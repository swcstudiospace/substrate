/**
 * The sweep policy, proved without a database.
 *
 * `index-store.sweep.test.ts` runs the same classes against a scratch Postgres
 * when `SUBSTRATE_TEST_PG_URL` is set. What is provable here, every run, is the
 * part that must never be wrong by a day or by a statement: which rows each
 * class names, the cutoff each one is judged against for a fixed `now`, that a
 * dry-run executes nothing but counts, that `apply` stops at a short batch, and
 * that deleting takes two keys — the env *and* the flag.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	DEFAULT_SWEEP_POLICY,
	SWEEP_CLASSES,
	SWEEP_CLASS_IDS,
	TERMINAL_GRAPH_STATUSES,
	executeSweep,
	formatSweepReport,
	planSweep,
	resolveSweepMode,
	sweepCounts,
	sweepModeFromEnv,
	sweepPolicyFromEnv,
	type SweepStatement,
} from "./index-sweep.ts";
import { FORGET_MARKER_PREFIX } from "./memory-forget.ts";

/** 2026-10-13T12:00Z — the cutoffs below are this minus whole days. */
const NOW = Date.UTC(2026, 9, 13, 12);
const DAY = 24 * 60 * 60 * 1000;
const iso = (daysAgo: number): string => new Date(NOW - daysAgo * DAY).toISOString();

describe("sweepPolicyFromEnv", () => {
	test("defaults match the documented retention", () => {
		expect(sweepPolicyFromEnv({})).toEqual({
			derivedWritesDays: 7,
			explicitWritesDays: 30,
			reviewsDays: 30,
			quarantineDays: 30,
			graphsDays: 90,
			supersededDays: 90,
			batch: 500,
		});
		expect(sweepPolicyFromEnv({})).toEqual(DEFAULT_SWEEP_POLICY);
	});

	test("every knob reads its env name and bad values fall back instead of throwing", () => {
		expect(
			sweepPolicyFromEnv({
				SUBSTRATE_SWEEP_DERIVED_WRITES_DAYS: "3",
				SUBSTRATE_SWEEP_EXPLICIT_WRITES_DAYS: "60",
				SUBSTRATE_SWEEP_REVIEWS_DAYS: "14",
				SUBSTRATE_SWEEP_QUARANTINE_DAYS: "45",
				SUBSTRATE_SWEEP_GRAPHS_DAYS: "180",
				SUBSTRATE_SWEEP_SUPERSEDED_DAYS: "365",
				SUBSTRATE_SWEEP_BATCH: "50",
			}),
		).toEqual({
			derivedWritesDays: 3,
			explicitWritesDays: 60,
			reviewsDays: 14,
			quarantineDays: 45,
			graphsDays: 180,
			supersededDays: 365,
			batch: 50,
		});
		// Zero, negative, fractional, out of range and prose all mean "the default".
		expect(
			sweepPolicyFromEnv({
				SUBSTRATE_SWEEP_DERIVED_WRITES_DAYS: "0",
				SUBSTRATE_SWEEP_EXPLICIT_WRITES_DAYS: "-1",
				SUBSTRATE_SWEEP_REVIEWS_DAYS: "1.5",
				SUBSTRATE_SWEEP_QUARANTINE_DAYS: "9999",
				SUBSTRATE_SWEEP_GRAPHS_DAYS: "ninety",
				SUBSTRATE_SWEEP_BATCH: "100000",
			}),
		).toEqual(DEFAULT_SWEEP_POLICY);
	});
});

