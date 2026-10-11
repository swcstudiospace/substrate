---
phase: 21-skills-propose
verified: 2026-10-11T02:10:00Z
status: passed
score: 24/24 must-haves verified
covered_files: [".env.example", ".planning/phases/21-skills-propose/21-01-PLAN.md", ".planning/phases/21-skills-propose/21-01-SUMMARY.md", ".planning/phases/21-skills-propose/21-02-PLAN.md", ".planning/phases/21-skills-propose/21-02-SUMMARY.md", ".planning/phases/21-skills-propose/21-03-PLAN.md", ".planning/phases/21-skills-propose/21-03-SUMMARY.md", ".planning/phases/21-skills-propose/21-04-PLAN.md", ".planning/phases/21-skills-propose/21-04-SUMMARY.md", ".planning/phases/21-skills-propose/21-05-PLAN.md", ".planning/phases/21-skills-propose/21-05-SUMMARY.md", ".planning/phases/21-skills-propose/21-06-PLAN.md", ".planning/phases/21-skills-propose/21-06-SUMMARY.md", "docs/event-vocabulary.md", "docs/mcp-audit.md", "docs/rehearsal.md", "docs/skills-propose.md", "package.json", "packages/audit/src/policy.test.ts", "packages/cli/src/index.ts", "packages/cli/src/skills.test.ts", "packages/cli/src/skills.ts", "packages/mcp-server/src/event-sources.test.ts", "packages/mcp-server/src/event-sources.ts", "packages/mcp-server/src/http.test.ts", "packages/mcp-server/src/mcp.test.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/observe.test.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/rehearsal-env.test.ts", "packages/mcp-server/src/rehearsal-env.ts", "packages/mcp-server/src/rehearsal-fake-gh.ts", "packages/mcp-server/src/rehearsal-skills.test.ts", "packages/mcp-server/src/rehearsal-skills.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/skills/frontmatter.ts", "packages/mcp-server/src/skills/propose.ts", "packages/mcp-server/src/skills/request.test.ts", "packages/mcp-server/src/skills/request.ts", "scripts/rehearsal.test.ts", "scripts/rehearsal.ts", "scripts/skills-propose-smoke.test.ts", "scripts/skills-propose-smoke.ts"]
covered_digest: "v3:sha256:1c10d749d7a855fba786d611144becd3eafefb3d7a1311829301a93c4e6d79f6"
behavior_unverified: 0
overrides_applied: 0
deferred:
  - truth: "The first real PR on swcstudiospace/agent-skills through production gh and the owner's credential."
    addressed_in: "Phase 22"
    evidence: "Phase 22 success criterion: 'A skill mined from a Cursor session is proposed as a PR, merged by the owner, and within one sync tick appears in Claude Code and Grok Build' — the owner merge implies the live cross-repo PR this phase's isolated proof stands in for."
re_verification:
  previous_status: stale
  previous_score: 24/24
  gaps_closed: []
  gaps_remaining: []
  regressions: []
---

# Phase 21: skills_propose Verification Report

