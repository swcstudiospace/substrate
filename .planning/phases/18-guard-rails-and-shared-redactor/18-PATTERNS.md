# Phase 18: Guard rails and shared redactor - Pattern Map

**Mapped:** 2026-10-08
**Files analyzed:** 10 (2 new, 8 modified), plus 2 optional doc pointers
**Analogs found:** 10 / 10

All analog paths below are git-tracked on this worktree (`git ls-files` checked). September sources are read only with `git show acc30a8:<path>`. Do not merge or check out that commit.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `packages/mcp-server/src/redact.ts` (M) | utility (shared module) | transform | main `redact.ts` + `acc30a8:packages/mcp-server/src/redact.ts` | exact (same file, two versions) |
| `packages/mcp-server/src/redact.test.ts` (M) | test (unit) | transform | main `redact.test.ts` + `acc30a8:packages/mcp-server/src/redact.test.ts` | exact |
| `packages/mcp-server/src/redact-lock.test.ts` (NEW) | test (repo check) | batch / file-I/O | `packages/mcp-server/src/store-lock.test.ts` | exact (sibling lock) |
| gated round-trip `describe` inside `redact.test.ts` | test (live, gated) | request-response (HTTP) | `graph-bind.test.ts:344-346` (gate) + `scripts/chaos-smoke.ts:62-73` (headers) | role-match |
| `packages/cli/src/lessons.ts` (M) | client utility (diagnostics) | transform | itself, `lessons.ts:23, 789-815` | exact (migration in place) |
| `packages/mcp-server/src/memory-classify.test.ts` (M) | test (unit) | transform | itself, `memory-classify.test.ts:4-28` | exact |
| `docs/redaction.md` (NEW) | doc (flat topic) | — | `docs/mcp-audit.md` (header/voice), `docs/memory-governance.md:542-552` ("The lock") | role-match |
| `docs/greptime-ledger.md` (M) | doc pointer | — | itself `:149-156` | exact |
| `docs/memory-governance.md` (M) | doc pointer | — | itself `:124`, `:133-134` | exact |
| `docs/observability.md` (M) | doc pointer | — | itself `:115-120` | exact |
| `docs/mcp-audit.md` (M, optional) | doc pointer | — | itself `:162-164` | exact |
| `docs/lessons-bank.md` (M, optional) | doc pointer | — | itself `:55-57` | exact |

Not touched, and not to be touched: `store-lock.test.ts`, which CONTEXT locks. The injected seams `packages/audit/src/{log,record}.ts` and `packages/observability/src/otlp.ts` are read only. They are the lock's allowlist subjects, not edit targets.

---

## Pattern Assignments

### `packages/mcp-server/src/redact.ts` (utility, transform)

**Analogs:** main `packages/mcp-server/src/redact.ts` (the base, kept), and `acc30a8:packages/mcp-server/src/redact.ts` (the source of the 11 D-04 entries and the skill engine, lines 103-286).

