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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	configWarnings,
	desktopConfigWarnings,
	isOperator,
	loadConfig,
	surfaceForToken,
	tokenEnvName,
} from "./config.ts";
import {
	assertDesktopSurfacesAllowed,
	assertLoopback,
	assertOperatorAllowed,
	buildRehearsalEnv,
	consumerEnvRecord,
	LEDGER_KEYS,
	REHEARSAL_DOCS_STATE_FILENAME,
	REHEARSAL_DOCS_STATE_KEY,
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
		desktopSurfaces: [],
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
		expect(desktopConfigWarnings(config)).toEqual([]);
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

	test("desktop dir is the runDir desktop join, and the allowlist round-trips", () => {
		const input = scratchInput({ desktopSurfaces: ["omp", "cursor"] });
		const env = buildRehearsalEnv(input);
		expect(env.SUBSTRATE_DESKTOP_SURFACES).toBe("omp,cursor");
		const config = loadConfig(env);
		expect(config.desktopDir).toBe(join(input.runDir, "desktop"));
		expect([...config.desktopSurfaces].sort()).toEqual(["cursor", "omp"]);
		expect(desktopConfigWarnings(config)).toEqual([]);
	});

	test("an empty allowlist writes no surfaces key and warns nothing", () => {
		const env = buildRehearsalEnv(scratchInput());
		expect("SUBSTRATE_DESKTOP_SURFACES" in env).toBe(false);
		expect(desktopConfigWarnings(loadConfig(env))).toEqual([]);
	});

	test("anonymous variant allows anonymous with zero operator tokens", () => {
		const env = buildRehearsalEnv(scratchInput({ surfaces: [], operator: null }));
		const config = loadConfig(env);
		expect(config.allowAnonymous).toBe(true);
		expect(config.tokens.size).toBe(0);
		expect(config.operatorTokens.size).toBe(0);
		expect(configWarnings(config)).toEqual([]);
		expect(desktopConfigWarnings(config)).toEqual([]);
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

	test("a desktop surface outside the surface tokens is refused, naming the surface", () => {
		let caught: unknown = null;
		try {
			buildRehearsalEnv(scratchInput({ surfaces: ["omp"], operator: null, desktopSurfaces: ["cursor"] }));
		} catch (cause) {
			caught = cause;
		}
		expect(caught).toBeInstanceOf(RehearsalEnvError);
		expect(String(caught)).toContain("cursor");
		expect(() => assertDesktopSurfacesAllowed(["omp"], ["omp"])).not.toThrow();
		expect(() => assertDesktopSurfacesAllowed(["omp"], [])).not.toThrow();
		expect(() => assertDesktopSurfacesAllowed(["omp"], ["cursor"])).toThrow(RehearsalEnvError);
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
			SUBSTRATE_DESKTOP_SURFACES: SENTINEL,
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
			"SUBSTRATE_DESKTOP_DIR",
			"SUBSTRATE_HANDOFF_KEY",
			"SUBSTRATE_SKILLS_STATE",
		]);
		expect(new Set(Object.keys(env))).toEqual(expected);
	});

	test("the skills state is always inside the run directory, so a twin cannot write the host's", () => {
		const runDir = tempDir();
		const env = buildRehearsalEnv(scratchInput({ runDir }));
		expect(env.SUBSTRATE_SKILLS_STATE).toBe(join(runDir, "skills"));
		// Nothing else about the library is set without a fixture: the defaults stand, and with no
		// mirror in that directory a proposal fails before any git or gh call.
		for (const key of ["SUBSTRATE_SKILLS_REPO", "SUBSTRATE_SKILLS_REMOTE_URL", "SUBSTRATE_SKILLS_GH"]) {
			expect(env).not.toHaveProperty(key);
		}
		expect(loadConfig(env).skills.stateDir).toBe(join(runDir, "skills"));
	});

	test("a non-empty desktop allowlist adds exactly the surfaces key", () => {
		const input = scratchInput({
			parentEnv: { PATH: "/usr/bin:/bin", HOME: "/root" },
			desktopSurfaces: ["omp"],
		});
		const env = buildRehearsalEnv(input);
		expect(env.SUBSTRATE_DESKTOP_SURFACES).toBe("omp");
		expect(env.SUBSTRATE_DESKTOP_DIR).toBe(join(input.runDir, "desktop"));
		expect(new Set(Object.keys(env))).toEqual(
			new Set([
				"PATH",
				"HOME",
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
				"SUBSTRATE_DESKTOP_DIR",
				"SUBSTRATE_DESKTOP_SURFACES",
				"SUBSTRATE_SKILLS_STATE",
				"SUBSTRATE_HANDOFF_KEY",
			]),
		);
	});
});

