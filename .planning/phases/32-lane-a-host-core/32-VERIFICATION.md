---
phase: 32-lane-a-host-core
verified: 2026-11-19T00:00:00Z
status: human_needed
score: 3/3 truths verified (truth 1 carries a WARNING; truth 3 verified under the build_proxy decision)
covered_files: [".planning/milestones/v1.3-phases/32-lane-a-host-core/32-01-PLAN.md", ".planning/milestones/v1.3-phases/32-lane-a-host-core/32-01-SUMMARY.md", ".planning/milestones/v1.3-phases/32-lane-a-host-core/32-02-PLAN.md", ".planning/milestones/v1.3-phases/32-lane-a-host-core/32-02-SUMMARY.md", ".planning/milestones/v1.3-phases/32-lane-a-host-core/32-03-PLAN.md", ".planning/milestones/v1.3-phases/32-lane-a-host-core/32-03-SUMMARY.md", ".planning/milestones/v1.3-phases/32-lane-a-host-core/32-CONTEXT.md", ".planning/milestones/v1.3-phases/32-lane-a-host-core/32-RESEARCH.md", "packages/host/src/hostfns.ts", "packages/host/src/main.ts", "packages/host/src/options.test.ts", "packages/host/src/options.ts", "packages/host/src/seed.test.ts", "packages/host/src/seed.ts", "packages/host/src/substrate-proxy.test.ts", "packages/host/src/substrate-proxy.ts", "packages/host/src/substrate.ts", "packages/host/src/sync.ts", "packages/host/src/tasks.test.ts", "packages/host/src/tasks.ts", "scripts/host-smoke.ts"]
covered_digest: "v3:sha256:5d4f58c9c04c211b4659b6fad13882683f1926a1a01338bffcfbda94758d9bf0"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 2/3
  gaps_closed:
    - "Criterion 3 (VM holds no tokens): the seeded substrate entry is now headerless and points at the host substrate proxy on 127.0.0.1:7413, which attaches the host bearer (build_proxy, owner decision). The session env no longer carries SUBSTRATE_VM_ANTHROPIC_API_KEY; the VM gets the placeholder 'shunt' and the host model relay on 127.0.0.1:3001 holds the key."
  gaps_remaining:
    - "Criterion 1 (WARNING, latent): a failure after the task record is saved leaves a restart-resumable record (turn_in_flight: true, released: false). Not reachable on the live route a:loopback; reachable on a:hostfn_proxy."
  regressions: []
human_verification:
  - test: "L1: run one task end to end on an isolated graph with a throwaway repository, through the Phase 16 harness"
    expected: "Lease is held by claude-code for the whole turn, heartbeats are sent, a commit and push land on substrate/<gid>, one PR is opened and PR fields sync; the VM's substrate MCP calls succeed through the proxy"
    why_human: "Spends real Claude Code quota and Docker capacity; docs/runbooks/lane-a-host.md gates it behind an operator-approved window"
  - test: "L2: production unit install and restart of substrate-host.service with a single continuation pass"
    expected: "One resume:1 continuation is sent after the restart and no further replay on a third boot"
    why_human: "Changes the live host service; operator action"
  - test: "L3/L4: manifest flip dormant:31 to live, and any real claude-code quota spend outside L1"
    expected: "Not performed by this verification"
    why_human: "Live operator decisions; not required to close the code-level success criteria"
  - test: "P1: confirm the model relay on 127.0.0.1:3001 on the host holds the Anthropic key and answers the VM's /v1/messages"
    expected: "A session on a:loopback completes one model turn with ANTHROPIC_API_KEY=shunt inside the VM"
    why_human: "The relay is an external host service (docs/runbooks/lane-a-host.md, 'Never-type-secrets class'); nothing in packages/host starts it, so this repo cannot prove it is up"
---

# Phase 32: Lane A host core Verification Report

**Phase Goal:** A host task works its node under the `claude-code` lease from start to finish, survives a host restart, and keeps every credential on the host.
**Verified:** 2026-11-19
**Status:** human_needed
**Re-verification:** Yes. The previous record (gaps_found, criterion 3 blocker) is overwritten. Criterion 3 is re-verified under the owner's build_proxy decision: the VM holds no host bearer and no real API key, and the VM's substrate MCP entry points at the host proxy in `packages/host/src/substrate-proxy.ts` on 127.0.0.1:7413, which adds the host bearer. D32-08 (bearer in the VM) is superseded and no override is recorded.

