import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { forecastConflicts, type ForecastWorktree, type OverlapPair, parseGitVersion, parseMergeTree, parseStatusZ, suggestMergeOrder, supportsMergeTree } from "./conflicts.ts";
import { type CommandRunner, spawnGit } from "./git.ts";
import { addWorktree, cleanupTemp, commit, git, makeRepo, tempDir, write } from "./testkit.ts";

afterAll(cleanupTemp);

const TEN_LINES = `${Array.from({ length: 10 }, (_unused, index) => `line ${index + 1}`).join("\n")}\n`;

function replaceLine(text: string, line: number, value: string): string {
	return text
		.split("\n")
		.map((current, index) => (index === line - 1 ? value : current))
		.join("\n");
}

function forecastInput(path: string): ForecastWorktree {
	return { path, branch: git(path, ["rev-parse", "--abbrev-ref", "HEAD"]), head: git(path, ["rev-parse", "HEAD"]), base: git(path, ["merge-base", "main", "HEAD"]) };
}

function fixture() {
	const repo = makeRepo();
	commit(repo.dir, "shared.txt", TEN_LINES, "shared");
	git(repo.dir, ["push", "-q", "origin", "main"]);
	const root = tempDir();
	const a = addWorktree(repo, root, "a");
	const b = addWorktree(repo, root, "b");
	const c = addWorktree(repo, root, "c");
	const d = addWorktree(repo, root, "d");
	commit(a, "shared.txt", replaceLine(TEN_LINES, 1, "from a"));
	commit(b, "shared.txt", replaceLine(TEN_LINES, 1, "from b"));
	commit(c, "other.txt", "only c\n");
	commit(d, "shared.txt", replaceLine(TEN_LINES, 9, "from d"));
	return { repo, a, b, c, d };
}

describe("forecastConflicts", () => {
	test("two branches editing the same lines conflict, different regions and files do not, and nothing is touched", async () => {
		const { a, b, c, d } = fixture();
		write(c, "scratch.txt", "uncommitted\n");
		const paths = [a, b, c, d];
		const before = paths.map((path) => [git(path, ["status", "--porcelain"]), git(path, ["rev-parse", "HEAD"]), git(path, ["stash", "list"])]);
		const sharedBefore = paths.map((path) => readFileSync(join(path, "shared.txt"), "utf8"));

		const forecast = await forecastConflicts(
			paths.map((path) => forecastInput(path)),
			{ git: spawnGit },
		);

		const pair = (x: string, y: string): OverlapPair | undefined => forecast.overlaps.find((item) => (item.a === x && item.b === y) || (item.a === y && item.b === x));
		expect(forecast.merge_tree).toBe("available");
		expect(pair(a, b)).toMatchObject({ prediction: "conflict", files: ["shared.txt"], conflicted_files: ["shared.txt"] });
		expect(pair(a, d)).toMatchObject({ prediction: "clean", files: ["shared.txt"], conflicted_files: [] });
		expect(pair(b, d)).toMatchObject({ prediction: "clean" });
		expect(pair(c, a)).toBeUndefined();
		expect(forecast.worktrees.find((entry) => entry.path === c)?.files).toEqual(["other.txt", "scratch.txt"]);

		// c overlaps nothing, so it merges first; the conflicting pair needs one rebase.
		expect(forecast.order[0]?.path).toBe(c);
		expect(forecast.rebase).toHaveLength(1);
		const [first, second] = [a, b].sort();
		expect(forecast.rebase[0]).toMatchObject({ path: second, after: first, files: ["shared.txt"] });

		const after = paths.map((path) => [git(path, ["status", "--porcelain"]), git(path, ["rev-parse", "HEAD"]), git(path, ["stash", "list"])]);
		expect(after).toEqual(before);
		expect(paths.map((path) => readFileSync(join(path, "shared.txt"), "utf8"))).toEqual(sharedBefore);
	});

	test("an uncommitted change counts as an overlap but is not part of the prediction", async () => {
		const { a, c } = fixture();
		write(c, "shared.txt", replaceLine(TEN_LINES, 1, "uncommitted in c"));
		const forecast = await forecastConflicts([forecastInput(a), forecastInput(c)], { git: spawnGit });
		expect(forecast.overlaps).toHaveLength(1);
		expect(forecast.overlaps[0]).toMatchObject({ files: ["shared.txt"], prediction: "clean" });
	});

	test("an older git reports unavailable and never runs merge-tree", async () => {
		const { a, b } = fixture();
		const calls: string[][] = [];
		const old: CommandRunner = async (args, cwd) => {
			calls.push(args);
			if (args[0] === "version") return { code: 0, stdout: "git version 2.30.2\n", stderr: "" };
			return spawnGit(args, cwd);
		};
		const forecast = await forecastConflicts([forecastInput(a), forecastInput(b)], { git: old });
		expect(forecast.merge_tree).toBe("unavailable");
		expect(forecast.overlaps[0]).toMatchObject({ prediction: "unavailable", files: ["shared.txt"] });
		expect(forecast.notes.join(" ")).toContain("2.38");
		expect(calls.some((args) => args[0] === "merge-tree")).toBe(false);
		expect(forecast.rebase).toEqual([]);
	});

	test("pairs beyond the limit are reported unavailable, not skipped", async () => {
		const { a, b, d } = fixture();
		const forecast = await forecastConflicts([a, b, d].map((path) => forecastInput(path)), { git: spawnGit, maxPairs: 1 });
		expect(forecast.overlaps).toHaveLength(3);
		expect(forecast.overlaps.filter((pair) => pair.prediction === "unavailable")).toHaveLength(2);
		expect(forecast.notes.join(" ")).toContain("only the first 1");
	});
});

