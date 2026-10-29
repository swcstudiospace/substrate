/**
 * The durable copy of the live steering session registry (phase 67, live steering GA).
 *
 * `SteeringSessionRegistry` (`session-state.ts`) holds the sessions `docs_steering_session` writes in process memory. With
 * `SUBSTRATE_STEERING_SESSIONS_TABLE` on, every write is also upserted to `steering_sessions` (migration step 35, opt-in like
 * `planning_steering_audit`), and the registry reads the newest rows back at boot. This module is the port the registry
 * talks to and the Postgres adapter behind it; it holds no state, reads no environment and starts no timer.
 *
 * The table is a restart cache of in-process state, not a record: the ledger keeps every transition as an event. So the
 * upsert is last-writer-wins on `(surface, session_id)`, and no request ever reads it. The only delete is the boot prune of
 * rows older than the TTL, which the load would skip anyway.
 */
import type { SQL } from "bun";
import { STEERING_STATES, type SteeringSession, type SteeringSessionState } from "../event.ts";
import { SURFACES, type Surface } from "../types.ts";

/** One stored session, as the registry holds it: the surface that owns it and the session itself. */
export interface StoredSteeringSession {
	surface: Surface;
	session: SteeringSession;
}

/** What the registry loads at boot: rows updated at or after `sinceMs`, newest first, at most `limit`. */
export interface SteeringSessionsLoadQuery {
	sinceMs: number;
	limit: number;
}

/** The port the registry writes through and loads from. The Bun adapter is {@link bunSteeringSessionsStore}; tests inject a fake. */
export interface SteeringSessionsStore {
	/** Upserts one session. Rejects with the driver's error. */
	save(surface: Surface, session: SteeringSession): Promise<void>;
	/** The newest rows inside the query, newest first. A row this build cannot read is skipped, never thrown. */
	loadNewest(query: SteeringSessionsLoadQuery): Promise<StoredSteeringSession[]>;
	/** Deletes the rows last updated before `beforeMs` and resolves how many went. Rejects with the driver's error. */
	prune(beforeMs: number): Promise<number>;
}

function isSurface(value: string): value is Surface {
	return (SURFACES as readonly string[]).includes(value);
}

function isState(value: string): value is SteeringSessionState {
	return (STEERING_STATES as readonly string[]).includes(value);
}

/**
 * A stored row as a session, or null when the row does not parse: a surface or state this build does not know (a newer release
 * wrote it), or a timestamp that is not a date. Such a row is left in the table and left out of the registry.
 */
export function storedSessionOf(row: Record<string, unknown>): StoredSteeringSession | null {
	const surface = String(row.surface);
	const state = String(row.state);
	const updated = new Date(row.updated_at as string | number | Date);
	if (!isSurface(surface) || !isState(state) || Number.isNaN(updated.getTime())) return null;
	const steering = row.steering;
	const planningHash = row.planning_hash;
	return {
		surface,
		session: {
			session_id: String(row.session_id),
			repo_id: String(row.repo_id),
			state,
			...(typeof planningHash === "string" ? { planning_hash: planningHash } : {}),
			...(typeof steering === "string" ? { steering } : {}),
			updated_at: updated.toISOString(),
		},
	};
}

/** The Postgres adapter over a Bun SQL pool. The table exists only when the `steering-sessions` opt-in ran its migration step. */
export function bunSteeringSessionsStore(sql: SQL): SteeringSessionsStore {
	return {
		async save(surface: Surface, session: SteeringSession): Promise<void> {
			await sql`
				insert into steering_sessions (surface, session_id, repo_id, state, steering, planning_hash, updated_at)
				values (${surface}, ${session.session_id}, ${session.repo_id}, ${session.state}, ${session.steering ?? null}, ${session.planning_hash ?? null}, ${session.updated_at})
				on conflict (surface, session_id) do update set
					repo_id = excluded.repo_id,
					state = excluded.state,
					steering = excluded.steering,
					planning_hash = excluded.planning_hash,
					updated_at = excluded.updated_at`;
		},
		async loadNewest(query: SteeringSessionsLoadQuery): Promise<StoredSteeringSession[]> {
			const rows: Array<Record<string, unknown>> = await sql`
				select surface, session_id, repo_id, state, steering, planning_hash, updated_at
				from steering_sessions
				where updated_at >= ${new Date(query.sinceMs).toISOString()}
				order by updated_at desc, surface asc, session_id asc
				limit ${query.limit}`;
			return rows.flatMap((row) => {
				const stored = storedSessionOf(row);
				return stored === null ? [] : [stored];
			});
		},
		async prune(beforeMs: number): Promise<number> {
			const removed: Array<Record<string, unknown>> = await sql`
				delete from steering_sessions where updated_at < ${new Date(beforeMs).toISOString()} returning session_id`;
			return removed.length;
		},
	};
}
