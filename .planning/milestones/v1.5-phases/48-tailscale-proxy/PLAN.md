---
phase: 48-tailscale-proxy
requirements: [SOTA-04]
status: planned; U1 first, then U2 and U3 in parallel, then U4
---

# 48-PLAN: Secure proxy layer for the data planes

## Units

### U1 — endpoint classifier (pure)

Files: `packages/mcp-server/src/db-endpoints.ts` (new), `packages/mcp-server/src/db-endpoints.test.ts` (new).

- `export type EndpointClass = "loopback" | "proxy" | "direct"`.
- `export type DbPlane = "greptime" | "postgres" | "dragonfly"`.
- `export function parseProxyAllow(raw: string | undefined): ProxyAllow` — comma-separated `host:port` entries, trimmed, lowercased host, port 1 to 65535. Malformed entries are a thrown error naming `SUBSTRATE_DB_PROXY_ALLOW` and the entry index, never the entry text.
- `export function classifyEndpoint(plane: DbPlane, url: string | undefined, allow: ProxyAllow): EndpointClass` — undefined or empty is `direct`, not configured (callers decide whether a missing endpoint matters). A URL that does not parse is `direct`. A host of `localhost`, `127.x.y.z`, `::1` or `[::1]` is `loopback`. A host and port in `allow` is `proxy`. Anything else is `direct`. The scheme is not used to decide the class.
- Tests: each class; an unparseable URL is direct; a loopback URL is loopback for every plane; an allowlisted host and port is proxy, and the same host on another port is direct; the error text of a malformed allow entry names the variable and not the entry.

Acceptance: the classifier tests pass.

### U2 — policy settings and refusal

Files: `packages/mcp-server/src/config.ts` (the database endpoint settings and `parseRedisUrl` only), `packages/mcp-server/src/flag-registry.ts` (new rows only), `.env.example` (new lines only), `packages/mcp-server/src/config.test.ts` or the existing config test file (find by grepping for `parseRedisUrl`).

- Add `SUBSTRATE_DB_ENDPOINT_POLICY` (`warn` default, `enforce`; any other value is a ConfigError naming it) and `SUBSTRATE_DB_PROXY_ALLOW` (see U1). Expose them on the config object as `dbEndpoints: { policy, allow, classes: Record<DbPlane, EndpointClass> }`, computed from the configured URLs with `classifyEndpoint`.
- In `enforce`, any plane whose class is `direct` while its URL is configured makes `loadConfig` throw a `ConfigError` naming the variable (`GREPTIME_URL`, `SUBSTRATE_PG_URL` or `DRAGONFLY_URL`) and the policy, never the URL.
- `parseRedisUrl` accepts a host and port listed in the allow list, as well as loopback. Its refusal of other hosts stays fail-open (the cache is off), as today.
- Tests: warn mode loads a direct URL and reports it; enforce refuses a direct Greptime URL with a message that names the variable and not the URL; enforce accepts a loopback URL and an allowlisted proxy URL; a Dragonfly URL on an allowlisted host enables the cache; an unknown policy value is refused.
- One flag-registry row per new variable with a doc pointer to `docs/data-planes.md`, and one `NAME=` line per variable in `.env.example`.

Acceptance: the config tests pass; warn mode changes nothing for existing deployments.

### U3 — boot audit events

Files: `packages/mcp-server/src/event-sources.ts` (one new row only), `packages/mcp-server/src/event-sources.test.ts` (only if a sample assertion needs a value), `packages/mcp-server/src/index.ts` (the listen path only: one call at boot), `packages/mcp-server/src/service.ts` (one method `emitDbEndpoints()` that emits one event per configured plane, no other change).

- The row: kind `note`, action `db.endpoint`, runtime `mcp-server`, with a sample whose payload is `{plane, class, policy}` and carries no URL, host or credential.
- `emitDbEndpoints()` runs once at listen, after the service exists, and emits one event per plane that has a configured endpoint. Emit failures are logged and never block boot.
- Documentation of the new event row in `docs/event-vocabulary.md` must match the row exactly (the lock test enforces it).

Acceptance: the event-sources tests pass with the new row; a boot test (or the existing listen test) shows one `db.endpoint` event per configured plane and none for an unconfigured one.

### U4 — documentation and generated reference

Files: `docs/data-planes.md` (the target topology section and a new "Endpoint policy" subsection), `docs/railway-tailscale.md` (only sentences that describe the allow list and the policy; keep the ports, and write no hostnames), `docs/config-reference.md` (regenerated).

- Document warn and enforce, the allow list format, the classes, the boot events, the Dragonfly rule, and that the forwarders and the live cutover are operator-gated. Write no hostname or tailnet name.
- Regenerate the config reference and check it.

Acceptance: `bun run config:reference -- --check` passes; the docs describe exactly what the tests pin.

## Orchestrator gates

- `bunx tsc --noEmit` exit 0.
- Full `bun test` against a phase-48 verification database, plus `bun run check:phase-close` (the event-sources and vocabulary locks run here).
- `bun run config:reference -- --check` exit 0.
- Records under `.planning/phases/48-tailscale-proxy/`.
