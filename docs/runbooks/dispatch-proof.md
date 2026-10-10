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
| Method | Each step's effect is checked within 60 s by read-only Linear reads. Record only hosts, ports, key names and booleans here — never values or issue text. Rehearse first: `bun run smoke:dispatcher` must be green (20/20 + driver 30/30) before any window is requested. |

## Sequence (bounded kill-switch-off window)

1. **Provision.** OPERATOR-GATED: write `/etc/substrate/substrate-dispatcher.env`
   (`SUBSTRATE_TOKEN_SUBSTRATE` by value from Phase 20, `LINEAR_API_KEY`,
   `SUBSTRATE_DISPATCH_DISABLED=1`). Verify names only, never values.
2. **Deploy.** OPERATOR-GATED: deploy this phase's code and restart
   `substrate-mcp` only if the release script requires it.
3. **Open the window.** OPERATOR-GATED: set `SUBSTRATE_DISPATCH_DISABLED=0`.
   The loop re-reads the file every tick; no restart needed.
4. **Launch.** Within 30 s the dispatcher launches one headless Hermes
   session in `/var/lib/substrate/worktrees/<graph>` on `substrate/<graph>`.
   Check: session log under `/var/lib/substrate/dispatcher/sessions/`,
   prompt under `prompts/` carrying the token path, never a value.
5. **Claim.** The session claims under the hermes token.
   Check (≤60 s): `agent:hermes` label, `Claimed by hermes — session …`
   comment, Notion Agent hermes, Claude Code brief names the claim.
6. **Run end.** The run ends in gated Done (connector moves it, never the
   dispatcher) or release-and-stop.
   Check: dispatcher logged the landed claim; no `[exited-unclaimed]`,
   no `[claim-timeout]`.
7. **Close the window.** OPERATOR-GATED: set `SUBSTRATE_DISPATCH_DISABLED=1`
   back. The proof ends with the kill switch back on — this is a proof
   step, not a note.
8. **Production cutover.** OPERATOR-GATED: restart
   `substrate-dispatcher.service`, retire the `dormant:24` expected-401
   count in `docs/runbooks/production-identity.md`, flip the manifest row
   `dormant:24` → `live` only after the restart.

## Rollback

Re-run the rehearsal smoke (`bun run smoke:dispatcher`) to confirm the
code still rehearses clean. If a proof step leaves a tracker in a wrong
state, the operator restores it by hand in Linear — the dispatcher never
repairs trackers, it only writes the current decision. The kill switch
(`SUBSTRATE_DISPATCH_DISABLED=1`) ends dispatching without a restart.
No deploy rollback is needed: the proof changes no code.

## Evidence

Dated readings, newest last. No live results yet.

| Date (UTC) | Issue | Graph | Steps 1–8 | Notes |
| --- | --- | --- | --- | --- |
| — | (to confirm) | — | NOT RUN | Awaiting operator approval |
