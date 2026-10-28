# Runbook — rehearse and apply an index migration: backup, restore to a throwaway, migrate, compare, then production

| | |
| --- | --- |
| Question | Is it safe to apply new `MIGRATION_STEPS` to the production Postgres index, and how do I prove it before and after? |
| Trigger | A release adds a step to `MIGRATION_STEPS` (`packages/mcp-server/src/index-store.ts`), or you change what `migrate()` does |
| Who | An operator. **Every step against production is HARD_STOP: nothing here runs automatically, no agent runs it, and no CI job does.** |
| Scope | The index (graph, lease, governed-memory and skills tables). Not the ledger (GreptimeDB), not Hindsight, not Dragonfly |
| Blast radius | The rehearsal touches only a throwaway container on `127.0.0.1:5434`. The backup and the final apply are the only steps that touch production: the backup reads it, the apply writes it |

## What to know first

- **The production index is not on this host.** It is a Railway TimescaleDB reached through Railway's public TCP proxy; `SUBSTRATE_PG_URL` in `/etc/substrate/substrate.env` names it. It is plain Postgres tables on that host: no hypertables, continuous aggregates or Timescale policies are used (`docs/data-planes.md`). `127.0.0.1:5432` on a dev or Cursor Cloud machine is a scratch Postgres for tests (`AGENTS.md`), not production.
- **Port 5434, never 5432.** Port 5432 on this host belongs to another project's container. The rehearsal container uses `127.0.0.1:5434`.
- **Production had no migration ledger before the first `migrate()`.** The first run on a database that predates `schema_migrations` finds an empty ledger and replays every idempotent step (`create … if not exists`, `add column if not exists`), stamping each version as it commits. On a database that already has the objects that is a no-op per step; it is also why a step's text must never be edited after it was applied (`index-store.migrate-contract.test.ts` pins every applied step by digest).
- **A step's `down` is documentation.** `MigrationStep.down` (steps from version 33) is for an operator to read and run by hand. `migrate()` never executes it.
- **Some steps are opt-in and are not in the default count.** Steps 33 `planning_steering_audit` and 34 `planning_steering_audit_reason` run only when `IndexStore` is built with `migrationOptIns: { "steering-audit": true }`, which the service does when `SUBSTRATE_PLANNING_STEERING_AUDIT_TABLE` is on (default off). While it is off, `migrate()` skips both steps and does not ledger them, so the ledger holds `applicableMigrationSteps(...)`, not every `MIGRATION_STEPS` entry. The commands below use the default (opt-in off), which is what production runs unless that variable is set. To rehearse the opt-in steps, pass `{ "steering-audit": true }` to both `applicableMigrationSteps` and the `IndexStore` constructor in the commands below, and rehearse them before turning the variable on; that one rehearsal covers 33 and 34 together, since 34 alters the table 33 creates.
- **Read the steps from the branch, not from `main`.** The rehearsal must run the code that will be deployed. Every command below that runs `bun` does so from the branch worktree, `$BRANCH`:

```sh
BRANCH=/root/src/worktrees/<the-branch-worktree>   # the checkout of the release you are about to deploy
git -C "$BRANCH" log -1 --oneline
cd "$BRANCH" && bun install --frozen-lockfile
bun -e 'import { applicableMigrationSteps } from "./packages/mcp-server/src/index-store.ts"; const steps = applicableMigrationSteps({ "steering-audit": false }); console.log(steps.length, steps.at(-1)?.name)'
```

Write down the step count `N` it prints: it is the ledger's expected `count(*)` and `max(version)` at the end. To list what is new, compare with what production already has (step 5 below), then read those steps in `index-store.ts` and, if they declare `down`, read it too.

Nothing below prints the connection URL. Do not add `echo "$SUBSTRATE_PG_URL"`, `set -x` or `docker inspect` output to a transcript, and do not paste a `docker run` line that has the URL on it.

## 1. Back up production

```sh
umask 077
mkdir -p ~/backups && chmod 700 ~/backups
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
docker run --rm \
  -v /etc/substrate/substrate.env:/run/substrate.env:ro \
  -v ~/backups:/backups \
  postgres:16 \
  sh -c 'set -a; . /run/substrate.env; set +a; pg_dump -Fc --no-owner -f "/backups/index-'"$STAMP"'.dump" "$SUBSTRATE_PG_URL"'
chmod 600 ~/backups/index-"$STAMP".dump
```

The file is mounted read-only and the URL is read inside the container, so it never reaches your shell history. If the env file is not readable by your user, run the same command with `sudo` and then `sudo chown "$USER" ~/backups/index-"$STAMP".dump`. The dump is a full copy of the index, including memory entries: keep it at mode 600 in a mode 700 directory and do not copy it off the host.

Check it is a valid archive and holds the data:

