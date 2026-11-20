/**
 * The long-poll registry behind `GET /steering/wait` (phase 67, live steering GA).
 *
 * A session that wants to hear about a directive without polling `docs_search` holds one request open here. The registry is
 * in process, like the inbox it reads: a waiter is a closure over a `check` that asks the inbox for the next queued directive,
 * and a queue for that session calls {@link SteeringWaiters.notify}, which re-runs each waiter's check. It adds no second
 * inbox, no table and no event: the directive is read from the inbox, the one place that holds it.
 *
 * Bounds and cleanup, because a held request is a held socket:
 * - at most {@link STEERING_WAIT_PER_SESSION_MAX} waiters per session and {@link STEERING_WAIT_TOTAL_MAX} overall; a request past
 *   either is answered `busy` at once, never queued;
 * - every waiter leaves the registry exactly once, whichever way it ends: a directive, the timeout, the client's abort signal,
 *   per-session cancellation or `closeAll` at shutdown. Its timer and abort listener are removed on every path;
 * - a directive queued before the call is returned at once. These are wake hints, not authorization: the service checks
 *   durable live-session authority before holding a request and again before releasing any result.
 */
import type { SteeringInbox, SteeringRecord } from "./steering.ts";

/** Waiters one session may hold at once. */
export const STEERING_WAIT_PER_SESSION_MAX = 4;
/** Waiters the whole process may hold at once. */
export const STEERING_WAIT_TOTAL_MAX = 256;

/** A queued record: the shape a waiter is woken with. */
export type QueuedSteeringRecord = Extract<SteeringRecord, { state: "queued" }>;

/** A queued directive with its delivery sequence in its target session: what a wait hands back. */
export interface QueuedDelivery {
	sequence: number;
	record: QueuedSteeringRecord;
}

/** How a wait ended. `busy` and `closed` are the registry's own answers; the rest are the caller's story. */
export type SteeringWaitResult =
	| { status: "directive"; record: QueuedSteeringRecord; sequence: number }
	| { status: "timeout" }
	| { status: "aborted" }
	| { status: "closed" }
	| { status: "busy"; scope: "session" | "total" };

