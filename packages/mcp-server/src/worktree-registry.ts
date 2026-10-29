/**
 * The worktree registry (phase 68, FLEET-02): which git worktrees exist on which host, whose they are and what state
 * they are in. The server never touches a worktree (ADR 0005, ADR 0007, D68-5): the CLI and the collectors inspect the
 * checkouts and POST what they found, and this module validates that report, keeps the latest one per host and path,
 * and lists it back.
 *
 * Three jobs, kept apart so the decisions test without a database:
 *
 * - {@link validateWorktreeReport} and {@link parseWorktreeListQuery} narrow untrusted input into the typed shapes. Every
 *   field is checked and every collection is bounded; nothing the caller sent is stored unchecked.
 * - {@link WorktreeRegistryStore} is the port. `worktree-registry-fake.ts` is the in-memory adapter and
 *   {@link PgWorktreeRegistry} the Postgres one; `worktree-registry.testkit.ts` runs one set of cases against both.
 * - {@link PgWorktreeRegistry} writes a report in one transaction: it upserts the rows the report lists, then deletes the
 *   reporting host's rows nobody has refreshed within the retention window. A report does not claim to be complete, so
 *   a row the report leaves out is kept until its own `last_seen_at` ages out.
 *
 * The retention is a time-to-live on `last_seen_at`, judged at report time by the server's clock. A host that stops
 * reporting keeps its rows (their `last_seen_at` says how old they are) until it reports again.
 */
import type { SQL } from "bun";

/** The report's `protocol` member. A different value is refused, so a changed shape never half-parses. */
export const WORKTREE_REPORT_PROTOCOL = 1;
/** Most worktrees one report may carry. */
export const WORKTREE_REPORT_MAX_ITEMS = 500;
/** The request body cap for `POST /worktrees/report`, in bytes. The route reads under it and the CLI's report splitter packs under it (less a margin). */
export const WORKTREE_REPORT_MAX_BYTES = 1_000_000;
/** Longest path accepted, in characters. */
export const WORKTREE_PATH_MAX_CHARS = 1024;
/** Longest branch name, base ref, or session and graph identifier accepted, in characters. */
export const WORKTREE_TEXT_MAX_CHARS = 255;
/** Retention window when `SUBSTRATE_WORKTREE_REGISTRY_TTL_S` is unset: fourteen days. */
export const DEFAULT_WORKTREE_REGISTRY_TTL_S = 1_209_600;
/** Idle window that makes a worktree `stale` in a listing when `SUBSTRATE_WORKTREE_IDLE_DAYS` is unset. */
export const DEFAULT_WORKTREE_IDLE_DAYS = 14;
/** Page size when a listing names no `limit`. */
export const WORKTREE_LIST_DEFAULT_LIMIT = 100;
/** Largest page a listing may ask for. */
export const WORKTREE_LIST_MAX_LIMIT = 500;
/** The ceiling a `ahead` or `behind` count must stay under: the column is a 32-bit integer. */
const MAX_COUNT = 2_147_483_647;

export const WORKTREE_REGISTRY_MODES = ["off", "on"] as const;
export type WorktreeRegistryMode = (typeof WORKTREE_REGISTRY_MODES)[number];

export const WORKTREE_PR_STATES = ["open", "merged", "closed", "none", "unknown"] as const;
export type WorktreePrState = (typeof WORKTREE_PR_STATES)[number];

export const WORKTREE_LIST_STATES = ["all", "dirty", "stale"] as const;
export type WorktreeListState = (typeof WORKTREE_LIST_STATES)[number];

/** One worktree as a reporter describes it. `session_id` and `graph_id` are present only when the reporter could attribute the worktree. */
export interface WorktreeRecord {
	path: string;
	repo: string;
	branch: string | null;
	head: string;
	base: string | null;
	dirty: boolean;
	ahead: number | null;
	behind: number | null;
	last_commit_at: string | null;
	size_bytes: number | null;
	locked: boolean;
	primary: boolean;
	pr_state: WorktreePrState;
	session_id?: string;
	graph_id?: string;
}

/** A validated report. `reported_at` is the reporter's own clock, normalised to ISO; the server stamps `last_seen_at` itself. */
export interface WorktreeReport {
	protocol: typeof WORKTREE_REPORT_PROTOCOL;
	host: string;
	reported_at: string;
	worktrees: WorktreeRecord[];
}

/** A registry row as a listing returns it. */
export interface StoredWorktree extends WorktreeRecord {
	host: string;
	first_seen_at: string;
	last_seen_at: string;
}

/** A validated listing request. `limit` is within `1..WORKTREE_LIST_MAX_LIMIT`. */
export interface WorktreeListQuery {
	repo: string | null;
	host: string | null;
	state: WorktreeListState;
	limit: number;
}

