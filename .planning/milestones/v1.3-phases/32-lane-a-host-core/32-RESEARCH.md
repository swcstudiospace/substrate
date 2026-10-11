# Phase 32: Lane A host core - Research

**Researched:** 2026-10-10 (local evidence, read-only unless marked OPERATOR-GATED)
**Domain:** Host-task lease lifecycle wiring, restart survival, host-side credential containment on the Phase 31 port
**Confidence:** HIGH for the lifecycle map, the lease gap, and the restart shape (every file read, line numbers below); MEDIUM for the seeded-bearer scoping (one loopback-reachability assumption flagged in D32-08); LOW where marked `[UNVERIFIED]`/`[INFERENCE]`

<user_constraints>
## User Constraints (from CONTEXT.md)

Locked: D32-01 (31 step-0 facts are inputs; G1-G4 verdicts stay pending-gated), D32-02 (claimAndPersist + heartbeat while turns run; re-claim on refusal), D32-03 (single release helper on every terminal path), D32-04 (`lease_id` 0600 beside task records, never logged/seeded/synced), D32-05 (kill-and-restart with fake VMs over on-disk stores), D32-06 (route re-established + heartbeat-or-reclaim before continuations), D32-07 (VM holds no token values; guest chooses text only), D32-08 (seeded bearer scoped to the one loopback MCP entry file), D32-09 (host-side commit→push→PR→sync; sync writes PR fields only; DoD on complete), D32-10 (fake-based rehearsal proof per plan; live tail gated), D32-11 (runbook gains lease/restart/containment; manifest NOT flipped in the PR).

Claude's discretion: tick implementation; log wording (values never printed); test layout; static loopback constant over runtime probe.
Out of scope: LANEA-04/06 (Phase 33), new kinds/surfaces, unprivileged user, live boots/installs/flip/quota (all OPERATOR-GATED).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| LANEA-02 | `openTask(graphId)` reads the node, claims it as `claude-code` with that surface's token, keeps the `lease_id` and heartbeats while turns run, seeds the brief, skills and MCP config with a sha256 read-back, opens the session with permission policy "ask", and releases the claim on any failure. [VERIFIED: REQUIREMENTS.md] | Lifecycle map (§ Lifecycle); the claim gap (§ Lease gap); seed read-back + ask open (§ Lifecycle steps 5-6); release paths (§ Release) |
| LANEA-03 | Sessions are durable: after a host restart, a continuation prompt keyed `<graph_id>:<node_id>:resume:<n>` resumes the work. [VERIFIED: REQUIREMENTS.md] | Resume shape (§ Restart); kill-and-restart proof design (§ Restart proof); G4 pending (§ Gated inventory) |
| LANEA-07 | Credentials stay on the host: the VM holds no tokens, and host functions commit and push (never force, never `.substrate-*` files), open the PR and sync PR fields through the substrate's Linear and Notion clients. [VERIFIED: REQUIREMENTS.md] | Containment map (§ Credentials); pure-argvs + sync fields (§ Credentials); bearer scoping decision (§ Credentials) |
</phase_requirements>

## Project Constraints (from AGENTS.md)

- Draft PR only; no merge, no auto-merge, no force-push, no branch deletion.
- **No secrets**: never print, commit or echo tokens, keys, passphrases; reference env vars by name only; **do not write tailnet names or internal hostnames into the repo, the PR or the transcript.**
- Every PR goes through the Greptile gate run by Desk Quality; a failed/skipped review is a blocker.
- Repo conventions that bind this phase: `tsconfig.json` includes `packages/**/*.ts` + `scripts/**/*.ts`; store-lock + redact-lock tests (import `redact` only from `packages/mcp-server/src/redact.ts`); closed `EVENT_KINDS` (12); `bun test`, `bunx tsc --noEmit`, `test:py` gates.

<local_evidence>
## Local Evidence (read-only probes, 2026-10-10)

