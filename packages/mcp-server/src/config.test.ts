/**
 * Identity rules in config.ts.
 *
 * SUBSTRATE_ALLOW_ANONYMOUS, the migration bridge. Unset keeps today's rule:
 * anonymous only when no surface token is configured. `1` accepts untokened
 * callers alongside tokens. `0` requires a bearer even when no token is
 * configured. A recognised token still names its surface.
 *
 * WR-01: the `substrate` host-job surface is never an operator. Host jobs
 * (anchor, skills-sync, dispatcher) run unattended under the same threat model
 * as the swarm: a listed substrate token able to `force`-release any lease
 * reintroduces the advisory lease. `isOperator` refuses it the way it refuses
 * every swarm surface, and `configWarnings` names the surface — never the
 * token — at boot.
 */
import { describe, expect, test } from "bun:test";
import { SOLANA_CLI_DEFAULT } from "@substrate/ledger";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	ConfigError,
	DEFAULT_SKILLS_GH,
	DEFAULT_SKILLS_REMOTE_URL,
	DEFAULT_SKILLS_REPO,
	DEFAULT_SKILLS_STATE,
	configWarnings,
	embedCacheFromEnv,
	isOperator,
	loadConfig,
	loadLedgerSettings,
	parseRedisUrl,
	railwayHostingFromEnv,
	surfaceForToken,
	teiFromEnv,
} from "./config.ts";

// Generated for each run, so no token-shaped literal sits in the repository.
const HERMES_TOKEN = `hermes-${randomUUID()}`;
const GROK_TOKEN = `grok-bot-${randomUUID()}`;
const CURSOR_TOKEN = `cursor-${randomUUID()}`;
const OPERATOR_TOKEN = `operator-${randomUUID()}`;
const SWARM_A05_TOKEN = `swarm-a05-${randomUUID()}`;
const HOST_JOB_TOKEN = `host-job-${randomUUID()}`;

describe("SUBSTRATE_ALLOW_ANONYMOUS", () => {
	test("unset with a token keeps today's rule: untokened callers are refused", () => {
		const config = loadConfig({ SUBSTRATE_TOKEN_GROK_BOT: "tok-grok" });

		expect(config.allowAnonymous).toBe(false);
		expect(surfaceForToken(config, "Bearer tok-grok")).toBe("grok-bot");
	});

	test("unset with no tokens stays a bare local run", () => {
		const config = loadConfig({});

		expect(config.allowAnonymous).toBe(true);
		expect(isOperator(config, null)).toBe(true);
	});

	test("1 keeps untokened callers alongside a configured token", () => {
		// Fails on 6417c92: loadConfig sets allowAnonymous from the token count alone
		// (config.ts), so the switch is ignored and a deployment with one token
		// refuses everyone who does not present it.
		const config = loadConfig({
			SUBSTRATE_ALLOW_ANONYMOUS: "1",
			SUBSTRATE_TOKEN_GROK_BOT: "tok-grok",
		});

		expect(config.allowAnonymous).toBe(true);
		expect(surfaceForToken(config, "Bearer tok-grok")).toBe("grok-bot");
		expect(surfaceForToken(config, null)).toBeNull();
	});

	test("0 forces authentication even when no token is configured", () => {
		const config = loadConfig({ SUBSTRATE_ALLOW_ANONYMOUS: "0" });

		expect(config.allowAnonymous).toBe(false);
		expect(config.tokens.size).toBe(0);
	});

	test("the bridge does not make an untokened caller an operator", () => {
		const config = loadConfig({
			SUBSTRATE_ALLOW_ANONYMOUS: "1",
			SUBSTRATE_TOKEN_GROK_BOT: "tok-grok",
		});

		expect(isOperator(config, null)).toBe(false);
		expect(isOperator(config, "Bearer tok-grok")).toBe(false);
	});

	test("an operator token that is not a surface token stays powerless on the bridge", () => {
		const config = loadConfig({
			SUBSTRATE_ALLOW_ANONYMOUS: "1",
			SUBSTRATE_TOKEN_GROK_BOT: "tok-grok",
			SUBSTRATE_OPERATOR_TOKENS: "tok-nowhere",
		});

		expect(isOperator(config, "Bearer tok-nowhere")).toBe(false);
		expect(surfaceForToken(config, "Bearer tok-nowhere")).toBeNull();
	});

	test("the bridge does not report that no surface token is configured", () => {
		const config = loadConfig({
			SUBSTRATE_ALLOW_ANONYMOUS: "1",
			SUBSTRATE_TOKEN_GROK_BOT: "tok-grok",
			SUBSTRATE_OPERATOR_TOKENS: "tok-grok",
		});

		expect(configWarnings(config).join("\n")).not.toContain("no SUBSTRATE_TOKEN_");
	});

	test(".env.example names the switch with no value", () => {
		const example = readFileSync(join(import.meta.dir, "..", "..", "..", ".env.example"), "utf8");

		expect(example.split("\n")).toContain("SUBSTRATE_ALLOW_ANONYMOUS=");
	});
});