describe("sweep mode", () => {
	test("the env defaults to dry-run and never applies by accident", () => {
		expect(sweepModeFromEnv({})).toBe("dry-run");
		expect(sweepModeFromEnv({ SUBSTRATE_INDEX_SWEEP: "APPLY " })).toBe("apply");
		expect(sweepModeFromEnv({ SUBSTRATE_INDEX_SWEEP: "off" })).toBe("off");
		expect(sweepModeFromEnv({ SUBSTRATE_INDEX_SWEEP: "yes" })).toBe("dry-run");
		expect(sweepModeFromEnv({ SUBSTRATE_INDEX_SWEEP: "1" })).toBe("dry-run");
	});

	test("--apply is refused unless the env also says apply: two keys to delete", () => {
		expect(resolveSweepMode({ env: {}, apply: true }).refused).toContain("SUBSTRATE_INDEX_SWEEP=apply");
		expect(resolveSweepMode({ env: { SUBSTRATE_INDEX_SWEEP: "dry-run" }, apply: true }).refused).toContain("dry-run");
		expect(resolveSweepMode({ env: { SUBSTRATE_INDEX_SWEEP: "off" }, apply: true }).refused).toBeDefined();
		expect(resolveSweepMode({ env: { SUBSTRATE_INDEX_SWEEP: "apply" }, apply: true })).toEqual({ mode: "apply" });
	});

	test("without a flag the env decides, which is how the timer runs; --dry-run always wins", () => {
		expect(resolveSweepMode({ env: {} })).toEqual({ mode: "dry-run" });
		expect(resolveSweepMode({ env: { SUBSTRATE_INDEX_SWEEP: "apply" } })).toEqual({ mode: "apply" });
		expect(resolveSweepMode({ env: { SUBSTRATE_INDEX_SWEEP: "off" } })).toEqual({ mode: "off" });
		expect(resolveSweepMode({ env: { SUBSTRATE_INDEX_SWEEP: "apply" }, dryRun: true })).toEqual({ mode: "dry-run" });
		expect(resolveSweepMode({ env: { SUBSTRATE_INDEX_SWEEP: "off" }, dryRun: true })).toEqual({ mode: "dry-run" });
	});
});

describe("planSweep", () => {
	test("names every class once, in a stable order, with the cutoff its retention implies", () => {
		const steps = planSweep(DEFAULT_SWEEP_POLICY, NOW);
		expect(steps.map((step) => step.cls.id)).toEqual([...SWEEP_CLASS_IDS]);
		expect(Object.fromEntries(steps.map((step) => [step.cls.id, step.cutoff]))).toEqual({
			"writes-derived-spent": iso(7),
			"writes-explicit-spent": iso(30),
			"reviews-decided": iso(30),
			"quarantine-released": iso(30),
			"quarantine-unresolved": iso(30),
			"graphs-terminal": iso(90),
			"entries-superseded": iso(90),
			"entries-ttl-30d": iso(30),
			"entries-ttl-graph": iso(90),
		});
	});

	test("the policy moves its own classes and leaves the 30d ttl class where its name puts it", () => {
		const steps = planSweep({ ...DEFAULT_SWEEP_POLICY, reviewsDays: 5, graphsDays: 10 }, NOW);
		const by = Object.fromEntries(steps.map((step) => [step.cls.id, step]));
		expect(by["reviews-decided"]?.cutoff).toBe(iso(5));
		expect(by["graphs-terminal"]?.cutoff).toBe(iso(10));
		expect(by["entries-ttl-graph"]?.cutoff).toBe(iso(10));
		expect(by["entries-ttl-30d"]?.cutoff).toBe(iso(30));
		expect(by["entries-ttl-30d"]?.days).toBe(30);
	});

	test("the ttl classes are report-only by default and under report, and deletable only under enforce", () => {
		// The default is what every caller before N4 got: no option, no delete.
		for (const steps of [planSweep(DEFAULT_SWEEP_POLICY, NOW), planSweep(DEFAULT_SWEEP_POLICY, NOW, { expiry: "report" })]) {
			const by = Object.fromEntries(steps.map((step) => [step.cls.id, step.cls]));
			expect(by["entries-ttl-30d"]?.mode).toBe("report");
			expect(by["entries-ttl-graph"]?.mode).toBe("report");
			expect(by["entries-ttl-30d"]?.deleteBatch).toBeUndefined();
			expect(by["entries-ttl-graph"]?.deleteBatch).toBeUndefined();
		}
		const enforced = planSweep(DEFAULT_SWEEP_POLICY, NOW, { expiry: "enforce" });
		const by = Object.fromEntries(enforced.map((step) => [step.cls.id, step.cls]));
		expect(by["entries-ttl-30d"]?.mode).toBe("delete");
		expect(by["entries-ttl-graph"]?.mode).toBe("delete");
		expect(typeof by["entries-ttl-30d"]?.deleteBatch).toBe("function");
		expect(typeof by["entries-ttl-graph"]?.deleteBatch).toBe("function");
		// Everything else is untouched by the switch, cutoffs included.
		const plain = planSweep(DEFAULT_SWEEP_POLICY, NOW);
		for (const [i, step] of enforced.entries()) {
			expect(step.cutoff).toBe(plain[i]!.cutoff);
			if (!step.cls.id.startsWith("entries-ttl-")) expect(step.cls).toBe(plain[i]!.cls);
		}
		// And `SWEEP_CLASSES` itself did not change under anyone's feet.
		expect(SWEEP_CLASSES.filter((cls) => cls.id.startsWith("entries-ttl-")).every((cls) => cls.mode === "report")).toBe(true);
	});
});