### Step-0 re-assert (D32-01 inputs — unchanged since 31-SPIKE.md)
- `/dev/kvm` absent; no `vmx`/`svm` flags; `127.0.0.1:6420` held by `gcs-rivet-rivet-engine-1`; `127.0.0.1:7411` free; `/` avail 128308633600; `substrate-sandbox:0.1` absent; `/var/lib/substrate/agentos` 332755597 bytes. Source: 31-SPIKE.md step-0 table (asserted via `bun scripts/host-spike.ts --check`, exit 0). No re-probe needed — the gated tails re-run `--check` themselves.
- HEAD is `2f801a1` (phase 31 docs + verification record landed; `71e74ef` host wiring, `934f1f9` bearer/lease cutover, `5038b0f` spike runner). Suite baseline per contract: bun 3154/3157 (1 flake-suspect env fail on `--port 7410`, passes isolated), pytest 230.
</local_evidence>

<lifecycle>
## Host-Task Lifecycle Map (LANEA-02 — every step read, not inferred)

`openTask` (`packages/host/src/tasks.ts:351-454`) today:

1. **Validate** (`validateOpenRequest`) → 400 on bad body.
2. **Existing?** `store.get(gid, nid)` → 200 + `statusOf` (idempotent re-open).
3. **Read the node:** `substrate.graphGet(gid)` → 400 when the graph/node is missing.
4. **Refuse a foreign claim:** `node.claimed_by && !== "claude-code"` → 409 naming holder + session.
5. **Claim:** bare `substrate.graphClaim(gid, nid, "claude-code", nid)` → 409 on refusal. **This is the gap** (§ Lease gap).
6. **Brief:** `substrate.brief(gid, repo)` (fails open to `BRIEF_UNAVAILABLE`).
7. **Seed with read-back:** `seedFiles({brief, skills, trackers, graph, route, prompt, substrateBearer})` → `mkdir` dirs → `writeFile` each → `readFile` back → `sha256(back) === sha256(content)` or throw (`tasks.ts:395-404`).
8. **Open the session:** `sessions.open({sessionId: nid, agent: "claude", cwd: VM_WORK, env: sessionEnv(...), mcpServers, permissionPolicy: "ask", additionalInstructions})` (`tasks.ts:406-415`). MCP substrate entry only on `route.s === "mcp"`, headerless (bearer is seeded into `.claude.json`, not the open call).
9. **Record + prompt:** `TaskRecord` saved (`released: false`, `resumes: 0`), `ensureModelRoute` again, `startPrompt(handle, record, prompt, \`${gid}:${nid}:1\`)` **not awaited** → 202 + status.
10. **Failure after claim:** `graphRelease` once, then 502 (`tasks.ts:447-453` — kept verbatim per D32-03).

Turn settle (`startPrompt`, `tasks.ts:457-488`): prompt resolves → `turn_in_flight = false`, `last_stop_reason`, `exit_code` via `pollCode`, then `backstopSync`. Rejection while `stopping` keeps the record in flight (shutdown-interrupt, D-07); any other rejection marks the turn failed. `finally` clears the in-flight prompt handle.

`statusOf` (`tasks.ts:623-648`): live session view (`sessions.get` + `readHistory`) merged over the stored record; released tasks report `unloaded` without touching the VM.
</lifecycle>

<lease_gap>
## The Lease Gap (what 32-01 wires — verified by grep, not inferred)

