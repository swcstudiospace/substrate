# 06-05 cutover evidence

Recorded from observed output only. 2026-09-27 (UTC), from `/root/src/repos/agent-substrate`.

## Task 1 — guarded DDL under the old code (D-08, D-09)

Keyed one-shot (`K` below):

```
sudo systemd-run --quiet --wait --pipe --collect -p EnvironmentFile=/etc/substrate/substrate.env -p WorkingDirectory=/root/src/repos/agent-substrate -E HOME=/root /root/.local/share/reflex/bun/bin/bun <script>
```

Commands:

```
systemctl show -p ActiveEnterTimestamp --value substrate-mcp
git rev-list -1 --before="Sat 2026-09-26 19:31:28 UTC" HEAD
sha256sum /etc/systemd/system/substrate-mcp.service
K /tmp/06-05-guard.ts        # SHOW CREATE TABLE "agent_events" / "anchors" → compared byte for byte with
                             # /var/lib/substrate/phase6-baseline/06-01/20260927T063414Z/greptime/*.show-create.txt
sudo tee /var/lib/substrate/phase6-baseline/RESTORE.d/06-05.md   # routes (1) code, (2) column, (3) anchors — before the DDL
K -E P6_MIGRATE=1 /tmp/06-05-ddl.ts   # new GreptimeClient(loadConfig().greptime).migrate(), then columns() report
```

(/tmp/06-05-guard.ts and /tmp/06-05-ddl.ts are throwaway scripts, deleted afterwards.)

deployed_commit_before=b0390d89a0c00e76274da0bfc6c4641e02a53c7f
service_active_since_before=Sat 2026-09-26 19:31:28 UTC
unit_sha256=ccbe64e5a02a48c226a82bf92b54a9da6edc04c5ca0dea1d94cf05e4e2051af3
schema_matches_snapshot=true
early_cutover=false
restore_route_written=true
ddl_run=ok
ingested_at_column=FIELD:timestamp(3)
anchors_tag_columns=0
anchors_columns=11
anchors_time_index=period_start
anchors_rows=0

Both SHOW CREATE outputs equalled the snapshot files exactly (the files hold the statement with no
added trailing newline). The DDL ran at 2026-09-27T12:46:12Z; substrate-mcp (old code, started
2026-09-26 19:31:28 UTC, before the first 06-04 commit at 2026-09-27T12:03:54Z) stayed active and
not restarted, writing NULL ingested_at meanwhile.

Live anchors columns after the DDL:
`period_start:TIMESTAMP:timestamp(3), period_end:FIELD:timestamp(3), root:FIELD:string,
event_count:FIELD:bigint, memo:FIELD:string, tx_sig:FIELD:string, signer:FIELD:string,
cluster:FIELD:string, slot:FIELD:bigint, anchored_at:FIELD:timestamp(3), stale_hashes:FIELD:bigint`.

## Task 2 — restart onto the global ingest chain, cutover event, live smoke (D-01, D-02, D-03)

Commands (the minute of the hour was 01 at the restart):

```
git rev-parse HEAD
sudo systemctl restart substrate-mcp
curl -s -o /dev/null -w '%{http_code}' -m 2 http://127.0.0.1:7410/healthz      # polled once a second, up to 30 s
journalctl -u substrate-mcp --since "$(systemctl show -p ActiveEnterTimestamp --value substrate-mcp)" -o cat
/root/.local/share/reflex/bun/bin/bun /tmp/06-05-burst.ts                       # plain bun against 127.0.0.1:7410
K /tmp/06-05-cutover.ts                                                         # first row by ingested_at, id; NULL-ingested_at count
K -E P6_SG=<smoke_graph_id> -E P6_CID=<cutover_event_id> -E P6_REPLAY_TS=<replay ts> /tmp/06-05-chain.ts
for g in <every baseline-ok-graph>; do curl -s -X POST http://127.0.0.1:7410/verify -d '{"graph_id":"<g>"}' | jq -r .ok; done
curl -s -X POST http://127.0.0.1:7410/verify -d '{"graph_id":"<smoke_graph_id>"}'
```

(/tmp/06-05-burst.ts, /tmp/06-05-cutover.ts and /tmp/06-05-chain.ts are throwaway, deleted afterwards.
The chain script reads every row with ingested_at set, ordered by ingested_at, id, maps it through
rowToEvent and runs verifyGlobalChain(events, null).)

