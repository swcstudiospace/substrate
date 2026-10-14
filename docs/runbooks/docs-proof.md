# Docs proof runbook (RAGFlow)

Rehearsal evidence for the docs plane lives in the Phase 25 summaries;
everything below is OPERATOR-GATED: the executor performs none of G1–G4.
Each gate names its command, its proof read and its rollback. No command
here prints a credential value — the bearer travels in a header read from
the server env file, and probes report status plus redacted shape only
(`docs/runbooks/production-identity.md` agent-query rules).

All commands assume the operator shell has the server env loaded without
echoing it:

```sh
set -a; . /etc/substrate/substrate.env; set +a
```

## G1 — first live reachability/version probe (OPERATOR-GATED)

Records the deployment version (U-01) and confirms the upload/parse paths
(U-02) against the deployment plus the public HTTP reference
(`https://ragflow.io/docs/http_api_reference`).

```sh
curl -s -w '\n%{http_code}\n' "$RAGFLOW_URL/api/v1/datasets" \
  -H "authorization: Bearer $RAGFLOW_API_KEY" | tail -5
```

Proof read: HTTP 200 with a dataset list; the response's version field
(if any) is recorded into the phase report, and any shape beyond the two
rehearsed response shapes is recorded with it. Confirm which upload/parse
paths the deployment serves before any ingest.

Rollback: no writes are made; nothing to roll back.

## G2 — dataset discovery/creation (OPERATOR-GATED)

```sh
curl -s "$RAGFLOW_URL/api/v1/datasets" \
  -H "authorization: Bearer $RAGFLOW_API_KEY"
```

Proof read: the name-matched list (`agent-substrate`,
`programming-desk`, `agent-skills`, plus any `<product>` name). Creation
only for names with no match, with TEI `bge-small` pinned:

```sh
curl -s -X POST "$RAGFLOW_URL/api/v1/datasets" \
  -H "authorization: Bearer $RAGFLOW_API_KEY" -H 'content-type: application/json' \
  -d '{"name":"<missing-name>","embedding_model":"tei-bge-small"}'
```

Rollback: delete any test dataset this gate created; re-list to confirm
the pre-gate names remain.

## G3 — any real ingest (OPERATOR-GATED)

Two proofs, in order:

1. Planted-secret refusal: ingest a page containing a known-canary
   secret-shaped string through `docs_ingest` and confirm the
   `docs.ingest.refused` warning (rule names and hashes only).
2. Real-page round-trip: ingest one real page and confirm the retrieval
   echoes the sent `{source_url, commit, heading_path}` metadata (U-03
   round-trip record goes into the phase report: which keys round-tripped).

Rollback: remove the ingested test docs from the dataset; confirm the
dataset list and versions match the pre-gate state.

## G4 — any real search served to an agent (OPERATOR-GATED)

Run a headless session that answers a docs question through
`docs_search`.

Proof read: the session's reply cites a `docs_search` URL that reads back
from its `docs.search` note event (the Phase 5 proof shape) — the cited
URL, the event URL list and the served chunk agree.

Rollback: none required (a read); record the session id in the phase
report.
