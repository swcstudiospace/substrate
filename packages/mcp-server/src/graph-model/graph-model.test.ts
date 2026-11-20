/**
 * The graph model's contract, pinned test by test: ids derived from content, one canonical byte form, layered
 * validation with typed errors, the query primitives, the diff, and the Ultrathink mapping.
 *
 * `composition()` is the shared fixture: a graph of thoughts with a tree inside one of them and a chain inside one of its
 * branches, plus a retrieval, a document reference and a prompt segment, so every node kind and every edge kind appears.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { defined } from "../test-support.ts";
import { base32Encode, canonicalJson, compareEdges, normalizeText, splitRationaleSteps } from "./canonical.ts";
import {
	ContractVersionError,
	DEFAULT_GRAPH_LIMITS,
	GRAPH_EDGE_KINDS,
	GRAPH_MODEL_PRODUCER,
	GRAPH_NODE_KINDS,
	GraphValidationError,
	ORDERED_EDGE_KINDS,
	ORDERING_EDGE_KINDS,
	ancestors,
	canonicalizeGraph,
	contentHash,
	deriveEdgeId,
	deriveId,
	descendants,
	diff,
	findCycle,
	fromUltrathinkGraph,
	getNode,
	loadGraph,
	makeEdge,
	makeGraph,
	makeNode,
	neighbors,
	selectedPath,
	serializeGraph,
	subgraph,
	topoOrder,
	validateGraph,
	type GraphDocument,
	type GraphEdgeKind,
	type GraphValidation,
	type JsonObject,
	type ModelEdge,
	type ModelNode,
	type ThoughtPayload,
	type UltrathinkGraphInput,
} from "./index.ts";

type Raw = Record<string, unknown>;

const PRODUCER = { name: "graph-model.test", version: "1.0.0" };

const idsOf = (nodes: readonly ModelNode[]): string[] => nodes.map((node) => node.id);

/** The graph of an accepted result, or a failed test that says why the document was refused. */
function accepted(result: GraphValidation): GraphDocument {
	if (!result.ok) throw new Error(`expected a valid document, got: ${result.errors.map((error) => `${error.code} ${error.path}`).join("; ")}`);
	return result.graph;
}

/** The errors of a refused result, or a failed test that says the document was accepted. */
function rejected(result: GraphValidation): readonly GraphValidationError[] {
	if (result.ok) throw new Error("expected the document to be refused");
	return result.errors;
}

function has(errors: readonly GraphValidationError[], code: string, path: string): boolean {
	return errors.some((error) => error.code === code && error.path === path);
}

/** A copy of an object without one key: a document with a required field missing. */
function without(value: object, key: string): Raw {
	return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

function withEdges(doc: GraphDocument, ...extra: readonly ModelEdge[]): GraphDocument {
	return { ...doc, edges: [...doc.edges, ...extra] };
}

function withNodes(doc: GraphDocument, ...extra: readonly ModelNode[]): GraphDocument {
	return { ...doc, nodes: [...doc.nodes, ...extra] };
}

function withScore(node: ModelNode, score: number): ModelNode {
	return { ...node, provenance: { ...node.provenance, score } };
}

/** A fixed pseudo-random permutation: the same seed shuffles the same way, so a failure reproduces. */
function shuffle<T>(items: readonly T[], seed: number): T[] {
	let state = seed >>> 0;
	const keyed = items.map((item) => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return { item, key: state };
	});
	return keyed.sort((a, b) => a.key - b.key).map((entry) => entry.item);
}

function reverseKeysDeep(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(reverseKeysDeep);
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(
			Object.entries(value)
				.reverse()
				.map(([key, inner]): [string, unknown] => [key, reverseKeysDeep(inner)]),
		);
	}
	return value;
}

/** The same value with every object's keys inserted in the opposite order, so key order cannot be what makes two documents equal. */
function reverseKeys<T>(value: T): T {
	return reverseKeysDeep(value) as T;
}

interface LinkExtra {
	readonly order?: number | undefined;
	readonly score?: number | undefined;
	readonly meta?: JsonObject | undefined;
}

function link(kind: GraphEdgeKind, src: ModelNode, dst: ModelNode, extra: LinkExtra = {}): ModelEdge {
	return makeEdge({ kind, src: src.id, dst: dst.id, order: extra.order, score: extra.score, meta: extra.meta });
}

/** Whether the ordering edges of `doc` put `before` ahead of `after`, with `depends_on` read backwards. */
function precedes(doc: GraphDocument, before: string, after: string): boolean {
	return doc.edges.some((edge) => (edge.kind === "depends_on" ? edge.dst === before && edge.src === after : ORDERING_EDGE_KINDS.includes(edge.kind) && edge.src === before && edge.dst === after));
}

interface Composition {
	readonly doc: GraphDocument;
	readonly root: ModelNode;
	readonly t1: ModelNode;
	readonly t2: ModelNode;
	readonly t3: ModelNode;
	readonly decision: ModelNode;
	readonly b0: ModelNode;
	readonly b1: ModelNode;
	readonly s0: ModelNode;
	readonly s1: ModelNode;
	readonly s2: ModelNode;
	readonly retrieval: ModelNode;
	readonly ref: ModelNode;
	readonly segment: ModelNode;
}

/**
 * A graph (t1, t2, t3 joined by depends_on) with a tree inside t2 (a decision, two ordered scored branches, a selected
 * edge to b1) and a chain inside b1 (s0, s1, s2 joined by next). `volatile` is put in `meta` on the document, on every node
 * and on every edge.
 */
function composition(volatile?: JsonObject): Composition {
	const root = makeNode({ kind: "root", payload: { goal: "Ship the graph model" }, meta: volatile });
	const thought = (key: string, title: string, question: string): ModelNode => makeNode({ kind: "thought", payload: { title, question }, scope: [root.id], localKey: key, meta: volatile });
	const t1 = thought("n1", "Understand", "What is being asked?");
	const t2 = thought("n2", "Choose an approach", "Which approach fits?");
	const t3 = thought("n3", "Write the plan", "What is the plan?");
	const decision = makeNode({ kind: "decision", payload: { question: "Which approach?" }, scope: [root.id, t2.id], meta: volatile });
	const branch = (key: string, label: string): ModelNode => makeNode({ kind: "branch", payload: { label }, scope: [root.id, t2.id, decision.id], localKey: key, meta: volatile });
	const b0 = branch("0", "Extend the tracker index");
	const b1 = branch("1", "Add a typed model beside it");
	const step = (key: string, text: string): ModelNode => makeNode({ kind: "step", payload: { text }, scope: [root.id, t2.id, b1.id], localKey: key, meta: volatile });
	const s0 = step("0", "Read the tracker types");
	const s1 = step("1", "List what they cannot say");
	const s2 = step("2", "Draft the contract");
	const retrieval = makeNode({ kind: "retrieval", payload: { query: "how do leases heartbeat" }, scope: [root.id], provenance: { origin: "lightrag" }, meta: volatile });
	const ref = makeNode({
		kind: "document_ref",
		payload: { docId: "doc-42", docHash: "9f2c" },
		scope: [root.id, retrieval.id],
		provenance: { origin: "lightrag", sourceDocId: "doc-42", sourceDocHash: "9f2c", score: 0.82 },
		meta: volatile,
	});
	const segment = makeNode({ kind: "prompt_segment", payload: { role: "system", text: "Answer from the cited passages only." }, scope: [root.id], meta: volatile });

	const plain: LinkExtra = { meta: volatile };
	const edges: ModelEdge[] = [
		link("contains", root, t1, plain),
		link("contains", root, t2, plain),
		link("contains", root, t3, plain),
		link("depends_on", t2, t1, plain),
		link("depends_on", t3, t2, plain),
		link("contains", t2, decision, plain),
		link("child", decision, b0, { ...plain, order: 0, score: 0.4 }),
		link("child", decision, b1, { ...plain, order: 1, score: 0.9 }),
		link("selected", decision, b1, plain),
		link("contains", b1, s0, plain),
		link("contains", b1, s1, plain),
		link("contains", b1, s2, plain),
		link("next", s0, s1, { ...plain, order: 0 }),
		link("next", s1, s2, { ...plain, order: 1 }),
		link("contains", root, retrieval, plain),
		link("contains", retrieval, ref, plain),
		link("retrieved_for", ref, t2, plain),
		link("supports", ref, b1, plain),
		link("contradicts", ref, b0, plain),
		link("contains", root, segment, plain),
	];
	const doc = makeGraph({
		graphId: "graph-composition",
		producer: PRODUCER,
		nodes: [root, t1, t2, t3, decision, b0, b1, s0, s1, s2, retrieval, ref, segment],
		edges,
		meta: volatile,
	});
	return { doc, root, t1, t2, t3, decision, b0, b1, s0, s1, s2, retrieval, ref, segment };
}

