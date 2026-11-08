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
const NEAR_DUPLICATE_DEFAULT_MAX_PAIRS = 1000;

export interface NearDuplicateItem {
	key: string;
	vector: ArrayLike<number>;
}

export interface NearDuplicatePair {
	a: string;
	b: string;
	similarity: number;
}

interface NearDuplicateOptions {
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

interface Unit {
	key: string;
	vector: Float64Array;
}

/** The state of one comparison, shared by the synchronous and the yielding entry points so they cannot drift apart. */
interface Scan {
	units: Unit[];
	threshold: number;
	maxPairs: number;
	flushAt: number;
	pairs: NearDuplicatePair[];
}

function startScan(items: readonly NearDuplicateItem[], opts: NearDuplicateOptions): Scan {
	if (!Number.isFinite(opts.threshold)) throw new RangeError("threshold must be a finite number");
	if (items.length > NEAR_DUPLICATE_MAX_ITEMS) {
		throw new RangeError(`nearDuplicates compares every pair and accepts at most ${NEAR_DUPLICATE_MAX_ITEMS} items`);
	}
	const maxPairs = Math.max(0, Math.floor(opts.maxPairs ?? NEAR_DUPLICATE_DEFAULT_MAX_PAIRS));
	const units: Unit[] = [];
	for (const item of items) {
		const vector = normalize(item.vector);
		if (norm(vector) === 0) continue;
		const first = units[0];
		if (first !== undefined && first.vector.length !== vector.length) {
			throw new RangeError(`vector lengths differ: ${first.vector.length} and ${vector.length}`);
		}
		units.push({ key: item.key, vector });
	}
	// Truncating to the best `maxPairs` whenever the buffer reaches four times the cap bounds memory when many pairs match.
	return { units, threshold: opts.threshold, maxPairs, flushAt: Math.max(4 * maxPairs, 16), pairs: [] };
}

/** Compares the unit at `row` with every unit after it and keeps the pairs at or above the threshold. */
function scanRow(scan: Scan, row: number): void {
	const { units } = scan;
	const left = units[row];
	if (left === undefined) return;
	for (let j = row + 1; j < units.length; j++) {
		const right = units[j];
		if (right === undefined) continue;
		let dot = 0;
		for (let k = 0; k < left.vector.length; k++) dot += (left.vector[k] ?? 0) * (right.vector[k] ?? 0);
		const similarity = clamp(dot);
		if (similarity < scan.threshold) continue;
		const ordered = compareKeys(left.key, right.key) <= 0;
		scan.pairs.push({ a: ordered ? left.key : right.key, b: ordered ? right.key : left.key, similarity });
		if (scan.pairs.length >= scan.flushAt) scan.pairs = scan.pairs.sort(comparePairs).slice(0, scan.maxPairs);
	}
}

function finishScan(scan: Scan): NearDuplicatePair[] {
	return scan.pairs.sort(comparePairs).slice(0, scan.maxPairs);
}

/**
 * The pairs of items whose cosine similarity is at least `threshold`, most similar first, ties by key. Each pair is
 * reported once with `a` ordered before `b`. Items with a zero vector are skipped. Throws a RangeError when the vectors
 * differ in length, the threshold is not finite, or there are more than `NEAR_DUPLICATE_MAX_ITEMS` items.
 *
 * A floating-point dot product of identical vectors can land a hair under 1, so a threshold of exactly 1 is best written
 * as 0.999999.
 *
 * The whole comparison runs without yielding to the event loop; a server answering other requests uses
 * {@link nearDuplicatesYielding}.
 */
export function nearDuplicates(items: readonly NearDuplicateItem[], opts: NearDuplicateOptions): NearDuplicatePair[] {
	const scan = startScan(items, opts);
	for (let row = 0; row < scan.units.length; row++) scanRow(scan, row);
	return finishScan(scan);
}

/** The multiply-adds {@link nearDuplicatesYielding} does between two yields unless told otherwise. */
const NEAR_DUPLICATE_YIELD_WORK = 2_000_000;

interface NearDuplicateYielding {
	/** Called between blocks of rows so other work can run; resolves when the comparison may continue. */
	yieldFn: () => Promise<void>;
	/** Multiply-adds between two yields (a row of `n - i - 1` pairs costs that many times the vector length). Default {@link NEAR_DUPLICATE_YIELD_WORK}. */
	yieldEvery?: number | undefined;
	/** Checked before the first block and after every yield; an aborted signal rejects with its reason. */
	signal?: AbortSignal | undefined;
}

/**
 * {@link nearDuplicates} that lets the event loop run between blocks of rows. The cost is the same O(n^2) dot products; a
 * block is the rows whose work (pairs times vector length) adds up to about `yieldEvery`, so the pause between two yields
 * does not grow with the number of items. It returns the same pairs in the same order as `nearDuplicates` for the same
 * input, and every error, the RangeErrors included, is a rejection rather than a synchronous throw.
 */
export async function nearDuplicatesYielding(items: readonly NearDuplicateItem[], opts: NearDuplicateOptions, yielding: NearDuplicateYielding): Promise<NearDuplicatePair[]> {
	yielding.signal?.throwIfAborted();
	const scan = startScan(items, opts);
	const budget = yielding.yieldEvery !== undefined && Number.isFinite(yielding.yieldEvery) ? Math.max(1, Math.floor(yielding.yieldEvery)) : NEAR_DUPLICATE_YIELD_WORK;
	const dimension = scan.units[0]?.vector.length ?? 0;
	const last = scan.units.length - 1;
	let work = 0;
	for (let row = 0; row < scan.units.length; row++) {
		scanRow(scan, row);
		work += (last - row) * dimension;
		// Nothing is left to compare after the last row, so the final block needs no pause.
		if (work < budget || row >= last) continue;
		work = 0;
		await yielding.yieldFn();
		yielding.signal?.throwIfAborted();
	}
	return finishScan(scan);
}