**Phase Goal:** Any authenticated surface can propose a skill and get a reviewable PR on `swcstudiospace/agent-skills`, and nothing secret, malformed or duplicate gets through.
**Verified:** 2026-10-10 (re-verification; initial pass 2026-10-09)
**Status:** passed, with one live-only proof deferred to Phase 22 (listed below).
**Base:** `main` at `e2ad4dc` (docs(20) close; clean, `dirty=false` at twin `up` time).

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | SC1: `skills_propose` over MCP, `POST /skills/propose` and `substrate skills propose` accept a valid skill from a token surface and open branch `skill/<surface>/<name>-<ts>-<hex>` with a PR through `gh`, after checking the origin, without force-pushing | ✓ VERIFIED | Smoke (a), re-run 2026-10-10: `opened` on all three doors, each branch matches the shape and exists in the library, one recorded `gh pr create` each, three distinct PRs. Engine tests pin the origin check before push and that no argv carries a force flag, colon refspec or search query. |
| 2 | SC1: the library never sees a non-fast-forward | ✓ VERIFIED | The fixture library sets `receive.denyNonFastForwards` and `receive.denyDeletes`; smoke (e), re-run 2026-10-10: 4 ref logs, 0 updates. |
| 3 | SC2: a bad name, path or frontmatter is refused | ✓ VERIFIED | Smoke (c), re-run 2026-10-10: bad name, `..` path, missing frontmatter, mismatched frontmatter each 400 with no branch and no `gh` call. 64 engine tests. |
| 4 | SC2: a planted secret is refused after redaction and scan, with a finding naming file, line and rule, and the value appears nowhere | ✓ VERIFIED | Smoke (c), re-run 2026-10-10: 400, finding `{file: SKILL.md, line: 6, rule: github}`; the runtime-assembled value is absent from the route and MCP responses, the proposal ledger, the events, the audit file, the recorded `gh` calls and the library's refs. |
| 5 | SC2: identical content answers `existing`, `declined` or `unchanged` and opens no second PR | ✓ VERIFIED | Smoke (b), re-run 2026-10-10: `existing` with the same PR; after the fake `gh` closed it, `declined`; content equal to `main`, `unchanged`; none pushed a branch or opened a PR. |
| 6 | SC3: an anonymous call is refused | ✓ VERIFIED | Smoke (d), re-run 2026-10-10: no token is 401 on `/skills/propose` and on `/mcp`. Route 401 is before the body is read (an oversize anonymous body still answers 401); the service refuses a null surface too; the CLI exits 1 with nothing posted. |
| 7 | SC3: the tool is registered in `mcp.ts`, `observe.ts` and the audit policy | ✓ VERIFIED | `mcp.test.ts` lists it with `destructiveHint: false`, `openWorldHint: true` and the schema's field set; `observe.test.ts` pins `KNOWN_TOOLS` and `KNOWN_ROUTES`; `policy.test.ts` pins both registrations, explicit fail-closed membership and that no served tool or route is undecided. Re-run 2026-10-10: 155 pass / 0 fail across `server/mcp/observe/policy` test files. |
| 8 | D21-01: only a surface token authenticates; September's propose key and `propose-auth.ts` are not ported | ✓ VERIFIED | `rg -i 'propose-key|propose-auth'` outside `.planning` finds one line, in `docs/skills-propose.md`, saying the header is gone; no code or script mentions it. |
| 9 | D21-03/04: the proposal is made as the token's surface; an equal or absent body surface is accepted, a different one is 403, never re-attributed; any authenticated surface may propose | ✓ VERIFIED | Service, route and tool tests (swarm and `substrate` surfaces included); smoke (d), re-run 2026-10-10: 403 for a mismatch. |
| 10 | D21-05: `mode replace`, `reopen` and `allow_doc_examples` need an operator token | ✓ VERIFIED | Each is 403 for a surface token on the route and as an MCP error; an operator passes them through to the engine; smoke (d), re-run 2026-10-10: all three 403. |
| 11 | D21-06: one service method is the only code that reaches git or gh | ✓ VERIFIED | The route, the tool and the CLI all end in `Substrate.proposeSkill` (spot-checked 2026-10-10 in `server.ts:755`, `mcp.ts:911`); the CLI imports the engine's types only (`import type`), so `redact-lock` stays green and it has no in-process path. |
| 12 | D21-08/09: the 1 MB cap and the status codes | ✓ VERIFIED | `http.test.ts`: 200 per status, 400 with findings, 401, 403, 413, 502 redacted and capped at 400 characters, 503 with an unwritable audit chain; the CLI refuses an oversize directory before posting and counts sizes before reading files. |
| 13 | D21-10: the CLI's output and exit codes | ✓ VERIFIED | `skills.test.ts` (31) against a stub over a real socket and as a spawned command; the smoke ran the real CLI to `status=opened`. Re-run 2026-10-10 green. |
| 14 | D21-11: `dry_run` is available on all three doors and has no side effect | ✓ VERIFIED | Service and tool tests: no event, no ledger line; smoke: a dry run as the operator pushed nothing and called no `gh`, and it is still audited as `skills_propose`. |
| 15 | D21-12/14/15: the engine is ported as it was; September's state dir and ledger format are kept; git and gh children get an allowlisted environment | ✓ VERIFIED | `propose.test.ts` (64) and `propose.git.test.ts` (2, real git) from plan 21-01; `childEnv` pins PATH, HOME and the two no-prompt flags. Re-run 2026-10-10: 126 pass / 0 fail across `propose/propose.git/config` files. |
| 16 | D21-13: the library is configurable; a non-default one needs a `file://` remote and an absolute `gh` | ✓ VERIFIED | `config.test.ts` (7 skills cases); the harness's env builder refuses any fixture value outside the run directory. |
| 17 | D21-17: events follow the Phase 17 rows, fail-open | ✓ VERIFIED | Service tests assert each event's kind and action equal the `skills.propose`, `.refused` and `.failed` rows; none on dry run, 401, 403 or malformed; a failing or throwing emit never changes the answer (mutation-checked). Smoke (f), re-run 2026-10-10: 6 notes and 6 warnings on the trail with rule names. Re-run: 162 pass / 0 fail across `skills/event-sources/rehearsal-env/rehearsal-skills` files. Service: 206 pass / 0 fail. |
| 18 | D21-18: the route is audited as `skills_propose`, fail-closed, before any git work | ✓ VERIFIED | `http.test.ts`: audit record `{tool: skills_propose, transport: rest}` with the body digested; unwritable audit file is 503 and the proposer is not called. Smoke (f), re-run 2026-10-10: 17 audit records across both transports. Policy still lists `skills_propose` fail-closed (spot-checked 2026-10-10, `policy.ts:27`). |
| 19 | D21-19: the docs | ✓ VERIFIED | `docs/skills-propose.md` and pointers in `rehearsal.md`, `mcp-audit.md`, `event-vocabulary.md`, `.env.example`; the docs-versus-table drift test is green. |
| 20 | D21-21: the harness gains a skills fixture, and every instance sets `SUBSTRATE_SKILLS_STATE` inside its run directory | ✓ VERIFIED | `rehearsal-env.test.ts`: the key is always set to `<run>/skills`; fixture keys only with the flag, only the four known keys, only inside the run directory. `rehearsal-skills.test.ts` (15): real git on a throwaway repository, the deny settings, the mirror refspec, the recording `gh` answering three questions and refusing the rest. |
| 21 | D21-22: the isolated smoke | ✓ VERIFIED | Re-run 2026-10-10 from a detached worktree at `e2ad4dc` (the harness refuses to run from the production checkout; code identical, `dirty=false`): `rehearsal up --name p21 --skills-fixture --port 17421` (port 17410 held by a leftover phase-19 twin, left untouched), `bun run smoke:skills-propose`: **47/47**; `rehearsal down` removed both containers and the run directory; worktree removed afterwards. |
| 22 | D21-23: results against the baseline | ✓ VERIFIED | 2026-10-10 at `e2ad4dc`: full `bun test` 2646 pass / 58 skip / 1 fail — the single failure is known F-01 (`rehearsal.test.ts` cwd-sensitive `--port 7410` assertion, phase-16 scope), recorded not fixed. No failure introduced or hidden by this phase. |
| 23 | COVERAGE: the shipped `gh` surface | ✓ VERIFIED | `pr create`, `pr view` and `pr list --head` are the only `gh` argv builders; the fake `gh` refuses everything else and records it; merge, close, search and force-push remain reasoned OPT-OUTs. |
| 24 | Locks: `store-lock`, `vocabulary-lock`, `redact-lock` unedited and green; no new dependency | ✓ VERIFIED | Re-run 2026-10-10: `check:phase-close` pass (4 lock files green, EVENT_KINDS 12, SURFACES 27); `redact-lock.test.ts` 19 pass (grew from 15 as the shared redactor evolved — green). |

