# Phase 1: Lane B - Research

**Researched:** 2026-09-24
**Domain:** Cross-agent hook/plugin wiring on a live VPS — Python (Hermes), TypeScript (ultrathink family), Rust (Grok Build), compiled binary (Muse), FastMCP (connectors)
**Confidence:** MEDIUM — every running surface was probed directly on disk; the biggest unknown is that the phase's own premise ("Hermes redesign per its own `.planning/PROJECT.md`") points at a document that does not contain that redesign. See Finding 1.

## Summary

This phase wires five agent surfaces (Hermes, Omp, Muse Code, Grok Build, Grok Bot) into the
Phase-0 substrate (`substrate-mcp` on `127.0.0.1:7410`, live). All five integration points were
probed directly against what is installed and running, not inferred from the Notion plan or
from STATE.md's prior claims — several of which turned out to be stale or wrong.

**The single most important finding** is that the phrase "Hermes redesign per its own
`.planning/PROJECT.md`" does not resolve the way the phase description implies. Hermes's own
`.planning/PROJECT.md` (`/root/src/repos/hermes-plugin/.planning/PROJECT.md`) is a **completed,
shipped milestone** (v0.3.0, "Grok 4.7 xhigh reasoning engine + GSD handoff") that has nothing to
do with a TypeScript engine, a brief, or Kanban retirement — its Out of Scope line explicitly
says "Kanban behaviour in hermes-plugin (unchanged; GSD writes are additive)." The actual
TypeScript-engine redesign the phase description is describing lives in a **different repo**,
discovered mid-research: a brand-new, unphased GSD milestone at
`/root/src/repos/claude-ultrathink-grok/.planning/PROJECT.md` ("Ultrathink on Hermes", v1.0,
status `planning`, 0 of N phases, still in "Requirements confirmation"). That milestone is
planned in a **separate git worktree** of `claude-ultrathink` (`milestone/v1.0-cross-runtime`)
specifically so it would not collide with the substrate's own Phase-0 work on the main checkout
(`feat/substrate-brief`). It targets the *same* Hermes hook, the *same* Kanban retirement, and a
materially overlapping "TypeScript engine bridge" — see Finding 1 for the coordination risk this
creates and the options for handling it.

Beyond that, every other Phase 1 target was found and characterized concretely: hermes-linear-
connector and hermes-engineering-board are running services with clear edit points;
omp-ultrathink has two credible edit points for "discovery tools" (a native-tool catalog and an
MCP discovery-call list) and is not yet wired to substrate-mcp at all; Grok Build's own
`claude-ultrathink-grok` fork already has a ported `src/substrate/brief.ts` (untested/unwired)
but carries a **documented, verified blocker**: Grok Build's `UserPromptSubmit` hook discards
stdout entirely, so the Claude-style `additionalContext` delivery path used by `fetchBrief` today
is a no-op there; Muse Code is a closed compiled binary with a plugin/hook system that has no
prompt-submission hook at all (confirmed from its own embedded strings), which is exactly why the
phase already specifies a static-file fallback rather than a live fetch; grok-hermes-connector is
already version-stamped `0.4.0` in code but forwards none of the four substrate tools yet; and
herdr, confirmed absent from this host, is a real open-source project (`herdrdev/herdr`) whose
`events.subscribe` API matches CONTEXT.md's description.

**Primary recommendation:** Before planning Hermes tasks, resolve the coordination question in
Finding 1 with the owner (or explicitly plan around it) — do not silently duplicate or silently
depend on the `claude-ultrathink-grok` v1.0 milestone. For every other surface, the concrete edit
points below are ready to plan against directly.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Brief injection into Hermes prompts | Hermes plugin (Python hook) | TypeScript engine (subprocess/HTTP bridge) | Hermes plugins load as Python only; the pre_llm_call hook is the only interception point, but per the `claude-ultrathink-grok` PROJECT.md decision, the reasoning/graph logic itself must stay in TypeScript, not be re-forked into Python |
| Hermes Kanban retirement | Hermes plugin (Python) | hermes-linear-connector (unaffected) | `hermes_kanban_create` is called directly from `prompt_uplift/hook.py`; removing it is a Python-only edit. The connector's Linear↔Hermes sync is a separate, already-correct system that must NOT be touched |
| eng-board auto-ingest retarget | hermes-engineering-board (Python hooks_session.py) | substrate-mcp (`events_emit` HTTP/MCP) | `on_start`/`on_tool`/`on_end` currently feed a local `work_unit_store`; retargeting to `events_emit` is additive at the hook boundary |
| Orca-vs-herdr runtime | herdr (new install) | Orca (existing, alongside as collector) | Already decided in CONTEXT.md; this phase's job is only to install herdr and stand up its `events.subscribe` collector, not re-litigate |
| omp-ultrathink brief discovery | omp-ultrathink (TS, Pi extension) | substrate-mcp (`memory_brief` / `/brief`) | `runAutonomousDiscovery`'s MCP `calls` array is the existing seam for adding a new MCP-backed discovery call |
| Grok Build brief fetch | claude-ultrathink-grok hook (`hooks/uplift.ts`) | substrate-mcp (`/brief`) | Blocked on the delivery-path problem in Finding 3 — the fetch itself is trivial (`brief.ts` exists), delivery into the model's context is not |
| Muse Code brief fallback | Filesystem (`.substrate/BRIEF.md`) | substrate collector (writer) | Muse's own plugin hook set has no prompt-submission event; a written file plus Muse's existing AGENTS.md/CLAUDE.md context-file reading is the only viable channel found |
| Grok Bot handoff events | grok-hermes-connector (`server.py`, `handoff_to_hermes`) | substrate-mcp (`events_emit`, `graph_get`) | Connector already owns the Grok↔Hermes trust boundary (OAuth, redaction); adding forwarding tools there is additive, not a new trust boundary |

## Findings (read before planning)

### Finding 1 — The "TypeScript engine" redesign lives in a different repo, mid-flight, in its own worktree

**What was checked:** `/root/src/repos/hermes-plugin/.planning/PROJECT.md`,
`ROADMAP.md`, `STATE.md`, `MILESTONES.md`, and git history for that path
`[VERIFIED: /root/src/repos/hermes-plugin/.planning/PROJECT.md, read in full this session]`.

**What it says:** the *current* milestone there (v0.3.0, shipped 2026-09-22) is "Prompt Uplift —
Grok 4.7 xhigh reasoning engine + GSD handoff." Its own text: `"Changing the Hermes core, shunt
source, or GSD core."` and `"Kanban behaviour in hermes-plugin (unchanged; GSD writes are
additive)."` are both listed under **Out of Scope**. There is no mention of a TypeScript engine,
a brief, or `events.emit` anywhere in that document.

