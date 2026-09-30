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
import { DEFAULT_IDLE_SECONDS, formatDrift } from "./drift.ts";
import { DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT } from "./greptime.ts";
import { MAX_LEASE_TTL_SECONDS, MIN_LEASE_TTL_SECONDS } from "./lease.ts";
import type { Substrate } from "./service.ts";
import {
	ACTORS,
	EDGE_KINDS,
	EVENT_KINDS,
	MEMORY_KINDS,
	MEMORY_TTLS,
	NODE_STATES,
	SURFACES,
	TRUST_LEVELS,
	type Surface,
} from "./types.ts";

const surfaceSchema = z.enum(SURFACES);

/**
 * Who a `memory_write` through this server is attributed to.
 *
 * The token, or nobody. Everywhere else in this file a caller-supplied `surface` is
 * attribution, and naming another surface is at worst a mislabelled event. On this one
 * tool it is *authorisation*: the name decides which grants apply, so a caller holding
 * the muse token that could pass `surface: "hermes"` would collect hermes's grants,
 * including its own `agent:hermes` scope.
 *
 * The argument therefore loses to the token — and, when there is no token, it loses to
 * `unknown` rather than winning by default. An unauthenticated caller is precisely the
 * one with nothing to lose by naming a surface, and a server with no tokens configured
 * is precisely where it can. `unknown` matches no wildcard grant, so it writes nothing
 * until an operator grants it by name.
 *
 * `argSurface` is a parameter so that ignoring it is testable. The reply's `writer`
 * reports what the write was actually attributed to, so a caller never has to guess
 * whether its argument was taken.
 */
export function memoryToolWriter(callerSurface: Surface | null, argSurface: Surface | undefined): string {
	return callerSurface ?? "unknown";
}

function text(value: string) {
	return { content: [{ type: "text" as const, text: value }] };
}

function json(value: unknown) {
	return text(JSON.stringify(value, null, 2));
}

/**
 * What the transport established about this caller, as opposed to what the
 * caller says about itself.
 *
 * `surface` is the token's surface, or null on an unauthenticated local run.
 * `isOperator` is whether it may take a node off its holder. Both are decided
 * before any tool argument is read, which is the point: a signed handoff's
 * sender and a forced release's authority cannot be arguments.
 */
export interface McpCaller {
	surface: Surface | null;
	isOperator: boolean;
}

