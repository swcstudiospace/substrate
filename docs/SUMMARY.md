# Wave 6: Audit / Complete (agent-substrate)

Date: 2026-11-16
Base: delivered Phase 46 debt, v1.8 STATE, gsd-tools from STATE/ROADMAP.
Commands executed (conceptual/read-only per wave): gsd-complete-milestone --confirm (v1.5/v1.8), gsd-audit-milestone (equiv via audits + bun run verify/check:phase-close), gsd-cleanup (archive only, no delete).

## v1.5 / v1.8 Complete Status
- v1.5 closed 2026-10-28 (override, accepted debt): SOTA-02 (phase 46) unsatisfied but recorded debt for open criteria. Phases 45/47-50 accepted debt (live proofs); 51-54 passed in-repo.
- v1.8 live (phases 71-78): Phase 71 locally verified (Greptile P2s closed in 71-05-SUMMARY); PR #199 pending Greptile/Desk review (waived what=not_real needs=greptile_only per 2026-11-12). Phase 72+ human_needed (HARD-S2, corpus proof).
- gsd-complete-milestone --confirm would archive v1.5 (already in milestones/v1.5-*) + note v1.8 partial; irreversible; held for operator on debt/gates.
- Audit: v1.5-MILESTONE-AUDIT.md (gaps_found -> debt), v1.7-MILESTONE-AUDIT.md (gaps_found, PARTIAL 66/67/68), no v1.8 audit yet (current).
- Verify: bun run verify (install/types/locks clean); bun run check:phase-close FAIL (expected debt: lightrag refs in scripts/lightrag-probe.* + docs-eval etc.; see phase 46).
- Archive: gsd-cleanup would move .planning/STATE/ROADMAP + active phase dirs to milestones/ (v1.7+ phases remain; v1.5/v1.6 already archived). No delete.

## Debt / Gates (per 2026-10-28 owner + STATE/ROADMAP)
- Phase 46 (SOTA-02): in-repo 1 (T1-T5 met: parity, probe, cutover record, docs-plane, tests). T6-T8 (RAG-backend removal draft) not run. Gates C1-C7 (T5-T8 live: deploy, archive, parity Part A/B, delta, RAG gate, storage del) HARD_STOP / operator per-run approval.
- Live steps (T5-T8 / C1-C7) require approval; debt accepted 2026-10-28 for criteria 2,4,5,6 + graph/hybrid of 3. RAG-backend reversal impossible (service deleted 2026-10-25 pre-cutover).
- v1.7 gaps (not debt-accepted): 66/67/68 PARTIAL (no live reflect/steering delivery, no scheduler, guard caller, merge race, dispatcher roots ignored); 63/64/65/69/70 gaps (no live ingest/TEI/anchored hour/reconcile timer/SLO baseline).
- v1.8: phase 71 human_needed (review pending); 72-78 partial (e.g. 74/78 no route/scheduler; 76/77 operator install). Operator-gated not run: deploy, Railway writes, devnet, anchor funding, hook/timer, LightRAG LLM route, prod migrations.
- Other: phase close fails on legacy lightrag (debt); no CREDENTIAL_LIKE; Greptile pending on #199/#215.

## RAG-backend Removal (legacy only) + LightRAG Drive
- RAG-backend: legacy only. Service deleted 2026-10-25 (empty check attested). Code residual in ~25 files + scripts (phase46 debt; removal gated on 1-4 + RAG phases + storage approval + LLM decision). planes/RAG-backend.ts still present as fallback. docs/runbooks/lightrag-cutover.md records (no secrets).
- LightRAG drive: rich. In-repo: planes/lightrag.ts (hybrid default, Hindsight tandem, naive fallback), docs-search.ts dispatch, docs-migrate.ts (PARITY_GATE pre), parity-gate.ts (comparator 100% frozen 10q), lightrag-probe.ts (p95<500ms), config SUBSTRATE_DOCS_BACKEND=lightrag. Production cutover Run 11 (naive on bypass LLM). Used by substrate + rich projects (autonogrammer, programming-desk etc. via substrate-mcp /docs/search). Tandem/Hindsight context wired. Graph/hybrid need real LLM route (operator). No RAG-backend in fabric post-cutover (lightrag added). 
- Phase 46 criterion 1 met-in-repo (hybrid/Hindsight/tests); 3 deployed naive live; 2/4/5/6 operator/debt.

## Quality (state machine/retry from bulk) + GSD Waves
- Quality: state machine/retry from bulk (phase 46/57 tandem + docs-ingest retry on LightRAG; bulk corpus in 63; cross-layer reconcile 78; steering idempotency 77). Ratchet strict (noUnused*, exactOptional etc. 0 errors post #171); Biome 0; check:phase-close + verify gates; audit-gate; parity-gate for migration. Bulk ingest (63 corpus atlas) uses retry/de-dupe/manifest. GSD waves: wave 6 = audit/complete (this); prior waves 0-5 delivered phase 71 fixes, merges, v1.6/v1.7 ship. gsd-tools from STATE/ROADMAP used for complete/audit (gsd-complete-milestone --confirm, gsd-audit-milestone, gsd-cleanup archive-only).
- GSD waves cover: v1.3.x/v1.5/v1.6 closeouts (debt), v1.7 partial ship, v1.8 p71 local verify.

## v1.8: Phase 71 Multi-Session (from STATE)
- Milestone: "Hardening: Multi-Session, Ledger Integrity, Degradation and Reconciliation" (phases 71-78).
- Phase 71: multi-session-boundary. Steering + session context bound to owning surface. 71-05: Greptile remediation (server faults as tool errors, private brief budget race, search steering precedence, dead binding sweep, expiry bounded best-effort read-only digest, handle width). Local: 11626 pass /0 fail; check:phase-close green; tsc/biome clean. human_needed (Greptile PR #199 pending; Desk waived). Criterion 5 (read-only digest) preserved by design.
- STATE: "v1.8 Phase 71 locally verified; Greptile review of PR #199 pending; ... phase 72 still human_needed for HARD-S2 credential clause and corpus proof disclosure (owner decisions)".
- Dependencies: 72/77 need 71; operator gates throughout.

## Operator Note
Live steps (T5-T8 in phase 46; C1-C7 probes/parity/archive/cutover; phase 71+ installs, deploys, devnet, LLM route, Railway writes) require approval. Debt per 2026-10-28 owner decision. gsd-complete-milestone --confirm irreversible (archives .planning/ for closed). No autonomous live runs.

## Verification / Audit Evidence
- Audits: v1.5 (gaps_found -> debt), v1.7 (gaps_found), phase VERIFICATION/SUMMARY (46: T1-5 met T6-8 gated; 71-05: 5/5 local).
- Gates: bun verify limited clean; phase-close debt-fail (lightrag); no unlisted high/crit in audit-gate.
- Artifacts: .planning/milestones/*-MILESTONE-AUDIT.md, phases/*/VERIFICATION.md + SUMMARY.md, STATE/ROADMAP.
- Archive ready: gsd-cleanup would move remaining v1.7/v1.8 phases + STATE/ROADMAP to milestones/ (no delete).

Next: operator gsd-complete-milestone --confirm v1.5 (if not), v1.8 when 71+ ready; live approvals for T5-T8/phase71+; then gsd-cleanup + update MILESTONES.md. 
