/**
 * `substrate index archive|verify-archive|restore`: the grammar this package
 * owns and the hand-off to the runner. The runner's behaviour is proved in
 * `packages/mcp-server/src/index-archive.test.ts`; here the question is only
 * what argv reaches it and what exit code comes back.
 */
import { describe, expect, test } from "bun:test";
import { parseArgs, type Args } from "./args.ts";
import { INDEX_ARCHIVE_USAGE, indexArchiveRunnerArgs, runIndexArchive } from "./index-archive.ts";

function split(words: string[]): { argv: string[]; args: Args } {
	return { argv: words, args: parseArgs(words) };
}

describe("indexArchiveRunnerArgs", () => {
	test("maps each subcommand's flags and directory onto the runner's argv", () => {
		const archive = split(["archive", "--out", "/mnt/index-archive", "--page-size", "200", "--json"]);
		expect(indexArchiveRunnerArgs(archive.argv, archive.args)).toEqual(["archive", "--out", "/mnt/index-archive", "--page-size", "200", "--json"]);

		const verify = split(["verify-archive", "/mnt/index-archive", "--json"]);
		expect(indexArchiveRunnerArgs(verify.argv, verify.args)).toEqual(["verify-archive", "/mnt/index-archive", "--json"]);

		const restore = split(["restore", "--scratch", "postgres://u@localhost/scratch", "/mnt/index-archive"]);
		expect(indexArchiveRunnerArgs(restore.argv, restore.args)).toEqual(["restore", "/mnt/index-archive", "--scratch", "postgres://u@localhost/scratch"]);
	});

	test("a --json before the directory does not swallow it", () => {
		const verify = split(["verify-archive", "--json", "/mnt/index-archive"]);
		// The shared parser reads `--json /mnt/…` as a value; the directory is still found and `--json` is forwarded as a bare flag.
		expect(indexArchiveRunnerArgs(verify.argv, verify.args)).toEqual(["verify-archive", "/mnt/index-archive", "--json"]);
	});

	test("an empty --out — what systemd expands an unset SUBSTRATE_INDEX_ARCHIVE_DIR to — reaches the runner, which refuses it by name", () => {
		const archive = split(["archive", "--out", ""]);
		expect(indexArchiveRunnerArgs(archive.argv, archive.args)).toEqual(["archive", "--out", ""]);
	});

	test("refuses an unknown subcommand or flag, a missing or doubled directory, and a directory where none belongs", () => {
		for (const words of [
			[],
			["prune"],
			["sweep"],
			["archive", "--apply"],
			["archive", "/mnt/x"],
			["verify-archive"],
			["verify-archive", "/a", "/b"],
			["verify-archive", "/a", "--scratch", "postgres://u@localhost/s"],
			["restore", "--scratch", "postgres://u@localhost/s"],
			["restore", "/a", "--out", "/b"],
		]) {
			const { argv, args } = split(words);
			expect({ words, out: indexArchiveRunnerArgs(argv, args) }).toEqual({ words, out: null });
		}
	});
});

describe("runIndexArchive", () => {
	test("spawns the runner with the mapped argv and returns its status", () => {
		const spawned: string[][] = [];
		const { argv, args } = split(["verify-archive", "/mnt/a"]);
		const code = runIndexArchive(argv, args, {
			spawn: (runnerArgs) => {
				spawned.push(runnerArgs);
				return 2;
			},
			err: () => undefined,
			env: {},
		});
		expect(code).toBe(2);
		expect(spawned).toEqual([["verify-archive", "/mnt/a"]]);
	});

	test("a grammar error prints usage and exits 2 without spawning", () => {
		const err: string[] = [];
		const { argv, args } = split(["verify-archive"]);
		const code = runIndexArchive(argv, args, {
			spawn: () => {
				throw new Error("must not spawn");
			},
			err: (text) => err.push(text),
			env: {},
		});
		expect(code).toBe(2);
		expect(err).toEqual([INDEX_ARCHIVE_USAGE]);
	});

	test("a restore with neither --scratch nor SUBSTRATE_INDEX_SCRATCH_URL (from the injected env) is refused before spawning; with the env var it spawns", () => {
		const err: string[] = [];
		const spawned: string[][] = [];
		const deps = (env: Record<string, string | undefined>) => ({
			spawn: (runnerArgs: string[]) => {
				spawned.push(runnerArgs);
				return 0;
			},
			err: (text: string) => err.push(text),
			env,
		});
		const { argv, args } = split(["restore", "/a"]);
		expect(runIndexArchive(argv, args, deps({}))).toBe(2);
		expect(runIndexArchive(argv, args, deps({ SUBSTRATE_INDEX_SCRATCH_URL: "   " }))).toBe(2);
		expect(err).toEqual([INDEX_ARCHIVE_USAGE, INDEX_ARCHIVE_USAGE]);
		expect(spawned).toEqual([]);
		expect(runIndexArchive(argv, args, deps({ SUBSTRATE_INDEX_SCRATCH_URL: "postgres://u@localhost/scratch" }))).toBe(0);
		expect(spawned).toEqual([["restore", "/a"]]);
		// An explicit --scratch needs no env at all; an empty one is the runner's to refuse by name.
		const explicit = split(["restore", "--scratch", "postgres://u@localhost/scratch", "/a"]);
		expect(runIndexArchive(explicit.argv, explicit.args, deps({}))).toBe(0);
	});
});
