# Hindsight and cache proof runbook (Phase 26)

How the planes are reached, what the operator approves live, and how each
gated step is proven and rolled back. Rehearsal proves everything provable;
G1–G4 run only in an operator-approved window, in order, with the proof read
and rollback named below.

## Reach: the Tailscale forwarder hop

Railway private networking is scoped to one project and environment, so each
project's `production` environment runs a Tailscale Forwarder that joins the
tailnet and forwards mapped ports to private service names
(`docs/railway-tailscale.md`). The Agent Substrate forwarder maps
`8888` to Hindsight and `80` to LightRAG (see `docs/data-planes.md`,
"Access path"). Only the VPS and the operator's admin machines reach the
forwarders; the Programming Desk's Grok Bot computers are not on the tailnet
and reach the desk gateway over HTTPS instead.

Bearers travel over the WireGuard-encrypted tailnet hop to the forwarder
(D11). Hindsight and LightRAG keys live only in the server env file for the
substrate's own paths (`planes/hindsight.ts`, `planes/lightrag.ts`) and in
the gateway's own environment for the gateway's paths — never in an agent
config, a repo file, or a prompt. Production `DRAGONFLY_URL` points at a
co-located loopback redis after a measured 180–310 ms tailnet RTT made the
Railway hop unusable (Greptile P1 disposition recorded in Phase 26 context).

## Operator rules for every live step

Phase 20 agent-query rules apply unchanged: agents query status and redacted
shape only, never a value. Name variables, never paste them; check names
against the server env file without reading values into the session. Agents
never edit the server env files, never run the restarts, and never prune the
on-disk `hindsight-api:0.9.1` image. A credential that reaches a log is
rotated, not redacted after the fact.

## Gated live steps (each needs explicit operator approval)

### G1 — first live reachability and version probe

Run unauthenticated `GET` on the deployment's health and version endpoints
(the paths `probeHealth` / `probeVersion` call; host and port come from the
server env file's Hindsight URL). Record the deployed version and check it
against `claude-ultrathink:.planning/research/hindsight-0.9.1-openapi.json`.
Confirm the client keeps its fail-open timeout regardless of version —
Hindsight 0.10.x has a recall hang (`vectorize-io/hindsight#4696`), so the
probe records the version instead of assuming it.

- Proof read: the version response body plus the recorded comparison.
- Rollback: none — read-only.

### G2 — first live bank ensure plus first live recall

Ensure one `sub-<surface>` bank (create-on-404 then pin
`retain_extraction_mode` to `chunks`) and run one recall against it. Confirm
the bank config reads back `chunks` mode and the recall answers in either
known shape.

- Proof read: the bank config read-back plus the recall reply.
- Rollback: delete the bank only if the probe created it and it holds no
  other surface's data (`deleteBank` exists for exactly this).

### G3 — first live retain of a gate-accepted memory

Retain one memory whose write returned `accepted` with `verified_persisted`
and which carries a source, through the forward (never by hand-crafting the
plane call). Confirm the document reads back by its `document_id` with the
accepted text faithful (chunks mode stores it as-is).

- Proof read: the document GET by `document_id` plus the matching
  `memory.retain` silence (success emits nothing) and no `memory.retain.failed`
  warning.
- Rollback: delete the document by its `document_id`.

### G4 — any live cache or topology change, plus the DOCS-07 headless proof

Cache/topology changes (re-pointing `DRAGONFLY_URL`, flipping refusal
behavior) each need approval with the previous URL on hand. The DOCS-07
headless proof then runs: a headless session holding only the substrate MCP
answers a docs question with a source URL that `docs_search` returned and
that event can be read back; an accepted memory retained by one surface is
recalled by another with its source; a second identical brief is a cache hit
and, with Dragonfly down, the same brief returns uncached.

- Proof reads: the cited URL in the session's event; the cross-surface
  recall reply with source-bank attribution; `/healthz` hits before and
  after the second brief; the Dragonfly-down brief equal to the cached one.
- Rollback: previous `DRAGONFLY_URL` plus the `SUBSTRATE_CACHE=0` bypass.

## Rehearsal evidence behind each gate

Every behavior above is proven against the Phase 16 harness plus the fake
banks server without touching a live system: bearer carriage and absence on
probes, bank-in-path, chunks ensure (one GET when already chunks,
404-create-then-PATCH otherwise), retain upsert shape, both recall shapes,
timeout-as-Result, fan-out bound with a single abort budget, slow-bank
degradation to a partial result, derived marking with source attribution,
redacted hits, recall-hit caching with generation invalidation, the
claims-freshness pin, and the plaintext non-loopback refusal with
off-with-reason health. See `26-VALIDATION.md` for the test inventory.
