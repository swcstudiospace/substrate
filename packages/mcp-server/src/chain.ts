/**
 * The global ingest chain (Phase 6, D-02): every event, from every surface, is hashed on ingest
 * with `prev` = the hash of the event ingested just before it.
 */
import { canonicalJson, normalizeEvent, rowToEvent } from "./event.ts";
import type { ChainHead, EventKey } from "./greptime.ts";
import type { EventInput, SubstrateEvent } from "./types.ts";

/** The slice of GreptimeClient the chain needs. */
export interface ChainStore {
	chainHead(): Promise<ChainHead | null>;
	insertEvents(events: readonly SubstrateEvent[]): Promise<void>;
	eventsAtKeys(keys: readonly EventKey[]): Promise<Array<Record<string, unknown>>>;
}

export type ChainState = "seeded" | "genesis" | "unknown";

interface Waiter {
	input: EventInput;
	resolve: (event: SubstrateEvent) => void;
	reject: (cause: unknown) => void;
}

/** A batch input that carries a client ts, while the guard finds it a free storage key. */
interface ClientTimed {
	waiter: Waiter;
	draft: SubstrateEvent;
	tsMs: number;
	moves: number;
}

const DEFAULT_MAX_NUDGES = 5;

function keyOf(event: Pick<SubstrateEvent, "surface" | "repo" | "graph_id" | "kind">, tsMs: number): EventKey {
	return { surface: event.surface, repo: event.repo, graph_id: event.graph_id, kind: event.kind, tsMs };
}

function keyId(key: EventKey): string {
	return JSON.stringify([key.surface, key.repo, key.graph_id, key.kind, key.tsMs]);
}

/** Everything a producer said, without the fields ingest assigns (id, ts, hash, prev, ingested_at). */
function content(event: SubstrateEvent): string {
	const { id: _id, ts: _ts, hash: _hash, prev: _prev, ingested_at: _ingestedAt, ...said } = event;
	return canonicalJson(said);
}

/**
 * Serializes emit in-process. One drain loop takes every queued input per turn
 * (`queue.splice(0)`), gives each a strictly increasing `ingested_at` = max(now, head + 1 ms) and
 * `prev` = the head's hash, and writes the whole batch in ONE multi-row INSERT — a Greptime round
 * trip costs ~200 ms, so a burst of hook events rides one insert instead of queueing behind seven.
 *
 * The head lives in memory. It is seeded from Greptime (latest row by ingested_at; none →
 * genesis, prev null). After any failed insert it is unknown — the write may have landed — and
 * the next turn re-seeds from whatever persisted before chaining on.
 *
 * Server-timed inputs get ts := ingested_at, so they never share a storage key. Inputs with a
 * client ts are checked against the stored rows on their exact key (NULL-safe): identical
 * content is a replay and returns the stored event without an insert; different content moves
 * ts by 1 ms and checks again, at most `maxNudges` times, then that one input is rejected.
 *
 * Single writer: only substrate-mcp.service emits with production credentials. A second process
 * emitting into the same Greptime (say, `bun run mcp` with the production env) keeps its own head
 * and forks the chain; the server cannot prevent that, and verify reports the fork.
 */
export class IngestChain {
	private head: ChainHead | "genesis" | "unknown" = "unknown";
	private readonly queue: Waiter[] = [];
	private draining = false;
	/** Tail of the critical section: drain turns and external seeds run one at a time. */
	private critical: Promise<unknown> = Promise.resolve();
	private readonly now: () => number;
	private readonly maxNudges: number;

	constructor(
		private readonly store: ChainStore,
		opts: { now?: () => number; maxNudges?: number } = {},
	) {
		this.now = opts.now ?? Date.now;
		this.maxNudges = opts.maxNudges ?? DEFAULT_MAX_NUDGES;
	}

	state(): ChainState {
		return typeof this.head === "object" ? "seeded" : this.head;
	}

	/** Load the head from the store. Throws (and leaves the state unknown) when the store fails. */
	seed(): Promise<"seeded" | "genesis"> {
		return this.exclusive(() => this.reseed());
	}

	/** Queue one input; resolves with the stored (or, for a replay, the already-stored) event. */
	append(input: EventInput): Promise<SubstrateEvent> {
		const { promise, resolve, reject } = Promise.withResolvers<SubstrateEvent>();
		this.queue.push({ input, resolve, reject });
		if (!this.draining) void this.drain();
		return promise;
	}

