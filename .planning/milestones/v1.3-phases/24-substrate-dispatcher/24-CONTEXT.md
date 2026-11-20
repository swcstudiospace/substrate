# Phase 24: substrate-dispatcher - Context

**Gathered:** 2026-10-10
**Status:** Ready for planning
**Mode:** Autonomous discuss-equivalent under the v1.3 run rules (`.planning/STATE.md`, "v1.3 decisions"): grey areas auto-accept unless they change a user-visible contract, and each is recorded below as a decision with its source. No operator questions were asked; items needing a live system are marked OPERATOR-GATED in the plans, not resolved here.

<domain>
## Phase Boundary

One PR on agent-substrate (DISP-01..DISP-08). Labelling a Linear issue `dispatch:hermes` starts a lease-correct Hermes session on the issue's Graph ID in its own worktree, and every issue the dispatcher does not dispatch says why.

1. **Port, not merge.** `packages/dispatcher/src/substrate_dispatcher/{__init__,__main__,dispatch,host,launcher,linear,mcp,sessions,worktree}.py`, `pyproject.toml`, the seven `tests/test_*.py` and `infra/vps/substrate-dispatcher.service` come from `acc30a8` (`git show acc30a8:<path>`), onto main's v1.2 lease model and Phase 20 production identity. September was built on the pre-lease claim model with anonymous access; the call sites that claim, read nodes and emit events are rewritten, never cherry-picked.
2. **The dispatcher never decides ownership.** Main's lease verdicts (`claimNode`/`releaseNode`/`completeNode`, Phase 23 mirror) stay authoritative. The dispatcher polls, prepares a worktree, launches a session, and watches for a landed claim. It never claims on an agent's behalf, never rolls a lease back, never moves an issue to Done, never overwrites labels.
3. **Rehearsal-first, then gated live.** Every behavior is proven with `--once --dry-run` plus fakes against the Phase 16 harness twin before any live step. The DISP-08 proof (real Linear label, real Hermes session, real claim mirror, kill switch off) is an OPERATOR-GATED sequence the executor stops at.
4. **Kill switch stays on.** `SUBSTRATE_DISPATCH_DISABLED=1` is the staged default and the end state. It is `0` only inside the bounded, operator-approved live window.

**Out of scope:**
- Any change to the lease engine, the claim mirror, `graph_find`/`issue_get`, or the DoD gate (Phase 23 owns them; this phase only calls them).
- Any new `EVENT_KINDS` or `SURFACES` entry (Phase 17 lock; the `dispatch.outcome`/`dispatch.failed` rows already exist).
- New redaction rules (Phase 18 owns `redact.ts`; issue text is fetched, not embedded).
- The Lane A host itself (Phases 31–33 own `substrate-host`; this phase only ports the thin `HostClient` and routes `dispatch:claude-code` through it).
- Production token values (Phase 20 provisioned them by name; this phase only reads token files).
- Running Hermes as an unprivileged user (deferred on the branch as D-16; deferred here).

**Depends on code already on `main`:**
- Phase 16: `scripts/rehearsal.ts`, harness twin (`consumer.env`, scratch port, `--port 0` instances).
- Phase 17: `event-sources.ts` `dispatch.outcome` (note/substrate) + `dispatch.failed` (warning/substrate) rows, `substrate` surface, `policy.ts`.
- Phase 18: store-lock rules, child-env discipline (argv-only, allowlisted env).
- Phase 20: `infra/identity/clients.json` `dormant:24` dispatcher row (surface `substrate`, env-file `/etc/substrate/substrate-dispatcher.env`, variable `SUBSTRATE_TOKEN_SUBSTRATE`), tokens-dir bearer pattern, `docs/runbooks/production-identity.md`.
- Phase 23: `graph_find`, `issue_get` (fail-open reads), the claim mirror's `dispatch:*` removal + `agent:<surface>` labelling, the `Claimed by <surface> — session <sid> (graph <g>, node <n>)` comment the landed-claim rule reads.
</domain>

<decisions>
## Implementation Decisions

