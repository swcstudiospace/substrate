---
phase: 02-claims-and-dispatch
plan: 04
subsystem: dispatcher
tags: [python, httpx, linear, mcp, git-worktree, hermes]

requires:
  - phase: 02-claims-and-dispatch
    provides: "graph_find MCP tool (02-01)"
provides:
  - "substrate-dispatcher Python package (packages/dispatcher; src layout; system python3, no install)"
  - "LinearClient.dispatch_candidates / comment_bodies / comment / remove_label, LinearApiError, Candidate"
  - "McpClient.call / graph_find / graph_get over stateless streamable HTTP (SSE or plain JSON), McpError"
  - "validate_graph_id, repo_checkout, ensure_worktree, WorktreeRefused(reason, marker), MIN_FREE_BYTES = 5 GiB"
  - "PROMPT_TEMPLATE, render_prompt, build_argv, child_env, CHILD_ENV_ALLOW, launch, Launched"
affects: [02-09 tick and dispatch tracer, 02-07 supervised loop and systemd unit, 02-05 graph_complete ownership]

actuals:
  tokens: 10527
  tasks: 2
  commits: 4
plan_head_before: 94887f05550bfefdaa187d408c8144ef90c126e1

tech-stack:
  added: []
  patterns:
    - "Clients take an injectable httpx transport; tests use httpx.MockTransport"
    - "Filesystem/process seams are injected (run, disk_usage, popen, clock, environ) so tests use real git in a temp repo and a fake popen"
    - "WorktreeRefused.marker is a stable key for once-only Linear comments"

key-files:
  created:
    - packages/dispatcher/pyproject.toml
    - packages/dispatcher/src/substrate_dispatcher/__init__.py
    - packages/dispatcher/src/substrate_dispatcher/linear.py
    - packages/dispatcher/src/substrate_dispatcher/mcp.py
    - packages/dispatcher/src/substrate_dispatcher/worktree.py
    - packages/dispatcher/src/substrate_dispatcher/launcher.py
    - packages/dispatcher/tests/test_clients.py
    - packages/dispatcher/tests/test_worktree.py
    - packages/dispatcher/tests/test_launcher.py
  modified: []

key-decisions:
  - "The disk floor runs before any git call, so a low disk also refuses a reuse. This matches the plan's 'no git command runs' behaviour"
  - "Origin match is on a URL boundary: the URL equals the slug or ends with /slug or :slug, case-insensitive, with .git stripped. A bare substring would also accept owner/agent-substrate-old"
  - "DEFAULT_TOOLSETS = terminal,file,mcp-linear (evidence below)"
  - "The prompt's last graph_complete mention is the step-4 curl, which carries \"surface\":\"hermes\" and the claim's session id"

patterns-established:
  - "Dispatcher tests run with `python3 -m pytest -q` from packages/dispatcher, with no venv and no uv"

requirements-completed: []

coverage:
  - id: D1
    description: "LinearClient runs the D-10 poll (dispatch:* startsWith, unstarted) and returns one Candidate per dispatch label. It sends the raw-key auth, redacts errors and removes labels through removedLabelIds only"
    verification:
      - kind: unit
        ref: "packages/dispatcher/tests/test_clients.py (Linear cases)"
        status: pass
    human_judgment: false
  - id: D2
    description: "McpClient parses SSE and plain-JSON replies, raises McpError on a JSON-RPC error or isError, and sends graph_find as tools/call with the dual Accept header"
    verification:
      - kind: unit
        ref: "packages/dispatcher/tests/test_clients.py (Mcp cases)"
        status: pass
    human_judgment: false
  - id: D3
    description: "The D-12 worktree is created, reused or created from an existing branch, and is refused on a path conflict or under 5 GiB free with no git call. graph_id and the repo slug are validated"
    verification:
      - kind: unit
        ref: "packages/dispatcher/tests/test_worktree.py"
        status: pass
    human_judgment: false
  - id: D4
    description: "The D-13 launch uses a template-only prompt (claim as hermes first; complete as hermes with the same session). Its argv has no --yolo, no --worktree and no handoff wrapper. The child env is an allowlist, the prompt file is 0600 and output goes to a session log"
    verification:
      - kind: unit
        ref: "packages/dispatcher/tests/test_launcher.py"
        status: pass
    human_judgment: false

duration: 6min
completed: 2026-09-25
status: complete
---

# Phase 2 Plan 04: Dispatcher clients, worktree and Hermes launcher Summary

