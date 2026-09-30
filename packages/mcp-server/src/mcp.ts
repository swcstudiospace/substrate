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
import {
	EVENT_KINDS,
	MEMORY_KINDS,
	MEMORY_TTLS,
	NODE_STATES,
	SURFACES,
	TRUST_LEVELS,
	type Surface,
} from "./types.ts";

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
				"Record a decision, fact, warning, handoff or todo at a scope so other agents see it in their brief. " +
				"Governed and default-deny: the reply's `outcome` is accepted | conflict | quarantined | denied, and " +
				"`remedy` says what to do about it. Treat the write as durable only when `outcome` is accepted AND " +
				"`verified_persisted` is true — anything else means no other agent will act on this. A `global` scope " +
				"is a proposal until a reviewer releases it; a `decision` with a subject must name the `expected_version` " +
				"it supersedes.",
			inputSchema: {
				scope: z.string().describe("graph:<id> | repo:<name> | global | agent:<surface> | person:<name>"),
				kind: z.enum(MEMORY_KINDS),
				text: z.string(),
				subject: z
					.string()
					.optional()
					.describe(
						"a stable name for what this entry is about; two entries sharing one at the same scope and kind " +
							"are the same claim over time, which is what lets a todo replace and a decision version",
					),
				trust: z
					.enum(TRUST_LEVELS)
					.optional()
					.describe(
						"human-confirmed needs a review_token; verified-by-test needs a source_event naming the run " +
							"that proved it. Anything else is recorded as agent-claimed.",
					),
				ttl: z.enum(MEMORY_TTLS).optional(),
				source_event: z.string().optional().describe("the event id this entry came from, for provenance"),
				session_id: z.string().optional(),
				graph_id: z.string().optional(),
				repo: z.string().optional(),
				expected_version: z
					.number()
					.int()
					.min(0)
					.optional()
					.describe("the version of the entry this write supersedes; required to replace a standing decision"),
				idempotency_key: z
					.string()
					.optional()
					.describe("makes the write exactly-once — retry with the same key rather than writing twice"),
				review_token: z.string().optional().describe("a reviewer's token; never stored or echoed"),
				surface: surfaceSchema.optional().describe("defaults to the caller's own surface"),
			},
			// Not destructive: a superseded entry is retired, never deleted. Idempotent
			// where the caller supplies a key, which is the whole point of having one.
			annotations: { destructiveHint: false, idempotentHint: true },
		},
		async ({ surface, ...entry }) =>
			json(await substrate.writeMemory({ ...entry, writer: surface ?? callerSurface ?? "unknown" })),
	);

	server.registerTool(
		"memory_search",
		{
			title: "Search memory",
			description:
				"Full-text search over memory entries, optionally narrowed to one scope. Superseded entries are " +
				"excluded unless asked for, and quarantined or unreviewed writes are never returned. An entry with " +
				"`needs_reverification` has outlived its trust: check it before acting on it.",
			inputSchema: {
				query: z.string(),
				scope: z.string().optional(),
				limit: z.number().int().min(1).max(100).optional(),
				include_superseded: z
					.boolean()
					.optional()
					.describe("include retired versions — how you read a decision's history"),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ query, scope, limit, include_superseded }) =>
			json(await substrate.searchMemory(query, scope, limit, include_superseded)),
	);

	server.registerTool(
		"memory_pending",
		{
			title: "Memory awaiting review",
			description:
				"Writes the governance gate parked: proposals waiting on a reviewer, and quarantined entries. Bodies " +
				"are redacted. Neither reaches a brief or a search until released.",
			inputSchema: { limit: z.number().int().min(1).max(100).optional() },
			annotations: { readOnlyHint: true },
		},
		async ({ limit }) => json(await substrate.governanceQueue(limit)),
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
				actor: z.enum(["agent", "human"]).optional(),
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
