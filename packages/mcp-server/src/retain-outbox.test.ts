/**
 * The retain outbox proven with a fake clock, a fake random source and the
 * fake banks server (uplift-2 R3).
 *
 * What it must hold: only transient forward failures park (never a refusal),
 * the backoff schedule is the documented one with bounded jitter, the durable
 * file round-trips at 0600 and compacts, the bound drops the oldest entry
 * with the `outbox-full` warning, a replay re-reads the entry by id and skips
 * what is gone or superseded, the last attempt's warning is today's warning,
 * and an open breaker makes a drain a no-op that spends nothing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CircuitBreaker } from "@substrate/observability";
import { loadConfig } from "./config.ts";
import { HindsightFake } from "./hindsight-fake.ts";
import { forwardRetain, retainDocumentId, type RetainDeps } from "./memory-retain.ts";
import { FakeStore } from "./memory-write.test.ts";
import { clearEnsuredBanks, type FetchLike, type HindsightConfig } from "./planes/hindsight.ts";
import {
	DEFAULT_RETAIN_MAX_ATTEMPTS,
	RetainOutbox,
	retainBackoffMs,
	TRANSIENT_RETAIN_REASONS,
	type RetainDropCause,
	type RetainOutboxCandidate,
	type RetainOutboxEntry,
} from "./retain-outbox.ts";
import { Substrate } from "./service.ts";
import type { EventInput, MemoryEntry, MemoryWriteResult } from "./types.ts";

const CONFIG: HindsightConfig = { url: "http://fake", apiKey: "test-bearer", bankPrefix: "sub-" };
const T0 = Date.parse("2026-10-13T00:00:00.000Z");

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
	return {
		id: "mem_1",
		scope: "repo:acme/app",
		kind: "fact",
		text: "fence the lease before handoff",
		writer: "cursor",
		actor: "agent",
		trust: "agent-claimed",
		ttl: "30d",
		created: "2026-10-10T00:00:00.000Z",
		version: 1,
		entry_hash: "hash_1",
		needs_reverification: false,
		...overrides,
	};
}

function accepted(overrides: Partial<MemoryWriteResult> = {}): MemoryWriteResult {
	return {
		outcome: "accepted",
		reason: "stored",
		remedy: "durable",
		verified_persisted: true,
		idempotency_key: "mwd_key1",
		writer: "cursor",
		entry: entry(),
		...overrides,
	};
}

const REQUEST = { source_event: "evt_proof_run", scope: "repo:acme/app", kind: "fact" as const, text: "x", writer: "cursor", session_id: "sess-1" };

function candidate(overrides: Partial<RetainOutboxCandidate> = {}): RetainOutboxCandidate {
	return {
		bank: "sub-cursor",
		document_id: "mwd_key1",
		entry_id: "mem_1",
		surface: "cursor",
		entry_hash: "hash_1",
		reason: "retain-server",
		...overrides,
	};
}

/** A clock the tests advance by hand. */
function clock(start = T0): { now: () => number; advance: (ms: number) => void } {
	let at = start;
	return { now: () => at, advance: (ms) => (at += ms) };
}

/** Deps around the fake with a recording sink; `fetchOverride` replaces the retain POST only. */
function retainDeps(fake: HindsightFake, options: { fetchOverride?: (init?: RequestInit) => Response | Error; sink?: boolean } = {}) {
	clearEnsuredBanks();
	const emitted: EventInput[] = [];
	const queued: RetainOutboxCandidate[] = [];
	const fetchImpl: FetchLike = async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (options.fetchOverride && init?.method === "POST" && url.endsWith("/memories")) {
			const answer = options.fetchOverride(init);
			if (answer instanceof Error) throw answer;
			return answer;
		}
		return fake.fetch(input, init);
	};
	const deps: RetainDeps = {
		config: CONFIG,
		fetchImpl,
		emit: async (event) => {
			emitted.push(event);
			return { stored: true };
		},
		...(options.sink === false
			? {}
			: {
					outbox: {
						enqueue: (item: RetainOutboxCandidate) => {
							queued.push(item);
							return true;
						},
					},
				}),
	};
	return { deps, emitted, queued };
}

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "retain-outbox-"));
	dirs.push(dir);
	return dir;
}

