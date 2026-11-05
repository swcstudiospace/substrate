---
phase: 70-docs-slo-and-eval
verified: 2026-11-05T07:10:30Z
status: human_needed
score: 4/5 must-haves verified
covered_files: [".planning/phases/70-docs-slo-and-eval/70-SUMMARY.md", "docs/corpus-eval.md", "docs/runbooks/docs-rag-operations.md", "infra/vps/substrate-docs-canary.service", "infra/vps/substrate-docs-canary.timer", "packages/corpus/fixtures/eval/manifest.json", "packages/corpus/src/eval-lexical.ts", "packages/corpus/src/eval-live.ts", "packages/corpus/src/eval.ts", "packages/corpus/src/slo.ts", "packages/mcp-server/src/corpus/slo.ts", "packages/mcp-server/src/docs-eval-server.ts", "packages/mcp-server/src/fabric/status.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/metrics-history.ts", "packages/observability/src/instruments.ts", "scripts/docs-eval.baseline.json", "scripts/docs-eval.test.ts", "scripts/docs-eval.ts", "scripts/docs-golden.ts", "scripts/docs-lint.test.ts", "scripts/docs-lint.ts", "scripts/planning-integrity.test.ts"]
covered_digest: "v3:sha256:a6ba22afee6f3cd2a3db04179cf493f7444b6fd84f487bee37a3db82386a5b33"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 4/5
  gaps_closed: []
  gaps_remaining: []
  regressions: []
  digest_refresh: "covered_digest v3:sha256:74d374bb... (ca9d02ec) to v3:sha256:a6ba22af... (42e3cf13): the H-1 change (9e6fa1f2, 42e3cf13 docs) rewrote the SUBSTRATE_BRIEF_SNAPSHOT_TTL_S text in packages/mcp-server/src/flag-registry.ts, a covered file. No criterion changed."
deferred: []
advisory: []
behavior_unverified_items: []
coincidental_reliance_items: []
human_verification:
  - test: "Criterion 5 clause 2 on a live plane: on a host with SUBSTRATE_CORPUS=on and the LightRAG backend, ingest this checkout's docs/ under SUBSTRATE_DOCS_EVAL_REPO, then run substrate corpus eval --root /root/src/repos --server \"$SUBSTRATE_URL\" --json."
    expected: "The runbook question and its heading questions are scored; the runbook's key is in the top 5."
    why_human: "Needs a live plane and a real ingest. Nothing in code asserts it."
  - test: "Canary install and first run (operator gate; the timer is staged, not installed)."
    expected: "Journal line golden recall@5 <value> over <n> questions, exit 0, and fabric_status corpus row shows recall5.reading."
    why_human: "Host install and a secret-bearing env file; not in this repository."
---

# Phase 70: Docs SLO and eval Verification Report

**Phase Goal:** The docs plane's quality is measured, guarded in CI and operable by someone who did not build it.
**Verified:** 2026-11-05T07:10:30Z
**Status:** human_needed
**Re-verification:** Yes. Head 42e3cf13 (prior record at ca9d02ec). The only change since ca9d02ec to a covered file is the one-line `SUBSTRATE_BRIEF_SNAPSHOT_TTL_S` text in `flag-registry.ts` from the H-1 change. Criteria 1 to 4 are carried forward with a re-audit of the changed lines; criterion 5 is unchanged.

## Inputs and Scope

