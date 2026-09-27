---
phase: "6"
slug: "ledger"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-09-26"
---

# Phase 6 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Seeded from `06-RESEARCH.md` § Validation Architecture, reconciled with the locked decisions
> D-01..D-12 in `06-CONTEXT.md`, the orchestrator-approved D-13..D-16 (research Open Questions 1-4),
> and plans 06-01..06-09 (test file names below are the ones the plans create). Research's plan
> numbers 06-02..06-07 map to 06-04/06-05 (chain + cutover), 06-02 (core), 06-06 (tracer), 06-07
> (verify), 06-08 (timer) and 06-09 (proof); 06-03 is the key/funding/memo-spike half of research's
> 06-01. The criterion and decision coverage matrices are in `COVERAGE.md`.
>
> **Revision 2026-09-27 — anchoring skipped by the owner (D-17, SPE-3970).** At 06-03's funding
> checkpoint the owner answered (verbatim) "Skip Phase 6 anchoring": the devnet key could not be
> funded. **skipped-owner (D-17):** ROADMAP SC2 (hourly timer → devnet memo → `anchors` rows), SC3's
> signature clause ("checks roots against signatures"), D-12 step 2's anchor wait and (b)'s anchor
> catch, 06-03 Task 2 (memo spike), 06-06, 06-08, and the anchor/signer/pending/unverified half of
> 06-07 (D-14, D-16). Still validated: SC1, SC3's chain clause, and the proof on the chain alone.
> Remaining order: 06-01, 06-02, 06-03 (summarized; its Task 2 skipped-owner) → 06-04 (wave 2) → 06-05 (wave 3) → 06-07 (wave 4,
> revised) → 06-09 (wave 5, revised).

---

## Test Infrastructure

Phase 6 touches `packages/mcp-server` (event, types, greptime, chain, service, index), the
`packages/ledger` package (merkle, memo, period, solana, rpc — 06-02, unused on-chain after D-17;
digest, store, anchor and cli are not created), `packages/cli` (verify only) and live state (Greptime
`agent_events` and the empty `anchors`, `/etc/substrate/substrate.env` and the unfunded devnet key
from 06-03, substrate-mcp). No `infra/vps` timer, no `/etc/systemd/system` change and no devnet
transaction (D-17). Phase 6 runs **after Phases 4 and 5** (Phase 5
as its desktop half only: the owner skipped the docs half on 2026-09-27, SPE-3970); 06-01's gate takes
04/05-VERIFICATION `passed` or an orchestrator acceptance quoted verbatim, and `phase45-symbols`
needs only "skill.propose" and "docs.ingest" in types.ts and `skills propose` in the CLI (no
`docs ingest`); its baseline is measured then (06-01), never copied.

| Property | Value |
|----------|-------|
| **Framework (TS)** | `bun test` (repo root, colocated `*.test.ts`) + `bunx tsc --noEmit` (root tsconfig includes `packages/**/*.ts`, so every ledger module is type-checked). No `resolveJsonModule`: the fixture is read with `readFileSync`. |
| **Framework (Python)** | `packages/dispatcher` pytest — untouched by Phase 6; regression gate only. |
| **Static (systemd)** | `/usr/bin/systemd-analyze verify` on the repo unit files (checked clean on the planned text during planning). |
| **Live reads** | Greptime through `sudo systemd-run … -p EnvironmentFile=/etc/substrate/substrate.env … bun -e` (no `$` or `%` in inline code — systemd expands them); the service through `curl 127.0.0.1:7410` and the `substrate` CLI. Devnet reads were used only by 06-03 (airdrop, balance); none remain after D-17. |
| **Quick run command** | `SUBSTRATE_DISABLED=1 /root/.local/share/reflex/bun/bin/bun test packages/ledger packages/mcp-server/src/chain.test.ts packages/mcp-server/src/event.test.ts packages/mcp-server/src/greptime.test.ts packages/mcp-server/src/service.test.ts` |
| **Full suite command** | `cd /root/src/repos/agent-substrate && SUBSTRATE_DISABLED=1 /root/.local/share/reflex/bun/bin/bun test && /root/.local/share/reflex/bun/bin/bunx tsc --noEmit && (cd packages/dispatcher && python3 -m pytest -q)` |
| **Estimated runtime** | < 30 s per suite (the live proof excluded) |

