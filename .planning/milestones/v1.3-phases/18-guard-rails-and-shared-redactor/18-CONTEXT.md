# Phase 18: Guard rails and shared redactor - Context

**Gathered:** 2026-10-08
**Status:** Ready for planning
**Mode:** Smart discuss, auto-accepted under the v1.3 run rules (`.planning/STATE.md`, "v1.3 decisions"). No answer changes a user-visible contract beyond what LANEB-06 already asks for. The operator's 2026-10-08 answer on the `pk`/`rk` rule is recorded as D18-21 below.

<domain>
## Phase Boundary

One PR on agent-substrate (LANEB-06). It delivers three things:

1. **One redactor.** `packages/mcp-server/src/redact.ts` on main gains the September D-04 rules from `acc30a8:packages/mcp-server/src/redact.ts`. It keeps main's `COUNTER_KEY`/`isCount` exemption, so `input_tokens` and the other counts survive `redactValue` (research ARCHITECTURE, anti-pattern 2).
2. **The skill pass in the same module.** The September skill-content engine moves into the same file: `redactSkillContent`, `scanSkillFiles`, `SKILL_HIGH_CONFIDENCE_RULES` and their types, from commit `70c75a0` (04-02, D-18). Phase 21 (`skills_propose`) and Phase 22 (the skills sync) import it from there.
3. **A redaction lock.** A repo check in `bun test` fails when any package redacts through anything other than this module. Phases 19 (collectors), 21 (`skills_propose`), 25 (`docs_ingest`) and 28 (anchoring) inherit the shared redactor because the alternative fails the check.

**Proof (isolated, no live system):**
- `redact.test.ts` runs over a fixture corpus with one planted secret per named rule.
- The redaction lock passes on the tree and catches planted offenders.
- Once Phase 16's harness is on the base, one round trip through the rehearsal twin.

**Out of scope:**
- The consumers themselves:
  - collectors and the Cursor `stop` hook (19);
  - `skills_propose` and `propose.ts` (21);
  - skills sync and miners (22);
  - `docs_ingest` and its refuse-on-findings policy (25);
  - the anchor job (28).
- New credential shapes that September did not have: RAGFlow (retired) and Hindsight keys, base58 secret keys, Railway and tailnet hostnames (PITFALLS 6). The phase that first handles each one adds its rule to this module, and the lock enforces that.
- `grok-hermes-connector`'s `redactor.py`, which lives in another repository.
- `EVENT_KINDS` and the audit policy: unchanged (Phase 17).
- Restarting production onto the new rules. The PR changes write-path behaviour only when the operator restarts `substrate-mcp` in an approved window.

</domain>

<decisions>
## Implementation Decisions

### Merging the D-04 rules into main's redactor
- **D18-01:** Port the September regexes verbatim, in September's order, into main's `RULES`:
  - `<private>…</private>` goes first, so a PEM inside it goes as one block.
  - `api-key-lower` goes right after the uppercase assignment rule.
  - `aws`, `google`, `slack`, `npm`, `gitlab`, `digitalocean`, `openai-proj` and `pk`/`rk` go after the provider shapes and before the JWT rule.
  - Criterion 1 says "every September D-04 pattern", so nothing is re-tuned in this phase, except `pk`/`rk`, which the operator narrowed on 2026-10-08 (D18-21).
- **D18-02:** Keep main's `redactValue` untouched: `SENSITIVE_KEY`, `COUNTER_KEY`, `isCount` and the null/undefined pass-through. Take nothing from September's `redactValue`, which predates the exemption.
- **D18-03:** Every rule gets a stable name. The rule table becomes labelled entries (name, pattern, replacement), and names are unique per pattern entry, e.g. `linear-api` and `linear-oauth`, not one shared `linear`.
  - The names are exported read-only for tests and docs.
  - `redact()` keeps its signature and output. No caller changes.
- **D18-04:** "One test per rule" is a fixture corpus keyed by rule name, with one planted secret per name. Each fixture is checked three ways:
  - the value is gone, and the surrounding text stays in place;
  - redaction is idempotent;
  - the fixture still matches when wrapped in `redactValue` under a key that is not sensitive.
  A coverage test fails if any rule name has no fixture, so a later phase cannot add a rule without a planted secret.
  - Fixtures are assembled at runtime, as September's `rnd()` and main's `DECOY` already are, so no literal token shape sits in git. That keeps them out of the store-lock and Greptile secret scans.
- **D18-05:** Counter exemption under the new rules: tests show that `input_tokens`, `output_tokens` and the other `COUNTER_KEY` names keep their numeric and digit-string values after the merge. `{tokens: "<D-04 fixture>"}` and `api_key: "short"` are still redacted whole.
- **D18-06:** Keep September's near-miss tests (`AKIA` with 15 characters, `api_key: short`, an unclosed `<private>`, a short `pk-`, a short `npm_`) and main's over-redaction guards (`KEYBOARD_LAYOUT`, `MONKEY`).

