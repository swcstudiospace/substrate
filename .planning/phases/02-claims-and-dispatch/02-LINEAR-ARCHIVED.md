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


## Owner decision 2 — archive 28 open duplicate issues (2026-09-25)

After the evaluation above, the owner chose option 2: archive 28 open duplicate "[TEST] …" / "[Locate …]"
issues from the 2026-08-11..17 batch, so 02-01, 02-09 and 02-08 can each create one issue (275 → 247 active).

Selection rule (read-only dry run, 2026-09-25): team SWC; state type backlog or unstarted; title starting
"[TEST]" or "[Locate"; created 2026-08-11..17; the title exactly matches at least one other open issue.
From each exact-title group, the keeper is the oldest Todo copy (else the oldest); only non-keepers are
candidates. A candidate must also have no assignee, parent or sub-issues, at most one comment, no
`agent:*`/`dispatch:*` label, `updatedAt` before 2026-09-11, and `graph_find` found:false for both the
id and the identifier. 44 issues were eligible. The 28 oldest were taken, all in Backlog.
Every keeper stays open, so no product loses its open issue.

Undo: `issueUnarchive(id)` per the method above, using the ids below.

| identifier | id | title | state | updatedAt | keeper |
|---|---|---|---|---|---|
| SWC-79 | 9fa3a316-52e2-424a-9e56-220bca7a24c5 | [Locate] Fold-Flat Adjustable Aluminum Laptop Stand | Backlog | 2026-08-11T20:24:40.827Z | SWC-78 (Todo, stays open) |
| SWC-83 | a972e6bd-a76c-481e-8c88-bee34caef7bd | [Locate] Magnetic Fridge Side Shelf — 2 shelves plus movable hooks | Backlog | 2026-08-12T04:17:32.898Z | SWC-82 (Todo, stays open) |
| SWC-85 | 411bcc8d-f829-43a0-b92e-d51dc9bf557a | [Locate] Under-Shelf Basket Pair — clip-on cabinet shelf expansion | Backlog | 2026-08-12T04:20:09.953Z | SWC-84 (Todo, stays open) |
| SWC-92 | 6deca22f-8b22-4a1d-b827-5fa617e535d8 | [TEST] 23-cup waterproof pet food travel bag + two collapsible bowls | Backlog | 2026-08-12T08:11:49.310Z | SWC-90 (Todo, stays open) |
| SWC-95 | 0aa2a686-924b-440a-aef2-f5048c974df6 | [TEST] Waterproof 600D dog backseat hammock + bench/cargo liner | Backlog | 2026-08-12T08:11:56.730Z | SWC-94 (Todo, stays open) |
| SWC-97 | 8defcd11-47cb-40b8-840b-2a0d87080ceb | [Locate] 23-cup waterproof pet food travel bag + two collapsible bowls | Backlog | 2026-08-12T08:16:38.784Z | SWC-96 (Todo, stays open) |
| SWC-106 | ed5b882f-39dc-42f8-bd3a-53b2f0e56961 | [TEST] Pilates Ring + Dual-Surface Slider Core Kit | Backlog | 2026-08-12T12:33:44.146Z | SWC-104 (Todo, stays open) |
| SWC-110 | ea906d98-4bd6-4052-b58e-c4edec5e1036 | [Locate] Weighted Speed-Jump-Rope Conditioning Bundle | Backlog | 2026-08-12T12:42:40.050Z | SWC-109 (Todo, stays open) |
| SWC-126 | 09c75838-e1a4-4fcc-84a8-f23be5f8a394 | [TEST] Non-electric bidet attachment + fit-guarantee install kit | Backlog | 2026-08-12T20:16:00.424Z | SWC-125 (Todo, stays open) |
| SWC-129 | a223ac64-bcb7-48d2-a44b-cfdbe1472155 | [Locate] Non-electric bidet attachment + fit-guarantee install kit | Backlog | 2026-08-12T20:24:05.812Z | SWC-128 (Todo, stays open) |
| SWC-138 | 782e901a-924e-4618-8697-9f5fe7f27d9a | [Locate] Folding adjustable aluminum laptop stand (with cable slot) | Backlog | 2026-08-13T00:18:28.250Z | SWC-137 (Todo, stays open) |
| SWC-140 | ac141f10-0d36-470e-8427-689f1709ea9d | [Locate] Remote-worker microbreak mobility kit: stretch strap plus mini resistan | Backlog | 2026-08-13T00:20:12.604Z | SWC-139 (Todo, stays open) |
| SWC-146 | c5484eee-d149-4d23-b989-2fcce68e522f | [Locate] Under-Shelf Hanging Basket Pair for Pantry and Cabinets | Backlog | 2026-08-13T04:18:10.552Z | SWC-145 (Todo, stays open) |
| SWC-168 | 372ce37c-df25-4364-ae49-b2e3aeb0dccb | [Locate] Portable Cable Resistance Travel Gym Kit | Backlog | 2026-08-13T12:16:13.496Z | SWC-167 (Todo, stays open) |
| SWC-188 | 505a2fc7-ecb5-47b1-b073-e4c3e89ad0fe | [TEST] Non-electric dual-nozzle bidet attachment and installation kit | Backlog | 2026-08-13T20:17:01.981Z | SWC-187 (Todo, stays open) |
| SWC-197 | 20b5956f-a13a-47f0-aae6-d370e6326b4c | [TEST] Desk-reset trigger-point foam roller / compact recovery roller | Backlog | 2026-08-14T00:18:37.816Z | SWC-196 (Todo, stays open) |
| SWC-200 | f9166b08-75d9-412a-a54c-cba4421275a8 | [Locate] Foldable adjustable aluminum laptop stand + carry sleeve | Backlog | 2026-08-14T00:22:28.217Z | SWC-199 (Todo, stays open) |
| SWC-203 | 22048ae6-891e-4fc2-bb35-0a8bb41de808 | [Locate] Roll-Up Over-Sink Dish-Drying Rack | Backlog | 2026-08-14T04:05:37.550Z | SWC-202 (Todo, stays open) |
| SWC-205 | ba7854bf-b012-4f9e-9157-3535d94991f8 | [Locate] Four-Compartment Food-Bag Drawer Dispenser | Backlog | 2026-08-14T04:06:47.597Z | SWC-204 (Todo, stays open) |
| SWC-212 | 3e014a6b-e6a8-4014-b882-cb25d403703d | [Locate] Four-Compartment Food-Bag Drawer Dispenser | Backlog | 2026-08-15T04:02:18.689Z | SWC-204 (Todo, stays open) |
| SWC-228 | 397cb76f-11fd-4237-b7dd-9d39cb0bb209 | [Locate/FB] Silent under-desk pedal exerciser (no-screen mechanical) | Backlog | 2026-08-16T00:06:51.332Z | SWC-227 (Todo, stays open) |
| SWC-237 | 9529aa4e-0a56-4625-961a-049cc52572fb | [Locate] Stackable Fridge Water-Bottle & Tumbler Rack (2-Pack) | Backlog | 2026-08-16T04:04:36.927Z | SWC-236 (Todo, stays open) |
| SWC-244 | f1bfa87c-e569-4c23-84ca-7e20b1c71274 | [TEST] Airline-style soft pet carrier backpack with side expanders | Backlog | 2026-08-16T08:04:52.392Z | SWC-243 (Todo, stays open) |
| SWC-246 | 839f80a1-0443-45e7-b2e9-7efaefe96e03 | [Locate] Airline-style soft pet carrier backpack with side expanders | Backlog | 2026-08-16T08:05:12.186Z | SWC-245 (Todo, stays open) |
| SWC-261 | 857ef4f3-74a2-41fa-ba55-ee281b7f027b | [Locate] Pilates Ring + Mini Loop Band Trio Mobility Bundle | Backlog | 2026-08-16T12:03:54.693Z | SWC-260 (Todo, stays open) |
| SWC-263 | f587e9be-5819-4429-a2a8-7051860d9423 | [Locate] Progressive Fabric Resistance Band Kit + Door Anchor + Workout Cards | Backlog | 2026-08-16T12:03:59.076Z | SWC-262 (Todo, stays open) |
| SWC-269 | 227e1040-ac05-436b-93af-66ec4098a06e | [TEST] TSA-friendly toiletry + tech wet/dry split Dopp kit | Backlog | 2026-08-16T16:03:03.335Z | SWC-268 (Todo, stays open) |
| SWC-271 | d6eb47fd-159a-4f51-9d22-ef12933d791c | [TEST] Modular tech pouch with labeled cable inserts | Backlog | 2026-08-16T16:03:07.419Z | SWC-270 (Todo, stays open) |

