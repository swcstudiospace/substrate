---
phase: 69-doc-proofs
milestone: v1.7
requirements: [PROOF-01, PROOF-02, PROOF-03, PROOF-04]
status: implemented and merged on main (PR #181, squash c9fccab8); the anchor job, its funded key and its hourly timer are operator-gated and untouched; no real anchored hour was exercised
---

# 69-SUMMARY: Doc proofs, a Merkle root over the corpus manifest

## What was built

- **Leaf encoding, `packages/corpus/src/leaf.ts`** (exported from `packages/corpus/src/index.ts`). `corpusLeafHex(repo, path, sha256)` hashes `"substrate:corpus:leaf:v1" ‖ u32be(len(repo)) ‖ repo ‖ u32be(len(path)) ‖ path ‖ sha256` and returns 64 lowercase hex characters. `leafRefusal` names a triple that cannot be encoded (`bad-sha256`, or `bad-text` for a lone surrogate). Also `CORPUS_EMPTY_ROOT` (SHA-256 of zero bytes), `shortRoot` (12 hex characters), `isSha256Hex` (moved here from the server's `validate.ts`) and `MAX_PROOF_PATH_LENGTH`. Tests: `packages/corpus/src/leaf.test.ts` (pinned vectors).
- **Wire types, `packages/corpus/src/protocol.ts`.** `CorpusRootResponse`, `CorpusProofResponse`, `CorpusAnchorResponse`, `CorpusAnchorEvidence` and `CORPUS_ANCHOR_STATUSES`, the same five statuses a session checkpoint is judged with.
- **Root and proof, `packages/mcp-server/src/corpus/root.ts`.** `corpusRoot(rows)` sorts the active rows by `(repo, path)` by code unit and folds the leaves with `merkleRootHex` from `@substrate/ledger`; `corpusProof` / `inclusionOf` use `merkleProofHex` on the same tree. `CorpusRootKeeper` caches one root per manifest version, brackets an ingest's writes (`writeStarted` / `writeSettled`), and records the root as a ledger event after the request has answered (`MAX_CORPUS_LEAVES` 100,000; `ROOT_EMIT_MIN_INTERVAL_MS` 5,000).
- **Manifest read, `packages/mcp-server/src/corpus/store.ts`.** `CorpusStore.activeLeaves(limit)` returns the active rows and the manifest version from one statement, and says when the read was cut.
- **Anchor lookup, `packages/mcp-server/src/corpus/anchor.ts`.** `corpusAnchorStatus` reads the `corpus-root` session's events newest first (at most `ANCHOR_LOOKUP_MAX_PAGES` pages), matches the root in the payload, and judges the newest `MAX_ANCHOR_CANDIDATES` with `verifyEventRef`, the verifier a checkpoint goes through. Nothing in it sends a transaction.
- **Doors.** `packages/mcp-server/src/corpus/service.ts` (`corpusRootReply`, `corpusProofReply`, `corpusAnchorReply`; the ingest reply brackets the keeper), `packages/mcp-server/src/service.ts` (`Substrate.corpusRoot`, `corpusProof`, `corpusAnchor`, `withCorpusRoot`), `packages/mcp-server/src/server.ts` (`GET /corpus/root`, `/corpus/proof`, `/corpus/anchor`, audited under `corpus_status`) and `packages/mcp-server/src/admission.ts` (all three in `ROUTE_CLASSES` as `read`).
- **Event.** `docs.corpus.root` is a reserved action (`packages/mcp-server/src/reserved-actions.ts`), a row in `packages/mcp-server/src/event-sources.ts` and in the table of `docs/event-vocabulary.md`. Kind `note`, surface `substrate`, session `corpus-root`, payload `{ action, root, count, manifest_version }`. No new event kind and no change under `packages/ledger`.
- **`docs_search`.** `packages/mcp-server/src/docs-search.ts` gains optional `corpus_root` and `corpus_count` on `SearchReply`; `withCorpusRoot` fills them from the cache only.
- **CLI.** `packages/cli/src/corpus/index.ts` (`substrate corpus prove --repo R --path P [--out FILE]`, `substrate corpus verify FILE [--online] [--json]`), `proof.ts` (`verifyProofOffline`, `conflictWith`), `render.ts` (`renderVerify`, `jsonVerifyReport`), `client.ts`. Offline verification imports the ledger's `verifyMerkleProofHex`.
- **Docs.** `docs/corpus-proofs.md` (what the root covers and does not, the leaf, the root event, prove and verify, anchor statuses, third-party verification, limits); `docs/data-planes.md`; the `SUBSTRATE_CORPUS` registry row and `.env.example`.

## Key decisions

- **D69-1 held.** The corpus follows the checkpoint precedent: it writes a ledger event and the hour's existing anchor covers it. The memo format and the anchor job are not touched.
- **D69-2 held, in another file.** The leaf encoding is fixed and pinned by vectors, but lives in `leaf.ts`, not `protocol.ts` (which holds the wire types). The 24-byte domain string carries the version, so a new encoding must be a new domain.
- **D69-3 held and tightened.** Verification reuses the ledger's proof functions and the checkpoint classification (through `verifyEventRef`, not a copy of it). With no event or no anchor row the answer is `unanchored`, a 200, not an error. A read that was cut, or a ledger that is missing or failed, is `unverified`, never `unanchored`.
- **D69-4 held.** Nothing sends a transaction. The anchor lookup is tested only against fake chain-evidence readers.
- **Changed in review: the root event is coalesced and settled.** One write at a time, at most one per five seconds, only when no ingest is writing, only when the root differs from the one last stored, never for the empty manifest.
- **Changed in review: a verdict must be about the row that names the root.** The lookup recomputes the matched row's content hash and requires it to equal the verdict's event hash.

## Deviations from the plan

- **File names.** The ROADMAP repo list names `packages/corpus/src/merkle.ts`. There is no such file: the leaf is in `packages/corpus/src/leaf.ts` and the tree in `packages/mcp-server/src/corpus/root.ts`.
- **Criterion 2, "each sync emits one".** The event is per ingest request that moved the manifest, not per sync: changes inside five seconds share one event, a root equal to the last stored one is not written again, the empty manifest and a manifest over 100,000 active rows are never written, a write still waiting when the server stops is dropped, and a write that failed is not retried until the next change. The payload field is `manifest_version`.
- **Criterion 3, chain evidence.** `verify` reports the anchored hour and transaction only with `--online`; offline it checks the proof alone. Offline verification does not authenticate the tree size (the root alone does not); `--online` compares it with the count of the recorded root event.
- **Criterion 4, "replies carry `corpus_root`".** Only with `SUBSTRATE_CORPUS=on`, and only when a root is cached: the first search after a restart or a manifest change leaves the field out and starts the computation off the request. The reply also carries `corpus_count`.
- **Added beyond the ROADMAP.** Three routes, the reserved action, the `corpus.too-large` refusal, `skipped` (active rows that cannot be encoded) and a `--json` form of `verify`.

## Findings

Greptile findings fixed before merge, from the squash message of #181 (it numbers rounds 1 to 5 and a post-rebase fix; the PR took seven rounds in all):

- **Post-rebase.** The proof routes were missing from the admission table; `verify` output now goes through the shared `printable` helper with clipping; an event the verifier refuses to judge keeps a status of its own.
- **Stale root reads.** The cached root is unavailable from an ingest's first write to its end, so a search never names a root the saved batches have outdated.
- **Concurrent writes.** Root writes are single-flight, a request that arrives during a slow write waits out the window from that write's start, and a root is compared (not its version) because concurrent batches can commit out of order.
- **Lost events.** An event an ingest owes survives a later ingest that changes nothing; nothing is recorded while an ingest is writing.
- **Refused writes.** The keeper advances its last written root only when the ledger answered `stored`.
- **Anchor lookup.** A second ledger row under one event id could borrow another's hour proof; a matching row nested too deeply to hash threw outside its guard and failed the lookup with a 500 before older valid events were judged. It is now counted as unreadable.
- **CLI.** `prove` refuses a valid proof that covers another document than the one asked for.
- **Test fix.** The root emitter in the proofs test returned nothing and no longer typechecked against the keeper's contract.

## What remains

- **Operator-gated.** The anchor job (`SOLANA_ANCHOR_KEYPAIR`, `SOLANA_ANCHOR_PUBKEY`, the devnet URL guard, the genesis check, a balance check) and `substrate-anchor.timer`. Until the operator enables them, every root stays `unanchored` once its hour is more than three hours old. No real anchored hour, devnet transaction or live ledger read was exercised.
- **Gaps.** A root event lost to a failure or a shutdown is not retried; the last stored root is held in memory, so a restart may store the current root once more. A manifest over 100,000 active rows has no root.
