# Grok Bot

How the `grok-bot` surface reaches memory, documents, briefs, and events. Grok Bot is a Programming Desk seat. It reaches the desk gateway over HTTPS. The gateway calls Hindsight and RAGFlow directly for memory and documents when those planes are configured. Substrate is the fallback for those two tools, and the target for the brief and for events.

This note cites [`swcstudiospace/programming-desk`](https://github.com/swcstudiospace/programming-desk) at `61c7900` (`61c79005b4c71504845e7f3a92a4830bd7237c03`) for the gateway, and this repository for what `substrate-mcp` actually implements. It does not add a client, a route, or an environment variable.

## Surface

`grok-bot` is a substrate surface. `SURFACES` in `packages/mcp-server/src/types.ts` lists it beside `cursor` and `grok-build`. `.env.example` names the matching token variable `SUBSTRATE_TOKEN_GROK_BOT`. The value stays in `/etc/substrate/substrate.env` on the VPS. The gateway's substrate client sends `surface: grok-bot` on the brief and on events (`Substrate.brief` and `Substrate.emit` in programming-desk `services/desk-gateway/src/desk_gateway/upstreams.py`).

The desk gateway's existing bearer value is reused as one entry of that list, and grok-hermes-connector holds another: both call over loopback as `grok-bot`, and there is no gateway surface.

## Loopback only

`loadConfig` in `packages/mcp-server/src/config.ts` defaults the listen address to `127.0.0.1` and the port to `7410` (`SUBSTRATE_HOST`, `SUBSTRATE_PORT`). The README states the same bound: substrate-mcp on `127.0.0.1:7410`, MCP at `/mcp`, with `POST /brief`, `POST /events`, `POST /events/query`, `POST /memory`, and `POST /verify`. That address is loopback. A session that is not on the VPS cannot open it.

The gateway process on the VPS can. `Settings` in programming-desk `services/desk-gateway/src/desk_gateway/config.py` defaults `SUBSTRATE_URL` to `http://127.0.0.1:7410` and listens on `127.0.0.1:8791`. The public name in both `config.py` and [`docs/data-planes.md`](data-planes.md) is `desk.swcstudio.space`.

## Access path

[`docs/railway-tailscale.md`](railway-tailscale.md) places Grok Bot computers off the tailnet. They reach the desk gateway over HTTPS. The gateway, on the VPS, is what can reach Hindsight, RAGFlow, and loopback `substrate-mcp`. Grok Bots do not receive the Hindsight or RAGFlow keys. Those keys are gateway settings: `HINDSIGHT_URL`, `HINDSIGHT_API_KEY`, `RAGFLOW_URL`, and `RAGFLOW_API_KEY` in programming-desk `config.py`.

Ming's Q2 decision is this route. Memory and documents run through the gateway calling Hindsight and RAGFlow directly. `substrate-mcp` has no Hindsight adapter; the gateway is the client for that plane. For documents, v1.3 phase 25 added a substrate RAGFlow adapter (`docs_search`, `docs_ingest` in `packages/mcp-server/src/docs/`), which is the fallback the next paragraph describes — the gateway-direct call stays primary when configured.

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

`packages/mcp-server/src/config.ts` reads `RAGFLOW_*` (v1.3 phase 25) but not `HINDSIGHT_*`. No file under `packages/` imports a Hindsight client; the Hindsight adapter is not implemented in substrate-mcp. The RAGFlow adapter lives in `packages/mcp-server/src/docs/` (`ragflow.ts` client, `registry.ts`, `ingest.ts`, `search.ts`, `manifest.ts`, `versions.ts`). `.env.example` lists `HINDSIGHT_URL`, `HINDSIGHT_API_KEY`, `HINDSIGHT_BANK_PREFIX`, `RAGFLOW_URL`, `RAGFLOW_API_KEY` and the docs state vars; `loadConfig` ignores only the `HINDSIGHT_*` ones.

`memory_write` and `memory_search` are registered in `packages/mcp-server/src/mcp.ts`. The README and [`docs/memory-governance.md`](memory-governance.md) describe that gate over the Postgres index: default-deny RBAC, quarantine, an idempotency key, and a conflict strategy. They are the substrate fallback and the second retain write. They are not a Hindsight client.

The gateway's document fallback calls a substrate tool named `docs_search`. Since v1.3 phase 25 this repository registers `docs_search` and `docs_ingest` (MCP tools plus `POST /docs/search` and `POST /docs/ingest` under `packages/`); see [`docs/docs-plane.md`](docs-plane.md) for the contract.

## `docs/data-planes.md` records this route

[`docs/data-planes.md`](data-planes.md) keeps a current-wiring table and a target table. The current row is this route: the desk gateway calls Hindsight and RAGFlow with its own keys, and `substrate-mcp` does not. `writeMemory` and `searchMemory` use the Postgres `IndexStore` (`packages/mcp-server/src/service.ts`, `packages/mcp-server/src/index-store.ts`), and `loadConfig` ignores `HINDSIGHT_*` and `RAGFLOW_*`. The gateway code at programming-desk `61c7900` is the route above.

Programming Desk seats use HTTPS to the desk gateway, and substrate-mcp stays on loopback. `substrate-mcp` does read `DRAGONFLY_URL` for the read-through cache described in that document.

## Hooks the cloud agent does not load

`packages/projector/src/cursor.ts` writes substrate hook entries into the Cursor CLI file `/root/.cursor/hooks.json` on the host. Those commands pass `--surface cursor`. A cloud agent checkout does not read that host file. There is no `grok-bot` projector under `packages/projector`. Rules for a cloud session are this repository's `AGENTS.md` and `.cursor/rules/desk.mdc`.
