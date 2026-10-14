---
phase: 18-guard-rails-and-shared-redactor
reviewed: 2026-10-09T00:25:25Z
depth: standard
files_reviewed: 9
files_reviewed_list:
  - docs/greptime-ledger.md
  - docs/memory-governance.md
  - docs/observability.md
  - docs/redaction.md
  - packages/cli/src/lessons.ts
  - packages/mcp-server/src/memory-classify.test.ts
  - packages/mcp-server/src/redact-lock.test.ts
  - packages/mcp-server/src/redact.test.ts
  - packages/mcp-server/src/redact.ts
findings:
  critical: 0
  warning: 2
  info: 5
  total: 7
status: issues_found
---

# Phase 18: Code Review Report

**Reviewed:** 2026-10-09T00:25:25Z
**Depth:** standard
**Files Reviewed:** 9
**Status:** issues_found

## Summary

Scope: the union of phase 18's task commits (`check evaluation-scope --phase 18`, status `resolved`, source `task-commits`), 9 files. The SUMMARY tier yielded nothing because the four SUMMARYs write `key-files` as YAML flow lists, which the workflow's extractor does not parse; the evaluation-scope tier supplied the same 9 files. The validate-phase gate's later commit `e59dee7` (new `redact-contract.test.ts`, 17 added lines in `redact-lock.test.ts`) is not a phase task commit and is outside this scope. Line numbers below are against the tree at review time, `6dbc8bf`.

The event pass is sound. The 30 labelled rules keep `redact()`'s signature and output. The D-04 entries follow September's order, the D18-21 `pk-rk` narrowing is correct (the greedy tail consumes the whole run the lookahead scanned, so the required digit always falls inside the match), `redactValue` and the counter exemption are untouched, and the `lessons.ts` migration to `redactKnown` behaves the same as before. The gated harness round trip refuses a non-loopback host or port 7410 before any request.

The defects are in the ported skill pass (`redactSkillContent`). It has no production caller yet (Phase 25 decides on reuse), so these are latent. Probes ran against the module through `bun` with runtime-assembled values and confirmed both warnings:

- A `<private>` block that contains a high-confidence shape keeps its other content. The output can then include text that was explicitly marked private, with no hit reported for it.
- A real value that starts with a placeholder word is neither redacted nor reported.

The documented verbatim-port gaps (`docs/redaction.md` "Verbatim-port gaps, kept on purpose": `api-key-lower` misses JSON-quoted keys and `openai_api_key:`, plus the fixed-length tails) are deliberate under D18-01. They are not re-reported here.

## Warnings

### WR-01: Skill pass leaves `<private>` block content in place when the block contains a high-confidence shape

**File:** `packages/mcp-server/src/redact.ts:252` (rule order), `packages/mcp-server/src/redact.ts:307` (overlap skip); also `docs/redaction.md:21`
**Issue:** `SKILL_RULES` puts `private-tag` after all 16 high-confidence rules (`pem` at line 234 through `openai-proj`). `redactSkillContent` then drops any later match that overlaps an earlier claim (line 307). When a `<private>…</private>` block contains a PEM, JWT, GitHub, AWS or other high-confidence span, that span is claimed first. The `private-tag` match overlaps it and is skipped entirely: only the inner token is replaced, and the rest of the private block is returned verbatim. No `private-tag` hit is reported.

Probe (runtime-assembled values): `<private>the db root pass is CANARYWORD and <jwt> too</private>` with `allowDocExamples: {jwt}` returns `text: "<private>the db root pass is CANARYWORD and [REDACTED] too</private>"`, `redactions: [{line:1, rule:"jwt"}]`, `findings: []`. The private prose survives with nothing flagging it. `allowDocExamples: {pem}` with a PEM inside a private block behaves the same way. Without the opt-in, the inner token becomes a finding and a well-behaved caller refuses, but the `files` map that `scanSkillFiles` returns still carries the private prose. The event pass removes the whole block (`redact()` returns `[REDACTED]`), so the two passes disagree on the one structural rule. The doc row at `docs/redaction.md:21` ("first so a key inside it goes as one block") is stated for both columns but is only true of the event pass. The test at `packages/mcp-server/src/redact.test.ts:525` asserts this behavior, so the current suite pins the leak.
**Fix:** Claim `<private>` blocks first, and still surface any high-confidence shape inside them as a finding. For example, collect private spans in a pre-pass and record inner high-confidence matches as finding-only claims, without a replacement span of their own:
```ts
// pre-pass: private blocks own their whole span
const privateRule = SKILL_RULES.find((r) => r.name === "private-tag")!;
for (const m of text.matchAll(privateRule.pattern)) {
	const [s, e] = m.indices![0];
	claims.push({ start: s, end: e, rule: "private-tag", replace: { start: s, end: e, with: REDACTED }, kind: "redaction" });
}
// in the main loop, for a high-confidence match fully inside a private claim:
//   report it as a finding (kind "finding", no replace) instead of `continue`.
```
Then change `redact.test.ts:525` to expect the whole block replaced plus the `github` finding.

### WR-02: Placeholder test is a prefix match, so real values beginning with a placeholder word are neither redacted nor reported

