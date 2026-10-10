---
phase: 19-lane-b-collectors
verified: 2026-10-10T00:00:00Z
status: passed
score: 5/5 must-haves verified
covered_files: [".planning/REQUIREMENTS.md", ".planning/phases/19-lane-b-collectors/19-01-PLAN.md",
  ".planning/phases/19-lane-b-collectors/19-01-SUMMARY.md", ".planning/phases/19-lane-b-collectors/19-02-PLAN.md",
  ".planning/phases/19-lane-b-collectors/19-02-SUMMARY.md", ".planning/phases/19-lane-b-collectors/19-03-PLAN.md",
  ".planning/phases/19-lane-b-collectors/19-03-SUMMARY.md", ".planning/phases/19-lane-b-collectors/19-04-PLAN.md",
  ".planning/phases/19-lane-b-collectors/19-04-SUMMARY.md", ".planning/phases/19-lane-b-collectors/19-05-PLAN.md",
  ".planning/phases/19-lane-b-collectors/19-05-SUMMARY.md", ".planning/phases/19-lane-b-collectors/19-CONTEXT.md",
  ".planning/phases/19-lane-b-collectors/19-PROOF.md", ".planning/phases/19-lane-b-collectors/19-REVIEW-DISPOSITION.md",
  ".planning/phases/19-lane-b-collectors/19-REVIEW-FIX.md", ".planning/phases/19-lane-b-collectors/19-REVIEW.md",
  ".planning/phases/19-lane-b-collectors/19-SECURITY.md", ".planning/phases/19-lane-b-collectors/19-VALIDATION.md",
  ".planning/phases/19-lane-b-collectors/COVERAGE.md", "docs/collectors.md", "docs/runbooks/lane-b-collectors.md",
  "infra/vps/substrate-collector-herdr.service", "infra/vps/substrate-collector-muse.service",
  "packages/collectors/src/cursor-stop.ts", "packages/collectors/src/emit.ts", "packages/collectors/src/git-context.ts",
  "packages/collectors/src/grok.ts", "packages/collectors/src/herdr-map.ts", "packages/collectors/src/herdr-state.ts",
  "packages/collectors/src/herdr.ts", "packages/collectors/src/muse.ts", "packages/collectors/src/status.ts",
  "packages/projector/src/cursor.ts", "packages/projector/src/muse.ts", "scripts/laneb-proof.test.ts",
  "scripts/laneb-proof.ts"]
covered_digest: "v3:sha256:92ad0bc0d67a3d677c96031857a60f93d430a1e5ab99f26e5d8ff033bd7d752b"
behavior_unverified: 0
overrides_applied: 0
---

# Phase 19: Lane B collectors Verification Report

**Phase Goal:** What herdr panes, Muse and Cursor sessions do on this host reaches the event log under main's vocabulary from code on `main`, and every Muse repo carries a fresh, redacted brief.
**Verified:** 2026-10-10
**Status:** passed
**Re-verification:** No — initial verification (validates the corrected real-runtime lineage, not the superseded fixture-only run)

