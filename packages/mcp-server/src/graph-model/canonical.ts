/**
 * Canonical form: the one byte string a logical graph serializes to, the ids derived from content, and the builders that
 * put the two together.
 *
 * The rules, each pinned by a test:
 *
 *   - Object keys sort by UTF-16 code unit and arrays keep their order. Nodes sort by id and edges by
 *     (src, kind, order, dst), so the same logical graph yields the same bytes whatever order it arrived in.
 *   - An id is `<kind>:<base32(sha256(canonical(kind, normalized payload, scope path[, localKey])))[:16]>`: 80 bits of
 *     the digest, lower-case RFC 4648 base32, no padding. The scope path is the ids of the enclosing nodes, outermost
 *     first, so identical content in two places gets two ids. The local key is a producer-chosen key that keeps two
 *     identical siblings apart.
 *   - Text is normalized (NFC, `\n` line ends, no edge whitespace) before it is hashed, and the builders store it that
 *     way, so producers that differ only in those details emit the same bytes.
 *   - `meta` is serialized but never hashed. A timestamp or a run id cannot move an id or the content hash.
 *
 * Everything here is a pure function of its arguments.
 */
import { createHash } from "node:crypto";
import {
	GRAPH_CONTRACT,
	GRAPH_CONTRACT_VERSION,
	type BranchPayload,
	type DecisionPayload,
	type DocumentRefPayload,
	type EdgeDraft,
	type GraphDocument,
	type GraphEdgeKind,
	type GraphNodeKind,
	type JsonObject,
	type ModelEdge,
	type ModelNode,
	type NodeDraft,
	type Producer,
	type PromptSegmentPayload,
	type Provenance,
	type RetrievalPayload,
	type RootPayload,
	type StepPayload,
	type ThoughtPayload,
	type UltrathinkGraphInput,
	type UltrathinkOptions,
} from "./types.ts";

/** UTF-16 code-unit order. Never `localeCompare`: an order that feeds a hash must not depend on the host's locale or ICU build. */
export function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The form text is compared and hashed in: NFC, `\n` for `\r\n` and `\r`, no leading or trailing whitespace. Interior
 * whitespace is left alone, because in a code block or a list it can mean something.
 */
export function normalizeText(text: string): string {
	return text.normalize("NFC").replace(/\r\n?/g, "\n").trim();
}

/** Deeper than any valid document nests: a `meta` object stops at `GraphLimits.maxDepth`, and the document adds a handful of levels. */
const MAX_CANONICAL_DEPTH = 64;

/**
 * JSON with object keys sorted at every depth, so the same value always serializes to the same bytes.
 *
 * Throws (a `TypeError`, or a `RangeError` for nesting) on anything JSON cannot hold faithfully: a non-finite number, a
 * function, a symbol, a bigint, `undefined` inside an array, an object that is not plain. An object property whose value
 * is `undefined` is left out, as `JSON.stringify` leaves it out, so an absent optional field and an explicitly undefined
 * one are the same document. Untrusted input goes through `validateGraph` first; this is for values the module built.
 */
export function canonicalJson(value: unknown): string {
	return encode(value, "$", 0);
}

function encode(value: unknown, path: string, depth: number): string {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError(`canonical JSON cannot hold ${String(value)} at ${path}`);
		return JSON.stringify(value);
	}
	if (typeof value === "object" && value !== null) return encodeContainer(value, path, depth);
	throw new TypeError(`canonical JSON cannot hold a ${typeof value} at ${path}`);
}

function encodeContainer(value: object, path: string, depth: number): string {
	if (depth >= MAX_CANONICAL_DEPTH) throw new RangeError(`canonical JSON nests deeper than ${MAX_CANONICAL_DEPTH} levels at ${path}`);
	if (Array.isArray(value)) {
		// `Array.from` visits holes as `undefined`, which `encode` refuses; `map` would skip them and print an invalid document.
		return `[${Array.from(value, (item, index) => encode(item, `${path}[${index}]`, depth + 1)).join(",")}]`;
	}
	const prototype: unknown = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`canonical JSON holds plain objects only; found another kind of object at ${path}`);
	const record = value as Record<string, unknown>;
	const parts: string[] = [];
	for (const key of Object.keys(record).sort(compareText)) {
		const inner = record[key];
		if (inner === undefined) continue;
		parts.push(`${JSON.stringify(key)}:${encode(inner, `${path}.${key}`, depth + 1)}`);
	}
	return `{${parts.join(",")}}`;
}

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32 in lower case, without padding. */
export function base32Encode(bytes: Uint8Array): string {
	let out = "";
	let buffer = 0;
	let bits = 0;
	for (const byte of bytes) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += BASE32_ALPHABET.charAt((buffer >>> (bits - 5)) & 31);
			bits -= 5;
		}
		// Keep only the bits not yet written, so the buffer never holds more than 12 of them.
		buffer &= (1 << bits) - 1;
	}
	if (bits > 0) out += BASE32_ALPHABET.charAt((buffer << (5 - bits)) & 31);
	return out;
}

