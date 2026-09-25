/**
 * Configuration, loaded from the environment.
 *
 * Deployment reads /etc/substrate/substrate.env via the systemd unit's
 * EnvironmentFile. Nothing here ever reads a secret from the repo.
 */
import { DEFAULT_TIMEOUT_MS as DEFAULT_GATE_TIMEOUT_MS } from "./dod-gate.ts";
import type { Surface } from "./types.ts";

export interface GreptimeConfig {
	url: string;
	user: string | undefined;
	password: string | undefined;
	db: string;
}

export interface SubstrateConfig {
	host: string;
	port: number;
	greptime: GreptimeConfig | null;
	postgresUrl: string | undefined;
	linearApiKey: string | undefined;
	notionApiKey: string | undefined;
	notionTaskGraphDataSource: string;
	/** hermes-linear-connector's API; its DoD gate alone moves an issue to Done (D-06). */
	hermesLinearUrl: string;
	/** How long to wait on the DoD gate; must exceed the connector's own 30 s Linear call. */
	dodGateTimeoutMs: number;
	/** bearer token → surface. Lets every event be attributed to a caller. */
	tokens: Map<string, Surface>;
	/** When true, an unauthenticated caller is accepted and attributed by its payload. */
	allowAnonymous: boolean;
}

/** SUBSTRATE_TOKEN_GROK_BUILD → "grok-build" */
function envSuffixToSurface(suffix: string): Surface {
	return suffix.toLowerCase().replace(/_/g, "-") as Surface;
}

function readTokens(env: Record<string, string | undefined>): Map<string, Surface> {
	const tokens = new Map<string, Surface>();
	for (const [key, value] of Object.entries(env)) {
		if (!key.startsWith("SUBSTRATE_TOKEN_") || !value) continue;
		tokens.set(value, envSuffixToSurface(key.slice("SUBSTRATE_TOKEN_".length)));
	}
	return tokens;
}

/** A positive whole number of milliseconds, else the fallback. */
function positiveMs(raw: string | undefined, fallback: number): number {
	const value = Number(raw?.trim());
	return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): SubstrateConfig {
	const greptimeUrl = env.GREPTIME_URL?.trim();
	return {
		host: env.SUBSTRATE_HOST?.trim() || "127.0.0.1",
		port: Number(env.SUBSTRATE_PORT ?? 7410),
		greptime: greptimeUrl
			? {
					url: greptimeUrl.replace(/\/+$/, ""),
					user: env.GREPTIME_USER,
					password: env.GREPTIME_PASSWORD,
					db: env.GREPTIME_DB?.trim() || "public",
				}
			: null,
		postgresUrl: env.SUBSTRATE_PG_URL?.trim() || undefined,
		linearApiKey: env.LINEAR_API_KEY?.trim() || undefined,
		notionApiKey: env.NOTION_API_KEY?.trim() || undefined,
		notionTaskGraphDataSource: env.NOTION_TASK_GRAPH_DS?.trim() || "be3418f0-d2d8-411b-8677-fa8a95ee63be",
		hermesLinearUrl: (env.HERMES_LINEAR_URL?.trim() || "http://127.0.0.1:8792").replace(/\/+$/, ""),
		dodGateTimeoutMs: positiveMs(env.SUBSTRATE_DOD_GATE_TIMEOUT_MS, DEFAULT_GATE_TIMEOUT_MS),
		tokens: readTokens(env),
		// No tokens configured at all means a local dev run; requiring auth then
		// would just lock the operator out of their own machine.
		allowAnonymous: readTokens(env).size === 0,
	};
}

/** Resolve a request's bearer token to the surface it belongs to. */
export function surfaceForToken(config: SubstrateConfig, authorization: string | null): Surface | null {
	if (!authorization) return null;
	const token = authorization.replace(/^Bearer\s+/i, "").trim();
	return config.tokens.get(token) ?? null;
}
