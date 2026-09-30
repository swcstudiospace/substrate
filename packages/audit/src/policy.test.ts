import { describe, expect, test } from "bun:test";
import { FAIL_CLOSED_TOOLS, FAIL_OPEN_TOOLS, auditMode, decideClaim } from "./policy.ts";

describe("auditMode", () => {
	test("reads and events_emit are fail-open", () => {
		// These sit inside a prompt's hook budget. The substrate is not allowed to fail
		// an agent's turn, and an unwritable audit file is not a reason to start.
		for (const tool of ["memory_brief", "memory_search", "graph_get", "events_emit"]) {
			expect(auditMode(tool)).toBe("fail-open");
		}
	});

	test("the claim family and memory_write are fail-closed", () => {
		for (const tool of ["graph_claim", "graph_release", "graph_complete", "graph_register", "memory_write"]) {
			expect(auditMode(tool)).toBe("fail-closed");
		}
	});

	test("an unknown tool is fail-closed", () => {
		// Deny by default, like `assertAppendOnly` in the ledger client: a tool added
		// without a decision about its audit mode is noticed the first time it is
		// called, rather than becoming a permanent hole.
		expect(auditMode("some_new_tool")).toBe("fail-closed");
		expect(auditMode("")).toBe("fail-closed");
	});

	test("the two lists do not overlap", () => {
		for (const tool of FAIL_CLOSED_TOOLS) expect(FAIL_OPEN_TOOLS.has(tool)).toBe(false);
	});
});

describe("decideClaim", () => {
	test("grants a claim whose event reached the ledger", () => {
		expect(decideClaim({ claimed: true, recorded: true, requireRecorded: true })).toEqual({
			decision: "granted",
			reason: null,
			quarantineReason: null,
		});
	});

	test("reports contention when another surface holds the node", () => {
		const verdict = decideClaim({ claimed: false, recorded: true, requireRecorded: true });
		expect(verdict.decision).toBe("contended");
		expect(verdict.quarantineReason).toBeNull();
	});

	test("withdraws a claim whose event did not reach the ledger", () => {
		// The fail-closed half of the chaos scenario. A dropped event costs a line in
		// the trail; a claim whose event dropped costs mutual exclusion — no other
		// agent's brief would show the node as taken, because the brief's recent
		// actions come from the ledger.
		const verdict = decideClaim({ claimed: true, recorded: false, requireRecorded: true });
		expect(verdict.decision).toBe("revoked");
		expect(verdict.quarantineReason).toBe("unrecorded-claim");
		expect(verdict.reason).toContain("withdrawn");
	});

	test("does not require a recording when no ledger is configured at all", () => {
		// Otherwise a local dev run with no ledger URL in its environment would have
		// every claim withdrawn.
		expect(decideClaim({ claimed: true, recorded: false, requireRecorded: false }).decision).toBe("granted");
	});

	test("contention wins over an unrecorded event — there was no claim to withdraw", () => {
		expect(decideClaim({ claimed: false, recorded: false, requireRecorded: true }).decision).toBe("contended");
	});
});
