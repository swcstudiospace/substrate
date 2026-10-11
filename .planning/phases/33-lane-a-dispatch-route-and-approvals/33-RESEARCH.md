# Phase 33: Lane A dispatch route and approvals - Research

**Researched:** 2026-10-11 (local evidence, read-only unless marked OPERATOR-GATED)
**Domain:** Proving the `dispatch:claude-code` route, completing the approval flow with a timeout, and mapping the label-to-Done chain onto the closed event vocabulary
**Confidence:** HIGH for the route mirror inventory, the host-core entry points, and the approval gap (every file read, line numbers below); MEDIUM for the timeout duration (one auto-accepted default, D33-05); LOW where marked `[UNVERIFIED]`/`[INFERENCE]`

<user_constraints>
## User Constraints (from CONTEXT.md)

Locked: D33-01 (route proven, not rebuilt), D33-02 (no new dispatcher markers), D33-03 (Phase 17 rows only; approvals are counters + logs), D33-04 (timeout is the only new approval behavior), D33-05 (900 s default, env-tunable, injected clock), D33-06 (fake rehearsal, gated real), D33-07 (fully-faked chain proof, gated live tail), D33-08 (three doc updates; no manifest flip in PR).

Claude's discretion: sweep implementation; log wording (values never printed); test layout; smoke script shape.
Out of scope: lease/mirror/DoD changes, new kinds/surfaces, unprivileged user, live boots/installs/flips/quota/writes (all OPERATOR-GATED).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| LANEA-04 | The dispatcher routes `dispatch:claude-code` to `POST /tasks`, and a refusal becomes a once-only Linear comment. [VERIFIED: REQUIREMENTS.md] | Route mirror (§ Route); refusal vocabulary (§ Refusals, additive per D33-02) |
| LANEA-06 | Permission requests reach a human through single-use Approve/Deny buttons on the existing Telegram stop-notify path, and an unanswered request times out rather than waiting forever. [VERIFIED: REQUIREMENTS.md] | Approval flow (§ Approvals); timeout design (§ Timeout); fake-vs-gated (§ Rehearsal) |
| LANEA-08 | Proof (live, approved): `dispatch:claude-code` on a fresh issue opens a VM that claims and heartbeats; restarting `substrate-host` mid-session resumes the same session; a real push and PR land; the PR fields sync; the issue reaches a gated Done. [VERIFIED: REQUIREMENTS.md] | Chain map (§ Chain); gated inventory (§ Gated) |
</phase_requirements>

## Project Constraints (from AGENTS.md)

- Draft PR only; no merge, no auto-merge, no force-push, no branch deletion.
- **No secrets**: never print, commit or echo tokens, keys, passphrases; reference env vars by name only; **do not write tailnet names or internal hostnames into the repo, the PR or the transcript.**
- Every PR goes through the Greptile gate run by Desk Quality; a failed/skipped review is a blocker.
- Repo conventions that bind this phase: `tsconfig.json` includes `packages/**/*.ts` + `scripts/**/*.ts`; store-lock + redact-lock tests (import `redact` only from `packages/mcp-server/src/redact.ts`); closed `EVENT_KINDS` (12); `bun test`, `bunx tsc --noEmit`, `test:py` gates.

<route>
## Route Mirror Inventory (dispatch:hermes → dispatch:claude-code — what already exists)

The claude-code route is the hermes route with the launch step swapped. Everything else is shared:

| Step | hermes (proven, Phase 24) | claude-code (this phase proves) |
|---|---|---|
| Poll | `linear.py` DISPATCH_QUERY: first 50 unstarted issues with `dispatch:*` label — surface-agnostic, no change | same query, `surface == "claude-code"` branch |
| Resolve | `graph_find` under substrate bearer; `no-node`/`already-claimed` markers — surface-agnostic | unchanged |
| Safety gates | `validate_ids` (`invalid-graph-id`/`invalid-ids`), `repo_checkout` (`no-checkout`), 5 GiB floor (`low-disk`), path-conflict, git-failed — all before any launch | unchanged (worktree still prepared for claude-code: `worktree` field of the `POST /tasks` body) |
| Launch | `launcher.launch` → `hermes chat --query-file`, prompt carries token path never value | `HostClient.open_task` → `POST 127.0.0.1:7411/tasks` (`host.py:105-128`); 200/202 → `RemoteTask`, 400/409/502 → `host-refused`, transport/other → `host-unreachable` |
| Watch | `SessionRegistry` reap: landed-claim evidence → success; exit-without-landing → `exited-unclaimed` + label removal + give-up; 900 s → `claim-timeout` + label removal + give-up; cap 2, one per issue; `given_up.json` survives restart | identical — `RemoteTask` serves exactly the Popen subset the reap uses (`poll/terminate/kill`), so the D-14 cap, the claim timeout and the landed-claim rule apply unchanged |
| Comment | once-only `substrate-dispatcher: [<marker>]` tag scan over last 50 | unchanged, same 13 markers (D33-02: no additions) |
| Events | `dispatch.outcome{launched}` / `dispatch.failed{reason}` on Phase 17 rows, fail-open, ids only | unchanged (D33-03) |

