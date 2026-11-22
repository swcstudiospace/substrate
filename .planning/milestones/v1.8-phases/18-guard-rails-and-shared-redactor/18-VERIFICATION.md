---
phase: 18-guard-rails-and-shared-redactor
verified: 2026-11-18T12:21:49Z
status: passed
score: 2/2 roadmap success criteria verified
covered_files: [".planning/milestones/v1.3-phases/18-guard-rails-and-shared-redactor/18-01-PLAN.md", ".planning/milestones/v1.3-phases/18-guard-rails-and-shared-redactor/18-01-SUMMARY.md", ".planning/milestones/v1.3-phases/18-guard-rails-and-shared-redactor/18-02-PLAN.md", ".planning/milestones/v1.3-phases/18-guard-rails-and-shared-redactor/18-02-SUMMARY.md", ".planning/milestones/v1.3-phases/18-guard-rails-and-shared-redactor/18-03-PLAN.md", ".planning/milestones/v1.3-phases/18-guard-rails-and-shared-redactor/18-03-SUMMARY.md", ".planning/milestones/v1.3-phases/18-guard-rails-and-shared-redactor/18-04-PLAN.md", ".planning/milestones/v1.3-phases/18-guard-rails-and-shared-redactor/18-04-SUMMARY.md", ".planning/milestones/v1.3-phases/18-guard-rails-and-shared-redactor/18-CONTEXT.md", ".planning/milestones/v1.3-phases/18-guard-rails-and-shared-redactor/18-RESEARCH.md", ".planning/milestones/v1.3-phases/18-guard-rails-and-shared-redactor/18-VALIDATION.md", "packages/mcp-server/src/redact-adversarial.test.ts", "packages/mcp-server/src/redact-contract.test.ts", "packages/mcp-server/src/redact-lock.test.ts", "packages/mcp-server/src/redact.test.ts", "packages/mcp-server/src/redact.ts"]
covered_digest: "v3:sha256:7d29c87ae7962167cf6b6caf290f661189dcf4f39c74411e19e9cfcf71239469"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: passed
  previous_score: 21/21 must-haves verified (archived 2026-10-11 at ed696ef)
  gaps_closed: []
  gaps_remaining: []
  regressions: []
---

# Phase 18: Guard Rails and Shared Redactor Verification Report

**Phase Goal:** One redactor protects every v1.3 publication path: the collectors, `docs_ingest`, `skills_propose` and anything anchored all import it, and it keeps main's counter exemption.
**Verified:** 2026-11-18 against branch `gsd/autonomous-rerun` at `357d6b15`
**Status:** passed
**Re-verification:** Yes — re-checked against the current tree. The phase directory did not exist under `.planning/phases/`; its artifacts are archived under `.planning/milestones/v1.3-phases/18-guard-rails-and-shared-redactor/`, and those were read as the prior record only, not as evidence.

## Goal Achievement

### Observable Truths

| #   | Truth (roadmap success criterion) | Status | Evidence |
| --- | --------------------------------- | ------ | -------- |
| 1   | main's `redact.ts` redacts every September D-04 pattern, with one test per rule, and still leaves `COUNTER_KEY` counts such as `input_tokens` unredacted. | ✓ VERIFIED | `packages/mcp-server/src/redact.ts`: `RULES` table (~L130-222) holds 39 uniquely named rules (`private-tag` first, `pem`, `tailscale`, `password`, `assignment`, `api-key-lower`, provider shapes, `jwt`, `pk-rk`, …); exported read-only `REDACTION_RULES` (L227). `COUNTER_KEY` (L274-275) and `isCount` (~L285) gate `redactValue` (L291-300), so numeric counts survive. `redact.test.ts` L388 `FIXTURES: Record<RedactionRuleName, …>` gives every rule at least one planted fixture (tsc enforces totality); L461-468 assert 39 unique names and full fixture coverage; L471+ generate four tests per fixture (pattern fires, secret removed with context intact, idempotent, reachable via `redactValue`). Counter tests at `redact.test.ts` L112-180 keep `input_tokens: 1200` and `input_tokens: "1200"`, while a non-numeric value under a count key (`input_tokens: "lin_api_…"`) and a non-finite `NaN` still redact whole. |
| 2   | The skill-content redaction and scan come from the same module, and a repo check fails when any package redacts through anything other than it, so Phases 19, 21, 25 and 28 inherit the shared redactor. | ✓ VERIFIED | `redactSkillContent` (`redact.ts` L634) and `scanSkillFiles` (L741) are defined only in `redact.ts`; no second definition exists in non-test source (the only local `redact` helpers are inside `packages/audit/src/*.test.ts`, which the lock excludes). Parity is pinned by `redact.test.ts` L778-795 (every event rule has a same-name skill rule or a reasoned exclusion; `SKILL_EXCLUSIONS` holds exactly `keypair-array`). The repo lock `packages/mcp-server/src/redact-lock.test.ts` scans `{packages,scripts,infra}/**` (scope L70-100), enforces five rules (import resolution, no second definition, no second marker, no hand-rolled credential-prefix detector, injected seams stay injected), and carries detector self-tests (L615+) that plant offenders. Consumers present: collectors (`packages/collectors/src/{emit,muse,herdr-map,cursor-stop}.ts`, Phase 19), skills propose (`packages/mcp-server/src/skills/propose.ts` L29 imports `redact`, `redactSkillContent`, `scanSkillFiles`; Phase 21), docs ingest/search (`packages/mcp-server/src/docs-ingest.ts`, `docs-search.ts`; Phase 25), anchor/verify paths (`anchor.ts`, `anchor-verify-deps.ts`; Phase 28). The lock runs under the root `bun test` script (`package.json` L23). |

