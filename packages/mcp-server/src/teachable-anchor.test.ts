import { describe, expect, test } from "bun:test";
import { formatMemo, hourEnd, merkleRootHex } from "@substrate/ledger";
import { loadConfig } from "./config.ts";
import { INGEST_LAG_MS } from "./greptime.ts";
import type { ClaimResult, MemoryStore, NewMemoryEntry } from "./memory-write.ts";
import { Substrate } from "./service.ts";
import type { MemoryEntry, SubstrateEvent } from "./types.ts";

/**
 * CARD-03 proof: every teachable is covered by the hourly anchor.
 *
 * The claim is demonstrated, not asserted, on a scratch ledger with a
 * fake-RPC read-back — never a real send, no SOLANA_* env, no CLI, no
 * network. The path under proof is the normal one: the teachable emit from
 * 29-01 is a plain `note` event, so server ingest order, `hourDigest` and
 * `verifyGraph` cover it with zero anchor-code changes.
 */
const HOUR = 3_600_000;
const H = Date.UTC(2026, 9, 10, 10);
const START_ISO = new Date(H).toISOString();
const END_ISO = new Date(H + HOUR).toISOString();
const CLOSED = hourEnd(H) + INGEST_LAG_MS;
const PUBKEY = "TestPubkey1111111111111111111111111111111";

/** The narrowest store the accepted-fact path needs: claims granted, rows read back. */
class ScratchMemoryStore implements MemoryStore {
	private readonly rows = new Map<string, MemoryEntry>();
	private readonly claims = new Map<string, string>();
	private holders = 0;

	async claimWrite(input: { key: string; explicit: boolean; entryHash: string; requestHash: string; entryId: string }): Promise<ClaimResult> {
		const holder = `hold_${++this.holders}`;
		this.claims.set(input.key, holder);
		return { claimed: true, holder, tookOverFrom: null };
	}

	async finishWrite(): Promise<void> {}
	async releaseWrite(): Promise<void> {}
	async restoreWrite(): Promise<void> {}
	async standingEntry(): Promise<MemoryEntry | null> {
		return null;
	}

	async insertEntry(
		row: NewMemoryEntry,
		claim: { key: string; holder: string },
	): Promise<{ ok: true; entry: MemoryEntry } | { ok: false; reason: "standing-moved" | "claim-lost" | "standing-exists" }> {
		if (this.claims.get(claim.key) !== claim.holder) return { ok: false, reason: "claim-lost" };
		const entry: MemoryEntry = {
			id: row.id,
			scope: row.scope,
			kind: row.kind,
			text: row.text,
			writer: row.writer,
			actor: row.actor,
			trust: row.trust,
			ttl: row.ttl,
			created: new Date().toISOString(),
			version: row.version,
			entry_hash: row.entry_hash,
			needs_reverification: false,
			...(row.subject ? { subject: row.subject } : {}),
			...(row.session_id ? { session_id: row.session_id } : {}),
			...(row.graph_id ? { graph_id: row.graph_id } : {}),
			...(row.idempotency_key ? { idempotency_key: row.idempotency_key } : {}),
		};
		this.rows.set(row.id, entry);
		return { ok: true, entry };
	}

	async readEntry(id: string): Promise<MemoryEntry | null> {
		return this.rows.get(id) ?? null;
	}

	async quarantineEntry(): Promise<string> {
		return "memq_1";
	}

	async enqueueReview(): Promise<string> {
		return "rev_1";
	}

	async releaseReviews(): Promise<number> {
		return 0;
	}
}

interface ScratchHour {
	rows: Array<Record<string, unknown>>;
	leaves: Array<{ event_id: string; ingested_at: number; hash: string }>;
	records: Array<{ event_id: string; event_ts: number; ingested_at: number }>;
}

/** A scratch substrate: the write path stores, the ledger captures, the anchor side is filled in after. */
function scratch() {
	const captured: SubstrateEvent[] = [];
	let hour: ScratchHour | null = null;
	let anchor: Record<string, unknown> | null = null;
	const greptime = {
		ensureAppendMode: async () => true,
		lastHash: async () => null,
		insertEvent: async (event: SubstrateEvent) => {
			captured.push(event);
		},
		readEvents: async () => hour?.rows ?? [],
		graphIngest: async () => hour?.records ?? [],
		firstIngestMs: async () => (hour ? H : null),
		hourLeaves: async () => hour?.leaves ?? [],
		anchorForPeriod: async () => anchor,
	};
	const substrate = new Substrate(loadConfig({ SOLANA_ANCHOR_PUBKEY: PUBKEY }), {
		index: new ScratchMemoryStore() as never,
		greptime: greptime as never,
	});
	return {
		substrate,
		captured,
		place: (next: ScratchHour | null) => {
			hour = next;
		},
		anchor: (next: Record<string, unknown> | null) => {
			anchor = next;
		},
	};
}

