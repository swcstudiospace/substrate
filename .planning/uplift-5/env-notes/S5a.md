# S5a env notes (skills governance, server half)

Add under the existing "Skills proposals (SKILL-01; docs/skills-propose.md)" block of `.env.example`, after `SUBSTRATE_SKILLS_GH=`:

```
# Skills governance (uplift-5 S5a; docs/skills-propose.md#approving-a-skill).
# off (default): `skills_propose` writes no registry row; `skills_approve` and `skills_list`
# still exist (approve is operator-only, needs SUBSTRATE_OPERATOR_TOKENS and a Postgres index).
# report: `skills_propose` also records a `proposed` row in the skills registry.
# enforce: as report; a reader of `GET /skills?state=approved` (the projector, U5-5b) may filter on it.
# Anything else is `off` with a boot warning. Never switch to enforce before the registry holds
# every skill already on the library's main (docs/skills-propose.md: bootstrap risk).
SUBSTRATE_SKILLS_GOVERNANCE=
```

No other variable is added. Operator authority reuses `SUBSTRATE_OPERATOR_TOKENS`; the registry lives in the database `SUBSTRATE_PG_URL` names (table `skills_registry`, created by the boot migration); `gh` is `SUBSTRATE_SKILLS_GH`.
