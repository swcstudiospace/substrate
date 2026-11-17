---
phase: "21"
slug: "skills-propose"
status: draft
# Severity-filtered blocking gate: total OPEN 1, low/non-blocking.
threats_open: 0
asvs_level: 1
block_on: high
register_authored_at_plan_time: true
created: "2026-10-10"
verifier: gsd-security-auditor
verification_method: static-source-and-grep
---

> Recovered 2026-10-29 from an uncommitted worktree of branch swarm/v13-autonomous-integration (HEAD 76a4b2c3).
> Written 2026-10-11 to 2026-10-12 during the v1.3 autonomous integration; it describes that run and was not re-verified against main.
> Its paths and line references point at the 2026-10-11 tree, not at main.

# Phase 21 — Security

> **SECURED at the ASVS L1 / high-severity blocking gate:** 19/20 CLOSED, 1/20 OPEN low/non-blocking, zero blocking-open threats. This is not an assertion that every risk is accepted or that the phase, external GSD gates, release or protected-main work is complete. The parent owns artifact persistence, final source fingerprint and phase status.

## Scope and Evidence Standard

Requirement: SKILL-01. The authored live register is T-21-01 through T-21-19 plus the shared reserved T-21-SC: twenty unique threats, nineteen mitigate dispositions, one proposed accept, no transfers. Renamed 21-03 IDs T-21-17/18/19 remain distinct from service IDs T-21-05/06/08. Reserved SC is counted once across six plans. Parent metadata evidence records duplicate_count0; no waiver was used.

The six PLANs, six SUMMARYs, CONTEXT, native secure-phase skill/workflow/template/ASVS references and relevant source/tests were read. Updated live-plan/context/documentation and final parent evidence were re-read after corrections. /root/src/worktrees/agent-substrate-v13-autonomous/.planning/config.json has no security overrides; native defaults are ASVS1 and block_on high.

