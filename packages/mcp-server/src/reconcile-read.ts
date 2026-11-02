/**
 * Read-only readers for the cross-layer reconcile (Phase 78, D78-2 to D78-4). Each turns one layer's rows into the shape
 * `reconcile.ts` compares: lease holds keyed `graph_id/node_id`, memory entry ids and graph ids. Nothing here writes.
 *
 * The ledger is bounded by time (`since`) and by a row cap per kind. `queryEvents` itself stops at 500 rows, so a busy window
 * reads as truncated rather than as a partial list passed off as whole. A read that stops at its cap says so.
 */
import { epochMsAnyUnit, MAX_QUERY_LIMIT, type GreptimeClient } from "./greptime.ts";
import type { IndexStore, ReconcileNodeHold } from "./index-store.ts";
import type { LeaseHold } from "./reconcile.ts";

/** The ledger reads: `queryEvents` only, so a fake needs one method. */
export type LedgerReader = Pick<GreptimeClient, "queryEvents">;

/** The index reads the reconcile makes. Every one is a SELECT. */
export type IndexReader = Pick<
	IndexStore,
	"reconcileHolds" | "reconcileHeldNodes" | "reconcileMemoryIds" | "reconcileGraphIds" | "reconcileMemoryRowsBefore"
>;

/** A lease key's node: the pair the index is read by. The key is `graph_id/node_id`. */
export interface LeaseNode {
	graph_id: string;
	node_id: string;
}

/** A ledger read: its value, whether it stopped at its cap, and how many matching events it saw. */
export interface LedgerRead<T> {
	value: T;
	truncated: boolean;
	events: number;
}

/** A ledger lease read: the latest transition per node, and the node behind each key. */
export interface LedgerLeaseRead extends LedgerRead<Map<string, LeaseHold>> {
	nodes: Map<string, LeaseNode>;
}

/** An index read: its value and whether it stopped at its cap. */
export interface IndexRead<T> {
	value: T;
	truncated: boolean;
}

/** An index lease read: each ledger node's hold (null when free), and the nodes the index currently holds. */
export interface IndexLeaseRead extends IndexRead<Map<string, LeaseHold>> {
	nodes: Map<string, LeaseNode>;
}

type Row = Record<string, unknown>;

/** Ledger kinds that carry lease transitions: a grant is a `claim` (a `warning` when stolen), a release a `note` (a `warning` when forced), an expiry a `warning`. */
const LEASE_KINDS = ["claim", "warning", "note"] as const;
/** Ledger kinds that carry accepted memory writes: a verified write is a `note`, one the read-back could not verify is a `warning`. */
const MEMORY_KINDS = ["note", "warning"] as const;
/** Payload actions that give a hold. */
const GRANT_ACTIONS: Record<string, true> = { granted: true, reclaimed: true, stolen: true };
/** Payload actions that leave the key free. */
const FREE_ACTIONS: Record<string, true> = { released: true, forced: true, expired: true };
/** Rows read for one node when the window misses it. Heartbeats are silent, so this is ample for one node's transitions. */
const LOOKUP_LIMIT = 100;
/** Index keys per `reconcileHolds` call. */
const HOLD_BATCH = 500;

/** The `graph_id/node_id` key the lease comparison uses. */
export function leaseKey(node: LeaseNode): string {
	return `${node.graph_id}/${node.node_id}`;
}