describe("a substrate token is never an operator", () => {
	test("a listed substrate token is refused force, while an ordinary surface token keeps it", () => {
		const config = loadConfig({
			SUBSTRATE_TOKEN_CURSOR: "tok-operator",
			SUBSTRATE_TOKEN_SUBSTRATE: "tok-substrate",
			SUBSTRATE_OPERATOR_TOKENS: "tok-operator,tok-substrate",
		});

		expect(surfaceForToken(config, "Bearer tok-substrate")).toBe("substrate");
		expect(isOperator(config, "Bearer tok-substrate")).toBe(false);
		expect(isOperator(config, "Bearer tok-operator")).toBe(true);
	});

	test("boot names the substrate surface, without printing its token", () => {
		const config = loadConfig({
			SUBSTRATE_TOKEN_CURSOR: OPERATOR_TOKEN,
			SUBSTRATE_TOKEN_SUBSTRATE: HOST_JOB_TOKEN,
			SUBSTRATE_OPERATOR_TOKENS: `${OPERATOR_TOKEN},${HOST_JOB_TOKEN}`,
		});
		const warnings = configWarnings(config);

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("substrate");
		expect(warnings[0]).not.toContain(HOST_JOB_TOKEN);
	});

	test("a listed swarm token and a listed substrate token warn side by side", () => {
		const config = loadConfig({
			SUBSTRATE_TOKEN_CURSOR: OPERATOR_TOKEN,
			SUBSTRATE_TOKEN_SWARM_A05_BE: SWARM_A05_TOKEN,
			SUBSTRATE_TOKEN_SUBSTRATE: HOST_JOB_TOKEN,
			SUBSTRATE_OPERATOR_TOKENS: `${OPERATOR_TOKEN},${SWARM_A05_TOKEN},${HOST_JOB_TOKEN}`,
		});

		expect(isOperator(config, `Bearer ${SWARM_A05_TOKEN}`)).toBe(false);
		expect(isOperator(config, `Bearer ${HOST_JOB_TOKEN}`)).toBe(false);
		const warnings = configWarnings(config);
		expect(warnings).toHaveLength(2);
		expect(warnings.join("\n")).toContain("swarm-a05-be");
		expect(warnings.join("\n")).toContain("substrate");
		expect(warnings.join("\n")).not.toContain(HOST_JOB_TOKEN);
	});
});

describe("SUBSTRATE_SKILLS_*", () => {
	test("an empty env returns September defaults without throwing", () => {
		const config = loadConfig({});

		expect(config.skills).toEqual({
			repo: DEFAULT_SKILLS_REPO,
			remoteUrl: DEFAULT_SKILLS_REMOTE_URL,
			stateDir: DEFAULT_SKILLS_STATE,
			gh: DEFAULT_SKILLS_GH,
			problem: null,
		});
		expect(DEFAULT_SKILLS_REPO).toBe("swcstudiospace/agent-skills");
		expect(DEFAULT_SKILLS_REMOTE_URL).toBe("https://github.com/swcstudiospace/agent-skills.git");
		expect(DEFAULT_SKILLS_STATE).toBe("/var/lib/substrate/skills");
		expect(DEFAULT_SKILLS_GH).toBe("gh");
	});

	test("a non-default repo is accepted with a file:// remote and an absolute non-default gh", () => {
		const config = loadConfig({
			SUBSTRATE_SKILLS_REPO: "rehearsal/agent-skills",
			SUBSTRATE_SKILLS_REMOTE_URL: "file:///tmp/rehearsal/agent-skills.git",
			SUBSTRATE_SKILLS_GH: "/run/fake-gh",
		});

		expect(config.skills.problem).toBeNull();
		expect(config.skills.repo).toBe("rehearsal/agent-skills");
		expect(config.skills.remoteUrl).toBe("file:///tmp/rehearsal/agent-skills.git");
		expect(config.skills.gh).toBe("/run/fake-gh");
	});

	test("a non-default repo with the https remote is refused, naming the remote key", () => {
		const config = loadConfig({ SUBSTRATE_SKILLS_REPO: "someone/else" });

		expect(config.skills.problem).toContain("SUBSTRATE_SKILLS_REMOTE_URL");
	});

	test("a file:// remote with the default gh is refused, naming the gh key", () => {
		const config = loadConfig({
			SUBSTRATE_SKILLS_REPO: "rehearsal/agent-skills",
			SUBSTRATE_SKILLS_REMOTE_URL: "file:///tmp/rehearsal/agent-skills.git",
		});

		expect(config.skills.problem).toContain("SUBSTRATE_SKILLS_GH");
	});

	test("a file:// remote with a relative gh is refused, naming the gh key", () => {
		const config = loadConfig({
			SUBSTRATE_SKILLS_REMOTE_URL: "file:///tmp/rehearsal/agent-skills.git",
			SUBSTRATE_SKILLS_GH: "my-gh",
		});

		expect(config.skills.problem).toContain("SUBSTRATE_SKILLS_GH");
	});

	test("an invalid combination warns at boot before the operator-tokens early return", () => {
		const config = loadConfig({
			SUBSTRATE_TOKEN_CURSOR: "tok-operator",
			SUBSTRATE_OPERATOR_TOKENS: "tok-operator",
			SUBSTRATE_SKILLS_REPO: "someone/else",
		});
		const warnings = configWarnings(config);

		expect(warnings.join("\n")).toContain("SUBSTRATE_SKILLS_REMOTE_URL");
		expect(warnings.join("\n")).not.toContain("someone/else");
	});

	test("a valid library warns nothing on its own", () => {
		const config = loadConfig({
			SUBSTRATE_TOKEN_CURSOR: OPERATOR_TOKEN,
			SUBSTRATE_OPERATOR_TOKENS: OPERATOR_TOKEN,
		});

		expect(configWarnings(config)).toEqual([]);
	});
});