### Port shape and auth cutover (the September-to-main break)
- **D24-01: Port the nine modules, tests, pyproject and unit file whole; rewrite only the auth and lease-model call sites.**
  - Source: research §2 port map + research SUMMARY (leaf modules port whole; call sites rewritten against the `lease_id` model).
  - September's prompt curls call `graph_claim`/`issue_get`/`graph_complete`/`graph_release` with no bearer (anonymous September). On main every write needs a surface bearer, so the prompt template gains bearer carriage (D24-03) and the dispatcher's own `graph_find`/event calls resolve the `substrate` surface token through the Phase 20 order. No other prompt logic changes.
- **D24-02: The dispatcher authenticates as surface `substrate`; Linear with the raw key.**
  - Source: 20-CONTEXT D20-07 (dormant:24 row holds `SUBSTRATE_TOKEN_SUBSTRATE` by name in `/etc/substrate/substrate-dispatcher.env`) + branch `linear.py` (raw `Authorization: <key>`, no `Bearer` prefix; never logged).
  - The dispatcher's MCP reads (`graph_find`) and outcome events (`dispatch.outcome`/`dispatch.failed`) use the substrate bearer. Linear reads/writes use `LINEAR_API_KEY` from the same env file. Error messages carry status + ≤200 body chars, never the key or headers (branch rule, kept).
- **D24-03: The launched Hermes session claims with its own `hermes` surface token, read at session runtime — never baked into the stored prompt.**
  - Source: DISP-05 (agent claims with its own surface token) + Phase 20 tokens-dir pattern + branch D-16 (session runs as root, so it can read what it needs).
  - The prompt template's curls gain `-H "Authorization: Bearer $(cat <tokens-dir hermes file>)"` evaluated by the session shell at run time. The stored prompt file under `STATE_DIR/prompts` carries the path, never a value. The dispatcher process itself never exports a hermes bearer into its own environment.
  - Grey area (which tokens-dir path the prompt names) auto-accepted: the Phase 20 tokens-dir file for surface `hermes`, resolved the same way `packages/cli/src/token.ts` resolves it; the plan asserts the literal path against `token.ts` rather than inventing one.

### Tick, markers and refusal vocabulary
- **D24-04: Keep September's 13-marker vocabulary, a superset of DISP-02's 11.**
  - Source: branch `dispatch.py` MARKERS + REQUIREMENTS DISP-02.
  - DISP-02 names 11 markers; September adds `invalid-graph-id` and `invalid-ids` (unsafe ids refused before any checkout or worktree). Dropping safety refusals to match the list exactly would be a scope reduction, so the plans keep all 13 and the proof asserts DISP-02's 11 are each reachable plus the two safety markers. Every non-dispatch leaves exactly one once-only comment: body starts with `substrate-dispatcher:`, carries the stable `[<marker>]` tag, skipped when the tag is among the issue's last 50 comments.
  - Grey area (DISP-02 vs branch marker set) auto-accepted: superset wins; user-visible contract (every non-dispatch says why, once) unchanged.
- **D24-05: The given-up set persists across restarts — the one greenfield delta on the branch.**
  - Source: REQUIREMENTS DISP-06 ("the given-up set survives a restart") vs branch `sessions.py` (in-memory `given_up`, "never relaunches while the dispatcher runs").
  - The registry loads/saves `STATE_DIR/given_up.json` (issue ids, 0600, atomic replace). A restart re-reads it before the first tick, so a given-up issue is never relaunched by a new process. Crash between add and fsync may relaunch once; the once-only comment tag makes the duplicate a skipped comment, not a duplicate session.
  - Grey area (file format) auto-accepted: flat JSON list, the smallest shape that survives a restart and is human-inspectable.
- **D24-06: `dispatch:claude-code` routes through the ported `HostClient`; live claude-code dispatch is deferred to Phase 33.**
  - Source: ROADMAP Phase 33 (the claude-code dispatch route) + branch `host.py` (thin loopback client, `RemoteTask` Popen subset, `host-refused` vs `host-unreachable` markers).
  - `host.py` ports now because the tick's surface routing needs it and it is host-independent (plain httpx against `127.0.0.1:7411`). With no host on the loopback port every claude-code candidate gets `host-unreachable` (retryable, no label removal) — the correct pre-Phase-31 behavior. This phase's live proof is hermes-only; a claude-code live launch is explicitly not attempted.
  - Grey area (whether to port host.py now or in Phase 31) auto-accepted: now — the file is leaf-stable, and deferring it would leave the tick's `DISPATCHABLE_SURFACES` half-wired.
