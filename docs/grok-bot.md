# Grok Bot

How the `grok-bot` surface reaches substrate data. This note follows the code and [`docs/data-planes.md`](data-planes.md). It does not add a client, a route, or an environment variable.

## Surface

`grok-bot` is a substrate surface. `SURFACES` in `packages/mcp-server/src/types.ts` lists it beside `cursor` and `grok-build`. `.env.example` names the matching token variable `SUBSTRATE_TOKEN_GROK_BOT`. The value stays in `/etc/substrate/substrate.env` on the VPS.

## Loopback only

`loadConfig` in `packages/mcp-server/src/config.ts` defaults the listen address to `127.0.0.1` and the port to `7410` (`SUBSTRATE_HOST`, `SUBSTRATE_PORT`). The README states the same bound: substrate-mcp on `127.0.0.1:7410`, MCP at `/mcp`, with `POST /brief`, `POST /events`, `POST /events/query`, `POST /memory`, and `POST /verify` for callers that cannot speak MCP. That address is loopback. A session that is not on the VPS cannot open it.

## Access path

[`docs/data-planes.md`](data-planes.md) draws two doors. Agents on the VPS (Claude Code, Hermes, Omp, Muse, Grok Build, Cursor) use MCP or hooks on loopback. Programming Desk seats, which that diagram labels Grok Bots, use HTTPS to the desk gateway. The public name recorded there is `desk.swcstudio.space`; on the VPS the gateway listens on `127.0.0.1:8791` and calls substrate-mcp over loopback.

[`docs/railway-tailscale.md`](railway-tailscale.md) says the same thing from the network side: Grok Bot computers are not on the tailnet. They reach the desk gateway over HTTPS. The gateway, on the VPS, is what can reach the planes.

For memory, `docs/data-planes.md` is explicit: the desk gateway calls the substrate, not Hindsight directly. The calls it names are `memory_write` and `memory_search` over loopback. Both tools are registered in `packages/mcp-server/src/mcp.ts`. One tenant key is held by the substrate; Grok Bots do not receive the Hindsight or RAGFlow keys (`docs/data-planes.md`).

## Hindsight and RAGFlow are not wired in substrate-mcp

`docs/data-planes.md` names Hindsight as the memory application and RAGFlow as the documents application, both reached from the VPS. `.env.example` lists `HINDSIGHT_URL`, `HINDSIGHT_API_KEY`, `HINDSIGHT_BANK_PREFIX`, `RAGFLOW_URL`, `RAGFLOW_API_KEY`, and `RAGFLOW_DATASET_ID`.

`packages/mcp-server/src/config.ts` does not read those variables. No file under `packages/` imports a Hindsight or RAGFlow client, and nothing in the TypeScript or Python sources calls `HINDSIGHT_*` or `RAGFLOW_*`. Hindsight and RAGFlow adapters are not implemented in substrate-mcp today.

`memory_write` and `memory_search` are the governed memory tools. The README and [`docs/memory-governance.md`](memory-governance.md) describe that gate over the Postgres index: default-deny RBAC, quarantine, an idempotency key, and a conflict strategy. They are not a retain or recall call into Hindsight. `docs/data-planes.md` describes that mapping (`memory_write` → `retain`, `memory_search` → `recall`); the server does not implement it.

`docs/data-planes.md` also names `docs_search`, `substrate docs ingest`, and `POST /docs/ingest` for RAGFlow. None of those exist in `packages/`.

## Hooks the cloud agent does not load

`packages/projector/src/cursor.ts` writes substrate hook entries into the Cursor CLI file `/root/.cursor/hooks.json` on the host. Those commands pass `--surface cursor`. A cloud agent checkout does not read that host file. Rules for a cloud session are this repository's `AGENTS.md` and `.cursor/rules/desk.mdc`.
