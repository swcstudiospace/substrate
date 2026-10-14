# 25-06 Summary: harness fixture, docs smoke, reconciled docs (close-out)

**Wave:** 5 (close-out) · **Plans:** DOCS-01/02/03 proof in isolation + contract docs · **Live proof:** EXPLICITLY NOT RUN (see §5)

## 1. What was built

- **Task 1 — `rehearsal up --ragflow-fixture`** (D25-24): new `packages/mcp-server/src/rehearsal-fake-ragflow.ts` (loopback Bun server implementing exactly the endpoints `RagflowClient` uses — retrieval, list/get datasets, upload, parse, update, delete, ensure — against run-dir state persisted on every mutation to `ragflow-fixture/state.json`, with scriptable `timeout`/`error`/`malformed`/`http-error` modes via `mode.json` without restart, plus an in-process `startFakeRagflow` handle for unit tests); new `rehearsal-ragflow.ts` builder (one-dataset `harness-docs` registry, receipts excluded, rebuilt on every call); `rehearsal-env.ts` accepts the six fixture keys (URL loopback-enforced, paths inside-run-enforced) and now **always** points `SUBSTRATE_DOCS_STATE` inside the run dir, never at the production default; `scripts/rehearsal.ts` spawns/stops the fake as a verified detached child (pid recorded in `state.json`, identity-checked `stopRagflowFake`, all `up` failure paths and `down`/`status` wired, `consumer.env` gains four `SUBSTRATE_REHEARSAL_RAGFLOW_*` keys). Tests: 13 fake + 6 builder + 8 env + 4 harness.
- **Task 2 — `bun run smoke:docs`** (`scripts/docs-smoke.ts` + package.json entry, D25-25): keeps Phase 16 guards (`consumer.env` only, `refuseSmokeUrl` — port 7410 refused, loopback only) and proves (a) uploaded on route/MCP/CLI + unchanged re-ingest with upload counting at the fake; (b) every refusal with the fake counter unmoved — no-source, outside-roots (receipts, foreign slug, empty segment), oversize page (400 too-large) and body (413), non-text, runtime-assembled planted secret (finding `{line:3,rule:"github"}`, value in no response/event/audit/fake state), anonymous 401s, agent-token 403/`isError`; (c) 3 images stripped, alt text as `[image: …]` placeholders in fake state; (d) six finalizes keep five versions, fallen-out content unsearchable, current commit found; (e) limit honoured, all DOCS-01 fields, snippets ≤1200, `untrusted:true`; (f) timeout/error/malformed → `results:[]` with matching reasons, recovery without restart; (g) `docs.search` note with URLs + `docs.ingest` rows on the trail, both transports in the audit file. **72/72 green** against twin `p25docs`.
- **Task 3 — docs reconciliation** (D25-22): `docs/data-planes.md` (timer+hook triggers not Actions, DOCS-01 fields, `RAGFLOW_MCP_URL` unused #16369, env-name-only references); `.env.example` drops `RAGFLOW_DATASET_ID`, documents the six vars with the unused-MCP note (and empties the previously hardcoded forwarder value); new `docs/docs-plane.md` (both contracts, writer rule, caps, refusals, registry, versions, refresh, triggers, proof); `docs/mcp-audit.md` marks both rows **landed**; `server.ts` header lists `/docs/search` + `/docs/ingest` (CLI header already listed both commands).
- **Task 4 — `docs/rehearsal.md`**: `--ragflow-fixture` flag, four new consumer keys, and the live-gated proof checklist — all five CONTEXT live steps verbatim-gated, approval windows blank, status NOT RUN, provisional-slug scope noted.

## 2. Must-haves, observable

- D25-24: `bun run rehearsal up --name p25docs --port 0 --ragflow-fixture` → twin + `fake RAGFlow on 127.0.0.1:<port>`; `down` stops both, run dir removed, no orphans.
- D25-25: `bun run smoke:docs` → **72/72 checks passed** (two iterations: 68/71 then 72/72 after smoke fixes only — no product change).
- D25-22: `grep RAGFLOW_DATASET_ID .env.example` empty; six vars documented; no secret/URL/hostname added by the diff (loopback + `rehearsal/`/`example.com` fixture markers only).
- Isolation: twin ran with `--port 0` (17410 was held by a sibling process); all traffic loopback; tmp run dirs only; planted secret runtime-assembled with value-absence assertions.

## 3. Verification (proof run, this worktree)

- `rehearsal up --name p25docs --port 0 --ragflow-fixture` → up (twin :45597, fake :40925); `rehearsal down` → stopped, 2 containers removed, dir gone.
- `bun run smoke:docs` → **72/72**.
- `bun test` → **2351 pass, 57 skip, 1 fail** — the fail is `scripts/doctor-units.test.ts > repo units match the known pre-cutover shape at HEAD`, pre-existing at HEAD: 25-05 (98c60b1) added `substrate-docs-refresh.service` without updating the exact-4-units expectation; `infra/vps/` untouched by this plan. Recorded, not fixed.
- `bunx tsc --noEmit` → clean, exit 0.
- `bun run check:phase-close` → pass (EVENT_KINDS 12, SURFACES 27).
- `bun scripts/doctor-units.ts` → the known 4 pre-existing findings (herdr/muse dev-checkout + shared-env), unchanged from HEAD.
- Commit: single `feat(v1.3 phase 25):` commit mentioning 25-06 (below). Not pushed.

## 4. Files

New: `packages/mcp-server/src/rehearsal-fake-ragflow.ts` (+`.test.ts`), `rehearsal-ragflow.ts` (+`.test.ts`), `scripts/docs-smoke.ts`, `docs/docs-plane.md`, this SUMMARY.
Modified: `packages/mcp-server/src/rehearsal-env.ts` (+`.test.ts`), `scripts/rehearsal.ts` (+`.test.ts`), `package.json` (`smoke:docs`), `docs/data-planes.md`, `docs/mcp-audit.md`, `docs/rehearsal.md`, `.env.example`, `packages/mcp-server/src/server.ts` (header only).

## 5. Live proof — NOT RUN

Zero live calls, zero production writes. All five CONTEXT live steps (version/datasets/models read; slug/fetch read; dataset creation + first refresh; deploy + state dir + timer enablement; live search+ingest + fast-forward trigger) are listed gated-not-run in `docs/rehearsal.md` with blank approval windows.

## 6. Open / risks

- **Current-only search is enforced by deletion, not by post-filter (flagged, not fixed).** `versions.ts` documents mechanism preference 3 ("`currentDocumentIds` — the set search.ts intersects hits with"), but `service.ts` never wires `lookupSource`, so kept-but-superseded versions still resolve and return. The smoke pins the deletion guarantee (fallen-out round unsearchable, hits only from kept versions). Wiring a strict current-only filter would also hide never-versioned pages, which (e) requires searchable — 25-02/25-04 owners should reconcile D25-17-preference-3 with unversioned-page searchability in a follow-up.
- **Anonymous search over the wire is 401 on a tokened twin** (gate rejects before the service); the `unauthenticated` reason belongs to `--anonymous` runs and is pinned at service level. Smoke asserts the 401.
- A literal `..` never survives URL parsing, so the smoke's traversal-adjacent refusal is the empty segment (`//`); `%2e%2e` is *not* refused by `normalisePath` (decodes nothing) — same follow-up bucket if the owners want it closed.
- `docs/grok-bot.md:43` still claims RAGFlow adapters are unimplemented — stale since 25-01..25-05, outside this plan's file list; suggested follow-up.
- Pre-existing, not mine: the doctor-units exact-list failure (§3), 4 doctor findings, ledger `redact()` noise in unrelated test output.
