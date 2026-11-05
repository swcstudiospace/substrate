import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditLog } from "@substrate/audit";
import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";
import { type Plan, planFromReport, scanCounters } from "./reconcile-repair.ts";
import type { IndexReader, LedgerReader } from "./reconcile-read.ts";
import { DEFAULT_RECONCILE_CAPS, runReport } from "./reconcile-run.ts";
import { type ReconcileClients, type ReconcileIo, reconcileMain } from "./reconcile-main.ts";

/** A run's io: the lines each stream received, and an `open` that records it was reached and then fails the test. */
function fakeIo(opened: string[]): { io: ReconcileIo; out: string[]; err: string[] } {
	const out: string[] = [];
	const err: string[] = [];
	const io: ReconcileIo = {
		out: (line) => out.push(line),
		err: (line) => err.push(line),
		open: () => {
			opened.push("open");
			throw new Error("open must not be reached");
		},
	};
	return { io, out, err };
}

const NOW = new Date("2026-11-02T12:00:00.000Z");

/** The env a repair needs: the index, the ledger and the cache. An audit path is added per test. */
const REPAIR_ENV: Record<string, string> = {
	SUBSTRATE_PG_URL: "postgres://127.0.0.1:5432/db",
	DRAGONFLY_URL: "redis://127.0.0.1:6379",
};
REPAIR_ENV["GREPTIME_URL"] = "http://127.0.0.1:4000";

/** Clients over the given keys. SCAN matches a trailing `*` as a prefix; UNLINK removes what it is given and records it. */
function repairClients(initial: readonly string[]): { clients: ReconcileClients; keys: Set<string>; removed: string[] } {
	const keys = new Set(initial);
	const removed: string[] = [];
	const ledger: LedgerReader = { queryEvents: async () => [] };
	const index: IndexReader = {
		reconcileHolds: async () => [],
		reconcileHeldNodes: async () => ({ rows: [], truncated: false }),
		reconcileMemoryIds: async () => ({ rows: [], truncated: false }),
		reconcileGraphIds: async () => ({ rows: [], truncated: false }),
		reconcileMemoryRowsBefore: async () => 0,
	};
	const cache = {
		scanKeys: async (match: string, limit: number) => {
			const prefix = match.endsWith("*") ? match.slice(0, -1) : match;
			const found = [...keys].filter((key) => key.startsWith(prefix)).sort();
			return { keys: found.slice(0, limit), truncated: found.length > limit };
		},
		unlinkKeys: async (list: readonly string[], onBatch?: (removed: number) => void): Promise<number> => {
			let count = 0;
			for (const key of list) {
				if (keys.delete(key)) {
					removed.push(key);
					count += 1;
				}
			}
			onBatch?.(count);
			return count;
		},
	};
	return { clients: { ledger, index, cache, close: async () => {} }, keys, removed };
}

/** The plan a report over these clients makes, with the text `plan` would write for it. */
async function planOver(clients: ReconcileClients): Promise<{ plan: Plan; text: string }> {
	const report = await runReport({ ledger: clients.ledger, index: clients.index, cache: clients.cache, now: NOW, windowHours: 24, caps: DEFAULT_RECONCILE_CAPS });
	const plan = planFromReport(report, NOW, (await scanCounters(clients.cache)).keys);
	return { plan, text: `${JSON.stringify(plan, null, 2)}\n` };
}

const ORPHAN_FIXTURE = ["substrate:v1:gen:graph:g-gone", "substrate:v1:brief:a1", "other:unrelated"];

