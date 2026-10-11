# Phase 31: Lane A runtime — spike, packaging and VM host - Research

**Researched:** 2026-10-10 (local evidence, read-only unless marked OPERATOR-GATED)
**Domain:** Port of September's rivet-agentos host (`acc30a8`) onto main's v1.2 lease model; no-KVM spike; npm-in-bun-workspace packaging; engine coexistence; disk/port budget
**Confidence:** HIGH for port map, session shape, disk/ports, identity row (every file read, every live fact probed this session); MEDIUM for engine sharing (read-only `ss` only — the spike decides); LOW where marked `[UNVERIFIED]`/`[INFERENCE]`

<user_constraints>
## User Constraints (from CONTEXT.md)

Locked: D31-01 (verbatim port; rewrite `substrate.ts` + `main.ts` path only), D31-02 (Node 24, npm-only host deps), D31-03 (pin 0.2.21; declare `@agentos-software/claude-code@0.2.7`), D31-04 (spike decides engine share-vs-own; recommendation: share), D31-05 (one actor per Graph ID; `VmHandle` session shape verbatim), D31-06 (no-KVM proven by spike, never asserted), D31-07 (10 GiB in-code gate on build/pull), D31-08 (loopback `POST /tasks` on 7411), D31-09 (credentials host-side; root trust carried; manifest NOT flipped), D31-10 (two-VM proof with fakes in-repo; real boots gated), D31-11 (new runbook; dispatcher note; no manifest flip).

Claude's discretion: September file split kept; disk-gate wording; 0.2.22 bump waits; test layout free.
Out of scope: LANEA-02/03/07 (Phase 32), LANEA-04/06/08 (Phase 33), new kinds/surfaces, unprivileged user, live installs/pulls/builds/boots (all OPERATOR-GATED).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| LANEA-01 | `substrate-host.service` runs one rivet-agentos VM per Graph ID with a Docker sandbox for native tools, a loopback `POST /tasks` on port 7411 and the rivet engine on loopback, without colliding with the engine container already bound to port 6420. [VERIFIED: REQUIREMENTS.md:107] | Port map (§ Port map); session shape (§ Session shape); engine `ss` (§ Host budget); Dockerfile + unit file (§ Port map P-16/P-17) |
| LANEA-05 | A disk gate in code refuses any image build or pull with less than 10 GiB free. [VERIFIED: REQUIREMENTS.md:111] | Dockerfile header + `substrate-desktop.sh` 10 GiB precedent (§ Disk gate); `df` floor 120 GiB free (§ Host budget) |
</phase_requirements>

## Project Constraints (from AGENTS.md)

No `CLAUDE.md` exists; `AGENTS.md` holds the project rules:
- Draft PR only; no merge, no auto-merge, no force-push, no branch deletion.
- **No secrets**: never print, commit or echo tokens, keys, passphrases; reference env vars by name only; **do not write tailnet names or internal hostnames into the repo, the PR or the transcript.**
- Every PR goes through the Greptile gate run by Desk Quality; a failed/skipped review is a blocker.
- Repo conventions that bind this phase: `tsconfig.json` includes `packages/**/*.ts` + `scripts/**/*.ts` (host sources type-check under root `tsc`); store-lock + redact-lock tests (import `redact` only from `packages/mcp-server/src/redact.ts`); closed `EVENT_KINDS` (12); `bun test`, `bunx tsc --noEmit`, `test:py` gates.

<local_evidence>
## Local Evidence (read-only probes, 2026-10-10)

