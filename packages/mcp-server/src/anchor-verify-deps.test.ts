/**
 * The service adapters of anchor verification (v1.6 phases 59 and 60): a ledger fake, an RPC fake and nothing else. No network,
 * no real clock: every read arrives through the ports, and `nowMs` is fixed.
 */
import { describe, expect, test } from "bun:test";
import { buildSignerRotateEvent, formatMemo, HOUR_MS, merkleRootHex, type Rpc, type TransactionMemo } from "@substrate/ledger";
import { DEVNET_GENESIS_HASH } from "./anchor.ts";
import {
	anchorEvidenceFor,
	anchorVerifyBlocker,
	CKPT_LOOKUP_WINDOW_MS,
	LOOKUP_ROW_LIMIT,
	ROTATION_READ_MAX_PAGES,
	verifyCheckpointRef,
	verifyEventRef,
	type AnchorLedger,
	type AnchorVerifyPorts,
} from "./anchor-verify-deps.ts";
import { CheckpointVerifyError } from "./checkpoint-verify.ts";
import { eventHash } from "./event.ts";
import type { AnchorRow, EventQuery, HourLeaf } from "./greptime.ts";
import { rowToEvent } from "./service.ts";
import { buildCheckpointEvent } from "./session-events.ts";
import type { SubstrateEvent } from "./types.ts";

const H = Date.UTC(2026, 9, 20, 10);
const NOW = H + 6 * HOUR_MS;
const INGESTED = H + 30 * 60_000;
const ANCHORED_AT = H + 2 * HOUR_MS;
/** A whole number of seconds, because the RPC reports seconds. */
const BLOCK_TIME_MS = ANCHORED_AT + 30_000;
// Real 32-byte public keys (the memo program ids), so base58 validation is exercised for real.
const SIGNER_A = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo";
const SIGNER_B = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const SIGNATURE = `5${"a".repeat(87)}`;
const CKPT = "ckpt_0123456789abcdefghjkmnpqrs";
const HEX_64 = "0123456789abcdef".repeat(4);
const HEX_40 = "0123456789abcdef0123456789abcdef01234567";
const OPERATOR = "hermes";

function event(over: Partial<Omit<SubstrateEvent, "hash">> & { id: string }): SubstrateEvent {
	const base: Omit<SubstrateEvent, "hash"> = {
		ts: new Date(INGESTED).toISOString(),
		surface: "claude-code",
		session_id: "sess-v16",
		graph_id: null,
		node_id: null,
		linear_identifier: null,
		step: null,
		repo: null,
		branch: null,
		actor: "agent",
		kind: "note",
		summary: "a note",
		payload: { action: "memory.forget" },
		prev: null,
		...over,
	};
	return { ...base, hash: eventHash(base) };
}

function checkpoint(): SubstrateEvent {
	const draft = buildCheckpointEvent("sess-v16", { ckpt_id: CKPT, seq: 1, trigger: "turn", git_tree: HEX_40, manifest_sha256: HEX_64, file_count: 3, skipped_count: 0 });
	return event({ id: "evt_v16_checkpoint", kind: draft.kind, summary: draft.summary, payload: { ...draft.payload } });
}

const toRow = (e: SubstrateEvent): Record<string, unknown> => ({ ...e, ts: Date.parse(e.ts), payload: JSON.stringify(e.payload) });

class FakeLedger {
	events: SubstrateEvent[] = [];
	leaves: HourLeaf[] = [];
	row: AnchorRow | null = null;
	/** Ids with no ingest record. */
	notIngested = new Set<string>();
	queries: EventQuery[] = [];
	calls = { eventsByIds: 0, cursorPosition: 0, hourLeaves: 0, anchorForPeriod: 0, queryEvents: 0 };
	failQuery: string | null = null;

