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
