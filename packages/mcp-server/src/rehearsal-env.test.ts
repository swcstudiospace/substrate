/**
 * The scratch server environment round-trips through the real `loadConfig`
 * and refuses non-loopback stores and swarm operators.
 *
 * Every token value below is short (`tok-…` is never even written: values are
 * generated at runtime with `randomBytes`), so no line assigns a substrate
 * token key a 16+ character value. Ledger keys are reached only through
 * `LEDGER_KEYS`, never as literals before a value.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	configWarnings,
	isOperator,
	loadConfig,
	surfaceForToken,
	tokenEnvName,
} from "./config.ts";
import {
	assertLoopback,
	assertOperatorAllowed,
	buildRehearsalEnv,
	consumerEnvRecord,
	LEDGER_KEYS,
	RehearsalEnvError,
	storesEnvRecord,
	toShellExports,
	type BuildRehearsalEnvInput,
	type ScratchSecrets,
} from "./rehearsal-env.ts";
import type { Surface } from "./types.ts";

const UNDER_TEST: Surface[] = ["claude-code", "cursor", "hermes", "omp"];
const OPERATOR: Surface = "claude-code";

const made: string[] = [];
afterAll(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "substrate-rehearsal-"));
	made.push(dir);
	return dir;
}

/** Scratch secrets are generated at runtime, never written as literals. */
function freshSecrets(surfaces: Surface[] = UNDER_TEST): ScratchSecrets {
	const surfaceTokens: Partial<Record<Surface, string>> = {};
	for (const surface of surfaces) surfaceTokens[surface] = randomBytes(16).toString("hex");
	return {
		ledgerUser: `rh-user-${randomBytes(3).toString("hex")}`,
		ledgerPassword: randomBytes(16).toString("hex"),
		pgPassword: randomBytes(12).toString("hex"),
		handoffKey: randomBytes(32).toString("hex"),
		surfaceTokens,
	};
}

function scratchInput(over: Partial<BuildRehearsalEnvInput> = {}): BuildRehearsalEnvInput {
	return {
		ports: { mcp: 17410, ledger: 15400, postgres: 15432 },
		secrets: freshSecrets(),
		surfaces: [...UNDER_TEST],
		operator: OPERATOR,
		runDir: tempDir(),
		parentEnv: { PATH: "/usr/bin:/bin", HOME: "/root" },
		...over,
	};
}

describe("buildRehearsalEnv round-trip", () => {
	test("built env loads through the real loadConfig with zero warnings", () => {
		const input = scratchInput();
		const env = buildRehearsalEnv(input);
		const config = loadConfig(env);
		expect(config.host).toBe("127.0.0.1");
		expect(config.port).toBe(17410);
		expect(config.tokens.size).toBe(UNDER_TEST.length);
		expect(config.allowAnonymous).toBe(false);
		expect(configWarnings(config)).toEqual([]);
		expect(config.greptime?.url).toBe("http://127.0.0.1:15400");
		expect(config.greptime?.db).toBe("public");
		expect(config.postgresUrl).toContain("127.0.0.1:15432");
		expect(config.handoffKeyId).toBe("k1");
		for (const surface of UNDER_TEST) {
			expect(config.tokens.get(input.secrets.surfaceTokens[surface] ?? "")).toBe(surface);
		}
		expect(surfaceForToken(config, `Bearer ${input.secrets.surfaceTokens.hermes ?? ""}`)).toBe("hermes");
	});

	test("operator token is a surface token value, and other surfaces are not operators", () => {
		const env = buildRehearsalEnv(scratchInput());
		const config = loadConfig(env);
		const token = env.SUBSTRATE_OPERATOR_TOKENS ?? "";
		expect(token.length).toBeGreaterThan(0);
		expect(config.tokens.has(token)).toBe(true);
		expect(isOperator(config, `Bearer ${token}`)).toBe(true);
		expect(surfaceForToken(config, `Bearer ${token}`)).toBe(OPERATOR);
		const other = UNDER_TEST.find((surface) => surface !== OPERATOR) ?? OPERATOR;
		const otherToken = env[tokenEnvName(other)] ?? "";
		expect(isOperator(config, `Bearer ${otherToken}`)).toBe(false);
	});

	test("audit path is a file inside the run directory", () => {
		const input = scratchInput();
		const config = loadConfig(buildRehearsalEnv(input));
		expect(config.audit.path).toBe(join(input.runDir, "mcp-audit.jsonl"));
	});

	test("anonymous variant allows anonymous with zero operator tokens", () => {
		const env = buildRehearsalEnv(scratchInput({ surfaces: [], operator: null }));
		const config = loadConfig(env);
		expect(config.allowAnonymous).toBe(true);
		expect(config.tokens.size).toBe(0);
		expect(config.operatorTokens.size).toBe(0);
		expect(configWarnings(config)).toEqual([]);
		expect("SUBSTRATE_OPERATOR_TOKENS" in env).toBe(false);
	});
});

