import { describe, expect, test } from "bun:test";
import type { WorktreeInfo } from "./inventory.ts";
import { validateWorktreeReport, WORKTREE_FILE_MAX_CHARS, WORKTREE_FILES_MAX, WORKTREE_REPORT_MAX_BYTES } from "../../mcp-server/src/worktree-registry.ts";
import { buildReport, buildReports, claimedSessions, MAX_REPORT_BYTES, MAX_REPORT_WORKTREES } from "./report.ts";
import type { ClaimsFn, ClaimsLookup, LiveClaim } from "./claims.ts";
import { defined } from "./testkit.ts";

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
	const bodyBytes = (report: unknown): number => Buffer.byteLength(JSON.stringify(report), "utf8");

	test("splits an inventory into bodies of at most the route's row limit and never drops a worktree", () => {
		const inventory = Array.from({ length: MAX_REPORT_WORKTREES * 2 + 1 }, (_unused, index) => info(`/w/${index}`));
		const { reports, skipped } = buildReports("h", inventory, { now: NOW, roots: [] });
		expect(reports.map((report) => report.worktrees.length)).toEqual([MAX_REPORT_WORKTREES, MAX_REPORT_WORKTREES, 1]);
		expect(skipped).toEqual([]);
		expect(buildReport("h", inventory, { now: NOW, roots: [] }).worktrees).toHaveLength(MAX_REPORT_WORKTREES);
	});

	test("long non-ASCII paths split a batch on encoded bytes long before the row limit, in order, every body under the route's limit", () => {
		// 1000 characters of 3 bytes each: 500 rows would be about 1.5 MB, over the route's 1,000,000 bytes.
		const inventory = Array.from({ length: MAX_REPORT_WORKTREES }, (_unused, index) => info(`/${"\u65e5".repeat(1000)}/${index}`));
		const { reports, skipped } = buildReports("h", inventory, { now: NOW, roots: [] });
		expect(skipped).toEqual([]);
		expect(reports.length).toBeGreaterThan(1);
		for (const report of reports) {
			expect(report.worktrees.length).toBeLessThan(MAX_REPORT_WORKTREES);
			expect(bodyBytes(report)).toBeLessThanOrEqual(MAX_REPORT_BYTES);
			expect(bodyBytes(report)).toBeLessThan(WORKTREE_REPORT_MAX_BYTES);
		}
		expect(reports.flatMap((report) => report.worktrees.map((row) => row.path))).toEqual(inventory.map((item) => item.path));
	});

	test("a row the route would refuse for a field limit is skipped with the route's reason, and the other rows are still reported", () => {
		const longBranch = info("/b", { branch: "x".repeat(300) });
		const longPath = info(`/${"p".repeat(1100)}`);
		const { reports, skipped } = buildReports("h", [info("/a"), longBranch, longPath, info("/c")], { now: NOW, roots: [] });
		expect(skipped.map((row) => row.path)).toEqual([longBranch.path, longPath.path]);
		expect(skipped[0]?.reason).toContain("branch");
		expect(skipped[1]?.reason).toContain("path");
		expect(reports.flatMap((report) => report.worktrees.map((row) => row.path))).toEqual(["/a", "/c"]);
		// The CLI counts session_id on posted rows only. A skipped row, even one a scan had attributed, is not in a body.
		const sessions = new Map([["/a", "sess-1"], ["/b", "A05@r1:ut-1"]]);
		const attributed = buildReports("h", [info("/a"), info("/b", { branch: "x".repeat(300) })], { now: NOW, roots: [], sessions });
		const posted = attributed.reports.reduce((count, report) => count + report.worktrees.filter((row) => row.session_id !== undefined).length, 0);
		expect(posted).toBe(1);
		expect(attributed.reports[0]?.worktrees[0]).toMatchObject({ path: "/a", session_id: "sess-1" });
		expect(attributed.skipped.map((row) => row.path)).toEqual(["/b"]);
	});

	test("an empty inventory is one empty report", () => {
		expect(buildReports("h", [], { now: NOW }).reports[0]?.worktrees).toEqual([]);
	});
});

