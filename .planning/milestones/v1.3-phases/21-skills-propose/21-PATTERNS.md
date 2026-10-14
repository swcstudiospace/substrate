# Phase 21: skills_propose - Pattern Map

**Mapped:** 2026-10-08
**Files analyzed:** 33 (14 new, 19 modified)
**Analogs found:** 31 / 33 (2 have no code analog yet: they depend on Phase 17 files that exist only as plans)

**Where the analogs live:**
- **Main**: this worktree, `/root/src/worktrees/agent-substrate-v13-p21` (HEAD `d85bf4e`).
- **`acc30a8`**: the September port source. Read it with `git -C /root/src/worktrees/agent-substrate-v13-p21 show acc30a8:<path>`.
- **P16**: `/root/src/worktrees/agent-substrate-v13-phase`, at HEAD `890c236` (WR-08). That worktree is still taking review fixes, so **anchor by symbol**; the line numbers below are from `890c236`.
- **Phase 17/18 contracts**: the P17 and P18 worktrees (`5f9dcc0`/`8560068`, `dc1a25b`) hold **plans only**. Neither has `event-sources.ts`, `redact-lock.test.ts`, `docs/event-vocabulary.md`, `redactSkillContent` or `scanSkillFiles` in code yet (verified with `ls packages/mcp-server/src/` in both). Main's `redact.ts` exports only `REDACTED`, `redact` and `redactValue` (redact.ts:13, 53, 98).

All analog paths are git-tracked. Checked with `git ls-files` on main and in the P16 worktree; the `acc30a8` paths are git objects. No gitignored mirror paths are named.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `packages/mcp-server/src/skills/propose.ts` (new) | service/engine | request-response + file-I/O + subprocess | `acc30a8:packages/mcp-server/src/skills/propose.ts` | exact (port) |
| `packages/mcp-server/src/skills/frontmatter.ts` (new) | utility | transform | `acc30a8:packages/mcp-server/src/skills/frontmatter.ts` | exact (verbatim) |
| `packages/mcp-server/src/skills/propose.test.ts` (new) | test | — | `acc30a8:packages/mcp-server/src/skills/propose.test.ts` | exact (port) |
| `packages/mcp-server/src/skills/propose.git.test.ts` (new) | test (real git) | file-I/O | main `packages/mcp-server/src/git.test.ts` + the fixture builder below | role-match |
| `packages/mcp-server/src/skills/authority.ts` (new, optional) | utility (pure policy) | transform | main `mcp.ts` `attributedSurface`/`claimAttribution` (91-117) | role-match |
| `packages/mcp-server/src/config.test.ts` (new, or extend `authority.test.ts`) | test | — | main `authority.test.ts` `configWarnings` describes (40-90) | exact |
| `packages/mcp-server/src/rehearsal-skills.ts` (new) | utility (fixture builder) | file-I/O + subprocess | P16 `packages/mcp-server/src/rehearsal-env.ts` + P16 `scripts/rehearsal.ts` `gitOutput` | role-match |
| `packages/mcp-server/src/rehearsal-fake-gh.ts` (new) | utility/CLI shim | file-I/O (JSON state) | P16 `scripts/rehearsal.ts` `main`/`import.meta.main` + `acc30a8` propose.ts lock/ledger | partial |
| `packages/mcp-server/src/rehearsal-skills.test.ts` (new) | test | — | P16 `packages/mcp-server/src/rehearsal-env.test.ts` | exact |
| `packages/cli/src/skills.ts` (new) | CLI command module | request-response (HTTP client) + file-I/O | main `packages/cli/src/lessons.ts` (`runLessons(argv, deps)`) + `acc30a8:packages/cli/src/index.ts:207-343` | exact |
| `packages/cli/src/skills.test.ts` (new) | test | — | main `packages/cli/src/lessons.test.ts` (Bun.serve stub, `harness()`) + main `http.test.ts` `run()` spawn | exact |
| `scripts/skills-propose-smoke.ts` (new) | script (live proof) | request-response | P16 `scripts/rehearsal.ts` `runSmoke` + helpers (862-1045) | exact |
| `scripts/skills-propose-smoke.test.ts` (new) | test | — | P16 `scripts/rehearsal.test.ts` | exact |
| `docs/skills-propose.md` (new) | docs | — | main `docs/lessons-bank.md` (feature contract doc), P16 `docs/rehearsal.md` | role-match |
| `packages/mcp-server/src/service.ts` (mod) | service | request-response + event | `acc30a8 service.ts:89-111,171-188`; main `bindGraph` emit (817-834), `auditMemoryWrite` (720-748) | exact |
| `packages/mcp-server/src/server.ts` (mod) | route | request-response | `acc30a8 server.ts:35-81,156-204`; main `/memory` and `/handoff` routes (374-437) | exact |
| `packages/mcp-server/src/mcp.ts` (mod) | MCP tool | request-response | `acc30a8 mcp.ts:143-176`; main `graph_bind` (491-521), `graph_release` operator gate (605-639) | exact |
| `packages/mcp-server/src/observe.ts` (mod) | config/registry | — | main `KNOWN_ROUTES` (53), `KNOWN_TOOLS` (309-338) | exact |
| `packages/mcp-server/src/config.ts` (mod) | config | — | main `loadConfig` (153-191), `configWarnings` (278-307), `audit` block (93-101) | exact |
| `packages/mcp-server/src/index.ts` (no edit expected) | entry | — | main index.ts:24-26 already prints `configWarnings` | n/a |
| `packages/audit/src/policy.ts` (mod only if Phase 17 did not add it) | config/registry | — | main `FAIL_CLOSED_TOOLS` (16-26) | exact |
| `packages/audit/src/policy.test.ts` (mod) | test | — | main policy.test.ts "write tools are all fail-closed, explicitly" (65-71) | exact |
| `packages/mcp-server/src/event-sources.ts` (mod, Phase 17 file) | registry | — | **none in code**; P17 `17-01-PLAN.md`/`17-PATTERNS.md:170` contract | no analog |
| `packages/mcp-server/src/event-sources.test.ts` (mod, Phase 17 file) | test | — | **none in code**; P17 plan | no analog |
| `docs/event-vocabulary.md` (mod, Phase 17 file) | docs | — | P17 plan (marker table) | plan-only |
| `packages/cli/src/index.ts` (mod) | CLI dispatch | — | main index.ts:1-22 (header), 387-402 (`case "lessons"`), 403-415 (usage) | exact |
| `packages/mcp-server/src/rehearsal-env.ts` (mod) | utility | transform | P16 `buildRehearsalEnv` (134-163) | exact |
| `packages/mcp-server/src/rehearsal-env.test.ts` (mod) | test | — | P16 "allowlist" describe (178-221) | exact |
| `scripts/rehearsal.ts` (mod) | script | — | P16 `UpOptions` (420-426), `TwinState` (358-374), `runUp` (509-…), `main`/`usage` (1047-1098) | exact |
| `scripts/rehearsal.test.ts` (mod) | test | — | P16 `parseOperator` describe (167-195) | exact |
| `package.json` (mod) | config | — | P16 package.json `scripts` (18-27) | exact |
| `docs/mcp-audit.md`, P16 `docs/rehearsal.md`, `.env.example` (mod) | docs/config | — | main mcp-audit.md:226-227; P16 rehearsal.md:36-60; main .env.example:127-133 | exact |
| `server.test.ts`, `mcp.test.ts`, `service.test.ts` / new `skills.service.test.ts`, `observe.test.ts`, `http.test.ts` (mod) | tests | — | `server.authority.test.ts`, `mcp.test.ts`, `graph-bind.test.ts`, `observe.test.ts:36-47,352-356`, `http.test.ts:300-326` | exact |

---

## Pattern Assignments

### `packages/mcp-server/src/skills/propose.ts` (engine, subprocess + file-I/O)

