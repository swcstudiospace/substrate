/**
 * The production presence backend (phase 52, W1): Bun's `RedisClient`, driven through `send` with a closed
 * command set. It lives beside the presence store, not in `cache.ts`, so the cache's command lock
 * (`cache-conformance.test.ts`) stays exactly as it is.
 *
 * The commands are GET, SET (with EX), SCAN and TIME, and nothing else. There is no KEYS, EVAL, PUBLISH or
 * any other path to a command. A SCAN walk is bounded by `SCAN_COUNT` per round, by `MAX_SCAN_ROUNDS`, and by
 * the caller's limit. Every connect and command has a reply deadline (`COMMAND_TIMEOUT_MS` by default). A connection
 * that fails or misses a deadline is discarded, so the next call reconnects.
 */
import { RedisClient } from "bun";
import { COMMAND_TIMEOUT_MS } from "../cache.ts";
import { sharedDeadline } from "../deadline.ts";
import { REDACTED, redact } from "../redact.ts";
import type { PresenceBackend } from "./presence-dragonfly.ts";

/** The whole command set this client may send. */
export const PRESENCE_COMMANDS = ["GET", "SET", "SCAN", "TIME"] as const;
export type PresenceCommand = (typeof PRESENCE_COMMANDS)[number];

/** Keys requested per SCAN round. The server may return more or fewer; the caller's limit still holds. */
export const SCAN_COUNT = 100;
/** A walk stops after this many rounds (100 x 1000 = 100k keys at most) and reports itself truncated. */
export const MAX_SCAN_ROUNDS = 1000;

/** The part of Bun's `RedisClient` this backend uses. A fake stands in for it in tests. */
export interface PresenceRedisClient {
	connect(): Promise<unknown>;
	send(command: string, args: string[]): Promise<unknown>;
	close(): void;
}

export type MakePresenceClient = (url: string, connectTimeoutMs: number) => PresenceRedisClient;

/** A failed presence command or connection. The message is redacted: a connection error can quote the URL. */
export class PresenceBackendError extends Error {
	readonly operation: PresenceCommand | "connect";

	constructor(operation: PresenceCommand | "connect", cause: unknown) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		super(`presence ${operation} failed: ${redact(detail.replace(/\b(?:redis|rediss):\/\/\S+/gi, `redis://${REDACTED}`))}`);
		this.name = "PresenceBackendError";
		this.operation = operation;
	}
}

const defaultClient: MakePresenceClient = (url, connectTimeoutMs) =>
	new RedisClient(url, {
		connectionTimeout: connectTimeoutMs,
		idleTimeout: 0,
		autoReconnect: false,
		maxRetries: 0,
		enableOfflineQueue: false,
	});

/**
 * A `PresenceBackend` over one connection, opened on first use. A command that fails closes that connection,
 * so the next call opens a fresh one; nothing retries a command on its own.
 */
export function dragonflyPresenceBackend(
	url: string,
	connectTimeoutMs: number,
	makeClient: MakePresenceClient = defaultClient,
	commandTimeoutMs: number = COMMAND_TIMEOUT_MS,
): PresenceBackend {
	let client: PresenceRedisClient | null = null;
	let opening: Promise<PresenceRedisClient> | null = null;

	const open = (): Promise<PresenceRedisClient> => {
		if (client !== null) return Promise.resolve(client);
		if (opening !== null) return opening;
		const next = makeClient(url, connectTimeoutMs);
		opening = bounded(next.connect(), connectTimeoutMs, "presence connect").then(
			() => {
				client = next;
				opening = null;
				return next;
			},
			(cause: unknown) => {
				opening = null;
				closeQuietly(next);
				throw new PresenceBackendError("connect", cause);
			},
		);
		return opening;
	};

	const run = async (command: PresenceCommand, args: string[], signal?: AbortSignal): Promise<unknown> => {
		// An abandoned listing sends nothing more. No command was sent, so the connection is not at fault and stays open.
		signal?.throwIfAborted();
		const redis = await open();
		// The connect can outlast the listing budget. An abandoned read must send nothing even when the connection is
		// now open, and the connection stays open: no command was sent, so it is not at fault.
		signal?.throwIfAborted();
		try {
			return await bounded(redis.send(command, args), commandTimeoutMs, `presence ${command}`);
		} catch (cause: unknown) {
			if (client === redis) client = null;
			closeQuietly(redis);
			throw new PresenceBackendError(command, cause);
		}
	};

	return {
		async get(key, signal) {
			const reply = await run("GET", [key], signal);
			if (reply === null || typeof reply === "string") return reply;
			throw new PresenceBackendError("GET", "reply is neither a string nor null");
		},
		async setWithTtl(key, value, ttlSeconds) {
			await run("SET", [key, value, "EX", String(ttlSeconds)]);
		},
		async scanPrefix(prefix, limit, signal) {
			// Glob metacharacters are escaped, so the pattern matches the prefix and nothing wider.
			const pattern = `${prefix.replace(/[*?[\]\\]/g, "\\$&")}*`;
			const found = new Set<string>();
			let cursor = "0";
			for (let round = 0; round < MAX_SCAN_ROUNDS; round++) {
			const reply = parseScanReply(await run("SCAN", [cursor, "MATCH", pattern, "COUNT", String(SCAN_COUNT)], signal));
				for (const key of reply.keys) {
					found.add(key);
					if (found.size > limit) return { keys: [...found].slice(0, limit), truncated: true };
				}
				if (reply.cursor === "0") return { keys: [...found], truncated: false };
				cursor = reply.cursor;
			}
			return { keys: [...found], truncated: true };
		},
		async serverTimeMs() {
			const reply = await run("TIME", []);
			if (!Array.isArray(reply) || reply.length !== 2) throw new PresenceBackendError("TIME", "reply is not [seconds, microseconds]");
			const seconds = Number(reply[0]);
			const micros = Number(reply[1]);
			if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(micros) || micros < 0) {
				throw new PresenceBackendError("TIME", "reply holds no integer seconds and microseconds");
			}
			return seconds * 1000 + Math.floor(micros / 1000);
		},
	};
}

function parseScanReply(reply: unknown): { cursor: string; keys: string[] } {
	if (!Array.isArray(reply) || reply.length !== 2) throw new PresenceBackendError("SCAN", "reply is not [cursor, keys]");
	const [cursor, keys] = reply as [unknown, unknown];
	if (typeof cursor !== "string" || !Array.isArray(keys) || !keys.every((key): key is string => typeof key === "string")) {
		throw new PresenceBackendError("SCAN", "reply holds a cursor or key that is not a string");
	}
	return { cursor, keys };
}

/**
 * A reply bounded by the codebase's shared deadline (`deadline.ts`, the same pattern the brief and docs fan-outs use).
 * A reply that misses the budget rejects with a `DeadlineError`; the caller then discards the connection.
 */
async function bounded<T>(read: Promise<T>, budgetMs: number, label: string): Promise<T> {
	const deadline = sharedDeadline(budgetMs, label);
	try {
		return await deadline.race(read);
	} finally {
		deadline.clear();
	}
}

function closeQuietly(redis: PresenceRedisClient): void {
	try {
		redis.close();
	} catch {
		// The socket is already gone; there is nothing left to release.
	}
}