### KVM / CPU (D31-06 input)
- `/dev/kvm`: **absent** (`ls: cannot access '/dev/kvm'`).
- CPU flags: **no `vmx`, no `svm`** in `lscpu` flags; `Hypervisor vendor: KVM`, `Virtualization type: full` — this host is itself a KVM guest with no nested virt.
- September's claim (ARCHITECTURE via 03-CONTEXT D-01): agentos is V8/WASM and needs no KVM. Status: **UNVERIFIED on main** — no agentos runtime exists in this worktree (`packages/host` holds only `package.json`), no local `rivet-agentos` checkout exists anywhere under `/root/src/repos` (searched, not found), and September's proof ran from the branch, not from `main`. The gated spike boot is the first main-tree test.
- Bounding: the packaging plans (31-02) are KVM-independent and land regardless; only the live proof waits on the boot result. A boot demanding `/dev/kvm` is recorded as a gap, never faked past.

### Bun workspace vs host lock (D31-02 input)
- Root `package.json` `workspaces` lists `packages/host`; root `bun.lock` already records `"packages/host"` (§38) and `@substrate/host@workspace:packages/host` (§80) with **zero** `agentos` entries — main's lock has never resolved the rivet deps.
- `acc30a8:packages/host` carries its own 8,498-line npm `package-lock.json` alongside `package.json` (FEATURES H-T1; verified `ls-tree` this session).
- Procedure (bounded, no new research needed): `npm ci` inside `packages/host` (Node 24); never `bun install` for host deps. The 0.2.21 defect workarounds in `vm.ts` assume the npm-resolved tree — another reason not to re-resolve under Bun. Footprint precedent: September's npm install cost ~2.2 GB (FEATURES H-T5). The install itself is OPERATOR-GATED (disk + network).

