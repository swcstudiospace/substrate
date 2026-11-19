---
phase: 65-doc-watch
verified: 2026-11-19
status: human_needed
score: 2/2 assigned criteria verified in code (2, 3); criteria 1, 4, 5 carried from the 2026-11-18 record, not re-checked in this pass
covered_files: [".planning/phases/65-doc-watch/65-CONTEXT.md", ".planning/phases/65-doc-watch/65-SUMMARY.md", "docs/corpus-watch.md", "docs/runbooks/corpus-sync.md", "packages/collectors/src/install-git-hook.test.ts", "packages/collectors/src/install-git-hook.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/planning-hash-store.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:f807229704bf36ff698de80a07dc1e815833fd16e92aedb929cbd9b2d7a3bafe"
verified_commit: ffacc938a1ebc795d23872531640ab613913ecfa
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 2/2
  gaps_closed:
    - "Criterion 3: SUBSTRATE_PLANNING_HASH_STORE now defaults to on (config.ts: unset or empty is on; flag-registry.ts default \"on\"; settings.test.ts asserts it). The 2026-11-18 record's 'default off' gap no longer holds in code."
    - "Criterion 2: the hint is `corpus hint` with payload {v, dir, at}; the amended criterion (opt-in installer, bounded corpus hint, exit 0, foreign hooks left alone) is what the code implements, and docs/corpus-watch.md states that nothing called docs.changed is written or read."
    - "docs/corpus-watch.md default-off wording corrected by f0c9b6a6: states the flag is on by default, set to a value other than `on` to turn it off."
    - "docs/runbooks/corpus-sync.md corpus-sync runbook wording corrected by 1bde15fd: the `hook` trigger row now describes `substrate corpus hint --repo` in the background with a 10-second timeout where `timeout` exists, always exits 0, the hint is one small file in the spool outside the repository, and post-commit stays the collector."
    - "ROADMAP `docs.changed` warning retired: `grep docs.changed .planning/ROADMAP.md` at ffacc938 returns nothing; criterion 2 wording says 'bounded corpus hint'."
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Run `SUBSTRATE_TEST_PG_URL=<postgres url> bun test packages/mcp-server/src/planning-hash-store.test.ts` against a database with migration step 39 applied."
    expected: "The three 'Postgres adapter against a live index' tests pass: save upserts by path, load reads it back across a second store object."
    why_human: "Those three tests are describe.skip without SUBSTRATE_TEST_PG_URL; no database is reachable from this worktree (credential pending). The SQL adapter against a real planning_page_hashes table is therefore not exercised here."
  - test: "Operator steps for criterion 4 (unchanged from the 2026-11-18 record): install hooks with `substrate corpus hook install --repo R`; copy the units and env file and `systemctl enable --now`; set SUBSTRATE_CORPUS=on with a LightRAG backend; run a live sync."
    expected: "Hooks written with foreign hooks reported and left alone; watcher starts and sweeps; a remote-only push appears in the plane without a local checkout change."
    why_human: "Operator-gated; nothing installed or run on a host in this pass."
---

# Phase 65: Doc Watch — Verification Report (criteria 2 and 3)

**Phase Goal:** When documentation changes in a registered repository, the docs plane follows without a manual ingest, and a server restart re-ingests nothing unchanged.
**Verified:** 2026-11-19
**Verified commit:** `ffacc938a1ebc795d23872531640ab613913ecfa` (includes `f0c9b6a6` planning-hash default-on + corpus-watch wording, and `1bde15fd` corpus-sync runbook wording)
**Status:** human_needed
**Re-verification:** Yes — criteria 2 and 3 re-checked against the code at `ffacc938`, including the `f0c9b6a6`/`1bde15fd` wording fixes; criteria 1, 4 and 5 not re-checked here

## Goal Achievement

### Criterion 2: git hooks send a bounded corpus hint, opt-in, always exit 0, never overwrite a foreign hook

| Check | Evidence | Status |
| --- | --- | --- |
| Opt-in installer | `install-git-hook.ts` installs the `post-merge`, `post-checkout`, `post-rewrite` block only with `--corpus`; `without --corpus no hint hook is written` (test) | ✓ VERIFIED |
| Bounded hint | Block runs `corpus hint --repo "$top"` under `timeout 10`, in background, output to /dev/null; `hints.ts` caps spool at 1,000 files of 4 KiB | ✓ VERIFIED |
| Always exits 0 | `corpusHookBlock` ends `return 0`, background `&`; test "exits 0 whatever the command does" and "does nothing and exits 0" | ✓ VERIFIED |
| Foreign hook never overwritten | `readExisting` returns `foreign`; test "a hook that is not ours is reported and left alone" and "uninstall never touches a foreign hook" | ✓ VERIFIED |
| Damaged marker pair left alone | `intactBlock` requires one begin before one end; tests "reversed or repeated marker pair is left untouched" | ✓ VERIFIED |
| Hint is not `docs.changed` | `docs/corpus-watch.md` line 138: "nothing called `docs.changed` is written or read"; no `docs.changed` string in `packages/` or `docs/` other than that sentence | ✓ VERIFIED against the amended wording |
| corpus-sync runbook wording (1bde15fd) | `docs/runbooks/corpus-sync.md` line 15 `hook` row: runs `substrate corpus hint --repo` in background, 10-second timeout where `timeout` exists, always exits 0, hint is one small spool file outside the repository, `post-commit` stays the collector, installed only by `substrate corpus hook install`, never over a foreign hook | ✓ VERIFIED — matches `install-git-hook.ts:80-100` block |

### Criterion 3: planning hashes live in `planning_page_hashes`; restart re-ingests nothing unchanged; flag on by default

| Check | Evidence | Status |
| --- | --- | --- |
| Separate table | Migration step 39 `planning_page_hashes` in `index-store.ts`, primary key `(destination, path)`; not `corpus_documents` | ✓ VERIFIED |
| Port and adapters | `planning-hash-store.ts`: `memoryPlanningHashStore`, `bunPlanningHashStore` scoped by SHA-256 of the docs URL | ✓ VERIFIED |
| Flag default on | `config.ts:1236` `["", "on"].includes((env.SUBSTRATE_PLANNING_HASH_STORE?.trim() ?? "").toLowerCase())`: unset or empty is on, `off` and other words are off (f0c9b6a6); `flag-registry.ts` default `"on"`; `settings.test.ts` asserts `""` and `" On "` → true, `"1"`, `"true"`, `"yes"`, `"off"` → false | ✓ VERIFIED |
| Flag wired in service | `service.ts:7296-7300` `planningHashStore()` returns null when flag off, else cached table store; `config.ts:688` declares the setting | ✓ VERIFIED |
| Off = nothing read or written | `service.ts` `planningHashStore()` returns null when the flag is off; test "with the flag off nothing is read or written" | ✓ VERIFIED |
| Restart ingests nothing unchanged | Test "a second server over the same store ingests nothing unchanged, and exactly the changed page after an edit" (spy on ingest) | ✓ VERIFIED |
| Failed page not stored | Test "a page the plane failed is not stored, so the next process sends it again" | ✓ VERIFIED |
| Store unreadable / unwritable | Test "costs one full ingest and the pass still completes" | ✓ VERIFIED |
| Postgres adapter against a live table | Three tests in `describeLive` are skipped without `SUBSTRATE_TEST_PG_URL` | ? UNCERTAIN, see human verification |

**Corrected in this pass:** the earlier warnings that `docs/corpus-watch.md` said the flag was off by default and that the corpus-sync runbook described a `docs.changed` hint are both closed by `f0c9b6a6` and `1bde15fd` respectively. `docs/corpus-watch.md` now states the flag is on by default and that nothing called `docs.changed` is written or read; `docs/runbooks/corpus-sync.md` describes the `corpus hint --repo` hook exactly as the installer writes it.

## Required Artifacts (scoped to criteria 2 and 3)

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `packages/collectors/src/install-git-hook.ts` | opt-in hint hook installer | ✓ VERIFIED | `CORPUS_HOOKS`, `corpusHookBlock`, `installCorpusHooks`, `uninstallCorpusHooks` |
| `packages/mcp-server/src/planning-hash-store.ts` | table-backed hash store port and adapters | ✓ VERIFIED | Memory and Bun SQL adapters |
| `packages/mcp-server/src/index-store.ts` | migration step 39 | ✓ VERIFIED | `planning_page_hashes` table |
| `packages/mcp-server/src/config.ts` | flag default on | ✓ VERIFIED | Line 1236, f0c9b6a6 |
| `packages/mcp-server/src/service.ts` | flag gates the store | ✓ VERIFIED | `planningHashStore()` at line ~7296 |
| `docs/corpus-watch.md` | operator description | ✓ VERIFIED | Default-on wording (f0c9b6a6); `docs.changed` negation at line 138 |
| `docs/runbooks/corpus-sync.md` | corpus-sync runbook trigger table | ✓ VERIFIED | `hook` row wording (1bde15fd), line 15 |

No tests were run in this pass (assignment forbids test execution); the test evidence above is from the prior pass's run and from reading the test files at `ffacc938`.

### Criteria 1, 4, 5

Not in this pass's assignment. Carried from the 2026-11-18 record: criterion 1 and 5 met in code and tests; criterion 4 staged but not installed on any host (operator action).

### Anti-Patterns

None in the scoped files at `ffacc938`. The two documentation warnings from the prior pass are closed by `f0c9b6a6` and `1bde15fd`.

### Human Verification Required

1. **Live Postgres adapter test** — `SUBSTRATE_TEST_PG_URL=<url> bun test packages/mcp-server/src/planning-hash-store.test.ts`. Expected: the three live-index tests pass. Why human: no database reachable here.
2. **Criterion 4 operator steps** — hook install, unit install and enable, `SUBSTRATE_CORPUS=on`, live sync. Why human: operator-gated, nothing run on a host.

### Gaps Summary

No blocking gaps for criteria 2 and 3. Status is `human_needed` rather than `passed` because the live Postgres adapter test did not run and criterion 4 is operator-gated. Both prior documentation warnings are fixed in code by `f0c9b6a6` (corpus-watch default-on) and `1bde15fd` (corpus-sync runbook hook wording), and the ROADMAP `docs.changed` wording is gone at `ffacc938`.

---

_Verified: 2026-11-19_
_Verifier: Claude (gsd-verifier)_