Host-core entry points the route lands on (Phase 32, reused untouched): `POST /tasks` → `openTask` (validate → existing → `graphGet` → foreign-claim 409 → `claimAndPersist` → brief → seed read-back → `sessions.open` ask → record → non-awaited `startPrompt` → 202); `GET /tasks/<gid>/<nid>` status reads (`RemoteTask` polls this); heartbeat tick while `turn_in_flight`; `resumeInterrupted` once per boot; single release; `graphComplete` with DoD + `lease_id`.
</route>

<refusals>
## Refusal Markers (additive — D33-02: the 13 stand, nothing added)

`dispatch.py` MARKERS today (D24-04 superset): `not-dispatchable`, `no-node`, `already-claimed`, `invalid-graph-id`, `invalid-ids`, `no-checkout`, `low-disk`, `path-conflict`, `git-failed`, `host-refused`, `host-unreachable`, `exited-unclaimed`, `claim-timeout`. The claude-code pair (`host-refused` retryable-with-comment, `host-unreachable` silent-retry) already behaves correctly pre-host (every candidate gets `host-unreachable` until the G4 restart, `docs/dispatcher.md` "host-unreachable → live transition" — no dispatcher code change at transition).

Approval outcomes need no markers because they resolve below the marker layer: an approval denied/timed-out fails the VM turn closed; the dispatcher only ever sees (a) a task status that never lands a claim → `exited-unclaimed`/`claim-timeout`, or (b) a landed claim → success. The once-only comment + label-removal + give-up semantics for those two markers already match "every non-dispatch says why."
</refusals>

<approvals>
## Approval Flow Design (what exists vs the one gap)

