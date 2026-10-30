/**
 * Retrieval telemetry (v1.7 phase 66, REFLECT-01): one bounded, redacted row per `docs_search`, appended after the answer is
 * built and never on the way to it.
 *
 * What a row holds is deliberately small: the sha256 of the normalised query (the key the gap report aggregates on), the
 * query text only when the redactor found nothing in it and cut to {@link RETRIEVAL_QUERY_TEXT_CHARS}, at most ten returned
 * document keys with their scores, the backend and the caller's surface. No snippet and no citation text is ever stored.
 *
 * The write is fail-open and bounded: {@link RetrievalRecorder.record} returns at once, the write runs under a time budget, at
 * most {@link MAX_PENDING_WRITES} writes are in flight (a slow database drops rows, it never queues without bound), and every
 * outcome is counted. A failed or dropped write is logged once per {@link LOG_EVERY} failures, never per search.
 */
import { createHash } from "node:crypto";
import type { SearchReply } from "../docs-search.ts";
import { redact } from "../redact.ts";
import { corpusKeyOf, type ShadowNote } from "./rank.ts";
import {
	RETRIEVAL_KEY_CHARS,
	RETRIEVAL_MAX_RETURNED,
	RETRIEVAL_QUERY_TEXT_CHARS,
	type ReflectStore,
	type RetrievalRow,
	type RetrievedDocument,
} from "./reflect-store.ts";

/** How long one telemetry write may take before it is given up, ms. */
export const TELEMETRY_WRITE_BUDGET_MS = 2000;
/** The most telemetry writes in flight at once; a write past it is dropped and counted. */
export const MAX_PENDING_WRITES = 50;
/** A failure is logged on the first and on every this-many-th after. */
export const LOG_EVERY = 100;
/** How often the retention sweep runs, ms: once at boot and then once an hour. */
export const RETRIEVAL_SWEEP_INTERVAL_MS = 3_600_000;
/** The most batches one sweep deletes before it leaves the rest for the next hour. */
export const SWEEP_MAX_BATCHES = 50;
/** The most wall time one sweep spends deleting, ms; a batch already running is let finish, so it can run a little over. */
export const SWEEP_BUDGET_MS = 2000;

/** Trim, lower-case and collapse every run of whitespace: two spellings of one question share a hash. */
export function normalizeQuery(query: string): string {
	return query.trim().replace(/\s+/g, " ").toLowerCase();
}

/** sha256 of the normalised query, lowercase hex. */
export function queryHash(query: string): string {
	return createHash("sha256").update(normalizeQuery(query), "utf8").digest("hex");
}

