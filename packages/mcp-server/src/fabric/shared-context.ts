/**
 * E2 (phase 82) Dragonfly shared-context cache for CLI Agents and Grok Bot.
 *
 * One namespaced lane on the existing `ReadThroughCache` — no second Redis
 * client, no second connection. Keys are `substrate:v1:shared:<agent>:<graph>:<kind>:<stable-key>`, where `agent` is one of `herdr | claude-code | grok | reminiscent`, `graph` is the Graph ID the entry belongs to (`"-"` is the agent-global spelling), `kind` is `context | output | recall`, and `stable-key` is a caller-chosen stable segment (or `stableSharedKey(args)` for callers holding arguments). `classOf()` names every such key `"shared"`, so the lane rides the existing `substrate.cache.operations{class}` metric and `scripts/cache-stats.ts` accounting.
 *
 * The fallback is the durability contract: the gate `unavailable`/`unconfigured`, a cache that is off, or an expired key all answer the caller's durable `load()` — stale is never served, and the bypass is counted where the read was refused. The gate is DG-1b (`dragonflyGateVerdict`, `dragonfly-readiness.ts`): `off` behaves exactly as today, `enforce` serves nothing the gate does not allow except `degraded`, which still serves. A claim is an advisory single-writer election over the slot's `:claim` key — one Lua round trip through the `eval` seam, `1` is won and `0` is lost. A caller that loses still answers from its own durable load and writes nothing, so correctness never depends on winning.
 */
import { createHash } from "node:crypto";
import { CACHE_PREFIX, canonical, type CacheHealth, type ReadThroughCache } from "../cache.ts";

/** `substrate:v1:shared:` — every shared-lane key starts here. */
export const SHARED_PREFIX = `${CACHE_PREFIX}:shared:`;

/** The agents a shared entry may belong to. */
export const SHARED_AGENTS = ["herdr", "claude-code", "grok", "reminiscent"] as const;
export type SharedAgent = (typeof SHARED_AGENTS)[number];

/** What a shared entry is: session/worktree context, recent output, or a hot-retrieval result. */
export const SHARED_KINDS = ["context", "output", "recall"] as const;
export type SharedKind = (typeof SHARED_KINDS)[number];

/**
 * Seconds a shared entry lives, per kind: output 60, context 300, recall 600. Every shared write and every claim slot carries its kind's TTL; `CACHE_TTL.shared` (300) is only the class ceiling, never the TTL a write uses.
 */
export const SHARED_KIND_TTL = { output: 60, context: 300, recall: 600 } as const;

/** The TTL in seconds a write or claim for `kind` uses. */
export function sharedTtlS(kind: SharedKind): number {
	return SHARED_KIND_TTL[kind];
}

/** What one claim attempt answered. `bypass` is the no-command answer: the caller still answers from its durable load. */
export type SharedClaimOutcome = "won" | "lost" | "bypass";

/** A `graph` or `stable-key` segment: no `:`, which is the separator. */
const SEGMENT = /^[A-Za-z0-9._-]+$/;

function checkSegment(value: string, what: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 512 || !SEGMENT.test(value)) {
		throw new TypeError(`shared ${what} must be 1-512 chars of [A-Za-z0-9._-]`);
	}
	return value;
}

function checkAgent(agent: string): SharedAgent {
	if (!(SHARED_AGENTS as readonly string[]).includes(agent)) {
		throw new TypeError(`shared agent must be one of ${SHARED_AGENTS.join("|")}`);
	}
	return agent as SharedAgent;
}

function checkKind(kind: string): SharedKind {
	if (!(SHARED_KINDS as readonly string[]).includes(kind)) {
		throw new TypeError(`shared kind must be one of ${SHARED_KINDS.join("|")}`);
	}
	return kind as SharedKind;
}

/**
 * `substrate:v1:shared:<agent>:<graph>:<kind>:<stable-key>`. Both scopes are always present; `"-"` is the agent-global graph spelling. An invalid segment throws `TypeError` — a programmer error, never a runtime fallback.
 */
export function sharedKey(agent: SharedAgent, graph: string, kind: SharedKind, stableKey: string): string {
	return `${SHARED_PREFIX}${checkAgent(agent)}:${checkSegment(graph, "graph")}:${checkKind(kind)}:${checkSegment(stableKey, "stable key")}`;
}

/** The exact inverse of `sharedKey`, or null for anything that is not a shared-lane key. */
export function parseSharedKey(key: string): { agent: SharedAgent; graph: string; kind: SharedKind; stableKey: string } | null {
	if (typeof key !== "string" || !key.startsWith(SHARED_PREFIX)) return null;
	const parts = key.slice(SHARED_PREFIX.length).split(":");
	if (parts.length !== 4) return null;
	const [agent, graph, kind, stableKey] = parts as [string, string, string, string];
	if (!(SHARED_AGENTS as readonly string[]).includes(agent)) return null;
	if (!(SHARED_KINDS as readonly string[]).includes(kind)) return null;
	if (!SEGMENT.test(graph) || !SEGMENT.test(stableKey)) return null;
	return { agent: agent as SharedAgent, graph, kind: kind as SharedKind, stableKey };
}

/** A stable key for callers holding arguments instead of a key: hex `sha256(canonical(args))`, whatever order the fields were written in. */
export function stableSharedKey(args: unknown): string {
	return createHash("sha256").update(canonical(args)).digest("hex");
}

