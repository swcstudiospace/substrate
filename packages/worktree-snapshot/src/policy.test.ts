/**
 * Pure unit tests: policy resolution, glob matching, path helpers and the manifest format.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { SnapshotPolicyError, UnsupportedPathError } from "./errors.ts";
import { ancestorsOf, blobIdOf, comparePaths, decodePath, isValidId, tempName } from "./paths.ts";
import { DEFAULT_SECRET_PATTERNS, excludedByName, matchesGlob, resolvePolicy } from "./policy.ts";
import { orderOperations } from "./plan.ts";
import { manifestOf } from "./tree.ts";
import type { RestoreOperation } from "./types.ts";

describe("globs and exclusion", () => {
	test("a pattern without a slash matches the basename at any depth; with a slash it anchors at the root", () => {
		expect(matchesGlob(".env", ".env")).toBe(true);
		expect(matchesGlob(".env", "deep/er/.env")).toBe(true);
		expect(matchesGlob(".env.*", "x/.env.local")).toBe(true);
		expect(matchesGlob(".env.*", ".env")).toBe(false);
		expect(matchesGlob("*.pem", "keys/a.pem")).toBe(true);
		expect(matchesGlob("*.pem", "keys/a.pem.txt")).toBe(false);
		expect(matchesGlob("id_rsa*", "ssh/id_rsa.pub")).toBe(true);
		expect(matchesGlob("config/*.json", "config/a.json")).toBe(true);
		expect(matchesGlob("config/*.json", "x/config/a.json")).toBe(false);
		expect(matchesGlob("config/*.json", "config/sub/a.json")).toBe(false);
		expect(matchesGlob("secrets/**", "secrets/a/b")).toBe(true);
		expect(matchesGlob("**/vault.txt", "vault.txt")).toBe(true);
		expect(matchesGlob("a?c", "abc")).toBe(true);
		expect(matchesGlob("a?c", "a/c")).toBe(false);
		// Regex metacharacters are literal.
		expect(matchesGlob("a+b(1).txt", "a+b(1).txt")).toBe(true);
		expect(matchesGlob("a.b", "axb")).toBe(false);
	});

	test("every default secret pattern excludes a representative file", () => {
		const policy = resolvePolicy();
		const samples = [".env", ".env.production", "k/server.pem", "k/a.key", "id_rsa", "id_ed25519.pub", "c.p12", "credentials.json", "credentials-prod.json", "a.keystore"];
		expect(DEFAULT_SECRET_PATTERNS.length).toBe(9);
		for (const sample of samples) expect(excludedByName(sample, policy)).toBe("secret-pattern");
		expect(excludedByName("src/index.ts", policy)).toBeNull();
	});

	test("always-excluded directories and logs are excluded silently; a file with a directory's name is not", () => {
		const policy = resolvePolicy();
		for (const path of ["node_modules/a.js", "x/node_modules/a.js", ".git/config", "a/.venv/bin/x", "target/debug/x", "dist/a.js", "build/a.js", "run.log", "a/b/c.log"]) {
			expect(excludedByName(path, policy)).toBe("excluded");
		}
		expect(excludedByName("docs/build", policy)).toBeNull();
		expect(excludedByName("vendor/lib/", policy, true)).toBeNull();
		expect(excludedByName("node_modules/", policy, true)).toBe("excluded");
	});

	test("resolvePolicy keeps the defaults and validates input", () => {
		const policy = resolvePolicy({ extraSecretPatterns: ["vault.txt"], extraExcludeDirs: ["cache"], extraExcludeGlobs: ["*.tmp"] });
		expect(policy.maxFileBytes).toBe(50 * 1024 * 1024);
		expect(policy.secretPatterns).toContain(".env");
		expect(policy.secretPatterns).toContain("vault.txt");
		expect(policy.excludeDirs).toContain("node_modules");
		expect(policy.excludeDirs).toContain("cache");
		expect(policy.excludeGlobs).toEqual(["*.log", "*.tmp"]);
		expect(policy.ignoredAllowlist).toEqual([".planning/"]);
		expect(resolvePolicy({ ignoredAllowlist: [] }).ignoredAllowlist).toEqual([]);
		for (const bad of [
			{ maxFileBytes: 0 },
			{ maxFileBytes: 1.5 },
			{ maxFileBytes: Number.NaN },
			{ extraSecretPatterns: ["/abs"] },
			{ extraExcludeDirs: ["a/b"] },
			{ ignoredAllowlist: [".git/x"] },
			{ ignoredAllowlist: ["a/../b"] },
			{ ignoredAllowlist: [":(top)x"] },
			{ ignoredAllowlist: ["/abs"] },
		]) {
			expect(() => resolvePolicy(bad)).toThrow(SnapshotPolicyError);
		}
	});
});

