/**
 * Per-surface transcript locators (v1.6, phase 61, unit c).
 *
 * A rollback checkpoint records WHERE in a surface's transcript it was taken, as the `transcript_ref` of
 * `session-events.ts`. This module turns what each collector already knows into that pointer, or into an
 * explicit `null` with a reason. Pure: it reads nothing, and it NEVER invents an id: a surface with no
 * verifiable per-turn id yields `null` with reason `no-turn-id`.
 *
 * Locator form. `session_locator` is always an opaque id (a session uuid or a conversation id), never a path:
 * a home directory path would leak the user name and the checkout layout into the ledger, and the contract's
 * `parseTranscriptRef` rejects a slash anyway. A caller that was handed a path (Cursor's `transcript_path`)
 * uses it only for a consistency check against the id; the path itself is not carried. No message text or
 * tool arguments are read, and unknown input keys are ignored rather than copied, so content cannot ride along.
 *
 * What each surface really offers (packages/collectors, and the v1.6 recon for per-turn ids):
 *  - omp: an entry id and a prefix digest, produced by `ompTranscriptRef` in `packages/cli/src/session/omp-fork.ts`.
 *  - grok-build: `session_id`, `turn_number` and `tool_call_id` are in the event payload (`grok-map.ts`).
 *  - cursor: the stop hook gives `conversation_id` and `transcript_path` (`cursor-stop.ts`). Per-turn ids
 *    inside the transcript are UNVERIFIED, so only a turn number the caller counted can complete a ref.
 *  - claude-code: the collectors never read its transcripts; a per-message id is UNVERIFIED on this host, so
 *    the ref is built only from ids the caller supplies.
 *  - hermes, muse, codex, opencode, pi, rivet-agentos, grok-bot, substrate and every swarm-* surface:
 *    no verifiable per-turn id, so always `null` / `no-turn-id`.
 */
import { parseTranscriptRef, SessionEventError, type TranscriptRef } from "../../mcp-server/src/session-events.ts";
import { SURFACES, type Surface } from "../../mcp-server/src/types.ts";

export const TRANSCRIPT_REF_NULL_REASONS = ["no-session-id", "no-turn-id", "invalid-field", "locator-mismatch", "unsupported-surface"] as const;
export type TranscriptRefNullReason = (typeof TRANSCRIPT_REF_NULL_REASONS)[number];

export type TranscriptRefResult =
	| { ref: TranscriptRef }
	/** `detail` names the offending field only (never its value). */
	| { ref: null; reason: TranscriptRefNullReason; detail?: string };

/** Cursor's conversation id shape, as `cursor-stop.ts` accepts it. */
const CURSOR_CONVERSATION_ID = /^[A-Za-z0-9-]{8,128}$/;

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function none(reason: TranscriptRefNullReason, detail?: string): TranscriptRefResult {
	return detail === undefined ? { ref: null, reason } : { ref: null, reason, detail };
}

/** `undefined` and `null` both mean "the collector did not have it". */
function has(value: unknown): boolean {
	return value !== undefined && value !== null;
}

/** Run the contract's own validator over a built candidate; a violation becomes a null with the field named. */
function finish(candidate: Rec): TranscriptRefResult {
	try {
		return { ref: parseTranscriptRef(candidate) };
	} catch (error) {
		if (error instanceof SessionEventError) {
			if (error.rule === "at_least_one_of") return none("no-turn-id");
			return none("invalid-field", error.path);
		}
		throw error;
	}
}

function pick(facts: Rec, ...keys: string[]): Rec {
	const out: Rec = {};
	for (const key of keys) {
		if (has(facts[key])) out[key] = facts[key];
	}
	return out;
}

