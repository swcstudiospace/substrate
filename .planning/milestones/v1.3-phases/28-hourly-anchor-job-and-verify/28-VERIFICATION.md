---
phase: 28-hourly-anchor-job-and-verify
verified: 2026-10-11T02:10:00Z
status: passed
score: 20/20 must-haves verified
covered_files: [".planning/phases/28-hourly-anchor-job-and-verify/28-01-PLAN.md", ".planning/phases/28-hourly-anchor-job-and-verify/28-01-SUMMARY.md", ".planning/phases/28-hourly-anchor-job-and-verify/28-02-PLAN.md", ".planning/phases/28-hourly-anchor-job-and-verify/28-02-SUMMARY.md", ".planning/phases/28-hourly-anchor-job-and-verify/28-03-PLAN.md", ".planning/phases/28-hourly-anchor-job-and-verify/28-03-SUMMARY.md", ".planning/phases/28-hourly-anchor-job-and-verify/28-04-PLAN.md", ".planning/phases/28-hourly-anchor-job-and-verify/28-04-SUMMARY.md", ".env.example", "docs/greptime-ledger.md", "infra/vps/README.md", "infra/vps/substrate-anchor.service", "infra/vps/substrate-anchor.service.d/10-environment.conf", "infra/vps/substrate-anchor.timer", "packages/cli/src/index.ts", "packages/ledger/src/rpc.test.ts", "packages/ledger/src/rpc.ts", "packages/mcp-server/src/anchor-run.ts", "packages/mcp-server/src/anchor.test.ts", "packages/mcp-server/src/anchor.ts", "packages/mcp-server/src/config.test.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/graph-bind.test.ts", "packages/mcp-server/src/greptime.test.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/mcp.test.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts", "scripts/doctor-units.test.ts", "scripts/greptime-smoke.ts", "scripts/rehearsal.test.ts", "scripts/rehearsal.ts"]
covered_digest: "v3:sha256:5a3fc737876e15a152a52ead68401aa63957fb1a214986deed36bd80bedd84a1"
behavior_unverified: 2
overrides_applied: 0
re_verification:
  previous_status: stale
  previous_score: 20/20
  gaps_closed: []
  gaps_remaining: ["devnet anchor store + verify behaviors (operator live window, L1-L10)"]
  regressions: []
---

# Phase 28: Hourly Anchor Job and Verify Verification Report

