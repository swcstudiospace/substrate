import { describe, expect, test } from "bun:test";
import { parseTranscriptRef } from "../../mcp-server/src/session-events.ts";
import { SURFACES } from "../../mcp-server/src/types.ts";
import { cursorTranscriptRef, grokTranscriptRef, transcriptRefFor, type TranscriptRefResult } from "./transcript-ref.ts";

// Synthetic ids only: nothing here is taken from a real session.
const CURSOR_ID = "11111111-2222-3333-4444-555555555555";
const GROK_ID = "01900000-0000-7000-8000-00000000cccc";
const SHA = "a".repeat(64);

function refOf(result: TranscriptRefResult) {
	if (result.ref === null) throw new Error(`expected a ref, got null: ${result.reason} ${result.detail ?? ""}`);
	return result.ref;
}

describe("cursorTranscriptRef", () => {
	test("the conversation id is the locator and the path is only checked, never carried", () => {
		const path = `/home/someone/.cursor/projects/p/agent-transcripts/${CURSOR_ID}/${CURSOR_ID}.jsonl`;
		const ref = refOf(cursorTranscriptRef({ conversation_id: CURSOR_ID, transcript_path: path, turn_no: 4, prefix_sha256: SHA }));
		expect(ref).toEqual({ surface: "cursor", session_locator: CURSOR_ID, turn_no: 4, prefix_sha256: SHA });
		expect(JSON.stringify(ref)).not.toContain("someone");
		expect(JSON.stringify(ref)).not.toContain("/");
	});

	test("without a counted turn the hook carries no per-turn id: null with no-turn-id", () => {
		expect(cursorTranscriptRef({ conversation_id: CURSOR_ID, transcript_path: `/x/${CURSOR_ID}.jsonl` })).toEqual({ ref: null, reason: "no-turn-id" });
	});

	test("a missing or malformed conversation id", () => {
		expect(cursorTranscriptRef({ turn_no: 1 })).toEqual({ ref: null, reason: "no-session-id" });
		expect(cursorTranscriptRef({ conversation_id: null, turn_no: 1 })).toEqual({ ref: null, reason: "no-session-id" });
		expect(cursorTranscriptRef({ conversation_id: "short", turn_no: 1 })).toEqual({ ref: null, reason: "invalid-field", detail: "conversation_id" });
		expect(cursorTranscriptRef({ conversation_id: 42, turn_no: 1 })).toEqual({ ref: null, reason: "invalid-field", detail: "conversation_id" });
	});

	test("a transcript path that does not name this conversation is a locator-mismatch (posix and windows separators)", () => {
		expect(cursorTranscriptRef({ conversation_id: CURSOR_ID, transcript_path: "/x/other-conversation.jsonl", turn_no: 1 })).toEqual({ ref: null, reason: "locator-mismatch", detail: "transcript_path" });
		expect(cursorTranscriptRef({ conversation_id: CURSOR_ID, transcript_path: `C:\\x\\${CURSOR_ID}.jsonl`, turn_no: 1 }).ref).not.toBeNull();
		expect(cursorTranscriptRef({ conversation_id: CURSOR_ID, transcript_path: 7, turn_no: 1 })).toEqual({ ref: null, reason: "invalid-field", detail: "transcript_path" });
	});

	test("an invalid turn number or digest is named, not repaired", () => {
		expect(cursorTranscriptRef({ conversation_id: CURSOR_ID, turn_no: -1 })).toEqual({ ref: null, reason: "invalid-field", detail: "transcript_ref.turn_no" });
		expect(cursorTranscriptRef({ conversation_id: CURSOR_ID, turn_no: 1.5 })).toMatchObject({ ref: null, reason: "invalid-field" });
		expect(cursorTranscriptRef({ conversation_id: CURSOR_ID, turn_no: 1, prefix_sha256: "XYZ" })).toEqual({ ref: null, reason: "invalid-field", detail: "transcript_ref.prefix_sha256" });
	});

	test("unknown keys, such as message content, are ignored and never copied", () => {
		const ref = refOf(cursorTranscriptRef({ conversation_id: CURSOR_ID, turn_no: 2, prompt: "synthetic secret prompt", content: "synthetic secret body" }));
		expect(JSON.stringify(ref)).not.toContain("secret");
	});

	test("facts that are not an object", () => {
		for (const facts of [null, undefined, "x", 3, [1]]) {
			expect(cursorTranscriptRef(facts)).toEqual({ ref: null, reason: "invalid-field", detail: "facts" });
		}
	});
});

