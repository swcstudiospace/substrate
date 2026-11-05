---
phase: 71-multi-session-boundary
verified: "2026-11-05T07:59:46Z"
status: human_needed
score: "5/5 roadmap success criteria verified on this tree (HEAD 6e5d766e); the PostgreSQL restart, authority and idempotency clauses are re-cited by name from the gate r33 JUnit report (no PostgreSQL started by this verifier); the only human item is the PR 199 Greptile gate, which this verifier did not observe"
covered_files: [".planning/phases/71-multi-session-boundary/71-01-PLAN.md", ".planning/phases/71-multi-session-boundary/71-01-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-02-PLAN.md", ".planning/phases/71-multi-session-boundary/71-02-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-03-PLAN.md", ".planning/phases/71-multi-session-boundary/71-03-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-04-DOCS-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-04-PLAN.md", ".planning/phases/71-multi-session-boundary/71-04-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-05-SUMMARY.md", "docs/live-steering.md", "packages/audit/src/record.ts", "packages/cli/src/steer/binding-record.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/live-session-boundary.test.ts", "packages/mcp-server/src/live-session-isolation.test.ts", "packages/mcp-server/src/live-session-restart.pg.test.ts", "packages/mcp-server/src/mcp.steering.test.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/planning/live-session-authority.pg.test.ts", "packages/mcp-server/src/planning/live-session-authority.test.ts", "packages/mcp-server/src/planning/session-state.ts", "packages/mcp-server/src/planning/steering-idempotency.pg.test.ts", "packages/mcp-server/src/planning/steering-rest.ts", "packages/mcp-server/src/planning/steering-sessions-store.ts", "packages/mcp-server/src/planning/steering-tools.test.ts", "packages/mcp-server/src/planning/steering-tools.ts", "packages/mcp-server/src/server.steering.test.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/session-context.test.ts", "packages/mcp-server/src/session-context.ts"]
covered_digest: "v3:sha256:c5db2d04760f1aa96b9ef85657ffb1dd4173801c6ad3be714d1f1db5ea945f5d"
behavior_unverified: 0
overrides_applied: 0
gaps: []
re_verification:
  previous_status: human_needed
  previous_score: "5/5"
  gaps_closed: []
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "PR 199 Greptile gate via Desk Quality / Programming Lead, covering the discovery-expiry change."
    expected: "A Greptile result on the PR with no unaddressed finding. A FAILED, SKIPPED or unavailable review is not a pass."
    why_human: "External review gate. Not observed or queried by this verifier."
---

# Phase 71: Multi-Session boundary — Re-verification at HEAD 6e5d766e

**Phase Goal:** Enforce authenticated bindings on live session-scoped reads and writes. Foreign and unknown targets return indistinguishable not-found responses. Live session identifiers are unguessable and never reused. Preserve operator-only steering writes and the redacted repository-wide `session_context` digest.
**Verified:** 2026-11-05T07:59:46Z
**Status:** human_needed
**Re-verification:** Yes. The prior `71-VERIFICATION.md` (HEAD 42e3cf13) was read, then overwritten.

**Tree:** /root/src/worktrees/as-gsd-v18-all, branch gsd/v18-int-all, HEAD 6e5d766e. No code edits, no commits, no full suite, no tsc, lint or formatters, no Docker, no database started. One non-PostgreSQL targeted bun run (`SUBSTRATE_TEST_PG_URL` unset, `TMPDIR` on the gate tmpfs) and one `verification.fingerprint` computation were run by this verifier. The PostgreSQL clauses are cited by named pass from the gate r33 JUnit report (`/root/src/worktrees/backups/gate-r33-junit.xml`), as the phase assignment directs. Only this phase's VERIFICATION.md was written, in the worktree.

**Changes since the prior record (42e3cf13..6e5d766e):** six commits: `bd5c287a` (records refresh at 42e3cf13), `49b9aece` (fix 76, `event-buffer.ts`), `b4bdd0fc` (fix 70, `service.ts` emit), `d1a5e89b` (fix 75, `cache.ts`), `b4fe6bfe` (fix 68, `worktree.py`), `6e5d766e` (docs). Among the covered set, only `packages/mcp-server/src/service.ts` changed (`git diff --stat`: +2/-1, one hunk at HEAD `:3005-3006`, in `Substrate.emit`). Every other covered file is byte-identical to 42e3cf13 (`git diff --stat 42e3cf13..HEAD` over `planning/`, `server.ts`, `mcp.ts`, `session-context.ts`, `observe.ts`, `event.ts`, `index-store.ts`, `packages/audit`, `packages/cli`, `docs/live-steering.md` is empty).