/** The first `max` UTF-16 units of `text`, never ending on half of a surrogate pair. */
function cutWell(text: string, max: number): string {
	const cut = text.slice(0, max);
	const last = cut.charCodeAt(cut.length - 1);
	return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * The query text a row keeps: the query cut to {@link RETRIEVAL_QUERY_TEXT_CHARS}, or null when the redactor would change the
 * whole query or the kept part (a secret in the question is never stored, not even masked).
 */
export function queryTextOf(query: string): string | null {
	const kept = cutWell(query.trim().replace(/\s+/g, " "), RETRIEVAL_QUERY_TEXT_CHARS);
	if (kept.length === 0) return null;
	return redact(query) !== query || redact(kept) !== kept ? null : kept;
}

/** The at most ten `{key, score}` entries of an answer's citations, in the order the answer gave them. */
export function returnedOf(reply: Pick<SearchReply, "chunks">): RetrievedDocument[] {
	return reply.chunks.slice(0, RETRIEVAL_MAX_RETURNED).map((citation) => ({
		key: (corpusKeyOf(citation) ?? citation.source_url).slice(0, RETRIEVAL_KEY_CHARS),
		score: Number.isFinite(citation.score) ? citation.score : 0,
	}));
}

export interface RetrievalInput {
	surface: string;
	/** The question as the caller asked it. */
	question: string;
	backend: string;
	reply: Pick<SearchReply, "chunks" | "degraded">;
	shadow: ShadowNote | null;
}

/** The row for one answered search. */
export function retrievalRowOf(input: RetrievalInput): RetrievalRow {
	const returned = returnedOf(input.reply);
	const scores = input.reply.chunks.map((citation) => citation.score).filter((score) => Number.isFinite(score));
	return {
		surface: input.surface,
		queryHash: queryHash(input.question),
		queryText: queryTextOf(input.question),
		backend: input.backend,
		returned,
		topScore: scores.length === 0 ? null : Math.max(...scores),
		returnedCount: input.reply.chunks.length,
		degraded: input.reply.degraded === true,
		rerank: input.shadow === null ? null : { mode: "shadow", order: input.shadow.order.slice(0, RETRIEVAL_MAX_RETURNED).map((key) => key.slice(0, RETRIEVAL_KEY_CHARS)), moved: input.shadow.moved },
	};
}

/** What the recorder has done since the process started. */
export interface RecorderCounters {
	written: number;
	failed: number;
	timedOut: number;
	dropped: number;
}

export interface RecorderDeps {
	/** The store, or null when there is no index: a row is then dropped and counted. */
	store: () => ReflectStore | null;
	/** Where a failure line goes; stderr in production. */
	log: (line: string) => void;
	writeBudgetMs?: number;
	maxPending?: number;
}

export class RetrievalRecorder {
	/** The wrappers a caller may wait on; a wrapper leaves when the budget race ends, which can be before its database call has settled. */
	private readonly pending = new Set<Promise<void>>();
	/**
	 * Database writes that have started and not settled. The slot is held until the write itself ends, not until the race gave up:
	 * a database that answers slowly must not be handed more work than the cap while the earlier calls still run or wait for a connection.
	 */
	private inFlight = 0;
	private readonly counts: RecorderCounters = { written: 0, failed: 0, timedOut: 0, dropped: 0 };

	constructor(private readonly deps: RecorderDeps) {}

	counters(): Readonly<RecorderCounters> {
		return { ...this.counts };
	}

	/** Starts the write and returns at once. Never throws and never waits for the database. */
	record(row: RetrievalRow): void {
		const store = this.deps.store();
		if (store === null || this.inFlight >= (this.deps.maxPending ?? MAX_PENDING_WRITES)) {
			this.counts.dropped += 1;
			return;
		}
		const write = this.write(store, row).finally(() => {
			this.pending.delete(write);
		});
		this.pending.add(write);
	}

	/** Resolves once every write started so far has finished: the seam for shutdown and for tests, never for a search. */
	async idle(): Promise<void> {
		while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
	}

	private async write(store: ReflectStore, row: RetrievalRow): Promise<void> {
		const budgetMs = this.deps.writeBudgetMs ?? TELEMETRY_WRITE_BUDGET_MS;
		const expired = Promise.withResolvers<"timeout">();
		const timer = setTimeout(() => expired.resolve("timeout"), budgetMs);
		timer.unref();
		this.inFlight += 1;
		// A store that throws synchronously is a failed write like any other.
		const append = (async () => store.appendRetrieval(row))().finally(() => {
			this.inFlight -= 1;
		});
		try {
			const outcome = await Promise.race([append.then(() => "written" as const), expired.promise]);
			if (outcome === "written") {
				this.counts.written += 1;
			} else {
				this.counts.timedOut += 1;
				this.noteFailure(`timed out after ${budgetMs} ms`);
			}
		} catch (cause) {
			this.counts.failed += 1;
			this.noteFailure(redact(String(cause instanceof Error ? cause.message : cause)).slice(0, 200));
		} finally {
			clearTimeout(timer);
		}
	}

	private noteFailure(reason: string): void {
		const failures = this.counts.failed + this.counts.timedOut;
		if (failures === 1 || failures % LOG_EVERY === 0) this.deps.log(`[substrate] docs telemetry: retrieval row not stored (${failures} so far) — ${reason}`);
	}
}

export interface SweepOptions {
	retentionDays: number;
	/** Rows one delete may take: the store's own bound, so no single statement holds a long lock. */
	batch: number;
	maxBatches?: number | undefined;
	budgetMs?: number | undefined;
	/** Epoch ms; injected by tests. */
	now?: (() => number) | undefined;
	/** Gives the event loop a turn between two batches; injected by tests. */
	yieldTurn?: (() => Promise<void>) | undefined;
}

function nextMacrotask(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(() => resolve());
	return promise;
}

/**
 * Deletes expired retrieval rows in bounded batches until a batch comes back short (nothing more is expired), the batch count is
 * reached or the time budget is spent, with a turn of the event loop between batches so searches are served meanwhile. What is
 * left waits for the next sweep. Returns how many rows it deleted. A store that throws propagates its error.
 */
export async function sweepExpiredRetrievals(store: ReflectStore, options: SweepOptions): Promise<number> {
	const now = options.now ?? Date.now;
	const yieldTurn = options.yieldTurn ?? nextMacrotask;
	const maxBatches = options.maxBatches ?? SWEEP_MAX_BATCHES;
	const budgetMs = options.budgetMs ?? SWEEP_BUDGET_MS;
	const started = now();
	let deleted = 0;
	for (let batches = 0; batches < maxBatches; batches += 1) {
		const removed = await store.sweepRetrievals(options.retentionDays, options.batch);
		deleted += removed;
		if (removed < options.batch || now() - started >= budgetMs) break;
		await yieldTurn();
	}
	return deleted;
}