describe("canonical JSON", () => {
	test("sorts keys at every depth, keeps array order and leaves out undefined properties", () => {
		expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null }, e: undefined })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
	});

	test("gives the same bytes whatever order the keys were inserted in", () => {
		expect(canonicalJson({ x: { p: 1, q: 2 }, y: [1, 2] })).toBe(canonicalJson({ y: [1, 2], x: { q: 2, p: 1 } }));
	});

	test("escapes strings as JSON does and writes -0 as 0", () => {
		expect(canonicalJson('a\n"b" é')).toBe(JSON.stringify('a\n"b" é'));
		expect(canonicalJson(-0)).toBe("0");
	});

	test("refuses what JSON cannot hold faithfully", () => {
		expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
		expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(TypeError);
		expect(() => canonicalJson([undefined])).toThrow(TypeError);
		expect(() => canonicalJson(() => 1)).toThrow(TypeError);
		expect(() => canonicalJson(10n)).toThrow(TypeError);
		expect(() => canonicalJson({ when: new Date(0) })).toThrow(TypeError);
	});

	test("refuses nesting deeper than any valid document", () => {
		let deep: unknown = 1;
		for (let level = 0; level < 100; level++) deep = { next: deep };
		expect(() => canonicalJson(deep)).toThrow(RangeError);
	});
});

describe("text normalization", () => {
	test("is NFC, newline line ends and no edge whitespace, and leaves interior whitespace alone", () => {
		expect(normalizeText("  cafe\u0301\r\nsecond  line\rthird \n")).toBe("caf\u00e9\nsecond  line\nthird");
	});

	test("is idempotent", () => {
		for (const text of ["  a\r\nb  ", "e\u0301\u0301 x", "\t\n", "already normal"]) expect(normalizeText(normalizeText(text))).toBe(normalizeText(text));
	});
});

describe("base32", () => {
	test("matches the RFC 4648 test vectors, in lower case and without padding", () => {
		const vectors: ReadonlyArray<readonly [string, string]> = [
			["", ""],
			["f", "my"],
			["fo", "mzxq"],
			["foo", "mzxw6"],
			["foob", "mzxw6yq"],
			["fooba", "mzxw6ytb"],
			["foobar", "mzxw6ytboi"],
		];
		for (const [text, expected] of vectors) expect(base32Encode(new TextEncoder().encode(text))).toBe(expected);
	});
});

describe("ids", () => {
	test("are the kind, a colon and 16 lower-case base32 characters", () => {
		const id = deriveId({ kind: "thought", payload: { title: "a", question: "b" } });
		expect(id).toMatch(/^thought:[a-z2-7]{16}$/);
		expect(deriveEdgeId("contains", "root:aaaaaaaaaaaaaaaa", id)).toMatch(/^contains:[a-z2-7]{16}$/);
	});

	test("are the first 16 base32 characters of the SHA-256 of the canonical kind, payload, scope and local key", () => {
		const identity = '{"kind":"step","localKey":"1","payload":{"text":"hello"},"scope":["root:aaaaaaaaaaaaaaaa"]}';
		let bits = "";
		for (const byte of createHash("sha256").update(identity, "utf8").digest()) bits += byte.toString(2).padStart(8, "0");
		let encoded = "";
		for (let at = 0; at + 5 <= bits.length; at += 5) encoded += "abcdefghijklmnopqrstuvwxyz234567".charAt(Number.parseInt(bits.slice(at, at + 5), 2));
		expect(deriveId({ kind: "step", payload: { text: "hello" }, scope: ["root:aaaaaaaaaaaaaaaa"], localKey: "1" })).toBe(`step:${encoded.slice(0, 16)}`);
	});

	test("ignore key order, Unicode form, line-ending style and edge whitespace in the payload", () => {
		const scope = ["root:aaaaaaaaaaaaaaaa"];
		expect(deriveId({ kind: "step", payload: { text: "  cafe\u0301\r\nsecond line \n" }, scope })).toBe(deriveId({ kind: "step", payload: { text: "caf\u00e9\nsecond line" }, scope }));
		expect(deriveId({ kind: "thought", payload: { question: "b", title: "a" } })).toBe(deriveId({ kind: "thought", payload: { title: "a", question: "b" } }));
		expect(deriveId({ kind: "thought", payload: { title: "a", question: "b", conclusion: undefined } })).toBe(deriveId({ kind: "thought", payload: { title: "a", question: "b" } }));
	});

	test("change with the kind, the payload, the scope and the local key", () => {
		const base = { kind: "step", payload: { text: "Verify" }, scope: ["root:aaaaaaaaaaaaaaaa"], localKey: "1" } as const;
		const variants = [
			deriveId(base),
			deriveId({ ...base, kind: "branch" }),
			deriveId({ ...base, payload: { text: "Verify!" } }),
			deriveId({ ...base, scope: ["root:bbbbbbbbbbbbbbbb"] }),
			deriveId({ ...base, localKey: "2" }),
			deriveId({ kind: base.kind, payload: base.payload, scope: base.scope }),
		];
		expect(new Set(variants).size).toBe(variants.length);
	});

	test("never depend on meta or provenance", () => {
		const plain = makeNode({ kind: "step", payload: { text: "Verify" }, scope: ["root:aaaaaaaaaaaaaaaa"], localKey: "1" });
		const decorated = makeNode({
			kind: "step",
			payload: { text: "Verify" },
			scope: ["root:aaaaaaaaaaaaaaaa"],
			localKey: "1",
			meta: { at: "2026-11-16T00:00:00Z" },
			provenance: { origin: "lightrag", score: 0.3 },
		});
		expect(decorated.id).toBe(plain.id);
	});

	test("an edge's id comes from its kind and ends, so its order, score and provenance do not move it", () => {
		const a = makeEdge({ kind: "child", src: "decision:aaaaaaaaaaaaaaaa", dst: "branch:bbbbbbbbbbbbbbbb", order: 0, score: 0.1 });
		const b = makeEdge({ kind: "child", src: "decision:aaaaaaaaaaaaaaaa", dst: "branch:bbbbbbbbbbbbbbbb", order: 4, score: 0.9, provenance: { origin: "ultrathink" } });
		expect(b.id).toBe(a.id);
		expect(makeEdge({ kind: "selected", src: "decision:aaaaaaaaaaaaaaaa", dst: "branch:bbbbbbbbbbbbbbbb" }).id).not.toBe(a.id);
	});

	test("makeNode stores the payload in normalized form", () => {
		const node = makeNode({ kind: "step", payload: { text: "  hello\r\nworld \n" } });
		if (node.kind !== "step") throw new Error("expected a step");
		expect(node.payload.text).toBe("hello\nworld");
	});
});

describe("canonical documents", () => {
	test("the composition fixture uses every node kind and every edge kind, and is valid", () => {
		const { doc } = composition();
		expect(new Set(doc.nodes.map((node) => node.kind))).toEqual(new Set(GRAPH_NODE_KINDS));
		expect(new Set(doc.edges.map((edge) => edge.kind))).toEqual(new Set(GRAPH_EDGE_KINDS));
		accepted(validateGraph(doc));
	});

	test("edges sort by src, then kind, then order, then dst", () => {
		const edge = (src: string, kind: GraphEdgeKind, dst: string, order?: number): ModelEdge => ({
			id: `${kind}:${src}${dst}${order}`,
			kind,
			src,
			dst,
			...(order === undefined ? {} : { order }),
			provenance: { origin: "substrate" },
		});
		const edges = [edge("b", "next", "z", 1), edge("a", "next", "y", 1), edge("a", "child", "x", 5), edge("a", "next", "z", 0), edge("a", "next", "x", 1), edge("a", "contains", "x")];
		expect([...edges].sort(compareEdges).map((item) => `${item.src} ${item.kind} ${item.order ?? "-"} ${item.dst}`)).toEqual([
			"a child 5 x",
			"a contains - x",
			"a next 0 z",
			"a next 1 x",
			"a next 1 y",
			"b next 1 z",
		]);
	});

	test("the same logical graph serializes to the same bytes whatever order it arrives in", () => {
		const { doc } = composition();
		const expected = serializeGraph(doc);
		const reversed: GraphDocument = { ...doc, nodes: reverseKeys([...doc.nodes].reverse()), edges: reverseKeys([...doc.edges].reverse()) };
		expect(reversed.nodes[0]?.id).not.toBe(doc.nodes[0]?.id);
		expect(serializeGraph(reversed)).toBe(expected);
		for (const seed of [1, 2, 3, 4, 5]) {
			const shuffled: GraphDocument = { ...doc, nodes: reverseKeys(shuffle(doc.nodes, seed)), edges: reverseKeys(shuffle(doc.edges, seed + 100)) };
			expect(serializeGraph(shuffled)).toBe(expected);
			expect(contentHash(shuffled)).toBe(contentHash(doc));
		}
	});

	test("a document read from text in another order serializes to the same bytes", () => {
		const { doc } = composition({ createdAt: "2026-11-16T10:00:00Z" });
		const reordered: GraphDocument = { ...doc, nodes: reverseKeys(shuffle(doc.nodes, 11)), edges: reverseKeys(shuffle(doc.edges, 12)) };
		const graph = accepted(loadGraph(JSON.stringify(reordered)));
		expect(serializeGraph(graph)).toBe(serializeGraph(doc));
	});

	test("serialize, load, serialize is a fixed point and loses nothing", () => {
		const { doc } = composition({ createdAt: "2026-11-16T10:00:00Z", run: { id: "run-1", attempt: 2, tags: ["a", "b"] } });
		const first = serializeGraph(doc);
		const loaded = accepted(loadGraph(first));
		expect(serializeGraph(loaded)).toBe(first);
		expect(loaded).toEqual(canonicalizeGraph(doc));
		expect(serializeGraph(accepted(loadGraph(serializeGraph(loaded))))).toBe(first);
	});

	test("a loaded graph is in canonical order and carries this reader's version", () => {
		const { doc } = composition();
		const graph = accepted(validateGraph({ ...doc, nodes: shuffle(doc.nodes, 3), edges: shuffle(doc.edges, 4) }));
		expect(idsOf(graph.nodes)).toEqual([...idsOf(doc.nodes)].sort());
		expect(graph.edges).toEqual([...graph.edges].sort(compareEdges));
		expect(graph.contract).toBe("substrate.graph");
		expect(graph.version).toBe("1.0");
	});
});

