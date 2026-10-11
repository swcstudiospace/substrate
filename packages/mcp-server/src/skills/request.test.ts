/**
 * The pieces the REST route and the MCP tool share for a skill proposal: the body's shape,
 * the request the service takes, and how each failure maps onto a status. Pure, so the
 * cases run on literals.
 */
import { describe, expect, test } from "bun:test";
import { REDACTED } from "../redact.ts";
import { SkillProposalDenied } from "../service.ts";
import { ProposeFailed, ProposeRefused } from "./propose.ts";
import { proposalBodyProblem, proposalBodySizeProblem, proposalFailure } from "./request.ts";

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
	test("a small body fits", () => {
		expect(proposalBodySizeProblem(valid)).toBeNull();
	});

	test("the boundary is on canonical serialized UTF-8 bytes: exactly 1_000_000 fits, one more does not", () => {
		// Multibyte content, JSON escaping and metadata overhead all count. The named
		// surface is a client-owned field, so it counts toward the 1M.
		const rationale = 'café "quoted"\nnewline';
		const prefix = "---\nname: demo-skill\ndescription: a demo\n---\ncafé \"q\"\n";
		const fixed = { name: "demo-skill", rationale, surface: "claude-code", session_id: "sess-1", graph_id: "ut-1" };
		const sized = (target: number) => {
			const pad = target - Buffer.byteLength(JSON.stringify({ ...fixed, files: { "SKILL.md": prefix } }), "utf8");
			return { ...fixed, files: { "SKILL.md": prefix + "x".repeat(pad) } };
		};
		expect(proposalBodySizeProblem(sized(1_000_000))).toBeNull();
		const over = proposalBodySizeProblem(sized(1_000_001)) ?? "";
		expect(over).toContain("over the limit of 1000000 bytes");
		expect(over).not.toContain("café");
	});

	test("a 1_000_000-byte caller body without a surface fits: attribution costs nothing", () => {
		const fixed = { name: "demo-skill", rationale: "why" };
		const pad = 1_000_000 - Buffer.byteLength(JSON.stringify({ ...fixed, files: { "SKILL.md": "" } }), "utf8");
		const wire = { ...fixed, files: { "SKILL.md": "x".repeat(pad) } };
		expect(Buffer.byteLength(JSON.stringify(wire), "utf8")).toBe(1_000_000);
		expect(proposalBodySizeProblem(wire)).toBeNull();
	});
});

describe("proposalFailure", () => {
	test("a denial keeps its status and message", () => {
		expect(proposalFailure(new SkillProposalDenied(401, "no surface"))).toEqual({ status: 401, body: { error: "no surface" } });
		expect(proposalFailure(new SkillProposalDenied(403, "wrong surface"))).toEqual({ status: 403, body: { error: "wrong surface" } });
	});

	test("a refusal is 400 and its findings are file, line and rule, nothing more", () => {
		const refusal = new ProposeRefused("secret-like content in 1 place(s)", [
			{ file: "SKILL.md", line: 4, rule: "github", extra: "never copied" } as never,
		]);
		const failure = proposalFailure(refusal);
		expect(failure).toEqual({
			status: 400,
			body: { error: "secret-like content in 1 place(s)", findings: [{ file: "SKILL.md", line: 4, rule: "github" }] },
		});
		expect(JSON.stringify(failure)).not.toContain("never copied");
	});

	test("a refusal without findings has no findings key", () => {
		expect(proposalFailure(new ProposeRefused("invalid skill name"))).toEqual({ status: 400, body: { error: "invalid skill name" } });
	});

	test("a failed git or gh step is 502, redacted and capped at 400 characters", () => {
		// Assembled at run time so no token-shaped literal sits in the repository.
		const token = `ghp_${"C".repeat(36)}`;
		const failure = proposalFailure(new ProposeFailed(`git push exited 1: GITHUB_TOKEN=${token} ${"x".repeat(900)}`));
		expect(failure?.status).toBe(502);
		expect(failure?.body.error.length).toBeLessThanOrEqual(400);
		expect(failure?.body.error).not.toContain(token);
		expect(failure?.body.error).toContain(REDACTED);
	});

	test("an error that is not the proposal's own is not mapped", () => {
		expect(proposalFailure(new Error("disk full"))).toBeNull();
		expect(proposalFailure("text")).toBeNull();
		expect(proposalFailure(undefined)).toBeNull();
	});
});
