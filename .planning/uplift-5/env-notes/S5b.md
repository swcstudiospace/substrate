# S5b — env notes (projector half of skills governance)

`.env.example` lines to add (shared with the server slice S5a, which documents its own reader; the variable is ONE name read by two processes):

```
# Skills governance (uplift-5 S5). off|report|enforce, default off.
# Read by the substrate server (registry writes) AND by the skills projector (substrate-skills-sync.service
# environment file). Projector: off = no fetch, byte-identical; report = project everything, one deduped
# `skills.sync` warning listing unapproved library skills; enforce = NEW links only for approved skills,
# never unlinks. Runbook: docs/runbooks/skills-governance.md
SUBSTRATE_SKILLS_GOVERNANCE=off
```

Projector reads, already present elsewhere (no new line): `SUBSTRATE_URL` (default `http://127.0.0.1:7410`), `SUBSTRATE_TOKEN_SUBSTRATE` then `SUBSTRATE_TOKEN` (first entry of a comma list) for the `GET /skills?state=approved` bearer.

Files the projector writes in the state directory beside `projector-warned.json` (default `/var/lib/substrate/skills/`), only when the flag is `report` or `enforce`: `approved.json` (mode 0600), `governance-warned.json` (mode 0600).
