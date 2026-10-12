# v1.3 Milestone Validation — Build plan completion

**Validated:** 2026-10-11 (UTC) at tip `b3ab09b`
**Scope:** Phases 16–33 (18 phases, 68 approved requirements)
**Verdict:** **PASS with recorded gated remainders** — every phase implemented and verified at the milestone tip; 43 live-tail behaviors across 11 phases are explicitly gated and unproven, each recorded with proof + rollback in its phase runbook/validation map.

## Success criteria

| Criterion | Status | Evidence |
| --- | --- | --- |
| Finish the build plan — every unfinished area, in build-plan order | ✅ | 18/18 phases executed; PRs #31–#53 merged; all code on `main` |
| Every phase verified at the milestone tip | ✅ | 18/18 `verification_status: passed` (final sweep `b3ab09b`); 6 phases fully verified with zero gaps (16, 18, 19, 20, 21, 23) |
| Gated live tails do not block milestone closure | ✅ (convention) | 43 `behavior_unverified` items across 11 phases (22:6, 24:8, 25:4, 26:4, 27:1, 28:2, 29:3, 30:2, 31:4, 32:4, 33:5) — each with proof, rollback, and runbook pointer |
| One PR per phase, Greptile-reviewed, merged | ✅ | PRs #31, #33, #35 (pre-session), #45–#53; Greptile findings addressed or dispositioned on-PR |
| Failures at HEAD recorded, not fixed | ✅ | F-01 (rehearsal `--port 7410` cwd-sensitive guard) recorded in every affected verification; F-02 fixed by its owning phase (20) |
| Suite health at tip | ✅ | bun 3136 pass / 58 skip / 1 recorded env fail; pytest 246; tsc clean; phase-close pass (EVENT_KINDS 12, SURFACES 27); store/redact/vocabulary locks green |

## Phase outcome table

| Phase | Outcome | Verification | Gated remainders |
| --- | --- | --- | --- |
| 16 Production parity & rehearsal harness | complete | passed (refreshed) | — |
| 17 Event vocabulary & audit policy | complete | passed (pre-session) | — |
| 18 Guard rails & shared redactor | complete | passed (refreshed) | — |
| 19 Lane B collectors | complete | passed (refreshed) | — |
| 20 Production identity & Phase 0 UAT | complete | passed | switch window executed 2026-10-10 (soak clean); scenarios 2+5 pass live |
| 21 skills_propose | complete | passed (refreshed) | first real agent-skills PR → phase 22 tail |
| 22 Skills sync, bridge, miners | complete | passed/partial (bu=6) | cutover chain + client rebinds (8 steps, runbook) |
| 23 Claim mirror & DoD gate | complete | passed (refreshed) | MIRROR-08 live proof (SWC-467) scripted, NOT RUN |
| 24 substrate-dispatcher | complete | passed/partial (bu=8) | env provisioning, DISP-08 window, unit restart, state review |
| 25 Docs search & ingest (RAGFlow) | complete | passed | G1–G4 (probe, datasets, ingest, served search) |
| 26 Hindsight recall & Dragonfly cache | complete | passed | G1–G4 (probe, bank/recall, retain, topology + headless proof) |
| 27 Ledger primitives & ingest order | complete | passed (refreshed) | gap unchanged (bu=1) |
| 28 Hourly anchor job & verify | complete | passed (refreshed) | devnet L1–L10 deferred; v1.1.4 anchors cadence acceptance |
| 29 Agent Cards & teachables | complete | passed | G1 spec diff, G2 publication, G3 devnet-backed teachable |
| 30 desktop_run | complete (7/7) | passed | live proof chain, N1 spike ladder, allowlist+restart |
| 31 Lane A runtime (spike/host) | complete | passed | G1 npm ci, G2 engine session, G3 no-KVM boot, G4 unit install |
| 32 Lane A host core | complete | passed | L1 VM-backed node run, L2 unit, L3 manifest, L4 quota |
| 33 Lane A dispatch route & approvals | complete | passed | G1–G5 (label wiring, VM dispatch, approvals, push/PR/Done, activations) |

## Suite evidence at tip (`b3ab09b`)

- `bun test`: **3136 pass / 58 skip / 1 fail** — the 1 fail is the recorded F-01 environment-sensitive guard (behavior intact, fails identically on main)
- `pytest`: **246 passed** (miner 52 + dispatcher 194)
- `bunx tsc --noEmit`: clean
- `check:phase-close`: pass — EVENT_KINDS 12 (closed, phase-17 lock), SURFACES 27
- Locks: store-lock, redact-lock, vocabulary-lock, phase-close locks all green

## Requirement coverage

All 68 approved requirements map to phases 16–33 and are implemented on `main`. REQUIREMENTS DESK traceability checkboxes remain Pending per the recorded convention (verified phases 27/28/30 precedent) — flip at operator milestone-acceptance. Live-tail UAT for gated behaviors is tracked per phase in `behavior_unverified` frontmatter and the runbooks listed below.

