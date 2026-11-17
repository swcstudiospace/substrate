# Substrate enhancement register

Read-only discovery. Written 2026-11-17 for Graph ut-f35e12d58f-ed1087ea. No Linear issue was created, edited or labelled. No tests, typecheck, lint or formatters were run.

## G2 gate (enhancement count)

Spec: `/root/.omp/agent/ultrathink/sessions/01a1d01f-29fb-745f-a2d2-9bce5b3f2926.xml:385`, verbatim:

> G2 (enhancement count): exactly eight Substrate-labeled items must be found in Linear with Notion links. Default: if the count is not eight, hold ENH-01 through ENH-08 and pause; all other units continue.

Linear lookup, read-only:

- Team: Spectrum Web Co (key SPE, id c194ec01-01ec-4203-809f-37381a0392e1).
- Query: `list_issues` with team "Spectrum Web Co", label "Substrate", includeArchived false. Result: 0 issues, hasNextPage false.
- Label check: `list_issue_labels` for the team returns Migrated, enhancement, Improvement, Feature, Bug. Workspace-wide labels return Improvement, Feature, Bug. No label named "Substrate" exists in either list.
- Actual labelled count: **0** (no IDs or titles to list).
- Keyword search of the team for "Substrate" and "enhancement" returned Substrate-titled task-graph steps (for example SPE-34212 "Ground the request in verifiable facts — Step 4: Mark the eight Substrate enhancements as unsourced"). These are planning steps, not enhancement issues, and carry no Substrate label.
- Notion search "Substrate enhancement" returned Agent Task Graph step pages, for example `41bbc1a0c7ae81abaab7cd4421c8a0fb` ("[n1] Step 4: Mark the eight Substrate enhancements as unsourced…"). It states the count "must be confirmed by searching Linear". No Notion page for an individual enhancement was found.

**G2 status: satisfied by decision, not by evidence.** The labelled count is 0, not 8. Per the user's decision in this session, the eight Substrate enhancements are v1.8 phases 71 to 78, so the eight entries below are those phases. ENH-01 to ENH-08 are not held on the G2 default. Every entry has no Linear issue and no Notion link, so the "Notion links" half of G2 is also unmet by evidence.

## Roadmap source

`/root/src/repos/agent-substrate/.planning/ROADMAP.md`: milestone v1.8 index at lines 137 to 148 (checkbox state and one-line status); phase detail at lines 1259 to 1388. Where the checkbox and the phase body disagree, both are recorded.

## Entries

### Phase 71: Multi-Session boundary

- Status (roadmap): unchecked `[ ]` (line 141). Body: "Locally verified (5/5 criteria)… Remaining gate: Greptile review of the remediation on PR #199 with no open threads, not yet observed" (line 1263).
- Success criterion 1 (line 1273): "Foreign and unknown live session IDs produce the same 404 status, body, and headers on every private session read or write, including directive lists, wait/listen, MCP steering tools, docs-session registration/transitions, and session-scoped steering augmentation. No directive, acknowledgement, or session state changes on refusal."
- Target stores (roadmap line 1269): `packages/mcp-server/src/server.ts`, `packages/mcp-server/src/planning/steering.ts`, `packages/mcp-server/src/mcp.ts`, `packages/cli/src/steer/`. Steering persistence: `packages/mcp-server/src/planning/steering-store.ts`.
- Linear: none found.
- Notion: none found.

### Phase 72: Repo allowlist and scoped credentials

- Status (roadmap): checkbox `[x]` (line 142, "ported from gsd/v18-p72-rebased in merge 082e653a; the branch's own verification is human_needed"). Body says "Not started" and "no per-session repository allowlist was found" (line 1285). The code now contains one; the body is stale.
- Success criterion 1 (line 1291): "A repository outside the session's allowlist is refused at the API and the CLI before any git call runs."
- Target stores: per-session allowlist read from `SUBSTRATE_REPO_ALLOWLIST` on each operation, `packages/mcp-server/src/repo-allowlist.ts:1-18`. Enforcement is named as `repo-executor.ts` in that file's header (lines 4 to 6) and in `packages/mcp-server/src/cross-repo-ops.test.ts:309`. Credential is per repository, named by the allowlist entry.
- Linear: none found.
- Notion: none found.

### Phase 73: Ledger tamper evidence

- Status (roadmap): checkbox `[x]` (line 143, "merged to main as PR #201, 83779a1d"). Body: "Implemented locally; gates green (2026-11-01)" (line 1300).
- Success criterion 1 (line 1306): "Tests save the graph's head before the change, then edit a stored payload, delete a middle event, truncate the last events, and rewrite the whole chain with recalculated `hash` and `prev`. Each is compared with that saved head: the edits and the rewrite report the first differing event id, and truncation reports the first missing event id."
- Target stores: Greptime event ledger `agent_events` (chain order comment, `packages/mcp-server/src/event.ts:267-282`). Chain leaves table `graph_chain_leaves`, DDL at `packages/mcp-server/src/greptime.ts:1078`, insert at `packages/mcp-server/src/greptime.ts:1898`. Hourly anchor code was not located in this pass (`evidence-anchor.ts` is absent).
- Linear: none found.
- Notion: none found.

