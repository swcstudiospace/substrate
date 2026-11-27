# Blocking unknowns — Wave 1 (n1/n4, SPE-38284/SPE-38286) · 2026-11-26

Settled vs open. Blocking = requires user decision before dependent work. Defaults are the recommended options from the Ultrathink plan unless repo evidence overrides.

| # | Unknown | Class | Default / evidence | Blocks |
|---|---|---|---|---|
| q1 | Linear vs Notion status authority | **Settled by evidence** — `.planning/issue-programming/notion-linear-mapping.md` §0 + `audit/FINAL-REPORT.md` §4: Linear authoritative, Notion derived/mirrored | Linear wins; Notion writes mirror only | Nothing (n5 design uses this) |
| q2 | 6–8 features: span all five or concentrate? | Non-blocking | Evidence-concentrated; zero allowed per resource with reason (Hindsight 0 until role verified) | n3 matrix shape only |
| q3 | LightRAG completeness target | Non-blocking | Checkpoint resume only; no backfill/new sources until lineage proves a gap | n5 ingestion scope |
| — | Notion DB ID / Linear team write scope | **Blocked (Wave 3 sync only)** — `notion-linear-mapping.md` §8 gate: env names exist, target DB/team unconfirmed; **no sync authorised** | Local spec only; 0 creates until user confirms | Any real Linear/Notion write beyond the already-created graph rows |
| — | Hypertable policy for future time-series tables | Grey area | Do-not-adopt for current 22 relational tables; adopt-gate = measured volume + retention need; ADR-0010 to re-scope (n3) | F1 migration scope |
| — | LightRAG 1713 failed docs cause | Open — extraction-side (tool failures 0) | Sample failed doc_ids before bulk resume (n6) | Big-repo resume confidence |
| — | Recall/throughput baselines (`null`) | Open | P0 measurement (P0 in optimisation-plan) before feature claims | F-verify gates (n6) |
| — | 10 outstanding phases are `human_needed/gaps_found`, v1.8 closed | Evidence (§1 inventory) | Human verify is the gate; agents cannot self-verify | Phase close (needs operator) |
| — | Hindsight specialist role beyond banks/recall | Open | No Hindsight feature until docs+usage verify (n3 evaluates) | F-selection |

**Pause rule (from n4):** halt only for missing write credentials (Wave-3 sync), unresolved phase scope (none — phases verified), unverifiable Hindsight selection (already excluded), missing LightRAG checkpoint (exists — §lightrag-checkpoint), conflicting status authority (settled q1). All other unknowns proceed under the defaults above.