What the changed covered hunk does: `b4bdd0fc` makes `emit` call `this.corpusSlo.recordSyncLag(payload)` also for a note that was held in the buffer or dead-lettered, not only for a stored one. `recordSyncLag` (`corpus/slo.ts:69`) reads only `syncLagSeconds(payload)`, the `docs.sync` lag, and leaves the reading in place when there is none. No live-session, steering, authority, digest or refusal code is on this path. The hunk does not change any boundary body, refusal value, operator map, or authority call. Its own test (`service-event-buffer.test.ts`, "a docs.sync note the ledger could not take still sets the sync-lag reading") passes in gate r33 with no skip.

Checked and not on the covered path: `49b9aece` (`event-buffer.ts`, `abandonAll`) and `d1a5e89b` (`cache.ts`, `forgetVerdict`) are not covered files. No covered steering, boundary, session-context, server or MCP file imports `event-buffer` (grep). The live-session authority (`steering-sessions-store.ts`) reads and writes PostgreSQL through its own `sql` handle per call and is documented as "wholly independent of the optional restart cache" (`:209`). `b4fe6bfe` (`worktree.py`) and `6e5d766e` docs are outside the covered set; `docs/corpus.md` and `docs/reconcile.md` changed, `docs/live-steering.md` did not.

**Docs checked at HEAD:**

- `ROADMAP.md` Phase 71 block (`:1230-1250`, goal and five success criteria) has no hunk in 42e3cf13..6e5d766e. The success-criteria text is unchanged.
- `ROADMAP.md:1234`, `:1256`, `:1271` and `:1419` still name commit `4b84e50c`. HEAD is `6e5d766e`. Stale, flagged, not edited.
- `REQUIREMENTS.md:133` HARD-S1 traceability row still reads "Human-needed: 3 of 5 criteria verified ... Postgres restart clauses pending". The PG clauses are now verified (below). Stale wording, flagged, not edited.

## Criteria source

- **Used:** this tree's ROADMAP `### Phase 71` success criteria, five items (`ROADMAP.md:1242-1248`).
- **Requirement:** HARD-S1, `.planning/REQUIREMENTS.md:112`.

## Method

Goal-backward inspection of the covered set, with the five criteria as the contract. Because only `service.ts` changed (one hunk, `:3005-3006`, which shifted every later line of that file by +1), line references were re-anchored at HEAD 6e5d766e by content. The steering boundary files (`steering-tools.ts`, `steering-sessions-store.ts`, `steering-rest.ts`, `session-state.ts`, `server.ts`, `mcp.ts`, `index-store.ts`, `session-context.ts`) are unchanged since 42e3cf13 and their references were spot-checked at HEAD.

PostgreSQL clauses: the three PG files were NOT re-run by this verifier. Per the phase assignment, each PG clause is cited by its named testcase from the gate r33 JUnit report (12290 testcases, 0 failures), with no `<skipped/>` child and no `<failure>`/`<error>` child, checked by parsing the XML.

Non-PostgreSQL targeted run (this verifier, HEAD 6e5d766e, `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000`), 12 files: `live-session-boundary.test.ts`, `live-session-isolation.test.ts`, `mcp.steering.test.ts`, `server.steering.test.ts`, `session-context.test.ts`, `planning/live-session-authority.test.ts`, `planning/steering-tools.test.ts`, `planning/steering.test.ts`, `planning/steering-rest.test.ts`, `service.test.ts`, `service-event-buffer.test.ts`, `planning/session-state.test.ts`: **585 pass, 0 fail, 0 skip** (3483 expect calls, 22.8 s). The `[substrate]` stderr lines in the run are the injected failure cases the tests expect (controlled ledger outage, audit-chain outage, expiry-pass failure).

Cross-check against gate r33 JUnit for the same 15 covered test files (12 above plus the three PG files): 618 testcases, 0 skipped, 0 failed. The PG files are 16 (restart), 13 (authority), 4 (idempotency), 33 in total.

## Goal achievement — roadmap success criteria

