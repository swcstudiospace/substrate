# Phase 30: desktop_run - Context

**Gathered:** 2026-10-08
**Status:** Ready for planning
**Mode:** Smart discuss, auto-accepted under the v1.3 run rules (`.planning/STATE.md`, "v1.3 decisions"). Recommended answers that touch a user-visible contract are listed under "Open for the operator"; the plan uses the recommendation until the operator says otherwise.

<domain>
## Phase Boundary

One PR on agent-substrate (DESK-01..05). An authenticated agent on an operator-listed surface drives the dedicated `substrate-desktop` webtop through `desktop_run` (click, type, key, screenshot) and gets the screenshots back as MCP image blocks; every action leaves one `tool.call` event, and nothing else on the host is reachable through the tool.

1. **Port, not merge.** `packages/mcp-server/src/desktop/{actions,driver}.ts`, `actions.test.ts`, `driver.test.ts` and `infra/desktop/substrate-desktop.sh` come from `acc30a8` (`git show acc30a8:<path>`), onto main's v1.2 surface-token model. September's `proposeAllowed` / `x-substrate-propose-key` gate is not ported (Phase 21 dropped the header, D21-01); the gate is the operator allowlist (D30-01).
2. **Guards come from earlier phases.**
   - The event mapping: Phase 17's `EVENT_SOURCES` row `desktop.action` (phase 30, kind `tool.call`, caller surface).
   - The fail-closed audit entry: Phase 17 already puts `desktop_run` in `FAIL_CLOSED_TOOLS`; Phase 30 adds the `observe.ts` `KNOWN_TOOLS` entry and the `mcp.ts` registration.
   - Error strings go through Phase 18's shared `redact` (`packages/mcp-server/src/redact.ts`); `redact-lock.test.ts` forbids a second redactor.
3. **Registered where a tool must be:** `mcp.ts` `registerTool`, `observe.ts` `KNOWN_TOOLS`. MCP only: no REST twin, no CLI command (an image block has no REST/CLI consumer, and September had none).

**Proof (DESK-05, isolated, no operator approval needed):** unit tests, then one scripted headless MCP session against the Phase 16 harness and the local, already-running `substrate-desktop` container. No production service or store is touched; `recruitment-desktop` (exited 12 days ago) is only inspected.

**Out of scope:**
- Restarting production onto this code, and setting the production allowlist (operator, after merge; see "Live steps").
- Production surface tokens (Phase 20).
- Any new `EVENT_KINDS` or `SURFACES` entry (Phase 17 lock); new redaction rules (Phase 18).
- A cua image or any new desktop image (REQUIREMENTS out-of-scope: `cua-xfce` is too large); pulling any image.
- Lane A VMs reaching the desktop (Phases 31–33 give the VM no token and no host function for it).

**Depends on code not yet on `main`:**
- Phase 16: `scripts/rehearsal.ts`, `packages/mcp-server/src/rehearsal-env.ts`, `consumer.env`, `tokens/<surface>` files — extended here.
- Phase 17: `event-sources.ts` (`desktop.action` row), `policy.ts` (`desktop_run` fail-closed), `docs/event-vocabulary.md`, `bun run check:phase-close`.
- Phase 18: shared `redact.ts`, `redact-lock.test.ts`.
Execution starts from a base that holds all three (rebase onto `main` after they merge).

</domain>

<decisions>
## Implementation Decisions

### Who may call (DESK-03)
- **D30-01: The operator allowlist is the only gate.** `SUBSTRATE_DESKTOP_SURFACES` (comma-separated surface names) in the service environment (`/etc/substrate/substrate.env` in production), parsed by `loadConfig` into `config.desktopSurfaces: ReadonlySet<Surface>`.
  - Unset or empty means nobody may call `desktop_run` (fail-closed default).
  - A name that is not in `SURFACES` is dropped and reported by `configWarnings` at boot (no value printed beyond the name); it never widens the list.
  - Swarm surfaces and `substrate` are allowed only if listed, like any other surface. An operator token is not a bypass: `isOperator` grants nothing here.
