/**
 * Vector similarity for near-duplicate documents (v1.7 phase 64 builds on this).
 *
 * Pure and exact. `nearDuplicates` compares every pair, so it costs O(n^2) dot products: fine up to
 * `NEAR_DUPLICATE_MAX_ITEMS` items, and a larger input is refused rather than left to run for hours. A caller with more
 * documents compares them in blocks.
 */

/** The most items `nearDuplicates` accepts in one call. */
export const NEAR_DUPLICATE_MAX_ITEMS = 5000;

/** The default cap on pairs returned. */
export const NEAR_DUPLICATE_DEFAULT_MAX_PAIRS = 1000;

export interface NearDuplicateItem {
	key: string;
	vector: ArrayLike<number>;
}

export interface NearDuplicatePair {
	a: string;
	b: string;
	similarity: number;
}

export interface NearDuplicateOptions {
	/** Pairs with a similarity at or above this are returned. Must be a finite number. */
	threshold: number;
	/** Cap on the pairs returned, the most similar first. Default 1000. */
	maxPairs?: number | undefined;
}

function norm(v: ArrayLike<number>): number {
	let sum = 0;
	for (let i = 0; i < v.length; i++) {
		const x = v[i] ?? 0;
		sum += x * x;
	}
	return Math.sqrt(sum);
}

/** The unit vector in the direction of `v`; a zero vector stays zero, so it never matches anything. */
export function normalize(v: ArrayLike<number>): Float64Array {
	const out = new Float64Array(v.length);
	const length = norm(v);
	if (length === 0 || !Number.isFinite(length)) return out;
	for (let i = 0; i < v.length; i++) out[i] = (v[i] ?? 0) / length;
	return out;
}

/**
 * Cosine similarity in [-1, 1]. Returns 0 when either vector is zero (the angle is undefined) and throws a RangeError
 * when the lengths differ, because comparing vectors from two different models is a bug, not a similarity.
 */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
	if (a.length !== b.length) throw new RangeError(`vector lengths differ: ${a.length} and ${b.length}`);
	const na = norm(a);
	const nb = norm(b);
	if (na === 0 || nb === 0) return 0;
	let dot = 0;
	for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
	return clamp(dot / (na * nb));
}

function clamp(value: number): number {
	return Math.min(1, Math.max(-1, value));
}

function compareKeys(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function comparePairs(x: NearDuplicatePair, y: NearDuplicatePair): number {
	return y.similarity - x.similarity || compareKeys(x.a, y.a) || compareKeys(x.b, y.b);
}

/**
 * The pairs of items whose cosine similarity is at least `threshold`, most similar first, ties by key. Each pair is
 * reported once with `a` ordered before `b`. Items with a zero vector are skipped. Throws a RangeError when the vectors
 * differ in length, the threshold is not finite, or there are more than `NEAR_DUPLICATE_MAX_ITEMS` items.
 *
 * A floating-point dot product of identical vectors can land a hair under 1, so a threshold of exactly 1 is best written
 * as 0.999999.
 */
export function nearDuplicates(items: readonly NearDuplicateItem[], opts: NearDuplicateOptions): NearDuplicatePair[] {
	if (!Number.isFinite(opts.threshold)) throw new RangeError("threshold must be a finite number");
	if (items.length > NEAR_DUPLICATE_MAX_ITEMS) {
		throw new RangeError(`nearDuplicates compares every pair and accepts at most ${NEAR_DUPLICATE_MAX_ITEMS} items`);
	}
	const maxPairs = Math.max(0, Math.floor(opts.maxPairs ?? NEAR_DUPLICATE_DEFAULT_MAX_PAIRS));
	const units: Array<{ key: string; vector: Float64Array }> = [];
	for (const item of items) {
		const vector = normalize(item.vector);
		if (norm(vector) === 0) continue;
		const first = units[0];
		if (first !== undefined && first.vector.length !== vector.length) {
			throw new RangeError(`vector lengths differ: ${first.vector.length} and ${vector.length}`);
		}
		units.push({ key: item.key, vector });
	}

	let pairs: NearDuplicatePair[] = [];
	// Truncating to the best `maxPairs` whenever the buffer reaches four times the cap bounds memory when many pairs match.
	const flushAt = Math.max(4 * maxPairs, 16);
	for (let i = 0; i < units.length; i++) {
		const left = units[i];
		if (left === undefined) continue;
		for (let j = i + 1; j < units.length; j++) {
			const right = units[j];
			if (right === undefined) continue;
			let dot = 0;
			for (let k = 0; k < left.vector.length; k++) dot += (left.vector[k] ?? 0) * (right.vector[k] ?? 0);
			const similarity = clamp(dot);
			if (similarity < opts.threshold) continue;
			const ordered = compareKeys(left.key, right.key) <= 0;
			pairs.push({ a: ordered ? left.key : right.key, b: ordered ? right.key : left.key, similarity });
			if (pairs.length >= flushAt) pairs = pairs.sort(comparePairs).slice(0, maxPairs);
		}
	}
	return pairs.sort(comparePairs).slice(0, maxPairs);
}
