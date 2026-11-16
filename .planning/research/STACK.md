# Stack Research

**Domain:** Agent substrate on one VPS: Bun/TypeScript MCP server and collectors, Node 24 Lane A host, Python dispatcher and miner, data planes on Railway, Solana devnet anchor (milestone v1.3, areas A–I)
**Researched:** 2026-10-08
**Confidence:** HIGH for what already exists in code and on the host; MEDIUM for external API shapes (docs read, live servers not probed); LOW where marked `[UNVERIFIED]`

## Headline

v1.3 needs almost no new third-party dependencies. The September code already chose a small, mostly dependency-free stack, and most of it is still current:

- **Ledger (E):** solana-cli for signing, raw `fetch` JSON-RPC for read-back, RFC 6962 Merkle on `Bun.CryptoHasher`. No `@solana/*` package.
- **Planes (D):** `fetch` for RAGFlow and Hindsight. For Dragonfly, Bun's built-in `RedisClient` should replace the hand-rolled RESP socket in `21652a2`.
- **Skills (F):** `git` and `gh` invoked with argv arrays, no shell.
- **Desktop (G):** `docker exec` + xdotool/xwd into the webtop container that is already running.
- **Dispatcher and miner:** Python with `httpx` as the only runtime dependency.

The one heavy dependency is **Lane A (H)**: `@rivet-dev/agentos` with rivetkit and native sidecar binaries. It runs under **Node 24, not Bun**.

Port sources (inspect read-only in `/root/src/worktrees/agent-substrate-v13`):
- `acc30a8` (`docs/data-planes-tailscale`, a superset of `substrate/ut-mughkkc0-73909228`) is the primary source for A, B, C, E, F, G and H.
- `21652a2` is the only source for the RAGFlow, Hindsight and Dragonfly clients in D.

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended | Integration point |
|------------|---------|---------|-----------------|-------------------|
| Bun | 1.4.0 (host `bun --version`; root `package.json` `engines.bun >=1.4.0`) | Runtime for `substrate-mcp`, CLI, collectors, projector, ledger | Already in production (`substrate-mcp.service` runs `bun packages/mcp-server/src/index.ts`). Provides `Bun.CryptoHasher`, built-in `RedisClient`, `fetch` and `node:net`/`node:child_process`, so A, B, D, E, F and G need no extra packages | All `packages/*` except `host`, `dispatcher`, `miner` |
| Node.js | 24.18.0 (host `node --version`) | Runtime for `packages/host` (Lane A) | `@rivet-dev/agentos` declares `engines.node >=22.0.0` and pulls in `better-sqlite3@12.x` (native addon) via `@rivet-dev/agentos-core`. `acc30a8:infra/vps/substrate-host.service` runs `ExecStart=/usr/bin/node src/main.ts` (Node 24 type stripping). Bun is not a supported host for this native/actor stack `[UNVERIFIED under Bun; do not try]` | `packages/host`, `infra/vps/substrate-host.service` |
| `@modelcontextprotocol/sdk` | `^1.30.1` pinned on main; 1.32.1 latest (`npm view`) | MCP server for new tools (`docs_search`, `docs_ingest`, `skills_propose`, `desktop_run`, `graph_*` mirror) | Already the server framework (`packages/mcp-server/package.json`). New tools follow the existing `server.registerTool` pattern (`21652a2:packages/mcp-server/src/mcp.ts`). The bump to 1.32.x is optional and must not be done in a port phase | `packages/mcp-server/src/mcp.ts` |
| zod | 4.6.5 (main `^4.6.5`; latest 4.6.5) | Tool input schemas, host API validation | Already used. `@rivet-dev/agentos` depends on `zod ^4.1.11`, so one major across the repo | mcp-server, host |
| solana-cli (Agave) | 4.2.2 installed at `/root/.local/share/solana/install/active_release/bin/solana` | Signs and sends the hourly anchor memo (E) and teachable anchors (F) | The process only passes the keypair **path**. It never opens the key: `acc30a8:packages/ledger/src/solana.ts` builds an argv for `execFile` (no shell) with an absolute CLI path, and `21652a2:planes.ts anchorMemoOnDevnet` does the same through `spawn`. Already installed and pinned by `SOLANA_CLI_DEFAULT` | `packages/ledger/src/solana.ts` |
| Solana JSON-RPC over `fetch` | n/a (Solana RPC methods `getTransaction`, `getSignaturesForAddress`, `getBalance`) | Read-back for `substrate verify` (E) | `acc30a8:packages/ledger/src/rpc.ts` already implements timeouts, bounded retries, a defensive parser and a built-in bs58 decoder. Memo text is accepted only from instructions whose `programId` is one of the memo programs | `packages/ledger/src/rpc.ts`, `packages/cli` `verify` |
| Python | 3.12.3 (`/usr/bin/python3`); 3.13.14 also at `/root/.local/bin/python3.13` | `packages/dispatcher` (C) and `packages/miner` (F, the Hermes bridge) | Both pyprojects (`acc30a8`) declare `requires-python >=3.11`. The units run system `python3 -m substrate_dispatcher` / `substrate_miner` with `PYTHONPATH=…/src` and no venv. `httpx` 0.28.1 and `pytest` 9.1.1 are already importable by system python3 (verified) | `infra/vps/substrate-dispatcher.service`, `substrate-skills-bridge.service` |
| httpx | `>=0.27` declared; 0.28.1 installed (= PyPI latest) | Linear GraphQL and substrate-mcp JSON-RPC from Python | The only runtime dependency in both pyprojects. Tests inject `httpx.BaseTransport` (`acc30a8:packages/dispatcher/src/substrate_dispatcher/linear.py`, `mcp.py`) | dispatcher `linear.py`, `mcp.py`; miner `bridge.py` |
| `@rivet-dev/agentos` | **0.2.22** latest (`npm view`, published 2026-09-29); `acc30a8` pins **0.2.21** | Lane A host (H): one VM per Graph ID, ACP sessions, durable SQLite session records | The real package name (`rivet-agentos` and `@rivetkit/agentos` return 404). Exports `.`, `./node`, `./react`, `./client`. Depends on `rivetkit 2.3.10`, `@rivet-dev/agentos-core 0.2.22`, `@agentclientprotocol/sdk 0.16.1`, and peers `react`/`react-dom` (only for `./react`). The native sidecar arrives as `@rivet-dev/agentos-sidecar-linux-x64-gnu` | `packages/host/src/{main,vm,tasks}.ts` |

