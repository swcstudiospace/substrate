import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { defined, linkFile, tempDir, writeTree } from "../test-support.ts";
import { scanGreptileExport } from "./greptile-export.ts";

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

describe("scanGreptileExport", () => {
	test("reads <owner>/<repo>/<path>.md files as tier-2 greptile-kb entries and ignores everything else", async () => {
		const root = fixture({
			"Acme/Alpha/architecture.md": "# architecture\n",
			"Acme/Alpha/modules/store.md": "# store\n",
			"Acme/Alpha/notes.txt": "not markdown",
			"Acme/Beta/index.md": "# beta\n",
			"loose.md": "outside the layout",
			"Acme/stray.md": "outside the layout",
		});
		const result = await scanGreptileExport(root);
		expect(result.entries).toEqual([
			{
				repo: "Acme/Alpha",
				path: "architecture.md",
				kind: "greptile-kb",
				tier: 2,
				sha256: createHash("sha256").update("# architecture\n").digest("hex"),
				bytes: 15,
				source: "greptile",
			},
			expect.objectContaining({ repo: "Acme/Alpha", path: "modules/store.md" }),
			expect.objectContaining({ repo: "Acme/Beta", path: "index.md", kind: "greptile-kb" }),
		]);
		expect(result.entries.every((entry) => entry.commit === undefined)).toBe(true);
		expect(result.repos.map((r) => ({ repo: r.repo, files: r.files, complete: r.complete, source: r.source }))).toEqual([
			{ repo: "Acme/Alpha", files: 2, complete: true, source: "greptile" },
			{ repo: "Acme/Beta", files: 1, complete: true, source: "greptile" },
		]);
		const location = defined(result.paths.get("Acme/Alpha:modules/store.md"), "path");
		expect(readFileSync(location, "utf8")).toBe("# store\n");
	});

	test("sets supersededBy from a front-matter marker and leaves an invalid one out", async () => {
		const root = fixture({
			"Acme/Alpha/old.md": "---\nsuperseded-by: new.md\n---\n# old\n",
			"Acme/Alpha/new.md": "# new\n",
			"Acme/Alpha/bad.md": "---\nsuperseded-by: ../up.md\n---\n# bad\n",
		});
		const result = await scanGreptileExport(root);
		expect(Object.fromEntries(result.entries.map((entry) => [entry.path, entry.supersededBy]))).toEqual({
			"old.md": "new.md",
			"new.md": undefined,
			"bad.md": undefined,
		});
		expect(result.skipped).toEqual([]);
	});

	test("applies the size, symlink, empty, binary and UTF-8 rules", async () => {
		const root = fixture({
			"o/r/ok.md": "fine\n",
			"o/r/empty.md": "",
			"o/r/binary.md": Uint8Array.of(65, 0, 66),
			"o/r/latin1.md": Uint8Array.of(0xe9),
			"o/r/big.md": "x".repeat(500),
			"o/r/target.md": "target\n",
		});
		linkFile(join(root, "o", "r"), "alias.md", join(root, "o", "r", "target.md"));
		const result = await scanGreptileExport(root, { maxBytes: 100 });
		expect(result.entries.map((e) => e.path)).toEqual(["ok.md", "target.md"]);
		expect(Object.fromEntries(result.skipped.map((s) => [s.path, s.reason]))).toEqual({
			"empty.md": "empty",
			"binary.md": "binary",
			"latin1.md": "invalid-utf8",
			"big.md": "too-large",
			"alias.md": "symlink",
		});
		expect(defined(result.repos[0], "repo").complete).toBe(true);
	});

	test("maxRepos reads the first repositories in name order and says how many were left", async () => {
		const root = fixture({ "a/one/x.md": "1", "a/two/x.md": "2", "b/three/x.md": "3" });
		const result = await scanGreptileExport(root, { maxRepos: 2 });
		expect(result.repos.map((r) => r.repo)).toEqual(["a/one", "a/two"]);
		expect(result.notes.some((note) => note.startsWith("1 greptile"))).toBe(true);
		expect((await scanGreptileExport(root, { maxRepos: 0 })).entries).toEqual([]);
	});

	test("a tier bound below 2 reads nothing, since every document is tier 2", async () => {
		const root = fixture({ "a/one/x.md": "1" });
		const result = await scanGreptileExport(root, { maxTier: 1 });
		expect(result.entries).toEqual([]);
		expect(result.repos).toEqual([]);
		expect(result.notes.length).toBeGreaterThan(0);
		expect((await scanGreptileExport(root, { maxTier: 2 })).entries).toHaveLength(1);
	});

	test("an unreadable file marks only its repository incomplete, and a missing directory is a note", async () => {
		const root = fixture({ "a/bad/x.md": "x", "a/good/x.md": "y" });
		const result = await scanGreptileExport(root, {
			readFile: (path) => {
				if (path.includes(`${join("a", "bad")}`)) throw new Error("EIO");
				return readFileSync(path);
			},
		});
		const byRepo = new Map(result.repos.map((r) => [r.repo, r]));
		expect(byRepo.get("a/bad")).toMatchObject({ complete: false, files: 0 });
		expect(byRepo.get("a/good")).toMatchObject({ complete: true, files: 1 });
		const missing = await scanGreptileExport(join(root, "nope"));
		expect(missing.entries).toEqual([]);
		expect(missing.notes.length).toBe(1);
	});

	test("two reads of the same export are identical", async () => {
		const root = fixture({ "a/one/x.md": "1", "a/one/sub/y.md": "2", "b/two/z.md": "3" });
		const first = await scanGreptileExport(root);
		const second = await scanGreptileExport(root);
		expect(JSON.stringify(second.entries)).toBe(JSON.stringify(first.entries));
		expect(JSON.stringify(second.repos)).toBe(JSON.stringify(first.repos));
	});
});
