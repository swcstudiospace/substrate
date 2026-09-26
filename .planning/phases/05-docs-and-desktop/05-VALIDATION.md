---
phase: "5"
slug: "docs-and-desktop"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-09-26"
---

# Phase 5 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Seeded from `05-RESEARCH.md` § Validation Architecture, reconciled with the locked decisions
> D-01..D-20 in `05-CONTEXT.md` and with plans 05-01..05-06 (test file names below are the ones the
> plans create). The criterion and decision coverage matrices are in `COVERAGE.md`.

---

## Test Infrastructure

Phase 5 touches the TypeScript monorepo only (`packages/mcp-server`, `packages/cli`, `infra/desktop`),
plus live state: the new `substrate-desktop` container, `substrate-mcp` restarts, the owner's RAGFlow
on Railway (dataset `substrate-docs`) and `/var/lib/substrate/{phase5-baseline,desktop,docs,proof}`.
No Python is added; the dispatcher suite is a regression gate only.

| Property | Value |
|----------|-------|
| **Framework (TS)** | `bun test` (repo root, colocated `*.test.ts`, no bunfig) + `bunx tsc --noEmit` (root tsconfig includes `packages/**/*.ts`). No test reaches a live RAGFlow or Docker: `fetchImpl` and Buffer-runner fakes only. |
| **Framework (Python)** | `packages/dispatcher` pytest — unchanged, regression gate in 05-01 and 05-06. |
| **Config files** | root `package.json` / `tsconfig.json`; `packages/dispatcher/pyproject.toml` |
| **Quick run command** | `SUBSTRATE_DISABLED=1 /root/.local/share/reflex/bun/bin/bun test packages/mcp-server/src/docs packages/mcp-server/src/desktop packages/mcp-server/src/redact.test.ts` |
| **Full suite command** | `cd /root/src/repos/agent-substrate && SUBSTRATE_DISABLED=1 /root/.local/share/reflex/bun/bin/bun test && /root/.local/share/reflex/bun/bin/bunx tsc --noEmit && (cd packages/dispatcher && python3 -m pytest -q)` |
| **Estimated runtime** | < 30 s per suite (live smokes, the owner checkpoint, the corpus ingest and the proof sessions excluded) |

| Repo / package | Quick run command | Baseline |
|---|---|---|
| agent-substrate (TS) | `SUBSTRATE_DISABLED=1 /root/.local/share/reflex/bun/bin/bun test` | pre-Phase-4 **338 pass / 0 fail / 22 files** at `b866793`; **re-measured at the post-Phase-4 HEAD by 05-01 into `gate-pass` / `gate-failing-id:`** (D-14 part 4) — every Phase 5 gate reads the `gate-*` keys |
| agent-substrate (tsc) | normalized `bunx tsc --noEmit` pipeline (05-BASELINE.md § Commands) | pre-Phase-4 `tsc-exit=0`; re-measured into `gate-tsc-set:` |
| dispatcher (Python) | `cd packages/dispatcher && python3 -m pytest -q` | pre-Phase-4 **149 passed**; re-measured into `gate-dispatcher-pass` / `gate-dispatcher-failing-id:` |

Two-sided rule (standing): every gate diffs failing ids and the normalized tsc set against the
`gate-*` keys in `05-BASELINE.md`; a failure or type error that **disappears** fails the gate like a
new one; the bun pass count must be greater than `gate-pass` in every plan that adds tests (`-gt`),
and the dispatcher count must not drop (`-ge`). Failures present at measurement belong to other
sessions and are not repaired.

