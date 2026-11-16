# Railway over Tailscale

**Revised:** 2026-09-30. How the VPS reaches the Ultrathink and Agent Substrate Railway projects privately, and what gets switched off once it does.

## Why a forwarder per project

Railway private networking is scoped to one project and one environment. Services in different projects cannot see each other, and that private DNS does not resolve from the VPS. Railway's supported bridge is the **Tailscale Forwarder** template (it replaced the deprecated subnet-router template, which allowed one router per tailnet). One forwarder is deployed into each project's `production` environment; it joins the tailnet under a derived machine name and forwards mapped ports to the project's private service names.

## Deploy

| Project / env | Machine name (derived) | `CONNECTION_MAPPING_n` |
|---|---|---|
| Ultrathink / production | `<ultrathink-forwarder>` | `4000:<greptime>:4000` · `4001:<greptime>:4001` · `4003:<greptime>:4003` · `5432:<timescale>:5432` · `6379:<dragonfly>:6379` |
| Agent Substrate / production | `<agent-substrate-forwarder>` | `8888:<hindsight>:8888` · `80:<lightrag>:9621` (since 2026-10-28, Run 11). LightRAG replaced RAG-backend; there is no fallback that calls the retired plane. |

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

`tag:vps` is the VPS. `tag:admin` is the operator's admin machines. Nothing else on the tailnet reaches the forwarders. The Programming Desk's Grok Bot computers are **not** on the tailnet; they reach the desk gateway over HTTPS and the gateway reaches the forwarders.

## Cutover on the VPS

1. `tailscale status` shows both forwarders online; `tailscale ping` each.
2. Probe each mapped port from the VPS by MagicDNS name (`psql`, `redis-cli`, `curl /health`).
3. Point `GREPTIME_URL`, `SUBSTRATE_PG_URL` and `DRAGONFLY_URL` in `/etc/substrate/substrate.env` at the Ultrathink forwarder placeholders in `.env.example`. Point the gateway's own `HINDSIGHT_URL` and `substrate.env`'s `LIGHTRAG_URL` at the Agent Substrate forwarder. Restart `substrate-mcp`; verify `POST /brief` and `events_emit`. `GET /healthz` reports the cache counters and stays up when Dragonfly does not answer.
4. Only then remove public exposure in Railway: the TimescaleDB TCP proxy and the GreptimeDB public domain. `hindsight-ui` keeps a Railway domain behind its access key only if browser access without the tailnet is wanted. This is an access change (Programming Desk G-6): record who approved it and when.
5. Retire the pre-existing `railway-app` tailnet node if it was the old subnet router or an exit node, after step 2 succeeds.

The forwarders are reached from the VPS only through entries in `SUBSTRATE_DB_PROXY_ALLOW`, one `host:port` per mapped port in the tables above; a URL whose host and port are not listed is a direct endpoint. Run with `SUBSTRATE_DB_ENDPOINT_POLICY=warn` first (the shadow step): any direct endpoint is reported at boot as a `db.endpoint` event. Setting `SUBSTRATE_DB_ENDPOINT_POLICY=enforce` is the enforce step, after which a configured direct endpoint refuses boot.

## Rollback

Re-create the TCP proxy / domain in Railway (minutes, no data implication) and revert `substrate.env` from the backup taken in step 3. Forwarders can be deleted without touching the databases.

## Security notes

Traffic on the tailnet hop is WireGuard-encrypted, which closes the Phase 8 concern about the Dragonfly password crossing a public TCP proxy in plaintext. Hindsight and LightRAG still require their keys; those keys live in the server and gateway environments, not in a client on an agent. The forwarder is a Railway service like any other: keep it on the same alerting as the databases and rotate `TS_AUTHKEY` when the tagged key is rotated.
