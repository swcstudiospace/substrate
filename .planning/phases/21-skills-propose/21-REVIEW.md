---
phase: 21-skills-propose
reviewed: 2026-10-11T00:00:00Z
depth: standard
files_reviewed: 17
files_reviewed_list:
  - packages/mcp-server/src/skills/propose.ts
  - packages/mcp-server/src/skills/frontmatter.ts
  - packages/mcp-server/src/skills/request.ts
  - packages/mcp-server/src/service.ts
  - packages/mcp-server/src/config.ts
  - packages/mcp-server/src/server.ts
  - packages/mcp-server/src/mcp.ts
  - packages/mcp-server/src/observe.ts
  - packages/mcp-server/src/event-sources.ts
  - packages/audit/src/policy.ts
  - packages/cli/src/skills.ts
  - packages/cli/src/index.ts
  - packages/mcp-server/src/rehearsal-skills.ts
  - packages/mcp-server/src/rehearsal-fake-gh.ts
  - packages/mcp-server/src/rehearsal-env.ts
  - scripts/rehearsal.ts
  - scripts/skills-propose-smoke.ts
findings:
  critical: 0
  warning: 0
  info: 1
  total: 1
status: clean
---

# Phase 21: Code Review Report (native, static only)

**Reviewed:** 2026-10-11 re-audit (static reading; no tests/builds/lint/smoke run by this reviewer)
**Depth:** standard (re-audit of final changed files: `server.ts`, `skills/request.ts`)
**Files Reviewed:** 17
**Status:** clean — 0 BLOCKER, 0 WARNING, 1 INFO (bounded, non-blocking)

## Summary

Final re-audit of the Phase 21 surface (six PLANs 21-01..21-06, requirement SKILL-01)
after the owner's WR-01 fix. The prior WARNING is CLOSED on source evidence plus
parent runtime proof cited below. No new scope invented, no separate checks claimed:
all gate numbers are parent-observed records (`local://v13-final-green-evidence.json`
+ `local://v13-final-runtime-evidence.json`), not reviewer runs. One INFO (IN-01,
suffix-based origin match) is preserved as bounded and non-blocking per parent
direction. No later-phase APIs labeled defective; Phase 22/20 follow-ons (first real
PR, propose.key removal, production tokens) stay excluded per CONTEXT.

## Acceptance verification (grounded)

- **One git path, three doors (D21-06):** route, `skills_propose` tool, and CLI-over-HTTP
  all end in `Substrate.proposeSkill`; CLI imports engine types with `import type` only.
  VERIFIED by reading.
- **Anonymous refused (D21-02):** route 401 before `readBody` (`server.ts` skills block);
  service refuses `surface === null` 401; MCP maps to `isError`; CLI refuses without
  `SUBSTRATE_TOKEN` before posting. VERIFIED. Anonymous exits remain unaudited by design.
- **Attribution = token surface (D21-03/04):** equal/absent accepted, different refused 403
  in service; unknown surfaces 400 in `proposalBodyProblem`. No re-attribution. VERIFIED.
- **Operator-only options (D21-05):** `mode replace` / `reopen` / non-empty
  `allow_doc_examples` refused 403 for non-operators in service. VERIFIED.
- **1 MB cap + status codes (D21-08/09):** `ROUTE_MAX_BYTES = 1_000_000` shared by engine,
  CLI pre-flight, and the route's new `proposalBodySizeProblem` guard, measured on the
  canonical serialized JSON of the caller's body before server-owned attribution (exact-1M
  accepted, over-cap refused 413 before any git work); `BodyTooLargeError` → 413 only on
  `/skills/propose`; `proposalFailure` maps Denied→401/403, Refused→400 with
  `{file,line,rule}` triples, Failed→502 redacted to 400 chars. VERIFIED.
- **Dedupe/declined/unchanged/dry-run (D21-11/16):** `fromLedger` existing/declined/
  re-resolve semantics intact; `unchanged` before commit; `dry_run` skips content lock,
  ledger, `gh`, push, and events. VERIFIED.
