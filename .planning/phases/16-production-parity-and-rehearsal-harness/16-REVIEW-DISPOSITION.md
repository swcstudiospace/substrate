---
phase: 16
review: 16-REVIEW.md
titles: json
findings:
  - id: WR-01
    severity: warning
    disposition: open
    title: "`up` accepts a partially healthy twin as ready"
  - id: WR-02
    severity: warning
    disposition: open
    title: "Default operator skips the swarm check, and the later throw leaks running containers"
  - id: WR-03
    severity: warning
    disposition: open
    title: "Missing flag values fall back to defaults without a word (`down --name` stops `default`)"
  - id: WR-04
    severity: warning
    disposition: open
    title: "The disk-floor preflight fails open"
  - id: WR-05
    severity: warning
    disposition: open
    title: "Run directory in shared `/tmp` trusts a pre-existing directory and swallows the chmod failure"
  - id: WR-06
    severity: warning
    disposition: open
    title: "A twin started from a `system.slice` context can never be stopped by `down`"
  - id: WR-07
    severity: warning
    disposition: open
    title: "`parseSsListeners` does not deduplicate pids, so a single owner can fail \"exactly MainPID\""
  - id: WR-08
    severity: warning
    disposition: open
    title: "The smoke `register` step passes on a tool error"
  - id: IN-01
    severity: info
    disposition: open
    title: "`parity:check --json` mixes human lines with the JSON on stdout"
  - id: IN-02
    severity: info
    disposition: open
    title: "`ls-remote` failure is reported as \"could not ask whether origin/main is local\" and can block on credentials"
  - id: IN-03
    severity: info
    disposition: open
    title: "`refuseSmokeUrl` rejects bracketed IPv6 loopback and refuses only `7410`"
  - id: IN-04
    severity: info
    disposition: open
    title: "Duplicated `/proc` start-time parsing with a hard-coded clock tick"
  - id: IN-05
    severity: info
    disposition: open
    title: "Unused or dead parameters and properties"
  - id: IN-06
    severity: info
    disposition: open
    title: "`refuseCheckoutDir` is an exact string comparison"
  - id: IN-07
    severity: info
    disposition: open
    title: "`--anonymous` silently ignores an explicit `--operator`"
  - id: IN-08
    severity: info
    disposition: open
    title: "`docs/rehearsal.md` drifts from the code"
  - id: IN-09
    severity: info
    disposition: open
    title: "Runbook rollback 1 makes `parity:check` fail by design, and the runbook does not say so"
open: 17
total: 17
recorded: 2026-10-08T21:36:50.141Z
---

# Phase 16: Code Review Disposition

| Finding | Severity | Disposition | Source |
|---------|----------|-------------|--------|
| WR-01 | warning | open | - |
| WR-02 | warning | open | - |
| WR-03 | warning | open | - |
| WR-04 | warning | open | - |
| WR-05 | warning | open | - |
| WR-06 | warning | open | - |
| WR-07 | warning | open | - |
| WR-08 | warning | open | - |
| IN-01 | info | open | - |
| IN-02 | info | open | - |
| IN-03 | info | open | - |
| IN-04 | info | open | - |
| IN-05 | info | open | - |
| IN-06 | info | open | - |
| IN-07 | info | open | - |
| IN-08 | info | open | - |
| IN-09 | info | open | - |

Dispositions: `open` (recorded, not yet triaged), `fixed`, `skipped`, `deferred`.
Set `deferred` by hand and put the reason in the Source cell; both are preserved. A `|` in the reason is kept as prose and escaped on the next run.
Re-running the gate keeps every row it can. A row the current review no longer reports is kept and its Source cell flagged, so a finding does not leave this record silently. ONE exception: when a finding id is REUSED by a different finding, the earlier decision cannot keep a row — the id is taken — and it is dropped. A RECORDED decision (anything but `open`) is named on the console when that happens; a row still at `open` is replaced silently, because `open` records no decision to lose.
