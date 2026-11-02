/**
 * The read-only reconcile run (Phase 78, D78-2 to D78-4, D78-7, D78-9). It reads the ledger, the index and the cache, compares
 * them with the pure core, and returns the report. It writes nothing: its calls are the ledger's `queryEvents`, the index's
 * SELECTs and the cache's SCANs.
 */
import { CACHE_CLASSES, CACHE_PREFIX, type ReadThroughCache } from "./cache.ts";
import {
	readIndexGraphIds,
	readIndexLeases,
	readIndexMemoryIds,
	readLedgerLatestLeases,
	readLedgerLeases,
	readLedgerMemoryIds,
	type IndexReader,
	type LedgerReader,
} from "./reconcile-read.ts";
import { buildReport, compareGenerations, compareLeases, compareMemory, type Finding, type Report } from "./reconcile.ts";

/** Row caps for one run. A capped read reports `truncated`, and a truncated report is never clean. */
export interface ReconcileCaps {
	/** Ledger events read per kind in the window. `queryEvents` itself stops at 500. */
	ledgerRows: number;
	/** Ledger lookups for held nodes the window did not see: one `queryEvents` each. Past the cap the read is truncated. */
	ledgerLookups: number;
	/** Index rows per read: holds, memory ids and graph ids. */
	indexRows: number;
	/** Cache keys per scan. */
	cacheKeys: number;
}

/** The caps a run uses when the caller names none. */
export const DEFAULT_RECONCILE_CAPS: ReconcileCaps = { ledgerRows: 500, ledgerLookups: 200, indexRows: 5_000, cacheKeys: 10_000 };

/** What one run reads from. `cache` needs only `scanKeys`, so a fake is one method. */
export interface ReconcileDeps {
	ledger: LedgerReader;
	index: IndexReader;
	cache: Pick<ReadThroughCache, "scanKeys">;
	now: Date;
	windowHours: number;
	caps: ReconcileCaps;
}

const MS_PER_HOUR = 3_600_000;
/** The generation counters of graphs: `substrate:v1:gen:graph:<id>`. */
const GENERATION_PREFIX = `${CACHE_PREFIX}:gen:graph:`;

/** Run the reconcile once over the window ending at `deps.now`. Reads only. */
export async function runReport(deps: ReconcileDeps): Promise<Report> {
	const { caps } = deps;
	const sinceIso = new Date(deps.now.getTime() - deps.windowHours * MS_PER_HOUR).toISOString();
	const counts: Record<string, number> = {};
	const truncated: Record<string, boolean> = {};

	const ledgerLeases = await readLedgerLeases(deps.ledger, sinceIso, caps.ledgerRows);
	counts["ledger.lease_transitions"] = ledgerLeases.events;
	truncated["ledger.leases"] = ledgerLeases.truncated;

	const ledgerMemory = await readLedgerMemoryIds(deps.ledger, sinceIso, caps.ledgerRows);
	counts["ledger.memory_writes"] = ledgerMemory.events;
	truncated["ledger.memory"] = ledgerMemory.truncated;

	const indexLeases = await readIndexLeases(deps.index, [...ledgerLeases.nodes.values()], caps.indexRows);
	counts["index.holds"] = indexLeases.nodes.size;
	truncated["index.holds"] = indexLeases.truncated;

	// A hold granted before the window is still held by the index, but the window cannot see its grant. Look up the newest
	// transition of each such node, unbounded in time, so it is not reported as drift.
	const unseen = [...indexLeases.nodes].filter(([key]) => !ledgerLeases.value.has(key)).map(([, node]) => node);
	const lookups = await readLedgerLatestLeases(deps.ledger, unseen, caps.ledgerLookups);
	truncated["ledger.lease_lookups"] = lookups.truncated;
	const ledgerView = new Map([...ledgerLeases.value, ...lookups.value]);

	const indexMemory = await readIndexMemoryIds(deps.index, sinceIso, caps.indexRows);
	counts["index.memory_rows"] = indexMemory.value.size;
	truncated["index.memory"] = indexMemory.truncated;
	const uncheckedMemoryRows = await deps.index.reconcileMemoryRowsBefore(sinceIso);

	const indexGraphs = await readIndexGraphIds(deps.index, caps.indexRows);
	counts["index.graphs"] = indexGraphs.value.size;
	truncated["index.graphs"] = indexGraphs.truncated;

	for (const klass of CACHE_CLASSES) {
		const scan = await deps.cache.scanKeys(`${CACHE_PREFIX}:${klass}:*`, caps.cacheKeys);
		counts[`cache.${klass}`] = scan.keys.length;
		truncated[`cache.${klass}`] = scan.truncated;
	}
	const generations = await deps.cache.scanKeys(`${GENERATION_PREFIX}*`, caps.cacheKeys);
	counts["cache.gen:graph"] = generations.keys.length;
	truncated["cache.gen:graph"] = generations.truncated;
	const generationGraphIds = new Set(generations.keys.map((key) => key.slice(GENERATION_PREFIX.length)));

	const findings: Finding[] = [
		...compareLeases(ledgerView, indexLeases.value),
		...compareMemory(indexMemory.value, ledgerMemory.value),
		...compareGenerations(generationGraphIds, indexGraphs.value),
	];

	return buildReport({
		generated_at: deps.now.toISOString(),
		window_hours: deps.windowHours,
		counts,
		truncated,
		unchecked_memory_rows: uncheckedMemoryRows,
		findings,
	});
}
