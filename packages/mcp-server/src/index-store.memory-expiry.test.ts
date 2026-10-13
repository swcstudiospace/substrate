/**
 * Memory lifetime on the serving reads (uplift-3 N4), proven against a real
 * Postgres.
 *
 * `memory-policy.test.ts` proves the predicate; this proves that the store
 * applies it where entries are served — that one extra `graph_index` lookup
 * gives the predicate what it needs, that `report` serves every row tagged and
 * counts `served`, that `enforce` leaves the expired ones out, counts `hidden`,
 * and gives them back to an `includeExpired` read; that the brief and a search
 * agree row for row; that the retain forward refuses the same rows in both
 * modes; and that the two `ttl` sweep classes delete only under `enforce`.
 *
 * Skipped unless a database is given, for the reason `index-store.sweep.test.ts`
 * gives: the thing under test is what the SQL does.
 *
 *     SUBSTRATE_TEST_PG_URL=postgres://… bun test index-store.memory-expiry
 *
 * Every row written here carries `RUN` in its id and graph id, and `afterAll`
 * removes them. The delete statements run inside a transaction that is rolled
 * back, so the scratch database keeps every row for the suites after this one.
 */
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HindsightFake } from "./hindsight-fake.ts";
import { IndexStore, type MemoryExpiredSample } from "./index-store.ts";
import { DEFAULT_SWEEP_POLICY, planSweep } from "./index-sweep.ts";
import { replayRetain, type RetainDeps } from "./memory-retain.ts";
import { clearEnsuredBanks, type HindsightConfig } from "./planes/hindsight.ts";
import type { EventInput, MemoryEntry } from "./types.ts";

const PG_URL = process.env.SUBSTRATE_TEST_PG_URL?.trim();
const RUN = `ut-expirytest-${Date.now().toString(36)}`;
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const ago = (days: number): Date => new Date(NOW - days * DAY_MS);

const describeLive = PG_URL ? describe : describe.skip;

/** `<RUN>-<name>`, so every id in this suite is findable by prefix. */
const id = (name: string): string => `${RUN}-${name}`;
/** The repo scope every repo-scoped row sits in; the brief reads it by repo name. */
const REPO = `${RUN}/exp`;
const SCOPE = `repo:${REPO}`;

let raw: SQL;
let plain: IndexStore;
let report: IndexStore;
let enforce: IndexStore;
const samples: MemoryExpiredSample[] = [];

/** What every repo-scoped row should read as, by name: alive or the reason it is not. */
const EXPECTED: Record<string, { expired: boolean; expires_at?: true }> = {
	"e-30d-fresh": { expired: false, expires_at: true },
	"e-30d-old": { expired: true, expires_at: true },
	"e-graph-open": { expired: false },
	"e-graph-null": { expired: false },
	"e-graph-done": { expired: true },
	"e-graph-gone": { expired: true },
	"e-perm": { expired: false },
};
const LIVE = Object.entries(EXPECTED).filter(([, v]) => !v.expired).map(([name]) => id(name)).sort();
const ALL = Object.keys(EXPECTED).map(id).sort();

function byName(entries: MemoryEntry[]): Record<string, MemoryEntry> {
	return Object.fromEntries(entries.map((entry) => [entry.id.slice(RUN.length + 1), entry]));
}

