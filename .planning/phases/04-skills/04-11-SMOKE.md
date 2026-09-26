# 04-11 Cursor stop hook evidence

Recorded from observed output only. Host run on 2026-09-26 (UTC) from
`/root/src/repos/agent-substrate` after commit `c29e8c5` (Task 1). `bun` below is
`/root/.local/share/reflex/bun/bin/bun`.

## Snapshot and restore route

```
C=/var/lib/substrate/phase4-baseline/04-11/20260926T090800Z
sudo install -d -m 0700 /var/lib/substrate/phase4-baseline/04-11 $C
sudo cp -a /root/.cursor/hooks.json $C/hooks.json
sudo sh -c "cd $C && sha256sum hooks.json > MANIFEST.sha256"      # sha256sum -c: hooks.json: OK
# route written before the projection:
/var/lib/substrate/phase4-baseline/RESTORE.d/04-11.md   (cp -a $C/hooks.json /root/.cursor/hooks.json)
```

## Hook projection

```
$ grep -c '"gsd-managed": true' /root/.cursor/hooks.json
6
$ bun packages/projector/src/cursor.ts --check
[projector] would change: ~ stop                        (exit 1)
$ bun packages/projector/src/cursor.ts
[projector] /root/.cursor/hooks.json: ~ stop (6 gsd-managed entries untouched, backup at /root/.cursor/hooks.json.substrate-backup)
$ bun packages/projector/src/cursor.ts --check
[projector] /root/.cursor/hooks.json already current (6 gsd-managed entries untouched)   (exit 0)
$ python3 -c "import json; h=json.load(open('/root/.cursor/hooks.json'))['hooks']; s=[e for e in h['stop'] if e.get('substrate-managed')]; print(len(s), s[0]['command'])"
1 bun /root/src/repos/agent-substrate/packages/collectors/src/cursor-stop.ts >/dev/null 2>&1 || true
```

Comparing the snapshot with the live file (python3 json): the only changed event is `stop`; the
non-substrate `stop` entries, every other event list and every top-level key are equal.

check_before_exit=1
projector_change=~ stop
check_after_exit=0
stop_entry_script=true
gsd_managed_before=6
gsd_managed_after=6

## Transcripts directory

```
$ sudo install -d -m 0700 /var/lib/substrate/transcripts /var/lib/substrate/transcripts/cursor
$ stat -c '%a %U' /var/lib/substrate/transcripts /var/lib/substrate/transcripts/cursor
700 root
700 root
```

transcripts_dir_mode=700

## Live fail-open checks

Each run piped the envelope into `bun packages/collectors/src/cursor-stop.ts`, captured stdout and
stderr to files and timed the run. The substrate was up (`systemctl is-active substrate-mcp`:
active; anonymous `GET /healthz`: 200), so each run also posted a `session.end` event.

```
printf '%s' '{"conversation_id":"p4-smoke-null-0001","transcript_path":null,"status":"completed","hook_event_name":"stop"}' | bun packages/collectors/src/cursor-stop.ts
  -> exit 0, stdout 0 bytes, stderr 0 bytes, 499 ms
printf '%s' '{"conversation_id":"p4-smoke-outside-0001","transcript_path":"/etc/hostname","status":"completed","hook_event_name":"stop"}' | bun packages/collectors/src/cursor-stop.ts
  -> exit 0, stdout 0 bytes, stderr 0 bytes, 493 ms; /var/lib/substrate/transcripts/cursor/p4-smoke-outside-0001.jsonl absent
printf 'not json' | bun packages/collectors/src/cursor-stop.ts
  -> exit 0, stdout 0 bytes, stderr 0 bytes, 289 ms
$ ls -A /var/lib/substrate/transcripts/cursor | wc -l
0
$ stat -c %a /var/lib/substrate/transcripts/cursor
700
```

No synthetic transcript was written (D-15): only a null path, an out-of-root path and a malformed
envelope were used.

null_path_exit=0
null_path_stdout_bytes=0
outside_path_exit=0
outside_path_file_written=false
bad_json_exit=0
transcripts_after=0

## Gaps

- A real transcript copy is not observed here: the bundled cursor-agent CLI is not signed in and
  fires no hooks in print mode (research Summary 4), and D-15 forbids seeding a synthetic
  transcript. The first live copy is observed in the owner's Cursor session in 04-12; until then the
  copy path (containment, redaction, 0600/0700, tmp + rename, 20 MB cap) is proven by
  `packages/collectors/src/cursor-stop.test.ts` only.
- `transcript_path` can be null when Cursor's transcripts are off (research risk register); the hook
  then emits `session.end` with `transcript_ref: null` and reason `no transcript_path`, and the miner
  has nothing to read for that session.
- The posted `session.end` events were not read back (the substrate exposes no event-read route on
  its HTTP surface); acceptance of the POST is inferred from the anonymous `/healthz` 200 and the same
  auth gate guarding `/events`.
