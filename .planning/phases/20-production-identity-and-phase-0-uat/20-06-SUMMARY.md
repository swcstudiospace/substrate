---
phase: 20-production-identity-and-phase-0-uat
plan: "06"
subsystem: production-identity
status: blocked
completed: null
last_updated: 2026-10-11
checkpoint: human-action
human_tasks_completed: 0
human_tasks_total: 3
requirements-completed: []
tags: [operator-blocked, identity-rotation, client-delivery, production-uat]
requires:
  - phase: 20-production-identity-and-phase-0-uat
    provides: "20-01 through 20-05 source deliverables; recovered 20-05 client at 9006476"
provides:
  - "Source-grounded operator command packet and pending checkpoint record only"
affects: [production-identity, production-uat]
actuals:
  tasks: 0
  commits: 0
coverage:
  - id: D1
    description: "Provisioning, switch-on, incident revocation and post-switch evidence"
    requirement: "FOUND-04"
    verification:
      - kind: human
        ref: "20-06-PLAN.md Task 1; production-identity.md ordered window and rotation"
        status: blocked
    human_judgment: true
  - id: D2
    description: "Reviewed cross-repo main landing, installed plugin/MCP entry and hooks"
    requirement: "UAT-03"
    verification:
      - kind: human
        ref: "20-06-PLAN.md Task 2; production-identity.md client-readiness packet"
        status: blocked
    human_judgment: true
  - id: D3
    description: "Actual production UAT and final evidence records"
    requirement: "UAT-01"
    verification:
      - kind: human
        ref: "20-06-PLAN.md Task 3; production-identity.md production UAT packet"
        status: blocked
    human_judgment: true
---

# Phase 20 plan 06: operator checkpoint Summary — BLOCKED

**Human actions completed: 0/3. No production acceptance or Phase 20 completion is claimed.**

This file is a checkpoint/handoff record, not a completed-plan artifact.
Native GSD initialization may coarsely count an existing `SUMMARY.md`;
that file-existence count must not override `status: blocked`, null
completion and zero completed human tasks. Do not call `phase.complete`
for Phase 20 on the strength of this file. Independent reachable work
continues without changing the three operator boundaries below. This
slice does not change root state, phase counts, verification freshness,
security verdicts, or milestone closure/archive status.

## Recovery evidence recorded 2026-10-11

