---
phase: 01-lane-b
plan: 07
subsystem: infra
tags: [mcp, omp-ultrathink, substrate-mcp, memory_brief, events_emit, streamable-http, discovery]

# Dependency graph
requires:
  - phase: 01-lane-b
    provides: "01-01's substrate-mcp service (memory_brief/events_emit tools, EVENT_KINDS/SURFACES closed unions, brief.delivered pattern) and 01-02's kind:\"uplift\" -> kind:\"prompt\" precedent for the closed EVENT_KINDS enum"
provides:
  - "omp-ultrathink/config.ts — substrateMcp config block (url, tokenEnv SUBSTRATE_TOKEN, tokenFile /etc/substrate/substrate.env, prefixes memory_/events_/graph_), optional field + substrateMcpConfig() helper"
  - "omp-ultrathink/index.ts — substrateEndpoint McpEndpoint + a second UltrathinkMcpClient, connected/closed alongside the primary and Greptile clients, threaded into runAutonomousDiscovery"
  - "omp-ultrathink/swe.ts — memory_brief queued ahead of the existing 3-call discovery budget when available; emitUpliftEvent posts one events_emit call (kind:\"prompt\", uplift specifics in payload) after discovery, fail-open"
  - "omp-ultrathink/swe.test.ts — 7 new behaviors covering availability gating, budget-cap priority, inert-without-substrate, error handling, clipping, events_emit fields, fail-open on rejection"
  - "Live proof (this plan's Task 3): the real substrateMcp client, hitting the real running substrate-mcp service, produces real <discovery> brief content naming another surface's work, and its events_emit call is independently visible in a subsequent /brief query"
affects: [phase-1-success-criterion-4, omp-ultrathink-swe-workflow, any-future-plan-touching-substrate-mcp-EVENT_KINDS-or-omp-discovery-budget]

# Actuals (#2632)
actuals:
  tokens: 5365
  tasks: 3
  commits: 2
plan_head_before: 3c8c2ec9998e5f326ac9a01c8e7c8ccdc7d6e534

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Cross-agent brief consumption: an Omp-side MCP client queries a first-party local substrate over loopback and injects the result into the model's uplift XML as read-only discovery context, no different in shape from the existing GitHub/Linear discovery calls."
    - "Cross-agent event emission: the same discovery pass that reads the brief also writes one summarizing event back, closing the loop so a surface is both a consumer and a producer of the shared event/memory store."
    - "Trailing-optional parameter for cross-cutting client injection: when a function already has an established, externally-called signature that this plan does not own the callers of, add the new dependency as the LAST, optional parameter rather than inserting it earlier — preserves every existing positional call site's typecheck."
    - "kind:\"uplift\" does not exist in substrate-mcp's closed EVENT_KINDS enum; every emitting surface in Lane B (01-02, and now 01-07) uses kind:\"prompt\" with the uplift specifics carried in payload instead."

key-files:
  created:
    - /root/src/repos/omp-ultrathink/swe.test.ts
  modified:
    - /root/src/repos/omp-ultrathink/config.ts
    - /root/src/repos/omp-ultrathink/index.ts
    - /root/src/repos/omp-ultrathink/swe.ts
    - /root/src/repos/omp-ultrathink/package.json

