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
 * `planning_sessions` is classified against the server's clock. When that clock cannot be read, sessions are listed as
 * `unknown` and the reason is given. They are not guessed as active.
 */
import { join, resolve as resolvePath } from "node:path";
import type { EventInput } from "../types.ts";
import { diffPlanningIndex, type PlanningSnapshot } from "./diff.ts";
import { emitPlanningChange } from "./events.ts";
import { type PlanningConfigError, type PlanningConfigResult, type PlanningLimits } from "./config.ts";
import { buildPlanningIndex, isErrorRecord, type PlanningFileRecord, type PlanningFs, type PlanningIndexFailure, type PlanningKind, type PlanningRecord } from "./index.ts";
import { DragonflyPresenceStore, PRESENCE_MAX_SESSIONS } from "./presence-dragonfly.ts";
import { classifySessions, type SessionRecord, type SessionStatus } from "./presence.ts";

/** The session id the ledger row carries for a change observed by this plane. */
export const PLANNING_OBSERVER_SESSION = "planning-observer";

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
export type PlanningHeartbeat = { state: "written" } | { state: "presence-unset" } | { state: "failed"; detail: string };

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

export type PlanningSessionsView =
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

export interface PlanningReaderDeps {
	settings: PlanningConfigResult;
	fs: PlanningFs;
	/** Null when the cache endpoint is unset or refused by the endpoint policy. */
	presence: DragonflyPresenceStore | null;
	/** The ledger ingest (`Substrate.emit`). Resolves true when the event was stored. */
	emit: (event: EventInput) => Promise<boolean>;
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
	/** The baseline: the root, the scan that set it, and its snapshot. It only moves forward. Process-local. */
	private baseline: { root: string; seq: number; snapshot: PlanningSnapshot } | null = null;
	/** Scans started so far. A scan takes the next number when it starts, so a later start has a larger number. */
	private scans = 0;

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
		const changes = await this.observe(root, seq, { records, truncated, unlisted });
		return {
			state: "ok",
			limits,
			truncated,
			counts: countOf(records),
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

	async sessions(): Promise<PlanningSessionsView> {
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
	 * value given here is a placeholder. Any failure is returned as a `failed` outcome, never thrown.
	 */
	private async heartbeat(root: string, ttlMs: number): Promise<PlanningHeartbeat> {
		const presence = this.deps.presence;
		if (presence === null) return { state: "presence-unset" };
		try {
			const layout = await gitLayout(this.deps.fs, root);
			if (!layout.ok) return { state: "failed", detail: layout.reason };
			const record: SessionRecord = {
				sessionId: planningSessionId(this.deps.fs, root),
				worktree: root,
				branch: await branchOf(this.deps.fs, layout.gitDir),
				activePhase: null,
				lastHeartbeatMs: 0,
			};
			await presence.touch(record, ttlMs);
			return { state: "written" };
		} catch (cause: unknown) {
			return { state: "failed", detail: cause instanceof Error ? cause.message : String(cause) };
		}
	}

	/**
	 * Compares this index with the baseline. A scan older than the baseline is `superseded`, and the baseline is left alone.
	 * A complete diff writes one `planning.changed` note when it differs. A partial diff (either side truncated) reports what
	 * it can vouch for and writes nothing: removals are never inferred from a truncated side, so `removed` stays null.
	 * A transition whose repo cannot be read for a transient reason is reported for this call and the baseline stays where it
	 * was, so the next successful read sees the same transition and publishes it once.
	 */
	private async observe(root: string, seq: number, snapshot: PlanningSnapshot): Promise<PlanningChangeNote> {
		const current = this.baseline;
		if (current !== null && seq < current.seq) return { state: "superseded" };
		if (current === null || current.root !== root) {
			this.advance(root, seq, snapshot);
			return { state: "baseline" };
		}
		const diff = diffPlanningIndex(current.snapshot, snapshot);
		const removed = diff.removed;
		if (removed === null) {
			this.advance(root, seq, snapshot);
			return {
				state: "partial",
				added: current.snapshot.truncated ? null : diff.added.length,
				removed: null,
				changed: diff.changed.length,
				ledger: "not-written",
			};
		}
		const counts = { added: diff.added.length, removed: removed.length, changed: diff.changed.length };
		if (counts.added + counts.removed + counts.changed === 0) {
			this.advance(root, seq, snapshot);
			return { state: "unchanged" };
		}
		const repo = await repoOf(this.deps.fs, root);
		if (repo.state === "unknown" && repo.transient) {
			return { state: "changed", ...counts, ledger: "repo-unknown", repoReason: repo.reason };
		}
		this.advance(root, seq, snapshot);
		if (repo.state === "unknown") return { state: "changed", ...counts, ledger: "repo-unknown", repoReason: repo.reason };
		const outcome = await emitPlanningChange(
			{ publish: this.deps.emit },
			{ repo: repo.repo, sessionId: PLANNING_OBSERVER_SESSION, diff: { ...diff, removed } },
		);
		return { state: "changed", ...counts, ledger: outcome === "published" ? "emitted" : "not-stored" };
	}

	/** Moves the baseline to this scan, unless a later scan already holds it. The baseline never moves backwards. */
	private advance(root: string, seq: number, snapshot: PlanningSnapshot): void {
		if (this.baseline !== null && seq < this.baseline.seq) return;
		this.baseline = { root, seq, snapshot };
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

/** The branch a worktree's HEAD names, or `detached`. A HEAD that is absent throws. */
async function branchOf(fs: PlanningFs, gitDir: string): Promise<string> {
	const head = await textOf(fs, join(gitDir, "HEAD"));
	if (head === null) throw new Error("HEAD is absent");
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
	const url = section ? /^\s*url\s*=\s*(\S+)\s*$/m.exec(section[1] ?? "") : null;
	if (!url) return null;
	const match = /[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url[1] ?? "");
	return match ? `${match[1]}/${match[2]}` : null;
}
