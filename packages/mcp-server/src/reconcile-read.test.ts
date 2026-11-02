import { describe, expect, mock, test } from "bun:test";
import { type CacheRedis, ReadThroughCache } from "./cache.ts";
import type { EventQuery } from "./greptime.ts";
import type { ReconcileNodeHold } from "./index-store.ts";
import {
	type IndexReader,
	type LedgerReader,
	readIndexLeases,
	readIndexMemoryIds,
	readLedgerLatestLeases,
	readLedgerLeases,
	readLedgerMemoryIds,
} from "./reconcile-read.ts";
import { runReport } from "./reconcile-run.ts";

type Row = Record<string, unknown>;

const NOW = new Date("2026-11-02T12:00:00.000Z");
const HOUR = 3_600_000;
/** Epoch ms of an instant `hoursAgo` before NOW. */
const at = (hoursAgo: number): number => NOW.getTime() - hoursAgo * HOUR;
const SINCE = new Date(NOW.getTime() - 24 * HOUR).toISOString();
const CAPS = { ledgerRows: 500, ledgerLookups: 200, indexRows: 5_000, cacheKeys: 10_000 };

/** A ledger row. The payload is stored as JSON text, as the ledger stores it. */
function row(id: string, hoursAgo: number, fields: { kind: string; payload: Record<string, unknown> | string } & Row): Row {
	const { payload, ...rest } = fields;
	return { id, ts: at(hoursAgo), ...rest, payload: typeof payload === "string" ? payload : JSON.stringify(payload) };
}

/** A ledger over fixed rows: equality on `match`, `since` on ts, newest first, the row limit honoured. */
function fakeLedger(rows: Row[], calls: string[]): LedgerReader {
	return {
		queryEvents: async (query: EventQuery = {}) => {
			calls.push("queryEvents");
			const since = query.since === undefined ? Number.NEGATIVE_INFINITY : Date.parse(query.since);
			const matched = rows.filter((candidate) => {
				for (const [column, value] of Object.entries(query.match ?? {})) {
					if (value !== undefined && value !== null && candidate[column] !== value) return false;
				}
				return Number(candidate.ts) >= since;
			});
			matched.sort((a, b) => Number(b.ts) - Number(a.ts) || String(b.id).localeCompare(String(a.id)));
			if (query.order === "asc") matched.reverse();
			const limit = Math.min(query.limit ?? 50, 500);
			return matched.slice(0, limit).map((candidate) => (query.includePayload ? { ...candidate } : { ...candidate, payload: undefined }));
		},
	};
}

interface FakeIndexState {
	holds: ReconcileNodeHold[];
	memory: Array<{ id: string; created: number }>;
	graphs: string[];
}

/** An index over fixed rows. Each method is a read; `calls` records them so a test can see nothing else ran. */
function fakeIndex(state: FakeIndexState, calls: string[]): IndexReader {
	return {
		reconcileHolds: async (keys) => {
			calls.push("reconcileHolds");
			return state.holds.filter((hold) => keys.some((key) => key.graph_id === hold.graph_id && key.node_id === hold.node_id));
		},
		reconcileHeldNodes: async (cap) => {
			calls.push("reconcileHeldNodes");
			const held = state.holds.filter((hold) => hold.claimed_by !== null).sort((a, b) => a.graph_id.localeCompare(b.graph_id) || a.node_id.localeCompare(b.node_id));
			return { rows: held.slice(0, cap), truncated: held.length > cap };
		},
		reconcileMemoryIds: async (sinceIso, cap) => {
			calls.push("reconcileMemoryIds");
			const found = state.memory
				.filter((entry) => entry.created >= Date.parse(sinceIso))
				.sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1))
				.map((entry) => entry.id);
			return { rows: found.slice(0, cap), truncated: found.length > cap };
		},
		reconcileGraphIds: async (cap) => {
			calls.push("reconcileGraphIds");
			const found = [...state.graphs].sort();
			return { rows: found.slice(0, cap), truncated: found.length > cap };
		},
		reconcileMemoryRowsBefore: async (sinceIso) => {
			calls.push("reconcileMemoryRowsBefore");
			return state.memory.filter((entry) => entry.created < Date.parse(sinceIso)).length;
		},
	};
}