export function createMcpServer(substrate: Substrate, caller: McpCaller | Surface | null): McpServer {
	// A bare surface is still accepted so existing callers and tests keep working;
	// it means "authenticated as this surface, not an operator".
	const { surface: callerSurface, isOperator } =
		caller === null || typeof caller === "string" ? { surface: caller, isOperator: false } : caller;
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
				surface: surfaceSchema
					.optional()
					.describe(
						"ignored on this tool — your token's surface is what RBAC is decided on, and with no token " +
							"the write is attributed to `unknown`, which holds no grants. The reply's `writer` says " +
							"which surface the write was attributed to.",
					),
			},
			// Not destructive: a superseded entry is retired, never deleted. Idempotent
			// where the caller supplies a key, which is the whole point of having one.
			annotations: { destructiveHint: false, idempotentHint: true },
		},
		// The token decides the writer, and nothing else does — see `memoryToolWriter`.
		// This is the one tool here where `surface` would be authorisation rather than
		// attribution, and `POST /memory` resolves it the same way.
		async ({ surface, ...entry }) =>
			json(await substrate.writeMemory({ ...entry, writer: memoryToolWriter(callerSurface, surface) })),
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
				"Writes the governance gate parked: proposals waiting on a reviewer, and quarantined entries. Neither " +
				"reaches a brief or a search until released. Bodies and subjects require a review_token — a quarantined " +
				"entry's body still holds the PII that got it quarantined, so without one you see that something is " +
				"parked, where, by whom and why, but not what.",
			inputSchema: {
				limit: z.number().int().min(1).max(100).optional(),
				review_token: z.string().optional().describe("a reviewer's token; required to see bodies"),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ limit, review_token }) => json(await substrate.governanceQueue({ limit, review_token })),
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
				edges: z
					.array(
						z.object({
							from_node: z.string(),
							to_node: z.string(),
							kind: z.enum(EDGE_KINDS),
						}),
					)
					.optional()
					.describe(
						"Dependencies between this graph's nodes, mirroring the Linear sub-issue relations: " +
							"requires | blocks | gated_by. graph_claim does not enforce them; coord_drift_scan reports a " +
							"held node whose dependency is not complete.",
					),
			},
		},
		async (args) => json(await substrate.registerGraph({ ...args, surface: args.surface ?? callerSurface })),
	);

	const ttlSchema = z
		.number()
		.int()
		.min(MIN_LEASE_TTL_SECONDS)
		.max(MAX_LEASE_TTL_SECONDS)
		.optional()
		.describe("How long the lease lasts without a heartbeat. Defaults to SUBSTRATE_LEASE_TTL_SECONDS (900).");

	server.registerTool(
		"graph_claim",
		{
			title: "Take a lease on a node",
			description:
				"Take the lease on a Graph-of-Thought node. A node has at most one holder, identified by surface AND " +
				"session_id, so two sessions of the same agent are two holders. The lease expires after ttl_seconds " +
				"unless graph_heartbeat extends it, and a lapsed lease is taken over by the next claimant — so a " +
				"session that dies releases its node by doing nothing. If another agent holds it, `claimed` is false " +
				"and their lease comes back instead: pick up something else rather than retrying. Keep the `lease_id` " +
				"from the reply — graph_heartbeat, graph_release and graph_complete all require it.",
			inputSchema: {
				graph_id: z.string(),
				node_id: z.string(),
				session_id: z.string().describe("This session's id. Half of the holder's identity, so it must be stable and yours."),
				ttl_seconds: ttlSchema,
				surface: surfaceSchema.optional(),
			},
		},
		async ({ graph_id, node_id, session_id, ttl_seconds, surface }) =>
			json(
				await substrate.claimNode(
					graph_id,
					node_id,
					surface ?? callerSurface ?? "claude-code",
					session_id,
					ttl_seconds,
				),
			),
	);

	server.registerTool(
		"graph_heartbeat",
		{
			title: "Extend a lease you hold",
			description:
				"Push out the expiry on a lease. Call it well inside ttl_seconds for as long as you are working the " +
				"node — every other reader treats a lapsed lease as free. `ok: false` means you no longer hold it: " +
				"`lost` if someone else does, `expired` if it lapsed (re-claim rather than beat), `unheld` if nothing " +
				"does. Stop working the node on a refusal; the reply names the current holder.",
			inputSchema: {
				graph_id: z.string(),
				node_id: z.string(),
				lease_id: z.string().describe("From graph_claim. Proves you are the holder."),
				ttl_seconds: ttlSchema,
			},
		},
		async ({ graph_id, node_id, lease_id, ttl_seconds }) =>
			json(await substrate.heartbeatNode(graph_id, node_id, lease_id, ttl_seconds)),
	);

	/**
	 * A forced release is an operator action, not a peer's.
	 *
	 * Every surface token is equally privileged here, so if `force` were simply
	 * passed through, any agent could evict any other and the lease would be
	 * advisory again for anyone who chose to use it. Refused with the reason
	 * rather than silently downgraded to an ordinary release, which would look
	 * like success and leave the holder in place.
	 */
	const FORCE_REFUSED = {
		released: false,
		completed: false,
		reason: "force-requires-operator",
		detail:
			"taking a node off its holder is an operator action: present a token from SUBSTRATE_OPERATOR_TOKENS. " +
			"To release your own lease, pass the lease_id you were granted.",
	} as const;

	server.registerTool(
		"graph_release",
		{
			title: "Release a node",
			description:
				"Drop your lease on a node without marking it complete. `lease_id` fences it: a holder whose lease " +
				"lapsed cannot release the node someone else has since claimed. `force` prises a node loose from a " +
				"holder that is gone, and is an operator action — it needs an operator token, not a surface token, " +
				"because one agent evicting another would make every lease advisory.",
			inputSchema: {
				graph_id: z.string(),
				node_id: z.string(),
				lease_id: z.string().optional(),
				force: z
					.boolean()
					.optional()
					.describe("Release whoever holds it. Operators only. Required when no lease_id is given."),
			},
		},
		async ({ graph_id, node_id, lease_id, force }) => {
			if (force && !isOperator) return json(FORCE_REFUSED);
			return json(await substrate.releaseNode(graph_id, node_id, { lease_id, force }));
		},
	);

	server.registerTool(
		"graph_complete",
		{
			title: "Complete a node",
			description:
				"Mark a node completed and drop its lease, in one fenced operation. You must hold the lease: pass the " +
				"`lease_id` you were granted. A node nobody holds cannot be completed — claim it first — and a lease " +
				"that has lapsed cannot close a node a second agent has since claimed. `force` is an operator action, " +
				"as in graph_release. `completed: false` means nothing changed, and says why.",
			inputSchema: {
				graph_id: z.string(),
				node_id: z.string(),
				lease_id: z.string().optional(),
				force: z.boolean().optional().describe("Operators only."),
				state: z.enum(NODE_STATES).optional().describe("Defaults to completed."),
			},
		},
		async ({ graph_id, node_id, lease_id, force, state }) => {
			if (force && !isOperator) return json(FORCE_REFUSED);
			return json(await substrate.completeNode(graph_id, node_id, { lease_id, force, state }));
		},
	);

	server.registerTool(
		"coord_handoff",
		{
			title: "Hand work to another agent",
			description:
				"Record a signed handoff packet: the goal, the files, the Definition of Done and the known blockers — " +
				"everything the receiving agent needs to start without asking you. The substrate adds the hash of " +
				"your last event, signs the packet and appends it to the ledger whole, so the receiver can replay it " +
				"from the log alone and check it was not altered. The sender is whoever this connection is " +
				"authenticated as and cannot be set from here; the anchor is read from the ledger for the same " +
				"reason. The reply's `gaps` names what a receiver will find missing; `signed: false` means no signing " +
				"key is configured, and the handoff was still recorded.",
			inputSchema: {
				to: surfaceSchema.describe("The surface taking over."),
				goal: z.string().describe("What the receiver is to achieve, in your words."),
				files: z.array(z.string()).optional().describe("Repo-relative paths the work touches."),
				dod: z.array(z.string()).optional().describe("Definition of Done, one checkable line each."),
				blockers: z.array(z.string()).optional().describe("What is known to be in the way. Empty is a claim, not an omission."),
				graph_id: z.string().optional(),
				node_id: z.string().optional(),
				linear_identifier: z.string().optional(),
				repo: z.string().optional().describe("Defaults to the graph's repo."),
				branch: z.string().optional(),
				session_id: z.string().optional().describe("Your session. Used to find the chain tip the packet is anchored to."),
				to_session_id: z.string().optional(),
				notes: z.string().optional(),
				lease_id: z.string().optional().describe("Your lease on node_id. With release_lease, it is dropped once the packet is durable."),
				release_lease: z
					.boolean()
					.optional()
					.describe(
						"Release the lease so the receiver can claim the node. The reply's `lease_released` says whether " +
							"it happened; the packet records only that you meant to hand it over, because a lease's state " +
							"cannot be frozen into a signed packet. A receiver calls graph_claim rather than reading the packet.",
					),
			},
		},
		async ({ to, to_session_id, session_id, lease_id, release_lease, ...rest }) =>
			json(
				await substrate.handoff({
					...rest,
					// The sender is the authenticated caller. There is no argument for it:
					// a packet naming someone else as sender would carry a valid signature
					// over a false identity, which is worse than an unsigned packet.
					from: { surface: callerSurface ?? "claude-code", session_id: session_id ?? null },
					to: { surface: to, session_id: to_session_id ?? null },
					handover_lease_id: lease_id ?? null,
					...(release_lease === undefined ? {} : { release_lease }),
				}),
			),
	);

	server.registerTool(
		"coord_handoff_verify",
		{
			title: "Verify a handoff packet",
			description:
				"Recompute the signature on a handoff packet. Call this before acting on one you did not watch being " +
				"written. `ok: false` with `unsigned` or `no-keys-configured` means the packet is unauthenticated " +
				"rather than forged; `bad-signature` means it does not match what was signed.",
			inputSchema: { packet: z.record(z.string(), z.unknown()) },
			annotations: { readOnlyHint: true },
		},
		async ({ packet }) => json(substrate.verifyHandoffPacket(packet)),
	);

	server.registerTool(
		"coord_handoff_list",
		{
			title: "Replay a graph's handoffs",
			description:
				"Every handoff packet recorded for a Graph ID, oldest first, each with its own verification verdict. " +
				"This is how a receiving agent picks up work it never saw being handed over. A packet that fails " +
				"verification is still listed, with the reason.",
			inputSchema: { graph_id: z.string() },
			annotations: { readOnlyHint: true },
		},
		async ({ graph_id }) => json(await substrate.handoffsForGraph(graph_id)),
	);

	server.registerTool(
		"coord_drift_scan",
		{
			title: "Scan a repo for coordination drift",
			description:
				"Compare the three records of what is happening in a repo — git's HEAD, the event ledger, and the " +
				"leases the index holds — and report where they disagree. Catches a commit no collector logged, a " +
				"trail naming a commit this checkout has not fetched, a lease held by a session that ended, a lease " +
				"alive with no work behind it, work on a node nobody holds, and a held node whose dependency is not " +
				"done. Reports only; it changes nothing. A record that could not be read is listed in `unavailable`, " +
				"so an empty `findings` is not mistaken for agreement.",
			inputSchema: {
				repo: z.string().describe("owner/name, as the events record it."),
				path: z.string().optional().describe("Absolute path to a local checkout, to read HEAD from. Omitted means the tree is not compared."),
				git_tip: z.string().optional().describe("The tip sha, if you already know it. Cheaper than a path, and no filesystem is touched."),
				branch: z.string().optional(),
				idle_seconds: z
					.number()
					.int()
					.min(60)
					.optional()
					.describe(`How long a live lease may show no work before that is drift. Default ${DEFAULT_IDLE_SECONDS}.`),
				limit: z.number().int().min(1).max(2000).optional().describe("How many recent events to compare against."),
				format: z.enum(["json", "text"]).optional().describe("`text` for a few printable lines instead of the full report."),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ format, ...request }) => {
			const report = await substrate.driftScan(request);
			return format === "text" ? text(formatDrift(report)) : json(report);
		},
	);

	server.registerTool(
		"coord_reap_leases",
		{
			title: "Clear lapsed leases",
			description:
				"Clear every lease whose TTL has passed and record each release in the ledger. Expiry is already " +
				"honoured everywhere — a lapsed lease reads as free — so this is housekeeping that makes the " +
				"auto-release visible: the rows stop naming holders that are gone, and other agents see the warnings.",
			inputSchema: { repo: z.string().optional().describe("Narrow to one repo. Omitted means every graph in the index.") },
		},
		async ({ repo }) => json(await substrate.reapExpiredLeases(repo)),
	);

	return server;
}
