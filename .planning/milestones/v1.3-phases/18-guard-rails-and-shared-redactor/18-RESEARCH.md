# Phase 18: Guard rails and shared redactor - Research

**Researched:** 2026-10-08
**Domain:** In-repo redaction engine (TypeScript on Bun 1.4.0), repo-level lock tests (`bun:test`), docs
**Confidence:** HIGH. Every rule, interaction and lock detector below was exercised this session against the real tree, against a scratch copy with the September rules merged in, and against prototype engines. No external packages.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Merging the D-04 rules into main's redactor
- **Port the September regexes verbatim, in September's order**, into main's `RULES`:
  - `<private>…</private>` goes first, so a PEM inside it goes as one block.
  - `api-key-lower` goes right after the uppercase assignment rule.
  - `aws`, `google`, `slack`, `npm`, `gitlab`, `digitalocean`, `openai-proj` and `pk`/`rk` go after the provider shapes and before the JWT rule.
  - Criterion 1 says "every September D-04 pattern", so nothing is re-tuned in this phase, except `pk-rk`, which ships in the D18-21 narrowed digit-required form (operator 2026-10-08), the only D-04 pattern not byte-identical to September.
- **Keep main's `redactValue` untouched**: `SENSITIVE_KEY`, `COUNTER_KEY`, `isCount` and the null/undefined pass-through. Take nothing from September's `redactValue`, which predates the exemption.
- **Every rule gets a stable name.** The rule table becomes labelled entries (name, pattern, replacement), and names are unique per pattern entry, e.g. `linear-api` and `linear-oauth`, not one shared `linear`.
  - The names are exported read-only for tests and docs.
  - `redact()` keeps its signature and output. No caller changes.
- **"One test per rule" is a fixture corpus keyed by rule name**, with one planted secret per name. Each fixture is checked three ways:
  - the value is gone, and the surrounding text stays in place;
  - redaction is idempotent;
  - the fixture still matches when wrapped in `redactValue` under a key that is not sensitive.
  A coverage test fails if any rule name has no fixture, so a later phase cannot add a rule without a planted secret.
  - Fixtures are assembled at runtime, as September's `rnd()` and main's `DECOY` already are, so no literal token shape sits in git. That keeps them out of the store-lock and Greptile secret scans.
- **Counter exemption under the new rules:** tests show that `input_tokens`, `output_tokens` and the other `COUNTER_KEY` names keep their numeric and digit-string values after the merge. `{tokens: "<D-04 fixture>"}` and `api_key: "short"` are still redacted whole.
- **Keep September's near-miss tests** (`AKIA` with 15 characters, `api_key: short`, an unclosed `<private>`, a short `pk-`, a short `npm_`) and main's over-redaction guards (`KEYBOARD_LAYOUT`, `MONKEY`).

#### Skill-content redaction and scan in the same module
- **Port the September engine verbatim** into `redact.ts`:
  - `SkillRedactionRule`, `SKILL_HIGH_CONFIDENCE_RULES`, `SkillDocExampleRule`, `SkillRedactionOptions`;
  - the hit types, `SKILL_RULES`, the placeholder logic, `redactSkillContent` and `scanSkillFiles`;
  - all of September's skill tests.
  `redact()` and `redactValue()` stay the liberal event-path pass, as September's "event redactor stays liberal" test asserts.
- **Close the gap D-04 left in the skill pass.** `SKILL_RULES` was written in 04-02, before D-04 (07-03), so a skill holding a Slack or npm token would pass the scan without even being redacted. The skill pass gains:
  - **high-confidence findings** (refused by callers): `google`, `slack`, `npm`, `gitlab`, `digitalocean` and `openai-proj`. `aws` is already one.
  - **contextual redactions:**
    - `pk`/`rk`, because publishable keys are public by design and the shape can collide with hyphenated slugs;
    - `private-tag`;
    - `api-key-lower`, with the usual placeholder handling, so `api_key: $OPENAI_API_KEY` and `apiKey: <your-key>` are kept as written.
  - The skill patterns keep their `[ \t]` line-local whitespace and their `d` flag.
- **Drift guard between the two passes.** A parity test fails when a named event-path rule has no skill rule of the same name and is not on an explicit exclusion list with a reason. Today that list is `keypair-array`, because byte arrays are ordinary code in docs.
  - This replaces deriving one table from the other: the two passes differ in whitespace, ordering and capture groups, and a derivation would hide that.
- **No new generic scan API in this phase.** `scanSkillFiles` is the publication-path scan: findings by file, line and rule, never the value.
  - Phase 25 decides whether `docs_ingest` reuses it as-is or adds a docs profile.
  - Whatever it adds must live in `redact.ts`; the lock enforces that.
- **Known-value scrubbing moves into the module.** `packages/cli/src/lessons.ts:811` replaces the client's own token and connection-string values with `REDACTED` through its own `replaceAll` before calling `redact()`. That is a second redaction step outside the module.
  - `redact.ts` gains a small exported helper, e.g. `redactKnown(text, values)`: longest value first, an empty value ignored.
  - `lessons.ts` calls the helper, and its existing tests keep passing unchanged.

#### The redaction lock (repo check)
- **Location and style:** a new `packages/mcp-server/src/redact-lock.test.ts`, the sibling of `store-lock.test.ts`.
  - It reuses the same idioms: `Bun.Glob` with `dot: true`, ignoring `node_modules/`, `.git/` and `dist/`, and `git ls-files` for non-TS sources.
  - Each rule asserts an offender list equal to `[]`.
  - It runs in plain `bun test`, so it is in every later phase's verification without wiring.
  - `store-lock.test.ts` is not edited.
- **What counts as redacting through something else.** Scope: every tracked source file (`.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.py`, `.sh` and extensionless hook scripts under `packages/`, `scripts/` and `infra/`), excluding `redact.ts` itself and `*.test.ts`.
  1. **Imports.** Any import of a binding named `redact`, `redactValue`, `redactKnown`, `redactSkillContent`, `scanSkillFiles` or `REDACTED`, or of any module whose specifier basename matches `redact`, must resolve to `packages/mcp-server/src/redact.ts`. The specifier is resolved against the importing file's directory.
  2. **Definitions.** No function, method, const or Python `def` named like a redactor or secret scanner (`redact*`, `*Redactor`, `scan*Secret*`, `scanSkill*`) is defined anywhere else.
  3. **Markers.** No `[REDACTED` string literal anywhere else, and no `.replace`/`.replaceAll` whose replacement argument is `REDACTED`.
  4. **Credential-shape detectors.** No regex literal or `new RegExp` holding a credential prefix that `redact.ts` names (for example `gh[pousr]_`, `sk-ant-`, `lin_api_`, `AKIA`, `AIza`, `xoxb-`, `glpat-`, `npm_`, `dop_v1_`, `tskey-`, `PRIVATE KEY`).
     - Runtime-assembled decoys stay legal: `scripts/greptime-smoke.ts`'s `` `ghp_${…}` `` is a string, not a detector.
- **Injected seams are allowed, but must be fed the shared redactor.** `packages/audit` (`log.ts`, `record.ts`) and `packages/observability` (`otlp.ts`) take `redact` as an injected `(text: string) => string` parameter, because importing it would be a cycle (mcp-server depends on them). They are allowlisted by path, with that reason. A companion rule asserts two things:
  - every non-test `new AuditLog(` and `new OtlpExporter(` passes a `redact` that its file imports from the shared module (today: `observe.ts:145,152`);
  - no non-test file outside those packages calls `buildRecord`/`sanitizeField` with a redactor of its own.
- **Detector self-tests.** As `store-lock.test.ts` does for `carriesCredential` and `TOKEN_LITERAL`:
  - each rule's detector is run against planted in-memory offenders (a copied `redact.ts` under another package, a local `function redactSecrets`, a `"[REDACTED]"` literal, a hand-written `/ghp_[A-Za-z0-9]{36}/`, a Python `def redact`);
  - it is also run against planted non-offenders (an import of the shared module from `../../mcp-server/src/redact.ts`, the smoke decoy, the injected-seam signatures).
  A detector that silently matches nothing therefore fails.
- **Installed copies are not second sources.** Phase 19's Muse hook imports the redactor "from a stable installed path". The lock is a check on the repository, so an installed artifact built from `redact.ts` is not a second source.
  - Phase 19 must keep its template's placeholder specifier passing rule 1, or add a narrowly scoped, reasoned exemption in its own PR.
  - This phase does not exempt it in advance.

#### Behaviour changes, docs and proof
- **Accepted write-path effects** (these are LANEB-06 itself, already covered by the accepted defaults and `docs/data-planes.md` "secrets (D-04 redaction)"):
  - D-04 shapes in event summaries and payloads are stored as `[REDACTED]`.
  - Memory bodies holding a D-04 shape or a `<private>` block now classify as `secret` (quarantined, unreleasable) through `memory-classify.ts`'s `redact(text) !== text`.
  - Tests cover one `<private>` memory body and one D-04 shape in `classify()`.
- **Docs:**
  - New flat topic doc `docs/redaction.md`. It covers:
    - the named rule table, in two columns: the event pass and the skill pass;
    - the counter exemption;
    - findings versus redactions;
    - the lock's rules and allowlist;
    - "how a new package redacts" (import path, injected seam);
    - how to add a rule (a name, a fixture, a skill counterpart or a reasoned exclusion).
  - Pointers from `docs/greptime-ledger.md` (the "patterns are in `redact.ts`" paragraph), `docs/memory-governance.md` (the `secret` row) and `docs/observability.md` (the counter-exemption note).
  - Shipped as a PR change, so no CHANGELOG entry is needed unless the repo has one at execution time.