```sh
docker run --rm -v ~/backups:/backups:ro postgres:16 pg_restore -l /backups/index-"$STAMP".dump | grep -c 'TABLE DATA'
```

Expect **12** table-data entries across the `public` and `substrate` schemas. Any other number: stop and find out which table is missing or new before going on. Also run `pg_restore -l … | grep -i extension`: if it lists `timescaledb`, the restore in step 2 will report that extension as an error on plain `postgres:16` (UNVERIFIED: this runbook was written without a production dump to look at). The tables are plain, so the rehearsal is still valid; note the extension error in your record and go on, or restore into a `timescale/timescaledb` image of the same Postgres major version instead.

## 2. Restore into a throwaway container

```sh
docker run -d --name index-rehearsal \
  -e POSTGRES_PASSWORD=rehearsal \
  -v ~/backups:/backups:ro \
  -p 127.0.0.1:5434:5432 \
  postgres:16
until docker exec index-rehearsal pg_isready -U postgres; do sleep 1; done
docker exec index-rehearsal createdb -U postgres substrate_copy
docker exec index-rehearsal pg_restore -U postgres -d substrate_copy --no-owner /backups/index-"$STAMP".dump
export REHEARSAL_PG_URL=postgres://postgres:rehearsal@127.0.0.1:5434/substrate_copy
```

`rehearsal` is a throwaway password for a container bound to loopback and removed at the end; it is not a production credential. If port 5434 is already in use, stop: pick another free port above 5433 and say so in your record. Never fall back to 5432.

Record the row counts of every table in the copy (the same query is used against production in steps 5 and 7):

```sh
cat > ~/backups/counts.sql <<'SQL'
select format('select %L as tbl, count(*) from %I.%I', schemaname || '.' || tablename, schemaname, tablename)
from pg_tables where schemaname in ('public', 'substrate') and tablename <> 'schema_migrations' order by 1 \gexec
SQL
docker exec -i index-rehearsal psql -U postgres -d substrate_copy -At -F ' ' < ~/backups/counts.sql > ~/backups/counts-copy-before.txt
cat ~/backups/counts-copy-before.txt
```

## 3. Migrate the copy with the branch's code

```sh
cd "$BRANCH"
bun -e '
import { IndexStore } from "./packages/mcp-server/src/index-store.ts";
const store = new IndexStore(process.env.REHEARSAL_PG_URL);
try { await store.migrate(); console.log("migrate: ok"); } finally { await store.close(); }
'
```

Then compare. Row counts of the data tables must not change (migrations create objects, they never delete rows). `counts.sql` leaves `schema_migrations` out of that comparison on purpose: the first ledgered run creates the table and every newly applied step adds one row to it, so it is expected to differ. Check the ledger on its own: it must hold exactly the steps of the branch, by version and name:

```sh
docker exec -i index-rehearsal psql -U postgres -d substrate_copy -At -F ' ' < ~/backups/counts.sql > ~/backups/counts-copy-after.txt
diff ~/backups/counts-copy-before.txt ~/backups/counts-copy-after.txt && echo "row counts unchanged"
docker exec index-rehearsal psql -U postgres -d substrate_copy -At -c 'select count(*), max(version) from schema_migrations'
bun -e 'import { applicableMigrationSteps } from "./packages/mcp-server/src/index-store.ts"; for (const s of applicableMigrationSteps({ "steering-audit": false })) console.log(s.version, s.name)' > ~/backups/ledger-expected.txt
docker exec index-rehearsal psql -U postgres -d substrate_copy -At -F ' ' -c 'select version, name from schema_migrations order by version' | diff ~/backups/ledger-expected.txt - && echo "ledger lists every step"
```

The first `diff` prints nothing, the second command prints `N|N` (the `N` from the top of this runbook) and the last `diff` prints nothing. Run `migrate()` a second time and run the checks again: they must give the same result (a migration that is not idempotent shows up here, and a second run adds no ledger row).

Now run the repo's checks against the copy, from `$BRANCH`:

```sh
bunx tsc --noEmit
SUBSTRATE_TEST_PG_URL="$REHEARSAL_PG_URL" bun test
```

`SUBSTRATE_TEST_PG_URL` turns on the live index tests (leases, memory, search, graph bindings, the migrate ledger). Those tests create and delete their own rows in the copy: that is why they run against the copy and never against production. A failure here stops the rollout.

## 4. Remove the container

```sh
docker rm -f index-rehearsal
```

The copy holds production data. Remove it as soon as the checks are done; do not leave it running overnight.

## 5. Take a fresh backup, immediately before the apply

The step 1 backup is as old as the rehearsal. Take another one with the same commands as step 1 (a new `STAMP`), and read the live counts for the record:

