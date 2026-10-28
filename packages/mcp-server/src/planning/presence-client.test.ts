/**
 * The presence client over a scripted fake connection: the SCAN walk follows its cursor and stops at its bound, glob
 * characters in a prefix match only themselves, TIME becomes milliseconds, and a failed command or connect is redacted,
 * closes its connection, and is followed by a fresh connection on the next call.
 */
import { describe, expect, test } from "bun:test";
import { MAX_SCAN_ROUNDS, PRESENCE_COMMANDS, PresenceBackendError, SCAN_COUNT, dragonflyPresenceBackend, type PresenceRedisClient } from "./presence-client.ts";

type Reply = (command: string, args: string[]) => unknown;

class ScriptedRedis implements PresenceRedisClient {
	closed = false;
	readonly sent: Array<{ command: string; args: string[] }> = [];

	constructor(
		private readonly reply: Reply,
		private readonly connectError: Error | null = null,
	) {}

	async connect(): Promise<void> {
		if (this.connectError) throw this.connectError;
	}

	async send(command: string, args: string[]): Promise<unknown> {
		this.sent.push({ command, args });
		return this.reply(command, args);
	}

	close(): void {
		this.closed = true;
	}
}

/** A factory that hands out one scripted connection per call, so tests can see each reconnect. */
function factory(connections: ScriptedRedis[]) {
	const made: ScriptedRedis[] = [];
	const make = () => {
		const next = connections[made.length] ?? new ScriptedRedis(() => null);
		made.push(next);
		return next;
	};
	return { make, made };
}