Execution note: `.planning/config.json` has `workflow.use_worktrees: false`. Wave 1 holds 05-02 (no
source files) and 05-03. Their only shared live resource was the rollback file; it is now split
(Phase 4's RESTORE.d pattern): 05-01 alone writes the index `/var/lib/substrate/phase5-baseline/RESTORE.md`,
and each plan writes only its own `RESTORE.d/05-NN.md`, declared in its `files_modified`. With that,
the wave-1 plans write no common file (repo or live) and may run concurrently. 05-04 → 05-05 → 05-06 are
sequential. If the owner answers "skip" at 05-02's checkpoint, 05-03 still completes and 05-04..05-06
do not start.

---

## Sampling Rate

- **After every task commit:** the targeted test file(s) for the touched module (each code task's `<automated>` starts with them).
- **After every plan (last code task):** full `bun test` + normalized tsc, two-sided against the `gate-*` keys; dispatcher pytest in 05-01 T1 and 05-06 T3.
- **Live smoke per plan:** the key=value lines in `05-01-INVENTORY.md`, `05-02-SPIKE.md`, `05-03-SMOKE.md`, `05-04-TRACER.md`, `05-05-SMOKE.md`, `05-PROOF.md`, each checked by the task's verify.
- **Before `/gsd:verify-work`:** all suites green against `gate-*`, every evidence file complete, `05-PROOF.md` with `proof_result=pass`.
- **Max feedback latency:** 30 seconds for unit gates.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Criterion / Decision | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|----------------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 05-01-01 | 01 | 0 | Precondition (Phase 4 landed), disk gate, D-14 part 4, standing rules | T-05-01-01, -03, -04 | presence-only probes; nothing secret copied | live measure | `gate-*` key checks; fresh bun/tsc/pytest runs equal the recorded values; library checkout and Phase 4 symbol greps; `df` ≥ 10 GiB; t0 `sha256sum -c` | ❌ W0 | ⬜ pending |
| 05-01-02 | 01 | 0 | D-15, D-07, D-08, D-17, D-11/D-20 hit counts | T-05-01-02 | counts and prefixes only | live inventory | 05-01-INVENTORY.md keys (corpus_dirs ≥ 25, url_missing=0, sums, tracer_url) | ❌ W0 | ⬜ pending |
| 05-02-01 | 02 | 1 | D-02, standing snapshot rule | T-05-02-06 | undo route before the owner edit | live presence | 05-02-SPIKE.md `env_*_before` keys; `RESTORE.d/05-02.md` (0600) grep | ❌ | ⬜ pending |
| 05-02-02 | 02 | 1 | D-02, D-04, D-05, D-06 | T-05-02-02, -04, -06 | values never read or printed | checkpoint (human-action) | presence: `sudo grep -c '^RAGFLOW_URL=https://'` = 1, `sudo grep -c '^RAGFLOW_API_KEY=ragflow-'` = 1, mode `600 root` | — | ⬜ pending |
| 05-02-03 | 02 | 1 | D-01, D-04, D-05, D-06, D-08, D-09, D-17 | T-05-02-01, -03, -05, -07 | keyed probes print key=value only; every spike body redact()ed before strip/hash/upload; evidence checked against both values with `grep -F -f` | live spike | 05-02-SPIKE.md keys; `spike_result=pass`, `spike_redact_applied=true`, `tei_no_public_domain=owner-confirmed`, `register_enabled=0`, `embedding_model_is_bge_small=true`, `cleanup=ok` | ❌ | ⬜ pending |
| 05-03-01 | 03 | 1 | SC3 (D-16), D-12, D-18 | T-05-03-04, -05, -SC | never touches the recruitment container; loopback + basic auth; `--pull never` | live | 05-03-SMOKE.md container keys; `docker inspect`/`docker port`; `ss`; `curl` 401; recruitment StartedAt equality | ❌ | ⬜ pending |
| 05-03-02 | 03 | 1 | D-13 | T-05-03-01, -06, -07 | closed vocabulary, no shell, typed text hashed, mutex, deadlines | unit | `bun test packages/mcp-server/src/desktop/actions.test.ts packages/mcp-server/src/desktop/driver.test.ts` | ❌ | ⬜ pending |
| 05-03-03 | 03 | 1 | SC3, D-13, D-19, D-14 part 2 | T-05-03-02 | VM-guest-shaped caller refused | unit + live MCP | `bun test packages/mcp-server/src/mcp.test.ts` + 05-03-SMOKE.md GUI keys + full gate | ✅ extend | ⬜ pending |
| 05-04-01 | 04 | 2 | D-11, D-20, D-02, D-01, D-05 | T-05-04-02, -03 | key never in errors; sha256 values intact; existing redact tests byte-identical | unit | `bun test packages/mcp-server/src/redact.test.ts packages/mcp-server/src/docs/ragflow.test.ts` | ✅ extend / ❌ | ⬜ pending |
| 05-04-02 | 04 | 2 | D-08, D-09, D-10, D-17 | T-05-04-01, -04, -05, -06, -07 | realpath containment; redact → strip → hash; dataset guard | unit | `bun test packages/mcp-server/src/docs/source.test.ts packages/mcp-server/src/docs/ingest.test.ts packages/mcp-server/src/docs/search.test.ts` | ❌ | ⬜ pending |
| 05-04-03 | 04 | 2 | SC1 (module), SC2, D-07/D-15 (tracer), D-09 | T-05-04-01, -05 | CLI in-process under EnvironmentFile | live CLI tracer | 05-04-TRACER.md keys (`rerun_writes=0`, `search_has_tracer_url=true`) + full gate | ❌ | ⬜ pending |
| 05-05-01 | 05 | 3 | SC1, SC2, D-10, D-19 | T-05-05-01, -02, -03, -07 | guard before body; 413; open search | unit / in-process integration | `bun test packages/mcp-server/src/service.test.ts packages/mcp-server/src/mcp.test.ts packages/mcp-server/src/server.test.ts` + full gate | ✅ extend | ⬜ pending |
| 05-05-02 | 05 | 3 | SC1, SC2, D-19 | T-05-05-01, -06 | anonymous ingest refused live | live MCP/REST | 05-05-SMOKE.md keys (401, 413, isError, cited URL, tool.call event) | ❌ | ⬜ pending |
| 05-05-03 | 05 | 3 | D-07/D-15, D-09, D-14 part 3, SC2 | T-05-05-04 | generated values never printed or committed | live | 05-05-SMOKE.md corpus and fixture keys (raw and MCP leaks 0) | ❌ | ⬜ pending |
| 05-06-01 | 06 | 4 | Proof, D-14 part 1, SC1 | T-05-06-02, -03 | session-scoped config; no agent config edited | live model session | 05-PROOF.md docs keys; transcript contains the URL; tool.call read-back | ❌ | ⬜ pending |
| 05-06-02 | 06 | 4 | Proof, D-14 parts 2-3, SC3 | T-05-06-01, -03 | key via headersHelper, never in a config | live model session | 05-PROOF.md GUI and fixture keys; desktop.action read-back | ❌ | ⬜ pending |
| 05-06-03 | 06 | 4 | D-14 part 4, standing gates | T-05-06-01 | configs/helper/values removed; transcripts key-free | full gate | bun + tsc + dispatcher two-sided against `gate-*`; `proof_result=pass` | ❌ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

Re-running per-task commands later (validate-phase, verify-work): the verifies are written to stay true after later plans run. 05-01 T1 checks gate-head against the commit that recorded it and re-runs the suites only while the code outside `.planning` still equals gate-head; 05-05 T3 checks the fixture values file while it exists and otherwise reads 05-PROOF.md's `fixture_values_removed=true`; 05-02 T1's presence check allows the count to grow. Checks that read live service state (the recruitment container's StartedAt, `/healthz`, the 127.0.0.1:7410 bind) can legitimately change after a host reboot; a later red there means "re-observe", not a plan defect.

### Behaviours pinned by unit tests with fakes (no live RAGFlow or Docker)

Every row's test carries a unique name (prefixed with its decision id; no Phase 4 test uses these names), and the task's `<automated>` runs each one with `bun test <file> -t "<name>"`, which exits non-zero when 0 tests match — so a missing test fails the verify even though Phase 4's own refusal and 413 tests contain similar strings.

| Named test | File | Plan / task |
|---|---|---|
| `D-19 desktop_run refuses a session without the host propose key` | mcp.test.ts | 05-03 T3 |
| `D-19 docs_ingest refuses a session without the host propose key`, `D-19 docs_search stays open to a session without the key` | mcp.test.ts | 05-05 T1 |
| `D-19 POST /docs/ingest answers 401 before reading the body`, `D-10 POST /docs/ingest answers 413 over 1 MB`, `D-10 POST /docs/search answers 413 over 1 MB`, `D-19 POST /docs/search stays open to anonymous callers` | server.test.ts | 05-05 T1 |
| `D-08 citation URL order is manifest url then Source line then root_url`, `D-09 pages that differ only in a redacted secret hash the same` | source.test.ts | 05-04 T2 |
| `D-09 a second plan against the applied state makes zero writes` | ingest.test.ts | 05-04 T2 |
| `D-05 retrievalBody never sends a chat-model field`, `D-05 createDatasetBody omits embedding_model and auto_metadata_config`, `D-02 RagflowError never contains the key or an Authorization header` | ragflow.test.ts | 05-04 T1 |


| Behaviour | Test file | Plan / task |
|---|---|---|
| 1 MB body cap → 413 on `/docs/search` and `/docs/ingest` (Phase 4 `BodyTooLargeError`) | server.test.ts | 05-05 T1 |
| Idempotency by the hash of the redacted, image-stripped bytes (skip / reparse / delete-then-upload / zero-write second plan; secret-only differences hash equal) | source.test.ts, ingest.test.ts | 05-04 T2 |
| Citation URL order: manifest `pages[].url` → `Source:` line within 20 lines → `root_url` → refused | source.test.ts; search-time fallback in search.test.ts | 05-04 T2 |
| VM-guest refusal (proposeAllowed false): `desktop_run` and `docs_ingest` isError, `/docs/ingest` 401 before body; `docs_search` and `/docs/search` open | mcp.test.ts, server.test.ts | 05-03 T3, 05-05 T1 |
| Redaction rules `ragflow-…`, hyphenated `sk-…` (sk-cp, sk-proj, sk-svcacct, sk-or-v1); sha256/prose untouched; existing cases unchanged | redact.test.ts | 05-04 T1 |
| Retrieval body never carries a chat-model field; dataset created without embedding_model; wrong-model dataset refused | ragflow.test.ts, ingest.test.ts | 05-04 T1/T2 |
| Key never in RagflowError messages (echoing fake) | ragflow.test.ts | 05-04 T1 |
| Desktop closed vocabulary, exact argv, bounds before input, Buffer screenshots → PNG, mutex, deadlines, one event per action, typed text hashed | actions.test.ts, driver.test.ts | 05-03 T2 |

---

## Wave 0 Requirements

- [ ] Precondition: Phase 4 landed — `04-VERIFICATION.md` `status: passed` or a recorded orchestrator acceptance; `/root/agent-skills` a clean `main` checkout of swcstudiospace/agent-skills with no top-level links; Phase 4 symbols present (05-01 Task 1; research Pitfall 17).
- [ ] Disk gate `df --output=avail -B1 /` ≥ 10737418240 (05-01 Task 1; again before `substrate-desktop.sh up` and the corpus ingest).
- [ ] `05-BASELINE.md` `gate-*` re-measure at the post-Phase-4 HEAD (05-01 Task 1; D-14 part 4).
- [ ] `/var/lib/substrate/phase5-baseline/` (0700) with the `RESTORE.md` index (written only by 05-01), an empty `RESTORE.d/` (0700) for the per-plan route files, and a t0 snapshot + manifest (05-01 Task 1).
- [ ] `05-01-INVENTORY.md` measured on the checkout, not the exports dir (05-01 Task 2; research Wave 0 gap).
- [ ] New test files are created with their modules (desktop/*, docs/*); no framework install anywhere in the phase (no npm/PyPI/cargo package, no image pull on the VPS).

---

## Manual-Only Verifications

| Behavior | Criterion | Why Manual | Test Instructions |
|---|---|---|---|
| TEI on Railway, HuggingFace provider as default embedding, chat model unset, API key, `REGISTER_ENABLED=0`, env lines | D-02, D-04, D-05, D-06 | needs the owner's Railway and RAGFlow accounts; the VPS cannot see the Railway project | 05-02 Task 2 exact steps; the agent verifies presence only, then 05-02 Task 3 checks healthz, registerEnabled and the dataset's embedding model with keyed probes. |
| Chat model left unset | D-05 | not visible through the API key | owner confirms in the resume reply ("chat model left unset: yes"), recorded as `chat_model_unset=owner-confirmed`. |
| Real model sessions (docs citation, desktop driving) | Proof, SC1, SC3 | model behaviour is nondeterministic | 05-06 Tasks 1-2: one retry per session, failed first runs kept under `## Failed runs`; tool use and events are read back rather than trusted from the answer text. |
| Watching the desktop in a browser | D-18 | optional owner convenience | SSH tunnel to 127.0.0.1:6081 with the credentials in `/etc/substrate/substrate-desktop.env`; not required for any gate (401/200 codes are checked automatically). |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or are owner checkpoints with presence-only verification
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all ❌ W0 references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] Baseline re-measured at the post-Phase-4 HEAD before the first gate (05-01); gates two-sided against `gate-*`
- [ ] Every live change (substrate-desktop, substrate-desktop.env, substrate-mcp restarts, RAGFlow dataset, redaction fixture and values file, proof files) preceded by a route in that plan's own `RESTORE.d/05-NN.md`
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
