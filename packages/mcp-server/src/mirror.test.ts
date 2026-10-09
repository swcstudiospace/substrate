import { describe, expect, test } from "bun:test";
import { Mirror, transitionComment, type MirrorContext, type MirrorOp } from "./mirror.ts";
import { LinearClient } from "./linear.ts";
import { NotionClient } from "./notion.ts";

const LIN_KEY = "lin-test-key";
const NOTION_KEY = "ntn-test-key";
const DS = "be3418f0-d2d8-411b-8677-fa8a95ee63be";
const PAGE = "3e4bc1a0-c7ae-81ba-afff-d1ebd773123d";
const LEASE_ID = "lease-planted-9f8e7d6c5b4a";

const TEAM_STATES = [
	{ id: "st-queued", name: "Queued", type: "unstarted", position: 0 },
	{ id: "st-doing", name: "Doing", type: "started", position: 1 },
	{ id: "st-review", name: "In Review", type: "started", position: 2 },
	{ id: "st-done", name: "Done", type: "completed", position: 3 },
];

interface LinearMutation {
	kind: "update" | "comment" | "label-create";
	stateId?: string;
	addedLabelIds?: string[];
	removedLabelIds?: string[];
	body?: string;
}

interface Label {
	id: string;
	name: string;
	team: { id: string } | null;
}

interface IssueFixture {
	labels: Array<{ id: string; name: string }>;
	comments: string[];
	knownLabels: Label[];
}

interface GraphqlBody {
	query: string;
	variables: Record<string, unknown>;
}

/** The mutation inputs this fake's LinearClient sends; asserted once at the fake boundary. */
interface MutationInput {
	name: string;
	teamId: string;
	stateId?: string;
	addedLabelIds?: string[];
	removedLabelIds?: string[];
	body: string;
}

/** A Linear GraphQL stand-in answering from one mutable fixture and recording mutations. */
function fakeLinear(
	fixture: IssueFixture,
	hooks?: { down?: boolean; onUpdate?: (input: MutationInput) => Promise<void>; onComment?: (input: MutationInput) => Promise<void> },
) {
	const mutations: LinearMutation[] = [];
	const requests: Array<{ url: string; body: string }> = [];
	const fetchImpl = (async (url: string, init: RequestInit) => {
		const bodyText = String(init.body);
		requests.push({ url, body: bodyText });
		if (hooks?.down) return new Response("connection refused", { status: 502 });
		const parsed: GraphqlBody = JSON.parse(bodyText) as GraphqlBody;
		const { query, variables } = parsed;
		if (query.includes("IssueContext")) {
			return Response.json({
				data: {
					issue: {
						id: "issue-1",
						identifier: "SWC-1",
						team: { id: "team-1", key: "SWC", states: { nodes: TEAM_STATES } },
						labels: { nodes: fixture.labels },
						comments: { nodes: fixture.comments.map((c) => ({ body: c })) },
					},
				},
			});
		}
		if (query.includes("issueLabels")) {
			const name = typeof variables.name === "string" ? variables.name : "";
			return Response.json({
				data: { issueLabels: { nodes: fixture.knownLabels.filter((l) => l.name === name) } },
			});
		}
		if (query.includes("LabelCreate")) {
			const input = variables.input as MutationInput;
			const created: Label = { id: `tl-${input.name}`, name: input.name, team: { id: input.teamId } };
			fixture.knownLabels.push(created);
			mutations.push({ kind: "label-create" });
			return Response.json({ data: { issueLabelCreate: { success: true, issueLabel: { id: created.id } } } });
		}
		if (query.includes("IssueUpdate")) {
			const input = variables.input as MutationInput;
			await hooks?.onUpdate?.(input);
			mutations.push({
				kind: "update",
				stateId: input.stateId,
				addedLabelIds: input.addedLabelIds,
				removedLabelIds: input.removedLabelIds,
			});
			return Response.json({ data: { issueUpdate: { success: true } } });
		}
		if (query.includes("CommentCreate")) {
			const input = variables.input as MutationInput;
			await hooks?.onComment?.(input);
			mutations.push({ kind: "comment", body: input.body });
			fixture.comments.push(input.body);
			return Response.json({ data: { commentCreate: { success: true } } });
		}
		if (query.includes("IssueState")) {
			return Response.json({ data: { issue: { state: { name: "Doing", type: "started" } } } });
		}
		if (query.includes("IssueText")) {
			return Response.json({ data: { issue: { identifier: "SWC-1", title: "Do it", description: "details" } } });
		}
		return new Response(`unknown query: ${query.slice(0, 80)}`, { status: 400 });
	}) as unknown as typeof fetch;
	return { mutations, requests, client: new LinearClient(LIN_KEY, { fetchImpl, endpoint: "https://linear.test/graphql" }) };
}

