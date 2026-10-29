import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { CorpusEntry } from "../protocol.ts";
import { defined } from "../test-support.ts";
import { type GhResult, type GhRunner, scanGithub } from "./github.ts";

interface TreeItem {
	path: string;
	type?: string;
	sha: string;
	mode?: string;
	size?: number;
}

interface FakeRepo {
	branch: string | null;
	archived?: boolean;
	commit?: string | "fail";
	tree?: TreeItem[] | "fail" | "throw";
	truncated?: boolean;
	/** Blob sha to content; "fail" makes the blob call fail. */
	blobs?: Record<string, string | Uint8Array | "fail">;
}

interface FakeGh extends GhRunner {
	calls: string[][];
	maxInFlight: () => number;
}

const COMMIT = "c".repeat(40);
const ok = (stdout: string): GhResult => ({ code: 0, stdout });
const fail: GhResult = { code: 1, stdout: "" };

function fakeGh(repos: Record<string, FakeRepo>, options: { listFails?: boolean } = {}): FakeGh {
	const calls: string[][] = [];
	let inFlight = 0;
	let peak = 0;
	const run = (async (args: string[]): Promise<GhResult> => {
		calls.push(args);
		inFlight += 1;
		peak = Math.max(peak, inFlight);
		try {
			// Yield a few times so concurrent callers overlap and the limiter is the only thing bounding them.
			for (let i = 0; i < 3; i++) await Promise.resolve();
			if (args[0] === "repo") {
				if (options.listFails === true) return fail;
				return ok(
					JSON.stringify(
						Object.entries(repos).map(([slug, repo]) => ({
							nameWithOwner: slug,
							isArchived: repo.archived === true,
							defaultBranchRef: repo.branch === null ? null : { name: repo.branch },
						})),
					),
				);
			}
			const route = /^repos\/([^/]+\/[^/]+)\/(commits|git\/trees|git\/blobs)\/(.+)$/.exec(args[args.length - 1] ?? "");
			const repo = repos[route?.[1] ?? ""];
			if (route === null || repo === undefined) return fail;
			if (route[2] === "commits") return repo.commit === "fail" ? fail : ok(`${repo.commit ?? COMMIT}\n`);
			if (route[2] === "git/trees") {
				if (repo.tree === "throw") throw new Error("gh vanished");
				if (repo.tree === undefined || repo.tree === "fail") return fail;
				const ref = route[3]?.replace("?recursive=1", "");
				if (repo.commit === "fail" ? ref !== repo.branch : ref !== (repo.commit ?? COMMIT)) return fail;
				return ok(JSON.stringify({ sha: "t".repeat(40), truncated: repo.truncated === true, tree: repo.tree.map((item) => ({ type: "blob", mode: "100644", ...item })) }));
			}
			const blob = repo.blobs?.[route[3] ?? ""];
			if (blob === undefined || blob === "fail") return fail;
			return ok(JSON.stringify({ encoding: "base64", content: Buffer.from(blob).toString("base64").replace(/(.{60})/g, "$1\n") }));
		} finally {
			inFlight -= 1;
		}
	}) as FakeGh;
	run.calls = calls;
	run.maxInFlight = () => peak;
	return run;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

function alpha(): FakeRepo {
	return {
		branch: "main",
		tree: [
			{ path: "README.md", sha: "s-readme" },
			{ path: "docs", type: "tree", sha: "s-docs" },
			{ path: "docs/a.md", sha: "s-a" },
			{ path: "docs/research/r.md", sha: "s-r" },
			{ path: "notes/loose.md", sha: "s-loose" },
			{ path: "src/x.ts", sha: "s-ts" },
			{ path: "docs/big.md", sha: "s-big", size: 5000 },
			{ path: "docs/empty.md", sha: "s-empty", size: 0 },
			{ path: "docs/link.md", sha: "s-link", mode: "120000" },
			{ path: "docs/bin.md", sha: "s-bin" },
		],
		blobs: {
			"s-readme": "# alpha\n",
			"s-a": "doc a\n",
			"s-r": "research\n",
			"s-loose": "loose\n",
			"s-bin": Uint8Array.of(65, 0, 66),
		},
	};
}

describe("scanGithub", () => {
	test("reads documentation blobs of the default branch into entries and hands each body to onBody", async () => {
		const gh = fakeGh({
			"Acme/Alpha": alpha(),
			"Acme/Old": { ...alpha(), archived: true },
			"Acme/Cloned": alpha(),
			"Acme/Empty": { branch: null },
		});
		const bodies = new Map<string, string>();
		const result = await scanGithub({
			owner: "Acme",
			gh,
			skipRepos: ["acme/cloned"],
			maxBytes: 1000,
			onBody: (entry: CorpusEntry, body: string) => {
				bodies.set(`${entry.repo}:${entry.path}`, body);
			},
		});
		expect(result.entries).toEqual([
			{ repo: "Acme/Alpha", path: "README.md", kind: "readme", tier: 1, sha256: sha256("# alpha\n"), bytes: 8, source: "github", commit: COMMIT },
			{ repo: "Acme/Alpha", path: "docs/a.md", kind: "doc", tier: 1, sha256: sha256("doc a\n"), bytes: 6, source: "github", commit: COMMIT },
			{ repo: "Acme/Alpha", path: "docs/research/r.md", kind: "doc", tier: 2, sha256: sha256("research\n"), bytes: 9, source: "github", commit: COMMIT },
		]);
		expect([...bodies.keys()].sort()).toEqual(["Acme/Alpha:README.md", "Acme/Alpha:docs/a.md", "Acme/Alpha:docs/research/r.md"]);
		expect(bodies.get("Acme/Alpha:docs/a.md")).toBe("doc a\n");
		expect(Object.fromEntries(result.skipped.map((s) => [s.path, s.reason]))).toEqual({
			"docs/big.md": "too-large",
			"docs/empty.md": "empty",
			"docs/link.md": "symlink",
			"docs/bin.md": "binary",
		});
		expect(result.repos.map((r) => ({ repo: r.repo, files: r.files, complete: r.complete, dir: r.dir }))).toEqual([
			{ repo: "Acme/Alpha", files: 3, complete: true, dir: "github:Acme/Alpha" },
			{ repo: "Acme/Empty", files: 0, complete: true, dir: "github:Acme/Empty" },
		]);
		expect(result.paths.size).toBe(0);
		// Archived, locally cloned and refused-by-size blobs never cost a call.
		const joined = gh.calls.map((call) => call.join(" "));
		expect(joined.some((call) => call.includes("Acme/Old") || call.includes("Acme/Cloned"))).toBe(false);
		expect(joined.some((call) => call.includes("s-big") || call.includes("s-empty") || call.includes("s-link") || call.includes("s-loose"))).toBe(false);
		expect(joined[0]).toBe("repo list Acme --json nameWithOwner,isArchived,defaultBranchRef -L 1000");
	});

	test("the tier bound drops research at tier 1 and brings loose notes at tier 3, without fetching what it drops", async () => {
		const gh = fakeGh({ "Acme/Alpha": alpha() });
		const one = await scanGithub({ owner: "Acme", gh, maxTier: 1, maxBytes: 1000 });
		expect(one.entries.map((e) => e.path)).toEqual(["README.md", "docs/a.md"]);
		expect(gh.calls.some((call) => call[call.length - 1] === "repos/Acme/Alpha/git/blobs/s-r")).toBe(false);
		const three = await scanGithub({ owner: "Acme", gh: fakeGh({ "Acme/Alpha": alpha() }), maxTier: 3, maxBytes: 1000 });
		expect(three.entries.map((e) => e.path)).toContain("notes/loose.md");
	});

	test("maxRepos reads the first repositories by name and notes the rest", async () => {
		const gh = fakeGh({ "Acme/Zed": alpha(), "Acme/Alpha": alpha(), "Acme/Mid": alpha() });
		const result = await scanGithub({ owner: "Acme", gh, maxRepos: 2, maxBytes: 1000 });
		expect(result.repos.map((r) => r.repo)).toEqual(["Acme/Alpha", "Acme/Mid"]);
		expect(result.notes.some((note) => note.includes("1 repositories"))).toBe(true);
		expect(gh.calls.some((call) => call.join(" ").includes("Acme/Zed/"))).toBe(false);
	});

	test("a repository whose tree, blob or runner fails is reported and the others still finish", async () => {
		const gh = fakeGh({
			"Acme/Alpha": alpha(),
			"Acme/TreeFail": { branch: "main", tree: "fail" },
			"Acme/Thrower": { branch: "main", tree: "throw" },
			"Acme/BlobFail": { branch: "main", tree: [{ path: "README.md", sha: "s1" }, { path: "docs/a.md", sha: "s2" }], blobs: { s1: "fine\n", s2: "fail" } },
		});
		const result = await scanGithub({ owner: "Acme", gh, maxBytes: 1000 });
		const byRepo = new Map(result.repos.map((r) => [r.repo, r]));
		expect(byRepo.get("Acme/Alpha")).toMatchObject({ complete: true, files: 3 });
		expect(byRepo.get("Acme/TreeFail")).toMatchObject({ complete: false, files: 0 });
		expect(byRepo.get("Acme/Thrower")).toMatchObject({ complete: false, files: 0 });
		expect(byRepo.get("Acme/BlobFail")).toMatchObject({ complete: false, files: 1 });
		expect(defined(byRepo.get("Acme/Thrower")?.incomplete, "reason")).toContain("gh vanished");
		const failed = result.skipped.filter((s) => s.reason === "fetch-failed").map((s) => `${s.repo}:${s.path}`);
		expect(failed).toEqual(["Acme/BlobFail:docs/a.md", "Acme/Thrower:(repository)", "Acme/TreeFail:(tree)"]);
		expect(result.entries.filter((e) => e.repo === "Acme/BlobFail").map((e) => e.path)).toEqual(["README.md"]);
	});

	test("a truncated tree keeps what it listed but is not complete", async () => {
		const gh = fakeGh({ "Acme/Big": { ...alpha(), truncated: true } });
		const result = await scanGithub({ owner: "Acme", gh, maxBytes: 1000 });
		expect(defined(result.repos[0], "report")).toMatchObject({ complete: false, files: 3 });
		expect(defined(result.repos[0]?.incomplete, "reason")).toContain("truncated");
	});

	test("an unresolved head commit falls back to the branch name and leaves entries without a commit", async () => {
		const gh = fakeGh({ "Acme/Alpha": { ...alpha(), commit: "fail" } });
		const result = await scanGithub({ owner: "Acme", gh, maxBytes: 1000 });
		expect(result.entries).toHaveLength(3);
		expect(result.entries.every((e) => e.commit === undefined)).toBe(true);
		expect(defined(result.repos[0], "report").complete).toBe(true);
	});

	test("a failed repository listing reads nothing and says so", async () => {
		const result = await scanGithub({ owner: "Acme", gh: fakeGh({ "Acme/Alpha": alpha() }, { listFails: true }) });
		expect(result.entries).toEqual([]);
		expect(result.repos).toEqual([]);
		expect(result.notes.some((note) => note.includes("gh repo list"))).toBe(true);
	});

	test("an owner that could be read as a flag is refused before any call", async () => {
		const gh = fakeGh({});
		const result = await scanGithub({ owner: "--limit", gh });
		expect(gh.calls).toEqual([]);
		expect(result.entries).toEqual([]);
	});

	test("gh calls never exceed the concurrency bound", async () => {
		const items: TreeItem[] = Array.from({ length: 30 }, (_, i) => ({ path: `docs/p${i}.md`, sha: `s${i}` }));
		const blobs = Object.fromEntries(items.map((item) => [item.sha, `page ${item.sha}\n`]));
		const repos = Object.fromEntries(["A", "B", "C"].map((name) => [`Acme/${name}`, { branch: "main", tree: items, blobs } satisfies FakeRepo]));
		const narrow = fakeGh(repos);
		const result = await scanGithub({ owner: "Acme", gh: narrow, concurrency: 3 });
		expect(result.entries).toHaveLength(90);
		expect(narrow.maxInFlight()).toBeLessThanOrEqual(3);
		expect(narrow.maxInFlight()).toBeGreaterThan(1);
		const wide = fakeGh(repos);
		await scanGithub({ owner: "Acme", gh: wide });
		expect(wide.maxInFlight()).toBeLessThanOrEqual(4);
	});

	test("two scans give the same entries in the same order", async () => {
		const first = await scanGithub({ owner: "Acme", gh: fakeGh({ "Acme/B": alpha(), "Acme/A": alpha() }), maxBytes: 1000 });
		const second = await scanGithub({ owner: "Acme", gh: fakeGh({ "Acme/A": alpha(), "Acme/B": alpha() }), maxBytes: 1000 });
		expect(JSON.stringify(second.entries)).toBe(JSON.stringify(first.entries));
	});
});