	async eventsByIds(positions: ReadonlyArray<string | { id: string }>): Promise<Array<Record<string, unknown>>> {
		this.calls.eventsByIds++;
		const ids = positions.map((p) => (typeof p === "string" ? p : p.id));
		return this.events.filter((e) => ids.includes(e.id)).map(toRow);
	}
	async cursorPosition(id: string): Promise<{ id: string; ingestedAt: number } | null> {
		this.calls.cursorPosition++;
		return this.notIngested.has(id) ? null : { id, ingestedAt: INGESTED };
	}
	async queryEvents(query: EventQuery = {}): Promise<Array<Record<string, unknown>>> {
		this.calls.queryEvents++;
		this.queries.push(query);
		if (this.failQuery !== null) throw new Error(this.failQuery);
		const match = (query.match ?? {}) as Record<string, string | undefined>;
		const rows = this.events
			.filter((e) => Object.entries(match).every(([column, value]) => value === undefined || (e as unknown as Record<string, unknown>)[column] === value))
			.filter((e) => query.since === undefined || e.ts >= query.since)
			.filter((e) => query.until === undefined || e.ts <= query.until)
			.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
			.slice(0, query.limit ?? 50);
		return rows.map(toRow);
	}
	async hourLeaves(): Promise<HourLeaf[]> {
		this.calls.hourLeaves++;
		return this.leaves;
	}
	async anchorForPeriod(ms: number): Promise<AnchorRow | null> {
		this.calls.anchorForPeriod++;
		return ms === H ? this.row : null;
	}
}

class FakeRpc implements Rpc {
	calls: Array<[string, string]> = [];
	genesisCalls = 0;
	genesis = DEVNET_GENESIS_HASH;
	/** The transaction at each level; a missing level answers null. */
	byLevel: Partial<Record<string, TransactionMemo>> = {};
	async transactionMemo(signature: string, commitment: string): Promise<TransactionMemo | null> {
		this.calls.push([signature, commitment]);
		return this.byLevel[commitment] ?? null;
	}
	async addressMemos(): Promise<never[]> {
		throw new Error("verification never lists addresses");
	}
	async getGenesisHash(): Promise<string> {
		this.genesisCalls++;
		return this.genesis;
	}
	async balance(): Promise<number> {
		throw new Error("verification never reads a balance");
	}
}

interface World {
	ledger: FakeLedger;
	rpc: FakeRpc;
	target: SubstrateEvent;
	ports: AnchorVerifyPorts;
	rpcBuilt: () => number;
}

/** An hour of `size` events with `target` at `index`, anchored by `signer` through a finalized transaction. */
function world(target: SubstrateEvent, options: { size?: number; index?: number; signer?: string; pubkey?: string | null; operators?: string[] } = {}): World {
	const size = options.size ?? 5;
	const index = options.index ?? 2;
	const signer = options.signer ?? SIGNER_A;
	const ledger = new FakeLedger();
	ledger.events.push(target);
	ledger.leaves = Array.from({ length: size }, (_, i) =>
		i === index ? { event_id: target.id, ingested_at: INGESTED, hash: target.hash } : { event_id: `evt_v16_other_${i}`, ingested_at: INGESTED, hash: new Bun.CryptoHasher("sha256").update(`v16-leaf:${i}`).digest("hex") },
	);
	const root = merkleRootHex(ledger.leaves.map((leaf) => leaf.hash));
	const memo = formatMemo({ periodStartMs: H, rootHex: root, count: size });
	ledger.row = {
		period_start: new Date(H).toISOString(),
		period_end: new Date(H + HOUR_MS).toISOString(),
		root,
		event_count: size,
		memo,
		tx_sig: SIGNATURE,
		signer,
		cluster: "devnet",
		slot: 4242,
		anchored_at: new Date(ANCHORED_AT).toISOString(),
		stale_hashes: null,
	};
	const rpc = new FakeRpc();
	rpc.byLevel["finalized"] = { memo, payer: signer, payerSigned: true, err: null, fee: 5000, slot: 4242, blockTime: BLOCK_TIME_MS / 1000 };
	let built = 0;
	const ports: AnchorVerifyPorts = {
		ledger: ledger as unknown as AnchorLedger,
		rowToEvent,
		rpc: () => {
			built++;
			return rpc;
		},
		solana: { pubkey: options.pubkey === undefined ? SIGNER_A : options.pubkey, problem: null },
		operatorSurfaces: new Set(options.operators ?? [OPERATOR]),
		nowMs: () => NOW,
	};
	return { ledger, rpc, target, ports, rpcBuilt: () => built };
}

