# Phase 17: Event vocabulary and audit policy - Pattern Map

**Mapped:** 2026-10-08
**Files analyzed:** 12 (8 new, 4 modified) + 1 optional doc link edit
**Analogs found:** 12 / 12 (every analog is git-tracked; verified with `git --no-optional-locks ls-files` at `88f8f8f`)

All paths are relative to the worktree root `/root/src/worktrees/agent-substrate-v13-p17`. Phase 16 files (`scripts/rehearsal.ts`, `scripts/rehearsal-env.ts`) are **not on this branch**. Nothing below names them as an analog to import. Only their planned contract is cited (16-PATTERNS.md).

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `packages/mcp-server/src/event-sources.ts` (new) | model / typed registry | transform (source → `EventInput`) | `packages/mcp-server/src/types.ts` (const enums) + `packages/collectors/src/grok-map.ts` (EventInput builder) | role-match (no typed-table-of-samples exists yet) |
| `packages/mcp-server/src/event-sources.test.ts` (new) | test | transform + file-I/O (doc parse) | `packages/mcp-server/src/event.test.ts` + `authority.test.ts:237-242` (repo-root file read) | exact (combined) |
| `packages/mcp-server/src/vocabulary-lock.test.ts` (new) | test | none (literal pin) | `packages/mcp-server/src/authority.test.ts:219-227` | exact |
| `scripts/phase-close-check.ts` (new) | utility CLI | batch (spawn tests, read git object) | `packages/projector/src/swarm-workspace.ts:552-587` (CLI shape) + `packages/mcp-server/src/git.ts:40-49` (spawn) | role-match |
| `scripts/phase-close-check.test.ts` (new) | test | pure functions | `packages/projector/src/swarm-workspace.test.ts:1-42` + `packages/collectors/src/grok-map.test.ts` | role-match |
| `scripts/vocabulary-smoke.ts` (new) | utility CLI (HTTP smoke) | request-response | `scripts/chaos-smoke.ts` (HTTP-only client, check/report/exit) + `swarm-workspace.ts` (`main` + `import.meta.main`) | exact (role and flow) |
| `scripts/vocabulary-smoke.test.ts` (new) | test | pure functions | `packages/projector/src/swarm-workspace.test.ts` | role-match |
| `docs/event-vocabulary.md` (new) | doc (machine-checked table) | n/a | `docs/swarm-correlation.md` (tables, "The closed enum") + `AGENTS.md:1-5` (HTML comment markers) | role-match |
| `packages/audit/src/policy.ts` (mod) | config (policy sets) | n/a | itself, lines 16-26 and 45-68 | exact |
| `packages/audit/src/policy.test.ts` (mod) | test | n/a | itself, lines 44-75 | exact |
| `docs/mcp-audit.md` (mod) | doc | n/a | itself, lines 226-242 | exact |
| `package.json` (mod) | config | n/a | itself, `scripts` block (`smoke:greptime`, `smoke:chaos`) | exact |
| `docs/swarm-correlation.md` (optional mod) | doc | n/a | itself, lines 164-168 | exact |

---

## Pattern Assignments

### `packages/mcp-server/src/event-sources.ts` (model / typed registry, transform)

**Analog 1:** `packages/mcp-server/src/types.ts`. It gives the closed-enum and type-derivation idiom, and the `EventInput` shape that `sample()` returns.

Enum + derived type (lines 50-64). This is what makes a kind outside the enum a type error:
```ts
export const EVENT_KINDS = [
	"session.start",
	"prompt",
	"claim",
	"tool.call",
	"file.edit",
	"shell",
	"commit",
	"pr",
	"handoff",
	"session.end",
	"note",
	"warning",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
```

