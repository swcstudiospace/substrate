/**
 * The one retry policy for a LightRAG query, shared by `docs_search` on the
 * LightRAG plane (`docs-search.ts`) and `docs_lightrag_query` with
 * `POST /docs/lightrag/query` (`mcp.ts`, `answerLightragQuery`).
 *
 * A query makes its first attempt and then at most `maxRetries` more. Retry
 * `n` waits `retryBaseMs * 2^(n - 1)` ms (`ragRetryDelay`): at the default
 * base of 200 ms, that is 200 ms then 400 ms. There is no jitter. Every
 * attempt and every wait runs under the shared total budget (`sharedDeadline`)
 * when the caller gives one. Only `docs_search` has a total budget; `docs_lightrag_query`
 * has per-attempt timeouts and backoff, and no total cap.
 *
 * Three outcomes are never retried: a refusal by the plane's open breaker (the
 * breaker decides when the plane is asked again), a spent budget (no time is
 * left to try in), and an answer with no usable content (`LIGHTRAG_EMPTY_ANSWER`),
 * which is a failure and never an empty success. Every other failure, an HTTP
 * error, a timeout or a transport error, is retried under the policy.
 */
import { DeadlineError, type SharedDeadline } from "./deadline.ts";
import { LIGHTRAG_CIRCUIT_OPEN, LIGHTRAG_EMPTY_ANSWER } from "./planes/lightrag.ts";
import { ragRetryDelay } from "./rag-retry.ts";

/** The empty-answer code and reason, owned by the plane and re-exported for the callers that name them here. */
export { LIGHTRAG_EMPTY_ANSWER };

/** The retry bounds: retries after the first attempt, and the base of the exponential backoff in ms. */
export interface LightragRetryPolicy {
	maxRetries: number;
	retryBaseMs: number;
}

/** The shape every attempt outcome has: an answer, or a reason it did not answer. */
export interface LightragAttemptShape {
	ok: boolean;
	reason?: string;
	code?: string;
}

/** An attempt's settled outcome, as `Promise.allSettled` reports it. */
export type LightragSettled<T> = PromiseSettledResult<T>;

/** One awaited read's outcome as `Promise.allSettled` reports it: a read that rejects is a settled failure, never a throw. */
export function settleLightrag<T>(read: Promise<T>): Promise<LightragSettled<T>> {
	return read.then(
		(value): LightragSettled<T> => ({ status: "fulfilled", value }),
		(reason: unknown): LightragSettled<T> => ({ status: "rejected", reason }),
	);
}

/**
 * Whether a failed attempt is worth another. A breaker refusal, an empty
 * answer and a spent budget are not; every other failure is.
 */
export function retryableLightragFailure(outcome: LightragSettled<LightragAttemptShape>): boolean {
	if (outcome.status === "rejected") return !(outcome.reason instanceof DeadlineError);
	if (outcome.value.ok) return false;
	// An empty answer is never retried. The plane codes it; `docs_search` builds its own with the reason alone.
	if (outcome.value.code === LIGHTRAG_EMPTY_ANSWER) return false;
	return outcome.value.reason !== LIGHTRAG_CIRCUIT_OPEN && outcome.value.reason !== LIGHTRAG_EMPTY_ANSWER;
}

/**
 * Run one LightRAG query under the policy: the first attempt, then up to
 * `policy.maxRetries` retries while the failure is retryable. Each backoff
 * is raced against the shared budget, so a wait the budget ends starts no
 * attempt (`ragRetryDelay` never rejects; the race rejects only with the
 * budget's own `DeadlineError`). The last outcome is returned, so the caller
 * answers with the failure that ended the chain. `attempt` settles its own
 * reads and is called again for each retry.
 */
export async function runLightragAttempts<T extends LightragAttemptShape>(
	attempt: () => Promise<LightragSettled<T>>,
	policy: LightragRetryPolicy,
	deadline: SharedDeadline,
): Promise<LightragSettled<T>> {
	let outcome = await attempt();
	for (let retry = 1; retry <= policy.maxRetries && retryableLightragFailure(outcome); retry += 1) {
		const waited = await deadline.race(ragRetryDelay(policy.retryBaseMs, retry)).then(
			() => true,
			() => false,
		);
		if (!waited) break;
		outcome = await attempt();
	}
	return outcome;
}
