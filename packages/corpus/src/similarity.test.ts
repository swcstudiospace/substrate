import { describe, expect, test } from "bun:test";
import { cosine, NEAR_DUPLICATE_MAX_ITEMS, nearDuplicates, nearDuplicatesYielding, normalize, type NearDuplicateItem } from "./similarity.ts";

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

/** A deterministic stream in [-1, 1): a test must not depend on Math.random. */
function seeded(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 2 ** 31 - 1;
	};
}

/** Random vectors with a few exact copies and one zero vector, so ties, the zero skip and a crowded top are all exercised. */
function randomItems(count: number, dimension: number, seed: number): NearDuplicateItem[] {
	const next = seeded(seed);
	const items: NearDuplicateItem[] = [];
	for (let index = 0; index < count; index++) {
		const key = `k${String(index).padStart(4, "0")}`;
		const earlier = items[Math.floor(index / 2)];
		if (index > 3 && index % 7 === 0 && earlier !== undefined) items.push({ key, vector: Array.from(earlier.vector) });
		else if (index === 3) items.push({ key, vector: new Array<number>(dimension).fill(0) });
		else items.push({ key, vector: Array.from({ length: dimension }, next) });
	}
	return items;
}

describe("nearDuplicatesYielding", () => {
	const noYield = (): Promise<void> => Promise.resolve();
	const cases: Array<[number, number, number | undefined]> = [];
	for (const count of [0, 1, 2, 9, 40, 130]) {
		for (const threshold of [-1, 0, 0.35, 0.9, 0.999999]) {
			for (const maxPairs of [undefined, 5, 0]) cases.push([count, threshold, maxPairs]);
		}
	}

	test.each(cases.map((row) => [row] as const))("returns exactly the pairs of nearDuplicates, in the same order: %j", async ([count, threshold, maxPairs]) => {
		const items = randomItems(count, 8, count * 31 + 7);
		const options = { threshold, maxPairs };
		const expected = nearDuplicates(items, options);
		// A budget of one multiply-add yields after every row, the hardest case for the blocking logic.
		expect(await nearDuplicatesYielding(items, options, { yieldFn: noYield, yieldEvery: 1 })).toEqual(expected);
		expect(await nearDuplicatesYielding(items, options, { yieldFn: noYield })).toEqual(expected);
	});

	test("yields more than once for a large input and never for a tiny one", async () => {
		let large = 0;
		await nearDuplicatesYielding(randomItems(700, 32, 11), { threshold: 0.99 }, {
			yieldFn: async () => {
				large += 1;
			},
		});
		// 244650 pairs of 32 multiply-adds is about 7.8 million, so several 2-million blocks.
		expect(large).toBeGreaterThan(1);
		let tiny = 0;
		await nearDuplicatesYielding(randomItems(5, 8, 3), { threshold: 0.5 }, {
			yieldFn: async () => {
				tiny += 1;
			},
		});
		expect(tiny).toBe(0);
	});

	test("a block is sized by work, so a longer vector yields more often for the same item count", async () => {
		const yields = async (dimension: number): Promise<number> => {
			let calls = 0;
			await nearDuplicatesYielding(randomItems(200, dimension, 5), { threshold: 0.99 }, {
				yieldEvery: 100_000,
				yieldFn: async () => {
					calls += 1;
				},
			});
			return calls;
		};
		expect(await yields(64)).toBeGreaterThan(await yields(8));
	});

	test("an abort between blocks rejects with the signal's reason and stops the work", async () => {
		const controller = new AbortController();
		let calls = 0;
		const run = nearDuplicatesYielding(randomItems(300, 16, 9), { threshold: 0 }, {
			yieldEvery: 1000,
			signal: controller.signal,
			yieldFn: async () => {
				calls += 1;
				controller.abort(new Error("stop"));
			},
		});
		await expect(run).rejects.toThrow("stop");
		expect(calls).toBe(1);
	});

	test("a signal that is already aborted rejects before any work", async () => {
		const controller = new AbortController();
		controller.abort(new Error("early"));
		let calls = 0;
		const run = nearDuplicatesYielding(randomItems(50, 8, 1), { threshold: 0 }, {
			signal: controller.signal,
			yieldFn: async () => {
				calls += 1;
			},
		});
		await expect(run).rejects.toThrow("early");
		expect(calls).toBe(0);
	});

	test("a yield function that rejects rejects the comparison", async () => {
		const run = nearDuplicatesYielding(randomItems(100, 16, 2), { threshold: 0 }, {
			yieldEvery: 100,
			yieldFn: async () => {
				throw new Error("loop gone");
			},
		});
		await expect(run).rejects.toThrow("loop gone");
	});

	test("every refusal of the synchronous function is a rejection, never a synchronous throw", async () => {
		const tooMany = Array.from({ length: NEAR_DUPLICATE_MAX_ITEMS + 1 }, (_, index) => ({ key: String(index), vector: [1, 0] }));
		const refusals: Array<[NearDuplicateItem[], number]> = [
			[[{ key: "a", vector: [1, 0] }], Number.NaN],
			[[{ key: "a", vector: [1, 0] }], Number.POSITIVE_INFINITY],
			[[{ key: "a", vector: [1, 0] }, { key: "b", vector: [1, 0, 0] }], 0.5],
			[tooMany, 0.5],
		];
		for (const [items, threshold] of refusals) {
			// A synchronous throw here would fail the test itself; the refusal has to arrive as a rejection.
			const started = nearDuplicatesYielding(items, { threshold }, { yieldFn: noYield });
			await expect(started).rejects.toBeInstanceOf(RangeError);
			expect(() => nearDuplicates(items, { threshold })).toThrow(RangeError);
		}
	});
});