**Where the actual redesign is:** `/root/src/repos/claude-ultrathink-grok/.planning/PROJECT.md`
`[VERIFIED: read in full this session]`. This directory is a **git worktree**
(`git -C /root/src/repos/claude-ultrathink-grok rev-parse --show-toplevel` resolves to
`/root/src/repos/claude-ultrathink/.git/worktrees/claude-ultrathink-grok`
`[VERIFIED: git worktree list ⇒ claude-ultrathink-grok 3766efd [milestone/v1.0-cross-runtime]]`)
of the same repo that Phase 0 already modified (`claude-ultrathink`, main checkout on
`feat/substrate-brief`). Its milestone, "Ultrathink on Hermes" v1.0, is at `status: planning`,
**0 of N phases**, "Requirements confirmation" — i.e. it has Active requirements but no ROADMAP
phases yet. Its stated goal, verbatim: *"One TypeScript ultrathink engine drives prompt uplift
across Claude Code, Grok Build, and Hermes... Hermes `pre_llm_call` bridge into the TypeScript
engine, injecting uplift XML and graph... Removal of the Python Kanban cards and the GSD
working-directory write."*

**Why this matters for planning:** this is the same hook (`hermes-plugin`'s `on_pre_llm_call`),
the same Kanban retirement, and an overlapping "bridge to TypeScript" concept that Phase 1 (Lane
B) also targets — but scoped around Notion/Linear tracking parity (kickoff/sync skill, blocking
HITL), not around the substrate brief/events. The two efforts are adjacent, not identical: Lane B
wants Hermes to fetch `/brief` and emit `events_emit`; the other milestone wants Hermes to get
uplift+GoT+Notion/Linear tracking from the TS engine. Both need a "Python hook calls into
TypeScript" bridge, and if built twice, independently, the second one to land will either fight
the first for the same hook registration or leave one implementation orphaned.

**Also relevant:** that other milestone documents its own **inherited red test baseline**: on its
worktree branch, `bun test` was 256 pass / 1 fail at PROJECT.md-write time, attributed to a
concurrent session's assertion bump (`3` → `15` sub-issues) landing before the corresponding
production fix. Verified live this session — see Finding 5 — both worktrees are still red.

**Recommendation for the planner:** treat this as an open coordination question, not a blocker to
silently route around. Options to put in front of the user via `/gsd-discuss-phase` follow-up or
as an explicit locked assumption in the plan:
1. Lane B's Hermes work proceeds independently (brief injection + events.emit only), leaving the
   Notion/Linear-tracking bridge to the other milestone — accept that both will eventually touch
   `on_pre_llm_call` and `hermes_kanban_create`/GSD-write removal, and sequence Lane B's edits to
   land second (rebase after) or coordinate on the same PR.
2. Lane B explicitly adopts the other milestone's planned TS-bridge mechanism (once it reaches a
   ROADMAP) and adds the substrate calls on top of it, rather than building a second Python→TS
   bridge from scratch.
3. Scope Lane B's Hermes success criteria down to what does NOT require touching
   `on_pre_llm_call`'s core structure (e.g., a `/brief` HTTP call injected additively, without
   waiting for the TS-engine bridge), deferring true Kanban retirement to the other milestone.

**Confidence:** HIGH that the discrepancy exists (both documents read in full this session).
LOW/`[ASSUMED]` on which of the three options the owner prefers — this needs a decision, not an
inference.

### Finding 2 — Hermes's live `pre_llm_call` hook, concretely

`[VERIFIED: /root/src/repos/hermes-plugin/__init__.py:222-260 and prompt_uplift/hook.py, read this
session]`. The plugin is loaded live via symlink
`/root/.hermes/plugins/prompt-uplift -> /root/src/repos/hermes-plugin` (confirmed with `ls -la`).
`on_pre_llm_call` (line 222) calls `handle_pre_llm_call` (`prompt_uplift/hook.py`), which:
- builds an uplift completer and (if `think_enabled`) a Graph-of-Thought completer via
  `build_completers` (routes to `shunt`/`grok-4.7-xhigh` per the v0.3.0 milestone),
- calls `hermes_kanban_create` from `prompt_uplift/kanban.py` when `issues_enabled` — this is the
  live Kanban card creation the phase wants retired,
- when `gsd_enabled`, calls `write_gsd_milestone` which writes `.planning/` into `Path.cwd()` —
  this is the "GSD working-directory write" the other milestone's PROJECT.md calls "the source of
  stray `.planning/` closeouts."

