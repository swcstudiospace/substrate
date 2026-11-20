# Extension points: configuration mechanism, Swarm and Realm hooks (W1-E)

Read-only discovery for spec graph `ut-f35e12d58f-ed1087ea`. No code, tests, or tooling were run; nothing was edited except this file.

Path conventions: `substrate:` = `/root/src/repos/agent-substrate/`, `swarm:` = `/root/src/repos/agent-swarm/`, `realm:` = `/root/src/repos/agent-realm/`, `realm-integrate:` = `/root/src/repos/agent-realm-integrate/`. Spec = `/root/.omp/agent/ultrathink/sessions/01a1d01f-29fb-745f-a2d2-9bce5b3f2926.xml`.

## 1. Spec definitions (verbatim)

From the spec, `n5` CONCLUSION list (lines 344, 345, 347):

- Q6, spec line 344: `- Q6 What feature-flag mechanism does the repo already use? Default: extend the existing config mechanism; if none exists, add per-store boolean flags that default to off.`
- Q7, spec line 345: `- Q7 Where are the Swarm and Realm extension points (registration, config, and cleanup hooks)? Default: extend existing registration and hooks only; create no new plugin or manifest.`
- Q9, spec line 347: `- Q9 Are Substrate, Ultrathink, Swarm, and Realm active during autonomous runs? Default: inactive unless their config enables them, and Substrate write paths stay off until their feature flags are on.`

Related spec text used below:
- Spec line 162: `Limit to isolation needed for Tracks 02 through 06: per-run scoping of memory writes so one realm cannot read or promote another realm's candidate memory, and per-run cleanup of temporary artifacts.`
- Spec line 245: `Whether Substrate, Ultrathink, Swarm, and Realm are enabled during autonomous runs. Current status: assume inactive until config shows otherwise.`
- Spec line 389: `Feature flags: all Substrate write paths stay off until their flags are enabled; default flags are off.`
- Spec line 398 (W1-E): `done when: each is cited by path, with the default recorded for anything missing`

## 2. Answers

### Q6: feature-flag mechanism

**Answer: the repo already has one.** Default per spec line 344 ("extend the existing config mechanism") applies; no new mechanism is needed.

Mechanism, in four parts:

1. **Typed registry (documentation and lock, not loader).** `substrate:packages/mcp-server/src/flag-registry.ts`
   - Header, lines 9-24: the registry is "the typed registry of every environment variable read by TypeScript under `packages/` and `scripts/`". Lines 20-24 state it "does not drive `loadConfig`" and "A row therefore never changes behaviour."
   - `FlagKind` (`mode | toggle | number | path | list | secret-ref | string`), line 43.
   - `FlagSpec` shape, lines 142-161: `default` (147), `allowed` (149), `unset` (151), `readBy` (153), `documented` (155), `status` (157), `doc` (159), `policy` (160).
   - `FLAG_FAMILIES` (composed names), lines 191-245; `REGISTRY_EXEMPT`, lines 247-270; `FLAGS`, lines 276-1139.
   - Adding a flag: one object literal in `FLAGS` (lines 31-32).
   - Lock: `findUnregistered` at line 1167 rejects any env read with no row; the scanner is `substrate:packages/mcp-server/src/flag-registry-scan.ts:163` (`scanFiles`). Renders to `substrate:docs/config-reference.md` (header lines 15-16).
   - Lookup helpers: `flagByName` line 1150, `policyFlags` line 1157.

2. **Reader: bespoke parsers in `config.ts`.** `substrate:packages/mcp-server/src/config.ts`
   - `toggleOn(raw)` at lines 2350-2353: `/^(1|true|yes|on)$/i` on the trimmed value; unset is off.
   - Toggle call sites: lines 1303-1306 (`steeringSessionsTable: toggleOn(env.SUBSTRATE_STEERING_SESSIONS_TABLE)`, `briefSessions: toggleOn(env.SUBSTRATE_BRIEF_SESSIONS)`).

