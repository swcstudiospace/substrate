/**
 * The pieces the REST route and the MCP tool share for a skill proposal: the body's shape,
 * the request the service takes, and how each failure maps onto a status. Pure, so the
 * cases run on literals.
 */
import { describe, expect, test } from "bun:test";
import { REDACTED } from "../redact.ts";
import { SkillProposalDenied } from "../service.ts";
import { ProposeFailed, ProposeRefused } from "./propose.ts";
import { proposalBodyProblem, proposalBodySizeProblem, proposalFailure, toProposalRequest } from "./request.ts";

const valid = { name: "demo-skill", files: { "SKILL.md": "---\nname: demo-skill\n---\n" }, rationale: "why" };

describe("proposalBodyProblem", () => {
	test("a well-formed body, with every optional field, has no problem", () => {
		expect(proposalBodyProblem(valid)).toBeNull();
		expect(
			proposalBodyProblem({
				...valid,
				remove: ["old.md"],
				surface: "claude-code",
				session_id: "sess-1",
				graph_id: "ut-1",
				dry_run: true,
				mode: "replace",
				reopen: false,
				allow_doc_examples: ["pem", "jwt"],
			}),
		).toBeNull();
	});

	test.each([
		["not an object", "text", "body must be a JSON object"],
		["null", null, "body must be a JSON object"],
		["an array", [valid], "body must be a JSON object"],
		["name", { ...valid, name: 3 }, "name must be a string"],
		["files missing", { name: "x", rationale: "r" }, "files must be an object of relative path to text"],
		["files an array", { ...valid, files: ["SKILL.md"] }, "files must be an object of relative path to text"],
		["a binary file", { ...valid, files: { "SKILL.md": 3 } }, "every file must be a string of UTF-8 text"],
		["rationale", { ...valid, rationale: undefined }, "rationale must be a string"],
		["remove", { ...valid, remove: "old.md" }, "remove must be an array of relative paths"],
		["remove entries", { ...valid, remove: [1] }, "remove must be an array of relative paths"],
		["surface", { ...valid, surface: "not-a-surface" }, "unknown surface"],
		["session_id", { ...valid, session_id: 5 }, "session_id must be a string"],
		["graph_id", { ...valid, graph_id: {} }, "graph_id must be a string"],
		["dry_run", { ...valid, dry_run: "yes" }, "dry_run must be a boolean"],
		["reopen", { ...valid, reopen: 1 }, "reopen must be a boolean"],
		["mode", { ...valid, mode: "merge" }, "mode must be overlay or replace"],
		["allow_doc_examples", { ...valid, allow_doc_examples: ["pem", "ssh"] }, "allow_doc_examples must be an array of pem or jwt"],
		["allow_doc_examples type", { ...valid, allow_doc_examples: "pem" }, "allow_doc_examples must be an array of pem or jwt"],
	])("refuses %s", (_what, body, message) => {
		expect(proposalBodyProblem(body)).toContain(message);
	});

	test("an unknown surface is named but truncated, so a long value is not echoed back whole", () => {
		const problem = proposalBodyProblem({ ...valid, surface: "x".repeat(500) }) ?? "";
		expect(problem.length).toBeLessThan(120);
	});
});

describe("proposalBodySizeProblem", () => {
	/** A body whose serialized JSON is exactly `total` UTF-8 bytes, padded through the rationale. */
	function bodyOf(total: number, pad = "x"): Record<string, unknown> {
		const bare = Buffer.byteLength(JSON.stringify({ ...valid, rationale: "" }), "utf8");
		return { ...valid, rationale: pad.repeat((total - bare) / Buffer.byteLength(pad, "utf8")) };
	}

	test("a body of exactly the cap fits and one byte more is refused with both numbers named", () => {
		expect(proposalBodySizeProblem(bodyOf(1_000_000))).toBeNull();
		expect(proposalBodySizeProblem(bodyOf(1_000_001))).toBe("the proposal is 1000001 bytes as JSON, over the limit of 1000000 bytes");
	});

	test("the measure is UTF-8 bytes, not characters", () => {
		// Two-byte characters: the body is over the cap in bytes while its character count is well under it.
		expect(proposalBodySizeProblem(bodyOf(1_000_002, "é"))).toContain("over the limit");
	});

	test("fields the file-text cap does not count are counted", () => {
		expect(proposalBodySizeProblem({ ...valid, remove: Array.from({ length: 100_000 }, () => "old/file.md") })).toContain("over the limit");
	});
});

describe("toProposalRequest", () => {
	test("carries only what the body names", () => {
		expect(toProposalRequest(valid)).toEqual(valid);
	});

	test("carries every optional field when present", () => {
		const full = {
			...valid,
			remove: ["old.md"],
			surface: "claude-code",
			session_id: "sess-1",
			graph_id: "ut-1",
			dry_run: true,
			mode: "replace",
			reopen: true,
			allow_doc_examples: ["pem"],
		};
		expect(toProposalRequest(full)).toEqual(full as never);
	});

	test("drops a field the shape check does not know", () => {
		expect(toProposalRequest({ ...valid, writer: "hermes", token: "x" })).toEqual(valid);
	});
});

describe("proposalFailure", () => {
	test("a denial keeps its status and message", () => {
		expect(proposalFailure(new SkillProposalDenied(401, "no surface"))).toEqual({ status: 401, body: { error: "no surface", refused: true } });
		expect(proposalFailure(new SkillProposalDenied(403, "wrong surface"))).toEqual({ status: 403, body: { error: "wrong surface", refused: true } });
	});

	test("a refusal is 400 and its findings are file, line and rule, nothing more", () => {
		const refusal = new ProposeRefused("secret-like content in 1 place(s)", [
			{ file: "SKILL.md", line: 4, rule: "github", extra: "never copied" } as never,
		]);
		const failure = proposalFailure(refusal);
		expect(failure).toEqual({
			status: 400,
			body: { error: "secret-like content in 1 place(s)", refused: true, findings: [{ file: "SKILL.md", line: 4, rule: "github" }] },
		});
		expect(JSON.stringify(failure)).not.toContain("never copied");
	});

	test("a refusal without findings has no findings key", () => {
		expect(proposalFailure(new ProposeRefused("invalid skill name"))).toEqual({ status: 400, body: { error: "invalid skill name", refused: true } });
	});

	test("a failed git or gh step is 502, redacted and capped at 400 characters", () => {
		// Assembled at run time so no token-shaped literal sits in the repository.
		const token = `ghp_${"C".repeat(36)}`;
		const failure = proposalFailure(new ProposeFailed(`git push exited 1: GITHUB_TOKEN=${token} ${"x".repeat(900)}`));
		expect(failure?.status).toBe(502);
		expect(failure?.body.error.length).toBeLessThanOrEqual(400);
		expect(failure?.body.error).not.toContain(token);
		expect(failure?.body.error).toContain(REDACTED);
		expect(failure?.body).not.toHaveProperty("refused");
	});

	test("an error that is not the proposal's own is not mapped", () => {
		expect(proposalFailure(new Error("disk full"))).toBeNull();
		expect(proposalFailure("text")).toBeNull();
		expect(proposalFailure(undefined)).toBeNull();
	});
});
