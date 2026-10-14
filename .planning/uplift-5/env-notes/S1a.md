# S1a — `.env.example` additions (orchestrator merges)

No `package.json` script beyond the one line already in this slice (`deploy:preflight`). Both variables are read by **`infra/vps/deploy-release.sh` from the operator's shell**, never by `substrate-mcp`: they are not unit or `substrate.env` settings, and the server ignores them. `.env.example` has no `SUBSTRATE_DEPLOY_*` line today (`SUBSTRATE_DEPLOY_MIN_FREE_GB` is only named in prose); put these two in the VPS/deploy block, or leave them to `infra/vps/README.md` if the orchestrator prefers not to list shell-only variables there.

```sh
# ── Deploy hooks (uplift-5 S1a; infra/vps/README.md § Pre-swap preflight) ──────
# Read by infra/vps/deploy-release.sh from the shell that runs it, not by the
# server. Both hooks run from the NEW release tree between "the release has
# its entry files" and "swap current". The preflight is read-only (it writes,
# starts and contacts nothing). The gate is NOT: it starts and removes scratch
# store containers through docker, pauses one, writes a run directory, and
# needs an image already present and free disk.
#
# scripts/deploy-preflight.ts: does the new tree's loadConfig accept the unit's
# env, do the state files under /var/lib/substrate parse, does the installed
# unit differ from the release's, is there disk. off skips it. report (the
# default) prints the table on stderr and ALWAYS continues, whatever happens to
# the preflight. enforce refuses before current is touched on any exit but 0
# (fail-closed, an unavailable preflight included). Any other value refuses the
# deploy (not rollback) before anything is built. No env value is printed.
SUBSTRATE_DEPLOY_PREFLIGHT=report
# scripts/release-gate.ts: the boot-and-prove gate (exit 0 pass, 1 a check
# failed, 2 unavailable). off (the default) never runs it. report prints a
# gate-receipt line and continues. enforce refuses on 1 AND 2. It runs after the
# preflight; an enforced preflight refusal stops the deploy before the gate.
SUBSTRATE_DEPLOY_GATE=off
```

Test seams, deliberately not in `.env.example` (unset on the VPS; documented in `infra/vps/README.md`): `SUBSTRATE_PREFLIGHT_STATE_DIR` (default `/var/lib/substrate`) and `SUBSTRATE_PREFLIGHT_INSTALLED_UNITS_DIR` (default `/etc/systemd/system`), passed to the preflight as `--state-dir` and `--installed-units-dir`.
