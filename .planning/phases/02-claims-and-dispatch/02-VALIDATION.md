---
phase: "2"
slug: "claims-and-dispatch"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-09-24"
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Seeded from `02-RESEARCH.md` § Validation Architecture, reconciled with the
> locked decisions D-01..D-16 in `02-CONTEXT.md`.

---

## Test Infrastructure

Phase 2 touches one TypeScript package, adds one Python package, and may touch
`hermes-linear-connector` (only if the D-06 routing decision adds an endpoint there).

| Property | Value |
|----------|-------|
| **Framework (TS)** | `bun test` (repo root) + `bunx tsc --noEmit`, colocated `packages/mcp-server/src/*.test.ts` |
| **Framework (Python, new)** | pytest via uv, `packages/dispatcher/` (new `pyproject.toml`, `src/` layout, `pythonpath=["src"]`) |
| **Config file** | `package.json` / `tsconfig.json` (existing); `packages/dispatcher/pyproject.toml` — none yet, Wave 0 creates it |
| **Quick run command** | the targeted test file for the task (table below) |
| **Full suite command** | `cd /root/src/repos/agent-substrate && SUBSTRATE_DISABLED=1 /root/.local/share/reflex/bun/bin/bun test && uv run --project packages/dispatcher pytest -q` (+ connector pytest if touched) |
| **Estimated runtime** | < 30 s per suite |

| Repo / package | Quick run command | Baseline (measured 2026-09-24, 02-RESEARCH.md Q9) |
|---|---|---|
| agent-substrate (TS) | `cd /root/src/repos/agent-substrate && SUBSTRATE_DISABLED=1 /root/.local/share/reflex/bun/bin/bun test` | **76 pass / 0 fail**, 8 files |
| agent-substrate dispatcher (Python) | `cd /root/src/repos/agent-substrate && uv run --project packages/dispatcher pytest -q` | does not exist yet — Wave 0 |
| hermes-linear-connector (only if touched by D-06) | `cd /root/src/repos/hermes-linear-connector && .venv/bin/python -m pytest -q` | **49 passed / 2 skipped / 0 failed** (branch `master`) |

Both measured baselines are green, so the gates are "stay green + new tests pass".
The Phase 1 two-sided rule still applies: re-measure immediately before the first
edit in each repo; if another session has turned a suite red in the meantime, record
the failing node ids and gate two-sided against them — do not repair them.

---

## Sampling Rate

- **After every task commit:** the targeted test file for the touched module.
- **After every plan wave:** full `bun test` + `bunx tsc --noEmit` + dispatcher pytest (+ connector pytest if touched).
- **Before `/gsd:verify-work`:** all suites green against the baselines above, plus the live proof recorded in `02-PROOF.md`.
- **Max feedback latency:** 30 seconds.

---

## Per-Task Verification Map

> No REQUIREMENTS.md exists. Rows are keyed to ROADMAP success criteria (SC-1..SC-3,
> Proof) and CONTEXT decisions. Task IDs are filled in once plans exist.

