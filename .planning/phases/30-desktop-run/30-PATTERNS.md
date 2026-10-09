# Phase 30: desktop_run - Pattern Map

**Mapped:** 2026-10-08
**Files analyzed:** 33 new or modified files (plus the planning artifact `30-N1-SPIKE.md`)
**Analogs found:** 30 / 33 have a usable analog. Three have only a partial one: the PATH-stub script test, the SDK-client smoke transport, and the pixel-band/PNG-decode helpers.

Path conventions used below:
- **main** = this worktree `/root/src/worktrees/agent-substrate-v13-p30` (HEAD `6624628`). Line numbers are from this worktree.
- **acc30a8:** = `git -C /root/src/worktrees/agent-substrate-v13-p30 show acc30a8:<path>`, the September port source. Copy it with `git show`. Do not retype it.
- **P16** = `/root/src/worktrees/agent-substrate-v13-phase` (HEAD `39072ac`), **P17** = `/root/src/worktrees/agent-substrate-v13-p17` (HEAD `b9047e7`), **P18** = `…-p18`, **P21** = `…-p21`. Files there are git-tracked on those branches but **not on main**. Each one is marked *exists after Phase N merges*, and its line numbers will shift after the rebase. Re-anchor by symbol.
- Every analog path named here is git-tracked source (checked with `git ls-files`). None is a gitignored mirror.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `packages/mcp-server/src/desktop/actions.ts` (new) | utility (schema + argv builders) | transform | `acc30a8:packages/mcp-server/src/desktop/actions.ts` | exact (verbatim port) |
| `packages/mcp-server/src/desktop/actions.test.ts` (new) | test | transform | `acc30a8:…/desktop/actions.test.ts` | exact (verbatim port) |
| `packages/mcp-server/src/desktop/png.ts` (new, discretion split) | utility (codec) | transform | `acc30a8:…/desktop/driver.ts:69-171` (+ RESEARCH `decodePng`) | exact for encode/XWD; decodePng has no repo analog |
| `packages/mcp-server/src/desktop/png.test.ts` (new) | test | transform | `acc30a8:…/desktop/driver.test.ts:36-122` | exact |
| `packages/mcp-server/src/desktop/driver.ts` (new) | service (executor) | subprocess + file-I/O + event-driven | `acc30a8:…/desktop/driver.ts:1-359` | exact, with the listed changes |
| `packages/mcp-server/src/desktop/driver.test.ts` (new) | test | subprocess (fake runner) | `acc30a8:…/desktop/driver.test.ts:1-346` | exact, with the listed changes |
| `packages/mcp-server/src/desktop/tool.test.ts` (new) | test (MCP integration) | request-response | main `mcp.test.ts:18-56`, `graph-bind.test.ts:289-293` | role-match |
| `packages/mcp-server/src/desktop/config.test.ts` (new; or new cases in `authority.test.ts`) | test | transform | main `authority.test.ts:66-90,245-271` | exact |
| `packages/mcp-server/src/mcp.ts` (mod) | controller (MCP tool) | request-response | main `mcp.ts:298-310,331-370`; `acc30a8:mcp.ts:178-204` | exact |
| `packages/mcp-server/src/service.ts` (mod) | service | request-response + event | main `service.ts:459-475,547-593`; `acc30a8:service.ts:90-113,191-197` | exact |
| `packages/mcp-server/src/config.ts` (mod) | config | transform | main `config.ts:99,153-191,323-333` | exact |
| `packages/mcp-server/src/observe.ts` (mod) | registry | — | main `observe.ts:309-342` | exact |
| `packages/mcp-server/src/index.ts` (mod) | entry/wiring | — | main `index.ts:11-26` | exact |
| `packages/mcp-server/src/http.test.ts` (mod, new describe) | test (real HTTP gate) | request-response | main `http.test.ts:31-73,193-241`; `server.authority.test.ts:108-125,291-298` | exact |
| `packages/mcp-server/src/observe.test.ts` (mod, one line) | test | — | main `observe.test.ts:352-356` | exact |
| `packages/mcp-server/src/event-sources.ts` (mod; *exists after Phase 17 merges*) | registry (typed table) | — | P17 `event-sources.ts:278-302` (the `desktop.action` row itself) | exact |
| `docs/event-vocabulary.md` (mod; *exists after Phase 17 merges*) | docs | — | P17 `docs/event-vocabulary.md:41-44,69` | exact |
| `packages/audit/src/policy.ts` / `policy.test.ts` (verify only; *Phase 17 entry*) | registry | — | P17 `policy.ts:27-30`, `policy.test.ts:12` | exact (no edit expected) |
| `packages/mcp-server/src/rehearsal-env.ts` (mod; *exists after Phase 16 merges*) | config builder | transform | P16 `rehearsal-env.ts:55-66,91-101,134-163` | exact |
| `packages/mcp-server/src/rehearsal-env.test.ts` (mod; *P16*) | test | transform | P16 `rehearsal-env.test.ts:75-125,195-222` | exact |
| `scripts/rehearsal.ts` (mod; *exists after Phase 16 merges*) | CLI script | request-response | P16 `rehearsal.ts:141-167,426-442,531-537,930-952,1372-1441` | exact |
| `scripts/rehearsal.test.ts` (mod; *P16*) | test | — | P16 `rehearsal.test.ts:179-210,418-432` | exact |
| `infra/desktop/substrate-desktop.sh` (new) | infra script (root lifecycle) | subprocess | `acc30a8:infra/desktop/substrate-desktop.sh:1-146` | exact (port + env-file seam + SC2016 directive) |
| `scripts/substrate-desktop.test.ts` (new) | test (script under PATH stubs) | subprocess | P16 `rehearsal.test.ts:63-68` (`runCli`), main `git.test.ts:16-35`, P16 `rehearsal.ts:329-349` (`docker()` env) | partial: no PATH-stub test exists in the repo |
| `scripts/desktop-smoke.ts` (new) | proof script | request-response (MCP over HTTP) | P16 `rehearsal.ts:1187-1220,1301-1340` (`refuseSmokeUrl`, `parseShellExports`, `runSmoke` check lines) | role-match; SDK `StreamableHTTPClientTransport` has no repo analog (RESEARCH probe) |
| `scripts/desktop-smoke.test.ts` (new) | test (pure helpers) | transform | P16 `scripts/parity-check.test.ts:1-30`, P16 `rehearsal.test.ts:216-235` | role-match |
| `package.json` (mod) | config | — | P16 `package.json` `scripts` block | exact |
| `README.md` (mod, new short section) | docs | — | main `README.md:123-150` (`## Observability and audit`) | role-match |
| `docs/runbooks/desktop.md` (new) | docs (runbook) | — | P16 `docs/runbooks/production-parity.md` | exact |
| `docs/mcp-audit.md` (mod) | docs | — | main `docs/mcp-audit.md:222-229`; P17 `docs/mcp-audit.md:229-241` ("Planned in v1.3") | exact |
| `.env.example` (mod) | config docs | — | main `.env.example:56-64,127-133` | exact |
| `.planning/phases/30-desktop-run/30-N1-SPIKE.md` (new, spike record) | planning artifact | — | none (RESEARCH "Spike plan (D30-18)") | no analog |

---

## Pattern Assignments

### `packages/mcp-server/src/desktop/actions.ts` (utility, transform) — verbatim port

**Analog:** `acc30a8:packages/mcp-server/src/desktop/actions.ts` (111 lines). Port it **unchanged**: `git show acc30a8:packages/mcp-server/src/desktop/actions.ts > …`. Two edits are allowed: re-point the header comment from `D-13` to `DESK-01 / D30-05..06`, and add a new argv builder **only if** the N1 spike (D30-18) adds `xrefresh`.

