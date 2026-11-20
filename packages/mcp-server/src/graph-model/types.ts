/**
 * The `substrate.graph` contract: one typed graph document, with one canonical byte form, for every shape of
 * structured reasoning Substrate stores.
 *
 * Why it exists. The tracker index (`../types.ts`: `GraphNode`, `GraphEdge`, `EDGE_KINDS` = requires, blocks,
 * gated_by) records which work item waits on which. It has no node kinds, no provenance and no canonical
 * serialization, so two runs of the same plan cannot be compared and a retrieved passage cannot be tied to the thought
 * it served. Ultrathink emits a Graph of Thought with a Chain of Thought filled into each node, and no Tree of
 * Thought. This contract holds all three in one document, and they nest inside each other:
 *
 *   chain  `step` nodes joined by `next`
 *   tree   a `decision` with ordered `child` branches and a `selected` edge to the winner
 *   graph  `thought` nodes joined by `depends_on`
 *
 * Edge direction. "Precedes" is the relation the acyclicity check and `topoOrder` use, so a dependency is never
 * mistaken for a cycle against the hierarchy it sits in:
 *
 *   depends_on     src needs dst first                              dst precedes src
 *   next           dst follows src in a chain; carries `order`      src precedes dst
 *   child          dst is the `order`-th alternative under src      src precedes dst
 *   contains       src holds dst                                    src precedes dst
 *   selected       src chose dst (a decision and its winning branch)
 *   supports       src is evidence for dst
 *   contradicts    src is evidence against dst
 *   retrieved_for  src was retrieved to serve dst (a retrieval or document_ref, and the node that needed it)
 *
 * Identity is content: an id is derived from the kind, the payload, the scope and an optional local key (see
 * `canonical.ts`). Volatile facts (timestamps, run ids) belong in `meta`, which never reaches an id or the content
 * hash.
 *
 * Versioning. `version` is `MAJOR.MINOR`. A reader accepts its own MAJOR and refuses any other with a
 * `ContractVersionError`. A MINOR only ever adds optional fields, so a reader ignores fields it does not know and a
 * change that adds a required field is a new MAJOR.
 */

/** The `contract` field of every document. */
export const GRAPH_CONTRACT = "substrate.graph";

/** The `MAJOR.MINOR` this module reads and writes. */
export const GRAPH_CONTRACT_VERSION = "1.0";

/** The MAJOR this module accepts. */
export const GRAPH_CONTRACT_MAJOR = 1;

export const GRAPH_NODE_KINDS = ["root", "thought", "step", "branch", "decision", "retrieval", "document_ref", "prompt_segment"] as const;
export type GraphNodeKind = (typeof GRAPH_NODE_KINDS)[number];

export const GRAPH_EDGE_KINDS = ["depends_on", "next", "child", "selected", "supports", "contradicts", "retrieved_for", "contains"] as const;
export type GraphEdgeKind = (typeof GRAPH_EDGE_KINDS)[number];

/** Where a node or an edge came from. */
export const PROVENANCE_ORIGINS = ["ultrathink", "substrate", "lightrag"] as const;
export type ProvenanceOrigin = (typeof PROVENANCE_ORIGINS)[number];

/** Edge kinds that carry an integer `order`, required: the position of the edge in the sequence it belongs to. */
export const ORDERED_EDGE_KINDS: readonly GraphEdgeKind[] = ["next", "child"];

/** Edge kinds that run from a container, a parent or a predecessor to what it holds or precedes. `descendants` and `ancestors` follow them. */
export const HIERARCHY_EDGE_KINDS: readonly GraphEdgeKind[] = ["contains", "child", "next"];

/** Edge kinds that order nodes. The relation they form is acyclic in a valid document, and `topoOrder` honours it. */
export const ORDERING_EDGE_KINDS: readonly GraphEdgeKind[] = ["depends_on", "contains", "child", "next"];

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;

export interface JsonObject {
	readonly [key: string]: JsonValue;
}

/** Who wrote the document. Tooling metadata: it is not part of the content hash. */
export interface Producer {
	readonly name: string;
	readonly version: string;
}

