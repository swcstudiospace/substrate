# Greptile access reuse check (Q5)

Read-only discovery. No tests, typecheck, lint or formatters were run. No secret value appears here; environment variables and credential fields are named only.

Citation base: `ut-pin/` = `/root/src/worktrees/ut-pin/`. Spec of record: `/root/.omp/agent/ultrathink/sessions/01a1d01f-29fb-745f-a2d2-9bce5b3f2926.xml` (Graph ut-f35e12d58f-ed1087ea).

Files read: `ut-pin/src/greptile/knowledge.ts`, `ut-pin/src/mcp/client.ts`, `ut-pin/src/mcp/store.ts`, `ut-pin/src/config.ts` (greptile keys). Files read for facts those four depend on: `ut-pin/src/mcp/providers.ts`, `ut-pin/src/mcp/relay.ts`, `ut-pin/src/mcp/oauth.ts`, `ut-pin/src/ship/greptile.ts`, `ut-pin/src/ship/types.ts`, `ut-pin/src/hitl/types.ts`, `ut-pin/src/track/create.ts`.

## 1. Module and exported surface

Module: `ut-pin/src/greptile/knowledge.ts` (522 lines).

- `createGreptileKnowledge(config: UltrathinkConfig, deps: { storePath?: string; fetch?: typeof fetch; now?: () => number } = {}): KnowledgeReader | undefined`. Lines 507-510. Returns `undefined` unless `config.hitl.knowledgeBase` is true (line 511). Wires `createMcpClientIfCredentialed("greptile", { storePath, fetch, callTimeoutMs: 10_000 })` (lines 513-518) and `organization: config.ship.greptileOrganization || undefined` (line 519).
- `createKnowledgeReader(opts: { client: () => Caller | undefined; organization?: string; maxDocs?: number; maxChars?: number; timeoutMs?: number; now?: () => number }): KnowledgeReader`. Lines 258-265 (`client` 259, `organization` 260, `maxDocs` 261, `maxChars` 262, `timeoutMs` 263, `now` 264). Defaults: `KNOWLEDGE_MAX_DOCS = 3` (line 62), `KNOWLEDGE_MAX_CHARS = 24_000` (line 64), `KNOWLEDGE_TIMEOUT_MS = 20_000` (line 66), applied at lines 266-268.
- `selectDocuments(input: { index?: string; paths: string[]; topic: string; maxDocs: number }): string[]`. Lines 180-185. Returns up to `maxDocs` listed paths scored from index.md's routing table, or from path words when there is none. `index.md` is excluded at line 186.
- `buildDigest(input: { repoName: string; version?: string; docs: Array<{ path: string; content: string }>; maxChars: number }): string`. Lines 232-237. Output never exceeds `maxChars`; `</knowledge_base` is neutralised by the replace at line 254.

Interfaces returned by the factories:

- `KnowledgeLookup`, lines 20-37 (`outcome` is `"used" | "none" | "off" | "error"`, type at line 17).
- `KnowledgeResult`, lines 39-43 (`lookup`, `digest`).
- `KnowledgeSession`, lines 45-54: `read(topic: string): Promise<KnowledgeResult>` (line 51) and `close(): void` (line 53).
- `KnowledgeReader`, lines 56-59: `start(input: { repo?: string; signal?: AbortSignal }): KnowledgeSession` (line 58).

The `Caller` type the reader accepts is `ToolCaller & { close?(): void }` (line 86). `ToolCaller` is `call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>` at `ut-pin/src/track/create.ts:32-34`. The reader uses only `call` and optional `close`.

## 2. Transport

