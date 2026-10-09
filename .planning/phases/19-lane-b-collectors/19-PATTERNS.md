# Phase 19: Lane B collectors - Pattern Map

**Mapped:** 2026-10-08
**Files analyzed:** 31 (21 new, 10 modified)
**Analogs found:** 30 / 31. The one without an analog is the herdr transport test's fake Unix-socket server; it has a partial analog.

## Where the analogs live (read this first)

| Source | How to read it | On `main`? |
|---|---|---|
| This worktree (`/root/src/worktrees/agent-substrate-v13-p19`, HEAD `5530db4`, main `ab62c91` + planning) | plain `read` | **yes** |
| September port source `acc30a8` | `git -C /root/src/worktrees/agent-substrate-v13-p19 show acc30a8:<path>` | **no**, branch only. Port by reading it; never merge it (D19-01) |
| Phase 16 harness (`/root/src/worktrees/agent-substrate-v13-phase`, HEAD `50625c9`, 55 commits on `ab62c91`) | plain `read` | **no**: executed, not merged. `git merge-base --is-ancestor 50625c9 HEAD` fails on p19 |
| Phase 17 (`/root/src/worktrees/agent-substrate-v13-p17`) | `.planning/phases/17-*/17-0{1,3}-PLAN.md` only | **no**: plans only. `packages/mcp-server/src/event-sources.ts` does not exist anywhere yet |
| Phase 18 (`/root/src/worktrees/agent-substrate-v13-p18`) | `.planning/phases/18-*/18-RESEARCH.md` Pattern 5, `18-02-PLAN.md` | **no**: plans only. `redact-lock.test.ts` does not exist anywhere yet |

Phase 19 executes from a `main` that already holds Phases 16 to 18 (CONTEXT, "Depends on"). Every Phase 16/17/18 excerpt below is a **shape to re-read in the merged file at execution time**, not a line number to trust. Line numbers are given for `main` and `acc30a8`, which are frozen.

Tracked-source gate: each analog path named here was checked with `git ls-files` in its own worktree, or is a `git show acc30a8:` object. No gitignored mirror is named. The live `/etc/systemd/system/*.service` and `/var/lib/substrate/muse-plugin` copies are **not** analogs; use `acc30a8:infra/vps/*` and `acc30a8:packages/projector/src/muse.ts`.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `packages/collectors/src/emit.ts` (new) | utility (HTTP client) | request-response, fail-open | `acc30a8:packages/collectors/src/cursor-stop.ts:185-195` (`postEvent`) + `packages/cli/src/index.ts:30-74` | exact (shape); outcome classification is new |
| `packages/collectors/src/emit.test.ts` (new) | test | request-response | `packages/cli/src/lessons.test.ts:58-110` (`FakeSubstrate` on `Bun.serve` port 0) | role-match |
| `packages/collectors/src/git-context.ts` (new) | utility | request-response (git spawn) | `packages/collectors/src/grok.ts:47-61` (`repoFor`, `branchFor`) | exact |
| `packages/collectors/src/git-context.test.ts` (new) | test | file-I/O (tmp git repos) | `packages/mcp-server/src/git.test.ts:1-35` (`tempRepo`) | exact |
| `packages/collectors/src/herdr-map.ts` (new, port) | utility (pure mapper) | transform | `acc30a8:packages/collectors/src/herdr-map.ts` + `packages/collectors/src/grok-map.ts` | exact (role), content rewritten |
| `packages/collectors/src/herdr-map.test.ts` (new, port) | test | transform | `acc30a8:packages/collectors/src/herdr-map.test.ts` + `packages/collectors/src/grok-map.test.ts` + Phase 17 planned `event-sources.test.ts` round trip | exact |
| `packages/collectors/src/herdr-state.ts` (new, discretionary) | service (pure reconciler + state file) | transform + file-I/O | `packages/collectors/src/grok.ts:28-45,111-171` (offsets load/save, first-sight seeding) | role-match |
| `packages/collectors/src/herdr-state.test.ts` (new) | test | transform | `packages/collectors/src/grok-map.test.ts` (pure table tests) | role-match |
| `packages/collectors/src/herdr.ts` (new, port) | service (long-running collector) | event-driven (socket push) + polling | `acc30a8:packages/collectors/src/herdr.ts` (transport) + `packages/collectors/src/grok.ts:173-189` (loop) | exact (transport), loop rewritten |
| `packages/collectors/src/herdr.test.ts` (new, optional) | test | event-driven | `scripts/rehearsal.ts:228-239` (Phase 16, `node:net createServer` + `withResolvers`) | partial: no Unix-socket ND-JSON fake exists |
| `packages/collectors/src/muse.ts` (new, port) | service (long-running writer) | request-response + file-I/O | `acc30a8:packages/collectors/src/muse.ts` | exact |
| `packages/collectors/src/muse.test.ts` (new, port) | test | file-I/O | `acc30a8:packages/collectors/src/muse.test.ts` + `packages/mcp-server/src/git.test.ts:18-31` | exact |
| `packages/collectors/src/cursor-stop.ts` (new, port) | hook (CLI on stdin) | request-response + file-I/O | `acc30a8:packages/collectors/src/cursor-stop.ts` | exact |
| `packages/collectors/src/cursor-stop.test.ts` (new, port) | test | file-I/O | `acc30a8:packages/collectors/src/cursor-stop.test.ts` | exact |
| `packages/collectors/src/status.ts` (new, discretionary; or `scripts/collectors-status.ts`) | utility (read-only report CLI) | file-I/O (read) | Phase 16 `scripts/parity-check.ts:128,262-425` (pure verdict + thin `main`, `--json`, exits 0/1/2) | role-match |
| `packages/collectors/src/status.test.ts` (new) | test | file-I/O | `packages/collectors/src/grok-map.test.ts` (pure) + `packages/projector/src/swarm-workspace.test.ts:32-41` (CLI spawn) | role-match |
| `packages/collectors/src/grok.ts` (modified) | service | file-I/O tail → emit | itself, `:94-109` (`emit`) replaced by `emit.ts`; `:28-45` gets `counters` | exact |
| `packages/projector/src/muse.ts` (new, port) | projector (bundle generator + CLI driver) | file-I/O + subprocess | `acc30a8:packages/projector/src/muse.ts` + `packages/projector/src/swarm-workspace.ts:560-587` (`--check` exit-1 convention) | exact |
| `packages/projector/src/muse.test.ts` (new) | test | file-I/O + subprocess | `packages/projector/src/swarm-workspace.test.ts:1-45` (CLI spawn, `SENTINEL` token-leak check) | exact |
| `packages/projector/src/cursor.ts` (modified) | projector | file-I/O (JSON merge) | `acc30a8:packages/projector/src/cursor.ts:24-70` (+`script()`, `STOP_SCRIPT`, `--print-desired`) | exact |
| `packages/projector/src/cursor.test.ts` (new) | test | file-I/O + subprocess | `packages/projector/src/swarm-workspace.test.ts:17-41` | exact |
| `infra/vps/substrate-collector-herdr.service` (new, port) | config (systemd unit) | — | `acc30a8:infra/vps/substrate-collector-herdr.service` | exact |
| `infra/vps/substrate-collector-muse.service` (new, port) | config (systemd unit) | — | `acc30a8:infra/vps/substrate-collector-muse.service` | exact |
| `scripts/laneb-proof.ts` (new) | script (isolated e2e proof) | batch / request-response | Phase 16 `scripts/rehearsal.ts:868-1040` (`refuseSmokeUrl`, `parseShellExports`, `runSmoke`) + Phase 17 planned `scripts/vocabulary-smoke.ts` | role-match |
| `package.json` (modified) | config | — | Phase 16 `package.json` diff (`"rehearsal": "bun scripts/rehearsal.ts"`) | exact |
| `docs/collectors.md` (new) | doc (topic) | — | `docs/swarm-correlation.md:1-25` + Phase 16 `docs/rehearsal.md:113-138` | role-match |
| `docs/runbooks/lane-b-collectors.md` (new) | doc (runbook) | — | Phase 16 `docs/runbooks/production-parity.md` (header table, "Operator step", "Rollback", "Who does what") | exact |
| `docs/event-vocabulary.md` (modified) | doc (machine-checked table) | — | Phase 17 planned (17-01 Task 3) | planned only |
| `packages/mcp-server/src/event-sources.ts` (modified, `herdr.pane_exited` row) | config (typed table) | — | Phase 17 planned (17-01 tracer) | planned only |
| `README.md` (modified) | doc | — | `README.md:64-79` (Layout) + the "Details in [`docs/x.md`](docs/x.md)" lines | exact |
| Generated bundle files `hooks/post-tool-use.ts`, `hooks/redact.ts`, `hooks/substrate.json`, `.muse-plugin/plugin.json` (not tracked; written by the projector) | generated artifact | — | `acc30a8:packages/projector/src/muse.ts:34-134` | exact |

