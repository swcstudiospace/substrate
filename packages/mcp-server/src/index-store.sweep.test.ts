/**
 * The sweeper and `capacity()`, proven against a real Postgres.
 *
 * `index-sweep.test.ts` proves the policy and the statements; this proves that
 * Postgres agrees with them — that each class's predicate selects the seeded
 * row it should and not its live twin, that a dry-run leaves every row where it
 * was, that `apply` removes exactly the spent rows in one transaction, and that
 * the terminal-graph cascade reaches edges, steps and bindings, which have no
 * foreign key to carry them.
 *
 * Skipped unless a database is given, for the reason `index-store.lease.test.ts`
 * gives: the thing under test is what the SQL does.
 *
 *     SUBSTRATE_TEST_PG_URL=postgres://… bun test index-store.sweep
 *
 * Every row written here carries `RUN` in its id, body or key, and `afterAll`
 * removes them. `apply` runs the real policy over the whole scratch database, so
 * the assertions are about this run's rows — never about totals.
 */
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { IndexStore } from "./index-store.ts";
import { DEFAULT_SWEEP_POLICY, SWEEP_CLASSES, type SweepReport } from "./index-sweep.ts";
import { defined } from "./test-support.ts";

const PG_URL = process.env.SUBSTRATE_TEST_PG_URL?.trim();
const RUN = `ut-sweeptest-${Date.now().toString(36)}`;
const DAY_MS = 24 * 60 * 60 * 1000;

let store: IndexStore;
let raw: SQL;
/** One instant for the whole suite; every seeded timestamp is this minus whole days. */
const NOW = Date.now();
const ago = (days: number): Date => new Date(NOW - days * DAY_MS);

const describeLive = PG_URL ? describe : describe.skip;

/** `<RUN>-<name>`, so every id in this suite is findable by prefix. */
const id = (name: string): string => `${RUN}-${name}`;

