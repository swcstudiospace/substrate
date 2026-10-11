import { describe, expect, test } from "bun:test";
import { parseRoute } from "./options.ts";
import type { GraphNodeView, GraphView } from "./substrate.ts";
import { MemoryLeaseStore } from "./substrate.ts";
import { DEFAULT_TASK_GRAPH_DS, HostSync, LinearLink, NotionSync, SYNC_WRITABLE, syncProperty, syncTask } from "./sync.ts";
import { type HostSyncLike, MemoryTaskStore, type TaskRecord, TaskService, type TaskServiceDeps, type VmHandle } from "./tasks.ts";

const GID = "ut-a-12345678";
const NID = "n1";
const REPO = "swcstudiospace/agent-substrate";
const BRANCH = `substrate/${GID}`;
const PR_URL = `https://github.com/${REPO}/pull/41`;
const NOTION_KEY = "ntn_0123456789abcdefSECRETNOTIONKEY0123456789";
const LINEAR_KEY = "lin_api_0123456789abcdefSECRETLINEARKEY0123456789";
const PAGE_ID = "3e3bc1a0-c7ae-814c-bd4d-f349c98fb47e";
const ISSUE_ID = "11111111-2222-3333-4444-555555555555";

type Recorded = { url: string; method: string; headers: Record<string, string>; body: unknown };

