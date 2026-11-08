/**
 * The consistency runner (v1.6, phase 57, unit d): argument grammar, exit codes, and what `--repair` may touch.
 *
 * No database, plane or ledger is opened. The stores are fakes that LOG every call, so "the repair touched only the
 * allowed actions" is asserted from the log, not assumed. The process-boundary tests at the end spawn the real
 * entry with a scrubbed environment and reach only the argument and configuration refusals.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
	CONSISTENCY_USAGE,
	ConsistencyUsageError,
	executeRepairPlan,
	ledgerWriteReader,
	configuredBanks,
	listBankDocuments,
	outboxFileReader,
	parseConsistencyArgs,
	runConsistency,
	type RepairPorts,
	type RunnerContext,
} from "./consistency-run.ts";
import { ReaderUnsupported, defaultDocumentId, type PlaneDocumentView, type RepairAction, type RepairPlan } from "./consistency-verify.ts";
import { contentHash } from "./memory-write.ts";
import type { EventQuery } from "./greptime.ts";
import type { FetchLike, HindsightConfig } from "./planes/hindsight.ts";
import type { MemoryEntry } from "./types.ts";
import { SURFACES } from "./types.ts";

const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const FORGOTTEN = `forgotten:fg_${"b".repeat(26)}`;
const minutesAgo = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
const BANK = "sub-hermes";

function entry(id: string, minutes: number, over: Partial<MemoryEntry> = {}): MemoryEntry {
	const base = { scope: "repo:acme/app", kind: "fact" as const, text: "body-needle-4411", writer: "hermes" };
	return {
		id,
		...base,
		actor: "agent",
		trust: "agent-claimed",
		ttl: "permanent",
		created: minutesAgo(minutes),
		version: 1,
		entry_hash: contentHash({ ...base, subject: null }),
		needs_reverification: false,
		source_event: `evt-${id}`,
		idempotency_key: `key-${id}`,
		...over,
	};
}

interface Fake {
	ctx: RunnerContext;
	log: string[];
	docs: Map<string, string | null>;
	entries: MemoryEntry[];
	/** What the repair ports read: starts as the same rows, a test may change one to simulate drift between verify and repair. */
	repairView: Map<string, MemoryEntry>;
	counters: { opens: number; closes: number };
	setup: FakeSetup;
	mutating(): string[];
}

interface FakeSetup {
	listing?: "ok" | "unsupported" | "down";
	ledger?: "ok" | "down";
	retain?: { forwarded: boolean; reason?: string } | "throws";
}

function fake(entries: MemoryEntry[], docs: Array<[string, string | null]>, setup: FakeSetup = {}): Fake {
	const log: string[] = [];
	const docMap = new Map(docs);
	const repairView = new Map(entries.map((e) => [e.id, e]));
	const counters = { opens: 0, closes: 0 };
	const events = entries.map((e) => ({ id: `ev-${e.id}`, ts: new Date(Date.parse(e.created) + 2000).toISOString(), surface: e.writer, scope: e.scope, kind: e.kind }));
	const readDocument = async (_bank: string, id: string): Promise<PlaneDocumentView | null> => {
		log.push(`readDocument:${id}`);
		const owner = docMap.get(id);
		if (owner === undefined) return null;
		return owner === null ? { id } : { id, entry_id: owner };
	};
	const ctx: RunnerContext = {
		readers: {
			index: {
				page: async () => ({ entries: [...entries].sort((a, b) => (a.created < b.created ? 1 : -1)), next: null }),
				entry: async (id) => entries.find((e) => e.id === id) ?? null,
				documentShared: async () => false,
			},
			plane: {
				getDocument: async (bank, id) => readDocument(bank, id),
				listDocuments: async () => {
					if (setup.listing === "unsupported") throw new ReaderUnsupported("no route");
					if (setup.listing === "down") throw new Error("hindsight unreachable at https://hs.internal:8888/v1");
					return { ids: [...docMap.keys()].sort(), next: null };
				},
			},
			ledger: {
				memoryWrites: async () => {
					if (setup.ledger === "down") throw new Error("greptime 503");
					return { events, next: null, skipped: 0 };
				},
			},
			outbox: { parkedEntryIds: async () => new Set<string>() },
		},
		bankFor: (writer) => `sub-${writer}`,
		bankPrefix: "sub-",
		banks: [BANK],
		repair: {
			readEntry: async (id) => {
				log.push(`readEntry:${id}`);
				return repairView.get(id) ?? null;
			},
			documentShared: async () => {
				log.push("documentShared");
				return false;
			},
			readDocument,
			retain: async (e, _bank, documentId) => {
				log.push(`retain:${e.id}`);
				if (setup.retain === "throws") throw new Error("connect failed: https://hs.internal:8888/v1/default/banks?token=abc");
				const result = setup.retain ?? { forwarded: true };
				if (result.forwarded) docMap.set(documentId, e.id);
				return result;
			},
			deleteDocument: async (_bank, id) => {
				log.push(`delete:${id}`);
				return docMap.delete(id) ? "deleted" : "absent";
			},
		},
		close: async () => {
			counters.closes += 1;
		},
	};
	return {
		ctx,
		log,
		docs: docMap,
		entries,
		repairView,
		counters,
		setup,
		mutating: () => log.filter((line) => line.startsWith("retain:") || line.startsWith("delete:")),
	};
}

