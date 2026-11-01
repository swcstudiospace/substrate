import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EmitOutcome } from "../../../collectors/src/emit.ts";
import { type CommandResult, type CommandRunner, spawnGit } from "../../../fleet/src/git.ts";
import { addWorktree, cleanupTemp, commit, defined, fakeGh, git, makeRepo, type TestRepo, tempDir, write } from "../../../fleet/src/testkit.ts";
import type { EventInput } from "../../../mcp-server/src/types.ts";
import { httpClaimsLookup, httpReportPoster, runWorktree, type PostOutcome, type WorktreeDeps } from "./command.ts";
import type { ClaimsLookup } from "../../../fleet/src/claims.ts";
import { parseWorktreeArgs } from "./args.ts";

afterAll(cleanupTemp);

const GIB = 1024 ** 3;

interface Harness {
	deps: WorktreeDeps;
	out: string[];
	err: string[];
	events: EventInput[];
	reports: Array<{ worktrees: Array<{ path: string; graph_id?: string; session_id?: string; files?: string[] | null; files_truncated?: boolean }> }>;
}

function harness(overrides: Partial<WorktreeDeps> = {}, env: Record<string, string | undefined> = {}): Harness {
	const out: string[] = [];
	const err: string[] = [];
	const events: EventInput[] = [];
	const reports: Harness["reports"] = [];
	const deps: WorktreeDeps = {
		env,
		cwd: tempDir(),
		host: "test-host",
		out: (text) => out.push(text),
		err: (text) => err.push(text),
		git: spawnGit,
		gh: fakeGh({}),
		// Far enough ahead that a worktree created in the test is idle for any threshold below.
		now: () => new Date(Date.now() + 60 * 24 * 3600 * 1000),
		freeBytes: () => 100 * GIB,
		emit: async (event): Promise<EmitOutcome> => {
			events.push(event);
			return { kind: "stored" };
		},
		postReport: async (report): Promise<PostOutcome> => {
			reports.push(report);
			return { ok: true, stored: report.worktrees.length };
		},
		claims: async () => ({ ok: true, claims: [] }),
		...overrides,
	};
	return { deps, out, err, events, reports };
}

interface Fleet {
	repo: TestRepo;
	root: string;
	merged: string;
	review: string;
	mergedToo: string;
}

/** A primary checkout, two merged-and-pushed worktrees, and one pushed but unmerged ("review"). */
function fleet(): Fleet {
	const repo = makeRepo();
	const root = join(tempDir(), "wts");
	mkdirSync(root);
	const merged = addWorktree(repo, root, "merged-a");
	const mergedToo = addWorktree(repo, root, "merged-b");
	const review = addWorktree(repo, root, "review-me");
	commit(merged, "a.txt", "a\n");
	commit(mergedToo, "b.txt", "b\n");
	commit(review, "r.txt", "r\n");
	git(review, ["push", "-q", "origin", "review-me"]);
	git(repo.dir, ["merge", "-q", "--no-ff", "-m", "merge a", "merged-a"]);
	git(repo.dir, ["merge", "-q", "--no-ff", "-m", "merge b", "merged-b"]);
	git(repo.dir, ["push", "-q", "origin", "main"]);
	return { repo, root, merged, mergedToo, review };
}

const withRoot = (root: string): Record<string, string> => ({ SUBSTRATE_WORKTREE_ROOTS: root });

/** Git's own exclude file of the repository: every worktree of it ignores the pattern, as a `.gitignore` would. */
function excludeFor(repo: TestRepo, pattern: string): void {
	write(repo.dir, ".git/info/exclude", `${pattern}\n`);
}

/** Git verbs that write to a repository or a worktree, plus the worktree, branch, remote and config forms that do. */
const WRITE_VERBS = ["add", "commit", "push", "reset", "checkout", "switch", "restore", "clean", "gc", "stash", "fetch", "pull", "merge", "rebase", "cherry-pick", "revert", "tag", "update-ref", "rm", "mv", "init", "clone", "prune"];
const BRANCH_WRITE_FLAGS = ["-d", "-D", "-m", "-M", "-c", "-C", "-f", "-u", "--delete", "--move", "--copy", "--force", "--set-upstream-to", "--unset-upstream"];

/** Whether a recorded git call could change a repository, a worktree, a branch, a remote or its configuration. */
function isWrite(args: string[]): boolean {
	if (WRITE_VERBS.includes(args[0] ?? "")) return true;
	if (args[0] === "worktree") return args[1] !== "list";
	if (args[0] === "branch") return args.some((arg) => BRANCH_WRITE_FLAGS.includes(arg));
	if (args[0] === "remote") return ["add", "remove", "rm", "rename", "set-head", "set-url", "prune"].includes(args[1] ?? "");
	if (args[0] === "config") return !args.some((arg) => arg === "--get" || arg === "--list" || arg === "-l");
	return false;
}

describe("usage and roots", () => {
	test("with no configured root the commands say so and exit 2", async () => {
		for (const command of ["list", "scan", "prune", "disk", "conflicts", "merge-back"]) {
			const h = harness();
			expect(await runWorktree([command], h.deps)).toBe(2);
			expect(h.err.join("")).toContain("SUBSTRATE_WORKTREE_ROOTS");
		}
	});

	test("an unknown subcommand or a flag the subcommand does not take is refused before anything runs", async () => {
		const h = harness({}, withRoot("/nowhere"));
		expect(await runWorktree(["frobnicate"], h.deps)).toBe(2);
		expect(await runWorktree(["list", "--force"], h.deps)).toBe(2);
		expect(await runWorktree(["list", "--execute"], h.deps)).toBe(2);
		expect(await runWorktree(["prune", "--idle-days"], h.deps)).toBe(2);
		expect(await runWorktree(["prune", "--idle-days", "soon"], harness({}, withRoot("/nowhere")).deps)).toBe(2);
	});

	test("--root repeats and --root=DIR works", () => {
		const parsed = parseWorktreeArgs(["list", "--root", "/a", "--root=/b", "--json"]);
		expect(parsed).toMatchObject({ ok: true, args: { roots: ["/a", "/b"], json: true } });
	});

	test("--session belongs to scan alone and needs a value", () => {
		expect(parseWorktreeArgs(["scan", "--report", "--session", "sess-1"])).toMatchObject({ ok: true, args: { report: true, session: "sess-1" } });
		expect(parseWorktreeArgs(["scan", "--report", "--session=sess-2"])).toMatchObject({ ok: true, args: { session: "sess-2" } });
		expect(parseWorktreeArgs(["prune", "--session", "sess-1"]).ok).toBe(false);
		expect(parseWorktreeArgs(["scan", "--report", "--session"]).ok).toBe(false);
	});
});

describe("list", () => {
	test("shows every worktree git knows, with its prune class, and filters by repository", async () => {
		const f = fleet();
		// list takes its idle threshold from the environment; a tiny one makes a just-made worktree idle.
		const h = harness({}, { ...withRoot(f.root), SUBSTRATE_WORKTREE_IDLE_DAYS: "0.0001" });
		expect(await runWorktree(["list", "--json"], h.deps)).toBe(0);
		const rows: Array<{ path: string; repo: string; prune: { class: string } }> = JSON.parse(h.out.join(""));
		const classOf = (path: string) => rows.find((row) => row.path === path)?.prune.class;
		expect(classOf(f.merged)).toBe("safe");
		expect(classOf(f.review)).toBe("review");
		expect(classOf(f.repo.dir)).toBe("never");
		expect(rows.every((row) => row.repo === "acme/widgets")).toBe(true);

		const none = harness({}, withRoot(f.root));
		await runWorktree(["status", "--repo", "someone/else"], none.deps);
		expect(none.out.join("")).toContain("no worktrees found");
	});
});

