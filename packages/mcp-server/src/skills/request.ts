// What the REST route and the MCP tool share about a skill proposal, so the two doors cannot
// answer the same input differently: the body's shape, the request `Substrate.proposeSkill`
// takes, and how each way a proposal can fail maps onto a status and a body (D21-09).
//
// Pure: no store, no process, no git. The engine validates the content of a proposal; this
// module only checks that the body is the shape the engine expects.

import { redact } from "../redact.ts";
import { SkillProposalDenied, SkillProposalStale, type SkillProposalRequest } from "../service.ts";
import { SURFACES } from "../types.ts";
import { ProposeFailed, ProposeRefused, PROPOSE_BATCH_MAX, ROUTE_MAX_BYTES } from "./propose.ts";

/** The most a failed git or gh step may say to a caller (D21-09). */
const FAILURE_MESSAGE_MAX = 400;

/**
 * The proposal body's shape, as a message for a 400, or null when it is well formed. Content
 * (names, paths, frontmatter, secrets) is the engine's to judge; a wrong type is refused here
 * so a malformed body never reaches the audit chain's service call or emits an event.
 */
export function proposalBodyProblem(body: unknown): string | null {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return "body must be a JSON object";
	const b = body as Record<string, unknown>;
	if (typeof b.name !== "string") return "name must be a string";
	if (b.files === null || typeof b.files !== "object" || Array.isArray(b.files)) {
		return "files must be an object of relative path to text";
	}
	if (Object.values(b.files).some((value) => typeof value !== "string")) return "every file must be a string of UTF-8 text";
	if (typeof b.rationale !== "string") return "rationale must be a string";
	if (b.remove !== undefined && (!Array.isArray(b.remove) || b.remove.some((path) => typeof path !== "string"))) {
		return "remove must be an array of relative paths";
	}
	if (b.surface !== undefined && (typeof b.surface !== "string" || !(SURFACES as readonly string[]).includes(b.surface))) {
		return `unknown surface ${JSON.stringify(String(b.surface)).slice(0, 80)}`;
	}
	for (const key of ["session_id", "graph_id"] as const) {
		if (b[key] !== undefined && typeof b[key] !== "string") return `${key} must be a string`;
	}
	for (const key of ["dry_run", "reopen"] as const) {
		if (b[key] !== undefined && typeof b[key] !== "boolean") return `${key} must be a boolean`;
	}
	if (b.mode !== undefined && b.mode !== "overlay" && b.mode !== "replace") return "mode must be overlay or replace";
	if (
		b.allow_doc_examples !== undefined &&
		(!Array.isArray(b.allow_doc_examples) || b.allow_doc_examples.some((rule) => rule !== "pem" && rule !== "jwt"))
	) {
		return "allow_doc_examples must be an array of pem or jwt";
	}
	if (b.expected_version !== undefined && (typeof b.expected_version !== "number" || !Number.isInteger(b.expected_version) || b.expected_version < 0)) {
		return "expected_version must be a non-negative integer";
	}
	return null;
}

/**
 * The proposal body's serialized size as a refusal message, or null when it fits.
 *
 * Measured on the caller's own JSON (canonical UTF-8), before the server attributes the call to
 * its token surface, so attribution never costs the caller budget. The REST route is already
 * bounded by its 1 MB wire cap; the MCP tool is not (its transport reads up to the docs cap), so
 * the tool calls this before the service. The engine's cap counts file text only, so a large
 * rationale or removal list would otherwise reach it. The limit is the engine's own, so the
 * two guards cannot disagree about it.
 */
export function proposalBodySizeProblem(body: object): string | null {
	const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
	if (bytes > ROUTE_MAX_BYTES) return `the proposal is ${bytes} bytes as JSON, over the limit of ${ROUTE_MAX_BYTES} bytes`;
	return null;
}

/** The flags a batch shares across its proposals, as the single body carries them per proposal. */
export interface ProposalShared {
	dry_run?: boolean | undefined;
	mode?: "overlay" | "replace" | undefined;
	reopen?: boolean | undefined;
	allow_doc_examples?: Array<"pem" | "jwt"> | undefined;
}

/** True when the body is the batch shape, `{ proposals: [...] }`, rather than one proposal. */
export function isProposalBatch(body: unknown): boolean {
	return body !== null && typeof body === "object" && !Array.isArray(body) && "proposals" in (body as Record<string, unknown>);
}

/**
 * The batch envelope's shape, as a message for a 400, or null when well formed. Only the
 * envelope is judged here — the array, its cap, one object per item, and the shared flags.
 * Each item's own fields are the engine's to judge, item by item, so one malformed item is
 * a per-item refusal rather than a whole-batch 400.
 */
