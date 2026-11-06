/**
 * Session presence for the planning plane (phase 52, SOTA-08; phase 58, liveness).
 *
 * A session is "active" while its last sign of life is within the TTL and "stale" after it. A sign of life is a change
 * heartbeat (`lastHeartbeatMs`: planning documents changed) or a liveness write (`livenessMs`: the observer scanned the
 * checkout and it was there), so a session that thinks for hours without touching a planning document stays active while
 * its observer runs, and `idleForMs` reports how long it has been quiet. Staleness is derived, never stored as a state:
 * `classifySessions` is pure and never removes a record, and no store in this module deletes one. History is append-only.
 * Nothing here truncates it.
 *
 * Ports: `PresenceStore` (where heartbeats live), `HistorySink` (the append-only log, TimescaleDB in
 * production), and `PresenceClock` (the backend's own clock). Production adapters live beside this
 * module; the Dragonfly adapter is in `presence-dragonfly.ts`.
 */
import { z } from "zod";

/** The shape a session id takes. It is also the Redis key suffix, so it is restricted. */
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Why a session's planning view cannot be trusted for conflicts (phase 53, D53-h). */
const UNKNOWN_VIEW_REASONS = [
	"no-scan",
	"scan-failed",
	"scan-truncated",
	"scan-unlisted",
	"scan-has-errors",
	"scan-stale",
	"report-limit",
	"clock-unavailable",
] as const;
export type UnknownViewReason = (typeof UNKNOWN_VIEW_REASONS)[number];

/** Most entries (phases and plan ids together) one planning report carries. A larger index is reported as `report-limit`. */
export const MAX_REPORT_ENTRIES = 512;

/** The longest phase or plan id a planning report or a touched pair carries. */
export const REPORT_ID_MAX = 128;
const REPORT_ID = z.string().min(1).max(REPORT_ID_MAX);

const PhaseReportSchema = z.object({ phase: REPORT_ID, plans: z.array(REPORT_ID).max(MAX_REPORT_ENTRIES) }).strict();
export type PhaseReport = z.infer<typeof PhaseReportSchema>;

/**
 * A session's planning report: what its own checkout's index says. It rides in the session's presence record and is
 * rewritten by that checkout's reads. `known` lists the phases the index holds, with the plan ids under each. `unknown`
 * gives the reason. Every other reader judges the report against its own clock: an older report is stale.
 */
const PlanningReportSchema = z.discriminatedUnion("status", [
	z
		.object({ status: z.literal("known"), scannedAtMs: z.number().int().nonnegative(), phases: z.array(PhaseReportSchema).max(MAX_REPORT_ENTRIES) })
		.strict(),
	z.object({ status: z.literal("unknown"), scannedAtMs: z.number().int().nonnegative(), reason: z.enum(UNKNOWN_VIEW_REASONS) }).strict(),
]);
export type PlanningReport = z.infer<typeof PlanningReportSchema>;

/**
 * A planning change this checkout made (phase 53, SOTA-09): the phase it touched and the plan it named, or null for a document
 * that names none. `observedAtMs` is the server's time of the complete observation that saw it. A pair counts only while it is
 * inside the presence TTL (`touchedWithin`).
 */
const TouchedPairSchema = z.object({ phase: REPORT_ID, plan: REPORT_ID.nullable(), observedAtMs: z.number().int().nonnegative() }).strict();
export type TouchedPair = z.infer<typeof TouchedPairSchema>;

/** A repository's identity, `owner/name`. Two checkouts take part in one conflict only when they name the same repository. */
const REPO_ID = z
	.string()
	.max(256)
	.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);

export const SessionRecordSchema = z.object({
	sessionId: z.string().regex(SESSION_ID_RE),
	worktree: z.string().min(1).max(1024),
	branch: z.string().min(1).max(256),
	/**
	 * The server time of the last change heartbeat: the last time the checkout's planning documents changed. It keeps this
	 * meaning; a liveness write does not move it.
	 */
	lastHeartbeatMs: z.number().int().nonnegative(),
	/**
	 * The server time of the last liveness write: the observer's scan proved the checkout alive, whether or not anything changed.
	 * Optional on the wire: a record without it is read as before, with the change heartbeat as its liveness. A change
	 * heartbeat does not write it, since its own time is then the liveness.
	 */
	livenessMs: z.number().int().nonnegative().optional(),
	planning: PlanningReportSchema.optional(),
	repo: REPO_ID.nullable().optional(),
	touched: z.array(TouchedPairSchema).max(MAX_REPORT_ENTRIES).optional(),
	// Older readers require this field and reject a record without it, so writers keep emitting null. This reader accepts an absent field, null, or a phase string.
	activePhase: z.string().min(1).max(64).nullable().optional(),
});

export type SessionRecord = z.infer<typeof SessionRecordSchema>;

export type SessionStatus = "active" | "stale";

export interface ClassifiedSession extends SessionRecord {
	status: SessionStatus;
	/** Milliseconds since the session's last sign of life (`livenessOf`). `status` is judged against it. */
	ageMs: number;
}

