---
phase: 01-lane-b
plan: 06
subsystem: infra
tags: [muse, bun, systemd, redaction, collector, projector, native-plugin, brief]

# Dependency graph
requires:
  - phase: 01-lane-b
    provides: "01-01's redact() module, EVENT_KINDS/SURFACES closed unions, and substrate-mcp's /brief and /events HTTP surface; 01-02's Cursor-style idempotent projector pattern"
provides:
  - "packages/collectors/src/muse.ts — brief-writing collector (SUBSTRATE_MUSE_REPOS required, POST /brief per repo, redact, write .substrate/BRIEF.md, append-only AGENTS.md pointer, brief.delivered event)"
  - "packages/projector/src/muse.ts — generates and idempotently installs a native Muse plugin whose PostToolUse hook emits a tool.call event"
  - "infra/vps/substrate-collector-muse.service — systemd unit running the brief writer continuously, installed and active"
  - "SUBSTRATE_MUSE_REPOS env var in /etc/substrate/substrate.env naming the four Lane B repos"
  - "brief.delivered added to EVENT_KINDS"
  - "empirical answer to research Assumption A2 (SessionStart hook output does reach model context, via decision.additional_contexts)"
affects: [phase-1-success-criterion-4, muse-code-integration, any-future-plan-touching-substrate-event-kinds]

# Actuals (#2632)
actuals:
  tokens: 5529
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Static brief-file fallback for closed binaries with no prompt-submission hook: collector POSTs /brief, writes a redacted file into the target repo, and an append-only marker block in AGENTS.md points a session at it."
    - "Native plugin projection: generate a bundle from a TS source-of-truth, `muse plugins validate` before every install, `install` on first run then `update` on subsequent idempotent runs (keyed off `muse plugins list --json`'s plugins[].plugin.id), `approve` to move a hook from review_needed to trusted_enabled."
    - "Hook scripts as literal-line arrays (not nested template literals) to avoid escaping a generated script's own backtick/${} syntax against the generator's."

key-files:
  created:
    - packages/collectors/src/muse.ts
    - packages/collectors/src/muse.test.ts
    - packages/projector/src/muse.ts
    - infra/vps/substrate-collector-muse.service
  modified:
    - packages/mcp-server/src/types.ts
    - AGENTS.md

key-decisions:
  - "SUBSTRATE_MUSE_REPOS set to the four repos STATE.md records as Lane B's own (hermes-plugin, omp-ultrathink, hermes-engineering-board, hermes-linear-connector), not agent-substrate itself — agent-substrate's own brief/AGENTS.md pointer already exists from Task 1's own verify run and is not part of the operator-named blast radius for the production unit."
  - "Manifest and hook schema for the Muse plugin were derived by reading the binary's own bundled create-plugin skill docs (native-plugin-contract.md, capability-examples.json) at ~/.local/share/muse/plugins/cache/builtin/muse-core/create-plugin/ rather than guessed, per the plan's explicit requirement; muse plugins validate confirmed valid:true with empty diagnostics before every install."
  - "Idempotence keyed off muse plugins list --json's plugins[].plugin.id (not a top-level plugins[].id, which does not exist) to decide install vs update; discovered mid-task that muse plugins update refreshes from the plugin's originally recorded install source path and ignores any newly given path, so a stale scratch-directory install had to be fully removed (plugins remove --delete-data) before the real, final install from the production MUSE_PLUGIN_DIR could be verified clean."
  - "hook test --fixture schema (top-level event + cwd + stdin) was determined empirically against the real binary's own error messages, since the create-plugin docs describe the plugin manifest contract but not the fixture file contract for hook test."
  - "The hook script resolves repo/branch via git rev-parse against its inherited cwd so the resulting tool.call event carries a repo field — required for composeBrief()'s repo-scoped recent-actions query to surface it, confirmed end-to-end via /brief."

patterns-established:
  - "Pattern: native-binary schema discovery — before writing a manifest/config generator for a closed binary, locate and read that binary's own bundled documentation/skill references rather than inferring the schema from partial --help output."

requirements-completed: [SC-4]

