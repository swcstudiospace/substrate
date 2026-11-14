# Worktree registry API (phase 68)

The server keeps one row per git worktree that a host has reported: where it is, which repository and branch, its head, whether it is dirty, how far it is from its base, how big it is, and which session or graph owns it. The CLI and the collectors inspect the checkouts and post what they found; **the server never touches a worktree** (ADR 0005, ADR 0007). The registry answers one question for everyone else: whose worktree is this, and is it safe to leave alone.

The registry is **off by default**. While `SUBSTRATE_WORKTREE_REGISTRY` is anything but `on`, the registry routes and the tool below answer 503 `worktrees.disabled` and nothing is stored or audited. The claims read (below) is the exception: it reads existing graph data, writes nothing and does not depend on the flag.

| Door | What it does | Class | Audit |
| --- | --- | --- | --- |
| `POST /worktrees/report` | Stores one host's inventory | write | `worktree_report`, **fail-closed** |
| `GET /worktrees` | Lists the registry | read | `worktree_list`, fail-open |
| MCP tool `worktree_list` | The same listing, same arguments and reply | read | `worktree_list`, fail-open |
| `GET /worktrees/claims` | The unexpired leases of one graph, for the prune guard | read | `graph_get`, fail-open |

The classes are the admission classes of `docs/observability.md`; the audit modes are `packages/audit/src/policy.ts`, described in `docs/mcp-audit.md`. A report the audit chain cannot record is refused (503) and stores nothing; a listing is served whether or not the chain can take its record.

## `POST /worktrees/report`

JSON, `Content-Type: application/json`, at most **1,000,000 bytes**. The caller needs an authenticated surface: an anonymous caller is 401 before the body is read, even on a run that allows untokened callers. A VM guest (`SUBSTRATE_VM_GUEST=1`) is refused 403, like the docs routes.

```json
{
  "protocol": 1,
  "host": "vps-1",
  "reported_at": "2026-10-29T09:00:00Z",
  "worktrees": [
    {
      "path": "/root/src/worktrees/as-r14-fleet",
      "repo": "swcstudiospace/agent-substrate",
      "branch": "gsd/r14-worktree-fleet",
      "head": "0123456789abcdef0123456789abcdef01234567",
      "base": "origin/main",
      "dirty": false,
      "ahead": 2,
      "behind": 0,
      "last_commit_at": "2026-10-28T08:00:00Z",
      "size_bytes": 123456,
      "locked": false,
      "primary": false,
      "pr_state": "open",
      "session_id": "sess-1",
      "graph_id": "graph-1",
      "files": ["docs/worktree-fleet.md", "packages/fleet/src/report.ts"],
      "files_truncated": false
    }
  ]
}
```

Every member is checked; nothing the body carries beyond these members is stored. The first problem found is reported with its index.

