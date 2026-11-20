/**
 * Graph edges into Linear relations (phase 38, B-D1), against a recorded Linear stand-in. A `blocks` relation runs
 * from the blocking issue to the waiting one. A relation already present in that direction is read, not written
 * again. An edge with no tracker issue on either side is skipped without a request. One edge's failure never stops
 * the next edge.
 */
import { describe, expect, test } from "bun:test";
import { LinearClient } from "./linear.ts";
import { type EdgeRelation, Mirror } from "./mirror.ts";
import type { GraphEdge, GraphNode, GraphView } from "./types.ts";

const KEY = "lin-test-key";
const ENDPOINT = "https://linear.test/graphql";

interface Recorded {
	body: { query: string; variables: Record<string, unknown> };
}

interface IssueFixture {
	id: string;
	relations?: Array<{ id?: string; type: string; relatedIssueId: string }>;
	/** Relations per page. Absent: every relation on one page. */
	pageSize?: number;
	/** The first page says more follows but gives no cursor. */
	omitCursor?: boolean;
}

function reply(data: unknown): Response {
	return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
}

/**
 * A Linear stand-in: issues by identifier, relations paged the way Linear pages them, and relation create and delete
 * that can each refuse one case.
 */
function linearStandIn(
	issues: Record<string, IssueFixture>,
	options: {
		refuse?: (input: { issueId: string; relatedIssueId: string }) => boolean;
		refuseDelete?: (id: string) => boolean;
	} = {},
) {
	const requests: Recorded[] = [];
	const fetchImpl = (async (_url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body)) as Recorded["body"];
		requests.push({ body });
		if (body.query.includes("IssueRelationCreate")) {
			const input = body.variables.input as { issueId: string; relatedIssueId: string };
			const refused = options.refuse?.(input) ?? false;
			return reply({ data: { issueRelationCreate: { success: !refused } } });
		}
		if (body.query.includes("IssueRelationDelete")) {
			const refused = options.refuseDelete?.(String(body.variables.id)) ?? false;
			return reply({ data: { issueRelationDelete: { success: !refused } } });
		}
		const identifier = String(body.variables.id);
		const issue = issues[identifier];
		if (!issue) return reply({ data: { issue: null } });
		const all = (issue.relations ?? []).map((relation, index) => ({
			id: relation.id ?? `${issue.id}-rel-${index}`,
			type: relation.type,
			relatedIssueId: relation.relatedIssueId,
		}));
		const start = typeof body.variables.after === "string" ? Number(body.variables.after) : 0;
		const end = issue.pageSize ? start + issue.pageSize : all.length;
		const hasNextPage = end < all.length;
		return reply({
			data: {
				issue: {
					id: issue.id,
					identifier,
					relations: {
						nodes: all.slice(start, end).map((relation) => ({
							id: relation.id,
							type: relation.type,
							relatedIssue: { id: relation.relatedIssueId },
						})),
						pageInfo: { hasNextPage, endCursor: hasNextPage && !issue.omitCursor ? String(end) : null },
					},
				},
			},
		});
	}) as unknown as typeof fetch;
	const linear = new LinearClient(KEY, { fetchImpl, endpoint: ENDPOINT });
	return { requests, linear, mirror: new Mirror({ linear }) };
}

/** A `requires` edge by default: node n2 (SWC-2) waits on n1 (SWC-1). */
function edge(over: Partial<EdgeRelation> = {}): EdgeRelation {
	return { kind: "requires", waitingNode: "n2", waitingRef: "SWC-2", blockerNode: "n1", blockerRef: "SWC-1", ...over };
}

function createsOf(requests: Recorded[]): Array<Record<string, unknown>> {
	return requests
		.filter((request) => request.body.query.includes("IssueRelationCreate"))
		.map((request) => request.body.variables);
}