`EventInput` (lines 70-85). `sample()` returns exactly this. Leave out `ts`; ingest stamps it (RESEARCH anti-pattern):
```ts
/** An event as a collector submits it. `id`, `ts`, `hash` and `prev` are filled in on ingest. */
export interface EventInput {
	surface: Surface;
	kind: EventKind;
	summary: string;
	session_id?: string;
	graph_id?: string;
	node_id?: string;
	linear_identifier?: string;
	step?: number;
	repo?: string;
	branch?: string;
	actor?: Actor;
	payload?: Record<string, unknown>;
	/** Collector-supplied timestamp; defaults to ingest time. */
	ts?: string;
}
```

**Analog 2:** `packages/collectors/src/grok-map.ts`. It gives the import style and the per-event `EventInput` literal.

Import (line 9). It is type-only, so the module stays side-effect-free and later collectors can import `../../mcp-server/src/event-sources.ts` the same way:
```ts
import type { EventInput } from "../../mcp-server/src/types.ts";
```
In `event-sources.ts` (same package) this becomes `import type { EventInput, EventKind, Surface } from "./types.ts";`. Import **nothing else**: no `event.ts`, `service.ts` or `redact.ts`.

`tool.call` payload shape (lines 88-102). Copy it for `muse.tool_call`, with keys `tool`, `outcome` and `duration_ms`:
```ts
		case "tool_completed": {
			const tool = event.tool_name ?? "unknown tool";
			const failed = event.outcome !== undefined && event.outcome !== "success";
			const duration = typeof event.duration_ms === "number" ? ` (${event.duration_ms}ms)` : "";
			return {
				...base,
				kind: "tool.call",
				summary: `${tool}${failed ? ` failed: ${event.outcome}` : ""}${duration}`,
				payload: {
					tool: tool,
					outcome: event.outcome,
					duration_ms: event.duration_ms,
					tool_call_id: event.tool_call_id,
				},
			};
		}
```
Unknown type becomes a `note` (lines 152-155). This is the runtime rule the doc records for `herdr.other`:
```ts
		default:
			// An unrecognised type is recorded rather than dropped: Grok adds event
			// types over time and silent loss is worse than a low-value note.
			return { ...base, kind: "note", summary: `grok ${type}` };
```

**Analog 3:** `packages/mcp-server/src/service.ts`. These are the existing emit precedents the samples must mirror.

`payload.action` discriminator on a `note`/`warning` (release, lines 1047-1066):
```ts
			await this.emit({
				surface: holder?.surface ?? "claude-code",
				kind: decision.action === "forced" ? "warning" : "note",
				...
				payload: {
					action: decision.action,
					lease_epoch: decision.observed_epoch,
					...(decision.evicted ? { evicted: decision.evicted } : {}),
				},
				...(await this.placeOf(graphId)),
			}).catch(() => undefined);
```
Reaper (line ~1130): `payload: { action: "expired", lease_epoch: lease.lease_epoch, expired_at: lease.expired_at, ... }`, `kind: "warning"`, fallback surface `"claude-code"`.

One-event session for a job/server event (graph_bind, lines 822-834). Job samples (`anchor.*`, `dispatch.*`, `skills.sync.refused`) follow this:
```ts
				await this.emit({
					surface: boundBy ?? "claude-code",
					kind: "note",
					summary: `bound correlation ${correlationId} to ${result.graph_id}`,
					graph_id: result.graph_id,
					// Its own one-event session: a sessionless event has no chain to join, and
					// two bindings on one graph would otherwise share the "" bucket in `verifyGraph`.
					session_id: `bind:${result.graph_id}:${correlationId}`,
					actor: "agent",
					payload: { correlation_id: correlationId, bound_by: boundBy },
				}).catch(() => undefined);
```

A refusal is a `warning` carrying decision, reason and ids, never the body (`auditMemoryWrite`, lines 719-748). `*.refused` / `*.failed` samples follow this:
```ts
	 * The event carries the decision, never the body. The body may be exactly the
	 * secret or the PII that got the write quarantined, ...
	...
		await this.emit({
			surface: writer as Surface,
			kind: result.outcome === "conflict" ? "note" : "warning",
			summary: line,
			graph_id: request.graph_id,
			session_id: request.session_id,
			repo: request.repo,
			payload: {
				outcome: result.outcome,
				reason: result.reason,
				scope: request.scope,
				kind: request.kind,
				...
			},
		}).catch(() => undefined);
```

