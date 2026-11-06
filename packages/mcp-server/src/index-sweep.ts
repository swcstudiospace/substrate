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
 *   - **The two `ttl` classes follow the reads (uplift-3 N4).** `memoryExpiry`
 *     in `memory-policy.ts` is the one predicate the brief, `memory_search` and
 *     the retain forward judge an entry's lifetime by, and
 *     `SUBSTRATE_MEMORY_EXPIRY` says what the reads do about it: under `report`
 *     (the default) an expired `30d` or `graph` entry is still served, tagged, so
 *     deleting it here would change answers the reads still give — the classes
 *     only count. Under `enforce` the reads already hide it, and `planSweep`
 *     given `{ expiry: "enforce" }` makes the classes deletable — still only on
 *     `apply`, which the env and the flag gate separately. Two switches, three
 *     keys, before a `ttl` row goes.
 *   - **`memory_quarantine` is counted, never deleted,** when its content never
 *     landed: it has no decision column at all, so a parked row is reported
 *     rather than guessed at.
 *   - **Cutoffs are computed here from one `now`,** never by the database, so a
 *     test can pin them and the report says exactly which instant each class was
 *     judged against.
 *   - **Deletes are batched** through a `limit`ed `for update skip locked` pick:
 *     each statement touches at most `batch` rows, stays inside the connection's
 *     `statement_timeout`, and steps around any row a live writer holds. The whole
 *     apply still runs in one transaction (`IndexStore.sweep`), so a failure half
 *     way leaves the index as it was.
 *   - **A graph with a live lease is never swept.** Claims and heartbeats write
 *     `graph_nodes` only and do not refuse a finished graph, so an old terminal
 *     graph can be in use. Both the count and the pick exclude any graph holding a
 *     live lease, and the delete locks every node of a picked graph and re-reads
 *     its lease before deciding, per graph, so a claim landing between pick and
 *     delete keeps its graph whole — every node, edge, step and binding.
 */
import { DEFAULT_LEASE_TTL_SECONDS } from "./lease.ts";
import { FORGET_MARKER_PREFIX } from "./memory-forget.ts";
import { retainDocumentId } from "./memory-retain.ts";
import { bankForSurface, type HindsightConfig } from "./planes/hindsight.ts";
import type { MemoryExpiryMode } from "./types.ts";

/** Statuses that mean a graph is finished — exactly Notion's `complete` status group on the Agent Task Graph. */
export const TERMINAL_GRAPH_STATUSES = ["Merged", "Resolved", "Done", "Won't Fix", "Closed", "Failed", "Canceled"] as const;