export interface Provenance {
	readonly origin: ProvenanceOrigin;
	/** The source document the node was taken from, when it was taken from one. */
	readonly sourceDocId?: string;
	/** The hash of that source document as it was read. */
	readonly sourceDocHash?: string;
	/** How far the origin trusts it: a retrieval relevance, a model confidence. Finite; the scale belongs to the origin. */
	readonly score?: number;
}

export interface RootPayload {
	readonly goal: string;
}

export interface ThoughtPayload {
	readonly title: string;
	readonly question: string;
	/** The producer's own name for the kind of thinking (Ultrathink: understand, decompose, generate, ...). */
	readonly thoughtKind?: string;
	readonly conclusion?: string;
	/** True when the producer could not fill the thought; `conclusion` is then absent. */
	readonly degraded?: boolean;
}

export interface StepPayload {
	readonly text: string;
}

export interface BranchPayload {
	readonly label: string;
	readonly text?: string;
}

export interface DecisionPayload {
	readonly question: string;
	readonly rationale?: string;
}

export interface RetrievalPayload {
	readonly query: string;
	/** The retrieval mode the plane was asked for (LightRAG: naive, local, global, hybrid). */
	readonly mode?: string;
}

export interface DocumentRefPayload {
	readonly docId: string;
	readonly docHash?: string;
	readonly title?: string;
	/** Where inside the document: a heading, a chunk id, a line range. */
	readonly locator?: string;
}

export interface PromptSegmentPayload {
	readonly role: string;
	readonly text: string;
}

/**
 * The fields every node carries. `payload` is what the node says and the only part of it (with `kind`, the scope and
 * `localKey`) an id is derived from; `provenance` says where it came from; `meta` holds volatile facts.
 */
export interface NodeEnvelope<K extends GraphNodeKind, P> {
	readonly id: string;
	readonly kind: K;
	readonly payload: P;
	/** A key the producer chose, stable across runs, hashed into the id so two otherwise identical siblings stay apart. */
	readonly localKey?: string;
	readonly provenance: Provenance;
	readonly meta?: JsonObject;
}

export type RootNode = NodeEnvelope<"root", RootPayload>;
export type ThoughtNode = NodeEnvelope<"thought", ThoughtPayload>;
export type StepNode = NodeEnvelope<"step", StepPayload>;
export type BranchNode = NodeEnvelope<"branch", BranchPayload>;
export type DecisionNode = NodeEnvelope<"decision", DecisionPayload>;
export type RetrievalNode = NodeEnvelope<"retrieval", RetrievalPayload>;
export type DocumentRefNode = NodeEnvelope<"document_ref", DocumentRefPayload>;
export type PromptSegmentNode = NodeEnvelope<"prompt_segment", PromptSegmentPayload>;

export type ModelNode = RootNode | ThoughtNode | StepNode | BranchNode | DecisionNode | RetrievalNode | DocumentRefNode | PromptSegmentNode;

export type NodeOfKind<K extends GraphNodeKind> = Extract<ModelNode, { readonly kind: K }>;

/**
 * An edge. Its id is derived from the kind and its two ends only, so a changed `order`, `score` or provenance leaves the
 * id alone and shows up as a *changed* edge in a diff rather than as a removed one and an added one.
 *
 * `order` is required on `next` and `child` and ignored on every other kind: the zero-based position of the edge in the
 * sequence it belongs to, which is the sibling index among a node's `child` edges and the index of the link along a
 * `next` chain (the link out of the first step is 0). `score` is optional on `child` and ignored elsewhere: how the
 * producer rated the alternative. It is not `provenance.score`, which rates the source.
 */
export interface ModelEdge {
	readonly id: string;
	readonly kind: GraphEdgeKind;
	readonly src: string;
	readonly dst: string;
	readonly order?: number;
	readonly score?: number;
	readonly provenance: Provenance;
	readonly meta?: JsonObject;
}

export interface GraphDocument {
	readonly contract: typeof GRAPH_CONTRACT;
	readonly version: typeof GRAPH_CONTRACT_VERSION;
	readonly producer: Producer;
	/** The key Substrate files the document under. Assigned, not derived, and not part of any node id or of the content hash. */
	readonly graphId: string;
	readonly nodes: readonly ModelNode[];
	readonly edges: readonly ModelEdge[];
	/** Volatile facts about the document: when it was written, which run wrote it. Never hashed. */
	readonly meta?: JsonObject;
}

