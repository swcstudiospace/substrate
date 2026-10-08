# Phase 21: skills_propose - Research

**Researched:** 2026-10-08
**Domain:** Port of September's skill-proposal git/gh engine (`acc30a8`) onto main's v1.2 surface-token server; MCP tool + REST route + CLI over one service method; Phase 16 harness extension with a throwaway git repository and a fake `gh`
**Confidence:** HIGH (every port point read on `acc30a8` and on main this session; git mechanics probed with real git 2.43; Phase 16/17/18 contracts read from their committed plans, which are still under revision; see Open Questions)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Authentication and attribution
- **D21-01: Only a surface token authenticates a proposal.**
  - September's `x-substrate-propose-key` header and `propose-auth.ts` are dropped. Phase 21 has no reviewed reason to keep them. The key existed for host processes that had no bearer token. On main every caller has a surface token: Phase 20 provisions them, and the Phase 22 bridge reads a surface token file, the v1.2 workspace-install pattern.
  - The key file `/var/lib/substrate/skills/propose.key` on the host is left as it is and becomes unused. Deleting it belongs to Phase 22's cutover.
- **D21-02: Anonymous calls are always refused.**
  - This holds even on a run with no tokens (`allowAnonymous`), because a proposal spends the owner's GitHub credential.
  - The refusals by door:
    - Route: 401 `{error}`, before the body is read.
    - MCP: an `isError` refusal ("skills_propose needs an authenticated surface; nothing was proposed").
    - CLI: exit 1 with a message on stderr.
  - Nothing reaches git or `gh`.
  - Production stays anonymous until Phase 20, so it refuses every proposal until then. That is the intended order.
- **D21-03: The proposal's surface is the token's surface, for every caller.**
  - The token's surface names the branch (`skill/<surface>/…`), the PR title and the event.
  - A body or argument `surface` that equals the token's surface is accepted, and so is an absent one.
  - A different surface is refused: 403 on the route, an MCP refusal on the tool. It is not re-attributed.
  - This is stricter than `attributedSurface` (swarm-only), on purpose. Phase 17 fixed this tool's event surface as "the authenticated caller's surface (never body-supplied)".
- **D21-04: Any authenticated surface may propose.**
  - That includes swarm surfaces and the `substrate` host-job surface.
  - No per-surface allowlist. The owner's merge is the gate.
- **D21-05: Privileged options require an operator token.**
  - The options: `mode: "replace"`, `reopen: true` and `allow_doc_examples` (`pem`/`jwt`).
  - In September these were CLI-only, in-process. Main's privileged authority is `isOperator`, so a non-operator token naming any of them gets 403 or an MCP refusal.
  - The defaults stay `overlay`, no reopen and no doc-example allowance.

#### Entry points and wire contract
- **D21-06: One service method.**
  - Signature: `Substrate.proposeSkill(input, caller: { surface: Surface; isOperator: boolean })`.
  - It validates options against the caller, then calls the injected `SkillProposer` and records the event (D21-17).
  - The `SkillProposer` seam (`createSkillProposer({ run })`) is injected through the constructor's existing `stores` parameter, so tests and the harness never reach `execFileRunner` by accident.