3. **Example of a write flag being read: `SUBSTRATE_RAILWAY_WRITES`.**
   - Registry row: `substrate:packages/mcp-server/src/flag-registry.ts:818`: `kind: "toggle"`, `default: "off"`, `allowed: "on"`, `readBy: "mcp-server/railway.ts"`.
   - Config doc comment: `substrate:packages/mcp-server/src/config.ts:351-352`: "Writes stay refused unless `SUBSTRATE_RAILWAY_WRITES` is exactly `on` (D45-c)."
   - Reader: `substrate:packages/mcp-server/src/railway.ts:449` (`writesEnabled: boolean`) and `:482` (`writesEnabled: env.SUBSTRATE_RAILWAY_WRITES === "on"`). Note this is an exact-match parse, unlike `toggleOn` (`1|true|yes|on`).
   - Enforcement: `substrate:packages/mcp-server/src/railway.ts:557`: `if (!config.writesEnabled) return "writes-disabled";`, evaluated before the operator check at `:558`.

4. **Other write-path gates, same pattern (all default off):** `SUBSTRATE_CORPUS` (`flag-registry.ts:869`; off answers 503 `corpus.disabled`), `SUBSTRATE_WORKTREE_REGISTRY` (`:323`; off answers 503 `worktrees.disabled`), `SUBSTRATE_EMBED_CACHE` (`:608`), `SUBSTRATE_PLANNING_HASH_STORE` (`:876`).

Gap: **no per-store write boolean for memory, Context Matrix, candidates, or promotion exists.** rg over `flag-registry.ts` for `MEMORY|CONTEXT|MATRIX|PROMOT|CANDIDATE` returns only `SUBSTRATE_MEMORY_REVIEW_TOKENS` (`:280`), `SUBSTRATE_MEMORY_GRANTS` (`:281`), `SUBSTRATE_MEMORY_EXPIRY` (`:420`), `SUBSTRATE_MEMORY_LIFECYCLE` (`:454`), none of which is a write gate.

**Default applied (Q6, spec line 344):** extend the existing mechanism. Concretely: add a `FLAGS` row (`flag-registry.ts` lines 276-1139) and a reader in `config.ts` next to lines 1303-1306, default `off`. The spec's "if none exists" branch does not apply.

### Q7: Swarm and Realm extension points

**Answer: both plugins register through the omp extension mechanism. Neither has a separate plugin manifest that the hooks depend on.**

#### Swarm (`swarm:`)

Registration
- `swarm:omp/package.json:6`: `"extensions": ["./src/index.ts"]`.
- `swarm:omp/src/index.ts:31` `createSwarmExtension(...)` returns the factory; line 124 `export default createSwarmExtension({ bridge: runPy });`. Header lines 2-6: omp calls the factory once per session, subagents included, "so it only registers."
- Registers: tools `pi.registerTool` (`index.ts:41`), `/swarm` command (`:43`), `/swarm-status` (`:45`), `session_shutdown` (`:56`), session-event bar (`:62-74`), `before_agent_start` (`:77`), `tool_call` guard (`:87`), `tool_result` (`:115`).
- Non-plugin hook scripts: `swarm:hooks/user_prompt_submit.py`, `swarm:hooks/autonomous_run.py`, `swarm:hooks/on_a01_complete.py`. They are wired for Claude and Grok, not the omp factory. `swarm:README.md:180` says the A01 Stop hook is "not registered by default"; `swarm:README.md:183-185` lists its opt-ins.

Configuration
- Kill switch: `swarm:omp/src/index.ts:33-35`: `SWARM_DISABLED=1` registers nothing, "Read per call."
- Root: `swarm:omp/src/bridge.ts:86` `swarmRoot()` (env `SWARM_ROOT`).
- Per-session child scoping: `swarm:omp/src/index.ts:36-40` (`inflight` set, `scoped` bridge).
- Autonomous-run opt-in: `swarm:swarm/hook_trigger.py:64-68` `is_opt_in()` reads `AIO_SWARM_AFTER_ORCH` or `SWARM_AFTER_ORCH` (`1|true|yes|on`); `:75` requires `SWARM_ALLOW_AUTONOMOUS == "1"`.
- Runner caps: `swarm:hooks/autonomous_run.py:12-13` (`SWARM_AUTONOMOUS_RUN_CAP_S` default 3600, `SWARM_AUTONOMOUS_RUN_GRACE_S` default 15); `:247`, `:251`. Shutdown budget `swarm:scripts/swarm_run.py:56` and `:2626` (`SWARM_SHUTDOWN_BUDGET_S`, default 15).

