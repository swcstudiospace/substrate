/**
 * Teachable anchor-coverage proof (Phase 29, CARD-03/CARD-04 isolated half).
 *
 * Scratch ledger + fake RPC only: never a real send, no live credentials, no
 * CLI spawn, no network. A `writeMemory` for a `teachable:` fact from the
 * 29-01 corpus lands its `teachable` event in an hour; `hourDigest` covers
 * the event id; a frozen anchor row plus a fake read-back lets
 * `verifyGraph` report that hour `anchored` with the teachable inside it.
 * Altering one event in the hour (a decoy from another graph) breaks the
 * whole-hour digest, and verify is non-ok naming the hour — the coverage
 * CARD-03 claims.
 *
 * The pubkey is a fake in-process constant wired through the config object,
 * never a `SOLANA_*` environment value: no keypair, no RPC override (the
 * read-back is injected), no chain interaction of any kind.
 */
import { describe, expect, test } from "bun:test";
import { formatMemo, hourEnd, merkleRootHex } from "@substrate/ledger";
import { DEVNET_GENESIS_HASH } from "./anchor.ts";
import { eventHash } from "./event.ts";
import { loadConfig } from "./config.ts";
import { FakeStore } from "./memory-write.test.ts";
import { Substrate } from "./service.ts";
import { ACCEPTED_TEACHABLE } from "./teachable.fixtures.ts";
import type { MemorySearch, MemorySearchPage, SubstrateEvent } from "./types.ts";

const H = Date.UTC(2026, 8, 1, 10);
const HOUR = 3_600_000;
const NOW = H + 5 * HOUR;
const PUBKEY = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";

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

export interface ScratchLedger {
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
 * A scratch ledger: events keep their own timestamps (so chains verify),
 * while ingest records land on a fixed clock in hour H (so digests and the
 * hour report are deterministic).
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
			const ids = new Set(
				[...rows.values()].filter((row) => row.graph_id === graphId).map((row) => row.id),
			);
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
				period_start: new Date(H).toISOString(),
				period_end: new Date(hourEnd(H)).toISOString(),
				root,
				event_count: batch.length,
				memo: formatMemo({ periodStartMs: H, rootHex: root, count: batch.length }),
				tx_sig: "sig-scratch-1",
				signer: PUBKEY,
				cluster: "devnet",
				slot: 42,
				anchored_at: new Date(NOW).toISOString(),
			};
		},
	};
}

export interface ScratchWorld {
	ledger: ScratchLedger;
	substrate: Substrate;
	rpc: {
		getGenesisHash: () => Promise<string>;
		transactionMemo: () => Promise<{
			memo: string | null;
			payer: string;
			payerSigned: boolean;
			err: null;
			fee: number;
			slot: number;
			blockTime: number;
		}>;
	};
}

function scratchWorld(): ScratchWorld {
	const ledger = scratchLedger();
	const index = new ScratchIndex();
	const base = loadConfig({});
	const substrate = new Substrate(
		{ ...base, solana: { ...base.solana, pubkey: PUBKEY } },
		{ index: index as never, greptime: ledger.greptime as never },
	);
	const rpc = {
		getGenesisHash: async () => DEVNET_GENESIS_HASH,
		transactionMemo: async () => ({
			memo: ledger.frozenMemo(),
			payer: PUBKEY,
			payerSigned: true,
			err: null,
			fee: 5000,
			slot: 42,
			blockTime: 1_790_000_000,
		}),
	};
	return { ledger, substrate, rpc };
}

/** The ledger id of the teachable note the write emitted for a session. */
function teachableEventId(ledger: ScratchLedger, session: string): string {
	const found = [...ledger.rows.values()].find(
		(row) => row.session_id === session && (row.payload as Record<string, unknown>)?.action === "teachable",
	);
	if (!found) throw new Error(`no teachable event for session ${session}`);
	return found.id;
}

describe("teachable anchor coverage", () => {
	test("the teachable event sits inside a verify-reported anchored hour", async () => {
		const { ledger, substrate, rpc } = scratchWorld();

		const written = await substrate.writeMemory({
			...ACCEPTED_TEACHABLE.request,
			scope: "graph:ut-teach-29",
			graph_id: "ut-teach-29",
			session_id: "sess-p29-anchor",
		});
		expect(written.outcome).toBe("accepted");
		expect(written.verified_persisted).toBe(true);

		const digest = await substrate.hourDigest(H, NOW);
		expect(digest.event_ids).toContain(teachableEventId(ledger, "sess-p29-anchor"));
		expect(digest.root).toMatch(/^[0-9a-f]{64}$/);

		ledger.anchorHour();
		const verdict = await substrate.verifyGraph("ut-teach-29", { now: NOW, rpc: rpc as never });

		expect(verdict.ok).toBe(true);
		expect(verdict.chain).toEqual({ ok: true });
		expect(verdict.hours).toHaveLength(1);
		expect(verdict.hours[0]).toMatchObject({
			period_start: new Date(H).toISOString(),
			status: "anchored",
			tx_sig: "sig-scratch-1",
		});
		expect(verdict.reason).toBeUndefined();
	});

	test("altering one event in the hour fails verify naming the hour", async () => {
		const { ledger, substrate, rpc } = scratchWorld();

		await substrate.writeMemory({
			...ACCEPTED_TEACHABLE.request,
			scope: "graph:ut-teach-29",
			graph_id: "ut-teach-29",
			session_id: "sess-p29-anchor",
		});
		// A second event in the same hour from another graph: the hour is
		// digested whole, so tampering with it breaks the teachable's hour.
		await substrate.emit({
			surface: "omp",
			kind: "note",
			summary: "unrelated decoy in the same hour",
			session_id: "sess-decoy",
			graph_id: "ut-other",
		});
		ledger.anchorHour();

		const decoy = [...ledger.rows.values()].find((row) => row.session_id === "sess-decoy");
		expect(decoy).toBeDefined();
		// The digest covers leaf hashes, so the tamper re-hashes the altered
		// event the way the ledger would have: even a self-consistent edit of
		// another event in the hour breaks the anchored coverage.
		const { ingestedAt, hash: _previous, ...unhashed } = decoy!;
		const tampered = { ...unhashed, summary: "tampered after anchoring" };
		ledger.rows.set(decoy!.id, { ...tampered, hash: eventHash(tampered), ingestedAt });

		const verdict = await substrate.verifyGraph("ut-teach-29", { now: NOW, rpc: rpc as never });

		expect(verdict.ok).toBe(false);
		expect(verdict.chain).toEqual({ ok: true });
		expect(verdict.hours[0]?.status).toBe("mismatch");
		expect(verdict.reason).toContain(new Date(H).toISOString());
	});
});