- **Proof:**
  1. The full `bun test` run and a clean `bunx tsc --noEmit`, compared with the v1.3 baseline (1129 pass / 56 skip / 0 fail at `ab62c91`).
     - New failures are fixed.
     - Failures already present at HEAD are recorded, not fixed.
  2. `redact.test.ts` and `redact-lock.test.ts` are named in the verification.
  3. When Phase 16's `bun run rehearsal` is on the base (Phase 18 depends on Phase 16), a harness round trip runs:
     - `rehearsal up`;
     - `POST /events` carrying one event whose summary and payload hold every D-04 fixture plus `input_tokens`/`output_tokens` counts;
     - read back through `events_query`;
     - assert that no fixture value survived and the counts did;
     - `rehearsal down`.
     It sources only `consumer.env`, and it touches no production store.
- **PR live-effect line:** "Redaction widens on the production write path at the operator's next approved restart of `substrate-mcp`; nothing restarts in this PR."

#### Operator answer (2026-10-08)
- **The `pk`/`rk` rule requires a digit in the matched tail (D18-21).**
  - The September regex `\b(?:pk|rk)-[A-Za-z0-9][A-Za-z0-9_-]{19,}` also matches an ordinary identifier such as a 20-character branch name starting `pk-` or `rk-`. On the event path, such a summary will show `[REDACTED]`.
  - Shipped (D18-21): narrowed pattern `\b(?:pk|rk)-(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9][A-Za-z0-9_-]{19,}`; word-only slugs such as `pk-fix-the-bug-in-store` survive; a digit-bearing Langfuse `pk-lf-` key is redacted; no accepted-over-redaction test.
  - This is a documented, tested deviation from September, listed in `docs/redaction.md`.