	private exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.critical.then(fn);
		this.critical = run.catch(() => undefined);
		return run;
	}

	private async reseed(): Promise<"seeded" | "genesis"> {
		this.head = "unknown";
		const head = await this.store.chainHead();
		this.head = head ?? "genesis";
		return head ? "seeded" : "genesis";
	}

	private async drain(): Promise<void> {
		this.draining = true;
		try {
			while (this.queue.length > 0) {
				await this.exclusive(async () => {
					const batch = this.queue.splice(0);
					try {
						await this.turn(batch);
					} catch (cause) {
						// Not expected (turn settles its own failures): fail the batch closed and re-seed.
						this.head = "unknown";
						for (const waiter of batch) waiter.reject(cause);
					}
				});
			}
		} finally {
			this.draining = false;
		}
	}

	/** One critical-section turn over a whole batch. Settles every waiter; never throws. */
	private async turn(batch: Waiter[]): Promise<void> {
		if (this.head === "unknown") {
			try {
				await this.reseed();
			} catch (cause) {
				for (const waiter of batch) waiter.reject(cause);
				return;
			}
		}

		// Waiters already answered (invalid, replayed or out of moves) before the insert.
		const settled = new Set<Waiter>();
		// Storage keys the batch's client-timed events took, so no two of its events share one.
		const taken = new Set<string>();
		// Final client ts per waiter that carries one (after any moves).
		const clientTs = new Map<Waiter, string>();
		const timed: ClientTimed[] = [];
		for (const waiter of batch) {
			if (!waiter.input?.ts) continue;
			try {
				const draft = normalizeEvent(waiter.input, null);
				timed.push({ waiter, draft, tsMs: Date.parse(draft.ts), moves: 0 });
			} catch (cause) {
				settled.add(waiter);
				waiter.reject(cause);
			}
		}
		try {
			await this.guard(timed, taken, clientTs, settled);
		} catch (cause) {
			// The existence check failed before anything was written: the head is still valid.
			for (const waiter of batch) if (!settled.has(waiter)) waiter.reject(cause);
			return;
		}

		const head = this.head as ChainHead | "genesis";
		let prev = typeof head === "object" ? head.hash : null;
		let lastMs = typeof head === "object" ? head.ingestedAtMs : Number.NEGATIVE_INFINITY;
		const events: Array<{ waiter: Waiter; event: SubstrateEvent; ms: number }> = [];
		for (const waiter of batch) {
			if (settled.has(waiter)) continue;
			const { input } = waiter;
			const ts = clientTs.get(waiter);
			let ms = Math.max(this.now(), lastMs + 1);
			if (ts === undefined && taken.size > 0 && input && typeof input === "object") {
				// Server-timed: ts will equal ingested_at, so step past a key a client ts took in this batch.
				const key = { surface: input.surface, repo: input.repo ?? null, graph_id: input.graph_id ?? null, kind: input.kind };
				while (taken.has(keyId({ ...key, tsMs: ms }))) ms++;
			}
			try {
				const event = normalizeEvent(ts === undefined ? input : { ...input, ts }, prev, new Date(ms).toISOString());
				events.push({ waiter, event, ms });
				prev = event.hash;
				lastMs = ms;
			} catch (cause) {
				waiter.reject(cause);
			}
		}
		if (events.length === 0) return;

		try {
			await this.store.insertEvents(events.map(({ event }) => event));
		} catch (cause) {
			// Ambiguous: the batch may have landed. Re-seed from what persisted before the next batch.
			this.head = "unknown";
			for (const { waiter } of events) waiter.reject(cause);
			return;
		}
		const last = events[events.length - 1]!;
		this.head = { hash: last.event.hash, ingestedAtMs: last.ms };
		for (const { waiter, event } of events) waiter.resolve(event);
	}

	/**
	 * Find every client-timed input a free storage key: one eventsAtKeys per round for the inputs
	 * still moving. Replays resolve here with the stored event; exhausted inputs reject here.
	 */
	private async guard(
		pending: ClientTimed[],
		taken: Set<string>,
		clientTs: Map<Waiter, string>,
		settled: Set<Waiter>,
	): Promise<void> {
		while (pending.length > 0) {
			const rows = await this.store.eventsAtKeys(pending.map((item) => keyOf(item.draft, item.tsMs)));
			const stored = new Map<string, SubstrateEvent>();
			for (const row of rows) {
				const event = rowToEvent(row);
				stored.set(keyId(keyOf(event, Date.parse(event.ts))), event);
			}
			const next: ClientTimed[] = [];
			for (const item of pending) {
				const id = keyId(keyOf(item.draft, item.tsMs));
				const existing = stored.get(id);
				if (existing && !taken.has(id) && content(existing) === content(item.draft)) {
					settled.add(item.waiter);
					item.waiter.resolve(existing);
					continue;
				}
				if (!existing && !taken.has(id)) {
					taken.add(id);
					clientTs.set(item.waiter, new Date(item.tsMs).toISOString());
					continue;
				}
				if (item.moves >= this.maxNudges) {
					settled.add(item.waiter);
					item.waiter.reject(
						new Error(`storage key still taken after moving ts ${this.maxNudges} times; event rejected`),
					);
					continue;
				}
				item.moves++;
				item.tsMs++;
				next.push(item);
			}
			pending = next;
		}
	}
}
