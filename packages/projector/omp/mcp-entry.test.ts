import { describe, expect, test } from "bun:test";
import {
	DEFAULT_OMP_MCP_URL,
	generateOmpMcpEntry,
	OMP_MCP_AUTHORIZATION,
	OMP_MCP_SERVER_NAME,
	OMP_MCP_TOKEN_ENV,
	renderOmpMcpEntry,
	type OmpMcpConfig,
} from "./mcp-entry.ts";

describe("generateOmpMcpEntry", () => {
	test("defaults: server name substrate, loopback Streamable-HTTP url, http type", () => {
		const config = generateOmpMcpEntry();
		expect(Object.keys(config.mcpServers)).toEqual([OMP_MCP_SERVER_NAME]);
		const server = config.mcpServers.substrate;
		expect(server.type).toBe("http");
		expect(server.url).toBe(DEFAULT_OMP_MCP_URL);
		expect(server.url).toBe("http://127.0.0.1:7410/mcp");
	});

	test("bearer template names the env var and embeds no token value", () => {
		const config = generateOmpMcpEntry();
		const header = config.mcpServers.substrate.headers.Authorization;
		expect(header).toBe(OMP_MCP_AUTHORIZATION);
		expect(header).toBe(`Bearer \${${OMP_MCP_TOKEN_ENV}}`);
		expect(header).toBe("Bearer ${SUBSTRATE_TOKEN_OMP}");
		expect(header).not.toContain("tok-");
		const text = renderOmpMcpEntry(config);
		expect(text).toContain("SUBSTRATE_TOKEN_OMP");
		expect(text).not.toMatch(/Bearer [A-Za-z0-9]{16,}/);
	});

	test("url override is used verbatim", () => {
		const config = generateOmpMcpEntry({ url: "http://127.0.0.1:7430/mcp" });
		expect(config.mcpServers.substrate.url).toBe("http://127.0.0.1:7430/mcp");
		expect(renderOmpMcpEntry(config)).toContain("http://127.0.0.1:7430/mcp");
	});

	test("explicit empty options behave like no options", () => {
		expect(generateOmpMcpEntry({})).toEqual(generateOmpMcpEntry());
	});
});

describe("renderOmpMcpEntry", () => {
	test("determinism: repeated generate and render produce byte-identical text", () => {
		const first = renderOmpMcpEntry(generateOmpMcpEntry());
		const second = renderOmpMcpEntry(generateOmpMcpEntry());
		expect(second).toBe(first);
		const config = generateOmpMcpEntry();
		expect(renderOmpMcpEntry(config)).toBe(renderOmpMcpEntry(config));
	});

	test("render parses back to the generated config", () => {
		const config: OmpMcpConfig = generateOmpMcpEntry({ url: "http://127.0.0.1:7431/mcp" });
		const parsed: unknown = JSON.parse(renderOmpMcpEntry(config));
		if (typeof parsed !== "object" || parsed === null || !("mcpServers" in parsed)) {
			throw new Error("rendered text did not parse back to an mcpServers object");
		}
		const servers: unknown = parsed.mcpServers;
		if (typeof servers !== "object" || servers === null || !("substrate" in servers)) {
			throw new Error("rendered text did not parse back to a substrate entry");
		}
		expect(servers.substrate).toEqual(config.mcpServers.substrate);
	});

	test("fixed key order: mcpServers, then type, url, headers", () => {
		const text = renderOmpMcpEntry(generateOmpMcpEntry());
		const indexOf = (needle: string) => {
			const index = text.indexOf(needle);
			if (index === -1) throw new Error(`rendered text is missing ${needle}`);
			return index;
		};
		expect(indexOf('"mcpServers"')).toBeLessThan(indexOf('"substrate"'));
		expect(indexOf('"substrate"')).toBeLessThan(indexOf('"type"'));
		expect(indexOf('"type"')).toBeLessThan(indexOf('"url"'));
		expect(indexOf('"url"')).toBeLessThan(indexOf('"headers"'));
		expect(text.endsWith("\n")).toBe(true);
	});
});
