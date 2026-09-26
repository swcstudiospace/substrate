---
phase: 04-skills
plan: 09
subsystem: grok-plugin
tags: [skills, propose, grok-build, skill-autonomy, autolearn, stop-hook, pending, d-12, sc-4, w2, w4, i5]

requires:
  - phase: 04-skills
    provides: 04-01 skill-autonomy git baseline 54972bf and 04-BASELINE.md (skill-autonomy 25 passed); 04-03 POST /skills/propose (x-substrate-propose-key, 400/401/413, overlay, declined), propose.key; 04-04 library sync + Grok projection; 04-07 bridge contract for ~/.grok/plugin-data/skill-autonomy/pending/*.json
provides:
  - skill-autonomy src/skill_autonomy/propose.py — propose_skill (POST <substrate>/skills/propose, 25 s, key header read per call, pending on unreachable/timeout/5xx/401/no key, rejected on 400/413, name checked against SKILL_NAME_RE), read_draft_dir (refuses symlinks, .pyc, non-UTF-8, missing SKILL.md)
  - write_skill(..., proposer=, session_id=) -> dict — secret refusal + RESERVED rename kept, SKILL.md only, no local write; skill_exists also checks /root/agent-skills (SKILL_AUTONOMY_LIBRARY_DIR)
  - run_improve(..., proposer=) — created rows carry pr_url or pending; report lines `proposed <url>` / `pending <path>`; names already drafted under drafts/ are skipped
  - `skill-autonomy propose <dir> [--rationale]` — JSON result, exit 1 only for rejected
  - Stop-hook live-learn context — draft under plugin-data/skill-autonomy/drafts/<name>/SKILL.md, then `"${GROK_PLUGIN_ROOT}/bin/skill-autonomy" propose <dir>` (resolved plugin root named as a fallback)
  - rules/commands/skills/README text — drafts + propose, "never into Grok's user skills directory"
  - live — plugin reinstalled (installed copy equals source), ~/.grok/rules/skill-autonomy.md updated, agent-skills#4 opened from Grok's surface
affects: [04-07, 04-12]

actuals:
  tokens: 8860       # chars/4 over the added lines of 54972bf..394d5ea in skill-autonomy (14 files, +728 -100)
  tasks: 2
  commits: 4         # skill-autonomy efa3484 (RED), 394d5ea (feat); agent-substrate 5bea2e6 (SMOKE), this SUMMARY
plan_head_before: 96eda37

key-files:
  created:
    - /root/src/repos/skill-autonomy/src/skill_autonomy/propose.py
    - /root/src/repos/skill-autonomy/tests/test_propose.py
    - .planning/phases/04-skills/04-09-SMOKE.md
    - /var/lib/substrate/phase4-baseline/RESTORE.d/04-09.md (host, not in git)
    - /var/lib/substrate/phase4-baseline/04-09/20260926T091357Z/ (host snapshot)
  modified:
    - /root/src/repos/skill-autonomy/src/skill_autonomy/{skill_write,improve,cli}.py, hooks/stop.py
    - /root/src/repos/skill-autonomy/{rules/skill-autonomy.md, commands/autolearn.md, skills/autolearn/SKILL.md, README.md}
    - /root/src/repos/skill-autonomy/tests/{test_improve,test_hooks,test_cli,conftest}.py
    - /root/.grok/installed-plugins/skill-autonomy-6d1e8e39 (reinstalled), /root/.grok/rules/skill-autonomy.md
    - /var/lib/substrate/phase4-baseline/RESTORE.md (index row 04-09)

key-decisions:
  - "Any non-2xx other than 400 and 413 queues (401, 404, 5xx); a 200 without a readable status also queues, since re-proposing is idempotent (existing/unchanged)."
  - "Pending file name is <name>-<UTC ts with microseconds>Z.json, created O_EXCL 0600 in a 0700 dir; the body is the exact request body, the key is only ever a header."
  - "write_skill keeps overwrite=False semantics as 'skip names that exist locally or in the library' (FileExistsError); overwrite=True proposes an update that 04-03 overlays."
  - "run_improve skips a name the model already drafted under drafts/<name>/ so `--apply` never opens a competing PR for a skill the model authored (replaces the old 'do not overwrite a SKILL.md you just authored')."
  - "Reinstall used uninstall --keep-data / install --trust / enable because `grok plugin update` is a no-op for this install."

coverage:
  - id: D1
    description: "Propose client (D-12, W4): opened/existing/unchanged/declined pass-through, pending on URLError/timeout/502/401/missing key (0600 file, 0700 dir, exact body, no key), rejected on 400 (server error) and 413 (too large), key header from SKILL_AUTONOMY_PROPOSE_KEY_FILE then SUBSTRATE_PROPOSE_KEY_FILE, URL from SKILL_AUTONOMY_SUBSTRATE_URL then SUBSTRATE_URL then 127.0.0.1:7410, read_draft_dir refusals."
    verification:
      - kind: unit
        ref: "tests/test_propose.py (RED committed first in efa3484)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Writers rewired (D-12, W2): write_skill proposes SKILL.md only and never writes; run_improve(apply=True) reports proposed/pending; dry-run hint says proposed as PRs; skill_exists consults the library; Stop context names drafts + propose and not ~/.grok/skills; SessionEnd auto-create queues under the closed-port test URL; CLI propose exit codes."
    verification:
      - kind: unit
        ref: "tests/test_improve.py, test_hooks.py, test_cli.py; skill-autonomy pytest 55 passed (baseline 25)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Live: plugin reinstalled (installed equals source), rule installed (cmp), grok inspect lists autolearn, propose opened agent-skills#4, isolated pending check (0600, no key, live queue untouched, temp dir removed), no new real dir in ~/.grok/skills."
    verification:
      - kind: e2e
        ref: "04-09-SMOKE.md; Task 2 <automated> verify run verbatim in a clean bash: exit 0"
        status: pass
    human_judgment: false
  - id: D4
    description: "Root suite and tsc two-sided unchanged."
    verification:
      - kind: other
        ref: "bun test 503 pass, 0 fail (27 files; baseline 338); tsc-exit=0; no failing-id difference"
        status: pass
    human_judgment: false

duration: about 25 min (08:52Z–09:18Z)
completed: 2026-09-26
status: complete
---

# Phase 4 Plan 09: Grok skill-autonomy proposes to the library instead of writing ~/.grok/skills Summary

**Every path by which skill-autonomy used to create a Grok skill (`/autolearn --apply`, SessionEnd auto-create, the Stop-hook live-learn instruction, and the rule/command/skill text the model reads) now opens a PR on swcstudiospace/agent-skills through `POST /skills/propose`, or queues the exact body for the 04-07 bridge. The reinstalled plugin opened [agent-skills#4](https://github.com/swcstudiospace/agent-skills/pull/4) live, and nothing new appeared in `~/.grok/skills`.**

## Performance

- **Tasks:** 2 (Task 1 TDD, Task 2 live)
- **Files modified:** 14 in skill-autonomy (13 planned + tests/conftest.py), 04-09-SMOKE.md and this SUMMARY here; host: installed plugin, live rule, RESTORE.d/04-09.md, index row, snapshot.

## Task Commits

1. **Task 1** (skill-autonomy): `efa3484` test (RED: test_propose.py import error), `394d5ea` feat (`feat: propose learned skills to the shared library instead of writing ~/.grok/skills (agent-substrate Phase 4 D-12) Refs SPE-2734 Refs SPE-3576`)
2. **Task 2** (agent-substrate): `5bea2e6` docs (04-09-SMOKE.md)

## Verification

| Gate | Result |
|---|---|
| Task 1 `<automated>` | exit 0, run in a clean `env -i … bash` with one substitution (see Deviations 1). Tail: `55 passed in 0.17s`, bun ` 503 pass` / ` 0 fail`, `tsc-exit=0` |
| Task 2 `<automated>` | exit 0, run verbatim in a clean `env -i … bash` |
| skill-autonomy pytest | 55 passed, 0 failed (baseline 25 passed, no failing ids) |
| agent-substrate bun test | 503 pass, 0 fail, 27 files (baseline 338 pass; growth is siblings' and earlier plans' tests) |
| tsc | tsc-exit=0 (baseline tsc-exit=0) |

## Deviations from Plan

1. **[Rule 3 – verify command] pytest form.** The plan's Task 1 verify runs `python3 -m pytest -q -p no:cacheprovider`. With pyproject's `addopts = "-q"` that is `-qq`, which prints only dots and no `N passed` line (04-BASELINE.md warns about this), so the pass-count check can never succeed. Ran it as `python3 -m pytest -p no:cacheprovider` (the baseline's prescribed form); everything else verbatim.
2. **[Rule 3 – harness] clean shell.** The executor's tool shell has builtin `grep`/`sed` that differ from GNU (`grep -oE '^ *…'` printed nothing), so both verifies were run as scripts under `env -i HOME=/root PATH=/usr/local/bin:/usr/bin:/bin bash`.
3. **[Rule 2 – safety] tests/conftest.py (not in files_modified).** The `grok_home` fixture now sets `SKILL_AUTONOMY_SUBSTRATE_URL=http://127.0.0.1:9`, a missing `SKILL_AUTONOMY_PROPOSE_KEY_FILE` and an empty `SKILL_AUTONOMY_LIBRARY_DIR`. Without it, the SessionEnd test (which runs `run_improve(apply=True)` with the default proposer) would read the real root key and open a real PR, and `skill_exists` would read the live library.
4. **[Rule 3 – blocked command] reinstall route.** `grok plugin update skill-autonomy` printed `local symlink, already live` and left the installed directory stale (12 files differ). Used the README's documented route: `grok plugin uninstall skill-autonomy --confirm --keep-data`, `grok plugin install /root/src/repos/skill-autonomy --trust`, `grok plugin enable skill-autonomy`, after also snapshotting `~/.grok/config.toml`, `registry.json` and the plugin-data dir (config.toml was byte-identical afterwards; same registry key and path). RESTORE.d/04-09.md documents that route too.
5. **[Rule 2] drafted-name skip.** `run_improve` skips a candidate whose `drafts/<name>/SKILL.md` exists, so `--apply` after the model authored a draft does not open a second competing PR (the old text's "do not overwrite a SKILL.md you just authored"). One test added.
6. **[Rule 2] Stop context fallback.** Besides the literal `"${GROK_PLUGIN_ROOT}/bin/skill-autonomy" propose`, the context names the resolved plugin root in case the model's shell does not export `GROK_PLUGIN_ROOT`.

## Gaps

- Stop-hook live learning is model-driven; covered by the hook test and the live propose CLI, not by a live Grok model session.
- `grok plugin update` does not refresh this Local install; later source changes need the reinstall route above.
- SessionEnd auto-create (default on) now opens PRs synchronously inside the 8 s SessionEnd hook budget (about 6 s per new PR, up to 8 per run). Nothing is lost if the hook is cut short (candidates are retried next SessionEnd, re-proposals answer `existing`), but a slow run can be cut short. [INFERENCE] Low-value slash-gap candidates (the dry run shows `user-prompt`, `ultrathink`) can reach the owner as PRs; closing them makes later proposals `declined`.
- agent-skills#4 is open for the owner (D-16); not merged here.

## Self-Check: PASSED

- propose.py, test_propose.py, 04-09-SMOKE.md exist; commits efa3484, 394d5ea (skill-autonomy) and 5bea2e6 (agent-substrate) exist; skill-autonomy `git status --porcelain` empty.
