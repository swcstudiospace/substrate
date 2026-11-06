import { describe, expect, test } from "bun:test";
import { MemoryWorktreeRegistry } from "./worktree-registry-fake.ts";
import { worktreeStoreContract } from "./worktree-registry.testkit.ts";
import { defined } from "./test-support.ts";
import {
	parseWorktreeListQuery,
	staleCutoff,
	validateWorktreeReport,
	WORKTREE_FILE_MAX_CHARS,
	WORKTREE_FILES_MAX,
	WORKTREE_LIST_DEFAULT_LIMIT,
	WORKTREE_LIST_MAX_LIMIT,
	WORKTREE_PATH_MAX_CHARS,
	WORKTREE_REPORT_MAX_ITEMS,
	WORKTREE_TEXT_MAX_CHARS,
} from "./worktree-registry.ts";

function worktree(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		path: "/work/as-r14-fleet",
		repo: "swcstudiospace/agent-substrate",
		branch: "gsd/r14-worktree-fleet",
		head: "0123456789abcdef0123456789abcdef01234567",
		base: "origin/main",
		dirty: false,
		ahead: 2,
		behind: 0,
		last_commit_at: "2026-10-29T08:00:00Z",
		size_bytes: 123_456,
		locked: false,
		primary: false,
		pr_state: "open",
		...overrides,
	};
}

function report(overrides: Record<string, unknown> = {}, items: unknown[] = [worktree()]): Record<string, unknown> {
	return { protocol: 1, host: "vps-1.example", reported_at: "2026-10-29T09:00:00Z", worktrees: items, ...overrides };
}

