# Milestones

## v1.5 v1.5 (Shipped: 2026-10-29)

**Phases completed:** 11 phases, 11 plans, 0 tasks

**Key accomplishments:**
- (none recorded)

---

## v1.3.x v1.3.x (Shipped: 2026-10-29)

**Phases completed:** 8 phases, 8 plans, 0 tasks

**Key accomplishments:**
- (none recorded)

---

## v1.4 Substrate contract hardening (Completed locally: 2026-10-24, not published)

**Phases completed:** 3 phases, 3 plans, 0 tasks

**Key accomplishments:**
- Invalid writes refused with nothing persisted, including LightRAG docs batches (76f2707); live Postgres suites pass (75 tests) on a throwaway postgres:16
- expected_version enforced for skills and docs with the memory contract's 409 body (c74fa07, 7cf8d44)
- Degraded-mode exactly-once replay: identical versioned skill proposals answer from the ledger (c74fa07); keyed replay after a newer version tested (7cf8d44); lost tests restored (5b5f68f)

---

## v1.3 v1.3 (Shipped: 2026-10-11)

**Phases completed:** 18 phases, 76 plans, 101 tasks

**Key accomplishments:**
- Pure scratch-env builder round-tripping the real loadConfig with zero warnings, exact-key-set allowlist proof, and a green store lock
- Read-only `parity:check` proving the SC-3 verdict from host facts, plus the approved `ConditionPathExists` unit guard
- One-command scratch twin lifecycle plus fixed-order wire smoke, with pure refusal guards pinned by 32 tests and a green store lock
- Scratch-harness topic doc, operator parity runbook with fillable evidence, and discoverable README entry points — all as-built, all store-lock green
- Harness proven isolated with loopback evidence and clean teardown; operator-approved parity:check PASS and zero rh- counts recorded values-free — SC-2, SC-3, SC-4 evidenced
- Closed event vocabulary locked: `substrate` surface appended (27 total, kinds unchanged at 12), 27-row typed `EVENT_SOURCES` table with write-path-proof samples, `substrate` token binding, and a drift-locked mapping document.
- Fail-open or fail-closed decided for all eight planned v1.3 tools, pinned by an independent test literal and a served-name scan guard, with docs updated.
- Phase-close gate proving the locked vocabulary against the v1.2 baseline plus a run-tagged smoke posting all 27 mapped samples over the wire with zero refusals, recorded against an isolated harness.
- September's 11 D-04 rules merged into main's labelled 30-entry redactor with the counter exemption intact; every rule proven by a runtime-assembled fixture and the widened memory quarantine pinned.
- September's skill-content engine lives in the shared redactor with the 9 D-04 skill entries, placeholder handling intact, and a parity test that fails the build when the two passes drift.
- Known-value scrubbing moved into the shared module and a four-rule repo lock fails `bun test` on any second redactor, with every detector proven against planted offenders.
- The shared redactor is documented for its future consumers and proven isolated: a new topic doc with three pointers, and a harness round trip through the rehearsal twin showing D-04 secrets redacted and counts intact.
- Fail-open emit, git attribution, and refusal visibility are in: one client every collector shares, with grok already on it and counting.
- herdr panes now reconcile onto main's vocabulary: one pinned surface table, a version-2 state file, and a collector that trusts the snapshot rather than the push.
- Each listed repo gets one redacted brief and one AGENTS.md pointer, and a Cursor stop copies a contained transcript before emitting session.end.
- The Muse hook ships as a bundle that carries its own redactor and reads its URL from a file, and one topic doc covers every collector.
- List-form surface tokens with a names-only boot refusal: `tokenConfig` plus `ConfigError` in config.ts, exit-78 refusal in index.ts, subprocess proof, and corrected env/docs
- One resolver serves CLI, collectors and parity-check: `resolveBearer` order env/token-file/tokens-dir, surface-threaded CLI headers, per-event collector tokens, and a 401 verdict that names the fix
- The no-strand guarantee in code and docs: a tracked names-only client manifest, a two-mode check script, and the production-identity runbook locked together by test
- Eight deferred scenarios become one guarded script: `bun run uat:phase0` with target classification, run-tagged writes, evidence-only reports, and a 6/6 isolated harness proof
- Deterministic graph registration through `graph_register`, shared token resolution, and the opt-in Claude Code substrate entry — built in a fresh clone on a local-only branch
- Fresh twin evidence for everything that can run without production mutation (6/6 scenarios, identity manifest, token parity), F-02 fixed, and every remaining live step collected into an explicit operator-approval list — no live command executed
- September's skill-proposal git/gh engine ported onto main's config model with a library seam, plus the skills config block and a recorded execution baseline.
- One method owns the git and gh path, authority comes before anything runs, and every outcome is recorded without ever changing the answer.
- Two audited doors on one method, with one body check and one failure mapping, so the doors cannot answer the same input differently.
- The third door keeps no git path of its own: it reads the directory, posts it and prints what the server answered.
- The phase gate: all three doors proved over the wire, with real git, against a throwaway library, with nothing able to reach GitHub or the host's skills state.
- The wire contract, the four configuration keys with the file:// rule, the dedupe semantics and the proof chain are documented where the next phase will look for them.
- complete. **Live effect:** none — production units untouched, no restarts, no merges.
- complete. **Live effect:** none — production units untouched, no restarts.
- complete. **Live effect:** none — host untouched, rebinds specified not executed.
- complete short of the named gates. **Live effect:** none — twin only.
- September's Linear poll, substrate-mcp client and per-Graph-ID worktree modules on main, with the substrate-bearer identity.
- September's prompt/registry/tick/host modules on main with runtime
- The supervised `python3 -m substrate_dispatcher` loop wired to the
- DISP-08 proven in rehearsal (smoke 20/20, driver exit 0, zero
- Five September ledger modules ported byte-identical with cmp proof, audit-style barrel, workspace wiring, baseline record, and the Wave 0 test fix — 45 ported tests green, tsc clean
- migrate() gains the append-only event_ingest table and the production-verified 11-column anchors shape with a silent-when-unanswerable drift warning; insertEvent records every event's ingest order with retry-then-IngestNotRecorded semantics — 70 greptime tests green, locks green, tsc clean
- A closed UTC hour now digests to one stable root and memo over its members in ingest order, and an ingest-record failure degrades to stored-with-warning instead of an un-stored event.
- The ingest-order path is proved on a real GreptimeDB (scratch, v0.14.4), production's anchors shape is confirmed read-only, and the ledger docs now say what Phase 28 inherits.
- The one-shot anchor job anchors closed, non-empty, unanchored hours via send-or-adopt with an alarm on root mismatch, over injected ports that keep every test off the real chain.
- verifyGraph returns the additive hour verdict through all three doors, fail-closed on unverified, with evidence pinned chain-only.
- The hourly schedule ships install-ready but uninstalled: two units plus drop-in, the README operator section, and the ledger anchoring record.
- ANCHOR-06 is proved isolated on a fake chain (47/47) and specced live behind operator gates that were not opened.
- Ported September's desktop vocabulary, XWD/PNG codec and driver onto main with the six locked deltas (child-env allowlist, busy refusal, tool.call events, tightened key rule, stop-on-unstored, silent deadline) — 31 tests green, tsc clean.
- Operator allowlist `SUBSTRATE_DESKTOP_SURFACES` parsed into `config.desktopSurfaces` with fail-closed empty default, unknown names dropped to `desktopIgnored` and warned by name via the `desktopConfigWarnings` sibling, plus absolute-only `config.desktopDir` — 6 config tests green, authority and store-lock suites green, tsc clean.
- `scripts/substrate-desktop.test.ts` proves every D30-15 gate and the locked `docker run` argv with PATH-injected `docker`/`df`/`openssl` stubs — 15 tests green, `bash -n` and `shellcheck` 0.10.0 exit 0, tsc clean, store-lock and redact-lock green.
- `desktop_run` registered behind the six-step allowlist gate with strict-schema self-attribution rejection, image-block replies, ledger-stop failures and a keys-plus-digest audit trail — 16 new tests green, full verification chain plus phase-close green.
- `rehearsal up` accepts `--desktop-surfaces a,b` as a validated subset of `--surfaces` and writes both desktop env keys per run — 19 env tests and 78 CLI tests green, tsc clean, phase-close green.

---

## v1.2 v1.2 (Shipped: 2026-10-08)

**Phases completed:** 5 phases, 5 plans, 0 tasks

**Key accomplishments:**
- The substrate refuses any lease action a swarm agent is not entitled to: swarm sessions must name their own agent, a valid replica and the graph; a lease_id is shown only to its holder; only the holder's surface can beat, release or complete; and a swarm token is never an operator.
- The swarm runner works every task's node under a substrate lease it holds for the executing agent: claim before dispatch, heartbeat while the agent runs, complete on DONE, release and re-claim on rework, release on failure; two replicas never work one node and a dead replica's node frees itself.
- Context that crosses an accountable-agent boundary is written down by its sender as a signed coord_handoff packet and can be rebuilt from the ledger alone; a killed replica's node is taken over within one TTL with no two holders, and a failed gate handed to A14 is reconstructed with no bus or Task Store read.
- A fresh swarm workspace is wired to substrate-mcp by the install alone: one substrate MCP entry per runtime that names the token variable and never a value, a 0600 token file per agent outside every checkout, and a runner that gives each child only its own SUBSTRATE_TOKEN and leases and tees with that same agent's token.
- Lessons from finished phases become governed, citable memory: substrate lessons add/recall/digest/outcome over fact entries written through memory_write, with recall paging every lesson by subject prefix and a keyset cursor, scores computed at read time and digests that retire lessons without deleting them.

---

## v1.1 Swarm correlation, governed memory and orchestrate integrations (Shipped: 2026-10-07)

**Phases completed:** 5 phases, 5 plans, 22 tasks

**Key accomplishments:**

- Swarm agents get their own substrate identities: 15 swarm surfaces whose tokens cannot act as another agent, and a race-safe binding of a swarm correlation id to one Graph ID (graph_bindings + MCP graph_bind).
- Swarm memory goes through the substrate's governed memory_write: one client with kind and scope maps, idempotency keys and a handler for every gate outcome, with default-deny proven from outside.
- Version conflicts on decisions report the version in force, so a swarm rewrite works however many newer entries share the decision's scope.
- A planned ultrathink prompt records its Graph ID in the substrate ledger, with no prompt text, inside the planning budget and without ever changing the hook's result.
- The swarm's run log reaches the substrate ledger under one Graph ID per run, attributed to the emitting agent, deduped and fail-open; orch_plan mints, binds and registers the graph.

**Close-out:** override closeout. Known verification overrides: 1 newly acknowledged, 0 carried forward from a prior close (see STATE.md Deferred Items): the v1.0 Phase 0 UAT (`milestones/v1.0-phases/00-brief/0-UAT.md`, partial, 8 scenarios pending) was acknowledged as deferred at this close on the user's decision.

---

## v1.0 Agent Substrate build plan (phases 0-6, 0.5 inserted) (Closed: 2026-10-01)

**Phases completed:** 8 phases (0, 0.5 and 1-6) marked complete; only Phase 0 is complete and live. Closed on 2026-10-01 by an autonomous run in a working checkout; archived on main by PR #10.

**Key accomplishments:**

- Phase 0 (Brief) is complete and live: `substrate-mcp` runs under systemd and briefs Claude Code from a real event store and index.
- Phases 0.5 and 1-6 were marked complete, but several were built on stubs; the archived roadmap itself lists a dispatcher stub, an anchor stub, a RAGFlow proxy stub and an evidence export stub.
- The production versions landed separately on main: the Greptime events ledger in PRs #3 and #4, memory governance in #5 and #9, leases, signed handoffs and drift in #6, and OTLP, SLOs, the hash-chained MCP audit and the evidence bundle in #7.
- Never landed: the dispatcher, the docs/anchor CLI, the Solana memo, Agent Cards and herdr.

**Close-out:** the archived audit says `passed` (2026-10-01). An earlier audit on 2026-09-28 was `gaps_found`, and the PR #10 review disputes the `passed` result. Archive: [milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md) · audit: [milestones/v1.0-MILESTONE-AUDIT.md](milestones/v1.0-MILESTONE-AUDIT.md) · phase folders: [milestones/v1.0-phases/](milestones/v1.0-phases/)

**Deferred:** Phase 0 UAT, 8 scenarios (`milestones/v1.0-phases/00-brief/0-UAT.md`), acknowledged as deferred at the v1.1 close.

---
