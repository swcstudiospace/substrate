# Coverage — Phase 5 (Docs and desktop)

> Full coverage by default. Opt-outs are explicit, reasoned decisions.
> Plans: 05-01 (Phase 4 precondition, disk gate, post-Phase-4 baseline, rollback area, corpus inventory),
> 05-02 (owner RAGFlow/TEI checkpoint, keyed checks, live contract spike), 05-03 (substrate-desktop container,
> desktop_run, GUI smoke), 05-04 (redaction rules, RAGFlow client, source/ingest/search modules, CLI, docs-python tracer),
> 05-05 (docs_search/docs_ingest tools, /docs/* routes, full corpus, redaction fixture), 05-06 (proof).
> Task references are `plan / task` (e.g. 05-04 T2).

## ROADMAP success criteria and proof → plan/task

| Criterion | Covered by | Evidence key(s) |
|---|---|---|
| SC1 `docs.search` proxies the owner's RAGFlow retrieval API (D-03 re-scope of "the existing RAGFlow MCP endpoint (`ragflow_retrieval`)"; MCP name `docs_search`) | 05-02 T2/T3 (backend, contract), 05-04 T1 (HTTP client, `/api/v1/retrieval`), 05-04 T2 (normaliser, citation URL), 05-04 T3 (CLI search), 05-05 T1/T2 (MCP `docs_search`, REST `/docs/search`), 05-06 T1 (agent) | 05-02-SPIKE.md `retrieval_code=0`, `ref_metadata_url`; 05-04-TRACER.md `search_has_tracer_url=true`; 05-05-SMOKE.md `mcp_search_has_tracer_url=true`, `search_tool_call_has_url=true`; 05-PROOF.md `claude_reply_has_url=true` |
| SC2 `docs.ingest` runs the redactor before ingesting (MCP name `docs_ingest`) | 05-04 T1 (rules D-11/D-20), 05-04 T2 (`preparePage`: redact → strip → hash), 05-04 T3 (CLI), 05-05 T1 (MCP `docs_ingest`, REST `/docs/ingest`), 05-05 T3 (fixture read back raw from RAGFlow), 05-06 T2 (re-check) | 05-05-SMOKE.md `fixture_raw_redacted_count≥4`, `fixture_raw_value_leaks=0`, `fixture_mcp_value_leaks=0`; 05-PROOF.md `fixture_recheck_value_leaks=0` |
| SC3 `desktop.run` drives a dedicated webtop container on the Docker path (docker exec + xdotool/xwd) (D-16 re-scope of "drives cua on the Docker path or the existing recruitment-desktop webtop"; MCP name `desktop_run`) | 05-03 T1 (container), 05-03 T2 (vocabulary, driver), 05-03 T3 (MCP tool, GUI smoke), 05-06 T2 (agent) | 05-03-SMOKE.md `running=true`, `smoke_title`, `smoke_events=4`, `recruitment_unchanged=true`; 05-PROOF.md `gui_route=agent`, `gui_events=4` |
| SC3 "No QEMU path — this host has no `/dev/kvm`" | 05-03 (Docker path only) | no QEMU/KVM code or config anywhere in the phase |
| **Proof** — an agent answers a docs question with a citation; a GUI smoke test runs in a sandbox | 05-06 T1 (docs session), 05-06 T2 (desktop session), 05-06 T3 (final gate) | 05-PROOF.md `proof_result=pass` |
| D-14 part 1 real MCP `docs_search` returns a chunk with its source URL; the answer cites it | 05-05 T2 (JSON-RPC), 05-06 T1 (Claude Code session) | `docs_tool_result_has_url=true`, `claude_reply_has_url=true`, `tool_call_event_has_url=true` |
| D-14 part 2 GUI smoke in substrate-desktop (terminal, type, xwd, title via xdotool) | 05-03 T3 (JSON-RPC), 05-06 T2 (agent) | `smoke_title`, `smoke_png=1280x800`, `gui_title`, `gui_png` |
| D-14 part 3 redaction fixture comes back `[REDACTED]` from `docs_search` | 05-05 T3, 05-06 T2 | `fixture_mcp_redacted_count≥4`, `fixture_recheck_redacted_count≥4` |
| D-14 part 4 baseline re-measured at the current HEAD before the first gate | 05-01 T1 | 05-BASELINE.md `gate-head`, `gate-pass`, `gate-tsc-set:`, `gate-dispatcher-pass` |

## Decisions D-01..D-20 → plan/task

| Decision | Covered by | How |
|---|---|---|
| D-01 backend = RAGFlow HTTP `POST /api/v1/retrieval` with Bearer key; not the `ragflow_retrieval` MCP | 05-02 T3 (spike), 05-04 T1 (client), 05-05 T1 | `RagflowClient.retrieve`; no code path touches RAGFlow's MCP server or port 9382; owner confirms 9382 has no public domain |
| D-02 `RAGFLOW_URL`, `RAGFLOW_API_KEY`, optional `RAGFLOW_DATASET_ID` in substrate.env; owner adds; presence-only + keyed systemd-run probes | 05-02 T1 (RESTORE first; empty `RAGFLOW_DATASET_ID=` in `.env.example`), 05-02 T2 (owner), 05-02 T3 (keyed), 05-04 T1 (`config.ts` `ragflow` block) | `sudo grep -c` only; evidence checked against both values with `grep -F -f` without printing |
| D-03 SC1 wording (owner-approved re-scope); plans do not edit ROADMAP.md | orchestrator (ROADMAP block in the planner report); 05-06 T3 Gaps note | no plan lists ROADMAP.md in files_modified |
| D-04 keyless TEI `BAAI/bge-small-en-v1.5` on Railway private networking, HuggingFace provider, tenant default embedding | 05-02 T2 (owner steps 2-3), 05-02 T3 (`embedding_model_is_bge_small=true`), 05-04 T2 (`ensureDataset` guard) | dataset created without `embedding_model`; any dataset not on bge-small is refused (permanent-model risk) |
| D-05 chat model unset; no retrieval or dataset option that needs one | 05-02 T2 (owner leaves it empty; confirmed in the reply), 05-04 T1 (retrievalBody / createDatasetBody tests + grep) | forbidden keys never sent; auto_keywords/auto_questions 0, RAPTOR/GraphRAG off, no auto_metadata_config |
| D-06 TEI/RAGFlow setup at a checkpoint with exact steps; `REGISTER_ENABLED=0` after the admin exists | 05-02 T2 (checkpoint:human-action, resume-signal), 05-02 T3 | `register_enabled=0` from the unauthenticated `/api/v1/system/config` |
| D-07 corpus = docs-scraper exports vendored into the library | 05-01 T2 (measured), 05-04 T3 (docs-python), 05-05 T3 (all) | refined by D-15 |
| D-08 one document per page; meta_fields url/title/source/content_hash; URL chain manifest → `Source:` → root_url | 05-04 T2 (source.ts tests), 05-04 T3 (`meta_fields_ok=true`), 05-02 T3 (`ref_metadata_url`) | search-time fallback `urlForName` uses the same chain |
| D-09 redact() on every page; idempotent by redacted-content hash; changed → delete + re-upload | 05-02 T3 (the spike redact()s every body before strip/hash/upload and asserts it: `spike_redact_applied=true`), 05-04 T2 (named tests `D-09 pages that differ only in a redacted secret hash the same`, `D-09 a second plan against the applied state makes zero writes`), 05-04 T3 (`rerun_writes=0`), 05-05 T3 (`corpus_rerun_writes=0`) | delete before upload (duplicate-name rename, Pitfall 1) |
| D-10 any authenticated surface may ingest; 1 MB body cap; paths under allowlisted roots, not content | 05-04 T2 (containment), 05-05 T1 (413 tests, path refusal), 05-05 T2 (live 413) | "authenticated" = Phase 4's proposeAllowed (D-19); CLI in-process for the corpus |
| D-11 rules for `ragflow-…` and `sk-cp-…`; no generic 64-hex rule | 05-01 T2 (hit counts), 05-04 T1 (RULES + tests) | one hyphenated-sk rule covers sk-cp (D-20 extends it); the ragflow rule needs an upper-case letter (token_urlsafe shape) so lower-case slugs such as the Railway template name are not redacted; sha256 values pinned unchanged |
| D-12 dedicated `substrate-desktop` from the local webtop image, no pull, 127.0.0.1 only, own volume, `--restart unless-stopped`; recruitment-desktop never touched | 05-03 T1 | script has no remove/stop/kill/pull and never names the recruitment container; StartedAt checked in 05-03 T1/T3 and 05-06 T2 |
| D-13 `docker exec -e DISPLAY=:1 substrate-desktop` + xdotool/xwd; `{actions, timeout}` → `{screenshots, log}`; one event per action; no free-form shell | 05-03 T2 (unit), 05-03 T3 (tool, live) | zod strict schemas, argv builders, Buffer runner, mutex, desktop.action events |
| D-14 proof parts 1-4 | see the criterion table | 05-PROOF.md |
| D-15 corpus = every library dir with manifest.json (25 dirs, 2,317 pages expected) | 05-01 T2 (measured on the checkout; drift recorded under Gaps), 05-05 T3 (ingest of the library root) | `corpus_dirs`/`corpus_pages` from the inventory are the pass numbers |
| D-16 SC3 wording: dedicated webtop via docker exec + xdotool/xwd | orchestrator (ROADMAP block); 05-03; 05-06 T3 Gaps note | no cua install anywhere |
| D-17 strip remote Markdown image embeds before upload; hash exactly the uploaded bytes | 05-02 T3 (`parse_ms_images` vs `parse_ms_stripped`), 05-04 T2 (`stripRemoteImages`, hash tests) | `<img src>` tags are left as is and counted (`html_img_pages`) |
| D-18 web view on 127.0.0.1:6081 with basic auth from `/etc/substrate/substrate-desktop.env` (0600) | 05-03 T1 | `webview_noauth_http=401`, `webview_auth_http=200`, `listener_6081=127.0.0.1` |
| D-19 `docs_ingest` and `desktop_run` refuse rivet VM guests via Phase 4's skills_propose guard; `docs_search` open; a test per case | 05-03 T3 (named test `D-19 desktop_run refuses a session without the host propose key` + live), 05-05 T1 (named tests for docs_ingest refusal, docs_search open, /docs/ingest 401 before body, /docs/search open; each run with `bun test -t`), 05-05 T2 (live) | guard = `proposeAllowed({ callerSurface, header, key })` from `skills/propose-auth.ts`; the proof's desktop session presents the key through a headersHelper |
| D-20 extend to `sk-proj-…` and other hyphenated `sk-…`; event redactor otherwise unchanged | 05-04 T1 | sk-cp, sk-proj, sk-svcacct, sk-or-v1 pinned; existing redact tests byte-identical (diff checked) |

## Assignment requirements → plan/task

| Requirement | Covered by |
|---|---|
| Owner checkpoint (TEI, HF provider + default embedding, chat unset, API key, REGISTER_ENABLED=0, env lines without echo), presence-only verification, resume-signal, stop on missing input | 05-02 T2 (checkpoint:human-action in 03-08 Task 2 format; HF form fields incl. the required instance name and max tokens 8192 → 512; resume signal confirms chat model unset and TEI without a public domain), 05-02 T3 precondition and `spike_result=fail` stop |
| Precondition gate: Phase 4 landed (clean git library, 04 VERIFICATION passed or accepted); disk ≥ 10 GiB | 05-01 T1 |
| Live changes with snapshot/RESTORE and guards (substrate-desktop, substrate-mcp restarts, substrate-desktop.env; never `docker rm` the recruitment container; `--pull never`) | 05-01 T1 (index RESTORE.md, RESTORE.d/, t0), then each plan's own RESTORE.d/05-NN.md written before its change: 05-02 T1, 05-03 T1/T3, 05-04 T3, 05-05 T2 (code) and T3 (fixture page, values file, fixture document), 05-06 T1 |
| 1 MB cap, idempotency by redacted-content hash, citation URL order, VM-guest refusal pinned by unit tests with fakes | 05-05 T1 (413, refusal), 05-04 T2 (hash, URL order), 05-03 T3 (refusal) — each a uniquely named test run with `bun test -t` in the task's verify; see 05-VALIDATION.md § Behaviours pinned by unit tests |
| Proof with a real `claude -p` session (session-scoped `--mcp-config` / `--strict-mcp-config`) and tool.call evidence; 05-PROOF.md | 05-06 T1/T2/T3 |

## Standing rules → plan/task

| Rule | Covered by |
|---|---|
| Two-sided gates against a measured baseline re-measured at HEAD before the first gate | 05-01 T1 (`gate-*`); every code task's `<automated>` (bun + tsc); dispatcher in 05-01 T1 and 05-06 T3 |
| Snapshot under `/var/lib/substrate/phase5-baseline/` with a RESTORE route before any live edit | 05-01 T1 (index RESTORE.md written only by 05-01, RESTORE.d/, t0), then RESTORE.d/05-02.md … 05-06.md, each written only by its plan before its change (no two same-wave plans share a file) |
| Read `/var/lib/substrate/phase1-baseline/RESTORE.md` before touching a Phase 1 file | none touched; stated in the RESTORE index (05-01 T1) |
| Never print secrets; substrate.env only via `sudo grep -c`; keyed probes via `systemd-run -p EnvironmentFile=` printing key=value | 05-02 T1/T3, 05-04 T3, 05-05 T2/T3, 05-06 T1-T3 (evidence scanned for key shapes and configured values) |
| Stage by explicit path; commit messages carry `Refs SPE-3576` | every task action |
| Collectors and hooks fail open; redact before emitting | desktop.action, tool.call and docs.ingest emits are `.catch(() => undefined)` (tested); the CLI event post is fail-open |
| Do not change `/events`, `/brief`, `/verify` shapes (Phase 6, 03-10) | 05-05 T1 (existing route tests unchanged and green); new routes only |

## Capability coverage (INTEGRATE / OPT-OUT)

| capability | decision | reason |
|---|---|---|
| RAGFlow HTTP API: datasets, documents (upload, meta update, parse, delete), retrieval with reference_metadata | INTEGRATE | D-01, D-08, 05-04 |
| RAGFlow MCP server (`ragflow_retrieval`) | OPT-OUT | D-01 — self-host mode serves the tenant's datasets to any caller and needs a second public port |
| RAGFlow chat, agents, Memory, GraphRAG, RAPTOR, auto keywords/questions/metadata | OPT-OUT | D-05 / CONTEXT § Deferred — they need a pay-as-you-go chat model |
| TEI bge-small sidecar on Railway (private networking) | INTEGRATE (owner) | D-04, 05-02 checkpoint |
| RAGFlow sign-up lock (`REGISTER_ENABLED=0`) | INTEGRATE (owner) | D-06; verified via `/api/v1/system/config` |
| Local RAGFlow on this VPS | OPT-OUT | explicitly out of scope — 19 GB free against RAGFlow's ≥ 50 GB |
| Docker exec + xdotool/xwd on substrate-desktop | INTEGRATE | D-12, D-13, 05-03 |
| cua / cua-driver | OPT-OUT | D-16 — owner chose the plain dedicated container; no install |
| QEMU / KVM desktop | OPT-OUT | no `/dev/kvm` on this host (SC3) |
| recruitment-desktop | OPT-OUT | D-12 — belongs to recruitment-swarm and holds the operator's sessions; never touched |
| Host ImageMagick `convert` for xwd → PNG | OPT-OUT | planner's choice of research Pattern 3 (b): an in-module TS XWD decoder + PNG encoder, unit-testable, no host coupling |
| Web view on 127.0.0.1:6081 with basic auth | INTEGRATE | D-18 |
| `/desktop` REST route | OPT-OUT | not needed — hooks never drive the desktop; smaller surface (research Q2) |
| `SUBSTRATE_TOKEN_*` bearer auth | OPT-OUT | not needed yet — anonymous loopback (D-19 uses Phase 4's host propose key instead) |
| Editing any agent's own MCP registration | OPT-OUT | explicitly out of scope; the proof uses a session-scoped `--mcp-config` |
| Stripping HTML `<img src>` tags | OPT-OUT | D-17 names Markdown embeds; 26 pages carry `<img>` (counted in 05-01) |
| Agentmemory / Recall phase, hindsight and supermemory retirement | OPT-OUT | explicitly out of scope — CONTEXT § Deferred (later Recall phase) |
| Product-docs dataset | OPT-OUT | deferred until the owner names sources; the ingest code is reused unchanged |
| The 2 docs-scraper test exports outside the library | OPT-OUT | D-15 — not in the library |
