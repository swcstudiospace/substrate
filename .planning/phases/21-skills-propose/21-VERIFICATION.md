---
phase: 21-skills-propose
verified: 2026-10-11T00:00:00Z
status: passed
score: 18/18 must-haves verified
covered_files: [".env.example", ".planning/phases/21-skills-propose/21-01-PLAN.md", ".planning/phases/21-skills-propose/21-01-SUMMARY.md", ".planning/phases/21-skills-propose/21-02-PLAN.md", ".planning/phases/21-skills-propose/21-02-SUMMARY.md", ".planning/phases/21-skills-propose/21-03-PLAN.md", ".planning/phases/21-skills-propose/21-03-SUMMARY.md", ".planning/phases/21-skills-propose/21-04-PLAN.md", ".planning/phases/21-skills-propose/21-04-SUMMARY.md", ".planning/phases/21-skills-propose/21-05-PLAN.md", ".planning/phases/21-skills-propose/21-05-SUMMARY.md", ".planning/phases/21-skills-propose/21-06-PLAN.md", ".planning/phases/21-skills-propose/21-06-SUMMARY.md", ".planning/phases/21-skills-propose/21-BASELINE.md", ".planning/phases/21-skills-propose/21-CONTEXT.md", ".planning/phases/21-skills-propose/COVERAGE.md", "docs/event-vocabulary.md", "docs/mcp-audit.md", "docs/rehearsal.md", "docs/skills-propose.md", "packages/audit/src/policy.test.ts", "packages/audit/src/policy.ts", "packages/cli/src/index.ts", "packages/cli/src/skills.test.ts", "packages/cli/src/skills.ts", "packages/mcp-server/src/config.test.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/event-sources.ts", "packages/mcp-server/src/http.test.ts", "packages/mcp-server/src/mcp.test.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/observe.test.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/rehearsal-env.test.ts", "packages/mcp-server/src/rehearsal-env.ts", "packages/mcp-server/src/rehearsal-fake-gh.ts", "packages/mcp-server/src/rehearsal-skills.test.ts", "packages/mcp-server/src/rehearsal-skills.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/skills/frontmatter.ts", "packages/mcp-server/src/skills/propose.git.test.ts", "packages/mcp-server/src/skills/propose.test.ts", "packages/mcp-server/src/skills/propose.ts", "packages/mcp-server/src/skills/request.test.ts", "packages/mcp-server/src/skills/request.ts", "scripts/rehearsal.test.ts", "scripts/rehearsal.ts", "scripts/skills-propose-smoke.test.ts", "scripts/skills-propose-smoke.ts"]
covered_digest: "v3:sha256:bd02a26cad319c296b1556e6065326515aacb8738b179c2a3cc074f8c84e4f7b"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: passed
  previous_score: 24/24
  gaps_closed: []
  gaps_remaining: []
  regressions: []
---

# Phase 21: skills_propose Verification Report

