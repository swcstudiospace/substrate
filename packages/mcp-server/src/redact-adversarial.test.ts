/**
 * The redactor against input built to hurt it, and against the shapes that slip between its rules.
 *
 * Three families: `redactKnown` (an echoed marker or an overlapping value must not shield a
 * secret), the event rules that scan for a closing delimiter or a digit (one pass, not one per
 * opening), and the skill engine (a placeholder is judged on the whole value, a match that
 * crosses a private block's edge is still a finding, and a large file is scanned in reasonable
 * time). Every credential-shaped value is assembled at run time from fragments.
 *
 * The timing bounds are far above what a linear scan takes here and far below what the
 * quadratic and exponential forms took (seconds to forever), so they flag a regression to
 * those without flaking on a busy machine.
 */
import { describe, expect, test } from "bun:test";
import { normalizeEvent } from "./event.ts";
import {
	REDACTED,
	REDACTED_PEM,
	REDACTION_RULES,
	applyRule,
	redact,
	redactKnown,
	redactSkillContent,
	scanSkillFiles,
	type RedactionRuleName,
} from "./redact.ts";

/** Milliseconds `work` takes. */
function took(work: () => void): number {
	const started = performance.now();
	work();
	return performance.now() - started;
}

const BEGIN = "-----BEGIN PRIVATE KEY-----";
const END = "-----END PRIVATE KEY-----";
const PK = "p" + "k-";
const GH = "gh" + "p_";

describe("redactKnown", () => {
	test("a marker-shaped lookalike does not shield a value inside it", () => {
		const out = redactKnown("the server said [REDACTED_OPAQUE_CANARY] back", ["OPAQUE_CANARY"]);
		expect(out).not.toContain("OPAQUE_CANARY");
		expect(out).toContain(REDACTED);
		// An arbitrary suffix does not make a span a marker, nor does a lowercase one.
		expect(redactKnown("[REDACTED_x] [REDACTED_ABC]", ["ABC", "x"])).not.toMatch(/ABC|_x\]/);
	});

	test("only the markers this module writes are left alone, so a value inside one cannot splice markers into markers", () => {
		const text = "a [REDACTED] b [REDACTED_PEM] c [REDACTED_TSKEY] d";
		for (const values of [["RED"], ["E"], ["DAC"], ["PEM", "TSKEY"], ["[REDACTED]"]]) {
			expect(redactKnown(text, values)).toBe(text);
		}
		// Idempotent: a second pass over the output changes nothing.
		const once = redactKnown("tok [REDACTED] tok", ["tok"]);
		expect(redactKnown(once, ["tok"])).toBe(once);
	});

	test("a short value that begins inside a longer secret cannot leave the rest of it behind", () => {
		const token = "CANARY" + "opaque-bearer-value";
		const out = redactKnown(`before${token}`, [token, "beforeCAN"]);
		expect(out).toBe(REDACTED);
		// Either order of the two values, and a value nested inside another.
		expect(redactKnown(`before${token}`, ["beforeCAN", token])).toBe(REDACTED);
		expect(redactKnown(`xx${token}yy`, [token, "opaque"])).toBe(`xx${REDACTED}yy`);
	});

	test("overlapping occurrences of one value are one span", () => {
		expect(redactKnown("aaa", ["aa"])).toBe(REDACTED);
		expect(redactKnown("a aaaa b", ["aaa"])).toBe(`a ${REDACTED} b`);
	});

	test("separate occurrences, and adjacent values, each become a marker", () => {
		expect(redactKnown("one tok two tok", ["tok"])).toBe(`one ${REDACTED} two ${REDACTED}`);
		expect(redactKnown("aabb", ["aa", "bb"])).toBe(`${REDACTED}${REDACTED}`);
	});

	test("an empty value is ignored, a missing value changes nothing, no values return the text", () => {
		expect(redactKnown("text", [""])).toBe("text");
		expect(redactKnown("text", [])).toBe("text");
		expect(redactKnown("text", ["absent"])).toBe("text");
		expect(redactKnown("a.b*c", ["a.b*c"])).toBe(REDACTED);
	});

	test("is not slow on a long text with a repeated value", () => {
		const text = "needle ".repeat(20_000);
		expect(took(() => redactKnown(text, ["needle", "need", "eedle"]))).toBeLessThan(1500);
	});
});

