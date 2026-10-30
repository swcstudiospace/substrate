import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { defaultGitBytesRunner, type GitBytesRunner } from "./gitio.ts";
import { ensureMirror, type MirrorState } from "./mirror.ts";
import { documentKey } from "./protocol.ts";
import { commitAll, defined, fingerprint, gitWorld, linkFile, runGit, tempDir, writeTree, type GitWorld } from "./test-support.ts";
import { buildView, readLocation, type ViewResult } from "./view.ts";

const run = defaultGitBytesRunner;
const REPO = "Acme/Alpha";
const roots: string[] = [];
afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sha = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

function world(files: Record<string, string | Uint8Array> = { "README.md": "# one\n", "docs/a.md": "a\n", "docs/b.md": "b\n" }): GitWorld {
	const made = gitWorld(files);
	roots.push(made.root);
	return made;
}

function mirrorDirOf(state: MirrorState): string {
	if (state.status === "absent") throw new Error(`no mirror: ${state.reason}`);
	return state.mirrorDir;
}

function read(w: GitWorld, options: { fetch?: boolean; maxBytes?: number } = {}): ViewResult {
	const state = ensureMirror(w.local, w.mirrors, run, { fetch: options.fetch ?? true });
	const result = buildView({ repo: REPO, repoDir: w.local, mirrorDir: mirrorDirOf(state), maxTier: 2, maxBytes: options.maxBytes ?? 1_000_000, runner: run });
	return defined(result, "a view");
}

function shas(view: ViewResult): Record<string, string> {
	return Object.fromEntries(view.entries.map((entry) => [entry.path, entry.sha256]));
}

/** The paths whose presence or content differs between two views. */
function changedPaths(before: ViewResult, after: ViewResult): string[] {
	const a = shas(before);
	const b = shas(after);
	return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((path) => a[path] !== b[path]).sort();
}

function pushFromOther(w: GitWorld, files: Record<string, string | Uint8Array>): void {
	writeTree(w.other, files);
	commitAll(w.other, "remote change");
	runGit(w.other, ["push", "-q", "origin", "main"]);
}