export function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A node kind or an edge kind: the prefix of an id. The two sets of names do not overlap. */
export type IdKind = GraphNodeKind | GraphEdgeKind;

export interface IdSpec {
	readonly kind: IdKind;
	/** What the node says. Strings inside it are normalized before they are hashed. */
	readonly payload: object;
	/** The ids of the enclosing nodes, outermost first. Empty for a root and for an edge. */
	readonly scope?: readonly string[] | undefined;
	readonly localKey?: string | undefined;
}

/** 10 bytes are 80 bits are exactly 16 base32 characters: the first 16 characters of the full encoding, without encoding the other 36. */
const ID_DIGEST_BYTES = 10;

/**
 * `<kind>:<base32(sha256(canonical(kind, normalized payload, scope path[, localKey])))[:16]>`. The canonical form is the
 * JSON object `{kind, localKey?, payload, scope}`.
 */
export function deriveId(spec: IdSpec): string {
	const identity: Record<string, unknown> = {
		kind: spec.kind,
		payload: normalizeValue(spec.payload),
		scope: [...(spec.scope ?? [])],
	};
	if (spec.localKey !== undefined) identity.localKey = normalizeText(spec.localKey);
	const digest = createHash("sha256").update(canonicalJson(identity), "utf8").digest();
	return `${spec.kind}:${base32Encode(digest.subarray(0, ID_DIGEST_BYTES))}`;
}

/**
 * An edge is identified by its kind and its two ends, which already carry their own scopes. `order`, `score` and
 * provenance are attributes: changing one changes the edge, not which edge it is.
 */
export function deriveEdgeId(kind: GraphEdgeKind, src: string, dst: string): string {
	return deriveId({ kind, payload: { src, dst } });
}

/** Strings normalized, everything else as it came. A copy: the argument is not touched. */
function normalizeValue(value: unknown): unknown {
	if (typeof value === "string") return normalizeText(value);
	if (Array.isArray(value)) return Array.from(value, normalizeValue);
	if (typeof value === "object" && value !== null) {
		// `fromEntries` creates own properties, so a key named `__proto__` stays a key.
		return Object.fromEntries(Object.entries(value).map(([key, inner]): [string, unknown] => [key, normalizeValue(inner)]));
	}
	return value;
}

export function compareNodes(a: ModelNode, b: ModelNode): number {
	return compareText(a.id, b.id);
}

/** (src, kind, order, dst), then id, so the order is total. An edge without an `order` sorts before one with. */
export function compareEdges(a: ModelEdge, b: ModelEdge): number {
	return compareText(a.src, b.src) || compareText(a.kind, b.kind) || compareOrder(a.order, b.order) || compareText(a.dst, b.dst) || compareText(a.id, b.id);
}

function compareOrder(a: number | undefined, b: number | undefined): number {
	if (a === b) return 0;
	if (a === undefined) return -1;
	if (b === undefined) return 1;
	return a < b ? -1 : 1;
}

/** The same document with nodes and edges in canonical order. Nothing else changes, and no node or edge is copied. */
export function canonicalizeGraph(doc: GraphDocument): GraphDocument {
	return { ...doc, nodes: [...doc.nodes].sort(compareNodes), edges: [...doc.edges].sort(compareEdges) };
}

/** The canonical bytes of the whole document, `meta` and producer included. Same logical graph, same string. */
export function serializeGraph(doc: GraphDocument): string {
	return canonicalJson(canonicalizeGraph(doc));
}

/** An item without its `meta`: the part of a node or an edge that counts as content. */
export function withoutMeta(item: object): Record<string, unknown> {
	return Object.fromEntries(Object.entries(item).filter(([key]) => key !== "meta"));
}

/**
 * The SHA-256 (hex) of the graph's content: contract, version, and every node and edge without its `meta`, in canonical
 * order. It is what a diff compares, so an empty diff and an equal hash say the same thing. It leaves out `meta` at every
 * level, `producer` (tooling, not content) and `graphId` (the key the document is filed under), so one graph written
 * twice, by two tool versions, under two keys, hashes once.
 */
export function contentHash(doc: GraphDocument): string {
	const canonical = canonicalizeGraph(doc);
	return sha256Hex(
		canonicalJson({
			contract: canonical.contract,
			version: canonical.version,
			nodes: canonical.nodes.map(withoutMeta),
			edges: canonical.edges.map(withoutMeta),
		}),
	);
}

const DEFAULT_PROVENANCE: Provenance = { origin: "substrate" };