---

## Pattern Assignments

### `packages/collectors/src/emit.ts` (utility, request-response, fail-open)

**Analog 1 (closest shape; env read at call time, not module load):** `acc30a8:packages/collectors/src/cursor-stop.ts:185-195`
```ts
/** POST one event to the substrate, bounded like the CLI; errors are the caller's to swallow. */
async function postEvent(event: EventInput): Promise<void> {
	const base = (process.env.SUBSTRATE_URL?.trim() || "http://127.0.0.1:7410").replace(/\/+$/, "");
	const token = process.env.SUBSTRATE_TOKEN?.trim();
	await fetch(`${base}/events`, {
		method: "POST",
		headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify(event),
		signal: AbortSignal.timeout(EMIT_TIMEOUT_MS),
	});
}
```

**Analog 2 (the CLI client convention D19-04 cites):** `packages/cli/src/index.ts:30-40`
```ts
const DEFAULT_URL = "http://127.0.0.1:7410";
const DEFAULT_TIMEOUT_MS = 1500;

function base(): string {
	return (process.env.SUBSTRATE_URL?.trim() || DEFAULT_URL).replace(/\/+$/, "");
}

function headers(): Record<string, string> {
	const token = process.env.SUBSTRATE_TOKEN?.trim();
	return { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
}
```

**Anti-pattern to replace (what every September collector did):** `packages/collectors/src/grok.ts:25,94-109`: `SUBSTRATE_URL` captured in a module const, and `return response.ok` with the result discarded by the caller. Do not copy the const.

**New, from RESEARCH Pattern 1 (no codebase analog for the outcome union):**
- `EmitOutcome = {kind:"stored"} | {kind:"refused", status, error} | {kind:"failed", status?, error}`. 202 → stored; 400-499 → refused; everything else, network error or timeout → failed. Never throws.
- Server truth: `packages/mcp-server/src/server.ts:330-358` (`/events` reply). 202/503 `stored`, 403 attribution, 400 `InvalidEventError`, 401 bearer (`:254-257`).
- An optional `{ url, token }` override argument. The Muse hook has no env, and the Cursor hook uses env.
- The refused line: one `appendFileSync(\`${stateDir}/refused-emits.jsonl\`, JSON.stringify({ts, collector, source, kind, surface, status, error: redact(error).slice(0, 200)}) + "\n")`. Never `summary` or `payload`. Name the helper `recordRefusal`, **not** `redact…` (Phase 18 lock rule 2). Write one stderr line too.
- Counters helper `{stored, refused, failed}`, with the journal summary rate-limited to once a minute (D19-05).

**Import line convention** (copy from `packages/collectors/src/grok-map.ts:9` and `acc30a8:…/herdr-map.ts:10-11`):
```ts
import { redact } from "../../mcp-server/src/redact.ts";
import type { EventInput } from "../../mcp-server/src/types.ts";
```

---

### `packages/collectors/src/emit.test.ts` (test)

**Analog:** `packages/cli/src/lessons.test.ts:72-73,90-99`. A real loopback server, not a fetch stub:
```ts
readonly server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => this.handle(request) });
readonly url = `http://127.0.0.1:${this.server.port}`;
...
if (request.headers.get("authorization") !== `Bearer ${this.token}`) {
	return Response.json({ error: "unknown or missing bearer token" }, { status: 401 });
}
```
Script per-test replies (202 / 400 / 401 / 403 / 500 / 503) the way `FakeSubstrate.rawReplies` does (`:66-67`). For "failed: network", point at a closed port. For "failed: timeout", use a handler that never resolves, with `timeoutMs: 50`. Assert that the refused line has exactly the key set `ts,collector,source,kind,surface,status,error`, and that `error` is ≤ 200 chars and redacted. Use a runtime-assembled decoy, as `acc30a8:…/cursor-stop.test.ts:15` does: ``const TOKEN = `ghp_${"a1B2c3D4e5".repeat(4)}`;``.

**Token in tests:** keep the value short (`tok-test`, `lessons.test.ts:59`). store-lock `TOKEN_LITERAL` (`packages/mcp-server/src/store-lock.test.ts:95`) fires on 16+ chars after `SUBSTRATE_TOKEN…[:=]`.

---

### `packages/collectors/src/git-context.ts` (utility)

**Analog:** `packages/collectors/src/grok.ts:47-61`. Copy verbatim, then export it:
```ts
/** owner/name for a working directory, or undefined when it is not a git repo. */
const repoCache = new Map<string, string | undefined>();
function repoFor(cwd: string): string | undefined {
	if (repoCache.has(cwd)) return repoCache.get(cwd);
	const result = spawnSync("git", ["-C", cwd, "remote", "get-url", "origin"], { encoding: "utf8" });
	const slug =
		result.status === 0 ? result.stdout.trim().match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/)?.[1] : undefined;
	repoCache.set(cwd, slug);
	return slug;
}

function branchFor(cwd: string): string | undefined {
	const result = spawnSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}
