/**
 * Phase 100 (F1): the unified T0 data-plane contract, enforced here first.
 *
 * Every validated write/read/update/supersede across Tools, Skills, Memory,
 * Context, Lessons and Teachable Moments carries mandatory provenance
 * (worktree, project, agent/session, event, content-hash). Missing provenance
 * is a structured rejection, never a silent default; cross-scope reads are
 * default-deny unless an explicit shared-scope flag is present.
 *
 * Pure module (no I/O): planes call `authorizeT0Write` / `authorizeT0Read` /
 * `authorizeT0Supersede` on their paths and quote the returned code. Nothing
 * here throws.
 */
export const T0_KINDS = ["tool", "skill", "memory", "context", "lesson", "teachable-moment"] as const;
export type T0Kind = (typeof T0_KINDS)[number];

/** Mandatory provenance on every T0 write. At least one of `agent` / `session` names the actor. */
export interface T0Provenance {
	/** The worktree (or checkout root) the entry was written from. */
	worktree: string;
	/** The project (repo slug or dataset) the entry belongs to. */
	project: string;
	/** The writing surface, when known. */
	agent?: string;
	/** The writing session, when known. */
	session?: string;
	/** The causative event id or trigger action that produced the entry. */
	event: string;
	/** Lowercase hex sha256 of the entry content. */
	content_hash: string;
}

export type T0Outcome =
	| { ok: true }
	| { ok: false; code: "t0.unknown-kind" | "t0.provenance-missing" | "t0.scope-denied" | "t0.supersede-mismatch"; reason: string; missing?: string[] };

/** A T0 write/update request: the kind plus its provenance. */
export interface T0WriteRequest {
	kind: unknown;
	provenance: unknown;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function isT0Kind(value: unknown): value is T0Kind {
	return typeof value === "string" && (T0_KINDS as readonly string[]).includes(value);
}

function missingProvenance(provenance: T0Provenance): string[] {
	const missing: string[] = [];
	if (provenance.worktree.trim().length === 0) missing.push("worktree");
	if (provenance.project.trim().length === 0) missing.push("project");
	if ((provenance.agent?.trim() ?? "").length === 0 && (provenance.session?.trim() ?? "").length === 0) {
		missing.push("agent/session");
	}
	if (provenance.event.trim().length === 0) missing.push("event");
	if (!SHA256_HEX.test(provenance.content_hash)) missing.push("content_hash");
	return missing;
}

/**
 * Validate kind + provenance for a write (create). An unknown kind is a
 * rejection, not a new namespace; missing provenance lists every missing
 * field so the caller can repair it. Never throws.
 */
export function validateT0Provenance(kind: unknown, provenance: unknown): T0Outcome {
	try {
		if (!isT0Kind(kind)) {
			return { ok: false, code: "t0.unknown-kind", reason: `t0: unknown kind ${JSON.stringify(String(kind)).slice(0, 60)} (expected one of ${T0_KINDS.join(", ")})` };
		}
		if (provenance === null || typeof provenance !== "object" || Array.isArray(provenance)) {
			return {
				ok: false,
				code: "t0.provenance-missing",
				reason: "t0: missing provenance (worktree, project, agent/session, event, content_hash required)",
				missing: ["worktree", "project", "agent/session", "event", "content_hash"],
			};
		}
		const record = provenance as Record<string, unknown>;
		const candidate: T0Provenance = {
			worktree: typeof record["worktree"] === "string" ? record["worktree"] : "",
			project: typeof record["project"] === "string" ? record["project"] : "",
			...(typeof record["agent"] === "string" ? { agent: record["agent"] } : {}),
			...(typeof record["session"] === "string" ? { session: record["session"] } : {}),
			event: typeof record["event"] === "string" ? record["event"] : "",
			content_hash: typeof record["content_hash"] === "string" ? record["content_hash"] : "",
		};
		const missing = missingProvenance(candidate);
		if (missing.length > 0) {
			return { ok: false, code: "t0.provenance-missing", reason: `t0: missing provenance: ${missing.join(", ")}`, missing };
		}
		return { ok: true };
	} catch (cause) {
		return { ok: false, code: "t0.provenance-missing", reason: `t0: provenance check failed (${cause instanceof Error ? cause.message : "unknown"})` };
	}
}

/** Alias kept for call sites that think in writes: identical to `validateT0Provenance`. */
export function authorizeT0Write(request: T0WriteRequest): T0Outcome {
	try {
		return validateT0Provenance(request.kind, request.provenance);
	} catch {
		return { ok: false, code: "t0.provenance-missing", reason: "t0: write authorization failed" };
	}
}

/**
 * Default-deny cross-scope read: a read whose record scope differs from the
 * requester's scope is denied unless `sharedScope` is explicitly true. Scope
 * strings compare exact (callers normalise before calling). Never throws.
 */
export function authorizeT0Read(input: { kind: unknown; recordScope: unknown; requesterScope: unknown; sharedScope?: boolean }): T0Outcome {
	try {
		if (!isT0Kind(input.kind)) {
			return { ok: false, code: "t0.unknown-kind", reason: `t0: unknown kind ${JSON.stringify(String(input.kind)).slice(0, 60)}` };
		}
		if (typeof input.recordScope !== "string" || input.recordScope.trim().length === 0) {
			return { ok: false, code: "t0.provenance-missing", reason: "t0: read needs a record scope", missing: ["recordScope"] };
		}
		if (typeof input.requesterScope !== "string" || input.requesterScope.trim().length === 0) {
			return { ok: false, code: "t0.provenance-missing", reason: "t0: read needs a requester scope", missing: ["requesterScope"] };
		}
		if (input.recordScope !== input.requesterScope && input.sharedScope !== true) {
			return {
				ok: false,
				code: "t0.scope-denied",
				reason: `t0: cross-scope read denied (${input.requesterScope} → ${input.recordScope} without sharedScope)`,
			};
		}
		return { ok: true };
	} catch {
		return { ok: false, code: "t0.scope-denied", reason: "t0: read authorization failed" };
	}
}

/**
 * Authorize an update/supersede: fresh provenance must validate, and
 * `supersedes` must name the current content hash — a stale supersede is a
 * mismatch, not a silent overwrite. Never throws.
 */
export function authorizeT0Supersede(input: { kind: unknown; provenance: unknown; supersedes: unknown; currentHash: unknown }): T0Outcome {
	try {
		const proven = validateT0Provenance(input.kind, input.provenance);
		if (!proven.ok) return proven;
		if (typeof input.supersedes !== "string" || typeof input.currentHash !== "string" || input.supersedes !== input.currentHash) {
			return { ok: false, code: "t0.supersede-mismatch", reason: "t0: supersedes does not match the current content hash" };
		}
		return { ok: true };
	} catch {
		return { ok: false, code: "t0.supersede-mismatch", reason: "t0: supersede authorization failed" };
	}
}
