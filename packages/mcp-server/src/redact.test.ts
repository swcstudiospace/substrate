import { describe, expect, test } from "bun:test";
import { REDACTED, REDACTION_RULES, redact, redactValue } from "./redact.ts";
import type { RedactionRuleName } from "./redact.ts";

describe("redact", () => {
	test("leaves ordinary event summaries alone", () => {
		const summary = "edited gateway/ws.rs, ran cargo test (pass)";
		expect(redact(summary)).toBe(summary);
	});

	test("strips the patterns inherited from redactor.py", () => {
		expect(redact("tskey-auth-kX9fQ2mNpL")).toBe("[REDACTED_TSKEY]");
		expect(redact("password: hunter2")).toBe(`password: ${REDACTED}`);
		expect(redact("PGPASSWORD=s3cr3t")).toBe(`PGPASSWORD=${REDACTED}`);
		expect(redact("VAULT_TOKEN=hvs.abcdef")).toBe(`VAULT_TOKEN=${REDACTED}`);
		expect(redact("-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----")).toBe("[REDACTED_PEM]");
	});

	test("strips provider token shapes", () => {
		expect(redact("lin_api_" + "a".repeat(40))).toBe(REDACTED);
		expect(redact("ntn_" + "b".repeat(46))).toBe(REDACTED);
		expect(redact("ghp_" + "c".repeat(36))).toBe(REDACTED);
		expect(redact("xai-" + "d".repeat(64))).toBe(REDACTED);
		expect(redact("sk-ant-api03-" + "e".repeat(40))).toBe(REDACTED);
	});

	test("strips the password out of a connection URL but keeps the host", () => {
		const out = redact("postgres://substrate:hunter2@db.railway.app:5432/index");
		expect(out).toContain("db.railway.app:5432/index");
		expect(out).not.toContain("hunter2");
	});

	test("strips bearer tokens from an authorization header", () => {
		const out = redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz");
		expect(out).not.toContain("abcdefghijklmnopqrstuvwxyz");
	});

	test("strips a JWT", () => {
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r";
		expect(redact(`token=${jwt}`)).not.toContain("dBjftJeZ4CVPmB92K27uhbUJU1p1r");
	});

	test("strips our own per-surface bearer tokens", () => {
		expect(redact("SUBSTRATE_TOKEN_HERMES=abc123xyz")).toBe(`SUBSTRATE_TOKEN_HERMES=${REDACTED}`);
	});
});

describe("redactValue", () => {
	test("redacts a sensitive key whole, since a bare token has no context to anchor on", () => {
		expect(redactValue({ api_key: "short", cmd: "cargo test" })).toEqual({
			api_key: REDACTED,
			cmd: "cargo test",
		});
	});

	test("recurses through nested payloads", () => {
		const payload = {
			files: ["gateway/ws.rs"],
			env: { PGPASSWORD: "s3cr3t", RUST_LOG: "debug" },
			nested: [{ authorization: "Bearer abcdefghijklmnop" }],
		};
		const out = redactValue(payload);
		expect(out.files).toEqual(["gateway/ws.rs"]);
		expect(out.env.PGPASSWORD).toBe(REDACTED);
		expect(out.env.RUST_LOG).toBe("debug");
		expect(out.nested[0]!.authorization).toBe(REDACTED);
	});

	test("passes non-string scalars through untouched", () => {
		expect(redactValue({ exit: 0, ok: true, missing: null })).toEqual({ exit: 0, ok: true, missing: null });
	});
});