**Analog:** `acc30a8:packages/mcp-server/src/skills/propose.ts` (640 lines). Port it whole. Copy from `git show acc30a8:…`; do not retype. Change only what is listed here.

**Header and imports** (acc30a8 L1-28). Keep the doc comment. Drop the `Refs`/`D-04` ids if desired. Keep the import line exactly; it resolves once Phase 18 lands:
```ts
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { redact, redactSkillContent, type SkillDocExampleRule, type SkillFileHit, scanSkillFiles } from "../redact.ts";
import { SURFACES, type Surface } from "../types.ts";
import { parseFrontmatter } from "./frontmatter.ts";
```

**Constants** (L30-53). Keep `LIBRARY_REPO` and `LIBRARY_URL` as exported **defaults**, and `ROUTE_MAX_BYTES = 1_000_000`. **Delete** `CLI_MAX_BYTES` (L41-42; D21-08). Keep `RUN_TIMEOUT_MS = 120_000`, `OUTPUT_TAIL_CHARS = 400` and `LOCK_WAIT_MS = 20_000`.

**Types and errors** (L55-131). Keep `ProposeInput`, `ProposeOptions`, `ProposeStatus`, `ProposeResult`, `ValidatedProposal`, `SkillProposer`, `ProposeRefused` and `ProposeFailed` as they are. The excerpt of the two errors that every door maps:
```ts
/** A guard refused the proposal before any git or gh call. Findings name file, line and rule, never a value. */
export class ProposeRefused extends Error {
	readonly findings?: SkillFileHit[];
	constructor(message: string, findings?: SkillFileHit[]) {
		super(message);
		this.name = "ProposeRefused";
		if (findings) this.findings = findings;
	}
}
/** A git or gh step failed (or a lock stayed busy); the message carries at most 400 redacted characters of output. */
export class ProposeFailed extends Error { constructor(message: string) { super(message); this.name = "ProposeFailed"; } }
```
Add `library: SkillsLibrary` to `ProposeOptions`, or bind it in `createSkillProposer`. Remove the `/** CLI only (D-18) */` and `CLI --replace only` wording from the option docs, because those options are now operator-gated (D21-05).

**Argv builders, pinned by tests** (L261-320). Copy them as they are. Only three signatures gain the configured value, and `argv[0]` stays a literal `"git"`/`"gh"`:
```ts
export function setUrlArgv(dir: string): string[] {
	return ["git", "-C", dir, "remote", "set-url", "origin", LIBRARY_URL];            // → (dir, remoteUrl)
}
export function prListHeadArgv(branch: string): string[] {
	return ["gh", "pr", "list", "--repo", LIBRARY_REPO, "--head", branch, "--state", "open", "--json", "url,number"]; // → (branch, repo)
}
export function prCreateArgv(branch: string, title: string, body: string): string[] {
	return ["gh", "pr", "create", "--repo", LIBRARY_REPO, "--head", branch, "--base", "main", "--title", title, "--body", body]; // → (…, repo)
}
```

**Slug checks** (L322-339). `originMatches(url, slug)` is unchanged. In `prUrlOf`, the comparison `match[1]?.toLowerCase() === LIBRARY_REPO` becomes `=== repo.toLowerCase()`, with the slug passed in.

**Commit message** (L381-383). Drop the last line:
```ts
function commitMessage(v: ValidatedProposal): string {
	return `skill(${v.name}): ${v.surface} proposal\n\nskill-content-sha256: ${v.content_sha256}\nRefs SPE-2734`; // drop "\nRefs SPE-2734"
}
```

**Runner** (L387-411). Keep the `RunResult`/`Runner` types. Replace `execFileRunner` with `createExecFileRunner({ gh, home })`. Keep the execFile shape and change only `env` and the binary mapping (D21-15). The original reads:
```ts
export function execFileRunner(argv: readonly string[]): Promise<RunResult> {
	const { promise, resolve: done } = Promise.withResolvers<RunResult>();
	execFile(argv[0] as string, argv.slice(1),
		{ timeout: RUN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: "utf8",
		  env: { ...process.env, HOME: "/root", GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" } }, // ← spread is the leak D21-15 forbids
		(error, stdout, stderr) => {
			const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
			done({ code, stdout: String(stdout), stderr: String(stderr) });
		});
	return promise;
}
```
The target shape is RESEARCH "Pattern 1": env = `{ PATH, HOME: home || process.env.HOME || "/root", GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" }`, and `argv[0] === "gh"` maps to the configured binary.

**Leave these as they are:** `tail`/`must` (L413-421), locks (L425-464), ledger (L466-498), `pathsFor` (L502-513), `openPr`/`fromLedger` (L515-566), `countNameStatus` (L568-577).
- `openPr` L518's message uses `LIBRARY_REPO`; switch it to the configured slug.
- `fromLedger` L553 calls `prListHeadArgv(known.branch)`; add the repo.

**`proposeSkill` order** (L584-635). Keep this exact step order. The only additions are the mirror-exists check and the configured slug in the origin check (L627):
```ts
export async function proposeSkill(input: ProposeInput, opts: ProposeOptions): Promise<ProposeResult> {
	const v = validateProposal(input, opts);
	const paths = pathsFor(opts);
	// NEW (D21-14): if (!existsSync(join(paths.mirror, "HEAD"))) throw new ProposeFailed(`<mirror> missing; bootstrap: …`)
	const waitMs = opts.lockWaitMs ?? LOCK_WAIT_MS;
	const run = opts.run;
	const releaseContent = opts.dryRun ? null : await acquireLock(join(paths.contentLocks, v.content_sha256), "proposal", waitMs);
	let clone: string | null = null;
	try {
		if (!opts.dryRun) { const known = await fromLedger(run, v, input, opts, paths.ledger); if (known) return known; }
		const releaseMirror = await acquireLock(paths.mirrorLock, "mirror", waitMs);
		try { await must(run, "git fetch", fetchArgv(paths.mirror)); } finally { releaseMirror(); }
		…
		await must(run, "git commit", commitArgv(clone, commitMessage(v)));
		const origin = await must(run, "git remote get-url", originUrlArgv(clone));
		if (!originMatches(origin.stdout, LIBRARY_REPO)) throw new ProposeFailed(`clone origin is not ${LIBRARY_REPO}; refusing to push`); // → library.repo
		await must(run, "git push", pushArgv(clone, branch));
		ledgerAppend(paths.ledger, { …, state: "pushed" });
		return await openPr(run, v, input, branch, paths.ledger);
	} finally {
		if (clone) rmSync(clone, { recursive: true, force: true });
		releaseContent?.();
	}
}
```
Render the missing-mirror text from RESEARCH §1a (September 04-02 bootstrap, three lines), using the configured URL and path.

**Seam** (L637-640):
```ts
export function createSkillProposer({ run }: { run: Runner }): SkillProposer {
	return { propose: (input, opts) => proposeSkill(input, { ...opts, run }) };
}
```
Extend it to `{ run, library, stateDir }`.

**Lock rules that bind this file** (Phase 18 redact-lock):
- Import the redactor only from `../redact.ts`.
- Name no helper `redact*`, `scanSkill*` or `*Redactor`.
- Write no `[REDACTED` literal and no credential-prefix regex.

---

### `packages/mcp-server/src/skills/frontmatter.ts` (utility, transform)

**Analog:** `acc30a8:packages/mcp-server/src/skills/frontmatter.ts`, 20 lines. Port it **verbatim**:
```ts
const FENCE_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
export function parseFrontmatter(text: string): Record<string, unknown> | null {
	const match = FENCE_RE.exec(text);
	if (!match) return null;
	let parsed: unknown;
	try { parsed = Bun.YAML.parse(match[1] ?? ""); } catch { return null; }
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	return parsed as Record<string, unknown>;
}
```

---

### `packages/mcp-server/src/skills/propose.test.ts` (test)

