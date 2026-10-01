# Phase 1 — Lane B: Plan

**Goal (from ROADMAP)**: Hermes, Omp, Muse Code, Grok Build and Grok Bot all read the brief and emit events. + v0.3 OTLP/SLOs/GrokBot production loop.

**Depends on**: Phase 0 (done), Phase 0.5 (governance done).

**Context reference**: phases/01-lane-b/CONTEXT.md (Orca/herdr both used; native floor first; Hermes plugins at /root/.hermes/plugins and /root/src/repos/hermes-engineering-board; Grok collector done; sensitive live edits).

**Success Criteria (ROADMAP verbatim, mapped to work)**:
1. Hermes redesign: pre_llm_call hook calls TS engine for brief with uplift XML + graph. Kanban retired as tracker; hermes-linear-connector keeps Linear dispatch/mirroring/DoD; eng-board -> events.emit.
2. Orca-vs-herdr: probe orca agent-context --json / ORCA_AGENT_HOOK_ENDPOINT. herdr persistent runtime.
3. omp-ultrathink adds memory.brief discovery; Grok Build UserPromptSubmit fetches /brief; Muse fallback .substrate/BRIEF.md.
4. grok-hermes-connector v0.4 forwards memory_brief/memory_write/events_emit/graph_get; handoff_to_hermes records handoff event.
5. v0.3: OTLP exporters + SLO dashboards (brief p95<800ms, emit≥99.5%); hash-chained MCP audit.
6. v0.3: Grok Bot production loop skill enforces memory_brief on open, signed handoffs, substrate-only docs/skills, desk packs.
**Proof**: Hermes finishes node n2 from Grok Bot handoff; Omp prompt lists handoff + claim. OTLP/SLO live; GrokBot follows loop.

**Current State (verified)**:
- substrate-mcp: POST /brief (text/markdown), POST /events (202/503 + id/hash/stored), CLI `substrate brief|emit`, health.
- Hermes: already emits via hermes_eng_board/substrate_client.py (POST /events, redaction, SUBSTRATE_* env, fail-open in hooks_session.py). Handles start/tool/user/finalize.
- Grok collector: packages/collectors/src/grok.ts running (systemd), emits sessions.
- Projector: cursor done.
- No OTLP yet.
- Brief compose in mcp-server supports graph/repo/surface.

**Risks & Mitigations** (from CONTEXT):
- Live Hermes/Orca edits: native floor (additive calls to substrate CLI or / ) first; tee second. 1.5s timeouts. Test in non-prod sessions.
- Fail open: all hooks/collectors must swallow substrate errors (already in client/CLI).
- Graph ID consistency: use claude-ultrathink minted ut- ids.
- Multi-surface: bearer tokens per surface (hermes-eng-board, grok-build etc.).

**Tasks (mapped to todo list; waves for parallel)**:

**Wave 1: Substrate foundations + OTLP (this repo)**
- Add basic OTLP/SLO in mcp-server (timing on brief/emit, optional OTLP export via env or simple /metrics; p95 calc stub or log for dashboards). Hash-chained audit already in events.
- Update service/server for any v0.3 brief format (include uplift XML if requested? keep compatible).
- Enhance projector for Lane B surfaces (hermes, omp, muse, grok) in substrate.yaml (tokens, urls).
- Add Grok Bot production loop as example skill or in cli/docs.
- Verification: tsc, unit tests, manual curl /brief /events, health includes events.

**Wave 2: Hermes retarget + brief injection (hermes-engineering-board + hermes-plugin)**
- In hooks_session.py / handle_pre_llm or uplift: fetch brief via `substrate brief --graph $graph --surface hermes-eng-board --write` or direct /brief, inject into prompt (with uplift XML/graph from CONTEXT redesign).
- Ensure eng-board events use substrate (already does; retarget any Kanban direct to emit).
- Update for redesign: Python calls TS for brief if needed (via CLI).
- Verification: Hermes session produces brief in prompt, events in Greptime with graph_id.

**Wave 3: Omp, Muse, Grok Build, Grok Bot**
- Omp: add memory.brief to discovery tools (edit omp-ultrathink if accessible; or substrate supports).
- Muse: ensure .substrate/BRIEF.md fallback (CLI --write already supports).
- Grok Build: UserPromptSubmit in ultrathink/grok-build fetches /brief (additive hook).
- grok-hermes-connector v0.4 (packages/connector-ext): forward memory_brief, memory_write (with status), events_emit, graph_get; record handoff events.
- Verification: Omp prompt shows brief; Muse falls back; Grok uplift injects; connector forwards; handoff event present.

**Wave 4: Orca/herdr + proof**
- Probe Orca (already in CONTEXT: no subscribe, push via endpoint.env).
- Add Orca tee collector (or set endpoint.env to substrate proxy that forwards + emits; native first).
- herdr as persistent: ensure installed/running, add collector if events available.
- Cross brief event claim OTLP.
- Proof run: start Hermes from Grok handoff, complete n2, observe in Omp brief + events + OTLP.

**Wave 5: Artifacts + verify**
- Write SUMMARY.md, update 0-UAT or add 1-UAT.md, update STATE/ROADMAP (mark Phase 1 done, progress).
- Run full smoke: collectors, CLI brief/emit, hermes session if safe, tsc/test/lint.
- Update docs if needed.

**Order & Gates**:
- Never edit live without backup or in window.
- All changes additive; existing hooks continue.
- Every wave ends with smoke (curl, node test, collector run).
- If blocker (e.g. no hermes source edit rights), fall back to docs + substrate-only.

**Files touched (this repo primary)**:
- .planning/phases/01-lane-b/PLAN.md, SUMMARY.md
- packages/mcp-server/src/{service,server,types?} (OTLP)
- packages/projector/
- packages/collectors/ (if)
- packages/connector-ext/src/
- packages/cli/ (if)
- .planning/STATE.md, ROADMAP.md
- External (hermes*): hooks for injection (additive calls to `substrate` CLI or fetch).

**Acceptance**:
- All 7 success criteria TRUE and proven by run (not assert).
- No regression on Phase 0 flows.
- Enterprise: OTLP/SLO numbers observable.

**Next after green**: Phase 2.

**Autonomous notes**: This plan follows gsd-autonomous (discuss in CONTEXT, plan here, execute waves, verify). Update todo on each wave. Full audit at end of milestone.
