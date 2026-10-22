/**
 * Configuration, loaded from the environment.
 *
 * Deployment reads /etc/substrate/substrate.env via the systemd unit's
 * EnvironmentFile. Nothing here ever reads a secret from the repo.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { SOLANA_CLI_DEFAULT } from "@substrate/ledger";
import { ADMISSION_CLASSES, loadBreakerSettings, type AdmissionClass, type BreakerSettings } from "@substrate/observability";
import { loadBriefProfileConfig, type BriefProfileConfig } from "./brief-profile.ts";
import { ADMISSION_MODES, type AdmissionMode, type AdmissionSettings, type BucketLimit } from "./admission.ts";
import { classifyEndpoint, parseProxyAllow, type DbPlane, type EndpointClass, type ProxyAllow } from "./db-endpoints.ts";
import { DEFAULT_INGEST_ROOTS } from "./docs-ingest.ts";
import { loadInventoryConfig, type InventoryConfig } from "./hindsight-inventory.ts";
import { normalizeTtlSeconds } from "./lease.ts";
import { LEGACY_ENV_KEYS } from "./legacy-env.ts";
import { LINEAR_API_URL } from "./linear.ts";
import { parseGrants, type MemoryGrant } from "./memory-policy.ts";
import { DEFAULT_RECALL_BUDGET_MS } from "./memory-recall.ts";
import { NOTION_API_URL } from "./notion.ts";
import { DEFAULT_RETRIEVAL_KNOBS, ragflowFromEnv, type RagflowConfig, type RetrievalKnobs } from "./planes/ragflow.ts";
import { railwayFromEnv, type RailwayConfig } from "./railway.ts";
import { hindsightBanksFromEnv } from "./planes/hindsight.ts";
import { loadRecallConfig, type RecallConfig } from "./recall-snapshot.ts";
import { loadCheckpointDirectory, loadPlanningSettings, type CheckpointDirectoryResult, type PlanningConfigResult } from "./planning/config.ts";
import { loadSteeringSettings, steeringToolsRegistered, type SteeringConfigResult } from "./planning/steering.ts";
import { steeringAuditTableEnabled } from "./planning/steering-store.ts";
import { DEFAULT_RETAIN_DRAIN_MS, DEFAULT_RETAIN_MAX_ATTEMPTS, DEFAULT_RETAIN_OUTBOX_MAX } from "./retain-outbox.ts";
import { EVENT_IDEMPOTENCY_MODES, MEMORY_EXPIRY_MODES, SURFACES, SWARM_SURFACES, isSwarmSurface, type EventIdempotencyMode, type MemoryExpiryMode, type Surface } from "./types.ts";

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
	/**
	 * Canonical public origin. The process still binds `host` (loopback).
	 * nginx terminates TLS for this name and proxies to the loopback port.
	 */
	publicOrigin: string;
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
	 * A `redis://` or `rediss://` URL to a host that is neither loopback nor listed in
	 * `SUBSTRATE_DB_PROXY_ALLOW` is refused fail-open: the cache stays off, answers come
	 * back uncached, and the reason is logged at boot.
	 * Null when the cache was not refused.
	 */
	dragonflyRefused: string | null;
	/** The endpoint policy, the allow list, and each configured plane's endpoint class (phase 48). */
	dbEndpoints: DbEndpointSettings;
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
	 * The Railway control plane (Phase 45, D45-a).
	 *
	 * Control calls go to the Railway public API with `RAILWAY_API_TOKEN`,
	 * never through the tailnet forwarders. Writes stay refused unless
	 * `SUBSTRATE_RAILWAY_WRITES` is exactly `on` (D45-c). Always present;
	 * an empty token makes every Railway tool refuse or report unconfigured.
	 */
	railway: RailwayConfig;
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
	/**
	 * The local checkout of swcstudiospace/agent-skills (`SUBSTRATE_AGENT_SKILLS_ROOT`, D42-1): an
	 * absolute path, or null. Set, the `agent-skills` merge-trigger ingests each skill's
	 * `<name>/SKILL.md` and `<name>/references/` from it; unset, that trigger is a noop.
	 */
	agentSkillsRoot: string | null;
	/** The relative `SUBSTRATE_AGENT_SKILLS_ROOT` value, refused and carried back for the boot warning; null otherwise. */
	agentSkillsRootRejected: string | null;
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
	 * Skills governance (uplift-5 S5a, `SUBSTRATE_SKILLS_GOVERNANCE`): `off` (the default) leaves
	 * `skills_propose` exactly as it was and writes nothing to the registry; `report` and `enforce`
	 * make `skills_propose` record a `proposed` row (the projector slice reads the mode; `enforce`
	 * is what lets it filter). `skills_approve` and `skills_list` exist in every mode. Anything else
	 * is `off`, named at boot by `skillsGovernanceConfigWarnings`.
	 */
	skillsGovernance: SkillsGovernanceMode;
	/** The unrecognised `SUBSTRATE_SKILLS_GOVERNANCE` value, for the boot warning; null when the key parsed or was unset. */
	skillsGovernanceRejected: string | null;
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
	// uplift-4 S4
	/** Stale-while-revalidate for the brief (`SUBSTRATE_CACHE_SWR=off|shadow|enforce`, default shadow: counts `would_serve_stale`, serves live). */
	cacheSwr: "off" | "shadow" | "enforce";
	/** How old a last-good brief may be and still be served stale, s (`SUBSTRATE_CACHE_SWR_WINDOW_S`, default 30, max 300). */
	cacheSwrWindowS: number;
	/** Pattern-based cache preload (phase 47): `SUBSTRATE_CACHE_PRELOAD` (on | off, default off), `_TOP` (1..20, default 3) and `_S` (10..3600, default 300). See `preload.ts`. */
	cachePreload: CachePreloadSettings;
	// uplift-5 U5-3
	/**
	 * Request-path flags, each defaulting to today's behaviour: `SUBSTRATE_BRIEF_GRAPH_READ=full|lite`,
	 * `SUBSTRATE_CACHE_BUMP_SCOPE=legacy|narrow`, `SUBSTRATE_HEALTHZ_INDEX_CAPACITY_MEMO_S` (0 = unmemoised, at most 300).
	 * `problems` are the boot warnings for a value that was refused or capped (`requestPathConfigWarnings`).
	 */
	requestPath: RequestPathSettings;
	// uplift-2 R5
	/**
	 * Ledger chain cache, chain-tip lookback, write-probe cadence and opt-in TTL,
	 * from `SUBSTRATE_LEDGER_*`. See `docs/greptime-ledger.md`.
	 */
	ledger: LedgerSettings;
	// uplift-4 S2
	/** Index archive directory, SLO age and export bounds, and the opt-in lease-table tune, from `SUBSTRATE_INDEX_ARCHIVE_*` and `SUBSTRATE_INDEX_TUNE`. See `docs/runbooks/index-archive.md`. */
	indexArchive: IndexArchiveSettings;
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
	 * The weight is `SUBSTRATE_DOCS_VECTOR_WEIGHT` when set, else `SUBSTRATE_RAGFLOW_VECTOR_WEIGHT`; junk or out-of-range docs values fall back to that. `rerankId` comes only from `SUBSTRATE_RAGFLOW_RERANK_ID`.
	 */
	docsRetrieval: RetrievalKnobs;
	// uplift-3 N3 — admission budgets
	/**
	 * `SUBSTRATE_BUDGETS` (`off` | `shadow` | `enforce`, default `shadow`) and
	 * the per-class buckets from `SUBSTRATE_BUDGET_<CLASS>_RPS` / `_BURST`, with
	 * per-surface `SUBSTRATE_BUDGET_<SURFACE>_<CLASS>_RPS` / `_BURST` overrides
	 * and the shared `SUBSTRATE_BUDGET_ANONYMOUS_RPS` / `_BURST`. See `admission.ts`.
	 */
	admission: AdmissionSettings;
	/**
	 * One shared deadline for every dataset's retrieval in one `docs_search`,
	 * ms (`SUBSTRATE_DOCS_SEARCH_BUDGET_MS`, default 4000; 0 = no shared
	 * deadline, each retrieval bounded only by its own 4 s call timeout —
	 * uplift-3 N5). A dataset that misses it is degraded alone; the others
	 * still answer.
	 */
	docsSearchBudgetMs: number;
	// uplift-3 N4 — memory lifetime
	/**
	 * What the index's serving reads do with an entry past its `ttl`
	 * (`SUBSTRATE_MEMORY_EXPIRY`): `report` (the default) serves it tagged
	 * `expired` and counts it; `enforce` hides it unless an operator asks, and
	 * lets the sweeper's two `entries-ttl-*` classes delete under `apply`. The
	 * retain forward refuses an expired entry in both modes. Anything else is
	 * `report`, named at boot by `memoryExpiryConfigWarnings`.
	 */
	memoryExpiry: MemoryExpiryMode;
	/** The unrecognised `SUBSTRATE_MEMORY_EXPIRY` value, for the boot warning; null when the key parsed or was unset. */
	memoryExpiryRejected: string | null;
	/**
	 * Which preimage `memory.write` hashes (`SUBSTRATE_HASH_VERSION`). `v1` (the
	 * default, and the value of anything that is not `v2`) is today's object.
	 * `v2` adds `hv` and `tenant` inside the hash only. An unrecognised non-empty
	 * value is named at boot by `hashVersionConfigWarnings`.
	 */
	hashVersion: HashVersion;
	/** The unrecognised `SUBSTRATE_HASH_VERSION` value, for the boot warning; null when the key parsed or was unset. */
	hashVersionRejected: string | null;
	/**
	 * What the index sweep prints about expired memory (`SUBSTRATE_MEMORY_LIFECYCLE`).
	 * `report` (the default) lists candidate ids and document ids and deletes nothing.
	 * `off` skips that read. There is no enforce mode. Anything else is `report`,
	 * named at boot by `memoryLifecycleConfigWarnings`.
	 */
	memoryLifecycle: MemoryLifecycleMode;
	/** The unrecognised `SUBSTRATE_MEMORY_LIFECYCLE` value, for the boot warning; null when the key parsed or was unset. */
	memoryLifecycleRejected: string | null;
	// U5-4a — idempotent event replay
	/**
	 * `SUBSTRATE_EVENT_IDEMPOTENCY`: `off` (the default) ignores an event's `idempotency_key` and the
	 * `x-substrate-replay` header entirely; `accept` stores a valid key and looks it up only for a
	 * replay-marked request; `enforce` looks up every keyed request. Anything else is `off`, named
	 * at boot by `eventIdempotencyConfigWarnings`. `GET /healthz` reports the mode as `idempotency`.
	 */
	eventIdempotency: EventIdempotencyMode;
	/** The unrecognised `SUBSTRATE_EVENT_IDEMPOTENCY` value, for the boot warning; null when the key parsed or was unset. */
	eventIdempotencyRejected: string | null;
	/** `SUBSTRATE_EVENT_BUS` (phase 50, D50-g): the Dragonfly wake-up hints. See `EventBusSettings`. */
	eventBus: EventBusSettings;
	/** `SUBSTRATE_PLANNING_*` (phase 52, SOTA-08): the planning root, presence window and read bounds. See `planning/config.ts`. */
	planning: PlanningConfigResult;
	/** `SUBSTRATE_PLANNING_CHECKPOINT_DIR` (phase 53, SOTA-09): where completion checkpoints are kept durably. Unset keeps them in memory. See `planning/checkpoint-store.ts`. */
	planningCheckpoint: CheckpointDirectoryResult;
	/** `SUBSTRATE_PLANNING_STEERING*` (phase 53, SOTA-09): the steering switch, principal allowlist and rate. See `planning/steering.ts`. */
	steering: SteeringConfigResult;
	/** `SUBSTRATE_PLANNING_STEERING_AUDIT_TABLE` (phase 53, SOTA-09): on lets `migrate()` create `planning_steering_audit`. Off by default. */
	steeringAuditTable: boolean;
	/** Whether the steering tools are registered: the switch is on, or it is malformed and so answered as `misconfigured`. Off registers none. */
	steeringRegistered: boolean;
	// uplift-3 N2 — restart-durable SLO history and notifications
	/**
	 * Where the SLO checkpoint is written and restored from
	 * (`SUBSTRATE_SLO_CHECKPOINT`): an absolute path, or `null` when disabled.
	 * Unset, it is `DEFAULT_SLO_CHECKPOINT_PATH` only when that file's directory
	 * exists on this host — asked of the `directoryExists` probe `loadConfig` is
	 * given, which the entry point supplies and tests do not, so a bare
	 * `loadConfig({})` never reads or writes under `/var/lib`. `off`, `0`, `none`
	 * or a relative value disable it; the relative one is named at boot by
	 * `sloConfigWarnings`, since a typo must not land a checkpoint in the repo.
	 */
	sloCheckpointPath: string | null;
	/** The rejected relative `SUBSTRATE_SLO_CHECKPOINT`, for the boot warning; null otherwise. */
	sloCheckpointRejected: string | null;
	/** Seconds between checkpoint writes (`SUBSTRATE_SLO_CHECKPOINT_S`, default 60); `0` writes only at shutdown. */
	sloCheckpointS: number;
	/**
	 * The transition notifier (`SUBSTRATE_SLO_NOTIFY=1`, default off): every
	 * `intervalS` it judges the catalogue, planes, burn, capacity and breakers,
	 * and a condition held for `sustainS` becomes one `warning` event on the
	 * ledger (and one POST to `webhookUrl` when set). See `slo-notify.ts`.
	 */
	sloNotify: SloNotifySettings;
	/**
	 * The brief profile (uplift-4 S1): `SUBSTRATE_BRIEF_PROFILE` (off | shadow |
	 * enforce, default shadow), `SUBSTRATE_BRIEF_PROFILE_SURFACES` and the three
	 * `SUBSTRATE_BRIEF_COMPACT_*` limits. Parsed by `brief-profile.ts`; its
	 * `warnings` are printed at boot.
	 */
	briefProfile: BriefProfileConfig;
	// uplift-4 S7 — docs freshness SLI and merge-trigger lag
	/**
	 * `SUBSTRATE_DOCS_FRESHNESS_MAX_AGE_H` (default 168; `0` reports freshness
	 * without judging it) and `SUBSTRATE_DOCS_TRIGGER_LAG_MIN` (default 15; `0`
	 * stops recording accepted triggers and detecting lag). `lagCheckS` is
	 * `SUBSTRATE_DOCS_LAG_CHECK_S` (default 60, 15..3600): how often the timer
	 * settles the lag warning, so `/slo` and `/metrics` only read. Report-only:
	 * nothing is refused or deleted, a breach is a `/slo` row and one `warning` event.
	 */
	docsFreshness: { maxAgeHours: number; triggerLagMinutes: number; lagCheckS: number };
	// uplift-4 S6
	/** The durable metrics history (`SUBSTRATE_METRICS_HISTORY*`, default off). See `metrics-history.ts`. */
	metricsHistory: MetricsHistorySettings;
	// uplift-4 S5
	/**
	 * Cross-session recall in the brief: `SUBSTRATE_BRIEF_RECALL` (off | shadow | enforce, default off),
	 * `SUBSTRATE_BRIEF_RECALL_INTERVAL_S`, `_TTL_S` and `_BUDGET_MS`. Parsed by `recall-snapshot.ts`.
	 */
	briefRecall: RecallConfig;
	/** The read-only Hindsight inventory (`SUBSTRATE_HINDSIGHT_INVENTORY=on`, default off). Parsed by `hindsight-inventory.ts`. */
	hindsightInventory: InventoryConfig;
	/** `HINDSIGHT_MENTAL_MODELS`: the models the weekly refresh names (fail-open). Parsed by `loadMentalModelConfig` below. */
	mentalModels: MentalModelSettings;
}

