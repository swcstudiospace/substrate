# Phase 1 — Lane B: Context

> **CORRECTED 2026-09-24 by the owner.** An earlier version of this document
> concluded "Orca, and herdr is not needed". That was wrong, and wrong in a
> specific way: it answered *"can Orca supply events?"* (yes) and treated that
> as answering *"what is the Lane B runtime?"* (a different question). Orca is
> an **IDE** — it runs as `orca-ide` — and is not the best persistent runtime.
> **herdr is the persistent runtime. Both are used:** herdr runs and holds the
> agents, Orca stays as the IDE surface and as a collector, because its push
> path genuinely does carry tool events.
>
> Everything below about Orca's hook contract remains accurate and useful. Only
> the runtime conclusion was wrong.

## What the Orca probe established (still valid, wrongly extrapolated)

Notion §4.2 framed this as "ask `orca agent-context --json` whether the runtime
exposes a session or event query the collector can subscribe to. If it does,
Orca is the Lane B runtime. If it does not, herdr's `events.subscribe` is the
fallback."

Probed on 2026-09-23 against Orca 1.4.205 (`orca-serve` active):

**There is no query or subscribe API.** `orca agent-context --json` returns a
catalogue of 234 CLI commands — the machine-readable command schema, for agents
discovering how to drive Orca. Of those, the only agent-related ones are
`agent hooks on|off|status|prepare-codex`, which manage Orca's *outbound* hooks.
Nothing lists sessions, streams events, or subscribes.

**But the push path is complete, so the fallback is not needed.** Orca's event
model is push-to-HTTP, and it carries everything the substrate wants.

## The hook contract, as actually implemented

`/root/.orca/agent-hooks/{claude,codex,grok}-hook.sh` — installed and enabled
(`agentStatusHooksEnabled: true`) for **claude, codex, grok and hermes**.

`ORCA_AGENT_HOOK_ENDPOINT` is **not a URL**. It is a path to a shell fragment
that the hook *sources*:

    /home/orca/.config/orca/agent-hooks/endpoint.env   (0600 orca:orca)
      ORCA_AGENT_HOOK_PORT=34049
      ORCA_AGENT_HOOK_TOKEN=<secret>
      ORCA_AGENT_HOOK_TRANSPORT=raw-json-v1
      ORCA_AGENT_HOOK_ENV, ORCA_AGENT_HOOK_VERSION

The hook then POSTs the raw agent payload to
`http://127.0.0.1:34049/hook/<agent>` with `X-Orca-Agent-Hook-Token` and a
base64 `X-Orca-Agent-Hook-Meta` header carrying paneKey, tabId, launchToken,
worktreeId, env and version. Port 34049 is `orca-ide` itself.

Timeouts are tight and deliberate: `--connect-timeout 0.5 --max-time 1.5`.

**Correction to a first reading.** The hook contains a filter that drops
`PreToolUse` / `PostToolUse` / `PostToolUseFailure`. That filter lives *only
inside `spool_hook_event()`*, the offline fallback — it keeps the 5 MB spool
small. The primary HTTP path posts **every** event, tool calls included. So
Orca does carry the action-level trail (`tool.call`, `file.edit`, `shell`) that
Notion §5.5 expects from it. No spool directories exist on disk, which is
evidence the HTTP path has never had to fall back.

## What this leaves open — a real decision, not a detail

To observe those events the substrate must sit in the path, and the only seam
is `endpoint.env`: repoint the hooks at a substrate listener that forwards
verbatim to 34049 and also translates to `events.emit`.

That seam is shared with a running system. Every Claude, Codex, Grok and Hermes
session on this host reports status through it, and Orca's UI depends on it. A
bug in the tee degrades agent status across the whole toolchain, not just the
substrate. The 1.5 s max-time caps the blast radius — a hung tee delays each
hook by at most that — but a *wrong* tee silently loses status.

Options, with the tradeoff stated plainly:

| | Coverage | Risk to running system |
|---|---|---|
| **A. Tee via `endpoint.env`** | claude, codex, grok, hermes — uniform, includes tool events | Touches the live status path for every agent |
| **B. Native per-agent hooks** | Claude Code (already done via ultrathink), Hermes eng-board, Grok `sessions/*.jsonl` tail | None — additive only; Codex uncovered |
| **C. Both** | A's coverage with B as the durable floor | Same as A |

B is already partly built: `claude-ultrathink` emits today, and Phase 0 shipped
the Cursor projector and git collector.

## Other Phase 1 facts confirmed

- Orca hooks are installed for hermes, so Hermes session lifecycle is available
  through the same path — the eng-board `on_tool` hook is not the only option.
- `orca-ide` also listens on `0.0.0.0:6768`. Not the hook port; not touched.
- herdr is **not installed** and must be, as the Lane B persistent runtime.
  Notion §4.2's `events.subscribe` on `pane.agent_status_changed` plus
  `pane.read` is the collector seam for it.
- Orca keeps two roles: the IDE, and a collector via the `endpoint.env` tee
  (deferred by the owner until the native floor lands).


## Native floor — status

**Done: Grok Build collector.** `packages/collectors/src/grok.ts`, running as
`substrate-collector-grok.service`. Verified end-to-end into production
Greptime. See the commit for the filtering rationale.