**Cursor stop precedent:** `packages/projector/src/cursor.ts:46` already emits `session.end` as `cursor` with `--actor human`:
```ts
	stop: command("emit --kind session.end --summary 'cursor session ended' --surface cursor --actor human"),
```

**Shape to build** (RESEARCH Pattern 1; field names are discretion): `SurfaceRule` union (`{ fixed: Surface } | "herdr-agent" | "caller" | "job-token" | "memory-writer" | "lease-holder"`); an `EventSource` interface with `id, phase, kind: EventKind, surface, actions?, runtime?, carriesRepo, periodic, sample(): EventInput`; `export const EVENT_SOURCES: readonly EventSource[]` (27 rows per RESEARCH inventory); `export const SILENT_SOURCES` (doc rows with kind `—`). Keep these constraints:
- No `node_id` on `tool.call` samples (drift.ts `work.unclaimed`).
- No payload key matching redact.ts `SENSITIVE_KEY` (`token`, `secret`, `password`, `authorization`, `credential`, `api_key`, `private_key`).
- Hashes are 64-hex literals; no content fields.

---

### `packages/mcp-server/src/event-sources.test.ts` (test, transform + doc parse)

**Analog 1:** `packages/mcp-server/src/event.test.ts`. Imports and the `EventInput` fixture style (lines 1-22):
```ts
import { describe, expect, test } from "bun:test";
import {
	canonicalJson,
	eventHash,
	inChainOrder,
	InvalidEventError,
	normalizeEvent,
	normalizeIdentifier,
	verifyChain,
} from "./event.ts";
import { REDACTED } from "./redact.ts";
import type { EventInput, SubstrateEvent } from "./types.ts";

const base: EventInput = {
	surface: "claude-code",
	kind: "file.edit",
	summary: "edited gateway/ws.rs, ran cargo test (pass)",
	session_id: "sess-1",
	graph_id: "ut-mz3k1q-8a1f2c3d",
	node_id: "n2",
	repo: "swcstudiospace/autonogrammer",
};
```
Use `normalizeEvent(sample, null)` as the real write-path gate (event.ts:124-159). It throws `InvalidEventError` on an unknown surface (126-128) or kind (129-131), and returns `payload: normalizePayload(input.payload)` (redacted and capped). Deep-equal `stored.payload` against `sample.payload ?? {}`.

**Analog 2:** `packages/mcp-server/src/authority.test.ts:237-242`. Read a repo-root file from a test in this package:
```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
...
		const example = readFileSync(join(import.meta.dir, "..", "..", "..", ".env.example"), "utf8").split("\n");
```
→ `const DOC = join(import.meta.dir, "..", "..", "..", "docs", "event-vocabulary.md");`. The same `ROOT` idiom is in `store-lock.test.ts:22` (`const ROOT = join(import.meta.dir, "..", "..", "..");`).

**Analog 3:** `packages/collectors/src/grok-map.test.ts:1-38`. This is the "loop over cases, one `expect` per case" style, with `describe` blocks named after the property:
```ts
describe("mapGrokEvent — noise", () => {
	test("drops the types that dominate the log", () => {
		// 52,621 phase_changed against 2,550 real tool calls on this host.
		for (const type of ["phase_changed", "first_token", "loop_started", "mcp_health_check"]) {
			expect(mapGrokEvent({ type }, ctx)).toBeNull();
		}
	});
```
For loops, put the id inside the expected object (`expect({ id, kind }).toEqual({ id, kind: ... })`) so a failure names the row (RESEARCH code examples).

Tests to write, all from RESEARCH: doc table ids, kinds and actions equal `EVENT_SOURCES ∪ SILENT_SOURCES` (marker parse, Pattern 2); every sample survives `normalizeEvent` unchanged in kind, surface and payload; roadmap-source prefix coverage; repo rule `!(periodic && sample.repo)` and `Boolean(sample.repo) === carriesRepo`; no content keys.

