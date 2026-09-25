import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";
import { LinearClient } from "./linear.ts";
import { createMirror, Mirror, type MirrorContext } from "./mirror.ts";
import { NotionClient } from "./notion.ts";
import type { GraphNode } from "./types.ts";

const KEY = "lin_api_test_key_0123456789";
const TEAM = "team-swc";

interface Recorded {
	op: string;
	variables: Record<string, unknown>;
	authorization: string | null;
}

interface FakeLinear {
	labels?: Array<{ id: string; name: string; team: { id: string } | null }>;
	issueLabels?: Array<{ id: string; name: string }>;
	comments?: string[];
}

/** A Linear stand-in that records every request and answers by GraphQL operation name. */
function fakeLinear(state: FakeLinear = {}) {
	const requests: Recorded[] = [];
	const fetchImpl = (async (_url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
		const op = /(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1] ?? "unknown";
		const headers = init.headers as Record<string, string>;
		requests.push({ op, variables: body.variables, authorization: headers.Authorization ?? null });
		const reply = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
		switch (op) {
			case "IssueContext":
				return reply({
					issue: {
						id: "issue-uuid",
						identifier: "SWC-7",
						team: {
							id: TEAM,
							key: "SWC",
							states: {
								nodes: [
									{ id: "st-todo", name: "Todo", type: "unstarted" },
									{ id: "st-review", name: "In Review", type: "started" },
									{ id: "st-progress", name: "In Progress", type: "started" },
									{ id: "st-done", name: "Done", type: "completed" },
								],
							},
						},
						labels: { nodes: state.issueLabels ?? [] },
						comments: { nodes: (state.comments ?? []).map((body) => ({ body })) },
					},
				});
			case "Labels":
				return reply({
					issueLabels: {
						nodes: (state.labels ?? []).filter((l) => l.name === (body.variables.name as string)),
					},
				});
			case "LabelCreate":
				return reply({ issueLabelCreate: { success: true, issueLabel: { id: "lbl-created" } } });
			case "IssueUpdate":
				return reply({ issueUpdate: { success: true } });
			case "CommentCreate":
				return reply({ commentCreate: { success: true } });
			default:
				return new Response("unknown op", { status: 400 });
		}
	}) as unknown as typeof fetch;
	return { requests, fetchImpl, client: new LinearClient(KEY, { fetchImpl }) };
}

function node(overrides: Partial<GraphNode> = {}): GraphNode {
	return {
		graph_id: "ut-1",
		node_id: "n1",
		linear_issue_id: "issue-uuid",
		linear_identifier: "SWC-7",
		notion_page: null,
		state: "unstarted",
		claimed_by: "hermes",
		claimed_at: null,
		claim_session: "sess-1",
		...overrides,
	};
}

function ctx(overrides: Partial<MirrorContext> = {}): MirrorContext {
	return {
		graphId: "ut-1",
		nodeId: "n1",
		surface: "hermes",
		sessionId: "sess-1",
		node: node(),
		repo: "swcstudiospace/agent-substrate",
		branch: "main",
		...overrides,
	};
}

function only(requests: Recorded[], op: string): Recorded[] {
	return requests.filter((r) => r.op === op);
}

