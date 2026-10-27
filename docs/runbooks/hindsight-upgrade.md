# Runbook — upgrading the pinned Hindsight

| | |
| --- | --- |
| Trigger | An open issue labelled `hindsight-lag`, opened by the weekly `Hindsight lag` workflow because a newer stable Hindsight release has existed for at least `lag_alert_days` (`.github/hindsight-pin.json`) |
| Scope | The three Railway services that run Hindsight: `hindsight-api`, `hindsight-worker`, `hindsight-control-plane`, and the Postgres they share |
| Blast radius | Recall and retain through `planes/hindsight.ts`. A Hindsight outage never turns `/healthz` red; it turns the plane's row red and degrades the reads that plane serves (`docs/runbooks/substrate-red.md`) |
| Untouched | The Postgres index, the ledger, leases, RAGFlow. Accepted memories are kept in the index first and forwarded to Hindsight afterwards (`docs/data-planes.md`) |
| Who | The operator. Every step marked **OPERATOR ONLY** touches Railway or production; no agent, workflow or script in this repository performs one |

## What is true today (2026-10-27) and what automates nothing

- The three services run Hindsight **0.9.1**, pinned by fixed image tags. Nothing upgrades them by itself and nothing was promised to. A version changes only when an operator edits the three image tags in Railway and accepts the deploy.
- The Railway write tools in this repo are triple-gated (`SUBSTRATE_RAILWAY_WRITES` on, an operator caller, an `approval_ref`) and are limited to a redeploy and a vCPU/memory change (`docs/data-planes.md`). **No tool in this repo sets an image**, and `railway.ts` must not gain one. The tag edit is done by the operator in Railway.
- The pin is `.github/hindsight-pin.json`. It is declared intent, not a probe: no automation compares it with what Railway runs. Keep it true by updating it in the pull request that closes an upgrade (step 9).
- The pin is held at 0.9.1 because of upstream [vectorize-io/hindsight#4696](https://github.com/vectorize-io/hindsight/issues/4696), a recall hang seen in 0.10.1. That issue is closed (2026-09-28). **Which release fixes it, if any, is not verified.** Closed is not proof that 0.10.3, 1.0.0 or 1.1.0 carries a fix.
- Our client (`packages/mcp-server/src/planes/hindsight.ts`) is tested against 0.9.1 only. It calls bank config and stats, memories (retain and recall), documents (get, delete, patch tags), `/health` and `/version`, keeps a fail-open timeout, and requires the `chunks` retain extraction mode.
- A newer Hindsight **runs its database migrations on start** against Hindsight's Postgres. That is why rollback is restore plus re-pin, never a re-tag alone.
- Upstream, as read on 2026-10-27: v0.10.3 (2026-10-08, no breaking change), v1.0.0 (2026-10-13, an API stability promise), v1.1.0 (2026-10-21, one breaking change: bank ids may not start with an underscore). Re-read the release notes themselves; this list goes stale.

## What the watcher does

`.github/workflows/hindsight-lag.yml` runs `scripts/hindsight-lag.ts` every Monday and on demand, on the Omega CI runner pool, behind `CI_ENABLED`. It compares the pin with the stable releases of `vectorize-io/hindsight` (prereleases and drafts ignored), and keeps **one** open issue labelled `hindsight-lag`: opened once the **oldest** stable release newer than the pin has existed for at least `lag_alert_days` (the age counts from that first newer release, so an older release can trigger the alert while the newest one is only a day old), updated while that stays true, closed when it stops being true. The issue and its title name the **newest** stable release as the latest. The issue shows the pinned version, the latest, the age, whether any newer release notes mention a breaking change, and the state of each `blocked_by` issue. It opens no pull request and never touches Railway. If the watcher itself fails, a second job (`report-failure`, with its own checkout and Bun setup) opens one issue labelled `hindsight-lag-failed`; the next good run closes it.

Run it by hand, read-only, without a token:

```sh
bun scripts/hindsight-lag.ts --dry-run
```

To defer a known-bad window deliberately, raise `lag_alert_days` or keep the blocker listed in `blocked_by`, in a reviewed pull request, and say why in the issue. Do not close the issue by hand: the watcher reopens a fresh one next week.

## When to upgrade

When the lag issue is open **and** the preconditions below hold. A lag issue alone is a prompt to decide, not an instruction to upgrade. It is also fine to decide to skip a release and wait for the next.

## Preconditions (read-only; do all before touching anything)

1. **Blockers.** Read every `blocked_by` entry in the pin file on GitHub. If one is open, stop and note it on the lag issue. If #4696 is closed, find the release that carries the fix from the issue and the release notes; if you cannot, treat the recall hang as still possible and rely on the canary's recall check (step 4), not on the issue state.
2. **Release notes, every release between the pin and the target.** Read each one in full for breaking changes, migration notes, config and API changes. The watcher's breaking-change flag only means the notes contain a Breaking Changes heading or the word BREAKING; a clean flag does not replace reading them.
3. **Bank ids.** From 1.1.0, bank ids may not start with an underscore. Our banks are named `<prefix><surface>` with the default prefix `sub-`, so they are unaffected. Confirm: list the banks from the `/healthz` hindsight block (baseline, step 1) and check no bank id and no configured bank prefix starts with an underscore.
4. **Client surface.** The client uses only the calls listed above and needs the `chunks` retain mode. Check the release notes for any change to those routes, to bank config, or to the retain extraction modes.
5. **Mental models.** A draft change adds `POST mental-models/{id}/refresh`; its shape against 1.1.0 is **unverified**. Do not enable mental-model refresh against a new version until the canary run with `--mental-model-refresh` has recorded the response shape and a reviewed change accepts it.
6. **Target version.** Pick one concrete version. Do not jump over a version whose notes you have not read. Write the previous tag down: it is the rollback target.
7. **Window.** Choose a quiet window. Retain is fail-open and queued through the outbox, recall degrades to the index, so a short Hindsight outage does not stop agents; it does cost recall quality while it lasts.

## Steps

Steps 1 to 5 change no running service: 1 and 2 only read production or copy its data (both OPERATOR ONLY), 3 to 5 work on a throwaway candidate. Steps 6 and 7 are OPERATOR ONLY and change production; step 8 watches it.

1. **Baseline (read-only; OPERATOR ONLY because it reads production).** On the server host, read `/healthz` from the loopback listener and keep the `planes.hindsight` row and the `hindsight` block (it exists when `SUBSTRATE_HINDSIGHT_INVENTORY` is `on`; it is report-only and carries the drift report: configured banks the deployment lacks, `sub-*` banks nobody configured, banks whose retain mode is not `chunks`). Also record `GET /version` of the current deployment. Never paste a URL, key or token into a note; name variables, not values. The time bound of the block was not verified when this runbook was written.
2. **Back up Hindsight's Postgres first (OPERATOR ONLY).** Take a Railway volume snapshot of the volume that holds Hindsight's Postgres (the same convention as the sweep in `docs/runbooks/quarantine-spike.md`). Which service and volume hold it is **not recorded in this repository**: read the environment (Railway `describe-environment`) and confirm before you snapshot. Where you can also reach the database, take a logical dump into an off-box directory as a second copy:

   ```sh
   pg_dump --format=custom --file "$BACKUP_DIR/hindsight-pre-upgrade.dump" "$SOURCE_DB_URL"
   pg_restore --list "$BACKUP_DIR/hindsight-pre-upgrade.dump" > /dev/null   # proves the file is readable
   ```

   Set `SOURCE_DB_URL` in your shell from the secret store; never echo it, never put it in a log, a ticket or this file. The restore rehearsal is the same pattern the repo uses elsewhere (`docs/rehearsal.md`, `docs/runbooks/index-archive.md`): restore into a scratch database and read it back before you rely on the copy. Do not proceed until the snapshot exists and the dump lists.
3. **Stand up a CANDIDATE Hindsight at the new tag, on a throwaway target.** A scratch Railway environment or a local container, never production's services, database or API key. Seed its Postgres from the step 2 dump so the migrations the new version runs on start are rehearsed on real data. Run the API and the worker at the target tag (and the control plane, so all three images are the ones you will promote). Use a candidate API key that exists only for this run. Which settings the candidate needs beyond the image tag are **not documented here**; copy the production service settings, minus anything that points at production.
4. **Run the canary against the candidate.** In a shell whose Hindsight URL, API key and bank-prefix variables (names in `docs/config-reference.md`, "Recall plane (Hindsight)") point at the **candidate**, never at production:

   ```sh
   bun packages/mcp-server/src/hindsight-canary-run.ts --confirm-throwaway --json --mental-model-refresh
   ```

   Exit codes: `0` every check passed, `1` a check failed, `2` usage or configuration refused (no `--confirm-throwaway`, no candidate configured), `3` the candidate was unreachable. Anything but `0` stops the upgrade. The runner creates one bank under your prefix, named `canary-` plus a random suffix, and removes it at the end. Its output carries neither the URL nor the key. Record the recorded `mental-model-refresh` shape if it ran. A recall that hangs or times out is the #4696 symptom: stop. The recall check uses the budget the client uses: `HINDSIGHT_RECALL_BUDGET_MS` when it is set in that shell (a positive integer, else the 4000 ms default), so set it to production's value to test the real limit.
5. **Run the plane tests and read the candidate's health.**

   ```sh
   bun test packages/mcp-server/src/planes/hindsight.test.ts packages/mcp-server/src/hindsight-canary-run.test.ts
   ```

   These run against the repo's fake, so they prove the client code, not the candidate; the canary in step 4 is the candidate proof. If the client needs a change for the new version, make it in a reviewed pull request and re-run step 4 before going on. Read the candidate's `/health` and `/version` (the unauthenticated probes the client uses) and confirm the version is the one you meant. If you can point a scratch substrate-mcp at the candidate, read its `/healthz` hindsight block as in step 1 and require no drift; that setup is **unverified** here.
6. **Promote (OPERATOR ONLY).** Only after steps 1 to 5 pass. In Railway, edit the image tag of all three services (`hindsight-api`, `hindsight-worker`, `hindsight-control-plane`) to the target in one staged change, review the staged diff, and accept the deploy. Accepting the deploy is destructive and needs the operator's explicit confirmation; record the approval reference (the pull request or ticket) in the evidence row. The repo's own Railway writes are triple-gated (`SUBSTRATE_RAILWAY_WRITES`, an operator caller, an `approval_ref`) and cannot set an image; if you use `railway_deploy` afterwards to redeploy, it needs all three.
7. **Health-gated verification (OPERATOR ONLY).** Do not call it done until all of these hold. Anything failing is a rollback trigger (next section):
   - `GET /health` and `GET /version` on the deployment answer, and the version is the target.
   - Service logs show the migrations completed and the three services settled; none is restarting.
   - `/healthz`: `planes.hindsight.ok` is true, its breaker is not `open`, and the `hindsight` block reports no drift (all `sub-*` banks present, every one in `chunks` mode).
   - One recall through `memory_recall` answers inside its budget, and one accepted memory is retained and read back by its `document_id` (G2 and G3 in `docs/runbooks/hindsight-cache-proof.md`).
   - No `memory.retain.failed` warning events and no growth of the retain outbox.
8. **Soak.** Watch the Hindsight plane for at least a day of normal traffic: the plane error and latency series, the breaker state, `recall.prefetch{error}`. Keep the backup from step 2 until the soak ends.
9. **Record the new pin in a pull request.** After the soak, open a pull request that edits `.github/hindsight-pin.json`: `pinned` and `tested_against` to the version the canary and the checks passed on, `pinned_since` to today, `blocked_by` pruned to what still blocks. Search the repo for the old tag and fix every mention that claims to be tested against it (for example the header of `packages/mcp-server/src/planes/hindsight.ts` and `docs/runbooks/hindsight-cache-proof.md`). When it merges, the next watcher run sees a current pin and closes the lag issue. The pin file does not change Railway; it only keeps this repository honest about what runs there.
10. **Close out.** Add the evidence row below.

## Rollback (OPERATOR ONLY)

Re-tagging the images is **not enough**: the new version migrated Hindsight's Postgres when it started, and an older version may not read the migrated schema. Whether a given migration is reversible is **not verified**; assume it is not.

1. Scale down or stop the three Hindsight services so nothing writes during the restore.
2. Restore the step 2 backup into a **fresh, empty database**, never on top of the migrated one: `pg_restore --clean` only drops objects the dump knows about, so tables, indexes and columns that the newer version added would survive and an older version could trip over them. Either restore the Railway volume snapshot, or create a new database (for example `hindsight_restore_<date>`) and run `pg_restore --no-owner --no-acl` of the dump into it, then point `HINDSIGHT_API_DATABASE_URL` on the three services at it (a Railway reference variable composed from the Postgres service variables, never a pasted URL). The old, migrated database stays untouched until the soak ends, so the rollback is itself reversible. Check the table count of the restored database against the backup before switching.
3. Set the three image tags back to the previous tag you wrote down, and accept the deploy as in step 6.
4. Run step 7's checks against the restored deployment.
5. State the loss honestly in the evidence row: everything retained in Hindsight between the backup and the rollback is gone from Hindsight. Accepted memories are kept in the Postgres index as the governed store; whether a re-retain of that window is possible with the current tools is **not verified**.
6. Leave `.github/hindsight-pin.json` unchanged (it still names the version that runs) and say on the lag issue why the upgrade was rolled back and what blocks it.

## Not verified when this runbook was written

- Which upstream release fixes #4696. The 2026-10-27 trial (evidence below) could not tell: its real-bank recall soak timed out at the 4 s budget on 0.9.1, 0.10.3 and 1.1.0 alike, so it does not separate the versions. Run the soak from inside the private network, and record per-bank latency, before relying on it.
- Whether our client works unchanged against any version above 0.9.1. Observed: the canary passed on 0.10.3 and 1.1.0 (every check except the opt-in refresh and the informational bank-id note). Not observed: the whole client surface under production traffic.
- The shape of `POST mental-models/{id}/refresh` against 1.1.0.
- Which Railway service and volume hold Hindsight's Postgres, whether each migration is reversible, and whether the three services must move together or can move one at a time.
- The time bound of the `/healthz` hindsight block, and whether a scratch substrate-mcp can be pointed at an external candidate.

## Evidence

| Date (UTC) | From → to | Approval ref | Backup taken (snapshot / dump) | Canary exit and mental-model shape | Verification (step 7) | Outcome (kept / rolled back) |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-10-27 | 0.9.1 → 0.10.3 → 1.1.0, trial only (throwaway candidate service on a copy of the production database; nothing on the three production services changed) | operator authorisation in session (trial, then upgrade only if the gates passed) | Logical dump of the production database (58 MB, 23 tables) restored into a pristine backup database `hindsight_backup_20261027` (kept) and a candidate copy (dropped); the in-place migrations on the copy ran cleanly 0.9.1 → 0.10.3 → 1.1.0 | Canary exit 0 on 0.10.3 and on 1.1.0; mental-model refresh not requested | Recall soak, 176 recalls over 8 real banks, 4 s budget: 108 timeouts on 0.10.3, 104 on 1.1.0, **106 on a 0.9.1 control over a fresh copy of the same backup**, p50 about 4 s on all three | **Kept on 0.9.1.** The "recall latency passes" gate was not demonstrated, so no upgrade; the soak does not distinguish the versions |

One row per upgrade or rollback. Versions, exit codes and names only: never a URL, a key, a token or a connection string.
