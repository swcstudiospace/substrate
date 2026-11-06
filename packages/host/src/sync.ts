// D-10 sync on the host (the deviation 03-01's tracker_route=host selects, and the backstop on
// every route): after a PR opens, the graph's Notion Task row gets PR URL, PR #, PR State (Open),
// Repo and Branch and the node's Linear issue gets the PR link — nothing else. No Linear workflow
// state and no Notion Status ever move here: Done comes only from graph_complete through the DoD
// gate (Phase 2 D-06/D-07, research Pitfall 7; T-03-07-03). No rivet import; fetch is injected.
//
// Keys come from the unit's EnvironmentFile (NOTION_API_KEY, LINEAR_API_KEY) and stay in this
// process (D-08). Error messages carry a status and at most 200 redacted characters of the body,
// never a header.

import { redact } from "../../mcp-server/src/redact.ts";
import type { GraphNodeView, GraphView } from "./substrate.ts";
import type { TaskRecord } from "./tasks.ts";

/** The only Notion properties sync may write (ultrathink-sync's "PR opened" row, nothing terminal). */
export const SYNC_WRITABLE = ["PR URL", "PR #", "PR State", "Repo", "Branch"] as const;
type SyncWritable = (typeof SYNC_WRITABLE)[number];

export const DEFAULT_TASK_GRAPH_DS = "be3418f0-d2d8-411b-8677-fa8a95ee63be";
const NOTION_VERSION = "2025-09-03";
const NOTION_BASE_URL = "https://api.notion.com/v1";
const LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const DEFAULT_TIMEOUT_MS = 10_000;
const BODY_LIMIT = 200;

class SyncError extends Error {
	/** HTTP status, or null when no response arrived. */
	readonly status: number | null;

	constructor(message: string, status: number | null = null) {
		super(message);
		this.status = status;
	}
}

function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/** The PATCH value for one writable property; the type is the schema's (02-NOTION-SCHEMA.md). */
export function syncProperty(name: SyncWritable, value: string | number): Record<string, unknown> {
	switch (name) {
		case "PR URL":
			return { url: String(value) };
		case "PR #":
			return { number: Number(value) };
		case "PR State":
			return { select: { name: String(value) } };
		case "Repo":
		case "Branch":
			return { rich_text: [{ text: { content: String(value) } }] };
		default:
			throw new SyncError(`refusing to write ${String(name)}: sync writes only ${SYNC_WRITABLE.join(", ")}`);
	}
}

type TaskRow = { id: string; prUrl: string | null };

/** Notion data-source query + page PATCH, limited to SYNC_WRITABLE. */
export class NotionSync {
	readonly #apiKey: string;
	readonly #fetchImpl: typeof fetch;
	readonly #timeoutMs: number;
	readonly #baseUrl: string;
	readonly dataSourceId: string;

	constructor(apiKey: string, opts: { dataSourceId?: string | undefined; fetchImpl?: typeof fetch | undefined; timeoutMs?: number; baseUrl?: string } = {}) {
		this.#apiKey = apiKey;
		this.#fetchImpl = opts.fetchImpl ?? fetch;
		this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.#baseUrl = (opts.baseUrl ?? NOTION_BASE_URL).replace(/\/+$/, "");
		this.dataSourceId = opts.dataSourceId ?? DEFAULT_TASK_GRAPH_DS;
	}

	/** null when NOTION_API_KEY is unset; the data source from NOTION_TASK_GRAPH_DS or the schema's id. */
	static fromEnv(env: Record<string, string | undefined>, opts: { fetchImpl?: typeof fetch } = {}): NotionSync | null {
		const key = env.NOTION_API_KEY?.trim();
		if (!key) return null;
		return new NotionSync(key, { dataSourceId: env.NOTION_TASK_GRAPH_DS?.trim() || undefined, fetchImpl: opts.fetchImpl });
	}

