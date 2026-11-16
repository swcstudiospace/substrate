# Phase 25: Docs search and ingest (RAGFlow (retired)) — Context

**Gathered:** 2026-10-10
**Status:** Ready for planning
**Mode:** Autonomous discuss-equivalent under the v1.3 run rules (`.planning/STATE.md`, "v1.3 decisions"): grey areas auto-accept unless they change a user-visible contract, and each is recorded below as a decision with its source. No operator questions were asked; items needing a live system are marked OPERATOR-GATED in the plans, not resolved here.

<domain>
## Phase Boundary

One PR on agent-substrate (DOCS-01, DOCS-02, DOCS-03). Agents answer docs questions from RAGFlow (retired) with citations, through the substrate only, and no secret or unsourced page is ingested.

1. **The substrate is the only door.** RAGFlow (retired) is reached ONLY through `substrate-mcp` (`packages/mcp-server/src/planes/ragflow (retired).ts`, new). No RAGFlow (retired) MCP server appears in any agent config (store-lock rule D9); the desk gateway keeps its own keys for its own reads, but every agent-facing `docs_search` / `docs_ingest` goes through the substrate's tools and routes.
2. **Port the names, not the stub.** `21652a2:packages/mcp-server/src/planes.ts` contributes exactly four keepers — `planesFromEnv`, URL trailing-slash handling, bearer carriage, `ragflow (retired)Search` — reshaped to the `docs/data-planes.md` contract. Its retrieval-without-`dataset_ids` returning the raw body is the recorded anti-pattern and is NOT ported. The RESP client, `anchorMemoOnDevnet` and `teachable.ts` are not ported either.
3. **Guards come from earlier phases.**
   - Redaction: Phase 18's `redact.ts` (`redact`, `redactValue` with the `COUNTER_KEY` exemption, `redactSkillContent`, `scanSkillFiles`, plus the `ragflow (retired)-*` / `sk-proj-*` rules). Ingest redacts before upload and refuses on findings; search redacts snippets before reply.
   - The event mapping: Phase 17's `EVENT_SOURCES` rows already exist (`docs.search`, `docs.search.failed`, `docs.ingest`, `docs.ingest.refused`); this phase emits against them and adds no kind and no surface.
   - Audit policy: Phase 17's `policy.ts` already lists `docs_search` fail-open and `docs_ingest` fail-closed; this phase registers the tool/route names (`KNOWN_TOOLS`, `KNOWN_ROUTES`) so the decided policy actually covers them.
   - Tokens-dir bearer resolution: Phase 20's `packages/cli/src/token.ts` pattern (D20-04) — `docs_ingest` accepts only authenticated surfaces; VM guests are refused.
4. **Rehearsal-first, then gated live.** Every behavior is proven against the Phase 16 harness plus a recording RAGFlow (retired) fake (recorded-playback fixtures) before any live step. The first live reachability/version probe, dataset discovery/creation, any real ingest, and any real search served to an agent are OPERATOR-GATED steps the executor stops at.

**Out of scope:**
- Hindsight recall/retain and the Dragonfly cache (Phase 26 owns `planes/hindsight.ts`, `planes/dragonfly.ts`, `/healthz` cache stats).
- New redaction rules beyond what Phase 18 owns (this phase only calls `redact.ts`; if a RAGFlow (retired)-shaped secret needs a new rule, the rule lands as a Phase 18-owned hunk with its test, not as a local regex).
- Any new `EVENT_KINDS` or `SURFACES` entry (Phase 17 lock).
- RAGFlow (retired) chat, agents, GraphRAG, RAPTOR, rerank, or a chat model registration (retrieval only, TEI bge-small, per research).
- Production credential values (Phase 20 provisioned names; this phase reads `RAGFLOW (retired)_URL` / `RAGFLOW (retired)_API_KEY` from the server env file only).

**Depends on code already on `main`:**
- Phase 16: `scripts/rehearsal.ts`, `packages/mcp-server/src/rehearsal-env.ts`, harness twin on a scratch port.
- Phase 17: `event-sources.ts` docs rows, `docs/event-vocabulary.md`, `policy.ts` docs entries, `observe.ts` registration points.
- Phase 18: `redact.ts` full engine, `redact-lock.test.ts`, store-lock rules.
- Phase 20: `infra/identity/clients.json`, `packages/cli/src/token.ts` resolver, `docs/runbooks/production-identity.md` agent-query rules.
- Phase 22 (sibling, code-merged at `bd2a8d3` but LIVE cutover deferred): `substrate-skills-sync` fast-forward is the trigger for the `agent-skills` dataset refresh; this phase consumes that trigger and degrades explicitly while the sync unit is not yet live (D25-07).
</domain>

<decisions>
## Implementation Decisions