**Evidence standard for this report.** This verifier ran no tests, builds, lint, smoke, gates, scripts, or live probes — only read-only source inspection plus the single permitted metadata query (`verification.fingerprint`, digest above). Every runtime tally below is **parent-observed** evidence from `local://v13-phase19-real-runtime-evidence.json` (transcribed in `19-PROOF.md`), attributed to the parent, not to this verifier. Source citations are verifier-observed.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | ------- | ---------- | -------------- |
| 1 | A herdr pane going working → idle in repo R appears in `events_query(repo=R)` within 10 s as a `note` with `payload.status` and `runtime: herdr`, under the surface herdr detected and R's origin slug; detection and exit appear as `session.start` / `session.end` | ✓ VERIFIED | Source: `herdr.ts:202-212` snapshot→reconcile→emit pass, `:311-313` `session.snapshot`, `:357` `events.subscribe`; parent real proof 41/41 drove `workspace.create` → `report_agent` working → own collector stop/restart → `report_agent` idle → `pane.close` on a proof-owned `substrate-proof-*` herdr 0.9.1 session, each of start/note/end observed within 10 s of its own action (`laneb-proof.ts:453-503`, `pollFor` remaining-deadline `:110-117`) |
| 2 | A Muse tool call in R appears as `tool.call` from surface `muse` with repo and branch from git, emitted by a hook importing the redactor from a stable installed path | ✓ VERIFIED | Source: bundle writes `hooks/redact.ts` byte-copied with commit+sha256 header (`projector/src/muse.ts:281-286,300-302`), hook imports `./redact.ts` (`:106`), config is path-only (`:119-122`, token-collision refusal `:290-291`); parent proof ran real scratch-HOME `validate` / `install-or-update` / `approve` / `inspect` (`trusted_enabled`), installed redactor/config readback, and the real installed `muse plugins hook test substrate:post-tool-use --fixture` CLI (`laneb-proof.ts:515-619`), with pre-execution URL-equality guard (`assertHookTarget`, `:138-141,:571-575`) |
| 3 | R's `.substrate/BRIEF.md` lists both events on its next 5-minute refresh, `AGENTS.md` keeps exactly one pointer however often the writer runs, and a failed `/brief` fetch leaves the last good file in place | ✓ VERIFIED | Source: redacted write `writeIfChanged(briefPath, redact(...))` (`muse.ts:390`), byte-identical preservation on failure (`:360`), `ensurePointer` (`:239-256`), ledger gate with bearer (`:158-159`); parent proof asserted real-store BRIEF listing note+tool.call, five reruns leave one pointer, closed-port run byte-identical; G19-06 behavioral tests over real loopback I/O (`muse.test.ts:683-736`) |
| 4 | A stopped substrate never blocks herdr, Muse or Cursor; collectors resume from saved offsets after a restart; refused emits are counted where the operator can see them and are zero in the proof run | ✓ VERIFIED | Source: `postEvent` never throws, 202=stored / 4xx=refused+recorded / 5xx+timeout=failed (`emit.ts:134-167`), timeouts 3000/1500 ms, `recordRefusal` fixed 7 keys no summary/payload (`:89-114`), hook exit-0/empty-stdout (`cursor-stop.ts:259`, `projector/src/muse.ts:237-247` WR-02 fix); parent proof: fail-open dead-URL hooks exit 0, own watching-collector restart emits no duplicate start, `collectors:status` reports **zero refused** (`laneb-proof.ts:699-706`) |
| 5 | Cursor's `stop` hook, run from `main`, copies a redacted transcript to `/var/lib/substrate/transcripts/cursor` and emits `session.end` | ✓ VERIFIED | Source: realpath containment, `O_NOFOLLOW`+fstat regular-file check (`cursor-stop.ts:74-126`), 20 MB cap, 0700 dir / 0600 file tmp+rename (`:139-175`), `redact()` over text (`:153`), `session.end` surface `cursor` actor `human` with `conversation_id`/`transcript_ref`/`status`/`reason` (`:184-219`); parent proof ran the synthetic stop against the real store: redacted 0600 copy + repo-filtered `session.end` observed (`laneb-proof.ts:646-668`) |

