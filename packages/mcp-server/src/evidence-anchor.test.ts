/**
 * The evidence bundle's anchors and teachable moments (Phase 41, E-D1 and E-D2).
 *
 * Scratch ledger and fake RPC only, as `teachable-anchor.test.ts` does: no keypair, no
 * network, no live send. A teachable written through `writeMemory` lands in an hour; the
 * hour is anchored by freezing the row the hourly job would write; `buildGraphEvidence`
 * then reads the bundle through the production `verifyGraph` with the fake read-back
 * injected. What is asserted is what a reader of the bundle sees.
 */
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { formatMemo, formatMemoV2, headsRoot, hourEnd, merkleRootHex } from "@substrate/ledger";
import { buildGraphHeads, DEVNET_GENESIS_HASH } from "./anchor.ts";
import type { StoredLeaf } from "./event.ts";
import { loadConfig } from "./config.ts";
import { buildGraphEvidence, createObservability } from "./observe.ts";
import { FakeStore } from "./memory-write.test.ts";
import { Substrate } from "./service.ts";
import { ACCEPTED_TEACHABLE } from "./teachable.fixtures.ts";
import type { MemorySearch, MemorySearchPage, MemoryWriteRequest, SubstrateEvent } from "./types.ts";

const H = Date.UTC(2026, 8, 1, 10);
const HOUR = 3_600_000;
const NOW = H + 5 * HOUR;
const GRAPH = "ut-teach-41";
const SESSION = "sess-p41-anchor";
const PUBKEY = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const SIG = "sig-scratch-41";
const EXPLORER = `https://explorer.solana.com/tx/${SIG}?cluster=devnet`;
const hourIso = (ms: number) => new Date(ms).toISOString();

const HOURS = 5;
/** What one devnet read-back costs on the virtual clock: `HOURS` of them outlast the CLI's old 1,500 ms wait. */
const READ_MS = 350;
const OLD_BUDGET_MS = 1_500;
const CLOCK_START = Date.UTC(2026, 8, 1, 12);
/** Late enough that every hour of the fixture is closed for the ingest lag. */
const NOW_LATE = H + (HOURS + 1) * HOUR;
const hourAt = (index: number) => H + index * HOUR;

/** A `FakeStore` that also answers prefix searches, newest first. */
class ScratchIndex extends FakeStore {
	async searchMemoryPage(search: MemorySearch): Promise<MemorySearchPage> {
		const prefix = search.subjectPrefix ?? null;
		const kept = [...this.rows.values()]
			.map((row) => row.entry)
			.filter((row) => prefix === null || row.subject?.startsWith(prefix))
			.filter((row) => search.includeSuperseded || !row.superseded_by)
			.sort((a, b) => (b.created === a.created ? (b.id < a.id ? -1 : 1) : b.created < a.created ? -1 : 1));
		const limit = search.limit ?? 20;
		return { entries: kept.slice(0, limit), next: null };
	}
}

interface StoredRow extends SubstrateEvent {
	/** The ingest clock: every appended event lands in the hour set for it. */
	ingestedAt: number;
}

interface IngestRecord {
	event_id: string;
	event_ts: number;
	ingested_at: number;
}

interface ScratchLedger {
	greptime: {
		ensureAppendMode: () => Promise<boolean>;
		lastHash: (sessionId: string) => Promise<string | null>;
		insertEvent: (event: SubstrateEvent) => Promise<void>;
		readEvents: (column: string, value: string) => Promise<Array<Record<string, unknown>>>;
		graphIngest: (graphId: string) => Promise<IngestRecord[]>;
		firstIngestMs: () => Promise<number>;
		graphChainLeafHours: (graphId: string) => Promise<number[]>;
		hourLeaves: (hour: number) => Promise<Array<{ event_id: string; hash: string }>>;
		anchorForPeriod: (hour: number) => Promise<Record<string, unknown> | null>;
	};
	rows: Map<string, StoredRow>;
	/** The memo the frozen anchor row for `hour` carries, for the fake read-back. Hour H by default. */
	frozenMemo: (hour?: number) => string | null;
	/** The memo of the frozen anchor row that carries this transaction signature. */
	memoOf: (signature: string) => string | null;
	/** Freeze the anchor row for `hour` the way the hourly job would have written it. Hour H by default. */
	anchorHour: (hour?: number) => void;
	/** Freeze the anchor row for `hour` as a v2 memo over the per-(graph, session) heads. Hour H by default. */
	anchorHourV2: (hour?: number) => void;
	/** Ingest every event from here on into this hour. */
	ingestHour: (hour: number) => void;
}

