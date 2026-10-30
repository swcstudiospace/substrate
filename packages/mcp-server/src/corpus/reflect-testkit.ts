/**
 * An in-memory `ReflectStore` for tests that behaves like the Postgres one: retention by age, one verdict per (document,
 * session), the grouped feedback counts and the gap aggregate. Failures and a database that never answers are injected by flag.
 */
import type { FeedbackCounts } from "@substrate/corpus";
import { isGap, type FeedbackEntry, type GapQuery, type GapRow, type ReflectStore, type RetrievalRow } from "./reflect-store.ts";

const DAY_MS = 86_400_000;

export interface StoredRetrieval {
	row: RetrievalRow;
	/** Epoch ms the row was appended at. */
	at: number;
}

export class FakeReflectStore implements ReflectStore {
	readonly retrievals: StoredRetrieval[] = [];
	readonly feedback = new Map<string, FeedbackEntry & { at: number }>();
	/** Appends reject with this error while it is set. */
	failAppend: Error | null = null;
	/** Appends never settle while this is set: a database that does not answer. */
	hangAppend = false;
	/** Feedback counts reject while this is set. */
	failCounts = false;
	feedbackCountReads = 0;

	constructor(private readonly clock: () => number = () => Date.now()) {}

	async appendRetrieval(row: RetrievalRow): Promise<void> {
		if (this.hangAppend) return new Promise<void>(() => undefined);
		if (this.failAppend !== null) throw this.failAppend;
		this.retrievals.push({ row, at: this.clock() });
	}

	async sweepRetrievals(retentionDays: number, batch: number): Promise<number> {
		const cutoff = this.clock() - retentionDays * DAY_MS;
		const doomed = this.retrievals
			.filter((entry) => entry.at < cutoff)
			.sort((left, right) => left.at - right.at)
			.slice(0, batch);
		for (const entry of doomed) this.retrievals.splice(this.retrievals.indexOf(entry), 1);
		return doomed.length;
	}

	async upsertFeedback(entry: FeedbackEntry): Promise<void> {
		this.feedback.set(`${entry.documentKey}\n${entry.sessionId}`, { ...entry, at: this.clock() });
	}

	async feedbackCounts(maxKeys: number): Promise<Map<string, FeedbackCounts>> {
		this.feedbackCountReads += 1;
		if (this.failCounts) throw new Error("connection lost");
		const counts = new Map<string, FeedbackCounts>();
		for (const entry of [...this.feedback.values()].sort((left, right) => right.at - left.at)) {
			if (!counts.has(entry.documentKey) && counts.size >= maxKeys) continue;
			const held = counts.get(entry.documentKey) ?? { helpful: 0, unhelpful: 0, stale: 0, wrong: 0, duplicate: 0 };
			held[entry.verdict] += 1;
			counts.set(entry.documentKey, held);
		}
		return counts;
	}

	async gaps(query: GapQuery): Promise<GapRow[]> {
		const since = this.clock() - query.days * DAY_MS;
		const byHash = new Map<string, StoredRetrieval[]>();
		for (const entry of this.retrievals) {
			if (entry.at < since || entry.row.degraded) continue;
			byHash.set(entry.row.queryHash, [...(byHash.get(entry.row.queryHash) ?? []), entry]);
		}
		const rows: GapRow[] = [];
		for (const [queryHash, entries] of byHash) {
			const scores = entries.map((entry) => entry.row.topScore).filter((score): score is number => score !== null);
			const best = scores.length === 0 ? null : Math.max(...scores);
			if (!isGap(best, query.gapScore)) continue;
			const newest = [...entries].sort((left, right) => right.at - left.at);
			rows.push({
				queryHash,
				text: newest.find((entry) => entry.row.queryText !== null)?.row.queryText ?? null,
				searches: entries.length,
				lastSeen: new Date(newest[0]?.at ?? 0).toISOString(),
				best,
			});
		}
		return rows.sort((left, right) => right.searches - left.searches || (right.lastSeen < left.lastSeen ? -1 : right.lastSeen > left.lastSeen ? 1 : 0) || (left.queryHash < right.queryHash ? -1 : 1)).slice(0, query.limit);
	}
}