restarted_at=2026-09-27T13:01:42Z
healthz_after=200
journal_chain_head_line=genesis
journal_degraded_greptime=0
deployed_commit=c2bafeb8e614a7b5515b28cca3cb356c05210564

healthz answered 200 on the fifth one-second poll. Journal since the restart (`[substrate]` lines):
`[substrate] chain head genesis`, `[substrate] listening on http://127.0.0.1:7410 (index + greptime, anonymous)`,
`[substrate] mirror: linear on, notion on`; no `degraded` line of any kind. The deployed commit is the
06-04 SUMMARY commit, which contains the three 06-04 code commits (515d664, 197a55c, 83506fe).

No other producer emitted between the restart and the smoke, so the cutover event is the first
event of the burst (graph ut-ledger-smoke-20260927T130216Z, server-timed: ts equals ingested_at).

cutover_event_id=evt_5d1b8c404ad948908a5a7d5c2a748696
cutover_hash=ae2db71f2cb3f5c1d0ac3d22b58c2f2c2a0ad093d3a80c5e4ae2f0fb76dd4567
cutover_ingested_at=2026-09-27T13:02:16.494Z
cutover_prev=null
cutover_surface=claude-code
historical_rows_at_cutover=6043

Burst smoke (20 concurrent, then 7 concurrent of which 3 carry a client ts of now minus 20, 21 and
22 minutes; then the replay pair and the collision at ts 2026-09-27T12:52:00.000Z, the UTC minute
floored minus 10 minutes):

smoke_graph_id=ut-ledger-smoke-20260927T130216Z
burst_http_202=20/20
emit_latency_max_ms=800
burst7_latency_max_ms=903
replay_same_id=true
replay_key_rows=1
collision_nudged_ms=1

Replay: both POSTs answered 202 with id evt_766b800159524b8dbb1b5d0576def81a; the collision
(summary "06-05 collision") answered 202, id evt_d241ffb20ab64cf5b7fb63b33f0f51fe, ts
2026-09-27T12:52:00.001Z (reply and stored row both 1 ms after the replayed row). All 7 of the
second burst answered 202.

Post-cutover chain (read 2026-09-27T13:02Z, after the smoke; 29 rows, all of them the smoke graph's):

post_cutover_rows=29
post_cutover_prev_null=1
post_cutover_hash_null=0
post_cutover_chain_breaks=0
ingested_at_strictly_increasing=true
smoke_ts_equals_ingested_at=true
smoke_hour=2026-09-27T13:00:00.000Z
smoke_hour_equals_cutover_hour=true

The one null prev is the cutover event (first row by ingested_at, id). smoke_ts_equals_ingested_at
covers the 24 server-timed smoke rows (20 + 4); the other 5 carry a client ts (3 burst, replay,
collision).

Historical graphs and the smoke graph (POST /verify after the restart; all 19 also answered ok
just before the restart):

pre_cutover_graphs_verified=19/19
smoke_graph_verify_ok=true

Smoke graph reply: `{"ok":true,"events":29,"chain":{"pre":{"ok":true,"events":0},"post":{"ok":true,"events":29}},"hours":[{"period_start":"2026-09-27T13:00:00.000Z","hour_events":29,"graph_events":29,"chain":"ok"}]}`.

## Gaps

- Anchoring is skipped by the owner (D-17, "Skip Phase 6 anchoring"): the period-keyed `anchors`
  table stays at 0 rows and no hour is ever anchored, so the smoke hour 2026-09-27T13:00:00.000Z is
  protected by the global chain only — a consistent rewrite of a whole stretch would still pass
  verifyGlobalChain. 06-07 adds per-hour chain lines to the CLI; it sees one hour line for the smoke
  graph (smoke_hour_equals_cutover_hour=true).
- After this cutover, RESTORE.d/06-05.md route (2) (DROP COLUMN) is no longer available — 29+ rows
  now carry ingested_at — and route (1) (code revert) would leave the post-cutover rows verifying only
  in their own terms.
- emit latency is transport-dominated: Greptime round trips were ~200 ms at baseline; the 20-burst
  took 800 ms and the 7-burst (with one eventsAtKeys round for the client-ts events) 903 ms, both
  under the 1500 ms hook budget.