/** A fetch fake: every request recorded; the reply picked by a route key `METHOD path-suffix`. */
function fakeFetch(replies: Record<string, (body: unknown) => { status?: number; body?: unknown } | undefined>) {
	const requests: Recorded[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = init?.method ?? "GET";
		const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}));
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
		requests.push({ url, method, headers, body });
		const key = Object.keys(replies).find((k) => {
			const [m, suffix] = k.split(" ", 2);
			return m === method && url.endsWith(suffix ?? "");
		});
		const reply = key ? replies[key]?.(body) : undefined;
		const status = reply?.status ?? (key ? 200 : 404);
		return new Response(JSON.stringify(reply?.body ?? { message: `no route for ${method} ${url}` }), {
			status,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	return { fetchImpl, requests };
}

function node(overrides: Partial<GraphNodeView> = {}): GraphNodeView {
	return {
		graph_id: GID,
		node_id: NID,
		linear_issue_id: ISSUE_ID,
		linear_identifier: "SWC-42",
		notion_page: null,
		state: "unstarted",
		claimed_by: "claude-code",
		claimed_at: null,
		claim_session: NID,
		...overrides,
	};
}

const TASK_ROW = { object: "list", results: [{ id: PAGE_ID, properties: { "PR URL": { type: "url", url: null } } }] };
const GRAPHQL_MUTATION_INTROSPECTION = { data: { __type: { fields: [{ name: "attachmentLinkURL" }, { name: "attachmentCreate" }, { name: "issueUpdate" }] } } };

function linearReply(body: unknown): { body: unknown } {
	const query = String((body as { query?: string })?.query ?? "");
	if (query.includes("__type")) return { body: GRAPHQL_MUTATION_INTROSPECTION };
	if (query.includes("attachments")) return { body: { data: { issue: { id: ISSUE_ID, attachments: { nodes: [{ url: PR_URL }] } } } } };
	if (query.includes("attachmentLinkURL")) return { body: { data: { attachmentLinkURL: { success: true } } } };
	return { body: { data: { issue: { id: ISSUE_ID } } } };
}

function hostSync(replies: Parameters<typeof fakeFetch>[0], opts: { notion?: boolean; linear?: boolean } = {}) {
	const f = fakeFetch(replies);
	const notion = opts.notion === false ? null : new NotionSync(NOTION_KEY, { fetchImpl: f.fetchImpl });
	const linear = opts.linear === false ? null : new LinearLink(LINEAR_KEY, { fetchImpl: f.fetchImpl });
	const logs: string[] = [];
	return { sync: new HostSync({ notion, linear, log: (line) => logs.push(line) }), requests: f.requests, logs };
}

const PR_INPUT = { graphId: GID, nodeId: NID, prUrl: PR_URL, prNumber: 41, repo: REPO, branch: BRANCH, node: node() };

describe("HostSync.syncPr (D-10, T-03-07-03)", () => {
	test("Task row found: one data-source query with Level=Task and Graph ID, then one PATCH of exactly the five PR properties", async () => {
		const h = hostSync({
			[`POST /v1/data_sources/${DEFAULT_TASK_GRAPH_DS}/query`]: () => ({ body: TASK_ROW }),
			[`PATCH /v1/pages/${PAGE_ID}`]: () => ({ body: { id: PAGE_ID } }),
			"POST /graphql": linearReply,
		});
		const result = await h.sync.syncPr(PR_INPUT);
		expect(result.notion).toBe("updated");
		const notion = h.requests.filter((r) => r.url.includes("notion.com"));
		expect(notion.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
			`POST /v1/data_sources/${DEFAULT_TASK_GRAPH_DS}/query`,
			`PATCH /v1/pages/${PAGE_ID}`,
		]);
		expect(notion[0]?.headers["Notion-Version"]).toBe("2025-09-03");
		expect(notion[0]?.body).toEqual({
			filter: { and: [{ property: "Level", select: { equals: "Task" } }, { property: "Graph ID", rich_text: { equals: GID } }] },
			page_size: 1,
		});
		expect(notion[1]?.body).toEqual({
			properties: {
				"PR URL": { url: PR_URL },
				"PR #": { number: 41 },
				"PR State": { select: { name: "Open" } },
				Repo: { rich_text: [{ text: { content: REPO } }] },
				Branch: { rich_text: [{ text: { content: BRANCH } }] },
			},
		});
		expect(Object.keys((notion[1]?.body as { properties: object }).properties).sort()).toEqual([...SYNC_WRITABLE].sort());
	});

	test("no Task row → no PATCH and notion no_task_row; Notion 500 → failed:500; the Linear half still runs either way", async () => {
		const empty = hostSync({
			[`POST /v1/data_sources/${DEFAULT_TASK_GRAPH_DS}/query`]: () => ({ body: { results: [] } }),
			"POST /graphql": linearReply,
		});
		const result = await empty.sync.syncPr(PR_INPUT);
		expect(result).toEqual({ notion: "no_task_row", linear: "attached" });
		expect(empty.requests.some((r) => r.method === "PATCH")).toBe(false);

		const down = hostSync({
			[`POST /v1/data_sources/${DEFAULT_TASK_GRAPH_DS}/query`]: () => ({ status: 500, body: { message: "boom" } }),
			"POST /graphql": linearReply,
		});
		const failed = await down.sync.syncPr(PR_INPUT);
		expect(failed).toEqual({ notion: "failed:500", linear: "attached" });
		expect(down.requests.some((r) => r.url.includes("/graphql") && String((r.body as { query: string }).query).includes("attachmentLinkURL"))).toBe(true);
	});

	test("Linear: one attachment mutation on the node's issue with the PR URL and title PR #<n>; no issueUpdate and no stateId anywhere; node without a reference → no_issue_ref", async () => {
		const h = hostSync({
			[`POST /v1/data_sources/${DEFAULT_TASK_GRAPH_DS}/query`]: () => ({ body: { results: [] } }),
			"POST /graphql": linearReply,
		});
		const result = await h.sync.syncPr(PR_INPUT);
		expect(result.linear).toBe("attached");
		const linear = h.requests.filter((r) => r.url.endsWith("/graphql"));
		const mutations = linear.filter((r) => String((r.body as { query: string }).query).trimStart().startsWith("mutation"));
		expect(mutations).toHaveLength(1);
		const mutation = mutations[0]?.body as { query: string; variables: Record<string, unknown> };
		expect(mutation.query).toContain("attachmentLinkURL");
		expect(mutation.variables).toEqual({ issueId: ISSUE_ID, url: PR_URL, title: "PR #41" });
		for (const r of linear) {
			const text = JSON.stringify(r.body);
			expect(text).not.toContain("issueUpdate");
			expect(text).not.toContain("stateId");
		}
		// Raw key, no Bearer (the mcp-server's Linear rule).
		expect(linear[0]?.headers.Authorization).toBe(LINEAR_KEY);

		const byIdentifier = hostSync({
			[`POST /v1/data_sources/${DEFAULT_TASK_GRAPH_DS}/query`]: () => ({ body: { results: [] } }),
			"POST /graphql": linearReply,
		});
		await byIdentifier.sync.syncPr({ ...PR_INPUT, node: node({ linear_issue_id: null }) });
		const resolved = byIdentifier.requests.filter((r) => r.url.endsWith("/graphql")).map((r) => (r.body as { variables: Record<string, unknown> }).variables);
		expect(resolved.some((v) => v.id === "SWC-42")).toBe(true);

		const noRef = hostSync({ [`POST /v1/data_sources/${DEFAULT_TASK_GRAPH_DS}/query`]: () => ({ body: { results: [] } }) });
		const missing = await noRef.sync.syncPr({ ...PR_INPUT, node: node({ linear_issue_id: null, linear_identifier: null }) });
		expect(missing.linear).toBe("no_issue_ref");
		expect(noRef.requests.some((r) => r.url.endsWith("/graphql"))).toBe(false);
	});

	test("a property outside SYNC_WRITABLE is refused before any request", async () => {
		const f = fakeFetch({});
		const notion = new NotionSync(NOTION_KEY, { fetchImpl: f.fetchImpl });
		await expect(notion.updateTaskRow(PAGE_ID, { "PR URL": { url: PR_URL }, Status: { select: { name: "Done" } } })).rejects.toThrow(/Status/);
		expect(f.requests).toEqual([]);
		expect(() => syncProperty("Status" as never, "Done")).toThrow(/Status/);
		expect(SYNC_WRITABLE).toEqual(["PR URL", "PR #", "PR State", "Repo", "Branch"]);
	});

	test("neither key appears in any returned result, log line or thrown message", async () => {
		const echo = hostSync({
			[`POST /v1/data_sources/${DEFAULT_TASK_GRAPH_DS}/query`]: () => ({ status: 401, body: { message: `bad token ${NOTION_KEY}` } }),
			"POST /graphql": () => ({ status: 401, body: { errors: [{ message: `bad key ${LINEAR_KEY}` }] } }),
		});
		const result = await echo.sync.syncPr(PR_INPUT);
		expect(result).toEqual({ notion: "failed:401", linear: "failed:401" });
		const everything = JSON.stringify(result) + echo.logs.join("\n");
		expect(everything).not.toContain(NOTION_KEY);
		expect(everything).not.toContain(LINEAR_KEY);
		const f = fakeFetch({ "POST /query": () => ({ status: 403, body: { message: `x ${NOTION_KEY}` } }) });
		const thrown = await new NotionSync(NOTION_KEY, { fetchImpl: f.fetchImpl }).findTaskRow(GID).catch((e: Error) => e.message);
		expect(String(thrown)).toContain("403");
		expect(String(thrown)).not.toContain(NOTION_KEY);
	});

	test("without a configured tracker the half reports failed:unconfigured and nothing is requested", async () => {
		const h = hostSync({}, { notion: false, linear: false });
		expect(await h.sync.syncPr(PR_INPUT)).toEqual({ notion: "failed:unconfigured", linear: "failed:unconfigured" });
		expect(h.requests).toEqual([]);
	});
});