describeLive("index sweep against a live index", () => {
	beforeAll(async () => {
		store = new IndexStore(defined(PG_URL, "SUBSTRATE_TEST_PG_URL"));
		raw = new SQL(defined(PG_URL, "SUBSTRATE_TEST_PG_URL"));
		await store.migrate();
		await seed();
	});

	afterAll(async () => {
		if (!PG_URL) return;
		const like = `${RUN}%`;
		for (const table of ["graph_edges", "graph_steps", "graph_bindings", "graph_nodes", "graph_index"]) {
			await raw.unsafe(`delete from ${table} where graph_id like $1`, [like]).catch(() => undefined);
		}
		await raw`delete from memory_entries where id like ${like}`.catch(() => undefined);
		await raw`delete from memory_reviews where id like ${like}`.catch(() => undefined);
		await raw`delete from memory_quarantine where id like ${like}`.catch(() => undefined);
		await raw`delete from memory_writes where idempotency_key like ${like}`.catch(() => undefined);
		await raw.end().catch(() => undefined);
		await store.close().catch(() => undefined);
	});

	async function seed(): Promise<void> {
		// Idempotency ledger: spent derived (old / young), spent explicit (old / young),
		// and an in-flight derived row older than everything, which must survive.
		const writes: Array<[string, boolean, string, number]> = [
			["w-derived-old", false, "accepted", 8],
			["w-derived-young", false, "accepted", 6],
			["w-explicit-old", true, "accepted", 31],
			["w-explicit-young", true, "accepted", 29],
			["w-inflight-old", false, "in-flight", 400],
		];
		for (const [name, explicit, outcome, days] of writes) {
			await raw`
				insert into memory_writes (idempotency_key, explicit, outcome, entry_id, entry_hash, request_hash, holder, claimed)
				values (${id(name)}, ${explicit}, ${outcome}, null, ${`h-${name}`}, ${`r-${name}`}, ${`hold_${name}`}, ${ago(days)})`;
		}

		// Reviews: approved old, approved young, pending old (pending never goes).
		const reviews: Array<[string, string, number]> = [
			["rv-approved-old", "approved", 31],
			["rv-approved-young", "approved", 29],
			["rv-pending-old", "pending", 400],
		];
		for (const [name, state, days] of reviews) {
			await raw`
				insert into memory_reviews (id, scope, kind, body, writer, ttl, entry_hash, reason, state, decided, created)
				values (${id(name)}, 'global', 'decision', ${`${RUN} ${name}`}, 'hermes', 'permanent', ${`h-${name}`}, 'review',
				        ${state}, ${state === "pending" ? null : ago(days)}, ${ago(days)})`;
		}

		// Memory entries: a superseded old version with its standing successor; a
		// 30d entry older than 30 days (report only); a graph-ttl entry on a terminal
		// graph (report only); and an entry whose hash releases a quarantine row.
		const entries: Array<[string, string, string, string | null, string | null, string | null, number]> = [
			// name, scope, ttl, superseded_by, graph_id, entry_hash, days
			["e-v1-old", "global", "permanent", id("e-v2"), null, "h-e-v1", 91],
			["e-v2", "global", "permanent", null, null, "h-e-v2", 91],
			["e-v1-young", "global", "permanent", id("e-v2"), null, "h-e-v1y", 89],
			// A forgotten entry (`memory-forget.ts` marker) older than the window: kept for audit, never swept.
			["e-forgotten-old", "global", "permanent", "forgotten:fg_0123456789abcdef0123456789", null, "h-e-forgotten", 91],
			["e-ttl30-old", "global", "30d", null, null, "h-e-ttl30", 31],
			["e-ttlgraph-old", `graph:${id("g-terminal-old")}`, "graph", null, id("g-terminal-old"), "h-e-ttlgraph", 91],
			["e-landed", "global", "permanent", null, null, `h-${RUN}-landed`, 1],
		];
		for (const [name, scope, ttl, supersededBy, graphId, hash, days] of entries) {
			await raw`
				insert into memory_entries (id, scope, kind, body, writer, ttl, superseded_by, graph_id, entry_hash, created)
				values (${id(name)}, ${scope}, 'decision', ${`${RUN} ${name}`}, 'hermes', ${ttl}, ${supersededBy}, ${graphId},
				        ${hash}, ${ago(days)})`;
		}

		// Quarantine: released old (its hash landed above), unresolved old, released young.
		const quarantine: Array<[string, string, number]> = [
			["q-released-old", `h-${RUN}-landed`, 31],
			["q-unresolved-old", `h-${RUN}-never`, 31],
			["q-released-young", `h-${RUN}-landed-young`, 29],
		];
		await raw`
			insert into memory_entries (id, scope, kind, body, writer, ttl, entry_hash, created)
			values (${id("e-landed-young")}, 'global', 'decision', ${`${RUN} e-landed-young`}, 'hermes', 'permanent',
			        ${`h-${RUN}-landed-young`}, ${ago(1)})`;
		for (const [name, hash, days] of quarantine) {
			await raw`
				insert into memory_quarantine (id, scope, kind, body, writer, entry_hash, reason, detail, created)
				values (${id(name)}, 'global', 'decision', ${`${RUN} ${name}`}, 'hermes', ${hash}, 'speculative', 'test', ${ago(days)})`;
		}

		// Graphs: terminal old (goes, with everything hanging off it), terminal young
		// (stays), open old (stays). Each gets a node, an edge, a step and a binding.
		const graphs: Array<[string, string, number]> = [
			["g-terminal-old", "Done", 91],
			["g-terminal-young", "Closed", 89],
			["g-open-old", "In Progress", 400],
			// Finished long ago, but a node is held on a live lease — a claim does not
			// refuse a terminal graph and never touches `graph_index.updated`.
			["g-terminal-lease-live", "Merged", 400],
			// Finished long ago, its lease lapsed and nobody reaped it: deletable.
			["g-terminal-lease-expired", "Merged", 400],
			// Finished long ago and free; claimed on a second connection mid-sweep by the race test.
			["g-terminal-race", "Done", 400],
			// Its batch-mate in the race test: picked and locked alongside, and removed whole while the raced one stays whole.
			["g-terminal-race-free", "Done", 400],
		];
		for (const [name, status, days] of graphs) {
			const graphId = id(name);
			await raw`
				insert into graph_index (graph_id, repo, status, created, updated)
				values (${graphId}, 'swcstudiospace/agent-substrate', ${status}, ${ago(days)}, ${ago(days)})`;
			await raw`insert into graph_nodes (graph_id, node_id, state) values (${graphId}, 'n1', 'completed'), (${graphId}, 'n2', 'completed')`;
			await raw`insert into graph_edges (graph_id, from_node, to_node, kind) values (${graphId}, 'n1', 'n2', 'blocks')`;
			await raw`insert into graph_steps (graph_id, node_id, step, state) values (${graphId}, 'n1', 1, 'done')`;
			await raw`insert into graph_bindings (correlation_id, graph_id, bound_by) values (${`${graphId}-corr`}, ${graphId}, 'test')`;
		}
		// The leases, in the columns the CAS helpers write.
		await raw`
			update graph_nodes set claimed_by = 'hermes', claim_session = ${`${RUN}-live`}, claimed_at = now(),
				lease_id = ${`lse_${RUN}_live`}, lease_epoch = 1, lease_heartbeat_at = now(),
				lease_expires_at = now() + interval '1 hour'
			where graph_id = ${id("g-terminal-lease-live")} and node_id = 'n1'`;
		await raw`
			update graph_nodes set claimed_by = 'hermes', claim_session = ${`${RUN}-expired`}, claimed_at = ${ago(2)},
				lease_id = ${`lse_${RUN}_expired`}, lease_epoch = 1, lease_heartbeat_at = ${ago(2)},
				lease_expires_at = ${ago(1)}
			where graph_id = ${id("g-terminal-lease-expired")} and node_id = 'n1'`;
	}

	/**
	 * `graph_nodes` only, the way `claimNode` writes: the sweep has to see this
	 * claim land between its pick and its node lock. Returns how many rows it
	 * wrote — zero once the node is gone, exactly as the CAS in `claimNode` sees it.
	 */
	async function claimLive(name: string): Promise<number> {
		const rows = (await raw`
			update graph_nodes set claimed_by = 'hermes', claim_session = ${`${RUN}-race`}, claimed_at = now(),
				lease_id = ${`lse_${RUN}_race`}, lease_epoch = lease_epoch + 1, lease_heartbeat_at = now(),
				lease_expires_at = now() + interval '1 hour'
			where graph_id = ${id(name)} and node_id = 'n2'
			returning node_id`) as Array<Record<string, unknown>>;
		return rows.length;
	}

	async function count(table: string, column: string, name: string): Promise<number> {
		const rows = (await raw.unsafe(`select count(*)::int as n from ${table} where ${column} = $1`, [id(name)])) as Array<{
			n: number;
		}>;
		return rows[0]?.n ?? 0;
	}

	function byId(report: SweepReport): Record<string, { candidates: number; deleted: number; children?: Record<string, number> }> {
		return Object.fromEntries(report.classes.map((cls) => [cls.id, cls]));
	}

	test("a dry-run counts at least this run's candidates and leaves every row in place", async () => {
		const report = await store.sweep({ apply: false, now: NOW, policy: DEFAULT_SWEEP_POLICY });
		const classes = byId(report);
		expect(report.apply).toBe(false);
		for (const key of [
			"writes-derived-spent",
			"writes-explicit-spent",
			"reviews-decided",
			"quarantine-released",
			"quarantine-unresolved",
			"graphs-terminal",
			"entries-superseded",
			"entries-ttl-30d",
			"entries-ttl-graph",
		]) {
			expect(classes[key]?.candidates ?? 0).toBeGreaterThanOrEqual(1);
			expect(classes[key]?.deleted).toBe(0);
		}
		// Nothing moved.
		expect(await count("memory_writes", "idempotency_key", "w-derived-old")).toBe(1);
		expect(await count("memory_reviews", "id", "rv-approved-old")).toBe(1);
		expect(await count("memory_quarantine", "id", "q-released-old")).toBe(1);
		expect(await count("graph_index", "graph_id", "g-terminal-old")).toBe(1);
		expect(await count("memory_entries", "id", "e-v1-old")).toBe(1);
	});

	test("a claim that lands between the pick and the node lock keeps its graph whole — every node, edge, step, binding and the index row — while its batch-mate goes", async () => {
		// The sweep's own statements, driven by hand inside one transaction with the
		// pick's lock held, and the claim arriving on a second connection in between —
		// the window `IndexStore.sweep` cannot be paused in.
		const graphs = defined(
			SWEEP_CLASSES.find((cls) => cls.id === "graphs-terminal"),
			"graphs-terminal sweep class",
		);
		const cutoff = new Date(NOW - 90 * DAY_MS).toISOString();
		const raced = id("g-terminal-race");
		const free = id("g-terminal-race-free");
		let lateClaim: Promise<number> | undefined;
		const outcome = await raw.begin(async (tx) => {
			const batch = defined(graphs.deleteBatch?.(cutoff, 5_000), "graphs-terminal delete batch");
			const all = (await tx.unsafe(batch.pick.text, batch.pick.params as unknown[])) as Array<Record<string, unknown>>;
			expect(all.map((row) => String(row.graph_id))).toEqual(expect.arrayContaining([raced, free]));
			// Only these two go on here; the rest stay for the apply test.
			const picked = [{ graph_id: raced }, { graph_id: free }];
			// The claim commits on its own connection after the pick and before the
			// lock: the lock must wait for nothing, yet read the claimed row version.
			expect(await claimLive("g-terminal-race")).toBe(1);
			const lock = defined(batch.lock, "batch.lock")(picked);
			const locked = (await tx.unsafe(lock.text, lock.params as unknown[])) as Array<
				Record<string, unknown>
			>;
			const liveOf = (graphId: string): unknown[] => locked.filter((row) => String(row.graph_id) === graphId).map((row) => row.live);
			expect(liveOf(free)).toEqual([false, false]);
			expect(liveOf(raced).sort()).toEqual([false, true]);
			// A claim arriving after the lock queues behind it (or behind the delete —
			// either way it resolves against this transaction's committed outcome).
			lateClaim = claimLive("g-terminal-race-free");
			const row: Record<string, unknown> = {};
			for (const statement of defined(batch.decide, "batch.decide")(picked, locked)) {
				Object.assign(row, ((await tx.unsafe(statement.text, statement.params as unknown[])) as Array<Record<string, unknown>>)[0]);
			}
			return row;
		});
		// The free graph went whole (two nodes, one edge, one step, one binding, its
		// row); the raced graph lost nothing — not even n1, which holds no lease.
		expect(Number(outcome.nodes)).toBe(2);
		expect(Number(outcome.deleted)).toBe(1);
		expect(Number(outcome.edges)).toBe(1);
		expect(Number(outcome.steps)).toBe(1);
		expect(Number(outcome.bindings)).toBe(1);
		for (const table of ["graph_index", "graph_nodes", "graph_edges", "graph_steps", "graph_bindings"]) {
			expect(await count(table, "graph_id", "g-terminal-race-free")).toBe(0);
			expect(await count(table, "graph_id", "g-terminal-race")).toBe(table === "graph_nodes" ? 2 : 1);
		}
		const unleased = (await raw`
			select node_id from graph_nodes where graph_id = ${raced} and claimed_by is null order by node_id`) as Array<Record<string, unknown>>;
		expect(unleased.map((row) => row.node_id)).toEqual(["n1"]);
		// The late claimant found its node gone: the CAS matched zero rows, as `claimNode` would report.
		expect(await defined(lateClaim, "late claim")).toBe(0);
		// And the raced graph is no longer a candidate at all while the lease is live:
		// the next pick — the count's predicate — does not name it, so no later round retries it.
		const batch = defined(graphs.deleteBatch?.(cutoff, 5_000), "graphs-terminal delete batch");
		const next = (await raw.unsafe(batch.pick.text, batch.pick.params as unknown[])) as Array<Record<string, unknown>>;
		expect(next.map((row) => String(row.graph_id))).not.toContain(raced);
		expect(next.map((row) => String(row.graph_id))).not.toContain(free);
		expect(next.map((row) => String(row.graph_id))).toContain(id("g-terminal-old"));
	});

	test("apply removes exactly the spent rows and the terminal graph's cascade, and keeps the live twins", async () => {
		const report = await store.sweep({ apply: true, now: NOW, policy: DEFAULT_SWEEP_POLICY });
		const classes = byId(report);
		expect(report.apply).toBe(true);

		// Idempotency ledger.
		expect(await count("memory_writes", "idempotency_key", "w-derived-old")).toBe(0);
		expect(await count("memory_writes", "idempotency_key", "w-derived-young")).toBe(1);
		expect(await count("memory_writes", "idempotency_key", "w-explicit-old")).toBe(0);
		expect(await count("memory_writes", "idempotency_key", "w-explicit-young")).toBe(1);
		expect(await count("memory_writes", "idempotency_key", "w-inflight-old")).toBe(1);

		// Reviews.
		expect(await count("memory_reviews", "id", "rv-approved-old")).toBe(0);
		expect(await count("memory_reviews", "id", "rv-approved-young")).toBe(1);
		expect(await count("memory_reviews", "id", "rv-pending-old")).toBe(1);

		// Quarantine: released goes, unresolved is only reported.
		expect(await count("memory_quarantine", "id", "q-released-old")).toBe(0);
		expect(await count("memory_quarantine", "id", "q-released-young")).toBe(1);
		expect(await count("memory_quarantine", "id", "q-unresolved-old")).toBe(1);
		expect(classes["quarantine-unresolved"]?.deleted).toBe(0);

		// Graphs: the whole terminal-old graph and the one whose lease lapsed; nothing
		// of the young, the open, or the two somebody holds a live lease on.
		for (const [table, column] of [
			["graph_index", "graph_id"],
			["graph_nodes", "graph_id"],
			["graph_edges", "graph_id"],
			["graph_steps", "graph_id"],
			["graph_bindings", "graph_id"],
		] as const) {
			expect(await count(table, column, "g-terminal-old")).toBe(0);
			expect(await count(table, column, "g-terminal-lease-expired")).toBe(0);
			expect(await count(table, column, "g-terminal-young")).toBeGreaterThanOrEqual(1);
			expect(await count(table, column, "g-open-old")).toBeGreaterThanOrEqual(1);
			expect(await count(table, column, "g-terminal-lease-live")).toBeGreaterThanOrEqual(1);
			expect(await count(table, column, "g-terminal-race")).toBeGreaterThanOrEqual(1);
		}
		// The held graph was never a candidate — the exclusion is in the count, not
		// only in the delete — so it is neither counted nor reported as skipped here.
		expect(classes["graphs-terminal"]?.children?.skipped_live_lease ?? 0).toBe(0);
		expect(classes["graphs-terminal"]?.deleted).toBeGreaterThanOrEqual(2);
		expect(classes["graphs-terminal"]?.children?.edges).toBeGreaterThanOrEqual(2);
		expect(classes["graphs-terminal"]?.children?.steps).toBeGreaterThanOrEqual(2);
		expect(classes["graphs-terminal"]?.children?.bindings).toBeGreaterThanOrEqual(2);
		expect(classes["graphs-terminal"]?.children?.nodes).toBeGreaterThanOrEqual(4);
		// No orphans: every edge, step and binding of this run still names a graph that exists.
		for (const table of ["graph_edges", "graph_steps", "graph_bindings", "graph_nodes"]) {
			const orphans = (await raw.unsafe(
				`select count(*)::int as n from ${table} t where t.graph_id like $1 ` +
					"and not exists (select 1 from graph_index g where g.graph_id = t.graph_id)",
				[`${RUN}%`],
			)) as Array<{ n: number }>;
			expect(orphans[0]?.n ?? 0).toBe(0);
		}

		// Memory entries: the old superseded version goes; the standing entry, the
		// young superseded one and both ttl classes stay (reads still return them).
		expect(await count("memory_entries", "id", "e-v1-old")).toBe(0);
		expect(await count("memory_entries", "id", "e-v2")).toBe(1);
		expect(await count("memory_entries", "id", "e-v1-young")).toBe(1);
		expect(await count("memory_entries", "id", "e-forgotten-old")).toBe(1);
		expect(await count("memory_entries", "id", "e-ttl30-old")).toBe(1);
		expect(await count("memory_entries", "id", "e-ttlgraph-old")).toBe(1);
		expect(classes["entries-ttl-30d"]?.deleted).toBe(0);
		expect(classes["entries-ttl-graph"]?.deleted).toBe(0);
		expect(classes["entries-ttl-graph"]?.candidates).toBeGreaterThanOrEqual(1);

		// What was deleted is what was counted, class by class, for the deletable ones.
		for (const cls of report.classes) {
			if (cls.mode === "delete") expect(cls.deleted).toBe(cls.candidates);
		}
	});

	test("a second apply finds nothing of this run left to delete", async () => {
		const before = await store.sweep({ apply: false, now: NOW, policy: DEFAULT_SWEEP_POLICY });
		const report = await store.sweep({ apply: true, now: NOW, policy: DEFAULT_SWEEP_POLICY });
		// Whatever a second pass found was not this run's: every row it could have
		// taken from us went in the first apply, and the count did not grow.
		for (const [i, cls] of report.classes.entries()) {
			expect(cls.candidates).toBeLessThanOrEqual(before.classes[i]?.candidates ?? 0);
		}
		expect(await count("memory_writes", "idempotency_key", "w-derived-young")).toBe(1);
		expect(await count("memory_reviews", "id", "rv-pending-old")).toBe(1);
		expect(await count("graph_index", "graph_id", "g-open-old")).toBe(1);
	});

	test("capacity() reports the database size and the repo's tables with row counts", async () => {
		const capacity = await store.capacity();
		expect(capacity.databaseBytes).toBeGreaterThan(0);
		expect(capacity.tables.length).toBeGreaterThan(0);
		expect(capacity.tables.length).toBeLessThanOrEqual(10);
		for (const table of capacity.tables) {
			expect(typeof table.name).toBe("string");
			expect(table.totalBytes).toBeGreaterThanOrEqual(0);
			expect(table.liveRows).toBeGreaterThanOrEqual(0);
			expect(table.deadRows).toBeGreaterThanOrEqual(0);
		}
		const names = capacity.tables.map((table) => table.name);
		expect(names.some((name) => name.startsWith("graph_") || name.startsWith("memory_"))).toBe(true);
		expect(names.some((name) => name.startsWith("_timescaledb"))).toBe(false);
	});

	test("ping answers true against a live index inside its default bound", async () => {
		expect(await store.ping()).toBe(true);
	});
});
