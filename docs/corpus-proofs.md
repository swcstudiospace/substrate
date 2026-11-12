# Corpus proofs — which documents the corpus held, and when

The corpus manifest ([`docs/corpus.md`](corpus.md)) records which version of each documentation file the docs plane holds. This page is how that record is made provable: a Merkle root over the manifest, written into the ledger after each change, so the hourly devnet anchor the ledger already has covers it ([`docs/greptime-ledger.md`](greptime-ledger.md), "Anchoring"). Nothing here sends a transaction, and the memo format does not change.

Everything on this page is behind `SUBSTRATE_CORPUS=on`. With the flag off (the default) the routes answer `503 corpus.disabled`, no root event is written, and `docs_search` replies are unchanged.

## What the root covers, and what it does not

The root covers the **active** rows of the manifest: one leaf per `(repo, path, sha256)`. A proof therefore shows that a document with that content hash, at that path, in that repository, was in the manifest when it had that root. A tombstoned row is not a leaf.

It does not cover:

- the document's text. The leaf holds the SHA-256 of the content; whoever has the text can check the hash, and the root says nothing about text it does not hash;
- the docs plane. The manifest says what the server recorded after the plane accepted a document; a plane that lost a document afterwards is not visible here (`docs/runbooks/corpus-ingest.md` has the reconcile steps);
- the other manifest columns (`kind`, `tier`, `source`, `commit`, `bytes`). A change to only those moves the manifest version and leaves the root as it was;
- a manifest of more than 100,000 active rows (`MAX_CORPUS_LEAVES`). Past that the server makes no root (`503 corpus.too-large`) instead of a root over a prefix that would look complete;
- an active row whose hash or names cannot be encoded (a malformed `sha256`, a lone surrogate in a path). Such a row cannot be a leaf; it is skipped, counted in `skipped` on `GET /corpus/root`, and the rest of the root is unaffected.

## The leaf

The encoding is fixed and versioned (`packages/corpus/src/leaf.ts`):

```
leaf bytes = "substrate:corpus:leaf:v1" ‖ u32be(len(repo)) ‖ repo ‖ u32be(len(path)) ‖ path ‖ sha256
```

`repo` and `path` are UTF-8, each length is the byte length as a 4-byte big-endian unsigned integer, and `sha256` is the 32 raw bytes of the document's content hash. The 24-byte domain prefix is fixed and the hash is fixed at 32 bytes, so no two triples share an encoding (`("ab", "c")` and `("a", "bc")` differ in their length prefixes). The leaf handed to the tree is the SHA-256 of those bytes, as 64 lowercase hex characters (`corpusLeafHex`): the ledger's RFC 6962 functions take 32-byte leaves and hash each once more with their own `0x00` leaf prefix.

Pinned vectors (the tests check them):

| repo | path | sha256 | leaf |
| --- | --- | --- | --- |
| `swcstudiospace/agent-substrate` | `docs/a.md` | SHA-256 of `hello` (`2cf24d…9824`) | `72149baea38a9a9b1bb3d909406da63deac9805cc90206705e51c3bc143def18` |
| `local/notes` | `README.md` | 64 zeros | `638bd9b75b5a325cae687212dbf01e29ea32663fe3fbee4451a01072f43b5fc3` |
| `a/b` | `é/ü.md` | 64 `a` | `cff1987802dd30ccc1cc867b0684e825cbcce7a6ee5209542985bbd6f56140e1` |

A new encoding is a new domain string (`…:v2`), never a silent change to this one.

## The root

