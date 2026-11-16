# Phase 34: invalid-write round trip

## Gap
uplift-7 MILESTONE-AUDIT row 23: "Invalid writes are rejected, with nothing partially
persisted." Status FAIL: shape refusals exist, but the round trip (invalid payload in an
isolated namespace, then count the rows the write would have touched) was never run.

## Write surfaces found (client input → persisted state)
| Surface | Entry | Validation | Persists |
|---|---|---|---|
| POST /memory | server.ts:1070-1085 | body JSON, then gate | memory_entries, memory_writes, memory_quarantine, memory_reviews |
| MCP memory_write | mcp.ts:288-349 | zod schema, then `substrate.writeMemory` | same |
| POST /skills/propose | server.ts:1400-1417 | `proposalBodyProblem` (skills/request.ts:21), then engine `validateProposal` (skills/propose.ts:207) | git branch/PR; skills_registry on opened/existing |
| MCP skills_propose | mcp.ts:1044-1080 | zod, then service | same |
| POST /skills/approve | server.ts:1432-1447 | `approvalBodyProblem` (skills/registry.ts:238), then `validateApproval` (registry.ts:259) | skills_registry |
| MCP skills_approve | mcp.ts:1084-1118 | zod (`pr_number: z.number()`), then service | skills_registry |
| POST /docs/ingest | server.ts:1248-1300 | route shape, then `ingestDocs` per-page loop (docs-ingest.ts:386-404) | RAGFlow (retired) uploads, docs ingest state |
| MCP docs_ingest | mcp.ts:887-919 | zod, then `ingestDocs` | same |

Not in the assignment list and not covered here: `/events`, `/handoff`, graph claim/bind routes.

## Current behaviour, read
- Memory shape checks run before any store call: writer, scope, kind, ttl, text, lesson
  (memory-write.ts:448-491), then RBAC (:494), then classification/quarantine (:621),
  then `claimWrite` (:671). A shape refusal therefore touches no table. Refusals map to
  403 through `memoryWriteStatus` (server.ts:410-418) because `denied` with a non-`store.`
  reason falls to the default branch.
- **POST /memory, non-object body.** server.ts:1072 does `JSON.parse(raw) as Record`.
  `auditedRest` (server.ts:1079) runs on whatever parsed, then line 1082 reads
  `body.writer`. For `null` that is a TypeError, answered 500 by the outer catch
  (server.ts:1480-1496). The audit record from `auditedRest` has already been written
  (`auditToolCalls` appends with `args: null`, observe.ts:709-714). For arrays, strings and
  numbers the body reaches the gate and is refused 403 with a shape reason, which is the
  wrong status for a malformed body; every other REST route answers 400 "request body must
  be a JSON object" (e.g. server.ts:1093-1094, 1217, 1253, 1335).
- MCP memory_write: zod refuses missing or mistyped required fields before the handler
  (mcp.ts:291-296). The SDK answers `isError` (mcp.test.ts:745-752 is the precedent).
- Skills propose: the route audits the object-shaped body (server.ts:1407) before
  `proposalBodyProblem` answers 400 (server.ts:1408-1410). The engine validates everything
  (propose.ts:936-945) before `mkdirSync`, clone, or any `run` call. `recordProposedSkill`
  writes the registry only for `opened`/`existing` (service.ts:2732-2736).
- Approve: `validateApproval` runs before `this.index` is touched (service.ts:2799-2805).
- Docs ingest: the per-page loop (docs-ingest.ts:386-404) refuses no-source-url,
  outside-roots, too-large, and secret findings for every page before the first upload
  (uploads start at :436). A refusal emits a warning (`refused`, :336-360) and persists
  nothing else; `persistDocsSeen` runs only when `outcome.ok || outcome.changed`
  (service.ts:3906).

## Audit lines before refusal
Object-shaped bodies on POST /memory, POST /skills/propose and POST /skills/approve are
audited before their shape or value checks. MCP tool calls are audited in `handleMcp`
(server.ts:1743) before the SDK validates arguments. This is the documented design:
docs/skills-propose.md:77 ("the audit chain records those that reach it"), the http test
"/memory is audited as memory_write" (http.test.ts:383), and the memory trail for denials
(service.ts:1924, "Governance that leaves no trace is indistinguishable from no
governance"). It is an attempt record, not a write to the table a surface targets.

## Decisions
1. Fix POST /memory: parse, then refuse a non-object body with 400 before the audit and
   the gate. Reason: the only partial effect found in the assignment's surfaces is an audit
   line left behind by a body that then answers 500. The 400 matches every other REST
   write route. Shape refusals from the gate keep their documented 403.
2. No change to the audit-attempt design (see above). Flagged as GREY_AREA.
3. Optional wrong-typed memory fields (`subject: 42`, `trust: 5`) are coerced or ignored
   by the REST door (memory-write.ts:448-455 and `typeof` guards), while MCP refuses them
   by zod. Not changed: it is a contract change for existing callers, outside
   "partial persistence". Flagged as GREY_AREA.
4. Tests assert the documented statuses (403 denied for memory shape, 400 for skills and
   docs, 400 for a non-object /memory body after decision 1) and zero rows in every table
   the surface writes to. Each suite also runs one valid control write so the counter is
   shown to move when a row lands.