**Score:** 2/2 roadmap success criteria verified (0 behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/redact.ts` | Shared redactor: event rules, `redactValue`, counter exemption, skill redaction and scan | ✓ VERIFIED | Substantive (~36 KB); exports `redact`, `redactValue`, `redactKnown`, `REDACTION_RULES`, `redactSkillContent`, `scanSkillFiles`; imported by ~30+ non-test publication-path modules. |
| `packages/mcp-server/src/redact.test.ts` | One fixture and test set per named rule; counter and parity tests | ✓ VERIFIED | Fixture table keyed by rule name; 4 generated tests per fixture; counter and parity suites. |
| `packages/mcp-server/src/redact-lock.test.ts` | Repo check failing on any second redactor | ✓ VERIFIED | Five enforcement rules over `packages/`, `scripts/`, `infra/`; self-tests plant an offender per rule. |
| `packages/mcp-server/src/redact-contract.test.ts` | Event rule order and docs table match module | ✓ VERIFIED | Order pinned; `docs/redaction.md` rule table must list every event rule. |
| `packages/mcp-server/src/redact-adversarial.test.ts` | Adversarial inputs against per-rule patterns | ✓ VERIFIED | Passes in the targeted run below. |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `skills/propose.ts` | `redact.ts` | import of `redact`, `redactSkillContent`, `scanSkillFiles` (L29) | ✓ WIRED | Redacts before any git or gh call (file header L3). |
| `collectors/src/emit.ts` (and muse, herdr-map, cursor-stop) | `redact.ts` | import of `redact` | ✓ WIRED | Phase 19 publication path. |
| `docs-ingest.ts` | `redact.ts` | import | ✓ WIRED | Phase 25 publication path. |
| `anchor.ts`, `anchor-verify-deps.ts` | `redact.ts` | import | ✓ WIRED | Phase 28 path. |
| `redact-lock.test.ts` | every non-test source under `packages/scripts/infra` | `Bun.Glob` scan + five rules | ✓ WIRED | Passes on the current tree; self-tests prove detection. |

### Data-Flow Trace (Level 4)

Not applicable: this phase delivers a pure transformation module and a static repo check, not a rendered data source.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Redaction rules, per-rule fixtures, counter exemption, skill/event parity, docs contract, repo lock and its detector self-tests | `cd packages/mcp-server && bun test src/redact.test.ts src/redact-contract.test.ts src/redact-lock.test.ts src/redact-adversarial.test.ts` | 295 pass / 1 skip / 0 fail (296 tests, 4 files, 3540 expects) | ✓ PASS |

The single skip is the harness round-trip block in `redact.test.ts`, gated on `SUBSTRATE_REHEARSAL_NAME` by design (it runs only under the rehearsal twin). It is not one of the two roadmap criteria, so it does not block this verdict.

### Probe Execution

No probes declared for this phase (`scripts/*/tests/probe-*.sh` not referenced in the phase artifacts).

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| LANEB-06 | 18-01 … 18-04 (archived plans) | Shared redactor guards every publication path | ✓ SATISFIED | Criteria 1 and 2 above. The requirement ID was declared in the roadmap entry; `.planning/REQUIREMENTS.md` on this branch was not confirmed to list it, so the mapping rests on the roadmap section. |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/redact.ts`, `redact.test.ts`, `redact-lock.test.ts`, `redact-contract.test.ts`, `redact-adversarial.test.ts` | — | Debt-marker scan (`TBD`, `FIXME`, `XXX`, `TODO`) | — | No markers found. |

### Human Verification Required

None. Both criteria are verifiable from the repository and the targeted test run. No live operator action is needed for this phase's goal.

### Gaps Summary

No gaps. The redactor carries the September D-04 rule set with one fixture per rule and the counter exemption, the skill path lives in the same module behind a parity test, and the repo lock rejects any second redactor. Consumers in the Phase 19, 21, 25 and 28 paths import it.

---

_Verified: 2026-11-18T12:21:49Z_
_Verifier: Claude (gsd-verifier)_
