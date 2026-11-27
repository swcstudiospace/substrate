# Risks / verification / rollback — Wave 5 (n6 SPE-38289) · 2026-11-26

| Risk | Guard | Test |
|---|---|---|
| Migration data loss (v50–52) | rehearsal on restored dump/test PG; pre-counts + checksums; down texts | migrate idempotent test (done 2026-11-26: 63 pass) |
| 1713 LightRAG failed docs | sample failed doc_ids before bulk resume; quarantine tool-side failures 0 today | grep report `file_counts` + LightRAG failed sample |
| Cache stampede / stale reads (F5) | cache-aside TTL, disable flag, bounded stale-if-error | hit-rate log + outage fallthrough check |
| Linear/Notion rate-limit dupes | stable keys, search-before-create, 3-retry backoff | sync replay = 0 duplicate rows (spec) |
| Secrets in index/logs | redactor chokepoint (`redact.ts`), parameterized SQL, env-only config | grep touched code/logs for tokens |
| Single-resource outage | owner re-read; F6 checkpoint preserved; degraded `healthz` status | kill-probe per resource (matrix) |
| Hypertable scope creep | adopt-gate = volume + retention evidence; plain-first F1 | 0-hypertable live check (done 2026-11-26) |
| Recall regression on F6/F7 | P0 baseline (`recall@5 null` → measured) before hybrid claims | `retrieval_evals` golden set post-v52 |

Failure/resume harness: per integration — outage/timeout/429 → bounded retry → resume proves no loss/dup. Rollback per feature in `selection-matrix.md`.
