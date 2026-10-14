# Env notes — slice U5-1b (boot-and-prove release gate)

## `.env.example` lines to add

None. The gate reads no server setting from the environment and adds no server flag.

What it does read, and what it sets:

- It forwards only (to the harness and the proofs) `PATH`, `HOME`, `XDG_RUNTIME_DIR`, `TMPDIR`, `DOCKER_HOST`, `DOCKER_CONFIG`, `DOCKER_CONTEXT` and `BUN_*` to the rehearsal harness and to the proofs. It never forwards the caller's `SUBSTRATE_*` or `CHAOS_*` variables.
- The twin it boots gets two allowlisted settings through `rehearsal up --extra-env`: `SUBSTRATE_BRIEF_PROFILE=shadow` and `SUBSTRATE_SLO_MIN_SAMPLES=3`. These are twin-only; nothing in an env file changes.
- The existing `SUBSTRATE_REHEARSAL_PG_IMAGE` and `SUBSTRATE_REHEARSAL_GREPTIME_IMAGE` overrides (docs/rehearsal.md) apply to the gate: exactly those two keys are forwarded into the environment of the `rehearsal` calls, and into no proof.

## Not an env file entry

`BOOT_GATE` is a **GitHub repository variable**, like `CI_ENABLED`. It is set with `gh variable set BOOT_GATE --body true --repo swcstudiospace/agent-substrate` and removed with `gh variable delete BOOT_GATE`. It belongs in no `.env*` file and no Railway variable. The `boot-gate` job needs both `CI_ENABLED` and `BOOT_GATE` to be `true`.

## Not a flag

`bun run gate:boot` is an explicit command, not a policy: nothing runs it unless an operator (or the opt-in CI job) does, so it has no off/shadow/report mode. The default of the new `--extra-env` flag is "none", so `rehearsal up` without it builds a byte-identical environment.
