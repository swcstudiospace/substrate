/**
 * The planning plane's reads (phase 52, SOTA-08): `planning_status` and `planning_sessions`.
 *
 * Both are read-only and write nothing, on every call: no presence heartbeat, no ledger note, no file. The reader holds no
 * state between calls. Changes are published, and the checkout heartbeats, from the server's planning observer
 * (`observer.ts`), which runs on a timer and never inside a read.
 *
 * Both are typed. A plane with no root answers `disabled` and never an error; invalid settings answer `misconfigured`
 * with the keys, never the values; a failed index or presence read answers `unavailable` with a code.
 *
 * `planning_status` carries hashes and counts only: no file body and no frontmatter.
 *
 * `planning_sessions` is classified against the server's clock. When that clock cannot be read, sessions are listed as
 * `unknown` and the reason is given. They are not guessed as active. Every sessions answer also carries `view`: the session
 * view's state (`states.ts`, one of six) and its line. A read has no heartbeat, so the view names the server clock and the
 * listing bound, and nothing about the checkout's own writes.
 */
import type { PlanningConfigError, PlanningConfigResult, PlanningLimits } from "./config.ts";
import { buildPlanningIndex, indexRecords, isErrorRecord, type PlanningFileRecord, type PlanningFs, type PlanningIndexFailure, type PlanningKind, type PlanningRecord } from "./index.ts";
import { DragonflyPresenceStore, PRESENCE_MAX_SESSIONS } from "./presence-dragonfly.ts";
import { classifySessions, type SessionRecord, type SessionStatus } from "./presence.ts";
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
}

export type ResolvedSettings = { ready: true; root: string; limits: PlanningLimits } | { ready: false; view: PlanningDisabled | PlanningMisconfigured };

/** The settings a plane runs with, or the typed view that says why it does not run. Shared by the reader and the observer. */
export function resolveSettings(result: PlanningConfigResult): ResolvedSettings {
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
	constructor(private readonly deps: PlanningReaderDeps) {}

	async status(): Promise<PlanningStatusView> {
		const resolved = resolveSettings(this.deps.settings);
		if (!resolved.ready) return resolved.view;
		const { root, limits } = resolved;
		const built = await buildPlanningIndex(root, { fs: this.deps.fs, limits: { maxFiles: limits.maxFiles, maxBytes: limits.maxBytes } });
		if (!built.ok) return { state: "unavailable", code: built.code };
		const records = indexRecords(built.index);
		return {
			state: "ok",
			limits,
			truncated: built.index.truncated,
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
		};
	}

	/** The sessions body, with the session view's state beside it: every answer carries one state from the closed set. */
	async sessions(): Promise<PlanningSessionsView> {
		const body = await this.sessionsBody();
		return { ...body, view: sessionViewOf(body) };
	}

	private async sessionsBody(): Promise<PlanningSessionsBody> {
		const resolved = resolveSettings(this.deps.settings);
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
				: listing.records.map((record: SessionRecord) => ({
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
			const disabledCapabilities = [...(body.clock.state === "unavailable" ? ["server clock"] : []), ...(body.truncated ? ["sessions beyond the listing bound"] : [])];
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
