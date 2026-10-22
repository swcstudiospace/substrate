/**
 * The Dragonfly presence adapter (phase 52, SOTA-08). One key per session, holding its last heartbeat.
 *
 * Clock: the heartbeat is stamped with the server's own time (`TIME`), never with the host clock, and
 * staleness is judged against that same server time. A caller's `lastHeartbeatMs` is therefore not
 * trusted; the stored value carries the server's reading.
 *
 * Expiry: a key is written with `SET ... EX retentionS`, where the retention is the largest freshness window the settings
 * allow plus a one-hour margin. The freshness window (`SUBSTRATE_PLANNING_PRESENCE_TTL_S`) is NOT the key expiry. A session
 * whose heartbeat is older than the freshness window is still held, so it is listed as `stale` and not dropped. The server
 * removes it only once the retention has closed with no new heartbeat. A freshness window that leaves no margin is refused.
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
import { PLANNING_BOUNDS } from "./config.ts";
import { SessionRecordSchema, type PresenceStore, type SessionRecord } from "./presence.ts";

export const PRESENCE_KEY_PREFIX = "substrate:v1:planning:presence:";
/** The largest freshness window the settings allow, in seconds. Taken from the same bounds `loadPlanningSettings` enforces. */
export const PRESENCE_TTL_MAX_S = PLANNING_BOUNDS.presenceTtlS.max;
/** How long a key outlives its freshness window, in seconds. A session that goes stale stays readable for this long. */
export const PRESENCE_RETENTION_MARGIN_S = 3_600;
/** Server-side key expiry, in seconds: the largest freshness window plus the margin. Stale sessions stay listed until it closes. */
export const PRESENCE_RETENTION_S = PRESENCE_TTL_MAX_S + PRESENCE_RETENTION_MARGIN_S;
/** The most sessions one listing reads. Beyond it the listing is marked truncated. */
export const PRESENCE_MAX_SESSIONS = 256;

export interface PresenceBackend {
	get(key: string): Promise<string | null>;
	/** `SET key value EX ttlSeconds`. */
	setWithTtl(key: string, value: string, ttlSeconds: number): Promise<void>;
	/** Up to `limit` keys under `prefix`. `truncated` is true when the walk stopped at `limit` or before the keyspace was covered. */
	scanPrefix(prefix: string, limit: number): Promise<{ keys: string[]; truncated: boolean }>;
	/** The server's clock, in milliseconds since the epoch. */
	serverTimeMs(): Promise<number>;
}

export interface PresenceListing {
	records: SessionRecord[];
	/** True when the listing stopped before every session was read. The records returned are still exact. */
	truncated: boolean;
}

export class DragonflyPresenceStore implements PresenceStore {
	constructor(
		private readonly backend: PresenceBackend,
		private readonly retentionS: number = PRESENCE_RETENTION_S,
	) {
		if (!Number.isSafeInteger(retentionS) || retentionS < 1) throw new RangeError("retentionS must be a positive integer");
	}

	/**
	 * Records a heartbeat stamped with the server's time. `ttlMs` is the freshness window. The key outlives it by the retention
	 * margin, so a session at the largest window is still held when that window closes.
	 */
	async touch(record: SessionRecord, ttlMs: number): Promise<void> {
		const valid = SessionRecordSchema.parse(record);
		if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError("ttlMs must be a positive number");
		if (ttlMs > (this.retentionS - PRESENCE_RETENTION_MARGIN_S) * 1000) throw new RangeError("ttlMs must leave the presence retention margin past it");
		const stamped: SessionRecord = { ...valid, lastHeartbeatMs: await this.backend.serverTimeMs() };
		await this.backend.setWithTtl(keyFor(valid.sessionId), JSON.stringify(stamped), this.retentionS);
	}

	/** Every held record, sorted by session id. Refuses, rather than answer partially, when more than the bound exist. */
	async list(): Promise<SessionRecord[]> {
		const listing = await this.listWithin(PRESENCE_MAX_SESSIONS);
		if (listing.truncated) throw new Error(`presence holds more than ${PRESENCE_MAX_SESSIONS} sessions; refusing a partial listing`);
		return listing.records;
	}

	/** Up to `limit` held records, sorted by session id, with the truncation flag. Stale records are included. */
	async listWithin(limit: number): Promise<PresenceListing> {
		if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
		const scanned = await this.backend.scanPrefix(PRESENCE_KEY_PREFIX, limit);
		const keys = [...new Set(scanned.keys.filter((key) => key.startsWith(PRESENCE_KEY_PREFIX)))].sort();
		const kept = keys.slice(0, limit);
		const records: SessionRecord[] = [];
		for (const key of kept) {
			const value = await this.backend.get(key);
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
