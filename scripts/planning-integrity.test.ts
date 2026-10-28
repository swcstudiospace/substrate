import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const STATE_PATH = join(import.meta.dir, "..", ".planning", "STATE.md");

/** Lines between the opening `---` (first line) and the next `---`, or undefined when there is no complete block. */
function frontmatterLines(text: string): string[] | undefined {
	const lines = text.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return undefined;
	const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
	return close < 0 ? undefined : lines.slice(1, close);
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

	test("STATE.md opens with a frontmatter block that has milestone and status keys", () => {
		const block = frontmatterLines(text);
		expect(block).toBeDefined();
		for (const key of ["milestone", "status"]) {
			expect(block?.some((line) => line.startsWith(`${key}:`))).toBe(true);
		}
	});

	test("the frontmatter parser rejects a missing or unterminated block", () => {
		expect(frontmatterLines("no frontmatter\n")).toBeUndefined();
		expect(frontmatterLines("---\nmilestone: v1\n")).toBeUndefined();
		expect(frontmatterLines("---\nmilestone: v1\nstatus: ok\n---\nbody\n")).toEqual(["milestone: v1", "status: ok"]);
	});
});