**Score:** 24/24 truths verified.

### Deferred Items

Items not yet met but explicitly addressed in later milestone phases.

- The first **real** PR on `swcstudiospace/agent-skills` through production `gh` and the owner's credential. It is a live GitHub write on another repository and needs operator approval; it is Phase 22's live proof (Phase 22 SC: a mined skill "is proposed as a PR, merged by the owner"). Production also stays anonymous until Phase 20, so it refuses every proposal until then, as D21-02 intends. (Phase 20 has since completed; the live proof remains operator-gated in Phase 22.)

## Gate Evidence (re-run 2026-10-10 at `e2ad4dc`)

| Gate | Result |
|---|---|
| `git pull --ff-only` | Already up to date at `e2ad4dc` |
| `bunx tsc --noEmit` | exit 0 |
| full `bun test` | 2646 pass / 58 skip / 1 fail (95 files) — the 1 fail is known F-01, phase-16 scope |
| phase test files (`propose`, `propose.git`, `config`) | 126 pass / 0 fail |
| `service.test.ts` | 206 pass / 0 fail |
| `server/mcp/observe/policy` test files | 155 pass / 0 fail |
| `skills/event-sources/rehearsal-env/rehearsal-skills` test files | 162 pass / 0 fail |
| `bun run check:phase-close` | pass |
| `redact-lock.test.ts` | 19 pass / 0 fail |
| isolated proof (twin on `:17421` with `--skills-fixture` from a detached `e2ad4dc` worktree, `smoke:skills-propose`, `rehearsal down`) | 47/47; torn down (2 containers removed, run dir removed, worktree removed) |
| wiring spot-checks | route + tool end in `Substrate.proposeSkill`; `skills_propose` fail-closed in `policy.ts`; registered in `mcp.ts`/`observe.ts` |