describe("HostSync.verifyModelSync (read-only, sync_by model_mcp)", () => {
	test("one data-source query and one attachments read; true only when the row holds the PR URL / the issue lists it; never a PATCH or mutation", async () => {
		const both = hostSync({
			[`POST /v1/data_sources/${DEFAULT_TASK_GRAPH_DS}/query`]: () => ({ body: { results: [{ id: PAGE_ID, properties: { "PR URL": { type: "url", url: PR_URL } } }] } }),
			"POST /graphql": linearReply,
		});
		expect(await both.sync.verifyModelSync({ graphId: GID, node: node(), prUrl: PR_URL })).toEqual({ notion: true, linear: true });
		expect(both.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([`POST /v1/data_sources/${DEFAULT_TASK_GRAPH_DS}/query`, "POST /graphql"]);
		expect(String((both.requests[1]?.body as { query: string }).query).trimStart().startsWith("query")).toBe(true);

		const neither = hostSync({
			[`POST /v1/data_sources/${DEFAULT_TASK_GRAPH_DS}/query`]: () => ({ body: { results: [{ id: PAGE_ID, properties: { "PR URL": { type: "url", url: null } } }] } }),
			"POST /graphql": () => ({ body: { data: { issue: { id: ISSUE_ID, attachments: { nodes: [{ url: "https://github.com/x/y/pull/1" }] } } } } }),
		});
		expect(await neither.sync.verifyModelSync({ graphId: GID, node: node(), prUrl: PR_URL })).toEqual({ notion: false, linear: false });
		expect(neither.requests.some((r) => r.method === "PATCH" || String((r.body as { query?: string })?.query ?? "").includes("mutation"))).toBe(false);

		const noRef = hostSync({ [`POST /v1/data_sources/${DEFAULT_TASK_GRAPH_DS}/query`]: () => ({ body: { results: [] } }) });
		expect(await noRef.sync.verifyModelSync({ graphId: GID, node: node({ linear_issue_id: null, linear_identifier: null }), prUrl: PR_URL })).toEqual({ notion: false, linear: false });
	});
});

function record(overrides: Partial<TaskRecord> = {}): TaskRecord {
	return {
		graph_id: GID,
		node_id: NID,
		identifier: "SWC-42",
		repo: REPO,
		session_id: NID,
		prompt_count: 1,
		turn_in_flight: true,
		last_stop_reason: null,
		exit_code: null,
		released: false,
		pending_approvals: [],
		opened_at: "2026-09-25T00:00:00Z",
		last_error: null,
		seeded: [],
		resumes: 0,
		stale_approvals: 0,
		pr_url: PR_URL,
		pr_number: 41,
		synced_at: null,
		sync_by: null,
		approvals_allowed: 0,
		approvals_denied: 0,
		...overrides,
	};
}

const GRAPH: GraphView = { graph_id: GID, repo: REPO, branch: "main", nodes: [node()] };

/** A HostSync fake recording calls; verify answers as configured. */
function fakeSync(opts: { verify?: { notion: boolean; linear: boolean } } = {}) {
	const calls: string[] = [];
	return {
		calls,
		sync: {
			syncPr: async (input: { graphId: string; nodeId: string; prUrl: string }) => {
				calls.push(`syncPr:${input.graphId}/${input.nodeId}:${input.prUrl}`);
				return { notion: "updated" as const, linear: "attached" as const };
			},
			verifyModelSync: async (input: { graphId: string; prUrl: string }) => {
				calls.push(`verify:${input.graphId}:${input.prUrl}`);
				return opts.verify ?? { notion: false, linear: false };
			},
		},
	};
}

describe("sync host function (T-03-07-04)", () => {
	test("rejects a --pr-url that differs from the recorded pr_url; on success records synced_at and sync_by model", async () => {
		const store = new MemoryTaskStore();
		store.save(record());
		const fake = fakeSync();
		const deps = { graphId: GID, nodeId: NID, store, substrate: { graphGet: async () => GRAPH }, sync: fake.sync, now: () => new Date("2026-09-25T12:00:00Z") };
		expect(await syncTask({ ...deps, prUrl: "https://github.com/swcstudiospace/agent-substrate/pull/999" })).toEqual({
			error: "pr-url does not match the pull request recorded for this task",
		});
		expect(fake.calls).toEqual([]);
		expect(await syncTask({ ...deps, prUrl: PR_URL })).toEqual({ notion: "updated", linear: "attached", synced_at: "2026-09-25T12:00:00.000Z", sync_by: "model" });
		expect(fake.calls).toEqual([`syncPr:${GID}/${NID}:${PR_URL}`]);
		expect(store.get(GID, NID)?.synced_at).toBe("2026-09-25T12:00:00.000Z");
		expect(store.get(GID, NID)?.sync_by).toBe("model");
		// No PR recorded yet → nothing to sync.
		store.save(record({ pr_url: null, pr_number: null, synced_at: null, sync_by: null }));
		expect(await syncTask({ ...deps, prUrl: PR_URL })).toEqual({ error: "no pull request recorded for this task yet (run pr-create first)" });
	});
});

/** TaskService with a store holding one record and a prompt that settles on demand. */
function serviceWith(routeValue: string, sync: HostSyncLike, rec: TaskRecord) {
	const store = new MemoryTaskStore();
	store.save(rec);
	let pending = Promise.withResolvers<{ stopReason: string }>();
	const handle = {
		filesystem: { mkdir: async () => {}, writeFile: async () => {}, readFile: async () => new Uint8Array() },
		sessions: {
			open: async () => {},
			prompt: () => {
				pending = Promise.withResolvers<{ stopReason: string }>();
				return pending.promise;
			},
			get: async () => ({ state: { status: "idle" }, latestSequence: 1 }),
			readHistory: async () => ({ events: [] }),
			cancelPrompt: async () => ({}),
			unload: async () => {},
		},
	} as unknown as VmHandle;
	const logs: string[] = [];
	const deps: TaskServiceDeps = {
		substrate: {
			graphGet: async () => GRAPH,
			graphClaim: async () => ({ claimed: true }),
			claimAndPersist: async () => ({ claimed: true }),
			heartbeat: async () => ({ ok: true }),
			graphComplete: async () => ({ completed: true }),
			graphRelease: async () => ({}),
			brief: async () => "",
		},
		vmFor: () => handle,
		store,
		leases: new MemoryLeaseStore(),
		ensureModelRoute: async () => {},
		route: parseRoute(routeValue),
		testsRoute: "sandbox",
		model: "grok-4.6",
		skills: [],
		trackers: { notionDataSourceUrl: "collection://x", linearTeam: "SWC" },
		sync,
		log: (line) => logs.push(line),
		now: () => new Date("2026-09-25T12:00:00Z"),
	};
	const service = new TaskService(deps);
	const settle = async (stopReason = "end_turn") => {
		service.startPrompt(handle, store.get(GID, NID) as TaskRecord, "go", `${GID}:${NID}:${Math.random()}`);
		pending.resolve({ stopReason });
		await service.turns.get(`${GID}/${NID}`);
	};
	return { service, store, logs, settle };
}

describe("sync backstop on turn settle (D-10)", () => {
	test("tracker_route vm_mcp: verifyModelSync first; both true → sync_by model_mcp with no write; otherwise syncPr once with sync_by host; a second settle does not re-run", async () => {
		const verified = fakeSync({ verify: { notion: true, linear: true } });
		const a = serviceWith("a:loopback,b:hooks,c:hostfn_commit,s:mcp", verified.sync, record());
		await a.settle();
		expect(verified.calls).toEqual([`verify:${GID}:${PR_URL}`]);
		expect(a.store.get(GID, NID)?.sync_by).toBe("model_mcp");
		expect(a.store.get(GID, NID)?.synced_at).toBe("2026-09-25T12:00:00.000Z");
		expect(a.logs).toContain(`[substrate-host] sync by model (mcp) for ${GID}/${NID}`);
		await a.settle();
		expect(verified.calls).toHaveLength(1);

		const unverified = fakeSync({ verify: { notion: true, linear: false } });
		const b = serviceWith("a:loopback,b:hooks,c:hostfn_commit,s:mcp", unverified.sync, record());
		await b.settle();
		expect(unverified.calls).toEqual([`verify:${GID}:${PR_URL}`, `syncPr:${GID}/${NID}:${PR_URL}`]);
		expect(b.store.get(GID, NID)?.sync_by).toBe("host");
		expect(b.logs).toContain(`[substrate-host] sync by host for ${GID}/${NID}`);
		await b.settle();
		expect(unverified.calls).toHaveLength(2);
	});

	test("tracker_route host: syncPr once with sync_by host and the log line; not without a pr_url; not when already synced; not during shutdown", async () => {
		const fake = fakeSync();
		const a = serviceWith("a:loopback,b:prompt_hostfn,c:hostfn_commit,s:hostfn", fake.sync, record());
		await a.settle();
		expect(fake.calls).toEqual([`syncPr:${GID}/${NID}:${PR_URL}`]);
		expect(a.store.get(GID, NID)?.sync_by).toBe("host");
		expect(a.logs).toContain(`[substrate-host] sync by host for ${GID}/${NID}`);
		await a.settle("end_turn");
		expect(fake.calls).toHaveLength(1);

		const noPr = fakeSync();
		const b = serviceWith("a:loopback,b:host_after_turn,c:hostfn_commit,s:hostfn", noPr.sync, record({ pr_url: null, pr_number: null }));
		await b.settle();
		expect(noPr.calls).toEqual([]);

		const already = fakeSync();
		const c = serviceWith("a:loopback,b:prompt_hostfn,c:hostfn_commit,s:hostfn", already.sync, record({ synced_at: "2026-09-25T11:00:00Z", sync_by: "model" }));
		await c.settle();
		expect(already.calls).toEqual([]);
		expect(c.store.get(GID, NID)?.sync_by).toBe("model");
	});
});
