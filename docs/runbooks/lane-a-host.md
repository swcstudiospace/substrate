# Runbook — lane-A host install and restart (substrate-host)

| | |
| --- | --- |
| Requirements | LANEA-01, LANEA-05 |
| Window | Operator-approved, after this phase merges to `main` |
| Scope | `substrate-host.service` running one rivet-agentos VM per Graph ID on this host |
| Untouched | `gcs-rivet-rivet-engine-1` (another project's container, never touched), `substrate-mcp.service`, `substrate-dispatcher.service` |

## Status

Staged, not installed: `infra/vps/substrate-host.service` exists in the repo
(Phase 31); no unit is installed and no VM has booted. The rehearsal proof
(`bun run smoke:host`, 23 checks green with fakes) and the spike step-0
(`bun scripts/host-spike.ts --check` clean) are the in-repo evidence. The live
tail below is OPERATOR-GATED — the spike runner stops at G1 by design (exit 3).

Names only below — no file in git holds an environment value, and no token
value, passphrase, or non-loopback hostname is ever typed into a record.
Report the bearer by name (`SUBSTRATE_TOKEN_SUBSTRATE`); report the lease by
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

## Never-type-secrets class

No token value, passphrase, or bus secret is typed into a shell history, a
record, or a transcript for any step above. Files that must name a credential
name its variable (`SUBSTRATE_TOKEN_SUBSTRATE`, `SUBSTRATE_VM_ANTHROPIC_API_KEY`
on route `a:anthropic_key` only). Non-loopback hostnames stay out of the repo,
the PR, and the record.
