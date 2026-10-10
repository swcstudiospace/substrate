# Phase 31: Lane A runtime — spike, packaging and VM host - Context

**Gathered:** 2026-10-10
**Status:** Ready for planning
**Mode:** Autonomous discuss (no operator round-trip; every decision below is sourced from a locked operator decision, the reviewed research, or a phase contract — nothing invents a user-visible choice). Items needing a live system are marked OPERATOR-GATED in the plans, not resolved here.

<domain>
## Phase Boundary

One PR on agent-substrate (LANEA-01 + LANEA-05; LANEA-02/03/07 belong to Phase 32, LANEA-04/06/08 to Phase 33). `substrate-host` runs from `main` and gives each Graph ID its own agentos VM on this host, within the disk and port limits the host actually has.

1. **Port, not merge.** `packages/host/src/{api,audit,hostfns,main,mcp-proxy,options,sandbox-options,sandbox-provider,seed,substrate,sync,tasks,telegram,vm}.ts` (~4.3k lines), `package.json`, `infra/sandbox/Dockerfile` and `infra/vps/substrate-host.service` come from `acc30a8` (`git show acc30a8:<path>`), onto main's v1.2 lease model and Phase 20 production identity. September was built on the pre-lease claim model with anonymous access; `substrate.ts` (anonymous JSON-RPC, no `lease_id`, no heartbeat) is rewritten, never cherry-picked. September's `.planning/` archives (hostnames) are never ported.
2. **Spike first, packaging second.** Plan 31-01 bounds the three unknowns with a gated spike (engine share-vs-own, no-KVM boot, npm-install footprint) before 31-02 ports the package. A spike that cannot boot a VM without KVM is a gap, never a pass.
3. **Rehearsal-first, then gated live.** Every behavior is proven with fakes and unit tests before any live step. Real VM boots, the ~2.2 GB npm install, image builds/pulls over 2 GB, and unit install/restart are OPERATOR-GATED sequences the executor stops at.

**Depends on code already on `main`:**
- Phase 16: rehearsal harness, `ConditionPathExists` + `StartLimitBurst` unit conventions, crash-loop guards.
- Phase 17: closed `EVENT_KINDS` (no new kinds); `substrate` surface.
- Phase 18: shared `redact.ts` (import only from `packages/mcp-server/src/redact.ts`), store-lock rules, disk-gate precedent (`df --output=avail -B1 /`, 10 GiB floor in `substrate-desktop.sh`; 2 GiB floor in `rehearsal.ts`).
- Phase 20: `infra/identity/clients.json` `dormant:31` substrate-host row (surface `substrate`, per-unit host env file, host-job token variable).
- Phase 24: dispatcher `HostClient` against `127.0.0.1:7411` (`host-unreachable` today — the correct pre-Phase-31 behavior); 5 GiB worktree floor precedent; D-16 root trust carried.

**Out of scope:**
- `openTask` lease choreography, heartbeats, resume prompts, host-side credentials discipline (LANEA-02/03/07 — Phase 32 owns them; this phase only ports the files they live in).
- The `dispatch:claude-code` route, `issue_get` host wiring, approval buttons (LANEA-04/06 — Phase 33).
- Any new `EVENT_KINDS` or `SURFACES` entry; new redaction rules; running the host as an unprivileged user (deferred on the branch as D-16; deferred here per D24-10 precedent).
- Production token values (Phase 20 provisioned them by name; this phase only reads token files).
- Pulling any base image, building `substrate-sandbox:0.1`, `npm ci` on this host, installing or restarting any unit (all OPERATOR-GATED).
</domain>

<decisions>
## Implementation Decisions

### Port shape and auth cutover (the September-to-main break)
- **D31-01: Port the fourteen host modules, package.json, sandbox Dockerfile and unit file whole; rewrite only the auth and lease-model call sites.**
  - Sourced: research SUMMARY (leaf modules port whole; call sites rewritten against the `lease_id` model) + ARCHITECTURE Port Map H.
  - `substrate.ts` is rewritten: bearer carriage for the host-job token (Phase 20 per-unit env file), `lease_id` persistence, heartbeat — September's anonymous client with no `lease_id` is dead on main. `main.ts`'s hard-coded operator checkout path becomes the repo checkout. No other module logic changes.
