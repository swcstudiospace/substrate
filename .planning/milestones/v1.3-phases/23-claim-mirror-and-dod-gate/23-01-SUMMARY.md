# 23-01 SUMMARY — Leaf clients and gate config

Wave 1 (MIRROR-01, MIRROR-06). Commit `feat(23-01)` on `gsd/v1.3-p23-claim-mirror`.

## What landed

- `packages/mcp-server/src/linear.ts` — ported from `acc30a8` with D23-06
  adaptation: `issueContext` fetches `position`; `firstStartedStateId` /
  `firstUnstartedStateId` pick lowest-position started/unstarted;
  `inReviewStateId` resolves a `started` state named "In Review"
  case-insensitively and throws on absence; no resolver returns a `completed`
  id. Kept: 5 s timeout on injected `fetchImpl`, raw `Authorization: <key>`,
  status + ≤200-char redacted errors, additive-only `updateIssue` (no
  `labelIds` param), `ensureLabel` team → workspace → create with re-search and
  per-`teamId:name` cache. Exports `LINEAR_API_URL`.
- `packages/mcp-server/src/notion.ts` — September rules unchanged (D23-10):
  `Notion-Version 2025-09-03`, `NOTION_WRITABLE` exactly Agent/Status/
  Linear State/Completed refused pre-request, GET-before-PATCH with
  dash/case-insensitive data-source gate, type-shaped values. Exports
  `NOTION_API_URL` (new; default base URL).
- `packages/mcp-server/src/config.ts` — `hermesLinearUrl` (default
  `http://127.0.0.1:8792`, slash-trimmed), `dodGateTimeoutMs` (default 35000,
  positive-finite else default), `linearApiUrl` / `notionApiUrl` overrides
  defaulting to production endpoints. Existing key parsing untouched.
- Tests: new `linear.test.ts` (position/type resolution, missing-Review
  failure, completed refusal, redaction, additive signature, label priority +
  cache, endpoint default); ported `notion.test.ts`; extended `config.test.ts`.

## Evidence

- `bun test linear.test.ts notion.test.ts config.test.ts` — 60 pass, 0 fail.
- `bunx tsc --noEmit` — clean (after `bun install --force` linked the
  `packages/ledger` workspace; 3 pre-existing `@substrate/ledger` errors gone).
- `bun test store-lock.test.ts` — 18 pass (no literal token shape added).

## Notes for later waves

- `MirrorContext` (23-02) should carry scalar `linearRef`/`notionPage`, not the
  node object, to keep the no-lease-id rule structural.
- `mirror.failed` sample in `event-sources.ts` uses `op: "comment"`; the D23-18
  op set is claim|steal|release|expire|force|review|done|close — drift fix
  belongs to 23-06 (table + doc together).