---

### `packages/mcp-server/src/vocabulary-lock.test.ts` (test, literal pin)

**Analog:** `packages/mcp-server/src/authority.test.ts:219-227`. It already pins counts and partial order (it stays):
```ts
describe("the swarm surfaces", () => {
	test("are the 15 agents, in A01..A15 order, after the original 11", () => {
		expect(SWARM_SURFACES).toHaveLength(15);
		expect(SURFACES).toHaveLength(26);
		expect(SURFACES.slice(11)).toEqual([...SWARM_SURFACES]);
		expect(SWARM_SURFACES[0]).toBe("swarm-a01-orch");
		expect(SWARM_SURFACES[4]).toBe("swarm-a05-be");
		expect(SWARM_SURFACES[14]).toBe("swarm-a15-doc");
	});
```
New file: `import { EVENT_KINDS, SURFACES } from "./types.ts";` and two `expect([...X]).toEqual([full literal])` tests (RESEARCH "Lock test (literal, ordered)"). Copy the literal values from `types.ts:11-27, 30-43, 50-63` verbatim. Add a file docblock in the style of `store-lock.test.ts:1-17` (what is locked, why, which doc).

---

### `scripts/phase-close-check.ts` (utility CLI, batch)

**Analog 1 (CLI skeleton):** `packages/projector/src/swarm-workspace.ts:544-587`, the repo's only `import.meta.main` user. Pure exports, `main(argv): number`, exit 2 for refusal or usage:
```ts
function usage(message: string): never {
	process.stderr.write(
		`[projector] ${message}\nusage: swarm-workspace.ts --workspace <ws> [--runtimes ${RUNTIMES.join(",")}] --plan|--check|--apply\n` +
			"       swarm-workspace.ts --spec\n",
	);
	process.exit(2);
}

function main(argv: string[]): number {
	...
	try {
		...
		return 0;
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
→ `[phase-close]` prefix. Export `BASELINE`, `LOCK_TESTS`, `parseEventKinds`, `diffKinds`, `missingFiles`. Exit codes: 0 pass, 1 test failure or kind diff, 2 missing test file or baseline object absent.

**Analog 2 (spawn: fixed argv, no shell, timeout, null on failure):** `packages/mcp-server/src/git.ts:40-49`:
```ts
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
→ `["git", "--no-optional-locks", "-C", ROOT, "show", `${BASELINE}:packages/mcp-server/src/types.ts`]`, with `env` carrying `PATH` and `HOME` plus the git optional-locks variable set to `"0"`, and without `GIT_DIR`/`GIT_WORK_TREE` (RESEARCH Pattern 3).

**Analog 3 (spawn bun from a script, repo-root cwd):** `store-lock.test.ts:98-105`, and `swarm-workspace.test.ts:33-42` for `process.execPath`:
```ts
	const proc = Bun.spawnSync([process.execPath, CLI, ...args], { ... });
	return { code: proc.exitCode ?? -1, out: proc.stdout.toString(), err: proc.stderr.toString() };
```
→ `Bun.spawnSync([process.execPath, "test", ...LOCK_TESTS.map((f) => `./${f}`)], { cwd: ROOT, stdout: "inherit", stderr: "inherit" })`. **Run `missingFiles(ROOT, LOCK_TESTS)` first.** Bun 1.4.0 exits 0 when one listed file is missing but another matches (RESEARCH Pitfall 1).

Import the current enum the way the root scripts do (`greptime-smoke.ts:33-37` imports `../packages/mcp-server/src/...`): `import { EVENT_KINDS } from "../packages/mcp-server/src/types.ts";`.

Header docblock: copy the `#!/usr/bin/env bun` + `/** ... bun run <name> ... */` style of `scripts/chaos-smoke.ts:1-48`. State what it proves, that git is read-only (`show` only, never fetch or checkout), and the exit codes.

---

### `scripts/phase-close-check.test.ts` and `scripts/vocabulary-smoke.test.ts` (test, pure functions)

