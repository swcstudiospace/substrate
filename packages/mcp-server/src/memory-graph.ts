import { redact } from "./redact.ts";

/** A ledger event as memory_search shows it: identity, placement and a bounded summary, no payload or hash. */
export interface ReducedEvent {
	id: string;
	ts: string;
	kind: string;
	surface: string;
	node_id: string | null;
	summary: string;
}

const SUMMARY_LIMIT = 200;
export const LINKED_EVENTS = 5;
/** The newest session events a causal chain is read from; a source older than these gets an empty chain. */
export const CAUSAL_WINDOW = 200;

function text(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
	return "";
}

function field(row: Record<string, unknown>, key: string): string {
	return text(row?.[key]);
}

/** A ledger row's `ts` as ISO-8601: epoch milliseconds become a string, a string stays as it is, and anything missing or invalid becomes "". */
function isoTs(row: Record<string, unknown>): string {
	const raw = row?.ts;
	if (typeof raw === "string") return raw;
	if (typeof raw !== "number" && typeof raw !== "bigint") return "";
	const date = new Date(Number(raw));
	return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function compareDesc(a: string, b: string): number {
	if (a === b) return 0;
	return a < b ? 1 : -1;
}

function newestFirst(a: Record<string, unknown>, b: Record<string, unknown>): number {
	return compareDesc(isoTs(a), isoTs(b)) || compareDesc(field(a, "id"), field(b, "id"));
}

/** Reduce one ledger row. Missing fields become empty strings, or null for node_id. The summary is redacted, then cut. */
export function reduceEvent(row: Record<string, unknown>): ReducedEvent {
	const nodeId = field(row, "node_id");
	return {
		id: field(row, "id"),
		ts: isoTs(row),
		kind: field(row, "kind"),
		surface: field(row, "surface"),
		node_id: nodeId.length > 0 ? nodeId : null,
		summary: [...redact(field(row, "summary"))].slice(0, SUMMARY_LIMIT).join(""),
	};
}

/** One entry per distinct graph id, in first-seen order. Each carries that graph's newest events, newest first. */
export function graphLinks(
	graphIds: readonly string[],
	eventsByGraph: ReadonlyMap<string, readonly Record<string, unknown>[]>,
): { graph_id: string; events: ReducedEvent[] }[] {
	const seen = new Set<string>();
	const links: { graph_id: string; events: ReducedEvent[] }[] = [];
	for (const graphId of graphIds) {
		if (seen.has(graphId)) continue;
		seen.add(graphId);
		const rows = eventsByGraph.get(graphId) ?? [];
		const events = [...rows].sort(newestFirst).slice(0, LINKED_EVENTS).map(reduceEvent);
		links.push({ graph_id: graphId, events });
	}
	return links;
}

/** The events that came before the source in its session, nearest first. Empty when the source is not in the rows. */
export function causalChain(
	sessionRows: readonly Record<string, unknown>[],
	sourceEventId: string,
): ReducedEvent[] {
	const at = sessionRows.findIndex((row) => field(row, "id") === sourceEventId);
	if (at < 0) return [];
	return sessionRows.slice(Math.max(0, at - LINKED_EVENTS), at).reverse().map(reduceEvent);
}
