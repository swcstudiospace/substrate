# Phase 22: Skills sync, bridge and miners - Research

**Researched:** 2026-10-10
**Domain:** Port of September's skills-sync/bridge/miner stack (`acc30a8`) onto main's v1.2 surface-token server; clients of Phase 21's `POST /skills/propose`; Hermes cron + Omp/Grok miners propose-only
**Confidence:** HIGH (every port point read on `acc30a8` and on main this session; September live evidence commits read; Phase 16/19/20/21 contracts read from committed plans and verification reports)

<user_constraints>
## User Constraints (from CONTEXT.md)

Locked: D22-01 (substrate surface token, never the propose key; key file deleted gated post-cutover), D22-02 (bridge=hermes, Omp=omp, skill-autonomy=grok-build surfaces), D22-03 (sync gate unchanged + child-env allowlist), D22-04 (projector six roots unchanged; re-derive GROK_KNOWN_REAL), D22-05 (dirty stays a refusal; gated cleanup + .gitignore PR), D22-06 (bridge semantics unchanged minus key), D22-07 (0600 queue-body contract), D22-08 (three propose-only interceptions), D22-09 (hourly miner + monitor precheck), D22-10 (four unit files with token carriage; restarts gated), D22-11 (rehearsal-first; SKILL-07 live tail gated). Full text in 22-CONTEXT.md.
</user_constraints>

<ports>
## Port Map (acc30a8 → main)

| # | September file | Lines | Disposition on main | Plan |
|---|---|---|---|---|
| P-01 | `packages/projector/src/skills.ts` | 468 | Port whole; imports `SKILL_NAME_RE` from main's `packages/mcp-server/src/skills/propose.ts` (same literal already on main); warning events via Phase 17 rows, surface per root | 22-01 |
| P-02 | `packages/projector/src/skills.test.ts` | 565 | Port whole; Bun colocated | 22-01 |
| P-03 | `packages/projector/src/skills-sync.ts` | 137 | Port whole; child env → allowlist (`PATH`, `HOME`, `GIT_TERMINAL_PROMPT=0`, `GH_PROMPT_DISABLED=1`, D22-03); `HOME=/root` default retained for gh credential | 22-01 |
| P-04 | `packages/projector/src/skills-sync.test.ts` | 144 | Port whole (`decide()` matrix + `runSync` harness) | 22-01 |
| P-05 | `packages/projector/omp/substrate-skills.ts` | 251 | Port whole; replace propose-key read+header with tokens-dir bearer for surface `omp` (D22-01); keep queue-on-401/5xx/timeout, 400/413 final, session_id forwarding, no-Omp-imports rule | 22-03 |
| P-06 | `packages/projector/omp/substrate-skills.test.ts` | 287 | Port whole, adapted to bearer carriage | 22-03 |
| P-07 | `packages/miner/src/substrate_miner/bridge.py` | 598 | Port whole; replace `PROPOSE_KEY_FILE`/`PROPOSE_KEY_HEADER` with bearer resolution for surface `hermes`; keep pending grouping, QUIET_S=120, propose-vs-hold classes, unlink-only-on-final, Omp+Grok drains, log/held paths | 22-02 |
| P-08 | `packages/miner/src/substrate_miner/monitor.py` | 30 | Port whole, unchanged | 22-02 |
| P-09 | `packages/miner/src/substrate_miner/__main__.py` | 51 | Port whole; `bridge --once` summary line + `monitor` subcommand unchanged | 22-02 |
| P-10 | `packages/miner/tests/test_bridge.py` | 523 | Port whole, adapted to bearer carriage | 22-02 |
| P-11 | `packages/miner/tests/test_monitor.py` | 43 | Port whole, unchanged | 22-02 |
| P-12 | `packages/miner/skills/substrate-skill-miner/SKILL.md` | 68 | Port whole; update auth paragraph (surface token, never direct publish); keep ≤3 skills, frontmatter contract, never-write rules | 22-03 |
| P-13 | `infra/vps/substrate-skills-sync.service` + `.timer` | 29+12 | Port whole; add per-unit `EnvironmentFile` for `SUBSTRATE_TOKEN_SUBSTRATE` by name (D20-07) + `ConditionPathExists` on entry point (Phase 16 convention) | 22-01 |
| P-14 | `infra/vps/substrate-skills-bridge.service` + `.timer` | 34+12 | Port whole; same token-carriage + guard treatment as P-13 | 22-02 |
| P-15 | skill-autonomy reinstall/config (04-09 evidence, no repo file) | — | Host-config step: point at `POST /skills/propose` with `grok-build` bearer or stage to pending dir; reinstall from pinned source per 04-09 pattern | 22-03 (gated) |
| P-16 | Hermes cron `substrate-skill-miner` rebind | — | Host-config step: bind existing cron entry to main's monitor + SKILL.md; `write_approval` flags stay true | 22-03 (gated) |
| NOT ported | `propose-auth.ts` / `x-substrate-propose-key` / `PROPOSE_KEY_*` | — | Dropped per 21-CONTEXT D21-01 and D22-01; any branch reference is dead on main's route | — |
| NOT ported | 04-06 VM library mounts (D-08) | — | No v1.3 requirement; deferred (CONTEXT) | — |

