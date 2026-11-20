---
phase: "21"
slug: "skills-propose"
status: draft
# Severity-filtered blocking gate (block_on: high): threats_open counts OPEN threats at high or above.
# T-21-SC is OPEN at low severity (threats_open_nonblocking: 1) and needs an owner decision.
threats_open: 0
threats_open_nonblocking: 1
asvs_level: 1
block_on: high
register_authored_at_plan_time: true
created: "2026-10-10"
reverified: "2026-11-12"
verifier: gsd-security-auditor (orchestrator re-verification, secure-phase run)
verification_method: static-source-grep-plus-targeted-bun-tests
---

# Phase 21 — Security

> **Re-verified 2026-11-12 against the current checkout** (`reconcile/main-2026-11-11`, HEAD `6d0adafd`). The earlier register (2026-10-11) cited line numbers in an uncommitted worktree (`/root/src/worktrees/agent-substrate-v13-autonomous`) that is not this tree; those references were discarded. Every row below cites `packages/...` paths in this checkout.
>
> Result: **19 CLOSED, 1 OPEN (T-21-SC, low).** No open threat at block_on `high`. Status stays `draft` because T-21-SC's disposition is `accept`, and no owner has accepted it. This file does not waive, accept, or sign off on any risk.

## Scope and Evidence Standard

Requirement: SKILL-01. Register: T-21-01 through T-21-19 plus the shared reserved T-21-SC (20 unique threats).

- **Static evidence:** each mitigation was read in the current source (file:line below).
- **Test evidence:** tests were run now with `bun test` in this checkout. Pass counts below come from those runs.
- **Not run:** the end-to-end smoke (`scripts/skills-propose-smoke.ts`) and the rehearsal harness (`rehearsal up/down`) were not executed. They need a live store and a scratch instance. Claims that depend only on them are marked as such.

Test runs (2026-11-12, this checkout):