- **D30-02: Refusal cases, each with its own test.**
  - **Unlisted surface with a valid token:** MCP `isError` refusal "desktop_run is not enabled for surface <s>; nothing was run". No `docker` call, no event.
  - **Anonymous caller** (a tokenless `allowAnonymous` run, `callerSurface === null`): always refused in the tool, even though anonymous runs are otherwise accepted — "desktop_run needs an authenticated, operator-listed surface; nothing was run".
  - **VM guest:** a Lane A VM holds no token (ROADMAP Phase 32 criterion 3) and reaches `127.0.0.1:7410` like any local process. On an authenticated deployment its request is 401 at the server's token gate before MCP dispatch; on an anonymous deployment it is the anonymous case. The VM-guest test drives the real HTTP server (`server.test.ts` style): no `Authorization` header → 401 and the driver's runner is never called; a bogus bearer → 401; and an attempt to self-attribute (a `surface` argument or September's `x-substrate-propose-key` header) is rejected by the strict input schema / ignored, never honoured.
- **D30-03: The tool stays registered for every caller** and refuses in its handler, so the refusal is explicit, testable and audited (the audit gate records the call before dispatch; the record holds arg keys and a digest only).
- **D30-04: Pre-run refusals emit no event.** Allowlist, anonymous, busy and validation refusals run no action, so there is no action event (DESK-02 is one event per action). The audit record is their trail. The Phase 17 vocabulary is unchanged.

### Run contract (DESK-01)
- **D30-05: Vocabulary and limits ported as is.** `DesktopRunInput` strict object: `actions` 1..50 of `click {x, y, button?, double?, settle_ms?}`, `type {text 1..2000 chars, no control chars but \n and \t, settle_ms?}`, `key {keys: 1..8 chords of [A-Za-z0-9_] joined by +, settle_ms?}`, `screenshot {}`; `timeout` integer 1..120 s, default 30 (whole-run deadline). Clicks outside the display geometry read at run start refuse the whole run before any action.
- **D30-06: Fixed argv.** Every call is `docker exec -e DISPLAY=:1 substrate-desktop` + `xdotool …` or `xwd -root -silent`; the container name is a constant, not configuration. `typeArgv` ends options with `--`. A test enumerates every argv builder and asserts the exact `EXEC` prefix and that no caller field reaches a program or flag position.
- **D30-07: The child environment is an allowlist**, not `process.env` (September spread `process.env`, which carries every `SUBSTRATE_TOKEN_*`): `PATH` and `HOME` only (Phase 21 D21-15 precedent). Buffer-mode `execFile`, 16 MiB `maxBuffer`, never a shell.
- **D30-08: One run at a time, refuse while busy.** A module-scope flag (`createMcpServer` is rebuilt per request); a second call while a run is active is refused at once with "desktop_run is busy with run <run_id>; nothing was run". September queued; queuing holds an HTTP request open for up to n × 120 s, past any client tool timeout. Test: two concurrent runs, the second refused, the runner called only for the first.
- **D30-09: Screenshots.** XWD (24 or 32 bpp) decoded and re-encoded as PNG by the ported `decodeXwd`/`encodePng`; returned as `{type: "image", mimeType: "image/png", data}` blocks after one text block `{run_id, screenshots: [{path, width, height, sha256}], log}`; stored under `config.desktopDir/<run_id>/<n>.png`, dirs 0700, files 0600; newest 200 runs and 7 days kept (`prune`, the current run always kept).
  - `SUBSTRATE_DESKTOP_DIR` overrides the default `/var/lib/substrate/desktop` (production already has it, 0700 root, inside the unit's `StateDirectory`); the harness points it into its run directory.
- **D30-10: Budgets ported.** 30 s per `docker exec` round trip (measured under CPU steal in September), plus 200 ms per typed character for `type`; settle defaults click 300 / type 200 / key 800 ms; the deadline stops actions that have not started, never one in flight.

### Events and audit (DESK-02)
- **D30-11: One `tool.call` event per executed action**, matching Phase 17's `desktop.action` row: `surface` = the authenticated caller, `actor: "agent"`, `session_id: "desktop:<run_id>"` (one-session-per-job pattern, Phase 17 "Sessions for job events"), summary `desktop <action> ok|failed`, payload `tool: "desktop_run"`, `action`, `run_id`, `i`, `ok`, `ms`, plus:
  - type: `text_len` + `text_sha256` — never the text;
  - screenshot: `sha256`, `width`, `height` — never bytes or base64;
  - click: `x`, `y`, `button`, `double`;
  - key: `keys` verbatim only when every chord is a named key (≥ 2 characters, e.g. `Return`, `ctrl+alt+t`) or carries a modifier; otherwise `keys_len` + `keys_sha256` (single-character chords can spell text eight keys at a time);
  - failure: `error`, redacted, ≤ 300 chars.
  - The active-window title stays in the tool's `log` returned to the caller and is not put in the event (a terminal title can echo typed text).
  - The `EVENT_SOURCES` row's sample and `docs/event-vocabulary.md` are updated in the same PR for the click/key fields (a reviewed change to the table, as Phase 17 requires); kind, surface rule and `tool`/`action` values are unchanged.
- **D30-12: An event that is not stored stops the run** (Phase 17's recorded recommendation). `Substrate.emit` reports `stored: false` → no further action runs; the tool returns `isError` with `{run_id, log, error: "event not stored after action <i>; run stopped"}` and no image blocks. A bare run without Greptime therefore cannot run desktop actions — fail-closed by design.
- **D30-13: The audit record never sees content.** The audit chain already keeps only arg key names and a digest (`packages/audit/src/record.ts` `argDigest`) and never tool results; a test asserts the record for a `desktop_run` call carries no typed text and no PNG/base64, and that `auditMode("desktop_run") === "fail-closed"`.

### Lifecycle script (DESK-04)
- **D30-14: Port `infra/desktop/substrate-desktop.sh` with `up` and `status` only.** It never stops, removes or pulls anything, and names no other container.
  - `up` order: root check → disk gate `df --output=avail -B1 /` ≥ 10737418240 → image must be local (`docker image inspect`, else refuse) → basic-auth env file `/etc/substrate/substrate-desktop.env` generated once under umask 077 (`CUSTOM_USER`, `PASSWORD`; never echoed; it already exists on this host) → if a container named `substrate-desktop` exists it must carry `org.swcstudio.substrate.role=desktop` (else refuse) and is started only if stopped → else `docker run -d --pull never` with `-p 127.0.0.1:6081:3000`, `--env-file`, the role label, named volume `substrate-desktop-config:/config`, `--restart unless-stopped`, `--shm-size 1g`, no `--privileged`, no host bind mounts, no Docker socket → wait ≤ 60 s for geometry `1280 800`.
  - `status` prints key=value lines (exists, running, ports, geometry, image, label_role, privileged, mounts, docker_socket_mounted, id).
- **D30-15: Script tests run without Docker.** A bun test runs the script with `PATH`-injected stubs for `docker`, `df` and `openssl` (recording argv to a file) and asserts: the `docker run` argv holds `--pull never` and `-p 127.0.0.1:6081:3000` and none of `--privileged`, `docker.sock`, `--network host`, `-v /`; `up` refuses below 10 GiB free before any `docker` call; refuses a same-named container without the label; refuses a missing image without pulling; the string `recruitment` and the verbs `rm`, `stop`, `kill`, `pull` (outside `--pull never`) never appear in any recorded argv. `bash -n` and, if present, `shellcheck` run on the script. The root check is exercised as written (the tests run as root here; a non-root run is asserted to exit 1 when not root).

### Proof (DESK-05)
- **D30-16: "Headless session" = a scripted MCP client session, no model.** `scripts/desktop-smoke.ts` (`bun run smoke:desktop`) uses the MCP SDK client over streamable HTTP with an allowlisted surface's token from the harness `tokens/` directory; no model quota, no live system. A `claude -p` run is an optional operator-approved extra, not the proof (see open question 2).
- **D30-17: The proof asserts pixels, never the window title** (September N1: titles passed while xwd pixels lagged the newest window).
  - Marker: a run nonce derives an RGB triple; one run does `screenshot` (baseline) → `key ctrl+alt+t` → `type "printf '\033[48;2;R;G;Bm%48s\033[0m\n' ''  # substrate-smoke-<nonce>\n"` → `screenshot` → `type "exit\n"`.
  - Pass: the PNG decoded from the **returned image block** (sha256 equal to the stored file and to the event's `sha256`) holds ≥ 1,500 pixels of exactly that RGB forming one rectangular band, and the baseline screenshot holds none (a nonce whose colour is already present is re-drawn). The colour appears only if the typed keystrokes reached the shell and the terminal repainted, which is exactly what N1 got wrong. PNG decode is a ~30-line inflate of the ported encoder's filter-0 rows (no new dependency).
  - The trailing `exit` closes the smoke's own terminal (September left 7 terminals, N2).
- **D30-18: N1 is spiked before the proof plan.** An early task reproduces N1 on the local container with the marker method (a screenshot-only probe plus one marker run) and records the capture path that yields fresh pixels. Compositing is already off (`xfwm4 /general/use_compositing = false`, read 2026-10-08), so that is not the cause; candidates for the spike: settle/repaint timing under load, xfce4-terminal damage handling, a second `xwd` after a short wait inside the screenshot action. Any fix stays inside the fixed vocabulary (no new action kind). If no capture path yields fresh pixels, the proof is reported as a gap, never passed on titles.
- **D30-19: The smoke also checks, from the same harness run:**
  - one stored `tool.call` per executed action under `session_id desktop:<run_id>` (read back via `POST /events/query`), kinds and payload keys equal to the `EVENT_SOURCES` row, `text_sha256` = sha256 of the typed text, no payload containing the typed text or a base64 PNG prefix (`iVBOR`);
  - the harness audit file holds the `desktop_run` record with `mode: fail-closed` and none of the typed text or `iVBOR`;
  - refusals live: an unlisted surface's valid token → `isError` refusal and no new event; no token → 401;
  - basic auth: `GET http://127.0.0.1:6081/` without credentials answers 401 (credentials never read or printed);
  - `recruitment-desktop` untouched: `docker container inspect --format '{{.Id}} {{.State.Status}} {{.State.StartedAt}} {{.State.FinishedAt}}'` identical before and after;
  - `substrate-desktop.sh status` shows `ports=127.0.0.1:6081->3000`, `privileged=false`, `docker_socket_mounted=false`, label `desktop`.
  - Smoke guard (Phase 16): refuses a `SUBSTRATE_URL` on port 7410 or a non-loopback host.
- **D30-20: Harness extension.** `bun run rehearsal up` gains `--desktop-surfaces a,b` (must be a subset of `--surfaces`; refused otherwise) which `buildRehearsalEnv` writes as `SUBSTRATE_DESKTOP_SURFACES`, and sets `SUBSTRATE_DESKTOP_DIR=<runDir>/desktop`. Proof run: `bun run rehearsal up --name p30 --surfaces omp,cursor --desktop-surfaces omp` → `bun run smoke:desktop` → `bun run check:phase-close` → `bun run rehearsal down --name p30`.

### Docs
- **D30-21:** `README.md` tool list gains `desktop_run`; `docs/runbooks/desktop.md` (new) covers the allowlist variable, `substrate-desktop.sh up|status`, the basic-auth file, retention and the rollback (unset the variable → every call refused); `docs/mcp-audit.md` marks `desktop_run` as landed; the September `desktop.action` kind is named nowhere as a kind.

### Claude's Discretion
- File split inside `packages/mcp-server/src/desktop/` (e.g. a separate `png.ts` for decode/encode) and test layout.
- Exact refusal wording, beyond containing "nothing was run".
- How `Substrate` receives the driver (constructor `stores`/deps seam like Phase 21's `SkillProposer`), as long as tests and the harness never reach the real runner by accident.
- Whether `configWarnings` names an empty allowlist when other tokens are set (informational only).

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `acc30a8:packages/mcp-server/src/desktop/actions.ts` (Zod vocabulary, argv builders, `boundsRefusal`) and `driver.ts` (Buffer runner, `decodeXwd`, `encodePng`, `crc32`, `prune`, driver with injected `run`/`emit`/`now`/`sleep`), with their tests. September's driver emitted kind `desktop.action` and spread `process.env` into the child; both change (D30-07, D30-11).
- `acc30a8:infra/desktop/substrate-desktop.sh` — `up`/`status`, already proven against this host's container in September (05-03-SMOKE).
- Main `mcp.ts`: `createMcpServer(substrate, caller: McpCaller | Surface | null)` gives `callerSurface`/`isOperator` per request; `refusal`/`json`/`text` helpers.
- Main `service.ts` `Substrate.emit(input): EmitResult` with `stored: boolean` (D30-12 reads it).
- Main `config.ts` `loadConfig`/`configWarnings` and the `SUBSTRATE_OPERATOR_TOKENS` comma-list parsing pattern.
- Main `observe.ts` `KNOWN_TOOLS`, `auditToolCalls` (audit in front of the dispatcher), `packages/audit/src/record.ts` `argDigest`.
- Phase 16 `rehearsal-env.ts` `buildRehearsalEnv`, `consumerEnvRecord` (`SUBSTRATE_REHEARSAL_TOKENS_DIR`), `scripts/rehearsal.ts` flag parsing (`--surfaces`, `--operator`, `--anonymous`).

### Established Patterns
- Tool tests connect an MCP client to `createMcpServer` with an injected substrate and a caller (`mcp.test.ts` `connect(greptime, surface)`); HTTP-gate tests run the real server (`server.test.ts`, `http.test.ts`).
- Fixed argv + injected runner for anything that executes a program (September D-13, Phase 21 `SkillProposer`).
- Refusals as MCP `isError` text; no content in events, hashes and lengths only (Phase 17).
- Colocated `*.test.ts` under `bun test`; no CI; baseline 1129 pass / 56 skip / 0 fail, `bunx tsc --noEmit` clean.

### Integration Points
- `packages/mcp-server/src/mcp.ts` (register `desktop_run`), `service.ts` (`runDesktop`), `config.ts` (`desktopSurfaces`, `desktopDir`), `observe.ts` (`KNOWN_TOOLS`), `index.ts` (wire the real runner), `event-sources.ts` + `docs/event-vocabulary.md` (row sample fields), `rehearsal-env.ts` + `scripts/rehearsal.ts` (flag), `package.json` (`smoke:desktop`), `infra/desktop/substrate-desktop.sh`, `README.md`, `docs/runbooks/desktop.md`, `docs/mcp-audit.md`.
- Live host facts (read-only, 2026-10-08): `substrate-desktop` (`linuxserver/webtop:ubuntu-xfce`) up 9 days on `127.0.0.1:6081->3000`, label role `desktop`, not privileged, only the named volume mounted, geometry `1280 800`; `recruitment-desktop` exited (137) 12 days ago; `/` has ~20.7 GB free; `/var/lib/substrate/desktop` exists 0700 root; `/etc/substrate/substrate-desktop.env` exists 0600 root with `CUSTOM_USER`/`PASSWORD` names; production unit runs as root with `ProtectSystem=full` and `AF_UNIX` allowed (the Docker socket is reachable, `/etc` is read-only to it). Host has `python3`+PIL and ImageMagick, the container has no `tesseract` or `import`.

</code_context>

<specifics>
## Specific Ideas

- Pixel proof, not title proof (operator note on September N1).
- `recruitment-desktop` must never be touched: no code path names it; the proof only inspects it.
- Typed text as length + sha256, screenshots as sha256 + dimensions; no image bytes in events or audit (Phase 17).

## Open for the operator (user-visible; the plan uses the recommendation)

1. **Initial production allowlist.** Code default is empty (nobody). Recommendation: leave production empty until the operator names surfaces after merge; the proof uses the harness only. Alternative: ship with `omp` (the operator's interactive agent) listed in the runbook as the suggested first entry.
2. **"Headless session" for DESK-05.** Recommendation: a scripted MCP client session (no model, no quota, isolated). Alternative: additionally a `claude -p` session with the allowlisted token, which spends model quota and so waits for operator approval.
3. **What "pixels show the typed marker" means.** Recommendation: the typed command paints a nonce-coloured band whose exact RGB is counted in the returned PNG (deterministic, no OCR on this host). Alternative: glyph-level OCR of the nonce text, which needs a new tool (`tesseract`) installed on the host or in the container.
4. **Busy behaviour.** Recommendation: refuse a concurrent call immediately (D30-08). Alternative: September's queue.

</specifics>

<deferred>
## Deferred Ideas

- A REST/CLI door for `desktop_run` (no image-block consumer today).
- Desktop access from Lane A VMs through a host function (would need its own allowlist entry and threat model; Phases 31–33 do not add one).
- OCR-based screenshot assertions.
- Cleaning up the 7 terminal windows September's smokes left in `substrate-desktop` (N2); the new smoke closes its own.

</deferred>
