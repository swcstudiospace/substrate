# 25-05 Summary: writer-side clients (ingest CLI, refresh, timer; hook blocked)

**Wave:** 4 · **Plans:** DOCS-02/03 triggers — merges land within one tick, agent-skills after fast-forward · **Live proof:** EXPLICITLY NOT RUN (no network calls; see §5)

## 1. What was built

- **Task 1 — `substrate docs ingest`** (`packages/cli/src/docs-refresh.ts` `runDocsIngest`, wired as `case "docs"` in `packages/cli/src/index.ts`, D25-12): posts to `POST /docs/ingest` with the existing `SUBSTRATE_TOKEN` `headers()` — Phase 20's `packages/cli/src/token.ts` is absent from this base, so the resolver branch does not exist. 256 KiB file pre-check before posting (pinned equal to the server's `MAX_CONTENT_BYTES`; exact-cap posts, +1 refuses); never redacts locally (no `redact` import in either CLI file, asserted by test); `key=value` output (`status`, `dataset_id`, `content_sha256`, `sections`, `redactions`, `images_stripped`, `document_ids`, `would_upload`, one `finding=<line> <rule>` per finding); exit 0 on `uploaded`/`unchanged`/`dry_run`, 1 on refusal/4xx/5xx/unreachable; `SUBSTRATE_DOCS_TIMEOUT_MS`, default ~120 s; not a hook command (real exit codes, documented in the header comment).
- **Task 2 — `substrate docs refresh`** (`runDocsRefresh`, D25-19/D25-20): lists with `git ls-tree -r -z` (blobs only) and reads with `git show <commit>:<path>` in `--repo` (bare mirror for merge datasets; `/root/agent-skills`, overridable by `SUBSTRATE_AGENT_SKILLS_PATH`, for `agent-skills`) — never a working tree or index. One page per matching text file with the canonical `https://github.com/<slug>/blob/<commit>/<path>` URL (`--slug`, else the repo's origin remote); serial posts. Skips counted (non-text, unreadable); refused pages warn to stderr but do not abort and ride absent into `paths_present`. A run that ingested nothing never calls `finalize` and exits 1 (25-02 open item, closed). Parse wait polls *via* `finalize` — the only audited door that reads document run status: `UNSTART`/`missing` (and transport throws) retry until `SUBSTRATE_DOCS_PARSE_TIMEOUT_MS` (~10 min), terminal `FAIL`/`CANCEL` aborts at once, any other status aborts; exit 0 iff the version cut. Posts no events itself; every post carries `session_id: docs-refresh:<dataset>:<short>` so the server's `docs.ingest` rows chain to the run.
- **Task 3 — timer pair + deploy wiring** (D25-18): `infra/vps/substrate-docs-refresh.{service,timer}` — oneshot from `/opt/agent-substrate/current` (`ConditionPathExists` on the entry, `EnvironmentFile=/etc/substrate/substrate.env`, same hardening as `substrate-mcp.service`), timer `OnCalendar=*:0/10` + `Persistent=true`. `SUBSTRATE_RELEASE_UNITS` default gains the `.service` (the `.timer` is deliberately not a restart unit — no `ExecStart` to check; noted in `deploy-release.sh`); `stage()` fixture trees gain the CLI entry; new tests pin the restart and the missing-entry refusal. `doctor-units.ts` needed zero code changes — `loadUnits` auto-discovers the new service; verified it reports no finding for it once committed. Zero host mutations: no enablement, no `/var/lib/substrate/docs` creation outside tmp.
- **Task 4 — STOPPED at the gate, tree untouched (D25-21 blocked):** `packages/mcp-server/src/skills-sync.ts` is absent from this base (Phase 22 not merged), exactly the STOP CONDITION. No hook written, no file created or modified under `packages/mcp-server/`. `git status` proves it.

## 2. Must-haves, observable

- D25-12: `bun test packages/cli/src/docs-refresh.test.ts -t "dry_run"` / `"over 256 KiB"` / `"exit-code matrix"` — shape, pre-check trip (+1 refuses, exact cap posts), 0-vs-1 matrix, Bearer header, snake_case keys, no `surface`; `index.test.ts` repeats the matrix through the real spawned command (import-time dispatch).
- D25-19: `-t "dirty file"` — posted content is the committed blob, never the working tree; `-t "refused page"` — 400-refused page warns, version still cut with it absent; `-t "no ingested pages"` — no `finalize` call, exit 1; canonical URLs asserted verbatim; every posted path is `/docs/ingest` (no client events).
- D25-20: `-t "queued parse"` — UNSTART finalize retried, then cut, exit 0; `-t "failed parse"` — FAIL aborts after exactly 1 finalize, exit 1; `-t "never finishes"` — 30 ms-bound run exits 1.
- D25-18: `bun test infra/vps/deploy-release.test.ts` — refresh service restarted on deploy, release without its entry refused; tick tests clone a file-remote mirror, refresh on drift, report `unchanged` with zero re-posts, and refresh again on a new origin commit.
- D25-21: BLOCKED — `ls packages/mcp-server/src/skills-sync.ts` fails; no hook, no test, no diff. The timer-side catch-up (`agent-skills` from the checkout read-only, `last-refresh-commit` drift file) is implemented and tested in `runDocsTick`, so the hook has a landing zone when Phase 22 merges.

## 3. Verification (run once at end, per plan)

- `bun test packages/cli/src/ infra/vps/` → **142 pass, 0 fail** (5 files; +47 new: 22 docs-refresh + 6 index + 19 deploy incl. 1 new).
- `bunx tsc --noEmit` → **clean, exit 0**; nothing in `packages/cli/src/` errors.
- `bun scripts/doctor-units.ts` → 5 findings: the 4 pre-existing herdr/muse findings (identical on clean HEAD, verified via `git stash`) plus `missing-entry substrate-docs-refresh.service`, which resolves on commit — doctor reads the git tree at HEAD and the entry is still untracked. Re-run after the commit below.
- Rebuilt-file check: only this plan's files (`index.ts`, `docs-refresh.ts`, `docs-refresh.test.ts`, `index.test.ts`, `deploy-release.sh`, `deploy-release.test.ts`, the unit pair, this SUMMARY); `packages/mcp-server/` untouched.

## 4. Files

New: `packages/cli/src/docs-refresh.ts`, `packages/cli/src/docs-refresh.test.ts`, `packages/cli/src/index.test.ts`, `infra/vps/substrate-docs-refresh.service`, `infra/vps/substrate-docs-refresh.timer`.
Modified: `packages/cli/src/index.ts` (dispatch + usage + header), `infra/vps/deploy-release.sh` (unit list + timer note), `infra/vps/deploy-release.test.ts` (fixture entry + 2 assertions).
Not touched: `scripts/doctor-units.ts` (auto-discovery; verified), everything under `packages/mcp-server/` (Task 4 STOP), any host state.

## 5. Live proof — NOT RUN

No `RAGFLOW_URL` or host traffic was made: all HTTP is stubbed, all git is fixture repos in tmp. Operator live steps outstanding: create `/var/lib/substrate/docs`, deploy the release, enable `substrate-docs-refresh.timer` (CONTEXT live step 4); confirm product repo slugs fetchable from the host (live step 2); first `substrate docs refresh` per dataset creating missing datasets (live step 3); search + ingest against the deployed RAGFlow (live step 5); real fast-forward triggering the agent-skills refresh once Phase 22 lands.

## 6. Open / risks

- D25-18 wants `runtime: "docs-refresh"` in the server-recorded event payload, but 25-04's `docs.ingest` row carries no `runtime` and the ingest body has no such field — a client cannot put it there without a server change (out of 25-05 scope). The CLI sends `session_id: docs-refresh:<dataset>:<short>` instead, which the server records on every event; 25-06 smoke can assert the chain. A server-side `runtime` needs a 25-04 follow-up.
- Discretionary choices, all documented in code: per-page 5xx/transport failure aborts the run without finalizing (fail-closed; the next tick retries); `--slug` falls back to the repo's origin remote; refresh posts serially (no parallelism); tick drift state is a `last-refresh-commit` file (a server-side version created by the hook path can cause one redundant re-finalize — pages stay `unchanged`, no re-upload, D25-15 holds).
- `finalize` retry treats every non-terminal 502 as transient until the ~10 min bound; only `FAIL`/`CANCEL` in the message aborts early.
- Pre-existing, not mine: 4 doctor findings (herdr/muse dev-checkout + shared-env) and the Phase 17 scan surface are unchanged from HEAD.