The auditor performed static source reading, targeted grep and test-assertion review only. No tests/builds/lint/scans/smoke/gates/formatters/runtime scripts/git commands/network/secret/operator/config actions were executed. Implementation files and audit artifacts were not written by the auditor. Parent-observed execution evidence is attributed below, not claimed as an independent audit run. Source controls, not SUMMARY claims or intent, support mitigation closure.

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| Client → authentication | Header bearer resolves caller surface/operator before arguments | Token and authority metadata |
| REST/MCP → audit dispatcher | Fail-closed skills_propose recording precedes action dispatch; REST refusals also leave safe descriptors | Digested request or fixed refusal-shape metadata |
| CLI directory → HTTP | Bounded regular UTF-8 file intake and flag mapping | Skill text and request options |
| Service → engine | Token attribution, operator gates and library configuration refusal | Trusted surface and approved options |
| Input → validation/redaction | Name/path/frontmatter/removals/content/metadata checks precede git/gh | Redacted file tree, hash and findings |
| Engine → subprocess | argv-only execFile and explicit private Git environment | Repository, branch, paths and PR text |
| Engine → state/library | Confined clone writes, locks and library-aware dedupe ledger | Redacted content, content hash and PR identity |
| Outcome → caller/event/audit | Findings project file/line/rule; failures redact before capping; audit retains digest rather than content | Sanitized outcome metadata |
| Harness → host/library | Scratch paths/HOME, local file remote, fake gh and guarded teardown | Isolated fixture state and scratch tokens |
| Documentation → operator/client | Current contract plus explicit recorded capability drift | Approved configuration/wire behavior |

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation / Source Evidence | Status |
|-----------|----------|-----------|----------|-------------|------------------------------|--------|
| T-21-01 | Tampering | skills/propose.ts argv | high | mitigate | /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/skills/propose.ts:388-449 builds fresh branch and literal argv without force/search/colon push; :987-997 creates branch/clone; :1014-1018 checks origin before push. Forbidden-argv tests were inspected, not run by auditor. | closed |
| T-21-02 | Information disclosure | skill content to PR | high | mitigate | /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/skills/propose.ts:207-290 invokes scanSkillFiles and refuses findings, then checks redacted frontmatter; :947-953 validates and caps PR body before subprocesses. PR rationale is whole-text redacted before truncation at :507-537. Shared scanner /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/redact.ts:676-702 projects file/line/rule. | closed |
| T-21-03 | Information disclosure | child env | high | mitigate | Reconciled threat row /root/src/worktrees/agent-substrate-v13-autonomous/.planning/phases/21-skills-propose/21-01-PLAN.md:140 and D21-15 /root/src/worktrees/agent-substrate-v13-autonomous/.planning/phases/21-skills-propose/21-CONTEXT.md:127-132 require four base plus seven fixed Git controls. /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/skills/propose.ts:550-598 implements exactly that explicit env and bounded argv-only execFile; no process.env spread or store/token/handoff forwarding. Behavioral child isolation assertions reviewed at /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/skills/propose.git.test.ts:185-267. | closed |
| T-21-04 | Elevation of privilege | library config | medium | mitigate | /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/config.ts:232-245 requires file:// plus absolute non-default gh for a non-default library; /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/service.ts:1279-1281 refuses configured problem before engine. /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/skills/propose.ts:452-496,815-915,959-967,1015-1016 checks configured slug for mirror/origin/PR/ledger identity. | closed |
| T-21-05 | Spoofing | proposal surface, service | high | mitigate | /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/service.ts:1259-1268 refuses body-surface mismatch before proposer; :1285-1290 sets input surface from caller; :1308-1324 emits as caller. /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/server.ts:401-419 establishes token-derived caller independently of body. | closed |
| T-21-06 | Authentication | anonymous proposal, service | high | mitigate | /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/service.ts:1260-1262 refuses null identity before proposer. Reviewed /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/service.test.ts:2069-2081 also asserts null surface cannot be overridden by an operator boolean. | closed |
| T-21-07 | Repudiation | unaudited publication | high | mitigate | /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/server.ts:343-396 fail-closed REST audit; :757-791 audits object or safe non-object descriptor before shape/action; :802-818 audits authenticated oversize/syntax refusal before responding. MCP :865-905 audits before dispatch. /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/observe.ts:382-432 invokes append/auditMode and blocks on AuditUnavailableError; /root/src/worktrees/agent-substrate-v13-autonomous/packages/audit/src/policy.ts:27 explicitly lists skills_propose; /root/src/worktrees/agent-substrate-v13-autonomous/packages/audit/src/log.ts:293-329 throws on fail-closed sink failure. | closed |
| T-21-08 | Information disclosure | findings/errors, service | medium | mitigate | /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/service.ts:1327-1350 emits rule names only and redacted bounded reasons. /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/skills/request.ts:99-108 projects findings and redacts/caps ProposeFailed; subprocess-output tail redaction exists in /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/skills/propose.ts:604-610. | closed |
| T-21-09 | Denial of service | oversize body | medium | mitigate | /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/server.ts:203-214,297-307 bounds intake; :775-782 and :802-809 give REST413 before proposer. /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/skills/request.ts:52-66 measures caller JSON bytes; /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/mcp.ts:910-919 checks before attribution/service. MCP wire cap is separately 1M+64KiB at server.ts:876-884. CLI JSON preflight is /root/src/worktrees/agent-substrate-v13-autonomous/packages/cli/src/skills.ts:205-211. Exact1M/1M+1 real socket assertions reviewed at /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/http.test.ts:1339-1388,1467-1561. | closed |
| T-21-10 | Tampering | second-door propose | high | mitigate | /root/src/worktrees/agent-substrate-v13-autonomous/packages/cli/src/skills.ts:25 imports engine types only; :165-167 requires token; :214-220 posts to audited /skills/propose with header. No executable engine import, git runner or self-posted event exists in inspected CLI module. /root/src/worktrees/agent-substrate-v13-autonomous/packages/cli/src/index.ts:469-475 supplies env token to HTTP client. | closed |
| T-21-11 | Information disclosure | token handling | medium | mitigate | /root/src/worktrees/agent-substrate-v13-autonomous/packages/cli/src/index.ts:471 reads SUBSTRATE_TOKEN; /root/src/worktrees/agent-substrate-v13-autonomous/packages/cli/src/skills.ts:217 sends only as authorization header. Output/refusal paths report fixed status, result and server metadata, not token/header or request contents. | closed |
| T-21-12 | Tampering | directory intake | medium | mitigate | /root/src/worktrees/agent-substrate-v13-autonomous/packages/cli/src/skills.ts:56-88,169-177 uses lstat, symlink/special-file refusal, fatal UTF-8 decode and size guards. /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/skills/propose.ts:147-290 revalidates names/paths/NUL/conflicts/frontmatter/removals/secrets; :321-382 confines tree, refuses symlink ancestors and removes final symlink before writing. | closed |
| T-21-13 | Isolation failure | skills fixture | high | mitigate | /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/rehearsal-env.ts:119-147,261-277 confines fixture values, always sets scratch state, refuses stale fixture mirror without flag and sets scratch HOME. /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/rehearsal-skills.ts:47-124 builds local file remote/fake gh in run directory; /root/src/worktrees/agent-substrate-v13-autonomous/scripts/rehearsal.ts:1268-1311 ownership-checks teardown and removes run dir; :1365-1377 refuses production ports/non-loopback smoke targets, called at /root/src/worktrees/agent-substrate-v13-autonomous/scripts/skills-propose-smoke.ts:96-101. Parent current up/down0 and two owned store removals separately recorded. | closed |
| T-21-14 | Information disclosure | planted secret | medium | mitigate | /root/src/worktrees/agent-substrate-v13-autonomous/scripts/skills-propose-smoke.ts:132-133 assembles synthetic decoy; :257-270 checks refusal/findings/no branch or gh effect; :327-339 checks absence from REST/MCP response, ledger/events/audit/gh calls/library refs. Parent current skills47/47, not auditor execution. | closed |
| T-21-15 | Tampering | library history | medium | mitigate | /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/rehearsal-skills.ts:85-88 sets denyNonFastForwards/denyDeletes/logging. /root/src/worktrees/agent-substrate-v13-autonomous/scripts/skills-propose-smoke.ts:245-256,295-308 checks refusal branch/call invariance and creation-only reflog. /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/skills/propose.git.test.ts:269-292 includes actual prohibited-update/delete attempts and unchanged-ref assertions, reviewed statically. | closed |
| T-21-16 | Tampering | stale contract docs | medium | mitigate | /root/src/worktrees/agent-substrate-v13-autonomous/docs/skills-propose.md:1-113 covers doors/auth/codes/caps/file-rule/current Git isolation; /root/src/worktrees/agent-substrate-v13-autonomous/.planning/phases/21-skills-propose/21-VALIDATION.md:53-70 maps real tasks. /root/src/worktrees/agent-substrate-v13-autonomous/.planning/phases/21-skills-propose/21-06-SUMMARY.md:48-52 expressly records preserved matrix open/all drift as instructed by /root/src/worktrees/agent-substrate-v13-autonomous/.planning/phases/21-skills-propose/21-06-PLAN.md:89. Parent final phase-close108/0 exit0 is attributed below. No claim that COVERAGE still exactly matches. | closed |
| T-21-17 | Spoofing | proposal surface, REST/MCP | high | mitigate | /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/config.ts:475-478 resolves token surface; /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/server.ts:401-419,783-788 passes transport caller after audit. /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/mcp.ts:185-188,919 uses callerSurface, never body-first attribution. Service :1263-1268 refuses mismatch before engine. | closed |
| T-21-18 | Authentication | anonymous proposal, REST/MCP | high | mitigate | /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/server.ts:474-477 rejects unmapped bearer; :750-755 refuses null proposal surface before readBody even on anonymous run. /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/service.ts:1260-1262 supplies MCP null refusal; /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/mcp.ts:920-924 returns isError for it. | closed |
| T-21-19 | Information disclosure | findings/errors, REST/MCP | medium | mitigate | /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/skills/request.ts:99-108 copies only file/line/rule and redacts/caps failed message at400 chars; shared mapping called at /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/server.ts:786-789 and /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/mcp.ts:920-924. No finding value/span is returned. | closed |
| T-21-SC | Tampering | dependencies, shared | low | accept | All six live PLANs propose no-new-package rationales. Existing /root/src/worktrees/agent-substrate-v13-autonomous/.planning/phases/21-skills-propose/21-SECURITY.md:78-80 has no acceptance and expressly retains SC as open. No acceptance signer/date exists. Repeated reserved ID counts once. | open — below high threshold (non-blocking) |

