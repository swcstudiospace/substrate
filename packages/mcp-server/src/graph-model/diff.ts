/**
 * What changed between two documents, by id.
 *
 * Ids are derived from content, so the same node in two runs has the same id. A node (or an edge) is *added* when only
 * the second document has its id, *removed* when only the first does, and *changed* when both do and the two differ.
 * `meta` is ignored at every level, as it is by the content hash: two documents that differ only in a timestamp or a run
 * id have an empty diff, and an empty diff means an equal content hash.
 *
 * What can change under one id: a node's provenance, since the payload, the scope and the local key are what the id was
 * derived from; an edge's `order`, `score` and provenance, since its id is derived from its kind and its two ends.
 *
 * The lists are in canonical order (nodes by id, edges by src, kind, order, dst; changes by id), so the diff of two
 * documents is the same whatever order their arrays were written in. Ids are taken to be unique within a document; for an
 * invalid document with a repeated id the last one counts.
 */
import { canonicalJson, compareEdges, compareNodes, compareText, withoutMeta } from "./canonical.ts";
import type { GraphDocument, ModelEdge, ModelNode } from "./types.ts";

export interface Change<T> {
	readonly id: string;
	readonly before: T;
	readonly after: T;
}

export interface Delta<T> {
	readonly added: readonly T[];
	readonly removed: readonly T[];
	readonly changed: readonly Change<T>[];
}

export interface GraphDiff {
	readonly nodes: Delta<ModelNode>;
	readonly edges: Delta<ModelEdge>;
}

function deltaOf<T extends { readonly id: string }>(before: readonly T[], after: readonly T[], compare: (a: T, b: T) => number): Delta<T> {
	const previous = new Map<string, T>();
	for (const item of before) previous.set(item.id, item);
	const current = new Map<string, T>();
	for (const item of after) current.set(item.id, item);

	const added: T[] = [];
	const changed: Array<Change<T>> = [];
	for (const [id, item] of current) {
		const was = previous.get(id);
		if (was === undefined) added.push(item);
		else if (was !== item && canonicalJson(withoutMeta(was)) !== canonicalJson(withoutMeta(item))) changed.push({ id, before: was, after: item });
	}
	const removed: T[] = [];
	for (const [id, item] of previous) {
		if (!current.has(id)) removed.push(item);
	}
	return { added: added.sort(compare), removed: removed.sort(compare), changed: changed.sort((a, b) => compareText(a.id, b.id)) };
}

/** The nodes and edges added, removed and changed going from `a` to `b`. */
export function diff(a: GraphDocument, b: GraphDocument): GraphDiff {
	return { nodes: deltaOf(a.nodes, b.nodes, compareNodes), edges: deltaOf(a.edges, b.edges, compareEdges) };
}
