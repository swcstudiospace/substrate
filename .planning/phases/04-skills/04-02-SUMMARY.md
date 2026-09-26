---
phase: 04-skills
plan: 02
subsystem: infra
tags: [skills, redaction, d-18, git, gh, github, library, mirror, swap, restore, d-01, d-02, d-03, sc-1]

requires:
  - phase: 04-skills
    provides: 04-01 04-BASELINE.md (bun 338/0, tsc-exit=0, library 41/26/40, 0 dangling links in the nine roots), /var/lib/substrate/phase4-baseline (0700, RESTORE.md index, RESTORE.d per plan)
  - phase: 03-lane-a
    provides: 03-07 conventions (gh/git under HOME=/root with the stored credential, never a token; key=value SMOKE evidence with one Gaps heading; verify blocks run verbatim under /bin/bash)
provides:
  - redact.ts — SkillRedactionRule, SKILL_HIGH_CONFIDENCE_RULES, SkillDocExampleRule, SkillRedactionOptions, redactSkillContent, scanSkillFiles; redact()/redactValue() unchanged (the diff only adds lines)
  - 04-02-SCAN.md — the owner-reviewed scan of the raw library (per-directory table, 12 pem/jwt findings as file:line rule, scan_* keys), owner_scan_decision=approved
  - swcstudiospace/agent-skills — PRIVATE, default branch main, 6e34790 (vendor, 2,420 files) + 3ac8572 (README states the git-backed library and its projection)
  - /var/lib/substrate/skills/mirror.git — bare clone, fetch refspec +refs/heads/main:refs/heads/main, main = 3ac8572
  - /root/agent-skills — clean git checkout of main @ 3ac8572 (0 links, 40 SKILL.md, 0 .pyc), swapped in by two back-to-back renames (237 ms)
  - /var/lib/substrate/phase4-baseline/04-02/20260926T040754Z (old tree cp -a, listing, MANIFEST.sha256) and RESTORE.d/04-02.md (checkout, mirror, owner-only repo routes)
  - 04-02-SMOKE.md — repo, mirror, swap, dangling-link and Grok script-path evidence
affects: [04-03, 04-04, 04-05, 04-06, 04-10, 04-12]

actuals:
  tokens: 8035       # chars/4 over the 04-02 commits' diffs (70c75a0 + f5b5f28): 4 files, +615
  tasks: 3
  commits: 2         # this plan's commits in agent-substrate before this SUMMARY (70c75a0, f5b5f28); two orchestrator planning commits (03128e5, 65ae9e2) landed in between and are not counted
plan_head_before: 7d26c1b8217f6343c88e5deac32ecd376ac61535

tech-stack:
  added: []
  patterns:
    - "Skill text gets its own redactor. Env references and placeholders survive. Contextual values are redacted. High-confidence token shapes are findings that refuse, never silent redactions. Hits carry file, line and rule, never the value."
    - "All rules match against the original text, and the first rule to claim a span wins. High-confidence rules run first, so a KEY= rule can never quietly swallow a real token. Line numbers come from the original text, so a collapsed PEM block does not shift later lines."
    - "The owner approves the scan of the exact tree that is pushed. The scratch tree is scanned, diffed against the live content right before the commit, and then committed as it is."
    - "Live-directory swap: snapshot and restore route first, clone to <dir>.new and verify it, then two renames in one shell line, then verify again and remove the old tree."

key-files:
  created:
    - .planning/phases/04-skills/04-02-SCAN.md
    - .planning/phases/04-skills/04-02-SMOKE.md
    - /var/lib/substrate/phase4-baseline/RESTORE.d/04-02.md (host, not in git)
    - /var/lib/substrate/phase4-baseline/04-02/20260926T040754Z/ (host, not in git)
    - /var/lib/substrate/skills/mirror.git (host, not in git)
  modified:
    - packages/mcp-server/src/redact.ts
    - packages/mcp-server/src/redact.test.ts
    - /var/lib/substrate/phase4-baseline/RESTORE.md (index row for 04-02)
    - /root/agent-skills (links + real dirs → git checkout of swcstudiospace/agent-skills)