coverage:
  - id: D1
    description: "Muse collector writes a redacted, current .substrate/BRIEF.md into every named repo and ensures an idempotent AGENTS.md pointer block, emitting brief.delivered on success and leaving an existing brief untouched on failure"
    requirement: "SC-4"
    verification:
      - kind: unit
        ref: "packages/collectors/src/muse.test.ts#Test 1: writes .substrate/BRIEF.md with the fetched brief text"
        status: pass
      - kind: unit
        ref: "packages/collectors/src/muse.test.ts#Test 2: running twice leaves exactly one AGENTS.md marker pair"
        status: pass
      - kind: unit
        ref: "packages/collectors/src/muse.test.ts#Test 3: a pre-existing AGENTS.md keeps every original line, block appended not replacing"
        status: pass
      - kind: unit
        ref: "packages/collectors/src/muse.test.ts#Test 4: a failed fetch leaves an existing BRIEF.md untouched rather than truncating it"
        status: pass
      - kind: unit
        ref: "packages/collectors/src/muse.test.ts#Test 5: emits a brief.delivered event per repo on success, carrying repo and byte length"
        status: pass
      - kind: unit
        ref: "packages/collectors/src/muse.test.ts#Test 6: a tskey- style token in the brief is redacted before it is written"
        status: pass
      - kind: integration
        ref: "SUBSTRATE_MUSE_REPOS=/root/src/repos/agent-substrate bun packages/collectors/src/muse.ts --once && test -s .substrate/BRIEF.md && grep -c substrate-brief AGENTS.md == 2"
        status: pass
    human_judgment: false
  - id: D2
    description: "A native Muse plugin projected via packages/projector/src/muse.ts installs idempotently, is approved, and its PostToolUse hook provably fires and lands a muse-surfaced tool.call event"
    requirement: "SC-4"
    verification:
      - kind: integration
        ref: "muse plugins hook test substrate:post-tool-use --fixture <fixture> — exit 0, terminals[0].status completed"
        status: pass
      - kind: integration
        ref: "POST /brief {repo,surface:muse} after the hook test shows 'muse called substrate_probe_tool' in recent actions"
        status: pass
      - kind: integration
        ref: "muse plugins list --json | jq '[.plugins[]|select(.plugin.id==\"substrate\")]|length' == 1 after two consecutive projector runs (install then update)"
        status: pass
    human_judgment: true
    rationale: "The plan's own <verify><human-check> requires starting a real Muse session in a target repo and confirming the model can quote .substrate/BRIEF.md content when asked — that is a live-session judgment call this executor cannot perform non-interactively."
  - id: D3
    description: "The brief writer runs continuously under systemd (substrate-collector-muse.service), installed, enabled, active, supplied SUBSTRATE_MUSE_REPOS via the shared env file, and rewrites briefs on its poll interval rather than once"
    requirement: "SC-4"
    verification:
      - kind: integration
        ref: "systemctl is-active substrate-collector-muse == active; grep SUBSTRATE_MUSE_REPOS /etc/substrate/substrate.env matches; journalctl since start has no 'usage:' line"
        status: pass
      - kind: integration
        ref: "BRIEF.md mtime in hermes-plugin advanced by ~303s (1790251238 -> 1790251541) after waiting out one full 300000ms poll interval"
        status: pass
    human_judgment: false

