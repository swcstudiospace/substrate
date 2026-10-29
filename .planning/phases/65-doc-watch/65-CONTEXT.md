# Phase 65: Doc Watch - Context

**Gathered:** 2026-10-29 (Run 14)
**Status:** Decisions fixed by the orchestrator from the Run 14 scout evidence; the owner's request is in `.planning/STATE.md` (Run 14).

## Phase boundary
Triggers, coalescing and the sync command that connect a documentation change to the phase 63 bulk path, with state that survives restarts. It does not decide what is worth retrieving.

## Decisions
- **D65-1:** four triggers feed one idempotent sync: git hooks, a filesystem watcher, the reconcile timer and the server's own planning events. Existing mechanisms: the post-commit collector is the only git hook that ships (`packages/collectors/src/install-git-hook.ts:16-17`, never overwrites a foreign hook, no debounce, emits the first 20 changed file names); the planning observer scans `.planning/` of one checkout every 15 s (`planning/observer.ts`, `planning/config.ts:22`); the server refresh runs only when `docsBackend === "lightrag"` (`service.ts:5651`).
- **D65-2:** the server's in-memory `planningHashes` is replaced by the manifest, so a restart re-ingests nothing unchanged.
- **D65-3:** `POST /docs/merge-trigger` has local sources for two datasets and nothing calls it for `agent-substrate` or `programming-desk` (`server.ts:353-361`, `:1736-1812`); it stays for skills sync, and the new path does not depend on it.
- **D65-4:** the VPS is private, so GitHub pushes cannot call it. The reconcile timer runs `git fetch` for each registered repository and then reads the fetched commit's tree directly (`git ls-tree -r` and `git cat-file --batch` on the remote-tracking default branch), because a fetch moves refs and not the checkout: a push made elsewhere leaves the working tree unchanged, so a working-tree scan would keep reporting no change. The sync therefore has two sources, the working tree for local edits and the fetched tree for remote ones, and the reconcile tests include a remote-only push.
- **D65-5:** hooks and the watcher never fail the user's command; hints are bounded and lost hints are recovered by the reconcile run.
- **D65-6:** a new `docs.sync` event maps onto the existing `note` kind through `payload.action` with a row in `event-sources.ts` and the table in `docs/event-vocabulary.md`; the vocabulary lock stays unchanged. The existing `docs.planning` action has no row (`service.ts` only) and gets one.

## Canonical references
`docs-freshness.ts` (`SUBSTRATE_DOCS_FRESHNESS_*`), `infra/vps/*.timer` (the canary timer is staged, not installed), `packages/mcp-server/src/event-sources.ts`, `docs/skills-sync-bridge-miners.md`
