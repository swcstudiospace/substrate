# Runbook — desktop_run for substrate-desktop

| | |
| --- | --- |
| Requirement | DESK-01..05 |
| Scope | The `desktop_run` MCP tool driving the dedicated `substrate-desktop` webtop (click, type, key, screenshot) |
| Untouched | `recruitment-desktop` (inspect-only, always), production surface tokens (Phase 20), the production allowlist value (operator, after merge) |

## What this runbook proves, and how

The proof is `scripts/desktop-smoke.ts`, run as `bun run smoke:desktop`: a
scripted MCP session over the harness twin — no model, no quota — that types
a nonce-coloured marker band into a fresh terminal on the live
`substrate-desktop` container and checks pixels, events, audit, refusals and
container state. Commands as run, from the Phase 30 worktree. Nothing below
touches a production store; `recruitment-desktop` is only inspected; no
command carries or prints a credential.

The check exits `0` on pass, `1` on a failed criterion, `2` when it could not
ask (no instance, a refused target, missing token files, or an unreachable
twin). It prints hashes, sizes, counts and booleans — never a bearer, a
password or typed text.

It checks, in order:

1. The twin answers `/healthz`, and `recruitment-desktop` inspects cleanly
   before anything runs.
2. `substrate-desktop.sh status` answers with its key=value lines.
3. One marker run — baseline screenshot, `key ctrl+alt+t`, the typed marker,
   a second screenshot, a closing `exit` — is accepted.
4. The returned after-image holds at least 1500 pixels of the exact nonce RGB
   forming one solid rectangle, and the baseline holds none. A stale or
   absent band is a FAIL, never a pass: titles are not proof.
5. Each block's sha256 equals the stored file's and the event's sha256.
6. One stored `tool.call` per executed action under `desktop:<run_id>`,
   with `text_sha256` equal to the typed text's sha256 and no typed text or
   base64 prefix in any payload.
7. An unlisted surface's valid token is refused with no new event, no token
   is a 401, and the 6081 root without credentials is a 401.
8. `recruitment-desktop` inspects identical after, and `status` shows the
   loopback port, unprivileged, no socket and the desktop label.
9. The harness audit file holds the `desktop_run` record fail-closed with
   none of the typed text or base64.

## Proof chain

```sh
bun run rehearsal up --name p30 --surfaces omp,cursor --desktop-surfaces omp
bun run smoke:desktop --name p30
bun run check:phase-close
bun run rehearsal down --name p30
```

`rehearsal up` writes `SUBSTRATE_DESKTOP_SURFACES=omp` and
`SUBSTRATE_DESKTOP_DIR=<runDir>/desktop` into the twin's environment and one
bearer file per surface under `<runDir>/tokens/`. The smoke reads the twin
URL from `consumer.env`, the bearers from the tokens dir, and refuses a
production port or a non-loopback host before any request. `rehearsal down`
removes the twin, its containers and the whole run dir — screenshots
included — so the proof numbers (band count and rectangle, the three sha256
equalities, the event count, the audit verdict, both inspect lines, the
status lines) go into `30-PROOF.md` before teardown.

## Allowlist

`SUBSTRATE_DESKTOP_SURFACES` (comma-separated surface names) in the service
environment is the only gate. Unset or empty means nobody may call
`desktop_run` — the fail-closed default. A name outside `SURFACES` is dropped
and reported at boot by name only; it never widens the list. `isOperator`
grants nothing here: an operator token on an unlisted surface is still
refused.

Until Phase 20 provisions production tokens, every production caller is
anonymous and therefore refused, whatever the allowlist says. Leave
production empty until the operator names surfaces after merge.

## Lifecycle

`infra/desktop/substrate-desktop.sh` has two verbs and names one container.
`up` checks root, 10 GiB free, a local image (never pulls), the basic-auth
file, and the role label on an existing same-named container, then starts or
creates it on `127.0.0.1:6081` and waits for the `1280 800` geometry.
`status` prints key=value lines (ports, geometry, image, label role,
privileged, mounts, socket). The script never stops, removes or pulls
anything, and never names `recruitment-desktop`.

```sh
sudo infra/desktop/substrate-desktop.sh up
sudo infra/desktop/substrate-desktop.sh status
```

## Basic auth

The web view on `127.0.0.1:6081` sits behind basic auth whose file lives at
`/etc/substrate/substrate-desktop.env` (root-owned, mode 0600, named here by
path only). The smoke proves the gate with a credentialless `GET /`, which
must answer 401; credentials are never read or printed.

## Retention

Screenshots land under `<desktopDir>/<run_id>/<n>.png` (dirs 0700, files
0600); the newest 200 runs and 7 days are kept, the current run always. The
harness points the dir into its run directory, so teardown cleans it. The
first production run after merge prunes run dirs older than 7 days from
`/var/lib/substrate/desktop` — September's evidence PNGs included — so the
operator copies those aside first if they are to be kept.

## Hashing rule: never type secrets

Typed text is recorded as `text_len` plus `text_sha256`, key chords as
`keys` only for modifier chords and fixed non-printing keys and as
`keys_len` plus `keys_sha256` otherwise, screenshots as sha256 plus
dimensions. No image bytes and no text ever enter an event or the audit
record. Residual risk: an unsalted sha256 of a short typed value (a PIN, a
short password) is brute-forceable by any ledger reader — never type secrets
through `desktop_run`.

## Egress residual

The container is unprivileged, has no host mounts and no Docker socket, and
publishes only the loopback port — but its terminal and browser have network
egress and can reach host services bound to all interfaces through the
bridge gateway. Loopback-only services are not reachable from the bridge.
Accepted by design; recorded here so no caller treats the desktop as
air-gapped.

## Timeouts

A run may last up to 120 s, so the caller's tool timeout must sit above that
ceiling: the smoke uses the run timeout plus 60 s (180 s for a full run),
never a 60 s default. A timed-out `docker exec` kills only the local client;
the keystrokes already sent may still land inside the container and spill
into the next run's window. Documented, not fixed: a kill path would be a
new program in the fixed argv table. A 50-screenshot run answers on the
order of 35 MB with no cap in the locked vocabulary.

## Rollback

Operator only: clear `SUBSTRATE_DESKTOP_SURFACES` (empty means nobody) and
restart the unit in an approved window. Every call is then refused before
anything runs; stored screenshots and the ledger are untouched. The harness
needs no rollback: `bun run rehearsal down` removes everything it made.

## Who does what

- The operator owns the allowlist value, the basic-auth file, production
  restarts, and copying September's evidence PNGs aside before the first
  production run.
- The phase proof owns the harness twin, the smoke run and `30-PROOF.md`.
- Agents never touch `recruitment-desktop`, never read credential files, and
  never type secrets through `desktop_run`.
