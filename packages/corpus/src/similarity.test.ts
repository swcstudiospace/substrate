import { describe, expect, test } from "bun:test";
import { cosine, NEAR_DUPLICATE_MAX_ITEMS, nearDuplicates, normalize } from "./similarity.ts";

describe("cosine", () => {
	test("identical vectors are 1, orthogonal 0, opposite -1, whatever their length", () => {
		expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 12);
		expect(cosine([2, 4, 6], [1, 2, 3])).toBeCloseTo(1, 12);
		expect(cosine([1, 0], [0, 5])).toBe(0);
		expect(cosine([1, 2], [-1, -2])).toBeCloseTo(-1, 12);
	});

	test("a zero vector has no angle, so it is 0 against anything, itself included", () => {
		expect(cosine([0, 0, 0], [1, 2, 3])).toBe(0);
		expect(cosine([1, 2, 3], [0, 0, 0])).toBe(0);
		expect(cosine([0, 0], [0, 0])).toBe(0);
	});

	test("a length mismatch is a bug and throws", () => {
		expect(() => cosine([1, 2], [1, 2, 3])).toThrow(RangeError);
	});

	test("a known angle: 45 degrees is sqrt(2)/2", () => {
		expect(cosine([1, 0], [1, 1])).toBeCloseTo(Math.SQRT1_2, 12);
	});
});

describe("normalize", () => {
	test("returns a unit vector without touching the input, and a zero vector stays zero", () => {
		const input = [3, 4];
		const unit = normalize(input);
		expect(Array.from(unit)).toEqual([0.6, 0.8]);
		expect(input).toEqual([3, 4]);
		expect(Array.from(normalize([0, 0]))).toEqual([0, 0]);
	});
});

describe("nearDuplicates", () => {
	const items = [
		{ key: "a", vector: [1, 0, 0] },
		{ key: "b", vector: [2, 0, 0] },
		{ key: "c", vector: [1, 1, 0] },
		{ key: "d", vector: [0, 0, 1] },
		{ key: "zero", vector: [0, 0, 0] },
		{ key: "neg", vector: [-1, 0, 0] },
	];

	test("returns every pair at or above the threshold, most similar first, ties by key, never the zero vector", () => {
		const pairs = nearDuplicates(items, { threshold: 0.7 });
		expect(pairs.map((p) => `${p.a}~${p.b}`)).toEqual(["a~b", "a~c", "b~c"]);
		expect(pairs[0]?.similarity).toBeCloseTo(1, 12);
		expect(pairs[1]?.similarity).toBeCloseTo(Math.SQRT1_2, 12);
	});

	test("the threshold is inclusive and a high one leaves only the identical direction", () => {
		const exact = nearDuplicates(items, { threshold: Math.SQRT1_2 - 1e-12 });
		expect(exact.map((p) => `${p.a}~${p.b}`)).toEqual(["a~b", "a~c", "b~c"]);
		expect(nearDuplicates(items, { threshold: 0.999999 }).map((p) => `${p.a}~${p.b}`)).toEqual(["a~b"]);
		expect(nearDuplicates(items, { threshold: 1.01 })).toEqual([]);
	});

	test("a negative threshold admits opposite vectors, and a pair is reported once with a before b", () => {
		const pairs = nearDuplicates(
			[
				{ key: "y", vector: [1, 0] },
				{ key: "x", vector: [-1, 0] },
			],
			{ threshold: -1 },
		);
		expect(pairs).toHaveLength(1);
		expect(pairs[0]?.a).toBe("x");
		expect(pairs[0]?.b).toBe("y");
		expect(pairs[0]?.similarity).toBeCloseTo(-1, 12);
	});

	test("maxPairs keeps the best pairs, also when far more pairs match than the cap", () => {
		const many = Array.from({ length: 60 }, (_, i) => ({ key: `k${String(i).padStart(2, "0")}`, vector: [1, i / 1000] }));
		const pairs = nearDuplicates(many, { threshold: 0.5, maxPairs: 5 });
		expect(pairs).toHaveLength(5);
		for (let i = 1; i < pairs.length; i++) {
			expect((pairs[i - 1]?.similarity ?? 0) >= (pairs[i]?.similarity ?? 0)).toBe(true);
		}
		const all = nearDuplicates(many, { threshold: 0.5, maxPairs: 5000 });
		expect(all).toHaveLength((60 * 59) / 2);
		expect(pairs).toEqual(all.slice(0, 5));
		expect(nearDuplicates(many, { threshold: 0.5, maxPairs: 0 })).toEqual([]);
	});

	test("refuses a non-finite threshold, mixed vector lengths and an input past the pairwise bound", () => {
		expect(() => nearDuplicates(items, { threshold: Number.NaN })).toThrow(RangeError);
		expect(() =>
			nearDuplicates(
				[
					{ key: "a", vector: [1, 0] },
					{ key: "b", vector: [1, 0, 0] },
				],
				{ threshold: 0.5 },
			),
		).toThrow(RangeError);
		const tooMany = Array.from({ length: NEAR_DUPLICATE_MAX_ITEMS + 1 }, (_, i) => ({ key: String(i), vector: [1] }));
		expect(() => nearDuplicates(tooMany, { threshold: 0.5 })).toThrow(RangeError);
	});
});