describe("graph edges into Linear blocks relations", () => {
	test("a requires edge creates a blocks relation from the blocking issue to the waiting one", async () => {
		const { requests, mirror } = linearStandIn({ "SWC-1": { id: "uuid-1" }, "SWC-2": { id: "uuid-2" } });
		const outcomes = await mirror.relateEdges([edge()]);
		expect(outcomes.map((outcome) => outcome.status)).toEqual(["created"]);
		expect(createsOf(requests)).toEqual([{ input: { issueId: "uuid-1", relatedIssueId: "uuid-2", type: "blocks" } }]);
	});

	test("a gated_by edge is mirrored the same way: the gate blocks the node that waits on it", async () => {
		const { requests, mirror } = linearStandIn({ "SWC-1": { id: "uuid-1" }, "SWC-2": { id: "uuid-2" } });
		const outcomes = await mirror.relateEdges([edge({ kind: "gated_by" })]);
		expect(outcomes.map((outcome) => outcome.status)).toEqual(["created"]);
		expect(createsOf(requests)).toEqual([{ input: { issueId: "uuid-1", relatedIssueId: "uuid-2", type: "blocks" } }]);
	});

	test("a blocks edge is read from the blocking side: the node it points at is the one waiting", async () => {
		const { requests, mirror } = linearStandIn({ "SWC-1": { id: "uuid-1" }, "SWC-2": { id: "uuid-2" } });
		// n1 blocks n2: the blocker is n1 whatever the edge's direction in the graph reads as.
		const outcomes = await mirror.relateEdges([
			edge({ kind: "blocks", waitingNode: "n2", waitingRef: "SWC-2", blockerNode: "n1", blockerRef: "SWC-1" }),
		]);
		expect(outcomes.map((outcome) => outcome.status)).toEqual(["created"]);
		expect(createsOf(requests)).toEqual([{ input: { issueId: "uuid-1", relatedIssueId: "uuid-2", type: "blocks" } }]);
	});

	test("a relation already present in that direction is read and not written again", async () => {
		const { requests, mirror } = linearStandIn({
			"SWC-1": { id: "uuid-1", relations: [{ type: "blocks", relatedIssueId: "uuid-2" }] },
			"SWC-2": { id: "uuid-2" },
		});
		const outcomes = await mirror.relateEdges([edge()]);
		expect(outcomes.map((outcome) => outcome.status)).toEqual(["existing"]);
		expect(createsOf(requests)).toEqual([]);
	});

	test("an edge with no tracker issue on either side is skipped without asking Linear", async () => {
		const { requests, mirror } = linearStandIn({});
		const outcomes = await mirror.relateEdges([
			edge({ waitingRef: null }),
			edge({ waitingNode: "n4", waitingRef: "SWC-4", blockerNode: "n3", blockerRef: null }),
		]);
		expect(outcomes.map((outcome) => outcome.status)).toEqual(["skipped", "skipped"]);
		expect(requests).toEqual([]);
	});

	test("a refused relation is reported with its reason, and the next edge is still mirrored", async () => {
		const { mirror } = linearStandIn(
			{ "SWC-1": { id: "uuid-1" }, "SWC-2": { id: "uuid-2" }, "SWC-3": { id: "uuid-3" } },
			{ refuse: (input) => input.issueId === "uuid-1" },
		);
		const outcomes = await mirror.relateEdges([
			edge(),
			edge({ kind: "blocks", waitingNode: "n2", waitingRef: "SWC-2", blockerNode: "n3", blockerRef: "SWC-3" }),
		]);
		expect(outcomes.map((outcome) => outcome.status)).toEqual(["failed", "created"]);
		expect(outcomes[0]?.reason).toContain("did not succeed");
	});
});

function deletesOf(requests: Recorded[]): string[] {
	return requests
		.filter((request) => request.body.query.includes("IssueRelationDelete"))
		.map((request) => String(request.body.variables.id));
}

/** An edge as `registerGraph` returns it in `removed`: stored before the replace, absent after. */
function dropped(from: string, to: string, kind: GraphEdge["kind"]): GraphEdge {
	return { graph_id: "ut-1", from_node: from, to_node: to, kind };
}

/** The graph as a replace leaves it: each node's tracker ref, and the edges still held. */
function graphAfter(refs: Record<string, string | null>, edges: GraphEdge[] = []): Pick<GraphView, "nodes" | "edges"> {
	const nodes = Object.entries(refs).map(
		([node_id, linear_identifier]) => ({ node_id, linear_identifier, linear_issue_id: null }) as GraphNode,
	);
	return { nodes, edges };
}

