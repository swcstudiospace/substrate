# ADR 0007: Checkpoint triggers and the hooks the sibling repositories would need

- **Status:** Accepted as a decision record and **proposal set**. The triggers are defined, every one has an entry point in this repository (the manual and rollback commands, plus `substrate session hook` for `turn`, `plan-step`, `steering` and `baseline`, with the rate limits below), and the printed host configuration (`substrate session hook-config`) is shipped. Every sibling hook below is still a **proposal written as text**: **no sibling repository was changed, no pull request was opened against one, and no hook was installed.** Installing a hook in a host is an operator step; firing one from omp, GSD-Core, Ultrathink or Swarm is outside this repository.
- **Date:** 2026-10-26
- **Tickets:** v1.6 phase 61, success criterion 3; phase 62, success criterion 2; decision D55-4 (edits stay in this repository)
- **Deciders:** Spectrum Web Co platform proposes; the owner of each sibling repository decides
- **Affects:** `packages/cli/src/session/{trigger-policy,hook,hook-config,command}.ts` (the entry points) and this record. Code references: `packages/mcp-server/src/session-events.ts`, `packages/cli/src/session/*`, `packages/collectors/src/{cursor-stop,transcript-ref,muse}.ts`, `packages/projector/src/{cursor,muse}.ts`

## Context

A rollback can only return to a checkpoint that exists. The CLI can take a checkpoint (`substrate session checkpoint`, ADR 0005) but, before the hook entry points below, nothing decided **when**. The defined boundaries are `turn`, `plan-step`, `steering`, `manual`, `pre-restore`, `baseline` (`CHECKPOINT_TRIGGERS`, `session-events.ts`). This record states what is wired and writes the proposals so each sibling owner can accept, change or refuse them.

## What is wired in this repository today

| Trigger | Meaning | Entry point here | Limit |
| --- | --- | --- | --- |
| `manual` | an operator or agent asks | `substrate session checkpoint` (the default `--trigger`) | none: always taken |
| `pre-restore` | the state a rollback is about to replace | `substrate session rollback` takes it itself before any file changes | none: always taken |
| `baseline` | the first checkpoint of a session that predates the feature, so it cannot be rolled back before it (D55-3) | `substrate session hook baseline` | only while the session has no checkpoint |
| `turn` | a turn ended | `substrate session hook turn` | at most one per 60 s (`TURN_MIN_INTERVAL_MS`); skipped when the tree is unchanged |
| `plan-step` | a plan step or lane boundary completed | `substrate session hook plan-step [--plan-phase P] [--plan-step S]` (each reference at most 64 characters) | at most one per 10 s (`PLAN_STEP_MIN_INTERVAL_MS`); skipped when the tree is unchanged |
| `steering` | a steering directive was applied | `substrate session hook steering` with `directive_id` in the stdin envelope | one per directive id, otherwise unlimited; skipped when the tree is unchanged |

An entry point is not a caller. Nothing in this repository fires `hook` by itself: a host has to run it (next section). The server side of the steering join (next paragraph) tells the acknowledging session when a checkpoint is due; it never runs the hook.

**The steering checkpoint hint.** When an applied `pause` or `redirect` acknowledgement actually moves the live session (to `PAUSED` or `CONTEXT_REFRESH`), the `steering_acknowledge` reply carries `checkpoint_hint: { "trigger": "steering", "directive_id": "<id>" }`, and only when the state actually changed. It is a hint and no ledger event: the server stays read-only on worktrees (ADR 0005), so the checkpoint itself is the session's own run, from its worktree, of `substrate session hook steering` (with the hinted `directive_id` in the envelope) or `substrate session checkpoint --trigger steering`. A refused transition (for example a redirect for a `PAUSED` session), a session the server does not hold, and a request for the state the session already holds (a pause for a `PAUSED` session, a redirect for a `CONTEXT_REFRESH` session: `session_state` reads `unchanged`, and no `docs.steering` note is recorded) carry no hint; the acknowledgement stands in every case. The join is by session id: a directive's `targetSessionId` must be the id the session passes to `docs_steering_session`, held under whichever surface wrote it; two surfaces holding the same id is refused as `ambiguous`.

