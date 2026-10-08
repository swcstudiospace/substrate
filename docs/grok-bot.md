# Grok Bot

How the `grok-bot` surface reaches memory, documents, briefs, and events. Grok Bot is a Programming Desk seat. It reaches the desk gateway over HTTPS. The gateway calls Hindsight and RAGFlow directly for memory and documents when those planes are configured. Substrate is the fallback for those two tools, and the target for the brief and for events.

This note cites [`swcstudiospace/programming-desk`](https://github.com/swcstudiospace/programming-desk) at `61c7900` (`61c79005b4c71504845e7f3a92a4830bd7237c03`) for the gateway, and this repository for what `substrate-mcp` actually implements. It does not add a client, a route, or an environment variable.

## Surface

`grok-bot` is a substrate surface. `SURFACES` in `packages/mcp-server/src/types.ts` lists it beside `cursor` and `grok-build`. `.env.example` names the matching token variable `SUBSTRATE_TOKEN_GROK_BOT`. The value stays in `/etc/substrate/substrate.env` on the VPS. The gateway's substrate client sends `surface: grok-bot` on the brief and on events (`Substrate.brief` and `Substrate.emit` in programming-desk `services/desk-gateway/src/desk_gateway/upstreams.py`).

## Loopback only

`loadConfig` in `packages/mcp-server/src/config.ts` defaults the listen address to `127.0.0.1` and the port to `7410` (`SUBSTRATE_HOST`, `SUBSTRATE_PORT`). The README states the same bound: substrate-mcp on `127.0.0.1:7410`, MCP at `/mcp`, with `POST /brief`, `POST /events`, `POST /events/query`, `POST /memory`, and `POST /verify`. That address is loopback. A session that is not on the VPS cannot open it.

The gateway process on the VPS can. `Settings` in programming-desk `services/desk-gateway/src/desk_gateway/config.py` defaults `SUBSTRATE_URL` to `http://127.0.0.1:7410` and listens on `127.0.0.1:8791`. The public name in both `config.py` and [`docs/data-planes.md`](data-planes.md) is `desk.swcstudio.space`.

## Access path

[`docs/railway-tailscale.md`](railway-tailscale.md) places Grok Bot computers off the tailnet. They reach the desk gateway over HTTPS. The gateway, on the VPS, is what can reach Hindsight, RAGFlow, and loopback `substrate-mcp`. Grok Bots do not receive the Hindsight or RAGFlow keys. Those keys are gateway settings: `HINDSIGHT_URL`, `HINDSIGHT_API_KEY`, `RAGFLOW_URL`, and `RAGFLOW_API_KEY` in programming-desk `config.py`.

Ming's Q2 decision is this route. Memory and documents run through the gateway calling Hindsight and RAGFlow directly. `substrate-mcp` has no adapters for either plane; the gateway is the client.

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

`packages/mcp-server/src/config.ts` does not read `HINDSIGHT_*` or `RAGFLOW_*`. No file under `packages/` imports a Hindsight or RAGFlow client. Hindsight and RAGFlow adapters are not implemented in substrate-mcp. `.env.example` lists `HINDSIGHT_URL`, `HINDSIGHT_API_KEY`, `HINDSIGHT_BANK_PREFIX`, `RAGFLOW_URL`, `RAGFLOW_API_KEY`, and `RAGFLOW_DATASET_ID`; `loadConfig` ignores them.

`memory_write` and `memory_search` are registered in `packages/mcp-server/src/mcp.ts`. The README and [`docs/memory-governance.md`](memory-governance.md) describe that gate over the Postgres index: default-deny RBAC, quarantine, an idempotency key, and a conflict strategy. They are the substrate fallback and the second retain write. They are not a Hindsight client.

The gateway's document fallback calls a substrate tool named `docs_search`. This repository does not register that tool. `docs/data-planes.md` also names `substrate docs ingest` and `POST /docs/ingest`. None of those exist under `packages/`.

## `docs/data-planes.md` is stale on this route

[`docs/data-planes.md`](data-planes.md) still describes a substrate-only memory path: the writer is `substrate-mcp`, `memory_write` maps to Hindsight `retain`, `memory_search` maps to `recall`, and the desk gateway calls the substrate rather than Hindsight. That is the path this repository's server implements, and it is not the path the gateway takes when `HINDSIGHT_URL` and `HINDSIGHT_API_KEY` are set. The gateway code at programming-desk `61c7900` is the route above. This pull request does not edit `docs/data-planes.md`.

The network half of that document still holds: Programming Desk seats use HTTPS to the desk gateway, and substrate-mcp stays on loopback.

## Hooks the cloud agent does not load

`packages/projector/src/cursor.ts` writes substrate hook entries into the Cursor CLI file `/root/.cursor/hooks.json` on the host. Those commands pass `--surface cursor`. A cloud agent checkout does not read that host file. There is no `grok-bot` projector under `packages/projector`. Rules for a cloud session are this repository's `AGENTS.md` and `.cursor/rules/desk.mdc`.
