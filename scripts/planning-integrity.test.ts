import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseStatePart } from "../packages/mcp-server/src/planning/position.ts";
import { parseFrontmatter } from "../packages/mcp-server/src/skills/frontmatter.ts";
import { brokenRelativeLinks } from "./docs-lint.ts";

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

/**
 * The Current Position prose says no phase is open (`Phase: none ...`) but the planning reader still reports one: the reader
 * prefers the frontmatter's `current_phase` and clears it only for a `status` of exactly `complete`, `completed` or `archived`,
 * so a closed project whose status is a sentence keeps showing its last phase in `planning_status`. Empty means consistent.
 */
export function checkClosedStateHasNoPhase(text: string): string[] {
	if (!/^Phase:[ \t]*(?:none|n\/a|null)\b/im.test(text)) return [];
	const parsed = parseStatePart(text);
	if (!parsed.ok) return ["the planning reader could not parse STATE.md"];
	return parsed.part.phase === null ? [] : [`the prose says no phase is open, but the reader reports phase ${parsed.part.phase.number}: set status to complete, completed or archived, or clear current_phase`];
}

const MILESTONES_DIR = join(import.meta.dir, "..", ".planning", "milestones");

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

	test("a STATE.md that says no phase is open is read as having no current phase", () => {
		expect(checkClosedStateHasNoPhase(text)).toEqual([]);
	});

	test("the closed-state check catches a sentence status that keeps the last phase alive, and accepts a recognised closed status", () => {
		const body = "## Current Position\n\nPhase: none open. The milestone is archived.\nPlan: —\n";
		const sentence = `---\nmilestone: v1.6\nstatus: "Awaiting next milestone"\ncurrent_phase: 62\ncurrent_phase_name: soak-and-close\n---\n${body}`;
		expect(checkClosedStateHasNoPhase(sentence)).toHaveLength(1);
		expect(checkClosedStateHasNoPhase(sentence.replace('"Awaiting next milestone"', "archived"))).toEqual([]);
		expect(checkClosedStateHasNoPhase("---\nmilestone: v1.6\nstatus: active\ncurrent_phase: 62\n---\n## Current Position\n\nPhase: 62 (in progress)\n")).toEqual([]);
	});

	test("the frontmatter check rejects a missing, unterminated or malformed block", () => {
		expect(checkStateFrontmatter("no frontmatter\n")).not.toEqual([]);
		expect(checkStateFrontmatter("---\nmilestone: v1\nstatus: ok\n")).not.toEqual([]);
		expect(checkStateFrontmatter("---\nmilestone: [\nstatus: ok\n---\nbody\n")).not.toEqual([]);
		expect(checkStateFrontmatter("---\n- milestone\n- status\n---\n")).not.toEqual([]);
		expect(checkStateFrontmatter("---\nmilestone: v1\n---\n")).toEqual(["status must be a non-empty string"]);
		expect(checkStateFrontmatter("---\nmilestone: v1\nstatus: ok\n---\nbody\n")).toEqual([]);
	});

	test("the link check flags a link copied from the live roadmap and accepts one that resolves", () => {
		expect(brokenRelativeLinks("[a](phases/55-x/CONTEXT.md) [b](MILESTONES.md) [c](https://example.com/x) [d](#top)", MILESTONES_DIR, existsSync)).toEqual(["phases/55-x/CONTEXT.md", "MILESTONES.md"]);
		expect(brokenRelativeLinks("[a](../MILESTONES.md#v16) [b](v1.6-ROADMAP.md)", MILESTONES_DIR, existsSync)).toEqual([]);
	});
});
