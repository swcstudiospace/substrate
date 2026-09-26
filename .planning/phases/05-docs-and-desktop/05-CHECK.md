---
phase: 05-docs-and-desktop
checker: gsd-plan-checker (independent; Check05)
iteration: 2
checked: 2026-09-26
plans_checked: [05-01, 05-02, 05-03, 05-04, 05-05, 05-06]
tracking: SPE-3572
status: issues_found
blockers: 0
warnings: 0
info: 8
revision_required: false
---

# Phase 5 plan check, iteration 2: docs and desktop

**Result: no revision required.** There are 0 blockers, 0 warnings and 8 info items. Every blocker and warning from iteration 1 is resolved in the plan text, and I found no regressions at blocker or warning level. The frontmatter says `issues_found` only because the plan-checker contract does not allow an INFO-only result to be called `passed`. No revision is needed.

One item needs the orchestrator, not the planner. ROADMAP § Phase 5 still carries the old SC1 and SC3 wording, and it must be updated per D-03 and D-16 before `/gsd-verify-work` (I1).

## What I checked

All of `.planning/phases/05-docs-and-desktop/` was re-read in full: 05-01 to 05-06, 05-VALIDATION.md, 05-PATTERNS.md and COVERAGE.md. It was compared against:
- 05-CONTEXT.md D-01 to D-20;
- RESEARCH, DISCOVERY and BASELINE;
- ROADMAP § Phase 5;
- STATE.md;
- the Phase 4 code now in the working tree (`70c75a0` feat(04-02) landed `redactSkillContent` and `SKILL_RULES`).

Every probe was read-only. Nothing was committed, and no secret was printed. The probes were:
- `gsd-tools verify.plan-structure` on all six plans: valid, with no errors or warnings.
- `phase-plan-index` with a same-wave overlap scan of `files_modified`, which now includes the `RESTORE.d` live files.
- All 16 `<automated>` blocks: each passes `bash -n` and was executed.
- `bun test -t` behaviour when the filter matches nothing.
- Whether `redact()` is idempotent on the spike's page directories.
- The current `redact.ts` and `redact.test.ts`.
- ROADMAP wording.

## Iteration 1 → resolution