## Scope of this pass

- Read in full: `seed.ts`, `options.ts`, `tasks.ts` (openTask, startPrompt, releaseOnce, complete), `main.ts` (proxy wiring), `substrate-proxy.ts`, and the uncommitted diffs for `seed.ts`, `options.ts`, `tasks.ts`, `main.ts`, `scripts/host-smoke.ts`.
- Test run, one invocation: `bun test src/seed.test.ts src/options.test.ts src/substrate-proxy.test.ts --timeout 60000` from `packages/host`. Result: **48 pass, 0 fail, 3538 expect() calls**, 3 files.
- Not re-run this pass (outside the named invocation): `tasks.test.ts`, `scripts/host-restart.test.ts`, `scripts/host-smoke.ts`. Truth 2 is carried forward from the previous record. The diff does not touch the resume path except the shared `ensureModelRoute` call, and `sessionEnv` has no caller there.

## Goal Achievement

### Observable Truths

| # | Truth (ROADMAP success criterion) | Status | Evidence |
|---|---|---|---|
| 1 | `openTask(graphId)` reads the node, claims as `claude-code`, keeps the `lease_id` and heartbeats while turns run, seeds brief/skills/MCP with sha256 read-back, opens with permission policy "ask", releases the claim on any failure | ✓ VERIFIED, with a WARNING | `tasks.ts` `openTask` (~line 765): `graphGet`, node-claimed-by check, `claimAndPersist` as `HOST_SURFACE` `claude-code`, persist-then-verify on `leases.load` (502 + `releaseOnce`), `seedFiles` with per-file write, `readFile`, sha256 compare, throws `seed read-back mismatch`; `sessions.open` with `permissionPolicy: "ask"`; `startPrompt` arms the heartbeat and releases once on every non-shutdown settle. Pre-save failures release the claim via `graphRelease` (test `tasks.test.ts` "sessions.open throwing ... releases it once", "ensureModelRoute throwing ... releases it once"). WARNING: see gap below. |
| 2 | After a host restart mid-session, a continuation prompt keyed `<graph_id>:<node_id>:resume:<n>` resumes the same work | ✓ VERIFIED (carried forward, not re-run) | `tasks.ts` `resumeInterrupted()` selects `interruptedTasks()` (turn_in_flight && !released && exit_code === null), runs `heartbeatOrReclaim`, bumps `resumes`, sends `RESUME_TEXT` with key `${gid}:${nid}:resume:${record.resumes}`. `main.ts` calls `service.resumeInterrupted()` before the API accepts requests. Prior targeted run of `scripts/host-restart.test.ts`: 2 pass. |
| 3 | The VM holds no tokens; host functions commit and push (never force, never `.substrate-*`), open the PR and sync PR fields through the substrate's Linear and Notion clients | ✓ VERIFIED (build_proxy) | **No host bearer in the VM.** `seed.ts` `seedFiles()` writes the substrate entry as `{ type: "http", url: SUBSTRATE_PROXY_URL }` with no headers; `seed.test.ts:416` asserts the entry is the bare URL and `seed.test.ts:419` asserts no `Authorization` in `.claude.json`. `tasks.ts` no longer passes a bearer into `seedFiles` (the `substrateBearer` input is removed). The session `mcpServers` entry is `{ url: SUBSTRATE_PROXY_URL, headers: [] }`. Grep of `packages/host/src` for `bearer` outside `substrate.ts`, `main.ts` proxy wiring and types finds no path that writes it into a VM file or session. **No real API key in the VM.** `options.ts` `sessionEnv()` returns exactly five keys: `ANTHROPIC_BASE_URL` = `MODEL_RELAY_URL` (127.0.0.1:3001), `ANTHROPIC_API_KEY` = `"shunt"`, `ANTHROPIC_MODEL`, `SUBSTRATE_GRAPH_ID`, `SUBSTRATE_NODE_ID`; `options.test.ts:95` asserts "the model relay and the placeholder key, no real key". `SUBSTRATE_VM_ANTHROPIC_API_KEY` is no longer read by `main.ts`. **Proxy.** `substrate-proxy.ts` binds 127.0.0.1:7413 only, accepts only `/mcp` (else 404 with no upstream contact), drops every VM-supplied `authorization` header and attaches `Bearer <host bearer>`; `substrate-proxy.test.ts` covers attach+drop, path refusal, and 502 on upstream failure. **Host functions** meet the criterion unchanged: `hostfns.ts` `pushArgv` fixes `git push origin substrate/<gid>` with no `--force`; `commitArgv` excludes `.substrate-*`; `prCreateArgv` fixes `--repo/--head/--base`; `sync.ts` `NotionSync`/`LinearLink` are constructed host-side in `main.ts`. The model key is held by the host relay on 127.0.0.1:3001, which is outside this repo (see P1 below). |

