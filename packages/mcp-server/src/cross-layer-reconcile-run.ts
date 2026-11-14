#!/usr/bin/env bun
/**
 * Scheduled cross-layer reconcile (phase 78): the ledger, the index and the cache must agree about memory forgets.
 *
 *   bun packages/mcp-server/src/cross-layer-reconcile-run.ts [--json]
 *
 * The daily tick behind `infra/vps/substrate-cross-layer-reconcile.timer`. It judges the last `RECONCILE_WINDOW_MS` of ledger
 * notes, settled `INGEST_LAG_MS` behind now, against the index and the cache, then prints the per-layer counts, the coverage
 * and the first mismatching key (`--json` prints the whole report object instead).
 *
 * Lives in this package, like `index-sweep-run.ts` and `anchor-run.ts`: only mcp-server reaches the Greptime client
 * (`store-lock.test.ts`), and the ledger port below is built from it.
 *
 * Read-only. The ledger port built here refuses every write, so a clean run and a dirty run both leave all three layers as
 * they were. A repair is a separate, operator-confirmed plan: `planRepair` / `applyRepair` for the forget pair, and
 * `planCacheIndexRepair` / `applyCacheIndexRepair` for the cache -> index pair (both run from `cross-layer-reconcile-repair-run.ts`).
 * This tick never plans or applies either.
 *
 * Exit codes: 0 every judged note matched and the read was complete; 3 the run found mismatches (named on stdout, and they
 * outrank an incomplete read); 1 the run was not clean and found no mismatch: a layer could not be read, or the read was
 * incomplete (stderr names why); 2 usage: `GREPTIME_URL` or `SUBSTRATE_PG_URL` is not set, or an unknown argument.
 */
import { createReadThroughCache, forgetMarkTtlS } from "./cache.ts";
import { type SubstrateConfig, loadConfig } from "./config.ts";
import {
	type CacheIndexRepairPorts,
	type CacheIndexReport,
	type IndexLedgerReport,
	type PairDeps,
	type PairOptions,
	type PairReport,
	applyCacheIndexRepair,
	pairCacheFrom,
	pairIndexFrom,
	pairLedgerFrom,
	planCacheIndexRepair,
	reconcileCacheIndex,
	runPairReconcile,
} from "./cross-layer-reconcile-pairs.ts";
import {
	type CrossLayerReport,
	type LedgerReads,
	type NoteWriter,
	type ReconcileCache,
	type ReconcileDeps,
	type ReconcileIndex,
	type ReconcileOptions,
	type ReconcileRun,
	ledgerFromSubstrate,
	runScheduledReconcile,
} from "./cross-layer-reconcile.ts";
import { GreptimeClient, INGEST_LAG_MS } from "./greptime.ts";
import { IndexStore } from "./index-store.ts";

/** A day and an hour: the timer runs daily, so the hour overlaps the previous run and a late tick still judges every note. */
export const RECONCILE_WINDOW_MS = 25 * 3_600_000;

export const EXIT = { clean: 0, failed: 1, usage: 2, mismatch: 3 } as const;

const USAGE = "usage: cross-layer-reconcile-run.ts [--json]\n";

export interface TickResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** The judged window and settle lag, with the forget mark's lifetime the way `Substrate.memoryForget` sets it. */
export function reconcileOptionsFor(config: Pick<SubstrateConfig, "briefSnapshotTtlS">): ReconcileOptions {
	return { windowMs: RECONCILE_WINDOW_MS, settleMs: INGEST_LAG_MS, markTtlS: forgetMarkTtlS(config.briefSnapshotTtlS) };
}

/** The ledger's write path for this tick. Nothing in it calls `emitNote`; if something ever did, the tick would fail loudly. */
const READ_ONLY_WRITER: NoteWriter = {
	async emit() {
		throw new Error("the scheduled cross-layer reconcile is read-only; it never writes a ledger note");
	},
};

/** The reconcile's ports, wired to the real stores: the ledger's reads, the index, the cache. */
export function scheduledDeps(stores: { reads: LedgerReads; index: ReconcileIndex; cache: ReconcileCache }, now: () => number): ReconcileDeps {
	return { ledger: ledgerFromSubstrate("substrate", stores.reads, READ_ONLY_WRITER), index: stores.index, cache: stores.cache, now };
}