The pieces the rest of the phase depends on:
```ts
// acc30a8 actions.ts:8-17
export const EXEC = ["docker", "exec", "-e", "DISPLAY=:1", "substrate-desktop"] as const;
const CHORD = "[A-Za-z0-9_]+(?:\\+[A-Za-z0-9_]+)*";
const KEYS = new RegExp(`^${CHORD}(?: ${CHORD}){0,7}$`);
const TYPEABLE = /^[^\u0000-\u0008\u000b-\u001f\u007f-\u009f]*$/;
const settleMs = z.number().int().min(0).max(5000).optional().describe("wait after the action, ms");
```
```ts
// acc30a8 actions.ts:47-51 — the strict object that mcp.ts must register as-is (not `.shape`)
export const DesktopRunInput = z.strictObject({
	actions: z.array(DesktopAction).min(1).max(50),
	timeout: z.number().int().min(1).max(120).default(30).describe("whole-run deadline in seconds"),
});
```
```ts
// acc30a8 actions.ts:57, 92-111 — settle defaults and the fixed argv table
export const DEFAULT_SETTLE_MS = { click: 300, type: 200, key: 800 } as const;
export function typeArgv(action: TypeText): string[] {
	return [...EXEC, "xdotool", "type", "--delay", "12", "--", action.text];
}
export function keyArgv(action: Key): string[] {
	return [...EXEC, "xdotool", "key", "--clearmodifiers", "--", ...parseKeys(action.keys)];
}
export function shotArgv(): string[] { return [...EXEC, "xwd", "-root", "-silent"]; }
export function titleArgv(): string[] { return [...EXEC, "xdotool", "getactivewindow", "getwindowname"]; }
export function geometryArgv(): string[] { return [...EXEC, "xdotool", "getdisplaygeometry"]; }
```
`boundsRefusal` (acc30a8 actions.ts:66-76) returns a string or `null`, and the driver throws it before any input.

---

### `packages/mcp-server/src/desktop/actions.test.ts` (test) — verbatim port

**Analog:** `acc30a8:…/desktop/actions.test.ts` (130 lines; its describes are at L21, 58, 76, 122). Port it unchanged. The builder-table test (L77-91) and the "no builder emits a shell" test (L99-115) are the D30-06 enumeration:
```ts
// acc30a8 actions.test.ts:100-114
const all = [clickArgv({ type: "click", x: 1, y: 1, double: true }), typeArgv({ type: "type", text: "sh -c id; bash" }),
	keyArgv({ type: "key", keys: "ctrl+alt+t" }), shotArgv(), titleArgv(), geometryArgv()];
for (const argv of all) {
	expect(argv.slice(0, 5)).toEqual([...EXEC]);
	expect(["xdotool", "xwd"]).toContain(argv[5]!);
	expect(argv.slice(0, 6)).not.toContain("sh");
	expect(argv).not.toContain("bash");
	expect(argv).not.toContain("-c");
}
```
If the spike adds an `xrefreshArgv()`, add it to `all` and to the exact-table test at L77-91. D30-06 says "a test enumerates every argv builder".

---

### `packages/mcp-server/src/desktop/png.ts` (utility, transform) — split out of the driver

**Analog:** `acc30a8:…/desktop/driver.ts:69-171`. Move these into `png.ts` unchanged: `XWD_*` constants, `decodeXwd` (L83-127), `PNG_SIGNATURE`, `CRC_TABLE`, `crc32` (L139-143), `pngChunk` (L145-152) and `encodePng` (L155-171). Export `PNG_SIGNATURE` so the decoder can use it.
```ts
// acc30a8 driver.ts:155-171
export function encodePng(width: number, height: number, rgb: Buffer): Buffer {
	const stride = width * 3;
	if (rgb.length !== stride * height) throw new Error(`png: ${rgb.length} bytes for ${width}x${height} RGB`);
	const rows = Buffer.alloc(height * (stride + 1));
	for (let y = 0; y < height; y++) rgb.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	…
	return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(rows)), pngChunk("IEND", Buffer.alloc(0))]);
}
```
**`decodePng` (new, no repo analog).** Use the RESEARCH "Pixel marker → Minimal decoder" block. It is filter-0 only and refuses anything else. Its chunk walk mirrors the test helper `chunks()` at acc30a8 driver.test.ts:69-81. The tests, the spike and the smoke all share it. Imports follow the acc30a8 style: `import { deflateSync, inflateSync } from "node:zlib";`. Add no dependency.

---

### `packages/mcp-server/src/desktop/png.test.ts` (test)

**Analog:** `acc30a8:…/desktop/driver.test.ts:36-122`. Move here: the `W/H/pixel/EXPECTED_RGB` fixture (L36-40), the synthetic `xwd()` builder (L46-67), `chunks()` (L69-81), `describe("decodeXwd")` (L83-100) and `describe("encodePng")` (L102-122).

Add `decodePng(encodePng(W,H,EXPECTED_RGB))` round-trip equality, plus a refusal on a non-zero filter byte. Build that case by flipping the first byte of an inflated row, re-deflating it and rebuilding the IDAT with `crc32`.

---

### `packages/mcp-server/src/desktop/driver.ts` (service, subprocess + file-I/O + event-driven)

**Analog:** `acc30a8:…/desktop/driver.ts` (359 lines). Port it, then make exactly the changes below. Everything else stays: `ACTION_TIMEOUT_MS`, `TYPE_MS_PER_CHAR`, `RETAIN_*`, `RUN_ID`, `NOT_RUNNING`, `failure()`, `prune()`, `call()`, the geometry→bounds order, per-action budget and the post-action title read.

**Imports pattern** (acc30a8 driver.ts:15-34; redaction from the one shared module, as Phase 18 locks it):
```ts
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { redact } from "../redact.ts";
import type { EmitResult } from "../service.ts";      // type-only; or define a local { stored: boolean } shape
import type { EventInput, Surface } from "../types.ts";
import { boundsRefusal, clickArgv, DEFAULT_SETTLE_MS, type DesktopAction, DesktopRunInput, … } from "./actions.ts";
import { decodeXwd, encodePng } from "./png.ts";
```

**Change 1: the child env is an allowlist (D30-07).** September did this (acc30a8 driver.ts:55-67):
```ts
{ encoding: "buffer", maxBuffer: 16 << 20, timeout: timeoutMs, env: { ...process.env, HOME: "/root" } },
```
Phase 30 instead exports a pure `childEnv(parent)` and passes `env: childEnv(process.env)`. The repo precedent for "explicit env, never inherited" is P16 `scripts/rehearsal.ts:329-334` (*exists after Phase 16 merges*):
```ts
function docker(args: string[], extraEnv?: Record<string, string>): DockerResult {
	const env: Record<string, string> = {};
	if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
	if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
```
For D30-07, keep only PATH and HOME (no `DOCKER_*`; RESEARCH A4). Fall back to `HOME: "/root"` and a standard PATH.

**Change 2: the busy flag replaces the queue (D30-08).** September did this (acc30a8 driver.ts:207, 351-357):
```ts
let queue: Promise<unknown> = Promise.resolve();
…
async run(input, { surface }) {
	const parsed = DesktopRunInput.parse(input);
	const turn = queue.then(() => execute(parsed, surface));
	queue = turn.catch(() => undefined);
	return turn;
},
```
Replace it with the RESEARCH Pattern 4 block. The state stays at module scope, because the header comment at acc30a8 driver.ts:12-13 still applies: "createMcpServer is rebuilt per request". Check-and-set synchronously after `parse` and before the first `await`, and clear the flag in `finally`. Busy is a typed refusal (for example `class DesktopBusy extends Error { constructor(readonly runId: string) }`) that `Substrate.runDesktop` maps to "desktop_run is busy with run <run_id>; nothing was run".

