# Phase 5: Docs and desktop - Context

**Gathered:** 2026-09-26
**Status:** Ready for planning

<domain>
## Phase Boundary

Third-party docs and GUI tasks reachable from any agent through substrate-mcp: `docs_search` and `docs_ingest` backed by the owner's RAGFlow on Railway, and `desktop_run` driving a dedicated webtop container.

ROADMAP success criteria:
1. `docs.search` proxies the owner's RAGFlow retrieval API (MCP name `docs_search`). This wording is the owner-approved re-scope of "proxies the existing RAGFlow MCP endpoint (`ragflow_retrieval`)" (D-03).
2. `docs.ingest` runs the redactor before ingesting (MCP name `docs_ingest`).
3. `desktop.run` drives cua on the Docker path or the existing `recruitment-desktop` webtop. No QEMU path, because this host has no `/dev/kvm`. Under D-12 and D-13 this means a new `substrate-desktop` container on the Docker path, driven with xdotool and xwd (MCP name `desktop_run`). The literal word "cua" still needs owner wording; see 05-RESEARCH Open Question 2.

Proof: an agent answers a docs question and cites a `docs_search` result; a GUI smoke test runs in `substrate-desktop`; a redaction fixture comes back `[REDACTED]` (D-14).

ROADMAP lists Phase 0 as the only dependency. Execution runs strictly 4 → 5 → 6, so every Phase 5 plan assumes Phase 4 has landed:
- `/root/agent-skills` is a git checkout of `swcstudiospace/agent-skills`, written only by `substrate-skills-sync`.
- `skills_propose` and `POST /skills/propose` exist, with `BodyTooLargeError` (413).
- `docs-scraper` is in `SURFACES` and `skill.propose` is in `EVENT_KINDS`.
- The CLI has `substrate skills propose`.
- `redact.ts` carries the skill-content table next to the unchanged event `RULES`.

Phase 5 must not change the `/events`, `/brief` or `/verify` request and response shapes that Phase 6 relies on, or anything Phase 3's pending 03-10 relies on.