### Phase 74: Cross-repo compensating actions

- Status (roadmap): checkbox `[ ]` (line 144): "Engine landed (96d451a4)… PARTIAL: no route or MCP tool calls it." Body: "Not started" (line 1315).
- Success criterion 1 (line 1323): "Execute an actual operation across at least two registered repositories and persist operation/step state before effects, using stable dedupe keys and idempotent per-step retry."
- Target stores: fan-out engine `packages/mcp-server/src/cross-repo-ops.ts` (tests `cross-repo-ops.test.ts`, testkit `cross-repo-ops.testkit.ts`). Built on the Phase 72 registry and allowlist (`repo-allowlist.ts`).
- Linear: none found.
- Notion: none found.

### Phase 75: DragonflyDB degradation

- Status (roadmap): checkbox `[x]` (line 145, "merged to main as PR #200, 3c465dc1"). Body: "Implemented locally; gates green (2026-11-01)" (line 1333).
- Success criterion 1 (line 1339): "With the cache breaker open, brief and recall return authoritative results. A test proves it."
- Target stores: cache plane `ReadThroughCache` at `packages/mcp-server/src/cache.ts:483`, which calls `callPlane` (`cache.ts:37`). Breaker: `callPlane` at `packages/observability/src/breaker.ts:215`, `BreakerOpenError` at `breaker.ts:173`. Per-class flags `SUBSTRATE_BUDGET_<CLASS>_BREAKER` are named in the roadmap body only (line 1333).
- Linear: none found.
- Notion: none found.

### Phase 76: Telemetry buffer and dead-letter

- Status (roadmap): checkbox `[x]` (line 146, "f3e6798b; claim-withdrawal policy and buffer paths in systemd are operator-gated"). Body: "Not started" (line 1348), citing `insertEvent` at `packages/mcp-server/src/greptime.ts:1217` before the change.
- Success criterion 1 (line 1354): "A failed event write enters a bounded buffer, is retried with backoff, and after the retry budget is written to a dead-letter store with its hash."
- Target stores: `EventBuffer` and `DeadLetterStore` in `packages/mcp-server/src/event-buffer.ts`. Config `packages/mcp-server/src/config.ts:650-654` and `:1219-1225` (`SUBSTRATE_LEDGER_BUFFER_PATH`, `SUBSTRATE_LEDGER_DEAD_LETTER_PATH`, `SUBSTRATE_LEDGER_DEAD_LETTER_MAX`). Wired in `packages/mcp-server/src/service.ts:2004-2007`. Write path: `packages/mcp-server/src/greptime.ts`.
- Linear: none found.
- Notion: none found.

### Phase 77: Steering idempotency and ordering

- Status (roadmap): checkbox `[x]` (line 147, "c26b1ef3 in process; b9ecd215 durable via migrations 44 and 45, the rehearsal is operator-gated"). Body: "Not started" (line 1363).
- Success criterion 1 (line 1369): "A replayed keyed command returns the original result and writes nothing."
- Target stores: `SteeringInbox` in `packages/mcp-server/src/planning/steering.ts` (delivery sequence, `sequenceOf` at `steering.ts:349`). Keyed rows (`idempotency_key`, `idempotency_fingerprint`, `delivery_sequence`) in `packages/mcp-server/src/planning/steering-store.ts` (around lines 76 to 436).
- Linear: none found.
- Notion: none found.

### Phase 78: Cross-layer reconciliation

- Status (roadmap): checkbox `[ ]` (line 148): "PARTIAL: the memory.forget pair is compared and repaired through a confirmed plan (46956358); the scheduled run is wired… not installed (operator gate)." Body: "Not started" (line 1379).
- Success criterion 1 (line 1385): "A scheduled reconcile reports per-layer counts and the first mismatching key, and writes nothing on a clean run."
- Target stores: `packages/mcp-server/src/cross-layer-reconcile.ts`, `packages/mcp-server/src/cross-layer-reconcile-run.ts` (scheduled run), `packages/mcp-server/src/cross-layer-reconcile-repair-run.ts` (confirmed repair). Scheduler wiring noted at `packages/mcp-server/src/index.ts:164`. Unit: `infra/vps/substrate-cross-layer-reconcile.service` and `infra/vps/substrate-cross-layer-reconcile.timer`.
- Linear: none found.
- Notion: none found.

## Unresolved

- Label "Substrate" does not exist in Spectrum Web Co or the workspace. Retired labels are not returned by `list_issue_labels`, so a retired label cannot be ruled out from this pass.
- Linear keyword searches (first page only where `hasNextPage` was true) for "multi-session", "allowlist", "tamper", "compensat", "DragonflyDB", "telemetry", "idempotency" and "reconcil" found no issue whose title matches a phase 71 to 78 topic.
- Roadmap checkboxes and phase bodies disagree for phases 72, 74, 76, 77 and 78. Both are recorded above; the roadmap was not edited.
- Hourly anchor code for phase 73 and the phase 75 breaker flag definitions were not located in this pass.