**Phase Goal:** Any authenticated surface can propose a skill and get a reviewable PR on `swcstudiospace/agent-skills`, and nothing secret, malformed or duplicate gets through.
**Verified:** 2026-10-11 (native source-first re-verification; no tests/builds/gates executed by verifier — all execution numbers are parent-observed receipts cited, not claimed)
**Status:** passed
**Re-verification:** Yes — prior 2026-10-09 report (24/24, passed) refreshed against current source, current audit reports, and final parent evidence. No prior gaps existed; no regressions found.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | SC1/SKILL-01: `skills_propose` over MCP, `POST /skills/propose`, and `substrate skills propose` accept a valid skill from a token surface and open branch `skill/<surface>/<name>-<ts>-<hex>` with a PR through `gh`, after checking the origin, without force-pushing | ✓ VERIFIED | `server.ts:781` and `mcp.ts:919` both end in `Substrate.proposeSkill`; CLI posts to `/skills/propose` (`skills.ts:215`). Branch builder `propose.ts:387-389` emits exactly `skill/<surface>/<name>-<ts>-<hex>` (UTC ISO + 4 hex). `pushArgv` (`propose.ts:435-437`) is `git push origin <branch>` only — no force flag, colon refspec, or search argv in any builder. Origin re-checked post-commit pre-push (`propose.ts:1015-1016`). Parent isolated proof: 47/47 smoke with `opened` on all three doors, real git, recording gh. |
| 2 | SC1: the library never sees a non-fast-forward | ✓ VERIFIED | Fixture sets `receive.denyNonFastForwards` + `receive.denyDeletes` (`rehearsal-skills.ts:86-87`); smoke asserts creation-only reflog; real-git tests assert prohibited update/delete attempts leave refs unchanged (`propose.git.test.ts:269-292`). Threat T-21-15 closed in 21-SECURITY.md. |
| 3 | SC2/SKILL-01: a bad name, path, or frontmatter is refused | ✓ VERIFIED | `validateProposal` revalidates names/paths/NUL/conflicts/frontmatter/removals (`propose.ts:147-290`); confined tree write refuses symlink ancestors (`propose.ts:321-382`). Parent smoke: bad name, `..` path, missing/mismatched frontmatter each refused with no branch and no `gh` call. |
| 4 | SC2/SKILL-01: a planted secret is refused after redaction and scan, with a finding naming file, line, and rule, and the value appears nowhere | ✓ VERIFIED | `scanSkillFiles` runs pre-git (`propose.ts:262`); findings project file/line/rule only (`redact.ts:676-702`, `request.ts:99-108`); PR rationale whole-text redacted before truncation (`propose.ts:507-537`). Parent smoke: 400 with `{file: SKILL.md, line, rule: github}`; value absent from response, ledger, events, audit, gh calls, library refs. T-21-02/T-21-14 closed. |
| 5 | SC2/SKILL-01: identical content answers `existing`, `declined`, or `unchanged` — never a second PR | ✓ VERIFIED | Ledger idempotence: OPEN → `existing`, owner-CLOSED → `declined` (unless reopen), pushed-without-PR re-resolved via `gh pr list --head`, content-equal-to-main → `unchanged` before commit/push (`propose.ts:811-917,1011`); per-content lock serializes concurrent identical proposals. Parent smoke exercised the existing→declined→unchanged sequence with no second push/PR. |
| 6 | SC3: an anonymous call is refused on every door, before the body is read | ✓ VERIFIED | Route refuses `surface === null` with 401 before `readBody` (`server.ts:751-755`); service refuses null caller even with operator flag (`service.ts:1260-1262`); MCP maps to `isError` (`mcp.ts:920-924`); CLI exits 1 without `SUBSTRATE_TOKEN` before posting (`skills.ts:166`). T-21-06/T-21-18 closed. |
| 7 | SC3: the tool is registered in `mcp.ts`, `observe.ts`, and the audit policy (fail-closed) | ✓ VERIFIED | `mcp.ts:881` registers `skills_propose`; `observe.ts:62` lists `/skills/propose` and `:345` lists `skills_propose`; `policy.ts:27` explicitly lists it fail-closed; route audits via `auditedRest` under its own name before shape-check and any git work (`server.ts:765,802,816`). G2 (MCP audit denial → JSON-RPC -32000, no proposer) filled per 21-VALIDATION.md. |
| 8 | D21-01: only a surface token authenticates; September's propose key and `propose-auth.ts` are not ported | ✓ VERIFIED | No `propose-key`/`propose-auth`/`x-substrate-propose-key` in code or scripts (one docs line states the header is gone). Bearer→surface/operator resolution precedes all doors (`config.ts:475-510`, `server.ts:401-419`). |
| 9 | D21-03/04/05: proposal surface is the token's surface (mismatch 403, never re-attributed); any authenticated surface may propose; `mode replace` / `reopen` / `allow_doc_examples` need an operator token | ✓ VERIFIED | Service gates: mismatch 403 (`service.ts:1263-1268`), surface forced from caller (`service.ts:1285-1290`), per-privilege 403 for non-operators (`service.ts` privileged list + operator check), invalid-library refusal before engine (`service.ts:1279-1281`). Swarm and `substrate` host surfaces accepted; no per-surface allowlist. |
| 10 | D21-06/07/10: one service method is the only code reaching git/gh; the CLI is HTTP-only with `import type` and no `--surface` flag | ✓ VERIFIED | Route, tool, CLI all end in `Substrate.proposeSkill`; `skills.ts:24` imports engine types only (`import type` — redact-lock green); CLI refuses `--surface`, requires `SUBSTRATE_TOKEN`, posts no event of its own. T-21-10 closed. |
| 11 | D21-08/09: one 1 MB cap everywhere; exact route/MCP status codes | ✓ VERIFIED | `MAX_BODY_BYTES = 1_000_000` (`server.ts:203`); canonical caller-JSON guard before attribution (`request.ts:52-66`, `server.ts:774-782` → 413); MCP pre-attribution check (`mcp.ts:910-919`); CLI JSON preflight (`skills.ts:205-211`); `BodyTooLargeError` → 413 only on this route. 200 per status; 400 findings; 401/403; 502 redacted to 400 chars; 503 on audit denial. G3 exact-1M/1M+1 UTF-8 assertions filled. |
| 12 | D21-11: `dry_run` on all three doors validates/redacts/clones/diffs with no push, no `gh`, no ledger write, no event — still audited | ✓ VERIFIED | Engine skips content lock/ledger/gh/push and returns staged diff (`propose.ts:972,1006-1008`); service emits nothing on dry_run; route still audits. G7 (existing-content dry-run: clone/diff, no gh/push/ledger change) filled with real-git staged counts. |
| 13 | D21-12–16: engine port fidelity; configurable library with `file://` rule and no-crash refusal; 4-base-plus-7-fixed Git child env (user-selected); September ledger compat | ✓ VERIFIED | Port order preserved (validate → locks → ledger → fetch → clone → write → commit → origin check → push → `gh pr create` → `opened`, clone removed in `finally`). Config: non-default repo/remote only with `file://` + absolute non-default gh (`config.ts:232-245`); `problem` warns at boot and refuses every proposal without throwing. Child env is exactly PATH/HOME/no-prompt flags + `GIT_CONFIG_GLOBAL/SYSTEM=/dev/null`, `COUNT=2` gh-helper selection (`propose.ts:560-576`) — user-selected Keep-current-Git-isolation reconciled in PLAN/CONTEXT/docs; G4 real-child isolation filled. Ledger keeps September `proposals.jsonl` shape; missing `mirror.git` refuses naming mirror + bootstrap before any Runner call. |
| 14 | D21-17/18: Phase-17 events fail-open with exact rows incl. `skills.propose.failed`; fail-closed audit precedes all git work | ✓ VERIFIED | Outcome `note` (caller surface, configured repo, `action: skill.propose`); refused/failed `warning`s with rule names only; dry_run/anonymous/403/malformed-shape emit nothing; emit failure never changes the answer. G1 (non-object/malformed/oversize audited via safe shape-only descriptors; 503/no-proposer on denial; parent runtime readback array→23/null→24/string→25 at 400, oversize→26 at 413) filled — WR-01 resolved by owner fix, not waived. |
| 15 | D21-19: contract docs with pointers and header comments | ✓ VERIFIED | `docs/skills-propose.md` covers doors/auth/codes/caps/file-rule/Git isolation; pointers in `mcp-audit.md`, `event-vocabulary.md`, `rehearsal.md`, `.env.example`; header comments list route/command. Drift: COVERAGE.md (`--state open`) vs shipped `--state all` recovery argv explicitly recorded in 21-06-SUMMARY amendment per plan — disclosed, not claimed matching (T-21-16 closed on that basis). |
| 16 | D21-20/21/22/23: unit coverage with injected seams; isolated harness fixture; 47/47 smoke; baseline comparison | ✓ VERIFIED | Ported `propose.test.ts` + real-git `propose.git.test.ts`, route/MCP/CLI/registration/event-row tests; no test calls real `gh`. Fixture: run-dir state, throwaway bare repo + `mirror.git` (fetch refspec main-only), recording `gh` (create/view/list-head only), `down` removes everything. Parent final proof (`v13-proof-230c1bd0`): up 0 → skills 47/47 exit 0 → down 0, two owned store containers removed. Baseline discipline retained in 21-BASELINE.md. |
| 17 | COVERAGE gh surface + locks green, no new dependency | ✓ VERIFIED | Only `pr create` / `pr view` / `pr list --head` argv builders; recording `gh` refuses the rest; merge/close/search/force-push reasoned OPT-OUTs. Parent final: locks 108/0 exit 0 (store/vocab/redact unchanged), types exit 0, `bun.lock` unchanged by this phase. |
| 18 | Gate reports: review clean (21), security high-gate SECURED, validation G1–G8 closed with D1–D11 applied | ✓ VERIFIED | 21-REVIEW.md: 0 critical / 0 warning / 1 info (IN-01 suffix-match, bounded non-blocking). 21-SECURITY.md: 19/20 CLOSED, `threats_open = 0` at block_on high; the single OPEN is T-21-SC **low proposed-accept with no acceptor/date — NOT an authorized acceptance**, disclosed below. 21-VALIDATION.md: G1–G8 FILLED, D1–D11 deleted-not-repinned, `validated` / `nyquist_compliant`. Parent final source union after D11 deletion: **2718 pass / 58 skip / 0 fail, 96 files, exit 0** (preceding 2719/58/0 was the real earlier run, not inferred). |