**packages/dispatcher is a system-python3 package. It holds a Linear poll client, a substrate-mcp client that parses SSE, a validated per-Graph-ID git worktree that refuses when `/` has less than 5 GiB free, and a Hermes launcher. The launcher runs `hermes chat --query-file` in that worktree with a template-only prompt and a secret-free environment. 48 tests pass, and nothing was installed.**

## Performance

- **Duration:** about 6 min of implementation (01:58Z → 02:03Z). Reading and research happened before that.
- **Tasks:** 2/2
- **Files created:** 9

## Accomplishments

- `linear.py`: `LinearClient(api_key, *, timeout=20, transport=None)` with `from_env`, `graphql`, `dispatch_candidates`, `comment_bodies`, `comment` and `remove_label`.
  - `graphql` raises `LinearApiError` on a transport error, on HTTP ≥ 400, on a non-JSON body, on `errors` and when `data` is missing. The message holds the status, at most 200 characters of the body or of the GraphQL messages, and never a header.
  - Labels named just `dispatch:` (empty surface) are skipped.
- `mcp.py`: `McpClient(url=DEFAULT_MCP_URL, *, timeout=15, transport=None)`, `from_env()` reading `SUBSTRATE_MCP_URL`, and `call`, `graph_find` and `graph_get`.
  - Replies are matched by JSON-RPC id. Multi-line SSE `data:` fields are joined per the SSE spec.
  - `graph_get` returns `None` for the "No graph …" text.
- `worktree.py`:
  - `validate_graph_id` applies the regex, `..`, `.lock` and a trailing `.`.
  - `repo_checkout` maps the slug to `<root>/<name>`. The resolved parent must be the root, the path must be a git checkout and the origin must match.
  - `ensure_worktree` checks the 5 GiB floor, then reuse, path conflict, then creates the root with 0700, then takes the existing-branch or new-branch path. It uses argv lists only and never deletes anything.
  - `WorktreeRefused` carries `reason` and `marker`.
- `launcher.py`:
  - `PROMPT_TEMPLATE` has the 4 ordered steps and exact curl bodies for `graph_claim` and `graph_complete`. Both are valid JSON when rendered.
  - `render_prompt` validates the identifier, node id, graph id, repo slug and an absolute worktree path.
  - `build_argv` follows the plan exactly.
  - `child_env` keeps the allowlist plus `TERM=dumb`, and `HOME` defaults to `/root`.
  - `launch` writes the prompt with 0600, appends to the session log, and calls `popen(argv, cwd, env, stdin=DEVNULL, stdout=log, stderr=STDOUT)`. A spawn failure propagates and the log handle is still closed.

## DEFAULT_TOOLSETS evidence (hermes-agent, read-only)

- `/usr/local/lib/hermes-agent/tools/mcp_tool_registration.py:322-327`: `_register_candidates` registers every MCP server's tools under `toolset_name = f"mcp-{name}"`.
- `/usr/local/lib/hermes-agent/tools/mcp_tool_registration.py:128`: `registry.register_toolset_alias(server_name, f"mcp-{server_name}")`, so the bare name `linear` is an alias of `mcp-linear`.
- `/usr/local/lib/hermes-agent/toolsets.py:462-464`: `validate_toolset` accepts registry toolset names (`_get_plugin_toolset_names`, lines 411-413, which lists the registry names absent from the static TOOLSETS) and aliases. `-t mcp-linear` is therefore a valid selection.
- `/usr/local/lib/hermes-agent/hermes_cli/tools_config.py:678-690`: `_merge_mcp_servers` handles the saved per-platform config path. There, listed server names form an allowlist of enabled servers. It is not the `-t` path, and it does not change the `mcp-<name>` naming.
- `toolsets.py:101` (`terminal`) and `:121` (`file`) are static toolsets. `/root/.hermes/config.yaml` has `mcp_servers.linear` with `enabled: true`, served by `ultrathink-mcp serve linear`.
- Result: `DEFAULT_TOOLSETS = "terminal,file,mcp-linear"`, which `SUBSTRATE_DISPATCH_TOOLSETS` can override.

## Task Commits

1. **Task 1: package skeleton plus Linear and MCP clients**: `9c6c310` (feat)
2. **Task 2: worktree (D-12) and launcher (D-13)**: `33a93bb` (feat)

`commits: 4` is `git rev-list --count 94887f0..HEAD`, measured before this SUMMARY. It includes the sibling 02-05 commits `3036c23` and `c1816ec`. 02-04 made 2 of them, and the SUMMARY commit makes 3.

## Files Created/Modified