### Supporting Libraries

| Library | Version | Purpose | When to Use | Integration point |
|---------|---------|---------|-------------|-------------------|
| Bun built-in `RedisClient` (`import { RedisClient } from "bun"`) | ships with Bun ≥1.2.9; host 1.4.0 | Dragonfly cache: brief 5 min, search/recall 10 min, counters 1 h (`docs/data-planes.md` table) | **Replace** the hand-rolled RESP framing in `21652a2:planes.ts` (`encodeCommand`/`parseReply`/`dragonflyCommand`). That parser only understands the first line of a reply and splits on CRLF inside bulk payloads, so it breaks on cached JSON that contains `\r\n`. The built-in client does auto-pipelining and reconnect, and has `send(cmd,args)` for anything unwrapped. Construct it with `DRAGONFLY_URL` (a `redis://` URL, verified). Never rely on the default `redis` singleton, which reads `REDIS_URL`/`VALKEY_URL` | new `packages/mcp-server/src/cache.ts`. Bun docs call the client "experimental" since 1.2.9 ([bun.sh/blog/bun-v1.2.9](https://bun.sh/blog/bun-v1.2.9)); Dragonfly's RESP3/`HELLO` compatibility with it is `[UNVERIFIED]`, so smoke-test `SET`/`GET`/`EX` before the first phase depends on it |
| `@rivet-dev/agentos-sandbox` | 0.2.22 latest; `acc30a8` pins 0.2.21 | Docker-backed sandbox provider for agentos VMs | Lane A tool execution in `substrate-sandbox:0.1` (image already built locally, 703 MB) | `packages/host/src/sandbox-provider.ts` |
| `sandbox-agent` | `acc30a8` pins 0.4.2; latest 0.5.1 | In-container agent server (`server --token … --port 3000`) baked into `infra/sandbox/Dockerfile` (`ARG SANDBOX_AGENT_VERSION=0.4.2`) | Keep 0.4.2 for the port. A bump changes the image and needs a rebuild behind the 10 GiB disk gate | `infra/sandbox/Dockerfile`, host `package.json` |
| `@agentos-software/claude-code` | 0.2.7 (lockfile and latest agree) | Claude Code agent package for agentos (`dispatch:claude-code` route) | Imported by `acc30a8:packages/host/src` but **missing from `packages/host/package.json` dependencies** (present only as a transitive in `package-lock.json`). Declare it explicitly when porting | `packages/host/src/vm.ts` |
| dockerode | `acc30a8` pins 4.0.12; latest 5.0.1 | Docker API from the Node host (sandbox containers) | Keep 4.0.12 for the port. 5.x is a major bump with no stated need | host |
| `@noble/hashes` | 2.4.0 | — | **Not needed.** `Bun.CryptoHasher("sha256")` in the ledger and `node:crypto` in the host cover every hash | — |
| `@solana/kit` + `@solana-program/memo` (+ `@solana-program/system`) | 8.4.0 / 0.15.0 / 0.15.0 (`npm view` today) | In-process transaction building and signing | **Only if** the anchor must run where solana-cli is absent (e.g. inside a container or Railway). Pattern: `createKeyPairSignerFromBytes` + `getAddMemoInstruction` + `sendAndConfirmTransactionFactory` ([solana.com cookbook: add memo](https://solana.com/developers/cookbook/transactions/add-memo)). Upstream does not state Bun support `[UNVERIFIED on Bun 1.4]`. It also means the process must read the keypair bytes, which the D-06 design (`acc30a8:packages/ledger/src/solana.ts` header) deliberately avoids | not in v1.3 |
| `@a2a-js/sdk` / `a2a-sdk` (PyPI) | 1.3.0 / 1.2.2 | A2A client/server SDKs | **Not needed.** v1.3 publishes static Agent Card JSON; nothing speaks A2A JSON-RPC. Typing the card locally in `packages/mcp-server/src/types.ts` (where `AgentCard` and `TeachableMoment` already live per `21652a2:packages/miner/src/teachable.ts` imports) is enough | — |
| `@vectorize-io/hindsight-client` | 0.10.3 | Hindsight TS client | **Not needed.** One `POST …/memories/recall` and one `POST …/memories` over `fetch` (21652a2 already does recall); a client adds a dependency for two calls | — |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| `bun test` | TS unit tests (root `package.json` `"test": "bun test"`) | Ported test files come with the code: `acc30a8` has `*.test.ts` for ledger (merkle, memo, period, rpc, solana), desktop, skills/propose, host, collectors (herdr-map, muse, grok-map) |
| `pytest` 9.1.1 (system) | Python tests for dispatcher and miner | **The repo has no Python test entry point on main**: no `pyproject.toml`, no `.github/workflows`, and the root `test` script is Bun-only. Add a root script, e.g. `"test:py": "python3 -m pytest packages/dispatcher packages/miner"` (each pyproject sets `testpaths=["tests"]`, `pythonpath=["src"]`, and the dispatcher defines a `live` marker to deselect with `-m "not live"`) |
| uv 0.11.26 | Optional isolated dev runs (`uv run --project packages/dispatcher pytest`) | Do **not** switch the systemd units to uv/venvs in v1.3. The units deliberately use system python3 ("httpx and pytest are already installed; no venv", `acc30a8:infra/vps/substrate-dispatcher.service`) |
| `bunx tsc --noEmit` with TypeScript `^5.7.0` | Type check | TypeScript 7.0.2 is the npm `latest` (the Go-native compiler). Do **not** bump in a port milestone |
| `gh` 2.45.0, `git` | `skills_propose` → branch + PR on `swcstudiospace/agent-skills` | `acc30a8:packages/mcp-server/src/skills/propose.ts` uses `gh pr view`, `gh pr list --head`, `gh pr create --repo swcstudiospace/agent-skills` with argv only, never a force flag |
| herdr 0.9.1 (`/root/.local/bin/herdr`), server protocol 22 | Lane B runtime events (A) | Socket API, see "herdr" below. Pin the collector to protocol 22 and re-verify after any `herdr update` |
| Docker + `substrate-desktop` (`linuxserver/webtop:ubuntu-xfce`, Ubuntu 26.04.1, `127.0.0.1:6081→3000`) | `desktop_run` target (G) | `xdotool` and `xwd` are present in the container (verified with `docker exec … ls /usr/bin`) |

## Area-by-area answers

### E. Solana ledger anchor

**How `21652a2` sends the devnet memo** (`packages/mcp-server/src/planes.ts`, `anchorMemoOnDevnet`):
1. `solana address -k <keypair>` derives the pubkey, so a stale `SOLANA_ANCHOR_PUBKEY` cannot send from the wrong key.
2. `solana transfer <self> 0.000001 --from <keypair> --url <rpc> --with-memo <memo≤500 chars> --allow-unfunded-recipient --commitment confirmed`.
3. The signature is regex-matched (`[1-9A-HJ-NP-Za-km-z]{64,88}`) from stdout+stderr, and the keypair path is scrubbed from errors.
4. The memo is `substrate:<graph_id>:<framing>`, used by `anchorTeachableOnSolanaDevnet` in `packages/miner/src/teachable.ts`.
5. Weakness: `verifyTeachableAnchor` only checks the signature *shape*, not chain state.

**How `acc30a8` does it (port this one):**
- `packages/ledger/src/solana.ts`: a self-transfer of `0` or `0.000000001` SOL. The memo must parse as `substrate:v1:<hour ISO>:<64-hex root>:<count>` (`memo.ts` `MEMO_RE`). The CLI path and keypair path must be absolute, and the RPC URL must be http(s).
- `rpc.ts` reads back with `getTransaction` / `getSignaturesForAddress` / `getBalance`.
- `memo.ts` accepts memo program IDs `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` (SPL Memo v2), `Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo` (v1), and `Memo4c2pN8afCj432Lb7RMVKi9PbQnnW7ewFFaV3oAH`. The code comment says solana-cli 4.2.2 writes the last one `[UNVERIFIED: check one devnet tx before trusting the comment]`.
- **Missing on every branch:** the hourly job entry point that queries Greptime, writes `anchors` and sends; the `substrate-anchor.service`/`.timer` (no anchor unit in `acc30a8:infra/vps/`); and the `substrate verify` wiring over `rpc.ts`. These are new code, not ports.

**Merkle construction:** use `acc30a8:packages/ledger/src/merkle.ts` unchanged.
- It is an RFC 6962 Merkle Tree Hash: `leaf = SHA256(0x00‖leaf)`, `node = SHA256(0x01‖L‖R)`, split at the largest power of two below n, odd leaf promoted (never duplicated). Empty input throws, so an empty hour is never anchored.
- Leaves are the 32-byte `agent_events.hash` values ordered by ingest time within half-open UTC hours (`period.ts`).
- This beats the obvious alternatives. A Bitcoin-style tree duplicates the odd leaf (CVE-2012-2459 class ambiguity). `merkletreejs` 0.6.0 is a dependency that defaults to non-domain-separated hashing. `@openzeppelin/merkle-tree` 1.0.8 is keccak/ABI-encoded and EVM-oriented.

**Client choice:**

| Option | Version | Verdict |
|--------|---------|---------|
| solana-cli (sign) + raw `fetch` JSON-RPC (read) | Agave 4.2.2 | **Use.** Zero npm deps, key never in process memory, already coded and tested in `acc30a8` |
| `@solana/kit` + `@solana-program/memo` | 8.4.0 / 0.15.0 | Fallback only when no CLI is available. Modern, tree-shakable, WebCrypto Ed25519; Bun support unstated upstream |
| `@solana/web3.js` | 1.99.0 | Avoid: the 1.x line is the legacy API that Kit replaces ([solana.com/docs/frontend/web3-compat](https://solana.com/docs/frontend/web3-compat)); heavier, with Node polyfill dependencies |

**Host facts:**
- `SOLANA_RPC_URL` points at devnet (checked by substring, value not printed).
- `SOLANA_ANCHOR_KEYPAIR` resolves to an existing file named `ledger-devnet.json`.
- `21652a2:.env.example` documents `/etc/substrate/anchor-keypair.json` and a second name, `SOLANA_KEYPAIR_PATH`. Reconcile `.env.example` to the one real variable (`SOLANA_ANCHOR_KEYPAIR`) when porting.

### D. Docs plane: RAGFlow, Hindsight, Dragonfly

**Endpoints in this deployment** (classified from `/etc/substrate/substrate.env`, values not printed):
- `RAGFLOW_URL`, `RAGFLOW_MCP_URL` and `HINDSIGHT_URL` are public `https` Railway URLs.
- `RAGFLOW_MCP_URL` ends in `/mcp`.
- `DRAGONFLY_URL` is a `redis://` URL on a non-Railway host.
- `HINDSIGHT_BANK` is set; `HINDSIGHT_BANK_PREFIX` is not.
- `docs/data-planes.md` lines 14–16 and 69 describe tailnet forwarders and `HINDSIGHT_BANK_PREFIX`, so the doc and the live env disagree. Phase planning must pick one and fix the other.

**RAGFlow HTTP API** ([ragflow.io/docs/http_api_reference](https://ragflow.io/docs/http_api_reference)), all with `Authorization: Bearer <RAGFLOW_API_KEY>` and the `{code, data}` envelope (`code: 0` = success):

| Purpose | Call | Notes |
|---------|------|-------|
| Retrieval (`docs_search`) | `POST /api/v1/retrieval` with `{question, dataset_ids[], document_ids?, page, page_size, similarity_threshold=0.2, vector_similarity_weight=0.3, top_k=1024, rerank_id?, keyword=false, highlight=false, metadata_condition?}` | `21652a2` sends no `dataset_ids`. Whether the HTTP endpoint (unlike the MCP tool) accepts that is `[UNVERIFIED]`, so pass the dataset ids from `docs/data-planes.md`'s dataset table. `top_k` is the candidate pool, not the result count (issue #9114); limit with `page_size`. Citations come from each chunk's `document_name`/`document_id`/`dataset_id`. The `docs/data-planes.md` contract ("chunk, heading path, source URL and commit") needs those stored as document metadata at ingest |
| List/create datasets | `GET /api/v1/datasets?page&page_size&name&id`, `POST /api/v1/datasets {name, chunk_method, embedding_model}` | `include_parsing_status=true` adds per-status counts (newer servers) |
| Upload (`docs_ingest`) | `POST /api/v1/datasets/{dataset_id}/documents`, multipart field `file` (repeat per file) | 128 MiB per file. Redact **before** building the `FormData` (Bun `FormData` + `Blob`, no library) |
| Parse after upload | `POST /api/v1/datasets/{dataset_id}/chunks` with `{document_ids:[…]}` | Required before anything is searchable `[UNVERIFIED path: confirm against the deployed version's reference]` |
| Update metadata | `PUT /api/v1/datasets/{dataset_id}/documents/{document_id}` | Attach source URL/commit for citations `[UNVERIFIED field name: meta_fields]` |

**RAGFlow MCP server:** tools `ragflow_retrieval` (args mirror `/api/v1/retrieval`; `dataset_ids` empty = all datasets the key can see; page×page_size ≤ 512), plus `ragflow_list_datasets` and `ragflow_list_chats` on the Go runtime ([ragflow.io/docs/mcp_tools](https://ragflow.io/docs/mcp_tools)).
- Python server: port 9382, `/mcp` streamable HTTP (`/sse` legacy).
- Go runtime: also `/api/v1/mcp` on the API port.
- Known break: RAGFlow **v0.26.1**'s Python MCP server fails every call because its internal `list_datasets(page_size=1000)` exceeds the REST cap (issue #16369).
- Recommendation: `docs_search` calls the **HTTP** `/api/v1/retrieval` directly (one fewer hop, no MCP session handshake, works regardless of MCP-server version). Expose `RAGFLOW_MCP_URL` only through the projector's `substrate.yaml` `ragflow` MCP entry for agents that want it directly.
- The deployed RAGFlow version is `[UNVERIFIED]`. Query it read-only before the docs phase.

**Hindsight REST** ([hindsight.vectorize.io/api-reference](https://hindsight.vectorize.io/api-reference)):

| Endpoint | Body / notes |
|----------|--------------|
| `POST /v1/default/banks/{bank}/memories/recall` (used by `21652a2`) | `21652a2` sends `{query, budget:"low", max_tokens:400}` and reads `results[].text`, with a 4 s timeout and at most 4 results |
| `POST /v1/default/banks/{bank}/memories` (retain) | `{items:[{content, context?, document_id?, timestamp?, tags?}], async?}`. With `async:true` every item needs a unique `document_id` (HTTP 400 otherwise) |
| `PUT /v1/default/banks/{bank}` | Create/configure a bank |
| `POST /v1/default/banks/{bank}/reflect` | Weekly per `docs/data-planes.md` |

Hindsight risk: hindsight-api **0.10.1** has an open hang on recall (vectorize-io/hindsight#4696). Keep the `AbortSignal.timeout` fail-open, and record the deployed version `[UNVERIFIED]`. A local image `ghcr.io/vectorize-io/hindsight-api:0.9.1` (5.91 GB) is on disk but not running; it is a candidate for `docker image rm` to recover space, subject to the operator's decision.

**Dragonfly:** recommend Bun's `RedisClient` (above) over `ioredis` 6.0.0. ioredis is a 6.0 major released 2026-10-06 and adds a dependency that duplicates a runtime built-in. It is only worth it for Cluster/Sentinel, which a single Dragonfly does not need.

### F. Skills plane and A2A Agent Cards

**`skills.propose`:** port `acc30a8:packages/mcp-server/src/skills/{propose,propose-auth,frontmatter}.ts` + `redact.ts` extensions. It uses `git` + `gh` via argv, so no new library. The PR target is `swcstudiospace/agent-skills` (`LIBRARY_REPO` constant).

**Timers:**
- `skills-sync.ts` (`acc30a8:packages/projector/src/{skills,skills-sync}.ts`) runs under Bun.
- The bridge (`acc30a8:packages/miner/src/substrate_miner/bridge.py`, pyproject deps `httpx>=0.27`) runs under system python3.
- Units: `acc30a8:infra/vps/substrate-skills-{sync,bridge}.{service,timer}`.
- Both timers currently fail because the code is absent from main, which production now runs (Main's correction, 2026-10-08). Porting the files is all it takes to turn them green; no stack change.

**Hermes hourly miner:** Hermes' own cron (`substrate.yaml` `hermes: { role: skill-miner, cron: "0 * * * *" }`, build plan §6.3) feeds `~/.hermes/pending/skills`, and the bridge drains that. No new package.

**A2A Agent Card:**
- Current spec: **A2A v1.0** (v1.0.0 released 2026-03-12; v1.0.1 is the latest GitHub release). Protobuf `a2a.proto` is normative ([a2a-protocol.org/latest/specification](https://a2a-protocol.org/latest/specification/)).
- Well-known path: **`/.well-known/agent-card.json`**. Early drafts used `/.well-known/agent.json`.
- Required card fields: `name`, `description`, `version` (the agent's version, not the protocol's), `supportedInterfaces[]` (`{url, protocolBinding: "JSONRPC"|"HTTP+JSON"|"GRPC", protocolVersion}`; this replaced v0.3's `url`/`preferredTransport`/`additionalInterfaces`), `capabilities`, `defaultInputModes`, `defaultOutputModes`, `skills[]`.
- Optional card fields: `provider`, `documentationUrl`, `iconUrl`, `securitySchemes`, `securityRequirements`, `signatures` (JWS over the RFC 8785 canonical form).
- `AgentSkill` fields: required `id`, `name`, `description`, `tags[]`; optional `examples[]`, `inputModes[]`, `outputModes[]`, `securityRequirements`.
- The code today (`21652a2:packages/miner/src/teachable.ts makeAgentCard`) emits `{agent, surface, version:"v0.3-a2a", skills:[{name, framing, tags}], teachables}`. That is **not spec-valid**: it lacks `id`, `description`, `supportedInterfaces`, `capabilities` and the default modes.

Mapping teachable → `skills[]`:

| AgentSkill field | Source in `TeachableMoment` |
|------------------|-----------------------------|
| `id` | `teachable:<graph_id>:<framing>` (stable, unique within the card) |
| `name` | `framing` |
| `description` | `learnings` joined (redacted), falling back to `session_summary` |
| `tags` | `["teachable-moment", surface, "graph:<graph_id>"]` |
| `examples` | `observations` (≤5) |
| (extension) | `edges`, `prev_event_hash` and `solana_anchor` don't fit `AgentSkill`. Carry them under a card-level `x-substrate` extension object or in `skills[].description` text. Spec-compliant extension declaration is via `capabilities.extensions[]` `[UNVERIFIED exact v1.0 extension shape]` |

Serve the card as static JSON from `substrate-mcp` (`GET /.well-known/agent-card.json?surface=<s>` or one path per surface; a REST route beside `/brief` and `/events`). No SDK.

### A. Lane B collectors (herdr, Muse)

**herdr** 0.9.1 (`herdr --version`; `herdr status` shows a running server, `protocol: 22`).
- API: newline-delimited JSON over the Unix socket `~/.config/herdr/herdr.sock` (named sessions at `~/.config/herdr/sessions/<name>/herdr.sock`).
- Request: `{id: <string>, method, params}`. An integer `id` is rejected.
- Push: `{"event": "<kind>", "data": {…}}`, after `events.subscribe` (once per connection; one bad `pane_id` kills the connection, hence one connection per pane). `events.wait` also exists.
- Event kinds in `herdr api schema --json`: `pane.created|closed|exited|focused|moved|updated|scroll_changed|output_matched|agent_detected|agent_status_changed`, `tab.*`, `workspace.*`.
- Query methods: `pane.list|get|read|process_info`, `agent.list|get|read|wait|start|prompt`.
- Constraints are documented in `acc30a8:packages/collectors/src/herdr.ts` header. The collector uses `node:net` only, no package.
- Host runs Bun 1.4.0 at a different path than the unit's `ExecStart=/root/.local/share/reflex/bun/bin/bun`. Re-derive `command -v bun` when installing the units `[UNVERIFIED which path is current]`.

**Muse** Code 1.4.3 (`muse --version`; the build plan saw 1.3.0). `acc30a8:packages/collectors/src/muse.ts` writes `<repo>/.substrate/BRIEF.md` + an `AGENTS.md` pointer block from `POST /brief`, with repos named by `SUBSTRATE_MUSE_REPOS`. No package. The Muse projector is `acc30a8:packages/projector/src/muse.ts`.

### B/C. Claim mirror and dispatcher

- **B:** Linear GraphQL and Notion REST over `fetch` (ports of `packages/mcp-server/src/{linear,notion,mirror,dod-gate}.ts` from the unmerged branches). Do not add `@linear/sdk` or `@notionhq/client`; the September code calls both APIs with plain `fetch`, and the SDKs add surface for 3–4 calls.
- **C:** Python package from `acc30a8:packages/dispatcher`, runtime deps `httpx>=0.27`, dev `pytest>=8.0`, build backend `hatchling` (only needed for `pip install`, which the unit does not do).
- Today it launches only `dispatch:hermes` (`DISPATCHABLE_SURFACES = {"hermes"}` in `dispatch.py`) via `/usr/local/bin/hermes` (`SUBSTRATE_HERMES_BIN`). The binary is at `/root/.local/bin/hermes` on this host, so set `SUBSTRATE_HERMES_BIN` or fix the default `[verify which hermes the unit should run]`.
- `acc30a8` adds `host.py` for the `dispatch:claude-code` → Lane A route (per Main's scope note).

### G. `desktop_run`

| Option | Size | Verdict |
|--------|------|---------|
| Existing `substrate-desktop` webtop + `docker exec … xdotool`/`xwd` (`acc30a8:packages/mcp-server/src/desktop/{actions,driver}.ts`) | 0 new bytes (image `linuxserver/webtop:ubuntu-xfce` 4.71 GB already on disk) | **Use.** Already coded; closed action vocabulary; PNG encoded with `node:zlib`, no image library |
| cua Docker path: PyPI `cua` 0.4.1 / `cua-sandbox` 0.9.0 / `cua-computer` 0.5.19 / `cua-agent` 0.9.0; npm `@trycua/computer` 0.2.1, `@trycua/core` 0.1.6 | Docker Hub `trycua/cua-xfce:latest` **7.89 GB compressed**; `trycua/cua-ubuntu:latest` 1.81 GB compressed (both 2026-10-01); unpacked typically 2–3× `[UNVERIFIED unpacked size]` | **Do not add in v1.3.** `/` has 22 GB free (95% used). cua-xfce alone could take most of that, and the build plan (§11) accepts the webtop as the desktop. `Sandbox.ephemeral(Image.linux())` from the build plan is the `cua-sandbox` API `[UNVERIFIED]` |

### H. Lane A (rivet-agentos)

- **Packages:** `@rivet-dev/agentos` (0.2.22), `@rivet-dev/agentos-sandbox` (0.2.22), `@agentos-software/claude-code` (0.2.7), `sandbox-agent` (0.4.2 in image), `dockerode` (4.0.12), `zod`.
- `packages/host` keeps its **own `package-lock.json`** (npm, Node) separate from the Bun workspace lock. Keep that split: `bun install` at the root must not try to build `better-sqlite3`. Consider removing `packages/host` from the root `workspaces` array, or verify that Bun's install leaves it alone `[UNVERIFIED]`.
- **Runtime needs:**
  - Node ≥22 (24.18 installed).
  - The rivet engine on `127.0.0.1:6420`. Container `gcs-rivet-rivet-engine-1` (`rivetdev/engine:latest`, 1.59 GB) already listens there for another project. `acc30a8`'s unit sets `RIVET_RUN_ENGINE=1`/`RIVET_RUN_ENGINE_HOST=127.0.0.1`, which spawns its own engine. **Port 6420 is taken**, so the host phase must either share that engine or move one of them `[decision needed]`.
  - `RIVETKIT_STORAGE_PATH=/var/lib/substrate/agentos`.
  - Docker for the sandbox.
  - The native sidecar package for linux-x64-gnu.
- **Disk gate:** `acc30a8:infra/sandbox/Dockerfile` requires `df --output=avail -B1 / >= 10737418240` (10 GiB) before an image build. 22 GB is free today. `substrate-sandbox:0.1` (703 MB) is already built, so the port needs no new pull unless the pins change.
- **Name collision:** Docker container `agentos-api` (`agentos:latest`, with `agnohq/pgvector:18`) is **Agno** AgentOS, unrelated (build plan §1 callout).

### I. Phase 0 UAT

No stack additions. The scenarios run against the existing `substrate-mcp` on `127.0.0.1:7410` and the Bun CLI.

## Installation

```bash
# Bun workspace (mcp-server, cli, collectors, projector, ledger): NO new npm packages for A, B, D, E, F, G.
# Dragonfly uses `import { RedisClient } from "bun"`; ledger uses Bun.CryptoHasher + fetch; signing via solana-cli 4.2.2.

# Lane A host only (Node 24, own lockfile, keep acc30a8 pins for the port):
cd packages/host && npm ci     # @rivet-dev/agentos@0.2.21 @rivet-dev/agentos-sandbox@0.2.21 dockerode@4.0.12 sandbox-agent@0.4.2 zod@4.6.5
# then add the missing explicit dep:
npm install --save-exact @agentos-software/claude-code@0.2.7

# Python (dispatcher, miner): nothing to install; system python3 3.12.3 already has httpx 0.28.1 and pytest 9.1.1
python3 -m pytest packages/dispatcher packages/miner -m "not live"
```

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| solana-cli + `fetch` JSON-RPC | `@solana/kit` 8.4.0 + `@solana-program/memo` 0.15.0 | Signing must happen where no CLI exists, or many tx/s (CLI spawn ≈ seconds) |
| RFC 6962 Merkle (`acc30a8:packages/ledger/src/merkle.ts`) | `@openzeppelin/merkle-tree` 1.0.8 | Proofs must verify inside an EVM contract (keccak + ABI encoding) |
| Bun `RedisClient` | `ioredis` 6.0.0 | Dragonfly behind Cluster/Sentinel, or a Bun `RedisClient` incompatibility found in the smoke test |
| `fetch` → RAGFlow `/api/v1/retrieval` | RAGFlow MCP `ragflow_retrieval` at `RAGFLOW_MCP_URL` | An agent outside substrate-mcp wants RAGFlow directly (projector `substrate.yaml` entry) |
| webtop + xdotool/xwd | cua (`cua-sandbox` 0.9.0 + `trycua/cua-ubuntu` 1.81 GB compressed) | After disk is recovered (>40 GB free) and a VLM-driven computer-use agent is actually wanted |
| Static Agent Card JSON | `@a2a-js/sdk` 1.3.0 | Substrate starts serving A2A `message/send` / task RPCs |
| System python3 + `PYTHONPATH` | uv-managed venv per package | A Python dependency beyond httpx appears, or the system Python changes |
| `@rivet-dev/agentos` 0.2.21 (port pin) | 0.2.22 | After the port is green: a one-line bump in its own task, re-running host tests |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `@solana/web3.js` 1.99.x | The 1.x line is the legacy API that Kit replaces; heavier, and the class-based Keypair loads the secret into the process | solana-cli argv signing; Kit only if forced |
| Loading the keypair JSON in TS (any SDK) | Violates D-06 (`acc30a8:packages/ledger/src/solana.ts`: "Only the keypair path is passed; nothing here opens it") and the no-secrets rule | `solana … --from <path>` via `execFile` |
| Hand-rolled RESP (`21652a2` `encodeCommand`/`parseReply`) | Reads only one reply line; breaks on multi-line bulk values and RESP3 types | Bun `RedisClient` |
| `merkletreejs` 0.6.0 | No leaf/node domain separation by default, duplicates odd leaves (second-preimage ambiguity), extra dependency, last release 2025-09 | `acc30a8` RFC 6962 implementation |
| cua images (`trycua/cua-xfce` 7.89 GB compressed) | `/` is 95% full (22 GB free); the build plan already accepts webtop | `substrate-desktop` webtop |
| QEMU/KVM sandboxes | No `/dev/kvm` on the host | Docker paths only |
| `rivet-agentos` / `@rivetkit/agentos` package names | 404 on npm; the build plan's name is a label, not the package | `@rivet-dev/agentos` |
| Running `packages/host` under Bun | Native `better-sqlite3` + rivetkit expect Node; `engines.node >=22` | `/usr/bin/node src/main.ts` (Node 24) |
| `@linear/sdk`, `@notionhq/client` | Adds dependency surface for 3–4 GraphQL/REST calls the September code already makes with `fetch`/httpx | `fetch` (TS), `httpx` (Python) |
| `@vectorize-io/hindsight-client`, `ragflow-sdk` | Two or three endpoints each; `fetch` is already written | `fetch` with `AbortSignal.timeout` fail-open |
| RAGFlow MCP as the `docs_search` backend | Extra hop + session; v0.26.1 Python MCP server is broken on every call (#16369) | HTTP `/api/v1/retrieval` |
| TypeScript 7.x bump, MCP SDK bump, dockerode 5, sandbox-agent 0.5 during ports | Unrelated churn in a port milestone; image rebuild for sandbox-agent | Keep pins; bump in dedicated tasks later |
| ioredis | Duplicates a Bun built-in; 6.0.0 is a two-day-old major | Bun `RedisClient` |
| A2A v0.3 card shape (`url`, `preferredTransport`, top-level `protocolVersion`) or `/.well-known/agent.json` | Superseded by v1.0 (`supportedInterfaces[]`, `/.well-known/agent-card.json`) | v1.0 card |

## Stack Patterns by Variant

**If Dragonfly is unreachable or `DRAGONFLY_URL` is unset:**
- Bypass the cache and serve uncached answers; `/healthz` reports bypass.
- Because `docs/data-planes.md` makes Dragonfly a cache only, never a source of truth.

**If the anchor job runs on the VPS (default):**
- solana-cli 4.2.2 at the absolute path, keypair `SOLANA_ANCHOR_KEYPAIR`, devnet RPC from `SOLANA_RPC_URL`.
- Because no key material enters Bun's memory and no npm dependency is added.

**If the anchor job ever moves off-host (Railway/container):**
- `@solana/kit` 8.4.0 + `@solana-program/memo` 0.15.0, smoke-tested under Bun first.
- Because the CLI isn't there; accept that the process now reads key bytes, and redesign secret handling.

**If `dispatch:<surface>` is `claude-code`/`codex`/`opencode`/`pi`:**
- Route to the Node `packages/host` task API on `127.0.0.1:7411` (`acc30a8` main.ts); otherwise the dispatcher launches the native CLI (Hermes today).
- Because only ACP-native agents run inside rivet agentos (build plan §4.1).

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| `@rivet-dev/agentos@0.2.21/0.2.22` | `rivetkit@2.3.10` (exact, transitive), `zod@^4.1.11`, Node ≥22 | rivetkit `latest` is 2.3.25; do not add rivetkit directly or it will dedupe-conflict with the exact 2.3.10 |
| `@rivet-dev/agentos@0.2.21` | `@rivet-dev/agentos-sandbox@0.2.21` | Bump the agentos family together (`0.2.x` versions move in lockstep) |
| `@rivet-dev/agentos-core` | `better-sqlite3@^12.8.0` (lockfile 12.11.1) | Native build against Node 24; Bun can't load it in-process |
| `@solana/kit@8.4.0` | `@solana-program/memo@0.15.0`, `@solana-program/system@0.15.0` | Only relevant if Kit is adopted |
| herdr collector | herdr 0.9.1, protocol 22 | String `id`s, one subscribe per connection; re-verify after `herdr update` |
| `substrate-sandbox:0.1` | Bun 1.4.0 (checksum pinned), `sandbox-agent@0.4.2`, `node:24-bookworm-slim` | Rebuild only behind the 10 GiB disk gate |
| Python dispatcher/miner | Python ≥3.11 (host 3.12.3), httpx ≥0.27 (0.28.1), pytest ≥8 (9.1.1) | No venv; units set `PYTHONPATH` |
| Merging `acc30a8` package.json files | main's root `package.json` | `acc30a8`/`ut-mughkkc0` root `package.json` and `mcp-server/package.json` **drop** main's workspaces `observability`, `audit`, `evidence`, the `smoke:*` scripts and the `@substrate/*` deps (`git diff ab62c91 substrate/ut-mughkkc0-73909228 -- package.json`). Port files, never whole manifests |

## Sources

- `/root/src/worktrees/agent-substrate-v13` main `ab62c91`+`8fc4d2d`: root and `packages/*/package.json`; `docs/data-planes.md` lines 4–73; no `.github/workflows`.
- `git show 21652a2`: `packages/mcp-server/src/planes.ts`, `mcp.ts`, `packages/miner/src/teachable.ts`, `packages/cli/src/index.ts`, `.env.example`.
- `git show acc30a8`: `packages/ledger/src/{merkle,memo,period,rpc,solana}.ts`; `packages/host/{package.json,package-lock.json,src/main.ts}`; `infra/sandbox/Dockerfile`; `infra/vps/*.service|*.timer`; `packages/mcp-server/src/{desktop/driver.ts,desktop/actions.ts,skills/propose.ts}`; `packages/projector/src/skills-sync.ts`; `packages/{dispatcher,miner}/pyproject.toml`; `packages/miner/src/substrate_miner/bridge.py`; `packages/collectors/src/{herdr,muse}.ts`.
- `git show substrate/ut-mughkkc0-73909228`: dispatcher sources and `infra/vps/substrate-{dispatcher,collector-herdr,collector-muse}.service`.
- Host commands (2026-10-08): `bun --version` 1.4.0, `node --version` 24.18.0, `python3 --version` 3.12.3, `uv --version` 0.11.26, `solana --version` 4.2.2, `herdr --version` 0.9.1, `herdr status`, `herdr api schema --json`, `muse --version` 1.4.3, `gh --version` 2.45.0, `docker ps`/`docker images`/`docker inspect`, `df -h /` (22 GB free), `ss -ltnp` (6420 held by the rivet engine container, 7410 by bun), `/etc/substrate/substrate.env` classified by Python without printing values.
- npm registry (`npm view`, 2026-10-08): @solana/kit 8.4.0, @solana/web3.js 1.99.0, @solana-program/memo 0.15.0, @solana-program/system 0.15.0, @solana/spl-memo 0.3.1, @a2a-js/sdk 1.3.0, ioredis 6.0.0, @rivet-dev/agentos 0.2.22 (+ deps/engines/exports), @rivet-dev/agentos-core 0.2.22, @rivet-dev/agentos-sandbox 0.2.22, @rivet-dev/agentos-sidecar 0.2.22, rivetkit 2.3.25, sandbox-agent 0.5.1, dockerode 5.0.1, @agentos-software/claude-code 0.2.7, @trycua/computer 0.2.1, @trycua/core 0.1.6, @noble/hashes 2.4.0, merkletreejs 0.6.0, @openzeppelin/merkle-tree 1.0.8, @vectorize-io/hindsight-client 0.10.3, @modelcontextprotocol/sdk 1.32.1, zod 4.6.5, typescript 7.0.2; 404 for `rivet-agentos`, `@rivetkit/agentos`.
- PyPI (`pip index versions`): cua 0.4.1, cua-sandbox 0.9.0, cua-computer 0.5.19, cua-agent 0.9.0, httpx 0.28.1, pytest 9.1.1, a2a-sdk 1.2.2.
- Docker Hub tags API: trycua/cua-xfce 7.89 GB, trycua/cua-ubuntu 1.81 GB, trycua/cua-linux 0.19 GB, linuxserver/webtop:ubuntu-xfce 1.28 GB (all compressed).
- [ragflow.io/docs/http_api_reference](https://ragflow.io/docs/http_api_reference): datasets, upload, retrieval (MEDIUM; deployed version unknown).
- [ragflow.io/docs/mcp_tools](https://ragflow.io/docs/mcp_tools), [ragflow.io/docs/dev/launch_mcp_server](https://ragflow.io/docs/dev/launch_mcp_server), [infiniflow/ragflow#16369](https://github.com/infiniflow/ragflow/issues/16369), [#9114](https://github.com/infiniflow/ragflow/issues/9114).
- [hindsight.vectorize.io/api-reference](https://hindsight.vectorize.io/api-reference), [vectorize-io/hindsight#4696](https://github.com/vectorize-io/hindsight/issues/4696).
- [bun.com/docs/runtime/redis](https://bun.com/docs/runtime/redis), [bun.sh/blog/bun-v1.2.9](https://bun.sh/blog/bun-v1.2.9).
- [a2a-protocol.org/latest/specification](https://a2a-protocol.org/latest/specification/), [A2A v1.0 announcement](https://a2a-protocol.org/latest/blog/2026/03/12/a2a-protocol-ships-v10-production-ready-standard-for-agent-to-agent-communication/), [a2aproject/A2A releases](https://github.com/a2aproject/A2A/releases).
- [solana.com cookbook: add memo](https://solana.com/developers/cookbook/transactions/add-memo), [github.com/anza-xyz/kit](https://github.com/anza-xyz/kit), [solana.com/docs/frontend/web3-compat](https://solana.com/docs/frontend/web3-compat).
- RFC 6962 §2.1 (Merkle Tree Hash), as implemented and cited in `acc30a8:packages/ledger/src/merkle.ts`.
- `local://build-plan-v02.md` §1 (Agno collision), §2, §4.1–4.4, §5.0, §5.1, §6.3, §7, §11, §12.

---
*Stack research for: agent-substrate v1.3 build plan completion (areas A–I)*
*Researched: 2026-10-08*