describe("retainBackoffMs", () => {
	test("doubles from 30 s, caps the base at one hour, and jitters within ±20 %", () => {
		const mid = (attempt: number) => retainBackoffMs(attempt, () => 0.5);
		expect([0, 1, 2, 3, 4, 5, 6].map(mid)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000]);
		expect(mid(7)).toBe(3_600_000);
		expect(mid(20)).toBe(3_600_000);
		expect(retainBackoffMs(2, () => 0)).toBe(96_000);
		expect(retainBackoffMs(2, () => 0.999_999)).toBeLessThanOrEqual(144_000);
		expect(retainBackoffMs(2, () => 0.999_999)).toBeGreaterThan(143_000);
		expect(retainBackoffMs(-3, () => 0.5)).toBe(30_000);
	});

	test("ten attempts with the live one included span about three hours, growing monotonically to the cap", () => {
		const waits: number[] = [];
		for (let attempt = 0; attempt < DEFAULT_RETAIN_MAX_ATTEMPTS - 1; attempt++) waits.push(retainBackoffMs(attempt, () => 0.5));
		// 30 + 60 + 120 + 240 + 480 + 960 + 1920 + 3600 + 3600 s = 11,010 s ≈ 3.06 h.
		expect(waits.reduce((sum, wait) => sum + wait, 0)).toBe(11_010_000);
		for (let index = 1; index < waits.length; index++) expect(waits[index]).toBeGreaterThanOrEqual(waits[index - 1] ?? 0);
		expect(waits.at(-1)).toBe(3_600_000);
	});
});

describe("forwardRetain with an outbox sink", () => {
	test("every transient kind parks instead of warning, and nothing else does", async () => {
		const cases: Array<{ name: string; override: (init?: RequestInit) => Response | Error; reason: string }> = [
			{ name: "5xx", override: () => Response.json({ detail: "boom" }, { status: 503 }), reason: "retain-server" },
			{ name: "429", override: () => Response.json({ detail: "slow down" }, { status: 429 }), reason: "retain-rate-limit" },
			{ name: "transport", override: () => new Error("connect ECONNREFUSED"), reason: "retain-network" },
			{ name: "timeout", override: () => new DOMException("aborted", "TimeoutError"), reason: "retain-timeout" },
			{
				name: "breaker open",
				override: () => {
					const refused = new Error("hindsight: circuit open");
					refused.name = "BreakerOpenError";
					return refused;
				},
				reason: "retain-network",
			},
		];
		for (const { name, override, reason } of cases) {
			const fake = new HindsightFake();
			const { deps, emitted, queued } = retainDeps(fake, { fetchOverride: override });
			const outcome = await forwardRetain(deps, REQUEST, accepted());
			expect({ name, outcome }).toEqual({ name, outcome: { forwarded: false, bank: "sub-cursor", document_id: "mwd_key1", reason, queued: true } });
			expect({ name, emitted: emitted.length }).toEqual({ name, emitted: 0 });
			expect({ name, queued }).toEqual({
				name,
				queued: [{ bank: "sub-cursor", document_id: "mwd_key1", entry_id: "mem_1", surface: "cursor", entry_hash: "hash_1", session_id: "sess-1", reason }],
			});
			expect(TRANSIENT_RETAIN_REASONS).toContain(reason);
		}
	});

	test("a 4xx other than 429, an unsourced write and a redactor finding warn at once and never park", async () => {
		const bad = new HindsightFake();
		const refused = retainDeps(bad, { fetchOverride: () => Response.json({ detail: "bad item" }, { status: 400 }) });
		const badRequest = await forwardRetain(refused.deps, REQUEST, accepted());
		expect(badRequest).toMatchObject({ forwarded: false, reason: "retain-bad-request" });
		expect(badRequest.queued).toBeUndefined();
		expect(refused.queued).toEqual([]);
		expect(refused.emitted.map((event) => event.payload?.reason)).toEqual(["retain-bad-request"]);

		const unsourced = retainDeps(new HindsightFake());
		await forwardRetain(unsourced.deps, { ...REQUEST, source_event: undefined }, accepted());
		expect(unsourced.queued).toEqual([]);
		expect(unsourced.emitted.map((event) => event.payload?.reason)).toEqual(["retain.unsourced"]);

		const unredacted = retainDeps(new HindsightFake());
		await forwardRetain(unredacted.deps, REQUEST, accepted({ entry: entry({ text: "deploy password: hunter2" }) }));
		expect(unredacted.queued).toEqual([]);
		expect(unredacted.emitted.map((event) => event.payload?.reason)).toEqual(["retain.unredacted"]);
	});

	test("without a sink a transient failure warns exactly as before", async () => {
		const fake = new HindsightFake();
		fake.failRetainWith = 500;
		const { deps, emitted } = retainDeps(fake, { sink: false });
		const outcome = await forwardRetain(deps, REQUEST, accepted());
		expect(outcome).toMatchObject({ forwarded: false, reason: "retain-server" });
		expect(emitted).toEqual([
			{
				surface: "cursor",
				kind: "warning",
				summary: "hindsight retain failed: retain-server (sub-cursor/mwd_key1)",
				session_id: "sess-1",
				payload: { action: "memory.retain", reason: "retain-server", bank: "sub-cursor", document_id: "mwd_key1", entry_hash: "hash_1" },
			},
		]);
	});

	test("a retain 404 evicts the ensured bank and re-ensures exactly once", async () => {
		const fake = new HindsightFake();
		const { deps, emitted, queued } = retainDeps(fake);
		expect(await forwardRetain(deps, REQUEST, accepted())).toMatchObject({ forwarded: true });
		// The bank vanishes out of band; the client still remembers it as ensured.
		fake.banks.delete("sub-cursor");
		fake.requests.length = 0;
		const again = await forwardRetain(deps, REQUEST, accepted({ idempotency_key: "mwd_key2" }));
		expect(again).toMatchObject({ forwarded: true, document_id: "mwd_key2" });
		const trail = fake.requests.map((request) => `${request.method} ${request.path.replace("/v1/default/banks/sub-cursor", "")}`);
		expect(trail).toEqual(["POST /memories", "GET /config", "PUT ", "PATCH /config", "POST /memories"]);
		expect(emitted).toEqual([]);
		expect(queued).toEqual([]);
		expect(fake.banks.get("sub-cursor")?.memories.map((memory) => memory.document_id)).toEqual(["mwd_key2"]);
	});

	test("a second 404 after the re-ensure is reported, not looped", async () => {
		const fake = new HindsightFake();
		let posts = 0;
		const { deps, emitted, queued } = retainDeps(fake, {
			fetchOverride: () => {
				posts += 1;
				return Response.json({ detail: "bank not found" }, { status: 404 });
			},
		});
		const outcome = await forwardRetain(deps, REQUEST, accepted());
		expect(outcome).toMatchObject({ forwarded: false, reason: "retain-not-found" });
		expect(posts).toBe(2);
		expect(queued).toEqual([]);
		expect(emitted.map((event) => event.payload?.reason)).toEqual(["retain-not-found"]);
	});
});