**Analog:** `acc30a8:packages/mcp-server/src/skills/propose.test.ts`, 583 lines, about 35 tests. The describes are at L142, 154, 196, 246, 290, 332, 482, 521 and 575.

**Fixture block** (L38-56). `state` is a mkdtemp per test, and `options()` passes `stateDir: state`:
```ts
const NAME = "demo-skill";
const PR_URL = "https://github.com/swcstudiospace/agent-skills/pull/7";
function skillMd(name = NAME, description = "Does one reusable thing."): string {
	return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n1. Step one.\n`;
}
function input(overrides: Partial<ProposeInput> = {}): ProposeInput {
	return { name: NAME, files: { "SKILL.md": skillMd() }, rationale: "because", surface: "claude-code", ...overrides };
}
let state: string;
beforeEach(() => { state = mkdtempSync(join(tmpdir(), "propose-test-")); });
afterEach(() => { rmSync(state, { recursive: true, force: true }); });
```

**Fake runner** (L58-105). Keep `step()` and `fake()` as they are. The default replies key off the step name:
```ts
const replies: Record<string, Partial<RunResult>> = {
	"diff-quiet": { code: 1 },
	"get-url": { stdout: `${LIBRARY_URL}\n` },
	"gh pr create": { stdout: `${PR_URL}\n` },
	"gh pr view": { stdout: JSON.stringify({ state: "OPEN", url: PR_URL, number: 7 }) },
	"gh pr list": { stdout: "[]" },
	...opts.replies,
};
function options(run: Runner, overrides: Partial<ProposeOptions> = {}): ProposeOptions {
	return { maxBytes: ROUTE_MAX_BYTES, mode: "overlay", run, stateDir: state, ...overrides }; // + library
}
```

**Criterion-1 pins** (L295-329). Keep both tests. Update `setUrlArgv`, `prListHeadArgv` and `prCreateArgv` to the library-aware signatures. Keep the forbidden list:
```ts
const forbidden = ["--force", "-f", "--force-with-lease", "--search"];
for (const argv of all) for (const element of argv) expect(forbidden).not.toContain(element);
for (const element of pushArgv(dir, br)) expect(element).not.toContain(":");
```

**Step-order and commit pin** (L401-415). Update the last line to drop `\nRefs SPE-2734`:
```ts
expect(f.steps()).toEqual(["fetch", "clone", "set-url", "checkout", "add", "diff-quiet", "commit", "get-url", "push", "gh pr create"]);
expect(commit.at(-1)).toBe(`skill(${NAME}): claude-code proposal\n\nskill-content-sha256: ${sha()}\nRefs SPE-2734`); // drop suffix
```

**Changes when porting:**
- The "allowDocExamples jwt" test (L232) carries a literal JWT. Assemble it at runtime from fragments (Phase 18 convention).
- New cases:
  - a non-default library reaches `set-url`, `--repo` and `prUrlOf`;
  - `createExecFileRunner` env equals the allowlist, and `gh` maps to the configured binary (stub `execFile` is unnecessary; assert the built env object if exported);
  - a missing `mirror.git` throws `ProposeFailed` naming the bootstrap, before any Runner call.
- Every test that uses `proposeSkill` needs `mkdirSync(join(state, "mirror.git"))` plus a `HEAD` file once the mirror check exists.

---

### `packages/mcp-server/src/skills/propose.git.test.ts` (test, real git; no Docker)

**Analog:** main `packages/mcp-server/src/git.test.ts:1-35`. It builds real repos in a temp dir and does no stubbing:
```ts
const made: string[] = [];
function tempRepo(options: { commit?: string } = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "substrate-git-"));
	made.push(dir);
	const run = (args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
	run(["init", "--initial-branch=main"]);
	run(["config", "user.email", "test@example.invalid"]);
	run(["config", "user.name", "Substrate Test"]);
	…
}
afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });
```
The header comment (git.test.ts:1-9) explains why to use real git rather than a stub; reuse that reasoning.

Build the bare repo and mirror with **the same builder the harness uses** (`rehearsal-skills.ts`; the commands are in RESEARCH "Fixture builder", verified in §5). Run `proposeSkill` with the production runner plus an in-process fake-gh Runner wrapper. Assert:
- `opened`;
- the branch exists in the bare repo;
- the bare repo's reflog has an all-zero old sha.

---

### `packages/mcp-server/src/skills/authority.ts` (optional pure policy)

**Analog:** main `mcp.ts:73-117` (`Attribution`, `attributedSurface`, `claimAttribution`). Copy the union-result shape. **Do not reuse** the body-first fallback (mcp.ts:91-97 is swarm-only strict):
```ts
/** Who an `events_emit` / `graph_claim` is attributed to — or why it is refused. */
export type Attribution = { surface: Surface } | { refused: string };