**Change 3: events (D30-11).** September did this (acc30a8 driver.ts:175-181, 284-292, 329-339):
```ts
export type DesktopActionEvent = { kind: "desktop.action"; surface: Surface; summary: string; actor: "agent"; payload: Record<string, unknown> };
…
await deps.emit({ kind: "desktop.action", surface, summary: `desktop ${action.type} ${entry.ok ? "ok" : "failed"}`, actor: "agent",
	payload: { run_id: runId, ...entry, ...details } });
} catch { /* Fail-open */ }
```
Phase 30 builds an `EventInput` (main `types.ts:71-85`): `kind: "tool.call"`, `session_id: \`desktop:${runId}\``, `summary: \`desktop ${action.type} ${ok ? "ok" : "failed"}\``. The payload is `{ tool: "desktop_run", action, run_id, i, ok, ms, …fields }`, using the field rules in D30-11. **Do not spread `entry`**: it carries `active_window`. Rename `text_chars`→`text_len`, `screenshot_sha256`→`sha256` (+`width`,`height`), and drop `screenshot_path`. Click adds `double`. The session id has a main precedent in the one-session-per-job pattern at `service.ts:831`: `session_id: \`bind:${result.graph_id}:${correlationId}\``.

**Change 4: emit is passed per call and its result is read (D30-12).** September fixed `emit` at construction (`createDesktopDriver({ …, emit })`, L230-236). Phase 30 uses `run(input, { surface, emit: (e: EventInput) => Promise<{ stored: boolean }> })`. After each executed action, `const { stored } = await ctx.emit(…)` (wrapped in try/catch; a throw counts as not stored). When `stored === false`, stop and return a failed outcome `{ run_id, log, error: \`event not stored after action ${i}; run stopped\` }` with no images. `EmitResult.stored` is defined at main `service.ts:230-238`.

**Change 5: a not-started action emits nothing (C7).** September (L276-278) logs `error: "deadline"` and then falls through to the emit at L329. In Phase 30 the deadline branch pushes the log entry and `break`s before any emit.

**Change 6: the directory comes from config.** Replace `SHOTS_DIR`/`deps.shotsDir` (L36, 232, 237) with a required `deps.dir` (from `config.desktopDir`). Keep the `mkdirSync(runDir, { recursive: true, mode: 0o700 })` / `writeFileSync(path, png, { mode: 0o600 })` lines (L302-304).

**New pure function `keyFields(keys)` (D30-11 tightened rule; no repo analog).** RESEARCH Pattern 5 is the *literal* rule, which C6 rejects. Implement the CONTEXT D30-11 predicate instead: a chord is verbatim-safe iff any `+`-part matches the non-shift modifier set (`ctrl|alt|super|meta|Control_*|Alt_*|Super_*`), or the whole chord is in the fixed named set (`Return, KP_Enter, Tab, Escape, BackSpace, Delete, Insert, Home, End, Page_Up, Page_Down, Up, Down, Left, Right, F1–F12, Menu`). Otherwise return `{ keys_len, keys_sha256 }`. Hash with the existing `sha256` helper (acc30a8 driver.ts:209).

**Error handling pattern** (kept, acc30a8 driver.ts:211-214 and 309-311):
```ts
function failure(result: BufferRunResult): string {
	if (NOT_RUNNING.test(result.stderr)) return "substrate-desktop is not running";
	return redact(`exit ${result.code}: ${result.stderr.trim().slice(-ERROR_CHARS)}`);
}
```

---

### `packages/mcp-server/src/desktop/driver.test.ts` (test)

**Analog:** `acc30a8:…/desktop/driver.test.ts` (346 lines). Keep the scaffolding unchanged:
```ts
// acc30a8 driver.test.ts:20-34 — temp dirs and runner results
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function tmpShots(): string { const dir = mkdtempSync(join(tmpdir(), "desktop-driver-")); dirs.push(dir); return join(dir, "shots"); }
const res = (stdout: string | Buffer, code = 0, stderr = ""): BufferRunResult => ({ code, stdout: typeof stdout === "string" ? Buffer.from(stdout) : stdout, stderr });
```
```ts
// acc30a8 driver.test.ts:125-137 — the recording fake runner (keep; import the xwd() fixture from png.test or a shared fixture)
function recorder(overrides: (argv: readonly string[]) => BufferRunResult | Promise<BufferRunResult> | undefined = () => undefined) {
	const calls: string[][] = [];
	const run: BufferRunner = async (argv) => { calls.push([...argv]); const override = await overrides(argv); if (override) return override;
		if (argv.includes("getdisplaygeometry")) return res("1280 800\n"); … };
	return { calls, run };
}
```
Port these tests unchanged except for the new `run(input, { surface, emit })` signature:
- out-of-bounds (L204-214);
- per-action timeout (L216-233). It uses a hung runner, `Promise.withResolvers<BufferRunResult>().promise`. Reuse the same deferred for the busy test;
- type budget (L255-279);
- not-running (L281-288);
- title failure, first half (L290-294);
- retention (L327-345).

Change these:
- **L152-202, the 4-event test.** Assert `kind === "tool.call"`, `session_id === \`desktop:${run_id}\``, `actor === "agent"` and summaries `desktop key ok…`. Payload keys must equal the D30-11 set per action, with `text_len: 17` and `text_sha256`. There must be no `active_window`, `screenshot_path` or `text` key. `JSON.stringify(events)` must not contain `"TYPED-SECRET-TEXT"` or `"iVBOR"`. Assert `keys: "ctrl+alt+t"` and `keys: "Return"` verbatim (modifier and named key), and add a `shift+a` / `KP_1` / `space` case that yields `keys_len` + `keys_sha256`.
- **L235-253, the deadline test.** Also assert there is no event for i=1.
- **L290-309, the "throwing emit changes nothing" test.** Invert it. `emit` returning `{ stored: false }` stops after action 0 with the D30-12 error and no images. A throwing emit does the same.
- **L311-325, the "never interleave" test.** Start run A on a deferred runner. Run B must be refused at once, naming A's run id. After resolving A in `finally`, the runner saw A's argv only (RESEARCH Pitfall 5).
- **New: `childEnv`.** A poisoned parent `{ PATH, HOME, SUBSTRATE_TOKEN_OMP: "x", GREPTIME_PASSWORD: "y" }` must yield exactly `{ PATH, HOME }`. Spell the ledger key through a computed name or `LEDGER_KEYS` if the test lives outside the MCP package. Inside `packages/mcp-server/src/` it is allowed, but keep values short (store-lock `TOKEN_LITERAL`).

---

### `packages/mcp-server/src/desktop/tool.test.ts` (test, MCP in-memory)

**Analog:** main `mcp.test.ts:18-56`. Copy `ledger()` and `connect()`, and give `connect` config and driver parameters:
```ts
// mcp.test.ts:19-48
function ledger(rows: Array<Record<string, unknown>> = []) {
	const written: SubstrateEvent[] = [];
	…
	greptime: { ensureAppendMode: async () => true, lastHash: async (): Promise<string | null> => null,
		insertEvent: async (event: SubstrateEvent) => { written.push(event); }, … },
}
async function connect(greptime: unknown, surface: Surface | null = "omp") {
	const substrate = new Substrate(loadConfig({}), { index: null, greptime: greptime as never });
	const server = createMcpServer(substrate, surface);
	const client = new Client({ name: "substrate-test", version: "0.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return { client, substrate };
}
```
For desktop, pass `loadConfig({ SUBSTRATE_DESKTOP_SURFACES: "omp", SUBSTRATE_DESKTOP_DIR: tmp })` and `{ index: null, greptime, desktop: createDesktopDriver({ run: recorder.run, dir: tmp, sleep: noSleep }) }`.