/** A ledger row's payload as an object, or null. The column is JSON text; a payload that does not parse is not a transition. */
function payloadOf(row: Row): Record<string, unknown> | null {
	let raw: unknown = row.payload;
	if (typeof raw === "string") {
		try {
			raw = JSON.parse(raw);
		} catch {
			return null;
		}
	}
	return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

/** A row's ledger time in epoch ms; a row with no usable time sorts oldest. */
function timeOf(row: Row): number {
	const time = epochMsAnyUnit(row.ts);
	return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

/** Newest first by ledger time, then by id: the order a key's latest transition is found in. */
function newestFirst(a: Row, b: Row): number {
	const timeA = timeOf(a);
	const timeB = timeOf(b);
	if (timeA !== timeB) return timeA < timeB ? 1 : -1;
	const idA = String(a.id);
	const idB = String(b.id);
	return idA < idB ? 1 : idA > idB ? -1 : 0;
}

/** Rows of the given kinds since `sinceIso`, newest first. Each kind is capped at `cap` (and at the query's own 500); a kind that fills its cap is truncated. */
async function windowRows(ledger: LedgerReader, kinds: readonly string[], sinceIso: string, cap: number): Promise<{ rows: Row[]; truncated: boolean }> {
	const limit = Math.min(Math.max(1, Math.floor(cap)), MAX_QUERY_LIMIT);
	const rows: Row[] = [];
	let truncated = false;
	for (const kind of kinds) {
		const found = await ledger.queryEvents({ match: { kind }, since: sinceIso, order: "desc", limit, includePayload: true });
		rows.push(...found);
		if (found.length >= limit) truncated = true;
	}
	rows.sort(newestFirst);
	return { rows, truncated };
}

/** The lease transition one ledger row records: the node and the hold it leaves, or null when the row is not a transition. */
function transitionOf(row: Row): { node: LeaseNode; hold: LeaseHold } | null {
	if (typeof row.graph_id !== "string" || typeof row.node_id !== "string") return null;
	const payload = payloadOf(row);
	if (payload === null || typeof payload.action !== "string") return null;
	const node = { graph_id: row.graph_id, node_id: row.node_id };
	if (GRANT_ACTIONS[payload.action] === true) {
		return {
			node,
			hold: { surface: String(row.surface ?? ""), session_id: String(row.session_id ?? ""), epoch: Number(payload.lease_epoch) },
		};
	}
	if (FREE_ACTIONS[payload.action] === true) return { node, hold: null };
	return null;
}

/**
 * The ledger's lease view over the window: for each `graph_id/node_id`, the latest transition read since `sinceIso`.
 * A grant (`granted`, `reclaimed`, `stolen`) holds the key as the row's surface and session at the payload's `lease_epoch`;
 * a release, forced release or expiry leaves it free (null). `nodes` names every key read, so the index can be read for it.
 * `events` counts the transitions read.
 */
export async function readLedgerLeases(ledger: LedgerReader, sinceIso: string, cap: number): Promise<LedgerLeaseRead> {
	const { rows, truncated } = await windowRows(ledger, LEASE_KINDS, sinceIso, cap);
	const value = new Map<string, LeaseHold>();
	const nodes = new Map<string, LeaseNode>();
	let events = 0;
	for (const row of rows) {
		const transition = transitionOf(row);
		if (transition === null) continue;
		events += 1;
		const key = leaseKey(transition.node);
		if (value.has(key)) continue;
		value.set(key, transition.hold);
		nodes.set(key, transition.node);
	}
	return { value, nodes, truncated, events };
}

/**
 * The newest lease transition of each named node, with no time bound. The window read misses a hold granted before the
 * window, which the index still shows held; without this lookup every such hold would read as drift. One query per node,
 * at most {@link LOOKUP_LIMIT} rows each. A node whose rows run out before any transition is reported truncated.
 */
export async function readLedgerLatestLeases(ledger: LedgerReader, nodes: readonly LeaseNode[], maxLookups: number): Promise<LedgerLeaseRead> {
	const value = new Map<string, LeaseHold>();
	const found = new Map<string, LeaseNode>();
	// One ledger query per node. Past `maxLookups` the lookup stops and the read is truncated, so the run is never clean.
	const lookups = nodes.slice(0, maxLookups);
	let truncated = nodes.length > maxLookups;
	let events = 0;
	for (const node of lookups) {
		const rows = await ledger.queryEvents({
			match: { graph_id: node.graph_id, node_id: node.node_id },
			order: "desc",
			limit: LOOKUP_LIMIT,
			includePayload: true,
		});
		rows.sort(newestFirst);
		const key = leaseKey(node);
		let latest: LeaseHold | undefined;
		for (const row of rows) {
			const transition = transitionOf(row);
			if (transition === null) continue;
			events += 1;
			latest ??= transition.hold;
		}
		if (latest !== undefined) {
			value.set(key, latest);
			found.set(key, node);
		} else if (rows.length >= LOOKUP_LIMIT) {
			truncated = true;
		}
	}
	return { value, nodes: found, truncated, events };
}

/**
 * The entry ids of accepted memory writes since `sinceIso`: audit events of the memory kinds whose payload says
 * `outcome: "accepted"` and names an `entry_id`. An event without an entry id is not a write and is ignored.
 */
export async function readLedgerMemoryIds(ledger: LedgerReader, sinceIso: string, cap: number): Promise<LedgerRead<Set<string>>> {
	const { rows, truncated } = await windowRows(ledger, MEMORY_KINDS, sinceIso, cap);
	const value = new Set<string>();
	let events = 0;
	for (const row of rows) {
		const payload = payloadOf(row);
		if (payload === null || payload.outcome !== "accepted") continue;
		if (typeof payload.entry_id !== "string" || payload.entry_id.length === 0) continue;
		events += 1;
		value.add(payload.entry_id);
	}
	return { value, truncated, events };
}

/**
 * The index's lease view: the hold of every ledger node (null when the node is free or has no row), plus every node the
 * index holds. `nodes` names the nodes the index holds, so the caller can look the ledger up for those it did not see.
 */
export async function readIndexLeases(index: IndexReader, ledgerNodes: readonly LeaseNode[], cap: number): Promise<IndexLeaseRead> {
	const value = new Map<string, LeaseHold>();
	const nodes = new Map<string, LeaseNode>();
	for (const node of ledgerNodes) value.set(leaseKey(node), null);
	const rows: ReconcileNodeHold[] = [];
	for (let from = 0; from < ledgerNodes.length; from += HOLD_BATCH) {
		rows.push(...(await index.reconcileHolds(ledgerNodes.slice(from, from + HOLD_BATCH))));
	}
	const held = await index.reconcileHeldNodes(cap);
	rows.push(...held.rows);
	for (const row of rows) {
		const key = leaseKey(row);
		const hold = row.claimed_by === null ? null : { surface: row.claimed_by, session_id: row.claim_session ?? "", epoch: row.lease_epoch };
		value.set(key, hold);
		if (hold !== null) nodes.set(key, { graph_id: row.graph_id, node_id: row.node_id });
	}
	return { value, nodes, truncated: held.truncated };
}

/** The ids of `memory_entries` rows created since `sinceIso`, up to `cap`. */
export async function readIndexMemoryIds(index: IndexReader, sinceIso: string, cap: number): Promise<IndexRead<Set<string>>> {
	const read = await index.reconcileMemoryIds(sinceIso, cap);
	return { value: new Set(read.rows), truncated: read.truncated };
}

/** The ids in `graph_index`, up to `cap`. */
export async function readIndexGraphIds(index: IndexReader, cap: number): Promise<IndexRead<Set<string>>> {
	const read = await index.reconcileGraphIds(cap);
	return { value: new Set(read.rows), truncated: read.truncated };
}