interface NotionMutation {
	method: "GET" | "PATCH";
	properties?: Record<string, unknown>;
}

/** A Notion stand-in for one Issue row, recording GET/PATCH. */
function fakeNotion() {
	const mutations: NotionMutation[] = [];
	const requests: Array<{ url: string; body: string }> = [];
	const fetchImpl = (async (url: string, init: RequestInit) => {
		requests.push({ url, body: init.body ? String(init.body) : "" });
		if (init.method === "PATCH") {
			const parsed = JSON.parse(String(init.body)) as { properties: Record<string, unknown> };
			mutations.push({ method: "PATCH", properties: parsed.properties });
			return Response.json({ object: "page", id: PAGE });
		}
		mutations.push({ method: "GET" });
		return Response.json({
			object: "page",
			id: PAGE,
			parent: { type: "data_source_id", data_source_id: DS },
			properties: {
				Agent: { type: "rich_text" },
				Status: { type: "status" },
				"Linear State": { type: "select" },
				Completed: { type: "date" },
			},
		});
	}) as unknown as typeof fetch;
	return { mutations, requests, client: new NotionClient(NOTION_KEY, { dataSourceId: DS, fetchImpl }) };
}

function ctx(overrides?: Partial<MirrorContext>): MirrorContext {
	return {
		graphId: "g1",
		nodeId: "n1",
		holder: "hermes",
		sessionId: "sess-1",
		epoch: 3,
		linearRef: "SWC-1",
		notionPage: PAGE,
		...overrides,
	};
}

function harness(fixture?: Partial<IssueFixture>) {
	const fix: IssueFixture = {
		labels: [
			{ id: "l-d1", name: "dispatch:hermes" },
			{ id: "l-a9", name: "agent:cursor" },
		],
		comments: [],
		knownLabels: [],
		...fixture,
	};
	const linear = fakeLinear(fix);
	const notion = fakeNotion();
	const mirror = new Mirror({ linear: linear.client, notion: notion.client });
	return { fix, linear, notion, mirror };
}

const updatesOf = (mutations: LinearMutation[]) => mutations.filter((m) => m.kind === "update");
const commentsOf = (mutations: LinearMutation[]) => mutations.filter((m) => m.kind === "comment");

describe("claim (granted/reclaimed)", () => {
	test("one update to first started plus agent label minus dispatch and other agents, then the claim comment", async () => {
		const { linear, notion, mirror } = harness();

		const failures = await mirror.claim(ctx());

		expect(failures).toEqual([]);
		const updates = updatesOf(linear.mutations);
		expect(updates).toHaveLength(1);
		expect(updates[0]!.stateId).toBe("st-doing");
		expect(updates[0]!.addedLabelIds).toEqual(["tl-agent:hermes"]);
		expect(updates[0]!.removedLabelIds).toEqual(["l-d1", "l-a9"]);
		const comments = commentsOf(linear.mutations);
		expect(comments).toHaveLength(1);
		expect(comments[0]!.body).toBe("Claimed by hermes — session sess-1 (graph g1, node n1)");
		const patch = notion.mutations.find((m) => m.method === "PATCH");
		expect(patch?.properties?.Agent).toEqual({ rich_text: [{ text: { content: "hermes" } }] });
		expect(patch?.properties?.["Linear State"]).toEqual({ select: { name: "Doing" } });
	});

	test("one shaped write costs a single GET and a single PATCH", async () => {
		const { notion, mirror } = harness();

		expect(await mirror.claim(ctx())).toEqual([]);

		expect(notion.mutations.filter((m) => m.method === "GET")).toHaveLength(1);
		expect(notion.mutations.filter((m) => m.method === "PATCH")).toHaveLength(1);
	});

	test("an identical comment among the last 20 posts no write; same-session reclaim posts nothing new", async () => {
		const body = "Claimed by hermes — session sess-1 (graph g1, node n1)";
		const { linear, mirror } = harness({ comments: ["older note", body] });

		const failures = await mirror.claim(ctx());

		expect(failures).toEqual([]);
		expect(updatesOf(linear.mutations)).toHaveLength(1);
		expect(commentsOf(linear.mutations)).toHaveLength(0);
	});

	test("a different session still gets its own comment", async () => {
		const { linear, mirror } = harness({ comments: ["Claimed by hermes — session sess-9 (graph g1, node n1)"] });

		await mirror.claim(ctx({ sessionId: "sess-2" }));

		const comments = commentsOf(linear.mutations);
		expect(comments).toHaveLength(1);
		expect(comments[0]!.body).toContain("sess-2");
	});
});

