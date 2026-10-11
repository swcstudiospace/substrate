# Phase 33: Lane A dispatch route and approvals - Context

**Gathered:** 2026-10-11
**Status:** Ready for planning
**Mode:** Autonomous discuss (no operator round-trip; every decision below is sourced from a locked operator decision, the reviewed research, or a phase contract — nothing invents a user-visible choice). Items needing a live system are marked OPERATOR-GATED in the plans, not resolved here.

<domain>
## Phase Boundary

One PR on agent-substrate (LANEA-04 + LANEA-06 + LANEA-08; the v1.3 FINAL phase). A `dispatch:claude-code` label takes a Linear issue all the way to a gated Done through a Lane A VM, with a human approving each permission request.

1. **Prove, not port.** The route already exists on `main`: the dispatcher tick routes `dispatch:claude-code` through the ported `HostClient` (`dispatch.py:382`, D24-06), and the host already posts every permission request to the Telegram approval broker (`vm.ts:467-485`, D-13 floor). This phase wires the one missing behavior (approval timeout), proves the whole chain with fakes, and gates every live step. No routing module is rewritten; the seams are `tasks.ts` (approval deadlines) + tests + smoke scripts + docs only.
2. **Rehearsal-first, then gated live.** Every behavior is proven with fakes (fake host, fake Telegram, fake Linear/MCP, fake runner/trackers) before any live step. The live end-to-end (real label, real VM, real taps, real push/PR, gated Done) is an OPERATOR-GATED sequence the executor stops at. The human-approval-per-permission design is intrinsic — the route proves end-to-end in rehearsal with fake approvals; the live end-to-end is the gated tail.
3. **Additive everywhere.** Same refusal vocabulary (no new dispatcher markers — approval outcomes surface through the existing `host-refused`/`exited-unclaimed`/`claim-timeout` paths); host lease lifecycle reused untouched (no reimplementation); EVENT_KINDS closed (12, no new kinds); store-lock; v1.3 operator rules (rehearsal-first, live runs wait for approval).

**Depends on code already on `main`:**
- Phase 32: `openTask` claim-via-`claimAndPersist` + heartbeat tick + single release + fenced completion; kill-and-restart rehearsal; bearer scoping; `docs/runbooks/lane-a-host.md` lease/restart/containment sections with L1-L4 gated tail; manifest `substrate-host dormant:31` row.
- Phase 24: dispatcher `HostClient` (`host.py`, loopback `POST /tasks`, `RemoteTask` Popen subset, `host-refused` vs `host-unreachable`), 13-marker refusal vocabulary (D24-04 superset), `given_up.json` persistence (D24-05), `dispatch.outcome`/`dispatch.failed` emission on Phase 17 rows (D24-12), landed-claim rule (D24-15), `docs/dispatcher.md`, `docs/runbooks/dispatch-proof.md`, manifest `dispatcher dormant:24` row.
- Phase 23: lease/DoD model, claim mirror (`dispatch:*` → `agent:<surface>`, `Claimed by <surface> — session <sid>` comment), additive Linear writes.
- Phase 20: identity manifest (`dispatcher dormant:24`, `substrate-host dormant:31` rows), tokens-dir bearer order.
- Phase 17: closed `EVENT_KINDS` (12); `dispatch.outcome` (note/substrate) + `dispatch.failed` (warning/substrate) rows.
- Phase 16: rehearsal harness, staged-unit conventions.

**Out of scope:**
- Any change to the lease engine, the claim mirror, or the DoD gate (Phases 23/32 own them; this phase only drives them).
- Any new `EVENT_KINDS` or `SURFACES` entry; new redaction rules; running the host as an unprivileged user (deferred per D24-10 precedent).
- Production token values (Phase 20 provisioned them by name; this phase only reads token files by name).
- Real VM boots, unit installs/restarts, manifest flips, model quota spend, real Linear/Notion/GitHub writes (all OPERATOR-GATED).
</domain>

<decisions>
## Implementation Decisions

### Route mirror (LANEA-04)
- **D33-01: The `dispatch:claude-code` route is proven, not rebuilt — `HostClient` + tick routing + `RemoteTask` port unchanged.**
  - Sourced: `dispatch.py:382` (claude-code branch posts through the configured host client), `host.py` (`POST /tasks` 200/202 → `RemoteTask`, 400/409/502 → `host-refused`, transport/other → `host-unreachable`), D24-06 (live claude-code dispatch deferred to this phase), `docs/dispatcher.md` ("Live claude-code dispatch is deferred to Phase 33").
  - This phase asserts the wired route end-to-end with a fake host (tick → `POST /tasks` → `RemoteTask` → landed-claim → mirror comment → success; refusal → once-only comment). Any diff to `host.py`/`dispatch.py` routing logic beyond test doubles is out of scope — only tests + smoke scripts change on the dispatcher side.