/** A cache client over fixed keys. SCAN pages at `pageSize` keys; every command is recorded in `commands`. */
function fakeRedis(keys: string[], commands: string[], pageSize = 500): CacheRedis {
	return {
		get: async () => {
			commands.push("get");
			return null;
		},
		set: async () => {
			commands.push("set");
		},
		incr: async () => {
			commands.push("incr");
			return 1;
		},
		scan: async (match, count, cursor) => {
			commands.push("scan");
			const pattern = new RegExp(`^${match.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
			const matching = keys.filter((key) => pattern.test(key)).sort();
			const start = Number(cursor);
			const size = Math.min(count, pageSize);
			return [start + size >= matching.length ? "0" : String(start + size), matching.slice(start, start + size)];
		},
		unlink: async (batch) => {
			commands.push(`unlink:${batch.length}`);
			return batch.length;
		},
	};
}

describe("readLedgerLeases", () => {
	test("the latest transition wins, a release frees the key, and a note without a lease action is ignored", async () => {
		const rows = [
			row("b1", 10, { kind: "claim", graph_id: "g1", node_id: "B", surface: "s2", session_id: "sess2", payload: { action: "granted", lease_epoch: 3 } }),
			row("b2", 5, { kind: "claim", graph_id: "g1", node_id: "B", surface: "s3", session_id: "sess3", payload: { action: "reclaimed", lease_epoch: 4 } }),
			row("c1", 10, { kind: "claim", graph_id: "g1", node_id: "C", surface: "s1", session_id: "sess1", payload: { action: "granted", lease_epoch: 1 } }),
			row("c2", 6, { kind: "note", graph_id: "g1", node_id: "C", surface: "s1", session_id: "sess1", payload: { action: "released", lease_epoch: 1 } }),
			row("d1", 8, { kind: "claim", graph_id: "g1", node_id: "D", surface: "s4", session_id: "sess4", payload: { action: "granted", lease_epoch: 2 } }),
			row("d2", 7, { kind: "warning", graph_id: "g1", node_id: "D", surface: "s4", session_id: "sess4", payload: { action: "forced", lease_epoch: 2 } }),
			row("f1", 9, { kind: "claim", graph_id: "g1", node_id: "F", surface: "s5", session_id: "sess5", payload: { action: "granted", lease_epoch: 5 } }),
			row("f2", 2, { kind: "warning", graph_id: "g1", node_id: "F", surface: "s5", session_id: "sess5", payload: { action: "expired", lease_epoch: 5 } }),
			row("g1", 3, { kind: "warning", graph_id: "g2", node_id: "G", surface: "s6", session_id: "sess6", payload: { action: "stolen", lease_epoch: 6 } }),
			row("e1", 4, { kind: "note", graph_id: "g1", node_id: "n9", surface: "s1", session_id: "sess1", payload: { outcome: "accepted", entry_id: "m1" } }),
			row("h1", 4, { kind: "note", graph_id: "g1", surface: "s1", session_id: "sess1", payload: { action: "released", lease_epoch: 1 } }),
			row("o1", 30, { kind: "claim", graph_id: "g1", node_id: "O", surface: "s9", session_id: "sess9", payload: { action: "granted", lease_epoch: 1 } }),
		];
		const calls: string[] = [];
		const read = await readLedgerLeases(fakeLedger(rows, calls), SINCE, CAPS.ledgerRows);
		expect(read.value.get("g1/B")).toEqual({ surface: "s3", session_id: "sess3", epoch: 4 });
		expect(read.value.get("g1/C")).toBeNull();
		expect(read.value.get("g1/D")).toBeNull();
		expect(read.value.get("g1/F")).toBeNull();
		expect(read.value.get("g2/G")).toEqual({ surface: "s6", session_id: "sess6", epoch: 6 });
		expect(read.value.has("g1/n9")).toBe(false);
		expect(read.value.has("g1/O")).toBe(false);
		expect(read.events).toBe(9);
		expect(read.truncated).toBe(false);
		expect(read.nodes.get("g1/C")).toEqual({ graph_id: "g1", node_id: "C" });
	});

	test("a kind that fills its cap reports truncated", async () => {
		const rows = [1, 2, 3].map((n) =>
			row(`claim${n}`, n, { kind: "claim", graph_id: "g1", node_id: `N${n}`, surface: "s", session_id: "x", payload: { action: "granted", lease_epoch: 1 } }),
		);
		const read = await readLedgerLeases(fakeLedger(rows, []), SINCE, 2);
		expect(read.truncated).toBe(true);
		expect(read.value.size).toBe(2);
	});
});

describe("readLedgerMemoryIds", () => {
	test("only accepted writes that name an entry id count, and a note without one is ignored", async () => {
		const rows = [
			row("n1", 3, { kind: "note", payload: { outcome: "accepted", entry_id: "m1" } }),
			row("n2", 2, { kind: "note", payload: { outcome: "accepted" } }),
			row("w1", 1, { kind: "warning", payload: { outcome: "accepted", entry_id: "m2" } }),
			row("n3", 1.5, { kind: "note", payload: { outcome: "rejected", entry_id: "m3" } }),
		];
		const read = await readLedgerMemoryIds(fakeLedger(rows, []), SINCE, CAPS.ledgerRows);
		expect([...read.value].sort()).toEqual(["m1", "m2"]);
		expect(read.events).toBe(2);
	});
});

describe("readIndexLeases and readIndexMemoryIds", () => {
	test("free and missing ledger nodes read as null, every held node is included, and a cap reports truncated", async () => {
		const state: FakeIndexState = {
			holds: [
				{ graph_id: "g1", node_id: "B", claimed_by: "s3", claim_session: "sess3", lease_epoch: 4 },
				{ graph_id: "g1", node_id: "C", claimed_by: null, claim_session: null, lease_epoch: 0 },
				{ graph_id: "g2", node_id: "G", claimed_by: "s6", claim_session: "sess6", lease_epoch: 6 },
				{ graph_id: "g1", node_id: "Z", claimed_by: "s8", claim_session: "sess8", lease_epoch: 7 },
			],
			memory: [],
			graphs: [],
		};
		const read = await readIndexLeases(
			fakeIndex(state, []),
			[
				{ graph_id: "g1", node_id: "B" },
				{ graph_id: "g1", node_id: "C" },
				{ graph_id: "g1", node_id: "X" },
			],
			CAPS.indexRows,
		);
		expect(read.value.get("g1/B")).toEqual({ surface: "s3", session_id: "sess3", epoch: 4 });
		expect(read.value.get("g1/C")).toBeNull();
		expect(read.value.get("g1/X")).toBeNull();
		expect(read.value.get("g2/G")).toEqual({ surface: "s6", session_id: "sess6", epoch: 6 });
		expect(read.value.get("g1/Z")).toEqual({ surface: "s8", session_id: "sess8", epoch: 7 });
		expect([...read.nodes.keys()].sort()).toEqual(["g1/B", "g1/Z", "g2/G"]);
		expect(read.truncated).toBe(false);

		const capped = await readIndexLeases(fakeIndex(state, []), [], 1);
		expect(capped.truncated).toBe(true);
	});

	test("index memory ids stop at the cap and report truncated", async () => {
		const state: FakeIndexState = {
			holds: [],
			memory: [
				{ id: "m1", created: at(1) },
				{ id: "m2", created: at(2) },
				{ id: "m3", created: at(3) },
			],
			graphs: [],
		};
		const read = await readIndexMemoryIds(fakeIndex(state, []), SINCE, 2);
		expect(read.value.size).toBe(2);
		expect(read.truncated).toBe(true);
	});
});

describe("readLedgerLatestLeases", () => {
	test("a hold granted before the window is found by its node, with no time bound", async () => {
		const rows = [
			row("old", 40, { kind: "claim", graph_id: "g1", node_id: "OLD", surface: "s9", session_id: "sess9", payload: { action: "granted", lease_epoch: 2 } }),
		];
		const read = await readLedgerLatestLeases(fakeLedger(rows, []), [{ graph_id: "g1", node_id: "OLD" }], 200);
		expect(read.value.get("g1/OLD")).toEqual({ surface: "s9", session_id: "sess9", epoch: 2 });
		expect(read.truncated).toBe(false);
	});

	test("a latest-lease lookup past its cap is truncated, so the run is not clean", async () => {
		const read = await readLedgerLatestLeases(fakeLedger([], []), [{ graph_id: "g1", node_id: "A" }, { graph_id: "g1", node_id: "B" }], 1);
		expect(read.truncated).toBe(true);
	});

	test("a newest release frees the key even when an older grant exists", async () => {
		const rows = [
			row("grant", 5, { kind: "claim", graph_id: "g1", node_id: "A", surface: "s1", session_id: "sess1", payload: { action: "granted", lease_epoch: 1 } }),
			row("release", 1, { kind: "note", graph_id: "g1", node_id: "A", surface: "s1", session_id: "sess1", payload: { action: "released", lease_epoch: 1 } }),
		];
		const read = await readLedgerLatestLeases(fakeLedger(rows, []), [{ graph_id: "g1", node_id: "A" }], 200);
		expect(read.value.has("g1/A")).toBe(true);
		expect(read.value.get("g1/A")).toBeNull();
	});

	test("a lookup whose rows run out before any transition is truncated", async () => {
		// The fake answers any limit with that many rows of an unrelated kind, so the test never copies LOOKUP_LIMIT.
		const silent: LedgerReader = {
			queryEvents: async (query: EventQuery = {}) =>
				Array.from({ length: query.limit ?? 0 }, (_, index) =>
					row(`hb${index}`, 1, { kind: "heartbeat", graph_id: "g1", node_id: "A", surface: "s1", session_id: "sess1", payload: { action: "heartbeat" } }),
				),
		};
		const read = await readLedgerLatestLeases(silent, [{ graph_id: "g1", node_id: "A" }], 200);
		expect(read.value.has("g1/A")).toBe(false);
		expect(read.truncated).toBe(true);
	});
});

describe("ReadThroughCache scan and unlink", () => {
	const genKeys = ["substrate:v1:gen:graph:g1", "substrate:v1:gen:graph:g2", "substrate:v1:gen:graph:g3", "substrate:v1:gen:graph:g4", "substrate:v1:gen:graph:g5"];

	test("a scan that reaches its cap reports truncated and never returns more than the cap", async () => {
		const commands: string[] = [];
		const cache = new ReadThroughCache({ redis: fakeRedis(genKeys, commands, 2), enabled: true, commandTimeoutMs: 1_000 });
		const capped = await cache.scanKeys("substrate:v1:gen:graph:*", 2);
		expect(capped.keys.length).toBe(2);
		expect(capped.truncated).toBe(true);
		const whole = await cache.scanKeys("substrate:v1:gen:graph:*", 10);
		expect(whole.keys.length).toBe(5);
		expect(whole.truncated).toBe(false);
	});

	test("with the cache off, a scan is empty and incomplete, and an unlink removes nothing", async () => {
		const cache = new ReadThroughCache({ redis: null, enabled: false });
		expect(await cache.scanKeys("substrate:v1:*", 10)).toEqual({ keys: [], truncated: true });
		expect(await cache.unlinkKeys(["substrate:v1:brief:a"])).toBe(0);
	});

	test("unlink runs in batches of at most 500 and returns the count removed", async () => {
		const commands: string[] = [];
		const cache = new ReadThroughCache({ redis: fakeRedis([], commands), enabled: true, commandTimeoutMs: 1_000 });
		const keys = Array.from({ length: 1201 }, (_, index) => `substrate:v1:brief:${index}`);
		expect(await cache.unlinkKeys(keys)).toBe(1201);
		expect(commands).toEqual(["unlink:500", "unlink:500", "unlink:201"]);
	});

	test("a failed batch keeps the batches already removed", async () => {
		let calls = 0;
		const redis: CacheRedis = {
			...fakeRedis([], []),
			unlink: async (batch) => {
				calls += 1;
				if (calls === 2) throw new Error("unlink failed");
				return batch.length;
			},
		};
		const cache = new ReadThroughCache({ redis, enabled: true, commandTimeoutMs: 1_000 });
		const keys = Array.from({ length: 501 }, (_, index) => `substrate:v1:brief:${index}`);
		const onBatch = mock((_removed: number) => {});
		await expect(cache.unlinkKeys(keys, onBatch)).rejects.toThrow("unlink failed");
		expect(onBatch).toHaveBeenCalledTimes(1);
		expect(onBatch).toHaveBeenCalledWith(500);
	});
});

/** The fixture both `runReport` tests share: a clean world, with its one drift shape replaced where a test needs it. */
function cleanWorld(): { ledgerRows: Row[]; index: FakeIndexState; keys: string[] } {
	return {
		ledgerRows: [
			row("c1", 1, { kind: "claim", graph_id: "g1", node_id: "n1", surface: "s1", session_id: "sess1", payload: { action: "granted", lease_epoch: 1 } }),
			row("c3", 48, { kind: "claim", graph_id: "g1", node_id: "n3", surface: "s7", session_id: "sess7", payload: { action: "granted", lease_epoch: 2 } }),
			row("m1", 1, { kind: "note", graph_id: "g1", payload: { outcome: "accepted", entry_id: "m1" } }),
		],
		index: {
			holds: [
				{ graph_id: "g1", node_id: "n1", claimed_by: "s1", claim_session: "sess1", lease_epoch: 1 },
				{ graph_id: "g1", node_id: "n2", claimed_by: null, claim_session: null, lease_epoch: 0 },
				{ graph_id: "g1", node_id: "n3", claimed_by: "s7", claim_session: "sess7", lease_epoch: 2 },
			],
			memory: [
				{ id: "m1", created: at(1) },
				{ id: "m0", created: at(30) },
			],
			graphs: ["g1"],
		},
		keys: ["substrate:v1:gen:graph:g1", "substrate:v1:brief:abc", "substrate:v1:memory-search:xyz"],
	};
}

function runWith(world: { ledgerRows: Row[]; index: FakeIndexState; keys: string[] }, commands: string[], ledgerCalls: string[], indexCalls: string[], cacheKeys = CAPS.cacheKeys) {
	return runReport({
		ledger: fakeLedger(world.ledgerRows, ledgerCalls),
		index: fakeIndex(world.index, indexCalls),
		cache: new ReadThroughCache({ redis: fakeRedis(world.keys, commands), enabled: true, commandTimeoutMs: 1_000 }),
		now: NOW,
		windowHours: 24,
		caps: { ...CAPS, cacheKeys },
	});
}

describe("runReport", () => {
	test("a clean fixture reports clean, the unchecked row is counted, and nothing is written", async () => {
		const commands: string[] = [];
		const ledgerCalls: string[] = [];
		const indexCalls: string[] = [];
		const report = await runWith(cleanWorld(), commands, ledgerCalls, indexCalls);
		expect(report.clean).toBe(true);
		expect(report.findings).toEqual([]);
		expect(report.first).toEqual({ lease: null, memory: null, generation: null });
		expect(Object.values(report.truncated).every((value) => value === false)).toBe(true);
		expect(report.unchecked_memory_rows).toBe(1);
		expect(report.counts["index.holds"]).toBe(2);
		expect(report.counts["cache.brief"]).toBe(1);
		// Every command the run issued is a SCAN; every index call is a read; every ledger call is queryEvents.
		expect(commands.every((command) => command === "scan")).toBe(true);
		expect(indexCalls.every((name) => name.startsWith("reconcile"))).toBe(true);
		expect(ledgerCalls.every((name) => name === "queryEvents")).toBe(true);
	});

	test("a dirty fixture reports the first mismatching key for each comparison", async () => {
		const world = cleanWorld();
		world.ledgerRows.push(
			// Ledger holds g1/n0, the index has no hold on it: the first lease finding.
			row("c0", 2, { kind: "claim", graph_id: "g1", node_id: "n0", surface: "s0", session_id: "sess0", payload: { action: "granted", lease_epoch: 1 } }),
			// Accepted write with no index row: the second memory finding.
			row("m3", 2, { kind: "note", graph_id: "g1", payload: { outcome: "accepted", entry_id: "m3" } }),
		);
		// The index no longer holds g1/n1, which the ledger still shows granted: the second lease finding.
		world.index.holds[0] = { graph_id: "g1", node_id: "n0", claimed_by: null, claim_session: null, lease_epoch: 0 };
		world.index.memory.push({ id: "m2", created: at(1) });
		world.keys.push("substrate:v1:gen:graph:g9");
		const report = await runWith(world, [], [], []);
		expect(report.clean).toBe(false);
		expect(report.first.lease?.key).toBe("g1/n0");
		expect(report.first.memory?.key).toBe("m2");
		expect(report.first.generation?.key).toBe("substrate:v1:gen:graph:g9");
	});

	test("a capped cache scan makes the run unclean", async () => {
		const world = cleanWorld();
		// Two brief keys against a cap of one: the scan of that class stops at its cap.
		world.keys.push("substrate:v1:brief:def");
		const report = await runWith(world, [], [], [], 1);
		expect(report.truncated["cache.brief"]).toBe(true);
		expect(report.counts["cache.brief"]).toBe(1);
		expect(report.clean).toBe(false);
	});
});
