import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { stripCredentials } from "./discover.ts";
import { defaultGitBytesRunner, type GitBytesRunner } from "./gitio.ts";
import { ensureMirror, mirrorName, mirrorPath, readOrigin } from "./mirror.ts";
import { commitAll, fingerprint, gitWorld, runGit, tempDir, writeTree, type GitWorld } from "./test-support.ts";

const run = defaultGitBytesRunner;
const roots: string[] = [];
afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function world(): GitWorld {
	const made = gitWorld({ "README.md": "# one\n", "docs/a.md": "a\n" });
	roots.push(made.root);
	return made;
}

describe("mirrorName", () => {
	test("is stable for one origin, ignores credentials and a .git suffix, and differs between origins", () => {
		const plain = mirrorName("https://github.com/Acme/Alpha.git");
		expect(mirrorName("https://user:secret@github.com/Acme/Alpha.git")).toBe(plain);
		expect(mirrorName("https://github.com/Acme/Alpha")).toBe(plain);
		expect(mirrorName("https://github.com/Acme/Beta.git")).not.toBe(plain);
		expect(plain).toMatch(/^Acme-Alpha-[0-9a-f]{12}$/);
		expect(mirrorName("git@github.com:Acme/Alpha")).toBe(plain);
		expect(mirrorName("ssh://git@github.com/Acme/Alpha.git")).toBe(plain);
		expect(mirrorName("https://github.com/Other/Alpha.git")).not.toBe(plain);
		expect(mirrorName("https://git.example.com/foo/bar.git")).toBe(mirrorName("git@git.example.com:foo/bar"));
	});

	test("a mirror created under the old https hash is reused when the origin is rewritten to ssh", () => {
		const w = world();
		const https = "https://github.com/Acme/Alpha.git";
		const stripped = stripCredentials(https).replace(/\/+$/, "").replace(/\.git$/, "");
		const hash = createHash("sha256").update(stripped).digest("hex").slice(0, 12);
		const legacy = join(w.mirrors, `Acme-Alpha-${hash}`);
		mkdirSync(w.mirrors, { recursive: true });
		runGit(w.mirrors, ["init", "-q", "--bare", legacy]);
		runGit(w.local, ["remote", "set-url", "origin", "git@github.com:Acme/Alpha.git"]);
		expect(ensureMirror(w.local, w.mirrors, run, { fetch: false })).toEqual({ status: "unfetched", mirrorDir: legacy });
	});

	test("never yields a path separator, a leading dot or an empty slug", () => {
		for (const origin of ["/srv/git/../repo.git", "ssh://host/~/weird name!.git", "https://h/.hidden", "/"]) {
			const name = mirrorName(origin);
			expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*-[0-9a-f]{12}$/);
		}
	});
});

