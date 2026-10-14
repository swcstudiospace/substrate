# Uplift 04 PLAN — Sandbox egress allowlist

**Graph:** `ut-mv5r71hp-65f7b012` · **Proposal:** `.planning/UPLIFT_PROPOSAL.md` §U1 · **Refs:** SPE-10477

## Scope (files)

- `packages/host/src/sandbox-options.ts` — egress policy config parsing (`SUBSTRATE_SANDBOX_EGRESS` allowlist; empty default = deny-all except the seeded minimum)
- `packages/host/src/sandbox-provider.ts` — compose + apply the network policy argv before container/VM start
- `packages/host/src/seed.ts` — only if the seeding path needs the registry/temporary destinations declared
- `packages/host/src/sandbox-options.test.ts`, `sandbox-provider.test.ts` — argv + negative-path tests

## Change

1. Policy model: an explicit allowlist of destinations (`host:port` entries) from `SUBSTRATE_SANDBOX_EGRESS` (comma-separated). Default when unset: deny-all — the operator allowlists what a VM may reach (model route, substrate loopback). A `bootstrap` set (package registries) may be requested by the seeder for the seed phase only, then dropped.
2. Enforcement: compose the Docker network/iptables argv in `sandbox-provider.ts` exactly like the `desktop_run` precedent composes its fixed `docker exec` argv (PATH-injectable binaries in tests, flags pinned). Policy application failure or an unresolvable entry → refuse VM start (fail-closed), one warning event.
3. Keep every decision pure and testable: a pure function turns (policy, seed-mode) → argv; the provider just runs it.

## Acceptance (orchestrator-verified)

- `bun test packages/host` green: exact argv pinned per policy; deny-all default; unresolvable entry refuses start with warning; seed-mode adds bootstrap set then drops it
- `bunx tsc --noEmit` clean; full `bun test` no new failures