/** Current entry with its document, a current entry with none, a forgotten entry whose document is still there, and a document nothing owns. */
function messy(setup: FakeSetup = {}): Fake {
	const ok = entry("mem_ok", 30);
	const missing = entry("mem_missing", 31);
	const forgotten = entry("mem_forgotten", 32, { superseded_by: FORGOTTEN });
	return fake(
		[ok, missing, forgotten],
		[
			[defaultDocumentId(ok) as string, "mem_ok"],
			[defaultDocumentId(forgotten) as string, "mem_forgotten"],
			["orphan-doc", "mem_vanished"],
		],
		setup,
	);
}

const consistent = (): Fake => {
	const ok = entry("mem_ok", 30);
	return fake([ok], [[defaultDocumentId(ok) as string, "mem_ok"]]);
};

const run = (argv: string[], f: Fake) =>
	runConsistency(argv, {
		now: () => NOW,
		open: async () => {
			f.counters.opens += 1;
			return f.ctx;
		},
	});

describe("argument grammar", () => {
	test("defaults and every flag", () => {
		expect(parseConsistencyArgs([])).toEqual({ json: false, bank: null, limit: null, since: null, repair: false, repairOrphans: false, serverStopped: false });
		expect(parseConsistencyArgs(["--json", "--bank", "sub-hermes", "--limit", "250", "--since", "2026-10-01T00:00:00Z", "--repair", "--server-stopped", "--repair-orphans"])).toEqual({
			json: true,
			bank: "sub-hermes",
			limit: 250,
			since: "2026-10-01T00:00:00.000Z",
			repair: true,
			repairOrphans: true,
			serverStopped: true,
		});
		expect(parseConsistencyArgs(["--since", "2026-10-01T02:00:00+02:00"]).since).toBe("2026-10-01T00:00:00.000Z");
	});

	test.each<[string[], string]>([
		[["--force"], "unknown flag"],
		[["--bank=sub-hermes"], "unknown flag"],
		[["verify"], "unexpected argument"],
		[["--json", "--json"], "given twice"],
		[["--bank", "a", "--bank", "b"], "given twice"],
		[["--bank"], "needs a value"],
		[["--bank", "--json"], "needs a value"],
		[["--limit"], "needs a value"],
		[["--bank", "has space"], "bank name"],
		[["--bank", "a/b"], "bank name"],
		[["--limit", "0"], "--limit needs"],
		[["--limit", "-5"], "--limit needs an integer"],
		[["--limit", "12x"], "--limit needs"],
		[["--limit", "1.5"], "--limit needs"],
		[["--limit", "50001"], "--limit needs"],
		[["--since", "yesterday"], "--since needs"],
		[["--since", "2026-10-01"], "--since needs"],
		[["--since", "2026-13-45T00:00:00Z"], "--since needs"],
		[["--repair-orphans"], "together with --repair"],
		[["--repair"], "--server-stopped"],
		[["--repair", "--repair-orphans"], "--server-stopped"],
		[["--server-stopped"], "together with --repair"],
	])("refuses %j", (argv, message) => {
		expect(() => parseConsistencyArgs(argv)).toThrow(ConsistencyUsageError);
		expect(() => parseConsistencyArgs(argv)).toThrow(message);
	});
});

