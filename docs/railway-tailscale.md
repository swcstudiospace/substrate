# Railway over Tailscale

**Revised:** 2026-09-30. How the VPS reaches the Ultrathink and Agent Substrate Railway projects privately, and what gets switched off once it does.

## Why a forwarder per project

Railway private networking is scoped to one project and one environment (`fd12::/16`, `*.railway.internal`); services in different projects cannot see each other, and `*.railway.internal` does not resolve from the VPS. Railway's supported bridge is the **Tailscale Forwarder** template (it replaced the deprecated subnet-router template, which allowed one router per tailnet). One forwarder is deployed into each project's `production` environment; it joins the tailnet under a derived machine name and forwards mapped ports to internal service names.

## Deploy

| Project / env | Machine name (derived) | `CONNECTION_MAPPING_n` |
|---|---|---|
| Ultrathink / production | `ultrathink-production-tailscale-forwarder` | `4000:greptimedb.railway.internal:4000` · `4001:greptimedb.railway.internal:4001` · `4003:greptimedb.railway.internal:4003` · `5432:timescaledb.railway.internal:5432` · `6379:dragonfly.railway.internal:6379` |
| Agent Substrate / production | `agent-substrate-production-tailscale-forwarder` | `8888:hindsight-api.railway.internal:8888` · `9380:ragflow.railway.internal:9380` · `80:ragflow.railway.internal:80` |

Service names above are the expected defaults; confirm each against the project before setting the mapping. Each forwarder gets a volume (machine identity survives redeploys), `TS_AUTHKEY` from a **reusable, tagged** key (`tag:railway-forwarder`), and key expiry disabled in the Tailscale admin console. Services must listen on `::`; Railway database images already do.

## ACL

```jsonc
{
  "tagOwners": { "tag:railway-forwarder": ["autogroup:admin"], "tag:vps": ["autogroup:admin"], "tag:admin": ["autogroup:admin"] },
  "grants": [
    { "src": ["tag:vps", "tag:admin"], "dst": ["tag:railway-forwarder"], "ip": ["tcp:4000-4003", "tcp:5432", "tcp:6379", "tcp:8888", "tcp:9380", "tcp:80"] }
  ]
}
```

`tag:vps` is `187.77.130.10`; `tag:admin` is the operator's Mac mini and XPS. Nothing else on the tailnet reaches the forwarders. The Programming Desk's Grok Bot computers are **not** on the tailnet; they reach the desk gateway over HTTPS and the gateway reaches the forwarders.

## Cutover on the VPS

1. `tailscale status` shows both forwarders online; `tailscale ping` each.
2. Probe each mapped port from the VPS by MagicDNS name (`psql`, `redis-cli`, `curl /health`).
3. Edit `/etc/substrate/substrate.env`: `GREPTIME_URL`, `SUBSTRATE_PG_URL`, `DRAGONFLY_URL`, `HINDSIGHT_URL`, `RAGFLOW_URL` to forwarder names (`.env.example` shows the shapes). Restart `substrate-mcp`; verify `POST /brief` and `events_emit`.
4. Only then remove public exposure in Railway: the TimescaleDB TCP proxy and the GreptimeDB public domain. `hindsight-ui` keeps a Railway domain behind its access key only if browser access without the tailnet is wanted. This is an access change (Programming Desk G-6): record who approved it and when.
5. Retire the pre-existing `railway-app` tailnet node if it was the old subnet router or an exit node, after step 2 succeeds.

## Rollback

Re-create the TCP proxy / domain in Railway (minutes, no data implication) and revert `substrate.env` from the backup taken in step 3. Forwarders can be deleted without touching the databases.

## Security notes

Traffic on the tailnet hop is WireGuard-encrypted, which closes the Phase 8 concern about the Dragonfly password crossing a public TCP proxy in plaintext. Hindsight and RAGFlow still require their bearer keys; those keys live only in `/etc/substrate/substrate.env`. The forwarder is a Railway service like any other: keep it on the same alerting as the databases and rotate `TS_AUTHKEY` when the tagged key is rotated.