```
Same regex as `packages/cli/src/index.ts:52-57` (`repoSlug`). Export `repoSlug(cwd)` and `branchFor(cwd)`. Cache the slug per cwd; never cache the branch (RESEARCH Pattern 2). Unborn branch: `rev-parse` prints `HEAD` with a non-zero exit, so it yields `undefined` (Pitfall 13).

Where git paths matter (the writer's exclude file), copy `--git-path` from `packages/collectors/src/install-git-hook.ts:19-24`:
```ts
function hooksDir(repo: string): string | null {
	const result = spawnSync("git", ["-C", repo, "rev-parse", "--git-path", "hooks"], { encoding: "utf8" });
	if (result.status !== 0) return null;
	const relative = result.stdout.trim();
	return resolve(repo, relative);
}
```
Use the same call with `info/exclude` (Pitfall 9: in a worktree `.git` is a file).

---

### `packages/collectors/src/git-context.test.ts` (test)

**Analog:** `packages/mcp-server/src/git.test.ts:10-35`. Real repos, no spawn stubs:
```ts
function tempRepo(options: { commit?: string } = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "substrate-git-"));
	made.push(dir);
	const run = (args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
	run(["init", "--initial-branch=main"]);
	run(["config", "user.email", "test@example.invalid"]);
	run(["config", "user.name", "Substrate Test"]);
	if (options.commit !== undefined) { … run(["commit", "-m", options.commit]); }
	return dir;
}
afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });
```
Add `run(["remote", "add", "origin", url])` for the https, ssh, `.git` and no-origin cases.

---

### `packages/collectors/src/herdr-map.ts` (pure mapper, transform)

**Analog A, the file being ported:** `acc30a8:packages/collectors/src/herdr-map.ts`. Keep:
- the docblock style and imports (`:1-11`);
- the `HerdrPane` interface (`:31-38`). Extend it with `terminal_id`, `agent`, `agent_session`, `workspace_id`, `tab_id` (the verified `PaneInfo` fields, RESEARCH "Snapshot");
- the redacted `pane.output_matched` branch (`:89-98`). It becomes `herdr.other`, **without `repo`** (Pitfall 6):
```ts
case "pane.output_matched": {
	const matched = event.matched_line ?? event.output_matched ?? event.matched_text;
	const redacted = typeof matched === "string" ? redact(matched) : undefined;
	return { ...base, kind: "note",
		summary: redacted ? `pane ${paneId ?? "?"} matched: ${redacted}` : `pane ${paneId ?? "?"} output matched`,
		payload: { pane_id: paneId, matched: redacted } };
}
```
**Do not port:**
- `surface: "herdr"` (`:58`);
- the kinds `agent.detected` / `agent.status` / `agent.exited` (`:66,75,84`);
- `repoFor` returning a **path** (`:41-43`); use `git-context.repoSlug(cwd ?? foreground_cwd)`;
- the switch on dotted lifecycle names (`:63,81`), which never matched the wire (Pitfall 2).

**Analog B, the mapper module shape on main:** `packages/collectors/src/grok-map.ts`.
- Header docblock that explains the filter rationale (`:1-8`).
- Exported input/context interfaces (`:11-34`).
- A `DROPPED`-style explicit set (`:37-44`). Use it for the D19-10 **unmapped** id list: `copilot, devin, droid, kimi, kilo, qodercli, qwen, mastracode, antigravity_cli`.
- `mapX(...) : EventInput | null` where null is "not a failure" (`:46-58` docblock).

**New content (RESEARCH Pattern 3/4 + D19-10/11):**
- `HERDR_AGENT_SURFACES` (8 enum rows plus the separate `muse → muse` row).
- A wire-name normaliser table (`pane_created → pane.created`, …; dotted names pass through).
- `transitionToEvent(t)`. Payload `{runtime:"herdr", herdr_type, pane_id, agent, status?, previous_status?}`; `actor:"agent"`; `session_id: herdr:<terminal_id>:<started_at>`; summary `herdr: working → idle (pane w4:p1)`.

---

### `packages/collectors/src/herdr-map.test.ts` (test)

**Analog A:** `acc30a8:packages/collectors/src/herdr-map.test.ts:4-11,35-49`. The pane fixture and the redaction assertion carry over:
```ts
const event: HerdrEvent = { type: "pane.output_matched", pane_id: "w1:p1", matched_line: "auth token tskey-abc123def456" };
const out = mapHerdrEvent(event, pane);
expect(out?.summary).not.toContain("tskey-abc123def456");
expect(out?.summary).toContain("[REDACTED_TSKEY]");
```
Phase 18 lock rule 3 bans `"[REDACTED"` literals **outside tests only**. Tests may keep them, though importing `REDACTED` is cleaner.

**Analog B:** `packages/collectors/src/grok-map.test.ts:1-4`. The `describe` / `ctx` fixture layout.

**Analog C, planned on Phase 17 and not on main:** the `normalizeEvent` round trip over `EVENT_SOURCES` rows (17-01 tracer action: "asserting stored kind surface and payload equal the sample for each row"). RESEARCH Pattern 4 gives the exact test body to copy:
```ts
import { EVENT_SOURCES } from "../../mcp-server/src/event-sources.ts";
import { normalizeEvent } from "../../mcp-server/src/event.ts";
const row = (id: string) => { const found = EVENT_SOURCES.find((s) => s.id === id); if (!found) throw new Error(`no EVENT_SOURCES row ${id}`); return found; };
...
const stored = normalizeEvent(ev, null);
expect({ kind: stored.kind, runtime: ev.payload?.runtime, action: ev.payload?.action, repo: Boolean(ev.repo) })
	.toEqual({ kind: r.kind, runtime: r.runtime, action: r.actions?.[0], repo: r.carriesRepo });
