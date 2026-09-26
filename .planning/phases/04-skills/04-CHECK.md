---
phase: 04-skills
checked: 2026-09-26
iteration: 3
checker: gsd-plan-checker (independent; Check04)
plans_checked: 12
status: issues_found
blockers: 0
warnings: 0
info: 15
---

# Phase 4 (Skills) — plan check, iteration 3 (final)

Scope: 04-01 … 04-12 PLAN, 04-VALIDATION.md, 04-PATTERNS.md and COVERAGE.md, checked against
04-CONTEXT.md (D-01..D-21), 04-RESEARCH.md, ROADMAP § Phase 4 and the STATE.md standing rules.
Iteration 3 changed 04-03, 04-06..04-10, PATTERNS, COVERAGE and VALIDATION. All probes were
read-only. This file replaces 04-PLAN-CHECK.md, which `phase-plan-index` flagged as a misnamed plan.

**Result: no blockers and no warnings.** The 15 remaining items are INFO advisories, which
consuming gates do not count. Status is `issues_found` only because the checker contract never
marks an INFO-bearing result `passed`.

## Iterations 1–2 findings → resolution

| Finding | Where resolved | Verdict |
|---|---|---|
| B1 docs-scraper skill written through the symlink into /root/agent-skills | 04-10 T2: a `git archive` scratch copy under /var/lib/substrate/skills, with realpath and no-link checks. The PR's files and diff are verified, and the checkout must stay clean. The workspace link is kept by a recorded decision. | Resolved (iter 2) |
| B2 skill-autonomy baseline missed `.grok-plugin/` and overwrote `.gitignore` | 04-01 T2: stages git's `--others --exclude-standard` list and keeps `.gitignore`. Porcelain must be empty, and the undo removes only `.git`. Simulated: 42 listed = 42 tracked, status empty. | Resolved (iter 2) |
| W1 search-index idempotence | Ledger plus `gh pr view` / `gh pr list --head`; no search. | Resolved (iter 2) |
| W2 whole-tree replace / 413 | Overlay by default, a `remove` list, CLI-only `--replace`, a changed-files bridge, and 413 final for every caller. | Resolved (iter 2) |
| W3 Hermes-local writes deleted or proposed | Held for the owner, never unlinked or proposed. | Resolved (iter 2) |
| W4 VM guest could spend the PAT | Propose key or authenticated surface, required on both the route and the tool. The key is unreachable from guests. | Resolved (iter 2) |
| W5 hourly and precheck not observed | 04-07 records the binding with no manual run. 04-12 T1 reads back scheduled suppressed ticks. | Resolved (iter 2) |
| W6 RESTORE routes missing | 04-07 and 04-10 routes are written before each change. | Resolved (iter 2) |
| W7 no D-08 copy fallback | `onVmStart` copy route on `mount_route=none`. | Resolved (iter 2) |
| W8 Cursor "none" branch | Owner re-check at the merge checkpoint; `sc3_cursor_visible=true` required. | Resolved (iter 2) |
| W9 `--force` gate vs PATTERNS comment | Quoted-literal gate; comment reworded. | Resolved (iter 2) |
| W10 04-03 over budget | Split 04-03/04-04: 80k at ratio 0.80, 60k at ratio 0.60. | Resolved (iter 2) |
| **W11** Hermes could write the live checkout (write window; "approve locally") | **04-07 T1:** write_approval (skills and memory) goes on before external_dirs. The epochs are recorded, ordered `plan_start ≤ write_approval_on ≤ external_dirs_set`, and verified. A live foreground `skill_manage` patch on `objective-dev-loop` is observed staged, with the checkout still clean, and then discarded. **RESTORE:** the key-by-key route clears external_dirs *before* write_approval (verify greps `skills.external_dirs '[]'`), and the whole-file route restores both at once. **Held records:** each held line carries a `resolve` hint (CLI PR from a copy outside the checkout then `/skills reject`, or reject; never `/skills approve`); the oversize disposition says the same. **04-07 T3** never touches write_approval and requires `sync_dirty_refusals_since_start=0`, re-checked live with `journalctl --since @plan_start_epoch`. | **Resolved (iter 3)** |
| **I17** copy route could mark a partial copy current | **04-06 T1:** `copyLibraryInto` clears the marker first, creates dirs with `mkdir(recursive)`, collects `BatchWriteResult.success=false` into `failed`, and writes the marker only when `failed` is empty (tested). The verify greps `recursive: true`. Checked: rivet `_writeFiles` returns per-entry results and itself creates parent dirs (agentos-core agent-os.js L2881-2900). | **Resolved (iter 3)** |
| **I19** owner-closed proposals re-opened | **04-03:** a CLOSED (unmerged) ledger hit returns `declined` with that URL and no clone, push or create. Only the operator-only CLI `--reopen` bypasses it; it is never on the route or tool. See the caller matrix below. | **Resolved (iter 3)** |
| I5, I10, I14 | Isolated queue checks; surface validated; sibling write recorded. | Resolved (iter 2) |
| I1-I3 declared deviations; I4 VM `--bare` Gap | Unchanged. | Accepted |

