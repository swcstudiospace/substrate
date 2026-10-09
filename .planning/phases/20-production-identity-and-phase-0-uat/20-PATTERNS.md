# Phase 20: Production identity and Phase 0 UAT - Pattern Map

**Mapped:** 2026-10-09
**Files analyzed:** 41 (30 agent-substrate, 11 claude-ultrathink)
**Analogs found:** 39 / 41 (2 have no in-repo analog of the same shape: the JSON manifest and the names-only env-file parser; partial analogs are given)

Path conventions in this file:
- `p20:` = `/root/src/worktrees/agent-substrate-v13-p20` (this branch; tracked files on `main`).
- `p16:` = `/root/src/worktrees/agent-substrate-v13-phase` (Phase 16, tracked on its branch; on `main` when Phase 20 executes).
- `p17:` = `/root/src/worktrees/agent-substrate-v13-p17` (Phase 17, tracked on its branch).
- `p19:` = `/root/src/worktrees/agent-substrate-v13-p19` (Phase 19 **plans only**; `emit.ts`, `cursor-stop.ts`, `docs/collectors.md` do not exist yet).
- `cu:` = claude-ultrathink `origin/main` at `ed3243e`, read with `git -C /root/src/repos/claude-ultrathink --no-optional-locks show origin/main:<path>`. Executor edits happen in the fresh clone `/root/src/worktrees/claude-ultrathink-p20` (D20-13), never the operator checkout.

Every analog path below was checked with `git ls-files` (tracked source, no gitignored mirrors).

**Spelling rule for every excerpt and every file this phase writes (store lock, Pitfall 1):** never a `SUBSTRATE_TOKEN*` name followed by `:` or `=` and 16+ path-like characters. Client paths go in prose ("defaults to /etc/substrate/tokens"); TS locals after a `SUBSTRATE_TOKEN*:` key stay short (`dir`, `tok`, `token`). Precedent comment: `p16:packages/mcp-server/src/rehearsal-env.ts:199-201`.

## File Classification

### agent-substrate

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `packages/mcp-server/src/config.ts` (edit: `tokenConfig`, `ConfigError`, list form) | config | transform | itself: `readTokens` :120-127, `readReviewTokens` :194-203, `configWarnings` :278-310 | exact |
| `packages/mcp-server/src/index.ts` (edit: boot refusal, exit 78) | entry point | event-driven (boot) | itself :1-26 (`[substrate] misconfigured —` lines) | exact |
| `packages/mcp-server/src/authority.test.ts` (extend) | test | transform | itself :16-38, :55-63, :237-242 | exact |
| `packages/mcp-server/src/server.authority.test.ts` (extend) | test (in-process HTTP) | request-response | itself :18-30, :90-125, :346-365 | exact |
| `packages/mcp-server/src/boot-refusal.test.ts` (new) | test (subprocess) | event-driven | `p20:packages/mcp-server/src/http.test.ts:347-370` + `p16:scripts/rehearsal.ts:236-238` | role-match |
| `packages/cli/src/token.ts` (new) | utility | file-I/O | `p20:packages/audit/src/log.ts:385-410` (bounded fail-open read) + `p20:packages/cli/src/index.ts:37-40` | role-match |
| `packages/cli/src/token.test.ts` (new) | test | file-I/O | `p20:packages/cli/src/lessons.test.ts:1-23` + `p16:scripts/rehearsal.test.ts:217-238` | role-match |
| `packages/cli/src/cli-auth.test.ts` (new) | test (spawn vs stub) | request-response | `p20:packages/mcp-server/src/http.test.ts:356-370` + `p20:packages/cli/src/lessons.test.ts:72-98` | exact |
| `packages/cli/src/index.ts` (edit: `headers(surface)`, lessons token) | CLI | request-response | itself :33-74, :82, :121, :231, :387-395 | exact |
| `packages/collectors/src/emit.ts` (edit, Phase 19 file) | utility | request-response | planned `p19:.planning/phases/19-lane-b-collectors/19-01-PLAN.md:28,89,100-101`; import convention `p19:packages/collectors/src/grok-map.ts:9` | role-match (file not yet written) |
| `packages/collectors/src/emit.test.ts` (extend, Phase 19 file) | test | request-response | `p20:packages/cli/src/lessons.test.ts:72-98` stub | role-match |
| `scripts/parity-check.ts` (edit, Phase 16 file) | script | request-response | itself `p16:scripts/parity-check.ts:142-143,283-297` | exact |
| `scripts/parity-check.test.ts` (extend) | test | transform | itself `p16:scripts/parity-check.test.ts:14-34,92-97` | exact |
| `infra/identity/clients.json` (new) | config (manifest) | — | no JSON manifest in repo; data-table precedent `p20:packages/projector/src/swarm-workspace.ts:58-63`; schema from RESEARCH §8 | partial |
| `scripts/identity-check.ts` (new) | script | file-I/O (read-only), batch | `p16:scripts/parity-check.ts:1-13,309-330,487` + `p16:scripts/rehearsal.ts:1216-1235` | role-match |
| `scripts/identity-check.test.ts` (new) | test + doc lock | transform | `p16:scripts/parity-check.test.ts:14-34` + `p17:packages/mcp-server/src/event-sources.test.ts:84-108` + `p20:packages/mcp-server/src/authority.test.ts:237-242` | exact |
| `scripts/uat-phase0.ts` (new) | script | request-response | `p20:scripts/chaos-smoke.ts:62-134` + `p17:scripts/vocabulary-smoke.ts:1-21,58-90,149-205` + `p16:scripts/rehearsal.ts:1194-1300` | exact |
| `scripts/uat-phase0.test.ts` (new) | test | transform | `p16:scripts/rehearsal.test.ts:217-238` | exact |
| `scripts/uat/fixtures/notion-rows.json` (new) | fixture | — | `p20:packages/mcp-server/src/backfill.test.ts:50-78`, type `backfill.ts:27-41` | exact |
| `docs/runbooks/production-identity.md` (new) | doc (runbook) | — | `p16:docs/runbooks/production-parity.md:1-9,145-248` + marked table `p17:docs/event-vocabulary.md:51-90` | exact |
| `docs/uat.md` (new) | doc | — | `p16:docs/rehearsal.md:1-60,113-138` | exact |
| `.env.example` (edit) | config | — | itself :56-64, :89-110 | exact |
| `docs/coordination.md` (edit) | doc | — | itself :119-148 | exact |
| `docs/grok-bot.md` (edit) | doc | — | itself :9 | exact |
| `docs/swarm-workspace.md` (edit) | doc | — | itself :72-94 | exact |
| `docs/memory-governance.md:104`, `docs/lessons-bank.md:48`, `.planning/PROJECT.md:101` (edit) | doc | — | themselves | exact |
| `docs/collectors.md` (edit, Phase 19 file) | doc | — | planned by Phase 19 | role-match (file not yet written) |
| `infra/vps/substrate-mcp.service` (edit: `RestartPreventExitStatus=78`) | config (unit) | — | itself :11-20 | exact |
| `package.json` (edit: `identity:check`, `uat:phase0`) | config | — | `p17:package.json:18-29` | exact |
| `.planning/milestones/v1.0-phases/00-brief/0-UAT.md` (results) and `20-UAT.md` | planning record | — | itself :1-11, :23-27, :65 | exact |

### claude-ultrathink (fresh clone)

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/substrate/brief.ts` (edit: `authHeaders(env, surface)`) | service (client) | request-response | itself `cu:src/substrate/brief.ts:53-56,69-96,115-145` | exact |
| `src/substrate/brief.test.ts` (extend) | test | request-response | itself `cu:src/substrate/brief.test.ts:1-30,87-91` | exact |
| `src/substrate/register.ts` (new) | service (MCP client) | request-response | `cu:src/substrate/brief.ts:42-96` + SSE `cu:src/mcp/sse.ts:3-45` / `p20:scripts/chaos-smoke.ts:84-102` | role-match |
| `src/substrate/register.test.ts` (new) | test | request-response | `cu:src/substrate/brief.test.ts:6-30` | exact |
| `src/mcp/cli.ts` (edit: `substrate register`, `substrate headers`, `trackComplete` hook) | CLI | request-response | itself `cu:src/mcp/cli.ts:30-40,283-324,347-361,390-427,452-458` | exact |
| `src/mcp/cli.test.ts` (extend) | test (spawn) | request-response | itself `cu:src/mcp/cli.test.ts:14-43,68-133` | exact |
| `scripts/mcp-register.ts` (edit: `--substrate`) | script | file-I/O via host CLI | itself `cu:scripts/mcp-register.ts:15-24,107-110,201-220,239-278,525-603` | exact |
| `scripts/mcp-register.test.ts` (extend) | test (fake `Run`) | transform | itself `cu:scripts/mcp-register.test.ts:1-25,131,462` | exact |
| `skills/ultrathink-kickoff/SKILL.md` (edit step 3) | doc (skill) | — | itself `cu:skills/ultrathink-kickoff/SKILL.md:48-62,81-95` | exact |
| `docs/configuration.md`, `docs/privacy.md`, `docs/how-to/register-mcp-gateway.md`, `README.md` (edit) | doc | — | `cu:docs/configuration.md:585`, `cu:docs/privacy.md:34-35` | exact |
| `CHANGELOG.md` (edit `[Unreleased]`) | doc | — | `cu:CHANGELOG.md:1-12` | exact |

## Pattern Assignments

### `packages/mcp-server/src/config.ts` (config, transform)

**Analog:** itself. The change replaces `readTokens` with an exported pure `tokenConfig(env)` and adds `ConfigError`; `loadConfig` calls it once.

**Current code to replace** (`p20:packages/mcp-server/src/config.ts:110-127`):
```ts
/** "swarm-a05-be" → "SUBSTRATE_TOKEN_SWARM_A05_BE": the inverse of `envSuffixToSurface`. */
export function tokenEnvName(surface: Surface): string {
	return `SUBSTRATE_TOKEN_${surface.toUpperCase().replace(/-/g, "_")}`;
}