## Gated remainders ledger (43 items — one operator window set)

Runbooks holding every proof + rollback: `docs/runbooks/production-identity.md` (identity evidence table), `dispatch-proof.md` (NOT RUN), `docs-proof.md`, `hindsight-cache-proof.md`, `mirror-proof.md`, `lane-a-host.md`, phase VALIDATION maps (22, 24, 25, 26, 28, 29, 30, 31, 32, 33). No live step has been executed by an agent; the identity switch (phase 20) ran in an operator-approved window on 2026-10-10 with clean soak.

## Non-goals held

RAGFlow/Hindsight MCP in agent configs (D9/D25-01/D26-01); Hindsight as store of record; new EVENT_KINDS (12 held); Dragonfly as queue/lock; auto-merging skills; agent-side credential handling.

## Late addendum — current-main correction hold (2026-10-12, no archive replay)

This section is additive only. The historical verdict above
(**PASS with recorded gated remainders**, 18/18 phases, 68 requirements,
43 `behavior_unverified` items across 11 phases) stands unchanged as the
archived v1.3 record. Nothing below re-runs, re-seals, re-completes, or
re-archives the milestone, and no requirement checkbox or roadmap state is altered
by this addendum.

**Current end-to-end acceptance: HELD — operator-blocked by explicit user
decision, not waived.** The 43 live-tail behaviors remain historically
unverified. The user explicitly selected Keep real-proof criteria, so full
end-to-end milestone completion stays blocked until real proofs are recorded.
The archived implementation is not full completion, and the original
convention (PASS with gated remainders) is history, not a silent waiver of
the current acceptance bar. Source-complete 18/18 stays historical; no
7-of-18 local checkpoint is presented as current-main status.

**Final parent proof on current `84c8fc1` plus owned corrections (2026-10-12):**

- Full Bun suite: **3,355 pass / 58 skip / 0 fail**,132files. Python:
  **246 passed**. Types exited0; shell syntax/shellcheck remained green.
  Phase-close: **119 pass / 0 fail** in four unchanged lock files;
  EVENT_KINDS12,SURFACES27. These supersede earlier3,199 and3,275 runs.
- Five actual Phase 28 consumer/entry test paths were checked to exist
  before the targeted **385 pass / 0 fail** run; G1–G4 are covered by
  actual subprocess/transport/verifier transitions.
- Final named scratch runtime `v13-seal-8bfdef25`: basic 4/4, proposal
  47/47, ledger **68/68**, desktop 20/20, vocabulary 29/29
  (28 stored/read back, no refusals). The exact existing-leaf proof retains
  its anchor while a valid rehashed chain mismatches the recomputed hour;
  the real CLI exits 1 and names the hour. Up/down exited 0 and removed
  two owned stores. Historical 47/47 and the earlier current run stay
  provenance, not production acceptance.
- Restored earlier owned Phase 19 source (`6f85adb`, source paths only):
  **41/41** current real named-herdr/installed-Muse checks passed.
  Herdr's internal client socket exceeded Unix path capacity under a long
  scratch HOME; a shorter owned private HOME satisfied the actual
  prerequisite. No collector or proof gate was weakened.
- Actual host-client → authenticated scratch MCP/PG/Greptime and actual
  Node guest relay passed **24/24** checks: correct identity, canonical
  grant persistence, fencing, real disk-failure compensation, no guest
  credentials, canonical kickoff registration, terminal public status,
  idle post-release heartbeat and no restart resumption. The trusted
  SDK CLI adapter is emulated; a real VM/engine/model remains unproved.
- Actual Git → CLI → HTTP/audit → pinned docs → restart/readback plus a
  real local-origin fast-forward and real projector link passed **16/16**.
  Dirty/untracked bytes remain unpublished, partial/refused refreshes
  retain the old pin, and successful sync exposes the new committed pin.
  RAGFlow is a loopback contract fixture, not a live external plane.

**Reachable source integration defects — repaired and exercised:**
the host's dual identities, canonical nested grant, fenced release and
guest credential containment now use actual product callers. Both guest
routes share TaskService terminal transitions; failed/released tasks lose
mutation authority, lease loss cancels/unloads the session, and guest
re-registration cannot overwrite canonical step references. The served
docs path now has committed-byte refresh, multipart promotion barriers,
immutable document manifests, last-five retention and truthful pin age.
Conflicting bytes for one URL and corrupt timestamp pins are refused or
dropped; dead hollow-pin helpers and incidental copy/source tests were
removed. Focused native source/security re-reviews closed their findings;
no live proof, risk acceptance or merge-ready verdict is implied.