### `declined` against every caller (I19 regression check)

| Caller | Handling of 200 `declined` | Evidence | Verdict |
|---|---|---|---|
| Route / MCP tool (04-03 T2) | Returns 200 with status declined; emits `skill.propose` | 04-03 L40, L115 | OK |
| CLI (04-03 T1) | Exits 0; `--reopen` bypasses; posts the event | 04-03 L119, L156 | OK |
| Hermes bridge, pending groups (04-07 T2) | Unlinks the records and logs `declined` with the PR (D-10 reject) | 04-07 L36, L166 | OK |
| Bridge queue drain (04-07 T2) | "removes it on 200", which covers declined | 04-07 L169 | OK (logging: I23) |
| Omp extension (04-08 T1) | Blocks with the declined reason, no pending file | 04-08 L24, L107, L112 | OK |
| Grok `skill-autonomy propose` (04-09 T1) | `{"status":"declined","pr_url"}`, no file, exit 0 | 04-09 L115, L121 | OK (report wording: I23) |
| docs-scraper `_propose_skill` (04-10 T1) | `propose_status=declined`, not an error, so `--resume-failed` skips it; never passes `--reopen` | 04-10 L77 | OK |
| Proof (04-12) | Not reachable: a new session means new content. A "closed" answer at T4 repeats T3 with a new session. | 04-12 T4 | OK |

## Findings (iteration 3)

