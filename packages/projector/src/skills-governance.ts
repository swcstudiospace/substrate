/**
 * Approval-gated skills projection (uplift-5 S5b, projector half).
 *
 * Until this module, "approved" meant "merged to agent-skills main": every skill that landed there
 * was linked into six agent roots within five minutes and nothing recorded who or which sha.
 * The substrate now keeps an approval registry (`GET /skills?state=approved`); this module lets the
 * projector consult it, in three modes read from `SUBSTRATE_SKILLS_GOVERNANCE`:
 *
 *   off      (default) — nothing here runs: no network call, no file read or write, no warning. The
 *            projector is byte-identical to the build before this module existed.
 *   report   — fetch the approved list, project EVERYTHING exactly as `off` does, and emit at most
 *            one deduped `warning` naming the library skills that are not approved. Fail-open: an
 *            unreachable or malformed answer is one stdout line and the run carries on.
 *   enforce  — the same list gates NEW links only: a `link-new` or `backup-then-link` action for a
 *            skill that is not approved is held back. Nothing is ever unlinked or deleted by this
 *            module — a skill that is already linked and later becomes unapproved or retired keeps
 *            its link and is only reported; cleanup stays an operator step.
 *
 * Why each refusal is what it is:
 *   - Gating filters the planner's ACTIONS, not its name list. `plan()` also uses the library name
 *     set to recognise stray real directories in the Grok root and to repoint exports links; a
 *     smaller name list would raise spurious `stray-real-dir` warnings for skills that are merely
 *     awaiting approval. Only the two actions that create a library link where none existed are held.
 *   - The fetch deadline sits INSIDE the call (an `AbortSignal` passed to `fetch` also aborts the
 *     body read) and the body is size-capped while it is read, so a slow or endless answer can
 *     neither stall the tick nor grow memory.
 *   - Every name the server returns is checked against the library scan's `SKILL_NAME_RE` before
 *     it is used; a path-like or oversized name is dropped, never joined into a path. Membership is
 *     a `Set`, never `in`.
 *   - A fetch that fails in `enforce` falls back to the last approved set cached in `approved.json`
 *     (atomic tmp + rename, mode 0600, size-bounded, schema-validated on read; any doubt makes the
 *     cache unusable rather than partially trusted). With no usable cache nothing is approved, so
 *     no NEW link is made and one warning says why; existing links are untouched.
 *   - Reporting is secondary: a warning or state file that cannot be written never fails the run.
 *   - The cache is also written in `report`, so the first `enforce` after a soak does not fail
 *     closed on a substrate hiccup. `--check` writes nothing (the caller passes `persist: false`).
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SKILL_NAME_RE } from "../../mcp-server/src/skills/propose.ts";
import type { Action, WarningEvent } from "./skills.ts";

export const GOVERNANCE_ENV = "SUBSTRATE_SKILLS_GOVERNANCE";
export type GovernanceMode = "off" | "report" | "enforce";

/** Names the server may send: its own cap is 500 (`truncated` flags the rest). */
export const MAX_APPROVED = 500;
/** Longest answer body read: 500 entries of the documented shape are far below this. */
export const MAX_BODY_BYTES = 512 * 1024;
/** Largest `approved.json` read back: 500 names plus framing. */
export const MAX_CACHE_BYTES = 64 * 1024;
/** Names carried in one warning; the count carries the rest. */
export const MAX_WARNED_NAMES = 20;
/** Fail-open fetch budget, the same family as the projector's POST /events. */
export const FETCH_TIMEOUT_MS = 3_000;
/** The same warning is re-sent after this long even when nothing changed, so a standing gap stays visible. */
export const RENOTIFY_MS = 24 * 60 * 60 * 1000;
const TMP_SUFFIX = ".substrate-tmp";
/** Version 2 adds `source`; a version-1 file carries no identity and is rejected on read. */
const CACHE_VERSION = 2;
/** Longest origin or library string a cache may carry. */
const MAX_SOURCE_CHARS = 200;

export const APPROVED_CACHE_NAME = "approved.json";
export const GOVERNANCE_WARNED_NAME = "governance-warned.json";

/** The substrate's `/skills` door, with the projector's own surface token. */
export interface GovernanceTarget {
	url: string;
	token: string;
}