| # | Criterion (ROADMAP, this tree) | Verdict | Evidence (HEAD 6e5d766e) |
|---|---|---|---|
| 1 | Foreign and unknown live session IDs give the same 404 status, body and headers on every private read or write. No directive, acknowledgement or state changes on refusal. | **VERIFIED** | One refusal value: `liveSessionNotFound()` (`steering-tools.ts:40`), thrown as `LiveSessionBoundaryError` (`:41-43`) and mapped to one refusal at `server.ts:765` and `:2420`. The authority returns `notFound()` for an absent row, a foreign or wrong-proof row, and an expired or closed row (`steering-sessions-store.ts:232-234`; `authorized` `:135-145`). Unknown rows still run the constant-time comparison against a dummy hash. `deny()` maps not-found to `liveSessionNotFound()` (`steering-tools.ts:124`); the prepare path maps not-found to `deny` (`:97`). Non-PG run: 585/0/0. JUnit: `live-session-boundary.test.ts` 18/0/0, `live-session-isolation.test.ts` 34/0/0. |
| 2 | Operator authority stays explicit and permitted cross-session operations stay available. Refusal audits hash requested identifiers and record no private session body. Principal-keyed limiting runs before binding lookup. | **VERIFIED** (audit best-effort, Residual 1) | Operator bypass is the explicit map `OPERATOR_OPERATIONS` = private-read, close, operator-queue, operator-ack (`steering-sessions-store.ts:125-127`), applied in `authorized()` at `:143` after the row is loaded. Owner transitions and heartbeat are not in the map. Operator queue or ack without operator rights records a denial and returns `forbidden operator-required` (`steering-tools.ts:99-101`). Refusal audit digests the target with `substrate.live-session-refusal.v1` over `target.slice(0, 128)` (`steering-tools.ts:126`, `recordDenial` `:127`), so no session body is recorded. Principal-keyed limiting ordering is as recorded at c40ffc9a (`reserve`, `steering-tools.ts:71`, before binding lookup). JUnit: `live-session-authority.test.ts` 15/0/0; `steering-tools.test.ts` 21/0/0. |
| 3 | Session identities have at least 128 bits of cryptographic randomness; durable ownership and closed-session tombstones prevent reissue or cross-surface takeover, including after restart. An unavailable authority fails closed rather than accepting a cached grant. | **VERIFIED** | Entropy: `randomBytes` from `node:crypto` (`steering-sessions-store.ts:7`; `entropy` default `:217`). Issuance draws two independent 32-byte values, ID and proof (`:271-272`); ID = `ls_` + 64 hex (`:274`, 256 bits); proof 64 hex (`:275`). Only the domain-separated proof hash is stored (`bindingHash` `:131-133`, `:276`; column `binding_proof_hash`, migration 42 `index-store.ts:880-905`). A wrong-length entropy draw returns `unavailable()` (`:273`). Closed or expired rows are tombstones and fail as not-found (`:232-234`). Restart and authority clauses (named JUnit passes, gate r33, see "PostgreSQL clauses re-cited" below): `live-session-restart.pg.test.ts` 16/16 pass; `planning/live-session-authority.pg.test.ts` 13/13 pass, including "unavailable pool cannot fall back to another adapter's successful cached grant" and "legacy SQL rows cannot grant an unissued identity or revive a closed binding". |
| 4 | The operator-only queue/ack contract and legacy unkeyed command shape remain unchanged. All affected callers migrate to the explicit session identity lifecycle; no alias silently bypasses binding checks. | **VERIFIED** (one deliberate contract change, Residual 4) | `session_binding` is optional in every input schema (`steering-tools.ts:15` `SESSION_BINDING_INPUT`, used at `:19`, `:21`, `:24`, `:26`, `:29`, `:32`), so the command shape is unchanged. Operator queue and ack need no proof for an operator (`steering-sessions-store.ts:126`, `:143`). Dispatch maps each tool to one explicit operation and session target (`service.ts:1602`, `liveInvocationFor`; `liveCallKey` `:1599`). Idempotent replay of a keyed queue: "a saved replay is returned exactly by a second instance" and "two concurrent keyed commands through two instances queue one directive and both get its reply" (steering-idempotency PG, named passes). |
| 5 | The redacted repo-wide `session_context` digest remains available as designed in Phase 67. Re-run the recorded steering regression file set and the new isolation/revocation/restart failure-injection cases; record pass/skip counts and any deliberate contract changes. | **VERIFIED** | Digest: `sessionContext` (`service.ts:4020`) reads steering through `this.liveSessions.listMetadata({ repoId: scope, limit: 200 })` (`:4041`), `scope = scopeRepoId(request.repoId)` (`:4022`); `listing()` selects only `session_id, owner_surface, repo_id, state, updated_at, expires_at` (`steering-sessions-store.ts:246-247`). Restart failure injection and revocation, named JUnit passes: `live-session-restart.pg.test.ts` 16/16 (including "SQL expiry overrides an already-admitted independent service and cannot be renewed or re-registered", "authority outage at close wait release is unavailable, never a successful directive/closed/timeout", "a real missing authority schema fails service reads, issuance and mutation closed despite another pool's grant"). Regression set re-run here: 585 pass / 0 fail / 0 skip over 12 files. Deliberate contract changes are listed in Residuals 4 and 5. |

