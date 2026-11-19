---
phase: 65-doc-watch
verified: 2026-11-19
status: human_needed
score: 2/2 assigned criteria verified in code (2, 3); criteria 1, 4, 5 carried from the 2026-11-18 record, not re-checked in this pass
covered_files: [".planning/phases/65-doc-watch/65-CONTEXT.md", ".planning/phases/65-doc-watch/65-SUMMARY.md", "docs/corpus-watch.md", "infra/vps/substrate-corpus-sync.service", "infra/vps/substrate-corpus-sync.timer", "infra/vps/substrate-corpus-watch.service", "packages/cli/src/corpus/watch-commands.ts", "packages/collectors/src/install-git-hook.test.ts", "packages/collectors/src/install-git-hook.ts", "packages/corpus/src/coalesce.ts", "packages/corpus/src/hints.ts", "packages/corpus/src/watch.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/reconcile.ts", "packages/mcp-server/src/docs-freshness.ts", "packages/mcp-server/src/event-sources.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/planning-hash-store.test.ts", "packages/mcp-server/src/planning-hash-store.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v4:sha256:73fc693cd7f8992bd1e1e33351e9c9ff7f60403ac35de0997fe6d954d8f5873e"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 3/5
  gaps_closed:
    - "Criterion 3: SUBSTRATE_PLANNING_HASH_STORE now defaults to on (config.ts: unset or empty is on; flag-registry.ts default \"on\"; settings.test.ts asserts it). The 2026-11-18 record's 'default off' gap no longer holds in code."
    - "Criterion 2: the hint is `corpus hint` with payload {v, dir, at}; the amended criterion (opt-in installer, bounded corpus hint, exit 0, foreign hooks left alone) is what the code implements, and docs/corpus-watch.md states that nothing called docs.changed is written or read."
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
**Status:** human_needed
**Re-verification:** Yes — after gap closure (criteria 2 and 3 re-checked against the code as it is in the worktree; criteria 1, 4 and 5 not re-checked here)

## Goal Achievement

### Criterion 2: git hooks send a bounded corpus hint, opt-in, always exit 0, never overwrite a foreign hook

| Check | Evidence | Status |
| --- | --- | --- |
| Opt-in installer | `install-git-hook.ts` installs the `post-merge`, `post-checkout`, `post-rewrite` block only with `--corpus`; `without --corpus no hint hook is written` (test) | ✓ VERIFIED |
| Bounded hint | Block runs `corpus hint --repo "$top"` under `timeout 10`, in background, output to /dev/null; `hints.ts` caps spool at 1,000 files of 4 KiB | ✓ VERIFIED |
| Always exits 0 | `corpusHookBlock` ends `return 0`, background `&`; test "exits 0 whatever the command does" and "does nothing and exits 0" | ✓ VERIFIED |
| Foreign hook never overwritten | `readExisting` returns `foreign`; test "a hook that is not ours is reported and left alone" and "uninstall never touches a foreign hook" | ✓ VERIFIED |
| Damaged marker pair left alone | `intactBlock` requires one begin before one end; tests "reversed or repeated marker pair is left untouched" | ✓ VERIFIED |
| Hint is not `docs.changed` | `docs/corpus-watch.md` line 138: "nothing called `docs.changed` is written or read" | ✓ VERIFIED against the amended wording |

**Warning (not blocking):** `.planning/ROADMAP.md` line 1112 still says the hook "sends a bounded `docs.changed` hint". The ROADMAP criterion needs the same amendment the docs already carry, or the code needs to emit that name. Scoped out of this pass; owner decides.

### Criterion 3: planning hashes live in `planning_page_hashes`; restart re-ingests nothing unchanged; flag on by default

| Check | Evidence | Status |
| --- | --- | --- |
| Separate table | Migration step 39 `planning_page_hashes` in `index-store.ts` (line ~843), primary key `(destination, path)`; not `corpus_documents` (step at line ~704) | ✓ VERIFIED |
| Port and adapters | `planning-hash-store.ts`: `memoryPlanningHashStore`, `bunPlanningHashStore` scoped by SHA-256 of the docs URL | ✓ VERIFIED |
| Flag default on | `config.ts:1236` `["", "on"].includes(...)`: unset or empty is on, `off` and other words are off; `flag-registry.ts` default `"on"`; `settings.test.ts` asserts `""` and `" On "` → true, `"1"`, `"true"`, `"yes"`, `"off"` → false | ✓ VERIFIED |
| Off = nothing read or written | `service.ts` `planningHashStore()` returns null when the flag is off; test "with the flag off nothing is read or written" | ✓ VERIFIED |
| Restart ingests nothing unchanged | Test "a second server over the same store ingests nothing unchanged, and exactly the changed page after an edit" (spy on ingest) | ✓ VERIFIED |
| Failed page not stored | Test "a page the plane failed is not stored, so the next process sends it again" | ✓ VERIFIED |
| Store unreadable / unwritable | Test "costs one full ingest and the pass still completes" | ✓ VERIFIED |
| Postgres adapter against a live table | Three tests in `describeLive` are skipped without `SUBSTRATE_TEST_PG_URL` | ? UNCERTAIN, see human verification |

**Warning (not blocking):** `docs/corpus-watch.md` still says the flag is "off by default" (line 5) and "With the flag off, the default, they are kept in memory only" (line 26). The code, `flag-registry.ts`, `docs/config-reference.md` line 258 and `docs/runbooks/corpus-sync.md` line 31 all say on. The operator page is wrong and must be corrected by its owner; no code change is needed for criterion 3.

**Warning (not blocking):** the in-memory `planningHashes` map is still the working set during a pass, loaded from and saved to the table. This matches the amended criterion ("planning hashes live in the separate table"), not the original "read from the manifest" wording.

### Required Artifacts (criteria 2 and 3)

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `packages/collectors/src/install-git-hook.ts` | opt-in hint hook installer | ✓ VERIFIED | `CORPUS_HOOKS`, `corpusHookBlock`, `installCorpusHooks`, `uninstallCorpusHooks` |
| `packages/mcp-server/src/planning-hash-store.ts` | table-backed hash store port and adapters | ✓ VERIFIED | Memory and Bun SQL adapters |
| `packages/mcp-server/src/index-store.ts` | migration step 39 | ✓ VERIFIED | `planning_page_hashes` table |
| `packages/mcp-server/src/config.ts` | flag default on | ✓ VERIFIED | Line 1236 |
| `docs/corpus-watch.md` | operator description | ✗ WARNING | States the flag is off by default; contradicts code |

### Test Run

`bun test packages/collectors/src/install-git-hook.test.ts packages/mcp-server/src/planning-hash-store.test.ts --timeout 60000` (one invocation, both files):

- 23 pass, 0 fail, 3 skip (the live Postgres suite, `describeLive`, skipped without `SUBSTRATE_TEST_PG_URL`)
- stderr lines `[substrate] planning hashes not loaded — connection refused` and `... not saved — read-only transaction` are the expected output of the failure-path tests, not failures.

### Criteria 1, 4, 5

Not in this pass's assignment. Carried from the 2026-11-18 record: criterion 1 and 5 met in code and tests; criterion 4 staged but not installed on any host (operator action).

### Anti-Patterns

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| `docs/corpus-watch.md` | 5, 26 | Says flag off by default | ⚠️ Warning | Operator docs contradict code |
| `.planning/ROADMAP.md` | 1112 | Names `docs.changed` hint | ⚠️ Warning | Criterion wording stale against code |

### Human Verification Required

1. **Live Postgres adapter test** — `SUBSTRATE_TEST_PG_URL=<url> bun test packages/mcp-server/src/planning-hash-store.test.ts`. Expected: the three live-index tests pass. Why human: no database reachable here.
2. **Criterion 4 operator steps** — hook install, unit install and enable, `SUBSTRATE_CORPUS=on`, live sync. Why human: operator-gated, nothing run on a host.

### Gaps Summary

No blocking gaps for criteria 2 and 3. Status is `human_needed` rather than `passed` because the live Postgres adapter test did not run and criterion 4 is operator-gated. Two documentation warnings (`docs/corpus-watch.md` default-off wording; ROADMAP `docs.changed` wording) need their owners to correct them.

---

_Verified: 2026-11-19_
_Verifier: Claude (gsd-verifier)_
