/**
 * Which calls may proceed unaudited, and when a claim is withdrawn.
 *
 * Two decisions live here, and both are stated as pure functions so the chaos
 * scenario in `chaos.test.ts` can drive them without a store, a socket or a clock.
 */
import type { AuditMode } from "./record.ts";

/**
 * Tools that must not run unrecorded.
 *
 * Everything that grants or transfers exclusive ownership of a node, or writes
 * shared state another agent will act on. A claim nobody recorded is how two agents
 * end up holding one node, and the whole point of `graph_claim` is that they cannot.
 */
export const FAIL_CLOSED_TOOLS: ReadonlySet<string> = new Set([
	"graph_claim",
	"graph_release",
	"graph_complete",
	"graph_register",
	"graph_heartbeat",
	"memory_write",
	"coord_handoff",
	"coord_reap_leases",
]);

/**
 * Tools that must never be blocked by the audit.
 *
 * All reads, plus `events_emit`. These sit inside a prompt's hook budget: the
 * substrate is not allowed to fail an agent's turn, and an unwritable audit file is
 * not a reason to start. The call still produces a record — it is just not a gate.
 *
 * **Every read tool this substrate serves has to be named here.** An unlisted name is
 * fail-closed by default, which is right for a write and wrong for a read: it meant an
 * unwritable audit file refused `events_query`, `events_verify`, `memory_pending`,
 * `coord_handoff_list` and `coord_drift_scan` while both their backing stores were
 * healthy — the audit sink failing took out reads it was never meant to gate, which is
 * the opposite of the stated policy. The two sets below are exhaustive over the tools in
 * `mcp.ts` and the REST routes in `server.ts`, so the default-deny catches only a name
 * this substrate does not serve; `policy.test.ts` pins that, and a tool added without a
 * decision about its audit mode still fails closed the first time it is called.
 */
export const FAIL_OPEN_TOOLS: ReadonlySet<string> = new Set([
	// MCP reads.
	"memory_brief",
	"memory_search",
	"memory_pending",
	"events_query",
	"events_verify",
	"graph_get",
	"coord_handoff_verify",
	"coord_handoff_list",
	"coord_drift_scan",
	// The one write that is fail-open on purpose: an event costs a line in the trail,
	// and refusing the turn over it would make a substrate outage an outage of the host.
	"events_emit",
	// REST routes, named as `server.ts` audits them.
	"brief",
	"events",
	"verify",
	"drift",
	"healthz",
	"metrics",
	"slo",
	"evidence",
]);

/**
 * Deny by default, like `assertAppendOnly` in the ledger client.
 *
 * An unknown tool name is either a typo or a tool added without a decision about
 * its audit mode. Treating it as fail-closed means the second case is noticed the
 * first time it is called, rather than becoming a permanent hole.
 */
export function auditMode(tool: string): AuditMode {
	if (FAIL_OPEN_TOOLS.has(tool)) return "fail-open";
	return "fail-closed";
}

export type ClaimDecision = "granted" | "contended" | "revoked";

export interface ClaimVerdict {
	decision: ClaimDecision;
	/** Why, for a `contended` or `revoked` verdict. Null when granted. */
	reason: string | null;
	/** Set on `revoked`: the reason the quarantine counter is incremented with. */
	quarantineReason: string | null;
}

/**
 * Whether a claim stands.
 *
 * `recorded` is whether the claim's event reached the ledger. A claim that the
 * ledger did not take is **withdrawn**, and this is the fail-closed half of the
 * chaos scenario: with Greptime down, `events_emit` still returns (fail open — the
 * caller gets its normalised event and `stored: false`), but `graph_claim` refuses,
 * because the two failures are not the same failure.
 *
 * A dropped event costs a line in the trail. A claim whose event dropped costs
 * *mutual exclusion*: the claim exists only in the index, no other agent's brief
 * mentions it — the brief's "recent actions" comes from the ledger — and the second
 * agent to arrive sees a node nobody is working on. Granting it would be the
 * substrate handing out a lock it cannot tell anyone about.
 *
 * `requireRecorded` is false when no ledger is configured at all: a local dev run
 * with no ledger URL in its environment would otherwise have every claim withdrawn.
 * This package never reads that variable — only `packages/mcp-server` does, which is
 * what the store lock is there to keep true — so the caller passes the answer in.
 */
export function decideClaim(input: {
	claimed: boolean;
	recorded: boolean;
	requireRecorded: boolean;
}): ClaimVerdict {
	if (!input.claimed) {
		return { decision: "contended", reason: "another surface holds this node", quarantineReason: null };
	}
	if (input.requireRecorded && !input.recorded) {
		return {
			decision: "revoked",
			reason:
				"the claim event did not reach the ledger, so no other agent's brief would show this node as taken; " +
				"the claim was withdrawn rather than held invisibly",
			quarantineReason: "unrecorded-claim",
		};
	}
	return { decision: "granted", reason: null, quarantineReason: null };
}
