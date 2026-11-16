# Phase 25: Docs search and ingest (RAGFlow) — Research

**Researched:** 2026-10-10
**Domain:** RAGFlow HTTP retrieval/ingest behind `docs_search` / `docs_ingest` on main's v1.2 surface-token server; dataset reuse plus refresh strategy; citation shape; redactor integration; skills-sync degradation; EVENT_KINDS fit
**Confidence:** HIGH for the repo-documented contract and port points (every source read on `main` and on `21652a2`/`acc30a8` this session); MEDIUM for the RAGFlow HTTP shapes (repo-attested plus the public `https://ragflow.io/docs/http_api_reference` pointer in FEATURES, not re-fetched here — the version-swap test in plan 25-01 is the guard); LOW where marked UNVERIFIED (resolved-or-gated below, never assumed).

<user_constraints>
## User Constraints (from CONTEXT.md)

Locked: D25-01 (substrate-only reach, no RAGFlow MCP in agent configs, store-lock pinned), D25-02 (credentials only in `substrate.env`; `RAGFLOW_MCP_URL` never read; data-planes wiring row updated), D25-03 (explicit `dataset_ids`, `page_size <= 10`, raw-body stub forbidden), D25-04 (citation shape plus untrusted framing plus dataset-pin commit fallback), D25-05 (ingest refuses on findings/no-URL/outside-roots/oversize/anonymous/guest; image strip; hash idempotency; 1 MB page / 5 MB call caps), D25-06 (reuse `programming-desk`/`agent-substrate` datasets; discover-by-name before create; TEI bge-small; last-five versions), D25-07 (agent-skills refresh degrades explicitly while skills-sync not live; hook, not timer), D25-08 (no new kind; the four docs rows already mapped), D25-09 (no policy change; register names in KNOWN_TOOLS/KNOWN_ROUTES), D25-10 (rehearsal-first; G1-G4 gated live steps). Full text in 25-CONTEXT.md.
</user_constraints>

<http_api>
## RAGFlow HTTP API Surface (from the repo's documented knowledge)

All shapes below are attested in-repo (file:line); nothing here goes beyond them. The public reference (`https://ragflow.io/docs/http_api_reference`, cited in FEATURES:482) is the tiebreaker at the G1 live probe, not a rehearsal dependency.