**Score:** 5/5 truths verified (0 present-but-behavior-unverified — every behavior-dependent truth has parent-observed real-runtime behavioral evidence, not presence alone)

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | ----------- | ------ | ------- |
| `packages/collectors/src/herdr.ts` + `herdr-state.ts` + `herdr-map.ts` | Snapshot-reconciled collector, v2 offsets, pinned agent→surface table | ✓ VERIFIED | Substantive (snapshot/subscribe/reconcile/dedupe present); wired (proof spawns the real collector child; mapper asserted by vocab locks) |
| `packages/collectors/src/emit.ts` + `git-context.ts` + `status.ts` + `grok.ts` (shared emit) | Fail-open outcomes, origin-slug attribution, refused counting + read-only status | ✓ VERIFIED | Substantive; wired (all collectors + generated hook consume it) |
| `packages/collectors/src/muse.ts` | Redacted brief writer, one pointer, ledger gate, failure accounting | ✓ VERIFIED | Substantive; wired (proof `--once`/watch pass against real store) |
| `packages/projector/src/muse.ts` | Bundle with byte-copied redactor, path-only config, validate/install/approve, `--check`/`--bundle-only` | ✓ VERIFIED | Substantive; wired (proof invokes the real projector in default install mode under scratch HOME) |
| `packages/collectors/src/cursor-stop.ts` + `packages/projector/src/cursor.ts` stop entry | Hardened stop hook + byte-identical desired hook string | ✓ VERIFIED | Substantive; wired (proof synthetic stop posts to real store) |
| `scripts/laneb-proof.ts` + `scripts/laneb-proof.test.ts` | Real named-herdr + installed-Muse proof with guards (41 checks) and guard unit tests | ✓ VERIFIED | Real-runtime driver (no fixture stub in current lineage: `herdr --session substrate-proof-* server`, installed `hook test`); guard tests pin budgets/ownership/target/env |
| `infra/vps/substrate-collector-{herdr,muse}.service` (+ drop-ins) | Ported units, collector-only env, state paths | ✓ VERIFIED | Static syntax `systemd-analyze verify` exit 0 (parent-observed); install/restart NOT performed — operator window |
| `docs/collectors.md` + `docs/runbooks/lane-b-collectors.md` | Topic doc + six-step operator cutover runbook with rollback | ✓ VERIFIED | Present; static review (docs task acceptance is inspection, not a behavioral test — recorded, not disguised) |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | --- | --- | ------ | ------- |
| herdr collector | `POST /events` | shared `postEvent` fail-open emit | WIRED | Call sites `herdr.ts:131,219-240` |
| herdr pushes | snapshot reconcile | push→dirty, debounced single-flight pass + 5 s timer | WIRED | `herdr.ts:148-186,205-212,311-315` |
| Muse hook | `POST /events` | inline fail-open emit, 1.5 s timeout, refusal file | WIRED | Template `:206-225`, `recordRefusal :168-190`; real installed hook-test posted `tool.call` in proof |
| Muse writer | `POST /brief` + `GET /healthz` | bearer-carrying fetch, ledger gate | WIRED | `muse.ts:158-159,362-390`; WR-fix bearer consistency landed |
| cursor-stop | `POST /events` + transcripts dir | shared emit + redacted 0600 copy | WIRED | `cursor-stop.ts:139-175,247-259` |
| projector | installed bundle/cache | exact bytes + sha256 drift check | WIRED | `projector/src/muse.ts:354-393,410-425`; proof readback equality |
| proof | harness twin | `consumer.env` only, refuse 7410/non-loopback/install mismatch | WIRED | Guards `:352-355`, `assertHookTarget`, `isProofSession` |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| herdr events | repo/branch/status | pane `cwd`→origin slug, `agent_status` from live snapshot | ✓ FLOWING | Real named-server panes in proof carried run-tagged slug |
| Muse `tool.call` | repo/branch/tool | git in hook cwd + envelope `tool_name` | ✓ FLOWING | Installed hook-test in R returned slug/branch |
| BRIEF.md | brief body | `POST /brief` 2xx non-empty → `redact()` → file | ✓ FLOWING | Real-store brief listed both proof events |
| refused-emits.jsonl | refusal lines | 4xx responses only, fixed keys, no payload | ✓ FLOWING | Zero lines in proof (zero refused); shape asserted by exact-key tests |

### Behavioral Spot-Checks

Not run by this verifier (contract: SKIP all tests/scripts; parent owns execution). Behavioral evidence is parent-observed and recorded here by attribution:

| Behavior | Parent command | Result | Status |
| -------- | ------------- | ------ | ------ |
| Real proof e2e | `bun run proof:laneb` (proof-owned twin, owned HOME/XDG/TMPDIR) | 41/41, exit 0, tag `p19-mv2i83ok`, zero refused, operator cache paths unchanged, own cleanup done | ✓ PASS (parent-observed) |
| Final targeted union | 6-file behavioral union after parked-agent correction | 85/0, exit 0 | ✓ PASS (parent-observed) |
| Types | `check` (`tsc --noEmit`) | exit 0 | ✓ PASS (parent-observed) |
| Vocabulary locks | `check:phase-close` | 112/0, 12 kinds / 27 surfaces | ✓ PASS (parent-observed) |
| Full suite | `bun test` | 2670/58/0 across 96 files | ✓ PASS (parent-observed; 58 skips preserved as skips, not proof) |
| Unit syntax | `systemd-analyze verify` on both current unit files | exit 0 | ✓ PASS (parent-observed; syntax only, not installation) |

### Probe Execution