describe("Mirror.claim → Linear", () => {
	test("moves to In Progress by name, never the other started state (In Review)", async () => {
		// Regression guard: In Progress and In Review are both type `started`; a
		// lookup by type would pick whichever came first.
		const { requests, client } = fakeLinear({ labels: [{ id: "lbl-team", name: "agent:hermes", team: { id: TEAM } }] });
		const failures = await new Mirror({ linear: client }).claim(ctx());

		expect(failures).toEqual([]);
		const updates = only(requests, "IssueUpdate");
		expect(updates).toHaveLength(1);
		const input = updates[0]!.variables.input as Record<string, unknown>;
		expect(input.stateId).toBe("st-progress");
		expect(input.stateId).not.toBe("st-review");
	});

	test("reuses the team's own agent label without creating one", async () => {
		const { requests, client } = fakeLinear({
			labels: [
				{ id: "lbl-other-team", name: "agent:hermes", team: { id: "team-other" } },
				{ id: "lbl-team", name: "agent:hermes", team: { id: TEAM } },
			],
		});
		await new Mirror({ linear: client }).claim(ctx());

		expect(only(requests, "LabelCreate")).toHaveLength(0);
		const input = only(requests, "IssueUpdate")[0]!.variables.input as Record<string, unknown>;
		expect(input.addedLabelIds).toEqual(["lbl-team"]);
	});

	test("reuses a workspace label (team null) of the same name", async () => {
		const { requests, client } = fakeLinear({
			labels: [{ id: "lbl-workspace", name: "agent:hermes", team: null }],
		});
		await new Mirror({ linear: client }).claim(ctx());

		expect(only(requests, "LabelCreate")).toHaveLength(0);
		const input = only(requests, "IssueUpdate")[0]!.variables.input as Record<string, unknown>;
		expect(input.addedLabelIds).toEqual(["lbl-workspace"]);
	});

	test("creates the agent label on the issue's team when absent, without replaceTeamLabels", async () => {
		const { requests, client } = fakeLinear({
			labels: [{ id: "lbl-other-team", name: "agent:hermes", team: { id: "team-other" } }],
		});
		await new Mirror({ linear: client }).claim(ctx());

		const creates = only(requests, "LabelCreate");
		expect(creates).toHaveLength(1);
		expect(creates[0]!.variables).toEqual({ input: { name: "agent:hermes", teamId: TEAM } });
		expect(JSON.stringify(creates[0]!.variables)).not.toContain("replaceTeamLabels");
		const input = only(requests, "IssueUpdate")[0]!.variables.input as Record<string, unknown>;
		expect(input.addedLabelIds).toEqual(["lbl-created"]);
	});

	test("removes every dispatch:* label and leaves other labels alone", async () => {
		const { requests, client } = fakeLinear({
			labels: [{ id: "lbl-team", name: "agent:hermes", team: { id: TEAM } }],
			issueLabels: [
				{ id: "lbl-dispatch", name: "dispatch:hermes" },
				{ id: "lbl-bug", name: "bug" },
			],
		});
		await new Mirror({ linear: client }).claim(ctx());

		const input = only(requests, "IssueUpdate")[0]!.variables.input as Record<string, unknown>;
		expect(input.removedLabelIds).toEqual(["lbl-dispatch"]);
	});

	test("never sends labelIds, and authorizes with the raw key (no Bearer)", async () => {
		const { requests, client } = fakeLinear({ issueLabels: [{ id: "lbl-dispatch", name: "dispatch:hermes" }] });
		await new Mirror({ linear: client }).claim(ctx());

		expect(requests.length).toBeGreaterThan(0);
		for (const request of requests) {
			expect(JSON.stringify(request.variables)).not.toContain('"labelIds"');
			expect(request.authorization).toBe(KEY);
		}
	});

	test("posts one comment carrying the session id", async () => {
		const { requests, client } = fakeLinear({ labels: [{ id: "lbl-team", name: "agent:hermes", team: { id: TEAM } }] });
		await new Mirror({ linear: client }).claim(ctx());

		const comments = only(requests, "CommentCreate");
		expect(comments).toHaveLength(1);
		const input = comments[0]!.variables.input as { issueId: string; body: string };
		expect(input.issueId).toBe("issue-uuid");
		expect(input.body).toContain("session sess-1");
	});

	test("a team with no state named In Progress fails the target instead of guessing a type", async () => {
		const { requests, fetchImpl } = fakeLinear();
		const noProgress = (async (url: string, init: RequestInit) => {
			const response = await fetchImpl(url, init);
			const body = (await response.json()) as { data: { issue?: { team: { states: { nodes: unknown[] } } } } };
			if (body.data.issue) {
				body.data.issue.team.states.nodes = body.data.issue.team.states.nodes.filter(
					(s) => (s as { name: string }).name !== "In Progress",
				);
			}
			return new Response(JSON.stringify(body), { status: 200 });
		}) as unknown as typeof fetch;
		const failures = await new Mirror({ linear: new LinearClient(KEY, { fetchImpl: noProgress }) }).claim(ctx());

		expect(failures).toHaveLength(1);
		expect(failures[0]!.target).toBe("linear");
		expect(failures[0]!.reason).toContain("In Progress");
		expect(only(requests, "IssueUpdate")).toHaveLength(0);
	});
});

