/**
 * Configuration, loaded from the environment.
 *
 * Deployment reads /etc/substrate/substrate.env via the systemd unit's
 * EnvironmentFile. Nothing here ever reads a secret from the repo.
 */
import { normalizeTtlSeconds } from "./lease.ts";
import { parseGrants, type MemoryGrant } from "./memory-policy.ts";
import { SWARM_SURFACES, isSwarmSurface, type Surface } from "./types.ts";

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
	/**
	 * Dragonfly URL. Cache only. Unset leaves the read-through cache off.
	 * `SUBSTRATE_CACHE=0` turns it off even when this is set.
	 */
	dragonflyUrl: string | undefined;
	/** True only when `dragonflyUrl` is set and `SUBSTRATE_CACHE` is not `0`. */
	cacheEnabled: boolean;
	linearApiKey: string | undefined;
	notionApiKey: string | undefined;
	notionTaskGraphDataSource: string;
	/** bearer token → surface. Lets every event be attributed to a caller. */
	tokens: Map<string, Surface>;
	/**
	 * When true, an unauthenticated caller is accepted.
	 *
	 * Unset `SUBSTRATE_ALLOW_ANONYMOUS` keeps today's rule: true only when no
	 * surface token is configured. `1` is the migration bridge — configured tokens
	 * are still recognised, and untokened callers stay accepted. `0` requires a
	 * bearer even when no token is configured.
	 */
	allowAnonymous: boolean;
	/**
	 * Surface tokens that may also take a node off its holder.
	 *
	 * A forced release breaks the guarantee every other agent is relying on, so it
	 * is not a peer's to use: with every surface's token equally privileged, an
	 * agent could evict any other and the lease would be advisory again for
	 * anyone who chose. It is an operator action, and this is who the operators
	 * are. Empty on a bare local run, where `allowAnonymous` already means the
	 * machine's owner is the only caller.
	 *
	 * These are **also** `SUBSTRATE_TOKEN_*` values, not a separate class of
	 * credential. A token that authenticated but named no surface would reach the
	 * authoring routes with no identity, and each of those falls back to the
	 * request body — so an operator credential could sign a handoff as any agent
	 * it cared to name. Operator authority is an attribute of a surface token, so
	 * a forced release is always attributable to whoever used it.
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
	/**
	 * Where the hash-chained MCP audit is written. `null` keeps it in memory.
	 *
	 * Separate from the Greptime ledger on purpose — see `docs/mcp-audit.md`. A
	 * deployment sets `SUBSTRATE_AUDIT_PATH`; a bare local run does not, and boots
	 * with a warning rather than refusing every fail-closed tool because
	 * `/var/lib/substrate` does not exist.
	 */
	audit: { path: string | null };
	/**
	 * Withdraw a claim whose event did not reach the ledger.
	 *
	 * `null` means "decide from the deployment": on when a ledger is configured, off
	 * when there is none, because a local run with no `GREPTIME_URL` would otherwise
	 * have every claim withdrawn. `SUBSTRATE_CLAIM_REQUIRE_LEDGER` forces either way.
	 */
	requireRecordedClaims: boolean | null;
}

/** "swarm-a05-be" → "SUBSTRATE_TOKEN_SWARM_A05_BE": the inverse of `envSuffixToSurface`. */
export function tokenEnvName(surface: Surface): string {
	return `SUBSTRATE_TOKEN_${surface.toUpperCase().replace(/-/g, "_")}`;
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

/**
 * `SUBSTRATE_ALLOW_ANONYMOUS`: unset keeps today's rule, `1` keeps untokened
 * callers alongside tokens, `0` forces a bearer. Anything else is unset — a typo
 * must not open a deployment that already has tokens.
 */
function allowAnonymousFrom(env: Record<string, string | undefined>, tokenCount: number): boolean {
	const value = env.SUBSTRATE_ALLOW_ANONYMOUS?.trim() ?? "";
	if (/^(1|true|yes)$/i.test(value)) return true;
	if (/^(0|false|no)$/i.test(value)) return false;
	return tokenCount === 0;
}

/** True while the migration bridge is on: tokens exist and untokened callers are still accepted. */
export function anonymousBridge(config: SubstrateConfig): boolean {
	return config.allowAnonymous && config.tokens.size > 0;
}

/** Surfaces that have a configured token. An untokened caller may not claim one of these. */
export function tokenedSurfaces(config: SubstrateConfig): ReadonlySet<Surface> {
	return new Set(config.tokens.values());
}

export function loadConfig(env: Record<string, string | undefined> = process.env): SubstrateConfig {
	const greptimeUrl = env.GREPTIME_URL?.trim();
	const leaseTtl = Number(env.SUBSTRATE_LEASE_TTL_SECONDS);
	const tokens = readTokens(env);
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
		...cacheSettings(env),
		linearApiKey: env.LINEAR_API_KEY?.trim() || undefined,
		notionApiKey: env.NOTION_API_KEY?.trim() || undefined,
		notionTaskGraphDataSource: env.NOTION_TASK_GRAPH_DS?.trim() || "be3418f0-d2d8-411b-8677-fa8a95ee63be",
		tokens,
		allowAnonymous: allowAnonymousFrom(env, tokens.size),
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
		audit: { path: env.SUBSTRATE_AUDIT_PATH?.trim() || null },
		requireRecordedClaims: booleanOrNull(env.SUBSTRATE_CLAIM_REQUIRE_LEDGER),
	};
}