export function attributedSurface(callerSurface: Surface | null, supplied: string | null | undefined): Attribution {
	if (isSwarmSurface(callerSurface)) {
		if (supplied === undefined || supplied === null || supplied === callerSurface) return { surface: callerSurface };
		return { refused: `this token is ${callerSurface} and cannot act as ${supplied}` };
	}
	return { surface: (supplied as Surface | null | undefined) ?? callerSurface ?? "claude-code" }; // ← NOT for proposals
}
```
- The refusal wording to mirror: `this token is ${callerSurface} and cannot act as ${supplied}`.
- The target shape is RESEARCH "Pattern 2" (`proposeAuthority` → `{surface}` or `{status: 401|403, error}`).
- Tests go beside the existing `describe("attributedSurface")` style in `authority.test.ts:274-319`: plain `expect(fn(...)).toEqual({...})`.

---

### `packages/mcp-server/src/service.ts` (service, request-response + fail-open event)

**Analog A, September's method:** `acc30a8:packages/mcp-server/src/service.ts:89-111,171-188`.

Seam:
```ts
readonly skills: SkillProposer;
constructor(readonly config: SubstrateConfig, stores?: { …; skills?: SkillProposer; … }) {
	…
	this.skills = stores?.skills ?? createSkillProposer({ run: execFileRunner });
}
```

Method:
```ts
async proposeSkill(input: ProposeInput): Promise<ProposeResult> {
	const result = await this.skills.propose(input, { maxBytes: ROUTE_MAX_BYTES, mode: "overlay" });
	await this.emit({
		kind: "skill.propose",                          // ← rejected kind; becomes "note" + payload.action
		surface: input.surface,
		summary: `skill ${input.name} ${result.status}`,
		...(input.session_id ? { session_id: input.session_id } : {}),
		...(input.graph_id ? { graph_id: input.graph_id } : {}),
		actor: "agent",
		payload: { name: input.name, status: result.status, pr_url: result.pr_url, content_sha256: result.content_sha256 },
	}).catch(() => undefined);
	return result;
}
```

**Analog B, main's constructor** (service.ts:459-475). This is where `skills?: SkillProposer` is added:
```ts
constructor(
	readonly config: SubstrateConfig,
	stores?: { index?: IndexStore | null; greptime?: GreptimeClient | null },   // ← add skills?: SkillProposer
	observer: SubstrateObserver = {},
) {
	this.index = stores?.index !== undefined ? stores.index : config.postgresUrl ? new IndexStore(config.postgresUrl) : null;
	…
}
```
Default: `createSkillProposer({ run: createExecFileRunner({ gh: config.skills.gh }), library: config.skills, stateDir: config.skills.stateDir })`. It is inert until called.

**Analog C, main's fail-open emit with an action payload and its own session:** `bindGraph`, service.ts:817-834:
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

**Analog D, a refusal warning that carries the decision and never the body:** `auditMemoryWrite`, service.ts:720-748. Copy the `kind: … ? "note" : "warning"` split and the comment "The event carries the decision, never the body". The release emit (1050-1065) shows `payload: { action: … }` as the discriminator.

**Shape of the new method:** `proposeSkill(input, caller: { surface: Surface; isOperator: boolean })`.
1. Run the authority and operator check, which throws a 403-class error and emits nothing.
2. Call `this.skills.propose(...)`.
3. On success, emit a `note` with `repo: this.config.skills.repo`, unless `dry_run`.
4. Catch `ProposeRefused`: emit a `warning` with no repo, `status: "refused"` and `rules`, then rethrow.
5. Catch `ProposeFailed`: emit a `warning` with no repo, `status: "failed"` and the redacted reason, then rethrow.

Every emit uses `.catch(() => undefined)`.

---

### `packages/mcp-server/src/server.ts` (route, request-response)

**Analog A, September's route and error mapping:** `acc30a8:packages/mcp-server/src/server.ts:35-52,63-81,156-204`.

`BodyTooLargeError`, to port and throw from main's `readBody` (main server.ts:117-126, which currently throws `new Error("request body too large")` at :122):
```ts
/** A body over MAX_BODY_BYTES: 413, and final for that body. */
export class BodyTooLargeError extends Error {
	constructor() { super("request body too large"); this.name = "BodyTooLargeError"; }
}
async function readBody(req: IncomingMessage): Promise<string> {
	…
	if (size > MAX_BODY_BYTES) throw new BodyTooLargeError();
	…
}
```

Body-shape check (acc30a8 L63-81). Port it; extend it for `dry_run`, `mode`, `reopen` and `allow_doc_examples`:
```ts
/** The propose body's shape (the service validates content); a message for 400, or null. */
function proposeBodyProblem(body: unknown): string | null {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return "body must be a JSON object";
	const b = body as Record<string, unknown>;
	if (typeof b.name !== "string") return "name must be a string";
	if (b.files === null || typeof b.files !== "object" || Array.isArray(b.files)) return "files must be an object of relative path to text";
	if (Object.values(b.files).some((value) => typeof value !== "string")) return "every file must be a string of UTF-8 text";
	if (typeof b.rationale !== "string") return "rationale must be a string";
	if (b.remove !== undefined && (!Array.isArray(b.remove) || b.remove.some((path) => typeof path !== "string"))) return "remove must be an array of relative paths";
	if (b.surface !== undefined && (typeof b.surface !== "string" || !(SURFACES as readonly string[]).includes(b.surface))) return `unknown surface ${JSON.stringify(String(b.surface)).slice(0, 80)}`;
	for (const key of ["session_id", "graph_id"] as const) if (b[key] !== undefined && typeof b[key] !== "string") return `${key} must be a string`;
	return null;
}
```

Catch-block branches (acc30a8 L192-204). Insert them before main's `InvalidEventError` branch at server.ts:482:
```ts
if (cause instanceof BodyTooLargeError) { sendJson(res, 413, { error: cause.message }); return; }
if (cause instanceof ProposeRefused) { sendJson(res, 400, { error: cause.message, ...(cause.findings ? { findings: cause.findings } : {}) }); return; }
if (cause instanceof ProposeFailed) { sendJson(res, 502, { error: redact(cause.message).slice(0, 400) }); return; }
```

**Analog B, a main fail-closed action route audited under its tool name:** `/memory` (server.ts:374-389) and `/handoff` (393-437):
```ts
if (req.method === "POST" && url.pathname === "/memory") {
	const raw = await readBody(req);
	const body = JSON.parse(raw) as Record<string, unknown>;
	// Audited as `memory_write`, the name the MCP tool is audited under, …
	if (!(await auditedRest(res, observability, surface, "memory_write", body))) return;
	…
}
```
- **Keep the `auditedRest(res, observability, surface, "skills_propose", body)` call on one line, with exactly those argument names.** Phase 17's policy scan regex reads it.
- Place the route before `/mcp` (server.ts:475).
- Follow the route order in RESEARCH "Route skeleton": `surface === null` → 401 before `readBody`.
- `caller` is already built at server.ts:224 (`const caller: McpCaller = { surface, isOperator: isOperator(config, authorization) }`); pass it to `substrate.proposeSkill`.

**Header comment** (server.ts:1-24). Add `POST /skills/propose` to the route list (D21-19):
```
 *   POST /memory        write a memory entry through the governance gate
 *   POST /skills/propose  propose a skill as a branch + PR on the skills library   ← new line
```

**Imports** (server.ts:25-44). Add `ProposeFailed`, `ProposeRefused` (from `./skills/propose.ts`), `redact` (from `./redact.ts`) and `SURFACES`, which `proposeBodyProblem` needs, from `./types.ts`. Main currently imports only `type Surface` at :44.

---

### `packages/mcp-server/src/mcp.ts` (MCP tool)

**Analog A, September's tool:** `acc30a8:packages/mcp-server/src/mcp.ts:143-176`. Copy the schema and the error mapping; replace the auth lines:
```ts
server.registerTool(
	"skills_propose",
	{
		title: "Propose a skill to the shared library",
		description: "Validates and redacts a skill, then opens a branch and pull request on the private library … Needs an authenticated surface or the host propose key.", // ← drop the propose-key clause
		inputSchema: {
			name: z.string().describe("the skill's directory name: ^[a-z0-9][a-z0-9-]{0,63}$, equal to SKILL.md's frontmatter name"),
			files: z.record(z.string(), z.string()).describe("relative path → UTF-8 text; must contain SKILL.md"),
			rationale: z.string().describe("why this skill is worth keeping; goes into the PR body"),
			remove: z.array(z.string()).optional().describe("relative paths to delete from the library skill; never SKILL.md"),
			surface: surfaceSchema.optional().describe(OWNER_SURFACE_HINT),   // ← main has no OWNER_SURFACE_HINT; write a describe()
			session_id: z.string().optional(),
			graph_id: z.string().optional(),
			// + dry_run, mode: z.enum(["overlay","replace"]), reopen, allow_doc_examples: z.array(z.enum(["pem","jwt"]))
		},
		annotations: { destructiveHint: false, openWorldHint: true },
	},
	async ({ surface, ...args }) => {
		if (!opts.proposeAllowed) return refusal("…");          // ← becomes: if (callerSurface === null) return refusal("skills_propose needs an authenticated surface; nothing was proposed")
		const owner = ownerSurface(surface, callerSurface);      // ← becomes the strict D21-03 check (or let the service throw)
		if (owner.refusal !== undefined) return refusal(owner.refusal);
		try {
			return json(await substrate.proposeSkill({ ...args, surface: owner.surface }));   // ← (input, { surface: callerSurface, isOperator })
		} catch (cause) {
			if (cause instanceof ProposeRefused) {
				return refusal(JSON.stringify({ error: cause.message, ...(cause.findings ? { findings: cause.findings } : {}) }));
			}
			if (cause instanceof ProposeFailed) return refusal(JSON.stringify({ error: cause.message }));
			throw cause;
		}
	},
);
```

**Analog B, main's operator-gated tool:** `graph_release`, mcp.ts:614-639. `isOperator` is in scope from the destructure at mcp.ts:174-175:
```ts
const { surface: callerSurface, isOperator } =
	caller === null || typeof caller === "string" ? { surface: caller, isOperator: false } : caller;
…
async ({ graph_id, node_id, lease_id, force }) => {
	if (force && !isOperator) return json(FORCE_REFUSED);
	…
}
```

**Analog C, typed service error → `refusal`:** `graph_bind`, mcp.ts:510-520:
```ts
try { return json(await substrate.bindGraph(args, callerSurface)); }
catch (cause) { if (cause instanceof InvalidBindError) return refusal(cause.message); throw cause; }
```

**Placement:** register before `return server;` (mcp.ts:795). `refusal()` is at mcp.ts:153-155; `json()` at :66-68; `surfaceSchema` at :37.

---

### `packages/mcp-server/src/observe.ts` (registry)

**Analog:** the same file. `KNOWN_ROUTES` (observe.ts:53):
```ts
const KNOWN_ROUTES = ["/brief", "/events", "/verify", "/healthz", "/mcp", "/metrics", "/slo", "/evidence"] as const; // append "/skills/propose"
```

`KNOWN_TOOLS` (observe.ts:309-338). Append `"skills_propose"` to the MCP block after `"coord_reap_leases"`, and **not** to the REST block. The comment at :330-331 says a route audited under the tool's own name is not repeated:
```ts
	"coord_reap_leases",
	// REST routes, as `server.ts` audits them. A route audited under a tool's own name
	// (`/memory` as `memory_write`) is covered by that name above and not repeated.