| Iter-1 | Severity | Finding | Resolution in iteration 2 | Evidence | Status |
|---|---|---|---|---|---|
| B1 | BLOCKER | The 05-02 spike uploaded pages without `redact()`. | In 05-02 T3 step 5, every body is built as `redact(raw)`, then stripped and hashed. The script asserts `redact(body) === body` before each upload. `spike_redact_applied=true` is a pass condition, is checked by the verify, and has a threat row (T-05-02-07). | I measured that `redact()` is idempotent on both spike directories: 0 of 80 docs-python pages and 0 of 80 docs-openai pages change on a second pass, including after image stripping. This covers `docs-openai/078` (84 embeds), the page `redact()` does change. The new assertion therefore cannot false-fail on these pages. | **Resolved** |
| W1 | WARNING | 05-02 and 05-03 (both wave 1) both wrote `RESTORE.md` and did not declare it. | Only 05-01 writes the `RESTORE.md` index. Each plan writes only its own `RESTORE.d/05-NN.md`, and that file is declared in its `files_modified`. VALIDATION, PATTERNS and COVERAGE were updated to match. | `phase-plan-index` finds no same-wave `files_modified` overlap. Wave 1 is 05-02 (SPIKE, `RESTORE.d/05-02.md`, `.env.example`) and 05-03 (10 repo files plus `RESTORE.d/05-03.md`). | **Resolved** |
| W2 | WARNING | The fixture files were created with no RESTORE route in place. | 05-05 T3 appends `## fixture <nonce>` routes to `RESTORE.d/05-05.md` before creating any fixture file. The routes cover the page, the values file and the RAGFlow document. The verify greps for both nonce paths and `fixture_restore_route_written=true`. | 05-05 T3 action and verify | **Resolved** |
| W3 | WARNING | The D-19 and D-10 test pins were satisfied by Phase 4's own tests. | Every new case has a unique `D-NN …` test name. Each verify runs `bun test <file> -t "<name>"` for 05-03 T3, 05-04 T1/T2 and 05-05 T1. | On bun 1.4.0 (the repo's binary), I checked the behaviour: a matching name gives exit 0 with 1 pass, and a name matching nothing gives exit 1 (`error: regex "…" matched 0 tests`). A missing test therefore fails the verify. | **Resolved** |
| I1 | INFO | The ROADMAP carries the old SC1/SC3 wording. | This is an orchestrator action, and 05-06 T3 records a Gaps note about it. | `.planning/ROADMAP.md` § Phase 5 still says "proxies the existing RAGFlow MCP endpoint (`ragflow_retrieval`)" and "drives cua … or the existing `recruitment-desktop` webtop". | **Open (orchestrator, before verify-work)** |
| I2 | INFO | The HF "Add model" steps missed the instance name and max-tokens default. | Step 3 now lists every field: Instance name `tei` (required), type `embedding`, base URL, empty key, and max tokens changed from 8192 to 512. | 05-02 T2 step 3, which matches v0.26.4 `buildLocalConfig` | **Resolved** |
| I3 | INFO | Nothing confirmed that TEI has no public domain. | The resume signal now asks "TEI has no public domain: yes". `tei_no_public_domain=owner-confirmed` is a verify key. | 05-02 T2/T3 | **Resolved** |
| I4 | INFO | The D-05 grep matched only quoted keys. | The grep is gone. D-05 is now pinned by named tests: `D-05 retrievalBody never sends a chat-model field` and `D-05 createDatasetBody omits embedding_model and auto_metadata_config`. | 05-04 T1 verify | **Resolved** |
| I5 | INFO | The RESTORE grep passed when `dataset_id` was empty. | The verify now checks `^dataset_id=[A-Za-z0-9_-]{16,64}$` before `grep -F`. | 05-04 T3 verify | **Resolved** |
| I6 | INFO | The 05-01 T1 and 05-05 T3 verifies could only be run once. | 05-01 T1 checks `gate-head` against the commit that recorded it, found with `git log -S'gate-head='`, and re-runs the suites only while the code outside `.planning` still equals `gate-head`. 05-05 T3 checks the values file while it exists and otherwise reads 05-PROOF.md's `fixture_values_removed=true`. VALIDATION documents the re-run semantics. | 05-01 T1 and 05-05 T3 verifies | **Resolved** |
| I7 | INFO | The Phase 4 skill-table extension was an unrequested deviation. | It is now recorded as a deviation in the 05-04 objective, with a fallback. A new inconsistency in that fallback is carried as N1. | 05-04 objective | **Resolved** (see N1) |
| I8 | INFO | 05-03 and 05-04 exceed the 10-file threshold. | Unchanged: 05-03 has 11 entries including `RESTORE.d`, and 05-04 has 14. No task touches more than 6 files. Estimates are 75k and 85k tokens against a 100k budget. | `phase-plan-index`, `estimate-check` | Advisory, unchanged |
| I9 | INFO | Docs `source` values mix manifest names and directory names. | Not addressed. It is still the manifest `source`, with the directory name as a fallback. | 05-04 T2 behaviour | Advisory, open |

## Iteration-2 findings

