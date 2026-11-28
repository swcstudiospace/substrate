# Phase 103: F4 multi-worktree state sharing — Plan

**Context:** `103-CONTEXT.md` (2026-11-28). Read-only `session_snapshot` over SessionRegistry + live bindings + worktrees, with freshness metadata, repo-allowlist gating, redactor enforcement, labeled degradation. F5 steering reads snapshots; consumers are CLI agents (Omp/Grok Bot); cross-machine sync over link is v2/F8 (out of scope).

## Tracer first

Slice vertically: one read-only `session_snapshot` path end-to-end (parse → allowlist gate → assemble from SessionRegistry/presence/worktrees → redact → freshness/degradation labels) behind a single flag, fake-backed tests only. No mutation surface, no transport, no persistence changes.

## Reusable assets (do not reinvent)

- `packages/mcp-server/src/session-context.ts` — digest assembly, `read()` degradation-as-note pattern, `SESSION_CONTEXT_BUDGET_MS`, byte caps; reuse `SourceResult`/`Read` notes idiom.
- `packages/mcp-server/src/brief-sessions.ts` — per-request live sections, `coarseAge`, redacted-as-data quoting; reuse line/char caps.
- `packages/mcp-server/src/worktree-registry.ts` — `WorktreeRegistryStore`, `parseWorktreeListQuery`, stale/idle semantics; read-only candidate query.
- `packages/mcp-server/src/repo-allowlist.ts` — `repoAllowlistFromEnv` / `assertRepoAllowed`; path-scoped cross-project gate (Phase 72).
- `packages/mcp-server/src/redact.ts` — `redact()` on every string crossing the boundary.
- `packages/mcp-server/src/presence-client.ts`, `session-events.ts` — live bindings liveness + event recency sources.

## Task 1 — `session_snapshot` read API + freshness/degradation contract

**Files:**
- NEW `packages/mcp-server/src/session-snapshot.ts` (types, `parseSessionSnapshotArgs`, `assembleSessionSnapshot`, caps)
- NEW `packages/mcp-server/src/session-snapshot.test.ts` (fake-only: sources as injected fns, no plane clients)
- EDIT `packages/mcp-server/src/index.ts` or tool registry (whichever registers `session_context`; single wiring point only)

**Change:**
1. Define `SnapshotScope = { session_id? | graph_id? | worktree? | repo_id? }`; exactly one selector required, else typed refusal (mirror `parseSessionContextArgs`).
2. Define `SessionSnapshot = { digest, freshness: { asOfMs, ageS, stale: boolean }, sourceRun: { id, hash? } | null, degradation: { label, reason } | null, truncated: boolean }`.
3. `assembleSessionSnapshot(scope, sources, { nowMs, budgetMs, byteCap })`: race each source under one shared deadline (reuse `sharedDeadline` idiom); a missing/slow/rejected source becomes a `degradation` note with `ageS + reason`, never throws, never presents as fresh (`stale: true` when newest source older than TTL or any source failed).
4. Freshness: `asOfMs` = max source timestamp actually read; `ageS` derived from injected `nowMs` (no wall-clock reads inside assembly → deterministic tests); `sourceRun` echoes the run/ledger seq the digest was built from, null with reason when unknown.
5. Enforce caps: per-list limits + JSON byte cap with `DROP_ORDER` reuse from `session-context.ts`; truncated flag when anything dropped.
6. Wire one read-only tool/route `session_snapshot` calling parse → allowlist gate (Task 2) → assemble → redact (Task 2). No mutation, no new env knobs beyond one `SUBSTRATE_SESSION_SNAPSHOT` on/off flag defaulting off (fail-closed, consistent with brief-sessions opt-in).

**Acceptance:**
- One selector returns digest + `asOfMs/ageS/stale=false` + `sourceRun` when all sources answer in budget.
- Any source timeout/rejection → same shape with `stale: true` + `degradation: { label: "stale"|"unreachable"|"partial", reason }`; never throws, never `stale: false`.
- Unknown selector / bad args → typed refusal naming the one-selector rule.
- Flag off → typed `session-snapshot.disabled` refusal before any source read.