Not a hot-path phase: it adds no work to `POST /events` or `POST /brief`, so the perf gate does not apply.

## Review

- **Code review (self, carried from 2026-10-09):** 0 critical. One warning fixed: `readSkillDir` read every file before comparing the assembled body with the cap, so a huge file could exhaust memory just to be refused; sizes are now summed from `lstat` first (plus a test). Info: the 413 mapping is limited to this route because an existing test pins the generic 500 elsewhere. No new review findings on re-verification (no code delta).
- **Security review (carried):** authentication before any work and before the body is read; attribution only from the token; privileged options need an operator token; `execFile` with argv arrays, never a shell; names and paths validated and confined; the child environment is an allowlist; secrets are redacted before any write and refusals carry file, line and rule only; events and errors carry rule names or redacted capped text; the audit digests the body; no dependency added; the harness cannot reach GitHub (the library is `rehearsal/agent-skills`, the recording `gh` refuses everything but three questions) or the host's skills state.
- **Nyquist validation:** `21-VALIDATION.md` is `validated` and `nyquist_compliant`; every row names the plan and task and a command that passed.

## Operator Steps Recorded

1. Phase 20 provisioned the production tokens (completed 2026-10-10); until Phase 22's live proof, no real PR has been opened.
2. Phase 22's live proof opens the first real PR on `agent-skills` (needs the operator's approval), and removes the unused key file `/var/lib/substrate/skills/propose.key` at its cutover.

## Re-verification after later-phase landings (2026-10-10)

Phases 23, 27, 28 and 30 landed after the 2026-10-09 pass and touched files in this phase's covered set (shared service/server/mcp/policy surface), and the production identity switch executed — so the report went `stale` and the fingerprint was refreshed (`486fc460…` → `1b860861…`). Nothing in this phase's own implementation changed. Re-verification re-ran every gate above at `e2ad4dc`: all green except known F-01. Verdict unchanged: `passed`, no gaps, no regressions, one live-only proof deferred to Phase 22.

## Re-verification after restacking (2026-10-09)

Phase 18's review round 2 changed the redactor this phase builds on, and `main` gained the verification-gate PR, so the branch was restacked onto Phase 18's new tip. Nothing in this phase changed. Gate on the restacked head: bun run verify: install, types, tests, locks all ok; 1914 pass / 57 skip / 0 fail. The report's fingerprint was refreshed (the base now carries the verification-gate PR and Phase 18's review fixes).

_Verifier: Phase21Verify (gsd execute-phase re-verification at gates only; no code delta)_

---

## Close-out sweep re-verification (2026-10-11, HEAD `ed696ef`, PR #53 merged)

Covered-file delta since the `acd0c16` verify (11 files): phases 25/26/29 layered additive
registrations onto the shared model (`mcp.ts`, `observe.ts`, `server.ts`, `service.ts`,
`packages/cli/src/index.ts`) plus `.env.example`, `docs/rehearsal.md`, `package.json`, and
the `mcp`/`observe` test extensions. Every phase-21-owned source (`skills/*`,
`event-sources.ts`, `rehearsal-skills*`, `skills-propose-smoke*`) is byte-identical.

- Skills files `bun test policy + skills + event-sources + http + mcp + observe +
  rehearsal-skills + service + skills/request + skills-propose-smoke`: **597 pass / 0 fail**.
- The deferred live-PR truth still routes to Phase 22's owner-merge criterion (unchanged).
- Shared gates at tip: `bun test` 3136 pass / 58 skip / 1 fail (F-01 only),
  `bunx tsc --noEmit` clean, pytest 246 passed, `check:phase-close` pass.

Verdict: 24/24 truths stand, no regressions, no new gaps. Digest refreshed to
`v3:sha256:1c10d749d7a855fba786d611144becd3eafefb3d7a1311829301a93c4e6d79f6`.