const DS = "be3418f0-d2d8-411b-8677-fa8a95ee63be";
const PAGE = "3e4bc1a0-c7ae-81ba-afff-d1ebd773123d";
const PAGE_URL = `https://www.notion.so/n1-Throwaway-${PAGE.replaceAll("-", "")}`;
const PR_OWNED = ["PR URL", "PR #", "PR State", "Repo", "Branch"];

/** An Agent Task Graph Issue row's types as 02-NOTION-SCHEMA.md observed them, the PR-owned ones included. */
const ISSUE_ROW_TYPES: Record<string, string> = {
	Item: "title",
	Level: "select",
	"Graph ID": "rich_text",
	"Issue ID": "rich_text",
	"Linear URL": "url",
	Agent: "rich_text",
	Status: "status",
	"Linear State": "select",
	Completed: "date",
	"PR URL": "url",
	"PR #": "number",
	"PR State": "select",
	Repo: "rich_text",
	Branch: "rich_text",
};

interface NotionRequest {
	method: string;
	url: string;
	body: { properties?: Record<string, unknown> } | undefined;
}

/** A Notion stand-in answering GET with a row of `types` under `dataSource`, and PATCH with 200; it records everything. */
function fakeNotion(opts: { types?: Record<string, string>; dataSource?: string } = {}) {
	const requests: NotionRequest[] = [];
	const fetchImpl = (async (url: string, init: RequestInit) => {
		requests.push({ method: init.method ?? "GET", url, body: init.body ? JSON.parse(String(init.body)) : undefined });
		if (init.method === "PATCH") return new Response(JSON.stringify({ object: "page", id: PAGE }), { status: 200 });
		const properties = Object.fromEntries(
			Object.entries(opts.types ?? ISSUE_ROW_TYPES).map(([name, type]) => [name, { id: name, type }]),
		);
		const parent = { type: "data_source_id", data_source_id: opts.dataSource ?? DS };
		return new Response(JSON.stringify({ object: "page", id: PAGE, parent, properties }), { status: 200 });
	}) as unknown as typeof fetch;
	const patches = () => requests.filter((r) => r.method === "PATCH").map((r) => r.body?.properties);
	return { requests, patches, fetchImpl, client: new NotionClient("ntn_mirror_test_key", { dataSourceId: DS, fetchImpl }) };
}

const linearDown = () =>
	new LinearClient(KEY, { fetchImpl: (async () => new Response("down", { status: 500 })) as unknown as typeof fetch });

function notionCtx(notionPage: string | null = PAGE_URL): MirrorContext {
	return ctx({ node: node({ notion_page: notionPage }) });
}