function cacheLine(cache: CrossLayerReport["layers"]["cache"]): string {
	const at = cache.atMs === null ? "" : ` at ${new Date(cache.atMs).toISOString()}`;
	return `${cache.state}${at}${cache.checked ? "" : " (not checked)"}`;
}

/** Why a read is not complete, in the words the journal and the exit message use. Empty when every note was judged. */
function incompleteReasons(coverage: CrossLayerReport["coverage"]): string[] {
	const reasons: string[] = [];
	if (coverage.ledgerTruncated) reasons.push("ledger window truncated");
	if (coverage.keysTruncated) reasons.push("key set truncated");
	if (coverage.malformedNotes > 0) reasons.push(`${coverage.malformedNotes} malformed notes`);
	if (coverage.partialNotes > 0) reasons.push(`${coverage.partialNotes} partial forget notes`);
	return reasons;
}

/** The text the journal shows: per-layer counts, the coverage, and the first mismatch by key. */
export function renderReport(report: CrossLayerReport): string {
	const { ledger, index, cache } = report.layers;
	const { coverage, mismatches } = report;
	const lines = [
		`cross-layer reconcile ${report.window.since} .. ${report.window.until}`,
		`  ledger: ${ledger.forgetNotes} forget notes, ${ledger.notesWithMarks} with marks, ${ledger.namedEntries} named entries`,
		`  index: ${index.forgotten} forgotten, ${index.superseded} superseded elsewhere, ${index.absent} absent, ${index.inForce} in force`,
		`  cache: ${cacheLine(cache)}`,
		`  coverage: ${coverage.complete ? "complete" : "incomplete"}${incompleteReasons(coverage).map((reason) => `, ${reason}`).join("")}`,
		`  mismatches: ${mismatches.count}`,
	];
	if (mismatches.first !== null) lines.push(`  first: ${mismatches.first.layer} ${mismatches.first.key} (${mismatches.first.reason})`);
	return `${lines.join("\n")}\n`;
}

/** One tick: run the reconcile once and turn its outcome into the journal text and the exit code. */
export async function runTick(deps: ReconcileDeps, options: ReconcileOptions, json: boolean): Promise<TickResult> {
	const run: ReconcileRun = await runScheduledReconcile(deps, options);
	if (!run.ok) {
		return { code: EXIT.failed, stdout: "", stderr: `[cross-layer-reconcile] run failed (${run.reason}): ${run.detail}\n` };
	}
	const stdout = json ? `${JSON.stringify(run.report)}\n` : renderReport(run.report);
	if (run.report.mismatches.count > 0) return { code: EXIT.mismatch, stdout, stderr: "" };
	const reasons = incompleteReasons(run.report.coverage);
	if (reasons.length > 0) {
		return { code: EXIT.failed, stdout, stderr: `[cross-layer-reconcile] read incomplete (${reasons.join(", ")}): not every note was judged, so this run is not clean\n` };
	}
	return { code: EXIT.clean, stdout, stderr: "" };
}

/** The env var that names the graphs the pair comparisons judge, comma separated. Unset or blank judges none. */
export const RECONCILE_GRAPHS_ENV = "SUBSTRATE_RECONCILE_GRAPHS";
/** More graphs than this is refused at boot, so a tick never silently covers only part of the list. */
export const RECONCILE_GRAPHS_MAX = 50;

export type GraphIdsParse = { ok: true; ids: string[] } | { ok: false; problem: string };

/** Parses `SUBSTRATE_RECONCILE_GRAPHS`. Ids are trimmed and de-duplicated. An empty entry or too many graphs is a problem, never a partial list. */
export function graphIdsFrom(raw: string | undefined): GraphIdsParse {
	if (raw === undefined || raw.trim() === "") return { ok: true, ids: [] };
	const ids = [...new Set(raw.split(",").map((id) => id.trim()))];
	if (ids.some((id) => id === "")) return { ok: false, problem: `${RECONCILE_GRAPHS_ENV} holds an empty graph id` };
	if (ids.length > RECONCILE_GRAPHS_MAX) return { ok: false, problem: `${RECONCILE_GRAPHS_ENV} names ${ids.length} graphs; the maximum is ${RECONCILE_GRAPHS_MAX}` };
	return { ok: true, ids };
}

