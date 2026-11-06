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
import { buildReport, compareGenerations, compareLeases, compareMemory, type Finding, type Layer, type Report } from "./reconcile.ts";

/** Row caps for one run. A capped read reports `truncated`, and a truncated report is never clean. */
interface ReconcileCaps {
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

	// The cache layer. An off cache scans nothing: every scan comes back empty and truncated. A live scan that truncates
	// holds keys past its cap, so it always has at least one key. Empty and truncated is therefore the off cache's answer.
	const scans: Array<[string, { keys: string[]; truncated: boolean }]> = [];
	for (const klass of CACHE_CLASSES) {
		scans.push([`cache.${klass}`, await deps.cache.scanKeys(`${CACHE_PREFIX}:${klass}:*`, caps.cacheKeys)]);
	}
	const generations = await deps.cache.scanKeys(`${GENERATION_PREFIX}*`, caps.cacheKeys);
	scans.push(["cache.gen:graph", generations]);
	const cacheOff = scans.every(([, scan]) => scan.keys.length === 0 && scan.truncated);
	// An off cache has no counts to report. Its classes stay truncated, so the run is never clean, and the layer is named unchecked.
	for (const [name, scan] of scans) {
		if (!cacheOff) counts[name] = scan.keys.length;
		truncated[name] = scan.truncated;
	}
	const uncheckedLayers: Layer[] = cacheOff ? ["cache"] : [];
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
		unchecked_layers: uncheckedLayers,
		findings,
	});
}
