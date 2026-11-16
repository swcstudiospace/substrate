---
phase: 56-lightrag-contract
milestone: v1.6
requirements: [SOTA-12]
status: implemented on gsd/v16-int (a573641); not merged; criteria 1 to 7 met against upstream v1.5.7 source
---

# 56-SUMMARY: LightRAG client contract alignment and storage topology

## What was built

Commit a573641 (17 files, 1911 insertions, 229 deletions).

- `packages/mcp-server/src/planes/lightrag.ts` rewritten against the upstream v1.5.7 REST contract:
  - One request choke point (`call`) that refuses the clear-all route `DELETE /documents` in every spelling, with a fixed reason, before any network I/O. Documents are deleted only through `DELETE /documents/delete_document` with real document ids.
  - Pipeline completion read from the upstream `busy` boolean; `recovery_required` (the workspace fence) and an unknown shape each give an explicit reason; the legacy `status` string is only a fallback when `busy` is absent.
  - The API key is sent as `X-API-Key` only, on every route, and never as `Authorization: Bearer`; the key never appears in a reason.
  - The upload `track_id` is kept apart from document ids and resolved through `GET /documents/track_status/{track_id}`; HTTP 409 (same-name upload) is a typed conflict outcome.
  - A health probe (`probeLightrag`), wired in `service.ts` so `planes.lightrag.ok` is filled instead of always null.
- The private second `/query` client in `mcp.ts` (which skipped the breaker and the gated fetch) was removed; `queryForTool` in the plane client serves the `docs_lightrag_query` door.
- `planes/__fixtures__/lightrag-v1.5.7-routes.json` (route table with a `provenance` field stating it was written by hand from the upstream source, not recorded from a server) and `planes/lightrag.contract.test.ts`, which fails when the client's routes or required request fields drift, with fail-before tests that mutate the fixture.
- `docs/runbooks/lightrag-storage-topology.md` (385 lines): the topology decision, isolation and identity settings, authentication and exposure, volume, backup and restore, observability, an operator preflight checklist (including the `/openapi.json` diff step), and the upgrade and re-index design (re-ingest into a new workspace, never change the embedding in place).
- `docs/docs-plane.md` and `docs/data-planes.md` updated; `.env.example` says to pin the image and that the key is an `X-API-Key`.

## Key decisions

- Dedicated pgvector Postgres with `PGTableGraphStorage` is the recommendation; Dragonfly is not a LightRAG store; the Timescale service is not reused (runbook "Options not chosen"). A shared Postgres needs an owner decision.
- The client sends no workspace; the workspace is selected by which server process answers. Whether a workspace header exists is UNVERIFIED in the runbook.

## Deviations from the plan

- The plan described an upgrade; no previous version existed, so the topology and upgrade design are written for a first deploy and for later upgrades.
- Verification is against the upstream source and a route fixture, not a live server, because none exists.

## Findings (defects fixed)

- **P0 (found by reading upstream source):** `deleteDocuments` sent `DELETE /documents`, which upstream implements as "clear all documents" and which takes no body, so a prune would have wiped the index. No server exists, so nothing was lost. Fixed by routing to the per-document route and refusing clear-all at the choke point. Tests: `lightrag.test.ts` `describe("the clear-all denylist (DELETE /documents is never sent)")`.
- P1: pipeline status read a `status` string where upstream returns `busy: boolean` (every poll looked busy and ingest would have timed out); the client sent a bearer that upstream validates as a JWT first (401); the upload `track_id` was treated as a document id.
- P2: a second `/query` client bypassed the breaker; no health probe existed.
- P3: the planned image tag was `latest`; the env example now says to pin.

## What remains (operator-gated)

LightRAG deploy, ingest and cutover (phase 46 T5 to T8); RAGFlow (retired) code removal; the live `/openapi.json` diff against the fixture; any hosting decision or cost; the LLM route (a key, or the bridge `/chat` contract). The docs plane has no live backend until then (RAGFlow (retired) is deleted, LightRAG is not deployed).
