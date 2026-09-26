---
phase: "4"
slug: "skills"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-09-26"
---

# Phase 4 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Seeded from `04-RESEARCH.md` § Validation Architecture, reconciled with the locked decisions
> D-01..D-21 in `04-CONTEXT.md` and with plans 04-01..04-12 (test file names below are the ones the
> plans create). Revised after the independent plan check (`04-PLAN-CHECK.md`, B1-B2, W1-W10): the
> former 04-03 is split into 04-03 (propose core, route, tool) and 04-04 (sync, projector, merge,
> arrival), and the later plans are renumbered 04-05..04-12. The criterion and decision coverage matrices are in `COVERAGE.md`.

---

## Test Infrastructure

Phase 4 touches the TypeScript monorepo (`packages/mcp-server`, `packages/cli`, `packages/projector`,
`packages/collectors`, `packages/host`), a new Python package (`packages/miner`), two external repos
(`/root/src/repos/skill-autonomy`, Python; `/root/.openclaw/workspace/projects/docs-scraper`, Python,
no tests), `infra/vps` (two new service/timer pairs) and live agent state (Claude Code, Grok Build,
Hermes, Omp, Muse, Cursor, OpenClaw, rivet VMs, GitHub).

| Property | Value |
|----------|-------|
| **Framework (TS)** | `bun test` (repo root, colocated `*.test.ts`) + `bunx tsc --noEmit` (root tsconfig includes `packages/**/*.ts`, so `packages/projector/omp/*.ts` and `packages/collectors/src/cursor-stop.ts` are type-checked). Host tests stay free of `@rivet-dev/*` imports. |
| **Framework (Python)** | system `python3 -m pytest` — `packages/dispatcher` (unchanged, regression gate), new `packages/miner` (`pyproject.toml` `testpaths=["tests"]`, `pythonpath=["src"]`, httpx `MockTransport`), `/root/src/repos/skill-autonomy` (`-p no:cacheprovider`). |
| **docs-scraper** | no test suite; the plan verifies with its `.venv/bin/python` loading the script through importlib and asserting `propose_argv`/`_propose_skill` (04-10 Task 1). |
| **Config files** | root `package.json` / `tsconfig.json`; `packages/dispatcher/pyproject.toml`; `packages/miner/pyproject.toml` (new, 04-07); skill-autonomy `pyproject.toml` |
| **Quick run command** | the targeted test file(s) named in each task's `<automated>` |
| **Full suite command** | `cd /root/src/repos/agent-substrate && SUBSTRATE_DISABLED=1 /root/.local/share/reflex/bun/bin/bun test && /root/.local/share/reflex/bun/bin/bunx tsc --noEmit && (cd packages/dispatcher && python3 -m pytest -q) && (cd packages/miner && python3 -m pytest -q) && (cd /root/src/repos/skill-autonomy && python3 -m pytest -q -p no:cacheprovider)` |
| **Estimated runtime** | < 30 s per suite (live smokes, the owner checkpoints and the proof excluded) |

| Repo / package | Quick run command | Baseline (CONTEXT § Specifics at `9eef1ee`; re-measured by 04-01 into `04-BASELINE.md`) |
|---|---|---|
| agent-substrate (TS) | `SUBSTRATE_DISABLED=1 /root/.local/share/reflex/bun/bin/bun test` | **338 pass / 0 fail**, 22 files |
| agent-substrate (tsc) | normalized `bunx tsc --noEmit` pipeline (03-BASELINE.md) | **exit 0** |
| dispatcher (Python) | `cd packages/dispatcher && python3 -m pytest -q` | **149 passed** |
| skill-autonomy (Python) | `cd /root/src/repos/skill-autonomy && python3 -m pytest -q -p no:cacheprovider` | **25 passed** (research Q8) |
| miner (Python, new) | `cd packages/miner && python3 -m pytest -q` | none — must report 0 failed and ≥ 25 passed (04-07) |

