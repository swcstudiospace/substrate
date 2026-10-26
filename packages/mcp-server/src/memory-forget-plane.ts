/**
 * The plane half of a memory forget (v1.6, phase 57): which Hindsight document an entry was retained as, and what
 * the delete's answer means to `forgetEntries`.
 *
 * `memory-forget.ts` is pure and asks its caller to delete the document. This is that caller's adapter, kept out of
 * `service.ts` so it can be proved with a fake plane and no service:
 *
 * - the bank is the WRITER's (`bankForSurface(config, entry.writer)`) and the document id is the one the retain used
 *   (`retainDocumentId(entry, entry.idempotency_key)`), so the delete names exactly what the retain wrote;
 * - a delete that finds nothing (`false`, or a `not-found` error) is SUCCESS: the document is gone, which is the goal;
 * - a timeout, a network error, a 5xx or a rate limit is PENDING and retryable: the index mark stands and a re-run
 *   of the same request retries only this deletion;
 * - an auth, bad-request or malformed-response failure is pending and NOT retryable: re-running will not help
 *   until an operator fixes the plane's configuration, and the report says so;
 * - no plane (unconfigured, or a VM guest, which never reaches Hindsight) is a skip, not a failure.
 *
 * The fetch is the service's gated Hindsight fetch, so the breaker and the per-plane budget apply; this module adds
 * nothing but the mapping and holds no state.
 */
import { retainDocumentId } from "./memory-retain.ts";
import type { PlaneDeleteResult } from "./memory-forget.ts";
import { bankForSurface, deleteDocument, type FetchLike, type HindsightConfig, type HindsightErrorKind } from "./planes/hindsight.ts";
import type { MemoryEntry } from "./types.ts";

/** Failures a re-run can cure: the plane was slow, unreachable, overloaded or refusing for now. */
const RETRYABLE_KINDS: readonly HindsightErrorKind[] = ["timeout", "network", "server", "rate-limit"];

export interface ForgetPlaneOptions {
	/** The Hindsight plane, or null when it is not configured. */
	config: HindsightConfig | null;
	/** A VM guest never reaches Hindsight (the retain path skips it the same way). */
	vmGuest: boolean;
	/** The service's gated Hindsight fetch. */
	fetchImpl: FetchLike;
	/** One delete's own timeout, ms. */
	timeoutMs: number;
}

/** The service cannot forget: there is no index to mark, and marking is the step that makes forgetting real. */
export class ForgetUnavailableError extends Error {
	override name = "ForgetUnavailableError";
	constructor() {
		super("memory forget needs the index (SUBSTRATE_PG_URL): without it nothing can be marked, so nothing is forgotten and no plane document is touched");
	}
}

/** The plane document `entry` was retained as, or null when it has no usable id (no subject and no idempotency key). */
export function forgetDocumentId(entry: MemoryEntry): string | null {
	const id = retainDocumentId(entry, entry.idempotency_key ?? "");
	return id.length > 0 ? id : null;
}

/** The `deletePlaneDocument` dependency of `forgetEntries`, over the options above. */
export function planeDeleteFor(options: ForgetPlaneOptions): (entry: MemoryEntry) => Promise<PlaneDeleteResult> {
	return async (entry) => {
		if (options.config === null) return { ok: true, skipped: "plane-not-configured" };
		if (options.vmGuest) return { ok: true, skipped: "vm-guest" };
		const documentId = forgetDocumentId(entry);
		if (documentId === null) return { ok: true, skipped: "no-document-id" };
		const deleted = await deleteDocument(options.config, bankForSurface(options.config, entry.writer), documentId, options.fetchImpl, options.timeoutMs);
		if (deleted.ok) return deleted.value ? { ok: true } : { ok: true, absent: true };
		if (deleted.error.kind === "not-found") return { ok: true, absent: true };
		return {
			ok: false,
			reason: `hindsight ${deleted.error.kind}: ${deleted.error.message}`,
			retryable: RETRYABLE_KINDS.includes(deleted.error.kind),
		};
	};
}
