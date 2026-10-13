/**
 * Retention for the Postgres index: which rows the sweeper may remove, after how
 * long, and the exact SQL it runs — pure, so every class is provable without a
 * database. `IndexStore.sweep` executes what is built here; `index-sweep-run.ts`
 * is the host job and the CLI target.
 *
 * The index is a cache over Notion and Linear plus the memory governance tables,
 * and nothing in it was ever deleted (`migrate` only adds). `docs/data-planes.md`
 * promised "open Graph IDs + 90 days"; this is the first code that keeps that
 * promise, and it keeps it carefully:
 *
 *   - **Dry-run is the default.** Without `SUBSTRATE_INDEX_SWEEP=apply` the sweep
 *     runs the COUNT statements and nothing else. The CLI's `--apply` additionally
 *     requires that env value: two keys to delete.
 *   - **Deletable classes are the spent ones.** An idempotency row whose dedup
 *     window has long passed, a review already decided, a quarantined write whose
 *     content a reviewer later landed, a finished graph nobody has touched for a
 *     quarter, a memory version a newer one has superseded.
 *   - **Report-only classes are counted, never deleted.** The read paths
 *     (`searchMemoryPage`, `memoryForBrief`) do not filter on `ttl`, so a `30d`
 *     entry older than 30 days is still what an agent is briefed with; deleting it
 *     here would change answers the reads still give. They are reported so the
 *     operator can see the gap, and they stay until the reads honour `ttl`.
 *     `memory_quarantine` has no decision column at all, so a parked row whose
 *     content never landed is reported rather than guessed at.
 *   - **Cutoffs are computed here from one `now`,** never by the database, so a
 *     test can pin them and the report says exactly which instant each class was
 *     judged against.
 *   - **Deletes are batched** through a `limit`ed CTE with `for update skip locked`:
 *     each statement touches at most `batch` rows, stays inside the connection's
 *     `statement_timeout`, and steps around any row a live writer holds. The whole
 *     apply still runs in one transaction (`IndexStore.sweep`), so a failure half
 *     way leaves the index as it was.
 */

/** Statuses that mean a graph is finished — exactly Notion's `complete` status group on the Agent Task Graph. */
export const TERMINAL_GRAPH_STATUSES = ["Merged", "Resolved", "Done", "Won't Fix", "Closed", "Failed", "Canceled"] as const;

export const SWEEP_MODES = ["dry-run", "apply", "off"] as const;
export type SweepMode = (typeof SWEEP_MODES)[number];
export const SWEEP_MODE_ENV = "SUBSTRATE_INDEX_SWEEP";

/** Days each class waits before a row is a candidate. Every one is overridable by env. */
export interface SweepPolicy {
	/** Derived idempotency keys dedupe for 24 h (`DERIVED_KEY_WINDOW_MS`); a week later the row serves nothing. */
	derivedWritesDays: number;
	/** Explicit keys: exactly-once is guaranteed for this long. A replay after it writes again. */
	explicitWritesDays: number;
	/** Decided (`approved`) review rows — an audit trail, kept this long. */
	reviewsDays: number;
	/** Quarantine rows, released or not, are judged after this long. */
	quarantineDays: number;
	/** Graphs in a terminal status with no update for this long, with their nodes, edges, steps and bindings. */
	graphsDays: number;
	/** Superseded memory versions — the decision log — kept this long after they were written. */
	supersededDays: number;
	/** Rows per DELETE statement. */
	batch: number;
}

export const DEFAULT_SWEEP_POLICY: SweepPolicy = {
	derivedWritesDays: 7,
	explicitWritesDays: 30,
	reviewsDays: 30,
	quarantineDays: 30,
	graphsDays: 90,
	supersededDays: 90,
	batch: 500,
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 3650;
const MAX_BATCH = 5000;

/** Env name per knob, read by {@link sweepPolicyFromEnv}. */
export const SWEEP_POLICY_ENV = {
	derivedWritesDays: "SUBSTRATE_SWEEP_DERIVED_WRITES_DAYS",
	explicitWritesDays: "SUBSTRATE_SWEEP_EXPLICIT_WRITES_DAYS",
	reviewsDays: "SUBSTRATE_SWEEP_REVIEWS_DAYS",
	quarantineDays: "SUBSTRATE_SWEEP_QUARANTINE_DAYS",
	graphsDays: "SUBSTRATE_SWEEP_GRAPHS_DAYS",
	supersededDays: "SUBSTRATE_SWEEP_SUPERSEDED_DAYS",
	batch: "SUBSTRATE_SWEEP_BATCH",
} as const satisfies Record<keyof SweepPolicy, string>;

/** A positive integer within bounds, or the fallback. Bad values never throw: a typo must not stop the job. */
function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
	const text = raw?.trim();
	if (!text || !/^\d+$/.test(text)) return fallback;
	const value = Number(text);
	if (!Number.isSafeInteger(value) || value < min || value > max) return fallback;
	return value;
}

