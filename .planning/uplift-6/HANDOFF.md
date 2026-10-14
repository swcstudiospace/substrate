# Uplift 6 handoff — hash v2, lifecycle report, cache conformance, guarded migrate, index drill, skills CLI, plane chaos

One branch on top of uplift 5 (`6e0dfd4`). Proposal: [PROPOSAL.md](PROPOSAL.md). Every policy flag defaults to today's behaviour or to a report that deletes nothing. No unit, timer, drop-in, or Railway variable is installed by code. Nothing in this series was deployed.

## The seven

| # | Item | What changes after deploy | Switch (default) |
|---|---|---|---|
| U6-1 | Memory hash v2 | New memory writes can store a preimage that includes `hv` 2 and `tenant` `swc`. v1 digests still match. Event hashes are unchanged. | `SUBSTRATE_HASH_VERSION=v1` |
| U6-2 | Lifecycle report | The index sweep, when it already runs, prints ttl-candidate ids and the Hindsight document ids they map to. | `SUBSTRATE_MEMORY_LIFECYCLE=report` (`off` skips the read) |
| U6-3 | Cache conformance | No runtime change. The test pins key classes, Redis commands, and "idempotency mirror stays a target". | none; optional loopback `SUBSTRATE_CONFORMANCE_REDIS_URL` |
| U6-4 | Guarded migrate | Boot takes one advisory lock, records `schema_migrations`, and resets session timeouts. | always on |
| U6-5 | Index drill | Opt-in scratch archive and restore inside `gate:boot`. | unset; `SUBSTRATE_GATE_INDEX_DRILL=1` |
| U6-6 | Skills CLI | `substrate skills list` and `substrate skills approve --name N --pr N --decision approve\|decline\|retire`. | none; needs `SUBSTRATE_TOKEN` |
| U6-7 | Plane chaos | Opt-in pause of the rehearsal Postgres only. Ledger freeze is unchanged. | unset; `rehearsal smoke --chaos-planes` or `SUBSTRATE_GATE_CHAOS_PLANES=1` |

## What the operator does next

1. Deploy remains a separate decision. This series does not deploy. When a deploy happens, `migrate()` will create `schema_migrations` on the live index under the advisory lock. It does not rewrite existing tables.
2. Leave `SUBSTRATE_HASH_VERSION` at `v1` until a soak. `v2` does not rewrite old rows; it only changes new memory digests and still recognises v1 ones. Do not expect the ledger chain to carry `tenant`.
3. `SUBSTRATE_MEMORY_LIFECYCLE=report` prints ids on the next sweep. It does not delete Hindsight documents. Set `off` to skip that read.
4. Skills already on the library are still approved with `skills_approve` (MCP, `POST /skills/approve`, or `substrate skills approve`). `substrate skills list --state all` needs an operator token; the default list is approved names.
5. `SUBSTRATE_GATE_INDEX_DRILL=1` and `SUBSTRATE_GATE_CHAOS_PLANES=1` are parent-process flags for a rehearsal, not `--extra-env` keys and not unit environment. The default `bun run gate:boot` does not set them.

## Rollback

Unset `SUBSTRATE_HASH_VERSION` (or set `v1`), set `SUBSTRATE_MEMORY_LIFECYCLE=off`, and do not pass the two gate flags. `schema_migrations` is inert if a later release ignores it; this release does not drop it. Stored v2 digests remain valid under v1 matching. Nothing in this series unlinks a skill or deletes a memory row.
