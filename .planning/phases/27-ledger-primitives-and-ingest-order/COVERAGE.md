# 27-01 Coverage — no new external API surface

**Recorded:** 2026-10-09

This plan adds **no new external API surface**, so there is no integration coverage to declare beyond the unit proof:

- **GreptimeDB HTTP SQL** is the pre-existing store, reached only through the existing `GreptimeClient` in `packages/mcp-server/src/greptime.ts`. This plan adds no statement, no method and no table to that client; the `event_ingest` DDL, hour reads and `anchors` shape check land in plan 02.
- **Solana JSON-RPC (`rpc.ts`) and the solana CLI (`solana.ts`)** are ported now but gain their first caller in Phase 28 (the anchor job). They have no caller in this phase, so no live Solana surface is exercised here. Their tests pin the argv/`execFile`/memo-instruction contract with stubbed transports only.
- **No new route, MCP tool, CLI command, dependency or environment variable.** The only wiring is the local `workspace:*` link to `@substrate/ledger`, resolved by `bun install` with no registry fetch.

The ported modules are proven by their 45 unit tests (`bun test packages/ledger`) plus the unchanged `store-lock`/`redact-lock` expectations met by inspection (the ported paths are outside `mayReachLedger` and carry no `greptime` import, no `GREPTIME_` reference and no SQL naming `agent_events`).
