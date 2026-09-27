---
phase: "7"
slug: "recall"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-09-26"
---

# Phase 7 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Seeded from the owner-accepted decisions D-01..D-12 in `07-CONTEXT.md`, the external contracts in
> `07-RESEARCH-CONTRACTS.md` (§ 1-5, § 8, Decisions D1-D8) and ROADMAP Phase 7 SC1-SC4 + Proof,
> reconciled with plans 07-01..07-08 (test file names below are the ones the plans create). The
> criterion and decision coverage matrices are in `COVERAGE.md`.

---

## Test Infrastructure

Phase 7 touches `packages/mcp-server` (config, redact, service, mcp, server, index, index-store and
a new `recall/` module: agentmemory, record, search, forward, source), the repo `.env.example`, and
live state (`/etc/substrate/substrate.env` via the owner, the owner's Agentmemory on Railway,
`/var/lib/substrate/recall/cursor.json`, substrate-mcp restarts, `/root/.claude.json`,
`/root/.claude/settings.json`, `/root/.hermes/config.yaml`). Phase 7 runs **after Phase 6**; its
baseline is measured then (07-01), never copied.

| Property | Value |
|----------|-------|
| **Framework (TS)** | `bun test` (repo root, colocated `*.test.ts`) + `bunx tsc --noEmit` (root tsconfig includes `packages/**/*.ts`). Agentmemory is always a fake `fetch` in unit tests; the forwarder uses fake timers, a fake source and a tmp dir. |
| **Framework (Python)** | `packages/dispatcher` pytest — untouched by Phase 7; regression gate only (07-01, 07-06 T2, 07-08 T3). |
| **Live reads** | Agentmemory through keyed probes `sudo systemd-run … -p EnvironmentFile=/etc/substrate/substrate.env … bun /tmp/<script>.ts` printing key=value only (no `$`/`%` inline); Greptime/Postgres through the same shape; the service through `curl 127.0.0.1:7410` (JSON-RPC and REST); agents through `claude`, `omp` and `hermes` CLIs. |
| **Quick run command** | `SUBSTRATE_DISABLED=1 /root/.local/share/reflex/bun/bin/bun test packages/mcp-server/src/recall packages/mcp-server/src/redact.test.ts packages/mcp-server/src/service.test.ts packages/mcp-server/src/mcp.test.ts packages/mcp-server/src/server.test.ts` |
| **Full suite command** | `cd /root/src/repos/agent-substrate && SUBSTRATE_DISABLED=1 /root/.local/share/reflex/bun/bin/bun test && /root/.local/share/reflex/bun/bin/bunx tsc --noEmit && (cd packages/dispatcher && python3 -m pytest -q)` |
| **Estimated runtime** | < 30 s per suite (owner checkpoint, live restarts, backfill wait and model sessions excluded) |

| Repo / package | Quick run command | Baseline (re-measured by 07-01 into `07-BASELINE.md`) |
|---|---|---|
| agent-substrate (TS) | `SUBSTRATE_DISABLED=1 /root/.local/share/reflex/bun/bin/bun test` | post-Phase-6 count (re-measured; never copied) |
| agent-substrate (tsc) | normalized `bunx tsc --noEmit` pipeline (03-BASELINE.md) | re-measured |
| dispatcher (Python) | `cd packages/dispatcher && python3 -m pytest -q` | re-measured |
| live: qualifying records in the 14-day window | 07-01 T2 probe | planning-time scout (2026-09-26, before Phase 6): 8 events (3 complete, 2 handoff, 3 session.end), 2 memory entries (1 warning, 1 fact); re-measured as `backfill_expected` |
| live: redact() gap | 07-01 T2 probe | research § 4: all 10 D-04 classes unchanged; re-measured as 11 `redact_gap_class:` lines |

Two-sided rule (standing): every code task diffs failing ids and the normalized tsc set against
`07-BASELINE.md`; a failure or type error that **disappears** fails the gate like a new one; the pass
count must exceed `agent-substrate-pass` (every code task adds tests). The dispatcher gate runs in
07-01 T1, 07-06 T2 and 07-08 T3.