```sh
docker run --rm -i \
  -v /etc/substrate/substrate.env:/run/substrate.env:ro \
  postgres:16 \
  sh -c 'set -a; . /run/substrate.env; set +a; psql "$SUBSTRATE_PG_URL" -At -F " "' < ~/backups/counts.sql > ~/backups/counts-prod-before.txt
docker run --rm -i \
  -v /etc/substrate/substrate.env:/run/substrate.env:ro \
  postgres:16 \
  sh -c 'set -a; . /run/substrate.env; set +a; psql "$SUBSTRATE_PG_URL" -At -c "select count(*), max(version) from schema_migrations"'
```

(The last command fails with `relation "schema_migrations" does not exist` on a database that has never run a ledgered `migrate()`: that is the "no ledger yet" case above, not an error in the runbook. Note its count, or that the table is missing: the ledger grows from that count to `N` in step 7, one row per newly applied step.)

**If the backup fails, or `pg_restore -l` does not show 12 table-data entries, abort.** Do not apply without a backup taken in this session.

## 6. Apply to production

Use either path, and only one:

- **Deploy the release** (`deploy-release.sh`, `docs/runbooks/release-gate.md`): `substrate-mcp` runs `migrate()` itself on boot, under the advisory lock; or
- **Run `migrate()` by hand** from `$BRANCH`, with the env file loaded by Bun so the URL is never on a command line:

```sh
cd "$BRANCH"
bun --env-file=/etc/substrate/substrate.env -e '
import { IndexStore } from "./packages/mcp-server/src/index-store.ts";
const store = new IndexStore(process.env.SUBSTRATE_PG_URL);
try { await store.migrate(); console.log("migrate: ok"); } finally { await store.close(); }
'
```

A second boot or run waits on the advisory lock (`lock_timeout` 180 s) rather than running concurrently, so a deploy and a manual run cannot collide. A failing step rolls back its own transaction, stamps nothing, and releases the lock; fix the cause and run again.

## 7. Verify production

Ledger rows and the highest version equal `N`; the ledger lists every step by name; the new objects exist; the data-table row counts did not change (the ledger is compared on its own, not in the counts); the service is healthy:

```sh
docker run --rm -i -v /etc/substrate/substrate.env:/run/substrate.env:ro postgres:16 \
  sh -c 'set -a; . /run/substrate.env; set +a; psql "$SUBSTRATE_PG_URL" -At -c "select count(*), max(version) from schema_migrations"'
docker run --rm -i -v /etc/substrate/substrate.env:/run/substrate.env:ro postgres:16 \
  sh -c 'set -a; . /run/substrate.env; set +a; psql "$SUBSTRATE_PG_URL" -At -F " " -c "select version, name from schema_migrations order by version"' | diff ~/backups/ledger-expected.txt - && echo "ledger lists every step"
docker run --rm -i -v /etc/substrate/substrate.env:/run/substrate.env:ro postgres:16 \
  sh -c 'set -a; . /run/substrate.env; set +a; psql "$SUBSTRATE_PG_URL" -At -F " "' < ~/backups/counts.sql > ~/backups/counts-prod-after.txt
diff ~/backups/counts-prod-before.txt ~/backups/counts-prod-after.txt && echo "row counts unchanged"
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7410/healthz
```

Expect `N|N`, no output from either `diff`, and `200`. The ledger's growth is the one expected change in `schema_migrations`: from the count you noted in step 5 (or no table at all) to `N`, one row per step that production had not applied yet, each by name in the listing. A table or column a new step adds may legitimately appear in the counts or the schema; a changed row count in an existing data table is not expected from a migration and means stop and investigate. Check the new objects by name, for example `\d <table>` in `psql`, against the step you read in `index-store.ts`. If `/healthz` needs a bearer, use the token file the deploy health check uses (`infra/vps/README.md`); do not paste a token on a command line.

## Backing out

Rollback is code only (`docs/runbooks/rollback-compat.md`): it never drops what a step created, and an older release ignores objects it does not know. To remove an object a step created, an operator reads that step's `down` (steps from version 33 declare one) and runs it by hand in a transaction. Its `schema_migrations` row stays, so `migrate()` will not recreate the object; delete that row too only if you want the next `migrate()` to run the step again. Restoring the backup from step 5 is the last resort and loses every write since it was taken.

## What this does not prove

- The rehearsal copy is a snapshot: a step that is safe on the copy can still wait on a lock on a busy production table. `migrate()` sets `lock_timeout` and `statement_timeout` for that case and fails the step instead of hanging the service.
- Nothing here exercises Timescale features, because the index uses none. A step that adds a hypertable, compression or retention policy needs its own rehearsal on the Timescale image, and an operator's explicit approval.
- The row counts compare existing tables only; they say nothing about the contents of a table a step adds.
