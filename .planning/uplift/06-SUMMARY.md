# Uplift 06 SUMMARY — Knowledge freshness automation

**Graph:** `ut-mv5r71hp-65f7b012` · **Plan:** `06-PLAN.md` · **Refs:** SPE-10477 · **Date:** 2026-10-13

## What shipped

- **skills-sync trigger** (`projector/src/skills-sync.ts`): after a successful fast-forward (decision `ff`, post-projection), one bounded (3 s timeout) `POST {dataset: "agent-skills", commit, content_sha256}` to `<SUBSTRATE_URL>/docs/merge-trigger` with the projector's bearer. Env read at call time (D19-04 idiom); no `SUBSTRATE_TOKEN` → null-block silent no-op. Result-shaped, never throws: any failure costs exactly one redacted `[skills-sync] docs refresh not triggered: <reason>` stderr line; the tick still returns `{decision:"ff", code:0}`. Non-`ff` decisions (warn/dirty/diverged) fire nothing.
- **Route** (`mcp-server/src/server.ts`): `POST /docs/merge-trigger` — 401 untokened before body read (holds even under `SUBSTRATE_ALLOW_ANONYMOUS=1`); 403 non-loopback remote via exported `isLoopbackRemote` (127/8, `::1`, `::ffff:`-mapped); 400 on non-object body / unknown dataset (validated against `DATASET_TRIGGERS`) / missing `commit` or `content_sha256`. Default dataset `agent-substrate` (the post-merge hook), body may name another known dataset. Calls the existing `refreshDataset` (redaction/refusal rules by construction); per-server version store mirrors `docsIngestSeen`.
- **Idempotency**: a trigger whose `commit+content_sha256` equals the newest recorded version answers `200 {ok:true, version, created:false, idempotent:true}` without a second version — retries dedupe by content hash.
- **Replies**: `200 {ok, version, created}`; `503 {ok:false, reason}` on plane refusal (await timeout-bounded, never hangs); `200 {ok, dataset, noop:true, reason:"docs-plane-unconfigured"}` under the null-block.
- **Audit**: registered via `auditedRest(…, "docs_ingest", …)` — the fail-closed decision for the write it performs, keeping `policy.test.ts` green without touching `packages/audit`. Not in `ANONYMOUS_ROUTES`. `docs-datasets.ts` unchanged (reuse, per plan).

## Recorded tradeoffs

- **22-01 grep gate superseded:** the one-shot gate had pinned the literal `SUBSTRATE_TOKEN` out of `skills-sync.ts`; U6's plan requires the projector's surface token here. Enforced gates stay green (`store-lock`'s TOKEN_LITERAL matches values only — env read at call time is exempt; childEnv git allowlist untouched).
- **Metrics bucket:** the route was deliberately not added to `observe.ts` `KNOWN_ROUTES` (folded into the bounded `other` series) in that pass; a follow-up adds the one-line registration + lock update if per-route series is wanted.

## Verification (exercised)

- `bun test packages/projector packages/mcp-server` — 0 fail (route 401/403/400 paths; refresh invoked with dataset + hash; unconfigured no-op; fast-forward fires exactly one POST; dirty-tree fires none; POST failure never fails the sync)
- `bun run check:phase-close` — pass (all locks green, vocabulary unchanged); `bunx tsc --noEmit` clean
