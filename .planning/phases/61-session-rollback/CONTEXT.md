---
phase: 61-session-rollback
milestone: v1.6
requirements: [SOTA-17]
discussed: 2026-10-26
status: implemented on gsd/v16-int; partial (criterion 3: no automatic checkpoint triggers); no live rehearsal
---

# 61-CONTEXT: Session rollback to an exact chat moment with file revert

## Goal

A session can be rolled back to a checkpoint: files are restored exactly, the chat position is recorded, memory written after the checkpoint stops influencing recall, and the rollback is an append-only event. The revert runs as a CLI under the session's own authority; the substrate server stays read-only on worktrees. The roadmap block is ROADMAP.md, Phase 61.

## Locked decisions

- **D55-1: nothing is hard-deleted.** A rollback appends a `session.rollback` note pointing at an earlier event (`target_event_id`, `target_hash`); memory the surface wrote in the session after the checkpoint is forgotten through the phase 57 marker, so recall excludes it and `include_superseded` still returns it for audit.
- **D55-3 and decision D52-g: the server never touches a worktree.** `substrate session rollback` restores files locally; the server plans, verifies and audits through three MCP tools (`session_checkpoint`, `session_rollback_plan`, `session_rollback_commit`). No REST twin was built. D55-3 planned a `baseline` checkpoint at a pre-feature session's first checkpoint-aware turn; the CLI accepts `--trigger baseline` but nothing creates it automatically (ADR 0007), so such a session can only be rolled back to a checkpoint someone took.
- **The local registry is git.** Checkpoints are parentless commits pinned at `refs/substrate/checkpoints/<ckpt id>`, so listing and rolling back work with the server unreachable. No TimescaleDB step was built for this phase (the ROADMAP once listed one; see ROADMAP Phase 61 "Repos").
- **A rollback is crash-recoverable, not atomic.** Each file is replaced atomically, the set of files is journaled, and `recover` (or the next rollback) completes an interrupted restore forward.
- **Transcripts are never rewritten.** omp gets a forked session file holding the root-to-checkpoint path (the original is untouched); other surfaces get a marker (the ledger note).
- **Edits stay in this repository (D55-4).** Hooks the sibling repositories would need are proposals in ADR 0007; no sibling repository was changed.

## Links

- Code: `packages/worktree-snapshot/src`; `packages/cli/src/session/*` (`checkpoint`, `rollback`, `client`, `pending`, `omp-fork`, `transcript-port`, `command`); `packages/collectors/src/transcript-ref.ts`; `packages/mcp-server/src/{session-rollback,session-events,memory-forget}.ts`
- Docs: `docs/runbooks/session-rollback.md`, `docs/event-vocabulary.md`, ADR 0005 (`docs/adr/0005-rollback-semantics.md`), ADR 0007 (checkpoint triggers and sibling hooks)
- Discovery: `../55-migration-safety/CONTEXT.md`
