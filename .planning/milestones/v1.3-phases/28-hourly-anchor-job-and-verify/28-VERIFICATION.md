---
phase: 28-hourly-anchor-job-and-verify
verified: 2026-11-12T08:30:53Z
status: human_needed
score: 3/4 roadmap success criteria verified (SC4 live devnet half behavior-unverified; isolated fake-chain half recorded, not re-run)
covered_files: [".env.example", "docs/greptime-ledger.md", "infra/vps/README.md", "infra/vps/substrate-anchor.service", "infra/vps/substrate-anchor.service.d/10-environment.conf", "infra/vps/substrate-anchor.timer", "packages/cli/src/index.ts", "packages/ledger/src/rpc.test.ts", "packages/ledger/src/rpc.ts", "packages/mcp-server/src/anchor-run.ts", "packages/mcp-server/src/anchor.test.ts", "packages/mcp-server/src/anchor.ts", "packages/mcp-server/src/config.test.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/graph-bind.test.ts", "packages/mcp-server/src/greptime.test.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/mcp.test.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts", "scripts/doctor-units.test.ts", "scripts/greptime-smoke.ts", "scripts/rehearsal.test.ts", "scripts/rehearsal.ts"]
covered_digest: "v3:sha256:58b603cec5298e4031ac44fdc9981a93bd8c4daa0562a65c48f63961222bf731"
behavior_unverified: 1
overrides_applied: 0
behavior_unverified_items:
  - truth: "SC4 live half: a closed hour is anchored on devnet with memo root equal to the recomputed root, read back by tx_sig"
    test: "Run operator gates L1-L10 in 28-04-SUMMARY.md one at a time in an operator-approved window with a funded key"
    expected: "Timer-anchored hour; read-back memo signed by SOLANA_ANCHOR_PUBKEY matches root+count; substrate verify exits 0 with every hour anchored; second start sends nothing"
    why_human: "Requires a real devnet send and production ledger write; no live step was executed; 0-lamport send and memo program id remain [UNVERIFIED]"
re_verification:
  previous_status: passed
  previous_score: 20/20 must-haves verified
  gaps_closed: []
  gaps_remaining: ["live devnet anchor and read-back (SC4 live half, L1-L10 operator gates)"]
  regressions: []
  note: "Prior report said status passed while listing 2 behavior-unverified items; the Step 9 decision tree requires human_needed in that case. Re-derived here."
audit_acknowledged:
  milestone: v1.8
  at: 2026-11-22
  status: human_needed
---

# Phase 28: Hourly Anchor Job and Verify Verification Report

**Phase Goal:** Each closed hour is anchored exactly once on Solana devnet, and anyone can check a graph's events against those anchors.
**Verified:** 2026-11-12T08:30:53Z
**Status:** human_needed
**Re-verification:** Yes. Prior VERIFICATION.md (2026-10-11) re-derived against current code.

## Goal Achievement