describe("mirror and DoD-gate config (D23-25)", () => {
	test("publicOrigin defaults to the substrate hostname and trims a trailing slash", () => {
		expect(loadConfig({}).publicOrigin).toBe("https://substrate.swcstudio.space");
		expect(loadConfig({ SUBSTRATE_PUBLIC_ORIGIN: "https://substrate.swcstudio.space/" }).publicOrigin).toBe(
			"https://substrate.swcstudio.space",
		);
	});

	test("hermesLinearUrl defaults to the connector loopback and trims a trailing slash", () => {
		expect(loadConfig({}).hermesLinearUrl).toBe("http://127.0.0.1:8792");
		expect(loadConfig({ HERMES_LINEAR_URL: "http://10.0.0.9:8792/" }).hermesLinearUrl).toBe(
			"http://10.0.0.9:8792",
		);
	});

	test("dodGateTimeoutMs defaults to 35000 and rejects non-positive input", () => {
		expect(loadConfig({}).dodGateTimeoutMs).toBe(35000);
		expect(loadConfig({ SUBSTRATE_DOD_GATE_TIMEOUT_MS: "10000" }).dodGateTimeoutMs).toBe(10000);
		expect(loadConfig({ SUBSTRATE_DOD_GATE_TIMEOUT_MS: "0" }).dodGateTimeoutMs).toBe(35000);
		expect(loadConfig({ SUBSTRATE_DOD_GATE_TIMEOUT_MS: "soon" }).dodGateTimeoutMs).toBe(35000);
	});

	test("LINEAR_API_URL and NOTION_API_URL default to the production endpoints", () => {
		const config = loadConfig({});
		expect(config.linearApiUrl).toBe("https://api.linear.app/graphql");
		expect(config.notionApiUrl).toBe("https://api.notion.com/v1");
	});

	test("endpoint overrides parse and trim trailing slashes", () => {
		const config = loadConfig({
			LINEAR_API_URL: "http://127.0.0.1:8801/graphql/",
			NOTION_API_URL: "http://127.0.0.1:8802/",
		});
		expect(config.linearApiUrl).toBe("http://127.0.0.1:8801/graphql");
		expect(config.notionApiUrl).toBe("http://127.0.0.1:8802");
	});

	test("existing tracker-key parsing is unchanged", () => {
		const config = loadConfig({ LINEAR_API_KEY: " lin-x ", NOTION_TASK_GRAPH_DS: "ds-1" });
		expect(config.linearApiKey).toBe("lin-x");
		expect(config.notionTaskGraphDataSource).toBe("ds-1");
		expect(config.notionApiKey).toBeUndefined();
	});
});

describe("SOLANA_* anchor config", () => {
	test("keypair and pubkey are null unless set; rpc and cli carry devnet defaults", () => {
		const config = loadConfig({});
		expect(config.solana).toEqual({
			rpcUrl: "https://api.devnet.solana.com",
			keypairPath: null,
			pubkey: null,
			cli: SOLANA_CLI_DEFAULT,
			problem: null,
			signerSet: null,
			signerSetProblem: null,
		});
	});

	test("names the four vars and trims them", () => {
		const config = loadConfig({
			SOLANA_RPC_URL: " https://rpc.test.invalid ",
			SOLANA_ANCHOR_KEYPAIR: " /etc/substrate/anchor-keypair.json ",
			SOLANA_ANCHOR_PUBKEY: " 4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T ",
			SOLANA_CLI: " /usr/local/bin/solana ",
		});
		expect(config.solana).toEqual({
			rpcUrl: "https://rpc.test.invalid",
			keypairPath: "/etc/substrate/anchor-keypair.json",
			pubkey: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T",
			cli: "/usr/local/bin/solana",
			problem: null,
			signerSet: null,
			signerSetProblem: null,
		});
	});

	test("a local test-validator URL is accepted", () => {
		expect(loadConfig({ SOLANA_RPC_URL: "http://localhost:8899" }).solana.problem).toBeNull();
	});

	test("a refused SOLANA_RPC_URL sets problem, keeps the value, never throws, and is warned about", () => {
		for (const url of [
			"https://api.mainnet-beta.solana.com",
			"https://API.TESTNET.SOLANA.COM",
			"https://user:s3cret@api.devnet.solana.com",
			"https://api.devnet.solana.com/#frag",
			"ftp://api.devnet.solana.com",
		]) {
			const config = loadConfig({ SOLANA_RPC_URL: url });
			expect(config.solana.rpcUrl).toBe(url);
			expect(config.solana.problem).toContain("SOLANA_RPC_URL refused");
			expect(config.solana.problem).not.toContain("s3cret");
			const warnings = configWarnings(config).join("\n");
			expect(warnings).toContain("SOLANA_RPC_URL");
			expect(warnings).not.toContain("s3cret");
		}
	});
});