describe("anchored through the adapters", () => {
	test("a non-checkpoint event by id: the proof verifies, the RPC's seconds are read as milliseconds, and nothing is sent", async () => {
		const w = world(event({ id: "evt_v16_note" }));
		// No rotation read here (no operator surfaces): the configured key alone anchors this hour.
		w.ports.operatorSurfaces = new Set();
		const result = await verifyEventRef(w.ports, "evt_v16_note");
		expect(result).toMatchObject({ status: "anchored", ref: "evt_v16_note", reasons: [], event: { id: "evt_v16_note", kind: "note" } });
		if (!("evidence" in result)) throw new Error("expected evidence");
		expect(result.evidence).toMatchObject({ event_hash: w.target.hash, leaf_index: 2, signature: SIGNATURE, signer: SIGNER_A, block_time_ms: BLOCK_TIME_MS, finality: "finalized", count: 5 });
		expect(result.evidence.proof).not.toBeNull();
		// The only chain reads: the genesis hash and one finalized transaction lookup. addressMemos and balance throw if touched.
		expect(w.rpc.genesisCalls).toBe(1);
		expect(w.rpc.calls).toEqual([[SIGNATURE, "finalized"]]);
		expect(w.ledger.calls).toMatchObject({ eventsByIds: 1, cursorPosition: 1, hourLeaves: 1, anchorForPeriod: 1 });
	});

	test("the block time is judged in milliseconds: a key valid from one second before the block time accepts it", async () => {
		const w = world(event({ id: "evt_v16_note" }), { signer: SIGNER_B });
		const draft = buildSignerRotateEvent({ old_pubkey: SIGNER_A, new_pubkey: SIGNER_B, effective_from_ms: BLOCK_TIME_MS - 1000, reason: "rotate the anchor key" });
		w.ledger.events.push(
			event({ id: "evt_v16_rotate_at_block", surface: OPERATOR as SubstrateEvent["surface"], session_id: null, kind: draft.kind, summary: draft.summary, payload: { ...draft.payload }, ts: new Date(H + HOUR_MS).toISOString() }),
		);
		// Read as seconds the block time is January 1970, long before the new key's window opens, and this would be a mismatch.
		const result = await verifyEventRef(w.ports, "evt_v16_note");
		expect(result.status).toBe("anchored");
		if (!("evidence" in result)) throw new Error("expected evidence");
		expect(result.evidence.block_time_ms).toBe(BLOCK_TIME_MS);
	});

	test("a transaction only confirmed so far is read at the second level, and says so", async () => {
		const w = world(event({ id: "evt_v16_note" }));
		w.ports.operatorSurfaces = new Set();
		w.rpc.byLevel = { confirmed: w.rpc.byLevel["finalized"] as TransactionMemo };
		const result = await verifyEventRef(w.ports, "evt_v16_note");
		expect(result.status).toBe("anchored");
		if (!("evidence" in result)) throw new Error("expected evidence");
		expect(result.evidence.finality).toBe("confirmed");
		expect(w.rpc.calls).toEqual([
			[SIGNATURE, "finalized"],
			[SIGNATURE, "confirmed"],
		]);
	});

	test("a transaction the cluster does not know at either level is unverified, never a mismatch", async () => {
		const w = world(event({ id: "evt_v16_note" }));
		w.ports.operatorSurfaces = new Set();
		w.rpc.byLevel = {};
		expect((await verifyEventRef(w.ports, "evt_v16_note")).status).toBe("unverified");
	});

	test("an event with no ingest record has no hour: unanchored", async () => {
		const w = world(event({ id: "evt_v16_note" }));
		w.ports.operatorSurfaces = new Set();
		w.ledger.notIngested.add("evt_v16_note");
		expect((await verifyEventRef(w.ports, "evt_v16_note")).status).toBe("unanchored");
	});
});