/**
 * A scratch ledger: events keep their own timestamps (so chains verify), while ingest records land in the
 * hour set by `ingestHour` (hour H until it is changed), on a clock that advances per event.
 */
function scratchLedger(): ScratchLedger {
	const rows = new Map<string, StoredRow>();
	const tips = new Map<string, string>();
	const records: IngestRecord[] = [];
	const anchored = new Map<number, Record<string, unknown>>();
	const storedLeaves = new Map<number, StoredLeaf[]>();
	let clock = 0;
	let hourBase = H;

	const leaves = (hour: number) =>
		records
			.filter((record) => record.ingested_at >= hour && record.ingested_at < hour + HOUR)
			.sort((a, b) => a.ingested_at - b.ingested_at)
			.map((record) => ({ event_id: record.event_id, hash: rows.get(record.event_id)?.hash ?? "" }));

	const greptime = {
		ensureAppendMode: async () => true,
		lastHash: async (sessionId: string) => tips.get(sessionId) ?? null,
		insertEvent: async (event: SubstrateEvent) => {
			clock += 1;
			const ingestedAt = hourBase + 1000 * clock;
			rows.set(event.id, { ...event, ingestedAt });
			if (event.session_id) tips.set(event.session_id, event.hash);
			records.push({ event_id: event.id, event_ts: Date.parse(event.ts), ingested_at: ingestedAt });
		},
		readEvents: async (column: string, value: string) =>
			[...rows.values()]
				.filter((row) => String((row as unknown as Record<string, unknown>)[column]) === value)
				.map((row) => ({ ...row, ingestedAt: undefined, ts: Date.parse(row.ts), payload: JSON.stringify(row.payload) })),
		graphIngest: async (graphId: string) => {
			const ids = new Set([...rows.values()].filter((row) => row.graph_id === graphId).map((row) => row.id));
			return records.filter((record) => ids.has(record.event_id));
		},
		firstIngestMs: async () => H,
		graphChainLeafHours: async () => [],
		hourChainLeaves: async (hour: number) => storedLeaves.get(hour) ?? [],
		hourLeaves: async (hour: number) => leaves(hour),
		anchorForPeriod: async (hour: number) => anchored.get(hour) ?? null,
	};

	return {
		greptime,
		rows,
		frozenMemo: (hour = H) => {
			const row = anchored.get(hour);
			return row ? String(row.memo) : null;
		},
		memoOf: (signature: string) => {
			for (const row of anchored.values()) {
				if (row.tx_sig === signature) return String(row.memo);
			}
			return null;
		},
		anchorHour: (hour = H) => {
			const batch = leaves(hour);
			const root = merkleRootHex(batch.map((leaf) => leaf.hash));
			anchored.set(hour, {
				period_start: hourIso(hour),
				period_end: hourIso(hourEnd(hour)),
				root,
				event_count: batch.length,
				memo: formatMemo({ periodStartMs: hour, rootHex: root, count: batch.length }),
				// The first hour keeps `SIG`, which the single-hour tests assert.
				tx_sig: hour === H ? SIG : `${SIG}-${(hour - H) / HOUR}`,
				signer: PUBKEY,
				cluster: "devnet",
				slot: 42,
				anchored_at: hourIso(NOW),
			});
		},
		anchorHourV2: (hour = H) => {
			const batch = leaves(hour);
			const members = batch.map((leaf) => {
				const row = rows.get(leaf.event_id);
				if (!row) throw new Error(`hour member ${leaf.event_id} has no row`);
				return { id: row.id, hash: row.hash, prev: row.prev, graph_id: row.graph_id ?? "", session_id: row.session_id ?? "" };
			});
			const built = buildGraphHeads(members, hour);
			const root = merkleRootHex(batch.map((leaf) => leaf.hash));
			anchored.set(hour, {
				period_start: hourIso(hour),
				period_end: hourIso(hourEnd(hour)),
				root,
				event_count: batch.length,
				memo: formatMemoV2({ periodStartMs: hour, rootHex: root, count: batch.length, headsRootHex: headsRoot(built.records) }),
				tx_sig: hour === H ? SIG : `${SIG}-${(hour - H) / HOUR}`,
				signer: PUBKEY,
				cluster: "devnet",
				slot: 42,
				anchored_at: hourIso(NOW),
			});
			storedLeaves.set(hour, built.leaves);
		},
		ingestHour: (hour: number) => {
			hourBase = hour;
		},
	};
}

