import { describe, expect, test } from "bun:test";
import { AUTHORITY_WEIGHTS, type AuthorityInput, type FeedbackCounts, scoreDocument } from "./authority.ts";
import { DOC_KINDS, DOC_TIERS, type DocKind, type DocTier } from "./protocol.ts";

const NO_FEEDBACK: FeedbackCounts = { helpful: 0, unhelpful: 0, stale: 0, wrong: 0, duplicate: 0 };
const AGES: Array<number | null> = [null, 0, 1, 30, 365, 1000, 100_000];
const COUNTS = [0, 1, 2, 5, 40];
const NEGATIVES = ["unhelpful", "stale", "wrong", "duplicate"] as const;

function input(overrides: Partial<AuthorityInput> = {}): AuthorityInput {
	return { tier: 1, kind: "doc", ageDays: 10, supersededBy: null, feedback: { ...NO_FEEDBACK }, ...overrides };
}

describe("scoreDocument bounds and determinism", () => {
	test("every combination of tier, kind, age, feedback and supersession scores inside 0..1", () => {
		for (const tier of DOC_TIERS) {
			for (const kind of DOC_KINDS) {
				for (const ageDays of AGES) {
					for (const helpful of COUNTS) {
						for (const negative of COUNTS) {
							for (const supersededBy of [null, "other.md"]) {
								const score = scoreDocument({
									tier,
									kind,
									ageDays,
									supersededBy,
									feedback: { helpful, unhelpful: negative, stale: negative, wrong: negative, duplicate: negative },
								});
								expect(score).toBeGreaterThan(0);
								expect(score).toBeLessThanOrEqual(1);
							}
						}
					}
				}
			}
		}
	});

	test("a perfect document scores close to 1 and never above it", () => {
		const best = scoreDocument(
			input({ tier: 1, kind: "planning-state", ageDays: 0, feedback: { ...NO_FEEDBACK, helpful: 1_000_000 } }),
		);
		expect(best).toBeLessThanOrEqual(1);
		expect(best).toBeGreaterThan(0.99);
	});

	test("the same input always gives the same score", () => {
		const a = input({ tier: 2, kind: "adr", ageDays: 77, feedback: { helpful: 3, unhelpful: 1, stale: 2, wrong: 0, duplicate: 1 } });
		expect(scoreDocument(a)).toBe(scoreDocument({ ...a, feedback: { ...a.feedback } }));
	});

	test("invalid counts and ages are treated as zero or unknown instead of leaving the range", () => {
		const bad = scoreDocument(
			input({ ageDays: Number.NaN, feedback: { helpful: -5, unhelpful: Number.NaN, stale: Number.POSITIVE_INFINITY, wrong: -1, duplicate: Number.NaN } }),
		);
		expect(bad).toBe(scoreDocument(input({ ageDays: null })));
		expect(scoreDocument(input({ ageDays: -30 }))).toBe(scoreDocument(input({ ageDays: 0 })));
	});

	test("the weights of the four terms sum to one", () => {
		const w = AUTHORITY_WEIGHTS;
		expect(w.tier + w.kind + w.recency + w.feedback).toBeCloseTo(1, 12);
	});

	test("every kind has a kind score in 0..1", () => {
		for (const kind of DOC_KINDS) {
			const value = AUTHORITY_WEIGHTS.kindScore[kind];
			expect(value).toBeGreaterThan(0);
			expect(value).toBeLessThanOrEqual(1);
		}
		expect(Object.keys(AUTHORITY_WEIGHTS.kindScore).sort()).toEqual([...DOC_KINDS].sort());
	});
});

