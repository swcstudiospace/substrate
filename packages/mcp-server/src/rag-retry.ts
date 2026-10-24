/**
 * Exponential backoff between LightRAG attempts. One policy for every LightRAG
 * call: `docs_lightrag_query`, `POST /docs/lightrag/query` and the docs search,
 * whose attempt count and base come from `SUBSTRATE_RAG_MAX_RETRIES` and
 * `SUBSTRATE_RAG_RETRY_BASE_MS`.
 */

/** Waits before retry `attempt` (1-based): `base * 2^(attempt - 1)` ms. No wait when the base is zero or there is no retry. */
export async function ragRetryDelay(baseMs: number, attempt: number): Promise<void> {
	if (baseMs <= 0 || attempt <= 0) return;
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, baseMs * 2 ** (attempt - 1));
	await promise;
}