- **D30-12:** set `insertEvent` to throw.
- **D30-04a:** use `greptime: null`. The reply contains "needs the event ledger" and the runner sees 0 calls.
- **D30-02:** cover an unlisted surface (`"cursor"`) and anonymous (`null`). Runner 0 calls, `written` empty, and the text contains "nothing was run".
- **Strict schema (C3):** `call(client, "desktop_run", { actions: [...], surface: "omp" })` gives `isError` and runner 0 calls.
- **Image blocks:** read `result.content` past `[0]`. `call()` (mcp.test.ts:51-56) reads only `content[0]`, so add a variant that returns the full content array.

**Tool-listing assertion analog:** `graph-bind.test.ts:289-293`:
```ts
const tool = (await client.listTools()).tools.find((candidate) => candidate.name === "graph_bind");
expect(tool).toBeDefined();
expect(tool?.annotations?.readOnlyHint).not.toBe(true);
```
Apply it to `desktop_run`, asserting `inputSchema.additionalProperties === false`.

---

### `packages/mcp-server/src/mcp.ts` (controller, request-response)

**Analog A, September's registration:** `acc30a8:packages/mcp-server/src/mcp.ts:178-204`. Copy the content-block shape. Replace the gate, the schema and the surface fallback:
```ts
// acc30a8 mcp.ts:184-200 (what changes is marked)
inputSchema: DesktopRunInput.shape,                         // ← DesktopRunInput (strict ZodObject; C3)
annotations: { destructiveHint: false, openWorldHint: true },
async (input) => {
	if (!opts.proposeAllowed) { return refusal("…"); }       // ← delete; the gate is in Substrate.runDesktop
	try {
		const { images, ...result } = await substrate.runDesktop(input, callerSurface ?? "claude-code"); // ← callerSurface, no fallback
		return { content: [
			{ type: "text" as const, text: JSON.stringify(result, null, 2) },
			...images.map((data) => ({ type: "image" as const, data, mimeType: "image/png" })),
		] };
	} catch (cause) {
		return refusal(redact(cause instanceof Error ? cause.message : String(cause)).slice(0, 400));
	}
}
```
The description text (acc30a8 L183) should drop "desktop.action event" and "host propose key". It should say the tool needs an operator-listed surface and that each action is a `tool.call` event.

**Analog B, main's refusal mapping** (`mcp.ts:153-155`, 298-310):
```ts
function refusal(message: string) {
	return { ...json({ error: message }), isError: true };
}
…
async (request) => {
	try {
		…
		if (request.query === undefined) {
			return refusal("memory_search needs `query`, or `subject_prefix` to list a subject family");
		}
		return json(await substrate.searchMemory(…));
	} catch (cause) {
		if (cause instanceof InvalidSearchError) return refusal(cause.message);
		throw cause;
	}
},
```
**Analog C, main's union-result idiom** (`mcp.ts:355-356`): `if ("refused" in attribution) return refusal(attribution.refused);`. Use it for `runDesktop`'s outcome, as RESEARCH "Tool handler shape" does: `refused` → `refusal()`; `failed` → `{ ...json(outcome.failed), isError: true }`; success → text block + image blocks.

**Caller identity is already destructured** (`mcp.ts:171-175`):
```ts
const { surface: callerSurface, isOperator } =
	caller === null || typeof caller === "string" ? { surface: caller, isOperator: false } : caller;
```
`isOperator` must not appear in the desktop handler (D30-01).

**Imports:** add `import { DesktopRunInput } from "./desktop/actions.ts";` after the `./drift.ts` import, in the same alphabetical import block as `mcp.ts:11-35`. Add `redact` only if the catch branch is kept. Prefer letting `runDesktop` return a redacted `failed` instead.

---

### `packages/mcp-server/src/service.ts` (service, request-response + event)

**Analog A, the constructor seam** (main `service.ts:459-475`):
```ts
export class Substrate {
	readonly index: IndexStore | null;
	readonly greptime: GreptimeClient | null;
	private readonly observer: SubstrateObserver;

	/** `stores` is a test seam; production always builds them from config. */
	constructor(
		readonly config: SubstrateConfig,
		stores?: { index?: IndexStore | null; greptime?: GreptimeClient | null },   // ← add desktop?: DesktopDriver | null
		observer: SubstrateObserver = {},
	) {
		this.index = stores?.index !== undefined ? stores.index : config.postgresUrl ? new IndexStore(config.postgresUrl) : null;
		this.greptime = stores?.greptime !== undefined ? stores.greptime : config.greptime ? new GreptimeClient(config.greptime) : null;
		this.observer = observer;
	}
```
Add `readonly desktop: DesktopDriver | null;` and `this.desktop = stores?.desktop ?? null;`. Both September and Phase 21 defaulted the field to the real executor:
- September: `acc30a8:service.ts:112-113`, `this.desktop = stores?.desktop !== undefined ? stores.desktop : createDesktopDriver({ run: bufferRunner, emit: … })`;
- Phase 21: P21 `21-PATTERNS.md:302-308`.

**Do not copy that default.** RESEARCH Pattern 1 sets it to `null`. Only `index.ts` wires the real driver, so no test can reach `docker`.

**Analog B, September's method** (`acc30a8:service.ts:191-197`):
```ts
/** desktop_run (D-13): drives the substrate-desktop container. … */
async runDesktop(input: DesktopRunInput, surface: Surface): Promise<DesktopRunResult> {
	if (!this.desktop) throw new Error("desktop driver not available");
	return this.desktop.run(input, { surface });
}
```
Phase 30 signature: `runDesktop(input: unknown, callerSurface: Surface | null): Promise<{ refused: string } | { failed: {...} } | { result: DesktopRunResult }>`. The refusal order (RESEARCH Pattern 3 plus D30-04a):
1. `callerSurface === null`;
2. `!this.config.desktopSurfaces.has(callerSurface)`;
3. `this.desktop === null`;
4. `this.greptime === null` → "desktop_run needs the event ledger; nothing was run";
5. busy (caught from the driver);
6. run.

Pass `emit: (e) => this.emit(e)` per call. **Not** `.catch(() => undefined)`: D30-12 reads `stored`.

**Analog C, the `stored` contract** (main `service.ts:230-238`, 547-593):
```ts
export interface EmitResult {
	event: SubstrateEvent;
	/** False when the ledger is unconfigured, unreachable or refused the write. */
	stored: boolean;
	error?: string;
	warning?: string;
}
…
if (!this.greptime) return { event, stored: false, error: "GREPTIME_URL is not set" };
…
try { await this.greptime.insertEvent(event); return { event, stored: true, … }; }
catch (cause) { const error = redact(String(cause)); …; return { event, stored: false, error }; }
```
`emit` never throws for an unavailable ledger. It can throw `InvalidEventError` for a malformed input, so the driver's try/catch treats a throw as `stored: false`.

**Imports:** add `import type { DesktopRunInput } from "./desktop/actions.ts";` and `import { type DesktopDriver, type DesktopRunResult } from "./desktop/driver.ts";`, matching acc30a8 service.ts:12-13 but without `bufferRunner`/`createDesktopDriver`.

---

### `packages/mcp-server/src/config.ts` (config, transform)

**Analog: the same file.**

**Interface field doc style** (main `config.ts:91-99`, the `audit` field):
```ts
/**
 * Where the hash-chained MCP audit is written. `null` keeps it in memory.
 * …
 */
audit: { path: string | null };
```
Add `desktopSurfaces: ReadonlySet<Surface>`, `desktopDir: string` and a dropped-name list for the warning (for example `desktopIgnored: readonly string[]`; names only).

**Comma-list parsing** (main `config.ts:177-182`):
```ts
operatorTokens: new Set(
	(env.SUBSTRATE_OPERATOR_TOKENS ?? "")
		.split(",")
		.map((token) => token.trim())
		.filter((token) => token.length > 0),
),
```
**Known-surface check precedent** (main `memory-policy.ts:78-80`, `event.ts:38-40`):
```ts
function isKnownSurface(value: string): boolean {
	return (SURFACES as readonly string[]).includes(value);
}
```
`SUBSTRATE_DESKTOP_DIR`: copy the `env.X?.trim() || default` idiom (`config.ts:188`) and add the absolute-path guard (RESEARCH Pitfall 10). A relative value keeps the default, records a warning, and never throws. `loadConfig({})` must not throw: dozens of tests call it.