| Command | Result |
|---|---|
| `bun test packages/mcp-server/src/skills/propose.test.ts propose.git.test.ts request.test.ts observe.test.ts` | 209 pass, 0 fail |
| `bun test packages/mcp-server/src/http.test.ts -t "skills/propose"` | 20 pass, 0 fail |
| `bun test packages/mcp-server/src/mcp.test.ts -t "skills_propose"` | 10 pass, 0 fail |
| `bun test packages/mcp-server/src/service.test.ts -t "propos"` | 19 pass, 0 fail |
| `bun test packages/cli/src/skills.test.ts` | 45 pass, 0 fail |
| `bun test packages/mcp-server/src/config.test.ts rehearsal-env.test.ts rehearsal-skills.test.ts` | 131 pass, 0 fail |
| `bun test scripts/desktop-smoke.test.ts scripts/rehearsal.test.ts` | 135 pass, 0 fail |

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| Client → authentication | Bearer resolves caller surface before the body is read | Token and authority metadata |
| REST/MCP → service | Surface attribution from the token; body surface must match | Trusted surface, operator flag |
| REST/MCP → proposer | Shape, size and content checks precede git/gh | Proposal body |
| Engine → subprocess | argv-only `execFile`, allowlisted child env | Repo path, branch, PR text |
| Engine → library | Fresh branch push only; origin checked before push | Branch, commit |
| Outcome → caller/event/audit | Findings as file/line/rule; failures redacted and capped | Sanitised outcome |
| CLI → HTTP | Regular UTF-8 directory intake, size cap, token as header | Skill files, token |

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation evidence (current checkout) | Tests run now | Status |
|-----------|----------|-----------|----------|-------------|----------------------------------------|---------------|--------|
| T-21-01 | Tampering | propose argv | high | mitigate | `packages/mcp-server/src/skills/propose.ts:412` `checkout -q -b <fresh> origin/main`; `:443` `pushArgv` = `git push origin <branch>` only (no force, no colon refspec, no search); `:1019-1022` origin checked before push | propose.test.ts "argv builders are exact"; "no builder carries a force or search flag, and the push has no colon refspec" | CLOSED |
| T-21-02 | Information disclosure | skill content to PR | high | mitigate | `propose.ts:269-271` `scanSkillFiles` findings refuse the proposal before any git call; `:204` whole-value `redact` check; `:278-281` frontmatter re-checked after redaction; `:952` PR body capped before subprocess (`PR_BODY_MAX`) | propose.test.ts "refuses a credential in a path, a removal, a session id or a graph id without echoing it"; "a ghp_ token shape is refused with a github finding…"; "refuses a pull request body over the cap before any runner call" | CLOSED |
| T-21-03 | Information disclosure | child env | high | mitigate | `propose.ts:567-581` `childEnv`: only `PATH` read from parent; `HOME` from argument; fixed Git controls (`GIT_CONFIG_GLOBAL/SYSTEM=/dev/null`, `GIT_CONFIG_COUNT`, `KEY_0/1`, `VALUE_0/1`, `GIT_TERMINAL_PROMPT=0`, `GH_PROMPT_DISABLED=1`); `:595-601` runner uses this object only, `execFile`, 120 s, 4 MiB | propose.test.ts "childEnv is exactly the allowlist" (`:982`) | CLOSED (see drift note F2) |
| T-21-04 | Elevation of privilege | library config | medium | mitigate | `packages/mcp-server/src/config.ts:893-896` non-default library requires `file://` remote and absolute non-default `SUBSTRATE_SKILLS_GH`, else `skills.problem`; `service.ts` `proposeSkill` refuses a configured problem before the proposer runs; `propose.ts:964` mirror origin must match configured slug; `:1020` clone origin re-checked before push | config.test.ts "a non-default repo is accepted with a file:// remote and an absolute non-default gh"; "a file:// remote with the default gh is refused, naming the gh key"; service.test.ts "an invalid skills library is refused before the proposer runs"; propose.test.ts "a mirror pointing at another library is refused before any Runner call" | CLOSED |
| T-21-05 | Spoofing | proposal surface, service | high | mitigate | `packages/mcp-server/src/service.ts` `proposeSkill` `:4680-4686`: body surface ≠ caller surface → `SkillProposalDenied(403)`, never re-attributed; `server.ts:2129-2146` surface comes from bearer, not body | service.test.ts "a body surface that differs from the token's is refused 403, never re-attributed"; http.test.ts "a body surface equal to the token's is accepted; a different one is 403…"; mcp.test.ts "a different surface than the caller's is refused, never re-attributed" | CLOSED |
| T-21-06 | Authentication | anonymous proposal | high | mitigate | `server.ts:2131-2134` `surface === null` → 401 before `readBody`; `service.ts:4676-4678` null surface → 401 before proposer; operator flag does not authenticate | http.test.ts "an anonymous caller is refused 401 before the body is read, with nothing proposed"; service.test.ts "even an operator flag does not authenticate an anonymous caller" | CLOSED |
| T-21-07 | Repudiation | unaudited publication | high | mitigate | Publication path: `server.ts:2138` `auditedRest(… "skills_propose" …)` fail-closed before `proposeSkill` (503 on denial, `:703-715`); MCP: `skills_propose` in `FAIL_CLOSED_TOOLS` (`packages/audit/src/policy.ts:27`) and gated in `observe.ts` before dispatch | http.test.ts "it is audited as skills_propose on the REST transport, the body digested not stored"; "when the audit chain cannot take the record it is 503 and nothing is proposed"; observe.test.ts "denies a fail-closed tool the chain could not record" | CLOSED for publication. **Finding F1:** refusals that never reach the audit call are not recorded (see Findings) |
| T-21-08 | Information disclosure | findings/errors, service | medium | mitigate | `packages/mcp-server/src/skills/request.ts:99-108` projects `{file,line,rule}` only; `:130-131` 502 message `redact(...).slice(0, 400)`; `propose.ts:62` `OUTPUT_TAIL_CHARS = 400` with redaction | request.test.ts "a refusal is 400 and its findings are file, line and rule, nothing more"; "a failed git or gh step is 502, redacted and capped at 400 characters"; service.test.ts "a failed git or gh step emits a warning with the redacted reason and rethrows" | CLOSED |
| T-21-09 | Denial of service | oversize body | medium | mitigate | REST: `server.ts:281` `MAX_BODY_BYTES = 1_000_000`, `readBody` throws, `server.ts:2424` answers 413 for `/skills/propose`; shared measure `request.ts:52-66` `proposalBodySizeProblem` (canonical UTF-8 of caller JSON, `ROUTE_MAX_BYTES = 1_000_000`, `propose.ts:53`); MCP: `mcp.ts:2054` refuses before service | http.test.ts "an oversize body is 413 on this route"; mcp.test.ts "a body over the 1 MB cap is a refused tool error before the service, and one at the cap goes through"; request.test.ts "a body of exactly the cap fits and one byte more is refused" | CLOSED |
| T-21-10 | Tampering | second-door propose | high | mitigate | `packages/cli/src/skills.ts:27` imports engine **types only** (`import type`); `:234` posts to audited `/skills/propose`; no git runner, no self-posted event in the CLI | skills.test.ts "posts the directory to /skills/propose with the token and the route's snake_case keys" | CLOSED |
| T-21-11 | Information disclosure | token handling | medium | mitigate | `packages/cli/src/skills.ts:185` token required, read from `SUBSTRATE_TOKEN`; token appears only in request headers (`:236`, `:298`); refusals print fixed text | skills.test.ts "no token is exit 1 on stderr with nothing posted, even for a dry run" | CLOSED |
| T-21-12 | Tampering | directory intake | medium | mitigate | CLI: `skills.ts:56-88,169-177` lstat, symlink and special-file refusal, fatal UTF-8 decode, size cap. Engine: `propose.ts:317-390` confined tree, symlink ancestors refused, final symlink removed before write | skills.test.ts "a symlink inside the directory refuses the whole directory, naming it"; "a file that is not valid UTF-8 refuses the whole directory, naming it"; propose.test.ts "a symlink parent is refused and the link target is untouched"; "nothing outside <clone>/<name>/ is created or removed" | CLOSED |
| T-21-13 | Isolation failure | skills fixture / smoke | high | mitigate | `scripts/rehearsal.ts:72` `PRODUCTION_PORTS = [7410, 7411, 6420]`, `:139` reserved-port refusal; `:1502` `refuseSmokeUrl` refuses non-loopback and production ports; `packages/mcp-server/src/rehearsal-env.ts:220` `assertLoopback`; `scripts/skills-propose-smoke.ts:100-101` refuses on `refuseSmokeUrl` | desktop-smoke.test.ts "refuses non-loopback hosts on any port"; "refusePort refuses the production ports"; rehearsal-env.test.ts "assertLoopback accepts loopback and refuses the rest"; "refuse a state directory, a gh script or a remote outside the run directory" | CLOSED (smoke itself not run, see Not run) |
| T-21-14 | Information disclosure | planted secret | medium | mitigate | Refusal without echo: `propose.ts:204,269-271` (finding carries file/line/rule, never value); smoke plants the decoy at `scripts/skills-propose-smoke.ts:136` and asserts absence (`:257-270`, end-to-end not run) | propose.test.ts "refuses a credential in a path, a removal, a session id or a graph id without echoing it"; "a ghp_ token shape is refused with a github finding and the refusal never carries it" | CLOSED (unit evidence run; e2e smoke not run) |
| T-21-15 | Tampering | library history | medium | mitigate | Production: push is a new fresh branch only (`propose.ts:443`, no force or refspec); fixture: `packages/mcp-server/src/rehearsal-skills.ts:86-88` sets `receive.denyNonFastForwards`, `denyDeletes`, `logAllRefUpdates` on the bare fixture remote. Protection of the real library on GitHub is **not** verified here | propose.test.ts "no builder carries a force or search flag, and the push has no colon refspec"; "a valid proposal opens, pushes a branch, and leaves an all-zero-old-sha reflog" (propose.git.test.ts) | CLOSED for substrate code; real-library protection out of scope (see F3) |
| T-21-16 | Tampering | stale contract docs | medium | mitigate | `docs/skills-propose.md` covers the three doors (`:7`), 401/403/200 answers (`:42-56`), file:// rule (`:95`), dry-run and events | Doc inspection only; no test. Validation map `.planning/.../21-VALIDATION.md` present | CLOSED (doc check, not executed) |
| T-21-17 | Spoofing | proposal surface, REST/MCP | high | mitigate | `packages/mcp-server/src/mcp.ts:2054-2063` passes `callerSurface`, never body-first; `service.ts:4680` refuses mismatch before engine | mcp.test.ts "a different surface than the caller's is refused, never re-attributed" | CLOSED |
| T-21-18 | Authentication | anonymous proposal, REST/MCP | high | mitigate | REST `server.ts:2131-2134` (before body read); MCP null-surface refusal via `service.ts:4676-4678` returned as `isError` (`mcp.ts:2063`) | mcp.test.ts "an anonymous caller is refused as an error and nothing is proposed"; http.test.ts 401 test | CLOSED |
| T-21-19 | Information disclosure | findings/errors, REST/MCP | medium | mitigate | `request.ts:99-108` (file/line/rule only); `request.ts:130-131` redact+cap 400 on failure; same mapping used by REST (`server.ts:2143-2146`) and MCP (`mcp.ts:2063`) | request.test.ts "a refusal is 400 and its findings are file, line and rule, nothing more"; mcp.test.ts "a refusal is an error carrying findings as file, line and rule" | CLOSED |
| T-21-SC | Tampering | dependencies, shared | low | accept (proposed, **no owner decision**) | Plans state "no package installed" (rationale only). No code-level proof for phase 21 changes was obtainable from this checkout (phase commits not isolated). Nothing in this file accepts it | n/a | **OPEN** (low, non-blocking) — owner decision required; acceptor: none; date: none |

