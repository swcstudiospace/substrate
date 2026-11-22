---
phase: 71-multi-session-boundary
plan: "04"
task: "03"
status: documentation-edits-complete-unverified
requirements-addressed: [HARD-S1]
requirements-completed: []
verification: not-run
---

# 71-04 Documentation Lane Summary

Existing documentation and environment examples were updated against the implemented storage, shared boundary, REST/MCP, CLI/private-record and hook contracts, including the integration owner's final committed-mutation receipt corrections. This is an edit-only documentation deliverable, not HARD-S1 verification, Phase 71 completion, deployment or merge readiness.

## Files changed

- `.env.example`: added `SUBSTRATE_LIVE_SESSION_LEASE_S=3600` with production bounds 60..86400 and heartbeat guidance; removed the dead `SUBSTRATE_STEERING_SESSION_TTL_S` example; changed `SUBSTRATE_STEERING_SESSIONS_TABLE` to historical migration-37 selection only. Clarified inbox versus independent lifecycle MCP registration and audit migrations 33/34.
- `docs/live-steering.md`: permanent credential-cutover record; independent public handle/private proof, mandatory migration 42, immutable ownership/terminal IDs, permissions, exact lifecycle/discovery/private REST/MCP contracts, errors and principal/audit ordering, public discovery versus private content/count, CLI secure record selection and lost-record behavior, explicit historical/live hook split, coherent public-output-only examples, lease renewal and same-OS-account limits. Existing public worktree-overlap contract was retained.
- `docs/data-planes.md`: distinguished non-disposable SQL authority from historical removed cache, optional durable inbox audit and ephemeral presence/cache; updated routes/brief/docs/history/private release and committed-receipt semantics without changing the public digest contract.
- `docs/event-vocabulary.md`: hash-only refusal payload; current phase-71 close producer/repository mapping; removed the obsolete persistence-warning producer row while describing unchanged historical rows; documented safe new live event projections and unchanged historical queries/kinds/surfaces.
- `docs/coordination.md`: separated live proof identity from historical graph/checkpoint/handoff labels; left graph lease fencing/reclaim rules unchanged.
- `docs/runbooks/session-rollback.md`: historical checkpoint identity stays stable; private hint lookup requires an explicit live handle and selected file; consumed decisions include historical/live identities; host/checkpoint fail-open is not private authorization fail-open; print-only configuration installs nothing.
- `docs/runbooks/index-archive.md`: explicitly excluded live bindings/tombstones and other non-whitelisted tables from closed logical archive coverage; preserved logical compatibility-hash scope; documented complete native PostgreSQL backup/recovery, quiescence across REST/MCP/docs/brief, complete issued-identity history and restored-active invalidation, with no claim that lost tombstones can be reconstructed or a native backup was rehearsed.
- `docs/runbooks/rollback-compat.md`: historical migration 37 and additive mandatory migration 42, binding-record persistence, and explicit security exception to old-code rollback. A compatible table shape/health response is not authorization compatibility; no automatic down, tombstone deletion, reset or downgrade to unbound live serving.

Created only this requested lane summary. No new user documentation bundle was introduced.

## Final concurrency contract incorporated

Read the final product exports after the integration owner's correction:

- Issuance/update receipts contain only `session_id`, `repo_id`, `state`, `updated_at`, `expires_at`, `event_stored` and status; issuance alone additionally returns the proof once to its originating creator. No lifecycle receipt echoes private steering/planning hash.
- Heartbeat returns the committed renewal receipt; close returns committed `closed_at` and `event_stored`. Successful SQL/inbox mutation receipts remain truthful after later close/outage, not retroactive 404/no-effect claims. An already-closed issued proof is unusable; issuance is not a continued-liveness promise.
- `event_stored: false` reports the subsequent best-effort public-note failure without undoing committed SQL. Required generic mutation audit remains before effects.
- Accepted acknowledgement can stand while state application refuses. If movement already committed, applied/unchanged metadata remains truthful while a failed final live check withholds the checkpoint hint. Private docs/brief/directives/wait still perform final SQL authorization before private release.
- No distributed rollback, safe blind retry, lost-proof reset or ID reuse is claimed. Commit/transport/local-persistence failures can remain uncertain.

The current producer catalog was reread after integration updated it: `steering.session_ended` is phase 71, carries the closed session repository and public close metadata; the obsolete `steering.persist_failed` producer row is gone. Documentation follows those actual exports, not the earlier summary's stale sample.

## Intentionally unchanged / parent-owned

- Historical event/checkpoint/rollback authorization, labels and previously published ledger rows; no retroactive confidentiality claim.
- Public repository digest shape, redaction, caps, provenance/source age and historical self-exclusion; metadata remains distinct from private inbox bodies/counts.
- Operator-only unkeyed queue/ack body shapes, principal allowlist, confirmation and existing directive audit/state semantics.
- Applied historical migration SQL/digests/schema, generated migration digest and generated `docs/config-reference.md`; parent owns generation.
- Source, tests, ROADMAP, STATE, REQUIREMENTS, phase verification and overall `71-04-SUMMARY.md` were not edited in this lane.

## Evidence and remaining gates

Read the installed executor persona, assigned plan/context/validation, 71-01/02/03 summaries, repository rules, and relevant implemented exports. The worktree briefing file was absent. Source reading and file-edit results are the only lane evidence.

**No tests, builds, typechecks, lint, formatters, installations, code generation, git writes, SQL connections or runtime checks were run by this lane.** No test counts, passing gates, deployment, production migration/rehearsal, complete backup/restore, real credential issuance, hook/timer installation or real-host delivery is claimed. Parent-owned verification remains necessary and this summary leaves completed requirements empty.

Parent must generate the config reference with the existing generator, exercise the declared 71-VALIDATION groups and Task 3 policy/config/migration/hook checks after integration, and record real results. Desk Quality/Programming Lead Greptile review is separate; unavailable/skipped/failed review is a blocker, never merge readiness. Draft PR only; no merge/auto-merge.