**Boot warning: a sibling, not `configWarnings` (C2).** Analog `swarmTokenWarnings` (main `config.ts:310-333`):
```ts
export function swarmTokenWarnings(config: SubstrateConfig): string[] {
	if (config.allowAnonymous) return [];
	…
	if (missing.length === 0) return [];
	return [`no token for ${missing.length} swarm surface… (${missing.map(tokenEnvName).join(", ")}); …`];
}
```
Name it `desktopConfigWarnings(config)` (CONTEXT D30-01). It returns `[]` for an empty or fully valid allowlist (P16 `rehearsal-env.test.ts:84,120` require zero warnings). Otherwise it is one line naming the dropped names and/or the relative dir. Follow the "Named by surface, never by token" rule at `config.ts:298`. `configWarnings` (`config.ts:278-308`) is **not** touched: it returns early at L280.

---

### `packages/mcp-server/src/desktop/config.test.ts` (or new cases in `authority.test.ts`)

**Analog:** main `authority.test.ts:245-271` (`describe("swarmTokenWarnings")`):
```ts
test("a bare local run is silent", () => {
	expect(swarmTokenWarnings(loadConfig({}))).toEqual([]);
});
test("a deployment with tokens names every swarm surface that has none", () => {
	const warnings = swarmTokenWarnings(loadConfig({ SUBSTRATE_TOKEN_HERMES: "tok-hermes" }));
	expect(warnings).toHaveLength(1);
	…
	// Never a token value.
	expect(warnings[0]).not.toContain("tok-hermes");
});
```
Mirror it for `desktopConfigWarnings`:
- unset → `desktopSurfaces.size === 0` and `[]`;
- `"omp, cursor ,"` → `{omp, cursor}` and `[]`;
- `"omp,nobody"` → `{omp}` and one warning containing `nobody`.

`isOperator` grants nothing: an operator token whose surface is unlisted is still refused (this is tested at the tool level). `configWarnings(loadConfig({ SUBSTRATE_DESKTOP_SURFACES: "nobody" }))` stays `[]` (`authority.test.ts:74-75` pattern). VALIDATION names `desktop/config.test.ts`. Either location works, but one test file per new behaviour keeps `bun test <file>` meaningful (RESEARCH Pitfall 11).

---

### `packages/mcp-server/src/observe.ts` (registry) + `observe.test.ts`

**Analog:** main `observe.ts:309-337`. Append after `"coord_reap_leases"` (L329), inside the "MCP tools, as `mcp.ts` registers them" block and above the REST comment (L330-331):
```ts
	"coord_drift_scan",
	"coord_reap_leases",
	// + "desktop_run",
	// REST routes, as `server.ts` audits them. A route audited under a tool's own name
```
On the Phase 17/21 base other planned names (`skills_propose`) may already sit there. Append after the last MCP tool.

**Test analog** (`observe.test.ts:352-356`): add `expect(toolLabel("desktop_run")).toBe("desktop_run");`.

---

### `packages/mcp-server/src/index.ts` (entry/wiring)

**Analog:** main `index.ts:11-26`:
```ts
import { configWarnings, loadConfig, swarmTokenWarnings } from "./config.ts";   // + desktopConfigWarnings
…
const substrate = new Substrate(config, undefined, observability.observer);
// → new Substrate(config, { desktop: createDesktopDriver({ run: bufferRunner, dir: config.desktopDir }) }, observability.observer);
…
for (const warning of [...configWarnings(config), ...swarmTokenWarnings(config)]) {   // + ...desktopConfigWarnings(config)
	process.stderr.write(`[substrate] misconfigured — ${warning}\n`);
}
```
`stores.index`/`greptime` stay `undefined`, so the `!== undefined` defaults at `service.ts:470-473` still apply. **Lock test (RESEARCH Pattern 1):** a grep test asserts that `bufferRunner` is referenced only in `desktop/driver.ts` and `index.ts`. Model it on main `store-lock.test.ts:99`, which uses `Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT })` to list tracked files.

---

### `packages/mcp-server/src/http.test.ts` (test, real HTTP gate): new `describe("desktop_run at the HTTP gate")`

**Analog A, harness** (main `http.test.ts:31-73`):
```ts
async function start(env: Record<string, string | undefined> = {}, stores: Partial<{ index: unknown; greptime: unknown }> = {}): Promise<Harness> {
	const config: SubstrateConfig = loadConfig(env);
	const observability = createObservability(config, env);
	await observability.start();
	const substrate = new Substrate(config,
		{ index: null, greptime: null, ...stores } as ConstructorParameters<typeof Substrate>[1],
		observability.observer);
	…
}
function auditDirectory(): string { return join(mkdtempSync(join(tmpdir(), "substrate-http-")), "mcp-audit.jsonl"); }
function unwritablePath(): string { … }
```
Widen `stores` to `Partial<{ index: unknown; greptime: unknown; desktop: unknown }>`.

**Analog B, audit-gate tests** (main `http.test.ts:193-227`):
```ts
function toolCall(name: string, args: unknown = {}) {
	return JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } });
}
…
const [record] = harness.observability.audit.recent();
expect(record).toMatchObject({ tool: "graph_get", decision: "allowed", graph_id: "ut-1", transport: "mcp" });
…
expect(body.error.code).toBe(-32000);
expect(body.error.message).toContain("graph_claim");
```
**Analog C, the 401 and bearer tests** (main `server.authority.test.ts:108-125`, 291-298):
```ts
headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
	...(token ? { authorization: `Bearer ${token}` } : {}) },
…
const response = await fetch(`${base}/handoff`, { method: "POST",
	headers: { "content-type": "application/json", authorization: "Bearer nonsense" }, body: … });
expect(response.status).toBe(401);
```
The cases are in RESEARCH Pattern 6 "HTTP level":
- VM guest: no bearer → 401; bogus bearer → 401; recording runner 0 calls; no `desktop_run` audit record;
- self-attribution: `surface` arg plus `x-substrate-propose-key` header → isError, 0 calls;
- unwritable audit → `-32000`, 0 calls;
- D30-13: `JSON.stringify(audit.recent())` has no `TYPED-SECRET-TEXT`/`iVBOR`; `mode: "fail-closed"`; `arg_keys` ⊆ `["actions","timeout"]`.

Keep tokens short (`tok-omp`), as `server.authority.test.ts:18-28` does, so the store-lock `TOKEN_LITERAL` stays green.

---

### `packages/mcp-server/src/event-sources.ts` + `docs/event-vocabulary.md` (*exist after Phase 17 merges*)

**Analog:** the row itself, P17 `event-sources.ts:278-302`:
```ts
{
	id: "desktop.action",
	phase: 30,
	kind: "tool.call",
	surface: "caller",
	actions: ["click", "type", "key", "screenshot"],
	carriesRepo: false,
	periodic: false,
	sample: () => ({
		surface: "claude-code",
		kind: "tool.call",
		summary: "desktop_run screenshot ok (120ms)",     // ← "desktop screenshot ok"           (C11)
		session_id: "sess-p17-desktop",                    // ← "desktop:dr-20261008T000000Z-abc123"
		payload: { tool: "desktop_run", action: "screenshot", run_id: "run-p17-1",   // ← run_id in the dr-… format
			i: 0, ok: true, ms: 120, sha256: HEX_64, width: 1280, height: 800 },
	}),
},
```
`kind`, `surface`, `actions`, `tool` and `action` stay unchanged. The sample must still pass `normalizeEvent` unchanged (P17 `event-sources.test.ts:15-30`) and the banned-key test (`event-sources.test.ts:71-82`, `BANNED = { text, content, body, bytes, image, png }`). D30-11's `text_len`/`text_sha256`/`keys_len`/`keys_sha256` are allowed.

