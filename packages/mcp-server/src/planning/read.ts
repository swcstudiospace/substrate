/**
 * The planning plane's read path (phase 52, SOTA-08): the two MCP reads, `planning_status` and `planning_sessions`.
 *
 * Both are typed. A plane with no root answers `disabled` and never an error; invalid settings answer `misconfigured`
 * with the keys, never the values; a failed index or presence read answers `unavailable` with a code.
 *
 * Each read writes a heartbeat for its checkout before it answers: the session is the worktree, keyed by a hash of its
 * path, with the branch read from its HEAD. The heartbeat is stamped with the server's clock (`presence-dragonfly.ts`).
 * A heartbeat that fails is reported in the view and does not fail the read. The MCP transport is stateless, so the
 * checkout is the only stable identity a read has.
 *
 * `planning_status` carries hashes and counts only: no file body and no frontmatter. Each read also compares the index
 * with the baseline the process holds. The baseline only moves forward: a scan that started before the current baseline
 * was set reports `superseded` and changes nothing. A complete change is written to the ledger as one `planning.changed`
 * note through the ingest path (`emit`), which also sends the bus hint. The first read of a process is a baseline and
 * emits nothing. The comparison is process-local, so a restart starts a new baseline.
 *
 * Each detected change also writes one `planning.transition` record (phase 54) through `metrics`, with the stdout line as its
 * fallback. The record is handed to its sinks without being awaited, so a slow metric write does not delay the read.
 *
 * `planning_sessions` is classified against the server's clock. When that clock cannot be read, sessions are listed as
 * `unknown` and the reason is given. They are not guessed as active. Every sessions answer also carries `view`: the session
 * view's state (`states.ts`, one of six) and its line.
 */
import { join, resolve as resolvePath } from "node:path";
import type { EventInput } from "../types.ts";
import { diffPlanningIndex, type PlanningDiff, type PlanningSnapshot } from "./diff.ts";
import { observePlanningChange, type ObservedPlanning } from "./events.ts";
import { type PlanningConfigError, type PlanningConfigResult, type PlanningLimits } from "./config.ts";
import { buildPlanningIndex, isErrorRecord, type PlanningFileRecord, type PlanningFs, type PlanningIndexFailure, type PlanningKind, type PlanningRecord } from "./index.ts";
import { DragonflyPresenceStore, PRESENCE_MAX_SESSIONS } from "./presence-dragonfly.ts";
import { classifySessions, type SessionRecord, type SessionStatus } from "./presence.ts";
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

/** Why a change could not be attributed to a repo. Each reason is a typed result, never an exception out of the read. */
export type RepoUnknownReason = "no-git-entry" | "git-file-malformed" | "git-dir-unreadable" | "config-unreadable" | "config-missing" | "origin-missing";

export type PlanningChangeNote =
	| { state: "baseline" }
	| { state: "unchanged" }
	/** A scan that started before the current baseline was set. It changes nothing and writes nothing. */
	| { state: "superseded" }
	| { state: "changed"; added: number; removed: number; changed: number; ledger: "emitted" | "not-stored" }
	| { state: "changed"; added: number; removed: number; changed: number; ledger: "repo-unknown"; repoReason: RepoUnknownReason }
	/** A truncated side: removals are not reported (`removed` is null) and `added` is null when the previous side was truncated. Nothing is written. */
	| { state: "partial"; added: number | null; removed: null; changed: number; ledger: "not-written" };

/** The outcome of this read's heartbeat. */
export type PlanningHeartbeat = { state: "written" } | { state: "presence-unset" } | { state: "failed"; detail: string; transient: boolean };

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
			heartbeat: PlanningHeartbeat;
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
			heartbeat: PlanningHeartbeat;
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

/** Most transition deliveries in flight at once. Past it a record goes straight to the stdout fallback, so the set stays bounded. */
export const MAX_PENDING_TRANSITIONS = 64;

