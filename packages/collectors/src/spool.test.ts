/**
 * The event spool's disk behaviour: what it keeps, what it drops and says so,
 * the file mode, the schedule, and the hostile files a crashed or concurrent
 * writer can leave behind. No network: the spool never opens a socket, and one
 * test proves it by making `fetch` throw.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	canonicalJson,
	contentKey,
	EventSpool,
	IDEMPOTENCY_KEY_PATTERN,
	spoolBackoffMs,
	spoolConfig,
	type SpoolCandidate,
	type SpoolDelivery,
	type SpoolDropReport,
	type SpoolEntry,
} from "./spool.ts";

let dir = "";
let clock = 0;
let drops: SpoolDropReport[] = [];
const realFetch = globalThis.fetch;
const realStderrWrite = process.stderr.write.bind(process.stderr);

beforeEach(() => {
	// The spool reports a broken disk or lock once on stderr; the tests assert the drop reports instead.
	process.stderr.write = (() => true) as typeof process.stderr.write;
	dir = mkdtempSync(join(tmpdir(), "spool-test-"));
	clock = 1_700_000_000_000;
	drops = [];
});

afterEach(() => {
	globalThis.fetch = realFetch;
	process.stderr.write = realStderrWrite;
});

function make(options: Partial<ConstructorParameters<typeof EventSpool>[0]> = {}): EventSpool {
	return new EventSpool({
		path: join(dir, "event-spool.jsonl"),
		now: () => clock,
		random: () => 0.5,
		onDrop: (report) => drops.push(report),
		lockWaitMs: 100,
		...options,
	});
}

function candidate(n: number, extra: Partial<SpoolCandidate> = {}): SpoolCandidate {
	return {
		key: `key-${String(n).padStart(6, "0")}`,
		collector: "test",
		source: "test.row",
		event: { surface: "claude-code", kind: "note", summary: `event ${n}`, ts: new Date(clock).toISOString() },
		reason: "unreachable",
		...extra,
	};
}

function fileText(): string {
	return readFileSync(join(dir, "event-spool.jsonl"), "utf8");
}

const delivered: SpoolDelivery = { kind: "delivered" };

describe("append", () => {
	test("creates the file 0600 and a state directory that is not world-accessible", () => {
		const spool = make({ path: join(dir, "nested", "event-spool.jsonl") });

		expect(spool.append(candidate(1)).ok).toBe(true);

		expect(statSync(join(dir, "nested", "event-spool.jsonl")).mode & 0o777).toBe(0o600);
		expect(statSync(join(dir, "nested")).mode & 0o077).toBe(0);
	});

	test("an existing wider file is tightened to 0600 on the next append", () => {
		writeFileSync(join(dir, "event-spool.jsonl"), "", { mode: 0o644 });
		make().append(candidate(1));

		expect(statSync(join(dir, "event-spool.jsonl")).mode & 0o777).toBe(0o600);
	});

	test("never touches the network and never drains: the hook path is one lock and one write", async () => {
		globalThis.fetch = (() => {
			throw new Error("the spool must not use the network");
		}) as unknown as typeof fetch;
		const spool = make();
		spool.append(candidate(1));
		spool.append(candidate(2));

		expect(spool.list().map((entry) => entry.key)).toEqual(["key-000001", "key-000002"]);
		expect(existsSync(join(dir, "event-spool.jsonl.lock"))).toBe(false);
	});

	test("an entry holds the body, key and schedule, and no credential field", () => {
		const spool = make();
		spool.append(candidate(1));

		const [entry] = spool.list();
		expect(entry?.attempts).toBe(1);
		expect(entry?.enqueued_at).toBe(clock);
		expect(entry?.next_at).toBe(clock + 30_000);
		expect(Object.keys(entry as SpoolEntry).sort()).toEqual(
			["attempts", "collector", "enqueued_at", "event", "id", "key", "last_reason", "next_at", "source", "v"].sort(),
		);
	});

	test("an unwritable spool is reported as a visible drop and never throws", () => {
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "not a directory");
		const spool = make({ path: join(blocker, "event-spool.jsonl") });

		const result = spool.append(candidate(1));

		expect(result.ok).toBe(false);
		expect(spool.writeFailures).toBe(1);
		expect(drops.map((report) => report.cause)).toEqual(["write_failed"]);
	});

	test("a body over the server's 1 MB cap is dropped visibly, not parked", () => {
		const spool = make();
		const big = candidate(1, { event: { surface: "claude-code", kind: "note", summary: "x".repeat(1_100_000) } });

		expect(spool.append(big)).toEqual({ ok: false, error: "oversize" });

		expect(existsSync(join(dir, "event-spool.jsonl"))).toBe(false);
		expect(drops.map((report) => [report.cause, report.count])).toEqual([["oversize", 1]]);
	});

	test("a ceiling of one attempt means the live try was the only one: dropped at once, visibly", () => {
		const spool = make({ maxAttempts: 1 });

		expect(spool.append(candidate(1)).ok).toBe(false);

		expect(drops.map((report) => report.cause)).toEqual(["attempts"]);
		expect(spool.stats().depth).toBe(0);
	});
});

describe("caps drop the oldest and say so", () => {
	test("over the line cap the oldest entries go, in order, each reported", () => {
		const spool = make({ max: 3 });
		for (let i = 1; i <= 5; i += 1) {
			clock += 10;
			spool.append(candidate(i));
		}

		expect(spool.list().map((entry) => entry.key)).toEqual(["key-000003", "key-000004", "key-000005"]);
		expect(drops.map((report) => [report.cause, report.sample[0]?.key])).toEqual([
			["overflow", "key-000001"],
			["overflow", "key-000002"],
		]);
	});

	test("over the byte cap the oldest entries go until it fits", () => {
		const spool = make({ maxBytes: 2048 });
		for (let i = 1; i <= 6; i += 1) {
			clock += 10;
			spool.append(candidate(i, { event: { surface: "claude-code", kind: "note", summary: "y".repeat(300) } }));
		}

		const stats = spool.stats();
		expect(stats.bytes).toBeLessThanOrEqual(2048);
		expect(stats.depth).toBeGreaterThan(0);
		expect(stats.depth).toBeLessThan(6);
		expect(drops.some((report) => report.cause === "bytes")).toBe(true);
		// What survived is the newest, contiguous run.
		const keys = spool.list().map((entry) => entry.key);
		expect(keys.at(-1)).toBe("key-000006");
	});

	test("a bulk drop reports its full count but samples a bounded number of entries", () => {
		const spool = make({ max: 1000 });
		for (let i = 1; i <= 60; i += 1) spool.append(candidate(i));
		const small = make({ max: 10 });
		// Re-opened under a smaller cap, the next append compacts the 51 excess entries in one pass.
		small.append(candidate(61));

		const overflow = drops.filter((report) => report.cause === "overflow");
		expect(overflow.reduce((sum, report) => sum + report.count, 0)).toBe(51);
		expect(Math.max(...overflow.map((report) => report.sample.length))).toBeLessThanOrEqual(20);
		expect(small.stats().depth).toBe(10);
	});
});

describe("TTL and attempts", () => {
	test("an entry older than the TTL is dropped visibly at the next drain and never sent", async () => {
		const spool = make({ ttlMs: 60_000 });
		spool.append(candidate(1));
		clock += 61_000;
		const sent: string[] = [];

		const report = await spool.drain(
			async (entry) => {
				sent.push(entry.key);
				return delivered;
			},
			{ budgetMs: 1000, all: true },
		);

		expect(sent).toEqual([]);
		expect(report.dropped).toBe(1);
		expect(drops.map((entry) => entry.cause)).toEqual(["ttl"]);
		expect(spool.stats().depth).toBe(0);
	});

	test("the TTL is also enforced when a cap compaction runs", () => {
		const spool = make({ ttlMs: 60_000, max: 2 });
		spool.append(candidate(1));
		clock += 61_000;
		spool.append(candidate(2));
		spool.append(candidate(3));
		spool.append(candidate(4));

		expect(spool.list().map((entry) => entry.key)).toEqual(["key-000003", "key-000004"]);
		expect(drops.map((entry) => entry.cause)).toContain("ttl");
	});

	test("an entry whose attempts reach the ceiling is dropped visibly, not retried forever", async () => {
		const spool = make({ maxAttempts: 3 });
		spool.append(candidate(1));
		let sends = 0;
		const retry = async (): Promise<SpoolDelivery> => {
			sends += 1;
			return { kind: "retry", reason: "http-503" };
		};

		clock += 3_600_000;
		await spool.drain(retry, { budgetMs: 1000 });
		expect(spool.list()[0]?.attempts).toBe(2);
		clock += 3_600_000;
		const last = await spool.drain(retry, { budgetMs: 1000 });

		expect(sends).toBe(2);
		expect(last.dropped).toBe(1);
		expect(spool.stats().depth).toBe(0);
		expect(drops.map((entry) => entry.cause)).toEqual(["attempts"]);
	});
});

describe("schedule", () => {
	test("backoff doubles from 30 s, caps at an hour, and jitters within ±20 %", () => {
		expect(spoolBackoffMs(0, () => 0.5)).toBe(30_000);
		expect(spoolBackoffMs(1, () => 0.5)).toBe(60_000);
		expect(spoolBackoffMs(3, () => 0.5)).toBe(240_000);
		expect(spoolBackoffMs(20, () => 0.5)).toBe(3_600_000);
		expect(spoolBackoffMs(0, () => 0)).toBe(24_000);
		expect(spoolBackoffMs(0, () => 0.999999)).toBeLessThanOrEqual(36_000);
		expect(spoolBackoffMs(500, () => 0.5)).toBe(3_600_000);
	});

	test("a drain leaves entries that are not due, and `all` replays them anyway", async () => {
		const spool = make();
		spool.append(candidate(1));
		const sent: string[] = [];
		const record = async (entry: SpoolEntry): Promise<SpoolDelivery> => {
			sent.push(entry.key);
			return delivered;
		};

		const early = await spool.drain(record, { budgetMs: 1000 });
		expect(early.delivered).toBe(0);
		expect(sent).toEqual([]);

		const forced = await spool.drain(record, { budgetMs: 1000, all: true });
		expect(forced.delivered).toBe(1);
		expect(sent).toEqual(["key-000001"]);
	});

	test("replays go oldest first, and a failed one backs off by its own attempt count", async () => {
		const spool = make();
		for (let i = 1; i <= 3; i += 1) spool.append(candidate(i));
		clock += 120_000;
		const sent: string[] = [];

		await spool.drain(
			async (entry) => {
				sent.push(entry.key);
				return entry.key === "key-000002" ? { kind: "retry", reason: "http-503" } : delivered;
			},
			{ budgetMs: 1000 },
		);

		expect(sent).toEqual(["key-000001", "key-000002", "key-000003"]);
		const [left] = spool.list();
		expect(left?.key).toBe("key-000002");
		expect(left?.attempts).toBe(2);
		expect(left?.next_at).toBe(clock + 60_000);
		expect(left?.last_reason).toBe("http-503");
	});

	test("a hold stops the pass and consumes nothing: attempts and schedule are untouched", async () => {
		const spool = make();
		spool.append(candidate(1));
		spool.append(candidate(2));
		const before = spool.list();
		clock += 120_000;
		let sends = 0;

		const report = await spool.drain(
			async () => {
				sends += 1;
				return { kind: "hold", reason: "unreachable" };
			},
			{ budgetMs: 1000 },
		);

		expect(sends).toBe(1);
		expect(report.held).toBe("unreachable");
		expect(spool.list()).toEqual(before);
	});

	test("three retryable failures in a row stop the pass: the ledger is not taking events", async () => {
		const spool = make();
		for (let i = 1; i <= 6; i += 1) spool.append(candidate(i));
		clock += 120_000;
		let sends = 0;

		const report = await spool.drain(
			async () => {
				sends += 1;
				return { kind: "retry", reason: "http-503" };
			},
			{ budgetMs: 1000 },
		);

		expect(sends).toBe(3);
		expect(report.held).toBe("consecutive-failures");
		expect(spool.list().map((entry) => entry.attempts)).toEqual([2, 2, 2, 1, 1, 1]);
	});

	test("the time budget stops a pass between entries", async () => {
		const spool = make();
		for (let i = 1; i <= 4; i += 1) spool.append(candidate(i));
		clock += 120_000;

		const report = await spool.drain(
			async () => {
				clock += 600;
				return delivered;
			},
			{ budgetMs: 1000 },
		);

		expect(report.budgetExhausted).toBe(true);
		expect(report.delivered).toBe(2);
		expect(spool.stats().depth).toBe(2);
	});

	test("a permanent refusal removes the entry; a delivery removes it", async () => {
		const spool = make();
		spool.append(candidate(1));
		spool.append(candidate(2));
		clock += 120_000;

		const report = await spool.drain(async (entry) => (entry.key === "key-000001" ? { kind: "refused", status: 400 } : delivered), {
			budgetMs: 1000,
		});

		expect(report).toMatchObject({ delivered: 1, refused: 1, remaining: 0 });
		expect(spool.stats().depth).toBe(0);
	});

	test("a delivery callback that throws is a retry, not a crash", async () => {
		const spool = make();
		spool.append(candidate(1));
		clock += 120_000;

		const report = await spool.drain(
			async () => {
				throw new Error("boom");
			},
			{ budgetMs: 1000 },
		);

		expect(report.retried).toBe(1);
		expect(spool.list()[0]?.attempts).toBe(2);
	});

	test("overlapping drains in one process share one pass", async () => {
		const spool = make();
		spool.append(candidate(1));
		clock += 120_000;
		let sends = 0;
		const gate = Promise.withResolvers<void>();
		const slow = async (): Promise<SpoolDelivery> => {
			sends += 1;
			await gate.promise;
			return delivered;
		};

		const first = spool.drain(slow, { budgetMs: 1000 });
		const second = spool.drain(slow, { budgetMs: 1000 });
		gate.resolve();

		expect(await second).toBe(await first);
		expect(sends).toBe(1);
	});
});

describe("crash windows and hostile files", () => {
	test("a crash between a delivery and the compaction leaves the entry, and the replay sends the same key and body again", async () => {
		const spool = make();
		spool.append(candidate(1));
		clock += 120_000;
		const seen: Array<{ key: string; event: unknown }> = [];

		// The compaction cannot take the lock: a fresh lock file stands for a process that died holding it.
		const first = await spool.drain(
			async (entry) => {
				seen.push({ key: entry.key, event: entry.event });
				writeFileSync(join(dir, "event-spool.jsonl.lock"), "");
				return delivered;
			},
			{ budgetMs: 1000 },
		);
		expect(first.delivered).toBe(1);
		expect(spool.stats().depth).toBe(1);

		// The dead holder's lock goes stale, a new process starts and replays the survivor.
		utimesSync(join(dir, "event-spool.jsonl.lock"), new Date(0), new Date(0));
		const second = await make().drain(
			async (entry) => {
				seen.push({ key: entry.key, event: entry.event });
				return delivered;
			},
			{ budgetMs: 1000 },
		);

		expect(second.delivered).toBe(1);
		expect(seen).toHaveLength(2);
		expect(seen[1]).toEqual(seen[0] as (typeof seen)[number]);
		expect(spool.stats().depth).toBe(0);
	});

	test("an event appended while a drain is running survives the drain's compaction", async () => {
		const spool = make();
		spool.append(candidate(1));
		clock += 120_000;

		await spool.drain(
			async () => {
				// A hook in another process appends mid-replay.
				make().append(candidate(2));
				return delivered;
			},
			{ budgetMs: 1000 },
		);

		expect(spool.list().map((entry) => entry.key)).toEqual(["key-000002"]);
	});

	test("a torn last line is ignored on read, counted, and the next append starts on a fresh line", () => {
		const spool = make();
		spool.append(candidate(1));
		const path = join(dir, "event-spool.jsonl");
		writeFileSync(path, `${readFileSync(path, "utf8")}{"v":1,"id":"abc","key":"key-0000`);

		expect(spool.list().map((entry) => entry.key)).toEqual(["key-000001"]);
		expect(spool.stats().malformed).toBe(1);

		spool.append(candidate(2));
		expect(spool.list().map((entry) => entry.key)).toEqual(["key-000001", "key-000002"]);
	});

	test("a garbled middle line and a line of the wrong shape are skipped, the rest still replay", async () => {
		const spool = make();
		spool.append(candidate(1));
		const path = join(dir, "event-spool.jsonl");
		writeFileSync(path, `${readFileSync(path, "utf8")}not json at all\n{"v":1,"id":"x"}\n`);
		spool.append(candidate(2));
		clock += 120_000;
		const sent: string[] = [];

		const report = await spool.drain(
			async (entry) => {
				sent.push(entry.key);
				return delivered;
			},
			{ budgetMs: 1000 },
		);

		expect(sent).toEqual(["key-000001", "key-000002"]);
		expect(report.delivered).toBe(2);
		// The compaction rewrote the file without the garbage.
		expect(fileText()).toBe("");
	});

	test("a lock left by a dead process is stolen, a live one is waited for and then reported", () => {
		const spool = make({ lockStaleMs: 10_000 });
		const lock = join(dir, "event-spool.jsonl.lock");
		writeFileSync(lock, "");
		utimesSync(lock, new Date(0), new Date(0));

		expect(spool.append(candidate(1)).ok).toBe(true);

		writeFileSync(lock, "");
		const blocked = spool.append(candidate(2));
		expect(blocked).toEqual({ ok: false, error: "locked" });
		expect(drops.map((report) => report.cause)).toEqual(["write_failed"]);
		expect(spool.list().map((entry) => entry.key)).toEqual(["key-000001"]);
	});

	test("concurrent appenders in separate processes never corrupt or lose a line", async () => {
		const script = `
			import { EventSpool } from ${JSON.stringify(join(import.meta.dir, "spool.ts"))};
			const [path, tag] = process.argv.slice(1);
			const spool = new EventSpool({ path, lockWaitMs: 5000 });
			for (let i = 0; i < 25; i += 1) {
				const result = spool.append({
					key: "key-" + tag + "-" + String(i).padStart(3, "0"),
					collector: "t",
					source: "t",
					event: { surface: "claude-code", kind: "note", summary: "p".repeat(2000) + tag + i },
					reason: "x",
				});
				if (!result.ok) process.exit(3);
			}
		`;
		const path = join(dir, "event-spool.jsonl");
		const children = ["a", "b", "c", "d"].map((tag) =>
			Bun.spawn(["bun", "--no-env-file", "-e", script, path, tag], { stdout: "pipe", stderr: "pipe" }),
		);
		const codes = await Promise.all(children.map((child) => child.exited));

		expect(codes).toEqual([0, 0, 0, 0]);
		const entries = make({ path, max: 1000 }).list();
		expect(entries).toHaveLength(100);
		expect(new Set(entries.map((entry) => entry.key)).size).toBe(100);
		expect(make({ path }).stats().malformed).toBe(0);
	});
});

describe("a failing disk", () => {
	const enospc = (): never => {
		throw Object.assign(new Error("no space"), { code: "ENOSPC" });
	};
	/** A write that puts a few bytes in the temp file and then fails, like a full disk. */
	const partialThenFail = (path: string, body: string): never => {
		writeFileSync(path, body.slice(0, 10));
		return enospc();
	};

	function tmpFiles(): string[] {
		return readdirSync(dir).filter((name) => name.endsWith(".tmp"));
	}

	test("a compaction whose write fails reports no drops, however often it is retried; the later good one reports them once", async () => {
		const spool = make({ ttlMs: 60_000 });
		spool.append(candidate(1));
		clock += 61_000;
		const failing = make({ ttlMs: 60_000, io: { writeFile: enospc } });

		const first = await failing.drain(async () => delivered, { budgetMs: 1000, all: true });
		await failing.drain(async () => delivered, { budgetMs: 1000, all: true });

		// The entry is still in the file, so nothing was dropped yet and nothing was announced.
		expect(drops).toEqual([]);
		expect(first.dropped).toBe(1);
		expect(spool.stats().depth).toBe(1);

		await make({ ttlMs: 60_000 }).drain(async () => delivered, { budgetMs: 1000, all: true });

		expect(drops.map((report) => [report.cause, report.count])).toEqual([["ttl", 1]]);
		expect(spool.stats().depth).toBe(0);
	});

	test("a write that fails half way leaves no temp file behind, and neither does a failed rename", async () => {
		const spool = make();
		spool.append(candidate(1));
		clock += 120_000;

		await make({ io: { writeFile: partialThenFail } }).drain(async () => delivered, { budgetMs: 1000 });
		expect(tmpFiles()).toEqual([]);
		await make({ io: { rename: enospc } }).drain(async () => delivered, { budgetMs: 1000 });
		expect(tmpFiles()).toEqual([]);

		// The entry survived both failed write-backs and is replayed (and settled) by a healthy pass.
		expect(spool.list().map((entry) => entry.key)).toEqual(["key-000001"]);
	});

	test("a compaction sweeps orphaned temp files older than the stale-lock age, a bounded few at a time, and leaves young and foreign ones", async () => {
		const spool = make({ lockStaleMs: 10_000 });
		spool.append(candidate(1));
		const old = [1, 2, 3, 4, 5, 6, 7, 8].map((pid) => join(dir, `event-spool.jsonl.${pid}.tmp`));
		for (const path of old) {
			writeFileSync(path, "partial");
			utimesSync(path, new Date(0), new Date(0));
		}
		const young = join(dir, "event-spool.jsonl.99999.tmp");
		writeFileSync(young, "in flight");
		const foreign = join(dir, "other-file.tmp");
		writeFileSync(foreign, "not ours");
		utimesSync(foreign, new Date(0), new Date(0));
		clock += 120_000;

		await spool.drain(async () => delivered, { budgetMs: 1000 });
		expect(old.filter((path) => existsSync(path))).toHaveLength(3);
		spool.append(candidate(2));
		clock += 120_000;
		await spool.drain(async () => delivered, { budgetMs: 1000 });

		expect(old.filter((path) => existsSync(path))).toHaveLength(0);
		expect(existsSync(young)).toBe(true);
		expect(existsSync(foreign)).toBe(true);
	});

	test("a short write is completed: every byte lands and the line parses", () => {
		const spool = make({
			io: { write: (fd, data, offset, length) => writeSync(fd, data, offset, Math.min(length, 7)) },
		});

		expect(spool.append(candidate(1)).ok).toBe(true);
		expect(spool.append(candidate(2)).ok).toBe(true);

		expect(spool.list().map((entry) => entry.key)).toEqual(["key-000001", "key-000002"]);
		expect(spool.stats().malformed).toBe(0);
	});

	test("a write that stops half way fails the append, is reported, and leaves no torn tail", () => {
		make().append(candidate(1));
		const before = fileText();
		let calls = 0;
		const spool = make({
			io: {
				write: (fd, data, offset, length) => {
					calls += 1;
					return calls === 1 ? writeSync(fd, data, offset, Math.min(length, 20)) : 0;
				},
			},
		});

		const result = spool.append(candidate(2));

		expect(result).toEqual({ ok: false, error: "EIO" });
		expect(drops.map((report) => report.cause)).toEqual(["write_failed"]);
		expect(fileText()).toBe(before);
		expect(spool.stats().malformed).toBe(0);
		expect(make().append(candidate(3)).ok).toBe(true);
		expect(make().list().map((entry) => entry.key)).toEqual(["key-000001", "key-000003"]);
	});
});

