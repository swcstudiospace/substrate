---
phase: 18
review: 18-REVIEW.md
titles: json
findings:
  - id: WR-01
    severity: warning
    disposition: fixed
    title: "Skill pass leaves `<private>` block content in place when the block contains a high-confidence shape"
  - id: WR-02
    severity: warning
    disposition: fixed
    title: "Placeholder test is a prefix match, so real values beginning with a placeholder word are neither redacted nor reported"
  - id: IN-01
    severity: info
    disposition: fixed
    title: "`redactKnown` re-scans its own markers, so a needle that is a substring of `[REDACTED]` corrupts the output and breaks idempotence"
  - id: IN-02
    severity: info
    disposition: fixed
    title: "`lessons.ts` still filters and sorts the values that `redactKnown` now filters and sorts"
  - id: IN-03
    severity: info
    disposition: fixed
    title: "The redaction doc miscounts which table rows are the D-04 classes"
  - id: IN-04
    severity: info
    disposition: fixed
    title: "The lock's ignore list misses gitignored output directories, so `bun test` can fail on local artifacts"
  - id: IN-05
    severity: info
    disposition: fixed
    title: "The pipeline self-test accepts a hit from any detector, not the planted rule's own"
open: 0
total: 7
recorded: 2026-10-09T00:26:19.100Z
---

# Phase 18: Code Review Disposition

| Finding | Severity | Disposition | Source |
|---------|----------|-------------|--------|
| WR-01 | warning | fixed | 4b0c8cd |
| WR-02 | warning | fixed | 00aedd8 |
| IN-01 | info | fixed | 3006db3 |
| IN-02 | info | fixed | 89de336 |
| IN-03 | info | fixed | 8a2ee5a |
| IN-04 | info | fixed | 2b69384 |
| IN-05 | info | fixed | 47d50f9 |

Dispositions: `open` (recorded, not yet triaged), `fixed`, `skipped`, `deferred`.
Set `deferred` by hand and put the reason in the Source cell; both are preserved. A `|` in the reason is kept as prose and escaped on the next run.
Re-running the gate keeps every row it can. A row the current review no longer reports is kept and its Source cell flagged, so a finding does not leave this record silently. ONE exception: when a finding id is REUSED by a different finding, the earlier decision cannot keep a row — the id is taken — and it is dropped. A RECORDED decision (anything but `open`) is named on the console when that happens; a row still at `open` is replaced silently, because `open` records no decision to lose.
