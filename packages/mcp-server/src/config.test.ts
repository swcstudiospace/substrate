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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_SKILLS_GH,
	DEFAULT_SKILLS_REMOTE_URL,
	DEFAULT_SKILLS_REPO,
	DEFAULT_SKILLS_STATE,
	configWarnings,
	isOperator,
	loadConfig,
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