## Task 2 — Allowlist gate + redaction boundary

**Files:**
- EDIT `packages/mcp-server/src/session-snapshot.ts` (gate + redaction pass; no separate module)
- EDIT `packages/mcp-server/src/session-snapshot.test.ts` (adversarial cases)
- REUSE `packages/mcp-server/src/repo-allowlist.ts`, `packages/mcp-server/src/redact.ts` (no edits)

**Change:**
1. Before any source read: resolve caller's allowlist session (`repoAllowlistFromEnv`); malformed/empty allowlist grants nothing (fail-closed, Phase 72 semantics). Cross-project `repo_id` not in caller's session → typed `repo-not-allowed` refusal, zero source reads (assert with fake call-count).
2. After assembly, before return: pass every string field (ids, branches, paths, event summaries, handoff goals, directive bodies) through `redact()` + existing `FIELD_MAX`/`TEXT_MAX` truncation; directive bodies quoted as data under a non-executable title (copy `brief-sessions.ts` idiom).
3. Credential rule: snapshot carries state digests, counts, and redacted text only — never credential variable names/values, tokens, or allowlist internals. Gate test asserts refusal bodies contain no secret material.
4. Path scoping: `worktree`/`repo_id` selectors are matched case-insensitively as the brief scopes them; a selector naming a repo outside the allowlist is refused even if the worktree registry holds a row for it.

**Acceptance:**
- Caller with no/malformed allowlist entry → refusal, sources unread (fake counters zero).
- Cross-project read outside allowlist → `repo-not-allowed`, no leakage of whether the target exists.
- Adversarial strings (token-looking, `SUBSTRATE_*`, prompt-injection directives) → redacted/quoted-as-data in output; `redact-adversarial`-style cases pass.
- Secrets audit: snapshot JSON contains no `token|secret|credential|Bearer ` (case-insensitive grep over fixture outputs).

## Verification harness (run once, after both tasks)

```bash
bun test packages/mcp-server/src/session-snapshot.test.ts
bun test packages/mcp-server/src/session-context.test.ts packages/mcp-server/src/brief-sessions.test.ts packages/mcp-server/src/repo-allowlist.test.ts packages/mcp-server/src/worktree-registry.test.ts
grep -rEi 'session_snapshot' packages/mcp-server/src --include='*.ts' -l | grep -v test | grep -v session-snapshot.ts | head  # expect: only tool wiring file
grep -rEi 'token|secret|credential' packages/mcp-server/src/session-snapshot.ts | head  # expect: only comments/tests referencing the rule
```

Fake-only: all sources injected; no plane/DB/network in tests. Existing suites above must stay green (no regressions in digest, brief, allowlist, registry).

## SUMMARY spec

`SUMMARY.md` (written at execution end) must state:
- Tool/route name + flag (`SUBSTRATE_SESSION_SNAPSHOT`), default off.
- Snapshot shape: selector rule, `digest / freshness(asOfMs, ageS, stale) / sourceRun / degradation(label, reason) / truncated`.
- Degradation labels used (`fresh | stale | partial | unreachable | disabled`) and when each fires.
- Allowlist + redaction guarantees (fail-closed, no secrets cross boundary, quoted-as-data).
- What F5 consumes (read API only) and the F8/v2 handoff (link transport, state sync over link — not built here).
- Verification: harness commands + results, files changed.

## Out of scope (do not build)

- Cross-machine transport / state sync over `tools/substrate-link` (v2/F8).
- Any mutation surface (steering injection is F5; in-session recall is F6).
- New persistence, schema migrations, index-plane changes, or env-knob proliferation beyond the single on/off flag.
- Live network/clock-dependent tests; perf tuning beyond the shared budget + caps.