### Archive log (owner decision 2)

| identifier | id | result |
|---|---|---|
| SWC-79 | 9fa3a316-52e2-424a-9e56-220bca7a24c5 | archived 2026-09-25T01:51:20+00:00 |
| SWC-83 | a972e6bd-a76c-481e-8c88-bee34caef7bd | archived 2026-09-25T01:51:22+00:00 |
| SWC-85 | 411bcc8d-f829-43a0-b92e-d51dc9bf557a | archived 2026-09-25T01:51:23+00:00 |
| SWC-92 | 6deca22f-8b22-4a1d-b827-5fa617e535d8 | archived 2026-09-25T01:51:24+00:00 |
| SWC-95 | 0aa2a686-924b-440a-aef2-f5048c974df6 | archived 2026-09-25T01:51:25+00:00 |
| SWC-97 | 8defcd11-47cb-40b8-840b-2a0d87080ceb | archived 2026-09-25T01:51:26+00:00 |
| SWC-106 | ed5b882f-39dc-42f8-bd3a-53b2f0e56961 | archived 2026-09-25T01:51:28+00:00 |
| SWC-110 | ea906d98-4bd6-4052-b58e-c4edec5e1036 | archived 2026-09-25T01:51:29+00:00 |
| SWC-126 | 09c75838-e1a4-4fcc-84a8-f23be5f8a394 | archived 2026-09-25T01:51:30+00:00 |
| SWC-129 | a223ac64-bcb7-48d2-a44b-cfdbe1472155 | archived 2026-09-25T01:51:30+00:00 |
| SWC-138 | 782e901a-924e-4618-8697-9f5fe7f27d9a | archived 2026-09-25T01:51:31+00:00 |
| SWC-140 | ac141f10-0d36-470e-8427-689f1709ea9d | archived 2026-09-25T01:51:32+00:00 |
| SWC-146 | c5484eee-d149-4d23-b989-2fcce68e522f | archived 2026-09-25T01:51:33+00:00 |
| SWC-168 | 372ce37c-df25-4364-ae49-b2e3aeb0dccb | archived 2026-09-25T01:51:34+00:00 |
| SWC-188 | 505a2fc7-ecb5-47b1-b073-e4c3e89ad0fe | archived 2026-09-25T01:51:36+00:00 |
| SWC-197 | 20b5956f-a13a-47f0-aae6-d370e6326b4c | archived 2026-09-25T01:51:37+00:00 |
| SWC-200 | f9166b08-75d9-412a-a54c-cba4421275a8 | archived 2026-09-25T01:51:38+00:00 |
| SWC-203 | 22048ae6-891e-4fc2-bb35-0a8bb41de808 | archived 2026-09-25T01:51:39+00:00 |
| SWC-205 | ba7854bf-b012-4f9e-9157-3535d94991f8 | archived 2026-09-25T01:51:40+00:00 |
| SWC-212 | 3e014a6b-e6a8-4014-b882-cb25d403703d | archived 2026-09-25T01:51:40+00:00 |
| SWC-228 | 397cb76f-11fd-4237-b7dd-9d39cb0bb209 | archived 2026-09-25T01:51:41+00:00 |
| SWC-237 | 9529aa4e-0a56-4625-961a-049cc52572fb | archived 2026-09-25T01:51:42+00:00 |
| SWC-244 | f1bfa87c-e569-4c23-84ca-7e20b1c71274 | archived 2026-09-25T01:51:43+00:00 |
| SWC-246 | 839f80a1-0443-45e7-b2e9-7efaefe96e03 | archived 2026-09-25T01:51:45+00:00 |
| SWC-261 | 857ef4f3-74a2-41fa-ba55-ee281b7f027b | archived 2026-09-25T01:51:47+00:00 |
| SWC-263 | f587e9be-5819-4429-a2a8-7051860d9423 | archived 2026-09-25T01:51:48+00:00 |
| SWC-269 | 227e1040-ac05-436b-93af-66ec4098a06e | archived 2026-09-25T01:51:48+00:00 |
| SWC-271 | d6eb47fd-159a-4f51-9d22-ef12933d791c | archived 2026-09-25T01:52:52+00:00 |

One transient Linear read timeout occurred before SWC-271's pre-archive read; the read was retried and the issue then archived normally.

Result: 28 archived, 0 skipped, 0 errors. Active issues in team SWC after the run: **247** (limit 250 per Linear docs). This leaves room for three new issues: the 02-01, 02-09 and 02-08 tracer/proof issues. Keepers (the Todo copies) are untouched.


## Phase 3 — archives for the proof issue (D-14, 2026-09-25)

Plan 03-09 needed room for one issue: the Phase 3 proof issue. D-14 allows exactly
max(0, active − 249) archives from the owner-decision-2 pool above, oldest `updatedAt` first, each
re-checked immediately before its `issueArchive`, and never more.

Rule: the owner-decision-2 selection rule, unchanged (team SWC; state type backlog or unstarted; title
starting "[TEST]" or "[Locate"; created 2026-08-11..17; exact title matches at least one other open
issue; per exact-title group the keeper is the oldest Todo copy, else the oldest, and only non-keepers
are candidates; no assignee, parent or sub-issues; at most one comment; no `agent:*`/`dispatch:*`
label; `updatedAt` before 2026-09-11; `graph_find` found:false for both the id and the identifier).

active_before: **262** non-archived issues in the workspace (counted 2026-09-25T22:55:11Z; research
earlier that day saw 251 — 12 `Untitled eng work` Backlog issues SWC-468..SWC-479 were created
2026-09-25 06:52–13:52Z by another workflow).

Arithmetic: a create needs ≤ 249 active, so max(0, 262 − 249) = **13** archives. The pool had
16 eligible issues; the 13 oldest were taken. Before each archive the script re-read every active
issue, recomputed the pool and re-ran `graph_find`; an issue that no longer qualified would have been
skipped and the next taken. None was skipped. Every keeper stays open.

