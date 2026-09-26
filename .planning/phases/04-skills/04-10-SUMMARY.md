---
phase: 04-skills
plan: 10
subsystem: skills
tags: [skills, docs-scraper, propose, cli, redaction, d-14, d-18, d-19, sc-2, b1, w2, w6]

requires:
  - phase: 04-skills
    provides: 04-01 docs-scraper baseline commit ab5652e and /var/lib/substrate/phase4-baseline; 04-02 04-02-SCAN.md (0/0 docs exports, docs-fastapi jwt finding); 04-03 `substrate skills propose --dir` with --allow-doc-examples, --replace and the docs-scraper surface; 04-04 library on main @ 34b32e2 with the sync timer
provides:
  - batch_docs_skills.py — SUBSTRATE_BUN, SUBSTRATE_CLI, propose_argv, _propose_skill (argv list, 600 s timeout, HOME=/root); result keys propose_status, pr_url, propose_error; status propose_error (retried by --resume-failed)
  - _install_skill, _update_agent_skills_readme, the README refresh and the four env targets removed
  - agent-skills#2 — corrected docs-scraper/SKILL.md "Shared install" section, OPEN for the owner (D-16)
  - 04-10-SMOKE.md — unchanged re-publish, D-18 refusal vs redaction, B1 scratch-copy PR evidence
  - host — snapshot /var/lib/substrate/phase4-baseline/04-10/20260926T090411Z (MANIFEST.sha256), RESTORE.d/04-10.md (script route, revert hash, PR #2)
affects: [04-12]

actuals:
  tasks: 2
  commits: 2         # workspace 0d7c2d6; agent-substrate abaadef (plus this SUMMARY commit)
plan_head_before: 96eda37

tech-stack:
  added: []
  patterns:
    - "External pipelines publish to the library by shelling out to the substrate CLI with an argv list and parsing its key=value stdout; a non-zero exit becomes a retryable per-item status"
    - "Library content that lives behind a symlink into the live checkout is edited only in a git-archive scratch copy under /var/lib/substrate/skills and proposed as a PR"

key-files:
  created:
    - .planning/phases/04-skills/04-10-SMOKE.md
    - /var/lib/substrate/phase4-baseline/RESTORE.d/04-10.md (host, not in git)
    - /var/lib/substrate/phase4-baseline/04-10/20260926T090411Z/ (host snapshot)
  modified:
    - /root/.openclaw/workspace/projects/docs-scraper/scripts/batch_docs_skills.py (workspace commit 0d7c2d6)

key-decisions:
  - "_propose_skill takes an optional root_url keyword so the rationale reads `docs-scraper <id>: <pages> pages from <root_url>` at the batch call site; direct calls (pages=0, no root_url) omit the `from` clause"
  - "A propose error sets result status propose_error (not ok), so --resume-failed retries it; unchanged/existing/declined/opened all keep ok/empty"
  - "RESTORE.md index was not edited: wave-4 routes live only in their own RESTORE.d file (PATTERNS § snapshot)"

requirements-completed: []
---

# Phase 4 Plan 10: docs-scraper publishes through `substrate skills propose` — Summary

**A finished docs-scraper crawl now ends in a library PR (`--surface docs-scraper --allow-doc-examples pem,jwt --replace`) instead of symlinks into four agent dirs and a README rewrite. The docs-scraper skill's own corrected text is open as agent-skills#2, built from a git-archive scratch copy and never written through the live checkout.**

## Performance

- Tasks: 2/2
- Files: 1 live script (workspace repo), 1 evidence file (agent-substrate)

## Accomplishments

- **Task 1 (D-14, D-18, D-19).** Snapshot and RESTORE route came first: `04-10/20260926T090411Z` with a verifying manifest; `RESTORE.d/04-10.md` holds the `cp -a` + path-scoped commit route, the revert hash and the PR note. Removed from `batch_docs_skills.py`: `AGENT_SKILLS`/`HERMES_SKILLS`/`OPENCLAW_SKILLS`/`OPENCLAW_WS_SKILLS`, `_install_skill`, `_update_agent_skills_readme` and the README refresh in `amain`. Added: `SUBSTRATE_BUN`, `SUBSTRATE_CLI`, `propose_argv` (the exact list the plan specifies) and `_propose_skill` (`subprocess.run` with no shell, 600 s timeout, `HOME=/root`). It parses `status=`/`pr_url=`; a non-zero exit or timeout returns `propose_status=error` plus the last 400 characters of stderr. The call site keeps `export_dir`, `pages` and `status`, and an error sets `status=propose_error`. `--dry-run` still returns before any propose. Workspace commit `0d7c2d6` touches only `projects/docs-scraper/scripts/batch_docs_skills.py` and is on top of `ab5652e`.
- **Task 2 (SC-2, B1).** Evidence is in 04-10-SMOKE.md:
  - `_propose_skill` on the real `docs-python` export returned `unchanged` and opened no PR.
  - `docs-fastapi` without the flag: exit 1, finding rule `jwt`, no value printed.
  - With `--allow-doc-examples pem,jwt`: `status=dry_run`, `redactions=181`.
  - Corrected docs-scraper SKILL.md: built with `git archive` in `/var/lib/substrate/skills/04-10-skill.*` (0 symlinks, realpath inside the scratch dir), proposed through `_propose_skill`, and returned `opened` as https://github.com/swcstudiospace/agent-skills/pull/2. The PR changes only `docs-scraper/SKILL.md`, and its diff adds "skills propose".
  - The scratch dir was removed. The workspace link still points to `/root/agent-skills/docs-scraper`. Both checkouts are clean, 0 new symlinks were written, and 0 workspace paths are tracked outside `projects/docs-scraper/`.

## Task Commits

1. **Task 1: propose through the substrate CLI, symlinks/README removed**: `0d7c2d6` in /root/.openclaw/workspace
2. **Task 2: live publish checks**: `abaadef` (docs) in agent-substrate

## Verification

- Task 1 `<automated>`: exit 0. tsc normalized set `tsc-exit=0` (= baseline); bun `503 pass`, `0 fail`, 27 files (baseline 338/0/22; growth is sibling plans' tests); failing ids: none (= baseline).
  - A first run at ~09:06Z failed only on the tsc diff: 16 `TS2304`/`TS7006` lines in `packages/host/src/options.test.ts`, a sibling plan's (04-06) in-progress red test file outside 04-10's files. The run after ~60 s was clean.
- Task 2 `<automated>`: exit 0. It includes the live `gh pr view` file list and the `gh pr diff` check against PR #2.

## Deviations from Plan

1. The argv list in `propose_argv` is written as flag/value pairs on one line each (`"--allow-doc-examples", "pem,jwt",`). The verify greps for that exact adjacent text, and the first one-element-per-line layout failed it. The list itself is unchanged. The fix was amended into the local, unpushed workspace commit (260db20 → 0d7c2d6), and the RESTORE revert hash was updated.
2. `_propose_skill` has an extra optional keyword `root_url` (default None). With it, the batch call site produces the plan's rationale `docs-scraper <id>: <pages> pages from <root_url>`, and the plan's direct-call signature `(export_dir, skill_name, *, pages, source_id)` still works.

Neither changes the contract.

## Issues / Gaps

- No crawl was run; crawl scheduling is deferred. The full `process_one` → propose → state path is covered only by the monkeypatched venv check and the direct `_propose_skill` calls.
- agent-skills#2 is OPEN and awaits the owner's merge (D-16/D-21). Until then the workspace's `skills/docs-scraper` link shows the old "Shared install" text.
- The flagged fastapi run was a dry run. No docs export PR has yet shown doc-example redactions in its body.

## Next Phase Readiness

- 04-12 can list agent-skills#2 among the owner's open proposals. The next real batch run publishes each successful export as a PR, or reports `unchanged`, with `propose_status`/`pr_url` in `data/batch/top20-state.json`.
