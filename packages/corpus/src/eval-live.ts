/**
 * The live half of the evaluation (v1.7 phase 70): the golden questions asked of a running server through its read-only
 * `POST /docs/search` route, answered as document keys so `scoreRun` can score them like the offline retriever's.
 *
 * Read-only. The bearer is passed in by the caller and is only ever sent in the `authorization` header; no message, result or
 * error carries it. One failed or degraded question never fails the run: it is counted and left out of the scores, and a run
 * that cannot work at all (an unauthorised token, a dead server) stops after a few consecutive failures instead of retrying
 * every question.
 */
import { isRecord } from "./guards.ts";
import { resultOf, type GoldenQuery, type QueryResult } from "./eval.ts";

/** The route the live run asks. */
const LIVE_SEARCH_PATH = "/docs/search";
/** The dataset the corpus atlas ingests into. */
export const LIVE_DEFAULT_DATASET = "corpus";
/** One question's deadline. */
const LIVE_QUESTION_TIMEOUT_MS = 10_000;
/** The whole run's deadline. */
export const LIVE_RUN_DEADLINE_MS = 600_000;
/** This many failures in a row end the run: the server, the token or the route is the problem, not the questions. */
export const LIVE_MAX_CONSECUTIVE_FAILURES = 5;
/** The most questions a live run asks unless its caller sets a lower number. Shared by `scripts/docs-eval.ts` and `substrate corpus eval`. */
export const LIVE_MAX_QUERIES = 500;

export interface LiveOptions {
	/** The server's base URL. */
	base: string;
	/** The bearer token. Never printed. */
	token: string;
	fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
	/** Milliseconds on a monotonic clock. */
	now: () => number;
	datasets?: readonly string[] | undefined;
	/**
	 * REQUIRED: says whether a question must not leave this machine (it looks like it carries a credential). `packages/corpus` is
	 * pure and cannot hold a detector of its own, so every caller passes the shared redactor's verdict, the check ingest applies
	 * to documents: `(text) => redact(text) !== text`. A question it flags is not sent, not scored and not counted as failed.
	 */
	unsafe: (text: string) => boolean;
}

export interface LiveRun {
	/** The questions that were answered, scored by the caller. */
	results: QueryResult[];
	/** Questions whose request failed or was refused. */
	failed: number;
	/** Questions the server answered as degraded (a plane outage): an outage is not a retrieval miss. */
	degraded: number;
	/** Why the run stopped early, or null when every question was asked. */
	aborted: "consecutive-failures" | "deadline" | null;
	/** Questions left unasked because {@link LiveOptions.unsafe} flagged them. Their text is never kept or returned. */
	skippedUnsafe: number;
}

/** The one line every report prints when questions were left unasked by the {@link LiveOptions.unsafe} guard; empty for none. */
export function unsafeSkippedLine(count: number): string {
	if (count <= 0) return "";
	const which = count === 1 ? "1 question was" : `${count} questions were`;
	return `${which} not sent: ${count === 1 ? "it looks" : "they look"} like ${count === 1 ? "it contains" : "they contain"} a credential (the same check ingest applies)`;
}

/** The `repo:path` key a citation's source URL names, or null for a URL that is not a corpus document's. The inverse of `sourceUrl`. */
export function documentKeyOfUrl(url: string): string | null {
	const decode = (path: string): string | null => {
		try {
			return path
				.split("/")
				.map((segment) => decodeURIComponent(segment))
				.join("/");
		} catch {
			// A malformed percent-escape names no document: null.
			return null;
		}
	};
	const github = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/blob\/[^/]+\/(.+)$/.exec(url);
	if (github !== null) {
		const path = decode(github[3] ?? "");
		return path === null ? null : `${github[1]}/${github[2]}:${path}`;
	}
	const local = /^corpus:\/\/([^/]+\/[^/]+)\/(.+)$/.exec(url);
	if (local !== null) {
		const path = decode(local[2] ?? "");
		return path === null ? null : `${local[1]}:${path}`;
	}
	return null;
}

/**
 * `keys` holds one slot per result of the answer, best first: a corpus document's key, or `null` for a result that names no corpus
 * document (a Hindsight hit, a page outside the corpus, a chunk with no usable URL). The shared plane answers for more than the
 * corpus, so such a result still stands in front of the ones behind it; dropping it would let a document in sixth place read as
 * fourth.
 */
type SearchReply = { kind: "ranked"; keys: (string | null)[] } | { kind: "degraded" } | { kind: "invalid" };

/**
 * The rank slots of a `POST /docs/search` answer in order (see {@link SearchReply}), or `degraded`, or `invalid` when the body is
 * not an answer. A corpus document appears once, at its first chunk; every other result takes its own slot.
 */
export function ranksFromSearchReply(body: unknown): SearchReply {
	if (!isRecord(body) || !Array.isArray(body.chunks)) return { kind: "invalid" };
	if (body.degraded === true) return { kind: "degraded" };
	const keys: (string | null)[] = [];
	for (const chunk of body.chunks) {
		const key = isRecord(chunk) && typeof chunk.source_url === "string" ? documentKeyOfUrl(chunk.source_url) : null;
		if (key === null) keys.push(null);
		else if (!keys.includes(key)) keys.push(key);
	}
	return { kind: "ranked", keys };
}

/** Asks every question in turn, except those `options.unsafe` flags (counted in `skippedUnsafe`). Never throws. */
export async function runLiveQueries(queries: readonly GoldenQuery[], options: LiveOptions): Promise<LiveRun> {
	const base = options.base.replace(/\/+$/, "");
	const datasets = [...(options.datasets ?? [LIVE_DEFAULT_DATASET])];
	const startedAt = options.now();
	const results: QueryResult[] = [];
	let failed = 0;
	let degraded = 0;
	let consecutive = 0;
	// Decided for every question before the first request, so the count is complete even when the run stops early.
	// A guard that throws cannot vouch for the question, so the question is not sent.
	const unsafe = (text: string): boolean => {
		try {
			return options.unsafe(text);
		} catch {
			return true;
		}
	};
	const askable = queries.map((golden, index) => ({ golden, index })).filter(({ golden }) => !unsafe(golden.query));
	const skippedUnsafe = queries.length - askable.length;
	for (const { golden, index } of askable) {
		if (options.now() - startedAt > LIVE_RUN_DEADLINE_MS) return { results, failed, degraded, aborted: "deadline", skippedUnsafe };
		if (consecutive >= LIVE_MAX_CONSECUTIVE_FAILURES) return { results, failed, degraded, aborted: "consecutive-failures", skippedUnsafe };
		const began = options.now();
		let reply: SearchReply = { kind: "invalid" };
		try {
			const response = await options.fetchImpl(`${base}${LIVE_SEARCH_PATH}`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${options.token}` },
				body: JSON.stringify({ question: golden.query, datasets, session_id: `docs-eval:${index}` }),
				signal: AbortSignal.timeout(LIVE_QUESTION_TIMEOUT_MS),
			});
			if (response.ok) reply = ranksFromSearchReply(await response.json());
		} catch {
			reply = { kind: "invalid" };
		}
		const latencyMs = options.now() - began;
		if (reply.kind === "ranked") {
			consecutive = 0;
			results.push(resultOf(golden, reply.keys, latencyMs));
		} else if (reply.kind === "degraded") {
			consecutive += 1;
			degraded += 1;
		} else {
			consecutive += 1;
			failed += 1;
		}
	}
	return { results, failed, degraded, aborted: consecutive >= LIVE_MAX_CONSECUTIVE_FAILURES ? "consecutive-failures" : null, skippedUnsafe };
}
