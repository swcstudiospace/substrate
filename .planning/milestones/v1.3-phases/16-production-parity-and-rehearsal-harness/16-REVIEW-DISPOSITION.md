---
phase: 16
review: 16-REVIEW.md
titles: json
findings:
  - id: WR-01
    severity: warning
    disposition: fixed
    title: "`up` accepts a partially healthy twin as ready"
  - id: WR-02
    severity: warning
    disposition: fixed
    title: "Default operator skips the swarm check, and the later throw leaks running containers"
  - id: WR-03
    severity: warning
    disposition: fixed
    title: "Missing flag values fall back to defaults without a word (`down --name` stops `default`)"
  - id: WR-04
    severity: warning
    disposition: fixed
    title: "The disk-floor preflight fails open"
  - id: WR-05
    severity: warning
    disposition: fixed
    title: "Run directory in shared `/tmp` trusts a pre-existing directory and swallows the chmod failure"
  - id: WR-06
    severity: warning
    disposition: fixed
    title: "A twin started from a `system.slice` context can never be stopped by `down`"
  - id: WR-07
    severity: warning
    disposition: fixed
    title: "`parseSsListeners` does not deduplicate pids, so a single owner can fail \"exactly MainPID\""
  - id: WR-08
    severity: warning
    disposition: fixed
    title: "The smoke `register` step passes on a tool error"
  - id: IN-01
    severity: info
    disposition: deferred
    title: "`parity:check --json` mixes human lines with the JSON on stdout"
  - id: IN-02
    severity: info
    disposition: deferred
    title: "`ls-remote` failure is reported as \"could not ask whether origin/main is local\" and can block on credentials"
  - id: IN-03
    severity: info
    disposition: fixed
    title: "`refuseSmokeUrl` rejects bracketed IPv6 loopback and refuses only `7410`"
  - id: IN-04
    severity: info
    disposition: deferred
    title: "Duplicated `/proc` start-time parsing with a hard-coded clock tick"
  - id: IN-05
    severity: info
    disposition: deferred
    title: "Unused or dead parameters and properties"
  - id: IN-06
    severity: info
    disposition: deferred
    title: "`refuseCheckoutDir` is an exact string comparison"
  - id: IN-07
    severity: info
    disposition: fixed
    title: "`--anonymous` silently ignores an explicit `--operator`"
  - id: IN-08
    severity: info
    disposition: fixed
    title: "`docs/rehearsal.md` drifts from the code"
  - id: IN-09
    severity: info
    disposition: fixed
    title: "Runbook rollback 1 makes `parity:check` fail by design, and the runbook does not say so"
open: 0
total: 17
recorded: 2026-10-08T21:36:50.141Z
---

# Phase 16: Code Review Disposition

| Finding | Severity | Disposition | Source |
|---------|----------|-------------|--------|
| WR-01 | warning | fixed | 8259d88 |
| WR-02 | warning | fixed | 6b0e4d3 |
| WR-03 | warning | fixed | 4c11888 |
| WR-04 | warning | fixed | f9d6c3f |
| WR-05 | warning | fixed | 9c6be92 |
| WR-06 | warning | fixed | 3272a73 |
| WR-07 | warning | fixed | e30e7f4 |
| WR-08 | warning | fixed | 890c236 |
| IN-01 | info | deferred | needs a CLI output-stream contract change; human lines and JSON share stdout by design today |
| IN-02 | info | deferred | needs spawn env plumbing (GIT_TERMINAL_PROMPT=0) plus ls-remote failure tracking; not a one-line change |
| IN-03 | info | fixed | d81ee08 |
| IN-04 | info | deferred | shared-module refactor across two scripts; tech debt with no behaviour bug |
| IN-05 | info | deferred | API change (refusePort signature, systemctl props); needs a design decision on ConditionResult reporting |
| IN-06 | info | deferred | stricter path canonicalization changes guard behaviour; needs a realpath decision |
| IN-07 | info | fixed | ac11c7f |
| IN-08 | info | fixed | 3d69e48 |
| IN-09 | info | fixed | 4937728 |

Dispositions: `open` (recorded, not yet triaged), `fixed`, `skipped`, `deferred`.
Set `deferred` by hand and put the reason in the Source cell; both are preserved. A `|` in the reason is kept as prose and escaped on the next run.
Re-running the gate keeps every row it can. A row the current review no longer reports is kept and its Source cell flagged, so a finding does not leave this record silently. ONE exception: when a finding id is REUSED by a different finding, the earlier decision cannot keep a row — the id is taken — and it is dropped. A RECORDED decision (anything but `open`) is named on the console when that happens; a row still at `open` is replaced silently, because `open` records no decision to lose.
