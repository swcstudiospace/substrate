import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { measureTree } from "./size.ts";
import { cleanupTemp, tempDir } from "./testkit.ts";

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