**Score:** 5/5 criteria verified. `behavior_unverified: 0`.

## PostgreSQL clauses re-cited (gate r33 JUnit, not re-run)

Source: `/root/src/worktrees/backups/gate-r33-junit.xml`. Each suite has `failures="0" skipped="0"`, and each named testcase has no `<skipped/>` or `<failure>`/`<error>` child (checked by parsing the XML).

| Clause | JUnit suite (file) | Result | Named testcases cited |
|---|---|---|---|
| live-session-restart | `HARD-S1 durable service restart and independent-instance release (controlled PostgreSQL)` (`packages/mcp-server/src/live-session-restart.pg.test.ts`) | 16 pass / 0 fail / 0 skip | "teardown/reconstruction preserves owner proof, canonical state and terminal tombstone with cache migration off"; "close racing independent-pool heartbeat reports its actual committed effect without revival"; "SQL-time expiry overrides an already-admitted independent service and cannot be renewed or re-registered"; "a held wait observes close from an independent service without any local wake or shared authority map"; "actual migration37 stale rows cannot grant or revive across reconstructed services without a cache adapter"; "a real missing authority schema fails service reads, issuance and mutation closed despite another pool's grant" |
| live-session-authority | `durable live-session authority against controlled PostgreSQL (two independent pools)` (`packages/mcp-server/src/planning/live-session-authority.pg.test.ts`) | 13 pass / 0 fail / 0 skip | "factory issuance with cache opt-in off persists hash-only canonical state and survives reconnect"; "state is canonical across pools; immutable owner/repo and omitted private fields persist"; "close racing heartbeat and transition never resurrects; tombstone persists after reconnect"; "active and terminal collisions retry fresh independent pairs and never change existing binding"; "legacy SQL rows cannot grant an unissued identity or revive a closed binding"; "lost commit responses never report issuance/close success even when PostgreSQL committed"; "unavailable pool cannot fall back to another adapter's successful cached grant" |
| steering-idempotency | `steering replay and delivery sequence against PostgreSQL` (`packages/mcp-server/src/planning/steering-idempotency.pg.test.ts`) | 4 pass / 0 fail / 0 skip | "a saved replay is returned exactly by a second instance, and the sequence continues from the saved value"; "a claim whose unit fails keeps no replay record on either instance"; "a keyed queue commits its audit row and replay record together, and a retry on the other instance replays"; "two concurrent keyed commands through two instances queue one directive and both get its reply" |

The restart suite's "outage/expiry before a queued directive's final wait release suppresses private bytes" and "authority outage at timeout/close/immediate wait release is unavailable" clauses (6 more named passes in the same suite) are cited with the same result.

## Required artifacts and wiring (Steps 4 and 5)

Artifact existence (plan artifacts unchanged): 71-01 3/3, 71-02 3/3, 71-03 5/5, 71-04 4/4.

| Artifact | Wiring | Status |
|---|---|---|
| `planning/steering-sessions-store.ts` (`bunLiveSessionAuthority`) | `index-store.ts:56` import, factory `index-store.ts:1048`, `IndexStore` → `service.ts:2032` | WIRED |
| `planning/steering-tools.ts` (`LiveSessionBoundary`, `liveSessionNotFound`) | `service.ts:2035-2043`; `server.ts:69` import, `:765` and `:2420` catch; `mcp.ts` | WIRED |
| `planning/steering-rest.ts` (`steeringHttpStatus`) | `server.ts` `sendSteeringResult` | WIRED |
| Migration 42 `live_session_bindings` (`index-store.ts:880-905`) | Mandatory, no opt-in | WIRED |
| `planning/session-state.ts` (`LiveSessionStatePort`) | Injected at `service.ts:2054`; reads authority per call | WIRED |
| `event.ts` helpers (`normalizeKey`, `assertWriteTextFields`, repo cap) | `service.ts:3139` write refusal; `index-store.ts` import | WIRED (ledger path; not on the live boundary path) |
| CLI `steer/binding-record.ts`, `steer/client.ts`, `session/hook.ts` | `steer/index.ts:43`; `hook.ts:47`; client paths match server routes (`server.ts:2210-2302`) | WIRED (route level) |

