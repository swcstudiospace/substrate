/**
 * The Dragonfly presence adapter (phase 52, SOTA-08). One key per session, holding its last heartbeat.
 *
 * Clock: the heartbeat is stamped with the server's own time (`TIME`), never with the host clock, and
 * staleness is judged against that same server time. A caller's `lastHeartbeatMs` is therefore not
 * trusted; the stored value carries the server's reading.
 *
 * Expiry: a key is written with `SET ... EX retentionS`, where the retention is the freshness window plus a margin derived from
 * it (twice the window, between five minutes and a day: `presenceRetentionS`), so the key never lives past two days. The
 * freshness window (`SUBSTRATE_PLANNING_PRESENCE_TTL_S`) is NOT the key expiry. A session whose sign of life is older than the
 * window is still held, so it is listed as `stale` and not dropped. The server removes it only once the retention has closed
 * with no new heartbeat. Every heartbeat, change or liveness, renews the key.
 *
 * Cache-only: this is Dragonfly, so presence is ephemeral by owner decision. Nothing durable lives under these keys: the
 * observer's baseline and every record of truth are kept elsewhere (`baseline-store.ts`, the ledger).
 *
 * Liveness: `touch` is a change heartbeat and stamps both the change time and the liveness with the server's time.
 * `touchLiveness` renews the record without moving the change time, so a session quiet for days stays active while its
 * observer scans, and its `idleForMs` grows.
 *
 * Bounds: enumeration is a bounded SCAN (see `presence-client.ts`). A listing reads at most `limit`
 * sessions. When more exist, `listWithin` says so with `truncated: true`, and `list` refuses instead
 * of returning a partial answer.
 *
 * Also guaranteed:
 * - A key that expires between the enumeration and its read is skipped as gone.
 * - A stored value that does not parse as a session record fails the listing, naming the key and never
 *   the value.
 * - `list` is not an atomic snapshot across keys.
 *
 * The commands go through `PresenceBackend`, a port of its own. The cache client in `cache.ts` is closed
 * to its current command set by `cache-conformance.test.ts`, so presence never reuses it.
 */
import { sharedDeadline } from "../deadline.ts";
import { PLANNING_BOUNDS } from "./config.ts";
import { SessionRecordSchema, type PresenceStore, type SessionRecord } from "./presence.ts";

export const PRESENCE_KEY_PREFIX = "substrate:v1:planning:presence:";
/** The largest freshness window the settings allow, in seconds. Taken from the same bounds `loadPlanningSettings` enforces. */
export const PRESENCE_TTL_MAX_S = PLANNING_BOUNDS.presenceTtlS.max;
/** How a key's lifetime is derived from the freshness window. The margin is twice the window, held between these bounds, in seconds. */
export const PRESENCE_MARGIN_FACTOR = 2;
export const PRESENCE_MARGIN_MIN_S = 300;
export const PRESENCE_MARGIN_MAX_S = 86_400;
/** The longest a presence key lives, in seconds: the largest freshness window plus the largest margin. */
export const PRESENCE_RETENTION_MAX_S = PRESENCE_TTL_MAX_S + PRESENCE_MARGIN_MAX_S;

/** How long a key outlives its freshness window of `ttlS` seconds: `PRESENCE_MARGIN_FACTOR` windows, between the bounds above. */
export function presenceMarginS(ttlS: number): number {
	return Math.min(PRESENCE_MARGIN_MAX_S, Math.max(PRESENCE_MARGIN_MIN_S, Math.ceil(ttlS * PRESENCE_MARGIN_FACTOR)));
}

/**
 * Server-side key expiry for a freshness window of `ttlMs`, in whole seconds: the window rounded up plus its margin. Stale sessions
 * stay listed until it closes. It is always at most `PRESENCE_RETENTION_MAX_S`. A window that is not positive and finite, or is
 * longer than the settings allow, is refused: a longer one would leave no margin under the bounded key lifetime.
 */
export function presenceRetentionS(ttlMs: number): number {
	if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError("ttlMs must be a positive number");
	if (ttlMs > PRESENCE_TTL_MAX_S * 1000) throw new RangeError("ttlMs must not exceed the largest presence freshness window");
	const ttlS = Math.ceil(ttlMs / 1000);
	return ttlS + presenceMarginS(ttlS);
}

/** The most sessions one listing reads. Beyond it the listing is marked truncated. */
export const PRESENCE_MAX_SESSIONS = 256;
/** The most time one listing may take, in milliseconds. Each command has its own reply deadline; this bounds the listing as a whole. */
export const PRESENCE_LISTING_BUDGET_MS = 5_000;

/** Each call takes an optional `signal`: an aborted signal stops the call before any command is sent. */
export interface PresenceBackend {
	get(key: string, signal?: AbortSignal): Promise<string | null>;
	/** `SET key value EX ttlSeconds`. */
	setWithTtl(key: string, value: string, ttlSeconds: number): Promise<void>;
	/** Up to `limit` keys under `prefix`. `truncated` is true when the walk stopped at `limit` or before the keyspace was covered. */
	scanPrefix(prefix: string, limit: number, signal?: AbortSignal): Promise<{ keys: string[]; truncated: boolean }>;
	/** The server's clock, in milliseconds since the epoch. */
	serverTimeMs(): Promise<number>;
}