- **D21-07: The CLI is an HTTP client.**
  - `substrate skills propose --dir <path>` reads the directory with September's `readSkillDir` rules: a symlink, a special file or non-UTF-8 content refuses the whole directory, naming the path.
  - It then posts to `POST /skills/propose` with `SUBSTRATE_TOKEN`.
  - It keeps no in-process git path. In-process would be a second door that skips the token, the audit and the event.
  - Flags:
    - `--name` (default: the directory's basename), `--rationale`, `--remove a,b`, `--session`, `--graph`, `--dry-run`;
    - operator-only: `--replace`, `--reopen`, `--allow-doc-examples pem,jwt`.
  - There is no `--surface` flag (D21-03).
  - Its request timeout is separate from the 1.5 s hook default, because a proposal runs `git fetch`, `git push` and `gh`. The default is about 180 s, overridable.
- **D21-08: One byte cap everywhere: 1 MB.**
  - The route's `MAX_BODY_BYTES`, September's `ROUTE_MAX_BYTES` and the CLI's pre-flight are the same cap.
  - The CLI refuses a directory over the cap before it posts.
  - September's in-process 64 MB `CLI_MAX_BYTES` is dropped. Larger skill exports are deferred.
  - An oversize body gets 413 on this route, not the generic 500 `readBody` produces today. Whether other routes also move to a typed `BodyTooLargeError` is left to Claude (see "Claude's Discretion").
- **D21-09: Route status codes.**
  - 200 with the `ProposeResult` for `opened`, `existing`, `unchanged`, `declined` and `dry_run`.
  - 400 for a malformed body or a `ProposeRefused`. The response carries `{error, findings?}`, and each finding is `{file, line, rule}`, never a value.
  - 401 anonymous; 403 surface mismatch or operator-only option; 413 oversize.
  - 502 `ProposeFailed`: a git or `gh` step failed or a lock stayed busy. The message carries at most 400 characters of output, redacted.
  - 503 when the fail-closed audit refuses (`auditedRest`).
  - The MCP tool returns the same result as JSON, and an `isError` refusal for every non-200 case.
- **D21-10: CLI output and exit codes.**
  - It prints September's `key=value` lines: `status`, `pr_url`, `pr_number`, `branch`, `content_sha256`, `redactions`, the diff counts, and one `finding=<file>:<line> <rule>` per finding.
  - It exits 0 for the five success statuses.
  - It exits 1 on refusal, failure, 401/403/413/5xx or an unreachable server.
  - It is not a hook command, so a non-zero exit is safe, as with `verify` and `drift`.
  - The CLI never posts its own event; the server records it (D21-17).
- **D21-11: `dry_run` is available on all three doors.**
  - It validates, redacts, clones and counts the staged diff.
  - It does not push, call `gh`, write the ledger or emit an event.
  - It is still audited as `skills_propose`.

#### The git and `gh` path (port fidelity)
- **D21-12: Port the September engine as it is, with these changes.**
  - What stays: `validateProposal`, `writeTree`/`confined`, the argv builders, `originMatches`, `prUrlOf`, `prTitle`/`prBody`, the directory locks with stale-PID recovery, the JSONL ledger and `fromLedger`, and `proposeSkill`'s order (validate → content lock → ledger → mirror lock and fetch → shared clone → set-url → checkout → write → add → diff → commit → origin check → push → ledger `pushed` → `gh pr create` → ledger `opened`, clone removed in `finally`).
  - What changes:
    - imports come from Phase 18's `redact.ts`;
    - the library is configurable (D21-13);
    - the child environment is an allowlist (D21-15);
    - the commit message drops September's `Refs SPE-2734` line and keeps the `skill-content-sha256:` trailer.
  - No argv carries a force flag, a colon refspec or a search query, and the tests pin that (criterion 1).
- **D21-13: The library is configurable; production defaults are September's.**
  - `config.ts` gains a `skills` block read from:
    - `SUBSTRATE_SKILLS_REPO` (default `swcstudiospace/agent-skills`);
    - `SUBSTRATE_SKILLS_REMOTE_URL` (default `https://github.com/swcstudiospace/agent-skills.git`);
    - `SUBSTRATE_SKILLS_STATE` (default `/var/lib/substrate/skills`);
    - `SUBSTRATE_SKILLS_GH` (default `gh`).
  - A non-default repository or remote is accepted only when the remote is a local `file://` path. Configuration therefore cannot point the owner's GitHub credential at another GitHub repository. Any other combination is a startup configuration error.
  - The origin check, the PR-URL check and the event's `repo` all use the configured slug.
- **D21-14: State and ledger compatibility.** The default state dir and the ledger format (`proposals.jsonl` lines `{ts, content_sha256, name, surface, branch, state, pr_url?, pr_number?}`) stay September's, so the host's existing ledger keeps deduplicating content proposed in September.
  - A missing `mirror.git` is a `ProposeFailed` that names the missing mirror and the 04-02 bootstrap command. The server does not create it.
- **D21-15: The child environment for `git` and `gh` is an allowlist, not `process.env`.**
  - The allowlist: `PATH`, `HOME`, `GIT_TERMINAL_PROMPT=0` and `GH_PROMPT_DISABLED=1`.
  - `HOME` is the configured or inherited home, `/root` when unset, so `gh`'s stored credential answers under systemd.
  - Store URLs, surface tokens and the handoff key never reach a child process.
  - `execFile` with an argv, never a shell, and a 120 s timeout.
- **D21-16: Dedupe semantics (criterion 2) are September's.**
  - Identical content, by `content_sha256` over mode, the redacted files and the removals:
    - is `existing` while its PR is open;
    - is `declined` once the owner closed it (unless an operator `reopen`);
    - is re-found with `gh pr list --head` when it was pushed without a recorded PR.
  - Content equal to the library's `main` is `unchanged`, and no branch is pushed.
  - Two concurrent identical proposals produce one `gh pr create`; the per-content lock enforces it.

#### Events, audit and registration
- **D21-17: Events follow Phase 17's `EVENT_SOURCES` rows, emitted fail-open.**
  - An outcome is a `note`:
    - surface: the caller's;
    - `repo`: the configured slug;
    - payload: `action: "skill.propose"`, `name`, `status`, `pr_url`, `content_sha256`, `redactions` (a count).
  - A `ProposeRefused` is a `warning`:
    - payload: `action: "skill.propose"`, `status: "refused"`, `name` if valid, the `reason`, and `rules` (rule names only, never a value or a span).
  - A `ProposeFailed` is a `warning` with `status: "failed"` and the redacted reason.
    - This adds one status value to Phase 17's documented row. `docs/event-vocabulary.md` and `EVENT_SOURCES` are updated in the same PR, as Phase 17 requires for any change to the table.
  - These emit no event:
    - `dry_run`;
    - anonymous calls (no surface to attribute);
    - 403 attribution refusals. The audit chain records those.
  - An event that fails to store never changes the proposal's answer.
  - A unit test asserts the emitted kind and action equal the `EVENT_SOURCES` row.
- **D21-18: Registration (criterion 3).**
  - `mcp.ts` registers `skills_propose` with zod input:
    - fields: `name`, `files` record, `rationale`, `remove?`, `surface?`, `session_id?`, `graph_id?`, `dry_run?`, `mode?`, `reopen?`, `allow_doc_examples?`;
    - annotations: `destructiveHint: false`, `openWorldHint: true`.
  - `observe.ts`: `KNOWN_TOOLS` gains `skills_propose`, and `KNOWN_ROUTES` gains `/skills/propose`.
  - `server.ts`: the route runs `auditedRest(…, "skills_propose", body)`, the fail-closed mode, before any git work.
  - `policy.ts`: if Phase 17's `FAIL_CLOSED_TOOLS` entry is not on the base, this phase adds it under the same comment. A test asserts `auditMode("skills_propose") === "fail-closed"` *and* that it is explicitly listed.
  - Tests assert all four registrations, so dropping one fails the build.
- **D21-19: Docs.**
  - New `docs/skills-propose.md`:
    - the contract: the three doors, the body, statuses and codes;
    - authentication and attribution;
    - the operator-only options;
    - dedupe;
    - the configuration keys and the `file://` rule;
    - the state dir;
    - the harness proof.
  - Pointers or entries in `docs/mcp-audit.md` (the tool's row marked as landed), `docs/event-vocabulary.md` (the `failed` status) and `docs/rehearsal.md` (the skills fixture flag).
  - The header comments of `server.ts` and the CLI `index.ts` list the new route and command.

#### Proof
- **D21-20: Unit tests.**
  - The ported `propose.test.ts` (fake `Runner`; real git for `writeTree` and overlay) and frontmatter tests.
  - New route tests in `server.test.ts` style: 401, 403 mismatch, 403 operator option, 400 findings, 413, 502, 503 audit denial, 200 per status.
  - MCP tool tests in `mcp.test.ts` style.
  - CLI tests: `readSkillDir` refusals, the cap, flag mapping and exit codes, against a stub server.
  - Registration and event-row tests.
  - Everything injects a `SkillProposer` or a `Runner`; no test calls real `gh`.
- **D21-21: The harness gains a skills fixture.**
  - `bun run rehearsal up --skills-fixture` extends Phase 16's harness. Every instance sets `SUBSTRATE_SKILLS_STATE=<runDir>/skills`, so a rehearsal can never touch `/var/lib/substrate/skills`.
  - With the flag, the harness also builds, inside the run directory:
    - a throwaway bare repository `<runDir>/skills-fixture/rehearsal/agent-skills.git`, seeded with a `main` that holds one skill, with `receive.denyNonFastForwards=true` and `receive.denyDeletes=true`;
    - `mirror.git`, a bare clone of it whose fetch refspec covers only `main`;
    - an injected `gh`: a small recording script that answers `pr create`, `pr view` and `pr list --head` from a JSON state file. Its PR URLs are `https://github.com/rehearsal/agent-skills/pull/<n>`.
  - It points `SUBSTRATE_SKILLS_REPO`, `_REMOTE_URL` (`file://…`) and `_GH` at them.
  - `git` runs for real. `rehearsal down` removes everything.
  - The fixture builder lives in `rehearsal-env.ts` or beside it, and names no `GREPTIME_` key (store lock).
- **D21-22: The smoke, `bun run smoke:skills-propose` (`scripts/skills-propose-smoke.ts`).**
  - It sources only `consumer.env` and keeps Phase 16's guards: it refuses port 7410 and any non-loopback host.
  - Assertions:
    - (a) A valid skill through MCP, the route and the CLI each answers `opened`, with branch `skill/<surface>/<name>-<UTC ms ts>-<4 hex>` present in the throwaway repository and one recorded `gh pr create` each.
    - (b) Resubmitting identical content answers `existing`. After the fake `gh` marks that PR closed, it answers `declined`. Content equal to `main` answers `unchanged`, and none of the three pushes a branch or opens a second PR.
    - (c) Each of these is refused with no new branch and no `gh` call: a bad name, a `..` path, missing or mismatched frontmatter, and a planted runtime-assembled secret. The secret refusal carries a finding that names file, line and rule, and the value appears nowhere in the response, the ledger, the events or the audit file.
    - (d) No token gives 401, and the MCP call is refused. A body surface naming another surface gives 403.
    - (e) The bare repository's reflog shows no non-fast-forward update.
    - (f) `POST /events/query` returns the `note`/`warning` rows with `action: "skill.propose"`, and the audit file holds `skills_propose` records.
  - Proof run:
    1. `rehearsal up --name p21 --skills-fixture`;
    2. the smoke;
    3. `bun test`;
    4. `bunx tsc --noEmit`;
    5. `bun run check:phase-close`;
    6. `rehearsal down --name p21`.
  - Isolated; no operator approval needed.
- **D21-23: Baseline discipline.** Results are compared with the base's `bun test` and `tsc` results. Failures already present at HEAD are recorded, not fixed.

### Claude's Discretion
- File split under `packages/mcp-server/src/skills/` (for example `propose.ts`, `frontmatter.ts`, `config` helpers) and whether the route body check is a function in `server.ts` or in `skills/`.
- Exact names of the zod fields for operator options (`allow_doc_examples` versus `allowDocExamples`); the route and tool use the same names.
- Whether the typed `BodyTooLargeError` → 413 applies to every route or only to `/skills/propose` (all routes is acceptable as a bug fix if tests for other routes keep passing).
- The fake `gh`'s implementation language and state-file shape, and how the smoke flips a PR to closed.
- The CLI's default timeout value and its override variable name.
- Plan split, for example: (1) engine port and config; (2) service, route, tool, registrations and events; (3) CLI; (4) harness fixture, smoke and docs.

### Deferred Ideas (OUT OF SCOPE)
- Skill exports over 1 MB, which September's in-process CLI allowed up to 64 MB. They would need a chunked or file-reference upload; no v1.3 requirement asks for it.
- Removing `/var/lib/substrate/skills/propose.key` and any host client still sending `x-substrate-propose-key`: this is Phase 22's cutover of the bridge onto surface tokens.
- A per-surface allowlist or rate limit for proposals, if the owner's review queue gets noisy.
- Mirror bootstrap as a command (`substrate skills init`): the host mirror exists today; a fresh host would follow September's 04-02 bootstrap by hand.

### Open for the operator (from CONTEXT, applied unless overridden)
1. The propose key is dropped (D21-01).
2. The CLI goes over HTTP with `SUBSTRATE_TOKEN`, with a 1 MB cap (D21-07, D21-08).
3. `--replace`, `--reopen` and `--allow-doc-examples` need an operator token (D21-05).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SKILL-01 | `skills_propose` (MCP tool, `POST /skills/propose`, `substrate skills propose`) validates name, paths and frontmatter; redacts and secret-scans, refusing on a finding; dedupes by content hash (`existing` / `declined` / `unchanged`); and opens branch `skill/<surface>/<name>-<ts>-<hex>` with a PR on `swcstudiospace/agent-skills` through `gh`, checking the origin and never force-pushing. Callers authenticate with their surface token; the tool is registered in `mcp.ts`, `observe.ts` and the audit policy. [VERIFIED: .planning/REQUIREMENTS.md:41] | Port map (engine §1, service/route/tool/CLI §1b), Phase 17 row contract (§2), Phase 18 import contract (§3), harness extension (§4), verified git mechanics (§5), fake `gh` wire contract (§6), Validation Architecture test map |
</phase_requirements>

## Project Constraints (from AGENTS.md and `.cursor/rules/desk.mdc`)

No `CLAUDE.md` exists in the worktree (`find` returned none); `AGENTS.md` carries the desk rules [VERIFIED: AGENTS.md:1-15]:
- **Draft PR only.** No merge, no auto-merge, no force-push, no branch deletion. (The v1.3 run rules in STATE.md let `ultrathink-ship` auto-merge after Greptile; the executor never merges by hand.)
- **No secrets.** Never print, commit or echo tokens or keys; reference env vars by name only; no tailnet names or internal hostnames in the repo, PR or transcript.
- **Greptile gate via Desk Quality.** A failed, skipped or unavailable review is a blocker, never a pass.
- `.substrate/BRIEF.md` is substrate-written; never edit it.

Repo-enforced constraints that bind every file this phase adds (they run in plain `bun test`):
- `store-lock.test.ts`: no `.ts` outside `packages/mcp-server/` (and the one smoke allowlisted) may contain the string `GREPTIME_`; no tracked file may assign a `SUBSTRATE_TOKEN*` key a 16+ character value, comments included [VERIFIED: packages/mcp-server/src/store-lock.test.ts:72,95,124-130; the allowlist `mayReachLedger` at :39-41 in the Phase 16 worktree].
- Phase 18 `redact-lock.test.ts` (on the base before execution): four rules over non-test sources under `packages/`, `scripts/`, `infra/` (§3).
- `tsconfig.json` is `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` (type imports must be `import type`/`type`), and includes `scripts/**/*.ts` [VERIFIED: tsconfig.json in the Phase 16 worktree, lines 2-16].

## Summary

Phase 21 is a port with three seams changed: authentication moves from September's propose key to main's surface tokens; the git/gh engine becomes library-configurable (repo slug, remote URL, state dir, gh binary) so it can run against a throwaway repository; and events move from September's rejected `skill.propose` kind onto Phase 17's `note`/`warning` rows with `payload.action: "skill.propose"`. The engine itself (`acc30a8:packages/mcp-server/src/skills/propose.ts`, 640 lines) is self-contained: pure argv builders, an injected `Runner`, directory locks, a JSONL ledger. Its only imports that change are the Phase 18 redactor exports, which Phase 18 ports verbatim, so the import line survives unchanged.

The integration points on main are small and well-shaped. `server.ts` resolves `caller = { surface, isOperator }` before the body (server.ts:224) and 401s only when tokens are configured (254-257), so the route itself must refuse `surface === null` before `readBody`. `readBody` throws a generic `Error` that falls to the 500 branch (117-126, 490-491); a typed `BodyTooLargeError` plus one catch branch gives 413 for every route with no existing test depending on 500. `auditedRest` (203-214) must be called with the literal argument shape `auditedRest(res, observability, surface, "skills_propose", body)` because Phase 17's policy scan guard extracts names with exactly that regex. The `Substrate` constructor's `stores` seam (service.ts:464-475) takes a `skills?: SkillProposer`, exactly as September did.

Every git behaviour the fixture depends on was probed with git 2.43.0 in `/tmp`: a bare clone **without** an explicit fetch refspec does not advance `refs/heads/main` on `git fetch origin main` (the mirror must set `+refs/heads/main:refs/heads/main`, as production's does); `clone --shared --no-checkout` of the mirror yields `refs/remotes/origin/main` for `checkout -b … origin/main`; push to a `file://` remote from a shared clone works; `receive.denyNonFastForwards` rejects a forced update and `receive.denyDeletes` rejects a delete; with `core.logAllRefUpdates=always` the bare repo records one reflog line per pushed ref with a zero old-sha for a new branch.

**Primary recommendation:** Port `propose.ts`/`frontmatter.ts`/`propose.test.ts` first with a `SkillsLibrary` config object threaded through the argv builders and a `createExecFileRunner({ gh, home })` that maps `argv[0] === "gh"` to the configured binary, so the September argv-pinning tests keep `"gh"` and `"git"` literal. Add one Docker-free engine test that runs `proposeSkill` against real git and a temp bare repo built by the same fixture builder the harness uses; that catches mirror/refspec/origin mismatches in plain `bun test` before the harness smoke.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Authentication, surface attribution, operator gate | API (`server.ts` caller; `Substrate.proposeSkill` option check) | MCP (`mcp.ts` refusals) | The token is decided before the body (server.ts:218-224); D21-06 puts the option check in the one service method |
| Body shape (route) / input schema (tool) | API (`server.ts` or `skills/` helper) | MCP zod schema | Each door validates its own wire shape; content rules live once in the engine |
| Content validation, redaction, secret scan, hash | Engine (`skills/propose.ts` `validateProposal`) | `redact.ts` (`scanSkillFiles`) | Before any git/gh call; Phase 18 owns the rules |
| Git/gh orchestration, locks, ledger | Engine (`proposeSkill`, injected `Runner`) | Host FS (`SUBSTRATE_SKILLS_STATE`) | Single git path for all three doors |
| Audit | Observability (`auditedRest` / `handleMcp` gate) | `packages/audit` policy | Fail-closed, before dispatch |
| Events | Service (`Substrate.emit`, fail-open) | Ledger (Greptime via service only) | Phase 17 rows; store lock forbids other paths |
| Directory reading, pre-flight cap, output | CLI (`packages/cli/src/skills.ts`) | — | HTTP client only (D21-07) |
| Throwaway repo, mirror, fake gh | Harness (`rehearsal-skills.ts` beside `rehearsal-env.ts`, `scripts/rehearsal.ts`) | — | Run-dir scoped; removed by `down` |

## Standard Stack

### Core (all already present; nothing to install)
| Component | Version | Purpose | Why Standard |
|-----------|---------|---------|--------------|
| Bun | 1.4.0 runtime, `bun-types` 1.4.2 | runtime, `bun test`, `Bun.YAML`, `Bun.spawn` | repo engine `"bun": ">=1.4.0"` [VERIFIED: `bun --version` → 1.4.0; package.json engines; node_modules/.bun/bun-types@1.4.2] |
| `Bun.YAML.parse` | built in | SKILL.md frontmatter | [VERIFIED: probe — `typeof Bun.YAML.parse === "function"`; `"name: a\ndescription: b"` → object; `"name: [unclosed…"` throws `SyntaxError`; `""` → `null`; `"- a"` → array; typed at bun-types bun.d.ts:1477-1486] |
| git | 2.43.0 at `/usr/bin/git` | real git in engine and fixture | [VERIFIED: `git --version`, `command -v git`] |
| gh | 2.45.0 at `/usr/bin/gh` | production PR creation (never called in tests or harness) | [VERIFIED: `gh --version`, `command -v gh`] |
| zod | 4.6.5 | MCP input schema | [VERIFIED: node_modules/.bun/zod@4.6.5; mcp.ts:729 already uses `z.record(z.string(), z.unknown())`] |
| @modelcontextprotocol/sdk | 1.30.1 | `McpServer.registerTool`, in-memory test transport | [VERIFIED: bun.lock:69; mcp.test.ts:10-11] |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `Bun.YAML` | `yaml` npm package | New dependency for no gain; September chose built-in [CITED: acc30a8 frontmatter.ts:1-5] |
| Fake `gh` in Bun TS | POSIX `sh` + `jq` | `jq` JSON state edits are fragile; Bun is already required by the harness |

**Installation:** none. The worktree already has `node_modules` (isolated linker, `node_modules/.bun/…`) [VERIFIED: listing].

## Package Legitimacy Audit

No external package is installed by this phase. **Packages removed due to [SLOP] verdict:** none. **Packages flagged as suspicious [SUS]:** none.

## 1. Port map: `acc30a8` → main

### 1a. Engine (`packages/mcp-server/src/skills/propose.ts`, `frontmatter.ts`)

| September (`acc30a8:…/skills/propose.ts`) | Main / Phase 21 change |
|---|---|
| L26 `import { redact, redactSkillContent, type SkillDocExampleRule, type SkillFileHit, scanSkillFiles } from "../redact.ts";` | Unchanged once Phase 18 lands: 18-02 ports `SkillDocExampleRule`, `SkillFileHit`, `redactSkillContent`, `scanSkillFiles` verbatim into `redact.ts` [CITED: p18 18-02-PLAN.md:23,64; 18-PATTERNS.md:109-112]. Resolves to `packages/mcp-server/src/redact.ts`, which satisfies redact-lock rule 1. |
| L27 `import { SURFACES, type Surface } from "../types.ts";` | Unchanged; after Phase 17 `SURFACES` has 27 entries including `substrate` [CITED: p17 17-01-PLAN.md:68]. |
| L30-31 `LIBRARY_REPO = "swcstudiospace/agent-skills"`, `LIBRARY_URL = "https://github.com/swcstudiospace/agent-skills.git"` | Keep as exported **defaults**; builders take a `SkillsLibrary { repo, remoteUrl }`. Used by `setUrlArgv` (L276), `prListHeadArgv` (L314), `prCreateArgv` (L318), `prUrlOf` (L333-339), `proposeSkill` origin check (L622) and `openPr` message (L517). |
| L32-37 state constants (`SKILLS_STATE`, `MIRROR`, `PROPOSE_ROOT`, `LOCK_DIR`, `CONTENT_LOCKS`, `LEDGER`) | `pathsFor` (L504-512) already derives everything from `opts.stateDir`; make `stateDir` come from `config.skills.stateDir`. Keep `fetchArgv(mirror)`/`cloneArgv(dir, mirror)` parameters (L268-274). |
| L40 `ROUTE_MAX_BYTES = 1_000_000`; L42 `CLI_MAX_BYTES = 64_000_000` | Keep `ROUTE_MAX_BYTES`; delete `CLI_MAX_BYTES` (D21-08). |
| L58-66 `ProposeInput` (`name, files, remove?, rationale, surface, session_id?, graph_id?`) | Unchanged; `surface` is filled by the service from the token, never from the body. |
| L68-84 `ProposeOptions` (`maxBytes, allowDocExamples?, mode, dryRun?, reopen?, ledgerPath?, stateDir?, lockWaitMs?, run`) | Add `library: SkillsLibrary` (or bind it in `createSkillProposer`); keep the test seams. |
| L86 `ProposeStatus = "opened" \| "existing" \| "unchanged" \| "declined" \| "dry_run"` | Unchanged — these are the five 200 statuses (D21-09). |
| L116-131 `ProposeRefused` (with `findings?: SkillFileHit[]`), `ProposeFailed` | Unchanged. |
| L136-148 `pathProblem` | Unchanged (optionally also refuse a `__proto__` segment; see Pitfall 12). |
| L161-219 `validateProposal` incl. the hash construction (`<mode>\0`, sorted `path\0content\0`, `remove\0path\0`) | Unchanged byte-for-byte — ledger compatibility (D21-14) depends on it. |
| L225-258 `confined`, `writeTree` | Unchanged. |
| L264-321 argv builders | Same argv; library-aware signatures for `setUrlArgv(dir, remoteUrl)`, `prListHeadArgv(branch, repo)`, `prCreateArgv(branch, title, body, repo)`. `argv[0]` stays the literal `"gh"`. |
| L323-328 `originMatches(url, slug)` | Unchanged; call with the configured slug. |
| L330-339 `PR_URL_RE`, `prUrlOf(stdout)` compares `match[1]?.toLowerCase() === LIBRARY_REPO` | Compare against `library.repo.toLowerCase()`. |
| L381-383 `commitMessage` ends `\nRefs SPE-2734` | Drop that line; keep `skill-content-sha256:` trailer (D21-12). Update the pin in propose.test.ts (`commit.at(-1)`). |
| L394-411 `execFileRunner` with `env: { ...process.env, HOME: "/root", GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" }` (L403) | Replace with `createExecFileRunner({ gh, home })`: env is exactly `{ PATH, HOME, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" }` (D21-15), `HOME = process.env.HOME || "/root"`, `argv[0] === "gh"` → configured binary, `timeout: 120_000`, `maxBuffer: 4 MiB`. |
| L413-415 `tail()` uses event-pass `redact` and keeps the last 400 chars | Unchanged. |
| L438-464 `acquireLock` (dir + `pid` file, stale-PID reclaim, `LOCK_WAIT_MS = 20_000`, poll 50 ms) | Unchanged. |
| L466-500 ledger (`ledgerLookup`, `ledgerAppend` 0600) | Unchanged (format is D21-14's). |
| L528-566 `fromLedger` | Unchanged; uses `prViewArgv`, `prListHeadArgv(…, repo)`. |
| L584-635 `proposeSkill` order | Unchanged order of git/gh steps; add a mirror-existence check (`existsSync(join(mirror, "HEAD"))`) that throws `ProposeFailed` naming the mirror and the bootstrap (D21-14). Recommended placement: right after `validateProposal`, before the content lock (it is not a git/gh step, so D21-12's step order is intact, and no `gh pr view` can run against a host with no mirror). |
| L638-640 `createSkillProposer({ run })` | `createSkillProposer({ run, library, stateDir })`; per-call options carry only request options. |
| `frontmatter.ts` (20 lines, `FENCE_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/`, `Bun.YAML.parse`, null on non-mapping) | Port verbatim. |

Bootstrap text for the missing-mirror message, verbatim from September [VERIFIED: `git show acc30a8:.planning/phases/04-skills/04-02-SMOKE.md` lines 36-38]:
```
env -i HOME=/root PATH=/usr/bin:/bin git clone --bare https://github.com/swcstudiospace/agent-skills.git /var/lib/substrate/skills/mirror.git
git -C /var/lib/substrate/skills/mirror.git config remote.origin.fetch +refs/heads/main:refs/heads/main
env -i HOME=/root PATH=/usr/bin:/bin git -C /var/lib/substrate/skills/mirror.git fetch origin
```
Render it with the configured remote URL and mirror path.

### 1b. Service, route, tool, CLI

| September | Main (line refs on this worktree) | Phase 21 |
|---|---|---|
| `acc30a8 service.ts:89,100,111` — `readonly skills: SkillProposer`; `stores?.skills ?? createSkillProposer({ run: execFileRunner })` | `service.ts:464-475` constructor `stores?: { index?; greptime? }` | Add `skills?: SkillProposer` to `stores`; default builds the exec runner from `config.skills` (inert until called; existing tests that pass `{ index, greptime }` are unaffected). |
| `acc30a8 service.ts:171-190` `proposeSkill(input)` → `this.skills.propose(input, { maxBytes: ROUTE_MAX_BYTES, mode: "overlay" })`, then `emit({ kind: "skill.propose", … })` | `service.ts:547-562` `emit(input): Promise<EmitResult>` (fail-open, returns `stored`); `append` can still throw (`normalizeEvent` at :573) so call sites use `.catch(() => undefined)` (precedent `bindGraph`, :824-834) | `proposeSkill(input, caller)`: option/surface check → `skills.propose` → `note`; catch `ProposeRefused` → `warning` + rethrow; catch `ProposeFailed` → `warning` + rethrow; never on dry_run. |
| `acc30a8 server.ts:32-50` `BodyTooLargeError`, `readBody` throws it; `:193-196` → 413 | `server.ts:46` `MAX_BODY_BYTES = 1_000_000`; `:117-126` `readBody` throws `new Error("request body too large")` (:122) → generic 500 at `:490-491` | Port `BodyTooLargeError` and the 413 catch branch (all routes; no existing test asserts the 500 — `grep "too large\|413"` finds only server.ts:122). |
| `acc30a8 server.ts:64-80` `proposeBodyProblem(body)` | — | Port and extend for `dry_run` (boolean), `mode` (`overlay`/`replace`), `reopen` (boolean), `allow_doc_examples` (array of `pem`/`jwt`). |
| `acc30a8 server.ts:156-188` route; `:197-204` `ProposeRefused` → 400 `{error, findings?}`, `ProposeFailed` → 502 `redact(message).slice(0, 400)` | `server.ts:218-224` `surface`, `caller`; `:254-257` 401 only when `!config.allowAnonymous`; `:203-214` `auditedRest` → 503 | Route order: `surface === null` → 401 (before body) → `readBody` (413) → `JSON.parse` (400) → `auditedRest(res, observability, surface, "skills_propose", body)` (503) → shape (400) → service (403/400/502/200). Auditing before the shape and attribution checks means 403s land in the audit chain, as D21-17 assumes. |
| `acc30a8 mcp.ts:143-175` tool | `mcp.ts:153-155` `refusal()`, `:166-169` `McpCaller`, `:171-175` caller destructure, `:782-795` last tool + `return server` | Register before `return server`; anonymous → `refusal("skills_propose needs an authenticated surface; nothing was proposed")`; `ProposeRefused` → `refusal(JSON.stringify({ error, findings }))`; `ProposeFailed` → `refusal(JSON.stringify({ error }))`; 403-class → `refusal(message)`. |
| `acc30a8 cli/src/index.ts:214-239` `readSkillDir`; `:241-335` `cmdSkillsPropose` (in-process, `CLI_MAX_BYTES`, posts its own event); `:337-343` `cmdSkills` | `cli/src/index.ts:30-31` `DEFAULT_TIMEOUT_MS = 1500`; `:37-40` `headers()` reads `SUBSTRATE_TOKEN`; `:62-73` `post()` returns `null` on network error; `:349-388` dispatch switch; `args.ts` `parseArgs`/`str`/`list` | New `packages/cli/src/skills.ts` (pattern: `lessons.ts` + `runLessons(argv, deps)`) exporting `readSkillDir`, the body builder and `runSkills(argv, deps)`; `index.ts` adds `case "skills"` and the header/usage lines. No in-process git, no event post. |

### 1c. Registries

| Registry | Main location | Edit |
|---|---|---|
| `KNOWN_ROUTES` | `observe.ts:53` `["/brief", "/events", "/verify", "/healthz", "/mcp", "/metrics", "/slo", "/evidence"]` | append `"/skills/propose"` (note `/events/query`, `/memory`, `/handoff`, `/drift` are already absent; the list is not exhaustive today) |
| `KNOWN_TOOLS` | `observe.ts:309-338` (19 MCP names, then REST names `brief, events, verify, drift, evidence`) | append `"skills_propose"` to the MCP block; the REST twin is audited under the same name, so no second entry (comment at :330-331) |
| `FAIL_CLOSED_TOOLS` | `packages/audit/src/policy.ts:16-26` (9 names, ending `coord_reap_leases`) | Phase 17 17-02 appends `skills_propose` with a "Phase 21" comment [CITED: p17 17-02-PLAN.md:47]; add only if absent on the base |
| `mcp.ts` | `registerTool(` blocks | new `skills_propose` block |

## 2. Phase 17 contract for this tool

Source: `/root/src/worktrees/agent-substrate-v13-p17/.planning/phases/17-event-vocabulary-and-audit-policy/` (plans committed at `5f9dcc0`; a revision pass is running).

- **Rows** [CITED: 17-01-PLAN.md:75; 17-RESEARCH.md:333-334]: `skills.propose` — phase 21, kind `note`, surface rule `caller`, action `skill.propose`, carries repo **yes** (`swcstudiospace/agent-skills`), periodic no; `skills.propose.refused` — phase 21, kind `warning`, surface `caller`, action `skill.propose`, carries repo **no**, periodic no.
- **`EventSource` shape** [CITED: 17-01-PLAN.md:68]: `id`, `phase`, `kind: EventKind`, `surface: SurfaceRule` (`fixed` / `herdr-agent` / `caller` / `memory-writer` / `lease-holder`), optional `actions` array, optional `runtime`, `carriesRepo: boolean`, `periodic: boolean`, `sample(): EventInput`. `event-sources.ts` imports only `./types.ts`.
- **Tests that will hold this phase** [CITED: 17-01-PLAN.md:75; 17-RESEARCH.md:572-574]: every sample round-trips `normalizeEvent`; `Boolean(sample.repo) === entry.carriesRepo`; no payload key in `text|content|body|bytes|image|png`; doc table (between the event-sources HTML markers, columns `id phase kind surface action runtime repo periodic`) has the same id set and per-row kind/actions as `EVENT_SOURCES` ∪ `SILENT_SOURCES`; roadmap-prefix coverage includes `skills.propose`.
- **Consequence for emits:** the refused **and failed** warnings must carry **no `repo`** (row says no); the outcome note carries `repo` = configured slug. Payload keys `action, name, status, pr_url, content_sha256, redactions, reason, rules` hit neither the no-content list nor `SENSITIVE_KEY` [VERIFIED: redact.ts:66 `/(?:password|passwd|secret|token|api[_-]?key|apikey|authorization|credential|private[_-]?key)/i`].
- **Adding `failed` (D21-17):** the doc table has no status column, and `sample()` holds one status. Recommended: add a third row `skills.propose.failed` (phase 21, `warning`, `caller`, actions `skill.propose`, carriesRepo false, periodic false, sample `status: "failed"`) to `EVENT_SOURCES` and to the marked table in `docs/event-vocabulary.md`, and state the status values (`opened/existing/declined/unchanged` on the note; `refused`/`failed` on warnings) in the doc's prose. The doc-equals-table test then passes by construction, and the D21-17 "kind and action equal the row" test can look up rows by id. If Phase 17's final table already models statuses differently, follow it (see Open Questions).
- **Audit policy** [CITED: 17-02-PLAN.md:47; 17-CONTEXT.md:97]: `skills_propose` fail-closed ("Opens a PR other agents will receive after merge; a proposal nobody recorded is an unaudited publication"). 17-02 also adds a scan guard in `policy.test.ts` that extracts `/registerTool\(\s*"([a-z_]+)"/g` from `mcp.ts` and `/auditedRest\(res, observability, surface, "([a-z_]+)"/g` from `server.ts` and requires each name in exactly one set [CITED: 17-RESEARCH.md:501]. **Keep the route's call on one line with exactly those argument names** or the guard silently stops seeing it.
- **Phase-close check** [CITED: 17-CONTEXT.md:80-84; 17-03-PLAN.md:53]: `bun run check:phase-close` → `scripts/phase-close-check.ts`, runs `store-lock`, `vocabulary-lock`, `event-sources` and `policy` tests (asserting each file exists), diffs `EVENT_KINDS` against `ab62c91`, and requires `SURFACES` = baseline + `substrate`. Exit 0 pass, 1 check failed, 2 precondition refused. This phase adds no kind and no surface, so it must stay green.
- **`substrate` surface** [CITED: 17-01-PLAN.md:68,75]: appended last; a `SUBSTRATE_TOKEN_SUBSTRATE` token resolves to it and `attributedSurface` binds it. D21-03's stricter rule must not reuse `attributedSurface` (non-swarm callers are body-first there, mcp.ts:91-97).

## 3. Phase 18 contract (redactor and lock)

Source: `/root/src/worktrees/agent-substrate-v13-p18/.planning/phases/18-guard-rails-and-shared-redactor/` (committed `dc1a25b`; a revision pass is running).

- **Exports this phase imports** [CITED: 18-02-PLAN.md:23,64; 18-PATTERNS.md:108-112], September signatures unchanged [VERIFIED: `git show acc30a8:packages/mcp-server/src/redact.ts` lines 114-286]:
  - `type SkillDocExampleRule = "pem" | "jwt"`
  - `interface SkillFileHit { file: string; line: number; rule: SkillRedactionRule }`
  - `redactSkillContent(text, opts?: { allowDocExamples?: ReadonlySet<SkillDocExampleRule> }) → { text, redactions: SkillRedactionHit[], findings: SkillRedactionHit[] }`
  - `scanSkillFiles(files: Record<string,string>, opts?) → { files, redactions: SkillFileHit[], findings: SkillFileHit[] }` — files sorted by path, 1-based lines.
  - `redact(text)` (event pass; used by `tail()`).
  - `SkillRedactionRule` gains `google, slack, npm, gitlab, digitalocean, openai-proj` (findings) and `pk-rk, private-tag, api-key-lower` (contextual redactions) [CITED: 18-02-PLAN.md:24]. Findings JSON therefore can name these rules; the CLI prints whatever `rule` arrives.
- **redact-lock rules (non-test sources under `packages/`, `scripts/`, `infra/`, incl. extensionless shebang files)** [CITED: 18-CONTEXT.md:85-89; 18-RESEARCH.md:410-413]:
  1. Any import of `redact`, `redactValue`, `redactKnown`, `redactSkillContent`, `scanSkillFiles`, `REDACTED`, or of a module whose basename matches `/redact/i`, must resolve to `packages/mcp-server/src/redact.ts`.
  2. No definition named `redact\w*`, `\w*Redactor`, `scan\w*Secret\w*`, `scanSkill\w*` outside `redact.ts`.
  3. No `[REDACTED` string literal and no `.replace`/`.replaceAll` with `REDACTED` as replacement outside `redact.ts`.
  4. No regex literal / `new RegExp` holding a credential prefix (`gh[pousr]_`, `sk-ant-`, `lin_api_`, `AKIA`, `AIza`, `xoxb-`, `glpat-`, `npm_`, `dop_v1_`, `tskey-`, `PRIVATE KEY`).
- **What that means here:**
  - `propose.ts` (`../redact.ts`) and CLI `skills.ts` (`../../mcp-server/src/redact.ts`, type-only) pass rule 1.
  - Do not name helpers `redactedTail`, `redactFindings`, `scanSkillDir`, etc. (rule 2). `readSkillDir` is fine.
  - The smoke script and fake gh must not contain the literal `[REDACTED`; import `REDACTED` from `redact.ts` if a marker check is wanted (rule 3).
  - The planted secret is assembled at runtime from fragments, never a regex and never a whole literal token shape (rule 4 + store-lock + GitHub push protection).
- **Test fixtures:** test files are exempt from redact-lock, but Phase 18's convention is runtime-assembled credentials everywhere [CITED: 18-PATTERNS.md:512-514]. September's `propose.test.ts` already builds GitHub shapes at runtime (`` `ghp_${"A".repeat(36)}` ``) but carries a **literal JWT** (`eyJhbGciOiJIUzI1NiJ9.eyJzdWIi…`) in the `allowDocExamples jwt` test [VERIFIED: acc30a8 propose.test.ts, "allowDocExamples jwt" test]. Assemble it from parts when porting.
- **Hash drift note:** Phase 18 adds `api-key-lower` as a redaction. A September proposal whose files held a lowercase `api_key: <real value>` now redacts differently, so its `content_sha256` changes and the ledger will not dedupe it [ASSUMED from the rule addition; not probed against the 14 ledger lines].

## 4. Phase 16 harness extension points

Source: `/root/src/worktrees/agent-substrate-v13-phase`. Read at `873eda2`; the code-review fixes WR-01..03 landed during this session (HEAD `4c11888`: missing flag values refused, default swarm operator refused, `up` gated on a fully healthy twin), so line numbers shift. **Anchor by symbol**; the behaviours below were re-checked at `4c11888`.

- **`buildRehearsalEnv(input)`** [VERIFIED: packages/mcp-server/src/rehearsal-env.ts, `export function buildRehearsalEnv` at :134; input type `BuildRehearsalEnvInput` at :55]: starts from `PATH`, `HOME`, `BUN_*` of `input.parentEnv`, then `SUBSTRATE_HOST`, `SUBSTRATE_PORT`, scratch store records, one `tokenEnvName(surface)` per surface, `SUBSTRATE_OPERATOR_TOKENS` (the operator surface's token), `SUBSTRATE_AUDIT_PATH = join(runDir, "mcp-audit.jsonl")`, `SUBSTRATE_HANDOFF_KEY`.
  - Add `SUBSTRATE_SKILLS_STATE = join(runDir, "skills")` **unconditionally**, and with a new optional input `skillsFixture?: { repo: string; remoteUrl: string; gh: string }` add `SUBSTRATE_SKILLS_REPO`, `SUBSTRATE_SKILLS_REMOTE_URL`, `SUBSTRATE_SKILLS_GH`.
  - `rehearsal-env.test.ts`, test "built env holds exactly the allowlist plus the scratch keys" (:197), pins the **exact** key set; it must be updated (the state key always; the three fixture keys only when the fixture input is given). Extend "parent production values never reach the built env" (:179) with parent `SUBSTRATE_SKILLS_*` values that must not leak.
- **Run dir** [VERIFIED: scripts/rehearsal.ts `runDirFor`]: `${XDG_RUNTIME_DIR ?? "/tmp"}/substrate-rehearsal/<name>`, created 0700 in `runUp`, holding `state.json`, `server.log`, `consumer.env`, `stores.env`, `tokens/<surface>` (0600). Here `XDG_RUNTIME_DIR=/run/user/0`, a tmpfs mounted `rw,nosuid,nodev` — **not** `noexec`, so a generated wrapper script there is executable [VERIFIED: `findmnt`].
- **Flag parsing** [VERIFIED: scripts/rehearsal.ts `flag`, `usage`, `main`]: `flag(argv, "--x")` returns `undefined` when absent and `null` when the value is missing (WR-03), and `main` refuses a `null`; booleans are `argv.includes("--anonymous")`. Add `const skillsFixture = argv.includes("--skills-fixture")`, pass it into `runUp({ …, skillsFixture })` (`UpOptions`), extend the `usage` string and persist it in `TwinState` so `status` can report it.
- **Where to build the fixture in `runUp`:** after `mkdirSync(runDir)` and `tokens/`, and before `const serverEnv = buildRehearsalEnv(...)`. The server is spawned with `Bun.spawn(buildServerSpawnArgv(), { cwd: checkout, env: serverEnv, … })`; `buildServerSpawnArgv()` = `[process.execPath, "--no-env-file", "packages/mcp-server/src/index.ts"]`.
- **Stale state:** `runUp` does **not** delete an existing run dir: after `removeLabelledContainers(opts.name)` (comment "A stale run dir (crashed up) keeps its label …") it only calls `mkdirSync(runDir, { recursive: true, mode: 0o700 })`. A crashed earlier `up` leaves `skills/proposals.jsonl` behind, which would make the next smoke answer `existing` instead of `opened`. The fixture builder must `rmSync` `<runDir>/skills` and `<runDir>/skills-fixture` before building.
- **`down`** [VERIFIED: `runDown`]: every path ends `rmSync(runDir, { recursive: true, force: true })`, which removes `skills/` and `skills-fixture/` with no extra code.
- **`consumer.env`** [VERIFIED: rehearsal-env.ts `consumerEnvRecord` at :196]: `SUBSTRATE_URL`, `SUBSTRATE_TOKEN` (the **first** surface's token), `SUBSTRATE_REHEARSAL_TOKENS_DIR`, `SUBSTRATE_REHEARSAL_NAME`, `SUBSTRATE_TEST_PG_URL`. Default surfaces `DEFAULT_SURFACES_RAW = "claude-code,cursor,hermes,omp"` and default operator = first surface (`parseOperator`), so **`SUBSTRATE_TOKEN` is the operator token**. The smoke reads `tokens/cursor`, `tokens/hermes`, `tokens/omp` for non-operator calls (the operator-option 403 needs one).
- **Reusable exports** [VERIFIED: `refuseSmokeUrl`, `parseShellExports`, `runDirFor`, `RehearsalRefused` are exported]: `smokeCall`/`smokeTool`/`smokeToolResult`/`parseSmokeBody` are **not exported** and `smokeCall` uses `AbortSignal.timeout(10_000)`; the skills smoke needs its own helper with a longer timeout (or Phase 21 exports a timeout-parameterised version). MCP replies come back as SSE frames; `parseSmokeBody` shows the parsing.
- **Store lock:** `scripts/*.ts` may not contain `GREPTIME_`; `packages/mcp-server/src/*` may [VERIFIED: store-lock.test.ts:39-41 in the Phase 16 worktree]. The fixture builder names no store key wherever it lives.
- **Harness env reaching git and gh:** `HOME` from the parent (here `/root`). Global git config holds only GitHub-scoped credential helpers and `safe.directory` entries — no `commit.gpgsign`, no `core.hooksPath`, no `url.*.insteadOf` [VERIFIED: `git config --global --get-regexp`], so real git against `file://` needs nothing more.

## 5. Git mechanics (probed with git 2.43.0 in a `/tmp` scratch dir, now removed)

| Step | Command | Observed |
|---|---|---|
| Bare library | `git init -q --bare -b main <B>`; `git -C <B> config receive.denyNonFastForwards true`; `… receive.denyDeletes true`; `… core.logAllRefUpdates always` | created |
| Seed main | `git init -q -b main seed`; write `demo-skill/SKILL.md`; `git -C seed -c user.name=… -c user.email=… commit`; `git -C seed push -q <B> main` | `refs/heads/main` in B |
| Mirror | `git clone -q --bare <B> skills/mirror.git`; `git -C skills/mirror.git config remote.origin.fetch '+refs/heads/main:refs/heads/main'` | config shows `url = <B path>` and that refspec |
| Mirror fetch | `git -C skills/mirror.git fetch origin main` after advancing B's main | mirror `main` advanced to B's |
| **Without refspec** | same fetch on a plain `git clone --bare` (no `remote.origin.fetch`) | **main did not advance** (`nomap main=18beaa7 bare main=691d7af`) — only `FETCH_HEAD` updates |
| Shared clone | `git clone -q --shared --no-checkout skills/mirror.git <C>` | refs: `refs/heads/main`, `refs/remotes/origin/HEAD`, `refs/remotes/origin/main`; `objects/info/alternates` → mirror objects |
| Set URL + checkout | `git -C <C> remote set-url origin file://<B>`; `git -C <C> checkout -q -b skill/omp/x-1-abcd origin/main` | exit 0 |
| Staged diff | `git -C <C> add -- new-skill`; `git -C <C> diff --cached --quiet` | exit **1** with changes (0 when identical) |
| Origin | `git -C <C> remote get-url origin` | `file:///tmp/…/skills-fixture/rehearsal/agent-skills.git` → `originMatches(…, "rehearsal/agent-skills")` is true (lowercase, strip `.git`, `endsWith("/rehearsal/agent-skills")`) |
| Push | `git -C <C> push origin skill/omp/x-1-abcd` | `* [new branch]`, exit 0 (alternates fine over `file://`) |
| Reflog | `<B>/logs/refs/heads/skill/omp/x-1-abcd` | one line `0000…0000 <new-sha> <ident> <epoch> +0000\tpush` |
| Force push | amend, `git push --force origin <branch>` | `! [remote rejected] … (non-fast-forward)` |
| Delete | `git push origin :<branch>` | `! [remote rejected] … (deletion prohibited)` |

**Proving "no force push" (smoke (e)):** set `core.logAllRefUpdates=always` on the bare repo (the default for a bare repo is off, so without it there is no reflog — `[ASSUMED]` from git docs, consistent with the probe needing the setting). For every file under `<B>/logs/refs/heads/`, every line's old sha must be all-zero (new ref) or an ancestor of its new sha (`git --git-dir <B> merge-base --is-ancestor <old> <new>` exit 0). With `denyNonFastForwards` a forced update is also rejected outright, so the check is belt and braces. Also count `refs/heads/skill/*` before/after each refused or deduped call (no new branch).

**Mirror fetch refspec covers only `main`:** skill branches pushed to the library never come back into the mirror, and the production mirror is already configured this way [VERIFIED: `/var/lib/substrate/skills/mirror.git/config` → `fetch = +refs/heads/main:refs/heads/main`, refs: only `refs/heads/main`].

## 6. Fake `gh` design

The engine issues exactly three `gh` argv shapes [VERIFIED: acc30a8 propose.ts:310-321] and parses them as follows:

| argv (engine) | Parser | Fake must answer |
|---|---|---|
| `gh pr create --repo <slug> --head <branch> --base main --title <t> --body <b>` | `prUrlOf(stdout)`: last line matching `^https://github\.com/([^/\s]+/[^/\s]+)/pull/(\d+)$` whose slug equals the configured repo (L330-339) | Exit 0, stdout `https://github.com/rehearsal/agent-skills/pull/<n>\n`. Refuse (exit 1, stderr) if `--repo` ≠ expected slug, `--base` ≠ `main`, the head branch does not exist in the bare repo (`git --git-dir <B> rev-parse --verify --quiet refs/heads/<branch>`), or an OPEN PR already exists for that head (real gh refuses that too [ASSUMED]). |
| `gh pr view <url> --json state,url,number` | `JSON.parse(stdout).state` ∈ `OPEN` / `CLOSED` / `MERGED`; anything else → `ProposeFailed` (L534-547) | `{"number":n,"state":"OPEN","url":"…"}`; unknown URL → exit 1 |
| `gh pr list --repo <slug> --head <branch> --state open --json url,number` | `JSON.parse(stdout)` array; each `url` through `prUrlOf` (L552-559) | `[]` or `[{"number":n,"url":"…"}]` (open PRs for that head only) |
| `gh pr close <url>` (smoke only) | — | sets `state: "CLOSED"`; this is a real gh verb, so the smoke flips a PR the natural way (D21 discretion: "how the smoke flips a PR to closed") |
| anything else | — | exit 2 `fake gh: unsupported` so a new engine verb fails loudly |

- **State file** (`<runDir>/skills-fixture/gh-state.json`): `{ "repo": "rehearsal/agent-skills", "bare": "<B>", "next": 1, "prs": [{ "number", "url", "head", "base", "title", "state" }] }`. Writes go through a `mkdir`-lock and write-temp-then-rename, so two concurrent `gh` calls cannot tear it.
- **Call record** (`<runDir>/skills-fixture/gh-calls.jsonl`): one JSON array per invocation, appended. The smoke counts `pr create` lines per step and greps the file for the planted secret (none expected; the secret is refused before any `gh`).
- **Implementation:** a tracked Bun TS module (e.g. `packages/mcp-server/src/rehearsal-fake-gh.ts`, pure state transitions exported for unit tests, `main` under `import.meta.main`), plus a generated `#!/bin/sh` wrapper in the run dir: `FAKE_GH_STATE='<state>' exec '<abs bun>' --no-env-file '<checkout>/…/rehearsal-fake-gh.ts' "$@"`. The absolute bun path (`process.execPath` at `up`) avoids depending on the child's `PATH`; `--no-env-file` stops Bun auto-loading a `.env` from the server's cwd (Phase 16 does the same for the server, rehearsal.ts:173-175). The env var is set **inside** the wrapper because the engine's child env is an allowlist (D21-15) and would drop anything else.
- `SUBSTRATE_SKILLS_GH` points at the wrapper; the production runner maps `argv[0] === "gh"` to it.

## Architecture Patterns

### System Architecture Diagram

```
  MCP client ──POST /mcp──┐     hook/agent ──POST /skills/propose──┐     substrate skills propose --dir D
                          │                                         │       │ readSkillDir (symlink/special/non-UTF-8 refuse)
                          │                                         │       │ JSON body ≤ 1 MB pre-flight
                          │                                         │       └──POST /skills/propose (SUBSTRATE_TOKEN, ~180 s)──┐
                          ▼                                         ▼                                                          │
                 server.ts: surfaceForToken → caller {surface, isOperator}   (401 if tokens configured and none) ◄──────────────┘
                          │                                         │
           handleMcp: readBody (413) → audit gate ──deny──► 200 JSON-RPC error
                          │                       route: surface null → 401 → readBody (413) → JSON (400)
                          │                              → auditedRest("skills_propose") ──deny──► 503
                          │                              → body shape (400)
                          ▼                                         ▼
               mcp.ts skills_propose (zod)           ┌──────────────────────────────┐
                 anonymous → isError                 │ Substrate.proposeSkill(input, │
                          └────────────────────────► │   caller)                     │
                                                     │ surface mismatch / operator   │──► 403 / isError (no event)
                                                     │ options → refuse              │
                                                     └──────────────┬───────────────┘
                                                                    ▼
                                         SkillProposer.propose  (engine, injected Runner)
             validateProposal: name, paths, SKILL.md frontmatter (Bun.YAML), text-only, cap, removals,
                              scanSkillFiles (Phase 18) ──finding──► ProposeRefused ──► 400 / isError + warning(refused)
             mirror exists? ──no──► ProposeFailed (bootstrap text) ──► 502 / isError + warning(failed)
             content lock (locks/<sha>) → ledger lookup ──OPEN──► existing │ CLOSED ──► declined │ pushed ──► gh pr list
             mirror lock → git fetch origin main → unlock
             clone --shared --no-checkout → remote set-url <remote> → checkout -b skill/<surface>/<name>-<ts>-<hex> origin/main
             writeTree (overlay|replace, confined) → add -- <name> → diff --cached --quiet ──0──► unchanged
             (dry_run: name-status counts → dry_run, no push/gh/ledger/event)
             commit → remote get-url == configured slug? → push origin <branch> → ledger pushed
             → gh pr create → prUrlOf (slug) → ledger opened → opened ──► 200 / JSON + note
             finally: rm clone, release content lock
                                    │                                     │
                                    ▼                                     ▼
                     git (PATH, HOME, GIT_TERMINAL_PROMPT=0)     gh or fake gh (same env + GH_PROMPT_DISABLED=1)
                     production: GitHub via mirror + https       harness: file:// bare repo + recording wrapper
```

### Recommended Project Structure
```
packages/mcp-server/src/
├── skills/
│   ├── propose.ts            # ported engine; library-aware builders; createExecFileRunner
│   ├── propose.test.ts       # ported (+ library, env allowlist, missing mirror, commit msg)
│   ├── propose.git.test.ts   # engine vs real git + fake-gh runner on a temp fixture (no Docker)
│   ├── frontmatter.ts        # verbatim
│   └── authority.ts          # optional: proposalSurface + operator-option check (pure)
├── rehearsal-skills.ts       # fixture builder (bare repo, mirror, wrapper, gh state) beside rehearsal-env.ts
├── rehearsal-fake-gh.ts      # fake gh: pure transitions + main under import.meta.main
├── config.ts                 # + skills block, file:// rule
├── service.ts / server.ts / mcp.ts / observe.ts   # integration
packages/cli/src/
├── skills.ts                 # readSkillDir, body builder, runSkills(argv, deps)
└── skills.test.ts
scripts/
├── rehearsal.ts              # + --skills-fixture
├── skills-propose-smoke.ts   # pure helpers exported; main under import.meta.main
└── skills-propose-smoke.test.ts
docs/skills-propose.md        # new
```

### Pattern 1: Library-aware argv builders with a mapping runner
**What:** keep `argv[0]` literal (`"git"`, `"gh"`) so September's pins survive; resolve the binary in the runner.
```typescript
// Source: acc30a8 propose.ts:394-411 (shape), D21-15 (env)
export interface SkillsLibrary { repo: string; remoteUrl: string }
export function prCreateArgv(branch: string, title: string, body: string, repo: string): string[] {
	return ["gh", "pr", "create", "--repo", repo, "--head", branch, "--base", "main", "--title", title, "--body", body];
}
export function createExecFileRunner(opts: { gh: string; home?: string }): Runner {
	const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", HOME: opts.home || process.env.HOME || "/root" };
	if (process.env.PATH) env.PATH = process.env.PATH;
	return (argv) => {
		const { promise, resolve } = Promise.withResolvers<RunResult>();
		const bin = argv[0] === "gh" ? opts.gh : (argv[0] as string);
		execFile(bin, argv.slice(1), { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8", env }, (error, stdout, stderr) => {
			resolve({ code: error ? (typeof error.code === "number" ? error.code : null) : 0, stdout: String(stdout), stderr: String(stderr) });
		});
		return promise;
	};
}
```

### Pattern 2: Proposal authority (pure, shared by service and tool)
```typescript
// D21-02, D21-03, D21-05. Not attributedSurface (mcp.ts:91-97 is body-first for non-swarm callers).
export type ProposeAuthority = { surface: Surface } | { status: 401 | 403; error: string };
export function proposeAuthority(
	caller: { surface: Surface | null; isOperator: boolean },
	request: { surface?: string; mode?: string; reopen?: boolean; allow_doc_examples?: readonly string[] },
): ProposeAuthority {
	if (caller.surface === null) return { status: 401, error: "skills_propose needs an authenticated surface; nothing was proposed" };
	if (request.surface !== undefined && request.surface !== caller.surface) {
		return { status: 403, error: `this token is ${caller.surface} and cannot propose as ${request.surface}` };
	}
	const privileged = request.mode === "replace" || request.reopen === true || (request.allow_doc_examples?.length ?? 0) > 0;
	if (privileged && !caller.isOperator) return { status: 403, error: "replace, reopen and allow_doc_examples need an operator token" };
	return { surface: caller.surface };
}
```

### Pattern 3: Fail-open event emission per Phase 17 row
```typescript
// Source: service.ts:824-834 (bindGraph emit with .catch); 17-RESEARCH.md:333-334 (rows)
await this.emit({
	surface,
	kind: "note",
	summary: `skill ${input.name} ${result.status}`,
	repo: this.config.skills.repo,          // note only; warnings carry no repo
	...(input.graph_id ? { graph_id: input.graph_id } : {}),
	session_id: input.session_id ?? `skills-propose:${result.content_sha256}:${Date.now()}`,
	actor: "agent",
	payload: { action: "skill.propose", name: input.name, status: result.status, pr_url: result.pr_url,
		content_sha256: result.content_sha256, redactions: result.redactions.length },
}).catch(() => undefined);
```
The fallback `session_id` follows the `bindGraph` precedent of a one-event session, because a sessionless event on a graph shares the `""` chain bucket in `verifyGraph` [VERIFIED: service.ts:827-831 comment]. Whether to add it is a planner call; it is harmless when no `graph_id` is given.

### Pattern 4: CLI as a testable module
`lessons.ts` exports `runLessons(argv, deps)` and `index.ts` passes real I/O [VERIFIED: cli/src/index.ts:365-381; lessons.ts:942]. Mirror it: `runSkills(argv, { post(path, body, timeoutMs): Promise<{status, json} | null>, out, err, cwd })`. Unit-test with a stub `post`; add one `Bun.spawn` (async, not `spawnSync` — http.test.ts:349-354 explains the deadlock) against a stub `node:http` server that records the request.

### Anti-Patterns to Avoid
- **Reusing `attributedSurface` for the proposal surface:** it re-attributes to a body surface for non-swarm tokens.
- **Spreading `process.env` into the child (September L403):** leaks store URLs and tokens into `git`/`gh` (D21-15).
- **Auditing after the 403 checks:** the attribution refusal would leave no audit record, contrary to D21-17's "the audit chain records those".
- **A multi-line `auditedRest(...)` call or different argument names:** Phase 17's scan regex stops matching.
- **In-process CLI propose:** a second door without token, audit or event (D21-07).
- **Building the fixture with `git clone --bare` and no fetch refspec:** the mirror never advances (§5).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| YAML frontmatter | a regex YAML reader | `Bun.YAML.parse` behind `FENCE_RE` | Quoting, multi-line scalars; September's choice |
| Secret detection / redaction | any pattern in propose.ts, CLI, smoke | `scanSkillFiles` / `redactSkillContent` / `redact` from `redact.ts` | Phase 18 redact-lock fails the build otherwise |
| Audit gating | a route-local audit call | `auditedRest` / `handleMcp` gate | One policy, fail-closed by name |
| Surface resolution / operator | header parsing | `surfaceForToken`, `isOperator` (config.ts:221-247) | Swarm-never-operator rule lives there |
| Event normalisation | manual redaction of payload | `Substrate.emit` → `normalizeEvent` (redact + caps) | event.ts:52-55 caps: summary 2000, field 512, payload string 4000, payload 16 000 bytes |
| PR idempotence | GitHub search | ledger + `gh pr view`/`gh pr list --head` | Search is eventually consistent (September W1) |
| Locks | `flock` / lockfile libs | September's dir + PID locks | Already tested incl. stale-PID reclaim |

**Key insight:** every guard this phase needs already exists either on `acc30a8` or in Phases 16-18; new code is wiring, configuration and the fixture.

## Runtime State Inventory

Not a rename phase; listed because the engine reads production state the moment it ships.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | `/var/lib/substrate/skills/proposals.jsonl` — 14 lines, 7 `pushed` + 7 `opened`, keys `branch, content_sha256, name, state, surface, ts` (+ `pr_number, pr_url` on `opened`); surfaces `claude-code`, `docs-scraper`, `omp`, `grok-build`, `hermes` [VERIFIED: `jq -c '[keys, .state, .surface]'`] | None (format kept, D21-14). Never validate a ledger line's `surface` against `SURFACES` — `docs-scraper` is not a surface on main. |
| Live service config | `mirror.git` (bare, `fetch = +refs/heads/main:refs/heads/main`, only `refs/heads/main`); empty `locks/`, `propose/`; `propose.key` (64 bytes); `projector-warned.json` (Phase 22's) [VERIFIED: `ls -la`, `cat mirror.git/config`] | None in this phase; do not modify. `propose.key` becomes unused (D21-01). |
| OS-registered state | `substrate-mcp.service`: `StateDirectory=substrate` (0700), `ProtectSystem=full`, `ProtectHome=false`, `PrivateTmp=true`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`, no `User=` [VERIFIED: infra/vps/substrate-mcp.service:20-41] | None; `/var/lib/substrate/skills` is writable, `/root` readable for `gh` config. Restart onto this code is out of scope. |
| Secrets/env vars | New keys `SUBSTRATE_SKILLS_REPO`, `_REMOTE_URL`, `_STATE`, `_GH` — none secret | Add commented defaults to `.env.example`; production needs none (defaults). |
| Build artifacts | none | — |

## Common Pitfalls

### Pitfall 1: The route's anonymous path is only reachable on an anonymous run
**What goes wrong:** with tokens configured, `server.ts:254-257` returns `401 {"error":"unknown or missing bearer token"}` before any route, so the route's own 401 and the MCP tool's anonymous refusal are only exercised when `allowAnonymous` is true. The harness has tokens, so smoke (d) sees the global 401 for both route and `/mcp`.
**How to avoid:** unit-test the route-level 401 and the MCP `isError` refusal with `loadConfig({})` servers; in the smoke, accept the global 401 for both doors (and the MCP "refused" is that HTTP 401).

### Pitfall 2: Body cap vs content cap
**What goes wrong:** `readBody` caps the raw HTTP body at 1 000 000 bytes (server.ts:46,117-126); `validateProposal` caps the sum of file UTF-8 bytes. JSON escaping and the JSON-RPC envelope make the body larger than the content, so the 413 always fires first near the cap, and over MCP the effective content cap is a little lower.
**How to avoid:** the CLI pre-flight measures `Buffer.byteLength(JSON.stringify(body))`, not file sizes; the docs say the cap is on the request body.

### Pitfall 3: `readBody` error becomes 500
**What goes wrong:** the generic `Error` at server.ts:122 reaches `sendJson(res, 500, { error: String(cause) })` (:491).
**How to avoid:** port `BodyTooLargeError` (`acc30a8 server.ts:35-41`) and catch it before the 500 branch; no existing test asserts the 500.

### Pitfall 4: A crash-looping substrate from a config throw
**What goes wrong:** `index.ts` calls `loadConfig()` at top level (index.ts:16); a throw exits the process, and the unit has `Restart=always`, `RestartSec=3`, `StartLimitIntervalSec=0`, so a bad `SUBSTRATE_SKILLS_*` combination would take the brief, events and claims down with it. `index.ts:1-9` states the opposite philosophy (boot degraded, report).
**How to avoid:** see Open Question 2 — detect at startup, report through the existing `[substrate] misconfigured — …` channel, and make every proposal answer `ProposeFailed` until fixed; or, if the operator wants a hard stop, throw. Either way `loadConfig({})` (used by dozens of tests) must keep returning defaults without throwing.

### Pitfall 5: Non-default slug with the real `gh`
**What goes wrong:** D21-13 forces a non-default repo onto a `file://` remote, but `SUBSTRATE_SKILLS_GH` can stay `gh`. Then `gh pr create --repo rehearsal/agent-skills` and `gh pr view` run with the owner's credential against a stranger's GitHub repository (the push went to `file://`, so `pr create` fails, but the credentialed API call still happens).
**How to avoid:** also require `SUBSTRATE_SKILLS_GH` to be an absolute path other than the default whenever the repo or remote is non-default (Open Question 3).

### Pitfall 6: Stale run dir makes the smoke answer `existing`
**What goes wrong:** `runUp` reuses an existing run dir (only `mkdirSync`, no `rmSync`; see §4), so a previous ledger or gh state survives a crashed `up`.
**How to avoid:** the fixture builder deletes and recreates `skills/` and `skills-fixture/`.

### Pitfall 7: Bare mirror without a fetch refspec
See §5: `git fetch origin main` updates only `FETCH_HEAD`. The fixture (and the missing-mirror bootstrap text) must set `remote.origin.fetch +refs/heads/main:refs/heads/main`.

### Pitfall 8: Store-lock and redact-lock in new files (including tests and docs)
- `SUBSTRATE_TOKEN` followed by `:`/`=` and a 16+ character identifier or value fails `TOKEN_LITERAL` in any tracked file, comments included — e.g. an object key `SUBSTRATE_TOKEN` assigned from a variable whose name is 16+ characters. Use short local names (`tok`), as Phase 16's `consumerEnvRecord` does (`const token = input.firstToken`, with a comment explaining why).
- `GREPTIME_` anywhere in `scripts/`.
- `[REDACTED` literal, a credential-prefix regex, or a `redact*`/`scanSkill*` definition in non-test sources.

### Pitfall 9: Long requests inside the HTTP handler and MCP clients
**What goes wrong:** a proposal runs fetch, clone, push and `gh` sequentially; each step may take up to 120 s, and the content lock waits up to 20 s. The CLI's 1.5 s default would abort (D21-07 sets ~180 s). MCP clients commonly time out a tool call around 60 s [ASSUMED: MCP TypeScript SDK default request timeout].
**What was checked:** Bun 1.4.0's `node:http` server served a request whose handler slept 13 s with no idle-timeout cut [VERIFIED: probe returned `status 200 ok 13007`]. Longer durations were not probed.
**How to avoid:** CLI timeout default 180 000 ms via its own variable (e.g. `SUBSTRATE_SKILLS_TIMEOUT_MS`); document that a slow proposal over MCP may time out client-side while the server finishes, and that a retry answers `existing` thanks to the ledger.

### Pitfall 10: Lock semantics in one process
**What goes wrong:** both locks record `process.pid`; inside the single server process a second identical proposal sees a live PID and waits; if the first takes over 20 s, the second fails `proposal busy` (502). After a restart the old PID is dead and its lock is reclaimed — unless the PID has been reused by another live process, which then reads as busy for 20 s.
**How to avoid:** keep September's behaviour (D21-12); document 502 `proposal busy` as retryable.

### Pitfall 11: `HOME` and `PATH` under systemd
**What goes wrong:** without `HOME`, git cannot find `/root/.gitconfig`'s `credential.https://github.com.helper !/usr/bin/gh auth git-credential` and `gh` cannot find `~/.config/gh`; with `GIT_TERMINAL_PROMPT=0` the push then fails instead of hanging. Whether systemd sets `HOME` for a root service without `User=` is [ASSUMED]; D21-15's `/root` fallback covers both. `PATH` under systemd's default includes `/usr/bin`, where `git` and `gh` live [VERIFIED: `command -v`].

### Pitfall 12: `__proto__` as a file path
`scanSkillFiles` builds `out: Record<string,string> = {}` and assigns `out[file]` (acc30a8 redact.ts:279-283); a `__proto__` key is silently dropped from the redacted files and the hash, so that file never reaches the tree. Not a write hazard, but a silent drop. Cheap fix in `pathProblem`: refuse a `__proto__` segment.

### Pitfall 13: Dot files in a skill dir
`readSkillDir` reads everything, including `.DS_Store` or `.git/`; the server then refuses the whole proposal with `dot-segment in path` (or 413 for a `.git` directory). Either surface the server's 400 clearly or skip nothing and say so in the docs; do not silently skip (September's stated rule: "Nothing is skipped silently", acc30a8 cli index.ts:208-212).

### Pitfall 14: Bun's multi-file `bun test` trap
`bun test ./a.test.ts ./missing.test.ts` exits 0 if one listed file is missing [CITED: 17-RESEARCH.md:122]. Run each new test file on its own in verification.

## Code Examples

### Route skeleton
```typescript
// Sources: acc30a8 server.ts:156-188, 193-204; main server.ts:203-214, 254-257
if (req.method === "POST" && url.pathname === "/skills/propose") {
	if (surface === null) {
		sendJson(res, 401, { error: "skills_propose needs an authenticated surface; nothing was proposed" });
		return;
	}
	const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
	if (!(await auditedRest(res, observability, surface, "skills_propose", body))) return;
	const problem = proposeBodyProblem(body);
	if (problem) {
		sendJson(res, 400, { error: problem });
		return;
	}
	const outcome = await substrate.proposeSkill(toProposeRequest(body), caller); // throws ProposeForbidden/Refused/Failed
	sendJson(res, 200, outcome);
	return;
}
// catch: BodyTooLargeError → 413; ProposeForbidden → 403; ProposeRefused → 400 {error, findings?};
//        ProposeFailed → 502 { error: redact(message).slice(0, 400) }
```

### Fixture builder (core commands, all verified in §5)
```typescript
const bare = join(runDir, "skills-fixture", "rehearsal", "agent-skills.git");
git(["init", "-q", "--bare", "-b", "main", bare]);
for (const [k, v] of [["receive.denyNonFastForwards", "true"], ["receive.denyDeletes", "true"], ["core.logAllRefUpdates", "always"]]) {
	git(["-C", bare, "config", k, v]);
}
// seed: init -b main, write demo-skill/SKILL.md, commit with -c user.name/-c user.email, push <bare> main
git(["clone", "-q", "--bare", bare, join(runDir, "skills", "mirror.git")]);
git(["-C", join(runDir, "skills", "mirror.git"), "config", "remote.origin.fetch", "+refs/heads/main:refs/heads/main"]);
// env for SUBSTRATE_SKILLS_REMOTE_URL: `file://${bare}`; SUBSTRATE_SKILLS_REPO: "rehearsal/agent-skills"
```

### Runtime-assembled planted secret (smoke)
```typescript
// No literal token shape and no credential regex in the tracked file.
const prefix = ["g", "h", "p", "_"].join("");
const planted = prefix + randomBytes(27).toString("base64url").replace(/[^A-Za-z0-9]/g, "a").slice(0, 36);
```

## State of the Art

| Old Approach (September `acc30a8`) | Current Approach (Phase 21) | Impact |
|--------------|------------------|--------|
| `x-substrate-propose-key` header or bearer | Surface token only; anonymous always refused | Host clients without a token get 401 until Phase 22 |
| Body `surface` honoured on anonymous runs | Token surface only; mismatch 403 | Branch and event attribution cannot be forged |
| CLI in-process, 64 MB, posts its own `skill.propose` event | CLI over HTTP, 1 MB, server records the event | One door for audit and events |
| `kind: "skill.propose"` | `note`/`warning` + `payload.action: "skill.propose"` | Closed 12-kind vocabulary |
| `env: { ...process.env, HOME: "/root", … }` | Allowlist `PATH, HOME, GIT_TERMINAL_PROMPT, GH_PROMPT_DISABLED` | No store URLs or tokens in children |
| Hard-coded library | `SUBSTRATE_SKILLS_*` with `file://` rule | Harness proof against a throwaway repo |

**Deprecated/outdated:** `propose-auth.ts` (not ported); `CLI_MAX_BYTES`; the `Refs SPE-2734` commit line.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Phase 18's `api-key-lower` redaction changes `content_sha256` for September proposals that held a lowercase `api_key:` value | §3 | One extra PR for such content after deploy; low |
| A2 | Bare repos do not keep reflogs unless `core.logAllRefUpdates` is set | §5 | Without the setting the reflog check would be vacuous; the fixture sets it explicitly anyway |
| A3 | Real `gh pr create` refuses a second PR for a head that already has an open one | §6 | The fake is stricter or looser than gh; only affects smoke realism |
| A4 | MCP TypeScript SDK clients default to ~60 s request timeout | Pitfall 9 | Long proposals time out client-side; retry answers `existing` |
| A5 | systemd may not set `HOME` for a root service without `User=` | Pitfall 11 | Covered by the `/root` fallback either way |
| A6 | Phase 17/18 final plans keep the row ids, `EventSource` fields, exports and lock rules quoted here (both are under revision) | §2, §3 | Planner must re-read the base before Wave 1 |

## Open Questions

1. **Phase 17's final shape for statuses.** What we know: rows `skills.propose` (note, repo) and `skills.propose.refused` (warning, no repo); the doc table has no status column. Unclear: whether Revise17 changes this. Recommendation: add `skills.propose.failed` as its own row unless the base already models a status list; re-read `event-sources.ts` on the execution base first.
2. **"Startup configuration error" semantics (D21-13).** A throw in `loadConfig` crash-loops the whole substrate under `Restart=always`. Recommendation: report at boot via the `misconfigured —` warning channel and refuse every proposal with `ProposeFailed` naming the bad key; this keeps D21-13's guarantee (no proposal ever runs with an invalid combination) without making a skills typo an outage of briefs and claims. If the planner prefers a hard stop, throw a typed error with a clear message.
3. **`SUBSTRATE_SKILLS_GH` under a non-default library.** Recommendation: require an absolute non-default `gh` path whenever repo or remote is non-default (Pitfall 5). It tightens D21-13 in its own stated direction and changes nothing for production defaults.
4. **Malformed-body event.** D21-17 names `ProposeRefused` and `ProposeFailed` warnings; a body that fails `proposeBodyProblem` never reaches the engine. Recommendation: no event (audited only), matching "403 emits no event".
5. **Phase 16/17/18 on the base.** CONTEXT says execution starts from a base that holds all three. If `scripts/rehearsal.ts` is missing, waves 1-3 still verify in plain `bun test`; only the harness proof blocks (the Phase 17/18 precedent).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Bun | everything | ✓ | 1.4.0 (`/root/.local/share/reflex/bun/bin/bun`) | — |
| git | engine, fixture | ✓ | 2.43.0 (`/usr/bin/git`) | — |
| gh | production only | ✓ | 2.45.0 (`/usr/bin/gh`) | never called in tests or harness |
| node_modules (worktree) | tests, tsc, harness | ✓ | isolated linker, zod 4.6.5, bun-types 1.4.2 | `bun install --frozen-lockfile` |
| Docker + `postgres:16-alpine` + `greptime/greptimedb:v0.14.4` | harness proof | ✓ | images present locally; no `substrate.rehearsal` containers running | — |
| Disk | harness | ✓ (tight) | `/` 22 G free (95 % used); `/run/user/0` tmpfs 3.2 G | Phase 16 floor is 2 GiB |
| Phase 16/17/18 code | base | ✗ on this worktree (plans only) | — | Execution base must hold them (CONTEXT) |

**Missing dependencies with no fallback:** none beyond the base requirement.
**Note:** other agents may run rehearsal twins concurrently; use a unique `--name` (`p21`) and consider `--port 0` (`runUp` then calls `pickFreePort()`) to avoid colliding on 17410.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `bun test` (Bun 1.4.0), colocated `*.test.ts`; tsc 5.9.3 |
| Config file | none (root discovery; `tsconfig.json` includes `packages/**/*.ts`, `scripts/**/*.ts`) |
| Quick run command | `bun test ./packages/mcp-server/src/skills/propose.test.ts` (and each new file on its own) |
| Full suite command | `bun test && bunx tsc --noEmit` (baseline at `ab62c91`: 1129 pass / 56 skip / 0 fail across 40 files, tsc clean [CITED: STATE.md:33]; the base for this phase will differ after 16-18, so record the base's own numbers first, D21-23) |
| Phase gate | `bun run check:phase-close` exit 0, then the isolated harness proof |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SKILL-01 SC1 | Engine order, argv pins (no `--force`/`-f`/`--force-with-lease`/`--search`, no `:` in push), branch format, ledger `pushed`→`opened`, origin check before push, PR URL slug check, commit trailer without `Refs SPE-2734`, child env allowlist, `gh` mapping | unit | `bun test ./packages/mcp-server/src/skills/propose.test.ts` | ❌ Wave 0 (port) |
| SKILL-01 SC1 | Engine against real git + fake-gh runner on a temp bare repo: `opened` with branch in bare repo; mirror advance; no reflog non-FF | integration (no Docker) | `bun test ./packages/mcp-server/src/skills/propose.git.test.ts` | ❌ Wave 0 |
| SKILL-01 SC1 | Route 200 per status, MCP tool JSON, CLI `opened` output | unit/socket | `bun test ./packages/mcp-server/src/server.test.ts`, `./packages/mcp-server/src/mcp.test.ts`, `./packages/cli/src/skills.test.ts` | ✅ files exist; new describes ❌ |
| SKILL-01 SC2 | Refusals: bad name, `..`/absolute/backslash/dot/`.pyc` paths, missing/mismatched frontmatter, NUL, cap, remove rules, planted secret → findings `{file,line,rule}`, value absent from response | unit | propose.test.ts; server.test.ts (400 findings); mcp.test.ts | ❌ |
| SKILL-01 SC2 | Dedupe: `existing`, `declined` (+ ledger `closed`), `reopen` operator-only, `pushed`→`gh pr list --head`, `unchanged`, concurrent identical → one `gh pr create` | unit | propose.test.ts | ❌ |
| SKILL-01 SC2 | `frontmatter.ts` fence/YAML/non-mapping | unit | propose.test.ts (`parseFrontmatter` describe) | ❌ |
| SKILL-01 SC3 | Anonymous refused: route 401 before body (even 2 MB), MCP `isError`, CLI exit 1; no proposer call | unit/socket | server.test.ts (`loadConfig({})`), mcp.test.ts (`connect(null)`), skills.test.ts | ❌ |
| SKILL-01 SC3 | 403 surface mismatch; 403 operator-only options (`mode: replace`, `reopen`, `allow_doc_examples`) for non-operator; operator allowed | unit | server.test.ts, mcp.test.ts, service.test.ts | ❌ |
| SKILL-01 SC3 | 413 oversize; 502 `ProposeFailed` ≤ 400 chars redacted; 503 audit denial (`SUBSTRATE_AUDIT_PATH` unwritable, http.test.ts:61-72 helper) | socket | server.test.ts / http.test.ts | ❌ |
| SKILL-01 SC3 | Registration: `listTools` has `skills_propose` with required `files,name,rationale` and annotations; `toolLabel("skills_propose")`; `normalizeRoute("/skills/propose")`; `auditMode` fail-closed **and** `FAIL_CLOSED_TOOLS.has`; scan guard sees route + tool | unit | mcp.test.ts, observe.test.ts, `./packages/audit/src/policy.test.ts` | ✅ files; new tests ❌ |
| SKILL-01 (events) | note/warning(refused)/warning(failed) match `EVENT_SOURCES` rows by id: kind, `payload.action`, repo presence; none on dry_run/403/anonymous; emit failure never changes the answer | unit | `bun test ./packages/mcp-server/src/service.test.ts`, `./packages/mcp-server/src/event-sources.test.ts` | ✅ files; new tests ❌ |
| SKILL-01 (config) | defaults; `file://` rule; non-default + https → error/disabled; `SUBSTRATE_SKILLS_STATE` passthrough | unit | `bun test ./packages/mcp-server/src/config.test.ts` (new) or authority.test.ts | ❌ |
| SKILL-01 (harness) | `buildRehearsalEnv` exact keys incl. `SUBSTRATE_SKILLS_STATE`; fixture keys only with fixture; sentinel no-leak; fixture builder config (deny settings, logAllRefUpdates, mirror refspec); fake gh transitions | unit | `bun test ./packages/mcp-server/src/rehearsal-env.test.ts`, `./packages/mcp-server/src/rehearsal-skills.test.ts`, `./scripts/rehearsal.test.ts` | ✅ / ❌ |
| SKILL-01 (smoke helpers) | consumer.env parse, URL guard, reflog FF check, secret assembly | unit | `bun test ./scripts/skills-propose-smoke.test.ts` | ❌ |
| Locks | store-lock, redact-lock stay green with every new file | repo | `bun test ./packages/mcp-server/src/store-lock.test.ts`; `bun test ./packages/mcp-server/src/redact-lock.test.ts` | ✅ (redact-lock from Phase 18) |
| SKILL-01 (proof) | D21-22 (a)-(f) over the wire | live-isolated (Docker) | `bun run rehearsal up --name p21 --skills-fixture && bun run smoke:skills-propose --name p21; bun run rehearsal down --name p21` | ❌ |

### Sampling Rate
- **Per task commit:** the touched test file(s), each run on its own.
- **Per wave merge:** `bun test && bunx tsc --noEmit`.
- **Phase gate:** full suite compared with the base (D21-23), `bun run check:phase-close` exit 0, the harness proof chain, then `docker ps -a --filter label=substrate.rehearsal=p21` empty and the run dir gone.

### Wave 0 Gaps
- [ ] `packages/mcp-server/src/skills/propose.test.ts` — port (runtime-assembled JWT; new library/env/missing-mirror/commit-message cases)
- [ ] `packages/mcp-server/src/skills/propose.git.test.ts` — engine vs real git (uses the fixture builder)
- [ ] `packages/mcp-server/src/config.test.ts` — skills block (no config test file exists today; loadConfig is tested in authority.test.ts)
- [ ] `packages/mcp-server/src/rehearsal-skills.test.ts` — fixture builder + fake gh
- [ ] `packages/cli/src/skills.test.ts` — readSkillDir, cap, flags, exit codes, one spawn against a stub server
- [ ] `scripts/skills-propose-smoke.test.ts` — pure helpers
- [ ] New describes in `server.test.ts`, `mcp.test.ts`, `service.test.ts`, `observe.test.ts`, `policy.test.ts`, `event-sources.test.ts`, `rehearsal-env.test.ts`, `scripts/rehearsal.test.ts`
- Framework install: none.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Bearer surface token → `surfaceForToken` (config.ts:221-224); anonymous always refused (D21-02) |
| V3 Session Management | no | Stateless HTTP/MCP |
| V4 Access Control | yes | Token surface only (D21-03); `isOperator` for `replace`/`reopen`/`allow_doc_examples` (D21-05); swarm never operator (config.ts:241-247) |
| V5 Input Validation | yes | zod schema (tool), `proposeBodyProblem` (route), `validateProposal` (name regex `^[a-z0-9][a-z0-9-]{0,63}$`, path rules, frontmatter, NUL, cap) |
| V6 Cryptography | no new | sha256 content hash only (node:crypto) |
| V7 Logging | yes | Fail-closed audit (`auditedRest`/MCP gate; record keeps arg keys + digest, never values — packages/audit/src/record.ts:163-193); events via `normalizeEvent` redaction |
| V12 Files/Resources | yes | `confined`/`writeTree` (no `..`, no symlink traversal, only `<clone>/<name>/`); state dir 0700, ledger 0600 |
| V14 Configuration | yes | `file://` rule for non-default library; child env allowlist |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Secret published in a public/private PR | Information disclosure | `scanSkillFiles` findings refuse; contextual values redacted; findings and PR body name `file:line rule` only |
| Path traversal / symlink write outside the skill | Tampering | `pathProblem` + `confined` + replace-mode only inside `<name>/` |
| Forged attribution (body `surface`) | Spoofing | Token surface only; mismatch 403, audited |
| Force-push / branch deletion on the library | Tampering | No force flag or colon refspec in any argv (pinned); fresh branch per proposal; harness bare repo denies non-FF and deletes |
| Credential misuse against another repo | Elevation | Configured slug in origin and PR-URL checks; `file://` rule; recommended non-default `gh` guard (Pitfall 5) |
| Option/argument injection into git/gh | Tampering | `execFile` argv (no shell); `git add -- <name>`; branch starts `skill/`; title starts `skill(` |
| Env leakage to children (store URLs, tokens, handoff key) | Information disclosure | D21-15 allowlist |
| Unaudited publication | Repudiation | `skills_propose` fail-closed in `policy.ts`; 503 on audit refusal |
| Proposal spam / review-queue flooding | DoS | 1 MB cap, locks, 120 s timeouts; rate limit deferred (CONTEXT) |
| Secret echoed in error output | Information disclosure | `tail()` redacts and keeps ≤ 400 chars; route slices `redact(message)` to 400 |

## Sources

### Primary (HIGH confidence)
- `git show acc30a8:` `packages/mcp-server/src/skills/{propose,frontmatter,propose-auth,propose.test}.ts`, `service.ts:1-60,150-200`, `mcp.ts:130-180`, `server.ts:20-85,150-215`, `server.test.ts:105-245`, `service.test.ts:940-1010`, `mcp.test.ts:150-215`, `cli/src/index.ts:1-40,195-350`, `redact.ts:100-290`, `.planning/phases/04-skills/04-02-SMOKE.md:34-39`
- Main worktree: `packages/mcp-server/src/{server,mcp,service,config,observe,redact,types,event,index,store-lock.test,server.test,http.test,mcp.test}.ts`, `packages/audit/src/{policy,policy.test,record}.ts`, `packages/cli/src/{index,args,lessons}.ts`, `infra/vps/substrate-mcp.service`, `docs/mcp-audit.md`, `AGENTS.md`, `.planning/{REQUIREMENTS,ROADMAP,STATE}.md`, `21-CONTEXT.md`
- Phase 16 worktree: `scripts/rehearsal.ts`, `packages/mcp-server/src/{rehearsal-env,rehearsal-env.test,store-lock.test}.ts`, `docs/rehearsal.md`, `package.json` diff, `tsconfig.json`
- Probes this session: git 2.43 fixture flow (§5); `Bun.YAML` behaviour; Bun `node:http` 13 s request; host `/var/lib/substrate/skills` listing and ledger key shapes; mount options; Docker images; global git config keys

### Secondary (MEDIUM confidence)
- Phase 17 plans (`17-CONTEXT.md`, `17-01/02/03-PLAN.md`, `17-RESEARCH.md`) and Phase 18 plans (`18-CONTEXT.md`, `18-02/03-PLAN.md`, `18-PATTERNS.md`, `18-RESEARCH.md`) — committed but under revision

### Tertiary (LOW confidence)
- Assumptions A1-A5

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — nothing new; versions read from the machine and lockfile.
- Architecture / port map: HIGH — both sides read with line numbers.
- Phase 17/18 contracts: MEDIUM — from committed plans that are being revised.
- Git mechanics: HIGH — probed.
- Pitfalls: HIGH for code-derived items, MEDIUM where tagged `[ASSUMED]`.

**Research date:** 2026-10-08
**Valid until:** 2026-10-15 (re-check Phase 17/18 final plans and the execution base before planning waves)