Level 4 (data flow): steering and digest paths read authority-backed rows (`steering-sessions-store.ts:246-253`) and return them unchanged (`service.ts:2287-2289`, `:4041-4043`). No hardcoded or static source.

### Key Link Verification

| Plan | From | To | Via (plan) | Status |
|---|---|---|---|---|
| 71-01 | `index-store.ts` | `planning/steering-sessions-store.ts` | `IndexStore.liveSessions` | WIRED |
| 71-01 | `steering-sessions-store.ts` | `event.ts` | `nextSteeringSession` | WIRED |
| 71-01 | `service.ts` | `index-store.ts` | consumes `liveSessions` | WIRED |
| 71-02 | `cli/src/steer/index.ts` | `steer/binding-record.ts` | record load and save | WIRED |
| 71-02 | `cli/src/steer/client.ts` | `mcp-server/src/server.ts` | HTTP routes | WIRED (route level) |
| 71-02 | `cli/src/session/hook.ts` | `cli/src/steer/client.ts` | client use | WIRED |
| 71-03 | `service.ts` | `planning/steering-sessions-store.ts` | authority types and factory | WIRED |
| 71-03 | `server.ts` | `planning/steering-tools.ts` | boundary calls | WIRED |
| 71-03 | `mcp.ts` | `service.ts` | `Substrate` methods | WIRED |
| 71-03 | `planning/steering-delivery.ts` | `planning/session-state.ts` | declared direction | **WARNING** (reversed in code: `session-state.ts` imports the port type from `steering-delivery.ts`; production wiring is `service.ts:2054`) |
| 71-04 | `live-session-isolation.test.ts` | `server.ts` | HTTP harness | WIRED (indirect) |
| 71-04 | `live-session-restart.pg.test.ts` | `index-store.ts` | IndexStore | WIRED |
| 71-04 | `docs/live-steering.md` | `cli/src/steer/index.ts` | documentation of the contract | **WARNING** (documentary link; contract text present) |

## Behavioral Spot-Checks (Step 7b)

| Behavior | Command | Result | Status |
|---|---|---|---|
| Foreign and unknown IDs share one 404; boundary, isolation, MCP and server steering, authority, tools, REST, digest, session-state, `service.test.ts`, service event buffer | Non-PG targeted run above (12 files) | 585 pass, 0 fail, 0 skip | ✓ PASS |
| Same covered set, gate r33 JUnit (15 files incl. PG) | XML parse, no run | 618 testcases, 0 skipped, 0 failed | ✓ PASS (cited) |
| Restart and durable tombstones survive a second instance | JUnit `live-session-restart.pg.test.ts` (named passes above) | 16 pass / 0 fail / 0 skip | ✓ PASS (cited) |
| Authority durability and terminal identities; unavailable pool refuses | JUnit `planning/live-session-authority.pg.test.ts` | 13 pass / 0 fail / 0 skip | ✓ PASS (cited) |
| Steering idempotency across restart | JUnit `planning/steering-idempotency.pg.test.ts` | 4 pass / 0 fail / 0 skip | ✓ PASS (cited) |
| Sync-lag hook change (`b4bdd0fc`) | JUnit `service-event-buffer.test.ts` (18 testcases, 0 skipped, 0 failed) incl. "a docs.sync note the ledger could not take still sets the sync-lag reading, and lands once when the ledger is back" | pass | ✓ PASS (cited, and included in the non-PG run) |

## Probe Execution (Step 7c)

No probes declared. No `scripts/*/tests/probe-*.sh` for this phase. Not applicable.

## Anti-Patterns

- Debt-marker scan: the 42e3cf13..6e5d766e change in covered code is the single `service.ts` hunk (`+2/-1`, comment plus a condition). No `TBD`, `FIXME`, `XXX`, `TODO` or `HACK` marker in it. Unchanged covered files carry the earlier scan (0 markers in the boundary path).
- Stub-pattern hits in the boundary files are not stubs: `steering-tools.ts:71` is `reserve()` admitting a call; `steering-sessions-store.ts:151-152` is the invalid-row guard.
- Debt-marker gate: not triggered. No blocker.

