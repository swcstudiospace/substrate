/**
 * Graph edges at registration (phase 38, B-D1 and B-D3). Each created or failed edge leaves one outcome event on the
 * node that waits, so the outcome sits in that node's evidence. A relation that already exists or an edge with no
 * tracker issue records nothing. A Linear failure never fails the registration behind it.
 */
import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";
import { type CacheRedis, ReadThroughCache } from "./cache.ts";
import type { EdgeOutcome, EdgeRelation, Mirror } from "./mirror.ts";
import { Substrate } from "./service.ts";
import type { EventInput } from "./types.ts";

const GRAPH = "ut-1";

/** The in-memory Redis stand-in the cache rig uses; the read-through cache needs get, set and incr only. */
class MemoryRedis implements CacheRedis {
	readonly values = new Map<string, string>();

	async get(key: string): Promise<string | null> {
		return this.values.get(key) ?? null;
	}

	async set(key: string, value: string): Promise<void> {
		this.values.set(key, value);
	}

	async incr(key: string): Promise<number> {
		const next = Number(this.values.get(key) ?? "0") + 1;
		this.values.set(key, String(next));
		return next;
	}
}

function nodes(refs: Record<string, string | null>) {
	return Object.entries(refs).map(([node_id, ref]) => ({
		graph_id: GRAPH,
		node_id,
		state: "open",
		linear_issue_id: ref,
		linear_identifier: ref,
	}));
}

/** A graph view as `registerGraph` returns it: nodes and edges, with no steps. */
function viewOf(
	refs: Record<string, string | null>,
	edges: Array<{ from_node: string; to_node: string; kind: "requires" | "blocks" | "gated_by" }>,
) {
	return {
		graph_id: GRAPH,
		notion_task_page: null,
		repo: null,
		branch: null,
		surface: null,
		status: null,
		pr_url: null,
		nodes: nodes(refs),
		steps: [],
		edges: edges.map((edge) => ({ graph_id: GRAPH, ...edge })),
	};
}

/** A substrate whose index returns `view`, whose mirror answers `relate`, and whose events are captured. */
function harness(view: unknown, mirror: unknown) {
	const index = { registerGraph: async () => view };
	const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: null, mirror: mirror as never, steering: { history: null, liveSessions: null } });
	const emitted: EventInput[] = [];
	substrate.emit = (async (input: EventInput) => {
		emitted.push(input);
		return { stored: true } as never;
	}) as never;
	return { substrate, emitted };
}

function mirrorAnswering(answer: (edges: EdgeRelation[]) => EdgeOutcome[]) {
	return { relateEdges: async (edges: EdgeRelation[]) => answer(edges) } as unknown as Mirror;
}

const REFS = { n1: "SWC-1", n2: "SWC-2", n3: "SWC-3" };