describe("the changed files in a report", () => {
	const bodyBytes = (report: unknown): number => Buffer.byteLength(JSON.stringify(report), "utf8");
	/** Exactly `WORKTREE_FILE_MAX_CHARS` UTF-16 units each, made of `unit` (a multi-byte character makes the encoded row larger). */
	const longFiles = (unit: string): string[] =>
		Array.from({ length: WORKTREE_FILES_MAX }, (_unused, index) => `${unit.repeat(WORKTREE_FILE_MAX_CHARS - 10)}${String(index).padStart(10, "0")}`);

	test("a listed worktree carries its files and the truncation flag, a failed listing carries null, and one never listed carries neither member", () => {
		const report = buildReport("h", [info("/w/listed", { files: ["a.ts", "b.ts"], files_truncated: true }), info("/w/failed", { files: null }), info("/w/unasked")], { now: NOW, roots: [] });
		expect(report.worktrees[0]).toMatchObject({ files: ["a.ts", "b.ts"], files_truncated: true });
		// null is "could not list", and it is sent as null: an empty list would claim the worktree touches nothing.
		expect(report.worktrees[1]).toMatchObject({ files: null, files_truncated: false });
		expect(report.worktrees[2]).not.toHaveProperty("files");
		expect(report.worktrees[2]).not.toHaveProperty("files_truncated");
	});

	test("the server's validator accepts what the builder makes, files and all", () => {
		const parsed = validateWorktreeReport(buildReport("h", [info("/w/listed", { files: ["a.ts", "b.ts"], files_truncated: true }), info("/w/failed", { files: null })], { now: NOW, roots: [] }));
		expect(parsed.ok).toBe(true);
		expect(parsed.ok && parsed.value.worktrees.map((row) => [row.files, row.files_truncated])).toEqual([
			[["a.ts", "b.ts"], true],
			[null, false],
		]);
	});

	test("a worktree at the largest list (200 paths of 400 characters, three bytes each) fits a body of its own well under the route's limit", () => {
		const plan = buildReports("h", [info("/w/one", { files: longFiles("€"), files_truncated: true })], { now: NOW, roots: [] });
		expect(plan.skipped).toEqual([]);
		expect(plan.reports).toHaveLength(1);
		const body = defined(plan.reports[0], "the body");
		expect(bodyBytes(body)).toBeLessThanOrEqual(MAX_REPORT_BYTES);
		expect(bodyBytes(body)).toBeLessThan(WORKTREE_REPORT_MAX_BYTES / 3);
		expect(validateWorktreeReport(body).ok).toBe(true);
	});

	test("a report of many worktrees at the largest list splits by encoded bytes, in order, with every body under the route's limit and nothing skipped", () => {
		const inventory = Array.from({ length: 12 }, (_unused, index) => info(`/w/big-${index}`, { files: longFiles("é"), files_truncated: true }));
		const plan = buildReports("h", inventory, { now: NOW, roots: [] });
		expect(plan.skipped).toEqual([]);
		expect(plan.reports.length).toBeGreaterThan(1);
		expect(plan.reports.flatMap((body) => body.worktrees.map((row) => row.path))).toEqual(inventory.map((item) => item.path));
		for (const body of plan.reports) {
			expect(bodyBytes(body)).toBeLessThanOrEqual(MAX_REPORT_BYTES);
			expect(validateWorktreeReport(body).ok).toBe(true);
		}
	});
});

describe("the session in a report", () => {
	const roots = ["/srv/wts"];
	const holder = (session: string) => ({ surface: "hermes", session_id: session });
	const claim = (node: string, session: string | null): LiveClaim => ({ node_id: node, holder: session === null ? null : holder(session), expires_at: "2026-10-29T13:00:00.000Z" });
	const answering =
		(table: Record<string, ClaimsLookup>, asked: string[] = []): ClaimsFn =>
		async (graphId) => {
			asked.push(graphId);
			return table[graphId] ?? { ok: true, claims: [] };
		};

	test("a report row carries the session its path was attributed to, and a row with none carries no session_id", () => {
		const sessions = new Map([["/srv/wts/g-1", "sess-1"]]);
		const report = buildReport("h", [info("/srv/wts/g-1"), info("/srv/wts/g-2")], { now: NOW, roots, sessions });
		expect(report.worktrees[0]).toMatchObject({ session_id: "sess-1", graph_id: "g-1" });
		expect(report.worktrees[1]).not.toHaveProperty("session_id");
		expect(buildReports("h", [info("/srv/wts/g-1")], { now: NOW, roots, sessions }).reports[0]?.worktrees[0]).toMatchObject({ session_id: "sess-1" });
	});

	test("one live holder session across every live claim attributes the graph's worktree", async () => {
		const lookup = answering({ "g-1": { ok: true, claims: [claim("n1", "sess-1"), claim("n2", "sess-1")] } });
		const sessions = await claimedSessions([info("/srv/wts/g-1")], roots, lookup);
		expect([...sessions]).toEqual([["/srv/wts/g-1", "sess-1"]]);
	});

	const UNATTRIBUTING: Array<[string, ClaimsLookup]> = [
		["two different holder sessions", { ok: true, claims: [claim("n1", "sess-1"), claim("n2", "sess-2")] }],
		["a live claim with no holder", { ok: true, claims: [claim("n1", "sess-1"), claim("n2", null)] }],
		["no live claim", { ok: true, claims: [] }],
		["a lookup the server did not answer", { ok: false, error: "HTTP 503" }],
		["a holder whose id is not a session id", { ok: true, claims: [claim("n1", "not a session id")] }],
	];

	test.each(UNATTRIBUTING)("%s leaves the worktree unattributed, and the report still goes out whole", async (_label, answer) => {
		const inventory = [info("/srv/wts/g-1"), info("/srv/wts/g-2")];
		const sessions = await claimedSessions(inventory, roots, answering({ "g-1": answer, "g-2": { ok: true, claims: [claim("n1", "sess-2")] } }));
		expect([...sessions]).toEqual([["/srv/wts/g-2", "sess-2"]]);
		const plan = buildReports("h", inventory, { now: NOW, roots, sessions });
		expect(plan.skipped).toEqual([]);
		expect(plan.reports.flatMap((report) => report.worktrees.map((row) => row.path))).toEqual(["/srv/wts/g-1", "/srv/wts/g-2"]);
		expect(plan.reports[0]?.worktrees[0]).not.toHaveProperty("session_id");
	});

	test("a lookup that throws is a failed lookup: the other graphs are still attributed", async () => {
		const lookup: ClaimsFn = async (graphId) => {
			if (graphId === "g-1") throw new Error("socket closed");
			return { ok: true, claims: [claim("n1", "sess-2")] };
		};
		const sessions = await claimedSessions([info("/srv/wts/g-1"), info("/srv/wts/g-2")], roots, lookup);
		expect([...sessions]).toEqual([["/srv/wts/g-2", "sess-2"]]);
	});

	test("asks once per graph, and only about worktrees that belong to a graph under the roots", async () => {
		const asked: string[] = [];
		const inventory = [info("/srv/wts/g-1"), info("/srv/wts/g-1/sub"), info("/elsewhere/x"), info("/srv/wts"), info("/srv/wts/g-2")];
		await claimedSessions(inventory, roots, answering({}, asked));
		expect(asked.sort()).toEqual(["g-1", "g-2"]);
	});
});
