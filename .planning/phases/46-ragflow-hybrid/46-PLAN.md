---
phase: 46-ragflow-hybrid
plan: 46
type: execute
wave: 1
depends_on: []
files_modified:
  - packages/mcp-server/src/docs-search.test.ts
  - packages/mcp-server/src/server.test.ts
  - packages/mcp-server/src/parity-gate.ts
  - packages/mcp-server/src/parity-gate.test.ts
  - scripts/parity-gate.ts
  - scripts/lightrag-probe.test.ts
  - package.json
  - docs/runbooks/lightrag-cutover.md
  - docs/docs-plane.md
  - packages/mcp-server/src/config.ts
  - packages/mcp-server/src/fabric/types.ts
  - packages/mcp-server/src/planes/ragflow.ts
  - packages/mcp-server/src/planes/ragflow.test.ts
  - packages/mcp-server/src/docs-archive.ts
  - packages/mcp-server/src/docs-archive.test.ts
  - scripts/docs-smoke.ts
  - .env.example
  - docs/config-reference.md
autonomous: false
requirements: [SOTA-02]
user_setup: []
must_haves:
  truths:
    - "docs_search answers from LightRAG on origin/main with hybrid as the code default and the Hindsight context block behind context: true, covered by tests (criterion 1, met in repo)."
    - "The RAGFlow dataset archive does not exist. Its writer on this branch needs a live RAGFlow API that was deleted on 2026-10-25, so criterion 2 stays open until the operator decides (D1)."
    - "PARITY_GATE has no implementation on origin/main. Part A and Part B are built offline and run live only after operator approval (criterion 4)."
    - "Production serves docs from LightRAG since the Run 11 cutover (2026-10-28). The reversal target RAGFlow no longer exists, so the switch is not reversible to RAGFlow (criterion 5)."
    - "RAGFlow code is removed only as a draft PR, and merge waits on the criterion 5 gate: criteria 1 to 4 pass or are waived, RAG-dependent phases pass or are waived, and the operator approves."
    - "No live step runs without per-run operator approval (criterion 6)."
  artifacts:
    - "packages/mcp-server/src/parity-gate.ts exports the Part A record mapping check and the Part B sample check as pure functions."
    - "scripts/parity-gate.ts is a read-only CLI with --part A or B. Without LIGHTRAG_URL it exits 2 and opens no socket."
    - "docs/runbooks/lightrag-cutover.md records the Run 11 cutover facts, the reversal limits and the delta-pass procedure, with env key names only."
    - "A draft PR removes planes/ragflow.ts and the RAGFlow docs plane. It is not merged until the criterion 5 gate records approval."
  key_links:
    - "docs-search.ts dispatch on DocsBackend: after removal the type is lightrag only, and resolveDocsBackend in config.ts no longer returns ragflow."
    - "fabric/types.ts FABRIC_RESOURCES loses ragflow, which changes the phase 51 contract and its tests."
    - "scripts/lightrag-probe.ts uses lightragFromEnv and LIGHTRAG_HEALTH_PATH, so no new reach reader is added."
---

# Phase 46 plan: LightRAG hybrid RAG and RAGFlow removal (re-scoped on origin/main)

<objective>
Re-scope Phase 46 (SOTA-02) against origin/main at b1b42f92. Replace the stale RAGFlow-premise plan with the work that remains.

Purpose: the RAGFlow service was deleted on 2026-10-25 and LightRAG has served production since the Run 11 cutover (2026-10-28). Most of the stale plan's live tasks are already done, impossible, or no longer apply. What is left is offline proof work, the operator decisions it cannot avoid, live checkpoints, and a gated RAGFlow removal.

Output: this plan; offline tasks 46-01 to 46-06; operator checkpoints C1 to C7; decision points D1 to D6.

Source of truth: ROADMAP.md "### Phase 46" success criteria (verbatim, not rewritten); STATE.md Run 11 and "Accepted debt (owner decision, 2026-10-28)"; archived governing plan `.planning/milestones/v1.5-phases/46-lightrag-hybrid/PLAN.md`, which supersedes `46-ragflow-hybrid/` (SUPERSEDED.md).
</objective>

<status>
## Criteria status at origin/main (b1b42f92), checked against the repository

Method: files and symbols were read on origin/main, plus the five branch commits on gsd/p46-offline. Nothing was executed and no live system was called.

