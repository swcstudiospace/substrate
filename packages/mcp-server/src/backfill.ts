/**
 * Backfill the index from the Notion Agent Task Graph.
 *
 * The mapping is pure and separately tested; only `fetchNotionRows` touches the
 * network. Notion stays the source of truth — this only warms the cache so the
 * brief does not call the API on every prompt.
 *
 * Two things the rows teach that the design doc does not say:
 *
 *   - `node_id` is not a column. It is a `[nN]` prefix on the `Item` title,
 *     e.g. "[n5] Rule out Linear API-side limitations".
 *   - `Issue ID` holds the Linear *identifier* (`SPE-121`), not a UUID, and it
 *     is null on Sub-Issue rows — those carry only a Linear URL.
 */
import { SURFACES, type NodeState, type Surface } from "./types.ts";

/**
 * Notion's `Agent` is free text, so it cannot be trusted to be a known surface.
 * An unrecognised value becomes null rather than poisoning the index with a
 * surface no collector will ever match.
 */
export function toSurface(value: string | null | undefined): Surface | null {
	const normalized = value?.trim().toLowerCase().replace(/[\s_]+/g, "-");
	return normalized && (SURFACES as readonly string[]).includes(normalized) ? (normalized as Surface) : null;
}

export interface NotionRow {
	url?: string | null;
	"Graph ID"?: string | null;
	Level?: string | null;
	Item?: string | null;
	"Issue ID"?: string | null;
	"Linear URL"?: string | null;
	"Linear State"?: string | null;
	Step?: number | null;
	Repo?: string | null;
	Branch?: string | null;
	Status?: string | null;
	Agent?: string | null;
	"PR URL"?: string | null;
}

interface GraphPlan {
	graph_id: string;
	notion_task_page?: string | null;
	repo?: string | null;
	branch?: string | null;
	surface?: Surface | null;
	status?: string | null;
	pr_url?: string | null;
	nodes: Array<{
		node_id: string;
		linear_issue_id?: string | null;
		linear_identifier?: string | null;
		notion_page?: string | null;
		state?: NodeState | null;
	}>;
	steps: Array<{
		node_id: string;
		step: number;
		linear_sub_issue_id?: string | null;
		notion_page?: string | null;
		state?: NodeState | null;
	}>;
}

/** "[n5] Rule out Linear API-side limitations" → "n5" */
export function nodeIdFromTitle(title: string | null | undefined): string | null {
	return title?.match(/^\s*\[(n\d+)\]/i)?.[1]?.toLowerCase() ?? null;
}

/** ".../issue/SPE-132/identify-..." → "SPE-132" */
export function identifierFromLinearUrl(url: string | null | undefined): string | null {
	return url?.match(/\/issue\/([A-Z][A-Z0-9]*-\d+)/i)?.[1]?.toUpperCase() ?? null;
}

/** Notion's mirrored Linear State → the workflow states in hermes-linear's config. */
export function toNodeState(linearState: string | null | undefined): NodeState | null {
	switch (linearState?.trim().toLowerCase()) {
		case "backlog":
			return "backlog";
		case "todo":
			return "unstarted";
		case "in progress":
			return "started";
		case "in review":
			return "started_review";
		case "done":
			return "completed";
		case "canceled":
		case "cancelled":
			return "canceled";
		default:
			return null;
	}
}

/**
 * Group flat Notion rows into one plan per Graph ID.
 *
 * Rows arrive in any order and a graph may have no Task row at all (a partial
 * write, or a Task filtered out by the query), so the plan is created lazily by
 * whichever row is seen first.
 */
export function mapNotionRows(rows: NotionRow[]): GraphPlan[] {
	const plans = new Map<string, GraphPlan>();

	const planFor = (graphId: string): GraphPlan => {
		let plan = plans.get(graphId);
		if (!plan) {
			plan = { graph_id: graphId, nodes: [], steps: [] };
			plans.set(graphId, plan);
		}
		return plan;
	};

	for (const row of rows) {
		const graphId = row["Graph ID"]?.trim();
		if (!graphId) continue;
		const plan = planFor(graphId);
		const level = row.Level?.trim();
		const nodeId = nodeIdFromTitle(row.Item);
		const identifier = row["Issue ID"]?.trim() || identifierFromLinearUrl(row["Linear URL"]);
		const state = toNodeState(row["Linear State"]);

		if (level === "Task") {
			plan.notion_task_page = row.url ?? plan.notion_task_page ?? null;
			plan.repo = row.Repo ?? plan.repo ?? null;
			plan.branch = row.Branch ?? plan.branch ?? null;
			plan.surface = toSurface(row.Agent) ?? plan.surface ?? null;
			plan.status = row.Status ?? plan.status ?? null;
			plan.pr_url = row["PR URL"] ?? plan.pr_url ?? null;
			continue;
		}

		// Without a node id there is nowhere to hang the row; skipping keeps the
		// index honest rather than inventing an n0 bucket.
		if (!nodeId) continue;

		if (level === "Issue") {
			plan.nodes.push({
				node_id: nodeId,
				linear_identifier: identifier,
				notion_page: row.url ?? null,
				state,
			});
		} else if (level === "Sub-Issue") {
			plan.steps.push({
				node_id: nodeId,
				step: typeof row.Step === "number" ? row.Step : 1,
				notion_page: row.url ?? null,
				state,
			});
		}
	}

	// A Sub-Issue can arrive for a node whose Issue row was not in this page of
	// results; the node must still exist for the foreign key to hold.
	for (const plan of plans.values()) {
		const known = new Set(plan.nodes.map((n) => n.node_id));
		for (const step of plan.steps) {
			if (!known.has(step.node_id)) {
				plan.nodes.push({ node_id: step.node_id });
				known.add(step.node_id);
			}
		}
		plan.nodes.sort((a, b) => a.node_id.localeCompare(b.node_id, undefined, { numeric: true }));
	}

	return [...plans.values()];
}