Execution note: `.planning/config.json` has `workflow.use_worktrees: false`, so same-wave plans run
sequentially on the main tree. Waves: 0 = 07-01; 1 = 07-02 (owner checkpoint) and 07-03 (redact
rules); 2 = 07-04 (read path + record shape, code only); 3 = 07-05 (tracer, first restart); 4 = 07-06
(forwarder); 5 = 07-07 (retirements, after 07-06's restart); 6 = 07-08 (proof). Wave 1 is the only
shared wave: 07-02's files (07-02-SPIKE.md, .env.example, substrate.env, RESTORE.d/07-02.md) and
07-03's (redact.ts, redact.test.ts, RESTORE.d/07-03.md) are disjoint; 07-02 Task 3 imports redact.ts
only to scrub error snippets, so either order is valid (declared coupling) — run 07-03 while the owner
works. Code plans (07-03, 07-04, 07-06) write their code route before their first commit, because
substrate-mcp runs the working tree under Restart=always; revert order 07-06 → 07-04 → 07-03.
Phase 8 (Hot cache) edits service.ts/mcp.ts/server.ts after Phase 7 and relies on 07-04's names
(`config.agentmemory`, `Substrate.searchContext`, `reason` = do not cache); every Phase 7 edit to
shared files is additive and re-reads the file at execution (Phase 6 rewrote `emit`).

---

## Sampling Rate

- **After every task commit:** the targeted test file(s) (each code task's `<automated>` starts with them, then runs its named tests with `bun test -t`).
- **After every code task:** full `bun test` + normalized tsc, two-sided against 07-BASELINE.md.
- **Live smoke per plan:** the key=value lines in `07-01-INVENTORY.md`, `07-02-SPIKE.md`, `07-05-TRACER.md`, `07-06-SMOKE.md`, `07-07-SMOKE.md`, `07-PROOF.md`, each checked by the plan's verify, plus a fresh live read (service health, cursor file, agent configs, journal) that must agree with the evidence.
- **Before `/gsd:verify-work`:** all suites green against the baseline, every evidence file complete, `07-PROOF.md` with `proof_result=pass`.
- **Max feedback latency:** 30 seconds for unit gates.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Criterion / Decision | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|----------------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 07-01-01 | 01 | 0 | standing rules (baseline, RESTORE, code-route-before-commit rule, revert order), Phase 6 dependency (exact contract strings + cutover_ingested_at), D-09/D-10 pre-state | T-07-01-01, -02, -04 | agent-config copies 0600 in a 0700 root dir; env via `grep -c` only | live measure | key checks on 07-BASELINE.md; 06-VERIFICATION.md status re-read; `ingested_at?: string`, `export class IngestChain`, `export const EVENT_COLUMNS`; 06-05-CUTOVER.md cutover line; `sha256sum -c` of the t0 manifest; conditional bun/tsc/pytest re-run | ❌ W0 | ⬜ pending |
| 07-01-02 | 01 | 0 | D-01 (decision/warning/fact), D-04, D-11 (sizing) | T-07-01-03 | counts and class names only; run-time fixtures never printed | live probe | 07-01-INVENTORY.md keys and sums; `events_post_cutover_ingested_at_null=0`; token-shape grep = 0 | ❌ W0 | ⬜ pending |
| 07-02-01 | 02 | 1 | credentials rule, RESTORE-first | T-07-02-05 | presence only; route before the owner edit | live | 07-02-SPIKE.md keys; RESTORE.d/07-02.md mode and routes; .env.example empty lines | ❌ | ⬜ pending |
| 07-02-02 | 02 | 1 | SC3, D-08, D-11 (owner; /data volume required) | T-07-02-02, -05, -06 | no-echo append commands; blocking; presence-only verification | checkpoint:human-action | presence `grep -c` lines in `<verification>`; resume-signal (four confirmations) recorded verbatim | — | ⬜ pending |
| 07-02-03 | 02 | 1 | SC3 (version + isolation before the first write), D-08, D-11, W4 (tokens_budget/truncated), research OQ 1-2 | T-07-02-01, -03, -04 | key=value only; evidence checked with non-sudo `grep -F -f`; host scan passes the secret on stdin to `sudo grep -f -` and requires exit 1 | live spike | 07-02-SPIKE.md keys incl. version ≥ 0.9.29 (python compare), scoped/wildcard/other-project, over-fetch truncation, secret_scan_exit=1; live stdin-pattern re-scan | ❌ | ⬜ pending |
| 07-03-01 | 03 | 1 | D-04 (redaction), SC2 | T-07-03-01..04 | code route written before the first commit; run-time fixtures; additive rules | unit (TDD) | RESTORE.d/07-03.md route check (literal head, git log selects commits); `bun test packages/mcp-server/src/redact.test.ts` + 5 named D-04 tests; token-shape grep on the test file = 0; no removed rule lines | ✅ extend | ⬜ pending |
| 07-04-01 | 04 | 2 | D-02, D-04 (caps; redaction of content, concepts, project, agentId), D-08 (deadline) | T-07-04-03, -04, -05, -06 | code route before the first commit; errors carry no URL/secret; 8 KB cap on a code-point boundary | unit (TDD, fake fetch) | RESTORE.d/07-04.md route check; `bun test packages/mcp-server/src/recall/agentmemory.test.ts packages/mcp-server/src/recall/record.test.ts` + 6 named tests; package.json unchanged | ❌ | ⬜ pending |
| 07-04-02 | 04 | 2 | SC1 (D-05 wording), D-05 (token budget, truncation reason), D-06, D-07, D-08, SC2 (query redacted) | T-07-04-01, -02, -07, -08 | UNTRUSTED notice; open like docs_search; fail-open with reason; brief.ts untouched | unit (TDD) | `bun test packages/mcp-server/src/recall/search.test.ts …/service.test.ts …/mcp.test.ts …/server.test.ts` + 10 named tests; `git diff --quiet <head> -- brief.ts` | ✅ extend | ⬜ pending |
| 07-05-01 | 05 | 3 | SC1 live, D-02, D-05, D-06, D-08 — **tracer** | T-07-05-01..04 | clean tree + code routes before the restart; failed restart runs them; throwaway instance with null writing stores | live | 07-05-TRACER.md keys; live healthz/bind; port 7419 closed; RESTORE.d/07-05.md (tracer memory id, pointer to code routes) | ❌ | ⬜ pending |
| 07-06-01 | 06 | 4 | D-01, D-03, D-08 (gate), D-11 (backfill partitioned by the ingested_at snapshot), discretion (cursor file, batching, overlap, keyset memory paging, outage never skips a record) | T-07-06-01, -03, -04, -05, -06 | code route before the first commit; cursor advances only on success; malformed cursor → off, never overwritten | unit (TDD, fake client/source/timers) | RESTORE.d/07-06.md route check; `bun test packages/mcp-server/src/recall/forward.test.ts packages/mcp-server/src/recall/source.test.ts` + 11 named tests (incl. the long-outage test) | ❌ | ⬜ pending |
| 07-06-02 | 06 | 4 | D-03 (never on the caller's path), SC2 | T-07-06-02 | enqueue synchronous; emit bounded with a hung client | unit (TDD) | `bun test packages/mcp-server/src/service.test.ts` + 2 named tests; dispatcher pytest two-sided | ✅ extend | ⬜ pending |
| 07-06-03 | 06 | 4 | SC2 live, D-01, D-03, D-08, D-11 | T-07-06-01, -02, -03, -07, -08 | clean tree; failed restart runs the code route; fixture values 0600 then removed; dummy secret to the fake; drains never write events | live | 07-06-SMOKE.md keys (backfill and continuous = independent counts, live forward ≤ 30 s, fixture 0 leaks, outage/replay); cursor file modes; journal line; port 7421 closed | ❌ | ⬜ pending |
| 07-07-01 | 07 | 5 | SC4, D-09, D-10; owner answer to OQ2 | T-07-07-01, -02, -03, -04, -05 | snapshot + executable routes (literal paths, no `$S`) first; hindsight data kept; only names/counts/sha recorded | live | 07-07-SMOKE.md cc_* keys; live `jq` on ~/.claude.json and settings.json (deny entries = cc_deny_entries); manifest; route resolves to existing snapshot files; headless session transcript has mcp__substrate__context_search | ❌ | ⬜ pending |
| 07-07-02 | 07 | 5 | SC4, D-10 | T-07-07-01, -02, -04 | Hermes' own writer; per-step changed-path check; config.yaml 0600; every snapshot file 0600 | live | 07-07-SMOKE.md hm_* keys; live yaml read; `hermes mcp test substrate`; sha matches | ❌ | ⬜ pending |
| 07-08-01 | 08 | 6 | Proof, D-12 step 1 | T-07-08-01 | exact prompt bytes (JSON checked before the run); shell calls counted; approval override only on a recorded refusal | live model session | 07-PROOF.md Omp keys (omp_prompt_json_ok); Postgres row; journal forwarded line; transcript 0600 | ❌ | ⬜ pending |
| 07-08-02 | 08 | 6 | Proof, D-12 step 2, SC1 | T-07-08-02 | codename absent from Claude's prompt (checked) | live model session | 07-PROOF.md Claude keys; transcript has context_search and the codename; tool.call read-back | ❌ | ⬜ pending |
| 07-08-03 | 08 | 6 | D-02, D-05, D-07, D-10, D-11, SC4 (phase-end), standing gates | T-07-08-03 | secret scan passes the secret on stdin to `sudo grep -rlsF -f -` and requires exit 1 (hit or error fails) | live + full gate | 07-PROOF.md final keys (secret_scan_exit=1); live stdin-pattern scan; full bun/tsc/dispatcher two-sided | ❌ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `07-BASELINE.md` — bun/tsc/dispatcher two-sided keys, Phase 6 gate, live presence keys (07-01 Task 1).
- [ ] `/var/lib/substrate/phase7-baseline/` (0700) with `RESTORE.md` index, `RESTORE.d/07-01.md`, t0 copies of the three agent configs and the hindsight extracts (07-01 Task 1).
- [ ] `07-01-INVENTORY.md` — 14-day qualifying volume, cap sizing, redact() gap (07-01 Task 2; read by 07-03 and 07-06).
- [ ] Agentmemory contract spike (version, isolation, response shape, over-fetch truncation) — deliberately in wave 1 (07-02 Task 3) because it needs the owner's env lines; 07-04 has it as a precondition.
- [ ] No npm/pip install anywhere in the phase (global fetch, zod, bun SQL only); 07-04 T1 checks the package manifests.

---

## Manual-Only Verifications

| Behavior | Criterion | Why Manual | Test Instructions |
|---|---|---|---|
| Railway env report, upgrade to ≥ 0.9.29, single secret holder, appending AGENTMEMORY_URL/SECRET | SC3, D-08, D-11 | Railway is not visible from the host (05-DISCOVERY E3); the secret lives in the service's /data/.hmac | 07-02 Task 2 (blocking human-action) with no-echo append commands; the agent then verifies presence with `grep -c` and the version/isolation live in Task 3. |
| Owner answers to COVERAGE open questions 1 (memory kinds) and 2 (host Claude Code tool exposure) | D-01, D-09 | owner decisions, not derivable | 07-04 pins D-01's kinds (decision/warning/fact) unless the owner widens them first; 07-07 T1's precondition stops until the orchestrator records `allow` or `deny-mutating`. |
| Model behaviour in the proof sessions | D-12 | Omp and Claude are real, nondeterministic model sessions | One retry each (07-08 T1/T2); failed first runs kept under `## Failed runs`; the codename-only-in-the-decision rule makes a guessed answer fail. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or are owner checkpoints with presence-only verification
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all ❌ W0 references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] Baselines re-measured before the first edit (07-01); gates two-sided against 07-BASELINE.md
- [ ] Every live edit outside the repo preceded by a snapshot and a RESTORE.d route
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
