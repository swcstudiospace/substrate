# Uplift Proposal — 7 engineering-mix improvements (post-v1.3)

**Date:** 2026-10-12 · **Graph:** `ut-mv5r71hp-65f7b012` · **Tracking:** n5 [SPE-10474](https://linear.app/swcstudio/issue/SPE-10474/select-exactly-7-improvements-and-frame-the-decision-gate)

**Authorization (recorded per acceptance criteria):** the operator answered the planning clarifications on 2026-10-12: **q1 = Pre-authorize** (autonomous selection and implementation of all 7; this file logs the rationale), **q2 = Engineering mix**. Non-blocking defaults applied: **q3 = justified dependency additions allowed** (none required — every item below is built on existing stack: Bun/TS, Python stdlib + httpx, Docker argv), **q4 = no budget cap**.

**Ground truth accepted:** `.planning/ROADMAP.md` phase table and VALIDATION.md are authoritative over STATE.md frontmatter drift: v1.3 is complete and archived (`ab0dff1`), zero remaining phases → the already-closed-milestone branch applies; these 7 are **standalone post-close artifacts** under `.planning/uplift/` with STATE.md progress entries — no new ROADMAP milestone (per plan scope).

**Note on the planning pass:** n4/n5 conclusions arrived degraded (HTTP 429 boilerplate; n5's generic hardening list cites no files). Per the degraded-planning notice, that list is superseded by the evidence-cited equivalents below, mapped to the same classes: security (U1), resilience (U2, U3), observability (U4, U5), DX/ops (U6), performance/ergonomics (U7).

**Green commands (baseline 2026-10-12):** `bun test` (3195 tests; 1 recorded fail = F-01 environment-sensitive guard, recorded convention from v1.3 VALIDATION, quarantined not fixed) · `bunx tsc --noEmit` (clean) · `bun run test:py` (246 pass). No lint script exists in `package.json`.

**Guardrails (n7):** red-main policy — full gate set after every improvement; red ⇒ fix or revert the unit's commits, never advance. Isolation — one focused commit series per improvement on `ultrathink/uplift-7`; revertibility = `git revert` of that range; `git diff --stat` must match the item's declared file scope. Infeasible item ⇒ full revert, substitute the next alternate, log the swap here and in STATE.md. Secrets — pattern scan over staged files before each commit; auth/validation-touching diffs add negative-path tests. Interactions — the previously green suite re-runs after each item.

## The 7 (ranked by impact-to-risk)

### 1. U5 — Governance gate verdicts as events (ADR S5, SPE-5056) — observability/audit, M
- **Evidence:** `packages/mcp-server/src/memory-write.ts` — gate outcomes (`accepted`/`conflict`/`quarantined`/`denied`) are visible only to the caller; briefs and evidence never show denials or quarantines. PROJECT.md "Next Milestone Goals" lists "ADR S5 gate verdicts as events (SPE-5056)".
- **Approach:** the memory governance gate emits one event per verdict onto the **existing closed vocabulary** (`note` for accepted/conflict, `warning` for quarantined/denied) with `payload.gate = { verdict, kind, surface, reason }`; brief and evidence pick them up unchanged. Zero new EVENT_KINDS/SURFACES.
- **Impact:** denials and quarantines become auditable from the ledger, brief and evidence bundle instead of vanishing into call replies.
- **Risks:** event volume from noisy writers (bounded: one event per gate call, same as today's audit records); vocabulary-lock violation (guarded by test).
- **Verify:** `vocabulary-lock.test.ts` green; new policy test pins the emit; brief integration test shows a quarantined write; full gates.

### 2. U4 — Quota-burn SLO alerts + dispatch storm-breaker — observability/resilience, S–M
- **Evidence:** `packages/observability/src/instruments.ts` already defines `substrate.tokens` and `substrate.cost.usd` (normalized usage aliases) but nothing alerts on burn; research records Anthropic 429s burning September dispatch runs (C-T6 note) and the 900 s claim-watch budget built around them.
- **Approach:** burn-rate SLOs over the existing token/cost series with configurable thresholds surfaced at `/slo`; the dispatcher checks the substrate's burn snapshot before launching and refuses new sessions while breached (one `warning` event + one marker comment, no retry) — a storm-breaker, not a throttle.
- **Impact:** model-quota exhaustion becomes a visible, enforced budget instead of a mid-run 429 failure.
- **Risks:** false-positive refusal blocks legitimate dispatch (mitigation: default threshold generous + kill-switch-style env override; refusal is once-only and self-explaining).
- **Verify:** threshold-crossing unit tests on the SLO math; dispatcher `--once --dry-run` test with an injected breaching snapshot; full gates.

### 3. U2 — Host re-adopts running VMs after restart — resilience, M
- **Evidence:** `packages/host/src/{main,api,tasks}.ts`, `sandbox-provider.ts`; research H-D3 / September N4: a dispatcher or host restart orphans running rivet sandboxes with no reconciliation.
- **Approach:** on boot, the host enumerates live sandboxes via the provider, reconciles them against persisted task state (0600 state file next to the lease record), re-attaches known graph tasks and terminates unknown orphans (each termination emits one `warning`).
- **Impact:** no orphaned VMs burning disk/quota after a restart; restart-survival claim becomes true at the host level, not only inside a session.
- **Risks:** terminating a sandbox another process owns (mitigation: only touch sandboxes carrying the host's own label prefix; unknown-but-unlabeled sandboxes are reported, not killed).
- **Verify:** fake-provider restart test: known sandbox re-attached, labeled orphan terminated, unlabeled foreign sandbox only reported; full gates.

### 4. U1 — Sandbox egress allowlist — security, M
- **Evidence:** `packages/host/src/sandbox-provider.ts`, `sandbox-options.ts`, `infra/sandbox/Dockerfile`; research H-D1 / September N3: "the container could reach example.com" — the Lane A sandbox has unrestricted network egress.
- **Approach:** enforced, code-declared egress policy for the sandbox container: default-deny network namespace with an allowlist (model route, substrate loopback, package registries during seed) implemented via Docker network/iptables argv composed in `sandbox-provider.ts`; fail-closed — unresolvable policy refuses VM start.
- **Impact:** a prompt-injected or misbehaving VM session cannot exfiltrate tokens or reach arbitrary hosts; closes the recorded N3 hole.
- **Risks:** over-tight policy breaks sessions (mitigation: allowlist is config with safe defaults + explicit test fixtures per allowed destination); iptables availability on host (verified in tests via argv composition, as `desktop_run` does for docker argv).
- **Verify:** argv-composition unit tests (exact flags pinned, PATH-injected stubs per the desktop precedent); negative-path test: unlisted destination blocked; full gates.

### 5. U3 — Replayable signed dispatch handoffs + pre-launch drift gate — resilience/DX, M
- **Evidence:** `packages/dispatcher/src/substrate_dispatcher/launcher.py` builds the launch prompt inline; `handoff.ts`/`drift.ts` (signed `coord_handoff`, `coord_drift_scan`) exist in mcp-server but the dispatcher uses neither; research C-D2/C-D4.
- **Approach:** the dispatcher composes dispatch context (goal, DoD lines, files, graph/node ids) as a signed handoff packet via the substrate client, so a killed session's context rebuilds from the ledger alone; before launch it runs `coord_drift_scan` against the worktree and appends a stale-brief warning to the marker comment when drift is found.
- **Impact:** dispatch context survives kills and restarts replayably; agents no longer launch against a stale brief without warning.
- **Risks:** handoff-signing key absent in dev (packet falls back to unsigned with a recorded warning, same as server behavior); drift scan latency (bounded, pre-launch only).
- **Verify:** pytest failure-injection: kill after handoff write, replay rebuilds identical context; drift-warning unit tests with a fake scan; full gates incl. `test:py`.

### 6. U6 — Knowledge freshness automation — DX/ops, M
- **Evidence:** `packages/mcp-server/src/docs-datasets.ts` implements dataset refresh but triggers are manual; DOCS-03 names the intended triggers ("agent-skills after each skills-sync fast-forward", "agent-substrate on merge"); D-D2 (ingest on merge) was deferred out of v1.3.
- **Approach:** skills-sync calls dataset re-ingest on every successful fast-forward (loopback POST, projector's surface token, fail-open with counted refusal); a token-authed loopback-only `POST /docs/merge-trigger` route re-ingests the `agent-substrate` dataset, callable from a post-merge hook; both no-op quietly when the docs plane is unconfigured (existing null-block idiom).
- **Impact:** docs and skills search stay current without a human running ingest; closes the recorded freshness gap.
- **Risks:** ingest cost on every merge (mitigation: content-hash idempotency already in `docs_ingest` makes no-op refreshes cheap); loopback route abuse (mitigation: surface-token auth, loopback bind only).
- **Verify:** trigger tests with a fake ingest endpoint (fast-forward fires once, dirty tree fires none); route auth negative test (401 without token, refusal of non-loopback bind); full gates.

### 7. U7 — Loopback SSE event stream — performance/API ergonomics, M–L
- **Evidence:** `packages/mcp-server/src/server.ts` serves REST only; every consumer today polls (collectors reconcile every 5 s, briefs rebuild on timers) — research Lessons Tier 2 "realtime delivery" (PROJECT.md recorded next goal) needs a push seam.
- **Approach:** `GET /events/stream` (Server-Sent Events) bound to loopback, surface-token authed, replaying only post-`Last-Event-ID` rows from the ledger, backpressure-bounded with a slow-consumer cap; fail-open — a broken subscriber never affects emit paths. Lessons delivery and collectors may subscribe; polling paths stay working (additive).
- **Impact:** sub-second event delivery for local consumers; removes the polling floor for Lessons Tier 2 and future collectors; additive, zero vocabulary change.
- **Risks:** connection leaks (mitigation: idle timeout + disconnect cleanup tests); event replay memory (bounded by ledger cursor, not in-memory buffering).
- **Verify:** SSE contract test (order, auth refusal, Last-Event-ID replay, disconnect cleanup); concurrent-subscriber test; full gates.

## Alternates (substitute in order after full revert of an infeasible item)

1. **A1** — herdr-hosted dispatch (A-D2): dispatched sessions run inside herdr panes; kill-switch semantics change recorded as a decision. `packages/dispatcher/src/substrate_dispatcher/launcher.py`, `packages/collectors/src/herdr.ts`.
2. **A2** — Graph edges → Linear relations (B-D1): `requires`/`blocks` mirrored via the existing Linear client (`mcp-server/src/linear.ts`, `mirror.ts`).
3. **A3** — `skills_list` + approve/decline audit trail (F-D3): `mcp-server/src/skills/`, CLI `packages/cli/src/index.ts`.

## Progress log (STATE.md carries per-item entries)

| Item | Status | Gates | Notes |
|------|--------|-------|-------|
| U5 | done | mcp-server 0 fail · phase-close pass · tsc clean | [01-SUMMARY.md](uplift/01-SUMMARY.md) — unified into auditMemoryWrite; accepted verdict was the real gap |
| U4 | done | test:py 272 pass · obs+mcp 0 fail · tsc clean | [02-SUMMARY.md](uplift/02-SUMMARY.md) — burn SLOs at /slo; storm-breaker with new `quota-burn` marker (D33-02 lock deliberately extended) |
| U2 | done | host 244 pass · tsc clean · full suite 1 recorded fail | [03-SUMMARY.md](uplift/03-SUMMARY.md) — provider-enumeration reconciliation replaces the D-04 blanket sweep |
| U1 | done | host 281 pass · tsc clean · full suite 1 recorded fail | [04-SUMMARY.md](uplift/04-SUMMARY.md) — DOCKER-USER allowlist, deny-all default, crash-orphan rule GC; limits recorded |
| U3 | pending | — | — |
| U6 | pending | — | — |
| U7 | pending | — | — |
