/**
 * `memory_search` with derived-marked Hindsight hits (D26-05).
 *
 * The governed index stays first and unmarked; plane hits append after it,
 * each carrying its source bank and the derived flag with the untrusted-
 * memory notice. A Hindsight outage yields index-only results with
 * `{degraded: true, reason}` — never a refusal. The merge shares the recall
 * module (no second client) and stays outside the brief compose path.
 *
 * The paged search (`subject_prefix` listings, keyset cursors) stays
 * index-only on purpose: plane hits ignore the prefix and the cursor, so
 * injecting them would corrupt paging without adding recall — the list path
 * is where `memory_search` merges.
 */
import { UNTRUSTED_MEMORY_NOTICE, type DerivedMemoryHit, type RecallReply } from "./memory-recall.ts";
import type { MemoryEntry } from "./types.ts";

/** The list reply: index entries first, derived plane hits after. */
export interface MergedMemoryResults {
	entries: MemoryEntry[];
	derived: DerivedMemoryHit[];
	degraded: boolean;
	notice: string;
	reason?: string;
}

/**
 * Append plane hits after index results without touching their order.
 * Attribution and the derived flag survive the merge; an outage surfaces as
 * index-only with the recall reason.
 *
 * A requested scope filters the plane leg the way the index filters its own:
 * only hits retained for that scope survive (the forward stores it in
 * metadata and each derived hit carries it as a locator). Without a scope
 * every hit survives, exactly as before.
 */
export function mergeDerivedHits(entries: MemoryEntry[], recall: RecallReply, scope?: string): MergedMemoryResults {
	return {
		entries,
		derived: scope === undefined ? recall.results : recall.results.filter((hit) => hit.scope === scope),
		degraded: recall.degraded,
		notice: UNTRUSTED_MEMORY_NOTICE,
		...(recall.reason !== undefined ? { reason: recall.reason } : {}),
	};
}