| identifier | id | title | state | updatedAt | keeper |
|---|---|---|---|---|---|
| SWC-210 | 8fe57e27-36bb-418d-a14e-4041c77c0cfe | [Locate] Roll-Up Over-Sink Dish-Drying Rack | Todo | 2026-08-15T04:02:02.102Z | SWC-202 (Todo, stays open) |
| SWC-211 | 39e59ba7-2be0-4b29-9321-9654c9306841 | [Locate] Four-Compartment Food-Bag Drawer Dispenser | Todo | 2026-08-15T04:02:14.866Z | SWC-204 (Todo, stays open) |
| SWC-275 | a6b9d6c0-b34d-47c4-af32-c5b7a7414258 | [Locate] TSA-friendly toiletry + tech wet/dry split Dopp kit | Backlog | 2026-08-16T16:03:35.791Z | SWC-274 (Todo, stays open) |
| SWC-278 | 5ee0cfee-07ee-42b3-a319-e5f0d1b7aeb9 | [Locate FALLBACK] TSA-friendly toiletry + tech wet/dry split Dopp kit | Backlog | 2026-08-16T16:05:36.354Z | SWC-277 (Todo, stays open) |
| SWC-287 | 1dd173d7-0549-4e47-a172-403fd9953954 | [Locate] Safety razor starter kit with bamboo handle + stand + blades tin | Backlog | 2026-08-16T20:04:21.950Z | SWC-286 (Todo, stays open) |
| SWC-289 | f74cd707-6930-4927-aada-c342bb14d373 | [Locate FALLBACK] Reusable bamboo cotton rounds set with mesh wash bag (30–40 pads) | Backlog | 2026-08-16T20:05:00.789Z | SWC-288 (Todo, stays open) |
| SWC-296 | 06059b79-5078-44eb-aced-7044dd131fa1 | [TEST] Wobble/balance board for sit-stand desks | Backlog | 2026-08-17T00:03:36.590Z | SWC-295 (Todo, stays open) |
| SWC-298 | 51e273a1-c336-442f-af0d-1b496c55504c | [Locate] Portable under-desk pedal exerciser (tension-adjust, fold-flat) | Backlog | 2026-08-17T00:03:52.656Z | SWC-297 (Todo, stays open) |
| SWC-300 | 648ba127-4f76-42c7-b520-570893249000 | [Locate] Under-desk silent mini elliptical (magnetic resistance) | Backlog | 2026-08-17T00:03:56.690Z | SWC-299 (Todo, stays open) |
| SWC-302 | 3be05180-8a38-4f98-9b04-92caa20183db | [Locate FALLBACK] Portable under-desk pedal exerciser (tension-adjust, fold-flat) | Backlog | 2026-08-17T00:04:41.222Z | SWC-301 (Todo, stays open) |
| SWC-304 | c2e6837e-6a76-45f3-84b7-eb4dec750513 | [Locate FALLBACK] Under-desk silent mini elliptical (magnetic resistance) | Backlog | 2026-08-17T00:05:14.742Z | SWC-303 (Todo, stays open) |
| SWC-314 | 897e321c-6b1e-4530-a16a-0a8d2b996f60 | [Locate FALLBACK] Expandable Bamboo Drawer Organizer Set (3-pc nested) | Backlog | 2026-08-17T04:05:03.667Z | SWC-312 (Todo, stays open) |
| SWC-317 | 2dd10cd6-19f3-4530-9c23-9ff65a858659 | [TEST] Inflatable elevated pet travel bed with puncture-resistant top and carry sack | Backlog | 2026-08-17T08:03:59.632Z | SWC-316 (Todo, stays open) |

Still open in the pool (eligible, not archived): SWC-319, SWC-323, SWC-330.

### Archive log (Phase 3)

| identifier | id | result |
|---|---|---|
| SWC-210 | 8fe57e27-36bb-418d-a14e-4041c77c0cfe | archived 2026-09-25T22:55:50+00:00 |
| SWC-211 | 39e59ba7-2be0-4b29-9321-9654c9306841 | archived 2026-09-25T22:55:52+00:00 |
| SWC-275 | a6b9d6c0-b34d-47c4-af32-c5b7a7414258 | archived 2026-09-25T22:55:54+00:00 |
| SWC-278 | 5ee0cfee-07ee-42b3-a319-e5f0d1b7aeb9 | archived 2026-09-25T22:55:57+00:00 |
| SWC-287 | 1dd173d7-0549-4e47-a172-403fd9953954 | archived 2026-09-25T22:55:59+00:00 |
| SWC-289 | f74cd707-6930-4927-aada-c342bb14d373 | archived 2026-09-25T22:56:01+00:00 |
| SWC-296 | 06059b79-5078-44eb-aced-7044dd131fa1 | archived 2026-09-25T22:56:03+00:00 |
| SWC-298 | 51e273a1-c336-442f-af0d-1b496c55504c | archived 2026-09-25T22:56:06+00:00 |
| SWC-300 | 648ba127-4f76-42c7-b520-570893249000 | archived 2026-09-25T22:56:09+00:00 |
| SWC-302 | 3be05180-8a38-4f98-9b04-92caa20183db | archived 2026-09-25T22:56:11+00:00 |
| SWC-304 | c2e6837e-6a76-45f3-84b7-eb4dec750513 | archived 2026-09-25T22:56:13+00:00 |
| SWC-314 | 897e321c-6b1e-4530-a16a-0a8d2b996f60 | archived 2026-09-25T22:56:16+00:00 |
| SWC-317 | 2dd10cd6-19f3-4530-9c23-9ff65a858659 | archived 2026-09-25T22:56:19+00:00 |

Unarchive method: `mutation { issueUnarchive(id: "<id>") { success } }` with each id above, sent from a
python3 script started as `sudo systemd-run --quiet --wait --pipe --collect -p EnvironmentFile=/etc/substrate/substrate.env /usr/bin/python3 - < <script>`
(the script holds no key and is deleted afterwards). Unarchiving any of them raises the active count
above the limit again.

Result: 13 archived, 0 skipped, 0 errors. Active issues now **249** (limit 250 per Linear docs); after
the proof issue SWC-480 was created, **250**.

## 2026-09-25 — owner-requested cleanup of completed issues

Archived every issue in a `completed` state type: SWC-467, SWC-465, SWC-113 (3). Undo with `issueUnarchive`.

## 2026-09-25: owner-requested cleanup of irrelevant issues

The owner asked to "close off random Linear issues which aren't relevant to anything". The active count went from 247 to 179.

- 12 × `Untitled eng work` (SWC-468..479). These are hermes-engineering-board session auto-ingest issues with "Last user ask: (none)".
- SWC-466, the Phase 2 dispatch tracer. Its body says "safe to close". It is still indexed as graph `ut-mugbqivi-752f2dad` n1.
- 55 issues with no project. Each is a dual-write copy of an AI Dropshipping Agency pipeline issue (same title and run, within ±2 identifiers). The projected twin is kept.

GitHub mirror issues (agent_runtime / ai-agency) were not touched. Undo any row with `issueUnarchive`.

