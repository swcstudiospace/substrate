# Coverage — Phase 7 (Recall)

> Full coverage by default. Opt-outs are explicit, reasoned decisions.
> Plans: 07-01 (Phase 6 gate, baseline, rollback area, t0 agent-config snapshot, backfill/redaction inventory), 07-02 (owner checkpoint: env lines, Railway report, version ≥ 0.9.29, isolation and contract spike),
> 07-03 (redact() D-04 classes), 07-04 (read path + record shape, code only: client, rememberBody, searchContext, context_search MCP + REST), 07-05 (tracer: first restart, one live record end to end, live fail-open),
> 07-06 (forwarder: gate, cursor, replay, 14-day backfill, emit/writeMemory/boot wiring), 07-07 (retire hindsight and supermemory; substrate MCP in Claude Code and Hermes), 07-08 (proof D-12, final gates).
> Task references are `plan / task` (e.g. 07-06 T3 Revised after plan-check iteration 1 (agent://Check07): 07-04 was split into 07-04 (code) and 07-05 (tracer), so the old 07-05/06/07 are now 07-06/07/08; waves 0-6. D-01..D-12 are the owner-accepted decisions in 07-CONTEXT.md (2026-09-26 Revised after plan-check iteration 1 (agent://Check07): 07-04 was split into 07-04 (code) and 07-05 (tracer), so the old 07-05/06/07 are now 07-06/07/08; waves 0-6.

## ROADMAP success criteria and proof → plan/task

| Criterion | Covered by | Evidence key(s) |
|---|---|---|
| SC-1 `context_search` (MCP) and `POST /context/search` proxy Agentmemory's search **as re-scoped by D-05** (`/search` with `format:"full"`, not smart-search — smart-search ignores `project` and returns content-less hits) using AGENTMEMORY_URL/AGENTMEMORY_SECRET from substrate.env; results carry `graph_id`, `repo`, `surface`, marked untrusted; an outage or missing key returns an empty result with the reason logged, never a caller error | 07-02 T1-T3 (env lines, response shape), 07-04 T1 (config, client, 2 s deadline), 07-04 T2 (searchContext, MCP, REST, fail-open tests), 07-05 T1 (live tracer + three live fail-open modes), 07-08 T2 (a real agent uses it), 07-08 T3 (`smart_search_unused`) | 07-05-TRACER.md `mcp_found`, `mcp_hit_graph`, `mcp_hit_repo`, `mcp_hit_surface`, `mcp_notice`, `rest_http=200`, `failopen_*_http=200`, `failopen_*_reason`, `failopen_log_line=true`; 07-PROOF.md `claude_reply_has_token`, `smart_search_unused=true` |
| SC-2 the substrate forwards already-redacted `session.end` summaries, handoffs and memory notes with `project=<repo>`, `agentId=<surface>` and the Graph ID; nothing leaves the VPS before `redact()` | 07-03 T1 (D-04 rules), 07-04 T1 (rememberBody: header, concepts, project/agentId, forward-time redact, 8 KB cap), 07-06 T1-T3 (forwarder, wiring, live fixture) | 07-05-TRACER.md `tracer_header_line_ok=true`; 07-06-SMOKE.md `backfill_forwarded` = `backfill_expected_events`, `fixture_search_value_leaks=0`, `fixture_stored_value_leaks=0`, `live_hit_surface`, `live_hit_repo` |
| SC-3 Agentmemory **≥ 0.9.29 (floor raised from 0.9.28 by D-08)** with per-agent isolation (#817; agentId on /remember only since 0.9.29, #1205), checked before the first write | 07-02 T3 (live version gate + isolation before any forward), 07-06 T1 (gate before every drain until it passes), 07-06 T3 (live gate log line) | 07-02-SPIKE.md `version_gate=pass`, `agentmemory_version`, `scoped_other_agent_found=false`, `wildcard_agent_found=true`, `other_project_found=false`; 07-06-SMOKE.md `gate_log_line=true`, `agentmemory_version_live` |
| SC-4 hindsight (Claude Code) and supermemory (Hermes) retired in favour of `context_search`, each with a restore route written first | 07-01 T1 (t0 snapshot), 07-07 T1 (Claude Code), 07-07 T2 (Hermes), 07-08 T3 (still retired at phase end) | 07-07-SMOKE.md `cc_restore_route_written=true`, `cc_hindsight_mcp_after=absent`, `cc_hindsight_hooks_after=0`, `cc_session_has_context_search=true`, `hm_restore_route_written=true`, `hm_status_provider=none`, `hm_mcp_test_exit=0`, `retire_result=pass`; 07-PROOF.md `hindsight_retired`, `supermemory_retired` |
| **Proof** — a fact recorded in one agent's session is recalled, with its Graph ID, by a different agent's `context_search` (procedure D-12) | 07-08 T1-T2 | 07-PROOF.md `omp_memory_write_call=true`, `pg_row_writer=omp`, `forwarded_log_line=true`, `claude_tool_graph_id` = `proof_graph`, `tool_result_surface=omp`, `claude_prompt_has_token=false`, `claude_reply_has_token=true`, `proof_result=pass` |

## Decisions D-01..D-12 → plan/task

| Decision | Covered by | How |
|---|---|---|
| D-01 forward only already-redacted session.end, handoff and complete summaries plus memory_write entries (decision/warning/note); no transcripts | 07-01 T2 (volume), 07-04 T1 (`FORWARD_EVENT_KINDS`, `FORWARD_MEMORY_KINDS`), 07-06 T1 (source SQL filter + named D-01 test), 07-06 T3 (backfill = independent count) | MEMORY_KINDS has no `note`: the planner maps D-01's `note` to the `fact` memory kind; the forwarded memory kinds are exactly decision, warning, fact (W5 — memory `handoff` and `todo` are not forwarded unless the owner widens D-01 before 07-04 runs, open question 1). Events: exactly session.end, handoff, complete |
| D-02 `POST /remember` with project, agentId, concepts [graph, repo, surface] and the content header line; not `/observe` | 07-04 T1 (rememberBody + named header test), 07-05 T1 (live header check), 07-08 T3 (`observe_unused=true`) | a second header line `<event|memory>:<id> kind:<k> ts:<iso>` is added below D-02's exact first line: it carries the original ts for results and keeps same-graph, near-identical summaries under Jaccard 0.7 apart while an exact replay still supersedes (research § 3, open question 5) |
| D-03 async after the Greptime write; outage → drop + log; forwarded-id cursor replays from Greptime; no spool | 07-06 T1 (drain, failure policy: only per-record 400/413/422/`success:false` rejections are skipped, every outage-class error stops the drain and is retried from the cursor forever — named tests incl. "D-03 an outage longer than 3 attempts forwards every record after recovery"; keyset memory paging), 07-06 T2 (enqueue after the write, never awaited — named test with a hung client), 07-06 T3 (live outage → replay on throwaway drains; `emit_ms_max` < 1500) | enqueue only schedules a drain; every forward is a replay from the stores after the cursor; memory notes replay from Postgres (their source of truth — they are not in Greptime), events from Greptime by `ingested_at` |
| D-04 extend redact() with AKIA, AIza, xoxb-, npm_, glpat-, dop_v1_, sk-proj-, pk-/rk-, `<private>`, case-insensitive api_key; fixture-tested; cap content at 8 KB and concepts count | 07-01 T2 (gap measured), 07-03 T1 (rules + 5 named tests, no literal shapes committed), 07-04 T1 (re-redaction at forward time of content and of graph/repo/surface before they become concepts/project/agentId — W3, named test), 07-04 T2 (query redacted before /search — W3, named test; 8 KB code-point cap, ≤ 8 concepts), 07-06 T3 (live fixture) | `redact_gap_unchanged` measured before; `fixture_search_redacted_count` ≥ 5 and 0 leaks after (search reply and stored copies) |
| D-05 `/search` format full; project filter with a repo; agentId `*` or a named surface; graph_id client-side after over-fetch; supersedes SC1's "smart search" | 07-02 T3 (response field names), 07-02 T3 (over-fetch tokens_budget/truncated — W4), 07-04 T2 (request shape tests, explicit token_budget 200 000 and a `truncated` reason — W4, named test, named graph filter test), 07-05 T1 (other-graph and other-surface live misses), 07-08 T3 (`smart_search_unused=true`) | over-fetch factor 5 when graph_id or repo is given (≤ 100); results keep Agentmemory's order |
| D-06 MCP `context_search {query, repo?, graph_id?, surface?, limit ≤ 20}` and `POST /context/search`; results `{text, graph_id, repo, surface, ts, score}` framed UNTRUSTED; open to VM guests like docs_search | 07-04 T2 (named open-session and anonymous-REST tests, 413 test), 07-05 T1 (anonymous live calls), 07-08 T2 (anonymous session config) | no proposeAllowed check; CONTEXT_NOTICE on every reply |
| D-07 no brief integration | 07-04 T2 (verify: brief.ts unchanged since the baseline head), 07-08 T3 (`brief_unchanged=true`) | agents call context_search on demand |
| D-08 own 2 s deadline; 5xx/504/401/success:false/network → empty + logged reason; boot/first-write gate `health.version ≥ 0.9.29`, else forwarding off while search fails open; SC3 floor raised | 07-04 T1 (named deadline test), 07-04 T2 (named failure-class test), 07-05 T1 (live unreachable/unauthorized/unconfigured), 07-02 T3 (live version), 07-06 T1 (named gate test), 07-06 T3 (live gate line) | search does not consult the gate (it fails open on its own); forwarding re-checks the gate before each drain until it passes |
| D-09 Claude Code: remove hindsight MCP entry and hooks (backup + restore first; data left on disk); register substrate MCP | 07-01 T1 (t0), 07-07 T1 | `claude mcp remove hindsight -s user`; jq removal of the three hook groups with a semantic compare; `claude mcp add --transport http --scope user substrate …`; headless session proves the tool is visible; `/root/.hindsight` file count unchanged |
| D-10 Hermes: memory.provider supermemory → none; reach context_search through the existing substrate route (planner confirms connector tool vs MCP entry); no native agentmemory plugins | 07-07 T2, 07-01 T1 + 07-07 T1/T2 + 07-08 T3 (native-plugin checks) | **planner confirmation:** Hermes has no substrate MCP route today (its link is the prompt-uplift plugin's REST /brief + /events; the grok-hermes-connector substrate tools are served to Grok Bot, not registered in Hermes) → an `mcp_servers.substrate` HTTP entry with `tools.include: [context_search]`; "none" = `hermes memory off` (provider "", status "(none — built-in only)") |
| D-11 substrate the only secret holder; one agentId per surface; scope shared; one-time 14-day backfill then continuous | 07-02 T2 (owner: scope shared, single holder), 07-02 T3 (`secret_only_in_env`, `secret_scan_exit=1`: secret passed to `sudo grep -rlsF -f -` on stdin, exit 1 required — B1), 07-04 T1 (agentId = surface), 07-06 T1/T3 (backfill + continuous, partitioned by the ingested_at snapshot M so no row falls between them — W1, named test; each path equals its independent count), 07-08 T3 (`secret_only_in_env`, `secret_scan_exit=1`, `journal_secret_free`) | backfill runs on the first boot without a cursor; `backfill_has_tracer=true` shows it covers pre-restart records |
| D-12 proof: headless Omp records a decision in graph X; headless `claude -p` with a session-scoped `--mcp-config` recalls it with graph X via context_search | 07-08 T1-T2 | Omp writes through memory_write via its shell tool (no substrate MCP in Omp; open question 4); the codename exists only in the Omp decision, so Claude's answer can only come from recall |

## CONTEXT discretion items (planner choices)

| Item | Choice | Covered by |
|---|---|---|
| Cursor storage | File `/var/lib/substrate/recall/cursor.json` (0600 root, 0700 dir, tmp+rename), not a table: no schema change in the shared Greptime/Postgres stores; RESTORE is a file delete (with the code revert); malformed → forwarding off, never overwritten | 07-06 T1 (named cursor test), 07-06 T3 (modes, `backfill_done`) |
| Backfill batching | `REPLAY_BATCH = 100` per page, serialized single drain, cursor written after every forward; the planning-time volume is ~10 records | 07-06 T1 |
| Over-fetch factor | 5× when graph_id or repo is given, capped at Agentmemory's 100 | 07-04 T2 |
| Memory replay overlap | re-read 10 s behind the `created` watermark and skip ids in `recent`, so a Postgres commit-order inversion is not skipped; later pages in a drain use keyset (created, id) so a page of already-seen ids still advances (I4) | 07-06 T1 (named overlap test) |
| Poison records | only a record-specific rejection (http 400/413/422, or `success:false`) is skipped; every other error (timeout, network, 401/403/404/408/429, 5xx, shape) stops the drain with the cursor unadvanced and is retried on every later drain — an outage never skips a record (D-03, plan-check iteration 2 NB1); `stuck` counts consecutive failures for a "forwarding stalled" log line every 10 drains; `forwarded_total` = every successful remember from any path | 07-06 T1 (named 400 test and named long-outage test) |

## Orchestrator constraints → plan/task

| Constraint | Covered by |
|---|---|
| Wave 0 gates on the prior phase (VERIFICATION passed or recorded acceptance), disk ≥ 10 GiB, re-measures bun/tsc/dispatcher, creates phase7-baseline with RESTORE.md + RESTORE.d | 07-01 T1 |
| Credentials presence-checked only; absent at execution → blocking human-action checkpoint with exact no-echo append commands (05-02 T2 step 6 model) | 07-02 T1-T3 |
| Tracer-first; TDD tasks marked tdd="true" | 07-05 T1 (`type="tracer"`, its own plan right after 07-04's TDD code — split for the context budget, W7); 07-03 T1, 07-04 T1/T2, 07-06 T1/T2 `tdd="true"` |
| RESTORE route before every live change | RESTORE.d/07-02 (env lines, rotation, spike), 07-03 / 07-04 / 07-06 (executable code routes — `C="$(git log -E --grep='^feat\(07-NN\)' --grep='^test\(07-NN\)' --grep='^fix\(07-NN\)' <head>..HEAD)"` then a revert loop over C, literal head, no placeholders — written before each plan's first commit because Restart=always runs the working tree; revert order 07-06 → 07-04 → 07-03; I3/W6), 07-05 (tracer memory), 07-06 (cursor, retraction, fixture), 07-07 (Claude Code, Hermes — literal snapshot paths, checked to resolve; W6), 07-08 (proof files, proof memory); guarded restarts (07-05 T1, 07-06 T3) need a clean packages/infra tree and run the code routes when /healthz does not return |
| Two-sided gates against the wave-0 baseline | every code task's `<automated>`; dispatcher in 07-01 T1, 07-06 T2, 07-08 T3 |
| Explicit-path staging; commits `Refs SPE-3576` | every action; commit bodies checked in the verifies |
| Phase 7 edits service.ts/mcp.ts/server.ts additively and re-reads them (Phase 6 changed emit) | 07-04 and 07-06 interfaces ("re-read at execution; anchor by symbol"); 07-06 T2 places enqueue beside any Phase 8 hook |
| Phase 8 coordination (Phase 8 caches context_search) | 07-04 objective and interfaces: `config.agentmemory`, `Substrate.searchContext(input, surface) → {notice, results, reason?}`, `reason` = fail-open empty or truncated list (never cached), one fire-and-forget tool.call per call, modules under `recall/` — agreed with the Phase 8 planner |

## Standing rules → plan/task

| Rule | Covered by |
|---|---|
| Two-sided gates against a measured `07-BASELINE.md` | 07-01 T1; every code task |
| Snapshot under `/var/lib/substrate/phase7-baseline/` with a RESTORE route before any live edit | 07-01 T1 (index + t0), 07-07 (pre-edit snapshot), RESTORE.d/07-02..07-08 |
| Read `/var/lib/substrate/phase1-baseline/RESTORE.md` before touching a Phase 1 file | 07-01 T1 cites it; Phase 7 touches no Phase 1 snapshotted file |
| Never print secrets | `grep -c` presence; keyed probes print key=value only; evidence checked with `grep -F -f` against the configured secret and URL; fixtures built at run time; host scans pass the secret to `sudo grep -rlsF -f -` on stdin and require exit status 1, since sudo closes `<(…)` descriptors (B1; 07-02 T3, 07-08 T3); journal scan (07-08 T3) |
| Fail open for callers | context_search (07-04), forwarding off the caller path (07-06 T2), throwaway instances never write (07-05 T1, 07-06 T3) |

## Capability coverage (INTEGRATE / OPT-OUT)

| capability | decision | reason |
|---|---|---|
| Agentmemory `POST /remember`, `POST /search` (format full), `GET /health`, `POST /forget` | INTEGRATE | D-02, D-05, D-08; forget for spike/tracer cleanup and the retraction route |
| Agentmemory `POST /smart-search` | OPT-OUT | D-05: ignores `project`, compact hits have no content |
| Agentmemory `POST /observe` | OPT-OUT | D-02: 400-char truncation, drops agentId (#1159), 500-per-session cap |
| Agentmemory `/context`, `/session/start|end`, facets | OPT-OUT | not query-driven / not needed (research § 2); no brief integration (D-07) |
| Agentmemory native Claude Code plugin/hooks, Hermes plugin, `@agentmemory/mcp` shim | OPT-OUT | D-10: they bypass redact(); checked absent (07-01, 07-07, 07-08) |
| Brief "Related past work" section | OPT-OUT | CONTEXT § Deferred (revisit after Phase 8) |
| New npm dependency | OPT-OUT | global fetch, zod and bun SQL suffice (07-04 T1 checks manifests) |
| Claude Code user-scope MCP registration; Hermes `mcp_servers` entry | INTEGRATE | D-09, D-10 |
| Omp substrate MCP registration | OPT-OUT | not in D-09/D-10; the proof uses Omp's shell tool against the anonymous MCP endpoint (open question 4) |

## Open questions carried to the orchestrator / owner

1. D-01 names memory kinds "decision/warning/note"; MEMORY_KINDS has no `note`. Plans now forward exactly decision, warning and fact (note = fact) and nothing else (W5). If the owner wants memory `handoff` entries forwarded too, record it in 07-CONTEXT.md before 07-04 runs; 07-04 T1's list and verify grep, 07-01's forwardable sum and 07-06's source filter then add `handoff`.
2. Registering the substrate at user scope gives host Claude Code sessions every substrate tool (guarded ones refuse anonymously; graph/memory/event tools do not). 07-07 T1 now stops until the orchestrator records the owner's answer: `allow` (no change) or `deny-mutating` (`.permissions.deny` entries for every non-read-only substrate tool; I8).
3. ROADMAP SC1 ("smart search") and SC3 (0.9.28) wording must be amended per D-05/D-08 by the orchestrator; plans do not edit ROADMAP.md (recorded in 07-PROOF.md Gaps).
4. D-12's Omp write goes through Omp's shell tool (curl JSON-RPC to the anonymous MCP endpoint) because Omp has no substrate MCP registration; if the owner prefers a native Omp tool, that is an Omp config change outside this phase.
5. Supersession across near-identical records in one graph (research OQ 5) is mitigated by the second header line and, in 07-06's fixture, by wording the event and the memory note differently; a remaining collapse is recorded under `## Gaps` (fixture_event_hit / fixture_memory_hit), not failed.

## Research open questions — disposition

| Research OQ | Disposition |
|---|---|
| 1 Agentmemory version on Railway | 07-02 T2 (owner report) and T3 (`version_gate`, live) |
| 2 Railway env (AGENT_ID, scope, embeddings, LLM keys) | 07-02 T2 owner report; `search_mode` recorded in T3 |
| 3 Railway edge limits (size, rate, idle timeout) | accepted: forwarded content ≤ 8 KB, client deadlines 2 s (search) / 5-10 s (health, remember), no rate reliance; any 413/429/5xx surfaces as a search `reason` or a forward drop replayed from the cursor; observed latency recorded (`remember_ms`, `search_ms`, `mcp_ms`) |
| 4 partial session rows from session/end | not applicable: session routes are not used |
| 5 supersession across graphs | second header line; fixture worded apart; collapse → Gaps (open question 5) |
| 6 upstream #1159/#817 still open | version gate + live isolation check each time 07-02 T3 runs; /observe never used |

## Plan-check iteration 1 (agent://Check07) → change

| Issue | Change |
|---|---|
| B1 | 07-02 T3 and 07-08 T3: secret passed to `sudo grep -rlsF -f -` on stdin (only existing paths), grep exit status must be exactly 1; pattern non-empty checked first; `secret_scan_exit` key; live re-scan in both verifies |
| W1 | 07-06: backfill bounded by the ingested_at snapshot M (`ts ≥ from AND (ingested_at IS NULL OR ≤ M)`, no upper ts bound), M read before now; named test for a future-ts row; live continuous count added |
| W2 | 07-06: `ForwardableEvent = Pick<SubstrateEvent, …>` (Surface/EventKind), no 07-04 contract change |
| W3 | 07-04: query redacted before /search; concepts/project/agentId built from redact()ed ids; two named tests |
| W4 | 07-02 records tokens_budget/truncated (default and over-fetch); 07-04 sends token_budget 200 000 and returns a `truncated` reason; named test |
| W5 | forwarded memory kinds narrowed to decision/warning/fact across 07-01, 07-04, 07-06; widening needs the owner (OQ1) |
| W6 | code routes are executable `git log --grep …` + revert-loop commands (no pipe after git) with the literal head and a stated order, checked to select commits; 07-07 routes carry literal snapshot paths (`S=` line), checked to resolve, no `$S` or placeholders |
| W7 | 07-04 split: 07-04 (T1+T2 code, 70k, 13 code files + its RESTORE file) and 07-05 (tracer, 40k); later plans renumbered |
| I1 | 07-01 greps the exact contract strings and requires `cutover_ingested_at=` in 06-05-CUTOVER.md (`phase6-cutover-ingested-at`) |
| I2 | 07-07 depends on 07-06 (wave 5); 07-02/07-03 coupling declared in 07-02's objective |
| I3 | code routes written before each code plan's first commit (07-03, 07-04, 07-06); clean-tree precondition and failed-restart branch in 07-05 T1 and 07-06 T3 |
| I4 | poison-record policy, keyset memory paging, `forwarded_total` defined |
| I5 | 07-06 interfaces and T2 say how to restructure a single-expression emit |
| I6 | `pgrep -fc '[h]indsight'` (07-01, 07-07) and `'[h]ermes'` |
| I7 | hm-mcp-test.txt written under umask 077 and chmod 600; verify requires every snapshot file 0600 |
| I8 | 07-07 T1 precondition: owner answer allow / deny-mutating, with a deny branch and checks |
| I9 | 07-02 T2: no /data volume → add one first; "/data volume: yes" in the resume signal; `owner_data_volume` key |
| I10 | 07-08 T1: exact three-line prompt written by python3 without escapes; `omp_prompt_json_ok` checks the --data JSON before the run |
| I11 | live paths added to files_modified (substrate.env, cursor.json, agent configs, proof7 files); research OQ3 disposition above; fixture event and memory worded apart, hits ≥ 1 with collapse → Gaps |

## Plan-check iteration 2 (agent://Check07) → change

| Issue | Change |
|---|---|
| NB1 | 07-06 T1: the 3-strike skip is removed. Only a record-specific rejection (http 400, 413, 422, or `success:false`) is skipped; timeout, network, 401/403/404/408/429, 5xx and shape stop the drain with the cursor unadvanced and are retried on every later drain; `stuck` is observability only (a "forwarding stalled" line every 10 drains). New named test "D-03 an outage longer than 3 attempts forwards every record after recovery"; the 400 test now also asserts 401/429/503 are never skipped |
| NI1 | 07-07 T1: `deny-mutating` uses an explicit read-only set (memory_brief, memory_search, graph_get, graph_find, issue_get, docs_search, context_search) and an explicit mutating set; unknown tools are recorded on `cc_unclassified_tool:` lines, not denied; the verify checks memory_brief and context_search are never denied |
| NI2 | 07-04 T2: the truncation reason logs `[substrate] context_search: agentmemory truncated results (token budget)`, not "unavailable"; the service test asserts both lines |
| NI3 | 07-05: evidence title is "# 07-05 tracer …" (the event summary already said 07-05) |
| NI4 | 07-06 T3: the continuous count uses the continuous path's own predicate (no ts filter) and is taken after the forwarder is idle (two journal reads 5 s apart); the outage drain accepts any first failed event (another agent's event in between is noted under `## Notes`) — the replay must still forward outage_event_id |
| NI5 | 07-06: a null continuous cursor means `"ingested_at" IS NOT NULL` (defined in ReplaySource and source.ts) |
| NI6 | advisory, no change: the calibrated estimate passes; if 07-04 degrades in execution, move the MCP/REST wiring out of T2 |
