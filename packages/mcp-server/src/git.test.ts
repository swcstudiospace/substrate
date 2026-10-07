/**
 * The checkout probe, against real repositories.
 *
 * `git` is cheap and present, so these build actual repositories in a temp
 * directory rather than stubbing the spawn: what this code has to get right is
 * how git behaves — a repo with no commits, a sha the checkout has never seen,
 * a path that is not a repo at all — and a stub would only prove that the
 * author's idea of git matches itself.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutKnowsCommit, isReadableCheckout, readGitTip } from "./git.ts";

const made: string[] = [];

function tempRepo(options: { commit?: string } = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "substrate-git-"));
	made.push(dir);
	const run = (args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
	run(["init", "--initial-branch=main"]);
	run(["config", "user.email", "test@example.invalid"]);
	run(["config", "user.name", "Substrate Test"]);
	if (options.commit !== undefined) {
		writeFileSync(join(dir, "README.md"), "hello\n");
		run(["add", "README.md"]);
		run(["commit", "-m", options.commit]);
	}
	return dir;
}

afterAll(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe("isReadableCheckout", () => {
	test("accepts an absolute path to a repository", () => {
		expect(isReadableCheckout(tempRepo({ commit: "init" }))).toBe(true);
	});

	test("refuses a relative path, so nothing in it can become a git option", () => {
		// `git -C -x` would read `-x` as a flag. Requiring an absolute path is what
		// rules that out for a path that arrived in a tool argument.
		expect(isReadableCheckout("packages/mcp-server")).toBe(false);
		expect(isReadableCheckout("--upload-pack=touch /tmp/pwned")).toBe(false);
		expect(isReadableCheckout("-C")).toBe(false);
	});

	test("refuses a directory that is not a repository, and one that is not there", () => {
		expect(isReadableCheckout(tmpdir())).toBe(false);
		expect(isReadableCheckout("/nonexistent-substrate-path-12345")).toBe(false);
		expect(isReadableCheckout("/tmp\0/etc")).toBe(false);
	});
});

describe("readGitTip", () => {
	test("reads HEAD's sha, short sha, subject, time and branch", () => {
		const tip = readGitTip(tempRepo({ commit: "feat: leases" }));

		expect(tip.unavailable).toBeUndefined();
		expect(tip.sha).toMatch(/^[0-9a-f]{40}$/);
		expect(tip.short_sha).toBe(tip.sha?.slice(0, tip.short_sha?.length ?? 7) ?? null);
		expect(tip.subject).toBe("feat: leases");
		expect(tip.branch).toBe("main");
		expect(Number.isNaN(Date.parse(tip.committed_at ?? ""))).toBe(false);
	});

	test("the short sha is a prefix of the full one, which is what the sha comparison relies on", () => {
		const tip = readGitTip(tempRepo({ commit: "init" }));
		expect(tip.sha?.startsWith(tip.short_sha ?? "zzz")).toBe(true);
	});

	test("a repository with no commits is unavailable, not a crash", () => {
		const tip = readGitTip(tempRepo());
		expect(tip.sha).toBeNull();
		expect(tip.unavailable).toContain("no commits");
	});

	test("a path that is not a checkout says so", () => {
		expect(readGitTip("/nonexistent-substrate-path-12345").unavailable).toContain("not a readable git checkout");
		expect(readGitTip("relative/path").unavailable).toContain("not a readable git checkout");
	});
});

describe("checkoutKnowsCommit", () => {
	test("true for a commit the checkout holds, by full sha and by short", () => {
		const dir = tempRepo({ commit: "init" });
		const tip = readGitTip(dir);

		expect(checkoutKnowsCommit(dir, tip.sha ?? "")).toBe(true);
		expect(checkoutKnowsCommit(dir, tip.short_sha ?? "")).toBe(true);
	});

	test("false for a commit it has never seen", () => {
		// The drift case: the ledger names a commit another host made and this
		// checkout has not fetched.
		expect(checkoutKnowsCommit(tempRepo({ commit: "init" }), "0".repeat(40))).toBe(false);
		expect(checkoutKnowsCommit(tempRepo({ commit: "init" }), "deadbee")).toBe(false);
	});

	test("null when the question cannot be asked — which a scan reports differently from no", () => {
		expect(checkoutKnowsCommit("/nonexistent-substrate-path-12345", "0".repeat(40))).toBeNull();
		expect(checkoutKnowsCommit(tempRepo({ commit: "init" }), "not-a-sha")).toBeNull();
		expect(checkoutKnowsCommit(tempRepo({ commit: "init" }), "abc")).toBeNull();
	});

	test("a ref name is not accepted in place of a sha", () => {
		// `cat-file -e HEAD` would answer true for any repo, which would silently
		// turn "does this checkout have the ledger's commit" into "is this a repo".
		const dir = tempRepo({ commit: "init" });
		expect(checkoutKnowsCommit(dir, "HEAD")).toBeNull();
		expect(checkoutKnowsCommit(dir, "main")).toBeNull();
	});
});
