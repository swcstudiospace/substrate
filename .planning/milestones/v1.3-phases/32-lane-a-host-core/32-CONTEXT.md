# Phase 32: Lane A host core - Context

**Gathered:** 2026-10-10
**Status:** Ready for planning
**Mode:** Autonomous discuss (no operator round-trip; every decision below is sourced from a locked operator decision, the reviewed research, or a phase contract — nothing invents a user-visible choice). Items needing a live system are marked OPERATOR-GATED in the plans, not resolved here.

<domain>
## Phase Boundary

One PR on agent-substrate (LANEA-02 + LANEA-03 + LANEA-07; LANEA-04/06/08 belong to Phase 33). A host task works its node under the `claude-code` lease from start to finish, survives a host restart, and keeps every credential on the host.

1. **Wire, not port.** Phase 31 ported the fourteen host modules whole onto `main`'s v1.2 lease model. This phase wires the lease lifecycle the port left open: `openTask` claims with `lease_id` persistence, heartbeats while turns run, re-claims on refusal, and releases on every terminal path. The machinery (`SubstrateClient.claimAndPersist`, `heartbeat`, `heartbeatDue`, `LeaseStore`) already exists in `substrate.ts` — it is called from nowhere. No module is rewritten; the seam is `tasks.ts` + `main.ts` only.
2. **Restart survival is process/unit semantics, provable with fake VMs.** `TaskStore` (0600 JSON per task under the unit's storage dir), `LeaseStore` (0600 lease files beside the task records), `beginShutdown` on SIGTERM/SIGINT, and `resumeInterrupted` once per boot already exist. This phase proves kill-and-restart against on-disk stores with fake VMs and stages the unit restart semantics — it does not boot a real VM to prove it.
3. **Rehearsal-first, then gated live.** Every behavior is proven with fakes and unit tests before any live step. A real VM-backed node run (spends Claude Code model quota + Docker capacity), the production unit install/restart, the manifest `dormant:31` → `live` flip, and any real `claude-code` quota spend are OPERATOR-GATED sequences the executor stops at.

**Depends on code already on `main`:**
- Phase 31: `packages/host` (14 modules + tests), `substrate.ts` bearer/`lease_id`/heartbeat client, `LeaseStore`, `TaskStore`, `resumeInterrupted`, staged `infra/vps/substrate-host.service`, `scripts/host-smoke.ts` two-VM rehearsal proof (23/23), `scripts/host-spike.ts` step-0 asserts, `docs/runbooks/lane-a-host.md`.
- Phase 16: rehearsal harness, `ConditionPathExists` + `StartLimitBurst` unit conventions, crash-loop guards.
- Phase 17: closed `EVENT_KINDS` (12, no new kinds); `substrate` surface.
- Phase 18: shared `redact.ts` (import only from `packages/mcp-server/src/redact.ts`), store-lock rules.
- Phase 20: `infra/identity/clients.json` `dormant:31` substrate-host row (surface `substrate`, per-unit host env file, host-job token variable).
- Phase 23: lease/DoD model — `LeaseState`/`lease_id` fencing/`graph_complete` DoD gate live in main's index; the mirror never sees a `lease_id` (D23-04).
- Phase 24: dispatcher `HostClient` against `127.0.0.1:7411`; `given_up.json` 0600 atomic-persist precedent (D24-05); `dispatch:claude-code` deferred live (D24-06); D-16 root trust carried (D24-10).

**Out of scope:**
- The `dispatch:claude-code` route, approval buttons, Telegram broker answers (LANEA-04/06 — Phase 33 owns them; `respondApproval` stays unreachable until then, `permissionPolicy: "ask"` stays unanswered by anything here).
- Any new `EVENT_KINDS` or `SURFACES` entry; new redaction rules; running the host as an unprivileged user (deferred per D24-10 precedent).
- Production token values (Phase 20 provisioned them by name; this phase only reads token files by name).
- Real VM boots, unit install/restart, manifest flip, model quota spend (all OPERATOR-GATED).
</domain>

<decisions>
## Implementation Decisions

### Spike-result dependency (which 31 results are inputs vs pending-gated)
- **D32-01: Phase 32 builds on the 31 step-0 facts as inputs; all four gated verdicts stay pending and gate only the live tail, never the rehearsal work.**
  - Sourced: 31-SPIKE.md (step-0 asserted 2026-10-10, exit 0) + 31-VERIFICATION.md (provable scope table).
  - Inputs (asserted, reusable): `/dev/kvm` absent, no `vmx`/`svm` flags, 6420 served by the rivet engine, 7411 free, ≥10 GiB free (128308633600 observed), `substrate-sandbox:0.1` absent, `/var/lib/substrate/agentos` 332755597 bytes. Plans may assume these as the environment they rehearse for.
  - Pending-gated (UNRECORDED/UNVERIFIED, NOT inputs): G1 npm-ci footprint, G2 shared-engine session verdict, G3 no-KVM boot verdict, G4 unit install/restart. No plan asserts a real engine session, a real boot, or an installed unit. The live tail of 32-03 re-checks step-0 (`--check` exit 0) before stopping at its gates.

### Lease lifecycle wiring (LANEA-02 core)
- **D32-02: `openTask` claims through `claimAndPersist` and heartbeats while turns run; a refused heartbeat re-claims, it never extends a dead lease.**
  - Sourced: `substrate.ts:283-326` (`claimAndPersist` persists `lease_id` + `acquiredAtMs` + TTL on a granted claim; `heartbeat` is fenced on `lease_id`; "a refused heartbeat means the lease lapsed or was taken over: the caller re-claims rather than extending") + `tasks.ts:368` (current code calls bare `graphClaim` — the gap this decision closes) + main `lease.ts` (heartbeat is due at half-TTL; `heartbeatDue` mirrors it).
  - Heartbeat cadence follows `heartbeatDue` (half of `DEFAULT_LEASE_TTL_SECONDS` = 900 s per D24-07, so ~450 s); the tick fires only while `turn_in_flight` is true. On refusal the task re-claims via `claimAndPersist` and persists the new `lease_id`; on re-claim failure the turn is marked failed (same release path as a failed open).
- **D32-03: Every terminal path releases the claim exactly once; a failed open after claim releases before answering 502.**
  - Sourced: `tasks.ts:447-453` (release-after-failed-open already exists — kept verbatim) + `kill` (cancel → unload → `graphRelease`, marks `released`) + LANEA-02 ("releases the claim on any failure").
  - Completion (`graphComplete` with DoD) and `terminate`/`kill` all funnel through the single release helper; double-release is guarded by the `released` flag on the record. No path leaves a held lease behind on success, failure, kill, or shutdown-after-settle.
- **D32-04: `lease_id` is a fencing token: persisted 0600 beside the task records, never logged, never seeded, never synced.**
  - Sourced: `substrate.ts:120-160` (`LeaseStore`, "0600 file discipline, Phase 24 given_up.json precedent", "never appears in logs — only presence is reported") + D23-04 (the mirror never sees a `lease_id`) + D31-09 (credentials host-side).
  - Lease files live beside `TaskStore` JSON under the unit's storage dir (same temp+rename atomic write, same 0600). Logs report `lease persisted yes/no`, `heartbeat ok/refused` — never the value. The `lease_id` never enters a seed file, a sync payload, a Linear/Notion call, or an event body.

### Restart survival (LANEA-03)
- **D32-05: Restart survival = on-disk `TaskStore` + on-disk `LeaseStore` + `resumeInterrupted` once per boot; proven by killing and restarting the service with fake VMs.**
  - Sourced: `tasks.ts:80-82` (`interruptedTasks`: in flight, still claimed, not finished), `tasks.ts:544-578` (`resumeInterrupted`: exactly one continuation prompt per interrupted task, key `<gid>:<nid>:resume:<n>`, stale approvals counted off, route re-established first), `main.ts:209` (boot calls `resumeInterrupted`), `tasks.ts:346-348` (`beginShutdown` on SIGTERM/SIGINT keeps the record in flight).
  - The rehearsal kills the `TaskService` mid-turn (fake VM whose `prompt` never settles), constructs a new service over the same on-disk stores, and asserts exactly one continuation prompt with the next resume key — including a double-boot that must NOT replay. Real `node src/main.ts` restart and the production unit restart are OPERATOR-GATED (G4 family).
- **D32-06: After a restart the service re-establishes the model route before resuming, and re-heartbeats surviving leases before sending continuations.**
  - Sourced: `tasks.ts:541` ("the model route is re-established first — on a:hostfn_proxy the restart killed the in-VM relay") + D32-02 (heartbeat while turns run — a restarted turn is a running turn).
  - Order at boot: `resumeInterrupted` → per task: `vmFor` + `ensureModelRoute` → heartbeat-or-reclaim on the persisted lease → continuation prompt. A task whose route or heartbeat both fail is marked failed on its own; the others still resume.

### Credential containment (LANEA-07)
- **D32-07: The VM holds no token values; host functions run on the host with host credentials; the guest chooses text only.**
  - Sourced: D31-09 (VM holds no tokens; `getToken()` through `substrateDocker`, never a `token` option to `sandboxAgentProvider`) + `hostfns.ts:5-8` (worktree `/var/lib/substrate/worktrees/<gid>`, branch `substrate/<gid>`, remote always origin, no `--force`, no colon refspec, `.substrate-*` excluded from every add) + `sync.ts:1-9` (host keys from the unit's `EnvironmentFile`, error bodies capped 200 redacted chars, never a header).
  - Containment tests pin: no `token`/`bearer`/`Authorization` value in `sessionEnv`, in any `sandboxAgentProvider` option, or in tracker-locator seed files; `NOTION_API_KEY`/`LINEAR_API_KEY` are read only in the host process; commit/push/PR argvs are pure functions with fixed targets (guest supplies title/body/message text within limits only).
- **D32-08: The seeded substrate MCP entry's bearer scoping is settled here, not carried as an open question.**
  - Sourced: `seed.ts:165-171` ("rotation and scoping are Phase 32's credentials discipline") + D32-07.
  - Decision: the seeded `.claude.json` substrate entry carries the host-job bearer (as `seed.ts` already builds) if and only if the entry URL is the loopback host MCP proxy the host serves; the bearer value is resolved host-side at seed time, written through the existing sha256 read-back path, and never logged. If the proxy is not loopback-reachable from the VM, the entry is headerless (September shape) and the model reaches substrate through the host functions instead. Either way the rule "no token value in VM env, only in this one file" is pinned by a negative test that scans every other seed file and the session env for the bearer value.

### Sync and PR discipline (LANEA-07 host side)
- **D32-09: Push/PR/sync run host-side through the existing pure-argvs + tracker clients; sync writes PR fields only, never workflow state.**
  - Sourced: `hostfns.ts` (`pushArgv`, `prCreateArgv`, `commitArgv` pure; one PR per task — recorded `pr_url` returned as-is; scratch check before any network call) + `sync.ts` (`SYNC_WRITABLE` = PR URL / PR # / PR State / Repo / Branch; "No Linear workflow state and no Notion Status ever move here: Done comes only from graph_complete through the DoD gate").
  - This phase proves the sequence (commit → push → pr-create → sync → verify) end-to-end with fakes (fake runner, fake Notion/Linear) on an isolated graph; the real push + real PR land only in the OPERATOR-GATED tail. `graphComplete` carries the DoD (`summary` non-empty capped, `tests_pass`, optional `review_pass`) per D23-13.

### Proof (LANEA-02/03/07 rehearsal shape)
- **D32-10: "A host task works its node start to finish" is proven with a fake VM + fake substrate on an isolated graph; the live tail spends quota and is gated.**
  - Sourced: v1.3 run rules (rehearsal-first; live runs wait for operator approval) + 31-VERIFICATION.md (smoke:host 23/23 pattern) + Phase 24 D24-06 (claude-code live deferred past 33's gate).
  - In-repo proof per plan: 32-01 (claim → seed read-back → ask-policy open → heartbeat ticks → prompt settles → complete/release, all faked, lease file asserted 0600 with no value in logs); 32-02 (kill mid-turn → reboot over same dirs → exactly one resume-keyed continuation, double-boot sends none); 32-03 (fake runner records commit→push→PR argvs with fixed targets, fake trackers receive PR fields only, bearer-value scan clean). The gated tail (real VM-backed node run on a throwaway repo, unit install/restart, manifest flip) is an OPERATOR-GATED sequence the executor stops at.

### Docs
- **D32-11:** `docs/runbooks/lane-a-host.md` gains the lease/heartbeat/reclaim table, the restart-resume sequence, and the credential-containment inventory; the manifest `dormant:31` row is NOT flipped in this phase's PR (the flip is a gated step of the live tail, after the gated restart).

### Claude's Discretion
- Heartbeat tick implementation (interval timer vs prompt-settle hook chain), as long as ticks fire only while `turn_in_flight` and stop on every terminal path.
- Exact refusal/presence log wording, beyond never printing a `lease_id` or bearer value.
- Test layout (extend existing `tasks.test.ts`/`substrate.test.ts`/`host-smoke.ts` vs new files), as long as every new behavior keeps its tests.
- Whether the seeded-bearer loopback check (D32-08) is a static constant or a runtime probe — recommendation: static constant matching the unit's served proxy, never a network probe at seed time.

### Open for the operator (recommendations the plans use until told otherwise)
1. Heartbeat at half-TTL (~450 s) while turns run; re-claim on refusal (D32-02).
2. Seeded bearer stays in the one loopback MCP entry file only (D32-08).
3. Approve the gated live tail (real node run, unit restart, manifest flip) after the rehearsal half is green.
</domain>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/host/src/substrate.ts` (381 lines) — bearer client, `claimAndPersist`, `heartbeat`, `heartbeatDue`, `LeaseStore` (0600, temp+rename), SSE parsing. Called from nowhere for lease ops — the seam this phase wires.
- `packages/host/src/tasks.ts` (695 lines) — `openTask` (validate → existing → graph_get → claim → brief → seed read-back → `sessions.open` ask → record → non-awaited `startPrompt`), `resumeInterrupted` (once-per-boot, resume keys, stale approvals), `beginShutdown`, `respondApproval` (D-13, unreachable until Phase 33), `kill` (cancel → unload → release).
- `packages/host/src/seed.ts` — `seedFiles` with sha256 read-back contract, bearer-entry builder, tracker locators without tokens, kickoff state (ids only).
- `packages/host/src/hostfns.ts` — pure commit/push/PR argvs, scratch guard, one-PR-per-task, fake-injectable runners.
- `packages/host/src/sync.ts` — `HostSync`/`NotionSync`/`LinearLink`, `SYNC_WRITABLE` five fields, `syncTask` + read-only `VerifyInput`, fetch-injected for fakes.
- `packages/host/src/main.ts` — boot calls `resumeInterrupted` (line 209), SIGTERM/SIGINT → `beginShutdown`, `TaskStore` on the unit storage dir.
- `scripts/host-smoke.ts` (23/23) — the fake-VM + fake-substrate rehearsal pattern to extend.
- `scripts/host-spike.ts --check` — step-0 re-assert for every gated tail.

### What Is Greenfield
- Heartbeat tick wiring in `tasks.ts` (start on prompt start, stop on settle/kill/shutdown) + heartbeat-or-reclaim at resume.
- `openTask` claim path switching from bare `graphClaim` to `claimAndPersist` with the unit's `LeaseStore`.
- Kill-and-restart rehearsal harness (fake VM with unsettlable prompt + service reboot over the same on-disk dirs).
- Bearer-value negative scan test (no token value outside the one seed file + host env).
- Runbook lease/restart/containment sections; gated live-tail sequence (real node run, unit restart, manifest flip).
</code_context>
