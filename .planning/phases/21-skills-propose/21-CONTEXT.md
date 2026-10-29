# Phase 21: skills_propose - Context

**Gathered:** 2026-10-08
**Status:** Ready for planning
**Mode:** Smart discuss, auto-accepted under the v1.3 run rules (`.planning/STATE.md`, "v1.3 decisions"). Three recommended answers change a user-visible contract relative to September's `acc30a8`; the plan uses them, and they are listed for the operator under "Open for the operator".

<domain>
## Phase Boundary

One PR on agent-substrate (SKILL-01). Any token-authenticated surface can propose a skill and get a reviewable branch and PR on `swcstudiospace/agent-skills`; nothing secret, malformed or duplicate gets through.

1. **One git path, three doors.** `Substrate.proposeSkill` is the only code that touches git or `gh`. The MCP tool `skills_propose`, the route `POST /skills/propose` and the CLI `substrate skills propose` all end there.
2. **Port, not merge.** `packages/mcp-server/src/skills/{propose,frontmatter}.ts` and `propose.test.ts` come from `acc30a8` (`git show acc30a8:<path>`), onto main's v1.2 surface-token model. `propose-auth.ts` (the `x-substrate-propose-key` header) is not ported.
3. **Guards come from earlier phases.**
   - Redaction and the secret scan: Phase 18's `redact.ts` (`redactSkillContent`, `scanSkillFiles`).
   - The event mapping: Phase 17's `EVENT_SOURCES` rows for `skills_propose`.
   - The fail-closed audit entry: Phase 17's `policy.ts`.
4. **Registered everywhere a tool must be:**
   - `mcp.ts` `registerTool`;
   - `observe.ts` `KNOWN_TOOLS` and `KNOWN_ROUTES`;
   - `server.ts` `auditedRest` under the tool's own name;
   - `policy.ts` `FAIL_CLOSED_TOOLS`.

**Proof (isolated, no live system):** the unit tests, and one smoke run against the Phase 16 harness. The harness server gets an injected `gh`, real `git` and a throwaway repository in the run directory. The first real PR on agent-skills is Phase 22's live proof (SKILL-07).

**Out of scope:**
- The skills sync, the Hermes bridge, the miners and the Omp/Grok queues (Phase 22).
- Production surface tokens (Phase 20).
- Restarting production onto this code.
- Provisioning the production mirror. `/var/lib/substrate/skills/mirror.git` already exists on the host, from September's 04-02.
- Any new `EVENT_KINDS` or `SURFACES` entry (Phase 17 lock).
- New redaction rules (Phase 18 owns `redact.ts`).

**Depends on code not yet on `main`:**
- Phase 16: `scripts/rehearsal.ts` and `packages/mcp-server/src/rehearsal-env.ts`, extended here.
- Phase 17: `event-sources.ts`, `policy.ts` entries and `docs/event-vocabulary.md`.
- Phase 18: the skill engine in `redact.ts` and `redact-lock.test.ts`.
Execution starts from a base that holds all three.

</domain>

<decisions>
## Implementation Decisions

### Authentication and attribution
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

### Entry points and wire contract
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

### The git and `gh` path (port fidelity)
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
  - A non-default repository or remote is accepted only when the remote is a local `file://` path *and* `SUBSTRATE_SKILLS_GH` is an absolute path to a non-default `gh`, so a typo can never send the real `gh` and the owner's credential at another repository (research Pitfall 5).
  - **An invalid combination does not crash the server** (research Pitfall 4: a throw in `loadConfig` would crash-loop briefs and claims under `Restart=always`). `configWarnings` reports it at boot on the existing `misconfigured —` channel, and every proposal is refused with a `ProposeFailed` naming the bad key until it is fixed. No proposal ever runs with an invalid combination.
  - The origin check, the PR-URL check and the event's `repo` all use the configured slug.