| Member | Rule |
| --- | --- |
| `protocol` | exactly `1` |
| `host` | 1 to 128 characters of letters, digits, `.`, `_`, `-`, starting with a letter or digit |
| `reported_at` | ISO 8601 with a time and an offset; the reporter's own clock, kept as `reported_at` and never used for retention |
| `worktrees` | an array of at most **500** entries, no two with the same `path` (an empty array is a valid report) |
| `path` | absolute, at most **1024** characters, no NUL |
| `repo` | `owner/name`, letters, digits, `.`, `_`, `-` |
| `branch`, `base` | a string of 1 to 255 characters with no control character, or `null` (a detached head has no branch; `base` is the ref the reporter compared against) |
| `head` | 40 or 64 hexadecimal characters; stored lowercase |
| `dirty`, `locked`, `primary` | booleans |
| `ahead`, `behind` | an integer from 0 to 2147483647, or `null` when the reporter could not tell |
| `last_commit_at` | ISO 8601 with an offset, or `null` |
| `size_bytes` | a non-negative integer, or `null` when the reporter did not measure |
| `pr_state` | `open`, `merged`, `closed`, `none` or `unknown` |
| `session_id`, `graph_id` | optional; when present a string of 1 to 255 characters with no control character. The CLI sets `session_id` from the server's live claim on the worktree's graph (one holder session) or from `scan --report --session ID` ([worktree-fleet.md](worktree-fleet.md#which-session-a-worktree-belongs-to)). A report that omits `session_id` stores none (NULL): the newest report wins, so a worktree handed to another session never keeps the old attribution |
| `files` | optional: an array of at most **200** repository-relative paths (no leading `/`, 1 to **400** characters, no control character), or `null`. A path that breaks a rule is dropped and the rest of the entry is kept; duplicates collapse and the list is stored sorted. More than 200 entries is refused (`worktrees.invalid`): a reporter sends the first 200 and `files_truncated: true`. **Absent** means the reporter did not say (an older CLI) and **`null`** means it tried and could not list the files (no merge base, a failed git command); both are stored as unknown, and neither is the same as `[]`, which says the worktree touches nothing. The newest report wins: a report without `files` clears what an earlier one stored |
| `files_truncated` | optional boolean, default `false`; true when the reporter cut the list at 200. Ignored (stored `false`) when `files` is absent or `null` |

The nullable members must be present (as `null`) rather than left out.

`files` feeds the `worktrees` section of `memory_brief` (see [live-steering.md](live-steering.md)). `GET /worktrees` and `worktree_list` do not return it: a listing of 500 rows would carry up to 100,000 paths. The report's body cap (1,000,000 bytes) is unchanged: one worktree at its largest (200 paths of 400 characters) is under 250 KB encoded, so it always fits a report of its own, and the CLI packs rows into bodies by encoded size.

**Reply, 200:** `{"stored": n, "removed": m}`: `n` is the number of worktrees upserted (the report's length) and `m` the number of rows the retention sweep deleted.

| Status | `error` | When |
| --- | --- | --- |
| 400 | `worktrees.invalid` (with `problem`) | a member fails its rule |
| 400 | `request body is not valid JSON` | the body does not parse |
| 401 | | no authenticated surface (anonymous, or an unknown bearer) |
| 403 | `worktrees.vm-guest` | the server runs as a VM guest |
| 413 | `request body too large` | more than 1,000,000 bytes |
| 415 | | not `application/json` |
| 503 | `worktrees.disabled` | `SUBSTRATE_WORKTREE_REGISTRY` is not `on` |
| 503 | `worktrees.unavailable` (with `problem`) | no index is configured, or the store failed |
| 503 | | the audit chain could not record the report |

An accepted report is one transaction: the worktrees it lists are upserted by `(host, path)` (their `first_seen_at` is kept, `last_seen_at` is the server's clock now), then the retention sweep below runs. It then leaves one ledger `note` with `payload.action: "worktrees.report"` carrying only `stored` and `removed`, from the caller's surface, in the session `worktrees:<host>` (`docs/event-vocabulary.md`). The note is best effort: the report is already stored when it is written.

## `GET /worktrees` and `worktree_list`

| Argument | Meaning |
| --- | --- |
| `repo` | `owner/name`; only that repository's worktrees |
| `host` | only that host's worktrees |
| `state` | `all` (the default); `dirty` keeps `dirty` worktrees; `stale` keeps worktrees whose `last_commit_at` is known and older than `SUBSTRATE_WORKTREE_IDLE_DAYS` |
| `limit` | 1 to 500, default 100 |

An argument that is present and invalid is refused (400 `worktrees.invalid`, or a tool error), never ignored. The reply is `{ "worktrees": [...], "truncated": <more rows exist> }`, newest `last_seen_at` first and then host and path. Each row has the report's members plus `host`, `first_seen_at` and `last_seen_at`; `session_id` and `graph_id` are left out when the reporter sent none. The listing is open to an anonymous caller on a run that allows one, like the other reads. It answers the 503 rows of the table above while the registry is off or has no index.

## `GET /worktrees/claims?graph_id=<id>`

The question `substrate worktree prune` asks before it removes a checkout that belongs to a graph: does a session hold a live claim there? A session that reuses an old, clean, merged checkout holds a lease without changing a file, so only the server can say so. The route reads the graph through the index (the read behind the `graph_get` tool) and judges each node's lease the way every other lease reader does; it is audited under `graph_get` (fail-open, class `read`). It is **not** behind `SUBSTRATE_WORKTREE_REGISTRY`: it reads existing graph data and writes nothing.

The caller needs an authenticated surface (an anonymous caller is 401, even on a run that allows untokened callers). `graph_id` is required and must be 1 to 128 characters of letters, digits, dot, underscore or hyphen, starting with a letter or digit (400 `worktrees.invalid` otherwise).

```json
{ "graph_id": "ut-mu1-abcd1234", "claims": [ { "node_id": "n1", "holder": { "surface": "hermes", "session_id": "..." }, "expires_at": "2026-10-29T13:00:00.000Z" } ] }
```

Only unexpired leases are listed, by node id; a free, released or lapsed node is not a claim, and a graph the index does not know has an empty list. The fencing `lease_id` is never returned. A server with no index (`SUBSTRATE_PG_URL`) or an index that did not answer is **503 `claims.unavailable`** and never an empty list: the caller deletes a directory on "no claims", so "no answer" must not look like it. The CLI treats every failure as `claims-unverified` (`review`), never as safe.

## Retention

A row is a report's last word about one worktree, not a history. Each accepted report deletes **its own host's** rows whose `last_seen_at` is older than `SUBSTRATE_WORKTREE_REGISTRY_TTL_S` (default 1,209,600 seconds, 14 days), judged at report time by the server's clock. Two consequences:

- A report does not claim to be complete. A worktree the report leaves out stays until it has gone unreported for the whole window, so one run that missed a checkout does not erase it.
- A worktree that is listed again is refreshed, never deleted, however old its previous sighting was.
- Another host's report never touches this host's rows. A host that stops reporting keeps its rows until it reports again; `last_seen_at` says how old they are. An operator removes a retired host's rows with `delete from worktrees where host = '<host>'` on the index.

The table is created by migration step `worktrees` (additive, `expand`; see `docs/runbooks/rollback-compat.md`) and is not part of the index archive: each host's next report rebuilds it.

## Flags

All six are read by TypeScript; the dispatcher also reads `SUBSTRATE_WORKTREE_ROOTS` and `SUBSTRATE_WORKTREE_MIN_FREE_GB` in Python. `docs/config-reference.md` lists them with the other flags.

| Variable | Default | Read by | Meaning |
| --- | --- | --- | --- |
| `SUBSTRATE_WORKTREE_REGISTRY` | `off` | the server | `on` enables the routes and the tool |
| `SUBSTRATE_WORKTREE_REGISTRY_TTL_S` | `1209600` | the server | the retention window, 60 to 31,536,000 seconds |
| `SUBSTRATE_WORKTREE_ROOTS` | none | the CLI, the collector, the fleet package, the doctor, the dispatcher | colon-separated absolute directories that hold worktrees. Unset: the CLI and the doctor assume no location; the collector's graph attribution falls back to `/var/lib/substrate/worktrees`; the dispatcher creates worktrees under the first absolute entry, else under `/var/lib/substrate/worktrees` |
| `SUBSTRATE_WORKTREE_MIN_FREE_GB` | `5` | the CLI, the fleet package, the dispatcher | the free-disk floor for creating a worktree |
| `SUBSTRATE_WORKTREE_IDLE_DAYS` | `14` | the server, the CLI, the fleet package | how long a worktree must be untouched before prune may call it safe, and when a listing calls it `stale` |
| `SUBSTRATE_SESSION_ID` | none | the CLI, the fleet package | the session `substrate worktree scan --report` attributes the worktree holding the current directory to when `--session ID` is absent (the flag wins; a value that is not a session id is a usage error) |

## Turning it on

1. Set `SUBSTRATE_WORKTREE_REGISTRY=on` on the server (it needs `SUBSTRATE_PG_URL`; the table is created at boot by `migrate()`).
2. Give each reporter a token for its surface. A reporter without one is refused.
3. Run the reporter; `GET /worktrees?host=<host>` shows what it sent.
4. Schedule the reporter with a host timer: `bun scripts/worktree-report.ts` ([the scheduled report](worktree-fleet.md#the-scheduled-report)). It reads `GET /worktrees` before it posts, so it keeps the sessions the registry holds.

To turn it off set the variable back to `off`: the routes answer 503 again and the rows stay, unread, until the next time it is on or an operator drops the table.

## Repository scope (phase 72)

Two JSON variables decide which repositories a surface may address, and where each repository lives on this host. Both are read once at boot; a malformed value refuses the boot, so a scope that cannot be read never defaults to open.

- `SUBSTRATE_REPO_REGISTRY`: `{"owner/name": {"checkouts": ["/abs"], "worktrees": ["/abs"]}}`. A path is placed in a repository only by this table. Two repositories may not share or nest a directory.
- `SUBSTRATE_REPO_SCOPES`: `{"<surface>": ["owner/name"]}`. Unset means scoping is off and every caller may address every repository, as before. Set, a surface missing from the object, and every anonymous caller, is granted nothing.
- `SUBSTRATE_REPO_ALLOWLIST`: `{"<session id>": {"owner/name": "<CREDENTIAL_ENV>"}}`. The session id is the caller's surface name. Each repository is canonical lowercase `owner/name`, and each value is the name of the environment variable that holds that repository's credential (`[A-Za-z_][A-Za-z0-9_]*`). A session addresses only the repositories in its own entry; an unknown and a disallowed repository are refused alike, and the refusal names neither. Unset or blank: no session is granted any repository, so every session-scoped git operation is refused before any spawn. A malformed value (not a JSON object, an empty session id, a non-canonical repository, or an invalid variable name) grants nothing and fails each operation; it does not refuse the boot. The variable is read from the process environment each time an operation runs. When git runs for an admitted repository, the executor passes that repository's credential to the runner as `SUBSTRATE_REPO_CREDENTIAL`; an unset credential variable passes nothing, and one repository's grant cannot resolve another repository's credential.

What is refused, and before what:

- `POST /drift` and `drift_scan` refuse a repository outside the grant, or a path that does not resolve (through symlinks and `..`) into a registered directory of the named repository. The refusal runs no git and reads no trail.
- `GET /worktrees` and `worktree_list` filter in the store to the granted repositories; naming another repository is a 403.
- `GET /corpus/proof`, `POST /corpus/plan`, `POST /corpus/ingest` refuse a repository outside the grant before any manifest or plane read. `GET /corpus/status` and `POST /corpus/reconcile` read every repository at once, so they are refused to a scoped surface.
- A live session issued or changed for an ungranted repository answers the same `not-found` an unknown session does.
- `substrate worktree` runs as surface `claude-code` and reads the same two variables. Every root must lie in a registered directory of a granted repository, and `--repo`, `provision`, `merge-back` and `guard` paths must too. A refusal exits 2 before any git call.

A refusal is recorded as a `repo.scope-refused` ledger warning with the route, the reason code and a 16-hex digest of what was asked for; the requested path or repository is never written. An anonymous refusal is recorded by the route audit. The corpus root and anchor are not gated: they are digests over every repository and reveal no document content.

`SUBSTRATE_REPO_SCOPES` carries no secret. The scoped credential is the surface bearer plus its grant. A repository's git credential is named only by `SUBSTRATE_REPO_ALLOWLIST` (above), which names the environment variable that holds it.

## Cross-repository operations (phase 74)

`packages/mcp-server/src/cross-repo-ops.ts` runs one cross-repository write: a branch fan-out. The same branch is created at a named base in each of two to 16 registered repositories, one step per repository. It is exposed as `POST /cross-repo/fanout` and the `cross_repo_fanout` tool, and its stored state is read with `GET /cross-repo/status?key=` and the `cross_repo_status` tool (see [Routes and tools](#routes-and-tools-phase-74)). The module entry points are `runBranchFanout` and `crossRepoStatus`. The steps run through the same phase 72 executor and allowlist session as the rest of this document.

Every step is recorded in Postgres (`cross_repo_operations` and `cross_repo_steps`, migration step 43) before its git effect runs, and its outcome is read back from the repository's ref. Each git call goes through the phase 72 executor, so a repository the surface is not granted, or that is not registered, is refused before any spawn.

- Create is create-only (`update-ref` with a null old value): a branch the operation did not write is never overwritten, and a branch already at the planned commit is refused, not adopted.
- Undo is compare-and-delete at the planned commit: a ref an outside change moved is parked as `ref-moved` and left alone.
- Statuses: `done` (every step applied); `rolled-back` (a step failed and every applied step was undone; terminal); `needs-attention` (a step is parked; a retry re-inspects only the parked and applied steps). `done` is never reported for a partial operation.
- The key is caller-supplied. A retry with the same key and request resumes the stored operation and runs no planning; the same key with a different request is refused (`key-reused`). A new attempt needs a new key.
- Persisted reasons are closed codes (`apply-failed`, `ref-moved`, `undo-failed`, and so on). Git output and paths are never stored.

A status read is refused as not found for a surface that is not granted every repository of the operation, as a live session is.

### Routes and tools (phase 74)

`POST /cross-repo/fanout` and the `cross_repo_fanout` tool take the body `{"key": "...", "branch": "...", "repos": [{"repo": "owner/name", "base": "..."}]}`: two to 16 repositories, each named once. Only `key`, `branch` and `repos` are read; any other field is a 400.

`GET /cross-repo/status?key=<key>` and the `cross_repo_status` tool (argument `key`) read a stored operation. A key is 1 to 128 letters, digits, `.`, `_`, `:` or `-`.

A 200 answers `{"ok": true, "operation": ...}`, and `operation.status` is `done`, `rolled-back` or `needs-attention`. A 200 does not mean `done`: read the status. The operation carries `key`, `fingerprint`, `branch`, `status`, `steps` (each with `index`, `repo`, `base`, `plannedSha`, `state`, `detail`, `updatedAt`), `createdAt` and `updatedAt`. A step `state` is `pending`, `applying`, `applied`, `compensating`, `compensated`, `failed` or `parked`; `detail` is a closed reason or `null`.

Every refusal of the fan-out and status routes answers `{"ok": false, "reason": "<code>", "problem": "<fixed message>"}`. The compensate route answers the same shape, except for its 401 and 403, which are described below. The tools answer any non-200 as an error result.

| Status | Reason | Route | When |
| --- | --- | --- | --- |
| 200 | none | both | the operation was run, resumed or read. |
| 400 | `request-invalid` | both | fan-out: the body is not JSON or not an object, carries a field other than `key`, `branch` or `repos`, or a field is malformed (the key, the branch, the repository count, a repository, or a base). Status: the key is missing or malformed. |
| 403 | `repo-not-granted` | fan-out | a named repository is not granted to the caller's surface, or is not in its `SUBSTRATE_REPO_ALLOWLIST` session. An anonymous caller, a surface with no session, and a malformed allowlist all land here. |
| 404 | `not-found` | status | no operation is stored under the key, or the caller may not see every repository it names. Both answer alike, so a key for an ungranted repository is not revealed. |
| 409 | `key-reused` | fan-out | the key is stored for a different request. A new attempt needs a new key. Nothing runs. |
| 422 | the gate's reason, `branch-invalid` or `base-unresolved` | fan-out | any other refusal: `repo-not-registered`, `path-not-registered`, `all-repos-not-granted` and the like from the surface grant; `branch-invalid` (not a git branch name); `base-unresolved` (the base is not a commit in that repository). Refused before the store is written. |
| 503 | `cross-repo.disabled` | both | no index store: `SUBSTRATE_PG_URL` is not set. Nothing runs. |
| 503 | `error` (the audit reason) | both | the audit sink refused the record; the route is fail-closed and nothing runs. |

### Compensation route (phase 74, operator only)

`POST /cross-repo/compensate` undoes a stored fan-out under its key. It is an operator's decision and a REST route only: no MCP tool is registered for it. It never runs a step forward; it only undoes steps that were applied. The body is `{"key": "..."}`, and any other field is a 400.

The checks run in this order, and the first refusal stops the run:

| Status | Reason | When |
| --- | --- | --- |
| 401 | `{"error": "cross_repo_compensate needs an authenticated surface; nothing was changed"}` | no surface. Refused before the body is read or audited. |
| 403 | `{"error": "cross_repo_compensate needs an operator token; nothing was changed"}` | the caller is not an operator. Refused before the body is read or audited. |
| 400 | `request-invalid` | the body is not valid JSON. Not audited. |
| 503 | `error` (the audit reason) | the audit sink refused the record; `cross_repo_compensate` is fail-closed (`packages/audit/src/policy.ts`). Nothing runs. |
| 503 | `cross-repo.disabled` | no index store: `SUBSTRATE_PG_URL` is not set. Nothing runs. The audit record was already written. |
| 400 | `request-invalid` | the body is not an object, carries a field other than `key`, or `key` is missing or malformed. |
| 403 | `operator-required` | the engine's own operator check. The route refuses the same caller first, so this is not reached through it. |
| 404 | `operation-not-found` | no operation is stored under the key. Nothing runs. |
| 403 | `repo-not-granted` | a repository the stored operation names is not granted to the caller's surface, or is not in its `SUBSTRATE_REPO_ALLOWLIST` session. |
| 422 | the gate's reason | any other gate refusal, such as `repo-not-registered`, `path-not-registered` or `all-repos-not-granted`. |

Every repository the operation names is gated before any git call runs. A refusal from the gate runs no git and changes no ref.

A 200 answers `{"ok": true, "operation": ...}`. The operation's `status` is `rolled-back` (every applied step was undone; terminal) or `needs-attention` (a step was parked and left in place). It is never `done`. A repeat call on a `rolled-back` operation returns it unchanged and makes no git call. A repeat call on a `needs-attention` operation undoes the steps still `applied`, `compensating` or `parked`, again under the key's lock.

A step is parked, not deleted, when the undo cannot prove it wrote the ref: `ref-moved` (the ref is no longer at the planned commit), `undo-failed` (the ref is still at the planned commit after the delete), `undo-unknown` (the ref could not be read), and `apply-unknown` (the step was found mid-create, so it cannot be told apart from one that never ran). Persisted reasons are closed codes, as for the fan-out.


