import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "../packages/mcp-server/src/skills/frontmatter.ts";

const STATE_PATH = join(import.meta.dir, "..", ".planning", "STATE.md");

/**
 * Problems with the STATE.md frontmatter, as the planning reader sees it: the shared `parseFrontmatter` must accept the
 * block (a fenced YAML mapping) and `milestone` and `status` must be non-empty strings. Empty means the block is sound.
 */
export function checkStateFrontmatter(text: string): string[] {
	const data = parseFrontmatter(text);
	if (data === null) return ["frontmatter is missing, unterminated, not valid YAML or not a mapping"];
	const problems: string[] = [];
	for (const key of ["milestone", "status"]) {
		const value = data[key];
		if (typeof value !== "string" || value.trim() === "") problems.push(`${key} must be a non-empty string`);
	}
	return problems;
}

describe("planning integrity", () => {
	const text = readFileSync(STATE_PATH, "utf8");

	test("STATE.md has no agent-swarm trailer lines", () => {
		const offending = text
			.split(/\r?\n/)
			.map((line, index) => ({ line, number: index + 1 }))
			.filter(({ line }) => /^swarm: /.test(line))
			.map(({ number }) => number);
		expect(offending).toEqual([]);
	});

	test("STATE.md frontmatter parses and carries a milestone and a status", () => {
		expect(checkStateFrontmatter(text)).toEqual([]);
	});

	test("the frontmatter check rejects a missing, unterminated or malformed block", () => {
		expect(checkStateFrontmatter("no frontmatter\n")).not.toEqual([]);
		expect(checkStateFrontmatter("---\nmilestone: v1\nstatus: ok\n")).not.toEqual([]);
		expect(checkStateFrontmatter("---\nmilestone: [\nstatus: ok\n---\nbody\n")).not.toEqual([]);
		expect(checkStateFrontmatter("---\n- milestone\n- status\n---\n")).not.toEqual([]);
		expect(checkStateFrontmatter("---\nmilestone: v1\n---\n")).toEqual(["status must be a non-empty string"]);
		expect(checkStateFrontmatter("---\nmilestone: v1\nstatus: ok\n---\nbody\n")).toEqual([]);
	});
});