### openSession option names (D31-05 input) — VERIFIED against `acc30a8`, runtime UNVERIFIED
- Source: `git show acc30a8:packages/host/src/tasks.ts` lines 239-263 (`VmHandle` type), read this session. There is **no local rivet-agentos checkout** to inspect (`/root/src/repos/rivet-agentos` does not exist; the contract's path assumption was wrong — recorded here so Phase 32 does not re-search it).
- `sessions.open({ sessionId: string; agent: string; cwd: string; env: Record<string,string>; mcpServers: Array<{ type: "http"; name: string; url: string; headers: Array<{name; value}> }>; permissionPolicy: "ask"; additionalInstructions: string }): Promise<void>`
- `prompt({ sessionId; idempotencyKey; content: [{ type: "text", text }] }): Promise<{ stopReason: string }>`; `get({sessionId})`, `readHistory({sessionId})`, `cancelPrompt({sessionId})`, `unload({sessionId})`; `respondPermission({sessionId; requestId; optionId})`.
- Actor definition: `agentOS({ software: [claude], loopbackExemptPorts, permissions: { network, hostFunction }, limits, resolveOptions, onVmStart, onVmDisposed, onSessionEvent })` + `setup({ use: { vm } })` (`vm.ts:410+`, read this session). Option names above are VERIFIED as September's contract; whether 0.2.21/0.2.22 runtime honors them is proven only by the gated boot.
- Continuation key `<graph_id>:<node_id>:resume:<n>` lives in `tasks.ts:45-46` (D-07) — ported in 31-02, exercised in Phase 32.

### Host budget: disk + ports + engine (D31-04/D31-07/D31-08 input)
- Disk: `/dev/sda1` 387 G total, **120 G free (70%)** — up from September's 22 G free (95%). `df -B1 /` avail ≈ 128,357,388,288.
- `/var/lib/substrate/agentos` exists, **318 M** (unchanged since September's 318 M — no growth, no cleanup needed).
- Budget: npm install ~2.2 GB + sandbox image ~1 GB + per-VM storage (order 318 M for the existing store) fit comfortably in 120 GB free with the 10 GiB floor intact. No prune, no cleanup in this phase.
- Ports (`ss -ltn` this session): `127.0.0.1:6420` held by `gcs-rivet-rivet-engine-1` (`rivetdev/engine:latest`, 1.59 GB, Up 8 days, healthy — another project's container, **never touched**); `127.0.0.1:7410` held by substrate-mcp; **`127.0.0.1:7411` free**; `127.0.0.1:6081` substrate-desktop; `agentos-api` on :8000 is Agno AgentOS (unrelated name collision, STACK H — not a port, not a conflict).
- Sandbox image `substrate-sandbox:0.1`: **absent** (`No such image`) — the Dockerfile ports in 31-02, the build is OPERATOR-GATED in 31-03's tail. Base pulls (`node:24-bookworm-slim` + gh + bun) exceed 2 GB of network — likewise gated.

### Identity row (D31-09 input)
- `docs/runbooks/production-identity.md:88`: `substrate-host` | surface `substrate` | per-unit host env file, host-job token variable | **`dormant:31`** | expected 401s until the restoring phase. Sibling: dispatcher `dormant:24` (flipped by Phase 24's gated restart, not here). This phase reads token files by name only, never values; the manifest is NOT flipped in this phase's PR.

### September host state (read-only)
- `substrate-host.service` is **not** in main's `infra/vps/` (only dispatcher/collectors/skills units) — September's unit (read in full this session: `RIVET_RUN_ENGINE=1`, `RIVETKIT_STORAGE_PATH=/var/lib/substrate/agentos`, `WorkingDirectory=…/packages/host`, `ExecStart=/usr/bin/node src/main.ts`, `StateDirectory=substrate`, `TimeoutStopSec=15`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`) ports as P-17 with the engine env decided by the spike.
- No September worktree/host state to preserve: `packages/host` on main holds only `package.json` (stub); `/var/lib/substrate/agentos` (318 M) is rivet storage from September, left alone.
</local_evidence>

<ports>
## Port Map (acc30a8 → main)

| # | September file | Disposition on main | Plan |
|---|---|---|---|
| P-01 | `packages/host/src/api.ts` (+ `api.test.ts`) | Port whole; transport already matches `server.ts` pattern | 31-03 |
| P-02 | `packages/host/src/tasks.ts` (+ `tasks.test.ts`) | Port whole; `SubstrateLike` call sites rewritten to bearer + `lease_id` client (the 31-02 greenfield seam) | 31-02 |
| P-03 | `packages/host/src/substrate.ts` | **Rewrite** (anonymous JSON-RPC → host-job bearer, `lease_id` persist, heartbeat); `HOST_SURFACE` kept | 31-02 |
| P-04 | `packages/host/src/vm.ts` | Port whole incl. three 0.2.21 workaround comments; no option renames (names VERIFIED above) | 31-02 |
| P-05 | `packages/host/src/sandbox-provider.ts` + `sandbox-options.ts` (+ tests) | Port whole; **add the 10 GiB in-code gate** at the build/pull entry (LANEA-05 greenfield) | 31-03 |
| P-06 | `packages/host/src/seed.ts` (+ `seed.test.ts`) | Port whole; MCP entry gains bearer header (Phase 20 tokens-dir pattern) | 31-02 |
| P-07 | `packages/host/src/main.ts` | Port whole; fix hard-coded operator checkout path → repo checkout; engine env per spike outcome | 31-03 |
| P-08 | `packages/host/src/options.ts` (+ `options.test.ts`) + `sandbox-options` route envs | Port whole (route facts stay env-driven per September unit) | 31-02 |
| P-09 | `packages/host/src/hostfns.ts` (+ `hostfns.test.ts`) | Port whole (commit/push/PR fns; exercised in Phase 32) | 31-02 |
| P-10 | `packages/host/src/sync.ts` (+ `sync.test.ts`) | Port whole (tracker sync; exercised in Phase 32) | 31-02 |
| P-11 | `packages/host/src/telegram.ts` (+ `telegram.test.ts`) | Port whole (approval broker; exercised in Phase 33) | 31-02 |
| P-12 | `packages/host/src/mcp-proxy.ts` (+ `mcp-proxy.test.ts`) + `audit.ts` (+ `audit.test.ts`) | Port whole | 31-02 |
| P-13 | `packages/host/package.json` + `package-lock.json` | Port whole; **add `@agentos-software/claude-code@0.2.7` to dependencies** (declared, exact) | 31-02 |
| P-14 | `infra/sandbox/Dockerfile` | Port whole (pinned bun + sha256, keep-label); build is gated, never run in-repo | 31-02 |
| P-15 | `infra/vps/substrate-host.service` (+ `.d/` drop-in if September has one) | Port whole; engine env per spike; `ConditionPathExists` on `packages/host/src/main.ts` (Phase 16 convention); per-unit `EnvironmentFile` | 31-03 |
| NOT ported | September `.planning/` archives (hostnames, pre-lease decisions) | Reference only | — |
| NOT ported | `21652a2` host-adjacent stubs | No host content; ignored | — |

**What is greenfield (on no branch):** `substrate.ts` bearer/`lease_id`/heartbeat rewrite; 10 GiB in-code disk gate; `main.ts` checkout-path fix; `@agentos-software/claude-code` declared dep; `scripts/host-spike.ts` (gated spike runner) + `scripts/host-smoke.ts` (fake-based rehearsal proof); `docs/runbooks/lane-a-host.md`; `smoke:host` package script.
</ports>

<spike>
## Spike Design (plan 31-01)

Order (each step records its outcome in `31-SPIKE.md`; a failed step stops the gated tail, never the rehearsal half):

1. **Read-only (in-repo, no approval):** assert `/dev/kvm` absent, no `vmx`/`svm` flags, 6420 held by `gcs-rivet-rivet-engine-1`, 7411 free, ≥10 GiB free, `substrate-sandbox:0.1` absent, `/var/lib/substrate/agentos` 318 M. (Done in this RESEARCH.md; the spike re-asserts so drift is caught.)
2. **Dependency footprint (OPERATOR-GATED G1):** `npm ci` in a scratch copy of `packages/host` (never the repo dir, so a half-install cannot dirty the tree); record bytes + wall time; assert `node -e "import('@rivet-dev/agentos')"` resolves.
3. **Engine share (OPERATOR-GATED G2):** with the scratch install, connect to the existing `127.0.0.1:6420` engine and open one session on a scratch graph id; record whether the shared engine serves the host's actors. Fallback (same gate, second run): spawn a loopback engine on a free port. The outcome fixes the unit's engine env (D31-04).
4. **No-KVM boot (OPERATOR-GATED G3):** one VM open → prompt (`echo` only, no model quota beyond the session itself) → dispose on the scratch graph; record fresh-vs-stale behavior and dispose-hook execution. No sandbox container (image absent), no substrate writes, no Linear/Notion calls.
5. **Cleanup:** dispose the VM, unload the session, remove the scratch dir; verify `gcs-rivet-rivet-engine-1` still healthy and 7411 still free.

Concurrency guard: the spike never runs while a rehearsal harness holds the loopback ports it probes (Phase 16 smoke guard pattern).
</spike>

<risks>
## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Shared 6420 engine refuses the host's actors (auth/version drift after 8 days) | MEDIUM | Spike falls back to a second loopback engine; unit env differs, code identical | G2 records both paths; D31-04 fallback pre-approved as env-only |
| `npm ci` exceeds its 2.2 GB precedent or 0.2.21 no longer resolves | LOW | Port blocked on network, not on code | G1 measures first; packaging plans land unblocked (they need no install) |
| agentos 0.2.21 runtime rejects a VERIFIED option name (type vs runtime drift) | LOW | `vm.ts` needs a compat shim | G3 is the first runtime execution; failure is a gap with the exact rejection recorded |
| Per-VM disk exceeds budget at scale | LOW | 120 GB free absorbs the spike; sustained scale is Phase 32+ business | 10 GiB floor + 318 M baseline recorded; runbook carries the budget table |
| Bun workspace tries to resolve host deps on `bun install` | LOW | Lock churn | Host deps are npm-only (D31-02); a lock test asserts no `agentos` entry migrates into root resolution |
</risks>