describe("token counts are counts, not credentials", () => {
	test("a numeric token count survives, so usage is not destroyed on the write path", () => {
		// Regression: the sensitive-key rule matched the substring `token`, so every
		// count any collector reported reached the ledger as `[REDACTED]` — invisibly,
		// because a redacted field looks like redaction working. The tokens-and-cost
		// metrics read exactly these keys.
		const out = redactValue({
			usage: {
				input_tokens: 1200,
				output_tokens: 340,
				total_tokens: 1540,
				cache_read_tokens: 12,
				tokens_in: 5,
				tokens_out: 6,
				token_count: 7,
				tokens: 8,
				max_tokens: 4096,
				cost_usd: 0.0123,
				model: "opus",
			},
		});

		expect(out.usage).toEqual({
			input_tokens: 1200,
			output_tokens: 340,
			total_tokens: 1540,
			cache_read_tokens: 12,
			tokens_in: 5,
			tokens_out: 6,
			token_count: 7,
			tokens: 8,
			max_tokens: 4096,
			cost_usd: 0.0123,
			model: "opus",
		});
	});

	test("a numeric string survives too, because extractUsage accepts one", () => {
		// Several collectors ship their counts as strings. Exempting only numbers meant
		// the redactor blanked exactly those, so `extractUsage` never saw them and the
		// usage was lost on the write path — the two have to agree.
		expect(redactValue({ input_tokens: "1200" }).input_tokens).toBe("1200");
		expect(redactValue({ tokens_out: "340" }).tokens_out).toBe("340");
	});

	test("a counter-shaped name that is not on the list is still redacted", () => {
		// The exemption is an explicit list, not a pattern that grows on its own.
		expect(redactValue({ cost_tokens: "0.5" }).cost_tokens).toBe(REDACTED);
	});

	test("a string that is not a count is still redacted whole", () => {
		// The exemption must not become a way to smuggle a credential.
		expect(redactValue({ tokens: "sk-ant-abcdefghijklmnopqrstuvwxyz" }).tokens).toBe(REDACTED);
		expect(redactValue({ input_tokens: "lin_api_abcdefghijklmnopqrstuvwxyz" }).input_tokens).toBe(REDACTED);
		expect(redactValue({ tokens: "1200; drop table" }).tokens).toBe(REDACTED);
		expect(redactValue({ tokens: "-5" }).tokens).toBe(REDACTED);
	});

	test("a key that is not a count keeps its old treatment, number or not", () => {
		// `password: 123456` is a secret even though it is a number, which is why the
		// exemption is an explicit list of counter names rather than "numbers are safe".
		for (const payload of [{ auth_token: 12345 }, { token_secret: 1 }, { github_token: 99 }, { password: 123456 }]) {
			const [key] = Object.keys(payload);
			expect(redactValue<Record<string, unknown>>(payload)[key as string]).toBe(REDACTED);
		}
	});

	test("a non-finite value under a count key is not treated as a count", () => {
		expect(redactValue<Record<string, unknown>>({ input_tokens: Number.NaN }).input_tokens).toBe(REDACTED);
	});
});

describe("over-redaction guards", () => {
	test("a word merely containing KEY is not treated as a secret", () => {
		expect(redact("KEYBOARD_LAYOUT=us")).toBe("KEYBOARD_LAYOUT=us");
		expect(redact("MONKEY=banana")).toBe("MONKEY=banana");
	});

	test("keyword as a mid-name segment is still caught", () => {
		expect(redact("SUBSTRATE_TOKEN_CLAUDE_CODE=xyz")).toBe(`SUBSTRATE_TOKEN_CLAUDE_CODE=${REDACTED}`);
		expect(redact("MY_API_KEY_V2=xyz")).toBe(`MY_API_KEY_V2=${REDACTED}`);
	});
})

// ── One planted secret per named rule (D-04 merge, D18-04) ────────────────────
// Deterministic runtime fixtures: the source never holds a literal token shape.
// Rule names come from REDACTION_RULES, so tsc fails when a rule lacks a fixture.
const UPPER_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const HEX = "0123456789abcdef";
const DIGITS = "0123456789";
const rnd = (alphabet: string, n: number) =>
	Array.from({ length: n }, (_, i) => alphabet[(i * 7 + 3) % alphabet.length]).join("");

interface RuleFixture {
	/** Text exercising the rule. */
	text: string;
	/** The substring that must be gone after redaction. */
	secret: string;
}

const pkBody = "lf-" + rnd(ALNUM, 21);
const rkBody = "live-" + rnd(ALNUM, 19);
const awsFixture = "AKIA" + rnd(UPPER_DIGITS, 16);