describe("exit codes", () => {
	test("0 when the three stores agree, with a short summary and a JSON form", async () => {
		const text = await run([], consistent());
		expect(text).toMatchObject({ code: 0, stderr: "" });
		expect(text.stdout).toContain("CLEAN");
		const json = await run(["--json"], consistent());
		expect(json.code).toBe(0);
		expect(json.stdout.endsWith("\n")).toBe(true);
		expect(JSON.parse(json.stdout)).toMatchObject({ schema: 1, ok: true, findings: [] });
	});

	test("1 when drift is found, and nothing is repaired without a flag", async () => {
		const f = messy();
		const result = await run([], f);
		expect(result.code).toBe(1);
		expect(result.stdout).toContain("DRIFT (3 findings)");
		expect(result.stdout).toContain("repairs available: 2 safe, 1 orphan");
		expect(f.mutating()).toEqual([]);
		expect(f.log.filter((line) => line.startsWith("retain:") || line.startsWith("delete:"))).toEqual([]);
	});

	test("3 when the plane is unreachable, even though no drift was found", async () => {
		const f = consistent();
		f.ctx.readers.plane.listDocuments = async () => {
			throw new Error("connect ECONNREFUSED 10.1.2.3:8888");
		};
		const result = await run(["--json"], f);
		expect(result.code).toBe(3);
		const report = JSON.parse(result.stdout);
		expect(report.ok).toBe(false);
		expect(report.stores.plane.state).toBe("store_unreachable");
		expect(result.stdout).not.toContain("10.1.2.3");
	});

	test("3 when a check could not run (the plane has no listing), never a false clean", async () => {
		const f = consistent();
		f.ctx.readers.plane.listDocuments = async () => {
			throw new ReaderUnsupported("no route");
		};
		const result = await run([], f);
		expect(result.code).toBe(3);
		expect(result.stdout).toContain("INCOMPLETE");
		expect(result.stdout).toContain("plane_listing_unavailable");
	});

	test("the configured banks reach the verifier: a bank with no index row but an orphan document is drift (exit 1)", async () => {
		const f = consistent();
		f.ctx.banks = [BANK, "sub-swept"];
		f.docs.set("stray-doc", "mem_gone");
		const listed: string[] = [];
		f.ctx.readers.plane.listDocuments = async (bank) => {
			listed.push(bank);
			const ids = [...f.docs.keys()].filter((id) => (id === "stray-doc") === (bank === "sub-swept")).sort();
			return { ids, next: null };
		};
		const result = await run(["--json"], f);
		expect(listed.sort()).toEqual([BANK, "sub-swept"]);
		expect(result.code).toBe(1);
		const report = JSON.parse(result.stdout);
		expect(report.findings).toMatchObject([{ code: "plane_document_orphan", bank: "sub-swept", document_id: "stray-doc" }]);
		expect(report.coverage.banks).toEqual({ configured: [BANK, "sub-swept"], examined: [BANK, "sub-swept"], skipped: [], listing_truncated: [] });
	});

	test("a configured bank that cannot be read is skipped, not clean (exit 3), and the other banks are still read", async () => {
		const f = consistent();
		f.ctx.banks = [BANK, "sub-down"];
		f.ctx.readers.plane.listDocuments = async (bank) => {
			if (bank === "sub-down") throw new Error("connect ECONNREFUSED 10.1.2.3:8888");
			return { ids: [...f.docs.keys()].sort(), next: null };
		};
		const result = await run(["--json"], f);
		expect(result.code).toBe(3);
		const report = JSON.parse(result.stdout);
		expect(report.ok).toBe(false);
		expect(report.stores.plane.state).toBe("ok");
		expect(report.coverage.banks.skipped).toHaveLength(1);
		expect(report.coverage.banks.skipped[0].bank).toBe("sub-down");
		expect(result.stdout).not.toContain("10.1.2.3");
	});

	test("configuredBanks is every surface's writer bank plus HINDSIGHT_BANKS, sorted and de-duplicated", () => {
		const plane: HindsightConfig = { url: "http://hs.test", apiKey: "k", bankPrefix: "sub-" };
		const banks = configuredBanks(plane, { HINDSIGHT_BANKS: "sub-extra, sub-hermes, pd-desk" });
		expect(banks).toContain("sub-hermes");
		expect(banks).toContain("sub-extra");
		expect(banks).not.toContain("pd-desk");
		expect(new Set(banks).size).toBe(banks.length);
		expect([...banks].sort()).toEqual(banks);
		expect(banks.length).toBe(SURFACES.length + 1);
	});

	test("3 wins over 1: drift and an unreachable ledger together", async () => {
		const result = await run(["--json"], messy({ ledger: "down" }));
		expect(result.code).toBe(3);
		const report = JSON.parse(result.stdout);
		expect(report.counts.findings_total).toBeGreaterThan(0);
		expect(report.stores.ledger.state).toBe("store_unreachable");
	});

	test("2 for a usage error, before any store is opened", async () => {
		const f = consistent();
		const result = await run(["--limit", "nope"], f);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("--limit needs");
		expect(result.stderr).toContain(CONSISTENCY_USAGE);
		expect(result.stdout).toBe("");
		expect(f.counters.opens).toBe(0);
	});

	test("2 when a store is not configured, naming the variable and never a value; 2 too when opening throws, with no URL", async () => {
		const refused = await runConsistency([], { now: () => NOW, open: async () => ({ refused: "SUBSTRATE_PG_URL is not set" }) });
		expect(refused).toMatchObject({ code: 2 });
		expect(refused.stderr).toContain("SUBSTRATE_PG_URL is not set");
		const thrown = await runConsistency([], {
			now: () => NOW,
			open: async () => {
				throw new Error("connect to postgres://user:hunter2@db.internal:5432/app failed");
			},
		});
		expect(thrown.code).toBe(2);
		expect(thrown.stderr).not.toContain("postgres://");
		expect(thrown.stderr).not.toContain("hunter2");
	});

	test("--bank must sit under the configured prefix; one inside it narrows the run", async () => {
		const outside = await run(["--bank", "pd-desk"], consistent());
		expect(outside.code).toBe(2);
		expect(outside.stderr).toContain("--bank must name a substrate bank");
		const inside = await run(["--json", "--bank", BANK], consistent());
		expect(inside.code).toBe(0);
		expect(JSON.parse(inside.stdout).scope.bank).toBe(BANK);
	});

	test("--limit bounds the entries examined and --since is passed through", async () => {
		const f = messy();
		const result = await run(["--json", "--limit", "2", "--since", minutesAgo(120)], f);
		const report = JSON.parse(result.stdout);
		expect(report.counts.entries_examined).toBe(2);
		expect(report.truncated).toBe(true);
		expect(report.scope.since).toBe(minutesAgo(120));
	});

	test("the stores are closed on every path", async () => {
		const f = consistent();
		await run(["--bank", "pd-desk"], f);
		expect(f.counters.closes).toBe(1);
		const g = messy();
		await run([], g);
		expect(g.counters.closes).toBe(1);
	});
});