**Score:** 3/3 truths verified (truth 1 carries a WARNING; truth 3 verified under build_proxy)

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `packages/host/src/substrate-proxy.ts` | Host MCP proxy, bearer attached host-side, VM header dropped, loopback-only bind | ✓ VERIFIED | 127.0.0.1:7413; `/mcp` only; hop-by-hop headers stripped; `startSubstrateProxy` called from `main.ts` only when `substrate.bearer` resolves |
| `packages/host/src/seed.ts` | Seed with headerless substrate entry pointing at the proxy | ✓ VERIFIED | `substrateProxyLoopback` and the bearer parameter are removed; default URL is `SUBSTRATE_PROXY_URL` |
| `packages/host/src/options.ts` | Five-key session env; loopback port and network rules for the proxy | ✓ VERIFIED | `loopbackPorts`: proxy 7413 only on a:loopback; `networkPermissions` matches |
| `packages/host/src/tasks.ts` | openTask, lease heartbeat, release, resume | ✓ VERIFIED (WARNING) | Calls updated to the new `sessionEnv` and `seedFiles` signatures; `mcpServers` uses `SUBSTRATE_PROXY_URL` on `s:mcp` |
| `packages/host/src/main.ts` | Proxy started with the host bearer; closed on shutdown | ✓ VERIFIED | `startSubstrateProxy({ upstream: \`${mcpBase}/mcp\`, bearer })`; `mcpBase` strips the trailing `/mcp`, so the upstream is `http://127.0.0.1:7410/mcp`; `substrateProxy?.close()` on SIGINT/SIGTERM |
| `scripts/host-smoke.ts` | Smoke checks that the entry is at the proxy with no bearer | ✓ VERIFIED (not run) | `substrateEntryAtProxy` asserts the URL and the absence of `authorization|bearer`; not executed this pass |
| `packages/host/src/hostfns.ts`, `sync.ts`, `substrate.ts` | Host functions and tracker writes stay host-side | ✓ VERIFIED (carried) | unchanged by this diff |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `seed.ts` substrate entry | `substrate-proxy.ts` | `SUBSTRATE_PROXY_URL` | ✓ WIRED | Same constant in `seed.ts`, `tasks.ts` and `scripts/host-smoke.ts` |
| `tasks.ts` session `mcpServers` | `substrate-proxy.ts` | `SUBSTRATE_PROXY_URL` on `s:mcp` | ✓ WIRED | |
| `main.ts` | `substrate-proxy.ts` | `startSubstrateProxy` with `substrate.bearer` | ✓ WIRED | Proxy is off when no bearer resolves; the VM's substrate entry is then refused (see consequences) |
| `options.ts` `loopbackPorts` | VM egress | 7413 exempted on a:loopback only | ✓ WIRED on a:loopback | Not exempted on a:anthropic_key or a:hostfn_proxy |

### Data-Flow Trace (Level 4)

Not applicable: no rendered UI. The proxy's data path is request/response pass-through, covered by `substrate-proxy.test.ts`.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Entry is headerless and at the proxy; session env has no real key; proxy attaches bearer and drops the VM's | `bun test src/seed.test.ts src/options.test.ts src/substrate-proxy.test.ts --timeout 60000` (in `packages/host`) | 48 pass, 0 fail | ✓ PASS |

### Probe Execution

Not declared for this phase. Skipped.

### Requirements Coverage