Source: parent-supplied `local://v13-phase20-recovered-client-evidence.json`;
see [20-05 recovery addendum](20-05-SUMMARY.md#recovery-evidence-recorded-2026-10-11).

- The restored cross-repo worktree is
  `/root/src/worktrees/claude-ultrathink-p20`, local branch
  `gsd/v1.3-p20-identity-uat`, revision **9006476**.
- Frozen install exit **0**; four targeted files **159 pass / 0 fail**,
  exit 0, with the production token directory masked; typecheck exit **0**.
- Actual scratch MCP registration ran twice and graph `ut-p20-295d4559`
  read back as `claude-code` with node `n1`, step `n1/1`, and no duplicate
  nodes or steps. Both registration exits and readback exit were 0.
- Wrong bearer **HTTP 401** still produced fail-open register CLI exit 0;
  disabled integration was skipped. Neither exit-0 case proves success.
- Parent agent-safe `identity-check.ts --json` returned exit **0**, names-only
  `pass: true`, zero missing names, zero stranded-live metadata entries and
  zero errors. Existing credential delivery metadata is present; do not
  regenerate or overwrite held values merely to resolve an unknown-variable
  question. This does not check bearer equality, external-client readiness,
  installed plugin provenance, rotation, approved restarts or production UAT.

These are observed recovered-client/scratch results supplied by the
parent, not new checks run by this documentation task. They do not prove
remote delivery, an upstream PR/main landing, installed-plugin refresh,
authenticated production clients, production rotation or production UAT.
The historical 20-05 metrics and completion date remain unchanged.

## Pending human actions

| 20-06 task | State | Evidence still required |
| --- | --- | --- |
| 1. Provisioning, switch-on and post-switch evidence | operator-blocked | Approved window; Phase 19 collector cutover; private client/server delivery; both identity modes; real client readiness; restart/parity, durable audit and signed-handoff round-trip; immediate/30-minute summed metrics with every live client accounted for; exposed Cursor credential rotation/revocation |
| 2. Cross-repo landing and hook installation | operator-blocked | Operator branch delivery and draft PR; Desk Quality / Programming Lead Greptile gate; human-approved main landing; clean stable checkout and installed plugin version/commit; real user-scope substrate entry; Cursor hooks current and git hook `present` in every approved repo |
| 3. Production UAT and final records | operator-blocked | Approval reference covering actual writes; real kickoff state/graph and issue capacity; real Cursor session and commit; required production scenario results and operator SQL/export evidence in `20-UAT.md` and the Phase 0 result record; parent final verification |

No completed task, production verdict or approval reference is invented.
FAILED, SKIPPED or unavailable Greptile review is a blocker. This packet
is not merge-ready and contains no agent merge/auto-merge/main-push path.

## Operator next steps

The executable packet is in
[production identity](../../../docs/runbooks/production-identity.md):

1. **Task 1 — private identity window.** Use the manifest paths and the
   code-derived variable names in **Local paths and inputs**. Retrieve
   existing credentials locally without displaying them; generate absent
   ones into new 0600 files under a 0700 private directory. Names-only
   checks inspect metadata/names, not bearer equality; the operator-only
   values check validates list membership but marks external clients
   `unchecked`. Stage the env file and preserve unrelated settings.
   Client readiness must precede enforcement. No automatic env or client
   credential replacement is authorized.
2. **Incident action — explicit two-restart rotation.** An earlier unsafe,
   pre-existing CLI test read the actual Cursor substrate credential and
   exposed it in failure output. The fixture is now isolated; the operator
   still must rotate/revoke the exposed production credential. Any earlier
   rotation decline does not apply to this new incident. Keep the old
   server-list member, add a locally generated replacement in staging,
   check/promote/restart, soak, privately refresh every effective client
   source, prove fresh authentication, then stage removal of only the old
   member and check/promote/restart again. Do not reproduce the value or
   revoke it before its consumers have moved. Rotation is not recorded
   as performed here.
3. **Task 2 — delivery and refresh only after approval.** Review the restored
   local branch, push that feature branch only, and open/reuse a draft PR
   against upstream `main`. Route the Greptile gate through Programming
   Lead / Desk Quality. A human performs a normal approved merge; no agent
   bypass. Only afterward update the established clean stable checkout
   `/root/src/repos/claude-ultrathink` with `pull --ff-only`, refresh the
   Claude marketplace/plugin and restart the host. Record installed
   provenance, not just recovered HEAD. Run `scripts/mcp-register.ts
   --hosts claude --substrate` from the stable clone after reviewing its
   private dry run; do not automatically overwrite foreign entries.
   The bearer-emitting `substrate headers` helper is for private client
   consumption only, never a chat diagnostic. Install git hooks only into
   the approved local `SUBSTRATE_MUSE_REPOS` roster; require `present`
   per repo, not exit 0 (missing hooks can exit 0). Require the Cursor
   projector's explicit `already current` result; an external host
   `--check-hooks` exit alone is likewise insufficient.
4. **Task 3 — genuine production UAT.** Confirm the approval reference,
   free issue slots and the real kickoff state/graph locally. Registration
   requires `substrate: registered <graphId>` plus `graph_get` readback;
   failure/skipped register paths also exit 0. The script flags scenarios
   `1,3,6,8` as write-gated with `--live`; scenario 1 is not read-only,
   and the real scenario-5 kickoff writes tracker/graph rows before the
   later readback. Follow the explicit `2,5` readback and approved
   `1,2,3,5,6` commands in the runbook. Scenario 6 additionally requires
   the operator's actual session and commit; config checks alone do not
   prove it. Record failures as failures, sanitized counts/IDs/statuses
   only. Production metrics, audit durability, handoff verification and
   UAT records remain pending.

No script, test, build, lint, smoke, gate, formatter, network call,
production write, plugin refresh, credential handling or runtime command
was executed by this documentation task. No commits, pushes or PRs were
made; the commands above are operator handoff, not execution evidence.

## Parent static verification and exact operator unknowns

The parent can inspect command contracts read-only without credentials:

- `scripts/identity-check.ts`: parsers, `main` flags, live/external verdicts.
- `infra/identity/clients.json`: exact delivery paths, variables, roster.
- `packages/mcp-server/src/config.ts`: comma-separated token lists,
  surface mapping, operator membership, handoff previous-key/ID pair.
- `packages/projector/src/cursor.ts` and
  `packages/collectors/src/install-git-hook.ts`: install/check semantics.
- `scripts/uat-phase0.ts`: write-scenario set, flags, installed-plugin
  metadata/fallback, graph readback and production scenario behavior.
- The recovered client's `src/substrate/brief.ts`, `src/mcp/cli.ts`,
  `scripts/mcp-register.ts` and `docs/how-to/upgrade-and-move.md`: bearer
  precedence, fail-open outcomes, entry ownership and plugin refresh.

Current operator-only unknowns are approval/window timing and its
non-secret reference; actual effective overrides/accounts and approved
hook roster; upstream PR/gate/main-landing and installed provenance;
real kickoff state/graph and tracker capacity; and post-window production
evidence. The existing local files/code supply path defaults, names and
command flags. Never ask the operator to paste secret values. Parent
owns final source freshness, checks, formatting, commits and root status;
this blocked summary supplies no substitute proof.
