/**
 * The checkout facts the observer heartbeats and attributes changes with (phase 52, SOTA-08): the owner and name of the
 * origin remote, read from a git config in any of its URL forms.
 */
import { describe, expect, test } from "bun:test";
import { repoFromGitConfig } from "./checkout.ts";

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
});