describe("prune", () => {
	test("is a dry run without --execute: it lists the classes and removes nothing", async () => {
		const f = fleet();
		const h = harness({}, withRoot(f.root));
		expect(await runWorktree(["prune", "--idle-days", "0"], h.deps)).toBe(0);
		const text = h.out.join("");
		expect(text).toContain("safe (2)");
		expect(text).toContain("review (1)");
		expect(text).toContain("never (1)");
		expect(text).toContain("dry run: 2 worktrees would be removed");
		expect([f.merged, f.mergedToo, f.review].every((path) => existsSync(path))).toBe(true);
		expect(h.events).toEqual([]);
	});

	test("--execute removes only the safe worktrees, without --force, and writes one ledger note each", async () => {
		const f = fleet();
		const removeCalls: string[][] = [];
		const spy: CommandRunner = async (args, cwd) => {
			if (args[0] === "worktree" && args[1] === "remove") removeCalls.push(args);
			return spawnGit(args, cwd);
		};
		const h = harness({ git: spy }, withRoot(f.root));
		expect(await runWorktree(["prune", "--execute", "--idle-days", "0"], h.deps)).toBe(0);
		expect(existsSync(f.merged)).toBe(false);
		expect(existsSync(f.mergedToo)).toBe(false);
		expect(existsSync(f.review)).toBe(true);
		expect(existsSync(f.repo.dir)).toBe(true);
		expect(removeCalls).toEqual([
			["worktree", "remove", f.merged],
			["worktree", "remove", f.mergedToo],
		]);
		expect(h.events).toHaveLength(2);
		expect(h.events[0]).toMatchObject({ kind: "note", repo: "acme/widgets", branch: "merged-a", payload: { action: "worktree.prune", path: f.merged, class: "safe" } });
	});

	test("a worktree that became dirty after the inventory is checked again and left alone", async () => {
		const f = fleet();
		const statusCalls = new Map<string, number>();
		const racing: CommandRunner = async (args, cwd) => {
			if (args[0] === "status" && args[1] === "--porcelain" && cwd === f.merged) {
				const count = (statusCalls.get(cwd) ?? 0) + 1;
				statusCalls.set(cwd, count);
				// The second status is the re-check right before removal.
				if (count === 2) write(f.merged, "late-work.txt", "unsaved\n");
			}
			return spawnGit(args, cwd);
		};
		const h = harness({ git: racing }, withRoot(f.root));
		expect(await runWorktree(["prune", "--execute", "--idle-days", "0"], h.deps)).toBe(0);
		expect(existsSync(join(f.merged, "late-work.txt"))).toBe(true);
		expect(existsSync(f.mergedToo)).toBe(false);
		expect(h.events.map((event) => event.payload?.path)).toEqual([f.mergedToo]);
		expect(h.err.join("")).toContain("no longer safe");
	});

	test("the first failed removal stops the run, is reported and is not retried", async () => {
		const f = fleet();
		const attempts: string[] = [];
		const failing: CommandRunner = async (args, cwd) => {
			if (args[0] === "worktree" && args[1] === "remove") {
				attempts.push(args[2] ?? "");
				return { code: 1, stdout: "", stderr: "fatal: cannot remove: boom" };
			}
			return spawnGit(args, cwd);
		};
		const h = harness({ git: failing }, withRoot(f.root));
		expect(await runWorktree(["prune", "--execute", "--idle-days", "0"], h.deps)).toBe(1);
		expect(attempts).toHaveLength(1);
		expect(h.err.join("")).toContain("boom");
		expect(h.events).toEqual([]);
		expect(existsSync(f.merged) && existsSync(f.mergedToo)).toBe(true);
	});

	test("a worktree inside the current directory is never removed", async () => {
		const f = fleet();
		const h = harness({ cwd: join(f.merged, "sub") }, withRoot(f.root));
		mkdirSync(join(f.merged, "sub"));
		expect(await runWorktree(["prune", "--execute", "--idle-days", "0"], h.deps)).toBe(0);
		expect(existsSync(f.merged)).toBe(true);
		expect(existsSync(f.mergedToo)).toBe(false);
	});

	test("with the default threshold a freshly used worktree is not idle", async () => {
		const f = fleet();
		const h = harness({ now: () => new Date() }, withRoot(f.root));
		expect(await runWorktree(["prune", "--json"], h.deps)).toBe(0);
		const result: { worktrees: Array<{ path: string; class: string }> } = JSON.parse(h.out.join(""));
		expect(defined(result.worktrees.find((row) => row.path === f.merged), "row").class).toBe("review");
	});

	test("a worktree with ignored local notes that differ from the primary is review, not safe", async () => {
		const f = fleet();
		write(f.repo.dir, ".gitignore", ".planning/\n");
		git(f.repo.dir, ["add", ".gitignore"]);
		git(f.repo.dir, ["commit", "-q", "-m", "ignore planning"]);
		git(f.repo.dir, ["push", "-q", "origin", "main"]);
		const fresh = addWorktree(f.repo, f.root, "notes-wt");
		write(fresh, ".planning/STATE.md", "only here\n");
		const h = harness({}, withRoot(f.root));
		expect(await runWorktree(["prune", "--json", "--idle-days", "0"], h.deps)).toBe(0);
		const result: { worktrees: Array<{ path: string; class: string; reasons: string[] }> } = JSON.parse(h.out.join(""));
		const row = defined(result.worktrees.find((item) => item.path === fresh), "row");
		expect(row.class).toBe("review");
		expect(row.reasons.join(" ")).toContain("ignored-files: .planning/STATE.md");
	});

	test("a clean merged worktree is still removed when the repository tracks .planning/", async () => {
		const f = fleet();
		write(f.repo.dir, ".planning/ROADMAP.md", "# roadmap\n");
		git(f.repo.dir, ["add", ".planning/ROADMAP.md"]);
		git(f.repo.dir, ["commit", "-q", "-m", "track planning"]);
		git(f.repo.dir, ["push", "-q", "origin", "main"]);
		git(f.merged, ["merge", "-q", "--ff-only", "main"]);
		expect(existsSync(join(f.merged, ".planning", "ROADMAP.md"))).toBe(true);
		const h = harness({}, withRoot(f.root));
		expect(await runWorktree(["prune", "--execute", "--json", "--idle-days", "0"], h.deps)).toBe(0);
		const result: { removed: Array<{ path: string }>; skipped: Array<{ path: string; reasons: string[] }> } = JSON.parse(h.out.join(""));
		expect(result.skipped).toEqual([]);
		expect(result.removed.map((item) => item.path).sort()).toEqual([f.merged, f.mergedToo].sort());
		expect(existsSync(f.merged)).toBe(false);
		expect(existsSync(f.mergedToo)).toBe(false);
	});

	test("a linked worktree nested in a regenerable ignored directory keeps the outer worktree, and the reason names it", async () => {
		const f = fleet();
		excludeFor(f.repo, "node_modules/");
		mkdirSync(join(f.merged, "node_modules"));
		const inner = addWorktree(f.repo, join(f.merged, "node_modules"), "inner");
		write(inner, "unsaved.txt", "work\n");
		const h = harness({}, withRoot(f.root));
		expect(await runWorktree(["prune", "--execute", "--json", "--idle-days", "0"], h.deps)).toBe(0);
		const result: { removed: Array<{ path: string }>; skipped: Array<{ path: string; reasons: string[] }> } = JSON.parse(h.out.join(""));
		expect(result.skipped).toEqual([{ path: f.merged, reasons: [`contains linked worktree ${inner}`] }]);
		expect(result.removed.map((item) => item.path)).toEqual([f.mergedToo]);
		expect(existsSync(join(inner, "unsaved.txt"))).toBe(true);
	});

	test("an ignored file the primary does not hold keeps its worktree, and the reason names the file", async () => {
		const f = fleet();
		excludeFor(f.repo, ".env");
		write(f.merged, ".env", "TOKEN=merged\n");
		const dry = harness({}, withRoot(f.root));
		expect(await runWorktree(["prune", "--json", "--idle-days", "0"], dry.deps)).toBe(0);
		const review: { worktrees: Array<{ path: string; class: string; reasons: string[] }> } = JSON.parse(dry.out.join(""));
		const row = defined(review.worktrees.find((item) => item.path === f.merged), "row");
		expect(row.class).toBe("review");
		expect(row.reasons).toContain("ignored-files: .env");
		const h = harness({}, withRoot(f.root));
		expect(await runWorktree(["prune", "--execute", "--json", "--idle-days", "0"], h.deps)).toBe(0);
		const result: { removed: Array<{ path: string }>; skipped: Array<{ path: string; reasons: string[] }> } = JSON.parse(h.out.join(""));
		expect(result.skipped).toEqual([]);
		expect(result.removed.map((item) => item.path)).toEqual([f.mergedToo]);
		expect(existsSync(join(f.merged, ".env"))).toBe(true);
	});

	test("an ignored file the primary holds with identical bytes does not block removal", async () => {
		const f = fleet();
		excludeFor(f.repo, ".env");
		write(f.merged, ".env", "TOKEN=same\n");
		write(f.repo.dir, ".env", "TOKEN=same\n");
		const h = harness({}, withRoot(f.root));
		expect(await runWorktree(["prune", "--execute", "--json", "--idle-days", "0"], h.deps)).toBe(0);
		const result: { removed: Array<{ path: string }>; skipped: Array<{ path: string; reasons: string[] }> } = JSON.parse(h.out.join(""));
		expect(result.skipped).toEqual([]);
		expect(result.removed.map((item) => item.path).sort()).toEqual([f.merged, f.mergedToo].sort());
	});

	test("a regenerable node_modules directory does not block removal", async () => {
		const f = fleet();
		excludeFor(f.repo, "node_modules/");
		write(f.merged, "node_modules/pkg/index.js", "module.exports = 1;\n");
		const h = harness({}, withRoot(f.root));
		expect(await runWorktree(["prune", "--execute", "--json", "--idle-days", "0"], h.deps)).toBe(0);
		const result: { removed: Array<{ path: string }>; skipped: Array<{ path: string; reasons: string[] }> } = JSON.parse(h.out.join(""));
		expect(result.skipped).toEqual([]);
		expect(result.removed.map((item) => item.path).sort()).toEqual([f.merged, f.mergedToo].sort());
	});
});

describe("scan", () => {
	test("--report posts the inventory in the route's shape and says how many were stored", async () => {
		const f = fleet();
		const h = harness({}, withRoot(f.root));
		expect(await runWorktree(["scan", "--report"], h.deps)).toBe(0);
		expect(h.reports).toHaveLength(1);
		expect(h.reports[0]?.worktrees.map((wt) => wt.path).sort()).toEqual([f.repo.dir, f.merged, f.mergedToo, f.review].sort());
		expect(h.out.join("")).toContain("reported to the registry: 4 stored");
	});

	test("--report carries each worktree's changed files and the truncation flag, and a scan that does not report never lists them", async () => {
		const f = fleet();
		write(f.review, "scratch/new.txt", "u\n");
		const big = addWorktree(f.repo, f.root, "big-one");
		for (let count = 0; count < 201; count += 1) write(big, `bulk/f${String(count).padStart(3, "0")}.txt`, "x\n");
		git(big, ["add", "-A"]);
		git(big, ["commit", "-q", "-m", "bulk"]);

		const h = harness({}, withRoot(f.root));
		expect(await runWorktree(["scan", "--report"], h.deps)).toBe(0);
		const rows = new Map(defined(h.reports[0], "the report").worktrees.map((wt) => [wt.path, wt]));
		// The merged worktrees and the primary checkout changed nothing against the default branch: an empty list, not null.
		expect(rows.get(f.merged)).toMatchObject({ files: [], files_truncated: false });
		expect(rows.get(f.repo.dir)).toMatchObject({ files: [], files_truncated: false });
		expect(rows.get(f.review)).toMatchObject({ files: ["r.txt", "scratch/new.txt"], files_truncated: false });
		expect(rows.get(big)?.files).toHaveLength(200);
		expect(rows.get(big)?.files_truncated).toBe(true);

		const calls: string[][] = [];
		const quiet = harness(
			{
				git: async (args, cwd) => {
					calls.push(args);
					return spawnGit(args, cwd);
				},
			},
			withRoot(f.root),
		);
		expect(await runWorktree(["scan"], quiet.deps)).toBe(0);
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.some((args) => args[0] === "diff")).toBe(false);
	});

	test("without --report nothing is posted, and a failed post is a non-zero exit", async () => {
		const f = fleet();
		const quiet = harness({}, withRoot(f.root));
		expect(await runWorktree(["scan"], quiet.deps)).toBe(0);
		expect(quiet.reports).toEqual([]);
		const broken = harness({ postReport: async () => ({ ok: false, error: "HTTP 503" }) }, withRoot(f.root));
		expect(await runWorktree(["scan", "--report"], broken.deps)).toBe(1);
		expect(broken.err.join("")).toContain("HTTP 503");
	});

	test("the poster sends the bearer, treats a non-2xx as a failure and reads the stored count", async () => {
		const seen: Array<{ url: string; auth: string | null }> = [];
		const ok = httpReportPoster({
			url: "http://substrate.invalid",
			token: "bearer-for-test",
			timeoutMs: 1000,
			fetchImpl: async (input, init) => {
				seen.push({ url: String(input), auth: new Headers(init.headers).get("authorization") });
				return new Response(JSON.stringify({ stored: 3 }), { status: 200 });
			},
		});
		const report = { protocol: 1 as const, host: "h", reported_at: "2026-10-29T00:00:00.000Z", worktrees: [] };
		expect(await ok(report)).toEqual({ ok: true, stored: 3 });
		expect(seen[0]).toEqual({ url: "http://substrate.invalid/worktrees/report", auth: "Bearer bearer-for-test" });
		const refused = httpReportPoster({ url: "http://x", token: undefined, timeoutMs: 1000, fetchImpl: async () => new Response("no", { status: 403 }) });
		expect(await refused(report)).toEqual({ ok: false, error: "HTTP 403" });
		const down = httpReportPoster({
			url: "http://x",
			token: undefined,
			timeoutMs: 1000,
			fetchImpl: async () => {
				throw new Error("connect refused");
			},
		});
		expect(await down(report)).toEqual({ ok: false, error: "server unreachable" });
	});
});

