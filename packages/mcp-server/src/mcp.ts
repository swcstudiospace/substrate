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
import type { Substrate } from "./service.ts";
import { EVENT_KINDS, MEMORY_KINDS, NODE_STATES, SURFACES, TRUST_LEVELS, type Surface } from "./types.ts";

const surfaceSchema = z.enum(SURFACES);

function text(value: string) {
	return { content: [{ type: "text" as const, text: value }] };
}

function json(value: unknown) {
	return text(JSON.stringify(value, null, 2));
}

/**
 * Who a release or completion acts as. The claim session id is public (a
 * Linear comment, the claim event), so the surface is the ownership proof: an
 * authenticated caller is its token's surface and a payload naming another is
 * refused. An anonymous caller is attributed by its payload.
 */
function ownerSurface(
	payload: Surface | undefined,
	callerSurface: Surface | null,
): { surface: Surface; refusal?: never } | { refusal: string } {
	if (callerSurface === null) return { surface: payload ?? "claude-code" };
	if (payload && payload !== callerSurface) {
		return { refusal: `surface ${payload} does not match the authenticated caller ${callerSurface}` };
	}
	return { surface: callerSurface };
}

const OWNER_SURFACE_HINT = "defaults to the caller's own surface; an authenticated caller cannot name another";

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
				"Append a normalised event to the substrate log. Redaction and the hash chain are applied on ingest.",
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
				actor: z.enum(["agent", "human"]).optional(),
				payload: z.record(z.string(), z.unknown()).optional(),
			},
		},
		async (args) => {
			const event = await substrate.emit({ ...args, surface: args.surface ?? callerSurface ?? "claude-code" });
			return json({ id: event.id, ts: event.ts, hash: event.hash });
		},
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
		"graph_find",
		{
			title: "Find a node by Linear issue",
			description:
				"Resolve a Linear issue (id or identifier) to the registered graph node that owns it. Used by substrate-dispatcher.",
			inputSchema: {
				linear_issue_id: z.string().optional(),
				linear_identifier: z.string().optional(),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ linear_issue_id, linear_identifier }) =>
			json(await substrate.findNode({ linear_issue_id, linear_identifier })),
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
			description:
				"Release this session's claim on a node: the Linear issue goes back to Todo and agent:<surface> is removed. Only the claiming surface and session can release.",
			inputSchema: {
				graph_id: z.string(),
				node_id: z.string(),
				session_id: z.string(),
				surface: surfaceSchema.optional().describe(OWNER_SURFACE_HINT),
			},
		},
		async ({ graph_id, node_id, session_id, surface }) => {
			const owner = ownerSurface(surface, callerSurface);
			if (owner.refusal !== undefined) return json({ released: false, reason: owner.refusal });
			return json(await substrate.releaseNode(graph_id, node_id, owner.surface, session_id));
		},
	);

	server.registerTool(
		"graph_complete",
		{
			title: "Complete a node",
			description:
				"Finish a node: the Linear issue moves to In Review and hermes-linear-connector's Definition-of-Done gate decides Done. Returns completed:false with the reason when DoD has not passed; the issue then stays In Review and the claim stays.",
			inputSchema: {
				graph_id: z.string(),
				node_id: z.string(),
				session_id: z.string(),
				surface: surfaceSchema.optional().describe(OWNER_SURFACE_HINT),
				dod: z
					.object({
						summary: z.string(),
						tests_pass: z.boolean(),
						review_pass: z.boolean().optional(),
					})
					.optional(),
			},
		},
		async ({ graph_id, node_id, session_id, surface, dod }) => {
			const owner = ownerSurface(surface, callerSurface);
			if (owner.refusal !== undefined) return json({ completed: false, reason: owner.refusal });
			return json(await substrate.completeNode(graph_id, node_id, owner.surface, session_id, dod));
		},
	);

	return server;
}
