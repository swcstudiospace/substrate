/**
 * Idempotent steering commands (phase 77): a client key makes a retry of a queue or an acknowledgement apply once.
 *
 * - A keyed queue names its directive from the key ({@link keyedDirectiveId}), so every retry of one key from one surface is
 *   the same directive. The inbox's duplicate check and the audit log's unique key then refuse a second `queued` row. A replay is
 *   recognised by its request fingerprint ({@link queueFingerprint}) against the open directive, or, once the directive is no longer
 *   open, against the durable queued row under the same surface and key (migration 44). No store of its own is needed for it.
 * - An acknowledgement's reply carries the session-state outcome, which a replay must not decide again. So {@link SteeringIdempotency}
 *   keeps the reply of each applied keyed acknowledgement, with the fingerprint it was made for ({@link acknowledgeFingerprint}).
 *   The durable log keeps the same reply (migration 44 keys, migration 45 session result), so a replay after a restart is answered.
 * - Both paths run inside a per-key lane ({@link SteeringIdempotency.serialize}): a concurrent identical retry waits for the first
 *   and then sees its result, instead of racing the inbox and being refused as a duplicate.
 *
 * The reply index and the lanes are process-local, like the inbox. Its bound is {@link STEERING_IDEMPOTENCY_MAX_ENTRIES}: past it
 * the oldest reply is forgotten from memory only. A replay of that key then reads the durable log and is answered from it, never
 * applied twice, and never refused as unknown.
 */
import { canonicalJson, sha256Hex } from "../event.ts";

/** Applied keyed acknowledgements whose reply is kept. Oldest evicted first. */
export const STEERING_IDEMPOTENCY_MAX_ENTRIES = 10_000;

const KEYED_QUEUE_ID_PREFIX = "idem-";

/** The directive id of a keyed queue: stable for one key from one surface, and within the directive id grammar. */
export function keyedDirectiveId(surface: string, key: string): string {
	return `${KEYED_QUEUE_ID_PREFIX}${sha256Hex(`steering.queue.v1\0${surface}\0${key}`)}`;
}

export interface QueueRequestFields {
	action: string;
	priority: string;
	targetSessionId: string;
	/** The redacted body, as the directive stores it. */
	body: string;
	planRef: { phase: string; plan: string } | null;
	conflictsWithActivePlan: boolean;
}

/** What makes two queue requests under one key the same request. The surface is not in it: the key is already scoped by surface. */
export function queueFingerprint(fields: QueueRequestFields): string {
	return sha256Hex(canonicalJson({ v: 1, command: "queue", ...fields }));
}

export interface AcknowledgeRequestFields {
	directiveId: string;
	sessionId: string;
	outcome: string;
	confirmed: boolean;
}

export function acknowledgeFingerprint(fields: AcknowledgeRequestFields): string {
	return sha256Hex(canonicalJson({ v: 1, command: "acknowledge", ...fields }));
}

/** Per-key lane and reply store. A serialized body runs after the previous body for the same key settles. */
export class SteeringIdempotency<R> {
	private readonly lanes = new Map<string, Promise<void>>();
	private readonly replies = new Map<string, { fingerprint: string; reply: R }>();

	constructor(private readonly maxEntries: number = STEERING_IDEMPOTENCY_MAX_ENTRIES) {
		if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new RangeError("maxEntries must be a positive integer");
	}

	/**
	 * Runs `run` once the previous run for this key has settled. The returned promise carries `run`'s own result or failure; the
	 * lane itself never rejects, so one failed run does not wedge the next.
	 */
	serialize<T>(surface: string, key: string, run: () => Promise<T>): Promise<T> {
		const lane = laneKey(surface, key);
		const result = (this.lanes.get(lane) ?? Promise.resolve()).then(run);
		const settled = result.then(
			() => undefined,
			() => undefined,
		);
		this.lanes.set(lane, settled);
		void settled.then(() => {
			if (this.lanes.get(lane) === settled) this.lanes.delete(lane);
		});
		return result;
	}

	/** The stored reply of an applied keyed command, with the fingerprint it was made for. A copy: changing it changes nothing. */
	recall(surface: string, key: string): { fingerprint: string; reply: R } | null {
		const stored = this.replies.get(laneKey(surface, key));
		return stored === undefined ? null : structuredClone(stored);
	}

	/** Keeps the reply of an applied keyed command. Re-keeping a key replaces it; past the bound the oldest entry is evicted. */
	remember(surface: string, key: string, fingerprint: string, reply: R): void {
		const id = laneKey(surface, key);
		this.replies.delete(id);
		this.replies.set(id, structuredClone({ fingerprint, reply }));
		while (this.replies.size > this.maxEntries) {
			const oldest = this.replies.keys().next();
			if (oldest.done) break;
			this.replies.delete(oldest.value);
		}
	}
}

function laneKey(surface: string, key: string): string {
	return `${surface}\0${key}`;
}
