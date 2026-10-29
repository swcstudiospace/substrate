---
phase: 40-docs-memory
requirements: [D-D1, D-D3, D-D4]
status: in review (draft PR). D-D1 done in-repo, with no live effect until the operator sets the flags. D-D3 blocked on a restore drill and approval. D-D4 narrowed from the ROADMAP wording, which needs the user's acceptance
---

# 40-SUMMARY: DOCS-MEMORY

## Built

- **D-D1, brief recall fan-out.** Under `SUBSTRATE_BRIEF_RECALL=enforce`, the brief reads the same fan-out `memory_recall` runs: the caller's own bank plus the `sub-*` banks in `HINDSIGHT_BANKS`, one query per bank. The answer is served from `recall-snapshot` when fresh and computed live otherwise. The wait is capped at 3000 ms (`BRIEF_RECALL_CAP_MS`). The other four brief reads keep the 1200 ms budget. The cache key holds the memory and recall generations, so a memory write or retain refreshes the next brief.
- **D-D4, weekly mental-model refresh.** A 7-day unref'd timer (no run at boot) refreshes the mental models named in `HINDSIGHT_MENTAL_MODELS`, format `<bank>=<id>[,<id>...]` separated by `;`. The bank must be in `HINDSIGHT_BANKS`, the id must match `^[A-Za-z0-9_-]{1,80}$`, and there are at most 20 models. Each refresh is a `POST` to the mental-model refresh endpoint and writes one ledger note, action `memory.mental_model.refresh`.
- **D-D3, runbook.** `docs/runbooks/memory-mcp-retirement.md` records the restore routes first: the Claude Code `hindsight` MCP (`/root/.claude.json`, `.mcpServers.hindsight`, backups under `/root/.claude/backups/`) and the Hermes supermemory entry. Nothing was retired.

## Decisions (operator, 2026-10-21)

- Recall is exempt from the 1200 ms brief budget and capped at 3000 ms.
- The fan-out is keyed on the memory and recall generations, not on TTL alone or on refresh-at-retain.
- The weekly refresh covers only the models named in config. Refresh-all and deferral were rejected.
- No reflect-only job. A `reflect` call persists nothing, so a weekly reflect would leave no record. The job was built, reviewed and removed before it shipped.
- Retirement runs only after a restore drill and operator approval.

## Deviations from the ROADMAP criteria

- **Criterion 3** says "a weekly `reflect` per bank". What shipped refreshes named mental models through the refresh endpoint, not a reflect per bank. Accepting the narrower scope is the user's call. Otherwise the criterion needs amending in ROADMAP.md.

## Known wrinkles (fan-out)

- The fan-out query is built from the subjects of the last composed brief. A pair's first two briefs therefore fan out.
- Fan-out hits count under `substrate.cache.operations{class=recall-snapshot}`.
- A failed GET on the fan-out entry marks the cache degraded.
- The prefetcher still refreshes its own bank. Its snapshot now feeds only `substrate.brief.recall`.
- The brief cache key does not include the bank set. A `HINDSIGHT_BANKS` change can show the old set for up to 300 s.
- A degraded last-good snapshot carries no recall. This is the existing design.

## Deployment prerequisites (checked on the running server, 2026-10-21)

- `SUBSTRATE_BRIEF_RECALL` is unset, so the default `off` applies. `GET /healthz` has no `recall` block, which matches. Criterion 1 has no effect in production until the operator sets it to `enforce`.
- `HINDSIGHT_BANKS` is unset. Boot logs `misconfigured — HINDSIGHT_URL is set but HINDSIGHT_BANKS is empty, so recall reads the caller's own bank only`. The fan-out needs the `sub-*` names set.
- `HINDSIGHT_BANK=ultrathink` is set but legacy and unread (boot warning).
- `HINDSIGHT_MENTAL_MODELS` is unset, so the weekly refresh is inactive.

## Criterion 2: why retirement is blocked

- The restore drill is operator-run and has not happened.
- "Once the `sub-*` banks answer" is not yet true for every surface. The Hindsight bank list on the VPS (11 banks, read 2026-10-21 13:07 UTC) includes `sub-cursor` and `sub-claude-code`. It does not include `sub-grok-bot`.
- Hermes supermemory has no configured integration on this host. The catalog has an entry, and the runbook records it as a blocker.

## Found while verifying, outside this phase

- Six `grok-bot` memory writes today were accepted and then refused at the retain step with `retain.unsourced`, because they carry no source event. Refusal is local and happens before any Hindsight call (`memory-retain.ts:203`). The fix belongs in the grok-bot write path.
- The root filesystem is at 99% with 4.5 GB free. Nothing was deleted; other workloads' files are not ours to remove.