**Next: Hermes.** Probed, not yet built. Entry points confirmed:

    /root/.hermes/plugins/hermes_eng_board/__init__.py
        on_start (L32) · on_tool (L35) · on_end (L38)   → retarget to events.emit
    /root/.hermes/plugins/prompt-uplift/__init__.py
        on_pre_llm_call (L222)                          → inject the brief here

    /root/src/repos/hermes-plugin/.planning/PROJECT.md  → ⚠ NOT the redesign.
        Corrected 2026-09-24 (see Decisions locked below). That document is a
        shipped v0.3.0 milestone, "Prompt Uplift — Grok 4.7 xhigh reasoning
        engine + GSD handoff", and its Out of Scope says verbatim: "Kanban
        behaviour in hermes-plugin (unchanged; GSD writes are additive)." The
        TypeScript-engine bridge and Kanban retirement belong to a different,
        currently unplanned milestone — "Ultrathink on Hermes" v1.0 in the
        `claude-ultrathink-grok` worktree. Lane B does NOT adopt it.

Related repos on disk: `hermes-agent`, `hermes-engineering-board`,
`hermes-linear-connector`, `hermes-plugin`.

Note both plugin files are mode 0600 and live in a running Hermes install —
edits there affect live sessions, so they want the same care as the Orca seam.

**Then:** Omp discovery step, Muse `.substrate/BRIEF.md` fallback, Grok Build
uplift hook, connector v0.4. **Then** the Orca tee (user chose: native floor
first, tee second).

## Decisions locked during autonomous planning (2026-09-24)

Three questions were put to the owner after research and answered. These are
binding on the plan; do not re-open or infer around them.

### D1 — Hermes scope: additive brief + events only

Lane B's Hermes work is **an additive `/brief` call and `events_emit`, without
restructuring `on_pre_llm_call`**. The TypeScript-engine bridge and the true
Kanban retirement are explicitly **deferred** to the "Ultrathink on Hermes"
v1.0 milestone, which already owns them.

*Why:* research established that Phase 1's criteria 1-2 cite
`hermes-plugin/.planning/PROJECT.md` as "the redesign", but that document is a
shipped Grok-routing milestone that puts Kanban changes out of scope. The real
redesign lives in a sibling git worktree of `claude-ultrathink`
(`milestone/v1.0-cross-runtime`) as an unplanned milestone with 0 phases. Both
target the same hook. Building the bridge twice guarantees a collision over
`on_pre_llm_call` registration or an orphaned implementation.

**Consequences the plan must honour:**
- Criteria 1 and 2 as written in ROADMAP.md are **not** achievable in Lane B
  and must not be claimed. Phase verification should assess Lane B against its
  actual goal — every surface reads the brief and emits events — not against
  the TS-bridge premise.
- Hermes edits stay additive and reversible. Both plugin files are mode 0600
  inside a **running** Hermes install; treat every edit there as hot.
- Do not modify `hermes_kanban_create` or the GSD working-directory write.

### D2 — herdr install is in scope for Phase 1

Resolved this session (research Open Question 2). herdr is `herdrdev/herdr`,
Apache-2.0, a single ~10 MB Rust binary with zero runtime dependencies.

Install options, in order of preference for this host:
1. `curl -fsSL https://herdr.dev/install.sh | sh` — official, but **review the
   script before piping it to a shell**; this is a production VPS.
2. Build from source: `git clone https://github.com/herdrdev/herdr && cargo
   build --release` — no pipe-to-shell, at the cost of a Rust toolchain.
3. `mise use -g herdr` if mise is already present.

`brew` is macOS-only and not applicable here.

**Socket API (the Lane B collector seam), confirmed from the official docs:**
- Newline-delimited JSON over a Unix domain socket. One JSON object per line
  with `id`, `method`, `params`; replies reuse `id` under `result` or `error`.
- Default socket `~/.config/herdr/herdr.sock`; named sessions at
  `~/.config/herdr/sessions/<name>/herdr.sock`. Resolution order: CLI
  `--session` → `HERDR_SOCKET_PATH` → `HERDR_SESSION` → default.
- `events.subscribe` takes a `subscriptions` array of `{type, ...filters}`,
  e.g. `{"type":"pane.agent_status_changed","pane_id":"w1:p1"}`. First reply is
  an ack; subsequent lines are pushed events. **Lifecycle streams start at
  accept time and do not replay retained events.**
- `session.snapshot` is a one-shot bootstrap (CLI: `herdr api snapshot`), not a
  live stream.
- **Race-free bootstrap, per the docs:** open `events.subscribe` on a separate
  connection, wait for the ack, buffer events while calling `session.snapshot`,
  install the snapshot, then apply the buffered events in order. Re-snapshot
  after any reconnect.
- Relevant pane events for the collector: `pane.agent_detected`,
  `pane.agent_status_changed`, `pane.output_matched`, `pane.exited`.

**Known upstream issues to design around** (from the project's own tracker, via
research): one unknown pane can fail an *entire* subscription, and integrators
advise treating pushed events as invalidation triggers and re-fetching
`session.snapshot` rather than trusting event payloads directly.

**Caveat that limits the "persistent runtime" claim:** after a machine restart
herdr restores the saved layout and can resume supported agent sessions, but
the original processes do **not** survive. Durability across reboot is Phase 3
(Lane A) territory, not something herdr alone provides.

**Gate:** installing herdr on this production VPS is an owner-approved action
in principle (D2), but the *method* still warrants a `checkpoint:human-verify`
before the install task runs — the owner has not yet chosen between the three
options above.

### D3 — claude-ultrathink `master` verified green

Checked this session in a throwaway detached worktree at `origin/master`
(`f10e8de`, the Phase 0 PR #1 squash-merge): **256 pass, 0 fail**. The worktree
was removed afterwards; neither in-flight checkout was touched.

This settles Finding 5's ambiguity: the red baselines the researcher observed
(`claude-ultrathink` 279 pass/5 fail, `claude-ultrathink-grok` 256 pass/1 fail)
are confined to uncommitted work in those two worktrees and are **not**
regressions from the Phase 0 merge. Do not attribute them to Lane B, and do not
try to "fix" them inside this phase.
