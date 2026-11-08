/**
 * The confirmed repair (Phase 78, D78-5, D78-6, H4). A plan names one action: flush the `substrate:v1` cache prefix when the
 * report shows generation orphans. The cache is derived, so the flush is safe, but only in order: answers and snapshots first,
 * then the generation counters, then the forget mark. No counter or mark is removed while an answer that depends on it may
 * remain. One run removes at most RECONCILE_MAX_ITEMS keys, the corpus rule's bound. A longer plan takes several runs, and the
 * order holds across them because each run takes a prefix of the same ordered list. The flush needs the server stopped, and a
 * scan that cannot complete refuses before anything is removed. A failed flush keeps every counter it has not reached. Nothing
 * here touches the ledger or the index.
 */
import { createHash } from "node:crypto";
import { RECONCILE_MAX_ITEMS } from "@substrate/corpus";
import { CACHE_PREFIX, type CacheKeyClass, classOf, FORGET_MARK_KEY, type ReadThroughCache } from "./cache.ts";
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
interface PlanItem {
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

/**
 * What a repair did. Every count is a number of cache keys, so `planned` and `removed` read against each other. `planned` is
 * the keys the plan's flush names in this run's scan, `removed` the keys this run removed, and `remaining` their difference.
 * `limit` is the most keys one run removes. `truncated` is set when the plan names more keys than that: the run stops at the
 * bound and leaves `remaining` for a later run.
 */
export interface RepairResult {
	executed: boolean;
	reason: string;
	planned: number;
	removed: number;
	remaining: number;
	limit: number;
	truncated: boolean;
	refused: boolean;
	/** Set when the flush failed part way; `removed` is then the keys removed before the failure. */
	error?: string;
}

/** A result from its counts. A refusal made before the scan has no planned keys, so it reports zero. */
function repairOutcome(fields: {
	executed: boolean;
	refused: boolean;
	reason: string;
	planned?: number;
	removed?: number;
	error?: string;
}): RepairResult {
	const planned = fields.planned ?? 0;
	const removed = fields.removed ?? 0;
	return {
		executed: fields.executed,
		reason: fields.reason,
		planned,
		removed,
		remaining: planned - removed,
		limit: RECONCILE_MAX_ITEMS,
		truncated: planned > RECONCILE_MAX_ITEMS,
		refused: fields.refused,
		...(fields.error === undefined ? {} : { error: fields.error }),
	};
}

/** The result of a repair that failed before it could count anything. */
export function failedRepair(error: string): RepairResult {
	return repairOutcome({ executed: false, refused: false, reason: `failed: ${error}`, error });
}

/**
 * sha256 hex over the findings and the counter keys. Findings sort by comparison then key, each as `comparison|key`; counter
 * keys sort by name, each as `counter|key`; all joined by newline. The detail is not hashed: the digest pins which mismatches
 * exist and which counters are cached, so any change in them refuses a stale plan.
 */
export function planDigest(findings: readonly Finding[], counters: readonly string[]): string {
	const findingLines = [...findings]
		.sort((a, b) => (a.comparison < b.comparison ? -1 : a.comparison > b.comparison ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
		.map((finding) => `${finding.comparison}|${finding.key}`);
	const counterLines = [...counters].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((key) => `counter|${key}`);
	return createHash("sha256").update([...findingLines, ...counterLines].join("\n")).digest("hex");
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
 * The generation-class keys in the cache: the counters and the forget mark. A plan pins them and a repair re-reads them, so
 * any counter cut changes the digest. One `substrate:v1:gen*` scan, filtered by class. `truncated` is true when the scan did
 * not complete; a partial set is never pinned or compared.
 */
export async function scanCounters(cache: Pick<ReadThroughCache, "scanKeys">): Promise<{ keys: string[]; truncated: boolean }> {
	const scan = await cache.scanKeys(`${CACHE_PREFIX}:gen*`, FLUSH_SCAN_LIMIT);
	const keys = scan.keys.filter((key) => classOf(key) === "gen").sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	return { keys, truncated: scan.truncated };
}

/**
 * The generation orphans a plan may act on. A truncated graph list cannot confirm that a counter's graph is absent from
 * `graph_index`, so no orphan is named: a healthy counter past the cap would otherwise read as one.
 */
function confirmedOrphans(report: Report): string[] {
	if (report.truncated["index.graphs"]) return [];
	return report.findings.filter((finding) => finding.comparison === "generation").map((finding) => finding.key);
}

/**
 * The plan for a report. It lists one flush item when the report has generation findings, and none otherwise. The digest
 * is taken over every finding and every counter key, so a plan goes stale when any comparison changes or a counter is removed.
 */
export function planFromReport(report: Report, now: Date, counters: readonly string[]): Plan {
	const orphans = confirmedOrphans(report);
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
		report_digest: planDigest(report.findings, counters),
		items,
	};
}

/**
 * Why a plan may not be run, or null when it names at least one flush and every item is that flush. The digest pins what the report
 * found; this pins what the plan asks to remove. Messages never echo a value from the plan file.
 */
function planRefusal(items: readonly PlanItem[], liveOrphans: ReadonlySet<string>): string | null {
	if (items.length === 0) return "the plan names no action; re-plan before repairing";
	for (const item of items) {
		if (typeof item !== "object" || item === null || item.action !== "flush-derived-cache") {
			return "the plan names an action this repair does not run; re-plan before repairing";
		}
		if (item.match !== FLUSH_MATCH) return `the plan names a match other than ${FLUSH_MATCH}; re-plan before repairing`;
		if (!Array.isArray(item.orphans) || item.orphans.length === 0) {
			return "the plan's flush names no supporting orphan; re-plan before repairing";
		}
		if (item.orphans.some((orphan) => !liveOrphans.has(orphan))) {
			return "the plan names an orphan that the fresh report does not list as a live generation orphan; re-plan before repairing";
		}
	}
	return null;
}

/**
 * The scanned keys sorted into the three passes, in the order a flush runs them: answers and snapshots, generation counters,
 * then the forget mark. Budget, embedding and unnamed keys are in none of them and are never removed.
 */
function flushPasses(scanned: readonly string[]): string[][] {
	const answers: string[] = [];
	const counters: string[] = [];
	const mark: string[] = [];
	for (const key of scanned) {
		const cls = classOf(key);
		if (key === FORGET_MARK_KEY) mark.push(key);
		else if (cls === "gen") counters.push(key);
		else if (cls !== null && FLUSH_ANSWER_CLASSES.includes(cls)) answers.push(key);
	}
	return [answers, counters, mark];
}

/**
 * The first `limit` keys of the passes, taken in pass order. A run that stops at the bound has finished every earlier pass, so
 * no counter goes while an answer it depends on remains, and the mark goes only after every counter.
 */
function boundPasses(passes: readonly string[][], limit: number): string[][] {
	let budget = limit;
	return passes.map((pass) => {
		const taken = pass.slice(0, budget);
		budget -= taken.length;
		return taken;
	});
}

/**
 * Run a plan. It re-runs the read-only report first, then refuses when the graph list is truncated, when the findings or the cache counters differ from the
 * plan's digest, when no generation orphan remains, when the plan is empty, or when any plan item is not the flush this repair runs: another action,
 * another match than `substrate:v1:*`, an orphan the fresh report does not list as live, or a flush that names no orphan. It then scans
 * `substrate:v1:*` once and refuses when
 * the scan cannot complete, so a partial key list is never flushed. The scan is read-only and runs in every mode, so a dry run
 * and a refusal both report the planned keys. Without `execute` it writes nothing. With `execute` it needs `serverStopped`,
 * and refuses without it. An execute removes the first RECONCILE_MAX_ITEMS keys of the ordered list, in three passes: answers
 * and snapshots, then generation counters, then the forget mark. A failure part way is returned in `error`, with the count
 * removed so far; a failed flush keeps every counter it has not reached.
 */
export async function executePlan(
	plan: Plan,
	deps: ReconcileDeps & { cache: Pick<ReadThroughCache, "scanKeys" | "unlinkKeys"> },
	options: { execute: boolean; serverStopped: boolean },
): Promise<RepairResult> {
	const live = await runReport(deps);
	let liveCounters: { keys: string[]; truncated: boolean };
	try {
		liveCounters = await scanCounters(deps.cache);
	} catch (cause) {
		const error = failureReason(cause);
		return repairOutcome({ executed: false, refused: false, reason: `failed: the cache counters could not be read: ${error}`, error });
	}
	if (liveCounters.truncated) {
		return repairOutcome({
			executed: false,
			refused: true,
			reason: "refused: the cache counters could not be read completely (the cache is off, or the prefix holds more than 1000000 keys); nothing was removed",
		});
	}
	if (live.truncated["index.graphs"]) {
		return repairOutcome({
			executed: false,
			refused: true,
			reason: "refused: the index's graph list is truncated, so a generation counter cannot be confirmed as an orphan; nothing was removed",
		});
	}
	if (planDigest(live.findings, liveCounters.keys) !== plan.report_digest) {
		return repairOutcome({
			executed: false,
			refused: true,
			reason: "refused: the findings or the cache counters changed since the plan was made (digest mismatch); re-plan before repairing",
		});
	}
	const orphans = live.findings.filter((finding) => finding.comparison === "generation");
	if (orphans.length === 0) {
		return repairOutcome({ executed: false, refused: true, reason: "refused: no generation orphans remain, so there is nothing to repair" });
	}
	const refusal = planRefusal(plan.items, new Set(orphans.map((finding) => finding.key)));
	if (refusal !== null) return repairOutcome({ executed: false, refused: true, reason: `refused: ${refusal}` });

	let passes: string[][];
	try {
		const scan = await deps.cache.scanKeys(FLUSH_MATCH, FLUSH_SCAN_LIMIT);
		if (scan.truncated) {
			return repairOutcome({
				executed: false,
				refused: true,
				reason: "refused: the cache keys could not be read completely (the cache is off, or the prefix holds more than 1000000 keys); nothing was removed",
			});
		}
		passes = flushPasses(scan.keys);
	} catch (cause) {
		const error = failureReason(cause);
		return repairOutcome({ executed: false, refused: false, reason: `failed: the flush of ${FLUSH_MATCH} stopped: ${error}`, error });
	}
	const planned = passes.reduce((total, pass) => total + pass.length, 0);
	const bounded = boundPasses(passes, RECONCILE_MAX_ITEMS);
	const willRemain = planned - RECONCILE_MAX_ITEMS;

	if (!options.execute) {
		const removing = Math.min(planned, RECONCILE_MAX_ITEMS);
		return repairOutcome({
			executed: false,
			refused: false,
			planned,
			reason: `dry run: ${orphans.length} generation orphan(s) confirmed; would remove ${removing} of ${planned} planned key(s) of ${FLUSH_MATCH} (answers and snapshots, then generation counters, then the forget mark; budget and embedding keys stay)${willRemain > 0 ? `; ${willRemain} would be left for a later run` : ""}. Nothing written; re-run with --execute --server-stopped to flush`,
		});
	}
	if (!options.serverStopped) {
		return repairOutcome({
			executed: false,
			refused: true,
			planned,
			reason: "refused: a flush needs the server stopped (--server-stopped); a live server can write a snapshot between the passes",
		});
	}

	let removed = 0;
	// One pass over one group. `removed` takes each batch as its callback lands, so a later failure keeps the earlier batches
	// counted; a pass that finishes sets the total to the count it returned.
	const unlinkPass = async (keys: readonly string[]): Promise<void> => {
		if (keys.length === 0) return;
		const before = removed;
		const count = await deps.cache.unlinkKeys(keys, (batch) => {
			removed += batch;
		});
		removed = before + count;
	};
	try {
		const [answers, counters, mark] = bounded;
		await unlinkPass(answers ?? []);
		await unlinkPass(counters ?? []);
		await unlinkPass(mark ?? []);
	} catch (cause) {
		// A failed pass stops the flush. A failure among the answers leaves every counter and the mark in place; a failure among
		// the counters leaves the mark in place. `removed` holds the keys removed before the failure.
		const error = failureReason(cause);
		return repairOutcome({
			executed: false,
			refused: false,
			planned,
			removed,
			reason: `failed: the flush of ${FLUSH_MATCH} stopped after ${removed} of ${planned} planned key(s): ${error}`,
			error,
		});
	}
	const remaining = planned - removed;
	return repairOutcome({
		executed: true,
		refused: false,
		planned,
		removed,
		reason:
			remaining === 0
				? `flushed ${removed} key(s) in three passes: answers and snapshots, then generation counters, then the forget mark; budget and embedding keys untouched; the cache is cold until it refills`
				: `flushed ${removed} of ${planned} planned key(s), at most ${RECONCILE_MAX_ITEMS} per run; ${remaining} left: run plan again, then repair again, to finish; budget and embedding keys untouched`,
	});
}