key-decisions:
  - "Owner decision at the Task 2 checkpoint: approved. The initial commit is the raw vendored library, including the 12 pem/jwt documentation-example spans in 4 docs files, pushed to a PRIVATE repo."
  - "A literal after `Authorization: Bearer` is reported as bearer, because the bearer rule runs before authorization. `Authorization: Basic …` and other schemes stay under authorization."
  - "A finding's span is also replaced in the returned text, so no field of the result, `text` included, ever carries a high-confidence value. Findings still refuse the proposal. Only pem and jwt can be downgraded to redactions through allowDocExamples, and this is enforced at runtime, not only by the type."
  - "High-confidence rules get no placeholder exemption. The keypair-array rule of the event path has no skill counterpart: it is not in the SkillRedactionRule union, and byte arrays are ordinary code in docs."
  - "The snapshot and RESTORE.d/04-02.md were written before the repo was created, which is the standing rule (route before the first live change). The plan lists D-01 first. Nothing else was reordered."

patterns-established:
  - "Scan reports for content leaving the host: per-directory counts, findings as file:line rule, a heuristic shape pass reported as counts only, the scanning script run from /tmp and deleted"

requirements-completed: []

coverage:
  - id: D1
    description: "D-18 skill-content redactor:
      - kept unchanged: `$VAR`, `${VAR}`, Markdown-escaped `$VAR\\_NAME`, `<…>`, the placeholder words and `[REDACTED…]`;
      - redacted: real values after the assignment, password, authorization, bearer and url-password rules;
      - findings: the ten high-confidence shapes (pem, jwt, github, openai, anthropic, xai, linear, notion, tailscale, aws), unless pem or jwt is an allowed doc example;
      - line numbers are 1-based and counted in the original text;
      - no result field carries a value;
      - scanSkillFiles reports per file;
      - redact() and redactValue() are byte-for-byte unchanged."
    verification:
      - kind: unit
        ref: "bun test packages/mcp-server/src/redact.test.ts: 25 pass, 0 fail (13 new tests; the existing 12 tests are unmodified, the diff only adds lines)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Raw vendoring and scan (D-02, D-18):
      - the 40 entries plus README.md dereferenced into /var/lib/substrate/skills/vendor (0700);
      - the one __pycache__/.pyc dropped;
      - 0 links, 2,420 files, 0 non-UTF-8;
      - 04-02-SCAN.md reports: the event redactor alters 298 files, the skill redactor 192 (678 spans), and 12 pem/jwt findings in 4 docs files, with 0 left once pem and jwt are allowed as doc examples."
    verification:
      - kind: other
        ref: "Task 1 <automated> verify (/tmp/04-02/t1-verify.sh under /bin/bash): exit 0; the scan script is deleted"
        status: pass
    human_judgment: false
  - id: D3
    description: "The owner reviewed the scan report at the blocking human-verify checkpoint (D-21) before anything left the host."
    verification:
      - kind: manual_procedural
        ref: "The owner's resume-signal `approved`, relayed verbatim by the orchestrator. `grep -c '^owner_scan_decision=' 04-02-SCAN.md` = 1 and the line is `owner_scan_decision=approved`."
        status: pass
    human_judgment: true
  - id: D4
    description: "D-01/D-02/D-03/SC-1:
      - swcstudiospace/agent-skills is created in-plan: PRIVATE, default branch main, holding the vendor commit and the README commit; gh and git ran under env -i HOME=/root; substrate.env holds 0 GH_TOKEN/GITHUB_TOKEN lines;
      - mirror.git is a bare clone that fetches only main;
      - the old /root/agent-skills is snapshotted (MANIFEST verifies) and has checkout, mirror and repo routes;
      - clone → verify → two renames (237 ms) → verify: /root/agent-skills is clean on main @ 3ac8572, equal to the mirror and to GitHub, with 0 links, 40 SKILL.md and 0 .pyc;
      - no dangling link in the nine roots, and all 11 Grok script paths exist;
      - the old tree and the scratch tree are removed."
    verification:
      - kind: integration
        ref: "04-02-SMOKE.md keys; Task 3 <automated> verify (/tmp/04-02/t3-verify.sh under /bin/bash): exit 0"
        status: pass
    human_judgment: false
  - id: D5
    description: "Root suite and tsc are green on both sides against 04-BASELINE.md, with more passes than agent-substrate-pass."
    verification:
      - kind: other
        ref: "bun test: 351 pass, 0 fail (baseline 338); no failing ids on either side; tsc-exit=0, the same set as the baseline"
        status: pass
    human_judgment: false

duration: 66min
completed: 2026-09-26
status: complete
---

# Phase 4 Plan 02: Skill-content redactor, owner-reviewed scan and the git-backed library Summary