describe("reconcileMain", () => {
	const savedPgUrl = process.env.SUBSTRATE_PG_URL;

	afterEach(() => {
		if (savedPgUrl === undefined) delete process.env.SUBSTRATE_PG_URL;
		else process.env.SUBSTRATE_PG_URL = savedPgUrl;
	});

	test("an unknown subcommand exits 2", async () => {
		const opened: string[] = [];
		const { io, err } = fakeIo(opened);
		expect(await reconcileMain(["bogus"], io)).toBe(2);
		expect(err.join("\n")).toMatch(/unknown subcommand/);
		expect(opened).toEqual([]);
	});

	test("report with no configured index exits 2 and reads nothing", async () => {
		delete process.env.SUBSTRATE_PG_URL;
		const opened: string[] = [];
		const { io, out, err } = fakeIo(opened);
		expect(await reconcileMain(["report"], io)).toBe(2);
		expect(err.join("\n")).toMatch(/SUBSTRATE_PG_URL is not set/);
		expect(opened).toEqual([]);
		expect(out).toEqual([]);
	});

	test("a failed flush exits 1 and writes the result file with the error", async () => {
		const dir = await mkdtemp(join(tmpdir(), "reconcile-main-"));
		try {
			const env: Record<string, string> = {
				SUBSTRATE_PG_URL: "postgres://user:pw@127.0.0.1:5432/db",
				DRAGONFLY_URL: "redis://127.0.0.1:6379",
			};
			env["GREPTIME_URL"] = "http://127.0.0.1:4000";
			env["SUBSTRATE_AUDIT_PATH"] = join(dir, "audit.jsonl");
			const now = new Date("2026-11-02T12:00:00.000Z");
			const keys = ["substrate:v1:gen:graph:g-gone", "other:unrelated"];
			const ledger: LedgerReader = { queryEvents: async () => [] };
			const index: IndexReader = {
				reconcileHolds: async () => [],
				reconcileHeldNodes: async () => ({ rows: [], truncated: false }),
				reconcileMemoryIds: async () => ({ rows: [], truncated: false }),
				reconcileGraphIds: async () => ({ rows: [], truncated: false }),
				reconcileMemoryRowsBefore: async () => 0,
			};
			const cache = {
				scanKeys: async (match: string, limit: number) => {
					const prefix = match.endsWith("*") ? match.slice(0, -1) : match;
					const found = keys.filter((key) => key.startsWith(prefix)).sort();
					return { keys: found.slice(0, limit), truncated: found.length > limit };
				},
				unlinkKeys: async (): Promise<number> => {
					throw new Error("unlink failed");
				},
			};
			const clients: ReconcileClients = { ledger, index, cache, close: async () => {} };
			const config = loadConfig(env);
			const report = await runReport({ ledger, index, cache, now, windowHours: config.reconcile.windowHours, caps: DEFAULT_RECONCILE_CAPS });
			const plan = planFromReport(report, now, (await scanCounters(cache)).keys);
			const planPath = join(dir, "plan.json");
			await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
			const out: string[] = [];
			const err: string[] = [];
			const io: ReconcileIo = { out: (line) => out.push(line), err: (line) => err.push(line), now: () => now, env, open: () => clients };
			expect(await reconcileMain(["repair", "--plan", planPath, "--execute", "--server-stopped"], io)).toBe(1);
			expect(err.join("\n")).toMatch(/unlink failed/);
			const record = JSON.parse(await readFile(`${planPath}.result.json`, "utf8")) as {
				result: { executed: boolean; refused: boolean; planned: number; removed: number; error?: string };
				recorded_at: string;
			};
			expect(record.result).toMatchObject({ executed: false, refused: false, planned: 1, removed: 0, error: "unlink failed" });
			expect(record.recorded_at).toBe(now.toISOString());
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("execute without --server-stopped exits 2 and opens no client", async () => {
		const opened: string[] = [];
		const { io, err } = fakeIo(opened);
		expect(await reconcileMain(["repair", "--plan", "plan.json", "--execute"], io)).toBe(2);
		expect(err.join("\n")).toMatch(/reconcile: --execute needs --server-stopped/);
		expect(err.join("\n")).toMatch(/usage: bun run reconcile/);
		expect(opened).toEqual([]);
	});

	test("--server-stopped with a command other than repair exits 2 and opens no client", async () => {
		const opened: string[] = [];
		const { io, err } = fakeIo(opened);
		expect(await reconcileMain(["report", "--server-stopped"], io)).toBe(2);
		expect(err.join("\n")).toMatch(/unknown argument: --server-stopped/);
		expect(opened).toEqual([]);
	});

	test("one repair execute writes exactly one audit record, carrying the plan digest and the counts", async () => {
		const dir = await mkdtemp(join(tmpdir(), "reconcile-audit-"));
		try {
			const env = { ...REPAIR_ENV, SUBSTRATE_AUDIT_PATH: join(dir, "audit.jsonl") };
			const fixture = repairClients(ORPHAN_FIXTURE);
			const { plan, text } = await planOver(fixture.clients);
			const planPath = join(dir, "plan.json");
			await writeFile(planPath, text);
			const io: ReconcileIo = { out: () => {}, err: () => {}, now: () => NOW, env, open: () => fixture.clients };
			expect(await reconcileMain(["repair", "--plan", planPath, "--execute", "--server-stopped"], io)).toBe(0);
			expect(fixture.removed).toEqual(["substrate:v1:brief:a1", "substrate:v1:gen:graph:g-gone"]);
			const lines = (await readFile(join(dir, "audit.jsonl"), "utf8")).trim().split("\n");
			expect(lines).toHaveLength(1);
			const record = JSON.parse(lines[0] ?? "") as { tool: string; decision: string; transport: string; reason: string };
			expect(record).toMatchObject({ tool: "reconcile_repair", decision: "allowed", transport: "internal" });
			expect(record.reason).toContain(`plan_digest=${createHash("sha256").update(text).digest("hex")}`);
			expect(record.reason).toContain(`report_digest=${plan.report_digest}`);
			expect(record.reason).toContain("outcome=executed planned=2 removed=2 remaining=0");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a repair execute with no durable audit chain exits 2 and flushes nothing", async () => {
		const dir = await mkdtemp(join(tmpdir(), "reconcile-nochain-"));
		try {
			const fixture = repairClients(ORPHAN_FIXTURE);
			const { text } = await planOver(fixture.clients);
			const planPath = join(dir, "plan.json");
			await writeFile(planPath, text);
			const opened: string[] = [];
			const err: string[] = [];
			const io: ReconcileIo = {
				out: () => {},
				err: (line) => err.push(line),
				now: () => NOW,
				env: REPAIR_ENV,
				open: () => {
					opened.push("open");
					return fixture.clients;
				},
			};
			expect(await reconcileMain(["repair", "--plan", planPath, "--execute", "--server-stopped"], io)).toBe(2);
			expect(err.join("\n")).toMatch(/SUBSTRATE_AUDIT_PATH/);
			expect(opened).toEqual([]);
			expect(fixture.removed).toEqual([]);
			expect(fixture.keys.size).toBe(ORPHAN_FIXTURE.length);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("an unreadable plan under execute records one refusal in the audit chain and exits 1", async () => {
		const dir = await mkdtemp(join(tmpdir(), "reconcile-unreadable-"));
		try {
			const env = { ...REPAIR_ENV, SUBSTRATE_AUDIT_PATH: join(dir, "audit.jsonl") };
			const fixture = repairClients(ORPHAN_FIXTURE);
			const garbage = "not a plan\n";
			const planPath = join(dir, "plan.json");
			await writeFile(planPath, garbage);
			const err: string[] = [];
			const io: ReconcileIo = { out: () => {}, err: (line) => err.push(line), now: () => NOW, env, open: () => fixture.clients };
			expect(await reconcileMain(["repair", "--plan", planPath, "--execute", "--server-stopped"], io)).toBe(1);
			expect(err.join("\n")).toMatch(/cannot be read as a substrate\.reconcile\.plan\.v1 record/);
			expect(fixture.removed).toEqual([]);
			const lines = (await readFile(join(dir, "audit.jsonl"), "utf8")).trim().split("\n");
			expect(lines).toHaveLength(1);
			const record = JSON.parse(lines[0] ?? "") as { tool: string; decision: string; reason: string };
			expect(record).toMatchObject({ tool: "reconcile_repair", decision: "denied" });
			expect(record.reason).toContain("outcome=refused planned=0 removed=0");
			expect(record.reason).toContain(`plan_digest=${createHash("sha256").update(garbage).digest("hex")}`);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("an execute whose plan file is missing records one refusal with an unreadable digest and exits 1", async () => {
		const dir = await mkdtemp(join(tmpdir(), "reconcile-missing-"));
		try {
			const env = { ...REPAIR_ENV, SUBSTRATE_AUDIT_PATH: join(dir, "audit.jsonl") };
			const fixture = repairClients(ORPHAN_FIXTURE);
			const err: string[] = [];
			const io: ReconcileIo = { out: () => {}, err: (line) => err.push(line), now: () => NOW, env, open: () => fixture.clients };
			expect(await reconcileMain(["repair", "--plan", join(dir, "absent.json"), "--execute", "--server-stopped"], io)).toBe(1);
			expect(err.join("\n")).toMatch(/cannot be read as a substrate\.reconcile\.plan\.v1 record/);
			expect(fixture.removed).toEqual([]);
			const lines = (await readFile(join(dir, "audit.jsonl"), "utf8")).trim().split("\n");
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain("outcome=refused planned=0 removed=0");
			expect(lines[0]).toContain("plan_digest=unreadable");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a run whose bound cuts into the counter pass is executed, not refused: answers and the first counter go, the rest stay, exit 0", async () => {
		const dir = await mkdtemp(join(tmpdir(), "reconcile-cut-"));
		try {
			const env = { ...REPAIR_ENV, SUBSTRATE_AUDIT_PATH: join(dir, "audit.jsonl") };
			// 499 answers and three counter-class keys: 502 planned, more than RECONCILE_MAX_ITEMS, so the run stops inside the counters.
			const briefs = Array.from({ length: 499 }, (_, i) => `substrate:v1:brief:k${String(i).padStart(3, "0")}`);
			const counters = ["substrate:v1:gen:graph:g-gone", "substrate:v1:gen:memory"] as const;
			const mark = "substrate:v1:gen:forgotten";
			const fixture = repairClients([...counters, mark, ...briefs]);
			const { text } = await planOver(fixture.clients);
			const planPath = join(dir, "plan.json");
			await writeFile(planPath, text);
			const err: string[] = [];
			const io: ReconcileIo = { out: () => {}, err: (line) => err.push(line), now: () => NOW, env, open: () => fixture.clients };
			expect(await reconcileMain(["repair", "--plan", planPath, "--execute", "--server-stopped"], io)).toBe(0);
			expect(err).toEqual([]);
			expect(fixture.removed).toEqual([...briefs, counters[0]]);
			expect([...fixture.keys].sort()).toEqual([mark, counters[1]]);
			const lines = (await readFile(join(dir, "audit.jsonl"), "utf8")).trim().split("\n");
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain("outcome=truncated planned=502 removed=500 remaining=2");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("an unwritable SUBSTRATE_AUDIT_PATH exits 2 and flushes nothing", async () => {
		const dir = await mkdtemp(join(tmpdir(), "reconcile-unwritable-"));
		try {
			// The audit path's parent is a regular file, so the chain cannot create its directory.
			await writeFile(join(dir, "blocker"), "");
			const env = { ...REPAIR_ENV, SUBSTRATE_AUDIT_PATH: join(dir, "blocker", "audit.jsonl") };
			const fixture = repairClients(ORPHAN_FIXTURE);
			const { text } = await planOver(fixture.clients);
			const planPath = join(dir, "plan.json");
			await writeFile(planPath, text);
			const opened: string[] = [];
			const err: string[] = [];
			const io: ReconcileIo = {
				out: () => {},
				err: (line) => err.push(line),
				now: () => NOW,
				env,
				open: () => {
					opened.push("open");
					return fixture.clients;
				},
			};
			expect(await reconcileMain(["repair", "--plan", planPath, "--execute", "--server-stopped"], io)).toBe(2);
			expect(err.join("\n")).toMatch(/not durable/);
			expect(err.join("\n")).not.toMatch(/is unset/);
			expect(opened).toEqual([]);
			expect(fixture.removed).toEqual([]);
			expect(fixture.keys.size).toBe(ORPHAN_FIXTURE.length);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	for (const [label, append] of [
		["throws", async (): Promise<unknown> => { throw new Error("disk full"); }],
		["reports written: false", async (): Promise<unknown> => ({ written: false, error: "disk full" })],
	] as const) {
		test(`an audit append that ${label} after the flush exits 1, and the flush and its result file stand`, async () => {
			const dir = await mkdtemp(join(tmpdir(), "reconcile-append-"));
			try {
				const env = { ...REPAIR_ENV, SUBSTRATE_AUDIT_PATH: join(dir, "audit.jsonl") };
				const fixture = repairClients(ORPHAN_FIXTURE);
				const { text } = await planOver(fixture.clients);
				const planPath = join(dir, "plan.json");
				await writeFile(planPath, text);
				const out: string[] = [];
				const err: string[] = [];
				const failingAudit = { open: async () => ({ records: 0, tip: null, durable: true }), append } as unknown as AuditLog;
				const io: ReconcileIo = {
					out: (line) => out.push(line),
					err: (line) => err.push(line),
					now: () => NOW,
					env,
					open: () => fixture.clients,
					openAudit: () => failingAudit,
				};
				expect(await reconcileMain(["repair", "--plan", planPath, "--execute", "--server-stopped"], io)).toBe(1);
				expect(fixture.removed).toEqual(["substrate:v1:brief:a1", "substrate:v1:gen:graph:g-gone"]);
				expect(err.join("\n")).toMatch(/the repair ran, but its audit record was not written: disk full/);
				const record = JSON.parse(await readFile(`${planPath}.result.json`, "utf8")) as { result: { executed: boolean; removed: number } };
				expect(record.result).toMatchObject({ executed: true, removed: 2 });
				expect(out).toHaveLength(1);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		});
	}
});