describe("stats", () => {
	test("reports depth, bytes, age and due count, and no event body", () => {
		const spool = make();
		spool.append(candidate(1));
		clock += 31_000;
		spool.append(candidate(2));

		const stats = spool.stats();

		expect(stats.depth).toBe(2);
		expect(stats.due).toBe(1);
		expect(stats.oldestAt).toBe(1_700_000_000_000);
		expect(stats.bytes).toBe(statSync(join(dir, "event-spool.jsonl")).size);
		expect(Object.keys(stats)).not.toContain("event");
	});

	test("an absent file is an empty spool and stats creates nothing", () => {
		const spool = make({ path: join(dir, "missing", "event-spool.jsonl") });

		expect(spool.stats()).toMatchObject({ depth: 0, bytes: 0, oldestAt: null, due: 0 });
		expect(existsSync(join(dir, "missing"))).toBe(false);
	});
});

describe("spoolConfig", () => {
	test("defaults: off, 5000 lines, 8 MB, 48 h, 12 attempts", () => {
		expect(spoolConfig({})).toEqual({ mode: "off", max: 5000, maxBytes: 8_388_608, ttlMs: 48 * 3_600_000, maxAttempts: 12, warnings: [] });
	});

	test("on is exact and case-insensitive; anything else is off, with a warning for a non-empty unknown value", () => {
		expect(spoolConfig({ SUBSTRATE_EVENT_SPOOL: " ON " }).mode).toBe("on");
		expect(spoolConfig({ SUBSTRATE_EVENT_SPOOL: "off" })).toMatchObject({ mode: "off", warnings: [] });
		const typo = spoolConfig({ SUBSTRATE_EVENT_SPOOL: "yes" });
		expect(typo.mode).toBe("off");
		expect(typo.warnings).toEqual(["SUBSTRATE_EVENT_SPOOL must be off or on; using off"]);
	});

	test("a byte cap below the 1024 minimum is raised to it with a warning, so status and enforcement agree", () => {
		const config = spoolConfig({ SUBSTRATE_EVENT_SPOOL_MAX_BYTES: "512" });

		expect(config.maxBytes).toBe(1024);
		expect(config.warnings).toEqual(["SUBSTRATE_EVENT_SPOOL_MAX_BYTES is below the minimum 1024; using 1024"]);
		expect(spoolConfig({ SUBSTRATE_EVENT_SPOOL_MAX_BYTES: "1024" }).warnings).toEqual([]);
		// "0" is not a positive integer at all: the default, with the malformed-value warning.
		expect(spoolConfig({ SUBSTRATE_EVENT_SPOOL_MAX_BYTES: "0" })).toMatchObject({ maxBytes: 8_388_608 });
	});

	test("an invalid cap falls back to its default with a warning, and an absurd one is clamped to the ceiling", () => {
		const config = spoolConfig({
			SUBSTRATE_EVENT_SPOOL_MAX: "-5",
			SUBSTRATE_EVENT_SPOOL_MAX_BYTES: "lots",
			SUBSTRATE_EVENT_SPOOL_TTL_H: "99999",
			SUBSTRATE_EVENT_SPOOL_MAX_ATTEMPTS: "0",
		});

		expect(config.max).toBe(5000);
		expect(config.maxBytes).toBe(8_388_608);
		expect(config.ttlMs).toBe(720 * 3_600_000);
		expect(config.maxAttempts).toBe(12);
		expect(config.warnings).toHaveLength(4);
	});
});