/** SUBSTRATE_TOKEN_GROK_BUILD → "grok-build" */
function envSuffixToSurface(suffix: string): Surface {
	return suffix.toLowerCase().replace(/_/g, "-") as Surface;
}

function readTokens(env: Record<string, string | undefined>): Map<string, Surface> {
	const tokens = new Map<string, Surface>();
	for (const [key, value] of Object.entries(env)) {
		if (!key.startsWith("SUBSTRATE_TOKEN_") || !value) continue;
		tokens.set(value, envSuffixToSurface(key.slice("SUBSTRATE_TOKEN_".length)));
	}
	return tokens;
}
```
`envSuffixToSurface` casts any suffix (A1). The new validator checks membership in `SURFACES`; today's import line (`config.ts:9`) is `import { SWARM_SURFACES, isSwarmSurface, type Surface } from "./types.ts";` — add `SURFACES` to it.

**Call sites in `loadConfig` to collapse into one call** (`config.ts:170-173`):
```ts
		tokens: readTokens(env),
		// No tokens configured at all means a local dev run; requiring auth then
		// would just lock the operator out of their own machine.
		allowAnonymous: readTokens(env).size === 0,
```
Compute `const { tokens, errors } = tokenConfig(env); if (errors.length > 0) throw new ConfigError(errors.join("; "));` at the top of `loadConfig`, then `tokens` and `allowAnonymous: tokens.size === 0`. Keep the comment.

**Split precedent, without its length floor** (`config.ts:193-203`):
```ts
/** Comma- or whitespace-separated, so an operator can wrap the line in the env file. */
function readReviewTokens(raw: string | undefined): Set<string> {
	return new Set(
		(raw ?? "")
			.split(/[\s,]+/)
			.map((token) => token.trim())
			// A short string is a placeholder or a typo, not a token, and accepting one
			// would hand reviewer authority to anybody who guessed it.
			.filter((token) => token.length >= 16),
	);
}
```
Copy the `split(/[\s,]+/).map(trim)` chain and `filter(Boolean)` only — **not** the `>= 16` filter (anti-pattern, RESEARCH: every fixture is short).

**Message style: name variables, never values** (`config.ts:298-306` in `configWarnings`):
```ts
	// Named by surface, never by token: the warning goes to a log.
	const swarmOperators = [...config.operatorTokens].map((token) => config.tokens.get(token)).filter(isSwarmSurface);
	if (swarmOperators.length > 0) {
		warnings.push(
			`SUBSTRATE_OPERATOR_TOKENS lists the token of ${swarmOperators.join(", ")}; a swarm surface is never an ` +
```
`tokenConfig` errors follow this: `"SUBSTRATE_TOKEN_DESK_GATEWAY names no surface"`, `"<first variable> and <second variable> list the same token"`.

**Doc comment style:** every exported function carries a "why" block (see `isOperator` :226-241, `swarmTokenWarnings` :312-326). `ConfigError` gets one saying it is the only boot refusal and its message names variables only. Target shape for `tokenConfig` is RESEARCH "Token config validator (shape)".

**Existing error-class precedent:** `p16:scripts/rehearsal.ts:42-43`:
```ts
/** The harness refused an input or a state; the message names hosts and ports, never values. */
export class RehearsalRefused extends Error {}
```

**Collision note:** draft PR #22 rewrites the same `loadConfig` lines and adds `config.test.ts` (A8). Put the new tests in `authority.test.ts`, not a new `config.test.ts`.

**Other `loadConfig()` callers that inherit the throw** (`grep loadConfig(`): `packages/mcp-server/src/index.ts:16`, `packages/mcp-server/src/backfill-run.ts:44`, `scripts/greptime-smoke.ts:51`. Only `index.ts` gets the catch (D20-02); the other two are operator tools that may crash with the `ConfigError` message, which names variables only.

---

### `packages/mcp-server/src/index.ts` (entry point, boot)

**Analog:** itself (`p20:packages/mcp-server/src/index.ts:1-26`).

**Header comment to amend** (:2-10):
```ts
/**
 * substrate-mcp entry point.
 *
 * Boots the HTTP surface even when a store is unreachable: an agent that gets a
 * thin brief is better off than one whose prompt hangs waiting for Railway. The
 * same applies to the observability plane — a missing collector or a non-durable
 * audit chain is reported at boot and again on `/healthz`, and never a reason to
 * refuse to start.
 */
import { configWarnings, loadConfig, swarmTokenWarnings } from "./config.ts";
```
Add one sentence: a self-contradictory identity configuration (one value under two surfaces, a `SUBSTRATE_TOKEN_<X>` that names no surface) is the one refusal, exit 78 (EX_CONFIG).

**One-line stderr convention to copy** (:24-26):
```ts
for (const warning of [...configWarnings(config), ...swarmTokenWarnings(config)]) {
	process.stderr.write(`[substrate] misconfigured — ${warning}\n`);
}
```
Refusal: wrap `const config = loadConfig();` (:16) in `try`/`catch`; on `instanceof ConfigError` write `` `[substrate] refused — ${cause.message}\n` `` and `process.exit(78)`; rethrow anything else. Nothing else in the file changes.

---

### `packages/mcp-server/src/authority.test.ts` (test, extend)

**Analog:** itself.

**Header and imports** (:16-22):
```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configWarnings, isOperator, loadConfig, surfaceForToken, swarmTokenWarnings, tokenEnvName } from "./config.ts";
import { attributedSurface, claimAttribution, swarmSessionRefusal } from "./mcp.ts";
import { Substrate } from "./service.ts";
import { SURFACES, SWARM_SURFACES, type SubstrateEvent } from "./types.ts";
```
Add `ConfigError`, `tokenConfig` to the `./config.ts` import.

**Fixture style (short values, store-lock safe)** (:33-38):
```ts
const TOKENS = {
	SUBSTRATE_TOKEN_HERMES: "tok-hermes",
	SUBSTRATE_TOKEN_GROK_BOT: "tok-grok",
	SUBSTRATE_TOKEN_CURSOR: "tok-operator",
	SUBSTRATE_OPERATOR_TOKENS: "tok-operator",
};
```

**Multi-value test shape to copy** (:55-63):
```ts
	test("several operators may be configured", () => {
		const config = loadConfig({
			...TOKENS,
			SUBSTRATE_TOKEN_CURSOR: "tok-a",
			SUBSTRATE_TOKEN_MUSE: "tok-b",
			SUBSTRATE_TOKEN_PI: "tok-c",
			SUBSTRATE_OPERATOR_TOKENS: "tok-a, tok-b ,tok-c",
		});
		for (const token of ["tok-a", "tok-b", "tok-c"]) expect(isOperator(config, `Bearer ${token}`)).toBe(true);
```
New `describe("list-form surface tokens", …)`: each entry resolves via `surfaceForToken`; `"tok-a,\n tok-b"` splits on whitespace and newline; `expect(() => loadConfig({ SUBSTRATE_TOKEN_HERMES: "tok-x", SUBSTRATE_TOKEN_MUSE: "tok-x" })).toThrow(ConfigError)` and the message contains both variable names and `not.toContain("tok-x")`; `SUBSTRATE_TOKEN_DESK_GATEWAY` throws naming it; single value unchanged; a list entry also in `SUBSTRATE_OPERATOR_TOKENS` is an operator.

**`.env.example` lock precedent (reuse for codex/opencode/pi and in identity-check.test.ts)** (:237-242):
```ts
	test(".env.example lists a blank SUBSTRATE_TOKEN_* line for every one", () => {
		const example = readFileSync(join(import.meta.dir, "..", "..", "..", ".env.example"), "utf8").split("\n");
		for (const surface of SWARM_SURFACES) {
			expect(example).toContain(`${tokenEnvName(surface)}=`);
		}
	});
```
Phase 17 also edits this file (surface count pin, `substrate`); append new `describe` blocks at the end, do not touch the pins.

---

### `packages/mcp-server/src/server.authority.test.ts` (in-process HTTP test, extend)

**Analog:** itself.

**Env fixture** (:18-29), **server start** (:90-100):
```ts
beforeAll(async () => {
	const config = loadConfig(ENV);
	…
	observability = createObservability(config, ENV);
	…
	const substrate = new Substrate(config, { index: index as never, greptime: greptime as never }, observability.observer);
	server = createHttpServer(substrate, config, observability);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
```
**REST probe helper** (:347-353):
```ts
	async function postEvent(token: string | null, body: Record<string, unknown>): Promise<Response> {
		return fetch(`${base}/events`, {
			method: "POST",
			headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
			body: JSON.stringify({ kind: "note", summary: "x", ...body }),
		});
	}
```
Change `ENV.SUBSTRATE_TOKEN_HERMES` to a list (`"tok-hermes,tok-hermes-2"`) or start a second server as at :319-333; assert `tok-hermes-2` gets 202 attributed `hermes` (`written.map((e) => e.surface)`), and `"tok-hermes,tok-hermes-2"` as one bearer gets 401 (the probe in RESEARCH §3 proved today's opaque behaviour).

**401 gate under test** (`p20:packages/mcp-server/src/server.ts:249-257`):
```ts
		if (!config.allowAnonymous && surface === null) {
			sendJson(res, 401, { error: "unknown or missing bearer token" });
			return;
		}
```
Unchanged (D20-08).

---

### `packages/mcp-server/src/boot-refusal.test.ts` (new, subprocess test)

**Analog:** `p20:packages/mcp-server/src/http.test.ts:347-370` (async spawn) + `p16:scripts/rehearsal.ts:235-238` (`--no-env-file`).

**Async spawn helper** (`http.test.ts:356-370`):
```ts
	async function run(args: string[], env: Record<string, string> = {}) {
		const child = Bun.spawn(["bun", CLI, ...args], {
			cwd: ROOT,
			env: { ...process.env, ...env },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		return { exitCode, stdout, stderr };
	}
```
**Spawn argv** (`p16:scripts/rehearsal.ts:235-238`):
```ts
/** The server spawn argv: Bun without env-file autoload, the checkout entry point. */
export function buildServerSpawnArgv(): string[] {
	return [process.execPath, "--no-env-file", "packages/mcp-server/src/index.ts"];
}
```
Differences from the analog: env is an **allowlist** (`PATH`, `HOME` plus the test's `SUBSTRATE_TOKEN_*` and `SUBSTRATE_PORT: "0"`), never `...process.env`, so a developer's tokens or `GREPTIME_*` never leak in (the `rehearsal-env.ts` allowlist idea, `p16:docs/rehearsal.md:20-24`); argv uses `--no-env-file` (do not import `rehearsal.ts` into a package test; inline the three-element argv). `ROOT = join(import.meta.dir, "..", "..", "..")` as in `http.test.ts:20`. Assert `exitCode === 78`, stderr starts with `[substrate] refused —`, names both variables, and `stdout + stderr` does not contain the fixture value. Refusal happens before stores, so no Postgres/Greptime is needed. Add a guard test that a valid env does **not** print `refused` within a short bound and then kill the child (or skip; the refusal path is the requirement).

---

### `packages/cli/src/token.ts` (new utility, file-I/O)

**Analogs:** current inline bearer in `p20:packages/cli/src/index.ts:37-40`; bounded fail-open file read in `p20:packages/audit/src/log.ts:385-410`; name-regex validation in `p16:scripts/rehearsal.ts:117-123`.

**What it replaces** (`cli/src/index.ts:37-40`):
```ts
function headers(): Record<string, string> {
	const token = process.env.SUBSTRATE_TOKEN?.trim();
	return { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
}
```
**Bounded read, any error means absent** (`audit/src/log.ts:385-409`):
```ts
	private readCheckpoint(): Checkpoint | null {
		const target = this.checkpointPath;
		if (target === null || !existsSync(target)) return null;
		try {
			const size = statSync(target).size;
			// A checkpoint is a few dozen bytes. Anything larger is not one, and reading it
			// whole would be trusting a file this is meant to be sceptical of.
			if (size === 0 || size > 4096) return null;
			const buffer = Buffer.alloc(size);
			const fd = openSync(target, "r");
			try {
				readSync(fd, buffer, 0, size, 0);
			} finally {
				closeSync(fd);
			}
			…
		} catch {
			// An unreadable checkpoint is not evidence of loss. Treated as absent, which
			// leaves the pre-checkpoint behaviour rather than inventing an alarm.
			return null;
		}
	}
```
Copy the shape for `firstLine(path)`: `statSync` → not a regular file or size 0 or > 4096 → `null`; read; take the text up to the first newline, trimmed; empty → `null`; `catch {}` → `null` (missing, EISDIR, EACCES). Never log.

**Name validation precedent** (`rehearsal.ts:117-123`):
```ts
/** Instance names are lower alnum plus dash, up to 31 chars. */
export function parseName(raw: string | undefined): string {
	const name = raw ?? "default";
	if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(name)) {
		throw new RehearsalRefused(`bad instance name ${name}: lower alnum plus dash, up to 31 chars`);
```
Here the regex is `/^[a-z0-9][a-z0-9-]{0,63}$/` and a mismatch returns `null` (no throw: fail-open).

**Exports:** `resolveBearer(surface, env = process.env, read = firstLine): string | null` (order: `SUBSTRATE_TOKEN` → `SUBSTRATE_TOKEN_FILE` first line → tokens dir file for a validated surface → `null`), a `DEFAULT_TOKENS_DIR` constant declared as `const DEFAULT_TOKENS_DIR = "/etc/substrate/tokens";` (not a `SUBSTRATE_TOKEN*` key, so the store lock does not apply), and `firstLine`. Shape in RESEARCH "Bearer resolver (shape)". Header doc comment in the CLI style (`cli/src/index.ts:2-22`), and say the module is imported by the CLI, `emit.ts`, `parity-check.ts` and `uat-phase0.ts`, and that claude-ultrathink `brief.ts` carries the same rule.

---

### `packages/cli/src/token.test.ts` (new unit test)

**Analog:** `p20:packages/cli/src/lessons.test.ts:1-4` (imports, temp dirs) and the parity/rehearsal style of small pure tests.
```ts
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
```
Cases: env wins over file and dir; `SUBSTRATE_TOKEN_FILE` beats dir; tokens dir via `SUBSTRATE_TOKENS_DIR` pointing at a `mkdtempSync` dir with a `cursor` file; first line only, trimmed; empty file → null; a **directory at the file path** → null (Pitfall 9: tests run as root, so `chmod 000` proves nothing); oversize (> 4096) → null; surface `../x`, `a/b`, `Cursor`, `""` never read (inject a `read` spy and assert it was not called with a joined path); default dir constant used when the variable is unset (inject `read`, assert the path). Locals after any `SUBSTRATE_TOKEN*:` key stay short (`dir`, `tok`).

---

### `packages/cli/src/cli-auth.test.ts` (new, spawn CLI vs stub)

**Analogs:** stub server `p20:packages/cli/src/lessons.test.ts:72-98`; async spawn `p20:packages/mcp-server/src/http.test.ts:356-370` (above).

**Stub that checks the bearer** (`lessons.test.ts:72-73, 95-98`):
```ts
	readonly server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => this.handle(request) });
	readonly url = `http://127.0.0.1:${this.server.port}`;
	…
	private async handle(request: Request): Promise<Response> {
		if (request.headers.get("authorization") !== `Bearer ${this.token}`) {
			return Response.json({ error: "unknown or missing bearer token" }, { status: 401 });
		}
```
Record each request's `authorization` header and path instead of refusing. Spawn `bun packages/cli/src/index.ts emit --kind note --summary x --surface cursor` with env `{ PATH, HOME, SUBSTRATE_URL: stub.url, SUBSTRATE_TOKENS_DIR: dir }` (no `...process.env`, so an operator's `SUBSTRATE_TOKEN` cannot leak in); assert the stub saw `Bearer <cursor file value>`; with `SUBSTRATE_TOKEN` also set the env value wins; with neither, no header. Must be `Bun.spawn` (async), never `spawnSync`: the stub runs in this process (`http.test.ts:349-354` explains why).

---

### `packages/cli/src/index.ts` (CLI, edit)

**Analog:** itself.

**`post` sends `headers()` today** (:63-74):
```ts
async function post(path: string, body: unknown): Promise<Response | null> {
	try {
		return await fetch(`${base()}${path}`, {
			method: "POST",
			headers: headers(),
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeout()),
		});
	} catch {
		return null;
	}
}
```
**Surface is already computed per command** (`:82` brief, `:121` emit, `:231` handoff): `surface: str(args.surface) ?? "claude-code",`. Thread it: `headers(surface)` → `resolveBearer(surface, process.env)`; `post(path, body, surface = "claude-code")`. `verify`, `drift`, `evidence` have no surface → `claude-code` (RESEARCH §5). Import as `import { resolveBearer } from "./token.ts";` next to `./args.ts` (:24-25 style).

**Lessons token** (:387-395):
```ts
	case "lessons":
		process.exit(
			await runLessons(rest, {
				memory: httpMemory({
					url: base(),
					token: process.env.SUBSTRATE_TOKEN?.trim() || undefined,
```
Becomes `token: resolveBearer("claude-code", process.env) ?? undefined`.

**Header doc** (:14-22): exit-0 rule for `brief`/`emit`/`handoff` is unchanged; add one line that the bearer comes from the token resolver (`SUBSTRATE_TOKEN`, the token-file variable, then the per-surface tokens-dir file).

---

### `packages/collectors/src/emit.ts` (Phase 19 file, edit)

**Analog:** the Phase 19 plan (file not yet written). Planned contract, `p19:.planning/phases/19-lane-b-collectors/19-01-PLAN.md:28`:
> postEvent never throws and returns stored for 202, refused for any 4xx, failed for 5xx/network/timeout; env read at call time with the CLI bearer convention and 3 s / 1.5 s timeouts

and :101 "Authorization header present only when a token is set; env read at call time, no module-const URL". `postEvent(event, { timeoutMs, collector, source, url?, token? })` (RESEARCH §5).

**Change:** default token becomes `opts.token ?? resolveBearer(event.surface, process.env)`.

**Cross-package relative import convention** (`p19:packages/collectors/src/grok-map.ts:9`, same on `main`):
```ts
import type { EventInput } from "../../mcp-server/src/types.ts";
```
So: `import { resolveBearer } from "../../cli/src/token.ts";`. The same convention is used by `p20:packages/cli/src/lessons.test.ts:5` (`../../mcp-server/src/memory-classify.ts`).

**Test (`emit.test.ts`, Phase 19 file, extend):** Phase 19's stub server style (from `lessons.test.ts:72-98`); add: an event with `surface: "hermes"` and no `opts.token` sends the `hermes` tokens-dir file; `opts.token` wins; `SUBSTRATE_TOKEN` in env wins over the file (A3 order). Per T-19-02 (`19-01-PLAN.md:172`) keep short `tok` locals.

---

### `scripts/parity-check.ts` + `scripts/parity-check.test.ts` (Phase 16 files, edit)

**Analog:** itself.

**Probe to change** (`p16:scripts/parity-check.ts:283-297`):
```ts
/** One GET to /healthz with the caller's bearer when set; the token is never printed. */
async function probeHealthz(): Promise<number | null> {
	const token = process.env.SUBSTRATE_TOKEN?.trim();
	try {
		const res = await fetch(HEALTHZ_URL, {
			headers: token ? { authorization: `Bearer ${token}` } : {},
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
```
→ `const token = resolveBearer("claude-code", process.env);` with `import { resolveBearer } from "../packages/cli/src/token.ts";` (scripts import packages by relative path, e.g. `p16:scripts/rehearsal.ts:33-40`).

**Verdict text** (:142-143):
```ts
	} else if (facts.healthzStatus === 401) {
		failures.push("healthz answered 401 (auth is configured — set SUBSTRATE_TOKEN)");
```
→ "auth on, token missing" plus the variables to set (`SUBSTRATE_TOKEN` or the token-file variable).

**Test to update** (`p16:scripts/parity-check.test.ts:92-97`):
```ts
	test("reports 401 as auth-configured, not as silence", () => {
		// After tokens exist the probe needs a bearer; 401 names the fix.
		const verdict = parityVerdict(facts({ healthzStatus: 401 }));
		expect(verdict.pass).toBe(false);
		expect(verdict.failures.join("\n")).toContain("SUBSTRATE_TOKEN");
	});
```
Add `toContain("auth on, token missing")`. `probeHealthz` is not exported; bearer selection is covered by `token.test.ts`.

---

### `infra/identity/clients.json` (new manifest)

**Analog:** none of the same shape (no tracked JSON manifest; `git ls-files '*.json'` shows only `package.json`/`tsconfig.json`/`.planning`). Closest data-as-table precedent `p20:packages/projector/src/swarm-workspace.ts:58-63`:
```ts
export type Format = "json" | "toml";
export const RUNTIME_FILES: Readonly<Record<string, { path: string; format: Format }>> = {
	claude: { path: ".mcp.json", format: "json" },
	omp: { path: ".mcp.json", format: "json" },
	grok: { path: ".grok/config.toml", format: "toml" },
};
```
Use the RESEARCH §8 schema verbatim (`version`, `server_env`, `required_server_names`, `clients[]` with `id`, `surface`, `delivery` of kind `tokens-dir` | `env-file` (`path`, `variable`) | `operator-file` (`path`) | `external` (`note`), `state` `live` | `after-phase-19` | `dormant:<phase>` | `not-installed`, `evidence`). Rows from CONTEXT's ClientInventory table, split per client (herdr per mapped surface). No values; paths are absolute system paths (`/etc/...`), never a repo checkout path (the lock test asserts it). `delivery.variable` strings are bare names (`"SUBSTRATE_TOKEN"`), so a JSON `"variable": "SUBSTRATE_TOKEN"` line is followed by a short value and stays store-lock safe; do **not** put a JSON key named `SUBSTRATE_TOKEN*` with a path value.

---

### `scripts/identity-check.ts` (new script, read-only file-I/O)

**Analog:** `p16:scripts/parity-check.ts` (read-only host check, pure exports + `main`, exit 0/1/2, never prints an env value).

**Header contract to mirror** (`parity-check.ts:1-13`):
```ts
#!/usr/bin/env bun
/**
 * Read-only production parity check (`bun run parity:check`).
 *
 * Gathers host facts about substrate-mcp.service — …
 * then reports the verdict. Exit 0 pass, 1 a
 * criterion failed, 2 usage or an unreadable precondition.
 *
 * It changes nothing: no state-changing systemctl verb, no /etc write, no
 * lock-taking git call (every git argv starts with --no-optional-locks), and
 * it prints pids, states and commits only — never an environment value.
 */
```
**`main` + usage + flags** (`parity-check.ts:298-330`, :487):
```ts
function usage(message?: string): never {
	if (message) process.stderr.write(`[parity:check] ${message}\n`);
	process.stderr.write("usage: parity-check.ts [--json] [--expect-restarts N] [--expect-start EPOCH]\n");
	process.exit(2);
}

export async function main(argv: string[]): Promise<number> {
	if (argv.includes("--help") || argv.includes("-h")) {
	…
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (arg === "--json") {
			json = true;
		} …
		} else {
			usage(`unknown argument: ${arg}`);
		}
	}
…
if (import.meta.main) process.exit(await main(process.argv.slice(2)));
```
Flags: `--values` (operator), `--json`, `--manifest <path>` (default `infra/identity/clients.json`), `--server-env <path>` (default the manifest's `server_env`). Prefix `[identity:check]`.

**Line parser shape** (`p16:scripts/rehearsal.ts:1216-1235`, the only existing env-line parser):
```ts
export function parseShellExports(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("export ")) continue;
		const rest = trimmed.slice("export ".length);
		const eq = rest.indexOf("=");
		if (eq <= 0) continue;
		const key = rest.slice(0, eq).trim();
		let value = rest.slice(eq + 1).trim();
		…
		out[key] = value;
	}
	return out;
}
```
**Differences (names-only mode, RESEARCH §8):** systemd `EnvironmentFile` syntax, so `export ` is optional, `#`/`;` comments skipped, a line after one ending in `\` is a continuation and is **skipped, never parsed as a key**; match `^([A-Za-z_][A-Za-z0-9_]*)\s*=`; keep only `{ name, valueIsEmpty, count }` and drop `rest` immediately (never stored in the returned structure). Report only manifest-expected names plus unexpected `SUBSTRATE_TOKEN_*` names. `--values` mode is a separate function that reads values into memory, hashes with `createHash("sha256")` (import `node:crypto` as `p16:scripts/rehearsal.ts:15` does `randomBytes`), and returns only `match` / `missing` / `mismatch`; never prints hashes. It also calls `tokenConfig()` from `../packages/mcp-server/src/config.ts` (Pattern 1: one validator, two callers) and prints its errors (variables only).

**Tokens-dir check (names-only):** `statSync` only, never `readFileSync`: regular file, `mode & 0o777 === 0o600`, `uid === 0`, `size > 0`; dir `0o700`. Mode assertion precedent: `p20:packages/projector/src/swarm-workspace.test.ts:336-337` (`expect(statSync(config).mode & 0o777).toBe(0o640)`).

**Store lock:** the script must not name `GREPTIME_` (store-lock rule 1) and must not import `service.ts`/`greptime.ts`.

---

### `scripts/identity-check.test.ts` (new test + doc lock)

**Analogs:** fixture builder `p16:scripts/parity-check.test.ts:14-34`; marked-table parser `p17:packages/mcp-server/src/event-sources.test.ts:84-108`; `.env.example` lock `p20:packages/mcp-server/src/authority.test.ts:237-242` (above).

**Fixture builder style** (`parity-check.test.ts:14-17`):
```ts
/** The discuss-time host reading (RESEARCH section 8): every field defaults to the passing value. */
function facts(over: Partial<ParityFacts> = {}): ParityFacts {
	return {
		mainPid: 1525582,
```
**Marked-table parser to copy** (`event-sources.test.ts:84-108`):
```ts
describe("docs/event-vocabulary.md equals the table", () => {
	const DOC = join(import.meta.dir, "..", "..", "..", "docs", "event-vocabulary.md");

	function parseMarkedTable(markdown: string): Array<Record<string, string>> {
		const start = markdown.indexOf("<!-- event-sources:start -->");
		const end = markdown.indexOf("<!-- event-sources:end -->");
		if (start < 0 || end < start) throw new Error("event-sources markers missing");
		const rows = markdown
			.slice(start, end)
			.split("\n")
			.filter((line) => line.trimStart().startsWith("|"));
		const [header, , ...body] = rows;
		const keys = (header ?? "")
			.trim()
			.replace(/^\||\|$/g, "")
			.split("|")
			.map((cell) => cell.trim().replace(/`/g, ""));
		return body.map((line) => {
			const values = line
				.trim()
				.replace(/^\||\|$/g, "")
				.split("|")
				.map((cell) => cell.trim().replace(/`/g, ""));
			return Object.fromEntries(values.map((value, i) => [keys[i] ?? `col${i}`, value]));
		});
	}
```
Markers `<!-- identity-clients:start -->` / `<!-- identity-clients:end -->`; `ROOT = join(import.meta.dir, "..")` for a `scripts/` test. Locks: every manifest `id` appears in the runbook table; every manifest surface has `` `${tokenEnvName(surface)}=` `` as a line of `.env.example`; manifest surfaces ⊆ `SURFACES`; no `delivery.path` under a checkout. Parser fixtures carry short values (below 16 characters) and assert those values never appear in the parser's output or in `main`'s stdout: quoted values, `export `, comments, continuation lines, duplicates by count.

---

### `scripts/uat-phase0.ts` (new script, HTTP/MCP client)

**Analogs:** `p20:scripts/chaos-smoke.ts` (HTTP-only client of `SUBSTRATE_URL`, check/note output, SSE-aware body parse, outside the store lock); `p17:scripts/vocabulary-smoke.ts` (pure exports + `main` + exit 0/1/2, target refusal before any request, run tag); `p16:scripts/rehearsal.ts` (the guard and helpers to import, not re-declare).

**Import, do not copy, Phase 16's guard pieces** (Phase 16 is on `main` when Phase 20 executes; `rehearsal.ts` ends in `if (import.meta.main)` (:1468) so importing it has no side effects):
```ts
// p16:scripts/rehearsal.ts:49, :295-306, :1201-1214, :1217, :1297
export const PRODUCTION_PORTS = [7410, 7411, 6420] as const;
export function pickFreePort(): Promise<number> { … }
export function refuseSmokeUrl(raw: string): string | null { … }
export function parseShellExports(text: string): Record<string, string> { … }
export function smokeToolResult(attempt: SmokeAttempt): Record<string, unknown> | null { … }
```
`refuseSmokeUrl`'s body (:1201-1214) is the template for an exported `classifyTarget(raw): "production" | "scratch" | { refused: string }` (A7): same `PRODUCTION_PORTS` membership and loopback set `{ "127.0.0.1", "::1", localhost }`, but returning a class instead of refusing:
```ts
	if ((PRODUCTION_PORTS as readonly number[]).includes(Number(url.port))) {
		return `refusing to smoke production :${url.port}`;
	}
	const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
	if (SMOKE_LOOPBACK_HOSTS[host] !== true) return `refusing non-loopback smoke host ${url.hostname}`;
```
(Phase 17's `vocabulary-smoke.ts:26-27` redeclared `PRODUCTION_PORTS` only because Phase 16 was unmerged; Phase 20 imports it.)

**Headers with both Accept types** (`chaos-smoke.ts:63-73`):
```ts
function headers(): Record<string, string> {
	const token = process.env.SUBSTRATE_TOKEN?.trim();
	return {
		"content-type": "application/json",
		// Both media types, because `/mcp` is the MCP streamable transport and it answers
		// a POST with **406** unless both are acceptable. …
		accept: "application/json, text/event-stream",
		...(token ? { authorization: `Bearer ${token}` } : {}),
	};
}
```
Bearer comes from `resolveBearer(surface, process.env)` instead of the env read.

**Body parse and timed call** (`chaos-smoke.ts:84-124`):
```ts
function parseBody(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		// Fall through to the SSE framing.
	}
	const frames = text
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim());
	for (const frame of frames.reverse()) {
	…
}

interface Attempt {
	status: number | null;
	body: unknown;
	/** Wall time the caller waited. The fail-open claim is about this, not just the status. */
	elapsedMs: number;
	error?: string;
}

async function call(path: string, body?: unknown): Promise<Attempt> {
	const started = performance.now();
	try {
		const response = await fetch(`${BASE}${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: headers(),
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		const text = await response.text();
		return { status: response.status, body: parseBody(text), elapsedMs: performance.now() - started };
	} catch (cause) {
		return { status: null, body: null, elapsedMs: performance.now() - started, error: String(cause) };
	}
}
```
Turn the module-level `BASE` into a parameter (pure, testable); reuse `parseBody` via the imported `smokeToolResult` where it fits.

**Check recording** (`chaos-smoke.ts:126-135`):
```ts
const results: Array<{ ok: boolean; what: string; detail?: string }> = [];

function check(ok: boolean, what: string, detail?: string): void {
	results.push({ ok, what, detail });
	process.stdout.write(`${ok ? "  ok  " : " FAIL "} ${what}${detail ? ` — ${detail}` : ""}\n`);
}
```
Per scenario: `{ id, title, result: "pass" | "fail" | "refused" | "skipped", checks: [{ ok, what, detail? }], evidence }` (RESEARCH §7); one `results` list per scenario, not module-global.

**Script contract to mirror** (`vocabulary-smoke.ts:12-20, 78-89, 149-169, 205`):
```ts
 * … `refuseTarget` runs before any request, so a production
 * port or a non-loopback host exits 2 with zero requests sent. Reports
 * carry ids, counts and statuses only — never the bearer or reply bodies.
 *
 * Exit codes: 0 every sample stored and read back with zero refusals,
 * 1 a check failed, 2 precondition refused …
…
/** Graph tag for one proof run: `rh-vocab-<epoch-ms>`. */
export function runTag(nowMs: number): string {
	return `rh-vocab-${nowMs}`;
}
…
	const refused = refuseTarget(target);
	if (refused !== null) {
		process.stderr.write(`[vocab-smoke] ${refused}.\n`);
		return 2;
	}
…
if (import.meta.main) process.exit(await main(process.argv.slice(2)));
```
Differences: `uat-phase0` reads `SUBSTRATE_URL` from the process env (the proof sources `consumer.env`, D20-14) rather than reading `consumer.env` itself; production is not refused but gated (`--live <approval-ref>` for write scenarios, D20-15); run tag `uat-<base36 time>`, graph ids `ut-uat-<tag>-<n>`. Prefix `[uat:phase0]`.

**MCP `tools/call` body** (`chaos-smoke.ts:150-153`; `tools/list` uses the same envelope with `method: "tools/list"`, `params: {}`):
```ts
async function tool(id: number, name: string, args: Record<string, unknown>): Promise<Attempt> {
	return call("/mcp", { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
}
```

**Scenario 3 spawn of the backfill loader** (`p20:packages/mcp-server/src/backfill-run.ts:1-31`): argv `["bun", "packages/mcp-server/src/backfill-run.ts", rowsPath]`, minimal env `{ PATH, HOME, SUBSTRATE_PG_URL }` (it calls `loadConfig()` and `substrate.index.migrate()`); it accepts a bare array or `{ results: [...] }`. Validate the fixture first with the pure `mapNotionRows` import (`backfill.ts` imports only `types.ts`). Never import `service.ts` or `greptime.ts` into the script (store-lock rule 1).

**Scenario 6 hook commands** come from `p20:packages/projector/src/cursor.ts:35-47`:
```ts
/** `|| true` keeps a substrate outage from failing the hook and stalling the turn. */
function command(args: string): HookEntry {
	return {
		type: "command",
		command: `bun ${CLI} ${args} >/dev/null 2>&1 || true`,
		"substrate-managed": true,
	};
}

const DESIRED: Record<string, HookEntry> = {
	// Writes .substrate/BRIEF.md into the workspace so the session can read it.
	sessionStart: command("brief --surface cursor --write"),
	postToolUse: command("emit --kind tool.call --summary 'cursor tool call' --surface cursor --actor human"),
	stop: command("emit --kind session.end --summary 'cursor session ended' --surface cursor --actor human"),
};
```
(`stop` changes to Phase 19's `cursor-stop.ts`; use its `--print-desired` output rather than copying strings.) `--check` exit codes: `cursor.ts:96-104` (0 current, 1 would change); `install-git-hook.ts --check` prints `✓ … present` / `○ … not installed` and exits 1 only on foreign or non-repo (`p20:packages/collectors/src/install-git-hook.ts:46-78`).

**Report safety:** evidence holds ids, counts, statuses, booleans, elapsed ms; never a token, brief body, event summary or non-loopback host (AGENTS.md: no internal hostnames). Same rule as `vocabulary-smoke.ts:15-16`.

---

### `scripts/uat-phase0.test.ts` (new unit test)

**Analog:** `p16:scripts/rehearsal.test.ts:217-238`:
```ts
describe("refuseSmokeUrl", () => {
	test("refuses :7410 even on loopback", () => {
		expect(refuseSmokeUrl("http://127.0.0.1:7410")).toContain(":7410");
	});

	test("refuses non-loopback hosts on any port", () => {
		expect(refuseSmokeUrl("http://10.0.0.5:17410")).toContain("non-loopback");
		expect(refuseSmokeUrl("http://example.com:17410")).toContain("non-loopback");
	});

	test("accepts loopback twins and rejects garbage", () => {
		expect(refuseSmokeUrl("http://127.0.0.1:17410")).toBeNull();
		expect(refuseSmokeUrl("http://localhost:17410")).toBeNull();
		expect(refuseSmokeUrl("not a url")).toContain("unparseable");
	});

	test("refuses every production port and accepts bracketed IPv6 loopback", () => {
		expect(refuseSmokeUrl("http://127.0.0.1:7411")).toContain("production");
		expect(refuseSmokeUrl("http://127.0.0.1:6420")).toContain("production");
		expect(refuseSmokeUrl("http://[::1]:17410")).toBeNull();
	});
});
```
Same cases for `classifyTarget`; plus: write scenarios on `production` without `--live` → `refused`; `--scenarios` parsing; run-tag format; report renderer never emits a field named like a token and drops non-loopback hosts; per-scenario expectation functions (e.g. "nine v1.0 names ⊆ tools", brief contains the `cursor` edit line and `n1` held by `claude-code`) on canned bodies. No server.

---

### `scripts/uat/fixtures/notion-rows.json` (new fixture)

**Analog:** `p20:packages/mcp-server/src/backfill.test.ts:50-78` (real-row shape), type `backfill.ts:27-41`:
```ts
		{
			url: "https://notion.so/task",
			"Graph ID": "ut-mucem4mc-ec70360f",
			Level: "Task",
			Item: "Fix the CoT truncation",
			Repo: "swcstudiospace/claude-ultrathink",
			Branch: "main",
			Status: "Implementing",
			Agent: "claude-code",
		},
		{
			url: "https://notion.so/n5",
			"Graph ID": "ut-mucem4mc-ec70360f",
			Level: "Issue",
			Item: "[n5] Rule out Linear API-side limitations",
			"Issue ID": "SPE-121",
			"Linear URL": "https://linear.app/swcstudio/issue/SPE-121/rule-out",
			"Linear State": "In Progress",
		},
		{
			url: "https://notion.so/n6-step",
			"Graph ID": "ut-mucem4mc-ec70360f",
			Level: "Sub-Issue",
			Item: "[n6] Node Detail",
			"Issue ID": null,
			"Linear URL": "https://linear.app/swcstudio/issue/SPE-132/identify-missing",
			Step: 1,
		},
```
Use a placeholder graph id (e.g. `ut-uat-TAG-3`) that the script substitutes with the run tag at run time, and a run-tagged lowercase repo (`uat-TAG/scratch`); identifiers like `UAT-1` rather than real SPE ids.

---

### `docs/runbooks/production-identity.md` (new runbook)

**Analog:** `p16:docs/runbooks/production-parity.md`.

**Header table** (:1-9):
```markdown
# Runbook — production parity for substrate-mcp

| | |
| --- | --- |
| Requirement | FOUND-03 |
| Window | … |
| Last known-good commit | … |
| Scope | `substrate-mcp.service` owning `127.0.0.1:7410` and serving `main` |
| Untouched | The herdr and Muse collectors, … surface tokens and the operator token (Phase 20), event mapping (Phase 17) |
```
**Operator step with a copyable block** (:145-162):
```markdown
## Operator step: installing the repo unit

`infra/vps/substrate-mcp.service` on `main` is ahead of the installed unit: …
The repo file has no effect until the operator installs it. Operator
only, at the next approved restart:

```sh
# back the installed unit up outside the repo, then install the repo file
cp /etc/systemd/system/substrate-mcp.service /root/substrate-mcp.service.bak-<date>
…
systemctl restart substrate-mcp
bun run parity:check --json
```
```
**Rollback section** (:164-194) and **Who does what** (:232-248, "Agents may: … Agents never: … The operator, in an approved window: …") — copy both section shapes. Evidence table with dated rows (:80-89).

**Marked machine-checked table** (`p17:docs/event-vocabulary.md:51-53,90`):
```markdown
<!-- event-sources:start -->

| id | phase | kind | surface | action | runtime | repo | periodic |
| --- | --- | --- | --- | --- | --- | --- | --- |
…
<!-- event-sources:end -->
```
Here `<!-- identity-clients:start -->` with columns `| id | surface | delivery | state | evidence |`; cell rules: no `|` inside a cell, backticks stripped by the parser.

Sections (D20-21): client table; token generation (`openssl rand -hex 32` straight into 0600 files, as in `p20:docs/swarm-workspace.md` "Generate each token as 32 random bytes"); ordered window D20-20; bridge variant D20-10; expected dormant 401s D20-07 with the `/metrics` read (`substrate.request.total`, `surface=unattributed`, `status=4xx`); rollback D20-09; rotation (`SUBSTRATE_HANDOFF_KEY_PREV`, list-form add-before-remove); links to `production-parity.md` and Phase 19's `lane-b-collectors.md`. Client paths in prose only (spelling rule).

---

### `docs/uat.md` (new doc)

**Analog:** `p16:docs/rehearsal.md` — opening "Tracked as … Owned by …" paragraph (:1-9), `## Commands` with one fenced usage block and a "Flags, as built" list (:36-60), `## The consumer contract` table (:113-131), `## Exits` (:133-138):
```markdown
## Exits

`0` pass, `1` failed, `2` usage or refused. Unreachable preconditions — a
missing `consumer.env`, a production-looking smoke target — refuse with exit
`2` before proving anything. …
```
Content: the regression loop `rehearsal up --name p20` → `set -a; . <run-dir>/consumer.env; set +a` → `bun run uat:phase0 --scenarios 1,4,7,8 --report <path>` → `rehearsal down`; the per-scenario table (where each runs, D20-17); the production `--live <approval-ref>` rule; report format.

---

### `.env.example` (edit)

**Analog:** itself (`p20:.env.example:89-110`):
```sh
# ── substrate-mcp ─────────────────────────────────────────────────────────────
SUBSTRATE_URL=http://127.0.0.1:7410
SUBSTRATE_HOST=127.0.0.1
SUBSTRATE_PORT=7410

# One bearer token per surface, so events are attributable.
SUBSTRATE_TOKEN_CLAUDE_CODE=
SUBSTRATE_TOKEN_HERMES=
SUBSTRATE_TOKEN_OMP=
SUBSTRATE_TOKEN_MUSE=
SUBSTRATE_TOKEN_GROK_BUILD=
SUBSTRATE_TOKEN_GROK_BOT=
SUBSTRATE_TOKEN_CURSOR=
SUBSTRATE_TOKEN_RIVET_AGENTOS=
# The Programming Desk gateway (… loopback :8791) calls the substrate with this token.
SUBSTRATE_TOKEN_DESK_GATEWAY=
```
Edits: comment on the block becomes the list form ("one or more comma- or whitespace-separated values per surface; one value under two surfaces, or a variable naming no surface, refuses boot"); delete the `DESK_GATEWAY` comment and line, move its meaning onto `SUBSTRATE_TOKEN_GROK_BOT` ("the Grok Bot gateway and grok-hermes-connector each hold one entry"); add blank `SUBSTRATE_TOKEN_CODEX=`, `SUBSTRATE_TOKEN_OPENCODE=`, `SUBSTRATE_TOKEN_PI=` (D20-05; the identity lock test needs a line per manifest surface). Phase 17 adds `SUBSTRATE_TOKEN_SUBSTRATE=` (coordinate, don't duplicate). The swarm block comment (:106-110) gains "swarm surfaces stay single-valued" (Pitfall 8). Operator-token comment (:56-64) gains "the operator's value is one extra entry in `SUBSTRATE_TOKEN_CLAUDE_CODE`". Client-only names (`SUBSTRATE_TOKEN_FILE`, `SUBSTRATE_TOKENS_DIR`) are described in a comment in prose and **never** given a `NAME=` line here (A1 would refuse them server-side, and a path value trips the store lock).

---

### `docs/coordination.md`, `docs/grok-bot.md`, `docs/swarm-workspace.md`, `docs/memory-governance.md`, `docs/lessons-bank.md`, `.planning/PROJECT.md` (doc edits)

- `docs/coordination.md:132-141` — the "operator token is a surface token that is also listed" paragraph; append the list form (the operator's own value is an extra entry of `SUBSTRATE_TOKEN_CLAUDE_CODE`) and the boot refusal. Same register as the existing text ("An operator token that is not also a surface token can never authenticate, and is reported at boot …").
- `docs/grok-bot.md:9` — "`.env.example` names the matching token variable `SUBSTRATE_TOKEN_GROK_BOT`. The value stays in `/etc/substrate/substrate.env` on the VPS." → the gateway's existing value is one entry of the `SUBSTRATE_TOKEN_GROK_BOT` list, the connector holds another. Do not add hostnames.
- `docs/swarm-workspace.md:76-90` — the `substrate.env` split table row "`SUBSTRATE_TOKEN_<SURFACE>`, one per surface"; note list form is allowed for non-swarm surfaces and the swarm installer copies the variable verbatim, so swarm surfaces stay single-valued.
- `docs/memory-governance.md:104` (`SUBSTRATE_TOKEN_CLAUDE_CODE=…`, one variable per surface), `docs/lessons-bank.md:48` (CLI reads `SUBSTRATE_URL` and `SUBSTRATE_TOKEN`), `.planning/PROJECT.md:101` (`SUBSTRATE_TOKEN_DESK_GATEWAY`) — one-line corrections.
- `docs/collectors.md` (Phase 19 file): herdr sends each event under its surface's tokens-dir file; its env must not define `SUBSTRATE_TOKEN` (A3).

---

### `infra/vps/substrate-mcp.service` (edit)

**Analog:** itself (`p20:infra/vps/substrate-mcp.service:11-20`):
```ini
[Service]
Type=simple
# Credentials only; nothing secret lives in the repo.
EnvironmentFile=/etc/substrate/substrate.env
WorkingDirectory=/root/src/repos/agent-substrate
# Machine-specific: `command -v bun`. Adjust when deploying elsewhere.
ExecStart=/root/.local/share/reflex/bun/bin/bun packages/mcp-server/src/index.ts
Restart=always
RestartSec=3
```
Add after `RestartSec=3`, with a comment in the file's style ("a refused identity configuration exits 78; restarting cannot fix it, so systemd stops instead of looping every 3 s"):
```ini
RestartPreventExitStatus=78
```
Phase 16 adds a `ConditionPathExists` guard to the same file (`p16:docs/runbooks/production-parity.md:147-150`); keep both. Run `systemd-analyze verify` if available.

---

### `package.json` (edit)

**Analog:** `p17:package.json:18-29` (shape after Phases 16-17):
```json
    "smoke:vocabulary": "bun scripts/vocabulary-smoke.ts",
    "check:phase-close": "bun scripts/phase-close-check.ts",
    "parity:check": "bun scripts/parity-check.ts",
    "rehearsal": "bun scripts/rehearsal.ts"
```
Add `"identity:check": "bun scripts/identity-check.ts"` and `"uat:phase0": "bun scripts/uat-phase0.ts"`. No dependency changes.

---

### `.planning/milestones/v1.0-phases/00-brief/0-UAT.md` (results record)

**Analog:** itself (:1-11 frontmatter, :23-27 per-test block, :65 `## Summary`):
```markdown
---
status: partial
phase: 00-brief
…
---
### 1. substrate-mcp serves both surfaces

expected: 9 MCP tools listed; GET /healthz, POST /brief, POST /events, POST /verify all answer
result: [pending]
evidence: "…"
```
Update `expected:` to D20-16's wording, set `result: pass|fail` and `evidence:` from the report (ids, counts, statuses only), update frontmatter `status`/`updated` and the Summary counts; a failed scenario stays failed (D20-18).

---

## claude-ultrathink Pattern Assignments

### `src/substrate/brief.ts` (client, edit)

**Analog:** itself.

**To replace** (`cu:src/substrate/brief.ts:53-56`):
```ts
function authHeaders(env: Record<string, string | undefined>): Record<string, string> {
	const token = env.SUBSTRATE_TOKEN?.trim();
	return token ? { authorization: `Bearer ${token}` } : {};
}
```
→ `authHeaders(env, surface)` using the same order as agent-substrate `token.ts` (`SUBSTRATE_TOKEN` → token-file variable → tokens-dir `<dir>/<surface>` with the surface regex, 4 KiB cap, any error → none). Callers already know the surface (:87, :131):
```ts
				surface: input.surface ?? "claude-code",
```
so `...authHeaders(env, input.surface ?? "claude-code")` at :82 and :127. Export a `resolveBearer` (or `substrateBearer`) from this file so `register.ts` and the `substrate headers` command share it. Keep the module header's opt-in and fail-open paragraphs (:3-19) and add one sentence for token resolution. File header must keep `// SPDX-License-Identifier: AGPL-3.0-or-later` + `// Copyright (C) 2026 SWC Studio`.

### `src/substrate/brief.test.ts` (extend)

**Analog:** itself (:6-18, :87-91):
```ts
const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): () => RequestInit {
	let captured: RequestInit = {};
	globalThis.fetch = ((url: string, init: RequestInit) => {
		captured = init;
		return Promise.resolve(handler(url, init));
	}) as unknown as typeof fetch;
	return () => captured;
}
…
	test("sends a bearer token when one is configured", async () => {
		const captured = stubFetch(() => new Response("ok"));
		await fetchBrief({ repo: "a/b" }, { SUBSTRATE_TOKEN: "secret-token" }, URL_);
		expect((captured().headers as Record<string, string>).authorization).toBe("Bearer secret-token");
	});
```
New cases with a `mkdtempSync` tokens dir passed as `SUBSTRATE_TOKENS_DIR` in the `env` argument: `surface: "grok-build"` reads the `grok-build` file; env wins; directory at the file path → no header; surface `../x` never read; `emitEvent` the same. CONTRIBUTING: deterministic, temp dirs, fake `fetch`, never a real-looking secret in fixtures.

### `src/substrate/register.ts` (new, MCP client)

**Analog:** `cu:src/substrate/brief.ts:42-96` for opt-in, timeout and fail-open; SSE parse from `cu:src/mcp/sse.ts:3-45` or the simpler last-`data:` frame (`p20:scripts/chaos-smoke.ts:84-102`).

**Opt-in gate to reuse** (`brief.ts:42-51`):
```ts
export function resolveSubstrate(
	env: Record<string, string | undefined>,
	configuredUrl: string,
): SubstrateTarget | undefined {
	if (env.SUBSTRATE_DISABLED === "1") return undefined;
	const fromEnv = env.SUBSTRATE_URL?.trim().replace(/\/+$/, "");
	if (fromEnv) return { url: fromEnv, source: "SUBSTRATE_URL" };
	const fromConfig = configuredUrl.trim().replace(/\/+$/, "");
	return fromConfig ? { url: fromConfig, source: "config" } : undefined;
}
```
**Fail-open request shape** (`brief.ts:74-95`):
```ts
	const target = resolveSubstrate(env, url);
	if (!target) return "";
	…
	const timeout = AbortSignal.timeout(timeoutMs(env));
	try {
		const response = await fetch(`${target.url}/brief`, {
			method: "POST",
			headers: { "content-type": "application/json", ...authHeaders(env) },
			…
		});
		if (!response.ok) return "";
		return (await response.text()).trim();
	} catch {
		return ""; // fail-open: a missing substrate never blocks a prompt
	}
```
For `registerGraph(record, env, configuredUrl, fetchImpl = fetch)`: POST `<url>/mcp`, headers add `accept: "application/json, text/event-stream"` (406 otherwise, `p20:scripts/chaos-smoke.ts:66-70`); body `{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "graph_register", arguments } }`; no `initialize`, no session header (stateless server). Outcome union `{ outcome: "registered" | "skipped" | "failed"; detail }`, never throws. A tool error is `result.isError === true` (`p16:scripts/rehearsal.ts:1297-1299`).

**Server schema to restrict arguments to** (`p20:packages/mcp-server/src/mcp.ts:445-487`):
```ts
				graph_id: z.string(),
				notion_task_page: z.string().optional(),
				repo: z.string().optional(),
				branch: z.string().optional(),
				surface: surfaceSchema.optional(),
				status: z.string().optional(),
				pr_url: z.string().optional(),
				nodes: z.array(z.object({ node_id, linear_issue_id?, linear_identifier?, notion_page?, state? })).optional(),
				steps: z.array(z.object({ node_id, step: int, linear_sub_issue_id?, notion_page?, state? })).optional(),
		…
		async (args) => json(await substrate.registerGraph({ ...args, surface: args.surface ?? callerSurface })),
```
`buildRegisterArgs(record)` is pure: `surface` only when `record.host` is one of `claude-code`, `grok-build`, `hermes`, `muse`, `omp` (`cu:src/host/types.ts:7` lists `prime-agent` too, which is not a substrate surface → omit, Pitfall 5). Record shape: `cu:src/claude/state.ts:32-62` (`host?`, `plan?`, `tracking?`).

### `src/substrate/register.test.ts` (new)

**Analog:** `cu:src/substrate/brief.test.ts:1-30` (header, `stubFetch`, `recordFetch`, `URL_` constant). Cases from RESEARCH §2: args mapping, `prime-agent` omission, opt-in skip makes no request (`recordFetch` → `[]`), SSE body parsed, 401/503/reject/timeout → `failed` without throw, bearer from a temp tokens dir, no token value in `detail`.

### `src/mcp/cli.ts` (CLI, edit)

**Analog:** itself.

**USAGE** (`cu:src/mcp/cli.ts:30-40`): add
```
  ultrathink-mcp substrate register --state <sessions/<id>.json>
  ultrathink-mcp substrate headers
```
**Subcommand shape** — copy `sessionMark` (:347-361):
```ts
function sessionMark(args: string[]): number {
	const statePath = flag(args, "--state");
	if (!statePath) throw new UsageError("session mark needs --state <path>");
	…
	const record = readRecord(statePath);
	if (!record) return 1;
```
For `substrate register`: missing `--state` → `UsageError` (exit 2); unreadable record or no `plan` → one line `substrate: skipped (<reason>)`, **exit 0** (fail-open, unlike `sessionMark`); otherwise `await registerGraph(record, process.env, loadConfig(claudeConfigPaths(process.cwd())).substrate…url)` and print one line via `out(...)`.

**Hook into `trackComplete`** (:311-323) after `writeAtomic(statePath, …)` (:314) and when `tracking.status !== "failed"`:
```ts
	record.tracking = tracking;
	const xml = injectTrackingXml(record.result.xml, plan, tracking);
	record.result = { ...record.result, xml };
	writeAtomic(statePath, `${JSON.stringify(record, null, 2)}\n`);
```
Call through a seam so `cli.test.ts` can observe it without network — extend `CliSeams` (:390-393):
```ts
export interface CliSeams {
	/** Test seam for one provider check (default: the real relay-based check). */
	checkOne?: (id: McpProviderId, deps: AuthDeps) => Promise<number>;
}
```
with `register?: (record: SessionRecord) => Promise<RegisterOutcome>`; `trackComplete` then needs the seams parameter.

**Dispatch** (:425-427):
```ts
		if (command === "track" && rest[0] === "complete") return await trackComplete(rest.slice(1));
		if (command === "session" && rest[0] === "mark") return sessionMark(rest.slice(1));
		if (command === "notion" && rest[0] === "init") return await notionInit(rest.slice(1), deps);
```
Add `substrate register` and `substrate headers` lines here. `headers` prints exactly `{"Authorization":"Bearer <v>"}` or `{}` to stdout, nothing on stderr, exit 0 always — it must bypass the generic error path at :452-458, which writes to stderr and returns 1/2.

### `src/mcp/cli.test.ts` (extend)

**Analog:** itself (:14-43 `run`/`runWith` spawning the real CLI with `HOME`, `XDG_CONFIG_HOME`, `CLAUDE_CONFIG_DIR`, `ULTRATHINK_MCP_STORE` inside a temp root; :68-133 `track complete` with a `SessionRecord` fixture and `session()` helper). New: `substrate register` on a record without `plan` → exit 0, `skipped`; with no URL configured → `skipped`, no request; `substrate headers` with no token → stdout `{}`; with `SUBSTRATE_TOKENS_DIR` pointing at a temp dir holding `claude-code` → header JSON, and stderr empty. `track complete` calling register once is tested in process with `main(argv, { register })` (the `checkOne` seam precedent at :356 "check in process").

### `scripts/mcp-register.ts` (edit: `--substrate`)

**Analog:** itself.

**Command table** (`cu:scripts/mcp-register.ts:201-208`):
```ts
const CLI_COMMANDS: Record<CliHost, { add: (entry: Entry) => string[][]; remove: (id: string) => string[][] }> = {
	claude: {
		add: (e) => [
			["claude", "mcp", "remove", "--scope", "user", e.id],
			["claude", "mcp", "add", "--scope", "user", e.id, "--", e.command, ...e.args],
		],
		remove: (id) => [["claude", "mcp", "remove", "--scope", "user", id]],
	},
```
The substrate entry is not a stdio `Entry`; add a separate plan for it: `["claude", "mcp", "remove", "--scope", "user", "substrate"]` then `["claude", "mcp", "add-json", "--scope", "user", "substrate", JSON.stringify({ type: "http", url: `${url}/mcp`, headers: { Authorization: "Bearer ${SUBSTRATE_TOKEN:-}" }, headersHelper: `${root}/bin/ultrathink-mcp substrate headers` })]` — argv elements, no shell, so `${…}` stays literal (RESEARCH §1 probe).

**Ownership rule** (:107-110):
```ts
/** An entry is ultrathink's when its command is some clone's bin/ultrathink-mcp. */
export function isOurs(command: unknown): boolean {
	return typeof command === "string" && command.trim().endsWith(OURS_SUFFIX);
}
```
Mirror as `isOurSubstrate(entry)`: `headersHelper` ends with `/bin/ultrathink-mcp substrate headers`. Read the user-scope entry from `~/.claude.json` top-level `mcpServers` as `planClaude` does (:255-274, `options.claudeConfig?.()`), and `decide()` (:112-121) for add/replace/remove semantics.

**`main` wiring** (:525-603): `--substrate` is valid only with the claude host (refuse otherwise), never default; URL from `resolveSubstrate(env, config.substrate.url)` (import from `../src/substrate/brief.ts`), refuse with a clear message when none; reuse `backup(claudeFile, stamp, dryRun, log)` (:593), the `dryRun` printing of `$ cmd` (:594-597), the plugin-cache warning (:554-558), and `applyCliPlan`'s run-then-confirm. Update `USAGE` (:15-24).

### `scripts/mcp-register.test.ts` (extend)

**Analog:** itself (`cu:scripts/mcp-register.test.ts:1-25` fixtures with a fake clone path `CMD = "/repo/claude-ultrathink/bin/ultrathink-mcp"`; `describe("CLI host planners")` at :131 and `describe("main")` at :462 with a fake `Run`). New: `--substrate` plans `add-json --scope user substrate` whose JSON has the header template naming `${SUBSTRATE_TOKEN:-}` and the helper path; `--dry-run` runs no add/remove; `--remove --substrate` removes only our entry (foreign `substrate` entry kept); no URL → refusal; non-claude host with `--substrate` → refusal.

### `skills/ultrathink-kickoff/SKILL.md` (edit step 3)

**Analog:** itself (`cu:skills/ultrathink-kickoff/SKILL.md:81-95`):
```markdown
## 3. Optional: register the graph with an Agent Substrate server

This is an optional integration. Run it only when an MCP server named `substrate` is connected in this session and you have its `graph_register` tool; otherwise skip this step silently — do not log, mention or suggest it. …

**Fail open.** If the call errors, log one line and continue. Do not retry or ask the user.
```
Copy step 1's command-first structure (:52-58: fenced `<repo>/bin/ultrathink-mcp … --state <stateFile>` block, "Only if the command itself cannot run (… exits 127 or 126), do step 2 manually"). New step 3: always run `<repo>/bin/ultrathink-mcp substrate register --state <stateFile>` once; only if the command cannot run, fall back to the MCP tool when a server named `substrate` is connected (keep the field table, drop `linear_url` and step `linear_identifier`, which the server schema does not accept); keep "fail open, one line, no retry".

### claude-ultrathink docs and changelog

- `cu:docs/configuration.md:585` env table row: `| \`SUBSTRATE_TOKEN\` | Sent as \`Authorization: Bearer <token>\` on Agent Substrate requests. |` → add rows for the token-file and tokens-dir variables, defaults stated in prose.
- `cu:docs/privacy.md:34-35` table rows "Agent Substrate server: brief/plan event" → add "Agent Substrate server: graph registration" (Notion page URLs, Linear issue ids/identifiers, repo, branch, status) and update the bearer sentence.
- `cu:docs/how-to/register-mcp-gateway.md` → a `--substrate` section; `README.md` substrate lines.
- `cu:CHANGELOG.md:8` `## [Unreleased]` → `### Added` bullets in the 1.4.0 style (long, behavioural, names flags and files).

## Shared Patterns

### Never print a value (tokens, hashes)
**Sources:** `p20:packages/mcp-server/src/config.ts:298` ("Named by surface, never by token: the warning goes to a log."); `p16:scripts/parity-check.ts:283` ("the token is never printed"); `p17:scripts/vocabulary-smoke.ts:15-16` ("Reports carry ids, counts and statuses only — never the bearer or reply bodies").
**Apply to:** `config.ts` errors, `index.ts` refusal line, `token.ts`, `identity-check.ts` (both modes), `uat-phase0.ts` reports, claude-ultrathink `register.ts` details and `substrate headers` (stdout only, the one sanctioned output).

### Store-lock-safe spelling
**Source:** `p20:packages/mcp-server/src/store-lock.test.ts:84-97` (`TOKEN_LITERAL`) and `p16:packages/mcp-server/src/rehearsal-env.ts:199-201`:
```ts
	// Short local, never a long name: a 16+ character identifier after the
	// client token key would trip the store lock's token scan.
	const token = input.firstToken;
```
**Apply to:** every new or edited file in agent-substrate (code, tests, docs, `.env.example`, unit, manifest, runbook, UAT records). Run `bun test packages/mcp-server/src/store-lock.test.ts` after any doc task (the committed `20-CONTEXT.md` already failed it once, A0).

### Bearer header shape, both Accept types for `/mcp`
**Source:** `p20:packages/mcp-server/src/server.authority.test.ts:108-125` / `p20:scripts/chaos-smoke.ts:63-73`:
```ts
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
```
**Apply to:** `cli/src/index.ts` (REST only needs content-type), `uat-phase0.ts`, `register.ts`, `emit.ts`.

### Fail-open clients
**Sources:** `p20:packages/cli/src/index.ts:14-22,63-74` (exit 0 for `brief`/`emit`/`handoff`; `post` returns `null` on any error); `cu:src/substrate/brief.ts:16-19,93-95`.
**Apply to:** `token.ts` (any read error → none), `emit.ts`, `register.ts`, `ultrathink-mcp substrate register|headers` (exit 0 always).

### Pure core + `import.meta.main` scripts, exit 0/1/2
**Sources:** `p16:scripts/parity-check.ts:309,487`, `p16:scripts/rehearsal.ts:1468`, `p17:scripts/vocabulary-smoke.ts:149,205`, `cu:scripts/mcp-register.ts:525,605-613`.
**Apply to:** `identity-check.ts`, `uat-phase0.ts` (exported pure functions tested server-free; `main(argv)` does I/O; `2` = usage or refused before any request).

### Relative imports across packages and from scripts
**Sources:** `p19:packages/collectors/src/grok-map.ts:9` (`../../mcp-server/src/types.ts`), `p20:packages/cli/src/lessons.test.ts:5`, `p16:scripts/rehearsal.ts:33-40` (`../packages/mcp-server/src/…`).
**Apply to:** `emit.ts` → `../../cli/src/token.ts`; `parity-check.ts`, `identity-check.ts`, `uat-phase0.ts` → `../packages/cli/src/token.ts`, `../packages/mcp-server/src/config.ts`, `./rehearsal.ts`.

### Subprocess tests: async spawn, allowlisted env
**Sources:** `p20:packages/mcp-server/src/http.test.ts:349-370`; `cu:src/mcp/cli.test.ts:22-43` (`spawnSync` is fine there because no in-process server is involved).
**Apply to:** `boot-refusal.test.ts`, `cli-auth.test.ts` (async `Bun.spawn`), claude-ultrathink `cli.test.ts` additions (`spawnSync` + temp `HOME`/`XDG_CONFIG_HOME`/`CLAUDE_CONFIG_DIR`). Never inherit the developer's `SUBSTRATE_TOKEN*` into a child that is asserted on.

### Root-run permission tests
**Source:** RESEARCH Pitfall 9; `p20:packages/mcp-server/src/http.test.ts:68-73` (`unwritablePath`: "A path whose parent is a regular file: impossible to create, whoever is running.").
**Apply to:** `token.test.ts`, `identity-check.test.ts`, claude-ultrathink `brief.test.ts` — simulate unreadable with a directory at the file path or an injected reader, never `chmod 000`.

### Runbook and operator-step discipline
**Source:** `p16:docs/runbooks/production-parity.md:145-162, 232-248`.
**Apply to:** `docs/runbooks/production-identity.md`, `docs/uat.md` (copyable `sh` blocks, operator-only steps named, backups outside the repo, "Agents may / Agents never / The operator" section).

### claude-ultrathink file conventions
**Source:** every `cu:` file header (`// SPDX-License-Identifier: AGPL-3.0-or-later` / `// Copyright (C) 2026 SWC Studio`), `cu:CHANGELOG.md:8`, tests beside code with fake `fetch` / fake `Run` and temp dirs.
**Apply to:** `register.ts`, `register.test.ts`, every edited `cu:` file.

## No Analog Found

| File | Role | Data Flow | Reason / what to use instead |
|---|---|---|---|
| `infra/identity/clients.json` | config manifest | — | No tracked JSON manifest exists. Use the RESEARCH §8 schema; table-as-data precedent `swarm-workspace.ts:58-63`; lock it with the marked-table test pattern. |
| names-only env-file parser in `scripts/identity-check.ts` | utility | file-I/O | The only parser (`parseShellExports`, `p16:scripts/rehearsal.ts:1217`) keeps values and requires `export `. Use its loop shape with RESEARCH §8's systemd rules (optional `export`, `#`/`;` comments, continuation lines skipped, value dropped at parse time). |

Phase 19's `emit.ts`, `emit.test.ts` and `docs/collectors.md` have planned shapes only (`p19:` plans); the planner should read the merged files before writing those edits.

## Metadata

**Analog search scope:** agent-substrate `p20:` (`packages/mcp-server/src`, `packages/cli/src`, `packages/collectors/src`, `packages/projector/src`, `packages/audit/src`, `scripts`, `docs`, `infra`, `.env.example`, `package.json`, `.planning/milestones/v1.0-phases/00-brief`); `p16:` (`scripts/rehearsal.ts`, `scripts/parity-check.ts` and tests, `packages/mcp-server/src/rehearsal-env.ts`, `docs/rehearsal.md`, `docs/runbooks/production-parity.md`); `p17:` (`scripts/vocabulary-smoke.ts`, `packages/mcp-server/src/event-sources.test.ts`, `docs/event-vocabulary.md`, `package.json`); `p19:` (19-01-PLAN.md, `grok-map.ts`); claude-ultrathink `origin/main` `ed3243e` (`src/substrate/brief.ts`, `brief.test.ts`, `src/mcp/cli.ts`, `cli.test.ts`, `src/mcp/sse.ts`, `scripts/mcp-register.ts`, `mcp-register.test.ts`, `skills/ultrathink-kickoff/SKILL.md`, `src/claude/state.ts`, `src/host/types.ts`, `CHANGELOG.md`, docs grep).
**Files scanned:** ~45 (read or grepped).
**Tracked check:** all analog paths confirmed with `git ls-files` in their worktree (19 `p20:`, 7 `p16:`, 3 `p17:`); `cu:` paths read from `origin/main`.
**Pattern extraction date:** 2026-10-09