/** The knobs behind `SUBSTRATE_SLO_NOTIFY*` and `SUBSTRATE_SLO_WEBHOOK_URL` (uplift-3 N2). */
export interface SloNotifySettings {
	enabled: boolean;
	/** Seconds between evaluations (`SUBSTRATE_SLO_NOTIFY_S`, default 60, floor 5). */
	intervalS: number;
	/** Seconds a breach or an open breaker must hold before it is announced (`SUBSTRATE_SLO_NOTIFY_SUSTAIN_S`, default 300; 0 announces at once). */
	sustainS: number;
	/** `SUBSTRATE_SLO_WEBHOOK_URL`, an `http(s)` URL given the same payload, or `null`. A URL, never a credential, but never printed either. */
	webhookUrl: string | null;
}

/** Where the SLO checkpoint lives when `SUBSTRATE_SLO_CHECKPOINT` is unset and the state directory exists. */
export const DEFAULT_SLO_CHECKPOINT_PATH = "/var/lib/substrate/slo-checkpoint.json";

/**
 * What `loadConfig` may ask the host. Only the entry point supplies a probe;
 * everything else gets the fail-safe answer, so no test harness discovers a
 * state directory on the machine it runs on.
 */
export interface ConfigProbes {
	directoryExists?: (path: string) => boolean;
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

export function loadConfig(env: Record<string, string | undefined> = process.env, probes: ConfigProbes = {}): SubstrateConfig {
	const greptimeUrl = env.GREPTIME_URL?.trim();
	const dbEndpoints = loadDbEndpointSettings(env);
	const leaseTtl = Number(env.SUBSTRATE_LEASE_TTL_SECONDS);
	const tokens = tokenConfig(env);
	const ragflowRetrieval = loadRagflowRetrievalSettings(env);
	const desktopNames = (env.SUBSTRATE_DESKTOP_SURFACES ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name.length > 0);
	const desktopDirRaw = env.SUBSTRATE_DESKTOP_DIR?.trim() || "";
	const ingestRoots = (env.SUBSTRATE_DOCS_INGEST_ROOTS ?? "")
		.split(",")
		.map((root) => root.trim())
		.filter((root) => root.length > 0);
	const cache = cacheSettings(env, dbEndpoints.allow);
	const cachePreloadRequested = loadCachePreloadSettings(env);
	if (cachePreloadRequested.enabled && !cache.cacheEnabled && cache.dragonflyRefused === null) {
		throw new ConfigError("SUBSTRATE_CACHE_PRELOAD=on needs the cache, which is off: set DRAGONFLY_URL to an accepted URL and leave SUBSTRATE_CACHE unset or not 0, or set SUBSTRATE_CACHE_PRELOAD=off");
	}
	// A refused Dragonfly URL is fail-open in warn mode, and enforce already refused boot in loadDbEndpointSettings. The cache is off, so the preload is skipped, not refused.
	if (cachePreloadRequested.enabled && !cache.cacheEnabled) {
		process.stderr.write("[substrate] SUBSTRATE_CACHE_PRELOAD=on skipped: the cache endpoint is refused, so the cache is off\n");
	}
	const cachePreload = cache.cacheEnabled ? cachePreloadRequested : { ...cachePreloadRequested, enabled: false };
	return {
		...readHandoffKeys(env),
		leaseTtlSeconds: normalizeTtlSeconds(Number.isFinite(leaseTtl) ? leaseTtl : undefined),
		host: env.SUBSTRATE_HOST?.trim() || "127.0.0.1",
		port: Number(env.SUBSTRATE_PORT ?? 7410),
		publicOrigin: (env.SUBSTRATE_PUBLIC_ORIGIN?.trim() || "https://substrate.swcstudio.space").replace(/\/+$/, ""),
		greptime: greptimeUrl
			? {
					url: greptimeUrl.replace(/\/+$/, ""),
					user: env.GREPTIME_USER,
					password: env.GREPTIME_PASSWORD,
					db: env.GREPTIME_DB?.trim() || "public",
				}
			: null,
		postgresUrl: env.SUBSTRATE_PG_URL?.trim() || undefined,
		dbEndpoints,
		...cache,
		linearApiKey: env.LINEAR_API_KEY?.trim() || undefined,
		notionApiKey: env.NOTION_API_KEY?.trim() || undefined,
		notionTaskGraphDataSource: env.NOTION_TASK_GRAPH_DS?.trim() || "be3418f0-d2d8-411b-8677-fa8a95ee63be",
		hermesLinearUrl: (env.HERMES_LINEAR_URL?.trim() || DEFAULT_HERMES_LINEAR_URL).replace(/\/+$/, ""),
		dodGateTimeoutMs: parseDodGateTimeoutMs(env.SUBSTRATE_DOD_GATE_TIMEOUT_MS),
		linearApiUrl: (env.LINEAR_API_URL?.trim() || LINEAR_API_URL).replace(/\/+$/, ""),
		notionApiUrl: (env.NOTION_API_URL?.trim() || NOTION_API_URL).replace(/\/+$/, ""),
		ragflow: ragflowFromEnv(env),
		railway: railwayFromEnv(env),
		docsIngestRoots: ingestRoots.length > 0 ? ingestRoots : [...DEFAULT_INGEST_ROOTS],
		vmGuest: (env.SUBSTRATE_VM_GUEST?.trim() ?? "") === "1",
		docsStateFile: env.SUBSTRATE_DOCS_STATE_FILE?.trim() || null,
		...agentSkillsRootFromEnv(env.SUBSTRATE_AGENT_SKILLS_ROOT),
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
		// uplift-4 S4
		cacheSwr: cacheSwrOr(env.SUBSTRATE_CACHE_SWR),
		cacheSwrWindowS: Math.min(300, positiveOr(env.SUBSTRATE_CACHE_SWR_WINDOW_S, 30)),
		cachePreload,
		// uplift-5 U5-3
		requestPath: loadRequestPathSettings(env),
		// uplift-2 R5
		ledger: loadLedgerSettings(env),
		// uplift-4 S2
		indexArchive: loadIndexArchiveSettings(env),
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
			vectorSimilarityWeight: unitIntervalOr(env.SUBSTRATE_DOCS_VECTOR_WEIGHT, ragflowRetrieval.vectorSimilarityWeight),
			topK: positiveOr(env.SUBSTRATE_DOCS_TOP_K, DEFAULT_RETRIEVAL_KNOBS.topK),
			...(ragflowRetrieval.rerankId !== undefined ? { rerankId: ragflowRetrieval.rerankId } : {}),
		},
		// uplift-3 N3
		admission: loadAdmissionSettings(env),
		// uplift-3 N5
		docsSearchBudgetMs: nonNegativeOr(env.SUBSTRATE_DOCS_SEARCH_BUDGET_MS, 4000),
		// uplift-3 N4
		...memoryExpiryFromEnv(env.SUBSTRATE_MEMORY_EXPIRY),
		...hashVersionFromEnv(env.SUBSTRATE_HASH_VERSION),
		...memoryLifecycleFromEnv(env.SUBSTRATE_MEMORY_LIFECYCLE),
		// uplift-5 S5a
		...skillsGovernanceFromEnv(env.SUBSTRATE_SKILLS_GOVERNANCE),
		// uplift-3 N2
		...sloCheckpointFromEnv(env.SUBSTRATE_SLO_CHECKPOINT, probes),
		sloCheckpointS: boundedInt(env.SUBSTRATE_SLO_CHECKPOINT_S, 60, 0, 86_400),
		sloNotify: {
			enabled: (env.SUBSTRATE_SLO_NOTIFY?.trim() ?? "") === "1",
			intervalS: boundedInt(env.SUBSTRATE_SLO_NOTIFY_S, 60, 5, 86_400),
			sustainS: boundedInt(env.SUBSTRATE_SLO_NOTIFY_SUSTAIN_S, 300, 0, 86_400),
			webhookUrl: /^https?:\/\//i.test(env.SUBSTRATE_SLO_WEBHOOK_URL?.trim() ?? "") ? env.SUBSTRATE_SLO_WEBHOOK_URL!.trim() : null,
		},
		// uplift-4 S1
		briefProfile: loadBriefProfileConfig(env),
		docsFreshness: {
			maxAgeHours: boundedInt(env.SUBSTRATE_DOCS_FRESHNESS_MAX_AGE_H, 168, 0, 8760),
			triggerLagMinutes: boundedInt(env.SUBSTRATE_DOCS_TRIGGER_LAG_MIN, 15, 0, 10_080),
			lagCheckS: boundedInt(env.SUBSTRATE_DOCS_LAG_CHECK_S, 60, 15, 3600),
		},
		// uplift-4 S6
		metricsHistory: loadMetricsHistorySettings(env, greptimeUrl !== undefined && greptimeUrl !== ""),
		// uplift-4 S5
		briefRecall: loadRecallConfig(env),
		hindsightInventory: loadInventoryConfig(env),
		// memory governance: the weekly mental-model refresh
		mentalModels: loadMentalModelConfig(env),
		// U5-4a
		...eventIdempotencyFromEnv(env.SUBSTRATE_EVENT_IDEMPOTENCY),
		// Phase 50 (D50-g): the bus rides the cache endpoint, and is off with a reason when that endpoint is missing or refused.
		eventBus: loadEventBusSettings(env, cache),
		// Phase 52 (SOTA-08): the planning plane's root and limits. Environment only; a bad value is a typed result.
		planning: loadPlanningSettings(env),
		// Phase 53 (SOTA-09): the durable checkpoint directory. Unset keeps checkpoints in memory; a bad value is a typed result.
		planningCheckpoint: loadCheckpointDirectory(env),
		// Phase 53 (SOTA-09): the steering switch, allowlist and rate. Environment only; a bad value is a typed result.
		steering: loadSteeringSettings(env),
		// Phase 53 (SOTA-09): the audit table opt-in. Off creates nothing at boot; on creates it through the gated migration step.
		steeringAuditTable: steeringAuditTableEnabled(env),
		steeringRegistered: steeringToolsRegistered(env),
	};
}

