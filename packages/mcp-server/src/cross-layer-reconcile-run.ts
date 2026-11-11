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
 * they were. A repair is a separate, operator-confirmed plan (`planRepair` / `applyRepair`); this tick never plans one.
 *
 * Exit codes: 0 the run found no mismatch; 3 it found mismatches (named on stdout); 1 a layer could not be read, so nothing
 * was judged; 2 usage: `GREPTIME_URL` or `SUBSTRATE_PG_URL` is not set, or an unknown argument.
 */
import { createReadThroughCache, forgetMarkTtlS } from "./cache.ts";
import { type SubstrateConfig, loadConfig } from "./config.ts";
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

/** The text the journal shows: per-layer counts, the coverage, and the first mismatch by key. */
export function renderReport(report: CrossLayerReport): string {
	const { ledger, index, cache } = report.layers;
	const { coverage, mismatches } = report;
	const lines = [
		`cross-layer reconcile ${report.window.since} .. ${report.window.until}`,
		`  ledger: ${ledger.forgetNotes} forget notes, ${ledger.notesWithMarks} with marks, ${ledger.namedEntries} named entries`,
		`  index: ${index.forgotten} forgotten, ${index.superseded} superseded elsewhere, ${index.absent} absent, ${index.inForce} in force`,
		`  cache: ${cacheLine(cache)}`,
		`  coverage: ${coverage.complete ? "complete" : "incomplete"}` +
			(coverage.ledgerTruncated ? ", ledger window truncated" : "") +
			(coverage.keysTruncated ? ", key set truncated" : "") +
			(coverage.malformedNotes > 0 ? `, ${coverage.malformedNotes} malformed notes` : "") +
			(coverage.partialNotes > 0 ? `, ${coverage.partialNotes} partial forget notes` : ""),
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
	return { code: run.report.mismatches.count === 0 ? EXIT.clean : EXIT.mismatch, stdout, stderr: "" };
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
	const greptime = new GreptimeClient(config.greptime, { ledger: config.ledger });
	const index = new IndexStore(config.postgresUrl);
	// With the cache off the mark reads `disabled` and the cache layer is reported as not checked, never as drift.
	const cache = createReadThroughCache(config);
	try {
		const deps = scheduledDeps({ reads: greptime, index, cache }, () => Date.now());
		const result = await runTick(deps, reconcileOptionsFor(config), argv.includes("--json"));
		process.stdout.write(result.stdout);
		process.stderr.write(result.stderr);
		return result.code;
	} finally {
		await index.close().catch(() => undefined);
	}
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