Cleanup hooks
- Session end: `swarm:omp/src/index.ts:56-58`: `session_shutdown` calls `killInflight(inflight)` (line 57) then `bar.stop()`.
- Process-group kill: `swarm:omp/src/bridge.ts:104` `killGroup`, `:114` `killInflight`; run loop `:163` `runScript`; export `:250` `runPy`.
- Autonomous run: `swarm:hooks/autonomous_run.py:271-273` `finally:` releases the debounce stamp; `:93` ignores repeat SIGTERM "so a repeat must not interrupt the cleanup."

Missing: **per-run temporary-artifact removal.** `swarm:omp/src/bridge.ts:149-160` (`writeInputFile`) writes `results/<kind>-<id>.json` and never removes it. rg for `unlink|rmSync|rmdir|rm\(|rename\(` in `swarm:omp/src` (non-test) returns no removal of run artifacts.
- Default (spec line 345): "extend existing registration and hooks only; create no new plugin or manifest." Extension point: `swarm:omp/src/index.ts:56` (session_shutdown) or `swarm:hooks/autonomous_run.py:271` (finally).

Not read: `swarm:swarm/manifest.py` (248 lines) is not a plugin manifest by name and was not read; it is not cited. `swarm:.bg-shell/manifest.json` is `[]` (0 lines). `swarm:swarm/substrate_mcp.json` configures the Substrate MCP entry per runtime; it is not a Swarm lifecycle hook.

#### Realm (`realm:`)

Registration
- `realm:package.json:30-34`: `"omp": { "extensions": ["./dist/src/omp/extension.js"] }`. Source: `realm:src/omp/extension.ts`. The same key is at `realm-integrate:package.json:30-32` (older copy; `realm-integrate:adapters/hermes-agent/plugin.json` version 0.3.27 vs 0.3.29).
- `realm:src/omp/extension.ts:29` `export default function realmExtension(pi)`; line 80 `registerRealmPlugin(pi, { attachDaemon, reattach: ... })`.
- `realm:src/omp/plugin.ts:304` `registerRealmPlugin`. Registers the five Realm tools at line 689 (`pi.registerTool(tool)`) and `realm-retry` at line 694 (`REALM_RETRY_COMMAND = "realm-retry"`, line 158). Comment at line 661: tools "register at load in every mode."
- Host-side registration (non-code): `realm:adapters/hermes-agent/plugin.json:5` says "Declares no code"; its server is `trust: untrusted` (lines 8-10).

Configuration
- Config file: `realm:src/runtime/host-paths.ts:12-13` (`$XDG_CONFIG_HOME/realm/config.json`, else `$HOME/.config/realm/config.json`); `:15` `resolveConfigPath`; `:36-43` `readHostRuntime` (throws on invalid config at load; see `realm:src/omp/extension.ts:30-31`).
- Required fields: `realm:src/runtime/config.ts:15-16` (`stateDir`, `workspaceRoot`, absolute); `:56` `loadRuntimeConfig`.
- Env read at the edge only: `realm:src/omp/extension.ts:31` (`readHostRuntime(process.env)`), `:33` `REALM_OMP_REATTACH` via `reattachEnabledOf` (`:19-27`: unset or `0` off, `1` on, other value throws `SCHEMA_INVALID`).
- Re-attach default off: `realm:src/omp/plugin.ts:312-313` ("or null while re-attach is off (the default)").
- Socket: `realm:src/omp/extension.ts:34` `controlSocketPath(stateDir)`; `realm:src/runtime/host-paths.ts:45-49` (`XDG_RUNTIME_DIR`).
- Daemon attach: `realm:src/omp/extension.ts:37-48` (`ensureDaemon`, `startDetachedDaemon` at `:44`).