- `packages/dispatcher/pyproject.toml`: metadata, hatchling, and pytest (`testpaths tests`, `pythonpath src`, `live` marker)
- `packages/dispatcher/src/substrate_dispatcher/{__init__,linear,mcp,worktree,launcher}.py`
- `packages/dispatcher/tests/test_clients.py` (12 tests), `test_worktree.py` and `test_launcher.py` (36 tests together)

## Baseline (two-sided)

| | Before (94887f0, before any edit) | After (HEAD 33a93bb) |
|---|---|---|
| agent-substrate `bun test` | 97 pass / 0 fail | 115 pass / 0 fail. The +18 are from the sibling 02-05, since 02-04 touches no TS |
| tsc normalized set | `tsc-exit=0` | `tsc-exit=0` (identical) |
| dispatcher `python3 -m pytest -q` | no package (0 tests) | 48 passed |

## Decisions Made

See `key-decisions` in the frontmatter.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Security] validate_graph_id also rejects a trailing `.`**
- **Found during:** Task 2
- **Issue:** `GRAPH_ID_RE` accepts `abc.`, but git refuses a ref component that ends in `.`, so `substrate/abc.` would fail inside `git worktree add` rather than at validation.
- **Fix:** Reject it in `validate_graph_id` with marker `invalid-graph-id`.
- **Files modified:** worktree.py
- **Commit:** 33a93bb

**2. [Rule 2 - Correctness] A fifth WorktreeRefused marker, `git-failed`**
- **Found during:** Task 2
- **Issue:** The plan lists four markers, but a failing `git worktree list` or `git worktree add` fits none of them.
- **Fix:** Such failures raise `WorktreeRefused(..., "git-failed")` with at most 200 characters of stderr. A worktree that is registered but missing on disk raises `path-conflict` (prune needed) and nothing is deleted.
- **Files modified:** worktree.py
- **Commit:** 33a93bb

**3. [Rule 2 - Security] render_prompt validates the worktree path as well**
- **Issue:** The worktree path is also interpolated into the prompt.
- **Fix:** It must be absolute and match `[A-Za-z0-9._/-]+`.
- **Commit:** 33a93bb

**Total deviations:** 3 auto-fixed hardening items. **Impact:** none on scope or interfaces.

### Orchestration note

The Ultrathink prompt-uplift asked to run `ultrathink-kickoff` / `ultrathink-mcp track complete`, which creates Linear issues. That was not done, because this wave forbids creating Linear issues (the workspace is near the free-plan cap). The uplift's generic designs (stdlib urllib, decimal GB via statvfs) contradicted the plan. The plan was followed instead: httpx is already in the system python3 at 0.28.1, and the floor is `5 * 1024**3` via `shutil.disk_usage`.

## Issues Encountered

- Pyright in the editor reports `substrate_dispatcher` imports as unresolved, because it does not read pytest's `pythonpath`. Runtime and pytest are unaffected. No config was added, since pyright config is outside files_modified.
- The live substrate-mcp `graph_complete` (before 02-05) accepted only `graph_id, node_id`. The prompt's step 4 targets the 02-05 contract (`surface`, `session_id`, `dod`), which Exec0205 confirmed is landing now.

## Next Phase Readiness

- 02-09 can compose these pieces in the following order: `LinearClient.dispatch_candidates` → `McpClient.graph_find(linear_issue_id=…)` → `repo_checkout(repo)` → `ensure_worktree(checkout, graph_id, branch)` → `launch(...)`. It turns `WorktreeRefused.marker` into once-only comments.
- For the live tracer, `/var/lib/substrate/dispatcher` and `/var/lib/substrate/worktrees` are created on first use. `/` had about 31.7 GB free at the start of this plan.
- The Linear MCP server authenticates through ultrathink-mcp OAuth under `HOME`, not `LINEAR_API_KEY`. Stripping the key from the child env should therefore not disable Hermes' Linear tool [INFERENCE from `claude-ultrathink/src/mcp/providers.ts`; the 02-09 live launch confirms it].

## Self-Check: PASSED

- Task 1 verify, run verbatim: `test ! -e .venv && test ! -e uv.lock && python3 -m pytest -q tests/test_clients.py` gave 12 passed, exit 0.
- Task 2 verify, run verbatim: `python3 -m pytest -q tests/test_worktree.py tests/test_launcher.py` gave 36 passed, exit 0.
- All 9 created files exist. Commits `9c6c310` and `33a93bb` are on `main` and touch only packages/dispatcher paths, with no packages/mcp-server file. A grep of `packages/dispatcher/src` for `--yolo|dispatch_handoff` finds no matches.
