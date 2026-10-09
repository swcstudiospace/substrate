import { describe, expect, test } from "bun:test";
import { LinearClient } from "../../mcp-server/src/linear.ts";
import {
	classifyIssue,
	collectCandidates,
	DISPATCH_OUTCOMES,
	ensureMarkerComment,
	hasMarkerComment,
	markerBody,
	removeDispatchLabels,
	type DispatchOutcome,
	type PollIssue,
} from "./linear-poll.ts";

const CANARY_TITLE = "CANARY-TITLE-9f3a2b1c-should-never-leave-linear";

interface FakeStoreIssue {
	id: string;
	identifier: string;
	title: string;
	labels: Array<{ id: string; name: string }>;
	comments: string[];
}

const ISSUE_PAGE_SIZE = 2;
const COMMENT_PAGE_SIZE = 20;

/** In-memory Linear stand-in behind a stub fetch: no live Linear, no network. */
function stubLinear(store: FakeStoreIssue[]) {
	const queries: string[] = [];
	const createdComments: Array<{ issueId: string; body: string }> = [];
	const updatedIssues: Array<{ id: string; input: Record<string, unknown> }> = [];

	const pageOf = <T>(items: T[], after: unknown, size: number) => {
		const start = typeof after === "string" && after.length > 0 ? Number(after) : 0;
		const nodes = items.slice(start, start + size);
		const next = start + size;
		return { nodes, pageInfo: { hasNextPage: next < items.length, endCursor: next < items.length ? String(next) : null } };
	};

	const fetchImpl = (async (_url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
		queries.push(body.query);
		if (body.query.includes("DispatchCandidates")) {
			const page = pageOf(
				store.map((issue) => ({ id: issue.id, identifier: issue.identifier, labels: { nodes: issue.labels } })),
				body.variables.after,
				ISSUE_PAGE_SIZE,
			);
			return new Response(JSON.stringify({ data: { issues: page } }), { status: 200 });
		}
		if (body.query.includes("DispatchMarkerComments")) {
			const issue = store.find((candidate) => candidate.id === body.variables.id);
			const page = pageOf((issue?.comments ?? []).map((comment) => ({ body: comment })), body.variables.after, COMMENT_PAGE_SIZE);
			return new Response(JSON.stringify({ data: { issue: issue ? { comments: page } : null } }), { status: 200 });
		}
		if (body.query.includes("commentCreate")) {
			const input = body.variables.input as { issueId: string; body: string };
			createdComments.push({ issueId: input.issueId, body: input.body });
			store.find((candidate) => candidate.id === input.issueId)?.comments.push(input.body);
			return new Response(JSON.stringify({ data: { commentCreate: { success: true } } }), { status: 200 });
		}
		if (body.query.includes("issueUpdate")) {
			const input = body.variables.input as { removedLabelIds?: string[] };
			updatedIssues.push({ id: body.variables.id as string, input: input as Record<string, unknown> });
			const issue = store.find((candidate) => candidate.id === body.variables.id);
			if (issue && input.removedLabelIds) {
				issue.labels = issue.labels.filter((label) => !input.removedLabelIds?.includes(label.id));
			}
			return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), { status: 200 });
		}
		throw new Error(`unexpected query: ${body.query.slice(0, 80)}`);
	}) as unknown as typeof fetch;

	return {
		queries,
		createdComments,
		updatedIssues,
		client: new LinearClient("lin-test-key", { fetchImpl, endpoint: "https://linear.test/graphql" }),
	};
}

const hermesIssue = (overrides: Partial<FakeStoreIssue> = {}): FakeStoreIssue => ({
	id: "issue-hermes",
	identifier: "SWC-101",
	title: CANARY_TITLE,
	labels: [{ id: "lbl-dispatch", name: "dispatch:hermes" }],
	comments: [],
	...overrides,
});

