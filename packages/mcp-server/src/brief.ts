/**
 * The session briefing (Notion §5.4).
 *
 * Composed from the index (graphs, nodes, claims), Greptime (recent actions)
 * and memory (warnings, decisions). Every source is optional: a brief with
 * fewer sections is still useful, and a missing store must degrade rather than
 * throw, because this text sits on the critical path of every prompt.
 */
import { earliestRefreshAt } from "./cache.ts";
import { normalizeIdentifier } from "./event.ts";
import type { GreptimeClient } from "./greptime.ts";
import { quote } from "./greptime.ts";
import { leaseSnapshot, type IndexStore } from "./index-store.ts";
import { leaseState } from "./lease.ts";
import type { GraphView, MemoryEntry, Surface } from "./types.ts";

export interface BriefRequest {
	repo?: string;
	branch?: string;
	graph_id?: string;
	surface: Surface;
}

export interface BriefSources {
	index: IndexStore | null;
	greptime: GreptimeClient | null;
}

const RECENT_ACTION_LIMIT = 5;

/**
 * Greptime returns a TIMESTAMP column as an integer, not an ISO string, at
 * whatever precision the column was declared with. `new Date(1790186361859)`
 * and `new Date("1790186361859")` disagree, so normalise before formatting.
 */
export function toDate(value: unknown): Date | null {
	if (value instanceof Date) return value;
	if (typeof value === "number" || (typeof value === "string" && /^\d{10,20}$/.test(value))) {
		const epoch = Number(value);
		// Disambiguate by magnitude: s → ms → µs → ns.
		const ms =
			epoch < 1e11 ? epoch * 1000 : epoch < 1e14 ? epoch : epoch < 1e17 ? epoch / 1000 : epoch / 1_000_000;
		const date = new Date(ms);
		return Number.isNaN(date.getTime()) ? null : date;
	}
	if (typeof value === "string") {
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? null : date;
	}
	return null;
}

