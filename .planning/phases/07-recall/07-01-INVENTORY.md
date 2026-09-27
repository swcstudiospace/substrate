# 07-01 backfill and redaction inventory (D-01, D-04, D-11)

Recorded from observed output only.

Measured 2026-09-27 after the 07-BASELINE.md commit, read-only: counts, lengths and class names only;
no summary, body, fixture value or secret was printed.

## Command

A throwaway `/tmp/07-01-probe.ts` (deleted afterwards) importing `loadConfig`, `GreptimeClient`/`quote`
and `redact` by absolute path, with `new SQL(config.postgresUrl)` from "bun" for Postgres, run once
under the keyed line:

```
sudo systemd-run --quiet --wait --pipe --collect -p EnvironmentFile=/etc/substrate/substrate.env -p WorkingDirectory=/root/src/repos/agent-substrate -E HOME=/root /root/.local/share/reflex/bun/bin/bun /tmp/07-01-probe.ts
```

- Events: Greptime `agent_events`, `"ts"` in `[from, to)` and `"kind" IN ('session.end','handoff','complete')`;
  `events_14d_with_graph` / `events_14d_with_repo` are `count("graph_id")` / `count("repo")` (non-null).
- Cutover: `cutover_ingested_at=2026-09-27T13:02:16.494Z` from 06-05-CUTOVER.md; null count is rows with
  `"ts"` ≥ that instant and `"ingested_at" IS NULL`.
- Memory: Postgres `memory_entries`, `created` in `[from, to)`; forwardable = decision + warning + fact
  (D-13: exactly these three kinds); `memory_max_body_bytes` / `memory_over_cap` are over all rows
  (`octet_length(body)`, cap 8192).
- Shape scan: the window's qualifying event summaries and forwardable memory bodies against the 11
  D-04 class regexes (07-03-PLAN interfaces); a row counts once however many classes it hits.
- Redaction gap: each D-04 fixture built by concatenation with random characters, embedded as
  `note <fixture> end`, compared before/after today's `redact()`.

## Printed lines (verbatim)

inventory_window_from=2026-09-13T17:09:07.989Z
inventory_window_to=2026-09-27T17:09:07.989Z
events_14d_session_end=3
events_14d_handoff=2
events_14d_complete=3
events_14d_total=8
events_14d_with_graph=5
events_14d_with_repo=4
events_14d_max_summary_len=98
events_post_cutover_ingested_at_null=0
events_ingested_at_max=2026-09-27T17:07:30.789Z
memory_14d_decision=0
memory_14d_warning=1
memory_14d_fact=1
memory_14d_handoff=0
memory_14d_todo=0
memory_14d_forwardable=2
memory_max_body_bytes=90
memory_over_cap=0
shape_hits_14d=0
redact_gap_class: aws unchanged
redact_gap_class: google unchanged
redact_gap_class: slack unchanged
redact_gap_class: npm unchanged
redact_gap_class: gitlab unchanged
redact_gap_class: digitalocean unchanged
redact_gap_class: openai-proj unchanged
redact_gap_class: pk unchanged
redact_gap_class: rk unchanged
redact_gap_class: private-tag unchanged
redact_gap_class: api-key-lower unchanged
redact_gap_fixture_count=11
redact_gap_unchanged=11
backfill_expected=10

## Reading

- Backfill sizing (D-11): 8 qualifying events + 2 forwardable memory entries = 10 records in the
  14-day window — same volume as the planning-time read (8 + 2).
- The ingested_at cursor 07-06 walks is sound: every post-cutover event carries `ingested_at`.
- Cap sizing (D-04): the largest summary is 98 characters and the largest memory body 90 bytes; no
  row exceeds the 8 KB cap.
- No stored qualifying row carries a D-04 shape today (`shape_hits_14d=0`); 07-04's forward-time
  `redact()` still applies to every forwarded content.
- All 11 D-04 classes pass through today's `redact()` unchanged: 07-03 must add every one.

## Gaps

- The 14-day counts are re-measured by 07-06 over the forwarder's own window; this file is the
  sizing figure only.
- The shape scan uses the planner's regexes; a class 07-03 tightens or widens is re-checked by its
  own fixture tests, not by this scan.
- `events_14d_with_graph` / `events_14d_with_repo` count non-null values; an empty-string tag would
  count as present.
