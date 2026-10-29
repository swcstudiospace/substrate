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
	"graph_bind",
	"memory_write",
	"coord_handoff",
	"coord_reap_leases",
	// Phase 17: planned v1.3 writes, decided before they ship.
	"skills_propose", // Phase 21: opens a PR other agents receive after merge.
	"skills_approve", // uplift-5 S5a: records which merged skill an operator approved, declined or retired.
	"docs_ingest", // Phase 25: writes a shared dataset every agent reads.
	"docs_steering_session", // SPE-19388: moves a live session's steering state and writes a ledger note.
	"desktop_run", // Phase 30: acts on a desktop (DESK-03).
	// Phase 45 (D45-h): a Railway write changes a live project, so it is recorded before it runs.
	"railway_scale",
	"railway_deploy",
	// Phase 53 (SOTA-09): a steering directive changes what a planning session does next, so it is recorded before it is queued
	// or acknowledged. Each write also answers not-configured, and records nothing, while no audit sink is injected.
	"steering_queue",
	"steering_acknowledge",
	// v1.6 (phase 61): a rollback commit takes memory other agents read out of force and deletes its plane documents (nearest: `memory_write`),
	// so an unrecorded one is refused; the client keeps it in its pending journal and delivers it later.
	"session_rollback_commit",
	// v1.7 (phase 63): a corpus ingest writes the shared docs dataset every agent reads and deletes plane documents (nearest: `docs_ingest`).
	"corpus_ingest",
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
 * the opposite of the stated policy. The two sets below cover the served tools in
 * `mcp.ts` and the REST routes in `server.ts` plus the v1.3 planned tools marked
 * by phase, so the default-deny catches only a name this substrate does not serve;
 * `policy.test.ts` pins that, and a tool added without a decision about its audit
 * mode still fails closed the first time it is called.
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
	"skills_list", // uplift-5 S5a: a read of the skills registry, like `memory_search`.
	// Phase 45 (D45-h): Railway reads. Inspection only; a read must not stop on an unwritable audit file.
	"railway_list",
	"railway_monitor",
	"railway_scale_suggest",
	"railway_cost",
	// Phase 51 (SOTA-07): fabric reads. A status, an optimisation list and a compliance report are inspection only.
	"fabric_status",
	"fabric_optimize",
	"fabric_compliance",
	// Phase 52 (SOTA-08): planning reads. An index or a presence listing is inspection only: both reads write nothing, and a failed
	// read answers typed, so a planning outage must not refuse the turn. Writes come from the server's planning observer, not a read.
	"planning_status",
	"planning_sessions",
	// Phase 53 (SOTA-09): the steering read. The directives for one session, queued or acknowledged, are inspection only.
	"steering_list",
	// Phase 67 (live steering GA): the cross-session digest. A bounded, redacted read of presence, claims and the ledger; it writes nothing.
	"session_context",
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
	// Phase 17: planned v1.3 reads, decided before they ship.
	"docs_search", // Phase 25: a read inside an agent's turn.
	"issue_get", // Phase 23: a read of untrusted tracker text.
	"graph_find", // Phase 23: a read of the index.
	"memory_recall", // Phase 26: a read like `memory_search`.
	"agent_card", // Phase 29: the Agent Card REST route is a read.
	// SPE-19388: RAG plane reads, served as an MCP tool and a REST route under one name.
	"docs_lightrag_query", // A read of the LightRAG plane, like `docs_search`.
	"docs_rag_state", // A read of the in-process RAG state machine, like `docs_search`.
	// v1.6 (phases 59 and 60): anchor verification reads. They read the ledger and devnet and write nothing, like `events_verify`.
	"checkpoint_verify",
	"memory_verify",
	// v1.6 (phase 61): session rollback. The plan is a read. A checkpoint is one ledger note, the nearest write to `events_emit`:
	// the client journals an unrecorded checkpoint and re-offers it, so an unwritable audit file must not fail the agent's turn over it.
	"session_rollback_plan",
	"session_checkpoint",
	// v1.7 (phase 63): the corpus manifest status and plan are reads of the index, like `planning_status`.
	"corpus_status",
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