```
`normalizeEvent(input, prev)` is on main at `packages/mcp-server/src/event.ts:124`. Keep the 17-id `IntegrationTarget` list as a literal array in the test. Fixtures: the verbatim probe lines in RESEARCH "Push envelopes as they actually arrive".

---

### `packages/collectors/src/herdr-state.ts` (pure reconciler + v2 state file)

**Analog:** `packages/collectors/src/grok.ts:28-45` (load and save) and `:121-127` (first sight starts at EOF):
```ts
function loadOffsets(): Offsets {
	try { return JSON.parse(readFileSync(STATE_FILE, "utf8")) as Offsets; } catch { return {}; }
}
function saveOffsets(offsets: Offsets): void {
	try {
		mkdirSync(dirname(STATE_FILE), { recursive: true });
		writeFileSync(STATE_FILE, JSON.stringify(offsets));
	} catch (cause) {
		process.stderr.write(`[grok-collector] cannot persist offsets: ${String(cause)}\n`);
	}
}
...
const known = offsets[log.path];
if (known === undefined) {
	// First sight: start at the end unless history was asked for.
	offsets[log.path] = backfill ? 0 : size;
	if (!backfill) continue;
}
```
Two changes:
1. Write with tmp + rename. Copy `packages/audit/src/log.ts:366-381`:
```ts
const temporary = `${target}.tmp`;
try {
	writeFileSync(temporary, `${JSON.stringify(checkpoint)}\n`);
	renameSync(temporary, target);
} catch {
	try { unlinkSync(temporary); } catch { /* … */ }
}
```
2. A file without `version: 2` (September's `{lastSignature}`, `acc30a8:…/herdr.ts:83-94`) or a missing file counts as a first run: seed silently and emit nothing.

The transition table, the `unknown` rule (`raw_status` vs. emitted `status`), "advance on stored|refused, never on failed", and the identity `${pane_id}|${terminal_id}` are specified in RESEARCH Pattern 3. No codebase analog exists for the diff itself.

---

### `packages/collectors/src/herdr.ts` (long-running collector, event-driven)

**Analog:** `acc30a8:packages/collectors/src/herdr.ts`. Port these blocks:
- **Socket resolution** (`:55-67`). Keeps D19-13's order; `--session` wins:
```ts
function socketPath(): string {
	const sessionIdx = args.indexOf("--session");
	const sessionArg = sessionIdx >= 0 ? args[sessionIdx + 1] : undefined;
	if (sessionArg) return `${HOME}/.config/herdr/sessions/${sessionArg}/herdr.sock`;
	if (process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH;
	if (process.env.HERDR_SESSION) return `${HOME}/.config/herdr/sessions/${process.env.HERDR_SESSION}/herdr.sock`;
	return `${HOME}/.config/herdr/herdr.sock`;
}
```
- **String ids** (`:69-74`): `substrate:herdr:${seq}`.
- **ND-JSON line reader** (`:132-144`, `makeLineReader`).
- **One-shot `call()` on a fresh connection** (`:146-190`). RESEARCH recommends `Promise.withResolvers()` over the executor form. Copy the precedent from Phase 16 `scripts/rehearsal.ts:228-239` (`pickFreePort`):
```ts
export function pickFreePort(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const srv = createServer();
	srv.once("error", reject);
	...
```
- **`fetchPanes()`** (`:196-203`).
- **Per-pane connection isolation** (`:256-310`). Keep: the error reply → destroy only that socket; the `close` → delete only if it is still the same socket. Change the subscriptions (`:272-279`) to **only** `[{type:"pane.agent_status_changed", pane_id}]`. Error replies carry a suffixed id (`<id>:sub:0:probe`), so treat any `error` on a subscribe connection as fatal for that connection.

New pieces with no direct analog:
- **Global connection**, one `events.subscribe` with `pane.created`, `pane.closed`, `pane.exited`, `pane.agent_detected`.
- **Debounce (~150 ms) and single-flight** snapshot → reconcile → emit.
- **Per-pane connections** opened and closed only inside a reconcile pass. This replaces September's `reconnectPane` (`:249-254`), which re-fetched the snapshot on every error.

**Do not port:**
- the top-level side effects at import (`:336-357`). Wrap them in `if (import.meta.main)`, as `acc30a8:…/muse.ts:180` and `packages/projector/src/swarm-workspace.ts:587` do;
- the local `emit()` (`:105-121`); use `emit.ts`;
- `lastSignature` (`:76-103`);
- the `"."` `output_matched` subscription (D19-12).

**Loop shape:** `packages/collectors/src/grok.ts:173-189`:
```ts
const args = process.argv.slice(2);
const watch = args.includes("--watch");
const offsets = loadOffsets();
const first = await pass(offsets, backfill);
process.stdout.write(`[grok-collector] read ${first.read} lines, emitted ${first.emitted}\n`);
if (watch) {
	process.stdout.write(`[grok-collector] watching ${SESSIONS_DIR} every ${POLL_MS}ms\n`);
	for (;;) { await new Promise((resolve) => setTimeout(resolve, POLL_MS)); … }
}
```
Log prefix convention: `[herdr-collector] …` on stderr for errors (September `:101,199,291`).

---

### `packages/collectors/src/herdr.test.ts` (optional transport test)

**Partial analog:** Phase 16 `scripts/rehearsal.ts:228-251` (`node:net createServer` + `withResolvers`). Listen on a tmp **Unix socket path** instead of a TCP port 0, and answer ND-JSON. No existing repo test fakes an ND-JSON Unix socket; build it from RESEARCH's verified envelopes.

---

### `packages/collectors/src/muse.ts` (brief writer)

**Analog:** `acc30a8:packages/collectors/src/muse.ts`. Port these:
- Header docblock (`:1-19`): the `SUBSTRATE_MUSE_REPOS` blast-radius rationale. Keep it.
- Markers and pointer block (`:30-41`). Verbatim; identical to `AGENTS.md:1-5` on main:
```ts
export const MARKER_START = "<!-- substrate-brief:start -->";
export const MARKER_END = "<!-- substrate-brief:end -->";
function pointerBlock(): string {
	return [MARKER_START,
		"Read `.substrate/BRIEF.md` at the start of your work in this repo. It is",
		"the current substrate brief — a record of what other agents did here.",
		"Substrate writes this file on a schedule; do not edit it by hand.",
		MARKER_END].join("\n");
}
```
- `fetchBrief` (`:49-67`): "2xx and non-empty or null". Read env at call time (not the `:26` const). Send `repo: <slug>`, not the path.
- The separator rule for appending (`:129-130`): `existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n"`.
- `usage()` / `import.meta.main` / `POLL_MS = 5 * 60 * 1000` (`:27-28,168-198`).

**Change:**
- `writeBrief` (`:90-100`) → tmp + rename (`wx` tmp) and skip when the bytes are equal.
- `ensurePointer` (`:107-139`) → the multi-block collapse. Orphan marker → untouched, plus a counter (RESEARCH Pattern 5, Pitfall 10).
- `deliverTo` (`:142-166`) → no `brief.delivered` emit (`:151-158` removed; silent `muse.brief_writer`). Resolve the slug through `git-context`; no slug → `no_slug`.
- Add `GET /healthz` once per pass (D19-15). `greptime !== true` → `fetch_failed` (`ledger_unavailable`). The server field is at `packages/mcp-server/src/server.ts:61-67,260-262`. Write the word `greptime` in lowercase only (store-lock bans `GREPTIME_`, `store-lock.test.ts:124-130`).
- Add the `.substrate/` exclude through `--git-path info/exclude` (see the git-context section).
- Counters in `SUBSTRATE_COLLECTOR_STATE` (default `${SUBSTRATE_STATE_DIR:-/var/lib/substrate}/muse-offsets.json`).

---

### `packages/collectors/src/muse.test.ts` (test)

**Analog:** `acc30a8:packages/collectors/src/muse.test.ts`.
- **Fetch stub** (`:9,15-18,26-41`). Keep its restore-in-`afterEach` discipline:
```ts
const originalFetch = globalThis.fetch;
afterEach(() => { rmSync(tmpRepo, { recursive: true, force: true }); globalThis.fetch = originalFetch; });
function stubFetch({ briefText = "stub brief" }: StubOptions = {}): Array<Record<string, unknown>> {
	const events: Array<Record<string, unknown>> = [];
	globalThis.fetch = (async (input, init) => {
		const href = String(input);
		if (href.endsWith("/brief")) { if (briefText === null) return new Response("", { status: 500 }); return new Response(briefText, { status: 200 }); }
		if (href.endsWith("/events")) { events.push(JSON.parse(String(init?.body ?? "{}"))); return new Response(…, { status: 202 }); }
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
	return events;
}
```
  Add a `/healthz` route. Repurpose the `/events` capture to assert **zero** event calls ever (Tests 5/5b at `:91-108` invert).
- **Marker counting** (`:64-66`): `agents.split(MARKER_START).length - 1`.
- **Byte-identical-after-failure** test (`:82-89`).
- **Redaction-equality** test (`:110-119`): `expect(written).toBe(redact(raw))`.

Repos must now be real git repos with an origin, so use `tempRepo` from `packages/mcp-server/src/git.test.ts:18-31` plus `remote add origin`. Add worktree and normal-repo exclude cases.

---

### `packages/collectors/src/cursor-stop.ts` (hook)

**Analog:** `acc30a8:packages/collectors/src/cursor-stop.ts`, ported almost verbatim:
- header contract (`:1-17`);
- constants (`:23-29`);
- `parseStopInput` with BOM strip (`:53-61`);
- `safeConversationId` (`:63-66`);
- realpath containment `resolveTranscript` (`:68-92`);
- `copyTranscript` with 0700/0600 + tmp + rename (`:103-131`);
- `runStop` with a "hook error" fallback event and a swallowed emit (`:137-183`);
- bounded `readStdin` (`:197-210`);
- the `import.meta.main` exit-0 block (`:212-220`):
```ts
if (import.meta.main) {
	try {
		const raw = await readStdin(STDIN_TIMEOUT_MS);
		await runStop(raw, { emit: postEvent });
	} catch {
		// Fail open.
	}
	process.exit(0);
}
```
**Changes:**
- Delete the local `postEvent` (`:185-195`) and inject `emit.ts`'s `postEvent` with a 1.5 s timeout and refused counting (`collector: "cursor-stop"`, `source: "cursor.stop"`).
- `root = process.env.SUBSTRATE_CURSOR_ROOT ?? CURSOR_ROOT` and `destDir = process.env.SUBSTRATE_TRANSCRIPTS_DIR ?? TRANSCRIPTS_DIR`, read in `main`, not in module consts, so tests can vary them.
- Recommended hardening (Security Domain): open the realpath with `O_RDONLY|O_NOFOLLOW` and `fstat` the fd instead of `statSync` + `readFileSync` (`:113-114`), and write the tmp with `flag: "wx"` (`:123`).
- `StopDeps.emit` (`:46`) stays an injection seam, so the tests keep their `recorder()`.

---

### `packages/collectors/src/cursor-stop.test.ts` (test)

**Analog:** `acc30a8:packages/collectors/src/cursor-stop.test.ts`. Port all of it:
- `realpathSync(mkdtempSync(...))` root (`:23-34`);
- the runtime-assembled `TOKEN` (`:15`);
- `recorder()` (`:42-45`);
- the symlink-out refusal (`:88-94`);
- mode checks (`:105-106`);
- the stdout capture (`:171-190`):
```ts
const writes: unknown[] = [];
const original = process.stdout.write;
process.stdout.write = ((chunk: unknown) => { writes.push(chunk); return true; }) as typeof process.stdout.write;
try { … } finally { process.stdout.write = original; }
expect(writes).toEqual([]);
```
Add the env-override cases and a refused-line case. The refused case runs against a `Bun.serve` stub returning 400 (the `emit.test.ts` pattern).

---

### `packages/collectors/src/status.ts` (`collectors:status`, read-only report)

**Analog, not on main:** Phase 16 `scripts/parity-check.ts`:
- a pure verdict function, `export function parityVerdict(facts, opts)` (`:128`);
- `export async function main(argv)` (`:262`) handling `--json` (`:272`) and a usage line (`:258,264`);
- `if (import.meta.main) process.exit(await main(process.argv.slice(2)));` (`:425`).

Mirror it as `summarize(stateFiles, refusedLines, since)` plus a thin `main`, with `--since <iso>`, `--state-dir <dir>` and `--json`. It reads `.counters` from `herdr-offsets.json`, `muse-offsets.json` and grok's state file (the reserved `counters` key, Pitfall 11), and `refused-emits.jsonl` lines with `ts >= since`, skipping lines it cannot parse.

---

### `packages/collectors/src/grok.ts` (modified)

**Self-analog.**
- Replace `emit` (`:94-109`) and the `if (await emit(event)) emitted++` call (`:165`) with `postEvent(event, { timeoutMs: 3000, collector: "grok", source: <grok row id> })`, and count its outcome.
- Remove the `SUBSTRATE_URL` const (`:25`).
- Keep the counters under a reserved `counters` key in the same state file. `loadOffsets` (`:30-36`) must skip non-number values, and `pass()` indexes only `offsets[log.path]`, so the key is inert to it (Pitfall 11).
- Optionally swap `repoFor`/`branchFor` (`:47-61`) for `git-context`. D19-04 says "nothing else in grok changes", so this is the planner's call. Prefer importing, to avoid a second regex copy.

---

### `packages/projector/src/muse.ts` (bundle generator + Muse CLI driver)

**Analog:** `acc30a8:packages/projector/src/muse.ts`. Port these:
- the header (`:1-21`);
- the env-named constants (`:26-32`), **minus** `REDACT_MODULE` (`:28-29`; D19-19 removes `SUBSTRATE_REDACT_MODULE`);
- the manifest (`:34-56`), verbatim; it validates clean;
- the string-array template (`:58-63`), using the same "literal source lines, not one template literal" technique;
- `writeBundle` (`:129-134`);
- `runMuse` / `fail` (`:136-150`):
```ts
function runMuse(args: string[]): MuseResult {
	const result = spawnSync(MUSE_BIN, args, { encoding: "utf8" });
	return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
function fail(step: string, result: MuseResult): never {
	process.stderr.write(`[muse-projector] ${step} failed:\n${result.stdout || result.stderr}\n`);
	process.exit(1);
}
```
- `installedPluginIds` from `list --json` (`:152-164`);
- the validate gate (`:168-176`): `valid !== true || diagnostics.length > 0` → fail;
- install-or-update then approve (`:178-185`).

**Template changes (D19-18, RESEARCH Pattern 7):**
- The import line becomes `'import { redact, redactValue } from "./redact.ts";'`. The Phase 18 anchored regex ignores imports inside string literals (18-RESEARCH Pattern 5 / `:411`), so no exemption is expected. Run the lock to confirm.
- Remove `process.env.SUBSTRATE_URL` / `SUBSTRATE_TOKEN` (`:75,104`). The hook reads `new URL("./substrate.json", import.meta.url)` and the `SUBSTRATE_TOKEN=` line of `cfg.tokenFile`.
- `repoContext()` (`:84-90`) changes from `--show-toplevel` to the origin regex inline (`git -C cwd remote get-url origin`).
- Payload `redactValue({ tool, tool_use_id?, outcome?, duration_ms? })`, not `tool_name` (`:114`).
- Timeout 1.5 s, not 3000 (`:116`).
- 4xx → `appendFileSync(cfg.stateDir + "/refused-emits.jsonl", …)`.
- Bounded stdin (copy `cursor-stop.ts:197-210`, not `:77-81`'s unbounded `for await`).
- No `redact*` function definitions inside the template (lock rule 2's `function` regex is unanchored).

**New:**
- `hooks/redact.ts` = header (`// Generated … from packages/mcp-server/src/redact.ts — commit <git log -1 --format=%H -- that path>, sha256 <h>`) + exact source bytes. Assert at projection time that the source has no `import`/`require` lines (main's `redact.ts` exports only `REDACTED` `:13`, `redact` `:53`, `redactValue` `:98`).
- `hooks/substrate.json` = `{url, tokenFile, stateDir}`, never a value.
- `--check` / `--bundle-only`: copy the mode convention from `packages/projector/src/swarm-workspace.ts:560-576` (exactly one mode flag; `--check` returns 1 on pending drift, 0 when current; `ProjectionRefused` → exit 2 with `[projector] refused: …`). Compute the sha256 with `Bun.CryptoHasher` as in `packages/mcp-server/src/event.ts:25-27`:
```ts
export function sha256Hex(input: string): string {
	return new Bun.CryptoHasher("sha256").update(input).digest("hex");
}
```
- Wrap the top-level flow (September `:166-189` runs at import) in `main()` + `if (import.meta.main)`, so the test can import `buildBundle()`-style pure helpers.

---

### `packages/projector/src/muse.test.ts` (test)

**Analog:** `packages/projector/src/swarm-workspace.test.ts:1-45`.
```ts
const CLI = join(import.meta.dir, "swarm-workspace.ts");
/** What a real token would be: if the projector ever expanded the environment, this is the string that would leak. */
const SENTINEL = "p14-sentinel-token-7f3a9c";
...
function run(...args: string[]): { code: number; out: string; err: string } {
	const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
		env: { ...process.env, SUBSTRATE_URL: "http://127.0.0.1:7499", SUBSTRATE_TOKEN: SENTINEL, … },
	});
	return { code: proc.exitCode ?? -1, out: proc.stdout.toString(), err: proc.stderr.toString() };
}
```
Note the store-lock passes here because the value is an identifier (`SENTINEL`), not a 16+ char literal after the key. Use it to assert the sentinel appears in **no** bundle file (the "projector refuses to put any token value into the bundle" rule). Point `MUSE_BIN` at a tmp stub script, so `validate`/`install`/`approve` record their argv. Spawn the generated hook with `bun` against a `Bun.serve` stub (see `emit.test.ts`); the async-spawn caveat is in `packages/mcp-server/src/http.test.ts:348-370`. Use `Bun.spawn`, not `spawnSync`, when the stub server lives in the test process.

---

### `packages/projector/src/cursor.ts` (modified)

**Analog:** `acc30a8:packages/projector/src/cursor.ts:16-27,50-70`. It is the full +23-line diff over main:
```ts
const STOP_SCRIPT =
	process.env.SUBSTRATE_CURSOR_STOP ?? "/root/src/repos/agent-substrate/packages/collectors/src/cursor-stop.ts";
...
/** A hook that runs a script directly, stdin inherited; same `|| true` rule. */
function script(path: string): HookEntry {
	return { type: "command", command: `bun ${path} >/dev/null 2>&1 || true`, "substrate-managed": true };
}
const DESIRED: Record<string, HookEntry> = {
	sessionStart: command("brief --surface cursor --write"),
	postToolUse: command("emit --kind tool.call --summary 'cursor tool call' --surface cursor --actor human"),
	stop: script(STOP_SCRIPT),
};
const args = process.argv.slice(2);
if (args.includes("--print-desired")) {
	process.stdout.write(`${JSON.stringify(DESIRED, null, 2)}\n`);
	process.exit(0);
}
```
Main's `cursor.ts:46-51` (`stop: command("emit --kind session.end …")`) is what gets replaced. `STOP_SCRIPT` sits beside `CLI` (main `:19`). Everything else on main (`:53-110`, the merge loop, `--check` exit 1, `--remove`, `.substrate-backup`) stays byte-identical.

### `packages/projector/src/cursor.test.ts` (new)

**Analog:** `packages/projector/src/swarm-workspace.test.ts:17-41` (spawn the CLI with `process.execPath`). Cases:
- `--print-desired`'s `stop.command` equals the live string `bun /root/src/repos/agent-substrate/packages/collectors/src/cursor-stop.ts >/dev/null 2>&1 || true`;
- `--check --path <tmp copy of a fixture equal to live>` prints `already current` and exits 0;
- a stale `stop` entry makes `--check` exit 1 with `would change: ~ stop`.

---

### `infra/vps/substrate-collector-{herdr,muse}.service` (systemd units)

**Analog:** `acc30a8:infra/vps/substrate-collector-herdr.service` and `-muse.service`, which are byte-identical to the installed copies. The structure is shared with main's `infra/vps/substrate-collector-grok.service`:
```ini
[Service]
Type=simple
EnvironmentFile=/etc/substrate/substrate.env
WorkingDirectory=/root/src/repos/agent-substrate
# Machine-specific: `command -v bun`.
ExecStart=/root/.local/share/reflex/bun/bin/bun packages/collectors/src/herdr.ts --watch
Restart=always
RestartSec=5

# Per-pane last-emitted signatures, so a restart never re-emits an unchanged
# output_matched replay.
StateDirectory=substrate
Environment=SUBSTRATE_COLLECTOR_STATE=/var/lib/substrate/herdr-offsets.json
```
The D19-23 deltas, and nothing else:
1. `EnvironmentFile=-/etc/substrate/substrate-collector-<name>.env` on the line **after** `EnvironmentFile=/etc/substrate/substrate.env`.
2. `Environment=SUBSTRATE_STATE_DIR=/var/lib/substrate` beside `SUBSTRATE_COLLECTOR_STATE`.
3. Corrected comments. herdr: "v2 per-pane state (agent, status, session id) so a restart emits nothing for unchanged panes". Muse: replace "Byte offsets per session log…" with "per-repo last success/failure and counters".

Keep `ExecStart`, `WorkingDirectory`, `SyslogIdentifier`, the hardening block (`NoNewPrivileges` … `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`) and `[Install]` exact. Do not touch `substrate-collector-grok.service`. Verify with `systemd-analyze verify`.

---

### `scripts/laneb-proof.ts` (isolated e2e proof)

**Analog, not on main:** Phase 16 `scripts/rehearsal.ts`. **Import, do not copy** (RESEARCH "Don't Hand-Roll"). Exports `refuseSmokeUrl` (`:868`), `parseShellExports` (`:884`), `runDirFor` (`:193`), `parseName` (`:91`), `flag` (`:1047`), `pickFreePort` (`:228`), `PRODUCTION_PORTS` (`:47`). The module is import-safe (`if (import.meta.main)` at `:1098`).

The guard-then-read sequence to mirror, from `runSmoke` (`:978-993`):
```ts
const runDir = runDirFor(name);
const text = readText(join(runDir, "consumer.env"));
if (text === null) throw new RehearsalRefused(`no consumer.env for instance ${name}: run rehearsal up first`);
const record = parseShellExports(text);
const base = (record["SUBSTRATE_URL"] ?? "").replace(/\/+$/, "");
const tok = record["SUBSTRATE_TOKEN"] ?? "";
if (!base) throw new RehearsalRefused(`consumer.env for ${name} has no twin url`);
const refused = refuseSmokeUrl(base);
if (refused !== null) throw new RehearsalRefused(refused);
const boot = await smokeCall(base, tok, "/healthz");
```
The per-check output idiom (`:996-1000`) and the final tally (`:1038-1040`):
```ts
const results: boolean[] = [];
const check = (ok: boolean, what: string, detail?: string): void => {
	results.push(ok);
	process.stdout.write(`${ok ? "  ok  " : " FAIL "} ${what}${detail ? ` — ${detail}` : ""}\n`);
};
...
process.stdout.write(`\n${passed}/${results.length} smoke checks passed\n`);
return passed === results.length ? 0 : 1;
```
- **Exit codes** (Phase 16 `docs/rehearsal.md` "Exits"): `0` pass, `1` failed, `2` usage or refused, before any request.
- **Token key names:** `SUBSTRATE_URL`, `SUBSTRATE_TOKEN`, `SUBSTRATE_REHEARSAL_TOKENS_DIR`, `SUBSTRATE_REHEARSAL_NAME`, `SUBSTRATE_TEST_PG_URL` (Phase 16 `packages/mcp-server/src/rehearsal-env.ts:196-207`).
- **Per-surface token files:** `<runDir>/tokens/<surface>`, holding the token plus `\n` (`rehearsal.ts:573-577`). Read `tokens/muse` for the hook's token file.
- **Short local for the token:** `tok`, as Phase 16 does. Phase 16's `rehearsal-env.ts:197-199` comment explains why.
- **Child processes:** spawn with `Bun.spawn` and an **explicit** env; never `...process.env` (it leaks `HERDR_*`; Pitfall 5).
- **Run tag:** `rh-p19-<tag>`, the Phase 16 `rh-` prefix (`rehearsal.ts:995`).
- **Step order:** RESEARCH Pattern 11, steps 1-13.

**Second analog, planned, not on disk:** Phase 17 `scripts/vocabulary-smoke.ts` (17-03 Task 2). It has the same consumer.env → refuse → post → read-back shape and was planned with local `parseConsumerEnv`/`refuseTarget` helpers. Prefer Phase 16's exported ones. If Phase 17 merged its own copies, reuse whichever main holds, rather than adding a third.

---

### `package.json` (modified)

**Analog, not on main:** the Phase 16 diff:
```json
"smoke:chaos": "bun scripts/chaos-smoke.ts",
"parity:check": "bun scripts/parity-check.ts",
"rehearsal": "bun scripts/rehearsal.ts"
```
Add `"proof:laneb": "bun scripts/laneb-proof.ts"` and `"collectors:status": "bun packages/collectors/src/status.ts"` (or the `scripts/` path). Re-read main's `scripts` block at execution time, because Phase 17 adds `check:phase-close` and `smoke:vocabulary`.

---

### `docs/collectors.md` (topic doc)

**Analogs:** `docs/swarm-correlation.md:1-25` (H1, purpose paragraph linking the ADR or phase, then `## Section` with `| --- |` tables) and Phase 16 `docs/rehearsal.md:113-128` (the "consumer contract" key/value table).
```md
## The consumer contract

Every later proof sources `consumer.env` and hardcodes nothing:

| Key | Value |
| --- | --- |
| `SUBSTRATE_URL` | The twin's loopback URL |
```
Planned sections (D19-25):
- each collector's rows, linking `docs/event-vocabulary.md`;
- env vars by **name** only;
- state files;
- `refused-emits.jsonl` and `collectors:status`;
- the herdr agent table;
- the Muse stable path and `substrate.json`;
- the Cursor guards;
- recorded gaps: the `/brief` 200-while-degraded race and PostToolUse firing on success only.

### `docs/runbooks/lane-b-collectors.md` (runbook)

**Analog, not on main:** Phase 16 `docs/runbooks/production-parity.md`. Copy:
- the header key/value table (`:3-9`: Requirement, Window, Last known-good commit, Scope, Untouched);
- `## Operator step: installing the repo unit` (`:145-162`): back the installed unit up outside the repo, `cp infra/vps/… /etc/systemd/system/…`, `systemctl daemon-reload`, restart, then a read-only check;
- `## Rollback` (`:164-185`): numbered, operator only; check out the last known-good commit, restart, re-run the check;
- `## Who does what` (`:210-`).
```sh
# back the installed unit up outside the repo, then install the repo file
cp /etc/systemd/system/substrate-mcp.service /root/substrate-mcp.service.bak-<date>
cp infra/vps/substrate-mcp.service /etc/systemd/system/substrate-mcp.service
systemctl daemon-reload
systemctl restart substrate-mcp
bun run parity:check --json
```
For Phase 19, the read-only checks are `bun packages/projector/src/muse.ts --check`, `bun packages/projector/src/cursor.ts --check` and `bun run collectors:status`. `docs/runbooks/` does not exist on main until Phase 16 merges.

### `docs/event-vocabulary.md` and `packages/mcp-server/src/event-sources.ts` (modified)

**Analog: planned only** (Phase 17, 17-01 tracer and Task 3).
- **Row:** `herdr.pane_exited`, phase 19, `session.end`, surface `herdr-agent`, runtime `herdr`, **"without repo"**. Amend `carriesRepo: true`, add `repo` to its sample, and change the doc cell (D19-11, Pitfall 6).
- **Doc table:** wrapped in `event-sources` start/end HTML comment markers (same style as `AGENTS.md:1-5`). Columns `id phase kind surface action runtime repo periodic`. `event-sources.test.ts` parses it, so the doc and the table change in the same commit.
- **herdr agent table:** replace it with the pinned D19-10 table, dropping `[UNVERIFIED]`.

Re-read the merged files before editing; field names are assumption A6.

### `README.md` (modified)

**Analog:** `README.md:71` (Layout line `packages/collectors/     Orca tee, grok/muse tails, git hook  (TS)`) and the link idiom at `:33-34`, `:148-149`: ``Details in [`docs/x.md`](docs/x.md).`` Add one `docs/collectors.md` link. Optionally correct the Layout line to "grok/herdr/muse collectors, cursor stop hook, git hook".

---

## Shared Patterns

### Fail-open hook contract
**Source:** `acc30a8:packages/collectors/src/cursor-stop.ts:14-16,197-220`; `packages/cli/src/index.ts:14-22`.
**Apply to:** `cursor-stop.ts`, the generated Muse hook, and every emit path.
- Always exit 0. Print nothing on stdout (Cursor auto-submits a `followup_message`). Bound the stdin read with a timer race. Swallow emit rejections.
- Long-running collectors log `[<name>-collector] …` to stderr and never `process.exit(1)` on a substrate outage.

### `import.meta.main` guard on every CLI module
**Source:** `acc30a8:packages/collectors/src/muse.ts:180`, `cursor-stop.ts:212`, `packages/projector/src/swarm-workspace.ts:587`, Phase 16 `scripts/rehearsal.ts:1098`.
**Apply to:** `herdr.ts`, `muse.ts` (both), `cursor-stop.ts`, `status.ts`, `laneb-proof.ts`, and `projector/src/muse.ts`. Never `grok.ts`-style top-level work in an importable module. Main's `projector/src/cursor.ts` is also top-level; leave it, since nothing imports it and its test spawns it.

### Env read at call time, not module load
**Source:** `packages/cli/src/index.ts:33-40` (functions `base()`/`headers()`); counter-example `grok.ts:25`, `acc30a8:…/herdr.ts:48`, `acc30a8:…/muse.ts:26`.
**Apply to:** `emit.ts`, `muse.ts` (writer), and the path overrides in `cursor-stop.ts`. Tests and the proof vary env per call.

### Atomic writes (tmp + rename)
**Source:** `packages/audit/src/log.ts:366-381`; `acc30a8:packages/collectors/src/cursor-stop.ts:119-129` (0700 dir, 0600 tmp, `rmSync(tmp)` on failure).
**Apply to:** the herdr v2 state, the muse writer state, `BRIEF.md`, `AGENTS.md`, the transcript copy, and the grok state with counters. Use a `wx` tmp flag where a pre-existing tmp would be a race (Security Domain).

### Redaction: one source
**Source:** `packages/mcp-server/src/redact.ts:13,53,98` (`REDACTED`, `redact`, `redactValue`); after Phase 18 merges, the same file with named rules.
**Apply to:** every collector and the hook (via the bundled byte copy).
- Import with the relative specifier `../../mcp-server/src/redact.ts`.
- Phase 18 lock rules (18-RESEARCH Pattern 5): no `redact*`/`*Redactor`/`scan*Secret*` definitions outside `redact.ts` (rule 2); no `"[REDACTED"` literal in non-test sources (rule 3); imports must resolve to `packages/mcp-server/src/redact.ts` (rule 1).
- Name local helpers `recordRefusal`, `sanitizeError` and similar.

### store-lock compatibility
**Source:** `packages/mcp-server/src/store-lock.test.ts:95` (`TOKEN_LITERAL`), `:124-130` (`GREPTIME_`).
**Apply to:** all new `.ts` files, especially `laneb-proof.ts`, tests, and the projector.
- Hold tokens in short locals (`tok`), or as identifiers rather than 16+ char literals after a `SUBSTRATE_TOKEN…` key.
- Never write the uppercase `GREPTIME_` prefix outside `packages/mcp-server/src`.

### Runtime-assembled secret fixtures
**Source:** `acc30a8:packages/collectors/src/cursor-stop.test.ts:15` (``const TOKEN = `ghp_${"a1B2c3D4e5".repeat(4)}`;``); Phase 16 `scripts/rehearsal.test.ts:34` (`SENTINEL`); `packages/projector/src/swarm-workspace.test.ts:19`.
**Apply to:** the emit, muse, cursor-stop and projector tests, and the proof's decoy transcript. No literal token shape in git (Greptile and store-lock scans).

### Unit state conventions
**Source:** `infra/vps/substrate-collector-grok.service` (main) and the `acc30a8` herdr/muse units.
**Apply to:** both new units.
- `StateDirectory=substrate`.
- `Environment=SUBSTRATE_COLLECTOR_STATE=/var/lib/substrate/<name>-offsets.json`.
- Journal output with a `SyslogIdentifier`.
- The identical hardening block.

### Proof isolation (no production touch)
**Source:** Phase 16 `scripts/rehearsal.ts:47` (`PRODUCTION_PORTS = [7410, 7411, 6420]`), `:868-881` (`refuseSmokeUrl`), and the runbook's "Who does what".
**Apply to:** `laneb-proof.ts`, and any test that spawns a hook or a collector.
- Refuse before the first request.
- Explicit child env.
- `herdr --session substrate-proof-<tag>` only; strip `HERDR_*`.
- Scratch Muse `HOME`, `XDG_*` unset, `MUSE_NO_AUTO_UPDATE=1`.
- Teardown in `finally`.

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `packages/collectors/src/herdr.test.ts` (fake herdr ND-JSON server on a tmp Unix socket) | test | event-driven | No repo test fakes a Unix-socket ND-JSON peer. The closest is Phase 16's `node:net createServer` in `pickFreePort` (`scripts/rehearsal.ts:228-239`). Build it from RESEARCH's verified envelopes (subscribe ack, error with suffixed id, push lines). |

Partial or new logic inside files that do have analogs (use RESEARCH, not the codebase):
- the herdr reconcile transition table and the `unknown` rule (RESEARCH Pattern 3);
- the herdr debounce / single-flight;
- the `EmitOutcome` classification;
- the `AGENTS.md` multi-block collapse with orphan detection (Pattern 5);
- the Muse `--check` sha comparison against `list --json` `.record.cache_path` (Pattern 6);
- the Muse hook's `substrate.json` + token-file read (Pattern 7).

## Metadata

**Analog search scope:**
- `packages/{collectors,projector,cli,audit,mcp-server}/src`, `infra/vps`, `docs`, `README.md`, `package.json` on the p19 worktree (main `ab62c91`);
- `git show acc30a8:` for `packages/collectors/src/{herdr,herdr-map,herdr-map.test,muse,muse.test,cursor-stop,cursor-stop.test}.ts`, `packages/projector/src/{muse,cursor}.ts` and `infra/vps/substrate-collector-{herdr,muse}.service`;
- the Phase 16 worktree: `scripts/{rehearsal,rehearsal.test,parity-check}.ts`, `packages/mcp-server/src/rehearsal-env.ts`, `docs/rehearsal.md`, `docs/runbooks/production-parity.md`, `package.json` diff;
- the Phase 17 and 18 worktrees: plans and research only (no code exists).

**Files scanned:** 34.
**Pattern extraction date:** 2026-10-08.