	async #request(method: "POST" | "PATCH", path: string, body: unknown): Promise<unknown> {
		let response: Response;
		try {
			response = await this.#fetchImpl(`${this.#baseUrl}${path}`, {
				method,
				headers: { Authorization: `Bearer ${this.#apiKey}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(this.#timeoutMs),
			});
		} catch (cause) {
			throw new SyncError(`notion unreachable: ${redact(messageOf(cause)).slice(0, BODY_LIMIT)}`);
		}
		const text = await response.text();
		if (!response.ok) throw new SyncError(`notion ${response.status}: ${redact(text).slice(0, BODY_LIMIT)}`, response.status);
		try {
			return JSON.parse(text);
		} catch {
			throw new SyncError(`notion returned non-JSON: ${redact(text).slice(0, BODY_LIMIT)}`, response.status);
		}
	}

	/** The graph's Task row (Level = Task, Graph ID = gid), or null. One query, never a write. */
	async findTaskRow(graphId: string): Promise<TaskRow | null> {
		const reply = (await this.#request("POST", `/data_sources/${this.dataSourceId}/query`, {
			filter: { and: [{ property: "Level", select: { equals: "Task" } }, { property: "Graph ID", rich_text: { equals: graphId } }] },
			page_size: 1,
		})) as { results?: Array<{ id?: string; properties?: Record<string, { url?: unknown }> }> };
		const row = reply.results?.[0];
		if (!row || typeof row.id !== "string") return null;
		const url = row.properties?.["PR URL"]?.url;
		return { id: row.id, prUrl: typeof url === "string" ? url : null };
	}

	/** One PATCH of shaped values; a property outside SYNC_WRITABLE is refused before any request. */
	async updateTaskRow(pageId: string, properties: Record<string, unknown>): Promise<void> {
		const refused = Object.keys(properties).filter((name) => !(SYNC_WRITABLE as readonly string[]).includes(name));
		if (refused.length > 0) throw new SyncError(`refusing to write ${refused.join(", ")}: sync writes only ${SYNC_WRITABLE.join(", ")}`);
		await this.#request("PATCH", `/pages/${pageId}`, { properties });
	}
}

type AttachMutation = "attachmentLinkURL" | "attachmentCreate";

/** Linear GraphQL: attach a link to an issue; read its attachments. Never issueUpdate, never a state. */
export class LinearLink {
	readonly #apiKey: string;
	readonly #fetchImpl: typeof fetch;
	readonly #timeoutMs: number;
	readonly #endpoint: string;
	#mutation: AttachMutation | null | undefined;

	constructor(apiKey: string, opts: { fetchImpl?: typeof fetch | undefined; timeoutMs?: number; endpoint?: string } = {}) {
		this.#apiKey = apiKey;
		this.#fetchImpl = opts.fetchImpl ?? fetch;
		this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.#endpoint = opts.endpoint ?? LINEAR_ENDPOINT;
	}

	static fromEnv(env: Record<string, string | undefined>, opts: { fetchImpl?: typeof fetch } = {}): LinearLink | null {
		const key = env.LINEAR_API_KEY?.trim();
		if (!key) return null;
		return new LinearLink(key, { fetchImpl: opts.fetchImpl });
	}

	async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
		let response: Response;
		try {
			response = await this.#fetchImpl(this.#endpoint, {
				method: "POST",
				// Linear personal API keys go in raw; `Bearer ` is for OAuth tokens (mcp-server/src/linear.ts).
				headers: { Authorization: this.#apiKey, "Content-Type": "application/json" },
				body: JSON.stringify({ query, variables }),
				signal: AbortSignal.timeout(this.#timeoutMs),
			});
		} catch (cause) {
			throw new SyncError(`linear unreachable: ${redact(messageOf(cause)).slice(0, BODY_LIMIT)}`);
		}
		const text = await response.text();
		if (!response.ok) throw new SyncError(`linear ${response.status}: ${redact(text).slice(0, BODY_LIMIT)}`, response.status);
		let body: { data?: T; errors?: Array<{ message?: string }> };
		try {
			body = JSON.parse(text);
		} catch {
			throw new SyncError(`linear returned non-JSON: ${redact(text).slice(0, BODY_LIMIT)}`, response.status);
		}
		if (body.errors?.length) {
			throw new SyncError(`linear: ${redact(body.errors.map((e) => e.message ?? "unknown error").join("; ")).slice(0, BODY_LIMIT)}`, response.status);
		}
		if (!body.data) throw new SyncError("linear returned no data", response.status);
		return body.data;
	}

	/** One read-only introspection of Mutation, cached for the process: attachmentLinkURL, else attachmentCreate, else null. */
	async attachMutation(): Promise<AttachMutation | null> {
		if (this.#mutation !== undefined) return this.#mutation;
		const data = await this.graphql<{ __type: { fields: Array<{ name: string }> } | null }>(
			`query AttachMutation { __type(name: "Mutation") { fields { name } } }`,
			{},
		);
		const names = new Set((data.__type?.fields ?? []).map((f) => f.name));
		this.#mutation = names.has("attachmentLinkURL") ? "attachmentLinkURL" : names.has("attachmentCreate") ? "attachmentCreate" : null;
		return this.#mutation;
	}

	/** The issue's id and attachment URLs; `ref` is a UUID or an identifier like SWC-12. Read-only. */
	async attachments(ref: string): Promise<{ id: string; urls: string[] }> {
		const data = await this.graphql<{ issue: { id: string; attachments: { nodes: Array<{ url: string }> } } | null }>(
			`query IssueAttachments($id: String!) { issue(id: $id) { id attachments { nodes { url } } } }`,
			{ id: ref },
		);
		if (!data.issue) throw new SyncError(`issue ${ref} not found`);
		return { id: data.issue.id, urls: data.issue.attachments.nodes.map((n) => n.url) };
	}

	/** Attach one link to the issue. The only mutation this module ever sends. */
	async attachLink(ref: string, url: string, title: string): Promise<void> {
		const mutation = await this.attachMutation();
		if (!mutation) throw new SyncError("linear exposes no attachment mutation");
		const issueId = /^[0-9a-f-]{36}$/i.test(ref)
			? ref
			: (await this.graphql<{ issue: { id: string } | null }>(`query IssueId($id: String!) { issue(id: $id) { id } }`, { id: ref })).issue?.id;
		if (!issueId) throw new SyncError(`issue ${ref} not found`);
		if (mutation === "attachmentLinkURL") {
			await this.graphql(
				`mutation AttachPr($issueId: String!, $url: String!, $title: String) { attachmentLinkURL(issueId: $issueId, url: $url, title: $title) { success } }`,
				{ issueId, url, title },
			);
			return;
		}
		await this.graphql(
			`mutation AttachPr($input: AttachmentCreateInput!) { attachmentCreate(input: $input) { success } }`,
			{ input: { issueId, url, title } },
		);
	}
}

type NotionSyncResult = "updated" | "no_task_row" | `failed:${string}`;
type LinearSyncResult = "attached" | "no_issue_ref" | `failed:${string}`;
type SyncResult = { notion: NotionSyncResult; linear: LinearSyncResult };

type SyncPrInput = {
	graphId: string;
	nodeId: string;
	prUrl: string;
	prNumber: number;
	repo: string;
	branch: string;
	node: Pick<GraphNodeView, "linear_issue_id" | "linear_identifier">;
};

type VerifyInput = { graphId: string; node: Pick<GraphNodeView, "linear_issue_id" | "linear_identifier">; prUrl: string };

function failure(cause: unknown): `failed:${string}` {
	if (cause instanceof SyncError && cause.status !== null) return `failed:${cause.status}`;
	return `failed:${redact(messageOf(cause)).slice(0, 80)}`;
}

/** The host's sync (sync_by host, or model through the sync host function) and its read-only verification (model_mcp). */
export class HostSync {
	readonly notion: NotionSync | null;
	readonly linear: LinearLink | null;
	readonly log: (line: string) => void;

	constructor(opts: { notion: NotionSync | null; linear: LinearLink | null; log?: (line: string) => void }) {
		this.notion = opts.notion;
		this.linear = opts.linear;
		this.log = opts.log ?? ((line) => process.stdout.write(`${line}\n`));
	}

	/** Never throws: each half reports its own outcome; a failed Notion half never stops the Linear half. */
	async syncPr(input: SyncPrInput): Promise<SyncResult> {
		const key = `${input.graphId}/${input.nodeId}`;
		let notion: NotionSyncResult;
		if (!this.notion) {
			notion = "failed:unconfigured";
		} else {
			try {
				const row = await this.notion.findTaskRow(input.graphId);
				if (!row) {
					notion = "no_task_row";
				} else {
					await this.notion.updateTaskRow(row.id, {
						"PR URL": syncProperty("PR URL", input.prUrl),
						"PR #": syncProperty("PR #", input.prNumber),
						"PR State": syncProperty("PR State", "Open"),
						Repo: syncProperty("Repo", input.repo),
						Branch: syncProperty("Branch", input.branch),
					});
					notion = "updated";
				}
			} catch (cause) {
				notion = failure(cause);
				this.log(`[substrate-host] sync notion ${key}: ${notion}`);
			}
		}

		let linear: LinearSyncResult;
		const ref = input.node.linear_issue_id ?? input.node.linear_identifier;
		if (!this.linear) {
			linear = "failed:unconfigured";
		} else if (!ref) {
			linear = "no_issue_ref";
		} else {
			try {
				await this.linear.attachLink(ref, input.prUrl, `PR #${input.prNumber}`);
				linear = "attached";
			} catch (cause) {
				linear = failure(cause);
				this.log(`[substrate-host] sync linear ${key}: ${linear}`);
			}
		}
		return { notion, linear };
	}

	/** Read-only: true per tracker only when it already holds this PR URL. Never a PATCH, never a mutation. */
	async verifyModelSync(input: VerifyInput): Promise<{ notion: boolean; linear: boolean }> {
		let notion = false;
		if (this.notion) {
			try {
				const row = await this.notion.findTaskRow(input.graphId);
				notion = row?.prUrl === input.prUrl;
			} catch (cause) {
				this.log(`[substrate-host] verify notion ${input.graphId}: ${failure(cause)}`);
			}
		}
		let linear = false;
		const ref = input.node.linear_issue_id ?? input.node.linear_identifier;
		if (this.linear && ref) {
			try {
				linear = (await this.linear.attachments(ref)).urls.includes(input.prUrl);
			} catch (cause) {
				this.log(`[substrate-host] verify linear ${input.graphId}: ${failure(cause)}`);
			}
		}
		return { notion, linear };
	}
}