describe("the single-pass event rules match what their patterns match", () => {
	const names: RedactionRuleName[] = ["private-tag", "pem", "pk-rk", "url-password"];
	const pattern = (name: RedactionRuleName) => REDACTION_RULES.find((rule) => rule.name === name)!;
	const run = (name: RedactionRuleName, text: string) => {
		const rule = pattern(name);
		return { applied: applyRule(name, text), direct: text.replace(rule.pattern, rule.replacement) };
	};
	const cases: Record<RedactionRuleName & string, string[]> = {
		"private-tag": [
			"a <private>secret</private> b",
			"<PRIVATE>x</Private> and <private>y</private>",
			"<private>one</private><private>two</private>",
			"<private>no close",
			"<private>a <private>b</private> c</private> d",
			"</private> stray <private>x</private>",
			"<private></private>",
			"plain text",
			"",
		],
		pem: [
			`before ${BEGIN}\nMIIabc\n${END} after`,
			`${BEGIN}\nx\n${END}${BEGIN}\ny\n${END}`,
			`-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----`,
			`${BEGIN} never closed`,
			`${END} only an end`,
			"plain text",
		],
		"pk-rk": [
			`${PK}abcdefghijklmnopqrstuvwxyz0123456789`,
			`rk-live_abcdefghijklmnopqrst1`,
			`${PK}abcdefghijklmnopqrstuvwxyz`,
			`xx ${PK}abcdefghijklmnopqrst1 yy rk-abcdefghijklmnopqrstu`,
			`${PK}${PK}abcdefghijklmnopqrstuvw1`,
			`${PK}short1`,
			"plain text",
		],
		"url-password": [
			"postgres://user:hunter2@host/db",
			"see https://a:b@c.example and ftp://x:y@z",
			"no scheme user:pw@host",
			"scheme-only://nothing here",
			"x://:@",
			"plain text with no marker at all",
		],
	} as never;

	for (const name of names) {
		test(`${name}: on ordinary inputs`, () => {
			for (const text of cases[name]) {
				const { applied, direct } = run(name, text);
				expect({ text, applied }).toEqual({ text, applied: direct });
			}
		});
	}

	test("on 600 random strings built from the rules' own fragments", () => {
		// A seeded generator, so a failure is reproducible. The regex is the oracle: it is the
		// definition, and on short inputs it is fast.
		let state = 0x9e3779b9;
		const next = () => {
			state = Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) >>> 0;
			state = Math.imul(state ^ (state >>> 12), 0x297a2d39) >>> 0;
			return (state ^ (state >>> 15)) >>> 0;
		};
		const fragments = [
			"<private>", "</private>", "<PRIVATE>", "</Private>", BEGIN, END, "-----BEGIN RSA PRIVATE KEY-----", "-----END RSA PRIVATE KEY-----",
			PK, "rk-", "abcdefghijklmnopqrst", "abcdefghijklmnopqrst1", "0", "x", " ", "-", "_", "\n", "secret",
			"://", "a:b@", "http", "u:p@", "@",
		];
		for (let i = 0; i < 600; i++) {
			let text = "";
			for (let n = next() % 12; n >= 0; n--) text += fragments[next() % fragments.length];
			for (const name of names) {
				const { applied, direct } = run(name, text);
				expect({ name, text, applied }).toEqual({ name, text, applied: direct });
			}
		}
	});
});

describe("event rules do not go quadratic", () => {
	test("repeated unclosed <private> tags", () => {
		const text = "<private>".repeat(60_000);
		let out = "";
		expect(took(() => (out = redact(text)))).toBeLessThan(1500);
		expect(out).toBe(text);
	});

	test("repeated pk- prefixes with no digit", () => {
		const text = PK.repeat(60_000);
		let out = "";
		expect(took(() => (out = redact(text)))).toBeLessThan(1500);
		expect(out).toBe(text);
	});

	test("a long hyphenated run with no URL in it", () => {
		const text = "ab-".repeat(120_000);
		expect(took(() => redact(text))).toBeLessThan(1500);
	});

	test("repeated unclosed PEM headers", () => {
		const text = `${BEGIN}\n`.repeat(20_000);
		expect(took(() => redact(text))).toBeLessThan(1500);
	});

	test("many closed blocks are still all redacted", () => {
		const text = "<private>a</private> ".repeat(30_000);
		let out = "";
		expect(took(() => (out = redact(text)))).toBeLessThan(1500);
		expect(out.startsWith(`${REDACTED} ${REDACTED}`)).toBe(true);
		expect(out).not.toContain("<private>");
	});

	test("an unclosed block after a closed one leaves the closed one redacted and the rest as it was", () => {
		expect(redact("<private>a</private> keep <private>tail")).toBe(`${REDACTED} keep <private>tail`);
	});
});

