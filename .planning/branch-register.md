# Branch and work-in-progress disposition register

Recorded 2026-10-29 (Run 13) against `origin/main` 99ab6754, then updated for the PRs of the run. The request was to merge the work on the remote branches and the new code onto main. A branch tip that is not an ancestor of main does not mean its content is missing: main is squash-merged, so the check used here is content-level (a three-way merge of each changed file between main, the branch's merge base and the branch tip; commit-level matching by author time and subject; the PR that landed each branch).

Result: of 84 remote branches not contained in main, **60 are heads of merged PRs** (listed last), **24 carry no merged head**, and of those 24 only the work named below was missing from main. It was landed through the PRs listed, not by merging old branches, because every one of them was 200 to 690 commits behind main and conflicted with code that evolved. **No branch, tag or stash was deleted or changed.** The one new ref is `archive/v13-autonomous-worktree-2026-10-29`, a snapshot of an uncommitted worktree that is not meant to be merged.

## Landed from branch work in Run 13

| PR | What | Source |
|---|---|---|
| #165 | the 7-SOTA plan under `.planning/uplift-7/` (every citation repointed) and thirteen v1.3 review, security, proof and validation records in the v1.3 archive | closed PR #83 branch; commit 76a4b2c3; an uncommitted worktree |
| #167 | the MCP `skills_propose` tool refuses a body over the 1,000,000-byte limit the REST route already enforces; the isolation docs match the code | commit 76a4b2c3 |
| #168 | the desktop wrapper and smoke refuse to run unless the docker endpoint is proven local (the driver already did); bounded, force-killed probe | commit 76a4b2c3 |
| #169 | every GreptimeClient diagnostic is scrubbed of configured credentials (scrub, then clip; JSON-escaped spellings; the missing-table fact stays structured) | commit 76a4b2c3 |

Not ported, deliberately: an audit row for an oversize or malformed REST `/skills/propose` body (main's `invalid-write-roundtrip.test.ts` pins that a body refused before the audit call leaves no record, and that an MCP call is audited `allowed` before the tool refuses it; that contract is the owner's to change), the production-identity runbook rewrite (the archive's copy records the real 2026-10-10 switch-on that the rewrite lacks), and the `greptime-smoke` extension (needs a live twin to verify).

## The 24 remote branches without a merged head

| Branch | PR | Verdict | Evidence |
|---|---|---|---|
| `claude/legacy-claims-strand-writes-k64mvr` | no PR | ON_MAIN | twin of PR #5's head (`claude/memory-governance-gate-prdjln`): 14 commits match by author time and subject; `memory-write.ts`, `memory-policy.ts`, `docs/memory-governance.md` and four test files are byte-identical to that head; main's copies evolved after PR #9 |
| `claude/takeover-wrong-write-jcih22` | no PR | ON_MAIN | an earlier snapshot of the same PR #5 series; the one commit it lacks ('no recorded identity') is on main through PR #5 |
| `claude/memory-write-approval-p1s-wuexi0` | no PR | SUPERSEDED | an earlier iteration of the SPE-4791 follow-up that PR #9 landed in a different design (`memory_reviews_pending_idx`, `standing.raced`); the `already-approved` design it carries was not adopted |
| `claude/rebase-swarm-adr-iigtda` | no PR | ON_MAIN | ADR 0001 is byte-identical on main (PR #8) |
| `claude/spe-4792-pr6-rebase-ctpybs` | no PR | ON_MAIN | tip equals the head of merged PR #6; tree byte-equal |
| `claude/spe-4793-greptile-p1s-eo1yxq` | no PR | ON_MAIN | tip equals the head of merged PR #7; tree byte-equal |
| `gsd/v1.3-p22-skills-sync` | no PR | ARCHIVE_ONLY | draft phase 22 plans; the final records are in `.planning/milestones/v1.3-phases/22-skills-sync-bridge-and-miners/`; the two extra draft plans (22-05, 22-06) were superseded |
| `swarm/v13-autonomous-integration` | no PR | PORTED (3 PRs) + RECOVERED | its hardening commit 76a4b2c3 was re-derived against main: the `skills_propose` MCP body cap (#167), the desktop locality gate in the wrapper and smoke (#168), the GreptimeClient credential scrub (#169); its review, security and proof records were recovered into the v1.3 archive (#165); its planning edits are superseded by the archive |
| `pr-83` | no PR | SUPERSEDED + RECOVERED | same tree as `feature/7-sota-enhancements` (PR #83); the code was a first-draft take on what the v1.5 phases 45-54 built; the plan document it carries was recovered (#165) |
| `feature/7-sota-enhancements` | #83 closed | SUPERSEDED + RECOVERED | the seven enhancements were built by v1.5 (fabric, hybrid RAG, predictive cache, secure proxy, graph memory, pub/sub); `.planning/7-SOTA-ENHANCEMENTS.md` now lives at `.planning/uplift-7/` and every citation points at it (#165) |
| `gsd/p53-complete-tools` | no PR | SUPERSEDED | phase 53 was replayed onto main (`3d7dbf8a`, replaces #110); main's steering tests are a superset |
| `gsd/p53-steering-core` | no PR | SUPERSEDED | as above; the local branch of the same name holds no commit that exists on no remote |
| `gsd/p54-observability-inventory` | no PR | SUPERSEDED | phase 54 was replayed onto main (`4c86ee1b`, replaces #111); main's runbook and telemetry are newer |
| `quality/biome-report-only` | no PR | SUPERSEDED | replaced by the blocking Biome gate (#155) and now by zero warnings (#171) |
| `test/swarm-pins-a16-a30` | no PR | ON_MAIN | the pins are in `packages/mcp-server/src/server.test.ts` on main (card boundary A16-A30 and claim boundary) |
| `docs/data-planes-tailscale` | #1 closed | SUPERSEDED | 276 commits of unrelated VPS-local history; the docs payload landed through PR #2 (`docs/data-planes-tailscale-clean`); the per-plan v1.0 detail files are old pre-restructure detail, the archive keeps the condensed records |
| `docs/roadmap-state-reconcile` | #118 closed | SUPERSEDED | re-shipped from a fresh branch as #119 (owner's closing comment) |
| `planning/consistency-check-2026-10-24` | #123 closed | ON_MAIN | its two commits landed through #125 (the stale primary checkout sat on this branch) |
| `gsd/p52-wiring` | #109 closed | SUPERSEDED | replayed onto main (`2b267a67`) |
| `gsd/p53-complete-store` | #110 closed | SUPERSEDED | replayed onto main (`3d7dbf8a`) |
| `gsd/p54-complete` | #111 closed | SUPERSEDED | replayed onto main (`4c86ee1b`) |
| `gsd/v16-58-live-steering` | #131 closed | SUPERSEDED | replayed onto main (`b1838eb2`) and finished by #147 |
| `phase/31-lane-a-runtime` | #51 merged, +1 commit | ARCHIVE_ONLY | the extra commit's phase 32 plan files are byte-identical in `.planning/milestones/v1.3-phases/32-lane-a-host-core/` |
| `gsd/v13x-41-anchor` | #93 merged, +5 commits | ON_MAIN | all 42 commits after the PR head are on main |

Verdicts: ON_MAIN (content present), SUPERSEDED (replaced by later work), ARCHIVE_ONLY (planning records that live in `.planning/milestones/`), PORTED/RECOVERED (landed in Run 13), DISCARD (no value).

## Local branches with commits on no remote (22)

| Branch | Verdict | Evidence |
|---|---|---|
| `claude/greptime-events-ledger-7j1so8` | ON_MAIN | append-only `agent_events`, store lock and the smoke script are on main; the plane commit was rewritten as `planes/*` |
| `reconcile/pr10` | ARCHIVE_ONLY | the v1.0 archive and research docs are on main in revised form |
| `backup/p11-with-planning` | DISCARD | a backup copy of the phase 11 work; the records are in `milestones/v1.2-phases/11-lease-authority/` |
| `feat/v1.2-p11-lease-authority` | ON_MAIN | holder-only leases and the claim TTL are on main (PR #16, `lease.ts`) |
| `feat/v1.2-p14-projector` | ON_MAIN | transactional, symlink-safe projection is on main (#17, #18, #152) |
| `feat/v1.2-p15-lessons-bank` | ON_MAIN | scope-keyed lessons and diagnostic redaction are on main (#26, #68) |
| `planning/v1.2-milestone` | ARCHIVE_ONLY | the v1.2 archive is on main |
| `gsd/v1.3-hardening-ci` | ON_MAIN | CI hardening of that era is on main in later form |
| `gsd/v1.3-int-17-18` | ARCHIVE_ONLY | integration branch for phases 17-18; the work landed through its phase PRs |
| `gsd/v16-0-milestone`, `gsd/v16-55-foundations`, `gsd/v16-56-lightrag`, `gsd/v16-57-hindsight-keys`, `gsd/v16-59-proofs`, `gsd/v16-61-snapshot` | ON_MAIN | each single local commit is on main through PR #130 and later review rounds (main's code evolved past them) |
| `fix/as-fix-110` | ON_MAIN | `observer.ts` already announces a conflict once per deterministic key when the ledger can dedupe |
| `wt/pr94-alt` | SUPERSEDED | main fails the refresh on an unreadable scan, validates skill directories and checks the checkout's HEAD instead of re-reading a commit snapshot |
| `fix/audit-advisories-upgrade` | SUPERSEDED | main's lockfile has newer zod, undici and body-parser; the audit gate passes with its five accepted entries |
| `feat/v14-expected-version-skills-docs` | ON_MAIN | `expected_version` for skills and docs landed through #80-#82 |
| `backup/p42-batching-local-330d78a` | ON_MAIN | `batchPagesForIngest` and its tests are on main |
| `ultrathink/uplift-5-b` | ON_MAIN | uplift 5 merged through its PRs |
| `gsd/r12-lintint` | DISCARD | a scratch merge of this run's own lint branches |

Another 81 local branches are ahead of main only because their commits also exist on a remote branch listed above or below.

## Worktrees, stashes and the primary checkout

- `/root/src/worktrees/agent-substrate-v13-autonomous` (branch `swarm/v13-autonomous-integration`, 36 modified and 11 untracked files from 2026-10-11): the whole state is preserved on `archive/v13-autonomous-worktree-2026-10-29` (commit edcc7859, one commit on top of 76a4b2c3). Recovered into main by #165: the 8 records the archive lacked. Not landed: 23 edits to records the archive already has, the production-identity runbook rewrite, `scripts/greptime-smoke.ts`, an `anchor-run.test.ts` variant.
- `/root/pr-fix/v151-fabric` (branch `gsd/v15-51-fabric`, 7 modified files): the pre-merge draft of phase 51 (`fabric_suggest`, six resources); main has `fabric_optimize` and seven resources. Superseded; left untouched.
- The 10 stashes are unchanged (register decision D-23: kept, none dropped).
- The primary checkout `/root/src/repos/agent-substrate` sits on the closed `planning/consistency-check-2026-10-24` branch, 225 commits behind main, with seven `swarm:` state lines added to `STATE.md` and an untracked `.claude/swarm-state.json` (a swarm run that never progressed). Both are runtime noise, not work; they were not committed. Switch that checkout to main before using it.

## Remote branches whose tip is the head of a merged PR (60)

Nothing is missing from main for these; they are candidates for pruning by the owner (none was deleted).

| Branch | Merged PR |
|---|---|
| `chore/known-vuln-accepted-risk` | #99 |
| `claude/greptime-events-ledger-7kwlr2` | #4 |
| `claude/index-store-write-collisions-vp98y1` | #9 |
| `claude/memory-governance-gate-prdjln` | #5 |
| `claude/otlp-slos-mcp-audit-y9o6bj` | #7 |
| `claude/spe-4792-leases-handoffs-2gz8rx` | #6 |
| `claude/swarm-substrate-adr-7anb0p` | #8 |
| `cursor/cloud-agent-env-3ee5` | #56 |
| `cursor/cursor-mcp-projector-bcb9` | #55 |
| `docs/data-planes-tailscale-clean` | #2 |
| `docs/phase-verification-closed-set` | #114 |
| `docs/roadmap-progress-rows-45-51` | #119, #121 |
| `docs/roadmap-reconcile-v15` | #105 |
| `docs/uplift-7-closeout` | #75 |
| `docs/v13x-closeout-40-44` | #117 |
| `feat/lightrag-railway-planning-graph-steering` | #112 |
| `feat/swarm-surfaces-a16-a30` | #113 |
| `fix/skill-scan-ratio-load` | #115 |
| `gsd/29-agent-cards-and-teachable-moments` | #50 |
| `gsd/autonomous-run-2026-10-24` | #126 |
| `gsd/p51-fabric-impl` | #108 |
| `gsd/r12-checkpoint-lock` | #146 |
| `gsd/r12-ci-tooling` | #142 |
| `gsd/r12-close-milestones` | #161 |
| `gsd/r12-code-ratchet` | #145 |
| `gsd/r12-docs-lightrag-status` | #157 |
| `gsd/r12-docs-plane-wording` | #154 |
| `gsd/r12-evidence-node-flag` | #159 |
| `gsd/r12-fabric-lightrag` | #158 |
| `gsd/r12-fakegh-lock-race` | #153 |
| `gsd/r12-governance` | #156 |
| `gsd/r12-guarded-reanchor` | #150 |
| `gsd/r12-lint-cli` | #151 |
| `gsd/r12-lint-gate` | #155 |
| `gsd/r12-lint-mcp-server` | #149 |
| `gsd/r12-lint-rest` | #152 |
| `gsd/r12-memory-entry-id` | #143 |
| `gsd/r12-planning-sync` | #144 |
| `gsd/r12-reverify-phases` | #160 |
| `gsd/r12-session-hooks` | #148 |
| `gsd/r12-steering-join` | #147 |
| `gsd/v1.3-p18-guard-rails` | #26 |
| `gsd/v1.3-p19-lane-b-collectors` | #30 |
| `gsd/v1.3-p20-identity-uat` | #33 |
| `gsd/v1.3-p21-skills-propose` | #28 |
| `gsd/v1.3-p22-execute` | #40 |
| `gsd/v1.3-p23-claim-mirror` | #36 |
| `gsd/v1.3-p24-dispatcher` | #41 |
| `gsd/v1.3-p25-docs-ragflow (retired)` | #34 |
| `gsd/v1.3-p27-ledger-primitives` | #29 |
| `gsd/v1.3-p28-anchor-job` | #35 |
| `gsd/v1.3-p29-agent-cards` | #42 |
| `gsd/v1.3-p30-desktop-run` | #31 |
| `gsd/v13x-40-docs-memory` | #92 |
| `gsd/v13x-41-anchor-merged` | #116 |
| `gsd/v15-48-proxy` | #102 |
| `planning/autonomous-run-preflight` | #122 |
| `ship/planning-consistency-2026-10-24` | #125 |
| `substrate/ut-muhk8v3p-47ae5f1a` | #57 |
| `swarm/v13-current-proof-corrections` | #54 |
