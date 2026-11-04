# Runbook: docs RAG operations (v1.7 phase 70)

This is the one path an operator follows to take the docs plane from a released build to a corpus that keeps itself current, is measured, and can be taken back one step at a time. Each step gives the command and the check that proves it. Nothing here is done by the code: every unit and timer is staged and installed by you, and every flag defaults to off or to the conservative value.

The pieces: the corpus atlas (phase 63, [`corpus-ingest.md`](corpus-ingest.md)), the sync and watch units (phase 65), the semantic signals (phase 64), the re-rank (phase 66) and the objectives and evaluation of this phase ([`../corpus-eval.md`](../corpus-eval.md)). Where a step needs a unit or command that another phase wrote, it says so; a unit that is not in your checkout is not staged yet, and that step waits.

Keep two terminals: one on the host for `systemctl` and `journalctl`, one anywhere the repositories and the `substrate` command are, with `SUBSTRATE_URL` and a token that is an authenticated surface (`SUBSTRATE_TOKEN`, `SUBSTRATE_TOKEN_FILE` or the tokens directory). Never paste a token into a command line or a ticket.

## 1. Deploy the release

```sh
infra/vps/deploy-release.sh --dry-run          # what would be pruned; deletes and locks nothing
infra/vps/deploy-release.sh <tag>              # a tag whose commit is on main
```

The script archives the tag into `/opt/agent-substrate/releases/<sha>`, runs the preflight (`SUBSTRATE_DEPLOY_PREFLIGHT=off|report|enforce`, default `report`) and, when `SUBSTRATE_DEPLOY_GATE` is `report` or `enforce`, the release gate ([`release-gate.md`](release-gate.md)), swaps `current` atomically, restarts the units and polls `GET /healthz` for `SUBSTRATE_HEALTH_DEADLINE` seconds. A failed health check points `current` back at the previous release by itself. See [`../../infra/vps/README.md`](../../infra/vps/README.md).

**Check.** The script exits 0, and:

```sh
curl -fsS http://127.0.0.1:7410/healthz       # 200, with index and greptime true
readlink /opt/agent-substrate/current          # the new release
```

The release applies its migrations at boot. The corpus manifest is migration step 35 (`corpus_documents`, `expand`, `create … if not exists`, no existing row touched); it is created whether or not the corpus is on and stays empty until an ingest writes to it. Later steps are listed in [`rollback-compat.md`](rollback-compat.md).

**Rollback.** `infra/vps/deploy-release.sh rollback`. This restores code and nothing else: units, drop-ins, env files, state files and every store stay as they are. A migration step is additive, so the older release ignores what a newer one created.

## 2. Turn the corpus on

The corpus needs the LightRAG docs backend (`LIGHTRAG_URL` set, or `SUBSTRATE_DOCS_BACKEND=lightrag`) and the Postgres index. Add one line to `/etc/substrate/substrate.env`, then restart:

```sh
SUBSTRATE_CORPUS=on
systemctl restart substrate-mcp.service
```

**Check.**

```sh
substrate corpus status                        # exit 0; "corpus: 0 rows, 0 active" and "last ingest: never" on a first run
```

`503 corpus.disabled` means the flag did not reach the server. `503 corpus.backend-unavailable` means the docs backend is not a configured LightRAG, and `503 corpus.index-unavailable` that there is no index or it did not answer; fix those before going on. `fabric_status` now shows the `corpus` row as `ok` with every reading `null` (nothing has been measured yet, which is not a breach).

**Rollback.** Remove the line (or set `SUBSTRATE_CORPUS=off`) and restart. The routes and tools answer `503 corpus.disabled`, nothing reaches the plane, and the manifest and every document already on the plane stay as they were. The `corpus` row is `unconfigured` again.

## 3. The first inventory and plan

Both read and change nothing on the server.

```sh
substrate corpus scan --root /root/src/repos             # entries, per repository, with what was skipped and why
substrate corpus plan --root /root/src/repos             # what the server would add, change, update, rename or tombstone
```

**Check.** `scan` lists the repositories you expect and no unexpected skip reason; `plan` reports the adds and nothing else on an empty manifest; `substrate corpus status` still says `corpus: 0 rows`. A large plan is the moment to narrow `--root`, `--tier` or `--max-bytes`, not after.

## 4. The first ingest

A dry run until `--execute`:

```sh
substrate corpus ingest --root /root/src/repos                         # dry run: what would be sent
substrate corpus ingest --root /root/src/repos --execute               # sends, in batches
```

To include a Greptile export directory, name it with its source:

```sh
substrate corpus ingest --root /root/src/repos --source fs --source greptile --greptile-dir /path/to/export --execute
```