/**
 * `SUBSTRATE_CACHE=0` (also `false` / `no`) disables the cache. Any other value,
 * including unset, leaves it on when `DRAGONFLY_URL` is set. A typo must not
 * silently disable a cache the operator configured.
 */
function cacheSettings(env: Record<string, string | undefined>): {
	dragonflyUrl: string | undefined;
	cacheEnabled: boolean;
} {
	const dragonflyUrl = env.DRAGONFLY_URL?.trim() || undefined;
	const off = /^(0|false|no)$/i.test(env.SUBSTRATE_CACHE?.trim() ?? "");
	return { dragonflyUrl, cacheEnabled: dragonflyUrl !== undefined && !off };
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

/** `null` when unset, so the caller can tell "not configured" from "configured false". */
function booleanOrNull(raw: string | undefined): boolean | null {
	const value = raw?.trim();
	if (!value) return null;
	if (/^(1|true|yes)$/i.test(value)) return true;
	if (/^(0|false|no)$/i.test(value)) return false;
	return null;
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
 * On a bare local run — no surface tokens at all — the caller is the machine's
 * owner and the answer is yes; there is nobody else to protect the lease from.
 * Once tokens exist, including while the anonymous bridge is on, an ordinary
 * surface token is not enough: the token must also be listed as an operator's,
 * because a forced release is exactly the thing one agent must not be able to
 * do to another. An untokened caller on the bridge is not an operator either.
 *
 * A swarm surface's token is never an operator, listed or not. The swarm runs
 * agents unattended against each other's nodes, so a listed swarm token would be
 * one agent able to evict any other, which is the advisory lease again. The
 * `substrate` host-job surface is held by unattended host jobs (anchor,
 * skills-sync, dispatcher) under the same threat model, so its token is never
 * an operator either. Refusing both here, rather than trusting the list, fails
 * closed on a misconfiguration that `configWarnings` reports at boot.
 */
export function isOperator(config: SubstrateConfig, authorization: string | null): boolean {
	// A bare local run — no surface tokens at all — is its own operator. The bridge
	// is not that run: tokens exist, so an untokened caller must not become one
	// merely because untokened callers are still accepted.
	if (config.tokens.size === 0 && config.allowAnonymous && config.operatorTokens.size === 0) return true;
	const token = bearer(authorization);
	if (token === null || !config.operatorTokens.has(token)) return false;
	const named = config.tokens.get(token);
	// Once any surface token exists, operator authority is an attribute of one of
	// them. A bearer listed only in SUBSTRATE_OPERATOR_TOKENS used to be 401; the
	// bridge must not turn that 401 into `force` with no named surface.
	// `isSwarmSurface(undefined)` is false, which is how that bearer used to pass.
	if (named === undefined) return config.tokens.size === 0;
	return !isSwarmSurface(named) && named !== "substrate";
}

/**
 * A presented bearer that names no surface, once any surface token exists.
 *
 * The bridge accepts a *missing* token. It does not accept a token that is not
 * configured: that request used to be 401, and admitting it would make an
 * operator-only bearer look like an anonymous caller.
 */
export function unmappedBearer(config: SubstrateConfig, authorization: string | null): boolean {
	if (config.tokens.size === 0) return false;
	const token = bearer(authorization);
	return token !== null && !config.tokens.has(token);
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

/**
 * Configuration that will not do what the operator intended, reported at boot.
 *
 * A warning has to say what is *actually* true of the running deployment, or it
 * costs more than it saves: an operator reading the wrong reason fixes the wrong
 * thing, and here the two reasons lead in opposite directions — one says add a
 * surface token, the other says you have no authentication at all.
 *
 * With surface tokens configured, a token listed only as an operator's can never
 * authenticate: the HTTP surface requires a token that names a surface, so it
 * would look configured and silently do nothing.
 *
 * With no surface tokens at all, the opposite holds. `allowAnonymous` lets every
 * caller in unauthenticated, and `isOperator` still honours the operator token —
 * so it does work, and it is the only thing gating anything.
 */
export function configWarnings(config: SubstrateConfig): string[] {
	const warnings: string[] = [];
	if (config.operatorTokens.size === 0) return warnings;

	if (config.allowAnonymous && config.tokens.size === 0) {
		warnings.push(
			"operator tokens are set but no SUBSTRATE_TOKEN_* surface token is, so every caller is accepted " +
				"unauthenticated and attributed by its own payload. The operator tokens do work — they gate a forced " +
				"release — but nothing else is gated at all.",
		);
		return warnings;
	}

	if ([...config.operatorTokens].some((token) => !config.tokens.has(token))) {
		warnings.push(
			"an operator token is not also a SUBSTRATE_TOKEN_* surface token, so it cannot authenticate at all; " +
				"operator authority is an attribute of a surface token",
		);
	}

	// Named by surface, never by token: the warning goes to a log.
	const swarmOperators = [...config.operatorTokens].map((token) => config.tokens.get(token)).filter(isSwarmSurface);
	if (swarmOperators.length > 0) {
		warnings.push(
			`SUBSTRATE_OPERATOR_TOKENS lists the token of ${swarmOperators.join(", ")}; a swarm surface is never an ` +
				"operator, so it is refused `force` like any other agent. Remove it from the list.",
		);
	}
	// Named by surface, never by token: the warning goes to a log.
	if ([...config.operatorTokens].some((token) => config.tokens.get(token) === "substrate")) {
		warnings.push(
			"SUBSTRATE_OPERATOR_TOKENS lists the token of substrate; the host-job surface is never an " +
				"operator, so it is refused `force` like any other agent. Remove it from the list.",
		);
	}
	return warnings;
}

/**
 * Swarm surfaces — and the `substrate` host-job surface — that have no token, reported at boot.
 *
 * Only a deployment that has authentication is told: a bare local run (no
 * `SUBSTRATE_TOKEN_*` at all) accepts every caller anonymously, and a warning there
 * would be noise about a setup that is working as intended. Once any token is set, an
 * agent without its own cannot authenticate — the server answers it 401 rather than
 * accepting it anonymously — so a missing one is a swarm seat that will be locked out
 * and the operator should hear about it at boot, not from the first failed run.
 * The same holds for `substrate`: without `SUBSTRATE_TOKEN_SUBSTRATE` no host job
 * (anchor, skills-sync, dispatcher) can authenticate.
 *
 * Separate from `configWarnings` because it describes an absence the operator may have
 * chosen (a deployment that does not run the swarm), not a configuration that
 * contradicts itself. One message per gap, naming every variable, so the list is one grep.
 */
export function swarmTokenWarnings(config: SubstrateConfig): string[] {
	if (config.allowAnonymous) return [];
	const held = new Set(config.tokens.values());
	const warnings: string[] = [];
	const missing = SWARM_SURFACES.filter((surface) => !held.has(surface));
	if (missing.length > 0) {
		warnings.push(
			`no token for ${missing.length} swarm surface${missing.length === 1 ? "" : "s"} ` +
				`(${missing.map(tokenEnvName).join(", ")}); a swarm agent without its own token is refused with 401, ` +
				"not accepted anonymously",
		);
	}
	if (!held.has("substrate")) {
		warnings.push(
			`no token for the substrate surface (${tokenEnvName("substrate")}); a host job without its own token ` +
				"is refused with 401, not accepted anonymously",
		);
	}
	return warnings;
}
