# Phase 24: substrate-dispatcher - Research

**Researched:** 2026-10-10
**Domain:** Port of September's Linear-to-Hermes dispatcher (`acc30a8`) onto main's v1.2 lease model + Phase 20 production identity; per-Graph-ID worktrees; lease-correct session watch; refusal vocabulary inside the closed event kinds
**Confidence:** HIGH (every port point read on `acc30a8` and on main this session; Phase 20/22/23 contracts read from committed CONTEXT/VERIFICATION; host facts read live, values never read)

<user_constraints>
## User Constraints (from CONTEXT.md)

Locked: D24-01 (verbatim port; rewrite auth + lease call sites only), D24-02 (substrate bearer for the loop, raw Linear key), D24-03 (hermes token read at session runtime, never baked into the prompt), D24-04 (13-marker superset), D24-05 (given_up.json persistence — the greenfield delta), D24-06 (HostClient ports now; claude-code live deferred to Phase 33), D24-07 (900 s timeout = lease TTL), D24-08 (--once refusal kept), D24-09 (30 s tick, flock, kill switch defaults on), D24-10 (D-16 root trust carried), D24-11 (additive Linear writes; no fight with the connector poller), D24-12 (dispatch.outcome/dispatch.failed events; no new kinds), D24-13 (September worktrees left alone), D24-14 (staged units; restarts + manifest flip gated), D24-15 (landed-claim rule reads Phase 23 artifacts only). Full text in 24-CONTEXT.md.
</user_constraints>

<ports>
## Port Map (acc30a8 → main)

| # | September file | Lines | Disposition on main | Plan |
|---|---|---|---|---|
| P-01 | `packages/dispatcher/src/substrate_dispatcher/linear.py` | 165 | Port whole; unchanged (raw `Authorization: <key>`, unstarted + `dispatch:*` poll, additive label removal, marker-tag comment scan over last 50). Key comes from the per-unit env file (D24-02), never the repo | 24-01 |
| P-02 | `packages/dispatcher/src/substrate_dispatcher/mcp.py` | 147 | Port whole; add the substrate bearer header to the JSON-RPC POST (D24-01/02). SSE-framed-or-plain parsing unchanged; `SUBSTRATE_MCP_URL` default loopback retained | 24-01 |
| P-03 | `packages/dispatcher/src/substrate_dispatcher/worktree.py` | 147 | Port whole; unchanged (`GRAPH_ID_RE`, origin-URL verification, 5 GiB floor, reuse-or-create on `substrate/<graph_id>`, argv-only git, never deletes). Paths `/var/lib/substrate/worktrees`, `/root/src/repos` stay | 24-01 |
| P-04 | `packages/dispatcher/src/substrate_dispatcher/__init__.py` | 11 | Port whole; unchanged | 24-01 |
| P-05 | `packages/dispatcher/tests/test_clients.py` | 178 | Port whole (covers P-01/P-02: poll shape, comment scan, SSE parsing); extend with bearer-header assertion (D24-02) | 24-01 |
| P-06 | `packages/dispatcher/tests/test_worktree.py` | 174 | Port whole, unchanged | 24-01 |
| P-07 | `packages/dispatcher/src/substrate_dispatcher/launcher.py` | 222 | Port whole; prompt template gains runtime bearer carriage for the hermes token (D24-03); CHILD_ENV_ALLOW, toolset/model envs, D-16 note unchanged | 24-02 |
| P-08 | `packages/dispatcher/src/substrate_dispatcher/sessions.py` | 251 | Port whole; add given_up.json load/save (D24-05); landed-claim rule unchanged (D24-15); 900 s / SIGTERM→SIGKILL / cap-2 unchanged | 24-02 |
| P-09 | `packages/dispatcher/src/substrate_dispatcher/dispatch.py` | 279 | Port whole; `graph_find` call gains auth (D24-02); 13 markers kept (D24-04); add `dispatch.outcome`/`dispatch.failed` emission on the Phase 17 rows (D24-12) | 24-02 |
| P-10 | `packages/dispatcher/src/substrate_dispatcher/host.py` | 224 | Port whole; add substrate bearer to the host POST (D24-02); `REFUSAL_STATUSES`/`UNREACHABLE_LIMIT`/200-char error cap unchanged | 24-02 |
| P-11 | `packages/dispatcher/tests/test_launcher.py` | 213 | Port whole; extend with no-baked-secret assertion (prompt file carries the token path, never a value) | 24-02 |
| P-12 | `packages/dispatcher/tests/test_sessions.py` | 439 | Port whole; extend with given-up persistence round-trip (restart re-reads, never relaunches) | 24-02 |
| P-13 | `packages/dispatcher/tests/test_dispatch.py` | 559 | Port whole; extend with event-emission assertions (outcome/failed rows, ids only, emit failure never blocks the tick) | 24-02 |
| P-14 | `packages/dispatcher/tests/test_host.py` | 212 | Port whole; extend with bearer-header assertion | 24-02 |
| P-15 | `packages/dispatcher/src/substrate_dispatcher/__main__.py` | 162 | Port whole; env-file re-read per tick, flock exit-3, `--once` refusal unchanged; kill-switch key `SUBSTRATE_DISPATCH_DISABLED` unchanged | 24-03 |
| P-16 | `packages/dispatcher/tests/test_main.py` | 261 | Port whole, unchanged | 24-03 |
| P-17 | `packages/dispatcher/pyproject.toml` | 28 | Port whole; `httpx>=0.27`, `pytest>=8.0` dev group, `testpaths=["tests"]` unchanged | 24-03 |
| P-18 | `infra/vps/substrate-dispatcher.service` | ~60 | Port whole; add per-unit `EnvironmentFile=/etc/substrate/substrate-dispatcher.env` (D24-14) + `ConditionPathExists` on the entry point (Phase 16 convention); keep `TimeoutStopSec=15`, kill-group semantics, `SUBSTRATE_ENV_FILE` re-read | 24-03 |
| NOT ported | September `.planning/` archives under `02-claims-and-dispatch/` | — | Hostnames + pre-lease decisions; reference only (research SUMMARY rule). The `ownershipRefusal`/`holder()`/`setNodeState` ownership model is dead on main (23-CONTEXT) | — |
| NOT ported | `21652a2` dispatcher-adjacent stubs | — | No dispatcher content; ignored | — |

