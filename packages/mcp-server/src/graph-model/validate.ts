/**
 * Layered validation of untrusted input, and the typed errors it returns.
 *
 * `validateGraph` takes anything and never throws on it. It runs its layers in order and stops at the first one that
 * finds a problem, because each layer relies on what the one before it established:
 *
 *   document   the input is a plain object (`loadGraph` first checks it is JSON within the byte limit)
 *   version    `contract` is `substrate.graph` and the MAJOR is this reader's: a document of another MAJOR gets one
 *              `ContractVersionError` and nothing else, because its shape is not this contract's to judge
 *   limits     node and edge counts are within bounds, before anything walks them; string length and meta nesting are
 *              limited as the schema layer reads each value
 *   schema     every field is present and typed. A kind this reader does not know is refused. A field it does not know is
 *              ignored: a MINOR only adds optional fields, so an unknown field is one an older reader may skip
 *   integrity  ids are unique and every edge ends at a node
 *   structure  exactly one root; the `depends_on`, `contains`, `child` and `next` edges are acyclic
 *
 * A document without problems comes back as a typed copy, not as the input: only the fields this contract defines, in
 * canonical order, with `version` set to the version this reader implements. The unknown fields are gone, so the copy
 * serializes and hashes the same as a document that never had them.
 *
 * Ids are checked for shape (`<kind>:` and 16 base32 characters), not re-derived: the scope and local key an id was
 * derived from are not part of the document.
 */
import { canonicalizeGraph, sealNode } from "./canonical.ts";
import { findCycle } from "./query.ts";
import {
	DEFAULT_GRAPH_LIMITS,
	GRAPH_CONTRACT,
	GRAPH_CONTRACT_MAJOR,
	GRAPH_CONTRACT_VERSION,
	GRAPH_EDGE_KINDS,
	GRAPH_NODE_KINDS,
	NODE_PAYLOAD_FIELDS,
	ORDERED_EDGE_KINDS,
	ORDERING_EDGE_KINDS,
	PROVENANCE_ORIGINS,
	type EdgeDraft,
	type GraphDocument,
	type GraphEdgeKind,
	type GraphLimits,
	type GraphNodeKind,
	type JsonObject,
	type JsonValue,
	type ModelEdge,
	type ModelNode,
	type NodeDraft,
	type Producer,
	type Provenance,
	type ProvenanceOrigin,
} from "./types.ts";

export type GraphErrorLayer = "document" | "version" | "limits" | "schema" | "integrity" | "structure";

export type GraphErrorCode =
	| "invalid_json"
	| "too_large"
	| "not_an_object"
	| "wrong_contract"
	| "contract_version"
	| "too_many_nodes"
	| "too_many_edges"
	| "string_too_long"
	| "too_deep"
	| "missing_field"
	| "invalid_type"
	| "invalid_value"
	| "unknown_node_kind"
	| "unknown_edge_kind"
	| "invalid_id"
	| "duplicate_id"
	| "dangling_edge"
	| "no_root"
	| "multiple_roots"
	| "cycle"
	| "too_many_errors";

/** One problem with a document. Returned in a list, never thrown. */
export class GraphValidationError extends Error {
	readonly code: GraphErrorCode;
	readonly layer: GraphErrorLayer;
	/** Where in the input, as a JSON pointer (`/nodes/3/payload/goal`); empty for the document as a whole. */
	readonly path: string;
	/** The ids the problem is about: the two ends of a dangling edge, the members of a cycle. */
	readonly related: readonly string[];

	constructor(code: GraphErrorCode, layer: GraphErrorLayer, path: string, message: string, related: readonly string[] = []) {
		super(message);
		this.name = "GraphValidationError";
		this.code = code;
		this.layer = layer;
		this.path = path;
		this.related = related;
	}
}

/** The longest stretch of a received value an error repeats. */
const SHOWN_LENGTH = 64;

/** A received string, quoted and cut short, for a message. An error must not echo a whole document back. */
function shown(value: string): string {
	return JSON.stringify(value.length > SHOWN_LENGTH ? `${value.slice(0, SHOWN_LENGTH)}…` : value);
}

