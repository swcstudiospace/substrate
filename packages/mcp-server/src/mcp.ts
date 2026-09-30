/**
 * MCP tool surface.
 *
 * Tool names use underscores, not the dots the design doc writes: Anthropic
 * tool names must match ^[a-zA-Z0-9_-]{1,64}$, so `memory.brief` would be
 * rejected at the client. The connector's forwarding tools already use
 * `memory_brief` / `events_emit`, so this stays consistent with them.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT } from "./greptime.ts";
import type { Substrate } from "./service.ts";
import { ACTORS, EVENT_KINDS, MEMORY_KINDS, NODE_STATES, SURFACES, TRUST_LEVELS, type Surface } from "./types.ts";

const surfaceSchema = z.enum(SURFACES);

function text(value: string) {
	return { content: [{ type: "text" as const, text: value }] };
}

function json(value: unknown) {
	return text(JSON.stringify(value, null, 2));
}

export function createMcpServer(substrate: Substrate, callerSurface: Surface | null): McpServer {
	const server = new McpServer({ name: "substrate", version: "0.1.0" });

	server.registerTool(
		"memory_brief",
		{
			title: "Substrate brief",
			description:
				"The cross-agent session briefing for a repo: this graph's nodes and claims, other open graphs, recent agent actions, decisions in force and warnings. Call this before your first action in a repo.",
			inputSchema: {
				repo: z.string().optional().describe("owner/name, e.g. swcstudiospace/autonogrammer"),
				branch: z.string().optional(),
				graph_id: z.string().optional().describe("ut-<ts36>-<8hex> from the ultrathink uplift"),
				surface: surfaceSchema.optional().describe("defaults to the caller's own surface"),
			},
		},
		async ({ repo, branch, graph_id, surface }) =>
			text(await substrate.brief({ repo, branch, graph_id, surface: surface ?? callerSurface ?? "claude-code" })),
	);

	server.registerTool(
		"memory_write",
		{
			title: "Write a memory entry",
			description:
				"Record a decision, fact, warning, handoff or todo at a scope so other agents see it in their brief.",
			inputSchema: {
				scope: z.string().describe("graph:<id> | repo:<name> | global | agent:<surface> | person:<name>"),
				kind: z.enum(MEMORY_KINDS),
				text: z.string(),
				trust: z.enum(TRUST_LEVELS).optional(),
				ttl: z.string().optional().describe("graph | 30d | permanent"),
				source_event: z.string().optional(),
				surface: surfaceSchema.optional().describe("defaults to the caller's own surface"),
			},
			annotations: { destructiveHint: false },
		},
		async ({ surface, ...entry }) =>
			json(await substrate.writeMemory({ ...entry, writer: surface ?? callerSurface ?? "unknown" })),
	);

	server.registerTool(
		"memory_search",
		{
			title: "Search memory",
			description: "Full-text search over memory entries, optionally narrowed to one scope.",
			inputSchema: {
				query: z.string(),
				scope: z.string().optional(),
				limit: z.number().int().min(1).max(100).optional(),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ query, scope, limit }) => json(await substrate.searchMemory(query, scope, limit)),
	);

	server.registerTool(
		"events_emit",
		{
			title: "Emit an event",
			description:
				"Append a normalised event to the substrate's append-only event ledger. Redaction and the hash chain " +
				"are applied on ingest, and this tool is the only way to write to the ledger. The reply's `stored` " +
				"says whether the append landed — false means the event was normalised but not persisted.",
			inputSchema: {
				kind: z.enum(EVENT_KINDS),
				summary: z.string(),
				surface: surfaceSchema.optional(),
				session_id: z.string().optional(),
				graph_id: z.string().optional(),
				node_id: z.string().optional(),
				linear_identifier: z.string().optional(),
				step: z.number().int().optional(),
				repo: z.string().optional(),
				branch: z.string().optional(),
				actor: z.enum(ACTORS).optional(),
				payload: z.record(z.string(), z.unknown()).optional(),
			},
		},
		async (args) => {
			const { event, stored, error, warning } = await substrate.emit({
				...args,
				surface: args.surface ?? callerSurface ?? "claude-code",
			});
			return json({
				id: event.id,
				ts: event.ts,
				hash: event.hash,
				stored,
				...(error ? { error } : {}),
				...(warning ? { warning } : {}),
			});
		},
	);

	server.registerTool(
		"events_query",
		{
			title: "Query the event ledger",
			description:
				"Read a window of the append-only event ledger: what agents did, narrowed by session, graph, node, " +
				"repo, branch, surface, kind, actor and a time range. This is the only read path onto the ledger — no " +
				"caller needs its credentials. Newest first unless `order` is `asc`. `payload` is omitted unless " +
				"`include_payload` is set, since it can be 16 KB an event. `ts` is collector-supplied, so it is " +
				"display order, not append order: `hash` and `prev` chain each session, and `events_verify` checks them.",
			inputSchema: {
				session_id: z.string().optional(),
				graph_id: z.string().optional().describe("ut-<ts36>-<8hex>"),
				node_id: z.string().optional(),
				linear_identifier: z.string().optional().describe("e.g. SPE-4789"),
				repo: z.string().optional().describe("owner/name"),
				branch: z.string().optional(),
				surface: surfaceSchema.optional(),
				kind: z.enum(EVENT_KINDS).optional(),
				actor: z.enum(ACTORS).optional(),
				since: z.string().optional().describe("inclusive ISO lower bound on ts"),
				until: z.string().optional().describe("inclusive ISO upper bound on ts"),
				limit: z
					.number()
					.int()
					.min(1)
					.max(MAX_QUERY_LIMIT)
					.optional()
					.describe(`rows, default ${DEFAULT_QUERY_LIMIT}, max ${MAX_QUERY_LIMIT}`),
				order: z.enum(["asc", "desc"]).optional(),
				include_payload: z.boolean().optional(),
			},
			annotations: { readOnlyHint: true },
		},
		async (args) => json(await substrate.queryEvents(args)),
	);

	server.registerTool(
		"events_verify",
		{
			title: "Verify a graph's hash chain",
			description:
				"Recompute the ledger's hash chain for one Graph ID and report the first event that does not verify. " +
				"Each session's events are chained separately; `ok` false names the event and why.",
			inputSchema: { graph_id: z.string() },
			annotations: { readOnlyHint: true },
		},
		async ({ graph_id }) => json(await substrate.verifyGraph(graph_id)),
	);

	server.registerTool(
		"graph_get",
		{
			title: "Get a graph",
			description: "Task, nodes, steps, claims and PR state for a Graph ID.",
			inputSchema: { graph_id: z.string() },
			annotations: { readOnlyHint: true },
		},
		async ({ graph_id }) => {
			const graph = await substrate.getGraph(graph_id);
			return graph ? json(graph) : text(`No graph ${graph_id} in the index.`);
		},
	);

	server.registerTool(
		"graph_register",
		{
			title: "Register a graph",
			description:
				"Record a Graph ID and its nodes/steps in the index after the Notion and Linear rows exist. Idempotent by Graph ID — re-running updates in place rather than duplicating.",
			inputSchema: {
				graph_id: z.string(),
				notion_task_page: z.string().optional(),
				repo: z.string().optional(),
				branch: z.string().optional(),
				surface: surfaceSchema.optional(),
				status: z.string().optional(),
				pr_url: z.string().optional(),
				nodes: z
					.array(
						z.object({
							node_id: z.string(),
							linear_issue_id: z.string().optional(),
							linear_identifier: z.string().optional(),
							notion_page: z.string().optional(),
							state: z.enum(NODE_STATES).optional(),
						}),
					)
					.optional(),
				steps: z
					.array(
						z.object({
							node_id: z.string(),
							step: z.number().int(),
							linear_sub_issue_id: z.string().optional(),
							notion_page: z.string().optional(),
							state: z.enum(NODE_STATES).optional(),
						}),
					)
					.optional(),
			},
		},
		async (args) => json(await substrate.registerGraph({ ...args, surface: args.surface ?? callerSurface })),
	);

	server.registerTool(
		"graph_claim",
		{
			title: "Claim a node",
			description:
				"Claim a Graph-of-Thought node for this surface. If another agent already holds it, their claim is returned unchanged rather than overwritten.",
			inputSchema: {
				graph_id: z.string(),
				node_id: z.string(),
				session_id: z.string(),
				surface: surfaceSchema.optional(),
			},
		},
		async ({ graph_id, node_id, session_id, surface }) =>
			json(await substrate.claimNode(graph_id, node_id, surface ?? callerSurface ?? "claude-code", session_id)),
	);

	server.registerTool(
		"graph_release",
		{
			title: "Release a node",
			description: "Drop this surface's claim on a node without marking it complete.",
			inputSchema: { graph_id: z.string(), node_id: z.string() },
		},
		async ({ graph_id, node_id }) => {
			await substrate.releaseNode(graph_id, node_id);
			return text(`Released ${graph_id}/${node_id}.`);
		},
	);

	server.registerTool(
		"graph_complete",
		{
			title: "Complete a node",
			description: "Mark a node completed and drop its claim.",
			inputSchema: { graph_id: z.string(), node_id: z.string() },
		},
		async ({ graph_id, node_id }) => {
			await substrate.completeNode(graph_id, node_id);
			return text(`Completed ${graph_id}/${node_id}.`);
		},
	);

	return server;
}