**What is greenfield (on no branch):** given_up.json persistence (D24-05); prompt bearer carriage (D24-03); loop/event bearer carriage (D24-02); `dispatch.outcome`/`dispatch.failed` emission (D24-12); `scripts/dispatcher-smoke.*` + `docs/dispatcher.md` + `docs/runbooks/dispatch-proof.md`; root `test:py` extension to `packages/dispatcher/tests`; `smoke:dispatcher` package script.
</ports>

<lease>
## Lease-Model Interplay (what "lease-correct" means on main)

- Claim: the session (not the dispatcher) calls `graph_claim{graph_id, node_id, surface: "hermes", session_id}` with the **hermes bearer**; the reply's `lease_id` is the only proof the session later presents to heartbeat/release/complete. The dispatcher never holds a hermes `lease_id` and never calls claim/release/complete at all — its only MCP calls are `graph_find` (fail-open read, substrate bearer) and `events_emit` (outcome rows).
- Landed evidence (D24-15) reads three Phase 23 artifacts, newest-first cheapest: `graph_get` public lease view (`claimed_by == "hermes"`), node state vs launch state (`started_review`/`completed` transitions), and the mirror's `Claimed by hermes — session <sid> (graph <g>, node <n>)` comment with a session id unseen at launch. A `dod-required` park at `started_review` with the lease held counts as landed (the session is alive and working).
- TTL coupling: `DEFAULT_LEASE_TTL_SECONDS = 900` (`lease.ts:42`) equals `CLAIM_TIMEOUT_SECONDS = 900`. The session must heartbeat inside the TTL (its prompt says so via the claim-first contract); the dispatcher kills at 900 s without evidence. `renewed` heartbeats never reach trackers (23-CONTEXT D23-02), so the watch polls `graph_get`, not Linear.
- Completion path: session calls `graph_complete` with its `lease_id` + `dod{summary, tests_pass}`; the Phase 23 gate moves Linear to Done via the connector. The dispatcher's job ends at landed-claim; it does not wait for Done. An exit *after* landing is success (session released/completed); an exit *without* landing is `[exited-unclaimed]` + label removal + give-up.
- Swarm edge: none — the dispatcher launches `hermes` only (and `claude-code` via host). A dispatched node stolen by a swarm surface later is the mirror's `stolen` path, not dispatcher business.
</lease>

