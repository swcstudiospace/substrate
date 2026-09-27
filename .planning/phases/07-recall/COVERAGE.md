# Coverage — Phase 7 (Recall)

> Full coverage by default. Opt-outs are explicit, reasoned decisions.
> Plans: 07-01 (Phase 6 gate, baseline, rollback area, t0 agent-config snapshot, backfill/redaction inventory), 07-02 (owner checkpoint: env lines, Railway report, version ≥ 0.9.29, isolation and contract spike),
> 07-03 (redact() D-04 classes), 07-04 (tracer: client, record shaping, context_search MCP + REST, fail-open),
> 07-05 (forwarder: gate, cursor, replay, 14-day backfill, emit/writeMemory/boot wiring), 07-06 (retire hindsight and supermemory; substrate MCP in Claude Code and Hermes), 07-07 (proof D-12, final gates).
> Task references are `plan / task` (e.g. 07-05 T3). D-01..D-12 are the owner-accepted decisions in 07-CONTEXT.md (2026-09-26).

## ROADMAP success criteria and proof → plan/task

| Criterion | Covered by | Evidence key(s) |
|---|---|---|
| SC-1 `context_search` (MCP) and `POST /context/search` proxy Agentmemory's search **as re-scoped by D-05** (`/search` with `format:"full"`, not smart-search — smart-search ignores `project` and returns content-less hits) using AGENTMEMORY_URL/AGENTMEMORY_SECRET from substrate.env; results carry `graph_id`, `repo`, `surface`, marked untrusted; an outage or missing key returns an empty result with the reason logged, never a caller error | 07-02 T1-T3 (env lines, response shape), 07-04 T1 (config, client, 2 s deadline), 07-04 T2 (searchContext, MCP, REST, fail-open tests), 07-04 T3 (live tracer + three live fail-open modes), 07-07 T2 (a real agent uses it), 07-07 T3 (`smart_search_unused`) | 07-04-TRACER.md `mcp_found`, `mcp_hit_graph`, `mcp_hit_repo`, `mcp_hit_surface`, `mcp_notice`, `rest_http=200`, `failopen_*_http=200`, `failopen_*_reason`, `failopen_log_line=true`; 07-PROOF.md `claude_reply_has_token`, `smart_search_unused=true` |
| SC-2 the substrate forwards already-redacted `session.end` summaries, handoffs and memory notes with `project=<repo>`, `agentId=<surface>` and the Graph ID; nothing leaves the VPS before `redact()` | 07-03 T1 (D-04 rules), 07-04 T1 (rememberBody: header, concepts, project/agentId, forward-time redact, 8 KB cap), 07-05 T1-T3 (forwarder, wiring, live fixture) | 07-04-TRACER.md `tracer_header_line_ok=true`; 07-05-SMOKE.md `backfill_forwarded` = `backfill_expected_events`, `fixture_search_value_leaks=0`, `fixture_stored_value_leaks=0`, `live_hit_surface`, `live_hit_repo` |
| SC-3 Agentmemory **≥ 0.9.29 (floor raised from 0.9.28 by D-08)** with per-agent isolation (#817; agentId on /remember only since 0.9.29, #1205), checked before the first write | 07-02 T3 (live version gate + isolation before any forward), 07-05 T1 (gate before every drain until it passes), 07-05 T3 (live gate log line) | 07-02-SPIKE.md `version_gate=pass`, `agentmemory_version`, `scoped_other_agent_found=false`, `wildcard_agent_found=true`, `other_project_found=false`; 07-05-SMOKE.md `gate_log_line=true`, `agentmemory_version_live` |
| SC-4 hindsight (Claude Code) and supermemory (Hermes) retired in favour of `context_search`, each with a restore route written first | 07-01 T1 (t0 snapshot), 07-06 T1 (Claude Code), 07-06 T2 (Hermes), 07-07 T3 (still retired at phase end) | 07-06-SMOKE.md `cc_restore_route_written=true`, `cc_hindsight_mcp_after=absent`, `cc_hindsight_hooks_after=0`, `cc_session_has_context_search=true`, `hm_restore_route_written=true`, `hm_status_provider=none`, `hm_mcp_test_exit=0`, `retire_result=pass`; 07-PROOF.md `hindsight_retired`, `supermemory_retired` |
| **Proof** — a fact recorded in one agent's session is recalled, with its Graph ID, by a different agent's `context_search` (procedure D-12) | 07-07 T1-T2 | 07-PROOF.md `omp_memory_write_call=true`, `pg_row_writer=omp`, `forwarded_log_line=true`, `claude_tool_graph_id` = `proof_graph`, `tool_result_surface=omp`, `claude_prompt_has_token=false`, `claude_reply_has_token=true`, `proof_result=pass` |

## Decisions D-01..D-12 → plan/task

| Decision | Covered by | How |
|---|---|---|
| D-01 forward only already-redacted session.end, handoff and complete summaries plus memory_write entries (decision/warning/note); no transcripts | 07-01 T2 (volume), 07-04 T1 (`FORWARD_EVENT_KINDS`, `FORWARD_MEMORY_KINDS`), 07-05 T1 (source SQL filter + named D-01 test), 07-05 T3 (backfill = independent count) | MEMORY_KINDS has no `note`: planner maps D-01's `note` to the `fact` memory kind and forwards memory `handoff` entries under D-01's handoff clause; `todo` is never forwarded (open question 1). Events: exactly session.end, handoff, complete |
| D-02 `POST /remember` with project, agentId, concepts [graph, repo, surface] and the content header line; not `/observe` | 07-04 T1 (rememberBody + named header test), 07-04 T3 (live header check), 07-07 T3 (`observe_unused=true`) | a second header line `<event|memory>:<id> kind:<k> ts:<iso>` is added below D-02's exact first line: it carries the original ts for results and keeps same-graph, near-identical summaries under Jaccard 0.7 apart while an exact replay still supersedes (research § 3, open question 5) |
| D-03 async after the Greptime write; outage → drop + log; forwarded-id cursor replays from Greptime; no spool | 07-05 T1 (drain, failure policy, named outage test), 07-05 T2 (enqueue after the write, never awaited — named test with a hung client), 07-05 T3 (live outage → replay on throwaway drains; `emit_ms_max` < 1500) | enqueue only schedules a drain; every forward is a replay from the stores after the cursor; memory notes replay from Postgres (their source of truth — they are not in Greptime), events from Greptime by `ingested_at` |
| D-04 extend redact() with AKIA, AIza, xoxb-, npm_, glpat-, dop_v1_, sk-proj-, pk-/rk-, `<private>`, case-insensitive api_key; fixture-tested; cap content at 8 KB and concepts count | 07-01 T2 (gap measured), 07-03 T1 (rules + 5 named tests, no literal shapes committed), 07-04 T1 (re-redaction at forward time, 8 KB code-point cap, ≤ 8 concepts), 07-05 T3 (live fixture) | `redact_gap_unchanged` measured before; `fixture_search_redacted_count` ≥ 10 and 0 leaks after |
| D-05 `/search` format full; project filter with a repo; agentId `*` or a named surface; graph_id client-side after over-fetch; supersedes SC1's "smart search" | 07-02 T3 (response field names), 07-04 T2 (request shape tests, named graph filter test), 07-04 T3 (other-graph and other-surface live misses), 07-07 T3 (`smart_search_unused=true`) | over-fetch factor 5 when graph_id or repo is given (≤ 100); results keep Agentmemory's order |
| D-06 MCP `context_search {query, repo?, graph_id?, surface?, limit ≤ 20}` and `POST /context/search`; results `{text, graph_id, repo, surface, ts, score}` framed UNTRUSTED; open to VM guests like docs_search | 07-04 T2 (named open-session and anonymous-REST tests, 413 test), 07-04 T3 (anonymous live calls), 07-07 T2 (anonymous session config) | no proposeAllowed check; CONTEXT_NOTICE on every reply |
| D-07 no brief integration | 07-04 T2 (verify: brief.ts unchanged since the baseline head), 07-07 T3 (`brief_unchanged=true`) | agents call context_search on demand |
| D-08 own 2 s deadline; 5xx/504/401/success:false/network → empty + logged reason; boot/first-write gate `health.version ≥ 0.9.29`, else forwarding off while search fails open; SC3 floor raised | 07-04 T1 (named deadline test), 07-04 T2 (named failure-class test), 07-04 T3 (live unreachable/unauthorized/unconfigured), 07-02 T3 (live version), 07-05 T1 (named gate test), 07-05 T3 (live gate line) | search does not consult the gate (it fails open on its own); forwarding re-checks the gate before each drain until it passes |
| D-09 Claude Code: remove hindsight MCP entry and hooks (backup + restore first; data left on disk); register substrate MCP | 07-01 T1 (t0), 07-06 T1 | `claude mcp remove hindsight -s user`; jq removal of the three hook groups with a semantic compare; `claude mcp add --transport http --scope user substrate …`; headless session proves the tool is visible; `/root/.hindsight` file count unchanged |
| D-10 Hermes: memory.provider supermemory → none; reach context_search through the existing substrate route (planner confirms connector tool vs MCP entry); no native agentmemory plugins | 07-06 T2, 07-01 T1 + 07-06 T1/T2 + 07-07 T3 (native-plugin checks) | **planner confirmation:** Hermes has no substrate MCP route today (its link is the prompt-uplift plugin's REST /brief + /events; the grok-hermes-connector substrate tools are served to Grok Bot, not registered in Hermes) → an `mcp_servers.substrate` HTTP entry with `tools.include: [context_search]`; "none" = `hermes memory off` (provider "", status "(none — built-in only)") |
| D-11 substrate the only secret holder; one agentId per surface; scope shared; one-time 14-day backfill then continuous | 07-02 T2 (owner: scope shared, single holder), 07-02 T3 (`secret_only_in_env`), 07-04 T1 (agentId = surface), 07-05 T1/T3 (backfill + continuous), 07-07 T3 (`secret_only_in_env`, `journal_secret_free`) | backfill runs on the first boot without a cursor; `backfill_has_tracer=true` shows it covers pre-restart records |
| D-12 proof: headless Omp records a decision in graph X; headless `claude -p` with a session-scoped `--mcp-config` recalls it with graph X via context_search | 07-07 T1-T2 | Omp writes through memory_write via its shell tool (no substrate MCP in Omp; open question 4); the codename exists only in the Omp decision, so Claude's answer can only come from recall |

## CONTEXT discretion items (planner choices)

| Item | Choice | Covered by |
|---|---|---|
| Cursor storage | File `/var/lib/substrate/recall/cursor.json` (0600 root, 0700 dir, tmp+rename), not a table: no schema change in the shared Greptime/Postgres stores; RESTORE is a file delete (with the code revert); malformed → forwarding off, never overwritten | 07-05 T1 (named cursor test), 07-05 T3 (modes, `backfill_done`) |
| Backfill batching | `REPLAY_BATCH = 100` per page, serialized single drain, cursor written after every forward; the planning-time volume is ~10 records | 07-05 T1 |
| Over-fetch factor | 5× when graph_id or repo is given, capped at Agentmemory's 100 | 07-04 T2 |
| Memory replay overlap | re-read 10 s behind the `created` watermark and skip ids in `recent`, so a Postgres commit-order inversion is not skipped | 07-05 T1 (named overlap test) |

## Orchestrator constraints → plan/task

| Constraint | Covered by |
|---|---|
| Wave 0 gates on the prior phase (VERIFICATION passed or recorded acceptance), disk ≥ 10 GiB, re-measures bun/tsc/dispatcher, creates phase7-baseline with RESTORE.md + RESTORE.d | 07-01 T1 |
| Credentials presence-checked only; absent at execution → blocking human-action checkpoint with exact no-echo append commands (05-02 T2 step 6 model) | 07-02 T1-T3 |
| Tracer-first; TDD tasks marked tdd="true" | 07-04 T3 (`type="tracer"`, after the TDD client/search tasks); 07-03 T1, 07-04 T1/T2, 07-05 T1/T2 `tdd="true"` |
| RESTORE route before every live change | RESTORE.d/07-02 (env lines, rotation, spike), 07-04 (code, tracer memory), 07-05 (code, cursor, retraction, fixture), 07-06 (Claude Code, Hermes), 07-07 (proof files, proof memory) |
| Two-sided gates against the wave-0 baseline | every code task's `<automated>`; dispatcher in 07-01 T1, 07-05 T2, 07-07 T3 |
| Explicit-path staging; commits `Refs SPE-3576` | every action; commit bodies checked in the verifies |
| Phase 7 edits service.ts/mcp.ts/server.ts additively and re-reads them (Phase 6 changed emit) | 07-04 and 07-05 interfaces ("re-read at execution; anchor by symbol"); 07-05 T2 places enqueue beside any Phase 8 hook |
| Phase 8 coordination (Phase 8 caches context_search) | 07-04 objective and interfaces: `config.agentmemory`, `Substrate.searchContext(input, surface) → {notice, results, reason?}`, `reason` = fail-open empty (never cached), one fire-and-forget tool.call per call, modules under `recall/` — agreed with the Phase 8 planner |

## Standing rules → plan/task

| Rule | Covered by |
|---|---|
| Two-sided gates against a measured `07-BASELINE.md` | 07-01 T1; every code task |
| Snapshot under `/var/lib/substrate/phase7-baseline/` with a RESTORE route before any live edit | 07-01 T1 (index + t0), 07-06 (pre-edit snapshot), RESTORE.d/07-02..07-07 |
| Read `/var/lib/substrate/phase1-baseline/RESTORE.md` before touching a Phase 1 file | 07-01 T1 cites it; Phase 7 touches no Phase 1 snapshotted file |
| Never print secrets | `grep -c` presence; keyed probes print key=value only; evidence checked with `grep -F -f` against the configured secret and URL; fixtures built at run time; final host + journal scan (07-07 T3) |
| Fail open for callers | context_search (07-04), forwarding off the caller path (07-05 T2), throwaway instances never write (07-04 T3, 07-05 T3) |

## Capability coverage (INTEGRATE / OPT-OUT)

| capability | decision | reason |
|---|---|---|
| Agentmemory `POST /remember`, `POST /search` (format full), `GET /health`, `POST /forget` | INTEGRATE | D-02, D-05, D-08; forget for spike/tracer cleanup and the retraction route |
| Agentmemory `POST /smart-search` | OPT-OUT | D-05: ignores `project`, compact hits have no content |
| Agentmemory `POST /observe` | OPT-OUT | D-02: 400-char truncation, drops agentId (#1159), 500-per-session cap |
| Agentmemory `/context`, `/session/start|end`, facets | OPT-OUT | not query-driven / not needed (research § 2); no brief integration (D-07) |
| Agentmemory native Claude Code plugin/hooks, Hermes plugin, `@agentmemory/mcp` shim | OPT-OUT | D-10: they bypass redact(); checked absent (07-01, 07-06, 07-07) |
| Brief "Related past work" section | OPT-OUT | CONTEXT § Deferred (revisit after Phase 8) |
| New npm dependency | OPT-OUT | global fetch, zod and bun SQL suffice (07-04 T1 checks manifests) |
| Claude Code user-scope MCP registration; Hermes `mcp_servers` entry | INTEGRATE | D-09, D-10 |
| Omp substrate MCP registration | OPT-OUT | not in D-09/D-10; the proof uses Omp's shell tool against the anonymous MCP endpoint (open question 4) |

## Open questions carried to the orchestrator / owner

1. D-01 names memory kinds "decision/warning/note"; MEMORY_KINDS has no `note`. Plans forward `fact` as note and include memory `handoff` entries (D-01's handoff clause); `todo` is excluded. Owner may narrow to decision/warning/fact.
2. Registering the substrate at user scope gives host Claude Code sessions every substrate tool (guarded ones refuse anonymously; graph/memory/event tools do not). Owner may want `permissions.deny` for mutating substrate tools in ~/.claude/settings.json — not planned (not in D-09).
3. ROADMAP SC1 ("smart search") and SC3 (0.9.28) wording must be amended per D-05/D-08 by the orchestrator; plans do not edit ROADMAP.md (recorded in 07-PROOF.md Gaps).
4. D-12's Omp write goes through Omp's shell tool (curl JSON-RPC to the anonymous MCP endpoint) because Omp has no substrate MCP registration; if the owner prefers a native Omp tool, that is an Omp config change outside this phase.
5. Supersession across near-identical records in one graph (research OQ 5) is mitigated by the second header line; if Agentmemory still collapses distinct records (a `similarTo` on /remember), the forwarder still counts the forward as done; 07-05 and 07-07 record any such collapse under `## Gaps`.