**Counts:** 20 unique threats. CLOSED 19. OPEN 1 (T-21-SC, low). `threats_open` (block_on high) = 0.

## Findings

- **F1 — REST refusals are not audited (contradicts the 2026-10-11 register).** `server.ts:2138` audits only when the parsed body is a JSON object. A non-object body (array, null, string) is answered 400 at `server.ts:2140-2142` with no audit call. Malformed JSON and oversize bodies are answered by the catch-all at `server.ts:2424-2427` (400 / 413) with no audit call. The earlier claim that these produce one safe audit record per attempt is not true of this checkout. Impact: refused, non-publishing attempts leave no record on REST; MCP is unaffected (audit gate runs before dispatch). Publication itself is still audited. **Owner should decide whether to close this (small change: audit a safe descriptor on those paths) or accept it.** Not fixed here: this task does not edit implementation.
- **F2 — Child env drift.** The plan and the old register said "four base keys". `childEnv` (`propose.ts:567-581`) sets 11 keys (PATH, HOME, plus nine fixed Git/gh controls). No secret is forwarded and the test asserts the exact allowlist, so this is documentation drift, not a leak. The credential helper is hard-coded to `/usr/bin/gh` (`:579`) while `SUBSTRATE_SKILLS_GH` is configurable; non-default libraries are `file://` only, so no credential helper runs for them.
- **F3 — Real library protection not verified.** T-21-15's bare-repo deny settings exist only in the fixture (`rehearsal-skills.ts:86-88`). Branch protection on the real skills library is outside this repo.
- **Not executed:** `scripts/skills-propose-smoke.ts` end-to-end (T-21-13/14/15 e2e assertions) and `bun run check:phase-close`. Not run in this pass.

