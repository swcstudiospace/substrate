# Grok Bot Production Loop (v0.3 example)

**Status**: Lane B / Phase 1 example. Enforces substrate usage for Grok Bot.

## The Loop

On every Grok Bot invocation / open:

1. Always fetch and inject brief:
   ```
   substrate brief --surface grok-bot --write || true
   ```
   (or direct POST /brief with Bearer ${SUBSTRATE_TOKEN_GROK_BOT})

   Fails open within 1.5s. Brief is written to .substrate/BRIEF.md for non-hook surfaces.

2. Use only substrate-mediated access:
   - docs: via substrate (future docs.search)
   - skills: via substrate (phase 4)
   - No direct Linear/Notion/raw API in bot prompts.

3. For handoffs to Hermes (via grok-hermes-connector v0.4):
   - Call `handoff_to_hermes` (records `handoff` event with graph_id)
   - `memory.write` and `events.emit` go through substrate (forwards memory_brief etc.)

4. Emit events for all actions:
   - session.start, prompt, tool.call, handoff, session.end
   - Use `--surface grok-bot`
   - Always include graph_id if known (from claude-ultrathink ut- ids)

5. Desk packs / artifacts:
   - All substrate-only (briefs, skills, handoff packets)

## Config via projector

From `substrate.yaml` + `substrate-yaml-projector`:
- SUBSTRATE_URL
- SUBSTRATE_TOKEN (from SUBSTRATE_TOKEN_GROK_BOT)
- SUBSTRATE_BRIEF_CMD

Example generated:
```
SUBSTRATE_URL=http://127.0.0.1:7410
SUBSTRATE_TOKEN=...
SUBSTRATE_BRIEF_CMD='substrate brief --surface grok-bot --write || true'
```

## Verification

- Grok collector (grok.ts) already emits.
- Connector v0.4 forwards.
- OTLP/SLO in healthz (briefP95, eventP95).
- Proof: handoff from GrokBot → Hermes finishes n2; Omp sees in brief.

See ROADMAP Phase 1 success #7, PLAN.md Wave 1/3, substrate.yaml.

Fail-open: bot continues if substrate down.
