# Phase 29 Plan 01: Teachable write path Summary

**Status:** complete — accepted `fact` with `teachable:` subject emits one
sample-shaped `note`; refusals emit none; vocabulary locks green.

## What was built

`packages/mcp-server/src/teachable.ts` (new): the `teachable:` subject
convention plus the trail event builder.

- `TEACHABLE_SUBJECT_PREFIX` (`"teachable:"`), `isTeachable(kind, subject)`
  (kind `fact` + normalised subject with a non-empty slug after the prefix),
  `teachableSlug(subject)`, and `teachableEvent(writer, request, result)`
  returning the `EventInput` shaped like the `teachable.accepted` sample:
  kind `note`, surface = writer, summary `teachable accepted: <slug>`,
  caller's `session_id`/`graph_id`, payload
  `{ action: "teachable", memory_id, subject, content_sha256 }` — entry id and
  content hash, never content bytes.
- `service.ts` `writeMemory`: after `auditMemoryWrite`, an accepted +
  verified_persisted teachable emits via `this.emit` fire-and-forget
  (`.catch(() => undefined)`), guarded on the writer being a known surface —
  the same SURFACES check and failure semantics as the audit trail. No gate,
  RBAC, redaction, or refusal-trail change; non-teachable writes emit nothing.

## Tests

`packages/mcp-server/src/teachable.test.ts` (new, 17 tests): predicate
(including `teachable:`-with-empty-slug and normalisation),
builder (id/hash, no body bytes, omitted session/graph),
`teachable.accepted` sample-shape conformance (kind, surface semantics,
action, exact payload keys), and service-level coverage with a narrow fake
store — accepted teachable emits one note; ordinary fact emits nothing;
unverified accept emits nothing; quarantined/denied/conflicting teachables
emit no `teachable` event; a failed trail write never fails the write.

## Verification (all green)

- `bun test teachable.test.ts`: 17 pass
- `bun test service/memory-write/event-sources/vocabulary-lock`: 370 + 2 pass
- `bunx tsc --noEmit`: clean
- `bun run check:phase-close`: pass — EVENT_KINDS at 12, SURFACES at 27

## Decisions

- Payload `subject` is the full stored subject (`teachable:retry-budget`),
  per the plan's explicit field list; the conformance test pins shape
  (keys/kind/action), not the value, so it cannot drift against the sample.
- `isTeachable` falls back to `result.entry.subject` when the request carries
  no subject (stored subject is normalised, so the check still holds).
- Deviation (auto-fixed, Rule 3): none to the design; one self-inflicted
  import clobber (`redact` import replaced by the new import) caught by tests
  and restored before commit.

**Commit:** 60c8380