**Counts:** 20 unique authored threats; 19 CLOSED mitigations; 1 OPEN proposed accept; 0 transfer. OPEN severity is low, below block_on high, so `threats_open = 0`. No missing/unparseable severity and no silently dropped threat.

## Reassessment of Earlier Gaps

### T-21-03 — CLOSED by actual reconciliation and code

The user selected **Keep current Git isolation**. The live plan row, must-have/action wording, CONTEXT D21-15, documentation and SUMMARY amendment now explicitly distinguish four base keys from seven fixed private Git controls. Current childEnv at /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/skills/propose.ts:560-576 returns PATH/HOME/no-prompt flags plus GIT_CONFIG_GLOBAL/SYSTEM=/dev/null, COUNT=2, KEY_0/VALUE_0 empty default credential helper and KEY_1/VALUE_1 GitHub gh credential helper. Only PATH/HOME are read from parent; Git hardening keys are fixed, not copied. The runner uses this explicit object with execFile argv and120-second/4MiB bounds. The old exact-four-key assertion is not certified; it was actually reconciled through the user-selected contract. No hardening was removed, no credential forwarding was added and no risk acceptance was inferred.

Behavioral test source at /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/skills/propose.git.test.ts:185-267 records a real child under poisoned scratch parent env and hostile scratch HOME gitconfig, asserts secret decoys absent, fixed Git values override poisoned controls, and global/system Git configs remain isolated. The auditor inspected these assertions only; parent final suite exercised them.