| Repo / package | Quick run command | Baseline (last recorded at `9eef1ee`; re-measured by 06-01 into `06-BASELINE.md`) |
|---|---|---|
| agent-substrate (TS) | `SUBSTRATE_DISABLED=1 /root/.local/share/reflex/bun/bin/bun test` | 338 pass / 0 fail, 22 files (before Phases 4-5; re-measured) |
| agent-substrate (tsc) | normalized `bunx tsc --noEmit` pipeline (03-BASELINE.md) | exit 0 (re-measured) |
| dispatcher (Python) | `cd packages/dispatcher && python3 -m pytest -q` | 149 passed (re-measured) |
| live: POST /verify over every graph | 06-01 probe | 18/18 ok at planning time (3,831 rows, 89 graph rows) — re-measured as `baseline-ok-graph:` lines |

Two-sided rule (standing): every code task diffs failing ids and the normalized tsc set against
`06-BASELINE.md`; a failure or type error that **disappears** fails the gate like a new one; the pass
count must exceed `agent-substrate-pass` (every code task adds tests). The dispatcher gate runs in
06-04 T3, 06-07 T2 and 06-09 T3. The live `baseline-ok-graph` set must stay ok after the
substrate-mcp cutover and at every later live step (06-05 T2, 06-07 T2, 06-09 T3).

Execution note: `.planning/config.json` has `workflow.use_worktrees: false`, so the two wave-1 plans
(06-02, 06-03) run sequentially on the main tree; their file
sets are disjoint (`phase-plan-index 6`: no same-wave overlap). 06-03 paused for the owner at its
Task 2 precondition (funded key); the owner answered "Skip Phase 6 anchoring" (D-17), so 06-06 and
06-08 are marked not executed and nothing remaining needs the key. The remaining chain is linear:
06-04 → 06-05 → 06-07 → 06-09 (waves 2-5); 06-06 and 06-08 keep their original wave/depends_on
text but carry a NOT EXECUTED revision note.

---

## Sampling Rate

