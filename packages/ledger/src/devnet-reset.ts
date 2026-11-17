/**
 * Devnet reset classification (v1.6, phase 59). Solana devnet is wiped from time to time; after a
 * wipe every anchor signature is gone from the cluster, which from the outside looks like missing
 * evidence. This module turns the three facts a verifier can observe (the cluster's genesis hash,
 * the signature's status, how old the anchor is) into a verdict that never confuses "the chain was
 * reset" or "the chain cannot be reached" with tampering.
 *
 * Pure: no network, no clock of its own (`nowMs` is a parameter), no environment.
 *
 * The verdict is about the CHAIN, not the anchor's content. A verifier must read `reset-suspected`,
 * `chain-unreachable` and `signature-missing` as "unverified", never as "mismatch": only a chain read
 * that succeeded and disagrees with the recomputed root is a mismatch.
 */

/** How the cluster answered for one signature. `unreachable` means the question could not be asked at all. */
export const SIGNATURE_STATUSES = ["finalized", "confirmed", "processed", "not-found", "unreachable"] as const;
export type SignatureStatus = (typeof SIGNATURE_STATUSES)[number];

export const CHAIN_VERDICTS = ["ok", "reset-suspected", "chain-unreachable", "signature-missing"] as const;
export type ChainVerdict = (typeof CHAIN_VERDICTS)[number];

/**
 * An anchor younger than this may simply not be visible yet (RPC propagation, confirmation lag), so a
 * missing or merely `processed` signature inside the window is `chain-unreachable`, not a missing
 * signature. Two minutes is several times the observed devnet confirmation time.
 */
export const YOUNG_ANCHOR_GRACE_MS = 120_000;

export interface ChainEvidenceInput {
	/** The genesis hash this deployment expects (devnet's). Never empty. */
	expectedGenesis: string;
	/** The genesis hash the RPC reported; null when the read failed. */
	observedGenesis: string | null;
	signatureStatus: SignatureStatus;
	/** When the anchor was written, epoch ms (the anchors row's `anchored_at`). */
	anchoredAtMs: number;
	nowMs: number;
}

export interface ChainEvidence {
	verdict: ChainVerdict;
	reason: string;
}

/**
 * Classify the chain evidence for one anchor.
 *
 * Order matters and is the contract:
 * 1. no genesis hash was read -> `chain-unreachable` (nothing can be concluded);
 * 2. the genesis hash differs -> `reset-suspected` (a different cluster answered, whatever it says
 *    about the signature; this is never tamper);
 * 3. the signature lookup failed -> `chain-unreachable`;
 * 4. `finalized` or `confirmed` -> `ok`;
 * 5. `processed` or `not-found`: a young anchor is `chain-unreachable` (not visible yet), an old one
 *    is `signature-missing`.
 *
 * Throws `TypeError` on malformed input (a programming error, not chain evidence).
 */
export function classifyChainEvidence(input: ChainEvidenceInput): ChainEvidence {
	const { expectedGenesis, observedGenesis, signatureStatus, anchoredAtMs, nowMs } = input;
	if (typeof expectedGenesis !== "string" || expectedGenesis.length === 0) throw new TypeError("classifyChainEvidence: expectedGenesis must be a non-empty string");
	if (observedGenesis !== null && (typeof observedGenesis !== "string" || observedGenesis.length === 0)) {
		throw new TypeError("classifyChainEvidence: observedGenesis must be a non-empty string or null");
	}
	if (!SIGNATURE_STATUSES.includes(signatureStatus)) throw new TypeError(`classifyChainEvidence: signatureStatus must be one of ${SIGNATURE_STATUSES.join(", ")}`);
	if (!Number.isFinite(anchoredAtMs) || !Number.isFinite(nowMs)) throw new TypeError("classifyChainEvidence: anchoredAtMs and nowMs must be finite numbers");

	if (observedGenesis === null) {
		return { verdict: "chain-unreachable", reason: "the cluster's genesis hash could not be read, so nothing can be concluded about the anchor" };
	}
	if (observedGenesis !== expectedGenesis) {
		return {
			verdict: "reset-suspected",
			reason: `the cluster reports genesis ${observedGenesis}, not the expected ${expectedGenesis}: the devnet was probably reset, which says nothing about the anchored root`,
		};
	}
	if (signatureStatus === "unreachable") {
		return { verdict: "chain-unreachable", reason: "the signature could not be looked up (the RPC did not answer), which is not a verdict about the anchor" };
	}
	if (signatureStatus === "finalized" || signatureStatus === "confirmed") {
		return { verdict: "ok", reason: `the signature is ${signatureStatus} on the expected cluster` };
	}
	const ageMs = Math.max(0, nowMs - anchoredAtMs);
	const ageS = Math.floor(ageMs / 1000);
	if (ageMs < YOUNG_ANCHOR_GRACE_MS) {
		return {
			verdict: "chain-unreachable",
			reason: `the signature is ${signatureStatus === "processed" ? "only processed" : "not visible yet"} ${ageS} s after anchoring, inside the ${YOUNG_ANCHOR_GRACE_MS / 1000} s grace window`,
		};
	}
	return {
		verdict: "signature-missing",
		reason:
			signatureStatus === "processed"
				? `the signature is still only processed ${ageS} s after anchoring; it never confirmed on the expected cluster`
				: `the signature is not found ${ageS} s after anchoring on the expected cluster`,
	};
}