The doc row (P17 `docs/event-vocabulary.md:69`) keeps its columns. The prose at L41-44 already says "typed desktop text (length plus sha256), screenshots (sha256 plus dimensions, never bytes)". If the doc carries per-row fields, add the click/key fields there. `event-sources.test.ts:84-125` ("docs/event-vocabulary.md equals the table") enforces the sync.

### `packages/audit/src/policy.ts` / `policy.test.ts` (verify, no edit expected)

P17 `policy.ts:27-30` already lists `"desktop_run", // Phase 30: acts on a desktop (DESK-03).` in `FAIL_CLOSED_TOOLS`, and P17 `policy.test.ts:12` pins `["desktop_run", "fail-closed"]`. On main, `auditMode` is default-deny (`policy.ts:77-80`), so the mode already holds before the rebase. Add the entry here only if the base lacks the Phase 17 line. Analog test: main `policy.test.ts:65-71` (explicit membership, not default).

---

### `packages/mcp-server/src/rehearsal-env.ts` + `rehearsal-env.test.ts` (*exist after Phase 16 merges*)

**Analog:** P16 `rehearsal-env.ts`.
- **Input field style** (L55-66): add `/** Surfaces allowed to call desktop_run; a subset of surfaces. */ desktopSurfaces: readonly Surface[];`.
- **Guard style** (L87-101): copy it into `assertDesktopSurfacesAllowed(surfaces, desktopSurfaces)`:
```ts
export function assertOperatorAllowed(surfaces: readonly Surface[], operator: Surface | null): void {
	if (operator === null) return;
	if (!surfaces.includes(operator)) {
		throw new RehearsalEnvError(`rehearsal env refused: operator surface ${operator} has no surface token`);
	}
	…
}
```
- **Insertion** (L160-162): set `SUBSTRATE_DESKTOP_DIR` always and the allowlist only when non-empty:
```ts
env.SUBSTRATE_AUDIT_PATH = join(input.runDir, "mcp-audit.jsonl");
// + env.SUBSTRATE_DESKTOP_DIR = join(input.runDir, "desktop");
// + if (input.desktopSurfaces.length > 0) env.SUBSTRATE_DESKTOP_SURFACES = input.desktopSurfaces.join(",");
env.SUBSTRATE_HANDOFF_KEY = input.secrets.handoffKey;
return env;
```
- **Tests:**
  - Extend the exact key set (`rehearsal-env.test.ts:197-221`) with `"SUBSTRATE_DESKTOP_DIR"`, and add a twin test that also expects `"SUBSTRATE_DESKTOP_SURFACES"`.
  - Keep `configWarnings(config)).toEqual([])` (L84, L120). Add `desktopConfigWarnings(...)).toEqual([])` beside them.
  - Round trip: `loadConfig(env).desktopSurfaces` equals the input and `.desktopDir === join(runDir, "desktop")`.
  - Copy the `audit path is a file inside the run directory` test (L101-105).
  - A refusal test for a desktop surface outside `surfaces` belongs in the existing `describe("refusals")` (L114+).

Phase 21's analogous change (`SUBSTRATE_SKILLS_STATE`) is planned the same way (P21 `21-PATTERNS.md:742-767`). If both land, merge the expected-set edits.

### `scripts/rehearsal.ts` + `scripts/rehearsal.test.ts` (*exist after Phase 16 merges*)

**Analog:** P16 `scripts/rehearsal.ts`.
- **Parser:** copy `parseOperator` (L141-167) into `parseDesktopSurfaces(raw, surfaces, anonymous)`. It throws `RehearsalRefused` naming surfaces only: each name must be in `SURFACES` and in `--surfaces`, and the flag is refused with `--anonymous` (tokenless runs would only be refused by the tool).
```ts
if (!surfaces.includes(raw as Surface)) {
	throw new RehearsalRefused(`operator surface ${raw} is not in --surfaces`);
}
```
- **Plumbing:**
  - `UpOptions` (L531-537) and `TwinState` (L426-442) gain `desktopSurfaces: Surface[]`;
  - the `buildRehearsalEnv({ … })` call (L939-946) passes it, inside the existing `try … catch (cause) { removeLabelledContainers(opts.name); throw cause instanceof RehearsalEnvError ? new RehearsalRefused(cause.message) : cause; }` (L947-952);
  - `refuseExtraArgs` `valued` (L1373) gains `"--desktop-surfaces": true`;
  - `main` (L1402-1441) reads `flag(argv, "--desktop-surfaces")` and adds it to the null-value loop (L1411-1418);
  - `usage()` (L1395-1400) lists `[--desktop-surfaces a,b]`.
- **Tests:**
  - copy `describe("parseOperator")` (`rehearsal.test.ts:179-210`) for `parseDesktopSurfaces`;
  - extend `refuseExtraArgs` (L418-432) with `["up", "--desktop-surfaces", "omp"]` → `null`.

---

### `infra/desktop/substrate-desktop.sh` (infra script, subprocess)

**Analog:** `acc30a8:infra/desktop/substrate-desktop.sh` (146 lines). Port it with three edits:

1. **Env-file seam (C4)** at acc30a8 L22:
```bash
ENV_FILE=/etc/substrate/substrate-desktop.env
# → ENV_FILE=${SUBSTRATE_DESKTOP_ENV_FILE:-/etc/substrate/substrate-desktop.env}  # test seam; operators leave it unset
```
2. **SC2016 directive (C5)** above the Go-template lines (acc30a8 L120-124: the `ports=`, `mounts=` and `sources=` `inspect '{{…}}'` calls). Use `# shellcheck disable=SC2016  # Go template, expanded by docker, not the shell`. Re-run shellcheck after editing (RESEARCH Pitfall 4).
3. **Header rollback pointer** (acc30a8 L16): `/var/lib/substrate/phase5-baseline/RESTORE.d/05-03.md` → `docs/runbooks/desktop.md`.

Keep everything else as is:
- `set -euo pipefail`;
- the constants block (L19-29);
- `die`/`require_root` (L31-38);
- `ensure_env_file` under `umask 077` with `mktemp` → `chmod 600` → `mv` and the password never echoed (L52-67);
- the `cmd_up` order: root → df gate → `docker image inspect` → env file → label check → `start` or `run -d --pull never …` → geometry wait (L69-104);
- the `cmd_status` key=value lines (L106-137);
- the `case` dispatch with usage exit 2 (L139-146).

The `docker run` argv (L85-93) is the D30-14 contract:
```bash
docker run -d --pull never --name "$NAME" \
	--restart unless-stopped --shm-size 1g \
	--label "$LABEL" \
	-p "$PUBLISH" \
	-v "$VOLUME:/config" \
	--env-file "$ENV_FILE" \
	-e TZ=Etc/UTC -e TITLE="Substrate desktop" -e START_DOCKER=false \
	-e SELKIES_MANUAL_WIDTH=1280 -e SELKIES_MANUAL_HEIGHT=800 \
	"$IMAGE" >/dev/null
```
Redaction lock (Phase 18 D18-13, which covers `.sh` under `infra/`): the script must define nothing named `redact*` and carry no `[REDACTED` literal. The September script has neither.

### `scripts/substrate-desktop.test.ts` (test, script under PATH stubs). Partial analog.

