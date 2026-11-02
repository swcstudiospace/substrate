/**
 * The confirmed repair (Phase 78, D78-5, D78-6, H4). A plan names one action: flush the whole `substrate:v1` cache prefix when
 * the report shows generation orphans. The flush is safe only because the cache is derived. It removes counters, answers,
 * snapshots and the forget mark together, never a subset. Nothing here touches the ledger or the index.
 */
import { createHash } from "node:crypto";
import type { ReadThroughCache } from "./cache.ts";
import { DEFAULT_RECONCILE_CAPS, type ReconcileDeps, runReport } from "./reconcile-run.ts";
import type { Finding, Report } from "./reconcile.ts";

/** The whole cache prefix. A flush never narrows below it: a counter alone can revive a stale answer (D78-5). */
const FLUSH_MATCH = "substrate:v1:*";

/** One action a plan names. `orphans` are the generation finding keys (`gen:graph:<id>`) that justified it. */
export interface PlanItem {
	action: "flush-derived-cache";
	match: string;
	reason: string;
	orphans: string[];
}

/** The plan record (`substrate.reconcile.plan.v1`). `report_digest` pins the findings the plan was made from. */
export interface Plan {
	schema: "substrate.reconcile.plan.v1";
	created_at: string;
	window_hours: number;
	report_digest: string;
	items: PlanItem[];
}

/** What a repair did. `listed` is the plan's item count; `repaired` is the keys removed, so it reads against `listed`. */
export interface RepairResult {
	executed: boolean;
	reason: string;
	listed: number;
	repaired: number;
	truncated: boolean;
	refused: boolean;
}

/**
 * sha256 hex over the findings, sorted by comparison then key, each as `comparison|key`, joined by newline. The detail is
 * not hashed: the digest pins which mismatches exist, so any change in them refuses a stale plan.
 */
export function findingsDigest(findings: readonly Finding[]): string {
	const lines = [...findings]
		.sort((a, b) => (a.comparison < b.comparison ? -1 : a.comparison > b.comparison ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
		.map((finding) => `${finding.comparison}|${finding.key}`);
	return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/**
 * The plan for a report. It lists one flush item when the report has generation findings, and none otherwise. The digest
 * is taken over every finding, so a plan goes stale when any comparison changes.
 */
export function planFromReport(report: Report, now: Date): Plan {
	const orphans = report.findings.filter((finding) => finding.comparison === "generation").map((finding) => finding.key);
	const items: PlanItem[] =
		orphans.length === 0
			? []
			: [
					{
						action: "flush-derived-cache",
						match: FLUSH_MATCH,
						reason: `${orphans.length} generation counter(s) for graphs absent from graph_index; flush ${FLUSH_MATCH} (derived cache only)`,
						orphans,
					},
				];
	return {
		schema: "substrate.reconcile.plan.v1",
		created_at: now.toISOString(),
		window_hours: report.window_hours,
		report_digest: findingsDigest(report.findings),
		items,
	};
}

/**
 * Run a plan. It re-runs the read-only report first, then refuses when the findings differ from the plan's digest or no
 * generation orphan remains. Without `execute` it returns what it would do and writes nothing. With `execute` it scans the
 * whole `substrate:v1:*` prefix and unlinks every key it found. A capped scan flushes only part of the prefix; the result
 * says so, and a fresh plan finishes it.
 */
export async function executePlan(
	plan: Plan,
	deps: ReconcileDeps & { cache: Pick<ReadThroughCache, "scanKeys" | "unlinkKeys"> },
	options: { execute: boolean },
): Promise<RepairResult> {
	const listed = plan.items.length;
	const live = await runReport(deps);
	if (findingsDigest(live.findings) !== plan.report_digest) {
		return {
			executed: false,
			reason: "refused: the findings changed since the plan was made (digest mismatch); re-plan before repairing",
			listed,
			repaired: 0,
			truncated: false,
			refused: true,
		};
	}
	const orphans = live.findings.filter((finding) => finding.comparison === "generation");
	if (orphans.length === 0) {
		return {
			executed: false,
			reason: "refused: no generation orphans remain, so there is nothing to repair",
			listed,
			repaired: 0,
			truncated: false,
			refused: true,
		};
	}
	if (!options.execute) {
		return {
			executed: false,
			reason: `dry run: ${orphans.length} generation orphan(s) confirmed; would flush ${FLUSH_MATCH}. Nothing written; re-run with execute to flush`,
			listed,
			repaired: 0,
			truncated: false,
			refused: false,
		};
	}
	const scan = await deps.cache.scanKeys(FLUSH_MATCH, DEFAULT_RECONCILE_CAPS.cacheKeys);
	const repaired = scan.keys.length > 0 ? await deps.cache.unlinkKeys(scan.keys) : 0;
	const reason = scan.truncated
		? `partial flush: the scan stopped at ${DEFAULT_RECONCILE_CAPS.cacheKeys} keys and removed ${repaired}; re-plan and execute again to finish`
		: `flushed ${repaired} key(s) under ${FLUSH_MATCH}; the cache is cold until it refills`;
	return { executed: true, reason, listed, repaired, truncated: scan.truncated, refused: false };
}
