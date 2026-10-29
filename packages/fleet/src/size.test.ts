import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exclusiveBytes, measureTree } from "./size.ts";
import { cleanupTemp, defined, tempDir } from "./testkit.ts";

afterAll(cleanupTemp);

const MIB = 1024 * 1024;

function bigFile(path: string): void {
	// Random bytes so a filesystem that compresses or dedups still allocates them.
	writeFileSync(path, randomBytes(MIB));
}

describe("measureTree", () => {
	test("a hardlinked file counts once, a copy counts twice", async () => {
		const linked = tempDir();
		bigFile(join(linked, "a.bin"));
		linkSync(join(linked, "a.bin"), join(linked, "b.bin"));
		const copied = tempDir();
		bigFile(join(copied, "a.bin"));
		writeFileSync(join(copied, "b.bin"), randomBytes(MIB));

		const one = await measureTree(linked);
		const two = await measureTree(copied);
		expect(one.bytes).toBeGreaterThanOrEqual(MIB);
		expect(one.bytes).toBeLessThan(1.5 * MIB);
		expect(two.bytes).toBeGreaterThanOrEqual(2 * MIB);
	});

	test("symlinks are measured as links, never followed", async () => {
		const dir = tempDir();
		const outside = tempDir();
		bigFile(join(outside, "huge.bin"));
		symlinkSync(outside, join(dir, "loop"));
		const result = await measureTree(dir);
		expect(result.bytes).toBeLessThan(MIB);
	});

	test("reports the newest modification time", async () => {
		const dir = tempDir();
		mkdirSync(join(dir, "sub"));
		writeFileSync(join(dir, "sub", "old.txt"), "x");
		writeFileSync(join(dir, "new.txt"), "y");
		utimesSync(join(dir, "sub", "old.txt"), 1_000_000, 1_000_000);
		utimesSync(join(dir, "sub"), 1_000_000, 1_000_000);
		utimesSync(join(dir, "new.txt"), 2_000_000, 2_000_000);
		utimesSync(dir, 1_500_000, 1_500_000);
		expect((await measureTree(dir)).lastActivityMs).toBe(2_000_000_000);
	});

	test("an entry cap yields nothing rather than a partial total", async () => {
		const dir = tempDir();
		for (let i = 0; i < 20; i++) writeFileSync(join(dir, `f${i}`), "x");
		const result = await measureTree(dir, { maxEntries: 10 });
		expect(result.bytes).toBeNull();
		expect(result.lastActivityMs).toBeNull();
		expect(result.note).toContain("10 entries");
	});

	test("a time cap yields nothing, using the injected clock", async () => {
		const dir = tempDir();
		for (let i = 0; i < 2100; i++) writeFileSync(join(dir, `f${i}`), "x");
		let tick = 0;
		const result = await measureTree(dir, { maxMs: 50, now: () => (tick += 100) });
		expect(result.bytes).toBeNull();
		expect(result.note).toContain("50 ms");
	});

	test("an unreadable root is unknown, not zero", async () => {
		const result = await measureTree(join(tempDir(), "absent"));
		expect(result.bytes).toBeNull();
	});
});

describe("exclusiveBytes", () => {
	test("an inode that is also linked from outside the removed tree is not freed; a file with one link is", async () => {
		const cache = tempDir();
		const tree = tempDir();
		bigFile(join(cache, "shared.bin"));
		linkSync(join(cache, "shared.bin"), join(tree, "shared.bin"));
		bigFile(join(tree, "own.bin"));
		const walked = await measureTree(tree, { links: true });
		// The tree's size counts both files; removing it frees only the one nothing else links to.
		expect(walked.bytes).toBeGreaterThanOrEqual(2 * MIB);
		const freed = exclusiveBytes([defined(walked.links, "links")]);
		expect(freed).toBeGreaterThanOrEqual(MIB);
		expect(freed).toBeLessThan(1.5 * MIB);
	});

	test("an inode whose every link is inside the trees removed together is freed once, and not when only one tree goes", async () => {
		const first = tempDir();
		const second = tempDir();
		bigFile(join(first, "x.bin"));
		linkSync(join(first, "x.bin"), join(second, "x.bin"));
		const one = defined((await measureTree(first, { links: true })).links, "links");
		const two = defined((await measureTree(second, { links: true })).links, "links");
		const both = exclusiveBytes([one, two]);
		expect(both).toBeGreaterThanOrEqual(MIB);
		expect(both).toBeLessThan(1.5 * MIB);
		expect(exclusiveBytes([one])).toBeLessThan(MIB / 2);
	});

	test("a walk that hit a cap offers no table, and the table is only built when asked for", async () => {
		const dir = tempDir();
		for (let i = 0; i < 20; i++) writeFileSync(join(dir, `f${i}`), "x");
		expect((await measureTree(dir, { maxEntries: 10, links: true })).links).toBeNull();
		expect((await measureTree(dir)).links).toBeNull();
		expect((await measureTree(dir, { links: true })).links).not.toBeNull();
	});
});