describe("validateWorktreeReport", () => {
	test("accepts a full report and returns it normalised: the head lowercased, the timestamps in UTC", () => {
		const result = validateWorktreeReport(
			report({ reported_at: "2026-10-29T10:00:00+01:00" }, [worktree({ head: "ABCDEF0123456789ABCDEF0123456789ABCDEF01", session_id: "sess-1", graph_id: "graph-1", last_commit_at: "2026-10-29T10:00:00.5+01:00" })]),
		);
		expect(result).toEqual({
			ok: true,
			value: {
				protocol: 1,
				host: "vps-1.example",
				reported_at: "2026-10-29T09:00:00.000Z",
				worktrees: [
					{
						path: "/work/as-r14-fleet",
						repo: "swcstudiospace/agent-substrate",
						branch: "gsd/r14-worktree-fleet",
						head: "abcdef0123456789abcdef0123456789abcdef01",
						base: "origin/main",
						dirty: false,
						ahead: 2,
						behind: 0,
						last_commit_at: "2026-10-29T09:00:00.500Z",
						size_bytes: 123_456,
						locked: false,
						primary: false,
						pr_state: "open",
						session_id: "sess-1",
						graph_id: "graph-1",
					},
				],
			},
		});
	});

	test("accepts the nullable members as null, a 64-character head, an empty report and the exact limits", () => {
		const nulls = validateWorktreeReport(report({}, [worktree({ branch: null, base: null, ahead: null, behind: null, last_commit_at: null, size_bytes: null, head: "f".repeat(64) })]));
		expect(nulls.ok).toBe(true);
		expect(validateWorktreeReport(report({}, [])).ok).toBe(true);
		expect(validateWorktreeReport(report({}, [worktree({ path: `/${"p".repeat(WORKTREE_PATH_MAX_CHARS - 1)}`, branch: "b".repeat(WORKTREE_TEXT_MAX_CHARS) })])).ok).toBe(true);
		const full = Array.from({ length: WORKTREE_REPORT_MAX_ITEMS }, (_, index) => worktree({ path: `/work/w${index}` }));
		const parsed = validateWorktreeReport(report({}, full));
		expect(parsed.ok && parsed.value.worktrees.length).toBe(WORKTREE_REPORT_MAX_ITEMS);
	});

	test("a member the contract does not name is ignored, never stored", () => {
		const parsed = validateWorktreeReport(report({ extra: 1 }, [worktree({ token: "x" })]));
		expect(parsed.ok && Object.keys(defined(parsed.value.worktrees[0], "the worktree")).includes("token")).toBe(false);
	});

	const refusals: Array<[string, unknown, string]> = [
		["a body that is not an object", ["x"], "request body must be a JSON object"],
		["null", null, "request body must be a JSON object"],
		["another protocol", report({ protocol: 2 }), "protocol must be 1"],
		["a missing protocol", report({ protocol: undefined }), "protocol must be 1"],
		["an empty host", report({ host: "" }), "host must be"],
		["a host with a space", report({ host: "bad host" }), "host must be"],
		["a host that starts with a hyphen", report({ host: "-host" }), "host must be"],
		["a host past 128 characters", report({ host: "h".repeat(129) }), "host must be"],
		["a host that is not a string", report({ host: 7 }), "host must be"],
		["a reported_at that is not a timestamp", report({ reported_at: "yesterday" }), "reported_at must be an ISO 8601"],
		["a reported_at with no time", report({ reported_at: "2026-10-29" }), "reported_at must be an ISO 8601"],
		["a reported_at with no offset", report({ reported_at: "2026-10-29T09:00:00" }), "reported_at must be an ISO 8601"],
		["worktrees that is not an array", report({ worktrees: {} }), "worktrees must be an array"],
		["more worktrees than the cap", report({}, Array.from({ length: WORKTREE_REPORT_MAX_ITEMS + 1 }, (_, index) => worktree({ path: `/work/w${index}` }))), "at most 500"],
		["a worktree that is not an object", report({}, [null]), "worktrees[0] must be an object"],
		["a repeated path", report({}, [worktree(), worktree({ branch: "other" })]), "worktrees[1].path repeats"],
		["a relative path", report({}, [worktree({ path: "work/a" })]), "worktrees[0].path must be an absolute path"],
		["a path with a NUL", report({}, [worktree({ path: "/work/a\u0000b" })]), "worktrees[0].path must be an absolute path"],
		["a path past 1024 characters", report({}, [worktree({ path: `/${"p".repeat(WORKTREE_PATH_MAX_CHARS)}` })]), "worktrees[0].path must be an absolute path"],
		["a path that is not a string", report({}, [worktree({ path: 3 })]), "worktrees[0].path must be an absolute path"],
		["a repo with no owner", report({}, [worktree({ repo: "agent-substrate" })]), "worktrees[0].repo must be owner/name"],
		["a repo with two slashes", report({}, [worktree({ repo: "a/b/c" })]), "worktrees[0].repo must be owner/name"],
		["a repo with a space", report({}, [worktree({ repo: "a/b c" })]), "worktrees[0].repo must be owner/name"],
		["an empty branch", report({}, [worktree({ branch: "" })]), "worktrees[0].branch must be a string"],
		["a branch past the limit", report({}, [worktree({ branch: "b".repeat(WORKTREE_TEXT_MAX_CHARS + 1) })]), "worktrees[0].branch must be a string"],
		["a branch with a newline", report({}, [worktree({ branch: "a\nb" })]), "worktrees[0].branch must be a string"],
		["a missing branch", report({}, [worktree({ branch: undefined })]), "worktrees[0].branch must be a string"],
		["a head of 39 characters", report({}, [worktree({ head: "a".repeat(39) })]), "worktrees[0].head must be 40 or 64 hex"],
		["a head that is not hex", report({}, [worktree({ head: "g".repeat(40) })]), "worktrees[0].head must be 40 or 64 hex"],
		["a head of 41 characters", report({}, [worktree({ head: "a".repeat(41) })]), "worktrees[0].head must be 40 or 64 hex"],
		["an empty base", report({}, [worktree({ base: "" })]), "worktrees[0].base must be a string"],
		["dirty as a string", report({}, [worktree({ dirty: "yes" })]), "worktrees[0].dirty must be a boolean"],
		["locked as a number", report({}, [worktree({ locked: 1 })]), "worktrees[0].locked must be a boolean"],
		["primary as null", report({}, [worktree({ primary: null })]), "worktrees[0].primary must be a boolean"],
		["a negative ahead", report({}, [worktree({ ahead: -1 })]), "worktrees[0].ahead must be a non-negative integer"],
		["a fractional behind", report({}, [worktree({ behind: 1.5 })]), "worktrees[0].behind must be a non-negative integer"],
		["ahead as a string", report({}, [worktree({ ahead: "3" })]), "worktrees[0].ahead must be a non-negative integer"],
		["an ahead past the 32-bit column", report({}, [worktree({ ahead: 2_147_483_648 })]), "worktrees[0].ahead must be a non-negative integer"],
		["a negative size", report({}, [worktree({ size_bytes: -1 })]), "worktrees[0].size_bytes must be a non-negative integer"],
		["a size past the safe integers", report({}, [worktree({ size_bytes: 2 ** 53 })]), "worktrees[0].size_bytes must be a non-negative integer"],
		["a last_commit_at that is not a timestamp", report({}, [worktree({ last_commit_at: "nope" })]), "worktrees[0].last_commit_at must be an ISO 8601"],
		["a last_commit_at that is a number", report({}, [worktree({ last_commit_at: 17 })]), "worktrees[0].last_commit_at must be an ISO 8601"],
		["an unknown pr_state", report({}, [worktree({ pr_state: "draft" })]), "worktrees[0].pr_state must be one of"],
		["a missing pr_state", report({}, [worktree({ pr_state: undefined })]), "worktrees[0].pr_state must be one of"],
		["an empty session_id", report({}, [worktree({ session_id: "" })]), "worktrees[0].session_id must be a string"],
		["a session_id as a number", report({}, [worktree({ session_id: 5 })]), "worktrees[0].session_id must be a string"],
		["a graph_id past the limit", report({}, [worktree({ graph_id: "g".repeat(WORKTREE_TEXT_MAX_CHARS + 1) })]), "worktrees[0].graph_id must be a string"],
		["a problem in a later entry is reported with its own index", report({}, [worktree(), worktree({ path: "/work/b", head: "zz" })]), "worktrees[1].head must be 40 or 64 hex"],
	];

	for (const [label, body, problem] of refusals) {
		test(`refuses ${label}`, () => {
			const result = validateWorktreeReport(body);
			expect(result.ok).toBe(false);
			expect(result.ok ? "" : result.problem).toContain(problem);
		});
	}
});