Cleanup hooks
- Host session end: `realm:src/omp/plugin.ts:658-660` `pi.on("session_shutdown", () => endSession())`; `endSession` at `:318-332` clears timers and closes the client. `realm:src/omp/plugin.ts:316-317`: "The client is closed, never taken down: the daemon keeps the sandbox."
- Documented: `realm:docs/integration/omp.md:152`: "The sandbox persists until `realm down`."
- Destroy (explicit teardown): `realm:src/lifecycle/controller.ts:566-587` `destroy()`: stop/destroy container (`:570`, `:578`), `releaseOwner` (`:580`), `store.delete(sessionId)` (`:585`). Sandbox name: `:836-837` `realmSandboxName(sessionId)`. Container destroy calls: `:604`, `:731`.
- Teardown bound: `realm:src/lifecycle/bounds.ts:9` `TEARDOWN_TIMEOUT_MS = 30_000`; option `realm:src/lifecycle/controller.ts:84-85`.
- Startup orphan sweep: `realm:src/daemon/startup.ts:366-375` (`sweepRootsOf`, roots from workspace roots and stateDir), called at `:228`.
- File-removal helpers (driver layer): `realm:src/runtime/driver/channel.ts:228` `removeKeyFile` and `:243` `removeTlsWorkDirectory` (called at `:122-123`); `realm:src/runtime/driver/secret-store.ts:137` `removeSecretEntries` (called at `:176`, `:261`, and `realm:src/runtime/driver/lifecycle.ts:425`, `:695`); `realm:src/runtime/driver/compute-driver-state.ts:40` `removeStateDir` (called at `realm:src/runtime/driver/compute-driver.ts:795`); `realm:src/runtime/driver/compute-driver.ts:460` (`removeKeyFile`).

Missing: **per-run memory-write scoping** and **a per-run cleanup hook keyed to a run.** rg over `realm:src` (non-test) for `hindsight|substrate|candidate|promot` returns no memory integration (matches are `audit/anchor.ts`, `audit/chain.ts` tree promotion, and `daemon/startup.ts` candidate lists). Realm's unit of cleanup is the session (`sessionId`), not a run.
- Default (spec line 345): "extend existing registration and hooks only; create no new plugin or manifest." Extension points: `realm:src/omp/plugin.ts:658` (`session_shutdown`) and `realm:src/lifecycle/controller.ts:566` (`destroy`).

Where "realm" scoping does exist: Substrate's own `realm` column, not the Realm plugin. `substrate:packages/mcp-server/src/index-store.ts:1080` (`realm text not null default 'default'`), `:2608` (`listAcceptedContext(realm, ...)`); `substrate:packages/mcp-server/src/context-matrix-gate.ts:82` (`entry.realm === candidate.realm` in the same-slot check). Spec line 162 says this scoping is required; it is a Substrate change, not a Realm hook.

### Q9: are the four plugins active during autonomous runs?

**Answer: the spec default is not met for Swarm's interactive path or for Realm.** Recorded as found; no code was changed.

