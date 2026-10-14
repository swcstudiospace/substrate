# S1 — Grok brief contract: compact, state-carrying profile and an estimated-spend SLI

Worktree `/root/src/repos/.wt/u4-s1`, branch `u4/s1`. Evidence: `recon-6-F-grok.md`; spec: S1 in `uplift-4-PROPOSAL.md`.

## Target
`brief.ts`, `brief-profile.ts` (+ test, new), `service.ts` (`briefDetailed`, `briefConditional`), `mcp.ts`, `server.ts` (the `profile` parameter, field and header), `packages/observability/src/instruments.ts`, `slo.ts` (+ tests), `docs/grok-bot.md`; the tests that pin shapes (`mcp.brief.test.ts`, `brief-fast-path.test.ts`).

## Change
1. `BriefProfile = full | compact`; `composeBrief` exposes structural sections (id, priority, lines) from ONE set of reads; `full` byte-identical to today.
2. Compact: state line first, priority-ordered whole lines (graph status, Warnings, Decisions, live/held Nodes ≤ `SUBSTRATE_BRIEF_COMPACT_NODES`=12, recent actions, other graphs), memory lines clipped to `…_MEMORY_CHARS`=240, hard cap `…_BYTES`=3500 on UTF-8 bytes, whole-line truncation from the lowest priority, last line `...omitted: nodes 7, decisions 2 (profile=compact; request profile=full)` (counted in the cap).
3. `SUBSTRATE_BRIEF_PROFILE=off|shadow|enforce` (default shadow); enforce serves compact to `SUBSTRATE_BRIEF_PROFILE_SURFACES` (default `grok-bot,grok-build`, closed against SURFACES) and to `profile: "compact"`; explicit `full` wins; unknown profile = 400 (REST) / tool error (MCP).
4. Cache: the cached value carries the sections, so one entry renders both profiles and no key needs the profile; an old string-shaped value is a miss; ETag per rendered text; state vocabulary unchanged.
5. Wire: additive `profile` in structuredContent + outputSchema, additive `x-substrate-brief-profile` header, `profile` in the REST body and MCP args.
6. Metrics: `substrate.brief.profile_bytes_saved{surface}`, `substrate.brief.profile{surface,profile,mode}`, separate `substrate.served.tokens_est{surface,tool}` (ceil(bytes/4); brief fresh answers, recall, docs; never `substrate.tokens`); `/slo` gains `served` rows per surface against `SUBSTRATE_SERVED_TOKENS_PER_HOUR` (unset = unconfigured).
7. `docs/grok-bot.md`: the profile contract, shadow→enforce procedure, gateway adoption notes.

## Acceptance
Property test (cap, determinism, priority, exact omitted counts); off/shadow byte parity for every surface; enforce compact for grok-bot only, override both ways, distinct ETags, state line only in compact, old string cache entry tolerated, shadow/enforce entries never cross-served, tokens_est for fresh answers and not for not_modified, unknown profile rejected.
