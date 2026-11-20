/**
 * What the docs RAG learns from use (v1.7 phase 66), behind an interface so the telemetry recorder, the feedback door, the
 * authority index and the gap report run against a fake in tests: retrieval rows (`corpus_retrievals`), feedback verdicts
 * (`corpus_feedback`) and the gap aggregate over the rows. Both tables come from migration step 38.
 */
import type { SQL } from "bun";
import type { CorpusShadowRow, FeedbackCounts } from "@substrate/corpus";

/** The closed list of verdicts a session may give a document. */
export const FEEDBACK_VERDICTS = ["helpful", "unhelpful", "stale", "wrong", "duplicate"] as const;
export type FeedbackVerdict = (typeof FEEDBACK_VERDICTS)[number];

export function isFeedbackVerdict(value: unknown): value is FeedbackVerdict {
	return typeof value === "string" && (FEEDBACK_VERDICTS as readonly string[]).includes(value);
}

/** The most documents one retrieval row names: the search returns at most ten citations. */
export const RETRIEVAL_MAX_RETURNED = 10;
/** The longest query text a retrieval row keeps, after redaction. */
export const RETRIEVAL_QUERY_TEXT_CHARS = 200;
/** The longest key (a citation title or URL) a retrieval row keeps for one returned document. */
export const RETRIEVAL_KEY_CHARS = 300;
/** The most rows one retention sweep deletes, so a sweep never holds a long lock. */
export const RETRIEVAL_SWEEP_BATCH = 1000;
/**
 * The most document keys the feedback counts hold. It equals the manifest's own read cap (`AUTHORITY_MAX_ROWS`): the counts are
 * read only for documents with an active row, so every document the authority index can see keeps its votes, and the bound is the
 * one the index already has.
 */
export const FEEDBACK_MAX_KEYS = 100_000;
/** The most keys one shadow row keeps in its order. */
export const SHADOW_ORDER_KEYS = 10;
/** The window `GET /corpus/gaps` aggregates over, in days. */
export const GAP_WINDOW_DAYS = 30;

/** One returned document in a retrieval row: its key and its score, never its text. */
export interface RetrievedDocument {
	key: string;
	score: number;
}

/** What `SUBSTRATE_DOCS_RERANK=shadow` records about a search: the order `on` would have answered and how many positions would move. */
export interface RetrievalRerank {
	mode: "shadow";
	order: string[];
	moved: number;
}

/** One `docs_search`, as `corpus_retrievals` stores it. */
export interface RetrievalRow {
	surface: string;
	queryHash: string;
	/** The redacted query cut to {@link RETRIEVAL_QUERY_TEXT_CHARS}; null when the redactor found a secret in it. */
	queryText: string | null;
	backend: string;
	returned: RetrievedDocument[];
	topScore: number | null;
	returnedCount: number;
	/** The plane could not answer: the search says nothing about what the corpus holds, so the gap report leaves it out. */
	degraded: boolean;
	/** Set only while the re-rank runs in shadow; null otherwise. */
	rerank: RetrievalRerank | null;
}

export interface FeedbackEntry {
	documentKey: string;
	sessionId: string;
	verdict: FeedbackVerdict;
	surface: string;
}

/** What the shadow report reads: the window and the most rows to list. */
export interface ShadowQuery {
	days: number;
	limit: number;
}

/** The shadow report's aggregate over one window, as the store computes it. */
export interface ShadowAggregate {
	searches: number;
	movedSearches: number;
	moved: number;
	largest: CorpusShadowRow[];
}

/** One aggregate row of the gap report. */
export interface GapRow {
	queryHash: string;
	text: string | null;
	searches: number;
	lastSeen: string;
	best: number | null;
}

export interface GapQuery {
	/** A query whose best citation scored below this is a gap; a query that returned no citation is a gap whatever this is. */
	gapScore: number;
	days: number;
	/** The most rows to return. */
	limit: number;
}

/** Whether a query whose best citation scored `best` (null: it returned none) is a gap. The SQL of `gaps` says the same. */
export function isGap(best: number | null, gapScore: number): boolean {
	return best === null || best < gapScore;
}

export interface ReflectStore {
	appendRetrieval(row: RetrievalRow): Promise<void>;
	/** Deletes at most `batch` rows older than `retentionDays` days, oldest first, and returns how many it deleted. */
	sweepRetrievals(retentionDays: number, batch: number): Promise<number>;
	/** One verdict per (document, session): the latest wins. */
	upsertFeedback(entry: FeedbackEntry): Promise<void>;
	/**
	 * Verdict counts per document key: one grouped query over at most `maxKeys` documents that hold an active manifest row, the most
	 * recently voted on first. A surface counts once per document: its latest verdict, whichever of its sessions gave it, so one
	 * surface cannot reach the stale threshold by posting under many session ids.
	 */
	feedbackCounts(maxKeys: number): Promise<Map<string, FeedbackCounts>>;
	/** The shadow report over the window: how many searches the re-rank would have moved, and the largest moves. */
	shadowReport(query: ShadowQuery): Promise<ShadowAggregate>;
	/** Query hashes whose best score in the window was below the gap score, most searched first. */
	gaps(query: GapQuery): Promise<GapRow[]>;
}

function numberOf(value: unknown): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

/** The `rerank` column as the shadow note the search wrote: its moved count and the keys it would have answered in, or null when it does not read as one. */
export function shadowOf(value: unknown): { moved: number; order: string[] } | null {
	if (typeof value !== "string") return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object") return null;
	const { moved, order } = parsed as { moved?: unknown; order?: unknown };
	if (typeof moved !== "number" || !Number.isFinite(moved) || !Array.isArray(order)) return null;
	return { moved, order: order.filter((key): key is string => typeof key === "string").slice(0, SHADOW_ORDER_KEYS) };
}

