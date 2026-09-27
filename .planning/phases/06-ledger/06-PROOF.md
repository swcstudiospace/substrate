# Phase 6 proof — alter one event row, verify flags the graph (D-12, chain-only per D-17)

Recorded from observed output only. 2026-09-27 (UTC), from `/root/src/repos/agent-substrate`, against
production (substrate-mcp active on 127.0.0.1:7410, deployed chain code from 06-04/06-05, 06-07 CLI).
Nothing was sent to devnet and no timer is involved (D-17: the owner answered "Skip Phase 6 anchoring").

`K` below is the keyed run line for the throwaway tamper script (source under "## Tamper script"):

```
K="sudo systemd-run --quiet --wait --pipe --collect -p EnvironmentFile=/etc/substrate/substrate.env -p WorkingDirectory=/root/src/repos/agent-substrate -E HOME=/root /root/.local/share/reflex/bun/bin/bun /tmp/06-09-tamper.ts"
```

## Setup

Preconditions: 06-07-SMOKE.md has smoke_verify_exit=0 and smoke_hour_chain=ok; `systemctl is-active
substrate-mcp` printed `active`; the UTC time was 13:17, inside minute 01–50 of the hour.

Commands:

```
STAMP=20260927T131911Z; G=ut-ledger-proof-$STAMP
for n in 1 2 3; do bun packages/cli/src/index.ts emit --kind note --summary "06-09 proof event $n $STAMP" --graph $G --session $G-s1 --surface claude-code --repo swcstudiospace/agent-substrate; done
$K capture $G /tmp/06-09-scratch.json
bun packages/cli/src/index.ts verify $G 2>&1
sudo install -d -m 0700 /var/lib/substrate/phase6-baseline/06-09/$STAMP
$K capture $G /var/lib/substrate/phase6-baseline/06-09/$STAMP/originals.json
sudo stat -c '%a %U' <originals>; sudo sha256sum <originals>
$K successor <originals> evt_7975e0d7037e497883efdcfb18160598
```

The three emits exited 0 (13:19:13.7, 13:19:15.8, 13:19:17.4 UTC). Read-back in ingest order:

```
row_1_id=evt_1a440de67e0542fcb6e81a252a5300bb  ingested_at=2026-09-27T13:19:13.190Z  hash=73a6ed4d…7861  prev=d4096865…cb62
row_2_id=evt_7975e0d7037e497883efdcfb18160598  ingested_at=2026-09-27T13:19:15.489Z  hash=bdbdd0e7…3bfb  prev=73a6ed4d…7861
row_3_id=evt_e4816d834c2d41ed8c746911570e1607  ingested_at=2026-09-27T13:19:17.094Z  hash=9adf8ede…2b08  prev=bdbdd0e7…3bfb
```

No other producer ingested between the three emits: each event's prev is the previous event's hash.

Verify before any write (exit 0):

```
chain intact for ut-ledger-proof-20260927T131911Z (3 events)
hour 2026-09-27T13:00:00.000Z chain ok (3 of 52 events)
```

proof_stamp=20260927T131911Z
proof_graph_id=ut-ledger-proof-20260927T131911Z
proof_session=ut-ledger-proof-20260927T131911Z-s1
proof_event_1=evt_1a440de67e0542fcb6e81a252a5300bb
proof_event_2=evt_7975e0d7037e497883efdcfb18160598
proof_event_3=evt_e4816d834c2d41ed8c746911570e1607
proof_hour=2026-09-27T13:00:00.000Z
proof_events_same_hour=true
verify_before_exit=0
verify_before_hour_line=hour 2026-09-27T13:00:00.000Z chain ok (3 of 52 events)

Originals, captured before any overwrite (all 17 columns as Greptime returned them; the scratch
capture was byte-identical by `cmp`; `stat` printed `600 root`). RESTORE.d/06-09.md (0600 root) was
written next, before the first tamper: `restore <originals> <id>` for each of the three ids, then
`readback`, `final` and `substrate verify $G`.