**Analog:** `packages/projector/src/swarm-workspace.test.ts:1-15`. The test imports the CLI module's exported pure functions; importing does not run `main` because of the `import.meta.main` guard:
```ts
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
...
import { apply, plan, ProjectionRefused } from "./swarm-workspace";
```
→ `import { diffKinds, missingFiles, parseEventKinds } from "./phase-close-check.ts";` and `import { parseConsumerEnv, refuseTarget, runTag } from "./vocabulary-smoke.ts";`. No git, no spawn and no network inside these tests. Use a temp dir (`mkdtempSync(join(tmpdir(), "p17-"))` as in `swarm-workspace.test.ts:23-30`) for `missingFiles`. `tsconfig.json:16` already includes `scripts/**/*.ts` and root `bun test` discovers `scripts/*.test.ts`, so no config change is needed.

Sentinel discipline (swarm-workspace.test.ts:18-19): if a test needs a token value for `parseConsumerEnv`, use a short fixture (< 16 chars, e.g. `tok-p17`) and never a token key `=` long-value literal. The `TOKEN_LITERAL` scan at `store-lock.test.ts:95` covers test files too.

---

### `scripts/vocabulary-smoke.ts` (utility CLI, request-response over HTTP)

**Analog:** `scripts/chaos-smoke.ts`. HTTP-only client, no ledger client (store lock), `check()` results, a report, and exit 0/1/2.

Request helper with a per-request timeout (lines 110-124):
```ts
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
Check/report (lines 126-131 and 372-385):
```ts
const results: Array<{ ok: boolean; what: string; detail?: string }> = [];

