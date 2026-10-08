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
import { mkdtempSync, rmSync } from "node:fs";
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
	LEDGER_KEYS,
	RehearsalEnvError,
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
