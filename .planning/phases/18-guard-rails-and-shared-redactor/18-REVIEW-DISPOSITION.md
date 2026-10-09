---
phase: 18
review: 18-REVIEW.md
titles: json
findings:
  - id: WR-01
    severity: warning
    disposition: open
    title: "Skill pass leaves `<private>` block content in place when the block contains a high-confidence shape"
  - id: WR-02
    severity: warning
    disposition: open
    title: "Placeholder test is a prefix match, so real values beginning with a placeholder word are neither redacted nor reported"
  - id: IN-01
    severity: info
    disposition: open
    title: "`redactKnown` re-scans its own markers, so a needle that is a substring of `[REDACTED]` corrupts the output and breaks idempotence"
  - id: IN-02
    severity: info
    disposition: open
    title: "`lessons.ts` still filters and sorts the values that `redactKnown` now filters and sorts"
  - id: IN-03
    severity: info
    disposition: open
    title: "The redaction doc miscounts which table rows are the D-04 classes"
  - id: IN-04
    severity: info
    disposition: open
    title: "The lock's ignore list misses gitignored output directories, so `bun test` can fail on local artifacts"
  - id: IN-05
    severity: info
    disposition: open
    title: "The pipeline self-test accepts a hit from any detector, not the planted rule's own"
open: 7
total: 7
recorded: 2026-10-09T00:26:19.100Z
---

# Phase 18: Code Review Disposition

| Finding | Severity | Disposition | Source |
|---------|----------|-------------|--------|
| WR-01 | warning | open | - |
| WR-02 | warning | open | - |
| IN-01 | info | open | - |
| IN-02 | info | open | - |
| IN-03 | info | open | - |
| IN-04 | info | open | - |
| IN-05 | info | open | - |

Dispositions: `open` (recorded, not yet triaged), `fixed`, `skipped`, `deferred`.
Set `deferred` by hand and put the reason in the Source cell; both are preserved. A `|` in the reason is kept as prose and escaped on the next run.
Re-running the gate keeps every row it can. A row the current review no longer reports is kept and its Source cell flagged, so a finding does not leave this record silently. ONE exception: when a finding id is REUSED by a different finding, the earlier decision cannot keep a row — the id is taken — and it is dropped. A RECORDED decision (anything but `open`) is named on the console when that happens; a row still at `open` is replaced silently, because `open` records no decision to lose.