| # | Criterion (ROADMAP wording, shortened) | Status | Evidence | Remaining |
|---|---|---|---|---|
| 1 | docs_search answers from LightRAG, hybrid search and Hindsight context, with tests | MET IN REPO. Hybrid in production is OPERATOR-GATED | `planes/lightrag.ts:59` `DEFAULT_QUERY_MODE = "hybrid"`. origin/main `docs-search.test.ts` has LightRAG context tests at line 1633 ("docs_search context on the LightRAG backend (Q2, Q3)") and breaker and fallback tests at lines 638 to 746. Production runs `SUBSTRATE_LIGHTRAG_QUERY_MODE=naive` (STATE, Run 11) | Trim branch commit 432a330a to non-duplicate cases (T1). Real LLM route for hybrid: D5 |
| 2 | RAGFlow dataset archived, verified checksum, before any deletion | NOT MET. Order violated | `docs-archive.ts` (branch commit 4076ccdd) is not wired to any CLI. `archiveRagflow` reads the live RAGFlow API through `ragflowArchiveSource`, and that service was deleted 2026-10-25. No archive or checksum exists in the repo. Operator re-scope note (ROADMAP line 721): RAGFlow was empty (no datasets, empty knowledgebase folder) | D1, then C2 |
| 3 | LightRAG deployed to production and passes a timed health probe | DEPLOY MET LIVE (Run 11, naive). TIMED PROBE NOT RUN | Run 11 (2026-10-28): `lightrag` v1.5.7, `lightrag-postgres`, `lightrag-llm-bypass`; `lightrag-smoke-run --confirm-live` passed six checks; production moved to release `5cf930a0`. `scripts/lightrag-probe.ts` (branch commit dff36981) implements the OD-5 timed probe, but no run is recorded | C1 |
| 4 | Migration job and parity comparator pass PARITY_GATE before any ingestion | NOT MET. No comparator | `PARITY_GATE` appears only in archived records on origin/main. `scripts/parity-check.ts` is a different host check (it reads unit state and `/healthz`) | T3 (offline), C3 and C4 (live), D2 and D3 |
| 5 | Cutover logged and reversible, with a delta pass. RAGFlow removed after cutover, criteria 1 to 4, and RAG-dependent phases. Storage deletion separately approved | PARTIAL. Cutover done, but reversal is not possible and the removal order was not followed | Cutover: STATE Run 11, `SUBSTRATE_DOCS_BACKEND=lightrag` (logged in STATE, not in a dedicated record). Delta pass: not recorded. Reversal: RAGFlow is deleted, so `SUBSTRATE_DOCS_BACKEND=ragflow` cannot be restored. The service was deleted 2026-10-25, before the 2026-10-28 cutover, and `56-lightrag-contract/VERIFICATION.md` says the docs plane had no backend in between. Removal: `planes/ragflow.ts` still on origin/main; 13 files import it (including tests); 65 files under packages/ and scripts/ name RAGFlow (36 non-test source files) | T5 (record), C4 (delta), D4 (reversal), T6 to T8 (gated removal), C5 to C7 |
| 6 | Each live step runs only after per-run operator approval | OPERATOR-GATED. Standing rule | No approval for this run is recorded. Owner accepted criteria 2, 4, 5, 6 as debt on 2026-10-28, and accepting debt does not mark them passed (STATE) | All C checkpoints |

Criterion 5 RAG-dependent phases (from the phase 46 PLAN rule "any other phase whose VERIFICATION names a live RAGFlow call"). Checked against the milestone VERIFICATION files:

| Phase | VERIFICATION names a RAGFlow call | Status | Action |
|---|---|---|---|
| 25 Docs search and ingest (RAGFlow) | Substrate door on RAGFlow; live G1-G4 tail operator-gated (ROADMAP) | Completed, live tail not run | Re-check against LightRAG, or waive (D6) |
| 40 DOCS-MEMORY | TCP reachability of RAGFlow | Accepted debt 2026-10-23 | Waive or re-check (D6) |
| 42 SKILL-CARD | Fake RAGFlow; live host fast-forward not run | Accepted debt 2026-10-23 | Waive or re-check (D6) |
| 51 Enterprise fabric | Live RAGFlow GET probes | Completed | Removed by T6 (the `ragflow` resource leaves FABRIC_RESOURCES). Contract change: D6 |
| 34 Invalid-write round trip | Fake RAGFlow only ("nothing here reads a live RAGFlow dataset") | Completed | Excluded, as the superseded PLAN also did. Operator confirms (D6) |

Note: the live proofs named for phases 25 and 42 target RAGFlow, which no longer exists. They can pass only against LightRAG, or they need a recorded waiver. Either way, criterion 5 cannot pass as written without an operator decision.
</status>

<operator_decisions>
These are answered at the plan gate. Each default applies if the operator approves the plan unchanged. None is auto-accepted.

