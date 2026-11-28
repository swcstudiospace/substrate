/**
 * Phase 100 (F1) fake tests: the unified T0 data-plane contract.
 * Pure module — no server, no I/O.
 */
import { describe, expect, test } from "bun:test";
import { authorizeT0Read, authorizeT0Supersede, authorizeT0Write, isT0Kind, T0_KINDS, validateT0Provenance } from "./t0-provenance.ts";

const SHA = "b".repeat(64);
const PROVENANCE = { worktree: "/tmp/wt-a", project: "agent-substrate", agent: "substrate", session: "planning-refresh", event: "planning-changed", content_hash: SHA };

describe("isT0Kind", () => {
	test("covers Tools, Skills, Memory, Context, Lessons and Teachable Moments", () => {
		expect([...T0_KINDS].sort()).toEqual(["context", "lesson", "memory", "skill", "teachable-moment", "tool"]);
		expect(isT0Kind("memory")).toBe(true);
		expect(isT0Kind("wiki")).toBe(false);
		expect(isT0Kind(null)).toBe(false);
	});
});

describe("validateT0Provenance", () => {
	test("accepts complete provenance with an agent and no session", () => {
		const { session: _dropped, ...agentOnly } = PROVENANCE;
		expect(validateT0Provenance("memory", agentOnly)).toEqual({ ok: true });
	});

	test("accepts complete provenance with a session and no agent", () => {
		const { agent: _dropped, ...sessionOnly } = PROVENANCE;
		expect(validateT0Provenance("lesson", sessionOnly)).toEqual({ ok: true });
	});

	test("rejects an unknown kind, never a silent default", () => {
		const outcome = validateT0Provenance("note", PROVENANCE);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.code).toBe("t0.unknown-kind");
	});

	test("rejects missing provenance with every missing field named", () => {
		const outcome = validateT0Provenance("tool", { worktree: " ", project: "p", event: "", content_hash: "zzz" });
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.code).toBe("t0.provenance-missing");
			expect(outcome.missing).toEqual(expect.arrayContaining(["worktree", "agent/session", "event", "content_hash"]));
		}
		const absent = validateT0Provenance("skill", null);
		expect(absent.ok).toBe(false);
	});

	test("a malformed hash is missing provenance, not a match", () => {
		const outcome = validateT0Provenance("context", { ...PROVENANCE, content_hash: SHA.toUpperCase() });
		expect(outcome.ok).toBe(false);
	});
});

describe("authorizeT0Write", () => {
	test("validates kind and provenance together", () => {
		expect(authorizeT0Write({ kind: "memory", provenance: PROVENANCE })).toEqual({ ok: true });
		expect(authorizeT0Write({ kind: "memory", provenance: null }).ok).toBe(false);
	});
});

describe("authorizeT0Read", () => {
	test("allows same-scope reads", () => {
		expect(authorizeT0Read({ kind: "memory", recordScope: "repo:a/b", requesterScope: "repo:a/b" })).toEqual({ ok: true });
	});

	test("default-denies cross-scope reads without an explicit shared-scope flag", () => {
		const outcome = authorizeT0Read({ kind: "memory", recordScope: "repo:a/b", requesterScope: "repo:c/d" });
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.code).toBe("t0.scope-denied");
	});

	test("allows cross-scope reads with sharedScope: true", () => {
		expect(authorizeT0Read({ kind: "context", recordScope: "global", requesterScope: "repo:a/b", sharedScope: true })).toEqual({ ok: true });
	});

	test("rejects blank scopes and unknown kinds", () => {
		expect(authorizeT0Read({ kind: "memory", recordScope: "", requesterScope: "repo:a/b" }).ok).toBe(false);
		expect(authorizeT0Read({ kind: "nope", recordScope: "global", requesterScope: "global" }).ok).toBe(false);
	});
});

describe("authorizeT0Supersede", () => {
	test("allows a supersede that names the current hash with valid provenance", () => {
		expect(authorizeT0Supersede({ kind: "lesson", provenance: PROVENANCE, supersedes: SHA, currentHash: SHA })).toEqual({ ok: true });
	});

	test("rejects a stale supersede and invalid provenance", () => {
		const stale = authorizeT0Supersede({ kind: "lesson", provenance: PROVENANCE, supersedes: "a".repeat(64), currentHash: SHA });
		expect(stale.ok).toBe(false);
		if (!stale.ok) expect(stale.code).toBe("t0.supersede-mismatch");
		expect(authorizeT0Supersede({ kind: "lesson", provenance: null, supersedes: SHA, currentHash: SHA }).ok).toBe(false);
	});
});
