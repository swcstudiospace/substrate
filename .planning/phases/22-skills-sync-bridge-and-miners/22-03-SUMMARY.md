# Phase 22 Plan 03: propose-only miners — Summary

**Status:** complete. **Live effect:** none — host untouched, rebinds specified not executed.
**Commit:** `3be564e`.

## Outcomes

- `packages/projector/omp/substrate-skills.ts` + `.test.ts`: extension ported whole —
  `manage_skill` create/update proposes then blocks with the PR reason, `learn` proposes,
  strips the payload so the lesson lands and names the PR, deletes and other tools pass
  through, 25 s abort inside Omp's 30 s budget, queue-on-timeout/transport/5xx/401 and
  final-block on 400/413, never throws, structural Omp types only, session_id forwarding.
  Bearer resolution follows the token.ts order for surface `omp`, sent only as the
  `Authorization` header. `SKILL_NAME_RE` stays a documented local literal: the file loads
  standalone inside Omp and cannot import the repo graph.
- Queue-compatibility proof: an extension-shaped queued fixture drained through the 22-02
  bridge validator unchanged (proposed=1, body byte-identical, session_id kept).
- Extension suite: 20 pass, incl. bearer-header, missing-bearer queueing, 401 queueing,
  timeout 0600 queueing, learn stripping, session_id method-call, and resolver-order cases.
- `packages/miner/skills/substrate-skill-miner/SKILL.md`: September prompt with a bearer
  auth paragraph (hermes surface bearer; no other credential) and a `skills.write_approval`
  / `memory.write_approval` never-flip rule; ≤3 cap, frontmatter contract, never-write and
  empty-run-correct rules intact; no key reference.
- `docs/skills-sync-bridge-miners.md` miners section: three OPERATOR-GATED rebinds —
  skill-autonomy reinstall, Hermes cron rebind (approval flags asserted true both sides),
  Omp symlink repair — each with proof read and rollback.

## Deviations

- **Plan grep-gate false positive (documented, not a code change):** the literal 22-03 gate
  pattern `from.*omp` matches the file's own structural names (`skillFromToolCall`,
  `OmpSkill`) that September's source also carries. Intent verified separately: the only
  imports are `node:fs` and `node:path`; no Omp-package or repo-graph import exists.

## Verification

Extension suite 20/20; key/omp-import gates pass on intent; store-lock green;
`bunx tsc --noEmit` clean.

## Self-Check: PASSED
