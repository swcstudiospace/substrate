---
phase: 23-claim-mirror-and-dod-gate
verified: 2026-10-11T02:10:00Z
status: passed
score: 30/30 must-haves verified
covered_files: [".planning/phases/23-claim-mirror-and-dod-gate/23-01-PLAN.md", ".planning/phases/23-claim-mirror-and-dod-gate/23-01-SUMMARY.md", ".planning/phases/23-claim-mirror-and-dod-gate/23-02-PLAN.md", ".planning/phases/23-claim-mirror-and-dod-gate/23-02-SUMMARY.md", ".planning/phases/23-claim-mirror-and-dod-gate/23-03-PLAN.md", ".planning/phases/23-claim-mirror-and-dod-gate/23-03-SUMMARY.md", ".planning/phases/23-claim-mirror-and-dod-gate/23-04-PLAN.md", ".planning/phases/23-claim-mirror-and-dod-gate/23-04-SUMMARY.md", ".planning/phases/23-claim-mirror-and-dod-gate/23-05-PLAN.md", ".planning/phases/23-claim-mirror-and-dod-gate/23-05-SUMMARY.md", ".planning/phases/23-claim-mirror-and-dod-gate/23-06-PLAN.md", ".planning/phases/23-claim-mirror-and-dod-gate/23-06-SUMMARY.md", "docs/coordination.md", "docs/event-vocabulary.md", "docs/runbooks/mirror-proof.md", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/dod-gate.test.ts", "packages/mcp-server/src/dod-gate.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/linear.test.ts", "packages/mcp-server/src/linear.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/mirror.test.ts", "packages/mcp-server/src/mirror.ts", "packages/mcp-server/src/notion.test.ts", "packages/mcp-server/src/notion.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/rehearsal-env.ts", "packages/mcp-server/src/service.ts", "scripts/mirror-smoke.ts"]
covered_digest: "v3:sha256:56708720239c8b94984293b1ea75428b0c3a23f407ac03cd6fdf428e4004522e"
behavior_unverified: 0
overrides_applied: 0
deferred:
  - truth: "MIRROR-08 live proof: on a real Linear issue (SWC-467) and its Notion row, claim, refused second claim, release, complete without DoD and complete with DoD each produce the specified tracker state within 60 s."
    addressed_in: "Operator-approved window via docs/runbooks/mirror-proof.md"
    evidence: "Runbook header gates on explicit operator approval; evidence table row is NOT RUN. All five steps rehearsed against loopback fakes instead (smoke:mirror 38/38)."
re_verification:
  previous_status: stale
  previous_score: 30/30
  gaps_closed: []
  gaps_remaining: []
  regressions: []
---

# Phase 23: Claim mirror and DoD gate Verification Report

**Phase Goal:** Linear and Notion show who holds each node as leases change, the lease stays authoritative when a tracker fails, and only the Definition-of-Done gate can mark an issue Done.
**Verified:** 2026-10-10
**Status:** passed, with the MIRROR-08 live proof deferred to an operator-approved window (below).
**Base:** `main` at `bfde32f` (docs(22) close; phase 23 merged via PR #36 as `8c028c3`; `git pull --ff-only` already up to date).

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | D23-05 (23-01): Linear leaf client — 5 s per-call timeout on injected fetch, raw `Authorization: <key>`, errors carry status + ≤200 body chars and never the key/headers, additive-only `updateIssue` (no `labelIds`) | ✓ VERIFIED | `linear.test.ts` pins redaction (key/headers absent), the additive signature, and zero real network calls; re-run 2026-10-10 in the 91-pass client batch |
| 2 | D23-06 (23-01): type-ordered state resolution through the issue's own team by position; `issueContext` fetches position; In Review by name case-insensitive, absence is a mirror failure; completed ids never resolved or sent | ✓ VERIFIED | Tests pin first-started/first-unstarted by position, In Review by name, and completed-state refusal; re-run green |
| 3 | D23-07 (23-01): `ensureLabel` team → workspace → create team label with re-search after create error, cached per `teamId:name` | ✓ VERIFIED | Priority + cache tests green in the 91-pass batch |
| 4 | D23-08/09 (23-01): no hard-coded identifiers (every call via `linear_issue_id ?? linear_identifier`); invisible issues are per-transition warnings; the mirror creates no Linear issues, only `agent:<surface>` labels | ✓ VERIFIED | Client tests + hook tests (unresolvable ref → one warning, never an error); no issue-creation call exists in `linear.ts` |
| 5 | D23-10 (23-01): Notion client — `Notion-Version 2025-09-03`, writable set exactly Agent/Status/Linear State/Completed refused pre-request, GET-before-PATCH with the data-source gate, type-shaped values | ✓ VERIFIED | Zero-fetch refusal test, foreign-`data_source_id` PATCH suppression, all-four-properties shaping tests; re-run green |
| 6 | D23-25 (23-01): `hermesLinearUrl` (default `http://127.0.0.1:8792`, slash-trimmed), `dodGateTimeoutMs` (default 35000), `LINEAR_API_URL`/`NOTION_API_URL` production defaults | ✓ VERIFIED | `config.test.ts` pins defaults, trim, and overrides; pre-existing config tests unchanged |
| 7 | D23-02 claim/steal (23-02): granted/reclaimed = one issueUpdate (first started, +`agent:<holder>`, −every `dispatch:*` and other `agent:*`) + exact-text claim comment skipped when identical among last 20 + Notion Agent/Linear State; steal moves the label in one update with the new session's own comment | ✓ VERIFIED | `mirror.test.ts` transition-table tests; wire effects re-proven by smoke:mirror (claim, reclaim, steal label move, idempotent comment) |
| 8 | D23-02 release (23-02): release/expire/force = one issueUpdate (first unstarted, −every `agent:*`), no comment; Notion Agent cleared + state name; renewed writes nothing ever | ✓ VERIFIED | Exactly-one-update/zero-comment tests + zero-fetch renewed test; smoke asserts release/reap/force effects and renewed silence |
| 9 | D23-03 (23-02): swarm-* holders get exactly one Linear comment per transition, never state/label changes, never a Notion touch — pinned over every transition including the steal edge | ✓ VERIFIED | Dedicated every-transition test asserts zero issueUpdate, zero label calls, zero Notion requests; evicted-label-stays edge asserted; smoke re-proves (swarm claim: one comment, no state/label/Notion change) |
| 10 | D23-04 (23-02/04/05): no lease-id field anywhere; leak test over every mirror op, both read tools, and the gate asserts the id appears in no fetch URL/body, no event, no reply | ✓ VERIFIED | `grep -c lease_id mirror.ts` → 0; injected-fetch leak tests green; release note carries `summary_chars` only (the gate leak test caught a decision-id leak during development and it was fixed structurally) |
| 11 | D23-17/18/19 (23-02/03): mirror never throws, never rolls a lease back; per-node serialized chain; one redacted ≤300-char `mirror.failed` warning per failed target; non-applicable targets are silent skips | ✓ VERIFIED | Throw-vs-failure hook tests (lease stands + one warning); renewed/denied/refusal zero-call tests; serialization and cap tests green |
| 12 | D23-01 hooks (23-03): `claimNode` mirrors only granted verdicts with action granted/reclaimed/stolen; `releaseNode` mirrors released/forced reading the holder before the row clears; reaper CTE carries `linear_issue_id` + `notion_page` with no second read | ✓ VERIFIED | 10 hook tests (allowlist, evicted holder, completion-path skip, reap refs); CTE select-list test; losing-claimant/refusal paths make zero mirror calls |
| 13 | D23-20 (23-03): startup logs mirror availability once from key presence | ✓ VERIFIED | Spot-checked 2026-10-10: `index.ts:56` writes `[substrate] mirror: …` via `mirror.describe()` → `linear on\|off, notion on\|off` (`mirror.ts:112-114`) |
| 14 | D23-13/14 (23-04): `graph_complete` gains `dod?: {summary 1..2000, tests_pass, review_pass?}`; gate runs only for non-forced `completed` of Linear-linked non-swarm nodes; no-ref runs main's path unchanged; forced/other-state use the fenced path + `close` mirror; swarm uses main's path + comment-only `done` mirror | ✓ VERIFIED | Routing tests (ungated no-ref/forced/other-state/swarm); `mcp.ts` zod schema + description; forced completion asserts untouched Linear state |
| 15 | D23-15.1 (23-04): fenced `started_review` write — one UPDATE under the caller lease with holder check, TTL extension; refusals return main's shape and write no tracker | ✓ VERIFIED | `reviewNode` is the single new state write (`:732` rule intact); not-holder/stale/expired/unheld refusal tests with zero tracker writes; TTL-extension test |
| 16 | D23-15.3 (23-04): review mirror moves Linear + Notion to In Review; failure warns and the sequence continues | ✓ VERIFIED | Review-failure continuation test; smoke asserts the In Review wire effects |
| 17 | D23-15.4 (23-04): no dod → no connector call (`dod-required`, node parked at `started_review`, lease kept); with dod POST `{HERMES_LINEAR_URL}/v1/complete-issue` unauthenticated, only explicit `completed:true` counts; non-2xx/unreachable/malformed refuse; timeout (35 s) settles via Linear state read | ✓ VERIFIED | Zero-connector-call test; versioned `6e532fe` fixture pins (incl. 502 mapping); timeout-settles-both-ways tests; smoke asserts `dod-required` then approval with fixture-shaped POST body |
| 18 | D23-15.5 (23-04): approval runs main's one-statement fenced completion with the caller lease; release note carries `payload.dod` (`tests_pass`, `review_pass`, `summary_chars`, never text); Notion records Done; post-approval fence failure returns `completed:false` + refusal + warning while Notion still records Done | ✓ VERIFIED | Note-shape test (no summary text outside the connector POST); already-Done skip; post-approval race test; smoke asserts node completed, lease cleared, Notion Done |
| 19 | D23-15.6 (23-04): refused/error/unknown → one `{action: dod}` warning, `completed:false` with `dod-refused`/`dod-unavailable`, node stays `started_review`, lease kept | ✓ VERIFIED | Per-reason tests assert node state + lease retention; leak test covers connector POST, tracker writes, warnings, and the tool reply |
| 20 | D23-16 (23-04): only the connector ever moves an issue to Done; force never closes Linear from this repo | ✓ VERIFIED | Forced completion asserts `close`-mirror effects (labels removed, Agent cleared) with Linear state untouched; smoke asserts force clears labels without moving toward Done |
| 21 | D23-22 (23-05): `graph_find` — at-least-one-ref validation, id-first then identifier with limit 2, zero/several → `found:false` naming candidates, one → `found:true` with ids, repo/branch/status, node with `lease_id: null`, public lease view only | ✓ VERIFIED | Priority, ambiguity-naming (limit-2 evidence), nulled-lease + JSON-wide lease-id absence, emission-silence tests |
| 22 | D23-23 (23-05): `issue_get` — node text through shared `redact()`, title ≤500 / description ≤20000 with `…[truncated]`, exact `UNTRUSTED ISSUE TEXT` banner; Linear-off/no-ref/read-failure → `found:false` | ✓ VERIFIED | Boundary-cap tests, exact-banner test, `redact()`-wiring test on both fields (no new redactor — redact lock green), all five `found:false` reasons |
| 23 | D23-24 (23-05): both tools MCP-only (no REST twin), in `KNOWN_TOOLS`, silent, audit fail-open | ✓ VERIFIED | `mcp.test.ts` lists + pass-through tests; `observe.test.ts` label pins; `event-sources.ts` untouched (Phase 23 silent rows used as-is) |
| 24 | D23-26 tracker block (23-06): opt-in `HERMES_LINEAR_URL`/`LINEAR_API_URL`/`NOTION_API_URL` all through `assertLoopback`, random scratch keys per build, never host keys, off by default | ✓ VERIFIED | 4 `rehearsal-env.test.ts` cases (absent-by-default, loopback round-trip through real `loadConfig`, per-key non-loopback refusal, randomness + host separation) |
| 25 | D23-26 smoke (23-06): `bun run smoke:mirror` sources only `consumer.env`, refuses production ports/hosts, drives claim → refused second claim → release → reclaim → silent heartbeat → dod-required → dod-approval → steal → force → reap → swarm against loopback fakes with wire-level assertions | ✓ VERIFIED | Re-run 2026-10-10 from a detached `bfde32f` worktree (production checkout refused by the guard): twin `p23verify` on `:17423`, **38/38 checks passed**, twin torn down (2 containers removed, worktree removed) |
| 26 | D23-27 (23-06): MIRROR-08 live-proof runbook on SWC-467 with 60 s read-only checks, approval-gated, zero executed live results | ✓ VERIFIED | `docs/runbooks/mirror-proof.md` header gates on operator approval; evidence table is NOT RUN; Free-plan cap respected (no new issue). Live run is the single operator-gated remainder |
| 27 | D23-28 + docs (23-06): `bun test` + `tsc` + `check:phase-close` green; `mirror.failed` sample `op:"comment"` → `"claim"` and `lease.release.dod` sample → implemented `{tests_pass, review_pass, summary_chars}` fixed table-side; Tracker mirror section replaces the `:321-325` no-Linear-client note | ✓ VERIFIED | `check:phase-close` pass (4 locks green, EVENT_KINDS 12, SURFACES 27); old note gone; tool descriptions state the dod requirement, swarm edge, and silent releases |
| 28 | September ownership-model symbols absent; leaf-import discipline holds | ✓ VERIFIED | `grep -n "ownershipRefusal\\|lostClaim\\|setNodeState" mirror.ts` empty (re-run 2026-10-10); `dod-gate.ts` imports no service/index-store/lease; `tsc` clean |
| 29 | Results against the baseline | ✓ VERIFIED | 2026-10-10 at `bfde32f`: full `bun test` **2706 pass / 58 skip / 1 fail (98 files)** — the 1 fail is known F-01 (`rehearsal.test.ts` cwd-sensitive `--port 7410` refusal-order assertion, phase-16 scope), recorded not fixed per operator rules. (+1 pass vs the 2705 contract baseline from phase-22 scope additions; no new failure.) |
| 30 | Locks unedited and green; no unrecorded surface | ✓ VERIFIED | `check:phase-close` pass; `store/vocabulary/redact` lock tests green (69-pass batch incl. rehearsal-env); `bunx tsc --noEmit` exit 0 |

**Score:** 30/30 truths verified.

### Deferred Items

- The **live MIRROR-08 proof** on `SWC-467` (claim, refused second claim, release, complete without DoD, complete with DoD, each checkable within 60 s by read-only reads). It writes to real Linear/Notion through the production substrate and connector, so per operator rules it waits for an operator-approved window with `substrate-mcp` deployed via `infra/vps/deploy-release.sh`, Phase 20 surface tokens, and the connector on `:8792`. Fully scripted in `docs/runbooks/mirror-proof.md`; explicitly NOT RUN in this phase.

## Gate Evidence (run 2026-10-10 at `bfde32f`)

| Gate | Result |
|---|---|
| `git pull --ff-only` | Already up to date at `bfde32f` |
| `bunx tsc --noEmit` | exit 0 |
| full `bun test` | 2706 pass / 58 skip / 1 fail (98 files) — the 1 fail is known F-01, phase-16 scope, recorded not fixed |
| phase test files (`mirror`, `linear`, `notion`, `config`) | 91 pass / 0 fail |
| `dod-gate`, `service`, `server.authority`, `mcp`, `observe`, `index-store.lease` test files | 364 pass / 31 skip (live-PG) / 0 fail |
| `rehearsal-env`, `redact-lock`, `vocabulary-lock`, `store-lock` test files | 69 pass / 0 fail |
| `bun run check:phase-close` | pass (4 locks green, EVENT_KINDS 12, SURFACES 27) |
| isolated proof (detached `bfde32f` worktree, twin `p23verify` on `:17423`, `smoke:mirror`, `rehearsal down`) | 38/38; torn down (2 containers removed, worktree removed) |
| wiring spot-checks | no ownership-model symbols in `mirror.ts`; `MirrorContext` carries scalars, zero `lease_id`; startup `[substrate] mirror: linear on\|off, notion on\|off` via `describe()`; runbook approval gate + NOT RUN evidence row |

No hot-path change: the mirror runs awaited inside claim/release/complete tool calls on tracker-linked nodes only; `POST /events` and `POST /brief` paths are untouched, so the perf gate does not apply.

## Review

- **Code review (carried from the phase branch):** two Greptile rounds closed on the branch (`9545403`, `7e8bf9e`) before PR #36 merged; no new review findings on verification (no code delta since merge — `8c028c3` is an ancestor of `bfde32f`).
- **Security review (carried + re-spot-checked):** key/header redaction in tracker errors (status + ≤200 chars); lease-id structurally absent from all tracker/event/reply surfaces; writable-set refusal + data-source gate before every Notion PATCH; evidence-free completions never reach the connector; timeout settles via Linear state with the lease kept; rehearsal tracker URLs loopback-only with scratch keys.

_Verifier: Phase23Verify (verification-gates run at HEAD; no code delta)_

---

## Close-out sweep re-verification (2026-10-11, HEAD `ed696ef`, PR #53 merged)

Covered-file delta since the `60bd0c1` verify (6 files): phases 25/26/29 layered additive
registrations onto the shared model (`config.ts`, `index-store.ts`, `index.ts`, `mcp.ts`,
`observe.ts`, `service.ts`). Every phase-23-owned source (`mirror.ts`, `dod-gate.ts`,
`linear.ts`, `notion.ts`, `mirror-smoke.ts`) is byte-identical.

- Mirror files `bun test dod-gate + linear + mirror + notion`: **79 pass / 0 fail**.
- The deferred MIRROR-08 live proof still routes to the operator window via
  `docs/runbooks/mirror-proof.md` (unchanged).
- Shared gates at tip: `bun test` 3136 pass / 58 skip / 1 fail (F-01 only),
  `bunx tsc --noEmit` clean, pytest 246 passed, `check:phase-close` pass.

Verdict: 30/30 truths stand, no regressions, no new gaps. Digest refreshed to
`v3:sha256:56708720239c8b94984293b1ea75428b0c3a23f407ac03cd6fdf428e4004522e`.
