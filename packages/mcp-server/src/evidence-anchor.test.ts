/**
 * The evidence bundle's anchors and teachable moments (Phase 41, E-D1 and E-D2).
 *
 * Scratch ledger and fake RPC only, as `teachable-anchor.test.ts` does: no keypair, no
 * network, no live send. A teachable written through `writeMemory` lands in an hour; the
 * hour is anchored by freezing the row the hourly job would write; `buildGraphEvidence`
 * then reads the bundle through the production `verifyGraph` with the fake read-back
 * injected. What is asserted is what a reader of the bundle sees.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { formatMemo, hourEnd, merkleRootHex } from "@substrate/ledger";
import { DEVNET_GENESIS_HASH } from "./anchor.ts";
import { loadConfig } from "./config.ts";
import { buildGraphEvidence, createObservability } from "./observe.ts";
import { FakeStore } from "./memory-write.test.ts";
import { Substrate } from "./service.ts";
import { ACCEPTED_TEACHABLE } from "./teachable.fixtures.ts";
import type { MemorySearch, MemorySearchPage, SubstrateEvent } from "./types.ts";

const H = Date.UTC(2026, 8, 1, 10);
const HOUR = 3_600_000;
const NOW = H + 5 * HOUR;
const GRAPH = "ut-teach-41";
const SESSION = "sess-p41-anchor";
const PUBKEY = "TestPubkey1111111111111111111111111111111";
const SIG = "sig-scratch-41";
const EXPLORER = `https://explorer.solana.com/tx/${SIG}?cluster=devnet`;
const hourIso = (ms: number) => new Date(ms).toISOString();

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
	/** Fixed ingest clock: every appended event lands in hour H. */
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
		hourLeaves: (hour: number) => Promise<Array<{ event_id: string; hash: string }>>;
		anchorForPeriod: (hour: number) => Promise<Record<string, unknown> | null>;
	};
	rows: Map<string, StoredRow>;
	/** The memo the frozen anchor row carries, for the fake read-back. */
	frozenMemo: () => string | null;
	/** Freeze the anchor row the way the hourly job would have written it. */
	anchorHour: () => void;
}

/**
 * A scratch ledger: events keep their own timestamps (so chains verify), while ingest
 * records land on a fixed clock in hour H (so digests and the hour report are deterministic).
 */
function scratchLedger(): ScratchLedger {
	const rows = new Map<string, StoredRow>();
	const tips = new Map<string, string>();
	const records: IngestRecord[] = [];
	let anchored: Record<string, unknown> | null = null;
	let clock = 0;

	const leaves = () =>
		records
			.filter((record) => record.ingested_at >= H && record.ingested_at < H + HOUR)
			.sort((a, b) => a.ingested_at - b.ingested_at)
			.map((record) => ({ event_id: record.event_id, hash: rows.get(record.event_id)?.hash ?? "" }));

	const greptime = {
		ensureAppendMode: async () => true,
		lastHash: async (sessionId: string) => tips.get(sessionId) ?? null,
		insertEvent: async (event: SubstrateEvent) => {
			clock += 1;
			const ingestedAt = H + 1000 * clock;
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
		hourLeaves: async (hour: number) => (hour === H ? leaves() : []),
		anchorForPeriod: async (hour: number) => (hour === H ? anchored : null),
	};

	return {
		greptime,
		rows,
		frozenMemo: () => (anchored ? String(anchored.memo) : null),
		anchorHour: () => {
			const batch = leaves();
			const root = merkleRootHex(batch.map((leaf) => leaf.hash));
			anchored = {
				period_start: hourIso(H),
				period_end: hourIso(hourEnd(H)),
				root,
				event_count: batch.length,
				memo: formatMemo({ periodStartMs: H, rootHex: root, count: batch.length }),
				tx_sig: SIG,
				signer: PUBKEY,
				cluster: "devnet",
				slot: 42,
				anchored_at: hourIso(NOW),
			};
		},
	};
}

/** A fake devnet read-back: a genesis hash, and whatever `transactionMemo` answers. */
function fakeRpc(transactionMemo: () => Promise<unknown>) {
	return { getGenesisHash: async () => DEVNET_GENESIS_HASH, transactionMemo };
}

/** The signed memo the anchored row describes, as devnet would return it. */
function signedMemo(memo: string | null) {
	return { memo, payer: PUBKEY, payerSigned: true, err: null, fee: 5000, slot: 42, blockTime: 1_790_000_000 };
}

/** One scratch world: a ledger, a substrate over it, and an observability for the audit side. */
async function scratchWorld() {
	const ledger = scratchLedger();
	const base = loadConfig({});
	const substrate = new Substrate(
		{ ...base, solana: { ...base.solana, pubkey: PUBKEY } },
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

/** Write the accepted teachable into the scratch ledger, for this graph and session. */
async function writeTeachable(substrate: Substrate): Promise<void> {
	const written = await substrate.writeMemory({
		...ACCEPTED_TEACHABLE.request,
		scope: `graph:${GRAPH}`,
		graph_id: GRAPH,
		session_id: SESSION,
	});
	expect(written.outcome).toBe("accepted");
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
});