describe("scan --report session attribution", () => {
	/** The rows that went out with a session, as [path, session], in path order. */
	function attributed(h: Harness): Array<[string, string]> {
		const rows = defined(h.reports[0], "the report").worktrees;
		return rows.flatMap((wt): Array<[string, string]> => (wt.session_id === undefined ? [] : [[wt.path, wt.session_id]])).sort(([a], [b]) => a.localeCompare(b));
	}
	/** One live claim per given holder session (`null`: a claim nobody holds), each on its own node. */
	const holding = (...sessions: Array<string | null>): ClaimsLookup => ({
		ok: true,
		claims: sessions.map((session, index) => ({ node_id: `node-${index}`, holder: session === null ? null : { surface: "hermes", session_id: session }, expires_at: "2026-10-29T13:00:00.000Z" })),
	});

	test("--session attributes exactly the worktree that holds the current directory, a subdirectory of it included", async () => {
		const f = fleet();
		mkdirSync(join(f.review, "deep", "er"), { recursive: true });
		const h = harness({ cwd: join(f.review, "deep", "er") }, withRoot(f.root));
		expect(await runWorktree(["scan", "--report", "--session", "sess-9", "--json"], h.deps)).toBe(0);
		expect(attributed(h)).toEqual([[f.review, "sess-9"]]);
		expect(h.reports[0]?.worktrees).toHaveLength(4);
		const summary: { attributed: number } = JSON.parse(h.out.join(""));
		expect(summary.attributed).toBe(1);
	});

	test("the deepest worktree wins when one sits inside another, and the primary checkout is attributed from its own directory", async () => {
		const f = fleet();
		mkdirSync(join(f.repo.dir, ".nested"));
		const nested = addWorktree(f.repo, join(f.repo.dir, ".nested"), "inner");
		const inside = harness({ cwd: nested }, withRoot(f.root));
		expect(await runWorktree(["scan", "--report", "--session", "sess-in"], inside.deps)).toBe(0);
		expect(attributed(inside)).toEqual([[nested, "sess-in"]]);

		const primary = harness({ cwd: f.repo.dir }, withRoot(f.root));
		expect(await runWorktree(["scan", "--report", "--session", "sess-main"], primary.deps)).toBe(0);
		expect(attributed(primary)).toEqual([[f.repo.dir, "sess-main"]]);
	});

	test("a current directory in no scanned worktree attributes nothing: one warning on stderr, exit 0, and the report still goes out", async () => {
		const f = fleet();
		const h = harness({}, withRoot(f.root));
		expect(await runWorktree(["scan", "--report", "--session", "sess-lost"], h.deps)).toBe(0);
		expect(attributed(h)).toEqual([]);
		expect(h.reports[0]?.worktrees).toHaveLength(4);
		const warnings = h.err.join("").split("\n").filter((line) => line.startsWith("warning:"));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("sess-lost");
	});

	const REFUSED: Array<[string, string[], Record<string, string>]> = [
		["--session with a control character", ["--session", "bad\nid"], {}],
		["--session empty", ["--session", ""], {}],
		["--session longer than 255 characters", ["--session", "a".repeat(256)], {}],
		["--session without --report", ["--session", "sess-1"], {}],
		["a SUBSTRATE_SESSION_ID that is not a registry label", ["--report"], { SUBSTRATE_SESSION_ID: "bad\nid" }],
	];

	test.each(REFUSED)("%s is a usage error: exit 2, nothing scanned or posted", async (_label, flags, extraEnv) => {
		const f = fleet();
		const h = harness({ cwd: f.review }, { ...withRoot(f.root), ...extraEnv });
		expect(await runWorktree(["scan", ...flags], h.deps)).toBe(2);
		expect(h.reports).toEqual([]);
		expect(h.err.join("")).toMatch(/session/i);
	});

	test("a swarm holder session is a registry label and is attributed", async () => {
		const f = fleet();
		const h = harness({ cwd: f.review }, withRoot(f.root));
		expect(await runWorktree(["scan", "--report", "--session", "A05@r1:ut-1", "--json"], h.deps)).toBe(0);
		expect(attributed(h)).toEqual([[f.review, "A05@r1:ut-1"]]);
		expect(JSON.parse(h.out.join(""))).toMatchObject({ attributed: 1 });
	});


	test("SUBSTRATE_SESSION_ID is used when the flag is absent, a blank one is no attribution, and the flag wins over it", async () => {
		const f = fleet();
		const fromEnv = harness({ cwd: f.review }, { ...withRoot(f.root), SUBSTRATE_SESSION_ID: "sess-env" });
		expect(await runWorktree(["scan", "--report"], fromEnv.deps)).toBe(0);
		expect(attributed(fromEnv)).toEqual([[f.review, "sess-env"]]);

		const blank = harness({ cwd: f.review }, { ...withRoot(f.root), SUBSTRATE_SESSION_ID: "  " });
		expect(await runWorktree(["scan", "--report"], blank.deps)).toBe(0);
		expect(attributed(blank)).toEqual([]);

		const both = harness({ cwd: f.review }, { ...withRoot(f.root), SUBSTRATE_SESSION_ID: "sess-env" });
		expect(await runWorktree(["scan", "--report", "--session", "sess-flag"], both.deps)).toBe(0);
		expect(attributed(both)).toEqual([[f.review, "sess-flag"]]);
	});

	test("an env session in a scan that does not report is ignored, not refused", async () => {
		const f = fleet();
		const h = harness({ cwd: f.review }, { ...withRoot(f.root), SUBSTRATE_SESSION_ID: "bad id" });
		expect(await runWorktree(["scan"], h.deps)).toBe(0);
		expect(h.reports).toEqual([]);
	});

	test("a live claim naming one session attributes its graph's worktree with no flag at all", async () => {
		const f = fleet();
		const asked: string[] = [];
		const claims: WorktreeDeps["claims"] = async (graphId) => {
			asked.push(graphId);
			return graphId === "review-me" ? holding("sess-claim") : { ok: true, claims: [] };
		};
		const h = harness({ claims }, withRoot(f.root));
		expect(await runWorktree(["scan", "--report"], h.deps)).toBe(0);
		expect(attributed(h)).toEqual([[f.review, "sess-claim"]]);
		// One request per graph under the root; the primary checkout is outside it and is never asked about.
		expect(asked.sort()).toEqual(["merged-a", "merged-b", "review-me"]);
	});

	test("an explicit session beats a claim-derived one for its worktree; the other worktrees keep their claim-derived session", async () => {
		const f = fleet();
		const claims: WorktreeDeps["claims"] = async (graphId) => (graphId === "review-me" ? holding("sess-claim") : graphId === "merged-a" ? holding("sess-other") : { ok: true, claims: [] });
		const h = harness({ cwd: f.review, claims }, withRoot(f.root));
		expect(await runWorktree(["scan", "--report", "--session", "sess-own"], h.deps)).toBe(0);
		const expected: Array<[string, string]> = [
			[f.review, "sess-own"],
			[f.merged, "sess-other"],
		];
		expect(attributed(h)).toEqual(expected.sort(([a], [b]) => a.localeCompare(b)));
	});

	const NOT_ATTRIBUTING: Array<[string, ClaimsLookup]> = [
		["two holder sessions", holding("sess-a", "sess-b")],
		["a claim with no holder", holding(null)],
		["no live claim", { ok: true, claims: [] }],
		["a lookup that failed", { ok: false, error: "HTTP 503" }],
	];

	test.each(NOT_ATTRIBUTING)("%s leaves the worktree unattributed and the report goes out whole", async (_label, answer) => {
		const f = fleet();
		const h = harness({ claims: async () => answer }, withRoot(f.root));
		expect(await runWorktree(["scan", "--report"], h.deps)).toBe(0);
		expect(attributed(h)).toEqual([]);
		expect(h.reports[0]?.worktrees).toHaveLength(4);
	});
});