### T-21-07 — CLOSED including the reproduced refusal-audit gap

The parent originally observed array/null/string400 and oversize413 without new audit records. That observation was ground truth, not dismissed or rerun by auditor. Current REST source audits all parsed attempts: object fields are digested; non-objects use a safe descriptor containing shape and optional string length, never content. Syntax and oversize catches also use fixed descriptors and await auditedRest; denial produces503 and no proposer call. No oversize body is re-read.

Parent current runtime evidence records array22→23, null23→24, string24→25 at400, and oversize25→26 at413: **one safe audit record per attempt**. Static tests at /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/http.test.ts:1241-1307 assert safe descriptors, no proposer call, no decoy content and audit denial dominating malformed requests. Records labelled allowed mean the attempted call reached the pre-dispatch audit, not that malformed input was published.

### T-21-09 — CLOSED without shrinking the caller budget

Current proposalBodySizeProblem measures canonical UTF-8 JSON of the caller body before server-owned surface injection. REST also bounds raw wire bytes. MCP checks schema-valid arguments before service attribution; schema optional fields have no injected defaults. Caller metadata, escaping and multibyte text count; server attribution and JSON-RPC framing do not consume the proposal budget. Exact1,000,000 fits;1,000,001 is refused before proposer/events, including dry-run. Engine text cap remains an internal backstop, not the public body measure.

MCP intake is separately bounded at1,000,000+64KiB. This is framing headroom, not permission for larger proposal content. Over-framing wire is refused before audit/dispatch with the pre-existing generic oversize handling. Reviewed real HTTP assertions at /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/http.test.ts:1467-1561 cover exact1M accepted,1M+1 tool refusal with no proposer and audit record, dry-run rejection, and over-framing rejection. REST no-surface exact1M is accepted and attributed at :1356-1373. Parent final full suite passed; auditor executed none of these.

