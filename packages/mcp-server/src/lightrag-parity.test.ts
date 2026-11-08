import { describe, expect, test } from "bun:test";
import { checkParityGate, type ParityDocument, type ParityInput, type ParityQuery } from "./lightrag-parity.ts";

const A = "https://docs.example/a";
const B = "https://docs.example/b";
const C = "https://docs.example/c";

const DOC_A: ParityDocument = { dataset: "agent-substrate", sourceUrl: A, version: "v1" };
const DOC_B: ParityDocument = { dataset: "agent-substrate", sourceUrl: B, version: "v1" };
const DOC_C: ParityDocument = { dataset: "programming-desk", sourceUrl: C, version: "v2" };

function syntheticQueries(): ParityQuery[] {
	return Array.from({ length: 10 }, (_, index) => ({
		id: `q${index}`,
		expectedSources: index < 5 ? [A] : [B, C],
	}));
}

function fixture(
	answerOverrides: Readonly<Record<string, readonly string[]>> = {},
	overrides: Partial<ParityInput> = {},
): ParityInput {
	const queries = syntheticQueries();
	return {
		source: [DOC_A, DOC_B, DOC_C],
		migrated: [DOC_A, DOC_B, DOC_C],
		queries,
		answers: queries.map((query) => ({
			queryId: query.id,
			citedSources: answerOverrides[query.id] ?? query.expectedSources,
		})),
		...overrides,
	};
}

