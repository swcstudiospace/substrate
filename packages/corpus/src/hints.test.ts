import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type HintClock, MAX_HINT_BYTES, MAX_HINT_DIR_BYTES, MAX_HINT_FILES, readHints, writeHint } from "./hints.ts";
import { defined, tempDir } from "./test-support.ts";

const roots: string[] = [];
afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function spool(): string {
	const root = tempDir("corpus-spool-");
	roots.push(root);
	return join(root, "hints");
}

function clock(start = 1_700_000_000_000): HintClock {
	let now = start;
	let counter = 0;
	return {
		nowMs: () => now++,
		random: () => (counter++).toString(16).padStart(8, "0"),
	};
}

describe("the hint spool", () => {
	test("a written hint is read once, the file is removed, and a repeated directory is reported once", () => {
		const dir = spool();
		const time = clock();
		expect(writeHint(dir, "/work/alpha", time).ok).toBe(true);
		expect(writeHint(dir, "/work/beta", time).ok).toBe(true);
		expect(writeHint(dir, "/work/alpha", time).ok).toBe(true);
		expect(readdirSync(dir)).toHaveLength(3);

		const batch = readHints(dir);

		expect(batch).toEqual({ dirs: ["/work/alpha", "/work/beta"], consumed: 3, dropped: 0 });
		expect(readdirSync(dir)).toEqual([]);
		expect(readHints(dir)).toEqual({ dirs: [], consumed: 0, dropped: 0 });
	});

	test("a hint is written atomically: no temporary file is left and a half-written one is never read", () => {
		const dir = spool();
		const written = writeHint(dir, "/work/alpha", clock());
		expect(written.ok).toBe(true);
		expect(readdirSync(dir).every((name) => !name.startsWith("."))).toBe(true);
		// A leftover temporary file of a crashed writer is not a hint.
		writeFileSync(join(dir, ".1700000000000-deadbeef.json.tmp"), '{"v":1,"dir":"/half');
		expect(readHints(dir).dirs).toEqual(["/work/alpha"]);
	});

	test("refuses a directory that does not fit a hint, without throwing", () => {
		const dir = spool();
		expect(writeHint(dir, "", clock())).toEqual({ ok: false, reason: "bad-directory" });
		expect(writeHint(dir, "/a\0b", clock())).toEqual({ ok: false, reason: "bad-directory" });
		expect(writeHint(dir, `/${"x".repeat(MAX_HINT_DIR_BYTES)}`, clock())).toEqual({ ok: false, reason: "bad-directory" });
		expect(MAX_HINT_DIR_BYTES + 64).toBeLessThanOrEqual(MAX_HINT_BYTES);
		expect(existsSync(dir)).toBe(false);
	});

	test("stops at the file bound and says so", () => {
		const dir = spool();
		const time = clock();
		for (let i = 0; i < MAX_HINT_FILES; i++) expect(writeHint(dir, `/work/r${i}`, time).ok).toBe(true);
		expect(writeHint(dir, "/work/one-too-many", time)).toEqual({ ok: false, reason: "spool-full" });
		expect(readdirSync(dir)).toHaveLength(MAX_HINT_FILES);
		// Reading frees the room again.
		expect(readHints(dir).consumed).toBe(MAX_HINT_FILES);
		expect(writeHint(dir, "/work/after", time).ok).toBe(true);
	});

	test("an unwritable spool is a closed reason, not an exception", () => {
		const dir = spool();
		const blocked = join(dir, "blocked");
		writeHint(dir, "/work/seed", clock());
		writeFileSync(blocked, "a file where the spool directory should be");
		expect(writeHint(blocked, "/work/alpha", clock())).toEqual({ ok: false, reason: "spool-unwritable" });
	});

	test("malformed and oversized hint files are removed and counted, foreign files are left alone", () => {
		const dir = spool();
		writeHint(dir, "/work/good", clock());
		const base = 1_700_000_000_500;
		writeFileSync(join(dir, `${base}-aaaaaaaa.json`), "not json");
		writeFileSync(join(dir, `${base + 1}-bbbbbbbb.json`), JSON.stringify({ v: 2, dir: "/work/future" }));
		writeFileSync(join(dir, `${base + 2}-cccccccc.json`), JSON.stringify({ v: 1, dir: 7 }));
		writeFileSync(join(dir, `${base + 3}-dddddddd.json`), JSON.stringify({ v: 1, dir: `/${"y".repeat(MAX_HINT_BYTES)}` }));
		writeFileSync(join(dir, "notes.txt"), "mine");

		const batch = readHints(dir);

		expect(batch.dirs).toEqual(["/work/good"]);
		expect(batch).toMatchObject({ consumed: 5, dropped: 4 });
		expect(readdirSync(dir)).toEqual(["notes.txt"]);
	});

	test("hints come back oldest first", () => {
		const dir = spool();
		const time = clock();
		for (const name of ["/work/c", "/work/a", "/work/b"]) writeHint(dir, name, time);
		expect(defined(readHints(dir).dirs, "dirs")).toEqual(["/work/c", "/work/a", "/work/b"]);
	});

	test("two processes cannot both pass the cap", () => {
		const dir = spool();
		const time = clock();
		for (let i = 0; i < MAX_HINT_FILES - 1; i++) expect(writeHint(dir, `/work/r${i}`, time).ok).toBe(true);
		const script = `import { writeHint } from ${JSON.stringify(join(import.meta.dir, "hints.ts"))};\nimport { randomBytes } from "node:crypto";\nconst result = writeHint(process.argv[2], process.argv[3], { nowMs: () => Date.now(), random: () => randomBytes(4).toString("hex") });\nprocess.stdout.write(JSON.stringify(result));\n`;
		const launch = (name: string) => Bun.spawn(["bun", "--no-env-file", "-e", script, dir, name], { stdout: "pipe", stderr: "pipe" });
		const left = launch("/work/left");
		const right = launch("/work/right");
		const done = Promise.all([left.exited, right.exited]);
		return done.then(async () => {
			const texts = [await new Response(left.stdout).text(), await new Response(right.stdout).text()];
			const results = texts.map((text) => JSON.parse(text) as { ok: boolean; reason?: string });
			expect(results.filter((result) => result.ok)).toHaveLength(1);
			expect(results.filter((result) => result.reason === "spool-full")).toHaveLength(1);
			expect(readdirSync(dir).filter((name) => name.endsWith(".json"))).toHaveLength(MAX_HINT_FILES);
		});
	});
});