- Base URL: `https://api.greptile.com/mcp`. `ut-pin/src/mcp/providers.ts:63` (`MCP_PROVIDERS.greptile.url`); the resource is the same origin at line 64. Provider block starts at line 59.
- The client reads that URL at `ut-pin/src/mcp/client.ts:94` (`url: MCP_PROVIDERS[provider].url`).
- Protocol: MCP JSON-RPC 2.0 over HTTP POST. `ut-pin/src/mcp/relay.ts:158-164` (`method: "POST"`, body is one JSON-RPC message). Headers at lines 147-155: `Accept: application/json, text/event-stream` (line 148), `Content-Type: application/json`, `User-Agent` from `USER_AGENT` = `ultrathink-mcp/0.2.0` (`providers.ts:117`), `Authorization` when a header is returned (line 152), `Mcp-Session-Id` once a session exists (lines 153-154), `MCP-Protocol-Version` (line 155). Protocol version sent at initialize: `2025-06-18` (`client.ts:168`).
- Responses: JSON or SSE (`relay.ts:202-256`; SSE parser imported at `relay.ts:4`).
- Redirects are refused: `redirect: "error"` at `relay.ts:163`, with the comment that a redirect would resend the bearer token.
- Overridable by configuration: **no**. `McpClientDeps` carries only `storePath`, `fetch`, `callTimeoutMs` (`client.ts:24-28`); `createMcpClient` takes no URL parameter (`client.ts:83`). `createGreptileKnowledge` passes no URL (`knowledge.ts:512-518`). No Greptile URL key exists in `ut-pin/src/config.ts` (greptile keys are listed in section 5). No environment read in the mcp/ or greptile/ code path sets the URL. The only injection seam is the `fetch` dependency (`knowledge.ts:509`, `516`), which is a code seam, not configuration.

## 3. Credential scope

Environment variables read on this path (names only):

- `ULTRATHINK_MCP_STORE`: overrides the store file path. `ut-pin/src/mcp/store.ts:52`.
- `XDG_CONFIG_HOME` and `HOME`: pick the default base directory. `store.ts:53`. Default file is `<base>/ultrathink/mcp-credentials.json` (`store.ts:53-54`).
- The default parameter of `storePath` is `process.env` (`store.ts:51`). `knowledge.ts:515` calls `storePath()` unless `deps.storePath` is given.
- No other environment read was found in `ut-pin/src/greptile/knowledge.ts`, `ut-pin/src/mcp/client.ts`, `ut-pin/src/mcp/relay.ts`, `ut-pin/src/mcp/oauth.ts`, `ut-pin/src/mcp/store.ts`, `ut-pin/src/mcp/providers.ts` or `ut-pin/src/ship/greptile.ts`. Outside this path: `ut-pin/src/mcp/cli.ts:553` reads `ULTRATHINK_MCP_DEBUG` (CLI only); `cli.ts:222` passes `process.env` to a CLI redirect helper.
- No Greptile-specific credential environment variable exists. The MCP provider type has no env-var field (`providers.ts:12-22`); the greptile entry is at lines 59-68. `loginHint` names an env var only for key providers (`client.ts:53-61`).

Credential kinds stored for `greptile` (`store.ts:36-44`):

- `api_key`: field `apiKey`, `store.ts:37`. Sent as `Authorization: Bearer <apiKey>` (`ut-pin/src/mcp/oauth.ts:440`).
- `oauth`: `store.ts:38-44`. Fields: `client` (OAuth client registration, `store.ts:19-27`, includes `clientSecret` optional), `tokens` (`store.ts:29-34`: `accessToken`, optional `refreshToken`, `expiresAt`, `scope`), `needsLogin` (`store.ts:42`), `updatedAt`. Sent as `Bearer <accessToken>` (`oauth.ts:441-444`). Refreshed under lock when near expiry (`oauth.ts:446-455`, `refreshLocked` at `oauth.ts:184`) and after a 401 (`oauth.ts:459-487`).
- Both kinds are accepted. The API-key and OAuth flags are both true for greptile (`providers.ts:66-67`).
- Usability gate: `hasUsableCredential` is true for an api_key, or for oauth with tokens and no `needsLogin` (`client.ts:217-221`). Otherwise `createMcpClientIfCredentialed` returns `undefined` (`client.ts:224-235`), and the lookup reports `outcome: "off"` (`knowledge.ts:356-357`).
- Storage: plaintext JSON. `writeStore` writes `JSON.stringify(store)` with file mode `0o600` (`store.ts:133-137`); the directory is created with mode `0o700`. Non-strict reads treat a corrupt store as empty (`store.ts:77-99`); the auth-header read is strict (`oauth.ts:438`).

