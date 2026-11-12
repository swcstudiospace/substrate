import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_CODE_HOOK_COMMAND, CLAUDE_CODE_TIMEOUT_SECONDS } from "../../cli/src/session/hook-config.ts";
import {
	TARGETS,
	TURN_HOOK_COMMAND,
	TURN_HOOK_TIMEOUT_SECONDS,
	bundleFor,
	claudeCodeBundle,
	grokBuildBundle,
	hermesBundle,
	primeAgentBundle,
	stale,
	writeBundle,
} from "./agent-plugins.ts";

const MCP_URL = "${SUBSTRATE_URL}/mcp";
const AUTH = "Bearer ${SUBSTRATE_TOKEN}";

function json(text: string): Record<string, unknown> {
	return JSON.parse(text) as Record<string, unknown>;
}

describe("shared hook contract", () => {
	test("the turn hook command and timeout match the CLI's exported hook config", () => {
		expect(TURN_HOOK_COMMAND).toBe(CLAUDE_CODE_HOOK_COMMAND);
		expect(TURN_HOOK_TIMEOUT_SECONDS).toBe(CLAUDE_CODE_TIMEOUT_SECONDS);
	});
});

describe("claude-code and grok-build bundles", () => {
	test("both point the MCP server at the shared templates, never a token value", () => {
		for (const bundle of [claudeCodeBundle(), grokBuildBundle()]) {
			const mcp = json(bundle[".mcp.json"] as string) as { mcpServers: { substrate: { url: string; headers: { Authorization: string } } } };
			expect(mcp.mcpServers.substrate.url).toBe(MCP_URL);
			expect(mcp.mcpServers.substrate.headers.Authorization).toBe(AUTH);
		}
	});

	test("each manifest names the MCP and hook files the bundle actually contains", () => {
		const claude = claudeCodeBundle();
		const grok = grokBuildBundle();
		expect(json(claude[".claude-plugin/plugin.json"] as string).mcpServers).toBe("./.mcp.json");
		expect(json(claude[".claude-plugin/plugin.json"] as string).hooks).toBe("./hooks/hooks.json");
		expect(json(grok[".grok-plugin/plugin.json"] as string).mcpServers).toBe("./.mcp.json");
		expect(json(grok[".grok-plugin/plugin.json"] as string).hooks).toBe("./hooks/hooks.json");
		expect(claude["hooks/hooks.json"]).toBeDefined();
		expect(grok["hooks/hooks.json"]).toBeDefined();
	});

	test("the Stop hook runs the turn command with the shared timeout", () => {
		const hooks = json(grokBuildBundle()["hooks/hooks.json"] as string) as {
			hooks: { Stop: Array<{ hooks: Array<{ type: string; command: string; timeout: number }> }> };
		};
		expect(hooks.hooks.Stop[0]?.hooks[0]).toEqual({ type: "command", command: TURN_HOOK_COMMAND, timeout: TURN_HOOK_TIMEOUT_SECONDS });
	});
});

describe("hermes and prime-agent bundles", () => {
	test("hermes fragment is a mcp_servers block using the shared templates", () => {
		const text = hermesBundle()["config.yaml.fragment"] as string;
		expect(text).toContain("mcp_servers:");
		expect(text).toContain(`url: "${MCP_URL}"`);
		expect(text).toContain(`Authorization: "${AUTH}"`);
	});

	test("prime-agent fragment is an mcpServers entry using the shared templates", () => {
		const settings = json(primeAgentBundle()["settings.json.fragment"] as string) as {
			mcpServers: { substrate: { url: string; headers: { Authorization: string } } };
		};
		expect(settings.mcpServers.substrate.url).toBe(MCP_URL);
		expect(settings.mcpServers.substrate.headers.Authorization).toBe(AUTH);
	});
});

describe("bundle writing and drift", () => {
	test("writes every file, then reports nothing stale", () => {
		const dir = mkdtempSync(join(tmpdir(), "agent-plugins-"));
		try {
			const bundle = bundleFor("grok-build");
			expect(stale(dir, bundle).sort()).toEqual(Object.keys(bundle).sort());
			writeBundle(dir, bundle);
			expect(stale(dir, bundle)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("every declared target produces a non-empty bundle", () => {
		for (const target of TARGETS) {
			expect(Object.keys(bundleFor(target)).length).toBeGreaterThan(0);
		}
	});
});

describe("command line", () => {
	test("an unknown target is refused with exit 2 and writes nothing", async () => {
		const proc = Bun.spawn(["bun", "packages/projector/src/agent-plugins.ts", "--target", "muse-code", "--out", "/tmp/never-written-agent-plugins"], {
			cwd: join(import.meta.dir, "..", "..", ".."),
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(await proc.exited).toBe(2);
	});
});
