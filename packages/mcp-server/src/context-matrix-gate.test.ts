import { describe, expect, test } from "bun:test";
import { type CandidateEntry, decidePromotion } from "./context-matrix-gate.ts";

const SHA = "a".repeat(64);
const REALM = "repo:swcstudiospace/agent-substrate";
const CLEAN_BODY = "The gate rejects duplicate writes.";

function entry(overrides: Partial<CandidateEntry> = {}): CandidateEntry {
	return {
		entryId: "entry-1",
		realm: REALM,
		milestone: "M1",
		phase: "P1",
		sourcePath: "docs/decisions.md",
		sourceSha256: SHA,
		entryKind: "decision",
		bodyRedacted: CLEAN_BODY,
		...overrides,
	};
}

describe("decidePromotion", () => {
	test("accepts a valid candidate with no accepted entries as new", () => {
		expect(decidePromotion(entry(), [])).toEqual({ outcome: "accepted", reason: "new" });
	});

	test("denies a candidate with a blank realm, milestone, phase or body as malformed", () => {
		expect(decidePromotion(entry({ realm: "  " }), [])).toEqual({ outcome: "denied", reason: "malformed" });
		expect(decidePromotion(entry({ milestone: "" }), [])).toEqual({ outcome: "denied", reason: "malformed" });
		expect(decidePromotion(entry({ phase: "\t" }), [])).toEqual({ outcome: "denied", reason: "malformed" });
		expect(decidePromotion(entry({ bodyRedacted: "   " }), [])).toEqual({ outcome: "denied", reason: "malformed" });
	});

	test("denies a candidate whose entry kind is not one of the four as malformed", () => {
		const handoff = "handoff" as unknown as CandidateEntry["entryKind"];
		expect(decidePromotion(entry({ entryKind: handoff }), [])).toEqual({ outcome: "denied", reason: "malformed" });
	});

	test("denies a candidate whose sourceSha256 is not 64 lowercase hex as malformed", () => {
		expect(decidePromotion(entry({ sourceSha256: "A".repeat(64) }), [])).toEqual({
			outcome: "denied",
			reason: "malformed",
		});
		expect(decidePromotion(entry({ sourceSha256: "abc" }), [])).toEqual({ outcome: "denied", reason: "malformed" });
	});

	test("denies a candidate with a blank sourcePath as unsourced", () => {
		expect(decidePromotion(entry({ sourcePath: "  " }), [])).toEqual({ outcome: "denied", reason: "unsourced" });
	});

	test("denies a candidate with a blank sourceSha256 as unsourced", () => {
		expect(decidePromotion(entry({ sourceSha256: "" }), [])).toEqual({ outcome: "denied", reason: "unsourced" });
	});

	test("malformed takes precedence over unsourced when both apply", () => {
		expect(decidePromotion(entry({ realm: "", sourcePath: "" }), [])).toEqual({
			outcome: "denied",
			reason: "malformed",
		});
	});

	test("denies a body that carries a credential as secret", () => {
		const body = "ghp_" + "c".repeat(36);
		expect(decidePromotion(entry({ bodyRedacted: body }), [])).toEqual({ outcome: "denied", reason: "secret" });
	});

	test("holds a body that carries personal data as pii", () => {
		const body = "Contact jane.doe@acme-corp.com about the rollout.";
		expect(decidePromotion(entry({ bodyRedacted: body }), [])).toEqual({ outcome: "held", reason: "pii" });
	});

	test("holds a hedged decision as speculative, and accepts a hedged warning", () => {
		expect(decidePromotion(entry({ bodyRedacted: "We probably use the lease index for claims." }), [])).toEqual({
			outcome: "held",
			reason: "speculative",
		});
		expect(decidePromotion(entry({ entryKind: "warning", bodyRedacted: "This might break the poller." }), [])).toEqual({
			outcome: "accepted",
			reason: "new",
		});
	});

	test("holds a body that conflicts with an accepted entry in the same slot", () => {
		const accepted = [entry({ entryId: "old", bodyRedacted: "The gate accepts duplicate writes." })];
		expect(decidePromotion(entry(), accepted)).toEqual({ outcome: "held", reason: "conflict" });
	});

	test("returns already-accepted for an identical body in the same slot", () => {
		const accepted = [entry({ entryId: "old" })];
		expect(decidePromotion(entry({ entryId: "new" }), accepted)).toEqual({
			outcome: "already-accepted",
			reason: "same body",
		});
	});

	test("a conflicting body in another realm does not hold", () => {
		const accepted = [entry({ realm: "repo:swcstudiospace/other", bodyRedacted: "The gate accepts duplicate writes." })];
		expect(decidePromotion(entry(), accepted)).toEqual({ outcome: "accepted", reason: "new" });
	});

	test("an entry of another kind in the same source does not conflict", () => {
		const accepted = [entry({ entryKind: "fact", bodyRedacted: "The gate accepts duplicate writes." })];
		expect(decidePromotion(entry(), accepted)).toEqual({ outcome: "accepted", reason: "new" });
	});

	test("an entry from another source path does not conflict", () => {
		const accepted = [entry({ sourcePath: "docs/other.md", bodyRedacted: "The gate accepts duplicate writes." })];
		expect(decidePromotion(entry(), accepted)).toEqual({ outcome: "accepted", reason: "new" });
	});

	test("does not mutate its arguments", () => {
		const candidate = entry();
		const accepted = Object.freeze([entry({ entryId: "old" })]);
		const before = JSON.stringify({ candidate, accepted });
		decidePromotion(candidate, accepted);
		expect(JSON.stringify({ candidate, accepted })).toBe(before);
	});
});