describeLive("memory lifetime against a live index", () => {
	beforeAll(async () => {
		raw = new SQL(PG_URL!);
		const observe = (sample: MemoryExpiredSample) => {
			samples.push(sample);
		};
		plain = new IndexStore(PG_URL!);
		report = new IndexStore(PG_URL!, { memoryExpiry: { mode: "report", observe } });
		enforce = new IndexStore(PG_URL!, { memoryExpiry: { mode: "enforce", observe } });
		await plain.migrate();
		await seed();
	});

	afterAll(async () => {
		if (!PG_URL) return;
		const like = `${RUN}%`;
		await raw`delete from memory_entries where id like ${like}`.catch(() => undefined);
		for (const table of ["graph_nodes", "graph_index"]) {
			await raw.unsafe(`delete from ${table} where graph_id like $1`, [like]).catch(() => undefined);
		}
		await raw.end().catch(() => undefined);
		for (const store of [plain, report, enforce]) await store.close().catch(() => undefined);
	});

	async function seed(): Promise<void> {
		// Graphs: open, open-without-a-status, finished. `g-gone` is never registered.
		for (const [name, status] of [
			["g-open", "In Progress"],
			["g-null", null],
			["g-done", "Merged"],
		] as const) {
			await raw`
				insert into graph_index (graph_id, repo, status, created, updated)
				values (${id(name)}, ${REPO}, ${status}, ${ago(40)}, ${ago(40)})`;
		}
		// name, scope, ttl, graph_id, days ago, kind
		const entries: Array<[string, string, string, string | null, number, string]> = [
			["e-30d-fresh", SCOPE, "30d", null, 29, "fact"],
			["e-30d-old", SCOPE, "30d", null, 31, "warning"],
			["e-graph-open", SCOPE, "graph", id("g-open"), 5, "decision"],
			["e-graph-null", SCOPE, "graph", id("g-null"), 5, "decision"],
			["e-graph-done", SCOPE, "graph", id("g-done"), 5, "decision"],
			["e-graph-gone", SCOPE, "graph", id("g-gone"), 5, "fact"],
			["e-perm", SCOPE, "permanent", null, 400, "decision"],
			// Scoped to the finished graph by scope alone: the fallback identity.
			["e-graph-scope", `graph:${id("g-done")}`, "graph", null, 5, "fact"],
		];
		for (const [name, scope, ttl, graphId, days, kind] of entries) {
			await raw`
				insert into memory_entries (id, scope, kind, body, writer, ttl, graph_id, entry_hash, source_event, created)
				values (${id(name)}, ${scope}, ${kind}, ${`${RUN} ${name}`}, 'cursor', ${ttl}, ${graphId}, ${`h-${id(name)}`},
				        'evt_proof', ${ago(days)})`;
		}
	}

	function sampled(mode: "served" | "hidden", surface: string): Array<{ kind: string }> {
		return samples.filter((sample) => sample.mode === mode && sample.surface === surface).map(({ kind }) => ({ kind }));
	}

	test("report serves every row tagged, the brief and the search agree row for row, and each expired row counts as served", async () => {
		samples.length = 0;
		const searched = await report.searchMemory("", SCOPE, 100, false, { surface: "cursor" });
		expect(searched.map((entry) => entry.id).sort()).toEqual(ALL);
		const got = byName(searched);
		for (const [name, want] of Object.entries(EXPECTED)) {
			expect({ name, expired: got[name]?.expired }).toEqual({ name, expired: want.expired });
			if (want.expires_at) {
				expect(got[name]?.expires_at).toBe(new Date(Date.parse(got[name]!.created) + 30 * DAY_MS).toISOString());
			} else {
				expect(got[name]?.expires_at).toBeUndefined();
			}
		}
		// Three expired rows, each counted once, as served, under the caller and its kind.
		expect(sampled("served", "cursor").sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([
			{ kind: "decision" },
			{ kind: "fact" },
			{ kind: "warning" },
		]);
		expect(sampled("hidden", "cursor")).toEqual([]);

		// The brief reads the same rows through the same judge. It also reads `global`,
		// which other suites may populate, so only this run's rows are asserted on.
		samples.length = 0;
		const briefed = (await report.memoryForBrief(REPO, null, 500, { surface: "hermes" })).filter((entry) => entry.id.startsWith(RUN));
		expect(briefed.map((entry) => entry.id).sort()).toEqual(ALL);
		for (const entry of briefed) {
			expect({ id: entry.id, expired: entry.expired, expires_at: entry.expires_at }).toEqual({
				id: entry.id,
				expired: got[entry.id.slice(RUN.length + 1)]!.expired,
				expires_at: got[entry.id.slice(RUN.length + 1)]!.expires_at,
			});
		}
		expect(sampled("served", "hermes").length).toBeGreaterThanOrEqual(3);
	});

	test("enforce hides the expired rows and counts them hidden; include_expired gives them back", async () => {
		samples.length = 0;
		const searched = await enforce.searchMemory("", SCOPE, 100, false, { surface: "cursor" });
		expect(searched.map((entry) => entry.id).sort()).toEqual(LIVE);
		expect(searched.every((entry) => entry.expired === false)).toBe(true);
		expect(sampled("hidden", "cursor")).toHaveLength(3);
		expect(sampled("served", "cursor")).toEqual([]);

		const briefed = (await enforce.memoryForBrief(REPO, null, 500, { surface: "cursor" })).filter((entry) => entry.id.startsWith(RUN));
		expect(briefed.map((entry) => entry.id).sort()).toEqual(LIVE);

		// The operator's audit read: everything, still tagged, and counted as served.
		samples.length = 0;
		const widened = await enforce.searchMemory("", SCOPE, 100, false, { surface: "omp", includeExpired: true });
		expect(widened.map((entry) => entry.id).sort()).toEqual(ALL);
		expect(widened.filter((entry) => entry.expired).map((entry) => entry.id).sort()).toEqual(
			["e-30d-old", "e-graph-done", "e-graph-gone"].map(id).sort(),
		);
		expect(sampled("served", "omp")).toHaveLength(3);
		expect(sampled("hidden", "omp")).toEqual([]);
	});

	test("a graph: scope stands in for a missing graph_id, in the reads and in graphLifetime", async () => {
		const scope = `graph:${id("g-done")}`;
		const reported = await report.searchMemoryPage({ scope, query: "", limit: 10 });
		expect(reported.entries.map((entry) => [entry.id, entry.expired])).toEqual([[id("e-graph-scope"), true]]);
		const enforced = await enforce.searchMemoryPage({ scope, query: "", limit: 10 });
		expect(enforced.entries).toEqual([]);

		expect(await plain.graphLifetime({ scope, graph_id: undefined })).toEqual({ status: "Merged" });
		expect(await plain.graphLifetime({ scope: SCOPE, graph_id: id("g-open") })).toEqual({ status: "In Progress" });
		expect(await plain.graphLifetime({ scope: SCOPE, graph_id: id("g-null") })).toEqual({ status: null });
		expect(await plain.graphLifetime({ scope: SCOPE, graph_id: id("g-gone") })).toBeNull();
		expect(await plain.graphLifetime({ scope: SCOPE, graph_id: undefined })).toBeNull();
	});

	test("a store built without settings is report: tagged, nothing hidden, nothing counted", async () => {
		samples.length = 0;
		const searched = await plain.searchMemory("", SCOPE, 100);
		expect(searched.map((entry) => entry.id).sort()).toEqual(ALL);
		expect(byName(searched)["e-30d-old"]?.expired).toBe(true);
		expect(byName(searched)["e-perm"]?.expired).toBe(false);
		expect(samples).toEqual([]);
	});

	test("an enforce page keeps its cursor from the raw page, so paging reaches every live row exactly once", async () => {
		const seen: string[] = [];
		let cursor: { before: string; before_id: string } | null = null;
		for (let page = 0; page < 20; page++) {
			const got = await enforce.searchMemoryPage({
				scope: SCOPE,
				query: "",
				limit: 2,
				...(cursor ? { before: cursor.before, beforeId: cursor.before_id } : {}),
			});
			// A page the filter thinned is still a page: at most `limit` rows, never more.
			expect(got.entries.length).toBeLessThanOrEqual(2);
			seen.push(...got.entries.map((entry) => entry.id));
			if (!got.next) break;
			cursor = got.next;
		}
		expect([...seen].sort()).toEqual(LIVE);
		expect(new Set(seen).size).toBe(seen.length);
	});

	test("the retain forward refuses the expired rows and forwards the live ones, in both modes alike", async () => {
		const config: HindsightConfig = { url: "http://fake", apiKey: "test-bearer", bankPrefix: "sub-" };
		for (const store of [report, enforce]) {
			clearEnsuredBanks();
			const fake = new HindsightFake();
			const emitted: EventInput[] = [];
			const deps: RetainDeps = {
				config,
				fetchImpl: fake.fetch,
				emit: async (event) => {
					emitted.push(event);
					return { stored: true };
				},
				graphLifetime: (entry) => store.graphLifetime(entry),
			};
			const forwarded: string[] = [];
			for (const name of Object.keys(EXPECTED)) {
				// The candidate read the outbox replay performs: by id, untagged.
				const current = await store.readEntry(id(name));
				expect(current).not.toBeNull();
				const outcome = await replayRetain(deps, { entry: current!, writer: "cursor", bank: "sub-cursor", documentId: `doc-${id(name)}` });
				if (outcome.forwarded) forwarded.push(current!.id);
				else expect(outcome.reason).toBe("retain.expired");
			}
			expect(forwarded.sort()).toEqual(LIVE);
			expect(emitted.map((event) => event.payload?.reason)).toEqual(["retain.expired", "retain.expired", "retain.expired"]);
		}
	});

	test("the ttl sweep classes count under report, and under enforce delete exactly their rows — on apply only", async () => {
		// The store's own sweep, dry-run, under both modes: counts only, nothing moves.
		const reported = await report.sweep({ apply: false, now: NOW, policy: DEFAULT_SWEEP_POLICY, expiry: "report" });
		const dry = await enforce.sweep({ apply: false, now: NOW, policy: DEFAULT_SWEEP_POLICY, expiry: "enforce" });
		const modes = (r: typeof dry) => Object.fromEntries(r.classes.filter((c) => c.id.startsWith("entries-ttl-")).map((c) => [c.id, c.mode]));
		expect(modes(reported)).toEqual({ "entries-ttl-30d": "report", "entries-ttl-graph": "report" });
		expect(modes(dry)).toEqual({ "entries-ttl-30d": "delete", "entries-ttl-graph": "delete" });
		expect(dry.classes.find((c) => c.id === "entries-ttl-30d")?.candidates).toBeGreaterThanOrEqual(1);
		for (const r of [reported, dry]) expect(r.classes.every((c) => c.deleted === 0)).toBe(true);
		expect(await count("e-30d-old")).toBe(1);

		// The enforce delete statements, by hand, inside a transaction we roll back:
		// `e-30d-old` goes and its fresh twin stays. The graph class waits on its own
		// 90-day cutoff (`graphsDays`), so the rows seeded five days ago are not yet
		// its candidates — the reads hide them now; the sweep removes them later.
		const steps = planSweep(DEFAULT_SWEEP_POLICY, NOW, { expiry: "enforce" });
		const thirty = steps.find((step) => step.cls.id === "entries-ttl-30d")!;
		const graph = steps.find((step) => step.cls.id === "entries-ttl-graph")!;
		const sentinel = new Error("rolled back on purpose");
		await raw
			.begin(async (tx) => {
				const batch = thirty.cls.deleteBatch!(thirty.cutoff, 5_000);
				const rows = (await tx.unsafe(batch.pick.text, batch.pick.params as unknown[])) as Array<Record<string, unknown>>;
				expect(Number(rows[0]?.deleted)).toBeGreaterThanOrEqual(1);
				const left = (await tx`select id from memory_entries where id like ${`${RUN}%`} order by id`) as Array<{ id: string }>;
				expect(left.map((row) => row.id)).not.toContain(id("e-30d-old"));
				expect(left.map((row) => row.id)).toContain(id("e-30d-fresh"));
				const graphBatch = graph.cls.deleteBatch!(graph.cutoff, 5_000);
				await tx.unsafe(graphBatch.pick.text, graphBatch.pick.params as unknown[]);
				const after = (await tx`select id from memory_entries where id like ${`${RUN}%`}`) as Array<{ id: string }>;
				for (const name of ["e-graph-done", "e-graph-gone", "e-graph-open", "e-perm"]) expect(after.map((row) => row.id)).toContain(id(name));
				throw sentinel;
			})
			.catch((cause: unknown) => {
				if (cause !== sentinel) throw cause;
			});
		// Rolled back: the scratch database is as it was.
		expect(await count("e-30d-old")).toBe(1);

		// And the graph class names the scope-only row too, once it is old enough:
		// with tomorrow as the cutoff, done, gone and the scope-only row all count.
		const tomorrow = graph.cls.count(new Date(NOW + DAY_MS).toISOString());
		const old = (await raw.unsafe(tomorrow.text, tomorrow.params as unknown[])) as Array<{ candidates: number }>;
		expect(Number(old[0]?.candidates)).toBeGreaterThanOrEqual(3);
	});

	async function count(name: string): Promise<number> {
		const rows = (await raw`select count(*)::int as n from memory_entries where id = ${id(name)}`) as Array<{ n: number }>;
		return rows[0]?.n ?? 0;
	}
});
