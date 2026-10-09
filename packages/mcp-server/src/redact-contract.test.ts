/**
 * Phase 18 contract pins the corpus in `redact.test.ts` leaves open: the event
 * rule order (D18-01), the skill pass staying line-local for `api-key-lower`
 * (D18-08), and `docs/redaction.md` naming exactly the rules the module holds
 * (D18-18). Each one is a promise `docs/redaction.md` makes ("structural
 * patterns first, provider shapes before the JWT rule, and keep the skill pass
 * line-local") that no other test would notice breaking.
 *
 * Fixtures are assembled at runtime: the source never holds a literal token
 * or tag shape.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REDACTED, REDACTION_RULES, SKILL_EXCLUSIONS, SKILL_RULE_NAMES, redact, redactSkillContent } from "./redact.ts";
import type { RedactionRuleName } from "./redact.ts";

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const rnd = (alphabet: string, n: number) =>
	Array.from({ length: n }, (_, i) => alphabet[(i * 7 + 3) % alphabet.length]).join("");

const OPEN = "<" + "private>";
const CLOSE = "</" + "private>";

describe("event rule order follows September (D18-01)", () => {
	test("a private block goes as one block even when a keyed value sits against its closing tag", () => {
		// With `password` ahead of `private-tag`, `(\S+)` would swallow the closing
		// tag, the block would no longer close, and the private prose would survive.
		const text = `${OPEN}keep this between us password: ${rnd(ALNUM, 10)}${CLOSE} after`;
		const out = redact(text);
		expect(out).toBe(`${REDACTED} after`);
		expect(out).not.toContain("keep this between us");
	});

	test("private-tag is first, api-key-lower follows assignment, provider shapes precede jwt in order", () => {
		const names: RedactionRuleName[] = REDACTION_RULES.map((entry) => entry.name);

		expect(names.indexOf("private-tag")).toBe(0);
		expect(names.indexOf("api-key-lower")).toBe(names.indexOf("assignment") + 1);

		const providers: RedactionRuleName[] = ["aws", "google", "slack", "npm", "gitlab", "digitalocean", "openai-proj", "pk-rk"];
		const positions = providers.map((name) => names.indexOf(name));
		expect(positions.every((position) => position >= 0)).toBe(true);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
		expect(Math.max(...positions)).toBeLessThan(names.indexOf("jwt"));
	});
});

describe("skill api-key-lower stays line-local (D18-08)", () => {
	test("an api_key with its value on the next line takes nothing from that line", () => {
		const value = rnd(ALNUM, 24);
		for (const text of [`api_key:\n${value}`, `apiKey =\n${value}`, `api-key:\t\n  ${value}`]) {
			expect(redactSkillContent(text)).toEqual({ text, redactions: [], findings: [] });
		}
	});

	test("the same value on the same line is redacted, so the line-local check is not vacuous", () => {
		const value = rnd(ALNUM, 24);
		expect(redactSkillContent(`api_key: ${value}`)).toEqual({
			text: `api_key: ${REDACTED}`,
			redactions: [{ line: 1, rule: "api-key-lower" }],
			findings: [],
		});
	});
});

describe("docs/redaction.md matches the module (D18-18)", () => {
	const DOCS = join(import.meta.dir, "..", "..", "..", "docs");
	const doc = readFileSync(join(DOCS, "redaction.md"), "utf8");
	const section = doc.slice(doc.indexOf("## The rule table"), doc.indexOf("\n## ", doc.indexOf("## The rule table") + 1));
	const rows = [...section.matchAll(/^\| `([a-z0-9-]+)` \| ([^|]+?) \|/gm)].map((match) => ({
		name: match[1] ?? "",
		family: (match[2] ?? "").trim(),
	}));

	test("the rule table lists every event rule, in table order", () => {
		expect(rows.map((row) => row.name)).toEqual(REDACTION_RULES.map((entry) => entry.name));
	});

	test("excluded rows are exactly the skill exclusions; every other row has a same-name skill rule", () => {
		const excluded = rows.filter((row) => /excluded/.test(row.family)).map((row) => row.name);
		expect(excluded.sort()).toEqual(Object.keys(SKILL_EXCLUSIONS).sort());
		for (const row of rows.filter((entry) => !/excluded/.test(entry.family))) {
			expect({ name: row.name, skill: SKILL_RULE_NAMES.some((name) => name === row.name) }).toEqual({
				name: row.name,
				skill: true,
			});
			expect({ name: row.name, family: /^`[a-z0-9-]+`$/.test(row.family) }).toEqual({ name: row.name, family: true });
		}
	});

	test("greptime-ledger, memory-governance and observability point at it", () => {
		for (const file of ["greptime-ledger.md", "memory-governance.md", "observability.md"]) {
			expect({ file, points: readFileSync(join(DOCS, file), "utf8").includes("](redaction.md)") }).toEqual({
				file,
				points: true,
			});
		}
	});
});