describe("buildView", () => {
	test("shows a remote-only push although the checkout did not move, and writes nothing into the checkout", () => {
		const w = world();
		const before = fingerprint(w.local);
		const first = read(w);
		expect(shas(first)).toEqual({ "README.md": sha("# one\n"), "docs/a.md": sha("a\n"), "docs/b.md": sha("b\n") });

		pushFromOther(w, { "docs/b.md": "b2\n", "docs/c.md": "c\n" });
		const second = read(w);

		expect(changedPaths(first, second)).toEqual(["docs/b.md", "docs/c.md"]);
		expect(shas(second)["docs/b.md"]).toBe(sha("b2\n"));
		expect(readFileSync(join(w.local, "docs/b.md"), "utf8")).toBe("b\n");
		expect(fingerprint(w.local)).toBe(before);
	});

	test("a local edit together with an unrelated remote change: both are visible", () => {
		const w = world();
		const base = read(w);
		writeTree(w.local, { "docs/a.md": "a-local\n" });
		pushFromOther(w, { "docs/b.md": "b-remote\n" });
		const before = fingerprint(w.local);

		const view = read(w);

		expect(shas(view)["docs/a.md"]).toBe(sha("a-local\n"));
		expect(shas(view)["docs/b.md"]).toBe(sha("b-remote\n"));
		expect(changedPaths(base, view)).toEqual(["docs/a.md", "docs/b.md"]);
		expect(view.fromWorkingTree).toBe(1);
		expect(view.problems).toEqual([]);
		expect(fingerprint(w.local)).toBe(before);
	});

	test("a committed but unpushed edit counts as a local change too", () => {
		const w = world();
		writeTree(w.local, { "docs/a.md": "a-committed\n" });
		commitAll(w.local, "local commit");
		pushFromOther(w, { "docs/b.md": "b-remote\n" });

		const view = read(w);

		expect(shas(view)["docs/a.md"]).toBe(sha("a-committed\n"));
		expect(shas(view)["docs/b.md"]).toBe(sha("b-remote\n"));
	});

	test("alternating local edits and remote pushes without pulling never flips a path that did not change", () => {
		const w = world();
		const v0 = read(w);

		writeTree(w.local, { "docs/a.md": "a1\n" });
		const v1 = read(w);
		expect(changedPaths(v0, v1)).toEqual(["docs/a.md"]);

		pushFromOther(w, { "docs/b.md": "b1\n" });
		const v2 = read(w);
		expect(changedPaths(v1, v2)).toEqual(["docs/b.md"]);

		pushFromOther(w, { "docs/c.md": "c1\n" });
		const v3 = read(w);
		expect(changedPaths(v2, v3)).toEqual(["docs/c.md"]);

		writeTree(w.local, { "docs/a.md": "a2\n" });
		const v4 = read(w);
		expect(changedPaths(v3, v4)).toEqual(["docs/a.md"]);

		// Reading again without any change in between is a no-op, with or without a fetch.
		expect(changedPaths(v4, read(w))).toEqual([]);
		expect(changedPaths(v4, read(w, { fetch: false }))).toEqual([]);

		// Reverting the local edit hands the path back to the mirror.
		runGit(w.local, ["checkout", "-q", "--", "docs/a.md"]);
		const v5 = read(w);
		expect(changedPaths(v4, v5)).toEqual(["docs/a.md"]);
		expect(shas(v5)["docs/a.md"]).toBe(sha("a\n"));
		expect(shas(v5)["docs/b.md"]).toBe(sha("b1\n"));
		expect(shas(v5)["docs/c.md"]).toBe(sha("c1\n"));
	});

	test("a failed fetch changes nothing and keeps reading the stale mirror; recovery brings the push in", () => {
		const w = world();
		const first = read(w);
		pushFromOther(w, { "docs/b.md": "b-remote\n" });
		const second = read(w);
		expect(changedPaths(first, second)).toEqual(["docs/b.md"]);

		renameSync(w.origin, `${w.origin}.away`);
		const offline = ensureMirror(w.local, w.mirrors, run, { fetch: true });
		expect(offline.status).toBe("stale");
		const stale = defined(buildView({ repo: REPO, repoDir: w.local, mirrorDir: mirrorDirOf(offline), maxTier: 2, maxBytes: 1_000_000, runner: run }), "a view");
		expect(changedPaths(second, stale)).toEqual([]);

		renameSync(`${w.origin}.away`, w.origin);
		pushFromOther(w, { "docs/a.md": "a-remote\n" });
		const recovered = read(w);
		expect(changedPaths(stale, recovered)).toEqual(["docs/a.md"]);
	});

	test("a path deleted locally is removed; a path deleted upstream disappears; an untracked document is included", () => {
		const w = world();
		rmSync(join(w.local, "docs/a.md"));
		writeTree(w.local, { "docs/new.md": "new\n", "notes.txt": "not a document\n" });
		runGit(w.other, ["rm", "-q", "docs/b.md"]);
		runGit(w.other, ["commit", "-q", "-m", "drop b"]);
		runGit(w.other, ["push", "-q", "origin", "main"]);

		const view = read(w);

		expect(Object.keys(shas(view)).sort()).toEqual(["README.md", "docs/new.md"]);
	});

	test("applies the scanner's rules: tier, size, binary, UTF-8 with the byte-order mark kept, empty, symlink and bad paths", () => {
		const bom = Uint8Array.of(0xef, 0xbb, 0xbf, ...new TextEncoder().encode("# bom\n"));
		const w = world({ "README.md": "# one\n" });
		writeTree(w.other, {
			"docs/binary.md": Uint8Array.of(97, 0, 98),
			"docs/latin.md": Uint8Array.of(0xff, 0xfe, 0x41),
			"docs/bom.md": bom,
			"docs/empty.md": "",
			"docs/big.md": "x".repeat(200),
			"src/index.ts": "export {};\n",
			"vendor/lib/README.md": "# vendored\n",
			"docs/odd\\name.md": "backslash\n",
		});
		linkFile(w.other, "docs/link.md", "../README.md");
		commitAll(w.other, "odd files");
		runGit(w.other, ["push", "-q", "origin", "main"]);

		const view = read(w, { maxBytes: 150 });

		expect(Object.keys(shas(view)).sort()).toEqual(["README.md", "docs/bom.md"]);
		expect(shas(view)["docs/bom.md"]).toBe(sha(bom));
		expect(view.entries.find((entry) => entry.path === "docs/bom.md")?.bytes).toBe(bom.byteLength);
		expect(view.skips.byReason).toEqual({ binary: 1, "invalid-utf8": 1, empty: 1, "too-large": 1, symlink: 1, "bad-path": 1 });
		expect(view.problems).toEqual([]);
		for (const entry of view.entries) expect(entry.source).toBe("fs");
	});

	test("entries carry the mirror's commit, or the checkout's for a local change", () => {
		const w = world();
		writeTree(w.local, { "docs/a.md": "a-local\n" });
		const view = read(w);
		const tip = runGit(w.origin, ["rev-parse", "main"]);
		const head = runGit(w.local, ["rev-parse", "HEAD"]);
		expect(view.tip).toBe(tip);
		expect(view.entries.find((entry) => entry.path === "docs/b.md")?.commit).toBe(tip);
		expect(view.entries.find((entry) => entry.path === "docs/a.md")?.commit).toBe(head);
	});

	test("a checkout with no common history is read incompletely, never as a reason to remove anything", () => {
		const w = world();
		pushFromOther(w, { "docs/remote-only.md": "remote\n" });
		runGit(w.local, ["checkout", "-q", "--orphan", "lone"]);
		writeTree(w.local, { "docs/a.md": "a-lone\n" });
		commitAll(w.local, "lone");

		const view = read(w);

		expect(view.mergeBase).toBeNull();
		expect(view.problems.join(" ")).toContain("shares no history");
		expect(shas(view)["docs/a.md"]).toBe(sha("a-lone\n"));
		expect(shas(view)["docs/remote-only.md"]).toBe(sha("remote\n"));
	});

	test("a mirror of an origin nobody pushed to yields no view, so the checkout is read from its working tree", () => {
		const root = tempDir("corpus-empty-");
		roots.push(root);
		const empty = join(root, "empty.git");
		const local = join(root, "local");
		runGit(root, ["init", "-q", "--bare", "-b", "main", empty]);
		runGit(root, ["init", "-q", "-b", "main", local]);
		writeTree(local, { "README.md": "# local\n" });
		commitAll(local, "first");
		runGit(local, ["remote", "add", "origin", empty]);
		const state = ensureMirror(local, join(root, "mirrors"), run, { fetch: true });
		expect(state.status).toBe("fetched");
		expect(buildView({ repo: REPO, repoDir: local, mirrorDir: mirrorDirOf(state), maxTier: 2, maxBytes: 1_000_000, runner: run })).toBeNull();
	});

	test("a directory that is not a repository is reported incomplete", () => {
		const w = world();
		const missing = join(w.root, "no-such-mirror");
		mkdirSync(missing);
		const view = defined(buildView({ repo: REPO, repoDir: w.local, mirrorDir: missing, maxTier: 2, maxBytes: 1_000_000, runner: run }), "a result");
		expect(view.entries).toEqual([]);
		expect(view.problems).toHaveLength(1);
	});

	test("a blobless mirror fetches the documentation blobs it lacks", () => {
		const w = world();
		// A file:// URL makes git honour the partial-clone filter; the plain path would copy every object.
		runGit(w.local, ["remote", "set-url", "origin", `file://${w.origin}`]);
		const state = ensureMirror(w.local, w.mirrors, run, { fetch: true });
		const mirror = mirrorDirOf(state);
		expect(runGit(mirror, ["config", "remote.origin.partialclonefilter"])).toBe("blob:none");

		const view = read(w);

		expect(shas(view)["docs/a.md"]).toBe(sha("a\n"));
		expect(view.problems).toEqual([]);
	});

	test("lists paths before sizes, and does not fetch a non-document blob", () => {
		const w = world({ "README.md": "# one\n", "docs/a.md": "a\n", "src/app.ts": "export const n = 1;\n" });
		const state = ensureMirror(w.local, w.mirrors, run, { fetch: true });
		const mirror = mirrorDirOf(state);
		const fetched: string[] = [];
		const runner: GitBytesRunner = (call) => {
			if (call.args[0] === "ls-tree" && call.args.includes("-l")) throw new Error("ls-tree asked for every blob size");
			if (call.args.includes("--stdin") && call.input !== undefined) fetched.push(call.input);
			return run(call);
		};
		const view = buildView({ repo: REPO, repoDir: w.local, mirrorDir: mirror, maxTier: 2, maxBytes: 1_000_000, runner });
		const asset = runGit(mirror, ["rev-parse", "HEAD:src/app.ts"]);
		expect(defined(view, "view").entries.some((entry) => entry.path === "src/app.ts")).toBe(false);
		expect(fetched.join("")).not.toContain(asset);
	});

	test("a dangling HEAD beside other branches is an incomplete read, not an empty origin", () => {
		const w = world();
		const mirror = mirrorDirOf(ensureMirror(w.local, w.mirrors, run, { fetch: true }));
		runGit(mirror, ["symbolic-ref", "HEAD", "refs/heads/missing"]);
		const view = buildView({ repo: REPO, repoDir: w.local, mirrorDir: mirror, maxTier: 2, maxBytes: 1_000_000, runner: run });
		expect(view).not.toBeNull();
		expect(defined(view, "view").problems.join(" ")).toContain("did not resolve");
		expect(view?.entries).toEqual([]);
	});
});

describe("readLocation", () => {
	test("reads a mirror blob through git and a working-tree path through readFile, and refuses anything else", () => {
		const w = world();
		writeTree(w.local, { "docs/a.md": "a-local\n" });
		const view = read(w);
		const mirrored = defined(view.paths.get(documentKey(REPO, "docs/b.md")), "a mirror location");
		const local = defined(view.paths.get(documentKey(REPO, "docs/a.md")), "a working-tree location");

		const reader = (path: string): Uint8Array => readFileSync(path);
		expect(new TextDecoder().decode(readLocation(mirrored, run, reader))).toBe("b\n");
		expect(new TextDecoder().decode(readLocation(local, run, reader))).toBe("a-local\n");
		expect(() => readLocation("git-blob:not-an-object@/tmp", run, reader)).toThrow();
		expect(() => readLocation(`git-blob:${"0".repeat(40)}@${w.mirrors}/absent`, run, reader)).toThrow();
	});
});