describe("volatile facts", () => {
	test("timestamps and run ids change neither ids nor the content hash", () => {
		const first = composition({ createdAt: "2026-11-16T10:00:00Z", run: "run-1" });
		const second = composition({ createdAt: "2031-01-01T00:00:00Z", run: "run-2" });
		const bare = composition();
		expect(idsOf(first.doc.nodes)).toEqual(idsOf(bare.doc.nodes));
		expect(first.doc.edges.map((edge) => edge.id)).toEqual(bare.doc.edges.map((edge) => edge.id));
		expect(contentHash(first.doc)).toBe(contentHash(bare.doc));
		expect(contentHash(second.doc)).toBe(contentHash(first.doc));
		expect(contentHash(first.doc)).toMatch(/^[0-9a-f]{64}$/);
	});

	test("meta is still serialized: it is kept, only never hashed", () => {
		const first = composition({ createdAt: "2026-11-16T10:00:00Z" });
		const second = composition({ createdAt: "2031-01-01T00:00:00Z" });
		expect(serializeGraph(first.doc)).toContain("2026-11-16T10:00:00Z");
		expect(serializeGraph(first.doc)).not.toBe(serializeGraph(second.doc));
		expect(diff(first.doc, second.doc)).toEqual({ nodes: { added: [], removed: [], changed: [] }, edges: { added: [], removed: [], changed: [] } });
	});

	test("the content hash ignores the producer and the graph id, and sees every change to content", () => {
		const { doc, ref } = composition();
		expect(contentHash({ ...doc, graphId: "another-key", producer: { name: "other-tool", version: "9.9.9" } })).toBe(contentHash(doc));
		const rescored: GraphDocument = { ...doc, nodes: doc.nodes.map((node) => (node.id === ref.id ? withScore(node, 0.5) : node)) };
		expect(contentHash(rescored)).not.toBe(contentHash(doc));
	});
});

describe("version", () => {
	test("a MAJOR other than this reader's is a ContractVersionError naming both versions, and nothing else", () => {
		const { doc } = composition();
		const errors = rejected(validateGraph({ ...doc, version: "2.0", nodes: "not even an array in this version" }));
		expect(errors).toHaveLength(1);
		const [error] = errors;
		if (!(error instanceof ContractVersionError)) throw new Error(`expected a ContractVersionError, got ${String(error)}`);
		expect(error).toBeInstanceOf(GraphValidationError);
		expect(error).toBeInstanceOf(Error);
		expect(error.code).toBe("contract_version");
		expect(error.layer).toBe("version");
		expect(error.expected).toBe("1.0");
		expect(error.received).toBe("2.0");
		expect(error.message).toContain("1.0");
		expect(error.message).toContain("2.0");
	});

	test("a version that is not MAJOR.MINOR at this reader's MAJOR is refused the same way", () => {
		const { doc } = composition();
		for (const version of ["0.9", "3.1", "1", "1.0.0", "v1.0", "01.0", "1.x", ""]) {
			const [error] = rejected(validateGraph({ ...doc, version }));
			expect(error).toBeInstanceOf(ContractVersionError);
		}
	});

	test("a newer MINOR of the same MAJOR is read, its unknown fields ignored, and the copy says 1.0", () => {
		const { doc } = composition();
		const graph = accepted(validateGraph({ ...doc, version: "1.7", futureField: "UNKNOWN-FIELD" }));
		expect(graph.version).toBe("1.0");
		expect(serializeGraph(graph)).toBe(serializeGraph(doc));
	});

	test("a missing or mistyped contract or version is a schema-level refusal, not a version error", () => {
		const { doc } = composition();
		expect(has(rejected(validateGraph(without(doc, "contract"))), "missing_field", "/contract")).toBe(true);
		expect(has(rejected(validateGraph({ ...doc, contract: "another.graph" })), "wrong_contract", "/contract")).toBe(true);
		expect(has(rejected(validateGraph(without(doc, "version"))), "missing_field", "/version")).toBe(true);
		expect(has(rejected(validateGraph({ ...doc, version: 1 })), "invalid_type", "/version")).toBe(true);
	});
});

