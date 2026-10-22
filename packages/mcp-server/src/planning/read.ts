/**
 * The planning plane's read path (phase 52, SOTA-08): the two MCP reads, `planning_status` and `planning_sessions`.
 *
 * Both are typed. A plane with no root answers `disabled` and never an error; invalid settings answer `misconfigured`
 * with the keys, never the values; a failed index or presence read answers `unavailable` with a code.
 *
 * `planning_status` carries hashes and counts only: no file body and no frontmatter. Each read also compares the index
 * with the one the process read before. A change is written to the ledger as one `planning.changed` note through the
 * ingest path (`emit`), which also sends the bus hint. The first read of a process is a baseline and emits nothing.
 * The comparison is process-local, so a restart starts a new baseline.
 *
 * Each detected change also writes one `planning.transition` record (phase 54) through `metrics`, with the stdout line as its fallback.
 * `planning_sessions` is classified against the server's clock (`presence-dragonfly.ts`). When that clock cannot be
 * read, sessions are listed as `unknown` and the reason is given. They are not guessed as active.
 * Every sessions answer also carries `view`: the session view's state (`states.ts`, one of six) and its line.
 */
import { join } from "node:path";
import type { EventInput } from "../types.ts";
import { diffPlanningIndex, type PlanningSnapshot } from "./diff.ts";
import { emitPlanningChange } from "./events.ts";
import { type PlanningConfigError, type PlanningConfigResult, type PlanningLimits } from "./config.ts";
import { buildPlanningIndex, isErrorRecord, type PlanningFileRecord, type PlanningFs, type PlanningIndexFailure, type PlanningKind, type PlanningRecord } from "./index.ts";
import { DragonflyPresenceStore, PRESENCE_MAX_SESSIONS } from "./presence-dragonfly.ts";
import { classifySessions, type SessionStatus } from "./presence.ts";
import { deriveSessionState, type SessionState, type SessionViewState } from "./states.ts";
import { emitTransition, stdoutMetricSink, transitionRecord, type MetricSink, type TransitionClock, type TransitionOutcome, type TransitionRecord } from "./telemetry.ts";

/** The session id the ledger row carries for a change observed by this plane. */
export const PLANNING_OBSERVER_SESSION = "planning-observer";

/** The phase id a planning transition is recorded under: the planning plane's view, which spans every phase document. */
export const PLANNING_TRANSITION_PHASE = "planning";

export interface PlanningDisabled {
	state: "disabled";
	reason: "root-unset";
}

export interface PlanningMisconfigured {
	state: "misconfigured";
	errors: PlanningConfigError[];
}

export interface PlanningHashRow {
	path: string;
	kind: PlanningKind;
	sha256: string;
	bytes: number;
	phase?: string;
	plan?: string;
}

export interface PlanningErrorRow {
	path: string;
	kind?: PlanningKind;
	sha256: string | null;
	bytes: number | null;
	code: string;
	detail: string;
}

export type PlanningChangeNote =
	| { state: "baseline" }
	| { state: "unchanged" }
	| { state: "changed"; added: number; removed: number; changed: number; ledger: "emitted" | "not-stored" | "repo-unknown" }
	/** A truncated side: removals are not reported (`removed` is null) and `added` is null when the previous side was truncated. Nothing is written. */
	| { state: "partial"; added: number | null; removed: null; changed: number; ledger: "not-written" };

export type PlanningStatusView =
	| PlanningDisabled
	| PlanningMisconfigured
	| { state: "unavailable"; code: PlanningIndexFailure }
	| {
			state: "ok";
			limits: PlanningLimits;
			truncated: boolean;
			counts: { documents: number; errors: number; byKind: Partial<Record<PlanningKind, number>> };
			documents: PlanningHashRow[];
			errors: PlanningErrorRow[];
			changes: PlanningChangeNote;
	  };

export interface PlanningSessionRow {
	sessionId: string;
	worktree: string;
	branch: string;
	activePhase: string | null;
	lastHeartbeatMs: number;
	ageMs: number | null;
	status: SessionStatus | "unknown";
}