- D1 Archive (criterion 2). Options: (a) the RAGFlow Railway volume still exists. The operator checks it read-only and approves a volume-level archive, which is new work and not the existing writer. (b) Attest the 2026-10-25 empty check as the archive record, with a checksum over the attestation only, and record that no data was archived. (c) Keep criterion 2 as debt (accepted 2026-10-28) and retire `docs-archive.ts`. Default: (c). Under (c) T7 deletes `docs-archive.ts` and its test.
- D2 Parity source (criterion 4). The RAGFlow dataset was empty, so there are zero RAGFlow records to migrate. Default: PARITY_GATE applies to the corpus as LightRAG holds it. Part A compares LightRAG's document records with the docs state manifest (dataset, source URL, version). Part B runs the sample in D3 against production. Alternative: the operator waives both parts as not applicable to an empty source, and records that in STATE.md.
- D3 Sample and threshold (criterion 4). The governing archived PLAN sets 10 frozen queries with a 100 percent match rate, fail-closed. The superseded design set 20 queries and at least 0.85. Default: the governing 10 queries at 100 percent. Note that one miss fails the gate. Match means a top-5 citation (the docs_search default limit) comes from the expected document.
- D4 Reversibility (criterion 5). RAGFlow cannot be restored, so `SUBSTRATE_DOCS_BACKEND=ragflow` is not a real reversal. Default: record it as accepted. Reversal is then the app rollback plus restoring `substrate.env` from its backup. Rollback to `702ed32e` is app-only, and that release has no LightRAG client.
- D5 Hybrid in production (criterion 1 wording, "hybrid search"). Hybrid is the code default, but production is naive until an LLM route exists (STATE, Run 11). Default: criterion 1 is met in repo, and hybrid in production stays operator-gated, as STATE records.
- D6 RAG-dependent gate and removal. Default: (a) the operator waives the live re-checks of 25, 40 and 42 with a dated STATE.md entry, because those checks name RAGFlow and cannot pass against it. Or the operator re-scopes each one to LightRAG. (b) Phase 34 is excluded, as in the superseded PLAN. (c) Removing `ragflow` from FABRIC_RESOURCES is approved as a phase 51 contract change. (d) The directory name `46-ragflow-hybrid` is kept, as the brief asks. SUPERSEDED.md names `46-lightrag-hybrid` as the governing folder, so the operator may rename it.
Status, recorded by the offline executor (2026-11-10): every Dn above is an AGENT DEFAULT, PENDING OPERATOR. None is decided. Recorded as "agent default, pending operator":
- D1 = (c). Agent default, pending operator. Criterion 2 stays debt. `docs-archive.ts` is not deleted in this run.
- D2 = PARITY_GATE against LightRAG records. Agent default, pending operator. RAGFlow was empty.
- D3 = 10 frozen queries at 100 percent, top-5 citation. Agent default, pending operator.
- D4 = reversal to RAGFlow is impossible. Agent default, pending operator. NOT ACTED ON in this run: the cutover record does not accept reversal as a decided limit.
- D5 = hybrid in production stays off. Agent default, pending operator.
- D6 = (a) waive 25, 40, 42; (b) exclude 34; (c) remove `ragflow` from FABRIC_RESOURCES; (d) keep folder name. Agent default, pending operator. NOT ACTED ON in this run: no removal, no waiver, no FABRIC_RESOURCES change.
</operator_decisions>

## Frozen sample

Frozen by T2 (2026-11-10, read-only, by content). Query wording is fixed. Source: the governing archived plan T3, with Q8 amended as recorded there (archived PLAN, line 74, operator approval 2026-10-25). Line numbers below are the current ones; the archived plan's line numbers were stale. Match rule (D3, agent default, pending operator): a query passes when a top-5 citation comes from the expected document; the gate is 100 percent, fail-closed.

| # | Query | Expected source | Line(s) | Confirmed fact |
|---|-------|-----------------|---------|----------------|
| Q1 | Which LightRAG query mode does docs_search use by default? | `docs/docs-plane.md` | 126 | "The query mode defaults to `hybrid` (`DEFAULT_QUERY_MODE` in ...)" |
| Q2 | How does docs ingest refuse secrets or unsourced pages? | `docs/docs-search-ingest.md` | 267-280 | "## The six ingest refusals": a redactor finding is refused; a page with no source URL is refused |
| Q3 | How is Hindsight memory governed for retained memories? | `docs/memory-governance.md` | 594-595 | "Hindsight holds a *derived* copy of every accepted entry" |
| Q4 | How are Greptime ledger events stored and read? | `docs/greptime-ledger.md` | 32, 39 | "Reads go through `events_query` and `events_verify`"; "## Schema" |
| Q5 | What is the closed event vocabulary? | `docs/event-vocabulary.md` | 15 | "Closed vocabulary, both enums." |
| Q6 | How does the redactor treat secrets in output? | `docs/redaction.md` | 7-14 | "Thirty-nine named rules on the event pass" |
| Q7 | How does the substrate dispatcher start a Hermes session? | `docs/dispatcher.md` | 3 | "Turns a Linear `dispatch:<surface>` label into a Hermes session" |
| Q8 | What does the skills propose flow check before it opens a pull request? | `docs/skills-propose.md` | 60-62, 66-75 | "## What is checked, and in what order" (name, paths, UTF-8, byte cap, SKILL.md, redaction) and "## Duplicates" (content_sha256 answers) |
| Q9 | How does the Railway service connect over Tailscale? | `docs/railway-tailscale.md` | 5-7 | "## Why a forwarder per project"; one Tailscale Forwarder per project's production environment |
| Q10 | What does the MCP audit log record? | `docs/mcp-audit.md` | 6 | "One hash-chained record per call an agent made to `substrate-mcp`" |