/** A classified session with the time since its last planning change. `classifySessions` always returns it. */
interface LiveClassifiedSession extends ClassifiedSession {
	/** Milliseconds since the last planning change (`lastHeartbeatMs`). Not what makes a session stale: a live session can be idle for days. */
	idleForMs: number;
}

/** The presence port. `touch` records a heartbeat; `list` returns every record the backend still holds. */
export interface PresenceStore {
	/** `ttlMs` is the freshness window: the age past which a heartbeat is stale. The Dragonfly adapter keeps a record for a longer retention and reads the server's clock. */
	touch(record: SessionRecord, ttlMs: number): Promise<void>;
	/** Every record held, stale or not, sorted by session id. Never filtered by age. */
	list(): Promise<SessionRecord[]>;
}

/** Append-only. There is deliberately no method to remove or replace an entry. */
interface HistorySink {
	append(record: SessionRecord): Promise<void>;
}

/**
 * The backend's own clock. Presence ages are read against it, never against the host clock.
 * The Dragonfly adapter reads it through the server's TIME command (`DragonflyPresenceStore.serverNowMs`).
 */
export interface PresenceClock {
	serverNowMs(): number;
}

/**
 * Classify each record against `nowMs`. A session is alive at the later of its last change heartbeat and its liveness time
 * (`livenessMs`; an old record has none, so its change heartbeat is its liveness). It is stale when that age is strictly
 * greater than `ttlMs`, so a sign of life exactly `ttlMs` old is still active. A sign of life ahead of `nowMs` (clock skew)
 * has a negative age and is active. `ageMs` is the age of the last sign of life; `idleForMs` is the time since the last
 * planning change, which a session that is alive but quiet can hold far past the TTL. The input is not modified, and nothing
 * is removed.
 */
export function classifySessions(records: readonly SessionRecord[], nowMs: number, ttlMs: number): LiveClassifiedSession[] {
	assertTtlMs(ttlMs);
	return records
		.map((record): LiveClassifiedSession => {
			const ageMs = nowMs - livenessOf(record);
			const idleForMs = nowMs - record.lastHeartbeatMs;
			return { ...record, ageMs, idleForMs, status: ageMs > ttlMs ? "stale" : "active" };
		})
		.sort((a, b) => compareText(a.sessionId, b.sessionId));
}

/** The server time of a session's last sign of life: its liveness time, or its change heartbeat when the record carries none or an older one. */
export function livenessOf(record: Pick<SessionRecord, "lastHeartbeatMs" | "livenessMs">): number {
	return Math.max(record.lastHeartbeatMs, record.livenessMs ?? 0);
}

/**
 * The touched pairs still inside the freshness window. A pair observed exactly `ttlMs` ago still counts, as a heartbeat exactly
 * `ttlMs` old is still active. A pair ahead of `nowMs` (clock skew) counts. The input is not modified.
 */
export function touchedWithin(pairs: readonly TouchedPair[], nowMs: number, ttlMs: number): TouchedPair[] {
	assertTtlMs(ttlMs);
	return pairs.filter((pair) => nowMs - pair.observedAtMs <= ttlMs);
}

/** Every record the store holds, classified against the clock's own time. */
export async function presenceSnapshot(
	deps: { store: PresenceStore; clock: PresenceClock },
	ttlMs: number,
): Promise<ClassifiedSession[]> {
	return classifySessions(await deps.store.list(), deps.clock.serverNowMs(), ttlMs);
}

/** Record a heartbeat, then append it to history. History is written only after the touch succeeds. */
export async function recordHeartbeat(
	deps: { store: PresenceStore; history: HistorySink },
	record: SessionRecord,
	ttlMs: number,
): Promise<void> {
	assertTtlMs(ttlMs);
	const valid = SessionRecordSchema.parse(record);
	await deps.store.touch(valid, ttlMs);
	await deps.history.append(valid);
}

/** A process-local store for tests and for reference. It keeps every heartbeat and never expires one. */
export class InMemoryPresenceStore implements PresenceStore {
	private readonly records = new Map<string, SessionRecord>();

	async touch(record: SessionRecord, ttlMs: number): Promise<void> {
		assertTtlMs(ttlMs);
		const valid = SessionRecordSchema.parse(record);
		this.records.set(valid.sessionId, valid);
	}

	async list(): Promise<SessionRecord[]> {
		return [...this.records.values()].map(copy).sort((a, b) => compareText(a.sessionId, b.sessionId));
	}
}

/** A process-local history for tests and for reference. It only grows. */
export class InMemoryHistorySink implements HistorySink {
	private readonly rows: SessionRecord[] = [];

	async append(record: SessionRecord): Promise<void> {
		this.rows.push(copy(SessionRecordSchema.parse(record)));
	}

	entries(): SessionRecord[] {
		return this.rows.map(copy);
	}
}

function assertTtlMs(ttlMs: number): void {
	if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError("ttlMs must be a positive number");
}

function copy(record: SessionRecord): SessionRecord {
	return { ...record };
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
