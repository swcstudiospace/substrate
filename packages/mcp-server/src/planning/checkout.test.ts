/**
 * The checkout facts the observer heartbeats and attributes changes with (phase 52, SOTA-08): the owner and name of the
 * origin remote, read from a git config in any of its URL forms.
 */
import { describe, expect, test } from "bun:test";
import { repoFromGitConfig, repoOf } from "./checkout.ts";
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
		expect(await repoOf(fs, TREE_ROOT)).toEqual({ state: "known", repo: "acme/repo" });
	});
});
