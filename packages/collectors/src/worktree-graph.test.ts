import { describe, expect, test } from "bun:test";
import { graphIdForWorktree, WORKTREE_ROOT, worktreeRoots } from "./worktree-graph.ts";

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

describe("several roots (SUBSTRATE_WORKTREE_ROOTS)", () => {
	const roots = ["/srv/a", "/srv/b"];

	test("a path under any configured root names its graph; the default root is no longer special", () => {
		expect(graphIdForWorktree(`/srv/a/${GID}/src`, roots)).toBe(GID);
		expect(graphIdForWorktree(`/srv/b/${GID}`, roots)).toBe(GID);
		expect(graphIdForWorktree(`${WORKTREE_ROOT}/${GID}`, roots)).toBeNull();
	});

	test("the first root that contains the path decides", () => {
		expect(graphIdForWorktree(`/srv/a/nested/${GID}`, ["/srv/a/nested", "/srv/a"])).toBe(GID);
		expect(graphIdForWorktree(`/srv/a/nested/${GID}`, ["/srv/a", "/srv/a/nested"])).toBe("nested");
	});

	test("a root itself and a sibling of a root name no graph", () => {
		expect(graphIdForWorktree("/srv/a", roots)).toBeNull();
		expect(graphIdForWorktree(`/srv/ab/${GID}`, roots)).toBeNull();
	});

	test("a single root string still works", () => {
		expect(graphIdForWorktree(`/srv/a/${GID}`, "/srv/a")).toBe(GID);
	});
});

describe("worktreeRoots", () => {
	test("defaults to the dispatcher directory when unset, empty or holding no absolute entry", () => {
		expect(worktreeRoots({})).toEqual([WORKTREE_ROOT]);
		expect(worktreeRoots({ SUBSTRATE_WORKTREE_ROOTS: "" })).toEqual([WORKTREE_ROOT]);
		expect(worktreeRoots({ SUBSTRATE_WORKTREE_ROOTS: "relative/dir: " })).toEqual([WORKTREE_ROOT]);
	});

	test("splits on colons, keeps order, drops relative and duplicate entries", () => {
		expect(worktreeRoots({ SUBSTRATE_WORKTREE_ROOTS: "/srv/a:rel:/srv/b/:/srv/a" })).toEqual(["/srv/a", "/srv/b"]);
	});

	test("the environment decides graph attribution when no roots are passed", () => {
		const saved = process.env.SUBSTRATE_WORKTREE_ROOTS;
		process.env.SUBSTRATE_WORKTREE_ROOTS = "/srv/a:/srv/b";
		try {
			expect(graphIdForWorktree(`/srv/b/${GID}`)).toBe(GID);
			expect(graphIdForWorktree(`${WORKTREE_ROOT}/${GID}`)).toBeNull();
		} finally {
			if (saved === undefined) delete process.env.SUBSTRATE_WORKTREE_ROOTS;
			else process.env.SUBSTRATE_WORKTREE_ROOTS = saved;
		}
	});
});