describe("keys", () => {
	test("canonicalJson ignores key order at every depth and drops undefined", () => {
		expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe(canonicalJson({ a: { c: undefined, d: [1, { y: 2, z: 1 }] }, b: 1 }));
		expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
	});

	test("a content key is deterministic, separates different content, and fits the wire alphabet and length", () => {
		const a = contentKey(["grok", "claude-code", "s1", "note", "2026-01-01T00:00:00.000Z", "hello", "{}"]);
		const b = contentKey(["grok", "claude-code", "s1", "note", "2026-01-01T00:00:00.000Z", "hello", "{}"]);
		const c = contentKey(["grok", "claude-code", "s1", "note", "2026-01-01T00:00:00.001Z", "hello", "{}"]);

		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(IDEMPOTENCY_KEY_PATTERN.test(a)).toBe(true);
	});
});

describe("directory handling", () => {
	test("the spool lives wherever its path says, and a pre-existing directory keeps its own mode", () => {
		const shared = join(dir, "shared");
		mkdirSync(shared, { mode: 0o755 });
		make({ path: join(shared, "event-spool.jsonl") }).append(candidate(1));

		expect(statSync(join(shared, "event-spool.jsonl")).mode & 0o777).toBe(0o600);
		expect(statSync(shared).mode & 0o777).toBe(0o755);
	});
});