| # | Severity | Plan / task | Issue (evidence) | Required fix (property; the route is only an example) |
|---|---|---|---|---|
| I1 | INFO | Phase level (orchestrator) | **The ROADMAP still has the pre-D-03/D-16 wording for SC1 and SC3.** No plan may edit ROADMAP.md, per D-03. | The orchestrator applies the D-03 and D-16 wording to ROADMAP § Phase 5 before verify-work. |
| N1 | INFO | 05-04 objective against T1 | **The fallback described in the objective cannot pass T1's own checks.**<br><br>The objective says: "If a Phase 4 test pins the exact skill rule table, the executor drops the skill-table addition … rather than editing a Phase 4 test". T1's behaviour bullet, acceptance criteria and verify all still require `"sk-hyphen"` in redact.ts and `redactSkillContent` redactions for both shapes. Taking the fallback would therefore fail T1's verify.<br><br>The risk is low today. The landed Phase 4 `redact.test.ts` iterates only `SKILL_HIGH_CONFIDENCE_RULES`, and nothing pins the full `SkillRedactionRule` union, so the fallback's trigger is not met. The two entries also need the `d` (indices) flag, which Phase 4's `SKILL_RULES` uses; the behaviour test would catch it if missing. | A documented fallback route must be passable by the task's own `<automated>`. Either make the skill-table greps and bullet conditional on a recorded deviation key, or drop the fallback sentence. |
| N2 | INFO | 05-VALIDATION.md execution note; 05-02 T1/T3 and 05-03 T1-T3 | **The note that the wave-1 plans "write no common file (repo or live) and may run concurrently" misses the shared git index.**<br><br>Both plans run `git add -- <path>` and `git commit` in one working tree. 05-02 T1 now also commits `.env.example`. If the two plans run concurrently, a plain `git commit` from one plan can sweep up the other plan's staged path.<br><br>The phase is safe as configured, because `workflow.use_worktrees=false` makes execute-phase run the wave sequentially. | Any concurrency claim must account for the shared index. For example, commit with `git commit -- <paths>`, which has only-these-paths semantics, or state that wave 1 runs sequentially. |
| N3 | INFO | 05-05 T3 / 05-06 T3 | **The raw fake values survive in the fixture page.**<br><br>05-06 T3 deletes `fixture-<nonce>.values`, but `/var/lib/substrate/docs/fixtures/redaction-fixture-<nonce>.md` (0600, in a 0700 directory) keeps the same four generated values in raw form, and it stays after the phase. The values are fake, and `RESTORE.d/05-05.md` holds a route to delete the page. Still, "values removed" is only partly true, and T-05-06's claim that "fake values exist briefly" is inaccurate. | Evidence should state that the fixture page keeps the fake values, or the page should be removed or rewritten after 05-06 T2's re-check. RAGFlow holds only the redacted copy. |
| N4 | INFO | COVERAGE.md D-05 row; 05-01 T1 `<files>` | **Two stale references remain after the revision.**<br><br>- The COVERAGE D-05 row still says "(retrievalBody / createDatasetBody tests + grep)", but the grep has been removed.<br>- 05-01's frontmatter declares `/var/lib/substrate/phase5-baseline/RESTORE.md`, but T1's `<files>` lists only 05-BASELINE.md. | Coverage and task file lists match the plan text. |
| I8 | INFO | 05-03, 05-04 | Carried over from iteration 1: two plans exceed the 10-file threshold. See the resolution table. | Advisory. |
| I9 | INFO | 05-04 T2, 05-05 `docs_search` | Carried over from iteration 1: `source` filter values are not uniform across exports. | Advisory. |
| X1 | INFO | Phase 4 dependency | **Phase 4 is only partly landed.** 04-02 is in `HEAD` (`70c75a0`). `propose.key`, `skills/propose-auth.ts` and 04-VERIFICATION.md do not exist yet. 05-01 T1 correctly stops until Phase 4 is verified or explicitly accepted. | None. This records state; 05-01 T1 is the gate. |

## Re-verification of the check areas

1. **Coverage.**
   - SC1 (D-03 wording), SC2 and SC3 (D-16 wording), the D-14 proof parts 1-4 and D-01 to D-20 each map to tasks with observable keys or named tests.
   - The COVERAGE claims that failed in iteration 1 now hold:
     - D-09 covers the spike.
     - D-19 has a named test for each case.
     - Every live change has a RESTORE route written first.
   - The deferred Recall items (Agentmemory, chat transcripts, context_search, hindsight/supermemory) and RAGFlow chat, agents, Memory, GraphRAG and RAPTOR are absent from every plan.
2. **Graph, waves and file overlap.**
   - The waves are {0:[05-01], 1:[05-02, 05-03], 2:[05-04], 3:[05-05], 4:[05-06]}. The graph is acyclic, and no same-wave plans share an entry in `files_modified`.
   - Live resources in wave 1 are separated:
     - The substrate-mcp restart and the container belong to 05-03 only.
     - `substrate.env` is written only by the owner in 05-02 T2.
     - The RESTORE files are now per plan.
   - The shared git index is N2 (info).
   - 05-03 edits `types.ts`, `service.ts` and `mcp.ts` strictly before 05-05 does (05-05 → 05-04 → 05-03), and both anchor on Phase 4 symbols.