**Score:** 18/18 truths verified. SKILL-01 fully met in isolated scope.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| SKILL-01 | 21-01…21-06 | Three-door propose with validation, redaction/scan refusal, content-hash dedupe, `skill/<surface>/<name>-<ts>-<hex>` branch + PR via `gh` with origin check and no force-push; surface-token auth; registration in `mcp.ts`/`observe.ts`/audit policy | ✓ SATISFIED (isolated scope) | Truths 1–18 above; parent 2718/58/0 + 47/47 + locks 108/0 + types 0 |

No orphaned requirements: REQUIREMENTS.md maps only SKILL-01 to Phase 21, and all six plans claim it.

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| route / tool / CLI | `Substrate.proposeSkill` | direct call / HTTP POST | WIRED | `server.ts:781`, `mcp.ts:919`, `skills.ts:215` |
| `proposeSkill` (service) | engine `SkillProposer` | constructor `stores.skills` seam | WIRED | `service.ts:676-677`, config-driven library |
| engine | Phase 18 `redact.ts` | `redactSkillContent`, `scanSkillFiles` imports | WIRED | `propose.ts:29`, scan at `:262` |
| engine | git / `gh` children | `execFile` argv + allowlisted `childEnv` | WIRED | `propose.ts:550-598`, origin check `:1015-1016`, push `:1018` |
| route | fail-closed audit | `auditedRest(…, "skills_propose", …)` before shape/git | WIRED | `server.ts:765,802,816` |
| service | events | `emit` fail-open, exact `EVENT_SOURCES` rows | WIRED | `service.ts:1308-1350`, `skills.propose.failed` row |
| CLI | engine types | `import type` only (no runtime path) | WIRED | `skills.ts:24` |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| smoke opened PR | branch in throwaway repo + recorded `gh pr create` | real `git` + recording `gh` in fixture | Yes (parent 47/47) | ✓ FLOWING |
| refusal findings | `{file, line, rule}` | `scanSkillFiles` pre-git | Yes, value-free | ✓ FLOWING |
| audit records | `skills_propose` entries incl. malformed/oversize descriptors | `auditedRest` pre-dispatch | Yes (parent readback +1 per attempt) | ✓ FLOWING |
| events | note/warning rows with `action: skill.propose` | service `emit` | Yes (parent `/events/query` readback) | ✓ FLOWING |

