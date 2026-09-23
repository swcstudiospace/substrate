/**
 * The session briefing (Notion §5.4).
 *
 * Composed from the index (graphs, nodes, claims), Greptime (recent actions)
 * and memory (warnings, decisions). Every source is optional: a brief with
 * fewer sections is still useful, and a missing store must degrade rather than
 * throw, because this text sits on the critical path of every prompt.
 */
import type { GreptimeClient } from "./greptime.ts";
import { quote } from "./greptime.ts";
import type { IndexStore } from "./index-store.ts";
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

function describeNode(node: GraphView["nodes"][number]): string {
	const label = node.linear_identifier ? `${node.node_id} ${node.linear_identifier}` : node.node_id;
	if (node.state === "completed") return `${label} done${node.claimed_by ? ` (${node.claimed_by})` : ""}`;
	if (node.claimed_by) {
		const since = node.claimed_at ? ` ${relativeTime(node.claimed_at)}` : "";
		return `${label} started by ${node.claimed_by}${since}`;
	}
	if (node.state === "canceled") return `${label} canceled`;
	return `${label} ${node.state ?? "todo"}`;
}

/** Fail open, but never silently: a swallowed error still reaches the log. */
function swallow<T>(what: string, fallback: T): (cause: unknown) => T {
	return (cause) => {
		process.stderr.write(`[substrate] brief: ${what} unavailable — ${String(cause)}\n`);
		return fallback;
	};
}

/** Build the Markdown brief. Never throws — a partial brief beats a blocked prompt. */
export async function composeBrief(request: BriefRequest, sources: BriefSources): Promise<string> {
	const { repo = null, branch = null, graph_id: graphId = null, surface } = request;
	const lines: string[] = [];

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
			lines.push(`Nodes: ${graph.nodes.map(describeNode).join(" · ")}`);
		}
	} else if (graphId) {
		lines.push("This graph is not in the index yet.");
	}

	// Recent actions in this repo, from any surface.
	if (sources.greptime && repo) {
		const rows = await sources.greptime
			.sql(
				`SELECT "ts", "surface", "summary", "node_id", "step" FROM "agent_events"
				 WHERE "repo" = ${quote(repo)} AND "kind" NOT IN ('session.start','session.end')
				 ORDER BY "ts" DESC LIMIT ${RECENT_ACTION_LIMIT}`,
			)
			.catch(swallow("recent actions", [] as Array<Record<string, unknown>>));
		if (rows.length > 0) {
			lines.push("", `Last ${rows.length} agent actions in this repo`);
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
					const started = other.nodes.filter((n) => n.claimed_by).length;
					const parts = [other.surface, other.status, started > 0 ? `${started} nodes started` : null].filter(
						Boolean,
					);
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
			lines.push(`- ${entry.text} (${entry.writer}, ${entry.trust})`);
		}
	}
	if (warnings.length > 0) {
		lines.push("", "Warnings");
		for (const entry of warnings.slice(0, 4)) {
			lines.push(`- ${entry.text} (${entry.writer}, ${relativeTime(entry.created)})`);
		}
	}

	if (lines.length === 1) {
		lines.push(`No substrate history for this repo yet. You are the first ${surface} session here.`);
	}

	return lines.join("\n");
}