describe("the skills fixture's settings", () => {
	function fixtureIn(runDir: string): Record<string, string> {
		return {
			SUBSTRATE_SKILLS_STATE: join(runDir, "skills"),
			SUBSTRATE_SKILLS_REPO: "rehearsal/agent-skills",
			SUBSTRATE_SKILLS_REMOTE_URL: `file://${join(runDir, "skills-fixture", "origin.git")}`,
			SUBSTRATE_SKILLS_GH: join(runDir, "skills-fixture", "gh"),
		};
	}

	test("a leftover fixture mirror is refused when this run is not a fixture", () => {
		const runDir = tempDir();
		mkdirSync(join(runDir, "skills", "mirror.git"), { recursive: true });
		writeFileSync(join(runDir, "skills", "mirror.git", "HEAD"), "ref: refs/heads/main\n");
		expect(() => buildRehearsalEnv(scratchInput({ runDir }))).toThrow("skills fixture mirror");
	});

	test("are added to the server env and load as a valid non-default library", () => {
		const runDir = tempDir();
		const env = buildRehearsalEnv(scratchInput({ runDir, skillsFixture: fixtureIn(runDir) }));
		const config = loadConfig(env);

		expect(config.skills.repo).toBe("rehearsal/agent-skills");
		expect(config.skills.remoteUrl.startsWith("file://")).toBe(true);
		expect(config.skills.gh).toBe(join(runDir, "skills-fixture", "gh"));
		expect(configWarnings(config)).toEqual([]);
		expect(env.HOME).toBe(join(runDir, "home"));
	});

	test("refuse a key the harness does not add", () => {
		const runDir = tempDir();
		expect(() => buildRehearsalEnv(scratchInput({ runDir, skillsFixture: { ...fixtureIn(runDir), GH_TOKEN: "x" } }))).toThrow(
			"GH_TOKEN is not a skills fixture setting",
		);
	});

	test("refuse a state directory, a gh script or a remote outside the run directory", () => {
		const runDir = tempDir();
		const outside = tempDir();
		for (const key of ["SUBSTRATE_SKILLS_STATE", "SUBSTRATE_SKILLS_GH"]) {
			expect(() => buildRehearsalEnv(scratchInput({ runDir, skillsFixture: { ...fixtureIn(runDir), [key]: join(outside, "x") } }))).toThrow(
				`${key} is not inside the run directory`,
			);
		}
		expect(() =>
			buildRehearsalEnv(scratchInput({ runDir, skillsFixture: { ...fixtureIn(runDir), SUBSTRATE_SKILLS_REMOTE_URL: `file://${join(outside, "o.git")}` } })),
		).toThrow("SUBSTRATE_SKILLS_REMOTE_URL is not inside the run directory");
		expect(() =>
			buildRehearsalEnv(scratchInput({ runDir, skillsFixture: { ...fixtureIn(runDir), SUBSTRATE_SKILLS_REMOTE_URL: "https://github.com/swcstudiospace/agent-skills.git" } })),
		).toThrow("not a file:// URL");
		expect(() => buildRehearsalEnv(scratchInput({ runDir, skillsFixture: { ...fixtureIn(runDir), SUBSTRATE_SKILLS_GH: "gh" } }))).toThrow("not inside the run directory");
	});

	test("a path that climbs out with .. is outside too", () => {
		const runDir = tempDir();
		expect(() =>
			buildRehearsalEnv(scratchInput({ runDir, skillsFixture: { ...fixtureIn(runDir), SUBSTRATE_SKILLS_STATE: `${runDir}/../elsewhere` } })),
		).toThrow("not inside the run directory");
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

	test("the consumer record names the fixture's paths only when there is a fixture", () => {
		const server = buildRehearsalEnv(scratchInput());
		const base = {
			mcpPort: 17410,
			firstToken: server[tokenEnvName("claude-code")] ?? "",
			operatorToken: server[tokenEnvName("hermes")] ?? "",
			runDir: tempDir(),
			name: "fixture",
			testPgUrl: server.SUBSTRATE_PG_URL ?? "",
		};
		const skills = { state: "/run/x/skills", origin: "/run/x/skills-fixture/o.git", ghState: "/run/x/skills-fixture/gh-state.json", repo: "rehearsal/agent-skills" };
		const out = consumerEnvRecord({ ...base, skills });

		expect(out.SUBSTRATE_REHEARSAL_SKILLS_STATE).toBe(skills.state);
		expect(out.SUBSTRATE_REHEARSAL_SKILLS_ORIGIN).toBe(skills.origin);
		expect(out.SUBSTRATE_REHEARSAL_SKILLS_GH_STATE).toBe(skills.ghState);
		expect(out.SUBSTRATE_REHEARSAL_SKILLS_REPO).toBe(skills.repo);
		expect(Object.keys(out)).toHaveLength(10);
		expect(Object.keys(consumerEnvRecord({ ...base, skills: null }))).toHaveLength(6);
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

describe("the opt-in tracker block", () => {
	const TRACKERS = {
		hermesLinearUrl: "http://127.0.0.1:18792",
		linearApiUrl: "http://127.0.0.1:18793/graphql",
		notionApiUrl: "http://127.0.0.1:18794",
	};

	test("off by default: no tracker keys without the block", () => {
		const env = buildRehearsalEnv(scratchInput());
		expect(env.LINEAR_API_KEY).toBeUndefined();
		expect(env.NOTION_API_KEY).toBeUndefined();
		expect(env.HERMES_LINEAR_URL).toBeUndefined();
		expect(env.LINEAR_API_URL).toBeUndefined();
		expect(env.NOTION_API_URL).toBeUndefined();
	});

	test("loopback endpoints are emitted and load through the real loadConfig", () => {
		const env = buildRehearsalEnv(scratchInput({ trackers: TRACKERS }));
		const config = loadConfig(env);
		expect(config.hermesLinearUrl).toBe("http://127.0.0.1:18792");
		expect(config.linearApiUrl).toBe("http://127.0.0.1:18793/graphql");
		expect(config.notionApiUrl).toBe("http://127.0.0.1:18794");
		expect(config.linearApiKey).toMatch(/^rh-linear-/);
		expect(config.notionApiKey).toMatch(/^rh-notion-/);
	});

	test("a non-loopback tracker URL is refused before any server starts", () => {
		for (const key of ["hermesLinearUrl", "linearApiUrl", "notionApiUrl"] as const) {
			expect(() =>
				buildRehearsalEnv(scratchInput({ trackers: { ...TRACKERS, [key]: "https://api.linear.app/graphql" } })),
			).toThrow(RehearsalEnvError);
		}
	});

	test("scratch keys are random per build and never the host's", () => {
		const hostLinear = `host-linear-${randomBytes(8).toString("hex")}`;
		const hostNotion = `host-notion-${randomBytes(8).toString("hex")}`;
		const parentEnv = { PATH: "/usr/bin:/bin", HOME: "/root", LINEAR_API_KEY: hostLinear, NOTION_API_KEY: hostNotion };
		const first = buildRehearsalEnv(scratchInput({ parentEnv, trackers: TRACKERS }));
		const second = buildRehearsalEnv(scratchInput({ parentEnv, trackers: TRACKERS }));
		for (const env of [first, second]) {
			expect(env.LINEAR_API_KEY).toMatch(/^rh-linear-/);
			expect(env.NOTION_API_KEY).toMatch(/^rh-notion-/);
			expect(env.LINEAR_API_KEY).not.toBe(hostLinear);
			expect(env.NOTION_API_KEY).not.toBe(hostNotion);
		}
		expect(first.LINEAR_API_KEY).not.toBe(second.LINEAR_API_KEY);
		expect(first.NOTION_API_KEY).not.toBe(second.NOTION_API_KEY);
	});
});

describe("the opt-in RAGFlow fixture", () => {
	const FIXTURE_URL = "http://127.0.0.1:18410";

	function fixtureKey(): string {
		return `rh-fixture-${randomBytes(16).toString("hex")}`;
	}

	test("off by default: no RAGFlow reach without the fixture", () => {
		const env = buildRehearsalEnv(scratchInput());
		expect(env.RAGFLOW_URL).toBeUndefined();
		expect(env.RAGFLOW_API_KEY).toBeUndefined();
		expect(loadConfig(env).ragflow).toBeNull();
		expect(env.SUBSTRATE_DOCS_STATE_FILE).toBeUndefined();
	});

	test("loopback fixture reach is emitted and loads through the real loadConfig", () => {
		const key = fixtureKey();
		const input = scratchInput({ ragflowFixture: { url: FIXTURE_URL, apiKey: key } });
		const env = buildRehearsalEnv(input);
		expect(env.RAGFLOW_URL).toBe(FIXTURE_URL);
		expect(env.RAGFLOW_API_KEY).toBe(key);
		expect(loadConfig(env).ragflow).toEqual({ url: FIXTURE_URL, apiKey: key });
		expect(env.SUBSTRATE_DOCS_STATE_FILE).toBe(join(input.runDir, REHEARSAL_DOCS_STATE_FILENAME));
		expect(loadConfig(env).docsStateFile).toBe(join(input.runDir, REHEARSAL_DOCS_STATE_FILENAME));
	});

	test("a non-loopback fixture URL is refused before any server starts", () => {
		expect(() =>
			buildRehearsalEnv(scratchInput({ ragflowFixture: { url: "http://agent-substrate-forwarder:9380", apiKey: fixtureKey() } })),
		).toThrow(RehearsalEnvError);
	});

	test("an empty fixture key is refused before any server starts", () => {
		expect(() => buildRehearsalEnv(scratchInput({ ragflowFixture: { url: FIXTURE_URL, apiKey: "" } }))).toThrow(RehearsalEnvError);
	});

	test("the consumer record names the locator by name and never the plane key", () => {
		const server = buildRehearsalEnv(scratchInput());
		const base = {
			mcpPort: 17410,
			firstToken: server[tokenEnvName("claude-code")] ?? "",
			operatorToken: server[tokenEnvName("hermes")] ?? "",
			runDir: tempDir(),
			name: "ragflow",
			testPgUrl: server.SUBSTRATE_PG_URL ?? "",
		};
		const out = consumerEnvRecord({ ...base, ragflowFixture: { url: FIXTURE_URL, pid: 424243 } });
		expect(out.SUBSTRATE_RAGFLOW_FIXTURE_URL).toBe(FIXTURE_URL);
		expect(out.SUBSTRATE_RAGFLOW_FIXTURE_READY).toBe("1");
		expect(out.SUBSTRATE_RAGFLOW_FIXTURE_PID).toBe("424243");
		expect(Object.keys(out)).toHaveLength(9);
		expect(out).not.toHaveProperty("RAGFLOW_API_KEY");
		expect(out).not.toHaveProperty("RAGFLOW_URL");
		expect(Object.keys(consumerEnvRecord({ ...base, ragflowFixture: null }))).toHaveLength(6);
	});

	test("the consumer record combines both fixtures without changing either shape", () => {
		const server = buildRehearsalEnv(scratchInput());
		const base = {
			mcpPort: 17410,
			firstToken: server[tokenEnvName("claude-code")] ?? "",
			operatorToken: server[tokenEnvName("hermes")] ?? "",
			runDir: tempDir(),
			name: "both",
			testPgUrl: server.SUBSTRATE_PG_URL ?? "",
		};
		const skills = { state: "/run/x/skills", origin: "/run/x/skills-fixture/o.git", ghState: "/run/x/skills-fixture/gh-state.json", repo: "rehearsal/agent-skills" };
		const out = consumerEnvRecord({ ...base, skills, ragflowFixture: { url: FIXTURE_URL, pid: 424243 } });
		expect(Object.keys(out)).toHaveLength(13);
		expect(out.SUBSTRATE_REHEARSAL_SKILLS_REPO).toBe(skills.repo);
		expect(out.SUBSTRATE_RAGFLOW_FIXTURE_URL).toBe(FIXTURE_URL);
	});

	test("the consumer docs manifest names the own path only, absent by default", () => {
		const server = buildRehearsalEnv(scratchInput());
		const runDir = tempDir();
		const base = {
			mcpPort: 17410,
			firstToken: server[tokenEnvName("claude-code")] ?? "",
			operatorToken: server[tokenEnvName("hermes")] ?? "",
			runDir,
			name: "docsmanifest",
			testPgUrl: server.SUBSTRATE_PG_URL ?? "",
		};
		expect(consumerEnvRecord(base)).not.toHaveProperty(REHEARSAL_DOCS_STATE_KEY);
		const out = consumerEnvRecord({ ...base, docsStateFile: join(runDir, REHEARSAL_DOCS_STATE_FILENAME) });
		expect(out[REHEARSAL_DOCS_STATE_KEY]).toBe(join(runDir, REHEARSAL_DOCS_STATE_FILENAME));
		expect(Object.keys(out)).toHaveLength(7);
	});

	test("a docs manifest outside the run directory is refused", () => {
		const server = buildRehearsalEnv(scratchInput());
		const runDir = tempDir();
		const base = {
			mcpPort: 17410,
			firstToken: server[tokenEnvName("claude-code")] ?? "",
			operatorToken: server[tokenEnvName("hermes")] ?? "",
			runDir,
			name: "docsmanifest",
			testPgUrl: server.SUBSTRATE_PG_URL ?? "",
		};
		expect(() => consumerEnvRecord({ ...base, docsStateFile: join(tmpdir(), "elsewhere.json") })).toThrow(
			"is not inside the run directory",
		);
	});
});
