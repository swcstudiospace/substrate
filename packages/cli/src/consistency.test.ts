/**
 * `substrate consistency verify …`: the grammar this package owns and the hand-off to the runner. The runner's
 * behaviour is proved in `packages/mcp-server/src/consistency-run.test.ts`; here the question is only what argv
 * reaches it and what exit code comes back.
 */
import { describe, expect, test } from "bun:test";
import { CONSISTENCY_USAGE, consistencyRunnerArgs, runConsistency } from "./consistency.ts";

describe("consistencyRunnerArgs", () => {
	test("forwards the flags the runner takes, in the order typed, without the subcommand", () => {
		expect(consistencyRunnerArgs(["verify"])).toEqual([]);
		expect(consistencyRunnerArgs(["verify", "--json"])).toEqual(["--json"]);
		expect(
			consistencyRunnerArgs(["verify", "--json", "--bank", "substrate-claude-code", "--limit", "500", "--since", "2026-10-01T00:00:00Z", "--repair", "--repair-orphans"]),
		).toEqual(["--json", "--bank", "substrate-claude-code", "--limit", "500", "--since", "2026-10-01T00:00:00Z", "--repair", "--repair-orphans"]);
		expect(consistencyRunnerArgs(["verify", "--repair"])).toEqual(["--repair"]);
	});

	test("a boolean flag before a value flag does not swallow it", () => {
		expect(consistencyRunnerArgs(["verify", "--json", "--limit", "10"])).toEqual(["--json", "--limit", "10"]);
	});

	test("refuses a missing or unknown subcommand, an unknown flag and a positional argument", () => {
		for (const words of [[], ["check"], ["--json"], ["verify", "--apply"], ["verify", "extra"], ["verify", "--json", "extra"], ["verify", "--out", "/x"]]) {
			expect({ words, out: consistencyRunnerArgs(words) }).toEqual({ words, out: null });
		}
	});

	test("refuses a doubled flag, a value flag without a value and the --flag=value spelling", () => {
		for (const words of [
			["verify", "--json", "--json"],
			["verify", "--limit", "5", "--limit", "6"],
			["verify", "--bank"],
			["verify", "--bank", "--json"],
			["verify", "--limit"],
			["verify", "--bank=substrate-claude-code"],
			["verify", "--since"],
		]) {
			expect({ words, out: consistencyRunnerArgs(words) }).toEqual({ words, out: null });
		}
	});

	test("refuses values of the wrong shape before a process is spawned", () => {
		for (const words of [
			["verify", "--limit", "0"],
			["verify", "--limit", "-5"],
			["verify", "--limit", "ten"],
			["verify", "--limit", "1.5"],
			["verify", "--bank", "bank with space"],
			["verify", "--bank", "a/b"],
			["verify", "--since", "yesterday"],
			["verify", "--since", "2026-10-01"],
			["verify", "--since", "2026-10-01T00:00:00"],
		]) {
			expect({ words, out: consistencyRunnerArgs(words) }).toEqual({ words, out: null });
		}
		expect(consistencyRunnerArgs(["verify", "--since", "2026-10-01T00:00:00.5+02:00"])).toEqual(["--since", "2026-10-01T00:00:00.5+02:00"]);
	});

	test("--repair-orphans without --repair is refused, not ignored", () => {
		expect(consistencyRunnerArgs(["verify", "--repair-orphans"])).toBeNull();
		expect(consistencyRunnerArgs(["verify", "--repair-orphans", "--repair"])).toEqual(["--repair-orphans", "--repair"]);
	});
});

describe("runConsistency", () => {
	function run(words: string[], status: number) {
		const spawned: string[][] = [];
		const err: string[] = [];
		const code = runConsistency(words, {
			spawn: (runnerArgs) => {
				spawned.push(runnerArgs);
				return status;
			},
			err: (text) => err.push(text),
		});
		return { code, spawned, err };
	}

	test("passes the runner's exit codes 0, 1, 2 and 3 through", () => {
		for (const status of [0, 1, 2, 3]) {
			const { code, spawned, err } = run(["verify", "--json"], status);
			expect(code).toBe(status);
			expect(spawned).toEqual([["--json"]]);
			expect(err).toEqual([]);
		}
	});

	test("an abnormal end (a signal, a crash) is 3 with a reason, never 0 or 1", () => {
		for (const status of [-1, 4, 130, 137]) {
			const { code, err } = run(["verify"], status);
			expect(code).toBe(3);
			expect(err.join("")).toContain("nothing was verified");
		}
	});

	test("a bad grammar prints the usage, exits 2 and spawns nothing", () => {
		const { code, spawned, err } = run(["verify", "--bogus"], 0);
		expect(code).toBe(2);
		expect(spawned).toEqual([]);
		expect(err).toEqual([CONSISTENCY_USAGE]);
	});

	test("the usage text documents the four exit codes", () => {
		for (const code of ["0 consistent", "1 drift found", "2 usage", "3 a store was unreachable"]) expect(CONSISTENCY_USAGE).toContain(code);
	});
});