export interface PairsOutcome {
	reports: Array<{ indexLedger: IndexLedgerReport; cacheIndex: CacheIndexReport }>;
	mismatches: number;
	incomplete: string[];
}

/** Both pairs for each named graph. Read-only: `runPairReconcile` never repairs. A layer that cannot be read is incomplete, never drift. */
export async function runPairsTick(deps: PairDeps, graphIds: string[], options: PairOptions): Promise<PairsOutcome> {
	const reports: PairsOutcome["reports"] = [];
	const incomplete: string[] = [];
	let mismatches = 0;
	for (const graphId of graphIds) {
		const pair = await runPairReconcile(graphId, deps, options);
		reports.push(pair);
		mismatches += pair.indexLedger.mismatches.count + pair.cacheIndex.mismatches.count;
		for (const report of [pair.indexLedger, pair.cacheIndex]) {
			if (report.verdict === "clean" || report.verdict === "drift") continue;
			incomplete.push(`${graphId} ${report.pair}: ${report.verdict}${report.reason ? ` (${report.reason})` : ""}`);
		}
	}
	return { reports, mismatches, incomplete };
}

/** One line per pair report: its verdict, its mismatch count, and its first mismatching key (with its surface, for the cache). */
export function renderPairLine(report: PairReport): string {
	const first = report.mismatches.first;
	const surface = first !== null && "surface" in first ? ` surface=${first.surface}` : "";
	return `pair ${report.pair} graph=${report.graphId}: ${report.verdict}, mismatches=${report.mismatches.count}${first ? ` first=${first.key}${surface}` : ""}\n`;
}

/** The text the journal shows for the pairs: one line per graph and pair, with the first mismatching key (and its surface, for the cache). */
export function renderPairs(outcome: PairsOutcome): string {
	return outcome.reports.flatMap((pair) => [pair.indexLedger, pair.cacheIndex]).map(renderPairLine).join("");
}

/** The exit code of a tick that ran the forget pair and the graph pairs. Mismatches outrank an incomplete read, as in `runTick`. */
export function combineExit(forget: TickResult, pairs: PairsOutcome | null): number {
	if (forget.code === EXIT.mismatch || (pairs !== null && pairs.mismatches > 0)) return EXIT.mismatch;
	if (forget.code !== EXIT.clean || (pairs !== null && pairs.incomplete.length > 0)) return EXIT.failed;
	return EXIT.clean;
}

/** The arguments after `--cache-index`: `GRAPH_ID` plans the repair; `--apply PLAN_ID --confirm` applies a printed plan. */
export type CacheIndexArgs = { mode: "cache-index-plan"; graphId: string } | { mode: "cache-index-apply"; planId: string } | { mode: "refused"; problem: string };

const GRAPH_ID = /^\S{1,200}$/;

/** Anything other than the two forms above is refused before a store is opened. */
export function parseCacheIndexArgs(argv: readonly string[]): CacheIndexArgs {
	const [first, ...rest] = argv;
	if (first === "--apply") {
		const [planId, confirm, ...extra] = rest;
		if (planId === undefined || planId.startsWith("--")) return { mode: "refused", problem: "--apply needs the PLAN_ID that a --cache-index run printed" };
		if (confirm !== "--confirm") return { mode: "refused", problem: "--apply writes the repair and needs --confirm after the plan id" };
		if (extra.length > 0) return { mode: "refused", problem: "unknown arguments after --confirm" };
		return { mode: "cache-index-apply", planId };
	}
	if (rest.length === 0 && first !== undefined && GRAPH_ID.test(first) && !first.startsWith("--")) return { mode: "cache-index-plan", graphId: first };
	return { mode: "refused", problem: "--cache-index takes one GRAPH_ID to plan, or --apply PLAN_ID --confirm to apply a printed plan" };
}

/**
 * The cache-index repair's plan run: one read of the graph's cache and index, then ONE `reconcile.plan.cache-index` note when that read
 * is drift. Repairs nothing. An incomplete or unavailable read plans nothing and says why.
 */