key-decisions:
  - "kind:\"uplift\" -> kind:\"prompt\": substrate-mcp's EVENT_KINDS (packages/mcp-server/src/types.ts) is a closed zod enum with no \"uplift\" member. Since events_emit is fail-open by design (a rejection is swallowed so an emit never blocks a prompt), following the plan's literal kind:\"uplift\" text would have made every single emit silently fail server-side validation. Followed the exact precedent already set and documented by sibling plan 01-02 (hermes-plugin, identical defect): kind:\"prompt\", with the uplift-specific details (repo, branch, graph_id, discovered tool names) carried in payload."
  - "substrateMcp appended as the LAST, optional parameter of runAutonomousDiscovery (after signal?) rather than inserted earlier in the required-parameter list. An untracked, not-owned file in this checkout (mcp-bind-timeout.test.ts, belonging to another concurrent session) calls this function with its original 4-argument shape; inserting a new required parameter earlier broke that caller's typecheck (TS2554) with no way to fix it without touching a file this plan does not own and must not touch. Appending it as trailing-optional keeps that call valid and adds zero new tsc errors — verified via an isolated /tmp scratch-copy diff against the pre-existing 52-error baseline (byte-identical signature, confirmed twice: once for Task 1's config/index.ts change, once for Task 2's swe.ts change)."
  - "graphId left as an always-undefined optional field on DiscoverySnapshot: no graph-id-minting subsystem exists anywhere in omp-ultrathink today (confirmed via grep for randomUUID/graph.id/graphId), consistent with the graph_id: str | None = None optional pattern already established across the rest of Lane B phase 1. The field exists so a future graph-id source can attach without another signature change."
  - "Used swcstudiospace/agent-substrate (this project's own repo) as the live-verify target in Task 3, not omp-ultrathink itself — querying POST /brief for swcstudiospace/omp-ultrathink returned \"No substrate history for this repo yet\", while swcstudiospace/agent-substrate already had five recorded commit events from the \"cursor\" surface (01-06 plan work), satisfying the task's own precondition (\"the substrate has at least one recorded event for the repo used in the check\") and giving unambiguous cross-surface content to look for."

patterns-established:
  - "Pattern: when a plan text names an events_emit `kind` value, verify it against substrate-mcp's actual EVENT_KINDS source before implementing — the enum is closed and every rejection is silent (fail-open by design). Two Lane B plans (01-02, 01-07) have now independently hit this; a future plan revision could correct the template text once rather than each plan rediscovering it."
  - "Pattern: when adding a parameter to a widely-called internal function inside a shared, multi-session checkout, check for untracked/not-owned callers before choosing where in the signature it goes — a trailing optional parameter is almost always safe against a caller you cannot edit; an earlier required one is not."

requirements-completed: [SC-4]

coverage:
  - id: D1
    description: "Omp registers substrate-mcp as a second MCP endpoint (config.ts substrateMcp block, index.ts substrateEndpoint + client, connected/closed alongside the existing clients) and can list its memory_/events_/graph_ tools"
    requirement: "SC-4"
    verification:
      - kind: integration
        ref: "live-verify script (Task 3): real UltrathinkMcpClient against real substrate-mcp resolves connected:true and selectTools() returning [memory_brief, memory_write, memory_search, events_emit, graph_get, graph_register, graph_claim, graph_release, graph_complete]"
        status: pass
    human_judgment: false
  - id: D2
    description: "runAutonomousDiscovery calls memory_brief ahead of the existing 3-call budget cap when available, its result lands in toolResults/formatDiscovery output (the exact text that becomes the uplift XML's <discovery> section), and the call is inert (no crash, no stall) when substrate-mcp is unreachable"
    requirement: "SC-4"
    verification:
      - kind: unit
        ref: "swe.test.ts#issues memory_brief when the substrate client reports it available, and its text lands in toolResults"
        status: pass
      - kind: unit
        ref: "swe.test.ts#is not squeezed out by the calls.slice(0, 3) budget cap when three other calls are also available"
        status: pass
      - kind: unit
        ref: "swe.test.ts#is inert when the substrate client reports no tools — output matches the no-substrate baseline"
        status: pass
      - kind: unit
        ref: "swe.test.ts#records a rejected memory_brief call as ok:false and still runs the other discovery calls"
        status: pass
      - kind: unit
        ref: "swe.test.ts#clips brief text to the same order of size as the other non-Linear discovery results"
        status: pass
      - kind: integration
        ref: "Task 3 live-verify RUN 1 (substrate-mcp active, systemctl): formatDiscovery() output contained \"mcp memory_brief (ok): ## Substrate brief: swcstudiospace/agent-substrate @ main ... 12:09 cursor commit a40b13a docs(01-06)...\" — real brief content naming another surface's (cursor's) work, elapsed 790ms"
        status: pass
      - kind: integration
        ref: "Task 3 live-verify RUN 2 (systemctl stop substrate-mcp, verified inactive + healthz 000 first): discovery completed in 32ms with no crash and no added stall, then systemctl start substrate-mcp restored, healthz confirmed 200 again"
        status: pass
    human_judgment: false
  - id: D3
    description: "runAutonomousDiscovery emits one events_emit call after discovery (kind:\"prompt\", repo/branch/graph_id, uplift specifics in payload), fail-open on rejection, making Omp a writer as well as a reader"
    requirement: "SC-4"
    verification:
      - kind: unit
        ref: "swe.test.ts#emits one events_emit call after discovery, carrying repo, branch and graph id"
        status: pass
      - kind: unit
        ref: "swe.test.ts#returns the discovery snapshot unchanged when the events_emit call rejects"
        status: pass
      - kind: integration
        ref: "Task 3 live-verify RUN 1: a subsequent POST /brief for swcstudiospace/agent-substrate showed a new top entry \"12:45 omp Omp autonomous discovery for swcstudiospace/agent-substrate\" that was not present before the run"
        status: pass
    human_judgment: false
  - id: D4
    description: "Literal product-level human-check: start the real Omp CLI in a repo with recent substrate activity, send an implementation-shaped prompt, and read the uplift XML's <discovery> section in the actual chat transcript (not a direct library call)"
    verification: []
    human_judgment: true
    rationale: "Attempting `pi -e /root/src/repos/omp-ultrathink/index.ts ...` (both from omp-ultrathink's own directory and via absolute path) failed at pi's own extension loader with `Error: Failed to load extension ... The \"path\" argument must be of type string. Received undefined` — confirmed unrelated to this plan's code (plain `pi -ne` with no extensions works fine; bun test and bunx tsc --noEmit both load index.ts/swe.ts/config.ts cleanly). This is a pre-existing pi CLI/environment defect, out of scope per the no-repair rule (D-03) and the file-scope boundary (pi's extension loader is neither omp-ultrathink nor agent-substrate source). Substituted the strongest available equivalent: a throwaway script (deleted after use) that imports the real swe.ts/mcp-client.ts/config.ts and drives the exact same runAutonomousDiscovery -> formatDiscovery code path index.ts's own input handler uses (index.ts:746-753), against the real running substrate-mcp service — see D2/D3 for what that proved. A human should still confirm the literal CLI/chat-transcript experience once the pi extension-loader defect is fixed or worked around (e.g., via `pi install ./local/path`, not attempted here since it mutates global pi settings outside this plan's file scope)."

