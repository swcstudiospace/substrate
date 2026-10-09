# Phase 16: Production parity and rehearsal harness - Pattern Map

**Mapped:** 2026-10-08
**Files analyzed:** 11 (6 new code/test, 2 new docs, 3 modified)
**Analogs found:** 11 / 11 for structure; 3 capabilities have no in-repo analog (docker lifecycle, detached spawn, systemd/`ss`/`/proc` parsing) and use RESEARCH.md §6-§9 instead.

> **Writing rule for this file and every file it describes.** `.planning/` is tracked, so `store-lock.test.ts` scans it.
> No excerpt below puts a value after a Greptime URL/user/password key or gives a substrate token key a 16+ character
> value. The store-lock section under "Shared Patterns" is the checklist every new file must pass.

All analog paths below were checked with `git ls-files` in this worktree (HEAD `3993b48`). None is a gitignored mirror.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `scripts/rehearsal.ts` (new) | ops CLI script (`up\|down\|status\|smoke`) | process + file-I/O lifecycle; request-response (smoke) | CLI shape: `packages/projector/src/swarm-workspace.ts`; smoke/HTTP: `scripts/chaos-smoke.ts`; spawn: `packages/mcp-server/src/git.ts` | role-match (no docker/detach analog) |
| `scripts/rehearsal.test.ts` (new) | test (pure guards) | transform | `packages/mcp-server/src/server.test.ts` (pure verdict table); `packages/projector/src/swarm-workspace.test.ts` (CLI + sentinel) | role-match |
| `packages/mcp-server/src/rehearsal-env.ts` (new) | utility / config builder | transform (inputs → env record, files' text) | `packages/mcp-server/src/config.ts` (`loadConfig`, `tokenEnvName`) | exact (inverse of it) |
| `packages/mcp-server/src/rehearsal-env.test.ts` (new) | test | transform round-trip | `packages/mcp-server/src/authority.test.ts` (`loadConfig` + `configWarnings`); sentinel from `swarm-workspace.test.ts` | exact |
| `scripts/parity-check.ts` (new) | ops CLI script, read-only | batch read (subprocess + procfs + one fetch) → verdict | git calls: `packages/mcp-server/src/git.ts`; report/exit: `scripts/chaos-smoke.ts`; CLI shape: `swarm-workspace.ts` | role-match (no systemctl/ss/proc analog) |
| `scripts/parity-check.test.ts` (new) | test (parsers + verdict) | transform | `packages/mcp-server/src/server.test.ts` `healthStatus`; `packages/mcp-server/src/git.test.ts` | role-match |
| `package.json` (mod) | config | — | itself, lines 23-24 | exact |
| `infra/vps/substrate-mcp.service` (mod) | config (systemd unit) | — | itself lines 1-9; `infra/vps/substrate-collector-grok.service` lines 1-7 | exact |
| `docs/rehearsal.md` (new) | doc, flat topic | — | `docs/observability.md` §"The chaos smoke" (271-314) + §"Configuration" (333-364); `docs/greptime-ledger.md` §"Smoke test" (340-367) | exact |
| `docs/runbooks/production-parity.md` (new; creates `docs/runbooks/`) | doc, operator runbook | — | `docs/receipts/SPE-4789-greptime-events-query.md` (header table, "commands as run"); operator sh blocks from `docs/observability.md` 279-292 | partial (no runbook exists yet) |
| `README.md` (mod) | doc index | — | itself, §"Running" lines 81-98 and doc-link style lines 13-14, 148-149 | exact |

Optional, Claude's discretion: one cross-reference sentence in `docs/observability.md` §"The chaos smoke" (near line 302, the `CHAOS_REHEARSAL=1` paragraph) pointing at `docs/rehearsal.md`, to keep the two meanings of "rehearsal" apart (RESEARCH Pitfall 13). A `docs/runbooks/README.md` index modelled on `docs/adr/README.md` is **not** required by CONTEXT; skip unless the planner wants the type directory to carry an index like `adr/`.

---

## Pattern Assignments

### `scripts/rehearsal.ts` (ops CLI, process lifecycle + request-response)

**Analog A — CLI skeleton that exports pure parts and only runs as entry module:** `packages/projector/src/swarm-workspace.ts` (the only `import.meta.main` user in the repo).

Usage/refusal (lines 544-550):
```ts
function usage(message: string): never {
	process.stderr.write(
		`[projector] ${message}\nusage: swarm-workspace.ts --workspace <ws> [--runtimes ${RUNTIMES.join(",")}] --plan|--check|--apply\n` +
			"       swarm-workspace.ts --spec\n",
	);
	process.exit(2);
}
```

Arg parsing + mode dispatch + typed refusal → exit 2 (lines 552-585, abridged):
```ts
function main(argv: string[]): number {
	const at = argv.indexOf("--workspace");
	const workspace = at >= 0 ? argv[at + 1] : undefined;
	if (!workspace) usage("--workspace is required");
	const modes = ["--plan", "--check", "--apply"].filter((mode) => argv.includes(mode));
	if (modes.length !== 1) usage("give exactly one of --plan, --check, --apply");
	const rt = argv.indexOf("--runtimes");
	const runtimes = rt >= 0 ? (argv[rt + 1] ?? "").split(",").map((r) => r.trim()).filter(Boolean) : RUNTIMES;
	…
	} catch (cause) {
		if (cause instanceof ProjectionRefused) {
			process.stderr.write(`[projector] refused: ${cause.message}.\n`);
			return 2;
		}
		throw cause;
	}
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
```
Copy: a `RehearsalRefused extends Error` class (cf. `export class ProjectionRefused extends Error {}`, line 105), a `[rehearsal]` log prefix, `--name/--port/--surfaces/--operator/--anonymous` read with the same `indexOf` idiom, subcommand from `argv[0]`. `main` is `async` here (fetch/healthz poll), so the guard becomes `if (import.meta.main) process.exit(await main(process.argv.slice(2)));`.

**Analog B — the `smoke` subcommand's HTTP client:** `scripts/chaos-smoke.ts`. Its helpers cannot be imported (top-level side effects, line 185 onwards runs on import), so copy them (RESEARCH §3 recommends copying over a shared module).

Headers, both media types for `/mcp` (lines 62-73):
```ts
function headers(): Record<string, string> {
	const token = process.env.SUBSTRATE_TOKEN?.trim();
	return {
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
		...(token ? { authorization: `Bearer ${token}` } : {}),
	};
}
```
For the harness, the token comes from the parsed `consumer.env`, not `process.env`, and is passed in (pure `headers(token)`), so `up`'s healthz poll can reuse it with the first surface's token (RESEARCH Pitfall 1).

`parseBody` (JSON, else last SSE `data:` frame) — lines 84-102; `Attempt` + `call(path, body?)` with `AbortSignal.timeout` — lines 104-126; `tool(id, name, args)` as stateless JSON-RPC — lines 146-148; `whyNoDecision` — 151-159; `toolResult` (parses `result.content[0].text`) — 162-172. Copy verbatim with `BASE` made a parameter.

Report helpers and run-tagged ids (lines 56-57, 128-137):
```ts
const GRAPH_ID = `ut-chaos-${Date.now().toString(36)}`;
const SESSION_ID = `chaos-${Date.now().toString(36)}`;
…
const results: Array<{ ok: boolean; what: string; detail?: string }> = [];

function check(ok: boolean, what: string, detail?: string): void {
	results.push({ ok, what, detail });
	process.stdout.write(`${ok ? "  ok  " : " FAIL "} ${what}${detail ? ` — ${detail}` : ""}\n`);
}

function note(what: string, detail?: string): void {
	process.stdout.write(`  --   ${what}${detail ? ` — ${detail}` : ""}\n`);
}
```
Harness tag is `rh-<name>-<timestamp>` (CONTEXT); use it for both `graph_id` and `session_id`.

Register then claim, reading the claim's own decision (lines 213-219, 291-293):
```ts
const registered = await tool(0, "graph_register", {
	graph_id: GRAPH_ID,
	repo: "swcstudiospace/agent-substrate",
	branch: "chaos-smoke",
	nodes: [{ node_id: NODE_ID }],
});
const graphRegistered = toolResult(registered) !== null;
…
const decisions = claims.map((attempt) => toolResult(attempt)?.decision);
const granted = decisions.filter((decision) => decision === "granted");
```
Harness asserts `claimed === true && decision === "granted"` and prints only `claimed`/`decision` — never the reply body (`lease.lease_id` is a capability, RESEARCH Pitfall 14). Note chaos-smoke line 199 prints the `/healthz` JSON wholesale; that is fine for health (no secret) but do not extend the habit to claim replies.

Host-only print (lines 174-182) and summary/exit (lines 367-385):
```ts
const host = (() => {
	try {
		return new URL(BASE).host;
	} catch {
		return "(unparseable SUBSTRATE_URL)";
	}
})();
…
const failed = results.filter((result) => !result.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
…
process.exit(failed.length === 0 ? 0 : 1);
```
Unreachable/precondition → exit 2 (lines 185-196: `if (boot.status === null) { …; process.exit(2); }` and the 401 branch). Mirror for "consumer.env missing" and "SUBSTRATE_URL is :7410 or non-loopback".

**Analog C — subprocess with fixed argv, no shell, bounded:** `packages/mcp-server/src/git.ts` lines 20, 40-49:
```ts
const GIT_TIMEOUT_MS = 3000;
…
function git(path: string, args: string[]): string | null {
	const run = Bun.spawnSync(["git", "-C", path, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		timeout: GIT_TIMEOUT_MS,
	});
	if (run.exitCode !== 0) return null;
	const out = run.stdout.toString().trim();
	return out.length > 0 ? out : null;
}
```
Copy as a `docker(args, env)` helper. Differences required by CONTEXT/RESEARCH: pass an explicit minimal `env` (`PATH`, `HOME`, `DOCKER_HOST`/`DOCKER_CONFIG` if set, plus the one secret by name for `-e POSTGRES_PASSWORD` / `-e RH_GT_USERS`), never `process.env`; never `-e KEY=value`. Shapes for `docker run` and the server spawn are in RESEARCH "Code Examples" (container start, `Bun.spawn([process.execPath, "--no-env-file", "packages/mcp-server/src/index.ts"], { detached: true, stdout: fd, stderr: fd })` + `unref()`).

**What the spawned server prints and how it stops** (for `up` log scraping and `down` wait): `packages/mcp-server/src/index.ts` lines 35-45 (`[substrate] listening on http://${config.host}:${config.port} (…)`) and 50-65 (SIGINT/SIGTERM → `server.close` → bounded 2 s flush → `process.exit(0)`). `down` sends SIGTERM to the verified pid, waits (bounded, ~10 s), re-verifies, then SIGKILL the same pid.

**Imports:** `scripts/greptime-smoke.ts` lines 32-36 show the cross-package import spelling scripts use:
```ts
import { randomUUID } from "node:crypto";
import { loadConfig } from "../packages/mcp-server/src/config.ts";
```
So: `import { buildRehearsalEnv, … } from "../packages/mcp-server/src/rehearsal-env.ts";` and `import { SURFACES, isSwarmSurface } from "../packages/mcp-server/src/types.ts";` (types.ts 30-48). `.ts` extensions are mandatory (`tsconfig.json`: `allowImportingTsExtensions`, `verbatimModuleSyntax` → type-only imports use `import type`).

**File docblock:** copy the shape of `scripts/chaos-smoke.ts` lines 1-49 / `scripts/greptime-smoke.ts` lines 1-31: `#!/usr/bin/env bun`, `/** … */` with the `bun run rehearsal …` usage line, what it proves, "it holds no ledger client", "nothing printed but hosts". Must not contain the substring `GREPTIME_` — even in this comment (store lock, see Shared Patterns).

**No analog — use RESEARCH:** docker container lifecycle and readiness (§6, §7, "Don't Hand-Roll"), detached spawn (§9), `mayStop` pid-ownership (Pattern 1 in RESEARCH Architecture Patterns), port refusal/bind probe, `statfsSync` disk floor.

---

### `scripts/rehearsal.test.ts` (test, pure guards)

**Analog A — pure decision table:** `packages/mcp-server/src/server.test.ts` lines 1-38:
```ts
import { createHttpServer, healthStatus, memoryWriteStatus, memoryWriter } from "./server.ts";
…
/** Shorthand for a health report; every field defaults to the unhealthy value. */
function health(over: Partial<Parameters<typeof healthStatus>[0]> = {}) {
	return { index: false, greptime: false, eventsWritable: false, ...over };
}

describe("healthStatus", () => {
	test("503 when a configured ledger cannot take writes, even with a healthy index", () => {
		// The regression: …
		expect(healthStatus(health({ index: true, greptime: true, eventsWritable: false }), true)).toBe(503);
	});
```
Copy for `mayStop`: a `proc(over)` builder whose defaults are the *safe-to-stop* facts, then one test per refusal (wrong cmdline, cwd, start time, `/system.slice/` cgroup, listening on 7410/7411/6420). Same for `refusePort` and the smoke URL guard.

**Analog B — CLI driven as a subprocess with a sentinel that must never leak:** `packages/projector/src/swarm-workspace.test.ts` lines 17-42:
```ts
const CLI = join(import.meta.dir, "swarm-workspace.ts");
/** What a real token would be: if the projector ever expanded the environment, this is the string that would leak. */
const SENTINEL = "p14-sentinel-token-7f3a9c";
…
function run(...args: string[]): { code: number; out: string; err: string } {
	const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
		env: {
			...process.env,
			SUBSTRATE_URL: "http://127.0.0.1:7499",
			SUBSTRATE_TOKEN: SENTINEL,
		},
	});
	return { code: proc.exitCode ?? -1, out: proc.stdout.toString(), err: proc.stderr.toString() };
}
```
Use for argument-refusal paths that exit before Docker (`--port 7410` → exit 2, `--operator swarm-a05-be` → exit 2, `smoke` with `SUBSTRATE_URL` on :7410 → exit 2). Note the short identifier `SENTINEL` after the token key: a 16+ character identifier there trips `TOKEN_LITERAL`.

**Temp dirs + cleanup:** `packages/mcp-server/src/git.test.ts` lines 16-34 (`mkdtempSync(join(tmpdir(), "substrate-git-"))`, `made.push(dir)`, `afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); })`). Use for a fake run dir when testing `state.json` read/`down` idempotence on a missing dir.

**Constraint:** this file must not contain `GREPTIME_` (it is outside `packages/mcp-server/src`). Treat `stores.env` as opaque here; its contents are tested in `rehearsal-env.test.ts`.

---

### `packages/mcp-server/src/rehearsal-env.ts` (config builder, transform)

**Analog:** `packages/mcp-server/src/config.ts` — the builder is the inverse of `loadConfig`, so it must emit exactly the keys `loadConfig` reads.

Header docblock style (lines 1-6):
```ts
/**
 * Configuration, loaded from the environment.
 *
 * Deployment reads /etc/substrate/substrate.env via the systemd unit's
 * EnvironmentFile. Nothing here ever reads a secret from the repo.
 */
import { normalizeTtlSeconds } from "./lease.ts";
import { SWARM_SURFACES, isSwarmSurface, type Surface } from "./types.ts";
```

Token key derivation to reuse, not re-implement (lines 110-113):
```ts
/** "swarm-a05-be" → "SUBSTRATE_TOKEN_SWARM_A05_BE": the inverse of `envSuffixToSurface`. */
export function tokenEnvName(surface: Surface): string {
	return `SUBSTRATE_TOKEN_${surface.toUpperCase().replace(/-/g, "_")}`;
}
```

Keys the built env must cover (lines 153-191, the ones that matter): `SUBSTRATE_HOST` (default `127.0.0.1`), `SUBSTRATE_PORT` (default 7410 — always set it explicitly), the four Greptime keys read at lines 154 and 164-166, `SUBSTRATE_PG_URL` (169), `SUBSTRATE_TOKEN_*` via `readTokens` (120-127; `allowAnonymous` = no tokens, 176), `SUBSTRATE_OPERATOR_TOKENS` as comma-separated **token values** (177-182), `SUBSTRATE_AUDIT_PATH` (a file path, 188), `SUBSTRATE_HANDOFF_KEY` (+ default id `k1`, 142-145). Leave `SUBSTRATE_CLAIM_REQUIRE_LEDGER` unset (189: `booleanOrNull`, null → fail-closed with a ledger).

Computed keys — the established spelling that keeps a key name out of `KEY: value` position. `authority.test.ts` line 231:
```ts
const config = loadConfig({ [tokenEnvName(surface)]: `tok-${surface}` });
```
For the ledger keys, RESEARCH §4 shape (safe against the CREDENTIAL regex because each key literal is followed by `"` then `,`):
```ts
const LEDGER_KEYS = { url: "GREPTIME_URL", user: "GREPTIME_USER", password: "GREPTIME_PASSWORD", db: "GREPTIME_DB" } as const;
const env: Record<string, string> = {};
env[LEDGER_KEYS.url] = `http://127.0.0.1:${ports.greptime}`;
env[LEDGER_KEYS.user] = scratch.greptimeUser;
```
Also: never name an object property or variable `greptime_url` / `greptime_user` / `greptime_password` followed by `:`/`=` — the CREDENTIAL regex is case-insensitive. camelCase (`greptimeUser`) is safe.

Warnings that describe surfaces, never tokens (lines 299-301, comment `// Named by surface, never by token: the warning goes to a log.`). Any error message `assertLoopback`/`buildRehearsalEnv` throws names the key and host:port, never the value.

Allowlist: no analog in repo (config always reads `process.env` whole). Build from `PATH`, `HOME`, `BUN_*` of the given parent env plus scratch values (RESEARCH Architecture diagram). Exports to plan: `buildRehearsalEnv`, `assertLoopback`, `storesEnvRecord`, `consumerEnvRecord` (+ a `toShellExports(record)` writing `export KEY='value'` lines, RESEARCH Pattern 3). In `consumerEnvRecord`, the line that sets the client token key must use a short value identifier (e.g. `token`), never a 16+ character name.

---

### `packages/mcp-server/src/rehearsal-env.test.ts` (test, round-trip)

**Analog:** `packages/mcp-server/src/authority.test.ts`.

Imports (lines 16-22):
```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configWarnings, isOperator, loadConfig, surfaceForToken, swarmTokenWarnings, tokenEnvName } from "./config.ts";
import { SURFACES, SWARM_SURFACES, type SubstrateEvent } from "./types.ts";
```

Round-trip assertions (lines 70-75):
```ts
const stranded = loadConfig({ SUBSTRATE_TOKEN_HERMES: "tok-hermes", SUBSTRATE_OPERATOR_TOKENS: "tok-nowhere" });
expect(configWarnings(stranded)).toHaveLength(1);
expect(configWarnings(stranded)[0]).toContain("cannot authenticate");

expect(configWarnings(loadConfig(TOKENS))).toEqual([]);
```
Copy as: `const config = loadConfig(buildRehearsalEnv(…))` → `configWarnings(config)` is `[]`, `config.tokens.size === surfaces.length`, `config.allowAnonymous === false`, operator ⊆ tokens, `config.greptime?.url` host is `127.0.0.1` on the given port, `config.audit.path` inside the run dir, `config.handoffKeyId === "k1"`; `--anonymous` variant gives `allowAnonymous === true` and `operatorTokens.size === 0`. `isOperator(config, \`Bearer ${token}\`)` (lines 41-54 pattern) for the operator surface. `swarmTokenWarnings` is expected non-empty for a token-configured twin (RESEARCH §1) — assert it, do not treat as failure.

Leak test: plant a sentinel under `LINEAR_API_KEY`, `NOTION_API_KEY`, an `OTEL_*` key, a parent token key and the ledger keys (via `LEDGER_KEYS`) in the parent env passed to the builder, then assert `JSON.stringify(env)` does not contain it (sentinel idea from `swarm-workspace.test.ts` lines 18-19). Generated tokens come from the builder at runtime; no literal tokens in the file.

Temp dir for audit path: `packages/mcp-server/src/http.test.ts` lines 63-66:
```ts
function auditDirectory(): string {
	return join(mkdtempSync(join(tmpdir(), "substrate-http-")), "mcp-audit.jsonl");
}
```

Assertions on ledger keys always go through `env[LEDGER_KEYS.url]` etc., never an object literal that writes a ledger key directly before a colon and a value.

---

### `scripts/parity-check.ts` (read-only ops CLI, batch read → verdict)

**Analog A — read-only git with no shell, and "could not ask" ≠ "no":** `packages/mcp-server/src/git.ts`.

Absolute-path guard (lines 33-38):
```ts
export function isReadableCheckout(path: string): boolean {
	if (typeof path !== "string" || !path.startsWith("/")) return false;
	if (path.includes("\0")) return false;
	// A worktree's `.git` is a file, not a directory, so existence is the test.
	return existsSync(path) && existsSync(join(path, ".git"));
}
```
Tri-state commit presence (lines 79-89):
```ts
export function checkoutKnowsCommit(path: string, sha: string): boolean | null {
	if (!isReadableCheckout(path)) return null;
	if (!/^[0-9a-f]{7,40}$/i.test(sha)) return null;
	const run = Bun.spawnSync(["git", "-C", path, "cat-file", "-e", `${sha}^{commit}`], {
		stdout: "pipe",
		stderr: "pipe",
		timeout: GIT_TIMEOUT_MS,
	});
	// 128 is git's "not a valid object name"; any other non-zero is a failure to
	// answer rather than a negative answer.
	if (run.exitCode === 0) return true;
	return run.exitCode === 1 || run.exitCode === 128 ? false : null;
}
```
Copy the helper shape, adding `--no-optional-locks` as the first git argument on **every** call (`["git", "--no-optional-locks", "-C", path, …]`). Importing `checkoutKnowsCommit` itself is acceptable but it omits `--no-optional-locks`; `cat-file -e` takes no index lock, so either reuse it or copy it — state the choice in the plan. Never `fetch`/`pull`/`checkout`; `ls-remote` only (RESEARCH §8, Pitfall 12).

**Analog B — report and exit:** `scripts/chaos-smoke.ts` `check`/`note` (128-137) and summary (367-385). Warnings (unit diff, other `substrate-*` units) go through `note`, never `check`, so they cannot fail criterion 3. Optional `--json` emits the reading for the runbook log (CONTEXT discretion).

**Analog C — CLI shape:** `swarm-workspace.ts` `main(argv)` + `if (import.meta.main)` (552-587), so `parseSystemctlShow`, `parseSsListeners`, `parseCgroup`, `procStartSeconds`, `parseReflogTime`, `parityVerdict` are exported and testable.

**The production `/healthz` probe:** shape from `chaos-smoke.ts` lines 185-196 (status null → unreachable; 401 → distinct message). Send `SUBSTRATE_TOKEN` from the caller's env when set, never print it (RESEARCH §2). The 401 gate it may hit: `packages/mcp-server/src/server.ts` lines 254-257:
```ts
if (!config.allowAnonymous && surface === null) {
	sendJson(res, 401, { error: "unknown or missing bearer token" });
	return;
}
```

**No analog — use RESEARCH §8:** `systemctl show` key=value parsing (order-independent, `--timestamp=unix`), `ss -ltnpH` multi-pid parsing, cgroup v2 line, `/proc/<pid>/stat` field 22 after the last `)`, reflog `%gd` with `--date=unix`. Fixtures are the verbatim outputs in RESEARCH §8.

**Constraints:** no `GREPTIME_` substring; no `agent_events` SQL (the `rh-` prefix-count SQL lives only in the runbook); never print an environment value (`systemctl show` must not be asked for `Environment`/`EnvironmentFiles` values beyond the path).

---

### `scripts/parity-check.test.ts` (test, parsers + verdict)

**Analog A:** `packages/mcp-server/src/server.test.ts` lines 10-38 (builder with failing defaults + one `test` per rule). For `parityVerdict`, the builder's defaults are the RESEARCH §8 passing reading (MainPID 1525582 owns 127.0.0.1:7410, cgroup `0::/system.slice/substrate-mcp.service`, start 1791479652 > HEAD move 1791469658, clean paths, zero diff), then flip one fact per test. Add a test that warnings never change the exit verdict.

**Analog B:** `packages/mcp-server/src/git.test.ts` lines 18-34 `tempRepo()` — use only if the plan tests the git helpers against a real temp repo (`git init --initial-branch=main`, local config). Never point a test at the operator checkout.

Comment style: each test carries a one-line "why" comment, as in `server.test.ts` lines 17-19 and `git.test.ts` lines 42-44.

---

### `package.json` (config)

**Analog:** itself, `scripts` block lines 18-25:
```json
    "mcp": "bun packages/mcp-server/src/index.ts",
    "substrate": "bun packages/cli/src/index.ts",
    "smoke:greptime": "bun scripts/greptime-smoke.ts",
    "smoke:chaos": "bun scripts/chaos-smoke.ts"
```
Add, same style: `"rehearsal": "bun scripts/rehearsal.ts"` and `"parity:check": "bun scripts/parity-check.ts"`. Two-space JSON indent. No dependency change.

---

### `infra/vps/substrate-mcp.service` (systemd unit)

**Analog:** itself, `[Unit]` lines 1-9:
```ini
[Unit]
Description=Agent Substrate MCP server (brief, memory, events, graph)
Documentation=https://github.com/swcstudiospace/agent-substrate
After=network-online.target
Wants=network-online.target
# The stores are external (Railway); a network blip must not trip the start
# limit and leave the unit dead. This key only takes effect in [Unit] —
# systemd ignores it under [Service].
StartLimitIntervalSec=0
```
Add `ConditionPathExists=/root/src/repos/agent-substrate/packages/mcp-server/src/index.ts` directly after `StartLimitIntervalSec=0`, preceded by a `#` comment in the same voice (why: a missing entry point is skipped silently instead of crash-looping into six-figure `NRestarts`; a skipped start does not enter `failed`; absolute path required). Keep `StartLimitIntervalSec=0` and the `StateDirectory` block (lines 21-27) unchanged. Machine-specific path note style: line 16 `# Machine-specific: \`command -v bun\`. Adjust when deploying elsewhere.` — mirror it for the condition path. Sibling `infra/vps/substrate-collector-grok.service` lines 1-7 shows the same `[Unit]` comment-then-key convention.

Verification: `systemd-analyze verify infra/vps/substrate-mcp.service` (RESEARCH, exit 0 today).

---

### `docs/rehearsal.md` (flat topic doc)

**Analog A:** `docs/observability.md`.
- Title + ownership line (lines 1-4): `# OTLP metrics, traces and SLOs` / `Tracked as SPE-4793. Owned by …`.
- Store-lock section first (lines 6-21), with a 3-column table of what holds what and how it is reached — mirror as "Isolation" (scratch stores, loopback, which file holds which values).
- Operator sh blocks with comment lines inside (lines 284-292).
- Configuration table (lines 333-358): `| Variable | Default | |` with `---` header — use for `SUBSTRATE_REHEARSAL_GREPTIME_IMAGE`, `SUBSTRATE_REHEARSAL_PG_IMAGE`, `XDG_RUNTIME_DIR`, and the `consumer.env` contract (`SUBSTRATE_URL`, `SUBSTRATE_TOKEN`, `SUBSTRATE_REHEARSAL_TOKENS_DIR`, `SUBSTRATE_REHEARSAL_NAME`, `SUBSTRATE_TEST_PG_URL`). Key names in backticks only, no `KEY=value`.

**Analog B:** `docs/greptime-ledger.md` §"Smoke test" lines 340-367: command block, then "Exits 0 when every check passes, 1 on a failure, 2 when …", "It prints the host and database only — no credential", numbered list of checks, then what the rows it writes look like and why they are harmless. Mirror for `rehearsal smoke` (rows are `rh-`-tagged and land only in scratch stores).

**Must state:** the two meanings of "rehearsal" (harness vs `CHAOS_REHEARSAL`, cf. `docs/observability.md` lines 302-308); that `stores.env` is sourced only by store-client proofs; that `consumer.env` never carries the ledger keys. Name the ledger keys without values — a `.md` line is scanned by CREDENTIAL unless it starts with `#`, `//`, `*` or `<!--`.

Linking: relative links in backticks, as `[\`mcp-audit.md\`](mcp-audit.md)` (observability.md line 364).

---

### `docs/runbooks/production-parity.md` (operator runbook; new type directory)

**No runbook exists yet.** Closest structure: `docs/receipts/SPE-4789-greptime-events-query.md`.
- Header key/value table (lines 3-9):
```markdown
| | |
| --- | --- |
| Ticket | [SPE-4789](https://linear.app/swcstudio/issue/SPE-4789) — … |
| Run | `20260930T065417Z-39274714` (Grok Bot → Claude Code) |
| Branch | `claude/greptime-events-ledger-7kwlr2`, from `main` |
| Scope | GreptimeDB events ledger behind `substrate-mcp` only |
| Untouched | Timescale SoR, Dragonfly, Hindsight, RAGflow, and every open PR |
```
  Mirror as: Requirement (FOUND-03), Window (operator, ~17:14 UTC 2026-10-08, pid 3149064 retired), Last known-good commit, Scope, Untouched.
- "Commands as run, in the repo root. … no command in this file carries a credential" (lines 37-40) → the evidence section, with ``` blocks of `bun run parity:check` output and a dated readings table (`NRestarts`, `ExecMainStartTimestamp`, MainPID) per RESEARCH Open Question 2.
- Operator steps as sh blocks with `# terminal …` comments, as `docs/observability.md` lines 284-292 does for `iptables`.

Required sections (CONTEXT): identify a stray holder (`ss -ltnp`, `/proc/<pid>/cgroup`) and how to tell a harness twin from a stray (port ≠ 7410, cwd = worktree, `state.json`); install the repo unit (backup outside repo → copy → `daemon-reload` → restart → `parity:check`); rollback (known-good commit + `systemctl restart`; unit backup restore); the two read-only `rh-` count SQL statements from RESEARCH "Code Examples" (they may live here because `.md` is not scanned by the `agent_events` SQL rule — it applies only to `**/*.ts`); agent vs operator boundary list. The SQL lines must not carry any connection string.

---

### `README.md` (doc index)

**Analog:** itself, §"Running" lines 81-98:
```markdown
## Running

```sh
bun install
cp .env.example /etc/substrate/substrate.env   # then fill it in; chmod 0600
bun run mcp                                    # substrate-mcp on :7410
bun test
bun run check                                  # tsc --noEmit
```

Against a live Greptime, `bun run smoke:greptime` proves the ledger end to end — …
```
Add one paragraph after line 98 in the same voice: `bun run rehearsal up|smoke|down` stands up a scratch twin on loopback (link [`docs/rehearsal.md`](docs/rehearsal.md)), and `bun run parity:check` is the read-only production check (link [`docs/runbooks/production-parity.md`](docs/runbooks/production-parity.md)). Link spelling as lines 13-14 / 148-149.

---

## Shared Patterns

### Store lock (applies to every new or modified file, `.planning/` and `docs/` included)
**Source:** `packages/mcp-server/src/store-lock.test.ts`.
- Exemption scope (lines 34, 39-41): only paths under `packages/mcp-server/src` and exactly `scripts/greptime-smoke.ts` may mention the ledger:
```ts
const SMOKE_HARNESS = join("scripts", "greptime-smoke.ts");
…
function mayReachLedger(path: string): boolean {
	return path.startsWith(LEDGER_PACKAGE) || path === SMOKE_HARNESS;
}
```
- `**/*.ts` outside the exemption (lines 108-130): no import specifier ending in `greptime` / no `new GreptimeClient`; no `(FROM|INTO|UPDATE|TABLE) agent_events`; **no `GREPTIME_` substring at all, comments included** → `scripts/rehearsal.ts`, `scripts/rehearsal.test.ts`, `scripts/parity-check.ts`, `scripts/parity-check.test.ts`.
- Every tracked file, exempt package included (lines 75-80, 268-278): the CREDENTIAL regex (case-insensitive) fires on a Greptime URL/USER/PASSWORD key followed by `:`/`=` and a non-space, non-quote character, on any line not starting with `#`, `//`, `*`, `<!--`; RAILWAY_HOST fires on any Railway hostname. → computed keys in `rehearsal-env.ts` and its test; key names only in docs; no snake_case ledger identifiers (`greptime_url`, `greptime_user`, `greptime_password`) followed by a colon or equals sign; camelCase is safe.
- Every tracked file, comments **not** exempt (lines 95, 324-333): TOKEN_LITERAL fires on `SUBSTRATE_TOKEN*` followed by `:`/`=` and 16+ chars of `[\w.~+/=-]` → short identifiers after token keys (`SENTINEL`, `token`), computed keys via `tokenEnvName(surface)`, runtime-generated tokens only.
- The store lock file itself is not edited (CONTEXT).

### Fixed-argv subprocesses, bounded, no shell
**Source:** `packages/mcp-server/src/git.ts` lines 20, 40-49 (excerpt above).
**Apply to:** every `docker`, `git`, `systemctl`, `ss` call in both scripts. Add an explicit `env` for `docker` (minimal) and `--no-optional-locks` for `git`.

### Nothing secret is printed; hosts, pids, states and commits only
**Source:** `scripts/chaos-smoke.ts` lines 14-17 docblock ("Nothing here reads a credential and nothing is printed but a host and a count") and 174-182 (`new URL(BASE).host`); `scripts/greptime-smoke.ts` lines 7-10; `config.ts` line 299 comment (`// Named by surface, never by token: the warning goes to a log.`).
**Apply to:** `up`/`status`/`smoke` output, `parity:check` output, every thrown message in `rehearsal-env.ts`.

### Exit codes: 0 pass, 1 a check failed, 2 usage/precondition
**Source:** `scripts/chaos-smoke.ts` 185-196 (exit 2 unreachable/401) and 385; `scripts/greptime-smoke.ts` 52-58 (exit 2 when unconfigured); `docs/greptime-ledger.md` line 347 documents the triple; `swarm-workspace.ts` `usage()` → 2.
**Apply to:** both scripts, and both docs state it.

### Pure core, thin CLI, `import.meta.main`
**Source:** `packages/projector/src/swarm-workspace.ts` 552-587 (exports + `main(argv): number` + guard).
**Apply to:** `scripts/rehearsal.ts`, `scripts/parity-check.ts`; their tests import the exported functions and never trigger Docker, systemd or network.

### Files with secrets: 0600 in a 0700 dir, mode set explicitly
**Source:** `packages/projector/src/swarm-workspace.ts` lines 398-406 — `openSync(path, O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW, 0o600)` then `fchmodSync(fd, mode & 0o777)` because the create mode is umask-masked; `packages/collectors/src/install-git-hook.ts` line 62 `chmodSync(path, 0o755)` for the explicit-chmod idiom.
**Apply to:** run dir (0700), `consumer.env`, `stores.env`, `tokens/<surface>`, `state.json`, `server.log` (opened 0600 and handed to the server as an fd).

### Tests: `bun:test`, "why" comments, temp dirs cleaned
**Source:** `git.test.ts` 1-34, `server.test.ts` 1-38, `authority.test.ts` 1-22. Live tests skip without env, `graph-bind.test.ts` 344-345:
```ts
const PG_URL = process.env.SUBSTRATE_TEST_PG_URL?.trim();
const describeLive = PG_URL ? describe : describe.skip;
```
This is the consumer of `consumer.env`'s `SUBSTRATE_TEST_PG_URL`; no new test needs Docker. `tsconfig.json` line 16 already includes `scripts/**/*.ts`, so `scripts/*.test.ts` is typechecked and discovered by `bun test`.

### Code style
Tabs for indentation in `.ts`; `.ts` extensions on relative imports; `import type` for type-only imports (`verbatimModuleSyntax`); file-top `/** … */` docblock explaining purpose and the reasoning behind each refusal, as in every analog above.

## No Analog Found

| File / capability | Role | Data Flow | Reason → use instead |
|---|---|---|---|
| docker container lifecycle in `scripts/rehearsal.ts` (`run`, health poll, `port`, label-filtered `rm -f`) | ops | process lifecycle | Nothing in the repo drives Docker; v1.2 proofs used untracked `/tmp` scripts → RESEARCH §6, §7, "Code Examples", "Don't Hand-Roll" |
| detached server spawn + `mayStop` pid ownership | ops | process lifecycle | No detached spawn or signalling in the repo → RESEARCH §5, §9, Architecture Pattern 1, Pitfalls 8-9 |
| `systemctl show` / `ss -ltnpH` / `/proc` parsers in `scripts/parity-check.ts` | ops | batch read | No host-probe code exists (only `/proc/self/fd` use in swarm-workspace.ts 379) → RESEARCH §8 verbatim outputs as fixtures, Pitfalls 10-12 |
| `docs/runbooks/` type directory | doc | — | First runbook; structure borrowed from `docs/receipts/` + observability operator blocks (above) |

## Metadata

**Analog search scope:** `scripts/`, `packages/mcp-server/src/`, `packages/projector/src/`, `packages/collectors/src/`, `packages/cli/src/` (grep), `infra/vps/`, `docs/` (incl. `adr/`, `receipts/`), `README.md`, `package.json`, `tsconfig.json`, `AGENTS.md`.
**Files read:** 24 (8 in full, 16 by targeted range or grep).
**Pattern extraction date:** 2026-10-08.
