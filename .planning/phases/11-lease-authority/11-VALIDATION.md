---
phase: "11"
slug: "lease-authority"
status: validated
nyquist_compliant: true
wave_0_complete: true
created: "2026-10-07"
source_commit: "1791393df14e74be9f6808649d78c6df08ffbb05"
fresh_execution: parent_reported
---

# Phase 11 — Validation Strategy

> Reconstructed Nyquist contract for all eight numbered tasks of Plan 11-01, validated using inspected phase source, historical provenance and explicitly attributed fresh parent integration evidence. The parent repaired the narrow test/documentation findings and completed README review; no open validation gap remains.

## Scope and provenance

- Inputs read in full: `11-01-PLAN.md`, `11-01-SUMMARY.md`, `11-VERIFICATION.md`, and `CONTEXT.md` in this directory. Plan 01 has one wave and eight numbered tasks, not eight independent plans.
- Source root: `/root/src/worktrees/agent-substrate-p11`; `git rev-parse HEAD` observed `1791393df14e74be9f6808649d78c6df08ffbb05`. Below, `src/` means `packages/mcp-server/src/` relative to that root. References are to this observed revision, not later milestone worktrees.
- Historical evidence: SUMMARY lines 55–60 and VERIFICATION lines 29–34 record **1049 tests passed / 0 failed with live PostgreSQL**, clean `bunx tsc --noEmit`, **42/42 live checks**, and [PR #16](https://github.com/swcstudiospace/agent-substrate/pull/16) merged as `1791393` after Greptile **5/5**, zero open threads. The original live proof used 7499; the post-review proof used isolated 7498. These are artifact-reported results, not executions performed by this auditor or independently fetched PR status.
- The historical scripts `/tmp/p11-lease-proof/proof.ts`, `run.sh`, and `run7498.sh` still exist. Assertion source was inspected, including the explicit refusal to target `:7410`; their presence does not prove a current pass. Raw historical stdout was not used to manufacture a fresh receipt.
- No product code, test, fixture, service, credential configuration, or input phase artifact was changed. No test, build, formatter, runtime check, or smoke run was performed in this report task.
- **Fresh evidence received from Main during this audit:** full `bun test` in substrate p14 (inherits merged Phase 11 authority), with real `SUBSTRATE_TEST_PG_URL`: **1066 pass / 0 fail**; `bun run check`: **exit 0**. This is integrated p14 evidence, not a claim that the isolated p11 full suite was rerun. Separately, parent ran `/tmp/p11-lease-proof/run.sh` on exact merged p11 `1791393`: **42 checks PASS plus boot misconfigured-operator warning PASS**, real PostgreSQL + GreptimeDB, isolated **7499**, **33 seconds**. Server log: `/tmp/p11-lease-proof/server.W8kZ.log`. Parent reports source was not edited. These are parent-reported results, not executions by the report author.
- **Final integration closure reported by Main:** in current integration p15, the existing stranger-oracle case in `lease.test.ts` now checks `rightRelease == wrongRelease == missing` and preserves the complete node row; `docs/swarm-correlation.md` now distinguishes omitted reaper id with `lease_epoch`/`expired_at` from null-id lease views. Parent targeted lease+lesson tests: **81 pass / 0 fail**, typecheck **exit 0** after edits; inherited full-suite totals **1066** and **1129** passing were also reported. Authority implementation remains unchanged from P11. These p15 test/docs repairs are not attributed to historical commit `1791393`.
- **Task 8 parent review:** current p15 README lines 41–48 describe holder-token fences, line 59 links coordination, and lines 164–166 describe session shape, holder-only ids, no swarm operators and link swarm-correlation. Parent confirmed all match the current authority contract; no README change needed.
- These reports retain the run provenance, source/log paths, counts and parent attribution for archival without creating a new external script or pretending that raw stdout or a cryptographically signed gate is embedded here. No dedicated security scan or fresh remote Greptile verdict is implied. No redundant rerun of passed parent gates is requested.

## Test Infrastructure

| Property | Value |
|----------|-------|
| Framework | Bun `bun:test`, TypeScript; root `package.json:18-31` declares `bun test`, TypeScript check, and Bun >=1.4.0 |
| Config | Root `package.json` and `tsconfig.json`; no `bunfig.toml` found at root |
| Quick run | `bun test packages/mcp-server/src/lease.test.ts packages/mcp-server/src/authority.test.ts packages/mcp-server/src/handoff.test.ts` |
| Phase behavioral suite | `bun test packages/mcp-server/src/lease.test.ts packages/mcp-server/src/index-store.lease.test.ts packages/mcp-server/src/service.test.ts packages/mcp-server/src/mcp.test.ts packages/mcp-server/src/authority.test.ts packages/mcp-server/src/server.authority.test.ts packages/mcp-server/src/handoff.test.ts packages/mcp-server/src/drift.test.ts packages/mcp-server/src/event.test.ts packages/mcp-server/src/store-lock.test.ts` |
| Plan-wide suite | `bun test packages/mcp-server packages/audit` with `SUBSTRATE_TEST_PG_URL` securely supplied |
| Type check | `bunx tsc --noEmit` |
| PG prerequisite | `src/index-store.lease.test.ts:22-38` uses `describe.skip` without `SUBSTRATE_TEST_PG_URL`; a no-DB green run is not SQL/CAS evidence. Use disposable smoke PostgreSQL only. |
| Live smoke | Fresh parent run: `WT=/root/src/worktrees/agent-substrate-p11 bash /tmp/p11-lease-proof/run.sh`, isolated 7499. Existing `run7498.sh` is an alternative launcher, not the fresh run; never production 7410. |
| Runtime | Parent reports fresh live proof completed in 33 seconds. It deliberately waits for a 30-second lease to expire (`proof.ts:106-111,182-186`); this is not a max latency guarantee for all gates. |

All commands in this report run from `/root/src/worktrees/agent-substrate-p11`. The parent may substitute its integrated source root, but must record that root and commit; a result from a different revision is new integration evidence, not a rewrite of Phase 11 history.

## Sampling Rate

- Reconstructed per-task commands below provide feedback for every code task; task 8 is a manual contract review backed by those behavioral suites.
- For future changes, run the affected task's scoped command after its edit and the plan-wide suite once after integration. In this concurrent assignment, execution belongs to the parent; the fresh integrated suite/typecheck and exact-p11 live run above have now passed.
- Finalization evidence: the parent resolved G11-02/G11-04, ran the targeted post-edit tests/typecheck, and completed the README contract review. Existing full-suite and actual isolated live-proof results above satisfy the phase's integrated validation path.
- Original per-commit sampling and max feedback latency cannot be reconstructed from summary totals. No historical sampling continuity or latency is asserted.

## Per-Task Verification Map

All files in the command column exist. `Validated` below combines source-level mapping, historical proof and parent-reported integrated execution; it is not a claim that this auditor separately ran each scoped command. The exact-p11 live proof and current-p15 repair evidence remain distinct.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure behavior | Test type | Automated command | File exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 11-01-01 | 01 | 1 | LEASE-02, LEASE-03 | T-11-02, T-11-03, T-11-04 | Public view redacts; stranger checked before id; legitimate/anonymous/operator paths retain fences; renewal authenticates caller | Pure decisions / state transitions | `bun test packages/mcp-server/src/lease.test.ts` | Yes | Validated; G11-02 closed in p15 |
| 11-01-02 | 01 | 1 | LEASE-02, LEASE-03 | T-11-02, T-11-03, T-11-04, T-11-08 | SQL CAS, no foreign renewal/reclaim/complete; accepted replies alone carry id; reaper returns epoch | Live PostgreSQL integration | `bun test packages/mcp-server/src/index-store.lease.test.ts` | Yes; requires PG env | Validated |
| 11-01-03 | 01 | 1 | LEASE-02, LEASE-03 | T-11-02, T-11-03, T-11-05, T-11-07 | Service redacts node/replies/events; withdrawal and handoff release fenced; complete cannot close free/foreign node | Service behavior plus live ledger | `bun test packages/mcp-server/src/service.test.ts` plus live smoke command above | Yes; live script outside repo | Validated; provenance retained |
| 11-01-04 | 01 | 1 | LEASE-02 | T-11-05, T-11-07 | New packet contains intent only; both old signed shapes still verify; tampering rejected | Signature / serialization unit | `bun test packages/mcp-server/src/handoff.test.ts` | Yes | Validated |
| 11-01-05 | 01 | 1 | LEASE-01, LEASE-02, LEASE-03 | T-11-01, T-11-02, T-11-03 | Token-bound swarm attribution and exact session shape before index; caller passed through; graph read/register redacted | Pure + MCP transport | `bun test packages/mcp-server/src/authority.test.ts packages/mcp-server/src/mcp.test.ts packages/mcp-server/src/server.authority.test.ts` | Yes | Validated |
| 11-01-06 | 01 | 1 | LEASE-04 | T-11-06 | Swarm token cannot force even if operator-listed; warning names surface, not token | Policy + real HTTP with stub stores | `bun test packages/mcp-server/src/authority.test.ts packages/mcp-server/src/server.authority.test.ts` | Yes | Validated |
| 11-01-07 | 01 | 1 | LEASE-02 | T-11-03 | Drift claims and findings retain holder/epoch/expiry but no id | Drift unit + live MCP/REST | `bun test packages/mcp-server/src/drift.test.ts` plus live smoke | Yes | Validated |
| 11-01-08 | 01 | 1 | LEASE-01..04 | T-11-01..08 | Operator-facing contract accurately describes changed behavior and limitations | Manual contract review; preceding suites are behavioral support, not prose tests | Phase behavioral suite above; manual instructions below | Yes | Validated; p15 doc repair and parent README review |
| 11-invariant | 01 | 1 | Unchanged EVENT_KINDS and store-lock | T-11-07 | Twelve existing kinds only; callers do not gain direct ledger access or credentials | Contract inspection + existing architecture/security guard | `bun test packages/mcp-server/src/event.test.ts packages/mcp-server/src/store-lock.test.ts` | Yes | Validated |

## Exact Behavioral Test and Implementation Evidence

### Task 1 — pure holder decisions

`src/lease.ts:234-268,298-300,312-336,388-413,441-463` implements denial redaction, renewal/reclaim caller binding, holder-before-id ordering, force/anonymous policy and public/holder views. Exact tests in `src/lease.test.ts`:

- Line 172: `a denied claim names the holder but never hands over its lease id`.
- Lines 312 and 327: `another surface is refused not-holder even with the right lease id`; `the refusal is the same whatever id the stranger sends, so it confirms nothing`. At historical P11 the latter compared heartbeat ids and missing-id release only. G11-02 is now closed in parent integration p15: the same case also compares correct/wrong/missing-id releases and asserts the complete row remains unchanged; included in the parent-reported 81-pass targeted run.
- Lines 339, 351, 362, 373: `the holder's own surface beats and releases as before`; `an anonymous local run is not checked`; `an operator's force is not held to the holder's surface`; `a free node is unheld or a no-op for anyone, stranger or not`.
- Lines 382, 401, 414, 429, 438: `re-claiming as the holder from another surface's token renews nothing`; `re-claiming as the holder of a lapsed lease from another surface's token is refused too`; `the holder's own surface still renews and re-claims`; `an anonymous re-claim is not checked`; `another surface's token still takes a free node, but cannot renew it afterwards`.
- Lines 573 and 586: `reports the hold as a reader sees it, expiry included, and no lease id`; `the holder's view is the same hold with its id`.

### Task 2 — durable SQL authority

`src/index-store.ts:444-523` gates decisions and returns public/holder views; renewal UPDATE fences id and server expiry, new ownership fences epoch and server expiry. `:538-571` fences heartbeat; `:583-620` writes release and completion state in one epoch/id-fenced statement; `:649-680` fences reaping on observed id, holder, expiry and heartbeat and emits epoch-only rows.

Exact tests in `src/index-store.lease.test.ts`:

- Lines 57, 75, 92, 103: `two connections racing for one node: exactly one lease`; `ten concurrent claims leave one lease and one epoch bump`; `two sessions of the same surface are two holders`; `the holder renews in place, keeping its lease id and epoch`.
- Lines 132, 164, 297: `a stale lease id cannot heartbeat the lease that replaced it`; `a stale holder cannot release the node someone else now holds`; `a stale holder's completion leaves both the lease and the state alone` (same-surface sessions exercise the id fence, not merely the surface refusal).
- Lines 198, 213, 233, 253, 282: `reaping clears lapsed leases and names whose they were, by epoch rather than lease id`; `a renewal decided before expiry cannot revive the lease after it`; `an extension aimed at a lapsed lease is refused by the server, not just the client`; `the reaper does not clear a lease that a heartbeat renewed`; `completion writes the state in the same statement as the release`.
- Lines 310, 334, 345, 367: `another surface cannot beat, release or complete a held node, even with its lease id`; `an operator's forced release is not held to the holder's surface`; `another surface's token naming the holder's public session cannot renew its lease`; `another surface's token cannot re-claim the holder's lapsed lease as the holder`. Assertions preserve expiry, epoch, holder and incomplete state, redact denied lease views, and prove own-token renewal still returns the original id.

### Task 3 — service and event/replay paths

`src/service.ts:95-96,687-697` redacts graph get/register, `:828-832,858-859,885-890` emits epoch and fences withdrawal/redacts claim replies, `:907-915,927-965,984-1001` handles heartbeat/release/complete, `:1012-1028` builds epoch-only reaper events, and `:1085-1142` builds/signs handoffs then releases only after durability and with the sender's surface.

Exact tests in `src/service.test.ts`:

- Lines 96, 109, 122, 153, 168: `hands the caller the lease it is now holding, and the TTL it was granted`; `a renewal writes no event — a heartbeat is the absence of news`; `a steal is a warning, naming who was evicted`; `a refused claim writes nothing, reports the holder and hides its lease id`; `a renewal from another surface's token is refused not-holder, with no id and no event`.
- Lines 252, 264, 299, 311, 319: `the holder's release writes a note naming the node` (exact `{action, lease_epoch}` payload); `another surface is refused not-holder with the right id, sees no id, and writes nothing`; `completing a node a stale holder no longer owns does not close it`; `the holder completing its own node writes the state`; `completing a node nobody holds is refused: a no-op release is not ownership`.
- Lines 428, 445: `withdraws a claim whose event the ledger refused`; `does not clear a claim another surface has taken in the meantime`.
- Lines 988, 1023, 1038, 1072, 1102: `the lease is released only once the packet is durable`; `the packet records that a lease was handed over, never its id`; `the handoff's release is held to the authenticated sender`; `an anonymous run's handoff release is not held to the sender`; `the whole packet is in the event, signed, and verifies as stored`.

The durable reaper event, all public read surfaces together, and real ledger query round trips are covered by the **external live proof**, not solely by these stub-store tests. `/tmp/p11-lease-proof/proof.ts:119-199,201-242` reads as A09 through denied claim, graph get/register, refused heartbeat (right/wrong ids), release (missing/right id), completion, force refusal, MCP/REST drift, reaper, handoff replay, MCP `events_query` and REST `/events/query`; it checks both minted ids are absent. It explicitly checks epoch-only claim/reaper payloads. `:246-249` proves A05 still beats and completes. Caveat: final completion occurs after event-read assertions, so release/complete note redaction relies additionally on the permanent service assertion at line 261. Historical 42-check results remain historical.

### Task 4 — new and legacy signed packets

`src/handoff.ts:234-254` explicitly constructs a packet without `handover_lease_id`; `:259-280,304-331` signs/verifies the stored object, preserving legacy fields rather than rebuilding it. Exact tests in `src/handoff.test.ts`:

- Line 110: `every field is covered: changing any one of them breaks the signature` (includes `lease_handover` at line 124).
- Line 178: `a packet signed before lease_handover, carrying the old lease id field, still verifies` (JSON round trip; changing old id or adding new field rejects signature).
- Line 196: `a packet signed before any lease field reads with lease_handover absent and still verifies`.
- Lines 233, 247: `records that the sender meant to hand its lease over, never the id`; `the signature survives the round trip through the event payload`.

### Task 5 — authenticated swarm claims and public graphs

`src/mcp.ts:83-146,523-532,553-554,596-622` binds claim attribution and session validation before the service and threads caller identity into fenced calls. HTTP derives caller identity at `src/server.ts:219-224` and rejects missing/unknown tokens at `:254-257`.

- `src/authority.test.ts:302,308,314`: `a non-swarm token cannot claim as a swarm surface`; `a swarm token claims as itself, and is refused as anyone else`; `a non-swarm token naming another non-swarm surface, and an anonymous run, are unchanged`.
- `src/authority.test.ts:324,330,335,341,349`: `<AGENT>@<replica>:<graph_id> naming the token's own agent is accepted`; `a session naming another agent is refused`; `a replica outside [A-Za-z0-9._-]{1,64} is refused`; `the graph must equal graph_id, not merely look like one`; `a session that is not in the shape at all is refused`.
- `src/mcp.test.ts:334,351,367,404`: `graph_claim: a non-swarm token naming a swarm surface is refused, and the index is never asked`; `graph_claim: a swarm session naming another agent, a bad replica or another graph is refused, never rewritten`; `graph_claim: a lease held as a swarm surface has the swarm session shape, whoever asks for it`; `graph_get and graph_register show the holder, session, epoch and expiry, and no lease id`. Assertions exercise MCP replies including `isError` and no index mutation.
- `src/server.authority.test.ts:189,210,433,449`: `another surface's token is refused not-holder, even with the holder's lease id, and sees no id`; `the holder's own token beats its lease`; `MCP graph_claim: a non-swarm token naming a swarm surface is refused before the index`; `MCP graph_claim: A05's token with a session naming another agent or graph is refused before the index`.

### Task 6 — swarm is never operator

`src/config.ts:241-245,298-304` denies swarm operator status and emits surface-only warnings; `src/index.ts:24-25` consumes warnings; `src/mcp.ts:597,621` rejects force before service mutation.

- `src/authority.test.ts:120,133`: `a swarm token is never an operator, even when it is listed as one`; `and boot says which swarm surface was listed, without printing its token`.
- `src/server.authority.test.ts:217`: `a swarm token listed in SUBSTRATE_OPERATOR_TOKENS is still refused force` covers both release and complete, and no store release.
- Live proof checks operator-listed A09 refusal at `proof.ts:161-163`; launcher checks boot warning. Parent now reports both checks passing freshly on isolated 7499 at exact p11 `1791393`.

### Tasks 7–8 and invariants

- `src/drift.ts:299,314,341,371,456-462` uses public views in every lease finding and returned claim. `src/drift.test.ts:245`: `no finding or claim carries the holder's lease id, though holder, epoch and expiry show` checks the whole serialized report and retained metadata; MCP/REST adapters are exercised in the live proof.
- `docs/coordination.md:64-103,122-144` and `docs/swarm-correlation.md:115-164` contain session/holder/operator/event/legacy semantics. Parent corrected reaper wording in current p15, closing G11-04, and confirmed README lines 41–48, 59, 164–166 match the authority contract with no README edit required. Historical P11 line references above remain unchanged.
- `src/types.ts:50-63` was inspected: exactly the existing twelve kinds (`session.start`, `prompt`, `claim`, `tool.call`, `file.edit`, `shell`, `commit`, `pr`, `handoff`, `session.end`, `note`, `warning`). `src/event.test.ts:63`, `rejects an unknown surface or kind rather than storing it`, checks rejection, not exact enum equality. Exact-set preservation is a source-contract inspection, not a new incidental source-text test.
- Existing `src/store-lock.test.ts:93,101,109,129,143` guards: `no package outside the MCP server imports the ledger client`; `nothing else names the events table in SQL`; `nothing else reads GREPTIME_ from the environment`; `only the ledger client and the brief compose statements`; `the query tool's filters are columns this package names, not a caller's string`. These are existing architecture guards, not a claim of OS credential isolation.

## Wave 0 Requirements and Gap Resolution

Existing test infrastructure covers the requirements. The auditor added no tests; the parent filled the one identified assertion gap in current integration p15 and reported successful post-edit execution.

| Gap | Final classification | Evidence / consequence | Resolution |
|-----|----------------------|------------------------|------------|
| G11-01 | Closed | Parent p14 full suite with real PG: 1066 pass / 0 fail; typecheck exit 0; exact-p11 live proof 42 checks plus boot warning PASS in 33s. Parent subsequently reported inherited 1129-pass full suite and post-repair 81-pass targeted suite/typecheck. | Source versus integration provenance retained above; no redundant gate rerun. |
| G11-02 | Closed in p15 | Historical `lease.test.ts:327-336` lacked the plan-requested wrong-id release comparison, while `lease.ts:401-406` already enforced correct ordering. | Parent added right/wrong/missing stranger-release equality and unchanged-row assertion to the existing case; targeted lease+lesson tests 81 pass / 0 fail and typecheck exit 0 after edits. |
| G11-03 | Provenance recorded; no unresolved execution gap | Whole-surface real-store proof remains `/tmp/p11-lease-proof/proof.ts`, not a tracked regression test. Parent fresh exact-p11 proof passed; server log `/tmp/p11-lease-proof/server.W8kZ.log`. | This report retains exact source/root, launcher, isolated port/stores, result, latency and reporter. External-script portability remains a stated evidence limit, not a fabricated repository test or missing execution. |
| G11-04 | Closed in p15 | Historical `docs/swarm-correlation.md:138-142` grouped reaper rows with null-id views despite epoch-only output (`index-store.ts:673-680`). | Parent corrected omission/`lease_epoch`/`expired_at` wording and completed README review at lines 41–48, 59, 164–166; no README change needed. |

## Manual-Only Verifications

| Behavior | Requirement | Why manual | Instructions |
|----------|-------------|------------|--------------|
| Published contract matches actual reply shapes and exclusions | LEASE-01..04, task 8 | Documentation is not behavior; no permanent wording test appropriate | Read docs sections above and README Coordination/swarm paragraphs; distinguish reaper epoch-only row from null-id LeaseView; preserve anonymous, same-surface replica and historical-event limits. |
| Historical PR/review provenance if required for fresh ship gate | Historical acceptance evidence | This report reads local provenance, not remote review state | Parent should use existing shipping gate receipts or authenticated PR review tooling; do not call the report a fresh Greptile approval. |

The runtime checks are automated but environment-dependent, not waived as manual-only. Fresh parent executions, repaired assertion coverage and manual contract review now support Nyquist compliance. Historical per-commit timing remains unasserted.

## Validation Sign-Off

- [x] All eight numbered tasks mapped to requirement IDs, source, and exact behavioral tests or justified manual contract review.
- [x] No watch-mode flags in commands.
- [x] G11-02 wrong-id release assertion added and executed by parent in p15.
- [x] G11-04 wording corrected and README reviewed by parent; no README edit needed.
- [x] Fresh integrated PG suite and exact-p11 live whole-surface proof reported passing by parent.
- [x] Parent fresh live execution latency recorded: 33 seconds.
- [x] Parent execution provenance retained in this report for milestone archival; raw external artifacts remain identified, not falsely embedded.
- [x] Reconstructed sampling map has automated checks for every code task, with explicit manual documentation review; no unsupported claim about historical per-commit timing.
- [x] `wave_0_complete: true` and `nyquist_compliant: true` justified by inspected coverage and parent repair/execution evidence.

**Approval:** validated 2026-10-07 on the source audit and parent-reported fresh integration evidence. This is a formal phase report, not a fabricated signed release gate or a claim that the auditor independently executed the commands.
