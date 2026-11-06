import { describe, expect, test } from "bun:test";
import {
	firstStartedStateId,
	firstUnstartedStateId,
	inReviewStateId,
	type IssueContext,
	LinearClient,
	LinearError,
	LINEAR_API_URL,
} from "./linear.ts";
import { defined } from "./test-support.ts";

const KEY = "lin-test-key";
const ENDPOINT = "https://linear.test/graphql";

interface Recorded {
	url: string;
	headers: Record<string, string>;
	body: { query: string; variables: Record<string, unknown> };
}

function reply(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

/** A Linear stand-in answering from a queue of responders, recording every request. */
function fakeLinear(respond: (recorded: Recorded) => Response | Promise<Response>) {
	const requests: Recorded[] = [];
	const fetchImpl = (async (url: string, init: RequestInit) => {
		const recorded: Recorded = {
			url,
			headers: { ...(init.headers as Record<string, string>) },
			body: JSON.parse(String(init.body)) as Recorded["body"],
		};
		requests.push(recorded);
		return respond(recorded);
	}) as unknown as typeof fetch;
	return { requests, client: new LinearClient(KEY, { fetchImpl, endpoint: ENDPOINT }) };
}

function ctxOf(states: Array<{ id: string; name: string; type: string; position: number }>): IssueContext {
	return {
		id: "issue-1",
		identifier: "SWC-1",
		team: { id: "team-1", key: "SWC", states },
		labels: [],
		comments: [],
	};
}

const TEAM_STATES = [
	{ id: "st-todo", name: "Todo", type: "unstarted", position: 0 },
	{ id: "st-backlog", name: "Backlog", type: "unstarted", position: 1 },
	{ id: "st-progress", name: "In Progress", type: "started", position: 2 },
	{ id: "st-review", name: "In Review", type: "started", position: 3 },
	{ id: "st-done", name: "Done", type: "completed", position: 4 },
];

describe("state resolution by type and position (D23-06)", () => {
	test("first started is the lowest-position started state, not In Review", () => {
		expect(firstStartedStateId(ctxOf(TEAM_STATES))).toBe("st-progress");
	});

	test("first unstarted is the lowest-position unstarted state", () => {
		expect(firstUnstartedStateId(ctxOf(TEAM_STATES))).toBe("st-todo");
	});

	test("In Review resolves by name case-insensitively among started states", () => {
		const ctx = ctxOf(
			TEAM_STATES.map((s) => (s.id === "st-review" ? { ...s, name: "in review" } : s)),
		);
		expect(inReviewStateId(ctx)).toBe("st-review");
	});

	test("a missing In Review is a mirror failure, never a fallback", () => {
		const ctx = ctxOf(TEAM_STATES.filter((s) => s.id !== "st-review"));
		expect(() => inReviewStateId(ctx)).toThrow(LinearError);
		expect(() => inReviewStateId(ctx)).toThrow('no started state named "In Review"');
	});

	test("no resolver ever returns a completed state id", () => {
		// A team whose only started state is Done: first-started must throw, not return it.
		const doneOnly = ctxOf([{ id: "st-done", name: "Done", type: "completed", position: 0 }]);
		expect(() => firstStartedStateId(doneOnly)).toThrow(LinearError);
		// In Review must be a started state: a completed state named "In Review" does not count.
		const completedReview = ctxOf([{ id: "st-x", name: "In Review", type: "completed", position: 0 }]);
		expect(() => inReviewStateId(completedReview)).toThrow(LinearError);
	});

	test("missing started/unstarted families throw", () => {
		const ctx = ctxOf([{ id: "st-done", name: "Done", type: "completed", position: 0 }]);
		expect(() => firstUnstartedStateId(ctx)).toThrow("no unstarted state");
	});
});

describe("issueContext fetches position", () => {
	test("states carry position and the query asks for it", async () => {
		const { requests, client } = fakeLinear(() =>
			reply({
				data: {
					issue: {
						id: "issue-1",
						identifier: "SWC-1",
						team: { id: "team-1", key: "SWC", states: { nodes: TEAM_STATES } },
						labels: { nodes: [] },
						comments: { nodes: [] },
					},
				},
			}),
		);

		const ctx = await client.issueContext("SWC-1");

		expect(defined(requests[0]).body.query).toContain("position");
		expect(ctx.team.states).toEqual(TEAM_STATES);
		expect(firstStartedStateId(ctx)).toBe("st-progress");
	});
});

describe("error redaction (D23-05)", () => {
	test("a non-2xx carries status plus at most 200 body chars, never the key or headers", async () => {
		const { client } = fakeLinear(() => new Response("x".repeat(500), { status: 502 }));

		const error = await client.issueState("SWC-1").catch((e: unknown) => e);

		if (!(error instanceof LinearError)) throw new Error(`expected LinearError, got ${String(error)}`);
		expect(error.message).toContain("502");
		expect(error.message.match(/x/g)?.length).toBe(200);
		expect(error.message).not.toContain(KEY);
		expect(error.message).not.toContain("Authorization");
	});

	test("the auth header is the raw key, not a Bearer token", async () => {
		const { requests, client } = fakeLinear(() => reply({ data: { issue: null } }));
		await client.issueState("SWC-1").catch(() => undefined);
		expect(defined(requests[0]).headers.Authorization).toBe(KEY);
	});

	test("an unreachable endpoint throws without the key", async () => {
		const unreachable = new LinearClient(KEY, {
			endpoint: ENDPOINT,
			fetchImpl: (async () => {
				throw new Error("socket hangup");
			}) as unknown as typeof fetch,
		});
		const error = await unreachable.issueState("SWC-1").catch((e: unknown) => e);
		if (!(error instanceof LinearError)) throw new Error(`expected LinearError, got ${String(error)}`);
		expect(error.message).toContain("linear unreachable");
		expect(error.message).not.toContain(KEY);
	});

	test("a reply that is not an object is refused with the module error, not a TypeError", async () => {
		const { client } = fakeLinear(() => reply(null));
		const error = await client.issueState("SWC-1").catch((e: unknown) => e);
		if (!(error instanceof LinearError)) throw new Error(`expected LinearError, got ${String(error)}`);
		expect(error.message).toContain("graphql");
	});
});

describe("updateIssue is additive only", () => {
	test("the signature has addedLabelIds/removedLabelIds and no labelIds parameter", async () => {
		const { requests, client } = fakeLinear(() => reply({ data: { issueUpdate: { success: true } } }));

		await client.updateIssue("issue-1", { stateId: "st-progress", addedLabelIds: ["l1"], removedLabelIds: ["l2"] });

		const input = defined(requests[0]).body.variables.input as Record<string, unknown>;
		expect(input).toEqual({ stateId: "st-progress", addedLabelIds: ["l1"], removedLabelIds: ["l2"] });
		expect(input).not.toHaveProperty("labelIds");
		// Adding labelIds must make this assignment fail to compile.
		const noLabelIds: "labelIds" extends keyof Parameters<LinearClient["updateIssue"]>[1] ? never : true = true;
		expect(noLabelIds).toBe(true);
	});
});

describe("ensureLabel (D23-07)", () => {
	const teamLabel = { id: "tl-1", name: "agent:hermes", team: { id: "team-1" } };
	const workspaceLabel = { id: "wl-1", name: "agent:hermes", team: null };

	test("prefers the team label over the workspace label", async () => {
		const { client } = fakeLinear(() =>
			reply({ data: { issueLabels: { nodes: [workspaceLabel, teamLabel] } } }),
		);
		expect(await client.ensureLabel("team-1", "agent:hermes")).toBe("tl-1");
	});

	test("falls back to the workspace label, then caches per teamId:name", async () => {
		let calls = 0;
		const { requests, client } = fakeLinear(() => {
			calls += 1;
			return reply({ data: { issueLabels: { nodes: [workspaceLabel] } } });
		});
		expect(await client.ensureLabel("team-9", "agent:hermes")).toBe("wl-1");
		expect(await client.ensureLabel("team-9", "agent:hermes")).toBe("wl-1");
		expect(calls).toBe(1);
		expect(requests).toHaveLength(1);
	});

	test("creates a team label when none exists, and re-searches after a create error", async () => {
		let calls = 0;
		const { client } = fakeLinear(() => {
			calls += 1;
			if (calls === 1) return reply({ data: { issueLabels: { nodes: [] } } });
			if (calls === 2) return new Response("race lost", { status: 500 });
			return reply({ data: { issueLabels: { nodes: [teamLabel] } } });
		});
		expect(await client.ensureLabel("team-1", "agent:hermes")).toBe("tl-1");
		expect(calls).toBe(3);
	});
});

describe("endpoint default", () => {
	test("defaults to the real Linear GraphQL API", async () => {
		expect(LINEAR_API_URL).toBe("https://api.linear.app/graphql");
		let called = false;
		const client = new LinearClient(KEY, {
			fetchImpl: (async (url: string) => {
				called = true;
				expect(url).toBe("https://api.linear.app/graphql");
				return reply({ data: { issue: null } });
			}) as unknown as typeof fetch,
		});
		await expect(client.issueState("SWC-1")).rejects.toThrow("issue SWC-1 not found");
		expect(called).toBe(true);
	});
});