### Skill-content redaction and scan in the same module
- **D18-07:** Port the September skill engine verbatim into `redact.ts`:
  - `SkillRedactionRule`, `SKILL_HIGH_CONFIDENCE_RULES`, `SkillDocExampleRule`, `SkillRedactionOptions`;
  - the hit types, `SKILL_RULES`, the placeholder logic, `redactSkillContent` and `scanSkillFiles`;
  - all of September's skill tests.
  `redact()` and `redactValue()` stay the liberal event-path pass, as September's "event redactor stays liberal" test asserts.
- **D18-08:** Close the gap D-04 left in the skill pass. `SKILL_RULES` was written in 04-02, before D-04 (07-03), so a skill holding a Slack or npm token would pass the scan without even being redacted. The skill pass gains:
  - **high-confidence findings** (refused by callers): `google`, `slack`, `npm`, `gitlab`, `digitalocean` and `openai-proj`. `aws` is already one.
  - **contextual redactions:**
    - `pk`/`rk`, because publishable keys are public by design and the shape can collide with hyphenated slugs;
    - `private-tag`;
    - `api-key-lower`, with the usual placeholder handling, so `api_key: $OPENAI_API_KEY` and `apiKey: <your-key>` are kept as written.
  - The skill patterns keep their `[ \t]` line-local whitespace and their `d` flag.
- **D18-09:** Drift guard between the two passes. A parity test fails when a named event-path rule has no skill rule of the same name and is not on an explicit exclusion list with a reason. Today that list is `keypair-array`, because byte arrays are ordinary code in docs.
  - This replaces deriving one table from the other: the two passes differ in whitespace, ordering and capture groups, and a derivation would hide that.
- **D18-10:** No new generic scan API in this phase. `scanSkillFiles` is the publication-path scan: findings by file, line and rule, never the value.
  - Phase 25 decides whether `docs_ingest` reuses it as-is or adds a docs profile.
  - Whatever it adds must live in `redact.ts`; the lock enforces that.
- **D18-11:** Known-value scrubbing moves into the module. `packages/cli/src/lessons.ts:811` replaces the client's own token and connection-string values with `REDACTED` through its own `replaceAll` before calling `redact()`. That is a second redaction step outside the module.
  - `redact.ts` gains a small exported helper, e.g. `redactKnown(text, values)`: longest value first, an empty value ignored.
  - `lessons.ts` calls the helper, and its existing tests keep passing unchanged.

### The redaction lock (repo check)
- **D18-12:** The lock's location and style: a new `packages/mcp-server/src/redact-lock.test.ts`, the sibling of `store-lock.test.ts`.
  - It reuses the same idioms: `Bun.Glob` with `dot: true`, ignoring `node_modules/`, `.git/` and `dist/`, and `git ls-files` for non-TS sources.
  - Each rule asserts an offender list equal to `[]`.
  - It runs in plain `bun test`, so it is in every later phase's verification without wiring.
  - `store-lock.test.ts` is not edited.
- **D18-13:** What counts as redacting through something else. Scope: every tracked source file (`.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.py`, `.sh` and extensionless hook scripts under `packages/`, `scripts/` and `infra/`), excluding `redact.ts` itself and `*.test.ts`.
  1. **Imports.** Any import of a binding named `redact`, `redactValue`, `redactKnown`, `redactSkillContent`, `scanSkillFiles` or `REDACTED`, or of any module whose specifier basename matches `redact`, must resolve to `packages/mcp-server/src/redact.ts`. The specifier is resolved against the importing file's directory.
  2. **Definitions.** No function, method, const or Python `def` named like a redactor or secret scanner (`redact*`, `*Redactor`, `scan*Secret*`, `scanSkill*`) is defined anywhere else.
  3. **Markers.** No `[REDACTED` string literal anywhere else, and no `.replace`/`.replaceAll` whose replacement argument is `REDACTED`.
  4. **Credential-shape detectors.** No regex literal or `new RegExp` holding a credential prefix that `redact.ts` names (for example `gh[pousr]_`, `sk-ant-`, `lin_api_`, `AKIA`, `AIza`, `xoxb-`, `glpat-`, `npm_`, `dop_v1_`, `tskey-`, `PRIVATE KEY`).
     - Runtime-assembled decoys stay legal: `scripts/greptime-smoke.ts`'s `` `ghp_${…}` `` is a string, not a detector.
