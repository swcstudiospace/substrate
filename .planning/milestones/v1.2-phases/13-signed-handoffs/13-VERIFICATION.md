---
phase: 13-signed-handoffs
verified: 2026-10-08T04:11:34Z
status: passed
score: 5/5 must-haves verified
source_commit: f2686c7d8995c6e500417031c99d9d4418455238
refresh_of: 2026-10-07T22:44:46Z
---

# Phase 13 Verification: Signed handoffs

Goal: context that crosses an accountable-agent boundary is written down by its sender and can be replayed from the ledger alone.

## Success criteria (ROADMAP)
| # | Criterion | Evidence | Result |
|---|-----------|----------|--------|
| 1 | Every accountable-agent boundary writes one packet (`goal`, `files`, `dod` from `acceptance[]`, `blockers`, `graph_id`, `node_id`) with the sender's own token | `test_substrate_handoff.py`: exact caller per packet, relabelled packet verifies `bad-signature`, no own token sends nothing; live: one packet per boundary, each from its sender | passed |
| 2 | A receiving agent's context is rebuilt from `coord_handoff_list` and `events_query` alone, proven by a test | Unit test with the Task Store and swarm dir removed and an audit hook on file and sqlite opens: exactly two calls as A14; live: A14's `a14.py` rebuilds goal, dod, blockers and files with nothing opened locally | passed |
| 3 | With `SUBSTRATE_HANDOFF_KEY` unset, packets are recorded unsigned, say so, and the run completes | Unit: a full `swarm_run.run()` with no key ends DONE ×2, packet unsigned, `handoff.unsigned` once, prompt says UNSIGNED | passed |
| 4 | A killed A05 replica's node is claimed by a second A05 within one TTL, shown as a `warning`, never two holders | Final live proof under CPU load: `stolen` 25.3 s after SIGKILL (TTL 30 s), holder sequence exactly r1 → r2, r2's hold starts no earlier than r1's last expiry, epoch +1, one `warning` | passed |
| 5 | A05 hands a failed gate to A14 with the swarm bus stopped; A14 rebuilds the task from the ledger alone | Live: escalation signed and verified with `k1`, `lease_handover` true and no id, release after the packet; no broker process; A14 reconstructs and claims the node | passed |

## Requirements
| ID | Evidence | Status |
|----|----------|--------|
| HAND-01 | Criterion 1 | satisfied |
| HAND-02 | Criterion 2 | satisfied |
| HAND-03 | Criterion 3 | satisfied |
| PROOF-02 | Criteria 4 and 5, `/tmp/p13-proof.sh` 49/49 against the merged Phase 11 server | satisfied |

## Historical implementation proof
`/tmp/p13-proof.sh` (agent-substrate `main` 1791393 on 127.0.0.1:7496, real Postgres and GreptimeDB): 49/49 PASS after the final Phase 12 lease fixes. Evidence: `/tmp/p13-proof-1791408817`, 34 driver checks plus 15 receiving-agent checks. Final Phase 13 full Python suite: 705 passing.

## Formal audit remediation

- Corrected source: agent-swarm `ce13342`. A reentrant per-task transition lock holds escalation through stored handoff and settlement; restart dedupe rejects untrusted/malformed or wrong-node packets. Packet fitting preserves bounded boundary keys and accounts for routing/envelope bytes.
- Parent gates: 757 Python tests, generator current, TypeScript contract 1/1 and changed-file Ruff all passed. Controlled keeper interleavings cover both escalation paths and stored, refused, failed and unreachable handoffs.
- Fresh real proof: 49/49 (34 driver + 15 receiver), isolated 7499 against the Phase 11 server, 66.86 seconds; `/tmp/p13-proof-1791412554`. Under eight CPU loops, the keeper retained the lease beyond its first TTL; after SIGKILL the successor acquired it in 25.6 seconds with TTL 30 seconds and exactly one holder transition across 236 samples.
- Ledger order was handoff `22:37:00.480Z` then release `22:37:00.501Z`. A14 reconstructed with no broker and no local Task Store/run log. This is deterministic runtime proof, not a full LLM run.
- [Nyquist validation](13-VALIDATION.md) is compliant; [ASVS-L1 security](13-SECURITY.md) closes all eight threats without accepted risks. PR shipping is separately gated.


## Goal reassessment — 2026-10-08T03:29:27Z (exact head `f2686c7`)

**Source binding (observed, not claimed).** Product read-only root `/root/src/worktrees/agent-swarm-p13`,
`git rev-parse HEAD` = `f2686c7d8995c6e500417031c99d9d4418455238`
(`fix(handoffs): preserve rework across delayed and uncertain writes`, 3 files:
`docs/substrate-handoffs.md`, `swarm/substrate_handoff.py`, `tests/test_substrate_handoff.py`).
Integrated-substrate server root `/root/src/worktrees/agent-substrate-p14` at
`a9d699e9e70ee7f112a4fe793572852054eff572`. Canonical planning owner is this worktree.
Inputs: `local://p13-oct08-review-evidence.json` plus the parent review/provenance receipt
appended to `13-01-SUMMARY.md` ("Exact-head review correction — 2026-10-08", read after that
append; this timestamp postdates it). Method: static source review only — no tests, builds, lint,
runtime calls, network, or git mutations. Native `.py` LSP references were attempted and no language
server exists, so all references below were traced by direct read/grep at the exact head.