describe("paths", () => {
	test("ids", () => {
		for (const id of ["ckpt-0001", "a.b_c-d.e1", "A".repeat(64)]) expect(isValidId(id)).toBe(true);
		for (const id of ["short", "A".repeat(65), "has space", ".lead-dot1", "trail-dot1.", "x..y-abcdef", "n.lock.lock", "slash/slash1", ""]) {
			expect(isValidId(id)).toBe(false);
		}
	});

	test("decodePath refuses non-UTF-8 names and line breaks", () => {
		expect(decodePath(Buffer.from("héllo/wörld.txt"))).toBe("héllo/wörld.txt");
		expect(() => decodePath(Buffer.from([0x61, 0xff, 0x62]))).toThrow(UnsupportedPathError);
		expect(() => decodePath(Buffer.from("a\nb"))).toThrow(UnsupportedPathError);
		expect(() => decodePath(Buffer.from("a\rb"))).toThrow(UnsupportedPathError);
	});

	test("paths sort by UTF-8 bytes, not UTF-16 units", () => {
		// U+FF5E sorts above U+1F600 in UTF-16 (0xFF5E > 0xD83D) but below it in UTF-8 bytes.
		const fullwidth = "\uff5e";
		const emoji = "\u{1f600}";
		expect(comparePaths(fullwidth, emoji)).toBeLessThan(0);
		expect(fullwidth > emoji).toBe(true);
		expect(["b", "a/z", "a", "a.b"].sort(comparePaths)).toEqual(["a", "a.b", "a/z", "b"]);
	});

	test("ancestorsOf", () => {
		expect(ancestorsOf("a")).toEqual([]);
		expect(ancestorsOf("a/b/c.txt")).toEqual(["a", "a/b"]);
	});

	test("blobIdOf agrees with git's blob hash", () => {
		const content = Buffer.from("hello\n");
		expect(blobIdOf(content, "sha1")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
		expect(blobIdOf(Buffer.alloc(0), "sha1")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
	});

	test("tempName stays in the destination directory and within the filename limit", () => {
		expect(tempName("/w/a/file.txt", "restore-0001")).toBe("/w/a/file.txt.substrate-restore-0001.tmp");
		const long = `/w/${"x".repeat(250)}`;
		const name = tempName(long, "restore-0001");
		expect(name.startsWith("/w/.substrate-restore-0001-")).toBe(true);
		expect(name.slice(3).length).toBeLessThanOrEqual(255);
	});
});

describe("manifest", () => {
	test("the empty manifest is the sha256 of the empty string", () => {
		expect(manifestOf([])).toBe(createHash("sha256").update("").digest("hex"));
	});

	test("is independent of entry order and changes with mode, sha or path", () => {
		const a = { path: "a.txt", mode: "100644", type: "blob", sha: "1".repeat(40) } as const;
		const b = { path: "b/c.txt", mode: "100755", type: "blob", sha: "2".repeat(40) } as const;
		expect(manifestOf([a, b])).toBe(manifestOf([b, a]));
		expect(manifestOf([a, b])).not.toBe(manifestOf([a, { ...b, mode: "100644" }]));
		expect(manifestOf([a, b])).not.toBe(manifestOf([a, { ...b, sha: "3".repeat(40) }]));
		expect(manifestOf([a, b])).not.toBe(manifestOf([a, { ...b, path: "b/d.txt" }]));
		const expected = createHash("sha256")
			.update(`100644 blob ${"1".repeat(40)} a.txt\n100755 blob ${"2".repeat(40)} b/c.txt\n`)
			.digest("hex");
		expect(manifestOf([b, a])).toBe(expected);
	});
});

describe("orderOperations", () => {
	const sha = "a".repeat(40);
	const add = (path: string): RestoreOperation => ({ op: "add", path, mode: "100644", sha });
	const del = (path: string): RestoreOperation => ({ op: "delete", path, previousMode: "100644" });

	test("puts deletes that make room first, writes next, other deletes last, each group by path", () => {
		const ordered = orderOperations([del("z.txt"), add("m/new.txt"), del("m"), add("a"), del("a/x"), del("a/y"), del("keep/old")]);
		expect(ordered.map((operation) => `${operation.op} ${operation.path}`)).toEqual([
			"delete a/x",
			"delete a/y",
			"delete m",
			"add a",
			"add m/new.txt",
			"delete keep/old",
			"delete z.txt",
		]);
	});
});