describe("parseRedisUrl refuses plaintext non-loopback redis (DOCS-06)", () => {
	test("loopback redis and rediss stay allowed", () => {
		for (const url of [
			"redis://127.0.0.1:6379/0",
			"redis://127.0.0.2:6379/0",
			"redis://localhost:6379",
			"redis://[::1]:6379",
			"redis://:secret@127.0.0.1:6379/0",
			"rediss://localhost:6380/0",
		]) {
			expect(parseRedisUrl(url)).toEqual({ kind: "ok", url });
		}
		expect(parseRedisUrl(undefined)).toEqual({ kind: "unset" });
		// A DNS name that starts with 127. is not a loopback address.
		expect(parseRedisUrl("redis://127.cache.example.com:6379").kind).toBe("refused");
		expect(parseRedisUrl("rediss://cache.example.com:6380/0").kind).toBe("refused");
	});

	test("plaintext redis to a non-loopback host is refused fail-open", () => {
		const refused = parseRedisUrl("redis://user:pass@cache.example.com:6379/0");
		expect(refused.kind).toBe("refused");
		const config = loadConfig({ DRAGONFLY_URL: "redis://user:pass@cache.example.com:6379/0" });
		expect(config.cacheEnabled).toBe(false);
		expect(config.dragonflyUrl).toBeUndefined();
		expect(config.dragonflyRefused).toContain("cache.example.com");
		const loopback = loadConfig({ DRAGONFLY_URL: " redis://127.0.0.1:6379 " });
		expect(loopback.cacheEnabled).toBe(true);
		expect(loopback.dragonflyUrl).toBe("redis://127.0.0.1:6379");
		expect(loopback.dragonflyRefused).toBeNull();
	});
});

describe("railwayHostingFromEnv: the LightRAG key without a public URL", () => {
	test("a private-DNS deployment keeps LIGHTRAG_API_KEY for the health probe, with no public URL", () => {
		const railway = railwayHostingFromEnv({ RAILWAY_PROJECT_ID: "proj", LIGHTRAG_API_KEY: " key-1 " });
		expect(railway?.apiKey).toBe("key-1");
		expect(railway?.lightrag).toBeNull();
	});

	test("SUBSTRATE_LIGHTRAG_API_KEY still wins over LIGHTRAG_API_KEY", () => {
		const railway = railwayHostingFromEnv({ RAILWAY_PROJECT_ID: "proj", LIGHTRAG_API_KEY: "plain", SUBSTRATE_LIGHTRAG_API_KEY: "override" });
		expect(railway?.apiKey).toBe("override");
	});

	test("a blank LIGHTRAG_API_KEY is no key", () => {
		const railway = railwayHostingFromEnv({ RAILWAY_PROJECT_ID: "proj", LIGHTRAG_API_KEY: "   " });
		expect(railway?.apiKey).toBeNull();
	});
});

describe("SUBSTRATE_LIGHTRAG_QUERY_MODE", () => {
	const REACH = { LIGHTRAG_URL: "http://lightrag.test/" };

	test("unset leaves the reach exactly as before: no queryMode key, no warning", () => {
		expect(loadConfig(REACH).lightrag).toStrictEqual({ url: "http://lightrag.test" });
		expect(loadConfig({ ...REACH, LIGHTRAG_API_KEY: "k" }).lightrag).toStrictEqual({ url: "http://lightrag.test", apiKey: "k" });
		expect(configWarnings(loadConfig(REACH))).toEqual([]);
	});

	test("each valid mode is parsed, case- and space-insensitively", () => {
		for (const mode of ["naive", "local", "global", "hybrid", "mix"] as const) {
			expect(loadConfig({ ...REACH, SUBSTRATE_LIGHTRAG_QUERY_MODE: mode }).lightrag?.queryMode).toBe(mode);
		}
		const config = loadConfig({ ...REACH, SUBSTRATE_LIGHTRAG_QUERY_MODE: "  NaIvE " });
		expect(config.lightrag?.queryMode).toBe("naive");
		expect(config.lightragQueryModeRejected).toBe(false);
		expect(configWarnings(config)).toEqual([]);
	});

	test("an invalid value falls back to the default and is named by key, never by value", () => {
		const config = loadConfig({ ...REACH, SUBSTRATE_LIGHTRAG_QUERY_MODE: "bypass-secret-value" });
		expect(config.lightrag).toStrictEqual({ url: "http://lightrag.test" });
		expect(config.lightragQueryModeRejected).toBe(true);
		const warnings = configWarnings(config);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("SUBSTRATE_LIGHTRAG_QUERY_MODE");
		expect(warnings.join("\n")).not.toContain("bypass-secret-value");
	});

	test("an empty or blank value is unset: default, no warning", () => {
		for (const raw of ["", "   "]) {
			const config = loadConfig({ ...REACH, SUBSTRATE_LIGHTRAG_QUERY_MODE: raw });
			expect(config.lightrag).toStrictEqual({ url: "http://lightrag.test" });
			expect(configWarnings(config)).toEqual([]);
		}
	});

	test("an invalid value warns even with no LightRAG reach configured", () => {
		expect(configWarnings(loadConfig({ SUBSTRATE_LIGHTRAG_QUERY_MODE: "nope" }))).toEqual([expect.stringContaining("SUBSTRATE_LIGHTRAG_QUERY_MODE")]);
	});
});