describe("the classes", () => {
	const by = Object.fromEntries(SWEEP_CLASSES.map((cls) => [cls.id, cls]));
	const cutoff = iso(30);

	test("deletable classes are exactly the spent ones; ttl and unresolved quarantine are report-only", () => {
		const modes = Object.fromEntries(SWEEP_CLASSES.map((cls) => [cls.id, cls.mode]));
		expect(modes).toEqual({
			"writes-derived-spent": "delete",
			"writes-explicit-spent": "delete",
			"reviews-decided": "delete",
			"quarantine-released": "delete",
			"quarantine-unresolved": "report",
			"graphs-terminal": "delete",
			"entries-superseded": "delete",
			"entries-ttl-30d": "report",
			"entries-ttl-graph": "report",
		});
		for (const cls of SWEEP_CLASSES) {
			expect(cls.deleteBatch === undefined).toBe(cls.mode === "report");
		}
	});

	test("a count and its delete share one predicate, so what is reported is what is removed", () => {
		for (const cls of SWEEP_CLASSES) {
			if (!cls.deleteBatch) continue;
			const count = cls.count(cutoff);
			const del = cls.deleteBatch(cutoff, 500).pick;
			const predicate = /where (.+)$/.exec(count.text)?.[1];
			expect(predicate).toBeDefined();
			expect(del.text).toContain(predicate!);
			expect(del.text).toMatch(/limit \$\d+ for update skip locked/);
			expect(count.params[0]).toBe(cutoff);
			expect(del.params[0]).toBe(cutoff);
			expect(del.params.at(-1)).toBe(500);
			if (cls.id !== "graphs-terminal") expect(del.text).toMatch(/^with doomed as/);
		}
	});

	test("count statements never modify anything", () => {
		for (const cls of SWEEP_CLASSES) {
			expect(cls.count(cutoff).text).toMatch(/^select count\(\*\)::int as candidates from /);
			expect(cls.count(cutoff).text).not.toMatch(/\b(delete|update|insert|truncate)\b/i);
		}
	});

	test("idempotency rows: derived and explicit are split, and in-flight claims are never touched", () => {
		expect(by["writes-derived-spent"]!.count(cutoff).text).toContain(
			"memory_writes q where explicit = false and outcome <> 'in-flight' and claimed < $1::timestamptz",
		);
		expect(by["writes-explicit-spent"]!.count(cutoff).text).toContain(
			"memory_writes q where explicit = true and outcome <> 'in-flight' and claimed < $1::timestamptz",
		);
	});

	test("reviews: decided rows only, judged on when they were decided", () => {
		expect(by["reviews-decided"]!.count(cutoff).text).toContain(
			"memory_reviews q where state <> 'pending' and coalesce(decided, created) < $1::timestamptz",
		);
	});

	test("quarantine: released means the same content later landed; the rest is reported, never deleted", () => {
		const landed = "exists (select 1 from memory_entries e where e.entry_hash = q.entry_hash)";
		expect(by["quarantine-released"]!.count(cutoff).text).toContain(`created < $1::timestamptz and ${landed}`);
		expect(by["quarantine-unresolved"]!.count(cutoff).text).toContain(`created < $1::timestamptz and not ${landed}`);
	});

	test("terminal graphs: the status list is the brief's, no graph with a live lease is a candidate, and the cascade locks every node then decides per graph", () => {
		const graphs = by["graphs-terminal"]!;
		const liveLease =
			"n.claimed_by is not null and coalesce(n.lease_expires_at, n.claimed_at + make_interval(secs => 900)) > now()";
		const count = graphs.count(cutoff);
		expect(count.text).toContain("g.status = any(string_to_array($2::text, '|')) and g.updated < $1::timestamptz");
		expect(count.text).toContain(`and not exists (select 1 from graph_nodes n where n.graph_id = g.graph_id and ${liveLease})`);
		expect(count.params).toEqual([cutoff, TERMINAL_GRAPH_STATUSES.join("|")]);
		expect(TERMINAL_GRAPH_STATUSES).toEqual(["Merged", "Resolved", "Done", "Won't Fix", "Closed", "Failed", "Canceled"]);

		const batch = graphs.deleteBatch!(cutoff, 100);
		// The pick is the count's predicate — live-lease exclusion included — locked.
		expect(batch.pick.text).toBe(
			`select g.graph_id from graph_index g where ${/where (.+)$/.exec(count.text)![1]} limit $3 for update skip locked`,
		);
		expect(batch.pick.params).toEqual([cutoff, TERMINAL_GRAPH_STATUSES.join("|"), 100]);
		expect(batch.skippedAs).toBe("skipped_live_lease");

		const picked = [{ graph_id: "ut-a" }, { graph_id: "ut-b" }, { graph_id: "ut-c" }];
		// The lock takes every node row of the picked graphs — plain `for update`, so
		// it waits for a claim in flight and reads the row version that claim wrote —
		// and reports each row's lease state; the ids travel as JSON text.
		const lock = batch.lock!(picked);
		expect(lock.text).toBe(
			`select n.graph_id, (${liveLease}) as live from graph_nodes n ` +
				"where n.graph_id in (select jsonb_array_elements_text($1::text::jsonb)) for update",
		);
		expect(lock.text).not.toContain("skip locked");
		expect(lock.params).toEqual([JSON.stringify(["ut-a", "ut-b", "ut-c"])]);

		// ut-a: two free nodes; ut-b: one free, one live; ut-c: no node rows at all.
		const locked = [
			{ graph_id: "ut-a", live: false },
			{ graph_id: "ut-a", live: false },
			{ graph_id: "ut-b", live: false },
			{ graph_id: "ut-b", live: true },
		];
		const [nodes, graphsThenRest, ...more] = batch.decide!(picked, locked);
		expect(more).toEqual([]);
		// Only the graphs with no live node are named — ut-b in neither statement, so
		// none of its rows (its free node included) is touched; ut-c, nodeless, goes.
		const ids = JSON.stringify(["ut-a", "ut-c"]);
		expect(nodes!.text).toContain("delete from graph_nodes n where n.graph_id in (select jsonb_array_elements_text($1::text::jsonb)) returning 1");
		expect(nodes!.text).not.toContain("claimed_by");
		expect(nodes!.params).toEqual([ids]);
		// Then the index row only where no node survived, and the FK-less tables only for graphs whose row went.
		expect(graphsThenRest!.text).toContain(
			"delete from graph_index gi where gi.graph_id in (select jsonb_array_elements_text($1::text::jsonb)) " +
				"and not exists (select 1 from graph_nodes n where n.graph_id = gi.graph_id) returning gi.graph_id",
		);
		for (const table of ["graph_edges", "graph_steps", "graph_bindings"]) {
			expect(graphsThenRest!.text).toContain(`delete from ${table} where graph_id in (select graph_id from g)`);
		}
		expect(graphsThenRest!.text).toMatch(/as deleted, .*as edges, .*as steps, .*as bindings$/);
		expect(graphsThenRest!.params).toEqual([ids]);
		for (const statement of [nodes!, graphsThenRest!]) expect(JSON.stringify(statement)).not.toContain("ut-b");

		// Every picked graph live: nothing is issued at all.
		expect(batch.decide!([{ graph_id: "ut-b" }], [{ graph_id: "ut-b", live: true }])).toEqual([]);
	});

	test("entries-superseded never names a forgotten row: its count and its delete both exclude the forget marker", () => {
		const cls = by["entries-superseded"]!;
		// The forget unit's marker is `forgotten:fg_...`; the predicate is built from the module's own prefix.
		const exclusion = `left(superseded_by, ${FORGET_MARKER_PREFIX.length}) <> '${FORGET_MARKER_PREFIX}'`;
		expect(cls.count(cutoff).text).toContain(exclusion);
		expect(cls.deleteBatch!(cutoff, 10).pick.text).toContain(exclusion);
		// The exclusion narrows the predicate; it does not replace the not-null rule.
		expect(cls.count(cutoff).text).toContain("superseded_by is not null and created < $1::timestamptz");
	});

	test("memory entries: superseded versions are deletable; ttl classes only count rows the reads still return", () => {
		expect(by["entries-superseded"]!.count(cutoff).text).toContain(
			"memory_entries q where superseded_by is not null and created < $1::timestamptz",
		);
		expect(by["entries-ttl-30d"]!.count(cutoff).text).toContain(
			"memory_entries where ttl = '30d' and superseded_by is null and created < $1::timestamptz",
		);
		const graphTtl = by["entries-ttl-graph"]!.count(cutoff);
		expect(graphTtl.text).toContain("ttl = 'graph' and superseded_by is null and created < $1::timestamptz");
		// The graph is `memoryGraphId`'s: `graph_id`, or the tail of a `graph:` scope —
		// the identity the reads judge by, so the sweep and `memoryExpiry` agree.
		expect(graphTtl.text).toContain(
			"not exists (select 1 from graph_index g where g.graph_id = coalesce(e.graph_id, " +
				"case when left(e.scope, 6) = 'graph:' then substr(e.scope, 7) end)",
		);
		expect(graphTtl.params).toEqual([cutoff, TERMINAL_GRAPH_STATUSES.join("|")]);
	});

	test("the ttl classes carry a delete only under enforce, and it removes exactly what the count named", () => {
		// `SWEEP_CLASSES` itself never exposes it: nothing that plans without the
		// switch can reach a ttl delete.
		for (const id of ["entries-ttl-30d", "entries-ttl-graph"] as const) {
			expect(by[id]!.deleteBatch).toBeUndefined();
			expect(by[id]!.underEnforce?.mode).toBe("delete");
			const count = by[id]!.count(cutoff);
			const pick = by[id]!.underEnforce!.deleteBatch(cutoff, 500).pick;
			// Same `from … where …` text in both statements, then the limit as the next parameter.
			const predicate = count.text.slice(count.text.indexOf("from ") + 5);
			expect(pick.text).toContain(`select id from ${predicate} limit $${count.params.length + 1} for update skip locked`);
			expect(pick.text).toContain("delete from memory_entries q using doomed where q.id = doomed.id");
			expect(pick.params).toEqual([...count.params, 500]);
		}
		expect(by["entries-superseded"]!.underEnforce).toBeUndefined();
	});
});