/**
 * uplift-3 N2: the checkpoint path. Unset asks the probe whether the default's
 * directory exists and uses it only then; an explicit `off`/`0`/`none` disables;
 * a relative path disables and is carried back for the boot warning, like
 * `SUBSTRATE_DESKTOP_DIR` — the file must never land in the repo by typo.
 */
function sloCheckpointFromEnv(raw: string | undefined, probes: ConfigProbes): Pick<SubstrateConfig, "sloCheckpointPath" | "sloCheckpointRejected"> {
	const trimmed = raw?.trim() ?? "";
	if (raw === undefined) {
		const directory = DEFAULT_SLO_CHECKPOINT_PATH.slice(0, DEFAULT_SLO_CHECKPOINT_PATH.lastIndexOf("/"));
		return { sloCheckpointPath: probes.directoryExists?.(directory) === true ? DEFAULT_SLO_CHECKPOINT_PATH : null, sloCheckpointRejected: null };
	}
	if (trimmed === "" || /^(off|0|none|false|no)$/i.test(trimmed)) return { sloCheckpointPath: null, sloCheckpointRejected: null };
	if (!trimmed.startsWith("/")) return { sloCheckpointPath: null, sloCheckpointRejected: trimmed };
	return { sloCheckpointPath: trimmed, sloCheckpointRejected: null };
}

