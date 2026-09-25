# Phase 2 — Linear issues archived to free issue slots

Owner decision (relayed by Main during 02-01): the agent may archive old Linear issues so that
`issueCreate` works again. The rules: completed or canceled state type only, oldest `updatedAt`
first. Skip anything in the substrate index, anything with an `agent:*` or `dispatch:*` label,
and anything updated in the last 14 days. Archive in batches of 5, with a hard cap of 10.

**Unarchive method:** the `issueUnarchive(id: String!)` mutation, with the issue UUID below
(`mutation { issueUnarchive(id: "<id>") { success } }`), sent under the same systemd-run
EnvironmentFile pattern as every other keyed Linear call.

## Candidates (listed 2026-09-25T01:32Z, read-only)

Filter: team SWC, state type in {completed, canceled}, `updatedAt` < 2026-09-11T01:32:15Z (14 days
back), not archived, no `agent:*`/`dispatch:*` label, and `graph_find` returns `found:false`, not
ambiguous, for both the id and the identifier. Linear returned **3** issues, and all 3 passed the
exclusions:

| identifier | id | title | state | updatedAt | archivedAt |
|---|---|---|---|---|---|
| SWC-113 | c6f40946-1004-4ea5-b014-906bdd5b598b | [Scout] Travel tech organizers — product-ranking gate | Done (completed) | 2026-08-12T16:26:35.394Z | not archived |
| SWC-284 | 0a2d11e2-6703-4cb0-84cd-f565cce23a35 | [NO-GO] Solid shampoo + conditioner bar duo with travel tin | Canceled (canceled) | 2026-08-24T01:55:31.228Z | not archived |
| SWC-285 | cff0b41b-037e-4869-91e1-e2852ef1323b | [Locate] Reusable bamboo cotton rounds set with mesh wash bag (30–40 pads) | Canceled (canceled) | 2026-08-24T02:37:11.299Z | not archived |

## Why nothing was archived

Workspace usage, observed read-only on 2026-09-25 through `issues(includeArchived: …)` pagination:

- Not archived: **275**. By state type: backlog 94, unstarted 174, started 4, completed 1, canceled 2.
- Including archived: 325, so 50 are already archived. `organization.createdIssueCount` = 325.
- `organization.subscription` = null, so this is the Free plan. The API does not expose the limit.
  The `issueCreate` error names only the metric: `USAGE_LIMIT_EXCEEDED`, `usageMetric: activeIssueCount`.
- Linear's documented Free-plan limit is 250 non-archived issues ("If you have over 250 issues, you
  will no longer be able to create new issues", https://linear.app/docs/billing-and-plans).
  Third-party guides agree that archived issues are excluded
  (https://t0ggles.com/blog/linear-free-plan-limits). The value 250 comes from these docs; it was
  not read from the API.

Arithmetic: creating one issue needs the active count at or below 249, so **26 archives**
(275 → 249). Each later issue needs one more. 02-01, 02-08 and 02-09 each need one issue, so the
three plans need **28**. The rules allow only **3** eligible issues, and the hard cap is **10**.
Archiving all 3 would leave 272 active issues, still 23 over the limit, so `issueCreate` would fail
with the same error. That makes the batch a guaranteed no-op, and rule 4 would then require
unarchiving it. So no issue was archived, and the eligible pool stays untouched for the owner to use.

The remaining 272 active issues after the eligible 3 are all backlog, unstarted or started. Every
one of them is excluded by the rules. Unblocking needs one of:

- **Upgrade** the workspace to Basic, which has no issue cap.
- **Archive or delete open issues**, which the current rules exclude. The obvious pool is the
  duplicate `[TEST] …` and `[Locate …]` product issues in Backlog/Todo from 2026-08-11..17.
  That needs an explicit owner decision because it touches another workflow's live backlog.

## Archive log

None. No `issueArchive` call was made, so there is nothing to unarchive.