describe("data-plane endpoint policy (phase 48)", () => {
	const GREPTIME_HOST = "greptime.test.invalid";
	const GREPTIME_URL_KEY = ["GREPTIME", "URL"].join("_");
	const DIRECT_GREPTIME = `http://${GREPTIME_HOST}:4000`;

	/** The boot refusal's message, or "" when loadConfig accepts the environment. */
	function bootRefusal(env: Record<string, string | undefined>): string {
		try {
			loadConfig(env);
		} catch (error) {
			if (error instanceof ConfigError) return error.message;
			throw error;
		}
		return "";
	}

	test("with nothing set the endpoint settings are warn, with no classes and an empty allow list", () => {
		const config = loadConfig({});
		expect(config.dbEndpoints.policy).toBe("warn");
		expect(config.dbEndpoints.allow.size).toBe(0);
		expect(config.dbEndpoints.classes).toEqual({});
	});

	test("warn is the default: a direct Greptime URL loads and is reported as direct", () => {
		for (const env of [{ [GREPTIME_URL_KEY]: DIRECT_GREPTIME }, { SUBSTRATE_DB_ENDPOINT_POLICY: "warn", [GREPTIME_URL_KEY]: DIRECT_GREPTIME }]) {
			const config = loadConfig(env);
			expect(config.dbEndpoints.policy).toBe("warn");
			expect(config.dbEndpoints.classes).toEqual({ greptime: "direct" });
			expect(config.greptime?.url).toBe(DIRECT_GREPTIME);
		}
	});

	test("enforce refuses a direct Greptime URL, naming the variable and the policy but never the URL", () => {
		const message = bootRefusal({ SUBSTRATE_DB_ENDPOINT_POLICY: "enforce", [GREPTIME_URL_KEY]: DIRECT_GREPTIME });
		expect(message).toContain(GREPTIME_URL_KEY);
		expect(message).toContain("SUBSTRATE_DB_ENDPOINT_POLICY");
		expect(message).not.toContain(GREPTIME_HOST);
		expect(message).not.toContain("4000");
	});

	test("enforce names the variable of each direct plane", () => {
		expect(bootRefusal({ SUBSTRATE_DB_ENDPOINT_POLICY: "enforce", SUBSTRATE_PG_URL: "postgres://user:pass@pg.test.invalid:5432/substrate" })).toContain("SUBSTRATE_PG_URL");
		expect(bootRefusal({ SUBSTRATE_DB_ENDPOINT_POLICY: "enforce", DRAGONFLY_URL: "redis://cache.test.invalid:6379/0" })).toContain("DRAGONFLY_URL");
	});

	test("enforce accepts a loopback endpoint and an allowlisted proxy endpoint", () => {
		const loopback = loadConfig({
			SUBSTRATE_DB_ENDPOINT_POLICY: "enforce",
			[GREPTIME_URL_KEY]: "http://127.0.0.1:4000",
			SUBSTRATE_PG_URL: "postgres://user:pass@localhost:5432/substrate",
			DRAGONFLY_URL: "redis://127.0.0.1:6379/0",
		});
		expect(loopback.dbEndpoints.classes).toEqual({ greptime: "loopback", postgres: "loopback", dragonfly: "loopback" });
		const proxied = loadConfig({ SUBSTRATE_DB_ENDPOINT_POLICY: "enforce", SUBSTRATE_DB_PROXY_ALLOW: `${GREPTIME_HOST}:4000`, [GREPTIME_URL_KEY]: DIRECT_GREPTIME });
		expect(proxied.dbEndpoints.classes).toEqual({ greptime: "proxy" });
		expect(proxied.dbEndpoints.allow.has(`${GREPTIME_HOST}:4000`)).toBe(true);
	});

	test("a Dragonfly URL on an allowlisted host enables the cache; the same host on another port stays refused", () => {
		const enforceEnv = { SUBSTRATE_DB_ENDPOINT_POLICY: "enforce", SUBSTRATE_DB_PROXY_ALLOW: "cache.test.invalid:6379" };
		const plain = loadConfig({ ...enforceEnv, DRAGONFLY_URL: "redis://cache.test.invalid:6379/0" });
		expect(plain.cacheEnabled).toBe(true);
		expect(plain.dragonflyUrl).toBe("redis://cache.test.invalid:6379/0");
		expect(plain.dragonflyRefused).toBeNull();
		expect(plain.dbEndpoints.classes.dragonfly).toBe("proxy");
		const tls = loadConfig({ ...enforceEnv, DRAGONFLY_URL: "rediss://cache.test.invalid:6379/0" });
		expect(tls.cacheEnabled).toBe(true);
		// Warn mode: the other port is reported and the cache stays off, fail-open.
		const otherPort = loadConfig({ SUBSTRATE_DB_PROXY_ALLOW: "cache.test.invalid:6379", DRAGONFLY_URL: "redis://cache.test.invalid:6380/0" });
		expect(otherPort.cacheEnabled).toBe(false);
		expect(otherPort.dragonflyUrl).toBeUndefined();
		expect(otherPort.dragonflyRefused).toContain("cache.test.invalid");
		expect(otherPort.dbEndpoints.classes.dragonfly).toBe("direct");
	});

	test("parseRedisUrl accepts an allowlisted host and port and refuses the same host on another port", () => {
		const allow = new Set(["cache.test.invalid:6379"]);
		expect(parseRedisUrl("redis://cache.test.invalid:6379/0", allow)).toEqual({ kind: "ok", url: "redis://cache.test.invalid:6379/0" });
		expect(parseRedisUrl("rediss://cache.test.invalid:6380/0", allow).kind).toBe("refused");
	});

	test("an unknown policy value is refused, naming the variable", () => {
		expect(() => loadConfig({ SUBSTRATE_DB_ENDPOINT_POLICY: "audit" })).toThrow(ConfigError);
		expect(bootRefusal({ SUBSTRATE_DB_ENDPOINT_POLICY: "audit" })).toContain("SUBSTRATE_DB_ENDPOINT_POLICY");
	});

	test("a malformed SUBSTRATE_DB_PROXY_ALLOW is refused, naming the variable and never the entry", () => {
		const message = bootRefusal({ SUBSTRATE_DB_PROXY_ALLOW: "cache.test.invalid" });
		expect(message).toContain("SUBSTRATE_DB_PROXY_ALLOW");
		expect(message).not.toContain("cache.test.invalid");
	});
});

