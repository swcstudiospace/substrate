/**
 * An in-memory Dragonfly presence backend for the planning tests (phase 52). It holds the keys a `SET ... EX` wrote, answers
 * `SCAN` and `GET` from them, and reports a server clock the test sets. Every write is recorded, so a test can prove that a
 * read wrote nothing.
 */
import type { PresenceBackend } from "./presence-dragonfly.ts";

export class RecordingPresenceBackend implements PresenceBackend {
	/** Every `SET ... EX` the backend received, in order. */
	readonly writes: Array<{ key: string; ttlSeconds: number }> = [];
	/** The stored value of each key. */
	readonly values = new Map<string, string>();
	/** The server clock, in milliseconds since the epoch. */
	clockMs = 1_800_000_000_000;
	/** When true, `TIME` fails, as an unreachable or refusing server would. */
	clockFails = false;

	async get(key: string): Promise<string | null> {
		return this.values.get(key) ?? null;
	}

	async setWithTtl(key: string, value: string, ttlSeconds: number): Promise<void> {
		this.writes.push({ key, ttlSeconds });
		this.values.set(key, value);
	}

	async scanPrefix(prefix: string, limit: number): Promise<{ keys: string[]; truncated: boolean }> {
		const keys = [...this.values.keys()].filter((key) => key.startsWith(prefix)).sort();
		return { keys: keys.slice(0, limit), truncated: keys.length > limit };
	}

	async serverTimeMs(): Promise<number> {
		if (this.clockFails) throw new Error("TIME is unavailable");
		return this.clockMs;
	}
}