describe("required and unknown fields", () => {
	test("a required field that is missing is refused, with its path", () => {
		const { doc, root, t1 } = composition();
		const at = (node: ModelNode): number => doc.nodes.findIndex((candidate) => candidate.id === node.id);
		const nextEdge = defined(doc.edges.find((edge) => edge.kind === "next"));

		expect(has(rejected(validateGraph(without(doc, "graphId"))), "missing_field", "/graphId")).toBe(true);
		expect(has(rejected(validateGraph(without(doc, "producer"))), "missing_field", "/producer")).toBe(true);
		expect(has(rejected(validateGraph(without(doc, "nodes"))), "missing_field", "/nodes")).toBe(true);
		expect(has(rejected(validateGraph(without(doc, "edges"))), "missing_field", "/edges")).toBe(true);

		const noProvenance = { ...doc, nodes: doc.nodes.map((node) => (node.id === t1.id ? without(node, "provenance") : node)) };
		expect(has(rejected(validateGraph(noProvenance)), "missing_field", `/nodes/${at(t1)}/provenance`)).toBe(true);

		const noGoal = { ...doc, nodes: doc.nodes.map((node) => (node.id === root.id ? { ...node, payload: {} } : node)) };
		expect(has(rejected(validateGraph(noGoal)), "missing_field", `/nodes/${at(root)}/payload/goal`)).toBe(true);

		const noOrder = { ...doc, edges: doc.edges.map((edge) => (edge.id === nextEdge.id ? without(edge, "order") : edge)) };
		const at_ = doc.edges.findIndex((edge) => edge.id === nextEdge.id);
		expect(has(rejected(validateGraph(noOrder)), "missing_field", `/edges/${at_}/order`)).toBe(true);
	});

	test("a required field of the wrong type or value is refused, with its path", () => {
		const { doc, root } = composition();
		const rootAt = doc.nodes.findIndex((node) => node.id === root.id);
		const childAt = doc.edges.findIndex((edge) => edge.kind === "child");

		const badGoal = { ...doc, nodes: doc.nodes.map((node) => (node.id === root.id ? { ...node, payload: { goal: 7 } } : node)) };
		expect(has(rejected(validateGraph(badGoal)), "invalid_type", `/nodes/${rootAt}/payload/goal`)).toBe(true);

		const emptyGoal = { ...doc, nodes: doc.nodes.map((node) => (node.id === root.id ? { ...node, payload: { goal: "" } } : node)) };
		expect(has(rejected(validateGraph(emptyGoal)), "invalid_value", `/nodes/${rootAt}/payload/goal`)).toBe(true);

		const withChildEdge = (patch: Raw): Raw => ({ ...doc, edges: doc.edges.map((edge, index) => (index === childAt ? { ...edge, ...patch } : edge)) });
		expect(has(rejected(validateGraph(withChildEdge({ order: 1.5 }))), "invalid_value", `/edges/${childAt}/order`)).toBe(true);
		expect(has(rejected(validateGraph(withChildEdge({ order: -1 }))), "invalid_value", `/edges/${childAt}/order`)).toBe(true);
		expect(has(rejected(validateGraph(withChildEdge({ order: "first" }))), "invalid_type", `/edges/${childAt}/order`)).toBe(true);
		expect(has(rejected(validateGraph(withChildEdge({ score: "high" }))), "invalid_type", `/edges/${childAt}/score`)).toBe(true);
		expect(has(rejected(validateGraph(withChildEdge({ provenance: { origin: "substrate", score: Number.NaN } }))), "invalid_value", `/edges/${childAt}/provenance/score`)).toBe(true);
	});

	test("an unknown required value (a node kind, an edge kind, an origin) is refused", () => {
		const { doc, t1 } = composition();
		const nodeAt = doc.nodes.findIndex((node) => node.id === t1.id);
		const edgeAt = doc.edges.findIndex((edge) => edge.kind === "supports");

		const newNodeKind = { ...doc, nodes: doc.nodes.map((node, index) => (index === nodeAt ? { ...node, kind: "hypothesis" } : node)) };
		expect(rejected(validateGraph(newNodeKind)).map((error) => `${error.code} ${error.path}`)).toEqual([`unknown_node_kind /nodes/${nodeAt}/kind`]);

		const newEdgeKind = { ...doc, edges: doc.edges.map((edge, index) => (index === edgeAt ? { ...edge, kind: "causes" } : edge)) };
		expect(rejected(validateGraph(newEdgeKind)).map((error) => `${error.code} ${error.path}`)).toEqual([`unknown_edge_kind /edges/${edgeAt}/kind`]);

		const newOrigin = { ...doc, nodes: doc.nodes.map((node, index) => (index === nodeAt ? { ...node, provenance: { origin: "human" } } : node)) };
		expect(has(rejected(validateGraph(newOrigin)), "invalid_value", `/nodes/${nodeAt}/provenance/origin`)).toBe(true);
	});

	test("an unknown optional field is ignored, everywhere, and leaves no trace in the copy", () => {
		const { doc } = composition({ createdAt: "2026-11-16T10:00:00Z" });
		const noisy = {
			...doc,
			annotations: { reviewer: "UNKNOWN-FIELD" },
			producer: { ...doc.producer, build: "UNKNOWN-FIELD" },
			nodes: doc.nodes.map((node) => ({ ...node, ranking: "UNKNOWN-FIELD", payload: { ...node.payload, hint: "UNKNOWN-FIELD" }, provenance: { ...node.provenance, reviewer: "UNKNOWN-FIELD" } })),
			edges: doc.edges.map((edge) => ({
				...edge,
				weight: "UNKNOWN-FIELD",
				provenance: { ...edge.provenance, reviewer: "UNKNOWN-FIELD" },
				// `order` and `score` are real on next and child and unknown fields everywhere else.
				...(ORDERED_EDGE_KINDS.includes(edge.kind) ? {} : { order: 99, score: 0.5 }),
			})),
		};
		const graph = accepted(validateGraph(noisy));
		expect(serializeGraph(graph)).toBe(serializeGraph(doc));
		expect(contentHash(graph)).toBe(contentHash(doc));
		expect(JSON.stringify(graph)).not.toContain("UNKNOWN-FIELD");
		expect(Object.keys(graph).sort()).toEqual(["contract", "edges", "graphId", "meta", "nodes", "producer", "version"]);
	});

	test("a meta key named __proto__ stays a key and pollutes nothing", () => {
		const { doc } = composition();
		const meta: unknown = JSON.parse('{"__proto__":{"polluted":true},"fine":1}');
		const graph = accepted(validateGraph({ ...doc, meta }));
		const kept = defined(graph.meta);
		expect(Object.keys(kept)).toContain("__proto__");
		expect(Object.getPrototypeOf(kept)).toBe(Object.prototype);
		expect((kept as Raw).polluted).toBeUndefined();
		expect(({} as Raw).polluted).toBeUndefined();
	});

	test("meta must be JSON, finite and within the nesting limit", () => {
		const { doc } = composition();
		expect(has(rejected(validateGraph({ ...doc, meta: { when: new Date(0) } })), "invalid_type", "/meta/when")).toBe(true);
		expect(has(rejected(validateGraph({ ...doc, meta: { n: Number.NaN } })), "invalid_value", "/meta/n")).toBe(true);
		expect(has(rejected(validateGraph({ ...doc, meta: { fn: () => 1 } })), "invalid_type", "/meta/fn")).toBe(true);
		const nested = { a: { b: { c: { d: 1 } } } };
		expect(has(rejected(validateGraph({ ...doc, meta: nested }, { maxDepth: 3 })), "too_deep", "/meta/a/b/c")).toBe(true);
		accepted(validateGraph({ ...doc, meta: nested }, { maxDepth: 4 }));
	});
});

describe("ids in a document", () => {
	test("an id must be its kind, a colon and 16 base32 characters", () => {
		const { doc, t1 } = composition();
		const at = doc.nodes.findIndex((node) => node.id === t1.id);
		for (const id of ["thought:short", "thought:AAAAAAAAAAAAAAAA", "thought:aaaaaaaaaaaaaaa1", "step:aaaaaaaaaaaaaaaa", "aaaaaaaaaaaaaaaa", ""]) {
			const bad = { ...doc, nodes: doc.nodes.map((node, index) => (index === at ? { ...node, id } : node)) };
			expect(rejected(validateGraph(bad)).some((error) => error.path === `/nodes/${at}/id`)).toBe(true);
		}
	});

	test("an edge id is checked against the edge's kind", () => {
		const { doc } = composition();
		const at = doc.edges.findIndex((edge) => edge.kind === "contains");
		const bad = { ...doc, edges: doc.edges.map((edge, index) => (index === at ? { ...edge, id: "next:aaaaaaaaaaaaaaaa" } : edge)) };
		expect(has(rejected(validateGraph(bad)), "invalid_id", `/edges/${at}/id`)).toBe(true);
	});
});

describe("referential integrity", () => {
	test("an edge to or from a node that is not there is refused", () => {
		const { doc, root, t1 } = composition();
		const missing = "thought:aaaaaaaaaaaaaaaa";
		const dangling = makeEdge({ kind: "contains", src: root.id, dst: missing });
		const errors = rejected(validateGraph(withEdges(doc, dangling)));
		expect(errors.map((error) => error.code)).toEqual(["dangling_edge"]);
		expect(errors[0]?.path).toBe(`/edges/${doc.edges.length}/dst`);
		expect(errors[0]?.layer).toBe("integrity");
		expect(errors[0]?.related).toEqual([dangling.id, missing]);

		const orphanSource = makeEdge({ kind: "depends_on", src: missing, dst: t1.id });
		expect(has(rejected(validateGraph(withEdges(doc, orphanSource))), "dangling_edge", `/edges/${doc.edges.length}/src`)).toBe(true);

		const bothEnds = makeEdge({ kind: "supports", src: missing, dst: "thought:bbbbbbbbbbbbbbbb" });
		expect(rejected(validateGraph(withEdges(doc, bothEnds))).map((error) => error.code)).toEqual(["dangling_edge", "dangling_edge"]);
	});

	test("a repeated node id or edge id is refused", () => {
		const { doc, t1 } = composition();
		const twiceNode = rejected(validateGraph(withNodes(doc, t1)));
		expect(twiceNode.map((error) => error.code)).toEqual(["duplicate_id"]);
		expect(twiceNode[0]?.path).toBe(`/nodes/${doc.nodes.length}/id`);
		expect(twiceNode[0]?.related).toEqual([t1.id]);

		const firstEdge = defined(doc.edges[0]);
		const twiceEdge = rejected(validateGraph(withEdges(doc, firstEdge)));
		expect(twiceEdge.map((error) => error.code)).toEqual(["duplicate_id"]);
		expect(twiceEdge[0]?.path).toBe(`/edges/${doc.edges.length}/id`);
	});
});

