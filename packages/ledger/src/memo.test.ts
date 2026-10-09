import { describe, expect, test } from "bun:test";
import { formatMemo, MEMO_PROGRAM_IDS, parseMemo, stripListingPrefix } from "./memo.ts";

const H10 = Date.UTC(2026, 8, 26, 10);
const ROOT = "ab".repeat(32);
const MEMO = `substrate:v1:2026-09-26T10:00:00.000Z:${ROOT}:79`;

describe("formatMemo", () => {
	test("formats the v1 memo (105 characters)", () => {
		const memo = formatMemo({ periodStartMs: H10, rootHex: ROOT, count: 79 });
		expect(memo).toBe(MEMO);
		expect(memo.length).toBe(105);
	});

	test("rejects a period that is not a whole UTC hour", () => {
		expect(() => formatMemo({ periodStartMs: H10 + 1, rootHex: ROOT, count: 1 })).toThrow();
		expect(() => formatMemo({ periodStartMs: H10 + 60_000, rootHex: ROOT, count: 1 })).toThrow();
	});

	test("rejects a root that is not 64 lowercase hex characters", () => {
		expect(() => formatMemo({ periodStartMs: H10, rootHex: "AB".repeat(32), count: 1 })).toThrow();
		expect(() => formatMemo({ periodStartMs: H10, rootHex: "ab".repeat(31), count: 1 })).toThrow();
	});

	test("rejects a count that is 0, negative or not an integer", () => {
		for (const count of [0, -1, 1.5, Number.NaN]) {
			expect(() => formatMemo({ periodStartMs: H10, rootHex: ROOT, count })).toThrow();
		}
	});
});

describe("parseMemo", () => {
	test("round-trips formatMemo", () => {
		const memo = { periodStartMs: H10, rootHex: ROOT, count: 79 };
		expect(parseMemo(formatMemo(memo))).toEqual(memo);
	});

	test("returns null for anything but an exact v1 memo", () => {
		for (const bad of [
			MEMO.replace(ROOT, "AB".repeat(32)),
			MEMO.replace("T10:00:00", "T10:01:00"),
			MEMO.replace(/:79$/, ":0"),
			MEMO.replace(/:79$/, ":079"),
			`${MEMO} trailing`,
			MEMO.replace("substrate:v1:", "substrate:v2:"),
			MEMO.replace(/:79$/, ":79:1"),
			"",
		]) {
			expect(parseMemo(bad)).toBeNull();
		}
	});
});

describe("memo program ids and listing prefix", () => {
	test("MEMO_PROGRAM_IDS is exactly v4, v3 and v1", () => {
		expect([...MEMO_PROGRAM_IDS].sort()).toEqual(
			[
				"Memo4c2pN8afCj432Lb7RMVKi9PbQnnW7ewFFaV3oAH",
				"MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
				"Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
			].sort(),
		);
	});

	test("stripListingPrefix drops `[len] `, keeps unprefixed text and null", () => {
		expect(stripListingPrefix(`[105] ${MEMO}`)).toBe(MEMO);
		expect(stripListingPrefix(MEMO)).toBe(MEMO);
		expect(stripListingPrefix(null)).toBeNull();
	});
});
