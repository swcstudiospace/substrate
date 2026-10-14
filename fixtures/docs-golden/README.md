# Docs golden questions

Fixtures for `scripts/docs-golden.ts` (uplift-3 N5): one question each,
the source URLs a docs search should cite, graded, with the thresholds
the fixture must meet. The corpus under `corpus/<dataset>/<slug>.md` is a
small sanitized stand-in for the real datasets — no hostnames, no
credential values; the one `sk-proj-…` string in `credentials.md` is the
redactor's own documented placeholder, planted so a fixture can prove it
never reaches a reply.

## Fixture shape

```json
{
	"id": "substrate-door",
	"question": "Which component is the only door to the data planes?",
	"datasets": ["agent-substrate"],
	"expected": [{ "source_url": "https://example.com/agent-substrate/data-planes", "commit": "golden-v1" }],
	"grades": { "https://example.com/agent-substrate/data-planes": 2 },
	"answerable": true,
	"k": 5,
	"forbidden": ["…"],
	"thresholds": { "precision_at_k": 1, "recall": 1, "ndcg": 1, "provenance_coverage": 1, "commit_match": 1, "redaction_clean": true, "max_citations": 0 },
	"corpus_manifest": { "sha256": "<corpusManifest()>", "dataset_commit": "golden-v1" }
}
```

- `datasets`: configured dataset names only, as `docs_search` takes them.
- `expected[].source_url` is `https://example.com/<dataset>/<slug>` for a
  corpus document; `commit` (optional) is the commit the citation must
  carry.
- `grades`: 0 off-topic, 1 useful, 2 the answer; URLs absent from the map
  grade 0. `ndcg` is computed over the distinct cited URLs in reply order.
- `answerable: false` fixtures carry `expected: []` and usually
  `max_citations: 0`.
- `thresholds`: every declared threshold must be met; undeclared ones are
  printed but not judged. A `degraded: true` reply always fails.
- `corpus_manifest.sha256` is `bun run docs:golden -- --manifest` (sha256
  over `<path>\n<sha256(file)>\n` per corpus file, sorted by path — also
  reproducible with `sha256sum`). `dataset_commit` is the dataset version
  pin an operator attests a live deployment ingested this corpus under;
  `--live` refuses to score without it or when a citation's
  `dataset_commit` differs.

## Offline tier (CI)

`scripts/docs-golden.test.ts` runs every fixture through the real
`searchDocs` against a question-aware `RagflowFake` that retrieves by
lexical overlap from the corpus (`packages/mcp-server/src/docs-golden.ts`).
It proves scope isolation, provenance, ordering, the ten-citation cap,
redaction and the scorer — not the deployment's relevance. Thresholds are
written for that toy retriever; a new fixture should pass offline before
it is committed, and a fixture that cannot be answered lexically from the
corpus has no place here.

## Live tier (operator, opt-in)

`SUBSTRATE_URL=… SUBSTRATE_TOKEN=… bun run docs:golden -- --live` posts
each question to `POST /docs/search` and prints the scores; nothing is
asserted, so a relevance number is read against the previous run, not
gated on. Without the two variables it exits 2 and opens no socket.
