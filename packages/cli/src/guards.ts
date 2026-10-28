/**
 * Guards for the external JSON the CLI reads: an operator-typed `--payload`, the drift report and the
 * evidence bundle a server answers with. Each parses to `unknown` and checks the shape before anything
 * is read from it, so a reply of the wrong shape takes the failure path the CLI already has for a bad
 * reply instead of reaching a renderer or an exit-status decision as a cast.
 *
 * Hand-written on purpose: `@substrate/cli` has no schema library and takes none for a handful of shapes.
 */
import type { EvidenceBundle } from "@substrate/evidence";

export type JsonObject = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What `emit --payload` parsed to. Only an object is a payload; anything else is dropped by the caller. */
export type PayloadParse = { kind: "ok"; payload: JsonObject } | { kind: "invalid-json" } | { kind: "not-object" };

export function parseEmitPayload(raw: string): PayloadParse {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { kind: "invalid-json" };
	}
	return isRecord(parsed) ? { kind: "ok", payload: parsed } : { kind: "not-object" };
}

/**
 * The exit status of `drift --json` from the server's body: 0 for a clean scan, 1 otherwise.
 *
 * A body that is not a drift report (not JSON, not an object, no `ok: true` and no `findings` list)
 * is not a clean scan either, so it is 1.
 */
export function driftExitCode(body: string): 0 | 1 {
	let report: unknown;
	try {
		report = JSON.parse(body);
	} catch {
		return 1;
	}
	if (!isRecord(report)) return 1;
	if (report.ok === true) return 0;
	return Array.isArray(report.findings) && report.findings.length === 0 ? 0 : 1;
}

/** One check: the problem found at `path`, or `undefined` when the value is acceptable. */
type Validator = (value: unknown, path: string) => string | undefined;

const isString: Validator = (value, path) => (typeof value === "string" ? undefined : `${path} must be a string`);
const isBoolean: Validator = (value, path) => (typeof value === "boolean" ? undefined : `${path} must be a boolean`);
// Numbers are interpolated into the HTML unescaped, so only a real number may stand in for one.
const isNumber: Validator = (value, path) => (typeof value === "number" && Number.isFinite(value) ? undefined : `${path} must be a finite number`);
const isStringOrNumber: Validator = (value, path) =>
	typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) ? undefined : `${path} must be a string or a number`;
// A value rendered into `href` has to be a web URL: escaping does not make `javascript:` safe there.
const isHttpUrl: Validator = (value, path) =>
	typeof value === "string" && /^https?:\/\/\S+$/i.test(value) ? undefined : `${path} must be an http(s) URL`;

function oneOf(...allowed: string[]): Validator {
	return (value, path) => (typeof value === "string" && allowed.includes(value) ? undefined : `${path} must be one of ${allowed.join(", ")}`);
}

function optional(inner: Validator): Validator {
	return (value, path) => (value === undefined ? undefined : inner(value, path));
}

function nullable(inner: Validator): Validator {
	return (value, path) => (value === null ? undefined : inner(value, path));
}

function arrayOf(inner: Validator): Validator {
	return (value, path) => {
		if (!Array.isArray(value)) return `${path} must be a list`;
		for (let index = 0; index < value.length; index++) {
			const problem = inner(value[index], `${path}[${index}]`);
			if (problem !== undefined) return problem;
		}
		return undefined;
	};
}

function object(shape: Record<string, Validator>): Validator {
	return (value, path) => {
		if (!isRecord(value)) return `${path} must be an object`;
		for (const [key, check] of Object.entries(shape)) {
			const problem = check(value[key], `${path}.${key}`);
			if (problem !== undefined) return problem;
		}
		return undefined;
	};
}

const CHAIN_SHAPE: Record<string, Validator> = {
	ok: nullable(isBoolean),
	state: optional(oneOf("verified", "broken", "unverifiable", "not-configured")),
	records: isNumber,
	brokenAt: optional(isStringOrNumber),
	reason: optional(isString),
};

const ANCHOR_STATES = ["anchored", "pending", "unverified"];

/**
 * Every field of the bundle that `renderEvidenceHtml` writes into the document or that `substrate evidence`
 * reads to choose its exit status. A section the renderer treats as absent-able (`anchors`, `teachables`,
 * `usage`, `audit.attribution`) stays optional here.
 */