<labelpath>
## Linear Label Ingestion Path (dispatcher vs connector poller)

- The dispatcher's poll is its own Linear GraphQL query (`DISPATCH_QUERY`: first 50 unstarted issues with a `dispatch:*` label, `Candidate{issue_id, identifier, team_id, team_key, surface, dispatch_label_id, dispatch_label}`). It does not consume `hermes-linear-poller.service` (the connector's `poller_main` loop in `/root/src/repos/hermes-linear-connector`, working for the connector's own sync) and shares no queue, cursor or offset file with it.
- Write discipline (D24-11): one idempotent marker comment per non-dispatch (tag scan over last 50 comments); label removal only of the candidate's own `dispatch:<surface>` label on give-up paths, via additive `removedLabelIds`; the `dispatch:*` → `agent:<surface>` move on landed claims is the Phase 23 mirror's write, never the dispatcher's. No `labelIds` overwrite anywhere (23-CONTEXT D23-05); no issue creation (SWC workspace at Free-plan cap, 23-CONTEXT D23-08/09).
- Refusal vocabulary vs closed kinds (DISP-02 × Phase 17): every marker resolves to an existing kind — terminal give-ups (`exited-unclaimed`, `claim-timeout`, plus the safety refusals) emit `dispatch.failed` (kind `warning`); launches emit `dispatch.outcome` (kind `note`); transient states (`host-unreachable`, already-commented skips) emit nothing. No new `EVENT_KINDS`, no new `SURFACES` (loop acts as `substrate`).
</labelpath>

<worktree>
## Worktree / Session Lifecycle (branch lifecycle, verified against host)

1. `validate_ids` (IN-02): identifier/node/graph/repo regexes before any checkout or worktree — `invalid-ids` gives up once, no retry.
2. `repo_checkout`: `<REPOS_ROOT>/<name>` must exist with `.git` and an origin matching `owner/name` (case-insensitive, `.git` ignored) — else `no-checkout`.
3. Worktree at `/var/lib/substrate/worktrees/<graph_id>` on `substrate/<graph_id>`: reused iff `git worktree list --porcelain` registers it; created from existing branch, else new branch; refused below 5 GiB free on `/` (`low-disk`, before any git call), on path-conflict, or on git failure. Nothing ever deletes a directory or touches the main checkout.
4. Prompt rendered to `STATE_DIR/prompts/<graph_id>.md` (0600): claim-first curl, `issue_get` as UNTRUSTED text, complete-with-DoD curl, release-and-stop curl. Bearer via runtime file read (D24-03). Hermes launched headless (`hermes chat --query-file`, cwd = worktree, allowlisted env, toolsets `terminal,file`, no `--worktree`, approvals on).
5. Registry watch per tick (reap → tick): landed-claim evidence → success (slot kept until process exit, then freed); process exit without evidence → `[exited-unclaimed]` + label removal + give-up; 900 s without evidence → SIGTERM, +10 s → SIGKILL → `[claim-timeout]` + label removal + give-up. Cap 2 sessions, one per issue; given-up ids persisted (D24-05).
6. Loop ends sessions with it: unit `KillMode=control-group` + `TimeoutStopSec=15` (D-15 kill switch semantics); restart ends dispatched sessions too — accepted, recorded in the runbook.
</worktree>