describe("grokTranscriptRef", () => {
	test("session id, turn number and tool call id map to locator, turn_no and entry_id", () => {
		const ref = refOf(grokTranscriptRef({ session_id: GROK_ID, turn_number: 3, tool_call_id: "call_abc123" }));
		expect(ref).toEqual({ surface: "grok-build", session_locator: GROK_ID, turn_no: 3, entry_id: "call_abc123" });
	});

	test("a turn number alone is enough, and so is a tool call id alone", () => {
		expect(refOf(grokTranscriptRef({ session_id: GROK_ID, turn_number: 0 }))).toEqual({ surface: "grok-build", session_locator: GROK_ID, turn_no: 0 });
		expect(refOf(grokTranscriptRef({ session_id: GROK_ID, tool_call_id: "call_abc123" }))).toEqual({ surface: "grok-build", session_locator: GROK_ID, entry_id: "call_abc123" });
	});

	test("neither a turn nor a tool call id: null with no-turn-id", () => {
		expect(grokTranscriptRef({ session_id: GROK_ID })).toEqual({ ref: null, reason: "no-turn-id" });
	});

	test("a tool call id that is not a plain opaque id is dropped when a turn number exists and refused otherwise", () => {
		expect(refOf(grokTranscriptRef({ session_id: GROK_ID, turn_number: 5, tool_call_id: "has space|pipe" }))).toEqual({ surface: "grok-build", session_locator: GROK_ID, turn_no: 5 });
		expect(grokTranscriptRef({ session_id: GROK_ID, tool_call_id: "has space|pipe" })).toEqual({ ref: null, reason: "invalid-field", detail: "transcript_ref.entry_id" });
	});

	test("a bad turn number is refused even beside a good tool call id", () => {
		expect(grokTranscriptRef({ session_id: GROK_ID, turn_number: -2, tool_call_id: "call_abc123" })).toEqual({ ref: null, reason: "invalid-field", detail: "transcript_ref.turn_no" });
		expect(grokTranscriptRef({ session_id: GROK_ID, turn_number: "3", tool_call_id: "call_abc123" })).toMatchObject({ ref: null, reason: "invalid-field" });
	});

	test("a missing or path-shaped session id", () => {
		expect(grokTranscriptRef({ turn_number: 1 })).toEqual({ ref: null, reason: "no-session-id" });
		const result = grokTranscriptRef({ session_id: "/root/.grok/sessions/x", turn_number: 1 });
		expect(result).toEqual({ ref: null, reason: "invalid-field", detail: "transcript_ref.session_locator" });
		expect(JSON.stringify(result)).not.toContain(".grok");
	});
});

describe("transcriptRefFor", () => {
	test("dispatches cursor and grok-build to their locators", () => {
		expect(refOf(transcriptRefFor("cursor", { conversation_id: CURSOR_ID, turn_no: 1 })).surface).toBe("cursor");
		expect(refOf(transcriptRefFor("grok-build", { session_id: GROK_ID, turn_number: 1 })).surface).toBe("grok-build");
	});

	test("omp and claude-code use the ids the caller vouches for", () => {
		const omp = refOf(transcriptRefFor("omp", { session_id: GROK_ID, entry_id: "a1b2c3d4", turn_no: 2, parent_entry_id: "f0e1d2c3", prefix_sha256: SHA }));
		expect(omp).toEqual({ surface: "omp", session_locator: GROK_ID, entry_id: "a1b2c3d4", turn_no: 2, parent_entry_id: "f0e1d2c3", prefix_sha256: SHA });
		expect(refOf(transcriptRefFor("claude-code", { session_id: GROK_ID, turn_no: 7 }))).toEqual({ surface: "claude-code", session_locator: GROK_ID, turn_no: 7 });
		expect(transcriptRefFor("omp", { session_id: GROK_ID })).toEqual({ ref: null, reason: "no-turn-id" });
		expect(transcriptRefFor("claude-code", { entry_id: "a1b2c3d4" })).toEqual({ ref: null, reason: "no-session-id" });
		expect(transcriptRefFor("claude-code", null)).toEqual({ ref: null, reason: "invalid-field", detail: "facts" });
	});

	test("every other surface has no verifiable per-turn id, even when ids are offered", () => {
		const offered = { session_id: GROK_ID, conversation_id: CURSOR_ID, entry_id: "a1b2c3d4", turn_no: 1, turn_number: 1 };
		const covered = new Set<string>(["cursor", "grok-build", "omp", "claude-code"]);
		const others = SURFACES.filter((surface) => !covered.has(surface));
		expect(others).toContain("hermes");
		expect(others).toContain("muse");
		expect(others).toContain("grok-bot");
		expect(others).toContain("swarm-a05-be");
		for (const surface of others) {
			expect(transcriptRefFor(surface, offered)).toEqual({ ref: null, reason: "no-turn-id" });
		}
	});

	test("a string that is not a surface is unsupported-surface", () => {
		expect(transcriptRefFor("herdr", { session_id: GROK_ID, turn_no: 1 })).toEqual({ ref: null, reason: "unsupported-surface", detail: "surface" });
	});

	test("every ref produced passes parseTranscriptRef unchanged", () => {
		const results = [
			transcriptRefFor("cursor", { conversation_id: CURSOR_ID, turn_no: 1, prefix_sha256: SHA }),
			transcriptRefFor("grok-build", { session_id: GROK_ID, turn_number: 2, tool_call_id: "call_1" }),
			transcriptRefFor("omp", { session_id: GROK_ID, entry_id: "a1b2c3d4" }),
			transcriptRefFor("claude-code", { session_id: GROK_ID, turn_no: 3 }),
		];
		for (const result of results) {
			const ref = refOf(result);
			expect(parseTranscriptRef(ref)).toEqual(ref);
		}
	});
});