describe("a surface token's length and comparison", () => {
	test("a short surface token still authenticates, and boot names only its variable", () => {
		const config = loadConfig({ SUBSTRATE_TOKEN_GROK_BOT: "tok-grok" });

		expect(surfaceForToken(config, "Bearer tok-grok")).toBe("grok-bot");
		const warnings = configWarnings(config);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("SUBSTRATE_TOKEN_GROK_BOT");
		expect(warnings[0]).not.toContain("tok-grok");
	});

	test("the floor is 16 characters: 15 is reported, 16 is not", () => {
		expect(configWarnings(loadConfig({ SUBSTRATE_TOKEN_GROK_BOT: "f".repeat(15) }))).toHaveLength(1);
		expect(configWarnings(loadConfig({ SUBSTRATE_TOKEN_GROK_BOT: "f".repeat(16) }))).toEqual([]);
	});

	test("a short surface token is reported even when operator tokens are configured", () => {
		const config = loadConfig({ SUBSTRATE_TOKEN_CURSOR: "tok-operator", SUBSTRATE_OPERATOR_TOKENS: "tok-operator" });

		const warnings = configWarnings(config);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("SUBSTRATE_TOKEN_CURSOR");
		expect(isOperator(config, "Bearer tok-operator")).toBe(true);
	});

	test("every configured token authenticates to its own surface, and a near miss does not", () => {
		const config = loadConfig({
			SUBSTRATE_TOKEN_GROK_BOT: GROK_TOKEN,
			SUBSTRATE_TOKEN_HERMES: HERMES_TOKEN,
			SUBSTRATE_TOKEN_CURSOR: CURSOR_TOKEN,
		});

		expect(surfaceForToken(config, `Bearer ${GROK_TOKEN}`)).toBe("grok-bot");
		expect(surfaceForToken(config, `Bearer ${HERMES_TOKEN}`)).toBe("hermes");
		expect(surfaceForToken(config, `Bearer ${CURSOR_TOKEN}`)).toBe("cursor");
		for (const near of [GROK_TOKEN.slice(0, -1), `${GROK_TOKEN}0`, GROK_TOKEN.replace("grok", "GROK"), `${CURSOR_TOKEN}x`]) {
			expect(surfaceForToken(config, `Bearer ${near}`)).toBeNull();
		}
	});

	test("operator authority follows the same exact match", () => {
		const config = loadConfig({
			SUBSTRATE_TOKEN_CURSOR: CURSOR_TOKEN,
			SUBSTRATE_TOKEN_HERMES: HERMES_TOKEN,
			SUBSTRATE_OPERATOR_TOKENS: CURSOR_TOKEN,
		});

		expect(isOperator(config, `Bearer ${CURSOR_TOKEN}`)).toBe(true);
		expect(isOperator(config, `Bearer ${CURSOR_TOKEN.slice(0, -1)}`)).toBe(false);
		expect(isOperator(config, `Bearer ${HERMES_TOKEN}`)).toBe(false);
	});
});

describe("SUBSTRATE_LEDGER_TTL floor", () => {
	test("a total of zero is refused, with the reason", () => {
		for (const ttl of ["0d", "0h", "0m", "0h 0m", "00d"]) {
			expect(() => loadConfig({ SUBSTRATE_LEDGER_TTL: ttl })).toThrow(ConfigError);
			expect(() => loadLedgerSettings({ SUBSTRATE_LEDGER_TTL: ttl })).toThrow("totals zero");
		}
	});

	test("a span that totals at least one unit is kept as written", () => {
		for (const ttl of ["180d", "1h", "1h 30m", "0d 1h"]) {
			expect(loadLedgerSettings({ SUBSTRATE_LEDGER_TTL: ttl }).ttl).toBe(ttl);
		}
		expect(loadLedgerSettings({}).ttl).toBeNull();
	});
});

describe("SUBSTRATE_AGENT_SKILLS_ROOT (phase 42, D42-1)", () => {
	test("unset names no checkout and warns nothing", () => {
		const config = loadConfig({});
		expect(config.agentSkillsRoot).toBeNull();
		expect(configWarnings(config)).toEqual([]);
	});

	test("an absolute path is the checkout, trimmed, and warns nothing", () => {
		const config = loadConfig({ SUBSTRATE_AGENT_SKILLS_ROOT: " /srv/agent-skills " });
		expect(config.agentSkillsRoot).toBe("/srv/agent-skills");
		expect(configWarnings(config)).toEqual([]);
	});

	test("a relative path is treated as unset and named at boot", () => {
		const config = loadConfig({ SUBSTRATE_AGENT_SKILLS_ROOT: "agent-skills" });
		expect(config.agentSkillsRoot).toBeNull();
		expect(configWarnings(config)).toEqual([expect.stringContaining('SUBSTRATE_AGENT_SKILLS_ROOT="agent-skills"')]);
	});
});

