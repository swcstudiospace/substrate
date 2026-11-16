# S7 summary: promotion advisor, flag registry, config reference (U5-7)

Slice branch `u5/s7`. The first pass was edit-only; the orchestrator's verification and the review round then ran `tsc`, the three new test files, `store-lock`, `authority`, `identity-check` and `config:reference --check` (all green after the review-round fixes below).

## What changed

| File | Change |
| --- | --- |
| `packages/mcp-server/src/flag-registry.ts` | NEW. The typed registry: 226 rows (`FLAGS`), three name families (`FLAG_FAMILIES`: `SUBSTRATE_TOKEN_<SURFACE>` 27 members, `SUBSTRATE_BUDGET_<CLASS>_RPS/_BURST` 168, `SUBSTRATE_REHEARSAL_<NAME>` 1), 14 platform exemptions each with a reason (`REGISTRY_EXEMPT`), `findUnregistered`, `registeredNames`, `flagByName`, `policyFlags`. Inside `packages/mcp-server/src` because it names `GREPTIME_*`/`HINDSIGHT_*` (store lock; `legacy-env.ts` precedent). Side-effect-free. Never drives `loadConfig`: `config.ts` is untouched. |
| `packages/mcp-server/src/flag-registry-scan.ts` | NEW. The scanner: `scanSource(file, text)`, `scanFiles(files, root?)` (takes a file list, so the test feeds it a planted fixture), `envReadSources(root)`. Finds `process.env.X`, `env.X`, `io.env.X`, `env["X"]`, whole-literal names under 17 known prefixes (this is how `INDEX_ROOTFS_ENV`, `TOKENS_BURN_ENV`, `SANDBOX_EGRESS_ENV`, name tables and `env("X")` calls are seen) and composed prefixes (`` `SUBSTRATE_TOKEN_${…}` ``). Comments are blanked first. |
| `packages/mcp-server/src/flag-registry.test.ts` | NEW. The lock and its proofs (below). |
| `scripts/promote-advisor.ts` + `.test.ts` | NEW. The read-only advisor. `package.json`: `advisor:promote`. |
| `scripts/config-reference.ts` + `.test.ts` | NEW. Generator and `--check`. `package.json`: `config:reference`. |
| `docs/config-reference.md` | NEW, generated: a table per plane, the promotion policies, the name families, the exempt names. |
| `docs/runbooks/flag-promotion.md` | NEW. Procedure, verdicts, caveats, offline fixture format; its evidence table is generated between two markers and checked. |
| `.env.example` | One block of 61 COMMENTED `# NAME=default` lines appended (names the code reads that had no line), one comment on `RAGFLOW (retired)_DATASET_ID=`. No live line added or changed. |
| `.planning/uplift-5/env-notes/S7.md` | What the orchestrator adds at integration (other slices' flags). |

## Flags and defaults

None added. The advisor, the scanner and the generator read and render; nothing changes behaviour. `loadConfig` is not modified (the registry's defaults are pinned to it by a test).

## The advisor (`bun run advisor:promote`)

`bun scripts/promote-advisor.ts [--json] [--flag NAME] [--offline fixture.json]`. Per policy flag with history evidence it prints `ready | hold | insufficient-data | series-unavailable`, one line per criterion with the observed number, threshold, comparator, sample count, floor and window, then `when ready:` (the operator's one-line step) and `rollback:`. Exit 0 whatever the verdicts; 2 for a usage error (unknown argument, `--flag` that is not a policy flag, unreadable or invalid `--offline` fixture, non-http `SUBSTRATE_URL`).

- Read-only: `liveGetter` only ever issues `GET` with `redirect: "manual"`; the getter takes a path and query, so there is no way to name a method. Sequential requests; each distinct (series, window) once; `/slo` once for the `history` epoch and `since` (context only).
- Bearer: `doctorBearer(env)` (the doctor's resolver: `SUBSTRATE_TOKEN`, first entry of `SUBSTRATE_TOKEN_SUBSTRATE`, `SUBSTRATE_TOKEN_FILE`, `SUBSTRATE_TOKENS_DIR`), sent only as the `Authorization` header, never printed or put in JSON. `SUBSTRATE_URL` defaults to `http://127.0.0.1:7410`.
- A response is read under a 4 MB cap while reading, inside the same `AbortSignal` deadline (5 s). Anything but a complete well-formed 200 (missing `points`/`from`/`to`, a non-numeric value, a bad timestamp, a negative count) is `series-unavailable` with a closed reason; the error text of a failed fetch is never echoed.
- Window honesty: a truncated answer, `windowCapped` (retention shorter than the window) or a history that spans under 90 % of the window is `insufficient-data`; so is a sample count under the floor. Coverage is judged on the criterion's `coverageSeries` (default: its denominator or numerator series; the memory-expiry criterion uses `emit.success` because a counter has no row for an interval with nothing to count).
- Flag verdict: `hold` > `series-unavailable` > `insufficient-data` > `ready`.
- `--offline` fixture: `{ "series": { "<series>[@<window>]": { "status": 200, "body": <a /slo/history body> } }, "slo"?: { "status", "body" } }`; `series@window` beats `series`; an unnamed series answers like one the substrate does not record (400). `404 {"enabled":false}` is history-off.
- Extended-only series (cache `would_serve_stale`, brief profile bytes saved, brief recall, recall prefetch, memory expiry) are referenced by name only. On a substrate that does not record them the history answers 400 and the advisor says `series-unavailable` with the hint `set SUBSTRATE_METRICS_HISTORY_SERIES=extended`. The series names match U5-6's `EXTENDED_METRIC_SERIES` (checked in its worktree: `cache.operations{result}`, `brief.profile_bytes_saved`, `brief.recall{result}`, `recall.prefetch{result}`, `memory.expired{mode}`).

### Proposed thresholds (all PROPOSALS; each row says so)

| Flag | Criterion | Min samples | Window | Series |
| --- | --- | --- | --- | --- |
| `SUBSTRATE_BUDGETS` | (shadow_limited + limited) / (allowed + shadow_limited + limited) <= 1 % | 100 | 24h | `admission.decisions` (core) |
| `SUBSTRATE_CACHE_SWR` | would_serve_stale / miss >= 10 % (lower bound); worst `brief.p95{grok-bot}` <= 800 ms | 100 / 100 | 24h | `cache.operations` (extended) / `brief.p95` (core) |
| `SUBSTRATE_BRIEF_PROFILE` | bytes saved per brief >= 700 | 30 | 3d | `brief.profile_bytes_saved` (extended) over `brief.p95` counts |
| `SUBSTRATE_BRIEF_RECALL` | (would_include + included) share >= 50 %; (cold + stale) share < 30 %; prefetch error share < 5 % | 100 each | 3d | `brief.recall`, `recall.prefetch` (extended) |
| `SUBSTRATE_MEMORY_EXPIRY` | served expired entries == 0 | 0 (coverage required) | 7d | `memory.expired{served}` (extended), coverage `emit.success` |

Flags with no history evidence (`SUBSTRATE_LEDGER_TTL`, `SUBSTRATE_INDEX_SWEEP`, `SUBSTRATE_INDEX_TUNE`, `SUBSTRATE_HINDSIGHT_INVENTORY`, `SUBSTRATE_DOCS_PRUNE_SUPERSEDED`, `SUBSTRATE_SLO_NOTIFY`, `SUBSTRATE_WATCHDOG`, `SUBSTRATE_METRICS_HISTORY`) are listed under "not judged from the history" with their manual check.

## Tests added, and what each proves

`packages/mcp-server/src/flag-registry.test.ts`
- Lock: no name read by `packages/**` or `scripts/**` (tests excluded) is missing from the registry. A planted fixture proves the scanner catches six read forms (dot, index, nested `io.env`, constant, `env("…")` call, composed prefix), and again through `scanFiles` on a file in a temp dir with its line number; comments and prose are not reads (and the real reads in the same fixture are still seen, so an empty result is not blindness).
- The scanner sees this repo's own declaration styles: `SUBSTRATE_INDEX_ARCHIVE_ALLOW_ROOTFS` and `SUBSTRATE_BURN_TOKENS_PER_HOUR` (constants) and the `SUBSTRATE_TOKEN_` and `SUBSTRATE_BUDGET_` prefixes.
- No rot: names unique; every row (except `unread`) is read; `RAGFLOW (retired)_DATASET_ID` stays `unread` until something reads it; every family prefix is live; every exemption is used and has a reason; every `doc` exists.
- `.env.example`: `documented` rows have a `NAME=` line and non-documented rows have none; every documented family member is listed; every name the file lists is registered.
- Defaults: each mode flag's registry default equals `loadConfig({})` (and `sweepModeFromEnv({})`); each policy's `safe` is the default; the numeric boot defaults match.
- Policies: every criterion is a proposal with a valid window; core series and labels exist in `METRIC_SERIES`; extended series are not in it and their labels are in the instrument's closed vocabulary; `safe`/`enforcing` are values the flag accepts and differ; a flag without evidence has a manual check.

`scripts/promote-advisor.test.ts` (hand-computed fixtures, arithmetic in comments)
- Budgets: 6 of 996 = 0.6024 % ready; 40 of 1000 with a 5000-count `bypass` is a hold (a bypass-diluted share of 0.67 % would read ready); exactly 10 of 1000 ready and 11 of 1000 hold; 80 decisions insufficient; exactly 100 judged; 2 h of a 24 h window insufficient; a 22.5 h hole and the 25 % gap boundary insufficient; history off unavailable with the hint.
- SWR: 100/900 = 11.1 % and worst p95 700 ms ready; share over `miss` alone (100 of 1000 ready, 99 of 1000 hold); the lower-bound note; precedence hold > unavailable > insufficient > ready, each in both directions; the extended hint.
- Boundaries: 42000 bytes / 60 briefs = 700 ready, 699 hold; 29 briefs insufficient; memory expiry 0 served ready, 3 served hold, `hidden` not counted, an empty answer insufficient without coverage; recall 60 % ready and 49 % hold; cold+stale exactly 30 % holds (strict `<`).
- Never ready on: truncated, retention-capped, malformed points/`from`/`to`/`enabled`, every non-200 status (401 names the bearer, 503, 429, 302, no answer).
- Read-only: a fake fetch asserts every call is `GET`, `redirect: manual`, no body, URL path `/slo…`, the bearer is the FIRST entry of a list, absent when none resolves, no secret in stdout or stderr, no duplicate request; a throwing fetch gives `series-unavailable` for every flag with exit 0 and the message not echoed; a 4 MB+ body is no answer; an unparseable body is malformed.
- CLI: `--offline` makes no request; `--flag` narrows (a manual flag prints its check); usage errors exit 2 (eight cases), `--help` exits 0; `series@window` precedence; `/slo` context reported or ignored; the text report carries the verdict, `0.60 % <= 1.00 %`, `[PROPOSED]`, the step and the rollback.

`scripts/config-reference.test.ts`
- `--check` passes on the committed documents and writes nothing; it fails (1, naming both files) on a stale reference plus a hand-edited evidence table, on a lost marker, on a missing reference; write mode repairs a drifted tree, leaves no `.tmp-` file; an unknown argument is 2 and writes nothing; the splice replaces only what is between the markers.
- Every registered name, family pattern and exempt name is in the rendered text; every table row has the header's column count (a `|` in a value is escaped); unread/legacy rows say so; every policy flag has a row in the policy table.

## Smoke commands for the orchestrator

```sh
bun test packages/mcp-server/src/flag-registry.test.ts scripts/promote-advisor.test.ts scripts/config-reference.test.ts
bun run config:reference -- --check        # config reference: up to date   (exit 0)
printf '{"series":{}}' > /tmp/u5-s7-empty.json
bun run advisor:promote -- --offline /tmp/u5-s7-empty.json   # every judged flag SERIES-UNAVAILABLE, a "not judged" list, exit 0
bun run advisor:promote -- --flag NOT_A_FLAG                  # exit 2 naming it
bun test packages/mcp-server/src/store-lock.test.ts packages/mcp-server/src/authority.test.ts scripts/identity-check.test.ts   # the .env.example neighbours
```

Evaluated here (not via `bun test`): 245 distinct names (including the exempt platform names and four composed prefixes) read across 164 scanned files, 0 unregistered, 0 stale rows, 0 dead families or exemptions, `.env.example` and the registry agree in both directions, every mode default equals `loadConfig({})`. Against a live substrate on the VPS (read-only, loopback): `bun run advisor:promote` is expected to say `series-unavailable` ("metrics history is off") until `SUBSTRATE_METRICS_HISTORY=on`, because production does not yet record the history; that is the correct answer, not a failure.

## Integration notes (orchestrator)

- Other slices' new variables will fail the lock by name until registered. One literal each, in the plane's block of `FLAGS`, for example U5-6's:
  `{ name: "SUBSTRATE_METRICS_HISTORY_SERIES", kind: "mode", plane: "observability", default: "core", allowed: "core | extended", unset: "core: the 11 recorded series; anything else is core with a boot warning", readBy: "mcp-server/config.ts", documented: true, doc: "docs/observability.md" }`.
  Then `bun run config:reference` and commit the regenerated `docs/config-reference.md` (the test fails on a stale one).
- U5-6's `.env.example` block goes after `SUBSTRATE_METRICS_HISTORY_TTL=`, where mine also starts: keep theirs first, mine after (mine begins with a blank line).
- Once U5-6 lands, `SUBSTRATE_METRICS_HISTORY` rows and the runbook prerequisites already name the flag by name only; nothing here imports its code.
- `docs/observability.md` is not touched (U5-6 owns it). A one-line pointer to `docs/runbooks/flag-promotion.md` and `docs/config-reference.md` there is optional.

## Operator steps

None are performed by code. The advisor prints the flip for each flag as text: set the variable in the unit env or drop-in and restart. `SUBSTRATE_METRICS_HISTORY=on` (after deciding the Greptime volume: 500 MB in one record, 5 GB in the plan) is the prerequisite for every criterion; `SUBSTRATE_METRICS_HISTORY_SERIES=extended` for the extended criteria (eight criteria across five flags, six of them extended).

## Deviations from the brief, and where the code contradicted the lane

- Evidence shape: the brief says `{series, comparator, threshold, minSamples, window, rationale}`. The registry's `Evidence` also carries `stat` (`share | ratio | max | sum`), `numerator`/`denominator` terms with label sets, `unit`, `needs` (`core | extended`) and an optional `coverageSeries`, because the criteria are ratios and worst-values over labelled series, not single comparisons. Adding a flag is still one object literal.
- `kind` has an extra `string` value (free-form values such as a URL or a duration) beside the brief's six.
- Brief profile: the recon's "bytes saved >= 20 % of full bytes over >= 30 briefs" cannot be computed, because no series records the full size (U5-6 confirmed the same). The proposal is 700 bytes saved per brief (20 % of the 3500-byte compact cap), over brief counts from `brief.p95`; documented as diluted and conservative.
- Budgets: the history is aggregated over surfaces and classes, so "per surface and class, and zero for coordination" is not decidable from it. The criterion is the aggregate; the runbook says the per-surface check needs `GET /metrics` (`substrate.admission.decisions`).
- Memory expiry: the history series is not split by memory kind, so "zero served for decision kinds" is "zero served at all" over a covered week, plus the manual sweep dry-run check.
- `RAGFLOW (retired)_MCP_URL` (lane L2: "read but undocumented"): the code names it only in two comments (`config.ts`, `planes/ragflow (retired).ts`: "never read"), so it is not an environment read and is not registered or listed. `RAGFLOW (retired)_DATASET_ID` is the opposite: listed in `.env.example` but read by nothing, so it is registered as `unread` (and the lock fails if something starts reading it without the row being updated).
- The registry file is excluded from the scan (it would otherwise vouch for itself); `scanFiles` and `envReadSources` take their own file lists.
- Lane count: the lane estimated ~223 names read and ~179 documented. The scan finds 245 distinct read names (counting the composed families by prefix) and the registry has 226 rows plus 196 family members.

## Known limits

- The scan is text-based, not a parser. A name built by concatenation with no literal prefix is invisible (the three families are why `FLAG_FAMILIES` exists). It reads TypeScript under `packages/**` and `scripts/**` only: shell (`infra/vps/*.sh`) and the Python dispatcher are not scanned, so a variable read only there needs a registry row added by hand. Line-based comment stripping would misread a `//` inside a template literal spanning lines; a false positive is fixed with an exemption row carrying a reason, a false negative by a pattern.
- The advisor does not know the flag's current value, so it cannot tell "still in shadow" from "already flipped": after a flip the counters change meaning and a repeated run reports on the enforcing mode.
- `brief.p95` in the history keeps the worst interval per bucket, so one slow interval holds `SUBSTRATE_CACHE_SWR` (stricter than `/slo`). `cache.operations` sums every cache class, so the SWR share is a LOWER BOUND of the brief share (a ready stands, a hold may understate it).
- Extended-series verdicts cannot exist before U5-6 is merged and `SUBSTRATE_METRICS_HISTORY_SERIES=extended` is set: until then they read `series-unavailable` with the hint. The core criteria (budgets, brief p95) work with only `SUBSTRATE_METRICS_HISTORY=on`.
- The thresholds are proposals from the recon. None was measured on production traffic (production ran uplift 2 when the recon was written and cache evidence was 21 hits, 110 misses).

## Scope (exact)

The registry, the lock and the generated reference cover **every variable read by TypeScript under `packages/` and `scripts/` (tests excluded); the Python dispatcher and the infra shell are not covered**. Variables read only there (for example `SUBSTRATE_DISPATCH_MAX_TURNS`, `SUBSTRATE_DISPATCH_MODEL`, `SUBSTRATE_STORMBREAK_DISABLED`, `SUBSTRATE_HOST_URL`, `SUBSTRATE_HERMES_BIN`, `SUBSTRATE_LINEAR_URL`, `SUBSTRATE_SURFACE`, `SUBSTRATE_MAIN_REF`, `SUBSTRATE_HEALTH_TIMEOUT`/`_INTERVAL`, `SUBSTRATE_DESKTOP_GEOMETRY_WAIT_S`) have no row. The same sentence is in the registry docblock, the scanner docblock, the generated `docs/config-reference.md` header (tested) and `docs/runbooks/flag-promotion.md`.

## Review round (independent review, P2 x3 and P3 x3)

1. **Lock blind spots (P2).** `RIVET_RUN_ENGINE` and `RIVET_RUN_ENGINE_HOST` (`packages/host/src/main.ts:69-70`, the first is the G2 safety gate) are registered (plane `host`, documented, commented lines in `.env.example`). Cause: the prefix list lacked `RIVET_` and the `env("NAME")` helper was only seen under a known prefix. The scanner now reads a helper call `…env("ANY_UPPER_NAME")` whatever its prefix, and destructuring (`const { A, B: x } = process.env`, `Bun.env`, `import.meta.env`, any `…env` object, multi-line). The prefix list was re-derived from every access, helper and literal read in the tree (the only missing prefix was `RIVET`); the repo has no destructured env read today. Both forms are planted in the lock test, plus a test that the real `RIVET_*` reads are seen, registered and documented. Remaining blind spots are listed in the scanner docblock (concatenated names with no literal prefix, variable-key lookups, an env object not named `…env`/`…Env`, Python and shell).
2. **SWR double count (P2).** `cache.ts` counts the miss and then `would_serve_stale` for the same request, so it is a subset of miss. The criterion's denominator is now `miss` only (`would_serve_stale / miss >= 10 %`, id "(lower bound)"). `Evidence` gained an optional `note`; the SWR share carries "lower bound: cache.operations sums every cache class, would_serve_stale is brief-only", printed on the advisor line and in JSON. Rationale, generated runbook table, caveat, fixtures and comments are corrected; tests pin 100 of 1000 misses = 10 % ready (the old denominator would give 9.09 % and hold), 99 of 1000 holds, and the note.
3. **Scope claim (P2).** Stated exactly (section above).
4. **Mid-window gaps (P3).** `coveredMs` ignored holes. A criterion is now `insufficient-data` when the coverage series has a stretch longer than 25 % of the window (`MAX_GAP_FRACTION`) between two points or after the last one; the line names the gap. Documented in the advisor docblock and runbook; tests: a 22.5 h hole in a 24 h window, and the boundary (last row 5.5 h ago passes, 8.5 h ago does not). The fixture helper now writes steady zero-value rows so the other fixtures model a sampler that was up. A long quiet period with no traffic reads the same way (counters have no row for an empty interval): the safe answer.
5. **Toggle value sets (P3).** Verified against each parser: `SUBSTRATE_ALLOW_ANONYMOUS` and `SUBSTRATE_CLAIM_REQUIRE_LEDGER` accept `1|true|yes|0|false|no` case-insensitively (anything else is unset); `SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER`, both `…ARCHIVE_ALLOW_ROOTFS` and `CHAOS_REHEARSAL` accept `1|true|yes` case-insensitively (anything else off). Rows and the generated reference are updated. Exact-`1` toggles and the `0|false|no` kill switches were already right.
6. **Runbook (P3).** Exit 2 for a non-http(s) `SUBSTRATE_URL` (live mode, before any request) added.