describe("structure", () => {
	test("a graph with no root, or with two, is refused", () => {
		const c = composition();
		const noRoot = makeGraph({ graphId: "no-root", producer: PRODUCER, nodes: [c.t1, c.t2], edges: [link("depends_on", c.t2, c.t1)] });
		const none = rejected(validateGraph(noRoot));
		expect(none.map((error) => error.code)).toEqual(["no_root"]);
		expect(none[0]?.layer).toBe("structure");

		const another = makeNode({ kind: "root", payload: { goal: "A second goal" } });
		const two = rejected(validateGraph(withNodes(c.doc, another)));
		expect(two.map((error) => error.code)).toEqual(["multiple_roots"]);
		expect(new Set(two[0]?.related)).toEqual(new Set([c.root.id, another.id]));
	});

	test("a graph of one root and nothing else is valid", () => {
		const root = makeNode({ kind: "root", payload: { goal: "Nothing yet" } });
		accepted(validateGraph(makeGraph({ graphId: "tiny", producer: PRODUCER, nodes: [root], edges: [] })));
	});

	test("a cycle through depends_on, next, child or contains is refused, and the cycle it names is real", () => {
		const c = composition();
		const cases: ReadonlyArray<readonly [string, ModelEdge, ModelNode, ModelNode]> = [
			["depends_on", link("depends_on", c.t1, c.t3), c.t1, c.t3],
			["next", link("next", c.s2, c.s0, { order: 2 }), c.s2, c.s0],
			["child", link("child", c.b1, c.decision, { order: 0 }), c.b1, c.decision],
			["contains", link("contains", c.s2, c.t2), c.s2, c.t2],
			["self", link("depends_on", c.t1, c.t1), c.t1, c.t1],
		];
		for (const [name, closing, from, to] of cases) {
			const bad = withEdges(c.doc, closing);
			const errors = rejected(validateGraph(bad));
			expect(errors.map((error) => error.code)).toEqual(["cycle"]);
			const cycle = defined(errors[0], name).related;
			expect(errors[0]?.layer).toBe("structure");
			expect(cycle.length).toBeGreaterThanOrEqual(2);
			expect(cycle[0]).toBe(cycle[cycle.length - 1]);
			expect(cycle).toContain(from.id);
			expect(cycle).toContain(to.id);
			for (let at = 0; at + 1 < cycle.length; at++) expect(precedes(bad, defined(cycle[at]), defined(cycle[at + 1]))).toBe(true);
			expect(findCycle(bad)).not.toBeNull();
		}
	});

	test("a child that depends on its parent is in order, not a cycle", () => {
		const c = composition();
		const ordered = withEdges(c.doc, link("depends_on", c.b1, c.decision));
		accepted(validateGraph(ordered));
		expect(findCycle(ordered)).toBeNull();
		expect(findCycle(withEdges(c.doc, link("depends_on", c.decision, c.b1)))).not.toBeNull();
	});

	test("findCycle looks only at the kinds it is given", () => {
		const c = composition();
		const bad = withEdges(c.doc, link("depends_on", c.t1, c.t3));
		expect(findCycle(bad, ["child", "next"])).toBeNull();
		expect(findCycle(bad, ["depends_on"])).not.toBeNull();
		expect(findCycle(c.doc)).toBeNull();
	});

	test("supports and contradicts may point both ways: they do not order anything", () => {
		const c = composition();
		const mutual = withEdges(c.doc, link("contradicts", c.b0, c.ref), link("supports", c.b1, c.ref));
		accepted(validateGraph(mutual));
	});
});

describe("layers and limits", () => {
	test("validation stops at the first layer that finds a problem", () => {
		const { doc, root } = composition();
		const dangling = makeEdge({ kind: "contains", src: root.id, dst: "thought:aaaaaaaaaaaaaaaa" });
		const errors = rejected(validateGraph({ ...doc, nodes: [...doc.nodes, 7], edges: [...doc.edges, dangling] }));
		expect(errors.map((error) => error.code)).toEqual(["invalid_type"]);
		expect(errors.every((error) => error.layer === "schema")).toBe(true);
	});

	test("the node and edge counts are limited before anything is read", () => {
		const { doc } = composition();
		const nodes = rejected(validateGraph(doc, { maxNodes: 5 }));
		expect(nodes.map((error) => `${error.code} ${error.layer} ${error.path}`)).toEqual(["too_many_nodes limits /nodes"]);
		const edges = rejected(validateGraph(doc, { maxEdges: 3 }));
		expect(edges.map((error) => error.code)).toEqual(["too_many_edges"]);
		expect(rejected(validateGraph(doc, { maxNodes: 5, maxEdges: 3 })).map((error) => error.code)).toEqual(["too_many_nodes", "too_many_edges"]);

		const flood = { ...doc, nodes: Array.from({ length: DEFAULT_GRAPH_LIMITS.maxNodes + 1 }, () => defined(doc.nodes[0])) };
		expect(rejected(validateGraph(flood)).map((error) => error.code)).toEqual(["too_many_nodes"]);
	});

	test("a string over the length limit is refused where it sits", () => {
		const { doc } = composition();
		const errors = rejected(validateGraph(doc, { maxStringLength: 10, maxErrors: 1000 }));
		expect(has(errors, "string_too_long", "/graphId")).toBe(true);
		expect(errors.every((error) => error.code === "string_too_long" && error.layer === "limits")).toBe(true);
	});

	test("the list of errors is cut at maxErrors with a marker, and a cut list is still a refusal", () => {
		const { doc } = composition();
		const garbage = { ...doc, nodes: doc.nodes.map(() => 7) };
		expect(rejected(validateGraph(garbage, { maxErrors: 2 })).map((error) => error.code)).toEqual(["invalid_type", "invalid_type", "too_many_errors"]);
		expect(rejected(validateGraph({}, { maxErrors: 0 })).map((error) => error.code)).toEqual(["too_many_errors"]);
	});

	test("loadGraph checks the byte limit before parsing, and refuses text that is not a JSON object", () => {
		const { doc } = composition();
		const codes = (text: string, limits: { readonly maxBytes?: number } = {}): string[] => rejected(loadGraph(text, limits)).map((error) => error.code);
		expect(codes(serializeGraph(doc), { maxBytes: 100 })).toEqual(["too_large"]);
		expect(codes("é".repeat(10), { maxBytes: 15 })).toEqual(["too_large"]);
		expect(codes("{not json")).toEqual(["invalid_json"]);
		expect(codes("[]")).toEqual(["not_an_object"]);
		expect(codes("null")).toEqual(["not_an_object"]);
		accepted(loadGraph(serializeGraph(doc)));
	});

	test("hostile input is refused, never thrown on", () => {
		const circular: Raw = {};
		circular.self = circular;
		const inputs: unknown[] = [undefined, null, 0, "", [], {}, true, circular, { contract: "substrate.graph" }, { contract: "substrate.graph", version: "1.0" }, { contract: "substrate.graph", version: "1.0", producer: {}, graphId: 1, nodes: {}, edges: "x" }];
		for (const input of inputs) expect(validateGraph(input).ok).toBe(false);
		for (const input of [undefined, null, 5, "x", [], true]) expect(rejected(validateGraph(input)).map((error) => error.code)).toEqual(["not_an_object"]);
	});
});