export type PlanningSessionsBody =
	| PlanningDisabled
	| PlanningMisconfigured
	| { state: "unavailable"; code: "presence-backend-unset" | "presence-listing-failed"; detail?: string }
	| {
			state: "ok";
			presenceTtlS: number;
			clock: { state: "server" } | { state: "unavailable"; detail: string };
			truncated: boolean;
			sessions: PlanningSessionRow[];
	  };

/** Every sessions answer carries the session view's state and its line, whatever the body is. */
export type PlanningSessionsView = PlanningSessionsBody & { view: SessionViewState };

export interface PlanningReaderDeps {
	settings: PlanningConfigResult;
	fs: PlanningFs;
	/** Null when the cache endpoint is unset or refused by the endpoint policy. */
	presence: DragonflyPresenceStore | null;
	/** The ledger ingest (`Substrate.emit`). Resolves true when the event was stored. */
	emit: (event: EventInput) => Promise<boolean>;
	/** The primary sink for `planning.transition` records: the metrics writer when the ledger is configured, else stdout. */
	metrics: MetricSink;
	/** Written once when `metrics` does not deliver. Default: one JSON line on stdout. */
	fallback?: MetricSink;
	/** The record's clock. Default: the host clock, which stamps a record and classifies nothing. */
	clock?: TransitionClock;
}

type Resolved = { ready: true; root: string; limits: PlanningLimits } | { ready: false; view: PlanningDisabled | PlanningMisconfigured };

function resolve(result: PlanningConfigResult): Resolved {
	if (!result.ok) return { ready: false, view: { state: "misconfigured", errors: result.errors } };
	const settings = result.settings;
	if (!settings.enabled) return { ready: false, view: { state: "disabled", reason: "root-unset" } };
	return {
		ready: true,
		root: settings.root,
		limits: { presenceTtlS: settings.presenceTtlS, maxFiles: settings.maxFiles, maxBytes: settings.maxBytes },
	};
}

export class PlanningReader {
	/** The index the previous `status` read saw, and the root it was read from. Process-local. */
	private previous: { root: string; snapshot: PlanningSnapshot; state: SessionState } | null = null;
	/** Scheduled transition deliveries not yet settled. */
	private readonly pending = new Set<Promise<void>>();

	constructor(private readonly deps: PlanningReaderDeps) {}

	async status(): Promise<PlanningStatusView> {
		const resolved = resolve(this.deps.settings);
		if (!resolved.ready) return resolved.view;
		const { root, limits } = resolved;
		const built = await buildPlanningIndex(root, { fs: this.deps.fs, limits: { maxFiles: limits.maxFiles, maxBytes: limits.maxBytes } });
		if (!built.ok) return { state: "unavailable", code: built.code };
		const { records, truncated } = built.index;
		const counts = countOf(records);
		const changes = await this.observe(root, { records, truncated }, indexState({ documents: counts.documents, errors: counts.errors, truncated }));
		return {
			state: "ok",
			limits,
			truncated,
			counts,
			documents: records.filter(isFileRecord).map(hashRow),
			errors: records.filter(isErrorRecord).map((record) => ({
				path: record.path,
				kind: record.kind,
				sha256: record.sha256,
				bytes: record.bytes,
				code: record.error.code,
				detail: record.error.detail,
			})),
			changes,
		};
	}

	/** The sessions body, with the session view's state beside it: every answer carries one state from the closed set. */
	async sessions(): Promise<PlanningSessionsView> {
		const body = await this.sessionsBody();
		return { ...body, view: sessionViewOf(body) };
	}

	private async sessionsBody(): Promise<PlanningSessionsBody> {
		const resolved = resolve(this.deps.settings);
		if (!resolved.ready) return resolved.view;
		const presence = this.deps.presence;
		if (presence === null) return { state: "unavailable", code: "presence-backend-unset" };
		const ttlMs = resolved.limits.presenceTtlS * 1000;
		try {
			const listing = await presence.listWithin(PRESENCE_MAX_SESSIONS);
			const clock = await readClock(presence);
			const sessions: PlanningSessionRow[] = clock.ok
				? classifySessions(listing.records, clock.nowMs, ttlMs).map((entry) => ({
						sessionId: entry.sessionId,
						worktree: entry.worktree,
						branch: entry.branch,
						activePhase: entry.activePhase,
						lastHeartbeatMs: entry.lastHeartbeatMs,
						ageMs: entry.ageMs,
						status: entry.status,
					}))
				: listing.records.map((record) => ({
						sessionId: record.sessionId,
						worktree: record.worktree,
						branch: record.branch,
						activePhase: record.activePhase,
						lastHeartbeatMs: record.lastHeartbeatMs,
						ageMs: null,
						status: "unknown",
					}));
			return {
				state: "ok",
				presenceTtlS: resolved.limits.presenceTtlS,
				clock: clock.ok ? { state: "server" } : { state: "unavailable", detail: clock.detail },
				truncated: listing.truncated,
				sessions,
			};
		} catch (cause: unknown) {
			return { state: "unavailable", code: "presence-listing-failed", detail: cause instanceof Error ? cause.message : String(cause) };
		}
	}