describe("--repair", () => {
	test("without --server-stopped a repair is refused with a usage error naming the reason, and nothing is opened or sent", async () => {
		const f = messy();
		for (const argv of [["--repair"], ["--json", "--repair"], ["--repair", "--repair-orphans"]]) {
			const result = await run(argv, f);
			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("--server-stopped");
			expect(result.stderr).toContain("write queue");
		}
		expect(f.counters.opens).toBe(0);
		expect(f.log).toEqual([]);
		// Verification alone is unchanged: read-only, no flag.
		expect((await run(["--json"], messy())).code).toBe(1);
	});

	test("a row that changed after the checks and before the write is skipped with a named reason, and nothing is sent", async () => {
		const f = messy();
		const real = f.ctx.repair.documentShared;
		// The forgotten entry's document is checked, then a replacement shares it just before the delete.
		let checks = 0;
		f.ctx.repair.documentShared = async (e) => {
			checks += 1;
			return checks > 1 ? true : real(e);
		};
		const result = await run(["--json", "--repair", "--server-stopped"], f);
		expect(f.mutating()).toEqual(["retain:mem_missing"]);
		const outcome = JSON.parse(result.stdout).repairs.outcomes.find((o: { action: string }) => o.action === "delete_forgotten_document");
		expect(outcome).toMatchObject({ outcome: "skipped", reason: expect.stringContaining("re-read before the write: a live entry shares the document") });
		expect(f.docs.has(defaultDocumentId(f.entries.find((e) => e.id === "mem_forgotten") as MemoryEntry) as string)).toBe(true);
	});

	test("an entry row that changed between the first read and the last look is not retained", async () => {
		const f = messy();
		const real = f.ctx.repair.readEntry;
		let reads = 0;
		f.ctx.repair.readEntry = async (id) => {
			const row = await real(id);
			if (id !== "mem_missing" || row === null) return row;
			reads += 1;
			return reads > 1 ? { ...row, entry_hash: "f".repeat(64) } : row;
		};
		const result = await run(["--json", "--repair", "--server-stopped"], f);
		expect(f.mutating()).toEqual(["delete:key-mem_forgotten"]);
		const outcome = JSON.parse(result.stdout).repairs.outcomes.find((o: { action: string }) => o.action === "re_retain");
		expect(outcome).toMatchObject({ outcome: "skipped", reason: expect.stringContaining("entry row changed between the plan and the write") });
	});

	test("performs only the two safe plane actions and leaves the orphan alone", async () => {
		const f = messy();
		const result = await run(["--json", "--repair", "--server-stopped"], f);
		expect(result.code).toBe(1);
		expect(f.mutating()).toEqual(["delete:key-mem_forgotten", "retain:mem_missing"]);
		expect(f.docs.has("orphan-doc")).toBe(true);
		const out = JSON.parse(result.stdout);
		expect(out.repairs.counts).toEqual({ repaired: 2, already_consistent: 0, skipped: 1, failed: 0 });
		expect(out.repairs.orphans_enabled).toBe(false);
		const skipped = out.repairs.outcomes.find((o: { outcome: string }) => o.outcome === "skipped");
		expect(skipped).toMatchObject({ action: "delete_orphan_document", finding_id: "orphan-doc", reason: "orphan deletion needs --repair-orphans" });
		// The report's findings are the pre-repair verdict: they are not rewritten by the repair.
		expect(out.counts.findings_total).toBe(3);
	});

	test("--repair-orphans adds the orphan's deletion and nothing else", async () => {
		const f = messy();
		const result = await run(["--json", "--repair", "--server-stopped", "--repair-orphans"], f);
		expect(f.mutating()).toEqual(["delete:key-mem_forgotten", "retain:mem_missing", "delete:orphan-doc"]);
		expect(f.docs.has("orphan-doc")).toBe(false);
		expect(JSON.parse(result.stdout).repairs.counts.repaired).toBe(3);
	});

	test("re-reads the entry first: one that stopped being current is skipped, not retained", async () => {
		const f = messy();
		const missing = f.repairView.get("mem_missing") as MemoryEntry;
		f.repairView.set("mem_missing", { ...missing, superseded_by: "mem_newer" });
		const result = await run(["--json", "--repair", "--server-stopped"], f);
		expect(f.mutating()).toEqual(["delete:key-mem_forgotten"]);
		const outcome = JSON.parse(result.stdout).repairs.outcomes.find((o: { action: string }) => o.action === "re_retain");
		expect(outcome).toMatchObject({ outcome: "skipped", reason: "the entry is no longer current" });
	});

	test("a document that came back on its own is already consistent, not re-retained", async () => {
		const f = messy();
		const missing = f.repairView.get("mem_missing") as MemoryEntry;
		// Verify sees no document; by the time the repair re-checks, the outbox drain has put it there.
		const real = f.ctx.repair.readEntry;
		f.ctx.repair.readEntry = async (id) => {
			if (id === "mem_missing") f.docs.set(defaultDocumentId(missing) as string, "mem_missing");
			return real(id);
		};
		const result = await run(["--json", "--repair", "--server-stopped"], f);
		expect(f.mutating()).toEqual(["delete:key-mem_forgotten"]);
		const outcome = JSON.parse(result.stdout).repairs.outcomes.find((o: { action: string }) => o.action === "re_retain");
		expect(outcome).toMatchObject({ outcome: "already_consistent", reason: "the document exists now" });
	});

	test("a forgotten entry's document that a live entry shares is skipped", async () => {
		const f = messy();
		f.ctx.repair.documentShared = async () => true;
		await run(["--json", "--repair", "--server-stopped"], f);
		expect(f.mutating()).toEqual(["retain:mem_missing"]);
	});

	test("an entry forgotten while the repair's retain was in flight has the document the retain re-created removed", async () => {
		const f = messy();
		const missing = f.repairView.get("mem_missing") as MemoryEntry;
		const real = f.ctx.repair.retain;
		// The forget marks the entry and deletes its document while the POST is in flight; the POST lands afterwards.
		f.ctx.repair.retain = async (e, bank, documentId) => {
			const result = await real(e, bank, documentId);
			f.repairView.set(e.id, { ...e, superseded_by: FORGOTTEN });
			return result;
		};
		const result = await run(["--json", "--repair", "--server-stopped"], f);
		const document = defaultDocumentId(missing) as string;
		expect(f.mutating()).toEqual(["delete:key-mem_forgotten", "retain:mem_missing", `delete:${document}`]);
		expect(f.docs.has(document)).toBe(false);
		const outcome = JSON.parse(result.stdout).repairs.outcomes.find((o: { action: string }) => o.action === "re_retain");
		expect(outcome).toMatchObject({ outcome: "skipped", reason: expect.stringContaining("forgotten while the repair ran") });
	});

	test("a forgotten entry's re-created document is left when a live entry shares it", async () => {
		const f = messy();
		const real = f.ctx.repair.retain;
		f.ctx.repair.retain = async (e, bank, documentId) => {
			const result = await real(e, bank, documentId);
			f.repairView.set(e.id, { ...e, superseded_by: FORGOTTEN });
			f.ctx.repair.documentShared = async () => true;
			return result;
		};
		await run(["--json", "--repair", "--server-stopped"], f);
		expect(f.mutating()).toEqual(["delete:key-mem_forgotten", "retain:mem_missing"]);
	});

	test("the retain gate's refusal is skipped; a throwing retain fails that action only, with no URL in the report", async () => {
		const refused = await run(["--json", "--repair", "--server-stopped"], messy({ retain: { forwarded: false, reason: "retain.expired" } }));
		expect(JSON.parse(refused.stdout).repairs.outcomes.find((o: { action: string }) => o.action === "re_retain")).toMatchObject({ outcome: "skipped", reason: "retain.expired" });

		const f = messy({ retain: "throws" });
		const thrown = await run(["--json", "--repair", "--server-stopped"], f);
		const out = JSON.parse(thrown.stdout);
		expect(out.repairs.counts).toMatchObject({ failed: 1, repaired: 1 });
		expect(thrown.stdout).not.toContain("https://");
		expect(thrown.stdout).not.toContain("token=abc");
		// The failure did not stop the other action.
		expect(f.mutating()).toEqual(["delete:key-mem_forgotten", "retain:mem_missing"]);
	});

	test("is skipped, with a note, when the plane could not be read", async () => {
		const f = messy({ listing: "down" });
		const result = await run(["--repair", "--server-stopped"], f);
		expect(result.code).toBe(3);
		expect(f.mutating()).toEqual([]);
		expect(result.stdout).toContain("repair skipped");
		const json = await run(["--json", "--repair", "--server-stopped"], messy({ listing: "down" }));
		expect(JSON.parse(json.stdout).repairs).toBeUndefined();
		expect(json.stderr).toContain("repair skipped");
	});

	test("the text form says what was done and to re-run", async () => {
		const result = await run(["--repair", "--server-stopped"], messy());
		expect(result.stdout).toContain("repair   2 repaired, 0 already consistent, 1 skipped, 0 failed (orphan deletion off)");
		expect(result.stdout).toContain("re-run the verifier to confirm");
	});

	test("a repair run on a consistent system calls no plane write at all", async () => {
		const f = consistent();
		const result = await run(["--repair", "--server-stopped", "--repair-orphans"], f);
		expect(result.code).toBe(0);
		expect(f.log).toEqual([]);
	});
});

