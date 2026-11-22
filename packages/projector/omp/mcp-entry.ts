/**
 * Omp MCP entry generator: builds the `substrate` MCP server config object Omp reads and
 * renders it to deterministic JSON text.
 *
 * Omp reaches the substrate over Streamable HTTP at the `/mcp` endpoint. The entry carries the
 * Streamable-HTTP shape Omp and Claude read (`type`, `url`, `headers`, as in
 * packages/projector/src/swarm-workspace.ts `jsonEntry`) under the server name `substrate`.
 * The requested MCP JSON shape for Omp is the `mcpServers` wrapper, so one call to
 * `generateOmpMcpEntry` yields the whole config.
 *
 * Auth is a variable template, never a value: the `Authorization` header is the literal
 * `Bearer ${SUBSTRATE_TOKEN_OMP}`, following the repo-wide `SUBSTRATE_TOKEN_<SURFACE>`
 * convention (see packages/cli/src/token.ts). Omp expands the variable from its own
 * environment at connection time, so the generated text embeds no token and can be committed.
 *
 * Pure function, no filesystem writes, byte-stable output: the object is built in a fixed key
 * order and `renderOmpMcpEntry` serializes with a fixed two-space indent plus a trailing
 * newline, so repeated renders are byte-identical.
 *
 * No import from the Omp package or the repo's module graph: like substrate-skills.ts this file
 * loads standalone, so every constant is local and nothing is read from disk or the environment.
 */

export const OMP_MCP_SERVER_NAME = "substrate";
export const DEFAULT_OMP_MCP_URL = "http://127.0.0.1:7410/mcp";
export const OMP_MCP_TOKEN_ENV = "SUBSTRATE_TOKEN_OMP";
export const OMP_MCP_AUTHORIZATION = "Bearer ${SUBSTRATE_TOKEN_OMP}";

/** The Streamable-HTTP entry for one MCP server, as Omp reads it. */
export interface OmpMcpServerEntry {
	type: "http";
	url: string;
	headers: { Authorization: string };
}

/** The Omp MCP JSON config: one server, under the `mcpServers` wrapper. */
export interface OmpMcpConfig {
	mcpServers: Record<typeof OMP_MCP_SERVER_NAME, OmpMcpServerEntry>;
}

export interface GenerateOmpMcpEntryOptions {
	/** Full Streamable-HTTP URL for the substrate MCP endpoint. Defaults to the loopback one. */
	url?: string;
}

/**
 * The Omp MCP config for the substrate, from one call. Pure: the returned object is built
 * fresh in a fixed key order, carries the bearer as an env-var template, and never embeds a
 * token value.
 */
export function generateOmpMcpEntry(opts?: GenerateOmpMcpEntryOptions): OmpMcpConfig {
	const url = opts?.url ?? DEFAULT_OMP_MCP_URL;
	return {
		mcpServers: {
			[OMP_MCP_SERVER_NAME]: {
				type: "http",
				url,
				headers: { Authorization: OMP_MCP_AUTHORIZATION },
			},
		},
	};
}

/** The config as byte-stable JSON text: fixed two-space indent, trailing newline. */
export function renderOmpMcpEntry(config: OmpMcpConfig): string {
	return `${JSON.stringify(config, null, 2)}\n`;
}