`--source greptile` without `--greptile-dir` is a usage error (exit 2). Start with one `--root` and widen: a first ingest is a full parse of every document.

**Check.**

```sh
substrate corpus status                        # "N active" = the number the plan added, "0 tombstoned", a last-ingest time
substrate corpus ingest --root /root/src/repos --execute   # a second run: everything unchanged, nothing sent
substrate corpus eval --root /root/src/repos --server "$SUBSTRATE_URL"   # exit 0: recall at 5 holds the objective
```

A failed or refused document is named in the output with its reason (the table is in [`corpus-ingest.md`](corpus-ingest.md)); fix the file and run again, only those are resent. `corpus eval` asks the golden set of what the scan found: exit 1 means recall at 5 is under `SUBSTRATE_DOCS_SLO_RECALL5`, or a question failed or came back degraded, and it prints which. After the ingest `fabric_status` shows the `corpus` row with `freshnessS` a few seconds and `ingestDocsPerS` the rate of your last request.

**Rollback.** Documents that were ingested are removed by taking their source away and ingesting again (the rows are tombstoned and their plane documents deleted, a deletion confirmed before the row changes) or, for plane documents no manifest row holds, with `substrate corpus reconcile` (step 10). Nothing is deleted by an ingest that did not cover the repository.

## 5. The sync and canary timers

Everything below is staged: the files exist in `infra/vps/` and nothing installs them.

**The sync units (phase 65).** `substrate-corpus-sync.timer` (every 15 minutes, `Persistent=true`) fires `substrate-corpus-sync.service`, a oneshot that runs `substrate corpus watch --once`: one sweep that fetches each registered repository's Substrate-managed blobless mirror and syncs only the repositories that changed. It never writes into a checkout. `substrate-corpus-watch.service` is the optional long-running watcher (`substrate corpus watch`): it coalesces a burst of changes into one sync per repository and sweeps on its own timer as well. Both run with a nice level, an idle I/O class, a CPU quota and a memory cap so the shared host is never starved. The units are in `infra/vps/` in this checkout. Install them as [`corpus-sync.md`](corpus-sync.md) §3 says, in this order ([`../../infra/vps/README.md`](../../infra/vps/README.md)):

```sh
[ -e /etc/substrate/substrate-corpus.env ] || install -m 0600 /dev/null /etc/substrate/substrate-corpus.env   # then fill in SUBSTRATE_URL, the CLI's token and SUBSTRATE_CORPUS_ROOTS
cp infra/vps/substrate-corpus-sync.service infra/vps/substrate-corpus-sync.timer /etc/systemd/system/
systemctl daemon-reload
systemctl start substrate-corpus-sync.service            # one run by hand
journalctl -u substrate-corpus-sync -n 50                # read it
systemctl enable --now substrate-corpus-sync.timer
```

Add the watcher only when a timer's lag is not enough: `cp infra/vps/substrate-corpus-watch.service /etc/systemd/system/`, `systemctl daemon-reload`, `systemctl enable --now substrate-corpus-watch.service`.

**The reconcile dry run.** `substrate-corpus-reconcile.timer` (daily, 04:43 UTC) runs `substrate corpus reconcile --json`: it compares the manifest with the docs plane, reports the drift and changes nothing. Install it the same way: `cp infra/vps/substrate-corpus-reconcile.service infra/vps/substrate-corpus-reconcile.timer /etc/systemd/system/`, `systemctl daemon-reload`, `systemctl enable --now substrate-corpus-reconcile.timer`. No unit runs `--execute`; see step 10.

**Check.** `systemctl list-timers 'substrate-corpus*'` lists the timer with a next run; the manual run exits 0 and the journal shows documents unchanged; `bun scripts/doctor-units.ts --dry-run` stays green.

**The canary.** `substrate-docs-canary.timer` runs the daily canary at 04:41 UTC: the fixture questions of [`../docs-search-ingest.md`](../docs-search-ingest.md) and, since phase 70, the golden set of this checkout's `docs/`. The golden part needs two things: this repository's documents in the corpus under `SUBSTRATE_DOCS_EVAL_REPO` (default `swcstudiospace/agent-substrate`), which step 4 does when `/root/src/repos` holds it, and `SUBSTRATE_CORPUS=on` in the environment the canary loads (`/etc/substrate/substrate.env`, the line step 2 sets). With the corpus off the canary sends no golden search and prints no golden line. Follow the install steps in that page (the corpus pins, the manifest, `SUBSTRATE_DOCS_CANARY=1` on the drop-in), then:

```sh
systemctl start substrate-docs-canary.service      # one run
journalctl -u substrate-docs-canary -n 50          # look for: golden recall@5 <value> over <n> questions
systemctl enable --now substrate-docs-canary.timer
```