describe("conflicts", () => {
	test("names conflicting pairs, the overlap files and a merge order for one repository named by directory", async () => {
		const repo = makeRepo();
		commit(repo.dir, "shared.txt", "one\ntwo\nthree\n");
		git(repo.dir, ["push", "-q", "origin", "main"]);
		const root = tempDir();
		const a = addWorktree(repo, root, "a");
		const b = addWorktree(repo, root, "b");
		commit(a, "shared.txt", "A\ntwo\nthree\n");
		commit(b, "shared.txt", "B\ntwo\nthree\n");
		const h = harness();
		expect(await runWorktree(["conflicts", "--repo", repo.dir], h.deps)).toBe(0);
		const text = h.out.join("");
		expect(text).toContain("CONFLICT in shared.txt");
		expect(text).toContain("suggested merge order");
		expect(text).toContain("rebase");
		expect(git(a, ["status", "--porcelain"])).toBe("");
	});

	test("--repo owner/name that is an ordinary subfolder of the current checkout still searches the configured roots", async () => {
		const repo = makeRepo();
		commit(repo.dir, "shared.txt", "one\ntwo\nthree\n");
		git(repo.dir, ["push", "-q", "origin", "main"]);
		const root = tempDir();
		const a = addWorktree(repo, root, "a");
		const b = addWorktree(repo, root, "b");
		commit(a, "shared.txt", "A\ntwo\nthree\n");
		commit(b, "shared.txt", "B\ntwo\nthree\n");
		// The repository's identity is `owner/name`, as for a GitHub clone; set after the push, which needs the local origin.
		git(repo.dir, ["remote", "set-url", "origin", "git@github.com:owner/name.git"]);
		// The current directory is another checkout where `owner/name` is a plain folder: git answers there, but it is not a checkout root.
		const other = makeRepo();
		mkdirSync(join(other.dir, "owner", "name"), { recursive: true });
		const h = harness({ cwd: other.dir }, { SUBSTRATE_WORKTREE_ROOTS: root });
		expect(await runWorktree(["conflicts", "--repo", "owner/name"], h.deps)).toBe(0);
		expect(h.out.join("")).toContain("CONFLICT in shared.txt");
	});

	test("--repo naming a checkout whose directory name ends in a space is still a checkout root", async () => {
		const original = makeRepo();
		commit(original.dir, "shared.txt", "one\ntwo\nthree\n");
		git(original.dir, ["push", "-q", "origin", "main"]);
		// Moved before any linked worktree exists, so no worktree records the old path.
		const spaced = `${original.dir} `;
		renameSync(original.dir, spaced);
		const repo: TestRepo = { ...original, dir: spaced };
		const root = tempDir();
		const a = addWorktree(repo, root, "a");
		const b = addWorktree(repo, root, "b");
		commit(a, "shared.txt", "A\ntwo\nthree\n");
		commit(b, "shared.txt", "B\ntwo\nthree\n");
		const h = harness();
		expect(await runWorktree(["conflicts", "--repo", spaced], h.deps)).toBe(0);
		expect(h.out.join("")).toContain("CONFLICT in shared.txt");
	});

	test("--repo naming a link to the primary checkout selects that repository", async () => {
		const repo = makeRepo();
		commit(repo.dir, "shared.txt", "one\ntwo\nthree\n");
		git(repo.dir, ["push", "-q", "origin", "main"]);
		const root = tempDir();
		const a = addWorktree(repo, root, "a");
		const b = addWorktree(repo, root, "b");
		commit(a, "shared.txt", "A\ntwo\nthree\n");
		commit(b, "shared.txt", "B\ntwo\nthree\n");
		const link = join(tempDir(), "primary-link");
		symlinkSync(repo.dir, link);
		const h = harness();
		expect(await runWorktree(["conflicts", "--repo", link], h.deps)).toBe(0);
		expect(h.out.join("")).toContain("CONFLICT in shared.txt");
	});
});

