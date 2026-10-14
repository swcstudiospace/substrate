/**
 * `substrate ledger …`: the grammar this package owns and the hand-off to the
 * runner. The runner's own behaviour (coverage, archive, verify) is proved in
 * `packages/mcp-server/src/ledger-archive.test.ts`; here the question is only
 * what argv reaches it and what exit code comes back.
 */
import { describe, expect, test } from "bun:test";
import { parseArgs, type Args } from "./args.ts";
import { LEDGER_USAGE, ledgerRunnerArgs, runLedger } from "./ledger.ts";

/** `substrate ledger <words>` as `index.ts` splits it: positional argv plus the parsed flags. */
function split(words: string[]): { argv: string[]; args: Args } {
	return { argv: words, args: parseArgs(words) };
}

describe("ledgerRunnerArgs", () => {
	test("maps each subcommand's flags onto the runner's argv, values as given", () => {
		const coverage = split(["coverage", "--json"]);
		expect(ledgerRunnerArgs(coverage.argv, coverage.args)).toEqual(["coverage", "--json"]);

		const archive = split(["archive", "--until", "2026-10-12", "--out", "/mnt/ledger-archive", "--page-size", "200"]);
		expect(ledgerRunnerArgs(archive.argv, archive.args)).toEqual([
			"archive",
			"--until",
			"2026-10-12",
			"--out",
			"/mnt/ledger-archive",
			"--page-size",
			"200",
		]);

		const verify = split(["verify-archive", "/mnt/ledger-archive", "--day", "2026-10-12"]);
		expect(ledgerRunnerArgs(verify.argv, verify.args)).toEqual(["verify-archive", "/mnt/ledger-archive", "--day", "2026-10-12"]);
	});

	test("an empty --out — what systemd expands an unset SUBSTRATE_LEDGER_ARCHIVE_DIR to — reaches the runner, which is where it is refused by name", () => {
		const archive = split(["archive", "--out", ""]);
		expect(ledgerRunnerArgs(archive.argv, archive.args)).toEqual(["archive", "--out", ""]);
	});

	test("refuses an unknown subcommand, an unknown flag and a verify-archive without a directory", () => {
		for (const words of [[], ["prune"], ["coverage", "--out", "/x"], ["archive", "--apply"], ["verify-archive"], ["verify-archive", "--day", "2026-10-12"]]) {
			const { argv, args } = split(words);
			expect({ words, out: ledgerRunnerArgs(argv, args) }).toEqual({ words, out: null });
		}
	});
});

describe("runLedger", () => {
	test("spawns the runner with the mapped argv and returns its status", () => {
		const spawned: string[][] = [];
		const err: string[] = [];
		const { argv, args } = split(["verify-archive", "/mnt/a", "--json"]);
		const code = runLedger(argv, args, {
			spawn: (runnerArgs) => {
				spawned.push(runnerArgs);
				return 2;
			},
			err: (text) => err.push(text),
		});
		expect(code).toBe(2);
		expect(spawned).toEqual([["verify-archive", "/mnt/a", "--json"]]);
		expect(err).toEqual([]);
	});

	test("a grammar error prints usage and exits 2 without spawning", () => {
		const err: string[] = [];
		const { argv, args } = split(["coverage", "--until", "2026-10-12"]);
		const code = runLedger(argv, args, {
			spawn: () => {
				throw new Error("must not spawn");
			},
			err: (text) => err.push(text),
		});
		expect(code).toBe(2);
		expect(err).toEqual([LEDGER_USAGE]);
	});
});