Requirement IDs LANEA-02, LANEA-03, LANEA-07 are the ones the previous record cited. Their meaning in `.planning/REQUIREMENTS.md` is not re-read in this pass. Criterion 3 (LANEA-07, "the VM holds no tokens") is satisfied under build_proxy. LANEA-02/03 are covered by truths 1 and 2.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| `packages/host/src/main.ts` | 7-8 | Header comment says "on route a:anthropic_key only, SUBSTRATE_VM_ANTHROPIC_API_KEY as the session's model auth" | ⚠️ Warning | Stale: `sessionEnv` no longer carries the key. Misleads the next reader |
| `infra/vps/substrate-host.service` | 33-35 | Comment says the key is copied into a VM on a:anthropic_key | ⚠️ Warning | Stale, same as above |
| `packages/host/src/tasks.ts` | ~865, ~874 | Second `ensureModelRoute` and the catch after `store.save(record)`; catch calls `graphRelease` directly and never updates the record | ⚠️ Warning | See gap 1 |

Debt-marker grep (`TBD`, `FIXME`, `XXX`) over `seed.ts`, `options.ts`, `tasks.ts`, `main.ts`, `substrate-proxy.ts` and `scripts/host-smoke.ts` found none. The empty-return matches in `options.ts` are input guards, not stubs.

### Human Verification Required

See the frontmatter `human_verification` block: L1 (real VM run), L2 (production restart), L3/L4 (operator decisions), and P1 (host relay on 127.0.0.1:3001 holds the key; not provable from this repo).

### Warnings and Consequences

**W1. VM graph calls depend on the host proxy (the consequence the owner asked to be noted).**
- On the live route (`infra/vps/substrate-host.service`: `SUBSTRATE_HOST_ROUTE=a:loopback,b:prompt_hostfn,c:hostfn_commit,s:hostfn`), the session `mcpServers` is empty, so Claude Code's session-level MCP registration does not run. But `seedFiles()` always writes the substrate entry into `/home/agentos/.claude.json`, and on a:loopback 7413 is exempt. So the VM can reach substrate MCP through the proxy with the host bearer attached.
- If no host bearer resolves, the proxy is off and that entry is refused. Substrate MCP calls from the VM fail. `main.ts` logs `substrate calls refused`.
- On a:anthropic_key and a:hostfn_proxy, 7413 is not exempt (`loopbackPorts`, `networkPermissions`), so the same entry is dead there. Any s:mcp session on those routes cannot reach substrate.
- Capability note: the proxy forwards every `/mcp` request. It does not apply the `substrate:*` host-function allowlist that `hostFunctionPermissions` enforces on host functions. Before this change the VM held the same bearer and could make the same calls, so the capability is unchanged. What changed is that the bearer no longer sits in a file. The owner should decide whether the seeded entry should be gated on `route.s === "mcp"` to match the session's `mcpServers`. Not changed in this pass.

**W2. Criterion 1 latent record defect (carried from the previous gap 2).**
- In `openTask`, `store.save(record)` runs before the second `ensureModelRoute` call. If that call or a later step in the try block throws, the catch calls `graphRelease` directly, not `releaseOnce`, and never updates the record. The record stays `turn_in_flight: true, released: false, exit_code: null`. `interruptedTasks()` then selects it on the next boot, and `resumeInterrupted()` re-claims and prompts a task the caller was told had failed.
- On the live route a:loopback `ensureModelRoute` returns at once, so this is latent. On a:hostfn_proxy the relay probe and spawn can throw and it is reachable.
- The existing test "ensureModelRoute throwing after the claim" throws at the first, pre-save call (~line 797), so it does not exercise this path.
- Fix: in the catch, mark the record `turn_in_flight = false`, `released = true`, `exit_code = 1`, `last_error` (or call `releaseOnce` and update), and add a test that throws on the second `ensureModelRoute` and asserts the stored record.

**W3. Stale comments.** `main.ts` lines 7-8 and `infra/vps/substrate-host.service` lines 33-35 still say the Anthropic key reaches a VM on a:anthropic_key. The code says otherwise. Not changed in this pass.

### Gaps Summary

No FAILED truth and no missing or stub artifact. Under the Step 9 decision tree, the status is `human_needed` because the phase still has operator-gated items (L1-L4, P1). Warnings W1-W3 do not block the code-level criteria. W2 is the one a reviewer should fix before the record is treated as closed for the resume path. The previous criterion-3 blocker is closed by the build_proxy change.

---

_Verified: 2026-11-19_
_Verifier: Claude (gsd-verifier)_
