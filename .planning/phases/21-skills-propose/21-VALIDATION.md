---
phase: "21"
slug: "skills-propose"
# Canonical lifecycle: final native audit validated with parent-exercised coverage.
status: validated
nyquist_compliant: true
wave_0_complete: true
created: "2026-10-08"
updated: "2026-10-11"
---

# Phase 21 — Validation Strategy

**Verdict: GAPS FILLED — Nyquist-compliant for the approved isolated Phase 21 scope.** G1–G7 consumer-boundary gaps are closed by meaningful landed tests and parent-exercised gates. G8 deletion requirements, original D1–D10 and subsequent D11, are applied without repinning. No named Phase 21 validation gap remains; no Phase 22 live criterion or root requirement is completed by this artifact.

## Scope and evidence provenance

- Sole audit owner: `/root/src/worktrees/agent-substrate-v13-autonomous/.planning/phases/21-skills-propose/21-VALIDATION.md`.
- Reviewed all six PLANs and SUMMARYs, approved CONTEXT, SKILL-01 and roadmap SC1–3, live engine/service/REST/MCP/CLI/fixture/smoke source and affected tests. No implementation, permanent test, fixture, root planning file or other document was changed by this auditor. No command, test, build, lint, gate, formatter or runtime script was executed by this auditor.
- Native workflow: `/root/.agents/gsd-core/workflows/validate-phase.md`, State A. The assignment authorizes static validation only, overriding workflow execution/commit steps. `/root/src/worktrees/agent-substrate-v13-autonomous/.planning/config.json` has no `agent_skills` mapping or explicit Nyquist step-hook setting; no runtime/config query was executed, and no enabled-hook check is claimed. Project `.claude/skills` and `.agents/skills` discovery found no skill index.
- Earlier shared source evidence: `local://v13-phase21-27-gate-context.json` and `local://v13-phase19-real-runtime-evidence.json` recorded **2670 pass / 58 skip / 0 fail**, types 0, locks 112/0 on unchanged source. Current authoritative `local://v13-final-green-evidence.json` records **2718 pass / 58 skip / 0 fail across 96 files, exit 0**, **types exit 0**, **locks 108 pass / 0 fail, exit 0**, vocabulary **12 kinds / 27 surfaces**. These are parent-observed union results, not this child's executions or separate per-file counts. The prior exercised count was 2719/58/0; after exact D11 test-only deletion the parent actually exercised 2718/58/0. No count is inferred and no source algorithm changed for that deletion.
- Final isolated proof: `local://v13-final-runtime-evidence.json`, instance `v13-proof-230c1bd0`, revision described as `4df30a0 plus owned dirty source corrections`: **up exit 0; skills smoke exit 0, 47/47; down exit 0; two owned store containers removed**. Authenticated array/null/string attempts each answered 400 and advanced actual audit records by one; oversize answered 413 and advanced the record by one. No live GitHub/production/operator proof is inferred. Earlier `p21-a6a927a5` 47/47 is preliminary evidence only. Runtime artifact's old finalgreen-pending sentence is superseded by the final-green artifact and parent reconciliation message.
- Historical evidence remains historical: `/root/src/worktrees/agent-substrate-v13-autonomous/.planning/phases/21-skills-propose/21-BASELINE.md` records base `8174d8c`, **1605/57/1**, typecheck 0; the six SUMMARYs and old VERIFICATION record **1851/57/0**, fixture **47/47**, historical teardown, and later restacked **1914/57/0**. None is this auditor's execution. The original approval and mutation counts are not renewed here.
- Parent reports canonical authored-threat duplicate count **0** for Phase 21, with no waiver. Signing-key variables are not prerequisites for this native source/requirements audit.

## Test infrastructure and parent-only commands

Framework: `bun:test`, colocated `*.test.ts`; package engine requires Bun >=1.4.0. Runner and scripts are declared in `/root/src/worktrees/agent-substrate-v13-autonomous/package.json`; TypeScript config is `/root/src/worktrees/agent-substrate-v13-autonomous/tsconfig.json`. No framework/dependency installation is needed.