describe("scoreDocument monotonicity", () => {
	test("more helpful feedback never lowers the score and, next to a negative, strictly raises it", () => {
		for (const tier of DOC_TIERS) {
			for (const negative of COUNTS) {
				let previous = -1;
				for (const helpful of COUNTS) {
					const score = scoreDocument(input({ tier, feedback: { ...NO_FEEDBACK, helpful, wrong: negative } }));
					expect(score).toBeGreaterThanOrEqual(previous);
					previous = score;
				}
			}
		}
		expect(scoreDocument(input({ feedback: { ...NO_FEEDBACK, helpful: 1 } }))).toBeGreaterThan(scoreDocument(input()));
	});

	test("more unhelpful, stale, wrong or duplicate feedback never raises the score", () => {
		for (const field of NEGATIVES) {
			for (const helpful of COUNTS) {
				let previous = 2;
				for (const negative of COUNTS) {
					const score = scoreDocument(input({ feedback: { ...NO_FEEDBACK, helpful, [field]: negative } }));
					expect(score).toBeLessThanOrEqual(previous);
					previous = score;
				}
			}
			expect(scoreDocument(input({ feedback: { ...NO_FEEDBACK, [field]: 1 } }))).toBeLessThan(scoreDocument(input()));
		}
	});

	test("a wrong report costs more than a duplicate report, and a stale report more than an unhelpful one", () => {
		const of = (field: (typeof NEGATIVES)[number]): number => scoreDocument(input({ feedback: { ...NO_FEEDBACK, [field]: 3 } }));
		expect(of("wrong")).toBeLessThan(of("duplicate"));
		expect(of("stale")).toBeLessThan(of("unhelpful"));
	});

	test("a superseded document scores strictly lower than the same document not superseded", () => {
		for (const tier of DOC_TIERS) {
			for (const kind of DOC_KINDS) {
				for (const ageDays of AGES) {
					const live = scoreDocument(input({ tier, kind, ageDays }));
					const replaced = scoreDocument(input({ tier, kind, ageDays, supersededBy: "repo:new.md" }));
					expect(replaced).toBeLessThan(live);
				}
			}
		}
	});

	test("an older document never scores above a newer one", () => {
		const ages = [0, 1, 30, 365, 1000, 100_000];
		for (const tier of DOC_TIERS) {
			for (const kind of DOC_KINDS) {
				let previous = 2;
				for (const ageDays of ages) {
					const score = scoreDocument(input({ tier, kind, ageDays }));
					expect(score).toBeLessThanOrEqual(previous);
					previous = score;
				}
			}
		}
		expect(scoreDocument(input({ ageDays: 0 }))).toBeGreaterThan(scoreDocument(input({ ageDays: 365 })));
	});

	test("an unknown age sits between the freshest and the oldest document", () => {
		const unknown = scoreDocument(input({ ageDays: null }));
		expect(unknown).toBeLessThan(scoreDocument(input({ ageDays: 0 })));
		expect(unknown).toBeGreaterThan(scoreDocument(input({ ageDays: 1_000_000 })));
	});

	test("tier 1 beats tier 2 beats tier 3 for every kind, age and feedback", () => {
		const feedbacks: FeedbackCounts[] = [NO_FEEDBACK, { ...NO_FEEDBACK, helpful: 5 }, { ...NO_FEEDBACK, wrong: 5 }];
		for (const kind of DOC_KINDS) {
			for (const ageDays of AGES) {
				for (const feedback of feedbacks) {
					for (const supersededBy of [null, "x.md"]) {
						const at = (tier: DocTier): number => scoreDocument({ tier, kind, ageDays, supersededBy, feedback });
						expect(at(1)).toBeGreaterThan(at(2));
						expect(at(2)).toBeGreaterThan(at(3));
					}
				}
			}
		}
	});
});

describe("scoreDocument without feedback or supersession", () => {
	test("the score depends on tier, kind and age only: any such document equals its zero-feedback twin", () => {
		const kinds: DocKind[] = ["doc", "adr", "planning-archive"];
		for (const kind of kinds) {
			for (const tier of DOC_TIERS) {
				for (const ageDays of AGES) {
					const plain = scoreDocument({ tier, kind, ageDays, supersededBy: null, feedback: { ...NO_FEEDBACK } });
					const w = AUTHORITY_WEIGHTS;
					const recency = ageDays === null ? w.unknownRecency : 0.5 ** (ageDays / w.recencyHalfLifeDays);
					const expected = w.tier * w.tierScore[tier] + w.kind * w.kindScore[kind] + w.recency * recency + w.feedback * 0.5;
					expect(plain).toBeCloseTo(expected, 12);
				}
			}
		}
	});

	test("feedback moves a document off the no-feedback score in the stated direction", () => {
		const neutral = scoreDocument(input());
		expect(scoreDocument(input({ feedback: { ...NO_FEEDBACK, helpful: 4 } }))).toBeGreaterThan(neutral);
		expect(scoreDocument(input({ feedback: { ...NO_FEEDBACK, stale: 4 } }))).toBeLessThan(neutral);
	});

	test("one vote cannot move a document further than the prior allows", () => {
		const neutral = scoreDocument(input());
		const oneWrong = scoreDocument(input({ feedback: { ...NO_FEEDBACK, wrong: 1 } }));
		const manyWrong = scoreDocument(input({ feedback: { ...NO_FEEDBACK, wrong: 100 } }));
		expect(neutral - oneWrong).toBeLessThan(neutral - manyWrong);
	});
});
