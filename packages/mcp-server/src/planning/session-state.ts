/**
 * The one steering state model (phase 58, success criterion 2).
 *
 * Two mechanisms steer a live session: the `docs_steering_session` state machine (ACTIVE, CONTEXT_REFRESH, PAUSED, RESUMED,
 * `steeringStateTransition` in `event.ts`) and the planning inbox (`steering.ts`, queued directives a session acknowledges).
 * This registry is the place they meet. It holds the live sessions `docs_steering_session` writes, and it implements the
 * {@link SessionStatePort} the acknowledgement path drives, so an applied pause or redirect moves the same session that
 * `docs_steering_session` reads and writes. It adds no second state machine: every move goes through `nextSteeringSession`,
 * so the transition rules are the ones `docs_steering_session` already enforces.
 *
 * Sessions are keyed `${surface}:${session_id}`, as `docs_steering_session` holds them: a session belongs to the surface that
 * wrote it. A directive names only a session id (the inbox knows no surfaces), so the registry also indexes session id to keys.
 * The two id spaces are one when the caller uses the session's own id for both: `SESSION_ID_RE` (`presence.ts`) is the shape a
 * directive's target must have, and `docs_steering_session` accepts any string, so any session id the inbox can target is also
 * one the registry can hold. A session whose id the inbox cannot target simply never receives a directive.
 *
 * Process-local by default: a restart forgets the sessions, and past the cap the oldest is forgotten. With a durable store
 * injected (`SUBSTRATE_STEERING_SESSIONS_TABLE`, phase 67) each write also goes to `steering_sessions` and `loadDurable` reads
 * the newest rows back at boot, inside the TTL and the cap. The memory stays authoritative: a store that fails never fails a
 * steering call, it records one warning note. The ledger keeps every transition as an event. A directive acknowledged for a
 * session the registry does not hold is refused by the port (the acknowledgement stands); the registry cannot seed a session
 * of its own because it does not know the session's repo.
 */
import { nextSteeringSession, steeringSessionPayload, type SteeringSession, type SteeringSessionState } from "../event.ts";
import { redact } from "../redact.ts";
import type { EventInput, Surface } from "../types.ts";
import type { SessionStateName, SessionStatePort, SessionTransitionContext, SessionTransitionResult } from "./steering-delivery.ts";
import { steeringSessionWithoutSecrets, type SteeringSessionsStore } from "./steering-sessions-store.ts";

/** The most sessions held. Past it the oldest is forgotten. */
export const STEERING_SESSION_CAP = 1000;

/** `payload.via` of a transition an acknowledgement drove. A transition `docs_steering_session` made carries no `via`. */
export const STEERING_ACKNOWLEDGE_VIA = "steering_acknowledge";

/** `payload.action` of the warning note a failed durable write records. Registered in `event-sources.ts`. */
export const STEERING_PERSIST_FAILED_ACTION = "steering.persist_failed";

/** The least time between two persistence warnings from one registry, so a store that is down does not write a note per call. */
export const STEERING_PERSIST_WARN_INTERVAL_MS = 60_000;

/** Durable writes queued behind a slow store. Past it a write is skipped and counted as a failure; the memory is unaffected. */
export const STEERING_PERSIST_PENDING_MAX = 256;

/** The default freshness window of a durable load: seven days. */
export const STEERING_SESSION_TTL_MS = 604_800_000;

/** The store key of one session: the surface that holds it and its id. */
export function steeringSessionKey(surface: Surface, sessionId: string): string {
	return `${surface}:${sessionId}`;
}

/**
 * The one non-blocking `docs.steering` note a transition records: the existing steering payload, plus `extra` for a transition
 * an acknowledgement drove. A pause is a `warning`, every other state a `note`.
 */
export function steeringSessionEvent(surface: Surface, session: SteeringSession, previous: SteeringSessionState | undefined, extra: Record<string, unknown> = {}): EventInput {
	return {
		surface,
		kind: session.state === "PAUSED" ? "warning" : "note",
		summary: `docs steering ${previous ?? "none"} -> ${session.state} for ${session.repo_id}`,
		session_id: session.session_id,
		repo: session.repo_id,
		payload: { ...steeringSessionPayload(session, previous), ...extra },
	};
}

/** What the registry holds for one session id: nothing, several surfaces' sessions (no one can be chosen), or exactly one. */
export type SteeringSessionLookup = { status: "none" } | { status: "ambiguous" } | { status: "one"; surface: Surface; session: SteeringSession };

interface Held {
	surface: Surface;
	sessionId: string;
	session: SteeringSession;
}

