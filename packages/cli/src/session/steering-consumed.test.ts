/**
 * The hook's memory of consumed steering hints: bounded, atomic, and never a reason for the hook to fail.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanupTemp, tempDir } from "../../../worktree-snapshot/src/testkit.ts";
import { CONSUMED_HARD_MAX, CONSUMED_STATE_MAX_BYTES, consumedPath, readConsumed, retainListed, writeConsumed } from "./steering-consumed.ts";

afterAll(cleanupTemp);

describe("consumedPath", () => {
	test("sits beside the pending journal, never inside it, and differs per session", () => {
		const pending = join(tempDir(), "substrate-pending");
		const a = consumedPath(pending, "sess-a", "live-a");
		expect(dirname(dirname(a))).toBe(dirname(pending));
		expect(a.startsWith(`${pending}/`)).toBe(false);
		expect(consumedPath(pending, "sess-b", "live-a")).not.toBe(a);
		expect(consumedPath(pending, "sess-a", "live-b")).not.toBe(a);
		expect(consumedPath(pending, "sess-a", "live-a")).toBe(a);
		expect(consumedPath(pending, "sess", "a:live")).not.toBe(consumedPath(pending, "sess:a", "live"));
	});

	test("a session id with path separators cannot leave the directory", () => {
		const pending = join(tempDir(), "substrate-pending");
		const path = consumedPath(pending, "../../etc/passwd", "../../live");
		expect(dirname(dirname(path))).toBe(dirname(pending));
	});
});

describe("read and write", () => {
	test("live incarnations cannot consume or prune each other's historical decisions and contain no credential field", () => {
		const pending = join(tempDir(), "substrate-pending");
		const first = consumedPath(pending, "history", "live-a");
		const second = consumedPath(pending, "history", "live-b");
		writeConsumed(first, "history", "live-a", ["old"]);
		writeConsumed(second, "history", "live-b", ["new"]);
		writeConsumed(second, "history", "live-b", retainListed(readConsumed(second), new Set()));
		expect(readConsumed(first)).toEqual(["old"]);
		expect(readConsumed(second)).toEqual([]);
		expect(JSON.parse(readFileSync(first, "utf8"))).toEqual({
			version: 2, session_id: "history", steering_session_id: "live-a", directive_ids: ["old"],
		});
	});

	test("a written list reads back in order, and no temporary file is left", () => {
		const path = consumedPath(join(tempDir(), "substrate-pending"), "s", "live");
		writeConsumed(path, "s", "live", ["d1", "d2"]);
		expect(readConsumed(path)).toEqual(["d1", "d2"]);
		expect(readdirSync(dirname(path)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		writeConsumed(path, "s", "live", ["d1", "d2", "d3"]);
		expect(readConsumed(path)).toEqual(["d1", "d2", "d3"]);
	});

	test("only the newest CONSUMED_HARD_MAX ids are kept", () => {
		const path = consumedPath(join(tempDir(), "substrate-pending"), "s", "live");
		const ids = Array.from({ length: CONSUMED_HARD_MAX + 25 }, (_, index) => `d${index}`);
		writeConsumed(path, "s", "live", ids);
		const back = readConsumed(path);
		expect(back).toHaveLength(CONSUMED_HARD_MAX);
		expect(back[0]).toBe("d25");
		expect(back[CONSUMED_HARD_MAX - 1]).toBe(`d${CONSUMED_HARD_MAX + 24}`);
	});

	test("a full list of the longest ids the server accepts still reads back (the size bound is not smaller than what is written)", () => {
		const path = consumedPath(join(tempDir(), "substrate-pending"), "s", "live");
		const ids = Array.from({ length: CONSUMED_HARD_MAX }, (_, index) => `${String(index).padStart(6, "0")}${"x".repeat(122)}`);
		writeConsumed(path, "s", "live", ids);
		expect(readConsumed(path)).toEqual(ids);
	});

	test("an absent file is an empty list and creates nothing", () => {
		const path = consumedPath(join(tempDir(), "substrate-pending"), "s", "live");
		expect(readConsumed(path)).toEqual([]);
		expect(existsSync(dirname(path))).toBe(false);
	});

	const unreadable: Array<[string, string]> = [
		["text that is not JSON", "{oops"],
		["a JSON array", "[]"],
		["an object without the list", JSON.stringify({ version: 1 })],
		["a list that is not an array", JSON.stringify({ directive_ids: "d1" })],
		["a file over the size bound", JSON.stringify({ directive_ids: ["x".repeat(CONSUMED_STATE_MAX_BYTES)] })],
	];
	for (const [name, content] of unreadable) {
		test(`${name} is an empty list, not an error`, () => {
			const path = consumedPath(join(tempDir(), "substrate-pending"), "s", "live");
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);
			expect(readConsumed(path)).toEqual([]);
		});
	}

	test("entries that are not non-empty strings are dropped, the rest kept", () => {
		const path = consumedPath(join(tempDir(), "substrate-pending"), "s", "live");
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ directive_ids: ["d1", 7, "", null, "d2"] }));
		expect(readConsumed(path)).toEqual(["d1", "d2"]);
	});
});

describe("retainListed", () => {
	test("more than the old 200-id cap of skipped decisions all stay while the server still lists them", () => {
		const ids = Array.from({ length: 250 }, (_, index) => `d${index}`);
		expect(retainListed(ids, new Set(ids))).toEqual(ids);
	});

	test("a decision for a directive the server no longer lists is dropped, the listed ones keep their order", () => {
		expect(retainListed(["d1", "gone", "d2"], new Set(["d2", "d1", "new"]))).toEqual(["d1", "d2"]);
	});

	test("an empty listing drops everything: callers pass it only when the read was complete", () => {
		expect(retainListed(["d1"], new Set())).toEqual([]);
	});
});
