import { describe, expect, test } from "bun:test";
import type { WorktreeInfo } from "./inventory.ts";
import { buildReport, buildReports, MAX_REPORT_WORKTREES } from "./report.ts";

const NOW = new Date("2026-10-29T12:00:00Z");

function info(path: string, overrides: Partial<WorktreeInfo> = {}): WorktreeInfo {
	return {
		path,
		repo: "acme/widgets",
		repo_dir: "/repos/widgets",
		branch: "feat",
		head: "a".repeat(40),
		base: "b".repeat(40),
		dirty: false,
		ahead: 2,
		behind: 0,
		last_commit_at: "2026-10-01T00:00:00.000Z",
		last_activity_at: "2026-10-02T00:00:00.000Z",
		size_bytes: 4096,
		locked: false,
		primary: false,
		pr_state: "open",
		detached: false,
		prunable: false,
		default_ref: "origin/main",
		pushed: true,
		merged: false,
		pr_number: 4,
		pr_head_sha: "a".repeat(40),
		pr_merged_heads: [],
		ignored_work: [".env"],
		notes: ["note"],
		...overrides,
	};
}

describe("buildReport", () => {
	test("carries exactly the contract's fields and attributes the graph from the roots", () => {
		const report = buildReport("host-1", [info("/srv/wts/ut-mu1-abcd1234/sub")], { now: NOW, roots: ["/srv/wts"] });
		expect(report).toEqual({
			protocol: 1,
			host: "host-1",
			reported_at: "2026-10-29T12:00:00.000Z",
			worktrees: [
				{
					path: "/srv/wts/ut-mu1-abcd1234/sub",
					repo: "acme/widgets",
					branch: "feat",
					head: "a".repeat(40),
					base: "b".repeat(40),
					dirty: false,
					ahead: 2,
					behind: 0,
					last_commit_at: "2026-10-01T00:00:00.000Z",
					size_bytes: 4096,
					locked: false,
					primary: false,
					pr_state: "open",
					graph_id: "ut-mu1-abcd1234",
				},
			],
		});
	});

	test("leaves graph_id out for a path under no root, and keeps unknowns as null", () => {
		const report = buildReport("h", [info("/elsewhere/x", { branch: null, base: null, ahead: null, behind: null, size_bytes: null, last_commit_at: null })], { now: NOW, roots: ["/srv/wts"] });
		const only = report.worktrees[0];
		expect(only).not.toHaveProperty("graph_id");
		expect(only).toMatchObject({ branch: null, base: null, ahead: null, behind: null, size_bytes: null, last_commit_at: null });
	});

	test("never sends local-only facts: ignored file names, notes or merged heads", () => {
		const text = JSON.stringify(buildReport("h", [info("/p")], { now: NOW, roots: [] }));
		expect(text).not.toContain(".env");
		expect(text).not.toContain("note");
		expect(text).not.toContain("pr_merged_heads");
	});
});

describe("buildReports", () => {
	test("splits an inventory into bodies of at most the route's limit and never drops a worktree", () => {
		const inventory = Array.from({ length: MAX_REPORT_WORKTREES * 2 + 1 }, (_unused, index) => info(`/w/${index}`));
		const reports = buildReports("h", inventory, { now: NOW, roots: [] });
		expect(reports.map((report) => report.worktrees.length)).toEqual([MAX_REPORT_WORKTREES, MAX_REPORT_WORKTREES, 1]);
		expect(buildReport("h", inventory, { now: NOW, roots: [] }).worktrees).toHaveLength(MAX_REPORT_WORKTREES);
	});

	test("an empty inventory is one empty report", () => {
		expect(buildReports("h", [], { now: NOW })[0]?.worktrees).toEqual([]);
	});
});