## 4. Timeout and retry policy (as coded)

Per MCP request (`ut-pin/src/mcp/client.ts`):

- Timer: `timeoutMs = deps.callTimeoutMs ?? 30_000` (`client.ts:86`). Greptile's knowledge reader passes `10_000` (`knowledge.ts:517`). The timer (`client.ts:146`) fails the request with `<method>: timed out after <ms>ms` via `fail` (`client.ts:141-145`); it is cleared in `finally` (`client.ts:158`).
- Caller abort: a caller signal aborts the request (`client.ts:147-148`).
- Initialize: one `initialize` plus `notifications/initialized` per client, memoised (`client.ts:163-181`). A failed handshake clears the memo (`client.ts:177-179`), so the next call re-initializes. No loop.
- Tool-page cap for `tools/list`: `MAX_TOOL_PAGES = 100` (`client.ts:17`, `192-193`). The knowledge reader does not call `listTools` (its `Caller` type exposes only `call`).

Knowledge-reader budgets (`ut-pin/src/greptile/knowledge.ts`):

- Stage budget: `KNOWLEDGE_TIMEOUT_MS = 20_000` (`knowledge.ts:66`), used by `createKnowledgeReader` (`knowledge.ts:268`) and not overridden by `createGreptileKnowledge` (`knowledge.ts:512-521`). Applied per stage: the prefetch deadline (`knowledge.ts:359`) and the read deadline (`knowledge.ts:412`).
- `deadline()` (`knowledge.ts:122-150`) joins the caller signal with `AbortSignal.timeout(ms)` (line 123), sets a timer (line 133), and races a rejecting promise (line 138) so a call that ignores its signal still settles.
- Pagination caps: `NAMESPACE_PAGES = 20` (`knowledge.ts:69`, loop at 293); `DOCUMENT_PAGES = 5` (`knowledge.ts:70`, loop at 319); `PAGE_LIMIT = 100` (`knowledge.ts:71`).
- Retries in the knowledge reader: none. Any selected document that fails, times out or has no string content makes the whole lookup `error` (contract at `knowledge.ts:45-50`; code at `knowledge.ts:453-458`). A prefetch failure is `error` (`knowledge.ts:401`).
- Single-call memoisation: `read(topic)` is memoised (`knowledge.ts:492`); `close()` aborts the lifetime signal and closes the client (`knowledge.ts:495-500`).

Transport-level retries and error paths (`ut-pin/src/mcp/relay.ts`, `ut-pin/src/mcp/oauth.ts`):

- Network throw: caught; reported as `upstream unreachable`, JSON-RPC -32000 (`relay.ts:166-168`, `330-333`).
- HTTP 401: one `auth.unauthorized` recovery, then one re-POST (`relay.ts:171-180`). Recovery refreshes the token or marks `needsLogin` (`oauth.ts:459-487`). A terminal 401 becomes -32001 (`relay.ts:346-351`).
- HTTP 404 with an active session: one re-initialize, then one re-POST (`relay.ts:317-328`).
- Rate limit (429, or 401/403 with rate-limit signals): not retried; returned as -32029 with the retry-after value when present (`relay.ts:108-119`, `335-345`).
- Other non-OK status: not retried; -32000 `upstream HTTP <status>` (`relay.ts:352-359`).
- Token-endpoint fetches bounded by `LOCKED_FETCH_TIMEOUT_MS = 15_000` (`oauth.ts:70`; used at `oauth.ts:112`, `156`, `293`).
- Relay default request budget `REQUEST_TIMEOUT_MS = 120_000` (`relay.ts:59`, `135`) applies only when a message has no caller signal (`relay.ts:404`). The client always passes its own signal (`client.ts:149`), so the client's `callTimeoutMs` governs.

## 5. Organization input and its configuration key

