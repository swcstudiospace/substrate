/**
 * Configuration, loaded from the environment.
 *
 * Deployment reads /etc/substrate/substrate.env via the systemd unit's
 * EnvironmentFile. Nothing here ever reads a secret from the repo.
 */
import { SOLANA_CLI_DEFAULT } from "@substrate/ledger";
import { loadBreakerSettings, type BreakerSettings } from "@substrate/observability";
import { DEFAULT_INGEST_ROOTS } from "./docs-ingest.ts";
import { normalizeTtlSeconds } from "./lease.ts";
import { LINEAR_API_URL } from "./linear.ts";
import { parseGrants, type MemoryGrant } from "./memory-policy.ts";
import { DEFAULT_RECALL_BUDGET_MS } from "./memory-recall.ts";
import { NOTION_API_URL } from "./notion.ts";
import { DEFAULT_RETRIEVAL_KNOBS, ragflowFromEnv, type RagflowConfig, type RetrievalKnobs } from "./planes/ragflow.ts";
import { DEFAULT_RETAIN_DRAIN_MS, DEFAULT_RETAIN_MAX_ATTEMPTS, DEFAULT_RETAIN_OUTBOX_MAX } from "./retain-outbox.ts";
import { SURFACES, SWARM_SURFACES, isSwarmSurface, type Surface } from "./types.ts";

/** Default hermes-linear-connector base URL (D23-25). */
export const DEFAULT_HERMES_LINEAR_URL = "http://127.0.0.1:8792";
/** Default DoD gate wait: above the connector's own 30 s Linear call (D23-15.4). */
export const DEFAULT_DOD_GATE_TIMEOUT_MS = 35000;

