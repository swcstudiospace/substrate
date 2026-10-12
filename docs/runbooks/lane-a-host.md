# Runbook — lane-A host install and restart (substrate-host)

| | |
| --- | --- |
| Requirements | LANEA-01, LANEA-02, LANEA-03, LANEA-05, LANEA-07 |
| Window | Operator-approved, after this phase merges to `main` |
| Scope | `substrate-host.service` running one rivet-agentos VM per Graph ID on this host |
| Untouched | `gcs-rivet-rivet-engine-1` (another project's container, never touched), `substrate-mcp.service`, `substrate-dispatcher.service` |

## Status

Staged, not installed: `infra/vps/substrate-host.service` exists in the repo
(Phase 31); no unit is installed and no VM has booted. The rehearsal proof
(`bun run smoke:host`, 38 checks green with fakes: the 31 two-VM proof plus
the 32 worked-node sequence) and the spike step-0
(`bun scripts/host-spike.ts --check` clean) are the in-repo evidence. The live
tail below is OPERATOR-GATED — the spike runner stops at G1 by design (exit 3),
and the 32 tail stops at L1 by plan contract.

Names only below — no file in git holds an environment value, and no token
value, passphrase, or non-loopback hostname is ever typed into a record.
Report the bearers by name (`SUBSTRATE_TOKEN_CLAUDE_CODE` for the lease bearer,
`SUBSTRATE_TOKEN_SUBSTRATE` for the host-job bearer); report the lease by
presence (`lease_id` persisted / heartbeat ok), never by value.

## Engine share-vs-own outcome (D31-04)

| | |
| --- | --- |
| Spike G2 verdict | UNVERIFIED (gated tail not run) |
| Unit env until verdict | Share mode: `SUBSTRATE_ENGINE_ENDPOINT=http://127.0.0.1:6420`, no `RIVET_RUN_ENGINE=1` |
| Fallback (pre-approved, env-only) | Second loopback engine on a free port, only when the shared engine refuses the host's actors |
| Invariant | The engine stays on loopback; the other project's container keeps running untouched |

`main.ts` refuses to boot with `RIVET_RUN_ENGINE=1` until G2 records its
verdict — share mode only until then.

## Disk and port budget (LANEA-05, D31-07)

| Item | Budget |
| --- | --- |
| Disk free `/` (spike step-0) | 128308633600 bytes (~120 GiB) |
| In-code floor (build/pull) | 10737418240 bytes (10 GiB), fail-closed on unreadable `df` |
| npm install footprint (G1 precedent) | ~2.2 GB in a scratch copy, never the repo dir |
| Sandbox image `substrate-sandbox:0.1` | absent; base pulls exceed 2 GB of network (gated) |
| Agentos store `/var/lib/substrate/agentos` | 332755597 bytes (~317 M), left alone |
| `127.0.0.1:6420` | rivet engine (shared, UNVERIFIED) |
| `127.0.0.1:7410` | substrate-mcp (guarded: the spike refuses it as a probe target) |
| `127.0.0.1:7411` | substrate-host API (free until G4) |

## Operator-gated live sequence

### G1 — dependency footprint

- Preconditions: spike step-0 clean (`--check` exit 0); 10 GiB floor holds.
- Run: the exact commands the spike runner prints (`cp -r packages/host /tmp/host-spike-*`, `npm ci`, `du`, agentos import resolve check).
- Record in `31-SPIKE.md`: npm tree bytes, wall time, import resolves yes/no.
- Rollback: `rm -rf /tmp/host-spike-*` (the repo tree is never installed into).

### G2 — engine share session

- Preconditions: G1 green; 6420 served; engine container healthy.
- Run: open one session on a scratch graph id through the shared engine (commands printed by the runner); fallback second loopback engine only on refusal.
- Record: shared engine serves yes/no (+ refusal text), container still healthy, unit engine env fixed by the outcome.
- Rollback: unload the session; the engine container is never restarted by this phase.

### G3 — no-KVM boot

- Preconditions: G2 green; no sandbox container; no substrate writes; no Linear/Notion calls.
- Run: one VM open → echo-only prompt → dispose → unload (commands printed by the runner).
- Record: boot verdict pass (no KVM needed) or gap (exact `/dev/kvm` demand text); dispose-hook execution; fresh-vs-stale note. A gap is recorded, never faked past.
- Rollback: dispose the VM, unload the session, remove the scratch dir.

### G4 — unit install and restart

- Preconditions: G1–G3 green; `/etc/substrate/substrate-host.env` present (root-owned, 0600, names `SUBSTRATE_TOKEN_SUBSTRATE`); 10 GiB floor holds; image present or build approved in the same window.

```sh
# 1. Install the staged unit (never edited in place).
install -m 0644 infra/vps/substrate-host.service /etc/systemd/system/
systemctl daemon-reload
# 2. Start and watch: engine mode line, orphan sweep, interrupted-turn resume.
systemctl enable --now substrate-host
journalctl -u substrate-host -f
# 3. Prove live: the dispatcher HostClient stops getting host-unreachable.
curl -s http://127.0.0.1:7411/healthz
```

- Record: unit active, `/healthz` reports engine + api, dispatcher log shows the first accepted task.
- Rollback: `systemctl stop substrate-host` disposes every VM (sandbox containers included); the manifest row stays `dormant:31` until this gated restart flips it.

## Lease, heartbeat and re-claim (LANEA-02, D32-02..D32-04)

| Item | Rule |
| --- | --- |
| Claim | `openTask` claims as `claude-code` through `claimAndPersist` under the lease bearer; the granted `lease.lease_id` persists 0600 beside the task records (`<storage>/leases`, sibling of `<storage>/tasks`), read back before the open proceeds. A wrong-surface bearer is refused server-side (`not-holder`), never loosened. |
| Heartbeat | Tick at half-TTL (~450 s of the 900 s TTL) while `turn_in_flight`; fenced on the persisted `lease_id` under the lease bearer |
| Refusal | Exactly one `claimAndPersist` re-claim, never an extension; a refused re-claim fails the turn closed and releases fenced |
| Release | Single fenced `releaseOnce` helper guarded by the record's `released` flag: settle, failure, kill, terminate, completion, lease-loss. Sends only the persisted `lease_id` (or null); consumes the reply's `released` flag — a refusal or transport error never marks the record released. Never force (operator-only). |
| Completion | `graph_complete` with the persisted `lease_id` + DoD (`summary` non-empty capped, `tests_pass`, optional `review_pass`); the server drops the lease, the record is marked released |
| Missing lease | A real persist throw compensates inside `claimAndPersist` with the captured grant's own `lease_id` (fenced, never force) and throws names-only; `openTask` answers 502 before any VM work with no claimed lease left. A grant without a readable lease file compensates once the same way and answers 502 |

Logs report presence only (`lease persisted …: yes`, `heartbeat ok/refused`) — never a `lease_id` or bearer value.

## Restart and resume (LANEA-03, D32-05/D32-06)

1. SIGTERM/SIGINT → `beginShutdown()` → in-flight prompt rejections keep their records in flight; heartbeat ticks stop.
2. Records (`<storage>/tasks`, 0600 JSON) and leases (`<storage>/leases`, 0600) survive under the unit's `StateDirectory=substrate`.
3. Boot runs `resumeInterrupted()` once: per interrupted task (`turn_in_flight`, still claimed, not finished) — re-establish the model route, heartbeat-or-reclaim the persisted lease, then send exactly one continuation keyed `<gid>:<nid>:resume:<n>`.
4. A task whose route and heartbeat both fail is marked failed on its own; the others still resume. Stale approvals move to `stale_approvals`.
5. A second boot without new work sends zero new prompts (no replay).

## Approvals (LANEA-06, D33-04..D33-06)

Every session `permission_request` is recorded with a deadline and posted to
the Telegram approval broker as single-use Approve/Deny buttons; a tap
answers exactly once through `respondApproval`, a second tap reads `expired`.
An unanswered request auto-denies fail-closed — nothing waits forever.

| Item | Rule |
| --- | --- |
| Deadline | `recorded_at + approvalTimeoutMs`, default 900 s (same ladder as lease TTL and claim timeout), tunable by `SUBSTRATE_APPROVAL_TIMEOUT_S` (seconds; malformed falls back logged) |
| Sweep | Heartbeat tick evaluates deadlines alongside `heartbeatDue` (no new timer lifetime — the tick is armed exactly while `turn_in_flight`); expiry auto-denies through the `respondApproval` path (same deny call, same `approvals_denied` increment, same pending-clearing, plus a `timeout` log line with ids only) |
| Deny | Deny-on-timeout, never allow: the turn fails closed through the existing turn-failure → single-release path |
| Race | Tap and sweep funnel through the same single-answer claim: the loser reads `not_pending`/`expired` |
| Resume | Stale approvals of the dead process count off to `stale_approvals` first; live deadlines arm on the new boot only |
| Logs | Presence-only (`approval pending/timeout <gid>/<nid> request <id>`); approval input text, bearer values, and `lease_id`s never printed |

Approvals-channel checklist (names only — values never enter the repo):

1. `SUBSTRATE_APPROVAL_BOT_TOKEN`, `SUBSTRATE_APPROVAL_CHAT_ID`, `SUBSTRATE_APPROVAL_USER_IDS` provisioned in the unit env file.
2. `whoami` check at boot: the journal shows `telegram approvals on (bot @<name>)`, else `telegram approvals off` and requests park until the deadline.
3. Poll health: `getUpdates` long-poll with 409 → 30 s backoff, error → 5 s backoff, offset persisted in `<storage>/approvals.json` (0600).
4. Live expectation: taps inside the 900 s window; a slower human's work auto-denies, fails closed, and is resumable — never half-applied.

## Credential containment (LANEA-07, D32-07/D32-08)

| Item | Rule |
| --- | --- |
| Unit env file | `/etc/substrate/substrate-host.env` (root-owned, 0600): names `SUBSTRATE_TOKEN_SUBSTRATE` (host-job reads) and `SUBSTRATE_TOKEN_CLAUDE_CODE` (lease claim/heartbeat/release/complete); values never enter the repo, a record, or a transcript |
| Tokens-dir order | Lease: `SUBSTRATE_TOKEN_CLAUDE_CODE` → `SUBSTRATE_TOKEN` → file → tokens dir `claude-code`; job: `SUBSTRATE_TOKEN_SUBSTRATE` → `SUBSTRATE_TOKEN` → file → tokens dir `substrate`; resolved host-side only, never cross-surface fallback |
| No seed credential | No bearer is seeded into the VM (no `.claude.json`/env/files entry on any route). s:mcp entry points at the in-VM relay (`127.0.0.1:7413`, VM-local); s:hostfn entry stays headerless and inert (host functions are that route's channel) |
| Guest MCP relay | s:mcp only: the in-VM relay pipes the guest MCP exchange to the `substrate-mcp` host function (`handleSubstrateRelayRequest` in `packages/host/src/substrate-relay.ts`, no rivet import — the parent throwaway entrypoint), which answers protocol methods locally and executes only `issue_get`/`graph_release`/`graph_complete` through the shared TaskService transitions (`complete`/`guestRelease`, same terminal state as every path), plus `graph_register` as a bound idempotent re-register of the host's canonical graph (identity/nodes/steps from the canonical view; guest graph/repo/branch/steps/lease/authority ignored, edges never written, real upsert return). Guest-supplied graph/session/lease/force are never read; refusals return as data unmarked. The relay proves a real initialize handshake (serverInfo name + protocol version, never a bare HTTP response) before sessions.open and every prompt inside a bounded 30 s budget; expiry throws into claim/release compensation. Restarted on resume |
| Lifecycle authority | Host-credentialed callbacks (commit/push/PR/sync/complete/run-tests, both guest routes) run only for live tasks: `released` or settled-failed records are refused (`mutationRefusal` shared rule). Terminal release transitions stay exempt. Lease loss marks the record failed synchronously, then cancels + unloads the session best-effort; cancellation delay/failure never restores authority, and prompt settlement never overwrites the recorded failure |
| Tracker proxy | Seeded notion/linear entries point at the loopback tracker proxy; inert off `tracker_route vm_mcp`; the VM never gets a tracker key |
| Host git/gh | `git -C <worktree> push origin substrate/<gid>`, `gh pr create --repo/--head/--base` fixed by the graph, commit identity fixed; guest supplies title/body/message text within limits only; `.substrate-*` excluded from every add; scratch guard before any network call |
| Host sync | `NOTION_API_KEY`/`LINEAR_API_KEY` read in the host process only; sync writes PR URL / PR # / PR State / Repo / Branch and the Linear PR link — no workflow state, no Notion Status, never Done (Done comes only from `graph_complete` through the DoD gate) |

## Operator-gated live tail L1-L4 (32-03 — the executor stops at L1, never runs it)

Each gate below is OPERATOR-GATED: preconditions checked, window approved, evidence recorded, rollback run. Out of scope even for the tail: real pushes/PRs on non-throwaway repos, Linear/Notion writes outside the isolated graph, `RIVET_RUN_ENGINE=1` (refused by `main.ts` until the G2 verdict), base-image pulls beyond the L1 window.

The v1.3 lane-A cutover itself is the LANEA-08 G1–G5 sequence in `docs/runbooks/dispatch-proof.md` (label wiring → real VM → real approvals → real push/PR/sync with gated Done → unit activations with both manifest flips); the L-gates below cover this host's install half only.

### L1 — OPERATOR-GATED: real VM-backed node run

- Preconditions: `bun scripts/host-spike.ts --check` exit 0; rehearsal half green (`bun run smoke:host` 38/38, `bun test packages/host/` green); operator-approved window (spends Claude Code quota + Docker capacity).
- Gate: OPERATOR-GATED — the executor stops here; a human approves the window and runs the step.
- Run: one node on an isolated graph against a throwaway repo — claim → heartbeat ticks during the turn → prompt settles → host-side commit → push → pr-create → sync → complete with DoD + lease → single release.
- Record: claim→heartbeat→resume→PR evidence, quota spent.
- Rollback: release the claim (`agentos-substrate release`), dispose the VM, delete the throwaway repo; the manifest stays `dormant:31`.

### L2 — OPERATOR-GATED: production unit install/restart

- Preconditions: L1 green; the restart sequence above reviewed.
- Gate: OPERATOR-GATED — the executor stops here; a human approves the window and runs the step.
- Run: install the staged unit, start, stop (records stay in flight), start again, verify the one resume pass and its continuation.
- Verify after the restart: `journalctl -u substrate-host` shows `interrupted turns resumed: N` with one `resumed <gid>/<nid> key <gid>:<nid>:resume:<n>` line per interrupted task; a second restart without new work resumes nothing.
- Record: runbook checkbox + `systemctl` evidence (unit active, `/healthz` reports engine + api).
- Rollback: `systemctl stop substrate-host` disposes every VM; the manifest row stays `dormant:31` until this gated restart flips it.

### L3 — OPERATOR-GATED: manifest `dormant:31` → `live` flip

- Preconditions: L2 green (expected 401s clear).
- Gate: OPERATOR-GATED — the executor stops here; a human approves the window and runs the step.
- Run: flip the `substrate-host` row in `infra/identity/clients.json` to `live`.
- Record: manifest diff + 2xx evidence.
- Rollback: flip back to `dormant:31`.

### L4 — OPERATOR-GATED: any real `claude-code` model quota spend outside L1's window

- Preconditions: explicit approval per run.
- Gate: OPERATOR-GATED — the executor stops here; a human approves the window and runs the step.
- Record: spend note per run.
- Rollback: none needed (spend is recorded, not undone); further runs need fresh approval.

## Never-type-secrets class

No token value, passphrase, or bus secret is typed into a shell history, a
record, or a transcript for any step above. Files that must name a credential
name its variable (`SUBSTRATE_TOKEN_SUBSTRATE`, `SUBSTRATE_VM_ANTHROPIC_API_KEY`
on route `a:anthropic_key` only). Non-loopback hostnames stay out of the repo,
the PR, and the record.