/**
 * A relative `SUBSTRATE_SLO_CHECKPOINT`, reported at boot (uplift-3 N2). A
 * sibling of `memoryExpiryConfigWarnings`; the value is a path, never a
 * credential, so the warning may quote it.
 */
export function sloConfigWarnings(config: SubstrateConfig): string[] {
	if (config.sloCheckpointRejected === null) return [];
	return [
		`SUBSTRATE_SLO_CHECKPOINT=${JSON.stringify(config.sloCheckpointRejected)} is not an absolute path; ` +
			"the SLO checkpoint is disabled, so every restart starts the SLO history fresh",
	];
}

/**
 * uplift-3 N4: `report` or `enforce`, case- and space-insensitive; anything else
 * keeps `report` and is carried back for the boot warning. Never `enforce` by
 * accident: a typo must not start hiding memories.
 */
function memoryExpiryFromEnv(raw: string | undefined): Pick<SubstrateConfig, "memoryExpiry" | "memoryExpiryRejected"> {
	const trimmed = raw?.trim() ?? "";
	if (trimmed === "") return { memoryExpiry: "report", memoryExpiryRejected: null };
	const mode = trimmed.toLowerCase();
	if ((MEMORY_EXPIRY_MODES as readonly string[]).includes(mode)) {
		return { memoryExpiry: mode as MemoryExpiryMode, memoryExpiryRejected: null };
	}
	return { memoryExpiry: "report", memoryExpiryRejected: trimmed };
}

/**
 * An unrecognised `SUBSTRATE_MEMORY_EXPIRY`, reported at boot (uplift-3 N4). A
 * sibling of `hindsightConfigWarnings`, not part of `configWarnings` (which
 * returns early without operator tokens). The value is a mode name, never a
 * credential, so the warning may quote it — that is how a typo gets found.
 */
export function memoryExpiryConfigWarnings(config: SubstrateConfig): string[] {
	if (config.memoryExpiryRejected === null) return [];
	return [
		`SUBSTRATE_MEMORY_EXPIRY=${JSON.stringify(config.memoryExpiryRejected)} is neither report nor enforce; ` +
			"running as report, so expired memory entries are still served (tagged `expired`) and nothing is hidden or deleted",
	];
}

export const HASH_VERSIONS = ["v1", "v2"] as const;
export type HashVersion = (typeof HASH_VERSIONS)[number];

/**
 * `v1` or `v2`, case- and space-insensitive. Unset, blank, and anything else
 * are `v1`. Only a non-empty unrecognised value is carried back for the boot
 * warning: a typo must not switch the preimage.
 */
function hashVersionFromEnv(raw: string | undefined): Pick<SubstrateConfig, "hashVersion" | "hashVersionRejected"> {
	const trimmed = raw?.trim() ?? "";
	if (trimmed === "") return { hashVersion: "v1", hashVersionRejected: null };
	const mode = trimmed.toLowerCase();
	if ((HASH_VERSIONS as readonly string[]).includes(mode)) {
		return { hashVersion: mode as HashVersion, hashVersionRejected: null };
	}
	return { hashVersion: "v1", hashVersionRejected: trimmed };
}

/**
 * An unrecognised `SUBSTRATE_HASH_VERSION`, reported at boot. A sibling of
 * `memoryExpiryConfigWarnings`. The value is a mode name, never a credential,
 * so the warning may quote it.
 */
export function hashVersionConfigWarnings(config: SubstrateConfig): string[] {
	if (config.hashVersionRejected === null) return [];
	return [
		`SUBSTRATE_HASH_VERSION=${JSON.stringify(config.hashVersionRejected)} is neither v1 nor v2; ` +
			"running as v1, so memory digests stay today's preimage and nothing already stored changes",
	];
}

export const MEMORY_LIFECYCLE_MODES = ["report", "off"] as const;
export type MemoryLifecycleMode = (typeof MEMORY_LIFECYCLE_MODES)[number];

/**
 * `report` or `off`, case- and space-insensitive. Unset or blank is `report`.
 * Anything else is `report` and is carried back for the boot warning. There is
 * no enforce mode: a typo must not delete.
 */
function memoryLifecycleFromEnv(raw: string | undefined): Pick<SubstrateConfig, "memoryLifecycle" | "memoryLifecycleRejected"> {
	const trimmed = raw?.trim() ?? "";
	if (trimmed === "") return { memoryLifecycle: "report", memoryLifecycleRejected: null };
	const mode = trimmed.toLowerCase();
	if ((MEMORY_LIFECYCLE_MODES as readonly string[]).includes(mode)) {
		return { memoryLifecycle: mode as MemoryLifecycleMode, memoryLifecycleRejected: null };
	}
	return { memoryLifecycle: "report", memoryLifecycleRejected: trimmed };
}

/**
 * An unrecognised `SUBSTRATE_MEMORY_LIFECYCLE`, reported at boot. A sibling of
 * `hashVersionConfigWarnings`. The value is a mode name, never a credential,
 * so the warning may quote it.
 */
export function memoryLifecycleConfigWarnings(config: SubstrateConfig): string[] {
	if (config.memoryLifecycleRejected === null) return [];
	return [
		`SUBSTRATE_MEMORY_LIFECYCLE=${JSON.stringify(config.memoryLifecycleRejected)} is neither report nor off; ` +
			"running as report, so the sweep lists lifecycle candidate ids and document ids and deletes nothing",
	];
}

/**
 * U5-4a: `off`, `accept` or `enforce`, case- and space-insensitive; unset or blank is `off`; anything
 * else is `off` and carried back for the boot warning. Never switched on by a typo: the flag changes
 * what a `POST /events` may be answered with.
 */
function eventIdempotencyFromEnv(raw: string | undefined): Pick<SubstrateConfig, "eventIdempotency" | "eventIdempotencyRejected"> {
	const trimmed = raw?.trim() ?? "";
	if (trimmed === "") return { eventIdempotency: "off", eventIdempotencyRejected: null };
	const mode = trimmed.toLowerCase();
	if ((EVENT_IDEMPOTENCY_MODES as readonly string[]).includes(mode)) {
		return { eventIdempotency: mode as EventIdempotencyMode, eventIdempotencyRejected: null };
	}
	return { eventIdempotency: "off", eventIdempotencyRejected: trimmed };
}

/**
 * An unrecognised `SUBSTRATE_EVENT_IDEMPOTENCY`, reported at boot (U5-4a). A sibling of
 * `memoryExpiryConfigWarnings`; the value is a mode name, never a credential, so the warning may
 * quote it.
 */
export function eventIdempotencyConfigWarnings(config: SubstrateConfig): string[] {
	if (config.eventIdempotencyRejected === null) return [];
	return [
		`SUBSTRATE_EVENT_IDEMPOTENCY=${JSON.stringify(config.eventIdempotencyRejected)} is not off, accept or enforce; ` +
			"running as off, so idempotency_key and the replay marker are ignored and a replayed event is appended again",
	];
}

export const SKILLS_GOVERNANCE_MODES = ["off", "report", "enforce"] as const;
export type SkillsGovernanceMode = (typeof SKILLS_GOVERNANCE_MODES)[number];

/**
 * uplift-5 S5a: `off`, `report` or `enforce`, case- and space-insensitive; anything else keeps
 * `off` and is carried back for the boot warning. Never `enforce` by accident: a typo must not
 * start filtering what the agents receive.
 */
