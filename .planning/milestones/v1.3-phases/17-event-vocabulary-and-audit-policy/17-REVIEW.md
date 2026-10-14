---
phase: 17-event-vocabulary-and-audit-policy
reviewed: 2026-10-08T00:00:00Z
depth: standard
files_reviewed: 17
files_reviewed_list:
  - .env.example
  - docs/event-vocabulary.md
  - docs/mcp-audit.md
  - docs/swarm-correlation.md
  - package.json
  - packages/audit/src/policy.ts
  - packages/audit/src/policy.test.ts
  - packages/mcp-server/src/authority.test.ts
  - packages/mcp-server/src/event-sources.ts
  - packages/mcp-server/src/event-sources.test.ts
  - packages/mcp-server/src/mcp.ts
  - packages/mcp-server/src/types.ts
  - packages/mcp-server/src/vocabulary-lock.test.ts
  - scripts/phase-close-check.ts
  - scripts/phase-close-check.test.ts
  - scripts/vocabulary-smoke.ts
  - scripts/vocabulary-smoke.test.ts
findings:
  critical: 0
  warning: 3
  info: 4
  total: 7
status: issues_found
---

# Phase 17: Code Review Report

**Reviewed:** 2026-10-08
**Depth:** standard
**Files Reviewed:** 17
**Status:** issues_found

## Summary

Phase 17 adds the v1.3 event-source table (`event-sources.ts`, 27 emitting rows + 7 silent rows), the `substrate` host-job surface (`types.ts`, `mcp.ts` attribution binding, `.env.example`, token plumbing), the audit-mode decision for 8 planned v1.3 tools (`policy.ts` + `mcp-audit.md`), and two verification instruments (phase-close gate, vocabulary smoke) with pure-helper tests. Samples were traced against `normalizeEvent` (no charset/length restriction beyond 512/2000 caps, so all session/graph ids survive), the `auditedRest` scan regex in `policy.test.ts` was verified against the real 5-argument call sites, and the `force`-release authority path was traced from `mcp.ts` through `isOperator` in `config.ts`.

No blockers. Three warnings, all real but latent: the new `substrate` surface is not covered by the operator-eligibility exclusion that every swarm surface gets; the successful skills-sync (and mirror) path has neither an emitting row nor a silent entry; and the event-source lock tests do not pin surface-rule-vs-sample consistency. Four info items are test/boot-observability gaps and one honest-but-unverified doc claim.

## Warnings

### WR-01: Substrate token is eligible for operator authority; swarm tokens are not

**File:** `packages/mcp-server/src/config.ts:243-246`
**Issue:** `isOperator` refuses operator status to swarm surfaces (`!isSwarmSurface(config.tokens.get(token))`) with a documented rationale — an unattended agent able to `force`-release any lease reintroduces the advisory lease. The new `substrate` surface is held by unattended host jobs (anchor, skills-sync, dispatcher) under the same threat model, yet nothing excludes it: listing `SUBSTRATE_TOKEN_SUBSTRATE`'s token in `SUBSTRATE_OPERATOR_TOKENS` grants `force` on `graph_release`/`graph_complete` (`mcp.ts:638,662`). `configWarnings` likewise flags only listed *swarm* tokens, so the misconfiguration is silent at boot. Default deployments are unaffected (requires the operator to list the token), which is why this is a warning, not a blocker — but the phase's own attribution change (`mcp.ts:94`) explicitly holds substrate to the swarm standard, and this is the one place it does not.
**Fix:**
```ts
// config.ts — isOperator
return !isSwarmSurface(config.tokens.get(token)) && config.tokens.get(token) !== "substrate";
```
plus a `configWarnings` branch naming `substrate` the way the swarm-operator branch does. If a later phase (e.g. dispatcher, 24) genuinely needs force authority, that phase should decide it explicitly, not inherit it by omission.

### WR-02: Successful skills-sync (and mirror) path is unmapped — no row, no silent entry

**File:** `packages/mcp-server/src/event-sources.ts:1-593`
**Issue:** Every other fallible host-job/write source has both sides: `anchor.written`/`anchor.failed`, `dispatch.outcome`/`dispatch.failed`, `docs.search`/`docs.search.failed`, `memory.retain` (silent success) + `memory.retain.failed`. But `skills.sync` has only the `skills.sync.refused` warning row: a successful sync is neither an emitting row nor a `SILENT_SOURCES` entry, and the "Silent sources" section of `docs/event-vocabulary.md` does not mention it. Same pattern for `mirror.failed` (mirror success writes a Linear comment — the external trail — but is not listed as silent). The phase's stated contract is that every v1.3 source maps onto the vocabulary; an unmapped success path means Phase 22/23 implementers must guess whether to emit or stay silent.
**Fix:** Either add the success rows (e.g. `skills.sync` note under `substrate`/`skills-sync`, periodic, no repo) or add explicit `SILENT_SOURCES` entries with the trail (`skills.sync`: the synced tree; `mirror`: the Linear comment) and mirror them in the doc's silent section.

