/**
 * PARITY_GATE (phase 46, SC4): the comparator that must pass, in order,
 * before any LightRAG ingestion replaces the RAGFlow plane.
 *
 * The gate is two ordered parts over one input:
 *
 *   Part A — record mapping. Every archived RAGFlow record, identified by
 *   its logical dataset name, source URL and per-URL version, must have a
 *   corresponding LightRAG record with the same triple. Zero mismatches.
 *   Records compare by the logical dataset NAME, never by the RAGFlow
 *   dataset id: the id is plane-local and differs across planes
 *   (`docs-datasets.ts lightragSearchDatasets` names the datasets on the
 *   LightRAG plane). A missing record and a changed field both count as
 *   mismatches; a LightRAG record with no archived counterpart is an
 *   `extra`. If Part A fails, Part B is not evaluated and is reported as
 *   skipped.
 *
 *   Part B — the frozen 20-query sample
 *   (`fixtures/parity/parity-queries.json`). A query matches when the
 *   RAGFlow baseline's top-1 cited source URL appears among the LightRAG
 *   reply's top-5 cited source URLs. A degraded or empty LightRAG reply is
 *   a miss. Part B passes when the match rate reaches `minMatchRate`
 *   (0.85, so 17 of 20).
 *
 * The comparator never throws on bad input: a record that is not the
 * expected shape is a `malformed` mismatch entry, not an exception.
 * Mismatch entries carry the dataset and source_url only — never page
 * content — so a gate report is safe to paste into a summary or a ticket.
 *
 * `parityDelta` is the cutover delta pass (SC5): the same record-mapping
 * comparison over only the records the commits ingested after the cutover
 * produced, with the same zero-mismatch rule and no sample part. The
 * caller extracts the delta subsets; a LightRAG record with no delta
 * counterpart is a post-cutover page, not a mismatch, so extras are not
 * flagged here (unlike Part A, whose mapping is total).
 *
 * Pure: no I/O, no clock, no network. `scripts/docs-migrate.ts` feeds it
 * from the archive (dry run) and from the live stores (post-apply).
 */

/** The minimum Part B match rate (0.85 → 17 of 20). */
export const PARITY_MIN_MATCH_RATE = 0.85;

/** How many of a LightRAG reply's citations may carry the baseline's top-1 (the top-5 rule). */
export const PARITY_TOP_K = 5;

/** One migrated record: logical dataset name, source URL and per-URL version. */
export interface ParityRecord {
	dataset: string;
	source_url: string;
	version: number;
}

/** The RAGFlow side of Part B: the archived baseline for one sample query. */
export interface ParityBaselineAnswer {
	id: string;
	/** Cited source URLs, best first; the match rule reads the first entry (top-1). */
	source_urls: readonly string[];
}

/** The LightRAG side of Part B: one sample query's answer. */
export interface ParitySampleAnswer {
	id: string;
	/** Cited source URLs, best first; only the top {@link PARITY_TOP_K} count. */
	source_urls: readonly string[];
	/** A degraded (fallback or failed) LightRAG reply is always a miss. */
	degraded?: boolean;
}

/**
 * One Part A disagreement. Redaction rule: dataset and source_url only —
 * never page content, never a plane-local dataset id, never a reason
 * string that could carry a snippet.
 */
export type ParityMismatch =
	| { kind: "missing"; dataset: string; source_url: string }
	| { kind: "changed"; dataset: string; source_url: string }
	| { kind: "extra"; dataset: string; source_url: string }
	| { kind: "malformed"; dataset: string; source_url: string };

export interface ParityGateInput {
	/** The archived RAGFlow records (logical names resolved by the mapper). */
	ragflowRecords: readonly unknown[];
	/** The LightRAG records: the mapper's expectation (dry run) or the live store (post-apply). */
	lightragRecords: readonly unknown[];
	/** The archived RAGFlow baseline, one entry per frozen query; malformed entries are skips, not throws. */
	baseline: readonly unknown[];
	/** The LightRAG answers for the same queries, in any order. */
	sampleAnswers: readonly ParitySampleAnswer[];
	/** The Part B floor; default {@link PARITY_MIN_MATCH_RATE}. */
	minMatchRate?: number;
	/** Skip Part B (the dry run's record-mapping-only mode); Part B reports `skipped`. */
	skipPartB?: boolean;
}