/** The claim slot for a shared value key: the value lives on the key itself, the claim (a bare claimId) on the key plus `:claim`. */
export function sharedClaimKey(key: string): string {
	return `${key}:claim`;
}

/** What the store reports: the cache's own counters (hits, misses, bypasses, errors — all under class `"shared"`) plus the claim counters no cache method counts. */
export interface SharedContextHealth extends CacheHealth {
	claimsWon: number;
	claimsLost: number;
	claimBypasses: number;
}

/**
 * E2 shared-context store over one `ReadThroughCache`. Reads, writes and claims go through the cache's own gate, deadline and counters; the store adds the namespace, the per-kind TTL and the claim election. No method throws except the key/claimId `TypeError`s — every other failure is a durable load or a `false`/`null`/`"bypass"`.
 */
export class SharedContextStore {
	private readonly cache: ReadThroughCache;
	private claimsWon = 0;
	private claimsLost = 0;
	private claimBypasses = 0;

	/**
	 * One store over one read-through cache. The cache is the single owner of the gate (`ReadThroughCache.gateAllows`, wired from `SUBSTRATE_DRAGONFLY_GATE` by `createReadThroughCache`): the store reads it for its write-skip and claim decisions and has no gate of its own, so the two can never disagree.
	 */
	constructor(cache: ReadThroughCache) {
		this.cache = cache;
	}


	/**
	 * The cached value for this shared key, or null: the shared-lane `peek`. Null covers cache off, a blocked gate, a miss or an expired key, a malformed value and a failed command — the caller composes live from its durable source. Hits, misses, bypasses and errors are counted by the cache under class `"shared"`.
	 */
	async get<T>(request: { agent: SharedAgent; graph: string; kind: SharedKind; stableKey: string }): Promise<T | null> {
		return this.cache.getShared<T>(sharedKey(request.agent, request.graph, request.kind, request.stableKey));
	}

	/**
	 * Write one shared entry with its kind's TTL. False means nothing was stored (cache off, bad shape, failed command); the caller already has its answer, so this never throws. Writes are not gate-blocked (DG-1b leaves the write path for the probe): an entry written under a blocked gate is never read back until the gate allows.
	 */
	async put(request: { agent: SharedAgent; graph: string; kind: SharedKind; stableKey: string; value: unknown }): Promise<boolean> {
		return this.cache.putShared(sharedKey(request.agent, request.graph, request.kind, request.stableKey), request.value, sharedTtlS(request.kind));
	}

	/**
	 * Get-or-load. A hit is the shared value. Every other case — cache off, gate blocked, miss, expired key, malformed value, failed command — answers `load()` (the durable read, never stale) and, when the gate allows serving, stores the loaded value with its kind's TTL. A gate-blocked load is not stored: the write would be invisible until the gate allows, and skipping it matches the read-through cache's own blocked path.
	 */
	async getOrLoad<T>(request: {
		agent: SharedAgent;
		graph: string;
		kind: SharedKind;
		stableKey: string;
		load: () => Promise<T>;
	}): Promise<T> {
		const key = sharedKey(request.agent, request.graph, request.kind, request.stableKey);
		const hit = await this.cache.getShared<T>(key);
		if (hit !== null) return hit;
		const value = await request.load();
		// The write is skipped while the gate blocks serving: the read above already counted that bypass, and an entry written under the block would be invisible until the gate allows — skipping it matches the read-through cache's own blocked path.
		if (this.cache.gateAllows()) await this.cache.putShared(key, value, sharedTtlS(request.kind));
		return value;
	}

	/**
	 * Claim the slot for one shared key: one Lua round trip through the `eval` seam. `"won"` — this caller owns the slot; `"lost"` — another caller already holds it, so this caller should answer from its own durable load and write nothing; `"bypass"` — no command could be sent (cache off, gate blocked, no `EVAL`, failed or timed-out script), and this caller answers the same durable way, with the bypass counted in `claimBypasses`. Never throws. `claimId` must be 1-256 chars, else `TypeError`.
	 */
	async claim(request: { agent: SharedAgent; graph: string; kind: SharedKind; stableKey: string; claimId: string }): Promise<SharedClaimOutcome> {
		const { claimId } = request;
		if (typeof claimId !== "string" || claimId.length === 0 || claimId.length > 256) {
			throw new TypeError("shared claimId must be 1-256 chars");
		}
		if (!this.cache.gateAllows()) {
			this.claimBypasses += 1;
			return "bypass";
		}
		const key = sharedKey(request.agent, request.graph, request.kind, request.stableKey);
		const outcome = await this.cache.claimShared(sharedClaimKey(key), claimId, sharedTtlS(request.kind));
		if (outcome === "won") this.claimsWon += 1;
		else if (outcome === "lost") this.claimsLost += 1;
		else this.claimBypasses += 1;
		return outcome;
	}

	health(): SharedContextHealth {
		return { ...this.cache.health(), claimsWon: this.claimsWon, claimsLost: this.claimsLost, claimBypasses: this.claimBypasses };
	}
}

/** One store over one read-through cache (the gate comes from the cache). */
export function createSharedContextStore(cache: ReadThroughCache): SharedContextStore {
	return new SharedContextStore(cache);
}