**Module header + constants (main lines 1-15, keep; extend the header with September's D-04 clause from acc30a8 lines 7-8):**
```ts
 * substrate actually handles: Linear, Notion, GitHub, xAI, Anthropic, OpenAI,
 * Railway, bearer tokens, JWTs and passworded connection URLs, and the classes
 * agentmemory's /remember does not filter (D-04).
 ...
export const REDACTED = "[REDACTED]";
const REDACTED_PEM = "[REDACTED_PEM]";
const REDACTED_TSKEY = "[REDACTED_TSKEY]";
```

**Current rule table shape, which is replaced (main lines 17-50):** the tuple form `const RULES: ReadonlyArray<readonly [RegExp, string]> = [ [/…/g, REDACTED], … ]`, with the section comments `// ── from redactor.py ──` and `// ── credentials this substrate touches ──`. Keep the section comments. Convert each tuple to `{ name, pattern, replacement }`.

**D-04 insertions, verbatim (acc30a8 lines 20-21, 35-36, 51-67), at September's positions:**
```ts
	// ── D-04 structural: a <private> block, first so a PEM inside it goes as one block ─
	[/<private>[\s\S]*?<\/private>/gi, REDACTED],
	// ── from redactor.py ── (pem, tailscale, password, password-env, daytona, vault)
	…
	[/\b((?:[A-Z0-9]+_)*(?:API_?KEY|APIKEY|TOKEN|SECRET|KEY)(?:_[A-Z0-9]+)*\s*[:=]\s*)(\S+)/g, `$1${REDACTED}`],
	// D-04 api-key-lower: api_key / apiKey / api-key assignments, any case; keeps the key.
	[/\b(api[_-]?key)(\s*[:=]\s*["']?)[A-Za-z0-9_\-/.+]{16,}/gi, `$1$2${REDACTED}`],
	…
	[/\bsk-(?!ant-)[A-Za-z0-9]{20,}/g, REDACTED],
	// ── D-04: shapes agentmemory's /remember does not filter ──────────────────
	// aws: AWS access key id.
	[/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
	// google: Google API key.
	[/\bAIza[0-9A-Za-z_-]{35}/g, REDACTED],
	// slack: Slack bot token.
	[/\bxoxb-[0-9A-Za-z-]{10,}/g, REDACTED],
	// npm: npm access token.
	[/\bnpm_[A-Za-z0-9]{36}/g, REDACTED],
	// gitlab: GitLab personal access token.
	[/\bglpat-[A-Za-z0-9_-]{20,}/g, REDACTED],
	// digitalocean: DigitalOcean personal access token.
	[/\bdop_v1_[a-f0-9]{64}/g, REDACTED],
	// openai-proj: OpenAI project key (the sk- rule above stops at its second hyphen).
	[/\bsk-proj-[A-Za-z0-9_-]{20,}/g, REDACTED],
	// pk / rk: publishable and restricted keys (D18-21 narrowed: digit required in the tail; the only D-04 pattern not byte-identical to September).
	[/\b(?:pk|rk)-(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9][A-Za-z0-9_-]{19,}/g, REDACTED],
	// JWTs.  (then keypair-array last)
```
The 30 names, in order, are in RESEARCH §"Rule inventory (event pass)": `private-tag, pem, tailscale, password, password-env, daytona, vault, assignment, api-key-lower, authorization, bearer, url-password, linear-api, linear-oauth, notion, github, github-pat, xai, anthropic, openai, aws, google, slack, npm, gitlab, digitalocean, openai-proj, pk-rk, jwt, keypair-array`.

**Target shape for the labelled table (RESEARCH Pattern 1; Claude's discretion):**
```ts
const RULES = [
	{ name: "private-tag", pattern: /<private>[\s\S]*?<\/private>/gi, replacement: REDACTED },
	{ name: "pem", pattern: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g, replacement: REDACTED_PEM },
	// …
] as const satisfies ReadonlyArray<{ name: string; pattern: RegExp; replacement: string }>;

export type RedactionRuleName = (typeof RULES)[number]["name"];
export const REDACTION_RULES: ReadonlyArray<{ readonly name: RedactionRuleName; readonly pattern: RegExp; readonly replacement: string }> = RULES;
```

**`redact()` (main lines 52-57): keep the signature and loop. Only the destructure changes:**
```ts
/** Redact a single string. Returns it unchanged when nothing matches. */
export function redact(text: string): string {
	let out = text;
	for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);   // → for (const { pattern, replacement } of RULES)
	return out;
}
```

**`redactValue` block (main lines 59-110): DO NOT TOUCH.** This includes `SENSITIVE_KEY` (66), `COUNTER_KEY` (81-82), `isCount` (93-96) and `redactValue` (98-110), with its `!(COUNTER_KEY.test(key) && isCount(inner))` clause. Never take acc30a8 lines 81-101: September's `redactValue` predates the counter exemption.

**Skill engine: append verbatim from acc30a8 lines 103-286**, after `redactValue`:
- `// ── skill content (D-18) ──` header comment (105-113);
- `SkillRedactionRule` union (114-129), extended with `"google" | "slack" | "npm" | "gitlab" | "digitalocean" | "openai-proj" | "private-tag" | "pk-rk" | "api-key-lower"`;
- `SKILL_HIGH_CONFIDENCE_RULES` (131-142), extended with the six high-confidence names;
- `SkillDocExampleRule`, `SkillRedactionOptions`, `SkillRedactionHit`, `SkillFileHit` (145-158), unchanged;
- `interface SkillRule` (160-166), gaining `name: RedactionRuleName` (RESEARCH Pattern 2);
- `SKILL_RULES` (175-197), each entry gaining `name`, with the 9 new entries placed as in RESEARCH §"Rule inventory (skill pass)": six high-confidence entries + `private-tag` + `pk-rk` right after `aws` (line 187), and `api-key-lower` right after the third `assignment` (line 192);
- `PLACEHOLDER_PREFIXES`, `isPlaceholder`, `Claim`, `redactSkillContent`, `scanSkillFiles` (199-286), unchanged. The destructure at line 229 `for (const { rule, pattern, value, replacement } of SKILL_RULES)` already ignores `name`, so the hit output stays byte-identical.

Skill-entry shape to copy (acc30a8 lines 187, 192):
```ts
	{ rule: "aws", pattern: /\bAKIA[0-9A-Z]{16}\b/dg, value: 0, replacement: REDACTED },
	…
	{ rule: "assignment", pattern: /\b((?:[A-Z0-9]+_)*(?:API_?KEY|APIKEY|TOKEN|SECRET|KEY)(?:_[A-Z0-9]+)*[ \t]*[:=][ \t]*)(\S+)/dg, value: 2, replacement: REDACTED },
```
→ e.g. `{ name: "github-pat", rule: "github", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/dg, value: 0, replacement: REDACTED }`. Every skill pattern keeps the `d` flag and the `[ \t]` line-local whitespace.

**Doc-comment update:** acc30a8 lines 168-174 ("The patterns of `RULES`, labelled, plus `aws` (skills only)… The keypair-array rule has no skill counterpart") must now say that `aws` is on both paths, and point to `SKILL_EXCLUSIONS`:
```ts
export const SKILL_EXCLUSIONS: Partial<Record<RedactionRuleName, string>> = {
	"keypair-array": "byte arrays are ordinary code in docs",
};
```
Also export a read-only list of skill names (e.g. `SKILL_RULE_NAMES`) for the parity test.

**`redactKnown` (new, no in-repo analog for the export; the semantics come from `lessons.ts:808,811`):**
```ts
// lessons.ts:808, 811, the behaviour being moved into the module:
const secretValues = [...secrets].filter(Boolean).sort((a, b) => b.length - a.length);
for (const secret of secretValues) cleaned = cleaned.replaceAll(secret, REDACTED);
```
→ `export function redactKnown(text: string, values: Iterable<string>): string`, which drops empty values, replaces longest first, and uses `REDACTED` (RESEARCH Pattern 4).

---

### `packages/mcp-server/src/redact.test.ts` (test, transform)

**Analogs:** main `redact.test.ts` (1-155, all kept) and `acc30a8:…/redact.test.ts` (1-310).

**Imports (acc30a8 lines 1-3). Merge them into one statement; inline `type` is legal under `verbatimModuleSyntax`:**
```ts
import { describe, expect, test } from "bun:test";
import { REDACTED, redact, redactValue } from "./redact.ts";
import { SKILL_HIGH_CONFIDENCE_RULES, redactSkillContent, scanSkillFiles, type SkillRedactionRule } from "./redact.ts";
```
Add `REDACTION_RULES`, `redactKnown`, `SKILL_EXCLUSIONS`, the skill-name list and `type RedactionRuleName`.

**Blocks to keep from main, unchanged:** `describe("redact")` 4-46, `describe("redactValue")` 48-72, `describe("token counts are counts, not credentials")` 74-143, `describe("over-redaction guards")` 145-155. acc30a8 lines 5-84 duplicate main 4-72 and 145-155, so do not paste them twice.

**Runtime fixture helper (acc30a8 lines 236-243), the canonical "no literal token shape in git" idiom:**
```ts
// ── D-04: the classes agentmemory's /remember does not filter (07-03) ──────────
// Deterministic run-time fixtures: the source never holds a literal token shape.
const UPPER_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const HEX = "0123456789abcdef";
const DIGITS = "0123456789";
const rnd = (alphabet: string, n: number) =>
	Array.from({ length: n }, (_, i) => alphabet[(i * 7 + 3) % alphabet.length]).join("");
```
**Fixture-split idiom (acc30a8 lines 86-90).** Split the prefix with `+` so no scanner sees a whole shape:
```ts
const GITHUB = "ghp_" + "A1b2".repeat(9);
const PEM = ["-----BEGIN " + "RSA PRIVATE KEY-----", "MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn", "-----END " + "RSA PRIVATE KEY-----"].join("\n");
const JWT = ["eyJ" + "hbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dBjftJeZ4CVPmB92K27uhbUJU1p1r"].join(".");
const AWS = "AKIA" + "QWERTYUIOPASDFGH";
```

**Corpus pattern to generalise (acc30a8 lines 245-271).** `D04_FIXTURES: Record<string, string>` becomes `FIXTURES: Record<RedactionRuleName, readonly Fixture[]>` with all 30 names (texts in RESEARCH Pattern 3). Keep the assertion style, with the fixture name as the message argument:
```ts
		for (const [name, value] of Object.entries(D04_FIXTURES)) {
			const out = redact(`shipped ${value} to staging`);
			expect(out, name).toContain(REDACTED);
			expect(out, name).not.toContain(value);
			expect(out.startsWith("shipped "), name).toBe(true);
			expect(out.endsWith(" to staging"), name).toBe(true);
		}
```
Add the own-pattern check (`text.replace(rule.pattern, "") !== text`, never `.test()` on a `/g` regex), idempotency, the `redactValue({ note })` equivalence, coverage (sorted names equal) and uniqueness.

**Carry over verbatim:**
- near-misses (acc30a8 281-291);
- idempotency (293-300);
- the multi-line `<private>` block (302-304);
- `redactValue` reach (306-309);
- the api-key-lower key-kept test (273-279);
- every skill `describe` (92-234), including "event redactor stays liberal" (228-234).

**The one September skill test that must be extended (acc30a8 lines 165-185).** Add six samples to the `samples` map, from the corpus, for `google`, `slack`, `npm`, `gitlab`, `digitalocean` and `openai-proj`:
```ts
		const samples: Partial<Record<SkillRedactionRule, string>> = {
			pem: PEM, jwt: JWT, github: GITHUB,
			openai: "sk-" + "Q9w8".repeat(12),
			…
			aws: AWS,
		};
		for (const rule of SKILL_HIGH_CONFIDENCE_RULES) {
			const sample = samples[rule];
			expect(sample).toBeDefined();
```

**Narrowed pk-rk tests (D18-21, main 145-149 style).** Beside the `KEYBOARD_LAYOUT`/`MONKEY` guards:
```ts
describe("over-redaction guards", () => {
	test("a word merely containing KEY is not treated as a secret", () => {
		expect(redact("KEYBOARD_LAYOUT=us")).toBe("KEYBOARD_LAYOUT=us");
		expect(redact("MONKEY=banana")).toBe("MONKEY=banana");
	});
```
→ new tests proving the digit-required deviation: a runtime-assembled digit-bearing `pk-lf-` key redacts, while `pk-fix-the-bug-in-store` and `rk-release-notes-for-october` survive `redact()` unchanged. The pk-rk fixtures (pk- and rk- bodies) must each contain a digit.

**Counter exemption under D-04 (main 74-143 voice: a regression comment explaining why, then exact `toEqual`/`toBe`):** `redactValue({ usage: { input_tokens: 1200, output_tokens: "340" }, tokens: <npm fixture>, api_key: "short" })`.

---

### Gated round-trip `describe` in `redact.test.ts` (test, live request-response)

**Gate analog (`graph-bind.test.ts:344-349`):**
```ts
const PG_URL = process.env.SUBSTRATE_TEST_PG_URL?.trim();
const describeLive = PG_URL ? describe : describe.skip;
/** Namespaced so a shared database is left as found: every row here carries it. */
const RUN = `gbtest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
```
→ `const REHEARSAL = process.env.SUBSTRATE_REHEARSAL_NAME?.trim(); const describeRehearsal = REHEARSAL ? describe : describe.skip;`, with a namespaced `session` id.

**Header analog (`scripts/chaos-smoke.ts:62-73`):**
```ts
function headers(): Record<string, string> {
	const token = process.env.SUBSTRATE_TOKEN?.trim();
	return {
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
		...(token ? { authorization: `Bearer ${token}` } : {}),
	};
}
```
**Caps to respect (`event.ts:52-55`):** `MAX_SUMMARY = 2000`, `MAX_PAYLOAD_STRING = 4000`, `MAX_PAYLOAD_BYTES = 16_000`. The payload goes through `capStrings(redactValue(payload ?? {}), MAX_PAYLOAD_STRING)` at `event.ts:109`, so the redaction happens before the cap.

**Phase 16 status:** the base has no `scripts/rehearsal.ts` and no `rehearsal` script in `package.json`. The scripts are only `test`, `check`, `smoke:greptime` and `smoke:chaos`. Use inline loopback/not-7410 `expect`s. Do not import a not-yet-landed `assertLoopback`.

---

### `packages/mcp-server/src/redact-lock.test.ts` (NEW: repo-check test, batch/file-I/O)

**Analog:** `packages/mcp-server/src/store-lock.test.ts`. Copy its helpers; do not import them. Importing a test file re-registers its suite (RESEARCH Pitfall 5), and CONTEXT forbids editing store-lock.

**Header comment voice (store-lock lines 1-17).** Numbered rules, each with its "why", then a pointer to the doc:
```ts
/**
 * The store lock, enforced against the tree rather than only written down.
 *
 * Four rules that a reviewer would otherwise have to remember:
 *
 *   1. Greptime is reached only through substrate-mcp. If a collector, the CLI or
 *      the projector grew its own client, redaction and the hash chain would no
 *      longer be unskippable — they live on this package's write path.
 *   …
 *   4. Memory is written only through the governance gate. Same argument as the
 *      first rule: the reason RBAC, quarantine and exactly-once cannot be
 *      forgotten is that there is no second door past them.
 *
 * See `docs/greptime-ledger.md` and `docs/memory-governance.md`.
 */
```
→ "The redaction lock…": rules 1-4 plus the seam rule, "a second door", and `See docs/redaction.md`.

**Imports + ROOT + IGNORED (store-lock lines 18-22, 36):**
```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const IGNORED = ["node_modules/", ".git/", "dist/"];
```
Add `dirname` and `resolve` from `node:path` for specifier resolution: `resolve(ROOT, dirname(file), spec)`.

**Named-allowlist-with-reason idiom (store-lock lines 25-41).** Copy this for `INJECTED_SEAMS`:
```ts
/**
 * The one file outside this package allowed to hold the ledger client.
 *
 * `scripts/greptime-smoke.ts` is the live proof harness: … Naming it
 * rather than exempting `scripts/` wholesale means the next file that wants
 * direct access has to be argued for here.
 */
const SMOKE_HARNESS = join("scripts", "greptime-smoke.ts");
…
function mayReachLedger(path: string): boolean {
	return path.startsWith(LEDGER_PACKAGE) || path === SMOKE_HARNESS;
}
```
→ `const INJECTED_SEAMS: Record<string, string> = { "packages/audit/src/log.ts": "<cycle reason>", "packages/audit/src/record.ts": …, "packages/observability/src/otlp.ts": … }`. Quote the reason from `record.ts:207-209` / `otlp.ts:204-207`: "the redactor lives in `packages/mcp-server`, which depends on this package; importing it back would be a cycle."

**File walk (store-lock lines 43-58), copied verbatim:**
```ts
async function filesMatching(pattern: string): Promise<string[]> {
	const found: string[] = [];
	for await (const path of new Bun.Glob(pattern).scan({ cwd: ROOT, dot: true })) {
		if (!IGNORED.some((prefix) => path.includes(prefix))) found.push(path);
	}
	return found;
}

function read(path: string): string {
	return readFileSync(join(ROOT, path), "utf8");
}
```
→ scope `filesMatching("{packages,scripts,infra}/**/*")`. Keep `.ts|.tsx|.js|.mjs|.cjs|.py|.sh` plus extensionless files whose text starts with `#!`. Exclude `*.test.ts`, `test_*.py`, `*_test.py` and `packages/mcp-server/src/redact.ts`. Today's only non-TS in-scope file is `packages/collectors/src/git/post-commit`.

**Tracked-file list (store-lock lines 97-105), copied if the lock unions `git ls-files` for non-TS sources.** Filter by extension or shebang **before** `read()` (RESEARCH Pitfall 6, `EISDIR`):
```ts
function trackedFiles(): string[] {
	const listed = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT });
	if (!listed.success) throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
	return listed.stdout
		.toString()
		.split("\0")
		.filter((path) => path.length > 0);
}
```

**Offender-list assertion style (store-lock lines 108-114):**
```ts
	test("no package outside the MCP server imports the ledger client", async () => {
		const offenders = (await filesMatching("**/*.ts"))
			.filter((path) => !mayReachLedger(path))
			.filter((path) => /from\s+["'][^"']*greptime(\.ts)?["']|new\s+GreptimeClient/.test(read(path)));

		expect(offenders).toEqual([]);
	});
```
Offenders are reported as `file:line rule`, never the matched value (CONTEXT §specifics). For a per-line diff-style failure, copy store-lock lines 163-170 (`expect({ file, offending }).toEqual({ file, offending: [] })`).

**Set-equality idiom for the seam companion rule (store-lock lines 197-206):**
```ts
	test("one file inserts an entry, and one file decides that it may", async () => {
		// Asserted as a set rather than a ceiling: the failure mode is a *new* caller
		// reaching past the gate, and that shows up here as an extra path.
		const callers = (await filesMatching("**/*.ts"))
			.filter((path) => !path.endsWith(".test.ts"))
			.filter((path) => /\binsertEntry\b/.test(read(path)))
			.sort();

		expect(callers).toEqual([...MEMORY_WRITE_PATH].sort());
	});
```
→ the non-test files holding `new AuditLog(` / `new OtlpExporter(` equal `["packages/mcp-server/src/observe.ts"]`. Each such call passes `redact`, and the file imports `redact` from the shared module (`observe.ts:45` `import { redact } from "./redact.ts";`, `:145` `new AuditLog({ path: config.audit.path, redact })`, `:152` `new OtlpExporter(settings.otlp, { redact })`).

**Detector self-test idiom (store-lock lines 280-296, 335-361).** Positive and negative bodies are run through the same detector function, with the body echoed in the assertion:
```ts
		for (const body of [
			"SUBSTRATE_TOKEN=<32 hex chars, planted at runtime>",
			…
		]) {
			expect({ body, caught: TOKEN_LITERAL.test(body) }).toEqual({ body, caught: true });
		}
	…
		for (const body of [ "SUBSTRATE_TOKEN_SWARM_A05_BE=", … ]) {
			expect({ body, caught: TOKEN_LITERAL.test(body) }).toEqual({ body, caught: false });
		}
```
→ each rule's detector is a pure `(path, body) => Offender[]` function, so the self-tests feed it the planted offenders and non-offenders listed in RESEARCH Pattern 5 without touching disk.

**Store-lock hazards for this new file.** store-lock scans every tracked file, including this one:
- Never write `SUBSTRATE_TOKEN…=` followed by 16+ characters (`TOKEN_LITERAL`, store-lock:95).
- Never write a `GREPTIME_URL|USER|PASSWORD` assignment with a value (`CREDENTIAL`, :72).
- Never write a Railway proxy or app host (`RAILWAY_HOST`, :73).
Assemble the planted credential-prefix bodies at runtime the same way (e.g. `"/gh" + "p_[A-Za-z0-9]{36}/g"`), so Greptile's secret scan also stays quiet.

**Detector prefix map:** keep it as a `Record<RedactionRuleName, RegExp | null>` (RESEARCH Pattern 5, rule 4), so `tsc` fails when a later rule lacks a decision. Add a test asserting that each non-null detector matches its own rule's `pattern.source` from `REDACTION_RULES`.

**Seam-signature non-offenders, verbatim from the tree:**
- `record.ts:132` `redact: (text: string) => string = (text) => text,`
- `otlp.ts:214` `private readonly deps: { fetch?: FetchLike; redact?: (text: string) => string } = {},`
- `otlp.ts:235` `const redact = this.deps.redact ?? ((text: string) => text);`
- `log.ts:81` `redact?: (text: string) => string;`
- `log.ts:127` `this.redact = options.redact ?? ((text) => text);`
- `event.ts:67` `const redacted = redact(value).slice(0, limit);`

**Import-anchoring non-offender, from September:** `acc30a8:packages/projector/src/muse.ts:73` holds `'import { redact, redactValue } from "__REDACT_MODULE__";',`. The line starts with a quote, so a line-anchored `^[ \t]*(?:import|export)` regex must not match it.

**Smoke decoy non-offender (`scripts/greptime-smoke.ts:39-40`):**
```ts
/** A token-shaped string, assembled at runtime so no token pattern sits in git. */
const DECOY = `ghp_${"A".repeat(36)}`;
```
Also legal: `greptime-smoke.ts:37` `import { REDACTED } from "../packages/mcp-server/src/redact.ts";`, which resolves to the shared module.

---

### `packages/cli/src/lessons.ts` (client utility, transform): migration

**Analog:** itself.

**Import, line 23 (current):**
```ts
import { REDACTED, redact, redactValue } from "../../mcp-server/src/redact.ts";
```
→ `import { redact, redactKnown, redactValue } from "../../mcp-server/src/redact.ts";`. `REDACTED` has no other use in the file, so drop it. Confirm with grep at execution time.

**Diagnostic scrubber, lines 789-815 (current):**
```ts
	const secrets = new Set([connection.token ?? ""]);
	… // url.username/password/searchParams/hash, encoded + decoded variants
	// Structured diagnostics escape string values before they reach the scrubber.
	for (const value of [...secrets]) secrets.add(JSON.stringify(value).slice(1, -1));
	const secretValues = [...secrets].filter(Boolean).sort((a, b) => b.length - a.length);
	function diagnostic(value: string): string {
		let cleaned = value.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, diagnosticUrl);
		for (const secret of secretValues) cleaned = cleaned.replaceAll(secret, REDACTED);
		// Match the storage boundary: redact before capping, so a truncated token
		// cannot survive as a fragment that the credential patterns no longer match.
		return redact(cleaned).slice(0, 200);
	}
```
→ line 811 becomes `cleaned = redactKnown(cleaned, secretValues);` (or `secrets`). Line 808 currently filters and sorts **once** per `httpMemory` construction. Either drop it (the helper filters and sorts on the error-only path, as RESEARCH Pattern 4 recommends) or keep it as the pre-sorted array (the helper's sort is then near-linear on sorted input). Do not sort twice in new code. Line 810's `diagnosticUrl` replacement stays: it rewrites URLs and is not a redaction marker. `lessons.test.ts:993-1140` ("lesson transport diagnostics") must pass unchanged.

---

### `packages/mcp-server/src/memory-classify.test.ts` (test, transform)

**Analog:** itself, `describe("secrets")` lines 4-28:
```ts
describe("secrets", () => {
	test("anything the redactor recognises is quarantined, not merely redacted", () => {
		// Redaction is a safety net, not a licence to store the thing it caught: …
		const found = classify("the poller needs GITHUB_TOKEN=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "fact");
		expect(found?.reason).toBe("secret");
	});

	test("a reviewer cannot release one", () => {
		expect(classify("password: hunter2", "fact")?.reviewable).toBe(false);
	});
	…
	test("prose about credentials is not a credential", () => {
		expect(classify("credentials live in /etc/substrate/substrate.env, 0600 and root-owned", "fact")).toBeNull();
```
Add tests in the same `describe`, in the same voice (a regression comment, then `reason`/`reviewable`):
- a `<private>` body (assembled `"<" + "private>…</" + "private>"`) → `secret`, `reviewable: false`;
- one D-04 shape (`"AKIA" + …` assembled at runtime) → `secret`;
- the prose non-offender "we keep private notes…" → `null`.

Mechanism being exercised (`memory-classify.ts:152`): `if (redact(text) !== text) { return { reason: "secret", … reviewable: false } }`.

---

### `docs/redaction.md` (NEW: flat topic doc)

**Analog for header and voice:** `docs/mcp-audit.md:1-7`:
```md
# The MCP audit chain

Tracked as SPE-4793. Owned by `packages/audit`; wired into `substrate-mcp` by
`packages/mcp-server/src/observe.ts`.

One hash-chained record per call an agent made to `substrate-mcp`, and whether it
was **allowed** or **denied**.
```
→ `# Redaction`: "Owned by `packages/mcp-server/src/redact.ts`; enforced by `redact-lock.test.ts`." `##` sections use the plain declarative headings mcp-audit uses ("The record", "Fail open, fail closed").

**Analog for the lock section:** `docs/memory-governance.md:542-552`:
```md
## The lock

`packages/mcp-server/src/store-lock.test.ts` fails the build if memory grows a
second door: nothing outside `packages/mcp-server/src` may name a memory table in
SQL, …

Same argument as the Greptime lock in [`greptime-ledger.md`](greptime-ledger.md):
the reason RBAC, quarantine and exactly-once cannot be forgotten is that there is
nowhere to forget them from.
```
**Table analog:** `docs/memory-governance.md:120-124` (a pipe table with a backticked first column).

Required sections (CONTEXT §Docs):
- the two-column rule table (event pass / skill pass);
- the counter exemption;
- findings vs redactions;
- the lock rules and allowlist (seams + `trace.ts:222` `describe = String` noted as dormant);
- how a new package redacts;
- how to add a rule;
- the pk-rk digit-required deviation from September (D18-21, operator 2026-10-08), with its rationale, and the verbatim-port gaps (RESEARCH "Verified behaviour": `openai_api_key:`, JSON `"api_key":`, fixed-length tails);
- pre-restart rows (RESEARCH Runtime State Inventory).

**Desk-rule constraint:** no literal token shapes, tailnet names or internal hostnames. Describe each rule by its prefix in prose or backticks (`ghp_`-style), never a full value.

---

### Doc pointers (modify)

| File | Anchor (current text) | Change |
|---|---|---|
| `docs/greptime-ledger.md:154-156` | "The patterns are in `redact.ts`, ported from `grok-hermes-connector`'s `redactor.py`. There is no second chance once a row is in an append-only log." | Append: the named rules and D-04 classes are listed in [`redaction.md`](redaction.md). |
| `docs/memory-governance.md:124` / `:133-134` | `` | `secret` | the write-path redactor changed the text | **no** | `` / "A secret is the one class no token releases…" | Pointer to `redaction.md`, plus one sentence: `<private>` blocks and D-04 shapes now quarantine as `secret`. |
| `docs/observability.md:115-120` | "> **A bug this surfaced.** `redactValue`'s sensitive-key rule matched the substring `token`…" | Pointer to the counter-exemption section of `redaction.md`. |
| `docs/mcp-audit.md:162-164` (optional) | "The redactor is **injected** rather than imported — it lives in `packages/mcp-server`, which depends on this package." | Pointer to the lock's seam rule. |
| `docs/lessons-bank.md:55-57` (optional) | "Transport diagnostics remove URL userinfo, queries and fragments, redact configured credential values and recognised credential patterns…" | Name `redactKnown`. |

Link style is relative and backticked, as in memory-governance.md:550: ``[`greptime-ledger.md`](greptime-ledger.md)``.

---

## Shared Patterns

### Runtime-assembled secrets (every test and every doc)
**Source:** `acc30a8:…/redact.test.ts:236-243` (`rnd`), `:86-90` (`"ghp_" + …`), `scripts/greptime-smoke.ts:39-40` (`DECOY`).
**Apply to:** `redact.test.ts`, `redact-lock.test.ts`, `memory-classify.test.ts`, `docs/redaction.md`.
No literal token shape, `SUBSTRATE_TOKEN…=<16+>`, Greptime credential assignment or Railway host in any tracked file. store-lock's `CREDENTIAL`/`RAILWAY_HOST`/`TOKEN_LITERAL` scan every tracked file (store-lock:72-95, 268-276, 324-332).

### Results never carry the value
**Source:** `acc30a8:…/redact.ts:110-111` ("Results name the line and the rule, never the value."), `memory-classify.ts:155-157` ("Deliberately does not say which rule matched").
**Apply to:** skill hits, lock offender lists (`file:line rule`), test failure messages (use the rule name as the `expect` message, never the fixture).

### Allowlist by named path with a reason
**Source:** store-lock lines 25-41 (`SMOKE_HARNESS`), 133-141 (`MAY_SEND_SQL`).
**Apply to:** `INJECTED_SEAMS`, `SKILL_EXCLUSIONS` (`"keypair-array": "byte arrays are ordinary code in docs"`).

### Exhaustive typing over rule names
**Source:** no in-repo analog for a `Record<derived literal union, …>`. The nearest is `SkillRedactionRule`-keyed `samples` in acc30a8 redact.test.ts:166 (a `Partial<Record<…>>`).
**Apply to:** `FIXTURES`, the lock's `DETECTOR` map and `SKILL_EXCLUSIONS` (`Partial`). Use a full `Record` wherever coverage must be total, so `tsc` (`bun run check`) fails first.

### Redact before cap
**Source:** `event.ts:57-69` (`clean`: "Redact, then cap"), `lessons.ts:812-814`, `record.ts:135`.
**Apply to:** any new call site and the round-trip assertions (send uncapped fixtures; the summary stays under 2000).

### Test style
- `bun:test` `describe`/`test`/`expect`, colocated `*.test.ts`, tabs.
- Sentence-case test names stating the property ("a numeric string survives too, because extractUsage accepts one").
- A regression comment inside the test explaining why (main redact.test.ts:76-79, 98-101).
- `tsconfig` has `verbatimModuleSyntax` (use `type` on type-only imports) and `noUncheckedIndexedAccess` (index results are `T | undefined`; use `!` only where main already does, e.g. redact.test.ts:66).

## No Analog Found

| File / element | Role | Data Flow | Reason |
|---|---|---|---|
| `redactKnown` export in `redact.ts` | utility | transform | The behaviour exists inline in `lessons.ts:808,811`; no exported known-value helper exists. Use RESEARCH Pattern 4 |
| Import-specifier resolution in `redact-lock.test.ts` | test helper | transform | store-lock matches specifiers by substring (`/from\s+["'][^"']*greptime(\.ts)?["']/`, line 111) and never resolves paths. Use RESEARCH Pattern 5's anchored `IMPORT`/`DYNAMIC` regexes + `node:path` `resolve` |
| Python/shell detectors in the lock | test helper | transform | No tracked `.py`/`.sh` on main; the patterns come from RESEARCH Pattern 5 (rules 1, 2, 4) |
| Rehearsal round trip harness hooks | live test | request-response | Phase 16's `scripts/rehearsal.ts` / `rehearsal-env.ts` are not on the base yet; gate on `SUBSTRATE_REHEARSAL_NAME` and inline the loopback guard |

## Metadata

**Analog search scope:**
- `packages/mcp-server/src/` (redact, store-lock, memory-classify, observe, event, graph-bind);
- `packages/cli/src/lessons.ts` (+ test);
- `packages/audit/src/`, `packages/observability/src/otlp.ts`;
- `scripts/`;
- `docs/`;
- `acc30a8:packages/mcp-server/src/redact{,.test}.ts`, `acc30a8:packages/projector/src/muse.ts`.

**Files scanned:** 18
**Pattern extraction date:** 2026-10-08