describe("executeSweep", () => {
	/**
	 * A runner that answers every count with `candidates`, every simple delete with
	 * a full batch until the rows are gone, and the graph class's pick with that
	 * many ids followed by a cascade that removes them all.
	 */
	function fakeRunner(candidates: number) {
		const statements: SweepStatement[] = [];
		let remaining = candidates;
		let picked = 0;
		const run = async (statement: SweepStatement) => {
			statements.push(statement);
			if (statement.text.startsWith("select count")) return [{ candidates }];
			if (statement.text.startsWith("select g.graph_id")) {
				picked = Math.min(Number(statement.params.at(-1)), remaining);
				remaining -= picked;
				return Array.from({ length: picked }, (_, i) => ({ graph_id: `g${i}` }));
			}
			// The lock: every picked graph has two nodes, neither held.
			if (statement.text.startsWith("select n.graph_id")) {
				const ids = JSON.parse(String(statement.params[0])) as string[];
				return ids.flatMap((graph_id) => [
					{ graph_id, live: false },
					{ graph_id, live: false },
				]);
			}
			if (statement.text.includes("delete from graph_nodes")) return [{ nodes: picked * 2 }];
			if (statement.text.includes("delete from graph_index")) return [{ deleted: picked, edges: 0, steps: 0, bindings: 0 }];
			const limit = Number(statement.params.at(-1));
			const deleted = Math.min(limit, remaining);
			remaining -= deleted;
			return [{ deleted }];
		};
		return { run, statements };
	}

	test("a dry-run executes the count statements and nothing else", async () => {
		const { run, statements } = fakeRunner(7);
		const report = await executeSweep(run, planSweep(DEFAULT_SWEEP_POLICY, NOW), { apply: false, batch: 500, now: NOW });
		expect(report.apply).toBe(false);
		expect(report.at).toBe(new Date(NOW).toISOString());
		expect(statements).toHaveLength(SWEEP_CLASSES.length);
		for (const statement of statements) expect(statement.text).toMatch(/^select count/);
		for (const cls of report.classes) {
			expect(cls.candidates).toBe(7);
			expect(cls.deleted).toBe(0);
		}
	});

	test("apply counts everything first, then deletes the deletable classes in batches until one comes back short", async () => {
		const { run, statements } = fakeRunner(1_200);
		const steps = planSweep(DEFAULT_SWEEP_POLICY, NOW).filter((step) => step.cls.id === "graphs-terminal");
		const report = await executeSweep(run, steps, { apply: true, batch: 500, now: NOW });
		// Count once; then per round: pick, node lock, node delete, graph+cascade
		// delete. 500, 500, 200 — the short third pick ends it.
		expect(statements.map((statement) => statement.text.slice(0, 11))).toEqual([
			"select coun",
			...Array(3).fill(["select g.gr", "select n.gr", "with d as (", "with g as ("]).flat(),
		]);
		expect(report.classes[0]).toMatchObject({
			id: "graphs-terminal",
			candidates: 1_200,
			deleted: 1_200,
			children: { nodes: 2_400, skipped_live_lease: 0 },
		});

		// A simple class takes one statement per round.
		const simple = fakeRunner(1_200);
		const superseded = planSweep(DEFAULT_SWEEP_POLICY, NOW).filter((step) => step.cls.id === "entries-superseded");
		await executeSweep(simple.run, superseded, { apply: true, batch: 500, now: NOW });
		expect(simple.statements.map((statement) => statement.text.slice(0, 11))).toEqual([
			"select coun",
			"with doomed",
			"with doomed",
			"with doomed",
		]);
	});

	test("apply never issues a delete for a report-only class or an empty one", async () => {
		const { run, statements } = fakeRunner(0);
		await executeSweep(run, planSweep(DEFAULT_SWEEP_POLICY, NOW), { apply: true, batch: 500, now: NOW });
		expect(statements.every((statement) => statement.text.startsWith("select count"))).toBe(true);

		const reportOnly = planSweep(DEFAULT_SWEEP_POLICY, NOW).filter((step) => step.cls.mode === "report");
		const second = fakeRunner(50);
		const report = await executeSweep(second.run, reportOnly, { apply: true, batch: 500, now: NOW });
		expect(second.statements.every((statement) => statement.text.startsWith("select count"))).toBe(true);
		expect(report.classes.map((cls) => [cls.candidates, cls.deleted])).toEqual([
			[50, 0],
			[50, 0],
			[50, 0],
		]);
	});

	test("under enforce the ttl classes delete on apply and still only count on a dry-run", async () => {
		const ttl = (expiry: "report" | "enforce") =>
			planSweep(DEFAULT_SWEEP_POLICY, NOW, { expiry }).filter((step) => step.cls.id.startsWith("entries-ttl-"));

		// Dry-run under enforce: counts, nothing else — the sweep mode is its own key.
		const dry = fakeRunner(7);
		const dryReport = await executeSweep(dry.run, ttl("enforce"), { apply: false, batch: 500, now: NOW, expiry: "enforce" });
		expect(dry.statements.every((statement) => statement.text.startsWith("select count"))).toBe(true);
		expect(dryReport.expiry).toBe("enforce");
		expect(dryReport.classes.map((cls) => [cls.mode, cls.candidates, cls.deleted])).toEqual([
			["delete", 7, 0],
			["delete", 7, 0],
		]);

		// Apply under report: still counts only, whatever the sweep mode says.
		const reporting = fakeRunner(7);
		const reported = await executeSweep(reporting.run, ttl("report"), { apply: true, batch: 500, now: NOW, expiry: "report" });
		expect(reporting.statements.every((statement) => statement.text.startsWith("select count"))).toBe(true);
		expect(reported.expiry).toBe("report");
		expect(reported.classes.map((cls) => [cls.mode, cls.candidates, cls.deleted])).toEqual([
			["report", 7, 0],
			["report", 7, 0],
		]);

		// Apply under enforce: one count then one delete round per class (the fake
		// holds one pool of rows, so each class gets its own), and the report says so.
		for (const step of ttl("enforce")) {
			const enforcing = fakeRunner(7);
			const enforced = await executeSweep(enforcing.run, [step], { apply: true, batch: 500, now: NOW, expiry: "enforce" });
			expect(enforcing.statements.map((statement) => statement.text.slice(0, 11))).toEqual(["select coun", "with doomed"]);
			expect(enforced.classes.map((cls) => [cls.id, cls.mode, cls.candidates, cls.deleted])).toEqual([[step.cls.id, "delete", 7, 7]]);
			expect(formatSweepReport(enforced)).toContain("ttl classes: enforce");
		}
		const thirty = ttl("enforce").filter((step) => step.cls.id === "entries-ttl-30d");
		const rendered = formatSweepReport(await executeSweep(fakeRunner(7).run, thirty, { apply: true, batch: 500, now: NOW, expiry: "enforce" }));
		expect(rendered).toMatch(/entries-ttl-30d\s+delete\s+> {2}30d candidates\s+7\s+deleted\s+7\n/);
	});

	test("the batch loop is bounded by the count it took, so a racing writer cannot keep it running", async () => {
		const statements: SweepStatement[] = [];
		const run = async (statement: SweepStatement) => {
			statements.push(statement);
			return statement.text.startsWith("select count") ? [{ candidates: 10 }] : [{ deleted: 10 }];
		};
		const steps = planSweep(DEFAULT_SWEEP_POLICY, NOW).filter((step) => step.cls.id === "entries-superseded");
		const report = await executeSweep(run, steps, { apply: true, batch: 10, now: NOW });
		// ceil(10 / 10) + 1 rounds, every one a full batch, then it stops.
		expect(statements.filter((statement) => statement.text.startsWith("with doomed"))).toHaveLength(2);
		expect(report.classes[0]?.deleted).toBe(20);
	});

	test("a terminal graph claimed between pick and lock is kept whole, reported as skipped, and stops the loop", async () => {
		const statements: SweepStatement[] = [];
		const run = async (statement: SweepStatement) => {
			statements.push(statement);
			if (statement.text.startsWith("select count")) return [{ candidates: 4 }];
			// The pick finds two per round; one of them grows a live lease on one node
			// before the lock runs, so the lock reports that node live.
			if (statement.text.startsWith("select g.graph_id")) return [{ graph_id: "g-free" }, { graph_id: "g-claimed" }];
			if (statement.text.startsWith("select n.graph_id")) {
				return [
					{ graph_id: "g-free", live: false },
					{ graph_id: "g-free", live: false },
					{ graph_id: "g-claimed", live: false },
					{ graph_id: "g-claimed", live: true },
				];
			}
			if (statement.text.includes("delete from graph_nodes")) return [{ nodes: 2 }];
			return [{ deleted: 1, edges: 1, steps: 1, bindings: 1 }];
		};
		const steps = planSweep(DEFAULT_SWEEP_POLICY, NOW).filter((step) => step.cls.id === "graphs-terminal");
		const report = await executeSweep(run, steps, { apply: true, batch: 2, now: NOW });
		expect(report.classes[0]).toMatchObject({
			candidates: 4,
			deleted: 1,
			children: { nodes: 2, edges: 1, steps: 1, bindings: 1, skipped_live_lease: 1 },
		});
		// One round only: the pick was full but the delete fell short, so the sweep
		// stops rather than chasing a graph that is in use.
		expect(statements.filter((statement) => statement.text.startsWith("select g.graph_id"))).toHaveLength(1);
		// The lock carries both picked ids; every delete carries only the free graph —
		// the claimed graph's unleased sibling node is never named by any statement.
		const lock = statements.find((statement) => statement.text.startsWith("select n.graph_id"))!;
		expect(lock.params).toEqual([JSON.stringify(["g-free", "g-claimed"])]);
		const deletes = statements.filter((statement) => statement.text.includes("delete from"));
		expect(deletes).toHaveLength(2);
		for (const statement of deletes) expect(statement.params).toEqual([JSON.stringify(["g-free"])]);
	});

	test("a round whose every picked graph is live issues no delete, reports them all skipped, and stops", async () => {
		const statements: SweepStatement[] = [];
		const run = async (statement: SweepStatement) => {
			statements.push(statement);
			if (statement.text.startsWith("select count")) return [{ candidates: 2 }];
			if (statement.text.startsWith("select g.graph_id")) return [{ graph_id: "g-x" }, { graph_id: "g-y" }];
			if (statement.text.startsWith("select n.graph_id")) {
				return [
					{ graph_id: "g-x", live: true },
					{ graph_id: "g-y", live: true },
				];
			}
			throw new Error(`unexpected statement: ${statement.text}`);
		};
		const steps = planSweep(DEFAULT_SWEEP_POLICY, NOW).filter((step) => step.cls.id === "graphs-terminal");
		const report = await executeSweep(run, steps, { apply: true, batch: 2, now: NOW });
		expect(report.classes[0]).toMatchObject({ candidates: 2, deleted: 0, children: { skipped_live_lease: 2 } });
		expect(statements.map((statement) => statement.text.slice(0, 11))).toEqual(["select coun", "select g.gr", "select n.gr"]);
	});

	test("an empty pick issues no follow-up statements", async () => {
		const statements: SweepStatement[] = [];
		const run = async (statement: SweepStatement) => {
			statements.push(statement);
			return statement.text.startsWith("select count") ? [{ candidates: 2 }] : [];
		};
		const steps = planSweep(DEFAULT_SWEEP_POLICY, NOW).filter((step) => step.cls.id === "graphs-terminal");
		const report = await executeSweep(run, steps, { apply: true, batch: 500, now: NOW });
		expect(statements.map((statement) => statement.text.slice(0, 11))).toEqual(["select coun", "select g.gr"]);
		expect(report.classes[0]?.deleted).toBe(0);
	});
});

