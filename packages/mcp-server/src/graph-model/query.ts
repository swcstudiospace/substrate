/**
 * Read-only queries over a document.
 *
 * A document is an immutable value, and the first query over one builds an index of it (nodes by id, edges by end, both
 * in canonical order), remembered against that object. Edit a document by making a new one, never in place, or the index
 * answers for the old one. Every result is in an order fixed by the document's content, not by the order its arrays were
 * written in: neighbours follow the canonical edge order (`compareEdges`), so the children of a `decision` come back in
 * `order` and a chain in chain order.
 *
 * Every query is total. An id that is not in the document gives an empty answer, and a document that has not been
 * validated (a cycle, a dangling edge) gives an answer rather than a throw or a loop.
 */
import { compareEdges, compareNodes, compareText } from "./canonical.ts";
import { HIERARCHY_EDGE_KINDS, ORDERED_EDGE_KINDS, ORDERING_EDGE_KINDS, type GraphDocument, type GraphEdgeKind, type ModelEdge, type ModelNode } from "./types.ts";

export type EdgeDirection = "out" | "in" | "both";

interface GraphIndex {
	readonly nodes: ReadonlyMap<string, ModelNode>;
	/** Edges by `src`, in canonical order. */
	readonly out: ReadonlyMap<string, readonly ModelEdge[]>;
	/** Edges by `dst`, in canonical order. */
	readonly incoming: ReadonlyMap<string, readonly ModelEdge[]>;
	/** The root, or the lowest-id root of an invalid document that has several. */
	readonly root: ModelNode | undefined;
}

const INDEXES = new WeakMap<GraphDocument, GraphIndex>();

function append<T>(lists: Map<string, T[]>, key: string, item: T): void {
	const list = lists.get(key);
	if (list === undefined) lists.set(key, [item]);
	else list.push(item);
}

function indexOf(graph: GraphDocument): GraphIndex {
	const cached = INDEXES.get(graph);
	if (cached !== undefined) return cached;
	const nodes = new Map<string, ModelNode>();
	let root: ModelNode | undefined;
	for (const node of graph.nodes) {
		nodes.set(node.id, node);
		if (node.kind === "root" && (root === undefined || node.id < root.id)) root = node;
	}
	const out = new Map<string, ModelEdge[]>();
	const incoming = new Map<string, ModelEdge[]>();
	for (const edge of [...graph.edges].sort(compareEdges)) {
		append(out, edge.src, edge);
		append(incoming, edge.dst, edge);
	}
	const index: GraphIndex = { nodes, out, incoming, root };
	INDEXES.set(graph, index);
	return index;
}

function kindFilter(kinds: GraphEdgeKind | readonly GraphEdgeKind[] | undefined): (kind: GraphEdgeKind) => boolean {
	if (kinds === undefined) return () => true;
	if (typeof kinds === "string") {
		const only = kinds;
		return (kind) => kind === only;
	}
	const wanted = new Set<GraphEdgeKind>(kinds);
	return (kind) => wanted.has(kind);
}

export function getNode(graph: GraphDocument, id: string): ModelNode | undefined {
	return indexOf(graph).nodes.get(id);
}

/**
 * The nodes one edge away, once each. `kind` limits which edges count (one kind, several, or all when omitted) and
 * `direction` which way they are followed: `out` to the nodes `id` points at, `in` to the nodes that point at it, `both`
 * out first.
 */
export function neighbors(graph: GraphDocument, id: string, kind?: GraphEdgeKind | readonly GraphEdgeKind[], direction: EdgeDirection = "out"): ModelNode[] {
	const index = indexOf(graph);
	const wanted = kindFilter(kind);
	const found: ModelNode[] = [];
	const seen = new Set<string>();
	const collect = (edges: readonly ModelEdge[] | undefined, far: "src" | "dst"): void => {
		for (const edge of edges ?? []) {
			if (!wanted(edge.kind)) continue;
			const farId = edge[far];
			if (seen.has(farId)) continue;
			const node = index.nodes.get(farId);
			if (node === undefined) continue;
			seen.add(farId);
			found.push(node);
		}
	};
	if (direction !== "in") collect(index.out.get(id), "dst");
	if (direction !== "out") collect(index.incoming.get(id), "src");
	return found;
}

/** Breadth-first from `start`, never revisiting a node, so a cycle ends the walk instead of continuing it. */
function reach(graph: GraphDocument, start: string, kinds: readonly GraphEdgeKind[], direction: "out" | "in"): ModelNode[] {
	const index = indexOf(graph);
	if (!index.nodes.has(start)) return [];
	const wanted = kindFilter(kinds);
	const edgesOf = direction === "out" ? index.out : index.incoming;
	const seen = new Set<string>([start]);
	const found: ModelNode[] = [];
	let frontier: string[] = [start];
	while (frontier.length > 0) {
		const next: string[] = [];
		for (const id of frontier) {
			for (const edge of edgesOf.get(id) ?? []) {
				if (!wanted(edge.kind)) continue;
				const farId = direction === "out" ? edge.dst : edge.src;
				if (seen.has(farId)) continue;
				const node = index.nodes.get(farId);
				if (node === undefined) continue;
				seen.add(farId);
				found.push(node);
				next.push(farId);
			}
		}
		frontier = next;
	}
	return found;
}

