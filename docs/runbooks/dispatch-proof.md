# Runbook — DISP-08 live proof for substrate-dispatcher

> **Approval gate.** Nothing below runs without explicit operator approval in
> its own window. Every step writes to real Linear and Notion and spends
> Hermes model quota. The proof itself does **not** run in this phase — this
> runbook only scripts it. No live results are recorded here.
>
> OPERATOR-GATED: the executor prepares the rehearsed sequence, then stops.
> Every step below waits for explicit operator approval.

| | |
| --- | --- |
| Requirement | DISP-08 |
| Prerequisites | `substrate-mcp` running this phase's code (deploy via `infra/vps/deploy-release.sh` and restart only if the release script requires it); Phase 20 production surface tokens (substrate + hermes); Linear writes approved; Hermes model quota; `/etc/substrate/substrate-dispatcher.env` provisioned (OPERATOR-GATED, gated live-tail step 1) |
| Proof issue | Reuse a fresh unstarted issue carrying `dispatch:hermes` — never create one against the Free-plan cap; confirm it is unarchived and visible to both the substrate key and the connector before starting |
| Method | Each step's effect is checked within 60 s by read-only Linear reads. Record only hosts, ports, key names and booleans here — never values or issue text. Rehearse first: `bun run smoke:dispatcher` must be green (20/20 checks, driver exit 0) before any window is requested. |

## Sequence (bounded kill-switch-off window)

1. **Provision.** OPERATOR-GATED: write `/etc/substrate/substrate-dispatcher.env`
   (`SUBSTRATE_TOKEN_SUBSTRATE` by value from Phase 20, `LINEAR_API_KEY`,
   `SUBSTRATE_DISPATCH_DISABLED=1`). Verify names only, never values.
2. **Deploy.** OPERATOR-GATED: deploy this phase's code and restart
   `substrate-mcp` only if the release script requires it.