describe("report rendering", () => {
	test("the ledger payload carries counts only", async () => {
		const run = async (statement: SweepStatement) => {
			if (statement.text.startsWith("select count")) return [{ candidates: 3 }];
			if (statement.text.startsWith("select g.graph_id")) return [{ graph_id: "a" }, { graph_id: "b" }, { graph_id: "c" }];
			if (statement.text.startsWith("select n.graph_id")) return [{ graph_id: "a", live: false }];
			if (statement.text.includes("delete from graph_nodes")) return [{ nodes: 1 }];
			return [{ deleted: 3, edges: 2, steps: 0, bindings: 0 }];
		};
		const report = await executeSweep(run, planSweep(DEFAULT_SWEEP_POLICY, NOW), { apply: true, batch: 500, now: NOW });
		const counts = sweepCounts(report);
		expect(Object.keys(counts)).toEqual([...SWEEP_CLASS_IDS]);
		expect(counts["graphs-terminal"]).toEqual({ candidates: 3, deleted: 3 });
		expect(counts["entries-ttl-30d"]).toEqual({ candidates: 3, deleted: 0 });
		for (const value of Object.values(counts)) expect(Object.keys(value)).toEqual(["candidates", "deleted"]);

		const text = formatSweepReport(report);
		expect(text.startsWith(`index sweep APPLY at ${new Date(NOW).toISOString()} (batch 500)`)).toBe(true);
		expect(text).toContain("graphs-terminal");
		expect(text).toContain("nodes 1, edges 2, steps 0, bindings 0, skipped_live_lease 0");
		expect(text).toMatch(/entries-ttl-30d\s+report\s+> {2}30d candidates\s+3\s+deleted\s+0\n/);
	});
});

