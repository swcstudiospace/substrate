---
phase: 56-lightrag-contract
verified: 2026-10-26
status: passed
score: 7 of 7 success criteria MET in the repository against the upstream v1.5.7 source; the live contract check is operator-gated
verified_on: gsd/v16-int at 8752578 (phase commit a573641)
---

# 56-VERIFICATION: LightRAG client contract alignment and storage topology

## Gates

Not run by the author of this record. Orchestrator figures for `gsd/v16-int` at 8752578: 7505 pass, 2 skip, 0 fail; audit gate 0 unlisted high or critical; `check:phase-close` pass; config-reference check pass. Evidence below was read from files and test names.

## Success criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | The client never sends `DELETE /documents`; documents go only through `DELETE /documents/delete_document` with real ids; a denylist test proves the clear-all route is unreachable | MET | `planes/lightrag.test.ts`: `describe("the clear-all denylist ...")` with `"every spelling of DELETE /documents is recognised, the per-document route is not"`, `"the single choke point refuses with a fixed reason before any network I/O"`, `"no client function, whatever its arguments, emits DELETE /documents"`; `describe("delete (DELETE /documents/delete_document)")`. |
| 2 | Pipeline completion is read from `busy`; `recovery_required` and an unknown shape give explicit reasons, never a silent timeout | MET | `lightrag.test.ts` `describe("pipeline status ...v1.5.7 shape")`: `"idle is busy === false..."`, `"recovery_required stops at once with the redacted, capped recovery message"`, `"a pipeline that stays busy is parse-timeout, never a silent loop"`, `"it never hangs: maxPolls ends the reads, and the injected clock ends them at the deadline"`. |
| 3 | The API key is sent as `X-API-Key` only and never appears in a reason or a log | MET | `lightrag.test.ts`: `"sends only X-API-Key (never an Authorization bearer) on every route when a key is set"`, `"sends neither auth header when no key is set, never 'Bearer undefined'"`, `"the key never appears in a transport reason"`, `"a 401 or 403 is named by status, never by the key"`. |
| 4 | A `track_id` resolves to document ids through `track_status`; a 409 same-name conflict is a typed outcome | MET | `lightrag.test.ts` `describe("document ids (GET /documents/track_status/{track_id})")` and `"the upload keeps the track id explicit: it is not a document id, and a 409 is a typed conflict"`; `LIGHTRAG_SAME_NAME_CONFLICT` in `lightrag.ts`. |
| 5 | One `/query` client remains, behind the breaker and the gated fetch; a health probe fills `planes.lightrag.ok` | MET | The private client in `mcp.ts` was removed (commit a573641 diff; `mcp.test.ts` updated); `describe("queryForTool (the docs_lightrag_query door)")`; `describe("health probe (GET /health)")`; `probeLightrag` wired at `service.ts` into the health reading `lightrag`. |
| 6 | A route fixture derived from upstream v1.5.7 with provenance, plus a contract test that fails on drift; the operator step that diffs against the live `/openapi.json` is documented | MET | `planes/__fixtures__/lightrag-v1.5.7-routes.json` (`provenance` field: "DERIVED FROM THE UPSTREAM SOURCE, NOT RECORDED FROM A LIVE SERVER"); `planes/lightrag.contract.test.ts` `describe("the v1.5.7 route contract")` and `describe("fail-before: the checker rejects a mutated fixture or a non-conforming client")`; the diff step is item 1 of the HARD_STOP list in `docs/runbooks/lightrag-storage-topology.md`. |
| 7 | The storage topology and the upgrade and re-index design are written down; no live action taken | MET | `docs/runbooks/lightrag-storage-topology.md` sections "Decision", "Isolation and identity settings", "Operator preflight checklist", "Upgrade and re-index design"; Dragonfly rejected there. No Railway call that writes was made. |

## Residual risks

- Everything is checked against the upstream source at one tag. The fixture was hand-written; if it misread the source, the contract test would pass against a wrong table. Mitigation is the operator `/openapi.json` diff, which has not been run (no server).
- No LightRAG service exists, so no request this client builds has ever reached a real server.
- UNVERIFIED in the runbook: whether `HNSW` fails on 3072-dimension embeddings, whether the Timescale image has pgvector, which services use the existing Postgres service, and whether a workspace header exists.
- The docs plane has no live backend until the cutover: the RAGFlow service is deleted and `SUBSTRATE_DOCS_BACKEND` defaults to RAGFlow while `LIGHTRAG_URL` is unset ([INFERENCE] from `docs-plane.md`).
- The RAGFlow client code is still in the repository (`planes/ragflow.ts`); removal belongs to phase 46.

## Operator-gated

LightRAG deploy, ingest and cutover (phase 46 T5 to T8); any hosting decision or cost and any new Railway service; the live `/openapi.json` diff; the LLM route.