- **D21-14: State and ledger compatibility.** The default state dir and the ledger format (`proposals.jsonl` lines `{ts, content_sha256, name, surface, branch, state, pr_url?, pr_number?}`) stay September's, so the host's existing ledger keeps deduplicating content proposed in September.
  - A missing `mirror.git` is a `ProposeFailed` that names the missing mirror and the 04-02 bootstrap command. The server does not create it.
- **D21-15: The child environment for `git` and `gh` is an allowlist, not `process.env`.**
  - The four base keys: `PATH`, `HOME`, `GIT_TERMINAL_PROMPT=0` and `GH_PROMPT_DISABLED=1`.
  - Plus seven controlled fixed Git values (user-selected "Keep current Git isolation", 2026-10-11): `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_SYSTEM=/dev/null` so a hostile host gitconfig (including `url.*.insteadOf`) stays unread, and a two-entry `GIT_CONFIG_COUNT` selecting the `gh` credential helper for GitHub HTTPS. These are fixed hardening values, never forwarded parent secrets.
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

### Events, audit and registration
- **D21-17: Events follow Phase 17's `EVENT_SOURCES` rows, emitted fail-open.**
  - An outcome is a `note`:
    - surface: the caller's;
    - `repo`: the configured slug;
    - payload: `action: "skill.propose"`, `name`, `status`, `pr_url`, `content_sha256`, `redactions` (a count).
  - A `ProposeRefused` is a `warning`:
    - payload: `action: "skill.propose"`, `status: "refused"`, `name` if valid, the `reason`, and `rules` (rule names only, never a value or a span).
  - A `ProposeFailed` is a `warning` with `status: "failed"` and the redacted reason.
    - It gets its own `EVENT_SOURCES` row (`skills.propose.failed`) beside Phase 17's `skills.propose` and `skills.propose.refused`, because the document's table has no status column. `docs/event-vocabulary.md` and `EVENT_SOURCES` change in the same PR, as Phase 17 requires for any change to the table. If the base already models statuses another way, follow the base.
  - These emit no event:
    - `dry_run`;
    - anonymous calls (no surface to attribute);
    - 403 attribution refusals and malformed bodies (400 from the shape check, before the engine). The audit chain records those.
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

### Proof
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
    - (d) No token gives 401 on `/skills/propose` and on `/mcp`, from the server's token gate. A body surface naming another surface gives 403, and an operator-only option sent with a non-operator token from `tokens/<surface>` gives 403. `consumer.env`'s `SUBSTRATE_TOKEN` is the operator's. The in-route and in-tool refusals of `surface === null` are reachable only on an anonymous run, so unit tests prove them.
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

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `acc30a8:packages/mcp-server/src/skills/propose.ts` (640 lines), `frontmatter.ts` (20, `Bun.YAML`), `propose.test.ts` (583, about 35 tests over validation, `writeTree`, argv pins, ledger idempotence, locks and PR text).
- `acc30a8` `service.ts:171-190` (`proposeSkill` plus the event), `mcp.ts:143-175` (tool), `server.ts:63-80,156-210` (`proposeBodyProblem`, route, error mapping), `cli/src/index.ts:207-345` (`readSkillDir`, `cmdSkillsPropose`, `cmdSkills`).
- Main `server.ts`: `auditedRest`, `surfaceForToken`, `isOperator`, `McpCaller`, `readBody` (1 MB cap, generic error), `sendJson`. The 401 for a configured deployment runs before any route; `allowAnonymous` lets a tokenless run through, so the route refuses `surface === null` itself.
- Main `mcp.ts`: `createMcpServer(substrate, caller)` with `callerSurface` and `isOperator`; `refusal()`, `json()`, `surfaceSchema`.
- Main `config.ts`: `loadConfig(env)`, `tokenEnvName`, `isOperator`, `configWarnings`.
- Main `cli/src/index.ts`: `post()`, `headers()` (`SUBSTRATE_TOKEN`), `parseArgs`/`str`/`list` in `args.ts`; `lessons.ts` already imports from `../../mcp-server/src/redact.ts`, so the CLI may import mcp-server modules.
- Phase 16 (`agent-substrate-v13-phase` worktree): `buildRehearsalEnv` (allowlist: `PATH`, `HOME`, `BUN_*` plus scratch keys), `consumerEnvRecord`, run dir layout, `--name`/`--surfaces`/`--operator` flags in `scripts/rehearsal.ts`.
- Host state already present: `/var/lib/substrate/skills/{mirror.git,proposals.jsonl,locks/,propose/,propose.key}` from September; `git` 2.43, `gh` 2.45 installed.