describe("RetainOutbox in memory", () => {
	test("enqueue schedules the first replay 30 s out and replaces a parked document", () => {
		const time = clock();
		const outbox = new RetainOutbox({ now: time.now, random: () => 0.5 });
		const first = outbox.enqueue(candidate());
		expect(first).toMatchObject({ bank: "sub-cursor", document_id: "mwd_key1", attempts: 1, next_at: T0 + 30_000, last_reason: "retain-server", enqueued_at: T0 });
		expect(first.id.startsWith("rob_")).toBe(true);
		time.advance(5_000);
		const second = outbox.enqueue(candidate({ entry_id: "mem_2", reason: "retain-timeout" }));
		expect(outbox.size()).toBe(1);
		expect(outbox.list()).toEqual([{ ...second }]);
		expect(second.entry_id).toBe("mem_2");
		expect(outbox.stats()).toEqual({ size: 1, oldestAt: new Date(T0 + 5_000).toISOString(), attemptsTotal: 1, durable: false });
	});

	test("the drain replays only due entries, backs off on a transient answer and drops on the rest", async () => {
		const time = clock();
		const dropped: Array<[RetainOutboxEntry, RetainDropCause]> = [];
		const outbox = new RetainOutbox({ now: time.now, random: () => 0.5, onDrop: (entry, cause) => dropped.push([entry, cause]) });
		outbox.enqueue(candidate({ document_id: "a" }));
		outbox.enqueue(candidate({ document_id: "b" }));
		outbox.enqueue(candidate({ document_id: "c" }));
		const delivered: string[] = [];
		const deliver = async (entry: RetainOutboxEntry) => {
			delivered.push(entry.document_id);
			if (entry.document_id === "a") return "delivered" as const;
			if (entry.document_id === "b") return "gone" as const;
			return { transient: "retain-timeout" };
		};
		await outbox.drain(deliver);
		expect(delivered).toEqual([]);
		time.advance(30_000);
		await outbox.drain(deliver);
		expect(delivered).toEqual(["a", "b", "c"]);
		expect(outbox.list().map((entry) => [entry.document_id, entry.attempts, entry.last_reason, entry.next_at])).toEqual([
			["c", 2, "retain-timeout", T0 + 30_000 + 60_000],
		]);
		expect(dropped).toEqual([]);
	});

	test("the last attempt drops the entry through onDrop with its last transient reason", async () => {
		const time = clock();
		const dropped: Array<[RetainOutboxEntry, RetainDropCause]> = [];
		const outbox = new RetainOutbox({ now: time.now, random: () => 0.5, maxAttempts: 3, onDrop: (entry, cause) => dropped.push([entry, cause]) });
		outbox.enqueue(candidate());
		let calls = 0;
		const deliver = async () => {
			calls += 1;
			return { transient: calls === 1 ? "retain-server" : "retain-network" };
		};
		time.advance(30_000);
		await outbox.drain(deliver);
		expect(outbox.size()).toBe(1);
		time.advance(60_000);
		await outbox.drain(deliver);
		expect(calls).toBe(2);
		expect(outbox.size()).toBe(0);
		expect(dropped.map(([entry, cause]) => [cause, entry.attempts, entry.last_reason])).toEqual([["exhausted", 3, "retain-network"]]);
	});

	test("a permanent answer drops without onDrop: the forward already warned", async () => {
		const time = clock();
		const dropped: RetainDropCause[] = [];
		const outbox = new RetainOutbox({ now: time.now, onDrop: (_entry, cause) => dropped.push(cause) });
		outbox.enqueue(candidate());
		await outbox.drain(async () => "permanent", { all: true });
		expect(outbox.size()).toBe(0);
		expect(dropped).toEqual([]);
	});

	test("over the bound the oldest entry is dropped with outbox-full", () => {
		const time = clock();
		const dropped: Array<[string, RetainDropCause]> = [];
		const outbox = new RetainOutbox({ now: time.now, max: 2, onDrop: (entry, cause) => dropped.push([entry.document_id, cause]) });
		outbox.enqueue(candidate({ document_id: "a" }));
		time.advance(1);
		outbox.enqueue(candidate({ document_id: "b" }));
		time.advance(1);
		outbox.enqueue(candidate({ document_id: "c" }));
		expect(dropped).toEqual([["a", "outbox-full"]]);
		expect(outbox.list().map((entry) => entry.document_id)).toEqual(["b", "c"]);
	});

	test("a drain under an open breaker attempts nothing and spends no attempt", async () => {
		const time = clock();
		const breaker = new CircuitBreaker("hindsight", { failureThreshold: 1, openMs: 30_000 }, time.now);
		const outbox = new RetainOutbox({ now: time.now, random: () => 0.5, allow: () => breaker.state() !== "open" });
		outbox.enqueue(candidate());
		breaker.onFailure("hindsight retain: unreachable");
		expect(breaker.state()).toBe("open");
		let calls = 0;
		const deliver = async () => {
			calls += 1;
			return { transient: "retain-network" };
		};
		time.advance(30_000 - 1);
		await outbox.drain(deliver, { all: true });
		expect(calls).toBe(0);
		expect(outbox.held()).toBe(true);
		expect(outbox.list().map((entry) => entry.attempts)).toEqual([1]);
		// Half-open admits the drain as the probe.
		time.advance(1);
		await outbox.drain(deliver, { all: true });
		expect(calls).toBe(1);
		expect(outbox.held()).toBe(false);
	});

	test("forget drops a parked document and abandonAll gives the rest up as abandoned", () => {
		const dropped: Array<[string, RetainDropCause]> = [];
		const outbox = new RetainOutbox({ now: clock().now, onDrop: (entry, cause) => dropped.push([entry.document_id, cause]) });
		outbox.enqueue(candidate({ document_id: "a" }));
		outbox.enqueue(candidate({ document_id: "b" }));
		expect(outbox.forget("sub-cursor", "a")).toBe(true);
		expect(outbox.forget("sub-cursor", "a")).toBe(false);
		expect(outbox.abandonAll()).toBe(1);
		expect(dropped).toEqual([["b", "abandoned"]]);
		expect(outbox.size()).toBe(0);
	});

	test("overlapping drains share one pass", async () => {
		const time = clock();
		const outbox = new RetainOutbox({ now: time.now, random: () => 0.5 });
		outbox.enqueue(candidate());
		let calls = 0;
		const { promise: release, resolve } = Promise.withResolvers<void>();
		const deliver = async () => {
			calls += 1;
			await release;
			return "delivered" as const;
		};
		const drains = Promise.all([outbox.drain(deliver, { all: true }), outbox.drain(deliver, { all: true })]);
		resolve();
		await drains;
		expect(calls).toBe(1);
	});
});