| Behavior | Criterion / Decision | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---|---|---|---|---|---|---|---|
| Claim mirrors to Linear: one `issueUpdate` with `stateId` (In Progress, resolved by name per team), `addedLabelIds` [agent:<surface>], `removedLabelIds` [dispatch:*]; never `labelIds`; one-line comment carries the session id | SC-1, D-01, D-03 | T-2-05 | labels changed additively only | unit (injected fetch) | `bun test packages/mcp-server/src/mirror.test.ts` | ❌ W0 | ⬜ pending |
| Claim mirrors to Notion: `PATCH /v1/pages/{id}` sets `Agent` = surface | SC-1, D-01 | — | key never logged | unit (injected fetch) | `bun test packages/mcp-server/src/mirror.test.ts` | ❌ W0 | ⬜ pending |
| Label create-or-reuse: reuse team or workspace `agent:<surface>` label; create only when absent | D-03 | — | N/A | unit | `bun test packages/mcp-server/src/mirror.test.ts` | ❌ W0 | ⬜ pending |
| Losing claimer → `claimed:false` + node, zero Linear/Notion calls | SC-1, D-04 | — | N/A | unit | `bun test packages/mcp-server/src/service.test.ts` | ✅ extend | ⬜ pending |
| Mirror failure → index claim still `claimed:true`, `warning` event names graph_id/node_id/target; re-claim retries idempotently | D-02 | — | fail open, no rollback | unit | `bun test packages/mcp-server/src/service.test.ts` | ✅ extend | ⬜ pending |
| null `linear_issue_id` / `notion_page` → warning event, no throw | D-02, D-16 | — | N/A | unit | `bun test packages/mcp-server/src/service.test.ts` | ✅ extend | ⬜ pending |
| Release → Linear Todo, `removedLabelIds` agent:<surface>, Notion `Agent` cleared, `release` event with graph_id/repo/node_id | SC-2, D-05, D-08 | T-2-03 | only the claim holder may release (if ownership check adopted) | unit | `bun test packages/mcp-server/src/service.test.ts` | ✅ extend | ⬜ pending |
| Complete → Linear In Review; Done only through the connector DoD gate; DoD not passed → `{completed:false, reason}` and issue stays In Review; `complete` event | SC-2, D-06, D-07, D-08 | T-2-06 | gate not re-implemented or bypassed | unit (mock :8792) | `bun test packages/mcp-server/src/service.test.ts` | ✅ extend | ⬜ pending |
| `graph_complete` writes only Notion Status / Linear State / Completed — never PR URL, PR #, PR State, Repo, Branch | D-07 | — | N/A | unit | `bun test packages/mcp-server/src/mirror.test.ts` | ❌ W0 | ⬜ pending |
| `EVENT_KINDS` accepts `release` and `complete`; existing hash vectors unchanged | D-08 | — | hash chain intact | unit | `bun test packages/mcp-server/src/event.test.ts` | ✅ extend | ⬜ pending |
| Reverse lookup Linear issue → (graph_id, node_id, repo) | SC-3 | T-2-07 | only registered nodes dispatchable | unit | `bun test packages/mcp-server/src/service.test.ts` | ✅ extend | ⬜ pending |
| Dispatcher poll filter: unstarted + `dispatch:*`, every 30 s | SC-3, D-10 | — | N/A | unit (fake Linear) | `uv run --project packages/dispatcher pytest -q` | ❌ W0 | ⬜ pending |
| Non-hermes `dispatch:<surface>` → exactly one comment across repeated polls, nothing launched | D-11 | — | N/A | unit | `uv run --project packages/dispatcher pytest -q` | ❌ W0 | ⬜ pending |
| Worktree at `/var/lib/substrate/worktrees/<graph_id>` on `substrate/<graph_id>`, reused; refused under 5 GB free; graph_id validated `^[A-Za-z0-9._-]+$` | D-12 | T-2-02 | no path traversal / ref injection | unit (tmp git repo, fake disk_usage) | `uv run --project packages/dispatcher pytest -q` | ❌ W0 | ⬜ pending |
| Launch is `hermes chat --query-file` with a fixed-template prompt (claim first, graph_id/node_id/identifier only, no issue body), cwd = worktree; never `dispatch_handoff_to_hermes.sh` | D-13 | T-2-01 | no untrusted issue text in the prompt | unit | `uv run --project packages/dispatcher pytest -q` | ❌ W0 | ⬜ pending |
| At most 2 concurrent sessions, one per issue; no claim in 10 min → comment + remove `dispatch:` label, no retry | D-14 | T-2-04 | bounded sessions | unit (fake clock) | `uv run --project packages/dispatcher pytest -q` | ❌ W0 | ⬜ pending |
| `SUBSTRATE_DISPATCH_DISABLED=1` → poll loop launches nothing; unit stop ends sessions | D-15 | T-2-04 | kill switch | unit + systemd smoke | `uv run --project packages/dispatcher pytest -q` + `systemctl is-active substrate-dispatcher` | ❌ W0 | ⬜ pending |
| MCP streamable-HTTP SSE response parsing (`data:` line → `content[0].text`) | SC-3 | — | N/A | unit | `uv run --project packages/dispatcher pytest -q` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `LINEAR_API_KEY` present in `/etc/substrate/substrate.env` (copied from `/root/.config/hermes-linear/connector.env` without printing it); verified by `sudo grep -c '^LINEAR_API_KEY=' /etc/substrate/substrate.env` = 1.
- [ ] `NOTION_API_KEY` present in `/etc/substrate/substrate.env` — **human action**: create a Notion internal integration, share the "🧩 Agent Task Graph" data source with it, add the token. No Notion token exists on the host today.
- [ ] Notion data-source schema read once the token exists: exact types/options of `Agent`, `Status`, `Linear State`, `Completed` pinned in the plan that builds `notion.ts`.
- [ ] D-06 routing decision recorded (research Open Question 1: (a) substrate-side check + `/v1/mark-dod`, (b) new connector endpoint applying `require_dod_for_done`, (c) unlinked issues never auto-close).
- [ ] `packages/dispatcher/pyproject.toml` + `tests/` skeleton; `packages/mcp-server/src/mirror.test.ts` with fetch injection.
- [ ] Reverse lookup (Linear issue → graph node) available to the dispatcher.

---

## Manual-Only Verifications

| Behavior | Criterion | Why Manual | Test Instructions |
|---|---|---|---|
| Phase proof: label a NEW throwaway issue `dispatch:hermes` on a NEW graph for `swcstudiospace/agent-substrate` → Hermes session starts in the per-graph worktree, claims the node, Linear shows In Progress + `agent:hermes` + session comment, Notion Issue row shows Agent hermes, Claude Code's brief shows the claim within 60 s | Proof, D-16 | spans live Linear, live Notion, a live Hermes model session, and a Claude Code prompt | Record timestamps for label, launch, claim, Linear state, Notion row, brief line in `02-PROOF.md`. If the Hermes model session cannot be run, record it as a human check — never assert it ran. |
| Notion token creation and DB share | Wave 0 | requires a Notion workspace admin | Create the integration, share the Agent Task Graph data source, add `NOTION_API_KEY` to substrate.env, restart `substrate-mcp`. |
| Claude Code brief shows the claim | Proof | needs an interactive Claude Code prompt | Start Claude Code in `agent-substrate`; check the uplift echo lists the `claim` event (surface hermes) — the per-surface "started by" line appears only when the session is scoped to that graph (02-RESEARCH.md finding 5). |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or a Wave 0 dependency
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all ❌ references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] Baselines re-measured before first edit; any pre-existing red gated two-sided
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