/**
 * Cursor stop-hook facts: `{ conversation_id, transcript_path?, turn_no?, prefix_sha256? }`.
 * The locator is the conversation id. `transcript_path`, when present, must name `<conversation_id>.jsonl`
 * (as in `agent-transcripts/<id>/<id>.jsonl`); only its basename is looked at. Without a caller-counted
 * `turn_no` the result is `null` / `no-turn-id`, because the hook carries no per-turn id.
 */
export function cursorTranscriptRef(facts: unknown): TranscriptRefResult {
	if (!isRec(facts)) return none("invalid-field", "facts");
	const id = facts["conversation_id"];
	if (!has(id)) return none("no-session-id");
	if (typeof id !== "string" || !CURSOR_CONVERSATION_ID.test(id)) return none("invalid-field", "conversation_id");
	const path = facts["transcript_path"];
	if (has(path)) {
		if (typeof path !== "string") return none("invalid-field", "transcript_path");
		const base = path.split(/[\\/]/).pop() ?? "";
		if (base !== `${id}.jsonl`) return none("locator-mismatch", "transcript_path");
	}
	return finish({ surface: "cursor", session_locator: id, ...pick(facts, "turn_no", "prefix_sha256") });
}

/**
 * Grok Build facts, as `grok-map.ts` reads them off an event: `{ session_id, turn_number?, tool_call_id?,
 * prefix_sha256? }`. A turn number is the turn; the tool call id, when it is a plain opaque id, narrows it to
 * one tool call (`entry_id`). A tool call id that is not a plain id is left out when a turn number exists, and
 * is an `invalid-field` otherwise.
 */
export function grokTranscriptRef(facts: unknown): TranscriptRefResult {
	if (!isRec(facts)) return none("invalid-field", "facts");
	const id = facts["session_id"];
	if (!has(id)) return none("no-session-id");
	const candidate: Rec = { surface: "grok-build", session_locator: id, ...pick(facts, "prefix_sha256") };
	if (has(facts["turn_number"])) candidate["turn_no"] = facts["turn_number"];
	const toolCall = facts["tool_call_id"];
	if (has(toolCall)) {
		const probe = finish({ ...candidate, entry_id: toolCall });
		if (probe.ref !== null) return probe;
		if (!has(candidate["turn_no"]) || probe.reason !== "invalid-field" || probe.detail !== "transcript_ref.entry_id") return probe;
	}
	return finish(candidate);
}

/**
 * Surfaces whose transcript ids the caller already holds and vouches for (`omp` from `ompTranscriptRef`,
 * `claude-code` from its hook payload): `{ session_id, entry_id?, turn_no?, parent_entry_id?, prefix_sha256? }`.
 * Needs one of `entry_id` and `turn_no`; otherwise `null` / `no-turn-id`.
 */
function suppliedTranscriptRef(surface: Surface, facts: unknown): TranscriptRefResult {
	if (!isRec(facts)) return none("invalid-field", "facts");
	const id = facts["session_id"];
	if (!has(id)) return none("no-session-id");
	return finish({ surface, session_locator: id, ...pick(facts, "entry_id", "turn_no", "parent_entry_id", "prefix_sha256") });
}

/**
 * The transcript ref for `surface` from that surface's facts, or a null with its reason. `surface` is any
 * string a collector may hold: a non-member of `SURFACES` is `unsupported-surface`.
 */
export function transcriptRefFor(surface: string, facts: unknown): TranscriptRefResult {
	if (!(SURFACES as readonly string[]).includes(surface)) return none("unsupported-surface", "surface");
	switch (surface as Surface) {
		case "cursor":
			return cursorTranscriptRef(facts);
		case "grok-build":
			return grokTranscriptRef(facts);
		case "omp":
		case "claude-code":
			return suppliedTranscriptRef(surface as Surface, facts);
		default:
			// hermes, muse, codex, opencode, pi, rivet-agentos, grok-bot, substrate and the swarm-* surfaces: no
			// verifiable per-turn id exists, and inventing one would make a rollback point at the wrong moment.
			return none("no-turn-id");
	}
}