## Accepted Risks Log

**None.** T-21-SC is not accepted. Its plan disposition `accept` is a planner proposal with no acceptor, rationale signed off, or date. Only the owner can accept it.

## Owner decisions required

| Item | Decision needed |
|------|-----------------|
| T-21-SC (low) | Accept with a named acceptor and date, or require evidence (phase commit range showing no `package.json`/lockfile change) and mark CLOSED |
| F1 (REST refusal audit gap) | Implement the refusal audit, or accept the gap in writing |

## Summary Threat Flags

No `## Threat Flags` sections were checked in this pass. No unregistered threat was identified in the code reviewed.

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-10-10 | 20 | 17 | 3 (1 blocking, 2 non-blocking) | Earlier static auditor return |
| 2026-10-11 | 20 | 19 | 1 (0 blocking, 1 low non-blocking) | Static reassessment against the v13 worktree (not this checkout) |
| 2026-11-12 | 20 | 19 | 1 (0 blocking, 1 low non-blocking) | secure-phase re-verification against current checkout; targeted bun tests (see table); findings F1–F3 |

## Sign-Off

- [x] All 20 threats re-checked against current source at `packages/...` paths in this checkout.
- [x] 19 mitigations CLOSED with a file:line and a test name run on 2026-11-12.
- [x] `threats_open` (block_on high) = 0.
- [ ] T-21-SC has an owner decision (OPEN, low, no acceptor).
- [ ] F1 has an owner decision (fix or written acceptance).
- [ ] Smoke end-to-end and phase-close check run.

**Verdict:** `draft`. No blocking threat is open, but phase security is not verified until the owner decides T-21-SC and F1. This file records no acceptance, waiver or sign-off.

## Owner decisions and operator state carried forward

Restored verbatim from the prior revision (git HEAD) so the rewrite does not drop them:

The user selected **Keep current Git isolation**. The live plan row, must-have/action wording, CONTEXT D21-15, documentation and SUMMARY amendment now explicitly distinguish four base keys from seven fixed private Git controls. Current childEnv at /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/skills/propose.ts:560-576 returns PATH/HOME/no-prompt flags plus GIT_CONFIG_GLOBAL/SYSTEM=/dev/null, COUNT=2, KEY_0/VALUE_0 empty default credential helper and KEY_1/VALUE_1 GitHub gh credential helper. Only PATH/HOME are read from parent; Git hardening keys are fixed, not copied. The runner uses this explicit object with execFile argv and120-second/4MiB bounds. The old exact-four-key assertion is not certified; it was actually reconciled through the user-selected contract. No hardening was removed, no credential forwarding was added and no risk acceptance was inferred.
The pre-existing credential incident remains **operator_rotation_pending**, outside authored Phase21/27 register counts. Containment/final green does not revoke the credential; no rotation, risk acceptance or incident closure is claimed.