describe("queries", () => {
	test("getNode finds a node by id and answers undefined for an id that is not there", () => {
		const c = composition();
		expect(getNode(c.doc, c.t2.id)).toEqual(c.t2);
		expect(getNode(c.doc, "thought:aaaaaaaaaaaaaaaa")).toBeUndefined();
	});

	test("neighbors follows the chosen kinds in the chosen direction, in edge order, once each", () => {
		const c = composition();
		expect(idsOf(neighbors(c.doc, c.decision.id, "child"))).toEqual([c.b0.id, c.b1.id]);
		expect(idsOf(neighbors(c.doc, c.decision.id, ["child", "selected"]))).toEqual([c.b0.id, c.b1.id]);
		expect(idsOf(neighbors(c.doc, c.decision.id, "selected"))).toEqual([c.b1.id]);
		expect(idsOf(neighbors(c.doc, c.b1.id, "child", "in"))).toEqual([c.decision.id]);
		expect(new Set(idsOf(neighbors(c.doc, c.b1.id, undefined, "in")))).toEqual(new Set([c.decision.id, c.ref.id]));
		expect(neighbors(c.doc, c.b1.id, undefined, "in")).toHaveLength(2);

		const both = idsOf(neighbors(c.doc, c.b1.id, undefined, "both"));
		expect(new Set(both.slice(0, 3))).toEqual(new Set([c.s0.id, c.s1.id, c.s2.id]));
		expect(new Set(both.slice(3))).toEqual(new Set([c.decision.id, c.ref.id]));

		expect(neighbors(c.doc, "thought:aaaaaaaaaaaaaaaa", "contains")).toEqual([]);
	});

	test("descendants are everything below a node along the hierarchy kinds", () => {
		const c = composition();
		expect(new Set(idsOf(descendants(c.doc, c.root.id)))).toEqual(new Set(idsOf(c.doc.nodes.filter((node) => node.id !== c.root.id))));
		expect(new Set(idsOf(descendants(c.doc, c.t2.id)))).toEqual(new Set([c.decision.id, c.b0.id, c.b1.id, c.s0.id, c.s1.id, c.s2.id]));
		expect(idsOf(descendants(c.doc, c.s0.id, ["next"]))).toEqual([c.s1.id, c.s2.id]);
		expect(descendants(c.doc, c.s2.id)).toEqual([]);
		expect(descendants(c.doc, "thought:aaaaaaaaaaaaaaaa")).toEqual([]);
		expect(descendants(c.doc, c.t3.id)).toEqual([]);
	});

	test("ancestors are everything above a node, nearest first", () => {
		const c = composition();
		const up = idsOf(ancestors(c.doc, c.s2.id));
		expect(up).toHaveLength(6);
		expect(new Set(up.slice(0, 2))).toEqual(new Set([c.s1.id, c.b1.id]));
		expect(new Set(up.slice(2, 4))).toEqual(new Set([c.s0.id, c.decision.id]));
		expect(up.slice(4)).toEqual([c.t2.id, c.root.id]);
		expect(ancestors(c.doc, c.root.id)).toEqual([]);
		expect(idsOf(ancestors(c.doc, c.t2.id, ["depends_on"]))).toEqual([c.t3.id]);
	});

	test("a chain inside a tree inside a graph keeps all three shapes", () => {
		const c = composition();
		const inside = new Set(idsOf(descendants(c.doc, c.t2.id)));
		for (const node of [c.decision, c.b0, c.b1, c.s0, c.s1, c.s2]) expect(inside.has(node.id)).toBe(true);
		const above = new Set(idsOf(ancestors(c.doc, c.s1.id)));
		for (const node of [c.b1, c.decision, c.t2, c.root]) expect(above.has(node.id)).toBe(true);
		expect(idsOf(neighbors(c.doc, c.t2.id, "depends_on"))).toEqual([c.t1.id]);
		expect(idsOf(neighbors(c.doc, c.t3.id, "depends_on"))).toEqual([c.t2.id]);
		expect(idsOf(neighbors(c.doc, c.s0.id, "next"))).toEqual([c.s1.id]);
		accepted(validateGraph(c.doc));
	});

	test("subgraph is the nodes within a depth along the chosen kinds and the edges between them", () => {
		const c = composition();
		const near = subgraph(c.doc, c.decision.id, 1);
		expect(near.root).toBe(c.decision.id);
		expect(new Set(idsOf(near.nodes))).toEqual(new Set([c.decision.id, c.b0.id, c.b1.id]));
		expect(near.edges.map((edge) => edge.kind)).toEqual(["child", "child", "selected"]);

		const two = subgraph(c.doc, c.decision.id, 2);
		expect(new Set(idsOf(two.nodes))).toEqual(new Set([c.decision.id, c.b0.id, c.b1.id, c.s0.id, c.s1.id, c.s2.id]));
		expect(two.edges).toHaveLength(8);

		const steps = subgraph(c.doc, c.b1.id, 1, ["contains"]);
		expect(new Set(idsOf(steps.nodes))).toEqual(new Set([c.b1.id, c.s0.id, c.s1.id, c.s2.id]));
		expect(steps.edges.map((edge) => edge.kind)).toEqual(["contains", "contains", "contains"]);

		const alone = subgraph(c.doc, c.decision.id, 0);
		expect(idsOf(alone.nodes)).toEqual([c.decision.id]);
		expect(alone.edges).toEqual([]);

		const everything = subgraph(c.doc, c.root.id, Number.POSITIVE_INFINITY);
		expect(everything.nodes).toHaveLength(c.doc.nodes.length);
		expect(everything.edges).toHaveLength(c.doc.edges.length);

		expect(subgraph(c.doc, "thought:aaaaaaaaaaaaaaaa", 3)).toEqual({ root: "thought:aaaaaaaaaaaaaaaa", nodes: [], edges: [] });
	});

	test("queries answer the same whatever order the document's arrays were written in", () => {
		const c = composition();
		const shuffled: GraphDocument = { ...c.doc, nodes: shuffle(c.doc.nodes, 21), edges: shuffle(c.doc.edges, 22) };
		expect(idsOf(descendants(shuffled, c.root.id))).toEqual(idsOf(descendants(c.doc, c.root.id)));
		expect(idsOf(ancestors(shuffled, c.s2.id))).toEqual(idsOf(ancestors(c.doc, c.s2.id)));
		expect(idsOf(neighbors(shuffled, c.decision.id, "child"))).toEqual(idsOf(neighbors(c.doc, c.decision.id, "child")));
		expect(subgraph(shuffled, c.root.id, 3)).toEqual(subgraph(c.doc, c.root.id, 3));
	});
});

describe("topoOrder", () => {
	test("puts every prerequisite, container, parent and predecessor before what follows it", () => {
		const c = composition();
		const order = defined(topoOrder(c.doc));
		expect(order).toHaveLength(c.doc.nodes.length);
		expect(new Set(idsOf(order))).toEqual(new Set(idsOf(c.doc.nodes)));
		expect(order[0]?.id).toBe(c.root.id);
		const position = new Map(order.map((node, index) => [node.id, index] as const));
		for (const edge of c.doc.edges) {
			if (!ORDERING_EDGE_KINDS.includes(edge.kind)) continue;
			const before = edge.kind === "depends_on" ? edge.dst : edge.src;
			const after = edge.kind === "depends_on" ? edge.src : edge.dst;
			expect(defined(position.get(before))).toBeLessThan(defined(position.get(after)));
		}
	});

	test("siblings come out in sibling order and a chain in chain order", () => {
		const c = composition();
		const position = new Map(defined(topoOrder(c.doc)).map((node, index) => [node.id, index] as const));
		expect(defined(position.get(c.b0.id))).toBeLessThan(defined(position.get(c.b1.id)));
		expect(defined(position.get(c.s0.id))).toBeLessThan(defined(position.get(c.s1.id)));
		expect(defined(position.get(c.s1.id))).toBeLessThan(defined(position.get(c.s2.id)));
	});

	test("where nothing else decides, the lower id goes first, so a diamond has one order", () => {
		const root = makeNode({ kind: "root", payload: { goal: "A diamond" } });
		const thought = (key: string): ModelNode => makeNode({ kind: "thought", payload: { title: key, question: key }, scope: [root.id], localKey: key });
		const a = thought("a");
		const b = thought("b");
		const c = thought("c");
		const d = thought("d");
		const doc = makeGraph({
			graphId: "diamond",
			producer: PRODUCER,
			nodes: [root, a, b, c, d],
			edges: [link("contains", root, a), link("contains", root, b), link("contains", root, c), link("contains", root, d), link("depends_on", b, a), link("depends_on", c, a), link("depends_on", d, b), link("depends_on", d, c)],
		});
		const lower = b.id < c.id ? b : c;
		const upper = b.id < c.id ? c : b;
		expect(idsOf(defined(topoOrder(doc)))).toEqual([root.id, a.id, lower.id, upper.id, d.id]);
	});

	test("is the same whatever order the document's arrays were written in", () => {
		const c = composition();
		const shuffled: GraphDocument = { ...c.doc, nodes: shuffle(c.doc.nodes, 7), edges: shuffle(c.doc.edges, 8) };
		expect(idsOf(defined(topoOrder(shuffled)))).toEqual(idsOf(defined(topoOrder(c.doc))));
	});

	test("is null when the ordering edges form a cycle, and honours only the kinds it is given", () => {
		const c = composition();
		const bad = withEdges(c.doc, link("depends_on", c.t1, c.t3));
		expect(topoOrder(bad)).toBeNull();
		expect(topoOrder(bad, ["child", "next"])).not.toBeNull();
		const dependencies = defined(topoOrder(c.doc, ["depends_on"]));
		expect(dependencies).toHaveLength(c.doc.nodes.length);
		const at = new Map(dependencies.map((node, index) => [node.id, index] as const));
		expect(defined(at.get(c.t1.id))).toBeLessThan(defined(at.get(c.t2.id)));
		expect(defined(at.get(c.t2.id))).toBeLessThan(defined(at.get(c.t3.id)));
	});

	test("a long chain validates, orders and walks without recursion", () => {
		const root = makeNode({ kind: "root", payload: { goal: "A long chain" } });
		const thought = makeNode({ kind: "thought", payload: { title: "t", question: "q" }, scope: [root.id], localKey: "n1" });
		const steps = Array.from({ length: 3000 }, (_, index) => makeNode({ kind: "step", payload: { text: `step ${index}` }, scope: [root.id, thought.id], localKey: String(index) }));
		const edges = [
			link("contains", root, thought),
			...steps.map((step) => link("contains", thought, step)),
			...steps.slice(1).map((step, index) => link("next", defined(steps[index]), step, { order: index })),
		];
		const doc = makeGraph({ graphId: "long-chain", producer: PRODUCER, nodes: [root, thought, ...steps], edges });
		accepted(validateGraph(doc));
		expect(findCycle(doc)).toBeNull();
		expect(idsOf(defined(topoOrder(doc)))).toEqual([root.id, thought.id, ...idsOf(steps)]);
		expect(descendants(doc, root.id)).toHaveLength(3001);
	});
});

