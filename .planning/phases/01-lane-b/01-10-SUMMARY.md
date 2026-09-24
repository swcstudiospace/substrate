---
phase: 01-lane-b
plan: 10
subsystem: infra
tags: [grok-hermes-connector, handoff_to_hermes, substrate-mcp, muse-collector, graph_claim, brief, proof]

# Dependency graph
requires:
  - phase: 01-lane-b
    provides: "01-05 graph_id on handoff_to_hermes and substrate_ext.emit; 01-06 Muse brief writer and SUBSTRATE_MUSE_REPOS; 01-09 proof graph ut-mufsocbe-c7ced745"
provides:
  - "handoff_to_hermes takes optional repo and node_id and passes both to the existing substrate_ext.emit(kind=handoff)"
  - "test_handoff_to_hermes_emits_repo_and_node_id locks that pass-through"
  - "Live SUBSTRATE_MUSE_REPOS lists five roots: the four Lane B checkouts plus /root/src/repos/agent-substrate"
  - "01-10-PROOF.md records an attributed handoff row, a claim on n2 by a real Hermes session that could not edit the tree, and an omp /brief body that names both"
affects: [phase-1-verification, roadmap-phase-1-proof, grok-hermes-connector, substrate-collector-muse]

# Actuals (#2632)
actuals:
  tokens: 3900
  tasks: 3
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "A claim-only live agent session runs as a transient systemd unit with ReadOnlyPaths on the working trees. That makes 'did not edit the tree' a guarantee, not only an observation."
    - "A kill-watcher, started before a live handoff call, SIGKILLs the implement wrapper (dispatch_handoff_to_hermes.sh) without editing the wrapper or the connector unit."

key-files:
  created:
    - .planning/phases/01-lane-b/01-10-PROOF.md
    - .planning/phases/01-lane-b/01-10-SUMMARY.md
  modified:
    - /root/src/repos/mcp/src/grok_hermes_connector/server.py
    - /root/src/repos/mcp/tests/test_handoff_pack.py
    - /etc/substrate/substrate.env
    - .substrate/BRIEF.md (written by the collector, gitignored)

key-decisions:
  - "Reused graph ut-mufsocbe-c7ced745 with n2 as the target. The new idempotency key 01-10-proof-ut-mufsocbe-c7ced745-n2 produced a fresh, non-deduped emit."
  - "The claim came from a real Hermes session (hermes chat, terminal toolset only, read-only trees, session 20260924_182534_fe7fa2). No proxy graph_claim was made by the executor."
  - ".substrate/BRIEF.md was not force-added to git. .gitignore:14 ignores .substrate/, and the collector rewrites the file every 5 minutes. Its observed body is recorded in 01-10-PROOF.md."
  - "Staged only this plan's hunks in mcp with git apply --cached. Other sessions' uncommitted changes in server.py and test_handoff_pack.py stay unstaged and unchanged."

patterns-established:
  - "Proof sessions for live agents: sandbox with ReadOnlyPaths, then export the session transcript (hermes sessions export) as the attribution evidence."

requirements-completed: []

coverage:
  - id: D1
    description: "handoff_to_hermes forwards repo and node_id on the substrate handoff emit"
    verification:
      - kind: unit
        ref: "tests/test_handoff_pack.py#test_handoff_to_hermes_emits_repo_and_node_id"
        status: pass
      - kind: unit
        ref: "tests/test_handoff_pack.py#test_handoff_to_hermes_emits_one_handoff_event_with_graph_id"
        status: pass
      - kind: integration
        ref: "Greptime agent_events row evt_1ddb0a2c572849ce86b2616b77bc0589: kind=handoff repo=swcstudiospace/agent-substrate node_id=n2 graph_id=ut-mufsocbe-c7ced745"
        status: pass
    human_judgment: false
  - id: D2
    description: "Proof checkout is on the live Muse list and its BRIEF.md was rewritten by the collector"
    verification:
      - kind: other
        ref: "Task 2 automated verify: five-root single SUBSTRATE_MUSE_REPOS line, collector active, BRIEF.md mtime 1790274119 > 1790250530"
        status: pass
    human_judgment: false
  - id: D3
    description: "A real Hermes session claimed n2 with the tree unchanged, and POST /brief as omp names both the handoff and the claim"
    verification:
      - kind: e2e
        ref: "01-10-PROOF.md Task 3: graph_get n2 claimed_by=hermes claim_session=20260924_182534_fe7fa2; porcelain and content hashes unchanged; omp brief lines '18:26 hermes claimed node (n2)' and '18:24 grok-bot Handoff to Hermes ... (n2)'"
        status: pass
    human_judgment: true
    rationale: "Grok Bot, Omp, Muse and Grok Build model sessions were not run, so no model quoted the brief. n2 is claimed, not completed. A human must decide whether a claim satisfies 'Hermes finishes n2'."

# Metrics
duration: 12min
completed: 2026-09-24
status: complete
---

# Phase 1 Plan 10: Handoff attribution, Muse proof-repo brief, and proof re-run Summary