export class PlanningReader {
	/** The baseline: the root, the scan that set it, its snapshot, and the state that read was in. It only moves forward. Process-local. */
	private baseline: { root: string; seq: number; snapshot: PlanningSnapshot; state: SessionState } | null = null;
	/** Scans started so far. A scan takes the next number when it starts, so a later start has a larger number. */
	private scans = 0;
	/** Scheduled transition deliveries not yet settled. */
	private readonly pending = new Set<Promise<void>>();
	/** The last queued observation. Each observation waits for it, so the baseline and the publish are never interleaved. */
	private observing: Promise<unknown> = Promise.resolve();
	/** The identity of the held change whose transition is already recorded, so a later read of that change records nothing. */
	private recordedHold: string | null = null;

	constructor(private readonly deps: PlanningReaderDeps) {}

	async status(): Promise<PlanningStatusView> {
		const resolved = resolve(this.deps.settings);
		if (!resolved.ready) return resolved.view;
		const { root, limits } = resolved;
		const seq = ++this.scans;
		const heartbeat = await this.heartbeat(root, limits.presenceTtlS * 1000);
		const built = await buildPlanningIndex(root, { fs: this.deps.fs, limits: { maxFiles: limits.maxFiles, maxBytes: limits.maxBytes } });
		if (!built.ok) return { state: "unavailable", code: built.code };
		const { records, truncated, unlisted } = built.index;
		const counts = countOf(records);
		const changes = await this.observe(root, seq, { records, truncated, unlisted }, indexState({ documents: counts.documents, errors: counts.errors, truncated }));
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
			heartbeat,
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
		const heartbeat = await this.heartbeat(resolved.root, ttlMs);
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
				heartbeat,
			};
		} catch (cause: unknown) {
			return { state: "unavailable", code: "presence-listing-failed", detail: cause instanceof Error ? cause.message : String(cause) };
		}
	}

	/**
	 * Writes this checkout's heartbeat. The record's `lastHeartbeatMs` is replaced by the server's clock inside `touch`, so the
	 * value given here is a placeholder. A missing git entry or HEAD is a definitive `failed` (`transient: false`). Every other
	 * failed read, and a presence write that throws, is a transient `failed` (`transient: true`), which degrades the session view.
	 */
	private async heartbeat(root: string, ttlMs: number): Promise<PlanningHeartbeat> {
		const presence = this.deps.presence;
		if (presence === null) return { state: "presence-unset" };
		let record: SessionRecord;
		try {
			const layout = await gitLayout(this.deps.fs, root);
			if (!layout.ok) return { state: "failed", detail: layout.reason, transient: false };
			const head = await textOf(this.deps.fs, join(layout.gitDir, "HEAD"));
			if (head === null) return { state: "failed", detail: "head-absent", transient: false };
			record = {
				sessionId: planningSessionId(this.deps.fs, root),
				worktree: root,
				branch: branchFromHead(head),
				activePhase: null,
				lastHeartbeatMs: 0,
			};
		} catch (cause: unknown) {
			// A read that fails after the layout was seen (EACCES, EIO, a file removed between stat and read) is transient.
			return { state: "failed", detail: cause instanceof Error ? cause.message : String(cause), transient: true };
		}
		try {
			await presence.touch(record, ttlMs);
			return { state: "written" };
		} catch (cause: unknown) {
			return { state: "failed", detail: cause instanceof Error ? cause.message : String(cause), transient: true };
		}
	}

	/**
	 * Compares this index with the baseline. A scan older than the baseline is `superseded`, and the baseline is left alone.
	 * A complete diff writes one `planning.changed` note when it differs. A partial diff (either side truncated) reports what
	 * it can vouch for and writes nothing: removals are never inferred from a truncated side, so `removed` stays null.
	 *
	 * A detected change also writes one `planning.transition` record, from the state the baseline was in to this read's. The
	 * baseline advances only after that record is made: a comparison that throws leaves it where it was. A transient repo read
	 * failure holds it too, so the next successful read publishes the change and its transition once.
	 */
	private async observeOnce(root: string, seq: number, snapshot: PlanningSnapshot, state: SessionState): Promise<PlanningChangeNote> {
		const current = this.baseline;
		if (current !== null && seq < current.seq) return { state: "superseded" };
		const previous = current !== null && current.root === root ? current.snapshot : null;
		const diff = previous === null ? null : diffPlanningIndex(previous, snapshot);
		const repo = await repoOf(this.deps.fs, root);
		let note: PlanningChangeNote;
		let outcome: TransitionOutcome | null;
		let hold = false;
		let baseline = snapshot;
		if (repo.state === "known") {
			// The baseline decision and the publish are core's: a failed publish holds the baseline, every other outcome advances it.
			const observed = await observePlanningChange({
				previous,
				next: snapshot,
				repo: repo.repo,
				sessionId: PLANNING_OBSERVER_SESSION,
				publisher: { publish: this.deps.emit },
			});
			note = noteFor(observed.outcome, previous, diff);
			hold = observed.outcome === "not-published";
			outcome = observed.outcome === "published" ? "applied" : hold ? "refused" : unpublishedOutcome(previous, diff);
			baseline = observed.baseline;
		} else {
			// Without a repo nothing can be published. A change is held for a transient failure and ends, as a repo-unknown note, for a
			// definitive absence. Any other scan becomes the baseline.
			const counts = diff !== null && diff.removed !== null ? countsOf(diff) : null;
			if (counts !== null && counts.added + counts.removed + counts.changed > 0) {
				if (repo.transient) return { state: "changed", ...counts, ledger: "repo-unknown", repoReason: repo.reason };
				note = { state: "changed", ...counts, ledger: "repo-unknown", repoReason: repo.reason };
				outcome = "refused";
			} else {
				note = noteFor(diff === null ? "baseline" : diff.removed === null ? "incomplete" : "unchanged", previous, diff);
				outcome = unpublishedOutcome(previous, diff);
			}
		}
		// The change's identity: a held change is recorded once, on first detection, and not again once it is stored.
		const key = diff !== null && diff.removed !== null && outcome !== null ? changeKey({ added: diff.added, removed: diff.removed, changed: diff.changed }, snapshot) : null;
		const incomplete = diff !== null && !diff.complete;
		if (hold) {
			// A change the ledger did not store holds the baseline, so the next read sends it again. Its transition is recorded once,
			// on first detection: a failed ledger write does not hide the transition from the stdout sink.
			if (outcome !== null && current !== null && key !== this.recordedHold) {
				this.recordedHold = key;
				this.schedule(transitionRecord({ phaseId: PLANNING_TRANSITION_PHASE, from: current.state, to: state, outcome, incomplete }, this.deps.clock ?? hostClock));
			}
			return note;
		}
		const recorded = key !== null && key === this.recordedHold;
		if (outcome !== null && current !== null && !recorded) {
			this.schedule(transitionRecord({ phaseId: PLANNING_TRANSITION_PHASE, from: current.state, to: state, outcome, incomplete }, this.deps.clock ?? hostClock));
		}
		this.advance(root, seq, baseline, state);
		return note;
	}

	/** Moves the baseline to this scan, unless a later scan already holds it. The baseline never moves backwards. A new baseline forgets a held change. */
	private advance(root: string, seq: number, snapshot: PlanningSnapshot, state: SessionState): void {
		if (this.baseline !== null && seq < this.baseline.seq) return;
		this.recordedHold = null;
		this.baseline = { root, seq, snapshot, state };
	}

	/** Observations run one at a time, in arrival order, so two reads never publish the same change. */
	private observe(root: string, seq: number, snapshot: PlanningSnapshot, state: SessionState): Promise<PlanningChangeNote> {
		const run = this.observing.then(() => this.observeOnce(root, seq, snapshot, state));
		this.observing = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/**
	 * Hands one `planning.transition` record to its sinks without waiting for them, so the reply never carries the metric write.
	 * The deliveries in flight are bounded by {@link MAX_PENDING_TRANSITIONS}: past the bound a record goes to the fallback alone,
	 * so a stalled primary can neither grow the set nor lose a record. `emitTransition` never throws; a fallback that fails is
	 * written to stderr.
	 */
	private schedule(record: TransitionRecord): void {
		const fallback = this.deps.fallback ?? stdoutMetricSink();
		const tracked = this.pending.size < MAX_PENDING_TRANSITIONS;
		const delivery: Promise<void> = emitTransition(record, tracked ? this.deps.metrics : fallback, fallback).then((delivered) => {
			if (tracked) this.pending.delete(delivery);
			if (delivered.status === "failed") {
				process.stderr.write(`[substrate] planning transition not delivered: ${delivered.primary.sink} ${delivered.primary.reason}, ${delivered.fallback.sink} ${delivered.fallback.reason}\n`);
			}
		});
		if (tracked) this.pending.add(delivery);
	}

	/**
	 * Waits for the transition deliveries in flight, up to `deadline`: resolves `settled` when none is left, or `deadline` when the
	 * bound came first. Never rejects. Shutdown passes its timer as the bound; a read never waits on this. Without a bound it waits
	 * for every delivery.
	 */
	async settleTransitions(deadline: Promise<void> = Promise.withResolvers<void>().promise): Promise<"settled" | "deadline"> {
		const flushed = (async (): Promise<"settled"> => {
			while (this.pending.size > 0) await Promise.all([...this.pending]);
			return "settled";
		})();
		return Promise.race([flushed, deadline.then((): "deadline" => "deadline")]);
	}

}