All ten files exist, and each pairing was confirmed against its content. The duplicate-check grep in T2's verify (`What is checked, and in what order`, `## Duplicates`) matches `docs/skills-propose.md` at lines 60 and 66.

<execution_split>
Executors split this plan into sub-plans. Each stays within the 2-3 task budget.

- 46-01 (wave 1, offline): T1, T2
- 46-02 (wave 1, offline): T3, T4
- 46-03 (wave 1, offline): T5
- 46-04 (wave 2, offline, draft only): T6
- 46-05 (wave 2, offline, draft only): T7
- 46-06 (wave 2, offline, draft only): T8
- Checkpoints C1 to C7 are live and each needs its own operator approval. They are not sub-plans and no executor runs them.

Gates: 46-04 to 46-06 open only after 46-01 to 46-03 land and the operator answers D1 to D4. Merging the removal waits on C5 to C7 and on D6.
</execution_split>

<tasks>

<task type="auto">
  <name>Task 1: Trim the SC1 LightRAG tests to cases with no equivalent on main (criterion 1)</name>
  <files>packages/mcp-server/src/docs-search.test.ts, packages/mcp-server/src/server.test.ts</files>
  <action>
Review branch commit 432a330a against origin/main. origin/main already has the LightRAG context cases in the describe "docs_search context on the LightRAG backend (Q2, Q3)" (docs-search.test.ts line 1633). That covers context true (memories and last five ledger events), context absent, and context false, and the default hybrid query mode. Those three are duplicates: remove them from 432a330a's describe "on the LightRAG backend (SC1)".

Keep the cases that main does not cover: (a) with no session, the context has no events, names no-session, and keeps the memories; (b) a LightRAG context reply is never stored, and a repeat keeps its own events; (c) a LightRAG search that fails its retries is answered from Hindsight, is not stored, and names the LightRAG reason; (d) the REST route POST /docs/search on the LightRAG backend in server.test.ts, which checks that the context key is attached only when asked.

Do not change product code. If a kept case needs a fake fix, change the fake only. Make one commit.
  </action>
  <verify>
    <automated>bun test packages/mcp-server/src/docs-search.test.ts packages/mcp-server/src/server.test.ts</automated>
  </verify>
  <done>No test title appears twice in the LightRAG context describes. The kept cases are listed in the commit message. The targeted tests pass. Criterion 1 evidence now points to origin/main line 1633 and to the four kept cases.</done>
</task>

<task type="auto">
  <name>Task 2: Freeze the 10-query PARITY sample and re-check each pairing against its file (criterion 4, sample)</name>
  <files>.planning/phases/46-ragflow-hybrid/46-PLAN.md</files>
  <action>
The governing archived plan (`.planning/milestones/v1.5-phases/46-lightrag-hybrid/PLAN.md`, T3) lists ten queries. Nine were confirmed by reading on 2026-10-24. Q8 was amended on 2026-10-25 to "What does the skills propose flow check before it opens a pull request?", with the source `docs/skills-propose.md`, sections "What is checked, and in what order" and "Duplicates". That re-check is still pending.

Read each source file and confirm its fact by content, not by name. Record the file, the line and the matching fact in a table in this plan file, under a heading "Frozen sample". Use the amended Q8 wording. Do not change any query wording after this task. Write the sample in the plan file, so the sample lives in the repo and not only in a closed archive.

Default under D3: ten queries, 100 percent match, top-5 citation. If the operator picks 20 queries and 0.85, extend the table with ten more pairings, each confirmed the same way, and record the change.
  </action>
  <verify>
    <automated>for f in docs/docs-plane.md docs/docs-search-ingest.md docs/memory-governance.md docs/greptime-ledger.md docs/event-vocabulary.md docs/redaction.md docs/dispatcher.md docs/skills-propose.md docs/railway-tailscale.md docs/mcp-audit.md; do test -f "$f" || echo "MISSING $f"; done; grep -n "What is checked, and in what order\|^## Duplicates" docs/skills-propose.md</automated>
  </verify>
  <done>All ten files exist. Each pairing is confirmed by a quoted line or section name. The Q8 amendment is applied, and the frozen table is in this plan file.</done>
</task>

