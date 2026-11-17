/**
 * Teachable moments (Phase 29, CARD-02/CARD-03).
 *
 * A teachable is a governed `fact` whose subject carries the tag as the prefix
 * `teachable:` (e.g. `teachable:retry-budget`). No new memory kind, no tags
 * field, no schema change: the subject carries the tag because the conflict key
 * is `scope|kind|subject`, so a teachable is addressable per topic, and the card
 * builder reads them back with a `subjectPrefix` search — no new index, no
 * migration (D29-01). `fact` entries are append-only: a revised teachable under
 * the same subject leaves both facts live, newest first, superseding by recency.
 *
 * This module holds the predicate, the slug helper, and the one new event
 * builder of the phase. The builder returns an EventInput shaped exactly like
 * the `teachable.accepted` sample in `event-sources.ts` — kind `note`, the
 * writer's surface, `{ action: "teachable", memory_id, subject,
 * content_sha256 }` — hash only, never content bytes. No new event kind, no new
 * surface, no `planes/` import, no `SOLANA_*` names.
 */
import { normalizeSubject } from "./memory-policy.ts";
import type {
	EventInput,
	MemoryKind,
	MemoryWriteRequest,
	MemoryWriteResult,
	Surface,
} from "./types.ts";

/** The tag a teachable carries, as the prefix of its subject (D29-01). */
export const TEACHABLE_SUBJECT_PREFIX = "teachable:";

/**
 * Whether a write is a teachable: kind `fact` with a normalised subject that
 * starts with the prefix and carries a non-empty slug after it. An empty slug
 * (`teachable:` with nothing after) is not a teachable.
 */
export function isTeachable(kind: MemoryKind | string, subject: unknown): boolean {
	if (kind !== "fact") return false;
	return teachableSlug(subject) !== null;
}

/**
 * The part of a teachable subject after the prefix, for summaries and skill
 * names. Null when the subject is not a teachable.
 */
export function teachableSlug(subject: unknown): string | null {
	const normalized = normalizeSubject(subject);
	if (!normalized?.startsWith(TEACHABLE_SUBJECT_PREFIX)) return null;
	const slug = normalized.slice(TEACHABLE_SUBJECT_PREFIX.length);
	return slug ? slug : null;
}

/**
 * The `teachable.accepted` trail event for an accepted + verified teachable
 * write: kind `note` on the writer's surface, shaped like the mapped sample in
 * `event-sources.ts`. Carries the accepted entry's id, its full (normalised)
 * subject, and the 64-hex entry hash — never content bytes.
 */
export function teachableEvent(
	writer: Surface,
	request: MemoryWriteRequest,
	result: MemoryWriteResult,
): EventInput {
	const entry = result.entry;
	const slug = teachableSlug(request.subject) ?? "";
	const subject = entry?.subject ?? (normalizeSubject(request.subject) || "");
	return {
		surface: writer,
		kind: "note",
		summary: `teachable accepted: ${slug}`,
		...(typeof request.session_id === "string" && request.session_id ? { session_id: request.session_id } : {}),
		...(typeof request.graph_id === "string" && request.graph_id ? { graph_id: request.graph_id } : {}),
		payload: {
			action: "teachable",
			memory_id: entry?.id ?? "",
			subject,
			content_sha256: entry?.entry_hash ?? "",
		},
	};
}
