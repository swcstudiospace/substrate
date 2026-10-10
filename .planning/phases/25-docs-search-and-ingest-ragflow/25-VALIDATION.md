# Phase 25: Validation

**Scope:** everything provable without the live system (rehearsal-first,
D25-10). Every real RAGFlow touch is an explicit OPERATOR-GATED step the
executor did not perform.

## Rehearsal evidence (fake-based, all green)

| Claim | Proof |
|---|---|
| Explicit `dataset_ids` on every retrieval | `planes/ragflow.test.ts`: wire body pins ids; fake 400s without them; client throws pre-network |
| `page_size <= 10` on the wire | clamp test (12 → 10) |
| Both response shapes parse (U-01) | full + minimal fake shapes, version-swap test |
| Citation shape + 1,200-char redacted snippets | `docs-search.test.ts`: shape, cap, `sk-proj` redaction with `[REDACTED]` marker |
| Untrusted framing + URL-listing note event | notice constant asserted; payload `urls` equals reply URLs; no `repo` |
| Empty-plus-reason errors | 503 injection, unconfigured plane; warning event carries the reason |
| All six ingest refusals | `docs-ingest.test.ts`: findings (rule names only, values never logged), no-URL, outside-roots, page/call caps, anonymous + guest with zero fake requests |
| Image stripping + hash idempotency | strip counts (remote removed, local kept); skip/replace by sha |
| Upload/poll/done-plus-timeout (U-02) | fake three-step; `parse-timeout` refusal on never-finishing parse; U-03 metadata asserted on uploads |
| Resolve-by-name + create-on-miss with TEI bge-small | `docs-datasets.test.ts`: no create POST on match; create body pinned on miss; `createOnMiss: false` rehearsal |
| Last-five version retention, monotonic numbers | 7 refreshes keep v3–v7 |
| Skills-sync-not-live degradation | warn-once `skills-sync-not-live`; pinned serve with `pin_age_ms`; pin age in search reply; fast-forward flips live and drives refresh |
| Substrate-only door | `store-lock.test.ts`: no RAGFlow MCP wiring, no out-of-package import, no committed credential (23/23) |
| Registrations | MCP + REST proofs for both tools; `observe.test.ts` pins; `policy.test.ts` fail-open/fail-closed pins; `event-sources.test.ts` unchanged |

## OPERATOR-GATED inventory (untouched by the executor)

- **G1** first live reachability/version probe — proof: U-01 version plus U-02 path confirmation recorded; rollback: no writes made.
- **G2** dataset discovery/creation — proof: name-matched list, creation only on miss; rollback: delete created test dataset.
- **G3** any real ingest — proof: planted-secret refusal plus real-page round-trip with U-03 meta round-trip record; rollback: remove ingested test docs.
- **G4** any real search served to an agent — proof: headless session cites a docs_search URL readable back from its event (Phase 5 proof shape).

Runbook: `docs/runbooks/docs-proof.md`. Each gate records its proof read
and rollback in the phase report before execution resumes at that gate
only.