originals_path=/var/lib/substrate/phase6-baseline/06-09/20260927T131911Z/originals.json
originals_sha256=1c6893ef8d350062c88a9510dd136cc77ebb685c2a25c68f2c90cd1021932b7d
key_rows_before=3

Chain-only design check — the middle event's global successor, located before any write:

```
successor_rows=1
successor_id=evt_e4816d834c2d41ed8c746911570e1607
successor_graph=ut-ledger-proof-20260927T131911Z
successor_ingested_at=2026-09-27T13:19:17.094Z
successor_hour=2026-09-27T13:00:00.000Z
```

middle_successor=evt_e4816d834c2d41ed8c746911570e1607
middle_successor_rows=1
middle_successor_hour=2026-09-27T13:00:00.000Z
middle_successor_not_after_event_3=true
b_detectable_by_chain=true

The successor is event 3 itself (ingested 13:19:17.094Z, the only row whose prev is the middle hash).
06-04 checks every row of hour H in ingest order, so a changed middle hash leaves this row's prev
dangling and verify must break there.

## Tamper (a)

Stale hash kept: the middle row re-inserted on the same (surface, repo, graph_id, kind, ts) with
summary "06-09 tampered (a) 20260927T131911Z", every other column (id, ingested_at, prev, hash,
payload, …) exactly as captured, all 17 columns named. Each write was read back before verify ran.

```
$K tamper-a <originals> evt_7975e0d7037e497883efdcfb18160598
$K readback <originals> evt_7975e0d7037e497883efdcfb18160598
bun packages/cli/src/index.ts verify ut-ledger-proof-20260927T131911Z 2>&1
$K restore <originals> evt_7975e0d7037e497883efdcfb18160598
$K readback <originals> evt_7975e0d7037e497883efdcfb18160598
bun packages/cli/src/index.ts verify ut-ledger-proof-20260927T131911Z 2>&1
```

Tamper read-back: `key_rows=1 graph_rows=3 live_id=evt_7975e0d7… summary_changed=true
hash_equals_original=true hash_equals_recomputed=false byte_equal_original=false`.

Verify with the tamper in place (exit 1):

```
chain BROKEN for ut-ledger-proof-20260927T131911Z at evt_7975e0d7037e497883efdcfb18160598: hash does not match contents
hour 2026-09-27T13:00:00.000Z chain broken (3 of 57 events)
```

Restore read-back: `key_rows=1 graph_rows=3 summary_changed=false hash_equals_original=true
hash_equals_recomputed=true byte_equal_original=true`. Verify after the restore (exit 0):

```
chain intact for ut-ledger-proof-20260927T131911Z (3 events)
hour 2026-09-27T13:00:00.000Z chain ok (3 of 57 events)
```

a_written_at=2026-09-27T13:20:36.989Z
a_readback_summary_changed=true
a_readback_hash_stale=true
a_key_rows=1
a_graph_rows=3
a_verify_exit=1
a_chain_reason=hash does not match contents
a_broken_at=evt_7975e0d7037e497883efdcfb18160598
a_hour_chain=broken
a_restored_at=2026-09-27T13:20:44.387Z
a_window_s=7.398
a_restore_byte_equal=true
a_verify_after_restore_exit=0
a_hour_chain_after_restore=ok