interface NodeSpecOf<K extends GraphNodeKind, P extends object> {
	readonly kind: K;
	readonly payload: P;
	/** The ids of the enclosing nodes, outermost first: where the node sits. */
	readonly scope?: readonly string[] | undefined;
	readonly localKey?: string | undefined;
	/** Defaults to origin `substrate`. */
	readonly provenance?: Provenance | undefined;
	readonly meta?: JsonObject | undefined;
}

/** What `makeNode` takes: the kind-specific payload and where the node sits. The id is derived, never supplied. */
export type NodeSpec =
	| NodeSpecOf<"root", RootPayload>
	| NodeSpecOf<"thought", ThoughtPayload>
	| NodeSpecOf<"step", StepPayload>
	| NodeSpecOf<"branch", BranchPayload>
	| NodeSpecOf<"decision", DecisionPayload>
	| NodeSpecOf<"retrieval", RetrievalPayload>
	| NodeSpecOf<"document_ref", DocumentRefPayload>
	| NodeSpecOf<"prompt_segment", PromptSegmentPayload>;

/**
 * The one place a draft node is asserted to be a `ModelNode`. A `ModelNode` is a union keyed by `kind`, and TypeScript
 * cannot see that a `kind` and a `payload` assembled field by field belong together; callers guarantee it.
 */
export function sealNode(draft: NodeDraft): ModelNode {
	return draft as ModelNode;
}

/** A node with its id derived from its content. The payload is stored in normalized form. */
export function makeNode(spec: NodeSpec): ModelNode {
	const payload = normalizeValue(spec.payload) as typeof spec.payload;
	const draft: NodeDraft = {
		id: deriveId({ kind: spec.kind, payload, scope: spec.scope, localKey: spec.localKey }),
		kind: spec.kind,
		payload,
		provenance: { ...(spec.provenance ?? DEFAULT_PROVENANCE) },
	};
	if (spec.localKey !== undefined) draft.localKey = spec.localKey;
	if (spec.meta !== undefined) draft.meta = spec.meta;
	return sealNode(draft);
}

export interface EdgeSpec {
	readonly kind: GraphEdgeKind;
	readonly src: string;
	readonly dst: string;
	/** Required on `next` and `child`; `validateGraph` rejects an edge of those kinds without one. */
	readonly order?: number | undefined;
	readonly score?: number | undefined;
	/** Defaults to origin `substrate`. */
	readonly provenance?: Provenance | undefined;
	readonly meta?: JsonObject | undefined;
}

/** An edge with its id derived from its kind and its two ends. */
export function makeEdge(spec: EdgeSpec): ModelEdge {
	const edge: EdgeDraft = {
		id: deriveEdgeId(spec.kind, spec.src, spec.dst),
		kind: spec.kind,
		src: spec.src,
		dst: spec.dst,
		provenance: { ...(spec.provenance ?? DEFAULT_PROVENANCE) },
	};
	if (spec.order !== undefined) edge.order = spec.order;
	if (spec.score !== undefined) edge.score = spec.score;
	if (spec.meta !== undefined) edge.meta = spec.meta;
	return edge;
}

export interface GraphSpec {
	readonly graphId: string;
	readonly producer: Producer;
	readonly nodes: readonly ModelNode[];
	readonly edges: readonly ModelEdge[];
	readonly meta?: JsonObject | undefined;
}

/** A document, in canonical order. It is not validated: `validateGraph` is the check. */
export function makeGraph(spec: GraphSpec): GraphDocument {
	return canonicalizeGraph({
		contract: GRAPH_CONTRACT,
		version: GRAPH_CONTRACT_VERSION,
		producer: spec.producer,
		graphId: spec.graphId,
		nodes: spec.nodes,
		edges: spec.edges,
		...(spec.meta === undefined ? {} : { meta: spec.meta }),
	});
}

/** The producer `fromUltrathinkGraph` names when its caller does not. */
export const GRAPH_MODEL_PRODUCER: Producer = { name: "substrate.graph-model", version: "1.0.0" };

/** A step marker at the start of a line: `3.`, `3)`, `**3.**`, `Step 3:`, `Step 3 -`: any number. */
const LINE_MARKER = /^[ \t]*(?:\*\*)?(?:step\s+)?(\d{1,2})(?:[.):]|\s+[-–—])(?:\*\*)?[ \t]+/gim;
/** A step marker inside running text: `2.` or `2)` after whitespace. */
const INLINE_MARKER = /(?:^|\s)(\d{1,2})[.)]\s+/g;

interface Marker {
	readonly start: number;
	readonly end: number;
}

function lineMarkers(text: string): Marker[] {
	const found: Marker[] = [];
	for (const match of text.matchAll(LINE_MARKER)) {
		const leading = match[0].length - match[0].trimStart().length;
		found.push({ start: match.index + leading, end: match.index + match[0].length });
	}
	return found;
}

