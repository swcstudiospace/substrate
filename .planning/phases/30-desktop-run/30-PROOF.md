# 30-PROOF: desktop_run proof (DESK-05)

**Status: LIVE-GATED — live chain NOT RUN.** The proof chain below drives the
live `substrate-desktop` display (keystrokes plus captures) and scrubs
harness containers, so it was neither executed nor simulated. Every live
verdict field reads `NOT-RUN`. The hermetic evidence (§1) was observed on
this worktree; the live battery (§2) is implemented as code
(`scripts/desktop-smoke.ts`, `bun run smoke:desktop`) and awaits a live run.

- `band_pixels=NOT-RUN`
- `band_rect=NOT-RUN`
- `block_sha=file_sha=event_sha=NOT-RUN`
- `tool_call_events=NOT-RUN`
- `audit_mode=NOT-RUN`
- `unlisted_refusal=NOT-RUN`
- `no_token_401=NOT-RUN`
- `port_6081_401=NOT-RUN`
- `recruitment_inspect=NOT-RUN`
- `desktop_status=NOT-RUN`

## 1. Isolated evidence (observed 2026-10-09, worktree HEAD `cbccd4b`)

- `bun test ./scripts/desktop-smoke.test.ts` — **20 pass / 0 fail**
  (56 expects): band finder exact on synthetic PNG round trips (48×19 rect
  found byte-exact; absent colour empty; split blobs counted but not solid),
  marker parses under `DesktopRunInput`, nonce channel reaches `0xC0`,
  guards refuse production ports and non-loopback hosts.
- `bun test` (full) — **1735 pass / 57 skip / 0 fail** across 61 files
  (6493 expects). Baseline held; growth is the 20 new helper tests.
- `bunx tsc --noEmit` — **clean**.
- `bun run check:phase-close` — **exit 0**: 4 lock files green
  (store, vocabulary, event-sources, audit policy), `EVENT_KINDS` unchanged
  at 12 against `ab62c91`, `SURFACES` baseline plus `substrate` at 27.
- Lock suites over the new files, each green on its own invocation:
  store-lock 18 pass, redact-lock 15 pass, redact-contract 7 pass,
  vocabulary-lock 2 pass.
- Hermetic refusal probes of the smoke entry (zero requests sent — every
  refusal precedes any network or container I/O):
  - `--name no-such-instance-xyz` → exit 2,
    `no consumer.env for instance …: run rehearsal up first`;
  - `--bogus-flag` → exit 2, `unknown option --bogus-flag`;
  - fabricated `consumer.env` with `SUBSTRATE_URL=http://127.0.0.1:7410`
    → exit 2, `refusing to smoke production :7410`.

## 2. Live proof chain (NOT-RUN — procedure for the live run)

Run in order from the Phase 30 worktree, recording the listed numbers here
before teardown removes the run dir:

```sh
bun run rehearsal up --name p30 --surfaces omp,cursor --desktop-surfaces omp
bun run smoke:desktop --name p30
bun run check:phase-close
bun run rehearsal down --name p30
```

Expected readings, per check line:

1. `marker run accepted` — exit path taken; the run text names `run_id`,
   2 screenshots and 5 log entries.
2. `band in returned block, none in baseline` — band pixel count (≥ 1500),
   rectangle (`WxH`), solidity, baseline count (0).
3. `shot N block sha equals reply sha` — the returned block's sha256
   (12-char prefix shown) per shot.
4. `shot N stored file equals reply sha` — stored file size in bytes per
   shot; equality of block, file and event sha256 values.
5. `one stored tool.call per action with hashes only` — `5/5` rows under
   `session_id desktop:<run_id>`, `text_sha256` equal to the typed texts'
   sha256, no typed text or `iVBOR` in any payload.
6. `unlisted token refused` + `refusal stored no new event` — the isError
   refusal line and the unchanged row count.
7. `no token 401` and `6081 root without credentials 401` — both status
   lines (credentials never read or printed).
8. `recruitment-desktop inspect before/after` — the two identical
   `Id Status StartedAt FinishedAt` lines.
9. `status shows loopback port, unprivileged, no socket, desktop label` —
   the four `status` key lines.
10. `audit holds fail-closed desktop_run with no content` — the
    `desktop_run` record count, every record `mode: fail-closed`, no typed
    text or `iVBOR`.

Per D30-18: if the band pixels come back stale or absent, the pixel clause
is recorded here as a gap — never passed on window titles. No gap is
claimed by this record: no live run was attempted.
