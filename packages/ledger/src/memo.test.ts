import { describe, expect, test } from "bun:test";
import { formatMemo, formatMemoV2, formatMemoV3, MEMO_PROGRAM_IDS, parseMemo, parseMemoV3, stripListingPrefix } from "./memo.ts";

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

describe("memo v2", () => {
	const HEADS = "cd".repeat(32);
	const MEMO_V2 = `substrate:v2:2026-09-26T10:00:00.000Z:${ROOT}:79:${HEADS}`;
	const V2 = { periodStartMs: H10, rootHex: ROOT, count: 79, headsRootHex: HEADS };

	test("formats the v2 memo and round-trips it through parseMemo", () => {
		expect(formatMemoV2(V2)).toBe(MEMO_V2);
		expect(parseMemo(formatMemoV2(V2))).toStrictEqual(V2);
	});

	test("parseMemo returns the v1 shape for a v1 memo, with no headsRootHex key", () => {
		expect(parseMemo(MEMO)).toStrictEqual({ periodStartMs: H10, rootHex: ROOT, count: 79 });
	});

	test("formatMemoV2 rejects a period that is not a whole UTC hour", () => {
		expect(() => formatMemoV2({ ...V2, periodStartMs: H10 + 1 })).toThrow("formatMemoV2:");
	});

	test("formatMemoV2 rejects a 63-character rootHex", () => {
		expect(() => formatMemoV2({ ...V2, rootHex: ROOT.slice(1) })).toThrow("formatMemoV2:");
	});

	test("formatMemoV2 rejects an uppercase headsRootHex", () => {
		expect(() => formatMemoV2({ ...V2, headsRootHex: HEADS.toUpperCase() })).toThrow("formatMemoV2:");
	});

	test("formatMemoV2 rejects a count that is 0 or not an integer", () => {
		for (const count of [0, 1.5]) {
			expect(() => formatMemoV2({ ...V2, count })).toThrow("formatMemoV2:");
		}
	});

	test("parseMemo returns null for anything but an exact v2 memo", () => {
		for (const bad of [
			`substrate:v2:2026-09-26T10:00:00.000Z:${ROOT}:79`,
			MEMO_V2.replace(HEADS, HEADS.toUpperCase()),
			MEMO_V2.replace(":79:", ":0:"),
			MEMO_V2.replace("T10:00:00", "T10:01:00"),
			MEMO_V2.replace("substrate:v2:", "substrate:v3:"),
		]) {
			expect(parseMemo(bad)).toBeNull();
		}
	});
});