The hour had grown from 52 to 57 events by then (other producers' traffic in hour H); for the 7.4 s
window every graph with events in 13:00–14:00 would have verified as broken.

## Tamper (b)

Hash recomputed, chain-only (D-17): the middle row re-inserted on the same key with summary
"06-09 tampered (b) 20260927T131911Z" and hash = eventHash of the tampered row (prev and ingested_at
unchanged, all 17 columns named). The successor was re-located first; a new row cannot take the
middle hash as its prev, since only the chain head's hash is ever used as the next prev.

```
$K successor <originals> evt_7975e0d7037e497883efdcfb18160598
$K tamper-b <originals> evt_7975e0d7037e497883efdcfb18160598
$K readback <originals> evt_7975e0d7037e497883efdcfb18160598
bun packages/cli/src/index.ts verify ut-ledger-proof-20260927T131911Z 2>&1
$K restore <originals> evt_7975e0d7037e497883efdcfb18160598
$K readback <originals> evt_7975e0d7037e497883efdcfb18160598
bun packages/cli/src/index.ts verify ut-ledger-proof-20260927T131911Z 2>&1
```

Successor re-run: `successor_rows=1 successor_id=evt_e4816d834c2d41ed8c746911570e1607
successor_hour=2026-09-27T13:00:00.000Z`. tamper-b printed `tampered_hash=74738e34…0c11`.

Tamper read-back: `key_rows=1 graph_rows=3 live_id=evt_7975e0d7… summary_changed=true
hash_equals_original=false hash_equals_recomputed=true byte_equal_original=false` — the middle row
verifies on its own contents; only the global chain can expose it.

Verify with the tamper in place (exit 1):

```
chain BROKEN for ut-ledger-proof-20260927T131911Z at evt_e4816d834c2d41ed8c746911570e1607: prev does not match the preceding event
hour 2026-09-27T13:00:00.000Z chain broken (3 of 57 events)
```

Restore read-back: `key_rows=1 graph_rows=3 summary_changed=false hash_equals_original=true
hash_equals_recomputed=true byte_equal_original=true`. Verify after the restore (exit 0):

```
chain intact for ut-ledger-proof-20260927T131911Z (3 events)
hour 2026-09-27T13:00:00.000Z chain ok (3 of 57 events)
```

b_expected_successor=evt_e4816d834c2d41ed8c746911570e1607
b_written_at=2026-09-27T13:21:02.287Z
b_readback_hash_recomputed=true
b_key_rows=1
b_graph_rows=3
b_verify_exit=1
b_chain_reason=prev does not match the preceding event
b_broken_at=evt_e4816d834c2d41ed8c746911570e1607
b_hour_chain=broken
b_caught_by=chain-prev-linkage
b_restored_at=2026-09-27T13:21:09.987Z
b_window_s=7.700
b_restore_byte_equal=true
b_verify_after_restore_exit=0
b_hour_chain_after_restore=ok

No anchor exists (anchors 0 rows, D-17): the break is reported at the recorded global successor,
whose stored prev still names the original middle hash, not at the tampered row.

## Final

```
$K final <originals>
bun packages/cli/src/index.ts verify ut-ledger-proof-20260927T131911Z 2>&1
for g in <every baseline-ok-graph in 06-BASELINE.md>; do bun packages/cli/src/index.ts verify "$g"; done
git log --grep='(06-' --name-only --format= | sort -u     # 33 paths
/root/.local/share/solana/install/active_release/bin/solana config get
systemctl is-active substrate-mcp
```

`final` printed `rows_equal=3/3` (each live row's canonical JSON equals its capture) and
`anchors_rows=0`; verify exit 0 with `hour 2026-09-27T13:00:00.000Z chain ok (3 of 57 events)`; all
19 baseline-ok graphs exited 0; no Phase 6 commit path under packages/collectors, projector, host or
dispatcher, and none a package.json, package-lock.json or bun.lock(b); Solana RPC URL is the
untouched localhost default; substrate-mcp `active`.

final_rows_equal_originals=true
final_verify_exit=0
final_hour_chain=ok
final_pre_cutover_graphs_verified=19/19
phase6_producer_changes=0
phase6_dependency_changes=0
solana_config_rpc_final=http://127.0.0.1:8899
anchors_rows_final=0
sc1_rescope=D-01
sc2_status=skipped-owner-D-17
sc3_signature_clause=skipped-owner-D-17
proof_result=pass

sc1_rescope: per D-01 the orchestrator annotates ROADMAP SC1 in place as "every event is hashed on
ingest over the canonical event JSON and carries prev", keeping the original wording quoted. SC2 and
SC3's signature clause are skipped by the owner, whose verbatim answer at 06-03's funding checkpoint
was "Skip Phase 6 anchoring" (D-17); SC3's chain clause is what this proof exercised.

## Tamper script

/tmp/06-09-tamper.ts, run only through `$K` (credentials from the EnvironmentFile, never printed;
no DELETE; every INSERT names all 17 EVENT_COLUMNS). Deleted after the proof, with
/tmp/06-09-scratch.json.

```ts
// 06-09 throwaway: capture, locate the global successor, tamper, restore and read back one
// agent_events row. Every INSERT names all 17 EVENT_COLUMNS; there is no DELETE. Prints key=value
// lines only. Greptime credentials come from the environment (EnvironmentFile), never printed.
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "/root/src/repos/agent-substrate/packages/mcp-server/src/config.ts";
import { canonicalJson, eventHash, rowToEvent } from "/root/src/repos/agent-substrate/packages/mcp-server/src/event.ts";
import { EVENT_COLUMNS, GreptimeClient, quote } from "/root/src/repos/agent-substrate/packages/mcp-server/src/greptime.ts";

type Row = Record<string, unknown>;

const config = loadConfig().greptime;
if (!config) throw new Error("greptime not configured");
const g = new GreptimeClient(config, 30000);
const SELECT = EVENT_COLUMNS.map((c) => '"' + c + '"').join(", ");
const [mode, a1, a2] = process.argv.slice(2);

const iso = (ms: unknown): string => new Date(Number(ms)).toISOString();
const hourIso = (ms: unknown): string => {
	const d = new Date(Number(ms));
	d.setUTCMinutes(0, 0, 0);
	return d.toISOString();
};
const out = (k: string, v: unknown): void => console.log(k + "=" + String(v));
function captured(file: string, id: string): Row {
	const row = (JSON.parse(readFileSync(file, "utf8")) as Row[]).find((r) => r.id === id);
	if (!row) throw new Error("id not in capture: " + id);
	return row;
}

/** One column value as SQL: timestamps as ISO strings, step as a number, the rest as text. */
function sqlValue(col: string, v: unknown): string {
	if (v === null || v === undefined) return quote(null);
	if (col === "ts" || col === "ingested_at") return quote(iso(v));
	if (col === "step") return quote(Number(v));
	return quote(String(v));
}

async function insertRow(row: Row): Promise<void> {
	const values = EVENT_COLUMNS.map((c) => sqlValue(c, row[c])).join(", ");
	await g.sql('INSERT INTO "agent_events" (' + SELECT + ") VALUES (" + values + ")");
}

function eq(col: string, v: unknown): string {
	return v === null || v === undefined ? '"' + col + '" IS NULL' : '"' + col + '" = ' + quote(String(v));
}

async function keyRows(row: Row): Promise<Row[]> {
	const where = [eq("surface", row.surface), eq("repo", row.repo), eq("graph_id", row.graph_id), eq("kind", row.kind)];
	where.push('"ts" = ' + quote(Number(row.ts)));
	return g.sql("SELECT " + SELECT + ' FROM "agent_events" WHERE ' + where.join(" AND "));
}

async function graphRows(graph: unknown): Promise<Row[]> {
	return g.sql("SELECT " + SELECT + ' FROM "agent_events" WHERE ' + eq("graph_id", graph) + ' ORDER BY "ingested_at", "id"');
}

function recomputed(row: Row): string {
	const { hash: _hash, ...rest } = rowToEvent(row);
	return eventHash(rest);
}

switch (mode) {
	case "capture": {
		const rows = await graphRows(a1);
		writeFileSync(a2, JSON.stringify(rows), { mode: 0o600 });
		chmodSync(a2, 0o600);
		out("rows", rows.length);
		rows.forEach((r, i) => {
			const n = i + 1;
			out("row_" + n + "_id", r.id);
			out("row_" + n + "_hash", r.hash);
			out("row_" + n + "_prev", r.prev);
			out("row_" + n + "_ingested_at", iso(r.ingested_at));
			out("row_" + n + "_hour", hourIso(r.ingested_at));
			out("row_" + n + "_summary", r.summary);
		});
		break;
	}
	case "successor": {
		const row = captured(a1, a2);
		const rows = await g.sql(
			'SELECT "id", "graph_id", "ingested_at" FROM "agent_events" WHERE "prev" = ' + quote(String(row.hash)) + ' ORDER BY "ingested_at", "id"',
		);
		out("successor_rows", rows.length);
		const s = rows[0];
		if (s) {
			out("successor_id", s.id);
			out("successor_graph", s.graph_id);
			out("successor_ingested_at", iso(s.ingested_at));
			out("successor_hour", hourIso(s.ingested_at));
		}
		break;
	}
	case "tamper-a": {
		const row = captured(a1, a2);
		const stamp = String(row.graph_id).replace("ut-ledger-proof-", "");
		await insertRow({ ...row, summary: "06-09 tampered (a) " + stamp });
		out("written_at", new Date().toISOString());
		break;
	}
	case "tamper-b": {
		const row = captured(a1, a2);
		const stamp = String(row.graph_id).replace("ut-ledger-proof-", "");
		const tampered: Row = { ...row, summary: "06-09 tampered (b) " + stamp };
		tampered.hash = recomputed(tampered);
		await insertRow(tampered);
		out("written_at", new Date().toISOString());
		out("tampered_hash", tampered.hash);
		break;
	}
	case "restore": {
		await insertRow(captured(a1, a2));
		out("restored_at", new Date().toISOString());
		break;
	}
	case "readback": {
		const row = captured(a1, a2);
		const atKey = await keyRows(row);
		const graph = await graphRows(row.graph_id);
		out("key_rows", atKey.length);
		out("graph_rows", graph.length);
		const live = atKey[0];
		if (live) {
			out("live_id", live.id);
			out("summary_changed", live.summary !== row.summary);
			out("hash_equals_original", live.hash === row.hash);
			out("hash_equals_recomputed", live.hash === recomputed(live));
			out("byte_equal_original", canonicalJson(live) === canonicalJson(row));
		}
		break;
	}
	case "final": {
		const rows = JSON.parse(readFileSync(a1, "utf8")) as Row[];
		let equal = 0;
		for (const row of rows) {
			const live = await g.sql("SELECT " + SELECT + ' FROM "agent_events" WHERE "id" = ' + quote(String(row.id)));
			if (live.length === 1 && canonicalJson(live[0]) === canonicalJson(row)) equal++;
		}
		const anchors = await g.sql('SELECT count(*) AS "n" FROM "anchors"');
		out("rows_equal", equal + "/" + rows.length);
		out("anchors_rows", anchors[0]?.n);
		break;
	}
	default:
		throw new Error("usage: capture|successor|tamper-a|tamper-b|restore|readback|final");
}
```

## Gaps

- D-17 residual risk, accepted with the owner's anchoring skip: a consistent rewrite of the middle
  row and every later row through the chain head (each hash and prev recomputed in order), followed
  by a substrate-mcp restart that re-seeds the in-memory head, passes the chain and would have
  needed the skipped anchor to catch. Not attempted here.
- Tamper windows: (a) 7.398 s and (b) 7.700 s, during which every graph with events in ingest hour
  2026-09-27T13:00:00.000Z (57 events at the time) would have verified as broken.
- D-12 step 2 (wait until the hour is anchored) was not run: nothing is anchored (D-17), and no
  timer exists (06-08 not executed).
