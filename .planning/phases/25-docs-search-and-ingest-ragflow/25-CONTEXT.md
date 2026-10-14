# Phase 25: Docs search and ingest (RAGFlow) - Context

**Gathered:** 2026-10-09
**Status:** Ready for planning
**Mode:** Smart discuss, auto-accepted under the v1.3 run rules (`.planning/STATE.md`, "v1.3 decisions"). Four recommended answers change a user-visible contract; the plan uses them, and they are listed for the operator under "Open for the operator".

<domain>
## Phase Boundary

One PR on agent-substrate (DOCS-01, DOCS-02, DOCS-03). Agents get cited docs answers from RAGFlow through the substrate only, and nothing secret, unsourced, out-of-root or oversize reaches a dataset.

1. **Greenfield on `main`.** There is no RAGFlow code on `main` or on `acc30a8`. `21652a2`'s `planes.ts` was a stub client (`planesFromEnv`, `RagflowConfig {url, apiKey}`); at most its names are reused. Nothing is ported.
2. **HTTP, never the RAGFlow MCP server.** The RAGFlow MCP server 0.26.1 is broken (#16369). The substrate calls RAGFlow's HTTP API with `RAGFLOW_URL` and `RAGFLOW_API_KEY`:
   - retrieval: `POST /api/v1/retrieval`, always with explicit `dataset_ids`;
   - upload: `POST /api/v1/datasets/{id}/documents` (multipart `file`);
   - parse: `POST /api/v1/datasets/{id}/chunks` with `document_ids`;
   - plus whatever list, update and delete calls the version rule needs (D25-17).
   Every path and field is verified against the RAGFlow source at the deployed version's tag. The deployed version itself is confirmed by one read-only live call in an approved window (see "Live steps").
3. **One RAGFlow seam, three doors per tool.**
   - `docs_search`: MCP tool and `POST /docs/search`.
   - `docs_ingest`: MCP tool, `POST /docs/ingest` and `substrate docs ingest`.
   - `substrate docs refresh` (the DOCS-03 job) is a client of `/docs/ingest`; it never talks to RAGFlow itself.
   All of them end in `Substrate` methods that call an injected `RagflowClient`, so tests and the harness use a fake RAGFlow.
4. **Guards come from earlier phases.**
   - Redaction: Phase 18's `redact.ts` (`redactSkillContent` as the publication-path pass, `redact()` on the way out). Any new rule lives in `redact.ts`; `redact-lock.test.ts` enforces it.
   - Events: Phase 17's `EVENT_SOURCES` rows `docs.search`, `docs.search.failed`, `docs.ingest`, `docs.ingest.refused`.
   - Audit: Phase 17's `policy.ts` entries, `docs_search` fail-open and `docs_ingest` fail-closed.
5. **Registered everywhere a tool must be:** `mcp.ts` `registerTool`; `observe.ts` `KNOWN_TOOLS` and `KNOWN_ROUTES`; `server.ts` `auditedRest` under each tool's own name.

**Proof.**
- Isolated: unit tests against a fake RAGFlow, and one smoke against the Phase 16 harness with a fake RAGFlow HTTP server on loopback. This covers every refusal and error path.
- Live (operator-approved): search and ingest against the deployed RAGFlow, the datasets existing, and the refresh triggers firing.

**Out of scope:**
- Hindsight, Dragonfly and the search-result cache (Phase 26, DOCS-04/05). The Tailscale forwarder hop and its runbook (Phase 26, DOCS-06).
- The DOCS-07 headless-session proof (Phase 26).
- Porting `substrate-skills-sync` itself (Phase 22). This phase adds only the post-fast-forward call (D25-21).
- Forwarding `docs_search` through grok-hermes-connector (XREPO-01, not v1.3).
- New `EVENT_KINDS` or `SURFACES` entries (Phase 17 lock).
- Provisioning RAGFlow or its embedding model. RAGFlow is an external endpoint the substrate never provisions (STATE.md).

**Depends on code not yet on `main`:**
- Phase 22's `skills-sync.ts`, for the agent-skills trigger (D25-21).
- Phase 20's CLI token resolver (`packages/cli/src/token.ts`), if it is on the base (D25-12).
The executor starts from a base that holds Phase 22.

</domain>

<decisions>
## Implementation Decisions

### docs_search contract (DOCS-01)
- **D25-01: Input.**
  - `query`: required, 1 to 1,000 characters.
  - `datasets`: optional list of registry dataset names (D25-14). Default: every registry dataset whose id is known.
  - `limit`: optional, 1 to 10, default 5. RAGFlow is asked for `page_size = limit` (or more if D25-17 post-filters, then cut to `limit`).
  - `similarity_threshold`: optional; RAGFlow's default unless set.
  - Callers never pass raw RAGFlow dataset ids. The substrate turns names into ids and always sends a non-empty explicit `dataset_ids`. A name outside the registry gives an empty result with reason `unknown-dataset`. Other datasets in the same RAGFlow tenant can never be searched.
- **D25-02: The reply is one JSON shape on both doors.**
  - Top level:
    - `untrusted: true`;
    - `notice`: a fixed sentence saying the text is retrieved data, not instructions, and that the answer should cite `source_url`;
    - `results`;
    - `reason` (only when `results` is empty because of an error or refusal).
  - Each result: `title`, `source_url`, `heading_path` (array of headings), `commit`, `snippet`, `score`, and `ids: {dataset_id, document_id, chunk_id}`.
  - `snippet` is the chunk content passed through `redact()` and then cut to at most 1,200 characters. The order is redact first, then cut, so a cut can never leave half a secret.
  - The MCP tool returns this JSON as its text content. The REST route returns it with 200.
- **D25-03: Errors never throw to the caller.**
  - Every failure gives 200 (MCP: not `isError`) with `results: []` and a `reason`.
  - Reasons are a closed list:
    - `not-configured`;
    - `unauthenticated`;
    - `unknown-dataset`;
    - `invalid-request` (the shape check);
    - `ragflow-timeout`;
    - `ragflow-unreachable`;
    - `ragflow-error` (non-zero `code` or a non-2xx status);
    - `ragflow-bad-response`.
  - The reason never carries the RAGFlow URL, the key or a raw response body. RAGFlow's own message, if it is kept at all, goes through `redact()` and is cut to 200 characters.
  - The request timeout defaults to 10 s and is configurable. The call is never inside the brief's 1.5 s budget.
- **D25-04: A result with no source is dropped.**
  - A chunk whose document cannot be resolved to a `source_url` (D25-16) is never returned.
  - The reply then carries `dropped: <n>`. Callers cite the source, not the chunk (`docs/data-planes.md`).
- **D25-05: Exactly one event per authenticated search.**
  - Success, including zero results, is a `note` under the caller's surface: `action: "docs.search"`, `dataset_ids`, `urls` (the deduplicated returned `source_url`s), `count`.
  - Failure is a `warning`: `action: "docs.search"`, `reason`.
  - Both match the Phase 17 rows; a unit test asserts kind and action against `EVENT_SOURCES`.
  - The query text is never in the event; at most `query_sha256` and `query_len` are.
  - The emit is fail-open: a refused or failed emit never changes the reply.
- **D25-06: `docs_search` needs an authenticated surface.**
  - An anonymous caller (an `allowAnonymous` run) gets `results: []`, `reason: "unauthenticated"`, and no RAGFlow call.
  - Why: the requirement needs one attributable event per search, and no event can be attributed without a surface. Production has tokens from Phase 20.
  - The audit mode stays fail-open (Phase 17).

### docs_ingest contract and guards (DOCS-02)
- **D25-07: Who may ingest: only `substrate` and operator tokens.** *(user-visible; see "Open for the operator" 1)*
  - Anonymous: route 401 before the body is read; MCP refusal; CLI exit 1.
  - An authenticated agent surface gets 403 or an MCP refusal ("docs_ingest is limited to the substrate host job and the operator").
  - Why stricter than "any authenticated surface": an ingested page reaches every agent's turn with no review step. `skills_propose` has the owner's merge as its gate; docs have none. The data-planes table already names `substrate docs ingest` as the only writer.
  - The event surface is the token's surface, never one taken from the body.
- **D25-08: Page input.**
  - `dataset` (registry name), `source_url`, `commit` (40-hex), `content` (UTF-8 markdown text), optional `title`, and optional `dry_run`.
  - The source URL must be `https://github.com/<registry repo slug>/blob/<commit>/<path>`. Its commit must equal `commit`. Its path must match the dataset's include globs and none of its exclude globs (D25-14).
  - A missing or empty `source_url` is refused as `no-source`. A different host or slug, or an unmatched path, is `outside-roots`.
  - Paths are normalised before matching. `..`, `.`, empty segments, backslashes and percent-encoded slashes are refused.
- **D25-09: Size caps, all refusals (status `refused`, HTTP 413 for the body cap and 400 otherwise).**
  - Request body: 1 MB, the server-wide `MAX_BODY_BYTES`. This route returns 413, as Phase 21 established for `/skills/propose`.
  - Page content: 256 KiB of UTF-8 after image stripping.
  - Sections per page: 200 (D25-16).
  - Title: 200 characters.
  - Content that is not valid UTF-8 or holds a NUL byte is refused as `not-text`.
- **D25-10: The pipeline order is fixed. Nothing reaches RAGFlow before step 5.**
  1. Authenticate and attribute (D25-07).
  2. Check the shape, the roots and the caps (D25-08, D25-09).
  3. Strip every image (D25-11).
  4. Run `redactSkillContent` over the stripped text.
     - Any high-confidence finding refuses the page as `secret`. The refusal carries `findings: [{line, rule}]`, never a value. This is Phase 18's refuse-on-findings policy for docs.
     - Contextual hits are redacted in place and counted as `redactions`.
     - No doc-example allowance (`pem`/`jwt` are findings).
  5. Hash, split, check idempotency, upload and parse (D25-15 to D25-17).
  - `dry_run` stops after step 4 plus the hash and split. It reports what would happen, writes nothing, emits no event and is still audited as `docs_ingest`.
- **D25-11: Image stripping removes every image, not only remote ones.**
  - What is stripped: markdown inline and reference images, `<img>` tags, `<picture>`/`<source>` elements and `data:` URIs.
  - Each is replaced by `[image: <alt>]`, or by nothing when there is no alt text. The alt text itself goes through the redactor with the rest of the page.
  - The reply and event carry `images_stripped: <n>`.
  - Why all: relative images mean nothing inside RAGFlow, and a remote one is a fetch-or-track risk when a parser or viewer resolves it. Stripping all of them is a superset of the requirement.
  - Links (`[text](url)`) are kept.
- **D25-12: The CLI is an HTTP client.**
  - `substrate docs ingest --dataset <name> --file <path> --source-url <url> --commit <sha> [--title <t>] [--dry-run]` posts to `POST /docs/ingest`.
  - The token comes from Phase 20's resolver if it is on the base, otherwise from the existing `SUBSTRATE_TOKEN` `headers()`.
  - It checks the file against the 256 KiB cap before posting, and never redacts locally (the server is the only redaction point).
  - Output: `key=value` lines (`status`, `dataset_id`, `content_sha256`, `sections`, `redactions`, `images_stripped`, `document_ids`, one `finding=<line> <rule>` per finding).
  - Exit codes: 0 for `uploaded`, `unchanged` and `dry_run`; 1 for a refusal, a 4xx/5xx or an unreachable server. It is not a hook command.
  - Its request timeout is separate from the 1.5 s hook default: about 120 s, overridable.
- **D25-13: Route and MCP status mapping for `docs_ingest`.**
  - 200: `uploaded`, `unchanged` or `dry_run`.
  - 400: a malformed body, or a refusal (`no-source`, `outside-roots`, `not-text`, `secret`, `too-large` other than the body cap, `unknown-dataset`).
  - 401 anonymous; 403 not `substrate` or operator; 413 body over 1 MB.
  - 502 RAGFlow failure: an upload, parse, list, update or delete call failed, timed out or answered badly. The message carries at most 200 characters, redacted.
  - 503 in two cases: `not-configured`, and the fail-closed audit refusing (`auditedRest`).
  - The MCP tool returns the same JSON, with `isError` for every non-200 case.

### Datasets, idempotency, versions and source metadata (DOCS-02, DOCS-03)
- **D25-14: The dataset registry is code, with a harness override.**
  - A typed registry in `packages/mcp-server/src/docs/` holds each dataset's name, GitHub slug, include and exclude globs, trigger, and (once known) RAGFlow dataset id.
  - The `SUBSTRATE_DOCS_DATASETS` environment variable may point at a JSON file that replaces the registry. Only the harness and tests use it.
  - Entries from `docs/data-planes.md`:
    - `agent-substrate`: `swcstudiospace/agent-substrate`; include `README.md`, `docs/**/*.md`, `.planning/PROJECT.md`; exclude `docs/receipts/**`, because receipts are a "Never" for RAGFlow in the data-planes table. Trigger: merge to `main`.
    - `agent-skills`: `swcstudiospace/agent-skills`; include `**/SKILL.md`, `**/references/**`. Trigger: skills-sync fast-forward.
    - `programming-desk`: `swcstudiospace/programming-desk`; include `docs/**`, `skills/**`, `contracts/**`, `ARCHITECTURE.md`, `prompts-assembled/**`. Trigger: merge to `main`.
    - `kanbanos`, `desklanes`, `clippyos`, `auctioning`: slug and roots confirmed by the operator (open question 3). The proposed default is `swcstudiospace/<name>`, `README.md` plus `docs/**`. Trigger: merge to `main`.
  - Only text files are ingested: `.md`, `.mdx`, `.markdown`, `.txt`. Any other file under `references/` is skipped by `refresh` and refused as `not-text` by `docs_ingest` if it is posted.
  - Dataset ids are resolved by name through RAGFlow's dataset list and cached in memory.
  - A missing dataset is created by the first operator or `substrate` ingest into it. It is created with the configured embedding model (`SUBSTRATE_DOCS_EMBEDDING_MODEL`, TEI `bge-small` per 05-02; the exact id is confirmed live) and the chunk method research confirms for markdown.
  - Search never creates a dataset.
- **D25-15: Idempotency by content hash, recorded in RAGFlow itself.**
  - `content_sha256` is the SHA-256 of the final upload text: stripped and redacted, over the normalised path. It does not cover the commit, so an unchanged page at a new commit hashes the same.
  - A page whose hash already exists for that path in the dataset is `unchanged`: no upload and no parse. It is carried into the new version (D25-17).
  - The hash and path are recorded in each RAGFlow document's name and/or `meta_fields`, so idempotency survives loss of the substrate's local state. The local manifest is a cache that can be rebuilt from RAGFlow.
  - Two concurrent identical ingests produce one upload, under a per-dataset in-process lock.
- **D25-16: Heading path and source come from per-section documents.**
  - The substrate splits a page at headings: H1 to H3 by default (Claude's discretion). Each section becomes one RAGFlow document:
    - its text starts with the heading breadcrumb, so retrieval can also match on headings;
    - its metadata (`meta_fields`, if the deployed version supports it, else the document name plus the manifest) records `source_url` (with the heading anchor), `heading_path`, `commit`, `title`, `path`, `content_sha256` and `section_index`.
  - Search maps each returned chunk's `document_id` to that metadata. The local manifest is tried first; a RAGFlow document lookup is the fallback; a chunk that still has no source is dropped (D25-04).
  - `title` is the page's first H1, or its file name.
- **D25-17: A version is one refresh run of a dataset at a commit, and only the current version is searchable.** *(user-visible; see "Open for the operator" 2)*
  - `docs_ingest` uploads pages tagged with `commit`. A final `docs_ingest` call with `finalize: true`, `dataset`, `commit` and the list of paths present at that commit then cuts the version:
    - the documents of that commit's pages become current;
    - pages absent at that commit stop being searchable;
    - the run joins the dataset's version list, which keeps the last five;
    - a document that belongs to none of the last five versions is deleted from RAGFlow.
  - `finalize` is audited as `docs_ingest`, under the same writer rule (D25-07).
  - How "only current is searchable" is enforced is chosen by research against the deployed version, in this order of preference:
    1. RAGFlow's document enable/disable flag;
    2. retrieval's `document_ids` filter;
    3. a post-filter against the manifest.
  - The manifest (versions, path → hash → document ids, metadata) lives in `SUBSTRATE_DOCS_STATE` (default `/var/lib/substrate/docs`). It is written atomically (temp file plus rename) under the dataset lock. A rehearsal never points at the production path (D25-24).
  - A version is cut only after every page uploaded in that run has finished parsing (D25-20). A failed run leaves the previous version current.

### Refresh triggers and docs (DOCS-03)
- **D25-18: "On merge" means a host timer, not a GitHub Action.** *(user-visible; see "Open for the operator" 4)*
  - `docs/data-planes.md` says a GitHub Action posts to `/docs/ingest`. That cannot work: `substrate-mcp` listens on loopback (desk rule), and no Action can reach it.
  - Instead, `substrate-docs-refresh.timer` runs every 10 minutes from the pinned release (`/opt/agent-substrate/current`), with a `.service` in `infra/vps/`.
  - Each run, for every merge-triggered dataset:
    1. `git fetch` the repo's `main` into a bare mirror under `SUBSTRATE_DOCS_STATE/mirrors/<owner>/<repo>.git`;
    2. if `main`'s commit differs from the dataset's current version, run `substrate docs refresh --dataset <name> --commit <sha>`.
  - Merges therefore land in RAGFlow within one tick.
  - The job emits as the `substrate` surface (Phase 17 host-job rule) through `/docs/ingest`. The server records its outcomes as the `docs.ingest` and `docs.ingest.refused` events, with `runtime: "docs-refresh"` in the payload.
  - Wiring:
    - the unit pair is added to `deploy-release.sh`'s unit list;
    - `doctor-units.ts` checks it;
    - `deploy-release.test.ts` asserts it.
  - Enabling the timer on the host is a live step.
- **D25-19: `substrate docs refresh` reads committed objects only.**
  - It lists files with `git ls-tree -r <commit>` and reads them with `git show <commit>:<path>`. It never reads a working tree or touches an index.
    - Merge-triggered datasets read from the bare mirror.
    - `agent-skills` reads from `/root/agent-skills` (configurable), so a dirty file there can never be ingested.
  - For each matching text file it posts one page to `/docs/ingest` with the canonical `https://github.com/<slug>/blob/<commit>/<path>` URL. It then posts `finalize`.
  - It runs pages serially, or with small bounded parallelism (Claude's discretion).
  - Skips are counted: a non-text file, a refused page. A refused page does not abort the run; the version is still cut with that page absent, and the refusal is a `warning` event.
  - It prints `key=value` totals. It exits 0 when the version was cut and 1 otherwise.
  - It never posts its own events; the server records them.
- **D25-20: Parsing is asynchronous; refresh waits.**
  - `docs_ingest` returns after the upload and the parse request (`status: "uploaded"`, `parse: "queued"`).
  - `refresh` polls document run status (bounded, about 10 minutes per run) before `finalize`.
  - A document whose parse fails or times out makes the run fail without cutting the version.
- **D25-21: agent-skills refreshes after each skills-sync fast-forward.**
  - After a fast-forward that moved `HEAD`, Phase 22's `skills-sync.ts` starts `substrate docs refresh --dataset agent-skills --commit <new HEAD>` detached.
    - A failure or timeout of the refresh never fails the sync.
    - It shows up as the refresh's own `warning`.
  - The docs refresh timer also catches up `agent-skills` when `/root/agent-skills` `HEAD` differs from the current version, read-only through `git rev-parse`. A missed hook is therefore repaired within one tick, and the hook path and the timer path are idempotent with each other (D25-15).
  - If Phase 22's `skills-sync.ts` is not on the execution base, the plan stops at this task and reports it, rather than writing the hook into a file that does not exist.
- **D25-22: Docs reconcile what is deployed today against the planned hop.**
  - `docs/data-planes.md`:
    - RAGFlow is reached today at the public Railway HTTPS URL in `RAGFLOW_URL`, with `RAGFLOW_API_KEY`, held only in `/etc/substrate/substrate.env`. The tailnet forwarder is the target, and its hop and runbook are Phase 26 (DOCS-06).
    - The ingest trigger is the host timer and the skills-sync hook, not a GitHub Action.
    - `docs_search` returns title, source URL, heading path, commit, snippet, score and ids.
    - `RAGFLOW_MCP_URL` is not used by the substrate (#16369) and is never given to an agent.
    - Neither the public URL nor any tailnet hostname is written into the repo.
  - `.env.example`:
    - drops `RAGFLOW_DATASET_ID`, replaced by the registry;
    - documents `RAGFLOW_URL`, `RAGFLOW_API_KEY`, `SUBSTRATE_DOCS_STATE`, `SUBSTRATE_DOCS_EMBEDDING_MODEL`, `SUBSTRATE_RAGFLOW_TIMEOUT_MS` and `SUBSTRATE_DOCS_DATASETS`;
    - notes that `RAGFLOW_MCP_URL` is unused.
  - New `docs/docs-plane.md`:
    - the contract of both tools;
    - writer rule, caps, refusal reasons and status codes;
    - registry, versions, refresh, triggers and the harness proof.
  - `docs/mcp-audit.md` marks both rows as landed, and the header comments of `server.ts` and the CLI `index.ts` list the new routes and commands.

### Configuration, registration, events and proof
- **D25-23: Configuration never crashes the server.**
  - `config.ts` gains a `ragflow` block (`url`, `apiKey`, `timeoutMs`) and a `docs` block (`stateDir`, `embeddingModel`, `datasetsFile`), read by `loadConfig`.
  - A RAGFlow URL is accepted only when it is:
    - `https:` anywhere;
    - or `http:` to a loopback address or a single-label host (a MagicDNS short name).
    `http:` to a dotted public host is rejected, because the key would cross the internet in plain text.
  - An invalid or partial configuration makes `configWarnings` report it on the existing `misconfigured —` channel. Every docs call then answers `not-configured`, with search returning empty and ingest returning 503. A throw in `loadConfig` would crash-loop the brief under `Restart=always` (Phase 21 Pitfall 4).
  - The key is redacted from every error and log line. A `ragflow` key shape (`ragflow-…`) is added to `redact.ts` as a high-confidence rule, on both the event path and the skill path (the Phase 18 parity test), so a key pasted into a doc page is refused, not uploaded.
  - The `RagflowClient` sends the key only as `Authorization: Bearer`, and only to the configured origin. It never follows a redirect to another origin.
- **D25-24: The harness gains a fake RAGFlow.**
  - `bun run rehearsal up --ragflow-fixture` starts a loopback fake RAGFlow inside the run directory, for example a Bun server.
    - It implements the endpoints the client uses, against an in-memory or run-dir state.
    - It can be told to time out, return a non-zero `code` or answer malformed JSON.
  - The flag also points `RAGFLOW_URL` at the fake, `SUBSTRATE_DOCS_STATE` at `<runDir>/docs` and `SUBSTRATE_DOCS_DATASETS` at a fixture registry.
  - Unit tests use an in-process fake `RagflowClient` or the same fake server. No test calls a real RAGFlow.
- **D25-25: The smoke, `bun run smoke:docs` (`scripts/docs-smoke.ts`).**
  - It keeps Phase 16's guards: `consumer.env` only, port 7410 refused, loopback only.
  - It asserts each of the following:
    - (a) An ingest through the route, MCP and the CLI answers `uploaded`; a re-ingest answers `unchanged` with no new upload at the fake.
    - (b) Each of these is refused, with nothing reaching the fake: a page without a source URL; one outside the roots (including `docs/receipts/…` and `..`); an oversize page and body; a non-text page; a planted runtime-assembled secret (the finding names line and rule, and the value appears in no response, event, audit or fake-RAGFlow state); an anonymous call; and an agent-surface token.
    - (c) A remote and a local image are stripped from what the fake received.
    - (d) `finalize` cuts a version. After six versions only five remain at the fake, and a search returns only current-version sections.
    - (e) A search returns at most `limit` results, each with every DOCS-01 field and a snippet of at most 1,200 characters, and `untrusted: true`.
    - (f) A fake timeout, an error code and malformed JSON each give `results: []` with the matching reason.
    - (g) `POST /events/query` returns one `docs.search` note listing the URLs, plus the `docs.ingest` rows, and the audit file holds the `docs_search` and `docs_ingest` records.
  - Proof run:
    1. `rehearsal up --name p25 --ragflow-fixture`;
    2. the smoke;
    3. `bun test`;
    4. `bunx tsc --noEmit`;
    5. `bun run check:phase-close`;
    6. `rehearsal down`.
  - This run is isolated. Failures already present at HEAD are recorded, not fixed.
- **D25-26: Registration tests.**
  - Tests assert that `docs_search` and `docs_ingest` are each registered in `mcp.ts`, in `KNOWN_TOOLS`, and as `auditedRest` names for `/docs/search` and `/docs/ingest` (both also in `KNOWN_ROUTES`).
  - They also assert that `auditMode` gives `fail-open` and `fail-closed` respectively, and that each is explicitly listed. Phase 17's scan guard already fails a registration that has no policy entry.
  - MCP annotations:
    - `docs_search`: `readOnlyHint: true`, `openWorldHint: true`;
    - `docs_ingest`: `destructiveHint: false`, `openWorldHint: true`.

### Claude's Discretion
- File split under `packages/mcp-server/src/docs/`, for example `ragflow.ts` (client), `registry.ts`, `ingest.ts` (strip, split, hash), `search.ts` and `manifest.ts`, and whether the route body checks live in `server.ts` or in `docs/`.
- The heading split level (H1 to H3 proposed), the section size handling, and the breadcrumb format.
- The exact `notice` sentence and the cap on RAGFlow error text.
- Whether `refresh` uses bounded parallelism, and its poll interval and limits.
- Whether the typed 413 applies to every route (acceptable as a bug fix if other route tests pass) or only to `/docs/ingest`.
- The fake RAGFlow's implementation and state shape.
- Plan split, for example: (1) client, config, registry and redact rule; (2) ingest pipeline, manifest and versions; (3) search; (4) routes, tools, registrations and events; (5) CLI ingest and refresh, the timer and the skills-sync hook; (6) harness fixture, smoke and docs.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/mcp-server/src/redact.ts`: `redact()` and `redactValue()` (the event path), `redactSkillContent()` (the publication path, with `findings` versus `redactions`), `SKILL_HIGH_CONFIDENCE_RULES`, and the parity and exclusion tables. `redact-lock.test.ts` forbids redaction anywhere else.
- `packages/mcp-server/src/event-sources.ts:193-261`: the four Phase 25 rows and their `sample()` payloads. Payload fields: `dataset_ids`, `urls`, `count` / `reason`; `dataset_id`, `source_url`, `content_sha256`, `status` / `status: "refused"`, `reason`, `rules`.
- `packages/audit/src/policy.ts`: `docs_ingest` in `FAIL_CLOSED_TOOLS` and `docs_search` in `FAIL_OPEN_TOOLS`, already on the base. `policy.test.ts`: `PLANNED_V13` and the scan guard over `registerTool` and `auditedRest` names.
- `packages/mcp-server/src/server.ts`: `auditedRest`, `readBody` (`MAX_BODY_BYTES = 1_000_000`, generic error today), `surfaceForToken`, `isOperator`, `sendJson`, the token gate before routes.
- `packages/mcp-server/src/mcp.ts`: `createMcpServer(substrate, caller)`, `json()`, `text()`, the refusal helper and `registerTool` (19 tools today).
- `packages/mcp-server/src/observe.ts:53,309`: `KNOWN_ROUTES` and `KNOWN_TOOLS`.
- `packages/mcp-server/src/config.ts`: `loadConfig`, `configWarnings`, `tokenEnvName("substrate")`.
- `packages/mcp-server/src/service.ts:464-473`: the constructor's `stores` test seam, where the `RagflowClient` is injected.
- `packages/mcp-server/src/greptime.ts`: a `fetch`-based HTTP client with timeouts, the house style for an external HTTP store.
- `packages/cli/src/index.ts`: `post()`, `headers()`, `args.ts`. `lessons.ts` already imports from mcp-server modules.
- Phase 21 (worktree `agent-substrate-v13-p21`): the same three-door shape, the 401/403/413/502/503 mapping, `configWarnings` instead of a throw, the harness-fixture flag and smoke layout. Follow it wherever this phase does the same thing.
- `21652a2:packages/mcp-server/src/planes.ts`: stub names `RagflowConfig`, `planesFromEnv`. Names only.

### Established Patterns
- Tests sit beside their code as `*.test.ts`, run with Bun. Repo checks are lock tests (`store-lock`, `redact-lock`, `vocabulary-lock`).
- Refusals record rule names, reasons and hashes, never values (`auditMemoryWrite`, Phase 17).
- REST twins are audited under the tool's own name (`/memory` → `memory_write`).
- A side-effect event never fails the action; reads are fail-open with a logged reason (`docs/data-planes.md`, "Fail-open budget").
- Host jobs emit as `substrate` with `payload.runtime` (Phase 17). Production units run from `/opt/agent-substrate/current` and are listed in `deploy-release.sh` and `doctor-units.ts` (PR #23).

### Integration Points
- New:
  - `packages/mcp-server/src/docs/*` and their tests;
  - `scripts/docs-smoke.ts`;
  - `infra/vps/substrate-docs-refresh.{service,timer}`;
  - `docs/docs-plane.md`.
- Edited:
  - mcp-server: `service.ts`, `mcp.ts`, `server.ts`, `observe.ts`, `config.ts` and `redact.ts` (the `ragflow` rule), plus their existing tests;
  - `packages/cli/src/index.ts`;
  - Phase 16's `rehearsal-env.ts` and `scripts/rehearsal.ts`;
  - `infra/vps/deploy-release.sh` and its test, `scripts/doctor-units.ts`;
  - `package.json` (`smoke:docs`), `.env.example`;
  - docs: `data-planes.md`, `mcp-audit.md`, `rehearsal.md`;
  - Phase 22's `skills-sync.ts` (one hook call).

</code_context>

<specifics>
## Specific Ideas

- The reply's untrusted marking follows the shape Greptile's MCP uses (`untrustedContent` plus a notice): a boolean flag and a fixed sentence, so an agent harness can key on it.
- "Through the substrate only": agents never hold `RAGFLOW_API_KEY` or `RAGFLOW_MCP_URL`. The out-of-scope table in REQUIREMENTS.md already rules out raw RAGFlow MCP in agent configs.
- `docs/receipts/` exists in this repo and must never reach RAGFlow. The registry exclude and a smoke assertion pin it.

</specifics>

<deferred>
## Deferred Ideas

- Caching `docs_search` results in Dragonfly for 10 minutes (Phase 26, DOCS-05).
- A `substrate docs search` CLI command. Not required; the operator can call the route.
- Verifying ingested content against GitHub (re-fetching the blob at `commit`) instead of trusting the `substrate`/operator writer.
- Ingesting non-text reference files (PDF, images) through RAGFlow's own parsers.
- A `/healthz` RAGFlow probe. Phase 26 owns the plane health fields.

</deferred>

## Open for the operator

Each one below is a user-visible contract choice that the plan builds on. Not yet answered.

1. **Only the `substrate` host job and the operator may ingest (D25-07).**
   - Agent surfaces get 403.
   - Why: an ingested page reaches every agent with no review step.
   - Alternative: any authenticated surface, as DOCS-02's wording minimally allows.
2. **Version semantics (D25-17).**
   - A version is one refresh run at a commit. The last five are kept, only the current one is searchable, and documents outside the last five are deleted.
   - Alternative: keep five revisions per page and search the newest of each.
3. **Product dataset sources (D25-14).**
   - Confirm the GitHub slugs and doc roots for `kanbanos`, `desklanes`, `clippyos` and `auctioning`.
   - Proposed: `swcstudiospace/<name>` with `README.md` plus `docs/**`.
   - Until they are confirmed, the live DOCS-03 proof covers `agent-substrate`, `agent-skills` and `programming-desk` only.
4. **"On merge" is a 10-minute host timer that fetches each repo's `main` (D25-18), not a GitHub Action.** The loopback-only substrate cannot be reached from Actions.
   - Alternative: an Action that posts through the public desk gateway, which belongs to another repository and is not in v1.3.

## Live steps (each waits for operator approval)

1. Read-only: query RAGFlow's version, its dataset list and its embedding models, to confirm endpoint shapes, existing datasets and the TEI `bge-small` model id.
2. Read-only: confirm the product repo slugs on GitHub, and that the host can fetch each repo.
3. Write: create the missing datasets and run the first `substrate docs refresh` for each dataset, as a RAGFlow write.
4. Write: deploy the release, create `/var/lib/substrate/docs`, and install and enable `substrate-docs-refresh.timer`.
5. Write and read: the live search and ingest proof against the deployed RAGFlow, which writes an event and an audit record. Then confirm a skills-sync fast-forward triggers the agent-skills refresh.
