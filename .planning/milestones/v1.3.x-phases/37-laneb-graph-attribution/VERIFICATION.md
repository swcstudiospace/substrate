---
phase: 37-laneb-graph-attribution
verified: 2026-11-12T08:36:03Z
status: human_needed
score: 6/8 must-haves verified in code and tests; 2 live checks not run (operator-gated)
behavior_unverified: 0
overrides_applied: 0
covered_files: ["packages/collectors/src/herdr-map.ts", "packages/collectors/src/herdr-state.test.ts", "packages/collectors/src/herdr-state.ts", "packages/collectors/src/herdr.test.ts", "packages/collectors/src/herdr.ts", "packages/collectors/src/muse-etag.test.ts", "packages/collectors/src/muse.ts", "packages/collectors/src/worktree-graph.test.ts", "packages/collectors/src/worktree-graph.ts", "packages/mcp-server/src/brief.ts", "packages/mcp-server/src/server.ts"]
covered_digest: "v3:sha256:26b5985e20a602e7b2374987a5adfb5e119e149907e579e49672b2e263147c9f"
human_verification:
  - test: "Redeploy the collectors to a Lane B host that creates dispatcher worktrees, run a herdr pane inside /var/lib/substrate/worktrees/<graph_id>, then read that graph's /brief and /events evidence on the live server"
    expected: "session.start carries graph_id; the event and the brief for that graph appear without the agent passing an id"
    why_human: "Live host deploy is operator-gated (STATE.md run rules); no live server run was made"
  - test: "On a host with a real worktree directory, run Muse pass() against a git repo inside that worktree and capture the /brief request body; repeat for a repo outside any worktree"
    expected: "The body carries graph_id for the worktree repo and no graph_id for the other"
    why_human: "The pass() call site was verified by reading and type check only; no real worktree exists on this host"
---

# Phase 37: LANEB Verification Report

**Phase Goal:** Lane B events for a worktree reach that graph's brief and evidence without agents passing ids.
**Verified:** 2026-11-12T08:36:03Z
**Status:** human_needed
**Re-verification:** Yes. Fresh re-run of gsd-verifier; replaces the 2026-10-21 record. Code checked at HEAD af4c4278.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | A worktree path names its graph (first segment under the root); root, sibling, traversal, relative and non-plain segments name none | ✓ VERIFIED | `worktree-graph.ts:37-52` (`graphIdForWorktree`, `graphIdUnder`); `worktree-graph.test.ts` passes |
| 2 | Herdr session.start, note and session.end events carry the pane's graph_id | ✓ VERIFIED | `herdr-state.ts:234` (`recordFor` sets `graph_id`), `herdr-state.ts:146` (restore), `herdr-map.ts:157` (`transitionToEvent` copies it); "a graph named at start stays on the pane record…" passes |
| 3 | One session, one graph: a graph change ends the session (`graph_changed`) and starts a new one; a no-directory snapshot keeps the session | ✓ VERIFIED | `herdr-state.ts:346-353`; "one session, one graph" tests (4) pass in `herdr-state.test.ts` |
| 4 | Git attribution runs only on transitions; steady snapshots run no Git | ✓ VERIFIED | `herdr-state.ts:208-210` (pure `graphOfPane`), `herdr-state.ts:217-220` (attribution helper), `:361` (called only on transition); "a pane that stays put is attributed once…" passes |
| 5 | Muse's brief request sends graph_id only when inferred from the repo root | ✓ VERIFIED | `muse.ts:196-201` (body with conditional spread), `muse.ts:405` (`graphIdForWorktree(repo)`); "the graph on the brief request" passes (`muse-etag.test.ts:184-185`) |
| 6 | Server contract unchanged: /brief keys on graph_id; /events stores it | ✓ VERIFIED (by read) | `mcp-server/src/brief.ts:249`, `server.ts:1249`, `server.ts:1266`; not modified in this phase |
| 7 | Lane B events reach the graph's brief and evidence without agents passing ids (roadmap SC1, end to end) | ? UNCERTAIN, live not run | Collector side verified (truths 1–6). No live server round trip was run; see Human Verification 1 |
| 8 | pass() infers the graph from a real worktree directory end to end | ? UNCERTAIN, live not run | Call site at `muse.ts:405` verified by read and types; no real `/var/lib/substrate/worktrees/<graph_id>` on this host; see Human Verification 2 |

**Score:** 6/8 truths verified (2 live checks not run; no truth failed)

### Deferred Items