Not in this phase: everything under <deferred>; any install of cua or cua-driver; a local RAGFlow on this VPS (19 GB free against RAGFlow's ≥50 GB); changing any agent's own MCP registration.

</domain>

<decisions>
## Implementation Decisions

### Docs backend and embeddings (criterion 1)
- **D-01:** The docs backend is the owner's RAGFlow on Railway. `docs_search` calls `POST {RAGFLOW_URL}/api/v1/retrieval` over HTTP with `Authorization: Bearer <RAGFLOW_API_KEY>`. It does not use RAGFlow's MCP server (`ragflow_retrieval`), whose self-host mode serves the tenant's datasets to any caller and needs a second public port (05-DISCOVERY E16, E17). — **Reversibility:** reversible (the backend sits behind the `docs_search` contract).
- **D-02:** Config lives in `/etc/substrate/substrate.env`:
  - `RAGFLOW_URL` (public Railway domain, no trailing slash)
  - `RAGFLOW_API_KEY` (`ragflow-…`)
  - optional `RAGFLOW_DATASET_ID`

  The owner adds them with `sudoedit` at a checkpoint:human-action. Verification is presence-only (`sudo grep -c '^NAME='`) plus keyed probes through `systemd-run … -p EnvironmentFile=` that print key=value lines only. — **Reversibility:** reversible (remove the lines).
- **D-03 (owner-approved re-scope of SC1):** SC1 reads "docs.search proxies the owner's RAGFlow retrieval API": the HTTP API, not the `ragflow_retrieval` MCP. The orchestrator updates ROADMAP wording; plans do not edit ROADMAP.md. — **Reversibility:** reversible.
- **D-04:** Embeddings use no API keys and no coding-plan keys. A TEI (text-embeddings-inference) sidecar on Railway serves `BAAI/bge-small-en-v1.5`, on private networking only. It is registered in RAGFlow as the **HuggingFace** provider and set as the tenant's default embedding model. — **Reversibility:** reversible, but the embedding model is fixed per RAGFlow dataset; switching models later means a full re-ingest.
- **D-05:** RAGFlow's chat model stays unset. Nothing Phase 5 sends to RAGFlow may need one:
  - Retrieval never sets `keyword`, `use_kg`, `toc_enhance`, `cross_languages` or an auto/semi-auto `meta_data_filter`.
  - The dataset never enables `auto_keywords`, `auto_questions`, RAPTOR, GraphRAG or auto-metadata.

  An explicit `metadata_condition` is allowed because it needs no model. — **Reversibility:** reversible.
- **D-06:** The TEI and RAGFlow setup is owner work in the Railway and RAGFlow UIs, done at a checkpoint with exact steps. The steps cover the TEI service, the HuggingFace provider, the default embedding model, the API key and the env lines. After the admin account exists, the owner sets `REGISTER_ENABLED=0` on the ragflow service and redeploys. — **Reversibility:** reversible.

### Ingest (criterion 2)
- **D-07:** The corpus is the docs-scraper exports as vendored into the library by Phase 4: "27 exports, 2,321 pages", read from `/root/agent-skills/docs-*`. Research found that this glob matches 24 export dirs plus the `docs-scraper` skill. `parallel-web` is in the library but outside the glob, and 2 small test exports are not in the library at all. The exact dir set is 05-RESEARCH Open Question 1. — **Reversibility:** reversible.
- **D-08:** Each page becomes one RAGFlow document with `meta_fields` `url`, `title`, `source` and `content_hash`. The citation URL comes from the manifest `pages[].url`. If that is missing it falls back to the page's `Source:` line, then to the manifest `root_url`. — **Reversibility:** reversible.
- **D-09:** `redact()` runs on every page before upload. Ingest is idempotent by the hash of the redacted content: an unchanged page is skipped, and a changed page is deleted and uploaded again. — **Reversibility:** reversible.
- **D-10:** Any authenticated surface may call `docs_ingest`. The request body is capped at 1 MB (`MAX_BODY_BYTES`), so `docs_ingest` takes paths under allowlisted roots, not raw content. — **Reversibility:** reversible.
- **D-11:** Add redaction rules for RAGFlow `ragflow-…` keys and MiniMax `sk-cp-…` keys. Do not add a generic 64-hex rule: it would destroy sha256 event and content hashes. — **Reversibility:** reversible.

### Desktop (criterion 3)
- **D-12:** A new dedicated `substrate-desktop` container:
  - Built from the already-local `linuxserver/webtop:ubuntu-xfce` image, with no pull.
  - Bound to `127.0.0.1` only.
  - Has its own volume and `--restart unless-stopped`.

  `recruitment-desktop` is never touched: it belongs to recruitment-swarm and holds the operator's LinkedIn and SEEK sessions. — **Reversibility:** reversible (`docker rm -f substrate-desktop`, then remove its volume).
- **D-13:** `desktop_run` drives the container with `docker exec -e DISPLAY=:1 substrate-desktop …`, using xdotool for input and xwd for screenshots.
  - Contract: `{actions: [click | type | key | screenshot], timeout}` → `{screenshots, log}`.
  - Every action is emitted as an event.
  - There is no free-form shell: callers choose only from the four action types, and substrate-mcp builds every argv itself.

  — **Reversibility:** reversible.

### Proof
- **D-14:** The proof has four parts:
  1. A real MCP `docs_search` call returns a chunk with its source URL, and the agent's answer cites that URL.
  2. A GUI smoke test in `substrate-desktop`: open a terminal, type a string, take an xwd screenshot, check the window title with xdotool.
  3. A redaction fixture containing a fake secret comes back `[REDACTED]` from `docs_search`.
  4. The baseline is re-measured at the current HEAD before the first gate.

  — **Reversibility:** reversible.

### Resolved research open questions (orchestrator, within the owner's 2026-09-26 answers)
- **D-15 (OQ1):** The corpus is every library dir that has a `manifest.json`: 25 dirs, 2,317 pages. That is the literal `docs-*` glob plus `parallel-web`. The 2 test exports that are not in the library stay out. This matches the owner's intent "the 27 docs exports" as far as the library holds them. — **Reversibility:** reversible.
- **D-16 (OQ2, owner-approved re-scope):** ROADMAP SC3 is re-worded to "`desktop.run` drives a dedicated webtop container on the Docker path (docker exec + xdotool/xwd)". The owner chose the plain dedicated container over the cua-driver variant. — **Reversibility:** reversible.
- **D-17 (OQ3):** Strip remote Markdown image embeds before upload, because RAGFlow fetches every linked image during parse (2,407 embeds across 385 pages). The content hash is taken over exactly the bytes uploaded. — **Reversibility:** reversible.
- **D-18 (OQ4):** Publish the web view on `127.0.0.1:6081` with basic auth from `/etc/substrate/substrate-desktop.env` (0600). — **Reversibility:** reversible.
- **D-19 (OQ5, tightened):** Keep anonymous loopback mode for local surfaces. However, `docs_ingest` and `desktop_run` must refuse callers that arrive from rivet VM guests, using the same guard Phase 4 applies to `skills_propose` (04-PLAN-CHECK W4: VM sessions reach 127.0.0.1:7410/mcp unauthenticated). `docs_search` stays open to VM guests. Each case gets a test. — **Reversibility:** reversible.
- **D-20 (OQ6):** Extend D-11's redaction rules to `sk-proj-…` and other hyphenated `sk-…` keys, with tests. The event redactor's existing behaviour for other patterns is unchanged. — **Reversibility:** reversible.

### Standing rules carried forward
- Two-sided test gates against a measured phase baseline (`05-BASELINE.md`, re-measured at HEAD before the first gate): `SUBSTRATE_DISABLED=1 bun test`, normalized `bunx tsc --noEmit`, dispatcher pytest. Bun is at `/root/.local/share/reflex/bun/bin/bun`. A vanished failure fails the gate like a new one.
- Before editing any live file outside this repo, snapshot it under `/var/lib/substrate/phase5-baseline/` and add a `RESTORE.md` route. Read `/var/lib/substrate/phase1-baseline/RESTORE.md` before touching a Phase 1 snapshotted file.
- Never print secrets. Probe `/etc/substrate/substrate.env` only with `sudo grep -c '^NAME='`. Keyed probes run through `sudo systemd-run --quiet --wait --pipe --collect -p EnvironmentFile=/etc/substrate/substrate.env <cmd>` and print key=value lines only.
- Stage by explicit path; never `git add -A`. Commit messages carry `Refs SPE-3576`.
- Collectors and hooks fail open; redact before emitting.

### Claude's Discretion
- Module layout for the RAGFlow client, the ingest planner and executor, and the desktop driver.
- Document naming scheme and batching and concurrency limits.
- Names of the new event kinds, and whether `docs_search` emits a `tool.call` event.
- REST routes and CLI subcommands.
- Screenshot conversion, storage and retention.
- `chunk_token_num`, the result cap and snippet length.
- Container env and port details.

All of these stay within D-01 to D-14.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/mcp-server/src/mcp.ts:43` `createMcpServer(substrate, callerSurface)`: `server.registerTool` with zod `inputSchema` and `annotations` (`readOnlyHint` for `memory_search` :94, `destructiveHint:false` :78). There are 11 tools today and Phase 4 adds `skills_propose`. `ownerSurface()` :30-39. The server is built fresh per request, so no state may live in it.
- `server.ts`:
  - Routes `/healthz`, `/brief`, `/events`, `/verify`, `/issue` and `/mcp` at :58-113.
  - `MAX_BODY_BYTES = 1_000_000` :22.
  - Bearer → surface auth at :47-55; anonymous when no `SUBSTRATE_TOKEN_*` is set.
  - Phase 4 adds `/skills/propose` and `BodyTooLargeError` (413).
- `service.ts:82-92`: the `stores` test seam (`index`, `greptime`, `mirror`, `dodGate`; Phase 4 adds `skills`). `emit()` :130, `health()` :528.
- `config.ts:55-79` `loadConfig`. The optional `greptime` block (:60-67, null when unset) is the pattern for an optional `ragflow` block. `.env.example:15-17` already has empty `RAGFLOW_URL=` and `RAGFLOW_API_KEY=`.
- `redact.ts`: `RULES` :18-50 (event path, unexported), `redact()` :53, `redactValue()` :68.
  - The `sk-(?!ant-)[A-Za-z0-9]{20,}` rule at :45 stops at a hyphen, so it misses `sk-cp-…`.
  - Phase 4 (04-02) adds `redactSkillContent`/`scanSkillFiles` in a separate table and leaves `RULES` byte-identical.
- `types.ts`: `SURFACES` :3-16 and `EVENT_KINDS` :19-38. `event.ts` rejects unknown kinds. `tool.call` already exists.
- Phase 4 `packages/mcp-server/src/skills/propose.ts`: `Runner`/`execFileRunner` (execFile, no shell). Like `host/src/hostfns.ts:93-112`, it is utf8 with a 4 MB `maxBuffer`, which is not safe for binary xwd output.
- `packages/cli/src/index.ts` subcommand switch :176-195 (`brief`, `emit`, `run`, `verify`; Phase 4 adds `skills propose`). `post()` :73-84 has a 1.5 s hook timeout.
- `packages/projector/src/muse.ts:75`: the Muse plugin already points at `http://127.0.0.1:7410`, so new tools reach Muse with no projection change.

### Established Patterns
- An optional remote backend is configured from `substrate.env`. When it is missing that is reported, not fatal.
- Credential-spending code is split into pure request and argv builders plus an injected executor. Unit tests use fakes, never the live service.
- Events are fail-open (`.catch(() => undefined)`), redacted on write and hash-chained.
- A new event kind gets its own name (Phase 4 `skill.propose`). substrate-mcp is restarted after `types.ts` changes.
- Owner checkpoints cover credentialed external setup; the agent verifies presence and status codes only.
- Large inputs go through the CLI in-process rather than the 1 MB REST cap (Phase 4 `skills propose --dir`).

### Integration Points
- **substrate-mcp:**
  - `infra/vps/substrate-mcp.service` runs as root.
  - `ProtectSystem=full` makes `/etc` read-only to the service, and `PrivateTmp=true` gives it a private `/tmp`.
  - It listens on `127.0.0.1:7410`.
  - It is in anonymous mode: `SUBSTRATE_TOKEN_*` count is 0, so "authenticated surface" currently means any local caller.
- **Docker:**
  - Version 29.6.2 with the containerd snapshotter; `/var/run/docker.sock` is `root:docker 660`.
  - Image `linuxserver/webtop:ubuntu-xfce` `c4ceafc1c48e`, 4.71 GB, build `621de5cf-ls1` (2026-09-15).
  - Xvfb runs on `:1` with `-ac -nolisten tcp`, so any in-container user can reach the display.
  - The session runs as `abc` (PUID defaults to 911).
  - The image ships `xdotool`, `xwd`, `xprop`, `xwininfo`, `xfce4-terminal`, `exo-open` and `chromium`. It has no `scrot`, `import` or `ffmpeg`.
  - Ctrl+Alt+T runs `exo-open --launch TerminalEmulator`.
  - `recruitment-desktop` uses `127.0.0.1:6080`. Port 6081 is free.
- **RAGFlow:** no endpoint or credential is visible from this host (RAGFLOW count 0 in `substrate.env`, no Railway CLI). Contracts are pinned to source v0.26.4 and v0.27.2 in 05-RESEARCH Q1.
- **Agents:** `~/.claude.json` registers no substrate MCP server (only greptile, hindsight, linear and notion). A Claude Code proof session needs a session-scoped MCP config.

</code_context>

<specifics>
## Specific Ideas

- Baseline `05-BASELINE.md` was measured at `b866793`: 338 pass / 0 fail / 22 files, tsc exit 0, dispatcher 149 passed. HEAD is now `79c7944` (docs-only commits), and Phase 4 will add code before Phase 5 runs, so re-measure at the post-Phase-4 HEAD.
- `/` is 96% full (19 GB free); 11 GiB RAM is available; there is no `/dev/kvm`. `substrate-desktop` should add about 100 MB (the recruitment container's writable layer is 7.5 MB and its volume 58 MB) plus screenshots.
- Corpus (measured 2026-09-26):
  - 27 exports, 2,321 pages, 42.5 MB. The largest page is 2,751,358 bytes; 52 are over 100 KB and 2 over 1 MB.
  - Every page has a `^Source: https://…` line.
  - docs-agno's manifest has no `pages`.
  - docs-gitbook and docs-greptile manifests lack `content_hash` and `source`.
  - The event `redact()` changes 295 pages.
  - 385 pages carry 2,407 remote Markdown image links.
- The RAGFlow API key format is `"ragflow-" + secrets.token_urlsafe(32)` (43 url-safe characters). The corpus has 0 matches for `ragflow-[A-Za-z0-9_-]{32,}` and 0 for `sk-cp-`.
- RAGFlow's unauthenticated `GET /api/v1/system/config` returns `registerEnabled`, which verifies D-06's `REGISTER_ENABLED=0` from the VPS without the key.

</specifics>

<deferred>
## Deferred Ideas

To a later "Recall" phase:
- Ingesting chat outputs as distilled, redacted summaries into Agentmemory.
- Agentmemory as the episodic layer behind a substrate `context_search` tool.
- Retiring hindsight (broken: `initdb` refuses to run as root, 30 of 30 starts failed) and supermemory (no key).
- RAGFlow chat, agents, Memory, GraphRAG and RAPTOR, all of which need a pay-as-you-go chat model.
- Qdrant and pgvector.
- A product-docs dataset, once the owner names its sources. The ingest code is reused unchanged.

</deferred>