describe("refusals", () => {
	test("assertLoopback accepts loopback and refuses the rest", () => {
		expect(() => assertLoopback("http://127.0.0.1:15400", "ledger")).not.toThrow();
		expect(() => assertLoopback("http://[::1]:15400", "ledger")).not.toThrow();
		expect(() => assertLoopback("http://localhost:15400", "ledger")).not.toThrow();
		for (const bad of [
			"https://ledger.example.com:443",
			"http://10.0.0.5:5432",
			"http://192.168.1.2:5432",
			"not-a-url",
		]) {
			expect(() => assertLoopback(bad, "ledger")).toThrow(RehearsalEnvError);
		}
	});

	test("refusal names the host, never the embedded password", () => {
		const raw = "postgresql://postgres:pw-that-must-not-print@db.example.com:5432/postgres";
		let caught: unknown = null;
		try {
			assertLoopback(raw, "postgres");
		} catch (cause) {
			caught = cause;
		}
		expect(caught).toBeInstanceOf(RehearsalEnvError);
		expect(String(caught)).toContain("db.example.com");
		expect(String(caught)).not.toContain("pw-that-must-not-print");
	});

	test("swarm surface is never an operator", () => {
		expect(() =>
			buildRehearsalEnv(
				scratchInput({ surfaces: ["claude-code", "swarm-a05-be"], operator: "swarm-a05-be" }),
			),
		).toThrow(RehearsalEnvError);
		expect(() => assertOperatorAllowed(["claude-code", "swarm-a05-be"], "swarm-a05-be")).toThrow(
			RehearsalEnvError,
		);
	});

	test("operator without a surface token and unknown surfaces are refused", () => {
		expect(() => buildRehearsalEnv(scratchInput({ operator: "muse" }))).toThrow(RehearsalEnvError);
		expect(() => buildRehearsalEnv(scratchInput({ surfaces: ["muse"], operator: null }))).toThrow(
			RehearsalEnvError,
		);
		expect(() => buildRehearsalEnv(scratchInput({ surfaces: ["nope" as Surface], operator: null }))).toThrow(
			RehearsalEnvError,
		);
	});
});

/** What a production value would be: if the builder ever forwarded the parent env, this string would leak. */
const SENTINEL = "rh-leak-9f3a";

describe("allowlist", () => {
	test("parent production values never reach the built env", () => {
		const parentEnv: Record<string, string | undefined> = {
			PATH: "/usr/bin:/bin",
			HOME: "/root",
			BUN_INSTALL: "/root/.bun",
			LINEAR_API_KEY: SENTINEL,
			NOTION_API_KEY: SENTINEL,
			OTEL_EXPORTER_OTLP_ENDPOINT: SENTINEL,
			SUBSTRATE_PG_URL: SENTINEL,
			SUBSTRATE_OPERATOR_TOKENS: SENTINEL,
			SUBSTRATE_TOKEN_HERMES: SENTINEL,
			[LEDGER_KEYS.url]: SENTINEL,
			[LEDGER_KEYS.user]: SENTINEL,
		};
		const env = buildRehearsalEnv(scratchInput({ parentEnv }));
		expect(JSON.stringify(env)).not.toContain(SENTINEL);
	});

	test("built env holds exactly the allowlist plus the scratch keys", () => {
		const env = buildRehearsalEnv(
			scratchInput({
				parentEnv: { PATH: "/usr/bin:/bin", HOME: "/root", BUN_INSTALL: "/root/.bun" },
			}),
		);
		const expected = new Set([
			"PATH",
			"HOME",
			"BUN_INSTALL",
			"SUBSTRATE_HOST",
			"SUBSTRATE_PORT",
			LEDGER_KEYS.url,
			LEDGER_KEYS.user,
			LEDGER_KEYS.password,
			LEDGER_KEYS.db,
			"SUBSTRATE_PG_URL",
			...UNDER_TEST.map(tokenEnvName),
			"SUBSTRATE_OPERATOR_TOKENS",
			"SUBSTRATE_AUDIT_PATH",
			"SUBSTRATE_HANDOFF_KEY",
		]);
		expect(new Set(Object.keys(env))).toEqual(expected);
	});
});

