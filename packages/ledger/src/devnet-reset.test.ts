import { describe, expect, test } from "bun:test";
import { CHAIN_VERDICTS, type ChainEvidenceInput, classifyChainEvidence, SIGNATURE_STATUSES, YOUNG_ANCHOR_GRACE_MS } from "./devnet-reset.ts";

const DEVNET = "EtWTRABZaYq6iMfeYKouRu166VU2xqaEyCydFLPYGEC";
const WIPED = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const ANCHORED_AT = Date.UTC(2026, 9, 20, 12);
const OLD = ANCHORED_AT + 3_600_000;

function input(overrides: Partial<ChainEvidenceInput> = {}): ChainEvidenceInput {
	return { expectedGenesis: DEVNET, observedGenesis: DEVNET, signatureStatus: "finalized", anchoredAtMs: ANCHORED_AT, nowMs: OLD, ...overrides };
}

describe("classifyChainEvidence", () => {
	test("a finalized or confirmed signature on the expected cluster is ok", () => {
		for (const signatureStatus of ["finalized", "confirmed"] as const) {
			expect(classifyChainEvidence(input({ signatureStatus })).verdict).toBe("ok");
		}
	});

	test("a genesis hash that differs is reset-suspected whatever the signature status says, and never anything else", () => {
		for (const signatureStatus of SIGNATURE_STATUSES) {
			const result = classifyChainEvidence(input({ observedGenesis: WIPED, signatureStatus }));
			expect({ signatureStatus, verdict: result.verdict }).toEqual({ signatureStatus, verdict: "reset-suspected" });
			expect(result.reason).toContain(WIPED);
			expect(result.reason).toContain("reset");
		}
	});

	test("an unreadable genesis hash, or a failed signature lookup, is chain-unreachable", () => {
		const noGenesis = classifyChainEvidence(input({ observedGenesis: null, signatureStatus: "not-found" }));
		expect(noGenesis.verdict).toBe("chain-unreachable");
		const lookupFailed = classifyChainEvidence(input({ signatureStatus: "unreachable" }));
		expect(lookupFailed.verdict).toBe("chain-unreachable");
		expect(lookupFailed.reason).toContain("not a verdict about the anchor");
	});

	test("unreachable is never a verdict about the anchor: no input with it can yield signature-missing or reset-suspected on a matching cluster", () => {
		for (const nowMs of [ANCHORED_AT, OLD, OLD * 2]) {
			expect(classifyChainEvidence(input({ signatureStatus: "unreachable", nowMs })).verdict).toBe("chain-unreachable");
			expect(classifyChainEvidence(input({ observedGenesis: null, nowMs })).verdict).toBe("chain-unreachable");
		}
	});

	test("not-found on the expected cluster is signature-missing once the anchor is older than the grace window", () => {
		const old = classifyChainEvidence(input({ signatureStatus: "not-found" }));
		expect(old.verdict).toBe("signature-missing");
		expect(old.reason).toContain("not found");
		const edge = classifyChainEvidence(input({ signatureStatus: "not-found", nowMs: ANCHORED_AT + YOUNG_ANCHOR_GRACE_MS }));
		expect(edge.verdict).toBe("signature-missing");
	});

	test("a young anchor that is not visible yet is chain-unreachable, not missing", () => {
		const young = classifyChainEvidence(input({ signatureStatus: "not-found", nowMs: ANCHORED_AT + YOUNG_ANCHOR_GRACE_MS - 1 }));
		expect(young.verdict).toBe("chain-unreachable");
		expect(young.reason).toContain("grace window");
		// A clock behind the anchor's own time reads as age zero, never as a negative age.
		expect(classifyChainEvidence(input({ signatureStatus: "not-found", nowMs: ANCHORED_AT - 10_000 })).verdict).toBe("chain-unreachable");
	});

	test("processed only: young is chain-unreachable, old is signature-missing", () => {
		expect(classifyChainEvidence(input({ signatureStatus: "processed", nowMs: ANCHORED_AT + 1_000 })).verdict).toBe("chain-unreachable");
		const old = classifyChainEvidence(input({ signatureStatus: "processed" }));
		expect(old.verdict).toBe("signature-missing");
		expect(old.reason).toContain("never confirmed");
	});

	test("every verdict is reachable, and only from the closed set", () => {
		const seen = new Set(
			[
				input(),
				input({ observedGenesis: WIPED }),
				input({ observedGenesis: null }),
				input({ signatureStatus: "not-found" }),
			].map((evidence) => classifyChainEvidence(evidence).verdict),
		);
		expect([...seen].sort()).toEqual([...CHAIN_VERDICTS].sort());
	});

	test("malformed input is a TypeError, not evidence", () => {
		expect(() => classifyChainEvidence(input({ expectedGenesis: "" }))).toThrow(TypeError);
		expect(() => classifyChainEvidence(input({ observedGenesis: "" }))).toThrow(TypeError);
		expect(() => classifyChainEvidence(input({ signatureStatus: "finalised" as never }))).toThrow(TypeError);
		expect(() => classifyChainEvidence(input({ nowMs: Number.NaN }))).toThrow(TypeError);
		expect(() => classifyChainEvidence(input({ anchoredAtMs: Number.POSITIVE_INFINITY }))).toThrow(TypeError);
	});
});