- Input: `organization?: string` on `createKnowledgeReader` (`knowledge.ts:260`). Trimmed and included only when non-empty (`knowledge.ts:270`). Added to every tool call as `{ ...args, ...org }` (`knowledge.ts:289`).
- Configuration key: `ship.greptileOrganization`.
  - Type: `greptileOrganization: string` (`ut-pin/src/ship/types.ts:20`).
  - Default: `""` (`ut-pin/src/ship/types.ts:58`).
  - Read per layer, trimmed: `ut-pin/src/config.ts:672-675`.
  - Project-layer rule: a repository-controlled layer can set it only when no earlier layer did (`config.ts:1053-1056`).
  - Consumed: `config.ship.greptileOrganization || undefined` (`knowledge.ts:519`).
- Tenant error: `tenantReason` (`ut-pin/src/ship/greptile.ts:80-85`) returns a reason naming `ship.greptileOrganization` when Greptile reports `tenant_required`. The knowledge reader surfaces it at `knowledge.ts:143`. The reader does not retry with a candidate.

## 6. The three read-only tool calls

The only dispatch point is `call(dl, caller, name, args)` (`knowledge.ts:288-289`). Calls to Greptile in this module:

1. `list_knowledge_bases`: `knowledge.ts:295`. Args `{ limit: 100, offset, organization? }`. Scans `repositories[]` for a case-insensitive `repoName` match and takes `namespaceId` (`knowledge.ts:302-303`). Pagination by `returned` / `total` / `truncated` (`knowledge.ts:291-312`).
2. `list_knowledge_base_documents`: `knowledge.ts:321`. Args `{ namespaceId, limit: 100, offset, organization? }`. Reads `documentPaths[]`, `indexPresent`, `sectionVersions.docs` (version). Each path must match `/^[\w./-]+\.md$/` (`knowledge.ts:74`, check at 334), must not contain `..` (line 335), and must be at most 200 chars (`knowledge.ts:72`, check at 336). Checks at `knowledge.ts:332-340`.
3. `get_knowledge_base_document`: called twice.
   - index.md during prefetch: `knowledge.ts:385`, args `{ namespaceId, path: "index.md", organization? }`. Content via `document.content` (`knowledge.ts:170-172`).
   - Selected documents during read: `knowledge.ts:434`, args `{ namespaceId, path, organization? }`.

Grep of `knowledge.ts` for the three tool names returns exactly these call sites (lines 295, 321, 385, 434). None of the three writes state.

## 7. Reuse by agent-substrate

Answer: **no, not unchanged.** The module cannot be imported from agent-substrate as-is. The reusable core (`createKnowledgeReader`, `selectDocuments`, `buildDigest`) depends only on the `ToolCaller` shape, `asObj`, and `tenantReason`. The coupling is in `createGreptileKnowledge` and in the MCP client and credential store it builds on.

Dependencies that would have to move or be replaced:

1. Config type: `import type { UltrathinkConfig }` (`knowledge.ts:9`; `ut-pin/src/config.ts:215`). `createGreptileKnowledge` reads `config.hitl.knowledgeBase` (`knowledge.ts:511`) and `config.ship.greptileOrganization` (`knowledge.ts:519`).
2. MCP client: `createMcpClientIfCredentialed` (`knowledge.ts:10`; `client.ts:224-235`) and its imports: `./oauth.ts` (`client.ts:3`), `./relay.ts` (`client.ts:12`), `./store.ts` (`client.ts:13`), `./providers.ts` (`client.ts:4-11`), and `../track/create.ts` for the type `ToolCaller` (`client.ts:14`).
3. Relay: `../net/body.ts` (`relay.ts:3`), `./sse.ts` (`relay.ts:4`), `../shared.ts` (`relay.ts:7`), `services/ultrathink/security/events.ts` (`relay.ts:5`) and `services/ultrathink/security/validation.ts` (`relay.ts:6`).
4. OAuth: `../net/body.ts` (`oauth.ts:7`), `services/ultrathink/security/events.ts` (`oauth.ts:9`), `services/ultrathink/security/validation.ts` (`oauth.ts:10`), and `withStoreLock` / `writeStore` from `store.ts` (`oauth.ts:6`).
5. Store: `processIdentity` from `ut-pin/src/swarm/lane.ts` (`store.ts:16`). `lane.ts` imports `node:child_process` and `../shared.ts` (`lane.ts:12`, `25`).
6. Tenant reason: `tenantReason` from `ut-pin/src/ship/greptile.ts` (`knowledge.ts:12`; defined at `ship/greptile.ts:80`). That file imports `./github.ts` (type, line 3), `./run.ts` (`defaultRun`, line 4), `./types.ts` (lines 5-11) and `../shared.ts` (line 12). Moving it pulls in the ship GitHub and run layers. A Substrate copy could inline the 6-line regex-and-message function instead.
7. Shared helpers: `asObj` (`knowledge.ts:13`; defined at `ut-pin/src/shared.ts:15`), `isRecord` (`shared.ts:10`).
8. Ultrathink-specific identity and paths: store default path and env var (`store.ts:52-54`); user agent `ultrathink-mcp/0.2.0` (`providers.ts:117`); client info name `ultrathink-track` 0.2.0 (`client.ts:170`); tenant message pointing at `~/.config/ultrathink/config.json` (`ship/greptile.ts:84`).
9. Credential format and lock: `Credential` / `CredentialStore` types (`store.ts:36-47`) and the lock-and-owner machinery (`store.ts:142-312`).