/** Positive finite milliseconds, floored; anything else is the default. */
function parseDodGateTimeoutMs(raw: string | undefined): number {
	const ms = Number(raw?.trim());
	return Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : DEFAULT_DOD_GATE_TIMEOUT_MS;
}

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
	/**
	 * Why the cache is off despite `DRAGONFLY_URL` being set (DOCS-06).
	 *
	 * A plaintext non-loopback `redis://` URL is refused fail-open: the cache
	 * stays off, answers come back uncached, and the reason is logged at boot.
	 * Null when the cache was not refused.
	 */
	dragonflyRefused: string | null;
	linearApiKey: string | undefined;
	notionApiKey: string | undefined;
	notionTaskGraphDataSource: string;
	/**
	 * Base URL of the hermes-linear-connector DoD gate. Trailing slashes are
	 * trimmed at load. Unset in production substrate.env today, so the default
	 * (the connector's loopback address) applies.
	 */
	hermesLinearUrl: string;
	/** How long the DoD gate waits for the connector before settling via Linear state. */
	dodGateTimeoutMs: number;
	/**
	 * Linear GraphQL endpoint. Defaults to the real API; the harness rehearsal
	 * points it at a loopback fake. Production never sets this.
	 */
	linearApiUrl: string;
	/**
	 * Notion API base. Defaults to the real API; the harness rehearsal points
	 * it at a loopback fake. Production never sets this.
	 */
	notionApiUrl: string;
	/**
	 * The RAGFlow reach, or null when the plane is unconfigured (D25-02).
	 *
	 * Read from `RAGFLOW_URL` / `RAGFLOW_API_KEY` only; `RAGFLOW_MCP_URL`
	 * names the unused MCP transport and is never read. Null leaves
	 * docs_search degraded rather than broken.
	 */
	ragflow: RagflowConfig | null;
	/**
	 * Path prefixes a docs_ingest page may come from (D25-05).
	 *
	 * From `SUBSTRATE_DOCS_INGEST_ROOTS` (comma-separated) or the dataset
	 * sources in `docs/data-planes.md` when unset. A page outside these
	 * roots is refused before anything is read from RAGFlow.
	 */
	docsIngestRoots: readonly string[];
	/**
	 * True when this instance runs inside a VM guest (D25-05).
	 *
	 * From `SUBSTRATE_VM_GUEST=1`. A guest instance refuses every
	 * docs_ingest before any network call, so guest bytes can never be
	 * published to a shared dataset.
	 */
	vmGuest: boolean;
	/**
	 * Where docs_ingest records live across restarts (Greptile P1).
	 *
	 * From `SUBSTRATE_DOCS_STATE_FILE`; null keeps the records process-local.
	 * A path, never a credential, so boot warnings may quote it. The file
	 * holds content hashes and document ids only — the same locators the
	 * ingest events already carry.
	 */
	docsStateFile: string | null;
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
	 * client refuses `RENAME` and every `ALTER` but the guarded TTL one by design.
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
	 * Which skill library proposals target, and where their state lives.
	 *
	 * Production defaults are September's library. A non-default repo or remote
	 * is accepted only for a local `file://` remote with an absolute non-default
	 * `gh`, so a typo can never send the real `gh` and the owner's credential at
	 * another repository. Any other combination sets `problem` — the
	 * invalid-combination reason, naming the bad key — and every proposal is
	 * refused until it is fixed, without crashing the server.
	 */
	skills: { repo: string; remoteUrl: string; stateDir: string; gh: string; problem: string | null };
	/**
	 * Surfaces allowed to call `desktop_run`, from `SUBSTRATE_DESKTOP_SURFACES`.
	 *
	 * The operator allowlist is the only gate (D30-01): unset or empty means
	 * nobody may call `desktop_run`. A name that is not in `SURFACES` is dropped
	 * — it never widens the list — and reported at boot by
	 * `desktopConfigWarnings`. An operator token grants nothing here:
	 * `isOperator` is never consulted by the gate.
	 */
	desktopSurfaces: ReadonlySet<Surface>;
	/**
	 * Directory screenshots are stored under, from `SUBSTRATE_DESKTOP_DIR`.
	 *
	 * Only an absolute path overrides the default `/var/lib/substrate/desktop`
	 * (D30-09). A relative value keeps the default and is reported at boot by
	 * `desktopConfigWarnings`, so screenshots can never land in the repo by
	 * typo — and `loadConfig` never throws over it.
	 */
	desktopDir: string;
	/**
	 * Allowlist names that named no known surface, dropped at parse time.
	 *
	 * Names only, never token values: the boot warning logs them. Empty when
	 * the allowlist itself is empty — an empty allowlist is the fail-closed
	 * default, not a misconfiguration, and warns nothing.
	 */
	desktopIgnored: readonly string[];
	/**
	 * The rejected `SUBSTRATE_DESKTOP_DIR` value, when it was set but relative.
	 *
	 * A path, not a credential, so the boot warning may quote it. `null` when
	 * the variable was unset, empty or absolute.
	 */
	desktopDirRejected: string | null;
	/**
	 * Withdraw a claim whose event did not reach the ledger.
	 *
	 * `null` means "decide from the deployment": on when a ledger is configured, off
	 * when there is none, because a local run with no `GREPTIME_URL` would otherwise
	 * have every claim withdrawn. `SUBSTRATE_CLAIM_REQUIRE_LEDGER` forces either way.
	 */
	requireRecordedClaims: boolean | null;
	/**
	 * The hourly anchor job's devnet identity (Phase 28).
	 *
	 * `rpcUrl` defaults to the public devnet endpoint and `cli` to the
	 * installed solana binary; `keypairPath` and `pubkey` are null unless the
	 * operator sets them, and the job exits 2 with usage until they do. The
	 * keypair is only ever a path the CLI reads — it is never opened or
	 * logged here. `pubkey` is non-secret.
	 */
	solana: { rpcUrl: string; keypairPath: string | null; pubkey: string | null; cli: string };
	/**
	 * Whole-verify devnet budget in milliseconds (D28-18).
	 *
	 * Per-hour reads already carry their own per-call timeout with bounded
	 * attempts; this caps the hour loop as a whole, so one slow hour cannot
	 * hold a `/verify` request open. Hours never reached read `unverified`.
	 */
	verifyTimeoutMs: number;
	/**
	 * Per-plane circuit breaker settings (uplift-2 R2), from `SUBSTRATE_BREAKER`,
	 * `SUBSTRATE_BREAKER_FAILURES` and `SUBSTRATE_BREAKER_OPEN_MS`.
	 *
	 * `SUBSTRATE_BREAKER=0` is the kill switch: every plane call runs unwrapped,
	 * exactly as before the breakers existed, and is still measured.
	 */
	breaker: BreakerSettings;
	// uplift-2 R1 — brief fast path and cache effectiveness. Every knob is
	// default-on and `0` switches it off; none needs a redeploy of code.
	/** Shared deadline for the four brief source reads, ms (`SUBSTRATE_BRIEF_BUDGET_MS`, default 1200; 0 = none). */
	briefBudgetMs: number;
	/** How far back the recent-actions query looks, days (`SUBSTRATE_BRIEF_RECENT_WINDOW_DAYS`, default 30). */
	briefRecentWindowDays: number;
	/** TTL of the last-good brief snapshot, s (`SUBSTRATE_BRIEF_SNAPSHOT_TTL_S`, default 3600; 0 = no snapshots). */
	briefSnapshotTtlS: number;
	/** Per-command cache timeout, ms (`SUBSTRATE_CACHE_COMMAND_TIMEOUT_MS`, default 250). */
	cacheCommandTimeoutMs: number;
	/** Cache connect timeout, ms (`SUBSTRATE_CACHE_CONNECT_TIMEOUT_MS`, default 250). */
	cacheConnectTimeoutMs: number;
	/** How long a computed `/healthz` body is served to pollers, ms (`SUBSTRATE_HEALTHZ_CACHE_MS`, default 5000; 0 = recompute per call). */
	healthzCacheMs: number;
	// uplift-2 R5
	/**
	 * Ledger chain cache, chain-tip lookback, write-probe cadence and opt-in TTL,
	 * from `SUBSTRATE_LEDGER_*`. See `docs/greptime-ledger.md`.
	 */
	ledger: LedgerSettings;
	// uplift-2 R3
	/**
	 * Hindsight time bounds (uplift-2 R3): the `memory_recall` fan-out budget
	 * (`HINDSIGHT_RECALL_BUDGET_MS`), the shorter recall leg inside
	 * `memory_search` (`HINDSIGHT_SEARCH_RECALL_BUDGET_MS`) and the retain POST
	 * bound (`HINDSIGHT_RETAIN_TIMEOUT_MS`). Milliseconds; non-positive or
	 * unparsable values fall back to the defaults. The URL and key are still
	 * read by `planes/hindsight.ts` alone (D26-02).
	 */
	hindsightBudgets: { recallBudgetMs: number; searchRecallBudgetMs: number; retainTimeoutMs: number };
	/**
	 * The retain outbox (uplift-2 R3): `path` from `SUBSTRATE_RETAIN_OUTBOX_PATH`
	 * (null = memory-only queue), `max` entries, the attempt ceiling and the
	 * drain interval. A path, never a credential, so boot output may quote it.
	 */
	retainOutbox: { path: string | null; max: number; maxAttempts: number; drainMs: number };
	/**
	 * Which Hindsight routing keys were present, for the boot warnings only:
	 * the legacy single-bank key is unread, and a URL without a bank list means
	 * recall reads the caller's own bank only. Presence, never a value.
	 */
	hindsightEnv: { legacyBankSet: boolean; urlSet: boolean; banksSet: boolean };
	// uplift-2 R6 — RAGFlow docs plane
	/**
	 * Delete a superseded document after its replacement parsed
	 * (`SUBSTRATE_DOCS_PRUNE_SUPERSEDED=1`). Off by default: nothing on the
	 * plane is deleted unless the operator turns this on.
	 */
	docsPruneSuperseded: boolean;
	/**
	 * The three documented retrieval knobs sent on every `docs_search`
	 * retrieval, from `SUBSTRATE_DOCS_SIMILARITY_THRESHOLD` (0.2),
	 * `SUBSTRATE_DOCS_VECTOR_WEIGHT` (0.3) and `SUBSTRATE_DOCS_TOP_K` (1024).
	 * The defaults are RAGFlow's own; junk or out-of-range values fall back.
	 */
	docsRetrieval: RetrievalKnobs;
}