- **D18-14:** Injected seams are allowed, but must be fed the shared redactor. `packages/audit` (`log.ts`, `record.ts`) and `packages/observability` (`otlp.ts`) take `redact` as an injected `(text: string) => string` parameter, because importing it would be a cycle (mcp-server depends on them). They are allowlisted by path, with that reason. A companion rule asserts two things:
  - every non-test `new AuditLog(` and `new OtlpExporter(` passes a `redact` that its file imports from the shared module (today: `observe.ts:145,152`);
  - no non-test file outside those packages calls `buildRecord`/`sanitizeField` with a redactor of its own.
- **D18-15:** Detector self-tests, as `store-lock.test.ts` does for `carriesCredential` and `TOKEN_LITERAL`:
  - each rule's detector is run against planted in-memory offenders (a copied `redact.ts` under another package, a local `function redactSecrets`, a `"[REDACTED]"` literal, a hand-written `/ghp_[A-Za-z0-9]{36}/`, a Python `def redact`);
  - it is also run against planted non-offenders (an import of the shared module from `../../mcp-server/src/redact.ts`, the smoke decoy, the injected-seam signatures).
  A detector that silently matches nothing therefore fails.
- **D18-16:** Installed copies are not second sources. Phase 19's Muse hook imports the redactor "from a stable installed path". The lock is a check on the repository, so an installed artifact built from `redact.ts` is not a second source.
  - Phase 19 must keep its template's placeholder specifier passing rule 1, or add a narrowly scoped, reasoned exemption in its own PR.
  - This phase does not exempt it in advance.

### Behaviour changes, docs and proof
- **D18-17:** Accepted write-path effects (these are LANEB-06 itself, already covered by the accepted defaults and `docs/data-planes.md` "secrets (D-04 redaction)"):
  - D-04 shapes in event summaries and payloads are stored as `[REDACTED]`.
  - Memory bodies holding a D-04 shape or a `<private>` block now classify as `secret` (quarantined, unreleasable) through `memory-classify.ts`'s `redact(text) !== text`.
  - Tests cover one `<private>` memory body and one D-04 shape in `classify()`.
- **D18-18:** Docs:
  - New flat topic doc `docs/redaction.md`. It covers:
    - the named rule table, in two columns: the event pass and the skill pass;
    - the counter exemption;
    - findings versus redactions;
    - the lock's rules and allowlist;
    - "how a new package redacts" (import path, injected seam);
    - how to add a rule (a name, a fixture, a skill counterpart or a reasoned exclusion).
  - Pointers from `docs/greptime-ledger.md` (the "patterns are in `redact.ts`" paragraph), `docs/memory-governance.md` (the `secret` row) and `docs/observability.md` (the counter-exemption note).
  - Shipped as a PR change, so no CHANGELOG entry is needed unless the repo has one at execution time.
- **D18-19:** Proof:
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
- **D18-20:** PR live-effect line: "Redaction widens on the production write path at the operator's next approved restart of `substrate-mcp`; nothing restarts in this PR."

### Operator answer (2026-10-08)
- **D18-21:** The `pk`/`rk` rule requires at least one digit in the matched tail (operator, 2026-10-08; documented, tested deviation from the verbatim September rule).
  - September's regex `\b(?:pk|rk)-[A-Za-z0-9][A-Za-z0-9_-]{19,}` also matched word-only slugs such as a branch name starting `pk-` or `rk-`, which showed `[REDACTED]` on the event path and quarantined memory bodies as `secret`.
  - Narrowed pattern (event and skill pass): `\b(?:pk|rk)-(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9][A-Za-z0-9_-]{19,}` (skill pass keeps its `dg` flags). This is the only D-04 pattern that is not byte-identical to September.
  - Tests: a Langfuse-shaped `pk-lf-…` key containing digits is redacted; `pk-fix-the-bug-in-store` and `rk-release-notes-for-october` are not redacted, and `classify()` no longer quarantines them; `docs/redaction.md` lists the deviation.

