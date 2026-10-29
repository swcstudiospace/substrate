# Requirements: Agent Substrate — v1.7 Docs Atlas, Self-Improving Context, Live Steering GA and Worktree Fleet

**Defined:** 2026-10-29
**Core Value:** Every agent on the host shares one brief, one event log, one governed memory plane, one skills library and one Graph ID.
**Archived:** the v1.3.x, v1.5 and v1.6 requirements moved to `milestones/v1.3.x-REQUIREMENTS.md`, `milestones/v1.5-REQUIREMENTS.md` and `milestones/v1.6-REQUIREMENTS.md` when this milestone was defined; earlier programs are archived beside them.

## Sources

- The owner's request of 2026-10-29 (Run 14): eight features and process improvements that use Solana devnet, GreptimeDB, TimescaleDB, DragonflyDB and TEI; ingest the documentation of every repository on the VPS, on GitHub and in the Greptile knowledge bases; re-ingest automatically when documentation changes; make the docs RAG self-improving the way Hindsight is; present Live Steering, which has not been demonstrated to the owner; and optimise many sessions working in git worktrees.
- Run 14 scout evidence, read from main at 9d3f2085: the docs plane ingests one page at a time and cannot delete, rename or filter by repository; the planning refresh keeps its hashes in memory; steering is pull-only and has no command or view; no component knows the worktrees under `/root/src/worktrees`; TEI has no client in the repository. Each phase's CONTEXT.md lists the file and line evidence.
- `.planning/milestones/v1.6-REQUIREMENTS.md` (SOTA-13 to SOTA-18) and `.planning/PROJECT.md` "Next Milestone Goals": the `checkpoint_hint` reader and the `steering` and `baseline` hook triggers are carried into STEER-05.

## v1.7 requirements

### Corpus Atlas (phase 63)

- [ ] **ATLAS-01**: A scan of the repositories on the VPS lists every documentation file with repo, path, kind, tier, sha256 and size, and collapses clones, linked worktrees and byte-identical copies into one canonical entry.
- [ ] **ATLAS-02**: `substrate corpus plan` reports what a bulk ingest would add, change, rename or tombstone against the server's manifest, without sending a document body.
- [ ] **ATLAS-03**: A bulk ingest route puts new and changed documents into the docs plane with repo, path, kind, tier and commit provenance and without a serial wait per page, and refuses secrets the way `docs_ingest` does.
- [ ] **ATLAS-04**: A document removed or renamed in its repository is tombstoned: its docs-plane document is deleted (unless another active row shares it) and its manifest row says so; a scan that is narrower than the manifest, or that failed on a repository, never tombstones anything outside what it covered.
- [ ] **ATLAS-05**: Running the same scan and ingest again changes nothing, and an interrupted run resumes where it stopped.
- [ ] **ATLAS-06**: Greptile knowledge-base documents and GitHub repositories with no local clone enter the same manifest through documented source adapters.

### Embedding fabric (phase 64)

- [ ] **EMB-01**: Substrate has a TEI client with batching, timeout, retry and a breaker, and refuses a model or dimension that differs from the pinned one.
- [ ] **EMB-02**: Embeddings are cached in Dragonfly by model and content hash, and every key carries a TTL.
- [ ] **EMB-03**: TEI is a fabric resource: `fabric_status` reports its health, model and dimension, and the compliance check names an endpoint that is not private.
- [ ] **EMB-04**: The server reports near-duplicate documents by cosine similarity of their TEI embeddings, the plan output can show them, and no document is dropped on that signal alone.

### Doc Watch (phase 65)

- [ ] **WATCH-01**: A documentation change in a registered repository reaches the docs plane within a configured lag with no manual command.
- [ ] **WATCH-02**: Triggers coalesce: a burst of edits costs one sync per repository, and a restart re-ingests nothing that has not changed.
- [ ] **WATCH-03**: Git hooks and the filesystem watcher never block or fail the user's git command or editor.
- [ ] **WATCH-04**: A reconcile timer finds changes that no trigger saw, including a push made from another machine that the local checkout has not pulled, without the local and remote views overwriting each other.
- [ ] **WATCH-05**: A sync reports its outcome, lag and failures as events and metrics, and a freshness breach raises the existing `docs.freshness` warning.

### Docs Reflect (phase 66)

- [ ] **REFLECT-01**: Every `docs_search` is recorded as a bounded, redacted retrieval event.
- [ ] **REFLECT-02**: A session can mark a citation helpful, unhelpful, stale, wrong or duplicate through `docs_feedback`.
- [ ] **REFLECT-03**: Documents carry an authority score from tier, kind, recency, supersession and feedback, and `docs_search` can re-rank by it, in shadow first.
- [ ] **REFLECT-04**: A document that a newer version, an archive or an explicit marker supersedes is flagged in its citations.
- [ ] **REFLECT-05**: A reflect run writes per-repository digests into the docs plane and retains them in Hindsight, and lists the queries the corpus could not answer.