3. **Automated blocks.**
   - All 16 pass `bash -n`.
   - All 16 exit non-zero before execution, each at its first missing artifact. Exit codes:
     - 05-01: 1, 1
     - 05-02: 1, 1
     - 05-03: 127, 1, 1
     - 05-04: 1, 1, 1
     - 05-05: 1, 1, 1
     - 05-06: 1, 1, 1
   - None has side effects. The only `rm -` string is inside a `grep` pattern.
   - The new `-t` named-test gates do fail when a test is missing (checked on bun 1.4.0).
   - 05-02 T1's `.env.example` checks fail today, as they should: there is no `RAGFLOW_DATASET_ID=` line yet, and the RAGFLOW lines are empty.
4. **Safety.**
   - Unchanged and still correct from iteration 1: `recruitment-desktop` is never named or touched, `--pull never`, loopback on 6081 with basic auth, and presence-only owner verification.
   - There is no silent fallback: a spike failure or owner "skip" stops the phase.
   - D-19 guards (tested by name), path-based ingest under the 1 MB cap, and no chat-model fields (pinned by named tests).
   - Redact runs before hash and upload everywhere, now including the spike.
   - The redaction regexes still pass the tested cases, with 0 hits on the current library.
   - The TEI and HF owner steps are accurate for RAGFlow v0.26.4, and the instance-name gap is fixed.
5. **Proof.** Unchanged and still valid:
   - a real `claude -p` (2.1.278) with a session-scoped `--mcp-config` and `--strict-mcp-config`;
   - the tracer URL must appear in both the tool result and the answer;
   - `tool.call` and `desktop.action` events are read back from Greptime;
   - the header for `desktop_run` comes from a `headersHelper`.
6. **Scope.**
   - No stubs and no in-scope deferrals.
   - The only unrequested addition is the recorded I7 deviation (see N1).
   - Moving `.env.example` to 05-02 T1 fits D-02, and 05-04 no longer edits it.

## Structured issues

```yaml
issues:
  - plan: null
    dimension: context_compliance
    severity: info
    required_property: "ROADMAP § Phase 5 carries the D-03/D-16 success-criteria wording before verify-work"
    description: "roadmap still reads 'proxies the existing RAGFlow MCP endpoint (ragflow_retrieval)' and 'drives cua … or the existing recruitment-desktop webtop'"
    fix_hint: "Orchestrator applies D-03/D-16 wording"
  - plan: "05-04"
    task: 1
    dimension: task_completeness
    severity: info
    required_property: "A documented fallback route is passable by the task's own automated verify"
    description: "Objective allows dropping the skill-table addition; T1 behaviour/acceptance/verify still require \"sk-hyphen\" in redact.ts"
    fix_hint: "Make the skill-table checks conditional on a recorded deviation key, or remove the fallback"
  - plan: "05-02,05-03"
    dimension: dependency_correctness
    severity: info
    required_property: "Concurrency claims account for the shared git index"
    description: "VALIDATION says wave-1 plans write no common file and may run concurrently; both stage and commit in one working tree"
    fix_hint: "git commit -- <paths>, or state wave 1 runs sequentially (use_worktrees=false already does)"
  - plan: "05-05,05-06"
    dimension: verification_derivation
    severity: info
    required_property: "Evidence of fake-value removal matches what remains on disk"
    description: "fixture .md keeps the raw fake values after 05-06 deletes the values file"
    fix_hint: "State it in evidence, or remove/rewrite the fixture page after the re-check"
  - plan: "05-01,COVERAGE"
    dimension: verification_derivation
    severity: info
    required_property: "Coverage text and task file lists match the plan text"
    description: "COVERAGE D-05 row still cites a removed grep; 05-01 T1 <files> omits RESTORE.md declared in frontmatter"
    fix_hint: "Refresh the two strings"
```

## Recommendation

**Advisory only: no revision required.** The plans can go to `/gsd-execute-phase 5` once Phase 4 is verified; 05-01 T1 enforces that. Before verify-work, the orchestrator must apply the D-03 and D-16 ROADMAP wording (I1).