```

**Tests:** observe.test.ts:36-39 and 352-356 show the pattern:
```ts
expect(normalizeRoute("/brief")).toBe("/brief");          // add "/skills/propose"
expect(toolLabel("graph_claim")).toBe("graph_claim");     // add "skills_propose"
```

---

### `packages/mcp-server/src/config.ts` (config)

**Analog:** the same file.

**Interface field.** Add a nested block like `audit: { path: string | null }` (config.ts:93-101). Copy its doc-comment style:
```ts
/**
 * Where the hash-chained MCP audit is written. `null` keeps it in memory.
 * …
 */
audit: { path: string | null };
```
New block: `skills: { repo: string; remoteUrl: string; stateDir: string; gh: string; problem: string | null }`. Name the field however you like; `problem` carries the D21-13 invalid-combination reason.

**Reading.** Copy the `loadConfig` style, `env.X?.trim() || default` (config.ts:153-191):
```ts
audit: { path: env.SUBSTRATE_AUDIT_PATH?.trim() || null },
requireRecordedClaims: booleanOrNull(env.SUBSTRATE_CLAIM_REQUIRE_LEDGER),
```
`loadConfig({})` must keep returning defaults without throwing; dozens of tests call it.

**Boot warning.** Append to `configWarnings` (config.ts:278-307), which `index.ts:24-26` already prints as `[substrate] misconfigured — …`. **Watch out:** `configWarnings` returns early at :280 (`if (config.operatorTokens.size === 0) return warnings;`). Put the skills check **before** that early return, or every anonymous or no-operator deployment silently drops it. Name keys, never values (comment at :298):
```ts
export function configWarnings(config: SubstrateConfig): string[] {
	const warnings: string[] = [];
	if (config.operatorTokens.size === 0) return warnings;   // ← skills warning must be pushed above this line
	…
	// Named by surface, never by token: the warning goes to a log.
```

**Test analog:** `authority.test.ts:66-90`:
```ts
const stranded = loadConfig({ SUBSTRATE_TOKEN_HERMES: "tok-hermes", SUBSTRATE_OPERATOR_TOKENS: "tok-nowhere" });
expect(configWarnings(stranded)).toHaveLength(1);
expect(configWarnings(stranded)[0]).toContain("cannot authenticate");
expect(configWarnings(loadConfig(TOKENS))).toEqual([]);
expect(configWarnings(loadConfig({}))).toEqual([]);
```

---

### `packages/audit/src/policy.ts` + `policy.test.ts` (registry + test)

**Analog:** the same files. The set to extend, only if Phase 17's entry is absent on the base (policy.ts:16-26):
```ts
export const FAIL_CLOSED_TOOLS: ReadonlySet<string> = new Set([
	"graph_claim", "graph_release", "graph_complete", "graph_register", "graph_heartbeat",
	"graph_bind", "memory_write", "coord_handoff", "coord_reap_leases",
	// + "skills_propose" (Phase 17 17-02 adds it with a "Phase 21" comment)
]);
```

**Test pattern:** policy.test.ts:65-71, the explicit-membership test. Add `"skills_propose"` and also assert `auditMode("skills_propose") === "fail-closed"`:
```ts
test("the write tools are all fail-closed, explicitly rather than by default", () => {
	for (const tool of ["graph_heartbeat", "graph_bind", "coord_handoff", "coord_reap_leases"]) {
		expect(FAIL_CLOSED_TOOLS.has(tool)).toBe(true);
	}
});
```
The REST-route test (policy.test.ts:44-63) lists action routes under their tool names (`memory_write`, `coord_handoff`). Add `skills_propose` there with the same comment shape.

---

### `packages/mcp-server/src/event-sources.ts`, `event-sources.test.ts`, `docs/event-vocabulary.md` (Phase 17 files)

**No code analog.** These files do not exist in any worktree yet. Follow the P17 contract (`17-PATTERNS.md:170`, `17-01-PLAN.md:68,75`):
- `EventSource { id, phase, kind: EventKind, surface: SurfaceRule, actions?, runtime?, carriesRepo, periodic, sample(): EventInput }`.
- The rows `skills.propose` (`note`, `caller`, `skill.propose`, carriesRepo **true**) and `skills.propose.refused` (`warning`, `caller`, carriesRepo **false**).

**This phase adds:**
- `skills.propose.failed` (phase 21, `warning`, `caller`, actions `["skill.propose"]`, carriesRepo false, periodic false, sample `payload.status: "failed"`);
- the matching row between the `docs/event-vocabulary.md` table markers.

If the execution base models statuses differently, follow the base (D21-17).

**Test idiom:** look rows up by id, then assert:
- `written[0].kind === row.kind`;
- `written[0].payload.action === row.actions[0]`;
- `Boolean(written[0].repo) === row.carriesRepo`.

The emit-capture technique is in graph-bind.test.ts (see the Shared Patterns "Ledger stub").

---

### `packages/cli/src/skills.ts` (CLI command module, HTTP client + dir read)

**Analog A, module shape:** main `packages/cli/src/lessons.ts`.
- Header doc listing subcommands (lessons.ts:1-19).
- Imports, including the cross-package redactor import (lessons.ts:20-24):
  ```ts
  import { REDACTED, redact, redactValue } from "../../mcp-server/src/redact.ts";
  import { list, parseArgs, str, type Args } from "./args.ts";
  ```
- A separate long timeout with an env override (lessons.ts:45-49, 739-742):
  ```ts
  /** Longer than the hooks' 1.5 s on purpose. Nothing waits on a lessons command, … */
  const DEFAULT_TIMEOUT_MS = 10_000;
  export function lessonsTimeout(raw: string | undefined): number {
  	const value = Number(raw);
  	return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
  }
  ```
  Copy this as `skillsTimeout` with `180_000` and its own variable, e.g. `SUBSTRATE_SKILLS_TIMEOUT_MS`.
- The deps-injected entry point (lessons.ts:921-967):
  ```ts
  export interface LessonsDeps { memory: MemoryApi; repo: string | undefined; root: string; cwd: string; now: () => Date; out: (text: string) => void; err: (text: string) => void; }
  export async function runLessons(argv: string[], deps: LessonsDeps): Promise<number> {
  	const [command, ...rest] = argv;
  	const args = parseArgs(rest);
  	try {
  		switch (command) { case "add": return await add(args, deps); … default: deps.out(USAGE); return command && command !== "help" ? 2 : 0; }
  	} catch (cause) { if (!(cause instanceof UsageError)) throw cause; deps.err(`[substrate] ${cause.message}\n`); return 2; }
  }
  ```
  `runSkills(argv, { post, out, err, cwd })` should mirror this.

**Analog B, September's behaviour:** `acc30a8:packages/cli/src/index.ts:207-343`.

`readSkillDir` (L207-239). Keep its refusals, **but** change the cap to the 1 MB JSON-body pre-flight (`Buffer.byteLength(JSON.stringify(body))`, RESEARCH Pitfall 2), not `CLI_MAX_BYTES`:
```ts
class DirRefused extends Error {}
/**
 * Every file under `dir` as UTF-8 text, keyed by its relative path. Nothing is skipped silently:
 * a symlink, a special file or a file that is not valid UTF-8 refuses the whole dir, naming it,
 * and so does a total over the CLI cap.
 */
function readSkillDir(dir: string): Record<string, string> {
	const files: Record<string, string> = {};
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let bytes = 0;
	const walk = (abs: string, rel: string) => {
		for (const entry of readdirSync(abs).sort()) {
			const path = join(abs, entry);
			const relPath = rel ? `${rel}/${entry}` : entry;
			const stat = lstatSync(path);
			if (stat.isSymbolicLink()) throw new DirRefused(`${relPath} is a symlink`);
			if (stat.isDirectory()) walk(path, relPath);
			else if (!stat.isFile()) throw new DirRefused(`${relPath} is not a regular file`);
			else {
				bytes += stat.size;
				if (bytes > CLI_MAX_BYTES) throw new DirRefused(`the dir is over the limit of ${CLI_MAX_BYTES} bytes`);
				try { files[relPath] = decoder.decode(readFileSync(path)); } catch { throw new DirRefused(`${relPath} is not valid UTF-8`); }
			}
		}
	};
	walk(dir, "");
	return files;
}
```

Output and refusal helpers (L241-262). Keep them, and keep the `--allow-doc-examples` parsing (L263-271):
```ts
const out = (key: string, value: string | number | undefined) => { if (value !== undefined) process.stdout.write(`${key}=${value}\n`); };
const refuse = (message: string) => { out("status", "refused"); process.stderr.write(`[substrate] skills propose refused: ${message}\n`); return 1; };
```

The result-printing block (L305-313) maps to `key=value` lines, and a finding prints as `out("finding", \`${finding.file}:${finding.line} ${finding.rule}\`)` (L297).

**Delete from the port:**
- the in-process `proposeSkill(…, { run: execFileRunner })` call (L285-294);
- `--surface` (L274);
- the self-posted `kind: "skill.propose"` event (L314-333);
- `event_status`.

The CLI now posts `/skills/propose` with `SUBSTRATE_TOKEN` and maps HTTP status to an exit code (D21-10).

**Redact-lock:** import types from `../../mcp-server/src/skills/propose.ts` or `redact.ts` with `import type` only. Name no helper `redact*`.

---

### `packages/cli/src/index.ts` (CLI dispatch)

**Analog:** the same file.
- **Header** (index.ts:3-22). Add a line beside `lessons`, and extend the exit-status paragraph to say `skills propose` reports failure like `verify`/`drift`:
  ```
   *   substrate lessons add|recall|digest|outcome   the lessons bank (docs/lessons-bank.md)
   *   substrate skills propose --dir D ...          propose a skill to the library (docs/skills-propose.md)   ← new
  ```
- **Dispatch** (index.ts:387-402). Copy `case "lessons"`, which builds deps from `base()` and `SUBSTRATE_TOKEN`:
  ```ts
  case "lessons":
  	process.exit(
  		await runLessons(rest, {
  			memory: httpMemory({ url: base(), token: process.env.SUBSTRATE_TOKEN?.trim() || undefined, timeoutMs: lessonsTimeout(process.env.SUBSTRATE_TIMEOUT_MS) }),
  			…
  			out: (text) => process.stdout.write(text),
  			err: (text) => process.stderr.write(text),
  		}),
  	);
  ```
- **Usage block** (index.ts:403-415). Add `"substrate skills propose --dir <path> [--name N] [--rationale R] [--remove a,b] [--session I] [--graph G] [--dry-run] [--replace] [--reopen] [--allow-doc-examples pem,jwt]\n"`.
- **Do not reuse `post()`** (index.ts:62-73). It uses the 1.5 s `timeout()` and returns `null` without a status. `skills.ts` owns its own fetch with the long timeout, like `httpMemory`.

---

### `packages/cli/src/skills.test.ts` (test)

**Analog A, stub server and harness:** lessons.test.ts:58-73 and 217-235:
```ts
class FakeSubstrate {
	token = "tok-test";
	readonly server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => this.handle(request) });
	readonly url = `http://127.0.0.1:${this.server.port}`;
	…
}
function harness(overrides: Partial<LessonsDeps> = {}) {
	const out: string[] = []; const err: string[] = [];
	const deps: LessonsDeps = { …, out: (text) => out.push(text), err: (text) => err.push(text), ...overrides };
	return { run: (argv: string[]) => runLessons(argv, deps), out: () => out.join(""), err: () => err.join("") };
}
```

**Analog B, one real spawn, async and never `spawnSync`:** http.test.ts:348-370:
```ts
async function run(args: string[], env: Record<string, string> = {}) {
	const child = Bun.spawn(["bun", CLI, ...args], { cwd: ROOT, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
	return { exitCode, stdout, stderr };
}
```

**Fixtures:**
- For the symlink refusal use `symlinkSync` (P16 `scripts/rehearsal.test.ts` imports it at :7).
- For non-UTF-8 use `writeFileSync(path, Buffer.from([0xff, 0xfe]))`.

---

### `packages/mcp-server/src/rehearsal-env.ts` + `rehearsal-env.test.ts` (P16 files, modified)

**Analog:** P16 `buildRehearsalEnv` (rehearsal-env.ts:134-163). Add the state key unconditionally beside the audit path, and the fixture keys only when the input carries them:
```ts
env.SUBSTRATE_AUDIT_PATH = join(input.runDir, "mcp-audit.jsonl");
env.SUBSTRATE_HANDOFF_KEY = input.secrets.handoffKey;
// + env.SUBSTRATE_SKILLS_STATE = join(input.runDir, "skills");
// + if (input.skillsFixture) { env.SUBSTRATE_SKILLS_REPO = …; env.SUBSTRATE_SKILLS_REMOTE_URL = …; env.SUBSTRATE_SKILLS_GH = …; }
return env;
```
Add the input field to `BuildRehearsalEnvInput` (rehearsal-env.ts:55-66), in the same doc-commented style:
```ts
/** Instance run directory; the audit file lives directly inside it. */
runDir: string;
```

**Tests:** both analog tests are in rehearsal-env.test.ts.
- Extend the "exact key set" test (:197-220) by adding `"SUBSTRATE_SKILLS_STATE"` to `expected`. Add a twin test with `skillsFixture` that adds the three keys.
- Extend the sentinel test (:179-195) by adding parent `SUBSTRATE_SKILLS_*: SENTINEL` keys.

```ts
const expected = new Set([ "PATH", "HOME", "BUN_INSTALL", "SUBSTRATE_HOST", "SUBSTRATE_PORT", LEDGER_KEYS.url, …, "SUBSTRATE_AUDIT_PATH", "SUBSTRATE_HANDOFF_KEY" ]);
expect(new Set(Object.keys(env))).toEqual(expected);
```

---

### `packages/mcp-server/src/rehearsal-skills.ts` (fixture builder, file-I/O + subprocess)

**Analog A, module style:** P16 rehearsal-env.ts:1-30. Copy:
- the doc header ("Isolation is by construction, not by scrubbing");
- a dedicated error class whose message names paths, never values:
  ```ts
  /** The builder refused an input; the message names surfaces and hosts, never values. */
  export class RehearsalEnvError extends Error {}
  ```

**Analog B, the git spawn helper:** P16 scripts/rehearsal.ts:409-418:
```ts
function gitOutput(checkout: string, args: string[]): string | null {
	const run = Bun.spawnSync(["git", "-C", checkout, ...args], { stdout: "pipe", stderr: "pipe", timeout: DOCKER_TIMEOUT_MS });
	if (run.exitCode !== 0) return null;
	const out = run.stdout.toString().trim();
	return out.length > 0 ? out : null;
}
```

**Analog C, 0600 writes:** P16 scripts/rehearsal.ts:400-407 (`writeMode`).

**What to build:**
- The commands are in RESEARCH "Fixture builder" (verified in §5).
- `rmSync` `<runDir>/skills` and `<runDir>/skills-fixture` first (RESEARCH Pitfall 6: `runUp` reuses a stale run dir; see P16 rehearsal.ts:555-557 "the dir itself is rebuilt fresh").
- Write the `#!/bin/sh` wrapper with `FAKE_GH_STATE='…' exec '<process.execPath>' --no-env-file '<checkout>/packages/mcp-server/src/rehearsal-fake-gh.ts' "$@"`. This is the same `--no-env-file` reason as P16 `buildServerSpawnArgv` (rehearsal.ts:178-181).

**Store lock:** no `GREPTIME_` string anywhere in this file.

---

### `packages/mcp-server/src/rehearsal-fake-gh.ts` (CLI shim, JSON state)

**Partial analogs:**
- **Entry shape:** P16 scripts/rehearsal.ts:1061-1098, `main(argv): Promise<number>` with a final `if (import.meta.main) process.exit(await main(process.argv.slice(2)));`. Export the pure transitions (`ghCreate`, `ghView`, `ghListHead`, `ghClose`) for unit tests.
- **State-file locking:** copy September's dir lock (`acc30a8 propose.ts:438-464`, `acquireLock`), plus write-temp-then-rename.
- **Wire contract:** RESEARCH §6 table, three engine verbs plus `pr close`. Anything else exits 2 with `fake gh: unsupported`. PR URL `https://github.com/rehearsal/agent-skills/pull/<n>`.

**Analog for its tests** (`rehearsal-skills.test.ts`): P16 rehearsal-env.test.ts:39-48 (the `made[]` + `tempDir()` + `afterAll` cleanup idiom).

---

### `scripts/rehearsal.ts` + `scripts/rehearsal.test.ts` (P16 files, modified)

**Analog:** the same file (P16).

**Boolean flag:** the `--anonymous` precedent, at rehearsal.ts:1078 and :1088:
```ts
const anonymous = argv.includes("--anonymous");
…
return await runUp({ name, port, surfaces, operator, anonymous }, process.cwd());
```

Add `skillsFixture: boolean` in these places:
- `UpOptions` (rehearsal.ts:420-426);
- `TwinState` (358-374), so `status` can report it;
- the `usage` string (1054-1059):
  ```ts
  `usage: rehearsal up|down|status|smoke [--name <n>] [--port <N>] [--surfaces a,b] [--operator <s>] [--anonymous]\n` // + [--skills-fixture]
  ```

**Insertion point** (rehearsal.ts:672-694). Build the fixture before `buildRehearsalEnv` and pass its result in. On a builder throw, follow the existing cleanup:
```ts
} catch (cause) {
	// The scratch containers are already healthy here; a builder throw must
	// not leak them, and must exit 2 instead of a stack trace.
	removeLabelledContainers(opts.name);
	throw cause instanceof RehearsalEnvError ? new RehearsalRefused(cause.message) : cause;
}
```

**Teardown:** `runDown` (784-825) already ends in `rmSync(runDir, { recursive: true, force: true })`. No extra code.

**Tests:** scripts/rehearsal.test.ts:167-195 (`parseOperator` describe), for flag parsing.

---

### `scripts/skills-propose-smoke.ts` (live proof script)

**Analog:** P16 scripts/rehearsal.ts `runSmoke` and its helpers (862-1045).

**Reuse the exported helpers** (rehearsal.ts:868 `refuseSmokeUrl`, :884 `parseShellExports`, :964 `smokeToolResult`, :193 `runDirFor`, :41 `RehearsalRefused`):
```ts
const runDir = runDirFor(name);
const text = readText(join(runDir, "consumer.env"));
if (text === null) throw new RehearsalRefused(`no consumer.env for instance ${name}: run rehearsal up first`);
const record = parseShellExports(text);
const base = (record["SUBSTRATE_URL"] ?? "").replace(/\/+$/, "");
const tok = record["SUBSTRATE_TOKEN"] ?? "";
const refused = refuseSmokeUrl(base);
if (refused !== null) throw new RehearsalRefused(refused);
```

**Copy, do not import** (not exported): `smokeHeaders`, `parseSmokeBody` (SSE `data:` frames) and `smokeCall` (rehearsal.ts:909-961). Copy them with a longer timeout. `smokeCall` hard-codes `AbortSignal.timeout(10_000)` at :944, and a proposal needs about 180 s. The alternative is to export a timeout-parameterised `smokeCall` from rehearsal.ts.

**Check line format** (rehearsal.ts:999-1044):
```ts
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

**Planted secret:**
- Assemble it at runtime (RESEARCH "Runtime-assembled planted secret"; precedent P16 `scripts/greptime-smoke.ts:39-40`: ``const DECOY = `ghp_${"A".repeat(36)}`;``).
- Prefer the fragment join, so no whole token shape is a literal.
- Never write a `[REDACTED` literal; import `REDACTED` from `redact.ts` (greptime-smoke.ts:37 does).

**Entry:** `if (import.meta.main) process.exit(await main(process.argv.slice(2)));`, with the refusal → exit 2 mapping from rehearsal.ts:1089-1095.

**`package.json` script** (P16 package.json:18-27):
```json
"smoke:chaos": "bun scripts/chaos-smoke.ts",
"rehearsal": "bun scripts/rehearsal.ts"
// + "smoke:skills-propose": "bun scripts/skills-propose-smoke.ts"
```

---

### Route, tool and service tests (modified test files)

**Route tests with real tokens and the operator split:** analog `server.authority.test.ts:18-28,87-127`.

ENV:
```ts
const ENV = {
	SUBSTRATE_TOKEN_HERMES: "tok-hermes",
	SUBSTRATE_TOKEN_CURSOR: "tok-operator",
	SUBSTRATE_TOKEN_SWARM_A05_BE: "tok-a05",
	SUBSTRATE_TOKEN_SWARM_A09_REV: "tok-a09",
	SUBSTRATE_OPERATOR_TOKENS: "tok-operator,tok-a09",
	SUBSTRATE_HANDOFF_KEY: "a-test-signing-key",
};
```

Server boot (add `skills: fakeProposer` to the stores):
```ts
const config = loadConfig(ENV);
observability = createObservability(config, ENV);
await observability.start();
const substrate = new Substrate(config, { index: index as never, greptime: greptime as never }, observability.observer);
server = createHttpServer(substrate, config, observability);
```

`callTool(token, name, args)` (server.authority.test.ts:106-124) parses the SSE `data:` line. Reuse it for the MCP door.

**Anonymous-run route 401** (`surface === null` reached inside the route). Use the `serve(greptime, env = {})` helper in server.test.ts:80-106 with `loadConfig({})`. September's test list to port (status codes updated per D21-09): acc30a8 server.test.ts:148-230.
- "401 before the body is read, even for a 2 MB body" (L148-157);
- findings never carry the value (L181-188);
- 413 (L190-194);
- 502 ≤ 400 redacted chars (L196-…).

**503 audit denial:** http.test.ts:69-73 (`unwritablePath()`) and 300-315:
```ts
const harness = await start({ SUBSTRATE_AUDIT_PATH: unwritablePath() });
const response = await fetch(`${harness.base}/memory`, { method: "POST", body: JSON.stringify({ … }) });
expect(response.status).toBe(503);
expect(body.error).toContain("memory_write");   // → "skills_propose"
```
`start(env, stores)` (http.test.ts:32-60) already takes `Partial<{ index; greptime }>`; widen it to accept `skills`.

**MCP tool tests:** mcp.test.ts:40-56. `connect()` passes a bare `Surface | null`; for operator cases pass `{ surface, isOperator: true }`, because `createMcpServer` accepts `McpCaller` (mcp.ts:171-175):
```ts
async function connect(greptime: unknown, surface: Surface | null = "omp") {
	const substrate = new Substrate(loadConfig({}), { index: null, greptime: greptime as never });   // + skills
	const server = createMcpServer(substrate, surface);
	…
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) { … isError: result.isError === true … }
```
The listTools assertion idiom is mcp.test.ts:59-69 (`byName.get(...)?.annotations?.readOnlyHint`). Use it for `destructiveHint: false` and `openWorldHint: true`. September's tool cases are at acc30a8 mcp.test.ts:154-215.

**Service event tests:** analog graph-bind.test.ts:122-155. The ledger stub has a `fail` switch for the fail-open proof:
```ts
function ledger(options: { fail?: boolean } = {}) {
	const written: SubstrateEvent[] = [];
	return { written, greptime: {
		ensureAppendMode: async () => true,
		lastHash: async (): Promise<string | null> => null,
		insertEvent: async (event: SubstrateEvent) => { if (options.fail) throw new Error("ledger unreachable"); written.push(event); },
	} };
}
…
expect(written[0]).toMatchObject({ kind: "note", surface: "swarm-a01-orch", graph_id: GRAPH_A, actor: "agent", payload: { … } });
```

---

### Docs (`docs/skills-propose.md` new; `docs/mcp-audit.md`, `docs/rehearsal.md`, `.env.example` modified)

**`docs/skills-propose.md`.** Analog: `docs/lessons-bank.md`, which has a one-paragraph lead, then `## Commands`, `## What gets written`, … and `## Not in Tier 1`. Mirror that order:
- the doors and the body;
- statuses and codes;
- authentication and attribution;
- the operator options;
- dedupe;
- configuration and the `file://` rule;
- the state dir;
- the harness proof.

**`docs/mcp-audit.md:227`.** The fail-closed row lists tools in backticks; append `` `skills_propose` `` and the `/skills/propose` route the way the fail-open row (:226) lists routes:
```
| **fail-closed** | `graph_claim`, `graph_release`, …, `coord_handoff`, `coord_reap_leases` | Everything that grants or transfers exclusive ownership … |
```

**P16 `docs/rehearsal.md:36-60`.** The "Commands" fence plus the "Flags, as built" bullets. Add `[--skills-fixture]` to the `up` line and one bullet:
```
bun run rehearsal up [--name <n>] [--port <N>] [--surfaces a,b] [--operator <s>] [--anonymous]
- `--anonymous` — no tokens at all, for proofs that need today's anonymous production shape. …
```
The run-dir bullet list (:24-29) gains `skills/` and `skills-fixture/`.

**`.env.example:127-133`.** Add a section block in the same style: a `# ── Title ──` rule, a prose comment, then the keys. Leave the defaults commented, because production needs none:
```
# ── MCP audit (SPE-4793) ──────────────────────────────────────────────────────
# The hash-chained record of what agents asked substrate-mcp to do …
# See docs/mcp-audit.md.
SUBSTRATE_AUDIT_PATH=/var/lib/substrate/mcp-audit.jsonl
```

---

## Shared Patterns

### Authentication and caller identity
**Source:** main `server.ts:216-257`, `config.ts:221-246`.
**Apply to:** the route, the tool and the service method.
```ts
const surface: Surface | null = surfaceForToken(config, authorization);
const caller: McpCaller = { surface, isOperator: isOperator(config, authorization) };
…
if (!config.allowAnonymous && surface === null) { sendJson(res, 401, { error: "unknown or missing bearer token" }); return; }
```
- `isOperator` is true on a bare anonymous run (config.ts:242). D21-02 therefore needs the route and tool's own `surface === null` refusal **before** any operator check.
- A swarm token is never an operator (config.ts:245).

### Fail-closed audit before work
**Source:** main `server.ts:160-214` (`auditRest`/`auditedRest`) and `handleMcp` (507-538), where MCP is gated before dispatch automatically.
**Apply to:** the route only. The MCP door is already covered by the `handleMcp` gate once `skills_propose` is in `FAIL_CLOSED_TOOLS`.
```ts
if (!(await auditedRest(res, observability, surface, "skills_propose", body))) return;   // one line, these names (Phase 17 scan regex)
```

### Errors as typed classes mapped per door
**Source:**
- `acc30a8 propose.ts:115-131` (`ProposeRefused`/`ProposeFailed`);
- main `server.ts:481-491` (catch ladder → 400/500);
- main `mcp.ts:153-155` (`refusal`) and 510-520 (`InvalidBindError` → `refusal`).

**Apply to:** route (400/413/502), tool (`isError`), CLI (exit 1).

### Fail-open events with `payload.action`
**Source:** main `service.ts:817-834` (bindGraph), 720-748 (decision-not-body warning) and 1050-1065 (action payload). Every emit ends `.catch(() => undefined)`.
**Apply to:** `Substrate.proposeSkill` only (D21-17). The CLI never emits.

### Never print or store a value
**Source:**
- `config.ts:298` ("Named by surface, never by token: the warning goes to a log");
- `acc30a8 propose.ts:413-415` (`tail()` = `redact(...).slice(-400)`);
- `acc30a8 server.ts:201-203` (`redact(cause.message).slice(0, 400)`);
- P16 rehearsal-env.ts:30 ("the message names surfaces and hosts, never values").

**Apply to:** config warnings, `ProposeFailed`, fixture builder errors, smoke output.

### Store-lock and token-literal hygiene in new tracked files
**Source:** P16 `store-lock.test.ts:39-41` (`mayReachLedger`), :72 and :95 (`TOKEN_LITERAL`); P16 rehearsal-env.ts:197-199:
```ts
// Short local, never a long name: a 16+ character identifier after the
// client token key would trip the store lock's token scan.
const token = input.firstToken;
```
**Apply to:** `scripts/skills-propose-smoke.ts`, `rehearsal-skills.ts`, `skills.ts` and every test.
- No `GREPTIME_` in `scripts/`.
- No `SUBSTRATE_TOKEN…: <16+ chars>`.
- Test tokens stay short (`tok-hermes`), or `randomBytes` at runtime (P16 rehearsal-env.test.ts:50-61).

### Test temp-dir lifecycle
**Source:** main git.test.ts:16-35; P16 rehearsal-env.test.ts:39-48 (`made[]` plus `afterAll` rmSync); acc30a8 propose.test.ts:50-56 (per-test `beforeEach`/`afterEach`).
**Apply to:** every new test that touches the filesystem.

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `packages/mcp-server/src/event-sources.ts` (row `skills.propose.failed`) | registry | — | Phase 17 file: no code in any worktree, only `17-01-PLAN.md`/`17-PATTERNS.md:170`. Re-read the execution base before editing. |
| `docs/event-vocabulary.md` (status note + row) | docs | — | Phase 17 file, not yet written. The marker-table format is defined in the P17 plan. |
| `rehearsal-fake-gh.ts` state machine | CLI shim | file-I/O | No fake external CLI exists in the repo. Use RESEARCH §6 for the contract; only its entry shape and lock have analogs (above). |

Also missing on main: the redactor exports `redactSkillContent` and `scanSkillFiles`, and `redact-lock.test.ts`. They are Phase 18 deliverables; the September signatures are at `acc30a8:packages/mcp-server/src/redact.ts:114-286`. Execution must start from a base that holds Phases 16, 17 and 18 (CONTEXT).

## Metadata

**Analog search scope:**
- main: `packages/mcp-server/src/{server,mcp,service,config,observe,index,redact,git.test,server.test,server.authority.test,mcp.test,http.test,graph-bind.test,authority.test,observe.test}.ts`, `packages/audit/src/policy{,.test}.ts`, `packages/cli/src/{index,args,lessons,lessons.test}.ts`, `docs/{mcp-audit,lessons-bank}.md`, `.env.example`;
- `acc30a8`: `skills/{propose,frontmatter,propose.test}.ts`, `service.ts`, `mcp.ts`, `server.ts`, `server.test.ts`, `mcp.test.ts`, `cli/src/index.ts`;
- P16: `scripts/rehearsal{,.test}.ts`, `scripts/greptime-smoke.ts`, `packages/mcp-server/src/rehearsal-env{,.test}.ts`, `store-lock.test.ts`, `docs/rehearsal.md`, `package.json`;
- P17 and P18: plans only.

**Files scanned:** about 40.
**Pattern extraction date:** 2026-10-08.
