# S1 — Summary

## What changed
- **One read, two renderings.** `composeBriefSections` (`brief.ts`) reads the four sources once and returns `BriefSection[]` (`id`, `priority`, the exact `lines` the full text prints, plus compact `items`/`title`). `composeBrief` is now `renderFullBrief(sections)`, byte-identical to the old text (pinned by a literal-text test). `brief-profile.ts` (new) holds the section types, `renderCompactBrief`, the state line, mode/config parsing, `resolveBriefProfile`, `parseBriefProfile`, and the zod-validated cache encoding of sections.
- **Compact** (`renderCompactBrief`): state line, then heading, graph status, Warnings, Decisions, Nodes (held, free, open, done, canceled; ≤ `SUBSTRATE_BRIEF_COMPACT_NODES`), recent actions, other graphs; one physical line each; memory lines clipped at the entry text (writer/trust/staleness kept); hard UTF-8 cap with whole-line, lowest-priority-first dropping and an exact `...omitted: …` last line that counts toward the cap. Deterministic and pure; the cap holds for every input (a heading that cannot fit is cut, and a last guard cuts the text).
- **Service** (`service.ts`, `briefDetailed`/`briefConditional` only plus a private `servedBrief`, two helpers and observer ports): the `brief` cache entry now holds the encoded sections (cache args gain `shape: "sections-v1"` so older plain-text entries are never read as sections); `decodeSections` returning null (old/foreign value) is a miss and a fresh compose, never a throw. The profile is chosen when the answer is served, so it is in no cache key and a shadow entry cannot be served as enforce output or vice versa (the entry is one value; the mode is applied on read). The snapshot also stores `sections` (a snapshot without them serves `full`). `BriefDetail` gains `profile`, `mode`, `bytesSaved`. `Substrate.brief()` always returns the full text.
- **Wire:** `profile` argument on `memory_brief` and in the REST body (unknown → 400 / `isError`, via `parseBriefProfile`); additive `profile` in `structuredContent` and `outputSchema`; additive `x-substrate-brief-profile` header (also on a 304).
- **Metrics** (`instruments.ts`): `substrate.brief.profile_bytes_saved{surface}`, `substrate.brief.profile{surface,profile,mode}`, `substrate.served.tokens_est{surface,tool}` (`estimateTokens` = ceil(bytes/4), described as ESTIMATED, never added to `substrate.tokens`). `briefConditional` records them for fresh answers (profile counter also for 304s); `memory_recall` and `docs_search` replies record `recall`/`docs` (the recall leg inside `memory_search` is not counted). Surface labels are bounded to SURFACES or `unknown`.
- **/slo** (`slo.ts`, `observe.ts`, `server.ts`): `servedTokensBySurface` → `served` array, one `served.tokens_est` row per surface, hourly rate against `SUBSTRATE_SERVED_TOKENS_PER_HOUR` (unset → `unconfigured`), same ledger mechanics as `burn.ts` (series keyed `substrate.served.tokens_est|<surface>` in the shared burn ledger, so the checkpoint restores them). `burn.ts` now exports `warnOnce` and `thresholdFrom` (no behaviour change).
- **Boot:** `config.briefProfile` (parsed by `loadBriefProfileConfig`); warnings printed by `index.ts` through `briefProfileConfigWarnings`.
- **Docs:** `docs/grok-bot.md` (profile contract, variables, cache note, estimated spend, shadow→enforce steps, gateway adoption notes). `.env.example` is untouched; see `env-notes/S1.md`.

## Files
New: `packages/mcp-server/src/brief-profile.ts`, `brief-profile.test.ts`, `.planning/uplift-4/{S1-PLAN,S1-SUMMARY}.md`, `.planning/uplift-4/env-notes/S1.md`.
Edited: `brief.ts`, `service.ts`, `mcp.ts`, `server.ts`, `observe.ts`, `config.ts`, `index.ts`, `mcp.brief.test.ts`; `packages/observability/src/{instruments,slo,burn,index}.ts`, `instruments.test.ts`, `slo.test.ts`; `docs/grok-bot.md`.

## Flags and defaults
`SUBSTRATE_BRIEF_PROFILE=shadow` (off | shadow | enforce); `SUBSTRATE_BRIEF_PROFILE_SURFACES=grok-bot,grok-build`; `SUBSTRATE_BRIEF_COMPACT_NODES=12`; `…_MEMORY_CHARS=240`; `…_BYTES=3500` (floor 512); `SUBSTRATE_SERVED_TOKENS_PER_HOUR` unset. Under the default, off and shadow serve the pre-change text for every surface.

