# Flag promotion: when is it safe to flip a shadow policy?

About twenty policies ship in `shadow`, `report`, `off` or unset, so that a deploy changes nothing until an operator decides. This runbook is how that decision is made from evidence: `bun run advisor:promote` reads the durable metrics history of a running substrate and says, per flag, `ready`, `hold`, `insufficient-data` or `series-unavailable`.

**The thresholds are proposals.** Every number below was inferred from the uplift-5 recon (the shape of each metric and what a flip would change), not measured as an SLO on production traffic. They are a starting point for the operator to accept or change in `packages/mcp-server/src/flag-registry.ts`; the advisor prints each one as `[PROPOSED]`, and a `ready` means "met the proposal", not "proven safe".

What the advisor does not do: it never flips a flag, never writes anything (every request is a `GET`), and does not read a flag's current value (that lives in the unit env, which it never opens). The flip is the operator's step, printed beside the verdict.

Scope of the registry it reads: every variable read by TypeScript under `packages/` and `scripts/`. The Python dispatcher and the infra shell are not covered (`docs/config-reference.md` says the same); a variable read only there has no registry row.

## Prerequisites

- `SUBSTRATE_METRICS_HISTORY=on` in the substrate-mcp unit env, with the ledger configured. Without it `GET /slo/history` answers `404 {"enabled":false}` and every criterion reads `series-unavailable`. Deciding the Greptime volume comes first: 500 MB is recorded in one place and 5 GB in the plan, and nothing here resolves that (`docs/observability.md`, "Durable metrics history").
- Some criteria need series that are recorded only under `SUBSTRATE_METRICS_HISTORY_SERIES=extended` (cache `would_serve_stale`, brief profile bytes saved, brief recall, recall prefetch, memory expiry). On a substrate that does not record them the history answers `400` and the advisor reports `series-unavailable` with the hint to enable it. The registry marks each criterion `core` or `extended`.
- A bearer for the `substrate` surface, resolved like the runtime doctor: `SUBSTRATE_TOKEN`, then the first entry of `SUBSTRATE_TOKEN_SUBSTRATE`, then `SUBSTRATE_TOKEN_FILE` or `SUBSTRATE_TOKENS_DIR`. It is sent only as an `Authorization` header to `SUBSTRATE_URL` (default `http://127.0.0.1:7410`) and is never printed. Redirects are not followed.

## Run it

```sh
bun run advisor:promote                      # all flags with history evidence
bun run advisor:promote -- --flag SUBSTRATE_BUDGETS
bun run advisor:promote -- --json            # the same report as JSON
bun run advisor:promote -- --offline fixture.json   # no request: answers from a file
```

Exits 0 whatever the verdicts. Exits 2 on a usage error: an unknown argument, a `--flag` that is not a policy flag, an unreadable or invalid `--offline` fixture, or (in live mode, not with `--offline`) a `SUBSTRATE_URL` that is not an `http://` or `https://` URL (checked before any request, so nothing is sent).

Each flag prints its verdict, one line per criterion with the observed number, the proposed threshold, the sample count and the window, then the operator's one-line step (`when ready:`) and the `rollback:`. Policy flags whose evidence is not in the history (`SUBSTRATE_LEDGER_TTL`, `SUBSTRATE_INDEX_SWEEP`, `SUBSTRATE_INDEX_TUNE`, `SUBSTRATE_HINDSIGHT_INVENTORY`, `SUBSTRATE_DOCS_PRUNE_SUPERSEDED`, `SUBSTRATE_SLO_NOTIFY`, `SUBSTRATE_WATCHDOG`, `SUBSTRATE_METRICS_HISTORY`) are listed under "not judged from the history" with the manual check to make instead.

## Verdicts

