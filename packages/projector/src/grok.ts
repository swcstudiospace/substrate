#!/usr/bin/env bun
/**
 * Build the consumable substrate plugin manifest for a Grok surface.
 *
 *   import { generateGrokPlugin } from "./grok.ts";
 *   const manifest = generateGrokPlugin("grok-build");
 *
 * `grok-build` runs on the VPS and calls substrate-mcp directly over
 * loopback (`http://127.0.0.1:7410/mcp`). `grok-bot` runs off the VPS as a
 * Programming Desk seat and reaches substrate only through the desk gateway
 * over HTTPS (`https://desk.swcstudio.space`); it never calls the loopback
 * MCP endpoint. See `docs/grok-bot.md` for the full access path.
 *
 * The bearer stays as the env template `SUBSTRATE_TOKEN_<SURFACE>`
 * (for example `SUBSTRATE_TOKEN_GROK_BOT`); no token value is ever embedded
 * in a manifest. The function is pure and deterministic: the same inputs
 * always produce a deep-equal manifest, and callers may mutate the result
 * without affecting later calls.
 */

export const GROK_SURFACES = ["grok-build", "grok-bot"] as const;
export type GrokSurface = (typeof GROK_SURFACES)[number];

/** Direct loopback MCP endpoint for `grok-build` (`docs/grok-bot.md`: substrate-mcp on 127.0.0.1:7410, MCP at /mcp). */
export const GROK_BUILD_MCP_URL = "http://127.0.0.1:7410/mcp";
/** Desk-gateway HTTPS base for `grok-bot` (`docs/grok-bot.md`: the public name is desk.swcstudio.space). */
export const GROK_BOT_GATEWAY_BASE_URL = "https://desk.swcstudio.space";
/** substrate-mcp server name, the same name the swarm projector writes. */
export const GROK_MCP_SERVER = "substrate";

/**
 * The substrate tool surface a Grok plugin exposes. Every name is a tool
 * registered by substrate-mcp (`packages/mcp-server/src/mcp.ts`) and is
 * named in `docs/grok-bot.md` as the seat's read/write path: brief, memory
 * recall/search/write, document search/ingest, and event emit/query.
 */
export const GROK_TOOL_SURFACE = [
	"memory_brief",
	"memory_recall",
	"memory_search",
	"memory_write",
	"docs_search",
	"docs_ingest",
	"events_emit",
	"events_query",
] as const;
export type GrokTool = (typeof GROK_TOOL_SURFACE)[number];

export interface GrokPluginOptions {
	/** Override the direct MCP URL for `grok-build`. Ignored for `grok-bot`. */
	mcpUrl?: string;
	/** Override the desk-gateway base URL for `grok-bot`. Ignored for `grok-build`. */
	gatewayBaseUrl?: string;
}

export interface GrokMcpEntry {
	server: typeof GROK_MCP_SERVER;
	url: string;
	headers: { Authorization: string };
}

export interface GrokGatewayEntry {
	baseUrl: string;
	surface: GrokSurface;
	headers: { Authorization: string };
}

export interface GrokPluginManifest {
	name: "substrate";
	version: "0.1.0";
	surface: GrokSurface;
	transport: "mcp" | "rest-gateway";
	mcp?: GrokMcpEntry;
	gateway?: GrokGatewayEntry;
	tokenEnvVar: string;
	tools: GrokTool[];
	notes: string;
}

/** The bearer env var name for a surface, for example `SUBSTRATE_TOKEN_GROK_BOT`. */
export function tokenEnvVarForSurface(surface: GrokSurface): string {
	return `SUBSTRATE_TOKEN_${surface.toUpperCase().replaceAll("-", "_")}`;
}

function notesFor(surface: GrokSurface): string {
	return surface === "grok-build"
		? "grok-build calls substrate-mcp directly over loopback at http://127.0.0.1:7410/mcp. Bearer: SUBSTRATE_TOKEN_GROK_BUILD. Access path: docs/grok-bot.md."
		: "grok-bot is a Programming Desk seat and reaches substrate only through the desk gateway over HTTPS at https://desk.swcstudio.space; it never calls the loopback MCP endpoint. Bearer: SUBSTRATE_TOKEN_GROK_BOT. Access path: docs/grok-bot.md.";
}

/**
 * The plugin manifest for one Grok surface. Pure and deterministic.
 *
 * `grok-build` gets a direct loopback MCP entry; `grok-bot` gets the
 * desk-gateway REST base and no MCP entry, per `docs/grok-bot.md`.
 */
export function generateGrokPlugin(surface: GrokSurface, opts?: GrokPluginOptions): GrokPluginManifest {
	if (!(GROK_SURFACES as readonly string[]).includes(surface)) {
		throw new Error(`unknown Grok surface: ${String(surface)}`);
	}
	const tokenEnvVar = tokenEnvVarForSurface(surface);
	const authorization = `Bearer \${${tokenEnvVar}}`;
	const base: GrokPluginManifest = {
		name: "substrate",
		version: "0.1.0",
		surface,
		transport: surface === "grok-build" ? "mcp" : "rest-gateway",
		tokenEnvVar,
		tools: [...GROK_TOOL_SURFACE],
		notes: notesFor(surface),
	};
	if (surface === "grok-build") {
		return {
			...base,
			mcp: {
				server: GROK_MCP_SERVER,
				url: opts?.mcpUrl ?? GROK_BUILD_MCP_URL,
				headers: { Authorization: authorization },
			},
		};
	}
	return {
		...base,
		gateway: {
			baseUrl: opts?.gatewayBaseUrl ?? GROK_BOT_GATEWAY_BASE_URL,
			surface,
			headers: { Authorization: authorization },
		},
	};
}
