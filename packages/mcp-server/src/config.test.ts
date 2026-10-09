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
import { configWarnings, isOperator, loadConfig, surfaceForToken } from "./config.ts";

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