Two-sided rule (standing): every gate diffs failing ids and the normalized tsc set against
`04-BASELINE.md`; a failure or type error that **disappears** fails the gate like a new one; pass counts
must grow when a plan adds tests (`-gt`) and must not drop otherwise (`-ge`). Failures present at
measurement belong to other sessions and are not repaired.

Execution note: `.planning/config.json` has `workflow.use_worktrees: false`, so execute-phase runs the
seven wave-4 plans sequentially on the main tree and each full-suite gate sees only committed sibling
work. If an orchestrator runs wave-4 plans concurrently in this checkout and a gate shows a failing id
from a file another wave-4 plan owns (ownership in `04-PATTERNS.md` and each plan's files_modified),
re-run the gate after that plan commits; never edit its file.

---

## Sampling Rate

- **After every task commit:** the targeted test file(s) for the touched module (each task's `<automated>` starts with them).
- **After every plan (last code task):** full `bun test` + normalized tsc, two-sided against 04-BASELINE.md; dispatcher pytest in 04-04 Task 1 and 04-07 Task 2; miner pytest in 04-07; skill-autonomy pytest in 04-09.
- **Live smoke per plan:** the `04-NN-SMOKE.md` / `04-03-TRACER.md` / `04-04-TRACER.md` key=value lines each plan's verify checks.
- **Before `/gsd:verify-work`:** all suites green against the baselines, every SMOKE/TRACER file complete, and `04-PROOF.md` with `proof_result=pass` and `sc3_cursor_visible=true`.
- **Max feedback latency:** 30 seconds for unit gates.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Criterion / Decision | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|----------------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 04-01-01 | 01 | 0 | standing rules (baseline, RESTORE) | T-04-01-01 | snapshotted configs never printed; 0700 | live measure | key checks on 04-BASELINE.md + `sha256sum -c` of the t0 manifest | ❌ W0 | ⬜ pending |
| 04-01-02 | 01 | 0 | D-12, D-14 baselines | T-04-01-03, -05 | every non-ignored skill-autonomy file tracked (.grok-plugin/ included), .gitignore unchanged, porcelain empty; only projects/docs-scraper committed; undo removes only .git | live git | `git status --porcelain --untracked-files=all` empty, `ls-files --error-unmatch .gitignore .grok-plugin/*`, .gitignore sha256, `diff -rq` source vs installed Grok plugin | ❌ W0 | ⬜ pending |
| 04-01-03 | 01 | 0 | D-08 (A3 spike) | T-04-01-02 | read-only mounts refuse writes; none → copy route (no stop) | live spike | keys in 04-01-SPIKE.md incl. `spike_sibling_write`, `mount_route=` rule | ❌ W0 | ⬜ pending |
| 04-02-01 | 02 | 1 | D-18, D-02 | T-04-02-01, T-04-02-05 | findings never echo values; event redact unchanged | unit + scan | `bun test packages/mcp-server/src/redact.test.ts` + 04-02-SCAN.md keys | ✅ extend | ⬜ pending |
| 04-02-02 | 02 | 1 | D-18, D-21 | T-04-02-01 | owner reviews raw content before push | checkpoint (human-verify) | presence: `grep -c '^owner_scan_decision='` = 1 | — | ⬜ pending |
| 04-02-03 | 02 | 1 | SC-1, D-01, D-02, D-03 | T-04-02-02, T-04-02-04 | gh via hosts.yml under env -i; clone-then-rename | live | 04-02-SMOKE.md keys; `gh repo view --json visibility` = PRIVATE; 0 links, 40 SKILL.md, clean checkout | ❌ | ⬜ pending |
| 04-03-01 | 03 | 2 | SC-4, D-09, D-18, D-19 (tracer, near end) | T-04-03-01, -03, -04, -05, -06 | guards before any git call; overlay keeps unnamed files; ledger idempotence (no search index); owner-closed identical content → declined; no quoted force/search flag | unit + live PR | `bun test packages/mcp-server/src/skills/propose.test.ts` + 04-03-TRACER.md (opened, immediate re-run existing, 2 ledger lines, overlay dry run diff_deleted=0) | ❌ | ⬜ pending |
| 04-03-02 | 03 | 2 | SC-4, D-09 | T-04-03-01, -02, -04 | anonymous caller (VM guest) → 401 / tool refusal; host propose key 0600; 400/413/502 shapes; loopback bind; no doc-example allowance on the route | unit + live | `bun test packages/mcp-server/src/{service,mcp,server}.test.ts` + live anonymous 401, bind check, key mode, RESTORE.d/04-03.md | ✅ extend | ⬜ pending |
| 04-04-01 | 04 | 3 | SC-3 (Claude, Grok), D-04, D-05, D-06 | T-04-04-02, -03, -04 | refuse dirty/diverged; never touch real dirs; backups | unit + live | `bun test packages/projector/src/skills.test.ts packages/projector/src/skills-sync.test.ts` + unit diff vs /etc + `skills.ts --check` + RESTORE.d/04-04.md | ❌ | ⬜ pending |
| 04-04-02 | 04 | 3 | D-16, D-21 | T-04-04-01 | owner merge is the gate | checkpoint (human-action) | presence: `gh pr view <url> --json state` = MERGED | — | ⬜ pending |
| 04-04-03 | 04 | 3 | SC-3 (Claude, Grok), D-04 (tracer, far end) | T-04-04-05 | delivery by timer only | live | 04-04-TRACER.md arrival keys; readlink checks; `merge-base --is-ancestor` | ❌ | ⬜ pending |
| 04-05-01 | 05 | 4 | SC-3 (Cursor, Muse, OpenClaw), D-05, D-06, D-20 | T-04-05-01, -02 | identical-only backup-then-link | unit | `bun test packages/projector/src/skills.test.ts` | ✅ extend | ⬜ pending |
| 04-05-02 | 05 | 4 | SC-3, D-05, D-06 | T-04-05-01 | backups verified; idempotent | live | 04-05-SMOKE.md keys; live link counts; `muse-bin … skills list --source user --json` | ❌ | ⬜ pending |
| 04-06-01 | 06 | 4 | SC-3 (VMs), D-08 | T-04-06-01, -02, -03, -06 | every mount readOnly; copy plan confined to the library; head marker only after a complete copy, parent dirs created; reserved names never mounted or copied | unit | `bun test packages/host/src/options.test.ts packages/host/src/seed.test.ts packages/host/src/tasks.test.ts` + seed/tasks unchanged since baseline head | ✅ extend | ⬜ pending |
| 04-06-02 | 06 | 4 | SC-3 (VMs), D-08 | T-04-06-01, -05, -07 | guest write refused (mount routes) or kept in the VM (copy); host tree clean | live VM | 04-06-SMOKE.md keys (route none → copy); journal library line | ❌ | ⬜ pending |
| 04-07-01 | 07 | 4 | SC-3 (Hermes), D-04, D-05, D-07, D-10 | T-04-07-09 | write_approval on before external_dirs (epochs ordered); foreground library write staged, not written; external_dirs verified before links removed; checkout clean | live | 04-07-SMOKE.md keys; epoch order; `hermes config get` ×3; no library-named link left; `git -C /root/agent-skills status --porcelain` empty | ❌ | ⬜ pending |
| 04-07-02 | 07 | 4 | SC-4 (Hermes), D-10, D-13 | T-04-07-02, -03, -04, -06, -07, -08, -09 | library-scoped; Hermes-local and unproposable writes held, never deleted; changed files + remove only; 413/oversize held; held library records carry a propose-or-reject hint, never approve; declined replies unlinked; key header; memory never read; quiet period | unit | `cd packages/miner && python3 -m pytest -q` (≥ 25 passed) | ❌ W0 | ⬜ pending |
| 04-07-03 | 07 | 4 | SC-5, D-04, D-10, D-13 | T-04-07-01, -05, -07, -09 | RESTORE routes before each live change; gate-staged library write → one-file PR by the timer; Hermes-local write held; job bound to the monitor shim; no manual cron run | live | 04-07-SMOKE.md keys; `hermes config get` ×2; `hermes cron list`; jobs.json binding; `gh pr view --json changedFiles` = 1; bridge units diff; RESTORE.d/04-07.md greps; no `refused … dirty` line in the skills-sync journal since plan_start_epoch | ❌ | ⬜ pending |
| 04-08-01 | 08 | 4 | SC-4 (Omp), D-11, D-17 | T-04-08-01, -02, -03, -06 | 25 s abort then queue; key header; 401 or missing key → queue; 413 → final block; never throws | unit | `bun test packages/projector/omp/substrate-skills.test.ts` | ❌ | ⬜ pending |
| 04-08-02 | 08 | 4 | SC-3 (Omp), SC-4 (Omp), D-05, D-17 | T-04-08-04, -05 | omp-ultrathink stays disabled; queue check isolated from the live bridge | live model session | 04-08-SMOKE.md keys; `omp config get` ×2; extension symlink target; temp queue removed | ❌ | ⬜ pending |
| 04-09-01 | 09 | 4 | SC-4 (Grok), D-12 | T-04-09-01, -02, -03, -06 | no code path writes ~/.grok/skills; key header; 401 or missing key → pending; 413 → rejected | unit | `cd /root/src/repos/skill-autonomy && python3 -m pytest -q -p no:cacheprovider` (two-sided, > 25) + clean porcelain | ✅ extend | ⬜ pending |
| 04-09-02 | 09 | 4 | SC-4 (Grok), D-12 | T-04-09-01, -05 | installed == source; no new real skill dir; pending check isolated from the live bridge | live | 04-09-SMOKE.md keys; `diff -rq` installed vs source; `cmp` rule; temp data dir removed | ❌ | ⬜ pending |
| 04-10-01 | 10 | 4 | SC-2, D-14 | T-04-10-03, -04 | snapshot + RESTORE route before the edit; argv only (with --replace); path-scoped commit | venv script check | `.venv/bin/python` importlib assertions print `ok`; RESTORE.d/04-10.md; manifest verifies | ❌ | ⬜ pending |
| 04-10-02 | 10 | 4 | SC-2, D-14, D-18, D-19 | T-04-10-01, -02, -05 | doc examples redacted only with the flag; corrected skill proposed from a scratch copy, never through the workspace symlink into /root/agent-skills | live | 04-10-SMOKE.md keys (unchanged, jwt refusal, dry-run redactions, PR files = docs-scraper/SKILL.md, `gh pr diff` adds the text, symlink unchanged, library clean) | ❌ | ⬜ pending |
| 04-11-01 | 11 | 4 | D-15 | T-04-11-01, -02, -03 | realpath containment; 0600 redacted copy; fail open | unit | `bun test packages/collectors/src/cursor-stop.test.ts` + `cursor.ts --print-desired` check | ❌ | ⬜ pending |
| 04-11-02 | 11 | 4 | D-15 | T-04-11-03, -05 | no synthetic transcript; gsd entries untouched | live | 04-11-SMOKE.md keys; hooks.json stop entry; transcripts dir empty, 0700 | ❌ | ⬜ pending |
| 04-12-01 | 12 | 5 | Proof (preflight), SC-5 | T-04-12-03 | untouched baseline recorded; scheduled suppressed ticks read back | live | 04-PROOF.md setup keys (`sched_suppressed_ticks` ≥ 1, `sched_docs_off_schedule=0`, monitor binding); timers/services active | ❌ | ⬜ pending |
| 04-12-02 | 12 | 5 | Proof, D-15, D-20, D-21 | T-04-12-02 | real session only | checkpoint (human-action) | presence: new *.jsonl newer than the t0 marker, mode 600 | — | ⬜ pending |
| 04-12-03 | 12 | 5 | Proof, SC-4, SC-5, D-13, D-20 | T-04-12-01, -03 | no hand-made pending/PR | live | 04-PROOF.md mining keys; flag files and `cursor_recheck_needed` match d20_action; `gh pr diff` carries `source: cursor:<id>` | ❌ | ⬜ pending |
| 04-12-04 | 12 | 5 | Proof, D-16, D-20, D-21, SC-3 (Cursor) | T-04-12-01 | owner merge; Cursor menu re-checked after a flag change | checkpoint (human-action) | presence: `gh pr view --json state` = MERGED | — | ⬜ pending |
| 04-12-05 | 12 | 5 | Proof, SC-3 (incl. Cursor) | T-04-12-03 | timer-only delivery; config mtimes unchanged | live | 04-PROOF.md arrival keys, `proof_result=pass`, `sc3_cursor_visible=true`, readlink checks | ❌ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `04-BASELINE.md` — agent-substrate bun/tsc, dispatcher, skill-autonomy (25) measured two-sided; library and projection inventory; `grok-real-entry:` and `dangling-link:` lines (04-01 Task 1).
- [ ] `/var/lib/substrate/phase4-baseline/` (0700) with `RESTORE.md` index, `RESTORE.d/`, t0 snapshot + manifest (04-01 Task 1).
- [ ] skill-autonomy git baseline (`git init` + commit of every non-ignored file, `.grok-plugin/` included, existing `.gitignore` unchanged, porcelain empty) and docs-scraper path-scoped baseline commit (04-01 Task 2).
- [ ] rivet nested-mount spike → `mount_route=` in `04-01-SPIKE.md` (04-01 Task 3; research A3); `none` selects D-08's copy route in 04-06, never a stop.
- [ ] `packages/miner/pyproject.toml` and `tests/` scaffold — created by 04-07 Task 2 together with its tests (the package has no earlier consumer).
- [ ] No npm/pip install anywhere in the phase (research: no new dependencies; `Bun.YAML`, httpx and stdlib only).

---

## Manual-Only Verifications

| Behavior | Criterion | Why Manual | Test Instructions |
|---|---|---|---|
| Raw library content may leave the host | D-18, D-21 | content-policy decision | 04-02 Task 2: owner reads 04-02-SCAN.md and answers approved / redact-high / stop. |
| Library PR merges (tracer, proof) | D-16, D-21 | the owner is the review gate | 04-04 Task 2 and 04-12 Task 4: owner merges on GitHub; the executor only checks `state = MERGED`. |
| Real Cursor session producing a transcript | Proof, D-15 | the headless cursor-agent is not signed in and fires no hooks in print mode | 04-12 Task 2: classic Remote-SSH session with transcripts on; presence of a new 0600 transcript copy. |
| Cursor skill menu lists library skills once (duplicates / none) | D-20, D-05 (Cursor reads ~/.agents/skills), SC-3 (Cursor) | only visible in the Cursor UI | 04-12 Task 2 step 4; the answer selects the D-20 flag in Task 3; on none or duplicates the owner re-checks at 04-12 Task 4 after the flag's sync tick, and 04-12 Task 5 requires `sc3_cursor_visible=true` (checker W8). |
| Live model sessions (Omp print mode, Claude init probe, Hermes miner run) | SC-3, SC-4 | model behaviour is nondeterministic | Observed and recorded; a model that does not call the tool is retried once and the first run kept under `## Failed runs`. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or are owner checkpoints with presence-only verification
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all ❌ W0 references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] Baselines re-measured before the first edit (04-01); gates two-sided against 04-BASELINE.md
- [ ] Every live edit outside the repo preceded by a snapshot and a RESTORE.d route
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