describe("memo v3", () => {
	const GRAPH = "graph-a";
	const HEADS3 = "cd".repeat(32);
	const SIG = `${"5".repeat(87)}k`;
	const V3 = { graphId: GRAPH, periodStartMs: H10, count: 79, graphHeadsRootHex: HEADS3, hourTxSig: SIG };
	const MEMO_V3 = `substrate:v3:${GRAPH}:2026-09-26T10:00:00.000Z:79:${HEADS3}:${SIG}`;

	test("formats the five fields in order and round-trips through parseMemoV3", () => {
		expect(formatMemoV3(V3)).toBe(MEMO_V3);
		expect(parseMemoV3(formatMemoV3(V3))).toStrictEqual(V3);
	});

	test("round-trips graph ids with colons, a newline, ISO-shaped text and 512 characters", () => {
		const colons = "ab:".repeat(171).slice(0, 512);
		expect(colons.length).toBe(512);
		for (const graphId of [
			"tenant:team:graph",
			"line one\nline two",
			"2026-09-26T10:00:00.000Z",
			`a:2026-09-26T11:00:00.000Z:5:${HEADS3}:${SIG}`,
			"g".repeat(512),
			colons,
		]) {
			const memo = { ...V3, graphId };
			expect(parseMemoV3(formatMemoV3(memo))).toStrictEqual(memo);
		}
	});

	test("the parser reads the graph id as everything before the last four fields", () => {
		const tricky = `a:2026-09-26T11:00:00.000Z:5:${HEADS3}:${SIG}`;
		expect(parseMemoV3(formatMemoV3({ ...V3, graphId: tricky }))?.graphId).toBe(tricky);
		expect(parseMemoV3(formatMemoV3({ ...V3, graphId: tricky }))?.periodStartMs).toBe(H10);
	});

	test("formatMemoV3 rejects an empty graph id and one longer than 512 characters", () => {
		expect(() => formatMemoV3({ ...V3, graphId: "" })).toThrow("formatMemoV3:");
		expect(() => formatMemoV3({ ...V3, graphId: "g".repeat(513) })).toThrow("formatMemoV3:");
	});

	test("formatMemoV3 rejects a bad period, count, root or signature", () => {
		expect(() => formatMemoV3({ ...V3, periodStartMs: H10 + 1 })).toThrow("formatMemoV3:");
		expect(() => formatMemoV3({ ...V3, count: 0 })).toThrow("formatMemoV3:");
		expect(() => formatMemoV3({ ...V3, graphHeadsRootHex: HEADS3.toUpperCase() })).toThrow("formatMemoV3:");
		expect(() => formatMemoV3({ ...V3, hourTxSig: SIG.slice(0, 63) })).toThrow("formatMemoV3:");
		expect(() => formatMemoV3({ ...V3, hourTxSig: `${SIG}${"5".repeat(3)}` })).toThrow("formatMemoV3:");
	});

	test("parseMemoV3 returns null for anything but an exact v3 memo", () => {
		for (const bad of [
			MEMO_V3.replace("T10:00:00", "T10:01:00"),
			MEMO_V3.replace("2026-09-26T10:00:00.000Z", "2026-02-30T10:00:00.000Z"),
			MEMO_V3.replace(":79:", ":0:"),
			MEMO_V3.replace(":79:", ":079:"),
			MEMO_V3.replace(HEADS3, HEADS3.toUpperCase()),
			MEMO_V3.replace(SIG, SIG.slice(0, 63)),
			MEMO_V3.replace(SIG, `${SIG}${"5".repeat(3)}`),
			MEMO_V3.replace("substrate:v3:", "substrate:v2:"),
			MEMO_V3.replace("substrate:v3:", "substrate:v4:"),
			MEMO_V3.replace(`${GRAPH}:`, ":"),
			`${MEMO_V3} trailing`,
			"",
		]) {
			expect(parseMemoV3(bad)).toBeNull();
		}
	});

	test("parseMemo never reads v3, and parseMemoV3 never reads v1 or v2", () => {
		expect(parseMemo(MEMO_V3)).toBeNull();
		expect(parseMemoV3(MEMO)).toBeNull();
		expect(parseMemoV3(formatMemoV2({ periodStartMs: H10, rootHex: ROOT, count: 79, headsRootHex: HEADS3 }))).toBeNull();
	});

	test("the signature is bounded at 88 characters, as parseSignature bounds it (solana.ts SIGNATURE_RE)", () => {
		const sig88 = "5".repeat(88);
		const sig89 = "5".repeat(89);
		expect(parseMemoV3(MEMO_V3.replace(SIG, sig89))).toBeNull();
		expect(parseMemoV3(MEMO_V3.replace(SIG, sig88))?.hourTxSig).toBe(sig88);
		expect(() => formatMemoV3({ ...V3, hourTxSig: sig89 })).toThrow("formatMemoV3:");
		expect(formatMemoV3({ ...V3, hourTxSig: sig88 })).toBe(MEMO_V3.replace(SIG, sig88));
	});

	test("parseMemoV3 refuses a graph id longer than 512 characters and reads one of exactly 512", () => {
		const id512 = "g".repeat(512);
		const id513 = "g".repeat(513);
		expect(parseMemoV3(`substrate:v3:${id513}:2026-09-26T10:00:00.000Z:79:${HEADS3}:${SIG}`)).toBeNull();
		expect(parseMemoV3(`substrate:v3:${id512}:2026-09-26T10:00:00.000Z:79:${HEADS3}:${SIG}`)?.graphId).toBe(id512);
		expect(parseMemoV3(formatMemoV3({ ...V3, graphId: id512 }))).toStrictEqual({ ...V3, graphId: id512 });
	});

	test("a graph id of 512 ASCII characters, 512 bytes, round-trips", () => {
		const memo = { ...V3, graphId: "g".repeat(512) };
		expect(parseMemoV3(formatMemoV3(memo))).toStrictEqual(memo);
	});

	test("a graph id of 512 UTF-8 bytes round-trips: 256 two-byte characters", () => {
		const graphId = "é".repeat(256);
		expect(new TextEncoder().encode(graphId).byteLength).toBe(512);
		expect(parseMemoV3(formatMemoV3({ ...V3, graphId }))).toStrictEqual({ ...V3, graphId });
	});

	test("a graph id of 513 UTF-8 bytes is refused on format and on parse", () => {
		const graphId = `${"é".repeat(256)}a`;
		expect(new TextEncoder().encode(graphId).byteLength).toBe(513);
		expect(() => formatMemoV3({ ...V3, graphId })).toThrow("formatMemoV3:");
		expect(parseMemoV3(`substrate:v3:${graphId}:2026-09-26T10:00:00.000Z:79:${HEADS3}:${SIG}`)).toBeNull();
	});

	test("512 multibyte characters, 1,536 bytes, are refused on format and on parse", () => {
		const graphId = "€".repeat(512);
		expect(new TextEncoder().encode(graphId).byteLength).toBe(1536);
		expect(() => formatMemoV3({ ...V3, graphId })).toThrow("formatMemoV3:");
		expect(parseMemoV3(`substrate:v3:${graphId}:2026-09-26T10:00:00.000Z:79:${HEADS3}:${SIG}`)).toBeNull();
	});

	test("a pointer memo for a 512-byte graph id plus its 251-byte transaction overhead is under the 1,232-byte packet", () => {
		// Overhead of the pointer transaction `solana transfer --with-memo` builds (solana.ts transferArgv), counted without the memo
		// bytes: 1 signature count + 64 signature; 3 header; 1 key count + 4 keys (payer, index address, System, Memo) × 32; 32 blockhash;
		// 1 instruction count; transfer = program index 1 + account count 1 + 2 indices + data length 1 + 12 data bytes;
		// memo = program index 1 + account count 1 (none) + data length 2 (the memo is 128 to 16,383 bytes).
		const overhead = 1 + 64 + 3 + (1 + 4 * 32) + 32 + 1 + (1 + 1 + 2 + 1 + 12) + (1 + 1 + 2);
		expect(overhead).toBe(251);
		const memo = formatMemoV3({ ...V3, graphId: "g".repeat(512), hourTxSig: "5".repeat(88) });
		expect(new TextEncoder().encode(memo).byteLength).toBe(707);
		expect(new TextEncoder().encode(memo).byteLength + overhead).toBeLessThan(1232);
	});
});