describe("validateWorktreeReport: the changed files", () => {
	/** The one worktree of a report made from `overrides`, or undefined when the report is refused. */
	function only(overrides: Record<string, unknown>) {
		const parsed = validateWorktreeReport(report({}, [worktree(overrides)]));
		return parsed.ok ? parsed.value.worktrees[0] : undefined;
	}

	test("a list is stored sorted and de-duplicated, with the truncation flag as sent", () => {
		expect(only({ files: ["b.ts", "a.ts", "b.ts"], files_truncated: true })).toMatchObject({ files: ["a.ts", "b.ts"], files_truncated: true });
	});

	test("absent stays absent, null stays null (unknown) and an empty list stays empty (touches nothing); the flag is true only beside a list", () => {
		expect(only({})).not.toHaveProperty("files");
		expect(only({})).not.toHaveProperty("files_truncated");
		expect(only({ files: null, files_truncated: true })).toMatchObject({ files: null, files_truncated: false });
		expect(only({ files: [] })).toMatchObject({ files: [], files_truncated: false });
		expect(only({ files_truncated: true })).not.toHaveProperty("files_truncated");
	});

	test("a path that breaks a rule is dropped and the entry and its other paths stay", () => {
		const files = ["ok.ts", "/absolute.ts", "", "x".repeat(WORKTREE_FILE_MAX_CHARS + 1), "new\nline", "tab\tname", "bell\u0007", "c1\u0085", "del\u007f", 7, null, { path: "a" }, "fine/also.ts"];
		expect(only({ files })).toMatchObject({ files: ["fine/also.ts", "ok.ts"] });
	});

	test("accepts exactly the cap: 200 paths of 400 characters", () => {
		const files = Array.from({ length: WORKTREE_FILES_MAX }, (_, index) => `${"x".repeat(WORKTREE_FILE_MAX_CHARS - 10)}${String(index).padStart(10, "0")}`);
		expect(only({ files })?.files).toHaveLength(WORKTREE_FILES_MAX);
	});

	const refusals: Array<[string, Record<string, unknown>, string]> = [
		["more paths than the cap", { files: Array.from({ length: WORKTREE_FILES_MAX + 1 }, (_, index) => `f${index}.ts`) }, `worktrees[0].files must hold at most ${WORKTREE_FILES_MAX} paths`],
		["files that is a string", { files: "a.ts" }, "worktrees[0].files must be an array of paths, or null"],
		["files that is an object", { files: { "a.ts": true } }, "worktrees[0].files must be an array of paths, or null"],
		["files_truncated as a string", { files: [], files_truncated: "yes" }, "worktrees[0].files_truncated must be a boolean"],
	];
	for (const [label, overrides, problem] of refusals) {
		test(`refuses ${label}`, () => {
			const result = validateWorktreeReport(report({}, [worktree(overrides)]));
			expect(result.ok).toBe(false);
			expect(result.ok ? "" : result.problem).toContain(problem);
		});
	}
});