### Claude's Discretion
- The exact shape of the labelled rule table and of the exported name list, as long as `redact()`'s output and signature are unchanged.
- The rule-name strings, as long as they are unique per pattern entry and shared between the passes where they mean the same shape.
- The name and exact semantics of the known-value helper.
- How the lock parses imports (regex over the source or Bun's transpiler `scanImports`) and resolves specifiers.
- Whether rule 4's prefix list is derived from `redact.ts` at test time or kept as a list in the lock with a test that it covers every named token-shape rule.
- Splitting into plans: for example, merge and skill engine; then lock and `lessons.ts` migration; then docs and harness proof.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/mcp-server/src/redact.ts` (main): `REDACTED`, a 20-entry `RULES` array, `redact`, `SENSITIVE_KEY`, `COUNTER_KEY`, `isCount` and `redactValue`.
- `acc30a8:packages/mcp-server/src/redact.ts` (+209 lines over the common base) and `redact.test.ts` (310 lines):
  - the D-04 block (commit `cc124b5`, 07-03);
  - the skill engine (commit `70c75a0`, 04-02);
  - tests with runtime fixtures (`rnd()`, `D04_FIXTURES`) and skill tests.
  Read them with `git show acc30a8:<path>`. Do not merge the branch.
- `packages/mcp-server/src/redact.test.ts` (main, 155 lines): tests for the counter exemption and the over-redaction guards. They are kept and extended.
- `packages/mcp-server/src/store-lock.test.ts`: the repo-check idiom. It provides `ROOT`, `filesMatching()` (Bun.Glob, `dot: true`, ignored dirs), `read()`, `trackedFiles()` (`git ls-files -z`), the `expect(offenders).toEqual([])` style and the detector self-tests.
- `scripts/greptime-smoke.ts:40`: the precedent for a runtime-assembled decoy (`` `ghp_${"A".repeat(36)}` ``).

### Established Patterns
- **Current importers**, all from the shared module:
  - inside mcp-server: `event.ts`, `handoff.ts`, `index-store.ts`, `memory-classify.ts`, `memory-write.ts`, `observe.ts` and `service.ts`;
  - `packages/cli/src/lessons.ts` and `scripts/greptime-smoke.ts`, through `../../mcp-server/src/redact.ts` and `../packages/mcp-server/src/redact.ts`.
  No other package defines a redactor today.
- **Injected seams:**
  - `packages/audit/src/log.ts` (`AuditLogOptions.redact`, default identity);
  - `packages/audit/src/record.ts` (`sanitizeField`/`argDigest`/`buildRecord` take `redact`);
  - `packages/observability/src/otlp.ts` (`deps.redact`, default identity).
  `observe.ts:145,152` feeds all of them the shared `redact`.
- **The one hand-rolled step:** `packages/cli/src/lessons.ts:811` (`cleaned.replaceAll(secret, REDACTED)`), which runs before `redact(cleaned)`.
- **September consumers that later phases port**, all importing `../../mcp-server/src/redact.ts` or `../redact.ts`:
  - `collectors/{cursor-stop,herdr-map,muse}.ts`;
  - `projector/{muse,skills-sync}.ts` (the Muse template uses the placeholder `__REDACT_MODULE__`);
  - `mcp-server/src/skills/propose.ts` (`redact`, `redactSkillContent`, `scanSkillFiles`, `SkillDocExampleRule`, `SkillFileHit`);
  - `cli/src/index.ts` (the type `SkillDocExampleRule`);
  - `host/*` and `desktop/driver.ts`.
  None of them carries its own pattern. The Python miner and dispatcher on `acc30a8` do not redact.
- No tracked `.py`, `.sh`, `.js`, `.mjs` or `.cjs` source exists on main today. `packages/collectors/src/git/post-commit` is an extensionless hook with no redaction.
- `memory-classify.ts:152` treats `redact(text) !== text` as `secret`, so every rule added widens memory quarantine.
- Tests are colocated `*.test.ts` files, run by `bun test`, with no CI workflow in the repo. The lock tests are the guard rails.

### Integration Points
- `packages/mcp-server/src/redact.ts`: the merge, the labelled rules, the skill engine and the known-value helper.
- `packages/mcp-server/src/redact.test.ts`: the fixture corpus, coverage, skill and parity tests.
- New file `packages/mcp-server/src/redact-lock.test.ts`.
- `packages/cli/src/lessons.ts`: migrate to the helper.
- `packages/mcp-server/src/memory-classify.test.ts`: the D-04 and `<private>` cases.
- Docs: new `docs/redaction.md`; pointers in `docs/greptime-ledger.md`, `docs/memory-governance.md` and `docs/observability.md`.
- The Phase 16 harness (`bun run rehearsal`, `consumer.env`) for the round-trip proof.

</code_context>

<specifics>
## Specific Ideas

- The September tests are the starting corpus: `D04_FIXTURES`, the near misses, idempotency and the multi-line `<private>` block, plus all the skill tests. Main's counter tests stay as they are.
- The lock reads like `store-lock.test.ts`: a header comment states each rule and why, in the same voice ("a second door").
- Results never name a value. Skill hits and lock offenders report file, line and rule only.

</specifics>

<deferred>
## Deferred Ideas

- Redaction rules for RAGFlow (retired) and Hindsight key formats, base58 secret keys, and Railway and tailnet hostnames (PITFALLS 6). They belong to the phase that first handles each class (25, 26, 27/28), and are added to `redact.ts` under the lock.
- A docs-specific scan profile and the refuse-on-findings policy for `docs_ingest` (Phase 25).
- Reconciling `grok-hermes-connector`'s `redactor.py` with this module (another repository; a cross-repo test-vector exchange is a candidate for a later milestone).

</deferred>