**What is greenfield (on no branch):** the bearer-resolution call sites in P-05/P-07 (new code shaped by Phase 20's `token.ts` resolver order); the rehearsal smoke for sync+bridge+projection (22-04; Phase 21's `--skills-fixture` covers propose only); `docs/skills-sync-bridge-miners.md`; the root `test:py` script (main has no Python test entry point — research SUMMARY stack note).
</ports>

<phase21_contract>
## The Wire Contract These Clients Code Against (Phase 21, verified 24/24 at e2ad4dc)

- `POST /skills/propose` with a surface bearer: 200 `opened|existing|unchanged|declined|dry_run`; 400 refused (findings `{file,line,rule}`, never values); 401 anonymous; 403 surface mismatch / operator-only option; 413 oversize (>1 MB); 502 redacted `ProposeFailed`; 503 audit denial. Final replies (unlink/ delete the queued record): 200-any + 400. Keep-for-next-tick: 401, 5xx, transport error, 413, oversize body.
- Branch shape `skill/<surface>/<name>-<ts>-<hex>`; the token's surface names it (D21-03) — hence D22-02's per-client surfaces.
- `config.ts` `skills` block: `SUBSTRATE_SKILLS_REPO/_REMOTE_URL/_STATE/_GH`; non-default repo needs `file://` remote + absolute `gh` (the rehearsal lever).
- Harness: `rehearsal up --skills-fixture` builds a throwaway bare repo + `mirror.git` + recording `gh` inside the run dir; `SUBSTRATE_SKILLS_STATE=<runDir>/skills` always. Plan 22-04 extends this pattern (fixture library seeded with ≥2 skills so projection is observable).
- Proven: 47/47 smoke; engine pins no force flag / colon refspec / search query; secret refusals carry file+line+rule with the value nowhere.
</phase21_contract>

<identity>
## Identity Manifest Rows This Phase Activates (Phase 20, `infra/identity/clients.json`)

Three `dormant:22` rows, each delivered by per-unit env file naming `SUBSTRATE_TOKEN_SUBSTRATE`, evidenced post-switch by expected 401s: `skills-sync` (surface `substrate`), `bridge` (surface `substrate`), `miner` (surface `substrate`, Hermes cron). At switch-on these 401s were recorded as expected-and-harmless because the code was broken; this phase's gated restarts flip them to live, and the runbook's expected-dormant count drops accordingly. The manifest itself flips to `live` only after the gated restarts — NOT in this phase's PR (CONTEXT integration points).
</identity>

<september_evidence>
## September Live Evidence (the rehearsal script for SKILL-07)

- agent-skills#5: a gate-staged library write became a PR via the bridge timer (SC-5, commit 558cf8d).
- agent-skills#4: skill-autonomy reinstall → live rule → propose with 0600 queued body (04-09, 5bea2e6).
- agent-skills#7: real Omp session → propose (session 01a0dfe8) → projection into Claude Code and Grok Build (04-12, 46dff86/b39c444).
- Proof-route note: 04-12 re-planned onto the Omp route when the Cursor stop hook/transcripts were not on the VPS (5e97249, c322e9c). On main the transcripts exist (Phase 19 `cursor-stop.ts`), so the Cursor route of SKILL-07 is plannable — but the plan keeps the Omp route as the rehearsal fallback.
</september_evidence>

<host_facts>
## Host Facts Constraining the Plans (names only, no values read)