function isoOf(value: unknown): string {
	const at = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
	return at === null || Number.isNaN(at.getTime()) ? new Date(0).toISOString() : at.toISOString();
}

/** The Bun SQL adapter over `corpus_retrievals` and `corpus_feedback` (migration step 38). */
export function bunReflectStore(sql: SQL): ReflectStore {
	return {
		async appendRetrieval(row: RetrievalRow): Promise<void> {
			const rerank = row.rerank === null ? null : JSON.stringify(row.rerank);
			await sql`
				insert into corpus_retrievals (surface, query_hash, query_text, backend, returned, top_score, returned_count, degraded, rerank)
				values (${row.surface}, ${row.queryHash}, ${row.queryText}, ${row.backend}, ${JSON.stringify(row.returned)}::text::jsonb, ${row.topScore}, ${row.returnedCount}, ${row.degraded}, ${rerank}::text::jsonb)`;
		},
		async sweepRetrievals(retentionDays: number, batch: number): Promise<number> {
			const rows = await sql`
				delete from corpus_retrievals
				where id in (select id from corpus_retrievals where at < now() - make_interval(days => ${retentionDays}) order by at limit ${batch})
				returning 1 as gone`;
			return rows.length;
		},
		async upsertFeedback(entry: FeedbackEntry): Promise<void> {
			await sql`
				insert into corpus_feedback (document_key, session_id, verdict, surface, at)
				values (${entry.documentKey}, ${entry.sessionId}, ${entry.verdict}, ${entry.surface}, now())
				on conflict (document_key, session_id) do update set verdict = excluded.verdict, surface = excluded.surface, at = now()`;
		},
		async feedbackCounts(maxKeys: number): Promise<Map<string, FeedbackCounts>> {
			const rows: Array<Record<string, unknown>> = await sql`
				select f.document_key,
					count(*) filter (where f.verdict = 'helpful')::int as helpful,
					count(*) filter (where f.verdict = 'unhelpful')::int as unhelpful,
					count(*) filter (where f.verdict = 'stale')::int as stale,
					count(*) filter (where f.verdict = 'wrong')::int as wrong,
					count(*) filter (where f.verdict = 'duplicate')::int as duplicate
				from (
					select distinct on (document_key, surface) document_key, surface, verdict, at
					from corpus_feedback
					order by document_key, surface, at desc
				) f
				join corpus_documents d on d.repo || ':' || d.path = f.document_key and d.state = 'active'
				group by f.document_key
				order by max(f.at) desc, f.document_key
				limit ${maxKeys}`;
			const counts = new Map<string, FeedbackCounts>();
			for (const row of rows) {
				if (typeof row.document_key !== "string") continue;
				counts.set(row.document_key, {
					helpful: numberOf(row.helpful),
					unhelpful: numberOf(row.unhelpful),
					stale: numberOf(row.stale),
					wrong: numberOf(row.wrong),
					duplicate: numberOf(row.duplicate),
				});
			}
			return counts;
		},
		async shadowReport(query: ShadowQuery): Promise<ShadowAggregate> {
			const totalRows: Array<Record<string, unknown>> = await sql`
				select count(*)::int as searches,
					count(*) filter (where (rerank->>'moved')::int > 0)::int as moved_searches,
					coalesce(sum((rerank->>'moved')::int), 0)::int as moved
				from corpus_retrievals
				where at >= now() - make_interval(days => ${query.days}) and not degraded and rerank is not null`;
			const rows: Array<Record<string, unknown>> = await sql`
				select query_hash, query_text, at, rerank::text as rerank
				from corpus_retrievals
				where at >= now() - make_interval(days => ${query.days}) and not degraded and rerank is not null
					and (rerank->>'moved')::int > 0
				order by (rerank->>'moved')::int desc, at desc, query_hash
				limit ${query.limit}`;
			const totals = totalRows[0] ?? {};
			return {
				searches: numberOf(totals.searches),
				movedSearches: numberOf(totals.moved_searches),
				moved: numberOf(totals.moved),
				largest: rows.flatMap((row): CorpusShadowRow[] => {
					const parsed = shadowOf(row.rerank);
					if (typeof row.query_hash !== "string" || parsed === null) return [];
					return [{ queryHash: row.query_hash, text: typeof row.query_text === "string" ? row.query_text : null, at: isoOf(row.at), moved: parsed.moved, order: parsed.order }];
				}),
			};
		},
		async gaps(query: GapQuery): Promise<GapRow[]> {
			const rows: Array<Record<string, unknown>> = await sql`
				select query_hash,
					(array_agg(query_text order by at desc) filter (where query_text is not null))[1] as text,
					count(*)::int as searches,
					max(at) as last_seen,
					max(top_score) as best
				from corpus_retrievals
				where at >= now() - make_interval(days => ${query.days}) and not degraded
				group by query_hash
				having max(top_score) is null or max(top_score) < ${query.gapScore}
				order by count(*) desc, max(at) desc, query_hash
				limit ${query.limit}`;
			return rows.flatMap((row): GapRow[] => {
				if (typeof row.query_hash !== "string") return [];
				return [
					{
						queryHash: row.query_hash,
						text: typeof row.text === "string" ? row.text : null,
						searches: numberOf(row.searches),
						lastSeen: isoOf(row.last_seen),
						best: row.best === null || row.best === undefined ? null : numberOf(row.best),
					},
				];
			});
		},
	};
}