describe("steal", () => {
	test("the label moves in one update with the new session's own comment", async () => {
		const { linear, mirror } = harness({
			labels: [{ id: "l-ev", name: "agent:cursor" }],
		});

		const failures = await mirror.steal(ctx({ holder: "hermes", sessionId: "sess-2", evictedHolder: "cursor" }));

		expect(failures).toEqual([]);
		const updates = updatesOf(linear.mutations);
		expect(updates).toHaveLength(1);
		expect(updates[0]!.addedLabelIds).toEqual(["tl-agent:hermes"]);
		expect(updates[0]!.removedLabelIds).toEqual(["l-ev"]);
		const comments = commentsOf(linear.mutations);
		expect(comments).toHaveLength(1);
		expect(comments[0]!.body).toBe("Claimed by hermes — session sess-2 (graph g1, node n1)");
	});
});

describe.each(["release", "expire", "force"] as const)("%s", (op) => {
	test("exactly one update to first unstarted removing every agent label, zero comments, Notion cleared", async () => {
		const { linear, notion, mirror } = harness({
			labels: [
				{ id: "l-a1", name: "agent:hermes" },
				{ id: "l-a2", name: "agent:cursor" },
				{ id: "l-d1", name: "dispatch:hermes" },
			],
		});

		const failures = await mirror[op](ctx());

		expect(failures).toEqual([]);
		const updates = updatesOf(linear.mutations);
		expect(updates).toHaveLength(1);
		expect(updates[0]!.stateId).toBe("st-queued");
		expect(updates[0]!.removedLabelIds).toEqual(["l-a1", "l-a2"]);
		expect(updates[0]!.addedLabelIds).toBeUndefined();
		expect(commentsOf(linear.mutations)).toHaveLength(0);
		const patch = notion.mutations.find((m) => m.method === "PATCH");
		expect(patch?.properties?.Agent).toEqual({ rich_text: [] });
		expect(patch?.properties?.["Linear State"]).toEqual({ select: { name: "Queued" } });
	});
});

describe("review and done and close", () => {
	test("review moves Linear to In Review and Notion Linear State to In Review", async () => {
		const { linear, notion, mirror } = harness();

		expect(await mirror.review(ctx())).toEqual([]);
		const updates = updatesOf(linear.mutations);
		expect(updates).toHaveLength(1);
		expect(updates[0]!.stateId).toBe("st-review");
		expect(commentsOf(linear.mutations)).toHaveLength(0);
		expect(notion.mutations.find((m) => m.method === "PATCH")?.properties?.["Linear State"]).toEqual({
			select: { name: "In Review" },
		});
	});

	test("done writes Notion Status/Linear State/Completed with no Linear call", async () => {
		const { linear, notion, mirror } = harness();

		expect(await mirror.done(ctx())).toEqual([]);
		expect(linear.mutations).toHaveLength(0);
		const patch = notion.mutations.find((m) => m.method === "PATCH");
		expect(patch?.properties?.Status).toEqual({ status: { name: "Done" } });
		expect(patch?.properties?.["Linear State"]).toEqual({ select: { name: "Done" } });
		expect(patch?.properties?.Completed).toEqual({ date: { start: expect.any(String) } });
	});

	test("close removes agent labels and clears Notion Agent, leaving Linear state alone", async () => {
		const { linear, notion, mirror } = harness({ labels: [{ id: "l-a1", name: "agent:hermes" }] });

		expect(await mirror.close(ctx())).toEqual([]);
		const updates = updatesOf(linear.mutations);
		expect(updates).toHaveLength(1);
		expect(updates[0]!.stateId).toBeUndefined();
		expect(updates[0]!.removedLabelIds).toEqual(["l-a1"]);
		expect(notion.mutations.find((m) => m.method === "PATCH")?.properties).toEqual({ Agent: { rich_text: [] } });
	});
});

describe("renewed paths write nothing, ever", () => {
	test("the Mirror has no renew or heartbeat entry point", () => {
		const names = Object.getOwnPropertyNames(Mirror.prototype);
		expect(names).not.toContain("renewed");
		expect(names).not.toContain("renew");
		expect(names).not.toContain("heartbeat");
		expect(names).toEqual(
			expect.arrayContaining(["claim", "steal", "release", "expire", "force", "review", "done", "close"]),
		);
	});
});

