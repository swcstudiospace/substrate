/**
 * A snapshot captures, and a restore reproduces, the EXACT bytes of every file whatever the
 * repository's attributes and config say about line endings and filters. Before the fix the temporary
 * index was built with `git add`, which applied `text=auto`, `eol`, `core.autocrlf` and clean filters:
 * the stored blob was the converted one, restore wrote it back verbatim, and the verification re-hash
 * converted the same way, so the original bytes were lost and every check still passed.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blobIdOf } from "./paths.ts";
import { restore } from "./restore.ts";
import { snapshot } from "./snapshot.ts";
import { manifestOf } from "./tree.ts";
import { cleanupTemp, FIXED_NOW, git, makeRepo } from "./testkit.ts";

afterAll(cleanupTemp);
setDefaultTimeout(60_000);

const opts = { now: FIXED_NOW };

/** Every regular file of the fixture, as exact bytes. */
const FILES: Record<string, Buffer> = {
	"crlf.txt": Buffer.from("one\r\ntwo\r\nthree\r\n"),
	"lf.txt": Buffer.from("one\ntwo\nthree\n"),
	"mixed.txt": Buffer.from("one\r\ntwo\nthree\rfour\r\n"),
	"no-newline.txt": Buffer.from("last line without a newline\r"),
	"lowercase.txt": Buffer.from("lower case text\r\n"),
	"empty.txt": Buffer.alloc(0),
	"blob.dat": Buffer.from([0x00, 0x0d, 0x0a, 0xff, 0xfe, 0x0a, 0x0d, 0x00, 0x80]),
	"sub/nested.txt": Buffer.from("nested\r\nfile\r\n"),
};

type Variant = { name: string; attributes: string; config: Record<string, string> };

const VARIANTS: Variant[] = [
	{ name: "* text=auto eol=lf", attributes: "* text=auto eol=lf\n", config: {} },
	{ name: "* text eol=crlf", attributes: "* text eol=crlf\n", config: {} },
	{
		name: "core.autocrlf=true and core.safecrlf=true with text=auto",
		attributes: "* text=auto\n",
		config: { "core.autocrlf": "true", "core.safecrlf": "true" },
	},
	{ name: "* text", attributes: "* text\n", config: {} },
	{
		name: "a clean/smudge filter",
		attributes: "*.txt filter=shout\n",
		config: { "filter.shout.clean": "tr a-z A-Z", "filter.shout.smudge": "cat" },
	},
];

function writeFixture(dir: string): void {
	for (const [path, bytes] of Object.entries(FILES)) {
		const absolute = join(dir, path);
		mkdirSync(join(absolute, ".."), { recursive: true });
		writeFileSync(absolute, bytes);
		chmodSync(absolute, 0o644);
	}
	writeFileSync(join(dir, "run.sh"), Buffer.from("#!/bin/sh\r\necho hi\r\n"));
	chmodSync(join(dir, "run.sh"), 0o755);
	symlinkSync("crlf.txt", join(dir, "link"));
}

function rawBlob(dir: string, sha: string): Buffer {
	return Buffer.from(Bun.spawnSync(["git", "-C", dir, "cat-file", "blob", sha], { stdout: "pipe" }).stdout);
}

describe("raw bytes survive snapshot and restore", () => {
	for (const variant of VARIANTS) {
		test(`byte for byte under ${variant.name}`, async () => {
			const dir = makeRepo();
			for (const [key, value] of Object.entries(variant.config)) git(dir, ["config", key, value]);
			writeFileSync(join(dir, ".gitattributes"), variant.attributes);
			writeFixture(dir);
			const expected: Record<string, Buffer> = { ...FILES, "run.sh": Buffer.from("#!/bin/sh\r\necho hi\r\n") };

			const snap = await snapshot({ worktree: dir, ...opts });

			// The recorded blobs are the raw bytes, and the tree hash is the hash over raw bytes.
			const byPath = new Map(snap.entries.map((entry) => [entry.path, entry]));
			for (const [path, bytes] of Object.entries(expected)) {
				const entry = byPath.get(path);
				expect(entry).toBeDefined();
				expect(entry?.sha).toBe(blobIdOf(bytes, "sha1"));
				expect(rawBlob(dir, entry?.sha ?? "").equals(bytes)).toBe(true);
			}
			expect(byPath.get("link")).toMatchObject({ mode: "120000", sha: blobIdOf(Buffer.from("crlf.txt"), "sha1") });
			expect(byPath.get("run.sh")?.mode).toBe("100755");
			expect(byPath.get("empty.txt")?.sha).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
			expect(snap.manifestSha256).toBe(manifestOf(snap.entries));

			// Mutate every kind of file, then restore.
			for (const path of Object.keys(expected)) writeFileSync(join(dir, path), "changed\n");
			rmSync(join(dir, "link"));
			symlinkSync("elsewhere", join(dir, "link"));
			writeFileSync(join(dir, "extra.txt"), "added after the snapshot\r\n");
			await restore({ worktree: dir, target: snap, id: `raw-bytes-${VARIANTS.indexOf(variant)}`, ...opts });

			for (const [path, bytes] of Object.entries(expected)) {
				expect(readFileSync(join(dir, path)).equals(bytes)).toBe(true);
			}
			expect(lstatSync(join(dir, "link")).isSymbolicLink()).toBe(true);
			expect(readlinkSync(join(dir, "link"))).toBe("crlf.txt");
			expect((lstatSync(join(dir, "run.sh")).mode & 0o100) !== 0).toBe(true);
			expect((lstatSync(join(dir, "crlf.txt")).mode & 0o100) !== 0).toBe(false);

			// The verification hash is over raw bytes too: the state is the snapshot's tree again.
			expect((await snapshot({ worktree: dir, ...opts })).tree).toBe(snap.tree);
		});
	}

	test("a file whose name starts with a double quote and one with spaces are stored raw", async () => {
		const dir = makeRepo();
		writeFileSync(join(dir, ".gitattributes"), "* text eol=lf\n");
		const quoted = Buffer.from("quoted\r\nname\r\n");
		writeFileSync(join(dir, '"q.txt'), quoted);
		writeFileSync(join(dir, "with space.txt"), quoted);
		const snap = await snapshot({ worktree: dir, ...opts });
		const shas = new Map(snap.entries.map((entry) => [entry.path, entry.sha]));
		expect(shas.get('"q.txt')).toBe(blobIdOf(quoted, "sha1"));
		expect(shas.get("with space.txt")).toBe(blobIdOf(quoted, "sha1"));
	});
});