/** A fake devnet read-back: a genesis hash, and whatever `transactionMemo` answers for a signature. */
function fakeRpc(transactionMemo: (signature: string) => Promise<unknown>) {
	return { getGenesisHash: async () => DEVNET_GENESIS_HASH, transactionMemo };
}

/**
 * The verify budget reads `Date.now()`. Each devnet read-back advances a virtual clock by `READ_MS` instead of
 * waiting, so the budget's arithmetic runs for real without a wall-clock sleep.
 */
let elapsedMs = 0;
const restorers: Array<() => void> = [];
afterEach(() => {
	for (const restore of restorers.splice(0)) restore();
});

/** Start the virtual clock at zero: from here `Date.now()` moves only when a read-back advances it. */
function startVirtualClock(): void {
	elapsedMs = 0;
	const clock = spyOn(Date, "now").mockImplementation(() => CLOCK_START + elapsedMs);
	restorers.push(() => clock.mockRestore());
}

/** A devnet read-back that costs `READ_MS` on the virtual clock, then answers with the memo that signature froze. */
function timedRpc(ledger: ScratchLedger) {
	return fakeRpc(async (signature) => {
		elapsedMs += READ_MS;
		return signedMemo(ledger.memoOf(signature));
	});
}

/** The signed memo the anchored row describes, as devnet would return it. */
function signedMemo(memo: string | null) {
	return { memo, payer: PUBKEY, payerSigned: true, err: null, fee: 5000, slot: 42, blockTime: 1_790_000_000 };
}

/**
 * One scratch world: a ledger, a substrate over it, and an observability for the audit side. `verifyTimeoutMs`
 * is the whole-verify budget the substrate runs under; the default is the configured one.
 */
async function scratchWorld(verifyTimeoutMs?: number) {
	const ledger = scratchLedger();
	const base = loadConfig({});
	const substrate = new Substrate(
		{ ...base, solana: { ...base.solana, pubkey: PUBKEY }, verifyTimeoutMs: verifyTimeoutMs ?? base.verifyTimeoutMs },
		{ index: new ScratchIndex() as never, greptime: ledger.greptime as never },
	);
	const observed = createObservability(base);
	await observed.start();
	closers.push(() => observed.stop());
	return { ledger, substrate, observed };
}

const closers: Array<() => void> = [];
afterAll(() => {
	for (const close of closers) close();
});

/** Write the accepted teachable into the scratch ledger, for this graph and session. `overrides` make a further one. */
async function writeTeachable(substrate: Substrate, overrides: Partial<MemoryWriteRequest> = {}): Promise<void> {
	const written = await substrate.writeMemory({
		...ACCEPTED_TEACHABLE.request,
		scope: `graph:${GRAPH}`,
		graph_id: GRAPH,
		session_id: SESSION,
		...overrides,
	});
	expect(written.outcome).toBe("accepted");
}

/** `HOURS` closed hours, each holding one teachable and frozen by the hourly job. */
async function writeAnchoredTeachables(ledger: ScratchLedger, substrate: Substrate): Promise<void> {
	for (let index = 0; index < HOURS; index++) {
		ledger.ingestHour(hourAt(index));
		await writeTeachable(substrate, { subject: `teachable:budget-${index}`, text: `retry budget for hop ${index}` });
		ledger.anchorHour(hourAt(index));
	}
}

