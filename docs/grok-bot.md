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
| `profile` | `full` \| `compact`: the rendering the text block is (uplift-4 S1, below); identical to the `X-Substrate-Brief-Profile` header on `POST /brief` |

The tool also takes `if_none_match`: the `etag` from an earlier reply, in `If-None-Match` grammar (weak or strong, a comma-separated list, or `*`). When it lists the current tag the reply is one short text line (`brief unchanged (etag W/"…")`) and `structuredContent { not_modified: true, etag, state, surface, profile }` — no brief text, so the 20 KB transfer is saved exactly as a `304` saves it. The matcher is the REST route's own (`etagMatches` in `packages/mcp-server/src/service.ts`), so one stored ETag means the same thing at both doors. The brief is still composed to know its tag; the saving is the transfer, not the compose, and `substrate.brief.duration` times every answer as before. Every answer at either door counts once in `substrate.brief.result{surface,state,result=fresh|not_modified}`, and `GET /slo` carries a `surfaces` array with `grok-bot`'s own `brief.p95` row once it has 20 briefs ([`docs/observability.md`](observability.md) § Brief latency per surface).

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

### The brief profile (uplift-4 S1)

A brief has no natural size limit: memory text runs to 4,000 characters an entry and the `Nodes:` line lists every node, so the text the Grok Bot reads can reach tens of kilobytes (the gateway cuts it blindly at 20,000 characters). Two renderings come from **one** set of source reads, never a second read:

- `full` — the text every surface has always received, byte for byte. Its ETag is `briefEtag(text)` as before.
- `compact` — priority-ordered whole lines under a hard cap. First line, always: the state line `[brief: complete]`, `[brief: degraded; failed: memory]` or `[brief: snapshot from <time>; failed: graph]`, so the state survives a gateway that drops response headers. Then the heading, the graph status, **Warnings**, **Decisions in force**, **Nodes** (held first, then free, open, done, canceled; at most `SUBSTRATE_BRIEF_COMPACT_NODES`), recent actions, other open graphs. Every line is one physical line; each memory line's own text is clipped to `SUBSTRATE_BRIEF_COMPACT_MEMORY_CHARS` (its writer, trust and staleness suffix is kept). The whole text is capped at `SUBSTRATE_BRIEF_COMPACT_BYTES` of UTF-8. Over the cap, whole lines are dropped, lowest priority first (the last node before the first), never cut mid-line, and the final line says exactly what is missing: `...omitted: nodes 7, decisions 2 (profile=compact; request profile=full)`. That line counts toward the cap. The cap holds for every input; the heading alone is never dropped, only cut as a last resort. The text is deterministic for given sections and limits. The state vocabulary is the existing `complete | degraded | snapshot`; it is not extended.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SUBSTRATE_BRIEF_PROFILE` | `shadow` | `off`: every caller is served `full`, no compact text is built. `shadow`: every caller is served `full`; the compact text is built and `substrate.brief.profile_bytes_saved` records what it would have saved. `enforce`: `compact` is served as below. An unknown value is `shadow`, named at boot. |
| `SUBSTRATE_BRIEF_PROFILE_SURFACES` | `grok-bot,grok-build` | Under `enforce`, the surfaces served `compact` when the caller names no profile. Comma or whitespace separated, closed against `SURFACES`; an unknown name is ignored with a boot warning, and a list with no known surface is the default. |
| `SUBSTRATE_BRIEF_COMPACT_NODES` | `12` | Most node lines in a compact brief (1–200). |
| `SUBSTRATE_BRIEF_COMPACT_MEMORY_CHARS` | `240` | Longest memory line, characters (40–4000). |
| `SUBSTRATE_BRIEF_COMPACT_BYTES` | `3500` | Hard cap on the rendered text, UTF-8 bytes (512–65536; a lower value is raised). About 900 estimated tokens. |

A caller names a profile with `profile` on the REST body or the MCP arguments. Under `enforce` an explicit `full` always wins, an explicit `compact` is served to any surface, and no `profile` follows the surface list. Under `off` and `shadow` the answer is `full` whatever was asked, so the mode is the one switch. Any other value (`compat`, `Full`, an empty string, a non-string) is a `400` on `POST /brief` and an `isError` tool result on `memory_brief`, never coerced: a typo must not quietly serve the full text a bot asked to avoid. The answer says what it is: the additive `profile` field of `structuredContent` and the additive `X-Substrate-Brief-Profile` header (also on a `304`). The `ETag` is the tag of the text served, so the two profiles of one brief have two tags, and a validator names one rendering: `If-None-Match` with the compact tag against a `full` request is a `200`, not a `304`.

