---
phase: 48-tailscale-proxy
requirements: [SOTA-04]
status: designed on origin/main 4c2c48e; not yet implemented. The forwarder deployment is operator-gated
---

# 48-CONTEXT: Secure proxy layer for the data planes

## Scope (ROADMAP and 7-SOTA plan, item 4)

Goal: Greptime, Dragonfly and Timescale are reached through one secure Tailscale proxy layer with RBAC, audit and pooling.
Acceptance: all DBs accessed via secure proxy; audit events for access.

The acceptance is the bar for this phase. RBAC and pooling in the goal are deferred (D48-f).

## State on origin/main 4c2c48e (scouted)

- Greptime: `GREPTIME_URL` is read at `config.ts`, trimmed, trailing slashes stripped, and nothing else is checked. `GreptimeClient` builds `${url}/v1/sql`.
- Postgres: `SUBSTRATE_PG_URL` is read at `config.ts`, trimmed only. `index-store.ts` opens it with `new SQL(connectionString, …)`, with no TLS or `sslmode` set.
- Dragonfly: `DRAGONFLY_URL` goes through `parseRedisUrl` (`config.ts`), which accepts only a loopback host and otherwise turns the cache off (fail-open, logged as `cache off`). `rediss:` is not checked.
- Neither Greptime nor Postgres has any endpoint rule. No audit event is emitted on connect or query: the plane calls produce metrics only (`callPlane`, `substrate.plane.duration`, `substrate.plane.errors`).
- The documented target (`docs/data-planes.md`, `docs/railway-tailscale.md`) sends Greptime, Timescale and Dragonfly through forwarders on the tailnet. The Dragonfly target URL is a non-loopback host, which the current rule refuses. That is a conflict this phase resolves.
- Lock tests (scouted): `store-lock.test.ts` allows only substrate-mcp to import the Greptime client or read `GREPTIME_*`; `vocabulary-lock.test.ts` closes `EVENT_KINDS` at 12; `event-sources.test.ts` requires every event row to have a sample, a kind, an id prefix and docs in `docs/event-vocabulary.md`; `flag-registry.test.ts` requires one row and one `.env.example` line per env read.

## Decisions

- D48-a. One pure endpoint classifier (`db-endpoints.ts`) decides, for each plane (greptime, postgres, dragonfly), whether the configured endpoint is `loopback` (the local end of a forwarder), `proxy` (host and port listed in `SUBSTRATE_DB_PROXY_ALLOW`, an operator-set list kept out of the repo), or `direct` (anything else, including any URL that does not parse). Its output never contains the URL, the host text or any credential, only the plane and the class.
- D48-b. `SUBSTRATE_DB_ENDPOINT_POLICY` is `warn` (default) or `enforce`. In `warn`, a `direct` endpoint is reported at boot and the service behaves as today. In `enforce`, a `direct` endpoint is a `ConfigError` at boot that names the variable and the plane, never the URL. Shadow first, then enforce.
- D48-c. The Dragonfly rule stays. `parseRedisUrl` accepts a loopback host as today, and additionally a host and port listed in `SUBSTRATE_DB_PROXY_ALLOW`. A refused Dragonfly URL still turns the cache off, fail-open. `rediss:` URLs go through the same classifier.
- D48-d. Audit events. At boot, one audit event per configured plane: kind `note`, action `db.endpoint`, payload `{plane, class, policy}`. The payload has no URL, host or credential. The row is registered in `event-sources.ts` with a sample, and documented in `docs/event-vocabulary.md`. No new event kind.
- D48-e. Per-call access is already metered: every plane call records a duration and an outcome (`substrate.plane.duration`), and that stays the per-call trail. Per-call audit events are not added, because they would flood the ledger. The boot events record the configured access path; the metrics record each access.
- D48-f. RBAC and connection pooling from the goal are out of this phase's acceptance. They are recorded as deferred.
- D48-g. Operator-gated and not run here: the forwarder deployment, the allow list values, the cutover and the live proof. No hostname or tailnet name is written to the repo.
- D48-h. No schema change, no new tool, no new audit class, no new event kind.

## Acceptance mapping

- All DBs accessed via a secure proxy: the classifier and the enforce mode make a direct endpoint a boot refusal, and the target topology is documented as proxy or loopback only (D48-a, D48-b, D48-g).
- Audit events for access: one `db.endpoint` audit event per configured plane at boot, plus the existing per-call plane metrics (D48-d, D48-e).

## Out of scope

- The Tailscale forwarders themselves, their ACL, and the live cutover (operator-gated).
- RBAC and pooling (D48-f).