describe("graph edges at registration", () => {
	test("a created requires edge leaves one note on the node that waits, and the graph still comes back", async () => {
		const view = viewOf(REFS, [{ from_node: "n2", to_node: "n1", kind: "requires" }]);
		const { substrate, emitted } = harness(
			view,
			mirrorAnswering((edges) => edges.map((edge) => ({ ...edge, status: "created" }))),
		);
		const registered = await substrate.registerGraph({ graph_id: GRAPH, edges: view.edges } as never);
		expect(registered.graph_id).toBe(GRAPH);
		expect(emitted).toHaveLength(1);
		expect(emitted[0]).toMatchObject({ kind: "note", surface: "substrate", graph_id: GRAPH, node_id: "n2" });
		expect(emitted[0]?.payload).toMatchObject({ action: "mirror", target: "linear", op: "relate", edge_kind: "requires", status: "ok" });
	});

	test("a blocks edge is recorded on the node it points at, which is the one waiting", async () => {
		const view = viewOf(REFS, [{ from_node: "n1", to_node: "n3", kind: "blocks" }]);
		const { substrate, emitted } = harness(
			view,
			mirrorAnswering((edges) => edges.map((edge) => ({ ...edge, status: "created" }))),
		);
		await substrate.registerGraph({ graph_id: GRAPH, edges: view.edges } as never);
		expect(emitted.map((event) => event.node_id)).toEqual(["n3"]);
		expect(emitted[0]?.payload).toMatchObject({ blocker_node: "n1", waiting_node: "n3" });
	});

	test("each outcome has its own one-event session, so no chain spans two relations", async () => {
		const view = viewOf(REFS, [
			{ from_node: "n2", to_node: "n1", kind: "requires" },
			{ from_node: "n3", to_node: "n1", kind: "gated_by" },
		]);
		const { substrate, emitted } = harness(
			view,
			mirrorAnswering((edges) => edges.map((edge) => ({ ...edge, status: "created" }))),
		);
		await substrate.registerGraph({ graph_id: GRAPH, edges: view.edges } as never);
		expect(emitted).toHaveLength(2);
		expect(new Set(emitted.map((event) => event.session_id)).size).toBe(2);
	});

	test("a relation that already exists, or an edge with no tracker issue, records nothing", async () => {
		const view = viewOf({ n1: "SWC-1", n2: null }, [{ from_node: "n2", to_node: "n1", kind: "requires" }]);
		const { substrate, emitted } = harness(
			view,
			mirrorAnswering((edges) => edges.map((edge) => ({ ...edge, status: edge.waitingRef ? "existing" : "skipped" }))),
		);
		await substrate.registerGraph({ graph_id: GRAPH, edges: view.edges } as never);
		expect(emitted).toEqual([]);
	});

	test("a failed relation records a warning on the waiting node, and the registration still returns", async () => {
		const view = viewOf(REFS, [{ from_node: "n2", to_node: "n1", kind: "requires" }]);
		const { substrate, emitted } = harness(
			view,
			mirrorAnswering((edges) => edges.map((edge) => ({ ...edge, status: "failed", reason: "linear down" }))),
		);
		const registered = await substrate.registerGraph({ graph_id: GRAPH, edges: view.edges } as never);
		expect(registered.graph_id).toBe(GRAPH);
		expect(emitted).toHaveLength(1);
		expect(emitted[0]).toMatchObject({ kind: "warning", node_id: "n2" });
		expect(emitted[0]?.payload).toMatchObject({ status: "failed", reason: "linear down" });
	});

	test("a mirror that throws still lets the registration return, with a warning for each edge", async () => {
		const view = viewOf(REFS, [{ from_node: "n2", to_node: "n1", kind: "requires" }]);
		const throwing = { relateEdges: async () => Promise.reject(new Error("socket hangup")) } as unknown as Mirror;
		const { substrate, emitted } = harness(view, throwing);
		const registered = await substrate.registerGraph({ graph_id: GRAPH, edges: view.edges } as never);
		expect(registered.graph_id).toBe(GRAPH);
		expect(emitted).toHaveLength(1);
		expect(emitted[0]).toMatchObject({ kind: "warning", node_id: "n2" });
		expect(emitted[0]?.payload).toMatchObject({ reason: "socket hangup" });
	});

	test("a graph with no mirror behind it registers and records nothing", async () => {
		const view = viewOf(REFS, [{ from_node: "n2", to_node: "n1", kind: "requires" }]);
		const { substrate, emitted } = harness(view, null);
		const registered = await substrate.registerGraph({ graph_id: GRAPH } as never);
		expect(registered.graph_id).toBe(GRAPH);
		expect(emitted).toEqual([]);
	});

	test("a request that names no edges writes no relation, so a status-only update touches no tracker", async () => {
		const view = viewOf(REFS, [{ from_node: "n2", to_node: "n1", kind: "requires" }]);
		const related: unknown[] = [];
		const mirror = {
			relateEdges: async (edges: unknown[]) => {
				related.push(edges);
				return [];
			},
		} as unknown as Mirror;
		const { substrate, emitted } = harness(view, mirror);

		await substrate.registerGraph({ graph_id: GRAPH } as never);

		expect(related).toEqual([]);
		expect(emitted).toEqual([]);
	});

	test("a node that gains a Linear reference relates the graph's saved edges, though the request names none", async () => {
		const view = viewOf(REFS, [{ from_node: "n2", to_node: "n1", kind: "requires" }]);
		const related: unknown[] = [];
		const mirror = {
			relateEdges: async (edges: unknown[]) => {
				related.push(edges);
				return [];
			},
		} as unknown as Mirror;
		const { substrate } = harness(view, mirror);

		await substrate.registerGraph({ graph_id: GRAPH, nodes: [{ node_id: "n2", linear_identifier: "SWC-2" }] } as never);

		expect(related).toHaveLength(1);
	});

	test("a null tracker field changes no link, so it relates nothing", async () => {
		const view = viewOf(REFS, [{ from_node: "n2", to_node: "n1", kind: "requires" }]);
		const related: unknown[] = [];
		const mirror = {
			relateEdges: async (edges: unknown[]) => {
				related.push(edges);
				return [];
			},
		} as unknown as Mirror;
		const { substrate } = harness(view, mirror);

		await substrate.registerGraph({ graph_id: GRAPH, nodes: [{ node_id: "n2", linear_identifier: null }] } as never);

		expect(related).toEqual([]);
	});

	test("while a Linear relation is still being written, reads already show the registered graph", async () => {
		const view = viewOf(REFS, [{ from_node: "n2", to_node: "n1", kind: "requires" }]);
		let stored = { ...view, notion_task_page: "before" };
		const indexWritten = Promise.withResolvers<void>();
		const index = {
			getGraph: async () => stored,
			registerGraph: async () => {
				stored = { ...view, notion_task_page: "after" };
				indexWritten.resolve();
				return view;
			},
		};
		const release = Promise.withResolvers<void>();
		const mirror = {
			relateEdges: async () => {
				await release.promise;
				return [];
			},
		} as unknown as Mirror;
		const cache = new ReadThroughCache({ redis: new MemoryRedis(), enabled: true, log: () => {} });
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: null, mirror: mirror as never, cache, steering: { history: null, liveSessions: null } });

		expect(await substrate.getGraph(GRAPH)).toMatchObject({ graph_id: GRAPH, notion_task_page: "before" });
		const registering = substrate.registerGraph({ graph_id: GRAPH, edges: view.edges } as never);
		await indexWritten.promise;
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(await substrate.getGraph(GRAPH)).toMatchObject({ graph_id: GRAPH, notion_task_page: "after" });
		release.resolve();
		await registering;
	});
});