export interface ParityPartA {
	passed: boolean;
	/** How many well-formed RAGFlow records Part A compared. */
	records: number;
	/** How many LightRAG records were considered, extras and malformed included. */
	mapped: number;
	/** How many mismatch entries Part A produced. */
	mismatches: number;
}

export type ParityPartB =
	| { skipped: true }
	| {
			skipped: false;
			/** How many well-formed baseline entries Part B ran over. */
			queries: number;
			matches: number;
			matchRate: number;
			passed: boolean;
			/** The sample ids whose baseline top-1 never showed in the LightRAG top-5. */
			misses: string[];
	  };

export interface ParityGateResult {
	passed: boolean;
	partA: ParityPartA;
	partB: ParityPartB;
	/** Every Part A mismatch entry, redacted to dataset + source_url. */
	mismatches: ParityMismatch[];
	/** `null` while Part B is skipped; otherwise the Part B match rate. */
	matchRate: number | null;
	threshold: number;
}

const UNPARSABLE = "(unparsable)";

/** The record an archived row describes, or null when it is not the expected shape. */
export function normalizeRecord(value: unknown): ParityRecord | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const entry = value as Record<string, unknown>;
	const dataset = entry.dataset;
	const sourceUrl = entry.source_url;
	const version = entry.version;
	if (typeof dataset !== "string" || dataset.length === 0) return null;
	if (typeof sourceUrl !== "string" || sourceUrl.length === 0) return null;
	if (typeof version !== "number" || !Number.isInteger(version) || version < 0) return null;
	return { dataset, source_url: sourceUrl, version };
}

/** A malformed record's redacted mismatch entry; unreadable fields stay `(unparsable)`. */
function malformed(value: unknown): ParityMismatch {
	const entry = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
	const dataset = entry.dataset;
	const sourceUrl = entry.source_url;
	return {
		kind: "malformed",
		dataset: typeof dataset === "string" && dataset.length > 0 ? dataset : UNPARSABLE,
		source_url: typeof sourceUrl === "string" && sourceUrl.length > 0 ? sourceUrl : UNPARSABLE,
	};
}

function recordKey(dataset: string, sourceUrl: string): string {
	return `${dataset}\u0000${sourceUrl}`;
}

/**
 * The Part A comparison: every RAGFlow record must map onto a LightRAG
 * record with the same logical dataset, source URL and version; a LightRAG
 * record with no RAGFlow counterpart is an `extra`. Never throws.
 */
function compareRecords(
	ragflowRecords: readonly unknown[],
	lightragRecords: readonly unknown[],
): { mismatches: ParityMismatch[]; records: number; mapped: number } {
	const mismatches: ParityMismatch[] = [];
	const lightragByKey = new Map<string, ParityRecord>();
	let mapped = 0;
	for (const value of lightragRecords) {
		const record = normalizeRecord(value);
		if (record === null) {
			mapped += 1;
			mismatches.push(malformed(value));
			continue;
		}
		mapped += 1;
		lightragByKey.set(recordKey(record.dataset, record.source_url), record);
	}
	let records = 0;
	for (const value of ragflowRecords) {
		const record = normalizeRecord(value);
		if (record === null) {
			records += 1;
			mismatches.push(malformed(value));
			continue;
		}
		records += 1;
		const key = recordKey(record.dataset, record.source_url);
		const other = lightragByKey.get(key);
		if (other === undefined) {
			mismatches.push({ kind: "missing", dataset: record.dataset, source_url: record.source_url });
			continue;
		}
		lightragByKey.delete(key);
		if (other.version !== record.version) {
			mismatches.push({ kind: "changed", dataset: record.dataset, source_url: record.source_url });
		}
	}
	for (const leftover of lightragByKey.values()) {
		mismatches.push({ kind: "extra", dataset: leftover.dataset, source_url: leftover.source_url });
	}
	return { mismatches, records, mapped };
}

/**
 * The ordered gate. Part A (record mapping, zero mismatches) runs first;
 * Part B (the frozen sample) runs only when Part A passed and was not
 * skipped. A skipped Part B is never a pass: `passed` stays false until a
 * real Part B clears the threshold. Never throws on bad input.
 */
