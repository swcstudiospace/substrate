---
phase: 07-recall
plan: 02
subsystem: recall-owner-inputs
tags: [wave-1, d-08, d-11, sc3, owner-checkpoint, owner-skip]

requires:
  - phase: 07-recall
    plan: 01
    provides: phase7-baseline-t0; RESTORE.md index naming RESTORE.d/07-02.md; RESTORE.d/ (0700)
provides:
  - .env.example Recall block (empty AGENTMEMORY_URL= / AGENTMEMORY_SECRET=)
  - /var/lib/substrate/phase7-baseline/RESTORE.d/07-02.md (host, 0600 root) — env-line, owner-only Railway and spike-forget routes
  - 07-02-SPIKE.md with spike_result=fail, reason owner-skip
affects: [07-04, 07-05, 07-06, 07-07, 07-08]

actuals:
  tasks: 2 of 3 (Task 3 not run)
  commits: 2
outcome: stopped — owner-skip

key-files:
  created:
    - .planning/phases/07-recall/07-02-SPIKE.md
    - /var/lib/substrate/phase7-baseline/RESTORE.d/07-02.md (host, 0600)
  modified:
    - .env.example

key-decisions:
  - "Owner answered the Task 2 checkpoint with 'skip': recall stops; there is no substitute backend (no silent fallback)"
---

# Phase 7 Plan 02: Agentmemory owner inputs Summary

Recall stopped at the owner checkpoint. The owner answered the Task 2 checkpoint with `skip`.
07-02-SPIKE.md therefore records `spike_result=fail` with `spike_result_reason=owner-skip`.
**07-04..07-08 do not run.** The plan has no substitute recall backend.

## Commits

| Task | Commit | Files |
|------|--------|-------|
| 1 — RESTORE route (host, before any owner edit) | — | /var/lib/substrate/phase7-baseline/RESTORE.d/07-02.md |
| 1 — env contract | 98bb274 | .env.example |
| 2 — owner skip recorded | 8fb36aa | .planning/phases/07-recall/07-02-SPIKE.md |
| 3 — keyed checks, version gate, isolation, contract spike | not run | — |

## What happened

- **Task 1.** Before any owner edit, /etc/substrate/substrate.env had no Agentmemory lines:
  `env_agentmemory_url_before=0`, `env_agentmemory_secret_before=0`, `env_mode_before=600 root`.
  - RESTORE.d/07-02.md (0600 root) was written with three routes:
    - (a) the env-line sed delete plus a substrate-mcp restart;
    - (b) owner-only Railway routes: roll back to the previous deployment, or rotate the secret by
      deleting /data/.hmac and redeploying;
    - (c) a keyed `/agentmemory/forget` for the spike memory.
  - RESTORE.md is unchanged (sha256 6585ec45… before and after).
  - .env.example gained the `# ── Recall: Agentmemory (phase 7)` block with empty values.
  - The plan's automated verify passed.
- **Task 2.** The owner resume signal, verbatim, was `skip`. It is recorded under `## Owner report`.
- **Task 3.** It did not run, because its precondition requires "done" and both env lines. There
  was no keyed probe, no network call to Agentmemory and no spike memory, so route (c) is moot.

## State after the stop

- substrate.env has 0 `AGENTMEMORY_*` lines and mode `600 root`. substrate-mcp was not restarted
  and needs no rollback.
- The .env.example block and RESTORE.d/07-02.md stay in place. They are inert without values, and
  a later re-run of 07-02 reuses them.
- To resume recall, re-run 07-02 from Task 2. The owner then does the Railway report, the
  upgrade to ≥ 0.9.29, the scope and single-holder confirmations and the two no-echo appends.
  Task 3 must pass before 07-04 starts.

## Deviations

None.