**File:** `packages/mcp-server/src/redact.ts:273-283`
**Issue:** `isPlaceholder` returns true for any value whose lowercase form *starts with* `your`, `xxx`, `...`, `***`, `example`, `changeme`, `placeholder` or `redacted`. Every contextual skill rule treats that as "kept": the span is claimed, left as written, and appears in neither `redactions` nor `findings`. Probes confirmed four values come back unchanged with nothing reported, while `redact()` on the event pass redacts all four: `password: YourDogRex2024!`, `DB_PASSWORD=examplecorp-Pr0d-7731`, `apiKey: xxxA9f3b2c1d4e5f6a7b8c9` and `SERVICE_TOKEN=redacted9f8e7d6c5b4a`. This phase extends the bypass to the new skill `api-key-lower` entry (D18-08). The behavior contradicts `docs/redaction.md` "Redactions: contextual rules with a real value are rewritten and reported".
**Fix:** Match placeholder *shapes*, not prefixes. Accept a placeholder word only when the whole value consists of it plus separators, `x`/`*`/`.` runs, or a `-key`/`-here`/`-token` style suffix. For example:
```ts
const PLACEHOLDER = /^(?:your|example|changeme|placeholder|redacted)(?:[-_ ]?(?:api|access|secret)?[-_ ]?(?:key|token|password|value|here|goes|secret))*$|^(?:x{3,}|\*{3,}|\.{3,})$/i;
return PLACEHOLDER.test(value);
```
Keep `your-api-key-goes-here` and `<your-key>` passing, and add the four probe values above as must-redact cases.

## Info

### IN-01: `redactKnown` re-scans its own markers, so a needle that is a substring of `[REDACTED]` corrupts the output and breaks idempotence

**File:** `packages/mcp-server/src/redact.ts:147-152`
**Issue:** Needles are replaced sequentially into the same string. A later, shorter needle that occurs inside the marker text (`RED`, `ACT`, `TED`, `E`, `[`) splices markers into markers. Probe: `redactKnown("token XYZTOKENVALUE and RED", ["XYZTOKENVALUE","RED"])` returns `token [[REDACTED]ACTED] and [REDACTED]`. Re-applying `["XYZ","DAC"]` twice yields `a [RE[RE[REDACTED]TED]TED] b`. `lessons.ts` feeds URL search-param values in as needles, so a short param value is enough to trigger this. Nothing leaks (it over-redacts), but the "is idempotent" test (`redact.test.ts:97`) only holds for needles that are disjoint from the marker.
**Fix:** Do a single pass: build one alternation of the escaped needles, longest first, and call `text.replace(new RegExp(alt, "g"), REDACTED)` once. Alternatively, split on existing `[REDACTED…]` markers and only replace inside non-marker segments.

### IN-02: `lessons.ts` still filters and sorts the values that `redactKnown` now filters and sorts

**File:** `packages/cli/src/lessons.ts:808`
**Issue:** `secretValues = [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)` duplicates `redactKnown`'s own dedupe, empty-filter and longest-first ordering (`redact.ts:148`). That leaves two places that encode the ordering contract D18-11 moved into the module.
**Fix:** Pass `secrets` directly: `redactKnown(..., secrets)`. Then drop the local `secretValues`.

### IN-03: The redaction doc miscounts which table rows are the D-04 classes

**File:** `docs/redaction.md:52-53`
**Issue:** The doc says "The last ten rows before `jwt` are the September D-04 classes". The ten rows immediately before `jwt` are `anthropic`, `openai`, `aws`, `google`, `slack`, `npm`, `gitlab`, `digitalocean`, `openai-proj` and `pk-rk`. Two of those (`anthropic`, `openai`) are not D-04, and two D-04 classes (`private-tag`, `api-key-lower`) sit elsewhere in the table.
**Fix:** Name the classes explicitly: "The D-04 classes are `private-tag`, `api-key-lower` and the eight rows from `aws` to `pk-rk`."

### IN-04: The lock's ignore list misses gitignored output directories, so `bun test` can fail on local artifacts

**File:** `packages/mcp-server/src/redact-lock.test.ts:38`, `:58`
**Issue:** `scopeFiles` globs untracked files on purpose, but `IGNORED` only skips `node_modules/`, `.git/` and `dist/`. `.gitignore` also ignores `build/`, `.venv/` and `venv/`. A local Python virtualenv or `build/` output under `packages/`, `scripts/` or `infra/` would be scanned: vendored `.py` files with `re.compile(...)` credential shapes or `def redact…` would fail rules 2 and 4 on a dev machine but not in CI. The check is also a substring match (`path.includes("dist/")` matches `redist/`).
**Fix:** Match whole path segments and add the gitignored build and venv directories, for example `const IGNORED = /(?:^|\/)(?:node_modules|\.git|dist|build|\.venv|venv|__pycache__)\//;` with `if (!IGNORED.test(path))`.

### IN-05: The pipeline self-test accepts a hit from any detector, not the planted rule's own

**File:** `packages/mcp-server/src/redact-lock.test.ts:558-568`
**Issue:** The test checks `rule4Offenders(file, body).length > 0`, which is satisfied when *any* detector fires on the extracted candidate. The `openai` detector (`(?<![A-Za-z0-9])sk-`) also fires on the planted `anthropic` (`sk-ant-`) and `openai-proj` (`sk-proj-`) bodies. Those two detectors are therefore never proven reachable through candidate extraction. The separate `detector.test(body)` runs on the raw line, not on the extracted pattern candidate.
**Fix:** Assert the specific detector against the extracted candidates: `expect(patternCandidates(file, body).some((c) => DETECTOR[rule]!.test(c))).toBe(true)`.

---

_Reviewed: 2026-10-09T00:25:25Z_
_Reviewer: the agent (gsd-code-reviewer)_
_Depth: standard_