- Worktree: `/root/src/worktrees/as-gsd-v18-all`, branch `gsd/v18-int-all`, HEAD `42e3cf13`.
- Must-haves: the five ROADMAP success criteria for phase 70 (`.planning/ROADMAP.md`, Phase 70 block). No PLAN files exist for this phase.
- Covered-file fingerprint: `node /root/.agents/gsd-core/bin/gsd-tools.cjs query verification.fingerprint .planning/phases/70-docs-slo-and-eval <23 covered files>` run at `42e3cf13`. The fingerprint adds `70-SUMMARY.md` itself. `covered_files` and `covered_digest` above are copied verbatim from that output.
- Drift scope: `git diff 835a2742..HEAD -- <covered files>` touches one file, `packages/mcp-server/src/flag-registry.ts` (1 line changed). The other 22 covered files are byte-identical to 835a2742.
- Postgres: none. No file in the covered list or in the re-run set is Postgres-gated (`SUBSTRATE_TEST_PG_URL` absent from every file below). No PG run was made.
- Commands run (non-PG): (T1) `bun test` on the six SC3 targeted files, 191 pass, 0 fail, 2331 expect() calls; (T2) `bun test` on `packages/mcp-server/src/flag-registry.test.ts`, `scripts/config-reference.test.ts`, `scripts/docs-eval.test.ts`, `scripts/docs-lint.test.ts`, `scripts/planning-integrity.test.ts`, 110 pass, 0 fail, 706 expect() calls. Plus read-only `git diff`, `grep`, and the fingerprint query. Not run: full suite, `tsc`, lint, formatters.

### Drift since the `ca9d02ec` record

- `flag-registry.ts` (`SUBSTRATE_BRIEF_SNAPSHOT_TTL_S`, l.632): the `unset` text now describes the in-process last-good brief window and the forget trade-off. Brief-plane docs text only. No docs-plane flag, default, or allowed value changed. The `SUBSTRATE_DOCS_SLO_SYNC_LAG_S` entry (l.898) and the `SUBSTRATE_CORPUS_FRESH_MAX_AGE_S` entry (l.881) are unchanged. Re-audited: no effect on truths 1 to 5. `scripts/config-reference.test.ts` passes against the regenerated `docs/config-reference.md` (T2).
- `service.ts` is not a covered file, but it carries claims cited here. The H-1 diff (+53/-8) adds `inProcessLastGood`, `rememberLastGood` and the forget handling on the brief path. It does not touch `emit`, `corpusFreshness`, or `corpusFreshnessRow` wiring. The line numbers moved: `emit` to `recordSyncLag` is now l.3005 (was l.2961), `corpusFreshness` is now l.7528 to l.7536. Re-audited: the wiring holds.
- `docs/observability.md` and `docs/config-reference.md` are not covered and not cited by any claim here.

## Goal Achievement

### Observable Truths

The must-haves are the five ROADMAP success criteria for phase 70. No PLAN files exist for this phase.

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | `generateGolden` derives queries from titles and headings with the expected key; `scoreRun` computes recall at k, MRR and latency; `scripts/docs-eval.ts` runs them live and offline | ✓ VERIFIED (carried forward) | Covered files `packages/corpus/src/eval.ts`, `eval-lexical.ts`, `eval-live.ts`, `scripts/docs-eval.ts`, `scripts/docs-eval.test.ts` have no diff since 835a2742. `scripts/docs-eval.test.ts` passes (T2). Wording note: the live flag is `--live URL`. |
| 2 | Offline harness (lexical retriever over fixtures) runs in `bun test` and fails on ranking, dedupe or re-rank regression | ✓ VERIFIED (carried forward) | Same files unchanged; `scripts/docs-eval.test.ts` passes (T2). Caveat unchanged: `scripts/docs-eval.baseline.json` is self-supervised and reads 1.0 on every metric. |
| 3 | Ingest throughput, sync lag and retrieval quality are metric series with SLO thresholds in flags; `fabric_status` reports a breach and is the contract for sync lag; the docs canary judges retrieval recall only; the staged canary timer runs `docs-eval` | ✓ VERIFIED (amended 2026-11-04, owner decision c) | Clause by clause, against the amended text. (a) Series with flags: `corpus.ingest_docs_per_s` (`SUBSTRATE_DOCS_SLO_INGEST_DOCS_PER_S`), `corpus.golden_recall5` (`SUBSTRATE_DOCS_SLO_RECALL5`), `corpus.sync_lag_seconds` (`SUBSTRATE_DOCS_SLO_SYNC_LAG_S`) in `packages/corpus/src/slo.ts` (`loadSloThresholds`, `sloBreaches`). (b) `fabric_status` breach: `packages/mcp-server/src/fabric/status.ts` names `sync` when the sync reading exceeds its objective; `corpus/slo.ts` `readings().syncLagS` feeds `FabricFacts.corpus`. (c) Canary judges recall only: `scripts/docs-golden.ts` reads the `recall5` objective alone. (d) Staged timer: `infra/vps/substrate-docs-canary.service` runs `docs-golden.ts`, which imports `measureGoldenRecall` from `docs-eval.ts`; the timer is staged, not installed. (e) docs.freshness route: `docs-freshness.ts` `corpusFreshnessRow` names `sync_lag` over `SUBSTRATE_DOCS_SLO_SYNC_LAG_S` (l.184 to 188); `service.ts` `corpusFreshness` (l.7528) passes the threshold (42dcb4c6). The SC3 targeted tests pass: 191 pass, 0 fail (T1). |
| 4 | Test fails on a broken relative link in `docs/` and `.planning/` (archives included) and on a missing level-1 title in `docs/` and live `.planning/` files | ✓ VERIFIED (carried forward) | `scripts/docs-lint.ts`, `scripts/docs-lint.test.ts`, `scripts/planning-integrity.test.ts` unchanged since 835a2742; `scripts/docs-lint.test.ts` and `scripts/planning-integrity.test.ts` pass (T2). The H-1 docs edits add no relative link and no new level-1 title. |
| 5 | `docs/runbooks/docs-rag-operations.md` covers deploy, first ingest, timers, rollback and the proving command for each step, and the golden set has a case for each new runbook and the eval finds it | ? UNCERTAIN (WARNING, operator-gated) | The runbook has no diff since 835a2742. Clauses 1 and 2 of the runbook text are unchanged. Clause 2 (the eval finds the runbook) needs a live plane; see Human Verification item 1. |