export async function runCacheIndexPlan(ports: CacheIndexRepairPorts, graphId: string): Promise<TickResult> {
	const report = await reconcileCacheIndex(graphId, ports);
	const line = renderPairLine(report);
	if (report.verdict === "incomplete" || report.verdict === "unavailable") {
		const reason = report.reason === null ? "" : ` (${report.reason})`;
		return { code: EXIT.failed, stdout: line, stderr: `[cross-layer-reconcile] cache-index read is ${report.verdict}${reason}: nothing was planned\n` };
	}
	const run = await planCacheIndexRepair(ports.ledger, report);
	if (!run.ok) return { code: EXIT.failed, stdout: line, stderr: `[cross-layer-reconcile] cache-index plan failed (${run.reason}): ${run.detail}\n` };
	if (run.planId === null) return { code: EXIT.clean, stdout: `${line}nothing to repair: the cache and the index agree for graph ${graphId}\n`, stderr: "" };
	const bumps = run.items.map((item) => `  bump ${item.key}\n`).join("");
	return {
		code: EXIT.mismatch,
		stdout: `${line}plan ${run.planId}: ${run.items.length} bump(s) recorded as a reconcile.plan.cache-index note; nothing repaired yet\n${bumps}apply with: cross-layer-reconcile-repair-run.ts --cache-index --apply ${run.planId} --confirm\n`,
		stderr: "",
	};
}

/** The cache-index repair's apply: the confirmed plan, re-checked against a fresh read, then its two bumps and nothing else. */
export async function runCacheIndexApply(ports: CacheIndexRepairPorts, planId: string): Promise<TickResult> {
	const run = await applyCacheIndexRepair(ports, { planId, confirm: planId });
	if (!run.ok) return { code: EXIT.failed, stdout: "", stderr: `[cross-layer-reconcile] cache-index apply failed (${run.reason}): ${run.detail}\n` };
	return { code: EXIT.clean, stdout: `applied cache-index plan ${run.planId}: bumped ${run.bumped.join(", ")}\n`, stderr: "" };
}

async function main(argv: string[]): Promise<number> {
	for (const arg of argv) {
		if (arg !== "--json") {
			process.stderr.write(`unknown argument ${arg}\n${USAGE}`);
			return EXIT.usage;
		}
	}
	const config = loadConfig();
	if (!config.greptime) {
		process.stderr.write(`GREPTIME_URL is not set\n${USAGE}`);
		return EXIT.usage;
	}
	if (!config.postgresUrl) {
		process.stderr.write(`SUBSTRATE_PG_URL is not set\n${USAGE}`);
		return EXIT.usage;
	}
	const graphs = graphIdsFrom(process.env[RECONCILE_GRAPHS_ENV]);
	if (!graphs.ok) {
		process.stderr.write(`${graphs.problem}\n${USAGE}`);
		return EXIT.usage;
	}
	const greptime = new GreptimeClient(config.greptime, { ledger: config.ledger });
	const index = new IndexStore(config.postgresUrl);
	// With the cache off the mark reads `disabled` and the cache layer is reported as not checked, never as drift.
	const cache = createReadThroughCache(config);
	try {
		const deps = scheduledDeps({ reads: greptime, index, cache }, () => Date.now());
		const options = reconcileOptionsFor(config);
		const pairDeps: PairDeps = { ledger: pairLedgerFrom(greptime), index: pairIndexFrom(index), cache: pairCacheFrom(cache.redisClient()), now: () => Date.now() };
		const json = argv.includes("--json");
		const forget = await runTick(deps, options, json);
		const pairs = graphs.ids.length === 0 ? null : await runPairsTick(pairDeps, graphs.ids, { settleMs: options.settleMs });
		process.stdout.write(forget.stdout);
		process.stderr.write(forget.stderr);
		if (pairs === null) process.stderr.write(`[cross-layer-reconcile] pairs not run: ${RECONCILE_GRAPHS_ENV} is unset\n`);
		else if (json) process.stdout.write(`${JSON.stringify({ pairs: pairs.reports, mismatches: pairs.mismatches, incomplete: pairs.incomplete })}\n`);
		else process.stdout.write(renderPairs(pairs));
		return combineExit(forget, pairs);
	} finally {
		await index.close().catch(() => undefined);
	}
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
