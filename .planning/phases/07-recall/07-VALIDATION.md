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
> reconciled with plans 07-01..07-07 (test file names below are the ones the plans create). The
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
| **Framework (Python)** | `packages/dispatcher` pytest — untouched by Phase 7; regression gate only (07-01, 07-05 T2, 07-07 T3). |
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
07-01 T1, 07-05 T2 and 07-07 T3.

Execution note: `.planning/config.json` has `workflow.use_worktrees: false`, so same-wave plans run
sequentially on the main tree. Wave 1: 07-02 (owner checkpoint; files: 07-02-SPIKE.md,
.env.example, RESTORE.d/07-02.md) and 07-03 (redact.ts, redact.test.ts) are disjoint — run 07-03
while the owner works. Wave 3: 07-05 (code) and 07-06 (agent configs + its evidence) are disjoint.
Phase 8 (Hot cache) edits service.ts/mcp.ts/server.ts after Phase 7 and relies on 07-04's names
(`config.agentmemory`, `Substrate.searchContext`, `reason` = do not cache); every Phase 7 edit to
shared files is additive and re-reads the file at execution (Phase 6 rewrote `emit`).

---

## Sampling Rate

- **After every task commit:** the targeted test file(s) (each code task's `<automated>` starts with them, then runs its named tests with `bun test -t`).
- **After every code task:** full `bun test` + normalized tsc, two-sided against 07-BASELINE.md.
- **Live smoke per plan:** the key=value lines in `07-01-INVENTORY.md`, `07-02-SPIKE.md`, `07-04-TRACER.md`, `07-05-SMOKE.md`, `07-06-SMOKE.md`, `07-PROOF.md`, each checked by the plan's verify, plus a fresh live read (service health, cursor file, agent configs, journal) that must agree with the evidence.
- **Before `/gsd:verify-work`:** all suites green against the baseline, every evidence file complete, `07-PROOF.md` with `proof_result=pass`.
- **Max feedback latency:** 30 seconds for unit gates.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Criterion / Decision | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|----------------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 07-01-01 | 01 | 0 | standing rules (baseline, RESTORE), Phase 6 dependency, D-09/D-10 pre-state | T-07-01-01, -02, -04 | agent-config copies 0600 in a 0700 root dir; env via `grep -c` only | live measure | key checks on 07-BASELINE.md; 06-VERIFICATION.md status re-read; Phase 6 symbols; `sha256sum -c` of the t0 manifest; conditional bun/tsc/pytest re-run | ❌ W0 | ⬜ pending |
| 07-01-02 | 01 | 0 | D-01, D-04, D-11 (sizing) | T-07-01-03 | counts and class names only; run-time fixtures never printed | live probe | 07-01-INVENTORY.md keys and sums; `events_post_cutover_ingested_at_null=0`; token-shape grep = 0 | ❌ W0 | ⬜ pending |
| 07-02-01 | 02 | 1 | credentials rule, RESTORE-first | T-07-02-05 | presence only; route before the owner edit | live | 07-02-SPIKE.md keys; RESTORE.d/07-02.md mode and routes; .env.example empty lines | ❌ | ⬜ pending |
| 07-02-02 | 02 | 1 | SC3, D-08, D-11 (owner) | T-07-02-02, -05, -06 | no-echo append commands; blocking; presence-only verification | checkpoint:human-action | presence `grep -c` lines in `<verification>`; resume-signal recorded verbatim | — | ⬜ pending |
| 07-02-03 | 02 | 1 | SC3 (version + isolation before the first write), D-08, D-11, research OQ 1-2 | T-07-02-01, -03, -04 | key=value only; secret/URL checked absent with `grep -F -f`; spike memory forgotten | live spike | 07-02-SPIKE.md keys incl. version ≥ 0.9.29 (python compare), scoped/wildcard/other-project results, secret_only_in_env | ❌ | ⬜ pending |
| 07-03-01 | 03 | 1 | D-04 (redaction), SC2 | T-07-03-01..04 | run-time fixtures; additive rules | unit (TDD) | `bun test packages/mcp-server/src/redact.test.ts` + 5 named D-04 tests; token-shape grep on the test file = 0; no removed rule lines | ✅ extend | ⬜ pending |
| 07-04-01 | 04 | 2 | D-02, D-04 (caps, forward-time redaction), D-08 (deadline) | T-07-04-03, -04, -05 | errors carry no URL/secret; 8 KB cap on a code-point boundary | unit (TDD, fake fetch) | `bun test packages/mcp-server/src/recall/agentmemory.test.ts packages/mcp-server/src/recall/record.test.ts` + 5 named tests; package.json unchanged | ❌ | ⬜ pending |
| 07-04-02 | 04 | 2 | SC1 (D-05 wording), D-05, D-06, D-07, D-08 | T-07-04-01, -02, -07, -08 | UNTRUSTED notice; open like docs_search; fail-open with reason; brief.ts untouched | unit (TDD) | `bun test packages/mcp-server/src/recall/search.test.ts …/service.test.ts …/mcp.test.ts …/server.test.ts` + 8 named tests; `git diff --quiet <head> -- brief.ts` | ✅ extend | ⬜ pending |
| 07-04-03 | 04 | 2 | SC1 live, D-02, D-05, D-06, D-08 — **tracer** | T-07-04-02, -06 | guarded restart; throwaway instance with null writing stores | live | 07-04-TRACER.md keys; live healthz/bind; port 7419 closed; RESTORE.d/07-04.md routes | ❌ | ⬜ pending |
| 07-05-01 | 05 | 3 | D-01, D-03, D-08 (gate), D-11 (backfill), discretion (cursor file, batching, overlap) | T-07-05-01, -03, -04, -05, -06 | cursor advances only on success; malformed cursor → off, never overwritten | unit (TDD, fake client/source/timers) | `bun test packages/mcp-server/src/recall/forward.test.ts packages/mcp-server/src/recall/source.test.ts` + 9 named tests | ❌ | ⬜ pending |
| 07-05-02 | 05 | 3 | D-03 (never on the caller's path), SC2 | T-07-05-02 | enqueue synchronous; emit bounded with a hung client | unit (TDD) | `bun test packages/mcp-server/src/service.test.ts` + 2 named tests; dispatcher pytest two-sided | ✅ extend | ⬜ pending |
| 07-05-03 | 05 | 3 | SC2 live, D-01, D-03, D-08, D-11 | T-07-05-01, -02, -03, -07, -08 | fixture values 0600 then removed; dummy secret to the fake; drains never write events | live | 07-05-SMOKE.md keys (backfill = independent count, live forward ≤ 30 s, fixture 0 leaks, outage/replay); cursor file modes; journal line; port 7421 closed | ❌ | ⬜ pending |
| 07-06-01 | 06 | 3 | SC4, D-09, D-10 | T-07-06-01, -02, -03, -04, -05 | snapshot + routes first; hindsight data kept; only names/counts/sha recorded | live | 07-06-SMOKE.md cc_* keys; live `jq` on ~/.claude.json and settings.json; manifest; headless session transcript has mcp__substrate__context_search | ❌ | ⬜ pending |
| 07-06-02 | 06 | 3 | SC4, D-10 | T-07-06-01, -02, -04 | Hermes' own writer; per-step changed-path check; config.yaml 0600 | live | 07-06-SMOKE.md hm_* keys; live yaml read; `hermes mcp test substrate`; sha matches | ❌ | ⬜ pending |
| 07-07-01 | 07 | 4 | Proof, D-12 step 1 | T-07-07-01 | exact command; shell calls counted; approval override only on a recorded refusal | live model session | 07-PROOF.md Omp keys; Postgres row; journal forwarded line; transcript 0600 | ❌ | ⬜ pending |
| 07-07-02 | 07 | 4 | Proof, D-12 step 2, SC1 | T-07-07-02 | codename absent from Claude's prompt (checked) | live model session | 07-PROOF.md Claude keys; transcript has context_search and the codename; tool.call read-back | ❌ | ⬜ pending |
| 07-07-03 | 07 | 4 | D-02, D-05, D-07, D-10, D-11, SC4 (phase-end), standing gates | T-07-07-03 | secret scan over proof7, rollback area, repo, agent configs and the journal | live + full gate | 07-PROOF.md final keys; `grep -rlsF -f` = empty; full bun/tsc/dispatcher two-sided | ❌ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `07-BASELINE.md` — bun/tsc/dispatcher two-sided keys, Phase 6 gate, live presence keys (07-01 Task 1).
- [ ] `/var/lib/substrate/phase7-baseline/` (0700) with `RESTORE.md` index, `RESTORE.d/07-01.md`, t0 copies of the three agent configs and the hindsight extracts (07-01 Task 1).
- [ ] `07-01-INVENTORY.md` — 14-day qualifying volume, cap sizing, redact() gap (07-01 Task 2; read by 07-03 and 07-05).
- [ ] Agentmemory contract spike (version, isolation, response shape) — deliberately in wave 1 (07-02 Task 3) because it needs the owner's env lines; 07-04 has it as a precondition.
- [ ] No npm/pip install anywhere in the phase (global fetch, zod, bun SQL only); 07-04 T1 checks the package manifests.

---

## Manual-Only Verifications

| Behavior | Criterion | Why Manual | Test Instructions |
|---|---|---|---|
| Railway env report, upgrade to ≥ 0.9.29, single secret holder, appending AGENTMEMORY_URL/SECRET | SC3, D-08, D-11 | Railway is not visible from the host (05-DISCOVERY E3); the secret lives in the service's /data/.hmac | 07-02 Task 2 (blocking human-action) with no-echo append commands; the agent then verifies presence with `grep -c` and the version/isolation live in Task 3. |
| Model behaviour in the proof sessions | D-12 | Omp and Claude are real, nondeterministic model sessions | One retry each (07-07 T1/T2); failed first runs kept under `## Failed runs`; the codename-only-in-the-decision rule makes a guessed answer fail. |

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