describe("Mirror → Notion Issue row", () => {
	test("claim with Linear ok: one PATCH of exactly Agent and Linear State In Progress, in the row's types", async () => {
		const notion = fakeNotion();
		const failures = await new Mirror({ linear: fakeLinear().client, notion: notion.client }).claim(notionCtx());

		expect(failures).toEqual([]);
		expect(notion.patches()).toEqual([
			{ Agent: { rich_text: [{ text: { content: "hermes" } }] }, "Linear State": { select: { name: "In Progress" } } },
		]);
		expect(notion.requests.at(-1)!.url).toBe(`https://api.notion.com/v1/pages/${PAGE}`);
	});

	test("claim with a Linear failure still sets Agent but leaves Linear State alone", async () => {
		const notion = fakeNotion();
		const failures = await new Mirror({ linear: linearDown(), notion: notion.client }).claim(notionCtx());

		expect(failures.map((f) => f.target)).toEqual(["linear"]);
		expect(notion.patches()).toEqual([{ Agent: { rich_text: [{ text: { content: "hermes" } }] } }]);
	});

	test("claim with Linear off writes Agent only: substrate set nothing on Linear to mirror", async () => {
		const notion = fakeNotion();
		const failures = await new Mirror({ linear: null, notion: notion.client }).claim(notionCtx());

		expect(failures).toEqual([]);
		expect(notion.patches()).toEqual([{ Agent: { rich_text: [{ text: { content: "hermes" } }] } }]);
	});

	test("the Agent value follows the row's own type (a select Agent gets a select value)", async () => {
		const notion = fakeNotion({ types: { ...ISSUE_ROW_TYPES, Agent: "select" } });
		await new Mirror({ linear: null, notion: notion.client }).claim(notionCtx());

		expect(notion.patches()).toEqual([{ Agent: { select: { name: "hermes" } } }]);
	});

	test("release clears Agent and sets Linear State Todo (D-05)", async () => {
		const notion = fakeNotion();
		const failures = await new Mirror({ linear: fakeLinear().client, notion: notion.client }).release(notionCtx());

		expect(failures).toEqual([]);
		expect(notion.patches()).toEqual([{ Agent: { rich_text: [] }, "Linear State": { select: { name: "Todo" } } }]);
	});

	test("review writes Linear State In Review and nothing else", async () => {
		const notion = fakeNotion();
		const failures = await new Mirror({ linear: fakeLinear().client, notion: notion.client }).review(notionCtx());

		expect(failures).toEqual([]);
		expect(notion.patches()).toEqual([{ "Linear State": { select: { name: "In Review" } } }]);
	});

	test("review after a Linear failure makes no Notion request at all", async () => {
		const notion = fakeNotion();
		const failures = await new Mirror({ linear: linearDown(), notion: notion.client }).review(notionCtx());

		expect(failures.map((f) => f.target)).toEqual(["linear"]);
		expect(notion.requests).toEqual([]);
	});

	test("done writes only Status Done, Linear State Done and Completed = today (UTC)", async () => {
		const notion = fakeNotion();
		const before = new Date().toISOString().slice(0, 10);
		const failures = await new Mirror({ linear: fakeLinear().client, notion: notion.client }).done(notionCtx());
		const after = new Date().toISOString().slice(0, 10);

		expect(failures).toEqual([]);
		const [patch] = notion.patches();
		expect(Object.keys(patch!).sort()).toEqual(["Completed", "Linear State", "Status"]);
		expect(patch!.Status).toEqual({ status: { name: "Done" } });
		expect(patch!["Linear State"]).toEqual({ select: { name: "Done" } });
		const onEitherSide = [before, after].map((day) => JSON.stringify({ date: { start: day } }));
		expect(onEitherSide).toContain(JSON.stringify(patch!.Completed));
	});

	test("no request in claim, release, review or done names a PR-owned property (D-07)", async () => {
		const notion = fakeNotion();
		const mirror = new Mirror({ linear: fakeLinear().client, notion: notion.client });

		await mirror.claim(notionCtx());
		await mirror.release(notionCtx());
		await mirror.review(notionCtx());
		await mirror.done(notionCtx());

		expect(notion.patches()).toHaveLength(4);
		for (const request of notion.requests) {
			const sent = JSON.stringify(request.body ?? {});
			for (const name of PR_OWNED) expect(sent).not.toContain(`"${name}"`);
		}
	});

	test("a row without an Agent property still gets Linear State, and one notion failure names Agent", async () => {
		const { Agent: _agent, ...withoutAgent } = ISSUE_ROW_TYPES;
		const notion = fakeNotion({ types: withoutAgent });
		const failures = await new Mirror({ linear: fakeLinear().client, notion: notion.client }).claim(notionCtx());

		expect(notion.patches()).toEqual([{ "Linear State": { select: { name: "In Progress" } } }]);
		expect(failures).toHaveLength(1);
		expect(failures[0]!.target).toBe("notion");
		expect(failures[0]!.reason).toContain('"Agent"');
	});

	test("a property of a type substrate cannot write is skipped with a notion failure naming it", async () => {
		const notion = fakeNotion({ types: { ...ISSUE_ROW_TYPES, Agent: "people" } });
		const failures = await new Mirror({ linear: fakeLinear().client, notion: notion.client }).claim(notionCtx());

		expect(notion.patches()).toEqual([{ "Linear State": { select: { name: "In Progress" } } }]);
		expect(failures.map((f) => f.target)).toEqual(["notion"]);
		expect(failures[0]!.reason).toContain('"Agent"');
		expect(failures[0]!.reason).toContain("people");
	});

	test("a node with no notion_page: one notion failure and zero Notion requests", async () => {
		const notion = fakeNotion();
		const failures = await new Mirror({ linear: fakeLinear().client, notion: notion.client }).claim(notionCtx(null));

		expect(failures).toEqual([{ target: "notion", reason: "node has no notion_page" }]);
		expect(notion.requests).toEqual([]);
	});

	test("a page outside the Agent Task Graph is never PATCHed; the refusal is a notion failure", async () => {
		const notion = fakeNotion({ dataSource: "99999999-8888-7777-6666-555555555555" });
		const failures = await new Mirror({ linear: fakeLinear().client, notion: notion.client }).claim(notionCtx());

		expect(notion.requests.map((r) => r.method)).toEqual(["GET"]);
		expect(failures.map((f) => f.target)).toEqual(["notion"]);
		expect(failures[0]!.reason).toContain("not a row of the Agent Task Graph");
	});

	test("a Notion error becomes a notion failure; the Linear step is unaffected", async () => {
		const linear = fakeLinear();
		const down = (async () => new Response("bad gateway", { status: 502 })) as unknown as typeof fetch;
		const notion = new NotionClient("ntn_mirror_test_key", { dataSourceId: DS, fetchImpl: down });
		const failures = await new Mirror({ linear: linear.client, notion }).claim(notionCtx());

		expect(failures).toHaveLength(1);
		expect(failures[0]!.target).toBe("notion");
		expect(failures[0]!.reason).toContain("502");
		expect(only(linear.requests, "IssueUpdate")).toHaveLength(1);
	});
});