function check(ok: boolean, what: string, detail?: string): void {
	results.push({ ok, what, detail });
	process.stdout.write(`${ok ? "  ok  " : " FAIL "} ${what}${detail ? ` — ${detail}` : ""}\n`);
}
...
const failed = results.filter((result) => !result.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
...
process.exit(failed.length === 0 ? 0 : 1);
```
Preflight refusal with exit 2 and no request sent (lines 185-196):
```ts
if (boot.status === null) {
	process.stderr.write(
		`substrate-mcp is unreachable at ${BASE}: ${boot.error}\n` + ...
	);
	process.exit(2);
}
if (boot.status === 401) {
	process.stderr.write("substrate-mcp refused the token. ...\n");
	process.exit(2);
}
```

**Deviate from the analog in three places** (RESEARCH anti-patterns):
1. `chaos-smoke.ts:51` defaults `SUBSTRATE_URL` to `http://127.0.0.1:7410` and reads `process.env`. The vocabulary smoke has **no default URL**, never reads the URL or token from `process.env`, and reads only `${XDG_RUNTIME_DIR || "/tmp"}/substrate-rehearsal/<name>/consumer.env`.
2. The helpers in `chaos-smoke.ts` cannot be imported because its top level runs on import. Use the swarm-workspace shape instead: exported pure `parseConsumerEnv`, `refuseTarget` and the run-tag helper, then `async function main(argv): Promise<number>` and `if (import.meta.main) process.exit(await main(process.argv.slice(2)));` (16-PATTERNS.md:72 notes the async form).
3. Hold the bearer in a short local (`const bearer = env.SUBSTRATE_TOKEN;`, then `authorization: \`Bearer ${bearer}\``). Never put the token key on the left of `:`/`=` with a 16+ char identifier on the right (store-lock `TOKEN_LITERAL`, line 95). Print only ids, counts and statuses, never the token or reply bodies.

Server contract the smoke asserts (`packages/mcp-server/src/server.ts:336-372`):
```ts
				sendJson(res, result.stored ? 202 : 503, {
					id: result.event.id,
					ts: result.event.ts,
					hash: result.event.hash,
					stored: result.stored,
					...(result.error ? { error: result.error } : {}),
					...(result.warning ? { warning: result.warning } : {}),
				});
...
			if (req.method === "POST" && url.pathname === "/events/query") {
				...
				const result = await substrate.queryEvents(body as Parameters<Substrate["queryEvents"]>[0]);
				// An empty window is a real answer, so 200; 503 is the ledger not answering.
				sendJson(res, result.error ? 503 : 200, result);
```
Attribution for a non-swarm token (`mcp.ts:91-97`): `return { surface: (supplied as Surface | null | undefined) ?? callerSurface ?? "claude-code" };`. The harness `claude-code` token can therefore post every sample's own surface.

Run tag: copy the `chaos-smoke.ts:55-56` idiom (`const GRAPH_ID = \`ut-chaos-${Date.now().toString(36)}\``), but use the `rh-vocab-<epoch-ms>` prefix (RESEARCH Pitfall 7) and `session_id = \`${tag}-${entry.id}\``. Read back by exact `graph_id` with `limit: 500, include_payload: true, order: "asc"`, using a bounded retry.

---

### `docs/event-vocabulary.md` (doc with one machine-checked table)

**Analog 1 (style):** `docs/swarm-correlation.md:1-46`. An H1, a one-paragraph purpose with links, `##` sections, and pipe tables with a `| --- |` separator and backticked identifiers:
```markdown
# Swarm correlation, identity and leases (S1, S2)

What the substrate provides so that Agent Swarm can run on it
([ADR 0001](adr/0001-agent-swarm-as-sdlc-mesh-on-substrate.md), phase S1, SPE-5052):
...
| Agent | Surface | Server-side token variable |
| --- | --- | --- |
| A01 | `swarm-a01-orch` | `SUBSTRATE_TOKEN_SWARM_A01_ORCH` |
```
The closed-enum precedent this doc generalises (`docs/swarm-correlation.md:164-168`):
```markdown
## The closed enum

`EVENT_KINDS` stays the closed set of 12. A swarm event type maps onto one of those kinds
and carries the specific type in `payload.swarm_type`; the enum is not widened. The
mapping table lives with the swarm's tee, not here. The lease rules above add no kind.
```

**Analog 2 (markers):** `AGENTS.md:1-5`:
```markdown
<!-- substrate-brief:start -->
...
<!-- substrate-brief:end -->
```
→ Wrap the parsed table in `<!-- event-sources:start -->` / `<!-- event-sources:end -->`. Cell rules from RESEARCH Pattern 2: no `|` inside a cell, one kind or `—` per row, and actions comma-separated or `—`.

Sections, from CONTEXT: the mapping rules with reasons; the marked table; silent sources; the herdr agent→surface table (marked `[UNVERIFIED]`, pinned by Phase 19); "Deferred producers" (`hermes-eng-board` → `hermes` + `runtime: "eng-board"`, unparsed); host-job surface (the open operator question and its recommended default); Lane A uses `claude-code` rather than `rivet-agentos`, with the reason; and the phase-close check (`bun run check:phase-close`, run by every later phase).

Secret hygiene (store-lock scans all tracked docs): name env keys only in backticks or prose, e.g. `` `SUBSTRATE_TOKEN` ``, and never show one assigned. Name no Greptime credential key at all.

---

### `packages/audit/src/policy.ts` (modified config)

**Analog:** itself. Append to the existing sets under a phase comment. `auditMode` (lines 77-80) does not change.

`FAIL_CLOSED_TOOLS` (lines 16-26), where the new entries go after `"coord_reap_leases"`:
```ts
export const FAIL_CLOSED_TOOLS: ReadonlySet<string> = new Set([
	"graph_claim",
	...
	"memory_write",
	"coord_handoff",
	"coord_reap_leases",
]);
```
`FAIL_OPEN_TOOLS` (lines 45-68). It already groups entries with `//` section comments. Add a `// v1.3 reads, decided in Phase 17.` group after the REST block:
```ts
	// REST routes, named as `server.ts` audits them.
	"brief",
	"events",
	"verify",
	"drift",
	"healthz",
	"metrics",
	"slo",
	"evidence",
]);
```
Reword the docblock sentence at lines 39-41 ("The two sets below are exhaustive over the tools in `mcp.ts` and the REST routes in `server.ts`") to cover served tools **plus** the v1.3 planned tools, marked by phase (RESEARCH Pitfall 6). Exact entries and comments: RESEARCH Pattern 5.

---

### `packages/audit/src/policy.test.ts` (modified test)

**Analog:** itself. The explicit-membership idiom (lines 65-71):
```ts
	test("the write tools are all fail-closed, explicitly rather than by default", () => {
		// Default-deny catches a tool nobody decided about; it should not be what is
		// carrying the decision for a tool somebody did.
		for (const tool of ["graph_heartbeat", "graph_bind", "coord_handoff", "coord_reap_leases"]) {
			expect(FAIL_CLOSED_TOOLS.has(tool)).toBe(true);
		}
	});

	test("the two lists do not overlap", () => {
		for (const tool of FAIL_CLOSED_TOOLS) expect(FAIL_OPEN_TOOLS.has(tool)).toBe(false);
	});
```
The REST-name idiom (lines 44-62), which the planned REST twins inherit (audited under the tool's own name):
```ts
		// The two action routes are audited under their MCP tools' own names, and inherit
		// those tools' fail-closed mode rather than being listed twice.
		expect(auditMode("memory_write")).toBe("fail-closed");
		expect(auditMode("coord_handoff")).toBe("fail-closed");
```
Add a `PLANNED_V13` literal table, independent of `policy.ts`, plus one test inside `describe("auditMode", ...)` (RESEARCH Pattern 5). Leave the existing tests unchanged; the "unknown tool" test uses `"some_new_tool"`, which is not a planned name. For the optional discretionary scan, read sibling sources with the authority.test idiom: `readFileSync(join(import.meta.dir, "..", "..", "mcp-server", "src", "mcp.ts"), "utf8")`. `registerTool(` and the name sit on separate lines (`mcp.ts:178-179`: `server.registerTool(\n\t\t"memory_brief",`), so use `/registerTool\(\s*"([a-z_]+)"/g`. For `server.ts`, use `/auditedRest\(res, observability, surface, "([a-z_]+)"/g` (e.g. `server.ts:338` `auditedRest(res, observability, surface, "events", body)`).

---

### `docs/mcp-audit.md` (modified doc)

**Analog:** itself, "Fail open, fail closed" (lines 226-242):
```markdown
## Fail open, fail closed

| | Tools | Why |
| --- | --- | --- |
| **fail-open** | every read — `memory_brief`, ... — plus `events_emit`, and the `/brief`, `/events`, `/events/query`, `/verify`, `/drift`, `/evidence` routes | These sit inside a prompt's hook budget. ... |
| **fail-closed** | `graph_claim`, `graph_release`, ... `coord_reap_leases` | Everything that grants or transfers exclusive ownership of a node, ... |
...
**Both lists are exhaustive over the tools this substrate serves**, and `policy.test.ts`
pins that.
```
Add the planned tools to each row, marked by phase (e.g. `docs_search` (Phase 25)), or add a "Planned in v1.3 (Phase 17)" sub-table with the CONTEXT "Why" column. Reword the "exhaustive" sentence (line 233) to cover served plus planned tools, and link `[event-vocabulary.md](event-vocabulary.md)`. Note the REST twins' rule next to the existing REST section (line 244ff, "REST is audited under the same names").

---

### `package.json` (modified config)

**Analog:** its own `scripts` block:
```json
    "smoke:greptime": "bun scripts/greptime-smoke.ts",
    "smoke:chaos": "bun scripts/chaos-smoke.ts"
```
→ add `"smoke:vocabulary": "bun scripts/vocabulary-smoke.ts"` and `"check:phase-close": "bun scripts/phase-close-check.ts"`. Phase 16 adds entries to the same block, so expect a trivial merge.

### `docs/swarm-correlation.md` (optional, one-line link)

Lines 164-168, "The closed enum": add a sentence linking `event-vocabulary.md` as the one mapping table for v1.3 sources. This follows RESEARCH "Architectural Responsibility Map", which says the doc links to it.

---

## Shared Patterns

### Pure core, thin CLI
**Source:** `packages/projector/src/swarm-workspace.ts:552-587`
**Apply to:** `scripts/phase-close-check.ts`, `scripts/vocabulary-smoke.ts`
```ts
if (import.meta.main) process.exit(main(process.argv.slice(2)));
```
Export the pure helpers; tests import them without triggering spawn, git or network. Exit codes follow the repo convention seen in `chaos-smoke.ts`, `greptime-smoke.ts`, `backfill-run.ts` and `install-git-hook.ts`: 0 pass, 1 check failed, 2 precondition refused / usage.

### Bounded subprocess, no shell
**Source:** `packages/mcp-server/src/git.ts:40-49`; `store-lock.test.ts:98-105`
**Apply to:** `scripts/phase-close-check.ts` (git show, bun test)
Fixed argv array, `timeout`, `stdout: "pipe"`, return null or a code rather than throwing. Pass `--no-optional-locks` to every git call.

### Store lock and secret hygiene
**Source:** `packages/mcp-server/src/store-lock.test.ts:72, 95, 107-131`
**Apply to:** every new `.ts` outside `packages/mcp-server/src` (both scripts and their tests), plus `docs/event-vocabulary.md`, `docs/mcp-audit.md` and this phase's planning docs
- No `GREPTIME_` substring in any `.ts` outside `packages/mcp-server/src` (line 124-129 test).
- No import of a `greptime` module and no SQL naming `agent_events` outside the ledger package.
- No `SUBSTRATE_TOKEN*` key followed by `:`/`=` and a 16+ char `[\w.~+/=-]` value, anywhere tracked (comments included).
- Scripts reach the ledger only through `SUBSTRATE_URL` HTTP (`chaos-smoke.ts:14-17` docblock states this).

### Event payload discipline
**Source:** `service.ts` release/reaper (`payload.action`), `graph_bind` (one-event session), `auditMemoryWrite` (decision, never body)
**Apply to:** every `EVENT_SOURCES.sample()` and the doc's rules section
`note` for success, `warning` for refusal or failure; `payload.action` as the discriminator; `payload.runtime` for non-agent producers; hashes and lengths, never content; fallback surface `"claude-code"`.

### Test file conventions
**Source:** `event.test.ts:1`, `policy.test.ts:1-2`, `grok-map.test.ts:1-2`
**Apply to:** all new `*.test.ts`
`import { describe, expect, test } from "bun:test";` and sibling imports with an explicit `.ts` extension (`./types.ts`, `./policy.ts`). Tests sit beside their source. Explanatory `//` comments inside tests say *why* the case matters (policy.test.ts style).

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| (part of) `scripts/vocabulary-smoke.ts`: `parseConsumerEnv` | utility | file-I/O parse | No `consumer.env` reader exists on this branch. Phase 16's `toShellExports` (planned, `export KEY='value'` lines, 16-PATTERNS.md:258) is the format contract. Use RESEARCH Pattern 4's regex and re-check it against the merged `rehearsal-env.ts` at execution (RESEARCH A2) |
| (part of) `event-sources.test.ts`: Markdown marked-table parser | utility | transform | No test parses a Markdown table yet. Use RESEARCH Pattern 2 `parseMarkedTable` |
| (part of) `scripts/phase-close-check.ts`: reading a blob at a baseline commit | utility | file-I/O | No existing `git show <rev>:<path>` caller. Combine the spawn shape from `git.ts:40-49` with RESEARCH Pattern 3 |

## Metadata

**Analog search scope:** `packages/mcp-server/src`, `packages/audit/src`, `packages/collectors/src`, `packages/projector/src`, `packages/cli/src` (exit-code grep), `scripts/`, `docs/`, `AGENTS.md`, `package.json`, `.planning/phases/16-*/16-PATTERNS.md` (planned contract only)
**Files scanned:** 24
**Pattern extraction date:** 2026-10-08