export interface GovernanceOptions {
	mode: GovernanceMode;
	/** Null when the projector holds no surface token: the fetch cannot be authorised, so it is not attempted. */
	target: GovernanceTarget | null;
	/** The substrate URL when `target` is null (no token): the cache is still bound to its origin. */
	url?: string;
	/** The unrecognised flag value, for the boot-style warning; null when parsed or unset. */
	rejected?: string | null;
	fetchImpl?: typeof fetch;
	now?: () => number;
	timeoutMs?: number;
	renotifyMs?: number;
}

export function parseGovernanceMode(raw: string | undefined): { mode: GovernanceMode; rejected: string | null } {
	const value = (raw ?? "").trim().toLowerCase();
	if (value === "") return { mode: "off", rejected: null };
	if (value === "off" || value === "report" || value === "enforce") return { mode: value, rejected: null };
	return { mode: "off", rejected: (raw ?? "").trim().slice(0, 40) };
}

/** First non-empty entry of a possibly comma-separated token variable; never the whole list. */
function firstToken(raw: string | undefined): string {
	for (const part of (raw ?? "").split(",")) {
		const token = part.trim();
		if (token !== "") return token;
	}
	return "";
}

/**
 * The bearer for the substrate's loopback doors, shared by the approved-list fetch and every event
 * the projector posts, so a governance warning is never sent with a different identity than the
 * fetch that produced it. Same precedence as `refreshTarget` in skills-sync.ts (the unit's own
 * `SUBSTRATE_TOKEN_SUBSTRATE`, then the generic `SUBSTRATE_TOKEN`) with a list-valued variable
 * reduced to its first entry — a comma list is never sent as one token. "" when neither is set.
 */
export function resolveSurfaceToken(env: NodeJS.ProcessEnv = process.env): string {
	return firstToken(env.SUBSTRATE_TOKEN_SUBSTRATE) || firstToken(env.SUBSTRATE_TOKEN);
}

/**
 * Whether `resolveSurfaceToken` yields the unit's own token, i.e. the `substrate` host-job surface
 * token. The server binds such a bearer to its own surface (`attributedSurface` refuses an event
 * that names another one with 403), so an event posted with it must be posted as `substrate`.
 */
export function usesHostJobToken(env: NodeJS.ProcessEnv = process.env): boolean {
	return firstToken(env.SUBSTRATE_TOKEN_SUBSTRATE) !== "";
}

/** The governance options for this process (flag, bearer and substrate URL from `env`). */
export function governanceFromEnv(env: NodeJS.ProcessEnv = process.env): GovernanceOptions {
	const { mode, rejected } = parseGovernanceMode(env[GOVERNANCE_ENV]);
	const token = resolveSurfaceToken(env);
	const url = (env.SUBSTRATE_URL ?? "http://127.0.0.1:7410").replace(/\/+$/, "");
	return { mode, rejected, url, target: token === "" ? null : { url, token } };
}

/** The flag value the projector fell back from, in the shape the repo prints misconfigurations. */
export function skillsGovernanceConfigWarnings(options: Pick<GovernanceOptions, "rejected">): string[] {
	if (options.rejected === undefined || options.rejected === null) return [];
	return [`${GOVERNANCE_ENV}=${JSON.stringify(options.rejected)} is not off, report or enforce; using off (no governance)`];
}

export interface ApprovedList {
	names: Set<string>;
	truncated: boolean;
	/** Entries dropped for a missing or invalid name. */
	dropped: number;
	/** The `<owner/repo>` the server says the list belongs to; null from an old server or an odd value. */
	library: string | null;
}

/** `scheme://host[:port]` of a URL, without credentials, path or query; null when it is not an http(s) URL. */
export function originOf(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
		return parsed.origin.length <= MAX_SOURCE_CHARS ? parsed.origin : null;
	} catch {
		return null;
	}
}

/**
 * Validate a `/skills` answer: an object with a `skills` array whose entries carry a `name` matching
 * the library scan's rule. A missing `skills` array is a malformed answer (null), never "nothing is
 * approved". Entries beyond MAX_APPROVED are ignored and flagged truncated.
 */
export function parseApproved(body: unknown): ApprovedList | null {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
	const record = body as Record<string, unknown>;
	if (!Array.isArray(record.skills)) return null;
	const names = new Set<string>();
	let dropped = 0;
	let truncated = record.truncated === true;
	for (const entry of record.skills) {
		const name = entry !== null && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>).name : undefined;
		if (typeof name !== "string" || !SKILL_NAME_RE.test(name)) {
			dropped++;
			continue;
		}
		if (names.size >= MAX_APPROVED && !names.has(name)) {
			truncated = true;
			continue;
		}
		names.add(name);
	}
	const library = typeof record.library === "string" && record.library.length > 0 && record.library.length <= MAX_SOURCE_CHARS ? record.library : null;
	return { names, truncated, dropped, library };
}

