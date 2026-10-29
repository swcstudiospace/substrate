# 30-PROOF: desktop_run proof (DESK-05)

**Status: corrected real-runtime proof PASSED 20/20, 2026-10-11.**
Parent-owned execution on `/root/src/worktrees/agent-substrate-v13-autonomous`,
revision `4df30a0` plus owned source corrections. No production MCP request,
model turn, credential read/rotation, service restart, main merge or unrelated
container change. Final source-union gates are recorded separately; a successful
runtime proof does not replace them or complete the milestone.

- `band_pixels=9120`, `baseline_pixels=0`, `band_rect=480x19`, `solid=true`
- `block_sha=file_sha=event_sha=true` for both screenshots
- `tool_call_events=5/5`, hash-only payloads, typed text/base64 absent
- `audit_mode=fail-closed`, `desktop_run_records=2`, content absent
- `unlisted_refusal=true`, surface-event count `5→5`
- `no_token_401=true`, `port_6081_401=true`
- `recruitment_snapshot=absent→absent`, authoritative inventory successful
- `desktop_status=loopback/unprivileged/no-docker-socket/role-desktop`

## 1. Historical isolated evidence, 2026-10-09

Worktree HEAD `cbccd4b`: helper suite **20 pass / 0 fail**; full suite
**1735 pass / 57 skip / 0 fail**, 61 files; `tsc` clean; phase-close exit 0,
`EVENT_KINDS=12`, `SURFACES=27`. Individual historical locks: store18,
redact-lock15, redact-contract7, vocabulary2 passed. Exit-2 guards refused an
absent instance, an unknown flag and a fabricated production-port target before
any request. The initial record had no live verdict; those counts are historical,
not a separate current execution.

## 2. Corrected actual proof, 2026-10-11

Named twin **`v13-proof-230c1bd0`**, private HOME/XDG runtime, free loopback
port, `omp` allowlisted and `cursor` unlisted. Existing dedicated desktop had
verified role `desktop`, geometry `1280x800`, loopback6081, no privilege or Docker
socket. Its image was already local; nothing was pulled or created by this proof.

Parent command sequence, with scratch credentials sourced privately and never
printed:

```sh
bun --no-env-file scripts/rehearsal.ts up --name v13-proof-230c1bd0 --port 0 --skills-fixture --desktop-surfaces omp
bun --no-env-file scripts/desktop-smoke.ts --name v13-proof-230c1bd0 --surface omp --unlisted cursor
bun --no-env-file scripts/rehearsal.ts down --name v13-proof-230c1bd0
```

Up, proof and down each exited **0**. The proof returned two PNG image blocks and
five successful action-log entries. The exact nonce RGB occurred in **9120** pixels
forming one solid **480×19** rectangle and occurred **0** times in the baseline.
Both returned block hashes matched reply hashes, stored PNG bytes and ledger-event
hashes; stored sizes were **532677** and **325285** bytes. Five `tool.call` rows under
the run session carried allowed metadata and typed-text hashes only, never typed
text or a base64 prefix. The unlisted bearer was refused without a new desktop
event; tokenless MCP and unauthenticated6081 each returned401. Two audit records
were fail-closed and content-free.

Before and after, a successful exact-name Docker inventory established the
unrelated desktop was absent. The snapshot distinguishes present, absent and
error: appearance, disappearance, changed metadata or any failed probe fails;
absence is not inferred from an inspect error. No unrelated container was
created, started, stopped or changed. Down stopped only the owned rehearsal
process and removed its two scratch store containers. The dedicated desktop
remains running; every proof-owned terminal was closed.

The N1 spike is separately recorded in `30-N1-SPIKE.md`: three measured real
as-ported XWD→PNG repeats, each9120 solid pixels/baseline0, with per-call timings
and host steal sampled. **`n1_reproduced=false`**; no capture-path change or
window-title substitute was needed.

The corrected source also refused the parent's failed-locality fixture with
**zero input actions and zero events**; before correction it had executed one
input and emitted one event. Unknown Docker locality now fails closed before
geometry, input, capture or lifecycle operations.

## 3. First actual run — FAILED18/20, preserved

At revision `4df30a0`, twin `p21-a6a927a5`, the first proof exited1 with
**18/20** checks passed. Both failures were unrelated-desktop inspect checks: a
successful exact-name inventory returned zero rows, but the old null-on-error
snapshot conflated legitimate absence with metadata-probe failure.

The first run already observed9120 solid480×19 pixels/baseline0, two PNGs with
matching block/file/event hashes, five hash-only ledger rows, unchanged unlisted
surface count5→5, both401 checks, correct desktop status and two fail-closed audit
records. Its own twin was torn down with exit0 and two owned containers removed.
This historical18/20 remains a **FAIL**, not a retrospectively renamed pass.
The corrected20/20 in §2 is a separate observed run.

## 4. Scope and remaining gates

Source: parent values-free `local://v13-final-runtime-evidence.json` and
`local://v13-phase30-spike-evidence.json`. These are local parent evidence, not
production approval or a remote deployment receipt. Full source tests, types,
locks and native review/security/Nyquist/goal-verification reports must be current
before the phase owner seals Phase30. Phase20 production identity/client/UAT
checkpoints and the exposed Cursor credential's operator rotation remain pending.