describe("not configured: a status, decided before any read", () => {
	const cases: Array<[string, Partial<AnchorVerifyPorts>, string]> = [
		["no anchor public key", { solana: { pubkey: null, problem: null } }, "SOLANA_ANCHOR_PUBKEY"],
		["a refused RPC URL", { solana: { pubkey: SIGNER_A, problem: "SOLANA_RPC_URL refused: not devnet" } }, "SOLANA_RPC_URL refused"],
		["no ledger", { ledger: null }, "event ledger is not configured"],
	];
	for (const [name, override, fragment] of cases) {
		test(`${name}: unverified with the reason, no ledger read, no RPC client built`, async () => {
			const w = world(event({ id: "evt_v16_note" }));
			const ports = { ...w.ports, ...override };
			expect(anchorVerifyBlocker(ports)).toContain(fragment);
			const byEvent = await verifyEventRef(ports, "evt_v16_note");
			const byCkpt = await verifyCheckpointRef(ports, CKPT, { sessionId: "sess-v16" });
			for (const result of [byEvent, byCkpt]) {
				expect(result.status).toBe("unverified");
				expect(result.reasons.join(" ")).toContain(fragment);
			}
			expect(w.rpcBuilt()).toBe(0);
			expect(w.rpc.genesisCalls).toBe(0);
			expect(Object.values(w.ledger.calls).reduce((a, b) => a + b, 0)).toBe(0);
			// The memory reader maps the same answer onto its own vocabulary.
			expect(await anchorEvidenceFor(ports, "evt_v16_note")).toMatchObject({ status: "unverified", proof_ref: null });
		});
	}

	test("a configured but invalid anchor key is unverified with a reason, not a throw", async () => {
		const w = world(event({ id: "evt_v16_note" }), { pubkey: "not-a-key" });
		const result = await verifyEventRef(w.ports, "evt_v16_note");
		expect(result.status).toBe("unverified");
		expect(result.reasons[0]).toContain("signer set could not be built");
	});
});

describe("checkpoint ids are found by a bounded search", () => {
	test("with a session: that session's newest notes, no time window; the found checkpoint verifies", async () => {
		const w = world(checkpoint());
		w.ports.operatorSurfaces = new Set();
		const result = await verifyCheckpointRef(w.ports, CKPT, { sessionId: "sess-v16", surface: "claude-code" });
		expect(result.status).toBe("anchored");
		expect(w.ledger.queries).toEqual([{ match: { kind: "note", session_id: "sess-v16" }, limit: LOOKUP_ROW_LIMIT, order: "desc", includePayload: true }]);
	});

	test("with only a surface: that surface's notes of the last seven days", async () => {
		const w = world(checkpoint());
		w.ports.operatorSurfaces = new Set();
		expect((await verifyCheckpointRef(w.ports, CKPT, { surface: "claude-code" })).status).toBe("anchored");
		expect(w.ledger.queries).toEqual([
			{ match: { kind: "note", surface: "claude-code" }, since: new Date(NOW - CKPT_LOOKUP_WINDOW_MS).toISOString(), limit: LOOKUP_ROW_LIMIT, order: "desc", includePayload: true },
		]);
	});

	test("another surface's checkpoint is not found by id, and neither is one with no session and no surface: not-found, and no query for the latter", async () => {
		const w = world(checkpoint());
		w.ports.operatorSurfaces = new Set();
		await expect(verifyCheckpointRef(w.ports, CKPT, { surface: "omp" })).rejects.toMatchObject({ code: "not-found" });
		w.ledger.queries.length = 0;
		await expect(verifyCheckpointRef(w.ports, CKPT)).rejects.toBeInstanceOf(CheckpointVerifyError);
		expect(w.ledger.queries).toEqual([]);
	});

	test("an event id that is not a checkpoint is a typed error for the checkpoint tool", async () => {
		const w = world(event({ id: "evt_v16_note" }));
		w.ports.operatorSurfaces = new Set();
		await expect(verifyCheckpointRef(w.ports, "evt_v16_note")).rejects.toMatchObject({ code: "not-a-checkpoint" });
	});
});

