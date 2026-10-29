# Phase 30: desktop_run - Research

**Researched:** 2026-10-08
**Domain:** MCP tool port (closed desktop vocabulary over `docker exec`), audit/event wiring, root lifecycle script, harness proof with pixel assertion
**Confidence:** HIGH for integration points and the port delta (every file read, two SDK behaviours probed); MEDIUM for the N1 cause (read-only evidence only; the spike decides)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
Copied from `30-CONTEXT.md` (D30-01..D30-21). Paraphrase is not allowed here; the planner reads the source for exact wording. Summary index, in the source's order:

- **D30-01** The operator allowlist `SUBSTRATE_DESKTOP_SURFACES` is the only gate; parsed into `config.desktopSurfaces: ReadonlySet<Surface>`; unset/empty = nobody; unknown names dropped and reported by `configWarnings` at boot (name only); `isOperator` grants nothing.
- **D30-02** Refusal cases, each with its own test: unlisted valid token (isError "desktop_run is not enabled for surface <s>; nothing was run", no docker call, no event); anonymous (`callerSurface === null`) always refused ("desktop_run needs an authenticated, operator-listed surface; nothing was run"); VM guest = no token on an authenticated deployment → 401 at the token gate (real HTTP server test), bogus bearer → 401, self-attribution (`surface` argument or `x-substrate-propose-key` header) rejected by the strict schema / ignored.
- **D30-03** Tool registered for every caller; refuses in its handler; the audit gate records the call before dispatch.
- **D30-04** Pre-run refusals (allowlist, anonymous, busy, validation) emit no event; the audit record is their trail; Phase 17 vocabulary unchanged.
- **D30-05** Vocabulary and limits ported as is (strict object; 1..50 actions; click/type/key/screenshot; timeout 1..120 s default 30; out-of-geometry click refuses the whole run before any action).
- **D30-06** Fixed argv `docker exec -e DISPLAY=:1 substrate-desktop` + `xdotool …` or `xwd -root -silent`; container name constant; `typeArgv` ends options with `--`; a test enumerates every argv builder.
- **D30-07** Child env allowlist `PATH` and `HOME` only; Buffer-mode `execFile`, 16 MiB `maxBuffer`, never a shell.
- **D30-08** One run at a time, refuse while busy, module-scope flag: "desktop_run is busy with run <run_id>; nothing was run"; test with two concurrent runs.
- **D30-09** XWD (24/32 bpp) → PNG; image blocks after one text block `{run_id, screenshots: [{path, width, height, sha256}], log}`; stored under `config.desktopDir/<run_id>/<n>.png`, dirs 0700 files 0600; 200 runs / 7 days; `SUBSTRATE_DESKTOP_DIR` overrides `/var/lib/substrate/desktop`.
- **D30-10** Budgets: 30 s per `docker exec`, +200 ms per typed char; settle defaults click 300 / type 200 / key 800 ms; deadline stops actions not started, never one in flight.
- **D30-11** One `tool.call` event per executed action (surface = caller, `actor: "agent"`, `session_id: "desktop:<run_id>"`, summary `desktop <action> ok|failed`, payload `tool`, `action`, `run_id`, `i`, `ok`, `ms`; type `text_len`+`text_sha256`; screenshot `sha256`,`width`,`height`; click `x`,`y`,`button`,`double`; key verbatim only under the named-key/modifier rule else `keys_len`+`keys_sha256`; failure `error` redacted ≤ 300); title not in the event; `EVENT_SOURCES` sample + `docs/event-vocabulary.md` updated in the same PR.
- **D30-12** `stored: false` stops the run; isError `{run_id, log, error: "event not stored after action <i>; run stopped"}`, no image blocks.
- **D30-13** Audit record never sees content (arg keys + digest only); test asserts no typed text / PNG / base64 and `auditMode("desktop_run") === "fail-closed"`.
- **D30-14** Port `infra/desktop/substrate-desktop.sh` with `up` and `status` only (order, flags and refusals as listed in CONTEXT).
- **D30-15** Script tests without Docker: PATH stubs for `docker`, `df`, `openssl`; assertions as listed; `bash -n` and `shellcheck` if present; non-root run exits 1.
- **D30-16** Proof = scripted MCP SDK client over streamable HTTP (`scripts/desktop-smoke.ts`, `bun run smoke:desktop`), harness token, no model.
- **D30-17** Pixel proof: nonce RGB band via `printf '\033[48;2;R;G;Bm%48s\033[0m\n'`, ≥ 1,500 px exact RGB forming one rectangle in the returned image block (sha256 = stored file = event), none in the baseline; trailing `exit`.
- **D30-18** N1 spiked before the proof plan; fix stays inside the vocabulary; if no capture path is fresh, the proof is a gap, never passed on titles.
- **D30-19** Smoke also checks: events per action under `desktop:<run_id>` via `POST /events/query`; audit file record `mode: fail-closed` with no typed text / `iVBOR`; live refusals (unlisted token isError, no token 401); `GET :6081/` 401; `recruitment-desktop` inspect identical before/after; `status` key lines; smoke guard (port 7410 / non-loopback refused).
- **D30-20** `bun run rehearsal up --desktop-surfaces a,b` (subset of `--surfaces`) → `SUBSTRATE_DESKTOP_SURFACES`; `SUBSTRATE_DESKTOP_DIR=<runDir>/desktop`; proof chain `rehearsal up --name p30 --surfaces omp,cursor --desktop-surfaces omp` → `smoke:desktop` → `check:phase-close` → `rehearsal down --name p30`.
- **D30-21** Docs: README gains `desktop_run`; new `docs/runbooks/desktop.md`; `docs/mcp-audit.md` marks `desktop_run` landed; `desktop.action` named nowhere as a kind.

