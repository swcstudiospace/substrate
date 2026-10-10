/**
 * Teachable moments: the `teachable:` subject convention and its trail event.
 *
 * A teachable is a governed `fact` whose subject carries the tag as the prefix
 * `teachable:` (e.g. `teachable:retry-budget`). `MemoryEntryInput` has no tags
 * field and none is added: the subject is the identity `lww`/`versioned`
 * resolve on (`conflictKey`), so teachables collide sanely per topic, and the
 * card builder reads a surface's teachables with a `subjectPrefix` search — no
 * new index, no migration, no new memory kind.
 *
 * The gate path is unchanged: a teachable passes `governMemoryWrite` like any
 * other fact, and a refused teachable is a refused fact, nothing more. The one
 * addition is the trail: an accepted + verified teachable emits a `note` from
 * the writer's surface shaped like the `teachable.accepted` sample in
 * `event-sources.ts`, so the hourly anchor covers it with zero anchor-code
 * changes. The payload carries the entry id and its content hash, never
 * content — the body may be exactly what a future quarantine would park.
 */
import { normalizeSubject } from "./memory-policy.ts";
import type { EventInput, MemoryWriteRequest, MemoryWriteResult, Surface } from "./types.ts";

/** The tag a teachable carries, as a subject prefix rather than a new field. */
export const TEACHABLE_SUBJECT_PREFIX = "teachable:";

/**
 * Whether this write is a teachable: kind `fact` with a non-empty slug after
 * the prefix. The subject is normalised the way the gate normalises a stored
 * subject, so `Teachable:Retry` and `teachable:retry` are the same teachable.
 */
export function isTeachable(kind: unknown, subject: unknown): boolean {
	return kind === "fact" && teachableSlug(subject) !== null;
}

/**
 * The part after the prefix, or null where the subject is not a teachable —
 * including `teachable:` with nothing after it, which names no topic.
 */
export function teachableSlug(subject: unknown): string | null {
	const normalized = normalizeSubject(subject);
	if (!normalized || !normalized.startsWith(TEACHABLE_SUBJECT_PREFIX)) return null;
	const slug = normalized.slice(TEACHABLE_SUBJECT_PREFIX.length);
	return slug ? slug : null;
}

/**
 * The trail event for an accepted teachable, shaped like the
 * `teachable.accepted` sample: kind `note` from the writer's surface, summary
 * `teachable accepted: <slug>`, the caller's session/graph, and a payload of
 * `{ action, memory_id, subject, content_sha256 }` — the entry id and its
 * content hash, never the body.
 *
 * Callers gate on accepted + verified + known surface before reaching here;
 * `result.entry` is always present on that path (every accepted reply carries
 * the stored entry), and the fallbacks below are unreachable defence.
 */
export function teachableEvent(
	writer: Surface,
	request: MemoryWriteRequest,
	result: MemoryWriteResult,
): EventInput {
	const entry = result.entry;
	const slug = teachableSlug(request.subject) ?? teachableSlug(entry?.subject) ?? "";
	return {
		surface: writer,
		kind: "note",
		summary: `teachable accepted: ${slug}`,
		...(request.session_id ? { session_id: request.session_id } : {}),
		...(request.graph_id ? { graph_id: request.graph_id } : {}),
		payload: {
			action: "teachable",
			memory_id: entry?.id ?? "",
			subject: entry?.subject ?? request.subject ?? "",
			content_sha256: entry?.entry_hash ?? "",
		},
	};
}