/** The size limits `validateGraph` and `loadGraph` enforce. A limit is checked before the work it bounds. */
export interface GraphLimits {
	/** The largest document text `loadGraph` parses, in UTF-8 bytes. */
	readonly maxBytes: number;
	readonly maxNodes: number;
	readonly maxEdges: number;
	/** The longest string anywhere in a document, in UTF-16 code units. */
	readonly maxStringLength: number;
	/** The deepest nesting inside a `meta` object. */
	readonly maxDepth: number;
	/** Errors listed before a `too_many_errors` marker closes the list. */
	readonly maxErrors: number;
}

export const DEFAULT_GRAPH_LIMITS: GraphLimits = {
	maxBytes: 8 * 1024 * 1024,
	maxNodes: 10_000,
	maxEdges: 50_000,
	maxStringLength: 100_000,
	maxDepth: 16,
	maxErrors: 100,
};

/** One field of a node payload: its type and whether the node is invalid without it. */
export interface PayloadFieldRule {
	readonly type: "string" | "boolean";
	readonly required: boolean;
}

/**
 * The fields each node kind's payload holds. A required field that is missing or mistyped makes the document invalid;
 * a field not listed here is unknown and ignored.
 */
export const NODE_PAYLOAD_FIELDS: Readonly<Record<GraphNodeKind, Readonly<Record<string, PayloadFieldRule>>>> = {
	root: { goal: { type: "string", required: true } },
	thought: {
		title: { type: "string", required: true },
		question: { type: "string", required: true },
		thoughtKind: { type: "string", required: false },
		conclusion: { type: "string", required: false },
		degraded: { type: "boolean", required: false },
	},
	step: { text: { type: "string", required: true } },
	branch: { label: { type: "string", required: true }, text: { type: "string", required: false } },
	decision: { question: { type: "string", required: true }, rationale: { type: "string", required: false } },
	retrieval: { query: { type: "string", required: true }, mode: { type: "string", required: false } },
	document_ref: {
		docId: { type: "string", required: true },
		docHash: { type: "string", required: false },
		title: { type: "string", required: false },
		locator: { type: "string", required: false },
	},
	prompt_segment: { role: { type: "string", required: true }, text: { type: "string", required: true } },
};

/**
 * A node as builders and the validator assemble it, before its kind and its payload are tied together. `sealNode` in
 * `canonical.ts` is the one place that asserts the result is a `ModelNode`.
 */
export interface NodeDraft {
	id: string;
	kind: GraphNodeKind;
	payload: object;
	localKey?: string;
	provenance: Provenance;
	meta?: JsonObject;
}

/** An edge as builders and the validator assemble it: the same fields as `ModelEdge`, writable. */
export interface EdgeDraft {
	id: string;
	kind: GraphEdgeKind;
	src: string;
	dst: string;
	order?: number;
	score?: number;
	provenance: Provenance;
	meta?: JsonObject;
}

/**
 * The shape of an Ultrathink Graph of Thought with its Chain of Thought filled in, as `fromUltrathinkGraph` reads it. It
 * is defined here, not imported, so the model does not depend on the other repository; Ultrathink's own `ThoughtGraph`
 * is assignable to it.
 */
export interface UltrathinkNodeInput {
	readonly id: string;
	readonly title: string;
	/** Ultrathink's node kind: understand, decompose, generate, compare, critique, aggregate, refine or synthesize. */
	readonly kind: string;
	readonly question: string;
	/** The ids of the nodes this one needs first. */
	readonly dependsOn: readonly string[];
	/** The rationale: numbered steps in one string. */
	readonly thinking?: string | undefined;
	readonly conclusion?: string | undefined;
	/** Set when every fill attempt failed. */
	readonly degraded?: boolean | undefined;
}

export interface UltrathinkGraphInput {
	readonly goal: string;
	readonly nodes: readonly UltrathinkNodeInput[];
}

/** What `fromUltrathinkGraph` cannot read off the Ultrathink graph. */
export interface UltrathinkOptions {
	/** The key to file the document under. Defaults to the root node's id, so the same graph always gets the same key. */
	readonly graphId?: string | undefined;
	readonly producer?: Producer | undefined;
	readonly meta?: JsonObject | undefined;
}