3. **Start the dispatcher idle.** OPERATOR-GATED: install, enable and start
   `substrate-dispatcher.service` explicitly (it is not in
   `deploy-release.sh`'s default unit list) with the switch still on.
   Check: the unit is active and the journal shows the disabled line, not
   a launch.
4. **Open the window.** OPERATOR-GATED: set `SUBSTRATE_DISPATCH_DISABLED=0`.
   The loop re-reads the file every tick; no restart needed.
5. **Launch.** Within 30 s the dispatcher launches one headless Hermes
   session in `/var/lib/substrate/worktrees/<graph>` on `substrate/<graph>`.
   Check: session log under `/var/lib/substrate/dispatcher/sessions/`,
   prompt under `prompts/` carrying the token path, never a value.
6. **Claim.** The session claims under the hermes token.
   Check (≤60 s): `agent:hermes` label, `Claimed by hermes — session …`
   comment, Notion Agent hermes, Claude Code brief names the claim.
7. **Run end.** The run ends in gated Done (connector moves it, never the
   dispatcher) or release-and-stop.
   Check: dispatcher logged the landed claim; no `[exited-unclaimed]`,
   no `[claim-timeout]`.
8. **Close the window.** OPERATOR-GATED: set `SUBSTRATE_DISPATCH_DISABLED=1`
   back. The proof ends with the kill switch back on — this is a proof
   step, not a note.
9. **Production cutover.** OPERATOR-GATED: restart
   `substrate-dispatcher.service`, retire the `dormant:24` expected-401
   count in `docs/runbooks/production-identity.md`, flip the manifest row
   `dormant:24` → `live` only after the restart.

## LANEA-08 gated sequence (Phase 33 — label to gated Done on Lane A)

Rehearsed end to end by `bun scripts/lane-a-e2e.ts` (29/29 checks with
fakes: label → tick → `POST /tasks` → claim → heartbeat → fake approval →
settle → push/PR/sync fakes → complete with DoD → Done, plus mid-chain
restart replay and refusal replays). The live tail below spends real quota
and writes real trackers: the executor stops at every gate and never runs it.
Preconditions chain: G(n) green before G(n+1). Out of scope even for the
tail: pushes/PRs on non-throwaway repos, Linear/Notion writes outside the
isolated graph, `RIVET_RUN_ENGINE=1` (refused until the G2 verdict), base
pulls beyond the G2 window, standing-permission grants.

### G1 — OPERATOR-GATED: label wiring live

- Preconditions: this phase's code on `main`; rehearsal half green
  (`bun scripts/lane-a-e2e.ts` 29/29, `python3 -m pytest
  packages/dispatcher/tests` green, `bun test packages/host/` green);
  operator-approved window.
- Gate: OPERATOR-GATED — the executor stops here; a human approves the
  window and runs the step.
- Run: kill switch `0` for the window only; a real `dispatch:claude-code`
  label on a fresh unstarted issue is polled within one 30 s tick.
- Record: tick log + candidate resolution evidence; kill switch back to `1`
  after — the switch-back is a proof step, not a note.
- Rollback: kill switch to `1`; remove the label; no claim exists yet.

### G2 — OPERATOR-GATED: real VM dispatch

- Preconditions: G1 green; `bun scripts/host-spike.ts --check` exit 0
  re-asserted; 10 GiB floor holds.
- Gate: OPERATOR-GATED — the executor stops here; a human approves the
  window and runs the step (spends Claude Code quota + Docker capacity).
- Run: `POST /tasks` 202 → the VM claims as `claude-code` → heartbeats
  observed on the persisted lease.
- Record: claim→heartbeat evidence, quota spent.
- Rollback: kill the task, release the claim, dispose the VM; the manifest
  stays `dormant:31`.

### G3 — OPERATOR-GATED: real approvals

- Preconditions: G2 green; approval bot token + chat + user ids provisioned
  (names only in the repo: `SUBSTRATE_APPROVAL_BOT_TOKEN`,
  `SUBSTRATE_APPROVAL_CHAT_ID`, `SUBSTRATE_APPROVAL_USER_IDS`); `whoami`
  check shows the bot name in the journal.
- Gate: OPERATOR-GATED — the executor stops here; a human taps in the live
  channel and runs the step.
- Run: permission requests reach the human channel; Approve continues the
  turn; Deny fails it closed; one request is left untapped to prove the
  deadline auto-deny (fail-closed, single release).
- Record: tap evidence + timeout log; no input values recorded anywhere.
- Rollback: deny any open request; the turn fails closed and releases.

### G4 — OPERATOR-GATED: real push, PR, sync, gated Done

- Preconditions: G2–G3 green; throwaway repo + isolated graph only.
- Gate: OPERATOR-GATED — the executor stops here; a human approves the
  window and runs the step.
- Run: real push + PR land on the throwaway repo; PR fields sync; the issue
  reaches gated Done via `graph_complete` with DoD + lease (the connector
  moves it, never the dispatcher or the host).
- Record: PR URL, sync evidence, Done transition.
- Rollback: close the PR, delete the throwaway repo, release the claim;
  restore any tracker field by hand.

### G5 — OPERATOR-GATED: production unit activations + manifest flips

- Preconditions: G1–G4 green (expected 401s clear on both rows);
  `substrate-host.service` G4 restart done, `substrate-dispatcher.service`
  restarted.
- Gate: OPERATOR-GATED — the executor stops here; a human approves the
  window and runs the step.
- Run: flip the manifest rows `dormant:24` → `live` and `dormant:31` →
  `live` only after the restarts.
- Record: `systemctl` evidence + manifest diff + 2xx evidence.
- Rollback: flip back to `dormant:24` / `dormant:31`; stop the units.

## Rollback

Re-run the rehearsal smoke (`bun run smoke:dispatcher`) to confirm the
code still rehearses clean. If a proof step leaves a tracker in a wrong
state, the operator restores it by hand in Linear — the dispatcher never
repairs trackers, it only writes the current decision. The kill switch
(`SUBSTRATE_DISPATCH_DISABLED=1`) ends dispatching without a restart.
No deploy rollback is needed: the proof changes no code.

## Evidence

Dated readings, newest last. No live results yet.

| Date (UTC) | Issue | Graph | Steps 1–9 | Notes |
| --- | --- | --- | --- | --- |
| — | (to confirm) | — | NOT RUN | Awaiting operator approval |
