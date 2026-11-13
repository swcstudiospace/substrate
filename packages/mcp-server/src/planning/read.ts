/**
 * The planning plane's reads (phase 52, SOTA-08; phase 53, SOTA-09): `planning_status` and `planning_sessions`.
 *
 * Both are read-only and write nothing, on every call: no presence heartbeat, no ledger note, no file. The reader holds no
 * state between calls. The server's planning observer (`observer.ts`) is the plane's only writer: it publishes changes,
 * heartbeats checkouts with their planning reports, and announces conflicts, on a timer and never inside a read.
 *
 * Both are typed. A plane with no checkouts answers `disabled` and never an error; invalid settings answer `misconfigured`
 * with the keys, never the values; a failed index or presence read answers `unavailable` with a code. Both take an optional
 * `checkout` key. Each configured checkout has its own reader: the top-level fields are the selected checkout's view (the one
 * named, or the first configured), and `checkouts` holds one `{ key, root, view }` entry per checkout the call names. A key that
 * names no checkout answers `unavailable` with reason `unknown-checkout`, and no `checkouts`.
 *
 * `planning_status` carries hashes and counts, and the GSD-Core position (`position.ts`): fields parsed from STATE.md and
 * ROADMAP.md, redacted and capped, and never a file body or the frontmatter itself. The position is composed from the scan
 * that built the index, with no second read. It also says whether completion checkpoints survive a restart, read from the
 * configured directory (`checkpoint-store.ts`).
 *
 * `planning_sessions` is classified against the server's clock. When that clock cannot be read, sessions are listed as
 * `unknown` and the reason is given. They are not guessed as active. Each session carries its planning view, and the view
 * lists the conflicts across the active sessions. Detection is pure here; announcing a conflict is the observer's. Every
 * sessions answer also carries `view`: the session view's state (`states.ts`, one of six) and its line. A read has no
 * heartbeat, so the view names the server clock and the listing bound, and nothing about the checkout's own writes.
 */
import type { CompletionStoreView } from "./checkpoint-store.ts";
import type { PlanningCheckout, PlanningConfigError, PlanningConfigResult, PlanningLimits } from "./config.ts";
import { detectConflicts, sessionViewOf, type PlanningConflict, type SessionView } from "./conflicts.ts";
import { scopeRepoId } from "../event.ts";
import { buildPlanningIndex, indexRecords, isErrorRecord, positionOf, type PlanningFileRecord, type PlanningFs, type PlanningIndexFailure, type PlanningKind, type PlanningRecord } from "./index.ts";
import type { PositionResult } from "./position.ts";
import { type DragonflyPresenceStore, PRESENCE_MAX_SESSIONS } from "./presence-dragonfly.ts";
import { classifySessions, type SessionStatus, type UnknownViewReason } from "./presence.ts";
import { deriveSessionState, type SessionViewState } from "./states.ts";

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

/** `checkout` names no configured checkout. Answered alone: no index and no `checkouts`. */
export interface PlanningUnknownCheckout {
	state: "unavailable";
	reason: "unknown-checkout";
}

/** One checkout's index: counts and hashes, the GSD-Core position and the errors, or why it could not be read. */
export type PlanningIndexView =
	| { state: "unavailable"; code: PlanningIndexFailure }
	| {
			state: "ok";
			limits: PlanningLimits;
			truncated: boolean;
			counts: { documents: number; errors: number; byKind: Partial<Record<PlanningKind, number>> };
			/** Where GSD-Core is: milestone, phase, plan, step, status and progress, from STATE.md and ROADMAP.md. Set whenever the index was read. */
			position?: PositionResult;
			documents: PlanningHashRow[];
			errors: PlanningErrorRow[];
			/** Whether completion checkpoints survive a restart. Read from the configured directory; see `checkpoint-store.ts`. */
			checkpoints: CompletionStoreView;
	  };

/** One configured checkout's entry in an answer: its key and root, and its own view. Entries come in configuration order. */
export interface PlanningCheckoutEntry<V> {
	key: string;
	root: string;
	view: V;
}

/**
 * `planning_status`. Disabled, misconfigured and unknown-checkout answer alone. Otherwise the top-level fields are the view of the
 * selected checkout (the one named, or the first configured) and `checkouts` holds the entries the call names.
 */
export type PlanningStatusView = PlanningDisabled | PlanningMisconfigured | PlanningUnknownCheckout | (PlanningIndexView & { checkouts: PlanningCheckoutEntry<PlanningIndexView>[] });