describe("swarm comment-only exception (D23-03)", () => {
	const swarm = "swarm-a05-be";
	const cases: Array<{ op: MirrorOp; body: string }> = [
		{ op: "claim", body: `Claimed by ${swarm} — session sess-1 (graph g1, node n1)` },
		{ op: "steal", body: `Claimed by ${swarm} — session sess-1 (graph g1, node n1)` },
		{ op: "release", body: `Released by ${swarm} — session sess-1 (graph g1, node n1)` },
		{ op: "expire", body: `Lease expired for ${swarm} — session sess-1 (graph g1, node n1)` },
		{ op: "force", body: `Lease forced off ${swarm} — session sess-1 (graph g1, node n1)` },
		{ op: "done", body: `Completed by ${swarm} — session sess-1 (graph g1, node n1)` },
		{ op: "close", body: `Completed by ${swarm} — session sess-1 (graph g1, node n1)` },
	];

	for (const { op, body } of cases) {
		test(`${op} with a swarm holder posts exactly one comment and touches nothing else`, async () => {
			const { linear, notion, mirror } = harness({ labels: [{ id: "l-ev", name: "agent:cursor" }] });

			const failures = await mirror[op](
				ctx({ holder: swarm as MirrorContext["holder"], evictedHolder: "cursor" }),
			);

			expect(failures).toEqual([]);
			expect(updatesOf(linear.mutations)).toHaveLength(0);
			expect(linear.mutations.filter((m) => m.kind === "label-create")).toHaveLength(0);
			const comments = commentsOf(linear.mutations);
			expect(comments).toHaveLength(1);
			expect(comments[0]!.body).toBe(body);
			expect(notion.mutations).toHaveLength(0);
		});
	}

	test("a swarm steal leaves the evicted holder's agent label in place", async () => {
		const { linear, mirror } = harness({ labels: [{ id: "l-ev", name: "agent:cursor" }] });

		await mirror.steal(ctx({ holder: swarm as MirrorContext["holder"], evictedHolder: "cursor" }));

		expect(updatesOf(linear.mutations)).toHaveLength(0);
	});

	test("transitionComment builds each specified body", () => {
		const base = { holder: "hermes" as const, sessionId: "s", graphId: "g", nodeId: "n" };
		expect(transitionComment("claim", base)).toBe("Claimed by hermes — session s (graph g, node n)");
		expect(transitionComment("release", base)).toBe("Released by hermes — session s (graph g, node n)");
		expect(transitionComment("expire", base)).toBe("Lease expired for hermes — session s (graph g, node n)");
		expect(transitionComment("force", base)).toBe("Lease forced off hermes — session s (graph g, node n)");
		expect(transitionComment("done", base)).toBe("Completed by hermes — session s (graph g, node n)");
	});
});

