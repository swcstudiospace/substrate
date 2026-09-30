/**
 * Configuration, loaded from the environment.
 *
 * Deployment reads /etc/substrate/substrate.env via the systemd unit's
 * EnvironmentFile. Nothing here ever reads a secret from the repo.
 */
import { normalizeTtlSeconds } from "./lease.ts";
import { parseGrants, type MemoryGrant } from "./memory-policy.ts";
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
	/** bearer token → surface. Lets every event be attributed to a caller. */
	tokens: Map<string, Surface>;
	/** When true, an unauthenticated caller is accepted and attributed by its payload. */
	allowAnonymous: boolean;
	/**
	 * Tokens that may take a node off its holder.
	 *
	 * A forced release breaks the guarantee every other agent is relying on, so it
	 * is not a peer's to use: with every surface's token equally privileged, an
	 * agent could evict any other and the lease would be advisory again for
	 * anyone who chose. It is an operator action, and this is who the operators
	 * are. Empty on a bare local run, where `allowAnonymous` already means the
	 * machine's owner is the only caller.
	 */
	operatorTokens: Set<string>;
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
	/**
	 * Tokens that carry reviewer authority over memory.
	 *
	 * A reviewer's token is the only thing that installs a `global` memory, records
	 * `human-confirmed` trust, claims `actor: "human"` or releases a reviewable
	 * quarantine. It is deliberately not a surface token: a surface token says *who
	 * is writing*, and this says *a person checked this*. Configuring none leaves
	 * every one of those paths closed, which is the correct default — the queue
	 * fills, nothing forged gets through.
	 */
	memoryReviewTokens: Set<string>;
	/**
	 * Grants appended to the default-deny memory policy, from JSON.
	 *
	 * They only ever widen it. There is no env var that narrows the defaults,
	 * because a policy you can loosen by deleting a variable is not one.
	 */
	memoryGrants: readonly MemoryGrant[];
	/** Default node-lease TTL in seconds. A caller may ask for less or more, within bounds. */
	leaseTtlSeconds: number;
	/**
	 * Keys a handoff packet's signature is verified against, by key id.
	 *
	 * More than one so a key can be rotated without invalidating the packets
	 * already in the ledger: the new key signs, the old one still verifies.
	 */
	handoffKeys: Map<string, string>;
	/** The key id new packets are signed with. Null when no key is configured. */
	handoffKeyId: string | null;
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

/**
 * The signing key and whatever previous key is still being honoured.
 *
 * A packet names the key id it was signed with, so rotation is: move the live
 * key to `SUBSTRATE_HANDOFF_KEY_PREV`, put the new one in
 * `SUBSTRATE_HANDOFF_KEY`, give it a new id. Packets signed either side of that
 * still verify, and nothing in the append-only ledger becomes unreadable.
 */
function readHandoffKeys(env: Record<string, string | undefined>): {
	handoffKeys: Map<string, string>;
	handoffKeyId: string | null;
} {
	const keys = new Map<string, string>();
	const active = env.SUBSTRATE_HANDOFF_KEY?.trim();
	const activeId = env.SUBSTRATE_HANDOFF_KEY_ID?.trim() || "k1";
	const previous = env.SUBSTRATE_HANDOFF_KEY_PREV?.trim();
	const previousId = env.SUBSTRATE_HANDOFF_KEY_PREV_ID?.trim() || "k0";
	if (previous) keys.set(previousId, previous);
	// Set last, so a misconfiguration that gives both keys the same id leaves the
	// live key in place rather than the retired one.
	if (active) keys.set(activeId, active);
	return { handoffKeys: keys, handoffKeyId: active ? activeId : null };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): SubstrateConfig {
	const greptimeUrl = env.GREPTIME_URL?.trim();
	const leaseTtl = Number(env.SUBSTRATE_LEASE_TTL_SECONDS);
	return {
		...readHandoffKeys(env),
		leaseTtlSeconds: normalizeTtlSeconds(Number.isFinite(leaseTtl) ? leaseTtl : undefined),
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
		operatorTokens: new Set(
			(env.SUBSTRATE_OPERATOR_TOKENS ?? "")
				.split(",")
				.map((token) => token.trim())
				.filter((token) => token.length > 0),
		),
		allowDeduplicatingLedger: /^(1|true|yes)$/i.test(env.SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER?.trim() ?? ""),
		memoryReviewTokens: readReviewTokens(env.SUBSTRATE_MEMORY_REVIEW_TOKENS),
		memoryGrants: parseGrants(env.SUBSTRATE_MEMORY_GRANTS, (message) =>
			process.stderr.write(`[substrate] ${message}\n`),
		),
	};
}

/** Comma- or whitespace-separated, so an operator can wrap the line in the env file. */
function readReviewTokens(raw: string | undefined): Set<string> {
	return new Set(
		(raw ?? "")
			.split(/[\s,]+/)
			.map((token) => token.trim())
			// A short string is a placeholder or a typo, not a token, and accepting one
			// would hand reviewer authority to anybody who guessed it.
			.filter((token) => token.length >= 16),
	);
}

function bearer(authorization: string | null): string | null {
	if (!authorization) return null;
	const token = authorization.replace(/^Bearer\s+/i, "").trim();
	return token.length > 0 ? token : null;
}

/** Resolve a request's bearer token to the surface it belongs to. */
export function surfaceForToken(config: SubstrateConfig, authorization: string | null): Surface | null {
	const token = bearer(authorization);
	return token === null ? null : config.tokens.get(token) ?? null;
}

/**
 * Whether this request may take a node off its holder.
 *
 * On a bare local run — no surface tokens at all, so `allowAnonymous` — the
 * caller is the machine's owner and the answer is yes; there is nobody else to
 * protect the lease from. Once tokens exist, a surface token is not enough: an
 * operator token must be presented, because a forced release is exactly the
 * thing one agent must not be able to do to another.
 */
export function isOperator(config: SubstrateConfig, authorization: string | null): boolean {
	if (config.allowAnonymous && config.operatorTokens.size === 0) return true;
	const token = bearer(authorization);
	return token !== null && config.operatorTokens.has(token);
}

/**
 * Whether a presented token carries reviewer authority.
 *
 * Fail-closed by construction: a missing token, an empty one and an unknown one
 * are the same answer, and with no reviewer tokens configured the answer is always
 * no. Never logs the token — a rejected credential in a log is still a credential
 * in a log.
 */
export function isReviewToken(config: SubstrateConfig, token: string | undefined): boolean {
	if (typeof token !== "string") return false;
	const trimmed = token.trim();
	return trimmed.length > 0 && config.memoryReviewTokens.has(trimmed);
}