/** A session's planning view as a row shows it: the scan time when its report is known, or the reason it is not. */
export type PlanningRowState = { state: "known"; scannedAtMs: number } | { state: "unknown"; reason: UnknownViewReason };

export interface PlanningSessionRow {
	sessionId: string;
	worktree: string;
	branch: string;
	lastHeartbeatMs: number;
	ageMs: number | null;
	/** Milliseconds since the last planning change, or null when the server clock could not be read. A live session can be idle for hours and still be `active`: `status` follows its last sign of life, not this. */
	idleForMs: number | null;
	status: SessionStatus | "unknown";
	/** The session's planning view: its scan time when known, or why it is unknown. */
	planning: PlanningRowState;
}

/** One checkout's sessions view: the listing's rows and the conflicts in its view, scoped by `inView`. */
export interface PlanningSessionsOk {
	state: "ok";
	presenceTtlS: number;
	clock: { state: "server" } | { state: "unavailable"; detail: string };
	/** The listing hit its bound: a session beyond it is in no view. */
	truncated: boolean;
	/** The listing's rows in this checkout's view: every row for a single-checkout plane, else the rows heartbeating as its key. */
	sessions: PlanningSessionRow[];
	/** The conflicts in this checkout's view, scoped like the rows. Read-only: the observer announces them. */
	conflicts: PlanningConflict[];
}

export type PlanningSessionsBody =
	| PlanningDisabled
	| PlanningMisconfigured
	| PlanningUnknownCheckout
	| { state: "unavailable"; code: "presence-backend-unset" | "presence-listing-failed"; detail?: string }
	| (PlanningSessionsOk & { checkouts: PlanningCheckoutEntry<PlanningSessionsOk>[] });

/** Every sessions answer carries the session view's state and its line, whatever the body is. */
export type PlanningSessionsView = PlanningSessionsBody & { view: SessionViewState };

export interface PlanningReaderDeps {
	settings: PlanningConfigResult;
	fs: PlanningFs;
	/** Null when the cache endpoint is unset or refused by the endpoint policy. */
	presence: DragonflyPresenceStore | null;
	/** Whether completion checkpoints are durable, from `completionStoreView`. Unset means in memory: not durable. */
	checkpoints?: CompletionStoreView;
}

export type ResolvedSettings = { ready: true; checkouts: readonly PlanningCheckout[]; limits: PlanningLimits } | { ready: false; view: PlanningDisabled | PlanningMisconfigured };

/** The settings a plane runs with, or the typed view that says why it does not run. Shared by the reader and the observer. */
export function resolveSettings(result: PlanningConfigResult): ResolvedSettings {
	if (!result.ok) return { ready: false, view: { state: "misconfigured", errors: result.errors } };
	const settings = result.settings;
	if (!settings.enabled) return { ready: false, view: { state: "disabled", reason: "root-unset" } };
	return {
		ready: true,
		checkouts: settings.checkouts,
		limits: { presenceTtlS: settings.presenceTtlS, maxFiles: settings.maxFiles, maxBytes: settings.maxBytes, scanIntervalMs: settings.scanIntervalMs },
	};
}

/** One checkout's reader: its `.planning/` index, read with the plane's limits. It holds no state between calls. */
class CheckoutReader {
	readonly key: string;
	readonly root: string;

	constructor(
		checkout: PlanningCheckout,
		private readonly limits: PlanningLimits,
		private readonly fs: PlanningFs,
		private readonly checkpoints: CompletionStoreView,
	) {
		this.key = checkout.key;
		this.root = checkout.root;
	}

	async index(): Promise<PlanningIndexView> {
		const built = await buildPlanningIndex(this.root, { fs: this.fs, limits: { maxFiles: this.limits.maxFiles, maxBytes: this.limits.maxBytes } });
		if (!built.ok) return { state: "unavailable", code: built.code };
		const records = indexRecords(built.index);
		return {
			state: "ok",
			limits: this.limits,
			truncated: built.index.truncated,
			counts: countOf(records),
			position: positionOf(built.index),
			documents: records.filter(isFileRecord).map(hashRow),
			errors: records.filter(isErrorRecord).map((record) => ({
				path: record.path,
				...(record.kind === undefined ? {} : { kind: record.kind }),
				sha256: record.sha256,
				bytes: record.bytes,
				code: record.error.code,
				detail: record.error.detail,
			})),
			checkpoints: this.checkpoints,
		};
	}
}

export class PlanningReader {
	private readonly resolved: ResolvedSettings;
	/** One reader per configured checkout, in configuration order. Empty when the plane is off or its settings are refused. */
	private readonly readers: readonly CheckoutReader[];