	/**
	 * Compares this index with the last one read here, and records the state this read is in. A complete diff writes one
	 * `planning.changed` note when it differs. A partial diff (either side truncated) reports what it can vouch for and writes
	 * nothing: removals are never inferred from a truncated side, so `removed` stays null rather than an empty list.
	 *
	 * A detected change also writes one `planning.transition` record, from the state of the previous read to this one. Nothing is
	 * written when nothing is detected.
	 */
	private async observe(root: string, snapshot: PlanningSnapshot, state: SessionState): Promise<PlanningChangeNote> {
		const previous = this.previous;
		if (previous === null || previous.root !== root) {
			this.previous = { root, snapshot, state };
			return { state: "baseline" };
		}
		// A throw from the comparison (a config read, a ledger publish) leaves `previous` where it was: the next read compares with the same baseline and sees the change then.
		const { note, outcome } = await this.compare(root, previous.snapshot, snapshot);
		const record = outcome === null ? null : transitionRecord({ phaseId: PLANNING_TRANSITION_PHASE, from: previous.state, to: state, outcome }, this.deps.clock ?? hostClock);
		this.previous = { root, snapshot, state };
		if (record !== null) this.schedule(record);
		return note;
	}

	/** The change note for two indexes, and the transition outcome when a change was detected: null when none was, or none can be vouched for. */
	private async compare(root: string, before: PlanningSnapshot, after: PlanningSnapshot): Promise<{ note: PlanningChangeNote; outcome: TransitionOutcome | null }> {
		const diff = diffPlanningIndex(before, after);
		const removed = diff.removed;
		if (removed === null) {
			const added = before.truncated ? null : diff.added.length;
			const changed = diff.changed.length;
			const vouched = (added ?? 0) + changed > 0;
			return { note: { state: "partial", added, removed: null, changed, ledger: "not-written" }, outcome: vouched ? "refused" : null };
		}
		const counts = { added: diff.added.length, removed: removed.length, changed: diff.changed.length };
		if (counts.added + counts.removed + counts.changed === 0) return { note: { state: "unchanged" }, outcome: null };
		const repo = await repoOf(this.deps.fs, root);
		if (repo === null) return { note: { state: "changed", ...counts, ledger: "repo-unknown" }, outcome: "refused" };
		const stored = await emitPlanningChange({ publish: this.deps.emit }, { repo, sessionId: PLANNING_OBSERVER_SESSION, diff: { ...diff, removed } });
		const ledger = stored === "published" ? "emitted" : "not-stored";
		return { note: { state: "changed", ...counts, ledger }, outcome: ledger === "emitted" ? "applied" : "refused" };
	}

	/**
	 * Hands one `planning.transition` record to its sinks without waiting for them, so the reply never carries the metric write.
	 * `emitTransition` never throws: a refused or thrown primary goes to the stdout fallback, and a fallback that fails is written to stderr.
	 */
	private schedule(record: TransitionRecord): void {
		const delivery: Promise<void> = emitTransition(record, this.deps.metrics, this.deps.fallback ?? stdoutMetricSink()).then((delivered) => {
			this.pending.delete(delivery);
			if (delivered.status === "failed") {
				process.stderr.write(`[substrate] planning transition not delivered: ${delivered.primary.sink} ${delivered.primary.reason}, ${delivered.fallback.sink} ${delivered.fallback.reason}\n`);
			}
		});
		this.pending.add(delivery);
	}