Every command below is **for the parent only**, with working directory `/root/src/worktrees/agent-substrate-v13-autonomous`. Absolute paths deliberately prevent execution in the user's root checkout. Commands identify coverage; listing one does not assert that a missing test exists or ran.

| ID | Automated command |
|----|-------------------|
| E | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/skills/propose.test.ts` |
| G | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/skills/propose.git.test.ts` |
| C | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/config.test.ts` |
| S | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/service.test.ts` |
| H | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/http.test.ts` |
| M | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/mcp.test.ts` |
| R | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/skills/request.test.ts` |
| O | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/observe.test.ts` |
| A | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/packages/audit/src/policy.test.ts` |
| L | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/packages/cli/src/skills.test.ts` |
| F | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/rehearsal-skills.test.ts` |
| I | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/rehearsal-env.test.ts` |
| Q | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/scripts/rehearsal.test.ts` |
| P | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/scripts/skills-propose-smoke.test.ts` |
| FULL | `bun test /root/src/worktrees/agent-substrate-v13-autonomous` |
| TYPES | `bunx tsc --noEmit --project /root/src/worktrees/agent-substrate-v13-autonomous/tsconfig.json` |
| LOCKS | `bun /root/src/worktrees/agent-substrate-v13-autonomous/scripts/phase-close-check.ts` |
| PROOF | `bun /root/src/worktrees/agent-substrate-v13-autonomous/scripts/rehearsal.ts up --name v13-proof-230c1bd0 --skills-fixture` → parent loads only that instance's consumer environment → `bun /root/src/worktrees/agent-substrate-v13-autonomous/scripts/skills-propose-smoke.ts` → `bun /root/src/worktrees/agent-substrate-v13-autonomous/scripts/rehearsal.ts down --name v13-proof-230c1bd0` |

Parent runs the final union once after all changes, not concurrent child checks. No measured latency or determinism probe is claimed here. The old estimated 120-second feedback assertion is not renewed.

## Per-task verification map

Task IDs resolve to the real six-plan split. **Green (parent)** means the meaningful behavioral assertions were statically reviewed and belong to the parent's exercised final green union; it is not an independent per-file run by this auditor. Metadata/document tasks are static review, not behavioral automation. All named gaps and deletion/result reconciliation are closed.

