# Grok Bot

How the `grok-bot` surface reaches memory, documents, briefs, and events. Grok Bot is a Programming Desk seat. It reaches the desk gateway over HTTPS. The gateway calls Hindsight and RAGFlow directly for memory and documents when those planes are configured, and calls `substrate-mcp` over loopback for the brief, for events, for the governed memory write that runs beside every retain, and as the fallback for memory and document reads. Since Phases 25 and 26 `substrate-mcp` has its own Hindsight and RAGFlow adapters, so the fallback is a real read of the same planes, not an index-only answer.

This note cites [`swcstudiospace/programming-desk`](https://github.com/swcstudiospace/programming-desk) at `61c7900` (`61c79005b4c71504845e7f3a92a4830bd7237c03`) for the gateway, and this repository for what `substrate-mcp` actually implements. It does not add a client, a route, or an environment variable.

## Surface

`grok-bot` is a substrate surface. `SURFACES` in `packages/mcp-server/src/types.ts` lists it beside `cursor` and `grok-build`. `.env.example` names the matching token variable `SUBSTRATE_TOKEN_GROK_BOT`. The value stays in `/etc/substrate/substrate.env` on the VPS. The gateway's substrate client sends `surface: grok-bot` on the brief and on events (`Substrate.brief` and `Substrate.emit` in programming-desk `services/desk-gateway/src/desk_gateway/upstreams.py`).

The desk gateway's existing bearer value is reused as one entry of that list, and grok-hermes-connector holds another: both call over loopback as `grok-bot`, and there is no gateway surface.

## Loopback only

`loadConfig` in `packages/mcp-server/src/config.ts` defaults the listen address to `127.0.0.1` and the port to `7410` (`SUBSTRATE_HOST`, `SUBSTRATE_PORT`). The README states the same bound: substrate-mcp on `127.0.0.1:7410`, MCP at `/mcp`, with `POST /brief`, `POST /events`, `POST /events/query`, `POST /memory`, and `POST /verify`. That address is loopback. A session that is not on the VPS cannot open it.

The gateway process on the VPS can. `Settings` in programming-desk `services/desk-gateway/src/desk_gateway/config.py` defaults `SUBSTRATE_URL` to `http://127.0.0.1:7410` and listens on `127.0.0.1:8791`. The public name in both `config.py` and [`docs/data-planes.md`](data-planes.md) is `desk.swcstudio.space`.

## Access path

[`docs/railway-tailscale.md`](railway-tailscale.md) places Grok Bot computers off the tailnet. They reach the desk gateway over HTTPS. The gateway, on the VPS, is what can reach Hindsight, RAGFlow, and loopback `substrate-mcp`. Grok Bots do not receive the Hindsight or RAGFlow keys. Those keys are gateway settings: `HINDSIGHT_URL`, `HINDSIGHT_API_KEY`, `RAGFLOW_URL`, and `RAGFLOW_API_KEY` in programming-desk `config.py`.

Ming's Q2 decision is this route. Memory and documents run through the gateway calling Hindsight and RAGFlow directly with the gateway's own keys. `substrate-mcp` holds its own copies of the same keys (`HINDSIGHT_URL`, `HINDSIGHT_API_KEY`, `RAGFLOW_URL`, `RAGFLOW_API_KEY` in `/etc/substrate/substrate.env`, read only by `packages/mcp-server/src/planes/hindsight.ts` and `planes/ragflow.ts`) for the paths it serves itself: `memory_recall`, the derived leg of `memory_search`, the retain forward, `docs_search` and `docs_ingest`. Neither process reads the other's env file, and no Grok Bot computer receives either set.

Tool names below are the core roster in programming-desk `contracts/tool-rosters/_core.yaml` at the same commit. The functions are in `services/desk-gateway/src/desk_gateway/tools/core.py`.

### Recall, search, and retain

`desk_memory_recall` (`memory_recall`, lines 109–125) is the primary memory read. `Hindsight` in `upstreams.py` (lines 336–343) is configured only when both `HINDSIGHT_URL` and `HINDSIGHT_API_KEY` are set: the client is given a base URL when the key is present, and `HttpUpstream.configured` is that URL. When it is configured, recall queries the seat's own bank and, unless `include_shared` is false, its shared banks, then returns. When it is not configured, the same tool calls substrate `memory_search`.

`desk_docs_search` (`docs_search`, lines 52–81) is the primary document read. `RAGFlow` in `upstreams.py` (lines 359–366) is configured only when both `RAGFLOW_URL` and `RAGFLOW_API_KEY` are set, on the same rule. When it is configured, retrieval uses the RAGFlow datasets named `programming-desk` and `agent-substrate`, plus the last path segment of `repo` when the caller passes one. When it is not configured, the tool calls substrate `docs_search`.

`desk_memory_retain` (`memory_retain`, lines 84–106) writes to Hindsight when that client is configured, into the seat's own bank, and also calls substrate `memory_write` on every retain. The tool succeeds when either write is accepted. The substrate write uses scope `graph:<graph_id>` when a graph id is present, and `agent:grok-bot` otherwise.

A configured Hindsight or RAGFlow call stays on that plane. The substrate call is the path taken when the corresponding URL and key are unset, and, for retain, the write that runs alongside Hindsight.

### Brief and events

`desk_brief` (`brief`, lines 22–49) posts the brief to substrate over loopback (`POST /brief`). The `recall` field on that reply is `memory_recall`, so it follows the Hindsight path above when Hindsight is configured and substrate `memory_search` when it is not.

`desk_event_emit` (`event_emit`, lines 184–205) posts the event to substrate over loopback (`POST /events` via `Substrate.emit`).

## What substrate-mcp implements

`packages/mcp-server/src/planes/hindsight.ts` (Phase 26) and `planes/ragflow.ts` (Phase 25) are the substrate's own plane clients. `hindsightFromEnv` reads `HINDSIGHT_URL` / `HINDSIGHT_API_KEY` and the routing-only `HINDSIGHT_BANK_PREFIX` / `HINDSIGHT_BANKS`; `ragflowFromEnv` reads `RAGFLOW_URL` / `RAGFLOW_API_KEY` / `RAGFLOW_DATASET_ID`. `store-lock.test.ts` fails the build if any file outside `packages/mcp-server/src` names `HINDSIGHT_`, and the legacy single-bank `HINDSIGHT_BANK` is unread (the server warns at boot when it is set). Every call to either plane goes through the plane's circuit breaker (uplift-2 R2), so an outage answers `degraded` in microseconds rather than a timeout per caller.

`memory_write`, `memory_search`, `memory_recall`, `docs_search` and `docs_ingest` are registered in `packages/mcp-server/src/mcp.ts`, with REST twins at `POST /memory`, `POST /memory/recall`, `POST /docs/search`, `POST /docs/ingest` and `POST /docs/merge-trigger` in `server.ts`. The README and [`docs/memory-governance.md`](memory-governance.md) describe the write gate over the Postgres index: default-deny RBAC, quarantine, an idempotency key, and a conflict strategy. Postgres stays the governed store; Hindsight holds a derived copy.

### The double retain

A `desk_memory_retain` from Grok Bot lands in Hindsight twice, by design, under two different owners:

1. The gateway writes to the seat's own `pd-*` bank with the gateway's key (`upstreams.py`).
2. The gateway's substrate `memory_write` passes the governance gate, is stored in the index, and — once the index read-back confirms it — `memory-retain.ts` forwards the accepted, redacted record into the writer's `sub-grok-bot` bank with the substrate's key, keyed by `document_id` with `update_mode: replace` so a retry stores once.

Recall through the substrate (`memory_recall`, the derived leg of `memory_search`) fans out over `sub-*` banks only — the caller's own first, then `HINDSIGHT_BANKS` — never over `pd-*` names, which `hindsightBanksFromEnv` drops even when listed. The two copies therefore serve two readers: the desk's own recall reads `pd-grok-bot`; every substrate surface reads `sub-grok-bot`. Duplicate hits collapse per bank on `document_id` and across banks only when the text is identical, keeping the best score (uplift-2 R3); a `document_id` names a subject, not a writer, so two surfaces' different facts about one subject stay two hits.

Before uplift-2 R3 the forward was one attempt: a timeout, a 5xx, a 429 or an open breaker emitted one `memory.retain.failed` warning and the `sub-grok-bot` copy never appeared, while the gateway's `pd-*` write and the index write both succeeded. The retain outbox (`retain-outbox.ts`, `SUBSTRATE_RETAIN_OUTBOX_PATH` under the unit's `StateDirectory`) now parks such a failure and replays it with exponential backoff, re-reading the entry from the index by id so a superseded memory is never replayed; the warning is emitted only when the attempts run out. [`docs/memory-governance.md`](memory-governance.md#derived-hits-and-the-retain-outbox) has the lifecycle and the env names.

### The brief's ETag

`POST /brief` answers with `ETag` and `X-Substrate-Brief` headers (uplift-2 R1); a gateway that sends `If-None-Match` on the next brief gets `304` and keeps the copy it has, which is the session-open `memory_brief • etag` the Build Plan's Grok Bot loop (A-4) names. The brief itself still never recalls from Hindsight synchronously; `recall` on that reply is the tool name to call next.

### The brief contract over MCP (uplift-3 N7)

MCP `memory_brief` carries the same facts as the REST headers, so a connector that calls the tool rather than the route is no longer blind to them. The text block is byte-for-byte what the tool has always returned; beside it, `structuredContent` holds:

| Field | Meaning |
| --- | --- |
| `etag` | weak validator of the text, `W/"<32 hex>"` — identical to the `ETag` header `POST /brief` sends for the same request |
| `state` | `complete` \| `degraded` \| `snapshot`, identical to `X-Substrate-Brief`; a degraded or snapshot brief is an answer, never `isError` |
| `surface` | the surface the brief was composed for: the `surface` argument when given, else the bearer's own — the bearer is the identity, and this is how a connector sees which surface its token resolved to |
| `failed_sources` | the sources that failed or missed the budget (`graph`, `recent actions`, `open graphs`, `memory`), empty when complete |
| `snapshot_at` | ISO time the served snapshot was composed; `null` unless `state` is `snapshot` |

The tool also takes `if_none_match`: the `etag` from an earlier reply, in `If-None-Match` grammar (weak or strong, a comma-separated list, or `*`). When it lists the current tag the reply is one short text line (`brief unchanged (etag W/"…")`) and `structuredContent { not_modified: true, etag, state, surface }` — no brief text, so the 20 KB transfer is saved exactly as a `304` saves it. The matcher is the REST route's own (`etagMatches` in `packages/mcp-server/src/service.ts`), so one stored ETag means the same thing at both doors. The brief is still composed to know its tag; the saving is the transfer, not the compose, and `substrate.brief.duration` times every answer as before. Every answer at either door counts once in `substrate.brief.result{surface,state,result=fresh|not_modified}`, and `GET /slo` carries a `surfaces` array with `grok-bot`'s own `brief.p95` row once it has 20 briefs ([`docs/observability.md`](observability.md) § Brief latency per surface).

### Connector smoke (uplift-3 N7, Build Plan A-7 #5)

`bun run smoke:grok` (`scripts/grok-connector-smoke.ts`) proves the contract above over the wire, as the `grok-bot` bearer, against a running `substrate-mcp` (`SUBSTRATE_URL`, default `http://127.0.0.1:7410`). It is opt-in and read-only — two MCP calls, two REST briefs, one health read; no event, no retain, no write — and it never prints the bearer. Four checks, each `ok`, `degraded` or `failed`, one line each with its timing (`--json` for one JSON report):

1. `mcp.brief` — `memory_brief { repo }` with no `surface` argument answers within 1,500 ms with non-empty text, an explicit `state`, and `surface: grok-bot`; another surface fails the check with a hint naming the variables, and a reply without `surface` (an older server) fails it too — the identity is not proven, so it is not a pass.
2. `mcp.brief.not_modified` — `memory_brief { repo, if_none_match: <etag> }` answers `not_modified: true` within 500 ms.
3. `rest.brief.304` — `POST /brief`, then the same with `If-None-Match`, answers `304` with an empty body.
4. `healthz.planes` — every configured plane reachable with a closed breaker; otherwise `degraded`, not `failed`.

Exit `0` only when every check is `ok`; `1` when the worst is `degraded` (the contract held, a plane did not); `2` when a check failed, the service is unreachable, the bearer is refused (the hint names `SUBSTRATE_TOKEN_GROK_BOT`, the tokens dir and `SUBSTRATE_TOKEN`, never a value) or the arguments are wrong. The bearer is resolved for `grok-bot` only, in this order: the first entry of `SUBSTRATE_TOKEN_GROK_BOT`, else the `grok-bot` file in the tokens dir named by `SUBSTRATE_TOKENS_DIR` (or the client default), else `SUBSTRATE_TOKEN`. `SUBSTRATE_SMOKE_REPO` picks the repo the brief is read for (default `swcstudiospace/agent-substrate`).

### Gateway adoption (external dependency: programming-desk)

The server side of the contract is complete; what the bot sees still depends on the sibling gateway checkout, which at `61c7900` POSTs briefs without conditional headers and drops the response headers, so state and ETag are lost at that boundary. The steps are the gateway's, recorded here as the dependency N7 leaves open (Build Plan A-4; the docs cutover is K5'):

