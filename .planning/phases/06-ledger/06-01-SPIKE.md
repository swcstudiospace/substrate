# 06-01 Greptime scratch spike evidence

Recorded from observed output only.

Run once on 2026-09-27 (UTC) against Greptime 1.1.4 (database `public`), STAMP=20260927063830.
The throwaway /tmp/06-01-spike.ts (deleted afterwards) sent every write through a guard that
refuses any statement not naming `"p6_scratch_20260927063830_`; agent_events and anchors were only
read (information_schema, SHOW CREATE). The DROP route for both scratch tables was appended to
/var/lib/substrate/phase6-baseline/RESTORE.d/06-01.md before the first CREATE.

```
sudo systemd-run --quiet --wait --pipe --collect -p EnvironmentFile=/etc/substrate/substrate.env -p WorkingDirectory=/root/src/repos/agent-substrate -E HOME=/root -E P6_STAMP=20260927063830 -E P6_SNAPSHOT=/var/lib/substrate/phase6-baseline/06-01/20260927T063414Z /root/.local/share/reflex/bun/bin/bun /tmp/06-01-spike.ts
```

Steps (statements as sent, table names abbreviated to `<events>` / `<anchors>`):

1. `CREATE TABLE IF NOT EXISTS <events>` with agent_events' exact column list and
   `PRIMARY KEY ("surface", "repo", "graph_id", "kind")`; two rows; `ALTER TABLE <events> ADD COLUMN "ingested_at" TIMESTAMP`;
   information_schema.columns for the new column; the two old rows' ingested_at.
2. One row with `ingested_at` as an epoch-ms literal at an exact hour H (2026-09-27T04:00:00.000Z),
   one with an ISO literal (H + 30 min 123 ms); `>= <epoch>` and `>= '<iso>'` filters; the H row
   against `[H, H+1h)` and `[H-1h, H)` in both epoch-ms and ISO literal forms.
3. A full row, then a second INSERT with the same (surface, repo, graph_id, kind, ts), a different
   id and summary, and no `branch` column.
4. One 20-row INSERT, timed; one 5-row INSERT whose fifth row puts `'x'` into BIGINT `step`.
5. `ALTER TABLE <events> DROP COLUMN "ingested_at"`.
6. `<anchors>` with the current anchors DDL (`PRIMARY KEY ("root")`); the research's new 11-column DDL
   as `CREATE TABLE IF NOT EXISTS` on the same name; `DROP TABLE`; the new DDL again; two INSERTs
   with the same period_start and roots `root-first` then `root-second`; one more row an hour later.
7. `DROP TABLE IF EXISTS` both; information_schema.tables; `SHOW CREATE TABLE "agent_events"`
   compared byte-for-byte with the 06-01 Task 1 snapshot.

## Keys

spike_events_table=p6_scratch_20260927063830_events
spike_anchors_table=p6_scratch_20260927063830_anchors
spike_tables_absent_before=true
alter_add_column=ok
new_col_semantic=FIELD
new_col_type=timestamp(3)
old_rows_null=ok
epoch_literal_on_new_col=ok
iso_literal_on_new_col=ok
half_open_boundary=ok
half_open_boundary_hour=2026-09-27T04:00:00.000Z
last_row_same_key_rows=1
last_row_omitted_field=null
last_row_surviving_id=lr2
last_row_surviving_summary=second
multirow_insert_rows=20
multirow_insert_ms=200
multirow_bad_insert=rejected:greptime 400: {"code":1004,"error":"Column step expect type: Int64(Int64Type), actual: String(StringType { size_type: Utf8 })","execution_time_ms":1}
multirow_bad_first4_landed=0
multirow_insert_atomic=yes
alter_drop_column=ok
old_pk_detectable=true
create_if_not_exists_keeps_old_pk=true
nopk_create=ok
nopk_root_semantic=FIELD
nopk_dedup_on_time_index=ok
nopk_distinct_time_rows=2
spike_scratch_dropped=true
agent_events_unchanged=true
agent_events_ingested_at_cols=0

## What 06-04 and 06-05 can rely on

- ADD COLUMN "ingested_at" TIMESTAMP works on a table with agent_events' schema in 1.1.4; the column
  is a FIELD of type timestamp(3) and existing rows read it as NULL (research A3 holds).
- Epoch-ms and ISO (`…Z`) literals both insert into and compare against the new column; an event at
  exactly HH:00:00.000 belongs to `[HH, HH+1h)` and not to `[HH-1h, HH)`.
- A second write on the same (surface, repo, graph_id, kind, ts) leaves one row: the second write's
  row, with a column the second INSERT omitted reading NULL — the whole row is replaced, not merged
  (Pitfall 3: two events colliding on that key lose the first one entirely).
- A multi-row INSERT with a type error in its last row was rejected as a whole; none of its first
  four rows landed. 20 rows took 200 ms, about one round trip.
- DROP COLUMN "ingested_at" works (06-05's rollback route).
- A PRIMARY KEY ("root") anchors table is detectable as root semantic_type TAG; `CREATE TABLE IF NOT
  EXISTS` with the new DDL leaves that old schema in place (no memo column appears) — 06-05 needs the
  guarded DROP (Pitfall 9).
- The primary-key-less 11-column anchors DDL creates; root is a FIELD; two writes on one
  period_start leave one row holding the second root; distinct period_starts keep separate rows
  (research A4 holds).
- Both scratch tables are gone and agent_events is byte-identical to its snapshot, still without
  ingested_at.

## Gaps

- Atomicity was observed only for a statement rejected at type-check time (HTTP 400, code 1004);
  a failure after Greptime has started writing a multi-row batch (network cut, region error) was
  not exercised, so `multirow_insert_atomic=yes` does not cover partial writes of that kind.
- `multirow_insert_ms` is one sample over the public-internet link (Task 1 RTT samples 196–204 ms).
