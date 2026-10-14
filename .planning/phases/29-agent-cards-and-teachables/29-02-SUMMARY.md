# Phase 29 Plan 02: Agent Card builder plus loopback route Summary

**Status:** complete — every known surface gets a 200 spec-valid card
listing its live teachables; bad input gets 400; locks still green.

## What was built

- `packages/mcp-server/src/agent-card.ts` (new): `buildAgentCard(surface,
  baseUrl, teachables)` returning the A2A v1.0 card (`id`, `name`,
  `description`, `url`, `version`, `supportedInterfaces`, `capabilities`,
  `defaultInputModes`/`defaultOutputModes`, `skills[]`) plus
  `validateAgentCard(card)` returning violation strings (empty = valid).
  One skill entry per teachable: `{ id: <memory id>, name: <slug folded to
  SKILL_NAME_RE>, description: <redacted text capped at 1200 chars>,
  tags: ["teachable"] }`. Slug folding is total — an unusable slug falls
  back to the memory id, never an empty or invalid name — and the
  description re-passes shared `redact.ts` with a non-empty fallback.
- `Substrate.teachablesForSurface(surface)` (`service.ts`): read-only
  `searchMemoryPage` with `subjectPrefix "teachable:"`, filtered to kind
  `fact` + writer === surface via the shared `isTeachable` predicate,
  superseded excluded, newest-first with keyset pagination past the first
  page. No emit, no gate, no cache-bump; unknown surface reads as empty.
- `GET /.well-known/agent-card.json?surface=<name>` (`server.ts`): missing
  `surface` → 400 naming the parameter; unknown surface → 400; else the
  built card as JSON 200. Unauthenticated discovery like `/healthz` — no
  `auditedRest`, no audit record. `KNOWN_ROUTES` in `observe.ts` names the
  route so per-route metrics stay accurate (the `/healthz` treatment).

## Tests

- `agent-card.test.ts` (new, 21 tests): name folding (spaces/slashes/case/
  underscores/length/fallback), description redaction + 1200 cap +
  non-empty fallback, builder validity (populated and empty), loopback URL,
  validator coverage of every CARD-01 field (absent and degraded), reader
  filtering (kind/writer/superseded/newest-first), unknown-surface and
  no-index emptiness, 105-row pagination proving every entry appears once.
- `server.test.ts` (+4 route tests): 200 validator-clean card with the
  stubbed teachable as `skills[0]`; 400 missing/unknown surface; anonymous
  200 on an allowAnonymous harness with tokens configured.

## Verification (all green)

- `bun test agent-card/server/http/service`: 334 pass
- `bunx tsc --noEmit`: clean
- `bun run check:phase-close`: pass — EVENT_KINDS at 12, SURFACES at 27

## Decisions (planner open questions, resolved as executor)

1. **Card `url`**: config-exposed loopback base
   (`http://{config.host}:{config.port}/.well-known/agent-card.json?surface=…`),
   not a relative marker — the deployment knows its host/port and the card
   should name where it is actually served.
2. **observe.ts/audit-policy entry**: no audit entry (read-only discovery,
   `/healthz` class); added to `KNOWN_ROUTES` only, so the route gets its
   own metric series instead of folding into `other`. No `ANONYMOUS_ROUTES`
   change (that set needs no addition for correct counting).
3. **Static preamble skills**: no — teachables only, per the requirement.
4. **Skill-name collisions**: folded slugs that land on the same rule-name (`Retry Budget` and `retry-budget`) keep the first and suffix the rest (`-2`, `-3`, …), still inside `SKILL_NAME_RE`.

**Commit:** b13252b