export interface PresenceListing {
	records: SessionRecord[];
	/** True when the listing stopped before every session was read. The records returned are still exact. */
	truncated: boolean;
}

export class DragonflyPresenceStore implements PresenceStore {
	constructor(private readonly backend: PresenceBackend) {}

	/**
	 * Records a change heartbeat stamped with the server's time. `ttlMs` is the freshness window. The key outlives it by a margin
	 * derived from the window (`presenceRetentionS`), so a session that goes stale stays listed for a while. The server's time is
	 * both the change time and the liveness time, so the stored record carries no `livenessMs` of its own.
	 */
	async touch(record: SessionRecord, ttlMs: number): Promise<void> {
		const valid = SessionRecordSchema.parse(record);
		const retentionS = presenceRetentionS(ttlMs);
		const stamped: SessionRecord = { ...valid, lastHeartbeatMs: await this.backend.serverTimeMs() };
		delete stamped.livenessMs;
		await this.backend.setWithTtl(keyFor(valid.sessionId), JSON.stringify(stamped), retentionS);
	}

	/**
	 * Records a liveness heartbeat: the checkout was scanned and is alive. The record is rewritten with the caller's report,
	 * repository and touched pairs, `livenessMs` set to the server's time, and `lastHeartbeatMs` (the last planning change) kept as
	 * the key held it. A key that is absent, expired or does not parse has no change time to keep, so the server's time stands in
	 * for it: the session reads as idle from its first sighting. Overwriting an unparseable value is deliberate: nothing this store
	 * wrote can be unparseable, and the value would otherwise fail every listing.
	 *
	 * The observer is the only writer of a session's key and runs one write at a time, so this read-then-write needs no lock.
	 * The key's lifetime is renewed exactly as a change heartbeat renews it.
	 */
	async touchLiveness(record: SessionRecord, ttlMs: number): Promise<void> {
		const valid = SessionRecordSchema.parse(record);
		const retentionS = presenceRetentionS(ttlMs);
		const key = keyFor(valid.sessionId);
		const nowMs = await this.backend.serverTimeMs();
		const held = await this.backend.get(key);
		const stamped: SessionRecord = { ...valid, lastHeartbeatMs: heldChangeTime(held) ?? nowMs, livenessMs: nowMs };
		await this.backend.setWithTtl(key, JSON.stringify(stamped), retentionS);
	}

	/** Every held record, sorted by session id. Refuses, rather than answer partially, when more than the bound exist. */
	async list(): Promise<SessionRecord[]> {
		const listing = await this.listWithin(PRESENCE_MAX_SESSIONS);
		if (listing.truncated) throw new Error(`presence holds more than ${PRESENCE_MAX_SESSIONS} sessions; refusing a partial listing`);
		return listing.records;
	}

	/**
	 * Up to `limit` held records, sorted by session id, with the truncation flag. Stale records are included. The whole listing
	 * must finish within `budgetMs`: a listing that misses it rejects with a `DeadlineError`, and no command is sent after that.
	 * A non-positive budget is no deadline; each command still has its own.
	 */
	async listWithin(limit: number, budgetMs: number = PRESENCE_LISTING_BUDGET_MS): Promise<PresenceListing> {
		if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
		const abandon = new AbortController();
		const deadline = sharedDeadline(budgetMs, "presence listing");
		try {
			return await deadline.race(this.collect(limit, abandon.signal));
		} catch (cause: unknown) {
			abandon.abort();
			throw cause;
		} finally {
			deadline.clear();
		}
	}

	private async collect(limit: number, signal: AbortSignal): Promise<PresenceListing> {
		signal.throwIfAborted();
		const scanned = await this.backend.scanPrefix(PRESENCE_KEY_PREFIX, limit, signal);
		const keys = [...new Set(scanned.keys.filter((key) => key.startsWith(PRESENCE_KEY_PREFIX)))].sort();
		const kept = keys.slice(0, limit);
		const records: SessionRecord[] = [];
		for (const key of kept) {
			signal.throwIfAborted();
			const value = await this.backend.get(key, signal);
			if (value === null) continue;
			records.push(parseStored(key, value));
		}
		return { records, truncated: scanned.truncated || keys.length > limit };
	}

	/** The server's clock. Staleness is measured against this reading. */
	serverNowMs(): Promise<number> {
		return this.backend.serverTimeMs();
	}
}

function keyFor(sessionId: string): string {
	return `${PRESENCE_KEY_PREFIX}${sessionId}`;
}

function parseStored(key: string, value: string): SessionRecord {
	let json: unknown;
	try {
		json = JSON.parse(value);
	} catch {
		throw new Error(`presence record ${key} is not JSON`);
	}
	const parsed = SessionRecordSchema.safeParse(json);
	if (!parsed.success) throw new Error(`presence record ${key} does not match the session schema`);
	return parsed.data;
}

/** The change time a held value carries, or null when there is no value or it is not a session record. A liveness write keeps it. */
function heldChangeTime(value: string | null): number | null {
	if (value === null) return null;
	let json: unknown;
	try {
		json = JSON.parse(value);
	} catch {
		return null;
	}
	const parsed = SessionRecordSchema.safeParse(json);
	return parsed.success ? parsed.data.lastHeartbeatMs : null;
}
