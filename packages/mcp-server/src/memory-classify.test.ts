import { describe, expect, test } from "bun:test";
import { classify, passesLuhn } from "./memory-classify.ts";

describe("secrets", () => {
	test("anything the redactor recognises is quarantined, not merely redacted", () => {
		// Redaction is a safety net, not a licence to store the thing it caught: a
		// memory entry whose point was the credential is useless once it is stripped,
		// and the writer needs to hear that rather than find a `[REDACTED]` later.
		const found = classify("the poller needs GITHUB_TOKEN=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "fact");
		expect(found?.reason).toBe("secret");
	});

	test("a reviewer cannot release one", () => {
		expect(classify("password: hunter2", "fact")?.reviewable).toBe(false);
	});

	test("the detail never quotes the match", () => {
		// "matched the GitHub PAT rule" is itself a hint about what was pasted.
		const found = classify("export XAI_API_KEY=xai-aaaaaaaaaaaaaaaaaaaaaaaaa", "fact");
		expect(found?.detail).not.toContain("xai-");
		expect(found?.detail).not.toContain("XAI_API_KEY");
	});

	test("prose about credentials is not a credential", () => {
		expect(classify("credentials live in /etc/substrate/substrate.env, 0600 and root-owned", "fact")).toBeNull();
		expect(classify("rotate the Linear key when the poller 401s", "decision")).toBeNull();
	});
});

describe("PII", () => {
	test("an email address is quarantined, and a reviewer can release it", () => {
		const found = classify("escalate to ove.govender@spectrumweb.example.net", "fact");
		expect(found?.reason).toBe("pii");
		expect(found?.reviewable).toBe(true);
	});

	test("the addresses every repo already contains are not PII", () => {
		// Quarantining a memory for naming the SSH remote or a commit trailer would
		// teach agents to stop recording commit provenance, which is the opposite of
		// what this gate is for.
		expect(classify("the remote is git@github.com:swcstudiospace/agent-substrate.git", "fact")).toBeNull();
		expect(classify("commits are trailered Co-Authored-By: noreply@anthropic.com", "fact")).toBeNull();
		expect(classify("the author shows as 12345+bot@users.noreply.github.com", "fact")).toBeNull();
		expect(classify("use admin@example.com in the fixture", "fact")).toBeNull();
	});

	test("an international phone number is caught", () => {
		expect(classify("reachable on +27 82 555 0134 out of hours", "fact")?.reason).toBe("pii");
	});

	test("a labelled national number is caught", () => {
		expect(classify("phone: 082 555 0134", "fact")?.reason).toBe("pii");
	});

	test("version strings, ports and hashes are not phone numbers", () => {
		// A classifier that fires on `v1.2.3-4567` is one operators switch off.
		expect(classify("bumped to v1.24.3-4567 and it still fails", "fact")).toBeNull();
		expect(classify("substrate-mcp listens on 127.0.0.1:7410", "fact")).toBeNull();
		expect(classify("the chain broke at 1790186361859 on Greptime", "fact")).toBeNull();
		expect(classify("15 nodes across 6 graphs, 256 tests green", "fact")).toBeNull();
	});

	test("a national identifier pattern is caught", () => {
		expect(classify("the record keys on 123-45-6789", "fact")?.reason).toBe("pii");
	});

	test("a payment card is caught, and a long id number that fails Luhn is not", () => {
		expect(classify("the test card is 4242 4242 4242 4242", "fact")?.reason).toBe("pii");
		expect(classify("the invoice id is 4242424242424241", "fact")).toBeNull();
	});

	test("Luhn is what separates a card from any other run of digits", () => {
		expect(passesLuhn("4242424242424242")).toBe(true);
		expect(passesLuhn("4242424242424241")).toBe(false);
		expect(passesLuhn("42424242")).toBe(false); // too short to be a card at all
	});

	test("a bank account number is caught", () => {
		expect(classify("settle to GB82 WEST 1234 5698 7654 32", "fact")?.reason).toBe("pii");
	});
});

describe("speculation", () => {
	test("a hedged decision is a plan, not a decision", () => {
		// The whole value of a decision log is that the next agent can act on it
		// without re-deriving it. "Probably" read as settled is worse than no entry.
		const found = classify("we will probably move the projector to herdr", "decision");
		expect(found?.reason).toBe("speculative");
		expect(found?.reviewable).toBe(true);
	});

	test("a hedged fact is caught too", () => {
		expect(classify("the append failures are likely a Railway proxy timeout", "fact")?.reason).toBe("speculative");
		expect(classify("this is untested against the live ledger", "fact")?.reason).toBe("speculative");
	});

	test("a settled decision phrased in the future tense is not speculation", () => {
		// "we will use X" is how most real decisions are phrased; a rule that catches a
		// bare "will" catches nearly every decision ever written.
		expect(classify("the runtime will be herdr, with Orca alongside", "decision")).toBeNull();
		expect(classify("Greptime is the append-only events ledger and nothing else", "decision")).toBeNull();
	});

	test("the three kinds that are supposed to be about the future are left alone", () => {
		// A todo is *supposed* to describe what has not happened, a handoff describes
		// what is left to do, and a warning that hedges is the warning worth having.
		expect(classify("we will probably need to recreate the table", "todo")).toBeNull();
		expect(classify("hermes should probably pick up n2 next", "handoff")).toBeNull();
		expect(classify("this might break the linear poller", "warning")).toBeNull();
	});

	test("a secret outranks speculation, because only one of them is unreleasable", () => {
		const found = classify("we might switch to GREPTIME_PASSWORD=hunter2 for the smoke run", "decision");
		expect(found?.reason).toBe("secret");
		expect(found?.reviewable).toBe(false);
	});
});

describe("clean text", () => {
	test("an ordinary entry passes", () => {
		expect(classify("agent_events must be in append_mode or the append is refused", "decision")).toBeNull();
		expect(classify("hermes holds n2; omp holds n4", "fact")).toBeNull();
		expect(classify("recreate agent_events before the next backfill", "todo")).toBeNull();
	});
});
