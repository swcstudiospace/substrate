# Runbook — MIRROR-08 live proof for the claim mirror and DoD gate

> **Approval gate.** Nothing below runs without explicit operator approval in
> its own window. Every step writes to real Linear and Notion. The proof
> itself does **not** run in this phase — this runbook only scripts it. No
> live results are recorded here.

| | |
| --- | --- |
| Requirement | MIRROR-08 |
| Prerequisites | `substrate-mcp` running this phase's code (deploy via `infra/vps/deploy-release.sh` and restart); Phase 20 production surface tokens (two surfaces, e.g. hermes + omp); hermes-linear-connector on `:8792`; Linear and Notion writes approved |
| Proof issue | Reuse `SWC-467` and its Agent Task Graph Notion row on a fresh graph (no new issue — the SWC workspace is a Free-plan workspace at its issue cap). The operator confirms first that the issue is unarchived and visible to both the substrate key and the connector. |
| Method | Each step's effect is checked within 60 s by read-only Linear and Notion reads. Record only hosts, ports, key names and booleans here — never values. |

## Sequence

1. **Claim.** Surface A `graph_claim`s the node bound to `SWC-467`.
   Check: Linear shows the first `started` state with `agent:<A>` and one
   `Claimed by` comment; the Notion row shows `Agent = A`.
2. **Refused claim.** Surface B `graph_claim`s the same node.
   Check: refused; Linear and Notion unchanged (a losing claimant writes
   nothing).
3. **Release.** A `graph_release`s.
   Check: Linear shows the first `unstarted` state with no `agent:*`
   labels and no new comment; Notion `Agent` cleared.
4. **Reclaim + heartbeat.** A re-claims (new session), then
   `graph_heartbeat`s.
   Check: one new-session claim comment; the heartbeat changes nothing on
   either tracker.
5. **Complete without DoD.** A `graph_complete`s with no `dod`.
   Check: `dod-required`; Linear shows In Review; the node is
   `started_review` with the lease held; the connector received nothing.
6. **Complete with DoD.** A `graph_complete`s with `dod` (`summary`,
   `tests_pass: true`).
   Check: the connector-approved completion; Linear shows Done (moved by
   the connector, never by this repo); the node is `completed` with the
   lease cleared; Notion shows `Status: Done`, `Linear State: Done`,
   `Completed` dated; the release note carries `payload.dod` with
   `summary_chars`, never the summary text.
7. **Steal.** On a second node, let A's lease lapse and have B claim it.
   Check: the label moves to `agent:<B>` with B's own claim comment.
8. **Force.** An operator `graph_complete`s a third node with `force`.
   Check: labels cleared, Notion `Agent` cleared, Linear state untouched
   (not Done).
9. **Reap.** Let a fourth node's lease lapse and run `coord_reap_leases`.
   Check: the expired mirror (same tracker effect as a release).
10. **Swarm claim.** A swarm surface claims a fifth node.
    Check: exactly one `Claimed by` comment; no state, label or Notion
    change.

## Rollback

Re-run the harness smoke (`bun run smoke:mirror`) to confirm the code
still rehearses clean. If a proof step leaves a tracker in a wrong state,
the operator restores it by hand in Linear/Notion — the mirror never
repairs trackers, it only writes the current decision. No deploy rollback
is needed: the proof changes no code.

## Evidence

Dated readings, newest last. No live results yet.

| Date (UTC) | Issue | Graph | Steps 1–10 | Notes |
| --- | --- | --- | --- | --- |
| — | `SWC-467` (to confirm) | — | NOT RUN | Awaiting operator approval |
