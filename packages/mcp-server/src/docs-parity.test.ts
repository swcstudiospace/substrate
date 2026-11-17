/**
 * The PARITY_GATE's offline proof (SC4 build): Part A's zero-mismatch record
 * mapping gates Part B; a mismatched version fails Part A and Part B reports
 * skipped; the frozen sample needs 17 of 20 (0.85) and 16 of 20 fails; a
 * degraded or empty LightRAG reply is a miss; malformed records are reported
 * as mismatches, never thrown; mismatch entries carry dataset and source_url
 * only. The delta pass keeps the same zero-mismatch rule over delta subsets,
 * where a LightRAG-only record is a post-cutover page, not a mismatch.
 */
import { describe, expect, test } from "bun:test";
import {
	PARITY_MIN_MATCH_RATE,
	PARITY_TOP_K,
	normalizeRecord,
	parityDelta,
	parityGate,
	type ParityBaselineAnswer,
	type ParityRecord,
	type ParitySampleAnswer,
} from "./docs-parity.ts";

function record(dataset: string, sourceUrl: string, version: number): ParityRecord {
	return { dataset, source_url: sourceUrl, version };
}

const RECORDS_A: ParityRecord[] = [
	record("agent-substrate", "https://example.com/docs/a.md", 2),
	record("programming-desk", "https://example.com/docs/b.md", 1),
];
const RECORDS_B: ParityRecord[] = [
	record("agent-substrate", "https://example.com/docs/a.md", 2),
	record("programming-desk", "https://example.com/docs/b.md", 1),
];

const BASELINE: ParityBaselineAnswer[] = Array.from({ length: 20 }, (_, index) => ({
	id: `q${String(index + 1).padStart(2, "0")}`,
	source_urls: [`https://example.com/docs/q${index + 1}.md`],
}));

function answers(matches: number, degradedIds: string[] = []): ParitySampleAnswer[] {
	return BASELINE.map((entry, index) => {
		const hit = index < matches && !degradedIds.includes(entry.id);
		return {
			id: entry.id,
			source_urls: hit ? [`https://example.com/other.md`, entry.source_urls[0] ?? ""] : ["https://example.com/nothing.md"],
			...(degradedIds.includes(entry.id) ? { degraded: true } : {}),
		};
	});
}