describe("failure semantics: fail-open warnings, never throws (D23-17/18)", () => {
	test("a Linear outage returns one linear failure per op and leaves the lease decision to the caller", async () => {
		const fix: IssueFixture = { labels: [], comments: [], knownLabels: [] };
		const linear = fakeLinear(fix, { down: true });
		const mirror = new Mirror({ linear: linear.client, notion: null });

		for (const op of ["claim", "steal", "release", "expire", "force", "review", "close"] as const) {
			const failures = await mirror[op](ctx({ evictedHolder: "cursor" }));
			expect(failures).toHaveLength(1);
			expect(failures[0]).toEqual({ target: "linear", op, reason: expect.stringContaining("502") });
			expect(failures[0]!.reason.length).toBeLessThanOrEqual(300);
		}
	});

	test("a target that does not apply is not a failure (D23-19)", async () => {
		const off = new Mirror({ linear: null, notion: null });
		expect(await off.claim(ctx())).toEqual([]);
		expect(await off.release(ctx())).toEqual([]);

		// No Linear reference: the Linear step is skipped silently and Notion still runs.
		const { linear, notion, mirror } = harness();
		expect(await mirror.claim(ctx({ linearRef: null }))).toEqual([]);
		expect(linear.mutations).toHaveLength(0);
		expect(notion.mutations.find((m) => m.method === "PATCH")?.properties?.Agent).toEqual({
			rich_text: [{ text: { content: "hermes" } }],
		});

		// No notion_page: the Notion step is skipped silently and Linear still runs.
		const { linear: linear2, notion: notion2, mirror: mirror2 } = harness();
		expect(await mirror2.claim(ctx({ notionPage: null }))).toEqual([]);
		expect(updatesOf(linear2.mutations)).toHaveLength(1);
		expect(notion2.mutations).toHaveLength(0);
	});

	test("a reference that fails to resolve is a failure", async () => {
		const fix: IssueFixture = { labels: [], comments: [], knownLabels: [] };
		const linear = fakeLinear(fix, { down: true });
		const mirror = new Mirror({ linear: linear.client, notion: null });

		const failures = await mirror.claim(ctx({ linearRef: "SWC-999" }));

		expect(failures).toEqual([{ target: "linear", op: "claim", reason: expect.any(String) }]);
	});

	test("a failed claim comment keeps the state Linear already has", async () => {
		// The issueUpdate landed and only the courtesy comment did not: the
		// comment failure warns on its own while Notion still shows Doing.
		const fix: IssueFixture = { labels: [], comments: [], knownLabels: [] };
		const linear = fakeLinear(fix, {
			onComment: async () => {
				throw new Error("commentCreate on issue-1 did not succeed");
			},
		});
		const notion = fakeNotion();
		const mirror = new Mirror({ linear: linear.client, notion: notion.client });

		const failures = await mirror.claim(ctx());

		expect(failures).toEqual([{ target: "linear", op: "claim", reason: expect.stringContaining("comment failed") }]);
		expect(updatesOf(linear.mutations)).toHaveLength(1);
		const patch = notion.mutations.find((m) => m.method === "PATCH");
		expect(patch?.properties?.["Linear State"]).toEqual({ select: { name: "Doing" } });
	});

	test("a failed issue read is redacted before it is forwarded", async () => {
		const secret = `api_key: ${"k7".repeat(12)}`;
		const fetchImpl = (async () => new Response(`upstream blew up: ${secret}`, { status: 502 })) as unknown as typeof fetch;
		const mirror = new Mirror({ linear: new LinearClient(LIN_KEY, { fetchImpl, endpoint: "https://linear.test/graphql" }), notion: null });

		const result = await mirror.issueText({ linearRef: "SWC-1" });

		if (result.ok) throw new Error("expected the read to fail");
		expect(result.reason).toContain("linear read failed");
		expect(result.reason).not.toContain("k7".repeat(12));
	});

	test("per-node calls serialize: a release cannot overtake its claim", async () => {
		// The first update blocks on a gate the test opens; the release's
		// update must not be issued until the claim's whole run is done.
		const firstUpdateStarted = Promise.withResolvers<void>();
		const releaseGate = Promise.withResolvers<void>();
		let updateCalls = 0;
		const fix: IssueFixture = {
			labels: [],
			comments: [],
			knownLabels: [{ id: "tl", name: "agent:hermes", team: { id: "team-1" } }],
		};
		const linear = fakeLinear(fix, {
			onUpdate: async () => {
				updateCalls += 1;
				if (updateCalls === 1) {
					firstUpdateStarted.resolve();
					await releaseGate.promise;
				}
			},
		});
		const mirror = new Mirror({ linear: linear.client, notion: null });
		const c = ctx();

		const pending = mirror.claim(c);
		await firstUpdateStarted.promise;
		const pendingRelease = mirror.release(c);
		// Release runs only synchronous prefix work before awaiting the chain:
		// its update cannot have been issued while the claim holds the node.
		expect(updateCalls).toBe(1);
		releaseGate.resolve();
		await Promise.all([pending, pendingRelease]);

		const updates = updatesOf(linear.mutations);
		expect(updates).toHaveLength(2);
		expect(updates[0]!.stateId).toBe("st-doing");
		expect(updates[1]!.stateId).toBe("st-queued");
	});
});

describe("lease-id hygiene (D23-04)", () => {
	test("MirrorContext has no lease-id field", () => {
		expect(Object.keys(ctx()).filter((k) => k.toLowerCase().includes("lease"))).toEqual([]);
	});

	test("a planted lease id appears in no tracker request, no failure and no reply across every op", async () => {
		// The planted id is intentionally never placed in any MirrorContext:
		// the assertion below proves none of it leaks through anyway.
		const { linear, notion, mirror } = harness();
		const c = ctx({ holder: "hermes", sessionId: "sess-1", evictedHolder: "cursor" });

		const allFailures: unknown[] = [];
		for (const op of ["claim", "steal", "release", "expire", "force", "review", "done", "close"] as const) {
			allFailures.push(...(await mirror[op](c)));
		}
		const state = await mirror.linearState(c);
		const text = await mirror.issueText(c);

		const wire = [
			...linear.requests.flatMap((r) => [r.url, r.body]),
			...notion.requests.flatMap((r) => [r.url, r.body]),
			JSON.stringify(allFailures),
			JSON.stringify(state),
			JSON.stringify(text),
		].join("\n");
		expect(LEASE_ID).toContain("lease-");
		expect(wire).not.toContain(LEASE_ID);
	});
});