describe("dropped graph edges take their Linear relations down", () => {
	test("removing an edge deletes only the relation that edge held", async () => {
		const { requests, mirror } = linearStandIn({
			"SWC-1": {
				id: "uuid-1",
				relations: [
					{ id: "rel-a", type: "blocks", relatedIssueId: "uuid-2" },
					{ id: "rel-b", type: "blocks", relatedIssueId: "uuid-3" },
				],
			},
			"SWC-2": { id: "uuid-2" },
			"SWC-3": { id: "uuid-3" },
		});
		const outcomes = await mirror.removeEdges(
			[dropped("n2", "n1", "requires")],
			graphAfter({ n1: "SWC-1", n2: "SWC-2", n3: "SWC-3" }),
		);
		expect(outcomes).toEqual([{ kind: "requires", waitingNode: "n2", blockerNode: "n1", status: "removed" }]);
		expect(deletesOf(requests)).toEqual(["rel-a"]);
	});

	test("a blocks edge is removed from the blocking side, the node it points at is the one waiting", async () => {
		const { requests, mirror } = linearStandIn({
			"SWC-1": { id: "uuid-1", relations: [{ id: "rel-a", type: "blocks", relatedIssueId: "uuid-3" }] },
			"SWC-3": { id: "uuid-3" },
		});
		const outcomes = await mirror.removeEdges([dropped("n1", "n3", "blocks")], graphAfter({ n1: "SWC-1", n3: "SWC-3" }));
		expect(outcomes.map((outcome) => outcome.status)).toEqual(["removed"]);
		expect(deletesOf(requests)).toEqual(["rel-a"]);
	});

	test("a pair another edge still holds keeps its relation, and nothing is deleted", async () => {
		const { requests, mirror } = linearStandIn({
			"SWC-1": { id: "uuid-1", relations: [{ id: "rel-a", type: "blocks", relatedIssueId: "uuid-2" }] },
			"SWC-2": { id: "uuid-2" },
		});
		const outcomes = await mirror.removeEdges(
			[dropped("n2", "n1", "requires")],
			graphAfter({ n1: "SWC-1", n2: "SWC-2" }, [dropped("n1", "n2", "blocks")]),
		);
		expect(outcomes.map((outcome) => outcome.status)).toEqual(["kept"]);
		expect(deletesOf(requests)).toEqual([]);
	});

	test("a dropped edge with no Linear relation is skipped and recorded", async () => {
		const { requests, mirror } = linearStandIn({ "SWC-1": { id: "uuid-1" }, "SWC-2": { id: "uuid-2" } });
		const outcomes = await mirror.removeEdges([dropped("n2", "n1", "requires")], graphAfter({ n1: "SWC-1", n2: "SWC-2" }));
		expect(outcomes).toEqual([
			{ kind: "requires", waitingNode: "n2", blockerNode: "n1", status: "skipped", reason: "no Linear relation" },
		]);
		expect(deletesOf(requests)).toEqual([]);
	});

	test("a dropped edge with no tracker issue on one side is skipped without asking Linear", async () => {
		const { requests, mirror } = linearStandIn({});
		const outcomes = await mirror.removeEdges([dropped("n2", "n1", "requires")], graphAfter({ n1: "SWC-1", n2: null }));
		expect(outcomes.map((outcome) => outcome.status)).toEqual(["skipped"]);
		expect(requests).toEqual([]);
	});

	test("a refused delete is reported with its reason, and the next dropped edge is still removed", async () => {
		const { requests, mirror } = linearStandIn(
			{
				"SWC-1": {
					id: "uuid-1",
					relations: [
						{ id: "rel-a", type: "blocks", relatedIssueId: "uuid-2" },
						{ id: "rel-b", type: "blocks", relatedIssueId: "uuid-3" },
					],
				},
				"SWC-2": { id: "uuid-2" },
				"SWC-3": { id: "uuid-3" },
			},
			{ refuseDelete: (id) => id === "rel-a" },
		);
		const outcomes = await mirror.removeEdges(
			[dropped("n2", "n1", "requires"), dropped("n1", "n3", "blocks")],
			graphAfter({ n1: "SWC-1", n2: "SWC-2", n3: "SWC-3" }),
		);
		expect(outcomes.map((outcome) => outcome.status)).toEqual(["failed", "removed"]);
		expect(outcomes[0]?.reason).toContain("did not succeed");
		expect(deletesOf(requests)).toEqual(["rel-a", "rel-b"]);
	});
});

describe("issueRelations reads every page", () => {
	test("it follows the cursor until Linear reports no more relations", async () => {
		const relations = [1, 2, 3, 4, 5].map((n) => ({ id: `rel-${n}`, type: "blocks", relatedIssueId: `uuid-${n + 1}` }));
		const { requests, linear } = linearStandIn({ "SWC-1": { id: "uuid-1", pageSize: 2, relations } });
		const issue = await linear.issueRelations("SWC-1");
		expect(issue).toEqual({ id: "uuid-1", identifier: "SWC-1", relations });
		const pages = requests.map((request) => request.body.variables.after);
		expect(pages).toEqual([null, "2", "4"]);
	});

	test("a page that says more follows without a cursor is an error, not a silent truncation", async () => {
		const relations = [1, 2, 3].map((n) => ({ id: `rel-${n}`, type: "blocks", relatedIssueId: `uuid-${n + 1}` }));
		const { linear } = linearStandIn({ "SWC-1": { id: "uuid-1", pageSize: 2, omitCursor: true, relations } });
		await expect(linear.issueRelations("SWC-1")).rejects.toThrow("pagination did not advance");
	});
});
