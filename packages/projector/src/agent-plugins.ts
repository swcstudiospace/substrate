#!/usr/bin/env bun
/**
 * Build the substrate connection bundle for one agent host.
 *
 *   bun packages/projector/src/agent-plugins.ts --target <name> --out <dir> [--check]
 *
 * Targets: claude-code, grok-build, hermes, prime-agent.
 *
 * Every bundle reuses the MCP entry the swarm projector already writes
 * (`swarm-workspace.ts`: `jsonEntry`, `URL_TEMPLATE`, `AUTHORIZATION_TEMPLATE`). The URL
 * and the bearer stay as the literal templates `${SUBSTRATE_URL}/mcp` and
 * `Bearer ${SUBSTRATE_TOKEN}`; no token value is ever written to a bundle.
 *
 * The turn hook command repeats `packages/cli/src/session/hook-config.ts`; the contract
 * test pins it to that export, so a drift fails the test, not a host.
 *
 * `--out` writes the files and creates the directory. `--check` writes nothing and
 * exits 1 when any file in `--out` would change or is missing. Exit 2 on a usage error.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AUTHORIZATION_TEMPLATE, SERVER, URL_TEMPLATE, jsonEntry } from "./swarm-workspace.ts";

/** The Claude Code `Stop` hook command. Same string as `CLAUDE_CODE_HOOK_COMMAND` in the CLI. */
export const TURN_HOOK_COMMAND = "substrate session hook turn";
/** Claude Code takes whole seconds; same value as `CLAUDE_CODE_TIMEOUT_SECONDS` in the CLI (its budget plus 5 s). */
export const TURN_HOOK_TIMEOUT_SECONDS = 15;

export const TARGETS = ["claude-code", "grok-build", "hermes", "prime-agent"] as const;
export type Target = (typeof TARGETS)[number];

/** Relative path inside the bundle directory mapped to its file content. */
export type Bundle = Readonly<Record<string, string>>;

function json(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

const PLUGIN_MCP = { mcpServers: { [SERVER]: jsonEntry() } };

const TURN_HOOKS = {
	hooks: {
		Stop: [{ hooks: [{ type: "command", command: TURN_HOOK_COMMAND, timeout: TURN_HOOK_TIMEOUT_SECONDS }] }],
	},
};

/**
 * Claude Code plugin: `.claude-plugin/plugin.json` (Grok Build reads this manifest too), the MCP
 * entry, and the Stop hook. Claude Code loads it through `/plugin` from a local directory.
 */
export function claudeCodeBundle(): Bundle {
	return {
		".claude-plugin/plugin.json": json({
			name: "substrate",
			version: "0.1.0",
			description: "Connects Claude Code to the Agent Substrate: MCP tools and a turn-end session hook.",
			mcpServers: "./.mcp.json",
			hooks: "./hooks/hooks.json",
		}),
		".mcp.json": json(PLUGIN_MCP),
		"hooks/hooks.json": json(TURN_HOOKS),
	};
}

/**
 * Grok Build plugin: `.grok-plugin/plugin.json`, `.mcp.json` and `hooks/hooks.json` in the Claude format,
 * which Grok Build reads without change.
 */
export function grokBuildBundle(): Bundle {
	return {
		".grok-plugin/plugin.json": json({
			name: "substrate",
			version: "0.1.0",
			description: "Connects Grok Build to the Agent Substrate: MCP tools and a turn-end session hook.",
			mcpServers: "./.mcp.json",
			hooks: "./hooks/hooks.json",
		}),
		".mcp.json": json(PLUGIN_MCP),
		"hooks/hooks.json": json(TURN_HOOKS),
	};
}

/**
 * Hermes: MCP servers live in `~/.hermes/config.yaml` under `mcp_servers`. This bundle is that block only.
 * Hermes lists a plugin's MCP server in config, not in a separate plugin file, so there is no plugin.yaml.
 */
export function hermesBundle(): Bundle {
	return {
		"config.yaml.fragment": [
			"# substrate MCP, projected by agent-substrate packages/projector. The token is named here, never written.",
			"# Merge this block under `mcp_servers:` in ~/.hermes/config.yaml, then run /reload-mcp.",
			"mcp_servers:",
			`  ${SERVER}:`,
			`    url: "${URL_TEMPLATE}"`,
			"    headers:",
			`      Authorization: "${AUTHORIZATION_TEMPLATE}"`,
			"",
		].join("\n"),
	};
}

/**
 * Prime Agent: an MCP server entry in `~/.prime/agent/settings.json`. Prime Agent reaches MCP through its
 * Python `mcp` module, so the entry is the connection and nothing else. Prime Agent ships no hooks.
 */
export function primeAgentBundle(): Bundle {
	return {
		"settings.json.fragment": json({
			mcpServers: { [SERVER]: { url: URL_TEMPLATE, headers: { Authorization: AUTHORIZATION_TEMPLATE } } },
		}),
	};
}

export function bundleFor(target: Target): Bundle {
	switch (target) {
		case "claude-code":
			return claudeCodeBundle();
		case "grok-build":
			return grokBuildBundle();
		case "hermes":
			return hermesBundle();
		case "prime-agent":
			return primeAgentBundle();
	}
}

/** Paths in `dir` whose content differs from `bundle`, including missing files. Empty when current. */
export function stale(dir: string, bundle: Bundle): string[] {
	const changed: string[] = [];
	for (const [rel, content] of Object.entries(bundle)) {
		const path = join(dir, rel);
		if (!existsSync(path) || readFileSync(path, "utf8") !== content) changed.push(rel);
	}
	return changed;
}

export function writeBundle(dir: string, bundle: Bundle): void {
	for (const [rel, content] of Object.entries(bundle)) {
		const path = join(dir, rel);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content, "utf8");
	}
}

function main(argv: string[]): number {
	const target = argv[argv.indexOf("--target") + 1];
	const out = argv[argv.indexOf("--out") + 1];
	if (!argv.includes("--target") || !argv.includes("--out") || !target || !out || !(TARGETS as readonly string[]).includes(target)) {
		process.stderr.write(`usage: agent-plugins --target <${TARGETS.join("|")}> --out <dir> [--check]\n`);
		return 2;
	}
	const bundle = bundleFor(target as Target);
	if (argv.includes("--check")) {
		const changed = stale(out, bundle);
		for (const rel of changed) process.stdout.write(`stale: ${rel}\n`);
		return changed.length === 0 ? 0 : 1;
	}
	writeBundle(out, bundle);
	process.stdout.write(`wrote ${Object.keys(bundle).length} file(s) for ${target} to ${out}\n`);
	return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