# Metrics
duration: ~23min (measured from Task 1's commit timestamp, 12:24:14Z, to this SUMMARY, 12:47Z, in this resumed/continued session; earlier planning and research work preceding that window is not separately timestamped)
completed: 2026-09-24
status: complete
---

# Phase 1 Plan 07: Omp <-> substrate-mcp bridge Summary

**Omp-ultrathink registers substrate-mcp as a second MCP endpoint and wires `memory_brief`/`events_emit` into `runAutonomousDiscovery`, proven live against the real running service: a real discovery pass surfaced another surface's ("cursor") recent commits in the uplift `<discovery>` text, the matching `events_emit` call landed as a new entry in a follow-up brief query, and stopping/restarting the real `substrate-mcp` systemd unit showed the call degrades to a fast no-op rather than a stall.**

## Performance

- **Duration:** ~23 min (see Metrics note above)
- **Started:** 2026-09-24T12:24:14Z (Task 1 commit)
- **Completed:** 2026-09-24T12:47:12Z
- **Tasks:** 3/3
- **Files modified:** 5 (1 created, 4 modified) across omp-ultrathink

## Accomplishments
- `omp-ultrathink` now speaks to `substrate-mcp` (`http://127.0.0.1:7410/mcp`) as a second, independently connected/closed MCP endpoint, gated on `memory_`/`events_`/`graph_` tool prefixes.
- `runAutonomousDiscovery` queues `memory_brief` ahead of the existing three-call discovery budget when the substrate client is connected and exposes it — so the brief cannot be silently squeezed out on exactly the implementation-shaped prompts where it matters.
- After discovery, `emitUpliftEvent` posts one `events_emit` call (fail-open) so Omp is a writer to the shared event store, not only a reader.
- Both directions verified against the real, running `substrate-mcp` systemd service — not only against test stubs — including a real stop/restart cycle proving graceful degrade.

## Task Commits

Each task was committed atomically:

1. **Task 1: Register substrate-mcp as a second Omp MCP endpoint** - `18cf205` (feat)
2. **Task 2: Wire memory_brief + events_emit into runAutonomousDiscovery** - `0d0d017` (feat, tdd)
3. **Task 3: Prove the brief reaches an Omp prompt on the running install** - no new commit (Task 1 + Task 2's commits already satisfy the ≤5-path, `swe.ts`-present acceptance criterion checked against `HEAD`); live verification performed and documented below.

**Plan metadata:** (this commit, agent-substrate repo — see final commit below)

_Note: Task 2 carried `tdd="true"`; its RED/GREEN work (writing `swe.test.ts` alongside the implementation) landed in a single commit rather than separate test/feat commits, consistent with how this session's prior Lane B plans handled `tdd="true"` tasks that were implemented and tested together before the first commit._

## Files Created/Modified
- `/root/src/repos/omp-ultrathink/config.ts` - `substrateMcp` config block (interface, `DEFAULTS`, `loadConfig`), optional field, `substrateMcpConfig()` helper, `resolveSubstrateToken()`
- `/root/src/repos/omp-ultrathink/index.ts` - `substrateEndpoint: McpEndpoint` + second `UltrathinkMcpClient`, connect/close lifecycle, threaded into the `input` handler's `runAutonomousDiscovery` call
- `/root/src/repos/omp-ultrathink/swe.ts` - `memory_brief` queued into discovery ahead of the budget cap; `emitUpliftEvent()` posts `events_emit` after discovery; `substrateMcp` trailing-optional parameter
- `/root/src/repos/omp-ultrathink/swe.test.ts` - 7 new behaviors (created)
- `/root/src/repos/omp-ultrathink/package.json` - added `swe.test.ts` to the `test` script

## Decisions Made
See `key-decisions` in frontmatter for full rationale. Summary: `kind:"uplift"` corrected to `kind:"prompt"` (closed enum, following 01-02's precedent); `substrateMcp` parameter placed trailing-optional (protects an untracked, not-owned caller); `graphId` left optional/undefined (no minting subsystem exists yet); Task 3's live-verify repo chosen as `agent-substrate` itself (had recorded substrate history, satisfying the task's stated precondition).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `kind:"uplift"` is not a member of substrate-mcp's closed EVENT_KINDS enum**
- **Found during:** Task 2 (implementing `emitUpliftEvent`)
- **Issue:** The plan's text specifies `kind: "uplift"` for the `events_emit` call. `packages/mcp-server/src/types.ts`'s `EVENT_KINDS` is a closed zod enum with no `"uplift"` member. Because the call is deliberately fail-open (a rejection is swallowed so an emit never blocks a prompt), every single emit would have failed server-side validation silently — defeating the plan's own goal of making Omp a real writer, not just a reader.
- **Fix:** Changed to `kind: "prompt"`, carrying the uplift specifics (`uplift: true`, discovered tool names) in `payload`, following the identical fix already made and documented by sibling plan 01-02 (hermes-plugin).
- **Files modified:** `swe.ts`
- **Verification:** `swe.test.ts`'s events_emit tests assert `emit?.args.kind === "prompt"`; Task 3's live-verify confirmed a real `events_emit` call landed and was independently visible in a follow-up `/brief` query.
- **Committed in:** `0d0d017` (Task 2 commit)

**2. [Rule 3 - Blocking] New tsc error (TS2554) in an untracked, not-owned file from an earlier required-parameter insertion**
- **Found during:** Task 2 (first implementation pass, before settling on the final signature)
- **Issue:** Inserting `substrateMcp` as the 3rd required positional parameter of `runAutonomousDiscovery` broke `mcp-bind-timeout.test.ts` (untracked, belongs to another concurrent session, must not be edited), which calls the function with its original 4-argument shape. `bunx tsc --noEmit` went from the 52-error baseline to 53 errors, a genuine new failure attributable to my change in a file outside my scope to fix.
- **Fix:** Redesigned the signature to append `substrateMcp` as the LAST, optional parameter (after `signal?`), which keeps the old 4-argument call valid. Updated the function body's substrate-usage guards (`substrateMcp?.selectTools() ?? []`, `if (substrateMcp) ...`) accordingly, and updated `index.ts`'s call site and all 7 call sites in `swe.test.ts`.
- **Files modified:** `swe.ts`, `index.ts`, `swe.test.ts`
- **Verification:** Re-ran `bunx tsc --noEmit` inside an isolated `/tmp` scratch copy and diffed against a freshly re-established Task 1 baseline (52 pre-existing errors, all in untracked/not-owned files: native-tools.ts, swarm.ts, mcp-tools.ts, mcp-server.ts, lsp-tools.ts, skill-hub.ts, mcp-bind-timeout.test.ts) — byte-for-byte identical error signature after the fix, zero new, zero removed.
- **Committed in:** `0d0d017` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 bug/Rule 1, 1 blocking/Rule 3)
**Impact on plan:** Both fixes were necessary for correctness (a silently-failing event emit would have defeated the plan's own success criterion) and for not violating the shared-checkout constraint (never edit another session's untracked files). No scope creep beyond the plan's own `files_modified` list plus the already-anticipated `index.ts` call-site touch.

## Issues Encountered

- **`pi -e <path>` extension loading failed** with `Error: Failed to load extension ... The "path" argument must be of type string. Received undefined`, reproduced both from `omp-ultrathink`'s own directory and via absolute path; a bare `pi -ne` (no extensions) with the same provider/model succeeds, and `bun test` / `bunx tsc --noEmit` both load `index.ts` cleanly — isolating the failure to `pi`'s own extension-loading CLI mechanism, unrelated to this plan's code changes and outside its file scope (no-repair rule, D-03). Recorded as coverage item D4 (`human_judgment: true`) and logged to `WINDOWS.md` as an `unrun-verify` entry, since the plan's literal `<human-check>` (start Omp, send a prompt, read the chat transcript) could not be executed this way. Substituted the strongest available equivalent: a throwaway script driving the real `runAutonomousDiscovery`/`formatDiscovery` code path (the same one `index.ts`'s `input` handler calls) against the real running `substrate-mcp` service, which positively confirmed both directions of the wiring (see coverage D2/D3).
- **`substrateMcp` client would not connect in this environment** at first: no `SUBSTRATE_TOKEN` env var and no matching key in `/etc/substrate/substrate.env` (the designated token file). This is `UltrathinkMcpClient.connect()`'s own pre-existing, Task-1-era client-side gate (`if (!this.token) { ...; return; }`), not something Task 2/3 changed. Confirmed the real substrate-mcp server itself runs with `allowAnonymous` in this bare local deployment (`/healthz` and `/brief` both answer without a bearer token, and the startup log reads "listening on http://127.0.0.1:7410 (index + greptime, anonymous)"), so for the live-verify script only, an ad hoc `SUBSTRATE_TOKEN` env var value was supplied for that one process invocation (not written to any file, not a persistent change) to let the client attempt the real connection; the server accepted it under `allowAnonymous`. No project file governs this — it is an ops/provisioning gap (no real `SUBSTRATE_TOKEN` is issued anywhere for Omp yet) worth flagging for whoever configures a non-bare deployment, but out of scope for this plan to fix.

## User Setup Required

None - no external service configuration required. (Note: for a non-bare/authenticated `substrate-mcp` deployment, someone will eventually need to provision a real `SUBSTRATE_TOKEN` value into `/etc/substrate/substrate.env` or the `SUBSTRATE_TOKEN` env var — see Issues Encountered above. Not required for this plan's own acceptance criteria, which the bare/anonymous deployment already satisfies.)

## Next Phase Readiness
- Omp is now a full reader+writer participant in the Agent Substrate event/memory system, matching the pattern already established for hermes-plugin (01-02) and Muse Code (01-06).
- The `pi -e` extension-loader defect (Issues Encountered) is unrelated to this plan but will block any future plan that needs to drive a literal, non-interactive Omp CLI session for live verification; worth a dedicated look before the next plan that depends on it.
- No blockers for phase 1's remaining plans (01-08, 01-09).

---
*Phase: 01-lane-b*
*Completed: 2026-09-24*

## Self-Check: PASSED

- FOUND: /root/src/repos/omp-ultrathink/config.ts
- FOUND: /root/src/repos/omp-ultrathink/index.ts
- FOUND: /root/src/repos/omp-ultrathink/swe.ts
- FOUND: /root/src/repos/omp-ultrathink/swe.test.ts
- FOUND: /root/src/repos/omp-ultrathink/package.json
- FOUND commit: 18cf205 (Task 1)
- FOUND commit: 0d0d017 (Task 2)
- FOUND: .planning/phases/01-lane-b/01-07-SUMMARY.md (this file)