/**
 * Everything below `id`: the nodes reachable by following edges of `kinds` from source to target, nearest first. By
 * default the hierarchy kinds (`contains`, `child`, `next`), not `depends_on`, which points from a node to what it needs
 * first and so reads as ancestry, not descent.
 */
export function descendants(graph: GraphDocument, id: string, kinds: readonly GraphEdgeKind[] = HIERARCHY_EDGE_KINDS): ModelNode[] {
	return reach(graph, id, kinds, "out");
}

/** Everything above `id`: the nodes from which it is reachable by edges of `kinds`, nearest first. */
export function ancestors(graph: GraphDocument, id: string, kinds: readonly GraphEdgeKind[] = HIERARCHY_EDGE_KINDS): ModelNode[] {
	return reach(graph, id, kinds, "in");
}

/** A piece of a document: some of its nodes and the edges among them. It is a view, not a document: it need not have a root. */
export interface Subgraph {
	readonly root: string;
	readonly nodes: readonly ModelNode[];
	readonly edges: readonly ModelEdge[];
}

/**
 * The nodes within `depth` edges of `root`, following edges of `edgeKinds` (all kinds when omitted) from source to
 * target, and every edge of those kinds that runs between two of them. Depth 0 is `root` alone; `Infinity` is no limit. A
 * `root` that is not in the document gives an empty subgraph.
 */
export function subgraph(graph: GraphDocument, root: string, depth: number, edgeKinds?: readonly GraphEdgeKind[]): Subgraph {
	const index = indexOf(graph);
	const start = index.nodes.get(root);
	if (start === undefined) return { root, nodes: [], edges: [] };
	const wanted = kindFilter(edgeKinds);
	const limit = Number.isNaN(depth) ? 0 : Math.max(0, Math.floor(depth));
	const members = new Set<string>([root]);
	const nodes: ModelNode[] = [start];
	let frontier: string[] = [root];
	for (let level = 0; level < limit && frontier.length > 0; level++) {
		const next: string[] = [];
		for (const id of frontier) {
			for (const edge of index.out.get(id) ?? []) {
				if (!wanted(edge.kind) || members.has(edge.dst)) continue;
				const node = index.nodes.get(edge.dst);
				if (node === undefined) continue;
				members.add(edge.dst);
				nodes.push(node);
				next.push(edge.dst);
			}
		}
		frontier = next;
	}
	const edges: ModelEdge[] = [];
	for (const id of members) {
		for (const edge of index.out.get(id) ?? []) {
			if (wanted(edge.kind) && members.has(edge.dst)) edges.push(edge);
		}
	}
	return { root, nodes: nodes.sort(compareNodes), edges: edges.sort(compareEdges) };
}

/** The pair an ordering edge puts in order: `depends_on` runs backwards (the dependency comes first), the rest forwards. */
function orient(edge: ModelEdge): readonly [before: string, after: string] {
	return edge.kind === "depends_on" ? [edge.dst, edge.src] : [edge.src, edge.dst];
}

/** For each node, the nodes that must come after it, sorted and without repeats. Edges to or from a node that is not there are skipped. */
function precedence(graph: GraphDocument, ids: ReadonlySet<string>, wanted: ReadonlySet<string>): Map<string, string[]> {
	const successors = new Map<string, string[]>();
	for (const edge of graph.edges) {
		if (!wanted.has(edge.kind) || !ids.has(edge.src) || !ids.has(edge.dst)) continue;
		const [before, after] = orient(edge);
		append(successors, before, after);
	}
	for (const [id, list] of successors) successors.set(id, [...new Set(list)].sort(compareText));
	return successors;
}

/**
 * One cycle among the ordering edges, as the ids along it with the first repeated at the end, or null when there is
 * none. `kinds` defaults to `depends_on`, `contains`, `child` and `next`, read as precedence: `contains`, `child` and
 * `next` put the source first and `depends_on` puts its target first, so a child that depends on its parent is in order,
 * not a cycle. Iterative, so a chain of any length is safe; deterministic, so the same document always names the same cycle.
 */