### WR-03: Lock tests do not pin surface-rule-vs-sample consistency or all source prefixes

**File:** `packages/mcp-server/src/event-sources.test.ts:26-63`
**Issue:** Two coverage gaps in the drift guard. (1) No test checks that a row's declared `surface` rule agrees with its `sample()` surface — a row declaring `{ fixed: "substrate" }` while sampling `cursor`, or declaring `"caller"` while sampling `substrate`, passes every existing assertion (normalize + doc kind/action equality + repo rule). The doc table's surface column is compared only implicitly through id presence, not value equality. (2) The "every roadmap source has at least one row" prefix guard covers `herdr.`, `muse.`, `cursor.stop`, `skills.propose`, `docs.ingest`, `desktop.`, `anchor.`, `teachable.` but not `dispatch.`, `lanea.`, `mirror.`, `dod.`/`lease.` — emptying any of those sections passes the guard.
**Fix:**
```ts
// per-row: declared rule must admit the sample surface
test(`row ${row.id} sample surface satisfies its rule`, () => {
  const s = row.sample().surface;
  if (typeof row.surface === "string") {
    if (row.surface === "caller" || row.surface === "memory-writer" || row.surface === "lease-holder")
      expect(["claude-code", "hermes"].includes(s)).toBe(true); // concrete sample surface
    // "herdr-agent" rows must sample a mapped SURFACES member, never a raw herdr id
  } else expect(s).toBe(row.surface.fixed);
});
```
plus doc-surface value equality in the marked-table test, and prefix entries for `dispatch.`, `lanea.`, `mirror.`, `dod.`, `lease.`.

## Info

### IN-01: `.env.example` test pins swarm tokens but not the new substrate line

**File:** `packages/mcp-server/src/authority.test.ts:247-256`
**Issue:** The test iterates only `SWARM_SURFACES`, so the added `SUBSTRATE_TOKEN_SUBSTRATE=` line in `.env.example` is unpinned — deleting it breaks no test. The adjacent substrate token-resolution test uses inline env, not the example file.
**Fix:** Iterate `[...SWARM_SURFACES, "substrate"]` (or `SURFACES` minus non-token surfaces, if that distinction matters) in the same loop.

### IN-02: No boot warning for a missing substrate token

**File:** `packages/mcp-server/src/config.ts:319-333`
**Issue:** `swarmTokenWarnings` reports each swarm surface without a token once authentication exists, but a deployment without `SUBSTRATE_TOKEN_SUBSTRATE` — host jobs unable to authenticate — is silent at boot. The smoke even relies on a borrowed `hermes` token posting `substrate` rows (authority test "borrowed" case), so the gap is masked in testing.
**Fix:** Append a `substrate` line to `swarmTokenWarnings` (or a parallel check) when `config.tokens` lacks it and `allowAnonymous` is false.

### IN-03: Reviewed doc ships an explicitly `[UNVERIFIED]` herdr mapping

**File:** `docs/event-vocabulary.md:79-87`
**Issue:** The "herdr agent to surface" section is marked `[UNVERIFIED]` and defers identifier pinning to Phase 19, yet in the same paragraph asserts example mappings (Claude→`claude-code`, Codex→`codex`, …) as parenthetical fact. The marker is honest, but a reviewed vocabulary doc now contains mapping claims no test or source confirms; `herdr-agent` sample surfaces assume a Phase 19 table that does not exist yet.
**Fix:** Either drop the parenthetical examples until Phase 19 pins them, or rephrase as non-normative illustrations ("expected shape, to be pinned by Phase 19").

### IN-04: `parseEventKinds` lacks the mis-match guard `parseSurfaces` has

**File:** `scripts/phase-close-check.ts:62-96`
**Issue:** `parseSurfaces` uses `(?<![A-Z_])SURFACES` so `SWARM_SURFACES` cannot false-match; `parseEventKinds` matches bare `EVENT_KINDS` with no equivalent guard, and the spread expansion only handles the exact token `...SWARM_SURFACES` (no whitespace variants, no other spreads). No such identifiers exist today, so this is latent robustness, not a live bug.
**Fix:** Add the same negative lookbehind to the kinds regex and tolerate `... SWARM_SURFACES` whitespace in the spread matcher.

---

_Reviewed: 2026-10-08_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
