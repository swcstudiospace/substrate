/**
 * SUBSTRATE_ALLOW_ANONYMOUS, the migration bridge.
 *
 * Unset keeps today's rule: anonymous only when no surface token is configured.
 * `1` accepts untokened callers alongside tokens. `0` requires a bearer even
 * when no token is configured. A recognised token still names its surface.
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