### Live Steering GA (phase 67)

- [ ] **STEER-01**: `substrate steer` lists live sessions and their steering state, and queues, acknowledges and lists directives for an operator.
- [ ] **STEER-02**: A session can ask what the other live sessions of its repository are doing and receives a bounded, redacted digest that carries its provenance.
- [ ] **STEER-03**: `memory_brief` carries sessions, steering and handoff sections behind a flag.
- [ ] **STEER-04**: Steering session state survives a server restart.
- [ ] **STEER-05**: The session hook reads `checkpoint_hint` and writes the checkpoint it names, and a context trigger injects the digest at session start.
- [ ] **STEER-06**: A session can wait for a directive with a long poll instead of polling `docs_search`.

### Worktree Fleet (phase 68)

- [ ] **FLEET-01**: Worktree locations are configurable, and every worktree of a repository is found through git, not through a path convention.
- [ ] **FLEET-02**: A worktree registry records path, repo, branch, head, base, dirty state, ahead and behind, last activity, size and the attributed session or graph.
- [ ] **FLEET-03**: `substrate worktree prune` removes only worktrees that are clean, pushed and whose current head is merged (not merely whose branch once was), never the primary checkout, and records each removal.
- [ ] **FLEET-04**: `substrate worktree conflicts` predicts textual conflicts between the active worktrees of a repository and suggests a merge order.
- [ ] **FLEET-05**: Worktree creation refuses below a configured free-disk floor, and the doctor reports disk pressure from worktrees.
- [ ] **FLEET-06**: A session's brief names other sessions' worktrees that touch the same files.

### Doc Proofs (phase 69)

- [ ] **PROOF-01**: The corpus manifest has a deterministic Merkle root over (repo, path, sha256) leaves.
- [ ] **PROOF-02**: Each sync records the root as a ledger event, so the existing hourly anchor covers it without a new memo format.
- [ ] **PROOF-03**: `substrate corpus prove` gives an inclusion proof for one document and `substrate corpus verify` checks it offline and against the anchored hour when chain evidence exists.
- [ ] **PROOF-04**: `docs_search` replies carry the short corpus root of what the session saw.

### Docs SLO and eval (phase 70)

- [ ] **EVAL-01**: A self-supervised golden set generated from the corpus is scored for recall at k, MRR and latency.
- [ ] **EVAL-02**: A deterministic offline harness guards ranking, dedupe and re-rank regressions in CI.
- [ ] **EVAL-03**: Freshness, ingest throughput and retrieval quality are metrics with SLO thresholds visible in `fabric_status` and the docs canary.
- [ ] **EVAL-04**: A broken relative link in `docs/` or `.planning/`, or a missing level-1 title in `docs/` or the live planning files, fails a test.
- [ ] **EVAL-05**: An operator runbook covers deploy, first ingest, timers, rollback and the check that proves each.

## Out of scope and deferred

- Graph and hybrid LightRAG modes: they need an LLM route that only the operator can provide (production runs naive mode). Nothing in this milestone requires one; REFLECT-05 is deterministic.
- Removing the RAGFlow code (TODO register D-15), deploys, Railway writes, funding the anchor key, devnet sends outside the existing anchor job, and installing hooks or timers on a host: all operator-gated. This milestone ships the code, the staged units and the runbooks.
- Agents queueing steering directives for other agents: directive authors stay human (v1.6 decision); STEER-02 shares context, it does not delegate authority.
- A new on-chain memo format: PROOF-02 rides the existing hourly anchor.
- Moving `packages/collectors/src/cursor-stop.ts` and the cli to collectors import cycle, `noPropertyAccessFromIndexSignature` and coverage thresholds stay deferred as recorded in Run 13.

## Traceability (v1.7)

Checkbox convention: a ticked requirement is satisfied or waived by the operator (its row says which); an unticked one is not yet delivered, partial or operator-gated, and its row carries the reason and the date.

| Requirement | Phase | Status |
|-------------|-------|--------|
| ATLAS-01 to ATLAS-06 | 63 | Planned |
| EMB-01 to EMB-04 | 64 | Planned |
| WATCH-01 to WATCH-05 | 65 | Planned |
| REFLECT-01 to REFLECT-05 | 66 | Planned |
| STEER-01 to STEER-06 | 67 | Planned |
| FLEET-01 to FLEET-06 | 68 | Planned |
| PROOF-01 to PROOF-04 | 69 | Planned |
| EVAL-01 to EVAL-05 | 70 | Planned |

---
*Requirements defined: 2026-10-29*