**Check.** The journal line names a recall and a count, the unit exits 0, and `fabric_status` then shows `recall5.reading` in the `corpus` row. If the journal says `golden recall not measured`, the parenthesis on that line gives the reason: no documents to ask about, the scan of `docs/` was partial, or a question failed or came back degraded. `golden recall not measured (the documents could not be read)` means the read threw. The posted report (`docs.canary`) is accepted only from the canary's own `substrate` token: any other token is refused with `reserved-action` (`packages/mcp-server/src/reserved-actions.ts`), so a missing reading is never one somebody else could have written.

**Rollback.** `systemctl disable --now substrate-corpus-sync.timer substrate-corpus-watch.service substrate-corpus-reconcile.timer substrate-docs-canary.timer`, then remove the unit files you copied (sync service and timer, watch service, reconcile service and timer, canary service and timer, and any drop-ins) and `systemctl daemon-reload`. Documents stay on the plane; they simply stop following the repositories.

## 6. Turn the re-rank on

The re-rank (phase 66) is in this checkout. `SUBSTRATE_DOCS_RERANK` is read by `loadDocsReflectSettings` in `packages/mcp-server/src/config.ts` and applied in `reflectAnswer` in `packages/mcp-server/src/service.ts`, through `reflectCitations` in `packages/mcp-server/src/corpus/rank.ts`. Any value other than `shadow` or `on` is `off`:

- `off` (default): the answer is exactly what the plane returned.
- `shadow`: the answer is unchanged. The order `on` would take and how many positions would move go to the retrieval telemetry row, which is written only with `SUBSTRATE_DOCS_TELEMETRY=on`.
- `on`: each corpus citation whose document the manifest holds as an active row is annotated with `stale` and `superseded_by`, and the corpus citations are re-ordered by their score times `0.5 + 0.5 × authority`, so authority moves a citation by at most half its score. Other citations keep their positions. A degraded answer, a missing manifest (`SUBSTRATE_CORPUS` off) or a manifest that cannot be read leaves the answer as `off` leaves it.

Promote it the way [`flag-promotion.md`](flag-promotion.md) says to promote any flag, with the corpus numbers as the evidence:

1. Record the number to beat with the mode off: `substrate corpus eval --root /root/src/repos --server "$SUBSTRATE_URL" --json > before.json`.
2. Set `SUBSTRATE_DOCS_RERANK=shadow` and `SUBSTRATE_DOCS_TELEMETRY=on`, restart, and let it run for the days you choose. Read the `rerank` column of the `corpus_retrievals` rows (`mode: "shadow"`, `order`, `moved`). Shadow answers exactly as off does, so `corpus eval` does not move in this mode.
3. Set `SUBSTRATE_DOCS_RERANK=on`, restart, run the same `corpus eval ... --json > after.json`, and compare it with `before.json` (recall at 5 and MRR).

**Check.** `corpus eval` asks the server's `POST /docs/search`, so it scores the mode the server is running. Exit 0 means recall at 5 holds the objective; it does not by itself show that the re-rank helped, so compare the two JSON files. Offline, `bun test scripts/docs-eval.test.ts` checks that an identity re-rank changes no score.

**Rollback.** Set `SUBSTRATE_DOCS_RERANK=off` (or `shadow`) and restart. The re-rank writes nothing to the manifest or the plane; retrieval rows already recorded stay until the telemetry retention sweep removes them.

## 7. Read the objectives

```sh
# the MCP tool, or the same through any client
fabric_status        # the `corpus` row: state, source, detail
```

The row's `detail` has `freshnessS`, `recall5` and `ingestDocsPerS`, each `{ reading, threshold }` with `reading: null` until measured, and `breaches`. With `SUBSTRATE_METRICS_HISTORY=on` and `SUBSTRATE_METRICS_HISTORY_SERIES=extended` the same three are the series `corpus.freshness_seconds`, `corpus.ingest_docs_per_s` and `corpus.golden_recall5` on `GET /slo/history` and the data-planes dashboard ([`../dashboards.md`](../dashboards.md)). Their meaning, and the thresholds `SUBSTRATE_DOCS_SLO_FRESHNESS_S` (86400), `SUBSTRATE_DOCS_SLO_RECALL5` (0.6) and `SUBSTRATE_DOCS_SLO_INGEST_DOCS_PER_S` (0.2), are in [`../corpus-eval.md`](../corpus-eval.md).

## 8. What each alert means

