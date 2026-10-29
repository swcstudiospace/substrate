import { describe, expect, test } from "bun:test";
import { FAIL_CLOSED_TOOLS, FAIL_OPEN_TOOLS, auditMode, decideClaim } from "./policy.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 17: the audit decision for every MCP tool v1.3 plans to add, written as a
// literal independent of `policy.ts` so that removing or flipping any entry on
// either side fails the suite.
const PLANNED_V13: ReadonlyArray<readonly [tool: string, mode: "fail-open" | "fail-closed"]> = [
	["skills_propose", "fail-closed"], // Phase 21
	["docs_ingest", "fail-closed"], // Phase 25
	["desktop_run", "fail-closed"], // Phase 30
	["docs_search", "fail-open"], // Phase 25
	["issue_get", "fail-open"], // Phase 23
	["graph_find", "fail-open"], // Phase 23
	["memory_recall", "fail-open"], // Phase 26
	["agent_card", "fail-open"], // Phase 29, REST route
];

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

	test("every read tool this substrate serves is fail-open", () => {
		// The ones that were missing. An unlisted name is fail-closed by default, which is
		// right for a write and wrong for a read: an unwritable audit file refused these
		// while both their backing stores were healthy, so the audit sink failing took out
		// reads it was never meant to gate.
		for (const tool of [
			"events_query",
			"events_verify",
			"memory_pending",
			"coord_handoff_list",
			"coord_handoff_verify",
			"coord_drift_scan",
			"fabric_status",
			"fabric_optimize",
			"fabric_compliance",
			"checkpoint_verify",
			"memory_verify",
			"session_rollback_plan",
			"planning_status",
			"planning_sessions",
			"steering_list",
		]) {
			expect(auditMode(tool)).toBe("fail-open");
		}
	});

	test("the steering writes are fail-closed", () => {
		// A directive changes what a planning session does next, so each write is recorded before it takes effect.
		expect({ queue: auditMode("steering_queue"), acknowledge: auditMode("steering_acknowledge") }).toEqual({
			queue: "fail-closed",
			acknowledge: "fail-closed",
		});
	});

	test("the worktree report is an explicit fail-closed write and the registry read an explicit fail-open read", () => {
		// The report replaces rows other sessions read; a listing is inspection and must not stop on an unwritable audit file.
		expect({ report: auditMode("worktree_report"), list: auditMode("worktree_list") }).toEqual({ report: "fail-closed", list: "fail-open" });
		expect({ reportClosed: FAIL_CLOSED_TOOLS.has("worktree_report"), listOpen: FAIL_OPEN_TOOLS.has("worktree_list") }).toEqual({ reportClosed: true, listOpen: true });
	});

	test("every REST route server.ts audits has a mode", () => {
		// `auditedRest` refuses a route whose record the chain will not take, so a route
		// audited under a name in neither list would be fail-closed by accident — a
		// Prometheus-adjacent read answering 503 because a disk filled.
		for (const [route, tool] of [
			["/brief", "brief"],
			["/events", "events"],
			["/events/query", "events_query"],
			["/verify", "verify"],
			["/drift", "drift"],
			["/evidence", "evidence"],
		]) {
			expect(FAIL_OPEN_TOOLS.has(tool as string)).toBe(true);
			expect(route).toBeDefined();
		}
		// The two action routes are audited under their MCP tools' own names, and inherit
		// those tools' fail-closed mode rather than being listed twice.
		expect(auditMode("memory_write")).toBe("fail-closed");
		expect(auditMode("coord_handoff")).toBe("fail-closed");
	});

	test("the write tools are all fail-closed, explicitly rather than by default", () => {
		// Default-deny catches a tool nobody decided about; it should not be what is
		// carrying the decision for a tool somebody did.
		for (const tool of ["graph_heartbeat", "graph_bind", "coord_handoff", "coord_reap_leases"]) {
			expect(FAIL_CLOSED_TOOLS.has(tool)).toBe(true);
		}
		// A checkpoint is one ledger note, like events_emit, the one write that is fail-open on purpose.
		expect(auditMode("session_checkpoint")).toBe("fail-open");
		expect(FAIL_CLOSED_TOOLS.has("session_checkpoint")).toBe(false);
		// A rollback commit takes memory out of force for every agent that reads it and deletes its plane documents.
		expect(FAIL_CLOSED_TOOLS.has("session_rollback_commit")).toBe(true);
		expect(FAIL_OPEN_TOOLS.has("session_rollback_commit")).toBe(false);
		expect(auditMode("session_rollback_commit")).toBe("fail-closed");
	});

	test("the v1.3 planned tools are explicitly in their decided set", () => {
		// Each planned tool is explicitly in the matching set (not fail-closed by
		// default) and absent from the other; `auditMode` returns the decided mode.
		for (const [tool, mode] of PLANNED_V13) {
			expect(auditMode(tool)).toBe(mode);
			if (mode === "fail-closed") {
				expect(FAIL_CLOSED_TOOLS.has(tool)).toBe(true);
				expect(FAIL_OPEN_TOOLS.has(tool)).toBe(false);
			} else {
				expect(FAIL_OPEN_TOOLS.has(tool)).toBe(true);
				expect(FAIL_CLOSED_TOOLS.has(tool)).toBe(false);
			}
		}
	});

	test("the two lists do not overlap", () => {
		for (const tool of FAIL_CLOSED_TOOLS) expect(FAIL_OPEN_TOOLS.has(tool)).toBe(false);
	});

	test("skills_propose is served on both doors and explicitly fail-closed", () => {
		// It opens a PR other agents receive after merge: a proposal nobody recorded is an
		// unaudited publication. Dropping any one registration fails here, not in production.
		const src = join(import.meta.dir, "..", "..", "mcp-server", "src");
		const mcp = readFileSync(join(src, "mcp.ts"), "utf8");
		const server = readFileSync(join(src, "server.ts"), "utf8");
		expect(mcp).toMatch(/registerTool\(\s*"skills_propose"/);
		expect(server).toMatch(/auditedRest\(\s*res\s*,\s*observability\s*,\s*surface\s*,\s*"skills_propose"\s*,\s*fields\s*\)/);
		expect(FAIL_CLOSED_TOOLS.has("skills_propose")).toBe(true);
		expect(FAIL_OPEN_TOOLS.has("skills_propose")).toBe(false);
		expect(auditMode("skills_propose")).toBe("fail-closed");
	});

	test("skills_approve is served on both doors and fail-closed; skills_list is a fail-open read on both", () => {
		// An approval nobody recorded is an unaudited statement of what is published; the list is read by a sync
		// that an unwritable audit file must not stop.
		const src = join(import.meta.dir, "..", "..", "mcp-server", "src");
		const mcp = readFileSync(join(src, "mcp.ts"), "utf8");
		const server = readFileSync(join(src, "server.ts"), "utf8");
		for (const tool of ["skills_approve", "skills_list"]) {
			expect(mcp).toMatch(new RegExp(`registerTool\\(\\s*"${tool}"`));
			expect(server).toMatch(new RegExp(`auditedRest\\(\\s*res\\s*,\\s*observability\\s*,\\s*surface\\s*,\\s*"${tool}"`));
		}
		expect(auditMode("skills_approve")).toBe("fail-closed");
		expect(auditMode("skills_list")).toBe("fail-open");
		expect(FAIL_CLOSED_TOOLS.has("skills_list")).toBe(false);
		expect(FAIL_OPEN_TOOLS.has("skills_approve")).toBe(false);
	});

	test("every served tool and REST route has an explicit audit decision", () => {
		// A later phase registering a tool with no decision fails here when the
		// suite runs, not the first time the tool is called in production.
		const src = join(import.meta.dir, "..", "..", "mcp-server", "src");
		const mcp = readFileSync(join(src, "mcp.ts"), "utf8");
		const server = readFileSync(join(src, "server.ts"), "utf8");
		const tools = [...mcp.matchAll(/registerTool\(\s*"([^"]+)"/g)].map((m) => m[1] as string);
		const routes = [...server.matchAll(/auditedRest\(\s*\w+\s*,\s*\w+\s*,\s*\w+\s*,\s*"([^"]+)"/g)].map((m) => m[1] as string);
		expect(tools.length).toBeGreaterThan(0);
		expect(routes.length).toBeGreaterThan(0);
		const undecided = [...tools, ...routes].filter(
			(tool) => FAIL_CLOSED_TOOLS.has(tool) === FAIL_OPEN_TOOLS.has(tool),
		);
		expect(undecided).toEqual([]);
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
