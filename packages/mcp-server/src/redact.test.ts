import { describe, expect, test } from "bun:test";
import * as redactModule from "./redact.ts";
import {
	REDACTED,
	REDACTED_PEM,
	REDACTION_RULES,
	SKILL_EXCLUSIONS,
	SKILL_HIGH_CONFIDENCE_RULES,
	SKILL_RULE_NAMES,
	redact,
	redactKnown,
	redactSkillContent,
	redactValue,
	scanSkillFiles,
} from "./redact.ts";
import type { RedactionRuleName, SkillRedactionRule } from "./redact.ts";

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

describe("redactKnown", () => {
	test("replaces the longest value first, so a shorter secret never leaves a tail", () => {
		const out = redactKnown("q=canary-query", ["canary", "canary-query"]);
		expect(out).toBe(`q=${REDACTED}`);
	});

	test("ignores empty values, which would otherwise splice the marker everywhere", () => {
		expect(redactKnown("plain", [""])).toBe("plain");
		expect(redactKnown("plain canary here", ["", "canary"])).toBe(`plain ${REDACTED} here`);
	});

	test("is idempotent and drops duplicates", () => {
		const once = redactKnown("canary-query and canary", ["canary", "canary-query", "canary"]);
		expect(once).toBe(`${REDACTED} and ${REDACTED}`);
		expect(redactKnown(once, ["canary", "canary-query"])).toBe(once);
	});
	test("a needle inside the marker text does not splice markers into markers", () => {
		expect(redactKnown("token XYZTOKENVALUE and RED", ["XYZTOKENVALUE", "RED"])).toBe(`token ${REDACTED} and ${REDACTED}`);
		const once = redactKnown("a XYZ b", ["XYZ", "DAC"]);
		expect(once).toBe(`a ${REDACTED} b`);
		expect(redactKnown(once, ["XYZ", "DAC"])).toBe(once);
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

describe("redaction coverage gaps", () => {
	test("provider token shapes that leaked before are redacted and their surroundings kept", () => {
		const probes = [
			"sk_live_" + "a".repeat(24),
			"rk_live_" + "a".repeat(24),
			"xoxp-" + "1".repeat(12),
			"xapp-1-" + "A".repeat(12),
			"ASIA" + "ABCDEFGHIJKLMNOP",
			"sk-svcacct-" + "a".repeat(20),
			"sk-admin-" + "a".repeat(20),
			"hf_" + "a".repeat(20),
			"ya29." + "a".repeat(20),
			"SG." + "a".repeat(22) + "." + "b".repeat(43),
			"shpat_" + "a".repeat(20),
			"sbp_" + "a".repeat(20),
			"glsoat-" + "a".repeat(20),
			"SK" + "0".repeat(32),
		];
		for (const probe of probes) expect(redact(`ship ${probe} now`)).toBe(`ship ${REDACTED} now`);
	});

	test("credential keys with a closing quote or a lowercase name lose the value and keep the JSON shape", () => {
		expect(redact('{"password": "hunter2"}')).toBe(`{"password": ${REDACTED}}`);
		expect(redact("client_secret=abc123")).toBe(`client_secret=${REDACTED}`);
		expect(redact('{"client_secret": "abc123"}')).toBe(`{"client_secret": ${REDACTED}}`);
		expect(redact('{"api_key": "abcdefghijklmnopqrstuvwx"}')).toBe(`{"api_key": "${REDACTED}"}`);
	});

	test("Basic and Token authorization credentials are redacted, not only the scheme word", () => {
		expect(redact("Authorization: Basic dXNlcjpwYXNz")).toBe(`Authorization: ${REDACTED}`);
		expect(redact("Authorization: Token abc123def456")).toBe(`Authorization: ${REDACTED}`);
	});

	test("a PGP block and a PEM block with no END line are redacted, text outside them kept", () => {
		expect(redact("-----BEGIN PGP PRIVATE KEY BLOCK-----")).toBe(REDACTED_PEM);
		const pgp = "-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOY\n-----END PGP PRIVATE KEY BLOCK-----";
		expect(redact(`before ${pgp} after`)).toBe(`before ${REDACTED_PEM} after`);
		expect(redact("keep this\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow")).toBe(`keep this\n${REDACTED_PEM}`);
	});

	test("a password containing @ is redacted up to the last @ before the host", () => {
		expect(redact("https://u:p@ss@host")).toBe(`https://u:${REDACTED}@host`);
		expect(redact("https://u:p@ss@host/path")).toBe(`https://u:${REDACTED}@host/path`);
	});
});

describe("a quoted credential value with spaces loses every word", () => {
	const SPACED = "correct horse battery";
	const lostEvery = (out: string) => {
		expect(out).toContain(REDACTED);
		for (const word of SPACED.split(" ")) expect(out).not.toContain(word);
	};
	test("the event path drops a JSON value and a quoted assignment whole", () => {
		expect(redact(`{"password": "${SPACED}"}`)).toBe(`{"password": ${REDACTED}}`);
		expect(redact(`{"client_secret": "${SPACED}"}`)).toBe(`{"client_secret": ${REDACTED}}`);
		expect(redact(`DB_PASS="${SPACED}"`)).toBe(`DB_PASS=${REDACTED}`);
		expect(redact(`DB_PASS='${SPACED}'`)).toBe(`DB_PASS=${REDACTED}`);
	});
	test("the skill path drops a JSON value and quoted assignments whole", () => {
		for (const line of [
			`{"client_secret": "${SPACED}"}`,
			`LINEAR_API_KEY="${SPACED}"`,
			`DB_PASS='${SPACED}'`,
			`DAYTONA_API_KEY="${SPACED}"`,
			`X-VAULT-TOKEN: "${SPACED}"`,
			`Authorization: "${SPACED}"`,
		]) {
			lostEvery(redactSkillContent(line).text);
		}
	});
	test("an unquoted value still ends at its first space", () => {
		expect(redact("DB_PASS=abc def")).toBe(`DB_PASS=${REDACTED} def`);
		expect(redactSkillContent("DB_PASS=abc def").text).toBe(`DB_PASS=${REDACTED} def`);
	});
	test("an escaped-quote JSON string loses every word on both paths", () => {
		for (const line of [String.raw`{\"password\": \"${SPACED}\"}`, String.raw`\"password\": \"${SPACED}\"`]) {
			lostEvery(redact(line));
			lostEvery(redactSkillContent(line).text);
		}
		expect(redact(String.raw`{\"password\": \"${SPACED}\"}`)).toBe(String.raw`{\"password\": ${REDACTED}}`);
		expect(redact(String.raw`\"password\": \"${SPACED}\"`)).toBe(String.raw`\"password\": ${REDACTED}`);
	});
	test("an escaped-quote bare assignment loses every word, double or single quoted", () => {
		for (const line of [
			String.raw`password=\"${SPACED}\"`,
			String.raw`password=\'${SPACED}\'`,
			String.raw`DB_PASS=\"${SPACED}\"`,
			String.raw`DB_PASS=\'${SPACED}\'`,
		]) {
			lostEvery(redact(line));
			lostEvery(redactSkillContent(line).text);
		}
		expect(redact(String.raw`password=\"${SPACED}\"`)).toBe(`password=${REDACTED}`);
		expect(redact(String.raw`password=\'${SPACED}\'`)).toBe(`password=${REDACTED}`);
	});
	test("an escaped value ends at its own closing escaped quote", () => {
		const out = redact(String.raw`password=\"x\", other: \"y\"`);
		expect(out).toContain(`password=${REDACTED}`);
		expect(out).toContain(String.raw`other: \"y\"`);
		expect(out).not.toContain(String.raw`\"x\"`);
	});
	test("an escaped value takes the non-space text attached after its closing quote", () => {
		const line = String.raw`DB_PASS=\"first\"tail`;
		for (const out of [redact(line), redactSkillContent(line).text]) {
			expect(out).toBe(`DB_PASS=${REDACTED}`);
			expect(out).not.toContain("first");
			expect(out).not.toContain("tail");
		}
	});
	test("an escaped env reference inside JSON is kept on the skill path", () => {
		const line = String.raw`curl -d "{\"password\": \"$DB_PASS\"}"`;
		expect(redactSkillContent(line).text).toBe(line);
	});
	test("an escaped env reference with attached text is still redacted on the skill path", () => {
		const line = String.raw`DB_PASS=\"$DB_PASS\"tail`;
		expect(redactSkillContent(line).text).toBe(`DB_PASS=${REDACTED}`);
	});
	test("plain quoted values keep the same placeholder shape", () => {
		expect(redact(`{"password": "${SPACED}"}`)).toBe(`{"password": ${REDACTED}}`);
		expect(redact(`password="${SPACED}"`)).toBe(`password=${REDACTED}`);
		for (const line of [`{"password": "${SPACED}"}`, `password="${SPACED}"`]) {
			lostEvery(redact(line));
			lostEvery(redactSkillContent(line).text);
		}
	});
});

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
	// The key prefix is a literal like the other provider prefixes above; the
	// tail is deterministic runtime output, never a real credential.
	ragflow: [{ text: "ragflow-" + rnd(ALNUM, 40), secret: "ragflow-" + rnd(ALNUM, 40) }],
	// Provider shapes added with the SOTA pass; the skill pass shares each name.
	stripe: [{ text: "sk_live_" + rnd(ALNUM, 24), secret: "sk_live_" + rnd(ALNUM, 24) }],
	huggingface: [{ text: "hf_" + rnd(ALNUM, 34), secret: "hf_" + rnd(ALNUM, 34) }],
	"google-oauth": [{ text: "ya29." + rnd(ALNUM, 40), secret: "ya29." + rnd(ALNUM, 40) }],
	sendgrid: [{ text: "SG." + rnd(ALNUM, 22) + "." + rnd(ALNUM, 43), secret: "SG." + rnd(ALNUM, 22) + "." + rnd(ALNUM, 43) }],
	shopify: [{ text: "shpat_" + rnd(HEX, 32), secret: "shpat_" + rnd(HEX, 32) }],
	supabase: [{ text: "sbp_" + rnd(HEX, 40), secret: "sbp_" + rnd(HEX, 40) }],
	glitch: [{ text: "glsoat-" + rnd(ALNUM, 32), secret: "glsoat-" + rnd(ALNUM, 32) }],
	twilio: [{ text: "SK" + rnd(HEX, 32), secret: "SK" + rnd(HEX, 32) }],
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
		expect(names.length).toBe(39);
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
// ── Skill content (D18-07, D18-08) ────────────────────────────────────────────
// Runtime-assembled fixtures: the source never holds a literal token shape.
const SKILL_GITHUB = "ghp_" + rnd(ALNUM, 36);
const SKILL_PEM_MIDDLE = rnd(ALNUM, 32);
const SKILL_PEM = ["-----BEGIN " + "RSA PRIVATE KEY-----", SKILL_PEM_MIDDLE, "-----END " + "RSA PRIVATE KEY-----"].join("\n");
const SKILL_JWT_LAST = rnd(ALNUM, 27);
const SKILL_JWT = ["eyJ" + "hbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", SKILL_JWT_LAST].join(".");
describe("redactSkillContent keeps env references and placeholders", () => {
	test("working auth lines and placeholder values come back unchanged with nothing reported", () => {
		for (const line of [
			"Authorization: Bearer $PARALLEL_API_KEY",
			"API_KEY=${OPENAI_API_KEY}",
			"TOKEN=<your-token>",
			"password: changeme",
			"SECRET=xxxxxxxx",
			"KEY=...",
			"postgres://user:***@host/db",
		]) {
			expect(redactSkillContent(line)).toEqual({ text: line, redactions: [], findings: [] });
		}
	});
	test("a key with nothing after it on its line takes nothing from the next line", () => {
		const yaml = "password:\n  type: string\nAPI_KEY:\n  description: the key";
		expect(redactSkillContent(yaml)).toEqual({ text: yaml, redactions: [], findings: [] });
	});
	test("an env reference with Markdown-escaped underscores, as scraped docs write it, is kept", () => {
		const line = '-H "Authorization: Bearer $OPENAI\\_API\\_KEY"';
		expect(redactSkillContent(line)).toEqual({ text: line, redactions: [], findings: [] });
	});
});
describe("redactSkillContent redacts real values", () => {
	test("a literal assignment is redacted and reported as one assignment", () => {
		const value = rnd(ALNUM, 16);
		expect(redactSkillContent(`LINEAR_API_KEY=${value}`)).toEqual({
			text: `LINEAR_API_KEY=${REDACTED}`,
			redactions: [{ line: 1, rule: "assignment" }],
			findings: [],
		});
	});
	test("a Bearer header carrying a 40-character literal is redacted as bearer", () => {
		const literal = "a1B2".repeat(10);
		const out = redactSkillContent(`curl -H "Authorization: Bearer ${literal}" https://api.example.test`);
		expect(out.text).toBe(`curl -H "Authorization: Bearer ${REDACTED}" https://api.example.test`);
		expect(out.redactions).toEqual([{ line: 1, rule: "bearer" }]);
		expect(out.findings).toEqual([]);
	});
	test("a connection URL keeps its host and loses its password", () => {
		expect(redactSkillContent("postgres://u:hunter2@h/db")).toEqual({
			text: `postgres://u:${REDACTED}@h/db`,
			redactions: [{ line: 1, rule: "url-password" }],
			findings: [],
		});
	});
	test("a quoted password redacts its whole value, not just the first word", () => {
		expect(redactSkillContent('{"password": "correct horse battery"}')).toEqual({
			text: `{"password": ${REDACTED}}`,
			redactions: [{ line: 1, rule: "password" }],
			findings: [],
		});
		expect(redactSkillContent("password: 'two words here'").text).toBe(`password: ${REDACTED}`);
	});
	test("redacting already-redacted text changes nothing more", () => {
		const once = redactSkillContent(`LINEAR_API_KEY=${rnd(ALNUM, 16)}\nAuthorization: Bearer ` + "z".repeat(40));
		expect(redactSkillContent(once.text)).toEqual({ text: once.text, redactions: [], findings: [] });
	});
});
describe("redactSkillContent rejects high-confidence secrets", () => {
	test("github, pem, jwt and aws shapes are findings, and no result field carries the value", () => {
		const cases: Array<[string, SkillRedactionRule, string]> = [
			[`GITHUB_TOKEN=${SKILL_GITHUB}`, "github", SKILL_GITHUB],
			[`key:\n${SKILL_PEM}`, "pem", SKILL_PEM_MIDDLE],
			[`token=${SKILL_JWT}`, "jwt", SKILL_JWT_LAST],
			[`aws_access_key_id = ${awsFixture}`, "aws", awsFixture],
		];
		for (const [text, rule, secret] of cases) {
			const out = redactSkillContent(text);
			expect(out.findings).toEqual([{ line: rule === "pem" ? 2 : 1, rule }]);
			expect(out.redactions).toEqual([]);
			expect(JSON.stringify(out)).not.toContain(secret);
		}
	});
	test("every high-confidence rule reports a finding rather than a redaction", () => {
		const samples: Partial<Record<SkillRedactionRule, string>> = {
			pem: SKILL_PEM,
			jwt: SKILL_JWT,
			github: SKILL_GITHUB,
			openai: "sk-" + "Q9w8".repeat(12),
			anthropic: "sk-ant-api03-" + "Z_y-".repeat(10),
			xai: "xai-" + "R7t6".repeat(16),
			linear: "lin_api_" + "P0o9".repeat(10),
			notion: "ntn_" + "L1k2".repeat(12),
			tailscale: "tskey-" + "auth-" + rnd(ALNUM, 12),
			aws: awsFixture,
			google: "AIza" + rnd(ALNUM, 35),
			slack: "xoxb-" + rnd(ALNUM, 24),
			npm: "npm_" + rnd(ALNUM, 36),
			gitlab: "glpat-" + rnd(ALNUM, 20),
			digitalocean: "dop_v1_" + rnd(HEX, 64),
			"openai-proj": "sk-proj-" + rnd(ALNUM, 40),
			ragflow: "ragflow-" + rnd(ALNUM, 40),
			stripe: "sk_live_" + rnd(ALNUM, 24),
			huggingface: "hf_" + rnd(ALNUM, 34),
			"google-oauth": "ya29." + rnd(ALNUM, 40),
			sendgrid: "SG." + rnd(ALNUM, 22) + "." + rnd(ALNUM, 43),
			shopify: "shpat_" + rnd(HEX, 32),
			supabase: "sbp_" + rnd(HEX, 40),
			glitch: "glsoat-" + rnd(ALNUM, 32),
			twilio: "SK" + rnd(HEX, 32),
		};
		for (const rule of SKILL_HIGH_CONFIDENCE_RULES) {
			const sample = samples[rule];
			expect(sample).toBeDefined();
			const out = redactSkillContent(`value ${sample}`);
			expect(out.findings).toEqual([{ line: 1, rule }]);
			expect(out.redactions).toEqual([]);
		}
	});
});
describe("redactSkillContent documentation examples", () => {
	test("allowed pem and jwt spans are replaced and reported as redactions; a github token is still a finding", () => {
		const out = redactSkillContent(`${SKILL_PEM}\njwt: ${SKILL_JWT}\ngh: ${SKILL_GITHUB}`, {
			allowDocExamples: new Set(["pem", "jwt"] as const),
		});
		expect(out.text).toBe(`[REDACTED_PEM]\njwt: ${REDACTED}\ngh: ${REDACTED}`);
		expect(out.redactions).toEqual([
			{ line: 1, rule: "pem" },
			{ line: 4, rule: "jwt" },
		]);
		expect(out.findings).toEqual([{ line: 5, rule: "github" }]);
	});
});
describe("redactSkillContent line numbers", () => {
	test("are 1-based and count lines of the original text, before a multi-line block collapses", () => {
		const tokenValue = rnd(ALNUM, 16);
		const passwordValue = rnd(ALNUM, 10);
		const text = `intro\n${SKILL_PEM}\n\nDB_TOKEN=${tokenValue}\n  password: ${passwordValue}`;
		const out = redactSkillContent(text, { allowDocExamples: new Set(["pem"] as const) });
		expect(out.text).toBe(`intro\n[REDACTED_PEM]\n\nDB_TOKEN=${REDACTED}\n  password: ${REDACTED}`);
		expect(out.redactions).toEqual([
			{ line: 2, rule: "pem" },
			{ line: 6, rule: "assignment" },
			{ line: 7, rule: "password" },
		]);
	});
});
describe("scanSkillFiles", () => {
	test("reports redactions and findings per file and returns the redacted file map", () => {
		const tokenValue = rnd(ALNUM, 16);
		const out = scanSkillFiles({
			"SKILL.md": `---\nname: demo\n---\nTOKEN=${tokenValue}\nAuthorization: Bearer $DEMO_KEY\n`,
			"references/a.md": `intro\n${SKILL_GITHUB}\n`,
		});
		expect(out.files).toEqual({
			"SKILL.md": `---\nname: demo\n---\nTOKEN=${REDACTED}\nAuthorization: Bearer $DEMO_KEY\n`,
			"references/a.md": `intro\n${REDACTED}\n`,
		});
		expect(out.redactions).toEqual([{ file: "SKILL.md", line: 4, rule: "assignment" }]);
		expect(out.findings).toEqual([{ file: "references/a.md", line: 2, rule: "github" }]);
	});
	test("scanSkillFiles is the only exported scan", () => {
		const scanners = Object.keys(redactModule).filter((key) => /^scan/i.test(key));
		expect(scanners).toEqual(["scanSkillFiles"]);
	});
});
describe("event redactor stays liberal", () => {
	test("redact() still rewrites a working $VAR auth line that the skill redactor keeps", () => {
		const line = "Authorization: Bearer $PARALLEL_API_KEY";
		expect(redact(line)).toBe(`Authorization: ${REDACTED}`);
		expect(redactSkillContent(line).text).toBe(line);
	});
});
describe("skill api-key-lower keeps placeholders and redacts real values (D18-08)", () => {
	test("dollar-variable, angle-bracket and your-key placeholders are kept as written", () => {
		for (const line of ["api_key: $OPENAI_API_KEY", "apiKey: <your-key>", "api_key: your-api-key-goes-here"]) {
			expect(redactSkillContent(line)).toEqual({ text: line, redactions: [], findings: [] });
		}
	});
	test("a real api_key value redacts as api-key-lower", () => {
		const value = rnd(ALNUM, 24);
		expect(redactSkillContent(`api_key: ${value}`)).toEqual({
			text: `api_key: ${REDACTED}`,
			redactions: [{ line: 1, rule: "api-key-lower" }],
			findings: [],
		});
	});
	test("a private-tag block holding a GitHub token goes as one block and still reports the github finding", () => {
		const token = "ghp_" + rnd(ALNUM, 36);
		const block = "<" + "private>deploy with " + token + " inside</" + "private>";
		const out = redactSkillContent(block);
		expect(out.text).toBe(REDACTED);
		expect(out.redactions).toEqual([{ line: 1, rule: "private-tag" }]);
		expect(out.findings).toEqual([{ line: 1, rule: "github" }]);
		expect(JSON.stringify(out)).not.toContain(token);
	});
	test("a private-tag block holding an allowed jwt goes as one block with no inner hit", () => {
		const block = "<" + "private>the db root pass is hunter2 and " + SKILL_JWT + " too</" + "private>";
		const out = redactSkillContent(block, { allowDocExamples: new Set(["jwt"] as const) });
		expect(out.text).toBe(REDACTED);
		expect(out.redactions).toEqual([{ line: 1, rule: "private-tag" }]);
		expect(out.findings).toEqual([]);
		expect(JSON.stringify(out)).not.toContain(SKILL_JWT_LAST);
	});
	test("real values beginning with a placeholder word still redact (WR-02)", () => {
		const cases: Array<[string, SkillRedactionRule]> = [
			["password: YourDogRex2024!", "password"],
			["DB_PASSWORD=examplecorp-Pr0d-7731", "password"],
			[`apiKey: xxx${rnd(ALNUM, 18)}`, "api-key-lower"],
			[`SERVICE_TOKEN=redacted${rnd(ALNUM, 16)}`, "assignment"],
		];
		for (const [line, rule] of cases) {
			const out = redactSkillContent(line);
			expect(out.redactions).toEqual([{ line: 1, rule }]);
			expect(out.findings).toEqual([]);
			expect(out.text).toContain(REDACTED);
		}
	});
});
describe("skill pk-rk needs a digit in the tail (D18-21)", () => {
	test("word-only pk-/rk- slugs produce no skill hit", () => {
		for (const slug of ["pk-fix-the-bug-in-store", "rk-release-notes-for-october"]) {
			const text = `on branch ${slug} today`;
			expect(redactSkillContent(text)).toEqual({ text, redactions: [], findings: [] });
			const scanned = scanSkillFiles({ "SKILL.md": `${text}\n` });
			expect(scanned.findings).toEqual([]);
			expect(scanned.redactions).toEqual([]);
		}
	});
	test("a digit-bearing pk-lf- key is a pk-rk redaction", () => {
		const key = `pk-${pkBody}`;
		const out = redactSkillContent(`key is ${key} here`);
		expect(out.redactions).toEqual([{ line: 1, rule: "pk-rk" }]);
		expect(out.findings).toEqual([]);
		expect(out.text).toBe(`key is ${REDACTED} here`);
		expect(JSON.stringify(out)).not.toContain(pkBody);
	});
});
describe("event/skill parity (D18-09)", () => {
	test("every named event rule has a same-name skill rule or a reasoned exclusion", () => {
		const missing = REDACTION_RULES.map((entry) => entry.name).filter(
			(name) => !SKILL_RULE_NAMES.includes(name) && !(name in SKILL_EXCLUSIONS),
		);
		expect(missing).toEqual([]);
	});
	test("every exclusion names a real rule and carries a reason", () => {
		for (const [name, reason] of Object.entries(SKILL_EXCLUSIONS)) {
			expect(REDACTION_RULES.some((entry) => entry.name === name)).toBe(true);
			expect(typeof reason === "string" && reason.length > 0).toBe(true);
		}
	});
	test("the exclusion list holds exactly keypair-array", () => {
		expect(Object.keys(SKILL_EXCLUSIONS).sort()).toEqual(["keypair-array"]);
	});
});
// ── Harness round trip (D18-19 item 3) ─────────────────────────────────────────
// Runs only under the rehearsal twin: SUBSTRATE_REHEARSAL_NAME is set by sourcing
// the harness's consumer.env, and only for this file — never the full suite with
// that env sourced. The twin guard below refuses a production target before any
// request, and `rehearsal down` closes the twin afterwards. No Phase 16 module is
// imported; the twin is driven over its HTTP doors only.
const describeRoundTrip = process.env.SUBSTRATE_REHEARSAL_NAME ? describe : describe.skip;
const D04_NAMES = [
	"private-tag",
	"api-key-lower",
	"aws",
	"google",
	"slack",
	"npm",
	"gitlab",
	"digitalocean",
	"openai-proj",
	"pk-rk",
] as const satisfies ReadonlyArray<RedactionRuleName>;
describeRoundTrip("harness round trip through the rehearsal twin", () => {
	test("D-04 fixtures do not survive the write path while counts do", async () => {
		// Twin guard (T-18-08): loopback host and never the production port,
		// asserted before any request — health check included.
		const base = (process.env.SUBSTRATE_URL ?? "").replace(/\/+$/, "");
		expect(base.length).toBeGreaterThan(0);
		const twin = new URL(base);
		const host = twin.hostname.replace(/^\[(.*)\]$/, "$1");
		expect(["127.0.0.1", "::1", "localhost"]).toContain(host);
		expect(Number(twin.port)).not.toBe(7410);
		const headers = {
			"content-type": "application/json",
			authorization: `Bearer ${process.env.SUBSTRATE_TOKEN ?? ""}`,
		};
		const tag = `rh-p18-${Date.now().toString(36)}`;
		const texts = D04_NAMES.flatMap((name) => FIXTURES[name].map((fixture) => fixture.text));
		const secrets = D04_NAMES.flatMap((name) => FIXTURES[name].map((fixture) => fixture.secret));
		const summary = `redaction round trip ${tag} ${texts.join(" ")}`;
		// The summary cap is 2000; the joined fixtures must fit under it.
		expect(summary.length).toBeLessThan(2000);
		const emit = await fetch(`${base}/events`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				kind: "note",
				summary,
				session_id: tag,
				graph_id: tag,
				payload: { fixtures: texts.join("\n"), input_tokens: 1200, output_tokens: 340 },
			}),
		});
		expect(emit.status).toBe(202);
		const emitBody: unknown = await emit.json();
		const stored =
			typeof emitBody === "object" && emitBody !== null && "stored" in emitBody ? emitBody.stored : undefined;
		expect(stored).toBe(true);
		// Read back through events_query, the same service call as the MCP tool.
		const query = await fetch(`${base}/events/query`, {
			method: "POST",
			headers,
			body: JSON.stringify({ session_id: tag, include_payload: true, limit: 10 }),
		});
		expect(query.status).toBe(200);
		const queryBody: unknown = await query.json();
		const events =
			typeof queryBody === "object" && queryBody !== null && "events" in queryBody && Array.isArray(queryBody.events)
				? queryBody.events
				: [];
		const found = events.find(
			(event): event is { session_id?: string; summary?: string; payload?: Record<string, unknown> } =>
				typeof event === "object" && event !== null,
		);
		const roundTripped = found?.session_id === tag ? found : undefined;
		expect(roundTripped).toBeDefined();
		expect(roundTripped!.summary).toContain("REDACTED");
		for (const secret of secrets) expect(JSON.stringify(roundTripped)).not.toContain(secret);
		expect(roundTripped!.payload?.input_tokens).toBe(1200);
		expect(roundTripped!.payload?.output_tokens).toBe(340);
	});
});