- `substrate.ts` exports `claimAndPersist`, `heartbeat`, `heartbeatDue`, `LeaseStore` (lines 98-160, 283-326). **Zero call sites**: `grep claimAndPersist|heartbeat|LeaseStore tasks.ts main.ts` returns nothing (the only heartbeat-adjacent line in the rehearsal tree is a `host-smoke.ts` fake stub).
- `openTask` claims with bare `graphClaim` (`tasks.ts:368`) — no `lease_id` is persisted, so a host restart today loses the fencing token even though the record survives.
- No tick exists anywhere: nothing calls `heartbeat` while `turn_in_flight`, and `resumeInterrupted` (`tasks.ts:544-578`) sends continuations without heartbeat-or-reclaim — a restarted turn runs on a lease that may have lapsed mid-outage (TTL 900 s per D24-07).
- Main's lease model (`packages/mcp-server/src/lease.ts`): one holder, TTL + heartbeat, every extension fenced by the granted `lease_id`, only the holder ever sees its id (`leaseView` nulls it for everyone else). D23-04 + D23-12 already bind the edges: the mirror never sees a `lease_id`, and no transition costs more than one GET + one PATCH (heartbeats emit no Linear/Notion traffic — heartbeats are index-only).
- DoD gate (D23-13/14/15): `graph_complete` keeps `graph_id/node_id/lease_id/force/state` + `dod{summary, tests_pass, review_pass?}`; gated only for non-forced `completed` on Linear-referenced nodes with non-swarm holders. The host's `graphComplete` (`substrate.ts:337-345`) already carries `dod: Dod` — 32-01/32-03 only need to call it with the persisted `lease_id` and a real DoD, not extend it.
</lease_gap>

<restart>
## Restart-Survival Design (LANEA-03 — mostly ported, proven by 32-02)

- **Stores:** `TaskStore` (`tasks.ts:167-209`): one JSON file per task at `<dir>/<gid>--<nid>.json`, mode 0600, temp+rename atomic write, `withRecordDefaults` for forward-compatible reads. `LeaseStore` (`substrate.ts:125-160`): same discipline beside the task records (0600, temp+rename, given_up.json precedent D24-05). `main.ts:142` puts `TaskStore` under the unit's storage dir — the same dir must host the `LeaseStore` (D32-04).
- **Shutdown:** `main.ts:266-274` SIGTERM/SIGINT → `service.beginShutdown()` before registry shutdown, so a rejected in-flight prompt keeps its record in flight (`tasks.ts:470-475`).
- **Boot:** `main.ts:209` `await service.resumeInterrupted()` once per process (`resumedThisBoot` guard). Per interrupted task (`turn_in_flight && !released && exit_code === null`): `vmFor` + `ensureModelRoute` → bump `resumes`/`prompt_count`, move `pending_approvals` into `stale_approvals`, set `turn_in_flight = true` → `startPrompt(RESUME_TEXT, \`${gid}:${nid}:resume:${resumes}\`)`. Route/prompt failure marks that task failed (`exit_code = 1`) and the loop continues.
- **32-02 delta (the only new behavior):** heartbeat-or-reclaim between route re-establishment and the continuation (D32-06), plus the kill-and-restart rehearsal: fake VM with an unsettlable prompt → destroy the service → new service over the same dirs → assert exactly one continuation with the next resume key → boot a third time → assert zero new prompts (no replay, T-03-06-01). Unit restart semantics (stop unit → `beginShutdown` path → start unit → one resume pass) are staged, not run — G4 family.
</restart>

<credentials>
## Credential Containment Map (LANEA-07 — pin, don't redesign)

- **VM env:** `sessionEnv({route, model, graphId, nodeId, directKey})` — route/model/ids only. Negative test pins: no bearer/`lease_id`/API-key **value** in `sessionEnv` output, in any `sandboxAgentProvider` option, or in tracker-locator seed files (D32-07).
- **Seeded bearer:** exactly one file — the `.claude.json` substrate entry (`seed.ts:279-283`), value resolved host-side via the Phase 20 tokens-dir order (`resolveHostBearer`, `substrate.ts:98-113`), carried never logged. D32-08 settles the open question: loopback-proxy reachability is a static constant matching the unit's served proxy, never a probe at seed time; when the proxy is not loopback the entry is headerless and the model uses host functions. A bearer-value scan test asserts the value appears in no other seed file and no session env.
- **Host git:** pure argvs — `pushArgv` (`git -C <worktree> push origin substrate/<gid>`), `prCreateArgv` (repo/base fixed by graph, guest supplies title/body within `PR_TITLE_MAX`/`PR_BODY_MAX`), `commitArgv` (add excludes `**/.substrate-*` at any depth + `scratchPaths` guard + uncomputable-diff refusal). Runner is `execFile` argv-only, 120 s, `HOME=/root` for the credential helper (D32-07: credentials answer on the host, never in the VM).
- **Host sync:** `NotionSync`/`LinearLink` read `NOTION_API_KEY`/`LINEAR_API_KEY` from the unit's `EnvironmentFile` (host process only); `SYNC_WRITABLE` five PR fields; Linear side attaches a link only (`attachmentLinkURL`/`attachmentCreate`), never `issueUpdate`, never a state; errors carry status + ≤200 redacted chars, never a header (D32-09).
- **Tracker proxy scoping (D-11/SC-2, carried):** seeded notion/linear entries point at `127.0.0.1:<TRACKER_PROXY_PORT>` and are inert off `tracker_route vm_mcp` — the VM never gets a tracker key, only a loopback URL.
</credentials>