/** The identity of a change: its paths and the hashes they now have. A held change detected again has the same identity. */
function changeKey(diff: { added: string[]; removed: string[]; changed: string[] }, after: PlanningSnapshot): string {
	const hashes = new Map(after.records.map((record) => [record.path, record.sha256] as const));
	const hashed = (paths: string[]): [string, string | null][] => paths.map((path) => [path, hashes.get(path) ?? null]);
	return JSON.stringify({ added: hashed(diff.added), removed: diff.removed, changed: hashed(diff.changed) });
}

/** The transition outcome of an observation that published nothing: an incomplete diff that vouches for a change is refused; the rest record nothing. */
function unpublishedOutcome(previous: PlanningSnapshot | null, diff: PlanningDiff | null): TransitionOutcome | null {
	if (diff === null || diff.complete) return null;
	const added = previous?.truncated === true ? 0 : diff.added.length;
	return added + diff.changed.length > 0 ? "refused" : null;
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
				...(body.heartbeat.state === "failed" && body.heartbeat.transient ? ["checkout heartbeat"] : []),
				...(body.truncated ? ["sessions beyond the listing bound"] : []),
			];
			return deriveSessionState({ loaded: true, sessions: body.sessions.map((row) => row.status), disabledCapabilities });
		}
	}
}