- **D24-07: Claim timeout stays 900 s, equal to `DEFAULT_LEASE_TTL_SECONDS`.**
  - Source: branch `sessions.py` CLAIM_TIMEOUT_SECONDS (amended 2026-09-25 to outlast the 600 s Hermes 429 backoff) + main `lease.ts:42`.
  - On timeout the registry terminates (SIGTERM, then SIGKILL after 10 s — Hermes ignores SIGTERM, 02-09 tracer evidence), posts `[claim-timeout]`, removes the `dispatch:<surface>` label and gives the issue up. No tuning; the equality with the lease TTL is load-bearing, not coincidence.
- **D24-08: `--once` without `--dry-run` stays refused; rehearsal is `--once --dry-run`.**
  - Source: branch `__main__.py` (WR-04: a real launch must stay under the loop's D-14 watch).
  - The smoke runs one reap + one tick with fakes and writes nothing. Any plan or runbook proposing `--once` live is wrong; the live proof runs the loop with the kill switch off in a bounded window.

### Loop, lock and kill switch
- **D24-09: 30 s tick under an exclusive flock; the kill switch is re-read every tick and defaults on.**
  - Source: REQUIREMENTS DISP-01 + branch `__main__.py` (POLL_INTERVAL_SECONDS=30, flock on `STATE_DIR/dispatcher.lock`, second instance exits 3; `SUBSTRATE_ENV_FILE` re-read per tick).
  - Staged unit + env default `SUBSTRATE_DISPATCH_DISABLED=1`. The live window sets `0`, the proof ends by setting `1` back (DISP-08's "kill switch is back on afterwards" is a proof step, not a note). At most 2 dispatched sessions, one per issue (D-14, kept).
- **D24-10: The D-16 root-trust assumption is carried forward verbatim.**
  - Source: branch `launcher.py` D-16 note (allowlist keeps secrets out of the child *environment*; root with terminal+file tools can still read `/etc/substrate/substrate.env` from disk; labelling trust = root trust).
  - Anyone who can label `dispatch:hermes` in the reached workspace is trusted with root on this host. Running Hermes as an unprivileged reader is deferred (was deferred on the branch; unchanged here). The CHILD_ENV_ALLOW list ports unchanged.

### Tracker and poller interplay
- **D24-11: Additive Linear writes only; the dispatcher never moves state toward Done and never fights the connector poller.**
  - Source: 23-CONTEXT D23-05 (additive `addedLabelIds`/`removedLabelIds`, no `labelIds` overwrite) + host fact (`hermes-linear-poller.service` drives the connector's own poll loop).
  - The dispatcher and `hermes-linear-poller` are independent readers of the same issues: the poller advances connector-managed state, the dispatcher reacts to `dispatch:*` labels on unstarted issues. They share nothing but the issue. The dispatcher removes only its own `dispatch:<surface>` label (on give-up paths) and relies on the Phase 23 mirror to move `dispatch:*` → `agent:<surface>` on landed claims — it never edits labels the mirror owns, never resolves or sends a `completed` state id, never creates issues (Free-plan cap, 23-CONTEXT D23-08/09).
  - Grey area (two pollers, one issue) auto-accepted: no coordination protocol — the once-only marker tags and the mirror's idempotent comment rule already make every overlapping write converge.
- **D24-12: One outcome event per launch decision on the existing Phase 17 rows; no new kinds.**
  - Source: `event-sources.ts` `dispatch.outcome` (kind `note`, surface `substrate`) + `dispatch.failed` (kind `warning`), both `phase: 24`, `runtime: "dispatcher"`.
  - A launched tick emits `dispatch.outcome{outcome: launched}`; each terminal non-dispatch and each give-up emits `dispatch.failed{reason: <marker>}`. Emission is fail-open (a refused emit never blocks the tick) and carries ids only, never issue text.
  - Grey area (branch has no event emission; whether to add it) auto-accepted: add it — Phase 17 registered the rows for this phase, and silent dispatch would leave the ledger blind to who started a session.

### Host and units
- **D24-13: September's `/var/lib/substrate/worktrees/ut-*` leftovers are left alone.**
  - Source: host fact (`ut-mugbqivi-752f2dad`, `ut-mughkkc0-73909228` present) + branch `worktree.py` (reuse only when git registers the path as this graph's worktree).
  - Stale worktrees can never be picked up for a new graph (path is per-graph-id; registration check fails closed). Operator cleanup is optional and ungated; no plan touches them.
  - Grey area (clean vs leave) auto-accepted: leave — deleting another run's tree is the riskier action and no requirement asks for it.
- **D24-14: Unit files staged with Phase 16 guards; restarts gated; the manifest flips only after gated restarts.**
  - Source: 22-CONTEXT D22-10 pattern + 20-CONTEXT D20-07 + `infra/identity/clients.json` `dormant:24` dispatcher row.
  - `infra/vps/substrate-dispatcher.service` ports with the per-unit `EnvironmentFile=/etc/substrate/substrate-dispatcher.env` (names `SUBSTRATE_TOKEN_SUBSTRATE`, value never in the repo) + `ConditionPathExists` on the entry point per the Phase 16 guard convention. Plans stage the file and prove it in rehearsal (content test / `--user` dry, never touching the production unit). The production restart, the env-file provisioning, and the manifest flip `dormant:24` → `live` are OPERATOR-GATED steps in plan 24-04, NOT in this phase's PR.

### Landed-claim rule (lease-correctness core)
- **D24-15: The landed-claim evidence rule ports unchanged and reads only Phase 23 artifacts.**
  - Source: branch `sessions.py` (`claimed_by == surface`, or node in a LANDED_STATE it did not have at launch, or a new `Claimed by <surface> — session <sid> (graph <g>, node <n>)` mirror comment) + 23-VERIFICATION truths 7/10.
  - Evidence is any of the three; a claim completed-or-released between two reaps still counts as landed (02-05 `completeNode` nulls `claimed_by`). The rule never reads a `lease_id` (23-CONTEXT D23-04; the dispatcher never sees one). `graph_get` shows the public lease view only.
  - Grey area (whether the In Review state counts as landed) auto-accepted: yes — `started_review` is a LANDED_STATE on the branch, and Phase 23 parks `dod-required` completions there with the lease held, which is exactly a live session doing its job.
</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `acc30a8:packages/dispatcher/src/substrate_dispatcher/{__init__ (11), linear (165), mcp (147), worktree (147), launcher (222), sessions (251), dispatch (279), host (224), __main__ (162)}.py` + `tests/test_{clients (178), worktree (174), launcher (213), sessions (439), dispatch (559), host (212), main (261)}.py` + `pyproject.toml` (28) + `infra/vps/substrate-dispatcher.service`.
- Main: `packages/mcp-server/src/{service,index-store,lease,mcp}.ts` (`graph_find`, `issue_get`, `graph_claim`/`heartbeat`/`release`/`complete` with `lease_id`; TTL default 900 s), `packages/mcp-server/src/event-sources.ts` (`dispatch.outcome`/`dispatch.failed` rows, phase 24), `packages/audit/src/policy.ts` (tool fail-open/closed table), `packages/cli/src/token.ts` (bearer resolver order), `infra/identity/clients.json` (`dormant:24` dispatcher row), Phase 16 harness (`scripts/rehearsal.ts`, `consumer.env`).
- Branch history worth replaying in rehearsal: WR-04 (`--once` refusal), IN-02 (prompt-id validation before checkout), 02-08 (429 backoff → 900 s timeout), 02-09 (SIGTERM ignored → SIGKILL; unknown Linear MCP toolset → no MCP toolsets passed).

### Established Patterns
- Port leaf modules whole; rewrite only auth + lease-model call sites (D24-01).
- Python tests under `packages/dispatcher/tests`, run via root `test:py` (extends the Phase 22 script to the dispatcher dir, never touches `/root` or live ports — monkeypatched transports and tmp dirs).
- Refusals record rule names, never values; marker comments idempotent by tag; side-effect events never fail the action.
- Detached worktrees for proof runs; the harness refuses the production checkout and port 7410.
- Staged units pattern (22-01): content + guard assertions in PR, restarts gated out.

### Integration Points
- New on main: `packages/dispatcher/src/substrate_dispatcher/*.py` (9 modules), `packages/dispatcher/tests/test_*.py` (7 files), `packages/dispatcher/pyproject.toml`, `infra/vps/substrate-dispatcher.service`, `scripts/dispatcher-smoke.*`, `docs/dispatcher.md`, `docs/runbooks/dispatch-proof.md`.
- Edited: `package.json` (`test:py` extended, `smoke:dispatcher` script), `docs/rehearsal.md` (only if the harness needs a dispatcher lever — none planned), `.env.example` (only if a new non-secret key is needed — `SUBSTRATE_DISPATCH_*` tuning stays env-only, documented in `docs/dispatcher.md`), `infra/identity/clients.json` (flip to `live` only after the gated restarts — NOT in this phase's PR).
</code_context>

<specifics>
## Specific Ideas

- The phase is "the last metre of the claim path": Phase 23 proved the mirror moves `dispatch:*` → `agent:<surface>` when a claim lands; this phase is what makes a claim land — a Hermes session in the right worktree, holding the right token, reading the issue through `issue_get` as untrusted text.
- September's September-to-main delta is small but load-bearing: bearer carriage in the prompt (D24-03), the `substrate`-token identity for the loop's own calls (D24-02), and given-up persistence (D24-05). Everything else is a verbatim port. Reviewers should check exactly those three diffs against the branch, plus the new event emission (D24-12).
- The rehearsal replays September's incident history as regression cases: `--once` refusal (WR-04), invalid-ids before checkout (IN-02), 429-backoff-sized timeout (02-08), SIGTERM-ignored kill (02-09), unknown-toolset launch flags.
</specifics>

<deferred>
## Deferred Ideas

- Running dispatched Hermes as an unprivileged user that cannot read `/etc/substrate` (branch D-16 deferred idea; unchanged).
- `dispatch:claude-code` live launch (needs the Lane A host; Phase 33 owns the route proof).
- A periodic reaper unit for lapsed dispatcher sessions beyond the loop's own reap (Phase 23 deferred the mirror reaper the same way; the loop's per-tick reap covers it).
- RAGFlow (retired, superseded by LightRAG)/docs or memory wiring for dispatched sessions (the session uses `issue_get` + its normal tools; no dispatcher role).
- Library-in-VM mounts for dispatched work (deferred with Phase 22's D-08).
</deferred>

## Open for the operator (gated steps, not questions)

**All decided below as written; each waits for operator approval at execution time.** They are locked, not open.

1. **Provisioning `/etc/substrate/substrate-dispatcher.env`.** Names `SUBSTRATE_TOKEN_SUBSTRATE` (value from Phase 20 provisioning, never in the repo), `LINEAR_API_KEY`, and `SUBSTRATE_DISPATCH_DISABLED=1`. Alternative: none — the loop cannot authenticate without it.
2. **The DISP-08 live proof window.** Bounded, kill-switch-off (`SUBSTRATE_DISPATCH_DISABLED=0`), on a fresh unstarted issue carrying `dispatch:hermes`: launch ≤30 s, claim under the hermes token, `agent:hermes` label, Notion Agent hermes, Claude Code brief names the claim ≤60 s, run ends in gated Done or release, kill switch back to `1`. Needs Linear + Notion writes, Hermes model quota, and the production `substrate-mcp` serving this phase's code. Alternative: none — the requirement is explicitly live.
3. **Production restart of `substrate-dispatcher.service` + manifest flip.** Only after the live proof; retires the `dormant:24` expected-401 count in `docs/runbooks/production-identity.md`. Alternative: leave dormant (unit keeps idling on the kill switch) — rejected as the end state, accepted as the interim.
4. **One-time `/var/lib/substrate/dispatcher/` state review.** The operator confirms the September `given_up` predecessor state (if any) and stale `dispatcher.lock` handling before first start; the code treats a stale lock as a fresh start (flock is kernel-held, not a pidfile). Alternative: none needed — informational.
</domain>