<contracts>
## Contracts This Phase Must Not Break

- `VmHandle` session shape (`tasks.ts:239-263`, D31-05 verbatim): `open/prompt/get/readHistory/cancelPrompt/unload/respondPermission`, `permissionPolicy: "ask"` only.
- `HOST_SURFACE = "claude-code"` (`substrate.ts:20`); `SUBSTRATE_SURFACE = "substrate"` for the host-job bearer; per-unit env file + host-job token variable per the `dormant:31` row.
- EVENT_KINDS closed (12) — heartbeats, resumes, syncs emit no new kinds (Phase 17 rows only; D24-12 one outcome event per launch decision).
- Store-lock / redact-lock: `redact` imports only from `packages/mcp-server/src/redact.ts`.
- `respondApproval` stays the only permission-answering path (D-13) and stays unreachable until Phase 33 — 32 proves `recordApproval` (pending, never answered) only.
</contracts>

<gated>
## Gated Inventory (OPERATOR-GATED — executors stop, never proceed)

| Gate | What | Preconditions | Records to |
|---|---|---|---|
| L1 | Real VM-backed node run (isolated graph, throwaway repo; spends Claude Code quota + Docker capacity) | `--check` exit 0; rehearsal half green; operator-approved window | 32 live-tail section: claim→heartbeat→resume→PR evidence, quota spent |
| L2 | Production unit install/restart (`substrate-host.service`, G4 family) | L1 green; runbook sequence reviewed | runbook checkbox + `systemctl` evidence |
| L3 | Manifest `dormant:31` → `live` flip (`infra/identity/clients.json`) | L2 green (expected 401s clear) | manifest diff + 2xx evidence |
| L4 | Any real `claude-code` model quota spend outside L1's window | explicit approval per run | spend note per run |

Out of scope even for the tail: real pushes/PRs on non-throwaway repos, Linear/Notion writes outside the isolated graph, `RIVET_RUN_ENGINE=1` (refused by `main.ts` until G2 verdict), base-image pulls beyond the L1 window.
</gated>

<risks>
## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Heartbeat tick outlives its turn (timer keeps firing after settle/kill) | MEDIUM | Stale lease extension on a finished task | Tick handle owned by the record: cleared in `startPrompt` settle paths, `kill`, and `beginShutdown`; test kills mid-tick and asserts zero further `graph_heartbeat` calls |
| Re-claim races a live holder (lease taken over between refusal and re-claim) | LOW | 409 loop or claim steal | Re-claim is one attempt; on refusal the turn fails closed and releases — never retries in a loop (lease contract: an expired lease is gone, a refused re-claim is someone else's) |
| Restart during `claimAndPersist` leaves claim held but lease file unwritten | LOW | Orphaned lease, resume runs headerless | Persist-then-verify: after `claimAndPersist`, read the lease back; missing lease → release + 502 like any failed open (same path as D32-03) |
| Bearer-value scan test false-passes (value is a substring of benign text) | LOW | Containment theater | Scan with the exact seeded value from a planted fake bearer of high entropy (`hb_test_<32 hex>`), assert zero occurrences outside the one file |
| L1 boot hits the G3 gap (`/dev/kvm` demanded at runtime) | LOW | Live tail blocked, rehearsal still lands | L1 pre-flight re-runs `--check`; a KVM demand is recorded as a gap referencing 31-SPIKE.md G3, never faked past |
</risks>