describe("executeRepairPlan refuses what the planner would never make", () => {
	const ports = (log: string[]): RepairPorts => ({
		readEntry: async () => entry("mem_x", 5),
		documentShared: async () => false,
		readDocument: async () => null,
		retain: async () => {
			log.push("retain");
			return { forwarded: true };
		},
		deleteDocument: async () => {
			log.push("delete");
			return "deleted";
		},
	});
	const plan = (actions: RepairAction[]): RepairPlan => ({ schema: 1, generated_at: "x", complete: true, actions, unrepairable: [] });

	test.each<[string, Record<string, unknown>]>([
		["a delete action carrying a retain", { action: "delete_forgotten_document", class: "safe", steps: [{ op: "retain_document", entry_id: "mem_x", bank: BANK, document_id: "d" }] }],
		["a retain action carrying two writes", { action: "re_retain", class: "safe", steps: [{ op: "retain_document", entry_id: "mem_x", bank: BANK, document_id: "d" }, { op: "delete_document", bank: BANK, document_id: "d" }] }],
		["a write that is not last", { action: "re_retain", class: "safe", steps: [{ op: "retain_document", entry_id: "mem_x", bank: BANK, document_id: "d" }, { op: "read_entry", entry_id: "mem_x" }] }],
		["an orphan deletion classed safe", { action: "delete_orphan_document", class: "safe", steps: [{ op: "delete_document", bank: BANK, document_id: "d" }] }],
		["an action with no write", { action: "re_retain", class: "safe", steps: [{ op: "read_entry", entry_id: "mem_x" }] }],
		["an unknown action", { action: "drop_index_row", class: "safe", steps: [{ op: "delete_document", bank: BANK, document_id: "d" }] }],
	])("%s", async (_name, partial) => {
		const log: string[] = [];
		const action = { finding: "hash_mismatch", finding_id: "f1", ...partial } as unknown as RepairAction;
		const run1 = await executeRepairPlan(plan([action]), ports(log), { orphans: true });
		expect(log).toEqual([]);
		expect(run1.counts.failed).toBe(1);
		expect(run1.outcomes[0]?.reason).toContain("plan refused");
	});

	test("an orphan action never runs without the switch, even through the executor directly", async () => {
		const log: string[] = [];
		const action: RepairAction = {
			action: "delete_orphan_document",
			class: "orphan",
			finding: "plane_document_orphan",
			finding_id: "d",
			steps: [{ op: "require", condition: "document_orphaned", bank: BANK, document_id: "d" }, { op: "delete_document", bank: BANK, document_id: "d" }],
		};
		const off = await executeRepairPlan(plan([action]), ports(log), { orphans: false });
		expect(off.counts.skipped).toBe(1);
		expect(log).toEqual([]);
	});
});

