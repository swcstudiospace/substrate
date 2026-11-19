/**
 * Removing a graph edge removes the Linear relation this mirror created for it (phase 38, gap G4). Only a relation the
 * ledger records as created by the mirror is ever deleted. A relation still held by an edge of this graph, or by an
 * edge of another graph, is kept. An unreadable ledger removes nothing.
 */
import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";
import type { Mirror, OwnedRelation, UnrelateOutcome } from "./mirror.ts";
import { Substrate } from "./service.ts";
import type { EventInput, GraphView } from "./types.ts";

const GRAPH = "ut-1";

interface NodeFixture {
	node_id: string;
	linear_issue_id: string | null;
	linear_identifier: string | null;
}

interface EdgeFixture {
	from_node: string;
	to_node: string;
	kind: "requires" | "blocks" | "gated_by";
}

/** A graph view as the index returns it, with the fields the registration reply carries. */
function viewOf(graphId: string, nodes: NodeFixture[], edges: EdgeFixture[]): GraphView {
	return {
		graph_id: graphId,
		notion_task_page: null,
		repo: null,
		branch: null,
		surface: null,
		status: null,
		pr_url: null,
		created: null,
		updated: null,
		nodes: nodes.map((node) => ({
			...node,
			graph_id: graphId,
			state: "unstarted",
			notion_page: null,
			claimed_by: null,
			claimed_at: null,
			claim_session: null,
			lease_id: null,
			lease_expires_at: null,
			lease_heartbeat_at: null,
			lease_epoch: 0,
		})),
		steps: [],
		edges: edges.map((edge) => ({ ...edge, graph_id: graphId })),
	};
}

/** The waiting pair of issues every test uses: n1 (SWC-1, uuid-1) blocks n2 (SWC-2, uuid-2). */
const PAIR: NodeFixture[] = [
	{ node_id: "n1", linear_issue_id: "uuid-1", linear_identifier: "SWC-1" },
	{ node_id: "n2", linear_issue_id: "uuid-2", linear_identifier: "SWC-2" },
];

/** A ledger row of the graph, carrying a payload as the ledger stores it. */
function ledgerRow(id: number, payload: Record<string, unknown>) {
	return {
		id: String(id),
		ts: id,
		surface: "substrate",
		session_id: `relation:${GRAPH}:${id}`,
		graph_id: GRAPH,
		node_id: "n2",
		linear_identifier: null,
		step: null,
		repo: null,
		branch: null,
		actor: "agent",
		kind: "note",
		summary: "linear relation created",
		payload: JSON.stringify(payload),
	};
}

/** The `created` record of the relation the mirror wrote for n1 blocks n2. */
function createdRow(relationId: string) {
	return ledgerRow(1, {
		action: "mirror",
		target: "linear",
		op: "relate",
		edge_kind: "requires",
		blocker_node: "n1",
		waiting_node: "n2",
		status: "ok",
		relation_id: relationId,
		blocker_issue_id: "uuid-1",
		waiting_issue_id: "uuid-2",
		blocker_ref: "SWC-1",
		waiting_ref: "SWC-2",
	});
}

interface Setup {
	registered: GraphView;
	ledger: unknown[] | "unreadable";
	/** Graphs other than this one, by id, as the index reads them. */
	graphs?: Record<string, GraphView>;
	/** Graph ids the index names as holding a node for the waiting issue. */
	holders?: string[];
}