**What `f2686c7` changes over `ce13342` (exact diff, reviewed in full).** A protected signed
logical-time header (`BOUNDARY_TIME_PREFIX`, `swarm/substrate_handoff.py:47`; `boundary()` takes
`occurred_at`, `:181-192`): dispatch anchors to the task's immutable `created_at` (`:437`), rework
and escalation anchor to the transition's `updated_at` (`:463`, `:492`); current-boundary selection
uses `_boundary_time` (`:100`), falling back to signed packet `ts` for older packets, while the packet
list stays in ledger storage order. Uncertain writes refresh persisted keys with a revision fence
(`_keys_revision`/`_loaded_keys_revision`/`_inflight`, `:260-261`; `_ledger_keys` `:282-312`;
`_send`/`_write` `:333-412`): a lost reply re-reads before retry, an unanswered list defers, locally
confirmed marks and in-flight reservations survive, and a snapshot crossed by another uncertain write
is discarded. Receiving rows must also pass `_valid_packet` (`:85`) or list as `malformed` rejected
(`reconstruct`, `:536-584`). Nothing in the lease-authority or signature protocol changes; all other
product files are byte-identical to `ce13342`.

### Success criteria re-trace at `f2686c7`

| # | Criterion | Exact-head evidence | Result |
|---|-----------|---------------------|--------|
| 1 | Every accountable-agent boundary writes one packet with `goal`/`files`/`dod` from `acceptance[]`/`blockers`/`graph_id`/`node_id`, sent with the sender's own token | `_send` refuses without `has_own_token` (`:333-358`); `_write` emits `handoff.misattributed` on recorded-identity mismatch (`:369-412`); boundaries `dispatched`/`gate_failed`/`escalated` (`:421-502`); sender-identity tests H01-H03 plus rerun spoof test (`tests/test_substrate_handoff.py:217-265,685-709`) | passed |
| 2 | Receiver context rebuilt from `coord_handoff_list` + `events_query` alone, proven by test | `reconstruct` issues exactly those two `_call`s and no Task Store/bus read (`:536-584`); current = newest signed logical time (`:571-582`); malformed rows rejected (`:558-566`); ledger-only test with deleted state + open-audit hook (`:460-498`), tampered-packet test (`:495-505`), 4 malformed-receiving-row tests (`:624-642`) | passed |
| 3 | Key unset → unsigned, said so, run completes | `say_unsigned`/`handoff.unsigned` once + UNSIGNED prompt section in `_write`/`render` (`:369-412`, `:584-604`); full-run unsigned test (`:651-683`); unsigned parametrizations in late-dispatch (2 of 8) and rerun tests | passed |
| 4 | Killed A05 replica's node claimed by second A05 within one TTL, `warning`, never two holders | Keeper/lease paths untouched by `f2686c7` (3-file commit); runtime evidence is retained-49 (qualified below) plus fake-clock replica tests retained in source | passed (implementation present; live proof retained, not re-run at head) |
| 5 | A05 failed gate → A14 with bus stopped; A14 rebuilds from ledger alone | `gate_failed`/`escalated` store-before-release via `release_lease` + `handed_over` (`swarm/results.py:267-300`, `swarm/substrate_lease.py:617-625`); retained-49 reconstruction leg (qualified below) + 4 changed-path real-server checks (new provenance below) | passed (implementation present; full leg retained, changed paths freshly exercised) |

### Requirements

| ID | Status | Basis |
|----|--------|-------|
| HAND-01 | satisfied | Criteria 1 + fenced handover + restart dedupe all present at head |
| HAND-02 | satisfied | Criterion 2, including logical-time current selection and malformed-row rejection |
| HAND-03 | satisfied | Criterion 3 |
| PROOF-02 | satisfied | Criteria 4-5: full 49-check leg retained on intermediate tree (qualified); 4 changed-path scenarios freshly proven on real server at final logic (below) |

### New14 consumer regressions registered (all present in `tests/test_substrate_handoff.py` at head)

- 8 late/redispatch signed/unsigned: `test_late_dispatch_retry_cannot_replace_newer_rework` (`:507-533`;
  `signing_key` × `reworks` × `delivery` = 2×2×2; flush and regenerated-redispatch paths, one and two reworks).
- 1 lost committed reply: `test_stored_handoff_with_lost_reply_is_not_written_again` (`:536-561`;
  reply lost after actual storage, transport reset, `flush()==0`, single `handoff_id`, context intact).
- 1 interleaved refresh: `test_ledger_refresh_keeps_a_concurrently_confirmed_boundary` (`:564-621`;
  concurrent write + lost-reply flush + key refresh, no duplicate, no loss).
- 4 malformed receiving rows: `test_malformed_receiving_row_cannot_hide_good_handoff` (`:624-642`;
  bad `from`/`to`/shape/`dod`, good handoff still drives, corrupt row listed rejected).