There is no PATH-stub shell test in any worktree. Combine these pieces:
- **Spawn with an explicit env.** P16 `rehearsal.test.ts:63-68` spawns with an inherited env; this test must instead use an explicit env, as P16 `rehearsal.ts:329-334` builds one:
```ts
function runCli(...args: string[]): { code: number; out: string; err: string } {
	const child = Bun.spawnSync([process.execPath, CLI, ...args], { env: { ...process.env, SUBSTRATE_TOKEN: SENTINEL } });
	return { code: child.exitCode ?? -1, out: child.stdout.toString(), err: child.stderr.toString() };
}
```
  Use `Bun.spawnSync(["bash", SCRIPT, sub], { env: { PATH: \`${stubDir}:/usr/bin:/bin\`, STUB_LOG, STUB_*, SUBSTRATE_DESKTOP_ENV_FILE } })`. Never spread `process.env`, which carries tokens.
- **Temp-dir lifecycle:** main `git.test.ts:16-35` (`made[]` + `afterAll` rmSync), or acc30a8 driver.test.ts:20-28 (`afterEach`).
- **Stubs:** write `docker`, `df` and `openssl` bash stubs with `writeFileSync(path, body, { mode: 0o755 })`. Each appends `"$0 $*"` (or a JSON line) to `$STUB_LOG` and answers from `STUB_DF_AVAIL`, `STUB_IMAGE` and `STUB_CONTAINER` (the RESEARCH "Lifecycle script tests without Docker" design).
- **Non-root case:** `setpriv --reuid=65534 --regid=65534 --clear-groups bash -s up < script` (RESEARCH Pitfall 3).
- **Optional tools:** run `shellcheck` only when `Bun.which("shellcheck")` is non-null, and `bash -n` always.
- **Assertions:** the full list is in CONTEXT D30-15. The "never `rm|stop|kill|pull` except `--pull never`" scan runs over every scenario's log.

The test lives under `scripts/` because `tsconfig.json` includes only `packages/**/*.ts` and `scripts/**/*.ts`.

---

### `scripts/desktop-smoke.ts` (proof script, MCP over HTTP)

**Analog A, guards and consumer env:** P16 `scripts/rehearsal.ts` exported helpers (*exist after Phase 16 merges*). Import them, do not copy them. The module is side-effect free (L1441 `if (import.meta.main)`).
```ts
// rehearsal.ts:1187-1200 — refuse production ports and non-loopback hosts before any request
export function refuseSmokeUrl(raw: string): string | null { … }
// rehearsal.ts:1203 parseShellExports, :250 runDirFor, :43 RehearsalRefused
```
**Analog B, the run shape and check lines** (P16 `rehearsal.ts:1301-1340`):
```ts
const runDir = runDirFor(name);
const text = readText(join(runDir, "consumer.env"));
if (text === null) throw new RehearsalRefused(`no consumer.env for instance ${name}: run rehearsal up first`);
const record = parseShellExports(text);
const base = (record["SUBSTRATE_URL"] ?? "").replace(/\/+$/, "");
…
const refused = refuseSmokeUrl(base);
if (refused !== null) throw new RehearsalRefused(refused);
…
const results: boolean[] = [];
const check = (ok: boolean, what: string, detail?: string): void => {
	results.push(ok);
	process.stdout.write(`${ok ? "  ok  " : " FAIL "} ${what}${detail ? ` — ${detail}` : ""}\n`);
};
…
const passed = results.filter(Boolean).length;
process.stdout.write(`\n${passed}/${results.length} smoke checks passed\n`);
return passed === results.length ? 0 : 1;
```
Read tokens from `record.SUBSTRATE_REHEARSAL_TOKENS_DIR` + `/<surface>` (`--surface` defaults to `omp`, `--unlisted` to `cursor`). Do not add a sixth consumer key (RESEARCH "Phase 16 harness extension"). The entry and refusal mapping come from P16 `rehearsal.ts:1432-1441`: a `RehearsalRefused` exits 2.

**Analog C, the MCP client** has no repo analog. In-repo clients use `InMemoryTransport` (`mcp.test.ts:44-46`). Use the RESEARCH "Smoke client" probe:
```ts
const client = new Client({ name: "desktop-smoke", version: "0.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
	requestInit: { headers: { authorization: `Bearer ${bearer}` } },
}));
const reply = await client.callTool({ name: "desktop_run", arguments: run }, undefined, { timeout: (run.timeout + 60) * 1000 });
```
The `{ timeout }` option is required (RESEARCH Pitfall 1: the SDK default is 60 s).

**Events read-back:** use `POST /events/query` on the twin (main `server.ts:360-371`, the same service call as `events_query`). The store lock forbids `GREPTIME_` and `.sql(` here. The no-token 401 check reuses `smokeHeaders` semantics (P16 `rehearsal.ts:1228-1234`): omit `authorization` and expect status 401.

**Docker inspect / script status / `:6081`:** use fixed argv with an explicit env, copying P16 `rehearsal.ts:329-349` `docker()` (no shell, bounded timeout). The basic-auth check is a plain `fetch("http://127.0.0.1:6081/")` expecting 401. Never read the env file.

**No-secret output:** follow P16 `rehearsal.ts:1297-1300` ("Prints booleans and decisions only"). Print hashes, sizes and counts, never a token or a password.

### `scripts/desktop-smoke.test.ts` (test, pure helpers)