export function parityGate(input: ParityGateInput): ParityGateResult {
	const threshold = input.minMatchRate ?? PARITY_MIN_MATCH_RATE;
	const compared = compareRecords(input.ragflowRecords, input.lightragRecords);
	const partA: ParityPartA = {
		passed: compared.mismatches.length === 0,
		records: compared.records,
		mapped: compared.mapped,
		mismatches: compared.mismatches.length,
	};
	if (!partA.passed) {
		return { passed: false, partA, partB: { skipped: true }, mismatches: compared.mismatches, matchRate: null, threshold };
	}
	if (input.skipPartB === true) {
		return { passed: false, partA, partB: { skipped: true }, mismatches: [], matchRate: null, threshold };
	}
	const answerById = new Map<string, ParitySampleAnswer>();
	for (const answer of input.sampleAnswers) {
		if (answer === null || typeof answer !== "object") continue;
		if (typeof (answer as ParitySampleAnswer).id === "string") answerById.set((answer as ParitySampleAnswer).id, answer as ParitySampleAnswer);
	}
	const misses: string[] = [];
	let matches = 0;
	let queries = 0;
	for (const baseline of input.baseline) {
		if (baseline === null || typeof baseline !== "object" || Array.isArray(baseline) || !("id" in baseline) || typeof baseline.id !== "string") continue;
		const baselineId: string = baseline.id;
		const baselineUrls = "source_urls" in baseline && Array.isArray(baseline.source_urls) ? baseline.source_urls : [];
		const top1 = baselineUrls.find((url): url is string => typeof url === "string" && url.length > 0);
		const answer = answerById.get(baselineId);
		const top5 = answer !== undefined && Array.isArray(answer.source_urls) ? answer.source_urls.slice(0, PARITY_TOP_K) : [];
		const matched = top1 !== undefined && answer !== undefined && answer.degraded !== true && top5.includes(top1);
		if (matched) matches += 1;
		else misses.push(baselineId);
		queries += 1;
	}
	const matchRate = queries > 0 ? matches / queries : 0;
	const partB: ParityPartB = {
		skipped: false,
		queries,
		matches,
		matchRate,
		passed: queries > 0 && matchRate >= threshold,
		misses,
	};
	return { passed: partA.passed && partB.passed, partA, partB, mismatches: [], matchRate, threshold };
}

export interface ParityDeltaInput {
	/** The delta's RAGFlow-side records (what the commits replaced). */
	ragflowRecords: readonly unknown[];
	/** The delta's LightRAG-side records (what the commits produced). */
	lightragRecords: readonly unknown[];
}

export interface ParityDeltaResult {
	passed: boolean;
	/** How many well-formed delta records were compared. */
	records: number;
	mismatches: ParityMismatch[];
}

/**
 * The cutover delta pass (SC5): the same record-mapping comparison over
 * the delta subsets the caller extracted from the commits ingested after
 * the cutover, with the same zero-mismatch rule and no sample part. A
 * LightRAG record with no delta counterpart is a page that only exists
 * post-cutover — expected, not a mismatch — so extras are not flagged.
 */
export function parityDelta(input: ParityDeltaInput): ParityDeltaResult {
	const mismatches: ParityMismatch[] = [];
	const lightragByKey = new Map<string, ParityRecord>();
	for (const value of input.lightragRecords) {
		const record = normalizeRecord(value);
		if (record === null) {
			mismatches.push(malformed(value));
			continue;
		}
		lightragByKey.set(recordKey(record.dataset, record.source_url), record);
	}
	let records = 0;
	for (const value of input.ragflowRecords) {
		const record = normalizeRecord(value);
		if (record === null) {
			mismatches.push(malformed(value));
			continue;
		}
		records += 1;
		const other = lightragByKey.get(recordKey(record.dataset, record.source_url));
		if (other === undefined) mismatches.push({ kind: "missing", dataset: record.dataset, source_url: record.source_url });
		else if (other.version !== record.version) mismatches.push({ kind: "changed", dataset: record.dataset, source_url: record.source_url });
	}
	return { passed: mismatches.length === 0, records, mismatches };
}