There is **no** brief-fetch, no HTTP call to `127.0.0.1:7410`, and no `events_emit` call anywhere
in `prompt_uplift/`'s Python source `[VERIFIED: grep for "brief"/"substrate" across
prompt_uplift/*.py and think/*.py returned zero matches]`. This confirms the brief-injection half
of the phase is genuinely unbuilt, not merely undocumented.

Both `__init__.py` (mode -rw-r--r--, owned root) and the plugin tree live under
`/root/src/repos/hermes-plugin`, which has **no own `.git`** — its git root is the enclosing
`/root/src/repos` superproject `[VERIFIED: git -C hermes-plugin rev-parse --show-toplevel ⇒
/root/src/repos]`. Any code commit here lands on that outer, very large, mixed-ownership
worktree — the same caveat the `claude-ultrathink-grok` PROJECT.md already documented
("Do not `git init` inside it").

**hermes-plugin test baseline (live, verified today):** `python3 -m pytest -q` → **234 passed**
(the v0.3.0 PROJECT.md recorded 227 at milestone close; drift is expected and fine — this is the
number to treat as green going into Phase 1).

### Finding 3 — hermes-linear-connector and hermes-engineering-board, concretely

Both run under systemd, confirmed independently owned git repos (own `.git`, not inside the
`/root/src/repos` superproject):

- `hermes-linear-api.service` and `hermes-linear-poller.service`, both `active running`
  `[VERIFIED: systemctl list-units]`, `ExecStart=/root/src/repos/hermes-linear-connector/.venv/
  bin/python -m hermes_linear_connector.{api_main,poller_main}`.
- Config at `config.example.yaml` confirms exactly the three behaviors the phase wants kept:
  `mirror_comments: true`, `require_dod_for_done: true` (enforced in `sync_engine.py`'s
  `mark_dod_pass`/status-transition guard, lines ~173-237), and `team_key: SPE`
  `[VERIFIED: config.example.yaml:5-29, quoted below]`:
  ```yaml
  linear:
    team_id: "c194ec01-01ec-4203-809f-37381a0392e1"
    team_key: SPE
  sync:
    db_path: ~/.hermes/linear-sync.db
    mirror_comments: true
    require_dod_for_done: true
  ```
  This is the DoD gate the phase says must be kept — it is real, live, and does not need
  reimplementing, only leaving alone.
- Test baseline (live, verified today): `.venv/bin/python -m pytest -q` → **49 passed, 2
  skipped**.

- `hermes-engineering-board`'s plugin (`plugin/hermes_eng_board/__init__.py`) registers
  `on_start`/`on_tool`/`on_end` `[VERIFIED: grep confirms these three functions at lines 32, 35,
  38]`, which delegate to `hooks_session.py`'s `handle_session_start` / `handle_tool_call` /
  `handle_finalize` — these currently write into a local `work_unit_store`
  (SQLite-backed, per `session_snapshot.py`/`work_unit_store.py`), which `pipeline.py`'s
  `run_session_pipeline` classifies and turns into Kanban/Linear work items. This is the
  "auto-ingest" the phase wants pointed at `events_emit` — currently it is a purely local,
  file-based pipeline with **no** substrate awareness `[VERIFIED: grep for "events_emit"/
  "events.emit"/"7410" across hermes-engineering-board/src returned no matches]`. Both share the
  same `~/.hermes/linear-sync.db` path as `hermes-linear-connector`'s `sync.db_path`, confirming
  they already coordinate through that file today.
- Test baseline (live, verified today): `.venv/bin/python -m pytest -q` → **76 passed**.

### Finding 4 — Grok Build's `ultrathink` fork: a real, documented hook-contract blocker

The "Grok Build" product itself (`/root/src/repos/grok-build`) is the vendored Rust CLI/editor
(xAI's own coding agent product source); the ultrathink plugin surface the phase means is
`/root/src/repos/claude-ultrathink-grok`, a **git worktree** of `claude-ultrathink` on branch
`milestone/v1.0-cross-runtime` (see Finding 1). It already contains a ported
`src/substrate/brief.ts` and `brief.test.ts`, byte-identical in shape to `claude-ultrathink`'s
own `fetchBrief`/`emitEvent` (`http://127.0.0.1:7410`, `POST /brief` / `POST /events`, 1.5 s
timeout, fail-open) `[VERIFIED: read src/substrate/brief.ts in full this session]` — but it is
**not wired** into `hooks/uplift.ts` yet (`grep` for `fetchBrief`/`SUBSTRATE_BRIEF` in
`hooks/uplift.ts` returned nothing).

The blocker, already documented and dated in that repo's own PROJECT.md
(`[CITED: claude-ultrathink-grok/.planning/PROJECT.md, "Grok Build contract" section, "verified
2026-09-23 against /root/.grok/docs/user-guide/"]`, an internal doc citation from a prior
session, not independently re-verified against the Grok docs this session — treat as MEDIUM, not
HIGH):
- **Grok discards a `UserPromptSubmit` hook's stdout entirely — no `additionalContext`.** The
  existing `fetchBrief`-into-context delivery pattern (inject via hook stdout, as Claude Code
  does) is a documented no-op on Grok Build. The other milestone's workaround: deliver via a
  session file plus a `rules/` entry and a skill, not via hook stdout.
- `bun` is not on Grok's hook PATH (`/usr/bin:/bin` only); hooks need a `bin/` shim, not a bare
  `bun` command.
- Grok's stdin envelope is camelCase; only `hook_event_name` and `tool_response` are aliased —
  reading `session_id`/`tool_name`/`tool_input` as-is yields `undefined`.
- A **different**, older ultrathink plugin is already installed and enabled at
  `/root/.grok/installed-plugins/ultrathink-53674ac1` and would fire alongside any new one until
  removed.

**Implication for Phase 1 planning:** success criterion 4's "Grok Build's `ultrathink`
`UserPromptSubmit` hook fetches `/brief`" cannot be planned as a simple stdout-injection task —
it inherits whatever delivery mechanism the coordination in Finding 1 settles on. If Lane B
proceeds independently of the other milestone, it must independently solve the same
delivery-path problem (session file + rules entry), which is real added scope, not a one-line
fetch call.

**What is already running and should NOT be confused with new work:** `substrate-collector-
grok.service` (`packages/collectors/src/grok.ts` in `agent-substrate`) is a **separate**,
already-shipped systemd service that tails Grok session output for event collection — it is not
the `UserPromptSubmit`/brief-fetch hook and does not need to be rebuilt; it already satisfies
part of the "Grok Build ... emit events" half of the phase goal.

### Finding 5 — Live test baselines are currently RED in both `claude-ultrathink` worktrees

Verified live this session, not merely cited from a stale doc:

| Worktree | Branch | `bun test` result |
|---|---|---|
| `/root/src/repos/claude-ultrathink` | `feat/substrate-brief` | **279 pass / 5 fail** (24 files) |
| `/root/src/repos/claude-ultrathink-grok` | `milestone/v1.0-cross-runtime` | **256 pass / 1 fail** (22 files) |

Both failures are assertion-count mismatches in `src/claude/hook.test.ts` (`toHaveLength`
expecting 3/15, receiving 5/3 respectively) — consistent with the concurrent-session collision
the `claude-ultrathink-grok` PROJECT.md already documents. **Any Phase 1 plan/executor touching
either worktree must treat these specific failures as a pre-existing baseline, not a regression
introduced by Phase 1 work**, and should not attempt to "fix" them as part of Lane B without
understanding which concurrent session's changes are still in flight.

### Finding 6 — omp-ultrathink: two credible edit points, substrate not yet wired

`[VERIFIED: read native-catalog.ts and swe.ts in full this session]`. Two candidate places match
"adds `memory.brief` to its discovery tools":
1. `native-catalog.ts`'s `NATIVE_TOOLS` array (`web_search`, `web_extract`, `memory`, `todo`) —
   a session-scoped tool the model can invoke by name; adding a `memory_brief` entry here would
   surface it as an on-demand tool, not an automatic pre-prompt fetch.
2. `swe.ts`'s `runAutonomousDiscovery` — gated on `looksLikeImplementation(prompt)`, builds a
   `calls` array of MCP tool invocations (`github_repo_info`, `github_pull_requests_list`,
   `linear_issues_list`) filtered by `mcp.selectTools()` availability, executed via `mcp.call(...)`
   with an 8 s/4 s budget, and injected into the uplift XML as `<discovery>`. This is the better
   match for "discovery tools" literally — adding `{ name: "memory_brief", args: {...} }` here,
   gated the same way (`available.has("memory_brief")`), would make the brief arrive
   automatically and consistently with the existing pattern, at the cost of needing omp/Pi's MCP
   client to have substrate-mcp registered as a server first.

`[VERIFIED: grep across /root/.claude.json, /root/.pi, and searched for "7410"/"substrate-mcp" in
config files]` — omp/Pi has **no existing MCP registration for substrate-mcp** anywhere on this
host. Wiring the client connection is itself a task, not a given.

### Finding 7 — Muse Code: closed binary, no prompt-submission hook, fallback is the only viable channel

`/root/.local/bin/muse` (symlinked binary `muse-bin-1.3.0-R3401.1`), no systemd unit — it is an
interactive/headless CLI, not a persistent service. It has a real plugin/hook system
`[VERIFIED: extracted from the binary's own embedded strings this session via `strings`]`: hook
event names found are **`SessionStart`, `PreToolUse`, `PermissionRequest`, `PostToolUse`,
`PostToolUseFailure`** — no `UserPromptSubmit` and no `Stop` event exists in this set. This is a
concrete confirmation (not an assumption) that Muse cannot intercept prompt submission the way
Claude Code or Grok Build can, which is exactly why the phase specifies a static
`.substrate/BRIEF.md` fallback rather than a live fetch.

Muse does read `AGENTS.md`/`CLAUDE.md` project-rule files as session context (confirmed from the
same string dump: `.claudeCLAUDE.md~/.claude/CLAUDE.md`, and an `/init` command whose prompt text
instructs it to read `AGENTS.md`/`CLAUDE.md` specifically). It also has an MCP-server login
subcommand (`muse mcp`) and a `memory` native tool with destinations `project`/`local`/`notes`.

**Two viable designs for the fallback, both consistent with what was verified — pick one at plan
time:**
1. A collector process (matches `agent-substrate` PROJECT.md's own "muse tail" line in the
   `collectors` package) writes `.substrate/BRIEF.md` into the repo; nothing further is needed if
   the operator or an `AGENTS.md` convention tells Muse to read it — this requires no Muse-side
   code changes at all.
2. A `SessionStart` plugin hook (confirmed to exist as an event kind) could read
   `.substrate/BRIEF.md` and inject it — **not verified whether a Muse `SessionStart` hook's
   output actually reaches model context** (only the event name's existence was confirmed via
   strings, not its plumbing) — treat this half as `[ASSUMED]` and validate with `muse plugins
   hook test` (a real subcommand, confirmed via `muse plugins --help`) before committing to it in
   a plan.

### Finding 8 — grok-hermes-connector: version already 0.4.0 in code, but none of the four tools exist yet

Running under `grok-hermes-connector.service`, `WorkingDirectory=/root/src/repos/mcp`,
`ExecStart=.venv/bin/grok-hermes-connector` `[VERIFIED: systemctl cat]`. Live journal line:
`starting grok-hermes-connector v0.4.0 on 127.0.0.1:8788`. Source:
`__version__ = "0.4.0"` in `src/grok_hermes_connector/__init__.py`
`[VERIFIED: read this session]` — note `pyproject.toml` still says `version = "0.3.3"`; this is
existing drift in the repo, not something Phase 1 caused, but worth a one-line fix if the plan
touches that file anyway.

`[VERIFIED: grep for "memory_brief"/"memory_write"/"events_emit"/"graph_get" across
server.py returned zero matches]` — **none of the four tools the phase wants forwarded exist
yet**, despite the version number already reading 0.4.0. `handoff_to_hermes` (the existing,
working fire-and-forget Hermes dispatch tool, `server.py:333` onward) does **not** currently
record or accept a Graph ID `[VERIFIED: grep for "graph_id"/"Graph ID" in server.py returned
zero matches]` — the "records a `handoff` event with its Graph ID" half of success criterion 5 is
new surface area, not an extension of existing plumbing.

Existing redaction code to reuse (per the substrate's own constraint: "Redact before emitting.
Reuse the connector's redactor.py patterns"): `/root/src/repos/mcp/src/grok_hermes_connector/
redactor.py` `[VERIFIED: file exists at this path]` — this is the same module Phase 0 already
ported into `packages/mcp-server/src/redact.ts` per STATE.md; no new redaction logic should be
written for connector-side changes, only calls into the existing module.

### Finding 9 — herdr: confirmed absent, real project, event contract matches CONTEXT.md

`[VERIFIED: command -v herdr, which herdr, and find / -iname "*herdr*" all returned nothing]` —
herdr is genuinely not installed anywhere on this host, confirming CONTEXT.md's claim. It is a
real open-source project, `herdrdev/herdr` (a terminal agent multiplexer), not a hallucinated
package name `[CITED: web search, herdrdev/herdr GitHub issue tracker]`. Its documented API
(socket-based, `events.subscribe` with filters like `{type: "pane.agent_status_changed", ...}`,
plus `session.snapshot` for bootstrap/reconnect) matches CONTEXT.md's description of the seam
almost exactly. Known, documented issues from that project's own tracker worth flagging for the
plan: a subscription bug where one unknown pane fails the *entire* subscription (issue #4344,
"the response id is not the request id"), and advice from downstream integrators to treat pushed
events as invalidation triggers and re-fetch `session.snapshot` rather than trusting event
payloads directly (replay/staleness issues, issue #90). **No installation source (npm/cargo/apt/
release binary) was confirmed this session** — the plan should treat "how herdr is installed on
this host" as an open item to resolve during planning, not assume a package manager.

## Standard Stack

No new third-party libraries are required for this phase — it is entirely wiring between
already-installed, already-running services (Hermes, hermes-linear-connector,
hermes-engineering-board, omp-ultrathink, claude-ultrathink-grok, grok-hermes-connector) and the
already-shipped `substrate-mcp` (Phase 0). The one genuinely new install is **herdr** itself.

### Core

| Component | Version | Purpose | Why Standard |
|---|---|---|---|
| herdr | not installed; latest from `herdrdev/herdr` | Lane B persistent runtime; `events.subscribe` collector seam | Already decided in CONTEXT.md; real, actively-issue-tracked project `[CITED]` |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|---|---|---|
| herdr | Orca alone (tee via `endpoint.env`) | Rejected in CONTEXT.md — Orca has no session/event query API; herdr's push model is closed while Orca's push-only tee touches a live, shared status path used by every agent on the host |

## Package Legitimacy Audit

Only one new external dependency is introduced by this phase (herdr); everything else is edits
to code already installed on this host.

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---|---|---|---|---|---|---|
| herdr | not resolved to a specific package registry this session (GitHub project, install mechanism unconfirmed) | unknown | unknown | `github.com/herdrdev/herdr` (per web search) | not run through `gsd_run query package-legitimacy check` — no ecosystem/registry name was confirmed to check against | **Flagged — planner must add a `checkpoint:human-verify` task before installing**, and must first determine the actual install command (npm global? cargo? release binary?) since this was not established this session |

**Packages removed due to [SLOP] verdict:** none.
**Packages flagged as suspicious [SUS]:** herdr — not because of any negative signal, but because
its registry/install path was not confirmed this session; verify the install command against the
project's own README before writing an install task.

## Architecture Patterns

### System Architecture Diagram

```
                     ┌─────────────────────────────────────────┐
                     │        substrate-mcp (Phase 0, live)     │
                     │  127.0.0.1:7410                          │
                     │  MCP: memory_brief, memory_write,        │
                     │  events_emit, graph_get, graph_register, │
                     │  graph_claim/release/complete            │
                     │  HTTP: POST /brief, /events, /verify     │
                     └───────────────┬───────────────────────────┘
                                     │ POST /brief (1.5s, fail-open)   │ POST /events
              ┌──────────────────────┼──────────────────────┬────────┴─────────────┐
              │                      │                      │                       │
   ┌──────────▼─────────┐  ┌─────────▼──────────┐  ┌────────▼────────┐   ┌──────────▼─────────┐
   │ Hermes pre_llm_call │  │ omp-ultrathink      │  │ claude-ultrathink│   │ grok-hermes-        │
   │ (Python hook, LIVE) │  │ runAutonomousDisc-  │  │ -grok hooks/     │   │ connector v0.4.0    │
   │ NEEDS: brief fetch  │  │ overy MCP calls     │  │ uplift.ts        │   │ (Python, LIVE)      │
   │ bridge to TS engine │  │ NEEDS: memory_brief │  │ NEEDS: delivery  │   │ NEEDS: forward 4     │
   │ (see Finding 1)     │  │ call + MCP client   │  │ path fix (Grok   │   │ substrate tools +    │
   │                     │  │ registration        │  │ discards hook    │   │ Graph ID on          │
   │                     │  │                     │  │ stdout)          │   │ handoff_to_hermes    │
   └──────────┬──────────┘  └─────────────────────┘  └──────────────────┘   └──────────┬──────────┘
              │                                                                          │
   ┌──────────▼──────────┐                                                    ┌──────────▼──────────┐
   │ hermes_kanban_create │ ── TO BE RETIRED (coordinate with Finding 1) ──►  │  Grok Bot            │
   │ (hermes-plugin)      │                                                    │  (upstream of        │
   └──────────────────────┘                                                    │  connector)          │
                                                                                └──────────────────────┘
   ┌──────────────────────┐         ┌──────────────────────┐
   │ hermes-linear-        │◄────────► hermes-engineering-  │
   │ connector (LIVE,      │ shared   │ board on_start/      │
   │ keep as-is: dispatch, │ sync.db  │ on_tool/on_end        │
   │ mirror, DoD gate)      │         │ NEEDS: retarget       │
   └──────────────────────┘         │ auto-ingest to        │
                                     │ events_emit           │
                                     └──────────────────────┘

   ┌──────────────────────┐         ┌──────────────────────┐
   │ Muse Code (closed     │         │ herdr (NOT INSTALLED) │
   │ binary, no prompt-    │         │ events.subscribe on   │
   │ submit hook)          │         │ pane.agent_status_    │
   │ NEEDS: .substrate/    │         │ changed → collector    │
   │ BRIEF.md written by   │         └──────────────────────┘
   │ a collector           │
   └──────────────────────┘
```

### Recommended Project Structure

No new top-level structure is needed; edits land in existing repos at existing entry points:

```
hermes-plugin/prompt_uplift/hook.py        # remove hermes_kanban_create call, remove/gate gsd_write,
                                             # add brief-fetch + events_emit (bridge TBD per Finding 1)
hermes-engineering-board/src/hermes_eng_board/hooks_session.py   # retarget ingest to events_emit
omp-ultrathink/swe.ts                       # add memory_brief to runAutonomousDiscovery's calls[]
claude-ultrathink-grok/hooks/uplift.ts      # wire existing src/substrate/brief.ts once delivery
                                             # path is decided (Finding 4)
mcp/src/grok_hermes_connector/server.py     # add memory_brief/memory_write/events_emit/graph_get
                                             # forwarding tools; add graph_id param to handoff_to_hermes
agent-substrate/packages/collectors/src/    # new: muse.ts (writes .substrate/BRIEF.md), herdr.ts
                                             # (events.subscribe collector)
```

### Pattern: fail-open substrate client (already established, Phase 0)

**What:** every substrate call from a hook/collector wraps its HTTP call in try/catch, returns a
neutral empty value on any failure, and enforces a short client-side timeout.
**When to use:** every new integration point in this phase — Hermes's brief fetch, omp's
discovery call, grok-hermes-connector's forwarding tools, herdr's collector.
**Example (the pattern to copy, already shipped and tested):**
```typescript
// Source: /root/src/repos/claude-ultrathink/src/substrate/brief.ts (read in full this session)
export async function fetchBrief(
	input: BriefInput,
	env: Record<string, string | undefined> = process.env,
): Promise<string> {
	if (env.SUBSTRATE_DISABLED === "1") return "";
	try {
		const response = await fetch(`${baseUrl(env)}/brief`, {
			method: "POST",
			headers: { "content-type": "application/json", ...authHeaders(env) },
			body: JSON.stringify({ repo: input.repo, branch: input.branch, graph_id: input.graphId, surface: input.surface ?? "claude-code" }),
			signal: AbortSignal.timeout(timeoutMs(env)),
		});
		if (!response.ok) return "";
		return (await response.text()).trim();
	} catch {
		return ""; // fail-open: a missing substrate never blocks a prompt
	}
}
```

### Anti-Patterns to Avoid

- **Reforking the uplift/GoT engine into Python for Hermes** — explicitly out of scope per the
  `claude-ultrathink-grok` PROJECT.md ("Out of Scope: A Python rewrite of the uplift, graph,
  HITL, or track-plan engine — TypeScript stays the source of truth"). If Lane B needs Hermes to
  reason over a graph, it must call into the existing TypeScript pipeline, not reimplement it.
- **Touching `hermes-linear-connector`'s sync/DoD logic** — it already does exactly what the
  phase wants kept; the temptation to "improve" it while in the file should be resisted.
- **Assuming Grok Build hooks work like Claude Code hooks** — the stdout/`additionalContext`
  delivery path is confirmed dead on Grok; any task that assumes it will silently no-op.
- **Building a Muse `UserPromptSubmit`-equivalent hook** — it does not exist in the binary's own
  hook event set; do not spend a task trying to find one.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---|---|---|---|
| Redacting secrets before emitting events | A new redaction pass | `/root/src/repos/mcp/src/grok_hermes_connector/redactor.py` (Python side) / `packages/mcp-server/src/redact.ts` (already ported, TS side) | Both already exist and are the substrate's own stated constraint ("Reuse the connector's redactor.py patterns") |
| Fail-open HTTP client to substrate | A new fetch wrapper per surface | Copy the `fetchBrief`/`emitEvent` pattern from `claude-ultrathink/src/substrate/brief.ts` verbatim per language | Already tested (`brief.test.ts`), already the house style |
| DoD gating on Linear "Done" | A second gate in the substrate | `hermes-linear-connector`'s existing `require_dod_for_done` in `sync_engine.py` | Already live, already correct; the phase explicitly says "keeps" this |
| Herdr event polling | A polling loop against herdr's CLI | `events.subscribe` socket API | herdr's own maintainers document polling as the fallback/reconcile path, not primary — `[CITED: web search]` |

**Key insight:** almost everything this phase needs already exists somewhere on this host in a
proven form (Phase 0's substrate client, the connector's redactor, the linear-connector's DoD
gate, the grok collector's event-tail pattern). The actual net-new work is bridging, not building.

## Common Pitfalls

### Pitfall 1: Assuming `.planning/PROJECT.md` documents match the phase description's premise
**What goes wrong:** a plan is written assuming the Hermes redesign is already specified, and
tasks reference a non-existent spec.
**Why it happens:** the phase description was written from the Notion build plan before this
probe; on-disk reality moved (a new, unrelated-but-adjacent milestone was started in a sibling
worktree) between when the roadmap was written and now.
**How to avoid:** read Finding 1 before planning any Hermes task; resolve the coordination
question explicitly rather than assuming either document is authoritative.
**Warning signs:** a plan task that says "per the redesign in PROJECT.md" without naming which
repo's PROJECT.md.

### Pitfall 2: Editing hermes-plugin and forgetting its git root is the enclosing superproject
**What goes wrong:** `git add`/`git commit` inside `hermes-plugin` sweeps in unrelated dirty files
from every other repo under `/root/src/repos` (confirmed: `git status` there showed modified
files in `../pumpgrok` and untracked entries for dozens of unrelated repos).
**Why it happens:** `/root/src/repos` itself is a git repository; `hermes-plugin` has no own
`.git`.
**How to avoid:** stage only the specific files touched (`git add <exact-path>`), never `git add
-A`/`.`, and diff before committing — the same lesson STATE.md already recorded for a different
file collision this milestone.
**Warning signs:** `git status` showing files you didn't touch.

### Pitfall 3: Treating claude-ultrathink's/claude-ultrathink-grok's red `bun test` as a Phase 1 regression
**What goes wrong:** an executor "fixes" the pre-existing `hook.test.ts` assertion-count failures
as part of a Lane B task, potentially clobbering a concurrent session's in-flight fix.
**Why it happens:** the failure is a real, visible red test in the exact files Phase 1 will touch
(`hooks/uplift.ts`, `src/claude/hook.ts`).
**How to avoid:** record the baseline (279/5 fail on `claude-ultrathink`, 256/1 fail on
`claude-ultrathink-grok`, both verified live this session) before starting; only new failures
introduced by Phase 1's own diff should block a task.
**Warning signs:** test count matches the numbers in Finding 5 exactly, unrelated to the file you
just edited.

### Pitfall 4: Assuming Grok Build hook stdout works like Claude Code's
**What goes wrong:** a task ports `fetchBrief` into `claude-ultrathink-grok`'s `hooks/uplift.ts`
exactly as it exists in `claude-ultrathink`, and the brief silently never appears in-session.
**Why it happens:** the code runs without error (fail-open design means no visible failure); the
delivery path is simply discarded by the Grok Build host.
**How to avoid:** plan the delivery mechanism (session file + rules entry + skill, per Finding 4)
as its own task, before or alongside the fetch-call task.
**Warning signs:** the proof criterion ("Omp's next prompt... lists both the handoff and the
claim") passing for Hermes/Omp but never for Grok Build.

## Code Examples

### Existing fail-open substrate client (copy this pattern)
```typescript
// Source: /root/src/repos/claude-ultrathink/src/substrate/brief.ts (verified, read in full)
const DEFAULT_URL = "http://127.0.0.1:7410";
const DEFAULT_TIMEOUT_MS = 1500;
export async function emitEvent(
	input: EmitInput,
	env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
	if (env.SUBSTRATE_DISABLED === "1") return false;
	try {
		const response = await fetch(`${baseUrl(env)}/events`, {
			method: "POST",
			headers: { "content-type": "application/json", ...authHeaders(env) },
			body: JSON.stringify({ kind: input.kind, summary: input.summary, surface: input.surface ?? "claude-code", session_id: input.sessionId, graph_id: input.graphId, node_id: input.nodeId, repo: input.repo, branch: input.branch, payload: input.payload }),
			signal: AbortSignal.timeout(timeoutMs(env)),
		});
		return response.ok;
	} catch {
		return false;
	}
}
```

### Existing Hermes hook registration (what any Hermes-side edit must preserve)
```python
# Source: /root/src/repos/hermes-plugin/__init__.py:262-286 (verified, read in full)
ctx.register_command("uplift", handle_uplift, ...)
ctx.register_command("think", handle_think, ...)
ctx.register_command("issues", handle_issues, ...)  # "Hermes Kanban issue tracking" — retire target
ctx.register_command("gsd", handle_gsd, ...)
ctx.register_hook("pre_llm_call", on_pre_llm_call)
```

### Existing omp-ultrathink discovery-call pattern (where memory_brief plugs in)
```typescript
// Source: /root/src/repos/omp-ultrathink/swe.ts (verified, read in full)
const available = new Set(mcp.selectTools().map((tool) => tool.name));
const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
if (available.has("linear_issues_list")) calls.push({ name: "linear_issues_list", args: {} });
// Phase 1 adds: if (available.has("memory_brief")) calls.push({ name: "memory_brief", args: {...} });
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|---|---|---|---|
| Hermes Kanban as the tracker | Notion + Linear as the only tracker (per both this phase and the parallel `claude-ultrathink-grok` v1.0 milestone) | mid-flight, not yet shipped in either repo | Two independent efforts are converging on the same outcome — see Finding 1 |
| grok-hermes-connector v0.3.x (dispatch/OAuth/redaction only) | v0.4.0 version string already committed, but forwarding tools not yet implemented | in progress on this host | Plan should treat "0.4.0" as the target to fill in, not a completed milestone |

**Deprecated/outdated:**
- The `agent-substrate` STATE.md's claim that hermes-plugin's `.planning/PROJECT.md` documents
  "the redesign this phase adopts as-is" — superseded by Finding 1; that claim should be corrected
  in STATE.md once this phase's plan resolves the coordination question.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|---|---|---|
| A1 | Which of Finding 1's three coordination options the owner prefers | Finding 1 | Wrong choice could mean rebuilding a Hermes↔TypeScript bridge twice, or silently orphaning the other milestone's in-progress requirements work |
| A2 | Muse `SessionStart` plugin hook output actually reaches model context (only the event name's existence was confirmed, not its data path) | Finding 7 | If false, the `.substrate/BRIEF.md`-via-hook design doesn't work and the pure filesystem-convention fallback (design 1) must be used instead |
| A3 | herdr's install mechanism (npm/cargo/release binary) — not confirmed this session | Finding 9, Package Legitimacy Audit | An install task could be written against the wrong package manager and fail at execution time |
| A4 | The Grok Build hook-contract facts in Finding 4 (stdout discarded, camelCase envelope, bun not on PATH) are accurate — sourced from another session's dated note against `/root/.grok/docs/user-guide/`, not independently re-fetched this session | Finding 4 | If stale, a delivery-path task could be built around a blocker that no longer exists, or miss a new one |

## Open Questions

1. **Does Lane B (this phase) proceed independently of `claude-ultrathink-grok`'s v1.0 milestone, or coordinate with it?**
   - What we know: both target the same Hermes hook and the same Kanban retirement; the other
     milestone has Active requirements but zero planned phases yet, so nothing there is committed
     to a specific implementation shape yet.
   - What's unclear: whether the owner wants these merged into one effort, sequenced, or kept
     deliberately separate with a defined seam.
   - Recommendation: raise this explicitly before phase planning proceeds — see Finding 1's three
     options.

2. **What is herdr's actual install command on this host?**
   - What we know: it is `herdrdev/herdr`, a real terminal-agent-multiplexer project; CONTEXT.md's
     description of its `events.subscribe` contract matches public documentation.
   - What's unclear: npm/cargo/binary-release install path; whether it needs a systemd unit like
     the other collectors.
   - Recommendation: resolve during planning with a `checkpoint:human-verify` before the install
     task, per the Package Legitimacy Audit.

3. **Does the Muse `.substrate/BRIEF.md` fallback need any Muse-side code at all, or is it pure
   filesystem convention?**
   - What we know: Muse reads `AGENTS.md`/`CLAUDE.md` as context; a `SessionStart` hook event
     exists in its plugin system.
   - What's unclear: whether `SessionStart` hook output is actually injected into context (vs.
     used only for side effects like logging) — `muse plugins hook test <plugin-id>:<hook-id>
     --fixture <path>` is a real subcommand that could answer this empirically before planning
     commits to either design.
   - Recommendation: run that probe as an early Phase 1 task, or treat design 1 (pure filesystem
     convention via a collector) as the default since it requires no Muse-side risk.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|---|---|---|---|---|
| substrate-mcp | every surface's brief/events call | ✓ | live, `systemctl status substrate-mcp` active | — (Phase 0, already proven) |
| Hermes plugin host | Hermes brief/events bridge, Kanban retirement | ✓ | Hermes v0.21.3 (per `claude-ultrathink-grok` PROJECT.md, not independently re-verified this session) | — |
| hermes-linear-connector | keep dispatch/mirror/DoD as-is | ✓ | running, own git repo, 49/2 pytest | — |
| hermes-engineering-board | eng-board auto-ingest retarget | ✓ | running (via Hermes plugin symlink), 76 pytest | — |
| omp-ultrathink | discovery-tool addition | ✓ (source present) | not yet wired to substrate-mcp | — |
| claude-ultrathink-grok worktree | Grok Build brief fetch | ✓ (worktree present, `src/substrate/brief.ts` ported) | `bun test`: 256 pass/1 fail (pre-existing) | — |
| Muse Code binary | `.substrate/BRIEF.md` fallback | ✓ | v1.3.0-R3401.1, no systemd (interactive/headless CLI) | filesystem-only fallback (design 1) if `SessionStart` hook injection (A2) is false |
| grok-hermes-connector | Grok Bot handoff events | ✓ | v0.4.0 in code (`pyproject.toml` stale at 0.3.3), tools not yet forwarded | — |
| herdr | Lane B persistent runtime | ✗ | — | none — must be installed; install mechanism unconfirmed (Open Question 2) |
| Orca (`orca-serve`) | collector alongside herdr, IDE surface | ✓ | active running | — |

**Missing dependencies with no fallback:**
- herdr — blocks the "herdr as persistent runtime" half of the phase until installed; installing
  it is itself the deliverable, not a prerequisite to work around.

**Missing dependencies with fallback:**
- none beyond herdr.

## Validation Architecture

### Test Framework

| Property | Value |
|---|---|
| Framework (Python repos) | pytest, per-repo `.venv` |
| Framework (TS repos) | `bun test` + `bunx tsc --noEmit` |
| Config files | each repo's own `pyproject.toml` / `package.json`; no shared root config |
| Quick run command (Hermes) | `cd /root/src/repos/hermes-plugin && python3 -m pytest -q` |
| Quick run command (linear connector) | `cd /root/src/repos/hermes-linear-connector && .venv/bin/python -m pytest -q` |
| Quick run command (eng-board) | `cd /root/src/repos/hermes-engineering-board && .venv/bin/python -m pytest -q` |
| Quick run command (ultrathink family) | `cd <repo> && bun test` |
| Full suite command | same as quick run — these are already fast (< 30s each) |

### Phase Requirements → Test Map

No REQUIREMENTS.md exists for this project; mapping is against the phase's own Success Criteria.

| Criterion | Behavior | Test Type | Automated Command | File Exists? |
|---|---|---|---|---|
| 1 (Hermes brief bridge) | `on_pre_llm_call` injects brief before uplift | unit (FakeCtx pattern already used in `test_hook.py`) | `python3 -m pytest tests/test_hook.py -x` | ✅ (extend existing) |
| 2 (Kanban retirement, DoD kept) | `hermes_kanban_create` no longer called; connector DoD gate unaffected | unit + smoke | `pytest tests/test_kanban.py` (hermes-plugin) + `pytest` (linear-connector, unchanged) | ✅ both exist |
| 3 (herdr) | `events.subscribe` collector receives `pane.agent_status_changed` | manual-only (no herdr installed yet; no existing test harness) | — | ❌ Wave 0 gap |
| 4 (omp/Grok Build/Muse brief) | each surface's next prompt shows the brief | integration/manual (cross-process, matches Phase 0's own proof style) | `swe.test.ts` extension (omp); manual for Grok Build/Muse per Finding 4/7 | ❌ Wave 0 gap for Grok Build delivery-path test |
| 5 (connector v0.4 tools) | four MCP tools forward correctly; `handoff_to_hermes` records Graph ID | unit | `pytest tests/test_handoff_pack.py` extension | ✅ file exists, needs new cases |

### Sampling Rate
- **Per task commit:** the quick-run command for whichever repo the task touched.
- **Per wave merge:** all five quick-run commands above, run in sequence.
- **Phase gate:** all green (accounting for the pre-existing `bun test` red baseline in Finding
  5 — Phase 1's own changes must not add to that fail count) before `/gsd-verify-work`.

### Wave 0 Gaps
- [ ] A herdr collector test harness — none exists; herdr isn't installed yet.
- [ ] A Grok Build delivery-path test (session file + rules entry, per Finding 4) — no existing
      test covers Grok's stdout-discard behavior.
- [ ] A Muse `SessionStart` hook probe (`muse plugins hook test`) to resolve Assumption A2 before
      committing to a fallback design.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---|---|---|
| V2 Authentication | yes (loopback token) | `SUBSTRATE_TOKEN` bearer header pattern, already established in `brief.ts`/`emitEvent`; grok-hermes-connector's own `Bearer CONNECTOR_TOKEN` pattern for its HTTP surface |
| V4 Access Control | yes | All substrate endpoints bind `127.0.0.1` only (established Phase 0 pattern) — new collectors/bridges must keep this, not expose `0.0.0.0` |
| V5 Input Validation | yes | Reuse existing `redactor.py`/`redact.ts` before any event/brief payload leaves a process boundary |
| V6 Cryptography | no | No new crypto surface in this phase (ledger hashing is Phase 6) |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---|---|---|
| Secret leakage into `agent_events` via a new collector/bridge (e.g. a Hermes session containing an API key gets tailed into an event payload) | Information Disclosure | Route every new emit path through the existing redactor before it reaches `events_emit`/`/events` — do not write a second redaction pass |
| A malformed/adversarial herdr `events.subscribe` payload (per herdr's own documented issue #4344, one bad pane failing the whole subscription) causing the collector to silently stop reporting | Denial of Service (of observability, not the agents themselves) | Treat herdr's push events as invalidation triggers and re-fetch `session.snapshot` on any subscription error, per the pattern herdr's own downstream integrators document |
| A Grok Build hook silently failing to deliver the brief (Finding 4) being mistaken for "no brief available" rather than "delivery broken" | Repudiation (of the brief actually having been attempted) | The fail-open design must still be observable — log/emit an event when a fetch succeeds but delivery is skipped, so silent breakage isn't indistinguishable from "substrate down" |

## Project Constraints (from CLAUDE.md)

The project's global `~/.claude/CLAUDE.md` requires all Claude Code work to be tracked in Notion
and Linear via the `ultrathink` plugin (Task/Issue/Sub-Issue rows, Graph ID keyed, nested via
`Parent Item`, handled automatically by hooks/skills). This is directly relevant to Phase 1: any
plan work here should itself flow through the existing `ultrathink-kickoff`/`ultrathink-sync`
skills rather than improvising Notion/Linear field mapping — consistent with, and reinforcing,
the phase's own goal of Hermes/Grok Bot doing the same via the substrate.

## Sources

### Primary (HIGH confidence — read in full this session)
- `/root/src/repos/hermes-plugin/.planning/{PROJECT,ROADMAP,STATE,MILESTONES}.md`
- `/root/src/repos/hermes-plugin/__init__.py`, `prompt_uplift/hook.py`
- `/root/src/repos/claude-ultrathink-grok/.planning/{PROJECT,STATE}.md`
- `/root/src/repos/claude-ultrathink/src/substrate/brief.ts`
- `/root/src/repos/hermes-linear-connector/config.example.yaml`
- `/root/src/repos/omp-ultrathink/{native-catalog,swe}.ts`
- `/root/src/repos/mcp/src/grok_hermes_connector/{server,__init__}.py`
- `systemctl list-units`/`cat` for all named services; live `git worktree list`, `git status`,
  `pytest -q`, `bun test` runs this session

### Secondary (MEDIUM confidence)
- `/root/.local/bin/muse --help` and `strings` extraction of the Muse binary
- Grok Build hook-contract facts (Finding 4), cited from `claude-ultrathink-grok/.planning/
  PROJECT.md`'s own dated verification against `/root/.grok/docs/user-guide/`, not independently
  re-fetched this session

### Tertiary (LOW confidence)
- herdr's public API/issue-tracker behavior, via web search — not installed or tested against
  this host

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new libraries besides herdr; every other surface is existing code, read directly.
- Architecture: MEDIUM — edit points are concrete and verified, but Finding 1's coordination question is unresolved and materially affects task shape for Hermes.
- Pitfalls: HIGH — sourced from live, reproduced test runs and git behavior on this exact host, not general knowledge.

**Research date:** 2026-09-24
**Valid until:** 7 days — this phase touches multiple live, actively-being-edited repos (at least two concurrent sessions were found mid-flight); re-verify Findings 1 and 5 immediately before planning if more than a day or two elapses.

---

## Addendum — Open Questions resolved (2026-09-24, autonomous run)

All three Open Questions above were put to the owner and are now settled. The
binding text is in `CONTEXT.md` § "Decisions locked during autonomous planning";
this addendum exists so the two documents do not disagree.

**OQ1 — coordination with the parallel Hermes milestone → RESOLVED (D1).**
Option 3. Lane B scopes its Hermes work to an additive `/brief` call and
`events_emit`, without restructuring `on_pre_llm_call`. The TS-engine bridge and
Kanban retirement stay with the "Ultrathink on Hermes" v1.0 milestone. Finding
1's discrepancy was independently re-verified this session before the decision
was taken: both `PROJECT.md` files were re-read, and `git worktree list`
confirmed `claude-ultrathink-grok` is a worktree of `claude-ultrathink` on
`milestone/v1.0-cross-runtime`.

**OQ2 — herdr's install command → RESOLVED (D2).** `herdrdev/herdr`,
Apache-2.0, single ~10 MB Rust binary, zero runtime dependencies. Official
install is `curl -fsSL https://herdr.dev/install.sh | sh`; `mise use -g herdr`
and a from-source `cargo build --release` are the alternatives (`brew` is
macOS-only). The socket API was retrieved from the official docs and is recorded
in full in D2 — ND-JSON over a Unix socket at `~/.config/herdr/herdr.sock`,
`events.subscribe` with `{type, ...filters}`, `session.snapshot` for bootstrap,
and the documented race-free ordering (subscribe → ack → buffer → snapshot →
apply buffered). Two upstream caveats carried forward: one unknown pane can fail
an entire subscription, and herdr does **not** survive a machine restart with
its original processes intact — so it is not by itself the durability story.

**OQ3 — Muse `SessionStart` reach → still open, but no longer blocking.**
Finding 7's conclusion stands: Muse exposes no prompt-submission hook, so the
static `.substrate/BRIEF.md` fallback is the only channel. Whether a
`SessionStart` hook can inject it into model context remains Assumption A2 and
should be settled by `muse plugins hook test` inside the phase, before any
design depends on it.

**Finding 5 red baselines → RESOLVED (D3).** `origin/master` at `f10e8de` was
tested this session in a throwaway detached worktree: **256 pass, 0 fail**. The
red baselines are confined to uncommitted work in the two active worktrees and
are not regressions from the Phase 0 merge. Do not attribute them to Lane B.