- **No-force / argv (D21-12, T-21-01):** `push origin <branch>` only; no force flag,
  colon refspec, or search argv; origin re-checked post-commit pre-push; `execFile`
  argv with 120 s timeout. The kept 7 git controls are the reconciled set per parent
  (21-01 PLAN/CONTEXT/docs); no reviewer change requested. VERIFIED.
- **Child env (D21-15):** allowlisted env with `GIT_CONFIG_*` isolation and credential
  helper pinned to `gh` — documented hardening. VERIFIED, accepted.
- **Secrets (T-21-02/08):** pre-git `scanSkillFiles`, file/line/rule-only findings,
  `refuseSecretText` on paths/ids, redact-before-cap PR body, NUL refused pre-git.
  VERIFIED.
- **Fail-closed audit (D21-18, T-21-07):** route audits under `skills_propose` before
  shape-check and any git work, 503 on denial; `FAIL_CLOSED_TOOLS`, `KNOWN_TOOLS`,
  `KNOWN_ROUTES` registrations intact; WR-01 gap closed (see below). VERIFIED.
- **Config file:// rule, no crash (D21-13):** `problem` string (never throws), service
  refuses all proposals incl. dry_run, boot warning. VERIFIED.
- **Fixture isolation (D21-21):** runDir-scoped state, stale-mirror guard, recording
  fake `gh` (create/view/list-head only), deny-non-FF bare library, redirected HOME,
  `refuseSmokeUrl`, consumer.env-only smoke. Real git, recorded gh. VERIFIED.

## Closed findings

### WR-01 (CLOSED): Non-object route bodies skipped the fail-closed audit

**Was:** `packages/mcp-server/src/server.ts` skills route — non-object 400s and the
wire-cap 413 exited without an audit record.
**Fix verified in source (owner's correction):**
- Non-object bodies now audit a shape-only descriptor before the 400
  (`server.ts` skills block): `auditBody = fields ?? { malformed: true, kind:
  Array|typeof, ...(string ? { bytes } : {}) }` — never the body itself.
- Wire-cap oversize now audits `{ oversize: true }` in the `BodyTooLargeError`
  branch before the 413; invalid-JSON audits `{ malformed: true, kind: "syntax" }`
  before its 400. Comments state the shape-only rationale (re-reading an oversize
  body would re-introduce the DoS the cap prevents). Anonymous pre-body 401 stays
  unaudited by design (D21-02).
- Canonical-size guard `proposalBodySizeProblem` (`skills/request.ts`) measures the
  caller's serialized JSON before attribution; message matches the CLI pre-flight.
**Parent runtime proof (not a reviewer run):** `local://v13-final-runtime-evidence.json`
`invalid_audit_after` — array/null/string 400s each audit 22→23/23→24/24→25 and
oversize 413 audits 25→26 (each NOW exactly one safe audit record, before 0);
skills smoke 47/47; final full suite 2719pass/58skip/0fail, types 0, phase-close
108/0. CLOSED.

## Info (preserved, non-blocking)

### IN-01: `originMatches` accepts any host via slug suffix

**File:** `packages/mcp-server/src/skills/propose.ts` — `originMatches()`
**Issue:** A remote matches when its normalized URL merely ends with `/<slug>` or
`:<slug>` (inherited September/`worktree.py` semantics). Backstopped by the config
`file://` rule (non-file non-default remotes refused before the proposer runs), so
exploitability requires already-hostile operator env/host state — hence INFO, bounded,
non-blocking. No change made or requested by this reviewer; owner's hardening sketch
from the prior review remains available for a future parent decision.

---

_Reviewed: 2026-10-11_
_Reviewer: Phase21NativeReview (gsd-code-review, static re-audit)_
_Evidence discipline: no checks executed; all gate numbers are parent/shared records._
