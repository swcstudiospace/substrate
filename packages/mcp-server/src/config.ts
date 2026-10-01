/**
 * Configuration, loaded from the environment.
 *
 * Deployment reads /etc/substrate/substrate.env via the systemd unit's
 * EnvironmentFile. Nothing here ever reads a secret from the repo.
 */
import type { Surface, MemoryPolicy } from "./types.ts";

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
	/** bearer token → surface. Lets every event be attributed to a caller. */
	tokens: Map<string, Surface>;
	/** When true, an unauthenticated caller is accepted and attributed by its payload. */
	allowAnonymous: boolean;
	/**
	 * Accept a ledger that is not provably append-only.
	 *
	 * The default is to refuse: an `agent_events` without `append_mode` drops one
	 * of two rows sharing a primary key and a millisecond, and a ledger that loses
	 * rows while answering `stored: true` is worse than one that says it cannot
	 * take the write. Recreating the table is the fix and is out of band — the
	 * client refuses `ALTER` and `RENAME` by design.
	 *
	 * This exists so an operator can knowingly accept that loss while the recreate
	 * is pending, rather than having no lever at all. It is never the quiet path:
	 * the state is in `/healthz` and on every append either way.
	 */
	allowDeduplicatingLedger: boolean;
	/** Policy for the memory gate (default-deny RBAC etc). Populated by loadMemoryPolicy. */
	memoryPolicy: MemoryPolicy;
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
		tokens: readTokens(env),
		// No tokens configured at all means a local dev run; requiring auth then
		// would just lock the operator out of their own machine.
		allowAnonymous: readTokens(env).size === 0,
		allowDeduplicatingLedger: /^(1|true|yes)$/i.test(env.SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER?.trim() ?? ""),
		memoryPolicy: loadMemoryPolicy(env),
	};
}

/** Resolve a request's bearer token to the surface it belongs to. */
export function surfaceForToken(config: SubstrateConfig, authorization: string | null): Surface | null {
	if (!authorization) return null;
	const token = authorization.replace(/^Bearer\s+/i, "").trim();
	return config.tokens.get(token) ?? null;
}

/** Policy loader for memory governance gate. Skeleton returns a static default-deny policy.
 * Real loader (later) will read YAML from SUBSTRATE_MEMORY_POLICY or /etc/substrate/ without new third-party packages.
 */
export function loadMemoryPolicy(env: Record<string, string | undefined> = process.env): MemoryPolicy {
	// default-deny per v0.3 spec; rules populated from external policy source in full impl
	return {
		version: "0.1-skel",
		defaultAction: "deny",
		rules: [],
		conflictStrategy: {
			todo: "last-write-wins",
			decision: "versioned",
			warning: "require-review",
		},
	};
}