### Refusal vocabulary and event mapping (LANEA-04/LANEA-08)
- **D33-02: No new dispatcher markers — approval outcomes surface through the existing vocabulary, additively.**
  - Sourced: D24-04 (13-marker superset, "dropping safety refusals to match the list exactly would be scope reduction" — same logic applies in reverse: adding markers without a requirement would widen the user-visible contract), `sessions.py` landed-claim rule (evidence OR timeout/exit paths already cover every VM-task ending).
  - Mapping: host answers 400/409/502 → `host-refused` (retryable, comment once); host unreachable → `host-unreachable` (silent retry); VM task exits without a landed claim → `exited-unclaimed` + label removal + give-up; 900 s without evidence → `claim-timeout` + label removal + give-up. An approval denied or timed out host-side fails the turn closed (D33-04): before landing that yields `exited-unclaimed`; after landing the registry already counts success (the dispatcher's job ends at landed-claim per D24-15). No marker text changes.
- **D33-03: One outcome event per launch decision on the existing Phase 17 rows; approval answers are host-record counters + logs, never new kinds.**
  - Sourced: D24-12 (`dispatch.outcome{outcome: launched}` on launch, `dispatch.failed{reason: <marker>}` on terminal non-dispatch/give-up, fail-open, ids only) + Phase 17 lock (12 kinds) + `tasks.ts` (`approvals_allowed`/`approvals_denied` counters already on the record).
  - Approval allow/deny/timeout increments the existing record counters and logs presence-only lines (`approval answered <allow|deny|timeout> <gid>/<nid> request <id>` — never input values). No `events_emit` for approvals (the ledger learns dispatch fate from the dispatcher rows; per-tap traffic would multiply event volume with no requirement asking for it).

### Approval flow (LANEA-06)
- **D33-04: The single gap is the timeout — posting, single-use buttons, and answering already exist and stay as-is.**
  - Sourced: `vm.ts:467-485` (every `permission_request` → `recordApproval` + `broker.post` with fail-closed log; `permission_response` → `resolveApproval`; "D-13 floor: nothing here ever answers one"), `telegram.ts` (`renderApprovalMessage` picks exactly one Approve (`allow_once`) + one Deny (`reject_once`) button, `encodeCallback` single-use keys, authorised-callback → `respond` → edit markup away + `Approved/Denied by <who>`, double-tap/unauthorised/unoffered → `expired`/`not allowed`/`not offered`), `tasks.ts:818-830` (`respondApproval` is the only answering path, counts allow/deny, clears pending), `main.ts:232-262` (poll loop with 409/5 s backoff, `approvals.json` 0600 state).
  - New behavior only: each pending approval carries a deadline; on expiry the host auto-denies through the `respondApproval` path (counts `approvals_denied`, clears pending, answers the session with the deny option) and logs the timeout. The session's turn then fails closed through the existing turn-failure → release path. Nothing waits forever.
- **D33-05: Approval deadline defaults to 900 s (== lease TTL == claim timeout), tunable by env, injected clock in tests.**
  - Sourced: D24-07 (`CLAIM_TIMEOUT_SECONDS = 900 = DEFAULT_LEASE_TTL_SECONDS`, "the equality is load-bearing, not coincidence") + `tasks.ts:329` (`heartbeatIntervalMs` injectable precedent — "tests inject short values").
  - Grey area (which duration) auto-accepted: 900 s keeps every timeout in the system on one ladder (approval expiry < claim timeout only when the request arrives late in the watch; the dispatcher backstop still bounds the unlanded case). Env name `SUBSTRATE_APPROVAL_TIMEOUT_S`; the TaskService constructor takes an injectable timeout + clock like the heartbeat tick. While a turn waits on an approval it is still in flight, so heartbeats keep ticking (D32-02 unchanged).
- **D33-06: Fake-approval rehearsal proves the human path; real taps are gated.**
  - Sourced: v1.3 run rules (rehearsal-first; live runs wait for operator approval) + `telegram.test.ts` (fake `fetchImpl` precedent) + LANEA-06 ("reach a human ... unanswered times out" — the timeout is the rehearsed half, the human is the gated half).
  - Rehearsal: injected `respond` + fake `TelegramClient` — post → authorised Approve callback → `respondApproval` answered → counters + markup-cleared; Deny → denied; double-tap → `expired` with no second respond; unauthorised user → `not allowed`; unanswered past deadline → auto-deny with no human. Live (gated): real bot token + chat + user ids, real taps, same code path.

### Proof (LANEA-08 rehearsal shape)
- **D33-07: "Label to gated Done" is proven with a fully-faked chain on an isolated graph; the live tail spends everything and is gated.**
  - Sourced: 32-VERIFICATION rehearsal pattern (fake VM + fake substrate on an isolated graph) + 24-VERIFICATION tick pattern (`--once --dry-run` + fakes) + host-core entry points (Phase 32) + route mirror (Phase 24).
  - In-repo proof (33-03): fake Linear label → dispatcher tick → fake-host `POST /tasks` 202 → fake VM claims + heartbeats (Phase 32 machinery, faked) → fake permission request → fake Approve → prompt settles → fake commit→push→PR argvs → fake tracker PR-field sync → `graph_complete` with DoD → Done. Kill-and-restart mid-session (Phase 32 rehearsal) replays inside the chain with the fake approval re-posted after resume. The gated tail (real label round-trip, real VM dispatch, real approvals, real push/PR, production unit activations, manifest flips, gated Done) is an OPERATOR-GATED sequence the executor stops at.

### Docs
- **D33-08:** `docs/dispatcher.md` gains the live claude-code route section (replacing the "deferred to Phase 33" note); `docs/runbooks/lane-a-host.md` gains the approval-timeout row + approvals-channel checklist; `docs/runbooks/dispatch-proof.md` gains the LANEA-08 gated sequence. Neither manifest row (`dormant:24`, `dormant:31`) flips in this phase's PR (both flips are gated steps of the live tail).

### Claude's Discretion
- Exact timeout-sweep implementation (per-request timer vs tick-time sweep), as long as expiry always funnels through `respondApproval` semantics and tests use an injected clock, never wall-clock sleeps.
- Exact approval log wording, beyond never printing input values, bearer values, or `lease_id`s.
- Test layout (extend `telegram.test.ts`/`tasks.test.ts`/dispatcher tests vs new files), as long as every new behavior keeps its tests.
- Smoke script shape (extend `dispatcher-smoke.ts`/`host-smoke.ts` vs one chain script), as long as the full fake chain runs with one command.

### Open for the operator (recommendations the plans use until told otherwise)
1. Approval deadline 900 s, env-tunable (D33-05).
2. Deny-on-timeout (fail closed), never allow-on-timeout (D33-04).
3. Approve the gated live tail (label round-trip, real VM, real taps, real push/PR, unit activations, both manifest flips, gated Done) after the rehearsal half is green.
</domain>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/dispatcher/src/substrate_dispatcher/{dispatch.py:382 (claude-code branch), host.py (HostClient + RemoteTask), sessions.py (registry + landed-claim + given_up.json), linear.py (once-only marker comments)}` — the route to prove, not rewrite.
- `packages/host/src/{vm.ts:467-485 (post-on-request wiring), telegram.ts (broker, single-use keys, 0600 state), tasks.ts (recordApproval/resolveApproval/respondApproval + allow/deny counters + heartbeat tick + single release), main.ts:176-262 (broker construction + poll loop)}` — the approval path to complete with a timeout.
- `scripts/{dispatcher-smoke.ts, host-smoke.ts}` — the rehearsal patterns to extend; `scripts/host-spike.ts --check` — step-0 re-assert for every gated tail.
- `docs/{dispatcher.md, runbooks/lane-a-host.md, runbooks/dispatch-proof.md}` — the docs to finish per D33-08.

### What Is Greenfield
- Approval deadline tracking in `tasks.ts` (deadline per pending approval, expiry sweep, auto-deny through `respondApproval` semantics) + `SUBSTRATE_APPROVAL_TIMEOUT_S` env plumbing in `main.ts`.
- Fake-approval rehearsal tests (approve/deny/double-tap/unauthorised/timeout) with injected `respond` + fake `TelegramClient`.
- End-to-end fake chain script (label → tick → fake host → fake approval → push/PR/sync fakes → complete → Done) with mid-chain restart replay.
- Runbook LANEA-08 gated-tail sequence (label round-trip, real VM, real taps, real push/PR, unit activations, both manifest flips, gated Done).
</code_context>