export function sweepPolicyFromEnv(env: Record<string, string | undefined> = process.env): SweepPolicy {
	const days = (key: keyof Omit<SweepPolicy, "batch">): number =>
		boundedInt(env[SWEEP_POLICY_ENV[key]], DEFAULT_SWEEP_POLICY[key], 1, MAX_DAYS);
	return {
		derivedWritesDays: days("derivedWritesDays"),
		explicitWritesDays: days("explicitWritesDays"),
		reviewsDays: days("reviewsDays"),
		quarantineDays: days("quarantineDays"),
		graphsDays: days("graphsDays"),
		supersededDays: days("supersededDays"),
		batch: boundedInt(env[SWEEP_POLICY_ENV.batch], DEFAULT_SWEEP_POLICY.batch, 1, MAX_BATCH),
	};
}

/** `SUBSTRATE_INDEX_SWEEP`, defaulting to dry-run. Anything unrecognised is dry-run too: never apply by accident. */
export function sweepModeFromEnv(env: Record<string, string | undefined> = process.env): SweepMode {
	const raw = env[SWEEP_MODE_ENV]?.trim().toLowerCase();
	return (SWEEP_MODES as readonly string[]).includes(raw ?? "") ? (raw as SweepMode) : "dry-run";
}

/**
 * The mode a run should take, from the env and the flags it was given.
 *
 * `--apply` is refused unless the env also says `apply` — the flag alone is one
 * key, and deleting takes two. `--dry-run` wins over everything, including `off`,
 * because a read-only report is always allowed. With neither flag the env decides,
 * which is how the timer unit runs.
 */
export function resolveSweepMode(input: {
	env: Record<string, string | undefined>;
	apply?: boolean;
	dryRun?: boolean;
}): { mode: SweepMode; refused?: undefined } | { mode?: undefined; refused: string } {
	const envMode = sweepModeFromEnv(input.env);
	if (input.dryRun) return { mode: "dry-run" };
	if (input.apply) {
		if (envMode === "apply") return { mode: "apply" };
		return {
			refused:
				`--apply needs ${SWEEP_MODE_ENV}=apply in the environment as well (it is ` +
				`${input.env[SWEEP_MODE_ENV]?.trim() ? JSON.stringify(input.env[SWEEP_MODE_ENV]?.trim()) : "unset"}); ` +
				"two keys to delete. Run without --apply for the dry-run report.",
		};
	}
	return { mode: envMode };
}

// ── classes ─────────────────────────────────────────────────────────────────

export const SWEEP_CLASS_IDS = [
	"writes-derived-spent",
	"writes-explicit-spent",
	"reviews-decided",
	"quarantine-released",
	"quarantine-unresolved",
	"graphs-terminal",
	"entries-superseded",
	"entries-ttl-30d",
	"entries-ttl-graph",
] as const;
export type SweepClassId = (typeof SWEEP_CLASS_IDS)[number];

/** One statement with positional `$n` parameters, for `sql.unsafe(text, params)`. */
export interface SweepStatement {
	text: string;
	params: unknown[];
}

export interface SweepClass {
	id: SweepClassId;
	/** `delete` removes candidates on apply; `report` only ever counts them. */
	mode: "delete" | "report";
	/** The policy knob whose day count bounds this class, or a fixed count the policy cannot move (a `ttl`). */
	days: keyof Omit<SweepPolicy, "batch"> | number;
	/** One row: `{ candidates: int }`. */
	count(cutoff: string): SweepStatement;
	/** One row: `{ deleted: int, …children }`. Absent on report-only classes. */
	deleteBatch?(cutoff: string, limit: number): SweepStatement;
}

/**
 * The terminal statuses as one `|`-joined parameter, split server-side. Bun's
 * driver stringifies a JS array parameter into a literal Postgres rejects (the
 * same quirk `memoryForBrief` notes), and none of the statuses contains `|`.
 */
const TERMINAL = TERMINAL_GRAPH_STATUSES.join("|");
const TERMINAL_SET = "string_to_array($2::text, '|')";

/**
 * Count and delete share one predicate per class, so what is reported is what is
 * removed. The predicate may qualify columns with `q` (the table's alias in both
 * statements); `doomed` carries only the key.
 */