describe("provision", () => {
	test("refuses below the free-disk floor and creates nothing", async () => {
		const repo = makeRepo();
		const root = join(tempDir(), "wts");
		const calls: string[][] = [];
		const spy: CommandRunner = async (args, cwd) => {
			calls.push(args);
			return spawnGit(args, cwd);
		};
		const h = harness({ git: spy, freeBytes: () => 1 * GIB }, withRoot(root));
		expect(await runWorktree(["provision", "--repo", repo.dir, "--branch", "feature/x"], h.deps)).toBe(1);
		expect(h.err.join("")).toContain("refused");
		expect(existsSync(root)).toBe(false);
		expect(calls.some((args) => args[0] === "worktree" && args[1] === "add")).toBe(false);
	});

	test("the floor follows SUBSTRATE_WORKTREE_MIN_FREE_GB", async () => {
		const repo = makeRepo();
		const root = join(tempDir(), "wts");
		const h = harness({ freeBytes: () => 8 * GIB }, { ...withRoot(root), SUBSTRATE_WORKTREE_MIN_FREE_GB: "10" });
		expect(await runWorktree(["provision", "--repo", repo.dir, "--branch", "b1"], h.deps)).toBe(1);
		const ok = harness({ freeBytes: () => 8 * GIB }, { ...withRoot(root), SUBSTRATE_WORKTREE_MIN_FREE_GB: "2" });
		expect(await runWorktree(["provision", "--repo", repo.dir, "--branch", "b1"], ok.deps)).toBe(0);
	});

	test("creates the branch and the worktree under the first root, from the default branch", async () => {
		const repo = makeRepo();
		const root = join(tempDir(), "wts");
		const h = harness({}, withRoot(root));
		expect(await runWorktree(["provision", "--repo", repo.dir, "--branch", "feature/x"], h.deps)).toBe(0);
		const created = join(root, "feature-x");
		expect(existsSync(join(created, "README.md"))).toBe(true);
		expect(git(created, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature/x");
	});

	test("refuses a bad branch name, a missing repository and a missing destination", async () => {
		const repo = makeRepo();
		const h = harness({}, withRoot(join(tempDir(), "wts")));
		expect(await runWorktree(["provision", "--repo", repo.dir, "--branch", "bad..name"], h.deps)).toBe(2);
		expect(await runWorktree(["provision", "--repo", join(tempDir(), "nope"), "--branch", "ok"], h.deps)).toBe(2);
		expect(await runWorktree(["provision", "--repo", repo.dir], h.deps)).toBe(2);
		expect(await runWorktree(["provision", "--repo", repo.dir, "--branch", "ok"], harness().deps)).toBe(2);
	});
});

describe("disk", () => {
	test("reports free space against the floor and the largest worktrees", async () => {
		const f = fleet();
		const ok = harness({ freeBytes: () => 50 * GIB }, withRoot(f.root));
		expect(await runWorktree(["disk"], ok.deps)).toBe(0);
		expect(ok.out.join("")).toContain("ok");
		const low = harness({ freeBytes: () => 1 * GIB }, withRoot(f.root));
		expect(await runWorktree(["disk", "--json"], low.deps)).toBe(0);
		const pressure: { ok: boolean; worktrees: unknown[] } = JSON.parse(low.out.join(""));
		expect(pressure.ok).toBe(false);
		expect(pressure.worktrees).toHaveLength(3);
	});
});

const MIB = 1024 * 1024;

/** A claim as the route reports it. */
const CLAIM = { node_id: "n1", holder: { surface: "hermes", session_id: "s-1" }, expires_at: "2026-10-29T13:00:00.000Z" };

interface PruneJson {
	worktrees: Array<{ path: string; class: string; reasons: string[]; claims: { state: string } }>;
	would_free_bytes: number;
}

describe("prune and live graph claims", () => {
	test("a live claim makes a graph checkout never; the server is asked only about otherwise-safe worktrees under a root", async () => {
		const f = fleet();
		const asked: string[] = [];
		const h = harness(
			{
				claims: async (graphId) => {
					asked.push(graphId);
					return { ok: true, claims: graphId === "merged-a" ? [CLAIM] : [] };
				},
			},
			withRoot(f.root),
		);
		expect(await runWorktree(["prune", "--json", "--idle-days", "0"], h.deps)).toBe(0);
		const result: PruneJson = JSON.parse(h.out.join(""));
		const row = (path: string) => defined(result.worktrees.find((item) => item.path === path), "row");
		expect(row(f.merged)).toMatchObject({ class: "never", claims: { state: "live" } });
		expect(row(f.merged).reasons.join(" ")).toContain("live claim on graph merged-a");
		expect(row(f.mergedToo)).toMatchObject({ class: "safe", claims: { state: "none", graph_id: "merged-b" } });
		expect(row(f.review).claims.state).toBe("not-checked");
		expect(row(f.repo.dir).claims.state).toBe("not-checked");
		expect(asked.sort()).toEqual(["merged-a", "merged-b"]);
	});

	test("a lookup that cannot be answered is review with claims-unverified, and --execute removes nothing", async () => {
		const f = fleet();
		const h = harness({ claims: async () => ({ ok: false, error: "server unreachable" }) }, withRoot(f.root));
		expect(await runWorktree(["prune", "--json", "--idle-days", "0"], h.deps)).toBe(0);
		const result: PruneJson = JSON.parse(h.out.join(""));
		for (const path of [f.merged, f.mergedToo]) {
			const row = defined(result.worktrees.find((item) => item.path === path), "row");
			expect(row.class).toBe("review");
			expect(row.reasons.join(" ")).toContain("claims-unverified");
			expect(row.claims.state).toBe("unverified");
		}
		const executing = harness({ claims: async () => ({ ok: false, error: "HTTP 503" }) }, withRoot(f.root));
		expect(await runWorktree(["prune", "--execute", "--idle-days", "0"], executing.deps)).toBe(0);
		expect(existsSync(f.merged) && existsSync(f.mergedToo)).toBe(true);
		expect(executing.events).toEqual([]);
	});

	test("--execute asks again right before each removal: a claim taken after the inventory keeps that worktree", async () => {
		const f = fleet();
		const calls = new Map<string, number>();
		const h = harness(
			{
				claims: async (graphId) => {
					const count = (calls.get(graphId) ?? 0) + 1;
					calls.set(graphId, count);
					// The first answer is the inventory's; the second is the check before removal.
					return { ok: true, claims: graphId === "merged-a" && count >= 2 ? [CLAIM] : [] };
				},
			},
			withRoot(f.root),
		);
		expect(await runWorktree(["prune", "--execute", "--idle-days", "0"], h.deps)).toBe(0);
		expect(existsSync(f.merged)).toBe(true);
		expect(existsSync(f.mergedToo)).toBe(false);
		expect(calls.get("merged-a")).toBe(2);
		expect(h.err.join("")).toContain("live claim on graph merged-a");
	});

	test("a worktree outside every root has no claim to ask about", async () => {
		const f = fleet();
		const asked: string[] = [];
		const h = harness({
			claims: async (graphId) => {
				asked.push(graphId);
				return { ok: false, error: "never asked" };
			},
		});
		expect(await runWorktree(["prune", "--json", "--idle-days", "0", "--root", f.repo.dir], h.deps)).toBe(0);
		expect(asked).toEqual([]);
	});
});

describe("prune reloads the worktree's identity before it trusts a merge proof", () => {
	test("a branch that gained a commit after the inventory is not removed on the strength of its old merged pull request", async () => {
		const repo = makeRepo();
		const root = join(tempDir(), "wts");
		mkdirSync(root);
		const wt = addWorktree(repo, root, "squashed");
		const merged = commit(wt, "s.txt", "1\n");
		git(wt, ["push", "-q", "origin", "squashed"]);
		// A squash merge leaves a different commit on main; only the pull request's head equals the branch head.
		commit(repo.dir, "s.txt", "1\n", "squash of squashed");
		git(repo.dir, ["push", "-q", "origin", "main"]);
		const gh = fakeGh({ squashed: [{ state: "MERGED", headRefOid: merged, number: 11 }] });
		let listings = 0;
		const racing: CommandRunner = async (args, cwd) => {
			if (args[0] === "worktree" && args[1] === "list") {
				listings += 1;
				// The second listing is the reload right before removal: another session commits just before it.
				if (listings === 2) commit(wt, "later.txt", "unpushed work\n");
			}
			return spawnGit(args, cwd);
		};
		const h = harness({ git: racing, gh }, withRoot(root));
		expect(await runWorktree(["prune", "--execute", "--idle-days", "0"], h.deps)).toBe(0);
		expect(listings).toBeGreaterThanOrEqual(2);
		expect(existsSync(join(wt, "later.txt"))).toBe(true);
		expect(h.err.join("")).toContain("not pushed");
		expect(h.events).toEqual([]);
	});

	test("a worktree git no longer lists is skipped, not removed", async () => {
		const f = fleet();
		let listings = 0;
		const vanishing: CommandRunner = async (args, cwd) => {
			if (args[0] === "worktree" && args[1] === "list") {
				listings += 1;
				if (listings >= 2) return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
			}
			return spawnGit(args, cwd);
		};
		const h = harness({ git: vanishing }, withRoot(f.root));
		expect(await runWorktree(["prune", "--execute", "--idle-days", "0"], h.deps)).toBe(0);
		expect(existsSync(f.merged) && existsSync(f.mergedToo)).toBe(true);
		expect(h.err.join("")).toContain("no longer lists");
	});
});

describe("prune reports the space it certainly frees", () => {
	/** Ignored node_modules in every worktree of the fleet, so a big file there does not make a worktree dirty. */
	function ignoringFleet(): Fleet {
		const f = fleet();
		write(f.repo.dir, ".git/info/exclude", "node_modules/\n");
		return f;
	}

	function bigFile(path: string): void {
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, randomBytes(MIB));
	}

	test("a file also linked from outside the removed worktrees is not counted as freed, though it is part of the worktree's size", async () => {
		const f = ignoringFleet();
		const cache = tempDir();
		bigFile(join(cache, "shared.bin"));
		mkdirSync(join(f.merged, "node_modules"));
		linkSync(join(cache, "shared.bin"), join(f.merged, "node_modules", "shared.bin"));
		bigFile(join(f.mergedToo, "node_modules", "own.bin"));
		const h = harness({}, withRoot(f.root));
		expect(await runWorktree(["prune", "--json", "--idle-days", "0"], h.deps)).toBe(0);
		const result: Omit<PruneJson, "worktrees"> & { worktrees: Array<{ path: string; size_bytes: number }> } = JSON.parse(h.out.join(""));
		const size = (path: string) => defined(result.worktrees.find((item) => item.path === path), "row").size_bytes;
		expect(size(f.merged)).toBeGreaterThanOrEqual(MIB);
		expect(size(f.mergedToo)).toBeGreaterThanOrEqual(MIB);
		expect(result.would_free_bytes).toBeGreaterThanOrEqual(MIB);
		expect(result.would_free_bytes).toBeLessThan(1.5 * MIB);
	});

	test("a file linked only between worktrees that are removed together is freed once", async () => {
		const f = ignoringFleet();
		bigFile(join(f.merged, "node_modules", "dep.bin"));
		mkdirSync(join(f.mergedToo, "node_modules"));
		linkSync(join(f.merged, "node_modules", "dep.bin"), join(f.mergedToo, "node_modules", "dep.bin"));
		const h = harness({}, withRoot(f.root));
		expect(await runWorktree(["prune", "--execute", "--json", "--idle-days", "0"], h.deps)).toBe(0);
		const result: { removed: unknown[]; freed_bytes: number } = JSON.parse(h.out.join(""));
		expect(result.removed).toHaveLength(2);
		expect(result.freed_bytes).toBeGreaterThanOrEqual(MIB);
		expect(result.freed_bytes).toBeLessThan(1.5 * MIB);
	});

	test("with a link to something that stays, --execute frees only what nothing else links to", async () => {
		const f = ignoringFleet();
		const cache = tempDir();
		bigFile(join(cache, "shared.bin"));
		mkdirSync(join(f.merged, "node_modules"));
		linkSync(join(cache, "shared.bin"), join(f.merged, "node_modules", "shared.bin"));
		const h = harness({}, withRoot(f.root));
		expect(await runWorktree(["prune", "--execute", "--json", "--idle-days", "0"], h.deps)).toBe(0);
		const result: { removed: unknown[]; freed_bytes: number } = JSON.parse(h.out.join(""));
		expect(result.removed).toHaveLength(2);
		expect(result.freed_bytes).toBeLessThan(MIB / 2);
		expect(existsSync(join(cache, "shared.bin"))).toBe(true);
	});
});

describe("prune says whether each ledger note was recorded", () => {
	test("--execute --json carries each note's delivery result per removed worktree, and a note that was not recorded is warned about on stderr", async () => {
		const f = fleet();
		const outcomes: EmitOutcome[] = [{ kind: "stored" }, { kind: "failed", error: "connect refused", spooled: true }];
		let next = 0;
		const h = harness({ emit: async (): Promise<EmitOutcome> => outcomes[next++] ?? { kind: "stored" } }, withRoot(f.root));
		expect(await runWorktree(["prune", "--execute", "--json", "--idle-days", "0"], h.deps)).toBe(0);
		const result: { removed: Array<{ path: string; ledger: string }> } = JSON.parse(h.out.join(""));
		expect(result.removed.map((item) => [item.path, item.ledger])).toEqual([
			[f.merged, "stored"],
			[f.mergedToo, "spooled"],
		]);
		expect(h.err.join("")).toContain("NOT RECORDED");
		expect(h.err.join("")).toContain("connect refused");
	});

	test("a refused or unanswered note is `refused` or `failed`; a fully recorded run warns about nothing", async () => {
		const refused = fleet();
		const a = harness({ emit: async (): Promise<EmitOutcome> => ({ kind: "refused", status: 403 }) }, withRoot(refused.root));
		await runWorktree(["prune", "--execute", "--json", "--idle-days", "0"], a.deps);
		expect((JSON.parse(a.out.join("")) as { removed: Array<{ ledger: string }> }).removed.map((item) => item.ledger)).toEqual(["refused", "refused"]);
		expect(a.err.join("")).toContain("refused (HTTP 403)");

		const down = fleet();
		const b = harness({ emit: async (): Promise<EmitOutcome> => ({ kind: "failed" }) }, withRoot(down.root));
		await runWorktree(["prune", "--execute", "--json", "--idle-days", "0"], b.deps);
		expect((JSON.parse(b.out.join("")) as { removed: Array<{ ledger: string }> }).removed.map((item) => item.ledger)).toEqual(["failed", "failed"]);

		const fine = fleet();
		const c = harness({}, withRoot(fine.root));
		await runWorktree(["prune", "--execute", "--json", "--idle-days", "0"], c.deps);
		expect(c.err.join("")).not.toContain("NOT RECORDED");
	});
});

describe("conflicts: warnings and the repository that was asked for", () => {
	function twoBranches(): { repo: TestRepo; a: string; b: string } {
		const repo = makeRepo();
		commit(repo.dir, "shared.txt", "one\ntwo\nthree\n");
		git(repo.dir, ["push", "-q", "origin", "main"]);
		const root = tempDir();
		const a = addWorktree(repo, root, "a");
		const b = addWorktree(repo, root, "b");
		commit(a, "shared.txt", "A\ntwo\nthree\n");
		commit(b, "shared.txt", "B\ntwo\nthree\n");
		return { repo, a, b };
	}

	test("a forecast whose changed files could not be listed shows the warnings and is marked incomplete, in text and in --json", async () => {
		const { repo } = twoBranches();
		const failingDiff: CommandRunner = async (args, cwd) => (args[0] === "diff" ? { code: 128, stdout: "", stderr: "fatal: bad revision" } : spawnGit(args, cwd));
		const text = harness({ git: failingDiff });
		expect(await runWorktree(["conflicts", "--repo", repo.dir], text.deps)).toBe(0);
		const out = text.out.join("");
		expect(out).toContain("INCOMPLETE");
		expect(out).toContain("warning: git diff failed");
		expect(out).toContain("changes unknown");
		expect(out).not.toContain("no changes");
		expect(out).not.toContain("  no overlapping files\n");
		expect(out).toContain("the forecast is incomplete");

		const json = harness({ git: failingDiff });
		await runWorktree(["conflicts", "--repo", repo.dir, "--json"], json.deps);
		const results: Array<{ forecast: { incomplete: boolean; worktrees: Array<{ notes: string[] }> } }> = JSON.parse(json.out.join(""));
		expect(results[0]?.forecast.incomplete).toBe(true);
		expect(results[0]?.forecast.worktrees.every((entry) => entry.notes.length > 0)).toBe(true);
	});

	test("a complete forecast is not marked incomplete", async () => {
		const { repo } = twoBranches();
		const h = harness();
		await runWorktree(["conflicts", "--repo", repo.dir], h.deps);
		expect(h.out.join("")).not.toContain("INCOMPLETE");
	});

	test("--repo DIR searches that directory even when the configured roots hold other repositories", async () => {
		const { repo, a, b } = twoBranches();
		const h = harness({}, withRoot(tempDir()));
		expect(await runWorktree(["conflicts", "--repo", repo.dir, "--json"], h.deps)).toBe(0);
		const results: Array<{ forecast: { worktrees: Array<{ path: string }> } }> = JSON.parse(h.out.join(""));
		expect(results).toHaveLength(1);
		expect(results[0]?.forecast.worktrees.map((entry) => entry.path).sort()).toEqual([repo.dir, a, b].sort());
	});
});

describe("httpClaimsLookup", () => {
	const config = (fetchImpl: (url: string, init: RequestInit) => Promise<Response>, token: string | null = "bearer-for-test") => ({ url: "http://substrate.invalid", token: token ?? undefined, timeoutMs: 1000, fetchImpl });

	test("asks GET /worktrees/claims for the graph with the bearer and reads the claims", async () => {
		const seen: Array<{ url: string; method: string | undefined; auth: string | null }> = [];
		const lookup = httpClaimsLookup(
			config(async (url, init) => {
				seen.push({ url, method: init.method, auth: new Headers(init.headers).get("authorization") });
				return new Response(JSON.stringify({ graph_id: "ut-1", claims: [CLAIM] }), { status: 200 });
			}),
		);
		expect(await lookup("ut-1")).toEqual({ ok: true, claims: [CLAIM] });
		expect(seen).toEqual([{ url: "http://substrate.invalid/worktrees/claims?graph_id=ut-1", method: "GET", auth: "Bearer bearer-for-test" }]);
	});

	test("every way of not getting an answer is a failure, never an empty list of claims", async () => {
		const reply = (status: number, body: unknown) => httpClaimsLookup(config(async () => new Response(JSON.stringify(body), { status })));
		expect(await reply(503, { error: "claims.unavailable" })("ut-1")).toEqual({ ok: false, error: "HTTP 503" });
		expect(await reply(401, {})("ut-1")).toEqual({ ok: false, error: "HTTP 401" });
		expect(await reply(200, { graph_id: "another", claims: [] })("ut-1")).toEqual({ ok: false, error: "unexpected response body" });
		expect(await reply(200, { nothing: true })("ut-1")).toEqual({ ok: false, error: "unexpected response body" });
		const down = httpClaimsLookup(
			config(async () => {
				throw new Error("connect refused");
			}),
		);
		expect(await down("ut-1")).toEqual({ ok: false, error: "server unreachable" });
		let fetched = false;
		const anonymous = httpClaimsLookup(
			config(async () => {
				fetched = true;
				return new Response("{}");
			}, null),
		);
		expect((await anonymous("ut-1")).ok).toBe(false);
		expect(fetched).toBe(false);
	});
});

describe("guard", () => {
	const FAILED: CommandResult = { code: 128, stdout: "", stderr: "fatal: injected" };

	/** A workspace `<root>/{api,web}`: linked worktrees whose primary checkout sits outside the root. Both are pushed and clean. */
	function workspace(): { repo: TestRepo; root: string; api: string; web: string } {
		const repo = makeRepo();
		commit(repo.dir, ".gitignore", "local.env\n", "ignore local.env");
		git(repo.dir, ["push", "-q", "origin", "main"]);
		const root = join(tempDir(), "ws");
		mkdirSync(root);
		const api = addWorktree(repo, root, "api");
		const web = addWorktree(repo, root, "web");
		git(api, ["push", "-q", "origin", "api"]);
		git(web, ["push", "-q", "origin", "web"]);
		return { repo, root, api, web };
	}

	/** The real git with every call recorded, with the directory it ran in; `answer` may replace the result of a call. */
	function recording(answer: (args: string[]) => CommandResult | null = () => null): { git: CommandRunner; calls: string[][]; dirs: string[] } {
		const calls: string[][] = [];
		const dirs: string[] = [];
		const runner: CommandRunner = async (args, cwd) => {
			calls.push(args);
			dirs.push(cwd);
			return answer(args) ?? spawnGit(args, cwd);
		};
		return { git: runner, calls, dirs };
	}

	test("clean and pushed members pass: exit 0 and nothing refused", async () => {
		const w = workspace();
		// The root is a flag, not an environment variable: a configured root that does not exist must change nothing.
		const h = harness({}, withRoot("/nowhere"));
		expect(await runWorktree(["guard", w.root], h.deps)).toBe(0);
		expect(h.out.join("")).toContain("holds no unsaved work");
	});

	test("an unpushed commit is refused and named", async () => {
		const w = workspace();
		commit(w.api, "feature.txt", "work\n");
		const h = harness({}, withRoot("/nowhere"));
		expect(await runWorktree(["guard", w.root], h.deps)).toBe(1);
		expect(h.out.join("")).toContain(`${w.api}: 1 unpushed commit(s)`);
	});

	test("uncommitted changes are refused and named", async () => {
		const w = workspace();
		write(w.web, "scratch.txt", "draft\n");
		const h = harness({}, withRoot("/nowhere"));
		expect(await runWorktree(["guard", w.root], h.deps)).toBe(1);
		expect(h.out.join("")).toContain(`${w.web}: uncommitted changes`);
	});

	test("ignored work the primary checkout does not hold identically is refused; an identical copy is not", async () => {
		const w = workspace();
		write(w.api, "local.env", "TOKEN=1\n");
		const h = harness({}, withRoot("/nowhere"));
		expect(await runWorktree(["guard", w.root], h.deps)).toBe(1);
		expect(h.out.join("")).toContain("ignored work would be lost: local.env");
		write(w.repo.dir, "local.env", "TOKEN=1\n");
		const same = harness({}, withRoot("/nowhere"));
		expect(await runWorktree(["guard", w.root], same.deps)).toBe(0);
	});

	test("ignored files that cannot be listed are refused, never passed", async () => {
		const w = workspace();
		const { git: runner } = recording((args) => (args[0] === "ls-files" ? FAILED : null));
		const h = harness({ git: runner }, withRoot("/nowhere"));
		expect(await runWorktree(["guard", w.root], h.deps)).toBe(1);
		expect(h.out.join("")).toContain("ignored files could not all be listed");
	});

	test("a failed or unreadable probe is a refusal, never a pass", async () => {
		const w = workspace();
		const answers: Array<(args: string[]) => CommandResult | null> = [
			(args) => (args[0] === "status" ? FAILED : null),
			(args) => (args[0] === "rev-list" ? FAILED : null),
			(args) => (args[0] === "rev-list" ? { code: 0, stdout: "not a number\n", stderr: "" } : null),
		];
		for (const answer of answers) {
			const h = harness({ git: recording(answer).git }, withRoot("/nowhere"));
			expect(await runWorktree(["guard", w.root], h.deps)).toBe(1);
			expect(h.out.join("")).toContain("cannot be ruled out");
		}
	});

	test("a .planning directory in the workspace root is refused: it is outside git", async () => {
		const w = workspace();
		write(w.root, ".planning/STATE.md", "state\n");
		const h = harness({}, withRoot("/nowhere"));
		expect(await runWorktree(["guard", w.root], h.deps)).toBe(1);
		expect(h.out.join("")).toContain("workspace .planning is outside git: copy it out first");
	});

	test("the guard writes nothing: no remove, no branch delete and no other write verb is called", async () => {
		const w = workspace();
		commit(w.api, "feature.txt", "work\n");
		write(w.web, "local.env", "x\n");
		const { git: runner, calls } = recording();
		const h = harness({ git: runner }, withRoot("/nowhere"));
		expect(await runWorktree(["guard", w.root], h.deps)).toBe(1);
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.some((args) => args[0] === "worktree" && args[1] === "remove")).toBe(false);
		expect(calls.some((args) => args[0] === "branch" && (args.includes("-d") || args.includes("-D") || args.includes("--delete")))).toBe(false);
		expect(calls.filter(isWrite)).toEqual([]);
		expect(existsSync(w.api) && existsSync(w.web)).toBe(true);
	});

	test("usage: guard takes exactly one directory and no flag it does not take", async () => {
		const w = workspace();
		expect(await runWorktree(["guard"], harness().deps)).toBe(2);
		expect(await runWorktree(["guard", w.root, w.api], harness().deps)).toBe(2);
		expect(await runWorktree(["guard", "--root", w.root, w.api], harness().deps)).toBe(2);
		expect(await runWorktree(["guard", w.root, "--execute"], harness().deps)).toBe(2);
		expect(await runWorktree(["list", w.root], harness().deps)).toBe(2);
	});

	test("--json prints the verdict and the refusals", async () => {
		const w = workspace();
		commit(w.api, "feature.txt", "work\n");
		const h = harness({}, withRoot("/nowhere"));
		expect(await runWorktree(["guard", "--json", "--root", w.root], h.deps)).toBe(1);
		const body: { ok: boolean; refusals: string[] } = JSON.parse(h.out.join(""));
		expect(body.ok).toBe(false);
		expect(body.refusals).toContain(`${w.api}: 1 unpushed commit(s)`);
	});

	test("the parser takes one positional root for guard alone", () => {
		expect(parseWorktreeArgs(["guard", "/ws/one", "--json"])).toMatchObject({ ok: true, args: { command: "guard", positional: ["/ws/one"], json: true } });
		expect(parseWorktreeArgs(["guard", "--root", "/ws/one"])).toMatchObject({ ok: true, args: { roots: ["/ws/one"] } });
		expect(parseWorktreeArgs(["list", "/ws/one"]).ok).toBe(false);
		expect(parseWorktreeArgs(["guard", ""]).ok).toBe(false);
	});

	test("a root that is itself a primary checkout is refused, and its state is still reported", async () => {
		const repo = makeRepo();
		write(repo.dir, "dirty.txt", "draft\n");
		const h = harness({}, withRoot("/nowhere"));
		expect(await runWorktree(["guard", repo.dir], h.deps)).toBe(1);
		expect(h.out.join("")).toContain(`${repo.dir}: primary checkout inside the workspace: never removed by a workspace removal`);
		expect(h.out.join("")).toContain(`${repo.dir}: uncommitted changes`);
	});

	test("a nested primary checkout under the root is refused", async () => {
		const repo = makeRepo();
		const root = join(tempDir(), "ws");
		mkdirSync(join(root, "group"), { recursive: true });
		const nested = join(root, "group", "api");
		renameSync(repo.dir, nested);
		const h = harness({}, withRoot("/nowhere"));
		expect(await runWorktree(["guard", root], h.deps)).toBe(1);
		expect(h.out.join("")).toContain(`${nested}: primary checkout inside the workspace: never removed by a workspace removal`);
	});

	test("a root holding only linked worktrees, clean and pushed, is not refused as a primary", async () => {
		const w = workspace();
		const h = harness({}, withRoot("/nowhere"));
		expect(await runWorktree(["guard", w.root], h.deps)).toBe(0);
		expect(h.out.join("")).not.toContain("primary checkout");
	});

	test("untracked files are refused even when the user has told git status to hide them", async () => {
		const w = workspace();
		git(w.web, ["config", "status.showUntrackedFiles", "no"]);
		write(w.web, "notes-untracked.txt", "draft\n");
		const h = harness({}, withRoot("/nowhere"));
		expect(await runWorktree(["guard", w.root], h.deps)).toBe(1);
		expect(h.out.join("")).toContain(`${w.web}: uncommitted changes`);
	});

	test("loose files and directories beside clean members are refused", async () => {
		const w = workspace();
		write(w.root, "notes.md", "scratch\n");
		write(w.root, "scratch/plan.txt", "draft\n");
		const h = harness({}, withRoot("/nowhere"));
		expect(await runWorktree(["guard", w.root], h.deps)).toBe(1);
		const text = h.out.join("");
		expect(text).toContain(`${join(w.root, "notes.md")}: outside every git worktree`);
		expect(text).toContain(`${join(w.root, "scratch")}: outside every git worktree`);
		expect(text).not.toContain("holds no unsaved work");
	});

	test("a member holding a submodule is refused, since the submodule's files are not checked", async () => {
		const w = workspace();
		const lib = makeRepo();
		git(w.api, ["-c", "protocol.file.allow=always", "submodule", "add", lib.origin, "vendor/lib"]);
		git(w.api, ["commit", "-q", "-m", "add submodule"]);
		git(w.api, ["push", "-q", "origin", "api"]);
		const h = harness({}, withRoot("/nowhere"));
		expect(await runWorktree(["guard", w.root], h.deps)).toBe(1);
		expect(h.out.join("")).toContain(`${w.api}: contains submodule(s) at vendor/lib`);
	});

	test("a primary checkout inside the workspace is refused for its other local branches too", async () => {
		const repo = makeRepo();
		const root = join(tempDir(), "ws");
		mkdirSync(join(root, "group"), { recursive: true });
		const api = join(root, "group", "api");
		renameSync(repo.dir, api);
		git(api, ["checkout", "-q", "-b", "keep"]);
		commit(api, "keep.txt", "unique\n");
		git(api, ["checkout", "-q", "main"]);
		const h = harness({}, withRoot("/nowhere"));
		expect(await runWorktree(["guard", root], h.deps)).toBe(1);
		expect(h.out.join("")).toContain(`${api}: primary checkout inside the workspace: never removed by a workspace removal`);
		expect(h.out.join("")).not.toContain("unpushed commit");
	});

	test("worktrees of a member's repository outside the workspace are never probed", async () => {
		const w = workspace();
		const elsewhere = join(tempDir(), "elsewhere");
		mkdirSync(elsewhere);
		const decoy = addWorktree(w.repo, elsewhere, "decoy");
		const { git: runner, dirs } = recording();
		const h = harness({ git: runner }, withRoot("/nowhere"));
		expect(await runWorktree(["guard", w.root], h.deps)).toBe(0);
		expect(dirs).toContain(w.api);
		expect(dirs).not.toContain(decoy);
	});

	test("the top-level help lists guard beside the other worktree subcommands", async () => {
		const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "index.ts")], { stdout: "pipe", stderr: "pipe" });
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		expect(out).toContain("worktree list|status|scan|prune|conflicts|provision|disk|guard");
	});

	test("directory links back to the root are refused promptly and their targets are never walked", async () => {
		const w = workspace();
		symlinkSync(w.root, join(w.root, "loop-a"));
		symlinkSync(w.root, join(w.root, "loop-b"));
		const h = harness({}, withRoot("/nowhere"));
		expect(await runWorktree(["guard", w.root], h.deps)).toBe(1);
		const text = h.out.join("");
		expect(text).toContain(`${join(w.root, "loop-a")}: outside every git worktree`);
		expect(text).toContain(`${join(w.root, "loop-b")}: outside every git worktree`);
		expect(text).not.toContain(join(w.root, "loop-a", "loop-a"));
	}, 10_000);
});

