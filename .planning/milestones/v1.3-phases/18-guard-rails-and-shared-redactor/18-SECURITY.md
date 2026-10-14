---
phase: "18"
slug: "guard-rails-and-shared-redactor"
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
block_on: high
register_authored_at_plan_time: true
created: "2026-10-09"
---

# Phase 18 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| agent text → `redact()` → Greptime/Postgres write path | untrusted summaries and payloads cross into append-only stores | credential shapes in event text and payloads (high) |
| memory body → `classify()` → quarantine | a missed shape becomes releasable memory | credential shapes in memory bodies (high) |
| skill file text → `redactSkillContent`/`scanSkillFiles` → PR body or publish decision | untrusted skill content crosses toward publication on agent-skills | token shapes in skill files (high) |
| event pass ↔ skill pass | a rule added to one pass but not the other leaves a silent gap | rule table integrity |
| any package source → publication (events, skills, docs, anchors) | a second redactor diverges silently from the shared rules | rule table integrity (high) |
| `packages/audit`, `packages/observability` ← shared `redact` | injected seams must carry the real redactor, not identity | audit records, OTLP spans (high) |
| gated test → `SUBSTRATE_URL` | a misconfigured URL sends fixture secrets at production | fixture secrets, scratch bearer |
| docs → future rule authors | wrong guidance breeds the next second redactor | contract text |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-18-01 | Information disclosure | `redact.ts` event pass | high | mitigate | D-04 merged into the one `RULES` table (`packages/mcp-server/src/redact.ts:18-72`, 30 named entries: `private-tag` first at `:20`, `api-key-lower` `:35`, `aws`/`google`/`slack`/`npm`/`gitlab`/`digitalocean`/`openai-proj` `:52-64`, `pk-rk` narrowed per D18-21 `:67`); `redact()` applies every entry (`:80-84`). `FIXTURES: Record<RedactionRuleName, …>` (`redact.test.ts:209-261`) makes `tsc` fail on a fixture-less rule; coverage asserts 30 unique names and fixture-key equality (`:270-278`); per fixture: own pattern fires, `redact` removes the secret with surrounding text intact, idempotent, reachable through `redactValue` (`:280-307`); D-04 near-misses survive (`:329-350`) | closed |
| T-18-02 | Denial of service (utility) | `redactValue` counter exemption | medium | mitigate | `COUNTER_KEY` + `isCount` (`redact.ts:108-123`) exempt only listed count keys holding finite numbers or digit strings (`:131-133`); D18-05 test `D-04 counter exemption` (`redact.test.ts:314-327`) pins `input_tokens: 1200` and `output_tokens: "340"` surviving while `tokens: <AWS key>` and `api_key: "short"` go `[REDACTED]`; existing counter suite (`:104-175`) green | closed |
| T-18-03 | Information disclosure | `memory-classify` secret quarantine | high | mitigate | `classify()` returns `reason: "secret"`, `reviewable: false` whenever `redact(text) !== text` (`memory-classify.ts:151-160`), so every widened rule quarantines; D18-17 tests: private-tag body (`memory-classify.test.ts:29`), AWS-shaped body (`:37`), digit-bearing `pk-` body (`:46`) all secret and unreleasable; prose and word-only `pk-`/`rk-` slugs not quarantined (`:54`) | closed |
| T-18-04 | Information disclosure | `SKILL_RULES` gap on D-04 shapes | high | mitigate | `SKILL_HIGH_CONFIDENCE_RULES` (`redact.ts:187-204`) holds `aws`, `google`, `slack`, `npm`, `gitlab`, `digitalocean`, `openai-proj`; matching `SKILL_RULES` entries (`:245-251`) sit before every contextual rule (`:252-265`) so a contextual rule cannot claim a real token; test `every high-confidence rule reports a finding rather than a redaction` (`redact.test.ts:424-450`) iterates the whole list with samples for each; findings never carry the value (`:410-423`); a `<private>` block holding a GitHub token still reports the `github` finding (`:519`) | closed |
| T-18-05 | Tampering | event/skill pass drift | medium | mitigate | every `SKILL_RULES` entry carries its `RedactionRuleName` (`redact.ts:217-226`), exported as `SKILL_RULE_NAMES` (`:272`); `SKILL_EXCLUSIONS` holds only `keypair-array` with a reason (`:268-270`); D18-09 parity suite (`redact.test.ts:548-564`) fails on any event rule with neither a skill entry nor a reasoned exclusion, on an exclusion naming no real rule, and on any exclusion beyond `keypair-array` | closed |
| T-18-06 | Tampering | second redactor outside `redact.ts` | high | mitigate | `redact-lock.test.ts` scans `{packages,scripts,infra}/**` incl. dotfiles and shebang scripts (`:55-91`): rule 1 imports resolve to the shared module (`:120-145`, `:308`), rule 2 no redactor definitions (`:149-179`, `:315`), rule 3 no `[REDACTED` marker / `REDACTED` replace (`:183-192`, `:325`), rule 4 no hand-rolled credential-prefix regex (`:201-271`, `:335`) with `DETECTOR: Record<RedactionRuleName, RegExp \| null>` (`:215-246`) forcing a decision per new rule; D18-15 self-tests prove each detector matches its own rule source (`:345`) and every rule catches planted offenders while passing decoys (`:514-558`); `lessons.ts` diagnostics migrated to shared `redactKnown` + `redact` (`packages/cli/src/lessons.ts:20`, `:809-814`), leaving no second marker in tree | closed |
| T-18-07 | Information disclosure | injected seam fed identity instead of `redact` | high | mitigate | `INJECTED_SEAMS` names exactly `audit/src/log.ts`, `audit/src/record.ts`, `observability/src/otlp.ts` with the cycle reason (`redact-lock.test.ts:282-289`); seams still type `redact: (text: string) => string` (`:354-362`); D18-14 companion asserts the set of `new AuditLog`/`new OtlpExporter` callers equals `[observe.ts]`, each call passes the shared `redact`, and `observe.ts` imports it from `./redact.ts` (`:364-382`); no outside file calls `buildRecord`/`sanitizeField`/`argDigest` (`:384-390`) | closed |
| T-18-08 | Information disclosure | round trip aimed at production | high | mitigate | round trip runs only under `SUBSTRATE_REHEARSAL_NAME` (`redact.test.ts:571`, skipped otherwise); twin guard asserts non-empty `SUBSTRATE_URL`, loopback host (`127.0.0.1`/`::1`/`localhost`, IPv6 brackets stripped) and port ≠ 7410 before the first `fetch` (`:586-593`, first request `:604`); run-tagged session/graph id (`:598`); 18-04-SUMMARY records only `consumer.env` sourced, only this file run, twin on `127.0.0.1:36061`, gated run 174 pass / 0 fail, `rehearsal down` with no instance left | closed |
| T-18-09 | Tampering | doc guidance drift from code | low | accept | `docs/redaction.md` rule table checked at audit: all 30 `REDACTION_RULES` names present (0 missing); parity (T-18-05) and coverage (T-18-01) tests, not docs, enforce truth; see AR-18-01 | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