const SWEEP_MODES = ["dry-run", "apply", "off"] as const;
type SweepMode = (typeof SWEEP_MODES)[number];
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
const SWEEP_POLICY_ENV = {
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
type SweepClassId = (typeof SWEEP_CLASS_IDS)[number];

/** One statement with positional `$n` parameters, for `sql.unsafe(text, params)`. */
export interface SweepStatement {
	text: string;
	params: unknown[];
}

/**
 * One round of deletion. `pick` either deletes outright and returns
 * `{ deleted, …children }` (the simple classes), or — when `decide` is present —
 * only selects and locks the keys to remove, returning one row per key;
 * `lock(picked)`, when present, then locks and re-reads the rows the decision
 * depends on, and `decide(picked, locked)` builds the statements that do the
 * removing from both. Each of those returns one row whose columns are merged
 * into the round's result.
 *
 * Separate statements rather than one WITH: the sub-statements of a data-modifying
 * CTE all run against the same snapshot and cannot see each other's effects, and
 * a locking read cannot be aggregated (`bool_or … for update` is refused), so
 * "lock every node, then delete the graph only if none is live" cannot be said
 * in one. The apply runs inside one transaction, so the locks `pick` and `lock`
 * take hold across every statement of the round.
 */
interface SweepBatch {
	pick: SweepStatement;
	/** With `decide`: locks the rows `decide` decides on; its rows are `decide`'s second argument. */
	lock?: (picked: Array<Record<string, unknown>>) => SweepStatement;
	decide?: (picked: Array<Record<string, unknown>>, locked: Array<Record<string, unknown>>) => SweepStatement[];
	/** With `decide`: the key under which picked-but-not-deleted rows are reported. */
	skippedAs?: string;
}

interface SweepClass {
	id: SweepClassId;
	/** `delete` removes candidates on apply; `report` only ever counts them. */
	mode: "delete" | "report";
	/** The policy knob whose day count bounds this class, or a fixed count the policy cannot move (a `ttl`). */
	days: keyof Omit<SweepPolicy, "batch"> | number;
	/** One row: `{ candidates: int }`. */
	count(cutoff: string): SweepStatement;
	/** Absent on report-only classes. */
	deleteBatch?(cutoff: string, limit: number): SweepBatch;
	/**
	 * What the class becomes when the reads enforce `ttl` (`planSweep` with
	 * `expiry: "enforce"`): the `ttl` classes carry their delete here, so
	 * `SWEEP_CLASSES` itself stays report-only and nothing reaches `deleteBatch`
	 * without that switch.
	 */
	underEnforce?: Required<Pick<SweepClass, "deleteBatch">> & { mode: "delete" };
}

/**
 * A node whose lease is live, in exactly the words the lease CAS helpers use
 * (`claimNode`, `heartbeatNode`, `reapExpiredLeases` in `index-store.ts`): a
 * holder, and an expiry — or the default TTL after the claim for rows written
 * before the column existed — still ahead of Postgres' clock. Claims do not
 * refuse a terminal graph and touch `graph_nodes` only, never `graph_index.updated`,
 * so an old finished graph can hold a live lease and must not be swept while it does.
 */
const LIVE_LEASE = (n: string): string =>
	`${n}.claimed_by is not null and coalesce(${n}.lease_expires_at, ${n}.claimed_at + make_interval(secs => ${DEFAULT_LEASE_TTL_SECONDS})) > now()`;

/**
 * A text parameter holding a JSON array of ids, expanded server-side (the
 * array-parameter quirk again). The parameter is typed `text` first: a bare
 * `$1::jsonb` makes the driver JSON-encode the JS string, which arrives as a
 * JSON *string* scalar and `jsonb_array_elements_text` refuses it (22023).
 */
const IDS_IN = (param: string): string => `in (select jsonb_array_elements_text(${param}::text::jsonb))`;

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
			pick: {
				text:
					`with doomed as (select ${key} from ${table} q where ${predicate} limit $2 for update skip locked), ` +
					`d as (delete from ${table} q using doomed where q.${key} = doomed.${key} returning 1) ` +
					`select count(*)::int as deleted from d`,
				params: [cutoff, limit],
			},
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

/**
 * A `ttl` class (uplift-3 N4): a report class whose delete exists but is only
 * reachable through `underEnforce`. Count and pick share `from`, so what is
 * reported is what would be removed; the pick's `limit` is the parameter after
 * the predicate's own, and the delete joins the picked keys back to the table.
 */
function ttlClass(id: SweepClassId, days: SweepClass["days"], from: string, params: (cutoff: string) => unknown[]): SweepClass {
	const table = from.slice(0, from.indexOf(" "));
	return {
		...reportClass(id, days, from, params),
		underEnforce: {
			mode: "delete",
			deleteBatch: (cutoff, limit) => {
				const bound = params(cutoff);
				return {
					pick: {
						text:
							`with doomed as (select id from ${from} limit $${bound.length + 1} for update skip locked), ` +
							`d as (delete from ${table} q using doomed where q.id = doomed.id returning 1) ` +
							"select count(*)::int as deleted from d",
						params: [...bound, limit],
					},
				};
			},
		},
	};
}

/** A quarantined write whose exact content (scope, kind, subject, text, writer) later landed through a reviewer. */
const QUARANTINE_LANDED = "exists (select 1 from memory_entries e where e.entry_hash = q.entry_hash)";

/** Finished, untouched for the window, and holding no live lease on any of its nodes. */
const GRAPH_TERMINAL_OLD =
	`g.status = any(${TERMINAL_SET}) and g.updated < $1::timestamptz ` +
	`and not exists (select 1 from graph_nodes n where n.graph_id = g.graph_id and ${LIVE_LEASE("n")})`;

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
			text: `select count(*)::int as candidates from graph_index g where ${GRAPH_TERMINAL_OLD}`,
			params: [cutoff, TERMINAL],
		}),
		// Four statements, in the apply transaction, because a claim can land between
		// the pick and the delete and no single statement can both lock the graph row
		// and re-read its nodes after that. The decision is per graph and made once,
		// in TypeScript, from locked rows — never per node row, so a graph is either
		// removed whole or left whole:
		//
		//   1. pick: lock up to `limit` candidate graph rows (`for update skip locked`),
		//      judged with the same no-live-lease predicate the count used.
		//   2. lock: `for update` every node row of the picked graphs and read each
		//      one's lease state. A concurrent `claimNode` is a row-level UPDATE on a
		//      node; the two serialise, and under READ COMMITTED a locking read that
		//      finds its row changed waits for that writer and returns the new
		//      version — so a claim committed before the lock is seen as live, and a
		//      claim after it blocks until this transaction commits, then finds its
		//      node gone (the CAS UPDATE matches zero rows).
		//   3. nodes: delete every node row of the graphs no locked row reported
		//      live. A graph with any live node gets no statement at all — none of
		//      its nodes, edges, steps, bindings or index row is touched — is unlocked
		//      at commit, and is reported as skipped for a live lease. A graph with
		//      no node rows has no live node and is removed.
		//   4. graphs: delete `graph_index` for those graphs where no node row
		//      remains (none should, after 3; a node row that appeared after the lock
		//      keeps its graph), then edges, steps and bindings only for the graphs
		//      whose index row went.
		//
		// The picked ids travel back as a JSON text parameter: the driver cannot take
		// an array, and the ids are the sweeper's own output, never caller text.
		deleteBatch: (cutoff, limit) => ({
			pick: {
				text: `select g.graph_id from graph_index g where ${GRAPH_TERMINAL_OLD} limit $3 for update skip locked`,
				params: [cutoff, TERMINAL, limit],
			},
			skippedAs: "skipped_live_lease",
			lock: (picked) => ({
				text:
					`select n.graph_id, (${LIVE_LEASE("n")}) as live from graph_nodes n ` +
					`where n.graph_id ${IDS_IN("$1")} for update`,
				params: [JSON.stringify(picked.map((row) => String(row.graph_id)))],
			}),
			decide: (picked, locked) => {
				const live = new Set(locked.filter((row) => row.live === true).map((row) => String(row.graph_id)));
				const doomed = picked.map((row) => String(row.graph_id)).filter((graphId) => !live.has(graphId));
				if (doomed.length === 0) return [];
				const ids = JSON.stringify(doomed);
				return [
					{
						text:
							`with d as (delete from graph_nodes n where n.graph_id ${IDS_IN("$1")} returning 1) ` +
							"select count(*)::int as nodes from d",
						params: [ids],
					},
					{
						text:
							`with g as (delete from graph_index gi where gi.graph_id ${IDS_IN("$1")} ` +
							"and not exists (select 1 from graph_nodes n where n.graph_id = gi.graph_id) returning gi.graph_id), " +
							"e as (delete from graph_edges where graph_id in (select graph_id from g) returning 1), " +
							"s as (delete from graph_steps where graph_id in (select graph_id from g) returning 1), " +
							"b as (delete from graph_bindings where graph_id in (select graph_id from g) returning 1) " +
							"select (select count(*)::int from g) as deleted, (select count(*)::int from e) as edges, " +
							"(select count(*)::int from s) as steps, (select count(*)::int from b) as bindings",
						params: [ids],
					},
				];
			},
		}),
	},
	// The standing entry's `supersedes` pointer then names a row that is gone; a
	// decision log older than the window is exactly what this retention gives up.
	// A FORGOTTEN row (`superseded_by = 'forgotten:fg_...'`, `memory-forget.ts`) is not a replaced version: it is the
	// audit record of what was forgotten and why, so it is kept however old it is.
	simpleClass(
		"entries-superseded",
		"supersededDays",
		"memory_entries",
		"id",
		"superseded_by is not null and created < $1::timestamptz " +
			`and left(superseded_by, ${FORGET_MARKER_PREFIX.length}) <> '${FORGET_MARKER_PREFIX}'`,
	),
	// The `30d` retention class, fixed by its name: the policy cannot move it.
	// `created < cutoff` is `memoryExpiry`'s `created + 30d <= now`, to the instant.
	ttlClass(
		"entries-ttl-30d",
		30,
		"memory_entries where ttl = '30d' and superseded_by is null and created < $1::timestamptz",
		(cutoff) => [cutoff],
	),
	// Old, scoped to a graph, and that graph is finished or no longer indexed. The
	// graph is the one `memoryGraphId` names: `graph_id`, or the tail of a `graph:`
	// scope when the write gave none — the same identity the reads judge by.
	ttlClass(
		"entries-ttl-graph",
		"graphsDays",
		"memory_entries e where ttl = 'graph' and superseded_by is null and created < $1::timestamptz " +
			"and not exists (select 1 from graph_index g where g.graph_id = coalesce(e.graph_id, " +
			"case when left(e.scope, 6) = 'graph:' then substr(e.scope, 7) end) " +
			`and (g.status is null or not (g.status = any(${TERMINAL_SET}))))`,
		(cutoff) => [cutoff, TERMINAL],
	),
];