function simpleClass(
	id: SweepClassId,
	days: SweepClass["days"],
	table: string,
	key: string,
	predicate: string,
): SweepClass {
	return {
		id,
		mode: "delete",
		days,
		count: (cutoff) => ({
			text: `select count(*)::int as candidates from ${table} q where ${predicate}`,
			params: [cutoff],
		}),
		deleteBatch: (cutoff, limit) => ({
			text:
				`with doomed as (select ${key} from ${table} q where ${predicate} limit $2 for update skip locked), ` +
				`d as (delete from ${table} q using doomed where q.${key} = doomed.${key} returning 1) ` +
				`select count(*)::int as deleted from d`,
			params: [cutoff, limit],
		}),
	};
}

function reportClass(id: SweepClassId, days: SweepClass["days"], from: string, params: (cutoff: string) => unknown[]): SweepClass {
	return {
		id,
		mode: "report",
		days,
		count: (cutoff) => ({ text: `select count(*)::int as candidates from ${from}`, params: params(cutoff) }),
	};
}

/** A quarantined write whose exact content (scope, kind, subject, text, writer) later landed through a reviewer. */
const QUARANTINE_LANDED = "exists (select 1 from memory_entries e where e.entry_hash = q.entry_hash)";

const GRAPH_TERMINAL_OLD = `status = any(${TERMINAL_SET}) and updated < $1::timestamptz`;

export const SWEEP_CLASSES: readonly SweepClass[] = [
	// A derived key is content + source event; it deduped for a day and is takeable
	// after that. In-flight rows are left alone at every age: one may still carry
	// the reservation a retry recovers, and the gate's own timeout handles them.
	simpleClass(
		"writes-derived-spent",
		"derivedWritesDays",
		"memory_writes",
		"idempotency_key",
		"explicit = false and outcome <> 'in-flight' and claimed < $1::timestamptz",
	),
	simpleClass(
		"writes-explicit-spent",
		"explicitWritesDays",
		"memory_writes",
		"idempotency_key",
		"explicit = true and outcome <> 'in-flight' and claimed < $1::timestamptz",
	),
	// `decided` is set with the state; `created` covers a row decided by an older build.
	simpleClass(
		"reviews-decided",
		"reviewsDays",
		"memory_reviews",
		"id",
		"state <> 'pending' and coalesce(decided, created) < $1::timestamptz",
	),
	simpleClass(
		"quarantine-released",
		"quarantineDays",
		"memory_quarantine",
		"id",
		`created < $1::timestamptz and ${QUARANTINE_LANDED}`,
	),
	reportClass(
		"quarantine-unresolved",
		"quarantineDays",
		`memory_quarantine q where created < $1::timestamptz and not ${QUARANTINE_LANDED}`,
		(cutoff) => [cutoff],
	),
	{
		id: "graphs-terminal",
		mode: "delete",
		days: "graphsDays",
		count: (cutoff) => ({
			text: `select count(*)::int as candidates from graph_index where ${GRAPH_TERMINAL_OLD}`,
			params: [cutoff, TERMINAL],
		}),
		// Edges, steps and bindings have no foreign key, so they are deleted by name;
		// nodes follow the graph through `on delete cascade` and are counted from the
		// statement's snapshot. Every data-modifying CTE here sees the same `doomed`
		// set, so one statement removes a whole graph or none of it.
		deleteBatch: (cutoff, limit) => ({
			text:
				`with doomed as (select graph_id from graph_index where ${GRAPH_TERMINAL_OLD} limit $3 for update skip locked), ` +
				"nodes as (select count(*)::int as n from graph_nodes where graph_id in (select graph_id from doomed)), " +
				"e as (delete from graph_edges where graph_id in (select graph_id from doomed) returning 1), " +
				"s as (delete from graph_steps where graph_id in (select graph_id from doomed) returning 1), " +
				"b as (delete from graph_bindings where graph_id in (select graph_id from doomed) returning 1), " +
				"g as (delete from graph_index where graph_id in (select graph_id from doomed) returning 1) " +
				"select (select count(*)::int from g) as deleted, (select n from nodes) as nodes, " +
				"(select count(*)::int from e) as edges, (select count(*)::int from s) as steps, " +
				"(select count(*)::int from b) as bindings",
			params: [cutoff, TERMINAL, limit],
		}),
	},
	// The standing entry's `supersedes` pointer then names a row that is gone; a
	// decision log older than the window is exactly what this retention gives up.
	simpleClass(
		"entries-superseded",
		"supersededDays",
		"memory_entries",
		"id",
		"superseded_by is not null and created < $1::timestamptz",
	),
	// The `30d` retention class, fixed by its name: the policy cannot move it.
	reportClass(
		"entries-ttl-30d",
		30,
		"memory_entries where ttl = '30d' and superseded_by is null and created < $1::timestamptz",
		(cutoff) => [cutoff],
	),
	// Old, scoped to a graph, and that graph is finished or no longer indexed.
	reportClass(
		"entries-ttl-graph",
		"graphsDays",
		"memory_entries e where ttl = 'graph' and superseded_by is null and created < $1::timestamptz " +
			"and not exists (select 1 from graph_index g where g.graph_id = e.graph_id " +
			`and (g.status is null or not (g.status = any(${TERMINAL_SET}))))`,
		(cutoff) => [cutoff, TERMINAL],
	),
];

