/**
 * Phase 100 (F1): the STATE reflection event builder (pure, no I/O).
 *
 * The planning refresh (`Substrate.runPlanningRefresh` in `service.ts`) is the
 * one post-write hook that observes `.planning/` writes. When a changed page is
 * a STATE write or a phase SUMMARY transition, the hook builds one reflect
 * event carrying run lineage (`graph_id`, `phase`, `commit`) plus the redacted
 * body, and attaches it to the pass's `docs.planning` note. The body's LightRAG
 * insert itself keeps flowing through the guarded batch ingest; this event is
 * the lineage record, not a second upload.
 *
 * Fail-open: the builder never throws. A hook failure is a structured
 * `{ ok: false }` the caller logs while the write (and the pass) continues.
 */
import { createHash } from "node:crypto";
import { redact } from "./redact.ts";

/** Run lineage every reflect event carries. All three are non-blank. */
export interface StateReflectLineage {
	/** The planning session/graph the STATE belongs to (the checkout key, `planningSessionId`). */
	graph_id: string;
	/** The phase the page belongs to (`planningPhaseOf`), or `"state"` for STATE.md itself. */
	phase: string;
	/** The version pin: the page content sha (the LightRAG `"unpinned"` convention when unknown). */
	commit: string;
}

/** The reflect event a STATE.md write or SUMMARY transition emits. */
export interface StateReflectEvent {
	action: "state.reflect";
	/** The `.planning/`-relative page path that triggered the event. */
	path: string;
	/** The redacted body, capped at {@link STATE_REFLECT_BODY_MAX}. */
	body: string;
	/** True when the body was capped. */
	body_truncated: boolean;
	/** Lowercase hex sha256 of the unredacted body. */
	content_sha256: string;
	lineage: StateReflectLineage;
}

export type StateReflectOutcome =
	| { ok: true; event: StateReflectEvent }
	| { ok: false; code: "state-reflect.not-state-path" | "state-reflect.bad-lineage" | "state-reflect.empty-body" | "state-reflect.build-failed"; reason: string };

/** The most redacted body one reflect event carries. STATE.md is small; a cap keeps the note bounded. */
export const STATE_REFLECT_BODY_MAX = 8 * 1024;

const SUMMARY_BASENAME = /^\d+-SUMMARY\.md$/;

function isBlank(value: unknown): boolean {
	return typeof value !== "string" || value.trim().length === 0;
}

/**
 * Whether a `.planning/`-relative page path is a reflect trigger: a STATE.md
 * write or a phase SUMMARY transition (`<N>-SUMMARY.md` under `.planning/phases/`).
 * Pure string match, so the hook filters before reading any body. Never throws.
 */
export function isStateReflectPath(path: unknown): boolean {
	try {
		if (typeof path !== "string" || path.length === 0) return false;
		const normalized = path.replace(/\\/g, "/");
		if (normalized === ".planning/STATE.md" || normalized.endsWith("/.planning/STATE.md")) return true;
		if (!normalized.startsWith(".planning/phases/")) return false;
		const base = normalized.slice(normalized.lastIndexOf("/") + 1);
		return SUMMARY_BASENAME.test(base);
	} catch {
		return false;
	}
}

/**
 * The phase segment of a SUMMARY path (`100` for `.planning/phases/100-foo/100-SUMMARY.md`),
 * or null when the path is not a phase SUMMARY. Never throws.
 */
export function summaryPhaseOf(path: string): string | null {
	try {
		const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
		const match = /^(\d+)-SUMMARY\.md$/.exec(base);
		return match?.[1] ?? null;
	} catch {
		return null;
	}
}

function readLineage(value: unknown): StateReflectLineage | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const { graph_id, phase, commit } = record;
	if (isBlank(graph_id) || isBlank(phase) || isBlank(commit)) return null;
	return { graph_id: (graph_id as string).trim(), phase: (phase as string).trim(), commit: (commit as string).trim() };
}

/**
 * Build the reflect event for one STATE/SUMMARY page. The body is redacted on
 * the write path (before it enters any event) and capped; the hash covers the
 * unredacted body so a reader can match it against the page. Missing lineage
 * is a structured refusal, never a silent default. Never throws.
 */
export function buildStateReflectEvent(input: { path: unknown; body: unknown; lineage: unknown }): StateReflectOutcome {
	try {
		if (typeof input.path !== "string" || !isStateReflectPath(input.path)) {
			return { ok: false, code: "state-reflect.not-state-path", reason: "state-reflect: path is not a STATE.md write or phase SUMMARY transition" };
		}
		const lineage = readLineage(input.lineage);
		if (lineage === null) {
			return { ok: false, code: "state-reflect.bad-lineage", reason: "state-reflect: lineage needs non-blank graph_id, phase and commit" };
		}
		if (typeof input.body !== "string" || input.body.trim().length === 0) {
			return { ok: false, code: "state-reflect.empty-body", reason: "state-reflect: body is empty" };
		}
		const content_sha256 = createHash("sha256").update(input.body, "utf8").digest("hex");
		const redacted = redact(input.body);
		const body_truncated = redacted.length > STATE_REFLECT_BODY_MAX;
		const body = body_truncated ? `${redacted.slice(0, STATE_REFLECT_BODY_MAX)}…[truncated]` : redacted;
		return { ok: true, event: { action: "state.reflect", path: input.path, body, body_truncated, content_sha256, lineage } };
	} catch (cause) {
		return {
			ok: false,
			code: "state-reflect.build-failed",
			reason: `state-reflect: build failed (${cause instanceof Error ? cause.message : String(cause).slice(0, 120)})`,
		};
	}
}