Existing (D-13 floor, verified by read): session emits `permission_request` → `vm.ts onSessionEvent` records (`recordApproval`: dedup by `request_id`, `pending_approvals[]` with tool + timestamp) and posts (`broker.post`: single-use 13-char base32 key, Approve/Deny buttons from `allow_once`/`reject_once` options, 0600 `approvals.json` persist, post failure logged never thrown) → human taps → `handleUpdate` (authorised chat+user check → single-use decode → `respond` → `respondApproval` → `respondPermission` on the VmHandle → markup cleared + `Approved/Denied by <who>`) → `permission_response` → `resolveApproval` clears pending. `main.ts` polls `getUpdates` (30 s long-poll, 409→30 s backoff, error→5 s backoff, offset persisted). Restart moves pending → `stale_approvals` count (they can never be answered — the approver's tap arrives at a dead key, correctly `expired`).

The gap: nothing expires a pending approval. A session parked in `waiting` holds `turn_in_flight`, so `pollCode` returns null forever and (post-landing) the dispatcher reap never fires — the turn waits on a human who may never come. The only backstop is the dispatcher's 900 s claim timeout, which covers only the unlanded case.
</approvals>

<timeout>
## Timeout Design (D33-04/D33-05 — the one new behavior)

- **Semantics:** each `pending_approvals` entry carries `deadlineMs = recorded_at + approvalTimeoutMs`. A sweep finds entries past deadline with no `permission_response` and no `respondApproval` answer, and auto-denies each through the `respondApproval` path: same `respondPermission` call with the deny option, same `approvals_denied` increment, same pending-clearing, plus a `timeout` log line. Deny (not allow) on timeout — fail closed; the turn then fails through the existing turn-failure → single-release path (D32-03).
- **Duration:** default 900 s (`SUBSTRATE_APPROVAL_TIMEOUT_S`, `main.ts` env plumbing), matching lease TTL and claim timeout so the whole system shares one ladder (D33-05). Constructor-injectable timeout + clock on `TaskService`, mirroring `heartbeatIntervalMs` precedent.
- **Sweep trigger:** the heartbeat tick evaluates approval deadlines alongside `heartbeatDue` (both are "while the turn runs" duties), plus an explicit sweep in `resumeInterrupted` ordering (stale approvals from the dead process are counted off first — expiry must not double-count them — then live deadlines arm on the new boot). No separate timer process: one fewer lifetime to leak, and the tick already stops on every settle path.
- **Timeout vs heartbeat interplay:** a turn waiting on approval is still in flight, so heartbeats continue — the lease survives the human's deliberation up to the deadline. After auto-deny the turn fails and releases; no tick outlives the turn (existing tick-clearing covers the new path because it funnels through the same settle).
- **Negative space:** no allow-on-timeout option (standing permission is never offered per D-13); no timeout extension on re-post (one deadline per `request_id`, deduped at record time); timeout never edits Telegram markup beyond what `respondApproval` already drives (the tap-after-timeout reads `expired`, which is the truthful state).
</timeout>

<events>
## Event Mapping in the Closed Vocabulary (D33-03)

| Signal | Row | Kind | Emitted by |
|---|---|---|---|
| claude-code launch decision | `dispatch.outcome{outcome: launched}` | `note` | dispatcher tick (existing D24-12 path) |
| terminal non-dispatch / give-up (`host-refused`, `exited-unclaimed`, `claim-timeout`, …) | `dispatch.failed{reason: <marker>}` | `warning` | dispatcher tick (existing) |
| `host-unreachable`, already-commented skips | nothing | — | (existing silence) |
| approval allowed / denied / timed-out | nothing on the ledger; `approvals_allowed`/`approvals_denied` counters + presence-only log lines | — | host task record |
| heartbeat, resume, sync, PR-field writes | existing Phase 17/32 behavior only | — | host |

No new `EVENT_KINDS`, no new `SURFACES` (loop acts as `substrate`, VM acts as `claude-code` — both registered). A ledger-leak test (planted input text through post → callback → timeout sweep → tick emit) asserts issue/approval text reaches no event body, mirroring the 24 lease-leak test.
</events>

<chain>
## End-to-End Chain Map (LANEA-08 — rehearsal with fakes, live gated)

Rehearsal chain (33-03, one command, all fakes, isolated graph): fake Linear candidate (`dispatch:claude-code`) → dispatcher tick against fake MCP/Linear → `HostClient` against fake host (`POST /tasks` 202) → fake VM `openTask` (claim via fake `claimAndPersist`, seed read-back, ask-policy open) → fake `permission_request` → fake Approve callback → `respondApproval` answered → prompt settles → heartbeat ticks observed → host-side fake commit→push→PR argvs (fixed targets, guest text within caps) → fake tracker PR-field sync → `graph_complete` with DoD + lease → mirror moves `dispatch:*` → `agent:claude-code` (fake) → Done. Mid-chain restart replay: kill the fake service mid-turn → reboot over same dirs → exactly one resume-keyed continuation → fake approval re-posted → chain completes. Refusal replay: fake host 409 → `host-refused` once-only comment; fake host down → `host-unreachable` silent; fake exit-without-claim → `exited-unclaimed` + label removal.

Live tail (all OPERATOR-GATED, executor stops): the same chain with real Linear, real host, real taps, real push/PR, gated Done — see § Gated.
</chain>

<gated>
## Gated Inventory (OPERATOR-GATED — executors stop, never proceed)

| Gate | What | Preconditions | Records to |
|---|---|---|---|
| G1 | Label webhook/poller wiring live: a real `dispatch:claude-code` label on a fresh unstarted issue is polled within one 30 s tick | dispatcher code on `main` serving this phase; operator-approved window; kill switch `0` for the window only | tick log + candidate resolution evidence; kill switch back to `1` after |
| G2 | Real VM dispatch end-to-end: `POST /tasks` 202 → VM claims as `claude-code` + heartbeats (spends Claude Code quota + Docker capacity) | G1 green; `--check` exit 0; 10 GiB floor holds | claim→heartbeat evidence, quota spent |
| G3 | Real approvals: permission requests reach the human channel; Approve continues the turn; Deny fails it closed; an unanswered request auto-denies at the deadline | G2 green; approval bot token + chat + user ids provisioned (names only in repo) | tap evidence + timeout log; no input values recorded |
| G4 | Real Linear/Notion writes: real push + PR land on a throwaway repo; PR fields sync; issue reaches gated Done via `graph_complete` + DoD | G2–G3 green; throwaway repo + isolated graph only | PR URL, sync evidence, Done transition |
| G5 | Production unit activations + manifest flips: `substrate-host.service` G4 restart, `substrate-dispatcher.service` restart, `dormant:24` → `live`, `dormant:31` → `live` flips | G1–G4 green (expected 401s clear on both rows) | `systemctl` evidence + manifest diff + 2xx evidence |

Out of scope even for the tail: pushes/PRs on non-throwaway repos, Linear/Notion writes outside the isolated graph, `RIVET_RUN_ENGINE=1` (refused until the G2 verdict), base-image pulls beyond the G2 window, standing-permission grants.
</gated>

<risks>
## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Auto-deny races a live human tap (timeout fires while the callback is in flight) | LOW | Double answer or lost tap | Single-use key + `inflight` guard already serialize; sweep answers through the same `respondApproval` path, so the loser gets `not_pending`/`expired` — test the race with an in-flight callback + forced expiry |
| Sweep never runs (tick cleared but turn still waiting) | LOW | Timeout theater — waits forever despite the feature | Sweep lives on the heartbeat tick which is armed exactly while `turn_in_flight`; test parks a turn in `waiting` with an expired deadline and asserts auto-deny without any prompt settling |
| Deny-on-timeout strands a landed claim (lease held, turn failed) | MEDIUM | Lease held by a dead turn until TTL | Turn failure funnels into the single release helper (D32-03) — the existing path; test asserts exactly one release after timeout-deny |
| Fake-approval rehearsal diverges from the real Telegram path | LOW | Green rehearsal, broken live | Rehearsal drives the real `ApprovalBroker.handleUpdate` + real `TaskService.respondApproval` with only the transport faked (`fetchImpl`), never stubbing the broker itself |
| G3 tap latency exceeds 900 s (human slower than the deadline) | MEDIUM | Legitimate work auto-denied | Documented operator expectation (taps inside the window); env-tunable per deployment; the denied turn fails closed and resumable, never half-applied |
</risks>

<plan_split>
## Plan Split (3 plans, 2 waves + gated tail)

- **33-01 (wave 1): claude-code route rehearsal (LANEA-04).** Tick → fake-host `POST /tasks` → `RemoteTask` → landed-claim → success; 409 → `host-refused` once-only comment; down → `host-unreachable` silent; exit-without-claim/timeout → give-up paths. Dispatcher tests + dispatcher smoke only; no routing-logic diffs. (pytest)
- **33-02 (wave 1): approval timeout + single-use rehearsal (LANEA-06).** Deadline tracking + expiry sweep + auto-deny through `respondApproval`; `SUBSTRATE_APPROVAL_TIMEOUT_S` plumbing; fake-transport approve/deny/double-tap/unauthorised/timeout/race tests. Host `tasks.ts`/`telegram.ts` (+ tests) + `main.ts` env only. No file overlap with 33-01 → same wave. (bun)
- **33-03 (wave 2, depends on 33-01 + 33-02): fake end-to-end chain + docs + gated tail (LANEA-08).** One-command fake chain incl. mid-chain restart replay + refusal replays; `docs/dispatcher.md` + `lane-a-host.md` + `dispatch-proof.md`; explicit G1-G5 OPERATOR-GATED tail (stops, never runs). Docs + chain script only; no `packages/` logic diffs.
</plan_split>

<open_questions>
## Open Questions — all resolved by auto-accept (no operator input needed)

1. New dispatcher markers for approvals → D33-02 (none; existing paths cover every ending).
2. Approval event emission → D33-03 (none; counters + logs).
3. Timeout duration → D33-05 (900 s default, env-tunable).
4. Sweep mechanism → tick-time sweep (no new timer lifetime).
5. Chain script shape → 33-03 discretion (one command either way).
6. Both manifest flips in the tail → G5 (after G1–G4 green, never in the PR).
</open_questions>
