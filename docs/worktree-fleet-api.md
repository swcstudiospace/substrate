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
| `SUBSTRATE_WORKTREE_ROOTS` | none | the CLI, the collector, the fleet package, the doctor, the dispatcher | colon-separated absolute directories that hold worktrees. Unset: the CLI and the doctor assume no location; the collector's graph attribution falls back to `/var/lib/substrate/worktrees`; the dispatcher reads it too and creates each graph's worktree under its first entry, which is `/var/lib/substrate/worktrees` when unset |
| `SUBSTRATE_WORKTREE_MIN_FREE_GB` | `5` | the CLI, the fleet package, the dispatcher | the free-disk floor for creating a worktree |
| `SUBSTRATE_WORKTREE_IDLE_DAYS` | `14` | the server, the CLI, the fleet package | how long a worktree must be untouched before prune may call it safe, and when a listing calls it `stale` |
| `SUBSTRATE_SESSION_ID` | none | the CLI, the fleet package | the session `substrate worktree scan --report` attributes the worktree holding the current directory to when `--session ID` is absent (the flag wins; a value that is not a session id is a usage error) |

## Turning it on

1. Set `SUBSTRATE_WORKTREE_REGISTRY=on` on the server (it needs `SUBSTRATE_PG_URL`; the table is created at boot by `migrate()`).
2. Give each reporter a token for its surface. A reporter without one is refused.
3. Run the reporter; `GET /worktrees?host=<host>` shows what it sent.

To turn it off set the variable back to `off`: the routes answer 503 again and the rows stay, unread, until the next time it is on or an operator drops the table.

## Repository scope (phase 72)

Two JSON variables decide which repositories a surface may address, and where each repository lives on this host. Both are read once at boot; a malformed value refuses the boot, so a scope that cannot be read never defaults to open.

- `SUBSTRATE_REPO_REGISTRY`: `{"owner/name": {"checkouts": ["/abs"], "worktrees": ["/abs"]}}`. A path is placed in a repository only by this table. Two repositories may not share or nest a directory.
- `SUBSTRATE_REPO_SCOPES`: `{"<surface>": ["owner/name"]}`. Unset means scoping is off and every caller may address every repository, as before, unless `SUBSTRATE_REPO_REGISTRY` is set: then the server refuses to start. Set, a surface missing from the object, and every anonymous caller, is granted nothing.

What is refused, and before what:

- `POST /drift` and `drift_scan` refuse a repository outside the grant, or a path that does not resolve (through symlinks and `..`) into a registered directory of the named repository. The refusal runs no git and reads no trail.
- `GET /worktrees` and `worktree_list` filter in the store to the granted repositories; naming another repository is a 403.
- `GET /corpus/proof`, `POST /corpus/plan`, `POST /corpus/ingest` refuse a repository outside the grant before any manifest or plane read. `GET /corpus/status` and `POST /corpus/reconcile` read every repository at once, so they are refused to a scoped surface.
- A live session issued or changed for an ungranted repository answers the same `not-found` an unknown session does.
- `substrate worktree` runs as surface `claude-code` and reads the same two variables. Every root must lie in a registered directory of a granted repository, and `--repo`, `provision`, `merge-back` and `guard` paths must too. A refusal exits 2 before any git call.
- `substrate corpus` (`scan`, `plan`, `ingest`, `eval`, `reflect`, `sync`, `watch`, `reconcile`, `hook install|uninstall|status`) refuses a `--root`, a `--repo` directory or a named `--repo` that the registry does not place, before any git call or hook write. A refusal exits 2 naming the repository or path. `--root` values come from `--root`, `SUBSTRATE_CORPUS_ROOTS` or the default root. Unset, `SUBSTRATE_REPO_REGISTRY` leaves the corpus CLI as it was. `corpus hint` writes a spool file and runs no git, so it is not gated. With `SUBSTRATE_REPO_REGISTRY` set, the server refuses to start unless `SUBSTRATE_REPO_SCOPES` is set; this CLI does not refuse, and with the scopes variable unset it reads no grant. The top-level CLI reads cwd git (for `brief`, `emit` and `drift` without `--path`) only inside a registered checkout when the registry is set; otherwise it reads no git and sends no repository from cwd.
- `packages/collectors/src/install-git-hook.ts` (the post-commit collector installer, run as a script) is gated when a registry is set. With `SUBSTRATE_REPO_REGISTRY` set, `install`, `uninstall` and `status` refuse an unregistered repository before any git call, and refuse a hooks directory outside the repository (commits `27778dee`, `0504e77c`). `5d` is closed (`a28ecac8`): a linked worktree's shared hooks need its primary checkout registered, and are refused otherwise. `6b` is closed for the decision-6 cases (`a28ecac8`): a nested checkout under a registered checkout with its own `.git`, or under a registered worktrees directory, is refused by name, and no git runs in it. `6c` is closed by the strict rule (owner decision 2026-11-03): any nested `.git` under a registered root is refused, and each repository, including each linked worktree, must be named by the registry. The server refuses to start when `SUBSTRATE_REPO_REGISTRY` is set without `SUBSTRATE_REPO_SCOPES`; this installer does not refuse that state and accepts a registry without the scopes variable. The identifier clause (`POST /drift`, `substrate drift --path`, `--root`) is gated only when `SUBSTRATE_REPO_SCOPES` is set.

A refusal is recorded as a `repo.scope-refused` ledger warning with the route, the reason code and a 16-hex digest of what was asked for; the requested path or repository is never written. An anonymous refusal is recorded by the route audit. The corpus root and anchor are not gated: they are digests over every repository and reveal no document content.

The scoped credential is the surface bearer plus its grant. No per-repository secret exists; that is a recorded open decision.
