/**
 * Graph edges into Linear relations (phase 38, B-D1), against a recorded Linear stand-in. A `blocks` relation runs
 * from the blocking issue to the waiting one. A relation already present in that direction is read, not written
 * again. An edge with no tracker issue on either side is skipped without a request. One edge's failure never stops
 * the next edge.
 */
import { describe, expect, test } from "bun:test";
import { LinearClient } from "./linear.ts";
import { type EdgeRelation, Mirror, ownedRelations } from "./mirror.ts";

const KEY = "lin-test-key";
const ENDPOINT = "https://linear.test/graphql";

interface Recorded {
	body: { query: string; variables: Record<string, unknown> };
}

interface IssueFixture {
	id: string;
	relations?: Array<{ type: string; relatedIssueId: string }>;
}

function reply(data: unknown): Response {
	return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** A Linear stand-in: issues by identifier, and a relation create that can be made to refuse one pair. */
function linearStandIn(
	issues: Record<string, IssueFixture>,
	options: { refuse?: (input: { issueId: string; relatedIssueId: string }) => boolean } = {},
) {
	const requests: Recorded[] = [];
	const fetchImpl = (async (_url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body)) as Recorded["body"];
		requests.push({ body });
		if (body.query.includes("IssueRelationCreate")) {
			const input = body.variables.input as { issueId: string; relatedIssueId: string };
			const refused = options.refuse?.(input) ?? false;
			return reply({ data: { issueRelationCreate: { success: !refused, issueRelation: refused ? null : { id: `rel-${input.issueId}-${input.relatedIssueId}` } } } });
		}
		if (body.query.includes("IssueRelationDelete")) return reply({ data: { issueRelationDelete: { success: true } } });
		const identifier = String(body.variables.id);
		const issue = issues[identifier];
		if (!issue) return reply({ data: { issue: null } });
		return reply({
			data: {
				issue: {
					id: issue.id,
					identifier,
					relations: {
						nodes: (issue.relations ?? []).map((relation) => ({
							type: relation.type,
							relatedIssue: { id: relation.relatedIssueId },
						})),
					},
				},
			},
		});
	}) as unknown as typeof fetch;
	return { requests, mirror: new Mirror({ linear: new LinearClient(KEY, { fetchImpl, endpoint: ENDPOINT }) }) };
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

describe("a racing registration of one new edge (G3)", () => {
	test("two registrations racing on one new edge write one relation, and the second reports it existing", async () => {
		// A stateful stand-in: a created relation is visible to the next read. The first two reads of the blocker
		// wait until both registrations have made theirs, so each one reads before either writes: the race itself.
		const issues: Record<string, { id: string; relations: Array<{ type: string; relatedIssueId: string }> }> = {
			"SWC-1": { id: "uuid-1", relations: [] },
			"SWC-2": { id: "uuid-2", relations: [] },
		};
		const requests: Recorded[] = [];
		const bothRead = Promise.withResolvers<void>();
		let blockerReads = 0;
		const fetchImpl = (async (_url: string, init: RequestInit) => {
			const body = JSON.parse(String(init.body)) as Recorded["body"];
			requests.push({ body });
			if (body.query.includes("IssueRelationCreate")) {
				const input = body.variables.input as { issueId: string; relatedIssueId: string };
				const blocker = Object.values(issues).find((issue) => issue.id === input.issueId);
				blocker?.relations.push({ type: "blocks", relatedIssueId: input.relatedIssueId });
				return reply({ data: { issueRelationCreate: { success: true, issueRelation: { id: "rel-race" } } } });
			}
			const identifier = String(body.variables.id);
			if (identifier === "SWC-1" && ++blockerReads === 2) bothRead.resolve();
			if (identifier === "SWC-1") await bothRead.promise;
			const issue = issues[identifier];
			if (!issue) return reply({ data: { issue: null } });
			return reply({
				data: {
					issue: {
						id: issue.id,
						identifier,
						relations: { nodes: issue.relations.map((relation) => ({ type: relation.type, relatedIssue: { id: relation.relatedIssueId } })) },
					},
				},
			});
		}) as unknown as typeof fetch;
		const mirror = new Mirror({ linear: new LinearClient(KEY, { fetchImpl, endpoint: ENDPOINT }) });

		const [first, second] = await Promise.all([mirror.relateEdges([edge()]), mirror.relateEdges([edge()])]);

		expect([first[0]?.status, second[0]?.status].sort()).toEqual(["created", "existing"]);
		expect(createsOf(requests)).toHaveLength(1);
	});
});