describe("the signer set: the configured key plus operator rotations", () => {
	const rotation = (surface: string, newKey: string, id = "evt_v16_rotate"): SubstrateEvent => {
		const draft = buildSignerRotateEvent({ new_pubkey: newKey, effective_from_ms: H, reason: "rotate the anchor key" });
		return event({ id, surface: surface as SubstrateEvent["surface"], kind: draft.kind, summary: draft.summary, payload: { ...draft.payload }, ts: new Date(H + HOUR_MS).toISOString(), session_id: null });
	};
	/** An operator note retiring `oldKey` and introducing `newKey` at `at`; the note's own time is `at`. */
	const retirement = (oldKey: string, newKey: string, at: number): SubstrateEvent => {
		const draft = buildSignerRotateEvent({ old_pubkey: oldKey, new_pubkey: newKey, effective_from_ms: at, reason: "retire the old anchor key" });
		return event({ id: "evt_v16_retire", surface: OPERATOR as SubstrateEvent["surface"], kind: draft.kind, summary: draft.summary, payload: { ...draft.payload }, ts: new Date(at).toISOString(), session_id: null });
	};
	/** Operator reads that never run out: every page is full of fresh unrelated notes, so only the page cap stops the read. */
	const endlessNotes = (w: World): void => {
		let served = 0;
		w.ledger.queryEvents = async (query: EventQuery = {}) => {
			w.ledger.calls.queryEvents++;
			w.ledger.queries.push(query);
			return Array.from({ length: LOOKUP_ROW_LIMIT }, () => {
				const n = served++;
				return toRow(event({ id: `evt_v16_endless_${n}`, surface: OPERATOR as SubstrateEvent["surface"], session_id: null, ts: new Date(H + 40 * HOUR_MS - n).toISOString() }));
			});
		};
	};
	test("an operator's rotation lets the new key anchor; the read asks only operator surfaces, only for notes", async () => {
		const w = world(event({ id: "evt_v16_note" }), { signer: SIGNER_B });
		w.ledger.events.push(rotation(OPERATOR, SIGNER_B));
		const result = await verifyEventRef(w.ports, "evt_v16_note");
		expect(result.status).toBe("anchored");
		const rotationQueries = w.ledger.queries.filter((query) => query.match?.surface !== undefined);
		expect(rotationQueries).toEqual([{ match: { kind: "note", surface: OPERATOR }, limit: LOOKUP_ROW_LIMIT, order: "desc", includePayload: true }]);
	});

	test("the same rotation written by a surface that is not an operator is never read: the new key is a mismatch", async () => {
		const w = world(event({ id: "evt_v16_note" }), { signer: SIGNER_B });
		w.ledger.events.push(rotation("omp", SIGNER_B));
		expect((await verifyEventRef(w.ports, "evt_v16_note")).status).toBe("mismatch");
	});

	test("a rotation read that cannot be completed is never anchored: a signer-only mismatch is unverified with rotation-read-incomplete", async () => {
		const w = world(event({ id: "evt_v16_note" }), { signer: SIGNER_B });
		endlessNotes(w);
		const result = await verifyEventRef(w.ports, "evt_v16_note");
		expect(result).toMatchObject({ status: "unverified", signer_set_complete: false });
		expect(result.reasons.join(" ")).toContain("rotation-read-incomplete");
		expect(result.reasons.join(" ")).toContain("older rotation may be missing");
	});

	test("the same gap does not hide a real disagreement: a different root stays a mismatch", async () => {
		const w = world(event({ id: "evt_v16_note" }), { signer: SIGNER_B });
		endlessNotes(w);
		// The ledger's hour no longer hashes to the anchored root.
		w.ledger.leaves = w.ledger.leaves.map((leaf, i) => (i === 0 ? { ...leaf, hash: "f".repeat(64) } : leaf));
		const result = await verifyEventRef(w.ports, "evt_v16_note");
		expect(result.status).toBe("mismatch");
		expect(result).toMatchObject({ signer_set_complete: false });
	});

	test("a failed rotation read leaves the bootstrap set and a gap, never a throw", async () => {
		const w = world(event({ id: "evt_v16_note" }), { signer: SIGNER_B });
		w.ledger.failQuery = "greptime unreachable";
		const result = await verifyEventRef(w.ports, "evt_v16_note");
		expect(result).toMatchObject({ status: "unverified", signer_set_complete: false });
		expect(result.reasons.join(" ")).toContain("could not be read");
	});

	test("a failed rotation read never lets the bootstrap signer pass as anchored: unverified, rotation-read-incomplete", async () => {
		// SIGNER_A is the configured key and signed the anchor: without the read it would verify, but a retirement may be hidden.
		const w = world(event({ id: "evt_v16_note" }));
		w.ledger.failQuery = "greptime unreachable";
		const result = await verifyEventRef(w.ports, "evt_v16_note");
		expect(result).toMatchObject({ status: "unverified", signer_set_complete: false });
		expect(result.reasons.join(" ")).toContain("rotation-read-incomplete");
		expect(await anchorEvidenceFor(w.ports, "evt_v16_note")).toMatchObject({ status: "unverified", proof_ref: null });
	});

	test("a rotation read cut by the page cap never lets the bootstrap signer pass as anchored", async () => {
		const w = world(event({ id: "evt_v16_note" }));
		endlessNotes(w);
		const result = await verifyEventRef(w.ports, "evt_v16_note");
		expect(result).toMatchObject({ status: "unverified", signer_set_complete: false });
		expect(result.reasons.join(" ")).toContain("rotation-read-incomplete");
		expect(w.ledger.calls.queryEvents).toBe(ROTATION_READ_MAX_PAGES);
	});

	test("a retirement beyond the old 500-note bound is seen: the retired signer is a mismatch, signer-retired", async () => {
		const w = world(event({ id: "evt_v16_note" }));
		const retired = retirement(SIGNER_A, SIGNER_B, H - 3 * HOUR_MS);
		w.ledger.events.push(retired);
		// 600 newer notes of the operator surface: the oldest 100 plus the retirement lie beyond the first page.
		for (let i = 0; i < 600; i++) {
			w.ledger.events.push(event({ id: `evt_v16_filler_${i}`, surface: OPERATOR as SubstrateEvent["surface"], session_id: null, ts: new Date(H + HOUR_MS + i).toISOString() }));
		}
		const result = await verifyEventRef(w.ports, "evt_v16_note");
		expect(result).toMatchObject({ status: "mismatch" });
		expect(result.reasons.join(" ")).toContain("signer-retired");
		expect(result).not.toHaveProperty("signer_set_complete");
		expect(result.signer_set).toMatchObject({ rotation_notes_applied: 1, read_gap: null });
		expect(w.ledger.calls.queryEvents).toBe(2);
	});

	test("a signer retired after the anchor still verifies as anchored, however many unrelated notes there are", async () => {
		const w = world(event({ id: "evt_v16_note" }));
		w.ledger.events.push(retirement(SIGNER_A, SIGNER_B, BLOCK_TIME_MS + HOUR_MS));
		for (let i = 0; i < 600; i++) {
			w.ledger.events.push(event({ id: `evt_v16_filler_${i}`, surface: OPERATOR as SubstrateEvent["surface"], session_id: null, ts: new Date(H + 5 * HOUR_MS + i).toISOString() }));
		}
		const result = await verifyEventRef(w.ports, "evt_v16_note");
		expect(result.status).toBe("anchored");
		expect(result).not.toHaveProperty("signer_set_complete");
		expect(result.signer_set).toMatchObject({ entries: 2, rotation_notes_applied: 1, read_gap: null });
	});
});