/** The counts of a complete diff. A change is only ever counted on one: a partial diff has no removals to count. */
function countsOf(diff: PlanningDiff): { added: number; removed: number; changed: number } {
	if (diff.removed === null) throw new Error("counts are only taken from a complete diff");
	return { added: diff.added.length, removed: diff.removed.length, changed: diff.changed.length };
}

/** The note for an observation outcome. `baseline` and `unchanged` carry no counts; `published` and `not-published` are changes. */
function noteFor(outcome: ObservedPlanning["outcome"], previous: PlanningSnapshot | null, diff: PlanningDiff | null): PlanningChangeNote {
	if (outcome === "baseline") return { state: "baseline" };
	if (outcome === "unchanged") return { state: "unchanged" };
	if (previous === null || diff === null) throw new Error("only a first scan has no previous baseline");
	if (outcome === "incomplete") {
		return { state: "partial", added: previous.truncated ? null : diff.added.length, removed: null, changed: diff.changed.length, ledger: "not-written" };
	}
	return { state: "changed", ...countsOf(diff), ledger: outcome === "published" ? "emitted" : "not-stored" };
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

/** The session a checkout heartbeats as: stable for the path, and shaped to pass the session id rule. */
function planningSessionId(fs: PlanningFs, root: string): string {
	return `wt-${fs.sha256(new TextEncoder().encode(root)).slice(0, 24)}`;
}

/** The text of a file, or null when it is absent. Any other failure throws. */
async function textOf(fs: PlanningFs, path: string): Promise<string | null> {
	const found = await fs.statFile(path);
	if (found === null || !found.isFile) return null;
	return new TextDecoder().decode(await fs.readFile(path));
}

type GitLayout = { ok: true; gitDir: string; commonDir: string } | { ok: false; reason: RepoUnknownReason };

/**
 * Where a checkout's git data lives. A `.git` directory is the git directory. A `.git` file (a linked worktree) names one
 * in its `gitdir:` line, relative to the checkout. That git directory's `commondir` file, when present, names the common
 * directory that holds the shared `config`. I/O failures throw; a missing or malformed layout is a typed result.
 */
async function gitLayout(fs: PlanningFs, root: string): Promise<GitLayout> {
	const dotGit = join(root, ".git");
	const entry = await fs.statFile(dotGit);
	if (entry === null) return { ok: false, reason: "no-git-entry" };
	let gitDir = dotGit;
	if (entry.isFile) {
		const pointer = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec((await textOf(fs, dotGit)) ?? "");
		if (pointer === null) return { ok: false, reason: "git-file-malformed" };
		gitDir = resolvePath(root, pointer[1] ?? "");
	}
	const commondir = await textOf(fs, join(gitDir, "commondir"));
	const commonDir = commondir === null ? gitDir : resolvePath(gitDir, commondir.trim());
	return { ok: true, gitDir, commonDir };
}

/** The branch a worktree's HEAD names, or `detached`. */
function branchFromHead(head: string): string {
	const ref = /^ref:[ \t]*refs\/heads\/(.+?)[ \t]*$/m.exec(head);
	return ref === null ? "detached" : (ref[1] ?? "detached");
}

type RepoLookup = { state: "known"; repo: string } | { state: "unknown"; reason: RepoUnknownReason; transient: boolean };

/**
 * The `owner/name` of the `origin` remote, read from the common git directory's config. A definitive absence (no git entry,
 * no config, no origin) is `transient: false`. A read that failed for any other reason (denied, I/O, or removed between the
 * stat and the read) is `transient: true`: the caller must not advance the baseline on it, so the transition is published
 * by the next successful read.
 */
async function repoOf(fs: PlanningFs, root: string): Promise<RepoLookup> {
	let layout: GitLayout;
	try {
		layout = await gitLayout(fs, root);
	} catch {
		return { state: "unknown", reason: "git-dir-unreadable", transient: true };
	}
	if (!layout.ok) return { state: "unknown", reason: layout.reason, transient: false };
	let config: string | null;
	try {
		config = await textOf(fs, join(layout.commonDir, "config"));
	} catch {
		return { state: "unknown", reason: "config-unreadable", transient: true };
	}
	if (config === null) return { state: "unknown", reason: "config-missing", transient: false };
	const repo = repoFromGitConfig(config);
	return repo === null ? { state: "unknown", reason: "origin-missing", transient: false } : { state: "known", repo };
}

/** Parses the `origin` URL of a git config into `owner/name`. Only the two trailing path segments are kept. */
export function repoFromGitConfig(text: string): string | null {
	const section = /\[remote "origin"\]([\s\S]*?)(?=\n\[|$)/.exec(text);
	const url = section ? /^\s*url\s*=\s*(.+?)\s*$/m.exec(section[1] ?? "") : null;
	if (!url) return null;
	const match = /[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(unquoted(url[1] ?? ""));
	return match ? `${match[1]}/${match[2]}` : null;
}

/** A value with one matching pair of surrounding quotes removed. A value without them is returned as it is. */
function unquoted(value: string): string {
	const pair = /^(["'])(.*)\1$/.exec(value);
	return pair ? (pair[2] ?? "") : value;
}
