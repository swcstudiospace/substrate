import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { documentKey } from "./protocol.ts";
import { buildScope, inspectBytes, MAX_LISTED_SKIPS, type RepoReport, scanRoots, SkipLog } from "./scan.ts";
import { defined, fakeGit, linkFile, tempDir, writeTree } from "./test-support.ts";

const dirs: string[] = [];
function fixture(files: Record<string, string | Uint8Array>): string {
	const root = tempDir();
	dirs.push(root);
	writeTree(root, files);
	return root;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const HEAD = "b".repeat(40);

describe("inspectBytes", () => {
	test("hashes the raw bytes and refuses empty, over-size, NUL and invalid UTF-8 input", () => {
		const ok = inspectBytes(new TextEncoder().encode("abc"), 10);
		expect(ok).toEqual({ ok: true, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", bytes: 3, text: "abc" });
		expect(inspectBytes(new Uint8Array(0), 10)).toEqual({ ok: false, reason: "empty" });
		expect(inspectBytes(new Uint8Array(11).fill(97), 10)).toEqual({ ok: false, reason: "too-large" });
		expect(inspectBytes(new Uint8Array(10).fill(97), 10).ok).toBe(true);
		expect(inspectBytes(Uint8Array.of(97, 0, 98), 10)).toEqual({ ok: false, reason: "binary" });
		expect(inspectBytes(Uint8Array.of(0xff, 0xfe, 0x41), 10)).toEqual({ ok: false, reason: "invalid-utf8" });
	});
});

describe("SkipLog", () => {
	test("lists a bounded number of skips and counts every one", () => {
		const log = new SkipLog();
		for (let i = 0; i < MAX_LISTED_SKIPS + 5; i++) log.add({ repo: "r", path: `p${i}.md`, reason: "empty" });
		expect(log.listed).toHaveLength(MAX_LISTED_SKIPS);
		expect(log.byReason.empty).toBe(MAX_LISTED_SKIPS + 5);
	});
});

describe("scanRoots over a git checkout", () => {
	const origin = "git@github.com:Acme/Alpha.git";

	function checkoutFixture(): { root: string; dir: string; files: string[] } {
		const files = [
			"README.md",
			"docs/guide.md",
			"docs/empty.md",
			"docs/binary.md",
			"docs/latin1.md",
			"docs/huge.md",
			"docs/link.md",
			"docs/gone.md",
			"docs/research/notes.md",
			"notes/loose.md",
			"src/index.ts",
			"node_modules/pkg/README.md",
		];
		const root = fixture({
			"alpha/.git/HEAD": "",
			"alpha/README.md": "# alpha\n",
			"alpha/docs/guide.md": "guide\n",
			"alpha/docs/empty.md": "",
			"alpha/docs/binary.md": Uint8Array.of(35, 0, 1, 2),
			"alpha/docs/latin1.md": Uint8Array.of(0xe9, 0x74, 0xe9),
			"alpha/docs/huge.md": "x".repeat(2000),
			"alpha/docs/research/notes.md": "research\n",
			"alpha/notes/loose.md": "loose\n",
			"alpha/src/index.ts": "export {};\n",
			"alpha/node_modules/pkg/README.md": "dep\n",
			"alpha/real-target.md": "target\n",
		});
		linkFile(join(root, "alpha"), "docs/link.md", join(root, "alpha", "real-target.md"));
		return { root, dir: join(root, "alpha"), files };
	}

	test("keeps tier-2-and-above documents with their hashes, and skips symlink, empty, binary, bad UTF-8, over-size and missing files with a reason", async () => {
		const { root, dir, files } = checkoutFixture();
		const result = await scanRoots({
			roots: [root],
			maxBytes: 1000,
			runner: fakeGit({ [dir]: { origin, head: HEAD, branch: "main", remoteDefault: "main", files } }),
		});
		expect(result.entries.map((e) => `${e.repo}:${e.path}`)).toEqual([
			"Acme/Alpha:README.md",
			"Acme/Alpha:docs/guide.md",
			"Acme/Alpha:docs/research/notes.md",
		]);
		const guide = defined(result.entries[1], "guide");
		expect(guide).toEqual({
			repo: "Acme/Alpha",
			path: "docs/guide.md",
			kind: "doc",
			tier: 1,
			sha256: sha("guide\n"),
			bytes: 6,
			source: "fs",
			commit: HEAD,
		});
		expect(defined(result.entries[2], "research").tier).toBe(2);
		const reasons = Object.fromEntries(result.report.skipped.map((s) => [s.path, s.reason]));
		expect(reasons).toEqual({
			"docs/empty.md": "empty",
			"docs/binary.md": "binary",
			"docs/latin1.md": "invalid-utf8",
			"docs/huge.md": "too-large",
			"docs/link.md": "symlink",
			"docs/gone.md": "missing",
		});
		expect(result.report.skippedByReason).toEqual({ empty: 1, binary: 1, "invalid-utf8": 1, "too-large": 1, symlink: 1, missing: 1 });
		// A refused file is a documented rule, not a failed read: the repository is still complete.
		const repo = defined(result.report.repos[0], "repo report");
		expect(repo).toMatchObject({ repo: "Acme/Alpha", files: 3, complete: true });
		expect(repo.bytes).toBe(entriesBytes(result.entries));
	});

	test("an over-size file is refused from its size, before it is read", async () => {
		const { root, dir, files } = checkoutFixture();
		const read: string[] = [];
		await scanRoots({
			roots: [root],
			maxBytes: 1000,
			runner: fakeGit({ [dir]: { origin, files } }),
			readFile: (path) => {
				read.push(path);
				return readFileSync(path);
			},
		});
		expect(read.some((path) => path.endsWith("huge.md"))).toBe(false);
		expect(read.some((path) => path.endsWith("guide.md"))).toBe(true);
	});

	test("maxTier bounds the entries: tier 1 drops research, tier 3 adds the loose notes", async () => {
		const { root, dir, files } = checkoutFixture();
		const runner = fakeGit({ [dir]: { origin, head: HEAD, branch: "main", remoteDefault: "main", files } });
		const one = await scanRoots({ roots: [root], maxTier: 1, maxBytes: 1000, runner });
		expect(one.entries.map((e) => e.path)).toEqual(["README.md", "docs/guide.md"]);
		const three = await scanRoots({ roots: [root], maxTier: 3, maxBytes: 1000, runner });
		expect(three.entries.map((e) => e.path)).toContain("notes/loose.md");
		expect(three.entries.every((e) => e.tier <= 3)).toBe(true);
	});

	test("two scans of the same tree are byte-identical", async () => {
		const { root, dir, files } = checkoutFixture();
		const make = () => fakeGit({ [dir]: { origin, head: HEAD, branch: "main", remoteDefault: "main", files } });
		const first = await scanRoots({ roots: [root], runner: make() });
		const second = await scanRoots({ roots: [root], runner: make() });
		expect(JSON.stringify({ entries: first.entries, report: first.report })).toBe(JSON.stringify({ entries: second.entries, report: second.report }));
	});

	test("entries are sorted by repo then path by code unit", async () => {
		const root = fixture({
			"b/.git/HEAD": "",
			"a/.git/HEAD": "",
			"a/docs/z.md": "z",
			"a/docs/B.md": "b",
			"a/README.md": "r",
			"b/README.md": "r2",
		});
		const runner = fakeGit({
			[join(root, "a")]: { origin: "git@github.com:Acme/A.git", files: ["docs/z.md", "docs/B.md", "README.md"], branch: "main" },
			[join(root, "b")]: { origin: "git@github.com:Acme/B.git", files: ["README.md"], branch: "main" },
		});
		const result = await scanRoots({ roots: [root], runner });
		expect(result.entries.map(({ repo, path }) => documentKey(repo, path))).toEqual([
			"Acme/A:README.md",
			"Acme/A:docs/B.md",
			"Acme/A:docs/z.md",
			"Acme/B:README.md",
		]);
	});

	test("a repository whose listing or a file read fails is reported incomplete and the others are still read", async () => {
		const root = fixture({
			"broken/.git/HEAD": "",
			"flaky/.git/HEAD": "",
			"fine/.git/HEAD": "",
			"flaky/README.md": "flaky",
			"flaky/docs/a.md": "a",
			"fine/README.md": "fine",
		});
		const runner = fakeGit({
			[join(root, "broken")]: { origin: "git@github.com:Acme/Broken.git", lsFilesFails: true, branch: "main" },
			[join(root, "flaky")]: { origin: "git@github.com:Acme/Flaky.git", files: ["README.md", "docs/a.md"], branch: "main" },
			[join(root, "fine")]: { origin: "git@github.com:Acme/Fine.git", files: ["README.md"], branch: "main" },
		});
		const result = await scanRoots({
			roots: [root],
			runner,
			readFile: (path) => {
				if (path.endsWith(join("flaky", "docs", "a.md"))) throw new Error("EACCES: permission denied");
				return readFileSync(path);
			},
		});
		const byRepo = new Map(result.report.repos.map((r) => [r.repo, r]));
		expect(byRepo.get("Acme/Broken")).toMatchObject({ complete: false, files: 0 });
		expect(byRepo.get("Acme/Flaky")).toMatchObject({ complete: false, files: 1 });
		expect(byRepo.get("Acme/Fine")).toMatchObject({ complete: true, files: 1 });
		expect(defined(byRepo.get("Acme/Broken")?.incomplete, "reason")).toContain("ls-files");
		expect(result.entries.map((e) => e.repo)).toEqual(["Acme/Fine", "Acme/Flaky"]);
		// What the plan may judge: only the repository that read completely.
		expect(buildScope({ reports: result.report.repos, maxTier: 2, sources: ["fs"] }).repos).toEqual(["Acme/Fine"]);
	});

	test("a clone and a linked worktree of one origin scan as one repository", async () => {
		const root = fixture({
			"main/.git/HEAD": "",
			"wt/.git": "gitdir: ../main/.git/worktrees/wt",
			"clone/.git/HEAD": "",
			"main/README.md": "main",
			"wt/README.md": "wt",
			"clone/README.md": "clone",
		});
		const common = join(root, "main", ".git");
		const base = { origin, remoteDefault: "main" };
		const runner = fakeGit({
			[join(root, "main")]: { ...base, branch: "main", commonDir: common, files: ["README.md"] },
			[join(root, "wt")]: { ...base, branch: "wip", commonDir: common, gitDir: join(common, "worktrees", "wt"), files: ["README.md"] },
			[join(root, "clone")]: { ...base, branch: "wip", files: ["README.md"] },
		});
		const result = await scanRoots({ roots: [root], runner });
		expect(result.report.checkouts).toBe(3);
		expect(result.report.collapsed).toMatchObject({ worktrees: 1, clones: 1 });
		expect(result.report.repos).toHaveLength(1);
		expect(result.entries).toHaveLength(1);
		expect(readFileSync(defined(result.paths.get("Acme/Alpha:README.md"), "path"), "utf8")).toBe("main");
	});
});

describe("scanRoots over copy collections", () => {
	const GUIDE = "# shared guide\n";

	function collections(extra: Record<string, string> = {}): string {
		return fixture({
			"c1/docs/guide.md": GUIDE,
			"c1/docs/only-one.md": "one only",
			"c2/docs/guide.md": GUIDE,
			"c3/docs/guide.md": GUIDE,
			...extra,
		});
	}

	test("three identical files in three collections collapse to the lexically smallest, the report names the others, and the next scan keeps the next one when it disappears", async () => {
		const root = collections();
		const first = await scanRoots({ roots: [root], runner: fakeGit({}) });
		const guides = first.entries.filter((e) => e.sha256 === sha(GUIDE));
		expect(guides.map((e) => documentKey(e.repo, e.path))).toEqual(["local/c1:docs/guide.md"]);
		expect(first.report.collapsed.identical).toBe(2);
		expect(first.report.collapsed.identicalGroups).toBe(1);
		expect(first.report.collapsed.identicalCopies).toEqual([
			{ keep: "local/c1:docs/guide.md", copies: ["local/c2:docs/guide.md", "local/c3:docs/guide.md"] },
		]);
		// The collapsed copies have no body location; the canonical one does.
		expect(first.paths.has("local/c2:docs/guide.md")).toBe(false);
		expect(first.paths.has("local/c1:docs/guide.md")).toBe(true);
		expect(first.entries.map((e) => documentKey(e.repo, e.path))).toContain("local/c1:docs/only-one.md");

		rmSync(join(root, "c1", "docs", "guide.md"));
		const second = await scanRoots({ roots: [root], runner: fakeGit({}) });
		expect(second.entries.filter((e) => e.sha256 === sha(GUIDE)).map((e) => documentKey(e.repo, e.path))).toEqual(["local/c2:docs/guide.md"]);
		expect(second.report.collapsed.identicalCopies).toEqual([{ keep: "local/c2:docs/guide.md", copies: ["local/c3:docs/guide.md"] }]);
		expect(second.report.collapsed.identical).toBe(1);
	});

	test("identical files inside one repository stay, and identical files in a repository with an origin are never collapsed", async () => {
		const root = fixture({
			"c1/docs/a.md": GUIDE,
			"c1/docs/b.md": GUIDE,
			"real/.git/HEAD": "",
			"real/docs/a.md": GUIDE,
		});
		const runner = fakeGit({ [join(root, "real")]: { origin: "git@github.com:Acme/Real.git", files: ["docs/a.md"], branch: "main" } });
		const result = await scanRoots({ roots: [root], runner });
		expect(result.entries.map((e) => documentKey(e.repo, e.path))).toEqual([
			"Acme/Real:docs/a.md",
			"local/c1:docs/a.md",
			"local/c1:docs/b.md",
		]);
		expect(result.report.collapsed.identical).toBe(0);
	});

	test("the listed groups and copies are bounded while the totals stay exact", async () => {
		const files: Record<string, string> = {};
		for (let group = 0; group < 205; group++) {
			for (const collection of ["a", "b"]) files[`${collection}/docs/g${String(group).padStart(3, "0")}.md`] = `group ${group}\n`;
		}
		const result = await scanRoots({ roots: [fixture(files)], runner: fakeGit({}) });
		expect(result.report.collapsed.identical).toBe(205);
		expect(result.report.collapsed.identicalGroups).toBe(205);
		expect(result.report.collapsed.identicalCopies).toHaveLength(200);

		const many: Record<string, string> = {};
		for (let copy = 0; copy < 25; copy++) many[`c${String(copy).padStart(2, "0")}/docs/x.md`] = "same\n";
		const crowded = await scanRoots({ roots: [fixture(many)], runner: fakeGit({}) });
		expect(crowded.report.collapsed.identical).toBe(24);
		expect(defined(crowded.report.collapsed.identicalCopies[0], "group").copies).toHaveLength(20);
	});

	test("a symlinked document in a collection is skipped, and a nested checkout is read once, as its own repository", async () => {
		const root = fixture({
			"pile/docs/a.md": "a\n",
			"pile/real.md": "real\n",
			"pile/nested/.git/HEAD": "",
			"pile/nested/README.md": "nested\n",
		});
		linkFile(join(root, "pile"), "docs/alias.md", join(root, "pile", "real.md"));
		const nested = join(root, "pile", "nested");
		const result = await scanRoots({ roots: [root], runner: fakeGit({ [nested]: { origin: "git@github.com:Acme/Nested.git", files: ["README.md"], branch: "main" } }) });
		const keys = result.entries.map((e) => documentKey(e.repo, e.path));
		expect(keys).toContain("Acme/Nested:README.md");
		expect(keys).toContain("local/pile:docs/a.md");
		expect(keys.filter((key) => key.includes("nested/README.md"))).toEqual([]);
		expect(result.report.skipped).toContainEqual({ repo: "local/pile", path: "docs/alias.md", reason: "symlink" });
	});

	test("a file that cannot be read leaves its collection incomplete", async () => {
		const root = fixture({ "c1/docs/a.md": "a\n" });
		const result = await scanRoots({ roots: [root], runner: fakeGit({}), readFile: () => { throw new Error("EIO"); } });
		expect(defined(result.report.repos[0], "report")).toMatchObject({ repo: "local/c1", complete: false });
		expect(result.entries).toEqual([]);
	});
});

describe("buildScope", () => {
	const report = (repo: string, complete: boolean, source: RepoReport["source"] = "fs"): RepoReport => ({ repo, dir: repo, source, files: 1, bytes: 1, complete });

	test("lists only repositories every source read completely, sorted, with the scan's tier and the sources it used", () => {
		const scope = buildScope({
			reports: [report("b/two", true), report("a/one", true), report("c/three", false), report("a/one", false, "greptile"), report("d/four", true, "github")],
			maxTier: 1,
			sources: ["github", "fs"],
		});
		expect(scope).toEqual({ repos: ["b/two", "d/four"], maxTier: 1, sources: ["fs", "github"] });
	});

	test("a scan that read nothing covers nothing", () => {
		expect(buildScope({ reports: [], maxTier: 2, sources: ["fs"] })).toEqual({ repos: [], maxTier: 2, sources: ["fs"] });
	});
});

function entriesBytes(entries: ReadonlyArray<{ bytes: number }>): number {
	return entries.reduce((sum, entry) => sum + entry.bytes, 0);
}