describe("skill placeholders are judged on the whole value", () => {
	const scan = (text: string) => scanSkillFiles({ "SKILL.md": text });

	test("a placeholder prefix followed by more of the value is not a placeholder", () => {
		const result = scan("api_key: yoursecretpassword!2024\n");
		expect(result.redactions).toEqual([{ file: "SKILL.md", line: 1, rule: "api-key-lower" }]);
		expect(result.files["SKILL.md"]).toBe(`api_key: ${REDACTED}\n`);
		expect(result.files["SKILL.md"]).not.toContain("yoursecret");
	});

	test("a real placeholder is still kept, bare or quoted", () => {
		for (const line of ["api_key: your-api-key-goes-here", 'api_key: "yoursecretpassword"', "api_key: $OPENAI_API_KEY_VALUE_ENV", "api_key: <your-api-key-value>"]) {
			const result = scan(`${line}\n`);
			expect({ line, files: result.files["SKILL.md"], redactions: result.redactions }).toEqual({ line, files: `${line}\n`, redactions: [] });
		}
	});

	test("the event path redacts the whole token too, with no tail left", () => {
		expect(redact("api_key: abcdefghijklmnopqrstuvwxyz!2024 next")).toBe(`api_key: ${REDACTED} next`);
		expect(redact('api_key: "abcdefghijklmnopqrstuvwxyz0123", other')).toBe(`api_key: "${REDACTED}", other`);
	});

	test("a failing placeholder match is linear in the length of the value", () => {
		for (const words of [35, 300, 3000]) {
			const text = `password: your${"secret".repeat(words)}!\n`;
			expect(took(() => redactSkillContent(text))).toBeLessThan(500);
		}
		// Still redacted, since the `!` makes it a real value.
		expect(redactSkillContent(`password: your${"secret".repeat(40)}!\n`).redactions).toEqual([{ line: 1, rule: "password" }]);
	});

	test("a long run of quotes is trimmed in linear time", () => {
		const text = `password: ${'"'.repeat(200_000)}a\n`;
		expect(took(() => redactSkillContent(text))).toBeLessThan(500);
	});
});

describe("a match that crosses a private block's edge is still a finding", () => {
	const body = "MIIabcdefghij";

	test("a PEM whose closing line sits inside a private block", () => {
		const text = `before\n${BEGIN}\n${body}\n<private>${END}</private>\nafter\n`;
		const result = redactSkillContent(text);

		expect(result.findings).toEqual([{ line: 2, rule: "pem" }]);
		// One marker for the union of the key and the block that overlaps it: not two, and not a body.
		expect(result.text).toBe(`before\n${REDACTED_PEM}\nafter\n`);
	});

	test("a PEM that starts before a private block and ends inside it, and one that starts inside and ends after", () => {
		const startsBefore = `${BEGIN}\n${body}\n<private>${END}\nrest</private>\n`;
		const startsInside = `<private>head\n${BEGIN}\n${body}\n</private>${END}\n`;
		const before = redactSkillContent(startsBefore);
		expect(before.findings).toEqual([{ line: 1, rule: "pem" }]);
		expect(before.text).toBe(`${REDACTED_PEM}\n`);
		const inside = redactSkillContent(startsInside);
		expect(inside.findings).toEqual([{ line: 2, rule: "pem" }]);
		expect(inside.text).toBe(`${REDACTED}\n`);
	});

	test("a doc example PEM that crosses an edge is a redaction, not a finding, and is still removed", () => {
		const text = `${BEGIN}\n${body}\n<private>${END}</private>\n`;
		const result = redactSkillContent(text, { allowDocExamples: new Set(["pem"]) });
		expect(result.findings).toEqual([]);
		expect(result.redactions.map((r) => r.rule)).toEqual(["pem", "private-tag"]);
		expect(result.text).toBe(`${REDACTED_PEM}\n`);
	});

	test("a token fully inside a private block is one finding and one marker, as before", () => {
		const token = GH + "A".repeat(36);
		const result = redactSkillContent(`x <private>use ${token} here</private> y`);
		expect(result.findings).toEqual([{ line: 1, rule: "github" }]);
		expect(result.text).toBe(`x ${REDACTED} y`);
	});

	test("a contextual match that touches a private block yields to it", () => {
		const result = redactSkillContent(`password:<private>hunter2</private>\n`);
		expect(result.text).not.toContain("hunter2");
		expect(result.findings).toEqual([]);
	});
});