describe("selectedPath", () => {
	function tree() {
		const root = makeNode({ kind: "root", payload: { goal: "Pick a path" } });
		const pick = (label: string, parents: readonly ModelNode[]): ModelNode => makeNode({ kind: "branch", payload: { label }, scope: parents.map((parent) => parent.id), localKey: label });
		const a = pick("a", [root]);
		const b = pick("b", [root]);
		const a1 = pick("a1", [root, a]);
		const b1 = pick("b1", [root, b]);
		const b2 = pick("b2", [root, b]);
		const doc = makeGraph({
			graphId: "tree",
			producer: PRODUCER,
			nodes: [root, a, b, a1, b1, b2],
			edges: [
				link("child", root, a, { order: 0 }),
				link("child", root, b, { order: 1 }),
				link("selected", root, b),
				link("child", a, a1, { order: 0 }),
				link("selected", a, a1),
				link("child", b, b1, { order: 0 }),
				link("child", b, b2, { order: 1 }),
				link("selected", b, b2),
			],
		});
		return { doc, root, a, b, a1, b1, b2 };
	}

	test("follows the selected edges from the root", () => {
		const t = tree();
		expect(idsOf(selectedPath(t.doc))).toEqual([t.root.id, t.b.id, t.b2.id]);
	});

	test("starts where it is told to, and a node with no selected edge is a path of one", () => {
		const t = tree();
		expect(idsOf(selectedPath(t.doc, t.a.id))).toEqual([t.a.id, t.a1.id]);
		expect(idsOf(selectedPath(t.doc, t.b2.id))).toEqual([t.b2.id]);
		expect(selectedPath(t.doc, "branch:aaaaaaaaaaaaaaaa")).toEqual([]);
	});

	test("ends where a chain of choices would loop", () => {
		const t = tree();
		expect(idsOf(selectedPath(withEdges(t.doc, link("selected", t.b2, t.root))))).toEqual([t.root.id, t.b.id, t.b2.id]);
	});

	test("takes the first selected edge in canonical order when a node has several", () => {
		const t = tree();
		const twice = withEdges(t.doc, link("selected", t.root, t.a));
		const lower = t.a.id < t.b.id ? t.a : t.b;
		expect(selectedPath(twice)[1]?.id).toBe(lower.id);
	});

	test("the composition's decision starts its own chain", () => {
		const c = composition();
		expect(idsOf(selectedPath(c.doc, c.decision.id))).toEqual([c.decision.id, c.b1.id]);
		expect(idsOf(selectedPath(c.doc))).toEqual([c.root.id]);
	});
});

describe("diff", () => {
	test("a document against itself has nothing added, removed or changed", () => {
		const { doc } = composition();
		expect(diff(doc, doc)).toEqual({ nodes: { added: [], removed: [], changed: [] }, edges: { added: [], removed: [], changed: [] } });
	});

	test("reports added, removed and changed nodes and edges by id", () => {
		const c = composition();
		const extra = makeNode({ kind: "step", payload: { text: "Verify the contract" }, scope: [c.root.id, c.t2.id, c.b1.id], localKey: "3" });
		const after = makeGraph({
			graphId: c.doc.graphId,
			producer: PRODUCER,
			nodes: [...c.doc.nodes.filter((node) => node.id !== c.segment.id && node.id !== c.ref.id), withScore(c.ref, 0.5), extra],
			edges: [
				...c.doc.edges.filter((edge) => edge.dst !== c.segment.id && !(edge.kind === "child" && edge.dst === c.b1.id)),
				link("child", c.decision, c.b1, { order: 1, score: 0.95 }),
				link("contains", c.b1, extra),
				link("next", c.s2, extra, { order: 2 }),
			],
		});
		accepted(validateGraph(after));

		const delta = diff(c.doc, after);
		expect(idsOf(delta.nodes.added)).toEqual([extra.id]);
		expect(idsOf(delta.nodes.removed)).toEqual([c.segment.id]);
		expect(delta.nodes.changed.map((change) => change.id)).toEqual([c.ref.id]);
		expect(delta.nodes.changed[0]?.before.provenance.score).toBe(0.82);
		expect(delta.nodes.changed[0]?.after.provenance.score).toBe(0.5);

		expect(delta.edges.added.map((edge) => edge.id).sort()).toEqual([deriveEdgeId("contains", c.b1.id, extra.id), deriveEdgeId("next", c.s2.id, extra.id)].sort());
		expect(delta.edges.removed.map((edge) => edge.id)).toEqual([deriveEdgeId("contains", c.root.id, c.segment.id)]);
		expect(delta.edges.changed.map((change) => change.id)).toEqual([deriveEdgeId("child", c.decision.id, c.b1.id)]);
		expect(delta.edges.changed[0]?.before.score).toBe(0.9);
		expect(delta.edges.changed[0]?.after.score).toBe(0.95);

		expect(contentHash(after)).not.toBe(contentHash(c.doc));
	});

	test("going the other way swaps added and removed and keeps the changes", () => {
		const c = composition();
		const extra = makeNode({ kind: "step", payload: { text: "Verify the contract" }, scope: [c.root.id, c.t2.id, c.b1.id], localKey: "3" });
		const after = makeGraph({ graphId: c.doc.graphId, producer: PRODUCER, nodes: [...c.doc.nodes.map((node) => (node.id === c.ref.id ? withScore(node, 0.5) : node)), extra], edges: c.doc.edges });
		const forward = diff(c.doc, after);
		const backward = diff(after, c.doc);
		expect(idsOf(forward.nodes.added)).toEqual(idsOf(backward.nodes.removed));
		expect(idsOf(forward.nodes.removed)).toEqual(idsOf(backward.nodes.added));
		expect(forward.nodes.changed.map((change) => change.id)).toEqual(backward.nodes.changed.map((change) => change.id));
		expect(backward.nodes.changed[0]?.before.provenance.score).toBe(0.5);
	});

	test("is the same whatever order the arrays were written in", () => {
		const c = composition();
		const after = makeGraph({ graphId: c.doc.graphId, producer: PRODUCER, nodes: c.doc.nodes.filter((node) => node.id !== c.segment.id), edges: c.doc.edges.filter((edge) => edge.dst !== c.segment.id) });
		const shuffledBefore: GraphDocument = { ...c.doc, nodes: shuffle(c.doc.nodes, 31), edges: shuffle(c.doc.edges, 32) };
		const shuffledAfter: GraphDocument = { ...after, nodes: shuffle(after.nodes, 33), edges: shuffle(after.edges, 34) };
		expect(diff(shuffledBefore, shuffledAfter)).toEqual(diff(c.doc, after));
	});
});

describe("splitRationaleSteps", () => {
	test("splits a one-step-per-line list on every line marker", () => {
		expect(splitRationaleSteps("1. Read the request.\n2. Note the goals.\n3. List the bars.")).toEqual(["Read the request.", "Note the goals.", "List the bars."]);
		expect(splitRationaleSteps("1) Plan\n2) Execute\n3) Verify")).toEqual(["Plan", "Execute", "Verify"]);
		expect(splitRationaleSteps("Step 1: Do X\nStep 2: Do Y")).toEqual(["Do X", "Do Y"]);
		expect(splitRationaleSteps("1. a\n1. b\n7. c")).toEqual(["a", "b", "c"]);
	});

	test("splits a rationale run together on one line only on markers that continue from 1", () => {
		expect(splitRationaleSteps("1. Split the work. 2. Order the pieces.")).toEqual(["Split the work.", "Order the pieces."]);
		expect(splitRationaleSteps("1. Measure 5-8 samples. 2. Compare v2. results.")).toEqual(["Measure 5-8 samples.", "Compare v2. results."]);
	});

	test("takes unnumbered text as one step, empty text as none, and folds a preamble into the first step", () => {
		expect(splitRationaleSteps("Think about regressions.")).toEqual(["Think about regressions."]);
		expect(splitRationaleSteps("")).toEqual([]);
		expect(splitRationaleSteps("  \n ")).toEqual([]);
		expect(splitRationaleSteps("Approach:\n1. First\n2. Second")).toEqual(["Approach: First", "Second"]);
	});
});