### T-21-16 — CLOSED through the plan-directed drift record

Current docs cover the actual environment and public budget/framing separation. COVERAGE.md remains read-only and still says --state open while the source builder uses --state all to recover owner-closed PRs. That factual difference is retained, not concealed. Plan06 explicitly instructed recording drift in SUMMARY instead of rewriting the matrix. The actual 2026-10-11 SUMMARY amendment does so and disclaims a match; this satisfies that prescribed disposition, not a fake matrix-match assertion. Historical original SUMMARY claims/metrics remain historical and are qualified by the amendment.

## End-to-End Authority, State and Error Trace

- Bearer resolves surface/operator before body at /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/config.ts:475-510 and /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/server.ts:401-419. REST and MCP both use that caller. Null/mismatched surface and non-operator replace/reopen/nonempty doc-example allowance refuse before engine at /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/service.ts:1259-1281. Swarm/substrate host-job tokens are never operators even if listed. A bare-run operator boolean cannot authenticate null identity.
- CLI regular UTF-8 intake →1M JSON preflight → bearer header → audited REST → same service. No executable engine import, in-process git path, body surface override or self-posted event is introduced.
- Engine validation/scan/redacted frontmatter/PR-text cap → mirror library identity → content lock/library-aware ledger → mirror lock/fetch → shared clone/set-url/fresh branch → confined overlay/removals and staged-file check → diff/commit → origin check/writable-ledger preflight → new-branch push → pushed/opened metadata ledger. Trace /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/skills/propose.ts:815-915,947-1029. File/delete hash tags prevent collision; legacy lookup remains gated by name/surface/library identity. Existing compatibility was read, not changed.
- Dry run bypasses content-ledger lookup/writes/gh, returns staged diff before commit/push at :1005-1008 and emits no event. It still clones/fetches under mirror lock and is audited. Existing/declined return through ledger; unchanged returns before commit/push. Finally removes clone and releases content lock at :1026-1028.
- Findings contain file/line/rule; service warnings contain rule names only. ProposeFailed output and reason are redacted before capping. Audit records store sanitized bounded identifiers/key names plus canonical arg digest, never file bodies, at /root/src/worktrees/agent-substrate-v13-autonomous/packages/audit/src/record.ts:181-247. PR rationale is whole-text redacted before truncation.
- Fixtures use local file remote, injected recording gh, scratch HOME/state and ownership-checked teardown; no host store/token config is forwarded. Source commands are statically reviewed only; their execution belongs to parent.

## Accepted Risks Log

**No accepted risks.** T-21-SC remains OPEN low/non-blocking. Planner rationale and absence of a new dependency do not create an authorized acceptance. Neither the historical 2026-10-08 approval of three wire/CLI/operator decisions nor the 2026-10-11 decision to retain Git hardening accepts supply-chain risk. No transfer dispositions exist.

## Open — Blocking

None at block_on high.

## Open — Non-Blocking

| Threat ID | Severity | Missing Evidence | Effect |
|-----------|----------|------------------|--------|
| T-21-SC | low | Authorized accepted-risk entry/sign-off; no acceptor or date exists | Remains OPEN; does not contribute to threats_open; no risk accepted by auditor |

## Summary Threat Flags

21-01 SUMMARY's original no-unmapped-surface section was read with its2026-10-11 child-env lineage amendment. The other five SUMMARYs have no Threat Flags section. Unregistered flags: none identified in the supplied sections. Missing sections do not imply exhaustive vulnerability coverage. The reproduced audit/cap gaps map to existing T-21-07/T-21-09, not invented unregistered threats. No unrelated vulnerability scan was performed.

## Parent Execution Evidence and Provenance

