---
phase: 21-skills-propose
plan: "03"
subsystem: server
tags: [route, mcp, registration, audit]

requires:
  - phase: 21-skills-propose plan 02
    provides: the plan before this one, as sequenced in the roadmap
provides:
  - POST /skills/propose and the skills_propose MCP tool, both ending in Substrate.proposeSkill
  - skills/request.ts: the shared body-shape check, the request builder and the failure-to-status mapping
  - BodyTooLargeError, answered 413 on this route only
  - the registrations: mcp.ts, KNOWN_TOOLS, KNOWN_ROUTES, and the audit policy contract

key-files:
  modified: []

requirements-completed: [SKILL-01]

coverage:
  - id: D1
    description: "the route answers every D21-09 code and the tool mirrors each as an isError reply"
    requirement: "SKILL-01"
    verification:
      - kind: integration
        ref: "bun test packages/mcp-server/src/http.test.ts (74) and mcp.test.ts (62), skills/request.test.ts (28)"
        status: pass
    human_judgment: false
  - id: D2
    description: "registration: tool listed with its annotations, KNOWN_TOOLS and KNOWN_ROUTES, explicit fail-closed, audited on the REST transport under its own name"
    requirement: "SKILL-01"
    verification:
      - kind: unit
        ref: "bun test packages/mcp-server/src/observe.test.ts packages/audit/src/policy.test.ts"
        status: pass
    human_judgment: false

completed: 2026-10-09
status: complete
---

# Phase 21 Plan 03 Summary

**Two audited doors on one method, with one body check and one failure mapping, so the doors cannot answer the same input differently.**

- The route answers 200 with the `ProposeResult`, 400 for a malformed body or a refusal (`{ error, findings? }` with findings as file, line and rule), 401 anonymous (before the body is read, even with anonymous callers allowed), 403 surface mismatch or operator-only option, 413 oversize (this route only; other routes keep their generic 500), 502 a failed git or gh step (redacted, at most 400 characters), 503 when the fail-closed audit cannot take the record.
- The tool returns the same JSON and an `isError` reply carrying the same body for every non-200 case.
- The route is audited under `skills_propose` before any git work, on the REST transport; the audit record digests the body (no file content).
- Registered in `mcp.ts`, `KNOWN_TOOLS`, `KNOWN_ROUTES`; `FAIL_CLOSED_TOOLS` already listed the tool from Phase 17, and a policy test now pins that dropping any one registration fails the build.

## Task Commits

1. `bbe394a` feat(21-03): add POST /skills/propose and the skills_propose MCP tool

## Mutation checks

Removing the route's 401 check failed 1 (the oversize-anonymous test, since the service's own 401 still answers: two layers); removing the audit call failed 4; making every MCP caller an operator failed 1.

## Deviations

The plan listed `server.test.ts`; the route tests live in `http.test.ts`, which drives the real socket. The 413 mapping is limited to this route because an existing test pins the generic 500 for an oversize body elsewhere.

## Self-Check: PASSED

The commits above exist; the commands named under each coverage entry passed in the final run (tsc exit 0; full suite 1851 pass / 57 skip / 0 fail).
