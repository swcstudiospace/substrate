# Quality/security/resilience baseline (Wave 4, SPE-39534) + Missing decisions (Wave 3, SPE-39533) — 2026-11-28

## Settled decisions (evidence-anchored)
1. **Linear authoritative, Notion derived mirror** — prior mapping (`.planning/issue-programming/notion-linear-mapping.md` §Status Authority: Linear is authoritative; Notion is derived) wins over planner's recommended opposite. Notion never creates status truth.
2. **Single operator per session via CLI** — one operator MANDATORY per live session; queue protocol for multi-agent continuation.
3. **Non-sensitive only in hot cache** — secrets/personal data never into DragonflyDB; redactor enforced.
4. **Runtime truth by probes, not by intent** — health checks via docker/L7, not by desired state.
5. **Cache-only Dragonfly** — never authoritative; loss costs latency, not data.
6. **Append-mode Greptime** — TTL expiry only; no DELETE purge.

## Baseline gates (enforceable)
- **Verify**: `bun run verify` (tsc + bun test + Python suites) green before planning closes.
- **Live probe**: docker health + `/healthz` + `/health` endpoints; fabric_status via MCP.
- **Compliance**: substrate_fabric_compliance must PASS (private endpoints, no secrets in reports).
- **Coverage**: `check:phase-close` (lock manifest) + `check:scope-coverage`.
- **Security**: no secrets in repo/PR/transcript; redaction keys via env names only; SAST on new code.
- **Resilience**: degraded-mode must not corrupt peers; each fabric tool fail-open per audit; circuit breakers on all cross-resource calls.
- **Quality**: prod-grade requires adversarial review (PASS/FLAG) on migrated state; no fabricated outputs.

## Architecture guardrails
- TimescaleDB only for time-series hypertables (retention + continuous aggregates). No hypertable conversion of event-ledger/metadata tables.
- Greptime single-writer for action streams; TTL only.
- LightRAG naive until F7 judge passes.
- Leader fencing for single-writer session mutation.
- All interop calls carry correlation IDs; fallback to durable read on cache miss.