**Final source gates:** local://v13-final-green-evidence.json reports parent-observed full suite **2719 pass /58 skip /0 fail across96 files**, typecheck exit0, phase-close **108 pass /0 fail /0 skip across4 files**, event kinds12/surfaces27, bash-n exit0 and shellcheck exit0. Formatter: none configured; none run. Original owners corrected first-union engine/framing/fixture errors; final green, not those superseded failures, is the latest gate evidence. Privacy guards remained unchanged. These are shared parent final runs, not separate Phase21 auditor checks.

**Actual isolated runtime:** local://v13-final-runtime-evidence.json records harness up0; actual skills **47/47 exit0** with real git and recording gh; one new audit record for each array/null/string400 and oversize413; harness down0 and **two owned store containers removed**. The runtime receipt's note that final full suite was pending predates and is superseded for source gates only by the later final-green receipt. Its runtime/scope facts remain unchanged. No additional cleanup observation was invented.

The source receipts identify execution at4df30a0 plus owned dirty corrections/pending commits, not a final committed fingerprint. Parent owns final fingerprint and commit metadata. The older2670/58/0 and112-lock results and historical2026-10-09 skills47/47 remain prior provenance, not the current final union metrics. The older shared-context promise of fresh21 proof is now fulfilled by the final runtime receipt; it is not used instead of it.

Phase27 runtime47/47 includes28 ledger/ingest plus19 fake-chain checks and no real devnet; it is not Phase21 proof. Historical Phase27 schema approval is historical operator provenance, not a new audit action. No user checkout, production MCP/configuration/store, real GitHub/tracker/devnet write, model turn or deployment restart was performed by this auditor.

## Explicit Production Exclusions and Pending Global Action

Production surface-token provisioning remains Phase20, with operator actions still0/3 per final parent scope. Phase21 code/isolated proof does not close that prerequisite or authorize deployment. The real skills-library PR remains Phase22 SKILL-07 and retains its operator/live-action approval boundary. No production mirror bootstrap/restart, obsolete propose-key deletion, plugin install or user-scope configuration change occurred here. These remain approved scope exclusions, not downgraded SKILL-01 requirements.

The pre-existing credential incident remains **operator_rotation_pending**, outside authored Phase21/27 register counts. Containment/final green does not revoke the credential; no rotation, risk acceptance or incident closure is claimed.

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-10-10 | 20 | 17 | 3 (1 blocking,2 non-blocking) | Earlier static auditor return, persisted by parent; unreconciled environment and stale-documentation findings |
| 2026-10-11 | 20 | 19 | 1 (0 blocking,1 low non-blocking) | gsd-security-auditor final static reassessment; user-selected actual reconciliation, source audit/cap corrections and separately attributed parent final/runtime evidence |

## Sign-Off

- [x] All20 unique live-plan threats retain category/severity/disposition, including renamed T-21-17/18/19 and shared reserved SC.
- [x] All19 mitigate dispositions are source-backed CLOSED at ASVS L1.
- [x] User-selected private Git controls were actually reconciled and retained, not removed or risk-accepted.
- [x] REST malformed/oversize refusal audit gap and caller-body/framing boundary corrections are source-backed; parent actual proof is attributed.
- [x] Read-only capability matrix drift is explicitly recorded through the plan-prescribed SUMMARY procedure; exact match is not falsely claimed.
- [x] Severity-filtered threats_open0 confirmed; total OPEN remains1 low/non-blocking.
- [x] Fresh parent actual skills47/47 and final2719/58/0 / types0 / phase-close108/0 / shell0 receipts recorded.
- [ ] T-21-SC has an authorized accepted-risk entry — remains OPEN non-blocking.
- [ ] Parent final committed source fingerprint recorded.
- [ ] Parent final phase/external-GSD/release status established; frontmatter remains draft here.

**Verdict:** SECURED for the ASVS L1/block_on high enforcing gate.19 closed,1 low OPEN,0 blocking. **Approval:** no risk acceptance, signed Swarm gate, phase-completion declaration, external-GSD completion or shipping approval issued. Parent persists this artifact and owns final status.