/** A substrate whose index, ledger and mirror are stand-ins. The mirror asks `stillWanted` as the real one does. */
function setup(input: Setup) {
	const unrelated: OwnedRelation[] = [];
	const mirror = {
		relateEdges: async () => [],
		unrelate: async (owned: OwnedRelation, stillWanted: () => Promise<boolean>): Promise<UnrelateOutcome> => {
			unrelated.push(owned);
			return (await stillWanted()) ? { status: "kept" } : { status: "deleted" };
		},
	} as unknown as Mirror;
	const graphs: Record<string, GraphView> = { [GRAPH]: input.registered, ...input.graphs };
	const index = {
		registerGraph: async () => input.registered,
		getGraph: async (id: string) => graphs[id] ?? null,
		graphIdsForLinearIssue: async () => input.holders ?? [],
	};
	const greptime = {
		readEvents: async () => {
			if (input.ledger === "unreadable") throw new Error("ledger unavailable");
			return input.ledger;
		},
	};
	const substrate = new Substrate(loadConfig({}), {
		index: index as never,
		greptime: greptime as never,
		mirror,
		steering: { history: null, liveSessions: null },
	});
	const emitted: EventInput[] = [];
	substrate.emit = (async (event: EventInput) => {
		emitted.push(event);
		return { stored: true } as never;
	}) as never;
	return { substrate, unrelated, emitted };
}

const unrelateEvents = (emitted: EventInput[]) =>
	emitted.filter((event) => (event.payload as { op?: unknown } | undefined)?.op === "unrelate");

describe("an edge removed from the graph removes the relation the mirror created (G4)", () => {
	test("the relation the ledger records as created for the removed edge is deleted, and the removal is recorded", async () => {
		const { substrate, unrelated, emitted } = setup({
			registered: viewOf(GRAPH, PAIR, []),
			ledger: [createdRow("rel-1")],
		});
		await substrate.registerGraph({ graph_id: GRAPH, nodes: [], edges: [] } as never);
		expect(unrelated.map((owned) => [owned.id, owned.blockerNode, owned.waitingNode])).toEqual([["rel-1", "n1", "n2"]]);
		const [event] = unrelateEvents(emitted);
		expect(event?.payload).toMatchObject({ op: "unrelate", status: "ok", relation_id: "rel-1", blocker_node: "n1", waiting_node: "n2" });
	});

	test("a relation another graph still holds is kept: asked, not deleted, and not recorded as a removal", async () => {
		const other = viewOf("ut-2", PAIR.map((node) => ({ ...node, node_id: node.node_id === "n1" ? "a" : "b" })), [
			{ from_node: "b", to_node: "a", kind: "requires" },
		]);
		const { substrate, unrelated, emitted } = setup({
			registered: viewOf(GRAPH, PAIR, []),
			ledger: [createdRow("rel-1")],
			graphs: { "ut-2": other },
			holders: ["ut-2"],
		});
		await substrate.registerGraph({ graph_id: GRAPH, nodes: [], edges: [] } as never);
		expect(unrelated).toHaveLength(1);
		expect(unrelateEvents(emitted)).toEqual([]);
	});

	test("an edge still in the graph keeps its relation untouched", async () => {
		const { substrate, unrelated } = setup({
			registered: viewOf(GRAPH, PAIR, [{ from_node: "n2", to_node: "n1", kind: "requires" }]),
			ledger: [createdRow("rel-1")],
		});
		await substrate.registerGraph({ graph_id: GRAPH, nodes: [], edges: [{ from_node: "n2", to_node: "n1", kind: "requires" }] } as never);
		expect(unrelated).toEqual([]);
	});

	test("a registration that does not replace the edge set removes nothing", async () => {
		const { substrate, unrelated } = setup({ registered: viewOf(GRAPH, PAIR, []), ledger: [createdRow("rel-1")] });
		await substrate.registerGraph({ graph_id: GRAPH, nodes: [] } as never);
		expect(unrelated).toEqual([]);
	});

	test("an unreadable ledger removes nothing, and the registration still returns", async () => {
		const { substrate, unrelated } = setup({ registered: viewOf(GRAPH, PAIR, []), ledger: "unreadable" });
		const view = await substrate.registerGraph({ graph_id: GRAPH, nodes: [], edges: [] } as never);
		expect(unrelated).toEqual([]);
		expect(view.graph_id).toBe(GRAPH);
	});
});