describe("evidence bundle anchors", () => {
	test("an anchored hour carries its transaction signature, slot and devnet explorer link", async () => {
		const { ledger, substrate, observed } = await scratchWorld();
		await writeTeachable(substrate);
		ledger.anchorHour();

		const bundle = await buildGraphEvidence(observed, substrate, GRAPH, [], undefined, {
			rpc: fakeRpc(async () => signedMemo(ledger.frozenMemo())) as never,
			now: NOW,
		});

		expect(bundle.anchors).toHaveLength(1);
		expect(bundle.anchors[0]).toMatchObject({
			period_start: hourIso(H),
			period_end: hourIso(hourEnd(H)),
			status: "anchored",
			root: expect.stringMatching(/^[0-9a-f]{64}$/),
			tx_sig: SIG,
			slot: 42,
			explorer_url: EXPLORER,
		});
		expect(bundle.anchors[0]?.event_count).toBeGreaterThan(0);
	});

	test("a pending hour is listed without a transaction, and does not fail", async () => {
		const { substrate, observed } = await scratchWorld();
		await writeTeachable(substrate);
		// Not anchored, and two hours after it closed: still inside the 3 h window in which it may anchor.
		const bundle = await buildGraphEvidence(observed, substrate, GRAPH, [], undefined, {
			rpc: fakeRpc(async () => {
				throw new Error("no read-back expected for a pending hour");
			}) as never,
			now: H + 2 * HOUR,
		});

		expect(bundle.anchors).toHaveLength(1);
		expect(bundle.anchors[0]?.status).toBe("pending");
		expect(bundle.anchors[0]).not.toHaveProperty("tx_sig");
		expect(bundle.anchors[0]).not.toHaveProperty("slot");
		expect(bundle.anchors[0]).not.toHaveProperty("explorer_url");
		expect(bundle.teachables[0]?.anchored).toBe(false);
	});

	test("an hour devnet cannot confirm is unverified, names the reason, and is not anchored", async () => {
		const { ledger, substrate, observed } = await scratchWorld();
		await writeTeachable(substrate);
		ledger.anchorHour();

		const bundle = await buildGraphEvidence(observed, substrate, GRAPH, [], undefined, {
			rpc: fakeRpc(async () => {
				throw new Error("devnet unreachable");
			}) as never,
			now: NOW,
		});

		expect(bundle.anchors[0]).toMatchObject({ status: "unverified", tx_sig: SIG });
		expect(bundle.anchors[0]?.reason).toContain("devnet unreachable");
		expect(bundle.teachables[0]?.anchored).toBe(false);
	});

	test("an hour whose devnet memo disagrees with the recomputed root is unverified", async () => {
		const { ledger, substrate, observed } = await scratchWorld();
		await writeTeachable(substrate);
		ledger.anchorHour();
		const wrong = formatMemo({ periodStartMs: H, rootHex: "0".repeat(64), count: 1 });

		const bundle = await buildGraphEvidence(observed, substrate, GRAPH, [], undefined, {
			rpc: fakeRpc(async () => signedMemo(wrong)) as never,
			now: NOW,
		});

		expect(bundle.anchors[0]?.status).toBe("unverified");
		expect(bundle.anchors[0]?.reason).toContain("recomputed");
	});

	test("a bundle of more hours than the old 1,500 ms budget allowed anchors every hour", async () => {
		const { ledger, substrate, observed } = await scratchWorld();
		await writeAnchoredTeachables(ledger, substrate);

		startVirtualClock();
		const bundle = await buildGraphEvidence(observed, substrate, GRAPH, [], undefined, {
			rpc: timedRpc(ledger) as never,
			now: NOW_LATE,
		});

		// The read-backs alone cost more than the old wait, so a client that stopped at 1,500 ms saw no bundle.
		expect(elapsedMs).toBeGreaterThan(OLD_BUDGET_MS);
		expect(bundle.anchors).toHaveLength(HOURS);
		expect(bundle.anchors.every((anchor) => anchor.status === "anchored")).toBe(true);
		expect(bundle.teachables).toHaveLength(HOURS);
		expect(bundle.teachables.every((teachable) => teachable.anchored)).toBe(true);
	});

	test("with the old 1,500 ms budget, the hour it cannot reach is unverified with a reason, and still listed", async () => {
		const { ledger, substrate, observed } = await scratchWorld(OLD_BUDGET_MS);
		await writeAnchoredTeachables(ledger, substrate);

		startVirtualClock();
		const bundle = await buildGraphEvidence(observed, substrate, GRAPH, [], undefined, {
			rpc: timedRpc(ledger) as never,
			now: NOW_LATE,
		});

		// Four read-backs fit inside the budget less its response margin; the fifth hour is past it.
		expect(bundle.anchors).toHaveLength(HOURS);
		expect(bundle.anchors[HOURS - 2]?.status).toBe("anchored");
		expect(bundle.anchors[HOURS - 1]?.status).toBe("unverified");
		expect(bundle.anchors[HOURS - 1]?.reason).toBeTruthy();
		expect(bundle.teachables.find((teachable) => teachable.hour === hourIso(hourAt(HOURS - 1)))?.anchored).toBe(false);
	});

	test("an anchored v2 hour whose event was edited after anchoring is unverified, and the evidence says the head failed", async () => {
		const { ledger, substrate, observed } = await scratchWorld();
		await writeTeachable(substrate);
		ledger.anchorHourV2();
		const altered = [...ledger.rows.values()].find((row) => row.payload.action === "teachable");
		if (!altered) throw new Error("the teachable should be written");
		// The hour is anchored over stored hashes; this changes the content and leaves the stored hash alone.
		ledger.rows.set(altered.id, { ...altered, payload: { ...altered.payload, content_sha256: "e".repeat(64) } });

		const bundle = await buildGraphEvidence(observed, substrate, GRAPH, [], undefined, {
			rpc: fakeRpc(async () => signedMemo(ledger.frozenMemo())) as never,
			now: NOW,
		});

		expect(bundle.anchors[0]).toMatchObject({ status: "unverified", head_failed: true });
		expect(bundle.anchors[0]?.reason).toContain("differs at");
	});
});

