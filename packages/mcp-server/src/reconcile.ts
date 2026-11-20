/**
 * Cross-layer reconciliation core (Phase 78, D78-1 to D78-4, D78-9).
 *
 * Pure: no I/O. The readers in `reconcile-read.ts` build the inputs, and this
 * module decides drift and shapes the report. Every output is sorted by key
 * (byte order), so the same inputs always produce the same report.
 *
 * Lease drift compares identity only. Expiry is never an input (D78-2): an
 * expired hold that has not been reaped yet is not drift, and a free key on
 * both sides is not drift.
 */

/** The three stores the reconcile compares. */
export type Layer = "ledger" | "index" | "cache";

/** A lease hold: who holds the node and at which epoch. `null` means free. */
export type LeaseHold = { surface: string; session_id: string; epoch: number } | null;

/** One mismatch. `key` is the lease key, the entry id, or the cache key. */
export interface Finding {
	comparison: "lease" | "memory" | "generation";
	key: string;
	detail: string;
}

/** The read-only reconcile report (`substrate.reconcile.report.v1`). */
export interface Report {
	schema: "substrate.reconcile.report.v1";
	generated_at: string;
	window_hours: number;
	counts: Record<string, number>;
	truncated: Record<string, boolean>;
	unchecked_memory_rows: number;
	/** Layers the run did not check; see `ReportInput.unchecked_layers`. */
	unchecked_layers: Layer[];
	findings: Finding[];
	first: { lease: Finding | null; memory: Finding | null; generation: Finding | null };
	clean: boolean;
}

/** Everything `buildReport` needs. `findings` may mix comparisons. */
export interface ReportInput {
	generated_at: string;
	window_hours: number;
	counts: Record<string, number>;
	truncated: Record<string, boolean>;
	unchecked_memory_rows: number;
	/** Layers the run did not check. `cache` when the cache is off: its counts are absent, so the layer is named here instead. */
	unchecked_layers: Layer[];
	findings: readonly Finding[];
}

/** Cache key prefix for generation counters: `substrate:v1` + `gen:graph:<id>`. */
const GENERATION_KEY_PREFIX = "substrate:v1:gen:graph:";

/** Tie-break order between comparisons that share a key. */
const COMPARISON_RANK: Record<Finding["comparison"], number> = {
	lease: 0,
	memory: 1,
	generation: 2,
};

function byteOrder(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function holdLabel(hold: NonNullable<LeaseHold>): string {
	return `surface=${hold.surface} session=${hold.session_id} epoch=${hold.epoch}`;
}

/**
 * Compare lease identity between the ledger's view and the index's view.
 *
 * Covers every key present on either side. Drift is: ledger held and index
 * free; index held and ledger free; or both held with a different surface,
 * session or epoch. Both free is not drift.
 *
 * @param ledger - key `graph_id/node_id` to the ledger's latest hold (or `null`).
 * @param index - key `graph_id/node_id` to the index's hold (or `null`).
 * @returns findings sorted by key.
 */
export function compareLeases(
	ledger: ReadonlyMap<string, LeaseHold>,
	index: ReadonlyMap<string, LeaseHold>,
): Finding[] {
	const findings: Finding[] = [];
	const keys = [...new Set([...ledger.keys(), ...index.keys()])].sort(byteOrder);
	for (const key of keys) {
		const held = ledger.get(key) ?? null;
		const indexed = index.get(key) ?? null;
		if (held === null && indexed === null) continue;
		if (held !== null && indexed === null) {
			findings.push({
				comparison: "lease",
				key,
				detail: `ledger holds ${holdLabel(held)}; index is free`,
			});
		} else if (held === null && indexed !== null) {
			findings.push({
				comparison: "lease",
				key,
				detail: `index holds ${holdLabel(indexed)}; ledger is free`,
			});
		} else if (held !== null && indexed !== null) {
			if (
				held.surface !== indexed.surface ||
				held.session_id !== indexed.session_id ||
				held.epoch !== indexed.epoch
			) {
				findings.push({
					comparison: "lease",
					key,
					detail: `identity differs: ledger ${holdLabel(held)}; index ${holdLabel(indexed)}`,
				});
			}
		}
	}
	return findings;
}

/**
 * Compare memory writes in both directions over the window.
 *
 * `index` holds the entry ids of `memory_entries` rows created in the window.
 * `ledger` holds the entry ids of accepted memory audit events in the window.
 *
 * @returns findings sorted by entry id.
 */
export function compareMemory(
	index: ReadonlySet<string>,
	ledger: ReadonlySet<string>,
): Finding[] {
	const keys = [...new Set([...index, ...ledger])].sort(byteOrder);
	const findings: Finding[] = [];
	for (const key of keys) {
		const inIndex = index.has(key);
		const inLedger = ledger.has(key);
		if (inIndex && !inLedger) {
			findings.push({
				comparison: "memory",
				key,
				detail: "index memory row has no accepted audit event in the window",
			});
		} else if (!inIndex && inLedger) {
			findings.push({
				comparison: "memory",
				key,
				detail: "accepted audit event has no index memory row in the window",
			});
		}
	}
	return findings;
}

/**
 * Find generation counters whose graph is absent from `graph_index`.
 *
 * @param genGraphIds - graph ids that have a `gen:graph:<id>` counter in the cache.
 * @param indexGraphIds - graph ids present in `graph_index`.
 * @returns one orphan finding per counter, keyed `substrate:v1:gen:graph:<id>`, sorted by key.
 */
export function compareGenerations(
	genGraphIds: ReadonlySet<string>,
	indexGraphIds: ReadonlySet<string>,
): Finding[] {
	return [...genGraphIds]
		.filter((id) => !indexGraphIds.has(id))
		.sort(byteOrder)
		.map((id) => ({
			comparison: "generation" as const,
			key: `${GENERATION_KEY_PREFIX}${id}`,
			detail: `generation counter for graph ${id} has no graph_index row`,
		}));
}

/**
 * Assemble the report from the comparison findings and the layer counts.
 *
 * Findings are sorted by key, with comparison rank and detail as tie-breaks.
 * `first` is the first finding of each comparison in that order. `clean` is
 * true only when there are no findings and no truncation flag is set.
 *
 * @param input - the counts, truncation flags and findings to report.
 * @returns the report; the input is not mutated.
 */
export function buildReport(input: ReportInput): Report {
	const findings = [...input.findings].sort(
		(a, b) =>
			byteOrder(a.key, b.key) ||
			COMPARISON_RANK[a.comparison] - COMPARISON_RANK[b.comparison] ||
			byteOrder(a.detail, b.detail),
	);
	const firstOf = (comparison: Finding["comparison"]): Finding | null =>
		findings.find((finding) => finding.comparison === comparison) ?? null;
	const anyTruncated = Object.values(input.truncated).some(Boolean);
	return {
		schema: "substrate.reconcile.report.v1",
		generated_at: input.generated_at,
		window_hours: input.window_hours,
		counts: Object.fromEntries(Object.entries(input.counts).sort(([a], [b]) => byteOrder(a, b))),
		truncated: Object.fromEntries(Object.entries(input.truncated).sort(([a], [b]) => byteOrder(a, b))),
		unchecked_memory_rows: input.unchecked_memory_rows,
		unchecked_layers: input.unchecked_layers,
		findings,
		first: {
			lease: firstOf("lease"),
			memory: firstOf("memory"),
			generation: firstOf("generation"),
		},
		clean: findings.length === 0 && !anyTruncated,
	};
}
