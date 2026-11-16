---
phase: 51-enterprise-fabric
requirements: [SOTA-07]
status: implemented on gsd/p51-fabric-impl; verification passed at 91d74c7 (delta re-verification, see VERIFICATION.md)
---

# 51-SUMMARY: Enterprise unified resource fabric

## What was executed

Verification ran twice on branch `gsd/p51-fabric-impl`, read-only, with no tests or gates run by the verifier.

- First pass at head `645c2fe`: status `gaps_found`. Criterion 1 failed on its read-only sub-check (the fabric read issued a Greptime write probe). Criterion 2 passed. The goal-level dashboard check failed.
- Re-verification at head `b0feacc`: status `passed`. Both criteria pass with file:line evidence. The goal-level dashboard check passes, with a caveat on the extended-series panels (VERIFICATION.md, Residual risks).
- Delta re-verification at head `91d74c7`, after the Greptile review fixes `b5123ad` and `91d74c7`: status `passed`. Criteria 1 and 2 and the goal pass. Recorded in the "Review-fix round" section below.
- The orchestrator reports `tsc` clean and 396 pass, 0 fail across the fabric, dashboards, metrics and observability tests. Those numbers are not re-run here.

## Phase commits (`git log --oneline 96d23ef..HEAD`)

Rev-list reports 28 commits: 16 phase 51 commits from the first pass, 4 merges, the verification commit `7fb8335`, and 7 fix-up commits from this re-verification round.

Fix-up commits since the first verification (`git log --format='%h %s' 7fb8335..HEAD`):

```
b0feacc fix(metrics): the proxy gauge has no row until boot sets it, as the S6 contract requires (phase 51, SOTA-07)
5dc93dd fix(metrics): the fabric proxy gauge follows the extended-series contract (phase 51, SOTA-07)
fbdfa6b chore(dashboards): regenerate the data-planes dashboard for the fabric row (phase 51, SOTA-07)
e7be6f6 test(dashboards): assert the extended-only row rule, not the full row list (phase 51, SOTA-07)
815f694 feat(dashboards): tailscale-proxy fabric panel from endpoint classes (phase 51, SOTA-07)
1b23736 feat(dashboards): fabric panels for the six resources (phase 51, SOTA-07)
4f9468d fix(fabric): fabric reads never write to the health table (phase 51, SOTA-07)
```

The full list from the first pass is in the verification record at `7fb8335`. Its phase-51 commits are unchanged.

Diff from `7fb8335` to `b0feacc` (the fix-up round): 15 files, +908 −48. Diff from `645c2fe` to `b0feacc`: 17 files, +1035 −48.

## Fix-up effects

- `4f9468d`: the fabric's health probes run with `probeWrites = false` (`service.ts:6085`). The Greptime write verdict is the last one `/healthz` recorded. A fabric read with no verdict since boot reports the Greptime row `unavailable` (`fabric/gather.ts:76`, `:98`, `:101`). A test records every SQL statement and asserts no write on the fabric path (`fabric-mcp.test.ts:435-458`).
- `1b23736`, `815f694`, `fbdfa6b`, `e7be6f6`: one dashboard panel per resource in `FABRIC_RESOURCES`, generated from `FABRIC_SERIES` (`scripts/dashboards.ts:132-139`). The data-planes dashboard carries the six panels (`infra/vps/dashboards/substrate-data-planes.json`, `:128`, `:235`, `:347`, `:468`, `:584`, `:691`). The test asserts the extended-only row rule as a property (`scripts/dashboards.test.ts:134-150`).
- `5dc93dd`, `b0feacc`: the `endpoint.proxy_planes` gauge follows the S6 contract. The constructor no longer sets it. Boot sets it: `observe.ts:300`, called unconditionally from `index.ts:63`. The test fixture adds a setup-only helper that makes the same boot call (`metrics-history.test.ts`).

## Deviations from PLAN.md (remaining)