describe("listBankDocuments", () => {
	const config: HindsightConfig = { url: "http://hs.test", apiKey: "hs-secret-key-123", bankPrefix: "sub-" };
	const route = (handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>): { fetchImpl: FetchLike; calls: string[]; headers: Array<unknown> } => {
		const calls: string[] = [];
		const headers: unknown[] = [];
		const fetchImpl: FetchLike = async (input, init) => {
			const url = String(input);
			calls.push(url);
			headers.push(init?.headers);
			return handler(url, init);
		};
		return { fetchImpl, calls, headers };
	};
	const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

	test("reads one page of ids with the bearer, and follows the total", async () => {
		const r = route(() => json({ items: [{ id: "a" }, { id: "b" }, { notId: 1 }, { id: "" }], total: 5, limit: 2, offset: 0 }));
		const page = await listBankDocuments(config, "sub-hermes", { limit: 2, cursor: null }, r.fetchImpl, 1000);
		expect(page).toEqual({ ids: ["a", "b"], next: "4" });
		expect(r.calls[0]).toBe("http://hs.test/v1/default/banks/sub-hermes/documents?limit=2&offset=0");
		expect(r.headers[0]).toEqual({ authorization: "Bearer hs-secret-key-123" });
		const last = route(() => json({ items: [{ id: "e" }], total: 5 }));
		expect(await listBankDocuments(config, "sub-hermes", { limit: 2, cursor: "4" }, last.fetchImpl, 1000)).toEqual({ ids: ["e"], next: null });
	});

	test("without a total it reads on until an empty page, so a server page cap never reads as the end", async () => {
		const r = route((url) => json({ items: url.includes("offset=0") ? [{ id: "a" }] : [] }));
		const first = await listBankDocuments(config, "b", { limit: 100, cursor: null }, r.fetchImpl, 1000);
		expect(first).toEqual({ ids: ["a"], next: "1" });
		expect(await listBankDocuments(config, "b", { limit: 100, cursor: "1" }, r.fetchImpl, 1000)).toEqual({ ids: [], next: null });
	});

	test("a 404 on a bank that exists is an unsupported route; on a bank that does not exist it is an empty list", async () => {
		const exists = route((url) => (url.endsWith("/config") ? json({ config: {} }) : json({}, 404)));
		await expect(listBankDocuments(config, "sub-hermes", { limit: 10, cursor: null }, exists.fetchImpl, 1000)).rejects.toBeInstanceOf(ReaderUnsupported);
		const absent = route(() => json({ detail: "bank not found" }, 404));
		expect(await listBankDocuments(config, "sub-hermes", { limit: 10, cursor: null }, absent.fetchImpl, 1000)).toEqual({ ids: [], next: null });
	});

	test("405, 501, a non-JSON body and a body without items are unsupported, not empty", async () => {
		for (const response of [() => json({}, 405), () => json({}, 501), () => new Response("<html>", { status: 200 }), () => json({ nothing: [] })]) {
			await expect(listBankDocuments(config, "b", { limit: 10, cursor: null }, route(response).fetchImpl, 1000)).rejects.toBeInstanceOf(ReaderUnsupported);
		}
	});

	test("failures carry fixed text only: no URL, no token, no cause", async () => {
		const server = route(() => json({ detail: "boom https://hs.test secret" }, 500));
		const unreachable: FetchLike = async () => {
			throw new Error("connect ECONNREFUSED http://hs.test hs-secret-key-123");
		};
		const timeout: FetchLike = async () => {
			throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
		};
		const messages: string[] = [];
		for (const fetchImpl of [server.fetchImpl, unreachable, timeout]) {
			try {
				await listBankDocuments(config, "b", { limit: 10, cursor: null }, fetchImpl, 1000);
			} catch (cause) {
				messages.push((cause as Error).message);
			}
		}
		expect(messages).toEqual(["plane list documents: http 500", "plane list documents: unreachable", "plane list documents: timed out"]);
		await expect(listBankDocuments(config, "b", { limit: 10, cursor: "x" }, server.fetchImpl, 1000)).rejects.toThrow("bad cursor");
	});
});

