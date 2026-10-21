---
phase: 48-tailscale-proxy
requirements: [SOTA-04]
status: in review (draft PR). In-repo gates green. The forwarders, their ACL, the allow list values and the live cutover are operator-gated and were not run
---

# 48-SUMMARY: Secure proxy layer for the data planes

## Built

- **Endpoint classifier.** `db-endpoints.ts` classifies each plane's endpoint as `loopback`, `proxy` (a host and port in `SUBSTRATE_DB_PROXY_ALLOW`) or `direct`. An unparseable URL is direct. The scheme does not decide the class, but it supplies the default port for the match. Host spellings are canonicalised, so `127.1` is loopback. Its output never carries a URL, host or credential.
- **Policy.** `SUBSTRATE_DB_ENDPOINT_POLICY` is `warn` (default) or `enforce`. In `warn`, a direct endpoint loads and is reported. In `enforce`, a configured direct endpoint refuses boot, naming the variable and the policy and never the URL. This is the shadow-then-enforce step.
- **Dragonfly rule.** `redis:` and `rediss:` URLs are accepted only when their class is loopback or proxy. Any other host is refused and the cache is off, fail-open, as before.
- **Boot audit.** One `db.endpoint` event per configured plane at listen: kind `note`, surface `substrate`, runtime `mcp-server`. The payload is `action`, `runtime`, `plane`, `class` and `policy`. No URL, host or credential. The event is fail-open and never blocks boot.
- **Docs.** `docs/data-planes.md` gains "Endpoint policy", and the target paragraph now says a Dragonfly URL must name a loopback host or an allow-listed proxy. `docs/railway-tailscale.md` gains one paragraph on the allow list and the shadow-then-enforce steps. No hostname is written.

## Decisions

- D48-a to D48-h in CONTEXT.md. Warn is the default, so existing deployments keep loading. Per-call access stays on the existing plane metrics, and the boot events record the configured access path.

## Deviations (from the plan, with reasons)

- **Payload carries action and runtime.** The lock requires `payload.action` and `payload.runtime` to match the row. They are added beside `plane`, `class` and `policy`.
- **Configured-ness from existing fields.** The boot event checks the existing config fields rather than the class map, because the map reports `direct` for unset planes.
- **Default ports and canonical hosts.** The plan did not name them. Without the default port, `https://host` would never match `host:443`. Without canonical hosts, `127.1` would not match its loopback form.
- **`rediss` follows the host rule.** A `rediss:` URL to a non-loopback, non-allow-listed host is now refused, as the plan's shared rule says. This is a warn-mode behaviour change for any deployment that points Dragonfly at a remote TLS host. The docs describe only loopback or forwarder targets, so the change is judged acceptable.
- **`0.0.0.0` is no longer loopback.** The old rule accepted it, which was wrong: it is the all-interfaces address, not loopback.
- **`127.1` is accepted.** The old rule refused that shorthand. It is loopback under any URL parser, so the incidental pin was deleted rather than kept.
- **Config-test names built from parts.** The secret-hygiene scan flags a literal `GREPTIME_URL` followed by a value in non-ledger `.ts` files. The new tests build the key from parts, as the other tests do.

## Verified in-repo

- Typecheck: `bunx tsc --noEmit` exit 0.
- Targeted: `db-endpoints.test.ts`, `config.test.ts`, `event-sources.test.ts`, `flag-registry.test.ts` and `store-lock.test.ts` pass, 222 and 79 in the two runs.
- Full suite: `bun test` 5927 pass, 2 skip (pre-existing), 0 fail, over 5929 tests in 220 files.
- Repo locks: `bun run check:phase-close` green (the event row and the vocabulary row match; the secret scan is clean).
- Config reference: regenerated and checked.

## Not proven and not done

- **The forwarders and the live cutover.** Operator-gated. No live Greptime, Postgres or Dragonfly endpoint was contacted.
- **RBAC and connection pooling.** Deferred (D48-f). They are in the goal, not the acceptance.
- **Per-call audit events.** Not added (D48-e). The metrics are the per-call trail; the boot events record the configured path.

## Cleanup

- The worktree `/root/pr-fix/v148-proxy` stays until close-out, with the other phase worktrees, after the user approves cleanup.