const FIXTURES: Record<RedactionRuleName, readonly RuleFixture[]> = {
	"private-tag": [{ text: "<" + "private>keep this between us</" + "private>", secret: "keep this between us" }],
	pem: [
		{
			text: ["-----BEGIN " + "RSA PRIVATE KEY-----", rnd(ALNUM, 32), "-----END " + "RSA PRIVATE KEY-----"].join("\n"),
			secret: rnd(ALNUM, 32),
		},
	],
	tailscale: [{ text: "tskey-" + "auth-" + rnd(ALNUM, 16), secret: "auth-" + rnd(ALNUM, 16) }],
	password: [{ text: "password: " + rnd(ALNUM, 10), secret: rnd(ALNUM, 10) }],
	// Not PGPASSWORD: the `password` rule claims that prefix first.
	"password-env": [{ text: "DB_PASSWD=" + rnd(ALNUM, 10), secret: rnd(ALNUM, 10) }],
	daytona: [{ text: "DAYTONA_API_KEY=" + rnd(ALNUM, 12), secret: rnd(ALNUM, 12) }],
	vault: [{ text: "X-VAULT-TOKEN: " + rnd(ALNUM, 12), secret: rnd(ALNUM, 12) }],
	// Never a SUBSTRATE_TOKEN value of 16+ characters (store-lock TOKEN_LITERAL).
	assignment: [{ text: "LINEAR_API_KEY=" + rnd(ALNUM, 16), secret: rnd(ALNUM, 16) }],
	"api-key-lower": [{ text: "api_key: " + rnd(ALNUM, 24), secret: rnd(ALNUM, 24) }],
	authorization: [{ text: "authorization: " + rnd(ALNUM, 12), secret: rnd(ALNUM, 12) }],
	bearer: [{ text: "Bearer " + rnd(ALNUM, 24), secret: rnd(ALNUM, 24) }],
	"url-password": [{ text: "postgres://u:" + rnd(ALNUM, 12) + "@h/db", secret: rnd(ALNUM, 12) }],
	"linear-api": [{ text: "lin_api_" + rnd(ALNUM, 40), secret: "lin_api_" + rnd(ALNUM, 40) }],
	"linear-oauth": [{ text: "lin_oauth_" + rnd(ALNUM, 40), secret: "lin_oauth_" + rnd(ALNUM, 40) }],
	notion: [{ text: "ntn_" + rnd(ALNUM, 46), secret: "ntn_" + rnd(ALNUM, 46) }],
	github: [{ text: "ghp_" + rnd(ALNUM, 36), secret: "ghp_" + rnd(ALNUM, 36) }],
	"github-pat": [{ text: "github_pat_" + rnd(ALNUM, 40), secret: "github_pat_" + rnd(ALNUM, 40) }],
	xai: [{ text: "xai-" + rnd(ALNUM, 64), secret: "xai-" + rnd(ALNUM, 64) }],
	anthropic: [{ text: "sk-ant-api03-" + rnd(ALNUM, 40), secret: "sk-ant-api03-" + rnd(ALNUM, 40) }],
	openai: [{ text: "sk-" + rnd(ALNUM, 48), secret: "sk-" + rnd(ALNUM, 48) }],
	aws: [{ text: awsFixture, secret: awsFixture }],
	google: [{ text: "AIza" + rnd(ALNUM, 35), secret: "AIza" + rnd(ALNUM, 35) }],
	slack: [{ text: "xoxb-" + rnd(DIGITS, 12) + "-" + rnd(ALNUM, 24), secret: "xoxb-" + rnd(DIGITS, 12) }],
	npm: [{ text: "npm_" + rnd(ALNUM, 36), secret: "npm_" + rnd(ALNUM, 36) }],
	gitlab: [{ text: "glpat-" + rnd(ALNUM, 20), secret: "glpat-" + rnd(ALNUM, 20) }],
	digitalocean: [{ text: "dop_v1_" + rnd(HEX, 64), secret: "dop_v1_" + rnd(HEX, 64) }],
	"openai-proj": [{ text: "sk-proj-" + rnd(ALNUM, 40), secret: "sk-proj-" + rnd(ALNUM, 40) }],
	// Two fixtures: one pk- body and one rk- body, each digit-bearing per D18-21.
	"pk-rk": [
		{ text: "pk-" + pkBody, secret: "pk-" + pkBody },
		{ text: "rk-" + rkBody, secret: "rk-" + rkBody },
	],
	jwt: [
		{
			text: ["eyJ" + "hbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", rnd(ALNUM, 27)].join("."),
			secret: "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
		},
	],
	"keypair-array": [
		{
			text: "[" + Array.from({ length: 64 }, (_, i) => ((i * 37) % 256).toString()).join(", ") + "]",
			secret: "37, 74",
		},
	],
};