<task type="auto">
  <name>Task 3: Build the PARITY_GATE comparator, offline, read-only by default (criterion 4 build; delta pass input for criterion 5)</name>
  <files>packages/mcp-server/src/parity-gate.ts, packages/mcp-server/src/parity-gate.test.ts, scripts/parity-gate.ts, package.json</files>
  <action>
Build two pure functions with injected reads, plus a CLI.

Part A, record mapping. Input: the docs state manifest records (the file at SUBSTRATE_DOCS_STATE, keyed `lightrag::`) and a LightRAG document listing. Compare dataset, source URL and version for each record. Zero mismatches is the pass, and extra or missing records are mismatches. Before writing the field mapping, read `ingestDocsLightrag` in `docs-ingest.ts` to confirm how LightRAG stores the source URL and version. The LightRAG listing uses `POST /documents/paginated`, which the recorded route fixture lists (`planes/__fixtures__/lightrag-v1.5.7-routes.json`). Do not add a route that the fixture does not list.

Part B, sample. Input: the frozen sample from 46-01 and a query function. A query passes when at least one of the top five citations comes from the expected document. The match rate is passes divided by queries. Pass is at least the threshold set in the plan (default 1.0 under D3).

The CLI is `scripts/parity-gate.ts --part A|B`. It takes the LightRAG reach only through `lightragFromEnv` in config.ts, and it prints counts only, never a key or a host. Without `LIGHTRAG_URL` it exits 2 and opens no socket. It writes nothing to any store. Part B calls `/query` in the mode the server is configured for, and the output records that mode.

Add the package.json script `parity:gate`. Tests use fakes only.
  </action>
  <verify>
    <automated>bun test packages/mcp-server/src/parity-gate.test.ts; env -u LIGHTRAG_URL bun scripts/parity-gate.ts --part A; test $? -eq 2</automated>
  </verify>
  <done>The unit tests cover zero-mismatch pass, a missing record, a changed source URL, a changed version, a stale extra record, a Part B pass at threshold, and a Part B fail one below threshold. The no-URL run exits 2 with no socket opened. Nothing is written to any store.</done>
</task>

<task type="auto">
  <name>Task 4: Close the timed-probe test gap and wire the probe command (criterion 3 build)</name>
  <files>scripts/lightrag-probe.test.ts, package.json</files>
  <action>
`scripts/lightrag-probe.ts` (branch commit dff36981) already has the OD-5 defaults: 20 samples over 60 seconds, a 1000 ms request timeout, and a p95 bound of 500 ms. Its test file exists. Read it and confirm that these paths are covered: exit 0 when every sample is 2xx and p95 is within the bound, exit 1 on a failed sample, exit 1 on p95 over the bound, and exit 2 with no socket when LIGHTRAG_URL is unset. Add any missing case. Do not change the defaults.

Add the package.json script `probe:lightrag`. Do not add a new reach reader. The probe must keep using `lightragFromEnv` and `LIGHTRAG_HEALTH_PATH`.
  </action>
  <verify>
    <automated>bun test scripts/lightrag-probe.test.ts; env -u LIGHTRAG_URL bun scripts/lightrag-probe.ts; test $? -eq 2</automated>
  </verify>
  <done>All four exit paths are tested. The no-URL run exits 2 with no socket. The `probe:lightrag` script exists. No live call was made.</done>
</task>

<task type="auto">
  <name>Task 5: Write the cutover record and correct the docs-plane status (criterion 5, logged switch and reversal limits)</name>
  <files>docs/runbooks/lightrag-cutover.md, docs/docs-plane.md</files>
  <action>
Create `docs/runbooks/lightrag-cutover.md`. It holds the durable cutover record that STATE.md Run 11 only summarises. Record the following, and nothing else. Date 2026-10-28. Release `702ed32e` before and `5cf930a0` after, both as recorded in STATE. `SUBSTRATE_DOCS_BACKEND=lightrag` and `SUBSTRATE_LIGHTRAG_QUERY_MODE=naive`. The backup kinds taken (index pg_dump, substrate.env). The rollback path (app-only; restore the env backup). The statement that RAGFlow reversal is not possible because the service was deleted on 2026-10-25 (D4). The delta-pass procedure, pointing to the C4 checkpoint and to `parity:gate` Part A. Name env keys only. Never write a key value, a host name, a tailnet name, or an internal address.

In `docs/docs-plane.md`, correct any sentence that says the RAGFlow plane is live or that a LightRAG cutover is still pending. Add one pointer to the cutover record. Keep the RAGFlow legacy-fallback statement, since removal has not merged. Do not rewrite the criteria in the ROADMAP.
  </action>
  <verify>
    <automated>git grep -n -i "tailnet\|ts\.net\|Bearer \|sk-" -- docs/runbooks/lightrag-cutover.md; test $? -eq 1; git grep -n "smoke:docs" -- docs | wc -l</automated>
  </verify>
  <done>The cutover record exists. It contains no hostnames, tailnet names, bearer strings or key values. The docs-plane states the cutover date and that reversal to RAGFlow is not available.</done>
