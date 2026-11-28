# substrate-link — SPEC

Offline peer-link manager: `pair` / `status` / `unlink` / `list` / `revoke`.

Files:

- `link.sh` — entrypoint (`machine-id`, `pair`, `status`, `list`,
  `unlink`, `revoke`, `--self-test`). Never touches the network.
- `revoke.sh` — permanent deny-list revocation, CLI + sourceable
  (`revoke_peer`, `revoke_code`, `revoke_list`). `link.sh revoke`
  delegates here; it is the single implementation.

## 1. Goals / non-goals

Goals: establish named peer links with short-lived codes, report link
state with zero connectivity, end links (`unlink`) or deny-list them
(`revoke`), with deterministic conflicts and machine-readable output.

Non-goals: transport, authentication beyond the code, key exchange,
central registry, un-revoke. Ports/scopes below are recorded intents the
caller enforces; these scripts open no sockets.

## 2. State

Root: `$SUBSTRATE_LINK_DIR` (default
`${XDG_STATE_HOME:-$HOME/.local/state}/substrate-link`).

- `machine-id` — stable local id, one random UUID written at first run.
- `codes.json` — `[{code, created_at, expires_at, status, peer_hint,
  issued_by, ports, scopes}]`, `status ∈ pending|redeemed|revoked|expired`.
- `links.json` — `[{peer, status, linked_at, machine_id, code, ports,
  scopes, unlinked_at}]`, `status ∈ linked|unlinked|revoked`.
- `revocations.json` — deny-list `[{target, revoked_at, reason, by}]`,
  `target` is `peer:NAME` or `code:XXXX-XXXX`.
- `.lock` — `flock` for all mutations; writes are `jq → tmp → mv`
  (atomic). Corrupt arrays are backed up to `<file>.corrupt.<ts>.bak`,
  never silently dropped.

`SUBSTRATE_LINK_NOW` overrides "now" (epoch) for deterministic tests;
`SUBSTRATE_LINK_TTL` overrides the default code TTL (600 s).

## 3. Stable machine id (no host PII)

`link.sh machine-id` prints the id, generating and persisting it once.
`--regenerate` rotates it. Randomness only: `/proc/sys/kernel/random/uuid`
(or `openssl`/`/dev/urandom` fallback). The scripts never read hostname,
username, MAC, IP, or `/etc/machine-id` — verified by the `--self-test`
no-PII scan. Links bind to this id, so re-pairing after rotation looks
like a new device, which is the point.

## 4. Pairing: short-lived codes with expiry

Issue: `link.sh pair --new [--ttl SECS] [--peer NAME] [--port N]...
[--scope S]...` prints `code=XXXX-XXXX expires_in=Ns` and stores a
`pending` code with `expires_at = now + ttl` (default 600 s).

Redeem: `link.sh pair --code CODE --peer NAME` (peer may be omitted when
the code carries a `--peer` hint). Redeem fails unless the code is
`pending` **and** `now < expires_at`; expiry is swept lazily on every
mutation, and `status` computes pending counts read-only against `now`
without mutating. Redeemed codes flip to `redeemed` and create (or
re-activate) the link row as `linked`.

Code alphabet: unambiguous base32 (`ABCDEFGHJKMNPQRSTUVWXYZ23456789`),
`XXXX-XXXX` shape, uniqueness-checked against the store. Codes are
case-insensitive on input, uppercase at rest.

## 5. Conflict handling

| Situation | Result |
|---|---|
| redeem unknown code | exit 5 `NOT_FOUND` |
| redeem past `expires_at` | exit 4 `EXPIRED`, code → `expired` |
| redeem already-redeemed code | exit 2 `CONFLICT` |
| redeem for already-`linked` peer | exit 2 `CONFLICT`, no duplicate row |
| redeem for revoked peer/code | exit 3 `REVOKED` (deny-list wins) |
| `unlink` peer with no row | exit 5 `NOT_FOUND` |
| `unlink` peer not `linked` | exit 2 `CONFLICT` |
| revoke already-revoked target | exit 2 `CONFLICT` |
| bad flags / peer name | exit 6 usage error |

Exit codes: `0` ok · `2` conflict · `3` revoked · `4` expired ·
`5` not found · `6` usage. Peer names match `[A-Za-z0-9._-]{1,64}`.

## 6. Revocation

`revoke.sh --peer NAME [--reason R]` / `--code CODE [--reason R]`
appends a deny-list entry, flips the matching link row(s) to `revoked`
(with `unlinked_at`) and matching code row(s) to `revoked`. Permanent:
no un-revoke command exists; a later `pair --code … --peer NAME` for a
revoked peer or code fails with exit 3. `revoke.sh --list [--json]`
shows the deny-list. `unlink` is the non-permanent counterpart: it flips
`linked → unlinked` and re-pair is allowed (use `revoke` to deny).

## 7. Offline / disconnected standalone status

`status` and `list` are pure local reads — valid on a disconnected host,
in a fresh shell, with no daemons running:

- `link.sh status` — `machine-id`, `mode: standalone (offline, no
  network)`, counts (`linked`, `pending-codes`, `revocations`,
  `peers-total`), then one line per known peer.
- `link.sh status --peer NAME [--json]` — that peer's row
  (`status=linked|unlinked|revoked|unknown`), deny-list flag, ports,
  scopes. Unknown peers report `status=unknown`, never an error.
- `link.sh list [--json] [--all]` — active (`linked`) rows by default,
  full history with `--all`.

## 8. Ports

A link declares which local ports the peer session may reach, recorded
at issue (`--port N`, repeatable) and redeem time and shown by
`status`/`list`. Default: none. The substrate-mcp loopback port is
`7410`; a typical pairing allows `--port 7410` only. These scripts
enforce nothing — the caller (host firewall / proxy allowlist) reads the
recorded set and enforces it. Undeclared ports are implicitly denied.

## 9. Data shared

A link declares data scopes, recorded at issue (`--scope S`, repeatable,
default `brief`) and shown by `status`/`list`:

- `brief` — session briefing (graph nodes, leases, recent events).
- `events` — append/query windows on the event ledger.
- `memory` — governed memory recall at an explicit scope.
- `skills` — skills library / projector outputs.

Scopes are advisory intents: the serving side maps each scope to the MCP
tools it will proxy for that peer and refuses everything else. Revoking
or unlinking a peer must also stop serving all its scopes.

## 10. Revoke runbook

1. Compromise / device loss: `revoke.sh --peer NAME --reason lost-device`
   (or `link.sh revoke --peer NAME …`). Verify with
   `link.sh status --peer NAME` → `status=revoked`.
2. Leaked code: `revoke.sh --code XXXX-XXXX --reason leaked` before its
   `expires_at`; even unrevoked, codes die at expiry.
3. Routine offboard: prefer `link.sh unlink --peer NAME` (re-pair
   allowed); escalate to `revoke` only to deny future pairing.
4. Audit: `revoke.sh --list` is the deny-list of record; `link.sh list
   --all --json` is link history. Both are plain JSON under
   `$SUBSTRATE_LINK_DIR` — back them up with the host.

## 11. Examples

```sh
link.sh machine-id
link.sh pair --new --peer field-laptop --ttl 300 --port 7410 --scope brief
# → code=7Q2X-9M4K expires_in=300s   (read out of band)
link.sh pair --code 7Q2X-9M4K --peer field-laptop
link.sh status --peer field-laptop
link.sh list
link.sh unlink --peer field-laptop
link.sh revoke --peer field-laptop --reason offboarded
link.sh --self-test   # temp-dir run: id stability, issue/redeem,
                      # conflict, expiry, revoke, unlink, offline status
```