export interface SteeringSessionRegistryDeps {
	/** Records the note a driven transition makes. A failure never undoes the transition: the registry absorbs it. */
	emit: (event: EventInput) => Promise<unknown>;
	nowMs?: () => number;
	/** Test seam; defaults to {@link STEERING_SESSION_CAP}. */
	cap?: number;
	/** The durable copy (`steering_sessions`). Absent or null keeps the registry process-local, exactly as before. */
	store?: SteeringSessionsStore | null;
	/** How old a stored session may be and still load, in milliseconds. Defaults to {@link STEERING_SESSION_TTL_MS}. */
	ttlMs?: number;
	/** Where a load failure is reported. Omitted, it goes to stderr as the server's other background notes do. */
	report?: (line: string) => void;
}

/** What `loadDurable` did. `failed` is the redacted reason the read or the prune could not finish, or null. */
export interface SteeringSessionsLoadReport {
	loaded: number;
	pruned: number;
	failed: string | null;
}

export class SteeringSessionRegistry implements SessionStatePort {
	private readonly held = new Map<string, Held>();
	/** Session id to the keys that hold it, so a directive (which names no surface) finds its session. */
	private readonly byId = new Map<string, Set<string>>();
	private readonly emit: (event: EventInput) => Promise<unknown>;
	private readonly nowMs: () => number;
	private readonly cap: number;
	private readonly store: SteeringSessionsStore | null;
	private readonly ttlMs: number;
	private readonly report: (line: string) => void;
	/** The tail of the durable write chain: writes reach the store in the order they were made, one at a time. */
	private writeTail: Promise<void> = Promise.resolve();
	private pendingWrites = 0;
	private lastWarnAtMs: number | null = null;

	constructor(deps: SteeringSessionRegistryDeps) {
		this.emit = deps.emit;
		this.nowMs = deps.nowMs ?? (() => Date.now());
		this.cap = deps.cap ?? STEERING_SESSION_CAP;
		this.store = deps.store ?? null;
		this.ttlMs = deps.ttlMs ?? STEERING_SESSION_TTL_MS;
		this.report = deps.report ?? ((line) => void process.stderr.write(`${line}\n`));
	}

	get size(): number {
		return this.held.size;
	}

	get(surface: Surface, sessionId: string): SteeringSession | undefined {
		return this.held.get(steeringSessionKey(surface, sessionId))?.session;
	}

	/**
	 * Stores or replaces one session and makes it the newest. Past the cap the oldest is forgotten. With a durable store the
	 * session is also queued for the table; that write never blocks or fails this call.
	 */
	put(surface: Surface, sessionId: string, session: SteeringSession): void {
		this.hold(surface, sessionId, session);
		this.persist(surface, session);
	}

	/** Every held session, newest write first. A copy: changing the result changes nothing here. */
	entries(): Array<{ surface: Surface; session: SteeringSession }> {
		return [...this.held.values()].reverse().map((held) => ({ surface: held.surface, session: held.session }));
	}

	/**
	 * Reads the durable rows back at boot: the newest `cap` rows updated inside the TTL, adopted oldest first so the newest end
	 * up newest. A session already held (written before the load finished) is kept as it is. Rows past the TTL are pruned
	 * from the table. Never throws: a store that fails is reported and the registry starts with what it holds.
	 */
	async loadDurable(): Promise<SteeringSessionsLoadReport> {
		const store = this.store;
		if (store === null) return { loaded: 0, pruned: 0, failed: null };
		const sinceMs = this.nowMs() - this.ttlMs;
		let loaded = 0;
		let pruned = 0;
		let failed: string | null = null;
		try {
			const rows = await store.loadNewest({ sinceMs, limit: this.cap });
			for (const row of [...rows].reverse()) {
				if (this.held.has(steeringSessionKey(row.surface, row.session.session_id))) continue;
				this.hold(row.surface, row.session.session_id, row.session);
				loaded += 1;
			}
			pruned = await store.prune(sinceMs);
		} catch (cause) {
			failed = redact(cause instanceof Error ? cause.message : String(cause)).slice(0, 200);
			this.report(`[substrate] steering sessions: durable load failed (${failed}); the registry starts with ${this.held.size} session(s) in memory`);
		}
		return { loaded, pruned, failed };
	}

	/** Resolves once every durable write queued so far has settled. Never rejects. */
	async idle(): Promise<void> {
		await this.writeTail;
	}

