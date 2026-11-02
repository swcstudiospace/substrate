/**
 * The confirmed repair (Phase 78, D78-5, D78-6, H4). A plan names one action: flush the whole `substrate:v1` cache prefix when
 * the report shows generation orphans. The flush is safe only because the cache is derived. It removes counters, answers,
 * snapshots and the forget mark together, never a subset. Nothing here touches the ledger or the index.
 */
import { createHash } from "node:crypto";
import type { ReadThroughCache } from "./cache.ts";
import { DEFAULT_RECONCILE_CAPS, type ReconcileDeps, runReport } from "./reconcile-run.ts";
import type { Finding, Report } from "./reconcile.ts";
import { redact } from "./redact.ts";

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
	/** Set when the flush failed part way; `repaired` is then the keys removed before the failure. */
	error?: string;
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
 * A message that fits one line and names no URL: a connection error can quote the URL it was given, password and all.
 */
export function failureReason(cause: unknown): string {
	const text = String(cause instanceof Error ? cause.message : cause);
	return redact(text)
		.replace(/\b(?:redis|rediss|postgres|postgresql|https?):\/\/\S+/gi, "<url>")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 300);
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
 * Why a plan's items may not be run, or null when every item is the flush this repair runs. The digest pins what the report
 * found; this pins what the plan asks to remove. Messages never echo a value from the plan file.
 */
function planRefusal(items: readonly PlanItem[], liveOrphans: ReadonlySet<string>): string | null {
	for (const item of items) {
		if (typeof item !== "object" || item === null || item.action !== "flush-derived-cache") {
			return "the plan names an action this repair does not run; re-plan before repairing";
		}
		if (item.match !== FLUSH_MATCH) return `the plan names a match other than ${FLUSH_MATCH}; re-plan before repairing`;
		if (!Array.isArray(item.orphans) || item.orphans.some((orphan) => !liveOrphans.has(orphan))) {
			return "the plan names an orphan that the fresh report does not list as a live generation orphan; re-plan before repairing";
		}
	}
	return null;
}

/**
 * Run a plan. It re-runs the read-only report first, then refuses when the findings differ from the plan's digest, when no
 * generation orphan remains, or when any plan item is not the flush this repair runs: another action, another match than
 * `substrate:v1:*`, or an orphan the fresh report does not list as live. Without `execute` it returns what it would do and
 * writes nothing. With `execute` it scans the whole `substrate:v1:*` prefix and unlinks every key it found; a failure part way
 * is returned in `error`, with the count removed so far. A capped scan flushes only part of the prefix; the result says so,
 * and a fresh plan finishes it.
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
	const refusal = planRefusal(plan.items, new Set(orphans.map((finding) => finding.key)));
	if (refusal !== null) {
		return { executed: false, reason: `refused: ${refusal}`, listed, repaired: 0, truncated: false, refused: true };
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
	let repaired = 0;
	let truncated = false;
	try {
		const scan = await deps.cache.scanKeys(FLUSH_MATCH, DEFAULT_RECONCILE_CAPS.cacheKeys);
		truncated = scan.truncated;
		// Each batch is counted as it is removed, so `repaired` stays right when a later batch fails; on success the returned total is the count.
		if (scan.keys.length > 0) repaired = await deps.cache.unlinkKeys(scan.keys, (removed) => { repaired += removed; });
	} catch (cause) {
		// The flush stopped part way: `repaired` holds the keys the batches before the failure removed, so the result says so.
		const error = failureReason(cause);
		return { executed: false, reason: `failed: the flush of ${FLUSH_MATCH} stopped: ${error}`, listed, repaired, truncated, refused: false, error };
	}
	const reason = truncated
		? `partial flush: the scan stopped at ${DEFAULT_RECONCILE_CAPS.cacheKeys} keys and removed ${repaired}; re-plan and execute again to finish`
		: `flushed ${repaired} key(s) under ${FLUSH_MATCH}; the cache is cold until it refills`;
	return { executed: true, reason, listed, repaired, truncated, refused: false };
}