const validateBundle: Validator = object({
	graph_id: isString,
	generated: isString,
	service: object({ name: isString, version: isString, instance: isString }),
	chains: object({
		app_events: object(CHAIN_SHAPE),
		mcp_audit: object({ ...CHAIN_SHAPE, path: nullable(isString), unparseable: isNumber }),
	}),
	slos: arrayOf(
		object({
			id: isString,
			title: isString,
			statement: isString,
			detail: isString,
			status: oneOf("ok", "breached", "insufficient-data", "unmeasurable"),
			observed: nullable(isNumber),
			unit: oneOf("ms", "ratio"),
			samples: isNumber,
		}),
	),
	slo_summary: object({ ok: isNumber, breached: isNumber, insufficient: isNumber, unmeasurable: isNumber }),
	audit: object({
		total: isNumber,
		allowed: isNumber,
		denied: isNumber,
		attribution: optional(oneOf("exact", "ambiguous")),
		byTool: arrayOf(object({ tool: isString, allowed: isNumber, denied: isNumber })),
		records: arrayOf(
			object({
				seq: isNumber,
				ts: isString,
				surface: isString,
				tool: isString,
				decision: oneOf("allowed", "denied"),
				reason: optional(nullable(isString)),
			}),
		),
	}),
	usage: optional(nullable(object({ inputTokens: isNumber, outputTokens: isNumber, costUsd: isNumber }))),
	anchors: optional(
		arrayOf(
			object({
				period_start: isString,
				status: oneOf(...ANCHOR_STATES),
				event_count: isNumber,
				tx_sig: optional(isString),
				explorer_url: optional(isHttpUrl),
				reason: optional(isString),
			}),
		),
	),
	teachables: optional(
		arrayOf(
			object({
				event_id: isString,
				session_id: optional(isString),
				hour: optional(nullable(isString)),
				anchored: isBoolean,
				content_sha256: isString,
				tx_sig: optional(isString),
				explorer_url: optional(isHttpUrl),
				reason: optional(isString),
			}),
		),
	),
	pending: arrayOf(isString),
	notes: arrayOf(isString),
});

/**
 * The `node` member `POST /evidence` adds when asked for one node: the per-node artifact, or `{ error }` when the
 * server could not build it (an unreadable or unconfigured ledger). Mirrors `NodeArtifact` in the server's
 * `node-artifact.ts`; every field the document carries is checked, so nothing reaches the output unchecked.
 */
export type EvidenceNode =
	| { error: string }
	| {
			node_id: string;
			claim: Array<{ ts: string | null; action: string }>;
			linear: Array<{
				ts: string | null;
				op: string;
				status: "ok" | "failed";
				reason: string | null;
				blocker_node: string | null;
				edge_kind: string | null;
			}>;
			notion: Array<{ ts: string | null; op: string; status: "ok" | "failed"; reason: string | null }>;
			dod: Array<{ ts: string | null; status: "approved" | "refused" | "warning"; reason: string | null }>;
	  };

const MIRROR_STATUSES = ["ok", "failed"];

const validateNodeArtifact: Validator = object({
	node_id: isString,
	claim: arrayOf(object({ ts: nullable(isString), action: isString })),
	linear: arrayOf(
		object({
			ts: nullable(isString),
			op: isString,
			status: oneOf(...MIRROR_STATUSES),
			reason: nullable(isString),
			blocker_node: nullable(isString),
			edge_kind: nullable(isString),
		}),
	),
	notion: arrayOf(object({ ts: nullable(isString), op: isString, status: oneOf(...MIRROR_STATUSES), reason: nullable(isString) })),
	dod: arrayOf(object({ ts: nullable(isString), status: oneOf("approved", "refused", "warning"), reason: nullable(isString) })),
});

/** The problem with a `node` member, or `undefined` when it is `{ error: string }` or a whole artifact. */
const validateEvidenceNode: Validator = (value, path) => {
	if (isRecord(value) && "error" in value) return object({ error: isString })(value, path);
	return validateNodeArtifact(value, path);
};

/**
 * What the server's `/evidence` body parsed to: the bundle (with the `node` member when the server sent one),
 * text that is not JSON, or JSON of the wrong shape.
 */
export type EvidenceParse =
	| { ok: true; bundle: EvidenceBundle; node?: EvidenceNode }
	| { ok: false; reason: "invalid-json" }
	| { ok: false; reason: "malformed"; detail: string };

export function parseEvidenceBundle(body: string): EvidenceParse {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return { ok: false, reason: "invalid-json" };
	}
	const problem = validateBundle(parsed, "bundle");
	if (problem !== undefined) return { ok: false, reason: "malformed", detail: problem };
	// `validateBundle` checked every field the CLI reads, which is what the cast below asserts.
	const bundle = parsed as EvidenceBundle;
	// The node member is outside the bundle type: it is validated on its own and carried beside the bundle.
	const member: unknown = (parsed as JsonObject).node;
	if (member === undefined) return { ok: true, bundle };
	const nodeProblem = validateEvidenceNode(member, "bundle.node");
	if (nodeProblem !== undefined) return { ok: false, reason: "malformed", detail: nodeProblem };
	// `validateEvidenceNode` checked the whole member, which is what the cast below asserts.
	return { ok: true, bundle, node: member as EvidenceNode };
}