describe("the event path unions a PEM with a private block that shares its edge", () => {
	const body = "MIIabcdefghij";

	test("a closing line inside the block, and an opening line inside the block, both drop the key body", () => {
		const closingInside = `before\n${BEGIN}\n${body}\n<private>${END}</private>\nafter\n`;
		const openingInside = `<private>head\n${BEGIN}\n${body}\n</private>${END}\n`;
		expect(redact(closingInside)).toBe(`before\n${REDACTED_PEM}\nafter\n`);
		expect(redact(openingInside)).toBe(`${REDACTED}\n`);
		expect(redact(`<private>\n${BEGIN}\n${body}\n${END}\n</private>`)).toBe(REDACTED);

		const stored = normalizeEvent(
			{
				surface: "claude-code",
				kind: "note",
				summary: closingInside,
				payload: { note: closingInside, nested: { key: openingInside } },
			},
			null,
		);
		expect(stored.summary).toBe(`before\n${REDACTED_PEM}\nafter\n`);
		expect(stored.summary).not.toContain(body);
		expect(JSON.stringify(stored.payload)).not.toContain(body);
		expect(JSON.stringify(stored.payload)).not.toContain(BEGIN);
	});
});

describe("the skill scan is not quadratic in the number of matches", () => {
	test("tens of thousands of safe placeholders", () => {
		const text = "TOKEN=$DEMO_KEY\n".repeat(64_000);
		let result: ReturnType<typeof redactSkillContent> | undefined;
		expect(took(() => (result = redactSkillContent(text)))).toBeLessThan(3000);
		expect(result?.text).toBe(text);
		expect(result?.redactions).toEqual([]);
	});

	test("tens of thousands of private blocks", () => {
		const text = "<private>a</private>\n".repeat(30_000);
		let result: ReturnType<typeof redactSkillContent> | undefined;
		expect(took(() => (result = redactSkillContent(text)))).toBeLessThan(3000);
		expect(result?.redactions).toHaveLength(30_000);
	});

	test("tens of thousands of real secrets, each reported once with its line", () => {
		const text = Array.from({ length: 20_000 }, (_, i) => `PASSWORD=value${i}`).join("\n");
		const result = redactSkillContent(text);
		expect(result.redactions).toHaveLength(20_000);
		expect(result.redactions[19_999]).toEqual({ line: 20_000, rule: "password" });
	});

	test("a long digitless pk- run with no URL does not rescan", () => {
		const text = "pk-".repeat(40_000);
		expect(text.includes("://")).toBe(false);
		expect(took(() => redactSkillContent(text))).toBeLessThan(200);
		const url = redactSkillContent("postgres://user:hunter2@localhost/db");
		expect(url.text).toBe(`postgres://user:${REDACTED}@localhost/db`);
		expect(url.redactions).toEqual([{ line: 1, rule: "url-password" }]);
	});

	test("many matches on one line are counted without rereading the line", () => {
		const lines = Array.from({ length: 16 }, () => "PASSWORD=value ".repeat(8_000)).join("\n");
		const text = "PASSWORD=value ".repeat(128_000);
		expect(text.includes("\n")).toBe(false);
		// A control with the same bytes and the same 128k matches, split across sixteen lines. Memory and GC cost is the same for both, so only work that rescans within a line separates them: about 1 for linear counting (0.5 to 1.4 measured), about 16 for a rescan per match.
		const best = (input: string) => Math.min(...[0, 1, 2].map(() => { Bun.gc(true); return took(() => redactSkillContent(input)); }));
		expect(best(text) / best(lines)).toBeLessThan(4);
		const result = redactSkillContent(text);
		expect(result.redactions).toHaveLength(128_000);
		expect(result.redactions[0]).toEqual({ line: 1, rule: "password" });
		expect(result.redactions[127_999]).toEqual({ line: 1, rule: "password" });
		expect(result.text).not.toContain("=value");
	}, 60_000);
});

describe("scanSkillFiles keeps every file", () => {
	test("including one named __proto__, without touching the prototype", () => {
		const files = Object.fromEntries([
			["__proto__", "first"],
			["a.md", "second"],
			["constructor", "third"],
		]);
		const out = scanSkillFiles(files).files;

		expect(Object.keys(out).sort()).toEqual(["__proto__", "a.md", "constructor"]);
		expect(Object.getOwnPropertyDescriptor(out, "__proto__")?.value).toBe("first");
		expect(out["constructor"]).toBe("third");
		expect(({} as Record<string, unknown>)["first"]).toBeUndefined();
		expect(Object.getPrototypeOf(out)).toBeNull();
		expect(JSON.stringify(out)).toContain('"__proto__":"first"');
	});

	test("an ordinary map comes back sorted and redacted", () => {
		const out = scanSkillFiles({ "b.md": "x", "a.md": "y" });
		expect(Object.keys(out.files)).toEqual(["a.md", "b.md"]);
	});
});
