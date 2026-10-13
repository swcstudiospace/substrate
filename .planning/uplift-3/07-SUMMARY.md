# 07 — N7 summary: Grok connector contract: smoke, MCP brief metadata, per-surface SLO

## What changed

| Area | Files | Change |
|---|---|---|
| Matcher + answer path | `packages/mcp-server/src/service.ts`, `server.ts` | `etagMatches` lives in `service.ts` beside `briefEtag` (removed from `server.ts`; no re-export). `briefConditional(request, ifNoneMatch)` returns `{ detail, notModified }` and records `observer.briefResult` once per answer with `surface` bounded to `SURFACES` or `unknown`. `POST /brief` calls it; 200/304 bytes and headers unchanged. New types `BriefAnswer`; `BriefDetail.state` is `BriefState`. |
| MCP | `packages/mcp-server/src/mcp.ts` | `memory_brief`: text unchanged; `outputSchema` + `structuredContent { etag, state, surface, failed_sources, snapshot_at }`; input `if_none_match` → `structuredContent { not_modified: true, etag, state, surface }` and the text `brief unchanged (etag W/"…")`. Description names the contract. `agent-card.ts` lists no tool outputs — untouched. |
| Counter | `packages/observability/src/instruments.ts`, `index.ts`, `packages/mcp-server/src/observe.ts` | `substrate.brief.result{surface,state,result}` (`BRIEF_STATES`, `BRIEF_RESULTS` closed), `recordBriefResult`, observer hook `briefResult`. |
| SLO | `packages/observability/src/slo.ts`, `index.ts`, `observe.ts`, `server.ts` | Latency targets accept `where`; `briefBySurfaceObjectives` → `SurfaceSloResult[]` (one `brief.p95` row per surface at ≥ `minSamples`, same target, sorted); `Observability.evaluateBriefSurfaces()`; `GET /slo` sibling `surfaces` after `docs`, never in `breached`. |
| Smoke | `scripts/grok-connector-smoke.ts`, `scripts/grok-connector-smoke.test.ts` | Opt-in, read-only, grok-bot bearer only (`SUBSTRATE_TOKEN_GROK_BOT` → tokens-dir file → `SUBSTRATE_TOKEN`), four checks `ok|degraded|failed` with timings, `--json`, exit 0/1/2, 401 hint names variables only. |
| Docs | `docs/grok-bot.md`, `docs/observability.md` | MCP contract table, `if_none_match`, smoke, gateway adoption steps (conditional POST with stored ETag per request context; propagate `X-Substrate-Brief`; docs via substrate `docs_search` = K5'); counter row, `surfaces` section, route table. |
| Tests | `mcp.brief.test.ts` (new), `instruments.test.ts`, `slo.test.ts`, `http.test.ts`, `brief-fast-path.test.ts` (import only) | See 07-PLAN.md. No existing assertion weakened. |

## Flags and defaults

None added. Additive fields only; `if_none_match` changes nothing unless sent; the smoke runs only when invoked.

## Decisions

- **`surface` in `structuredContent`.** The brief does not say which surface it was composed for, and no route reports the bearer's identity, so the smoke's "refuse a bearer that is not grok-bot" needed one bit from the server. The composed-for surface is the honest one (argument, else bearer, else `claude-code`), is useful to the gateway for the same reason, and costs one field.
- **The counter is recorded in `briefConditional`, not in the two routes.** Both doors answer through it, so they cannot count differently; the sample carries the state the caller saw and whether text was sent — what a 304 saves.
- **The smoke does not compare the REST and MCP ETags** — an event landing between two live calls legitimately moves the brief; equality for one request is `mcp.brief.test.ts`'s job.
- **Rows below the floor are omitted** from `surfaces` rather than reported `insufficient-data`, so the array is empty until there is something to say and bounded by the calling surfaces.

## How it is measured

- `GET /metrics`: `substrate.brief.result{surface=grok-bot,result=not_modified}` is the gateway's conditional-request adoption; zero until programming-desk's step 1 lands.
- `GET /slo` → `surfaces[]`: `grok-bot`'s own `brief.p95` after 20 briefs; `results[0]` stays the blend.
- `bun run smoke:grok` on the VPS with the real bearer (operator step): expect four `ok` lines and exit 0; `1` names a degraded plane; `2` with the 401 hint means the token file or variable is wrong.

## Rollback

Revert the branch: no state, schema, unit or env change. A client that ignores `structuredContent` sees the previous behaviour throughout.

## External dependency

Gateway adoption (programming-desk `desk-gateway`): recorded in `docs/grok-bot.md` § Gateway adoption; not in this repo.

## Gates

At the branch head after both waves merged (orchestrator-run, 2026-10-13): `bunx tsc --noEmit` clean · `bun test` with `SUBSTRATE_TEST_PG_URL` (scratch Postgres 16) **3845 pass / 1 skip / 1 fail** — the one failure is the recorded F-01 (`scripts/rehearsal.test.ts` "CLI refusals > --port 7410 exits 2", identical on `main`) · `bun run check:phase-close` pass (EVENT_KINDS 12, SURFACES 27, 4 lock files) · `bun run test:py` 298 pass.