/** Read the body in chunks and stop at the cap: the limit is enforced while reading, not after. */
async function readCapped(response: Response, max: number): Promise<string | null> {
	if (response.body === null) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > max) {
			await reader.cancel().catch(() => undefined);
			return null;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

export type FetchOutcome = { ok: true; list: ApprovedList } | { ok: false; reason: string };

/** `GET /skills?state=approved`; every failure is a reason (never a throw, never the token). */
export async function fetchApproved(target: GovernanceTarget, fetchImpl: typeof fetch = fetch, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<FetchOutcome> {
	try {
		const response = await fetchImpl(`${target.url}/skills?state=approved`, {
			method: "GET",
			headers: { authorization: `Bearer ${target.token}` },
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) return { ok: false, reason: `skills ${response.status}` };
		const text = await readCapped(response, MAX_BODY_BYTES);
		if (text === null) return { ok: false, reason: "skills answer too large" };
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			return { ok: false, reason: "skills answer malformed" };
		}
		const list = parseApproved(body);
		return list === null ? { ok: false, reason: "skills answer malformed" } : { ok: true, list };
	} catch (cause) {
		return { ok: false, reason: `skills unreachable: ${String(cause instanceof Error ? cause.message : cause).slice(0, 120)}` };
	}
}

/**
 * The set (and whether the server cut it) from a schema-valid cache file whose recorded source
 * origin equals `origin`, or null for anything else: missing, oversized, corrupt, wrong shape, an
 * older format without `source`, a malformed `source`, or another origin (approvals fetched from a
 * different server must never gate this one). The library cannot be compared here: after a failed
 * fetch the current library is unknown.
 */
export function readApprovedCache(file: string, origin: string | null): { names: Set<string>; truncated: boolean; library: string | null } | null {
	if (origin === null) return null;
	try {
		const stat = lstatSync(file);
		if (!stat.isFile() || stat.size > MAX_CACHE_BYTES) return null;
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const record = parsed as Record<string, unknown>;
		if (record.version !== CACHE_VERSION || !Array.isArray(record.names) || record.names.length > MAX_APPROVED) return null;
		const source = record.source;
		if (source === null || typeof source !== "object" || Array.isArray(source)) return null;
		const cachedOrigin = (source as Record<string, unknown>).url;
		const library = (source as Record<string, unknown>).library;
		if (typeof cachedOrigin !== "string" || cachedOrigin.length === 0 || cachedOrigin.length > MAX_SOURCE_CHARS) return null;
		if (library !== null && (typeof library !== "string" || library.length === 0 || library.length > MAX_SOURCE_CHARS)) return null;
		if (cachedOrigin !== origin) return null;
		const names = new Set<string>();
		for (const name of record.names) {
			if (typeof name !== "string" || !SKILL_NAME_RE.test(name)) return null;
			names.add(name);
		}
		if (record.truncated !== undefined && typeof record.truncated !== "boolean") return null;
		return { names, truncated: record.truncated === true, library };
	} catch {
		return null;
	}
}

/** Write `value` as JSON through a sibling temp file, mode 0600, then rename over `file`. */
function writeJsonAtomic(file: string, value: unknown): void {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}${TMP_SUFFIX}`;
	try {
		rmSync(tmp, { force: true });
		writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
		renameSync(tmp, file);
	} catch (cause) {
		rmSync(tmp, { force: true });
		throw cause;
	}
}

export function writeApprovedCache(
	file: string,
	names: ReadonlySet<string>,
	now: number,
	truncated: boolean,
	source: { url: string; library: string | null },
): void {
	writeJsonAtomic(file, { version: CACHE_VERSION, fetched_at: new Date(now).toISOString(), source, truncated, names: [...names].sort() });
}

export type ApprovedSource = "live" | "cache" | "none";

export interface GovernanceRun {
	mode: Exclude<GovernanceMode, "off">;
	/** The approved set in force; null when neither the fetch nor the cache produced one. */
	approved: ReadonlySet<string> | null;
	source: ApprovedSource;
	truncated: boolean;
	/** Why the live fetch failed, when it did. */
	fetchError: string | null;
	/** Library skills that are not approved (all of them when `approved` is null). */
	unapproved: string[];
	/** The planner's actions after gating: the input untouched in `report`, minus held new links in `enforce`. */
	actions: Action[];
	/** New links held back (enforce only). */
	held: Action[];
	/** Lines for the run's stdout. */
	notes: string[];
}

/**
 * The actions that put a library link where the root held none, or held an exports link instead:
 * the only ones `enforce` holds for an unapproved name. `repoint` is among them because it swaps a
 * link into the exports dir for a link into the library, which newly exposes the library skill under
 * a name that already exists; held, the existing exports link simply stays where it is.
 */
const NEW_LINK_KINDS: ReadonlySet<Action["kind"]> = new Set(["link-new", "backup-then-link", "repoint"]);

/** Remove the actions in NEW_LINK_KINDS for skills outside `approved`; never adds, reorders or removes anything else. */
export function gateActions(actions: readonly Action[], approved: ReadonlySet<string> | null): { actions: Action[]; held: Action[] } {
	const kept: Action[] = [];
	const held: Action[] = [];
	for (const action of actions) {
		if (NEW_LINK_KINDS.has(action.kind) && !(approved?.has(action.name) ?? false)) held.push(action);
		else kept.push(action);
	}
	return { actions: kept, held };
}

export function governancePaths(stateFile: string): { cache: string; warned: string } {
	const dir = dirname(stateFile);
	return { cache: join(dir, APPROVED_CACHE_NAME), warned: join(dir, GOVERNANCE_WARNED_NAME) };
}

/**
 * Resolve the approved set and gate the plan. `libraryNames` is the full library scan; `actions` the
 * planner's output. Does one fetch (when a token is held), reads the cache only after a failed fetch,
 * and writes the cache only when `persist` is true. Never throws.
 */
export async function evaluateGovernance(
	gov: GovernanceOptions,
	libraryNames: readonly string[],
	actions: readonly Action[],
	files: { cache: string; persist: boolean },
): Promise<GovernanceRun | null> {
	if (gov.mode === "off") return null;
	const now = gov.now ?? Date.now;
	const notes: string[] = [];
	const origin = originOf(gov.target?.url ?? gov.url ?? "");
	let approved: ReadonlySet<string> | null = null;
	let source: ApprovedSource = "none";
	let truncated = false;
	let fetchError: string | null = null;

	if (gov.target === null) {
		fetchError = "no surface token (SUBSTRATE_TOKEN_SUBSTRATE or SUBSTRATE_TOKEN)";
	} else {
		const outcome = await fetchApproved(gov.target, gov.fetchImpl, gov.timeoutMs);
		if (outcome.ok) {
			approved = outcome.list.names;
			source = "live";
			truncated = outcome.list.truncated;
			if (outcome.list.dropped > 0) notes.push(`[projector] governance dropped ${outcome.list.dropped} approved entr${outcome.list.dropped === 1 ? "y" : "ies"} with an invalid name`);
			// A successful answer replaces the cache whatever it held: approvals of another origin or
			// library are never merged in. When the replacement cannot be written the old file is
			// removed, so a stale set from another source cannot outlive this answer.
			if (files.persist && origin !== null) {
				try {
					writeApprovedCache(files.cache, outcome.list.names, now(), outcome.list.truncated, { url: origin, library: outcome.list.library });
				} catch (cause) {
					notes.push(`[projector] governance cache not written: ${String(cause instanceof Error ? cause.message : cause).slice(0, 120)}`);
					try {
						rmSync(files.cache, { force: true });
					} catch {
						// A cache that can neither be replaced nor removed is still origin-checked on read.
					}
				}
			}
		} else {
			fetchError = outcome.reason;
		}
	}
	if (approved === null) {
		const cached = readApprovedCache(files.cache, origin);
		if (cached !== null) {
			approved = cached.names;
			truncated = cached.truncated;
			source = "cache";
		}
	}
	if (fetchError !== null) {
		notes.push(`[projector] governance approved list unavailable (${fetchError}); ${source === "cache" ? "using the cached set" : "no cached set"}`);
	}

	const unapproved = libraryNames.filter((name) => !(approved?.has(name) ?? false));
	if (gov.mode === "report") {
		return { mode: "report", approved, source, truncated, fetchError, unapproved, actions: [...actions], held: [], notes };
	}
	const gated = gateActions(actions, approved);
	for (const action of gated.held) notes.push(`[projector] ${action.root.id} held ${action.kind} ${action.name} (not approved)`);
	return { mode: "enforce", approved, source, truncated, fetchError, unapproved, actions: gated.actions, held: gated.held, notes };
}

interface WarnedEntry {
	digest: string;
	at: number;
}

function readWarned(file: string): Record<string, WarnedEntry> {
	try {
		const stat = lstatSync(file);
		if (!stat.isFile() || stat.size > MAX_CACHE_BYTES) return {};
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const out: Record<string, WarnedEntry> = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (!Object.hasOwn(REASON_SUMMARY, key)) continue;
			if (value === null || typeof value !== "object") continue;
			const { digest, at } = value as Record<string, unknown>;
			if (typeof digest === "string" && typeof at === "number" && Number.isFinite(at)) out[key] = { digest, at };
		}
		return out;
	} catch {
		return {};
	}
}

/** The reasons a governance warning carries (also the keys of the dedupe state), with their summaries. */
const REASON_SUMMARY = {
	unapproved: (mode: string, count: number) => `skills governance (${mode}): ${count} library skill(s) not approved`,
	"approved-list-truncated": (mode: string, count: number) =>
		`skills governance (${mode}): approved list cut at ${MAX_APPROVED} by the server, ${count} library skill(s) counted as not approved`,
	"approved-list-unavailable": (mode: string) => `skills governance (${mode}): approved list unavailable, no new links made`,
} as const;
type GovernanceReason = keyof typeof REASON_SUMMARY;

/**
 * The one warning this run owes, or null. `unapproved` names the library skills that are not approved;
 * `approved-list-truncated` says the server cut its list, so some of those names may be approved but
 * beyond the cut (in `enforce` they stay held back — fail-closed for new links — until the list fits);
 * `approved-list-unavailable` (enforce, nothing fetched and nothing cached) says why no new link was made.
 */
export function governanceWarning(run: GovernanceRun, libraryCount: number): { key: string; digest: string; event: WarningEvent } | null {
	let reason: GovernanceReason;
	let names: string[];
	let count: number;
	if (run.mode === "enforce" && run.approved === null) {
		reason = "approved-list-unavailable";
		names = [];
		count = libraryCount;
	} else if (run.unapproved.length > 0 && run.approved !== null) {
		reason = run.truncated ? "approved-list-truncated" : "unapproved";
		names = run.unapproved.slice(0, MAX_WARNED_NAMES);
		count = run.unapproved.length;
	} else {
		return null;
	}
	const digest = createHash("sha256").update(`${run.mode}\n${reason}\n${run.unapproved.join("\n")}`).digest("hex").slice(0, 16);
	const summary = REASON_SUMMARY[reason](run.mode, count);
	return {
		key: reason,
		digest,
		event: {
			surface: "substrate",
			kind: "warning",
			actor: "agent",
			summary,
			payload: {
				action: "skills.sync",
				component: "skills-projector",
				reason,
				mode: run.mode,
				count,
				names,
				...(run.truncated ? { truncated: true } : {}),
			},
		},
	};
}

/**
 * Emit the run's warning at most once per (reason, name set) and at most once per `renotifyMs` while
 * it stays true, through the projector's fail-open emitter. The state file is written only after the
 * substrate accepted the event, so a refused post is retried on the next run. Never throws.
 */
export async function reportGovernance(
	run: GovernanceRun,
	libraryCount: number,
	ctx: { warnedFile: string; emitWarning: (event: WarningEvent) => Promise<boolean>; log: (line: string) => void; now: () => number; renotifyMs: number },
): Promise<boolean> {
	try {
		for (const line of run.notes) ctx.log(line);
		const warning = governanceWarning(run, libraryCount);
		if (warning === null) return false;
		const warned = readWarned(ctx.warnedFile);
		const previous = Object.hasOwn(warned, warning.key) ? warned[warning.key] : undefined;
		const now = ctx.now();
		// A clock that stepped backwards leaves `at` in the future: that is not "recent", re-send.
		const age = now - (previous?.at ?? 0);
		if (previous !== undefined && previous.digest === warning.digest && age >= 0 && age < ctx.renotifyMs) return false;
		if (!(await ctx.emitWarning(warning.event))) return false;
		warned[warning.key] = { digest: warning.digest, at: now };
		try {
			writeJsonAtomic(ctx.warnedFile, warned);
		} catch (cause) {
			ctx.log(`[projector] governance warned-state not written: ${String(cause instanceof Error ? cause.message : cause).slice(0, 120)}`);
		}
		ctx.log(`[projector] governance warning ${warning.key} (${run.mode})`);
		return true;
	} catch (cause) {
		ctx.log(`[projector] governance report failed: ${String(cause instanceof Error ? cause.message : cause).slice(0, 120)}`);
		return false;
	}
}