<identity>
## Identity Manifest Row This Phase Activates (Phase 20, `infra/identity/clients.json`)

One `dormant:24` row: `dispatcher` (surface `substrate`, env-file `/etc/substrate/substrate-dispatcher.env`, variable `SUBSTRATE_TOKEN_SUBSTRATE`, evidence "expected 401s counted in unattributed 4xx points until the restoring phase"). At switch-on its 401s were recorded expected-and-harmless (dispatch disabled, unit idling). This phase's gated restart flips it live and the runbook's expected-dormant count drops by one. The manifest flips to `live` only after the gated restart — NOT in this phase's PR (CONTEXT integration points). (Sibling: `substrate-host` `dormant:31`, untouched here.)
</identity>

<september_evidence>
## September Live Evidence (rehearsal regression script)

- 02-09 tracer: Hermes ignores SIGTERM → terminate-then-kill + `TimeoutStopSec=15` (replay: fake session that traps TERM; assert SIGKILL path + `[claim-timeout]`/`[exited-unclaimed]`).
- 02-08: Anthropic per-model 429 with 600 s backoff → 900 s timeout + `SUBSTRATE_DISPATCH_MODEL` override (replay: slow-to-claim fake; 600 s-backoff-shaped delay still lands).
- 02-09: Hermes v0.21.4 warns on unknown MCP toolset → no MCP toolsets passed, `terminal,file` only (host has v0.21.5; assert argv contains no `mcp-*` toolset).
- WR-04: `--once` without `--dry-run` refused, exit non-zero, launches nothing (replay as a unit test + smoke negative).
- IN-02/a0c5b11: unsafe ids refused before checkout with `[invalid-ids]` (replay: `../escape`-shaped graph id; assert zero git calls).
- 03-05/98cf59d: dispatcher restart forgets the VM handle; the host keeps the task (replay for host path: registry drop ≠ task kill; documents why given_up.json covers Hermes but claude-code relies on `host-unreachable` retry).
- D-15 loop semantics: second instance exits 3 on the flock without polling (replay: two `--once --dry-run` holders).
</september_evidence>

<host_facts>
## Host Facts Constraining the Plans (names only, no values read)

- `hermes` v0.21.5 present (`/usr/local/bin/hermes` shim + `/root/.local/bin/hermes`); `hermes-linear-poller.service` active path `/root/src/repos/hermes-linear-connector` (connector-owned, untouched).
- `/var/lib/substrate/dispatcher/` exists (`dispatcher.lock`, `prompts/`, `sessions/`) with September leftovers; `/var/lib/substrate/worktrees/` holds `ut-mugbqivi-752f2dad`, `ut-mughkkc0-73909228` (D24-13: left alone).
- `substrate-dispatcher` unit currently `inactive (dead)`, `NRestarts=0` — the September crash-loop (`NRestarts=114888`, `__pycache__`-only code, kill switch on) is over because there is no code left to crash on; the unit file itself is absent from `infra/vps/` on main (only `__pycache__` under `packages/dispatcher/`).
- No `/etc/substrate/substrate-dispatcher.env` yet (gated provisioning, plan 24-04); `/etc/substrate/tokens/` exists (Phase 20).
- Root `test:py` covers `packages/miner/tests` only — extension to `packages/dispatcher/tests` is in scope (24-03).
- Main HEAD `60bd0c1`; suite baseline 2706 pass / 58 skip / 1 known fail (F-01) + 1 env-caused rehearsal-guard fail (assignment brief). Failures at HEAD are recorded, not fixed.
</host_facts>

<pitfalls>
## Pitfalls Carried Into the Plans