// ── planning and execution ──────────────────────────────────────────────────

interface SweepStep {
	cls: SweepClass;
	/** ISO instant: rows older than this are candidates. */
	cutoff: string;
	days: number;
}

/**
 * The cutoff per class for one `now`. Pure, and what the report echoes. With
 * `expiry: "enforce"` the `ttl` classes take their `underEnforce` shape — the
 * only way a step ever carries their delete. The default is `report`, which
 * is what every caller before N4 got.
 */
export function planSweep(policy: SweepPolicy, now: number, options: { expiry?: MemoryExpiryMode } = {}): SweepStep[] {
	return SWEEP_CLASSES.map((cls) => {
		const days = typeof cls.days === "number" ? cls.days : policy[cls.days];
		const effective = options.expiry === "enforce" && cls.underEnforce ? { ...cls, ...cls.underEnforce } : cls;
		return { cls: effective, days, cutoff: new Date(now - days * DAY_MS).toISOString() };
	});
}

interface SweepClassReport {
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
	/** What the `ttl` classes were planned under: `enforce` is the only way they delete. */
	expiry: MemoryExpiryMode;
	classes: SweepClassReport[];
}

/** Runs one statement and returns its rows. `IndexStore` binds this to `sql.unsafe`, tests to a fake. */
type SweepRunner = (statement: SweepStatement) => Promise<Array<Record<string, unknown>>>;