describe("RetainOutbox on disk", () => {
	test("the file is 0600 in a 0700 directory, hydrates on construction and compacts after a drain", async () => {
		const dir = tempDir();
		const path = join(dir, "state", "retain-outbox.jsonl");
		const time = clock();
		const first = new RetainOutbox({ path, now: time.now, random: () => 0.5 });
		expect(first.durable).toBe(true);
		first.enqueue(candidate({ document_id: "a" }));
		first.enqueue(candidate({ document_id: "b" }));
		// A replaced document appends a second line until the next compaction.
		first.enqueue(candidate({ document_id: "a", entry_id: "mem_9" }));
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(join(dir, "state")).mode & 0o777).toBe(0o700);
		expect(readFileSync(path, "utf8").trim().split("\n").length).toBe(3);

		const second = new RetainOutbox({ path, now: time.now, random: () => 0.5 });
		expect(second.list().map((entry) => [entry.document_id, entry.entry_id])).toEqual([
			["b", "mem_1"],
			["a", "mem_9"],
		]);
		// Hydration compacted: one line per entry, same mode.
		expect(readFileSync(path, "utf8").trim().split("\n").length).toBe(2);
		expect(statSync(path).mode & 0o777).toBe(0o600);

		time.advance(30_000);
		await second.drain(async (entry) => (entry.document_id === "b" ? "delivered" : { transient: "retain-server" }));
		const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as RetainOutboxEntry);
		expect(lines.map((entry) => [entry.document_id, entry.attempts])).toEqual([["a", 2]]);
		expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);

		await second.drain(async () => "delivered", { all: true });
		expect(readFileSync(path, "utf8")).toBe("");
	});

	test("malformed lines are skipped and the bound applies at hydrate", () => {
		const dir = tempDir();
		const path = join(dir, "retain-outbox.jsonl");
		const time = clock();
		const seed = new RetainOutbox({ path, now: time.now });
		for (const id of ["a", "b", "c"]) {
			seed.enqueue(candidate({ document_id: id }));
			time.advance(1);
		}
		const body = `${readFileSync(path, "utf8")}not json\n{"id":"x"}\n`;
		writeFileSync(path, body);
		const dropped: string[] = [];
		const hydrated = new RetainOutbox({ path, now: time.now, max: 2, onDrop: (entry) => dropped.push(entry.document_id) });
		expect(hydrated.list().map((entry) => entry.document_id)).toEqual(["b", "c"]);
		expect(dropped).toEqual(["a"]);
	});

	test("a missing file is an empty queue, not an error", () => {
		const dir = tempDir();
		const outbox = new RetainOutbox({ path: join(dir, "nothing-yet.jsonl") });
		expect(outbox.size()).toBe(0);
		expect(existsSync(join(dir, "nothing-yet.jsonl"))).toBe(false);
	});

	test("a failed save turns durable off and warns once; the next good save turns it back on (Greptile round 1)", () => {
		const dir = tempDir();
		// A regular file where the directory should be: every mkdir/append fails.
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "not a directory");
		const path = join(blocker, "retain-outbox.jsonl");
		const unsaved: string[] = [];
		const outbox = new RetainOutbox({ path, now: clock().now, onUnsaved: (entry) => unsaved.push(entry.document_id) });
		outbox.enqueue(candidate({ document_id: "a" }));
		outbox.enqueue(candidate({ document_id: "b" }));
		expect(outbox.durable).toBe(false);
		expect(outbox.stats().durable).toBe(false);
		expect(unsaved).toEqual(["a"]);
		expect(outbox.size()).toBe(2);
		// The disk comes back: the next save rewrites the whole queue, not just
		// the newest line, and durability is restored without a second warning.
		rmSync(blocker);
		outbox.enqueue(candidate({ document_id: "c" }));
		expect(outbox.durable).toBe(true);
		expect(unsaved).toEqual(["a"]);
		expect(readFileSync(path, "utf8").trim().split("\n").length).toBe(3);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	test("the attempt ceiling is checked before any replay (Greptile round 1)", async () => {
		const time = clock();
		const drops: Array<[string, RetainDropCause]> = [];
		let replays = 0;
		const deliver = async () => {
			replays += 1;
			return { transient: "retain-server" };
		};
		// One attempt: the live try was it. Dropped at enqueue, never replayed.
		const one = new RetainOutbox({ maxAttempts: 1, now: time.now, random: () => 0.5, onDrop: (entry, cause) => drops.push([entry.document_id, cause]) });
		one.enqueue(candidate({ document_id: "once" }));
		expect(one.size()).toBe(0);
		await one.drain(deliver, { all: true });
		expect(replays).toBe(0);
		expect(drops).toEqual([["once", "exhausted"]]);
		// Two attempts: exactly one replay, then the warning.
		const two = new RetainOutbox({ maxAttempts: 2, now: time.now, random: () => 0.5, onDrop: (entry, cause) => drops.push([entry.document_id, cause]) });
		two.enqueue(candidate({ document_id: "twice" }));
		await two.drain(deliver, { all: true });
		await two.drain(deliver, { all: true });
		expect(replays).toBe(1);
		expect(two.size()).toBe(0);
		expect(drops).toEqual([
			["once", "exhausted"],
			["twice", "exhausted"],
		]);
		// Hydrated from a file written under a higher ceiling: the spent entry
		// gets its warning on the first pass and no request.
		const dir = tempDir();
		const path = join(dir, "retain-outbox.jsonl");
		const older = new RetainOutbox({ path, maxAttempts: 10, now: time.now, random: () => 0.5 });
		older.enqueue(candidate({ document_id: "hydrated" }));
		await older.drain(deliver, { all: true });
		expect(replays).toBe(2);
		const tighter = new RetainOutbox({ path, maxAttempts: 2, now: time.now, random: () => 0.5, onDrop: (entry, cause) => drops.push([entry.document_id, cause]) });
		await tighter.drain(deliver, { all: true });
		expect(replays).toBe(2);
		expect(drops.at(-1)).toEqual(["hydrated", "exhausted"]);
		expect(readFileSync(path, "utf8")).toBe("");
	});
});