### Reach and credentials (the substrate-only door)
- **D25-01: RAGFlow (retired) is reached ONLY through the substrate; no RAGFlow (retired) MCP in any agent config.**
  - Source: operator decision 2026-10-08 ("the data planes are reached only through the substrate") + Phase 18 store-lock D9.
  - `packages/mcp-server/src/planes/ragflow (retired).ts` is the single client. A store-lock test fails when any agent config (`.mcp.json`, `.cursor/mcp.json`, Claude user-scope entries this repo tracks) registers a RAGFlow (retired) MCP server, and when any package outside `mcp-server` imports the RAGFlow (retired) client.
  - Grey area (desk gateway's direct reads) auto-accepted: the gateway keeps its own keys for its own paths per `docs/data-planes.md` "Current wiring"; agent-facing search/ingest still goes through the substrate. This phase does not change gateway code.
- **D25-02: Plane credentials live only in `/etc/substrate/substrate.env`; `substrate-mcp` reads `RAGFLOW (retired)_URL` / `RAGFLOW (retired)_API_KEY` starting this phase.**
  - Source: `docs/data-planes.md` "Environment keys" + DOCS-06 (credentials live only in `substrate.env`) + host fact (`RAGFLOW (retired)_URL`, `RAGFLOW (retired)_API_KEY`, `RAGFLOW (retired)_MCP_URL` present in the server env file).
  - `RAGFLOW (retired)_MCP_URL` is present on the host but MUST NOT be read by `substrate-mcp` and MUST NOT appear in any agent config — it names the MCP transport this phase deliberately does not use. A comment at the read site records why it is ignored.
  - This changes the `docs/data-planes.md` "Current wiring" row for RAGFlow (retired) from "not read by `substrate-mcp`" to "read by `substrate-mcp` `planes/ragflow (retired).ts`"; the doc hunk ships in plan 25-03. Grey area (whether to keep the `.env.example` "unused" note) auto-accepted: update the note to name the new reader.

### Retrieval contract (the anti-pattern to avoid)
- **D25-03: Every retrieval carries explicit `dataset_ids` with `page_size <= 10`; the raw-body stub shape is forbidden.**
  - Source: REQUIREMENTS DOCS-01 + research SUMMARY (acc30a8 stub "RAGFlow (retired) retrieval without dataset_ids returning raw body" is the anti-pattern to avoid) + FEATURES D-T1.
  - Request: `POST {RAGFLOW (retired)_URL}/api/v1/retrieval` with `{question, dataset_ids, page, page_size}`; `dataset_ids` resolved from configured names/aliases (never caller-supplied raw ids alone); `page_size` clamped to <= 10 server-side. A test asserts the fake received `dataset_ids` on every call.
  - Grey area (default dataset when the caller names none) auto-accepted: search across all configured datasets the caller may read (`agent-substrate` + `programming-desk` + `agent-skills` once live), never an open-ended tenant default.
- **D25-04: Citation shape is `{title, source_url, heading_path, commit, snippet <= 1200 chars redacted, score, document_id, chunk_id}`, framed untrusted.**
  - Source: REQUIREMENTS DOCS-01 + `docs/data-planes.md` RAGFlow (retired) datasets ("callers cite the source, not the chunk").
  - The reply carries an untrusted-docs notice; one `note` event (`payload.action: "docs.search"`) lists the returned URLs; any error yields `{chunks: [], degraded: true, reason}` — never a throw inside an agent's turn (fail-open, policy.ts). Snippets pass through `redactValue` before reply.
  - Grey area (`commit` when RAGFlow (retired) returns none) auto-accepted: fall back to the dataset version pinned at ingest time and say so in the field, never blank and never invented.

### Ingest gates (refuse, never clean-and-publish)
- **D25-05: `docs_ingest` redacts before upload, strips remote images, is idempotent by content hash, and refuses loudly.**
  - Source: REQUIREMENTS DOCS-02 + research PITFALLS 6 (publication paths) + Phase 18 redactor contract.
  - Refuse (fail-closed, `warning` event `docs.ingest.refused` carrying rule names, reasons and hashes only) on: any redactor finding (refuse, never clean-and-publish); a page with no source URL; a path outside the configured roots; over the size caps; an unauthenticated caller; a VM guest. Idempotency: skip unchanged content hashes, replace changed ones. Remote images (`http(s)` img tags and markdown image syntax) are stripped before upload, and stripping is logged in the event.
  - Grey area (size-cap values) auto-accepted: single page <= 1 MB, single ingest call <= 5 MB total, mirroring the Phase 21 propose 1 MB precedent unless RAGFlow (retired)'s parse endpoint says smaller — resolved or gated in RESEARCH.
  - Grey area (who may ingest) auto-accepted: any authenticated non-guest surface; no operator-only restriction (docs are team-shared, unlike `desktop_run`).

### Dataset strategy (reuse, never duplicate)
- **D25-06: Reuse the existing `programming-desk` and `agent-substrate` datasets in the desk gateway; create nothing that already exists.**
  - Source: `docs/data-planes.md` RAGFlow (retired) datasets + REQUIREMENTS DOCS-03.
  - First live step is discovery (`GET /api/v1/datasets`), matched by name; creation only for names with no match, with the pinned embedding model (TEI bge-small). `agent-substrate` refreshes on merge to `main`; `programming-desk` on merge of that repo; `agent-skills` after each skills-sync fast-forward; one dataset per product repo on that repo's merge. Keep the last five versions per dataset.
  - Grey area (product datasets this phase) auto-accepted: wire the per-product naming + retention convention and prove it against the fake; real product-dataset creation is a gated live step, not rehearsed away.
- **D25-07: The `agent-skills` refresh degrades explicitly while the Phase 22 sync unit is not yet live.**
  - Source: phase-22 code-merged (`bd2a8d3`) but its skills-sync LIVE cutover is a DEFERRED operator gate + `docs/skills-sync-bridge-miners.md` hook point ("after each sync fast-forward, the RAGFlow (retired) `agent-skills` dataset refresh").
  - The refresh trigger is implemented as: on sync fast-forward evidence, attempt refresh; when the sync unit has never produced a fast-forward (unit not live), record a `warning` event (`payload.action: "docs.ingest"`, reason `skills-sync-not-live`) and serve `agent-skills` from its last pinned version — search marks those results with the pin age. No silent staleness: the pin age travels in the reply.
  - Grey area (poll vs hook for the trigger) auto-accepted: hook — the sync tick's existing projection step calls the refresh entry point; no new timer, no new surface.

### Vocabulary and audit (already decided, register only)
- **D25-08: No new event kind: `docs.search` / `docs.ingest` are `note`, their refusals/failures are `warning`.**
  - Source: Phase 17 `docs/event-vocabulary.md` mapping table + `event-sources.ts` (rows already exist).
  - `repo` is unset on all four (they are not work in a repo — vocabulary rule). Payloads carry hashes and lengths only (`content_sha256`, source URL allowlisted as the citation, never secret values).
- **D25-09: No audit-policy change: search is fail-open, ingest is fail-closed; register the names so the policy bites.**
  - Source: `packages/audit/src/policy.ts` (already lists both) + Phase 17 four-registration rule (Pattern 2).
  - This phase adds `docs_search` / `docs_ingest` to `KNOWN_TOOLS`, `/docs/search` + `/docs/ingest` to `KNOWN_ROUTES`, the MCP + REST + CLI registrations, and the `policy.test.ts` pins. A test fails when a planned tool has no entry — that test already exists; this phase keeps it green.

### Proof shape (rehearsal-first, gated live)
- **D25-10: Proof is rehearsal-first; every real RAGFlow (retired) touch is an explicit OPERATOR-GATED step.**
  - Source: v1.3 run rules (live runs wait for operator approval) + ROADMAP Phase 25 proof ("refusal and error-path tests run isolated against a fake; search and ingest against the deployed RAGFlow (retired) need the live system in an operator-approved window").
  - Rehearsal (no approval): recording RAGFlow (retired) fake proves explicit-`dataset_ids`, <=10 results, citation shape, redacted snippets, untrusted framing, URL-listing event, empty+reason on error, all six ingest refusals, image stripping, hash idempotency, dataset resolve-by-name, and the skills-sync-not-live degradation.
  - Gated (executor stops, operator approves): (G1) first live reachability/version probe; (G2) dataset discovery/creation; (G3) any real ingest; (G4) any real search served to an agent. Each gated step names its proof read and rollback in plan 25-03.
</decisions>

<code_context>
## Prior Art Consumed

- `21652a2:packages/mcp-server/src/planes.ts` — `planesFromEnv` (env trim + trailing-slash strip), bearer carriage (`authorization: Bearer`), `ragflow (retired)Search` request/response skeleton (`POST {url}/api/v1/retrieval`, `{question, page, page_size}`, `data.chunks[]` with `content`/`document_name`). Kept as adapted helpers; `dataset_ids` added (the stub's omission is the anti-pattern), raw-body return replaced with the DOCS-01 citation shape.
- `docs/data-planes.md` — dataset table, "callers cite the source, not the chunk", TEI bge-small, "Re-ingest on merge" target, current-wiring RAGFlow (retired) row (changed by D25-02).
- `docs/skills-sync-bridge-miners.md` — the `agent-skills` refresh hook point after each sync fast-forward.
- `docs/runbooks/production-identity.md` — agent-query rules: no command prints a token value; the phase's live probes follow the same rule (status + redacted shape only).
- Phase 18 `redact.ts` contract + Phase 17 vocabulary/policy + Phase 20 token resolver (see domain section).
</code_context>