1. **Tool name.** PLAN and CONTEXT D51-a pin `fabric_suggest`; the code registers `fabric_optimize` (`mcp.ts:1369`). The ROADMAP criterion says "optimization suggestions", so the name is a fair reading.
2. **Six resources.** PLAN lists `railway, greptime, postgres, dragonfly, hindsight, ragflow`. The code reports `dragonfly, timescaledb-index, greptime, ragflow, hindsight, tailscale-proxy` (`fabric/types.ts:10-17`). Railway is not a row; it feeds `fabric_optimize` only (`optimize.ts`). `tailscale-proxy` is a row, although CONTEXT.md treats Tailscale as a dimension.
3. **States.** PLAN has `ok, degraded, down, unconfigured, unknown`. The code has `ok, degraded, unavailable, unconfigured` (`fabric/types.ts:33`). There is no `unknown` state.
4. **Compliance verdicts.** PLAN has `pass | finding | not-applicable`. The code has `PASS | FAIL | NOT_APPLICABLE` (`fabric/types.ts:66`), which matches the task wording and the docs.
5. **Compliance checks.** PLAN's `railway-writes-gated` and `auth-configured` are absent. The code adds `audit-policy-fabric-tools`, `report-redaction`, and `resource-state.<resource>` (`compliance.ts:31-37`).
6. **Suggestion shape.** PLAN pins `id, resource, severity, message, reference`. The code has `id, resource, action, evidence, severity` (`fabric/types.ts:58-64`). No docs `reference` anchor is emitted.
7. **Test layout.** PLAN has one `fabric/fabric.test.ts`. The code has `status.test.ts`, `optimize.test.ts`, `compliance.test.ts`, `gather.test.ts`, and `fabric/fixtures.ts`.
8. **`service.ts` scope.** PLAN limits the change to one `fabricSources()` method. The diff rewrites `health()` into `healthProbes`, `greptimeProbe`, `writeProbeReading`, and `sharedHealthProbes` (`service.ts:5932-6150`). This is the `/healthz` path; parity rests on the commit messages.
9. **"No new probe" (D51-b).** Resolved for writes (fix-up `4f9468d`). The fabric still issues live read probes: a ping, the dialect and append-mode reads, Hindsight and RAGFlow GETs. CONTEXT.md D51-b says "performs no new probe".
10. **Sequencing.** PLAN says code starts after PRs 102 and 103 are merged to `origin/main`. The base `96d23ef` is a merge into `gsd/p48-ci`, which contains the phase 48 and 50 commits. Whether those reached `origin/main` was not checked.

Resolved since the first pass: docs (PLAN required a section in `docs/observability.md`; it is now present, `docs/observability.md:997`), and dashboards (PLAN deferred them under D51-f; the six panels are now built).

## Open items carried forward

- The Greptime row is `unavailable` until `/healthz` records a write verdict since boot. A fabric-only deployment with no `/healthz` poller reads it so, and `fabric_compliance` reports FAIL for it.
- The extended-series panels (`Fabric: hindsight`, `Fabric: tailscale-proxy`) are omitted from a core-only history render (`scripts/dashboards.ts:38`, `:147-179`). The committed JSON is the all-series render.
- Dragonfly reads `unavailable` until a cache command connects (no ping in the cache client; `docs/data-planes.md`).
- Tailscale ACL and forwarder health stay operator-gated (phase 48).

## Dependencies added

None. `git diff 96d23ef..HEAD -- '*package.json' bun.lock bun.lockb` is empty.

## Review-fix round (delta at 91d74c7)

Two commits from the Greptile review, after `9f8a1d5`:

```
91d74c7 fix(healthz): the size read starts when the ping answers, not after the write probe (phase 51, SOTA-07)
b5123ad fix(fabric): a healthy Greptime is not unavailable with the write probe off (phase 51, SOTA-07)
```

- `b5123ad`: `writeUnread` is gated on `writeProbeS > 0` (`service.ts:6126`). With the write probe off, a healthy Greptime reads ok, and the fabric still issues no write. Test: `fabric-mcp.test.ts:461`.
- `91d74c7`: the size read is chained to the ping only (`service.ts:6013-6014`, `greptimePing` at `service.ts:6031`), so a stalled write probe does not hold it. The ping is one shared gate; the write-probe reads run from `greptimeReads` (`service.ts:6036`). Test: `fabric-mcp.test.ts:483`.
- Goal and S6 are unchanged: six `Fabric:` panels in the JSON, six `FABRIC_SERIES` entries (`scripts/dashboards.ts:132-139`), and the boot gauge call at `observe.ts:300` from `index.ts:63`.

Deviations remaining from PLAN.md are the ones listed above (tool name, six-resource composition, state and compliance enums, suggestion shape, test layout, `service.ts` scope, D51-b read probes, sequencing). The Greptime row caveat in Open items is now limited to `SUBSTRATE_LEDGER_WRITE_PROBE_S > 0`.
