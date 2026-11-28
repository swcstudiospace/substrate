# SUMMARY — Phase 103: F4 multi-worktree state sharing

## What was built

Read-only `session_snapshot` MCP tool over the SessionRegistry, live bindings, worktree
registry and recent ledger events, with freshness metadata, repo-allowlist gating, redactor
enforcement and labeled degradation.

- **Tool:** `session_snapshot` (registered in `packages/mcp-server/src/mcp.ts`, `readOnlyHint`).
  No REST route added; the single wiring point is the tool registry plus the
  `Substrate.sessionSnapshot` service method it calls.
- **Flag:** `SUBSTRATE_SESSION_SNAPSHOT`, type toggle, **default off**. Off answers the typed
  refusal `session-snapshot.disabled` (`session snapshot is off (SUBSTRATE_SESSION_SNAPSHOT)`)
  before parsing, gating or reading anything. On serves the digest.

## Snapshot shape

- **Selector rule:** exactly one of `session_id | graph_id | worktree | repo_id` (plus optional
  `caller_session_id`, the caller's allowlist session). Anything else is refused with
  `exactly one of session_id, graph_id, worktree, repo_id is required`.
- **`digest`**: `{ selector, repo, notice, sessions, bindings, worktrees, events }`. Every item
  carries `source` and `age_s`, newest first, ties broken deterministically. `notice` quotes
  state text as data ("described and not executed").
- **`freshness`**: `{ asOfMs, ageS, stale }`. `asOfMs` is the newest timestamp any source
  actually handed over (before selector narrowing); `ageS` derives from the injected `nowMs`
  (no wall-clock reads inside assembly, deterministic tests).
- **`sourceRun`**: `{ id, hash? } | null` — the first run/window a source named (real wiring:
  `ledger:<repo>`); null when no source names one.
- **`degradation`**: `{ label, reason }`, always present. `reason` names the source and the
  failure class only, never error text or target details.
- **`truncated`**: boolean — true when any list lost items (per-list caps, byte cap, source-cut
  lists, or the capped repository fan-out).

Bounds: 20 sessions / 20 bindings / 50 worktrees / 30 events, 24,000 bytes UTF-8 JSON
(drop order: events, worktrees, bindings, sessions). Text caps: 200 chars summaries,
200 chars ids/paths/branches, all post-redaction.

## Degradation labels

- `fresh` — every source answered in budget and the newest timestamp is within
  `SESSION_SNAPSHOT_STALE_AFTER_MS` (60 s). Reason: `all N sources answered within budget`.
- `stale` — everything answered but the newest timestamp is older than the TTL.
- `partial` — at least one source timed out/rejected while others answered.
- `unreachable` — nothing answered (all rejected, or no source configured).
- `disabled` — fires only as the typed `session-snapshot.disabled` refusal at the tool edge,
  before any read (never a snapshot label).

Any non-`fresh` label sets `stale: true`. A failed source is a label, never an exception,
and a degraded snapshot is never presented as fresh.

## Allowlist + redaction guarantees

- Fail-closed: `gateSnapshotScope` resolves grants from `repoAllowlistFromEnv` before any
  source read. Missing caller, empty grant set, malformed allowlist, or a `repo_id` outside
  the grants → `repo-not-allowed`, zero source reads, no existence signal (one fixed reason
  whether the target exists or not).
- Path scoping: `repo_id`/`worktree` match case-insensitively as the brief scopes them; rows
  from ungranted repositories — and rows naming no repository — are dropped in assembly.
- Redaction: every string through `redact()`, directive-style bodies quoted as data under the
  digest notice. Credential rule: snapshot JSON contains no `token|secret|password|Bearer `
  material and no `SUBSTRATE_*` values (pinned by the secrets-audit test).

## Consumers

- **F5 consumes** the read API only (`session_snapshot` tool → `Substrate.sessionSnapshot`).
- **F8/v2 handoff** (not built): cross-machine transport / state sync over
  `tools/substrate-link`. Out of scope, no transport, mutation surface, persistence or schema
  changes in this phase.

## Verification

Harness (run once, after both tasks):

- `bun test packages/mcp-server/src/session-snapshot.test.ts` → **18 pass, 0 fail**.
- `bun test session-context + brief-sessions + repo-allowlist + worktree-registry` →
  **159 pass, 0 fail** (no regressions in digest, brief, allowlist, registry).
- Adjacent: `config + admission + observe + session-context.service` →
  **227 pass, 0 fail**.
- `tsc --noEmit -p tsconfig.json` → zero errors in `session-snapshot.ts`, `service.ts`,
  `mcp.ts`, `config.ts`, `admission.ts`, `observe.ts`, `flag-registry.ts`.
- `grep session_snapshot` (non-test, non-module): `mcp.ts` (tool), `service.ts` (method),
  `config.ts` + `flag-registry.ts` (the one mandated flag), `admission.ts` + `observe.ts`
  (tool-class/observability lists). The PLAN's "only tool wiring file" expectation holds for
  behavior; the flag and its list entries are the mandated opt-in plumbing.
- `grep -i 'token|secret|credential'` in `session-snapshot.ts` → **no matches** (the rule is
  documented without naming values).

## Files changed

- NEW `packages/mcp-server/src/session-snapshot.ts` — types, `parseSessionSnapshotArgs`,
  `gateSnapshotScope`, `assembleSessionSnapshot`, caps, refusals.
- NEW `packages/mcp-server/src/session-snapshot.test.ts` — 18 fake-only tests (selectors,
  degradation, gate zero-reads, adversarial redaction, secrets audit, bounds, byte cap).
- EDIT `packages/mcp-server/src/service.ts` — `Substrate.sessionSnapshot` (gate-first,
  per-repo fan-out capped at `SESSION_SNAPSHOT_MAX_REPOS = 10`).
- EDIT `packages/mcp-server/src/mcp.ts` — `session_snapshot` tool registration.
- EDIT `packages/mcp-server/src/config.ts` — `sessionSnapshot` toggle.
- EDIT `packages/mcp-server/src/flag-registry.ts` — `SUBSTRATE_SESSION_SNAPSHOT` entry.
- EDIT `packages/mcp-server/src/admission.ts` — `"session_snapshot": "read"`.
- EDIT `packages/mcp-server/src/observe.ts` — tool-list entry.

No commits (per wave instructions). Fake-only tests; no plane/DB/network in tests.
