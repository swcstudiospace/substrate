/**
 * The hook's memory of consumed steering hints: bounded, atomic, and never a reason for the hook to fail.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanupTemp, tempDir } from "../../../worktree-snapshot/src/testkit.ts";
import { CONSUMED_MAX, consumedPath, readConsumed, writeConsumed } from "./steering-consumed.ts";

afterAll(cleanupTemp);

describe("consumedPath", () => {
	test("sits beside the pending journal, never inside it, and differs per session", () => {
		const pending = join(tempDir(), "substrate-pending");
		const a = consumedPath(pending, "sess-a");
		expect(dirname(dirname(a))).toBe(dirname(pending));
		expect(a.startsWith(`${pending}/`)).toBe(false);
		expect(consumedPath(pending, "sess-b")).not.toBe(a);
		expect(consumedPath(pending, "sess-a")).toBe(a);
	});

	test("a session id with path separators cannot leave the directory", () => {
		const pending = join(tempDir(), "substrate-pending");
		const path = consumedPath(pending, "../../etc/passwd");
		expect(dirname(dirname(path))).toBe(dirname(pending));
	});
});

describe("read and write", () => {
	test("a written list reads back in order, and no temporary file is left", () => {
		const path = consumedPath(join(tempDir(), "substrate-pending"), "s");
		writeConsumed(path, "s", ["d1", "d2"]);
		expect(readConsumed(path)).toEqual(["d1", "d2"]);
		expect(readdirSync(dirname(path)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		writeConsumed(path, "s", ["d1", "d2", "d3"]);
		expect(readConsumed(path)).toEqual(["d1", "d2", "d3"]);
	});

	test("only the newest CONSUMED_MAX ids are kept", () => {
		const path = consumedPath(join(tempDir(), "substrate-pending"), "s");
		const ids = Array.from({ length: CONSUMED_MAX + 25 }, (_, index) => `d${index}`);
		writeConsumed(path, "s", ids);
		const back = readConsumed(path);
		expect(back).toHaveLength(CONSUMED_MAX);
		expect(back[0]).toBe("d25");
		expect(back[CONSUMED_MAX - 1]).toBe(`d${CONSUMED_MAX + 24}`);
	});

	test("an absent file is an empty list and creates nothing", () => {
		const path = consumedPath(join(tempDir(), "substrate-pending"), "s");
		expect(readConsumed(path)).toEqual([]);
		expect(existsSync(dirname(path))).toBe(false);
	});

	const unreadable: Array<[string, string]> = [
		["text that is not JSON", "{oops"],
		["a JSON array", "[]"],
		["an object without the list", JSON.stringify({ version: 1 })],
		["a list that is not an array", JSON.stringify({ directive_ids: "d1" })],
		["a file over the size bound", JSON.stringify({ directive_ids: ["x".repeat(70_000)] })],
	];
	for (const [name, content] of unreadable) {
		test(`${name} is an empty list, not an error`, () => {
			const path = consumedPath(join(tempDir(), "substrate-pending"), "s");
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);
			expect(readConsumed(path)).toEqual([]);
		});
	}

	test("entries that are not non-empty strings are dropped, the rest kept", () => {
		const path = consumedPath(join(tempDir(), "substrate-pending"), "s");
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ directive_ids: ["d1", 7, "", null, "d2"] }));
		expect(readConsumed(path)).toEqual(["d1", "d2"]);
	});
});