describe("fromUltrathinkGraph", () => {
	const SAMPLE: UltrathinkGraphInput = {
		goal: "Understand the request, decompose it, weigh approaches, and produce an execution plan",
		nodes: [
			{
				id: "n1",
				title: "Understand",
				kind: "understand",
				question: "What is the user actually asking for?",
				dependsOn: [],
				thinking: "1. Read the request.\n2. Note the implicit goals.\n3. List the quality bars.",
				conclusion: "Ship a typed graph model.",
			},
			{ id: "n2", title: "Decompose", kind: "decompose", question: "What subproblems must be solved?", dependsOn: ["n1"], thinking: "1. Split the work. 2. Order the pieces.", conclusion: "Two pieces." },
			{ id: "n3", title: "Approaches", kind: "generate", question: "What are the viable approaches?", dependsOn: ["n2"], degraded: true },
			{ id: "n4", title: "Risks", kind: "critique", question: "What could go wrong?", dependsOn: ["n3"], thinking: "Think about regressions.", conclusion: "Watch for id drift." },
			{ id: "n5", title: "Plan", kind: "synthesize", question: "What is the plan?", dependsOn: ["n4", "n2"], thinking: "1) Plan\n2) Execute\n3) Verify\n4) Report", conclusion: "Do it in order." },
		],
	};

	function thoughtOf(doc: GraphDocument, key: string): ModelNode {
		return defined(
			doc.nodes.find((node) => node.kind === "thought" && node.localKey === key),
			`thought ${key}`,
		);
	}

	function payloadOf(node: ModelNode): ThoughtPayload {
		if (node.kind !== "thought") throw new Error(`expected a thought, got ${node.kind}`);
		return node.payload;
	}

	/** The step texts of a thought in chain order: from the contained step nothing precedes, along `next`. */
	function chainOf(doc: GraphDocument, thought: ModelNode): string[] {
		const head = neighbors(doc, thought.id, "contains").find((candidate) => neighbors(doc, candidate.id, "next", "in").length === 0);
		if (head === undefined) return [];
		return [head, ...descendants(doc, head.id, ["next"])].map((node) => (node.kind === "step" ? node.payload.text : ""));
	}

	const hasEdge = (doc: GraphDocument, kind: GraphEdgeKind, src: ModelNode, dst: ModelNode): boolean => doc.edges.some((edge) => edge.kind === kind && edge.src === src.id && edge.dst === dst.id);

	test("maps a five-node graph with a rationale into thoughts, steps and edges, and the result validates", () => {
		const doc = fromUltrathinkGraph(SAMPLE);
		accepted(validateGraph(doc));

		const count = (kind: string): number => doc.nodes.filter((node) => node.kind === kind).length;
		expect([count("root"), count("thought"), count("step")]).toEqual([1, 5, 10]);
		expect(doc.nodes).toHaveLength(16);
		const edgeCount = (kind: GraphEdgeKind): number => doc.edges.filter((edge) => edge.kind === kind).length;
		expect([edgeCount("contains"), edgeCount("depends_on"), edgeCount("next")]).toEqual([15, 5, 6]);
		expect(doc.edges).toHaveLength(26);

		const root = defined(doc.nodes.find((node) => node.kind === "root"));
		if (root.kind !== "root") throw new Error("expected a root");
		expect(root.payload.goal).toBe(SAMPLE.goal);
		for (const key of ["n1", "n2", "n3", "n4", "n5"]) expect(hasEdge(doc, "contains", root, thoughtOf(doc, key))).toBe(true);
		for (const [from, to] of [["n2", "n1"], ["n3", "n2"], ["n4", "n3"], ["n5", "n4"], ["n5", "n2"]] as const) {
			expect(hasEdge(doc, "depends_on", thoughtOf(doc, from), thoughtOf(doc, to))).toBe(true);
		}
		expect(hasEdge(doc, "depends_on", thoughtOf(doc, "n1"), thoughtOf(doc, "n2"))).toBe(false);
	});

	test("a thought keeps its title, question, kind, conclusion and degraded flag", () => {
		const doc = fromUltrathinkGraph(SAMPLE);
		expect(payloadOf(thoughtOf(doc, "n1"))).toEqual({
			title: "Understand",
			question: "What is the user actually asking for?",
			thoughtKind: "understand",
			conclusion: "Ship a typed graph model.",
		});
		expect(payloadOf(thoughtOf(doc, "n3"))).toEqual({ title: "Approaches", question: "What are the viable approaches?", thoughtKind: "generate", degraded: true });
	});

	test("each rationale step is a step node, held by its thought and chained by next in order", () => {
		const doc = fromUltrathinkGraph(SAMPLE);
		expect(chainOf(doc, thoughtOf(doc, "n1"))).toEqual(["Read the request.", "Note the implicit goals.", "List the quality bars."]);
		expect(chainOf(doc, thoughtOf(doc, "n2"))).toEqual(["Split the work.", "Order the pieces."]);
		expect(chainOf(doc, thoughtOf(doc, "n3"))).toEqual([]);
		expect(chainOf(doc, thoughtOf(doc, "n4"))).toEqual(["Think about regressions."]);
		expect(chainOf(doc, thoughtOf(doc, "n5"))).toEqual(["Plan", "Execute", "Verify", "Report"]);

		const orders = doc.edges.filter((edge) => edge.kind === "next" && neighbors(doc, thoughtOf(doc, "n5").id, "contains").some((step) => step.id === edge.src)).map((edge) => edge.order);
		expect([...orders].sort()).toEqual([0, 1, 2]);
	});

	test("every node and edge says it came from Ultrathink", () => {
		const doc = fromUltrathinkGraph(SAMPLE);
		expect(doc.nodes.every((node) => node.provenance.origin === "ultrathink")).toBe(true);
		expect(doc.edges.every((edge) => edge.provenance.origin === "ultrathink")).toBe(true);
	});

	test("the same graph gives the same bytes in whatever order its nodes and dependencies are listed", () => {
		const reordered: UltrathinkGraphInput = { goal: SAMPLE.goal, nodes: [...SAMPLE.nodes].reverse().map((node) => ({ ...node, dependsOn: [...node.dependsOn].reverse() })) };
		expect(serializeGraph(fromUltrathinkGraph(reordered))).toBe(serializeGraph(fromUltrathinkGraph(SAMPLE)));
		expect(serializeGraph(fromUltrathinkGraph(SAMPLE))).toBe(serializeGraph(fromUltrathinkGraph(SAMPLE)));
	});

	test("takes its key, producer and meta from the options, and defaults the key to the root's id", () => {
		const doc = fromUltrathinkGraph(SAMPLE);
		const root = defined(doc.nodes.find((node) => node.kind === "root"));
		expect(doc.graphId).toBe(root.id);
		expect(doc.producer).toEqual(GRAPH_MODEL_PRODUCER);
		expect(doc.meta).toBeUndefined();

		const custom = fromUltrathinkGraph(SAMPLE, { graphId: "ut-fixed", producer: PRODUCER, meta: { createdAt: "2026-11-16T00:00:00Z" } });
		expect(custom.graphId).toBe("ut-fixed");
		expect(custom.producer).toEqual(PRODUCER);
		expect(custom.meta).toEqual({ createdAt: "2026-11-16T00:00:00Z" });
		expect(contentHash(custom)).toBe(contentHash(doc));
		accepted(validateGraph(custom));
	});

	test("survives a round trip through text", () => {
		const doc = fromUltrathinkGraph(SAMPLE, { graphId: "ut-fixed", producer: PRODUCER });
		const text = serializeGraph(doc);
		expect(serializeGraph(accepted(loadGraph(text)))).toBe(text);
	});

	test("collapses a repeated dependency and refuses a graph it cannot point edges at", () => {
		const doubled: UltrathinkGraphInput = { goal: "g", nodes: [{ id: "a", title: "A", kind: "understand", question: "q", dependsOn: [] }, { id: "b", title: "B", kind: "decompose", question: "q", dependsOn: ["a", "a"] }] };
		expect(fromUltrathinkGraph(doubled).edges.filter((edge) => edge.kind === "depends_on")).toHaveLength(1);

		const missingDependency: UltrathinkGraphInput = { goal: "g", nodes: [{ id: "a", title: "A", kind: "understand", question: "q", dependsOn: ["missing"] }] };
		expect(() => fromUltrathinkGraph(missingDependency)).toThrow(RangeError);

		const repeated: UltrathinkGraphInput = { goal: "g", nodes: [{ id: "a", title: "A", kind: "understand", question: "q", dependsOn: [] }, { id: "a", title: "A again", kind: "decompose", question: "q", dependsOn: [] }] };
		expect(() => fromUltrathinkGraph(repeated)).toThrow(RangeError);
	});

	test("a cycle among Ultrathink's own dependencies comes out as a document the validator refuses", () => {
		const looped: UltrathinkGraphInput = {
			goal: "g",
			nodes: [
				{ id: "a", title: "A", kind: "understand", question: "q", dependsOn: ["b"] },
				{ id: "b", title: "B", kind: "decompose", question: "q", dependsOn: ["a"] },
			],
		};
		expect(rejected(validateGraph(fromUltrathinkGraph(looped))).map((error) => error.code)).toEqual(["cycle"]);
	});
});
