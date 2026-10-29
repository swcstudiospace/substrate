import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { EmitOutcome } from "../../../collectors/src/emit.ts";
import { type CommandRunner, spawnGit } from "../../../fleet/src/git.ts";
import { addWorktree, cleanupTemp, commit, defined, fakeGh, git, makeRepo, type TestRepo, tempDir, write } from "../../../fleet/src/testkit.ts";
import type { EventInput } from "../../../mcp-server/src/types.ts";
import { httpReportPoster, runWorktree, type PostOutcome, type WorktreeDeps } from "./command.ts";
import { parseWorktreeArgs } from "./args.ts";

afterAll(cleanupTemp);

const GIB = 1024 ** 3;

interface Harness {
	deps: WorktreeDeps;
	out: string[];
	err: string[];
	events: EventInput[];
	reports: Array<{ worktrees: Array<{ path: string; graph_id?: string }> }>;
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

describe("usage and roots", () => {
	test("with no configured root the commands say so and exit 2", async () => {
		for (const command of ["list", "scan", "prune", "disk", "conflicts"]) {
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
