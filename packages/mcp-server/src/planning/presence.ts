/**
 * Session presence for the planning plane (phase 52, SOTA-08).
 *
 * A session is "active" while its last heartbeat is within the TTL and "stale" after it. Staleness
 * is derived, never stored as a state: `classifySessions` is pure and never removes a record, and
 * no store in this module deletes one. History is append-only. Nothing here truncates it.
 *
 * Ports: `PresenceStore` (where heartbeats live), `HistorySink` (the append-only log, TimescaleDB in
 * production), and `PresenceClock` (the backend's own clock). Production adapters live beside this
 * module; the Dragonfly adapter is in `presence-dragonfly.ts`.
 */
import { z } from "zod";

/** The shape a session id takes. It is also the Redis key suffix, so it is restricted. */
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const SessionRecordSchema = z.object({
	sessionId: z.string().regex(SESSION_ID_RE),
	worktree: z.string().min(1).max(1024),
	branch: z.string().min(1).max(256),
	activePhase: z.string().min(1).max(64).nullable(),
	lastHeartbeatMs: z.number().int().nonnegative(),
});

export type SessionRecord = z.infer<typeof SessionRecordSchema>;

export type SessionStatus = "active" | "stale";

export interface ClassifiedSession extends SessionRecord {
	status: SessionStatus;
	ageMs: number;
}

/** The presence port. `touch` records a heartbeat; `list` returns every record the backend still holds. */
export interface PresenceStore {
	/** `ttlMs` is the freshness window: the age past which a heartbeat is stale. The Dragonfly adapter keeps a record for a longer retention and reads the server's clock. */
	touch(record: SessionRecord, ttlMs: number): Promise<void>;
	/** Every record held, stale or not, sorted by session id. Never filtered by age. */
	list(): Promise<SessionRecord[]>;
}

/** Append-only. There is deliberately no method to remove or replace an entry. */
export interface HistorySink {
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
 * Classify each record against `nowMs`. A record is stale when its age is strictly greater than
 * `ttlMs`, so a heartbeat exactly `ttlMs` old is still active. A heartbeat ahead of `nowMs`
 * (clock skew) has a negative age and is active. The input is not modified, and nothing is removed.
 */
export function classifySessions(records: readonly SessionRecord[], nowMs: number, ttlMs: number): ClassifiedSession[] {
	assertTtlMs(ttlMs);
	return records
		.map((record): ClassifiedSession => {
			const ageMs = nowMs - record.lastHeartbeatMs;
			return { ...record, ageMs, status: ageMs > ttlMs ? "stale" : "active" };
		})
		.sort((a, b) => compareText(a.sessionId, b.sessionId));
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