- **D31-02: Node 24 runs the host; Bun never touches its dependencies.**
  - Sourced: STACK H (`@rivet-dev/agentos` declares `engines.node >=22`; native `better-sqlite3`; `[UNVERIFIED under Bun; do not try]`) + acc30a8 unit `ExecStart=/usr/bin/node src/main.ts` (type stripping).
  - `packages/host` keeps its own `package.json` + npm lockfile; installs run as `npm ci` inside `packages/host`, never `bun install` at root. Root `bun.lock` already lists `packages/host` as a workspace (verified this session); the host's rivet deps resolve through npm only. `bunx tsc --noEmit` still type-checks the sources via root `tsconfig.json` includes.
- **D31-03: Pin `@rivet-dev/agentos` 0.2.21 for the port; declare the missing agent package explicitly.**
  - Sourced: STACK H (0.2.21 pinned on the branch, 0.2.22 latest; `@agentos-software/claude-code@0.2.7` imported by `vm.ts` but missing from `package.json` dependencies, present only transitively in the 8,498-line lock).
  - The port pins 0.2.21 + `agentos-sandbox` 0.2.21 + `dockerode` 4.0.12 + `sandbox-agent` 0.4.2 + `zod` 4.6.5, and adds `@agentos-software/claude-code@0.2.7` to dependencies. A 0.2.22 bump is its own later task, never folded into the port.