describe("evidence bundle teachable moments", () => {
	test("a teachable carries its graph id, its content digest, its hour and that hour's transaction", async () => {
		const { ledger, substrate, observed } = await scratchWorld();
		await writeTeachable(substrate);
		ledger.anchorHour();

		const bundle = await buildGraphEvidence(observed, substrate, GRAPH, [], undefined, {
			rpc: fakeRpc(async () => signedMemo(ledger.frozenMemo())) as never,
			now: NOW,
		});

		const stored = [...ledger.rows.values()].find(
			(row) => row.payload.action === "teachable",
		);
		if (!stored) throw new Error("the teachable event was not written");
		const storedDigest = String(stored.payload.content_sha256);

		expect(bundle.teachables).toHaveLength(1);
		expect(bundle.teachables[0]).toMatchObject({
			event_id: stored.id,
			graph_id: GRAPH,
			session_id: SESSION,
			content_sha256: storedDigest,
			hour: hourIso(H),
			anchored: true,
			tx_sig: SIG,
			explorer_url: EXPLORER,
		});
		expect(storedDigest).toMatch(/^[0-9a-f]{64}$/);
	});

	test("a teachable altered after its hour was anchored is not anchored, and an untouched teachable still is", async () => {
		const { ledger, substrate, observed } = await scratchWorld();
		await writeTeachable(substrate);
		await writeTeachable(substrate, { subject: "teachable:second-budget", text: "the second hop gets a budget of two" });
		ledger.anchorHour();

		const [altered, untouched] = [...ledger.rows.values()].filter((row) => row.payload.action === "teachable");
		if (!altered || !untouched) throw new Error("both teachable events should be written");
		// The hour is anchored over stored hashes. This changes one event's content and leaves its stored hash alone.
		ledger.rows.set(altered.id, { ...altered, payload: { ...altered.payload, content_sha256: "e".repeat(64) } });

		const bundle = await buildGraphEvidence(observed, substrate, GRAPH, [], undefined, {
			rpc: fakeRpc(async () => signedMemo(ledger.frozenMemo())) as never,
			now: NOW,
		});

		expect(bundle.anchors[0]?.status).toBe("anchored");
		expect(bundle.teachables.find((teachable) => teachable.event_id === altered.id)).toMatchObject({
			anchored: false,
			reason: "tampered",
		});
		expect(bundle.teachables.find((teachable) => teachable.event_id === untouched.id)).toMatchObject({ anchored: true });
	});
});