/** Inline markers must continue the sequence from 1, so `5-8`, `v2.` and a nested list that restarts stay inside their step. */
function sequentialInlineMarkers(text: string): Marker[] {
	const found: Marker[] = [];
	let expected = 1;
	for (const match of text.matchAll(INLINE_MARKER)) {
		if (Number(match[1]) !== expected) continue;
		const leading = match[0].length - match[0].trimStart().length;
		found.push({ start: match.index + leading, end: match.index + match[0].length });
		expected += 1;
	}
	return found;
}

/**
 * The numbered steps of a Chain-of-Thought rationale. It follows the rules Ultrathink splits by, so a node has the same
 * steps on both sides: a one-step-per-line list (`1.`, `2)`, `**3.**`, `Step 4:`) splits on every line marker, even when
 * the model skipped or repeated a number; a rationale run together on one line splits only on markers that continue the
 * sequence from 1; unnumbered text is one step; empty text is none; text before the first marker joins the first step.
 */
export function splitRationaleSteps(rationale: string): string[] {
	const text = rationale.trim();
	if (text === "") return [];
	const byLine = lineMarkers(text);
	const markers = byLine.length >= 2 ? byLine : sequentialInlineMarkers(text);
	const first = markers[0];
	if (first === undefined) return [text];
	const steps = markers.map((marker, index) => {
		const next = markers[index + 1];
		return text.slice(marker.end, next === undefined ? text.length : next.start).trim();
	});
	const preamble = text.slice(0, first.start).trim();
	const head = steps[0];
	if (preamble !== "" && head !== undefined) steps[0] = `${preamble} ${head}`.trim();
	return steps.filter((step) => step !== "");
}

/**
 * Maps an Ultrathink Graph of Thought, with its Chain-of-Thought fill, into a document: a root holding the goal, a
 * `thought` per node (`localKey` is Ultrathink's own node id), a `depends_on` edge per dependency, and a `step` per
 * rationale step, held by its thought with `contains` and chained with `next`. A node with no rationale has no steps.
 *
 * Pure and deterministic: the same graph gives the same bytes, in whatever order its nodes and dependencies are listed.
 * It throws a `RangeError` for a graph Ultrathink's own validation would not have produced, because there is no id to
 * point an edge at: a node id that appears twice, or a dependency on a node that is not there.
 */
export function fromUltrathinkGraph(graph: UltrathinkGraphInput, options: UltrathinkOptions = {}): GraphDocument {
	const provenance: Provenance = { origin: "ultrathink" };
	const root = makeNode({ kind: "root", payload: { goal: graph.goal }, provenance });
	const nodes: ModelNode[] = [root];
	const edges: ModelEdge[] = [];
	const thoughts = new Map<string, ModelNode>();

	for (const source of graph.nodes) {
		if (thoughts.has(source.id)) throw new RangeError(`Ultrathink node id ${JSON.stringify(source.id)} appears more than once`);
		const conclusion = source.conclusion ?? "";
		const payload: ThoughtPayload = {
			title: source.title,
			question: source.question,
			thoughtKind: source.kind,
			...(normalizeText(conclusion) === "" ? {} : { conclusion }),
			...(source.degraded === true ? { degraded: true } : {}),
		};
		const thought = makeNode({ kind: "thought", payload, scope: [root.id], localKey: source.id, provenance });
		thoughts.set(source.id, thought);
		nodes.push(thought);
		edges.push(makeEdge({ kind: "contains", src: root.id, dst: thought.id, provenance }));
	}

	for (const source of graph.nodes) {
		const thought = thoughts.get(source.id);
		if (thought === undefined) continue;

		const dependencies = new Set<string>();
		for (const dependency of source.dependsOn) {
			if (dependencies.has(dependency)) continue;
			dependencies.add(dependency);
			const target = thoughts.get(dependency);
			if (target === undefined) throw new RangeError(`Ultrathink node ${JSON.stringify(source.id)} depends on ${JSON.stringify(dependency)}, which is not in the graph`);
			edges.push(makeEdge({ kind: "depends_on", src: thought.id, dst: target.id, provenance }));
		}

		let previous: ModelNode | undefined;
		for (const [index, text] of splitRationaleSteps(source.thinking ?? "").entries()) {
			const step = makeNode({ kind: "step", payload: { text }, scope: [root.id, thought.id], localKey: String(index + 1), provenance });
			nodes.push(step);
			edges.push(makeEdge({ kind: "contains", src: thought.id, dst: step.id, provenance }));
			if (previous !== undefined) edges.push(makeEdge({ kind: "next", src: previous.id, dst: step.id, order: index - 1, provenance }));
			previous = step;
		}
	}

	return makeGraph({
		graphId: options.graphId ?? root.id,
		producer: options.producer ?? GRAPH_MODEL_PRODUCER,
		nodes,
		edges,
		meta: options.meta,
	});
}