## Residuals (reported, not blocking)

1. **Denial audit is best-effort.** `recordDenial` swallows audit errors (`steering-tools.ts:127`). Refusals still return the identical 404. Rate-limited refusals are not audited, as they carry no target identifier.
2. **Audit digest embeds the proof for MCP calls that carry `session_binding`.** `argDigest` = SHA-256 of canonical args (`packages/audit/src/record.ts:180-192`). No plaintext stored. Owner-held item (see Open decisions).
3. **Malformed vs unknown IDs.** A syntactically invalid `session_id` gets REST 400 before lookup (`steering-rest.ts:34-37`, `requiredSession`); well-formed unknown or foreign IDs get 404.
4. **Owner unkeyed calls are refused.** `authorized()` (`steering-sessions-store.ts:138-144`) requires a matching proof. Deliberate behavior change; criterion 5 requires it recorded.
5. **Operator bypass without proof.** `authorized()` (`:143`) lets an operator read, close, queue and ack without a proof, for the operations at `:125-127`. Explicit operator authority per `PLAN 71-01`.
6. **Over-long repo refused at issue.** `issue()` throws `repo_too_long` before the authority's `try` (`steering-sessions-store.ts:265`). A refusal of invalid input, not an acceptance.
7. **Digest session IDs.** `session_context` lists `session_id`, surface, state and times for the repo (`steering-sessions-store.ts:246-247`); the proof never appears in the digest.
8. **Lone-surrogate and straddle data:** carried from the earlier record; no change in this range.
9. **Sync-lag hook (new in this range, `b4bdd0fc`).** A held or dead-lettered `docs.sync` note now sets the corpus sync-lag reading. This is the docs SLO path (`corpus/slo.ts`), not the live-session path, and it is not a phase 71 criterion.
10. **Stale docs, carried unchanged:** `ROADMAP.md:1234` status and `:1419` table row name commit `4b84e50c`; `REQUIREMENTS.md:133` HARD-S1 row says "Postgres restart clauses pending" (they are now verified, see above). Flagged, not edited.

## Human Verification Required

1. **PR 199 Greptile gate via Desk Quality / Programming Lead.** Covers the discovery-expiry change. The expiry is not in discovery at HEAD: `listing()` (`steering-sessions-store.ts:238-260`) has no expiry call and performs no write; the only expiry caller is `expireDueBeforeIssue` (`:194-200`), called from `issue()` (`:269`). Not observed or queried here. A FAILED, SKIPPED or unavailable review is not a pass. This is the only human item for phase 71, and the sole reason the status is `human_needed`.

## Open decisions (owner-held, carried; not re-opened here)

These are recorded owner-held items. Per the owner decision in force, the PR 199 Greptile gate is the only human item for this phase; the items below are not human-verification entries and do not change the status.

- **Recovery limit (D71-08):** the closed logical archive does not cover `live_session_bindings`. `docs/runbooks/index-archive.md:8` still lists it under "Not covered". Wave 6 added `corpus_documents` to the archive; `live_session_bindings` remains excluded.
- **Operator-only, not exercised here:** deployed migration 42, complete PostgreSQL backup and restore including tombstones, real host hooks and timers, real credential enablement.
- **Malformed-ID response (400 vs 404):** Residual 3.
- **Digest-of-proof in the audit record and in-process dispatch key:** whether a hash of the proof in `argDigest` (`record.ts:180-192`) and in `liveCallKey` (`service.ts:1599`) is acceptable under HARD-S1. Residual 2.
- **Owner unkeyed calls refused:** Residual 4.
- **Operator close and bypass scope:** Residual 5.
- **Test-count reconciliation and ROADMAP status commit id:** Residual 10.
- **Lone-surrogate and straddle data:** Residuals 8 and 9.

## Gaps

None. No criterion is FAILED. No behavior-unverified truths remain. Deferred items: none. Regressions since 42e3cf13: none. The one changed covered file, `service.ts`, changed only at the sync-lag hook in `emit` (`:3005-3006`); no boundary body changed, and the boundary tests pass at 6e5d766e: 585/0/0 targeted (12 files, non-PG run), and 618 covered testcases with 0 skipped and 0 failed in gate r33 JUnit, including the PG clauses cited above.

---

_Verified: 2026-11-05T07:59:46Z_
_Verifier: Claude (gsd-verifier), re-verification at HEAD 6e5d766e_