**Score:** 4/5 must-haves verified (SC1, SC2, SC3, SC4). SC5 UNCERTAIN (operator-gated). `behavior_unverified: 0`.

### Deferred Items

None. No phase after 70 in ROADMAP.md (v1.8 phases 71 to 78) names the canary, the golden set or the runbook. Phase 65 (earlier) owns the docs.freshness route; it is cited as evidence for criterion 3 (e), not deferred.

### Advisory (New Scope, Unevidenced)

No advisory items.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/corpus/src/slo.ts` | sync-lag threshold, breach | ✓ VERIFIED | `syncLagS` optional threshold; `sloBreaches` `sync` breach; unset = no verdict. |
| `packages/mcp-server/src/corpus/slo.ts` | sync reading state | ✓ VERIFIED | `recordSyncLag`, `readings().syncLagS`. |
| `packages/mcp-server/src/fabric/status.ts` | corpus row carries sync | ✓ VERIFIED | `syncLag` detail; breach named `sync`. |
| `packages/mcp-server/src/metrics-history.ts` | `corpus.sync_lag_seconds` series | ✓ VERIFIED | Extended tier, max per step; gauge source wired. |
| `packages/mcp-server/src/docs-freshness.ts` | sync breach on the freshness warning | ✓ VERIFIED | `corpusFreshnessRow` adds `sync_lag`; test-covered (`docs-freshness.test.ts`, T1). Not in the covered list. |
| `scripts/docs-golden.ts` | canary judges recall only | ✓ VERIFIED | Reads `recall5` objective alone; no sync reading. |
| `infra/vps/substrate-docs-canary.{service,timer}` | staged canary runs the golden/docs-eval path | ✓ VERIFIED | Staged, not installed (operator step). `ExecStart` is `docs-golden.ts`, which imports `docs-eval.ts`. |
| `packages/mcp-server/src/flag-registry.ts` | flag entries | ✓ VERIFIED | `SUBSTRATE_DOCS_SLO_SYNC_LAG_S` entry present (l.898); `SUBSTRATE_BRIEF_SNAPSHOT_TTL_S` text refreshed by H-1 (l.632), flag-registry.test.ts passes (T2). |
| `scripts/dashboards.ts`, `infra/vps/dashboards/substrate-data-planes.json` | sync-lag panel | ✓ VERIFIED | Panel present; `scripts/dashboards.test.ts` passes (T1). Not in the covered list. |

### Key Link Verification

| From | To | Via | Status |
| ---- | -- | --- | ------ |
| `service.ts` `emit` | `corpus/slo.ts` `recordSyncLag` | stored `docs.sync` note | ✓ WIRED (l.3005; was l.2961 before H-1) |
| `corpus/slo.ts` readings | `fabric/status.ts` `corpusRow` | `FabricFacts.corpus` | ✓ WIRED |
| `service.ts` `corpusFreshness` | `docs-freshness.ts` `corpusFreshnessRow` | `docsSlo.syncLagS` and the corpus sync reading | ✓ WIRED (l.7528 to 7536) |
| `docs-golden.ts` | `docs-eval.ts` `measureGoldenRecall` | import | ✓ WIRED |

### Requirements Coverage

No REQUIREMENTS.md row was re-checked this run beyond the EVAL-01..05 mapping already in the ROADMAP phase block. EVAL-03 is the criterion 3 clause; it is judged against the amended text above.

### Anti-Patterns Found

None in the SC3 changed set. The baseline caveat (self-supervised, reads 1.0) remains a documented limitation, not a stub.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| SC3 targeted tests (slo, corpus slo, fabric status, docs-freshness, metrics-history, dashboards) | `bun test` on the six files | 191 pass, 0 fail, 2331 expect() calls | ✓ PASS |
| Flag registry, config reference, docs-eval, docs-lint, planning integrity | `bun test` on the five files | 110 pass, 0 fail, 706 expect() calls | ✓ PASS |

### Human Verification Required

1. **Criterion 5 clause 2 on a live plane.** Test: ingest this checkout's `docs/` under `SUBSTRATE_DOCS_EVAL_REPO` on a live LightRAG plane, run `substrate corpus eval --root /root/src/repos --server "$SUBSTRATE_URL" --json`. Expected: the runbook's key is in the top 5. Why human: needs a live plane and a real ingest.
2. **Canary install and first run (operator gate).** Test: install `substrate-docs-canary.{service,timer}` and the drop-in, set `SUBSTRATE_DOCS_CANARY=1` and the attested manifest, run `systemctl start substrate-docs-canary.service`. Expected: journal line `golden recall@5 <value> over <n> questions`, exit 0, and the `corpus` row of `fabric_status` shows `recall5.reading`. Why human: host install and a secret-bearing env file.

### Gaps Summary

No BLOCKER. Criterion 3 is VERIFIED against the amended text. Criterion 5 remains UNCERTAIN (WARNING, operator-gated), so the phase status is `human_needed`.

### Open Items

1. Criterion 5 clause 2: live ingest and eval (Human Verification item 1).
2. Canary install and first run: operator gate (Human Verification item 2). The timer is staged by design.
3. Live sync-lag read is not exercised: the `corpus` row breach is verified by pure-function tests, not on a live plane with a real `docs.sync` note.
4. The covered list is used verbatim per the orchestrator. SC3 files outside it, covered by targeted tests and not by `covered_digest`: `packages/mcp-server/src/docs-freshness.ts`, `packages/mcp-server/src/docs-freshness.test.ts`, `packages/mcp-server/src/service.ts` (H-1 added brief-path code; its SC3 wiring is unchanged and re-audited here), `packages/mcp-server/src/config.ts`, `packages/mcp-server/src/fabric/types.ts`, `scripts/dashboards.ts`, `infra/vps/dashboards/substrate-data-planes.json`, `packages/corpus/src/slo.test.ts`, `packages/mcp-server/src/corpus/slo.test.ts`, `packages/mcp-server/src/fabric/status.test.ts`, `packages/mcp-server/src/metrics-history.test.ts`.
5. The timer's `ExecStart` runs `scripts/docs-golden.ts`, not `scripts/docs-eval.ts` by name. Criterion 3 (d) is judged met through the shared `measureGoldenRecall` import. Owner to confirm if the wording must name the file.
6. The covered digest changed from `v3:sha256:74d374bb...` (ca9d02ec) to `v3:sha256:a6ba22af...` (42e3cf13) only because of the H-1 one-line text change in `flag-registry.ts`.

---

_Verified: 2026-11-05T07:10:30Z_
_Verifier: Claude (gsd-verifier)_