</task>

<task type="auto">
  <name>Task 6: Remove the RAGFlow backend choice from config, fabric and flags (criterion 5 removal, part 1, draft only)</name>
  <files>packages/mcp-server/src/config.ts, packages/mcp-server/src/fabric/types.ts, packages/mcp-server/src/fabric/gather.ts, packages/mcp-server/src/fabric/status.ts, packages/mcp-server/src/fabric/compliance.ts, packages/mcp-server/src/flag-registry.ts, .env.example, docs/config-reference.md</files>
  <action>
Only after D1 to D4 are answered and 46-01 to 46-03 have landed. Open a draft PR. Do not merge it.

`DocsBackend` becomes `lightrag` only. `resolveDocsBackend` returns lightrag. A `SUBSTRATE_DOCS_BACKEND` set to `ragflow` is refused with a ConfigError that names the variable, so the old value is not silently ignored. Remove `ragflowFromEnv`, `RagflowConfig`, and the RAGFLOW_* and SUBSTRATE_RAGFLOW_* flags. Remove `ragflow` from FABRIC_RESOURCES and from the breaker and health types, and update the fabric gather, status, compliance and fixtures to match. This is the phase 51 contract change approved under D6(c). Remove RAGFLOW_* from `.env.example`, and keep the LightRAG lines. Regenerate `docs/config-reference.md` with the repo's own command, and do not edit it by hand.

Check whether LightRAG reads `SUBSTRATE_DOCS_VECTOR_WEIGHT` before deciding to keep it. It is documented as a RAGFlow blend weight, so the default is to remove it along with the RAGFlow knobs.
  </action>
  <verify>
    <automated>bunx tsc --noEmit; bun run config:reference -- --check; bun test packages/mcp-server/src/config.test.ts packages/mcp-server/src/fabric</automated>
  </verify>
  <done>No config or flag reads a RAGFlow variable. FABRIC_RESOURCES has no ragflow entry. The config reference check passes. The draft PR is open and marked draft.</done>
</task>

<task type="auto">
  <name>Task 7: Delete the RAGFlow plane and its fakes, and move the smoke to the LightRAG fixture (criterion 5 removal, part 2, draft only)</name>
  <files>packages/mcp-server/src/planes/ragflow.ts, packages/mcp-server/src/planes/ragflow.test.ts, packages/mcp-server/src/ragflow-fake.ts, packages/mcp-server/src/rehearsal-ragflow.ts, packages/mcp-server/src/rehearsal-ragflow-server.ts, packages/mcp-server/src/rehearsal-ragflow.test.ts, packages/mcp-server/src/docs-archive.ts, packages/mcp-server/src/docs-archive.test.ts, packages/mcp-server/src/docs-search.ts, packages/mcp-server/src/docs-ingest.ts, packages/mcp-server/src/docs-datasets.ts, packages/mcp-server/src/docs-freshness.ts, packages/mcp-server/src/docs-golden.ts, packages/mcp-server/src/docs-eval-server.ts, packages/mcp-server/src/service.ts, packages/mcp-server/src/mcp.ts, packages/mcp-server/src/server.ts, packages/cli/src/docs.ts, scripts/docs-smoke.ts</files>
  <action>
Only after 46-04 has landed in the same draft branch. Split into commits, one per concern.

Commit A: delete `planes/ragflow.ts`, `planes/ragflow.test.ts`, `ragflow-fake.ts`, and the `rehearsal-ragflow*` files. Remove every import, then fix each caller so it uses the LightRAG path. The 13 importers are the list from `git grep -l "planes/ragflow"`, and every RAGFlow word in the non-test source files (36) must go or be reworded to LightRAG.

Commit B: under D1(c), delete `docs-archive.ts` and its test. Under D1(a) or (b), keep `verifyArchive` and its test, and drop the RAGFlow writer. Do not keep a dead writer.

Commit C: move `scripts/docs-smoke.ts` off the RAGFlow fixture (`rehearsal up --ragflow-fixture`) to a LightRAG fake built from `planes/__fixtures__/lightrag-v1.5.7-routes.json`. Keep the same assertions.

Do not edit ADRs under `docs/adr/` (they record history). Leave `docs/receipts/**` alone, as the smoke already excludes it. Record in the PR that both are kept on purpose.
  </action>
  <verify>
    <automated>git grep -l -i "ragflow" -- packages scripts | grep -v "docs/receipts"; bunx tsc --noEmit; bun test packages/mcp-server/src/docs-search.test.ts packages/mcp-server/src/docs-ingest.test.ts packages/mcp-server/src/server.test.ts</automated>
  </verify>
  <done>The grep prints no source file that still names RAGFlow, apart from any file the PR lists as kept on purpose. The typecheck passes. The targeted tests pass. The smoke runs against the LightRAG fake. The commits are split by concern and the PR is still a draft.</done>