**Archive continuity:** the old active roadmap was byte-identical to the
existing archived roadmap. Its duplicate active phase routing has been
replaced by archive pointers and this acceptance hold. Native discovery
now returns no active phases and `next_phase: null`, not a false Phase 16
replay. The archive's historical 18/18 phases, 76 plans, 68 requirements
and 43-count ledger remain unchanged; 0 active phases is not 0 completed
archived phases. STATE now carries the separate human-needed acceptance.

**Operator facts — conflict preserved, no acceptance invented:** the
aggregate above claims a switch/soak and scenarios 2+5 passed live, while
archived `20-UAT.md` lines 93–106 and `20-06-SUMMARY.md` say the live tasks
and scenarios were not run. There is also a dated positive window record
in `docs/runbooks/production-identity.md` lines 248–252: staged values
PASS, restart/parity, and soak counts for four surfaces, with hermes,
grok-build and grok-bot idle (no prompts). That later record is preserved,
not suppressed; it does not establish scenario 2+5 receipts, readiness of
every installed client, or a real prompt from every live client. The
evidence owner must reconcile the records. Phase 20 acceptance stays held.

**Separately held beyond the historical 43 count:** MIRROR-08 is explicitly
NOT RUN despite Phase 23's `behavior_unverified: 0`. Its real
Linear/Notion/connector transition proof still needs approval and receipts.
The new Cursor credential disclosure also requires operator rotation;
the historical rotation decline is not a waiver of this incident. No
credential value, new approval, restart or private hostname is recorded.

**Proof + rollback pointers:** isolated fake-chain proof and its additive
rollback live in the Phase 28 archive
(`.planning/milestones/v1.3-phases/28-hourly-anchor-job-and-verify/`,
`28-04-SUMMARY.md` runbook + `28-PROOF-ADDENDUM.md` late status);
per-step live gates in `docs/greptime-ledger.md` (Hourly anchor entry).
The local scratch prerequisite is proved and cleaned up. All L1–L10 live
steps still need separate approval, including read-only steps; L9/L10's
permissive historical wording never overrides the binding plan. Real
production v1.1.4 cadence, external plane/client/tracker/VM/model proofs
and incident rotation remain operator-owned.

**Delivery:** corrections are isolated on `swarm/v13-current-proof-corrections`;
no protected-main merge, auto-merge, force-push or branch deletion was
performed. `ultrathink-ship assess` returned `done: false` through its
deterministic uncommitted-change gate, before any model judge request.
The corrected source is committed locally at `ce1b6d5` (preceded by
`84c8fc1` and `148a50c`); full user-request
acceptance still requires the operator proofs above, so no PR/review/merge
command or `--ignore-gsd` bypass follows that assessment.

**Checkout incident:** exact known child-owned test hunks were copied,
verified and surgically removed from the user checkout; its subsequent
status was empty. A separate child's earlier whole-file restore of
`scripts/greptime-smoke.ts` had an unknown pre-existing diff. Empty status
does not establish no loss for that earlier incident; no such claim is
made. The disclosed Cursor credential remains a separate containment
action for the operator.

### Residual source-artifact check

The older residual register has now been mapped row by row: 36 plan mappings,
98 source/checkpoint tasks and53 previously pending requirement rows. Recorded
reconciliation is not live acceptance. The 53-row subset has 32 isolated
locally evidenced criteria and 21 held compound live criteria; the original
68-requirement score and historical 43-count ledger are not re-sealed.

The user explicitly keeps the consolidated docs contract and supersedes the
older `dry_run`, RAGFlow-backed manifest rebuilding and physical-deletion
source clauses. The implemented API, persisted local manifests and last-five
version manifests remain; all real proof gates remain required.

The named `--ragflow-fixture` and `scripts/docs-smoke.ts` are now implemented
and actually exercised: docs **82/82**, skills **18/18** on explicit required
scratch surfaces, and default basic **4/4**. Up/status/down exited0; every
twin/stand-in stopped and two owned stores were removed per named runtime.
Docs proof covers actual MCP/REST/CLI/Git/ledger, upstream snippet redaction,
exact MCP401, source-bound committed pins, partial/failed/conflicting parts,
exact last-five manifests and skills-not-live pin age/warn-once.

Earlier compiler/175 and194 focused runs, startup refusal,56/62 and72/82
actual failures remain historical evidence. Bounded same-birth entry
qualification and immediate truthful recovery records replaced accidental
startup timing; correct dataset IDs, transport classification, document
selection and real Git staging fixed false proof. No assertion was weakened.
The unchanged tracked-file secret guard now includes all new source files:
a reserved example fixture replaced a production-host-shaped test value.
The existing non-root desktop test passed after only the owned TMPDIR was
made traversable; HOME/XDG/token directories stayed private and host
credentials remained filesystem-masked. No production/model/remote proof,
new approval, archive replay or full milestone acceptance is implied.