describe("suggestMergeOrder", () => {
	const pair = (a: string, b: string, prediction: OverlapPair["prediction"]): OverlapPair => ({ a, b, files: ["x"], prediction, conflicted_files: prediction === "conflict" ? ["x"] : [], detail: null });

	test("no overlaps first, then fewer files, ties by path", () => {
		const result = suggestMergeOrder(
			[
				{ path: "/w/z", files: ["1"] },
				{ path: "/w/a", files: ["1", "2", "3"] },
				{ path: "/w/m", files: ["1", "2"] },
				{ path: "/w/b", files: ["1"] },
				{ path: "/w/k", files: ["1"] },
			],
			[pair("/w/b", "/w/k", "clean")],
		);
		expect(result.order.map((step) => step.path)).toEqual(["/w/z", "/w/m", "/w/a", "/w/b", "/w/k"]);
		expect(result.order.map((step) => step.position)).toEqual([1, 2, 3, 4, 5]);
		expect(result.order[3]?.overlaps_with).toEqual(["/w/k"]);
		expect(result.rebase).toEqual([]);
	});

	test("the later of a conflicting pair is flagged for a rebase", () => {
		const result = suggestMergeOrder(
			[
				{ path: "/w/big", files: ["1", "2", "3"] },
				{ path: "/w/small", files: ["1"] },
			],
			[pair("/w/big", "/w/small", "conflict")],
		);
		expect(result.rebase).toEqual([{ path: "/w/big", after: "/w/small", files: ["x"] }]);
	});
});

describe("parsers", () => {
	test("git version and the merge-tree threshold", () => {
		expect(parseGitVersion("git version 2.43.0\n")).toEqual([2, 43]);
		expect(parseGitVersion("nothing")).toBeNull();
		expect(supportsMergeTree([2, 38])).toBe(true);
		expect(supportsMergeTree([2, 37])).toBe(false);
		expect(supportsMergeTree([3, 0])).toBe(true);
		expect(supportsMergeTree(null)).toBe(false);
	});

	test("merge-tree output lists conflicted paths until the blank line", () => {
		expect(parseMergeTree("f".repeat(40) + "\nsrc/a.ts\nb c.txt\n\nAuto-merging src/a.ts\nCONFLICT (content): ...\n")).toEqual(["src/a.ts", "b c.txt"]);
		expect(parseMergeTree("f".repeat(40) + "\n")).toEqual([]);
	});

	test("status -z paths keep spaces and ignore the status letters", () => {
		expect(parseStatusZ(" M a b.txt\0?? new.txt\0A  src/x.ts\0")).toEqual(["a b.txt", "new.txt", "src/x.ts"]);
	});
});

describe("an incomplete forecast says so", () => {
	test("a missing merge base or a failed diff marks the forecast incomplete and keeps the warning on the entry", async () => {
		const { a, b } = fixture();
		const noBase = await forecastConflicts([{ ...forecastInput(a), base: null }, forecastInput(b)], { git: spawnGit });
		expect(noBase.incomplete).toBe(true);
		expect(noBase.worktrees.find((entry) => entry.path === a)?.notes.join(" ")).toContain("no merge base");

		const failing: CommandRunner = async (args, cwd) => (args[0] === "diff" ? { code: 128, stdout: "", stderr: "fatal: bad revision" } : spawnGit(args, cwd));
		const broken = await forecastConflicts([forecastInput(a), forecastInput(b)], { git: failing });
		expect(broken.incomplete).toBe(true);
		expect(broken.worktrees.every((entry) => entry.notes.some((note) => note.startsWith("git diff failed")))).toBe(true);

		const whole = await forecastConflicts([forecastInput(a), forecastInput(b)], { git: spawnGit });
		expect(whole.incomplete).toBe(false);
	});
});