/** Production defaults: September's library, so the host ledger keeps deduplicating. */
export const DEFAULT_SKILLS_REPO = "swcstudiospace/agent-skills";
export const DEFAULT_SKILLS_REMOTE_URL = "https://github.com/swcstudiospace/agent-skills.git";
export const DEFAULT_SKILLS_STATE = "/var/lib/substrate/skills";
export const DEFAULT_SKILLS_GH = "gh";

/**
 * The skills library block, in the `loadConfig` trim-or-default style.
 *
 * Never throws: an invalid combination sets `problem` (naming the bad key) and
 * `configWarnings` reports it at boot, because a throw here would crash-loop
 * every deployment under `Restart=always`.
 */
function readSkills(env: Record<string, string | undefined>): SubstrateConfig["skills"] {
	const repo = env.SUBSTRATE_SKILLS_REPO?.trim() || DEFAULT_SKILLS_REPO;
	const remoteUrl = env.SUBSTRATE_SKILLS_REMOTE_URL?.trim() || DEFAULT_SKILLS_REMOTE_URL;
	const stateDir = env.SUBSTRATE_SKILLS_STATE?.trim() || DEFAULT_SKILLS_STATE;
	const gh = env.SUBSTRATE_SKILLS_GH?.trim() || DEFAULT_SKILLS_GH;
	let problem: string | null = null;
	if (repo !== DEFAULT_SKILLS_REPO || remoteUrl !== DEFAULT_SKILLS_REMOTE_URL) {
		if (!remoteUrl.startsWith("file://")) {
			problem = "SUBSTRATE_SKILLS_REMOTE_URL must be a file:// path to propose to a non-default library";
		} else if (gh === DEFAULT_SKILLS_GH || !gh.startsWith("/")) {
			problem = "SUBSTRATE_SKILLS_GH must be an absolute path to a non-default gh to propose to a non-default library";
		}
	}
	return { repo, remoteUrl, stateDir, gh, problem };
}
/** "swarm-a05-be" → "SUBSTRATE_TOKEN_SWARM_A05_BE": the inverse of the suffix mapping in `tokenConfig`. */
export function tokenEnvName(surface: Surface): string {
	return `SUBSTRATE_TOKEN_${surface.toUpperCase().replace(/-/g, "_")}`;
}