describe("HINDSIGHT_MENTAL_MODELS", () => {
	test("unset names no model and warns about nothing", () => {
		expect(loadConfig({}).mentalModels).toEqual({ models: [], warnings: [] });
	});

	test("a valid entry is kept and an invalid entry is dropped, with the valid ones still applying", () => {
		const config = loadConfig({
			HINDSIGHT_BANKS: "sub-omp,sub-hermes",
			HINDSIGHT_MENTAL_MODELS: "sub-omp=mm_a,mm_b;sub-hermes=bad id;sub-other=mm_x;sub-hermes=mm_c",
		});
		expect(config.mentalModels.models).toEqual([
			{ bank: "sub-omp", id: "mm_a" },
			{ bank: "sub-omp", id: "mm_b" },
			{ bank: "sub-hermes", id: "mm_c" },
		]);
		// `sub-hermes=bad id` breaks the id rule; `sub-other` is not in HINDSIGHT_BANKS.
		expect(config.mentalModels.warnings).toHaveLength(2);
	});

	test("at most 20 models, and a repeated model is dropped with a warning", () => {
		const ids = Array.from({ length: 21 }, (_, index) => `mm_${index}`);
		const config = loadConfig({ HINDSIGHT_BANKS: "sub-omp", HINDSIGHT_MENTAL_MODELS: `sub-omp=${ids.join(",")};sub-omp=mm_0` });
		expect(config.mentalModels.models).toHaveLength(20);
		expect(config.mentalModels.warnings).toHaveLength(2);
	});
});