## The checkpoint hook (`substrate session hook`)

`substrate session hook <turn|plan-step|steering|baseline> [--session ID] [--surface S] [--plan-phase P] [--plan-step S] [--verbose]` reads a JSON envelope on stdin (Claude Code's hook fields `session_id`, `cwd`, `transcript_path`; for `steering` an optional `directive_id`), asks `trigger-policy.ts` whether a checkpoint is due, and if so takes it with the same code as `session checkpoint`.

- **Policy, in order.** `manual` and `pre-restore` are always taken. `baseline` only while the session has no checkpoint. A `steering` directive that already has a checkpoint is skipped (the directive is recorded as `plan_ref.step = directive:<id>`, hashed as `directive:h.<16 hex>` when the id is too long for the 64-character limit). `turn` and `plan-step` are skipped inside their interval, measured from the last checkpoint **with the same trigger** (a manual checkpoint does not suppress a turn one). Any automatic trigger is skipped when the worktree's tree id equals the session's newest checkpoint's. The limits are conservative defaults chosen from the cost reasoning below, not measurements.
- **Cost.** A checkpoint hashes the whole worktree. The hook evaluates the cheap rules (baseline, directive, rate limit) first, on an unlocked list of the local checkpoints; only a call that passes them takes a snapshot, and it takes exactly one: `createCheckpoint` hashes the worktree once and re-runs the whole policy (including the unchanged-tree rule, using that snapshot's tree id) under the checkpoint lock before pinning. A busy session therefore pays at most one tree hash per call that passes the cheap rules, and none for a call they decline. Because the policy decision, the sequence number and the pin are made under one lock, two hooks started together cannot both pass the rate limit on the same history.
- **Session id.** `--session`, else the envelope's `session_id`, else the one session that has local checkpoints in the worktree (the rule `session checkpoint` already uses). No environment variable names a session and none was added; with none or several known sessions the hook takes nothing. The id must be the string the surface uses for its memory writes (below).
- **Worktree.** The envelope's `cwd`, when it is an absolute path inside a git worktree, else the worktree the command runs in. `transcript_path` is accepted and ignored: it is a Claude Code transcript, not an omp session file, so no transcript reference is recorded.
- **Fail-open, by contract.** Every error path (malformed or empty stdin, a missing or invalid session id, a `cwd` that is not a git worktree, a server error, a misspelled flag or trigger, the 10 s overall timeout `HOOK_TIMEOUT_MS`) exits 0 with nothing on stdout; `--verbose` adds one stderr line. A Claude Code hook that exits 2 blocks the turn from ending, so even a usage error exits 0. A server that is down does not fail the hook: the local checkpoint stands and the ledger record is journaled for `substrate session sync`. The journal record is written before the server request (write-ahead) and removed when the server accepts the record, so a hook that ends at its 10 s deadline while the request is still in flight leaves the record behind for `sync` rather than a pinned checkpoint nobody will report.
- **Printed host configuration.** One target per trigger: `substrate session hook-config claude-code` prints the `Stop` hook settings (JSON) for `turn`, and `git-post-commit` prints a post-commit script body that runs the `plan-step` hook in the background. `steering` and `baseline` print a script body with the exact command (`substrate session hook steering --session "$SESSION_ID" --surface "$SURFACE"` with the directive id piped in as the envelope; `substrate session hook baseline --session "$SESSION_ID" --surface "$SURFACE"`), run in the foreground and fail-open (`|| true`) so the checkpoint reflects the tree as it stood at the start or at the directive rather than later edits, and a comment naming the event the operator must wire it to: this record maps no host event to either, so the text invents none (for `baseline` it only names the proposals below, omp's `session_start` and a Swarm lane start). All four only print; none writes a file or edits a setting.

## The hook contract every proposal shares

- **Command.** A host that can pipe a JSON envelope runs `substrate session hook <turn|plan-step|steering|baseline> --surface <surface>` (above). A host that cannot, or that wants a transcript reference, runs `substrate session checkpoint --session <the session id the surface uses for its memory writes> --surface <surface> --trigger <t> [--plan-phase P --plan-step S] [--omp-session FILE | --transcript-ref JSON]`, which has no rate limit and must be given `--session`. Both work from the worktree they are run in; no environment variable names a session (`packages/cli/src/session/command.ts`).
- **The session id must be the string the writer used.** A rollback forgets the memory *this surface* wrote *in this session* after the checkpoint (ADR 0005). A hook that passes a different spelling of the session id than the memory writes carry would forget nothing.
- **Fail-open, never blocking the turn.** `session hook` is fail-open itself (always exit 0, empty stdout, 10 s overall timeout). `session checkpoint` is not: run it detached or under a short timeout, ignore its exit status (0 done, 1 failed, 2 usage, 3 refused), discard stdout, and never put it inside a path whose failure blocks the agent. With the server unreachable both still take the local checkpoint and queue the ledger record in the pending journal (`substrate session sync` delivers it). Idempotent by checkpoint id.
- **No new kind, surface or trigger.** A checkpoint is an existing `note`; the 12 kinds, 42 surfaces and 6 triggers do not change. A sibling-specific trigger would be a contract change in `session-events.ts` and is not proposed.
- **Cost is unmeasured.** The snapshot hashes the worktree; its cost on a large worktree per turn has not been measured by this work (UNVERIFIED). `session hook` therefore rate-limits (`turn` one a minute, `plan-step` one every ten seconds) and skips a tree identical to the newest checkpoint's; `session checkpoint` does neither. The limits are defaults to revisit once the cost is measured.
- **Surfaces are the token's.** There is no per-sibling surface to add. A hook uses the surface whose token it holds (`SUBSTRATE_TOKEN` or the per-surface token file, `packages/cli/src/token.ts`).

## Proposals

Each: the event, the command, the failure behaviour, the owner, the risk.

### omp

- **Event.** The omp extension's `agent_end` (a turn finished); `session_start` for a `baseline`. These event names are the ones `claude-ultrathink`'s `src/host/omp.ts` and `agent-realm`'s `src/omp/plugin.ts` already subscribe to.
- **Command.** `substrate session checkpoint --surface omp --trigger turn --session <omp session id> --omp-session <session file>` (records the entry id, turn number and prefix digest, never content or the path).
- **Failure.** Detached; skipped silently; a file that cannot be read yields a checkpoint without a transcript pointer, said in the output.
- **Owner.** omp or an extension of it. The extension source is not in this repository and its location was not found (UNVERIFIED).
- **Risk.** The hook must run after omp has written the entry it points at, or the prefix digest will not match later. omp has no substrate MCP server (`docs/omp-substrate-status.md`, as written), so the CLI, not an MCP tool, is the only route from omp. Resuming a forked file is UNVERIFIED (ADR 0005).

### GSD-Core (phase and plan-step boundaries)

- **Event.** After a plan task's commit (the `<task_commit>` boundary in the installed `execute-plan` workflow) and at a phase transition.
- **Command.** `substrate session checkpoint --trigger plan-step --plan-phase <phase> --plan-step <plan>-<task>` from the agent running the workflow, `|| true`.
- **Failure.** Never stops the workflow; a missing CLI or server is ignored.
- **Owner.** GSD-Core. Only an installed copy (version 1.18.0 under the user's agents directory) was found; its upstream repository was not located (UNVERIFIED).
- **Risk.** Workflows are markdown followed by a model, so a step is not guaranteed to run; a host hook is more reliable than a prompt line. **Name collision:** GSD-Core already says "checkpoint" for checkpoint plans and `[checkpoint]` heartbeats, and phase 53 (merged, PR #136) uses "plan-step checkpoint" for a resume record keyed by file hash. Neither is a session checkpoint.

### Ultrathink (plan node boundaries)

- **Event.** The Stop hook (`hooks/stop.ts`, timeout 60 s, silent and fail-open) for `turn`; a node completing in the session record for `plan-step`.
- **Command.** A detached spawn of the CLI, the same way the hook already detaches `teach observe` (`spawnObserveDetached`), with `--plan-step <node id>`.
- **Failure.** Fail-open, as every Ultrathink substrate call is.
- **Owner.** `claude-ultrathink`.
- **Risk.** Ultrathink emits events with the session id `${hostSession}:${graphId}` (`src/claude/hook.ts`); the checkpoint session id must match whatever the memory writes of that session carry, otherwise rollback forgets nothing. Its `surface` defaults to `claude-code`.

### Swarm (lane start, lane end, before a merge)

- **Event.** Lane start (after its worktree and branch exist) as `baseline`; lane end (task node completed, before the lease is released) as `plan-step`; before a merge of a lane branch as `plan-step` with `--plan-step pre-merge`.
- **Command.** Run **by the controller (A01 or the operator), in the lane's worktree**, with that lane agent's own surface token and the session id `<AGENT>@<replica>:<graph_id>` (`swarm/substrate_tee.py`), not by the lane.
- **Failure.** Fail-open, matching `swarm/substrate_client.py` (every call optional and fail-open).
- **Owner.** `agent-swarm`.
- **Risk, two verified facts.** (1) The lane guard blocks `git checkout|restore` and their destructive forms inside swarm sessions (`omp/src/guard.ts`), so a rollback must run in the controller. Whether the guard's other rules would also refuse the `substrate` CLI inside a lane is UNVERIFIED. (2) The guard's allowlist of substrate MCP tools (`SUBSTRATE_TOOL`, `omp/src/guard.ts` line 98) names `memory_{brief,write,search,pending}`, `events_{emit,query,verify}`, `graph_*` and `coord_*` only. **`session_checkpoint`, `session_rollback_plan`, `session_rollback_commit`, `checkpoint_verify` and `memory_verify` are not on it**, so a lane agent calling them is blocked (`needs: human-approval`). Adding them is a change in `agent-swarm`, and is proposed only if the owner wants lane agents to call them; the controller route does not need it.

### Realm (before and after a governed action)

- **Event.** The host-side `tool_call` handler of `src/omp/plugin.ts` for "before"; the result phase of `src/tools/dispatch.ts` (where Realm already appends its audit line) for "after".
- **Command.** `substrate session checkpoint --trigger turn` against the workspace the plugin bound (`ctx.cwd`), detached.
- **Failure.** **Must not sit in the verdict path.** The host fails closed on a `tool_call` handler error or timeout (`plugin.ts` header), so a slow checkpoint inside it would block a tool. Spawn it detached or give it a budget well below `toolCallTimeoutMs`.
- **Owner.** `agent-realm`.
- **Risk.** Realm does not call Substrate at all today (its spec says "Realm provides seams only", `docs/specs/realm-spec.xml` line 176, in the `agent-realm` repository), has no surface of its own (none can be added: `SURFACES` is locked at 42) and no snapshot primitive (`StopSandbox` and `StartSandbox` are refused, `docs/integration/openshell.md`, PD-08). Whether the CLI can see the sandbox's files from the host is UNVERIFIED. Realm's mutation gate (`src/lifecycle/mutation-gate.ts`) is a single choke point for writes, so a pre-image capture there is an alternative that needs no checkpoint at all (UNVERIFIED how it behaves).
- **Realm's own devnet anchor and Substrate's hourly roots.** They are **complementary evidence with no shared mechanism**. Realm's `src/audit/anchor.ts` anchors one session's audit-log Merkle root (record: session id, line count, root, time; never content) as its own memo under its own key (`REALM_ANCHOR_KEY_FILE`), published by `realm anchor --publish` (dry-run by default). Substrate anchors one root per closed hour over the ledger's event hashes with memo v1. Neither reads the other, and Realm's record is not a `substrate:v1:` memo. **No change is proposed to either mechanism.** The one gap the scout report shows is that Realm's governed actions never enter the Substrate ledger; closing it would mean Realm emitting a `note` that carries its record's root and transaction signature (so the hourly root covers the pointer), which is a Realm change and a choice of surface that belongs to its owner.

### muse

- **Event.** None usable. The hook this repository projects is **PostToolUse only** (`packages/projector/src/muse.ts`, `docs/collectors.md` "Muse tool hook"); there is no Stop or turn event.
- **Proposal.** Do not checkpoint per tool call. Until Muse offers a turn-end event, take `manual` or `baseline` checkpoints explicitly. A checkpoint's transcript reference is always null for Muse (`transcript-ref.ts`, `no-turn-id`), so a rollback restores files and leaves a marker.
- **Owner.** Muse (the host); the hook generator is in this repository.

### cursor

- **Event.** The stop hook this repository already generates (`packages/collectors/src/cursor-stop.ts`, written into `hooks.json` by `packages/projector/src/cursor.ts`, stdout and stderr discarded, failure ignored). Whether it fires per turn or per conversation is UNVERIFIED.
- **Command.** A second hook command: `substrate session checkpoint --surface cursor --trigger turn --session <conversation id> --transcript-ref '{"surface":"cursor","session_locator":"<conversation id>","turn_no":<n>}'`.
- **Failure.** Already fail-open by construction of the projector's command.
- **Owner.** This repository (collectors and projector): a code change, **not made here**.
- **Risk.** Cursor exposes no verifiable per-turn id; `turn_no` is a counter the hook must keep (`transcript-ref.ts`). The working directory the hook runs in is UNVERIFIED.

### claude-code

- **Event.** A Claude Code `Stop` hook (its input carries `session_id`, `cwd` and `transcript_path`, as `claude-ultrathink`'s `hooks/stop.ts` reads them).
- **Command.** `substrate session hook turn`, run by the `Stop` hook printed by `substrate session hook-config claude-code`. The hook reads `session_id` and `cwd` from Claude Code's envelope; no `--session` is needed. No transcript reference is recorded.
- **Failure.** Fail-open by contract (always exit 0); the printed settings give Claude Code a timeout above the hook's own 10 s budget.
- **Owner.** The user's Claude Code configuration, or the Ultrathink plugin (the hook above). This repository installs no Claude Code hook (its only per-repo hook is the git post-commit collector, `packages/collectors/src/install-git-hook.ts`).
- **Risk.** Claude Code's transcript layout and per-message ids are UNVERIFIED on this host, so rollback is `unsupported` or `marker-only` for the transcript; files are still restored.

## Explicit statements

- **No sibling repository was changed.** Nothing was written in `agent-realm`, `agent-swarm`, `claude-ultrathink`, GSD-Core, omp, Muse or Cursor; the sibling files named above were only read.
- **No hook is installed by this repository.** `hook-config` prints text; an operator copies it into a Claude Code settings file, `.git/hooks/post-commit`, or the host's own handler. Firing the hook from omp, GSD-Core (phase and plan-step boundaries), Ultrathink (plan nodes), Swarm (lane boundaries) or a steering-delivery host is outside this repository: each of those hosts has to run `substrate session hook ...` itself, under its owner's review. No Claude Code event is mapped to `steering` or `baseline` here, so their printed text names the command and the event to wire it to rather than a ready host configuration; a host that applies a directive pipes `{"session_id": "...", "directive_id": "..."}` to `substrate session hook steering`.
- **No pull request was opened** and none is proposed to be opened by this milestone. D55-4: hooks needed by sibling plugins are documented proposals in this repository.
- Accepting a proposal is the sibling owner's decision, under that repository's own review and gates.

## Consequences

- A session has checkpoints where an operator or agent ran a command, plus the `pre-restore` ones rollbacks create, plus whatever a host that an operator configured fires through `session hook`. `substrate session checkpoints` shows what exists; an operator must not assume a boundary has one until a host is configured and the checkpoint is listed.
- The proposals add no event kind, surface, trigger, table, environment variable or dependency to this repository.

## References

- ADR 0005 (rollback semantics), `docs/runbooks/session-rollback.md`, `docs/ussr-integration.md`
- Scout report on the sibling repositories (`/tmp/recon/R9.txt`) and the rollback inputs (`/tmp/recon/R7.txt`); both are working notes, not repository files