describe("SUBSTRATE_ANCHOR_SIGNER_SET is the bootstrap when set", () => {
	const OLD_THEN_NEW = [
		{ pubkey: SIGNER_A, valid_from_ms: 0, valid_until_ms: BLOCK_TIME_MS + HOUR_MS, label: "old" },
		{ pubkey: SIGNER_B, valid_from_ms: BLOCK_TIME_MS + HOUR_MS, valid_until_ms: null, label: "new" },
	];
	const withSet = (w: World, signerSet: AnchorVerifyPorts["solana"]["signerSet"], pubkey: string | null): void => {
		w.ports.solana = { pubkey, problem: null, signerSet, signerSetProblem: null };
		w.ports.operatorSurfaces = new Set();
	};

	test("rotating the job's key does not make the old key's anchors a mismatch while the old key stays in the set", async () => {
		// The job now signs with B and SOLANA_ANCHOR_PUBKEY names B; the anchor under test was signed by A before the rotation.
		const without = world(event({ id: "evt_v16_note" }), { pubkey: SIGNER_B });
		without.ports.operatorSurfaces = new Set();
		const lost = await verifyEventRef(without.ports, "evt_v16_note");
		expect(lost.status).toBe("mismatch");
		expect(lost.reasons.join(" ")).toContain("not in the signer set");

		const kept = world(event({ id: "evt_v16_note" }), { pubkey: SIGNER_B });
		withSet(kept, OLD_THEN_NEW, SIGNER_B);
		const result = await verifyEventRef(kept.ports, "evt_v16_note");
		expect(result.status).toBe("anchored");
		expect(result.signer_set).toEqual({ source: "env", entries: 2, rotation_notes_applied: 0, rotation_issues: [], read_gap: null });
	});

	test("a window that ended before the anchor's block time still rejects that signer", async () => {
		const w = world(event({ id: "evt_v16_note" }));
		withSet(w, [{ pubkey: SIGNER_A, valid_from_ms: 0, valid_until_ms: BLOCK_TIME_MS }, { pubkey: SIGNER_B, valid_from_ms: BLOCK_TIME_MS, valid_until_ms: null }], SIGNER_B);
		const result = await verifyEventRef(w.ports, "evt_v16_note");
		expect(result.status).toBe("mismatch");
		expect(result.reasons.join(" ")).toContain("outside its valid window");
	});

	test("unset keeps today's behaviour exactly: the public key alone, valid from the epoch, summarised as `pubkey`", async () => {
		const w = world(event({ id: "evt_v16_note" }));
		w.ports.operatorSurfaces = new Set();
		const result = await verifyEventRef(w.ports, "evt_v16_note");
		expect(result.status).toBe("anchored");
		expect(result.signer_set).toEqual({ source: "pubkey", entries: 1, rotation_notes_applied: 0, rotation_issues: [], read_gap: null });
	});

	test("a configured set stands without SOLANA_ANCHOR_PUBKEY: the key is only the bootstrap when there is no set", async () => {
		const w = world(event({ id: "evt_v16_note" }));
		withSet(w, [{ pubkey: SIGNER_A, valid_from_ms: 0, valid_until_ms: null }], null);
		expect(anchorVerifyBlocker(w.ports)).toBeNull();
		expect((await verifyEventRef(w.ports, "evt_v16_note")).status).toBe("anchored");
	});

	test("a malformed set is unverified with a fixed reason that carries no part of the config problem, and nothing is read", async () => {
		const w = world(event({ id: "evt_v16_note" }));
		const problem = "SUBSTRATE_ANCHOR_SIGNER_SET is not a valid signer set: format at [0].pubkey";
		w.ports.solana = { pubkey: SIGNER_A, problem: null, signerSet: null, signerSetProblem: problem };
		const byEvent = await verifyEventRef(w.ports, "evt_v16_note");
		const byCkpt = await verifyCheckpointRef(w.ports, CKPT, { sessionId: "sess-v16" });
		for (const result of [byEvent, byCkpt]) {
			expect(result.status).toBe("unverified");
			expect(result.reasons).toEqual(["Solana is not usable: SUBSTRATE_ANCHOR_SIGNER_SET is malformed (the server's boot warnings say why)"]);
			expect(result.signer_set).toBeUndefined();
		}
		// Never a silently empty set: the bootstrap key is not used instead either.
		expect(w.rpcBuilt()).toBe(0);
		expect(Object.values(w.ledger.calls).reduce((a, b) => a + b, 0)).toBe(0);
		expect(await anchorEvidenceFor(w.ports, "evt_v16_note")).toMatchObject({ status: "unverified", proof_ref: null });
	});

	test("a rotation note the set cannot apply is listed with its rule, and one it can apply is counted", async () => {
		const draft = buildSignerRotateEvent({ old_pubkey: SIGNER_B, new_pubkey: SIGNER_A, effective_from_ms: H, reason: "the old key is not in the set" });
		const ignored = event({ id: "evt_v16_ignored", surface: OPERATOR as SubstrateEvent["surface"], kind: draft.kind, summary: draft.summary, payload: { ...draft.payload }, ts: new Date(H + HOUR_MS).toISOString(), session_id: null });
		const added = buildSignerRotateEvent({ new_pubkey: SIGNER_B, effective_from_ms: H, reason: "add the second key" });
		const applied = event({ id: "evt_v16_applied", surface: OPERATOR as SubstrateEvent["surface"], kind: added.kind, summary: added.summary, payload: { ...added.payload }, ts: new Date(H + HOUR_MS).toISOString(), session_id: null });

		const w = world(event({ id: "evt_v16_note" }), { signer: SIGNER_B });
		w.ports.solana = { pubkey: SIGNER_A, problem: null, signerSet: [{ pubkey: SIGNER_A, valid_from_ms: 0, valid_until_ms: null }], signerSetProblem: null };
		w.ledger.events.push(ignored, applied);
		const result = await verifyEventRef(w.ports, "evt_v16_note");

		expect(result.status).toBe("anchored");
		expect(result.signer_set).toEqual({
			source: "env",
			entries: 2,
			rotation_notes_applied: 1,
			rotation_issues: [{ event_id: "evt_v16_ignored", reason: "old-key-not-valid" }],
			read_gap: null,
		});
	});

	test("a retired window in the configured set, closed at or before the anchored hour, is a mismatch with signer-retired", async () => {
		const w = world(event({ id: "evt_v16_note" }));
		withSet(w, [{ pubkey: SIGNER_A, valid_from_ms: 0, valid_until_ms: H }, { pubkey: SIGNER_B, valid_from_ms: H, valid_until_ms: null }], SIGNER_B);
		const result = await verifyEventRef(w.ports, "evt_v16_note");
		expect(result.status).toBe("mismatch");
		expect(result.reasons.join(" ")).toContain("signer-retired");
	});

	test("a rotation read that exhausts its notes reports no gap, a capped one says so in the summary, and a failed one says why", async () => {
		const full = world(event({ id: "evt_v16_note" }));
		for (let i = 0; i < LOOKUP_ROW_LIMIT; i++) {
			full.ledger.events.push(event({ id: `evt_v16_filler_${i}`, surface: OPERATOR as SubstrateEvent["surface"], session_id: null, ts: new Date(H + HOUR_MS + i).toISOString() }));
		}
		const exhausted = await verifyEventRef(full.ports, "evt_v16_note");
		expect(exhausted.status).toBe("anchored");
		expect(exhausted).not.toHaveProperty("signer_set_complete");
		expect(exhausted.signer_set?.read_gap).toBeNull();

		const capped = world(event({ id: "evt_v16_note" }));
		const served = { n: 0 };
		capped.ledger.queryEvents = async () =>
			Array.from({ length: LOOKUP_ROW_LIMIT }, () => toRow(event({ id: `evt_v16_endless_${served.n++}`, surface: OPERATOR as SubstrateEvent["surface"], session_id: null, ts: new Date(H + 40 * HOUR_MS - served.n).toISOString() })));
		const truncated = await verifyEventRef(capped.ports, "evt_v16_note");
		expect(truncated).toMatchObject({ status: "unverified", signer_set_complete: false });
		expect(truncated.signer_set?.read_gap).toContain(`${ROTATION_READ_MAX_PAGES}-page limit`);

		const failed = world(event({ id: "evt_v16_note" }));
		failed.ledger.failQuery = "greptime unreachable";
		expect((await verifyEventRef(failed.ports, "evt_v16_note")).signer_set?.read_gap).toContain("could not be read");
	});

	test("the memory reader's observer receives the same summary", async () => {
		const w = world(event({ id: "evt_v16_note" }));
		withSet(w, [{ pubkey: SIGNER_A, valid_from_ms: 0, valid_until_ms: null }], SIGNER_B);
		const seen: unknown[] = [];
		await anchorEvidenceFor(w.ports, "evt_v16_note", (summary) => seen.push(summary));
		expect(seen).toEqual([{ source: "env", entries: 1, rotation_notes_applied: 0, rotation_issues: [], read_gap: null }]);
	});
});