/** The timer seam. Production uses the global timer, unref'd; a test injects its own so no real sleep happens. */
export interface SteeringWaitTimers {
	set(run: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

const GLOBAL_TIMERS: SteeringWaitTimers = {
	set: (run, ms) => {
		const handle = setTimeout(run, ms);
		handle.unref();
		return handle;
	},
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * The next queued directive for `sessionId` after the directive `after` names, in the order directives entered the inbox, or
 * null. `after` is a cursor over the inbox's delivery sequence, not over timestamps: a clock that steps back or two directives
 * in one millisecond cannot sort a later directive before the last delivered one. A directive the inbox does not hold (a
 * restart forgot it, or it was never one) filters nothing, so the caller sees every queued directive rather than none and
 * dedupes by id. A read: it changes nothing in the inbox.
 */
export function nextQueuedDirective(inbox: SteeringInbox, sessionId: string, after: string | null): QueuedDelivery | null {
	const queued = inbox.queuedFor(sessionId);
	const cursor = after === null ? null : inbox.sequenceOf(after);
	if (cursor === null) return queued[0] ?? null;
	return queued.find((entry) => entry.sequence > cursor) ?? null;
}

interface Waiter {
	check: () => QueuedDelivery | null;
	finish: (result: SteeringWaitResult) => void;
}

export interface SteeringWaitersDeps {
	timers?: SteeringWaitTimers;
	/** Test seams; default to {@link STEERING_WAIT_PER_SESSION_MAX} and {@link STEERING_WAIT_TOTAL_MAX}. */
	perSessionMax?: number;
	totalMax?: number;
}

export interface SteeringWaitRequest {
	sessionId: string;
	timeoutMs: number;
	/** The caller's abort: when it fires the waiter ends `aborted` and leaves no timer or listener behind. */
	signal?: AbortSignal;
	/** Asks the inbox for the next directive for this wait. Called once up front and again on every notify for the session. */
	check: () => QueuedDelivery | null;
}

export class SteeringWaiters {
	private readonly bySession = new Map<string, Set<Waiter>>();
	private readonly timers: SteeringWaitTimers;
	private readonly perSessionMax: number;
	private readonly totalMax: number;
	private total = 0;
	private closed = false;

	constructor(deps: SteeringWaitersDeps = {}) {
		this.timers = deps.timers ?? GLOBAL_TIMERS;
		this.perSessionMax = deps.perSessionMax ?? STEERING_WAIT_PER_SESSION_MAX;
		this.totalMax = deps.totalMax ?? STEERING_WAIT_TOTAL_MAX;
	}

	/** Waiters held right now, across sessions. */
	get size(): number {
		return this.total;
	}

	/** Holds the request until a directive is queued for the session, the timeout passes, the signal aborts or the registry closes. */
	wait(request: SteeringWaitRequest): Promise<SteeringWaitResult> {
		if (this.closed) return Promise.resolve({ status: "closed" });
		if (request.signal?.aborted === true) return Promise.resolve({ status: "aborted" });
		let ready: QueuedDelivery | null;
		try {
			ready = request.check();
		} catch {
			return Promise.resolve({ status: "closed" });
		}
		if (this.closed) return Promise.resolve({ status: "closed" });
		if (request.signal?.aborted) return Promise.resolve({ status: "aborted" });
		if (ready !== null) return Promise.resolve({ status: "directive", record: ready.record, sequence: ready.sequence });
		const held = this.bySession.get(request.sessionId) ?? new Set<Waiter>();
		if (held.size >= this.perSessionMax) return Promise.resolve({ status: "busy", scope: "session" });
		if (this.total >= this.totalMax) return Promise.resolve({ status: "busy", scope: "total" });
		const { promise, resolve } = Promise.withResolvers<SteeringWaitResult>();
		let done = false;
		let timer: unknown;
		let timerSet = false;
		const finish = (result: SteeringWaitResult): void => {
			if (done) return;
			done = true;
			request.signal?.removeEventListener("abort", onAbort);
			held.delete(waiter);
			if (held.size === 0 && this.bySession.get(request.sessionId) === held) this.bySession.delete(request.sessionId);
			this.total -= 1;
			// Cleared last: a timer observer runs synchronously here, and must already see this waiter gone from `size`.
			if (timerSet) this.timers.clear(timer);
			resolve(result);
		};
		const onAbort = (): void => finish({ status: "aborted" });
		const waiter: Waiter = { check: request.check, finish };
		held.add(waiter);
		this.bySession.set(request.sessionId, held);
		this.total += 1;
		request.signal?.addEventListener("abort", onAbort, { once: true });
		// Abort may have happened during the initial check, before the listener was installed.
		if (request.signal?.aborted) onAbort();
		if (!done) {
			try {
				const handle = this.timers.set(() => finish({ status: "timeout" }), request.timeoutMs);
				// A synchronous test timer may have settled the waiter before returning its handle.
				if (done) this.timers.clear(handle);
				else {
					timer = handle;
					timerSet = true;
				}
			} catch {
				finish({ status: "closed" });
			}
		}
		return promise;
	}

	/** Wakes the waiters of one session whose check now finds a directive. Waiters whose check finds none keep waiting. */
	notify(sessionId: string): void {
		const held = this.bySession.get(sessionId);
		if (held === undefined) return;
		for (const waiter of [...held]) {
			let found: QueuedDelivery | null;
			try {
				found = waiter.check();
			} catch {
				// A check that throws cannot be trusted to find anything later either: end this wait rather than hold the socket.
				waiter.finish({ status: "closed" });
				continue;
			}
			if (found !== null) waiter.finish({ status: "directive", record: found.record, sequence: found.sequence });
		}
	}

	/** Cancels this session's local waits without closing the registry or changing durable authority. */
	closeSession(sessionId: string): number {
		const held = this.bySession.get(sessionId);
		if (held === undefined) return 0;
		const count = held.size;
		for (const waiter of [...held]) waiter.finish({ status: "closed" });
		return count;
	}

	/** Ends every waiter as `closed` and refuses new ones. For shutdown: no request outlives the server. */
	closeAll(): void {
		this.closed = true;
		for (const sessionId of [...this.bySession.keys()]) this.closeSession(sessionId);
	}
}