// ── planning and execution ──────────────────────────────────────────────────

export interface SweepStep {
	cls: SweepClass;
	/** ISO instant: rows older than this are candidates. */
	cutoff: string;
	days: number;
}

/** The cutoff per class for one `now`. Pure, and what the report echoes. */
export function planSweep(policy: SweepPolicy, now: number): SweepStep[] {
	return SWEEP_CLASSES.map((cls) => {
		const days = typeof cls.days === "number" ? cls.days : policy[cls.days];
		return { cls, days, cutoff: new Date(now - days * DAY_MS).toISOString() };
	});
}

export interface SweepClassReport {
	id: SweepClassId;
	mode: "delete" | "report";
	days: number;
	cutoff: string;
	candidates: number;
	deleted: number;
	/** `graphs-terminal` only: rows removed alongside the graphs. */
	children?: Record<string, number>;
}

export interface SweepReport {
	apply: boolean;
	/** The `now` the cutoffs were taken from. */
	at: string;
	batch: number;
	classes: SweepClassReport[];
}

/** Runs one statement and returns its rows. `IndexStore` binds this to `sql.unsafe`, tests to a fake. */
export type SweepRunner = (statement: SweepStatement) => Promise<Array<Record<string, unknown>>>;

function int(value: unknown): number {
	const n = Number(value ?? 0);
	return Number.isFinite(n) ? n : 0;
}

/**
 * Count every class, then — only when `apply` — delete the deletable ones in
 * batches until a batch comes back short. Counts are taken first for every class
 * so a report-only class is judged before a delete changes what it would see
 * (`entries-ttl-graph` looks at `graph_index`, which `graphs-terminal` empties).
 *
 * The batch loop is bounded by the count it just took: a class that keeps
 * finding rows past that (a writer racing the sweep) stops rather than chasing it.
 */
export async function executeSweep(
	run: SweepRunner,
	steps: readonly SweepStep[],
	options: { apply: boolean; batch: number; now: number },
): Promise<SweepReport> {
	const classes: SweepClassReport[] = [];
	for (const step of steps) {
		const rows = await run(step.cls.count(step.cutoff));
		classes.push({
			id: step.cls.id,
			mode: step.cls.mode,
			days: step.days,
			cutoff: step.cutoff,
			candidates: int(rows[0]?.candidates),
			deleted: 0,
		});
	}
	if (options.apply) {
		for (const [i, step] of steps.entries()) {
			const report = classes[i]!;
			const build = step.cls.deleteBatch;
			if (!build || report.candidates === 0) continue;
			const maxRounds = Math.ceil(report.candidates / options.batch) + 1;
			for (let round = 0; round < maxRounds; round++) {
				const rows = await run(build(step.cutoff, options.batch));
				const row = rows[0] ?? {};
				const deleted = int(row.deleted);
				report.deleted += deleted;
				for (const [key, value] of Object.entries(row)) {
					if (key === "deleted") continue;
					report.children = { ...report.children, [key]: (report.children?.[key] ?? 0) + int(value) };
				}
				if (deleted < options.batch) break;
			}
		}
	}
	return { apply: options.apply, at: new Date(options.now).toISOString(), batch: options.batch, classes };
}

/** The report as an operator reads it on a terminal; `--json` prints the object instead. */
export function formatSweepReport(report: SweepReport): string {
	const lines = [`index sweep ${report.apply ? "APPLY" : "dry-run"} at ${report.at} (batch ${report.batch})`];
	for (const cls of report.classes) {
		const tail = cls.children ? ` (${Object.entries(cls.children).map(([k, v]) => `${k} ${v}`).join(", ")})` : "";
		lines.push(
			`  ${cls.id.padEnd(22)} ${cls.mode === "report" ? "report " : "delete "} >${String(cls.days).padStart(4)}d ` +
				`candidates ${String(cls.candidates).padStart(6)}  deleted ${String(cls.deleted).padStart(6)}${tail}`,
		);
	}
	return `${lines.join("\n")}\n`;
}

/** Counts only, for the ledger note: never bodies, ids or cutoffs. */
export function sweepCounts(report: SweepReport): Record<string, { candidates: number; deleted: number }> {
	const out: Record<string, { candidates: number; deleted: number }> = {};
	for (const cls of report.classes) out[cls.id] = { candidates: cls.candidates, deleted: cls.deleted };
	return out;
}