| Task ID | Plan / wave | SKILL-01 behavior / acceptance | Canonical threat refs | Deterministic isolated coverage and parent smoke | Commands | Status |
|---------|-------------|-------------------------------|-----------------------|------------------------------------------------|----------|--------|
| 21-01-01 | 01 / 1 | Phase 16/17/18 prerequisites and original execution-base counts | — | Original BASELINE preserves all prerequisite and count evidence; presence/source grep is metadata, not a consumer test | Historical BASELINE; FULL, TYPES for final source | Static evidence retained |
| 21-01-02 | 01 / 1 | SC1–2: validation, redaction, confined overlay/replace/removals, branch/PR, origin guard, no force, locks, ledger/dedupe, errors and dry run | T-21-01, T-21-02, T-21-03, T-21-04 | E: no-runner refusals, safe findings, tree confinement, OPEN/CLOSED/MERGED/pushed/legacy/library transitions, mixed OPEN precedence, malformed-gh controlled failures, create-failure retry on same branch, concurrent one push/create, ledger refusal/recovery. G: real refs/reflog/redelivery, real poisoned child, hostile config isolation, denied rewrite/delete, existing-ledger real diff/no gh/unchanged ledger. PROOF (a–f) uses real git through all three doors | E, G, PROOF | Green (parent); incidental/tautological slices deleted |
| 21-01-03 | 01 / 1 | D21-13 defaults; local file remote plus absolute non-default gh; invalid config warns and refuses without crash | T-21-04 | C: valid/invalid combinations and warning; S: invalid library never reaches proposer. PROOF exercises valid fixture config | C, S, PROOF | Green (parent); user-selected hardening lineage reconciled |
| 21-02-01 | 02 / 2 | SC3 / D21-01–06, 11, 17: caller authority; any authenticated surface; events fail open; dry-run silence | T-21-05, T-21-06, T-21-08 | S: null even with operator flag, match/mismatch, each privilege, swarm/host, each success/refused/failed event, absent/empty session, failed/throwing emit preserves result/error. E/G add existing-ledger dry-run outcomes; H/M/L cover external callers; PROOF covers attribution/events | S, E, G, H, M, L, PROOF | Green (parent) |
| 21-02-02 | 02 / 2 | D21-17 actual note/refused/failed event contract and vocabulary entry | T-21-08 | S asserts actual emitted kinds/actions/payloads without content; PROOF queries stored notes/warnings. Declaration/sample-only skills assertions removed; generic doc-equality checks remain metadata only | S, PROOF | Green (parent) |
| 21-03-01 | 03 / 3 | SC1–3 / D21-08–11: REST/MCP auth, result/error mapping, caller-body cap, audit and dry run | T-21-18, T-21-17, T-21-07, T-21-19, T-21-09 | H: prior 401/403/status/finding/error cases plus safe non-object/malformed/oversize audit, denial precedence, exact 1M/1M+1 UTF-8 with escapes/metadata, no surface-attribution budget charge, real MCP denial including dry_run, real MCP cap/framing. M: protocol result/refusal and caller-body cap. PROOF adds actual rejection audit readback | H, M, R, PROOF | Green (parent); WR-01 resolved |
| 21-03-02 | 03 / 3 | SC3 / D21-18 discoverable tool, stable labels, explicit fail-closed action | T-21-07, T-21-16 | M runtime discovery/schema; O public normalization/labeling; H actual REST audit/503 and real MCP JSON-RPC -32000/no proposer for ordinary and dry-run calls. Source-regex wiring assertions deleted | M, O, H, PROOF | Green (parent) |
| 21-04-01 | 04 / 2 | D21-07–10 directory intake, flags, bearer, JSON cap, output/status/errors | T-21-10, T-21-11, T-21-12 | L actual stub socket/body/header; symlink/non-UTF8/missing paths; real FIFO named refusal/no post; exact 1M post and 1M+1 refusal including escaping/metadata; no token/invalid flags; five statuses/findings/errors/timeout. PROOF uses actual CLI/server | L, PROOF | Green (parent); FIFO fixture intentionally Linux-specific |
| 21-04-02 | 04 / 2 | D21-07 real dispatch/help/usage and HTTP-only behavior | T-21-10, T-21-11 | L spawned CLI success bearer/header, no-token/refusal exit and usage; module help/unknown subcommand; PROOF real CLI opened | L, PROOF, TYPES | Green (parent) |
| 21-05-01 | 05 / 4 | D21-21 isolated fixture, bare library/mirror, recording gh, rebuild/removal | T-21-13, T-21-15 | F installed real child, unsupported/missing-head refusal, concurrent PRs, rebuild/removal; I run-dir/no-fixture/outside/.. refusals; G denied rewrite/delete refs unchanged and production runner isolation. Internal fixture source/layout pins removed | F, I, G, PROOF | Green (parent) |
| 21-05-02 | 05 / 4 | D21-22 safe fixture flag/guards, truthful parsers and proof clauses | T-21-13, T-21-14, T-21-15 | Q typo/extra argument and production-port/non-loopback refusals; P independent branch near-misses/rewrite/SSE/error cases; fixture-text/self-agreement tests deleted; actual smoke checks 47 observations | Q, P, PROOF | Green (parent), 47/47 |
| 21-05-03 | 05 / 4 | D21-22–23 proof chain, baseline comparison and cleanup | T-21-13, T-21-14, T-21-15 | Final parent up 0 / skills 47/47 exit 0 / down 0, two owned store containers removed; latest actual source union 2718/58/0 after D11 deletion, types 0, locks 108/0; immutable historical baseline retained | PROOF, FULL, TYPES, LOCKS | Green (parent), exercised source/proof |
| 21-06-01 | 06 / 5 | D21-19 contract/config/env/rehearsal/audit/event pointers | T-21-16 | Static docs review; user-selected four base plus seven fixed Git controls recorded in PLAN/CONTEXT/docs; public caller-body and separate bounded framing budgets explicit | Static review; behavioral commands above | Reconciled metadata; no grep-as-behavior claim |
| 21-06-02 | 06 / 5 | All task IDs mapped; capability drift honestly recorded | T-21-16 | All 14 tasks mapped; immutable COVERAGE open→all drift recorded in 21-06-SUMMARY amendment per plan, not falsely declared matching; D1–D11 deleted without repinning | Static review; E/PROOF recovery | Reconciled metadata and parent green consumer coverage |