### Notes (non-blocking)

- In the skill pass, `pk-rk`, `private-tag` and `api-key-lower` are contextual redactions, not findings, so a real digit-bearing `pk-`/`rk-` key in a skill file is rewritten and reported, not refused. This matches D18-08 (18-CONTEXT `:64-65`, 18-02-PLAN must-have `:24`). The 18-02 deviation that moved the `pk-rk` test from `findings` to `redactions` brought the test in line with that decision. It did not weaken any code. A `<private>` block wrapping a high-confidence shape still reports the inner finding (`redact.test.ts:519`).
- The T-18-08 twin guard is test-local. Isolation from production rests mainly on the Phase 16 harness (`consumer.env` written by `rehearsal up`, T-16-08/T-16-13). The guard is the backstop that stops the run before any request if that env points elsewhere.
- Operational evidence for T-18-08 (sourced env, twin teardown) comes from 18-04-SUMMARY and was not re-run at audit. Re-running would need the Docker-backed twin, and this gate does not have it.

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-18-01 | T-18-09 | Docs are guidance, not enforcement. A rule added without a doc row is caught by the `FIXTURES`/`DETECTOR` `Record<RedactionRuleName, …>` types and the parity suite, not by the doc. Doc drift can only mislead an author, and review against `REDACTION_RULES` catches that. Audit check: all 30 rule names present in `docs/redaction.md`. Low severity, below the `high` block threshold. | plan-time disposition (18-04-PLAN threat register, accept) | 2026-10-09 |

*Accepted risks do not resurface in future audit runs.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-10-09 | 9 | 9 | 0 | gsd-secure-phase (State B, ASVS L1 grep-depth + targeted tests; auditor short-circuited: register authored at plan time, threats_open 0, asvs_level 1) |

Audit verification run: `bun test packages/mcp-server/src/redact.test.ts packages/mcp-server/src/redact-lock.test.ts packages/mcp-server/src/memory-classify.test.ts` reported 209 pass / 1 skip / 0 fail. The skip is the env-gated harness round trip.

No `## Threat Flags` sections exist in 18-01..18-04 SUMMARY, so the plan-time register was the complete scope. The workflow's user gate (Step 4) was not reached because no threats were open. The run was non-interactive (autonomous milestone).

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-10-09