- **After every task commit:** the targeted test file(s) (each task's `<automated>` starts with them).
- **After every code task:** full `bun test` + normalized tsc, two-sided against 06-BASELINE.md.
- **Live smoke per plan:** the key=value lines in `06-01-SPIKE.md`, `06-03-SPIKE.md`, `06-05-CUTOVER.md`, `06-07-SMOKE.md`, `06-PROOF.md`, each checked by the plan's verify, plus a fresh live read (Greptime or the CLI) that must agree with the evidence. `06-06-TRACER.md` and `06-08-SMOKE.md` are never written (skipped-owner, D-17).
- **Before `/gsd:verify-work`:** all suites green against the baseline, every evidence file complete, `06-PROOF.md` with `proof_result=pass`.
- **Max feedback latency:** 30 seconds for unit gates.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Criterion / Decision | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|----------------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 06-01-01 | 01 | 0 | standing rules (baseline, RESTORE), D-03, req. 4 (historical graphs) | T-06-01-01, -03 | fixture re-scanned by redact() and a token-shape grep; env only via `grep -c`; id.json only via `stat` | live measure | key checks on 06-BASELINE.md; fixture sha256/jq counts; `sha256sum -c` of the snapshot manifest | ❌ W0 | ⬜ pending |
| 06-01-02 | 01 | 0 | D-08, D-09 (A3, A4) | T-06-01-02 | DDL only on `p6_scratch_<stamp>_*`; RESTORE first | live spike | 06-01-SPIKE.md keys + live information_schema read (0 scratch tables, agent_events unchanged) | ❌ W0 | ⬜ pending |
| 06-02-01 | 02 | 1 | D-10 | T-06-02-05 | 0x00/0x01 domain separation | unit | `bun test packages/ledger/src/merkle.test.ts` (8 reference roots) | ❌ | ⬜ pending |
| 06-02-02 | 02 | 1 | D-09, D-10 | T-06-02-03 | anchored memo regex; half-open hours | unit | `bun test packages/ledger/src/memo.test.ts packages/ledger/src/period.test.ts` | ❌ | ⬜ pending |
| 06-02-03 | 02 | 1 | D-06, D-04, discretion (every memo program ID) | T-06-02-01, -02, -03, -04 | argv only, v1 memo + two amounts only, key never opened; RPC timeouts | unit (fake Runner, fake fetch) | `bun test packages/ledger/src/solana.test.ts packages/ledger/src/rpc.test.ts`; package.json unchanged | ❌ | ⬜ pending |
| 06-03-01 | 03 | 1 | D-04, D-05 | T-06-03-01, -02, -03 | `--silent` keygen, no `--force`, guarded appends, 0600 snapshot | live | 06-03-SPIKE.md keys; `stat`, `grep -cx`, `solana-keygen pubkey`, `solana config get`, id.json stat | ❌ | ⬜ pending |
| 06-03-02 | 03 | 1 | D-05 (funding gate), D-06 (A1, A2) | T-06-03-05 | spike memo cannot parse as v1; owner asked only via the precondition-unmet checkpoint when unfunded | live devnet | 06-03-SPIKE.md keys + fresh getTransaction (err null, signer, memo program) | ❌ | ⏭️ skipped-owner (D-17: "Skip Phase 6 anchoring"; key unfunded, no memo sent) |
| 06-04-01 | 04 | 2 | D-01, D-03, D-09, req. 4 | T-06-04-01, -05 | ingested_at absent (never null) on old rows; input cannot set id/hash/prev/ingested_at | unit (real-row fixture) | `bun test packages/mcp-server/src/event.test.ts`; SURFACES/EVENT_KINDS entries kept | ✅ extend | ⬜ pending |
| 06-04-02 | 04 | 2 | D-02, D-08, D-09, req. 3; discretion (batched INSERT, ts := ingested_at, client-ts guard) | T-06-04-02, -03, -04, -06 | NULL-safe keys; DROP only on empty old schema | unit | `bun test packages/mcp-server/src/greptime.test.ts packages/mcp-server/src/chain.test.ts` ("batches queued emits into one insert", "stays under the hook budget") | ❌ | ⬜ pending |
| 06-04-03 | 04 | 2 | D-02, D-03 (clean cutover) | T-06-04-07 | per-session writer path removed | unit | `bun test packages/mcp-server/src/service.test.ts …`; no `lastHash`/`insertEvent(` left; dispatcher pytest | ✅ extend | ⬜ pending |
| 06-05-01 | 05 | 3 | D-08 (anchors re-created empty, stays 0 rows under D-17), D-09 | T-06-05-01, -02 | schema guard vs 06-01 snapshot; RESTORE written first | live DDL | 06-05-CUTOVER.md keys + live `columns()` read | ❌ | ⬜ pending |
| 06-05-02 | 05 | 3 | D-01, D-02, D-03, req. 3 (live latency), req. 4 (live) | T-06-05-03, -04, -05 | guarded restart; throwaway smoke graph | live | CUTOVER keys; live post-cutover null-prev count; POST /verify loop over baseline-ok graphs and the smoke graph | ❌ | ⬜ pending |
| 06-06-01 | 06 | 4 | D-08, D-10; discretion (recomputed leaves, stale flag) | T-06-06-02 | leaves recomputed, stale counted | unit | `bun test packages/ledger/src/digest.test.ts packages/ledger/src/store.test.ts` | ❌ | ⏭️ skipped-owner (D-17) — plan not executed |
| 06-06-02 | 06 | 4 | SC2 (job), D-06, D-07, D-13, D-15 — **tracer** | T-06-06-01, -03, -04, -05, -06 | key/pubkey check and unfunded check before any send; adopt, never re-anchor | unit + live devnet | `bun test packages/ledger/src/anchor.test.ts`; 06-06-TRACER.md keys; fresh getTransaction; anchors row; `cli.ts status` | ❌ | ⏭️ skipped-owner (D-17) — plan not executed |
| 06-07-01 | 07 | 4 | SC3 chain clause, D-11 chain half, D-17 | T-06-07-01, -02 | thin POST (one `post("/verify"…)`); own 60 s verify timeout; brief/emit keep 1.5 s; no ledger/greptime import | throwaway canned server + gate | 06-07-SMOKE.md `cli_*` keys; import diff since baseline head; full gate two-sided | ❌ | ⬜ pending |
| 06-07-02 | 07 | 4 | SC3 chain clause, req. 4 (live) | T-06-07-03 (accepted residual) | read-only live; no restart | live | 06-07-SMOKE.md `smoke_hour_chain=ok`, `pre_cutover_graphs_verified=N/N`, `verify_max_ms`; live CLI output has no anchor/devnet word; dispatcher pytest | ❌ | ⬜ pending |
| ~~06-07 (anchor half)~~ | 07 | — | SC3 signature clause, D-14, D-16, signer discretion item | — | — | — | removed from the plan (ledger-verify.ts, config.ledger, verifyGraph anchor check, 7419 dead-RPC instance) | — | ⏭️ skipped-owner (D-17) |
| 06-08-01 | 08 | 5 | SC2 (timer), D-07, D-13 | T-06-08-01, -02 | absence guard; RESTORE first; hardening | static + live | `systemd-analyze verify` (empty); repo vs /etc `diff`; `is-enabled`/`is-active`/Persistent | ❌ | ⏭️ skipped-owner (D-17) — plan not executed |
| 06-08-02 | 08 | 5 | D-07 | T-06-08-03, -04 | RPC failure writes nothing | live | 06-08-SMOKE.md keys; LastTriggerUSec; Result=success; journal `[ledger]` line | ❌ | ⏭️ skipped-owner (D-17) — plan not executed |
| 06-09-01 | 09 | 5 | Proof, D-12 step 1 (step 2 skipped-owner, D-17); chain-only design for (b) | T-06-09-01, -04 | originals captured (0600) before any write; successor located before any write | live | 06-PROOF.md setup keys (`b_detectable_by_chain=true`, `middle_successor*`); CLI verify `hour H chain ok` | ❌ | ⬜ pending |
| 06-09-02 | 09 | 5 | Proof, D-12 (a) + step 4 | T-06-09-01, -02 | read-back before verify; restore byte-equal | live | 06-PROOF.md (a) keys (`hash does not match contents` at event 2, `a_hour_chain=broken`); live rows_equal=3/3; CLI verify exit 0 | ❌ | ⬜ pending |
| 06-09-03 | 09 | 5 | Proof, D-12 (b) on the chain alone + step 4; D-01, D-04, D-06, D-17 (phase-end scope) | T-06-09-01..06 | restore byte-equal; no producer/dependency change; anchors empty | live + full gate | 06-PROOF.md (b)/final keys (`b_broken_at` = successor, `prev does not match the preceding event`, `b_caught_by=chain-prev-linkage`, `anchors_rows_final=0`, `sc2_status`/`sc3_signature_clause=skipped-owner-D-17`); path checks; baseline graphs; full gate + dispatcher | ❌ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky · ⏭️ skipped-owner (D-17)*

---

## Wave 0 Requirements

- [ ] `06-BASELINE.md` — bun/tsc/dispatcher two-sided keys, live Greptime and Solana inventory, `baseline-ok-graph:` lines (06-01 Task 1).
- [ ] `packages/mcp-server/src/fixtures/pre-cutover-rows.json` — every row of the baseline-ok graphs, re-scanned, sha256 in the baseline (06-01 Task 1; used by 06-04 Task 1).
- [ ] `/var/lib/substrate/phase6-baseline/` (0700) with `RESTORE.md` index, `RESTORE.d/06-01.md`, verbatim `SHOW CREATE TABLE` copies (06-01 Task 1).
- [ ] Greptime scratch-table spike → `06-01-SPIKE.md` (A3, A4; 06-01 Task 2).
- ⏭️ ~~Memo spike (A1, A2) — 06-03 Task 2~~ — skipped-owner (D-17): the key was never funded and no memo was sent; nothing remaining depends on it.
- [ ] No npm/pip/cargo install anywhere in the phase (research: Bun.CryptoHasher, fetch, execFile, solana-cli only); 06-02 and 06-09 check the manifests.

---

## Manual-Only Verifications

| Behavior | Criterion | Why Manual | Test Instructions |
|---|---|---|---|
| Funding the devnet key when the RPC airdrop is refused | D-05 | faucet.solana.com forbids AI agents; no other funding route on the host | **Resolved by owner skip (D-17).** 06-03 Task 2's precondition was unmet (airdrops refused, PoW faucet did not build, 0 lamports); at the checkpoint the owner answered "Skip Phase 6 anchoring" (`owner_funding=owner-skip`, `spike_result=skipped-owner`). No manual step remains. |
| ~~Waiting for the hourly timer to anchor the proof hour~~ | D-07, D-13, D-12 step 2 | — | skipped-owner (D-17): no timer and no anchor; 06-09 verifies the proof hour immediately on the chain alone. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or are owner checkpoints with presence-only verification
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all ❌ W0 references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] Baselines re-measured before the first edit (06-01); gates two-sided against 06-BASELINE.md
- [ ] Every live edit outside the repo preceded by a snapshot and a RESTORE.d route
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
