---
phase: 17
review: 17-REVIEW.md
titles: json
findings:
  - id: WR-01
    severity: warning
    disposition: fixed
    title: "Substrate token is eligible for operator authority; swarm tokens are not"
  - id: WR-02
    severity: warning
    disposition: fixed
    title: "Successful skills-sync (and mirror) path is unmapped — no row, no silent entry"
  - id: WR-03
    severity: warning
    disposition: fixed
    title: "Lock tests do not pin surface-rule-vs-sample consistency or all source prefixes"
  - id: IN-01
    severity: info
    disposition: fixed
    title: "`.env.example` test pins swarm tokens but not the new substrate line"
  - id: IN-02
    severity: info
    disposition: fixed
    title: "No boot warning for a missing substrate token"
  - id: IN-03
    severity: info
    disposition: fixed
    title: "Reviewed doc ships an explicitly `[UNVERIFIED]` herdr mapping"
  - id: IN-04
    severity: info
    disposition: fixed
    title: "`parseEventKinds` lacks the mis-match guard `parseSurfaces` has"
open: 0
total: 7
recorded: 2026-10-08T23:59:08.211Z
---

# Phase 17: Code Review Disposition

| Finding | Severity | Disposition | Source |
|---------|----------|-------------|--------|
| WR-01 | warning | fixed | 8cd476d |
| WR-02 | warning | fixed | 6e323dd |
| WR-03 | warning | fixed | 254a328 |
| IN-01 | info | fixed | fe88ecf |
| IN-02 | info | fixed | 82383c7 |
| IN-03 | info | fixed | f4aa6a5 |
| IN-04 | info | fixed | c25ad88 |

Dispositions: `open` (recorded, not yet triaged), `fixed`, `skipped`, `deferred`.
Set `deferred` by hand and put the reason in the Source cell; both are preserved. A `|` in the reason is kept as prose and escaped on the next run.
Re-running the gate keeps every row it can. A row the current review no longer reports is kept and its Source cell flagged, so a finding does not leave this record silently. ONE exception: when a finding id is REUSED by a different finding, the earlier decision cannot keep a row — the id is taken — and it is dropped. A RECORDED decision (anything but `open`) is named on the console when that happens; a row still at `open` is replaced silently, because `open` records no decision to lose.