function relativeTime(value: unknown, now = Date.now()): string {
	const date = toDate(value);
	if (!date) return "at an unknown time";
	const delta = now - date.getTime();
	if (delta < 0) return "just now";
	const minutes = Math.floor(delta / 60000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

function clock(value: unknown): string {
	return toDate(value)?.toISOString().slice(11, 16) ?? "--:--";
}

/**
 * One node, as a line in the brief.
 *
 * The lease state matters more than `claimed_by` here. A node whose lease has
 * lapsed is *free* — the next claim takes it — so reporting it as "started by
 * hermes" would tell the reading agent the one thing it must not believe, and
 * would keep it off a node it is entitled to. It is named as stale instead,
 * because who was there last is still worth knowing.
 */
function describeNode(node: GraphView["nodes"][number], now = Date.now()): string {
	const label = node.linear_identifier ? `${node.node_id} ${node.linear_identifier}` : node.node_id;
	if (node.state === "completed") return `${label} done${node.claimed_by ? ` (${node.claimed_by})` : ""}`;
	if (node.claimed_by) {
		const state = leaseState(leaseSnapshot(node), now);
		if (state === "held") {
			const since = node.claimed_at ? ` ${relativeTime(node.claimed_at, now)}` : "";
			return `${label} held by ${node.claimed_by}${since}`;
		}
		const lapsed = node.lease_expires_at ? ` ${relativeTime(node.lease_expires_at, now)}` : "";
		return `${label} free — ${node.claimed_by}'s lease expired${lapsed}`;
	}
	if (node.state === "canceled") return `${label} canceled`;
	return `${label} ${node.state ?? "todo"}`;
}

/**
 * Mark an entry whose trust has decayed.
 *
 * A decayed entry is still shown — dropping it would quietly lose the only record
 * that a decision was ever taken. What changes is that the brief stops presenting
 * it as settled, which is the whole point of `needs_reverification`: the next agent
 * is told to check before acting, not left to assume a year-old agent-claimed fact
 * still holds.
 */
function staleness(entry: MemoryEntry): string {
	return entry.needs_reverification ? " — needs reverification" : "";
}

/** Fail open, but never silently: a swallowed error still reaches the log. */
function swallow<T>(what: string, fallback: T): (cause: unknown) => T {
	return (cause) => {
		process.stderr.write(`[substrate] brief: ${what} unavailable — ${String(cause)}\n`);
		return fallback;
	};
}

/**
 * Build the Markdown brief. Never throws — a partial brief beats a blocked prompt.
 *
 * `noteRefreshAt` receives the soonest lease expiry or reverify time the text
 * depends on, so a cache can drop the brief when that moment arrives.
 */
export async function composeBrief(
	request: BriefRequest,
	sources: BriefSources,
	noteRefreshAt?: (at: number | null) => void,
): Promise<string> {
	const { repo = null, branch = null, graph_id: graphId = null, surface } = request;
	const lines: string[] = [];
	const deadlines: Array<string | null | undefined> = [];

	const heading = [repo ?? "unknown repo", branch ? `@ ${branch}` : null, graphId ? `— ${graphId}` : null]
		.filter(Boolean)
		.join(" ");
	lines.push(`## Substrate brief: ${heading}`);

	let graph: GraphView | null = null;
	if (sources.index && graphId) {
		graph = await sources.index.getGraph(graphId).catch(swallow("graph", null));
	}

	if (graph) {
		const summary = [
			graph.status ? graph.status : "status unknown",
			graph.surface ? `Agent ${graph.surface}` : null,
			graph.pr_url ? `PR ${graph.pr_url}` : "PR none yet",
		]
			.filter(Boolean)
			.join(" · ");
		lines.push(summary);
		if (graph.nodes.length > 0) {
			// Not `map(describeNode)`: map would pass the array index as the `now`
			// argument, and every lease would read as live against a clock at epoch 0.
			lines.push(`Nodes: ${graph.nodes.map((node) => describeNode(node)).join(" · ")}`);
			for (const node of graph.nodes) deadlines.push(node.lease_expires_at);
		}
	} else if (graphId) {
		lines.push("This graph is not in the index yet.");
	}

	// Recent actions in this repo, from any surface. The repo is matched in the form
	// the write path stores it, not as the caller spelled it — see normalizeIdentifier.
	if (sources.greptime && repo) {
		const rows = await sources.greptime
			.sql(
				`SELECT "ts", "surface", "summary", "node_id", "step" FROM "agent_events"
				 WHERE "repo" = ${quote(normalizeIdentifier(repo) ?? repo)} AND "kind" NOT IN ('session.start','session.end')
				 ORDER BY "ts" DESC LIMIT ${RECENT_ACTION_LIMIT}`,
			)
			.catch(swallow("recent actions", [] as Array<Record<string, unknown>>));
		if (rows.length > 0) {
			lines.push("", `Last ${rows.length} agent action${rows.length === 1 ? "" : "s"} in this repo`);
			for (const row of rows) {
				const where = row.node_id ? ` (${row.node_id}${row.step ? ` step ${row.step}` : ""})` : "";
				lines.push(`- ${clock(row.ts)} ${String(row.surface).padEnd(12)} ${String(row.summary)}${where}`);
			}
		}
	}

	// Other graphs open in this repo.
	if (sources.index && repo) {
		const others = await sources.index.openGraphs(repo, graphId ?? undefined).catch(swallow("open graphs", [] as GraphView[]));
		if (others.length > 0) {
			const described = others
				.slice(0, 4)
				.map((other) => {
					// Live leases only. A graph whose every lease has lapsed has nobody
					// on it, and counting those as started would make the repo look busier
					// than it is — which is the reading that stops an agent picking work up.
					const started = other.nodes.filter((n) => leaseState(leaseSnapshot(n), Date.now()) === "held").length;
					const parts = [
						other.surface,
						other.status,
						started > 0 ? `${started} node${started === 1 ? "" : "s"} held` : null,
					].filter(Boolean);
					for (const node of other.nodes) deadlines.push(node.lease_expires_at);
					return `${other.graph_id} (${parts.join(", ")})`;
				})
				.join(" · ");
			lines.push("", `Other open graphs here: ${described}`);
		}
	}

	// Warnings and decisions worth carrying into this session.
	let memory: MemoryEntry[] = [];
	if (sources.index) {
		memory = await sources.index.memoryForBrief(repo, graphId).catch(swallow("memory", [] as MemoryEntry[]));
	}
	const warnings = memory.filter((entry) => entry.kind === "warning");
	const decisions = memory.filter((entry) => entry.kind === "decision");
	if (decisions.length > 0) {
		lines.push("", "Decisions in force");
		for (const entry of decisions.slice(0, 4)) {
			const version = entry.version > 1 ? `, v${entry.version}` : "";
			lines.push(`- ${entry.text} (${entry.writer}, ${entry.trust}${version})${staleness(entry)}`);
		}
	}
	if (warnings.length > 0) {
		lines.push("", "Warnings");
		for (const entry of warnings.slice(0, 4)) {
			lines.push(`- ${entry.text} (${entry.writer}, ${relativeTime(entry.created)})${staleness(entry)}`);
		}
	}

	for (const entry of memory) {
		if (!entry.needs_reverification) deadlines.push(entry.reverify_after);
	}

	if (lines.length === 1) {
		lines.push(`No substrate history for this repo yet. You are the first ${surface} session here.`);
	}

	noteRefreshAt?.(earliestRefreshAt(deadlines));
	return lines.join("\n");
}
