/**
 * The Dragonfly presence adapter (phase 52, SOTA-08). Presence is a key per session, written with
 * the server's own expiry, so the freshness window is enforced by the server.
 *
 * What it guarantees:
 * - `touch` writes `SET key value EX <seconds>`. The server removes the key when the window closes.
 *   The window is `ceil(ttlMs / 1000)` seconds, never less than one.
 * - `list` returns the records whose keys exist when read. A key that expires between the
 *   enumeration and its read is skipped as gone, not reported as stale.
 * - A stored value that does not parse as a session record fails `list`, naming the key. It is
 *   never dropped silently.
 *
 * What it cannot guarantee:
 * - It never reports "stale". An expired session has no key, so it is absent, not old. Do not run
 *   `classifySessions` over these records with a host clock: every record here is active by the
 *   server's TTL.
 * - It reads no server time. The Dragonfly client exposes no `TIME` command, so the adapter never
 *   uses the local clock for expiry.
 * - The enumeration is only as complete as `keysWithPrefix`. Production must page a bounded SCAN
 *   until the cursor returns to zero. A partial enumeration gives a partial list, with no error.
 * - `list` is not an atomic snapshot across keys. Two sessions touched during one list may land
 *   on either side of it.
 *
 * The commands go through `PresenceBackend`, a port of its own. The cache client in `cache.ts` is
 * closed to its current command set by `cache-conformance.test.ts`, so presence never reuses it.
 */
import { SessionRecordSchema, type PresenceStore, type SessionRecord } from "./presence.ts";

export const PRESENCE_KEY_PREFIX = "substrate:v1:planning:presence:";

export interface PresenceBackend {
	get(key: string): Promise<string | null>;
	/** `SET key value EX ttlSeconds`. */
	setWithTtl(key: string, value: string, ttlSeconds: number): Promise<void>;
	/** Every key under `prefix`, completely enumerated. */
	keysWithPrefix(prefix: string): Promise<string[]>;
}

export class DragonflyPresenceStore implements PresenceStore {
	constructor(private readonly backend: PresenceBackend) {}

	async touch(record: SessionRecord, ttlMs: number): Promise<void> {
		const valid = SessionRecordSchema.parse(record);
		await this.backend.setWithTtl(keyFor(valid.sessionId), JSON.stringify(valid), ttlSecondsFor(ttlMs));
	}

	async list(): Promise<SessionRecord[]> {
		const enumerated = await this.backend.keysWithPrefix(PRESENCE_KEY_PREFIX);
		// SCAN may name a key more than once across its pages: each key is read once.
		const keys = [...new Set(enumerated)].filter((key) => key.startsWith(PRESENCE_KEY_PREFIX)).sort();
		const records: SessionRecord[] = [];
		for (const key of keys) {
			const value = await this.backend.get(key);
			if (value === null) continue;
			records.push(parseStored(key, value));
		}
		return records;
	}
}

function keyFor(sessionId: string): string {
	return `${PRESENCE_KEY_PREFIX}${sessionId}`;
}

function ttlSecondsFor(ttlMs: number): number {
	if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError("ttlMs must be a positive number");
	return Math.max(1, Math.ceil(ttlMs / 1000));
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