**Analog:** P16 `scripts/parity-check.test.ts:1-30` (it imports the script's exported pure functions and builds a fixture with defaults overridable by `Partial<>`). The guard tests mirror P16 `rehearsal.test.ts:216-235` (`describe("refuseSmokeUrl")`). Helpers to export and test:
- `markerText(nonce)`, built with `String.raw` (RESEARCH "Typing the marker"); it must pass `DesktopAction` parsing (`TYPEABLE`);
- `nonceRgb(nonce)`, with one channel ≥ 0xC0;
- `findBand(rgb, width, height, colour)` → `{count, rect, solid}`, tested on a synthetic image from `encodePng` → `decodePng`.

### `package.json`

**Analog:** P16 `package.json` `scripts` block:
```json
"smoke:greptime": "bun scripts/greptime-smoke.ts",
"smoke:chaos": "bun scripts/chaos-smoke.ts",
"parity:check": "bun scripts/parity-check.ts",
"rehearsal": "bun scripts/rehearsal.ts"
// + "smoke:desktop": "bun scripts/desktop-smoke.ts"
```
`check:phase-close` arrives with Phase 17 (`scripts/phase-close-check.ts`). Do not add it here.

---

### `README.md` (docs)

**Analog:** main `README.md:123-150` (`## Observability and audit`): a short prose section, a few bullets, then `Details in [docs/…](docs/…)`. Add `## Desktop` (C10: there is no tool list). Say:
- `desktop_run` drives `substrate-desktop` with click/type/key/screenshot;
- only `SUBSTRATE_DESKTOP_SURFACES`-listed surfaces may call it;
- each action is a `tool.call` event (hashes and lengths only);
- link `docs/runbooks/desktop.md`.

Do not name `desktop.action` as a kind (D30-21).

### `docs/runbooks/desktop.md` (new runbook)

**Analog:** P16 `docs/runbooks/production-parity.md` (*exists after Phase 16 merges*). Copy its shape:
- a header key/value table (Requirement, Scope, Untouched) at L1-9;
- "What this runbook proves, and how" (L11);
- commands in fenced `sh` blocks with exit-code semantics (L19-27);
- `## Rollback` (L164);
- `## Who does what` (L232).

Content comes from D30-21: the allowlist variable (with C9: production refuses everyone until Phase 20 tokens exist), `substrate-desktop.sh up|status`, the basic-auth file (by path only), retention (including the note that the first production run prunes the four September run dirs), the key/text hashing rule, the "never type secrets" residual (T-30-05), the network-egress residual (T-30-07), stale in-container xdotool after a timeout (Pitfall 6), and the rollback (unset the variable → every call refused).

### `docs/mcp-audit.md` (docs)

**Analogs:**
- main `docs/mcp-audit.md:222-229` ("## Fail open, fail closed" table; the **fail-closed** row lists tools in backticks);
- P17 `docs/mcp-audit.md:229-241` ("### Planned in v1.3", *exists after Phase 17 merges*):
```md
| `desktop_run` (30) | fail-closed | Acts on a desktop (DESK-03 fixes this). |
```
"Marks `desktop_run` as landed" means two edits: add `` `desktop_run` `` to the fail-closed row at L227, and change or remove the planned row. Follow whatever convention Phase 21 used for `skills_propose` on the same table if it lands first.

### `.env.example`

**Analog:** main `.env.example:56-64` (a comment block explaining semantics and the fail-closed default, then `SUBSTRATE_OPERATOR_TOKENS=`) and `:127-133` (a section header with `# ── … ──` rule, then `SUBSTRATE_AUDIT_PATH=/var/lib/substrate/mcp-audit.jsonl`). Add a `# ── Desktop (desktop_run, DESK-01..05) ──` block with `SUBSTRATE_DESKTOP_SURFACES=` (empty = nobody) and `SUBSTRATE_DESKTOP_DIR=/var/lib/substrate/desktop`, plus one-line comments pointing to `docs/runbooks/desktop.md`.

---

## Shared Patterns

### Caller identity comes from the transport, never from arguments
**Source:** main `server.ts:216-224,254-257`; `mcp.ts:171-175`.
**Apply to:** `mcp.ts` handler, `Substrate.runDesktop`, `http.test.ts` cases.
```ts
const surface: Surface | null = surfaceForToken(config, authorization);
const caller: McpCaller = { surface, isOperator: isOperator(config, authorization) };
…
if (!config.allowAnonymous && surface === null) {
	sendJson(res, 401, { error: "unknown or missing bearer token" });
	return;
}
```
`isOperator` is true on a bare anonymous run (`config.ts:242`). The desktop gate must never consult it (D30-01).

### Fail-closed audit is structural and runs before dispatch
**Source:** main `server.ts:521-528` (`handleMcp`: `auditToolCalls` before `createMcpServer`); `observe.ts:363-417`; `packages/audit/src/record.ts:180-193,242-243` (`argDigest` keeps only sorted keys + sha256 of canonical args).
**Apply to:** nothing new in code. The tool inherits the gate. Tests prove it (http.test.ts D30-13 case; `-32000` on an unwritable audit).

### Refusals are `isError` text containing "nothing was run", with no event and no docker call
**Source:** main `mcp.ts:153-155` (`refusal`), `mcp.ts:356` (`"refused" in …`), `acc30a8 mcp.ts:189`.
**Apply to:** all six pre-run refusals in `runDesktop` and the D30-12 failure (which also carries `{run_id, log}`).

### Fixed argv, injected runner, explicit child env
**Source:** acc30a8 `actions.ts` builders; acc30a8 `driver.ts:51-67` (`BufferRunner`); P16 `rehearsal.ts:329-349` (`docker()` with an allowlisted env); P16 `parity-check.ts:244-252` (`spawn(argv)`, "Fixed argv, no shell, bounded").
**Apply to:** `driver.ts`, `desktop-smoke.ts` (docker inspect, script status), `substrate-desktop.test.ts` (stubbed spawns).

### Hashes and lengths, never content
**Source:** acc30a8 `driver.ts:209` (`sha256` helper), `driver.ts:287` (`text_sha256`); P17 `event-sources.test.ts:71-82` (banned keys); main `redact.ts:53,98` (`redact`, `redactValue`; the key pattern blanks `*token*`, `*secret*` and similar).
**Apply to:** driver payloads, smoke output, runbook examples. Never name a payload field with `token`/`secret`/`password`.

### Redaction from the one shared module
**Source:** main `packages/mcp-server/src/redact.ts` (`export function redact`, L53). Phase 18 adds `redact-lock.test.ts` (D18-13; *planned in Phase 18, not yet tracked on the P18 branch*).
**Apply to:** `driver.ts` (`import { redact } from "../redact.ts"`), any error string in `service.ts`/`mcp.ts`. Define no local `redact*`, and write no `[REDACTED` literal (import `REDACTED` if a test needs it).

### Store-lock and token-literal hygiene
**Source:** main `store-lock.test.ts:95` (`TOKEN_LITERAL`), `:144-152` (`.sql(` restriction); P16 `rehearsal-env.ts:197-199`:
```ts
// Short local, never a long name: a 16+ character identifier after the
// client token key would trip the store lock's token scan.
const token = input.firstToken;
```
**Apply to:** `scripts/desktop-smoke.ts`, `scripts/substrate-desktop.test.ts`, every new test.
- No `GREPTIME_` under `scripts/`.
- Test tokens stay short (`tok-omp`).
- The smoke reads events only via `POST /events/query`.

### Test temp-dir lifecycle and module-scope state
**Source:** acc30a8 `driver.test.ts:20-28` (`dirs[]` + `afterEach`), main `git.test.ts:16-35` (`made[]` + `afterAll`).
**Apply to:** every desktop test. Every test that starts a driver run must await it, so the module busy flag never leaks (RESEARCH Pitfall 5).

### One test file per command in verification
**Source:** RESEARCH Pitfall 11 / P17 17-RESEARCH: Bun treats several paths as filters and exits 0 if one matches.
**Apply to:** every `<automated>` verify line the planner writes: `bun test ./path/to/one.test.ts`.

## No Analog Found

| File / piece | Role | Data Flow | Reason / what to use instead |
|---|---|---|---|
| `decodePng` in `desktop/png.ts` | utility | transform | No PNG decoder in the repo. Use the RESEARCH "Minimal decoder" block (filter-0 only), mirroring `chunks()` in acc30a8 driver.test.ts:69-81 |
| `keyFields` (D30-11 tightened key rule) | utility | transform | New policy. Implement from CONTEXT D30-11 / RESEARCH C6, not RESEARCH Pattern 5's literal rule |
| PATH-stub harness in `scripts/substrate-desktop.test.ts` | test | subprocess | No shell-script test exists anywhere in the repo. Compose it from the spawn/env/temp-dir analogs above and the RESEARCH design |
| `StreamableHTTPClientTransport` usage in `scripts/desktop-smoke.ts` | client | request-response | In-repo clients use `InMemoryTransport` only. Use the RESEARCH probe (SDK 1.30.1) with an explicit `{ timeout }` |
| `findBand` / marker helpers | utility | transform | New. Follow RESEARCH "Pixel marker" |
| `30-N1-SPIKE.md` | planning artifact | — | Follow RESEARCH "Spike plan (D30-18)", steps 1-6 |

## Metadata

**Analog search scope:**
- main: `packages/mcp-server/src/{mcp,service,config,observe,server,index,types,redact,memory-policy,event,mcp.test,http.test,graph-bind.test,authority.test,server.authority.test,git.test,observe.test,store-lock.test}.ts`, `packages/audit/src/{policy,policy.test,record}.ts`, `README.md`, `docs/mcp-audit.md`, `.env.example`, `infra/`, `scripts/`.
- acc30a8: `packages/mcp-server/src/desktop/{actions,driver}{,.test}.ts`, `infra/desktop/substrate-desktop.sh`, `packages/mcp-server/src/{mcp,service}.ts` (desktop parts).
- P16: `scripts/{rehearsal,rehearsal.test,parity-check,parity-check.test}.ts`, `packages/mcp-server/src/rehearsal-env{,.test}.ts`, `docs/runbooks/production-parity.md`, `package.json`.
- P17: `packages/mcp-server/src/event-sources{,.test}.ts`, `docs/event-vocabulary.md`, `docs/mcp-audit.md`, `packages/audit/src/policy{,.test}.ts`, `scripts/phase-close-check.ts`.
- P18: `packages/mcp-server/src/redact*` (the lock test is not yet present on that branch).
- P21: `.planning/phases/21-skills-propose/21-PATTERNS.md` (the seam, config, observe, rehearsal and smoke sections).

**Files scanned:** ~40
**Pattern extraction date:** 2026-10-08