**Phase Goal:** Each closed hour is anchored exactly once on Solana devnet, and anyone can check a graph's events against those anchors.
**Verified:** 2026-10-10 (HEAD `35c8f5b`, `main` tip, origin synced)
**Status:** passed, with two behaviours that cannot be proved before the operator live window (listed under Behavior Not Verified).
**Base:** phase-28 merge `589a27c` (PR #35, ANCHOR-03..06) plus phases 22–27 and the 27 re-verification docs.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | ANCHOR-03 candidates: closed, non-empty, unanchored hours from coverage start ascending, cap 24, 7-day lookback; empty hours never written | ✓ VERIFIED | `anchor.test.ts` candidates-and-exits block (nothing-to-do, empty skip, pre-coverage exclusion, dedup, cap-24-ascending, coverage-unreachable); 38/38 anchor tests pass at tip |
| 2 | ANCHOR-03 failure split: per-hour digest failures continue; systemic failures (wrong cluster, signer mismatch, unfunded, rpc-unreadable, CLI/store failure) stop; exit 0 only when all anchored/adopted or nothing to do | ✓ VERIFIED | `anchor.test.ts` failures block (8 cases) plus digest-continues case; all green |
| 3 | ANCHOR-03 idempotence: adopt-before-send with `transactionMemo` confirm; same root+count adopts (`adopted:true`, nothing sent); different root+count alarms (row as found, root-mismatch, ALARM line, exit 1); `--period` re-run adopts without row write | ✓ VERIFIED | `anchor.test.ts` adopt-and-alarm block (adopt, alarm, unconfirmed-hint-sends, `--period` re-run adopt without row write) |
| 4 | ANCHOR-03 schedule: `substrate-anchor.service` (Type=oneshot, no Restart=) + `substrate-anchor.timer` (OnCalendar=hourly, Persistent=true) + environment drop-in; single instance by design; trigger-only-through-systemctl-start | ✓ VERIFIED | `doctor-units.test.ts` 18 pass pins the anchor shape; `doctor-units.ts --dry-run` reports no findings; timer literals read verbatim |
| 5 | ANCHOR-04 send path: transferMemoArgv unchanged (absolute CLI, self-transfer, `--with-memo`, `--url`, `--keypair`/`--fee-payer` path, confirmed, json via Runner, no shell); D28-07 preconditions in order; 0-lamport single-amount flow | ✓ VERIFIED | `anchor.test.ts` send-path block pins the argv flags and AMOUNT_ZERO flow; `NewAnchor.cluster` typed `"devnet"` (mainnet forbidden at the type level) |
| 6 | ANCHOR-04 row: production 11-column shape with `stale_hashes` NULL, cluster devnet, dedup by `period_start` | ✓ VERIFIED | `greptime.test.ts` anchors block (window read, single-period read, 11-column insert, coverage start); 91/91 pass |
| 7 | ANCHOR-04 events: `anchor.written` (note) and `anchor.failed` (warning) exactly as EVENT_SOURCES samples them, emitted in-process; CLI/RPC output in reasons passes through `redact()`; closed reason set | ✓ VERIFIED | `anchor.test.ts` asserts `session_id` `anchor:<YYYY-MM-DDTHH>`, action/runtime anchor, plus the `AnchorFailReason` closed union |
| 8 | ANCHOR-04 config: `SOLANA_RPC_URL` default, `SOLANA_ANCHOR_KEYPAIR`/`SOLANA_ANCHOR_PUBKEY` required, `SOLANA_CLI` default; missing config exits 2 with usage, sends nothing | ✓ VERIFIED | `config.test.ts` SOLANA_* block (defaults, four names, trim) + `parseAnchorArgs` usage errors; 27/27 pass; `.env.example` carries exactly the four names plus `SUBSTRATE_VERIFY_TIMEOUT_MS=30000` |
| 9 | ANCHOR-05 one verdict, three doors: `verifyGraph` hour report; `POST /verify`, `events_verify` and `substrate verify` return it; `buildGraphEvidence` passes `anchors:false` and stays chain-only | ✓ VERIFIED | Evidence anchors-off test plus chain-only bundle assertions in service/graph-bind/mcp/observe/server tests |
| 10 | ANCHOR-05 additive response: `ok`/`events`/`brokenAt`/`reason` keep meaning; `chain`, `hours[]`, `uncovered`, `legacy` added; `ok` true only when chain verifies, every hour anchored-or-pending, no uncovered post-coverage event | ✓ VERIFIED | `service.test.ts` verifyGraph hour-report block (16 cases: anchored, pending x2, unanchored, mismatch x5, unverified x3, legacy, uncovered, anchors-off, empty); 206/206 pass |
| 11 | ANCHOR-05 hour statuses anchored/pending/unanchored/mismatch/unverified per the memo triple-check; pending inside 3 h or hour open; unverified fail-closed | ✓ VERIFIED | Same 16-case block incl. the open-hour pending regression pinned after the first scratch run caught the digest-throw |
| 12 | ANCHOR-05 reads: graph events as today; ingest records from typed `graphIngest` by stored graph_id with first-record collapse; each distinct hour digested whole then checked once | ✓ VERIFIED | `greptime.test.ts` graphIngest block (first-record collapse, SQL shape) plus hour-report tests |
| 13 | ANCHOR-05 legacy/uncovered: pre-coverage record-less events are legacy (counted, never failing); post-coverage record-less events are uncovered and fail naming ids; empty coverage means all legacy | ✓ VERIFIED | Legacy/uncovered service tests; graph-bind + mcp ledger stubs on the empty-coverage legacy path |
| 14 | ANCHOR-05 bounded devnet reads: per-call timeout with bounded attempts, sequential hours (concurrency one), `SUBSTRATE_VERIFY_TIMEOUT_MS` whole-verify budget shared by the CLI/`/verify` request | ✓ VERIFIED | Config default 30000 with env override; budget-exceeded hours read `unverified` (unit-pinned via timeoutMs) |
| 15 | ANCHOR-05 surfaces: CLI one chain line plus one per hour with the D28-19 wording, exit 0 iff ok else 1 (2 on usage); D-era window keeps today's verify behaviour (no `verifyGlobalChain`; D-era events are pre-coverage legacy) | ✓ VERIFIED | `cmdVerify` reviewed against the D28-19 formats (no CLI exit-code harness — recorded gap, logic is a straight map over `hours[]`); `grep verifyGlobalChain` over sources finds nothing; D-era note in `docs/greptime-ledger.md` |
| 16 | ANCHOR-03/05 key discipline: production-key-only-by-production-unit; rehearsal harness never carries the key names; the fake-chain proof refuses non-loopback ledgers before any write | ✓ VERIFIED | README rehearsal warning plus ledger-doc key paragraph; smoke section 8 greps clean of the names; `rehearsal.test.ts` `refuseLedgerUrl` block (non-loopback refused, scratch loopback accepted, garbage refused) |
| 17 | ANCHOR-06 isolated proof: emit, anchor past the lag, untouched-verify all anchored, silent re-run, crash-adopt, tamper-mismatch naming the hour with chain intact | ✓ VERIFIED | Recorded isolated run 47/47 on scratch `greptime/greptimedb:v0.14.4` (`p28anchor --port 17441`, 2026-10-09, `28-04-SUMMARY.md`); send-then-crash (exit 1, 1 send, no row), adopt (row with found tx_sig, `adopted:true`, still 1 send), silent re-run, tamper-append (chain ok, hour `mismatch`) |
| 18 | ANCHOR-06 live proof runbook L1–L10 recorded with per-step gates, nothing executed, no devnet packet sent | ✓ VERIFIED | `28-04-SUMMARY.md` LIVE-GATED section: all ten steps DEFERRED with explicit gates; operator decision pending |
| 19 | ANCHOR-06 no overclaim: verification-status entry distinguishes fake-chain-proven from live-proven; rollback noted (proof-additive) | ✓ VERIFIED | `docs/greptime-ledger.md` Hourly anchor (Phase 28) entry plus rollback paragraph |
| 20 | Docs: README hourly-anchor section (units, drop-in, trigger rule, second-tick timing, D28-12 rehearsal warning, doctor line) and ledger-doc anchoring/verify/D-era record | ✓ VERIFIED | Anchoring (Phase 28) section in `docs/greptime-ledger.md`; `grep anchor` nonzero; store lock green |

**Score:** 20/20 truths verified.

### Behavior Not Verified

- **Live devnet proof (L1–L10, operator gates).** No real 0-lamport send has run, so the memo program id (D27-06 carryover) and the 0-lamport acceptance question stay **[UNVERIFIED]**; no timer installed/enabled, no production proof-graph written, no signer-checked read-back. Each L-step needs separate operator approval in an operator-approved window. Recorded verbatim in `28-04-SUMMARY.md`; not run here.
- **Production GreptimeDB v1.1.4 acceptance of the anchors write cadence.** Scratch proved the row shape on v0.14.4; the 24-sends-a-day write path against production v1.1.4 is only observable after the operator deploy + timer enable. `migrate()` never alters `anchors` (phase-27 pins), and the job degrades to per-hour failure lines, never a silent double-send.

## Gate Evidence

| Gate | Result |
|---|---|
| `bun install --frozen-lockfile` | no changes (111 installs across 107 packages) |
| `bunx tsc --noEmit` | exit 0 |
| full `bun test` | 2845 pass / 58 skip / 1 fail (106 files) — the 1 fail is the known pre-existing environmental `rehearsal.test.ts` `--port 7410` cwd-sensitive assertion (phase-16 scope, F-01 baseline) |
| anchor proofs: `anchor.test.ts` / `rpc.test.ts` / `config.test.ts` | 38 / 15 / 27 pass, 0 fail |
| hour selection + verify: `greptime.test.ts` / `service.test.ts` (incl. 16-case hour-report block, shuffle-determinism, empty-hour null) | 91 / 206 pass, 0 fail |
| locks: `store-lock.test.ts` (+ vocabulary/redact/event-sources/policy via phase-close) | 29 pass, 0 fail; `check:phase-close` pass (EVENT_KINDS 12, SURFACES baseline + substrate) |
| units: `doctor-units.test.ts` + `--dry-run` | 18 pass; dry-run reports no findings (the 4 known lane-B findings recorded in 28-03 are resolved on main) |
| flake probe, `--rerun-each 3` on ledger + anchor + greptime + store-lock | 624 pass / 0 fail |
| `pytest` | 230 passed |
| ledger byte-identity vs `acc30a8` | `merkle`, `memo`, `period`, `solana` (+ tests) identical via `cmp`; `rpc.ts` additive-only (`getGenesisHash` + 2 tests, no existing line altered) |
| scratch harness proof | NOT re-run — `rehearsal up` refuses from this checkout by design (`UNIT_WORKING_DIRECTORY` guard; same environmental root cause as F-01). Standing evidence: recorded 47/47 isolated run 2026-10-09 (28-04-SUMMARY); all unit-level pins re-proven green at this tip |

### Post-merge drift review (`589a27c..35c8f5b`)

Two phase-28 files changed after the phase-28 merge: `service.ts` +263/−5 (phases 25–26: docs commands, Hindsight recall merge) and `packages/cli/src/index.ts` +18 (phase 25 `docs ingest` command). Zero changed lines mention `verifyGraph`, `hours`, `anchor`, `hourDigest` or `graphIngest`; the verify/anchor paths are byte-untouched. All phase-28 unit pins green at the new tip (anchor 38, greptime 91, service 206, locks 29, flake 624/0, phase-close pass, tsc clean, pytest 230). Full suite matches the 2845/58/1 baseline exactly.

## Review

- **Code review (self):** 0 critical. The drift diff was read in full: additive commands and recall-merge only, no verify/anchor line altered. The recorded 28-02 gap stands (no CLI exit-code harness; logic is a straight map over `hours[]`).
- **Security review:** keypair path-only on argv, no shell, devnet genesis gate, pubkey equality gate; memo carries period_start, root, count only; keypair never opened or logged; CLI/RPC output in reasons passes through `redact()`; `refuseLedgerUrl` keeps fake-chain signatures off any non-loopback ledger; no new route, tool, token, dependency or environment variable beyond the four SOLANA_* names and the verify timeout.
- **Nyquist validation:** every requirement-level behaviour has an automated command that passed, except the two operator-gated behaviours above, which are recorded as DEFERRED with per-step gates — no silent pass.

## Operator Steps Recorded

L1–L10 deferred to an operator-approved window with a funded key (see `28-04-SUMMARY.md` for the verbatim per-step gates): env/key identity read-only checks, devnet balance, funding (~1 devnet SOL), missing SOLANA_* lines, deploy release holding Phases 27+28, install/enable `substrate-anchor.timer`, fresh proof-graph events, first real anchor (settles 0-lamport + memo program id), read-back and verify, re-run adopts. No secret value recorded anywhere: names, modes, balances, tx_sigs only when the window runs.

## Verification path (close-out)

Path A (verify-resume): all four PLANs carry SUMMARYs, code merged via PR #35 (`589a27c`, ancestor of HEAD), no prior VERIFICATION.md. Per close-out rules no plan was re-run (#2868): `init verify-work --phase 28` confirms implementation-complete / verification-missing with next action `/gsd-execute-phase 28` resuming at the gates. Gates only, live steps recorded verbatim, never run.

---

## Close-out sweep re-verification (2026-10-11, HEAD `ed696ef`, PR #53 merged)

Covered-file delta since the `e295746` verify (2 files): `packages/mcp-server/src/service.ts`
(the same phase-29 teachable +57, additive, awaited-caught) and
`scripts/doctor-units.test.ts` (+9/-1, phase-31 host-wiring accommodation). No anchor,
verify, RPC, config, graph-bind, or greptime line altered.

- `bun test ledger/rpc + anchor + config + graph-bind + doctor-units`: **118 pass /
  8 skip / 0 fail**; anchor-adjacent `mcp + greptime + service + rehearsal` files green
  in the 16/21/27 targeted runs.
- Standing gaps unchanged: the two devnet behaviors stay operator-gated
  (`behavior_unverified: 2`); no devnet write attempted.
- Shared gates at tip: `bun test` 3136 pass / 58 skip / 1 fail (F-01 only),
  `bunx tsc --noEmit` clean, pytest 246 passed, `check:phase-close` pass.

Verdict: 20/20 truths stand, no regressions, no new gaps. Digest refreshed to
`v3:sha256:5a3fc737876e15a152a52ead68401aa63957fb1a214986deed36bd80bedd84a1`.