Failing-before controls for these corrections: `artifact://112`, `artifact://114`, `artifact://129`,
`artifact://131` (parent-reported; one lost-reply case refined to reset the transport breaker, then proved
an actual duplicate — per evidence receipt).

### New execution provenance (parent-reported, not executed by this refresher)

- Full Python suite: **771 passed, 0 failed, 94.10 s** (`python3 -m pytest -q -o addopts=''`);
  Ruff clean on `swarm/substrate_handoff.py` + `tests/test_substrate_handoff.py`. A docstring-wording-only
  change landed mid-run; source was then committed/pushed as `f2686c7` with no later semantic change.
- Changed-path runtime: **4/4** against real isolated Postgres `:55432` + GreptimeDB `:54000`, server at
  `a9d699e` on `:7512` (graph `ut-muyyxewt-3f8b2d21`, root `/tmp/p13-review-real-m9092cl5`): late queued
  dispatch preserves signed current rework (packet `hof_845466c4f0e24e11a9587f2fc413b72e`); committed
  handoff with lost reply stays one signed ledger packet after fresh read (packet
  `hof_80c45d04fed5489fadfadfb2d3bafda4`); regenerated redispatch cannot supersede rework; controlled
  malformed receiving reply cannot hide valid signed handoffs. Fixture tokens/HMAC key only, not production.

### Retained proof — explicitly qualified, not relabeled

- Retained S2 proof **49/49 in 67.05 s** (`artifact://119`, bundle `/tmp/p13-proof-1791428380`, server
  `a9d699e` on `:7511`; 8 CPU loops, keeper held beyond 35 s, takeover 24.9 s within 30 s TTL, 231 samples,
  one holder transition, epoch +1, handoff `03:00:47.236Z` before release `03:00:47.250Z`, separate-process
  A14 ledger-only recovery) ran on the **intermediate review-fix tree BEFORE the final cache-generation and
  immutable-creation-anchor refinements**. It is NOT a 49-case run at final `f2686c7` and must not be cited
  as one. It remains applicable history because `f2686c7` touches only handoff send/receive/tests/docs —
  keeper, takeover, and A14 claim paths are unchanged — and its changed paths carry the fresh 771/4-scenario
  proof above.
- Older evidence is likewise retained, not refreshed: 757-test/49-check `ce13342` closure (25.6 s takeover,
  236 samples), 705-test/25.3 s original proof, generator-current + TypeScript 1-test/6-assertion receipts,
  and the integrated-substrate bun bundle (1171 tests / 4489 assertions / 40 files). None is re-executed at
  `f2686c7`; none needs to be, since `f2686c7` contains no TS, generator, server, or lease-keeper change.

### Nine-task coverage — all in State A (implemented + test-bound + no open gap at head)

Tasks 1 (own-token seam), 2 (lease seam + `handed_over`), 3 (bridge + logical-time + fenced refresh +
shape validation), 4 (tee warning mapping), 5 (guarded reconcile/escalation), 6 (runner wiring + flush),
7 (25 test functions incl. 14 new + retained keeper/escalation matrix), 8 (docs incl. corrected
`boundary-at`/refresh/malformed-row contract), 9 (proof: retained-49 + fresh 771 + fresh 4-scenario).
Per-task source binding is recorded in `13-VALIDATION.md`'s exact-head refresh section.

### Verdict

**Status stays `passed` (5/5, HAND-01..03 + PROOF-02 satisfied).** Current code at `f2686c7` genuinely
meets all five criteria and all four requirements; no source gap was found, so no blocker is filed.
Explicit non-claims: no new security verdict (parent is sole `SECURITY.md` writer; threat posture unchanged
— no lease-authority or signature-protocol cutover); no merge claim (PR #10 review run 30258836 pending);
no full-LLM-run or ledger-corruption claim (malformed scope is a controlled upstream response); milestone
remains unshipped pending PR #10 and the two Phase 14 deliveries.

## Delivery receipt verified — 2026-10-08T04:11:34Z

Parent validated the terminal receipt after updating SUMMARY. The independent goal reassessment above remains the `03:29:27Z` source review, not a new test/security execution. Exact executable source is unchanged at `f2686c7d8995c6e500417031c99d9d4418455238`.

PR[10](https://github.com/swcstudiospace/agent-swarm/pull/10) **MERGED** at `2026-10-08T03:38:42Z`, squash `3e513c9539d31611ef2f7a3c12247330a84aa0c5`; configured Greptile round2 **5/5, zero comments**, both `ci/test` runs and Greptile Review SUCCESS. Independent current security gate returned SECURED,8/8 closed,zero opens/accepted risks; see13-SECURITY.md. The earlier pending-review statement is the historical worker checkpoint.

Remote source branch deleted; local main sync refused because the Phase12 worktree owns main, preserved untouched. Notion/Linear receipts were synchronized before the next branch's assessment. Phase13 delivery is complete; both Phase14 deliveries and milestone audit/archive/approved cleanup remain.