Must-haves: the four ROADMAP success criteria (contract) plus plan-level truths in 28-01..04-PLAN.md. Evidence is code and tests, not SUMMARY claims.

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | SC1: hourly timer anchors previous hour idempotently; re-run adopts a signer-checked memo; root mismatch alarms and exits 1 | ✓ VERIFIED | `infra/vps/substrate-anchor.timer:9-10` (OnCalendar=hourly, Persistent=true); adopt/alarm tests in `packages/mcp-server/src/anchor.test.ts` pass |
| 2 | SC2: anchor sent via solana CLI, keypair path only, devnet only; writes `anchors` row with the named fields | ✓ VERIFIED | `anchor.test.ts` send-path block pins `transferMemoArgv`; `NewAnchor.cluster` typed `"devnet"`; `greptime.test.ts` anchors block passes. ROADMAP says "ten fields", plan says 11 columns (extra `stale_hashes`, NULL) |
| 3 | SC3: `substrate verify` and `POST /verify` check the chain and compare recomputed root with the memo read by `tx_sig`; `pending` up to 3 h; `unverified` fail-closed | ✓ VERIFIED | `packages/mcp-server/src/service.ts:791` (`VERIFY_PENDING_MS = 3 * HOUR_MS`), `:714` (HourStatus union), `:8155-8163` (pending/unverified emission); `service.test.ts -t verifyGraph` 68 pass |
| 4 | SC4: closed hour anchored on devnet with memo root equal to recomputed root; one altered event makes verify exit 1 naming the hour; untouched graph verifies; re-run adopts | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Fake-chain half: recorded 47/47 isolated run in `28-04-SUMMARY.md` (not re-run here). Live devnet half: `28-04-SUMMARY.md` LIVE-GATED section, L1–L10 all DEFERRED; no devnet send, no timer installed |
| 5 | Plan 01: D28-07 preconditions run before first send (absolute keypair, pubkey equality, devnet genesis hash, balance) | ✓ VERIFIED | `packages/ledger/src/rpc.ts:115-116, 250` (`getGenesisHash`); `anchor.test.ts` preconditions block and `rpc.test.ts` devnet URL refusal block pass |
| 6 | Plan 01: config — `SOLANA_RPC_URL`, `SOLANA_ANCHOR_KEYPAIR`, `SOLANA_ANCHOR_PUBKEY`, `SOLANA_CLI`; missing config exits 2 | ✓ VERIFIED | `packages/mcp-server/src/config.ts`; `config.test.ts` SOLANA_* block passes; `.env.example` carries the four names |
| 7 | Plan 02: verify returns hour report; `buildGraphEvidence` stays chain-only (`anchors: false`) | ✓ VERIFIED | `packages/mcp-server/src/observe.ts` (anchors-off call); `service.ts:764` option type; `service.ts:7783` empty-ledger path |
| 8 | Plan 03: units — Type=oneshot, no Restart=, timer Persistent; drop-in loads substrate.env; no secret values | ✓ VERIFIED | `infra/vps/substrate-anchor.service:12-13`; `infra/vps/substrate-anchor.timer:9-10`; drop-in present; `doctor-units.test.ts` passes |
| 9 | Plan 04: fake-chain tamper proof runs in rehearsal harness with no SOLANA_* names | ✓ VERIFIED (recorded, not re-run) | `scripts/greptime-smoke.ts` present; harness not started here (needs scratch stores); evidence is `28-04-SUMMARY.md` 47/47 |