describe("dispatcher linear poll (DISP-01 / DISP-02)", () => {
	test("outcome names are the eleven DISP-02 tokens verbatim", () => {
		expect([...DISPATCH_OUTCOMES]).toEqual([
			"not-dispatchable",
			"no-node",
			"already-claimed",
			"low-disk",
			"no-checkout",
			"path-conflict",
			"git-failed",
			"host-refused",
			"host-unreachable",
			"exited-unclaimed",
			"claim-timeout",
		]);
	});

	test("poll pages every candidate without selecting title or description", async () => {
		const store: FakeStoreIssue[] = [
			hermesIssue(),
			hermesIssue({ id: "issue-claude", identifier: "SWC-102", labels: [{ id: "lbl-cc", name: "dispatch:claude-code" }] }),
			hermesIssue({ id: "issue-bare", identifier: "SWC-103", labels: [] }),
		];
		const fake = stubLinear(store);
		const collected = await collectCandidates(fake.client);
		expect(collected.dispatchable.map((entry) => entry.issue.identifier)).toEqual(["SWC-101", "SWC-102"]);
		expect(collected.dispatchable.map((entry) => entry.surface)).toEqual(["hermes", "claude-code"]);
		expect(collected.notDispatchable.map((issue) => issue.identifier)).toEqual(["SWC-103"]);
		expect(fake.queries.length).toBeGreaterThan(1);
		for (const query of fake.queries) {
			expect(query.toLowerCase()).not.toContain("title");
			expect(query.toLowerCase()).not.toContain("description");
		}
		const pollQuery = fake.queries.find((query) => query.includes("DispatchCandidates"));
		expect(pollQuery).toBeDefined();
		expect(pollQuery).toContain("hasNextPage");
		expect(pollQuery).toContain("endCursor");
	});

	test("classification needs exactly one known dispatch surface", () => {
		const labels = (names: string[]): PollIssue => ({
			id: "issue-x",
			identifier: "SWC-999",
			labels: names.map((name, index) => ({ id: `lbl-${index}`, name })),
		});
		expect(classifyIssue(labels(["dispatch:hermes"]))).toEqual({ kind: "dispatchable", surface: "hermes" });
		expect(classifyIssue(labels([])).kind).toBe("not-dispatchable");
		expect(classifyIssue(labels(["Bug"])).kind).toBe("not-dispatchable");
		expect(classifyIssue(labels(["dispatch:hermes", "dispatch:claude-code"])).kind).toBe("not-dispatchable");
		expect(classifyIssue(labels(["dispatch:hermes", "dispatch:hermes"])).kind).toBe("not-dispatchable");
		expect(classifyIssue(labels(["dispatch:unknown-surface"])).kind).toBe("not-dispatchable");
		expect(classifyIssue(labels(["dispatch:"])).kind).toBe("not-dispatchable");
	});

	test("marker is once-only even when buried past the first comment page", async () => {
		const unrelated = Array.from({ length: 25 }, (_, index) => `review note ${index}`);
		const outcome: DispatchOutcome = "low-disk";
		const store: FakeStoreIssue[] = [hermesIssue({ comments: [...unrelated, markerBody(outcome)] })];
		const fake = stubLinear(store);
		expect(await hasMarkerComment(fake.client, "issue-hermes", outcome)).toBe(true);
		expect(await ensureMarkerComment(fake.client, "issue-hermes", outcome)).toBe("already-marked");
		expect(fake.createdComments).toEqual([]);
	});

	test("missing marker posts exactly one comment carrying only the outcome token", async () => {
		const unrelated = Array.from({ length: 21 }, (_, index) => `review note ${index} on ${CANARY_TITLE}`);
		const store: FakeStoreIssue[] = [hermesIssue({ comments: [...unrelated] })];
		const fake = stubLinear(store);
		expect(await ensureMarkerComment(fake.client, "issue-hermes", "no-node")).toBe("commented");
		expect(fake.createdComments).toEqual([{ issueId: "issue-hermes", body: "substrate-dispatch: no-node" }]);
		expect(await ensureMarkerComment(fake.client, "issue-hermes", "no-node")).toBe("already-marked");
		expect(fake.createdComments).toHaveLength(1);
		for (const created of fake.createdComments) {
			expect(created.body).not.toContain(CANARY_TITLE);
		}
	});

	test("label removal is additive-only and keeps unrelated labels", async () => {
		const store: FakeStoreIssue[] = [
			hermesIssue({ labels: [{ id: "lbl-dispatch", name: "dispatch:hermes" }, { id: "lbl-bug", name: "Bug" }] }),
		];
		const fake = stubLinear(store);
		const issue = store[0];
		if (!issue) throw new Error("test store lost its issue");
		expect(await removeDispatchLabels(fake.client, issue)).toBe("removed");
		expect(fake.updatedIssues).toHaveLength(1);
		const update = fake.updatedIssues[0];
		expect(update?.input).toEqual({ removedLabelIds: ["lbl-dispatch"] });
		expect(store[0]?.labels).toEqual([{ id: "lbl-bug", name: "Bug" }]);
	});

	test("label removal is a no-op without dispatch labels", async () => {
		const store: FakeStoreIssue[] = [hermesIssue({ labels: [{ id: "lbl-bug", name: "Bug" }] })];
		const fake = stubLinear(store);
		const issue = store[0];
		if (!issue) throw new Error("test store lost its issue");
		expect(await removeDispatchLabels(fake.client, issue)).toBe("nothing-to-remove");
		expect(fake.updatedIssues).toEqual([]);
	});
});
