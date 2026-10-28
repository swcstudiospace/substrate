/**
 * The checkout facts the observer heartbeats and attributes changes with (phase 52, SOTA-08): the owner and name of the
 * origin remote, read from a git config in any of its URL forms.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitOriginUrl, repoFromGitConfig, repoOf } from "./checkout.ts";
import { nodePlanningFs } from "./fs.ts";
import { FakeTree, TREE_ROOT } from "./tree.fixtures.ts";

describe("repoFromGitConfig", () => {
	test("reads owner and name from ssh, https and https-with-.git origin URLs", () => {
		expect(repoFromGitConfig('[remote "origin"]\n\turl = git@github.com:swcstudiospace/agent-substrate.git\n')).toBe("swcstudiospace/agent-substrate");
		expect(repoFromGitConfig('[remote "origin"]\n\turl = https://github.com/swcstudiospace/agent-substrate\n')).toBe("swcstudiospace/agent-substrate");
		expect(repoFromGitConfig('[remote "origin"]\n\turl = https://github.com/swcstudiospace/agent-substrate.git\n')).toBe("swcstudiospace/agent-substrate");
	});

	test("quoted and unquoted origin URLs give the same repo identity", () => {
		expect(repoFromGitConfig('[remote "origin"]\n\turl = "git@github.com:swcstudiospace/agent-substrate.git"\n')).toBe("swcstudiospace/agent-substrate");
		expect(repoFromGitConfig("[remote \"origin\"]\n\turl = git@github.com:swcstudiospace/agent-substrate.git\n")).toBe("swcstudiospace/agent-substrate");
	});

	test("only the origin remote counts, and a config with none gives null", () => {
		expect(repoFromGitConfig('[remote "upstream"]\n\turl = https://github.com/someone/else.git\n')).toBeNull();
		expect(repoFromGitConfig('[remote "upstream"]\n\turl = https://github.com/someone/else.git\n[remote "origin"]\n\turl = https://github.com/swcstudiospace/agent-substrate.git\n')).toBe(
			"swcstudiospace/agent-substrate",
		);
		expect(repoFromGitConfig("[core]\n\tbare = false\n")).toBeNull();
	});

	test("an inline comment after the origin URL is not part of it, and a # inside quotes is", () => {
		expect(repoFromGitConfig('[remote "origin"]\n\turl = https://github.com/acme/repo.git # primary remote\n')).toBe("acme/repo");
		expect(repoFromGitConfig('[remote "origin"]\n\turl = git@github.com:acme/repo.git ; mirror of the primary\n')).toBe("acme/repo");
		expect(repoFromGitConfig('[remote "origin"]\n\turl = "git@github.com:acme/repo.git" # quoted, then a comment\n')).toBe("acme/repo");
		expect(repoFromGitConfig('[remote "origin"]\n\turl = "https://github.com/acme/re#po.git"\n')).toBeNull();
	});

	test("section and key names are case-insensitive, whitespace around names is ignored, and an indented header ends the origin section", () => {
		expect(repoFromGitConfig('[Remote "origin"]\n\tURL = https://github.com/acme/repo.git\n')).toBe("acme/repo");
		expect(repoFromGitConfig('  [remote "origin"]\n    url   =   git@github.com:acme/repo.git\n')).toBe("acme/repo");
		expect(repoFromGitConfig('[remote "Origin"]\n\turl = https://github.com/acme/repo.git\n')).toBeNull();
		expect(repoFromGitConfig('[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n  [remote "upstream"]\n\turl = https://github.com/other/upstream.git\n')).toBeNull();
	});
});

describe("repoOf", () => {
	test("a linked worktree's origin is read from the common directory its gitdir and commondir files name", async () => {
		const common = "/common/.git";
		const gitDir = `${common}/worktrees/feature`;
		const fs = new FakeTree({
			[`${TREE_ROOT}/.git`]: `gitdir: ${gitDir}\n`,
			[`${gitDir}/commondir`]: "../..\n",
			[`${common}/config`]: '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/acme/repo.git\n',
		});
		expect(await repoOf(fs, TREE_ROOT, async () => ({ kind: "unavailable" }))).toEqual({ state: "known", repo: "acme/repo" });
	});
});

describe("repoOf asks git, so a configured origin is found wherever git finds it", () => {
	const fs = nodePlanningFs();
	const saved: Record<string, string | undefined> = {};
	let scratch = "";

	beforeAll(async () => {
		// The machine's own git config must not decide these tests: only the checkout's files may define an origin.
		for (const name of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"]) saved[name] = process.env[name];
		process.env.GIT_CONFIG_GLOBAL = "/dev/null";
		process.env.GIT_CONFIG_SYSTEM = "/dev/null";
		process.env.GIT_CONFIG_NOSYSTEM = "1";
		scratch = await mkdtemp(join(tmpdir(), "planning-checkout-test-"));
	});

	afterAll(async () => {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		await rm(scratch, { recursive: true, force: true });
	});

	async function checkoutWith(name: string, config: string, extra: Record<string, string> = {}): Promise<string> {
		const dir = join(scratch, name);
		await mkdir(dir, { recursive: true });
		const init = Bun.spawnSync(["git", "init", "--quiet", dir], { stdout: "pipe", stderr: "pipe" });
		if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr.toString()}`);
		for (const [path, text] of Object.entries(extra)) await writeFile(join(dir, ".git", path), text);
		if (config !== "") await appendFile(join(dir, ".git", "config"), config);
		return dir;
	}

	test("an origin defined in an included config file is found, which a read of .git/config alone misses", async () => {
		const dir = await checkoutWith("included", "[include]\n\tpath = origin.inc\n", { "origin.inc": '[remote "origin"]\n\turl = git@github.com:acme/included.git\n' });
		expect(repoFromGitConfig(await readFile(join(dir, ".git", "config"), "utf8"))).toBeNull();
		expect(await repoOf(fs, dir)).toEqual({ state: "known", repo: "acme/included" });
	});

	test("an origin defined in .git/config itself is found", async () => {
		const dir = await checkoutWith("direct", '[remote "origin"]\n\turl = https://github.com/acme/direct.git\n');
		expect(await repoOf(fs, dir)).toEqual({ state: "known", repo: "acme/direct" });
	});

	test("a checkout with no origin anywhere is origin-missing, and that is definite, not transient", async () => {
		const dir = await checkoutWith("bare", '[remote "upstream"]\n\turl = https://github.com/acme/else.git\n');
		expect(await repoOf(fs, dir)).toEqual({ state: "unknown", reason: "origin-missing", transient: false });
	});

	test("a config git cannot parse is a failure to answer: transient, so the baseline holds", async () => {
		const dir = await checkoutWith("broken", '[remote "origin"\n\turl = https://github.com/acme/broken.git\n');
		expect(await repoOf(fs, dir)).toEqual({ state: "unknown", reason: "origin-unresolved", transient: true });
	});

	test("git failing or timing out is transient, and its answer is never replaced by the config file", async () => {
		const tree = new FakeTree({ [`${TREE_ROOT}/.git/config`]: '[remote "origin"]\n\turl = https://github.com/acme/repo.git\n' });
		expect(await repoOf(tree, TREE_ROOT, async () => ({ kind: "failed" }))).toEqual({ state: "unknown", reason: "origin-unresolved", transient: true });
	});

	test("git saying there is no origin is definite, whatever the config file says", async () => {
		const tree = new FakeTree({ [`${TREE_ROOT}/.git/config`]: '[remote "origin"]\n\turl = https://github.com/acme/repo.git\n' });
		expect(await repoOf(tree, TREE_ROOT, async () => ({ kind: "none" }))).toEqual({ state: "unknown", reason: "origin-missing", transient: false });
	});

	test("git that cannot run at all falls back to the config file", async () => {
		const tree = new FakeTree({ [`${TREE_ROOT}/.git/config`]: '[remote "origin"]\n\turl = https://github.com/acme/repo.git\n' });
		expect(await repoOf(tree, TREE_ROOT, async () => ({ kind: "unavailable" }))).toEqual({ state: "known", repo: "acme/repo" });
		expect(await gitOriginUrl(join(scratch, "does-not-exist"))).toEqual({ kind: "unavailable" });
	});
});