## Failure behaviour
A compact rendering that throws serves the full text (logged once per occurrence, truncated). A metric-recording failure never fails the answer. A malformed config value falls back (mode → shadow, list → default, numbers clamped) with a boot warning; an unknown caller `profile` is refused (400 / tool error), never coerced. Degraded briefs are still never cached; the compact text of a degraded brief starts `[brief: degraded; failed: …]`.

## Rollback
`SUBSTRATE_BRIEF_PROFILE=shadow` (or `off`) and a restart of `substrate-mcp` (unit environment; operator step). No cache flush: entries hold sections and serve full again.

## Verify (orchestrator)
```sh
bun test packages/mcp-server/src/brief-profile.test.ts packages/mcp-server/src/mcp.brief.test.ts packages/mcp-server/src/brief-fast-path.test.ts packages/mcp-server/src/brief.test.ts packages/mcp-server/src/cache.test.ts packages/mcp-server/src/memory-expiry-cache.test.ts packages/mcp-server/src/service.test.ts packages/mcp-server/src/http.test.ts packages/mcp-server/src/store-lock.test.ts packages/mcp-server/src/vocabulary-lock.test.ts
bun test packages/observability
bun test scripts/grok-connector-smoke.test.ts
bunx tsc --noEmit
```

## Residual risks
- `brief-fast-path.test.ts` needed no edit by reading, but asserts on cache-call counts (SET counts, generation GETs); not run here. The brief cache now stores a JSON blob of sections (~1.5× the text), so `maxmemory` use per brief entry rises slightly.
- `docs/observability.md` (metric/route table) and `.env.example` are not edited (hot files, merged by the orchestrator); the three metric names and the `served` array belong in that table.
- The `docs`/`recall` estimate sizes `JSON.stringify(reply)`, not the pretty-printed MCP text (an underestimate of a few percent); `memory_search`'s internal recall leg is not counted.
- Zod 4 `z.tuple(...).optional()` and `.refine` on an object schema were written without running tsc; the type casts at the two `parse` boundaries are the places a compiler may disagree.
- Gateway behaviour (no `If-None-Match`, `repo=None`) is unchanged; until it adopts the notes in `docs/grok-bot.md`, compact briefs still lack recent-actions and other-graphs sections.
- Nothing was run (edit-only assignment); all tests are unexecuted.

## Corrections and integration with S4 (uplift-4b merge)
- `docs/observability.md` IS edited (three metric rows in the Instruments table, an "Estimated served tokens per surface" section). `.env.example` is still not edited (see `env-notes/S1.md`).
- Cache cost: the brief cache args now carry `shape: "sections-v1"`, so deploying this is a **cold start for brief entries** (old plain-text entries are never read). Sections are stored as both `lines` and `items`, so a brief value is about 2x the text, and a snapshot (`text` + `sections`) about 3x. This replaces the earlier "~1.5x" estimate.
- `X-Substrate-Brief-Profile` and `structuredContent.profile` appear in every mode (`off` and `shadow` report `full`), not only under `enforce`.
- **S4 agreement.** The snapshot is `{text, at, sections, until}`. S4's `lastGood` returns the ENCODED sections (a snapshot without readable sections, or one that fails `parseSections`, is not a last-good: null, never a synchronous recompose); the background `refresh.load` returns `encodeSections(await compose())`; `refresh.stored` decodes that value and calls `keep(renderFullBrief(sections), sections, until)`, with `until` from the refresh's own lease note. `ageS` is set only by the `served` hook (the stale value really was returned) and is cleared if the value then fails to decode and a live compose is served. The degraded/snapshot path serves `snapshot.text`, the rendered text, never the encoding.
- **Bearer surface.** `briefConditional`/`briefDetailed` take the bearer's surface for `resolveBriefProfile` (REST: the token's surface; MCP: the caller surface), falling back to `request.surface` only for an unauthenticated caller; the body/argument `surface` is attribution (cache key, metric label) as before.
- **Priority** is derived from `BRIEF_SECTION_PRIORITY[section.id]`; the cached form no longer carries a `priority` number (an old or tampered one is stripped on decode).
- **Warning wording:** the malformed `SUBSTRATE_SERVED_TOKENS_PER_HOUR` warning now says "served-tokens objective".