function int(value: unknown): number {
	const n = Number(value ?? 0);
	return Number.isFinite(n) ? n : 0;
}

/**
 * One round of a class's delete: run `pick`; with `decide`, run `lock` on what it
 * picked (when the class has one), feed the picked and locked rows to the
 * follow-up statements and merge their one-row results. Returns how many rows
 * the round *picked* (what bounds the loop) and the merged columns.
 */
async function runBatch(run: SweepRunner, batch: SweepBatch): Promise<{ picked: number; row: Record<string, unknown> }> {
	const picked = await run(batch.pick);
	if (!batch.decide) return { picked: int(picked[0]?.deleted), row: picked[0] ?? {} };
	if (picked.length === 0) return { picked: 0, row: {} };
	const locked = batch.lock ? await run(batch.lock(picked)) : [];
	const row: Record<string, unknown> = {};
	for (const statement of batch.decide(picked, locked)) Object.assign(row, (await run(statement))[0] ?? {});
	if (batch.skippedAs) row[batch.skippedAs] = picked.length - int(row.deleted);
	return { picked: picked.length, row };
}

/**
 * Count every class, then — only when `apply` — delete the deletable ones in
 * batches until a batch comes back short. Counts are taken first for every class
 * so a report-only class is judged before a delete changes what it would see
 * (`entries-ttl-graph` looks at `graph_index`, which `graphs-terminal` empties).
 *
 * The batch loop is bounded by the count it just took: a class that keeps
 * finding rows past that (a writer racing the sweep) stops rather than chasing it.
 * A two-phase class whose pick came back full but whose delete fell short (a
 * graph claimed between the pick and the node lock) stops too: something is
 * moving under the sweep, and the next tick will judge it fresh.
 */