function ruleByName(name: RedactionRuleName) {
	const rule = REDACTION_RULES.find((entry) => entry.name === name);
	if (!rule) throw new Error(`no rule named ${name}`);
	return rule;
}

describe("one fixture per named rule", () => {
	test("every rule carries a unique stable name", () => {
		const names = REDACTION_RULES.map((entry) => entry.name);
		expect(new Set(names).size).toBe(names.length);
		expect(names.length).toBe(30);
	});

	test("every rule name has at least one fixture", () => {
		expect(Object.keys(FIXTURES).sort()).toEqual(REDACTION_RULES.map((entry) => entry.name).sort());
	});

	for (const [name, fixtures] of Object.entries(FIXTURES) as Array<[RedactionRuleName, readonly RuleFixture[]]>) {
		for (const [index, fixture] of fixtures.entries()) {
			test(`${name}[${index}]: the entry's own pattern fires`, () => {
				const rule = ruleByName(name);
				expect(fixture.text.replace(rule.pattern, "") !== fixture.text).toBe(true);
			});

			test(`${name}[${index}]: redact removes the secret with surrounding text intact`, () => {
				const out = redact(`shipped ${fixture.text} to staging`);
				// The marker varies by rule ([REDACTED], [REDACTED_PEM], [REDACTED_TSKEY]).
				expect(out).toContain("REDACTED");
				expect(out).not.toContain(fixture.secret);
				expect(out.startsWith("shipped ")).toBe(true);
				expect(out.endsWith(" to staging")).toBe(true);
			});

			test(`${name}[${index}]: redaction is idempotent`, () => {
				const once = redact(`shipped ${fixture.text} to staging`);
				expect(redact(once)).toBe(once);
			});

			test(`${name}[${index}]: reachable through redactValue under a non-sensitive key`, () => {
				expect(redactValue({ note: `deploy with ${fixture.text}` })).toEqual({
					note: redact(`deploy with ${fixture.text}`),
				});
			});
		}
	}

	test("D-04 multi-line private block", () => {
		expect(redact("<" + "private>\nline one\nline two\n</" + "private> after")).toBe(`${REDACTED} after`);
	});
});

describe("D-04 counter exemption", () => {
	test("counts survive while a D-04 fixture and a short api_key are redacted whole", () => {
		const out = redactValue({
			input_tokens: 1200,
			output_tokens: "340",
			tokens: awsFixture,
			api_key: "short",
		});
		expect(out.input_tokens).toBe(1200);
		expect(out.output_tokens).toBe("340");
		expect(out.tokens).toBe(REDACTED);
		expect(out.api_key).toBe(REDACTED);
	});
});

describe("D-04 near-misses stay unredacted", () => {
	test("short, unclosed and word-only shapes survive redact", () => {
		const nearMisses = [
			`id AKIA${rnd(UPPER_DIGITS, 15)} only`,
			"api_key: short",
			"<" + "private> this block never closes",
			`ref pk-${rnd(ALNUM, 10)} here`,
			`pkg npm_${rnd(ALNUM, 20)} there`,
			"KEYBOARD_LAYOUT=us",
			"MONKEY=banana",
		];
		for (const text of nearMisses) expect(redact(text)).toBe(text);
	});

	test("word-only pk-/rk- slugs survive while a digit-bearing key is redacted (D18-21)", () => {
		expect(redact("on branch pk-fix-the-bug-in-store today")).toBe("on branch pk-fix-the-bug-in-store today");
		expect(redact("see rk-release-notes-for-october for details")).toBe("see rk-release-notes-for-october for details");
		const keyOut = redact(`shipped pk-${pkBody} to staging`);
		expect(keyOut).toContain(REDACTED);
		expect(keyOut).not.toContain(pkBody);
	});
});
