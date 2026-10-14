# Uplift 04 SUMMARY — Sandbox egress allowlist

**Graph:** `ut-mv5r71hp-65f7b012` · **Plan:** `04-PLAN.md` · **Refs:** SPE-10477 · **Date:** 2026-10-13

## What shipped

- **Config** (`sandbox-options.ts`): `SUBSTRATE_SANDBOX_EGRESS` — comma-separated `host:port` entries; unset/blank = **deny-all**. Strict grammar (port 1–65535, sane host); a bad entry is a construction-time refusal naming it, before any docker call.
- **Enforcement** (pure composers in `sandbox-options.ts`, executed in `sandbox-provider.ts`): two docker-genuine mechanisms, chosen per policy —
  - *internal* network: docker-native deny-all (no external route), zero argv; an allowlist under `internal` refuses rather than silently never applying;
  - *published_loopback* (host default): iptables `DOCKER-USER` rules — per-destination ACCEPT pinned to DNS-resolved IPv4, DNS 53 opened only when something is allowed, final `-s <container-ip> -j DROP` — composed pure, executed between create and start via PATH-injectable runner (desktop stub precedent).
- **Fail-closed**: bad entry, internal+allowlist conflict, unresolvable host, missing bridge IP, or failing rule → container removed, one `sandbox.egress` warning, throw; the sandbox never runs wider than its policy. Seed: `seed.ts` declares `SEED_EGRESS` (registry.npmjs.org:443); `withSeedEgress` head-inserts bootstrap accepts above the standing drop and drops them in a `finally` even when the work throws.
- **Crash-orphan cleanup (U2×U1 interaction resolved)**: applied delete-argv lists persist in the sandbox state entry (`egress_cleanup`); every destroy path — provider destroy (both branches), `destroySandbox` (boot reconciliation terminate) — best-effort executes the recorded deletes and clears the field (take-then-execute). A failed delete leaves a NARROWER standing rule (deny), never wider access; re-adopted sandboxes' rules from a previous boot are now cleaned too (in-memory map removed — the persisted entry is the single source of truth).
- **Warning wiring**: `setEgressWarnSink` module sink installed by `main.ts` at boot → `events_emit` warning events (reconciliation idiom); stderr fallback before installation.

## Honest limits (recorded)

- iptables path needs root + iptables (substrate-host runs as root); missing/failing iptables refuses the start — no open fallback.
- Destinations pinned to IPv4 resolved at sandbox start; mid-session DNS rotation not tracked (next start re-resolves); AAAA-only names refuse.
- DNS 53 to any resolver stays open on allowlisted policies (the sandbox must resolve); deny-all leaves no DNS channel.
- Insert positions assume an empty `DOCKER-USER`; deletes are spec-matched so teardown stays exact.
- `DOCKER-USER` filters forwarded traffic only; host-root compromise defeats it; cross-sandbox bridge traffic is now dropped (tighter than before).

## Verification (exercised)

- `bun test packages/host` — **281 pass / 0 fail** (parse/refusals, exact argv timelines incl. seed burst open+drop-on-failure, PATH-stub execution, rollback+remove on failed application, cleanup persistence + reconciliation terminate cleans recorded rules, sink routing)
- `bunx tsc --noEmit` clean; full `bun test` 3216 pass / 1 fail (recorded F-01 only)
- Two corrective passes: (1) six definite-assignment/annotation diagnostics in `sandbox-provider.ts`; (2) the warn wiring + crash-orphan rule GC above.

## Deferred / surprises

- The provider is constructed inside the rivet VM factory (`vm.ts`), so warn wiring went through a module sink rather than constructor injection — pinned by test at the mechanism level.