### Claude's Discretion
- File split inside `packages/mcp-server/src/desktop/` (e.g. a separate `png.ts` for decode/encode) and test layout.
- Exact refusal wording, beyond containing "nothing was run".
- How `Substrate` receives the driver (constructor `stores`/deps seam like Phase 21's `SkillProposer`), as long as tests and the harness never reach the real runner by accident.
- Whether `configWarnings` names an empty allowlist when other tokens are set (informational only).

### Deferred Ideas (OUT OF SCOPE)
- A REST/CLI door for `desktop_run` (no image-block consumer today).
- Desktop access from Lane A VMs through a host function (would need its own allowlist entry and threat model; Phases 31–33 do not add one).
- OCR-based screenshot assertions.
- Cleaning up the 7 terminal windows September's smokes left in `substrate-desktop` (N2); the new smoke closes its own.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DESK-01 | `desktop_run` drives the dedicated `substrate-desktop` webtop with a closed vocabulary (click, type, key, screenshot), at most 50 actions, a 1–120 s timeout, a fixed `docker exec` argv and one run at a time; screenshots return as MCP image blocks and are kept at mode 0600 for 200 runs or 7 days. [VERIFIED: .planning/REQUIREMENTS.md:99] | Port map (§ Port delta), strict-schema probe (§ Pattern 2), image block type (§ Integration points), busy flag (§ Pattern 4), retention (`prune`) |
| DESK-02 | Each action produces one event under an existing kind; typed text is recorded only as its length and sha256; image blocks never enter the audit record. [VERIFIED: REQUIREMENTS.md:100] | Phase 17 row (`desktop.action` → `tool.call`, caller), payload field renames, `argDigest` read (§ Integration points 6), `stored` read path (service.ts:547-593) |
| DESK-03 | Only surfaces on an operator-maintained allowlist may call `desktop_run`; an unlisted surface with a valid token, an anonymous caller and a VM guest are each refused, with a test for each; fail-closed in the audit policy. [VERIFIED: REQUIREMENTS.md:101] | config parsing pattern, token gate (server.ts:254-257), test harnesses (`mcp.test.ts` `connect`, `http.test.ts` `start`), audit default-deny (policy.ts:77-80) |
| DESK-04 | Lifecycle script: ≥ 10 GiB free, `--pull never`, loopback 6081 behind basic auth, unprivileged, no Docker socket, never touches `recruitment-desktop`. [VERIFIED: REQUIREMENTS.md:102] | September script read in full; PATH-stub test design; shellcheck run; live `status` output |
| DESK-05 | Proof (isolated): a headless session's `desktop_run` returns a screenshot whose pixels show the typed marker, one event per action lands, and `recruitment-desktop` is untouched. [VERIFIED: REQUIREMENTS.md:103] | N1 evidence and live probes (§ N1), marker sizing (§ Pixel marker), SDK client probe (70 s call), harness extension points |
</phase_requirements>

## Project Constraints (from AGENTS.md)

No `CLAUDE.md` exists in the worktree; `AGENTS.md` holds the project rules [VERIFIED: AGENTS.md:1-13]:
- Read `.substrate/BRIEF.md` at the start of work (not present in this worktree checkout; nothing to read).
- Draft PR only; no merge, no auto-merge, no force-push, no branch deletion.
- **No secrets**: never print, commit or echo tokens, keys, passphrases; reference env vars by name only; **do not write tailnet names or internal hostnames into the repo, the PR or the transcript.** The proof must never print a harness token, the basic-auth password, or a host IP.
- Every PR goes through the Greptile gate run by Desk Quality; a failed/skipped review is a blocker.

Repo conventions that bind this phase (read this session):
- `tsconfig.json` includes only `packages/**/*.ts` and `scripts/**/*.ts` [VERIFIED: tsconfig.json `"include": ["packages/**/*.ts", "scripts/**/*.ts"]`]. A test placed under `infra/` would not be type-checked; put the lifecycle-script test under `scripts/`.
- Store lock (`packages/mcp-server/src/store-lock.test.ts`): no file outside the MCP package names `GREPTIME_`; no `SUBSTRATE_TOKEN… = <16+ chars>` literal (`TOKEN_LITERAL`, line 95); `*.ts` directly in `packages/mcp-server/src` that mention `greptime` and call `.sql(` are restricted (line 144-152). The desktop smoke reads events only through `POST /events/query` on the twin.
- Redaction lock (Phase 18 D18-13, applies to `.ts` and `.sh` under `packages/`, `scripts/`, `infra/`): import `redact` only from `packages/mcp-server/src/redact.ts`; define nothing named `redact*`; no `[REDACTED` literal; no credential-prefix regex [VERIFIED: agent-substrate-v13-p18 18-CONTEXT.md:85-89].

## Summary

The port is small and mechanical, but five details decide whether the locked decisions actually hold. (1) `registerTool` must be given the `DesktopRunInput` **ZodObject**, not `DesktopRunInput.shape` as September did: probed against the installed SDK 1.30.1, a raw shape is rebuilt as a plain `z4mini.object` that silently strips an extra `surface` key and runs the handler, while the strict object returns `isError` "Unrecognized key: \"surface\"" with zero handler calls. (2) The driver's child env, event kind/payload, fail-open emit and queue mutex all change (D30-07/08/11/12); everything else (`actions.ts`, XWD/PNG codecs, budgets, retention) ports unchanged. (3) The lifecycle script hardcodes `/etc/substrate/substrate-desktop.env`; hermetic tests need an env-file path seam, otherwise a test on a host without that file writes into `/etc` as root. (4) `configWarnings` returns early when no operator tokens exist (config.ts:280), and the harness tests demand zero warnings for every harness build (rehearsal-env.test.ts:84,120), so desktop warnings belong in a sibling function and must stay silent for an empty or valid allowlist. (5) The smoke must pass a request timeout: the SDK client's default is 60 s (`DEFAULT_REQUEST_TIMEOUT_MSEC = 60000`), shorter than a realistic marker run.

N1 (stale pixels) could not be reproduced read-only: the container was restarted on 2026-09-29T16:42Z, the desktop now holds no terminal windows (September's 7 are gone), and a live `xwd -root` decodes to a fresh frame (panel clock 23:32 at capture 23:32:22). Conditions differ sharply from September: `docker exec` round trips take 0.09–0.27 s and `xwd` 0.16 s (September 4–7 s and 8–11 s), CPU steal 1–2 % and load ~2.5 on 8 vCPUs (September 71–76 % steal, load 15–23). Re-reading September's N1 PNG shows the stale region covers the new window's **frame and client** while the panel clock and the pager (which draws the active window's outline in that region) were fresh, so "terminal repaint starvation" alone does not explain it. The spike should run the as-ported capture path first (it may simply pass today), then a discriminating ladder (delayed second capture, server stacking vs WM stacking, map state/workspace, `xrefresh` before `xwd`).

**Primary recommendation:** port `actions.ts` verbatim; split `png.ts` (decodeXwd, encodePng, crc32, plus a filter-0 `decodePng` shared by tests, spike and smoke); rewrite only the driver's runner env, busy flag and emit path; gate in `Substrate.runDesktop` with a `null` default driver that only `index.ts` wires to the real runner; register the tool with the strict object.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Caller identity (token → surface, 401) | API / Backend (`server.ts` token gate) | — | Established before any body is read (server.ts:220-257) |
| Allowlist + anonymous refusal | API / Backend (`Substrate.runDesktop`) | MCP handler (renders isError) | Policy next to config, reusable by any future door |
| Argument validation (closed vocabulary) | MCP layer (SDK validates strict object) | Driver re-parses (defence in depth) | SDK rejects before the handler (probe); driver re-parse kept from September |
| Audit record (fail-closed) | Observability (`auditToolCalls` before dispatch) | `packages/audit` policy | Structural gate in front of the dispatcher (server.ts:522) |
| Executing actions | Host process (`execFile docker exec`) | Container (xdotool/xwd as root inside, X server `-ac`) | Fixed argv; no shell |
| Events per action | API / Backend (`Substrate.emit` → Greptime) | — | `stored` read back (service.ts:574-591) |
| Screenshot storage + retention | Database / Storage (local FS `desktopDir`) | — | 0700/0600 under the service's state dir |
| Container lifecycle | Operator tier (root script) | — | Service never creates/starts containers (`/etc` read-only under `ProtectSystem=full`) |
| Proof | Test harness (Phase 16 twin) | Real container (read/act only) | Isolated per D30-16/19 |

## Standard Stack

No new dependency. Everything below is already installed [VERIFIED: packages/mcp-server/package.json; `node_modules/.bun/@modelcontextprotocol+sdk@1.30.1`, `zod@4.6.5`].

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@modelcontextprotocol/sdk` | 1.30.1 (installed) | `McpServer.registerTool`, image content blocks, `Client` + `StreamableHTTPClientTransport` for the smoke | Already the server's MCP stack |
| `zod` | 4.6.5 | `DesktopRunInput` strict object | Already used by every tool schema |
| `node:child_process` `execFile` | Bun 1.4.0 | Buffer-mode runner | September's runner, argv only |
| `node:zlib` `deflateSync`/`inflateSync` | Bun 1.4.0 | PNG encode (driver) and decode (tests, spike, smoke) | No new dependency (D30-17) |

### Supporting (host tools, not packages)
| Tool | Version | Purpose |
|------|---------|---------|
| `shellcheck` | 0.10.0 at `/usr/local/bin/shellcheck` | Lint the lifecycle script in its test |
| `setpriv` | `/usr/bin/setpriv` | Run the script as uid 65534 for the non-root refusal test |
| `python3` + PIL | host | Spike-only decoding cross-check (not in tests) |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Filter-0 PNG decode by hand | `pngjs` / `sharp` | New dependency for 30 lines; CONTEXT D30-17 says no new dependency |
| `xwd -root` | ImageMagick `import` in container | Not installed in the container [CONTEXT live facts]; would need a new image |
| Pixel band | OCR (`tesseract`) | Not installed; deferred (OCR out of scope) |

**Installation:** none.

## Package Legitimacy Audit

No external package is installed by this phase. **Packages removed due to [SLOP]:** none. **Packages flagged [SUS]:** none.

## Integration Points (main, with evidence)

Line numbers are the p30 worktree (`gsd/v1.3-p30-desktop-run`, HEAD `2416ed1`).

### 1. `packages/mcp-server/src/mcp.ts`
- Helpers: `text(value)` → `{ content: [{ type: "text" as const, text: value }] }` (62-64); `json(value)` (66-68); `refusal(message)` → `{ ...json({ error: message }), isError: true }` (153-155). [VERIFIED: mcp.ts:62-68,153-155]
- `McpCaller { surface: Surface | null; isOperator: boolean; }` (166-169); `createMcpServer(substrate, caller: McpCaller | Surface | null)` destructures `callerSurface`/`isOperator`; a bare surface string means "authenticated, not operator" (171-175). [VERIFIED: mcp.ts:166-176]
- Every existing tool uses a raw shape `inputSchema: { … }` (e.g. 184-189). `memory_write` documents its `surface` argument as "ignored" (240-246) — that is the *attribution* precedent; for `desktop_run` CONTEXT wants rejection, which needs the strict object (§ Pattern 2).
- Image block: SDK `ImageContentSchema = z.object({ type: z.literal('image'), data: Base64Schema, mimeType: z.string(), annotations?, _meta? })` [VERIFIED: sdk dist/esm/types.js:1034-1053]. Return `{ type: "image" as const, data: <base64>, mimeType: "image/png" }`; the probe returned exactly that block through a real client.
- Tool errors: any throw inside the handler (and any input validation failure) becomes `{ content: [{ type: "text", text: <message> }], isError: true }` via `createToolError` [VERIFIED: sdk server/mcp.js:134-160]. Validation text is `MCP error -32602: Input validation error: Invalid arguments for tool <name>: …` (probe output).

### 2. `packages/mcp-server/src/service.ts`
- Constructor seam: `constructor(readonly config: SubstrateConfig, stores?: { index?: IndexStore | null; greptime?: GreptimeClient | null }, observer: SubstrateObserver = {})` with "`stores` is a test seam; production always builds them from config" (464-475). Phase 21 adds `skills?: SkillProposer` to the same object [CITED: agent-substrate-v13-p21 21-PATTERNS.md:302-337]. Add `desktop?: DesktopDriver | null` the same way.
- `emit(input: EventInput): Promise<EmitResult>` (547-562); `EmitResult { event; stored: boolean; error?; warning? }` (230-238). `stored: false` arises from: no ledger `"GREPTIME_URL is not set"` (574), not append-only (582), insert threw (591). [VERIFIED: service.ts:230-238,547-593]
- Each append first queries `greptime.lastHash(sessionId)` (570-572), so events under `desktop:<run_id>` form one hash chain per run.

### 3. `packages/mcp-server/src/config.ts`
- `loadConfig(env = process.env)` (153-191). Comma-list precedent: `operatorTokens: new Set((env.SUBSTRATE_OPERATOR_TOKENS ?? "").split(",").map((token) => token.trim()).filter((token) => token.length > 0))` (177-182). `allowAnonymous: readTokens(env).size === 0` (176). [VERIFIED: config.ts:173-188]
- `configWarnings(config)` begins `if (config.operatorTokens.size === 0) return warnings;` (280). A desktop warning appended after that line never fires on a deployment without operator tokens (production today). Sibling precedent: `swarmTokenWarnings(config)` (323-333), concatenated at boot in `index.ts:24`. [VERIFIED: config.ts:278-333, index.ts:24-26]
- `surfaceForToken` (221-224) and `isOperator` (241-246).
- No `config.test.ts` exists; config warnings are tested in `authority.test.ts:66-143` with exact `toHaveLength`/`toEqual([])` expectations (70-75, 83-87, 140-143). [VERIFIED: grep]

### 4. `packages/mcp-server/src/observe.ts`
- `KNOWN_TOOLS` (309-337) bounds the `tool` metric label; an unlisted name is counted as `"unrecognized"` (`toolLabel`, 340-342). Add `"desktop_run"` under "MCP tools, as `mcp.ts` registers them". [VERIFIED: observe.ts:309-342]
- `auditToolCalls` (363-417) appends `{ surface: surface ?? "unknown", tool, transport, graph_id, node_id, session_id, decision: "allowed", mode: auditMode(call.tool), args: call.args }` **before** the dispatcher; an `AuditUnavailableError` on a fail-closed tool denies the batch (402-414). [VERIFIED: observe.ts:376-414]

### 5. `packages/audit/src/policy.ts`
- Main today: `FAIL_CLOSED_TOOLS` has 9 names, not `desktop_run` (16-26); `auditMode` is default-deny: `if (FAIL_OPEN_TOOLS.has(tool)) return "fail-open"; return "fail-closed";` (77-80). So `auditMode("desktop_run") === "fail-closed"` already holds on main; Phase 17 plan 17-02 adds the explicit entry `"desktop_run", // Phase 30` [CITED: v13-p17 17-02-PLAN.md:47; 17-RESEARCH.md:477]. [VERIFIED: policy.ts:16-26,77-80]

### 6. `packages/audit/src/record.ts` (D30-13)
- `AuditRecord` fields: `seq, ts, surface, tool, transport, decision, mode, reason, graph_id, node_id, session_id, actor, arg_keys, arg_digest, hash, prev` (139-160) — no args, no result field. `argDigest(args, redact)` returns `{ keys: [sorted top-level names], digest: sha256Hex(canonicalJson(args)) }` (180-193); `buildRecord` stores only `arg_keys: keys, arg_digest: digest` (242-243). [VERIFIED: record.ts:139-193,219-246]
- Tool results never reach the audit: the gate runs before dispatch (server.ts:522) and nothing appends after the handler. A `desktop_run` record therefore carries `arg_keys: ["actions", "timeout"]` (or `["actions"]` when `timeout` is omitted — the digest is over the args *as submitted*, before the default is applied).

### 7. `packages/mcp-server/src/server.ts`
- `const caller: McpCaller = { surface, isOperator: isOperator(config, authorization) };` (224). Token gate: `if (!config.allowAnonymous && surface === null) { sendJson(res, 401, { error: "unknown or missing bearer token" }); return; }` (254-257) — before routing, before the body is read, before the audit. [VERIFIED: server.ts:216-257]
- `handleMcp` (507-538): POST only (405 otherwise); reads body (`MAX_BODY_BYTES = 1_000_000`, line 46); audits; `createMcpServer(substrate, caller)` per request; stateless `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`. A per-request server is why the busy flag must live at module scope.

### 8. `packages/mcp-server/src/index.ts`
- `const substrate = new Substrate(config, undefined, observability.observer);` (18); warnings loop `[...configWarnings(config), ...swarmTokenWarnings(config)]` (24-26). Wire the real driver here: `new Substrate(config, { desktop: createDesktopDriver({ run: bufferRunner, dir: config.desktopDir }) }, observer)` — `stores.index`/`greptime` stay `undefined`, so their config defaults still apply (service.ts:470-473 test `!== undefined`). [VERIFIED: index.ts:16-26; service.ts:470-473]

### 9. Production unit facts (read-only, names only)
- `substrate-mcp.service`: `EnvironmentFile=/etc/substrate/substrate.env`, `WorkingDirectory=/root/src/repos/agent-substrate`, `NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectSystem=full`, `ProtectHome=false`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`, no `User=` (root). [VERIFIED: `systemctl cat substrate-mcp`]
- `/etc/substrate/substrate.env` holds **no** `SUBSTRATE_TOKEN_*` name today (0 matches), so production is `allowAnonymous` and every caller is anonymous: `desktop_run` will refuse every production caller until Phase 20 issues surface tokens, whatever the allowlist says. [VERIFIED: `grep -o '^[A-Z_]*='` count 0]
- `DOCKER_HOST` unset; `/var/run/docker.sock` `srw-rw---- root docker`. The child env allowlist (PATH, HOME) loses nothing today.

## Port delta: `acc30a8` → main (Question 3)

### Port unchanged
| Symbol | Source | Note |
|--------|--------|------|
| `EXEC = ["docker", "exec", "-e", "DISPLAY=:1", "substrate-desktop"] as const` | actions.ts:8 | D30-06 |
| `CHORD`, `KEYS`, `KEYS_RULE`, `TYPEABLE`, `settleMs` (0..5000) | actions.ts:10-17 | grammar: 1..8 space-separated chords of `[A-Za-z0-9_]+` joined by `+` |
| `DesktopAction` (discriminated union of 4 strict objects), `DesktopRunInput` (strict; `actions` 1..50; `timeout` int 1..120 default 30) | actions.ts:19-51 | D30-05 |
| `DEFAULT_SETTLE_MS = { click: 300, type: 200, key: 800 } as const` | actions.ts:57 | D30-10 |
| `parseKeys`, `boundsRefusal`, `clickArgv`, `typeArgv` (`"xdotool", "type", "--delay", "12", "--", text`), `keyArgv` (`"key", "--clearmodifiers", "--", ...chords`), `shotArgv` (`"xwd", "-root", "-silent"`), `titleArgv`, `geometryArgv` | actions.ts:60-111 | argv table pinned by actions.test.ts |
| `ACTION_TIMEOUT_MS = 30_000`, `TYPE_MS_PER_CHAR = 200`, `RETAIN_RUNS = 200`, `RETAIN_MS = 7 * 86_400_000`, `ERROR_CHARS = 300`, `TITLE_CHARS = 256`, `RUN_ID = /^dr-\d{8}T\d{6}Z-[0-9a-f]{6}$/`, `NOT_RUNNING = /is not running\|No such container/i` | driver.ts:37-49 | |
| `BufferRunResult`, `BufferRunner` types | driver.ts:51-52 | |
| `decodeXwd` (v7, ZPixmap, TrueColor/DirectColor, 24 packed or 32 bpp, masks), `crc32`, `pngChunk`, `encodePng` (filter-0 rows, one IDAT) | driver.ts:71-171 | move to `png.ts` (discretion) |
| `failure()` (not-running mapping + `redact`), `prune()`, `call()` race against the driver's own timer, geometry read + `boundsRefusal` before any input, per-action budget `min(budget, remaining)`, post-action title read with full budget | driver.ts:209-327 | |
| `DesktopLogEntry`, `DesktopScreenshot`, `DesktopRunResult` (`images` base64 for the blocks) | driver.ts:183-200 | |
| Driver re-parses `DesktopRunInput` itself | driver.ts:353 | keep |

### Change
| What | September | Phase 30 | Decision |
|------|-----------|----------|----------|
| Child env | `env: { ...process.env, HOME: "/root" }` (driver.ts:60) | `{ PATH: parent.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: parent.HOME ?? "/root" }`; export a pure `childEnv(parent)` for the test | D30-07, D21-15 precedent (`HOME` falls back to `/root` under systemd) |
| Shots dir | `SHOTS_DIR` constant, `deps.shotsDir` | `deps.dir` from `config.desktopDir` (`SUBSTRATE_DESKTOP_DIR`, default `/var/lib/substrate/desktop`) | D30-09 |
| Exclusivity | module `queue` promise chain (driver.ts:207, 354) | module `let active: string \| null`; check-and-set synchronously at the top of `run()` (after parse, before the first `await`); clear in `finally` | D30-08 |
| Event kind | `kind: "desktop.action"` (176, 331) | `kind: "tool.call"`, `actor: "agent"`, `session_id: \`desktop:${runId}\`` | D30-11 |
| Payload | `{ run_id, ...entry, ...details }` → includes `type`, `active_window`, `text_chars`, `screenshot_path`, `screenshot_sha256`, `keys` raw | `{ tool: "desktop_run", action, run_id, i, ok, ms }` + type `text_len`,`text_sha256` / screenshot `sha256`,`width`,`height` / click `x`,`y`,`button`,`double` / key `keys` or `keys_len`+`keys_sha256` / failure `error`; **no** `active_window`, **no** path | D30-11 |
| Summary | `desktop <type> ok\|failed` | `desktop <action> ok\|failed` | D30-11 (Phase 17's sample says `desktop_run screenshot ok (120ms)`; update the sample) |
| Emit failure | try/catch, fail-open (338) | read `stored`; `stored === false` or a throw → stop; tool returns isError `{ run_id, log, error: "event not stored after action <i>; run stopped" }`, no images | D30-12 |
| Deadline-stopped action | log entry `error: "deadline"` **and an emitted event** (278, 329-339) | keep the log entry; **emit nothing** (the action was not executed; same reasoning as D30-04) — see CONTEXT correction C7 | D30-11 "per executed action" |
| `run()` ctx | `{ surface }`, `emit` fixed at construction | `run(input, { surface, emit })`: emit passed per call by `Substrate.runDesktop`, so `index.ts` can build the driver before the `Substrate` exists | discretion |
| MCP registration | `inputSchema: DesktopRunInput.shape` (Sept mcp.ts:184); anonymous fallback `callerSurface ?? "claude-code"` (192) | `inputSchema: DesktopRunInput`; never a surface fallback | D30-02 |
| Gate | `opts.proposeAllowed` (Sept mcp.ts:188-189) | `config.desktopSurfaces.has(callerSurface)`; `callerSurface === null` refused first | D30-01/02 |

### Tests to port and change
- `actions.test.ts`: port verbatim (schema, key grammar, argv table, `--` handling, "no builder emits a shell", settle defaults, bounds).
- `driver.test.ts`: port the XWD/PNG tests, timeout/deadline/budget/not-running/title-failure tests and retention; **change** the 4-event test (new kind/payload/session), the "throwing emit changes nothing" test (now: `stored:false` and a throw both stop the run with D30-12's error), the "two concurrent runs never interleave" test (now: second refused, runner called only for the first), and the deadline test (no event for the not-started action).

## Architecture Patterns

### System Architecture Diagram

```
 agent (MCP client) ──POST /mcp, Bearer──▶ server.ts token gate ──no/bogus token + tokens configured──▶ 401 (VM guest)
                                                   │
                                                   ▼
                                   auditToolCalls (fail-closed record: arg_keys + digest)
                                       │ chain refused → JSON-RPC -32000, nothing runs
                                       ▼
                         createMcpServer(substrate, caller) per request
                                       │ SDK validates DesktopRunInput (strict) → isError on extra key
                                       ▼
                         desktop_run handler → Substrate.runDesktop(input, callerSurface)
                                       │ null caller → refuse │ not in config.desktopSurfaces → refuse
                                       │ driver null (not wired) → refuse │ busy → refuse
                                       ▼
                         driver: geometry read → bounds check → for each action:
                             fixed argv ──execFile(env PATH,HOME)──▶ docker exec substrate-desktop xdotool|xwd
                             screenshot: XWD → decodeXwd → encodePng → <desktopDir>/<run_id>/<n>.png (0600)
                             emit tool.call (session desktop:<run_id>) ──▶ Greptime
                                   stored:false → stop, isError, no images
                         prune(desktopDir) ──▶ result
                                       ▼
                         [text {run_id, screenshots, log}] + [image/png …]
```

### Recommended Project Structure
```
packages/mcp-server/src/desktop/
├── actions.ts         # verbatim port: vocabulary + argv builders
├── actions.test.ts    # verbatim port
├── png.ts             # decodeXwd, encodePng, crc32, decodePng (filter-0 only), findBand helper (optional)
├── png.test.ts        # XWD/PNG round trip, decodePng(encodePng(x)) === x, refuses non-0 filter
├── driver.ts          # childEnv, bufferRunner, busy flag, createDesktopDriver, prune, keyFields rule
├── driver.test.ts     # ported + changed tests
└── tool.test.ts       # MCP-level refusals, events, D30-12/13 (or extend mcp.test.ts / http.test.ts)
infra/desktop/substrate-desktop.sh   # port, env-file seam, SC2016 directive, comments re-pointed
scripts/substrate-desktop.test.ts    # PATH-stub script tests (tsc covers scripts/**)
scripts/desktop-smoke.ts             # proof session (SDK client), bun run smoke:desktop
docs/runbooks/desktop.md             # new
```

### Pattern 1: Driver seam that tests cannot reach by accident
**What:** `Substrate` gets `stores.desktop?: DesktopDriver | null`; the default is `null` (refusal "desktop_run is not available in this process; nothing was run"). Only `index.ts` constructs `createDesktopDriver({ run: bufferRunner, dir: config.desktopDir })`.
**Why:** every test that builds a `Substrate` (dozens, all with `loadConfig({})` or partial envs) is structurally unable to run `docker`; the harness spawns `packages/mcp-server/src/index.ts` (Phase 16 `buildServerSpawnArgv`) and therefore gets the real runner. Phase 21 defaulted to the real executor ("inert until called") [CITED: 21-PATTERNS.md:305,337]; here the real executor acts on a shared desktop, so the safer default is `null`.
**Lock test (cheap):** grep that `bufferRunner` is referenced only by `desktop/driver.ts` and `index.ts`.

### Pattern 2: Strict input schema (probe-verified)
```ts
// mcp.ts — pass the ZodObject, not .shape
server.registerTool("desktop_run", {
  title: "Drive the sandbox desktop",
  description: "...",            // say: needs an operator-listed surface; events are tool.call
  inputSchema: DesktopRunInput,  // z.strictObject → additionalProperties:false, extra keys rejected
  annotations: { destructiveHint: false, openWorldHint: true },
}, async (input) => { /* Substrate.runDesktop(input, callerSurface) */ });
```
Probe (this session, SDK 1.30.1, InMemoryTransport): strict object + `{actions:[…], surface:"omp"}` → `{"content":[{"type":"text","text":"MCP error -32602: Input validation error: Invalid arguments for tool strict_tool: Unrecognized key: \"surface\""}],"isError":true}`, handler calls 0; `.shape` + same args → handler ran with `{"actions":[…],"timeout":30}` (surface stripped). Mechanism: `normalizeObjectSchema` returns a v4 object schema as is, but rebuilds a raw shape with `z4mini.object(shape)` [VERIFIED: sdk server/zod-compat.js:14-25,79-112].

### Pattern 3: Refusal order in `runDesktop`
1. `callerSurface === null` → anonymous refusal (D30-02).
2. `!config.desktopSurfaces.has(callerSurface)` → "desktop_run is not enabled for surface <s>; nothing was run".
3. driver `null` → not-wired refusal.
4. (recommended) `substrate.greptime === null` → "desktop_run needs the event ledger; nothing was run" — otherwise the first action executes before D30-12 stops the run (see C8).
5. busy → "desktop_run is busy with run <run_id>; nothing was run".
6. run.
All are `refusal(...)` isError, no event, no docker call; the audit record already exists.

### Pattern 4: Busy flag
```ts
let active: string | null = null; // module scope: createMcpServer is rebuilt per request
async run(input, ctx) {
  const parsed = DesktopRunInput.parse(input);           // validation refusal never takes the lock
  if (active !== null) throw new DesktopBusy(active);    // synchronous check-and-set, no await before
  const runId = newRunId(now());
  active = runId;
  try { return await execute(parsed, runId, ctx); } finally { active = null; }
}
```
Test: start run A with a runner that blocks on a deferred; call run B → refused naming A's run id; resolve A; assert the runner saw only A's argv.

### Pattern 5: Key-field rule (D30-11), implementable as a pure function
```ts
// verbatim when every chord is "named" (≥ 2 chars) or carries a modifier; else len + sha256
function keyFields(keys: string): Record<string, unknown> {
  const chords = keys.split(" ");
  const safe = chords.every((c) => c.includes("+") || c.length >= 2);
  return safe ? { keys } : { keys_len: keys.length, keys_sha256: sha256(keys) };
}
```
See C6 for the leak this literal rule leaves (shift chords, keypad and punctuation keysyms); the recommendation there is a tighter predicate.

### Pattern 6: Test harnesses to reuse
- **Tool level (InMemory):** `mcp.test.ts:41-48` `connect(greptime, surface)` builds `new Substrate(loadConfig({}), { index: null, greptime })`, `createMcpServer(substrate, surface)`, `InMemoryTransport.createLinkedPair()`. For desktop tests pass `loadConfig({ SUBSTRATE_DESKTOP_SURFACES: "omp", SUBSTRATE_DESKTOP_DIR: tmp })` and `{ desktop: createDesktopDriver({ run: fakeRunner, dir: tmp }) }`; reuse the `ledger()` stub (mcp.test.ts:19-38) — set `insertEvent` to throw for D30-12. [VERIFIED: mcp.test.ts:19-48]
- **HTTP level (real gate):** `http.test.ts:31-58` `start(env, stores)` builds config/observability/Substrate/`createHttpServer`, listens on port 0; `toolCall(name, args)` posts bare JSON-RPC `tools/call` without `initialize` and the stateless server answers (193-241); `harness.observability.audit.recent()` returns the records (208). [VERIFIED: http.test.ts:31-58,193-241]
  - VM guest: `start({ SUBSTRATE_TOKEN_OMP: "tok-omp", SUBSTRATE_DESKTOP_SURFACES: "omp", SUBSTRATE_AUDIT_PATH: auditDirectory() }, { desktop })` → no `authorization` → 401; `authorization: "Bearer bogus"` → 401; recording runner never called; `audit.recent()` has no `desktop_run` record (401 precedes the audit).
  - Self-attribution: token of an unlisted surface (`SUBSTRATE_TOKEN_CURSOR`) + `arguments: { actions:[…], surface: "omp" }` + header `x-substrate-propose-key: x` → isError (strict schema), runner 0 calls.
  - Fail-closed: `SUBSTRATE_AUDIT_PATH: unwritablePath()` + listed token → JSON-RPC `-32000` naming `desktop_run`, runner 0 calls (http.test.ts:212-227 pattern).
  - D30-13: listed token + `type` text `"TYPED-SECRET-TEXT"` + fake XWD → `JSON.stringify(audit.recent())` contains neither the text nor `iVBOR`; `record.mode === "fail-closed"`; `arg_keys` ⊆ `["actions","timeout"]`.

### Anti-Patterns to Avoid
- **`inputSchema: DesktopRunInput.shape`** — strips unknown keys silently (probe).
- **Spreading `process.env` into the child** — carries every `SUBSTRATE_TOKEN_*`, `GREPTIME_PASSWORD`, `SUBSTRATE_HANDOFF_KEY`.
- **A queue** — holds an HTTP request open for n × up to ~150 s.
- **Putting `active_window` or a path in the event** — a terminal title can echo typed text.
- **Falling back to a default surface for anonymous callers** (Sept mcp.ts:192).
- **Proving on titles** (N1).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Input validation | Manual checks in the handler | SDK validation of the strict ZodObject | Rejects before the handler; JSON Schema `additionalProperties:false` published to clients |
| Redaction of error text | Local regexes | `redact` from `../redact.ts` | Phase 18 lock forbids a second redactor |
| Audit | Any record inside the tool | `auditToolCalls` in `handleMcp` | Structural fail-closed gate already in front of the dispatcher |
| Event chaining | Own hash/prev | `Substrate.emit` with `session_id` | `lastHash` chain per session |
| Harness env / guards | New URL guard | Phase 16 exports `refuseSmokeUrl`, `parseShellExports`, `runDirFor`, `PRODUCTION_PORTS` from `scripts/rehearsal.ts` | One convention; refuses 7410/7411/6420 and non-loopback |
| MCP HTTP client | Raw fetch + SSE parsing | SDK `Client` + `StreamableHTTPClientTransport` (`requestInit.headers.authorization`) | Probe: works against a stateless per-request server, 70 s call, image block intact |

## Runtime State Inventory

Not a rename phase, but the port touches live host state:

| Category | Items Found | Action Required |
|----------|-------------|-----------------|
| Stored data | `/var/lib/substrate/desktop/` (0700 root) holds 4 September run dirs `dr-20260926T193225Z-903657`, `dr-20260927T055018Z-f58602`, `dr-20260927T055519Z-002e8a`, `dr-20260927T055741Z-a93dcf` (N1 evidence PNGs). All are > 7 days old, so the **first production `desktop_run` will prune them** (`RUN_ID` matches) | Runbook note; copy them aside first if the September evidence is to be kept (operator call). Harness runs use `<runDir>/desktop`, never this dir |
| Live service config | Production `substrate-mcp` runs pre-port code; `/etc/substrate/substrate.env` has no `SUBSTRATE_DESKTOP_*` and no `SUBSTRATE_TOKEN_*` | Out of scope (operator, after merge; Phase 20 for tokens) |
| OS-registered state | Container `substrate-desktop` (restart `unless-stopped`, label `org.swcstudio.substrate.role=desktop`, StartedAt `2026-09-29T16:42:04Z`); `recruitment-desktop` exited, StartedAt `2026-09-26T15:03:13.690881811Z`, FinishedAt `2026-09-26T16:34:53.891825707Z`, no role label | None; the proof only inspects |
| Secrets/env vars | `/etc/substrate/substrate-desktop.env` 0600 root, 64 bytes (names `CUSTOM_USER`, `PASSWORD` per CONTEXT); new env names `SUBSTRATE_DESKTOP_SURFACES`, `SUBSTRATE_DESKTOP_DIR` | Add both names to `.env.example` (empty values) |
| Build artifacts | None | — |

## Common Pitfalls

### Pitfall 1: SDK client times out at 60 s
**What goes wrong:** `client.callTool(...)` rejects after 60 s while the server is still running the actions; the run then completes with nobody reading it.
**Evidence:** `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000` [VERIFIED: sdk shared/protocol.js:8,712]. Probe: a 70 s tool call with `{ timeout: 180_000 }` succeeded over Bun `node:http` with a 600 KB image block intact.
**How to avoid:** `client.callTool(params, undefined, { timeout: (input.timeout + 60) * 1000 })` in the smoke.

### Pitfall 2: The lifecycle script writes `/etc` during tests
**What goes wrong:** `ENV_FILE=/etc/substrate/substrate-desktop.env` is a constant [VERIFIED: substrate-desktop.sh:23]; on this host the file exists, so `ensure_env_file` returns before `openssl` (the stub is never exercised); on a host without it, a test run as root creates it.
**How to avoid:** `ENV_FILE=${SUBSTRATE_DESKTOP_ENV_FILE:-/etc/substrate/substrate-desktop.env}` (commented as the test seam; operator never sets it) and every test points it into a temp dir. Then the "generated once, 0600, never echoed" assertions become testable: stub `openssl rand -base64 48` output, assert the file mode `600`, two keys, and that stdout/stderr never contain the password.

### Pitfall 3: Non-root test cannot read the script
**What goes wrong:** running `setpriv --reuid=65534 … bash /root/…/substrate-desktop.sh up` depends on directory traversal rights.
**Evidence:** `/root` is `701` here, so it works on this host, but `bash -s up < script` (the parent opens the file) is robust everywhere; probe: `setpriv --reuid=65534 --regid=65534 --clear-groups bash -s < rootcheck.sh` → `euid=65534`, exit 1.
**How to avoid:** feed the script on stdin for the non-root case.

### Pitfall 4: shellcheck exits 1 on an info finding
**Evidence:** `shellcheck -x substrate-desktop.sh` → `SC2016 (info)` at line 120 (Go template in single quotes), exit 1 [VERIFIED: run this session on the acc30a8 script].
**How to avoid:** `# shellcheck disable=SC2016  # Go template, expanded by docker, not the shell` above that line (and the mounts lines use double braces inside single quotes too — re-run after editing).

### Pitfall 5: Busy flag leaks between tests
**What goes wrong:** module-scope state is shared by every driver in the test process; a test that leaves a run pending makes later tests see "busy".
**How to avoid:** every test awaits its runs; the busy test resolves its deferred in `finally`; the flag is cleared in the driver's `finally`.

### Pitfall 6: A timed-out action keeps running inside the container
**Evidence:** "A timed-out call kills only the local `docker exec` client; the process inside the container can finish on its own (text from failed runs 1-2 … is visible in a terminal)" [VERIFIED: acc30a8 05-03-SMOKE.md:203-205].
**Consequence:** after a timeout the busy flag clears, but an `xdotool type` may still be typing into the next run's window. Document in the runbook; do not add a kill path (would be a new program in the argv table).

### Pitfall 7: Typing before the new terminal has focus
**Evidence:** September run 1 typed into the previously focused terminal because the new one had not taken focus when typing began; run 2 raised `settle_ms` to 5000 [VERIFIED: acc30a8 05-PROOF.md:119-127]. Today there is no other terminal, so stray keystrokes would land on xfdesktop (Return on a selected icon opens it).
**How to avoid:** in the smoke, `key ctrl+alt+t` with `settle_ms: 5000`; preferably split into two runs and only type when run 1's `log[i].active_window` starts with `Terminal` (a precondition guard, not the proof).

### Pitfall 8: Payload keys that the redactor or Phase 17 tests reject
- `redactValue` blanks keys matching `/(?:password|passwd|secret|token|api[_-]?key|apikey|authorization|credential|private[_-]?key)/i` [VERIFIED: redact.ts:66]: `keys`, `keys_len`, `keys_sha256`, `text_len`, `text_sha256`, `sha256` are safe; never name a field `*token*`.
- Phase 17's no-content test bans payload keys `text`, `content`, `body`, `bytes`, `image`, `png` in samples [VERIFIED: v13-p17 event-sources.test.ts:75].
- Event payload cap 16,000 bytes, strings 4,000 (event.ts:54-55) — irrelevant for these payloads but an `error` must stay ≤ 300.

### Pitfall 9: Harness tests require zero config warnings
`rehearsal-env.test.ts:84` and `:120` assert `configWarnings(loadConfig(buildRehearsalEnv(…)))` equals `[]`, and `:197-219` pins the exact env key set [VERIFIED: v13-phase rehearsal-env.test.ts]. Adding `SUBSTRATE_DESKTOP_DIR` (always) and `SUBSTRATE_DESKTOP_SURFACES` (when given) must update the key-set test; no desktop warning may fire for a valid allowlist or an empty one.

### Pitfall 10: `SUBSTRATE_DESKTOP_DIR` relative path
Production `WorkingDirectory` is the git checkout; a relative value would write screenshots into the repo. Accept only absolute paths (else default + boot warning).

### Pitfall 11: `bun test` with several paths hides a missing file
Bun treats arguments as filters; if one matches it exits 0 even when another file is missing [CITED: v13-p17 17-RESEARCH.md:525-528, probed with Bun 1.4.0]. Run each new test file by its own command in verification.

## N1: stale pixels (Question 6)

### September evidence (re-read)
- 05-PROOF Gap 2 / 05-VERIFICATION N1: after run 2 the X server listed window `46138072 "Terminal - substrate-smoke-6155f173"` active and topmost in `_NET_CLIENT_LIST_STACKING` at `462,75 818x485`; the PNG showed that rectangle with an older window's contents and frame title; a screenshot-only call a minute later showed the same pixels; the panel clock repainted; cause inferred as repaint starvation under 67–76 % steal, not investigated [VERIFIED: acc30a8 05-PROOF.md:196-206; 05-VERIFICATION.md:236-244].
- Looking at the PNG itself (`/var/lib/substrate/desktop/dr-20260927T055519Z-002e8a/1.png`, sha256 `fd8f5d33…` matching the record): the region at x 462–1280 shows a terminal **frame** titled `Terminal - @1917e37f4d54:~` and contents ending `…substrate-smoke-6142ed08\007'` with a `$ ` prompt; the panel's pager draws a filled (active) window outline in that same top-right region; the taskbar shows "Xfce Terminal" grouped ×7; the clock reads 05:56. So the panel (pager, tasklist, clock) was fresh while **both the new window's frame (painted by xfwm4) and its client (VTE)** were absent from the root image. [VERIFIED: image read this session]
- Consequence: "terminal repaint starvation" alone does not explain a missing xfwm4 frame that stayed missing for a minute. Candidates [ASSUMED, for the spike to discriminate]: (a) the window was not viewable (map state, workspace, iconic) although the WM reported it active/top; (b) server stacking differed from the WM's list; (c) neither xfwm4 nor the client painted because they were blocked (starvation/X grab); (d) the root capture itself was stale for that region.

### Live state now (read-only probes, 2026-10-08 ~23:31-23:40Z)
| Fact | Value | Evidence |
|------|-------|----------|
| Container | `substrate-desktop` running since `2026-09-29T16:42:04Z` (restarted after September's smokes), `linuxserver/webtop:ubuntu-xfce`, Ubuntu 26.04.1 | `docker container inspect`; `/etc/os-release` |
| X server | `Xvfb :1 -screen 0 1280x800x24 -dpi 96 +extension COMPOSITE +extension DAMAGE … -nolisten tcp -ac -noreset -shmem` as user `abc` (uid 911) | `/proc/253/cmdline` |
| WM | `xfwm4 4.20.0`; abc's `xfwm4.xml`: `use_compositing=false`, `placement_mode=center`, `placement_ratio=20`, `focus_new=true`, `prevent_focus_stealing=false`, `raise_on_focus=false`, `focus_delay=250` | file read (not `xfconf-query`) |
| `_NET_SUPPORTED` | includes `_NET_WM_SYNC_REQUEST(_COUNTER)`, **no** `_NET_WM_FRAME_DRAWN` (GTK's frame clock is not throttled by the WM) | `xprop -root _NET_SUPPORTED` |
| Windows | `_NET_CLIENT_LIST_STACKING` = 2 (desktop, panel); `_NET_ACTIVE_WINDOW` = 0; **no terminal windows** (N2's 7 are gone); 4 workspaces, current 0 | `xprop -root`, `xdotool search --onlyvisible` |
| Title read with no active window | `XGetWindowProperty[_NET_ACTIVE_WINDOW] failed`, exit 1 → driver logs `active_window: null` | probe |
| `xwd -root -silent` | 0.16 s; 4,099,179 bytes; header v7, ZPixmap, depth 24, **bpp 24, bytes_per_line 5120**, visual class 5, masks ff0000/ff00/ff, byte_order 0, ncolors 256; colormap **identity** (0 of 256 entries non-identity) | probe + python decode |
| Decode | packed 3-byte pixels at a 5,120-byte stride (`x*3` within `y*5120`) is the correct reading; the image is a clean desktop with panel clock `2026-10-08 23:32` at capture `23:32:22` → fresh | decoded PNG viewed |
| `docker exec` round trip | 0.09–0.27 s | `time` |
| Host load | load avg 2.19–2.70 on 8 vCPUs; vmstat `st` 1–2 %, `id` 75–89 % | `uptime`, `vmstat 1 3` |
| September load | `st` 71–76 %, load 15–23; `docker exec` 4–7 s, `xwd` 8–11 s | 05-03-SMOKE.md:171-176 |
| Packages | `xfce4-terminal 1.1.5-1`, `libvte-2.91-0 0.84.0-2`, `libgtk-3-0t64 3.24.52`, `xvfb 21.1.22`, `xdotool 3.20160805.1`, `x11-apps 7.7+11` (`xrefresh`, `xwd`, `xwininfo`, `xprop`, `xdpyinfo` present) | `dpkg-query` |
| Terminal launch | `<Primary><Alt>t` → `exo-open --launch TerminalEmulator` → `debian-x-terminal-emulator` (xfce4-terminal); abc has no `terminalrc` (defaults) | shortcuts xml:52, helpers.rc |

N1 does not show in the current idle desktop; whether it reproduces with a new terminal is exactly what D30-18's spike must establish (it needs key presses, which this research did not perform).

### Spike plan (D30-18), in order
1. **As-ported path first:** one run `screenshot` → `key ctrl+alt+t` (settle 5000) → `type <marker>` (settle 1500) → `screenshot` → `type "exit\n"`. Decode the returned image block; count exact-RGB pixels; record pass/fail and timings. Under today's ~1 % steal this may pass first time — record that, and repeat 3× to see it is stable.
2. **If absent — timing:** a second `screenshot` in the same run after `settle` (two consecutive screenshot actions with a `key`-free gap is impossible; use a following run with only `screenshot` after 2 s and 10 s). If the band appears later, the fix is a settle/second-capture inside the screenshot action (fixed argv, no new action kind).
3. **If still absent — discriminate (host-side diagnostics, spike only, not tool argv):** `xwininfo -id <new> -stats` (Map State IsViewable?), `xprop -id <new> _NET_WM_DESKTOP _NET_WM_STATE` vs `_NET_CURRENT_DESKTOP`, `xwininfo -root -children` (server stacking, bottom→top) vs `_NET_CLIENT_LIST_STACKING`, `xwd -id <frame>` vs a crop of `xwd -root`.
4. **Forced repaint:** `xrefresh` (present, x11-apps) then `xwd -root -silent`. If this yields fresh pixels, the screenshot action becomes two fixed calls (`xrefresh`, short settle, `xwd`) — still the same four action kinds; add both argv to the builder table test.
5. **Reproduce September's layout** (optional, if 1 passes): open a second terminal so the new one is centered over an existing one (`placement_mode=center`), then run the marker — September's failure had an old terminal under the new one.
6. Record `30-N1-SPIKE.md` with `n1_reproduced=`, `capture_path=`, `settle_ms=`, timings, steal at the time. If nothing yields the band, DESK-05's pixel clause is reported as a gap (D30-18).

## Pixel marker (Question 7)

- **Truecolor rendering:** the marker is interpreted by VTE (0.84), not by an application, so `TERM`/`COLORTERM` in the shell do not matter; VTE parses SGR `48;2;R;G;B` and paints the cell background with that colour [ASSUMED: VTE truecolor support; confirmed by the spike's first run]. Capture is exact: Xvfb depth 24, masks ff/ff/ff, identity colormap (above), no compositing, `decodeXwd` maps `max === 255` channels without scaling (driver.ts:118).
- **Cell size:** abc has no `terminalrc`, so xfce4-terminal defaults apply (80×24, font "Monospace 12"); `fc-match Monospace` → `DejaVuSansMono.ttf` [VERIFIED: probe]. At 96 dpi that is a 16 px font; September's terminal window measured `818x485` client [VERIFIED: 05-PROOF.md:197-198], consistent with ~10 px × ~19 px cells (80 × 10 = 800 + scrollbar/padding; 24 × 19 = 456 + menubar) [ASSUMED: inference from geometry]. The band (`%48s` → 48 cells × 1 row) is then ≈ 480 × 19 ≈ 9,100 px — six times the 1,500 px threshold.
- **Band test:** collect pixels equal to the nonce RGB; pass when count ≥ 1,500 and count equals the area of their bounding box (one solid rectangle) and height ≤ 3 × cell height; the baseline must contain zero such pixels (redraw the nonce otherwise). Make one channel ≥ 0xC0 so the colour cannot occur in the dark wallpaper (41,879 distinct colours in today's desktop; dominant `(0,0,0)`).
- **Typing the marker:** in TypeScript build the text with `String.raw`, e.g. ``String.raw`printf '\033[48;2;${r};${g};${b}m%48s\033[0m\n' ''  # substrate-smoke-${nonce}` + "\n"`` — the `\033`/`\n` inside the printf are typed as backslash sequences (no control characters, so `TYPEABLE` accepts them); the final real `\n` presses Return. Bash interactive comments are on by default, so the trailing `# substrate-smoke-<nonce>` is inert.
- **Minimal decoder (no dependency):**
```ts
// filter-0 only: exactly what encodePng writes; anything else is refused
export function decodePng(png: Buffer): { width: number; height: number; rgb: Buffer } {
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("png: bad signature");
  let width = 0, height = 0; const idat: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const len = png.readUInt32BE(at); const type = png.toString("latin1", at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 2 || data[12] !== 0) throw new Error("png: not 8-bit RGB non-interlaced");
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    at += 12 + len;
  }
  const rows = inflateSync(Buffer.concat(idat)); const stride = width * 3;
  if (rows.length !== height * (stride + 1)) throw new Error("png: size mismatch");
  const rgb = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    if (rows[y * (stride + 1)] !== 0) throw new Error(`png: row ${y} filter ${rows[y * (stride + 1)]}`);
    rows.copy(rgb, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  }
  return { width, height, rgb };
}
```
- **Size:** a 1280×800 desktop PNG from filter-0 + default deflate is ≈ 530 KB (≈ 706 KB base64) [VERIFIED: computed from today's XWD]. 50 screenshots in one run ≈ 35 MB of MCP response; no cap exists in the locked vocabulary (risk R4).

## Phase 16 harness extension (Question 4)

As read in `/root/src/worktrees/agent-substrate-v13-phase` (uncommitted edits in progress; cite by symbol, line numbers shift):
- `packages/mcp-server/src/rehearsal-env.ts`: `BuildRehearsalEnvInput` (55-…) gains `desktopSurfaces: readonly Surface[]`; `buildRehearsalEnv` (134-163) asserts the subset (new `assertDesktopSurfacesAllowed(surfaces, desktopSurfaces)`, naming surfaces only, like `assertOperatorAllowed` 91-…), writes `env.SUBSTRATE_DESKTOP_SURFACES = desktopSurfaces.join(",")` when non-empty and **always** `env.SUBSTRATE_DESKTOP_DIR = join(input.runDir, "desktop")` next to `SUBSTRATE_AUDIT_PATH` (160). The allowlist never comes from the parent env (only `PATH`, `HOME`, `BUN_*` are copied).
- `scripts/rehearsal.ts`: `refuseExtraArgs` `valued` map (≈1373) gains `"--desktop-surfaces"`; `main` reads `flag(argv, "--desktop-surfaces")` and adds it to the null-value check list (≈1409-1418); new `parseDesktopSurfaces(raw, surfaces, anonymous)` (each in `SURFACES`, subset of `--surfaces`, refused with `--anonymous`); `UpOptions` (531-…) gains `desktopSurfaces`; `runUp`'s `buildRehearsalEnv({ … })` call (≈939) passes it; `usage()` text (≈1395-1398) lists the flag; `TwinState` may record it for `status`.
- Tests: `scripts/rehearsal.test.ts` (flag parsing, refusals) and `rehearsal-env.test.ts` (exact key set 197-219 updated; zero warnings stays true; round trip `loadConfig(env).desktopSurfaces`).
- Tokens: `runUp` writes one file per surface `writeMode(join(tokensDir, surface), \`${tok}\n\`)` (0600) under `<runDir>/tokens/` and clears stale ones first; `consumer.env` (`consumerEnvRecord`, exactly 5 keys pinned by `rehearsal-env.test.ts:252`) holds `SUBSTRATE_URL`, `SUBSTRATE_TOKEN`, `SUBSTRATE_REHEARSAL_TOKENS_DIR`, `SUBSTRATE_REHEARSAL_NAME`, `SUBSTRATE_TEST_PG_URL`. The desktop smoke should take `--name`, `--surface` (default `omp`) and `--unlisted` (default `cursor`) and read `tokens/<surface>` from `SUBSTRATE_REHEARSAL_TOKENS_DIR`, rather than add a sixth consumer key.
- Smoke guard to reuse: `export function refuseSmokeUrl(raw)` (refuses `PRODUCTION_PORTS = [7410, 7411, 6420]` and non-loopback hosts), `parseShellExports`, `runDirFor(name)` (`${XDG_RUNTIME_DIR ?? "/tmp"}/substrate-rehearsal/<name>`) — all exported from `scripts/rehearsal.ts`; importing the module is side-effect free (`if (import.meta.main)`).
- Teardown: `rehearsal down` removes containers labelled `substrate.rehearsal=<name>` only and `rmSync(runDir, { recursive: true })` — the harness never names `substrate-desktop`; screenshots under `<runDir>/desktop` vanish at `down`, so the proof must record hashes/sizes before teardown.

## Lifecycle script tests without Docker (Question 5)

Design for `scripts/substrate-desktop.test.ts`:
- Stub dir (`mkdtemp`) with executable `docker`, `df`, `openssl` bash stubs that append their argv (NUL- or JSON-encoded) to `$STUB_LOG` and answer from env knobs: `STUB_DF_AVAIL`, `STUB_IMAGE=present|absent`, `STUB_CONTAINER=absent|labelled-running|labelled-stopped|foreign`, geometry `1280 800` for `exec … xdotool getdisplaygeometry`.
- Run: `Bun.spawnSync(["bash", SCRIPT, "up"], { env: { PATH: \`${stubDir}:${process.env.PATH}\`, STUB_LOG, SUBSTRATE_DESKTOP_ENV_FILE: tmp/…, … } })` — pass an explicit env (never the parent's tokens).
- Assertions (D30-15): `run` argv contains `--pull never`, `-p 127.0.0.1:6081:3000`, `--label org.swcstudio.substrate.role=desktop`, `-v substrate-desktop-config:/config`, `--shm-size 1g`, and none of `--privileged`, `docker.sock`, `--network host`, a `-v /…` bind; `df` below 10,737,418,240 → exit 1 with **no** docker line in the log; foreign same-name container → exit 1, no `run`/`start`; absent image → exit 1, no `pull`/`run`; across all scenarios no recorded argv contains `recruitment`, `rm`, `stop`, `kill`, or `pull` other than the `--pull never` pair; env file created mode 600 with `CUSTOM_USER=`/`PASSWORD=` lines and the password never on stdout/stderr; `status` prints the 11 key names; `bash -n` exit 0; `shellcheck` exit 0 when `Bun.which("shellcheck")`; non-root via `setpriv --reuid=65534 --regid=65534 --clear-groups bash -s up` with the script on stdin → exit 1, empty log.
- Live reference for `status` (read-only, this session): `exists=true running=true restart=unless-stopped ports=127.0.0.1:6081->3000 geometry=1280x800 image=linuxserver/webtop:ubuntu-xfce label_role=desktop privileged=false mounts=volume:substrate-desktop-config->/config docker_socket_mounted=false id=1917e37f…`; `ss` shows `127.0.0.1:6081` only; `GET http://127.0.0.1:6081/` without credentials → `401`.

## Code Examples

### Tool handler shape (main helpers)
```ts
// Source: mcp.ts:62-68,153-155 (helpers); sdk types.js:1034 (image block)
async (input) => {
  const outcome = await substrate.runDesktop(input, callerSurface);
  if ("refused" in outcome) return refusal(outcome.refused);
  if ("failed" in outcome) return { ...json(outcome.failed), isError: true }; // D30-12: {run_id, log, error}
  const { images, ...result } = outcome.result;
  return { content: [
    { type: "text" as const, text: JSON.stringify(result, null, 2) },
    ...images.map((data) => ({ type: "image" as const, data, mimeType: "image/png" })),
  ] };
}
```

### Event input per action
```ts
// Source: types.ts:70-85 (EventInput), Phase 17 row desktop.action
await ctx.emit({
  surface: ctx.surface, kind: "tool.call", actor: "agent",
  session_id: `desktop:${runId}`,
  summary: `desktop ${action.type} ${entry.ok ? "ok" : "failed"}`,
  payload: { tool: "desktop_run", action: action.type, run_id: runId, i, ok: entry.ok, ms: entry.ms, ...fields },
});
```

### Smoke client
```ts
// Source: probe this session (SDK 1.30.1)
const client = new Client({ name: "desktop-smoke", version: "0.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
  requestInit: { headers: { authorization: `Bearer ${bearer}` } },
}));
const reply = await client.callTool({ name: "desktop_run", arguments: run }, undefined, { timeout: 240_000 });
// no token: connect() rejects with "Streamable HTTP error: Error POSTing to endpoint: {\"error\":\"unknown or missing bearer token\"}"
```

## State of the Art

| Old Approach (September `acc30a8`) | Current Approach (Phase 30) | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `desktop.action` event kind | `tool.call` under the caller surface | Phase 17 (operator: no new kinds) | Field renames; `desktop.action` is only a row id |
| `proposeAllowed` / `x-substrate-propose-key` gate | Operator allowlist `SUBSTRATE_DESKTOP_SURFACES` | Phase 21 D21-01 / D30-01 | Header ignored; anonymous always refused |
| Fail-open emit | Stop on `stored: false` | D30-12 | Bare run without ledger cannot act |
| Queue | Refuse while busy | D30-08 | No request held open behind another |
| `process.env` child env | `PATH`, `HOME` | D30-07 | No token reaches `docker` |
| Title-based smoke | Pixel band in the returned image | D30-17 | Requires N1 spike |

**Deprecated/outdated:** September `05-03`'s RESTORE.d rollback route in the script header comment (`/var/lib/substrate/phase5-baseline/RESTORE.d/05-03.md`) → point at `docs/runbooks/desktop.md`.

## CONTEXT corrections (evidence against 30-CONTEXT.md)

- **C1 — N2 windows no longer exist.** The deferred item "Cleaning up the 7 terminal windows September's smokes left" is moot: `substrate-desktop` restarted `2026-09-29T16:42:04Z`; `xdotool search --onlyvisible` lists only Xfwm4, Desktop, panel and plugin windows; `_NET_CLIENT_LIST_STACKING` holds 2 windows. The smoke's own terminal is the only one it will see.
- **C2 — `configWarnings` cannot carry the desktop warning as written.** It returns at config.ts:280 when there are no operator tokens (production today), and `authority.test.ts:70-75,83-87` pin its exact output. Use a sibling `desktopWarnings(config)` concatenated in `index.ts:24` (precedent `swarmTokenWarnings`), and never warn for an empty or fully valid allowlist (harness tests require `[]`, rehearsal-env.test.ts:84,120). This also settles the discretion item: no empty-allowlist warning.
- **C3 — "rejected by the strict input schema" requires `inputSchema: DesktopRunInput`.** September registered `DesktopRunInput.shape` (acc30a8 mcp.ts:184); with SDK 1.30.1 that silently strips `surface` (probe). The header `x-substrate-propose-key` is simply never read on main (no code references it), which is "ignored".
- **C4 — D30-15 needs an env-file seam.** The script's `ENV_FILE` is a constant (substrate-desktop.sh:23); without `SUBSTRATE_DESKTOP_ENV_FILE` (test-only override) the `openssl` stub is never reached on this host and a root test elsewhere writes `/etc`.
- **C5 — shellcheck is present (0.10.0) and fails the ported script** on SC2016 (info) at line 120; a directive is required for "shellcheck runs on the script" to pass.
- **C6 — the D30-11 key rule leaks text.** "Every chord named (≥ 2 chars) or carrying a modifier" passes `shift+a shift+b …` (capitals), `KP_1 KP_2 …` (digits), and punctuation keysyms (`space`, `period`, `at`, `minus`…) verbatim — eight chords per action, 50 actions per run. Recommend: verbatim only when every chord either contains a non-shift modifier (`ctrl`, `alt`, `super`, `meta`, `Control_*`, `Alt_*`, `Super_*`) or is in a fixed allowlist of non-printing keys (`Return`, `KP_Enter`, `Tab`, `Escape`, `BackSpace`, `Delete`, `Insert`, `Home`, `End`, `Page_Up`, `Page_Down`, `Up`, `Down`, `Left`, `Right`, `F1`–`F12`, `Menu`); otherwise `keys_len` + `keys_sha256`. Needs operator acknowledgement because it narrows a locked rule.
- **C7 — "one event per executed action" vs September's deadline entry.** September emitted an event for an action stopped by the deadline before it started (driver.ts:278 then 329-339). The plan should state that such an action is logged but not emitted, and the tests pin it.
- **C8 — D30-12 lets one action run on a bare (ledger-less) run.** The first event fails only after its action executed. A pre-run refusal when `substrate.greptime === null` makes "a bare run cannot run desktop actions" literally true with zero actions executed.
- **C9 — Production refuses every caller today regardless of the allowlist.** `/etc/substrate/substrate.env` defines no `SUBSTRATE_TOKEN_*`, so `allowAnonymous` is true and every caller is anonymous (refused by D30-02). Worth a line in the runbook and in Open-for-operator 1 (the allowlist only matters after Phase 20).
- **C10 — README has no tool list.** README is prose by area (`## Coordination`, `## Observability and audit`, …); "tool list gains `desktop_run`" means a short paragraph (e.g. a new `## Desktop` section linking the runbook).
- **C11 — Phase 17's row sample does not match D30-11.** Sample summary `desktop_run screenshot ok (120ms)` and `session_id: "sess-p17-desktop"` (v13-p17 event-sources.ts:289-290) vs D30-11 summary `desktop <action> ok|failed` and `desktop:<run_id>`; D30-11 already says to update the sample in the same PR — include the summary and session format.
- **C12 — `use_compositing=false` was confirmed from abc's file.** Running `xfconf-query` as root via `docker exec` reads root's channel, not abc's (a root `dbus-launch --autolaunch` started ~23:22Z is visible in `ps`); the value in CONTEXT is nevertheless right per `/config/.config/xfce4/xfconf/xfce-perchannel-xml/xfwm4.xml:5`. Future reads should use the file or `docker exec -u abc`.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | VTE 0.84 paints SGR 48;2 truecolor backgrounds with the exact RGB | Pixel marker | Band never matches exactly → spike must loosen to a ±0 check on a dominant colour or change marker |
| A2 | Default xfce4-terminal cell ≈ 10×19 px (band ≈ 9,100 px) | Pixel marker | Threshold 1,500 still holds down to ~3×10 px cells |
| A3 | N1 candidates (a)–(d) | N1 | Spike may find another cause; plan must leave room for a capture-path change |
| A4 | Docker CLI needs nothing beyond PATH and HOME on this host | Port delta | A future `DOCKER_HOST`/`DOCKER_CONFIG` deployment would need the allowlist widened |
| A5 | `xrefresh` forces Expose/repaint of every window | Spike step 4 | Only a candidate; spike verifies |

## Open Questions (RESOLVED)

1. **C6 key rule** — RESOLVED: CONTEXT D30-11 adopts the tightened predicate (implemented in plan 30-01; listed for the operator as CONTEXT open item 5; recorded in the plan 30-07 runbook).
2. **First-event-before-ledger (C8)** — RESOLVED: CONTEXT D30-04a refuses before any action when no ledger is configured (plan 30-04).
3. **Response size** — RESOLVED as a documented residual: 50 screenshots ≈ 35 MB in one MCP reply; no cap in the locked vocabulary; recorded in the plan 30-07 runbook (T-30-30).
4. **September evidence PNGs** — RESOLVED as an operator item: the first production run after merge prunes runs older than 7 days from `/var/lib/substrate/desktop`, which includes September's evidence; the harness proof uses its own run directory and never prunes them. The runbook (plan 30-07) tells the operator to copy them aside first if wanted.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Docker + `substrate-desktop` running | proof, spike | ✓ | container up since 2026-09-29 | none (proof is a gap) |
| `linuxserver/webtop:ubuntu-xfce` local image | `up` (not run by the proof) | ✓ | — | — |
| Phase 16 harness (`bun run rehearsal`) | proof | ✗ on main (worktree only) | — | execution base must include Phase 16 (CONTEXT) |
| Phase 17 (`event-sources.ts`, `check:phase-close`, policy entry) | events table, proof chain | ✗ on main (executing in p17 worktree) | — | rebase after merge (CONTEXT) |
| Phase 18 (`redact-lock.test.ts`) | lock check | ✗ on main | — | `redact.ts` exists on main; the lock arrives with the rebase |
| `shellcheck` | script test | ✓ | 0.10.0 | skip when absent |
| `setpriv` | non-root test | ✓ | util-linux | `runuser -u nobody` |
| `python3` + PIL | spike cross-check only | ✓ | — | in-repo `decodePng` |
| Bun | all | ✓ | 1.4.0 | — |
| Free disk on `/` | `up` gate | ✓ | 20,659,855,360 B (≥ 10 GiB) | — |

**Missing dependencies with no fallback:** none for planning; the proof wave is blocked until Phases 16/17/18 are on the base.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `bun:test` (Bun 1.4.0), colocated `*.test.ts` |
| Config file | none (root `bun test`; `tsconfig.json` include `packages/**/*.ts`, `scripts/**/*.ts`) |
| Quick run command | `bun test ./packages/mcp-server/src/desktop/` |
| Full suite command | `bun test && bunx tsc --noEmit && bun run check:phase-close` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DESK-01 | Vocabulary, limits, argv table, `--`, no shell | unit | `bun test ./packages/mcp-server/src/desktop/actions.test.ts` | ❌ W0 (port) |
| DESK-01 | XWD 24/32 bpp decode, PNG encode/decode round trip, filter-0 refusal | unit | `bun test ./packages/mcp-server/src/desktop/png.test.ts` | ❌ W0 |
| DESK-01 | Busy refusal (2 concurrent runs, runner called for first only); deadline/timeout/budget; 0600/0700; retention 200/7 d; child env has only PATH/HOME | unit | `bun test ./packages/mcp-server/src/desktop/driver.test.ts` | ❌ W0 (port + change) |
| DESK-01 | Tool returns text block + image blocks; strict schema publishes `additionalProperties:false` | integration (InMemory MCP) | `bun test ./packages/mcp-server/src/desktop/tool.test.ts` | ❌ W0 |
| DESK-02 | One `tool.call` per executed action, payload keys per action = row contract, `text_sha256`, no text/`iVBOR` in any event; key rule; `stored:false` stops (D30-12); no event for pre-run refusals and not-started actions | unit + integration | `bun test ./packages/mcp-server/src/desktop/driver.test.ts` and `…/tool.test.ts` | ❌ W0 |
| DESK-02 | Audit record for `desktop_run` has only `arg_keys`/`arg_digest`, no typed text, no `iVBOR` | integration (HTTP) | `bun test ./packages/mcp-server/src/http.test.ts` (new describe) | ✅ file, ❌ cases |
| DESK-02 | `EVENT_SOURCES` row sample/doc in sync | unit | `bun test ./packages/mcp-server/src/event-sources.test.ts` | Phase 17 |
| DESK-03 | Unlisted valid token → isError, runner 0 calls, 0 events | integration | `bun test ./packages/mcp-server/src/desktop/tool.test.ts` | ❌ W0 |
| DESK-03 | Anonymous (`allowAnonymous`, null caller) → isError | integration | same | ❌ W0 |
| DESK-03 | VM guest: no bearer → 401; bogus bearer → 401; runner 0 calls; `surface` arg / propose header → refused | integration (real HTTP) | `bun test ./packages/mcp-server/src/http.test.ts` | ✅ file, ❌ cases |
| DESK-03 | `auditMode("desktop_run") === "fail-closed"`; unwritable audit → -32000, runner 0 calls | unit + integration | `bun test ./packages/audit/src/policy.test.ts` and `…/http.test.ts` | ✅ (Phase 17 entry) |
| DESK-03 | Allowlist parsing: unknown names dropped + warned by name only; `isOperator` irrelevant; absolute-dir rule | unit | `bun test ./packages/mcp-server/src/authority.test.ts` (or new `desktop/config.test.ts`) | ❌ cases |
| DESK-04 | Script: disk gate, `--pull never`, loopback port, no privileged/socket/host mounts, foreign container refused, missing image refused, no `recruitment`/rm/stop/kill/pull, env file 0600 never echoed, non-root exit 1, `bash -n`, shellcheck | unit (PATH stubs) | `bun test ./scripts/substrate-desktop.test.ts` | ❌ W0 |
| DESK-05 | Harness flag + env | unit | `bun test ./packages/mcp-server/src/rehearsal-env.test.ts` and `bun test ./scripts/rehearsal.test.ts` | Phase 16 files, ❌ cases |
| DESK-05 | Pixel band in returned block; sha equalities; events read back; audit file; live refusals; 6081 401; recruitment unchanged; status lines | e2e (harness + real container) | `bun run rehearsal up --name p30 --surfaces omp,cursor --desktop-surfaces omp && bun run smoke:desktop --name p30 && bun run check:phase-close && bun run rehearsal down --name p30` | ❌ W0 (`scripts/desktop-smoke.ts`) |
| DESK-05 | N1 capture path | manual-assisted spike | spike transcript `30-N1-SPIKE.md` | ❌ |

### Sampling Rate
- **Per task commit:** the touched file's own `bun test ./path/to/file.test.ts` (one command per file) + `bunx tsc --noEmit`.
- **Per wave merge:** `bun test` (full) + `bunx tsc --noEmit`.
- **Phase gate:** full suite green, `bun run check:phase-close` exit 0, then the proof chain.

### Wave 0 Gaps
- [ ] `packages/mcp-server/src/desktop/{actions,png,driver,tool}.test.ts`
- [ ] `scripts/substrate-desktop.test.ts` (+ stub helpers inside the test file)
- [ ] `scripts/desktop-smoke.ts` (+ pure helpers tested in `scripts/desktop-smoke.test.ts`: band finder, marker text builder, key-rule, URL guard reuse)
- [ ] new cases in `http.test.ts`, `authority.test.ts` (or `desktop/config.test.ts`), `rehearsal-env.test.ts`, `rehearsal.test.ts`

## Security Domain

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Bearer → surface at the server gate (server.ts:254-257); no new credential |
| V3 Session Management | no | stateless MCP |
| V4 Access Control | yes | Operator allowlist in `runDesktop`; anonymous refused; `isOperator` ignored |
| V5 Input Validation | yes | Zod strict object (SDK-validated) + driver re-parse; key grammar; `TYPEABLE` |
| V6 Cryptography | yes (hashing only) | `node:crypto` sha256 for text/keys/screenshots; no secrets generated in TS (script uses `openssl rand`) |
| V7 Error handling/logging | yes | `redact` on every error string; ≤ 300 chars in events |
| V12 Files | yes | Server-generated run ids, fixed file names, 0700/0600, absolute `desktopDir` |

### Threat register (STRIDE)
| ID | Threat | STRIDE | Mitigation |
|----|--------|--------|------------|
| T-30-01 | argv injection (program/flag via caller fields) | Elevation | Fixed builders; numbers via `String()`; text after `--`; key grammar `[A-Za-z0-9_+ ]`; builder-table test; `execFile` never a shell |
| T-30-02 | Env leakage to the child (`SUBSTRATE_TOKEN_*`, ledger password, handoff key) | Info disclosure | `childEnv` = PATH + HOME; unit test with a poisoned parent env |
| T-30-03 | Unlisted/anonymous/VM-guest use | Elevation | 401 gate; anonymous refusal; allowlist; one test each; harness proof live |
| T-30-04 | Self-attribution (`surface` arg, propose header) | Spoofing | Strict schema rejects extra keys (probe); header never read |
| T-30-05 | Typed secrets in events/audit | Info disclosure | `text_len`+`text_sha256`, keys rule (C6), audit stores digest only. **Residual:** an unsalted sha256 of a short typed value (PIN, short password) is brute-forceable by any reader of the ledger (`events_query` is open to every surface), and `arg_digest` covers the same args. Runbook: never type secrets through `desktop_run` |
| T-30-06 | Screenshot content (desktop shows what agents typed/browsed) | Info disclosure | 0600/0700 under root state dir; retention; images never in events/audit |
| T-30-07 | Reaching other host content through the desktop | Info disclosure / Elevation | Container: no host mounts, no socket, unprivileged, bridge network (verified `status`). **Residual (accepted by design, Sept T-05-03-03):** the desktop's terminal/browser has network egress and can reach host services bound to all interfaces through the bridge gateway (several such listeners exist on this host); host loopback-only services (7410, 6081) are not reachable from the bridge. Inside the container `abc` is in `sudo` and `docker` groups but there is no socket. Document in the runbook |
| T-30-08 | Basic-auth bypass on the web view | Info disclosure | Published on `127.0.0.1:6081` only (`ss`); `401` without credentials (probe); password generated once, 0600, never printed; smoke checks 401 without reading credentials |
| T-30-09 | DoS by long/many runs | DoS | Refuse while busy; run ≤ 120 s (+ ≤ 30 s title read); per-call 30 s; 1 MB body cap; only allowlisted callers. Residual: a listed caller can keep the desktop busy back-to-back; ~35 MB replies (R4) |
| T-30-10 | Path traversal in run ids / dir | Tampering | Run id server-generated (`dr-<stamp>Z-<6hex>`), `prune` deletes only `RUN_ID` matches inside `desktopDir`; `desktopDir` absolute, operator-set |
| T-30-11 | Audit/event content leaks via error text | Info disclosure | `redact` + 300-char cap; `failure()` maps not-running to a fixed string |
| T-30-12 | Touching `recruitment-desktop` | Tampering | No code path names it; script never rm/stop/kill/pull; smoke compares inspect before/after |
| T-30-13 | Stale in-container xdotool after timeout | Tampering (integrity of next run) | Documented (Pitfall 6); no kill path added |
| T-30-14 | Image pull / supply chain | Tampering | `--pull never`, image must be local |

## Recommended plan / wave split

| Plan | Wave | Content | Files |
|------|------|---------|-------|
| 30-01 Desktop module port | W1 | `actions.ts` verbatim; `png.ts` (decodeXwd, encodePng, crc32, decodePng); `driver.ts` with childEnv, busy flag, tool.call events, key rule, stop-on-unstored, no-event-for-not-started; tests | `packages/mcp-server/src/desktop/{actions,png,driver}.ts`, `{actions,png,driver}.test.ts` |
| 30-02 Config + allowlist | W1 | `desktopSurfaces`, `desktopDir` (absolute), ignored-name capture; `desktopWarnings` sibling; `.env.example` names | `config.ts`, `index.ts` (warnings loop), `authority.test.ts` or `desktop/config.test.ts`, `.env.example` |
| 30-03 Lifecycle script | W1 | Port script (env-file seam, SC2016 directive, comments to the runbook); PATH-stub tests | `infra/desktop/substrate-desktop.sh`, `scripts/substrate-desktop.test.ts` |
| 30-04 Tool registration, refusals, events | W2 (after 01, 02) | `Substrate.runDesktop` + `stores.desktop` (default null); `mcp.ts` registration with strict object; `observe.ts` `KNOWN_TOOLS`; `index.ts` real driver; `EVENT_SOURCES` sample + `docs/event-vocabulary.md`; refusal/VM-guest/audit/fail-closed tests; `bufferRunner` reference lock | `service.ts`, `mcp.ts`, `observe.ts`, `index.ts`, `event-sources.ts`, `docs/event-vocabulary.md`, `desktop/tool.test.ts`, `http.test.ts` |
| 30-05 Harness flag | W2 (parallel with 04) | `--desktop-surfaces`, env keys, tests | `packages/mcp-server/src/rehearsal-env.ts` (+test), `scripts/rehearsal.ts` (+test) |
| 30-06 N1 spike | W2 (after 01; needs png.ts) | Spike ladder; `30-N1-SPIKE.md`; if a fix: change the screenshot step in `driver.ts`/`actions.ts` with tests | `.planning/phases/30-desktop-run/30-N1-SPIKE.md`, possibly `desktop/{actions,driver}.ts` |
| 30-07 Smoke, proof, docs | W3 (after 04, 05, 06) | `scripts/desktop-smoke.ts` (+ helper tests), `package.json` `smoke:desktop`, proof run, `30-PROOF.md`; README section, `docs/runbooks/desktop.md`, `docs/mcp-audit.md` fail-closed table row | `scripts/desktop-smoke.ts`, `scripts/desktop-smoke.test.ts`, `package.json`, `README.md`, `docs/runbooks/desktop.md`, `docs/mcp-audit.md` |

Plans 01–03 touch disjoint files. 04 and 05 are disjoint. 06 may edit `desktop/driver.ts` after 01 lands; 07 depends on everything.

## Sources

### Primary (HIGH confidence)
- p30 worktree files read this session: `mcp.ts`, `service.ts`, `config.ts`, `observe.ts`, `server.ts`, `index.ts`, `event.ts`, `redact.ts`, `types.ts`, `mcp.test.ts`, `http.test.ts`, `store-lock.test.ts`, `authority.test.ts` (grep), `packages/audit/src/{record,policy,policy.test}.ts`, `tsconfig.json`, `package.json`s, `.env.example` (names), `README.md`/`docs/mcp-audit.md` headings.
- `git show acc30a8:` `packages/mcp-server/src/desktop/{actions,driver}{,.test}.ts`, `infra/desktop/substrate-desktop.sh`, `packages/mcp-server/src/{mcp,service}.ts` (desktop parts), `.planning/phases/05-docs-and-desktop/{05-03-PLAN,05-03-SMOKE,05-03-SUMMARY,05-PROOF,05-VERIFICATION}.md`.
- Installed SDK 1.30.1 sources (`server/mcp.js`, `server/zod-compat.js`, `types.js`, `shared/protocol.js`, `client/streamableHttp.js`) and two probes (strict vs shape; stateless HTTP client with 70 s call, image block, 401 on connect).
- Live read-only probes: `docker container inspect` (both containers), container `ps`, `/proc/253/cmdline`, `xprop -root`, `xdotool search/getdisplaygeometry/getactivewindow`, `xwininfo -root -children`, `xdpyinfo`, `xwd -root -silent` decoded with PIL, abc's xfconf XML files, `dpkg-query`, `vmstat`, `uptime`, `ss`, `curl` 401, the acc30a8 script's `status`, September PNG at `/var/lib/substrate/desktop/dr-20260927T055519Z-002e8a/1.png`.

### Secondary (MEDIUM: planned, not merged)
- Phase 16 worktree `rehearsal-env.ts`, `rehearsal-env.test.ts`, `scripts/rehearsal.ts` (uncommitted edits in progress).
- Phase 17 worktree `event-sources.ts`, `event-sources.test.ts`, 17-CONTEXT/RESEARCH/02-PLAN/03-PLAN.
- Phase 18 18-CONTEXT (redaction lock D18-12..16); Phase 21 21-CONTEXT (D21-15), 21-PATTERNS (SkillProposer seam).

### Tertiary (LOW)
- VTE truecolor exactness and xfce4-terminal cell size (A1, A2); N1 cause candidates (A3).

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new dependency; SDK behaviour probed.
- Architecture / integration points: HIGH — every file read with line ranges.
- Port delta: HIGH — both sides read in full.
- Pitfalls: HIGH for SDK timeout, strict schema, script seam, shellcheck, harness tests; MEDIUM for N1.
- N1 cause: LOW-MEDIUM until the spike runs.

**Research date:** 2026-10-08
**Valid until:** 2026-10-22 (Phase 16/17/18 are moving; re-check line anchors after they merge)