**Score:** 3/4 roadmap success criteria verified; 1 behavior-unverified (SC4 live half). Plan-level truths 5–9 verified by tests or recorded evidence as noted.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/anchor.ts` | Anchor orchestration | ✓ VERIFIED | Present; tests pass |
| `packages/mcp-server/src/anchor-run.ts` | Thin entry point | ✓ VERIFIED | Present; ConditionPathExists target in unit |
| `packages/mcp-server/src/greptime.ts` | Typed anchors + graphIngest | ✓ VERIFIED | Present; greptime tests pass (prior run; not re-run here) |
| `packages/ledger/src/rpc.ts` | `getGenesisHash` | ✓ VERIFIED | `rpc.ts:115-116, 250` |
| `infra/vps/substrate-anchor.service` | oneshot unit | ✓ VERIFIED | `Type=oneshot`, no `Restart=` |
| `infra/vps/substrate-anchor.timer` | hourly timer | ✓ VERIFIED | `OnCalendar=hourly`, `Persistent=true` |
| `infra/vps/substrate-anchor.service.d/10-environment.conf` | env drop-in | ✓ VERIFIED | Present |
| `docs/greptime-ledger.md`, `infra/vps/README.md` | docs | ✓ VERIFIED | Present |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `substrate-anchor.timer` | `substrate-anchor.service` | `Unit=` | ✓ WIRED | Timer names the service |
| `anchor-run.ts` | `anchor.ts` run() | import + exit code | ✓ WIRED | Covered by anchor tests |
| `verifyGraph` | `GreptimeClient.graphIngest` → hour verdicts | service.ts | ✓ WIRED | service tests exercise hour report |
| `POST /verify` / `events_verify` / `cmdVerify` | `verifyGraph` | server.ts / mcp.ts / cli | ✓ WIRED | Grep-confirmed; CLI exit codes not harness-tested |
| Live: timer → devnet read-back → verify | operator window | — | ✗ NOT EXERCISED | Live-gated; see Behavior Not Verified |

### Data-Flow Trace (Level 4)

Not applicable: no dynamic UI rendering in this phase.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Anchor, RPC, config and doctor-units tests | `bun test packages/mcp-server/src/anchor.test.ts scripts/doctor-units.test.ts packages/ledger/src/rpc.test.ts` | 111 pass, 0 fail | ✓ PASS |
| verifyGraph hour-report block | `bun test packages/mcp-server/src/service.test.ts -t verifyGraph` | 68 pass, 0 fail | ✓ PASS |
| Fake-chain tamper proof (rehearsal harness) | not run here | recorded 47/47 in 28-04-SUMMARY.md | ? SKIP |
| Live devnet anchor | operator gates L1–L10 | DEFERRED | ? SKIP (human) |

### Probe Execution

No `scripts/*/tests/probe-*.sh` declared or present for this phase. Skipped.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| ANCHOR-03 | 28-01, 28-03 | Hourly timer, idempotent adopt, root-mismatch alarm exit 1 | ✓ SATISFIED | SC1 evidence |
| ANCHOR-04 | 28-01 | Solana CLI send, keypair path only, devnet, anchors row | ✓ SATISFIED | SC2 evidence; production DDL reconciliation not re-checked |
| ANCHOR-05 | 28-02, 28-03 | verify / POST /verify hour statuses, pending ≤3 h, unverified fail-closed | ✓ SATISFIED | SC3 evidence |
| ANCHOR-06 | 28-04 | Live devnet proof + isolated tamper proof | ? NEEDS HUMAN | Isolated half recorded (47/47); live half DEFERRED |

No orphaned requirements: REQUIREMENTS.md maps ANCHOR-03..06 to Phase 28.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/anchor.ts` | 318, 680 | Null devnet slot stored as 0 (REVIEW IN-03) | ℹ️ Info | No verdict impact today |
| `packages/mcp-server/src/service.ts` | 2977-3015 | `checkHour` does not compare `row.signer`/`row.cluster` (REVIEW IN-01) | ℹ️ Info | Defence-in-depth only |
| `packages/mcp-server/src/anchor.ts` | 476-490 | `--period --dry-run` previews "would anchor" for an already-anchored hour (REVIEW IN-02) | ⚠️ Warning | Misleading preview only |
| `packages/mcp-server/src/anchor.ts` | 57, 70, 255 | Funding gate checks one fee for up to 24 sends (REVIEW IN-04) | ℹ️ Info | Bounded partial progress by design |

Debt-marker scan (TBD/FIXME/XXX) over anchor.ts, anchor-run.ts, service.ts, greptime.ts, rpc.ts, greptime-smoke.ts: none. No stubs found.

### Human Verification Required

### 1. Live devnet anchor (SC4 / ANCHOR-06 live half)

**Test:** Run gates L1–L10 in `28-04-SUMMARY.md`, one at a time, in an operator-approved window with a funded key.
**Expected:** Timer anchors a closed hour holding a fresh proof graph; read-back memo signed by `SOLANA_ANCHOR_PUBKEY` equals recomputed root+count; `substrate verify <graph>` exits 0 with every hour anchored; second `systemctl start` sends nothing; `anchor-run.ts --period <H>` adopts without a send; memo program id confirmed on devnet (settles D27-06).
**Why human:** Needs real devnet transactions, production ledger writes, and systemd install, all operator-gated.

### 2. Production GreptimeDB acceptance of anchors write cadence

**Test:** After operator deploy and timer enable, observe 24 anchor inserts/day against production GreptimeDB v1.1.4.
**Expected:** One row per hour; no duplicate writes; no store-failed loop in `anchor.failed`.
**Why human:** Scratch proof ran on v0.14.4 only.

### 3. CLI verify output and exit codes

**Test:** `substrate verify <graph>` against a running substrate, with an anchored graph and a tampered one.
**Expected:** One chain line plus one per hour in D28-19 format; exit 0 when ok, 1 otherwise, 2 on usage.
**Why human:** `cmdVerify` has no exit-code harness test (open gap from prior report).

### Gaps Summary

No FAILED truths and no missing or stub artifacts. Status is `human_needed`, not `passed`, because:

- SC4's live half (devnet anchor, read-back, live verify) is unexecuted and operator-gated (L1–L10 DEFERRED).
- `28-REVIEW.md` CR-01 says the phase must not be sealed until L1–L10 run or the operator explicitly defers them as `human_needed`. That matches this verdict. It is a process gate, not a code defect.

The prior report's `status: passed` with `behavior_unverified: 2` contradicted the Step 9 decision tree and is superseded here.

---

_Verified: 2026-11-12T08:30:53Z_
_Verifier: Claude (gsd-verifier)_
