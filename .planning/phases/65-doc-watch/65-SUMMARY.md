---
phase: 65-doc-watch
milestone: v1.7
requirements: [WATCH-01, WATCH-02, WATCH-03, WATCH-04, WATCH-05]
status: merged to main in PR #186 (squash aa19c926); PARTIAL in delivery: the watcher, the sweep timer, the hook installer and the reconcile are staged or opt-in, and no host has them installed; no live sync and no production ingest were run
---

# 65-SUMMARY: Doc Watch, four triggers into one idempotent sync

Built and merged as one squash commit. Decisions are in [65-CONTEXT.md](65-CONTEXT.md); the verification record is [65-VERIFICATION.md](65-VERIFICATION.md). Operator pages: [docs/corpus-watch.md](../../../docs/corpus-watch.md) and [docs/runbooks/corpus-sync.md](../../../docs/runbooks/corpus-sync.md). Paths are at commit aa19c926 and were read with `git show`; nothing was run.

## What was built

- **Coalescing and the watcher, `packages/corpus`.** `src/coalesce.ts` (`Coalescer`: trailing debounce, maximum wait, one running sync per repository, 4,096 tracked repositories before further signals fold into the sweep key `*`). `src/watch.ts` (`createWatcher`: one directory watch per target, capped by `SUBSTRATE_CORPUS_WATCH_MAX`; a change event only marks a repository dirty; `ENOSPC` or `EMFILE` closes every watch and sets `degraded: "inotify-limit"`).
- **The hint spool, `packages/corpus/src/hints.ts`.** `writeHint` writes `{v, dir, at}` to a temporary dot file and renames it, under a lock file inside the spool; at most 1,000 files of 4 KiB. `readHints` removes what it reads and returns distinct directories.
- **The mirror and the view, `packages/corpus/src/mirror.ts` and `view.ts`.** `ensureMirror` keeps a Substrate-managed bare, blobless mirror per origin (`git clone --mirror --filter=blob:none` once, then `git fetch --prune` with the mirror as working directory). The only command run in a user's checkout is `git remote get-url origin`. `buildView` reads the mirror's default-branch tree and lays the checkout's documentation changes over it path by path, with `GIT_OPTIONAL_LOCKS=0` and the mirror's objects as alternates.
- **The CLI, `packages/cli/src/corpus`.** `watch-settings.ts` (the six `SUBSTRATE_CORPUS_*` doc watch flags, read only here); `sync.ts` (`runSync`, the one code path every trigger calls; a per-repository lock file under the mirror directory, held across scan, plan and send; plans partitioned to the server's bounds); `watch-loop.ts` (`runWatchLoop`: watch events, hints and the sweep timer feed one coalescer); `watch-commands.ts` (`sync`, `watch`, `reconcile`, `hint`, `hook`; SIGTERM and SIGINT stop after the sync in flight); `events.ts` (the `docs.sync` note, posted to `POST /events`, never rejects); `render-sync.ts`; `index.ts` wiring and `--sweep-s` range check.
- **Hook installer, `packages/collectors/src/install-git-hook.ts`.** `installCorpusHooks` writes a marked block into `post-merge`, `post-checkout` and `post-rewrite`. It refuses a foreign hook and a damaged marker pair. The block runs `corpus hint` in the background under `timeout 10` and exits 0. `uninstallCorpusHooks` removes only the block.
- **Server, `packages/mcp-server`.**
  - Migration step 39 `planning_page_hashes` in `src/index-store.ts`: `phase: "expand"`, no `optIn`, `down` drops the table, primary key `(destination, path)`. Digest in `src/index-store.migrations.digests.json`. `PLANNING_HASH_TABLE_REPAIR`, an unledgered statement that `migrate()` runs after the steps.
  - `src/planning-hash-store.ts`: the port, an in-memory adapter and a Bun SQL adapter. The destination key is the SHA-256 of the docs URL.
  - `src/service.ts`: `planningHashStore()`, `loadPlanningHashes()` and `savePlanningHashes()` wired into `runPlanningRefresh`; `corpusFreshness()` feeds a `corpus` row to the `docs.freshness` lag pass.
  - `src/corpus/reconcile.ts` (`diffPlane`, `reconcileCorpus`): missing rows and orphan `corpus:` documents; at most 500 repairs per run; an 8 s lookup budget; a 100,000-row read bound. Route `POST /corpus/reconcile` in `src/server.ts`, class `write` in `src/admission.ts`; a dry run is audited as `corpus_status`, `execute` as `corpus_ingest`.
  - `src/corpus/sync-event.ts` (`syncLagSeconds`), read by `src/server.ts` into the gauge `substrate.corpus.sync_lag_seconds` (`packages/observability/src/instruments.ts`), only when the ledger stored the note.
  - `src/event-sources.ts`: rows for `docs.sync` (runtime `corpus-sync`) and for `docs.planning`, which had none. `docs/event-vocabulary.md` lists both.
- **Units, `infra/vps`.** `substrate-corpus-watch.service`, `substrate-corpus-sync.service` (`corpus watch --once`) and `substrate-corpus-sync.timer` (`OnCalendar=*:0/15`, `Persistent=true`). Each sets `Nice=15`, `IOSchedulingClass=idle`, `CPUQuota=25%`, `MemoryMax=512M`, `ProtectSystem=strict`, and writable paths only for the mirror and spool directories. Two sandbox drop-in examples. None is installed.
- **Docs and config.** `docs/corpus-watch.md`, `docs/runbooks/corpus-sync.md`, `docs/corpus.md`, `docs/config-reference.md`, `docs/runbooks/rollback-compat.md`, `.env.example`.

## The four triggers

| Trigger | `trigger` value | What it notices | How it is enabled | Writes into a repository |
| --- | --- | --- | --- | --- |
| `corpus sync --repo R` | `manual` | the named repository | an operator runs it | no |
| Filesystem watcher (`corpus watch`) | `watch` | an event in a watched directory: a documentation file name, or a name without a dot | the operator, or the staged watch unit | no |
| Git hook (`post-merge`, `post-checkout`, `post-rewrite`) | `hook` | a merge, checkout or rebase that moves documents | `substrate corpus hook install --repo R`, per repository | yes: the hook file in that repository's hooks directory |
| Sweep (`corpus watch`, every `SUBSTRATE_CORPUS_SWEEP_S`; or `watch --once` from the timer) | `sweep` | everything, including a push made elsewhere, because it fetches the mirrors | the staged timer unit, or the watcher's own interval | no (the mirror directory only) |
| Reconcile (`corpus reconcile`) | `reconcile` | the manifest and the docs plane disagreeing | a manual command; no unit runs it | no |

The server's planning refresh is a fifth path, not a CLI trigger. It scans `.planning/` every 15 s (`packages/mcp-server/src/planning/config.ts`) and runs only when `docsBackend` is `lightrag` with a LightRAG config (`service.ts`, `planningEnabled`). It emits `docs.planning`.

## Idempotence

- A sync sends only what the plan marks as add, change, rename or tombstone. A document already recorded at the same sha256 is `unchanged` and is not sent (the manifest rule from the phase 63 record). Test: `packages/cli/src/corpus/sync.test.ts`, "a second sync with nothing changed plans everything unchanged and ingests nothing".
- Coalescing turns a burst of signals into one sync per repository (`coalesce.ts`; `watch-loop.test.ts`).
- Hints are removed when read. A lost hint is recovered by the next sweep.
- A per-repository lock covers scan, plan and send (`sync.ts`, `withRepoLocks`); a waiter gives up after 120 s.
- The planning refresh stores the hash of each page after the batch that sent it succeeded. With `SUBSTRATE_PLANNING_HASH_STORE=on` a restart reloads those hashes; with the flag off the map lives in memory only.

## The docs.sync event

- `createHttpEmitter` posts one `note` to `POST /events` after each execute sync (`events.ts`, `sync.ts` `runSync`). A dry run emits nothing.
- Payload: `action` `docs.sync`, `runtime` `corpus-sync`, `repo` (`*` when several), `trigger`, `outcome`, `lag_s`, `added`, `changed`, `updated`, `tombstoned`, `refused`, `failed`, `duration_ms`.
- The server reads only `lag_s`, bounded to a year, into the gauge `substrate.corpus.sync_lag_seconds`, which has no repository label (`sync-event.ts`, `server.ts`).
- A failed post never fails the sync; the result says so (`events.ts`, `sync.test.ts`).

## Key decisions

- **D65-1, four triggers, held with one change.** Reconcile is a command, not a timer. Nothing in `infra/vps` or `watch-loop.ts` runs `corpus reconcile`. The sweep is the timer, and it is the only scheduled path that fetches.
- **D65-2, changed.** The plan said the planning refresh's in-memory hashes would be replaced by the manifest. The code uses a separate table, `planning_page_hashes` (step 39), keyed by destination. The in-memory map stays as the working set, loaded once per process.
- **D65-3, held.** This PR does not change `POST /docs/merge-trigger` (no hunk for it in `src/server.ts`).
- **D65-4, held.** The mirror and the view as described above (`mirror.ts`, `view.ts`).
- **D65-5, held with one exception.** Default triggers write nothing into a repository, and hooks are an opt-in installer. The exception is that `corpus watch` always executes: it has no dry run, so the watcher writes into the docs plane (`watch-commands.ts`, `runWatchCommand` passes `execute: true`). `docs/corpus-watch.md` states this.
- **D65-6, held.** `docs.sync` maps onto `note` through `payload.action`, with a row in `event-sources.ts` and an entry in `docs/event-vocabulary.md`. `docs.planning` gets its row.

## Deviations from the plan

- **The hint has no action name.** ROADMAP criterion 2 and `docs/runbooks/corpus-sync.md` call it a `docs.changed` hint. The code writes `{v:1, dir, at}` (`hints.ts`, `writeHint`). No `docs.changed` appears in `packages/`, `docs/` or `scripts/` at this commit.
- **The hook set does not include post-commit.** ROADMAP criterion 2 says the hooks sit "beside the existing post-commit collector". `CORPUS_HOOKS` in `install-git-hook.ts` is `post-merge`, `post-checkout`, `post-rewrite`. This record did not check a commit-only path; a commit reaches a sync through the watcher's events or the sweep.
- **Planning state is not in the manifest.** ROADMAP criterion 3 and `docs/corpus-watch.md` ("keeps its state in the manifest and not in memory") do not match the code (see D65-2).
- **Step 39 always runs.** Steps 33, 34 and the steering steps are gated by `optIn` (`index-store.ts`, `MigrationOptIn`); step 39 is not. Its write path is gated by `SUBSTRATE_PLANNING_HASH_STORE`, which defaults to off. `PLANNING_HASH_TABLE_REPAIR` runs on every boot, outside any flag. It drops `planning_page_hashes` when the primary key lacks `destination`. The squash body says this rebuilds a path-only table from an earlier draft.

## Findings

- The squash body lists 12 fix commits after the feature commit. Most concern mirror identity: https, ssh and scp forms, ports, SSH accounts, absolute paths, and reuse of older mirror names (`mirror.ts`, `originIdentity`, `equivalentOrigins`, `legacyMirrorName`). Others concern reconcile bounds, the plan request byte budget (5,000,000 bytes, under the server's 6,000,000-byte cap, `sync.ts`), and the planning hash repair.
- The reconcile dry run also fetches the mirrors: `runReconcileCommand` calls `runSync` with `fetchMirrors: true` and `execute: false`. It writes nothing into a repository, but it does use the network.
- `docs.sync` is not in `RESERVED_NOTE_ACTIONS` (`reserved-actions.ts`), so any authenticated caller can post one and set the lag gauge. `sync-event.ts` says every field is untrusted.
- `POST /corpus/reconcile` with `execute: true` has no operator check. `corpusReconcileReply` checks the surface and the corpus gate only. The same holds for the phase 63 ingest.
- `savePlanningHashes` writes one upsert per page, not one statement per batch (`planning-hash-store.ts`, `bunPlanningHashStore`).

## What remains

Operator-gated, not done:

- installing the git hooks in any repository (`substrate corpus hook install --repo R`);
- copying the three units and an environment file to a host, then `systemctl enable --now` for the timer and the watcher;
- `SUBSTRATE_CORPUS=on` and a LightRAG backend on the server (the sync and the reconcile answer `corpus.disabled` without it);
- `SUBSTRATE_PLANNING_HASH_STORE=on`, and a rehearsal of migration step 39 on a restored dump (`docs/runbooks/rollback-compat.md`);
- a scheduled reconcile. None exists; the runbook asks for a weekly manual dry run;
- the first live sweep and any ingest it drives. The corpus ingest itself is the phase 63 operator step, and the Greptile knowledge-base export is not ingested.

Gaps:

- No live run. Every behaviour is checked against injected clocks, fake watchers and fake servers, and this record did not run any of them.
- A private origin without credentials that `git` can use without a prompt leaves the mirror `stale`, and the view reads the last good copy (`docs/corpus-watch.md`, Troubleshooting).
- The watcher only sees directories it was given. New documentation directories are picked up by the next sweep.
- `planning_page_hashes` is not in the index archive. The migrate contract records the reason as the planning refresh rebuilding it (`index-store.migrate-contract.test.ts`).
- The lag gauge keeps the last value reported by any caller.