## Boundary, transition, error and precedence assessment

- **Authority precedence covered:** H sends >1 MB anonymously and still gets 401/no proposer; S refuses null caller even with an operator flag; mismatch and each privilege refuse before proposer/event. Equal/absent surface and ordinary swarm/host callers remain accepted.
- **Audit precedence covered:** H exercises safe descriptors for non-object/oversize/malformed input, and 503/no proposer when audit denial dominates malformed objects, non-objects or invalid JSON. Actual isolated runtime array/null/string/oversize calls advanced audit records by one. Parent-reported WR-01 is resolved by owner changes and exercised evidence, not accepted as a deviation.
- **Exact content boundary covered:** H/L construct valid serialized UTF-8 caller bodies at 1,000,000 and 1,000,001 bytes including multibyte text, escaping and metadata. H real MCP calls prove exact caller-body acceptance, over-body refusal, dry-run refusal and bounded 64 KiB framing headroom. Internal E file-text backstop tests are not substituted for wire coverage.
- **Transitions covered:** existing OPEN/CLOSED/MERGED/pushed/legacy/library/concurrent outcomes are retained; E now rejects malformed gh list/view output without publication, preserves OPEN precedence in either row order, and retries failed create using the recorded branch without another push.
- **Errors covered:** origin/mirror/ledger/push failures remain safe; malformed external gh data now yields controlled ProposeFailed. H proves transport refusal and zero proposer effects; S proves emit/storage faults do not change proposal result/error.
- **Existing-content dry run covered:** E verifies clone/diff/no gh/no push/byte-identical ledger; G obtains actual staged diff counts with real git after OPEN/CLOSED/pushed records. S still proves no events on success/refusal/failure; H proves dry-run audit and MCP denied-audit behavior.
- **Proof limits:** 47/47 opens through all three doors; existing/declined/unchanged smoke sequence is REST-only and privilege refusals primarily REST. Independent protocol/CLI/unit cases fill the mapped other-door coverage. No real GitHub credential, GitHub publication, devnet/model/operator turn or production claim is made.

## Explicit gap resolution

**Named gaps remaining: none. G1–G8 FILLED.** Meaningful G1–G7 assertions run green in the parent's actual final union; G8 D1–D11 deletion requirements are satisfied and retained consumers remain green. This auditor authored/executed no tests: closure relies on reviewed assertions plus observed parent results, never merely test-file creation, internal snapshots or a fabricated independent run.

