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
	"memory_write",
]);

/**
 * Tools that must never be blocked by the audit.
 *
 * All reads, plus `events_emit`. These sit inside a prompt's hook budget: the
 * substrate is not allowed to fail an agent's turn, and an unwritable audit file is
 * not a reason to start. The call still produces a record — it is just not a gate.
 */
export const FAIL_OPEN_TOOLS: ReadonlySet<string> = new Set([
	"memory_brief",
	"memory_search",
	"events_emit",
	"graph_get",
	"brief",
	"events",
	"verify",
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
 * with no `GREPTIME_URL` would otherwise have every claim withdrawn.
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