1. **Merge = deploy** (SUMMARY Pitfall 1): staging the unit file is safe; restarting the production unit and provisioning the env file are gated. Every plan states its live effect (none, until 24-04's gated steps).
2. **Porting by merge** (Pitfall 2): reference implementations only; the three auth diffs + event emission are rewritten, never cherry-picked — `rg Bearer` on ported files must show only the two new call sites + prompt template; `rg propose-key|labelIds|x-substrate` must be clean.
3. **Lease authority** (Pitfall 4): no `lease_id` in dispatcher code, prompts (except the session's own `<your session id>` placeholder it fills itself), events, or comments. A leak test (planted lease id through tick + prompt render + emit) asserts absence everywhere — mirrors 23-VERIFICATION truth 10.
4. **Store-lock bypass** (Pitfall 8): dispatcher code names no `GREPTIME_*`/`RAGFLOW_*`/`HINDSIGHT_*`; token paths in prose, never `NAME=<path>` (Phase 20 spelling rule).
5. **Double dispatch** (Pitfall 5): flock + cap-2 + one-per-issue + persisted given-up close the four double-launch paths (second process, second tick, second issue-label, post-restart). The smoke asserts each.
6. **Issue text in prompts** (DISP-07): prompt template contains zero issue text by construction (ids only); a test renders the template and asserts the title/description strings of a fixture issue appear nowhere. The `issue_get` reply is labelled UNTRUSTED in the template (branch wording kept).
7. **PR size** (Pitfall 14): four plans; the 559-line `test_dispatch.py` rides with its engine in 24-02, not in a separate test plan.
8. **Test isolation** (Pitfall 13): Python tests use `httpx.MockTransport`/monkeypatched runners/tmp dirs only — never `/var/lib`, never loopback ports, never the production checkout. The smoke runs in a detached worktree against the harness twin.
9. **Baseline discipline**: suite baseline recorded at plan time; failures at HEAD recorded, not fixed.
</pitfalls>

<plan_split>
## Plan Split (4 plans, 2 waves + gated tail)

- **24-01 (wave 1): poll + node-read + worktree port.** P-01..P-06. DISP-01 (poll half) + DISP-03. Files: `linear.py`, `mcp.py` (+substrate bearer), `worktree.py`, `__init__.py`, `tests/test_clients.py`, `tests/test_worktree.py`.
- **24-02 (wave 1): launch + watch + route port.** P-07..P-14. DISP-02, DISP-04, DISP-05, DISP-06 (with D24-05 persistence), DISP-07. Files: `launcher.py`, `sessions.py`, `dispatch.py`, `host.py`, `tests/test_launcher|test_sessions|test_dispatch|test_host.py`. No file overlap with 24-01 → same wave.
- **24-03 (wave 2, depends on 24-01 + 24-02): loop + packaging + staged unit.** P-15..P-18, `test:py` extension, `smoke:dispatcher` script stub (wired fully in 24-04). DISP-01 (loop half). Files: `__main__.py`, `tests/test_main.py`, `pyproject.toml`, `package.json`, `infra/vps/substrate-dispatcher.service`.
- **24-04 (wave 3, depends on 24-01..03): rehearsal proof + docs + gated live tail.** `--once --dry-run` smoke against the harness twin with fake Linear/MCP/Hermes (incl. all September incident replays + double-launch matrix), `docs/dispatcher.md`, `docs/runbooks/dispatch-proof.md` (DISP-08 sequence), production-identity runbook delta (staged, not applied), and the explicit OPERATOR-GATED live tail (env provisioning → bounded window → proof → kill-switch-on → restart → manifest flip). DISP-08.
</plan_split>

<open_questions>
## Open Questions — all resolved by auto-accept (no operator input needed)

1. Marker superset (11 vs 13) → D24-04 (superset; contract unchanged).
2. Given-up persistence shape → D24-05 (flat JSON list under STATE_DIR).
3. Prompt token-path spelling → D24-03 (Phase 20 tokens-dir hermes file, asserted against token.ts).
4. host.py now vs Phase 31 → D24-06 (now; leaf-stable, half-wired tick is worse).
5. September worktrees → D24-13 (leave; reuse rule fails closed).
6. Stale lock/previous given-up state → operator informational (flock is kernel-held; registry re-reads given_up.json).
</open_questions>