describe("the runner", () => {
	test("refuses --apply without SUBSTRATE_INDEX_SWEEP=apply before it reads any config or opens a store", () => {
		// Spawned rather than imported: the entry point acts at import time, like
		// anchor-run.ts. The environment is explicit so a developer's .env cannot
		// leak the second key into the test.
		const result = Bun.spawnSync({
			cmd: [process.execPath, join(import.meta.dir, "index-sweep-run.ts"), "--apply"],
			env: { PATH: process.env.PATH ?? "", SUBSTRATE_INDEX_SWEEP: "dry-run" },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(2);
		expect(result.stderr.toString()).toContain("SUBSTRATE_INDEX_SWEEP=apply");
		expect(result.stderr.toString()).toContain("two keys");
	});

	test("off exits 0 and does nothing, whatever else is set", () => {
		const result = Bun.spawnSync({
			cmd: [process.execPath, join(import.meta.dir, "index-sweep-run.ts")],
			env: { PATH: process.env.PATH ?? "", SUBSTRATE_INDEX_SWEEP: "off" },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toContain("nothing to do");
	});

	test("an unknown flag is a usage error", () => {
		const result = Bun.spawnSync({
			cmd: [process.execPath, join(import.meta.dir, "index-sweep-run.ts"), "--yes"],
			env: { PATH: process.env.PATH ?? "", SUBSTRATE_INDEX_SWEEP: "dry-run" },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(2);
		expect(result.stderr.toString()).toContain("usage:");
	});
});