	constructor(private readonly deps: PlanningReaderDeps) {
		const resolved = resolveSettings(deps.settings);
		const checkpoints: CompletionStoreView = deps.checkpoints ?? { durable: false, reason: "checkpoint-dir-unset" };
		this.resolved = resolved;
		this.readers = resolved.ready ? resolved.checkouts.map((checkout) => new CheckoutReader(checkout, resolved.limits, deps.fs, checkpoints)) : [];
	}

	/** The index of the checkout a call names, with the entries it names: every configured checkout, or the one `checkout` picks. */
	async status(checkout?: string): Promise<PlanningStatusView> {
		const resolved = this.resolved;
		if (!resolved.ready) return resolved.view;
		const selection = this.select(checkout);
		if (!selection.ok) return selection.view;
		const checkouts = await Promise.all(selection.readers.map(async (reader): Promise<PlanningCheckoutEntry<PlanningIndexView>> => ({ key: reader.key, root: reader.root, view: await reader.index() })));
		return { ...topOf(checkouts), checkouts };
	}

	/** The sessions body, with the session view's state beside it: every answer carries one state from the closed set. */
	async sessions(checkout?: string): Promise<PlanningSessionsView> {
		const body = await this.sessionsBody(checkout);
		return { ...body, view: sessionStateOf(body) };
	}

	/** Whether `sessionsForRepo` has anything to read: the plane has a root and a presence store. */
	presenceConfigured(): boolean {
		return resolveSettings(this.deps.settings).ready && this.deps.presence !== null;
	}

	/**
	 * The active presence records of one repository, for the session context digest (phase 67). Read-only, like `sessions`:
	 * no heartbeat, no note. Stale records are left out, and a record that names no repository matches none. Rejects when the
	 * listing or the server clock cannot be read, and the digest turns that into a note: it never guesses a session active.
	 */
	async sessionsForRepo(repo: string): Promise<{ rows: PlanningSessionRow[]; truncated: boolean }> {
		const resolved = resolveSettings(this.deps.settings);
		const presence = this.deps.presence;
		if (!resolved.ready || presence === null) return { rows: [], truncated: false };
		const listing = await presence.listWithin(PRESENCE_MAX_SESSIONS);
		const clock = await readClock(presence);
		if (!clock.ok) throw new Error("the presence server clock could not be read");
		const scope = scopeRepoId(repo);
		const ofRepo = listing.records.filter((record) => scopeRepoId(record.repo) === scope);
		const active = classifySessions(ofRepo, clock.nowMs, resolved.limits.presenceTtlS * 1000).filter((entry) => entry.status === "active");
		return {
			rows: active.map(
				(entry): PlanningSessionRow => ({
					sessionId: entry.sessionId,
					worktree: entry.worktree,
					branch: entry.branch,
					lastHeartbeatMs: entry.lastHeartbeatMs,
					ageMs: entry.ageMs,
					idleForMs: entry.idleForMs,
					status: entry.status,
					planning: planningRowOf(sessionViewOf(entry, clock.nowMs, resolved.limits.presenceTtlS * 1000)),
				}),
			),
			truncated: listing.truncated,
		};
	}

	/** The readers a call names: every configured checkout in configuration order, or the one a key picks. */
	private select(checkout: string | undefined): { ok: true; readers: readonly CheckoutReader[] } | { ok: false; view: PlanningUnknownCheckout } {
		if (checkout === undefined) return { ok: true, readers: this.readers };
		const reader = this.readers.find((candidate) => candidate.key === checkout);
		return reader === undefined ? { ok: false, view: { state: "unavailable", reason: "unknown-checkout" } } : { ok: true, readers: [reader] };
	}

	/**
	 * Whether a listing row or conflict belongs in a checkout's view. A plane with one checkout shows the whole listing, as the
	 * single-root plane did. With several checkouts a row belongs to the checkout it heartbeats as, and a conflict to each checkout
	 * whose session takes part in it.
	 */
	private inView(reader: CheckoutReader, sessionIds: readonly string[]): boolean {
		return this.readers.length === 1 || sessionIds.includes(reader.key);
	}