**The handoff event now carries repo and node_id. The proof checkout is on the live Muse list. A real sandboxed Hermes session claimed n2, and the omp brief names both the handoff and the claim.**

## Performance

- **Duration:** about 12 min
- **Started:** 2026-09-24T18:20:32Z
- **Completed:** 2026-09-24T18:32Z
- **Tasks:** 3
- **Files modified:** 6 (2 mcp source/test, 1 env file, 1 collector-written brief, 2 planning docs)

## Accomplishments
- `handoff_to_hermes(repo=..., node_id=...)` reaches `substrate_ext.emit`. The live row `evt_1ddb0a2c…` has `repo=swcstudiospace/agent-substrate` and `node_id=n2`.
- `SUBSTRATE_MUSE_REPOS` now lists five roots on one line. `substrate-collector-muse` delivered to 5 repos, and `.substrate/BRIEF.md` was rewritten at 18:21:59Z.
- A real Hermes session (`20260924_182534_fe7fa2`) ran with read-only trees and one terminal `curl` to `graph_claim`, and it claimed n2. The claim event carries the graph id and the repo. Porcelain and content hashes did not change.
- `POST /brief` (omp, slug, graph id) lists `hermes claimed node (n2)` and `grok-bot Handoff to Hermes … (n2)`. `/verify` returns `{"ok":true,"events":3}`.

## Task Commits

1. **Task 1: Pass repo and node_id on the handoff emit.** mcp `63fd450` (fix)
2. **Task 2: Add the proof repo to the live Muse list.** No commit. The env file is outside git, and BRIEF.md is gitignored.
3. **Task 3: Re-run the proof.** Recorded in 01-10-PROOF.md and committed with this summary.

**Plan metadata:** see the `docs(01-10)` commit in agent-substrate.

## Files Created/Modified
- `/root/src/repos/mcp/src/grok_hermes_connector/server.py`: two optional arguments, forwarded on the handoff emit
- `/root/src/repos/mcp/tests/test_handoff_pack.py`: `test_handoff_to_hermes_emits_repo_and_node_id`
- `/etc/substrate/substrate.env`: `:/root/src/repos/agent-substrate` appended to the single `SUBSTRATE_MUSE_REPOS` line (still 0600 root)
- `.substrate/BRIEF.md`: written by the collector, gitignored
- `.planning/phases/01-lane-b/01-10-PROOF.md`: observed proof

## Decisions Made
See the key-decisions list in the frontmatter.

## Deviations from Plan

**1. [Rule 3 - Blocking] .substrate/BRIEF.md not committed**
- **Found during:** Close-out
- **Issue:** The assignment asked for the collector-written BRIEF.md to be committed. `.gitignore:14` ignores `.substrate/`, and the file has never been tracked.
- **Fix:** Did not force-add it. Tracking it would dirty the tree every 5 minutes when the collector rewrites it. Its observed body and mtime are recorded in 01-10-PROOF.md.
- **Files modified:** none
- **Verification:** `git check-ignore -v .substrate/BRIEF.md` returns `.gitignore:14:.substrate/`

**Total deviations:** 1 (a commit scope correction). **Impact:** none on behavior.

## Issues Encountered
- The live handoff still starts the implement wrapper. A kill-watcher SIGKILLed `dispatch_handoff_to_hermes.sh` (pid 207619) about 100 ms after it spawned, and killed its ACK `hermes send` (pid 207634) at about 113 ms. No implement `hermes chat` started. Whether a Telegram ACK went out was not observed.
- The mcp checkout already held other sessions' uncommitted hunks in server.py and test_handoff_pack.py. Only this plan's hunks were staged.

## User Setup Required
None.

## Remaining gaps (human)
- No Grok Bot model session made the handoff. The executor made it through the connector API.
- No live Omp, Muse or Grok Build model session ran, so no model quotation exists.
- n2 is claimed by a real Hermes session but not completed. Whether a claim-only finish satisfies "Hermes finishes n2" is a human call.

## Next Phase Readiness
Phase 1 is ready for re-verification of truths 7 and 8 and of the Muse proof-repo currency. The two mcp baseline failures remain, untouched. D-01 was not started.

---
*Phase: 01-lane-b*
*Completed: 2026-09-24*

## Self-Check: PASSED

- Task 1 verify: `2 passed in 1.39s` (exit 0). Baseline files `tests/test_dedupe_waiter.py` and `tests/test_tasks_skills.py` are unchanged versus HEAD.
- Task 2 verify: `active` plus the five-root line, a single key, and BRIEF.md mtime > 1790250530. Result: `T2_PASS`.
- Task 3 verify: 01-10-PROOF.md contains `repo=swcstudiospace/agent-substrate`, `node_id=n`, handoff and claim, with 112 non-blank lines. Result: `T3_PASS`.
- `grok-hermes-connector`, `substrate-collector-muse` and `substrate-mcp` are all `active`. brief.ts, muse.ts, infra/vps, substrate_ext.py and the dispatch script are unchanged.