describe("ledgerWriteReader", () => {
	const row = (id: string, ts: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
		id,
		ts,
		surface: "hermes",
		summary: "memory.write accepted: fact at repo:acme/app",
		payload: JSON.stringify({ outcome: "accepted", scope: "repo:acme/app", kind: "fact" }),
		...over,
	});

	test("keeps accepted write events only, reads notes then warnings, and ends after the last kind", async () => {
		const queries: EventQuery[] = [];
		const reader = ledgerWriteReader({
			queryEvents: async (query) => {
				queries.push(query ?? {});
				if (query?.match?.kind === "note") {
					return [
						row("w1", NOW - 5000),
						row("c1", NOW - 4000, { summary: "memory.write conflict: version.stale (decision at repo:x)", payload: JSON.stringify({ outcome: "conflict", scope: "repo:x", kind: "decision" }) }),
						row("n1", NOW - 3000, { summary: "session started", payload: "{}" }),
						row("bad", NOW - 2000, { payload: "{not json" }),
					];
				}
				return [row("w2", NOW - 1000, { payload: JSON.stringify({ outcome: "accepted", scope: "global", kind: "todo", reason: "verify.unconfirmed" }) })];
			},
		});
		const first = await reader.memoryWrites({ since: minutesAgo(10), until: minutesAgo(0), limit: 500, cursor: null });
		expect(first.events.map((e) => e.id)).toEqual(["w1"]);
		expect(first.events[0]).toEqual({ id: "w1", ts: new Date(NOW - 5000).toISOString(), surface: "hermes", scope: "repo:acme/app", kind: "fact" });
		expect(first.next).toBe(`1|${minutesAgo(10)}`);
		const second = await reader.memoryWrites({ since: minutesAgo(10), until: minutesAgo(0), limit: 500, cursor: first.next });
		expect(second.events.map((e) => e.id)).toEqual(["w2"]);
		expect(second.next).toBeNull();
		expect(queries.map((q) => [q.match?.kind, q.order, q.includePayload, q.limit, q.until])).toEqual([
			["note", "asc", true, 500, minutesAgo(0)],
			["warning", "asc", true, 500, minutesAgo(0)],
		]);
	});

	test("a full page resumes inclusively at its last timestamp, in the same kind", async () => {
		const reader = ledgerWriteReader({ queryEvents: async () => [row("a", NOW - 2000), row("b", NOW - 1000)] });
		const page = await reader.memoryWrites({ since: minutesAgo(10), until: minutesAgo(0), limit: 2, cursor: null });
		expect(page.next).toBe(`0|${new Date(NOW - 1000).toISOString()}`);
	});

	test("an event's entry_id is carried when the payload names one and absent otherwise", async () => {
		const named = (over: Record<string, unknown>) => JSON.stringify({ outcome: "accepted", scope: "repo:acme/app", kind: "fact", ...over });
		const reader = ledgerWriteReader({
			queryEvents: async () => [
				row("with-id", NOW - 5000, { payload: named({ entry_id: "mem_stored" }) }),
				row("legacy", NOW - 4000),
				row("empty-id", NOW - 3000, { payload: named({ entry_id: "" }) }),
				row("number-id", NOW - 2000, { payload: named({ entry_id: 7 }) }),
			],
		});
		const page = await reader.memoryWrites({ since: minutesAgo(10), until: minutesAgo(0), limit: 500, cursor: null });
		expect(page.events.map((e) => [e.id, e.entry_id])).toEqual([
			["with-id", "mem_stored"],
			["legacy", undefined],
			["empty-id", undefined],
			["number-id", undefined],
		]);
		// The key is absent, not undefined, on an event that names no entry.
		expect("entry_id" in (page.events[1] as object)).toBe(false);
	});

	test("a malformed cursor is refused", async () => {
		const reader = ledgerWriteReader({ queryEvents: async () => [] });
		await expect(reader.memoryWrites({ since: "a", until: "b", limit: 5, cursor: "9|nope" })).rejects.toThrow("bad cursor");
	});

	test("an unparseable ledger payload is counted as skipped, and no event is invented for it", async () => {
		const reader = ledgerWriteReader({ queryEvents: async () => [row("ok", NOW - 5000), row("bad", NOW - 4000, { payload: "{not json" })] });
		const page = await reader.memoryWrites({ since: minutesAgo(10), until: minutesAgo(0), limit: 500, cursor: null });
		expect(page.skipped).toBe(1);
		expect(page.events.map((e) => e.id)).toEqual(["ok"]);

		// Through the verifier: the report counts the skip, and an invented event would surface as drift.
		const f = consistent();
		const rows: Array<Record<string, unknown>> = f.entries.map((e) => ({
			id: `ev-${e.id}`,
			ts: Date.parse(e.created) + 2000,
			surface: e.writer,
			summary: "memory.write accepted: fact at repo:acme/app",
			payload: JSON.stringify({ outcome: "accepted", scope: e.scope, kind: e.kind }),
		}));
		rows.push(row("bad", NOW - 60_000, { payload: "{not json" }));
		f.ctx.readers.ledger = ledgerWriteReader({ queryEvents: async (query) => (query?.match?.kind === "note" ? rows : []) });
		const result = await run(["--json"], f);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, findings: [], counts: { ledger_events_malformed: 1 } });
	});

	test("a resumed page does not count the same unparseable row twice", async () => {
		const reader = ledgerWriteReader({ queryEvents: async () => [row("bad", NOW - 2000, { payload: "{not json" })] });
		const first = await reader.memoryWrites({ since: minutesAgo(10), until: minutesAgo(0), limit: 1, cursor: null });
		const again = await reader.memoryWrites({ since: minutesAgo(10), until: minutesAgo(0), limit: 1, cursor: first.next });
		expect([first.skipped, again.skipped]).toEqual([1, 0]);
	});
});