describe("dragonflyPresenceBackend", () => {
	test("serverTimeMs reads the server's seconds and microseconds as milliseconds", async () => {
		const redis = new ScriptedRedis((command) => (command === "TIME" ? ["1700000000", "123456"] : null));
		const backend = dragonflyPresenceBackend("redis://127.0.0.1:6379", 1000, factory([redis]).make);
		expect(await backend.serverTimeMs()).toBe(1_700_000_000_123);
		expect(redis.sent).toEqual([{ command: "TIME", args: [] }]);
	});

	test("serverTimeMs refuses a reply that is not seconds and microseconds", async () => {
		const redis = new ScriptedRedis(() => ["not-a-number", "1"]);
		const backend = dragonflyPresenceBackend("redis://127.0.0.1:6379", 1000, factory([redis]).make);
		await expect(backend.serverTimeMs()).rejects.toThrow(PresenceBackendError);
	});

	test("scanPrefix follows the cursor until it returns to zero and collects every key once", async () => {
		const pages: Record<string, [string, string[]]> = {
			"0": ["5", ["p:a", "p:b"]],
			"5": ["0", ["p:b", "p:c"]],
		};
		const redis = new ScriptedRedis((command, args) => (command === "SCAN" ? pages[args[0] ?? ""] : null));
		const backend = dragonflyPresenceBackend("redis://127.0.0.1:6379", 1000, factory([redis]).make);
		expect(await backend.scanPrefix("p:", 10)).toEqual({ keys: ["p:a", "p:b", "p:c"], truncated: false });
		expect(redis.sent.map((entry) => entry.args[0])).toEqual(["0", "5"]);
	});

	test("scanPrefix never returns more keys than its limit and reports the truncation", async () => {
		const redis = new ScriptedRedis(() => ["0", ["p:a", "p:b", "p:c", "p:d"]]);
		const backend = dragonflyPresenceBackend("redis://127.0.0.1:6379", 1000, factory([redis]).make);
		expect(await backend.scanPrefix("p:", 2)).toEqual({ keys: ["p:a", "p:b"], truncated: true });
	});

	test("scanPrefix sends a bounded COUNT and escapes glob characters in the prefix", async () => {
		const redis = new ScriptedRedis(() => ["0", []]);
		const backend = dragonflyPresenceBackend("redis://127.0.0.1:6379", 1000, factory([redis]).make);
		await backend.scanPrefix("a*b[c]?", 5);
		expect(redis.sent[0]).toEqual({ command: "SCAN", args: ["0", "MATCH", "a\\*b\\[c\\]\\?*", "COUNT", String(SCAN_COUNT)] });
	});

	test("scanPrefix stops after the round cap and reports the walk as incomplete", async () => {
		const redis = new ScriptedRedis(() => ["9", []]);
		const backend = dragonflyPresenceBackend("redis://127.0.0.1:6379", 1000, factory([redis]).make);
		expect(await backend.scanPrefix("p:", 5)).toEqual({ keys: [], truncated: true });
		expect(redis.sent).toHaveLength(MAX_SCAN_ROUNDS);
	});

	test("a failed command redacts the URL, closes its connection, and the next call opens a fresh one", async () => {
		const failing = new ScriptedRedis(() => {
			throw new Error("ECONNRESET redis://user:SECRET-PASS@10.0.0.9:6379");
		});
		const healthy = new ScriptedRedis(() => "value");
		const { make, made } = factory([failing, healthy]);
		const backend = dragonflyPresenceBackend("redis://127.0.0.1:6379", 1000, make);
		const failure = await backend.get("k").then(
			() => null,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(PresenceBackendError);
		expect(String(failure)).not.toContain("SECRET-PASS");
		expect(String(failure)).not.toContain("10.0.0.9");
		expect(failing.closed).toBe(true);
		expect(await backend.get("k")).toBe("value");
		expect(made).toHaveLength(2);
	});

	test("a failed connect is a typed connect error, closes the socket, and is retried on the next call", async () => {
		const refused = new ScriptedRedis(() => null, new Error("refused redis://user:SECRET-PASS@host"));
		const healthy = new ScriptedRedis(() => null);
		const { make, made } = factory([refused, healthy]);
		const backend = dragonflyPresenceBackend("redis://127.0.0.1:6379", 1000, make);
		const failure = await backend.serverTimeMs().then(
			() => null,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(PresenceBackendError);
		expect((failure as PresenceBackendError).operation).toBe("connect");
		expect(String(failure)).not.toContain("SECRET-PASS");
		expect(refused.closed).toBe(true);
		expect(made).toHaveLength(1);
		await expect(backend.get("k")).resolves.toBe(null);
		expect(made).toHaveLength(2);
	});

	test("a GET that answers with something other than a string or null is refused", async () => {
		const redis = new ScriptedRedis(() => 42);
		const backend = dragonflyPresenceBackend("redis://127.0.0.1:6379", 1000, factory([redis]).make);
		await expect(backend.get("k")).rejects.toThrow("reply is neither a string nor null");
	});

	test("every command sent is in the closed presence command set", async () => {
		const redis = new ScriptedRedis((command) => (command === "TIME" ? ["1", "0"] : command === "SCAN" ? ["0", []] : null));
		const backend = dragonflyPresenceBackend("redis://127.0.0.1:6379", 1000, factory([redis]).make);
		await backend.get("k");
		await backend.setWithTtl("k", "v", 60);
		await backend.scanPrefix("p:", 3);
		await backend.serverTimeMs();
		const commands = new Set(redis.sent.map((entry) => entry.command));
		expect([...commands].filter((command) => !(PRESENCE_COMMANDS as readonly string[]).includes(command))).toEqual([]);
		expect(redis.sent.find((entry) => entry.command === "SET")?.args).toEqual(["k", "v", "EX", "60"]);
	});

	test("a reply that never arrives fails within the command deadline, closes its connection, and the next call reconnects", async () => {
		const stalled = new ScriptedRedis(() => new Promise<never>(() => {}));
		const healthy = new ScriptedRedis(() => "value");
		const { make, made } = factory([stalled, healthy]);
		const backend = dragonflyPresenceBackend("redis://127.0.0.1:6379", 1000, make, 20);
		const started = performance.now();
		const failure = await backend.get("k").then(
			() => null,
			(error: unknown) => error,
		);
		expect(performance.now() - started).toBeLessThan(1000);
		expect(failure).toBeInstanceOf(PresenceBackendError);
		expect(String(failure)).toContain("deadline (20 ms presence GET)");
		expect(stalled.closed).toBe(true);
		expect(await backend.get("k")).toBe("value");
		expect(made).toHaveLength(2);
	});
});

describe("dragonflyPresenceBackend cancellation", () => {
	test("a read given an aborted signal is not sent and leaves the connection open", async () => {
		const redis = new ScriptedRedis(() => "value");
		const backend = dragonflyPresenceBackend("redis://127.0.0.1:6379", 1000, factory([redis]).make);
		expect(await backend.get("substrate:v1:planning:presence:a")).toBe("value");
		const abandoned = new AbortController();
		abandoned.abort();
		const failure = await backend.get("substrate:v1:planning:presence:b", abandoned.signal).then(
			() => null,
			(cause: unknown) => cause,
		);
		expect(failure).not.toBeNull();
		expect(redis.sent).toEqual([{ command: "GET", args: ["substrate:v1:planning:presence:a"] }]);
		expect(redis.closed).toBe(false);
		expect(await backend.get("substrate:v1:planning:presence:c")).toBe("value");
		expect(redis.sent).toHaveLength(2);
	});

	test("a read abandoned while the connect is in flight is not sent, and the connection stays open", async () => {
		const gate = Promise.withResolvers<void>();
		class GatedRedis extends ScriptedRedis {
			override async connect(): Promise<void> {
				await gate.promise;
			}
		}
		const redis = new GatedRedis(() => "value");
		const backend = dragonflyPresenceBackend("redis://127.0.0.1:6379", 1000, factory([redis]).make);
		const controller = new AbortController();
		const pending = backend.get("substrate:v1:planning:presence:a", controller.signal).then(
			() => null,
			(cause: unknown) => cause,
		);
		controller.abort();
		gate.resolve();
		const failure = await pending;
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).name).toBe("AbortError");
		expect(redis.sent).toEqual([]);
		expect(redis.closed).toBe(false);
	});
});