### Engine coexistence (spike-resolved, D31-04)
- **D31-04: The spike decides share-vs-own for the rivet engine on port 6420; the recommendation is to share.**
  - Sourced: STACK H (`gcs-rivet-rivet-engine-1` holds `127.0.0.1:6420` for another project; acc30a8's unit sets `RIVET_RUN_ENGINE=1`/`RIVET_RUN_ENGINE_HOST=127.0.0.1`, which would bind the same port) + live `ss` this session (6420 held, healthy, 8 days up).
  - September's unit spawns its own engine. Spawning a second engine on 6420 collides with a live container this phase must not touch. The spike (31-01, gated boot) connects to the existing loopback engine first; only if the shared engine refuses the host's actors does the plan fall back to a second loopback engine on a free port. Either way the engine stays on loopback and the other project's container keeps running untouched (LANEA-01 criterion 1 names this).

### VM contract (what the spike must prove)
- **D31-05: One actor per Graph ID; the session shape is taken verbatim from September's `VmHandle` type.**
  - Sourced: acc30a8 `packages/host/src/tasks.ts:239-263` (read this session): `sessions.open({ sessionId, agent, cwd, env, mcpServers: [{ type: "http", name, url, headers }], permissionPolicy: "ask", additionalInstructions })`, `prompt({ sessionId, idempotencyKey, content: [{ type: "text", text }] })`, plus `get`/`readHistory`/`cancelPrompt`/`unload`.
  - `permissionPolicy: "ask"` is the only policy (Phase 32's approval broker answers; nothing here ever answers one — vm.ts D-13 floor). The three 0.2.21 workarounds in `vm.ts` (per-VM sidecar pool `vm-<gid>`, `resolveSandboxOptions` inside `resolveOptions`, per-actor dispose hooks) port as-is with their comments.
- **D31-06: No KVM is needed — but the spike proves it, the context does not assert it.**
  - Sourced: ARCHITECTURE (V8/WASM per September 03-CONTEXT D-01) marked UNVERIFIED in the research SUMMARY + live facts this session (`/dev/kvm` absent, no `vmx`/`svm` flags, `hypervisor: KVM` guest).
  - The claim "agentos needs no KVM" is September's, not main's. Plan 31-01's gated boot is the first time it is tested from `main`. If the boot demands `/dev/kvm`, the spike records a gap and the packaging plans still land (they are KVM-independent); the live proof waits on the operator, never on a faked pass.

### Disk and port budget (LANEA-05 + LANEA-01)
- **D31-07: A disk gate in code refuses any image build or pull below 10 GiB free — the `substrate-desktop.sh` floor, not the rehearsal 2 GiB floor.**
  - Sourced: REQUIREMENTS LANEA-05 + September Dockerfile header (`df --output=avail -B1 / >= 10737418240` immediately before building) + main precedent (`substrate-desktop.sh` 10 GiB, `rehearsal.ts` 2 GiB).
  - The gate lives in the host's sandbox path (`sandbox-provider.ts` build/pull entry), runs before any `docker` call, and is unit-tested with stubbed `df` output. September enforced this by hand only; this phase puts it in code.
- **D31-08: The host API is loopback-only `POST /tasks` on port 7411; 7411 is free today.**
  - Sourced: acc30a8 `api.ts` (transport copied from `server.ts`: one handler, bounded 1 MiB body, `SyntaxError → 400`) + live `ss` this session (7411 unbound; 7410 held by substrate-mcp; 6420 held by the rivet engine).
  - `GET /healthz` reports `{ engine, api }`. The dispatcher's Phase 24 `HostClient` already speaks this surface; with no host on the port every claude-code candidate keeps getting `host-unreachable` until the gated install.

### Credentials and trust
- **D31-09: Credentials stay host-side; the session runs as root.**
  - Sourced: D-16 root trust carried per D24-10 precedent + production-identity `dormant:31` row (per-unit host env file, host-job token variable, surface `substrate`).
  - The VM holds no tokens (Phase 32 enforces; this phase ports the shape that makes it possible: `getToken()` through `substrateDocker`, never a `token` option to `sandboxAgentProvider`). The manifest row flips to `live` only after the gated restart — NOT in this phase's PR.

### Proof (LANEA-01 rehearsal half)
- **D31-10: "Two Graph IDs run in two VMs" is proven with fakes in-repo; real boots are the gated tail.**
  - Sourced: v1.3 run rules (rehearsal-first; live runs wait for operator approval) + Phase 24 D24-06 (claude-code live deferred to Phase 33).
  - In-repo proof: two `openTask` calls against a fake `VmHandle` + fake docker client land in two actors with two sandbox containers, each with the graph label, loopback-only ports, no privileged flag, no docker socket. The gated tail (real `node src/main.ts`, real engine session, real sandbox container) is an OPERATOR-GATED sequence the executor stops at — with the preconditions that `/var/lib/substrate/agentos` (318 M today) and image budget fit the 10 GiB floor.

### Docs
- **D31-11:** `docs/runbooks/lane-a-host.md` (new) covers the engine share-vs-own outcome, the disk/port budget table, the gated install/restart sequence, and the rollback (stop unit → VMs disposed, sandboxes included); `docs/dispatcher.md` gains the `host-unreachable` → live transition note; `infra/identity/clients.json` is NOT flipped in this phase.

### Claude's Discretion
- File split inside `packages/host/src/` stays September's (no reorganization during a port).
- Exact refusal wording for the disk gate, beyond naming the free bytes and the 10 GiB floor.
- Whether the 0.2.22 bump rides as a final task of 31-02 or waits — recommendation: waits (a green port first).
- Test layout (per-module `*.test.ts` like September, or consolidated), as long as every ported module keeps its tests.

### Open for the operator (recommendations the plans use until told otherwise)
1. Share the existing rivet engine on 6420 rather than spawning a second one (D31-04).
2. Fund the ~2.2 GB npm install + ~1 GB sandbox image inside the current 120 GiB free (D31-07 budget).
3. Approve the gated spike boot window after the rehearsal half is green.
</domain>

<code_context>
## Existing Code Insights

### Reusable Assets
- `acc30a8:packages/host/src/*.ts` (14 modules, ~4.3k non-test lines + tests) — the port source. `vm.ts` carries the three 0.2.21 defect workarounds with comments; `tasks.ts:239-263` carries the `VmHandle`/`sessions.open` shape; `api.ts` carries the loopback transport; `sandbox-provider.ts` + `sandbox-options.ts` carry the container spec (graph label, loopback ports, per-container token, no privileged, no socket).
- `acc30a8:infra/sandbox/Dockerfile` (`node:24-bookworm-slim`, pinned bun/sha256, `sandbox-agent@0.4.2`, keep-label exempting it from `docker-image-prune`) + `acc30a8:infra/vps/substrate-host.service` (loopback env, `StateDirectory=substrate`, `TimeoutStopSec=15`, `RestrictAddressFamilies` with `AF_UNIX` for the docker socket).
- Main `packages/mcp-server/src/redact.ts` (the only redactor; `redact-lock.test.ts` forbids a second), `packages/mcp-server/src/server.ts` (transport pattern for `api.ts`), `packages/dispatcher` `host.py` (the client side of `POST /tasks`, Phase 24).
- Main `scripts/rehearsal.ts` (2 GiB floor pattern), `infra/desktop/substrate-desktop.sh` (10 GiB floor pattern, PATH-stub test design).

### What Is Greenfield
- `substrate.ts` rewrite (bearer + `lease_id` + heartbeat) — September's anonymous client cannot be ported.
- The in-code 10 GiB disk gate on the sandbox build/pull path — September enforced by hand.
- `main.ts` checkout-path fix (September hard-codes the operator checkout).
- `@agentos-software/claude-code@0.2.7` declared dependency (September imports it, never declares it).
- `docs/runbooks/lane-a-host.md`, `scripts/host-spike.ts` (gated spike runner), `scripts/host-smoke.ts` (fake-based rehearsal proof).
</code_context>