describe("removing an edge deletes only a relation this mirror created (G4)", () => {
	const deletesOf = (requests: Recorded[]) =>
		requests.filter((request) => request.body.query.includes("IssueRelationDelete")).map((request) => request.body.variables);
	const created = { id: "rel-uuid-1-uuid-2", blockerIssueId: "uuid-1", waitingIssueId: "uuid-2" };
	const owned = { ...created, kind: "requires" as const, blockerNode: "n1", waitingNode: "n2", blockerRef: "SWC-1", waitingRef: "SWC-2" };

	test("a relation the create returned is recorded with the ids that delete it", async () => {
		const { mirror } = linearStandIn({ "SWC-1": { id: "uuid-1" }, "SWC-2": { id: "uuid-2" } });
		const [outcome] = await mirror.relateEdges([edge()]);
		expect(outcome?.relation).toEqual(created);
	});

	test("a relation no edge still holds is deleted by its id", async () => {
		const { requests, mirror } = linearStandIn({ "SWC-1": { id: "uuid-1" }, "SWC-2": { id: "uuid-2" } });
		const outcome = await mirror.unrelate(owned, async () => false);
		expect(outcome.status).toBe("deleted");
		expect(deletesOf(requests)).toEqual([{ id: "rel-uuid-1-uuid-2" }]);
	});

	test("a relation an edge still wants is kept, and Linear is not asked to delete it", async () => {
		const { requests, mirror } = linearStandIn({ "SWC-1": { id: "uuid-1" }, "SWC-2": { id: "uuid-2" } });
		const outcome = await mirror.unrelate(owned, async () => true);
		expect(outcome.status).toBe("kept");
		expect(deletesOf(requests)).toEqual([]);
	});

	test("a refused delete is reported with its reason and never thrown", async () => {
		const fetchImpl = (async () => reply({ data: { issueRelationDelete: { success: false } } })) as unknown as typeof fetch;
		const mirror = new Mirror({ linear: new LinearClient(KEY, { fetchImpl, endpoint: ENDPOINT }) });
		const outcome = await mirror.unrelate(owned, async () => false);
		expect(outcome.status).toBe("failed");
		expect(outcome.reason).toContain("did not succeed");
	});

	test("ownership is a created relation with an ok record, until its ok removal", () => {
		const pair = (blocker: string, waiting: string) => ({ action: "mirror", target: "linear", op: "relate", blocker_node: blocker, waiting_node: waiting, status: "ok" });
		const withRelation = (payload: Record<string, unknown>) => ({
			...payload,
			relation_id: `rel-${String(payload.blocker_node)}-${String(payload.waiting_node)}`,
			blocker_issue_id: "uuid-1",
			waiting_issue_id: "uuid-2",
			edge_kind: "requires",
		});
		const events = [
			{ payload: withRelation(pair("n1", "n2")) },
			{ payload: withRelation(pair("n3", "n4")) },
			{ payload: { ...pair("n5", "n6"), status: "failed" } },
			{ payload: { action: "mirror", target: "linear", op: "unrelate", blocker_node: "n3", waiting_node: "n4", status: "ok" } },
			{ payload: { action: "mirror", target: "linear", op: "unrelate", blocker_node: "n1", waiting_node: "n2", status: "failed" } },
		];
		expect(ownedRelations(events).map((relation) => `${relation.blockerNode}>${relation.waitingNode}:${relation.id}`)).toEqual([
			"n1>n2:rel-n1-n2",
		]);
	});
});
