import { describe, expect, test } from "bun:test";
import { REDACTED, redact, redactValue } from "./redact.ts";
import { SKILL_HIGH_CONFIDENCE_RULES, redactSkillContent, scanSkillFiles, type SkillRedactionRule } from "./redact.ts";

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

// Token-shaped fixtures are assembled at runtime so no literal secret shape sits in the source.
const GITHUB = "ghp_" + "A1b2".repeat(9);
const PEM = ["-----BEGIN " + "RSA PRIVATE KEY-----", "MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn", "-----END " + "RSA PRIVATE KEY-----"].join("\n");
const JWT = ["eyJ" + "hbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dBjftJeZ4CVPmB92K27uhbUJU1p1r"].join(".");
const AWS = "AKIA" + "QWERTYUIOPASDFGH";

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
		expect(redactSkillContent("LINEAR_API_KEY=abcd1234efgh5678")).toEqual({
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

	test("redacting already-redacted text changes nothing more", () => {
		const once = redactSkillContent("LINEAR_API_KEY=abcd1234efgh5678\nAuthorization: Bearer " + "z".repeat(40));
		expect(redactSkillContent(once.text)).toEqual({ text: once.text, redactions: [], findings: [] });
	});
});

describe("redactSkillContent rejects high-confidence secrets", () => {
	test("github, pem, jwt and aws shapes are findings, and no result field carries the value", () => {
		const cases: Array<[string, SkillRedactionRule, string]> = [
			[`GITHUB_TOKEN=${GITHUB}`, "github", GITHUB],
			[`key:\n${PEM}`, "pem", "MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn"],
			[`token=${JWT}`, "jwt", JWT],
			[`aws_access_key_id = ${AWS}`, "aws", AWS],
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
			pem: PEM,
			jwt: JWT,
			github: GITHUB,
			openai: "sk-" + "Q9w8".repeat(12),
			anthropic: "sk-ant-api03-" + "Z_y-".repeat(10),
			xai: "xai-" + "R7t6".repeat(16),
			linear: "lin_api_" + "P0o9".repeat(10),
			notion: "ntn_" + "L1k2".repeat(12),
			tailscale: "tskey-auth-kX9fQ2mNpL",
			aws: AWS,
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
		const out = redactSkillContent(`${PEM}\njwt: ${JWT}\ngh: ${GITHUB}`, { allowDocExamples: new Set(["pem", "jwt"] as const) });
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
		const text = `intro\n${PEM}\n\nDB_TOKEN=abc123def456\n  password: hunter2`;
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
		const out = scanSkillFiles({
			"SKILL.md": "---\nname: demo\n---\nTOKEN=abcdef123456\nAuthorization: Bearer $DEMO_KEY\n",
			"references/a.md": `intro\n${GITHUB}\n`,
		});
		expect(out.files).toEqual({
			"SKILL.md": `---\nname: demo\n---\nTOKEN=${REDACTED}\nAuthorization: Bearer $DEMO_KEY\n`,
			"references/a.md": `intro\n${REDACTED}\n`,
		});
		expect(out.redactions).toEqual([{ file: "SKILL.md", line: 4, rule: "assignment" }]);
		expect(out.findings).toEqual([{ file: "references/a.md", line: 2, rule: "github" }]);
	});
});

describe("event redactor stays liberal", () => {
	test("redact() still rewrites a working $VAR auth line that the skill redactor keeps", () => {
		const line = "Authorization: Bearer $PARALLEL_API_KEY";
		expect(redact(line)).toBe(`Authorization: ${REDACTED}`);
		expect(redactSkillContent(line).text).toBe(line);
	});
});