describe("merge-back", () => {
	interface MergeBackJson {
		dry_run: boolean;
		recorded: Array<{ path: string; repo: string; branch: string | null; head: string; merged_via: string; ledger: string | null }>;
		refused: string[];
		reasons: Record<string, string[]>;
	}

	/** A runner that records every git call and runs it for real. */
	function recording(calls: string[][]): CommandRunner {
		return async (args, cwd) => {
			calls.push(args);
			return spawnGit(args, cwd);
		};
	}

	/** A branch cut from main, committed, pushed and merged into main: its head is on the default branch and on origin. */
	function landed(repo: TestRepo, root: string, name: string): string {
		const path = addWorktree(repo, root, name);
		commit(path, `${name}.txt`, `${name}\n`);
		git(path, ["push", "-q", "origin", name]);
		git(repo.dir, ["merge", "-q", "--no-ff", "-m", `merge ${name}`, name]);
		git(repo.dir, ["push", "-q", "origin", "main"]);
		return path;
	}

	const reasonsOf = (result: MergeBackJson, path: string): string => (result.reasons[path] ?? []).join(" | ");

	/** A `gh` that answers `pr list --head` from a table, each pull request with the branch it merged into. */
	function prGh(table: Record<string, Array<{ state: string; headRefOid: string; number: number; baseRefName: string }>>): CommandRunner {
		return async (args) => {
			const head = args[args.indexOf("--head") + 1] ?? "";
			return { code: 0, stdout: JSON.stringify(table[head] ?? []), stderr: "" };
		};
	}

	test("a dry run writes nothing, emits nothing and runs no write command", async () => {
		const f = fleet();
		const calls: string[][] = [];
		const h = harness({ git: recording(calls) }, withRoot(f.root));
		expect(await runWorktree(["merge-back", f.merged, f.mergedToo], h.deps)).toBe(0);
		expect(h.out.join("")).toContain("dry run: 2 worktrees would be recorded, 0 refused");
		expect(h.events).toEqual([]);
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.filter(isWrite)).toEqual([]);
		expect([f.merged, f.mergedToo].every((path) => existsSync(path))).toBe(true);
	});

	test("--execute emits one retained note per eligible worktree, named by repository and branch, and removes nothing", async () => {
		const f = fleet();
		const calls: string[][] = [];
		const h = harness({ git: recording(calls) }, withRoot(f.root));
		expect(await runWorktree(["merge-back", "--execute", f.merged, f.mergedToo], h.deps)).toBe(0);
		expect(h.events).toHaveLength(2);
		expect(h.events[0]).toMatchObject({ kind: "note", repo: "acme/widgets", branch: "merged-a", payload: { action: "worktree.merge_back", repo: "acme/widgets", branch: "merged-a", merged_via: "default-branch", retained: true } });
		expect(h.events[1]).toMatchObject({ payload: { branch: "merged-b" } });
		for (const event of h.events) {
			expect(JSON.stringify(event)).not.toContain(f.root);
			expect(Object.keys(event.payload ?? {})).not.toContain("path");
		}
		expect(h.out.join("")).toContain("ledger: worktree.merge_back note recorded");
		expect(calls.filter(isWrite)).toEqual([]);
		expect([f.merged, f.mergedToo, f.repo.dir].every((path) => existsSync(path))).toBe(true);
	});

	test("a squash-merged pull request proves its head: merged_via is pull-request", async () => {
		const repo = makeRepo();
		const root = join(tempDir(), "wts");
		mkdirSync(root);
		const wt = addWorktree(repo, root, "squashed");
		const head = commit(wt, "s.txt", "1\n");
		git(wt, ["push", "-q", "origin", "squashed"]);
		// A squash merge leaves a different commit on main; only the pull request's head equals the branch head.
		commit(repo.dir, "s.txt", "1\n", "squash of squashed");
		git(repo.dir, ["push", "-q", "origin", "main"]);
		const gh = prGh({ squashed: [{ state: "MERGED", headRefOid: head, number: 11, baseRefName: "main" }] });
		const h = harness({ gh }, withRoot(root));
		expect(await runWorktree(["merge-back", "--execute", wt], h.deps)).toBe(0);
		expect(h.events).toHaveLength(1);
		expect(h.events[0]).toMatchObject({ payload: { head, merged_via: "pull-request", retained: true } });
	});

	test("a dirty, unpushed, unproven, ignored-work, primary or live-claimed worktree is refused and absent from the notes", async () => {
		const f = fleet();
		// The ignored notes are ignored on main before the worktree branches from it, or they would show as untracked files.
		write(f.repo.dir, ".gitignore", ".planning/\n");
		git(f.repo.dir, ["add", ".gitignore"]);
		git(f.repo.dir, ["commit", "-q", "-m", "ignore planning"]);
		git(f.repo.dir, ["push", "-q", "origin", "main"]);
		const notes = landed(f.repo, f.root, "notes");
		write(notes, ".planning/STATE.md", "only here\n");
		const dirty = landed(f.repo, f.root, "dirty");
		write(dirty, "scratch.txt", "unsaved\n");
		const unpushed = addWorktree(f.repo, f.root, "unpushed");
		commit(unpushed, "u.txt", "u\n");
		const claimed = landed(f.repo, f.root, "claimed");
		const all = [f.merged, f.mergedToo, f.review, f.repo.dir, unpushed, dirty, notes, claimed];
		const claims = async (graphId: string): Promise<ClaimsLookup> => ({ ok: true, claims: graphId === "claimed" ? [CLAIM] : [] });

		const calls: string[][] = [];
		const dry = harness({ git: recording(calls), claims }, withRoot(f.root));
		expect(await runWorktree(["merge-back", "--json", ...all], dry.deps)).toBe(1);
		const result: MergeBackJson = JSON.parse(dry.out.join(""));
		expect(result.dry_run).toBe(true);
		expect(result.recorded.map((item) => item.branch)).toEqual(["merged-a", "merged-b"]);
		expect(result.refused).toEqual([f.review, f.repo.dir, unpushed, dirty, notes, claimed]);
		expect(reasonsOf(result, f.review)).toContain("HEAD is not proven merged");
		expect(reasonsOf(result, f.repo.dir)).toContain("the primary checkout is never merged back");
		expect(reasonsOf(result, unpushed)).toContain("head is not pushed");
		expect(reasonsOf(result, dirty)).toContain("has uncommitted or untracked changes");
		expect(reasonsOf(result, notes)).toContain("ignored work: .planning/STATE.md");
		expect(reasonsOf(result, claimed)).toContain("live claim on graph claimed");
		expect(dry.events).toEqual([]);
		expect(calls.filter(isWrite)).toEqual([]);

		const executing = harness({ claims }, withRoot(f.root));
		expect(await runWorktree(["merge-back", "--execute", ...all], executing.deps)).toBe(1);
		expect(executing.events.map((event) => event.payload?.branch)).toEqual(["merged-a", "merged-b"]);
		expect(executing.err.join("")).toBe("");
		expect(existsSync(join(dirty, "scratch.txt")) && existsSync(join(notes, ".planning", "STATE.md"))).toBe(true);
	});

	test("a claim that cannot be checked refuses: nothing is recorded and the worktrees stay", async () => {
		const f = fleet();
		const h = harness({ claims: async () => ({ ok: false, error: "HTTP 503" }) }, withRoot(f.root));
		expect(await runWorktree(["merge-back", "--execute", f.merged, f.mergedToo], h.deps)).toBe(1);
		expect(h.out.join("")).toContain("claims-unverified");
		expect(h.events).toEqual([]);
		expect(existsSync(f.merged) && existsSync(f.mergedToo)).toBe(true);
	});

	test("a worktree outside every configured root has no graph claim to ask about, so it is eligible", async () => {
		const f = fleet();
		const outside = join(tempDir(), "outside-root");
		mkdirSync(outside);
		const elsewhere = landed(f.repo, outside, "elsewhere");
		const asked: string[] = [];
		const h = harness(
			{
				claims: async (graphId) => {
					asked.push(graphId);
					return { ok: false, error: "never asked" };
				},
			},
			withRoot(f.root),
		);
		expect(await runWorktree(["merge-back", "--execute", elsewhere], h.deps)).toBe(0);
		expect(asked).toEqual([]);
		expect(h.events.map((event) => event.payload?.branch)).toEqual(["elsewhere"]);
	});

	test("a directory that is not a worktree is refused and exits 1", async () => {
		const f = fleet();
		const plain = tempDir();
		const h = harness({}, withRoot(f.root));
		expect(await runWorktree(["merge-back", "--json", plain], h.deps)).toBe(1);
		const result: MergeBackJson = JSON.parse(h.out.join(""));
		expect(result.refused).toEqual([plain]);
		expect(h.events).toEqual([]);
	});

	test("the parser takes paths for merge-back alone, and it needs a path and a configured root", async () => {
		expect(parseWorktreeArgs(["merge-back", "/a", "/b", "--execute"])).toMatchObject({ ok: true, args: { command: "merge-back", positional: ["/a", "/b"], execute: true } });
		expect(parseWorktreeArgs(["merge-back", "--root", "/x"]).ok).toBe(false);
		expect(parseWorktreeArgs(["merge-back", ""]).ok).toBe(false);
		const f = fleet();
		const none = harness({}, withRoot(f.root));
		expect(await runWorktree(["merge-back"], none.deps)).toBe(2);
		expect(none.err.join("")).toContain("at least one worktree path");
	});

	test("a squash-merged branch whose remote branch was deleted is still recorded, by its merged pull request", async () => {
		const repo = makeRepo();
		const root = join(tempDir(), "wts");
		mkdirSync(root);
		const wt = addWorktree(repo, root, "gone");
		const head = commit(wt, "g.txt", "1\n");
		git(wt, ["push", "-q", "origin", "gone"]);
		commit(repo.dir, "g.txt", "1\n", "squash of gone");
		git(repo.dir, ["push", "-q", "origin", "main"]);
		// The squash merge deletes the remote branch and prunes its remote-tracking ref: nothing on origin has this head now.
		git(wt, ["push", "-q", "origin", "--delete", "gone"]);
		git(wt, ["update-ref", "-d", "refs/remotes/origin/gone"]);
		const gh = prGh({ gone: [{ state: "MERGED", headRefOid: head, number: 12, baseRefName: "main" }] });
		const h = harness({ gh }, withRoot(root));
		expect(await runWorktree(["merge-back", "--json", wt], h.deps)).toBe(0);
		const result: MergeBackJson = JSON.parse(h.out.join(""));
		expect(result.recorded).toMatchObject([{ path: wt, branch: "gone", head, merged_via: "pull-request" }]);
	});

	test("a pull request merged only into a release branch is not proof that the work reached the default branch", async () => {
		const repo = makeRepo();
		const root = join(tempDir(), "wts");
		mkdirSync(root);
		const wt = addWorktree(repo, root, "stacked");
		const head = commit(wt, "st.txt", "1\n");
		git(wt, ["push", "-q", "origin", "stacked"]);
		commit(repo.dir, "other.txt", "x\n", "unrelated main work");
		git(repo.dir, ["push", "-q", "origin", "main"]);
		const gh = prGh({ stacked: [{ state: "MERGED", headRefOid: head, number: 13, baseRefName: "release" }] });
		const h = harness({ gh }, withRoot(root));
		expect(await runWorktree(["merge-back", "--json", wt], h.deps)).toBe(1);
		const result: MergeBackJson = JSON.parse(h.out.join(""));
		expect(result.recorded).toEqual([]);
		expect(reasonsOf(result, wt)).toContain("HEAD is not proven merged");
		expect(h.events).toEqual([]);
	});

	test("untracked files count even when status.showUntrackedFiles hides them", async () => {
		const f = fleet();
		git(f.repo.dir, ["config", "status.showUntrackedFiles", "no"]);
		const dirty = landed(f.repo, f.root, "hidden");
		write(dirty, "new-work.txt", "unsaved\n");
		const h = harness({}, withRoot(f.root));
		expect(await runWorktree(["merge-back", "--json", dirty], h.deps)).toBe(1);
		const result: MergeBackJson = JSON.parse(h.out.join(""));
		expect(reasonsOf(result, dirty)).toContain("has uncommitted or untracked changes");
		expect(h.events).toEqual([]);
	});

	test("a HEAD that moves between the check and the note is refused, not recorded under the commit that was checked", async () => {
		const f = fleet();
		const mainSha = git(f.repo.dir, ["rev-parse", "HEAD"]);
		let listings = 0;
		const moving: CommandRunner = async (args, cwd) => {
			const result = await spawnGit(args, cwd);
			if (args[0] === "worktree" && args[1] === "list" && cwd === f.repo.dir) {
				listings += 1;
				// The first listing is the reload that captures merged-a's HEAD; another session moves that HEAD right after it.
				if (listings === 1) git(f.merged, ["checkout", "-q", "--detach", mainSha]);
			}
			return result;
		};
		const h = harness({ git: moving }, withRoot(f.root));
		expect(await runWorktree(["merge-back", "--execute", f.merged, f.mergedToo], h.deps)).toBe(1);
		expect(h.events.map((event) => event.payload?.branch)).toEqual(["merged-b"]);
		expect(h.out.join("")).toContain("HEAD or the branch changed");
	});

	test("a note the ledger did not store is never reported as recorded", async () => {
		const f = fleet();
		const h = harness({ emit: async (): Promise<EmitOutcome> => ({ kind: "failed", error: "connection refused" }) }, withRoot(f.root));
		expect(await runWorktree(["merge-back", "--execute", f.merged], h.deps)).toBe(1);
		const out = h.out.join("");
		expect(out.split("\n").some((line) => line.startsWith(`recorded ${f.merged}`))).toBe(false);
		expect(out).toContain(`not recorded (failed) ${f.merged}`);
		expect(out).toContain("recorded 0 worktrees, refused 0, not recorded 1");
		expect(h.err.join("")).toContain("NOT RECORDED");
	});

	test("with no root configured the error names only SUBSTRATE_WORKTREE_ROOTS, never --root", async () => {
		const h = harness({}, {});
		expect(await runWorktree(["merge-back", "/nowhere/wt"], h.deps)).toBe(2);
		expect(h.err.join("")).toContain("set SUBSTRATE_WORKTREE_ROOTS (colon separated)");
		expect(h.err.join("")).not.toContain("--root");
	});

	test("a symlinked root still finds the graph claim on a worktree git lists under its real path", async () => {
		const f = fleet();
		const base = tempDir();
		mkdirSync(join(base, "data", "wts"), { recursive: true });
		symlinkSync(join(base, "data"), join(base, "srv"));
		const claimed = landed(f.repo, join(base, "data", "wts"), "claimed");
		const asked: string[] = [];
		const h = harness(
			{
				claims: async (graphId) => {
					asked.push(graphId);
					return { ok: true, claims: graphId === "claimed" ? [CLAIM] : [] };
				},
			},
			withRoot(join(base, "srv", "wts")),
		);
		expect(await runWorktree(["merge-back", "--json", claimed], h.deps)).toBe(1);
		expect(asked).toEqual(["claimed"]);
		const result: MergeBackJson = JSON.parse(h.out.join(""));
		expect(reasonsOf(result, claimed)).toContain("live claim on graph claimed");
		expect(h.events).toEqual([]);
	});

	test("with an origin remote but no origin/HEAD, a topic commit merged only into local main is refused and not recorded", async () => {
		const repo = makeRepo();
		git(repo.dir, ["remote", "set-head", "origin", "-d"]);
		const root = join(tempDir(), "wts");
		mkdirSync(root);
		const topic = addWorktree(repo, root, "topic");
		commit(topic, "t.txt", "t\n");
		// Merged into the local main only: origin/main never has it, so nothing on origin proves it merged.
		git(repo.dir, ["merge", "-q", "--no-ff", "-m", "merge topic", "topic"]);
		const h = harness({}, withRoot(root));
		expect(await runWorktree(["merge-back", "--execute", topic], h.deps)).toBe(1);
		expect(h.events).toEqual([]);
		expect(h.out.join("")).toContain("origin/HEAD is not set, so the default branch cannot be proven merged");
		expect(existsSync(topic)).toBe(true);
	});

	test("with origin/HEAD set, a commit that is on origin/main still records", async () => {
		const f = fleet();
		const h = harness({}, withRoot(f.root));
		expect(await runWorktree(["merge-back", "--execute", f.merged], h.deps)).toBe(0);
		expect(h.events).toHaveLength(1);
		expect(h.events[0]).toMatchObject({ payload: { branch: "merged-a", merged_via: "default-branch" } });
	});
});