</task>

<task type="auto">
  <name>Task 8: Sweep the docs and close the removal, then run the repo gates (criterion 5 removal, part 3, draft only)</name>
  <files>docs/docs-search-ingest.md, docs/data-planes.md, docs/grok-bot.md, docs/observability.md, docs/railway-tailscale.md, docs/rehearsal.md, docs/runbooks/index-archive.md, docs/runbooks/docs-proof.md, docs/runbooks/hindsight-cache-proof.md, docs/runbooks/hindsight-upgrade.md, docs/runbooks/railway-migration-inventory.md, docs/runbooks/release-gate.md, docs/runbooks/rollback-compat.md, docs/runbooks/substrate-red.md, docs/redaction.md, docs/docs-plane.md, docs/config-reference.md</files>
  <action>
Only after 46-05 has landed. Rewrite each RAGFlow sentence so it describes LightRAG. Remove the "legacy fallback" language in `docs/docs-plane.md` and the RAGFlow failure reasons in its `docs_search` section, and replace them with the LightRAG reasons from the code. Do not change criteria text in the ROADMAP.

Leave `docs/adr/` and `docs/receipts/` untouched. Note in the PR body that they are historical.

Then run the gates once: typecheck, the repo's config and phase-close locks, and the full test suite. The main agent runs the full suite once after all draft commits land, not each sub-plan.
  </action>
  <verify>
    <automated>git grep -l -i "ragflow" -- docs | grep -v "docs/adr/\|docs/receipts/"; bun run check:phase-close; bun run config:reference -- --check</automated>
  </verify>
  <done>No doc outside ADRs and receipts names RAGFlow as a live or fallback plane. The phase-close and config checks pass. The PR is still a draft, unmerged, and the PR body lists the criterion 5 gate status.</done>
</task>

</tasks>

<live_checkpoints>
Each checkpoint is a live step. The executor never runs it. The operator approves each one for that run, and the approval is recorded in STATE.md before it starts (criterion 6). Each one lists its pass condition.

- C1 Timed probe (criterion 3). The operator runs `bun run probe:lightrag` with LIGHTRAG_URL and LIGHTRAG_API_KEY in the operator shell. It is a read-only GET /health, 20 samples over 60 seconds. Pass: exit 0 (every sample 2xx, p95 at most 500 ms). Record the JSON counts and not the host.
- C2 Archive (criterion 2). Carry out whichever of D1 (a), (b) or (c) was chosen. Under (c) there is nothing to run, and the owner's 2026-10-28 debt acceptance stays. Under (a) or (b), the operator records the artifact and its checksum, and the entry goes into STATE.md before any deletion.
- C3 Parity Part A (criterion 4). The operator runs `bun run parity:gate -- --part A` against production (read-only). Pass: zero mismatches.
- C4 Parity Part B and delta pass (criteria 4 and 5). The operator runs `bun run parity:gate -- --part B`, which makes 10 read-only `/query` calls. Pass: match rate meets the threshold in D3. The delta pass is the same Part A run, repeated after the corpus refresh timer has run, to show the LightRAG records still match the manifest at HEAD.
- C5 RAG-dependent gate (criterion 5 precondition). For each of 25, 40, 42: either the live re-check passes against LightRAG, or D6(a) waiver is recorded in STATE.md with its date. Phase 51's live RAGFlow probes go away with Task 6, and 34 is excluded under D6(b).
- C6 Production env (after the draft merges, only with approval). Back up `substrate.env`, then remove RAGFLOW_URL, RAGFLOW_API_KEY, RAGFLOW_DATASET_ID and SUBSTRATE_RAGFLOW_* from it. Pass: `/healthz` no longer lists a ragflow plane, and the `lightrag` plane is still closed-healthy. Redeploy under the preflight.
- C7 Storage deletion (criterion 5, separately approved). The `elasticsearch`, `mysql`, `storage` and `redis` services may be shared. Check that no consumer remains before any deletion. The `ragflow` Railway service was already deleted on 2026-10-25, so it needs no action. The dead `ragflow-oauth-*` services are a separate decision and are not part of this phase.

Merge gate for the removal draft: C5 recorded, C4 passed or waived under D2 to D3, D1 chosen, D4 recorded, and the operator's explicit approval to merge. Until then the draft stays open.
</live_checkpoints>