export function proposalBatchProblem(body: unknown): string | null {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return "body must be a JSON object";
	const b = body as Record<string, unknown>;
	if (!Array.isArray(b.proposals)) return "proposals must be an array of proposals";
	if (b.proposals.length === 0) return "a batch needs at least one proposal";
	if (b.proposals.length > PROPOSE_BATCH_MAX) return `a batch takes at most ${PROPOSE_BATCH_MAX} proposals, not ${b.proposals.length}`;
	if (b.proposals.some((item) => item === null || typeof item !== "object" || Array.isArray(item))) return "every proposal must be an object";
	for (const key of ["dry_run", "reopen"] as const) {
		if (b[key] !== undefined && typeof b[key] !== "boolean") return `${key} must be a boolean`;
	}
	if (b.mode !== undefined && b.mode !== "overlay" && b.mode !== "replace") return "mode must be overlay or replace";
	if (
		b.allow_doc_examples !== undefined &&
		(!Array.isArray(b.allow_doc_examples) || b.allow_doc_examples.some((rule) => rule !== "pem" && rule !== "jwt"))
	) {
		return "allow_doc_examples must be an array of pem or jwt";
	}
	return null;
}

/**
 * The batch body's serialized size as a refusal message, or null when it fits under the
 * batch's total cap (the single cap per proposal, times the batch cap). A single item over
 * the per-item cap is not refused here: the engine answers it as that item's own refusal,
 * so its siblings still run.
 */
export function proposalBatchSizeProblem(body: object): string | null {
	const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
	if (bytes > ROUTE_MAX_BYTES * PROPOSE_BATCH_MAX) return `the batch is ${bytes} bytes as JSON, over the limit of ${ROUTE_MAX_BYTES * PROPOSE_BATCH_MAX} bytes`;
	return null;
}

/** The requests `Substrate.proposeSkills` takes, from a body `proposalBatchProblem` accepted. */
export function toProposalRequests(body: Record<string, unknown>): SkillProposalRequest[] {
	return ((body.proposals ?? []) as Array<Record<string, unknown>>).map((item) => toProposalRequest(item));
}

/** The shared flags a batch body carries at the top level, for `Substrate.proposeSkills`. */
export function toProposalShared(body: Record<string, unknown>): ProposalShared {
	return {
		...(body.dry_run !== undefined ? { dry_run: body.dry_run as boolean } : {}),
		...(body.mode !== undefined ? { mode: body.mode as "overlay" | "replace" } : {}),
		...(body.reopen !== undefined ? { reopen: body.reopen as boolean } : {}),
		...(body.allow_doc_examples !== undefined ? { allow_doc_examples: body.allow_doc_examples as Array<"pem" | "jwt"> } : {}),
	};
}

/** The request `Substrate.proposeSkill` takes, from a body `proposalBodyProblem` accepted. */
export function toProposalRequest(body: Record<string, unknown>): SkillProposalRequest {
	return {
		name: body.name as string,
		files: body.files as Record<string, string>,
		rationale: body.rationale as string,
		...(body.remove !== undefined ? { remove: body.remove as string[] } : {}),
		...(body.surface !== undefined ? { surface: body.surface as string } : {}),
		...(body.session_id !== undefined ? { session_id: body.session_id as string } : {}),
		...(body.graph_id !== undefined ? { graph_id: body.graph_id as string } : {}),
		...(body.dry_run !== undefined ? { dry_run: body.dry_run as boolean } : {}),
		...(body.mode !== undefined ? { mode: body.mode as "overlay" | "replace" } : {}),
		...(body.reopen !== undefined ? { reopen: body.reopen as boolean } : {}),
		...(body.allow_doc_examples !== undefined ? { allow_doc_examples: body.allow_doc_examples as Array<"pem" | "jwt"> } : {}),
		...(body.expected_version !== undefined ? { expected_version: body.expected_version as number } : {}),
	};
}

/** What a failed proposal answers with: the route's status and JSON body, and the tool's refusal payload. */
export interface ProposalFailure {
	status: 400 | 401 | 403 | 409 | 502;
	body: {
		refused?: true;
		error: string;
		findings?: Array<{ file: string; line: number; rule: string }>;
		/** On a 409 `version.stale`: memory's conflict fields, so a caller reads one shape for both. */
		outcome?: "conflict";
		reason?: "version.stale";
		remedy?: string;
		current_version?: number | null;
		verified_persisted?: false;
		conflict_with?: string;
	};
}

/**
 * How a proposal's failure reaches the caller, or null for an error that is not one of the
 * proposal's own (the caller rethrows it). A refusal carries findings as file, line and rule,
 * never a value; a failed git or gh step is redacted and capped.
 */
export function proposalFailure(cause: unknown): ProposalFailure | null {
	if (cause instanceof SkillProposalDenied) return { status: cause.status, body: { error: cause.message, refused: true } };
	if (cause instanceof SkillProposalStale) {
		return {
			status: 409,
			body: {
				error: cause.message,
				outcome: "conflict",
				reason: "version.stale",
				remedy: cause.remedy,
				current_version: cause.current_version,
				verified_persisted: false,
				...(cause.conflict_with !== null ? { conflict_with: cause.conflict_with } : {}),
			},
		};
	}
	if (cause instanceof ProposeRefused) {
		const findings = cause.findings?.map(({ file, line, rule }) => ({ file, line, rule }));
		return { status: 400, body: { error: cause.message, refused: true, ...(findings ? { findings } : {}) } };
	}
	if (cause instanceof ProposeFailed) {
		return { status: 502, body: { error: redact(cause.message).slice(0, FAILURE_MESSAGE_MAX) } };
	}
	return null;
}
