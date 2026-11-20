/**
 * The promotion gate for context-matrix entries.
 *
 * A candidate entry becomes accepted context only when it has complete provenance,
 * carries no credential or personal data, and does not contradict an entry already
 * accepted under the same realm, kind and source. This module is pure: it takes the
 * candidate and the accepted set, and returns a decision. It performs no I/O.
 */
import { classify } from "./memory-classify.ts";
import { redact } from "./redact.ts";

export type CandidateEntry = {
	entryId: string;
	realm: string;
	milestone: string;
	phase: string;
	sourcePath: string;
	sourceSha256: string;
	entryKind: "decision" | "fact" | "warning" | "todo";
	bodyRedacted: string;
};

export type PromotionDecision =
	| { outcome: "accepted"; reason: "new" }
	| { outcome: "already-accepted"; reason: "same body" }
	| { outcome: "held"; reason: "conflict" | "pii" | "speculative" }
	| { outcome: "denied"; reason: "malformed" | "unsourced" | "secret" };

const ENTRY_KINDS: readonly CandidateEntry["entryKind"][] = ["decision", "fact", "warning", "todo"];
const SHA256_HEX = /^[0-9a-f]{64}$/;

function blank(value: string): boolean {
	return value.trim().length === 0;
}

/**
 * Decide whether a candidate may be promoted into the accepted set.
 *
 * Rules are applied in order; the first match wins:
 *   1. malformed  – realm, milestone, phase or body is blank; entryKind is not one of
 *                   the four kinds; sourceSha256 is present but not 64 lowercase hex.
 *   2. unsourced  – sourcePath or sourceSha256 is blank. Reached only when rule 1 passed,
 *                   so the candidate's other fields are valid and only its provenance is missing.
 *   3. secret     – the body is not stable under `redact()`, or `classify()` reports a secret.
 *   4. pii, speculative – `classify()` reports personal data, or a hedged decision or fact. Held for review, never accepted.
 *   5. conflict   – an accepted entry has the same realm, kind and source but a different body.
 *   6. already-accepted – an accepted entry has the same realm, kind, source and identical body.
 *   7. accepted   – otherwise.
 */
export function decidePromotion(candidate: CandidateEntry, accepted: readonly CandidateEntry[]): PromotionDecision {
	const body = candidate.bodyRedacted;

	if (
		blank(candidate.realm) ||
		blank(candidate.milestone) ||
		blank(candidate.phase) ||
		blank(body) ||
		!ENTRY_KINDS.includes(candidate.entryKind) ||
		(!blank(candidate.sourceSha256) && !SHA256_HEX.test(candidate.sourceSha256))
	) {
		return { outcome: "denied", reason: "malformed" };
	}

	if (blank(candidate.sourcePath) || blank(candidate.sourceSha256)) {
		return { outcome: "denied", reason: "unsourced" };
	}

	const finding = classify(body, candidate.entryKind);
	if (redact(body) !== body || finding?.reason === "secret") {
		return { outcome: "denied", reason: "secret" };
	}

	if (finding?.reason === "pii") {
		return { outcome: "held", reason: "pii" };
	}
	if (finding?.reason === "speculative") {
		return { outcome: "held", reason: "speculative" };
	}

	const sameSlot = accepted.filter(
		(entry) =>
			entry.realm === candidate.realm &&
			entry.entryKind === candidate.entryKind &&
			entry.sourcePath === candidate.sourcePath,
	);

	if (sameSlot.some((entry) => entry.bodyRedacted !== body)) {
		return { outcome: "held", reason: "conflict" };
	}

	if (sameSlot.length > 0) {
		return { outcome: "already-accepted", reason: "same body" };
	}

	return { outcome: "accepted", reason: "new" };
}