describe("checkParityGate", () => {
	test("passes when every document is migrated unchanged and all ten queries match", () => {
		expect(checkParityGate(fixture())).toEqual({
			passed: true,
			recordMismatches: [],
			queryMisses: [],
			matched: 10,
			total: 10,
			matchRate: 1,
		});
	});

	describe("record check", () => {
		test.each([
			{
				field: "dataset",
				changed: { ...DOC_A, dataset: "programming-desk" },
				described: "programming-desk https://docs.example/a v1",
			},
			{
				field: "sourceUrl",
				changed: { ...DOC_A, sourceUrl: "https://docs.example/a-moved" },
				described: "agent-substrate https://docs.example/a-moved v1",
			},
			{
				field: "version",
				changed: { ...DOC_A, version: "v9" },
				described: "agent-substrate https://docs.example/a v9",
			},
		])("a changed $field fails and names both the source and the migrated document", ({ changed, described }) => {
			expect(checkParityGate(fixture({}, { migrated: [changed, DOC_B, DOC_C] }))).toEqual({
				passed: false,
				recordMismatches: [`missing agent-substrate ${A} v1`, `unexpected ${described}`],
				queryMisses: [],
				matched: 10,
				total: 10,
				matchRate: 1,
			});
		});

		test("a missing document fails and is named", () => {
			expect(checkParityGate(fixture({}, { migrated: [DOC_A, DOC_B] }))).toEqual({
				passed: false,
				recordMismatches: [`missing programming-desk ${C} v2`],
				queryMisses: [],
				matched: 10,
				total: 10,
				matchRate: 1,
			});
		});

		test("an unexpected document fails and is named", () => {
			const extra: ParityDocument = { dataset: "agent-substrate", sourceUrl: "https://docs.example/d", version: "v1" };
			expect(checkParityGate(fixture({}, { migrated: [DOC_A, DOC_B, DOC_C, extra] }))).toEqual({
				passed: false,
				recordMismatches: ["unexpected agent-substrate https://docs.example/d v1"],
				queryMisses: [],
				matched: 10,
				total: 10,
				matchRate: 1,
			});
		});

		test("a document migrated twice fails as a multiset, not a set", () => {
			expect(checkParityGate(fixture({}, { migrated: [DOC_A, DOC_A, DOC_B, DOC_C] }))).toEqual({
				passed: false,
				recordMismatches: [`unexpected agent-substrate ${A} v1`],
				queryMisses: [],
				matched: 10,
				total: 10,
				matchRate: 1,
			});
		});

		test("an empty export fails closed, even when nothing was migrated and every query matches", () => {
			expect(checkParityGate(fixture({}, { source: [], migrated: [] }))).toEqual({
				passed: false,
				recordMismatches: ["source export is empty"],
				queryMisses: [],
				matched: 10,
				total: 10,
				matchRate: 1,
			});
		});

		test("the same dataset and source URL at two versions is checked per version: an unmigrated stale copy is named missing", () => {
			const stale: ParityDocument = { dataset: "programming-desk", sourceUrl: C, version: "v1" };
			expect(checkParityGate(fixture({}, { source: [DOC_A, DOC_B, DOC_C, stale], migrated: [DOC_A, DOC_B, DOC_C] }))).toEqual({
				passed: false,
				recordMismatches: [`missing programming-desk ${C} v1`],
				queryMisses: [],
				matched: 10,
				total: 10,
				matchRate: 1,
			});
		});
	});

	describe("query check", () => {
		test("a query that lacks a cited source fails", () => {
			expect(checkParityGate(fixture({ q5: [B] }))).toEqual({
				passed: false,
				recordMismatches: [],
				queryMisses: [`q5: cites [${B}] expected [${B}, ${C}]`],
				matched: 9,
				total: 10,
				matchRate: 0.9,
			});
		});

		test("a query that cites an extra source fails", () => {
			expect(checkParityGate(fixture({ q0: [A, C] }))).toEqual({
				passed: false,
				recordMismatches: [],
				queryMisses: [`q0: cites [${A}, ${C}] expected [${A}]`],
				matched: 9,
				total: 10,
				matchRate: 0.9,
			});
		});

		test("a query with no answer fails", () => {
			const base = fixture();
			expect(checkParityGate({ ...base, answers: base.answers.filter((answer) => answer.queryId !== "q2") })).toEqual({
				passed: false,
				recordMismatches: [],
				queryMisses: ["q2: no answer"],
				matched: 9,
				total: 10,
				matchRate: 0.9,
			});
		});

		test("a query with two answers fails even when both answers match", () => {
			const base = fixture();
			expect(
				checkParityGate({ ...base, answers: [...base.answers, { queryId: "q0", citedSources: [A] }] }),
			).toEqual({
				passed: false,
				recordMismatches: [],
				queryMisses: ["q0: multiple answers"],
				matched: 9,
				total: 10,
				matchRate: 0.9,
			});
		});
	});

	describe("match rate", () => {
		test("one miss of ten is 0.9: passes at 0.9 and fails at the default of 1", () => {
			const oneMiss = { q0: [B] };
			const report = {
				recordMismatches: [],
				queryMisses: [`q0: cites [${B}] expected [${A}]`],
				matched: 9,
				total: 10,
				matchRate: 0.9,
			};
			expect(checkParityGate(fixture(oneMiss, { requiredMatchRate: 0.9 }))).toEqual({ passed: true, ...report });
			expect(checkParityGate(fixture(oneMiss))).toEqual({ passed: false, ...report });
		});

		test("an empty queries list fails closed without throwing", () => {
			expect(checkParityGate(fixture({}, { queries: [], answers: [] }))).toEqual({
				passed: false,
				recordMismatches: [],
				queryMisses: [],
				matched: 0,
				total: 0,
				matchRate: 0,
			});
		});
	});

	describe("malformed input", () => {
		test("an empty expectedSources list throws a TypeError", () => {
			const queries: ParityQuery[] = [{ id: "q0", expectedSources: [] }];
			expect(() => checkParityGate(fixture({}, { queries, answers: [] }))).toThrow(TypeError);
		});

		test("duplicate query ids throw a TypeError", () => {
			const queries: ParityQuery[] = [
				{ id: "q0", expectedSources: [A] },
				{ id: "q0", expectedSources: [B] },
			];
			expect(() => checkParityGate(fixture({}, { queries, answers: [] }))).toThrow(TypeError);
		});

		test.each([0, 1.5, Number.NaN])("requiredMatchRate %s throws a TypeError", (requiredMatchRate) => {
			expect(() => checkParityGate(fixture({}, { requiredMatchRate }))).toThrow(TypeError);
		});
	});

	test("does not mutate any input array", () => {
		const input = fixture({ q0: [B] }, { migrated: [DOC_A, DOC_A, DOC_C], requiredMatchRate: 0.9 });
		const before = structuredClone(input);
		expect(checkParityGate(input).recordMismatches).toEqual([
			`missing agent-substrate ${B} v1`,
			`unexpected agent-substrate ${A} v1`,
		]);
		expect(input).toEqual(before);
	});
});