| Operation | Method plus path | Request shape (repo-attested) | Response shape (repo-attested) | Source |
|---|---|---|---|---|
| Retrieval | `POST {RAGFLOW_URL}/api/v1/retrieval` | `{question, page, page_size}` plus **`dataset_ids` (added this phase; the stub's omission is the anti-pattern)** | `{data: {chunks: [{content, document_name}]}}`, non-OK yields an error string | `21652a2:planes.ts` `ragflowSearch`; FEATURES D-T1 (`dataset_ids`, `page_size <= 10`) |
| Dataset discovery | `GET /api/v1/datasets` | bearer auth | list matched by name | D25-06 (CONTEXT decision; endpoint is the conventional RAGFlow shape — confirmed or corrected at G1) |
| Dataset creation | `POST /api/v1/datasets` | `{name, embedding_model}` with TEI bge-small per data-planes | dataset id | `docs/data-planes.md` (Embedding: TEI bge-small); creation only on name-miss (D25-06) |
| Document upload plus parse | dataset document upload, then parse-status poll | redacted body plus `{source_url, commit}` metadata | parse status until done | FEATURES D-T2 (sets metadata, polls parse status) |
| Auth | `authorization: Bearer {RAGFLOW_API_KEY}` | — | — | `21652a2:planes.ts` (both plane calls); `planesFromEnv` trim plus trailing-slash strip kept |

What is deliberately NOT used: the RAGFlow MCP server (`ragflow_retrieval`) — self-host mode serves the tenant's datasets to any caller with no dataset control (research 05 D-01/D-03, FEATURES:240); RAGFlow chat/agents/GraphRAG/RAPTOR/rerank — paid chat model plus non-deterministic (05 D-05, FEATURES:241); `RAGFLOW_MCP_URL` — names the unused transport (D25-02).
</http_api>

<unverified>
## UNVERIFIED Items: Resolve or Gate (never assume)

| ID | Item | Status after this research | Disposition |
|---|---|---|---|
| U-01 | Deployed RAGFlow version | Not observable from the repo (no version pin anywhere on `main` or `acc30a8`) | **GATED (G1):** the first live probe records the deployment version into the phase report; rehearsal covers the two known response shapes (with/without `document_id`, `chunk_id`, `heading_path`) via the version-swap test in plan 25-01 so a version skew cannot break parsing |
| U-02 | Parse endpoint (upload to parse to status path) | Attested only as "upload and parse, polls parse status" (FEATURES D-T2); exact paths not in-repo | **GATED (G1/G3):** resolved at the first live ingest against the deployment plus the public HTTP reference; rehearsal fakes the three-step shape (upload, polling, done/timeout) so retry, timeout and timeout-as-`warning` logic is proven before the paths are confirmed |
| U-03 | `meta_fields` (which metadata keys RAGFlow indexes: source_url, commit, heading_path) | Not in-repo; citation needs them back in retrieval | **RESOLVED as gated-fallback:** ingest always SENDS `{source_url, commit, heading_path}` metadata (D25-04 needs them echoed); retrieval maps whatever comes back, falling back to dataset-pin commit plus ingested URL (never blank, never invented). G3 confirms which keys round-trip and the phase report records it |
| U-04 | Bank model (Hindsight `sub-<surface>` vs single `HINDSIGHT_BANK`) | Settled by `docs/data-planes.md` Hindsight-banks table plus `.env.example` `HINDSIGHT_BANK_PREFIX=sub-` (per-surface banks win; the single-bank shape in `21652a2` contradicts main and is NOT ported) | **RESOLVED:** no RAGFlow impact — recorded here only because the contract names it. RAGFlow datasets are shared (not per-surface), so no bank question arises for docs |

Net: U-01 to U-03 are explicitly gated live steps with rehearsal coverage for every known shape; U-04 is resolved. No plan proceeds on an assumed API shape: the fake implements the repo-attested skeleton, and the version-swap plus parse-timeout tests prove the client survives the unknown.
</unverified>

<datasets>
## Dataset Strategy (D25-06): Reuse, Then Refresh

Existing datasets live in the desk gateway (`programming-desk`, `agent-substrate` per `docs/data-planes.md` RAGFlow datasets plus the contract's "desk gateway" row). This phase MUST NOT create duplicates:

1. **Discover first:** `GET /api/v1/datasets`, match by name (`programming-desk`, `agent-substrate`, `agent-skills`, `<product>`). Create ONLY on name-miss, with TEI bge-small pinned.
2. **Refresh triggers (no new timers):** `agent-substrate` on merge to `main`; `programming-desk` on merge of that repo; `agent-skills` from the skills-sync fast-forward hook (D25-07); one `<product>` dataset per product repo (`kanbanos`, `desklanes`, `clippyos`, `auctioning`) on that repo's merge. The merge-trigger wiring itself (CI workflow calling `POST /docs/ingest`) ships as config plus docs in plan 25-03; running it live is G3.
3. **Retention:** keep the last five versions per dataset (DOCS-03); the version record is `{dataset, version, commit, content_sha256, ingested_at}` so search can pin `commit` per the D25-04 fallback.
4. **Product datasets:** naming plus retention convention wired and proven against the fake; real creation is gated (G2), not rehearsed away.
</datasets>

<citation>
## Citation Shape (D25-04)

Per result: `{title, source_url, heading_path, commit, snippet, score, document_id, chunk_id}` where `snippet` is redacted via `redactValue` and capped at 1,200 chars, `commit` falls back to the dataset-pin form, and callers cite `source_url`, never the chunk (`docs/data-planes.md`:50). The tool reply (MCP plus `POST /docs/search`) carries an untrusted-docs notice; one `note` event with `payload.action: "docs.search"` lists the returned URLs (readable back from Greptime — the Phase 5 proof shape, FEATURES:266). At most 10 results; any error yields `{chunks: [], degraded: true, reason}` (fail-open).
</citation>

<redactor>
## Redactor Integration (D25-05, Phase 18 contract)

- Search path: snippets through `redactValue` (keeps the `COUNTER_KEY` exemption — `input_tokens`-style counts stay readable).
- Ingest path: full `redact()` plus `redactSkillContent`/`scanSkillFiles` where the page is skill-shaped, PLUS the `ragflow-*` / `sk-proj-*` rules — BEFORE upload, with refusal (never clean-and-publish) on any finding. The `warning` event carries locator-style `{file, line, rule}` plus hashes, never values (Phase 21 refusal precedent).
- Remote-image strip: `http(s)` `img` tags plus remote markdown images removed pre-upload; the strip count travels in the `note` event.
- No local regexes for secrets: if rehearsal surfaces a RAGFlow-shaped secret the engine misses, the rule lands as a Phase 18-owned `redact.ts` hunk with its test (CONTEXT out-of-scope), and ingest gains the refusal case.
</redactor>

<skills_sync>
## Skills-Sync Dependency Degradation (D25-07)

Phase 22 is code-merged (`bd2a8d3`) but its LIVE cutover is a DEFERRED operator gate, so no fast-forward evidence exists yet. The refresh entry point is called from the sync tick's projection step (hook, D25-07); with no fast-forward ever observed it emits one `warning` (`payload.action: "docs.ingest"`, reason `skills-sync-not-live`) and search serves `agent-skills` from the last pinned version with the pin age in the reply. Rehearsal proves both arms: (a) simulated fast-forward triggers refresh against the fake; (b) no fast-forward yields warning plus pinned serve with pin age. The 22-04 simulated merge-to-sync-to-links loop is the pattern to mirror. When the operator flips the sync unit live, no code change is needed — the first real fast-forward drives the first real refresh (recorded in the G3 report).
</skills_sync>

<events>
## EVENT_KINDS Mapping (D25-08): Fits, No New Kind

Already decided in Phase 17 (`docs/event-vocabulary.md` mapping table plus `event-sources.ts`): `docs.search` maps to `note` (caller surface, `payload.action: "docs.search"`, no `repo`), `docs.search.failed` to `warning`, `docs.ingest` to `note` (`payload.action: "docs.ingest"`), `docs.ingest.refused` to `warning`. Payloads follow the vocabulary rules: hashes plus lengths only (`content_sha256`), source URL allowlisted as the citation, refused values never logged. This phase emits against the existing rows; the plan-25-01 test asserts `event-sources.test.ts` still passes unchanged.
</events>

<anti_pattern>
## Anti-Pattern Avoided (contract: acc30a8 stub)

The `acc30a8` RAGFlow stub ("retrieval without dataset_ids returning raw body") is the shape this phase exists to replace: unscoped retrieval over the tenant default plus raw chunk bodies with no citation, no redaction, no event. Every plan carries the negative gate: the recording fake FAILS any retrieval missing `dataset_ids`, and a test asserts `page_size <= 10` on the wire. A reviewer checking one thing checks that.
</anti_pattern>
