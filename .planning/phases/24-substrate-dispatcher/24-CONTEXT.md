# Phase 24: substrate-dispatcher — Context

There was no `/gsd:discuss-phase` round for this phase. No CONTEXT.md
existed when research ran, and no user decisions were gathered.

## Locked decisions

The locked constraints are exactly these three sources, in this order.
Plans must not reopen them:

1. **ROADMAP.md Phase 24** — goal, dependencies (Phase 23), repos
   (`packages/dispatcher`, `infra/vps`), success criteria, and proof line
   (isolated `--once --dry-run` first; live DISP-08 only in an
   operator-approved bounded kill-switch-off window).
2. **REQUIREMENTS.md DISP-01..DISP-08** — the eight dispatcher
   requirements verbatim. DISP-08 is a human-only live proof.
3. **`.planning/phases/24-substrate-dispatcher/24-RESEARCH.md`**
   (2026-10-09, HIGH confidence) — the only launcher is headless Hermes;
   `dispatch:claude-code` is a TCP dial of `127.0.0.1:7411` only; issue
   text stays out of the prompt; no Lane A VM, no `POST /tasks`, no
   `openTask`, no `packages/host` source; never port `21652a2`; the
   dispatcher never calls `graph_claim`; no new npm dependencies.

## Standing prohibitions (bind every plan in this phase)

- Agents must not disable the kill switch, write `/etc/substrate`,
  restart systemd units, or spawn the real `hermes` binary.
- Tests use tmp directories and fakes; never `/var/lib/substrate`,
  never live Linear, never live Hermes.
- The kill switch `SUBSTRATE_DISPATCH_DISABLED` defaults to **disabled**
  (dispatch does not run) when the variable is absent.
- Open-question resolutions, not investigations: do not execute a live
  Hermes `${VAR}` header check (A1 → preflight skip + operator
  checkpoint); pin Linear `pageInfo` cursor fields in the fake (A2);
  treat `graph.repo` as GitHub `owner/name` and test that assumption (A3).
- DISP-08 (plan 24-06) is `autonomous: false` with a
  `checkpoint:human-action`. The operator approves any live window and
  the agent does not run it.