| Gap | Task / requirement | Landed behavioral evidence; plausible regression caught | Actual source / command | Status |
|-----|--------------------|---------------------------------------------------------|-------------------------|--------|
| G1 | 21-03-01; D21-09/11/18, T-21-07 | Non-object/malformed/oversize requests are recorded without content before 400/413; invalid-input plus audit-denial gives 503/no proposer. Actual twin rejection audit counts advanced. Catches unaudited error exits and validation-before-audit bypass | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/http.test.ts:1241-1297,1375-1390`; H plus final runtime | FILLED, parent green; WR-01 resolved |
| G2 | 21-03-01/02; SC3, D21-18, T-21-07 | Actual /mcp calls with unavailable audit return JSON-RPC -32000, exact caller IDs/tool reason and no proposer; dry_run does not bypass gate. Catches missing/wrong policy or dispatcher placement | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/http.test.ts:1417-1465`; H | FILLED, parent green |
| G3 | 21-01-02,21-03-01,21-04-01; D21-08, T-21-09 | UTF-8/escape/metadata caller bodies at 1M succeed and 1M+1 refuse/no proposer or no CLI post; no server-attribution budget charge; actual MCP socket framing bounded separately. Catches off-by-one/characters/files-only/attribution/framing mistakes | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/http.test.ts:1339-1390,1467-1561`; `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/mcp.test.ts:716-729`; `/root/src/worktrees/agent-substrate-v13-autonomous/packages/cli/src/skills.test.ts:224-248`; H/M/L | FILLED, parent green; D11 not counted |
| G4 | 21-01-02,21-05-01; D21-15/21, T-21-03/13/15 | Real createExecFileRunner child executes configured probe, excludes scratch credential/store/handoff poison, replaces poisoned controlled Git keys with fixed controls, keeps hostile HOME global/system gitconfig unread; rewrite/delete attempts leave actual refs unchanged. Catches missing env filtering/config isolation/history protection | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/skills/propose.git.test.ts:185-291`; G | FILLED, parent green; controls overridden, not incorrectly expected absent |
| G5 | 21-04-01; D21-07/20, T-21-12 | Actual FIFO path produces exit 1 and names relative special-file path with no HTTP post; catches reads/hangs/silent omissions | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/cli/src/skills.test.ts:204-214`; L | FILLED, parent green; WARNING: intentional Linux/mkfifo fixture |
| G6 | 21-01-02; SC2, D21-09/16, T-21-01/08 | Malformed gh output produces controlled failure/no new push-create; mixed rows preserve OPEN precedence; failed create retry reuses saved branch. Catches TypeError and duplicate publication/wrong declined precedence | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/skills/propose.test.ts:966-1036`; E | FILLED, parent green |
| G7 | 21-01-02/21-02-01; D21-11, T-21-07/08 | Previously OPEN/CLOSED/pushed content still clones/diffs for dry run; no gh/push or ledger change, real staged counts; S no-event and H transport-audit tests retained. Catches dedupe-before-dry-run shortcut | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/skills/propose.test.ts:1038-1082`; `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/skills/propose.git.test.ts:294-365`; E/G plus S/H | FILLED, parent green |
| G8 | Deletion findings across 21-01/02/03/04/05/06 | D1–D10 whole-argv/hash-clone/wiring/source/copy/incidental slices and D11 unused-envelope tautology removed, not repinned; meaningful mapped consumer assertions retained. Parent full union actually green after final deletion | Original locations retained below as historical pointers, not current line anchors; FULL 2718/58/0 after D11 deletion | FILLED; D1–D11 applied, parent green |

## Specific deletion findings (not coverage credit)

**Original D1–D10: applied, not repinned.** Their test/assertion slices are absent in the reviewed updated files. Paths/line numbers below preserve the initial reviewed snapshot for provenance and are not current edit anchors. Runtime discovery/normalization and semantic safety behavior were retained. The parent owns all test changes.

| Finding | Exact reviewed location | Why deletion, not repinning |
|---------|-------------------------|-----------------------------|
| D1 | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/skills/propose.test.ts:461-473`, “argv builders are exact” | Copies implementation argv/layout. Preserve semantic forbidden force/refspec/search tests and real-git consumer effects |
| D2 | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/skills/propose.test.ts:320-324`, hash algorithm reconstruction; `339-342`, pre-tag-hash inequality; `913-915`, default object equals its own constants | Algorithm/self-consistency pins rather than proposal identity outcomes. Keep reordered-equal/mode-removal-different and actual old-ledger redelivery/collision tests |
| D3 | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/skills/propose.test.ts:591`, exact full step list; `596-599`, exact commit argv/message slice; `769-781`, private lock-position assertions | Internal sequence/layout. Keep publication-before-origin/ledger refusals, public content hash/provenance, concurrent one-create and cleanup outcomes; replace chronology credit only with observable failure injection |
| D4 | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/skills/propose.test.ts:919-945`, copied childEnv object/key list; `948-951`, childBinary mapping; `981-1001`, createSkillProposer binding-only tests | Wiring/helper return snapshots do not prove actual subprocess isolation or default service behavior. G4 observes the real runner; normal engine/smoke tests prove proposals |
| D5 | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/skills/request.test.ts:61-83`, “carries only”, “carries every optional”, “drops a field” | Object-copy helper pins. Keep shape validation and safe failure mapping; H/M/L exercise public option handling and non-operator authority |
| D6 | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/audit/src/policy.test.ts:108-119`, skills source-regex/set wiring test; `121-135`, source-discovery regex test | Reads code text, not execution. Other explicit policy I/O tests may remain policy-unit tests but cannot substitute for G2; M runtime discovery and H real audit are consumer evidence |
| D7 | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/event-sources.test.ts:203-214`, skills row/sample literals | Tests a declaration/sample rather than actual emitted events. S already independently asserts actual kinds/actions/payloads for success/refusal/failure. Generic doc drift tests are metadata checks only, not SKILL-01 behavior |
| D8 | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/rehearsal-skills.test.ts:172-178`, fake wrapper source pins; `264-269`, exact incidental directory entries; `285-294`, builder-to-origin-helper/self-label agreement | Wrapper text and artifact-layout/identity pins. Keep real installed-child, missing-head, rebuild/removal and real proposal tests |
| D9 | `/root/src/worktrees/agent-substrate-v13-autonomous/scripts/skills-propose-smoke.test.ts:35-38`, pattern agrees with engine; `79-84`, fixture skillMd text | Two implementation helpers can agree while violating accepted branch shape; fixture strings are not consumer behavior. Keep independent near-miss branch examples and parser/ref-log negative cases |
| D10 | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/cli/src/skills.test.ts:337`, error prototype; `365-367`, constant equality; `/root/src/worktrees/agent-substrate-v13-autonomous/scripts/rehearsal.test.ts:344-349`, Docker source regex | Incidental structure/source text. Keep CLI path/refusal/result tests; use G3 real cap thresholds and actual child/argv records instead of code-text scans |