**`/root/agent-skills` is now a clean git checkout of the private `swcstudiospace/agent-skills` on `main`:**
- It holds the real content of all 40 entries. The 26 symlinks are dereferenced, so there are 0 links and 0 `.pyc` files.
- It was swapped in by two back-to-back renames. Every path agents use still resolves: no dangling link in the nine skill roots, and all 11 script paths hardcoded in Grok's copied skills exist.
- The propose mirror `mirror.git` fetches only `main` and sits at the same commit.
- Before anything left the host, the owner reviewed a scan made by the same skill-content redactor that every later `skills_propose` will run, and answered `approved`.
- That redactor keeps `Authorization: Bearer $PARALLEL_API_KEY` and its Markdown-escaped forms, redacts real values, and turns high-confidence secrets into findings that refuse. The event redactor is untouched.

## Performance

- **Duration:** 66 min of executor time. First run 03:48:41Z–04:03Z; the owner's checkpoint answer arrived at 04:06Z; the resumed run ended at 04:57Z.
- **Started:** 2026-09-26T03:48:41Z
- **Completed:** 2026-09-26T04:57Z
- **Tasks:** 3 (Task 2 was the owner's blocking human-verify checkpoint)
- **Files modified:** 4 in the repo (redact.ts, redact.test.ts, 04-02-SCAN.md, 04-02-SMOKE.md) plus this SUMMARY. Outside the repo: the GitHub repo, mirror.git, /root/agent-skills, and the 04-02 snapshot and restore route.

## Baselines (two-sided, against 04-BASELINE.md)

| Suite | 04-BASELINE (44bad2d) | After Task 1 (70c75a0) |
|---|---|---|
| agent-substrate bun test | 338 pass, 0 fail | 351 pass, 0 fail (+13 redactor tests) |
| tsc (normalized) | tsc-exit=0 | tsc-exit=0 |

No failing-id set differs from the baseline in either direction. Task 3 changed no code, so the suite was not re-run after it.

## Owner decision

`owner_scan_decision=approved` (Task 2, 2026-09-26, relayed verbatim). The initial commit is the raw vendored tree. It includes the 12 documentation-example spans (pem and jwt in docs-fastapi, docs-greptile, docs-kubernetes and docs-nextjs), which the research anticipated as 5 (dir, rule) pairs.

## Accomplishments

- **Skill redactor (D-18, T-04-02-01/05).**
  - `SKILL_RULES` is a labelled copy of the event patterns plus `aws`. Each entry names its rule, pattern, value group and replacement.
  - Every rule matches against the original text, and an overlapping later match is skipped. The ten high-confidence rules come first.
  - The placeholder check strips surrounding quotes and trailing `,;)`. It keeps `$VAR`/`${VAR}` (Markdown `\_` read as `_`), `<…>`, `your…`, `xxx…`, `...`, `***`, `example`, `changeme`, `placeholder`, `redacted…` and `[REDACTED…]`.
  - Whitespace around a key stays on its line.
  - `scanSkillFiles` sorts the paths and tags every hit with its file.
  - 13 tests cover every behavior bullet, plus the escaped-env case, the YAML next-line case, idempotence and the event-vs-skill divergence.
- **Scan (D-02, D-18).**
  - Vendored tree: 2,420 files and 43,609,207 bytes, with 0 links, 0 .pyc, 0 non-UTF-8 files and 0 special files.
  - `redact()` alters 298 files, as the research measured. The skill redactor alters 192 files (678 spans: assignment 127, authorization 229, bearer 63, password 206, url-password 53).
  - 12 findings in 4 files, all pem/jwt, with 0 remaining once doc examples are allowed.
  - The three parallel-* SKILL.md auth lines are altered by the event path and kept by the skill path.
  - Docs exports with 0/0 (for 04-10's unchanged check): cloudflare, postgres, python, react, stripe, tailwind, typescript.
- **Repo (D-01, T-04-02-02/03).**
  - `gh repo view` reported the repo absent, then `gh repo create --private` created it. Both ran under `env -i HOME=/root PATH=/usr/bin:/bin`, so no token reached argv, the environment or the output.
  - Right before the commit, `diff -rq` showed the scanned tree equal to the live content.
  - Commit 1 is `6e34790`: 2,420 files and 41 top-level entries, with no symlink or submodule entry.
  - Commit 2 is `3ac8572`, the README (Pitfall 10). It describes:
    - the canonical library and the read-only checkout that `substrate-skills-sync` fast-forwards;
    - PR-only changes through `skills_propose`, `POST /skills/propose` and `substrate skills propose --dir`, merged by the owner;
    - the redactor policy;
    - the per-agent projection table;
    - the vendoring history.
  - The push created `main` as the default branch. `substrate.env` has 0 GitHub token lines.
- **Mirror.** A bare clone with the fetch refspec set to `+refs/heads/main:refs/heads/main`. Its only ref is `refs/heads/main` = `3ac8572`, and `fetch origin` exits 0.
- **Swap (D-03, T-04-02-04).**
  - Snapshot `04-02/20260926T040754Z`: the old tree copied with `cp -a` (26 links preserved), the listing TSV, and MANIFEST.sha256 with 28 entries, which verifies.
  - RESTORE.d/04-02.md has the checkout, mirror and owner-only repo routes. The RESTORE.md index gained a 04-02 row.
  - The clone at `/root/agent-skills.new` was verified before the swap: 40 SKILL.md, 0 links, HEAD equal to the mirror's main, content equal to the live tree, and the same 9 executables.
  - `mv … && mv …` in one line took 237 ms.
  - Verified after the swap: clean on main, 0 links, 40 SKILL.md, 0 .pyc, HEAD equal to the mirror, GitHub and library_head, 0 dangling links (0 new), and all 11 Grok paths present.
  - The old tree and `vendor/` were removed. The old link targets (the docs-scraper exports and Hermes' anda-ecosystem) are untouched.

## Task Commits

1. **Task 1: Skill-content redactor (D-18) and the raw vendoring scan report**: `70c75a0` (feat)
2. **Task 2: Owner reviews the scan report**: checkpoint, answered `approved`. The line was recorded in 04-02-SCAN.md and committed with Task 3.
3. **Task 3: Private repo, push, mirror, snapshot and the clone-then-rename swap**: `f5b5f28` (docs) in agent-substrate; `6e34790` and `3ac8572` in swcstudiospace/agent-skills.

**Plan metadata:** this SUMMARY commit (docs).

## Files Created/Modified

- `packages/mcp-server/src/redact.ts`: the skill-content section (types, SKILL_HIGH_CONFIDENCE_RULES, SKILL_RULES, isPlaceholder, redactSkillContent, scanSkillFiles). `RULES`, `redact` and `redactValue` are untouched.
- `packages/mcp-server/src/redact.test.ts`: 13 new tests in new describe blocks, and a second import line.
- `.planning/phases/04-skills/04-02-SCAN.md`: the scan report and `owner_scan_decision=approved`.
- `.planning/phases/04-skills/04-02-SMOKE.md`: the migration evidence.
- Host only:
  - `/var/lib/substrate/skills/mirror.git`
  - `/var/lib/substrate/phase4-baseline/{04-02/20260926T040754Z/, RESTORE.d/04-02.md, RESTORE.md row}`
  - `/root/agent-skills` (now a checkout)
- GitHub: `swcstudiospace/agent-skills` (PRIVATE).

## Decisions Made

See key-decisions. None of them changes a D-01..D-21 contract.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Markdown-escaped env references were redacted**
- **Found during:** Task 1 (first scan run)
- **Issue:** Scraped docs write the auth line D-18 protects as `Authorization: Bearer $OPENAI\_API\_KEY`. The plan's `^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$` does not accept `\_`. The first run redacted 245 such spans: 923 spans in 239 files.
- **Fix:** the placeholder check reads `\_` as `_` before matching the env-reference regex, and a test covers it. Result: 678 spans in 192 files, with findings unchanged.
- **Files modified:** packages/mcp-server/src/redact.ts, packages/mcp-server/src/redact.test.ts
- **Verification:** redact tests 25/25; re-scan
- **Committed in:** 70c75a0

**2. [Rule 1 - Bug] Contextual rules could take the next line's first word as a value**
- **Found during:** Task 1 (rule design)
- **Issue:** The event patterns use `\s*` after `password:` and `KEY:`. On a YAML key at a line end (`password:` then `  type: string`), the value becomes `type:`, which corrupts schemas in docs.
- **Fix:** the skill copies use `[ \t]` around the key. There is a test for the YAML case. The event patterns are unchanged.
- **Files modified:** packages/mcp-server/src/redact.ts, packages/mcp-server/src/redact.test.ts
- **Verification:** redact tests 25/25
- **Committed in:** 70c75a0

**3. [Rule 2 - Missing critical] A second pass must be a no-op**
- **Found during:** Task 1
- **Issue:** Without it, `KEY=[REDACTED]` would be redacted again and reported again. 04-03 hashes the redacted content, so repeated passes would change the result.
- **Fix:** `[REDACTED…]` counts as a placeholder, and trailing `,;)` is stripped along with quotes. A test asserts that redacting redacted text changes nothing.
- **Files modified:** packages/mcp-server/src/redact.ts, packages/mcp-server/src/redact.test.ts
- **Verification:** redact tests 25/25
- **Committed in:** 70c75a0

---

**Total deviations:** 3 auto-fixed (Rule 1: 2, Rule 2: 1).
**Impact on plan:** No contract changed. All three move the redactor closer to D-18's "keeps $VAR and placeholder forms, redacts real values".

## Issues Encountered

- The host ran at load average 145–286 with about 220 MB of free memory. Git and network steps took minutes, and one `gh repo view` hit a TLS handshake timeout; the same read-only query was retried and answered. The 237 ms swap gap includes two `mv` process spawns under that load.
- In Task 3, the `git add -- README.md <names>` list was computed after `git init`, so it also named `.git`, which git skips. The commit tracks exactly 2,420 files (= `scan_files`) and 41 top-level entries.
- Git records only 644/755. 14 files that were 0600 in the old real directories are now 0644 in the checkout, and 9 scripts went from 0711 to 0755. Their content is identical, and the scan found no credential in them.
- The skill redactor still rewrites some working documentation, as the plan's exemption list defines it. Heuristic counts:
  - authorization: 178 spans are a quoted scheme word (`Authorization: 'Bearer ' + key`);
  - password and bearer: 151 spans are lowercase identifiers such as `password: str`;
  - url-password: 47 spans are placeholder words;
  - assignment: 13 spans are ALL-CAPS identifiers.

  This only matters for later `skills_propose` runs of those files; it is recorded in 04-02-SCAN.md Gaps for 04-03 and 04-10.
- Both `<automated>` blocks were run verbatim from `/tmp/04-02/t{1,3}-verify.sh` under `/bin/bash`, and each exited 0.

## Threat Flags

None beyond the plan's register. Each mitigation held as observed:
- **T-04-02-01:** the repo is PRIVATE, the owner reviewed the scan, and no value was printed.
- **T-04-02-02:** gh and git ran under env -i, substrate.env has 0 token lines, and output was masked.
- **T-04-02-03:** only `gh repo view` and `gh repo create --private` were run; the delete route exists only in RESTORE.d.
- **T-04-02-04:** clone first, 237 ms swap, 0 dangling links, 11/11 Grok paths.
- **T-04-02-05:** redact()/redactValue() untouched; the existing tests are unmodified and green.

## User Setup Required

None. The repo was created in-plan with the stored credential.

## Next Phase Readiness

- 04-03 imports `scanSkillFiles`/`redactSkillContent` from `packages/mcp-server/src/redact.ts`. It fetches `mirror.git` (main only) and pushes branches to `https://github.com/swcstudiospace/agent-skills.git`.
- 04-04's sync timer finds `/root/agent-skills` clean on `main` with origin set to the GitHub URL. Until the timer exists, nothing fast-forwards the checkout.
- 04-10's unchanged check can pick any of cloudflare, postgres, python, react, stripe, tailwind or typescript (0 skill redactions, 0 findings).
- STATE.md and ROADMAP.md are untouched (orchestrator-owned). `.planning/config.json`, `.planning/state.json`, the phase 5/6 planning files and `issues/` are left unstaged.

## Self-Check: PASSED

- FOUND: packages/mcp-server/src/redact.ts (redactSkillContent, scanSkillFiles), 04-02-SCAN.md (owner_scan_decision=approved), 04-02-SMOKE.md (checkout_links=0)
- FOUND: /var/lib/substrate/skills/mirror.git and /var/lib/substrate/phase4-baseline/RESTORE.d/04-02.md; the snapshot MANIFEST verifies
- FOUND: commits 70c75a0 and f5b5f28 (agent-substrate); 6e34790 and 3ac8572 (swcstudiospace/agent-skills, PRIVATE)
- The Task 1 and Task 3 `<automated>` verifies exited 0 under /bin/bash
