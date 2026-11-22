/**
 * `substrate plugins [--json]` (read-only): per-agent compat status for the
 * CLI agent surfaces. Works offline and changes nothing on disk.
 *
 * For each surface this reports four presence facts only:
 * - `surface_in_registry`: the name is in the substrate surfaces registry
 *   (replicated below; importing the mcp-server constant would couple the
 *   CLI to that package's load graph for one list).
 * - `token_present`: a bearer would resolve for the surface under the same
 *   rule as `token.ts` (`SUBSTRATE_TOKEN`, else `SUBSTRATE_TOKEN_FILE`, else
 *   the per-surface file in the tokens dir). Only the boolean is reported;
 *   a token VALUE is never printed, returned, or logged.
 * - `mcp_entry`: `present` when the surface's known MCP config file exists
 *   and names the substrate server, `absent` when it exists without it (or
 *   does not exist), `unknown` when there is no known config path or the
 *   concurrent P1/P2/P3 generators have not landed yet to prove the entry.
 * - `hook_present`: same tri-state for the surface's hook config file.
 *
 * The P1/P2/P3 generator modules land concurrently in other files; this
 * module deliberately does not import them (defensive: their names, exports
 * and locations are not settled). When they land, `mcp_entry`/`hook_present`
 * for those surfaces can be re-probed through them without changing the
 * output shape.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveBearer } from "./token.ts";

export const PLUGINS_USAGE = "usage: substrate plugins [--json]\n";

/** The surfaces the registry knows (subset of mcp-server `SURFACES`). */
export const PLUGIN_SURFACES = [
	"omp",
	"grok-build",
	"grok-bot",
	"hermes",
	"codex",
	"opencode",
	"muse",
	"cursor",
	"claude-code",
	"pi",
] as const;
export type PluginSurface = (typeof PLUGIN_SURFACES)[number];

const REGISTRY: ReadonlySet<string> = new Set<string>(PLUGIN_SURFACES);

export type Presence = "present" | "absent" | "unknown";

export interface PluginStatus {
	surface: string;
	surface_in_registry: boolean;
	token_present: boolean;
	mcp_entry: Presence;
	hook_present: Presence;
}

/** Minimal filesystem surface, injectable so tests use a fake fs. */
export interface PluginsFs {
	exists: (path: string) => boolean;
	read: (path: string) => string | null;
}

export interface PluginsDeps {
	env: Record<string, string | undefined>;
	home: string;
	fs: PluginsFs;
	out: (text: string) => void;
	err: (text: string) => void;
}

export function nodePluginsFs(): PluginsFs {
	return {
		exists: (path) => existsSync(path),
		read: (path) => {
			try {
				return readFileSync(path, "utf8");
			} catch {
				return null;
			}
		},
	};
}

export function defaultPluginsDeps(
	overrides: Partial<PluginsDeps> = {},
): PluginsDeps {
	return {
		env: process.env,
		home: homedir(),
		fs: nodePluginsFs(),
		out: (text) => process.stdout.write(text),
		err: (text) => process.stderr.write(text),
		...overrides,
	};
}

/**
 * Known config-file locations per surface, relative to home. A surface with
 * no entry here has no probed path, so its entry/hook read as `unknown`
 * rather than a guessed `absent`. `marker` is the substring that proves the
 * substrate entry/hook is in the file (never a secret).
 */
interface SurfacePaths {
	mcp?: string;
	hook?: string;
	marker: string;
}

const PATHS: Readonly<Record<string, SurfacePaths>> = {
	"claude-code": {
		mcp: ".claude.json",
		hook: ".claude/settings.json",
		marker: "substrate",
	},
	cursor: {
		mcp: ".cursor/mcp.json",
		hook: ".cursor/hooks.json",
		marker: "substrate",
	},
	hermes: {
		mcp: ".hermes/config.yaml",
		marker: "substrate",
	},
	muse: {
		mcp: ".muse/mcp.json",
		hook: ".muse/hooks.json",
		marker: "substrate",
	},
	"grok-build": {
		mcp: ".grok/mcp.json",
		hook: ".grok/hooks.json",
		marker: "substrate",
	},
	"grok-bot": {
		mcp: ".grok-bot/mcp.json",
		hook: ".grok-bot/hooks.json",
		marker: "substrate",
	},
	omp: {
		mcp: ".config/omp/config.json",
		hook: ".config/omp/hooks.json",
		marker: "substrate",
	},
	codex: {
		mcp: ".codex/config.toml",
		hook: ".codex/hooks.json",
		marker: "substrate",
	},
	opencode: {
		mcp: ".config/opencode/opencode.json",
		hook: ".config/opencode/hooks.json",
		marker: "substrate",
	},
	pi: {
		mcp: ".pi/mcp.json",
		hook: ".pi/hooks.json",
		marker: "substrate",
	},
};

function probe(
	rel: string | undefined,
	home: string,
	fs: PluginsFs,
	marker: string,
): Presence {
	if (rel === undefined) return "unknown";
	const path = join(home, rel);
	if (!fs.exists(path)) return "absent";
	const body = fs.read(path);
	if (body === null) return "unknown";
	return body.includes(marker) ? "present" : "absent";
}

/** Token presence only: the resolver's value is discarded, never retained. */
function tokenPresent(surface: string, deps: PluginsDeps): boolean {
	const env = deps.env;
	const read = (path: string): string | null => {
		if (!deps.fs.exists(path)) return null;
		// First line only, mirroring firstLine's rule; the value is
		// discarded by the caller and never retained.
		const body = deps.fs.read(path);
		if (body === null) return null;
		const line = body.split("\n", 1)[0]?.trim() ?? "";
		return line ? line : null;
	};
	return resolveBearer(surface, env, read) !== null;
}

export function collectPlugins(deps: PluginsDeps): PluginStatus[] {
	return PLUGIN_SURFACES.map((surface) => {
		const paths = PATHS[surface];
		return {
			surface,
			surface_in_registry: REGISTRY.has(surface),
			token_present: tokenPresent(surface, deps),
			mcp_entry: paths === undefined ? "unknown" : probe(paths.mcp, deps.home, deps.fs, paths.marker),
			hook_present: paths === undefined ? "unknown" : probe(paths.hook, deps.home, deps.fs, paths.marker),
		};
	});
}

function renderTable(rows: PluginStatus[]): string {
	const header = ["surface", "registry", "token", "mcp", "hook"];
	const cells = rows.map((r) => [
		r.surface,
		r.surface_in_registry ? "yes" : "no",
		r.token_present ? "yes" : "no",
		r.mcp_entry,
		r.hook_present,
	]);
	const widths = header.map((h, i) =>
		Math.max(h.length, ...cells.map((c) => (c[i]?.length ?? 0))),
	);
	const line = (parts: string[]): string =>
		parts.map((p, i) => p.padEnd(widths[i] ?? 0)).join("  ");
	const out: string[] = [line(header)];
	for (const c of cells) out.push(line(c));
	return `${out.join("\n")}\n`;
}

export function runPlugins(argv: readonly string[], deps: PluginsDeps): number {
	for (const arg of argv) {
		if (arg !== "--json") {
			deps.err(PLUGINS_USAGE);
			return 2;
		}
	}
	const rows = collectPlugins(deps);
	if (argv.includes("--json")) {
		deps.out(`${JSON.stringify(rows, null, 2)}\n`);
	} else {
		deps.out(renderTable(rows));
	}
	return 0;
}

if (import.meta.main) {
	process.exit(runPlugins(process.argv.slice(2), defaultPluginsDeps()));
}