describe("stores and consumer records", () => {
	test("stores record carries the ledger keys and loads as the server greptime shape", () => {
		const input = scratchInput();
		const stores = storesEnvRecord({ ports: input.ports, secrets: input.secrets });
		expect(stores[LEDGER_KEYS.url]).toBe("http://127.0.0.1:15400");
		expect(stores[LEDGER_KEYS.db]).toBe("public");
		expect(stores.SUBSTRATE_PG_URL).toContain("127.0.0.1:15432");
		expect(new Set(Object.keys(stores))).toEqual(
			new Set([LEDGER_KEYS.url, LEDGER_KEYS.user, LEDGER_KEYS.password, LEDGER_KEYS.db, "SUBSTRATE_PG_URL"]),
		);
		expect(loadConfig(stores).greptime?.url).toBe("http://127.0.0.1:15400");
	});

	test("consumer record holds the six contract keys and no ledger key", () => {
		const server = buildRehearsalEnv(scratchInput());
		const token = server[tokenEnvName(UNDER_TEST[0] ?? "claude-code")] ?? "";
		const opToken = server[tokenEnvName("hermes")] ?? "";
		const runDir = tempDir();
		const out = consumerEnvRecord({
			mcpPort: 17410,
			firstToken: token,
			operatorToken: opToken,
			runDir,
			name: "default",
			testPgUrl: server.SUBSTRATE_PG_URL ?? "",
		});
		expect(out.SUBSTRATE_URL).toBe("http://127.0.0.1:17410");
		expect(out.SUBSTRATE_TOKEN).toBe(token);
		expect(out.SUBSTRATE_REHEARSAL_OPERATOR_TOKEN).toBe(opToken);
		expect(out.SUBSTRATE_REHEARSAL_TOKENS_DIR).toBe(join(runDir, "tokens"));
		expect(out.SUBSTRATE_REHEARSAL_NAME).toBe("default");
		expect(out.SUBSTRATE_TEST_PG_URL).toBe(server.SUBSTRATE_PG_URL);
		expect(Object.keys(out)).toHaveLength(6);
		for (const key of Object.values(LEDGER_KEYS)) expect(out).not.toHaveProperty(key);
	});

	test("SUBSTRATE_TOKEN stays the first surface when the operator differs", () => {
		// An `--operator hermes` twin must not promote the operator token to
		// the client credential: proofs source SUBSTRATE_TOKEN, and only the
		// smoke reads the operator key.
		const server = buildRehearsalEnv(scratchInput());
		const first = server[tokenEnvName("claude-code")] ?? "";
		const op = server[tokenEnvName("hermes")] ?? "";
		expect(op.length).toBeGreaterThan(0);
		expect(op).not.toBe(first);
		const out = consumerEnvRecord({
			mcpPort: 17410,
			firstToken: first,
			operatorToken: op,
			runDir: tempDir(),
			name: "op-twin",
			testPgUrl: server.SUBSTRATE_PG_URL ?? "",
		});
		expect(out.SUBSTRATE_TOKEN).toBe(first);
		expect(out.SUBSTRATE_REHEARSAL_OPERATOR_TOKEN).toBe(op);
	});

	test("toShellExports renders sorted single-quoted lines", () => {
		expect(toShellExports({ B_KEY: "b'b", A_KEY: "a a" })).toBe(
			"export A_KEY='a a'\nexport B_KEY='b'\\''b'\n",
		);
	});

	test("toShellExports output sources cleanly in sh", () => {
		const dir = tempDir();
		const file = join(dir, "consumer.env");
		writeFileSync(
			file,
			toShellExports({ SUBSTRATE_URL: "http://127.0.0.1:17410", SUBSTRATE_REHEARSAL_NAME: "it's quoted" }),
		);
		const run = Bun.spawnSync(["sh", "-c", `. "$0"; printf "%s|%s" "$SUBSTRATE_URL" "$SUBSTRATE_REHEARSAL_NAME"`, file]);
		expect(run.exitCode).toBe(0);
		expect(run.stdout.toString()).toBe("http://127.0.0.1:17410|it's quoted");
	});
});
