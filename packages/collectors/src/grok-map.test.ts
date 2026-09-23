import { describe, expect, test } from "bun:test";
import { decodeSessionCwd, mapGrokEvent, type GrokEvent } from "./grok-map.ts";

const ctx = { sessionId: "01a0a66e-5cdf-7d53-9488-f869c20eea44", repo: "swcstudiospace/x", branch: "main" };

describe("decodeSessionCwd", () => {
	test("decodes the url-encoded cwd Grok uses as a directory name", () => {
		expect(decodeSessionCwd("%2Froot%2Fsrc%2Frepos")).toBe("/root/src/repos");
	});

	test("strips the trailing slash Grok sometimes leaves", () => {
		expect(decodeSessionCwd("%2Froot%2Fsrc%2Frepos%2F")).toBe("/root/src/repos");
	});

	test("rejects anything that is not an absolute path", () => {
		expect(decodeSessionCwd("not-a-path")).toBeNull();
		expect(decodeSessionCwd("%ZZ")).toBeNull();
	});
});

describe("mapGrokEvent — noise", () => {
	test("drops the types that dominate the log", () => {
		// 52,621 phase_changed against 2,550 real tool calls on this host.
		for (const type of ["phase_changed", "first_token", "loop_started", "mcp_health_check"]) {
			expect(mapGrokEvent({ type }, ctx)).toBeNull();
		}
	});

	test("drops tool_started, since tool_completed carries the outcome too", () => {
		expect(mapGrokEvent({ type: "tool_started", tool_name: "read_file" }, ctx)).toBeNull();
	});

	test("drops an allowed permission but keeps a denial", () => {
		expect(mapGrokEvent({ type: "permission_resolved", decision: "allow" }, ctx)).toBeNull();
		const denied = mapGrokEvent({ type: "permission_resolved", decision: "deny", tool_name: "bash" }, ctx);
		expect(denied?.kind).toBe("warning");
		expect(denied?.summary).toContain("deny");
	});
});

describe("mapGrokEvent — translation", () => {
	const toolCompleted: GrokEvent = {
		ts: "2026-09-15T18:57:31.009Z",
		type: "tool_completed",
		tool_name: "read_file",
		duration_ms: 1,
		outcome: "success",
		tool_call_id: "call-cdef0dd4",
	};

	test("turns a completed tool call into tool.call with context attached", () => {
		const out = mapGrokEvent(toolCompleted, ctx);
		expect(out?.kind).toBe("tool.call");
		expect(out?.summary).toBe("read_file (1ms)");
		expect(out?.surface).toBe("grok-build");
		expect(out?.session_id).toBe(ctx.sessionId);
		expect(out?.repo).toBe("swcstudiospace/x");
		expect(out?.ts).toBe("2026-09-15T18:57:31.009Z");
	});

	test("names the failure when a tool did not succeed", () => {
		const out = mapGrokEvent({ ...toolCompleted, outcome: "error" }, ctx);
		expect(out?.summary).toContain("failed: error");
	});

	test("maps a turn to a prompt", () => {
		const out = mapGrokEvent({ type: "turn_started", turn_number: 0, model_id: "grok-4.5" }, ctx);
		expect(out?.kind).toBe("prompt");
		expect(out?.summary).toBe("turn 0 started on grok-4.5");
	});

	test("maps a failed MCP server to a warning", () => {
		const out = mapGrokEvent(
			{ type: "mcp_server_failed", server_name: "aio", error_message: "spawn failed" },
			ctx,
		);
		expect(out?.kind).toBe("warning");
		expect(out?.summary).toContain("aio");
	});

	test("records an unknown type rather than losing it silently", () => {
		// Grok adds event types over time; silent loss is worse than a thin note.
		const out = mapGrokEvent({ type: "some_future_event" }, ctx);
		expect(out?.kind).toBe("note");
		expect(out?.summary).toBe("grok some_future_event");
	});

	test("drops an event with no type at all", () => {
		expect(mapGrokEvent({}, ctx)).toBeNull();
	});
});
