---
phase: 40-docs-memory
verified: 2026-10-21
status: human_needed
score: criteria 1 and 3 accepted (criterion 3 as narrower scope, by the owner on 2026-10-22); criterion 2 open, blocked on the operator restore drill and approval
verified_on: gsd/v13x-40-docs-memory, two commits on origin/main acb6767 (PR #91). Full suite and typecheck run on the tree after the doc and comment edits, before the records were committed
covered_files: ["packages/mcp-server/src/memory-recall.ts", "packages/mcp-server/src/recall-snapshot.ts", "packages/mcp-server/src/brief.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/cache.ts", "packages/mcp-server/src/brief-recall.test.ts", "packages/mcp-server/src/brief-recall-fanout.test.ts", "packages/mcp-server/src/mental-model-refresh.ts", "packages/mcp-server/src/mental-model-refresh.test.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/config.test.ts", "packages/mcp-server/src/planes/hindsight.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/event-sources.ts", "packages/mcp-server/src/flag-registry.ts", "docs/data-planes.md", "docs/memory-governance.md", "docs/config-reference.md", "docs/event-vocabulary.md", "docs/runbooks/memory-mcp-retirement.md"]
---

> Status detail, kept verbatim from the original frontmatter: partial. Criterion 1 proven in-repo, no live effect yet. Criterion 2 blocked on a restore drill and approval. Criterion 3 not met as written. The closed-set value is gaps_found because criterion 3 is a gap as written; criterion 2 stays operator-gated.
> Owner decision, 2026-10-22: criterion 3 accepted as narrower scope (a weekly refresh of config-named mental models through the refresh endpoint, without reflect). The status is human_needed because criterion 2 needs the operator's restore drill.

# 40-VERIFICATION: DOCS-MEMORY

## Proven in-repo

| Claim | Evidence |
|---|---|
| Typecheck is clean | `bunx tsc --noEmit` on the phase tree: exit 0 |
| Full suite passes | `bun test` with `SUBSTRATE_TEST_PG_URL` on the verification Postgres: 5774 pass, 2 skip (`cache-conformance.test.ts:127`, `redact.test.ts:813`, both pre-existing), 0 fail. 5776 tests in 214 files, 168 s, no `ENOSPC` |
| Targeted suites pass | Before the full run, 609 pass across the brief, recall, memory-recall, cache, config, flag-registry, event-sources, vocabulary-lock and config-reference tests |
| Fan-out key and cap | `brief-recall-fanout.test.ts`; `brief-recall.test.ts` cases A to J on the new contract |
| Mental-model refresh | `mental-model-refresh.test.ts`; `config.test.ts` `HINDSIGHT_MENTAL_MODELS` block; the event-catalog and vocabulary-lock tests |

## Live checks made on 2026-10-21 (read-only)

| Check | Result |
|---|---|
| `substrate-mcp` service | active; health planes greptime, index, cache, hindsight, ragflow all `ok`, breakers closed |
| TCP reachability of configured endpoints | Hindsight, Greptime, Dragonfly, Timescale and RAGFlow all open |
| Hindsight API (`/v1/default/banks`) | 200; 11 banks; default bank `ultrathink` present |
| Production recall settings | `SUBSTRATE_BRIEF_RECALL` unset (default off); `HINDSIGHT_BANKS` unset; `HINDSIGHT_MENTAL_MODELS` unset |
| Retain outbox | `SUBSTRATE_RETAIN_OUTBOX_PATH` set; the outbox file is absent, so nothing is parked |

## Not proven (not run)

- Fan-out under `enforce` against the live VPS.
- A mental-model refresh against Hindsight.
- The restore drill for the D-D3 retirement.
- The retirement itself. It needs the drill and operator approval.

## Success criteria

| # | ROADMAP criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | D-D1: cross-surface recall in the brief is a bounded, cached fan-out over the `sub-*` banks | PASS in-repo. No live effect: recall is off and `HINDSIGHT_BANKS` is empty on the server | the fan-out tests above; the live settings table |
| 2 | Claude Code's `hindsight` MCP and Hermes supermemory retired once the `sub-*` banks answer, restore routes recorded first | NOT MET. Restore routes are recorded in `docs/runbooks/memory-mcp-retirement.md`. The drill and approval are pending. Not every `sub-*` bank answers: `sub-grok-bot` is absent from the VPS bank list, and Hermes supermemory has no configured integration here | runbook; the Hindsight bank check |
| 3 | A weekly `reflect` per bank: mental models replace stale detail | NOT MET as written. Shipped: a weekly refresh of config-named models through the refresh endpoint. `reflect` is not used because it persists nothing. Accepting the narrower scope is the user's call | `mental-model-refresh.test.ts`; SUMMARY deviations |

## Requirement coverage re-verification (2026-10-24)

Scope: D-D4 (`.planning/REQUIREMENTS.md:34`). Checked against worktree HEAD bdcc798. Tests were not run in this task; the orchestrator runs them. Every path and line below was read before it was cited.

### D-D4: mental models replace stale detail

- ROADMAP criterion 3 (`.planning/ROADMAP.md:571`), quoted: "A weekly refresh of the config-named mental models through the refresh endpoint, without `reflect`: mental models replace stale detail (`data-planes.md:27,39`). The owner accepted this narrower scope on 2026-10-22 (see phases/40-docs-memory/VERIFICATION.md frontmatter), which supersedes the original weekly `reflect` wording."
- Scope record: the owner accepted the narrower scope on 2026-10-22, as the frontmatter above records. ROADMAP criterion 3 at `:571` states the narrowed wording. `.planning/ROADMAP.md:93` gives 2026-10-23 for an "accepted as debt" entry. That entry is a separate phase-level acceptance; the two dates are not reconciled here. [INFERENCE] the 2026-10-23 entry is not the criterion-3 scope decision.
- Implementing code:
  - `packages/mcp-server/src/config.ts:2126` `loadMentalModelConfig`, which parses `HINDSIGHT_MENTAL_MODELS`.
  - `packages/mcp-server/src/mental-model-refresh.ts:23` `REFRESH_INTERVAL_MS`, seven days.
  - `packages/mcp-server/src/mental-model-refresh.ts:82-91` `start` and `stop`, the timer with no pass at boot.
  - `packages/mcp-server/src/mental-model-refresh.ts:129` the POST to `.../mental-models/<id>/refresh`. The refresh endpoint is used; `reflect` is not.
  - `packages/mcp-server/src/index.ts:187-193` builds the refresh from the config-named models and starts it; no timer is set when no model is named.
- Tests:
  - `packages/mcp-server/src/config.test.ts:542` describe "HINDSIGHT_MENTAL_MODELS"; `:543` "unset names no model and warns about nothing"; `:547` "a valid entry is kept and an invalid entry is dropped, with the valid ones still applying"; `:561` "at most 20 models, and a repeated model is dropped with a warning"
  - `packages/mcp-server/src/mental-model-refresh.test.ts:101` describe "the weekly mental-model refresh"; `:110` "models named: the timer is seven days out, and no pass runs at boot"; `:128` "each named model is refreshed once per run, with the confirmed POST"; `:141` "a failing model does not stop the others, and each outcome gets one ledger note"; `:210` "the plane is unconfigured: each model is recorded failed as unconfigured, with no call"
- Evidence status: in-repo proven for the narrowed scope in criterion 3. Code and tests were both found. The criterion as originally written (a weekly `reflect` per bank) is not met, and the phase VERIFICATION records that.
- Live proof remaining: `PENDING_VALIDATION`. Operator check, on the VPS: confirm `HINDSIGHT_MENTAL_MODELS` names the intended bank and model pairs (read the variable's name and count only, never print the plane key). After the first scheduled pass, seven days after start, confirm the ledger shows one note per named model with an accepted or failed outcome. No refresh against Hindsight has been run here.