### Established Patterns
- Tests colocated as `*.test.ts`, run with Bun; repo checks as lock tests (`store-lock`, Phase 18 `redact-lock`).
- Refusals record rule names and hashes, never values (`auditMemoryWrite`; Phase 17 rule).
- REST twins are audited under the tool's own name (`/memory` → `memory_write`).
- Side-effect events never fail the action (September `proposeSkill`; main `emit` returns `stored`).
- Production runner pattern: pure argv builders plus an injected `Runner` (September `hostfns.ts` shape).

### Integration Points
- New: `packages/mcp-server/src/skills/{propose,frontmatter}.ts` and tests; `scripts/skills-propose-smoke.ts`; `docs/skills-propose.md`.
- Edited: `service.ts`, `mcp.ts`, `server.ts`, `observe.ts`, `config.ts`, `packages/audit/src/policy.ts` (only if Phase 17's entry is absent), `event-sources.ts` and `docs/event-vocabulary.md` (the `failed` status), `packages/cli/src/index.ts`, Phase 16's `rehearsal-env.ts` and `scripts/rehearsal.ts`, `package.json` (`smoke:skills-propose`), `docs/mcp-audit.md`, `docs/rehearsal.md`, and the existing tests for `mcp`, `server`, `observe`, `config` and `policy`.

</code_context>

<specifics>
## Specific Ideas

- The phase is "the route before its clients": Phase 22's bridge, miners and the Omp `manage_skill` interception all call this route with a surface token, so the wire contract here (D21-07 to D21-11) is what they code against.
- Results never name a value. Findings carry file, line and rule. The PR body lists redacted spans as `file:line rule`.
- The owner's merge is the only publication step; nothing here writes `/root/agent-skills`.

</specifics>

<deferred>
## Deferred Ideas

- Skill exports over 1 MB, which September's in-process CLI allowed up to 64 MB. They would need a chunked or file-reference upload; no v1.3 requirement asks for it.
- Removing `/var/lib/substrate/skills/propose.key` and any host client still sending `x-substrate-propose-key`: this is Phase 22's cutover of the bridge onto surface tokens.
- A per-surface allowlist or rate limit for proposals, if the owner's review queue gets noisy.
- Mirror bootstrap as a command (`substrate skills init`): the host mirror exists today; a fresh host would follow September's 04-02 bootstrap by hand.

</deferred>

## Open for the operator

**Answered 2026-10-08: the operator accepted all three below as written.** They are locked decisions, not open questions. The record follows.

1. **The propose key is dropped (D21-01).**
   - Proposals authenticate with surface tokens only.
   - Host clients that used `x-substrate-propose-key` get 401 until Phase 22 moves them to a token.
   - Alternative: keep the header as a second credential for host processes.
2. **The CLI goes over HTTP with `SUBSTRATE_TOKEN`, with a 1 MB cap (D21-07, D21-08).**
   - It no longer proposes in-process, and the 64 MB CLI cap is dropped.
   - Alternative: keep an in-process CLI path for operators, which would have no token, no audit and its own event.
3. **`--replace`, `--reopen` and `--allow-doc-examples` need an operator token (D21-05).**
   - In September they were open to anyone who could run the CLI on the host.
   - Alternative: drop the three options from v1.3.
