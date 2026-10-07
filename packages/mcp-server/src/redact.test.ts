import { describe, expect, test } from "bun:test";
import { REDACTED, redact, redactValue } from "./redact.ts";

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
