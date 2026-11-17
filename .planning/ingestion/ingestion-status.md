# LightRAG ingestion status: 15 projects (2026-11-17)

Source: live LightRAG `POST /documents/paginated`, all 9,319 documents, read on 2026-11-17.
Matching: case-insensitive substring of `file_path` against each project name.

Limits of the match:
- Corpus-atlas keys (`corpus:swcstudiospace%2F<repo>:...`) match by repo name.
- Documents whose paths do not contain the repo name are not matched. The 83 agent-substrate documents ingested earlier are among them, so the agent-substrate row is an undercount.
- A document whose path contains two project names is counted under both.

Status rules:
- unknown: no documents matched.
- ingested: every matched document is processed.
- partially ingested: some matched documents are processed and some failed.
- failed: matched documents exist, none is processed.

Graph status is not measured per project. No per-project graph query has been run, so every row reads unverified.

| project | docs | processed | failed | ingest status | graph |
|---|---|---|---|---|---|
| agent-realm | 0 | 0 | 0 | unknown | unverified |
| agent-substrate | 8 | 4 | 4 | partially ingested (undercount) | unverified |
| agent-swarm | 40 | 9 | 31 | partially ingested | unverified |
| auctioning | 77 | 48 | 29 | partially ingested | unverified |
| autonogrammer | 8 | 6 | 2 | partially ingested | unverified |
| claude-ultrathink | 2 | 2 | 0 | ingested | unverified |
| clippyos | 13 | 13 | 0 | ingested | unverified |
| desklanes | 1 | 1 | 0 | ingested | unverified |
| hypergrok | 63 | 59 | 4 | partially ingested | unverified |
| motion-playbook | 13 | 13 | 0 | ingested | unverified |
| trading-desk | 1 | 1 | 0 | ingested | unverified |
| spectrumwebco-marketing | 0 | 0 | 0 | unknown | unverified |
| token-optimisation | 10 | 10 | 0 | ingested | unverified |
| programming-desk | 285 | 85 | 200 | partially ingested | unverified |
| purpleteam | 37 | 6 | 31 | partially ingested | unverified |

Totals for the 15 projects: 558 documents matched, 257 processed, 301 failed.
Documents in LightRAG outside these 15 names: 8,761 (corpus atlas, `.claude`, `docs`, `sw-main` and others). These are not classified here.

Failure causes, from the status messages across all 1,330 failed documents:
- Embedding worker timeouts after 60 s in PGVectorStorage entities or chunks. Most failures.
- Duplicate file names ("File name already exists ... Status: failed").

Likely cause [INFERENCE]: LightRAG's LLM binding pointed at 127.0.0.1:3010, which had no listener, so entity extraction could not connect and retried into timeouts. Graph status cannot be trusted for documents processed before the loopback adapter was added on 2026-11-17.

Next step, not done: re-ingest of failed documents writes to production LightRAG and needs operator approval.