None.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/collectors/src/worktree-graph.ts` | Pure graph-from-path helper | ✓ VERIFIED | Exports `WORKTREE_ROOT`, `graphIdForWorktree`, `worktreeRoots`. Now also reads `SUBSTRATE_WORKTREE_ROOTS` (see Info) |
| `packages/collectors/src/herdr-state.ts` | `graphOfPane`, graph boundary, record field | ✓ VERIFIED | `:31-32`, `:77-78`, `:208-210`, `:346-353` |
| `packages/collectors/src/herdr-map.ts` | `HerdrTransition.graph_id`, `graph_changed` | ✓ VERIFIED | `:99`, `:111`, `:157` |
| `packages/collectors/src/herdr.ts` | `attributePane` returns repo and branch only | ✓ VERIFIED | `:34-38` |
| `packages/collectors/src/muse.ts` | `fetchBrief(..., graphId)` | ✓ VERIFIED | `:194-201`, `:405` |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| herdr-state.ts `recordFor` | worktree-graph.ts `graphIdForWorktree` | `graphOfPane` | ✓ WIRED | `herdr-state.ts:17, 209-210` |
| herdr-state.ts transitions | herdr-map.ts `transitionToEvent` | `graph_id` on `HerdrTransition` | ✓ WIRED | `herdr-state.ts:234, 246`; `herdr-map.ts:157` |
| muse.ts `pass` | `fetchBrief` body | `graphIdForWorktree(repo)` | ✓ WIRED (by read) | `muse.ts:31, 405, 201` |
| collectors | server `/brief`, `/events` | `graph_id` field | ✓ WIRED (by read) | `brief.ts:249`, `server.ts:1266` |

### Data-Flow Trace (Level 4)

Skipped: no UI or dynamic rendering. Event payload flow is covered by truth 2.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Graph helper, herdr state (one-session-one-graph, steady-snapshot), graphOfPane, Muse brief body, herdr transport, herdr-map | `bun test packages/collectors/src/worktree-graph.test.ts packages/collectors/src/herdr-state.test.ts packages/collectors/src/muse-etag.test.ts packages/collectors/src/herdr.test.ts packages/collectors/src/herdr-map.test.ts` | 46 pass, 0 fail, 261 expects, 5 files | ✓ PASS |
| Full repository suite against Postgres | not run | — | ? SKIP (not run this pass) |
| Loopback smoke: herdr pane in worktree gets graph_id; fetchBrief over real HTTP | not run | — | ? SKIP (not run this pass) |
| Mutation checks (dropped event graph_id; always-sent brief graph_id) | not run | — | ? SKIP (not run this pass) |

### Probe Execution

No `scripts/*/tests/probe-*.sh` declared or present for this phase. Skipped.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| A-D1 | PLAN.md | Lane B events reach the graph's brief and evidence without agents passing ids | ? NEEDS HUMAN | Collector-side code and tests verified (truths 1–6). Live effect needs an operator deploy (Human Verification 1–2) |

No ORPHANED requirements: REQUIREMENTS.md maps only A-D1 to phase 37.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| (none) | - | No TBD, FIXME, XXX, or placeholder markers in the phase's source files checked | - | - |

### Info

- **Drift from the recorded decision.** `worktree-graph.ts:9-11, 15-27` now reads `SUBSTRATE_WORKTREE_ROOTS` and accepts several roots. This came from a later commit, `8f1ce16c` (FLEET-01..05), not from phase 37. SUMMARY.md GREY_AREA 4 says "No environment knob was added", so that record is out of date. The multi-root behavior is covered by tests (`worktree-graph.test.ts:29-69`) and does not change the phase's must-haves. Recommend updating SUMMARY.md or recording the change.
- **Security record.** No `*-SECURITY.md` exists in this phase directory, so the draft/threats_open gate does not apply. Such files exist only in older milestone folders (v1.2, v1.3).
- **Not run this pass:** full suite (`bun test`), `tsc`, loopback smoke, and mutation checks. Their results from 2026-10-21 are in the previous record and were not re-proven here.

### Human Verification Required

### 1. Live end-to-end on a Lane B host

**Test:** Redeploy the collectors to a Lane B host that creates dispatcher worktrees (`/var/lib/substrate/worktrees/<graph_id>`). Run a herdr pane inside one of those worktrees and read that graph's `/brief` and `/events` evidence on the live server.
**Expected:** `session.start` carries `graph_id`. The event and brief for that graph appear without the agent passing an id.
**Why human:** Deploying to a live host is operator-gated (STATE.md run rules). No live server run was made.

### 2. pass() on a real worktree

**Test:** On a host with a real worktree directory, run Muse `pass()` on a git repo inside it and capture the `/brief` request body. Repeat for a repo outside any worktree.
**Expected:** The body has `graph_id` for the worktree repo and no `graph_id` for the other.
**Why human:** The call site at `muse.ts:405` was verified by reading and type checking. No real worktree exists on this host.

### Gaps Summary

No must-have failed. All in-repo truths (1–6) are verified by code and by the collector tests that ran. The phase is not `passed` because roadmap SC1 (end-to-end delivery) and the `pass()` call site on a real worktree need a live run, which is operator-gated.

---

_Verified: 2026-11-12T08:36:03Z_
_Verifier: Claude (gsd-verifier)_