	private async sessionsBody(checkout: string | undefined): Promise<PlanningSessionsBody> {
		const resolved = this.resolved;
		if (!resolved.ready) return resolved.view;
		const selection = this.select(checkout);
		if (!selection.ok) return selection.view;
		const presence = this.deps.presence;
		if (presence === null) return { state: "unavailable", code: "presence-backend-unset" };
		const presenceTtlS = resolved.limits.presenceTtlS;
		const ttlMs = presenceTtlS * 1000;
		try {
			// One listing and one clock serve every checkout the call names. Each checkout's view takes its rows and conflicts through `inView`.
			const listing = await presence.listWithin(PRESENCE_MAX_SESSIONS);
			const clock = await readClock(presence);
			const checkouts: PlanningCheckoutEntry<PlanningSessionsOk>[] = [];
			if (clock.ok) {
				const classified = classifySessions(listing.records, clock.nowMs, ttlMs);
				const { conflicts } = detectConflicts({ sessions: classified, nowMs: clock.nowMs, ttlMs });
				for (const reader of selection.readers) {
					checkouts.push({
						key: reader.key,
						root: reader.root,
						view: {
							state: "ok",
							presenceTtlS,
							clock: { state: "server" },
							truncated: listing.truncated,
							sessions: classified
								.filter((entry) => this.inView(reader, [entry.sessionId]))
								.map(
									(entry): PlanningSessionRow => ({
										sessionId: entry.sessionId,
										worktree: entry.worktree,
										branch: entry.branch,
										lastHeartbeatMs: entry.lastHeartbeatMs,
										ageMs: entry.ageMs,
										idleForMs: entry.idleForMs,
										status: entry.status,
										planning: planningRowOf(sessionViewOf(entry, clock.nowMs, ttlMs)),
									}),
								),
							conflicts: conflicts.filter((conflict) => this.inView(reader, conflict.sessionIds)),
						},
					});
				}
			} else {
				for (const reader of selection.readers) {
					checkouts.push({
						key: reader.key,
						root: reader.root,
						view: {
							state: "ok",
							presenceTtlS,
							clock: { state: "unavailable", detail: clock.detail },
							truncated: listing.truncated,
							sessions: listing.records
								.filter((record) => this.inView(reader, [record.sessionId]))
								.map(
									(record): PlanningSessionRow => ({
										sessionId: record.sessionId,
										worktree: record.worktree,
										branch: record.branch,
										lastHeartbeatMs: record.lastHeartbeatMs,
										ageMs: null,
										idleForMs: null,
										status: "unknown",
										planning: { state: "unknown", reason: "clock-unavailable" },
									}),
								),
							conflicts: [],
						},
					});
				}
			}
			return { ...topOf(checkouts), checkouts };
		} catch (cause: unknown) {
			return { state: "unavailable", code: "presence-listing-failed", detail: cause instanceof Error ? cause.message : String(cause) };
		}
	}
}

/** The view the top-level fields carry: the first entry's, which is the named checkout or the first configured one. */
function topOf<V>(entries: readonly PlanningCheckoutEntry<V>[]): V {
	const [first] = entries;
	if (first === undefined) throw new Error("the planning plane has no checkout to answer for");
	return first.view;
}

/** The session view's state and line, from what the body knows. Each non-ok body names what is off, or the failure it had. */
function sessionStateOf(body: PlanningSessionsBody): SessionViewState {
	switch (body.state) {
		case "disabled":
			return deriveSessionState({ loaded: true, sessions: [], disabledCapabilities: ["planning"] });
		case "misconfigured":
			return deriveSessionState({ loaded: true, sessions: [], disabledCapabilities: [], error: `invalid planning settings: ${body.errors.map((error) => error.key).join(", ")}` });
		case "unavailable":
			if ("reason" in body) return deriveSessionState({ loaded: true, sessions: [], disabledCapabilities: [], error: body.reason });
			if (body.code === "presence-backend-unset") return deriveSessionState({ loaded: true, sessions: [], disabledCapabilities: ["presence"] });
			return deriveSessionState({ loaded: true, sessions: [], disabledCapabilities: [], error: body.code });
		case "ok": {
			const disabledCapabilities = [...(body.clock.state === "unavailable" ? ["server clock"] : []), ...(body.truncated ? ["sessions beyond the listing bound"] : [])];
			return deriveSessionState({ loaded: true, sessions: body.sessions.map((row) => row.status), disabledCapabilities });
		}
	}
}

function planningRowOf(view: SessionView): PlanningRowState {
	return view.status === "known" ? { state: "known", scannedAtMs: view.scannedAtMs } : { state: "unknown", reason: view.reason };
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
export async function readClock(presence: DragonflyPresenceStore): Promise<{ ok: true; nowMs: number } | { ok: false; detail: string }> {
	try {
		return { ok: true, nowMs: await presence.serverNowMs() };
	} catch (cause: unknown) {
		return { ok: false, detail: cause instanceof Error ? cause.message : String(cause) };
	}
}