function rpcReturning(memo: string | null) {
	return {
		getGenesisHash: async () => "EtWTRABZaYq6iMfeYKouRu166VU2xqaEyCydFLPYGEC",
		transactionMemo: async () => ({ memo, payer: PUBKEY, payerSigned: true, err: null, fee: 5000, slot: 42, blockTime: null }),
	};
}

/** House the captured teachable event in hour H: rows, leaves and ingest records off its id and hash. */
function houseInHour(event: SubstrateEvent): { world: ScratchHour; root: string; memo: string } {
	const world: ScratchHour = {
		rows: [{ ...event, ts: Date.parse(event.ts), payload: JSON.stringify(event.payload) }],
		leaves: [{ event_id: event.id, ingested_at: H + 1000, hash: event.hash }],
		records: [{ event_id: event.id, event_ts: Date.parse(event.ts), ingested_at: H + 1000 }],
	};
	const root = merkleRootHex([event.hash]);
	const memo = formatMemo({ periodStartMs: H, rootHex: root, count: 1 });
	return { world, root, memo };
}

function anchorRow(root: string, memo: string, over: Record<string, unknown> = {}) {
	return {
		period_start: START_ISO,
		period_end: END_ISO,
		root,
		event_count: 1,
		memo,
		tx_sig: "sig-teachable-1",
		signer: PUBKEY,
		cluster: "devnet",
		slot: 42,
		anchored_at: new Date(H + 5 * HOUR).toISOString(),
		...over,
	};
}

const TEACHABLE_WRITE = {
	scope: "graph:ut-1",
	kind: "fact" as const,
	text: "retry with a capped budget and backoff",
	writer: "hermes",
	subject: "teachable:retry-budget",
	session_id: "sess-anchor-1",
	graph_id: "ut-1",
};

describe("teachable anchor coverage", () => {
	test("an accepted teachable's event sits in an hour verify reports anchored", async () => {
		const world = scratch();

		const result = await world.substrate.writeMemory({ ...TEACHABLE_WRITE });
		expect(result.outcome).toBe("accepted");
		expect(result.verified_persisted).toBe(true);

		const trail = world.captured.filter((event) => event.payload["action"] === "teachable");
		expect(trail).toHaveLength(1);
		const event = trail[0] as SubstrateEvent;

		const { world: housed, root, memo } = houseInHour(event);
		world.place(housed);

		// The hour's digest covers the teachable event id.
		const digest = await world.substrate.hourDigest(H, CLOSED);
		expect(digest.event_ids).toContain(event.id);
		expect(digest.event_count).toBe(1);

		// And verify reports that hour anchored, with the event inside it.
		world.anchor(anchorRow(root, memo));
		const verdict = await world.substrate.verifyGraph("ut-1", { now: H + 5 * HOUR, rpc: rpcReturning(memo) as never });

		expect(verdict.ok).toBe(true);
		expect(verdict.hours).toHaveLength(1);
		expect(verdict.hours[0]).toMatchObject({ period_start: START_ISO, status: "anchored", event_count: 1, root });
		expect(verdict.uncovered).toEqual({ count: 0, ids: [] });
	});

	test("an altered hour fails verify naming the hour — the tamper case", async () => {
		const world = scratch();

		const result = await world.substrate.writeMemory({ ...TEACHABLE_WRITE });
		expect(result.outcome).toBe("accepted");
		const event = world.captured.filter((e) => e.payload["action"] === "teachable")[0] as SubstrateEvent;

		const { world: housed, memo } = houseInHour(event);
		world.place(housed);

		// The anchor row names a root the hour's events do not digest to.
		world.anchor(anchorRow("f".repeat(64), memo));
		const verdict = await world.substrate.verifyGraph("ut-1", { now: H + 5 * HOUR, rpc: rpcReturning(memo) as never });

		expect(verdict.ok).toBe(false);
		expect(verdict.hours[0]?.status).toBe("mismatch");
		expect(verdict.reason).toContain(START_ISO);
	});
});