1. **Conditional brief with a stored ETag per request context.** `Substrate.brief` in `services/desk-gateway/src/desk_gateway/upstreams.py` keeps the last `ETag` per (seat, repo, branch, graph) and sends it as `If-None-Match` on the next `POST /brief`; a `304` means keep the copy held. The key is the request context, not the seat alone: one seat briefing two repos holds two tags.
2. **Propagate `X-Substrate-Brief`** (and `X-Substrate-Brief-Failed` when present) onto the `desk_brief` reply, so a seat can tell a `degraded` or `snapshot` brief from a `complete` one and say so instead of acting on thin text as if it were whole. Over MCP the same facts are `structuredContent.state` / `failed_sources`.
3. **Docs via substrate `docs_search`** (K5'): route `desk_docs_search` through `substrate-mcp`'s `docs_search` / `POST /docs/search` instead of the gateway's own RAGFlow call, so the fan-out, budget, provenance and `docs.search.p95` verdict of uplift-3 N5 cover the bot's reads too. Until then the gateway's direct RAGFlow path is unmeasured by the substrate.

Until step 1 lands, `substrate.brief.result{surface=grok-bot,result=not_modified}` stays at zero and the smoke is the only conditional caller; its `rest.brief.304` check is what the gateway's change should make true in production traffic.

### Admission budgets (uplift-3 N3)

Every loopback call the gateway makes as `grok-bot` — `POST /brief`, `POST /events`, `POST /memory`, the MCP tools — passes a per-surface budget after the bearer is resolved and before the handler runs (`packages/mcp-server/src/admission.ts`). The bucket is the token's surface, so a body naming another surface spends `grok-bot`'s budget, not that surface's; the gateway's second bearer entry and grok-hermes-connector's share it, because both are `grok-bot`. Three classes have their own buckets: `read` (`/brief`, `/memory/recall`, `/docs/search`, `/events/query`, `memory_search`, …), `write` (`/events`, `/memory`, `/docs/ingest`, `memory_write`, `events_emit`, …) and `coordination` (`graph_claim`, `graph_heartbeat`, `graph_release`, `graph_complete`), so a burst of briefs never delays a heartbeat. An MCP batch costs one token per `tools/call` member.

What the gateway sees when a bucket is empty depends on `SUBSTRATE_BUDGETS`. In the default `shadow` mode: nothing — the call is served and `substrate.admission.decisions{surface=grok-bot,decision=shadow_limited}` counts what `enforce` would have refused. In `enforce`: a `429` with an integer `Retry-After` header (seconds, never 0) and the bounded body `{"error":"budget","class":"read"|"write"|"coordination","retry_after_s":<n>}`; an MCP request answers `429` with one JSON-RPC error per member (`code: -32000`, the same body under `error.data`) and no member runs. A refused call did nothing: no event was stored, no memory written, no audit record taken. The gateway should wait `Retry-After` and retry; a 401 is answered before the budget is consulted, so a refused bearer is never reported as a budget. A cache plane that cannot answer admits the call (`bypass`), so the budget never turns a Dragonfly outage into a gateway outage. The defaults (`SUBSTRATE_BUDGET_READ_RPS=20`, burst 40; write 10/20; coordination 30/60) and the `SUBSTRATE_BUDGET_GROK_BOT_<CLASS>_RPS` / `_BURST` override are in `.env.example`; the `/slo` row is `admission.limited_rate` ([`observability.md`](observability.md)).

## `docs/data-planes.md` records this route

[`docs/data-planes.md`](data-planes.md) keeps the per-plane wiring table. The current row is this route: the desk gateway calls Hindsight and RAGFlow with its own keys for its own tools, and `substrate-mcp` calls them with its own for `memory_recall`, the retain forward, `docs_search` and `docs_ingest`. `writeMemory` and `searchMemory` use the Postgres `IndexStore` (`packages/mcp-server/src/service.ts`, `packages/mcp-server/src/index-store.ts`) as the governed store and append derived Hindsight hits after the index rows. The gateway code at programming-desk `61c7900` is the route above.

Programming Desk seats use HTTPS to the desk gateway, and substrate-mcp stays on loopback. `substrate-mcp` does read `DRAGONFLY_URL` for the read-through cache described in that document.

## Hooks the cloud agent does not load

`packages/projector/src/cursor.ts` writes substrate hook entries into the Cursor CLI file `/root/.cursor/hooks.json` on the host. Those commands pass `--surface cursor`. A cloud agent checkout does not read that host file. There is no `grok-bot` projector under `packages/projector`. Rules for a cloud session are this repository's `AGENTS.md` and `.cursor/rules/desk.mdc`.