	/** Resolves once every scheduled transition record has been delivered or handed to its fallback. A read never waits on it; tests and an orderly shutdown may. */
	async settleTransitions(): Promise<void> {
		while (this.pending.size > 0) await Promise.all([...this.pending]);
	}
}

/** The host clock. It stamps a transition record and classifies nothing. */
const hostClock: TransitionClock = () => new Date();

/**
 * The state of a planning index for its transition record: DEGRADED when the view is partial (truncated, or a document could
 * not be read), EMPTY with no document, SUCCESS otherwise. An unavailable read is ERROR, but it records no state.
 */
function indexState(input: { documents: number; errors: number; truncated: boolean }): SessionState {
	if (input.truncated || input.errors > 0) return "DEGRADED";
	return input.documents === 0 ? "EMPTY" : "SUCCESS";
}

/** The session view's state and line, from what the body knows. Each non-ok body names what is off, or the failure it had. */
function sessionViewOf(body: PlanningSessionsBody): SessionViewState {
	switch (body.state) {
		case "disabled":
			return deriveSessionState({ loaded: true, sessions: [], disabledCapabilities: ["planning"] });
		case "misconfigured":
			return deriveSessionState({ loaded: true, sessions: [], disabledCapabilities: [], error: `invalid planning settings: ${body.errors.map((error) => error.key).join(", ")}` });
		case "unavailable":
			if (body.code === "presence-backend-unset") return deriveSessionState({ loaded: true, sessions: [], disabledCapabilities: ["presence"] });
			return deriveSessionState({ loaded: true, sessions: [], disabledCapabilities: [], error: body.code });
		case "ok": {
			const disabledCapabilities = [
				...(body.clock.state === "unavailable" ? ["server clock"] : []),
				...(body.truncated ? ["sessions beyond the listing bound"] : []),
			];
			return deriveSessionState({ loaded: true, sessions: body.sessions.map((row) => row.status), disabledCapabilities });
		}
	}
}

function isFileRecord(record: PlanningRecord): record is PlanningFileRecord {
	return !isErrorRecord(record);
}

function hashRow(record: PlanningFileRecord): PlanningHashRow {
	const row: PlanningHashRow = { path: record.path, kind: record.kind, sha256: record.sha256, bytes: record.bytes };
	if (record.phase !== undefined) row.phase = record.phase;
	if (record.plan !== undefined) row.plan = record.plan;
	return row;
}

function countOf(records: PlanningRecord[]): { documents: number; errors: number; byKind: Partial<Record<PlanningKind, number>> } {
	const byKind: Partial<Record<PlanningKind, number>> = {};
	let documents = 0;
	let errors = 0;
	for (const record of records) {
		if (isErrorRecord(record)) {
			errors++;
			continue;
		}
		documents++;
		byKind[record.kind] = (byKind[record.kind] ?? 0) + 1;
	}
	return { documents, errors, byKind };
}

/** The server's clock, or the reason it could not be read. Never a host-clock guess. */
async function readClock(presence: DragonflyPresenceStore): Promise<{ ok: true; nowMs: number } | { ok: false; detail: string }> {
	try {
		return { ok: true, nowMs: await presence.serverNowMs() };
	} catch (cause: unknown) {
		return { ok: false, detail: cause instanceof Error ? cause.message : String(cause) };
	}
}

/** The `owner/name` of the `origin` remote in the checkout's `.git/config`, or null when it cannot be read from there. */
async function repoOf(fs: PlanningFs, root: string): Promise<string | null> {
	const path = join(root, ".git", "config");
	const found = await fs.statFile(path);
	if (found === null || !found.isFile) return null;
	return repoFromGitConfig(new TextDecoder().decode(await fs.readFile(path)));
}

/** Parses the `origin` URL of a git config into `owner/name`. Only the two trailing path segments are kept. */
export function repoFromGitConfig(text: string): string | null {
	const section = /\[remote "origin"\]([\s\S]*?)(?=\n\[|$)/.exec(text);
	const url = section ? /^\s*url\s*=\s*(\S+)\s*$/m.exec(section[1] ?? "") : null;
	if (!url) return null;
	const match = /[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url[1] ?? "");
	return match ? `${match[1]}/${match[2]}` : null;
}
