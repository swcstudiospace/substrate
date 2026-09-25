import { describe, expect, test } from "bun:test";
import { LinearClient } from "./linear.ts";
import { Mirror, type MirrorContext } from "./mirror.ts";
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
