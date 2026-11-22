# Phase 71: Multi-Session boundary - Context

**Gathered:** 2026-10-31
**Status:** Ready for gap-closure planning; preliminary implementation is not complete.

<domain>
## Phase Boundary

Enforce the accepted session-isolation feature across session-scoped APIs. Re-check caller binding on the server. Foreign and unknown session IDs must produce indistinguishable not-found responses. Session identifiers must be unguessable and never reused. Preserve operator-only steering writes and the existing redacted repository-wide `session_context` digest.

The merged milestone definition omitted the identifier lifecycle and narrowed not-found into forbidden. Those omissions do not reduce the accepted feature's requirements. No phase is complete until the original behavior is covered.
</domain>

<decisions>
## Implementation Decisions

- **D71-01:** The owner accepted all eight hardening features and retaining unkeyed steering commands. Do not ask again about those decisions.
- **D71-02:** The owner explicitly approved running the installed GSD workflows through available agents/tools in place of the unavailable Skill dispatcher. Preserve CONTEXT, PLAN, SUMMARY, verification, and phase ordering.
- **D71-03:** Keep surface bearer authentication and operator authorization; reuse existing identity and durable index patterns. Alternative: introduce a separate authentication service. Rejected as unnecessary scope.
- **D71-04:** Foreign and unknown target sessions must return the same 404 status/body/headers without exposing ownership or existence. Record internal refusal audit with a hashed identifier, not raw requested session IDs. Alternative: current 403 with ownership reason. Rejected because it does not meet the accepted requirement.
- **D71-05:** Choose a cryptographically generated identifier lifecycle with durable ownership/revocation/non-reuse. Assess existing client-generated IDs and registration before changing contracts. Do not equate UUID-shaped client input with proven server issuance. A volatile cache is not binding authority.
- **D71-06:** The redacted repository-wide digest is intentionally cross-session, not a private steering command list. Keep it unchanged and document that scope distinction.
- **D71-07:** No deployment, production migration, timer installation, funding, or devnet transaction. New PRs remain draft; no merge or auto-merge.
- **D71-08 (owner decision):** Use a separate per-session binding credential. The owner selected this over trusting all sessions sharing a surface token. Server issuance returns a public CSPRNG session ID and a separate private CSPRNG credential once; persist only the credential hash, immutable surface ownership, active lease, and terminal tombstone. Migrate REST/MCP/CLI private session consumers together. Preserve the public digest but never expose private directions, credentials, or private command counts through unproved discovery. This is an approved credential-protocol change, not permission to weaken the original isolation requirement. **Reversibility:** costly — clients must keep and present the new credential.
- **D71-09:** Session IDs are metadata, not secrets or credentials. Choose independent 32-byte random values for the identifier and credential; never derive one from the other or from the shared surface token. Same-OS-account filesystem compromise is outside the network session-isolation guarantee; document that limit rather than claiming process sandboxing.
- **D71-10:** Historical event/checkpoint session labels remain separate from live steering identity. Generic attribution must not authorize private retrieval or implicitly revoke another live session. Docs/brief APIs use explicit live steering handle plus binding proof for private augmentation.

### Engineer's Discretion

Reuse existing typed errors, PostgreSQL migration/store conventions, event vocabulary, bounded work, and CLI argument patterns. An existing opt-in durable session table is a best-effort restart cache, not an authorization authority; do not silently relabel it durable security state. Preserve current operator-only queue/ack rules.
</decisions>

<canonical_refs>
## Canonical References

- `.planning/ROADMAP.md` — phase scope and progress, corrected by this context where narrowed text contradicts the accepted feature.
- `docs/live-steering.md` — current REST/MCP/CLI steering contract and operator writes.
- `docs/data-planes.md` — state ownership and cache-only role.
- `packages/mcp-server/src/planning/session-state.ts` — surface-keyed registry and best-effort durable persistence.
- `packages/mcp-server/src/planning/steering-tools.ts` — shared steering admission and audit.
- `packages/mcp-server/src/planning/steering-sessions-store.ts` — existing durable session adapter.
- `packages/mcp-server/src/mcp.ts` — docs session registration and steering tools.
- `packages/mcp-server/src/server.ts` — HTTP authorization and route responses.
</canonical_refs>

<code_context>
## Existing Code Insights

Preliminary ownership gate edits exist but are uncommitted. They bind steering reads to a surface's registry entry; they do not mint IDs, keep durable tombstones, or cover all session-scoped entrypoints. Registry entries can currently be registered under the same ID by different surfaces and are forgotten on TTL/cap eviction; durable writes fail open by design. These are gaps, not accepted behavior for the new security boundary.

### Verification already observed

- Broader planning/steering/session tests: 1,076 passed, 10 skipped, zero failed across 38 files; TypeScript and lint passed.
- Real ephemeral HTTP server smoke: owner 200; foreign 403; unknown 403; foreign/unknown bodies equal. This proves preliminary gates operate but also proves the required 404 behavior is missing.
- The recorded unmodified steering baseline was 575 pass, 7 skip, zero fail; the recovered broader command is not the exact same file set, so do not claim identical baseline counts.
</code_context>

<specifics>
## Specific Ideas

Complete the security lifecycle before claiming delivery. Do not substitute a standalone registry helper with no routed consumers. Every affected REST/MCP/CLI consumer, test, and runbook must be migrated together.
</specifics>

<deferred>
## Deferred Ideas

The other seven hardening features remain separate phases. Phase 74 was incorrectly counted as a no-op; absence of an existing multi-repo transaction is not delivery of the requested feature. It must be implemented against a real selected multi-repo operation or explicitly parked after a scope decision.
</deferred>
