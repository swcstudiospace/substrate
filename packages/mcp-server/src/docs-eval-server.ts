/**
 * The offline docs-eval harness's server tier (v1.7 phase 70): the golden questions asked of the real `Substrate.searchDocs`
 * over a fake LightRAG plane that serves a fixture corpus.
 *
 * `scripts/docs-eval.ts` holds the fixtures, the scorer and the CLI; this module holds the part that must live inside
 * `mcp-server`, because the store lock (`store-lock.test.ts`) lets no file outside this package import the search code or a
 * plane client. `docs-golden.ts` splits the work the same way for the RAGFlow golden harness.
 *
 * What it exercises, and what it does not. The fake plane plays the retrieval backend: it answers `POST /query` with the
 * fixture documents that share words with the question (lexical BM25, `createLexicalIndex`), up to {@link SERVER_EVAL_CANDIDATES}
 * of them, and it sends them **worst first**, so the order the caller sees is the order the server produced. Everything after
 * the plane is production code on the path `docs_search` takes for the corpus dataset: the plane client's parsing of the answer,
 * the citation of each chunk (a corpus document name becomes its `corpus://` URL), the sort by score, the cap of ten and the
 * reduction of the answer to one key per document (`ranksFromSearchReply`, the reader the live run uses). A change to any of
 * those moves the scores. It does not measure embeddings, and it does not test the plane's own ranking.
 *
 * The plane keeps one copy of a page: a document uploaded again under another name with the same text is answered under the
 * first name (`duplicate-content` in `corpus/testkit.ts`), so the fake serves the smallest key of each group of identical
 * documents. `searchDocs` itself holds no de-duplication step in this tree; the probe in `scripts/docs-eval.ts` will catch the
 * day it starts to answer two copies of one page, or the wrong one.
 */
import { createHash } from "node:crypto";
import {
	LIVE_DEFAULT_DATASET,
	corpusDocumentName,
	createLexicalIndex,
	documentKey,
	isRecord,
	ranksFromSearchReply,
	type EvalDocument,
	type Rerank,
} from "@substrate/corpus";
import { loadConfig } from "./config.ts";
import type { FetchLike } from "./planes/lightrag.ts";
import { Substrate } from "./service.ts";

/** The most candidates the fake plane returns for a question. Above the server's cap of ten, so the cap is the server's. */
export const SERVER_EVAL_CANDIDATES = 30;

/** A reserved example host (RFC 2606): the fake plane is never dialled. */
const EVAL_PLANE_URL = "http://lightrag.example.test";

export interface ServerEvalOptions {
	/** The plane's own ranking step, applied to the collapsed hits before they are scored and sent. The artificial regressions of the tests plug in here. */
	rerank?: Rerank | undefined;
}

/**
 * The server's answer to a question as rank slots, best first (`null` for a result that is no corpus document). A question the plane could not answer (no document shares a
 * word with it, or the server degraded) answers nothing: a miss for the scorer, never an exception.
 */
export type ServerEvalSearch = (question: string) => Promise<(string | null)[]>;

export function createServerEvalSearch(docs: readonly EvalDocument[], options: ServerEvalOptions = {}): ServerEvalSearch {
	const byKey = new Map(docs.map((doc) => [documentKey(doc.repo, doc.path), doc]));
	const index = createLexicalIndex(docs.map((doc) => ({ key: documentKey(doc.repo, doc.path), text: doc.text })));

	const lightragFetch: FetchLike = async (input, init) => {
		const url = new URL(String(input));
		if (init?.method !== "POST" || url.pathname !== "/query") return Response.json({ detail: "no route" }, { status: 404 });
		const body: unknown = JSON.parse(String(init.body));
		const question = isRecord(body) && typeof body.query === "string" ? body.query : "";
		const hits = index.search(question, { limit: SERVER_EVAL_CANDIDATES, rerank: options.rerank });
		// The score follows the plane's own order, so a re-ranking step that reorders the hits reorders what the server answers.
		const chunks = hits.flatMap((hit, position) => {
			const doc = byKey.get(hit.key);
			if (doc === undefined) return [];
			const sha256 = createHash("sha256").update(doc.text, "utf8").digest("hex");
			return [{ content: doc.text, file_path: corpusDocumentName(doc.repo, doc.path, sha256), chunk_id: `eval:${position}`, score: (hits.length - position) / hits.length }];
		});
		return Response.json({ status: "success", data: { chunks: chunks.reverse() } });
	};

	const substrate = new Substrate(loadConfig({ LIGHTRAG_URL: EVAL_PLANE_URL, SUBSTRATE_DOCS_BACKEND: "lightrag" }), { index: null, greptime: null, lightragFetch });
	return async (question) => {
		const answer = ranksFromSearchReply(await substrate.searchDocs({ question, datasets: [LIVE_DEFAULT_DATASET] }, "omp"));
		return answer.kind === "ranked" ? answer.keys : [];
	};
}