/** What the store needs to write one report. `seenAt` is the server's clock; the retention cutoff is `seenAt` minus `ttlS`. */
export interface WorktreeStoreReport {
	host: string;
	reportedAt: Date;
	seenAt: Date;
	ttlS: number;
	worktrees: readonly WorktreeRecord[];
}

/** What the store needs to read: `staleBefore` is the instant a commit must predate for the worktree to count as stale. */
export interface WorktreeStoreFilter {
	repo: string | null;
	host: string | null;
	state: WorktreeListState;
	limit: number;
	staleBefore: Date;
}

export interface WorktreeRegistryStore {
	/** Upserts every worktree of the report, then deletes the host's rows last seen before the cutoff, in one transaction. `stored` is the count upserted. */
	report(input: WorktreeStoreReport): Promise<{ stored: number; removed: number }>;
	/** At most `filter.limit` rows, newest `last_seen_at` first, ties by host then path. */
	list(filter: WorktreeStoreFilter): Promise<StoredWorktree[]>;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string };

const fail = (problem: string): { ok: false; problem: string } => ({ ok: false, problem });

const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** The repository label a report row may carry: `owner/name`. The fleet package builds its `local/<name>` labels against it. */
export const WORKTREE_REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}$/;
const HEAD_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A control character (including NUL and newline) would break a log line or a path shown to a human. */
function hasControlCharacter(text: string): boolean {
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

/** A non-empty single-line string within `WORKTREE_TEXT_MAX_CHARS`. */
function isLabel(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= WORKTREE_TEXT_MAX_CHARS && !hasControlCharacter(value);
}

/** The ISO form of `value`, or null when it is not an ISO 8601 timestamp with an offset. */
function isoOf(value: unknown): string | null {
	if (typeof value !== "string" || !ISO_PATTERN.test(value)) return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function isCount(value: unknown, max: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function isPrState(value: unknown): value is WorktreePrState {
	return typeof value === "string" && (WORKTREE_PR_STATES as readonly string[]).includes(value);
}

function isListState(value: unknown): value is WorktreeListState {
	return typeof value === "string" && (WORKTREE_LIST_STATES as readonly string[]).includes(value);
}

function validateWorktree(raw: unknown, index: number): Parsed<WorktreeRecord> {
	const at = `worktrees[${index}]`;
	if (!isRecord(raw)) return fail(`${at} must be an object`);
	const { path, repo, branch, head, base, dirty, ahead, behind, last_commit_at, size_bytes, locked, primary, pr_state, session_id, graph_id } = raw;
	if (typeof path !== "string" || !path.startsWith("/") || path.length > WORKTREE_PATH_MAX_CHARS || path.includes("\u0000")) {
		return fail(`${at}.path must be an absolute path of at most ${WORKTREE_PATH_MAX_CHARS} characters with no NUL`);
	}
	if (typeof repo !== "string" || !WORKTREE_REPO_PATTERN.test(repo)) return fail(`${at}.repo must be owner/name`);
	if (branch !== null && !isLabel(branch)) return fail(`${at}.branch must be a string of at most ${WORKTREE_TEXT_MAX_CHARS} characters, or null`);
	if (typeof head !== "string" || !HEAD_PATTERN.test(head)) return fail(`${at}.head must be 40 or 64 hex characters`);
	if (base !== null && !isLabel(base)) return fail(`${at}.base must be a string of at most ${WORKTREE_TEXT_MAX_CHARS} characters, or null`);
	if (typeof dirty !== "boolean") return fail(`${at}.dirty must be a boolean`);
	if (ahead !== null && !isCount(ahead, MAX_COUNT)) return fail(`${at}.ahead must be a non-negative integer, or null`);
	if (behind !== null && !isCount(behind, MAX_COUNT)) return fail(`${at}.behind must be a non-negative integer, or null`);
	const lastCommit = last_commit_at === null ? null : isoOf(last_commit_at);
	if (last_commit_at !== null && lastCommit === null) return fail(`${at}.last_commit_at must be an ISO 8601 timestamp, or null`);
	if (size_bytes !== null && !isCount(size_bytes, Number.MAX_SAFE_INTEGER)) return fail(`${at}.size_bytes must be a non-negative integer, or null`);
	if (typeof locked !== "boolean") return fail(`${at}.locked must be a boolean`);
	if (typeof primary !== "boolean") return fail(`${at}.primary must be a boolean`);
	if (!isPrState(pr_state)) return fail(`${at}.pr_state must be one of ${WORKTREE_PR_STATES.join(", ")}`);
	if (session_id !== undefined && !isLabel(session_id)) return fail(`${at}.session_id must be a string of at most ${WORKTREE_TEXT_MAX_CHARS} characters when present`);
	if (graph_id !== undefined && !isLabel(graph_id)) return fail(`${at}.graph_id must be a string of at most ${WORKTREE_TEXT_MAX_CHARS} characters when present`);
	return {
		ok: true,
		value: {
			path,
			repo,
			branch,
			head: head.toLowerCase(),
			base,
			dirty,
			ahead,
			behind,
			last_commit_at: lastCommit,
			size_bytes,
			locked,
			primary,
			pr_state,
			...(session_id === undefined ? {} : { session_id }),
			...(graph_id === undefined ? {} : { graph_id }),
		},
	};
}

/**
 * Narrows a parsed JSON body into a {@link WorktreeReport}, or names the first problem. The body-size cap is the
 * transport's; this checks the shape, every field, the item cap and that no path repeats (one row per host and path).
 */
export function validateWorktreeReport(body: unknown): Parsed<WorktreeReport> {
	if (!isRecord(body)) return fail("request body must be a JSON object");
	if (body.protocol !== WORKTREE_REPORT_PROTOCOL) return fail(`protocol must be ${WORKTREE_REPORT_PROTOCOL}`);
	if (typeof body.host !== "string" || !HOST_PATTERN.test(body.host)) return fail("host must be 1 to 128 characters of letters, digits, dot, underscore or hyphen");
	const reportedAt = isoOf(body.reported_at);
	if (reportedAt === null) return fail("reported_at must be an ISO 8601 timestamp");
	const items = body.worktrees;
	if (!Array.isArray(items)) return fail("worktrees must be an array");
	if (items.length > WORKTREE_REPORT_MAX_ITEMS) return fail(`worktrees must hold at most ${WORKTREE_REPORT_MAX_ITEMS} entries`);
	const worktrees: WorktreeRecord[] = [];
	const seen = new Set<string>();
	for (const [index, item] of items.entries()) {
		const parsed = validateWorktree(item, index);
		if (!parsed.ok) return parsed;
		if (seen.has(parsed.value.path)) return fail(`worktrees[${index}].path repeats an earlier entry`);
		seen.add(parsed.value.path);
		worktrees.push(parsed.value);
	}
	return { ok: true, value: { protocol: WORKTREE_REPORT_PROTOCOL, host: body.host, reported_at: reportedAt, worktrees } };
}

/** The arguments a listing accepts, as the two doors hand them over: strings from a URL, typed values from a tool call. */
export interface RawWorktreeListQuery {
	repo?: unknown;
	host?: unknown;
	state?: unknown;
	limit?: unknown;
}

/** Narrows the filters of a listing. An absent member takes its default; a present one that is not valid is refused, never ignored. */
export function parseWorktreeListQuery(raw: RawWorktreeListQuery): Parsed<WorktreeListQuery> {
	const { repo, host, state, limit } = raw;
	if (repo !== undefined && (typeof repo !== "string" || !WORKTREE_REPO_PATTERN.test(repo))) return fail("repo must be owner/name");
	if (host !== undefined && (typeof host !== "string" || !HOST_PATTERN.test(host))) return fail("host must be 1 to 128 characters of letters, digits, dot, underscore or hyphen");
	if (state !== undefined && !isListState(state)) return fail(`state must be one of ${WORKTREE_LIST_STATES.join(", ")}`);
	let pageSize = WORKTREE_LIST_DEFAULT_LIMIT;
	if (limit !== undefined) {
		const asNumber = typeof limit === "string" && /^\d{1,6}$/.test(limit) ? Number(limit) : limit;
		if (!isCount(asNumber, WORKTREE_LIST_MAX_LIMIT) || asNumber < 1) return fail(`limit must be an integer from 1 to ${WORKTREE_LIST_MAX_LIMIT}`);
		pageSize = asNumber;
	}
	return {
		ok: true,
		value: {
			repo: repo ?? null,
			host: host ?? null,
			state: state ?? "all",
			limit: pageSize,
		},
	};
}

/** The instant before which a worktree's last commit makes it `stale`, `idleDays` before `now`. */
export function staleCutoff(now: number, idleDays: number): Date {
	return new Date(now - idleDays * 86_400_000);
}

/** Postgres adapter's way to run a call under the index plane's gate; `IndexStore` passes its own. */
export type RunUnderGate = <T>(op: string, fn: () => Promise<T>) => Promise<T>;

/** The Postgres adapter. Constructed by `IndexStore.worktreeRegistry()`, over the index's own pool. */
export class PgWorktreeRegistry implements WorktreeRegistryStore {
	constructor(
		private readonly sql: SQL,
		private readonly run: RunUnderGate,
	) {}

	async report(input: WorktreeStoreReport): Promise<{ stored: number; removed: number }> {
		const seenAt = input.seenAt.toISOString();
		const reportedAt = input.reportedAt.toISOString();
		const cutoff = new Date(input.seenAt.getTime() - input.ttlS * 1000).toISOString();
		return this.run("worktrees.report", async () => {
			let removed = 0;
			// One transaction: a reader sees the registry before the report or after it, never the upserts without the sweep.
			await this.sql.begin(async (tx: SQL) => {
				for (const worktree of input.worktrees) {
					await tx`
						insert into worktrees (
							host, path, repo, branch, head, base, dirty, ahead, behind, last_commit_at, size_bytes,
							locked, is_primary, pr_state, session_id, graph_id, first_seen_at, last_seen_at, reported_at)
						values (
							${input.host}, ${worktree.path}, ${worktree.repo}, ${worktree.branch}, ${worktree.head}, ${worktree.base},
							${worktree.dirty}, ${worktree.ahead}, ${worktree.behind}, ${worktree.last_commit_at}::timestamptz, ${worktree.size_bytes},
							${worktree.locked}, ${worktree.primary}, ${worktree.pr_state}, ${worktree.session_id ?? null}, ${worktree.graph_id ?? null},
							${seenAt}::timestamptz, ${seenAt}::timestamptz, ${reportedAt}::timestamptz)
						on conflict (host, path) do update
						set repo = excluded.repo, branch = excluded.branch, head = excluded.head, base = excluded.base,
						    dirty = excluded.dirty, ahead = excluded.ahead, behind = excluded.behind,
						    last_commit_at = excluded.last_commit_at, size_bytes = excluded.size_bytes,
						    locked = excluded.locked, is_primary = excluded.is_primary, pr_state = excluded.pr_state,
						    session_id = excluded.session_id, graph_id = excluded.graph_id,
						    last_seen_at = excluded.last_seen_at, reported_at = excluded.reported_at`;
				}
				const swept = (await tx`delete from worktrees where host = ${input.host} and last_seen_at < ${cutoff}::timestamptz returning path`) as unknown[];
				removed = swept.length;
			});
			return { stored: input.worktrees.length, removed };
		});
	}

	async list(filter: WorktreeStoreFilter): Promise<StoredWorktree[]> {
		const staleBefore = filter.staleBefore.toISOString();
		return this.run("worktrees.list", async () => {
			const rows = (await this.sql`
				select * from worktrees
				where (${filter.repo}::text is null or repo = ${filter.repo})
				  and (${filter.host}::text is null or host = ${filter.host})
				  and (${filter.state}::text = 'all'
				       or (${filter.state}::text = 'dirty' and dirty)
				       or (${filter.state}::text = 'stale' and last_commit_at is not null and last_commit_at < ${staleBefore}::timestamptz))
				order by last_seen_at desc, host collate "C" asc, path collate "C" asc
				limit ${filter.limit}`) as Array<Record<string, unknown>>;
			return rows.map(toStoredWorktree);
		});
	}
}

function iso(value: unknown): string {
	return value instanceof Date ? value.toISOString() : String(value);
}

function isoOrNull(value: unknown): string | null {
	return value === null || value === undefined ? null : iso(value);
}

function numberOrNull(value: unknown): number | null {
	return value === null || value === undefined ? null : Number(value);
}

function textOrNull(value: unknown): string | null {
	return value === null || value === undefined ? null : String(value);
}

function toStoredWorktree(row: Record<string, unknown>): StoredWorktree {
	const sessionId = textOrNull(row.session_id);
	const graphId = textOrNull(row.graph_id);
	return {
		host: String(row.host),
		path: String(row.path),
		repo: String(row.repo),
		branch: textOrNull(row.branch),
		head: String(row.head),
		base: textOrNull(row.base),
		dirty: row.dirty === true,
		ahead: numberOrNull(row.ahead),
		behind: numberOrNull(row.behind),
		last_commit_at: isoOrNull(row.last_commit_at),
		size_bytes: numberOrNull(row.size_bytes),
		locked: row.locked === true,
		primary: row.is_primary === true,
		pr_state: String(row.pr_state) as WorktreePrState,
		...(sessionId === null ? {} : { session_id: sessionId }),
		...(graphId === null ? {} : { graph_id: graphId }),
		first_seen_at: iso(row.first_seen_at),
		last_seen_at: iso(row.last_seen_at),
	};
}

/** A request the registry refuses before or instead of touching the store: the HTTP status it maps to and the body to send. */
export interface WorktreeRefusal {
	ok: false;
	status: 400 | 401 | 403 | 503;
	body: { error: string; problem?: string };
}

export type WorktreeReportOutcome = { ok: true; stored: number; removed: number } | WorktreeRefusal;
export type WorktreeListOutcome = { ok: true; worktrees: StoredWorktree[]; truncated: boolean } | WorktreeRefusal;
