import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";
import { type Plan, planFromReport } from "./reconcile-repair.ts";
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
	const plan = planFromReport(
		await runReport({ ledger: clients.ledger, index: clients.index, cache: clients.cache, now: NOW, windowHours: 24, caps: DEFAULT_RECONCILE_CAPS }),
		NOW,
	);
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
			const plan = planFromReport(
				await runReport({ ledger, index, cache, now, windowHours: config.reconcile.windowHours, caps: DEFAULT_RECONCILE_CAPS }),
				now,
			);
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
});
