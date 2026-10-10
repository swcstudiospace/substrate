---
phase: 28-hourly-anchor-job-and-verify
plan: "03"
subsystem: ledger
tags: [systemd, units, docs, anchoring, verify-states]

requires:
  - plan: "01"
    provides: anchor-run.ts entry, SOLANA_* config names
  - plan: "02"
    provides: verify states, SUBSTRATE_VERIFY_TIMEOUT_MS
provides:
  - substrate-anchor.service/.timer plus environment drop-in
  - README anchor section and ledger-doc anchoring/verify/D-era record
affects: [28-04 (live install L6 references these units; runbook)]

actuals:
  tasks: 3
  commits: 1

key-files:
  modified:
    - scripts/doctor-units.test.ts
    - infra/vps/README.md
    - .env.example
    - docs/greptime-ledger.md
  created:
    - infra/vps/substrate-anchor.service
    - infra/vps/substrate-anchor.timer
    - infra/vps/substrate-anchor.service.d/10-environment.conf

key-decisions:
  - "No lock file: oneshot single-instance by design plus adopt-before-send; trigger-only-through-systemctl-start recorded in the README (D28-03, planner discretion exercised)"
  - "Drop-in loads the shared substrate.env: the job is a store client in the server trust domain, not a collector, so the doctor's shared-env rule (collectors only) stays green with no rule change"
  - "deploy-release.sh untouched: it already refuses releases missing any ExecStart entry, restarts only SUBSTRATE_RELEASE_UNITS, and a oneshot reads current on every tick"
  - ".env.example gains SUBSTRATE_VERIFY_TIMEOUT_MS=30000 beside the confirmed 28-01 SOLANA_* names (additive, same voice)"

requirements-completed: [ANCHOR-03, ANCHOR-05]

coverage:
  - id: D28-02
    description: "units substrate-anchor.service (Type=oneshot, no Restart=) and substrate-anchor.timer (OnCalendar=hourly, Persistent=true, Unit=substrate-anchor.service); service follows substrate-mcp.service (WorkingDirectory, ConditionPathExists, absolute bun, SyslogIdentifier, hardening, StateDirectory)"
    requirement: "ANCHOR-03"
    verification:
      - kind: unit
        ref: "bun test scripts/doctor-units.test.ts — anchor shape pinned (release cwd, shared env, restart null); dry-run green with zero new findings"
        status: pass
    human_judgment: false
  - id: D28-03
    description: "single instance by design; README trigger-only-through-systemctl-start rule; no lock file with rationale"
    requirement: "ANCHOR-03"
    verification:
      - kind: review
        ref: "infra/vps/README.md Hourly anchor job section names the rule and the re-check-before-send"
        status: pass
    human_judgment: false
  - id: D28-04
    description: "hourly OnCalendar with the 5-minute INGEST_LAG_MS lag in the job; second-tick timing (pending ~2h inside the 3h window)"
    requirement: "ANCHOR-03"
    verification:
      - kind: review
        ref: "timer OnCalendar=hourly literal plus README timing note; proven indirectly by the 28-04 fake-now run"
        status: pass
    human_judgment: false
  - id: D28-12
    description: "production-key-only-by-production-unit rule; rehearsal harness never carries the key names"
    requirement: "ANCHOR-05"
    verification:
      - kind: review
        ref: "README rehearsal warning plus ledger-doc key paragraph; smoke section 8 greps clean of the names"
        status: pass
    human_judgment: false
  - id: ledger-docs
    description: "greptime-ledger.md records schedule, candidate rule, send/adopt/alarm, 11-column row, anchor event shapes, five verify states plus legacy/uncovered with the 3h window, and the D-era note"
    requirement: "ANCHOR-05"
    verification:
      - kind: review
        ref: "Anchoring (Phase 28) section; grep anchor nonzero; store lock green"
        status: pass
    human_judgment: false

duration: ~2h
completed: 2026-10-09
status: complete
---

# Phase 28 Plan 03: Units and docs Summary

**The hourly schedule ships install-ready but uninstalled: two units plus drop-in, the README operator section, and the ledger anchoring record.**

## Accomplishments

- `substrate-anchor.service` (oneshot, no Restart=, release cwd, ConditionPathExists on anchor-run.ts, same bun, SyslogIdentifier=substrate-anchor, StateDirectory=substrate, same hardening block) and `substrate-anchor.timer` (OnCalendar=hourly, Persistent=true).
- `substrate-anchor.service.d/10-environment.conf` loading `/etc/substrate/substrate.env`; doctor fixtures extended (unit list + anchor shape), no rule change, dry-run still exactly the 4 known lane-B findings.
- README "Hourly anchor job" section (units, drop-in, trigger rule, second-tick timing, D28-12 rehearsal warning, doctor line); `.env.example` SOLANA_* confirmed plus `SUBSTRATE_VERIFY_TIMEOUT_MS`.
- `docs/greptime-ledger.md` "Anchoring (Phase 28)" section and the anchors-DDL stale-note fix.

## Task Commits

1. `1ed07ce` feat(28-03): anchor units, drop-in, README and ledger anchoring docs

## Verification

- `bun run scripts/doctor-units.ts --dry-run` green (4 known findings, zero from the anchor unit).
- `bun test scripts/doctor-units.test.ts infra/vps/deploy-release.test.ts` green.
- `bun test packages/mcp-server/src/store-lock.test.ts` green.
- No live step in this slice (install/enable L6 is live-gated to 28-04).

## Deviations from Plan

- None material. `deploy-release.sh` diff is empty with the rationale recorded above.

## Rollback and lock

- Rollback is file-deletion: remove the two units and the drop-in dir; README and ledger sections revert cleanly.
- No secret value in any new file (env names only); no host or credential in docs.

## Threat notes

- **T-28-11 (privilege):** same hardening block as substrate-mcp.service; keypair path only; doctor dry-run green.
- **T-28-12 (disclosure):** names only, never values; shared-env rule still targets collectors.
- **T-28-13 (double instance):** oneshot by design plus adopt-before-send; trigger rule documented.

## Self-Check: PASSED

Units parse, the doctor pins their shape, docs instruct the operator; nothing installed anywhere.