- **Swarm, omp extension:** active on load unless `SWARM_DISABLED=1`. Evidence: `swarm:omp/src/index.ts:35` is the only gate; everything else registers. This is the opposite of the spec default ("inactive unless their config enables them") for the interactive path.
- **Swarm, autonomous-run hook:** inactive unless opted in. Evidence: `swarm:swarm/hook_trigger.py:64-68` (`AIO_SWARM_AFTER_ORCH` or `SWARM_AFTER_ORCH`), `:75` (`SWARM_ALLOW_AUTONOMOUS=1`), `swarm:README.md:180` (A01 hook not registered by default), `swarm:hooks/autonomous_run.py:192` (`SWARM_DISABLED` returns 0). This matches the spec default.
- **Realm:** active on every omp session once the config is valid. Evidence: `realm:src/omp/plugin.ts:643-645` (`session_start` calls `beginSession`), `:609-636` (`beginSession` always starts `attach`; there is no enable switch), `realm:src/omp/extension.ts:37-48` (spawns a detached daemon if absent). `REALM_OMP_REATTACH` (`extension.ts:33`) controls re-attach only, not activation. No enabling config was found. The spec default cannot be met by existing code without a new switch; that is a decision for the user, not this unit.
- **Substrate:** partial. Substrate's write paths are gated per feature, default off (`flag-registry.ts:323`, `:818`, `:869`). No Substrate-wide write gate and no memory-write gate were found (see Q6). Not fully verified.
- **Ultrathink:** not investigated (outside the Swarm and Realm assignment).

## 3. Summary table: items and defaults

| Item | Found? | Evidence | Default (spec, quoted) |
|---|---|---|---|
| Feature-flag registry | yes | `substrate:packages/mcp-server/src/flag-registry.ts:276-1139` | Q6 line 344: "extend the existing config mechanism" |
| Write-flag reader | yes | `substrate:packages/mcp-server/src/railway.ts:482, 557`; `config.ts:2351-2353` | Q6 line 344 |
| Per-store memory write boolean | no | rg over `flag-registry.ts` (see Q6) | Q6 line 344: "if none exists, add per-store boolean flags that default to off" |
| Swarm registration | yes | `swarm:omp/package.json:6`; `swarm:omp/src/index.ts:31-124` | Q7 line 345: "extend existing registration and hooks only; create no new plugin or manifest" |
| Swarm config | yes | `swarm:omp/src/index.ts:33-35`; `swarm:swarm/hook_trigger.py:64-75` | Q9 line 347 |
| Swarm cleanup (session) | yes | `swarm:omp/src/index.ts:56-58`; `swarm:omp/src/bridge.ts:114` | Q7 line 345 |
| Swarm per-run artifact cleanup | no | `swarm:omp/src/bridge.ts:149-160` (writes, no removal) | Q7 line 345 |
| Realm registration | yes | `realm:package.json:30-34`; `realm:src/omp/plugin.ts:304, 689, 694` | Q7 line 345 |
| Realm config | yes | `realm:src/omp/extension.ts:31, 33`; `realm:src/runtime/host-paths.ts:15, 36-43`; `realm:src/runtime/config.ts:56` | Q6 line 344 (flag mechanism); Q9 line 347 (activation) |
| Realm cleanup (session) | yes | `realm:src/omp/plugin.ts:658-660, 318-332`; `realm:src/lifecycle/controller.ts:566-587` | Q7 line 345 |
| Realm per-run memory scoping | no (Realm); present in Substrate as `realm` column | `substrate:packages/mcp-server/src/index-store.ts:1080`; `context-matrix-gate.ts:82` | Q7 line 345 |
| Realm per-run temp-artifact cleanup | partial (session-scoped removal helpers) | `realm:src/runtime/driver/channel.ts:228, 243`; `secret-store.ts:137`; `compute-driver-state.ts:40` | Q7 line 345 |
| Realm enable switch | no | `realm:src/omp/plugin.ts:643-645, 609-636` (always attaches) | Q9 line 347: "inactive unless their config enables them" (not met by code) |

## 4. Unresolved

- Swarm and Realm do not match the Q9 default (active on load). Needs a decision: add an enable switch, or accept active-on-load and record it in the spec.
- Per-run scoping (spec line 162) and per-run cleanup have no run-keyed hook in either plugin. Both must be built in the Substrate or Swarm code the W4-A unit names, using the Q7 default ("extend existing registration and hooks only").
- Ultrathink and Substrate overall activation were not investigated.
- `realm-integrate` and `swarm-lanes` are copies; `swarm:omp/src/index.ts` differs from the lane copy (`agent-swarm-lanes/qa-node-test-oct31/omp/src/index.ts`). This unit cites the main `agent-swarm` checkout.