describe("the memory reader's view", () => {
	test("anchored carries the transaction signature as its proof reference", async () => {
		const w = world(event({ id: "evt_v16_note" }));
		w.ports.operatorSurfaces = new Set();
		expect(await anchorEvidenceFor(w.ports, "evt_v16_note")).toEqual({ status: "anchored", proof_ref: SIGNATURE });
	});

	test("an event the ledger does not hold is unanchored; a malformed id is unverified; neither is a throw", async () => {
		const w = world(event({ id: "evt_v16_note" }));
		w.ports.operatorSurfaces = new Set();
		expect(await anchorEvidenceFor(w.ports, "evt_v16_missing")).toMatchObject({ status: "unanchored", proof_ref: null });
		expect(await anchorEvidenceFor(w.ports, "not an id!")).toMatchObject({ status: "unverified", proof_ref: null });
	});

	test("a reader that throws is not swallowed into a verdict", async () => {
		const w = world(event({ id: "evt_v16_note" }));
		w.ports.operatorSurfaces = new Set();
		w.ports.ledger = {
			...(w.ledger as unknown as Record<string, unknown>),
			eventsByIds: async () => {
				throw new Error("boom");
			},
		} as unknown as AnchorLedger;
		await expect(anchorEvidenceFor(w.ports, "evt_v16_note")).rejects.toThrow("boom");
	});
});