describe("createMirror → Notion", () => {
	test("without NOTION_API_KEY: notion off, zero Notion requests and no notion failure", async () => {
		const linear = fakeLinear();
		const urls: string[] = [];
		const recording = (async (url: string, init: RequestInit) => {
			urls.push(url);
			return linear.fetchImpl(url, init);
		}) as unknown as typeof fetch;
		const mirror = createMirror(loadConfig({ LINEAR_API_KEY: KEY }), recording);

		const failures = await mirror.claim(notionCtx());

		expect(mirror.describe()).toBe("linear on, notion off");
		expect(failures).toEqual([]);
		expect(urls.length).toBeGreaterThan(0);
		expect(urls.filter((url) => url.includes("notion"))).toEqual([]);
	});

	test("with NOTION_API_KEY: notion on, checking rows against the configured data source", async () => {
		const custom = "12345678-90ab-cdef-1234-567890abcdef";
		const linear = fakeLinear();
		const notion = fakeNotion({ dataSource: custom });
		const routed = (async (url: string, init: RequestInit) =>
			url.startsWith("https://api.notion.com/") ? notion.fetchImpl(url, init) : linear.fetchImpl(url, init)) as unknown as typeof fetch;
		const env = { LINEAR_API_KEY: KEY, NOTION_API_KEY: "ntn_key", NOTION_TASK_GRAPH_DS: custom };
		const mirror = createMirror(loadConfig(env), routed);

		const failures = await mirror.claim(notionCtx());

		expect(mirror.describe()).toBe("linear on, notion on");
		expect(failures).toEqual([]);
		expect(notion.patches()).toHaveLength(1);
	});
});