function skillsGovernanceFromEnv(raw: string | undefined): Pick<SubstrateConfig, "skillsGovernance" | "skillsGovernanceRejected"> {
	const trimmed = raw?.trim() ?? "";
	if (trimmed === "") return { skillsGovernance: "off", skillsGovernanceRejected: null };
	const mode = trimmed.toLowerCase();
	if ((SKILLS_GOVERNANCE_MODES as readonly string[]).includes(mode)) {
		return { skillsGovernance: mode as SkillsGovernanceMode, skillsGovernanceRejected: null };
	}
	return { skillsGovernance: "off", skillsGovernanceRejected: trimmed.slice(0, 40) };
}

/**
 * An unrecognised `SUBSTRATE_SKILLS_GOVERNANCE`, reported at boot (uplift-5 S5a). A sibling of
 * `memoryExpiryConfigWarnings`. The value is a mode name, never a credential, so the warning
 * may quote it (bounded to 40 characters).
 */
export function skillsGovernanceConfigWarnings(config: SubstrateConfig): string[] {
	if (config.skillsGovernanceRejected === null) return [];
	return [
		`SUBSTRATE_SKILLS_GOVERNANCE=${JSON.stringify(config.skillsGovernanceRejected)} is not off, report or enforce; ` +
			"running as off, so skills_propose records no registry row and nothing is filtered",
	];
}

/**
 * `SUBSTRATE_AGENT_SKILLS_ROOT` (phase 42, D42-1): an absolute path to a local agent-skills
 * checkout, trimmed; unset or blank is null. A relative value is null and carried back for the
 * boot warning, so a checkout is never read relative to the working directory.
 */
