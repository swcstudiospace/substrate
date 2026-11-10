---
phase: 71-multi-session-boundary
plan: "02"
subsystem: cli
status: locally-verified-awaiting-quality
verification_status: local-passed-external-quality-pending
requirements-completed: []
requirements-addressed: [HARD-S1]
provides:
  - Private exact-context live-session binding persistence and CLI lifecycle consumers
  - Proof-header private reads with terminal typed session refusals
  - Separate historical checkpoint and live steering hook identities
  - Authored filesystem, transport, command, renderer and hook regression coverage
affects: [71-03, 71-04]
tech-stack:
  added: []
  patterns: [exclusive private atomic records, explicit live-handle selection, metadata-only discovery]
coverage:
  - id: CLI-ISSUANCE
    description: CLI issuance projects public output and persists the private proof atomically
    requirement: HARD-S1
    verification:
      - kind: integration
        ref: packages/cli/src/steer/index.test.ts
        status: unknown
    human_judgment: false
  - id: CLI-PRIVATE
    description: Exact selected proof drives reads and lifecycle; typed session refusal terminates consumers
    requirement: HARD-S1
    verification:
      - kind: unit
        ref: packages/cli/src/steer/client.test.ts
        status: unknown
    human_judgment: false
  - id: CLI-HOOK
    description: Historical labels do not authorize live hints; consumed decisions are incarnation-scoped
    requirement: HARD-S1
    verification:
      - kind: integration
        ref: packages/cli/src/session/hook.test.ts
        status: unknown
    human_judgment: false
---

# Phase 71 Plan 02 Summary

**Parent verification update:** Local CLI/hook and integrated acceptance passed, including the actual CLI executable against native PostgreSQL. Current evidence and the outstanding external review are in `71-VERIFICATION.md`; earlier unexecuted notes are retained handoff history.

**CLI and hook consumers now retain independent binding proofs privately and address live steering separately from historical checkpoint labels.**

All three implementation tasks and their authored test migrations are complete as an edit-only deliverable. This is not verification of HARD-S1 or completion of Phase 71. Server integration, real loopback coverage and all checks remain parent-owned.

## Accomplishments

1. Added bounded binding records with canonical server identity, selected surface and exact `ls_` handle validation. Records are strictly shaped, limited to4096 bytes and256 directory entries, and published through exclusively created0600 temporary files, fsync and atomic rename. The record directory is0700; existing owner/mode, ancestor/symlink, regular-file, hardlink and fd identity checks fail closed. Exclusive directory and target reservations prevent capacity races and overwrite; existing locks are never taken over. Failed issuance persistence reports that the unused identity expires, not that a lost proof can be reset.
2. Implemented real client and command open/heartbeat/close requests. Proofs travel only in `X-Substrate-Session-Binding` on selected private operations. Heartbeat updates only the same validated record/proof; successful close removes only a matching record under its lock, freeing capacity. Failed close retains it. Explicit missing/invalid binding paths fail locally; absent default records permit unproved read/close requests solely for server-enforced operator overrides, never inferred from surface names.
3. Untargeted status projects metadata and the existing public digest without private fanout or private counts, including when an injected server returns operator fields. Metadata rendering distinguishes absent fields from explicit zero. Typed404 and503 session refusals are terminal resource/authority failures, not old-server diagnoses or infinite listener retries. Transport and server error diagnostics, rejected proof flags and nested refused-transition diagnostics are sanitized; lifecycle outputs use explicit public projections and strict timestamp guards.
4. Hooks accept explicit live handle and record path independently of historical checkpoint identity. The record is validated before hint lookup; failed authorization skips hints while preserving the ordinary checkpoint and a sanitized verbose explanation. Consumption paths and payloads include historical plus live identity, never proof. The bounded five-hint policy remains. Printed configuration is print-only and separates historical ID, live ID and binding-file variables, with lifecycle guidance.

## Files Created/Modified

Created:
- `packages/cli/src/steer/binding-record.ts`
- `packages/cli/src/steer/binding-record.test.ts`

Modified CLI consumers and tests:
- `packages/cli/src/steer/client.ts`, `client.test.ts`: lifecycle port, guarded wire projections, header transport, typed failures, metadata sessions and error secrecy.
- `packages/cli/src/steer/index.ts`, `index.test.ts`: strict lifecycle grammar, exact record selection, public issuance output, selected reads/status/listener and real injected-fetch filesystem flows.
- `packages/cli/src/steer/render.ts`, `render.test.ts`: optional private fields and explicit-zero rendering.
- `packages/cli/src/session/command.ts`, `command.test.ts`: configured URL and separate hook flags, safe unknown-flag diagnostics, real injected-fetch transport fixtures.
- `packages/cli/src/session/hook.ts`, `hook.test.ts`: explicit live authorization, envelope/flag precedence, fail-open ordinary checkpoints and proof-free payloads/journal assertions.
- `packages/cli/src/session/hook-config.ts`, `hook-config.test.ts`: three-variable print-only configuration and lifecycle instructions.
- `packages/cli/src/session/steering-consumed.ts`, `steering-consumed.test.ts`: historical/live namespace and version2 consumed payload.

