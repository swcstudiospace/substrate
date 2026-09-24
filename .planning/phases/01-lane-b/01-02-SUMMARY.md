---
plan: "01-02"
phase: "1"
title: "Tracer — Hermes reads the brief and emits an event"
status: complete
completed: "2026-09-24"
tasks: 3
commits: 2
checkpoint: approved-by-owner
---

# Plan 01-02 — Summary

The phase tracer. One Hermes turn now fetches the substrate brief and emits an
event, end to end against the live `substrate-mcp`, without restructuring the
hook it lives in.

## What was built

| File | Change |
|---|---|
| `prompt_uplift/substrate.py` | **new** — stdlib-only fail-open client (`fetch_brief`, `emit_event`, `--selftest`) |
| `prompt_uplift/redactor.py` | **new** — vendored byte-identical from `mcp/src/grok_hermes_connector/redactor.py` |
| `prompt_uplift/hook.py` | additive — `run_substrate_brief` inside the existing path |
| `tests/conftest.py` | **new** — autouse `SUBSTRATE_DISABLED=1` test-isolation guard |
| `tests/test_hook.py` | +5 FakeCtx tests locking the additive contract |

Commits `8821d46`, `7a1fc16` in `hermes-plugin` on `master`.

## D-01 compliance — proven, not asserted

`__init__.py` is **byte-identical** to the Wave 1 snapshot at
`/var/lib/substrate/phase1-baseline/20260924T040418Z/`. The live hook file was
never edited at all. `create_task=hermes_kanban_create` is still wired and
`register_hook` still appears exactly once — both verified after the fact.

This was achieved with a `substrate_enabled: bool = True` kwarg defaulting to on,
so the call site needed zero edits — strictly more additive than threading a new
argument through `__init__.py`.

No Python→TypeScript bridge. No Kanban retirement. Both remain with the
"Ultrathink on Hermes" milestone that owns them.

## The tracer's claim, demonstrated

A live `handle_pre_llm_call` returned context containing:

```
## Substrate brief: hermes-plugin @ master

Last 2 agent actions in this repo
- 04:32 hermes       prompt-uplift substrate selftest
- 04:31 hermes       prompt-uplift substrate selftest
```

with `last_substrate = {'chars': 185, 'error': None, 'event_ok': True}`. The loop
closed on itself: events emitted by the selftest came back as brief text in a
later turn, attributed to surface `hermes`, repo `hermes-plugin`, branch
`master`. Brief injection, event emission and repo attribution are all proven
against the running service — not mocked.

## Three plan defects found and fixed

1. **`kind="uplift"` does not exist.** The substrate's `EVENT_KINDS` is a closed
   set (`packages/mcp-server/src/types.ts` L18-31) enforced at `event.ts` L63.
   Following the plan verbatim would have returned HTTP 400 on **every** emit —
   and because the client fails open by design, the failure would have been
   silent while the phase reported green. Must-have truth #2 ("that same turn
   lands one event in the substrate event store") would have been false with no
   signal anywhere. Corrected to `kind="prompt"`, with the uplift specifics
   (root, source, node count, redacted prompt) carried in the payload.

2. **`POST /events` returns 202, not 200** (`server.ts` L82). A literal `== 200`
   check would have read every successful emit as a failure. `brief.ts` uses
   `response.ok`, so 2xx acceptance is what "match brief.ts exactly" means.

3. **The pre-existing suite would have written to production.** With the brief
   fetching by default and a live substrate on `127.0.0.1:7410`, all 234 existing
   tests would have POSTed a real event into the production store on every run.
   `tests/conftest.py` adds an autouse `SUBSTRATE_DISABLED=1` fixture; the new
   substrate tests stub the module directly, bypassing the env var.

## Verification

- `python3 -m pytest -q` → **239 passed, 0 failed** (baseline 234 + this plan's 5)
- `SUBSTRATE_URL=http://127.0.0.1:1 python3 -m pytest -q tests/test_hook.py` →
  25 passed in 0.10s — well under the 1.5 s client timeout, so no test touches
  the network
- `python3 -m prompt_uplift.substrate --selftest` → `brief_bytes=130 event_ok=true`
- `diff -q prompt_uplift/redactor.py …/grok_hermes_connector/redactor.py` →
  byte-identical
- D-03 two-sided gate: hermes-plugin 234/0 → 239/0. No other repo touched, so the
  `mcp` (2), `claude-ultrathink-grok` (1) and `claude-ultrathink` (5) failing node
  id sets are unchanged by construction — nothing repaired, nothing vanished.

## Owner checkpoint

`gate="blocking-human"`, approved by the owner after verifying the live install:
brief appended rather than replacing the uplift XML, Kanban card still created,
graceful degradation with `substrate-mcp` stopped, and no leaked secrets in the
injected text.

## Undo

Route A of `/var/lib/substrate/phase1-baseline/RESTORE.md` — restore `hook.py`
from the snapshot and delete the two new modules. No restart needed; Hermes
re-reads plugin modules per session. **Route B for `hook.py` is now stale** — it
restores to commit `8821d46`, not the baseline. Use Route A.

## Artifacts this plan produced

- `prompt_uplift.substrate` module: `fetch_brief`, `emit_event`,
  `EVENT_KIND_PROMPT`, `--selftest` entry point
- `prompt_uplift.redactor` (vendored `redact_text`)
- `prompt_uplift.hook.run_substrate_brief`
- `handle_pre_llm_call(substrate_enabled: bool = True)` kwarg
- `tests/conftest.py` autouse substrate-isolation fixture
