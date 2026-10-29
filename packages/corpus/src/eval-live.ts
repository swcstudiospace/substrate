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
export const LIVE_SEARCH_PATH = "/docs/search";
/** The dataset the corpus atlas ingests into. */
export const LIVE_DEFAULT_DATASET = "corpus";
/** One question's deadline. */
export const LIVE_QUESTION_TIMEOUT_MS = 10_000;
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

export type SearchReply = { kind: "ranked"; keys: string[] } | { kind: "degraded" } | { kind: "invalid" };

/** The document keys of a `POST /docs/search` answer in rank order, one per document, or `degraded`, or `invalid` when the body is not an answer. */
export function ranksFromSearchReply(body: unknown): SearchReply {
	if (!isRecord(body) || !Array.isArray(body.chunks)) return { kind: "invalid" };
	if (body.degraded === true) return { kind: "degraded" };
	const keys: string[] = [];
	for (const chunk of body.chunks) {
		if (!isRecord(chunk) || typeof chunk.source_url !== "string") continue;
		const key = documentKeyOfUrl(chunk.source_url);
		if (key !== null && !keys.includes(key)) keys.push(key);
	}
	return { kind: "ranked", keys };
}

/** Asks every question in turn. Never throws. */
export async function runLiveQueries(queries: readonly GoldenQuery[], options: LiveOptions): Promise<LiveRun> {
	const base = options.base.replace(/\/+$/, "");
	const datasets = [...(options.datasets ?? [LIVE_DEFAULT_DATASET])];
	const startedAt = options.now();
	const results: QueryResult[] = [];
	let failed = 0;
	let degraded = 0;
	let consecutive = 0;
	for (const [index, golden] of queries.entries()) {
		if (options.now() - startedAt > LIVE_RUN_DEADLINE_MS) return { results, failed, degraded, aborted: "deadline" };
		if (consecutive >= LIVE_MAX_CONSECUTIVE_FAILURES) return { results, failed, degraded, aborted: "consecutive-failures" };
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
	return { results, failed, degraded, aborted: consecutive >= LIVE_MAX_CONSECUTIVE_FAILURES ? "consecutive-failures" : null };
}