| You see | It means | Do this |
| --- | --- | --- |
| `corpus` row `degraded`, `corpus.slo: breached freshness` | The newest ingested document is older than `SUBSTRATE_DOCS_SLO_FRESHNESS_S`. Either the sync stopped, or nothing changed (the reading is the age of the newest document, so a quiet corpus ages). | `systemctl status substrate-corpus-sync.timer`, `journalctl -u substrate-corpus-sync`; run `substrate corpus ingest --execute` by hand. If the repositories simply did not change, raise the threshold. |
| `corpus.slo: breached recall5` | The last golden-set recall at 5 reported by the canary is under `SUBSTRATE_DOCS_SLO_RECALL5`. Retrieval got worse, or the documents the golden set asks about are not in the corpus. | `substrate corpus eval --server "$SUBSTRATE_URL"` for a fresh reading; check `substrate corpus status` holds this repository. |
| `corpus.slo: breached ingest` | An ingest request that uploaded documents to the plane averaged under `SUBSTRATE_DOCS_SLO_INGEST_DOCS_PER_S`. The plane is slow or a large first ingest is under way. Rows only refreshed in the manifest (`updated`) are not uploads and do not count; a request that uploaded nothing is never judged. | `fabric_status` for the `lightrag` row; lower `SUBSTRATE_CORPUS_CONCURRENCY` if the host is starved; wait out a first ingest. |
| `corpus.slo: timeout` or `failed` | The corpus readings could not be read: the manifest read ran out of its 1 second bound (`timeout`) or threw (`failed`), or the fabric's own deadline passed. The freshness reading keeps its last good value and is not refreshed until a read succeeds. | `fabric_status`'s `timescaledb-index` row; [`../observability.md`](../observability.md). |
| The canary unit failed with `golden recall@5 … is under SUBSTRATE_DOCS_SLO_RECALL5` | The same breach as above, seen from the daily run. | As for `breached recall5`. |
| `docs canary regression: …` warning event | A fixture question stopped finding its page. | [`../docs-search-ingest.md`](../docs-search-ingest.md). |
| `docs.freshness` warning event | An accepted merge trigger has no recorded ingest after `SUBSTRATE_DOCS_TRIGGER_LAG_MIN`. | [`../observability.md`](../observability.md). |
| `corpus eval` exit 1 with `question(s) failed` or `degraded` | The server could not answer: an outage, not a retrieval miss. The scores printed cover only the answered questions. | Fix the plane first (`fabric_status`), then run it again. |
| `503 corpus.backend-unavailable` | The docs backend is not a configured LightRAG. | Set `LIGHTRAG_URL` or `SUBSTRATE_DOCS_BACKEND=lightrag` and restart. |

## 9. CI and the baseline

`bun test` runs `scripts/docs-eval.test.ts`, which runs the offline harness against the committed baselines, once for the lexical retriever and once for the production search code behind a fake plane. A failure there is a change in ranking inputs, de-duplication, the re-rank hook order or the server's handling of an answer, and the failing line says which baseline (`lexical:` or `server:`). If the change is intended, run `bun scripts/docs-eval.ts --write-baseline`, read the diff and commit it with the change ([`../corpus-eval.md`](../corpus-eval.md)).

## 10. Roll back, step by step

| To undo | Do | What stays |
| --- | --- | --- |
| The release | `infra/vps/deploy-release.sh rollback` | Everything but code: units, env files, stores, migrations. |
| The corpus | `SUBSTRATE_CORPUS=off`, restart | The manifest and every plane document; the routes answer `503 corpus.disabled`. |
| The re-rank | `SUBSTRATE_DOCS_RERANK=off` (or `shadow`), restart | The manifest and the plane, untouched. `corpus_retrievals` rows already recorded (telemetry on) stay until the retention sweep. |
| The timers | `systemctl disable --now` the sync timer, the watcher, the reconcile timer and the canary timer; remove their unit files | Documents on the plane. |
| The manifest table | Its migration step is `phase: "expand"` and additive; an older release ignores it. The step's declared `down` (`drop table if exists corpus_documents`) is an operator statement that nothing in the code runs; run it only with the corpus off, and read [`rollback-compat.md`](rollback-compat.md) first. | The plane documents, now unreferenced by any row. |
| Plane documents | `substrate corpus reconcile` (a dry run unless `--execute`) lists the `corpus:` documents the plane holds that no active manifest row names (orphans), and the rows whose plane document is gone. With `--execute` it deletes the orphans and marks the missing rows removed, so the next `corpus plan` offers them as adds and `corpus ingest --execute` puts them back. It needs `SUBSTRATE_CORPUS=on` and the LightRAG backend, so run it before step 2's rollback, and read its `--help` for the exact flags. No unit runs `--execute`: `substrate-corpus-reconcile.timer` runs the dry run daily (step 5). | Nothing else on the plane. |

The plane documents this milestone writes are named `corpus:<repo>:<path>@<sha12>` (percent-encoded), so they can be told from every other document, and the manifest key is `(repo, path)`.
