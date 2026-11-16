# Docs proof runbook

Rehearsal evidence for the docs plane lives in the Phase 25 summaries;
everything below is OPERATOR-GATED: the executor performs none of G1–G4.
Each gate names its command, its proof read and its rollback. No command
here prints a credential value — the bearer travels in a header read from
the server env file, and probes report status plus redacted shape only
(`docs/runbooks/production-identity.md` agent-query rules).

The docs plane is LightRAG. LightRAG replaced RAG-backend; there is no fallback that calls the retired plane.

All commands assume the operator shell has the server env loaded without
echoing it:

```sh
set -a; . /etc/substrate/substrate.env; set +a
```

An unset `LIGHTRAG_URL` means the plane is unconfigured: search degrades and ingest refuses. Do not point a probe at another docs backend.

## G1 — first live reachability probe (OPERATOR-GATED)

Confirms LightRAG answers a read-only health probe.

```sh
curl -s -o /dev/null -w '%{http_code}\n' "$LIGHTRAG_URL/health" \
  -H "X-API-Key: $LIGHTRAG_API_KEY"
```

Proof read: HTTP 200. Record the status only.

Rollback: no writes are made; nothing to roll back.

## G2 — dataset names (OPERATOR-GATED)

Dataset names are the registry in `packages/mcp-server/src/docs-datasets.ts` (`agent-substrate`, `programming-desk`, `agent-skills`, plus any product name). LightRAG keeps one workspace; names are labels on results, not separate indexes to create by hand. Confirm the registry names before ingest.

Rollback: none (a read of the registry).

## G3 — any real ingest (OPERATOR-GATED)

Two proofs, in order, through `docs_ingest` only:

1. Planted-secret refusal: ingest a page containing a known-canary
   secret-shaped string through `docs_ingest` and confirm the
   `docs.ingest.refused` warning (rule names and hashes only).
2. Real-page round-trip: ingest one real page and confirm the retrieval
   echoes the sent `{source_url, commit, heading_path}` metadata.

Rollback: remove the ingested test docs through the documented LightRAG delete path; confirm versions match the pre-gate state.

## G4 — any real search served to an agent (OPERATOR-GATED)

Run a headless session that answers a docs question through
`docs_search`.

Proof read: the session's reply cites a `docs_search` URL that reads back
from its `docs.search` note event — the cited URL, the event URL list and
the served chunk agree. An unconfigured plane degrades; it does not call
another backend.

Rollback: none required (a read); record the session id in the phase
report.