# Metrics
duration: ~19min (measured span between Task 1's and Task 3's commit timestamps in this resumed session; the plan's total wall-clock, including pre-compaction schema-discovery work, is longer and not separately timestamped)
completed: 2026-09-24
status: complete
---

# Phase 1 Plan 06: Muse Code Summary

**Static per-repo brief file plus an append-only AGENTS.md pointer for Muse's closed binary (no prompt-submission hook exists), and a native PostToolUse plugin — schema discovered from the binary's own bundled docs — that lands `tool.call` events, both running as a systemd-supervised collector across Lane B's four repos.**

## Performance

- **Duration:** ~19 min measured span (see note above; session resumed mid-plan after a context compaction)
- **Started:** 2026-09-24T11:49:09Z (Task 1 commit; upstream schema-discovery work for Task 2 predates this timestamp)
- **Completed:** 2026-09-24T12:07:45Z
- **Tasks:** 3/3
- **Files modified:** 6 (4 created, 2 modified)

## Accomplishments
- Muse now has the only brief channel its closed binary actually offers: a static, redacted `.substrate/BRIEF.md` per repo, pointed at by an idempotent, append-only `AGENTS.md` marker block that never touches a pre-existing line outside it.
- Muse also has a working event path: a native plugin (schema derived from the binary's own `create-plugin` reference docs, not guessed) whose `PostToolUse` hook lands a `tool.call` event with surface `muse`, confirmed end-to-end via `muse plugins hook test` followed by an observed `/brief` "recent actions" entry.
- The brief writer runs unattended under `substrate-collector-muse.service`, confirmed to rewrite briefs on its 5-minute poll interval (not just once) across all four Lane B repos.
- Research Assumption A2 (does a `SessionStart` hook's stdout reach model context) is answered YES on the record, via the same `hook test` harness, without anything in this plan depending on the answer.

## Task Commits

Each task was committed atomically:

1. **Task 1: Write a current brief into every target repo, and point AGENTS.md at it** - `df13c83` (feat, tdd)
2. **Task 2: Project a Muse plugin whose PostToolUse hook emits substrate events** - `21c7c10` (feat)
3. **Task 3: Run the brief writer under systemd** - `531c1de` (feat)

**Plan metadata:** (this commit, made immediately after this SUMMARY)

## Files Created/Modified
- `packages/collectors/src/muse.ts` - Brief-writing collector: required `SUBSTRATE_MUSE_REPOS`, POST `/brief` per repo, redact, write `.substrate/BRIEF.md` (never truncating on a failed fetch), idempotent append-only `AGENTS.md` pointer, `brief.delivered` event, `--once`/`--watch` CLI
- `packages/collectors/src/muse.test.ts` - 7 tests (the 6 required behaviors plus one extra covering no-event-on-failure)
- `packages/projector/src/muse.ts` - Generates and idempotently installs/updates/approves a native Muse plugin bundle whose `PostToolUse` hook POSTs a `tool.call` event to `/events`
- `infra/vps/substrate-collector-muse.service` - systemd unit running the collector under `--watch`, installed and active
- `packages/mcp-server/src/types.ts` - added `"brief.delivered"` to `EVENT_KINDS` (Rule 2: the collector's core delivery-confirmation event needed a home in the closed union; `SURFACES` already had `"muse"`)
- `AGENTS.md` (repo root) - carries the substrate-brief pointer block, generated by running Task 1's own collector against `agent-substrate` itself as required by that task's `<verify>`

## Decisions Made
- `SUBSTRATE_MUSE_REPOS` for the production systemd unit was set to the four repos `STATE.md` records as Lane B's own initial-commit set (`hermes-plugin`, `omp-ultrathink`, `hermes-engineering-board`, `hermes-linear-connector`), not `agent-substrate` — the operator-named blast radius is Lane B's actual work, and `agent-substrate`'s own brief/pointer already exist from Task 1's verify run against itself.
- Muse's native plugin manifest and hook-declaration shape were read directly from the binary's own bundled `create-plugin` skill reference (`native-plugin-contract.md`, `capability-examples.json`) rather than inferred from `--help` alone, satisfying the plan's explicit "stop and surface a checkpoint rather than guessing" requirement by never needing to guess.
- Idempotence detection in the projector reads `plugins[].plugin.id` from `muse plugins list --json` (the id is nested there and duplicated at `plugins[].record.id`; there is no top-level `plugins[].id`).
- The hook script resolves `repo`/`branch` via `git rev-parse` against its inherited working directory so the emitted `tool.call` event carries a `repo` field — required for `composeBrief()`'s repo-scoped "recent actions" query to surface it at all; without this the event would land but never be observable through the only read path (`/brief`) available.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added `"brief.delivered"` to the `EVENT_KINDS` closed union**
- **Found during:** Task 1
- **Issue:** The plan requires emitting a `brief.delivered` event, but `EVENT_KINDS` in `packages/mcp-server/src/types.ts` did not yet include that kind — ingestion would have silently rejected every delivery-confirmation event.
- **Fix:** Added `"brief.delivered"` to `EVENT_KINDS`. Confirmed `SURFACES` already included `"muse"`, no change needed there.
- **Files modified:** `packages/mcp-server/src/types.ts`
- **Verification:** `bunx tsc --noEmit` clean; Task 1 test 5 asserts the event's shape and that it is accepted.
- **Committed in:** `df13c83` (Task 1 commit)

**2. [Rule 3 - Blocking] Removed a stale scratch-directory plugin install before the real idempotence run**
- **Found during:** Task 2
- **Issue:** While empirically validating the manifest/fixture schema, a plugin named `substrate` was installed from a throwaway scratch directory (`packages/projector/muse-plugin/`, never committed). `muse plugins update <id>` was then discovered to refresh content from that plugin's *originally recorded* install source path, not from any newly-specified path — so re-running the final projector script's `update` call kept silently pulling from the scratch directory instead of the production `MUSE_PLUGIN_DIR`, leaving stale hooks (including a throwaway `session-start-probe` hook used only for the A2 research) installed alongside the intended single `post-tool-use` hook.
- **Fix:** Ran `muse plugins remove substrate --delete-data --json` to fully uninstall, deleted the scratch directory (`rm -rf packages/projector/muse-plugin`), then re-ran the final `packages/projector/src/muse.ts` script fresh so it performed a genuine `install` from `/var/lib/substrate/muse-plugin`.
- **Files modified:** none (runtime plugin-cache state only; no repo files affected by the fix itself)
- **Verification:** `muse plugins inspect substrate --json` confirmed `record.source.path` = `/var/lib/substrate/muse-plugin`, exactly one hook (`post-tool-use`), `runtime_capabilities[0].status: "trusted_enabled"`.
- **Committed in:** n/a (no file changes; state-only correction ahead of the Task 2 commit)

**3. [Rule 3 - Blocking, verify-script correction] Substituted an equivalent idempotence check for the plan's literal `<verify>` line**
- **Found during:** Task 2
- **Issue:** The plan's automated `<verify>` block ends with `test "$(muse plugins list --json | grep -c 'substrate') = "1"` after two projector runs. Run exactly as written, this assertion fails (measured count: 7) even for a correctly non-duplicated single installed plugin — the binary's pretty-printed multi-line `--json` output naturally contains multiple lines substring-matching "substrate" (the plugin id, cache path, source path, and data path each appear on their own line) for one entry, not because of any actual duplication.
- **Fix:** Verified the plan's actual stated acceptance criterion — "re-running the projector leaves exactly one installed copy, no duplicate plugin id" — via `muse plugins list --json | jq '[.plugins[] | select(.plugin.id=="substrate")] | length'` (== 1) and a corroborating `grep -c '"active_scope"'` (== 1, since that field appears exactly once per installed-plugin entry regardless of internal field duplication). Ran the plan's literal command too, for the record: it exits 1 (fails) as predicted, confirming this is a defect in the verify script's assumption about output shape, not in the projector's idempotence.
- **Files modified:** none — this is a verification-methodology correction, not a code change.
- **Verification:** `jq` structural check plus a full `muse plugins inspect substrate --json` dump, both showing exactly one plugin entry, one hook, correctly sourced from `MUSE_PLUGIN_DIR`.
- **Committed in:** n/a (verification-only finding, documented here per Rule 3's "fix inline, track as deviation" process)

---

**Total deviations:** 3 (1 Rule 2 missing-critical, 2 Rule 3 blocking — one a stale-state correction, one a verify-script defect worked around with an equivalent, independently-confirmed check)
**Impact on plan:** All three were necessary to reach a correctly verified state; none changed the plan's design or scope. The verify-script defect (deviation 3) does not indicate any flaw in the shipped code — independent structural verification (`jq`) confirms genuine idempotence.

## Issues Encountered
- The plan's Task 2 `<verify>` automated command's final assertion (`grep -c 'substrate' == 1`) does not hold against the real `muse plugins list --json` output shape even in the fully correct case; see deviation 3 above. Future plans authoring `muse plugins list --json`-based checks should count structured fields (via `jq`) rather than grep line counts, since the binary pretty-prints its JSON across many lines per entry.
- None of Task 3's automated `<verify>` block required waiting out a full poll interval, but the "rewrites on poll interval rather than once" acceptance criterion did — this executor waited the full ~310s to observe a second write and confirm periodic (not one-shot) behavior directly, rather than relying solely on code inspection.

## User Setup Required
None - no external service configuration required. `/etc/substrate/substrate.env` was updated via an append-only `sudo tee -a` write (no read of prior content, per the harness's credential-access restrictions) and the unit is installed and active on this host already.

## Next Phase Readiness
- Phase 1 Success Criterion 4 (the Muse share) is fully delivered: brief channel, event channel, and continuous operation under systemd.
- The `brief.delivered` / `tool.call` (surface `muse`) event kinds and the `.substrate/BRIEF.md` / `substrate-brief` marker pattern are now precedented for any future collector targeting another closed-binary agent with the same "no live injection hook" constraint.
- No blockers. The four Lane B repos named in `SUBSTRATE_MUSE_REPOS` are the current operator-set blast radius; widening it is a one-line append to `/etc/substrate/substrate.env`, per the plan's own design intent.

---
*Phase: 01-lane-b*
*Completed: 2026-09-24*

## Self-Check: PASSED

All created files verified present on disk; all three task commits (`df13c83`, `21c7c10`, `531c1de`) verified present in `git log`.
