---
phase: 51-enterprise-fabric
requirements: [SOTA-07]
status: implemented on gsd/p51-fabric-impl; verification gaps_found (see VERIFICATION.md)
---

# 51-SUMMARY: Enterprise unified resource fabric

## What was executed

This pass was a read-only verification of branch `gsd/p51-fabric-impl` at head `645c2fe1098a1f2c52d845359e18c4152abc5225`. No tests, typecheck, lint, install or gate was run; the orchestrator runs them.

- Read CONTEXT.md, PLAN.md, the fabric modules under `packages/mcp-server/src/fabric/`, `fabric-mcp.test.ts`, and the three tool registrations in `mcp.ts`.
- Traced the read path: `mcp.ts:1348-1351` → `gatherFabricFacts` (`fabric/gather.ts:54-139`) → `service.ts:6103-6139` (`fabricSources`) → `health()` probes → `greptime.ts` write probe.
- Checked the audit and admission tables (`admission.ts:216-218`, `observe.ts:652-654`, `packages/audit/src/policy.ts`).
- Searched the dashboards and docs for the fabric and the six resources (search and counts in VERIFICATION.md).
- Checked `package.json` and lockfile changes across `96d23ef..HEAD`.
- Wrote VERIFICATION.md (status `gaps_found`: criterion 1 FAIL on its read-only sub-check, criterion 2 PASS; goal-level dashboard check FAIL).

## Phase commits (`git log --oneline 96d23ef..HEAD`)

20 commits: 16 phase 51 commits and 4 merge commits.

```
645c2fe fix(fabric): a stalled write is unavailable, and the size read is off the Greptime row (phase 51, SOTA-07)
9284513 test(fabric): size fixture matches LedgerCapacity (phase 51, SOTA-07)
54c38d5 fix(fabric): run every Greptime read after the ping concurrently (phase 51, SOTA-07)
4f5109f fix(fabric): run the Greptime write probe and size read together (phase 51, SOTA-07)
579c28a fix(fabric): /healthz jobs row matches main in the half-open state (phase 51, SOTA-07)
a68d834 fix(fabric): per-plane deadlines and half-open jobs deferral (phase 51, SOTA-07)
95fd337 test(fabric): assemble the Greptime URL key at runtime (phase 51, SOTA-07)
70d9512 test(fabric): type recorded ping timeouts as number or undefined (phase 51, SOTA-07)
c92b675 fix(fabric): the Greptime bound applies to the fabric path only (phase 51, SOTA-07)
44d098a fix(fabric): per-plane health probes, one health window, backlog under any breaker (phase 51, SOTA-07)
eae3fbf Merge remote-tracking branch 'origin/ci/github-hosted-runners' into gsd/p51-fabric-impl
6dec331 Merge remote-tracking branch 'origin/ci/github-hosted-runners' into gsd/p51-fabric-impl
1bbfbdd fix(fabric): typed optimise test, lock-clean compliance check name, Dragonfly limitation documented (phase 51, SOTA-07)
d54f5a6 docs(fabric): unified resource fabric section (phase 51, SOTA-07)
a6e0a62 feat(fabric): fabric_status, fabric_optimize and fabric_compliance tools (phase 51, SOTA-07)
cd0d50d feat(fabric): optimisation suggestions and compliance report (phase 51, SOTA-07)
e8b8a01 feat(fabric): status across six resources (phase 51, SOTA-07)
4e62965 Merge branch 'gsd/v15-48-proxy' into gsd/v15-51-fabric
3c9a593 Merge remote-tracking branch 'origin/main' into gsd/v15-51-fabric
87c2bdc Phase 51 context and plan: unified resource fabric (SOTA-07)
```

Diff against base: 20 files, +2119 −52 (`git diff --stat 96d23ef..HEAD`), taken on the tree at head. The merge commits bring in no manifest or lockfile change (see Dependencies).

## Deviations from PLAN.md

1. **Tool name.** PLAN pins `fabric_suggest`; the code registers `fabric_optimize` (`mcp.ts:1369`). The ROADMAP criterion says "optimization suggestions", so the name is a fair reading, but PLAN and CONTEXT D51-a still say `fabric_suggest`.
2. **Six resources.** PLAN lists `railway, greptime, postgres, dragonfly, hindsight, ragflow`. The code reports `dragonfly, timescaledb-index, greptime, ragflow, hindsight, tailscale-proxy` (`fabric/types.ts:10-17`). Railway is not a row; it is an input to `fabric_optimize` only (`optimize.ts:139-158`). `tailscale-proxy` is a row, although CONTEXT.md treats Tailscale as a dimension, not a row.
3. **States.** PLAN has `ok, degraded, down, unconfigured, unknown`. The code has `ok, degraded, unavailable, unconfigured` (`fabric/types.ts:33`). There is no `unknown` state; a missed deadline reads `unavailable` with the reason in `source` (`gather.ts:45-47`).
4. **Compliance verdicts.** PLAN has `pass | finding | not-applicable`. The code has `PASS | FAIL | NOT_APPLICABLE` (`fabric/types.ts:66`), which matches the task wording and the docs.
5. **Compliance checks.** PLAN's `railway-writes-gated` and `auth-configured` are absent. The code adds `audit-policy-fabric-tools`, `report-redaction`, and `resource-state.<resource>` (`compliance.ts:31-37`).
6. **Suggestion shape.** PLAN pins `id, resource, severity, message, reference`. The code has `id, resource, action, evidence, severity` (`fabric/types.ts:58-64`). No docs `reference` anchor is emitted.
7. **Test layout.** PLAN has one `fabric/fabric.test.ts`. The code has `status.test.ts`, `optimize.test.ts`, `compliance.test.ts`, `gather.test.ts`, and a new `fabric/fixtures.ts`.
8. **Docs.** PLAN requires a new section in `docs/observability.md`. It is not in the diff. `docs/data-planes.md:233-243` was updated.
9. **`service.ts` scope.** PLAN limits the change to one `fabricSources()` method. The diff rewrites `health()` into `healthProbes`, `greptimeProbe`, `writeProbeReading`, and `sharedHealthProbes` (`service.ts:5932-6088`). This is the `/healthz` path; parity rests on the commit messages.
10. **"No new probes" (D51-b).** The fabric issues the health probes, including the GreptimeDB write probe (`service.ts:6038` → `greptime.ts:1779-1785`). CONTEXT.md says it "performs no new probe". This also conflicts with D51-a ("No writes") and makes "it changes nothing" in the tool descriptions inaccurate (VERIFICATION.md, criterion 1).
11. **Sequencing.** PLAN says code starts after PRs 102 and 103 are merged to `origin/main`. The base `96d23ef` is a merge into `gsd/p48-ci` containing the phase 48 and phase 50 commits. Whether those reached `origin/main` was not checked.
12. **Dashboards.** Not built. CONTEXT.md D51-f excludes them from acceptance. The goal-level check in VERIFICATION.md is FAIL.

## Dependencies added

None. `git diff 96d23ef..HEAD -- '*package.json' bun.lock bun.lockb` is empty, and the 20-file stat has no manifest or lockfile.

## Open items carried forward

- Dragonfly reads `unavailable` until a cache command connects (the cache client has no ping; `docs/data-planes.md:243`).
- The fabric's GreptimeDB write probe (criterion 1 gap) needs a decision: remove it from the fabric path, or disclose it.
- No dashboard for the fabric or the six resources.
- Tailscale ACL and forwarder health stay operator-gated (phase 48).
