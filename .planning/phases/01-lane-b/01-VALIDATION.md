---
phase: "1"
slug: "lane-b"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-09-24"
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Seeded from `01-RESEARCH.md` § Validation Architecture, reconciled with the
> locked decisions in `CONTEXT.md` § "Decisions locked during autonomous planning".

---

## Test Infrastructure

Lane B spans five repos with two toolchains; there is no shared root config.

| Property | Value |
|----------|-------|
| **Framework (Python repos)** | pytest, per-repo `.venv` |
| **Framework (TS repos)** | `bun test` + `bunx tsc --noEmit` |
| **Config file** | each repo's own `pyproject.toml` / `package.json` — none shared |
| **Quick run command** | the command for whichever repo the task touched (table below) |
| **Full suite command** | all five quick-run commands, in sequence |
| **Estimated runtime** | < 30 s per repo |

| Repo | Quick run command | Baseline (verified 2026-09-24) |
|---|---|---|
| hermes-plugin | `cd /root/src/repos/hermes-plugin && python3 -m pytest -q` | 234 pass |
| hermes-linear-connector | `cd /root/src/repos/hermes-linear-connector && .venv/bin/python -m pytest -q` | 49 pass / 2 skip |
| hermes-engineering-board | `cd /root/src/repos/hermes-engineering-board && .venv/bin/python -m pytest -q` | 76 pass |
| claude-ultrathink | `cd /root/src/repos/claude-ultrathink && bun test` | 279 pass / **5 fail** ⚠ |
| claude-ultrathink-grok | `cd /root/src/repos/claude-ultrathink-grok && bun test` | 256 pass / **1 fail** ⚠ |

⚠ **Pre-existing red baselines — do not attribute to Lane B.** Both failures are
assertion-count mismatches in `src/claude/hook.test.ts` from a concurrent
session's in-flight work. Per decision D3, `origin/master` was verified clean
this session in a throwaway worktree (`f10e8de`: **256 pass / 0 fail**), so these
are confined to uncommitted work in those two checkouts. A Lane B task must not
"fix" them, and the phase gate compares against the fail *count*, not zero.

---

## Sampling Rate

- **After every task commit:** the quick-run command for the repo that task touched.
- **After every plan wave:** all five quick-run commands in sequence.
- **Before `/gsd-verify-work`:** all green, with the two known baseline failures
  unchanged in count and identity.
- **Max feedback latency:** 30 seconds.

---

## Per-Task Verification Map

> Seeded against the phase's own Success Criteria — no REQUIREMENTS.md exists
> for this project. Task IDs are filled in once plans exist.

| Criterion | Behavior | Test Type | Automated Command | File Exists | Status |
|---|---|---|---|---|---|
| 1 *(re-scoped by D1)* | `on_pre_llm_call` injects the brief **additively**, before uplift, without restructuring the hook | unit (FakeCtx pattern in `test_hook.py`) | `python3 -m pytest tests/test_hook.py -x` | ✅ extend | ⬜ pending |
| 2 *(deferred by D1)* | Kanban retirement is **out of scope** — assert only that `hermes_kanban_create` behaviour is *unchanged* and the connector DoD gate still passes | unit + smoke | `pytest tests/test_kanban.py` + connector `pytest` | ✅ both | ⬜ pending |
| 3 (herdr) | `events.subscribe` collector receives `pane.agent_status_changed` | manual-only until installed | — | ❌ W0 | ⬜ pending |
| 4 (omp / Grok Build / Muse) | each surface's next prompt shows the brief | integration + manual | `swe.test.ts` extension (omp); manual for Grok Build / Muse | ❌ W0 | ⬜ pending |
| 5 (connector v0.4) | four MCP tools forward; `handoff_to_hermes` records a Graph ID | unit | `pytest tests/test_handoff_pack.py` extension | ✅ needs cases | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

**Note on criteria 1-2.** ROADMAP.md states these in terms of a TypeScript-engine
bridge and Kanban retirement. Decision D1 established that premise is wrong —
it cites a shipped milestone that puts Kanban changes out of scope, and the real
redesign belongs to a different, unplanned milestone. Lane B is validated against
the re-scoped behaviour above. Verification must not claim the ROADMAP wording.

---

## Wave 0 Requirements

- [ ] herdr installed (per D2) **and** a collector test harness — neither exists.
      Install method still needs an owner checkpoint before this task runs.
- [ ] A Grok Build delivery-path test — no existing test covers Grok's
      `UserPromptSubmit` stdout-discard behaviour (Finding 4), and the
      `additionalContext` pattern is a no-op there.
- [ ] A Muse `SessionStart` probe (`muse plugins hook test`) to settle Assumption
      A2 before any fallback design depends on it.

---

## Manual-Only Verifications

| Behavior | Criterion | Why Manual | Test Instructions |
|---|---|---|---|
| herdr pane events reach the collector | 3 | herdr not installed; no harness | Install per D2, `herdr api snapshot`, subscribe, drive a pane, observe `pane.agent_status_changed` |
| Grok Build shows the brief | 4 | stdout discarded; delivery is session-file + rules-entry | Start a Grok Build session in a repo with open graphs; confirm the brief appears |
| Muse shows the brief | 4 | no prompt-submission hook exists | Write `.substrate/BRIEF.md`, start Muse, confirm reachability |
| Phase proof — cross-surface | Proof | spans two live agents | Hermes finishes n2 from a Grok Bot handoff; Omp's next prompt lists handoff + claim |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or a Wave 0 dependency
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all ❌ references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] Known baseline failures unchanged in count and identity
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