No phase-declared `probe-*.sh` files; `scripts/laneb-proof.ts` is the phase's executable proof (covered above). No separate probe table applies.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| LANEB-01 | 19-02, 19-05 | herdr collector runs from main: snapshot bootstrap, per-connection subscribe, 5 s reconcile, dedupe offsets, fail-open POST | ✓ SATISFIED | Real collector process + restart in proof; timer/reconnect/recovery tests green |
| LANEB-02 | 19-02, 19-05 | Main vocabulary: agent surface, origin-slug repo, start/note/end with status+runtime | ✓ SATISFIED | Pinned enum + wire-spelling mapper tests; real pane attribution in proof |
| LANEB-03 | 19-03, 19-05 | Brief writer per repo: redacted BRIEF.md, one pointer, 5-min refresh, last-good on failure | ✓ SATISFIED | Writer tests + real-store BRIEF in proof; degraded-200 race documented, not hidden |
| LANEB-04 | 19-04, 19-05 | Muse plugin projected/validated/approved; PostToolUse `tool.call` with git repo/branch, stable installed redactor path | ✓ SATISFIED | Real scratch install/approve/inspect + installed hook-test in proof; no model turn (explicit opt-out) |
| LANEB-05 | 19-01, 19-05 | Never blocks; offsets survive restart; refused emits operator-visible | ✓ SATISFIED | Never-throw emit + bounded timeouts; real restart; zero-refused proof |
| LANEB-07 | 19-05 | Isolated proof: working→idle + tool call in R within 10 s, zero refused, BRIEF lists both | ✓ SATISFIED | Parent 41/41 real-runtime proof (supersedes fixture-only 27/27, whose stub substitutions are withdrawn, not deleted) |
| SKILL-06 | 19-03, 19-05 | Cursor stop hook from main: redacted transcript copy + `session.end` | ✓ SATISFIED | Hardened-hook tests + real-store synthetic stop in proof; operator-installed hook currency remains M19-01 |

Orphaned requirements: none — all seven Phase 19 IDs were claimed and are covered.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| — | — | No TBD/FIXME/XXX, placeholders, empty returns, hardcoded-empty render data, or stdout-leaking hooks found in reviewed scope | — | None — iteration-2 review status `clean` (1 info seam IN-01, no fix) |

Debt-marker gate: no `TBD`/`FIXME`/`XXX` markers encountered in phase-touched files. Clean.

### Security posture (recorded, not self-accepted)

`19-SECURITY.md`: 18/20 CLOSED, **2 OPEN non-blocking low** (T-19-04 reserved-counter compatibility, T-19-19 tagged-evidence — both plan-proposed `accept` with **no documented acceptance entry**; this verifier does not accept them, invent an approver/date, or borrow acceptance from another phase). **Zero blocking-open** at the `block_on: high` gate → SECURED for the enforcing gate. Global Cursor credential rotation is **operator-pending** (contained by scratch fixture, not revoked) — a global operator action, explicitly not an eighth Phase 19 requirement and not marked done.

### Operator follow-ups (outside isolated proof per D19-24 — not blockers, not human-verification gates)

- M19-01: production unit install/restart, user-scope Muse projection, `/root/.cursor/hooks.json` currency — operator window after merge per `docs/runbooks/lane-b-collectors.md`. Historical operator cutover receipts keep their recorded actor/date; nothing here claims a new production action.
- M19-02: optional real Muse model turn — unperformed, explicitly not required for isolated acceptance.
- M19-03: global Cursor credential rotation — pending, outside the authored register counts.
- Public delivery status: branch verification only. This report makes no main-shipping, milestone-completion, merge-ready, or signed-security-gate claim. Production cutover and model/credential actions were never performed by the parent and are not represented as done.

### Gaps Summary

No gaps. All five roadmap success criteria verify against source plus parent-observed real-runtime evidence (fresh 41/41, not the superseded fixture-only 27/27). Iteration-2 review is clean with all three actionable findings closed on exact source evidence; validation is `nyquist_compliant: true` with 15/15 tasks and 7/7 IDs mapped. Skipped tests (58) are preserved as skips. Two low unaccepted plan-dispositions and the pending operator rotation are recorded above without self-acceptance and do not fail the enforcing gates.

---

_Verified: 2026-10-10_
_Verifier: Claude (gsd-verifier, Phase19GoalVerifier)_
_Evidence: parent-observed `local://v13-phase19-real-runtime-evidence.json` + read-only source inspection; digest `v3:sha256:92ad0bc0d67a3d677c96031857a60f93d430a1e5ab99f26e5d8ff033bd7d752b`_