/**
 * A surface-token configuration that contradicts itself, reported at boot.
 *
 * The message names variables only, never values: it goes to stderr, and a
 * refused credential in a log is still a credential in a log.
 */
export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

/**
 * bearer token → surface, from every `SUBSTRATE_TOKEN_*` variable.
 *
 * Each variable holds a comma-separated list, so one surface can have several
 * values — the operator, the gateway and the connector each hold their own —
 * and one value stays valid, so the change is backward compatible. Entries
 * split on commas and whitespace like the reviewer tokens, trimmed with
 * empties dropped; a repeat under one variable is silently one entry.
 *
 * Pure, so boot and `identity:check --values` share it. It throws ConfigError,
 * naming variables only, when a variable names no surface in SURFACES or when
 * one value is listed under two surfaces: today's Map.set would silently
 * re-attribute that token to whichever variable came last.
 */
export function tokenConfig(env: Record<string, string | undefined>): Map<string, Surface> {
	const prefix = "SUBSTRATE_TOKEN_";
	const tokens = new Map<string, Surface>();
	const firstVar = new Map<string, string>();
	for (const [key, value] of Object.entries(env)) {
		if (!key.startsWith(prefix)) continue;
		const surface = key.slice(prefix.length).toLowerCase().replace(/_/g, "-");
		if (!(SURFACES as readonly string[]).includes(surface)) {
			throw new ConfigError(
				`${key} names no known surface; remove it or rename it to the SUBSTRATE_TOKEN_<SURFACE> ` +
					`of the surface its value authenticates as`,
			);
		}
		if (!value) continue;
		for (const entry of new Set(
			value
				.split(/[\s,]+/)
				.map((token) => token.trim())
				.filter((token) => token.length > 0),
		)) {
			const other = firstVar.get(entry);
			if (other === undefined) {
				firstVar.set(entry, key);
				// Narrowed by the SURFACES membership throw above; the cast says
				// so at the one place a Surface is produced.
				tokens.set(entry, surface as Surface);
			} else if (other !== key) {
				throw new ConfigError(
					`the same token value is listed under both ${other} and ${key}; a token names exactly ` +
						`one surface, so the server refuses to choose between them`,
				);
			}
		}
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

/** Where screenshots land unless `SUBSTRATE_DESKTOP_DIR` says otherwise (D30-09). */
export const DEFAULT_DESKTOP_DIR = "/var/lib/substrate/desktop";

function isKnownDesktopSurface(value: string): value is Surface {
	return (SURFACES as readonly string[]).includes(value);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): SubstrateConfig {
	const greptimeUrl = env.GREPTIME_URL?.trim();
	const leaseTtl = Number(env.SUBSTRATE_LEASE_TTL_SECONDS);
	const tokens = tokenConfig(env);
	const desktopNames = (env.SUBSTRATE_DESKTOP_SURFACES ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name.length > 0);
	const desktopDirRaw = env.SUBSTRATE_DESKTOP_DIR?.trim() || "";
	const ingestRoots = (env.SUBSTRATE_DOCS_INGEST_ROOTS ?? "")
		.split(",")
		.map((root) => root.trim())
		.filter((root) => root.length > 0);
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
		hermesLinearUrl: (env.HERMES_LINEAR_URL?.trim() || DEFAULT_HERMES_LINEAR_URL).replace(/\/+$/, ""),
		dodGateTimeoutMs: parseDodGateTimeoutMs(env.SUBSTRATE_DOD_GATE_TIMEOUT_MS),
		linearApiUrl: (env.LINEAR_API_URL?.trim() || LINEAR_API_URL).replace(/\/+$/, ""),
		notionApiUrl: (env.NOTION_API_URL?.trim() || NOTION_API_URL).replace(/\/+$/, ""),
		ragflow: ragflowFromEnv(env),
		docsIngestRoots: ingestRoots.length > 0 ? ingestRoots : [...DEFAULT_INGEST_ROOTS],
		vmGuest: (env.SUBSTRATE_VM_GUEST?.trim() ?? "") === "1",
		docsStateFile: env.SUBSTRATE_DOCS_STATE_FILE?.trim() || null,
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
		skills: readSkills(env),
		requireRecordedClaims: booleanOrNull(env.SUBSTRATE_CLAIM_REQUIRE_LEDGER),
		desktopSurfaces: new Set(desktopNames.filter(isKnownDesktopSurface)),
		desktopDir: desktopDirRaw.startsWith("/") ? desktopDirRaw : DEFAULT_DESKTOP_DIR,
		desktopIgnored: desktopNames.filter((name) => !isKnownDesktopSurface(name)),
		desktopDirRejected: desktopDirRaw !== "" && !desktopDirRaw.startsWith("/") ? desktopDirRaw : null,
		solana: {
			rpcUrl: env.SOLANA_RPC_URL?.trim() || "https://api.devnet.solana.com",
			keypairPath: env.SOLANA_ANCHOR_KEYPAIR?.trim() || null,
			pubkey: env.SOLANA_ANCHOR_PUBKEY?.trim() || null,
			cli: env.SOLANA_CLI?.trim() || SOLANA_CLI_DEFAULT,
		},
		verifyTimeoutMs: Number.isFinite(Number(env.SUBSTRATE_VERIFY_TIMEOUT_MS)) && Number(env.SUBSTRATE_VERIFY_TIMEOUT_MS) > 0
			? Number(env.SUBSTRATE_VERIFY_TIMEOUT_MS)
			: 30_000,
		breaker: loadBreakerSettings(env),
		// uplift-2 R1
		briefBudgetMs: nonNegativeOr(env.SUBSTRATE_BRIEF_BUDGET_MS, 1200),
		briefRecentWindowDays: positiveOr(env.SUBSTRATE_BRIEF_RECENT_WINDOW_DAYS, 30),
		briefSnapshotTtlS: nonNegativeOr(env.SUBSTRATE_BRIEF_SNAPSHOT_TTL_S, 3600),
		cacheCommandTimeoutMs: positiveOr(env.SUBSTRATE_CACHE_COMMAND_TIMEOUT_MS, 250),
		cacheConnectTimeoutMs: positiveOr(env.SUBSTRATE_CACHE_CONNECT_TIMEOUT_MS, 250),
		healthzCacheMs: nonNegativeOr(env.SUBSTRATE_HEALTHZ_CACHE_MS, 5000),
		// uplift-2 R5
		ledger: loadLedgerSettings(env),
		// uplift-2 R3
		hindsightBudgets: {
			recallBudgetMs: positiveIntOr(env.HINDSIGHT_RECALL_BUDGET_MS, DEFAULT_RECALL_BUDGET_MS),
			searchRecallBudgetMs: positiveIntOr(env.HINDSIGHT_SEARCH_RECALL_BUDGET_MS, DEFAULT_SEARCH_RECALL_BUDGET_MS),
			retainTimeoutMs: positiveIntOr(env.HINDSIGHT_RETAIN_TIMEOUT_MS, DEFAULT_RETAIN_TIMEOUT_MS),
		},
		retainOutbox: {
			path: env.SUBSTRATE_RETAIN_OUTBOX_PATH?.trim() || null,
			max: positiveIntOr(env.SUBSTRATE_RETAIN_OUTBOX_MAX, DEFAULT_RETAIN_OUTBOX_MAX),
			maxAttempts: positiveIntOr(env.SUBSTRATE_RETAIN_MAX_ATTEMPTS, DEFAULT_RETAIN_MAX_ATTEMPTS),
			drainMs: positiveIntOr(env.SUBSTRATE_RETAIN_DRAIN_MS, DEFAULT_RETAIN_DRAIN_MS),
		},
		hindsightEnv: {
			legacyBankSet: (env.HINDSIGHT_BANK?.trim() ?? "") !== "",
			urlSet: (env.HINDSIGHT_URL?.trim() ?? "") !== "",
			banksSet: (env.HINDSIGHT_BANKS?.trim() ?? "") !== "",
		},
		// uplift-2 R6
		docsPruneSuperseded: (env.SUBSTRATE_DOCS_PRUNE_SUPERSEDED?.trim() ?? "") === "1",
		docsRetrieval: {
			similarityThreshold: unitIntervalOr(env.SUBSTRATE_DOCS_SIMILARITY_THRESHOLD, DEFAULT_RETRIEVAL_KNOBS.similarityThreshold),
			vectorSimilarityWeight: unitIntervalOr(env.SUBSTRATE_DOCS_VECTOR_WEIGHT, DEFAULT_RETRIEVAL_KNOBS.vectorSimilarityWeight),
			topK: positiveOr(env.SUBSTRATE_DOCS_TOP_K, DEFAULT_RETRIEVAL_KNOBS.topK),
		},
	};
}

/** uplift-2 R1: a finite number ≥ 0, floored (0 is "off"); anything else is the default. */
function nonNegativeOr(raw: string | undefined, fallback: number): number {
	const value = Number(raw?.trim());
	return raw !== undefined && raw.trim() !== "" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/** uplift-2 R1: a finite number > 0, floored; anything else (0 included) is the default. */
function positiveOr(raw: string | undefined, fallback: number): number {
	const value = Number(raw?.trim());
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** uplift-2 R6: a finite number in [0, 1]; anything else is the default. */
function unitIntervalOr(raw: string | undefined, fallback: number): number {
	const value = Number(raw?.trim());
	return raw !== undefined && raw.trim() !== "" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

/**
 * Whether a Redis URL may enable the cache (DOCS-06).
 *
 * A plaintext `redis://` URL whose host is not loopback is refused: a
 * credential crossing any other network in the clear is the failure this
 * exists to prevent. Loopback and `rediss://` stay allowed; anything else —
 * including an unparseable URL, which the client reports at connect time —
 * passes through to the existing fail-open runtime.
 */
export function parseRedisUrl(raw: string | undefined): { kind: "unset" } | { kind: "ok"; url: string } | { kind: "refused"; reason: string } {
	const trimmed = raw?.trim();
	if (!trimmed) return { kind: "unset" };
	let scheme = "";
	let host = "";
	try {
		const parsed = new URL(trimmed);
		scheme = parsed.protocol.toLowerCase();
		// The URL parser keeps IPv6 brackets on the hostname; strip them so the
		// loopback check sees the address.
		host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
	} catch {
		return { kind: "ok", url: trimmed };
	}
	if (scheme === "redis:") {
		// An actual loopback address, not a DNS name that starts with one:
		// `127.cache.example.com` must not pass as `127.0.0.1` does.
		const octets = host.split(".");
		const loopbackV4 =
			octets.length === 4 &&
			octets[0] === "127" &&
			octets.slice(1).every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
		const loopback = host === "localhost" || host === "::1" || host === "0.0.0.0" || loopbackV4;
		if (!loopback) {
			return { kind: "refused", reason: `refusing plaintext redis:// to non-loopback host ${host || "(empty)"}` };
		}
	}
	return { kind: "ok", url: trimmed };
}

/**
 * `SUBSTRATE_CACHE=0` (also `false` / `no`) disables the cache. Any other value,
 * including unset, leaves it on when `DRAGONFLY_URL` is set. A typo must not
 * silently disable a cache the operator configured.
 */
function cacheSettings(env: Record<string, string | undefined>): {
	dragonflyUrl: string | undefined;
	cacheEnabled: boolean;
	dragonflyRefused: string | null;
} {
	const parsed = parseRedisUrl(env.DRAGONFLY_URL);
	const off = /^(0|false|no)$/i.test(env.SUBSTRATE_CACHE?.trim() ?? "");
	if (parsed.kind === "refused") return { dragonflyUrl: undefined, cacheEnabled: false, dragonflyRefused: parsed.reason };
	const dragonflyUrl = parsed.kind === "ok" ? parsed.url : undefined;
	return { dragonflyUrl, cacheEnabled: dragonflyUrl !== undefined && !off, dragonflyRefused: null };
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
	// Before the operator-tokens early return: an invalid library must be heard on every deployment.
	// Named by key, never by value: the warning goes to a log.
	if (config.skills.problem) {
		warnings.push(`skill proposals are refused until the skills library is fixed: ${config.skills.problem}`);
	}
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

/**
 * Desktop allowlist and directory problems, reported at boot.
 *
 * A sibling of `configWarnings`, not part of it: `configWarnings` returns
 * early without operator tokens, and an empty allowlist is the fail-closed
 * default (nobody may call `desktop_run`), not a misconfiguration — so an
 * empty or fully valid allowlist warns nothing. A dropped allowlist name or a
 * relative directory is an operator typo that silently narrows or misplaces
 * the gate, and the operator should hear about it at boot.
 *
 * Named by surface, never by token: the warning goes to a log.
 */
export function desktopConfigWarnings(config: SubstrateConfig): string[] {
	const warnings: string[] = [];
	if (config.desktopIgnored.length > 0) {
		warnings.push(
			`SUBSTRATE_DESKTOP_SURFACES names unknown surface${config.desktopIgnored.length === 1 ? "" : "s"} ` +
				`(${config.desktopIgnored.join(", ")}); ${config.desktopIgnored.length === 1 ? "it was" : "they were"} dropped, ` +
				"so nobody on those names may call desktop_run",
		);
	}
	if (config.desktopDirRejected !== null) {
		warnings.push(
			`SUBSTRATE_DESKTOP_DIR (${config.desktopDirRejected}) is not absolute; ` +
				`using the default ${DEFAULT_DESKTOP_DIR}`,
		);
	}
	return warnings;
}

// uplift-2 R5 — GreptimeDB ledger settings

/** The knobs behind `SUBSTRATE_LEDGER_*` (uplift-2 R5). */
export interface LedgerSettings {
	/** Remember each session's chain tip after one read; `SUBSTRATE_LEDGER_CHAIN_CACHE=0` restores one read per emit. */
	chainCache: boolean;
	/** Sessions whose tip is remembered at once; the least recently used is dropped past this. */
	chainCacheMax: number;
	/** How far back in `ts` the one chain-tip read looks before it falls back to the whole session. */
	chainLookbackDays: number;
	/** Seconds between `/healthz` write probes; 0 never probes, and writability is metadata only. */
	writeProbeS: number;
	/** Retention to apply to `agent_events` and `event_ingest` at boot; `null` alters nothing. */
	ttl: string | null;
	// uplift-3 N6
	/** Uncovered eligible hours `substrate ledger coverage` tolerates before exiting 2 (`SUBSTRATE_LEDGER_MAX_UNCOVERED_HOURS`, default 2). */
	maxUncoveredHours: number;
	/** Where `substrate ledger archive` writes when `--out` is omitted (`SUBSTRATE_LEDGER_ARCHIVE_DIR`); `null` means the command needs `--out`. */
	archiveDir: string | null;
}

export const DEFAULT_LEDGER_SETTINGS: LedgerSettings = {
	chainCache: true,
	chainCacheMax: 10_000,
	chainLookbackDays: 30,
	writeProbeS: 60,
	ttl: null,
	maxUncoveredHours: 2,
	archiveDir: null,
};

/**
 * Whether a string is a GreptimeDB time duration (reference, "Time Durations"):
 * one or more `<integer><unit>` spans, units case-insensitive, singular or plural,
 * spaces between spans allowed — `180d`, `4320h`, `1h 30m`. Decimals, signs and
 * hex are not. `forever` and `instant` are legal TTLs too but are not retention
 * policies, so they are refused here: unset means "leave the table alone".
 */
export function isGreptimeDuration(value: string): boolean {
	// Suffixes are case-insensitive per the reference, so `M` (months) is also
	// reached through the `m` alternative; the alternation lists long forms first
	// so `ms` is not read as `m` + a stray `s`.
	return /^(?:\d+(?:nsec|ns|usec|us|msec|ms|seconds|second|sec|s|minutes|minute|min|m|hours|hour|hr|h|days|day|d|weeks|week|w|months|month|years|year|y)\s*)+$/i.test(
		value,
	);
}

/** A whole number inside `[min, max]`, or `fallback` for anything else. */
function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
	const n = Number(raw?.trim());
	if (raw === undefined || raw.trim() === "" || !Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * `SUBSTRATE_LEDGER_*` as the client reads them. Out-of-range numbers clamp,
 * unparseable ones fall back — like the breaker settings — except the TTL: a
 * retention that is set but is not a Greptime duration would never be applied
 * and the operator would believe it was, so it refuses to boot with the reason.
 */
export function loadLedgerSettings(env: Record<string, string | undefined> = process.env): LedgerSettings {
	const ttlRaw = env.SUBSTRATE_LEDGER_TTL?.trim() ?? "";
	if (ttlRaw !== "" && !isGreptimeDuration(ttlRaw)) {
		throw new ConfigError(
			`SUBSTRATE_LEDGER_TTL=${JSON.stringify(ttlRaw)} is not a GreptimeDB time duration; use spans like 180d, 4320h or 1h30m ` +
				"(integer + unit, no decimals), or unset it to leave the tables' retention unchanged",
		);
	}
	return {
		chainCache: !/^(0|false|no)$/i.test(env.SUBSTRATE_LEDGER_CHAIN_CACHE?.trim() ?? ""),
		chainCacheMax: boundedInt(env.SUBSTRATE_LEDGER_CHAIN_CACHE_MAX, DEFAULT_LEDGER_SETTINGS.chainCacheMax, 1, 1_000_000),
		chainLookbackDays: boundedInt(env.SUBSTRATE_LEDGER_CHAIN_LOOKBACK_DAYS, DEFAULT_LEDGER_SETTINGS.chainLookbackDays, 1, 3650),
		writeProbeS: boundedInt(env.SUBSTRATE_LEDGER_WRITE_PROBE_S, DEFAULT_LEDGER_SETTINGS.writeProbeS, 0, 86_400),
		ttl: ttlRaw === "" ? null : ttlRaw,
		// uplift-3 N6: the archive dir is a path, taken as given; the archive command
		// itself refuses the repo, the release root and a filesystem below the floor.
		maxUncoveredHours: boundedInt(env.SUBSTRATE_LEDGER_MAX_UNCOVERED_HOURS, DEFAULT_LEDGER_SETTINGS.maxUncoveredHours, 0, 100_000),
		archiveDir: env.SUBSTRATE_LEDGER_ARCHIVE_DIR?.trim() ? env.SUBSTRATE_LEDGER_ARCHIVE_DIR.trim() : null,
	};
}

// uplift-2 R3
/** `memory_search`'s recall leg: shorter than the tool's own budget, so a slow plane never holds a search past it. */
export const DEFAULT_SEARCH_RECALL_BUDGET_MS = 1500;
/** The retain POST bound, the plane client's own default made a config field. */
export const DEFAULT_RETAIN_TIMEOUT_MS = 8000;

/** A positive decimal integer, or the fallback: a typo must never crash-loop the service or zero a budget. */
function positiveIntOr(raw: string | undefined, fallback: number): number {
	const trimmed = raw?.trim() ?? "";
	if (!/^\d+$/.test(trimmed)) return fallback;
	const value = Number(trimmed);
	return value > 0 ? value : fallback;
}

/**
 * Hindsight routing keys that do not do what their presence suggests,
 * reported at boot (uplift-2 R3). A sibling of `desktopConfigWarnings`, not
 * part of `configWarnings` (which returns early without operator tokens).
 *
 * `HINDSIGHT_BANK` is the single-bank shape of the acc30a8 stub: nothing reads
 * it, so an operator who set it believes recall is configured when it is
 * not. A URL with no `HINDSIGHT_BANKS` is valid — recall reads the caller's
 * own bank only — but it is usually not what was meant for a fan-out.
 * Named by key, never by value: the warnings go to a log.
 */
export function hindsightConfigWarnings(config: SubstrateConfig): string[] {
	const warnings: string[] = [];
	if (config.hindsightEnv.legacyBankSet) {
		warnings.push("HINDSIGHT_BANK is set but legacy and unread; recall fans out over HINDSIGHT_BANKS (sub-* names), so set that instead");
	}
	if (config.hindsightEnv.urlSet && !config.hindsightEnv.banksSet) {
		warnings.push("HINDSIGHT_URL is set but HINDSIGHT_BANKS is empty, so recall reads the caller's own bank only; list the sub-* banks to fan out");
	}
	return warnings;
}
