---
phase: 67-live-steering-ga
verified: 2026-11-06T00:00:00Z
status: human_needed
score: 6 of 6 success criteria passed (5 VERIFIED; criterion 4 PASSED (override): superseded by phase 71, owner acceptance 2026-11-06)
covered_files: [".env.example", ".planning/phases/67-live-steering-ga/67-SUMMARY.md", "docs/live-steering.md", "packages/audit/src/policy.test.ts", "packages/audit/src/policy.ts", "packages/cli/src/index.ts", "packages/cli/src/session/hook-config.test.ts", "packages/cli/src/session/hook-config.ts", "packages/cli/src/session/hook.test.ts", "packages/cli/src/session/hook.ts", "packages/cli/src/session/steering-consumed.ts", "packages/cli/src/session/trigger-policy.ts", "packages/cli/src/steer/client.ts", "packages/cli/src/steer/index.test.ts", "packages/cli/src/steer/index.ts", "packages/cli/src/steer/plain.ts", "packages/cli/src/steer/render.ts", "packages/cli/src/steer/repo.ts", "packages/mcp-server/src/admission.test.ts", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/brief-profile.ts", "packages/mcp-server/src/brief-sessions.test.ts", "packages/mcp-server/src/brief-sessions.ts", "packages/mcp-server/src/brief.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/handoff.ts", "packages/mcp-server/src/index-store.migrate-optin.test.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/live-session-restart.pg.test.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/planning/session-state.ts", "packages/mcp-server/src/planning/steering-rest.ts", "packages/mcp-server/src/planning/steering-sessions-store.ts", "packages/mcp-server/src/planning/steering-tools.ts", "packages/mcp-server/src/planning/steering-waiters.test.ts", "packages/mcp-server/src/planning/steering-waiters.ts", "packages/mcp-server/src/planning/steering.ts", "packages/mcp-server/src/server.steering.test.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/session-context.service.test.ts", "packages/mcp-server/src/session-context.test.ts", "packages/mcp-server/src/session-context.ts"]
covered_digest: "v3:sha256:0188b47f50647237a6b4887db132fa444c4339774f4b804e1639da0024cc3612"
behavior_unverified: 0
overrides_applied: 1
overrides:
  - must_have: "With SUBSTRATE_STEERING_SESSIONS_TABLE on, session state lives in steering_sessions (its own migration step, opt-in like the audit table) and survives a restart; TTL and cap are enforced."
    reason: "Superseded by phase 71 (multi-session boundary): live authority is live_session_bindings (migration 42), not steering_sessions. Owner accepted the supersession on 2026-11-06 and did not reinstate the cap."
    accepted_by: "owner"
    accepted_at: "2026-11-06T00:00:00Z"
re_verification:
  previous_status: passed
  previous_score: "6 of 6 success criteria passed (5 VERIFIED; criterion 4 PASSED (override)) (record 67-VERIFICATION.md at 5e304ef8)"
  gaps_closed: []
  gaps_remaining:
    - "Stale step 37 comment at index-store.ts:767 still describes a boot-time upsert and TTL drop that no longer exist (non-blocking; not edited here)"
    - "ROADMAP.md:1158 (SC4 text) and 67-SUMMARY.md D67-4 (line 29) still describe the superseded mechanism (orchestrator to amend; not edited here)"
    - "Operator-gated: hooks installed and a directive seen reaching a real session (not observable here)"
  regressions: []
gaps: []
deferred: []
behavior_unverified_items: []
coincidental_reliance_items: []
---

# 67-VERIFICATION: Live Steering GA

**Phase goal:** Live Steering is something an operator can see and use, and a session can learn what the other sessions of its repository are doing.
**Verified:** 2026-11-06, at code head 4637a9b7 (worktree `as-gsd-v18-all`, read-only). Supersedes the record at 5e304ef8 (2026-11-06, passed).
**Status:** human_needed. All six criteria pass. The status is not `passed` because the Human verification section below is not empty; `passed` requires that section to be empty.
**Covered list:** 45 files, unchanged from the 5e304ef8 record and identical to the `covered_files` frontmatter, which is the output of `gsd_run query verification.fingerprint .planning/phases/67-live-steering-ga <45 files>` run read-only at 4637a9b7. Digest `v3:sha256:0188b47f50647237a6b4887db132fa444c4339774f4b804e1639da0024cc3612` is the fingerprint's own output, pasted verbatim. It changed from `874422d6…` because `packages/cli/src/index.ts` changed in 4ac770af, the only covered file whose content changed in the window.

## Owner decisions (binding, 2026-11-06)

- **Criterion 4 supersession accepted.** The owner accepts that phase 71 (the multi-session boundary) supersedes criterion 4. Criterion 4 is amended in this record to read: "superseded by phase 71; accepted by owner 2026-11-06".
- The authority that replaced the criterion's mechanism is `live_session_bindings` (mandatory migration 42), with the lease `SUBSTRATE_LIVE_SESSION_LEASE_S` as the TTL. The historical `steering_sessions` table (migration 37, opt-in) has no runtime reader or writer.
- This decision does not reinstate a session cap, and does not amend ROADMAP.md (orchestrator).
- Original criterion wording, kept for traceability (ROADMAP.md:1158, unchanged there): "With `SUBSTRATE_STEERING_SESSIONS_TABLE` on, session state lives in `steering_sessions` (its own migration step, opt-in like the audit table) and survives a restart; TTL and cap are enforced."
- Owner decisions (4) and (5) of 2026-11-06 change no verdict here. Decision (4) (the unreadable mirror config refusal, e2e4cba4) is on the skill-proposal path, not a phase 67 criterion path. Decision (5) (the one stderr line from `substrate emit`, 4ac770af) is on a path no phase 67 criterion reaches (criteria 5 and 6 below).

## Gates and evidence

- Gates not run here. No tests, tsc, lint, formatters, docker or database were run by the verifier. The orchestrator reports a targeted run on the content of 4637a9b7 covering the `packages/cli` session and steer subset and `packages/mcp-server/src/skills/propose.test.ts`; it is not re-run here, and the title-level evidence below comes from the r41 JUnit.
- Source of truth for pass/fail: `/root/src/worktrees/backups/gate-r41-junit.xml` (gate r41, run on b577f5be, before 4ac770af and e2e4cba4). Each of the 34 cited titles is matched as a substring of a testcase name in that file; each matched testcase has no `failure`, `error` or `skipped` child. This includes the `live-session-restart.pg.test.ts` cases. No pass count is claimed here.
- Gate r42 JUnit `/root/src/worktrees/backups/gate-r42-junit.xml` (run on 4637a9b7) is in progress and was not present when this draft was written. The orchestrator confirms it. This draft does not claim its result. Re-check every cited title against it when it lands.
- Each cited title was grep-checked in source at 4637a9b7 (`grep -F` over `packages/`): all 34 exist, and none is missing.
- Two tests added in e958e8b1 (test-only, before a46d42c3) are in the r41 JUnit with no failure child and were checked against the code at head (criterion 3).

## Changes since the last record (5e304ef8 to 4637a9b7) that touch this phase

The window holds five commits: cebd76df and b577f5be (docs), 4ac770af and e2e4cba4 (code), and 4637a9b7 (docs). `git diff --stat 5e304ef8 4637a9b7` lists 20 files. Of the 45 covered files, only `packages/cli/src/index.ts` changed, so the covered digest changed and no other covered file did. Its one hunk was read (below).

- **4ac770af, `packages/cli/src/index.ts`, one hunk (`@@ -235 +235,6 @@`, `cmdEmit`):** when `post` returns null (its `fetch` threw, that is unreachable or timed out) and the event spool is off, `emit` prints one stderr line naming the kind, quoted and capped at 64 characters. It prints no summary or payload. The exit status is unchanged: the `emit` case calls `process.exit(0)` after `cmdEmit` (`index.ts:672` to `674`). A server answer of any status, including 5xx, is a non-null `Response` and prints nothing new. With the spool on, `cmdEmit` returns in the `postEvent` branch (line 223) before `post`, so the line never prints. This is a behaviour change on `substrate emit` only.
- **e2e4cba4, `packages/mcp-server/src/skills/propose.ts` (and its test), `mirrorOriginUrl`:** an unreadable mirror config throws `ProposeFailed` before any Runner call. A behaviour change on the skill-proposal path, not on any phase 67 criterion path. `propose.ts` is not in the covered list. Of the covered files, `agent-card.ts` imports only `SKILL_NAME_RE` from it, and `admission.ts` and `observe.ts` name the `/skills/propose` route and the `skills_propose` tool without importing from it.
- **Docs-only commits** cebd76df, b577f5be and 4637a9b7 change planning records and `.planning/ROADMAP.md`. None is a covered file; `67-SUMMARY.md` is unchanged in the window.
- **Criteria 1 to 4:** every file and line they cite is unchanged in the window (none of those files appears in the diff stat), so their references at 5e304ef8 hold at 4637a9b7.
- **Criteria 5 and 6 (4ac770af path):** no file under `cli/src/session/` or `cli/src/steer/` calls `cmdEmit`, spawns `substrate emit`, or posts to `/events`, and `post` in `index.ts` is module-private. So neither `substrate session hook` nor `substrate steer listen` reaches the stderr line. Their output and exit status are unaffected.
- **Earlier window (a46d42c3 to 5e304ef8):** the export-keyword removals and comment-only additions listed in the 5e304ef8 record are unchanged by this window and stand as written there. None changes a criterion.

## Success criteria

| # | Criterion (ROADMAP Phase 67) | Status | Evidence |
|---|---|---|---|
| 1 | `substrate steer sessions|status|queue|ack|list|listen` work over REST routes with the same audit, admission and operator guard as the MCP tools; agents cannot author directives. | VERIFIED | Routes in `server.ts`: POST and GET `/steering/sessions` (2231, 2247), GET `/steering/directives` (2258), POST `/steering/queue` (2270), POST `/steering/acknowledge` (2282), GET `/steering/wait` (2293). Each is behind `steeringRouteOpen` (720). Operator rule in `steering-tools.ts`. CLI in `cli/src/steer/index.ts` and `client.ts`. Changes checked: export-only in `server.ts` (line 193 to 465 hunks), `steering-tools.ts`, `admission.ts`, `audit/src/policy.ts`, `cli/src/steer/*`. Named passes: server.steering.test.ts "bound nonoperator writes403, operator queue and directive-only ack commit state and honest hint"; "disabled steering routes remain absent rather than creating identities"; "anonymous401 and malformed400 are distinct from denied well-shaped targets"; admission.test.ts "live lifecycle admission is method-aware and shares the mutation tool classes"; audit/policy.test.ts "every live mutation explicitly requires audit; discovery and private reads do not". |
| 2 | `session_context` (MCP tool and `GET /session/context`) returns a bounded, redacted digest of the other live sessions of the caller's repository, each item with its source and age. | VERIFIED | `session-context.ts` (`SESSION_CONTEXT_LIMITS` line 28, `SESSION_CONTEXT_MAX_BYTES` line 30, `SESSION_CONTEXT_TEXT_MAX` line 32); route `GET /session/context` at `server.ts:2323`; MCP tool `session_context` in `mcp.ts:725`. Changes checked: export-only in `session-context.ts` and `mcp.ts`; the route (2323) is outside every changed hunk. Named passes: session-context.test.ts "every list stops at its bound and `truncated` names exactly the lists that lost items"; "past the byte cap the oldest events go first and every other list is left whole"; "a secret-shaped string planted in every free-text field never reaches the digest"; "every item names its source and its age"; server.steering.test.ts "REST and MCP session_context preserve proof-free cross-session metadata and self label"; "digest malformed/anonymous/disabled behavior is unchanged". |
| 3 | `memory_brief` gains `sessions`, `steering` and `handoffs` sections behind `SUBSTRATE_BRIEF_SESSIONS`, within the existing size bound. | VERIFIED | `brief-sessions.ts` (`composeLiveSections`; `BRIEF_SESSIONS_SECTION_MAX_CHARS` = 1,200 at line 26); `service.ts` `liveBriefSections` (4152), which returns `[]` when `SUBSTRATE_BRIEF_SESSIONS` is off and the worktree registry is not on; section ids and priorities in `brief-profile.ts` (lines 46 to 67). Changes checked: `brief-sessions.ts`, `brief.ts`, `session-context.ts`, `handoff.ts` export-only; `brief-profile.ts` export and comment only; `service.ts` change at 6418 is outside `liveBriefSections`. Per-section bounds: brief-sessions.test.ts "sections come in print order: sessions, steering, handoffs"; "a section with many long sessions stays inside 1,200 characters and counts what it left out"; "the steering section is bounded the same way, directive bodies included"; "text another session wrote is redacted before it reaches the brief". Combined bound: session-context.service.test.ts:375 "under a tight compact byte cap, live sections stay within the bound, whole, naming their source and age" (checked against the code at head, below). Flag off: session-context.service.test.ts:394 "with the sessions flag off, live sessions do not change a byte of the brief" (checked against the code at head, below). |
| 4 | superseded by phase 71; accepted by owner 2026-11-06 | PASSED (override) | Amended criterion (owner decision above). Evidence that the replaced mechanism is gone: the `steering_sessions` table exists only as migration 37 (`index-store.ts:766` to 787), opt-in `steering-sessions` (`service.ts:1896` passes `config.steeringSessionsTable`). `git grep steering_sessions` at 5e304ef8 finds no SQL reader or writer outside that migration and the historical-selection flag (`flag-registry.ts:534`). The file header of `planning/steering-sessions-store.ts` (lines 2 to 4) says the table "has no runtime adapter". Live authority: `live_session_bindings` (migration 42, `index-store.ts:882` to 904) through `bunLiveSessionAuthority` (`planning/steering-sessions-store.ts:213`); the lease is `SUBSTRATE_LIVE_SESSION_LEASE_S`, default 3600 s, bounds 60 to 86400 (`config.ts:776` field, `config.ts:1319` parse). No `STEERING_SESSION_CAP` or `STEERING_SESSION_TTL` exists in non-test code; the override does not require one. Restart survival: live-session-restart.pg.test.ts "teardown/reconstruction preserves owner proof, canonical state and terminal tombstone with cache migration off"; "actual migration37 stale rows cannot grant or revive across reconstructed services without a cache adapter" (both present in r38, no failure child). Migration opt-in: index-store.migrate-optin.test.ts "with the opt-in off or absent, migrate() never creates steering_sessions"; "the step is gated, additive and idempotent, and lists only when its opt-in is on". |
| 5 | `substrate session hook` reads `checkpoint_hint` from an acknowledged directive and writes the named checkpoint; a `context` trigger prints the digest; `hook-config` prints all five triggers. | VERIFIED | `cli/src/session/hook.ts` (`checkpoint_hint` handling, line 179 onward), `steering-consumed.ts`, `hook-config.ts` (`HOOK_CONFIG_TARGETS` line 15: claude-code, git-post-commit, steering, baseline, context). None of these four files changed between 5e304ef8 and 4637a9b7. Effect of 4ac770af on this criterion: none. `session hook` is dispatched to `runSession` (`index.ts:792`) and then to `session/hook.ts`; it does not reach `cmdEmit`. `post` (`index.ts:146`) is module-private, and no file under `cli/src/session/` calls `cmdEmit`, spawns `substrate emit` or posts to `/events`. The hook-config targets print only `substrate session hook <trigger>` commands, never `substrate emit`, so the stderr line cannot appear on a hook run and the hook's exit status is unaffected. Named passes (hook.test.ts): "an acknowledged directive with a hint gets exactly the checkpoint it names, with no envelope directive id"; "a second run, with the same hint still listed and the worktree changed, writes no second checkpoint for it"; "a server that is down: the normal steering checkpoint is taken, nothing is consumed, exit 0, nothing on stdout"; "the output is at most 4,000 characters however large the digest is, and says lines were cut". hook-config.test.ts "the targets together cover every trigger `session hook` accepts". |
| 6 | `GET /steering/wait` long-polls for a directive for one session with a bounded timeout; `steer listen` uses it. | VERIFIED | `server.ts` `/steering/wait` (2293; 200 with `wait_ms` and `directive.sequence`, 204 with `x-steering-wait-ms`, 429 busy); `planning/steering-waiters.ts` (`STEERING_WAIT_PER_SESSION_MAX` line 20 exported; `STEERING_WAIT_TOTAL_MAX` line 22, module-private; `nextQueuedDirective` line 63, ordered by inbox sequence); CLI `client.ts` `/steering/wait` (line 525); `steer listen` is dispatched from `case "steer"` (`index.ts:808`) to `runSteer` (`steer/index.ts:261`). None of `server.ts`, `steering-waiters.ts`, `client.ts` or `steer/index.ts` changed between 5e304ef8 and 4637a9b7. Effect of 4ac770af on this criterion: none. The `listen` path does not call `cmdEmit` or `post`, so the stderr line cannot appear there and the exit status is unaffected. Named passes: server.steering.test.ts "already-queued directive returns immediately without registering timer"; "the wait body carries the delivery sequence of the directive it returns"; "queue wakes only the owner's held wait and releases all resources"; "overlong waits clamp to the configured ceiling, with bounded internal timers; invalid timeout holds nothing"; "client abort and server shutdown leave no waiter or timer"; planning/steering-waiters.test.ts "each directive carries its sequence in its own session, and an after cursor walks one session in queue order"; cli steer/index.test.ts "prints a directive that arrives, then with --once stops at the first"; "a server that answers 204 at once is paced, so the loop cannot spin". |

**Score:** 6 of 6 criteria passed: criteria 1, 2, 3, 5 and 6 VERIFIED; criterion 4 PASSED (override), structured owner acceptance under verification-overrides (must_have as above; accepted_by owner; accepted_at 2026-11-06T00:00:00Z). No other override.

### Criterion 3: the two tests added in e958e8b1, checked against the code at head

- **Tight compact cap (session-context.service.test.ts:375).** `compactLiveBrief` sets `SUBSTRATE_BRIEF_COMPACT_BYTES` to the cap, enables `SUBSTRATE_BRIEF_SESSIONS` and the steering flags, and calls `briefDetailed` with profile `compact`. The cap is clamped to `[MIN_COMPACT_BYTES, MAX_COMPACT_BYTES]` = [512, 65,536] (`brief-profile.ts:105`, `:106`), so the caps 512, 640, 800 and 1024 are used as written. The test first asserts all three section titles are present uncapped at 65,536, so it is not vacuous. For each cap it asserts `utf8Bytes(text) <= cap`, that every non-state, non-omitted line appears verbatim in the uncapped brief, that the first line is `[brief: complete]`, and that each section is whole (title present if and only if an item line is present). Age is checked on every session, handoff and pending line. The test also asserts that at least one cap dropped a section, so the bound was exercised. Limits of this check: "whole" means title and items agree, not that every item of a section survived; the source check keys on the fixture's one other session label (`[steering, hermes]`); handoff and directive lines are checked for age only.
- **Flag off (session-context.service.test.ts:394).** The test compares two substrates, both with `SUBSTRATE_BRIEF_SESSIONS` unset (flag off): `off` is built with the live authority present, `absent` is built with `liveSessions` set to `null` (no live authority). It asserts identical `text` and identical `etag`, and that neither the sessions title, the `[steering, hermes]` line, nor the handoffs title appears. A third substrate with the flag on is the control and shows all three. The earlier record described this as "flag unset versus absent"; that wording was wrong. The comparison is live authority present versus absent, with the flag off on both sides. The code path that makes it hold is `liveBriefSections` (`service.ts:4154`): it returns `[]` when the flag is off and the worktree registry is not on.

### Requirements coverage (REQUIREMENTS.md, phase 67)

| Requirement | Status | Evidence |
|---|---|---|
| STEER-01 | SATISFIED | SC1 |
| STEER-02 | SATISFIED | SC2 |
| STEER-03 | SATISFIED | SC3, including the combined-bound test at session-context.service.test.ts:375 |
| STEER-04 | SATISFIED | "Survives a restart" holds through `live_session_bindings`; live-session-restart.pg.test.ts. The requirement text does not name the table; SC4's table wording is superseded (owner decision 2026-11-06) |
| STEER-05 | SATISFIED | SC5 |
| STEER-06 | SATISFIED | SC6 |

No orphaned requirements: REQUIREMENTS.md maps only STEER-01..06 to phase 67.

### Anti-patterns

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| packages/mcp-server/src/index-store.ts | 767 | Stale comment: "The application upserts one row per (surface, session_id) and drops rows past the TTL when it loads them at boot" | Warning | Still present at 4637a9b7 (`index-store.ts` unchanged in the window). Describes behaviour that no longer exists. Not criterion-affecting; not edited here. |

### Probes and spot-checks

- No runnable spot-check was executed (verifier does not run tests). Behavioural evidence is the r41 JUnit named passes above (gate r41, run on b577f5be), plus the code reads at head.
- Migration probe: not applicable (no migration added in the range; step 37 and step 42 are unchanged).

## Human verification (not blocking the status; listed for the owner)

- Real-session delivery: no run has shown a steering directive reaching a real session through the hooks (operator-gated; hooks not installed). Not observed here.

## Gaps summary

No criterion is open. Criterion 4 is superseded by phase 71 and accepted by the owner on 2026-11-06, and is recorded as amended above. The two tests the phase added (criterion 3) are checked against the code at head. The only covered file changed since 5e304ef8 is `packages/cli/src/index.ts`, and its change does not reach a criterion (see the Changes section and criteria 5 and 6). Status is human_needed rather than passed because the Human verification section is not empty. Remaining items are residuals, listed below; none is a criterion gap.

## Open items (non-blocking residuals)

1. Correct the stale step 37 comment at `index-store.ts:767` (not edited here). The comment describes a boot-time upsert and TTL drop that the code no longer performs.
2. `.planning/ROADMAP.md:1158` (SC4 text) and `67-SUMMARY.md` D67-4 (line 29) still describe the superseded mechanism. Orchestrator to amend; not edited here.
3. `docs/live-steering.md:94` now says the retired restart-cache TTL configuration has no reader or example. The earlier artifact is resolved in the doc.
4. The gate r42 JUnit (`/root/src/worktrees/backups/gate-r42-junit.xml`, run on 4637a9b7) is not yet present. Re-check every cited title against it when it lands.
5. Operator-gated: install hooks and see a directive reach a real session (unchanged).

---

_Verified: 2026-11-06_
_Verifier: Claude (gsd-verifier)_