**D11 — applied, not coverage:** the prior `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/skills/propose.test.ts:1133-1141` “a JSON-RPC envelope over the cap does not change the engine verdict” built an envelope never supplied to the SUT. Parent removed that exact nine-line test, not repinned it; the reviewed current file now closes the describe at line 1133. Real H /mcp wire/body/framing assertions independently fill G3 and remain unchanged. Parent's post-deletion full run is actually 2718/58/0.
Runtime MCP listTools/schema discovery and public route/tool label normalization are intentionally retained: these are client-visible outputs required by SC3, not source inspection. Repo store/redaction/vocabulary locks remain independent safety constraints, not evidence for a missing SKILL-01 consumer behavior.

## Contract/metadata reconciliation

- **Threat rename resolved here:** plan 21-03 uses **T-21-18** anonymous authentication, **T-21-17** surface spoofing, **T-21-19** findings/errors. Plan 21-02 retains T-21-06/T-21-05/T-21-08 for its service boundary; these are distinct authored IDs, not aliases to reintroduce. T-21-07 audit and T-21-09 cap remain unchanged. Generic former “T-21 authn/input/leak” labels are not used as canonical refs.
- **D21-15 reconciled by user choice:** `/root/src/worktrees/agent-substrate-v13-autonomous/.planning/phases/21-skills-propose/21-01-PLAN.md:32,140` and `/root/src/worktrees/agent-substrate-v13-autonomous/.planning/phases/21-skills-propose/21-CONTEXT.md:127-132` now explicitly record user-selected “Keep current Git isolation” (2026-10-11): four base keys plus seven fixed Git controls. `/root/src/worktrees/agent-substrate-v13-autonomous/docs/skills-propose.md:100` matches. G4 observes actual children: excluded credentials are absent, controlled poisoned keys are overwritten with approved fixed values; no false all-undefined claim or hardening rollback.
- **Capability matrix drift reconciled per plan:** immutable `/root/src/worktrees/agent-substrate-v13-autonomous/.planning/phases/21-skills-propose/COVERAGE.md:14` retains --state open; shipped engine uses --state all with state fields. `/root/src/worktrees/agent-substrate-v13-autonomous/.planning/phases/21-skills-propose/21-06-SUMMARY.md:48-52` records this exact drift and reason as required by plan 21-06. The old matrix is not declared matching, changed, or used as a false behavior oracle.
- **MCP response/budget limits explicit:** actual audit denial is transport JSON-RPC -32000, not tool isError; docs explain it and G2 exercises it. Public caller JSON budget is 1,000,000 UTF-8 bytes before server attribution; MCP wire intake has a separate bounded 64 KiB framing allowance, not larger proposal permission. G3 uses actual calls, not unused envelope strings.

## Manual-only and production follow-on boundaries