| Verdict | Meaning | What to do |
| --- | --- | --- |
| `ready` | Every criterion of the flag is met, with enough samples, over a history that spans the window. | Read the numbers, take the manual check if the flag lists one (`also check:`), then take the step. |
| `hold` | A criterion is measured and not met. A flip would be a regression against the proposal. | Do not flip; change the policy's tuning or the proposal on purpose, then soak again. |
| `insufficient-data` | The history does not span the window (under 90 %), has a gap longer than 25 % of the window, holds fewer samples than the floor, was truncated, or its retention is shorter than the window. Coverage is judged per the evidence rules below (own labelled rows; for extended criteria also the extended gauge and the policy's own series). | Keep the safe mode and rerun later. |
| `series-unavailable` | The substrate cannot give the series: history off, an extended series not recorded, a refused bearer, or no answer. | The line carries the reason and the hint. |

A flag with several criteria is `hold` if any is held, else `series-unavailable` if any series is unavailable, else `insufficient-data` if any lacks data, else `ready`. A measured miss outranks a gap in the data, and an unreadable series outranks a thin one.

A history that spans the window can still have a hole: no stretch of it (between two points, or after the last one) may be longer than 25 % of the window (`MAX_GAP_FRACTION` in `scripts/promote-advisor.ts`), otherwise the criterion is `insufficient-data` and the line names the gap. A sampler or ledger that was down for most of the window cannot read as covered; a long stretch with no traffic (a counter has no row for an interval with nothing to count) reads the same way, which is the safe answer.

The evidence rules, exactly (each says what a check proves and what it cannot):

1. **Window coverage and gaps (every criterion).** The criterion's coverage points must span at least 90 % of the window and have no stretch (between two points, or after the last) longer than 25 % of it. This proves the sampler and the ledger were up. It cannot prove the policy was producing evidence.
2. **Label scope.** Coverage is judged on the points the criterion is about: a criterion with a label term (for example `brief.p95{grok-bot}`) is covered only by rows with that label, so another surface's full day cannot vouch for a recent burst.
3. **Extended sampling (criteria over an extended series).** The extended coverage gauge (`hindsight.outbox_size`, a row in every sampling interval once `SUBSTRATE_METRICS_HISTORY_SERIES=extended` is on) must pass rule 1. Extended history starts when that flag was enabled; before it the extended counters are absent, not zero. This proves extended sampling ran for the window. It cannot prove the policy ran: a policy records nothing while its flag is `off`.
4. **The policy's own series (criteria over an extended series).** The criterion's own series (the numerator, with its label terms; for a share, its denominator population) must have its first point at or before 10 % of the window from the window start, so the policy has been producing evidence for at least 90 % of the window. A counter has no row for an interval with nothing to count, so there is no gap rule here, only the age of the first point. A series that started later is `insufficient-data` ("started only N h ago ... it records nothing while the flag is off"): three days of gauge and a recall series that began three hours ago is not three days of recall evidence. This proves the policy had been running; it cannot prove the interval in between was busy.
5. **No points recorded.** If the own series has no points at all in the window, the advisor cannot tell "not observed" from "zero" and the criterion is `insufficient-data` ("no points recorded: cannot tell not-observed from zero"), never `ready`. For `SUBSTRATE_MEMORY_EXPIRY` that means the history can only ever report `hold` (something was served) or `insufficient-data`; the decision rests on its manual check (`also check:`).
6. **Rules 3 to 5 block only a pass.** A measured miss is a `hold` whatever the age of the data.

**The manual check still applies when the verdict is `ready`.** A policy with both history evidence and a manual check (`SUBSTRATE_MEMORY_EXPIRY`, `SUBSTRATE_BRIEF_RECALL`, `SUBSTRATE_BUDGETS`) prints the check as `also check:` beside the step, and carries it in the JSON as `manual`. `ready` means the history met the proposals; it does not replace that check (for recall, the unchanged `brief.p95` while in shadow; for memory expiry, the sweep dry-run; for budgets, the per-surface and coordination counts in `/metrics`).

## The evidence and the proposed thresholds

Generated from the registry by `bun run config:reference`; `bun run config:reference -- --check` exits 1 when this table has drifted, and `config-reference.test.ts` runs that check. A **share** is a sum of counter increments over a sum of counter increments in the window; `shadow_limited` and `limited` are both counted against budgets so the same rule judges a flag that was already flipped.

<!-- evidence-table:begin (generated by `bun run config:reference`; edit flag-registry.ts, not this table) -->

| Flag | Criterion | Rule | Min samples | Window | Series | Rationale |
| --- | --- | --- | --- | --- | --- | --- |
| `SUBSTRATE_MEMORY_EXPIRY` | expired entries still served | `total memory.expired{served} == 0` | 0 | 7d | extended | PROPOSED. Under report an expired entry is still served (mode=served), so a non-zero count is exactly what enforce would start hiding. The series is not split by memory kind, so any served expired entry holds the flip until the operator has read the sweep dry-run for kind=decision entries; a count of zero cannot be told from 'not observed', because a counter has no row for an interval with nothing to count, so the advisor reports hold when something was served and insufficient-data otherwise: the decision rests on the manual check. Extended history starts when SUBSTRATE_METRICS_HISTORY_SERIES=extended was enabled, never earlier. |
| `SUBSTRATE_CACHE_SWR` | would-serve-stale share of misses (lower bound) | `cache.operations{would_serve_stale} / cache.operations{miss} >= 10.00 %` | 100 | 24h | extended | PROPOSED. would_serve_stale is counted IN ADDITION to the miss of the same request (cache.ts counts the miss, then the shadow probe counts would_serve_stale), so it is a subset of miss and the share is would_serve_stale / miss. Below this share stale-serving answers too few misses to be worth a second code path (under 1 % it buys nothing). The history sums every cache class while would_serve_stale is counted only for the brief class, so other classes' misses inflate the denominator: the measured share is a LOWER BOUND of the brief share. A ready verdict therefore stands; a hold may understate the brief share and is worth a look at /metrics (class=brief) before it is believed. |
| `SUBSTRATE_CACHE_SWR` | brief p95 (grok-bot, worst interval) | `worst brief.p95{grok-bot} <= 800 ms` | 100 | 24h | core | PROPOSED. The brief objective already in the SLO catalogue (DEFAULT_THRESHOLDS.briefP95Ms = 800). The history keeps the worst interval p95 per bucket, so one slow interval holds the flip: stricter than the rolling-hour objective. |
| `SUBSTRATE_BRIEF_PROFILE` | bytes saved per brief | `brief.profile_bytes_saved per brief.p95 observation >= 700 bytes/brief` | 30 | 3d | extended | PROPOSED. 700 bytes is 20 % of the 3500-byte compact cap (DEFAULT_COMPACT_BYTES): below it the compact rendering saves too little to change what a surface is served. The history carries no full-size series, so the recon's 20 % share cannot be computed; bytes per brief replaces it. The denominator counts every brief of every surface, and bytes saved accrue only on fresh answers, so the figure is diluted and a ready verdict is conservative. |
| `SUBSTRATE_BRIEF_RECALL` | would-include share of briefs | `brief.recall{would_include+included} / brief.recall >= 50.00 %` | 100 | 3d | extended | PROPOSED. Fewer than half of briefs finding a fresh recall snapshot means enforce would mostly add nothing. Denominator is every brief counted in brief.recall, including disabled and dropped_by_cap. |
| `SUBSTRATE_BRIEF_RECALL` | cold plus stale share of briefs | `brief.recall{cold+stale} / brief.recall < 30.00 %` | 100 | 3d | extended | PROPOSED. A cold or stale snapshot is counted and omitted; 30 % or more of briefs missing means the prefetch interval or budget is wrong for the traffic. |
| `SUBSTRATE_BRIEF_RECALL` | prefetch error share | `recall.prefetch{error} / recall.prefetch < 5.00 %` | 100 | 3d | extended | PROPOSED. Prefetch errors at 5 % or more mean the Hindsight plane is not steady enough to enforce a section built from it. |
| `SUBSTRATE_BUDGETS` | shadow-limited share of decisions | `admission.decisions{shadow_limited+limited} / admission.decisions{allowed+shadow_limited+limited} <= 1.00 %` | 100 | 24h | core | PROPOSED. The 1 % ceiling and the 100-decision floor are the ones ADMISSION_SLO already uses for admission.limited_rate; the proposal is to apply them to the SHADOW count, because that row reads 0 in shadow by design. A bypass is not a decision and is left out. The history is aggregated over surfaces and classes: the per-surface-and-class check and the zero tolerance for the coordination class need /metrics substrate.admission.decisions. |

<!-- evidence-table:end -->

Caveats the numbers carry:

- `/slo` `admission.limited_rate` reads 0 in shadow by design (only `limited` is its numerator), so the budget criterion reads the raw `shadow_limited` counts, not that row.
- The history is aggregated over surfaces. The budget criterion is therefore over all surfaces and classes together; the per-surface, per-class check and the zero tolerance for the `coordination` class need the labelled counters in `GET /metrics` (`substrate.admission.decisions`).
- The SWR share is `would_serve_stale / miss`: `would_serve_stale` is counted in addition to the miss of the same request (a subset of it), so the denominator is `miss` alone, not `miss + would_serve_stale`. The cache series sums every cache class while `would_serve_stale` is only ever counted for the brief class, so the measured share is a LOWER BOUND of the brief share: a `ready` stands, a `hold` may understate it (check `GET /metrics`, class `brief`). The advisor prints this on the criterion's line.
- The brief-profile series is `bytes saved`, not a share of full size (no full-size series exists), so the proposal is bytes per brief against 20 % of the 3500-byte compact cap.
- `brief.p95` in the history keeps the worst interval per bucket, so a single slow interval holds the flip: stricter than the rolling-hour objective in `/slo`.

## Procedure

1. **Soak in the safe mode.** Leave the flag at its `safe` value for at least the criterion window (24 hours for budgets and SWR, 3 days for profile and recall, 7 days for memory expiry). For `SUBSTRATE_BRIEF_RECALL` the safe value is `off`: first set `shadow` and soak, because `off` records nothing and the criteria read `insufficient-data`.
2. **Run the advisor** and read every line, not just the verdict: the observed number, the samples, and the window.
3. **Flip as an operator step.** The advisor prints the step; take it yourself in the unit env or drop-in and restart the unit. A flag read by two processes (`SUBSTRATE_MEMORY_EXPIRY`: the server and the sweep job) must be set in both, or one keeps the old behaviour.
4. **Watch.** The counters change meaning once the policy bites (for example `would_serve_stale` stops and `stale` and `refresh` begin), so a repeated advisor run reports on the enforcing mode; compare `/slo`, `/healthz` and the policy's own metrics against the pre-flip week.
5. **Roll back** by setting the flag back to its safe value and restarting. This restores the code path only. It does not restore what the enforcing mode already did: rows deleted by `SUBSTRATE_INDEX_SWEEP=apply`, documents pruned by `SUBSTRATE_DOCS_PRUNE_SUPERSEDED=1`, a retention `ALTER` applied by `SUBSTRATE_LEDGER_TTL` and the storage tune of `SUBSTRATE_INDEX_TUNE=apply` stay until an operator reverses them (export first: `docs/runbooks/index-archive.md`, `docs/greptime-ledger.md`).

Changing a proposal is a code change: edit the row in `packages/mcp-server/src/flag-registry.ts`, run `bun run config:reference`, and commit the regenerated tables with the registry.

## Offline fixtures

`--offline fixture.json` answers every request from a file, for a dry run and for tests. The file is `{ "series": { "<series>[@<window>]": { "status": 200, "body": <a /slo/history body> } }, "slo": { "status": 200, "body": { "history": { "epoch": 3, "since": "..." } } } }`. A key with `@<window>` (for example `admission.decisions@24h`) wins over the bare series name; a series the file does not name answers like a series the substrate does not record. `404 {"enabled":false}` is the history-off answer.
