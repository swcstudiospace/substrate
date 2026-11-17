import { describe, expect, test } from "bun:test";
import { type GraphHeadRecord, headRecordHash, headsRoot } from "./heads.ts";
import { merkleRootHex } from "./merkle.ts";
import { HOUR_MS } from "./period.ts";

const H10 = Date.UTC(2026, 8, 26, 10);
const base: GraphHeadRecord = {
	graphId: "graph-a",
	sessionId: "session-1",
	periodStartMs: H10,
	count: 3,
	leavesRootHex: "aa".repeat(32),
	headEventId: "evt-3",
	headHashHex: "bb".repeat(32),
};
const withRecord = (overrides: Partial<GraphHeadRecord>): GraphHeadRecord => ({ ...base, ...overrides });

describe("headRecordHash", () => {
	test("is deterministic and 64 lowercase hex", () => {
		expect(headRecordHash(base)).toBe(headRecordHash({ ...base }));
		expect(headRecordHash(base)).toMatch(/^[0-9a-f]{64}$/);
	});

	test("is SHA-256 over the canonical JSON array of the fields", () => {
		const canonical = JSON.stringify([
			base.graphId,
			base.sessionId,
			base.periodStartMs,
			base.count,
			base.leavesRootHex,
			base.headEventId,
			base.headHashHex,
		]);
		expect(headRecordHash(base)).toBe(new Bun.CryptoHasher("sha256").update(canonical).digest("hex"));
	});

	test("changes when any one field changes", () => {
		const edits: Partial<GraphHeadRecord>[] = [
			{ graphId: "graph-b" },
			{ sessionId: "session-2" },
			{ periodStartMs: H10 + HOUR_MS },
			{ count: 4 },
			{ leavesRootHex: "cc".repeat(32) },
			{ headEventId: "evt-4" },
			{ headHashHex: "cc".repeat(32) },
		];
		const hashes = edits.map((edit) => headRecordHash(withRecord(edit)));
		expect(new Set([headRecordHash(base), ...hashes]).size).toBe(edits.length + 1);
	});

	test("accepts an empty sessionId", () => {
		expect(headRecordHash(withRecord({ sessionId: "" }))).toMatch(/^[0-9a-f]{64}$/);
	});

	test("refuses a non-hour period, a bad leaves root and an empty graphId", () => {
		expect(() => headRecordHash(withRecord({ periodStartMs: H10 + 1 }))).toThrow("headRecordHash:");
		expect(() => headRecordHash(withRecord({ leavesRootHex: "AB".repeat(32) }))).toThrow("headRecordHash:");
		expect(() => headRecordHash(withRecord({ leavesRootHex: "ab".repeat(31) }))).toThrow("headRecordHash:");
		expect(() => headRecordHash(withRecord({ graphId: "" }))).toThrow("headRecordHash:");
	});
});

describe("headsRoot", () => {
	const a = withRecord({ graphId: "graph-a" });
	const b = withRecord({ graphId: "graph-b", count: 5, headEventId: "evt-b" });
	const c = withRecord({ graphId: "graph-c", count: 1, headEventId: "evt-c" });

	test("of one record equals the Merkle root over its hash", () => {
		expect(headsRoot([base])).toBe(merkleRootHex([headRecordHash(base)]));
	});

	test("sorts by (graphId, sessionId) before hashing", () => {
		expect(headsRoot([c, a, b])).toBe(merkleRootHex([a, b, c].map((r) => headRecordHash(r))));
	});

	test("is identical for every input order", () => {
		const root = headsRoot([a, b, c]);
		for (const order of [
			[c, a, b],
			[b, c, a],
			[c, b, a],
		]) {
			expect(headsRoot(order)).toBe(root);
		}
	});

	test("gives two sessions of one graph two distinct leaves", () => {
		const s1 = withRecord({ sessionId: "session-1" });
		const s2 = withRecord({ sessionId: "session-2", headEventId: "evt-s2" });
		expect(headsRoot([s1, s2])).toBe(headsRoot([s2, s1]));
		expect(headsRoot([s1, s2])).not.toBe(headsRoot([s1]));
		expect(headsRoot([s1, s2])).toBe(merkleRootHex([s1, s2].map((r) => headRecordHash(r))));
	});

	test("accepts an empty sessionId as its own bucket", () => {
		const none = withRecord({ sessionId: "" });
		expect(headsRoot([none, a])).toBe(headsRoot([a, none]));
		expect(headsRoot([none])).toBe(merkleRootHex([headRecordHash(none)]));
	});

	test("changes when a single record's count changes", () => {
		expect(headsRoot([a, b, c])).not.toBe(headsRoot([a, withRecord({ graphId: "graph-b", count: 6 }), c]));
	});

	test("refuses an empty list", () => {
		expect(() => headsRoot([])).toThrow("headsRoot:");
	});

	test("refuses a duplicate (graphId, sessionId) pair", () => {
		expect(() => headsRoot([a, withRecord({ graphId: "graph-a", count: 9 })])).toThrow("headsRoot:");
	});

	test("refuses records with different periodStartMs", () => {
		expect(() => headsRoot([a, withRecord({ graphId: "graph-b", periodStartMs: H10 + HOUR_MS })])).toThrow(
			"headsRoot:",
		);
	});
});