describe("parseWorktreeListQuery", () => {
	test("an empty query is every worktree, with the default page", () => {
		expect(parseWorktreeListQuery({})).toEqual({ ok: true, value: { repo: null, host: null, state: "all", limit: WORKTREE_LIST_DEFAULT_LIMIT } });
	});

	test("accepts every filter, and a limit as a number or as the digits of a URL", () => {
		expect(parseWorktreeListQuery({ repo: "a/b", host: "h1", state: "dirty", limit: 7 })).toEqual({ ok: true, value: { repo: "a/b", host: "h1", state: "dirty", limit: 7 } });
		expect(parseWorktreeListQuery({ state: "stale", limit: "500" })).toEqual({ ok: true, value: { repo: null, host: null, state: "stale", limit: WORKTREE_LIST_MAX_LIMIT } });
	});

	const refusals: Array<[string, Record<string, unknown>, string]> = [
		["a repo with no owner", { repo: "b" }, "repo must be owner/name"],
		["an empty repo", { repo: "" }, "repo must be owner/name"],
		["a host with a slash", { host: "a/b" }, "host must be"],
		["an unknown state", { state: "merged" }, "state must be one of"],
		["a limit of zero", { limit: 0 }, "limit must be an integer from 1 to 500"],
		["a limit past the cap", { limit: 501 }, "limit must be an integer from 1 to 500"],
		["a fractional limit", { limit: 1.5 }, "limit must be an integer from 1 to 500"],
		["a limit that is words", { limit: "many" }, "limit must be an integer from 1 to 500"],
		["a negative limit", { limit: "-3" }, "limit must be an integer from 1 to 500"],
		["a limit of 0 as digits", { limit: "0" }, "limit must be an integer from 1 to 500"],
	];
	for (const [label, query, problem] of refusals) {
		test(`refuses ${label}`, () => {
			const result = parseWorktreeListQuery(query);
			expect(result.ok).toBe(false);
			expect(result.ok ? "" : result.problem).toContain(problem);
		});
	}
});

describe("staleCutoff", () => {
	test("is the idle window before now, and a fraction of a day counts", () => {
		const now = Date.parse("2026-10-29T12:00:00Z");
		expect(staleCutoff(now, 14).toISOString()).toBe("2026-10-15T12:00:00.000Z");
		expect(staleCutoff(now, 0.5).toISOString()).toBe("2026-10-29T00:00:00.000Z");
	});
});

describe("the in-memory registry satisfies the store contract", () => {
	// Each case names its own labels, so one shared store keeps the cases apart by host and repo.
	const store = new MemoryWorktreeRegistry();
	worktreeStoreContract(() => ({
		store,
		host: (label) => `mem-${label}`,
		repo: (label) => `ut-wt/${label}`,
	}));
});

describe("the repo cap in a worktree report", () => {
	test("refuses a repo over 512 code units by name, before the owner/name pattern", () => {
		const result = validateWorktreeReport(report({}, [worktree({ repo: `owner/${"r".repeat(507)}` })]));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.problem).toContain("repo_too_long: a repo may not exceed 512 code units; got 513");
	});
});
