/**
 * The smoke's pure helpers. The smoke itself drives a live twin and is proved by running it
 * (see `.planning/phases/21-skills-propose/21-VERIFICATION.md`); these pin the parsers it
 * trusts, so a mis-parse cannot turn a failing proof green.
 */
import { describe, expect, test } from "bun:test";
import { branchPattern, parseKeyValues, rewrittenRefs, toolReply } from "./skills-propose-smoke.ts";

describe("parseKeyValues", () => {
	test("reads key=value lines and keeps repeated keys in order", () => {
		const parsed = parseKeyValues("status=refused\nfinding=SKILL.md:4 github\nfinding=a.sh:1 aws\n\nnoise\n=orphan\n");
		expect(parsed).toEqual({ status: ["refused"], finding: ["SKILL.md:4 github", "a.sh:1 aws"] });
	});

	test("a value may itself contain =", () => {
		expect(parseKeyValues("pr_url=https://x/y?z=1\n")).toEqual({ pr_url: ["https://x/y?z=1"] });
	});

	test("an empty text has no keys", () => {
		expect(parseKeyValues("")).toEqual({});
	});
});

describe("branchPattern", () => {
	test("matches the engine's branch shape and nothing near it", () => {
		const pattern = branchPattern("cursor", "demo-skill");
		expect(pattern.test("skill/cursor/demo-skill-20261009T101530123Z-ab12")).toBe(true);
		expect(pattern.test("skill/cursor/demo-skill-20261009T101530123Z-ab1")).toBe(false);
		expect(pattern.test("skill/cursor/demo-skill-20261009T101530123Z-ab12x")).toBe(false);
		expect(pattern.test("skill/omp/demo-skill-20261009T101530123Z-ab12")).toBe(false);
		expect(pattern.test("skill/cursor/other-20261009T101530123Z-ab12")).toBe(false);
		expect(pattern.test("skill/cursor/demo-skill-2026-10-09T10:15:30.123Z-ab12")).toBe(false);
	});
});

describe("rewrittenRefs", () => {
	const zeros = "0".repeat(40);
	const sha = "a".repeat(40);
	const sha2 = "b".repeat(40);

	test("a log of creations only is clean", () => {
		expect(rewrittenRefs(`${zeros} ${sha} rehearsal 1 +0000\tbranch: Created from HEAD\n`)).toEqual([]);
		expect(rewrittenRefs("")).toEqual([]);
	});

	test("an update, such as a fast-forward or a force-push, is reported", () => {
		const update = `${sha} ${sha2} rehearsal 2 +0000\tupdate by push`;
		expect(rewrittenRefs(`${zeros} ${sha} x\n${update}\n`)).toEqual([update]);
	});
});

describe("toolReply", () => {
	const payload = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ status: "opened" }) }] } };

	test("reads a plain JSON reply", () => {
		expect(toolReply(JSON.stringify(payload))).toEqual({ isError: false, value: { status: "opened" } });
	});

	test("reads the last data frame of a server-sent-events reply, and the error flag", () => {
		const error = { ...payload, result: { ...payload.result, isError: true } };
		expect(toolReply(`event: message\ndata: ${JSON.stringify(payload)}\n\nevent: message\ndata: ${JSON.stringify(error)}\n\n`)).toEqual({
			isError: true,
			value: { status: "opened" },
		});
	});

	test("a reply with no tool result is null, so a transport error cannot pass as an answer", () => {
		expect(toolReply("{}")).toBeNull();
		expect(toolReply(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "no" } }))).toBeNull();
		expect(toolReply("not json")).toBeNull();
	});
});