### Claude's Discretion
- The exact shape of the labelled rule table and of the exported name list, as long as `redact()`'s output and signature are unchanged.
- The rule-name strings, as long as they are unique per pattern entry and shared between the passes where they mean the same shape.
- The name and exact semantics of the known-value helper.
- How the lock parses imports (regex over the source or Bun's transpiler `scanImports`) and resolves specifiers.
- Whether rule 4's prefix list is derived from `redact.ts` at test time or kept as a list in the lock with a test that it covers every named token-shape rule.
- Splitting into plans: for example, merge and skill engine; then lock and `lessons.ts` migration; then docs and harness proof.

### Deferred Ideas (OUT OF SCOPE)
- Redaction rules for RAGFlow and Hindsight key formats, base58 secret keys, and Railway and tailnet hostnames (PITFALLS 6). They belong to the phase that first handles each class (25, 26, 27/28), and are added to `redact.ts` under the lock.
- A docs-specific scan profile and the refuse-on-findings policy for `docs_ingest` (Phase 25).
- Reconciling `grok-hermes-connector`'s `redactor.py` with this module (another repository; a cross-repo test-vector exchange is a candidate for a later milestone).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| LANEB-06 | One shared redactor: main's `redact.ts` gains the September D-04 rules while keeping its `COUNTER_KEY` exemption, and every collector, `docs_ingest`, `skills_propose` and anything anchored uses it. [VERIFIED: .planning/REQUIREMENTS.md:36] | §"Rule inventory" lists all 30 event rules and 29 skill rules with exact regexes and positions. §"Verified behaviour" shows the merge changes no existing test outcome. §"Fixture corpus" holds one fixture per rule, each validated. §"Redaction lock design" gives detectors that are clean on HEAD (one offender, `lessons.ts:811`, which this phase migrates), catch every planted offender, and pass September's consumer tree, so Phases 19/21/22 inherit the lock without exemptions. |
</phase_requirements>

## Summary

The merge is mechanical and low-risk. Main's `RULES` and September's differ by exactly three inserted blocks, 11 regex entries, and by nothing else. Main's `redactValue` differs only by the `COUNTER_KEY`/`isCount` exemption, which September lacks [VERIFIED: `diff` of `acc30a8:packages/mcp-server/src/redact.ts:1-101` against main `redact.ts`]. With those 11 entries inserted into a scratch copy of HEAD, the full suite gave 1127 pass / 56 skip / 2 fail. Both failures were scratch-copy artifacts: git-tracked `node_modules` symlinks made store-lock's `read()` throw `EISDIR`, and they fail identically with the change stashed. **No existing test changes outcome** because of the D-04 rules. None of the 11 D-04 fixtures is redacted by main today.

The skill engine ports verbatim. The planner needs one design decision the CONTEXT left implicit. Event-path names are unique per pattern (30 names), but the skill hit `rule` field is a public family name: `github` covers two patterns, `assignment` three, `password` two. September's tests assert those family names, and September's `propose.ts` prints `hit.rule` into PR bodies. **Give each skill entry a separate `name` (a `RedactionRuleName`) beside its reported `rule`.** The parity test compares `name`s, and hit output stays byte-identical. Prototype engines with the 9 new skill rules pass 30 of September's 31 skill tests unchanged. The one failure is the "every high-confidence rule reports a finding" sample map, which needs six new samples.

The lock is cheap to make precise. Line-anchored regexes over the source run on 45 in-scope files at HEAD. They report exactly one offender: `packages/cli/src/lessons.ts:811`, rule 3, which this phase migrates to `redactKnown`. They catch all 15 planted offenders, false-positive on none of 9 planted non-offenders, and report zero offenders over September's 70-file consumer tree. That last result includes the Muse hook template, because the anchored import regex ignores imports inside string literals. Phases 19/21/22 therefore inherit the lock without exemptions. `Bun.Transpiler.scanImports` should not be the primary import parser, because it drops type-only imports.

**Primary recommendation:** Convert `RULES` to an `as const satisfies` labelled table and derive `RedactionRuleName` from it. Insert 10 September entries verbatim at September's positions plus `pk-rk` in the D18-21 narrowed digit-required form. Port the skill engine with a `name` per entry. Type the fixture corpus, skill exclusions and lock prefix map as `Record<RedactionRuleName, …>`, so `tsc` and the tests both fail when a rule lacks a fixture, a skill counterpart or a detector decision. Build the lock from copied store-lock helpers plus line-anchored regex detectors. Put the harness round trip in `redact.test.ts` as a `describe` gated on `SUBSTRATE_REHEARSAL_NAME`.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Event-path redaction (`redact`, `redactValue`) | API / Backend (`packages/mcp-server/src/redact.ts`) | — | Runs on the write path inside `substrate-mcp` (`event.ts:67,109`, `memory-write.ts:376`, `index-store.ts:1081`). One module, no copies. |
| Skill/publication scan (`redactSkillContent`, `scanSkillFiles`) | API / Backend (same module) | CLI (`packages/cli` passes `SkillDocExampleRule` in Phase 21) | Publication paths refuse on findings, and the engine must sit beside the event rules so the parity test can see both. |
| Known-value scrubbing (`redactKnown`) | Same module | CLI (`lessons.ts` diagnostics) | Removes the one hand-rolled redaction step outside the module. |
| Redaction lock | Test tier (`packages/mcp-server/src/redact-lock.test.ts`) | — | A repo check in plain `bun test`, the sibling of `store-lock.test.ts`. |
| Injected seams | `packages/audit`, `packages/observability` (accept `redact`) | `observe.ts` (feeds the shared `redact`) | Importing would be a cycle. Allowlisted and checked by the companion rule. |
| Live round trip | Test tier, gated (`redact.test.ts`) | Phase 16 harness (`consumer.env`) | Talks to the server only over HTTP. Never names a store key (store-lock rule 1). |
| Docs | `docs/redaction.md` + 3 pointers | — | Locked in CONTEXT. |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Bun runtime + `bun:test` | 1.4.0 [VERIFIED: `bun --version`] | Test runner, `Bun.Glob`, `Bun.spawnSync`, `Bun.Transpiler` | Already the repo's only runtime (`package.json` `"test": "bun test"`, `engines.bun >=1.4.0`) |
| TypeScript | ^5.7.0 devDependency [VERIFIED: package.json] | `bunx tsc --noEmit` gate | `tsconfig.json`: `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` (type-only imports must say `import type`) |

### Supporting
None. The phase adds no dependency.

**Installation:** none.

## Package Legitimacy Audit

No external packages are installed by this phase. **Packages removed:** none. **Packages flagged:** none.

## Rule inventory (event pass)

The order is September's file order, which is main's order with three insertions. "S#" is the line in `acc30a8:packages/mcp-server/src/redact.ts` and "M#" the line in main's `redact.ts` [VERIFIED: both files read this session]. Names are this research's recommendation (CONTEXT leaves them to Claude's discretion; they must be unique per entry).

| # | Proposed name | Pattern (verbatim) | Replacement | S# | M# | Skill counterpart (class) |
|---|---|---|---|---|---|---|
| 1 | `private-tag` (new) | `/<private>[\s\S]*?<\/private>/gi` | `REDACTED` | 21 | — | new `private-tag` (contextual) |
| 2 | `pem` | `/-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g` | `REDACTED_PEM` | 23 | 20 | `pem` (finding; doc-example allowable) |
| 3 | `tailscale` | `/tskey-[A-Za-z0-9_-]+/g` | `REDACTED_TSKEY` | 24 | 21 | `tailscale` (finding) |
| 4 | `password` | `/(password\s*[:=]\s*)(\S+)/gi` | `` `$1${REDACTED}` `` | 25 | 22 | `password` (contextual) |
| 5 | `password-env` | `/\b([A-Z0-9_]*(?:PASSWORD\|PASSWD\|PASS)\s*=\s*)(\S+)/gi` | `` `$1${REDACTED}` `` | 26 | 23 | `password` (contextual) |
| 6 | `daytona` | `/\b(DAYTONA_(?:API_)?KEY\s*=\s*)(\S+)/gi` | `` `$1${REDACTED}` `` | 27 | 24 | `assignment` (contextual) |
| 7 | `vault` | `/\b((?:VAULT_TOKEN\|VAULT_TOKEN_ID\|X-VAULT-TOKEN)\s*[:=]\s*)(\S+)/gi` | `` `$1${REDACTED}` `` | 28 | 25 | `assignment` (contextual) |
| 8 | `assignment` | `/\b((?:[A-Z0-9]+_)*(?:API_?KEY\|APIKEY\|TOKEN\|SECRET\|KEY)(?:_[A-Z0-9]+)*\s*[:=]\s*)(\S+)/g` | `` `$1${REDACTED}` `` | 34 | 31 | `assignment` (contextual) |
| 9 | `api-key-lower` (new) | `` /\b(api[_-]?key)(\s*[:=]\s*["']?)[A-Za-z0-9_\-/.+]{16,}/gi `` | `` `$1$2${REDACTED}` `` | 36 | — | new `api-key-lower` (contextual, placeholders kept) |
| 10 | `authorization` | `/\b(authorization\s*[:=]\s*)(?:bearer\s+)?(\S+)/gi` | `` `$1${REDACTED}` `` | 38 | 33 | `authorization` (contextual) |
| 11 | `bearer` | `/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/g` | `` `Bearer ${REDACTED}` `` | 39 | 34 | `bearer` (contextual) |
| 12 | `url-password` | `/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s@]+)@/gi` | `` `$1:${REDACTED}@` `` | 41 | 36 | `url-password` (contextual) |
| 13 | `linear-api` | `/\blin_api_[A-Za-z0-9]{20,}/g` | `REDACTED` | 43 | 38 | `linear` (finding) |
| 14 | `linear-oauth` | `/\blin_oauth_[A-Za-z0-9]{20,}/g` | `REDACTED` | 44 | 39 | `linear` (finding) |
| 15 | `notion` | `/\b(?:ntn_\|secret_)[A-Za-z0-9]{30,}/g` | `REDACTED` | 45 | 40 | `notion` (finding) |
| 16 | `github` | `/\bgh[pousr]_[A-Za-z0-9]{20,}/g` | `REDACTED` | 46 | 41 | `github` (finding) |
| 17 | `github-pat` | `/\bgithub_pat_[A-Za-z0-9_]{20,}/g` | `REDACTED` | 47 | 42 | `github` (finding) |
| 18 | `xai` | `/\bxai-[A-Za-z0-9]{20,}/g` | `REDACTED` | 48 | 43 | `xai` (finding) |
| 19 | `anthropic` | `/\bsk-ant-[A-Za-z0-9_-]{20,}/g` | `REDACTED` | 49 | 44 | `anthropic` (finding) |
| 20 | `openai` | `/\bsk-(?!ant-)[A-Za-z0-9]{20,}/g` | `REDACTED` | 50 | 45 | `openai` (finding) |
| 21 | `aws` (new on event path) | `/\bAKIA[0-9A-Z]{16}\b/g` | `REDACTED` | 53 | — | `aws` (finding; already in skill pass) |
| 22 | `google` (new) | `/\bAIza[0-9A-Za-z_-]{35}/g` | `REDACTED` | 55 | — | new `google` (finding) |
| 23 | `slack` (new) | `/\bxoxb-[0-9A-Za-z-]{10,}/g` | `REDACTED` | 57 | — | new `slack` (finding) |
| 24 | `npm` (new) | `/\bnpm_[A-Za-z0-9]{36}/g` | `REDACTED` | 59 | — | new `npm` (finding) |
| 25 | `gitlab` (new) | `/\bglpat-[A-Za-z0-9_-]{20,}/g` | `REDACTED` | 61 | — | new `gitlab` (finding) |
| 26 | `digitalocean` (new) | `/\bdop_v1_[a-f0-9]{64}/g` | `REDACTED` | 63 | — | new `digitalocean` (finding) |
| 27 | `openai-proj` (new) | `/\bsk-proj-[A-Za-z0-9_-]{20,}/g` | `REDACTED` | 65 | — | new `openai-proj` (finding) |
| 28 | `pk-rk` (new, D18-21 narrowed — the only D-04 pattern not byte-identical to September) | `/\b(?:pk\|rk)-(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9][A-Za-z0-9_-]{19,}/g` | `REDACTED` | 67 | — | new `pk-rk` (contextual) |
| 29 | `jwt` | `/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g` | `REDACTED` | 69 | 47 | `jwt` (finding; doc-example allowable) |
| 30 | `keypair-array` | `/\[\s*(?:\d{1,3}\s*,\s*){31,}\d{1,3}\s*\]/g` | `REDACTED` | 71 | 49 | **excluded**: "byte arrays are ordinary code in docs" |

(`\|` in the table is the Markdown escape of a regex `|`.)

`pk-rk` is one regex in September, and September's test corpus has two fixtures for it (`pk`, `rk`) [VERIFIED: acc30a8 redact.test.ts:253-254]. Keep it as **one** entry named `pk-rk` and give it two fixtures (both digit-bearing per D18-21). The name rule is per pattern entry. Per operator answer D18-21 (2026-10-08) the shipped pattern is the narrowed digit-required form above, not the byte-identical September regex.

Constants in main: `export const REDACTED = "[REDACTED]"`, `const REDACTED_PEM = "[REDACTED_PEM]"`, `const REDACTED_TSKEY = "[REDACTED_TSKEY]"` [VERIFIED: redact.ts:13-15]. `SENSITIVE_KEY` (line 66) and `COUNTER_KEY` (lines 81-82, quoted below) are unchanged:

```
const SENSITIVE_KEY = /(?:password|passwd|secret|token|api[_-]?key|apikey|authorization|credential|private[_-]?key)/i;
const COUNTER_KEY =
	/^(?:(?:input|output|prompt|completion|total|cached|cache_read|cache_write|max|min|reasoning)_)?tokens?(?:_(?:count|in|out|used))?$/i;
```

## Rule inventory (skill pass)

September `SKILL_RULES` [VERIFIED: acc30a8 redact.ts:175-197], quoted verbatim, in order: `pem`, `jwt`, `github` (`gh[pousr]_`), `github` (`github_pat_`), `anthropic`, `openai`, `xai`, `linear` ×2, `notion`, `tailscale`, `aws` (`/\bAKIA[0-9A-Z]{16}\b/dg`), `password` ×2 (`[ \t]` forms), `assignment` ×3 (DAYTONA, VAULT, generic), `bearer` (placed before `authorization`), `authorization`, `url-password`. `SKILL_HIGH_CONFIDENCE_RULES = ["pem","jwt","github","openai","anthropic","xai","linear","notion","tailscale","aws"]` (lines 131-142). `SkillDocExampleRule = "pem" | "jwt"` (line 145). `PLACEHOLDER_PREFIXES = ["your", "xxx", "...", "***", "example", "changeme", "placeholder", "redacted"]` (line 199).

**New skill entries (recommended exact text; each was prototyped this session).** The six high-confidence entries go **immediately after `aws`**, and `private-tag` and `pk-rk` follow them. `api-key-lower` goes **immediately after the third `assignment` entry**:

```ts
{ rule: "google", pattern: /\bAIza[0-9A-Za-z_-]{35}/dg, value: 0, replacement: REDACTED },
{ rule: "slack", pattern: /\bxoxb-[0-9A-Za-z-]{10,}/dg, value: 0, replacement: REDACTED },
{ rule: "npm", pattern: /\bnpm_[A-Za-z0-9]{36}/dg, value: 0, replacement: REDACTED },
{ rule: "gitlab", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/dg, value: 0, replacement: REDACTED },
{ rule: "digitalocean", pattern: /\bdop_v1_[a-f0-9]{64}/dg, value: 0, replacement: REDACTED },
{ rule: "openai-proj", pattern: /\bsk-proj-[A-Za-z0-9_-]{20,}/dg, value: 0, replacement: REDACTED },
{ rule: "private-tag", pattern: /<private>[\s\S]*?<\/private>/dgi, value: 0, replacement: REDACTED },
{ rule: "pk-rk", pattern: /\b(?:pk|rk)-(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9][A-Za-z0-9_-]{19,}/dg, value: 0, replacement: REDACTED },
// …after the generic `assignment` entry:
{ rule: "api-key-lower", pattern: /\b(api[_-]?key)([ \t]*[:=][ \t]*["']?)([A-Za-z0-9_\-/.+]{16,})/dgi, value: 3, replacement: REDACTED },
```

In the recommended design (Pattern 2), every entry also carries `name: RedactionRuleName`, e.g. `{ name: "github-pat", rule: "github", … }`. `SkillRedactionRule` gains `"google" | "slack" | "npm" | "gitlab" | "digitalocean" | "openai-proj" | "private-tag" | "pk-rk" | "api-key-lower"`. `SKILL_HIGH_CONFIDENCE_RULES` gains the six high-confidence names.

## Verified behaviour (experiments this session)

Experiments ran in `/tmp/p18research`: a scratch `git archive HEAD` copy, prototype engines built from the September file, and nothing written to the worktree.

| Fact | Evidence |
|---|---|
| Main today redacts **none** of the 11 D-04 fixtures, and the merged table redacts all of them, keeping `shipped `/` to staging` | exp1: `main-changes: false` ×11, sept `shipped [REDACTED] to staging` ×10, and `shipped api_key: [REDACTED] to staging` |
| The merge changes no existing test outcome | Scratch tree plus the 21 inserted lines: 1127 pass / 56 skip / 2 fail. The 2 failures are store-lock `EISDIR` from scratch-only tracked `node_modules` symlinks, and fail identically with the change stashed |
| The merge is idempotent across all fixtures | `sept(sept(all)) === sept(all)` → `true` |
| `<private>` wrapping a PEM → one `[REDACTED]` (main gives `<private>⏎[REDACTED_PEM]⏎</private>`) | exp1 |
| `API_KEY=…` is caught by `assignment` first; api-key-lower never double-processes it (`[` is outside its value class) | exp1 `API_KEY=[REDACTED]` |
| api-key-lower **misses** `openai_api_key: <24>` (no `\b` between `_` and `a`) and JSON `{"api_key":"<24>"}` (the closing quote sits between key and colon) | exp1 unchanged. A verbatim port keeps these gaps; record them in docs, do not tune |
| On the event path api-key-lower **crosses a newline** (`\s*`): `api_key:\n  description_of_the_field_here` → `api_key:\n  [REDACTED]` | exp1. The skill pass's `[ \t]` form keeps it |
| `pk-rk` (D18-21 narrowed) redacts a digit-bearing `pk-lf-…` key but leaves word-only slugs such as `pk-fix-the-bug-in-store` and `rk-release-notes-for-october` untouched | narrowed pattern: digit-bearing key → `[REDACTED]`; the two slugs survive `redact()` unchanged |
| `npm_`, `AIza` and `dop_v1_` are fixed-length without a trailing `\b`, so a longer run leaves a tail (`npm_`+40 → `[REDACTED]HOVc`) | exp1. Verbatim, so record it, do not tune |
| `redactValue({input_tokens:1200, output_tokens:"34", tokens:<npm fixture>, api_key:"short", note:<aws>})` → counts kept, `tokens` and `api_key` whole-redacted. Main today leaves `note`'s AKIA intact | exp1 |
| The September skill pass today lets google/slack/npm/gitlab/digitalocean/openai-proj/pk/rk/private/api-key through **unchanged** (aws is a finding) | exp1 "gap" block |
| Prototype engine with the 9 new skill entries: September's skill+event tests 30/31 pass; the only failure is `every high-confidence rule…` (`expect(sample).toBeDefined()` for the new rules) | `bun test sept-after.test.ts sept-first.test.ts` → 60 pass / 2 fail (one per prototype) |
| Skill pass: `api_key: $OPENAI_API_KEY`, `apiKey: <your-key>`, `api_key: your-api-key-goes-here`, `api_key = "xxxx…"` kept, nothing reported. Real `api_key: <24>` → redaction `api-key-lower`. `API_KEY=<24>` → still `assignment`. `GITLAB_TOKEN=glpat-…` → finding `gitlab` (not a silent `assignment` redaction). `Authorization: Bearer npm_…` → finding `npm` | exp2 |
| `private-tag` ordering: **after** the high-confidence block, a `<private>` block holding a GitHub token → finding `github`, rest of block left in the text; with `allowDocExamples:{pem}`, a PEM inside `<private>` → `pem` redaction and the block's other text **survives**. **First** in the table, both cases become one silent `private-tag` redaction (no finding) | exp2 |
| `classify()` on a `<private>` body, on an AKIA body and on a digit-bearing `pk-lf-…` key body → `secret`, `reviewable:false`; bodies holding `pk-fix-the-bug-in-store` or `rk-release-notes-for-october` → `null`; "we keep private notes…" → `null` | D18-21 narrowed expectation (operator 2026-10-08) |
| `lessons.ts` migrated to `redactKnown` (prototype): `lessons.test.ts` 60 pass / 0 fail, `bunx tsc --noEmit` exit 0 | Scratch tree |
| Baseline at HEAD `4752ef0` (no `packages/` or `scripts/` diff from `ab62c91`): `bun test` **1129 pass / 56 skip / 0 fail, 4094 expect() calls, 1185 tests across 40 files**; `bunx tsc --noEmit` exit 0. The run prints two `[substrate] audit of … failed unexpectedly: RangeError: Maximum call stack size exceeded` lines on stderr. This is pre-existing noise from the audit-fault tests, not a failure | Run this session |

## Architecture Patterns

### System Architecture Diagram

```
 agent / collector / CLI / skill author
        │ (text, JSON payload, skill files)
        ▼
 ┌──────────────── packages/mcp-server/src/redact.ts (the only source) ───────────────┐
 │ RULES (30 named, ordered) ──► redact(text) ──► redactValue(json)                    │
 │                                   ▲              │  SENSITIVE_KEY → whole value       │
 │                                   │              └─ COUNTER_KEY+isCount → keep count  │
 │ redactKnown(text, values)  (CLI diagnostics, longest first)                          │
 │ SKILL_RULES (29 named; family `rule`) ──► redactSkillContent ──► scanSkillFiles      │
 │        high-confidence → findings (caller refuses) │ contextual → redactions / kept   │
 └───────┬───────────────┬────────────────┬───────────────┬──────────────────────────────┘
         │ import        │ import          │ inject (seam)  │ import (later phases)
         ▼               ▼                 ▼                ▼
 event.ts / memory-*   cli/lessons.ts   audit log/record,   collectors (19), propose (21),
 service/handoff/...   greptime-smoke   observability otlp  skills-sync (22), docs_ingest (25),
         │                               (fed by observe.ts) anchor (28)
         ▼
 Greptime agent_events / Postgres memory tables (stored already clean)

 redact-lock.test.ts ── scans {packages,scripts,infra}/** (non-test) ── 4 rules + seam rule ── offenders == []
 redact.test.ts ── fixture corpus (Record<RuleName,…>) ── parity (event names ⊆ skill names ∪ exclusions)
        └─ gated describe (SUBSTRATE_REHEARSAL_NAME) ── POST /events → POST /events/query on the scratch twin
```

### Recommended file changes
```
packages/mcp-server/src/
├── redact.ts               # labelled RULES + 11 D-04 entries, skill engine, redactKnown
├── redact.test.ts          # keep main's tests; add corpus, coverage, near-misses, skill, parity, gated round trip
├── redact-lock.test.ts     # NEW: the redaction lock
└── memory-classify.test.ts # + <private> body and one D-04 shape → secret
packages/cli/src/lessons.ts # diagnostic(): redactKnown instead of replaceAll; drop REDACTED import
docs/redaction.md           # NEW topic doc
docs/greptime-ledger.md     # pointer at :150-156
docs/memory-governance.md   # pointer at the `secret` row (:124) / :133-134
docs/observability.md       # pointer in the counter note (:115-120)
```

### Pattern 1: Labelled event table with a derived name type
**What:** One table is the single source of rule names. `as const satisfies` keeps names as literal types, so `Record<RedactionRuleName, …>` elsewhere is checked by `tsc`.
**When:** The `RULES` rewrite in `redact.ts`.
```ts
// Shape only; patterns are the 10 verbatim September patterns plus the D18-21 narrowed pk-rk in the Rule inventory table.
const RULES = [
	{ name: "private-tag", pattern: /<private>[\s\S]*?<\/private>/gi, replacement: REDACTED },
	{ name: "pem", pattern: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g, replacement: REDACTED_PEM },
	// … 28 more, in the order of the Rule inventory table …
] as const satisfies ReadonlyArray<{ name: string; pattern: RegExp; replacement: string }>;

export type RedactionRuleName = (typeof RULES)[number]["name"];

/** Read-only view for tests and docs. `redact()` is the only thing that applies it. */
export const REDACTION_RULES: ReadonlyArray<{ readonly name: RedactionRuleName; readonly pattern: RegExp; readonly replacement: string }> = RULES;

export function redact(text: string): string {
	let out = text;
	for (const { pattern, replacement } of RULES) out = out.replace(pattern, replacement);
	return out;
}
```
`String.prototype.replace` with a global regex resets `lastIndex`, so sharing the `RegExp` objects is safe for `.replace`. Tests must not call `.test()`/`.exec()` on these `/g` patterns; use `text.replace(rule.pattern, …) !== text` [ASSUMED: standard ECMAScript `lastIndex` semantics].

### Pattern 2: Skill entries carry `name` (parity) and `rule` (reported family)
```ts
interface SkillRule {
	/** The event-path rule this entry mirrors; the parity test compares these. */
	name: RedactionRuleName;
	/** What a hit reports. A family: both GitHub shapes report `github`. */
	rule: SkillRedactionRule;
	pattern: RegExp;
	value: number;
	replacement: string;
}
/** Event rules with no skill counterpart, and why. */
export const SKILL_EXCLUSIONS: Partial<Record<RedactionRuleName, string>> = {
	"keypair-array": "byte arrays are ordinary code in docs",
};
```
The parity test: `REDACTION_RULES.map(r => r.name).filter(n => !SKILL_NAMES.includes(n) && !(n in SKILL_EXCLUSIONS))` equals `[]`, and every exclusion key is a real rule name. Export the skill names read-only (e.g. `SKILL_RULE_NAMES`). `redactSkillContent` ignores `name` and reports `rule`, so the hit output is byte-identical to September.

### Pattern 3: Fixture corpus typed by rule name
```ts
interface Fixture { text: string; secret: string } // secret = the substring that must vanish
const FIXTURES: Record<RedactionRuleName, readonly Fixture[]> = { /* one+ per rule, runtime-assembled */ };
```
Per fixture, assert:
1. the entry's own pattern changes it (`text.replace(rule.pattern, "") !== text`), so the rule under test is the one firing and an earlier rule is not shadowing it;
2. `redact(\`shipped ${text} to staging\`)` lacks `secret`, starts with `shipped ` and ends with ` to staging`;
3. a second `redact` is a no-op;
4. `redactValue({ note: wrapped }).note === redact(wrapped)`.

The coverage test is `Object.keys(FIXTURES)` sorted equal to the `REDACTION_RULES` names sorted. `tsc` already enforces it, and the runtime check guards a cast. Also assert the names are unique (`new Set(names).size === names.length`).

**Validated corpus.** All 30 rules pass all four checks [VERIFIED: /tmp/p18research/fixtures.ts → `bad 0`]. `rnd(a, n) = Array.from({length:n}, (_, i) => a[(i*7+3) % a.length]).join("")` is September's helper (acc30a8 redact.test.ts:242-243).

| name | runtime-assembled text |
|---|---|
| private-tag | `"<" + "private>keep this between us</" + "private>"` |
| pem | `["-----BEGIN " + "RSA PRIVATE KEY-----", rnd(ALNUM,32), "-----END " + "RSA PRIVATE KEY-----"].join("\n")` |
| tailscale | `"tskey-" + "auth-" + rnd(ALNUM,16)` |
| password | `"password: " + rnd(ALNUM,10)` |
| password-env | `"DB_PASSWD=" + rnd(ALNUM,10)`. Not `PGPASSWORD=`, which rule `password` claims first |
| daytona | `"DAYTONA_API_KEY=" + rnd(ALNUM,12)` |
| vault | `"X-VAULT-TOKEN: " + rnd(ALNUM,12)` |
| assignment | `"LINEAR_API_KEY=" + rnd(ALNUM,16)`. Never `SUBSTRATE_TOKEN…=` with 16+ chars (store-lock `TOKEN_LITERAL`) |
| api-key-lower | `"api_key: " + rnd(ALNUM,24)` |
| authorization | `"authorization: " + rnd(ALNUM,12)` |
| bearer | `"Bearer " + rnd(ALNUM,24)` |
| url-password | `"postgres://u:" + rnd(ALNUM,12) + "@h/db"` |
| linear-api / linear-oauth | `"lin_api_"`/`"lin_oauth_" + rnd(ALNUM,40)` |
| notion | `"ntn_" + rnd(ALNUM,46)` |
| github / github-pat | `"ghp_" + rnd(ALNUM,36)` / `"github_pat_" + rnd(ALNUM,40)` |
| xai / anthropic / openai | `"xai-" + rnd(ALNUM,64)` / `"sk-ant-api03-" + rnd(ALNUM,40)` / `"sk-" + rnd(ALNUM,48)` |
| aws, google, slack, npm, gitlab, digitalocean, openai-proj | September's `D04_FIXTURES` (acc30a8 redact.test.ts:246-252) |
| pk-rk | `"pk-" + digit-bearing body` and `"rk-" + digit-bearing body` (each body must contain a digit per D18-21; e.g. a `pk-lf-…` shape assembled at runtime) |
| jwt | `["eyJ" + "hbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", rnd(ALNUM,27)].join(".")` |
| keypair-array | `"[" + Array.from({length:64}, (_, i) => (i*37) % 256).join(", ") + "]"` |

### Pattern 4: `redactKnown`
```ts
/** Replace each known value — a configured token, a URL credential — with REDACTED, longest first. Empty values are ignored. */
export function redactKnown(text: string, values: Iterable<string>): string {
	let out = text;
	for (const value of [...values].filter((value) => value.length > 0).sort((a, b) => b.length - a.length)) {
		out = out.replaceAll(value, REDACTED);
	}
	return out;
}
```
`lessons.ts` (prototype verified): the import becomes `{ redact, redactKnown, redactValue }`, dropping `REDACTED`. Delete `const secretValues = …` at line 808. Replace the loop at line 811 with `cleaned = redactKnown(cleaned, secrets);`, where `secrets` is the `Set` built at lines 790-807 and still contains `""` from `connection.token ?? ""`, which the helper drops. Line 814 `return redact(cleaned).slice(0, 200);` stays. Sorting on each call happens only on the diagnostic (error) path. If the planner wants zero repeated work, `lessons.ts` can pass a pre-sorted array and the helper's sort becomes a no-op on sorted input. The semantics stay in the helper either way.

### Pattern 5: The redaction lock (validated prototype)
**Scope:** `Bun.Glob("{packages,scripts,infra}/**/*")` with `dot: true`, skipping `node_modules/`, `.git/` and `dist/`. Keep files ending `.ts|.tsx|.js|.mjs|.cjs|.py|.sh`, plus extensionless files whose text starts with `#!`. Exclude `*.test.ts`, Python tests (`test_*.py` / `*_test.py`, a convention September's packages use: `packages/dispatcher/tests/test_*.py`) and `packages/mcp-server/src/redact.ts`. HEAD has 45 files in scope, and the only non-TS one is `packages/collectors/src/git/post-commit` [VERIFIED]. The glob also sees untracked new files, which is what an executor needs before it commits. CONTEXT's "`git ls-files` for non-TS" can be met by also unioning `git ls-files` results for `.py`/`.sh`/extensionless; the glob alone already covers them.

**Rule 1, imports.** Use a line-anchored regex over the source. Bindings and specifiers come from the same match, and type-only imports are kept:
```ts
const IMPORT = /^[ \t]*(?:import|export)\s+(?:type\s+)?((?:[\w$*\s,]|\{[^}]*\})+?)\s*\bfrom\s*["']([^"']+)["']/gm;
const DYNAMIC = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
```
A statement offends when its clause names one of `redact|redactValue|redactKnown|redactSkillContent|scanSkillFiles|REDACTED`, or its specifier basename (minus extension) matches `/redact/i`, and `resolve(ROOT, dirname(file), spec)` (with `.ts` appended when the spec has no extension) is not `ROOT/packages/mcp-server/src/redact.ts`. For Python: `^\s*from\s+([\w.]+)\s+import\s+(.+)$` where the module matches `/redact/i` or the names include a binding, plus `^\s*import\s+[\w.]*redact`. A Python import can never resolve to the TS module, so any match offends.
- **Why not `Bun.Transpiler.scanImports` alone:** it drops `import type { X } from "./my-redact.ts"` and `import { type Y } from …` entirely, and returns no binding names [VERIFIED: probe returned only `./redact-all.ts` from a mixed sample]. It does skip comments and strings and keeps unused value imports [VERIFIED]. The anchored regex gets the string-literal case right as well: September's Muse template `'import { redact, redactValue } from "__REDACT_MODULE__";'` (acc30a8 `packages/projector/src/muse.ts:73`) starts with a quote, so it is not a match. Phase 19 then needs **no exemption** for it [VERIFIED: an unanchored prototype flagged it; the anchored one does not].

**Rule 2, definitions.** `NAME = (?:redact\w*|\w*Redactor|scan\w*Secret\w*|scanSkill\w*)`:
```ts
new RegExp(String.raw`\bfunction\s*\*?\s*(${NAME})\s*[<(]`, "g"),
new RegExp(String.raw`\b(?:const|let|var)\s+(${NAME})\s*(?::[^=;]+)?=\s*(?:async\s+)?(?:function\b|\([^()]*\)\s*(?::[^=]+?)?=>|[A-Za-z_$][\w$]*\s*=>)`, "g"),
new RegExp(String.raw`^\s*(?:(?:public|private|protected|static|async|override)\s+)*(${NAME})\s*(?:<[^>]*>)?\([^)]*\)\s*(?::[^{=;]+)?\{`, "gm"),
new RegExp(String.raw`\bclass\s+(\w*Redactor)\b`, "g"),
new RegExp(String.raw`^\s*(?:async\s+)?def\s+(${NAME})\s*\(`, "gm"),
new RegExp(String.raw`^\s*(?:function\s+)?(${NAME})\s*\(\)\s*\{`, "gm"), // shell
```
These patterns do not fire on `const redacted = redact(value)…` (`event.ts:67`), `const redact = this.deps.redact ?? (…)` (`otlp.ts:235`) or the `redact: (text: string) => string = (text) => text` parameter (`record.ts:132`) [VERIFIED: planted non-offenders → ok].

**Rule 3, markers.** Per line: `/["'`][^"'`\n]*\[REDACTED/` or `/\.replace(?:All)?\s*\([^;]*?,\s*REDACTED\s*\)/`. HEAD offenders: **only `packages/cli/src/lessons.ts:811`** [VERIFIED], which this phase removes.

**Rule 4, detectors.** Pull regex-literal bodies with `/(?:^|[=(,:;!&|?{}[\s])\/(?![*/])((?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+)\/[dgimsuyv]*/g`, `new RegExp(` string arguments, Python `re.(compile|search|match|fullmatch|sub|findall|finditer|split)(r?"…")` arguments, and in `.sh`/extensionless files any line with `grep|sed|awk|perl`. Test each body against the prefix detectors. **Keep the prefixes as a typed map in the lock:**
```ts
const DETECTOR: Record<RedactionRuleName, RegExp | null> = {
	pem: /PRIVATE KEY/, tailscale: /tskey-/, "linear-api": /lin_api_/, "linear-oauth": /lin_oauth_/, notion: /ntn_/,
	github: /gh\[pousr\]_|\bgh[pousr]_/, "github-pat": /github_pat_/, xai: /xai-/, anthropic: /sk-ant-/,
	openai: /(?<![A-Za-z0-9])sk-/, aws: /AKIA/, google: /AIza/, slack: /xoxb-/, npm: /npm_/, gitlab: /glpat-/,
	digitalocean: /dop_v1_/, "openai-proj": /sk-proj-/, "pk-rk": /\(\?:pk\|rk\)-|(?<![A-Za-z0-9])[pr]k-/,
	jwt: /eyJ/, "private-tag": /<private>/,
	// contextual: no fixed prefix to detect
	password: null, "password-env": null, daytona: null, vault: null, assignment: null, "api-key-lower": null,
	authorization: null, bearer: null, "url-password": null, "keypair-array": null,
};
```
The `Record` type makes `tsc` fail when a later phase adds a rule without a decision. A test asserts that every non-null detector matches its own rule's `pattern.source`, so a detector cannot drift from the rule it guards. Generic prefixes need a left boundary: plain `sk-` occurs inside `task-graph` in September's Python docstrings [VERIFIED: git grep acc30a8]. HEAD and September's tree both have **zero** rule-4 offenders [VERIFIED]. This answers the CONTEXT discretion item: keep the list, typed, and cover it with a test. Do not derive it from regex sources at test time, because the leading literal of `\b(?:pk|rk)-…` or `-----BEGIN[ A-Z]*PRIVATE KEY` is not mechanically extractable.

**Seam rule.** `INJECTED_SEAMS: Record<string, string>` maps each of `packages/audit/src/log.ts`, `packages/audit/src/record.ts` and `packages/observability/src/otlp.ts` to the cycle reason. Assert that each file exists and still accepts a `redact` parameter, so the allowlist cannot go stale, and skip rules 2–4 for exactly these paths. Companion checks:
1. For each non-test file containing `new AuditLog(` or `new OtlpExporter(`, take the balanced-paren argument text. It must hold `redact` in shorthand (`[{,]\s*redact\s*[,}]`) or `redact: redact` form, and the file must have a rule-1 import of `redact` that resolves to the shared module. HEAD: only `observe.ts:145` (`new AuditLog({ path: config.audit.path, redact })`) and `observe.ts:152` (`new OtlpExporter(settings.otlp, { redact })`), with `observe.ts:45` `import { redact } from "./redact.ts";` [VERIFIED]. All other `new AuditLog(`/`new OtlpExporter(` sites are in `*.test.ts`.
2. Non-test files outside `packages/audit/` matching `\b(?:buildRecord|sanitizeField|argDigest)\s*\(`: HEAD has none [VERIFIED: grep]. Assert the list is `[]`, or that each call's last argument is the shared `redact`.

`packages/observability/src/trace.ts:222` `withSpan(…, describe = String)` is a dormant seam with no non-test caller [VERIFIED]. Mention it in `docs/redaction.md`; enforcing it is optional.

**Helpers: copy, don't import.** Importing `store-lock.test.ts` from another test file re-registers all of its tests inside the importer's run [VERIFIED: a 2-file probe ran 2 tests from 1 file]. CONTEXT forbids editing store-lock, so a shared helper module would be a second convention used by one file. Copy `ROOT = join(import.meta.dir, "..", "..", "..")`, `IGNORED`, `filesMatching()` and `read()` (store-lock lines 22, 36, 48-58), and `trackedFiles()` (lines 98-105) if used. Cite store-lock in a comment.

**Self-tests (validated).** Planted offenders, all CAUGHT: `import { redact } from "./redact.ts"` under `packages/collectors`; `import { scrub } from "../lib/redactor.ts"`; a multi-line `import {\n type SkillFileHit,\n scanSkillFiles,\n} from "./copy.ts"`; `from substrate.redact import redact`; `function redactSecrets`; `export const redactLine = (line: string): string => line`; `class TokenRedactor`; Python `def redact`; `const scanForSecrets = async (t) => t`; `"[REDACTED]"`; `line.replaceAll(token, REDACTED)`; `/ghp_[A-Za-z0-9]{36}/g`; `new RegExp("xoxb-[0-9]+")`; `re.compile(r"AKIA…")`; a shell `grep -E 'glpat-…'`. Planted non-offenders, all ok: the cli/scripts/propose imports of the shared module, the smoke decoy, `a / b` division, `const redacted = redact(…)`, the otlp/record seam lines, and a comment.

### Pattern 6: Gated harness round trip in `redact.test.ts`
This mirrors the repo's live-test idiom `const describeLive = PG_URL ? describe : describe.skip;` [VERIFIED: graph-bind.test.ts:344-349]. Keep it in `redact.test.ts`, because the fixtures live there and importing a test file from another re-runs it.
```ts
const REHEARSAL = process.env.SUBSTRATE_REHEARSAL_NAME?.trim(); // only consumer.env sets this
const describeRehearsal = REHEARSAL ? describe : describe.skip;
describeRehearsal("round trip through the rehearsal twin", () => {
	test("no fixture value survives storage and the counts do", async () => {
		const base = process.env.SUBSTRATE_URL ?? "";
		const url = new URL(base);
		// Refuse production before any request: loopback only, never :7410.
		expect(["127.0.0.1", "localhost", "[::1]"]).toContain(url.hostname);
		expect(url.port).not.toBe("7410");
		const token = process.env.SUBSTRATE_TOKEN?.trim();
		const headers = { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
		const session = `rh-${REHEARSAL}-redact-${Date.now().toString(36)}`;
		// POST /events: kind "note", summary = joined fixture texts (< 2000 chars), payload.fixtures = name → text,
		// payload.usage = { input_tokens: 1200, output_tokens: "340" }; expect 202 and stored: true.
		// POST /events/query { session_id: session, include_payload: true }; expect 200, then narrow `events` with
		// `typeof`/`in` guards (no inline casts) and assert:
		//   for every fixture, JSON.stringify(events) does not contain fixture.secret;
		//   usage.input_tokens === 1200 and usage.output_tokens === "340".
	});
});
```
Run: `bun run rehearsal up --name p18`, then `set -a; . "${XDG_RUNTIME_DIR:-/tmp}/substrate-rehearsal/p18/consumer.env"; set +a; bun test packages/mcp-server/src/redact.test.ts`, then `bun run rehearsal down --name p18`. If Phase 16 ships `assertLoopback` in `packages/mcp-server/src/rehearsal-env.ts` (planned in 16-01), import it instead of the two inline `expect`s once it is on the base. Do not import it while it is absent, or `tsc` fails.

### Anti-Patterns to Avoid
- **Taking September's `redact.ts` whole:** it loses `COUNTER_KEY`, and `input_tokens` gets redacted (ARCHITECTURE anti-pattern 2). Insert the 10 verbatim entries plus the D18-21 narrowed `pk-rk`; never copy `redactValue`.
- **Renaming skill hit `rule` values to per-pattern names:** this breaks September's tests (`rule: "github"`, `"assignment"`, `"password"`) and Phase 21's `propose.ts` PR-body format (`- ${hit.file}:${hit.line} ${hit.rule}`, acc30a8 propose.ts:374). Add `name`; keep `rule`.
- **Deriving the skill table from the event table:** CONTEXT forbids it, because whitespace, capture groups and ordering differ.
- **Literal token shapes in tests/docs:** assemble at runtime. Do not write `SUBSTRATE_TOKEN…=` with 16+ chars, a `GREPTIME_URL|USER|PASSWORD` key with a value, or a Railway proxy/app host in any tracked file, docs included. The store-lock `CREDENTIAL`, `RAILWAY_HOST` and `TOKEN_LITERAL` scans cover all tracked files [VERIFIED: store-lock.test.ts:72-95, 268-276, 324-332].
- **Unanchored import regex:** it matches string templates and multi-statement spans; the prototype produced 2 false hits on `service.ts`/`lessons.ts` before anchoring.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Repo file walk | `fs.readdir` recursion | `Bun.Glob(...).scan({ cwd: ROOT, dot: true })` + `IGNORED` (store-lock idiom) | Same semantics as the existing lock, dotfiles included |
| Tracked-file list | Parsing `.git/index` | `Bun.spawnSync(["git","ls-files","-z"])` (store-lock:98-105) | Proven in repo |
| Path resolution of specifiers | String concatenation | `node:path` `resolve(ROOT, dirname(file), spec)` | Handles `../..` correctly |
| Test fixtures | Literal tokens | Runtime assembly (`rnd()`, `"pk-" + …`, store-lock-safe identifiers) | Greptile and store-lock scans |
| Live HTTP client | New client lib | `fetch` + `AbortSignal.timeout`, headers like `chaos-smoke.ts:62-73` | Same wire path every client uses |

**Key insight:** The repo already has every primitive. The work is ordering, naming and typing.

## Runtime State Inventory

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | Existing Greptime `agent_events` rows and Postgres memory/quarantine rows were written under the 20-rule table. Nothing re-redacts them, and append-only forbids it. New rows get the 30-rule table after restart. Identifier normalisation (`normalizeIdentifier`) now also redacts pk/rk-shaped branch or session ids, so a query for such a raw id normalises the same way and still matches *new* rows. Rows stored before the restart hold the unredacted id, so a post-restart query normalises to `[REDACTED]` and misses them [ASSUMED: inferred from `docs/greptime-ledger.md:259-263` and `service.ts:613-616`] | None in this PR. Note it in `docs/redaction.md` |
| Live service config | `substrate-mcp.service` runs the old module until an approved restart | None. Live-effect line per CONTEXT |
| OS-registered state | None | None |
| Secrets/env vars | No names change | None |
| Build artifacts | None (Bun runs TS directly; no `dist/` for mcp-server) | None |

## Common Pitfalls

### Pitfall 1: the skill-side `private-tag` ordering trades a finding for a leak
**What goes wrong:** Placed after the high-confidence block, a PEM inside `<private>` under `allowDocExamples:{pem}` is redacted as `pem`. The overlap check then skips `private-tag`, and the block's other text survives into a published skill. Placed first, a GitHub token inside `<private>` is silently redacted, and the caller gets no finding to rotate on.
**How to avoid:** Use **after**. It keeps September's invariant that "a contextual rule can never claim, and quietly redact, a real token" (acc30a8 redact.ts:169-171), and `allowDocExamples` is CLI-only and opt-in (acc30a8 propose.ts:70). Pin both behaviours in tests and state the edge in `docs/redaction.md`.
**Warning signs:** A future change moving `private-tag` above `pem`.

### Pitfall 2: shadowed rules make "one test per rule" vacuous
**What goes wrong:** `PGPASSWORD=x` is caught by rule 4 `password`, so rule 5 never fires on it. A fixture that full `redact()` clears does not prove that its own rule works.
**How to avoid:** Check 1 in Pattern 3 (the entry's own pattern changes its fixture).

### Pitfall 3: the "every high-confidence rule" September test fails after the port
**What goes wrong:** `expect(sample).toBeDefined()` fails for the six new high-confidence rules.
**How to avoid:** Add samples for them from the D-04 fixtures [VERIFIED: it was the only failing September test against both prototypes].

### Pitfall 4: lock false positives from string templates and generic prefixes
**What goes wrong:** Unanchored import regexes flag code-generation templates, and a bare `sk-` matches `task-graph`.
**How to avoid:** Anchor imports at line start and give generic prefixes a left boundary. Keep the planted non-offender self-tests.

### Pitfall 5: importing store-lock helpers duplicates its suite
**How to avoid:** Copy the helpers [VERIFIED by probe].

### Pitfall 6: `trackedFiles()` + `read()` throws on a tracked directory symlink
**What goes wrong:** `EISDIR` [VERIFIED in the scratch copy]. It does not happen at HEAD.
**How to avoid:** If the lock reads `git ls-files` output, filter by the source-extension/shebang rule first. A symlink to a directory never qualifies.

### Pitfall 7: summary cap
**What goes wrong:** The round-trip summary is capped at `MAX_SUMMARY = 2000` (event.ts:52). The joined fixture texts are 1612 characters [VERIFIED].
**How to avoid:** Assert `summary.length < 2000` in the test, or carry the fixtures in `payload` (`MAX_PAYLOAD_STRING = 4000`, `MAX_PAYLOAD_BYTES = 16_000`, event.ts:54-55).

### Pitfall 8: cross-phase test interaction (Phase 17)
**What goes wrong:** If Phase 17 merges first, its `event-sources.test.ts` asserts that sample payloads (64-hex sha256 values, base58 `tx_sig`, keys such as `transcript_ref`) pass `normalizeEvent` unchanged [CITED: peer message from the Phase 17 researcher].
**How to avoid:** Every D-04 rule requires a `\b`-anchored literal prefix, and `SENSITIVE_KEY` is unchanged, so bare hex and base58 are untouched [VERIFIED: rules quoted above]. Re-run the full suite after rebasing onto main. If `bun run check:phase-close` exists on the base, run it too.

## Code Examples

### Event table insertion points (verbatim September text)
```ts
// first entry
	// ── D-04 structural: a <private> block, first so a PEM inside it goes as one block ─
	[/<private>[\s\S]*?<\/private>/gi, REDACTED],
// right after the uppercase assignment rule
	// D-04 api-key-lower: api_key / apiKey / api-key assignments, any case; keeps the key.
	[/\b(api[_-]?key)(\s*[:=]\s*["']?)[A-Za-z0-9_\-/.+]{16,}/gi, `$1$2${REDACTED}`],
// after `sk-(?!ant-)`, before JWTs
	[/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
	[/\bAIza[0-9A-Za-z_-]{35}/g, REDACTED],
	[/\bxoxb-[0-9A-Za-z-]{10,}/g, REDACTED],
	[/\bnpm_[A-Za-z0-9]{36}/g, REDACTED],
	[/\bglpat-[A-Za-z0-9_-]{20,}/g, REDACTED],
	[/\bdop_v1_[a-f0-9]{64}/g, REDACTED],
	[/\bsk-proj-[A-Za-z0-9_-]{20,}/g, REDACTED],
	[/\b(?:pk|rk)-(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9][A-Za-z0-9_-]{19,}/g, REDACTED], // D18-21 narrowed (digit required); the other rows above are verbatim September text
```
Source: acc30a8 `packages/mcp-server/src/redact.ts:20-21, 35-36, 51-67`. Convert these to `{ name, pattern, replacement }` objects.

### Tests to carry over or add
- Main `redact.test.ts:1-155`: keep all of it (counter exemption 73-143, guards 145-155).
- September `redact.test.ts:86-234` (skill) and `236-310` (D-04 near-misses, idempotency, multi-line private, `redactValue` reach). Merge the duplicate `describe("redact")`/`describe("redactValue")` blocks rather than keeping both copies.
- New tests: corpus × 4 checks (pk-rk fixtures digit-bearing); coverage and uniqueness; parity; D18-21 narrowed `pk-rk` tests (a runtime-assembled digit-bearing `pk-lf-` key redacts; `pk-fix-the-bug-in-store` and `rk-release-notes-for-october` survive `redact()` and `classify()` returns null for them); counters under D-04 (`redactValue({ usage: { input_tokens: 1200, output_tokens: "340" }, tokens: <npm fixture>, api_key: "short" })`); skill placeholder cases for `api-key-lower`; both `private-tag` ordering cases; `redactKnown` (longest first: `["ab","abc"]` over `"abc"` → `[REDACTED]` not `[REDACTED]c`; empty ignored); the gated round trip.
- `memory-classify.test.ts`: `classify("<private>…</private>", "fact")?.reason === "secret"` and `reviewable === false`; one D-04 shape (e.g. the AKIA fixture) → `secret`.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Tuple `RULES` with no names (main) | Labelled table, derived `RedactionRuleName` | This phase | Typed coverage, docs table, lock prefix map |
| Skill engine on a branch only (`acc30a8`) | Same module as the event pass | This phase | Phases 21/22 import from main |
| `lessons.ts` hand-rolled `replaceAll` | `redactKnown` | This phase | Lock rule 3 clean |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Sharing `/g` `RegExp` objects through an exported table is safe because `.replace` resets `lastIndex` | Pattern 1 | Low. A test using `.test()` on them could flake; the recommendation avoids it |
| A2 | Rows stored before restart under unredacted pk/rk-like identifiers won't match post-restart normalised queries | Runtime State Inventory | Low. A documentation note only |
| A3 | Phase 16 lands `scripts/rehearsal.ts`, `consumer.env` keys (`SUBSTRATE_URL`, `SUBSTRATE_TOKEN`, `SUBSTRATE_REHEARSAL_TOKENS_DIR`, `SUBSTRATE_REHEARSAL_NAME`, `SUBSTRATE_TEST_PG_URL`) and `assertLoopback` as planned | Pattern 6 | Medium. The plans exist (16-01/16-03), but the code is not on the base yet. Re-read the as-built names before wiring |
| A4 | Stripe-style keys use underscores (`pk_live_…`), so September's hyphen `pk-`/`rk-` rule mostly matches non-Stripe shapes and slugs | Open Questions | Low. Informs the operator's default only |

## Open Questions (RESOLVED)

- Q1 RESOLVED: the operator answer (2026-10-08, CONTEXT D18-21) narrowed the pk-rk rule to require a digit in the tail; 18-01 ships the narrowed pattern with pinned tests.
- Q2 RESOLVED: both branches of the gated round trip (D18-19) are planned in 18-04.
- Q3 RESOLVED: Phase 17's `check:phase-close` is intentionally not edited; `redact-lock.test.ts` runs in plain `bun test`.

1. **The `pk-rk` rule (operator — ANSWERED 2026-10-08).**
   - What we know: September's rule redacted 20+-char `pk-`/`rk-` slugs, including branch names, on the event path, and a memory body containing one became an unreleasable `secret` [VERIFIED: classify experiment]. The operator narrowed it (D18-21): the shipped pattern requires at least one digit in the matched tail, so a digit-bearing `pk-lf-…` key still redacts while `pk-fix-the-bug-in-store` and `rk-release-notes-for-october` survive `redact()` and return null from `classify()`.
   - Shipped: the narrowed pattern on both passes with pinned tests and a `docs/redaction.md` deviation note. The verbatim September regex is superseded for this rule only.
2. **Is Phase 16's harness on the base at execution time?**
   - What we know: the base today has no `scripts/rehearsal.ts` and no `rehearsal` package script [VERIFIED: `ls scripts`, package.json]. Docker 29.6.2 is available.
   - Recommendation: the gated test is real code that skips when not sourced. The final plan's proof step runs it if `scripts/rehearsal.ts` exists after rebasing. Otherwise it records "harness round trip not run: Phase 16 not on base", which is CONTEXT's conditional, and states that in the PR.
3. **Adding `redact-lock.test.ts` to Phase 17's `check:phase-close` list.** It already runs in plain `bun test`. Adding it means editing Phase 17's script, so do so only if Phase 17 is merged and the orchestrator agrees.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Bun | all tests, tsc via bunx | ✓ | 1.4.0 | — |
| git | lock (`ls-files`), reading `acc30a8` | ✓ | — | — |
| Docker | Phase 16 harness round trip only | ✓ | 29.6.2 | Skip the gated test |
| Phase 16 harness (`bun run rehearsal`) | Round-trip proof | ✗ (not on base) | — | Gated describe skips; proof recorded as conditional |

**Missing dependencies with no fallback:** none for the core deliverable.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `bun:test` (Bun 1.4.0) |
| Config file | none (`package.json` `"test": "bun test"`; `tsconfig.json` for `tsc`) |
| Quick run command | `bun test packages/mcp-server/src/redact.test.ts packages/mcp-server/src/redact-lock.test.ts` |
| Full suite command | `bun test && bunx tsc --noEmit` |
| Baseline | 1129 pass / 56 skip / 0 fail, 40 files, tsc clean (HEAD 4752ef0 = ab62c91 code) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| LANEB-06 (SC1) | Every September D-04 pattern is redacted, one fixture per named rule (4 checks each), coverage and unique names | unit | `bun test packages/mcp-server/src/redact.test.ts` | ✅ extend |
| LANEB-06 (SC1) | `COUNTER_KEY` counts survive under the new rules; `{tokens: <fixture>}`, `api_key: "short"` whole-redacted | unit | same | ✅ extend |
| LANEB-06 (SC1) | Near-misses kept; KEYBOARD_LAYOUT/MONKEY guards; D18-21 narrowed pk-rk pinned (digit-bearing key redacts, word-only slugs survive) | unit | same | ✅ extend |
| LANEB-06 (SC2) | Skill engine in the same module; September skill tests; new findings/redactions; placeholders; parity with exclusions | unit | same | ✅ extend |
| LANEB-06 (SC2) | The repo check fails on any other redaction path; clean on the tree; catches planted offenders; seam rule | unit (repo) | `bun test packages/mcp-server/src/redact-lock.test.ts` | ❌ Wave 0 (new) |
| LANEB-06 | `redactKnown` semantics; `lessons.ts` unchanged behaviour | unit | `bun test packages/mcp-server/src/redact.test.ts packages/cli/src/lessons.test.ts` | ✅ |
| LANEB-06 | `<private>` and D-04 memory bodies → `secret` | unit | `bun test packages/mcp-server/src/memory-classify.test.ts` | ✅ extend |
| LANEB-06 | Store lock stays green with new tests and docs | unit (repo) | `bun test packages/mcp-server/src/store-lock.test.ts` | ✅ |
| LANEB-06 | Harness round trip: no fixture survives, counts do | live-isolated (gated) | `set -a; . <run dir>/consumer.env; set +a; bun test packages/mcp-server/src/redact.test.ts` between `bun run rehearsal up` and `down` | ✅ (gated block) / harness ❌ until Phase 16 is on base |

### Sampling Rate
- **Per task commit:** the quick run command, plus `bunx tsc --noEmit`.
- **Per wave merge:** `bun test && bunx tsc --noEmit`.
- **Phase gate:** full suite green against the baseline (expect +1 file, `redact-lock.test.ts`; more passes; skips +1 or more from the gated block) before `/gsd:verify-work`. Also run `bun run check:phase-close` if Phase 17 has put it on the base.

### Wave 0 Gaps
- [ ] `packages/mcp-server/src/redact-lock.test.ts` covers LANEB-06 SC2.
- No framework install, no shared fixtures file (fixtures live in `redact.test.ts`).

## Security Domain

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | — |
| V3 Session Management | no | — |
| V4 Access Control | no | — |
| V5 Input Validation / Output encoding | yes | Write-path redaction before storage (`redact`/`redactValue`), redaction before truncation (event.ts:57-69) |
| V6 Cryptography | no | — |
| V7 Error handling and logging | yes | Errors and diagnostics are redacted (`service.ts:589,641,693`, `lessons.ts` diagnostics); never log values |
| V8 Data protection | yes | Secrets never persisted (quarantine holds the redacted body); publication paths refuse on findings |
| V14 Configuration | yes | No secrets in repo (store-lock); fixtures runtime-assembled |

### Known Threat Patterns
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Second, divergent redactor in a new package | Information disclosure | Redaction lock rules 1–4 plus the seam rule |
| Credential in an event or memory body | Information disclosure | 30-rule event pass, `secret` quarantine |
| Credential in a published skill | Information disclosure | High-confidence findings → caller refuses |
| Over-redaction destroying usage counts | Tampering (data integrity) | `COUNTER_KEY` + `isCount` kept, with tests |
| Test or doc leaking a real token | Information disclosure | Runtime assembly; store-lock scans; desk rule (no tokens or hostnames) |
| Round trip hitting production | Tampering | Gate on `SUBSTRATE_REHEARSAL_NAME`; loopback-only and not-7410 assertion before any request |

## Sources

### Primary (HIGH confidence)
- `packages/mcp-server/src/redact.ts` (main, read in full) and `git show acc30a8:packages/mcp-server/src/redact.ts` (full); `diff` of the two.
- `packages/mcp-server/src/redact.test.ts` (main 1-155), `acc30a8:…/redact.test.ts` (1-310).
- `packages/mcp-server/src/store-lock.test.ts` (1-362).
- `packages/cli/src/lessons.ts:23, 763-815`; `observe.ts:45,145,152`; `otlp.ts:204-215,235-253`; `audit/src/log.ts:81,119,127,295,643`; `record.ts:116-137,180-243`; `memory-classify.ts:152`; `event.ts:52-69,109`; `server.ts:330-372`; `service.ts:188-221`; `types.ts:70-85` (EVENT_KINDS contains `"note"`); `mcp.ts:91-97`; `graph-bind.test.ts:344-349`; `chaos-smoke.ts:62-148`; `greptime-smoke.ts:37-40`.
- Phase 16: `16-CONTEXT.md` (harness lifecycle, consumer.env), `16-01-PLAN.md` (rehearsal-env builders, `assertLoopback`), `16-03-PLAN.md` (`scripts/rehearsal.ts`, smoke), `16-04-PLAN.md` (docs/rehearsal.md contract).
- Phase 17: `/root/src/worktrees/agent-substrate-v13-p17/.planning/phases/17-event-vocabulary-and-audit-policy/17-CONTEXT.md:77-83` (`check:phase-close`).
- Experiments: `/tmp/p18research/{exp1,exp2,fixtures,lock-proto2,lock-sept}.ts`, scratch tree full-suite runs, Bun.Transpiler probes, the test-import probe.

### Secondary (MEDIUM confidence)
- Peer message from `Phase17DiscussPlan.Research17` on `event-sources.test.ts` sample shapes.

### Docs to touch (current wording)
- `docs/greptime-ledger.md:150-156`: "The patterns are in `redact.ts`, ported from `grok-hermes-connector`'s `redactor.py`." Add a pointer to `docs/redaction.md` (named rules, D-04).
- `docs/memory-governance.md:124` (`| \`secret\` | the write-path redactor changed the text | **no** |`) and `:133-134`. Add a pointer, and note that `<private>` blocks and D-04 shapes now quarantine.
- `docs/observability.md:115-120` (the "A bug this surfaced" counter note). Add a pointer to the counter-exemption section of `docs/redaction.md`.
- Optional: `docs/mcp-audit.md:162-164` (injected redactor) and `docs/lessons-bank.md:55-57` (diagnostic scrubbing → `redactKnown`).
- No `CHANGELOG*` at the repo root [VERIFIED: root listing].

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH. No new dependencies; versions probed.
- Architecture: HIGH. Every recommended structure was prototyped (engine, fixtures, lock, helper migration).
- Pitfalls: HIGH. Each was reproduced except A2 (an inference about legacy rows).

**Research date:** 2026-10-08
**Valid until:** 2026-11-07 (stable in-repo domain; re-check Phase 16/17 as-built names on rebase)
