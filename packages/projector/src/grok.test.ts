import { describe, expect, test } from "bun:test";
import {
	GROK_BOT_GATEWAY_BASE_URL,
	GROK_BUILD_MCP_URL,
	GROK_TOOL_SURFACE,
	generateGrokPlugin,
	tokenEnvVarForSurface,
} from "./grok.ts";

describe("generateGrokPlugin", () => {
	test("grok-build produces a direct loopback MCP manifest", () => {
		const manifest = generateGrokPlugin("grok-build");
		expect(manifest.surface).toBe("grok-build");
		expect(manifest.transport).toBe("mcp");
		expect(manifest.mcp?.url).toBe(GROK_BUILD_MCP_URL);
		expect(manifest.mcp?.url).toBe("http://127.0.0.1:7410/mcp");
		expect(manifest.gateway).toBeUndefined();
		expect(manifest.tokenEnvVar).toBe("SUBSTRATE_TOKEN_GROK_BUILD");
		expect(manifest.mcp?.headers.Authorization).toBe("Bearer ${SUBSTRATE_TOKEN_GROK_BUILD}");
		expect(manifest.tools).toEqual([...GROK_TOOL_SURFACE]);
		expect(manifest.notes).toContain("docs/grok-bot.md");
	});

	test("grok-bot produces a desk-gateway REST manifest, never a direct MCP entry", () => {
		const manifest = generateGrokPlugin("grok-bot");
		expect(manifest.surface).toBe("grok-bot");
		expect(manifest.transport).toBe("rest-gateway");
		expect(manifest.gateway?.baseUrl).toBe(GROK_BOT_GATEWAY_BASE_URL);
		expect(manifest.gateway?.baseUrl).toBe("https://desk.swcstudio.space");
		expect(manifest.gateway?.surface).toBe("grok-bot");
		expect(manifest.mcp).toBeUndefined();
		expect(JSON.stringify(manifest)).not.toContain("127.0.0.1:7410/mcp");
		expect(manifest.tokenEnvVar).toBe("SUBSTRATE_TOKEN_GROK_BOT");
		expect(manifest.gateway?.headers.Authorization).toBe("Bearer ${SUBSTRATE_TOKEN_GROK_BOT}");
		expect(manifest.tools).toEqual([...GROK_TOOL_SURFACE]);
		expect(manifest.notes).toContain("docs/grok-bot.md");
	});

	test("no token value is embedded; only the env template is named", () => {
		for (const surface of ["grok-build", "grok-bot"] as const) {
			const manifest = generateGrokPlugin(surface);
			const text = JSON.stringify(manifest);
			expect(text).toContain(`\${${tokenEnvVarForSurface(surface)}}`);
			expect(text).not.toMatch(/Bearer [A-Za-z0-9\-_]{8,}/);
		}
	});

	test("output is deterministic and independent across calls", () => {
		const first = generateGrokPlugin("grok-bot");
		const second = generateGrokPlugin("grok-bot");
		expect(first).toEqual(second);
		first.tools.pop();
		expect(second.tools).toEqual([...GROK_TOOL_SURFACE]);
	});

	test("overrides apply only to their own surface", () => {
		expect(generateGrokPlugin("grok-build", { mcpUrl: "http://127.0.0.1:9999/mcp" }).mcp?.url).toBe(
			"http://127.0.0.1:9999/mcp",
		);
		expect(
			generateGrokPlugin("grok-bot", { gatewayBaseUrl: "https://gateway.example.test" }).gateway?.baseUrl,
		).toBe("https://gateway.example.test");
		expect(generateGrokPlugin("grok-bot", { mcpUrl: "http://127.0.0.1:9999/mcp" }).mcp).toBeUndefined();
	});

	test("an unknown surface is refused", () => {
		expect(() => generateGrokPlugin("other" as never)).toThrow("unknown Grok surface");
	});
});
