/**
 * The confirmed repair (Phase 78, D78-5, D78-6, H4). A plan names one action: flush the `substrate:v1` cache prefix when the
 * report shows generation orphans. The cache is derived, so the flush is safe, but only in order: answers and snapshots first,
 * then the generation counters, then the forget mark. No counter or mark is removed while an answer that depends on it may
 * remain. The flush needs the server stopped, and a scan that cannot complete refuses before anything is removed. A failed
 * flush keeps every counter it has not reached. Nothing here touches the ledger or the index.
 */
import { createHash } from "node:crypto";
import { type CacheKeyClass, classOf, FORGET_MARK_KEY, type ReadThroughCache } from "./cache.ts";
import { type ReconcileDeps, runReport } from "./reconcile-run.ts";
import type { Finding, Report } from "./reconcile.ts";
import { redact } from "./redact.ts";

/** The whole cache prefix, scanned once. A flush never narrows below it: a counter alone can revive a stale answer (D78-5). */
const FLUSH_MATCH = "substrate:v1:*";

/** The most keys a flush will consider. A scan that reaches it is incomplete, so the flush refuses rather than run on part of the prefix. */
const FLUSH_SCAN_LIMIT = 1_000_000;

/** The answer and snapshot classes, removed first. Each is derived from a counter or the forget mark, so it goes before them. */
const FLUSH_ANSWER_CLASSES: readonly CacheKeyClass[] = [
	"brief",
	"memory-search",
	"graph-view",
	"brief-snapshot",
	"recall-snapshot",
	"docs-search",
];

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
 * writes nothing. With `execute` it needs `serverStopped`, and refuses without it. It then scans `substrate:v1:*` once and
 * refuses when the scan cannot complete, so a partial key list is never flushed. The flush runs three passes in a fixed order:
 * answers and snapshots, then generation counters, then the forget mark. A failure part way is returned in `error`, with the
 * count removed so far; a failed flush keeps every counter it has not reached.
 */
export async function executePlan(
	plan: Plan,
	deps: ReconcileDeps & { cache: Pick<ReadThroughCache, "scanKeys" | "unlinkKeys"> },
	options: { execute: boolean; serverStopped: boolean },
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
			reason: `dry run: ${orphans.length} generation orphan(s) confirmed; would remove the answers and snapshots, then the generation counters, then the forget mark, under ${FLUSH_MATCH}; budget and embedding keys stay. Nothing written; re-run with --execute --server-stopped to flush`,
			listed,
			repaired: 0,
			truncated: false,
			refused: false,
		};
	}
	if (!options.serverStopped) {
		return {
			executed: false,
			reason: "refused: a flush needs the server stopped (--server-stopped); a live server can write a snapshot between the passes",
			listed,
			repaired: 0,
			truncated: false,
			refused: true,
		};
	}
	let repaired = 0;
	// One pass. `repaired` takes each batch as its callback lands, so a later failure keeps the earlier batches counted; a pass
	// that finishes sets the total to the count it returned.
	const unlinkPass = async (keys: readonly string[]): Promise<void> => {
		if (keys.length === 0) return;
		const before = repaired;
		const removed = await deps.cache.unlinkKeys(keys, (count) => {
			repaired += count;
		});
		repaired = before + removed;
	};
	try {
		const scan = await deps.cache.scanKeys(FLUSH_MATCH, FLUSH_SCAN_LIMIT);
		if (scan.truncated) {
			return {
				executed: false,
				reason: "refused: the cache keys could not be read completely (the cache is off, or the prefix holds more than 1000000 keys); nothing was removed",
				listed,
				repaired: 0,
				truncated: true,
				refused: true,
			};
		}
		// Each key falls in at most one group. Answers and snapshots go first, then the counters, then the mark. Budget, embedding
		// and unnamed keys fall in no group and are never removed.
		const answers = scan.keys.filter((key) => {
			const cls = classOf(key);
			return cls !== null && FLUSH_ANSWER_CLASSES.includes(cls);
		});
		const counters = scan.keys.filter((key) => key !== FORGET_MARK_KEY && classOf(key) === "gen");
		const mark = scan.keys.filter((key) => key === FORGET_MARK_KEY);
		await unlinkPass(answers);
		await unlinkPass(counters);
		await unlinkPass(mark);
	} catch (cause) {
		// A failed pass stops the flush. A failure among the answers leaves every counter and the mark in place; a failure among
		// the counters leaves the mark in place. `repaired` holds the keys removed before the failure.
		const error = failureReason(cause);
		return { executed: false, reason: `failed: the flush of ${FLUSH_MATCH} stopped: ${error}`, listed, repaired, truncated: false, refused: false, error };
	}
	return {
		executed: true,
		reason: `flushed ${repaired} key(s) in three passes: answers and snapshots, then generation counters, then the forget mark; budget and embedding keys untouched; the cache is cold until it refills`,
		listed,
		repaired,
		truncated: false,
		refused: false,
	};
}
