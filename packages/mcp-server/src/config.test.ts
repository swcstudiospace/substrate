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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_DOCS_STATE,
	DEFAULT_RAGFLOW_TIMEOUT_MS,
	DEFAULT_SKILLS_GH,
	DEFAULT_SKILLS_REMOTE_URL,
	DEFAULT_SKILLS_REPO,
	DEFAULT_SKILLS_STATE,
	configWarnings,
	isOperator,
	loadConfig,
	parseRedisUrl,
	surfaceForToken,
} from "./config.ts";

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
			SUBSTRATE_TOKEN_CURSOR: "tok-operator",
			SUBSTRATE_TOKEN_SUBSTRATE: "tok-substrate",
			SUBSTRATE_OPERATOR_TOKENS: "tok-operator,tok-substrate",
		});
		const warnings = configWarnings(config);

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("substrate");
		expect(warnings[0]).not.toContain("tok-substrate");
	});

	test("a listed swarm token and a listed substrate token warn side by side", () => {
		const config = loadConfig({
			SUBSTRATE_TOKEN_CURSOR: "tok-operator",
			SUBSTRATE_TOKEN_SWARM_A05_BE: "tok-a05",
			SUBSTRATE_TOKEN_SUBSTRATE: "tok-substrate",
			SUBSTRATE_OPERATOR_TOKENS: "tok-operator,tok-a05,tok-substrate",
		});

		expect(isOperator(config, "Bearer tok-a05")).toBe(false);
		expect(isOperator(config, "Bearer tok-substrate")).toBe(false);
		const warnings = configWarnings(config);
		expect(warnings).toHaveLength(2);
		expect(warnings.join("\n")).toContain("swarm-a05-be");
		expect(warnings.join("\n")).toContain("substrate");
		expect(warnings.join("\n")).not.toContain("tok-substrate");
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
			SUBSTRATE_TOKEN_CURSOR: "tok-operator",
			SUBSTRATE_OPERATOR_TOKENS: "tok-operator",
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
describe("RAGFLOW_* and SUBSTRATE_DOCS_* (D25-23)", () => {
	// The key below is an inert test value assembled at runtime, never a
	// credential; the URLs are loopback or single-label fixtures.
	const key = () => "test-" + "key-9f8e7d6c5b4a";

	test("an empty env leaves ragflow unconfigured with docs defaults, without throwing", () => {
		const config = loadConfig({});

		expect(config.ragflow).toBeNull();
		expect(config.docs).toEqual({
			stateDir: DEFAULT_DOCS_STATE,
			embeddingModel: undefined,
			datasetsFile: undefined,
		});
		expect(DEFAULT_DOCS_STATE).toBe("/var/lib/substrate/docs");
		expect(DEFAULT_RAGFLOW_TIMEOUT_MS).toBe(10_000);
	});

	test("https anywhere and http to loopback or single-label hosts are accepted", () => {
		for (const url of [
			"https://ragflow.example.test:9380",
			"http://localhost:9380",
			"http://127.0.0.1:9380",
			"http://[::1]:9380",
			"http://ragflow:9380",
		]) {
			const config = loadConfig({ RAGFLOW_URL: url, RAGFLOW_API_KEY: key() });
			expect({ url, problem: config.ragflow?.problem }).toEqual({ url, problem: null });
		}
	});

	test("http to a dotted public host is rejected with a warning, never a throw", () => {
		const config = loadConfig({ RAGFLOW_URL: "http://example.test:9380", RAGFLOW_API_KEY: key() });

		expect(config.ragflow?.problem).toContain("RAGFLOW_URL");
		const warnings = configWarnings(config);
		expect(warnings.join("\n")).toContain("RAGFLOW_URL");
		expect(warnings.join("\n")).not.toContain("example.test");
	});

	test("a malformed URL is rejected without echoing it", () => {
		const config = loadConfig({ RAGFLOW_URL: "not a url with spaces", RAGFLOW_API_KEY: key() });

		expect(config.ragflow?.problem).toContain("RAGFLOW_URL");
		expect(JSON.stringify(config.ragflow)).not.toContain("not a url");
	});

	test("partial config warns: a key without a URL, and a URL without a key", () => {
		const keyOnly = loadConfig({ RAGFLOW_API_KEY: key() });
		expect(keyOnly.ragflow?.problem).toContain("RAGFLOW_URL");
		expect(configWarnings(keyOnly).join("\n")).toContain("RAGFLOW_URL");

		const urlOnly = loadConfig({ RAGFLOW_URL: "http://localhost:9380" });
		expect(urlOnly.ragflow?.problem).toContain("RAGFLOW_API_KEY");
		expect(configWarnings(urlOnly).join("\n")).toContain("RAGFLOW_API_KEY");
	});

	test("no docs/ragflow input makes loadConfig throw", () => {
		const inputs: Array<Record<string, string | undefined>> = [
			{},
			{ RAGFLOW_URL: "http://example.test" },
			{ RAGFLOW_API_KEY: key() },
			{ RAGFLOW_URL: "gopher://example.test" },
			{ SUBSTRATE_RAGFLOW_TIMEOUT_MS: "nan" },
			{ SUBSTRATE_DOCS_STATE: "" },
			{ SUBSTRATE_DOCS_EMBEDDING_MODEL: "bge-small", SUBSTRATE_DOCS_DATASETS: "/run/docs.json" },
		];
		for (const env of inputs) {
			let config = loadConfig(env);
			expect(config.docs.stateDir.length).toBeGreaterThan(0);
			config = loadConfig({ ...env, SUBSTRATE_TOKEN_CURSOR: "tok", SUBSTRATE_OPERATOR_TOKENS: "tok" });
			configWarnings(config);
		}
	});

	test("timeout defaults to 10 s and parses a valid override", () => {
		expect(loadConfig({ RAGFLOW_URL: "http://localhost:9380", RAGFLOW_API_KEY: key() }).ragflow?.timeoutMs).toBe(
			10_000,
		);
		expect(
			loadConfig({
				RAGFLOW_URL: "http://localhost:9380",
				RAGFLOW_API_KEY: key(),
				SUBSTRATE_RAGFLOW_TIMEOUT_MS: "2500",
			}).ragflow?.timeoutMs,
		).toBe(2500);
		expect(
			loadConfig({
				RAGFLOW_URL: "http://localhost:9380",
				RAGFLOW_API_KEY: key(),
				SUBSTRATE_RAGFLOW_TIMEOUT_MS: "nan",
			}).ragflow?.timeoutMs,
		).toBe(10_000);
	});

	test("docs block reads state, model and datasets file", () => {
		const config = loadConfig({
			SUBSTRATE_DOCS_STATE: "/run/docs",
			SUBSTRATE_DOCS_EMBEDDING_MODEL: "bge-small",
			SUBSTRATE_DOCS_DATASETS: "/run/docs.json",
		});
		expect(config.docs).toEqual({
			stateDir: "/run/docs",
			embeddingModel: "bge-small",
			datasetsFile: "/run/docs.json",
		});
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
		});
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
			"rediss://cache.example.com:6380/0",
		]) {
			expect(parseRedisUrl(url)).toEqual({ kind: "ok", url });
		}
		expect(parseRedisUrl(undefined)).toEqual({ kind: "unset" });
		// A DNS name that starts with 127. is not a loopback address.
		expect(parseRedisUrl("redis://127.cache.example.com:6379").kind).toBe("refused");
		expect(parseRedisUrl("redis://127.1:6379").kind).toBe("refused");
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
