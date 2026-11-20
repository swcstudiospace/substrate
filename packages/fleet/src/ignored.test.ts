import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { spawnGit } from "./git.ts";
import { findIgnoredWork, UNKNOWN_IGNORED } from "./ignored.ts";
import { addWorktree, cleanupTemp, commit, git, makeRepo, tempDir, write } from "./testkit.ts";
import { LOOSE_REFUSAL, workspaceGuard } from "./workspace-guard.ts";

afterAll(cleanupTemp);

/** A primary checkout that ignores `.planning/` and `.env`, and a linked worktree cut after that commit. */
function ignoringWorktree(): { repo: string; worktree: string } {
	const repo = makeRepo();
	commit(repo.dir, ".gitignore", ".planning/\n.env\n", "ignore local files");
	git(repo.dir, ["push", "-q", "origin", "main"]);
	return { repo: repo.dir, worktree: addWorktree(repo, tempDir(), "wt") };
}

describe("findIgnoredWork", () => {
	test("an ignored regular file named like a rebuildable directory is work, and so is anything under a rebuildable directory in .planning/", async () => {
		const { repo, worktree } = ignoringWorktree();
		write(worktree, ".planning/target", "notes, not build output\n");
		write(worktree, ".planning/dist/out.js", "rebuilt by a command\n");
		write(worktree, ".planning/keep/node_modules/dep.js", "rebuilt by a command\n");
		expect(await findIgnoredWork(worktree, repo, spawnGit)).toEqual([".planning/dist/out.js", ".planning/keep/node_modules/dep.js", ".planning/target"]);
	});

	test("an ignored file in a rebuildable directory under .planning is compared, not skipped", async () => {
		const { repo, worktree } = ignoringWorktree();
		write(worktree, ".planning/build/x", "the only copy\n");
		expect(await findIgnoredWork(worktree, repo, spawnGit)).toEqual([".planning/build/x"]);
		write(repo, ".planning/build/x", "the only copy\n");
		expect(await findIgnoredWork(worktree, repo, spawnGit)).toEqual([]);
	});

	test("an ignored file the primary lacks is work, and equal bytes in the primary make it replaceable", async () => {
		const { repo, worktree } = ignoringWorktree();
		write(worktree, ".env", "TOKEN_NAME=placeholder\n");
		expect(await findIgnoredWork(worktree, repo, spawnGit)).toEqual([".env"]);
		write(repo, ".env", "TOKEN_NAME=placeholder\n");
		expect(await findIgnoredWork(worktree, repo, spawnGit)).toEqual([]);
	});

	test("a link named like a rebuildable directory is compared like any other file", async () => {
		const { repo, worktree } = ignoringWorktree();
		mkdirSync(join(worktree, ".planning"));
		symlinkSync("/nonexistent-target", join(worktree, ".planning", "vendor"));
		expect(await findIgnoredWork(worktree, repo, spawnGit)).toEqual([".planning/vendor"]);
	});

	test("a primary that reaches the worktree's own notes through a directory link does not back them up", async () => {
		const { repo, worktree } = ignoringWorktree();
		write(worktree, ".planning/notes.md", "the only copy\n");
		// The primary's `.planning` is a link to the worktree's: reading `primary/.planning/notes.md` reads the same file.
		symlinkSync(join(worktree, ".planning"), join(repo, ".planning"));
		expect(await findIgnoredWork(worktree, repo, spawnGit)).toEqual([".planning/notes.md"]);
	});

	test("many empty directories exhaust the visit budget, which counts directories and not only files", async () => {
		const { repo, worktree } = ignoringWorktree();
		// The same file in the primary keeps the baseline empty and makes git report `.planning/` as one ignored directory.
		write(worktree, ".planning/seed.txt", "same\n");
		write(repo, ".planning/seed.txt", "same\n");
		for (let index = 0; index < 40; index++) mkdirSync(join(worktree, ".planning", `d${index}`), { recursive: true });
		expect(await findIgnoredWork(worktree, repo, spawnGit)).toEqual([]);
		expect(await findIgnoredWork(worktree, repo, spawnGit, { maxVisited: 10 })).toEqual([UNKNOWN_IGNORED]);
	});

	test("the time budget stops a walk, using the injected clock, and what was not examined counts as work", async () => {
		const { repo, worktree } = ignoringWorktree();
		for (let index = 0; index < 5; index++) write(worktree, `.planning/f${index}.txt`, `${index}\n`);
		let tick = 0;
		const result = await findIgnoredWork(worktree, repo, spawnGit, { maxMs: 50, now: () => (tick += 100) });
		expect(result).toContain(UNKNOWN_IGNORED);
	});

	test("a failed listing is unknown, never empty", async () => {
		const { repo } = ignoringWorktree();
		expect(await findIgnoredWork(join(tempDir(), "absent"), repo, spawnGit)).toEqual([UNKNOWN_IGNORED]);
	});
});

describe("workspaceGuard", () => {
	test("a dangling .planning link in a root that no worktree holds is refused, not skipped", async () => {
		const root = tempDir();
		symlinkSync(join(root, "absent-planning"), join(root, ".planning"));
		const result = await workspaceGuard(root, spawnGit);
		expect(result.ok).toBe(false);
		expect(result.refusals).toHaveLength(1);
		expect(result.refusals[0]?.endsWith(`/.planning: ${LOOSE_REFUSAL}`)).toBe(true);
	});
});