export async function executeSweep(
	run: SweepRunner,
	steps: readonly SweepStep[],
	options: { apply: boolean; batch: number; now: number; expiry?: MemoryExpiryMode },
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
			const report = classes[i];
			const build = step.cls.deleteBatch;
			if (!report || !build || report.candidates === 0) continue;
			const maxRounds = Math.ceil(report.candidates / options.batch) + 1;
			for (let round = 0; round < maxRounds; round++) {
				const { picked, row } = await runBatch(run, build(step.cutoff, options.batch));
				const deleted = int(row.deleted);
				report.deleted += deleted;
				for (const [key, value] of Object.entries(row)) {
					if (key === "deleted") continue;
					report.children = { ...report.children, [key]: (report.children?.[key] ?? 0) + int(value) };
				}
				if (picked < options.batch || deleted < picked) break;
			}
		}
	}
	return {
		apply: options.apply,
		at: new Date(options.now).toISOString(),
		batch: options.batch,
		expiry: options.expiry ?? "report",
		classes,
	};
}

/** The report as an operator reads it on a terminal; `--json` prints the object instead. */
export function formatSweepReport(report: SweepReport): string {
	const lines = [`index sweep ${report.apply ? "APPLY" : "dry-run"} at ${report.at} (batch ${report.batch}) ttl classes: ${report.expiry}`];
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

const TTL_30_DAYS = 30;

/**
 * The graph half of `entries-ttl-graph`: the graph row is missing, or its
 * status is in `TERMINAL_GRAPH_STATUSES`. `$3` is that set, `|`-joined.
 * `g.status is null` stays inside the `not exists`, same as the sweep class.
 */
const LIFECYCLE_GRAPH_PREDICATE =
	"not exists (select 1 from graph_index g where g.graph_id = coalesce(e.graph_id, " +
	"case when left(e.scope, 6) = 'graph:' then substr(e.scope, 7) end) " +
	"and (g.status is null or not (g.status = any(string_to_array($3::text, '|')))))";

/**
 * One read of the two ttl classes the sweep already counts (`entries-ttl-30d`,
 * `entries-ttl-graph`). Not `entries-superseded`. Lists at most `policy.batch`
 * ids per class and still returns each class's full count. No delete.
 */
export function memoryLifecycleQuery(policy: SweepPolicy, now: number): SweepStatement {
	const cutoff30 = new Date(now - TTL_30_DAYS * DAY_MS).toISOString();
	const cutoffGraph = new Date(now - policy.graphsDays * DAY_MS).toISOString();
	const text =
		"select id, scope, kind, subject, writer, ttl, graph_id, idempotency_key, created, class_count from (" +
		"select e.id, e.scope, e.kind, e.subject, e.writer, e.ttl, e.graph_id, e.idempotency_key, e.created, " +
		"count(*) over (partition by e.ttl)::int as class_count, " +
		"row_number() over (partition by e.ttl order by e.created, e.id) as rn " +
		"from memory_entries e where e.superseded_by is null and (" +
		"(e.ttl = '30d' and e.created < $1::timestamptz) or " +
		"(e.ttl = 'graph' and e.created < $2::timestamptz and " +
		LIFECYCLE_GRAPH_PREDICATE +
		"))" +
		") ranked where rn <= $4::int";
	return { text, params: [cutoff30, cutoffGraph, TERMINAL, policy.batch] };
}

interface MemoryLifecyclePrintedRow {
	id: string;
	ttl: string;
	writer: string;
	bank: string | null;
	document_id: string;
}

interface MemoryLifecycleReport {
	memoryLifecycle: "report";
	batch: number;
	counts: { "30d": number; graph: number };
	truncated: { "30d": boolean; graph: boolean };
	rows: MemoryLifecyclePrintedRow[];
}

const LIFECYCLE_TTLS = ["30d", "graph"] as const;

function lifecycleCount(group: readonly Record<string, unknown>[]): number {
	if (group.length === 0) return 0;
	let full = group.length;
	for (const row of group) {
		if (row.class_count === undefined || row.class_count === null) continue;
		const n = Number(row.class_count);
		if (Number.isFinite(n) && n > full) full = n;
	}
	return full;
}

/** Drop subject after the document id is computed. Bank is null without Hindsight config. */
export function memoryLifecycleReport(
	raw: readonly Record<string, unknown>[],
	options: { batch: number; hindsight: HindsightConfig | null },
): MemoryLifecycleReport {
	const counts = { "30d": 0, graph: 0 };
	const truncated = { "30d": false, graph: false };
	const rows: MemoryLifecyclePrintedRow[] = [];
	for (const ttl of LIFECYCLE_TTLS) {
		const group = raw.filter((row) => String(row.ttl) === ttl);
		const full = lifecycleCount(group);
		const listed = group.slice(0, options.batch);
		counts[ttl] = full;
		truncated[ttl] = full > listed.length;
		for (const row of listed) {
			const subject = typeof row.subject === "string" && row.subject.length > 0 ? row.subject : undefined;
			const writer = String(row.writer ?? "");
			rows.push({
				id: String(row.id ?? ""),
				ttl,
				writer,
				bank: options.hindsight === null ? null : bankForSurface(options.hindsight, writer),
				document_id: retainDocumentId({ scope: String(row.scope ?? ""), kind: row.kind, subject }, String(row.idempotency_key ?? "")),
			});
		}
	}
	return { memoryLifecycle: "report", batch: options.batch, counts, truncated, rows };
}

/** Second sweep section. Subject is not printed. */
export function formatMemoryLifecycleReport(
	raw: readonly Record<string, unknown>[],
	options: { batch: number; hindsight: HindsightConfig | null },
): string {
	const report = memoryLifecycleReport(raw, options);
	const lines = [`memory lifecycle report batch ${report.batch}`];
	for (const ttl of LIFECYCLE_TTLS) {
		const listed = report.rows.filter((row) => row.ttl === ttl).length;
		lines.push(
			`  ${ttl.padEnd(5)} candidates ${String(report.counts[ttl]).padStart(6)}  listed ${String(listed).padStart(6)}  truncated ${report.truncated[ttl]}`,
		);
	}
	for (const row of report.rows) {
		lines.push(`  ${row.id} ${row.ttl} ${row.writer} ${row.bank ?? "-"} ${row.document_id}`);
	}
	return `${lines.join("\n")}\n`;
}