- `/root/agent-skills` dirty (untracked `__pycache__`) — research SUMMARY PITFALLS 12; D22-05 gated cleanup.
- `/var/lib/substrate/skills/{mirror.git,proposals.jsonl,locks/,propose/,propose.key}` exists from September 04-02; ledger format kept by Phase 21 (D21-14) so September content-hashes still dedupe.
- Timers `substrate-skills-sync/-bridge` fail every 5 min (`Module not found …skills-sync.ts`, `No module named substrate_miner.__main__`); Hermes cron `substrate-skill-miner` failure_streak 198; 4 proposals staged; Omp extension symlink dangling (research SUMMARY production-hazards table).
- Transcripts at `/var/lib/substrate/transcripts/cursor` (Phase 19); pending at `~/.hermes/pending/skills`; queues at `~/.omp/agent/substrate-pending` and Grok `plugin-data/skill-autonomy/pending`.
- Roots from P-01: `/root/.claude/skills`, `/root/.grok/skills`, `/root/.agents/skills` (disable flag), `/root/.config/muse/skills` (create), `/root/.openclaw/skills` + `/workspace/skills` (repoint-only), `/root/.cursor/skills` (enable flag).
</host_facts>

<pitfalls>
## Pitfalls Carried Into the Plans

1. **Merge = deploy** (SUMMARY Pitfall 1): staging unit files is safe; restarting production units is gated. Every plan states its live effect (none, until 22-04's gated steps).
2. **Porting by merge** (Pitfall 2): reference implementations only; the auth call sites are rewritten, never cherry-picked — the key header must not survive anywhere (`rg propose-key` clean except historical docs).
3. **Store-lock bypass** (Pitfall 8): bridge/ext read only their surface token file + `SUBSTRATE_URL`; no `GREPTIME_*`/`RAGFLOW (retired)_*`/`HINDSIGHT_*` names in new code; token paths in prose, never `NAME=<path>` (Phase 20 spelling rule).
4. **Fail-open/closed misassignment** (Pitfall 3): collection/bridge transport errors keep-and-retry (fail-open for the tick); proposal audit stays fail-closed (Phase 21); sync refusals exit 0 as policy outcomes, git failures exit 1.
5. **PR size** (Pitfall 14): four plans; P-01+P-02 tests (~700 lines) ride with their engines, not in a separate test plan.
6. **Test isolation** (Pitfall 13): Python tests never touch `/root` paths (monkeypatch tmp); Bun tests use injected runners; the smoke runs in a detached worktree against the twin.
7. **Baseline discipline** (D21-23 pattern): `bun test` baseline at HEAD is 2646 pass / 58 skip / 1 fail (F-01, recorded); `bunx tsc --noEmit` clean. Failures at HEAD are recorded, not fixed.
</pitfalls>

<plan_split>
## Plan Split (4 plans, 2 waves)

- **22-01 (wave 1): sync + projector port.** P-01..P-04, P-13. SKILL-02 minus live proof. Files: `packages/projector/src/{skills,skills-sync}.{ts,test.ts}`, `infra/vps/substrate-skills-sync.{service,timer}`.
- **22-02 (wave 1): bridge + monitor port.** P-07..P-11, P-14, root `test:py`. SKILL-03 + SKILL-04's monitor half. Files: `packages/miner/...`, `infra/vps/substrate-skills-bridge.{service,timer}`. No file overlap with 22-01 → same wave.
- **22-03 (wave 2, depends on 22-02): propose-only miners.** P-05/P-06, P-12, P-15/P-16 host-config (gated). SKILL-04 + SKILL-05. Needs the bridge queue contract settled (22-02) before the extension's queue format is frozen.
- **22-04 (wave 3, depends on 22-01..03): rehearsal proof + live runbook.** Fixture-library smoke (`propose→PR→merge→sync→links`), docs, dirty-tree `.gitignore` PR prep, and the explicit OPERATOR-GATED live tail (real PR, owner merge, production restarts, cron rebind, key-file deletion). SKILL-07.
</plan_split>

<open_questions>
## Open Questions — all resolved by auto-accept (no operator input needed)

1. Quiet-window 120 s kept → D22-06 (September-proven; no requirement to tune).
2. Key-file interim lifetime → D22-01 (leave-then-delete; code never references it).
3. Grok knownReal drift → D22-04 (re-derive; drift becomes skip-warn).
4. .gitignore vs delete-only → D22-05 (both, via owner-reviewed PR).
5. Cron scheduler mechanics → D22-09 (rebind existing entry; no new scheduler).
</open_questions>