Leaves are sorted by `(repo, path)` by code unit (the library's `compareEntries`, no locale), then folded with `merkleRootHex` of `@substrate/ledger`: RFC 6962, an odd last leaf promoted, not duplicated. The same manifest gives the same root whatever order its rows were written or read in, and a change to any active row's hash, path or repository changes it.

The manifest with no active row has the root `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` (RFC 6962's hash of the empty tree, SHA-256 of zero bytes). The ledger's own function refuses an empty input, so the corpus defines this value itself (`CORPUS_EMPTY_ROOT`). It is never written as a root event, and no proof exists against it.

The server computes the root from the manifest (one read of at most 100,001 rows) and caches it per manifest version. `GET /corpus/root` compares the cache with the manifest's current version before serving it.

## The root event

After an ingest request that moved the manifest, the server writes one ledger event:

| field | value |
| --- | --- |
| `kind` | `note` |
| `surface` | `substrate` |
| `session_id` | `corpus-root` |
| `payload` | `{ action: "docs.corpus.root", root, count, manifest_version }` |

It goes through the ordinary emit path, so the existing redaction and hash chain apply, and the hour it lands in is covered by that hour's anchor like any other event. The action is reserved (`RESERVED_NOTE_ACTIONS`): `events_emit` and `POST /events` refuse it from an ordinary caller, so only the server (or an operator, as its own surface) can write one. The row is in `docs/event-vocabulary.md` and `packages/mcp-server/src/event-sources.ts`.

- **Coalesced.** At most one event per five seconds, counted from the start of the previous write attempt (a slow write does not shorten the window for the next one). A change that lands inside the window is folded into the next event, and the event that goes out reads the manifest when its timer fires, so the latest state wins. The first change after a quiet period writes at once. One root is written at a time.
- **Settled states only.** While an ingest is writing, the manifest is between versions, so no root is recorded and a search does not name one; the event follows the ingest's last write.
- **Not in the request's path.** The event is scheduled on a timer and written after the ingest has answered. A failure of any kind (the manifest unreadable, the ledger unavailable) is swallowed: a root event never fails an ingest.
- **One per state.** A root is written only when it differs from the root written last, so a request that changed nothing writes nothing and a state is never written twice by one process, whatever order concurrent batches committed in.
- **What can be lost.** A root event still waiting in its timer when the server stops is dropped, and one that failed to reach the ledger is not retried. The next change writes the then-current root. `GET /corpus/root` always answers the live manifest, so the root of a document you can prove is the one to ask `GET /corpus/anchor` about.
- **Not emitted** for the empty manifest, or when the manifest is too large for a root.

## Prove and verify

Routes (all need a bearer token, are reads audited under `corpus_status`, and answer `503 corpus.disabled` while the flag is off):

| Route | Answer |
| --- | --- |
| `GET /corpus/root` | `{ protocol: 1, root, count, manifestVersion, skipped }` |
| `GET /corpus/proof?repo=R&path=P` | `{ protocol: 1, repo, documentPath, sha256, leaf, index, treeSize, path: string[], root, manifestVersion, rootScope: "repository" }`, the root of `repo`'s own tree (see below); `404 not-in-corpus` for a missing or tombstoned document; `400 bad-repo` / `bad-path` for a name that is not a repository or a normal relative path |
| `GET /corpus/anchor?root=HEX64` | `{ protocol: 1, root, status, reasons, eventId, count, manifestVersion, hourStart, evidence }`; `400 bad-root` for anything but 64 lowercase hex characters |

In the proof, `path` is the RFC 6962 audit path (sibling hashes, leaf to root), **not** the document's path, which is `documentPath`. The proof is taken from one read of the manifest, so its leaf, path and root belong together.

`rootScope` is always `"repository"`. The proof is over the active documents of `repo` alone: its root is the RFC 6962 root of that repository's leaves, and its audit path holds only hashes derived from those leaves, so no other repository's leaf or sibling hash appears in it. The hashes reveal nothing about another repository's documents. `manifestVersion` is still the whole manifest's version. The whole-corpus tree and its root are unchanged: `GET /corpus/root`, the `docs.corpus.root` events and `GET /corpus/anchor` all name that root. A served proof's root is therefore **not** the anchored root, and a caller cannot verify a served proof against the anchored root (the two match only when `repo` holds every active row).

```sh
substrate corpus prove --repo swcstudiospace/agent-substrate --path docs/corpus.md --out proof.json
substrate corpus verify proof.json            # offline: no server, no network
substrate corpus verify proof.json --online   # also asks the server where the root is anchored
```

`prove` prints the proof JSON, and writes it to `--out` when given. It checks the proof it received before handing it on, and refuses to write a proof that does not verify.

`verify` recomputes the leaf from the file's `repo`, `documentPath` and `sha256`, requires it to equal the file's `leaf`, then checks the audit path against the file's `root` with the ledger's own verifier. A changed repo, path, hash, leaf, sibling or root is reported invalid. Exit codes: `0` valid, `1` invalid, `2` usage (no file, a file that cannot be read or is not JSON). JSON that is not a corpus proof is invalid (`1`).

With `--online` it asks `GET /corpus/anchor` and prints the anchor status. With no answer (no server, a refusal, a timeout) the offline result stands, the anchor line says the check was skipped and why, and the exit code is the offline one. An anchor answer of `mismatch`, or a root event whose count differs from the proof's tree size, makes the result invalid. Server text is printed with control characters escaped.

Offline verification proves the document was in the manifest that has that root. It does not authenticate the tree size (a root alone does not: see `verifyMerkleProofHex` in `packages/ledger/src/merkle-proof.ts`); the online check compares it with the count of the recorded root event.

## Anchor status

`GET /corpus/anchor` finds the stored `docs.corpus.root` events whose payload root equals the one asked about (the ledger cannot filter on a payload field, so the events of the `corpus-root` session are read newest first and matched in the server; at most ten pages of 500) and judges the newest with the verifier a session checkpoint is judged by (`verifyEventRef`), so the statuses are the same closed set:

| status | meaning |
| --- | --- |
| `anchored` | the event's hour has an anchor row, the devnet transaction exists, its memo commits to the hour's root and count, a signer in the signer set wrote it, and the event's proof inside the hour verifies. `evidence` carries the hour, transaction signature, slot, signer, block time, the hourly root and the event's audit path in the hour. |
| `pending` | the hour has not closed, or its anchor may still land (the hour plus a 3-hour lag). |
| `unanchored` | no root event carries this root, **or** the hour closed long ago and has no anchor row. Not an error: the document was in the manifest with this root, and nothing proves when. |
| `unverified` | the chain or the ledger could not settle it: Solana unconfigured, an unreachable RPC, a devnet reset, a root-event read cut by its page limit. Never a finding of tampering. |
| `mismatch` | a chain read that succeeded disagrees with the ledger (root, count, signer, proof). |

When several events carry one root (the manifest changed without changing the root), the newest five are judged newest first and the first `anchored` one is reported; otherwise the newest one's verdict is.

A verdict counts only when it is about the row that names the root. The checkpoint verifier reads an event again by its id, and a ledger can hold more than one row under one id, so the lookup recomputes the hash of the row it matched (from its content, never the stored hash) and compares it with the event hash in the verdict's evidence. A verdict about a different row is reported as `unverified` with that reason; the verifier's own `mismatch` (the content changed after it was written) is kept as it is.

### Why a root is `unanchored` on a host that has not enabled the anchor

The hourly anchor job is operator-gated. It sends nothing unless the operator has set `SOLANA_ANCHOR_KEYPAIR` (the funded key) and `SOLANA_ANCHOR_PUBKEY`, the devnet URL guard, the genesis-hash check and a balance check pass, and the operator has enabled `substrate-anchor.timer`. Writing the root event does not enable any of that, and no transaction is sent for the corpus. On a host where the timer is not enabled, every root event stays `unanchored` once its hour is more than three hours old. The job is described in `docs/greptime-ledger.md` ("Anchoring") and its outage handling in `docs/runbooks/anchor-chain-outage.md`. Hours that were not anchored while the job was off are picked up by it within its 7-day lookback.

## How a third party verifies

A third party needs the proof file, the recorded root event, and the hourly memo; the server is not needed once they hold them.

1. Run `substrate corpus verify proof.json`. This establishes the document was in the manifest with root `R` and size `N`.
2. Find the `docs.corpus.root` event whose payload root is `R` (`GET /corpus/anchor?root=R` names its id; `events_query` returns it with its hash) and check its payload: `root` is `R` and `count` is `N`.
3. Check that event is in an anchored hour: the `evidence` of the anchor answer gives the event's hash, its index in the hour, its audit path and the hour's anchored root. Verify with `verifyMerkleProofAgainstCommitment(eventHash, { index, size: hourEventCount, path }, { rootHex: anchoredRoot, count: hourEventCount })` from `@substrate/ledger`.
4. Read the anchor transaction on devnet with `evidence.signature`: its memo is `substrate:v1:<hour start>:<root>:<count>` for hours anchored before phase 73, and `substrate:v2:<hour start>:<root>:<count>:<heads root>` after. Both carry the hour, the same root and the same count, and it must be signed by an anchor key the operator publishes.

Without access to the server, steps 2 and 3 need the root event and the hour's events from whoever operates the ledger (`docs/greptime-ledger.md` describes the event hash, the hour's leaf order and the anchors row); steps 1 and 4 need only the proof file and devnet.

Steps 2 and 3 above apply to the whole-corpus root, not to a served proof. A proof from `GET /corpus/proof` has `rootScope: "repository"`, so, unless `repo` holds every active row, it cannot be tied to a `docs.corpus.root` event or to the hourly anchor: a third party can establish that the document is in that repository's tree, and no more. `substrate corpus verify --online` asks the anchor endpoint about such a root and gets `unanchored`.

## `docs_search`

With `SUBSTRATE_CORPUS=on`, a `docs_search` reply carries `corpus_root` (the first 12 hex characters of the current root) and `corpus_count`, so a session's trail says which corpus it read. The value comes from the cache and is never computed on the search path: if no root is cached yet (after a restart, or just after a change), the fields are left out and the computation starts off the request. With the flag off the reply is byte-for-byte what it was before.

## Limits and failure behaviour

| Situation | Behaviour |
| --- | --- |
| More than 100,000 active rows | `503 corpus.too-large` on `root` and `proof`; no root event |
| Manifest unreadable | `503 corpus.index-unavailable`; the ingest that triggered a root event is unaffected |
| An active row that cannot be encoded | skipped and counted in `skipped`; the root covers the rest |
| Root event cannot be written | swallowed; the next change writes the then-current root |
| Anchor lookup cut by its page limit and nothing found | `unverified`, never `unanchored` |
| Anchor check with no ledger configured | `unverified` with the reason |