Parent separately updated two root `packages/cli/src/index.ts` help lines after this executor reported the additional help consumer. This executor did not edit that file or server/storage/planning-state files.

## File and Flag Contracts

- `steer open [--repo R] [--binding-file PATH] [--json]`: initial ACTIVE state; existing origin resolver supplies repository when omitted. Prints public handle, metadata, expiry and record location only.
- `steer heartbeat|close --session LIVE_ID [--binding-file PATH] [--json]`.
- `steer list|listen --session LIVE_ID [--binding-file PATH]` and targeted `steer status --session LIVE_ID [--binding-file PATH]`, retaining their existing options.
- All commands retain `--surface`; it selects configured authentication and record context, not operator authority. There is no proof argv flag.
- Default records: `homedir()/.local/state/substrate/live-sessions/<sha256(server_identity,surface,public_handle)>.json`. `--binding-file` overrides exactly one path, never discovers a sibling. No new environment reader or credential resolver.
- Record: `version:1`, `server_identity`, `surface`, `session_id`, `session_binding`, `expires_at`. Local expiry is advisory only.
- Exported helper functions: `serverIdentity`, `bindingRecordPath`, `saveBindingRecord`, `loadBindingRecord`, `updateBindingExpiry`, `removeBindingRecord`; errors contain no raw filesystem/credential values.
- Session hooks retain historical `--session`/envelope `session_id`; private hints require `--steering-session`/`steering_session_id` and selected `--binding-file`/`binding_file`. Flags override envelope fields. Envelopes reject plaintext proof fields.
- `HookParams` adds configured `url`, optional `steeringSessionId` and `bindingFile`. Consumed helpers now take both historical and live identities. All discovered CLI callers/owned fixtures were migrated; command tests use the production client with injected fetch, not lifecycle no-op implementations.

## Intentionally Preserved

Operator-only queue/ack request bodies, unkeyed behavior, directive-only acknowledgement and confirmation flags remain unchanged. The redacted repository digest, historical context exclusion, checkpoint history, rollback identity and replay-journal contract remain historical and proof-free. No hook, timer or service was installed; no environment credential was read for a smoke check; no production effect occurred.

## Execution Deviations and Evidence

The approved available-tool executor recovery was used after provider dispatch failure. Parent supplied actual LSP references for exported SteerClient changes; scoped repository reference searches covered CLI callers and consumed-state APIs. Independent workers owned disjoint hook files and steering test files; this executor integrated their changes.

No tests, builds, typechecks, lint, formatting, installs, codegen or git writes were run by this executor or its workers. No commit hashes, pass counts or performance claims are available. Test coverage above is authored, not exercised. `requirements-completed` intentionally remains empty pending parent evidence.

## Parent Verification

Run after server integration, not concurrently against partial edits:

```sh
bun test --timeout 30000 packages/cli/src/steer
bun test --timeout 30000 packages/cli/src/session/command.test.ts packages/cli/src/session/hook.test.ts packages/cli/src/session/hook-config.test.ts packages/cli/src/session/steering-consumed.test.ts
```

Then execute the planned71-04 real HTTP/CLI round trip and parent-owned typecheck/lint/regression gates. Durable authority evidence, deployment and the Desk Quality/Programming Lead Greptile gate are not certified by this CLI edit-only summary.

## Parent integration correction

The parent reproduced an ancestor-validation gap with a throwaway credential-file scenario: a sticky directory stopped the walk before a writable ancestor was inspected. Before correction, the path was accepted and the smoke assertion failed. The parent changed `secureDirectory` to inspect every ancestor, permitting root-owned sticky system ancestors without treating them as a stopping boundary, and added a behavior regression in `binding-record.test.ts`. Repeating the same isolated runtime scenario rejected the unsafe path and passed. The permanent suite remains pending the full integration gate; this is not a Phase 71 completion claim.

The CLI owner also corrected issuance response validation to compare the server's canonical repository ID with the request's trimmed, lowercased `owner/name` form. The response keeps the canonical server ID rather than the caller's spelling. Authored client and real command-flow regressions cover mixed-case explicit repositories/origin resolution, mismatches, and credential/output secrecy; those tests await the integrated parent run.