/** The document's MAJOR is not the one this reader implements. Names both, so the fix (upgrade the reader or downgrade the writer) is plain. */
export class ContractVersionError extends GraphValidationError {
	/** The `MAJOR.MINOR` this reader implements. */
	readonly expected: string;
	/** The version the document claims, cut to a sensible length. */
	readonly received: string;

	constructor(expected: string, received: string) {
		super("contract_version", "version", "/version", `unsupported ${GRAPH_CONTRACT} version: expected major ${GRAPH_CONTRACT_MAJOR} (this reader implements ${expected}), received ${shown(received)}`);
		this.name = "ContractVersionError";
		this.expected = expected;
		this.received = received.slice(0, SHOWN_LENGTH);
	}
}

export type GraphValidation =
	| { readonly ok: true; readonly graph: GraphDocument }
	| { readonly ok: false; readonly errors: readonly GraphValidationError[] };

interface Ctx {
	readonly limits: GraphLimits;
	readonly errors: GraphValidationError[];
	/** Set by every problem, listed or not, so a cap on the list can never turn a failure into a pass. */
	failed: boolean;
	truncated: boolean;
}

function add(ctx: Ctx, error: GraphValidationError): void {
	ctx.failed = true;
	if (ctx.errors.length >= ctx.limits.maxErrors) {
		ctx.truncated = true;
		return;
	}
	ctx.errors.push(error);
}

function report(ctx: Ctx, code: GraphErrorCode, layer: GraphErrorLayer, path: string, message: string, related: readonly string[] = []): void {
	add(ctx, new GraphValidationError(code, layer, path, message, related));
}

function failure(ctx: Ctx): GraphValidation {
	const errors = [...ctx.errors];
	if (ctx.truncated) errors.push(new GraphValidationError("too_many_errors", "limits", "", `more than ${ctx.limits.maxErrors} problems; the rest are not listed`));
	return { ok: false, errors };
}

/** What reading one field found: a value, nothing (an optional field that is absent), or a problem already reported. */
type Field<T> = { readonly kind: "ok"; readonly value: T } | { readonly kind: "absent" } | { readonly kind: "bad" };

const BAD: Field<never> = { kind: "bad" };
const ABSENT: Field<never> = { kind: "absent" };

const NODE_KINDS: ReadonlySet<string> = new Set<string>(GRAPH_NODE_KINDS);
const EDGE_KINDS: ReadonlySet<string> = new Set<string>(GRAPH_EDGE_KINDS);
const ORIGINS: ReadonlySet<string> = new Set<string>(PROVENANCE_ORIGINS);
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ID_SUFFIX = /^[a-z2-7]{16}$/;

function isNodeKind(value: string): value is GraphNodeKind {
	return NODE_KINDS.has(value);
}

function isEdgeKind(value: string): value is GraphEdgeKind {
	return EDGE_KINDS.has(value);
}

