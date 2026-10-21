import { describe, expect, test } from "bun:test";
import { graphIdForWorktree, WORKTREE_ROOT } from "./worktree-graph.ts";

const GID = "ut-mugzzzzz-0123abcd";

describe("graphIdForWorktree", () => {
	test("names the graph for its worktree and for any directory under it", () => {
		expect(graphIdForWorktree(`${WORKTREE_ROOT}/${GID}`)).toBe(GID);
		expect(graphIdForWorktree(`${WORKTREE_ROOT}/${GID}/packages/collectors/src`)).toBe(GID);
		expect(graphIdForWorktree(`${WORKTREE_ROOT}/${GID}/`)).toBe(GID);
	});

	test("names no graph for the root, a sibling of the root, a path that climbs out, or an unrelated repo", () => {
		expect(graphIdForWorktree(WORKTREE_ROOT)).toBeNull();
		expect(graphIdForWorktree(`${WORKTREE_ROOT}-old/${GID}`)).toBeNull();
		expect(graphIdForWorktree(`${WORKTREE_ROOT}/../${GID}`)).toBeNull();
		expect(graphIdForWorktree("/home/ops/src/agent-substrate")).toBeNull();
	});

	test("names no graph for a relative path, a missing value, or a segment that is not a plain graph id", () => {
		expect(graphIdForWorktree(`worktrees/${GID}`)).toBeNull();
		expect(graphIdForWorktree("")).toBeNull();
		expect(graphIdForWorktree(undefined)).toBeNull();
		expect(graphIdForWorktree(`${WORKTREE_ROOT}/.hidden`)).toBeNull();
		expect(graphIdForWorktree(`${WORKTREE_ROOT}/has space`)).toBeNull();
	});
});