| identifier | id | why | title |
|---|---|---|---|
| SWC-69 | 85ad02ab-28ac-4938-aef9-9859c6989a16 | dual-write duplicate (no project) | [E2E] Product pipeline — KOUPA Height Adjustable Flip Standing Desk wi |
| SWC-70 | b71199c8-6a9b-4ad6-95f6-be5d9f0ae1d9 | dual-write duplicate (no project) | [NO-GO] KOUPA Height Adjustable Flip Standing Desk with Wheels, 24-Inc |
| SWC-73 | 9e7289b6-ef6d-405a-8826-6457e35efb58 | dual-write duplicate (no project) | [E2E] Product pipeline — Fold-Flat Adjustable Aluminum Laptop Stand |
| SWC-76 | b0437f71-a18c-4074-9d9f-f1f86397b5bd | dual-write duplicate (no project) | [GO] Clamp-On Rotating Forearm Support |
| SWC-81 | 1b8960a0-9fbd-488c-a0bf-e7563b934303 | dual-write duplicate (no project) | [Post-locate] Outreach + shipping — 20260812T003502Z |
| SWC-88 | 9494daf5-a553-463a-9016-b47670dbbd09 | dual-write duplicate (no project) | [Scout] Pet travel accessories — product-ranking gate |
| SWC-91 | f2d313b1-0f91-4766-b697-28ac2fdc54a5 | dual-write duplicate (no project) | [Product Rank] pet travel accessories |
| SWC-100 | 8cc51154-bcc7-4601-bd4e-0abe45c22a4a | dual-write duplicate (no project) | [Post-locate] Outreach + shipping — 20260812T081951Z |
| SWC-112 | fbf6df0a-8b1f-4b47-8b91-249d9f0b717d | dual-write duplicate (no project) | [Post-locate] Outreach + shipping — 20260812T124257Z |
| SWC-114 | 1f6eff05-0ecd-47b9-b961-140f8123a2ef | dual-write duplicate (no project) | [Scout] Travel tech organizers — product-ranking gate |
| SWC-118 | e7f33c59-3cf8-4e60-9c99-ea78baedd113 | dual-write duplicate (no project) | [GO] AirTag-Compatible Passport + SIM Travel Wallet |
| SWC-132 | 66f9d806-30ed-48e0-b764-834c253b5b9b | dual-write duplicate (no project) | [Scout] Desk mobility product-ranking gate |
| SWC-142 | 09c8981e-74ba-4730-8b03-4a95f74971ef | dual-write duplicate (no project) | [Post-locate] Outreach + shipping — 20260813T002027Z |
| SWC-144 | 48e78a78-fce0-4c2e-86ef-0da5cb55c7a9 | dual-write duplicate (no project) | [Scout] Kitchen organizers under $40 — product-ranking gate |
| SWC-149 | 89d9b92b-d4df-4667-b64e-26c64ee80492 | dual-write duplicate (no project) | [Post-locate] Outreach + shipping — 20260813T041919Z |
| SWC-151 | eced4381-a03c-4c9c-961e-513b32f4aa8f | dual-write duplicate (no project) | [Scout] Pet travel accessories — product-ranking gate |
| SWC-153 | 12f195f3-a66d-4744-8c87-2b71f5c70024 | dual-write duplicate (no project) | [Scout] Pet travel ranking gate — final top 5 |
| SWC-155 | cd2cf475-27b1-4d7a-a7ee-9be4bc58862e | dual-write duplicate (no project) | [Product Rank] pet travel accessories |
| SWC-160 | 5d2509fc-433a-412d-a1fa-4f2b3df29926 | dual-write duplicate (no project) | [Scout] Home gym micro-equipment ranking gate |
| SWC-163 | 57654c6f-74d4-4aee-8dd4-2385170441ac | dual-write duplicate (no project) | [GO] Portable Cable Resistance Travel Gym Kit |
| SWC-166 | d1cf8acd-13af-4fda-9aae-b7a0dd682c81 | dual-write duplicate (no project) | [GO] Fabric Hip-Band Glute Activation Kit |
| SWC-173 | f010e9b1-22fa-4073-a17e-935b3054fa84 | dual-write duplicate (no project) | [Product Rank] travel tech organizers |
| SWC-175 | 9ef4f604-f5c3-4da2-977e-f46f17c47735 | dual-write duplicate (no project) | [GO] Modular Padded Tech Organizer with Removable Dividers |
| SWC-177 | 763a80e7-39ab-46ea-91a8-8c92d13b0a72 | dual-write duplicate (no project) | [GO] Creator SD-Card and Adapter Media Vault |
| SWC-182 | f6800302-0d29-4815-bd9b-844ba5841cf4 | dual-write duplicate (no project) | [Post-locate] Outreach + shipping — 20260813T161706Z |
| SWC-184 | ba711cc5-49cf-4d35-9ba0-80aaaa84271f | dual-write duplicate (no project) | [Scout] Product-ranking gate: sustainable bathroom gadgets |
| SWC-186 | 8437f2d2-7db6-46e3-9a3c-7931dd3bf1d0 | dual-write duplicate (no project) | [Product Rank] sustainable bathroom gadgets |
| SWC-192 | 03c044ca-0ef7-4639-a0e0-884011488e17 | dual-write duplicate (no project) | [Scout] Product-ranking gate: desk mobility / posture tools |
| SWC-208 | 7a46c245-36b8-4db7-a8de-72208c8ae7cc | dual-write duplicate (no project) | [Post-locate] Outreach + shipping — 20260814T080232Z |
| SWC-214 | e6f28bfe-0496-40d5-b56a-162a88e5b6ef | dual-write duplicate (no project) | [Post-locate] Outreach + shipping — 20260815T040224Z |
| SWC-216 | 8bf4b5be-6a5e-4b17-a22a-3f6324df7f8e | dual-write duplicate (no project) | [Post-locate] Outreach + shipping — 20260815T080212Z |
| SWC-218 | 6bf12efa-38dc-4552-b9f4-31ccfaa10b49 | dual-write duplicate (no project) | [Post-locate] Outreach + shipping — 20260815T200154Z |
| SWC-221 | 375048c8-5757-4a39-9d13-36352204ebba | dual-write duplicate (no project) | [Product Rank FALLBACK] desk mobility and posture tools for remote wor |
| SWC-223 | b07a3df7-52b9-42c8-a72a-bc1de3d39b88 | dual-write duplicate (no project) | [GO/FB] Silent under-desk pedal exerciser (no-screen mechanical) |
| SWC-225 | 2cbe4dd1-54de-4a04-8883-1883f0110940 | dual-write duplicate (no project) | [TEST/FB] Textured topographic anti-fatigue standing mat (compact desk |
| SWC-232 | 1876c9ad-b7f3-4e5f-9f1c-af98d585b71f | dual-write duplicate (no project) | [NO-GO] Stackable Fridge Water-Bottle & Tumbler Rack (2-Pack) |
| SWC-235 | 4d764c7f-99ad-4a59-8c8a-5b2e3cbc2a19 | dual-write duplicate (no project) | [NO-GO] Bamboo Bag Organizer Dispenser (Foil/Wrap/Bag Trio) |
| SWC-240 | 46af6550-6a56-483e-8039-ad300a9dd6b6 | dual-write duplicate (no project) | [Post-locate] Outreach + shipping — 20260816T040454Z |
| SWC-242 | 821f141e-e89e-49db-a955-feef8716d043 | dual-write duplicate (no project) | [Product Rank FALLBACK] pet travel accessories |
| SWC-249 | ad6bf083-e36a-45c4-a2f6-51db5434cdc6 | dual-write duplicate (no project) | [Post-locate] Outreach + shipping — 20260816T080535Z |
| SWC-251 | 191463f0-8aa2-4f91-9347-613aa4963822 | dual-write duplicate (no project) | [Post-locate] Outreach + shipping — 20260816T080605Z |
| SWC-253 | 86f54bf9-ff30-4bc9-b943-821e77b2dcf7 | dual-write duplicate (no project) | [Product Rank FALLBACK] home gym micro-equipment |
| SWC-255 | b24457d0-1314-4324-8939-0ba8d46e88a4 | dual-write duplicate (no project) | [GO] Pilates Ring + Mini Loop Band Trio Mobility Bundle |
| SWC-257 | 74ec2179-caad-446c-9f8e-841c747a4bbc | dual-write duplicate (no project) | [GO] Progressive Fabric Resistance Band Kit + Door Anchor + Workout Ca |
| SWC-259 | 5079bbbc-6100-4f83-a04a-be3ed05219b1 | dual-write duplicate (no project) | [GO] Collapsible/Fillable Soft Kettlebell (empty ship, user fills sand |
| SWC-265 | 556290ba-f925-4609-93bf-077079fe0659 | dual-write duplicate (no project) | [Post-locate] Outreach + shipping — 20260816T120413Z |
| SWC-267 | 452e3cb2-f186-4d7e-bc6e-2df51e5be0e1 | dual-write duplicate (no project) | [Product Rank FALLBACK] travel tech organizers |
| SWC-273 | b3c340e7-5dbb-4877-9d56-d4dc01fb53f6 | dual-write duplicate (no project) | [GO] Under-seat personal-item organizer insert with tech bay |
| SWC-306 | ad189320-618f-46fb-a5f5-6c796c1179da | dual-write duplicate (no project) | [Post-locate] Outreach + shipping — 20260817T000528Z |
| SWC-319 | e7ab3603-afde-415b-b206-e9e2b1e44ee8 | dual-write duplicate (no project) | [TEST] Crash-tested style 3-in-1 dog seatbelt harness (walk harness +  |
| SWC-323 | 521aa1ca-0a25-4528-9e9e-57c112b3ab85 | dual-write duplicate (no project) | [Locate FALLBACK] Crash-tested style 3-in-1 dog seatbelt harness (walk |
| SWC-325 | 7455f408-dc7a-498e-9b47-3f95d5682d36 | dual-write duplicate (no project) | [Post-locate] Outreach + shipping — 20260817T080543Z |
| SWC-327 | 8fd858af-57a9-4785-9879-757f9bc79955 | dual-write duplicate (no project) | [Product Rank FALLBACK] home gym micro-equipment |
| SWC-330 | f502cd6f-88d8-4f97-b3ab-10e1119c034f | dual-write duplicate (no project) | [TEST] Under-desk mini pedal exerciser (no electronics) |
| SWC-334 | 2fa89571-596d-42a7-a68c-f04e3600048a | dual-write duplicate (no project) | [Post-locate] Outreach + shipping — 20260817T120524Z |
| SWC-466 | d5b9c622-c760-4ee4-89d0-3dbaab0a1ab5 | Phase 2 dispatch tracer (done) | [substrate 02-09 dispatch tracer] throwaway — safe to close |
| SWC-468 | 96016de3-ac5b-48b8-8bae-20201a0f625e | untitled eng-board session ingest | Untitled eng work |
| SWC-469 | 1a3e2e85-001c-4e4e-bcc5-0be7a81ffd91 | untitled eng-board session ingest | Untitled eng work |
| SWC-470 | 9dacc7c5-7dd4-4420-8f6d-38f87436b000 | untitled eng-board session ingest | Untitled eng work |
| SWC-471 | 2bd08777-27e0-4246-80da-14bbd8e145f1 | untitled eng-board session ingest | Untitled eng work |
| SWC-472 | 383dd688-94ea-484a-8aef-17f0baec0ab3 | untitled eng-board session ingest | Untitled eng work |
| SWC-473 | 5c623ccd-8ff8-4c68-b665-959cb09cf6ae | untitled eng-board session ingest | Untitled eng work |
| SWC-474 | fe5e6ede-68ff-481c-bfaf-3887a7f2d713 | untitled eng-board session ingest | Untitled eng work |
| SWC-475 | e26b730e-ab34-480a-b105-384284220fba | untitled eng-board session ingest | Untitled eng work |
| SWC-476 | 2fad6ccd-cbe8-4b7a-9b37-cf022fc94a96 | untitled eng-board session ingest | Untitled eng work |
| SWC-477 | 3e4c4d10-ea44-451c-a359-8c83bd2cc1cd | untitled eng-board session ingest | Untitled eng work |
| SWC-478 | 2aefe23e-1bad-4594-8294-b939c74e20ae | untitled eng-board session ingest | Untitled eng work |
| SWC-479 | bb611ef9-e83f-4024-a98e-b394f9cba6c5 | untitled eng-board session ingest | Untitled eng work |

## 2026-09-26: AI Dropshipping Agency run output archived (owner: "Keep setup + GO, archive the rest")

Archived 152 pipeline issues: Scout, Product Rank, TEST, NO-GO, Locate, Post-locate, E2E and Spend HITL drafts from 11–17 Aug. The active count went from 179 to 27.
Kept: SWC-60, SWC-61, SWC-62, SWC-64, SWC-65, SWC-74, SWC-75, SWC-107, SWC-116, SWC-117, SWC-124, SWC-136, SWC-162, SWC-165, SWC-174, SWC-176, SWC-178, SWC-194, SWC-209, SWC-222, SWC-254, SWC-256, SWC-258, SWC-272, SWC-293, SWC-294, SWC-480. These are the setup issues SWC-60/61/62, the Parallel 402 ops issue SWC-209, every [GO] and [GO/FB] pick, and the 03-10 proof issue SWC-480.
Undo with `issueUnarchive`.

| identifier | id | title |
|---|---|---|
| SWC-63 | 726fa774-79c9-4e22-8e65-d4eee73868ba | [Product Rank] desk mobility and posture tools for remote workers |
| SWC-66 | 7c402c5b-def3-4c32-83ba-d1d704f5bb5f | [TEST] Desk Reset Mobility Kit |
| SWC-67 | ea5e1768-9a49-4f02-9103-28e6d95dbe52 | [E2E] Product pipeline — KOUPA Height Adjustable Flip Standing Desk with Wheels, |
| SWC-68 | 4f1e6170-6160-4ae2-a4e6-d27adbbe165c | [NO-GO] KOUPA Height Adjustable Flip Standing Desk with Wheels, 24-Inch, 360° Fl |
| SWC-71 | 87b4b336-f26c-43b1-b231-6f4f9075113c | [Spend HITL] HITL spend $75.00 meta: E2E draft only — KOUPA Height Adjustable Fl |
| SWC-72 | f2d4cf10-1ccf-4aa7-ace2-cbc2d94e1af4 | [E2E] Product pipeline — Fold-Flat Adjustable Aluminum Laptop Stand |
| SWC-77 | 7748c762-1290-4dc0-a96a-edb60549a5f7 | [Spend HITL] HITL spend $75.00 meta: E2E draft only — Fold-Flat Adjustable Alumi |
| SWC-78 | 32293694-4e25-4126-9a32-7fa81e2c3b73 | [Locate] Fold-Flat Adjustable Aluminum Laptop Stand |
| SWC-80 | 48f14a3f-807a-4e9b-a6fa-04b5fde91cef | [Post-locate] Outreach + shipping — 20260812T003502Z |
| SWC-82 | e44ad63c-bb21-4c29-aa2d-8c0ffc91eb22 | [Locate] Magnetic Fridge Side Shelf — 2 shelves plus movable hooks |
| SWC-84 | d00863cb-a803-45d4-aa87-c4fd92765b80 | [Locate] Under-Shelf Basket Pair — clip-on cabinet shelf expansion |
| SWC-86 | 8d91ec60-8a24-46cd-ae1a-1343fb65586a | [Post-locate] Outreach + shipping — 20260812T042017Z |
| SWC-87 | 7ab28873-7244-4533-97ff-dc6e812abdba | [Scout] Pet travel accessories — product-ranking gate |
| SWC-89 | bc9aa085-5907-47cb-8985-dd5541526efd | [Product Rank] pet travel accessories |
| SWC-90 | fccfb25d-9e19-4ff6-9573-8a0bee7c4c24 | [TEST] 23-cup waterproof pet food travel bag + two collapsible bowls |
| SWC-93 | 7b0551af-9abe-4594-be0e-5ad9bd321e71 | [TEST] Fold-flat waterproof ripstop travel mat for hotels, RVs, and campsites |
| SWC-94 | 39d29f87-8234-4e55-a896-544dab52c192 | [TEST] Waterproof 600D dog backseat hammock + bench/cargo liner |
| SWC-96 | b4bb4acb-6037-41ce-b648-94e3e7350ca4 | [Locate] 23-cup waterproof pet food travel bag + two collapsible bowls |
| SWC-98 | 3c101757-322a-421f-ae54-3bd208d03266 | [Locate] Fold-flat waterproof ripstop travel mat for hotels, RVs, and campsites |
| SWC-99 | a3520cb1-59d0-4617-937a-08de1272c52e | [Post-locate] Outreach + shipping — 20260812T081951Z |
| SWC-101 | 5b6e209c-5856-4b99-a1d4-6433390411ca | [Scout] Home gym micro-equipment ranking gate |
| SWC-102 | 6c0815de-3d3d-43e9-987d-87cab5a646c3 | [Scout] Home gym micro-equipment ranking gate |
| SWC-103 | d7a4ecd6-8dca-4bbb-bb80-142a4a13ed0f | [Product Rank] home gym micro-equipment |
| SWC-104 | 9f6087b4-b6cd-44b7-ab56-5c33f2e236db | [TEST] Pilates Ring + Dual-Surface Slider Core Kit |
| SWC-105 | de8e6b82-aba5-4d7f-ae2e-735f391a0a0b | [TEST] Weighted Speed-Jump-Rope Conditioning Bundle |
| SWC-108 | 8aff443e-17c7-4659-91da-ddaf057cf00f | [Locate] Pilates Ring + Dual-Surface Slider Core Kit |
| SWC-109 | d39dc363-d1f5-4da1-a340-78d3ac21e5ab | [Locate] Weighted Speed-Jump-Rope Conditioning Bundle |
| SWC-111 | 4070766d-e56b-42eb-88f3-f25f2f76736a | [Post-locate] Outreach + shipping — 20260812T124257Z |
| SWC-115 | 24c7a187-a1ea-4d6e-8b5c-3673e81ba464 | [Product Rank] travel tech organizers |
| SWC-119 | fdfbe716-88d8-4025-a822-29d321672856 | [TEST] Creator Media Vault: Passive SD/microSD + Dongle Case |
| SWC-120 | b598f386-fec1-4e22-842c-68a324653e6f | [Locate] AirTag-Compatible Passport + SIM Travel Wallet |
| SWC-121 | 73e5039c-2fbd-4f61-9337-9047eb457a54 | [Locate] Creator Mini Tech Sling / Pocket Organizer |
| SWC-122 | 85a056ec-c118-4c57-a1e3-c743be5a9989 | [Post-locate] Outreach + shipping — 20260812T163443Z |
| SWC-123 | 4790125d-ba06-467b-8a7b-7045d3e06f24 | [Product Rank] sustainable bathroom gadgets |
| SWC-125 | 597cf47e-eba6-4fd2-a9e3-494da967a32f | [TEST] Non-electric bidet attachment + fit-guarantee install kit |
| SWC-127 | 80282224-f244-467f-9412-008a2f91d10a | [Locate] Filtered showerhead + first replacement cartridge |
| SWC-128 | f057237d-d92b-46d8-b692-c066779fe4b0 | [Locate] Non-electric bidet attachment + fit-guarantee install kit |
| SWC-130 | 61a7bc1d-c658-4bd2-beb2-a8869dccc868 | [Post-locate] Outreach + shipping — 20260812T202416Z |
| SWC-131 | 6aa49b13-4deb-4984-bdd1-f00b2b8acbbc | [Scout] Desk mobility product-ranking gate |
| SWC-133 | ef34a80b-2bea-4e98-a02c-c5fa463e0501 | [Product Rank] desk mobility and posture tools for remote workers |
| SWC-134 | 63ad8c1b-9d26-4240-bb91-7a3985c7fd4e | [TEST] Folding adjustable aluminum laptop stand (with cable slot) |
| SWC-135 | 885da2dd-5066-4618-b6b4-bc1608cf069a | [TEST] Remote-worker microbreak mobility kit: stretch strap plus mini resistance |
| SWC-137 | c581a2f1-5324-46f5-ac15-bc84fe0471ae | [Locate] Folding adjustable aluminum laptop stand (with cable slot) |
| SWC-139 | dd0ebca8-b896-40fe-b7a3-e555f65815ef | [Locate] Remote-worker microbreak mobility kit: stretch strap plus mini resistan |
| SWC-141 | 420113f5-c742-47b9-8a41-e29f17dd9dc1 | [Post-locate] Outreach + shipping — 20260813T002027Z |
| SWC-143 | a952b29f-315b-455f-b795-34baf2f487dc | [Scout] Kitchen organizers under $40 — product-ranking gate |
| SWC-145 | cc3f73fb-674c-42de-8a62-329aa6330b40 | [Locate] Under-Shelf Hanging Basket Pair for Pantry and Cabinets |
| SWC-147 | f737aca3-924f-4d82-a4b9-98b48413afd8 | [Locate] 3-in-1 Foil, Plastic-Wrap & Baggy Dispenser Drawer |
| SWC-148 | a5af4777-d3a3-45b4-aeed-c7faecec2875 | [Post-locate] Outreach + shipping — 20260813T041919Z |
| SWC-150 | 0fc34f64-a487-4c58-9b05-5eea42a53bc6 | [Scout] Pet travel accessories — product-ranking gate |
| SWC-152 | 65a38e09-c08e-44c4-bd57-f09f8567e4ad | [Scout] Pet travel ranking gate — final top 5 |
| SWC-154 | 7b76240a-56a3-4225-83c5-9843b3f88158 | [Product Rank] pet travel accessories |
| SWC-156 | 7b203e31-7d63-485c-ac75-4811155a1e73 | [TEST] Universal Waterproof Back-Seat Pet Hammock with Door Shields |
| SWC-157 | c5396942-86de-4bca-8a21-be2345697423 | [Locate] Universal Waterproof Back-Seat Pet Hammock with Door Shields |
| SWC-158 | 6287b58a-1cd8-4fb7-b0f8-224df1d79958 | [Post-locate] Outreach + shipping — 20260813T081216Z |
| SWC-159 | 4a6fe366-b50f-4129-86eb-f9bf69af169b | [Scout] Home gym micro-equipment ranking gate |
| SWC-161 | ce5a524b-df92-4d85-b1d7-6ac57c9e3615 | [Product Rank] home gym micro-equipment |
| SWC-164 | 003e6a8f-b187-4e5b-ad92-b2222803e09d | [TEST] Pilates Ring + Mini-Ball Starter Kit |
| SWC-167 | 87d06d6b-523b-414d-b4b4-26c1713b8cc3 | [Locate] Portable Cable Resistance Travel Gym Kit |
| SWC-169 | 9b9542b1-7a87-46e6-9984-b73c5328a8ed | [Locate] Pilates Ring + Mini-Ball Starter Kit |
| SWC-170 | 09cdc720-3342-4162-87f3-1d71a74c41cc | [Post-locate] Outreach + shipping — 20260813T121736Z |
| SWC-171 | de0b6654-90bb-4776-8722-76729515984b | [Scout] Travel tech organizers — product-ranking gate |
| SWC-172 | 11a60e51-63dc-42c6-ab02-0d153eb40dbb | [Product Rank] travel tech organizers |
| SWC-179 | 3e61e33f-20f3-4bd2-baff-88e741ee51f1 | [Locate] Modular Padded Tech Organizer with Removable Dividers |
| SWC-180 | bee2081a-36bd-4dad-95aa-72f325fe500f | [Locate] Creator SD-Card and Adapter Media Vault |
| SWC-181 | 013306a3-c014-4bc7-8e96-0df2f439e373 | [Post-locate] Outreach + shipping — 20260813T161706Z |
| SWC-183 | c1be7413-f3a9-4b53-b8d9-e85b18d25b4a | [Scout] Product-ranking gate: sustainable bathroom gadgets |
| SWC-185 | 4bbfbd6c-fe6d-4077-96e7-0db43463e5e2 | [Product Rank] sustainable bathroom gadgets |
| SWC-187 | 2bcb9ed7-862d-4eac-8476-d92872c3c262 | [TEST] Non-electric dual-nozzle bidet attachment and installation kit |
| SWC-189 | 5d85b477-2435-4673-b5f9-57dbf3b1bed0 | [Locate] Non-electric dual-nozzle bidet attachment and installation kit |
| SWC-190 | a5194215-0a80-435d-a27c-1e97b30d3ec4 | [Post-locate] Outreach + shipping — 20260813T201856Z |
| SWC-191 | 21f267a7-b980-4801-a462-377a7feefee7 | [Scout] Product-ranking gate: desk mobility / posture tools |
| SWC-193 | ff44155b-7b54-4d35-91a1-b5b6eb7d8f2d | [Product Rank] desk mobility and posture tools for remote workers |
| SWC-195 | deef91c2-2d5d-4665-81fe-5d7f9645edb4 | [TEST] Foldable adjustable aluminum laptop stand + carry sleeve |
| SWC-196 | bf3abfa7-ffc6-4708-9d42-cb8446bf3b4c | [TEST] Desk-reset trigger-point foam roller / compact recovery roller |
| SWC-198 | e9f89f6f-736b-4a49-b15b-fb5fcae0dcac | [Locate] Adjustable double-height desk foot hammock |
| SWC-199 | d24bdc6a-0479-4d30-beec-b846e6967a42 | [Locate] Foldable adjustable aluminum laptop stand + carry sleeve |
| SWC-201 | f5a7779a-3762-4e6c-af3a-acf218637ec2 | [Post-locate] Outreach + shipping — 20260814T002237Z |
| SWC-202 | 556956eb-f89e-4aea-b9d4-cb659e00e34d | [Locate] Roll-Up Over-Sink Dish-Drying Rack |
| SWC-204 | a395ad47-68ce-41eb-9cf6-45e024906fe8 | [Locate] Four-Compartment Food-Bag Drawer Dispenser |
| SWC-206 | 46ef8f5a-07e0-45d0-9ec9-7207e371678e | [Post-locate] Outreach + shipping — 20260814T040702Z |
| SWC-207 | cc6ca9ce-c795-468b-9e04-2685bc2653b1 | [Post-locate] Outreach + shipping — 20260814T080232Z |
| SWC-213 | 5b021b2f-cd33-40e3-81ea-31328c595693 | [Post-locate] Outreach + shipping — 20260815T040224Z |
| SWC-215 | f2ca2f02-642f-4418-811b-137e689f3608 | [Post-locate] Outreach + shipping — 20260815T080212Z |
| SWC-217 | c4b6e783-59a1-4a62-8578-031afdf40859 | [Post-locate] Outreach + shipping — 20260815T200154Z |
| SWC-219 | 8297a19b-7039-4e6f-96bb-f7de700e1fb7 | [Product Rank FALLBACK] desk mobility and posture tools for remote workers |
| SWC-220 | 3b5e5a36-be94-4309-882e-fd4cfca446ff | [TEST/FB] Rocking height-adjustable memory-foam under-desk footrest |
| SWC-224 | 3773a499-ec87-44c8-a91f-497f9a1240a6 | [TEST/FB] Textured topographic anti-fatigue standing mat (compact desk size) |
| SWC-226 | e0386623-32bd-4304-b8b5-158ba63537fc | [Locate/FB] Rocking height-adjustable memory-foam under-desk footrest |
| SWC-227 | f16b038a-7fdc-418d-bf80-369986328b6e | [Locate/FB] Silent under-desk pedal exerciser (no-screen mechanical) |
| SWC-229 | d5be38c5-d8f0-435f-9432-404bfdf89ee4 | [Post-locate] Outreach + shipping — 20260816T000702Z |
| SWC-230 | 5f617690-0d2c-4ae8-b90f-5e72693830b3 | [Product Rank FALLBACK] kitchen organizers under $40 |
| SWC-231 | b7d73c89-76ba-4c61-9c92-832f86cb9449 | [NO-GO] Stackable Fridge Water-Bottle & Tumbler Rack (2-Pack) |
| SWC-233 | 79732998-3d06-47d7-a012-35fec430cd24 | [NO-GO] 360° Turntable Lazy Susan Duo (Pantry + Fridge) |
| SWC-234 | 64c60e7c-7fdf-4f20-bc72-c3eecf693012 | [NO-GO] Bamboo Bag Organizer Dispenser (Foil/Wrap/Bag Trio) |
| SWC-236 | 2d172064-4fcd-422c-a32b-f8bc0fd293bb | [Locate] Stackable Fridge Water-Bottle & Tumbler Rack (2-Pack) |
| SWC-238 | cecd4aa5-7626-4fba-b9e0-4c3f6131bdb9 | [Locate] 360° Turntable Lazy Susan Duo (Pantry + Fridge) |
| SWC-239 | 1dc14ea7-032e-43c7-9799-a1b786b5e15d | [Post-locate] Outreach + shipping — 20260816T040454Z |
| SWC-241 | fddade29-e614-42b8-bad5-e921c2b2e99e | [Product Rank FALLBACK] pet travel accessories |
| SWC-243 | 6ac56a13-e503-4eb7-9062-884fc6a1f2fa | [TEST] Airline-style soft pet carrier backpack with side expanders |
| SWC-245 | dd584fc2-5880-48dd-98a0-6b2e56d8d784 | [Locate] Airline-style soft pet carrier backpack with side expanders |
| SWC-247 | e070032f-c16f-4c3e-beb5-9fa35a3f3d26 | [Locate] Pet travel organizer tote (bowls, bags, docs, meds pouches) |
| SWC-248 | b36f1698-c532-4a7a-afa2-ca79287356f8 | [Post-locate] Outreach + shipping — 20260816T080535Z |
| SWC-250 | b508a600-6919-418b-b948-23a4c3ed9555 | [Post-locate] Outreach + shipping — 20260816T080605Z |
| SWC-252 | 262092e4-c987-4097-b1bc-b28e2707b7f3 | [Product Rank FALLBACK] home gym micro-equipment |
| SWC-260 | cadbff27-7c02-44ce-ba5c-aceccaddac97 | [Locate] Pilates Ring + Mini Loop Band Trio Mobility Bundle |
| SWC-262 | 6d994eae-800b-459d-af18-dc431e69afc7 | [Locate] Progressive Fabric Resistance Band Kit + Door Anchor + Workout Cards |
| SWC-264 | e84dc025-309a-43d5-932f-c950dc47ce8c | [Post-locate] Outreach + shipping — 20260816T120413Z |
| SWC-266 | eeda5d77-4a13-4831-b061-18b7531e25e7 | [Product Rank FALLBACK] travel tech organizers |
| SWC-268 | 88c87b0c-4e66-436e-9e0c-c256b53c3f4d | [TEST] TSA-friendly toiletry + tech wet/dry split Dopp kit |
| SWC-270 | 62680189-cbd5-49c7-87f9-5ed874a25c54 | [TEST] Modular tech pouch with labeled cable inserts |
| SWC-274 | d3a916a6-3c4b-44bc-aaa1-51ee936f4c18 | [Locate] TSA-friendly toiletry + tech wet/dry split Dopp kit |
| SWC-276 | 3eae690f-d16f-468a-84ba-56fe26950f96 | [Locate] Modular tech pouch with labeled cable inserts |
| SWC-277 | 54647533-cc7b-4109-bfcf-a20fa7b56cb2 | [Locate FALLBACK] TSA-friendly toiletry + tech wet/dry split Dopp kit |
| SWC-279 | b54e68ac-4c49-495b-96cd-30d523659f7c | [Locate FALLBACK] Modular tech pouch with labeled cable inserts |
| SWC-280 | 55b1eb61-5594-445f-a253-2281bfbfbdec | [Post-locate] Outreach + shipping — 20260816T160621Z |
| SWC-281 | 41f673ba-fa90-43ca-a5b9-cba370f1d376 | [Product Rank FALLBACK] sustainable bathroom gadgets |
| SWC-282 | 55d8fb49-5f7f-4628-93e4-197be88689cc | [NO-GO] Reusable bamboo cotton rounds set with mesh wash bag (30–40 pads) |
| SWC-283 | c814b601-aaed-46e0-87b9-4ed2324bb995 | [NO-GO] Safety razor starter kit with bamboo handle + stand + blades tin |
| SWC-284 | 0a2d11e2-6703-4cb0-84cd-f565cce23a35 | [NO-GO] Solid shampoo + conditioner bar duo with travel tin |
| SWC-285 | cff0b41b-037e-4869-91e1-e2852ef1323b | [Locate] Reusable bamboo cotton rounds set with mesh wash bag (30–40 pads) |
| SWC-286 | bcff9d11-9853-411d-9db9-75980c908751 | [Locate] Safety razor starter kit with bamboo handle + stand + blades tin |
| SWC-288 | 44cb3406-88d8-4658-a151-6f8a171d5f62 | [Locate FALLBACK] Reusable bamboo cotton rounds set with mesh wash bag (30–40 pa |
| SWC-290 | 252b8b4f-b474-44cc-8343-9adb09c4d94b | [Locate FALLBACK] Safety razor starter kit with bamboo handle + stand + blades t |
| SWC-291 | 61933c7d-f55c-4c3f-aeab-d09c0532633d | [Post-locate] Outreach + shipping — 20260816T200544Z |
| SWC-292 | 4dbca16d-c8c9-4d3c-b759-5988d11014bb | [Product Rank FALLBACK] desk mobility and posture tools for remote workers |
| SWC-295 | 55840614-dadd-4d11-b889-c6f88d0cd30d | [TEST] Wobble/balance board for sit-stand desks |
| SWC-297 | c8743c82-f3dd-4516-b9e2-0321ad51d12d | [Locate] Portable under-desk pedal exerciser (tension-adjust, fold-flat) |
| SWC-299 | a49435f6-d147-4dfc-b51b-61082b82c1d6 | [Locate] Under-desk silent mini elliptical (magnetic resistance) |
| SWC-301 | 7c8a6a51-6348-44d1-967f-d14b7e7e2ded | [Locate FALLBACK] Portable under-desk pedal exerciser (tension-adjust, fold-flat |
| SWC-303 | bf786b42-af3e-4976-9c88-81503968fd25 | [Locate FALLBACK] Under-desk silent mini elliptical (magnetic resistance) |
| SWC-305 | 954fc139-cccc-4e4f-a229-739b30226ca7 | [Post-locate] Outreach + shipping — 20260817T000528Z |
| SWC-307 | 5d0a8dca-5c31-4e11-8e66-87b6a3aa3a07 | [Product Rank FALLBACK] kitchen organizers under $40 |
| SWC-308 | 25b15857-a374-495f-a5e6-ca046e317d83 | [NO-GO] Pantry Shelf Divider Set (clip-on, 4-pack) |
| SWC-309 | 4e740697-24dc-481a-8e90-bed3340989b2 | [NO-GO] Expandable Bamboo Drawer Organizer Set (3-pc nested) |
| SWC-310 | 9f274912-747a-4f8e-9e9b-fc56ecd59dfc | [NO-GO] Water Bottle & Tumbler Cabinet Organizer (stackable rack) |
| SWC-311 | 850718a8-f49d-4975-bd09-92eb86a13911 | [Locate FALLBACK] Pantry Shelf Divider Set (clip-on, 4-pack) |
| SWC-312 | db19260e-615f-4909-98c3-bc5cd42fca79 | [Locate FALLBACK] Expandable Bamboo Drawer Organizer Set (3-pc nested) |
| SWC-313 | 22819ce5-30d3-442f-9862-1d034a647b16 | [Post-locate] Outreach + shipping — 20260817T040450Z |
| SWC-315 | 55c26c7b-7dde-4cfc-9fbb-95d1efb5c27c | [Product Rank FALLBACK] pet travel accessories |
| SWC-316 | d64cf113-4473-403e-a606-b61a0e5e36df | [TEST] Inflatable elevated pet travel bed with puncture-resistant top and carry  |
| SWC-318 | 4cdcedf3-ad0f-45df-90b8-ec91ab587113 | [TEST] Crash-tested style 3-in-1 dog seatbelt harness (walk harness + car tether |
| SWC-320 | 3cc7a432-5fba-4a4d-ad0d-58f075a59da6 | [TEST] Waterproof pet car rear-seat hammock cover with seat anchors and side fla |
| SWC-321 | c2214760-9839-4616-aece-d9653f13699a | [Locate FALLBACK] Inflatable elevated pet travel bed with puncture-resistant top |
| SWC-322 | eb2e82b1-63e4-41c0-b14d-83f1039f1ae0 | [Locate FALLBACK] Crash-tested style 3-in-1 dog seatbelt harness (walk harness + |
| SWC-324 | 8603fc1f-f287-483e-b89a-88f62d6d0f68 | [Post-locate] Outreach + shipping — 20260817T080543Z |
| SWC-326 | 4a1fd915-9e10-4a88-8628-9100bbcfd561 | [Product Rank FALLBACK] home gym micro-equipment |
| SWC-328 | c1b5d63e-3e82-49d9-ac26-1e611c15e453 | [TEST] Suspension trainer straps (door anchor bodyweight system) |
| SWC-329 | 95f5a399-e25e-40db-acf2-c7e381f78515 | [TEST] Under-desk mini pedal exerciser (no electronics) |
| SWC-331 | d2564e81-057d-4022-a033-3bc4fc15dd5c | [Locate FALLBACK] Suspension trainer straps (door anchor bodyweight system) |
| SWC-332 | 39a7df8e-1987-4c9f-9a81-2d71efa2214e | [Locate FALLBACK] Under-desk mini pedal exerciser (no electronics) |
| SWC-333 | 89525cd4-4a65-4ba9-b772-68d53410e9be | [Post-locate] Outreach + shipping — 20260817T120524Z |