describe("ensureMirror", () => {
	test("a checkout without an origin gets no mirror", () => {
		const bare = tempDir("corpus-noorigin-");
		roots.push(bare);
		runGit(bare, ["init", "-q"]);
		expect(readOrigin(bare, run)).toBeNull();
		expect(ensureMirror(bare, join(bare, "mirrors"), run, { fetch: true })).toEqual({ status: "absent", reason: "no-origin" });
	});

	test("without fetch a missing mirror is not created, and nothing is written", () => {
		const w = world();
		const state = ensureMirror(w.local, w.mirrors, run, { fetch: false });
		expect(state).toEqual({ status: "absent", reason: "not-created" });
		expect(existsSync(w.mirrors)).toBe(false);
	});

	test("creates a bare mirror once, then fetches into it, and never writes into the checkout", () => {
		const w = world();
		const before = fingerprint(w.local);

		const created = ensureMirror(w.local, w.mirrors, run, { fetch: true });
		expect(created.status).toBe("fetched");
		if (created.status !== "fetched") throw new Error("expected a fetched mirror");
		expect(created.created).toBe(true);
		expect(created.mirrorDir).toBe(mirrorPath(w.mirrors, w.origin));
		expect(runGit(created.mirrorDir, ["rev-parse", "--is-bare-repository"])).toBe("true");

		const again = ensureMirror(w.local, w.mirrors, run, { fetch: true });
		expect(again).toEqual({ status: "fetched", mirrorDir: created.mirrorDir, created: false });
		expect(ensureMirror(w.local, w.mirrors, run, { fetch: false })).toEqual({ status: "unfetched", mirrorDir: created.mirrorDir });
		expect(readdirSync(w.mirrors)).toEqual([mirrorName(w.origin)]);
		expect(fingerprint(w.local)).toBe(before);
	});

	test("a failed fetch leaves the mirror as it was and says stale; recovery fetches again", () => {
		const w = world();
		const created = ensureMirror(w.local, w.mirrors, run, { fetch: true });
		if (created.status !== "fetched") throw new Error("expected a fetched mirror");
		const tipBefore = runGit(created.mirrorDir, ["rev-parse", "HEAD"]);

		renameSync(w.origin, `${w.origin}.away`);
		const offline = ensureMirror(w.local, w.mirrors, run, { fetch: true });
		expect(offline).toEqual({ status: "stale", mirrorDir: created.mirrorDir, reason: "fetch-failed" });
		expect(runGit(created.mirrorDir, ["rev-parse", "HEAD"])).toBe(tipBefore);

		renameSync(`${w.origin}.away`, w.origin);
		expect(ensureMirror(w.local, w.mirrors, run, { fetch: true }).status).toBe("fetched");
	});

	test("a clone that fails leaves no directory behind that could be mistaken for a mirror", () => {
		const w = world();
		renameSync(w.origin, `${w.origin}.away`);
		const state = ensureMirror(w.local, w.mirrors, run, { fetch: true });
		expect(state).toEqual({ status: "absent", reason: "clone-failed" });
		expect(readdirSync(w.mirrors)).toEqual([]);
	});

	test("a timed-out fetch is reported as such", () => {
		const w = world();
		ensureMirror(w.local, w.mirrors, run, { fetch: true });
		const slow: GitBytesRunner = (call) =>
			call.args[0] === "fetch" ? { code: 124, stdout: new Uint8Array(0), timedOut: true } : run(call);
		const state = ensureMirror(w.local, w.mirrors, slow, { fetch: true });
		expect(state.status === "stale" && state.reason).toBe("fetch-timeout");
	});

	test("a directory that is not a mirror is reported and left alone", () => {
		const w = world();
		const dest = mirrorPath(w.mirrors, w.origin);
		runGit(w.root, ["init", "-q", join(w.mirrors, "x")]);
		renameSync(join(w.mirrors, "x"), dest);
		expect(ensureMirror(w.local, w.mirrors, run, { fetch: true })).toEqual({ status: "absent", reason: "mirror-dir-unusable" });
		expect(existsSync(join(dest, ".git"))).toBe(true);
	});

	test("a fetch into a moved origin's own mirror follows that origin's default branch and leaves the previous mirror", () => {
		const w = world();
		const created = ensureMirror(w.local, w.mirrors, run, { fetch: true });
		if (created.status !== "fetched") throw new Error("expected a fetched mirror");
		const rotated = join(w.root, "rotated.git");
		runGit(w.root, ["clone", "-q", "--bare", w.origin, rotated]);
		runGit(w.local, ["remote", "set-url", "origin", rotated]);
		runGit(w.other, ["remote", "set-url", "origin", rotated]);
		runGit(w.other, ["checkout", "-q", "-b", "docs"]);
		writeTree(w.other, { "docs/moved.md": "moved\n" });
		commitAll(w.other, "docs");
		runGit(w.other, ["push", "-q", "origin", "docs"]);
		runGit(rotated, ["symbolic-ref", "HEAD", "refs/heads/docs"]);
		runGit(rotated, ["update-ref", "-d", "refs/heads/main"]);
		const again = ensureMirror(w.local, w.mirrors, run, { fetch: true });
		expect(again.status).toBe("fetched");
		if (again.status !== "fetched") throw new Error("expected a fetched mirror");
		expect(again.mirrorDir).not.toBe(created.mirrorDir);
		expect(runGit(created.mirrorDir, ["remote", "get-url", "origin"])).toBe(w.origin);
		expect(runGit(again.mirrorDir, ["remote", "get-url", "origin"])).toBe(rotated);
		expect(runGit(again.mirrorDir, ["symbolic-ref", "HEAD"])).toBe("refs/heads/docs");
		expect(runGit(again.mirrorDir, ["rev-parse", "--verify", "HEAD^{commit}"]).length).toBeGreaterThan(0);
	});

	test("a second origin that shares a commit does not receive the first origin's mirror directory", () => {
		const w = world();
		const created = ensureMirror(w.local, w.mirrors, run, { fetch: true });
		if (created.status !== "fetched") throw new Error("expected a fetched mirror");
		const fork = join(w.root, "fork.git");
		const checkout = join(w.root, "fork-checkout");
		runGit(w.root, ["clone", "-q", "--bare", w.origin, fork]);
		runGit(w.root, ["clone", "-q", fork, checkout]);
		const again = ensureMirror(checkout, w.mirrors, run, { fetch: true });
		expect(again.status).toBe("fetched");
		if (again.status !== "fetched") throw new Error("expected a fetched mirror");
		expect(again.mirrorDir).not.toBe(created.mirrorDir);
		expect(runGit(created.mirrorDir, ["remote", "get-url", "origin"])).toBe(w.origin);
	});
});