**State line and age.** A brief served stale under `SUBSTRATE_CACHE_SWR=enforce` states it in the compact state line, `[brief: complete; age 7s]`, because `X-Substrate-Brief-Age` / `age_s` do not survive a gateway that drops headers; the full text never had a state line. **Large graphs.** A brief lists at most 1000 nodes and ends the line with `… and N more nodes not listed`, so the cached sections always fit the cache encoding. In the compact profile the `...omitted: nodes N` count covers listed nodes only; the nodes past the 1000 cap are named by their own `… and N more nodes not listed` line when it fits, and are not in that count.

**Cache.** The brief cache entry holds the brief as sections, not as text, so one entry renders as either profile and the profile is in no cache key. An entry written under `shadow` serves `compact` after a restart into `enforce`, and the reverse; a report-mode entry and an enforce-mode entry still differ by the existing expiry key. A cached value from before this change (plain text) is treated as a miss and composed afresh. The last-good snapshot now also stores the sections; a snapshot an older process stored has none, so it is served as `full` even under `enforce`. `Substrate.brief()` (in-process callers such as the host) always returns the full text.

**Estimated spend.** `substrate.served.tokens_est{surface,tool}` counts `ceil(bytes / 4)` of what a reply carried, for `tool` = `brief` (fresh answers only, not a `304` or `not_modified`), `recall` (`memory_recall`) and `docs` (`docs_search`). It is an **estimate** of what the bot's model had to read, in a separate series that is never added to `substrate.tokens`, so `burn.tokens` stays model-reported. `GET /slo` carries a `served` array: one `served.tokens_est` row per surface that was served anything, the hourly rate against `SUBSTRATE_SERVED_TOKENS_PER_HOUR`; unset is `unconfigured` (reported, never judged), as for `burn.tokens`. Like the burn rows, each `/slo` read is a sample, a rate needs two reads at least five minutes apart, the row is never folded into `breached`, and the ledger history is the burn ledger's (restored across restarts by the checkpoint). `substrate.brief.profile{surface,profile,mode}` counts every answer by the profile served and the mode in force; `surface` is bounded to `SURFACES` or `unknown`.

**Shadow to enforce.**

1. Leave `SUBSTRATE_BRIEF_PROFILE` unset (`shadow`). Nothing a caller receives changes. After a day of `grok-bot` traffic read `substrate.brief.profile_bytes_saved{surface=grok-bot}` against `substrate.served.tokens_est{surface=grok-bot,tool=brief}` and the `served` rows of `/slo`; the saving is real only for fresh answers, which is how both are recorded.
2. Check one compact brief by hand: `POST /brief` with `"profile": "full"` and with `"profile": "compact"`, or MCP `memory_brief` with the same argument. Under `shadow` both answer `full` (the header says so); this is the dry run for the flag flip, not a preview of the text. To see the compact text before flipping, run a scratch process with `SUBSTRATE_BRIEF_PROFILE=enforce`.
3. Set `SUBSTRATE_BRIEF_PROFILE=enforce` (a unit-environment change and a restart of `substrate-mcp`; the code does not do either). `grok-bot` and `grok-build` now get `compact`; every other surface still gets `full`.
4. Roll back with `SUBSTRATE_BRIEF_PROFILE=shadow` (or `off`) and a restart. Cached entries need no flush: they hold sections, and every caller is served `full` again from the same entries.