<drop_list>
The stale PLAN (`.planning/phases/46-ragflow-hybrid/46-PLAN.md` in the operator's main tree, on the RAGFlow premise) had 16 tasks. Here is what happens to each.

- Stale T1 (SC1 tests): replaced by T1. Partly done on this branch.
- Stale T2 (docs update): done on this branch in commits a68285f6 and 2cc8c89e, not yet on origin/main. The remaining docs work is T5 and T8.
- Stale T3 (archive writer, offline): built on this branch in 4076ccdd. Disposition is D1.
- Stale T4 (live archive and baseline): impossible as written. The RAGFlow API no longer exists. Replaced by C2 under D1.
- Stale T5 (probe, offline): built on this branch in dff36981. Test gaps are in T4.
- Stale T6 (LightRAG deploy and probe, live): deploy done in Run 11. Only the timed probe remains, as C1.
- Stale T7 (parity comparator, offline): replaced by T3. Redefined from the RAGFlow export to the LightRAG records and manifest under D2.
- Stale T8 (freeze sample and migration job dry-run): sample frozen in T2. The migration job is dropped, because the RAGFlow source is empty and the corpus is re-indexed from git by the existing refresh path.
- Stale T9 (Part A dry-run against the archive): replaced by C3, against production.
- Stale T10 (rehearsal LightRAG ingest, Part B): dropped. A second LightRAG deployment is not needed, since Part B runs read-only against production (C4).
- Stale T11 (cutover log and reversal path, offline): the log is T5. The reversal path to RAGFlow cannot be built, and D4 records that.
- Stale T12 (production ingestion of the migration set): dropped with T8. There is no RAGFlow set to ingest.
- Stale T13 (cutover, delta pass, reversal test, live): the cutover is done (Run 11). The delta pass is C4. The reversal test is dropped, since there is no RAGFlow target.
- Stale T14 (RAG-dependent gate): kept as C5, using the table above.
- Stale T15 (removal as a draft PR): kept as T6 to T8. Draft only.
- Stale T16 (storage deletion and RAGFlow service removal, live): the service was deleted on 2026-10-25. Storage deletion is C7.

Anything else in the stale plan that repeats completed work is also dropped. Do not re-run the Run 11 deploy or cutover.
</drop_list>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| operator shell to LightRAG | LIGHTRAG_API_KEY is read by the probe and the parity CLI and never printed. |
| repo docs to public | The cutover record and PR text must not carry hostnames, tailnet names or key values. |
| production env to repo | RAGFLOW_* values exist in substrate.env, and the removal must not copy them into the repo. |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-46-01 | Information disclosure | probe and parity CLI output | high | mitigate | Print counts and the URL only when it is loopback or private. Never print the key. Test that the output has no key. |
| T-46-02 | Information disclosure | docs/runbooks/lightrag-cutover.md | medium | mitigate | Task 5 verify greps for tailnet names, bearer strings and key patterns. |
| T-46-03 | Tampering | removal of the RAGFlow path | high | mitigate | Removal is a draft. Merge waits on the C5 to C7 gate and explicit approval. The config refuses the old backend value rather than ignoring it. |
| T-46-04 | Repudiation | archive and removal decisions | medium | mitigate | Each live step is recorded in STATE.md with the operator's approval and date before it runs. |
| T-46-SC | Tampering | new dependencies | low | accept | This plan adds none. Any new package is a separate decision. |
</threat_model>

<verification>
Run by the main agent once, after all sub-plans land. Sub-plan executors run only their own task verifies.

1. `bunx tsc --noEmit` exits 0.
2. `bun test` for the full suite, once, on the draft branch. Record the pass, skip and fail counts.
3. `bun run check:phase-close` and `bun run config:reference -- --check` pass.
4. `git grep -l -i ragflow -- packages scripts docs .env.example` lists only ADRs, receipts and any files the PR lists as kept on purpose.
5. Probe and parity CLIs exit 2 without LIGHTRAG_URL and open no socket.
6. Checkpoints C1 to C7 are run by the operator only, each with its own approval recorded in STATE.md.
</verification>

<success_criteria>
- Each ROADMAP criterion 1 to 6 is listed above with its status and evidence, and no status is marked met unless the repo shows it.
- Criterion 1: met in repo; the branch's duplicate tests are trimmed (T1).
- Criterion 2: open, with the decision recorded under D1 (no fabricated archive).
- Criterion 3: deploy met live; the timed probe is run once, as C1.
- Criterion 4: the comparator is built offline (T3) and the sample is frozen (T2). The live parts are C3 and C4.
- Criterion 5: the cutover is logged in T5 with its reversal limits. Removal is a draft (T6 to T8) that waits on the C5 to C7 gate.
- Criterion 6: every live step is a C checkpoint with its own approval.
- Operator decisions D1 to D6 are answered before the removal drafts start.
</success_criteria>

<output>
Create `.planning/phases/46-ragflow-hybrid/SUMMARY.md` when the offline sub-plans land, recording the verified commands and their results. Create one `VERIFICATION.md` after the C checkpoints run, with each criterion status updated from live evidence.
</output>