function agentSkillsRootFromEnv(raw: string | undefined): Pick<SubstrateConfig, "agentSkillsRoot" | "agentSkillsRootRejected"> {
	const trimmed = raw?.trim() ?? "";
	if (trimmed === "") return { agentSkillsRoot: null, agentSkillsRootRejected: null };
	if (!trimmed.startsWith("/")) return { agentSkillsRoot: null, agentSkillsRootRejected: trimmed };
	return { agentSkillsRoot: trimmed, agentSkillsRootRejected: null };
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
 * The RAGFlow retrieval settings (D46-a, D46-b). `SUBSTRATE_RAGFLOW_VECTOR_WEIGHT`
 * is a number in [0, 1], default 0.3 (RAGFlow's own). `SUBSTRATE_RAGFLOW_RERANK_ID`
 * names a reranker; unset or blank, no `rerankId` is returned and no `rerank_id`
 * goes on the wire. A non-numeric or out-of-range weight refuses to start.
 */
function loadRagflowRetrievalSettings(env: Record<string, string | undefined>): Pick<RetrievalKnobs, "vectorSimilarityWeight" | "rerankId"> {
	const rawWeight = env.SUBSTRATE_RAGFLOW_VECTOR_WEIGHT?.trim() ?? "";
	const weight = rawWeight === "" ? DEFAULT_RETRIEVAL_KNOBS.vectorSimilarityWeight : Number(rawWeight);
	if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
		throw new ConfigError("SUBSTRATE_RAGFLOW_VECTOR_WEIGHT must be a number in [0, 1]; unset it for RAGFlow's default 0.3");
	}
	const rerankId = env.SUBSTRATE_RAGFLOW_RERANK_ID?.trim() ?? "";
	return { vectorSimilarityWeight: weight, ...(rerankId !== "" ? { rerankId } : {}) };
}

/** uplift-4 S4: `off`, `shadow` or `enforce` (case-insensitive); anything else, unset included, is `shadow`, which only reports. */
function cacheSwrOr(raw: string | undefined): "off" | "shadow" | "enforce" {
	const value = raw?.trim().toLowerCase();
	return value === "off" || value === "enforce" ? value : "shadow";
}

/** `SUBSTRATE_CACHE_PRELOAD*` (phase 47, D47-d): the pattern-based cache preload. Off unless `SUBSTRATE_CACHE_PRELOAD=on`. */
export interface CachePreloadSettings {
	enabled: boolean;
	/** Repos composed per tick (`SUBSTRATE_CACHE_PRELOAD_TOP`, default 3). */
	top: number;
	/** Seconds between ticks (`SUBSTRATE_CACHE_PRELOAD_S`, default 300). */
	intervalS: number;
}

export const DEFAULT_CACHE_PRELOAD_TOP = 3;
export const DEFAULT_CACHE_PRELOAD_S = 300;

/** A whole number in `[min, max]`, or `fallback` when unset. Anything else is a ConfigError naming the variable, so boot refuses it. */
function cacheWholeNumberOr(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
	const trimmed = raw?.trim() ?? "";
	if (trimmed === "") return fallback;
	const value = Number(trimmed);
	if (!/^\d+$/.test(trimmed) || value < min || value > max) {
		throw new ConfigError(`${name}=${JSON.stringify(trimmed)} is not a whole number from ${min} to ${max}; set one in that range or unset it for ${fallback}`);
	}
	return value;
}

/**
 * `SUBSTRATE_CACHE_PRELOAD*` as the preloader reads them. A mode that is not
 * on or off, and a number outside its range, refuse boot with a ConfigError
 * that names the variable: a typo must not leave the preload silently off or
 * on a different cadence.
 */
export function loadCachePreloadSettings(env: Record<string, string | undefined> = process.env): CachePreloadSettings {
	const rawMode = env.SUBSTRATE_CACHE_PRELOAD?.trim().toLowerCase() ?? "";
	if (rawMode !== "" && rawMode !== "on" && rawMode !== "off") {
		throw new ConfigError(`SUBSTRATE_CACHE_PRELOAD=${JSON.stringify(rawMode)} is not on or off; set on or off, or unset it for off`);
	}
	return {
		enabled: rawMode === "on",
		top: cacheWholeNumberOr("SUBSTRATE_CACHE_PRELOAD_TOP", env.SUBSTRATE_CACHE_PRELOAD_TOP, DEFAULT_CACHE_PRELOAD_TOP, 1, 20),
		intervalS: cacheWholeNumberOr("SUBSTRATE_CACHE_PRELOAD_S", env.SUBSTRATE_CACHE_PRELOAD_S, DEFAULT_CACHE_PRELOAD_S, 10, 3600),
	};
}

/**
 * `SUBSTRATE_EVENT_BUS` (phase 50, D50-g): whether the Dragonfly wake-up hints run. `enabled` is what the
 * bus is built from. `offReason` names why an operator's `on` did not turn it on, and is logged once at boot.
 */
export interface EventBusSettings {
	enabled: boolean;
	offReason: string | null;
}

/**
 * `SUBSTRATE_EVENT_BUS=on|off` (case- and space-insensitive; unset is off). Any other value refuses boot,
 * naming the variable. The value is not echoed: it may be a mistyped URL with a credential in it.
 */
export function loadEventBusSettings(
	env: Record<string, string | undefined>,
	cache: { dragonflyUrl: string | undefined; dragonflyRefused: string | null; cacheEnabled: boolean },
): EventBusSettings {
	const rawMode = env.SUBSTRATE_EVENT_BUS?.trim().toLowerCase() ?? "";
	if (rawMode !== "" && rawMode !== "on" && rawMode !== "off") {
		throw new ConfigError("SUBSTRATE_EVENT_BUS is not on or off; set on or off, or unset it for off");
	}
	if (rawMode !== "on") return { enabled: false, offReason: null };
	if (cache.dragonflyRefused !== null) {
		return { enabled: false, offReason: `DRAGONFLY_URL refused by the endpoint policy: ${cache.dragonflyRefused}` };
	}
	if (cache.dragonflyUrl === undefined) return { enabled: false, offReason: "DRAGONFLY_URL is unset" };
	if (!cache.cacheEnabled) return { enabled: false, offReason: "SUBSTRATE_CACHE is 0" };
	return { enabled: true, offReason: null };
}

/** The three uplift-5 U5-3 request-path flags, parsed. */
export interface RequestPathSettings {
	/** `lite` reads the brief's graph with two concurrent statements (nodes only); `full` is `getGraph`. */
	briefGraphRead: "full" | "lite";
	/** `narrow` bumps the recall generation (not memory) after a retain and drops the graph key from briefs. */
	cacheBumpScope: "legacy" | "narrow";
	/** Seconds `/healthz` reuses the index capacity report; 0 = measured on every computed body. */
	healthzIndexCapacityMemoS: number;
	problems: string[];
}

/** The most seconds a capacity report may be reused: a database that grows must show on `/healthz` within five minutes. */
export const MAX_HEALTHZ_INDEX_CAPACITY_MEMO_S = 300;

/**
 * uplift-5 U5-3: an unset or empty flag is the default silently. A value outside the vocabulary
 * keeps the default and is named in `problems`, so a typo never switches a policy on. The memo
 * seconds take a non-negative number; a larger one is capped (named), anything else is 0 (named).
 */
function loadRequestPathSettings(env: Record<string, string | undefined>): RequestPathSettings {
	const problems: string[] = [];
	const choice = <T extends string>(name: string, raw: string | undefined, allowed: readonly [T, T], fallback: T): T => {
		const trimmed = raw?.trim() ?? "";
		if (trimmed === "") return fallback;
		const value = trimmed.toLowerCase();
		if ((allowed as readonly string[]).includes(value)) return value as T;
		problems.push(`${name}=${JSON.stringify(trimmed)} is neither ${allowed[0]} nor ${allowed[1]}; running as ${fallback}`);
		return fallback;
	};
	const briefGraphRead = choice("SUBSTRATE_BRIEF_GRAPH_READ", env.SUBSTRATE_BRIEF_GRAPH_READ, ["full", "lite"], "full");
	const cacheBumpScope = choice("SUBSTRATE_CACHE_BUMP_SCOPE", env.SUBSTRATE_CACHE_BUMP_SCOPE, ["legacy", "narrow"], "legacy");
	let healthzIndexCapacityMemoS = 0;
	const rawMemo = env.SUBSTRATE_HEALTHZ_INDEX_CAPACITY_MEMO_S?.trim() ?? "";
	if (rawMemo !== "") {
		const value = Number(rawMemo);
		if (!Number.isFinite(value) || value < 0) {
			problems.push(`SUBSTRATE_HEALTHZ_INDEX_CAPACITY_MEMO_S=${JSON.stringify(rawMemo)} is not a number of seconds >= 0; the index capacity is measured on every health computation`);
		} else if (value > MAX_HEALTHZ_INDEX_CAPACITY_MEMO_S) {
			healthzIndexCapacityMemoS = MAX_HEALTHZ_INDEX_CAPACITY_MEMO_S;
			problems.push(`SUBSTRATE_HEALTHZ_INDEX_CAPACITY_MEMO_S=${JSON.stringify(rawMemo)} exceeds ${MAX_HEALTHZ_INDEX_CAPACITY_MEMO_S}; capped at ${MAX_HEALTHZ_INDEX_CAPACITY_MEMO_S} s`);
		} else {
			healthzIndexCapacityMemoS = Math.floor(value);
			if (healthzIndexCapacityMemoS !== value) {
				problems.push(`SUBSTRATE_HEALTHZ_INDEX_CAPACITY_MEMO_S=${JSON.stringify(rawMemo)} is not a whole number of seconds; using ${healthzIndexCapacityMemoS} s${healthzIndexCapacityMemoS === 0 ? " (the index capacity is measured on every health computation)" : ""}`);
			}
		}
	}
	return { briefGraphRead, cacheBumpScope, healthzIndexCapacityMemoS, problems };
}

/** The uplift-5 U5-3 flags that were refused or capped, for the boot log. Values are mode names and numbers, never credentials. */
export function requestPathConfigWarnings(config: SubstrateConfig): string[] {
	return [...config.requestPath.problems];
}

/** uplift-3 N3: a finite rate > 0, fractions kept (0.5 rps is one call per 2 s); anything else is the default. */
function positiveRateOr(raw: string | undefined, fallback: number): number {
	const value = Number(raw?.trim());
	return raw !== undefined && raw.trim() !== "" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** uplift-3 N3 defaults, per surface and second: the burst is one second of headroom over the rate. */
export const DEFAULT_BUDGETS: Readonly<Record<AdmissionClass, BucketLimit>> & { readonly anonymous: BucketLimit } = {
	read: { rps: 20, burst: 40 },
	write: { rps: 10, burst: 20 },
	coordination: { rps: 30, burst: 60 },
	anonymous: { rps: 2, burst: 4 },
};

/**
 * uplift-3 N3. The mode defaults to `shadow`: decide and count, never refuse,
 * so the numbers are tuned from the metric before `enforce` makes a wrong one
 * a 429. A per-surface override may set the rate, the burst or both; the half
 * it leaves out is the class default, so `SUBSTRATE_BUDGET_GROK_BOT_READ_RPS=5`
 * alone keeps the read burst of 40.
 */
export function loadAdmissionSettings(env: Record<string, string | undefined>): AdmissionSettings {
	const rawMode = env.SUBSTRATE_BUDGETS?.trim().toLowerCase() ?? "";
	const mode: AdmissionMode = (ADMISSION_MODES as readonly string[]).includes(rawMode) ? (rawMode as AdmissionMode) : "shadow";
	const classes = Object.fromEntries(
		ADMISSION_CLASSES.map((klass) => {
			const name = klass.toUpperCase();
			return [
				klass,
				{
					rps: positiveRateOr(env[`SUBSTRATE_BUDGET_${name}_RPS`], DEFAULT_BUDGETS[klass].rps),
					burst: positiveOr(env[`SUBSTRATE_BUDGET_${name}_BURST`], DEFAULT_BUDGETS[klass].burst),
				},
			];
		}),
	) as Record<AdmissionClass, BucketLimit>;
	const overrides: AdmissionSettings["overrides"] = {};
	for (const surface of SURFACES) {
		// `grok-bot` → `GROK_BOT`, the spelling `SUBSTRATE_TOKEN_*` already uses.
		const spelled = surface.toUpperCase().replace(/-/g, "_");
		for (const klass of ADMISSION_CLASSES) {
			const prefix = `SUBSTRATE_BUDGET_${spelled}_${klass.toUpperCase()}`;
			const rps = env[`${prefix}_RPS`];
			const burst = env[`${prefix}_BURST`];
			if ((rps?.trim() ?? "") === "" && (burst?.trim() ?? "") === "") continue;
			(overrides[surface] ??= {})[klass] = {
				rps: positiveRateOr(rps, classes[klass].rps),
				burst: positiveOr(burst, classes[klass].burst),
			};
		}
	}
	return {
		mode,
		classes,
		anonymous: {
			rps: positiveRateOr(env.SUBSTRATE_BUDGET_ANONYMOUS_RPS, DEFAULT_BUDGETS.anonymous.rps),
			burst: positiveOr(env.SUBSTRATE_BUDGET_ANONYMOUS_BURST, DEFAULT_BUDGETS.anonymous.burst),
		},
		overrides,
	};
}

/**
 * `SUBSTRATE_DB_ENDPOINT_POLICY` (phase 48, D48-b): `warn` or `enforce`, case- and space-insensitive.
 * Unset or blank is `warn`. Anything else is a ConfigError at boot: a typo must not change what a
 * deployment accepts.
 */
export type DbEndpointPolicy = "warn" | "enforce";

/**
 * The data-plane endpoint settings (phase 48). `classes` has an entry only for each plane whose URL
 * is configured. A class names the path to the plane, never the URL.
 */
export interface DbEndpointSettings {
	policy: DbEndpointPolicy;
	allow: ProxyAllow;
	classes: Partial<Record<DbPlane, EndpointClass>>;
}

/** The configured data-plane URLs, in the order the boot names them. */
const DB_PLANE_URL_VARIABLES = [
	["greptime", "GREPTIME_URL"],
	["postgres", "SUBSTRATE_PG_URL"],
	["dragonfly", "DRAGONFLY_URL"],
] as const;

/** The allow list when none is supplied: no proxy entries. */
const NO_PROXY_ALLOW: ProxyAllow = new Set<string>();

function dbEndpointPolicyFrom(raw: string | undefined): DbEndpointPolicy {
	const value = raw?.trim().toLowerCase() ?? "";
	if (value === "") return "warn";
	if (value === "warn" || value === "enforce") return value;
	throw new ConfigError("SUBSTRATE_DB_ENDPOINT_POLICY must be warn or enforce; unset it for warn");
}

function proxyAllowFrom(raw: string | undefined): ProxyAllow {
	try {
		return parseProxyAllow(raw);
	} catch (error) {
		throw new ConfigError(error instanceof Error ? error.message : "SUBSTRATE_DB_PROXY_ALLOW is malformed");
	}
}

/**
 * The endpoint policy, the allow list and each configured plane's class. In `enforce`, a configured
 * `direct` endpoint is a ConfigError naming its variable and the policy, never its URL.
 */
function loadDbEndpointSettings(env: Record<string, string | undefined>): DbEndpointSettings {
	const policy = dbEndpointPolicyFrom(env.SUBSTRATE_DB_ENDPOINT_POLICY);
	const allow = proxyAllowFrom(env.SUBSTRATE_DB_PROXY_ALLOW);
	const classes: Partial<Record<DbPlane, EndpointClass>> = {};
	for (const [plane, variable] of DB_PLANE_URL_VARIABLES) {
		const url = env[variable]?.trim();
		if (!url) continue;
		const endpointClass = classifyEndpoint(plane, url, allow);
		classes[plane] = endpointClass;
		if (policy === "enforce" && endpointClass === "direct") {
			throw new ConfigError(
				`${variable} is a direct endpoint, which SUBSTRATE_DB_ENDPOINT_POLICY=enforce refuses; ` +
					"point it at a loopback forwarder, or list its host:port in SUBSTRATE_DB_PROXY_ALLOW",
			);
		}
	}
	return { policy, allow, classes };
}

/**
 * Whether a Redis URL may enable the cache (DOCS-06, phase 48 D48-c).
 *
 * A `redis://` or `rediss://` URL whose endpoint classifies as `direct` is refused. Loopback (the
 * local end of a forwarder) and a host and port listed in `allow` pass. A refusal is fail-open: the
 * cache stays off. An unparseable URL passes through to the existing fail-open runtime, which
 * reports it at connect time.
 */
export function parseRedisUrl(raw: string | undefined, allow: ProxyAllow = NO_PROXY_ALLOW): { kind: "unset" } | { kind: "ok"; url: string } | { kind: "refused"; reason: string } {
	const trimmed = raw?.trim();
	if (!trimmed) return { kind: "unset" };
	let scheme = "";
	let host = "";
	try {
		const parsed = new URL(trimmed);
		scheme = parsed.protocol.toLowerCase();
		// The URL parser keeps IPv6 brackets on the hostname; strip them so the reason names the address.
		host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
	} catch {
		return { kind: "ok", url: trimmed };
	}
	const redis = scheme === "redis:" || scheme === "rediss:";
	if (redis && classifyEndpoint("dragonfly", trimmed, allow) === "direct") {
		return { kind: "refused", reason: `refusing ${scheme}// to host ${host || "(empty)"}, which is neither loopback nor in SUBSTRATE_DB_PROXY_ALLOW` };
	}
	return { kind: "ok", url: trimmed };
}

/**
 * `SUBSTRATE_CACHE=0` (also `false` / `no`) disables the cache. Any other value,
 * including unset, leaves it on when `DRAGONFLY_URL` is set. A typo must not
 * silently disable a cache the operator configured.
 */
function cacheSettings(env: Record<string, string | undefined>, allow: ProxyAllow): {
	dragonflyUrl: string | undefined;
	cacheEnabled: boolean;
	dragonflyRefused: string | null;
} {
	const parsed = parseRedisUrl(env.DRAGONFLY_URL, allow);
	const off = /^(0|false|no)$/i.test(env.SUBSTRATE_CACHE?.trim() ?? "");
	if (parsed.kind === "refused") return { dragonflyUrl: undefined, cacheEnabled: false, dragonflyRefused: parsed.reason };
	const dragonflyUrl = parsed.kind === "ok" ? parsed.url : undefined;
	return { dragonflyUrl, cacheEnabled: dragonflyUrl !== undefined && !off, dragonflyRefused: null };
}

/**
 * The shortest bearer a token may be. Reviewer tokens shorter than this are dropped;
 * a surface token shorter than this still authenticates but is reported at boot.
 */
const MIN_TOKEN_LENGTH = 16;

/** Comma- or whitespace-separated, so an operator can wrap the line in the env file. */
function readReviewTokens(raw: string | undefined): Set<string> {
	return new Set(
		(raw ?? "")
			.split(/[\s,]+/)
			.map((token) => token.trim())
			// A short string is a placeholder or a typo, not a token, and accepting one
			// would hand reviewer authority to anybody who guessed it.
			.filter((token) => token.length >= MIN_TOKEN_LENGTH),
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

/**
 * The configured token equal to `presented`, or `undefined`.
 *
 * Every configured token is digested and compared before the answer is known: there is
 * no early exit on the first match, so how long a lookup takes says nothing about which
 * configured token, or how much of one, matched. Digests are fixed width, so
 * `timingSafeEqual` never sees a length mismatch. Bearer tokens are compared only here.
 */
function configuredMatch(configured: Iterable<string>, presented: string): string | undefined {
	const digest = createHash("sha256").update(presented).digest();
	let match: string | undefined;
	for (const candidate of configured) {
		if (timingSafeEqual(digest, createHash("sha256").update(candidate).digest())) match = candidate;
	}
	return match;
}

/** Resolve a request's bearer token to the surface it belongs to. */
export function surfaceForToken(config: SubstrateConfig, authorization: string | null): Surface | null {
	const token = bearer(authorization);
	if (token === null) return null;
	const match = configuredMatch(config.tokens.keys(), token);
	return match === undefined ? null : config.tokens.get(match) ?? null;
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
	const match = token === null ? undefined : configuredMatch(config.operatorTokens, token);
	if (match === undefined) return false;
	const named = config.tokens.get(match);
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
	return token !== null && configuredMatch(config.tokens.keys(), token) === undefined;
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
	return trimmed.length > 0 && configuredMatch(config.memoryReviewTokens, trimmed) !== undefined;
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
	// Named by variable and value only, never a credential; before the early return, as the skills warning is.
	if (config.agentSkillsRootRejected !== null) {
		warnings.push(
			`SUBSTRATE_AGENT_SKILLS_ROOT=${JSON.stringify(config.agentSkillsRootRejected)} is not an absolute path; ` +
				"agent-skills is not refreshed from a checkout, and its merge-trigger is a noop",
		);
	}

	// Named by variable, never by token: the warning goes to a log. Such a token still
	// authenticates; enforcing the floor now would refuse tokens already deployed, so it
	// waits for rotation.
	const short = new Set<Surface>();
	for (const [token, surface] of config.tokens) if (token.length < MIN_TOKEN_LENGTH) short.add(surface);
	for (const surface of short) {
		warnings.push(
			`${tokenEnvName(surface)} holds a token shorter than ${MIN_TOKEN_LENGTH} characters; it still authenticates, ` +
				"but rotate it to a longer one",
		);
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
	// The syntax check above admits digits only inside spans, so a total of zero is
	// exactly a value with no non-zero digit.
	if (ttlRaw !== "" && !/[1-9]/.test(ttlRaw)) {
		throw new ConfigError(
			`SUBSTRATE_LEDGER_TTL=${JSON.stringify(ttlRaw)} totals zero, which is not a retention; use spans of at least one unit, ` +
				"like 180d or 1h30m, or unset it to leave the tables' retention unchanged",
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

// uplift-4 S2 — index disaster-recovery archive

/** The knobs behind `SUBSTRATE_INDEX_ARCHIVE_*` and `SUBSTRATE_INDEX_TUNE` (uplift-4 S2). */
export interface IndexArchiveSettings {
	/** Where `substrate index archive` writes when `--out` is omitted (`SUBSTRATE_INDEX_ARCHIVE_DIR`); `null` refuses by name, and the health row is absent. */
	dir: string | null;
	/** Hours the newest archive may be old before `index.archive.age` is breached (`SUBSTRATE_INDEX_ARCHIVE_MAX_AGE_H`); `null` keeps the row report-only. */
	maxAgeHours: number | null;
	/** Seconds one export may run before it is abandoned (`SUBSTRATE_INDEX_ARCHIVE_MAX_SECONDS`, default 900). */
	maxSeconds: number;
	/** Bytes one export may write (`SUBSTRATE_INDEX_ARCHIVE_MAX_BYTES`, default 1 GiB). */
	maxBytes: number;
	/** `SUBSTRATE_INDEX_TUNE=apply` applies the `graph_nodes` storage tune at boot; anything else is `off`. */
	tune: "off" | "apply";
}

export const DEFAULT_INDEX_ARCHIVE_SETTINGS: IndexArchiveSettings = {
	dir: null,
	maxAgeHours: null,
	maxSeconds: 900,
	maxBytes: 1024 * 1024 * 1024,
	tune: "off",
};

/**
 * `SUBSTRATE_INDEX_ARCHIVE_*` as the runner and the health row read them. The
 * directory is a path taken as given (the archive command refuses the repo,
 * the release root, the root filesystem and a disk below the floor); numbers
 * clamp and fall back like the ledger's. An age that is not a positive whole
 * number of hours leaves the SLO row report-only rather than guessing one.
 */
export function loadIndexArchiveSettings(env: Record<string, string | undefined> = process.env): IndexArchiveSettings {
	const dir = env.SUBSTRATE_INDEX_ARCHIVE_DIR?.trim();
	const age = env.SUBSTRATE_INDEX_ARCHIVE_MAX_AGE_H?.trim() ?? "";
	return {
		dir: dir ? dir : null,
		maxAgeHours: /^\d{1,6}$/.test(age) && Number(age) > 0 ? Number(age) : null,
		maxSeconds: boundedInt(env.SUBSTRATE_INDEX_ARCHIVE_MAX_SECONDS, DEFAULT_INDEX_ARCHIVE_SETTINGS.maxSeconds, 10, 86_400),
		maxBytes: boundedInt(env.SUBSTRATE_INDEX_ARCHIVE_MAX_BYTES, DEFAULT_INDEX_ARCHIVE_SETTINGS.maxBytes, 1024 * 1024, 1024 ** 4),
		tune: /^apply$/i.test(env.SUBSTRATE_INDEX_TUNE?.trim() ?? "") ? "apply" : "off",
	};
}

// uplift-4 S6
/** The knobs behind `SUBSTRATE_METRICS_HISTORY*`: a durable, TTL-bounded `metric_samples` table fed from the registry. */
export interface MetricsHistorySettings {
	/** The effective flag: `SUBSTRATE_METRICS_HISTORY=on` AND a configured ledger. Anything else is off, so a typo never starts a writer. */
	enabled: boolean;
	/** Seconds between samples (`SUBSTRATE_METRICS_HISTORY_INTERVAL_S`, default 60, floor 15, ceiling 3600). */
	intervalS: number;
	/** The table's retention as it goes into `CREATE TABLE` (`SUBSTRATE_METRICS_HISTORY_TTL`, whole days, `1d` to `90d`, default `14d`). */
	ttl: string;
	/** The same retention in days, for the readback window cap. */
	ttlDays: number;
	/** Which series tier is sampled and served (`SUBSTRATE_METRICS_HISTORY_SERIES`, `core` | `extended`, default `core`). `core` is the original 11 series, byte-identical. */
	series: MetricsHistorySeriesMode;
	/** What was wrong with a set value, for the boot warning; empty when every value was usable. Names the key, never quotes a value. */
	problems: string[];
}

/** The tiers of the metrics-history allow-list (uplift-5 S6); `extended` is opt-in because the table's volume is unsized. */
export type MetricsHistorySeriesMode = "core" | "extended";

export const DEFAULT_METRICS_HISTORY_TTL = "14d";
export const MIN_METRICS_HISTORY_TTL_DAYS = 1;
export const MAX_METRICS_HISTORY_TTL_DAYS = 90;
export const MIN_METRICS_HISTORY_INTERVAL_S = 15;

/**
 * A metrics-history retention, or `null`. Strictly `<1-3 digits>d` inside the
 * day bounds, because this string is interpolated into a `CREATE TABLE` — no
 * other unit, no spaces, no sign, nothing a Greptime duration parser or an
 * attacker's quote could do anything with. Case-sensitive on purpose.
 */
export function parseMetricsHistoryTtl(raw: string): { ttl: string; days: number } | null {
	const match = /^([1-9][0-9]{0,2})d$/.exec(raw);
	if (match === null) return null;
	const days = Number(match[1]);
	if (days < MIN_METRICS_HISTORY_TTL_DAYS || days > MAX_METRICS_HISTORY_TTL_DAYS) return null;
	return { ttl: `${days}d`, days };
}

/**
 * `SUBSTRATE_METRICS_HISTORY*` as the sampler reads them. Never throws: a bad
 * TTL falls back to the default and is carried back as a problem, because a
 * knob on a best-effort history must not stop the substrate from booting.
 *
 * `enabled` is the ONE effective flag: the switch is `on` AND the event ledger
 * is configured (`ledgerConfigured`). The sampler, the route and the drop
 * counter all read it, so with no ledger none of them exists.
 */
export function loadMetricsHistorySettings(env: Record<string, string | undefined> = process.env, ledgerConfigured = true): MetricsHistorySettings {
	const problems: string[] = [];
	const flag = (env.SUBSTRATE_METRICS_HISTORY?.trim() ?? "").toLowerCase();
	if (flag !== "" && flag !== "on" && flag !== "off") {
		problems.push("SUBSTRATE_METRICS_HISTORY is neither `on` nor `off`, so the metrics history stays off");
	}
	const ttlRaw = env.SUBSTRATE_METRICS_HISTORY_TTL?.trim() ?? "";
	const parsed = ttlRaw === "" ? null : parseMetricsHistoryTtl(ttlRaw);
	if (ttlRaw !== "" && parsed === null) {
		problems.push(
			`SUBSTRATE_METRICS_HISTORY_TTL is not a whole number of days from ${MIN_METRICS_HISTORY_TTL_DAYS}d to ${MAX_METRICS_HISTORY_TTL_DAYS}d (for example 14d), so ${DEFAULT_METRICS_HISTORY_TTL} is used`,
		);
	}
	if (flag === "on" && !ledgerConfigured) {
		problems.push("SUBSTRATE_METRICS_HISTORY=on needs the event ledger, which is not configured, so the metrics history stays off");
	}
	const seriesRaw = (env.SUBSTRATE_METRICS_HISTORY_SERIES?.trim() ?? "").toLowerCase();
	if (seriesRaw !== "" && seriesRaw !== "core" && seriesRaw !== "extended") {
		problems.push("SUBSTRATE_METRICS_HISTORY_SERIES is neither `core` nor `extended`, so the core series are used");
	}
	const retention = parsed ?? parseMetricsHistoryTtl(DEFAULT_METRICS_HISTORY_TTL)!;
	return {
		enabled: flag === "on" && ledgerConfigured,
		intervalS: boundedInt(env.SUBSTRATE_METRICS_HISTORY_INTERVAL_S, 60, MIN_METRICS_HISTORY_INTERVAL_S, 3600),
		ttl: retention.ttl,
		ttlDays: retention.days,
		series: seriesRaw === "extended" ? "extended" : "core",
		problems,
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
		// The sentence lives in legacy-env.ts so the runtime doctor prints the same one.
		for (const key of LEGACY_ENV_KEYS) if (key.name === "HINDSIGHT_BANK") warnings.push(key.hint);
	}
	if (config.hindsightEnv.urlSet && !config.hindsightEnv.banksSet) {
		warnings.push("HINDSIGHT_URL is set but HINDSIGHT_BANKS is empty, so recall reads the caller's own bank only; list the sub-* banks to fan out");
	}
	return warnings;
}

/** The most mental models the weekly refresh names, across every bank. */
export const MAX_MENTAL_MODELS = 20;

/** A mental model the weekly refresh names: the bank it lives in, and its id. */
export interface MentalModelRef {
	bank: string;
	id: string;
}

/** `HINDSIGHT_MENTAL_MODELS` as the refresh reads it. Fail-open: a dropped entry is named in `warnings`, and the rest still apply. */
export interface MentalModelSettings {
	models: MentalModelRef[];
	/** What the parse dropped, for the boot warning. Entries are named by position, never by value. */
	warnings: string[];
}

const MENTAL_MODEL_ID = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * Parse `HINDSIGHT_MENTAL_MODELS`: `<bank>=<id>[,<id>...]` entries separated by `;`.
 * A bank must be one of `HINDSIGHT_BANKS`, and every id must match `MENTAL_MODEL_ID`.
 * An entry that breaks either rule is dropped with a warning, and the valid entries
 * still apply. A repeated model, and any model past `MAX_MENTAL_MODELS`, is dropped
 * the same way. Unset names nothing. Never throws.
 */
export function loadMentalModelConfig(env: Record<string, string | undefined>): MentalModelSettings {
	const models: MentalModelRef[] = [];
	const warnings: string[] = [];
	const raw = env.HINDSIGHT_MENTAL_MODELS?.trim() ?? "";
	if (raw === "") return { models, warnings };
	const banks = new Set(hindsightBanksFromEnv(env) ?? []);
	const seen = new Set<string>();
	for (const [index, segment] of raw.split(";").entries()) {
		const entry = segment.trim();
		if (entry === "") continue;
		const at = `entry ${index + 1}`;
		const eq = entry.indexOf("=");
		const bank = eq < 0 ? "" : entry.slice(0, eq).trim();
		const ids = eq < 0 ? [] : entry.slice(eq + 1).split(",").map((id) => id.trim());
		if (bank === "" || ids.some((id) => !MENTAL_MODEL_ID.test(id))) {
			warnings.push(`HINDSIGHT_MENTAL_MODELS ${at} is not <bank>=<id>[,<id>...] with ids of [A-Za-z0-9_-] up to 80 characters, so it is dropped`);
			continue;
		}
		if (!banks.has(bank)) {
			warnings.push(`HINDSIGHT_MENTAL_MODELS ${at} names a bank that is not in HINDSIGHT_BANKS, so it is dropped`);
			continue;
		}
		for (const id of ids) {
			const key = JSON.stringify([bank, id]);
			if (seen.has(key)) {
				warnings.push(`HINDSIGHT_MENTAL_MODELS ${at} repeats a model already named, so the repeat is dropped`);
				continue;
			}
			if (models.length >= MAX_MENTAL_MODELS) {
				warnings.push(`HINDSIGHT_MENTAL_MODELS ${at} names a model past the ${MAX_MENTAL_MODELS} allowed, so it is dropped`);
				continue;
			}
			seen.add(key);
			models.push({ bank, id });
		}
	}
	return { models, warnings };
}