/** The Hindsight env the service reads at call time, restored afterwards. */
function hindsightEnv(): () => void {
	const names = ["HINDSIGHT_URL", "HINDSIGHT_API_KEY", "HINDSIGHT_BANKS"];
	const saved = new Map(names.map((name) => [name, process.env[name]]));
	process.env.HINDSIGHT_URL = "http://fake";
	process.env.HINDSIGHT_API_KEY = "test-bearer";
	process.env.HINDSIGHT_BANKS = "sub-cursor";
	return () => {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
}

const GRANTS = `[{"surfaces":["cursor"],"scopes":["graph"],"kinds":["fact","decision"]}]`;

function substrateWith(fake: HindsightFake, store: FakeStore, env: Record<string, string> = {}) {
	clearEnsuredBanks();
	const warnings: Array<Record<string, unknown>> = [];
	const config = loadConfig({ SUBSTRATE_MEMORY_GRANTS: GRANTS, ...env });
	const substrate = new Substrate(
		config,
		{ index: store as never, greptime: null, hindsightFetch: fake.fetch },
		{
			emitted: (sample) => {
				if (sample.kind === "warning" && sample.payload.action === "memory.retain") warnings.push(sample.payload);
			},
		},
	);
	return { substrate, warnings };
}

/** A subject-addressed fact: appends on repeat (no version dance) while every version shares one plane document. */
async function writeOne(substrate: Substrate, text: string, subject = "handoff-rule") {
	const written = await substrate.writeMemory({ scope: "graph:ut-1", kind: "fact", subject, text, writer: "cursor", source_event: "evt_e2e" });
	expect(written.outcome).toBe("accepted");
	await substrate.drainPendingRetains(2000);
	return written;
}

describe("Substrate retain outbox", () => {
	test("a transient failure parks without a warning and the replay lands after the plane recovers", async () => {
		const restore = hindsightEnv();
		try {
			const fake = new HindsightFake();
			const store = new FakeStore();
			const { substrate, warnings } = substrateWith(fake, store);
			fake.failRetainWith = 503;
			await writeOne(substrate, "fence every handoff");
			expect(fake.retains.length).toBe(0);
			expect(warnings).toEqual([]);
			expect(substrate.retainOutboxStats()).toMatchObject({ size: 1, attemptsTotal: 1, durable: false });

			fake.failRetainWith = null;
			await substrate.drainRetainOutbox({ all: true });
			expect(fake.retains.map((retained) => retained.item.content)).toEqual(["fence every handoff"]);
			expect(substrate.retainOutboxStats().size).toBe(0);
			expect(warnings).toEqual([]);
		} finally {
			restore();
		}
	});

	test("the replay re-reads the entry by id and skips what is gone or superseded", async () => {
		const restore = hindsightEnv();
		try {
			const fake = new HindsightFake();
			const store = new FakeStore();
			const { substrate, warnings } = substrateWith(fake, store);
			fake.failRetainWith = 503;
			const gone = await writeOne(substrate, "first rule", "rule-a");
			const stale = await writeOne(substrate, "second rule", "rule-b");
			expect(substrate.retainOutboxStats().size).toBe(2);
			store.rows.delete(gone.entry?.id ?? "");
			const staleRow = store.rows.get(stale.entry?.id ?? "");
			if (staleRow) staleRow.entry.superseded_by = "mem_newer";

			fake.failRetainWith = null;
			await substrate.drainRetainOutbox({ all: true });
			expect(fake.retains).toEqual([]);
			expect(substrate.retainOutboxStats().size).toBe(0);
			expect(warnings).toEqual([]);
		} finally {
			restore();
		}
	});

	test("a live success for the same document forgets its parked copy", async () => {
		const restore = hindsightEnv();
		try {
			const fake = new HindsightFake();
			const store = new FakeStore();
			const { substrate } = substrateWith(fake, store);
			fake.failRetainWith = 503;
			await writeOne(substrate, "v1 of the rule");
			expect(substrate.retainOutboxStats().size).toBe(1);
			fake.failRetainWith = null;
			await writeOne(substrate, "v2 of the rule");
			expect(fake.retains.map((retained) => retained.item.content)).toEqual(["v2 of the rule"]);
			expect(substrate.retainOutboxStats().size).toBe(0);
		} finally {
			restore();
		}
	});

	test("the exhausted warning is today's warning, emitted once per parked entry", async () => {
		const restore = hindsightEnv();
		try {
			const fake = new HindsightFake();
			const store = new FakeStore();
			const { substrate, warnings } = substrateWith(fake, store, { SUBSTRATE_RETAIN_MAX_ATTEMPTS: "2" });
			fake.failRetainWith = 503;
			const written = await writeOne(substrate, "fence every handoff");
			await substrate.drainRetainOutbox({ all: true });
			// The drop's warning is tracked like a forward; the bounded drain settles it.
			await substrate.drainPendingRetains(1000);
			expect(substrate.retainOutboxStats().size).toBe(0);
			expect(written.entry).toBeDefined();
			expect(warnings).toEqual([
				{
					action: "memory.retain",
					reason: "retain-server",
					bank: "sub-cursor",
					document_id: written.entry ? retainDocumentId(written.entry, written.idempotency_key) : "",
					entry_hash: written.entry?.entry_hash,
				},
			]);
		} finally {
			restore();
		}
	});

	test("a memory-only outbox gives its leftovers a warning at shutdown; a durable one keeps them", async () => {
		const restore = hindsightEnv();
		try {
			const fake = new HindsightFake();
			const memoryOnly = substrateWith(fake, new FakeStore());
			fake.failRetainWith = 503;
			await writeOne(memoryOnly.substrate, "lost on restart otherwise");
			await memoryOnly.substrate.drainPendingRetains(500, { abandon: true });
			expect(memoryOnly.warnings.map((payload) => payload.reason)).toEqual(["retain-server"]);
			expect(memoryOnly.substrate.retainOutboxStats().size).toBe(0);

			const dir = tempDir();
			const path = join(dir, "retain-outbox.jsonl");
			const durableFake = new HindsightFake();
			durableFake.failRetainWith = 503;
			const durable = substrateWith(durableFake, new FakeStore(), { SUBSTRATE_RETAIN_OUTBOX_PATH: path });
			await writeOne(durable.substrate, "kept for the next boot");
			await durable.substrate.drainPendingRetains(500, { abandon: true });
			expect(durable.warnings).toEqual([]);
			expect(durable.substrate.retainOutboxStats()).toMatchObject({ size: 1, durable: true });
			expect(readFileSync(path, "utf8").trim().split("\n").length).toBe(1);
		} finally {
			restore();
		}
	});

	test("a replay queued behind a live forward for the same document cannot land before it (Greptile round 1)", async () => {
		const restore = hindsightEnv();
		try {
			const fake = new HindsightFake();
			const store = new FakeStore();
			// A gate on the retain POST only: the live forward of v2 stalls inside
			// the plane while the replay of v1 falls due behind it.
			let gate: Promise<void> | null = null;
			const gated: FetchLike = async (input, init) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				if (gate !== null && init?.method === "POST" && url.endsWith("/memories")) await gate;
				return fake.fetch(input, init);
			};
			clearEnsuredBanks();
			const warnings: Array<Record<string, unknown>> = [];
			const substrate = new Substrate(
				loadConfig({ SUBSTRATE_MEMORY_GRANTS: GRANTS }),
				{ index: store as never, greptime: null, hindsightFetch: gated },
				{
					emitted: (sample) => {
						if (sample.kind === "warning" && sample.payload.action === "memory.retain") warnings.push(sample.payload);
					},
				},
			);
			fake.failRetainWith = 503;
			await writeOne(substrate, "v1 of the rule");
			expect(substrate.retainOutboxStats().size).toBe(1);
			fake.failRetainWith = null;

			const { promise: opened, resolve: open } = Promise.withResolvers<void>();
			gate = opened;
			const v2 = await substrate.writeMemory({ scope: "graph:ut-1", kind: "fact", subject: "handoff-rule", text: "v2 of the rule", writer: "cursor", source_event: "evt_e2e" });
			expect(v2.outcome).toBe("accepted");
			// The replay is due now and waits its turn in the document chain.
			const replay = substrate.drainRetainOutbox({ all: true });
			await substrate.drainPendingRetains(50);
			expect(fake.retains.length).toBe(0);
			open();
			await replay;
			await substrate.drainPendingRetains(2000);
			// v2 landed; the v1 replay found itself forgotten and sent nothing.
			expect(fake.retains.map((retained) => retained.item.content)).toEqual(["v2 of the rule"]);
			expect(fake.banks.get("sub-cursor")?.memories.map((memory) => memory.text)).toEqual(["v2 of the rule"]);
			expect(substrate.retainOutboxStats().size).toBe(0);
			expect(warnings).toEqual([]);
		} finally {
			restore();
		}
	});

	test("an outbox whose save failed is abandoned with warnings at shutdown like a memory-only one (Greptile round 1)", async () => {
		const restore = hindsightEnv();
		try {
			const dir = tempDir();
			const blocker = join(dir, "blocker");
			writeFileSync(blocker, "not a directory");
			const fake = new HindsightFake();
			fake.failRetainWith = 503;
			const { substrate, warnings } = substrateWith(fake, new FakeStore(), { SUBSTRATE_RETAIN_OUTBOX_PATH: join(blocker, "retain-outbox.jsonl") });
			await writeOne(substrate, "never reached the disk");
			expect(substrate.retainOutboxStats()).toMatchObject({ size: 1, durable: false });
			expect(warnings.map((payload) => payload.reason)).toEqual(["outbox-unsaved"]);
			await substrate.drainPendingRetains(500, { abandon: true });
			expect(warnings.map((payload) => payload.reason)).toEqual(["outbox-unsaved", "retain-server"]);
			expect(substrate.retainOutboxStats().size).toBe(0);
		} finally {
			restore();
		}
	});
});
