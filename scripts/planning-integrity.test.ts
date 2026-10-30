import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type RoadmapTableRow, parseStatePart } from "../packages/mcp-server/src/planning/position.ts";
import { parseFrontmatter } from "../packages/mcp-server/src/skills/frontmatter.ts";
import { brokenRelativeLinks } from "./docs-lint.ts";
import { checkPlannedPhaseMerged, parsePulls, requirementsOfRoadmap } from "./planning-shipped-check.ts";

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

describe("planned phases with merged pull requests", () => {
	const row = (number: string, status: string): RoadmapTableRow => ({ milestone: "v1.7", name: `Phase ${number}`, number, status });
	const requirementsByPhase: Record<string, string[]> = {
		"63": ["ATLAS-01", "ATLAS-02"],
		"64": ["EMB-01"],
		"65": ["WATCH-01", "WATCH-02", "WATCH-03", "WATCH-04", "WATCH-05"],
		"66": ["REFLECT-01"],
		"67": ["STEER-01"],
		"68": ["FLEET-01"],
		"69": ["PROOF-01"],
		"70": ["SLO-01"],
	};
	const requirements = new Map(Object.entries(requirementsByPhase));

	test("flags the Planned and Not started phases that merged pull requests name, and not a Complete one", () => {
		const rows = [
			row("63", "Planned"),
			row("64", "Planned"),
			row("65", "Planned"),
			row("66", "Planned"),
			row("67", "Complete (PR #150)"),
			row("68", "Planned"),
			row("69", "Planned"),
			row("70", "Not started"),
		];
		const merged = [
			{ title: "feat(atlas): ATLAS-02 corpus scan", branch: "feat/atlas-02" },
			{ title: "feat(watch): WATCH-01..05 doc watch", branch: "feat/watch" },
			{ title: "Phase 66: REFLECT-01 retrieval telemetry", branch: "feat/reflect" },
			{ title: "feat(steer): STEER-01 steering command", branch: "feat/steer" },
			{ title: "feat(slo): SLO-01 golden set", branch: "feat/slo" },
		];
		const findings = checkPlannedPhaseMerged(rows, requirements, merged);
		expect(findings.map((finding) => finding.split(" ")[1])).toEqual(["63", "65", "66", "70"]);
	});

	test("phase 6 does not match phase 63, p63 or phase 6.1, and matches phase 6 and p6 as whole tokens", () => {
		const six = [row("6", "Planned")];
		const unrelated = [
			{ title: "Phase 63 corpus atlas", branch: "docs/p63" },
			{ title: "Phase 6.1 fix", branch: "fix/p6.1" },
		];
		expect(checkPlannedPhaseMerged(six, new Map(), unrelated)).toEqual([]);
		expect(checkPlannedPhaseMerged(six, new Map(), [{ title: "phase 6 cleanup", branch: "" }])).toHaveLength(1);
		expect(checkPlannedPhaseMerged(six, new Map(), [{ title: "docs", branch: "docs/p6" }])).toHaveLength(1);
	});

	test("a range names each requirement in it, and an ID outside the range does not match", () => {
		const watch = [row("65", "Planned")];
		const cases: Array<[string, number]> = [
			["WATCH-06 next", 0],
			["WATCH-03..04 docs", 1],
			["WATCH-01..WATCH-05 done", 1],
			["WATCH-01..05", 1],
		];
		for (const [title, expected] of cases) {
			expect(checkPlannedPhaseMerged(watch, requirements, [{ title, branch: "" }])).toHaveLength(expected);
		}
	});

	test("requirement IDs match as whole tokens in their exact case", () => {
		const atlas = [row("63", "Planned")];
		const cases: Array<[string, string, number]> = [
			["ATLAS-010 corpus", "", 0],
			["XATLAS-02 corpus", "", 0],
			["atlas-02 corpus", "", 0],
			["corpus", "feat/ATLAS-02-scan", 1],
		];
		for (const [title, branch, expected] of cases) {
			expect(checkPlannedPhaseMerged(atlas, requirements, [{ title, branch }])).toHaveLength(expected);
		}
	});

	test("each phase's requirement IDs come from its Requirements line, skipping fenced code, prose and sections past the phase", () => {
		const roadmap = [
			"# Roadmap",
			"## v1.7",
			"### Phase 63: Corpus Atlas",
			"**Goal**: scan the corpus",
			"**Requirements**: [ATLAS-01, ATLAS-02]",
			"#### Success criteria",
			"```",
			"**Requirements**: [FAKE-01]",
			"```",
			"### Phase 65: Doc Watch",
			"**Requirements**: [WATCH-01..05]",
			"### Phase 66: Docs Reflect",
			'**Requirements**: uplift-7 audit row "Invalid writes are rejected"',
			"## Later",
			"**Requirements**: [LATER-01]",
		].join("\n");
		const parsed = requirementsOfRoadmap(roadmap);
		expect([...parsed.keys()]).toEqual(["63", "65", "66"]);
		expect(parsed.get("63")).toEqual(["ATLAS-01", "ATLAS-02"]);
		expect(parsed.get("65")).toEqual(["WATCH-01", "WATCH-02", "WATCH-03", "WATCH-04", "WATCH-05"]);
		expect(parsed.get("66")).toEqual([]);
	});

	test("parsePulls reads gh's title and headRefName, and reports output that is not a list", () => {
		expect(parsePulls('[{"title":"feat: WATCH-01","headRefName":"feat/watch-01"}]')).toEqual([{ title: "feat: WATCH-01", branch: "feat/watch-01" }]);
		expect(typeof parsePulls("not json")).toBe("string");
		expect(typeof parsePulls('{"title":"x"}')).toBe("string");
	});
});