function isOrigin(value: string): value is ProvenanceOrigin {
	return ORIGINS.has(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype: unknown = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** An own property, or undefined: a field named like something on `Object.prototype` is not a field. */
function own(record: Readonly<Record<string, unknown>>, key: string): unknown {
	return Object.hasOwn(record, key) ? record[key] : undefined;
}

function readString(ctx: Ctx, owner: Record<string, unknown>, key: string, parent: string, required: boolean, nonEmpty: boolean = required): Field<string> {
	const value = own(owner, key);
	if (value === undefined) {
		if (!required) return ABSENT;
		report(ctx, "missing_field", "schema", `${parent}/${key}`, `${key} is required`);
		return BAD;
	}
	if (typeof value !== "string") {
		report(ctx, "invalid_type", "schema", `${parent}/${key}`, `${key} must be a string`);
		return BAD;
	}
	if (value.length > ctx.limits.maxStringLength) {
		report(ctx, "string_too_long", "limits", `${parent}/${key}`, `${key} is longer than ${ctx.limits.maxStringLength} characters`);
		return BAD;
	}
	if (nonEmpty && value.length === 0) {
		report(ctx, "invalid_value", "schema", `${parent}/${key}`, `${key} must not be empty`);
		return BAD;
	}
	return { kind: "ok", value };
}

function readBoolean(ctx: Ctx, owner: Record<string, unknown>, key: string, parent: string, required: boolean): Field<boolean> {
	const value = own(owner, key);
	if (value === undefined) {
		if (!required) return ABSENT;
		report(ctx, "missing_field", "schema", `${parent}/${key}`, `${key} is required`);
		return BAD;
	}
	if (typeof value !== "boolean") {
		report(ctx, "invalid_type", "schema", `${parent}/${key}`, `${key} must be true or false`);
		return BAD;
	}
	return { kind: "ok", value };
}

/** `whole` asks for a non-negative integer (an `order`); otherwise any finite number (a `score`). */
function readNumber(ctx: Ctx, owner: Record<string, unknown>, key: string, parent: string, required: boolean, whole: boolean): Field<number> {
	const value = own(owner, key);
	if (value === undefined) {
		if (!required) return ABSENT;
		report(ctx, "missing_field", "schema", `${parent}/${key}`, `${key} is required`);
		return BAD;
	}
	if (typeof value !== "number") {
		report(ctx, "invalid_type", "schema", `${parent}/${key}`, `${key} must be a number`);
		return BAD;
	}
	if (!Number.isFinite(value) || (whole && (!Number.isSafeInteger(value) || value < 0))) {
		report(ctx, "invalid_value", "schema", `${parent}/${key}`, whole ? `${key} must be a non-negative integer` : `${key} must be a finite number`);
		return BAD;
	}
	return { kind: "ok", value };
}

/** An id is its kind, a colon and 16 base32 characters. With no known kind there is no prefix to check. */
function readId(ctx: Ctx, owner: Record<string, unknown>, parent: string, kind: GraphNodeKind | GraphEdgeKind | undefined): Field<string> {
	const id = readString(ctx, owner, "id", parent, true);
	if (id.kind !== "ok") return BAD;
	if (kind !== undefined && !(id.value.startsWith(`${kind}:`) && ID_SUFFIX.test(id.value.slice(kind.length + 1)))) {
		report(ctx, "invalid_id", "schema", `${parent}/id`, `id must be ${kind}: followed by 16 base32 characters (a-z, 2-7)`);
		return BAD;
	}
	return id;
}

function copyJsonValue(ctx: Ctx, value: unknown, path: string, depth: number): Field<JsonValue> {
	if (value === null || typeof value === "boolean") return { kind: "ok", value };
	if (typeof value === "number") {
		if (Number.isFinite(value)) return { kind: "ok", value };
		report(ctx, "invalid_value", "schema", path, "numbers must be finite");
		return BAD;
	}
	if (typeof value === "string") {
		if (value.length <= ctx.limits.maxStringLength) return { kind: "ok", value };
		report(ctx, "string_too_long", "limits", path, `a string is at most ${ctx.limits.maxStringLength} characters`);
		return BAD;
	}
	if (Array.isArray(value)) {
		if (depth > ctx.limits.maxDepth) {
			report(ctx, "too_deep", "limits", path, `meta nests at most ${ctx.limits.maxDepth} levels`);
			return BAD;
		}
		const items: JsonValue[] = [];
		let ok = true;
		for (const [index, item] of value.entries()) {
			const copied = copyJsonValue(ctx, item, `${path}/${index}`, depth + 1);
			if (copied.kind === "ok") items.push(copied.value);
			else ok = false;
		}
		return ok ? { kind: "ok", value: items } : BAD;
	}
	if (isPlainRecord(value)) return copyJsonObject(ctx, value, path, depth);
	report(ctx, "invalid_type", "schema", path, "meta holds JSON only: null, booleans, numbers, strings, arrays and objects");
	return BAD;
}

/** A property whose value is `undefined` is left out, as it is in a JSON text. Own properties are created by `fromEntries`, so a key named `__proto__` stays a key. */
function copyJsonObject(ctx: Ctx, record: Record<string, unknown>, path: string, depth: number): Field<JsonObject> {
	if (depth > ctx.limits.maxDepth) {
		report(ctx, "too_deep", "limits", path, `meta nests at most ${ctx.limits.maxDepth} levels`);
		return BAD;
	}
	const entries: Array<[string, JsonValue]> = [];
	let ok = true;
	for (const [key, item] of Object.entries(record)) {
		if (item === undefined) continue;
		const copied = copyJsonValue(ctx, item, `${path}/${key}`, depth + 1);
		if (copied.kind === "ok") entries.push([key, copied.value]);
		else ok = false;
	}
	return ok ? { kind: "ok", value: Object.fromEntries(entries) } : BAD;
}

function readMeta(ctx: Ctx, owner: Record<string, unknown>, parent: string): Field<JsonObject> {
	const raw = own(owner, "meta");
	if (raw === undefined) return ABSENT;
	const path = `${parent}/meta`;
	if (!isPlainRecord(raw)) {
		report(ctx, "invalid_type", "schema", path, "meta must be an object");
		return BAD;
	}
	return copyJsonObject(ctx, raw, path, 1);
}

interface ProvenanceDraft {
	origin: ProvenanceOrigin;
	sourceDocId?: string;
	sourceDocHash?: string;
	score?: number;
}

function readProvenance(ctx: Ctx, owner: Record<string, unknown>, parent: string): Field<Provenance> {
	const path = `${parent}/provenance`;
	const raw = own(owner, "provenance");
	if (raw === undefined) {
		report(ctx, "missing_field", "schema", path, "provenance is required");
		return BAD;
	}
	if (!isPlainRecord(raw)) {
		report(ctx, "invalid_type", "schema", path, "provenance must be an object");
		return BAD;
	}
	let origin: ProvenanceOrigin | undefined;
	const originValue = own(raw, "origin");
	if (originValue === undefined) {
		report(ctx, "missing_field", "schema", `${path}/origin`, "origin is required");
	} else if (typeof originValue !== "string" || !isOrigin(originValue)) {
		report(ctx, "invalid_value", "schema", `${path}/origin`, `origin must be one of ${PROVENANCE_ORIGINS.join(", ")}`);
	} else {
		origin = originValue;
	}
	const sourceDocId = readString(ctx, raw, "sourceDocId", path, false);
	const sourceDocHash = readString(ctx, raw, "sourceDocHash", path, false);
	const score = readNumber(ctx, raw, "score", path, false, false);
	if (origin === undefined || sourceDocId.kind === "bad" || sourceDocHash.kind === "bad" || score.kind === "bad") return BAD;
	const provenance: ProvenanceDraft = { origin };
	if (sourceDocId.kind === "ok") provenance.sourceDocId = sourceDocId.value;
	if (sourceDocHash.kind === "ok") provenance.sourceDocHash = sourceDocHash.value;
	if (score.kind === "ok") provenance.score = score.value;
	return { kind: "ok", value: provenance };
}

function readProducer(ctx: Ctx, owner: Record<string, unknown>): Field<Producer> {
	const raw = own(owner, "producer");
	if (raw === undefined) {
		report(ctx, "missing_field", "schema", "/producer", "producer is required");
		return BAD;
	}
	if (!isPlainRecord(raw)) {
		report(ctx, "invalid_type", "schema", "/producer", "producer must be an object");
		return BAD;
	}
	const name = readString(ctx, raw, "name", "/producer", true);
	const version = readString(ctx, raw, "version", "/producer", true);
	if (name.kind !== "ok" || version.kind !== "ok") return BAD;
	return { kind: "ok", value: { name: name.value, version: version.value } };
}

/** The fields the contract defines for this kind. A field it does not list is dropped. */
function readPayload(ctx: Ctx, kind: GraphNodeKind, record: Record<string, unknown>, path: string): Field<object> {
	let ok = true;
	const entries: Array<[string, string | boolean]> = [];
	for (const [name, rule] of Object.entries(NODE_PAYLOAD_FIELDS[kind])) {
		const field = rule.type === "boolean" ? readBoolean(ctx, record, name, path, rule.required) : readString(ctx, record, name, path, rule.required);
		if (field.kind === "ok") entries.push([name, field.value]);
		else if (field.kind === "bad") ok = false;
	}
	return ok ? { kind: "ok", value: Object.fromEntries(entries) } : BAD;
}

function readNode(ctx: Ctx, raw: unknown, index: number): Field<ModelNode> {
	const path = `/nodes/${index}`;
	if (!isPlainRecord(raw)) {
		report(ctx, "invalid_type", "schema", path, "a node must be an object");
		return BAD;
	}
	let kind: GraphNodeKind | undefined;
	const kindValue = own(raw, "kind");
	if (kindValue === undefined) {
		report(ctx, "missing_field", "schema", `${path}/kind`, "kind is required");
	} else if (typeof kindValue !== "string") {
		report(ctx, "invalid_type", "schema", `${path}/kind`, "kind must be a string");
	} else if (!isNodeKind(kindValue)) {
		report(ctx, "unknown_node_kind", "schema", `${path}/kind`, `unknown node kind ${shown(kindValue)}; expected one of ${GRAPH_NODE_KINDS.join(", ")}`);
	} else {
		kind = kindValue;
	}
	const id = readId(ctx, raw, path, kind);
	let payload: Field<object> = BAD;
	const payloadValue = own(raw, "payload");
	if (payloadValue === undefined) report(ctx, "missing_field", "schema", `${path}/payload`, "payload is required");
	else if (!isPlainRecord(payloadValue)) report(ctx, "invalid_type", "schema", `${path}/payload`, "payload must be an object");
	else if (kind !== undefined) payload = readPayload(ctx, kind, payloadValue, `${path}/payload`);
	const localKey = readString(ctx, raw, "localKey", path, false, true);
	const provenance = readProvenance(ctx, raw, path);
	const meta = readMeta(ctx, raw, path);
	if (kind === undefined || id.kind !== "ok" || payload.kind !== "ok" || localKey.kind === "bad" || provenance.kind !== "ok" || meta.kind === "bad") return BAD;
	const draft: NodeDraft = { id: id.value, kind, payload: payload.value, provenance: provenance.value };
	if (localKey.kind === "ok") draft.localKey = localKey.value;
	if (meta.kind === "ok") draft.meta = meta.value;
	return { kind: "ok", value: sealNode(draft) };
}

/** `order` is read on `next` and `child` and `score` on `child`; on any other kind they are unknown fields and ignored. */
function readEdge(ctx: Ctx, raw: unknown, index: number): Field<ModelEdge> {
	const path = `/edges/${index}`;
	if (!isPlainRecord(raw)) {
		report(ctx, "invalid_type", "schema", path, "an edge must be an object");
		return BAD;
	}
	let kind: GraphEdgeKind | undefined;
	const kindValue = own(raw, "kind");
	if (kindValue === undefined) {
		report(ctx, "missing_field", "schema", `${path}/kind`, "kind is required");
	} else if (typeof kindValue !== "string") {
		report(ctx, "invalid_type", "schema", `${path}/kind`, "kind must be a string");
	} else if (!isEdgeKind(kindValue)) {
		report(ctx, "unknown_edge_kind", "schema", `${path}/kind`, `unknown edge kind ${shown(kindValue)}; expected one of ${GRAPH_EDGE_KINDS.join(", ")}`);
	} else {
		kind = kindValue;
	}
	const id = readId(ctx, raw, path, kind);
	const src = readString(ctx, raw, "src", path, true);
	const dst = readString(ctx, raw, "dst", path, true);
	const order = kind !== undefined && ORDERED_EDGE_KINDS.includes(kind) ? readNumber(ctx, raw, "order", path, true, true) : ABSENT;
	const score = kind === "child" ? readNumber(ctx, raw, "score", path, false, false) : ABSENT;
	const provenance = readProvenance(ctx, raw, path);
	const meta = readMeta(ctx, raw, path);
	if (kind === undefined || id.kind !== "ok" || src.kind !== "ok" || dst.kind !== "ok" || order.kind === "bad" || score.kind === "bad" || provenance.kind !== "ok" || meta.kind === "bad") return BAD;
	const edge: EdgeDraft = { id: id.value, kind, src: src.value, dst: dst.value, provenance: provenance.value };
	if (order.kind === "ok") edge.order = order.value;
	if (score.kind === "ok") edge.score = score.value;
	if (meta.kind === "ok") edge.meta = meta.value;
	return { kind: "ok", value: edge };
}

function readList<T>(ctx: Ctx, owner: Record<string, unknown>, key: string, readItem: (raw: unknown, index: number) => Field<T>): Field<T[]> {
	const path = `/${key}`;
	const raw = own(owner, key);
	if (raw === undefined) {
		report(ctx, "missing_field", "schema", path, `${key} is required`);
		return BAD;
	}
	if (!Array.isArray(raw)) {
		report(ctx, "invalid_type", "schema", path, `${key} must be an array`);
		return BAD;
	}
	const items: T[] = [];
	let ok = true;
	for (const [index, item] of raw.entries()) {
		const read = readItem(item, index);
		if (read.kind === "ok") items.push(read.value);
		else ok = false;
	}
	return ok ? { kind: "ok", value: items } : BAD;
}

function readDocument(ctx: Ctx, input: Record<string, unknown>): Field<GraphDocument> {
	const producer = readProducer(ctx, input);
	const graphId = readString(ctx, input, "graphId", "", true);
	const nodes = readList(ctx, input, "nodes", (raw, index) => readNode(ctx, raw, index));
	const edges = readList(ctx, input, "edges", (raw, index) => readEdge(ctx, raw, index));
	const meta = readMeta(ctx, input, "");
	if (producer.kind !== "ok" || graphId.kind !== "ok" || nodes.kind !== "ok" || edges.kind !== "ok" || meta.kind === "bad") return BAD;
	return {
		kind: "ok",
		value: {
			contract: GRAPH_CONTRACT,
			version: GRAPH_CONTRACT_VERSION,
			producer: producer.value,
			graphId: graphId.value,
			nodes: nodes.value,
			edges: edges.value,
			...(meta.kind === "ok" ? { meta: meta.value } : {}),
		},
	};
}

/** The MAJOR gate. Anything but this reader's MAJOR, a malformed version included, is a `ContractVersionError`. */
function checkVersion(ctx: Ctx, input: Record<string, unknown>): boolean {
	const contract = own(input, "contract");
	if (contract === undefined) {
		report(ctx, "missing_field", "version", "/contract", "contract is required");
		return false;
	}
	if (contract !== GRAPH_CONTRACT) {
		report(ctx, "wrong_contract", "version", "/contract", `contract must be ${JSON.stringify(GRAPH_CONTRACT)}`);
		return false;
	}
	const version = own(input, "version");
	if (version === undefined) {
		report(ctx, "missing_field", "version", "/version", "version is required");
		return false;
	}
	if (typeof version !== "string") {
		report(ctx, "invalid_type", "version", "/version", "version must be a string");
		return false;
	}
	const match = VERSION_PATTERN.exec(version);
	if (match === null || Number(match[1]) !== GRAPH_CONTRACT_MAJOR) {
		add(ctx, new ContractVersionError(GRAPH_CONTRACT_VERSION, version));
		return false;
	}
	return true;
}

/** The counts, checked before any element is read. A field that is not an array is the schema layer's to report. */
function checkCounts(ctx: Ctx, input: Record<string, unknown>): boolean {
	const nodes = own(input, "nodes");
	if (Array.isArray(nodes) && nodes.length > ctx.limits.maxNodes) {
		report(ctx, "too_many_nodes", "limits", "/nodes", `a document holds at most ${ctx.limits.maxNodes} nodes; this one has ${nodes.length}`);
	}
	const edges = own(input, "edges");
	if (Array.isArray(edges) && edges.length > ctx.limits.maxEdges) {
		report(ctx, "too_many_edges", "limits", "/edges", `a document holds at most ${ctx.limits.maxEdges} edges; this one has ${edges.length}`);
	}
	return !ctx.failed;
}

function checkIntegrity(ctx: Ctx, graph: GraphDocument): void {
	const nodeIds = new Set<string>();
	for (const [index, node] of graph.nodes.entries()) {
		if (nodeIds.has(node.id)) report(ctx, "duplicate_id", "integrity", `/nodes/${index}/id`, `node id ${node.id} appears more than once`, [node.id]);
		nodeIds.add(node.id);
	}
	const edgeIds = new Set<string>();
	for (const [index, edge] of graph.edges.entries()) {
		if (edgeIds.has(edge.id)) report(ctx, "duplicate_id", "integrity", `/edges/${index}/id`, `edge id ${edge.id} appears more than once`, [edge.id]);
		edgeIds.add(edge.id);
		if (!nodeIds.has(edge.src)) report(ctx, "dangling_edge", "integrity", `/edges/${index}/src`, `edge ${edge.id} starts at ${edge.src}, which is not a node`, [edge.id, edge.src]);
		if (!nodeIds.has(edge.dst)) report(ctx, "dangling_edge", "integrity", `/edges/${index}/dst`, `edge ${edge.id} ends at ${edge.dst}, which is not a node`, [edge.id, edge.dst]);
	}
}

function checkStructure(ctx: Ctx, graph: GraphDocument): void {
	const roots = graph.nodes.filter((node) => node.kind === "root");
	if (roots.length === 0) {
		report(ctx, "no_root", "structure", "/nodes", "a graph has exactly one root node; this one has none");
	} else if (roots.length > 1) {
		report(
			ctx,
			"multiple_roots",
			"structure",
			"/nodes",
			`a graph has exactly one root node; this one has ${roots.length}`,
			roots.map((node) => node.id),
		);
	}
	const cycle = findCycle(graph);
	if (cycle !== null) {
		const route = cycle.length > 9 ? [...cycle.slice(0, 8), "…"] : cycle;
		report(ctx, "cycle", "structure", "/edges", `the ${ORDERING_EDGE_KINDS.join(", ")} edges form a cycle: ${route.join(" -> ")}`, cycle);
	}
}

/**
 * Validates anything that is plain data, which is everything `JSON.parse` can return and any object built from it.
 * Returns the typed document, or every problem the first failing layer found (at most `limits.maxErrors` of them, then a
 * `too_many_errors` marker). Never throws on such input; an object with a throwing getter or a hostile proxy is not data.
 */
export function validateGraph(input: unknown, limits: Partial<GraphLimits> = {}): GraphValidation {
	const ctx: Ctx = { limits: { ...DEFAULT_GRAPH_LIMITS, ...limits }, errors: [], failed: false, truncated: false };
	if (!isPlainRecord(input)) {
		report(ctx, "not_an_object", "document", "", "a graph document must be a JSON object");
		return failure(ctx);
	}
	if (!checkVersion(ctx, input) || !checkCounts(ctx, input)) return failure(ctx);
	const parsed = readDocument(ctx, input);
	if (parsed.kind !== "ok" || ctx.failed) return failure(ctx);
	checkIntegrity(ctx, parsed.value);
	if (ctx.failed) return failure(ctx);
	checkStructure(ctx, parsed.value);
	if (ctx.failed) return failure(ctx);
	return { ok: true, graph: canonicalizeGraph(parsed.value) };
}

/** `validateGraph` over a JSON text. The byte limit is checked before the text is parsed. */
export function loadGraph(text: string, limits: Partial<GraphLimits> = {}): GraphValidation {
	const maxBytes = limits.maxBytes ?? DEFAULT_GRAPH_LIMITS.maxBytes;
	if (Buffer.byteLength(text, "utf8") > maxBytes) {
		return { ok: false, errors: [new GraphValidationError("too_large", "document", "", `a document is at most ${maxBytes} bytes of UTF-8`)] };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { ok: false, errors: [new GraphValidationError("invalid_json", "document", "", "the text is not valid JSON")] };
	}
	return validateGraph(parsed, limits);
}