| # | Severity | Plan / task | Issue (evidence) | Required fix |
|---|---|---|---|---|
| I4 | info | 04-01 T3 / 04-06 | Accepted Gap: the VM's Claude runs `--bare` (03-01 `b_skills=no`, `b_skill_by_path=yes`), so skills are readable by path, not auto-loaded. On the sibling and copy routes the library is at `/home/agentos/agent-skills`, which no VM prompt mentions. | — |
| I6 | info | 04-RESEARCH L404 | `## Open Questions` still has no `(RESOLVED)` marker; the resolutions are D-17..D-20. | — |
| I7 | info | 04-07 T3, 04-08 T2, 04-09 T2 | The named entry points are not run live: Hermes `/learn` is exercised by a direct gate call, Omp `learn` and the Grok Stop hook by unit tests only (declared). | — |
| I8 | info | 04-02 T3 (redact-high) | `redactSkillContent(...).text` also applies non-high-confidence redactions, which is more than the owner option describes. | — |
| I9 | info | 04-05 T1 | backup-then-link says "tmp+rename". Linux `rename()` of a symlink over a non-empty dir fails with EISDIR, so the step must remove the dir after the verified backup. | — |
| I11 | info | 04-03 → 04-08 | Propose latency is recorded, not gated against Omp's 25 s client timeout. | — |
| I12 | info | 04-12 T1/T5 | The "untouched" check compares the mtimes of `~/.claude/settings.json` and `~/.grok/config.toml`; unrelated writers cause false failures. | — |
| I13 | info | 04-07 T3 | The miner job's `--workdir` is the shared live checkout. | — |
| I15 | info | scope | 04-03 has 14 files, 04-09 14 and 04-07 11. 04-07's estimate is 96k (ratio 0.96). 04-12 has 5 tasks, 2 of them checkpoints. None is over budget. | — |
| I16 | info | 04-06 | Nested mounts were verified at 40; library growth has no cap. | — |
| I18 | info | ROADMAP § Phase 4 | Still shows "0/11 plans" with the old numbering and waves (orchestrator-owned). | — |
| I20 | info | 04-12 T1 | The `sched_docs_off_schedule` heuristic (minute ≥ 10) can fail falsely after a gateway catch-up. `find -newermt` needs a `cron_created_at` it can parse. | — |
| I21 | info | 04-02 T3 → 04-07 T1 | Before 04-07 T1, Hermes' 13 local links already point into the checkout (and 04-04/04-05 add Claude, Grok and agents links by design). A foreground `skill_manage` through one of them writes `/root/agent-skills`. This is D-04's accepted detect-and-refuse class (skills-sync refuses plus a warning; every plan verifies a clean checkout; T-04-04-02). W11 closed only the external_dirs path. | — |
| I22 | info | 04-03 interfaces L116 | The ledger contract still lists `state: "pushed" \| "opened"`, but the behavior writes `state closed` on a declined hit. Unlike `--replace`, `--reopen` has no grep gate; only the unit test pins it. | — |
| I23 | info | 04-09 T1, 04-07 T2 | Reporting of `declined` is unspecified in two places. Grok's `run_improve`/`format_report` covers only `proposed <url>` / `pending <path>`, so a declined result would read as "proposed". `drain_queue` logs reasons only for 400 and 413, so a declined queue file is removed silently. | — |

## Blocker list (verbatim)

None.

## Checks run (iteration 3)

- **Structure:** `verify.plan-structure` returns valid for all 12 plans with 0 errors and 0 warnings. `estimate-check --calibrated` finds no plan over budget (the highest is 04-07 at 0.96).
- **Waves:** `phase-plan-index 4` groups the plans as 0:[04-01] 1:[04-02] 2:[04-03] 3:[04-04] 4:[04-05..04-11] 5:[04-12]. The graph is acyclic, no files overlap within a wave, and the renumbered references are consistent. The only index warning was the misnamed 04-PLAN-CHECK.md, which this iteration removes.
- **Automated verifies:** all 27 commands were spot-run read-only. Each exited non-zero at its first check, for the stated missing-artifact reason (for example 04-07 A1 printed `smoke missing or duplicate plan_start_epoch`); 0 pass today. All 27 have a `<fails_when>`.
- **Ordering verifies (W11):** 04-07 A1 requires `PS ≤ WA ≤ ED`, the foreground probe staged and discarded, a clean checkout before and after, both write_approval keys true live, and the external_dirs-first RESTORE line. 04-07 A3 requires `sync_dirty_refusals_since_start=0` and re-checks it with journalctl.
- **Restore routes:** 04-07's key-by-key order is external_dirs `[]` first, then write_approval false; the whole-file route covers both. The T3 cron, shim and bridge routes are written before their changes; 04-10's script route and snapshot come before the edit. No other plan's routes changed.
- **Host facts re-checked:**
  - Hermes blocks writes to external_dirs only for background review: `skill_manager_guards.py` L164-183, with the preflight at L233-238.
  - The gate precedes validation (`skill_manager_tool.py` L779).
  - `/skills approve` bypasses the gate (L634, L652-663), which is why the W11 "never approve" hint is needed.
  - rivet `_writeFiles` returns per-entry results and creates parent dirs.

## Recommendation

Advisory only: no revision is required. The 15 INFO items can be taken up during execution or left.