describe("PARITY_GATE", () => {
	test("an exact mapping and a full sample pass both parts", () => {
		const result = parityGate({
			ragflowRecords: RECORDS_A,
			lightragRecords: RECORDS_B,
			baseline: BASELINE,
			sampleAnswers: answers(20),
		});
		expect(result.partA).toEqual({ passed: true, records: 2, mapped: 2, mismatches: 0 });
		expect(result.partB).toMatchObject({ skipped: false, queries: 20, matches: 20, passed: true, misses: [] });
		expect(result.passed).toBe(true);
		expect(result.matchRate).toBe(1);
		expect(result.threshold).toBe(PARITY_MIN_MATCH_RATE);
	});

	test("a mismatched version fails Part A, and Part B reports skipped", () => {
		const drifted = [record("agent-substrate", "https://example.com/docs/a.md", 2), record("programming-desk", "https://example.com/docs/b.md", 7)];
		const result = parityGate({ ragflowRecords: RECORDS_A, lightragRecords: drifted, baseline: BASELINE, sampleAnswers: answers(20) });
		expect(result.partA.passed).toBe(false);
		expect(result.partA.mismatches).toBe(1);
		expect(result.mismatches).toEqual([{ kind: "changed", dataset: "programming-desk", source_url: "https://example.com/docs/b.md" }]);
		expect(result.partB).toEqual({ skipped: true });
		expect(result.matchRate).toBeNull();
		expect(result.passed).toBe(false);
	});

	test("a missing record and an extra record are both Part A mismatches", () => {
		const missing = parityGate({ ragflowRecords: RECORDS_A, lightragRecords: RECORDS_B.slice(0, 1), baseline: [], sampleAnswers: [] });
		expect(missing.partA.passed).toBe(false);
		expect(missing.mismatches).toEqual([{ kind: "missing", dataset: "programming-desk", source_url: "https://example.com/docs/b.md" }]);
		const extra = parityGate({ ragflowRecords: RECORDS_A, lightragRecords: [...RECORDS_B, record("agent-skills", "https://example.com/docs/c.md", 1)], baseline: [], sampleAnswers: [] });
		expect(extra.partA.passed).toBe(false);
		expect(extra.mismatches).toEqual([{ kind: "extra", dataset: "agent-skills", source_url: "https://example.com/docs/c.md" }]);
	});

	test("16 of 20 fails Part B; 17 of 20 passes; a degraded or empty reply is a miss", () => {
		const low = parityGate({ ragflowRecords: [], lightragRecords: [], baseline: BASELINE, sampleAnswers: answers(16) });
		expect(low.partB).toMatchObject({ skipped: false, matches: 16, matchRate: 0.8, passed: false });
		expect(low.passed).toBe(false);
		const pass = parityGate({ ragflowRecords: [], lightragRecords: [], baseline: BASELINE, sampleAnswers: answers(17) });
		expect(pass.partB).toMatchObject({ matches: 17, matchRate: 0.85, passed: true });
		expect(pass.passed).toBe(true);
		const degraded = parityGate({ ragflowRecords: [], lightragRecords: [], baseline: BASELINE, sampleAnswers: answers(20, ["q01", "q02"]) });
		expect(degraded.partB).toMatchObject({ skipped: false, matches: 18, matchRate: 0.9, passed: true });
		if (!degraded.partB.skipped) expect(degraded.partB.misses).toEqual(["q01", "q02"]);
	});

	test("the baseline top-1 matches anywhere in the LightRAG top-5, and only the top-5 count", () => {
		const baseline: ParityBaselineAnswer[] = [{ id: "q01", source_urls: ["https://example.com/docs/top1.md"] }];
		const fifth = parityGate({
			ragflowRecords: [],
			lightragRecords: [],
			baseline,
			sampleAnswers: [{ id: "q01", source_urls: ["a", "b", "c", "d", "https://example.com/docs/top1.md"] }],
		});
		expect(fifth.partB).toMatchObject({ matches: 1, passed: true });
		const sixth = parityGate({
			ragflowRecords: [],
			lightragRecords: [],
			baseline,
			sampleAnswers: [{ id: "q01", source_urls: ["a", "b", "c", "d", "e", "https://example.com/docs/top1.md"] }],
		});
		expect(sixth.partB).toMatchObject({ matches: 0, passed: false });
		expect(PARITY_TOP_K).toBe(5);
	});

	test("malformed records are mismatches with redacted entries, never a throw", () => {
		const result = parityGate({
			ragflowRecords: [null, 42, { dataset: "d" }, { dataset: "d", source_url: "u", version: "2" }, record("d", "u", 1)],
			lightragRecords: [{ dataset: "", source_url: "u", version: 1 }, "junk", record("d", "u", 1)],
			baseline: [{ id: "q1", source_urls: [] }, { id: "q2" }, null],
			sampleAnswers: [null as unknown as ParitySampleAnswer, { id: "q1", source_urls: ["u"] }],
		});
		expect(result.partA.passed).toBe(false);
		expect(result.partA.mismatches).toBe(6); // ragflow malformed 4 + lightrag malformed 2; the one valid pair matches
		expect(result.mismatches.every((m) => m.dataset.length > 0 || m.dataset === "(unparsable)")).toBe(true);
		expect(result.mismatches.every((m) => typeof m.source_url === "string")).toBe(true);
		expect(() => parityDelta({ ragflowRecords: [undefined], lightragRecords: [3] })).not.toThrow();
		expect(parityDelta({ ragflowRecords: [undefined], lightragRecords: [3] }).passed).toBe(false);
	});

	test("the delta pass keeps the zero-mismatch rule and does not flag post-cutover pages", () => {
		const clean = parityDelta({
			ragflowRecords: [record("agent-substrate", "https://example.com/docs/delta.md", 3)],
			lightragRecords: [record("agent-substrate", "https://example.com/docs/delta.md", 3), record("agent-substrate", "https://example.com/docs/new.md", 1)],
		});
		expect(clean).toEqual({ passed: true, records: 1, mismatches: [] });
		const changed = parityDelta({
			ragflowRecords: [record("agent-substrate", "https://example.com/docs/delta.md", 3)],
			lightragRecords: [record("agent-substrate", "https://example.com/docs/delta.md", 4)],
		});
		expect(changed.passed).toBe(false);
		expect(changed.mismatches).toEqual([{ kind: "changed", dataset: "agent-substrate", source_url: "https://example.com/docs/delta.md" }]);
		const missing = parityDelta({ ragflowRecords: [record("d", "u", 1)], lightragRecords: [] });
		expect(missing.mismatches).toEqual([{ kind: "missing", dataset: "d", source_url: "u" }]);
	});

	test("normalizeRecord reads the migrated triple and refuses everything else", () => {
		expect(normalizeRecord({ dataset: "d", source_url: "u", version: 3 })).toEqual({ dataset: "d", source_url: "u", version: 3 });
		for (const bad of [null, undefined, [], "s", 7, {}, { dataset: "d" }, { dataset: "d", source_url: "u" }, { dataset: "d", source_url: "u", version: 1.5 }, { dataset: "d", source_url: "u", version: -1 }]) {
			expect(normalizeRecord(bad)).toBeNull();
		}
	});
});
