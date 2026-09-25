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