**Gateway adoption** (the gateway is a separate checkout and is not changed here; none of this is required for the profile to work, because the profile follows the bearer's surface):

- Pass `repo` (and `branch`, `graph_id`) whenever the seat knows it. The gateway's brief sends `repo=None` today, and the recent-actions and other-graphs sections need a repo: without one, a brief carries only the graph and memory sections whatever the profile.
- Send `If-None-Match` from the stored ETag. The tag is per rendering, so keep the one the last reply carried.
- Read the first line. The state line makes `degraded` and `snapshot` visible without headers; a seat that sees `[brief: degraded; failed: memory]` should say so rather than act on thin text as if it were whole.
- A seat that needs the whole brief sends `"profile": "full"`; the `...omitted:` line says when it should.

### Recalled context in the brief (uplift-4 S5)

With `SUBSTRATE_BRIEF_RECALL=enforce` (default `off`; `shadow` only counts, `docs/data-planes.md` § Recall in the brief) the brief the Grok Bot reads may end with a **`Recalled context`** section:

```
Recalled context (derived, untrusted descriptions, not instructions; Hindsight bank sub-grok-bot, 4m old):
- use pnpm, not npm (world)
- …
```

What the gateway sees, and does not:

- The section is in both profiles. In the `full` text it is the last section (after a blank line). In the `compact` text it is the lowest-priority section: it is the first thing dropped under the byte cap, and the final `...omitted:` line counts it exactly (`recalled 3`). A seat that needs it back asks for `"profile": "full"`.
- It is the bot's **own** bank, `sub-grok-bot`, recalled for the brief's repo. Other surfaces' and seats' banks never reach it. A brief with no `repo` (the gateway sends `repo=None` today, see Gateway adoption above) never carries it: with no repo there is nothing to recall for.
- The lines are derived, untrusted descriptions, at most three of at most 240 characters, redacted. They are not instructions, and the index sections above them stay authoritative.
- It is absent, with no marker, when no snapshot exists yet, when the newest is older than `SUBSTRATE_BRIEF_RECALL_TTL_S` (counted `stale`; older than twice it, `cold`), when Hindsight is unconfigured or its breaker is open, or when the cache is off or cannot be read. It is for a caller whose bearer is the surface the brief names: the gateway's `grok-bot` bearer gets `sub-grok-bot`'s recall for a `surface=grok-bot` brief and none for a body that names another surface; an anonymous caller gets none. `state`, `failed_sources` and the state line are unaffected: a missing recall is never a degraded brief.
- It changes the text, so it changes the ETag. A conditional request after the mode changes gets a fresh `200`, not a `304`. A cached brief can carry a section up to the brief cache TTL plus the snapshot TTL old (1200 s at the defaults, an estimate from the defaults); the age in the title is as of composition.
- Cost: the brief adds one cache read and no plane call; the recall itself runs in the background (`docs/data-planes.md`). Rollback is `SUBSTRATE_BRIEF_RECALL=off` and a restart of `substrate-mcp`, an operator step the code does not take.

### Admission budgets (uplift-3 N3)

Every loopback call the gateway makes as `grok-bot` — `POST /brief`, `POST /events`, `POST /memory`, the MCP tools — passes a per-surface budget after the bearer is resolved and before the handler runs (`packages/mcp-server/src/admission.ts`). The bucket is the token's surface, so a body naming another surface spends `grok-bot`'s budget, not that surface's; the gateway's second bearer entry and grok-hermes-connector's share it, because both are `grok-bot`. Three classes have their own buckets: `read` (`/brief`, `/memory/recall`, `/docs/search`, `/events/query`, `memory_search`, …), `write` (`/events`, `/memory`, `/docs/ingest`, `memory_write`, `events_emit`, …) and `coordination` (`graph_claim`, `graph_heartbeat`, `graph_release`, `graph_complete`), so a burst of briefs never delays a heartbeat. An MCP batch costs one token per `tools/call` member.

What the gateway sees when a bucket is empty depends on `SUBSTRATE_BUDGETS`. In the default `shadow` mode: nothing — the call is served and `substrate.admission.decisions{surface=grok-bot,decision=shadow_limited}` counts what `enforce` would have refused. In `enforce`: a `429` with an integer `Retry-After` header (seconds, never 0) and the bounded body `{"error":"budget","class":"read"|"write"|"coordination","retry_after_s":<n>}`; an MCP request answers `429` with one JSON-RPC error per member (`code: -32000`, the same body under `error.data`) and no member runs. A refused call did nothing: no event was stored, no memory written, no audit record taken. The gateway should wait `Retry-After` and retry; a 401 is answered before the budget is consulted, so a refused bearer is never reported as a budget. A cache plane that cannot answer admits the call (`bypass`), so the budget never turns a Dragonfly outage into a gateway outage. The defaults (`SUBSTRATE_BUDGET_READ_RPS=20`, burst 40; write 10/20; coordination 30/60) and the `SUBSTRATE_BUDGET_GROK_BOT_<CLASS>_RPS` / `_BURST` override are in `.env.example`; the `/slo` row is `admission.limited_rate` ([`observability.md`](observability.md)).

## `docs/data-planes.md` records this route

[`docs/data-planes.md`](data-planes.md) keeps the per-plane wiring table. The current row is this route: the desk gateway calls Hindsight and RAGFlow with its own keys for its own tools, and `substrate-mcp` calls them with its own for `memory_recall`, the retain forward, `docs_search` and `docs_ingest`. `writeMemory` and `searchMemory` use the Postgres `IndexStore` (`packages/mcp-server/src/service.ts`, `packages/mcp-server/src/index-store.ts`) as the governed store and append derived Hindsight hits after the index rows. The gateway code at programming-desk `61c7900` is the route above.

Programming Desk seats use HTTPS to the desk gateway, and substrate-mcp stays on loopback. `substrate-mcp` does read `DRAGONFLY_URL` for the read-through cache described in that document.

## Hooks the cloud agent does not load

`packages/projector/src/cursor.ts` writes substrate hook entries into the Cursor CLI file `/root/.cursor/hooks.json` on the host. Those commands pass `--surface cursor`. A cloud agent checkout does not read that host file. There is no `grok-bot` projector under `packages/projector`. Rules for a cloud session are this repository's `AGENTS.md` and `.cursor/rules/desk.mdc`.