export function findCycle(graph: GraphDocument, kinds: readonly GraphEdgeKind[] = ORDERING_EDGE_KINDS): string[] | null {
	const ids = new Set<string>();
	for (const node of graph.nodes) ids.add(node.id);
	const successors = precedence(graph, ids, new Set<string>(kinds));
	const ON_PATH = 1;
	const DONE = 2;
	const state = new Map<string, number>();
	for (const start of [...ids].sort(compareText)) {
		if (state.has(start)) continue;
		const stack: Array<{ readonly id: string; next: number }> = [{ id: start, next: 0 }];
		const path: string[] = [start];
		state.set(start, ON_PATH);
		while (stack.length > 0) {
			const frame = stack[stack.length - 1];
			if (frame === undefined) break;
			const targets = successors.get(frame.id) ?? [];
			if (frame.next >= targets.length) {
				state.set(frame.id, DONE);
				stack.pop();
				path.pop();
				continue;
			}
			const target = targets[frame.next];
			frame.next += 1;
			if (target === undefined) continue;
			const seen = state.get(target);
			if (seen === ON_PATH) return [...path.slice(path.indexOf(target)), target];
			if (seen === undefined) {
				state.set(target, ON_PATH);
				stack.push({ id: target, next: 0 });
				path.push(target);
			}
		}
	}
	return null;
}

/** Smaller `order` first; a node no ordered edge enters has none, and comes after those that do. */
function compareRank(a: number | undefined, b: number | undefined): number {
	if (a === b) return 0;
	if (a === undefined) return 1;
	if (b === undefined) return -1;
	return a < b ? -1 : 1;
}

/**
 * Every node in an order that honours every edge of `kinds` (default: `depends_on`, `contains`, `child`, `next`, read as
 * precedence; see `findCycle`), or null when those edges form a cycle. Where several nodes could come next, the one
 * entered by the lowest `order` goes first, so siblings come out in sibling order and a chain in chain order, and
 * remaining ties go to the lowest id. The order depends only on the document's content.
 */
export function topoOrder(graph: GraphDocument, kinds: readonly GraphEdgeKind[] = ORDERING_EDGE_KINDS): ModelNode[] | null {
	const index = indexOf(graph);
	const ids = new Set<string>(index.nodes.keys());
	const wanted = new Set<string>(kinds);
	const successors = precedence(graph, ids, wanted);

	const waiting = new Map<string, number>();
	for (const id of ids) waiting.set(id, 0);
	for (const targets of successors.values()) {
		for (const target of targets) waiting.set(target, (waiting.get(target) ?? 0) + 1);
	}

	const rank = new Map<string, number>();
	for (const edge of graph.edges) {
		if (edge.order === undefined || !ORDERED_EDGE_KINDS.includes(edge.kind) || !wanted.has(edge.kind) || !ids.has(edge.src) || !ids.has(edge.dst)) continue;
		const known = rank.get(edge.dst);
		if (known === undefined || edge.order < known) rank.set(edge.dst, edge.order);
	}
	const ranked = [...index.nodes.values()].sort((a, b) => compareRank(rank.get(a.id), rank.get(b.id)) || compareText(a.id, b.id));
	const priority = new Map<string, number>();
	for (const [position, node] of ranked.entries()) priority.set(node.id, position);

	// Priorities of the nodes that can go next, largest first, so `pop` takes the smallest. Each insert is a binary search.
	const ready: number[] = [];
	const release = (id: string): void => {
		const position = priority.get(id);
		if (position === undefined) return;
		let low = 0;
		let high = ready.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			const held = ready[middle];
			if (held !== undefined && held > position) low = middle + 1;
			else high = middle;
		}
		ready.splice(low, 0, position);
	};
	for (const [id, count] of waiting) {
		if (count === 0) release(id);
	}

	const order: ModelNode[] = [];
	for (;;) {
		const position = ready.pop();
		if (position === undefined) break;
		const node = ranked[position];
		if (node === undefined) continue;
		order.push(node);
		for (const target of successors.get(node.id) ?? []) {
			const left = (waiting.get(target) ?? 0) - 1;
			waiting.set(target, left);
			if (left === 0) release(target);
		}
	}
	return order.length === ranked.length ? order : null;
}

/**
 * The chain of choices from `from` (default: the root): the node, then the target of its `selected` edge, then the
 * target of that node's, until a node has none. A node that has several `selected` edges follows the first in canonical
 * order, and a chain that loops back ends where it would repeat. A decision nested inside a branch starts its own chain:
 * pass it as `from`. An unknown `from` gives an empty path.
 */
export function selectedPath(graph: GraphDocument, from?: string): ModelNode[] {
	const index = indexOf(graph);
	let current = from === undefined ? index.root : index.nodes.get(from);
	if (current === undefined) return [];
	const path: ModelNode[] = [current];
	const seen = new Set<string>([current.id]);
	for (;;) {
		let next: ModelNode | undefined;
		for (const edge of index.out.get(current.id) ?? []) {
			if (edge.kind !== "selected") continue;
			next = index.nodes.get(edge.dst);
			if (next !== undefined) break;
		}
		if (next === undefined || seen.has(next.id)) return path;
		path.push(next);
		seen.add(next.id);
		current = next;
	}
}