describe("outboxFileReader", () => {
	test("unset path is unknown, a missing file is empty, lines are read by entry id and torn ones skipped", async () => {
		expect(await outboxFileReader(null, () => "x").parkedEntryIds()).toBeNull();
		expect([...((await outboxFileReader("/state/outbox.jsonl", () => null).parkedEntryIds()) ?? [])]).toEqual([]);
		const body = [JSON.stringify({ entry_id: "mem_a", bank: BANK }), "", "{torn", JSON.stringify({ nothing: 1 }), JSON.stringify({ entry_id: "mem_b" })].join("\n");
		expect([...((await outboxFileReader("/state/outbox.jsonl", () => body).parkedEntryIds()) ?? [])].sort()).toEqual(["mem_a", "mem_b"]);
	});

	test("a read error other than a missing file reaches the verifier, which reports the outbox unknown", async () => {
		const reader = outboxFileReader("/state/outbox.jsonl", () => {
			throw new Error("EACCES");
		});
		await expect(reader.parkedEntryIds()).rejects.toThrow("EACCES");
	});
});

describe("the entry process", () => {
	const RUNNER = new URL("./consistency-run.ts", import.meta.url).pathname;

	async function spawn(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
		const home = mkdtempSync(join(tmpdir(), "p57-consistency-run-"));
		mkdirSync(join(home, ".config"));
		const proc = Bun.spawn(["env", "-i", `PATH=/usr/bin:/bin`, `HOME=${home}`, `XDG_CONFIG_HOME=${join(home, ".config")}`, process.execPath, RUNNER, ...args], {
			cwd: home,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		return { code, stdout, stderr };
	}

	test("a bad flag exits 2 with the usage and prints nothing to stdout", async () => {
		const result = await spawn(["--bogus"]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("unknown flag");
		expect(result.stderr).toContain("usage: consistency-run.ts");
		expect(result.stdout).toBe("");
	});

	test("an empty environment exits 2 naming the unset variable, before any connection", async () => {
		const result = await spawn(["--json"]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("SUBSTRATE_PG_URL is not set");
		expect(result.stdout).toBe("");
	});
});