No Phase 21 consumer requirement is moved to manual-only or SKIP. G1–G8 are filled; D1–D11 are applied without repinning. Remaining scope limitations below are approved production follow-ons and environment caveats, not silently waived Phase 21 requirements.

The approved first real PR/owner merge/mined-skill propagation proof is **SKILL-07, Phase 22**, not a Phase 21 missing fixture step and not completed by 47/47 recording-gh checks. Production identity is Phase 20; production restarts/mirror provisioning, sync/bridge/miners and removal of the unused propose-key file remain their approved follow-on scopes. No live credential, signing key, model turn or operator approval is requested to replace deterministic isolated testing.

The unrelated credential incident/operator rotation outside the authored Phase 21/27 STRIDE registries remains pending; this artifact does not close it. Historical Phase 27 schema approval is not a new action by this audit.

## Wave 0 and sign-off

- [x] Existing Bun infrastructure and parent shared green results identified, with no duplicate execution claim.
- [x] All 14 real tasks mapped; independent SC1–3 and authority/events/error cases distinguished from copy/wiring checks.
- [x] Threat references use the renamed 21-03 IDs and preserve the service boundary's separate IDs.
- [x] G1–G7 consumer-boundary tests reviewed and part of the parent's exercised final green union; owner source fixes resolved actual defects rather than suppressing errors.
- [x] Original D1–D10 deletion findings applied without repinning; required consumer behavior retained.
- [x] Parent final post-repair source and isolated runtime proof evidence supplied; down 0 and two owned store containers removed.
- [x] User-selected controlled child-env hardening and immutable capability drift reconciled in approved artifacts.
- [x] D11 exact deletion observed and parent actual post-deletion 2718/58/0 count recorded, with no inference.
- [x] `nyquist_compliant: true` / `wave_0_complete: true` supported by complete named behavioral coverage/deletions and parent gates.

**Approval:** native validation reconciled 2026-10-11 against meaningful current assertions, parent latest full 2718/58/0, types 0, locks 108/0 and actual isolated skills 47/47/down 0. Canonical `status: validated`, `nyquist_compliant: true`, `wave_0_complete: true` applies only to the approved Phase 21 validation scope. No independent child execution, root phase/requirement completion, live Phase 22 proof or justified SKIP is claimed.

## Validation Audit

**2026-10-10 — native static re-audit**

| Metric | Result |
|--------|--------|
| Real plan tasks mapped | 14 / 14 |
| Explicit validation gaps found | 8 (G1–G8) |
| Gaps FILLED by this auditor | 0 |
| Gaps escalated | 8; G1 is parent-reported WR-01, the others are uncovered test/deletion requirements |
| Permanent tests created / executions | 0 / 0 (assignment restriction) |
| Existing source suite | Parent shared 2670 pass / 58 skip / 0 fail, not a new Phase 21 run |
| Fresh Phase 21 fixture proof | Parent 47/47, up 0 / smoke 0 at 4df30a0; current teardown and post-repair source gates pending |
| Nyquist outcome | PARTIAL; no waiver, no fabricated pass, no Phase 22 live criterion completion |

## Validation Audit

**2026-10-11 — final parent evidence reconciliation**

| Metric | Result |
|--------|--------|
| Real plan tasks mapped | 14 / 14 |
| Named validation gaps resolved | G1–G8 FILLED; meaningful assertions reviewed, deletion requirements applied and parent green |
| Deletion findings | D1–D11 applied, not repinned |
| Remaining named gaps | None |
| Auditor permanent tests / executions | 0 / 0; only this owned artifact updated |
| Parent latest actual source gates | Full 2718 pass / 58 skip / 0 fail, 96 files, exit 0 after D11 deletion; preceding actual full was 2719/58/0; types 0; locks 108/0, exit 0 |
| Parent final actual skills proof | 47/47, exit 0; up 0 / down 0; two owned store containers removed |
| Actual rejection audit readback | array/null/string 400 and oversize 413; one audit record added for each |
| Metadata / follow-on limits | Zero threat-ID duplicates; user fixed-Git choice reconciled; matrix drift recorded; SKILL-07/production/operator/credential incident not closed |
| Nyquist outcome | GAPS FILLED; validated / nyquist_compliant true / wave_0_complete true; no waiver or child execution |