Agent-substrate facts (repo `/root/src/repos/agent-substrate`, excluding `.planning/` and `docs/`):

- No `ToolCaller`, `UltrathinkConfig`, `createMcpClient` or Greptile knowledge code was found.
- `packages/host/src/options.ts:75` (`D12_HOSTS`) already lists `api.greptile.com` in the egress allowlist. Network reachability is not a blocker.
- `packages/host/package.json:5` is ESM (`"type": "module"`); `:7-9` requires Node `>=22`.
- [INFERENCE, not executed] The knowledge path uses `Promise.withResolvers` (`client.ts:136`), `AbortSignal.any` (`knowledge.ts:123`) and global `fetch`, which Node 22 provides. The one Bun-only call, `Bun.stdin.stream()`, is a default parameter of `runStdioRelay` (`relay.ts:446`), not on the client path.

Interface a Substrate adapter would need (from section 1): `createKnowledgeReader({ client, organization })` takes any object with `call(name, args, signal?)` (`knowledge.ts:86`, `track/create.ts:32-34`). A Substrate-side MCP caller plus an organization input equivalent to `ship.greptileOrganization` would satisfy it without moving the config type or the credential store. This is a design observation for Main, not a decision.

## 8. Q5 verdict

Spec wording, verbatim (`grep -n 'Q5'`):

- Line 343: `- Q5 Does Ultrathink's Greptiles client work from Substrate as-is, and what is its interface? Default: reuse it unchanged with a Substrate call site; if it is not reusable, add a shared adapter in Layer 1 and record the change.`
- Line 387: `Q5 (Greptiles reuse): if Ultrathink's Greptiles access module is not reusable as is, add one shared adapter in a new Wave 3 unit and record the change. Default: reuse unchanged.`
- Line 395 (W1-B, this unit): `done when: module path, interface, credential scope, timeout, and retry policy are recorded with provenance`

Branch that applies: **the conditional branch, "if it is not reusable, add a shared adapter … and record the change."** The first branch, "reuse it unchanged with a Substrate call site," does not apply.

Reason: section 7. The module imports `UltrathinkConfig`, the MCP client, the OAuth and relay layers, the credential store, the `ship/greptile.ts` tenant helper, and the Ultrathink `services/` security modules. Agent-substrate has none of the config type, the `ToolCaller`-backed MCP client, or the credential store, so the default cannot be met without moving or re-creating that closure.

Open for Main: the spec places the adapter in two different spots. Line 343 says "Layer 1". Line 387 says "a new Wave 3 unit". This file does not choose between them.

## Not resolved

- Whether `services/ultrathink/security/*` (imported by `relay.ts` and `oauth.ts`) exists in agent-substrate: not searched.
- Runtime behaviour of the module under Substrate's Node runtime: not executed (rules forbid tests).
- Greptile's own input schemas for the three tools: not read (outside the four assigned files). The `organization` argument is taken from `knowledge.ts:289` as coded.