	private hold(surface: Surface, sessionId: string, session: SteeringSession): void {
		const key = steeringSessionKey(surface, sessionId);
		this.held.delete(key);
		if (this.held.size >= this.cap) {
			const oldest = this.held.keys().next();
			if (!oldest.done) this.forget(oldest.value);
		}
		this.held.set(key, { surface, sessionId, session });
		const keys = this.byId.get(sessionId) ?? new Set<string>();
		keys.add(key);
		this.byId.set(sessionId, keys);
	}

	private persist(surface: Surface, session: SteeringSession): void {
		const store = this.store;
		if (store === null) return;
		if (this.pendingWrites >= STEERING_PERSIST_PENDING_MAX) {
			this.warnPersistFailed(surface, session.session_id, "the durable write queue is full");
			return;
		}
		this.pendingWrites += 1;
		this.writeTail = this.writeTail
			.then(() => store.save(surface, steeringSessionWithoutSecrets(session)))
			.catch((cause: unknown) => {
				this.warnPersistFailed(surface, session.session_id, cause instanceof Error ? cause.message : String(cause));
			})
			.finally(() => {
				this.pendingWrites -= 1;
			});
	}

	/** One warning note per interval, never an error: the session is held in memory whatever the table did. */
	private warnPersistFailed(surface: Surface, sessionId: string, reason: string): void {
		const nowMs = this.nowMs();
		if (this.lastWarnAtMs !== null && nowMs - this.lastWarnAtMs < STEERING_PERSIST_WARN_INTERVAL_MS) return;
		this.lastWarnAtMs = nowMs;
		const cut = redact(reason).slice(0, 200);
		const warning: EventInput = {
			surface,
			kind: "warning",
			summary: `steering session ${redact(sessionId).slice(0, 80)} was not saved to steering_sessions: ${cut}`,
			session_id: sessionId,
			payload: { action: STEERING_PERSIST_FAILED_ACTION, reason: cut },
		};
		// Started inside an async function so a synchronous throw from `emit` is a rejection like any other.
		void (async () => {
			await this.emit(warning);
		})().catch(() => {
			// A note the ledger cannot take adds nothing to a write that already failed; the memory still holds the session.
		});
	}

	/** The session an id names, across surfaces. A read: it changes nothing. */
	lookup(sessionId: string): SteeringSessionLookup {
		const keys = this.byId.get(sessionId);
		if (keys === undefined || keys.size === 0) return { status: "none" };
		if (keys.size > 1) return { status: "ambiguous" };
		const [key] = keys;
		const held = key === undefined ? undefined : this.held.get(key);
		return held === undefined ? { status: "none" } : { status: "one", surface: held.surface, session: held.session };
	}

	/**
	 * Moves the session a directive targets to `target`, by the state machine's own rules, and reports whether the state moved
	 * (`changed`). A move records one `docs.steering` note that names the directive. A request for the state the session already
	 * holds is allowed by the rules but is no transition: it returns `changed: false`, stores nothing and records no note (the
	 * acknowledgement itself is audited by the steering audit). A session the registry does not hold, a session id two surfaces
	 * hold, and a transition the rules refuse are all refused and change nothing. `sessionKey` is the directive's target session id.
	 */
	async applyTransition(sessionKey: string, target: SessionStateName, context: SessionTransitionContext): Promise<SessionTransitionResult> {
		const found = this.lookup(sessionKey);
		if (found.status === "none") return { ok: false, reason: "session not registered" };
		if (found.status === "ambiguous") return { ok: false, reason: "ambiguous" };
		const { surface, session } = found;
		const next = nextSteeringSession(
			session,
			{
				session_id: session.session_id,
				repo_id: session.repo_id,
				state: target,
				...(session.planning_hash !== undefined ? { planning_hash: session.planning_hash } : {}),
				...(session.steering !== undefined ? { steering: session.steering } : {}),
			},
			this.nowMs(),
		);
		if (!next.ok) return { ok: false, reason: next.reason };
		if (session.state === target) return { ok: true, changed: false };
		this.put(surface, session.session_id, next.session);
		try {
			await this.emit(steeringSessionEvent(surface, next.session, next.previous, { directive_id: context.directiveId, via: STEERING_ACKNOWLEDGE_VIA }));
		} catch {
			// The transition is stored and the acknowledgement is audited; a note the ledger cannot take is not a refusal.
		}
		return { ok: true, changed: true };
	}

	private forget(key: string): void {
		const held = this.held.get(key);
		this.held.delete(key);
		if (held === undefined) return;
		const keys = this.byId.get(held.sessionId);
		if (keys === undefined) return;
		keys.delete(key);
		if (keys.size === 0) this.byId.delete(held.sessionId);
	}
}