type SyncTaskInput = {
	graphId: string;
	nodeId: string;
	prUrl: string;
	store: { get(graphId: string, nodeId: string): TaskRecord | null; save(record: TaskRecord): void };
	substrate: { graphGet(graphId: string): Promise<GraphView | null> };
	sync: Pick<HostSync, "syncPr">;
	now?: () => Date;
};

type SyncTaskResult = (SyncResult & { synced_at: string; sync_by: "model" }) | { error: string };

/**
 * `agentos-substrate sync --node <nid> --pr-url <url>` (tracker_route host, b:hooks or
 * b:prompt_hostfn): the URL must be the one the host's own pr-create recorded (T-03-07-04); on a
 * run with no failed half the record gets synced_at and sync_by "model".
 */
export async function syncTask(input: SyncTaskInput): Promise<SyncTaskResult> {
	const record = input.store.get(input.graphId, input.nodeId);
	if (!record) return { error: `no task for node ${input.nodeId} in this VM` };
	if (!record.pr_url || record.pr_number === null) return { error: "no pull request recorded for this task yet (run pr-create first)" };
	if (input.prUrl !== record.pr_url) return { error: "pr-url does not match the pull request recorded for this task" };
	const graph = await input.substrate.graphGet(input.graphId);
	if (!graph) return { error: `graph ${input.graphId} is not registered` };
	const node = graph.nodes?.find((n) => n.node_id === input.nodeId);
	if (!node) return { error: `graph ${input.graphId} has no node ${input.nodeId}` };
	const result = await input.sync.syncPr({
		graphId: input.graphId,
		nodeId: input.nodeId,
		prUrl: record.pr_url,
		prNumber: record.pr_number,
		repo: graph.repo ?? record.repo,
		branch: `substrate/${input.graphId}`,
		node,
	});
	if (result.notion.startsWith("failed:") || result.linear.startsWith("failed:")) {
		return { error: `sync failed: notion ${result.notion}, linear ${result.linear}` };
	}
	const syncedAt = (input.now ?? (() => new Date()))().toISOString();
	const fresh = input.store.get(input.graphId, input.nodeId) ?? record;
	fresh.synced_at = syncedAt;
	fresh.sync_by = "model";
	input.store.save(fresh);
	return { ...result, synced_at: syncedAt, sync_by: "model" };
}