describe("TEI and the embedding cache (phase 64)", () => {
	test("with TEI_URL unset there is no TEI, whatever else is set, and no endpoint class", () => {
		const config = loadConfig({ TEI_API_KEY: "k", SUBSTRATE_TEI_MODEL: "m", SUBSTRATE_TEI_DIM: "384" });
		expect(config.tei).toBeNull();
		expect(config.dbEndpoints.tei).toBeUndefined();
		expect(config.embedCache).toEqual({ enabled: false, ttlS: 604_800 });
	});

	test("a configured TEI reads its pins and limits, trims the URL, and keeps defaults for a missing or bad number", () => {
		expect(teiFromEnv({ TEI_URL: " http://127.0.0.1:8080/// " })).toEqual({ url: "http://127.0.0.1:8080", timeoutMs: 10_000, batch: 32 });
		expect(
			teiFromEnv({
				TEI_URL: "http://127.0.0.1:8080",
				TEI_API_KEY: " key ",
				SUBSTRATE_TEI_MODEL: " bge ",
				SUBSTRATE_TEI_DIM: "384",
				SUBSTRATE_TEI_TIMEOUT_MS: "2500",
				SUBSTRATE_TEI_BATCH: "8",
			}),
		).toEqual({ url: "http://127.0.0.1:8080", apiKey: "key", model: "bge", dim: 384, timeoutMs: 2500, batch: 8 });
		const bad = teiFromEnv({ TEI_URL: "http://127.0.0.1:8080", SUBSTRATE_TEI_DIM: "wide", SUBSTRATE_TEI_TIMEOUT_MS: "soon", SUBSTRATE_TEI_BATCH: "" });
		expect(bad).toEqual({ url: "http://127.0.0.1:8080", timeoutMs: 10_000, batch: 32 });
		expect(teiFromEnv({ TEI_URL: "http://127.0.0.1:8080", SUBSTRATE_TEI_DIM: "0" })?.dim).toBeUndefined();
		expect(teiFromEnv({ TEI_URL: "http://127.0.0.1:8080", SUBSTRATE_TEI_DIM: "99999" })?.dim).toBeUndefined();
	});

	test("timeout and batch are clamped, not refused", () => {
		const high = teiFromEnv({ TEI_URL: "http://127.0.0.1:8080", SUBSTRATE_TEI_TIMEOUT_MS: "9999999", SUBSTRATE_TEI_BATCH: "9999" });
		expect(high).toMatchObject({ timeoutMs: 120_000, batch: 512 });
		const low = teiFromEnv({ TEI_URL: "http://127.0.0.1:8080", SUBSTRATE_TEI_TIMEOUT_MS: "1", SUBSTRATE_TEI_BATCH: "0" });
		expect(low).toMatchObject({ timeoutMs: 100, batch: 1 });
	});

	test("the embedding cache is off unless exactly `on`, and its TTL is clamped", () => {
		expect(embedCacheFromEnv({}).enabled).toBe(false);
		for (const value of ["", "off", "1", "true", "yes", "onn"]) expect(embedCacheFromEnv({ SUBSTRATE_EMBED_CACHE: value }).enabled).toBe(false);
		expect(embedCacheFromEnv({ SUBSTRATE_EMBED_CACHE: " ON " }).enabled).toBe(true);
		expect(embedCacheFromEnv({ SUBSTRATE_EMBED_CACHE_TTL_S: "3600" }).ttlS).toBe(3600);
		expect(embedCacheFromEnv({ SUBSTRATE_EMBED_CACHE_TTL_S: "1" }).ttlS).toBe(60);
		expect(embedCacheFromEnv({ SUBSTRATE_EMBED_CACHE_TTL_S: "99999999" }).ttlS).toBe(2_592_000);
		expect(embedCacheFromEnv({ SUBSTRATE_EMBED_CACHE_TTL_S: "forever" }).ttlS).toBe(604_800);
	});

	test("TEI_URL is classed like a data-plane endpoint: loopback, a listed proxy or direct", () => {
		expect(loadConfig({ TEI_URL: "http://127.0.0.1:8080" }).dbEndpoints.tei).toBe("loopback");
		expect(loadConfig({ TEI_URL: "http://tei.example.test:8080", SUBSTRATE_DB_PROXY_ALLOW: "tei.example.test:8080" }).dbEndpoints.tei).toBe("proxy");
		expect(loadConfig({ TEI_URL: "http://tei.example.test:8080" }).dbEndpoints.tei).toBe("direct");
		// The database planes' own classes are untouched by it.
		expect(loadConfig({ TEI_URL: "http://tei.example.test:8080" }).dbEndpoints.classes).toEqual({});
	});

	test("enforce refuses a direct TEI_URL with a ConfigError that names the variable and not the host", () => {
		const refuse = () => loadConfig({ TEI_URL: "http://tei.example.test:8080", SUBSTRATE_DB_ENDPOINT_POLICY: "enforce" });
		expect(refuse).toThrow(ConfigError);
		let message = "";
		try {
			refuse();
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("TEI_URL");
		expect(message).not.toContain("example.test");
	});
});

describe("SUBSTRATE_RECONCILE_* (phase 78, D78-7)", () => {
	test("the scheduled reconcile is off when the interval is unset, blank or 0", () => {
		expect(loadConfig({}).reconcile.intervalS).toBe(0);
		expect(loadConfig({ SUBSTRATE_RECONCILE_INTERVAL_S: "" }).reconcile.intervalS).toBe(0);
		expect(loadConfig({ SUBSTRATE_RECONCILE_INTERVAL_S: "   " }).reconcile.intervalS).toBe(0);
		expect(loadConfig({ SUBSTRATE_RECONCILE_INTERVAL_S: "0" }).reconcile.intervalS).toBe(0);
	});

	test("a valid interval is kept in whole seconds", () => {
		expect(loadConfig({ SUBSTRATE_RECONCILE_INTERVAL_S: "300" }).reconcile.intervalS).toBe(300);
		expect(loadConfig({ SUBSTRATE_RECONCILE_INTERVAL_S: " 3600 " }).reconcile.intervalS).toBe(3600);
	});

	test("an interval above 0 but under 60 is clamped to 60", () => {
		expect(loadConfig({ SUBSTRATE_RECONCILE_INTERVAL_S: "1" }).reconcile.intervalS).toBe(60);
		expect(loadConfig({ SUBSTRATE_RECONCILE_INTERVAL_S: "59" }).reconcile.intervalS).toBe(60);
		expect(loadConfig({ SUBSTRATE_RECONCILE_INTERVAL_S: "60" }).reconcile.intervalS).toBe(60);
	});

	test("an interval too long for a timer is clamped to the longest one a timer holds", () => {
		expect(loadConfig({ SUBSTRATE_RECONCILE_INTERVAL_S: "99999999999" }).reconcile.intervalS).toBe(2_147_483);
	});

	test("an interval that is not a whole number, or is negative, refuses boot and names the variable", () => {
		for (const value of ["1.5", "-5", "5s", "every hour", "1e3"]) {
			expect(() => loadConfig({ SUBSTRATE_RECONCILE_INTERVAL_S: value })).toThrow(ConfigError);
			expect(() => loadConfig({ SUBSTRATE_RECONCILE_INTERVAL_S: value })).toThrow("SUBSTRATE_RECONCILE_INTERVAL_S");
		}
	});

	test("the window defaults to 24 hours when unset or blank", () => {
		expect(loadConfig({}).reconcile.windowHours).toBe(24);
		expect(loadConfig({ SUBSTRATE_RECONCILE_WINDOW_HOURS: "" }).reconcile.windowHours).toBe(24);
	});

	test("a valid window is kept in whole hours", () => {
		expect(loadConfig({ SUBSTRATE_RECONCILE_WINDOW_HOURS: "6" }).reconcile.windowHours).toBe(6);
		expect(loadConfig({ SUBSTRATE_RECONCILE_WINDOW_HOURS: "1" }).reconcile.windowHours).toBe(1);
	});

	test("a window outside 1 to 168 hours is clamped into that range", () => {
		expect(loadConfig({ SUBSTRATE_RECONCILE_WINDOW_HOURS: "0" }).reconcile.windowHours).toBe(1);
		expect(loadConfig({ SUBSTRATE_RECONCILE_WINDOW_HOURS: "168" }).reconcile.windowHours).toBe(168);
		expect(loadConfig({ SUBSTRATE_RECONCILE_WINDOW_HOURS: "169" }).reconcile.windowHours).toBe(168);
		expect(loadConfig({ SUBSTRATE_RECONCILE_WINDOW_HOURS: "100000" }).reconcile.windowHours).toBe(168);
	});

	test("a window that is not a whole number, or is negative, refuses boot and names the variable", () => {
		for (const value of ["1.5", "-1", "a day", "24h"]) {
			expect(() => loadConfig({ SUBSTRATE_RECONCILE_WINDOW_HOURS: value })).toThrow(ConfigError);
			expect(() => loadConfig({ SUBSTRATE_RECONCILE_WINDOW_HOURS: value })).toThrow("SUBSTRATE_RECONCILE_WINDOW_HOURS");
		}
	});
});
