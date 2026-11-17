import { describe, expect, test } from "bun:test";
import { EXIT_OUTPUT_LIMIT, EXIT_SPAWN_FAILED, EXIT_TIMEOUT, gitOut, spawnGit, spawnRunner } from "./git.ts";

describe("spawnRunner", () => {
	test("returns stdout, stderr and the exit code without a shell", async () => {
		const result = await spawnGit(["--version"], process.cwd());
		expect(result.code).toBe(0);
		expect(result.stdout).toStartWith("git version");
		const failed = await spawnGit(["rev-parse", "--verify", "no-such-ref-here"], process.cwd());
		expect(failed.code).not.toBe(0);
	});

	test("an argument is never interpreted by a shell", async () => {
		const echo = spawnRunner("echo");
		expect((await echo(["a; touch /tmp/never-created-by-fleet", "$(id)"], process.cwd())).stdout).toBe("a; touch /tmp/never-created-by-fleet $(id)\n");
	});

	test("a program that is missing or a directory that is missing is a spawn failure, not a throw", async () => {
		expect((await spawnRunner("substrate-no-such-program")(["x"], process.cwd())).code).toBe(EXIT_SPAWN_FAILED);
		expect((await spawnGit(["status"], "/definitely/not/a/directory")).code).toBe(EXIT_SPAWN_FAILED);
	});

	test("output past the cap is cut off with its own exit code", async () => {
		const yes = spawnRunner("yes", { maxOutputBytes: 4096 });
		const result = await yes([], process.cwd());
		expect(result.code).toBe(EXIT_OUTPUT_LIMIT);
		expect(result.stdout).toBe("");
	});

	test("a program that outlives the time bound is killed with its own exit code", async () => {
		const sleep = spawnRunner("sleep", { timeoutMs: 40 });
		expect((await sleep(["30"], process.cwd())).code).toBe(EXIT_TIMEOUT);
	});
});

describe("gitOut", () => {
	test("is trimmed stdout on success and null on failure", async () => {
		expect(await gitOut(spawnGit, ["--version"], process.cwd())).toStartWith("git version");
		expect(await gitOut(spawnGit, ["rev-parse", "--verify", "nope-nope"], process.cwd())).toBeNull();
	});
});