### Behavioral Spot-Checks

Step 7b SKIPPED by contract: verifier executes no commands beyond the metadata-only fingerprint query. Behavior is evidenced by parent-exercised gates cited (not re-run): full suite 2718/58/0, types 0, locks 108/0, isolated skills smoke 47/47, up/down 0.

### Probe Execution

No phase-declared `probe-*.sh` exists for Phase 21; the phase proof is the `smoke:skills-propose` script (parent-exercised 47/47). No probe substitution claimed.

### Anti-Patterns Found

| File | Pattern | Severity | Impact |
|------|---------|----------|--------|
| (none) | No `TODO`/`FIXME`/`XXX`/`TBD`, no placeholder/Not-implemented text in phase-owned source | — | None |
| `propose.ts` `return null` / `return []` sites | Legitimate nullable lookups (mirror origin, ledger/pushed-PR resolution) — each has a wired consumer | ℹ️ Info | Not stubs |

### Explicit Scope Boundaries (not gaps)

- **First real GitHub PR / owner merge / skills propagation is Phase 22 (SKILL-07)** — roadmap Proof statement for Phase 21 explicitly defers it; 47/47 recording-`gh` checks do not claim it. Not a Phase 21 gap.
- **Production surface tokens are Phase 20** (operator actions 0/3); production refuses proposals until then by design (D21-02). Not a Phase 21 gap.
- **Obsolete `/var/lib/substrate/skills/propose.key` removal** belongs to Phase 22's cutover. Not done here per plan.
- **High-threshold disclosure:** T-21-SC (dependency supply-chain) remains **OPEN low, proposed-accept with no acceptor/date**. It sits below the configured `block_on: high` gate, so `threats_open = 0` and the SECURED verdict holds — but **no low/medium risk acceptance is authorized by this report**. The accept is proposed, not accepted.

### Gaps Summary

None. All 18 must-haves verified against current source; review/security/validation gates reconcile; follow-ons stay explicitly operator-owned per existing plans. No ROOT REQUIREMENTS checkbox or phase-completion write is made by this verifier — parent owns status.

---
_Verified: 2026-10-11_
_Verifier: Phase21GoalVerifier (native gsd-verifier, static source-first)_
