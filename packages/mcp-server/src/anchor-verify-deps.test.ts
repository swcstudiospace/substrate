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
	followReanchor,
	CKPT_LOOKUP_WINDOW_MS,
	LOOKUP_ROW_LIMIT,
	MAX_OPERATOR_SURFACES,
	newestBoundNote,
	readReanchorNotes,
	REANCHOR_READ_MAX_PAGES,
	reanchorSessionId,
	ReanchorReadIncomplete,
	ROTATION_READ_MAX_PAGES,
	verifyCheckpointRef,
	verifyEventRef,
	type AnchorLedger,
	type AnchorVerifyPorts,
} from "./anchor-verify-deps.ts";
import { CheckpointVerifyError } from "./checkpoint-verify.ts";
import { eventHash } from "./event.ts";
import type { AnchorRow, EventQuery, HourLeaf } from "./greptime.ts";
import { buildReanchorEvent } from "./reanchor-plan.ts";
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
	/** Operator reads that never run out: every page is full of fresh unrelated notes, so only the page cap stops the read. The hour's re-anchor session has none. */
	const endlessNotes = (w: World): void => {
		let served = 0;
		w.ledger.queryEvents = async (query: EventQuery = {}) => {
			w.ledger.calls.queryEvents++;
			w.ledger.queries.push(query);
			if (query.match?.session_id !== undefined) return [];
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
		const rotationQueries = w.ledger.queries.filter((query) => query.match?.surface !== undefined && query.match.session_id === undefined);
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
		// The rotation pages, plus the one read of the hour's re-anchor notes.
		expect(w.ledger.calls.queryEvents).toBe(ROTATION_READ_MAX_PAGES + 1);
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
		// Two rotation pages; the re-anchor notes of the hour are read once per verification, and the retired signer is re-checked once.
		expect(w.ledger.calls.queryEvents).toBe(4);
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

	test("operator surfaces past the read cap make the signer set incomplete, never a clean read", async () => {
		const w = world(event({ id: "evt_v16_note" }));
		w.ports.operatorSurfaces = new Set(Array.from({ length: MAX_OPERATOR_SURFACES + 1 }, (_, i) => `op-${i}`));
		const result = await verifyEventRef(w.ports, "evt_v16_note");
		expect(result).toMatchObject({ status: "unverified", signer_set_complete: false });
		expect(result.signer_set?.read_gap).toContain("1 of 9 operator surfaces were not read");
		expect(result.signer_set?.read_gap).toContain(`op-${MAX_OPERATOR_SURFACES}`);

		const within = world(event({ id: "evt_v16_note" }));
		within.ports.operatorSurfaces = new Set(Array.from({ length: MAX_OPERATOR_SURFACES }, (_, i) => `op-${i}`));
		expect((await verifyEventRef(within.ports, "evt_v16_note")).signer_set?.read_gap).toBeNull();
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

describe("a re-anchored hour: the operator's note is a pointer, the chain transaction is the proof", () => {
	const NEW_SIGNATURE = `6${"d".repeat(87)}`;
	const SECOND_SIGNATURE = `7${"e".repeat(87)}`;
	const NOTE_TS = new Date(H + 5 * HOUR_MS).toISOString();
	const NEW_BLOCK_TIME_S = (H + 5 * HOUR_MS) / 1000;

	const storedRow = (w: World): AnchorRow => w.ledger.row as AnchorRow;
	const tx = (memo: string, over: Partial<TransactionMemo> = {}): TransactionMemo => ({ memo, payer: SIGNER_A, payerSigned: true, err: null, fee: 5000, slot: 9000, blockTime: NEW_BLOCK_TIME_S, ...over });

	/** An `anchor.reanchor` note for the world's hour, bound to its stored row unless `over` says otherwise. */
	function note(w: World, over: { id?: string; surface?: string; newSig?: string; previous?: string; root?: string; count?: number; ts?: string; session?: string | null; extra?: Record<string, unknown> } = {}): SubstrateEvent {
		const row = storedRow(w);
		const draft = buildReanchorEvent({
			period_start: row.period_start,
			root: over.root ?? row.root,
			event_count: over.count ?? row.event_count,
			previous_tx_sig: over.previous ?? row.tx_sig,
			new_tx_sig: over.newSig ?? NEW_SIGNATURE,
			genesis: DEVNET_GENESIS_HASH,
		});
		return event({
			id: over.id ?? "evt_v16_reanchor",
			surface: (over.surface ?? OPERATOR) as SubstrateEvent["surface"],
			kind: draft.kind,
			summary: draft.summary,
			payload: { ...draft.payload, ...over.extra },
			session_id: over.session === undefined ? reanchorSessionId(row.period_start) : over.session,
			ts: over.ts ?? NOTE_TS,
		});
	}

	/** The cluster after a reset: it knows exactly the signatures in `known` (at the finalized level) and not the old one. */
	function cluster(w: World, known: Record<string, TransactionMemo>): void {
		w.rpc.transactionMemo = async (signature: string, commitment: string) => {
			w.rpc.calls.push([signature, commitment]);
			return commitment === "finalized" ? (known[signature] ?? null) : null;
		};
	}

	const sigsRead = (w: World): string[] => [...new Set(w.rpc.calls.map(([signature]) => signature))];

	test("an operator's note is followed: the replacement transaction is read and verified, and the anchors row is not touched", async () => {
		const w = world(event({ id: "evt_v16_note" }));
		w.ledger.events.push(note(w));
		cluster(w, { [NEW_SIGNATURE]: tx(storedRow(w).memo) });

		const result = await verifyEventRef(w.ports, "evt_v16_note");

		expect(result).toMatchObject({ status: "anchored", reasons: [] });
		if (!("evidence" in result)) throw new Error("expected evidence");
		expect(result.evidence).toMatchObject({ signature: NEW_SIGNATURE, signer: SIGNER_A, slot: 9000, finality: "finalized", count: 5, block_time_ms: H + 5 * HOUR_MS });
		// The old signature is never asked about: the replacement is the transaction that is judged.
		expect(sigsRead(w)).toEqual([NEW_SIGNATURE]);
		expect(storedRow(w).tx_sig).toBe(SIGNATURE);
		expect(await anchorEvidenceFor(w.ports, "evt_v16_note")).toEqual({ status: "anchored", proof_ref: NEW_SIGNATURE });
	});

	test("the checkpoint verifier follows it the same way", async () => {
		const w = world(checkpoint());
		w.ledger.events.push(note(w));
		cluster(w, { [NEW_SIGNATURE]: tx(storedRow(w).memo) });
		const result = await verifyCheckpointRef(w.ports, CKPT, { sessionId: "sess-v16" });
		expect(result.status).toBe("anchored");
		if (!("evidence" in result)) throw new Error("expected evidence");
		expect(result.evidence.signature).toBe(NEW_SIGNATURE);
	});

	test("the replacement's signer and slot come from the chain, so a re-anchor signed by a later key still verifies", async () => {
		const w = world(event({ id: "evt_v16_note" }));
		const rotation = buildSignerRotateEvent({ old_pubkey: SIGNER_A, new_pubkey: SIGNER_B, effective_from_ms: H + 4 * HOUR_MS, reason: "rotate the anchor key" });
		w.ledger.events.push(
			event({ id: "evt_v16_rotate", surface: OPERATOR as SubstrateEvent["surface"], session_id: null, kind: rotation.kind, summary: rotation.summary, payload: { ...rotation.payload }, ts: new Date(H + 4 * HOUR_MS).toISOString() }),
			note(w),
		);
		cluster(w, { [NEW_SIGNATURE]: tx(storedRow(w).memo, { payer: SIGNER_B }) });
		const result = await verifyEventRef(w.ports, "evt_v16_note");
		expect(result.status).toBe("anchored");
		if (!("evidence" in result)) throw new Error("expected evidence");
		expect(result.evidence.signer).toBe(SIGNER_B);
	});

	test("a forged note from a surface that is not an operator is ignored: the old signature is read, it is gone, and the hour stays unverified", async () => {
		const w = world(event({ id: "evt_v16_note" }));
		w.ledger.events.push(note(w, { surface: "omp" }));
		// Even though the transaction the forged note names would verify.
		cluster(w, { [NEW_SIGNATURE]: tx(storedRow(w).memo) });
		const result = await verifyEventRef(w.ports, "evt_v16_note");
		expect(result.status).toBe("unverified");
		if (!("evidence" in result)) throw new Error("expected evidence");
		expect(result.evidence.signature).toBe(SIGNATURE);
		expect(sigsRead(w)).toEqual([SIGNATURE]);
		expect(await anchorEvidenceFor(w.ports, "evt_v16_note")).toMatchObject({ status: "unverified", proof_ref: null });
	});

	test("with no operator surface configured the ledger is not even asked for notes", async () => {
		const w = world(event({ id: "evt_v16_note" }));
		w.ports.operatorSurfaces = new Set();
		w.ledger.events.push(note(w));
		cluster(w, { [NEW_SIGNATURE]: tx(storedRow(w).memo) });
		expect((await verifyEventRef(w.ports, "evt_v16_note")).status).toBe("unverified");
		expect(w.ledger.queries).toEqual([]);
	});

	test("a note can never make an hour pass without its transaction verifying: another root, a failed transaction, a signer outside the set, an unknown signature", async () => {
		const row = (w: World): string => storedRow(w).memo;
		const cases: Array<[string, (w: World) => TransactionMemo | null, "mismatch" | "unverified"]> = [
			["a memo with another root", () => tx(formatMemo({ periodStartMs: H, rootHex: "f".repeat(64), count: 5 })), "mismatch"],
			["a memo with another count", () => tx(formatMemo({ periodStartMs: H, rootHex: "f".repeat(64), count: 6 })), "mismatch"],
			["a memo for another hour", () => tx(formatMemo({ periodStartMs: H + HOUR_MS, rootHex: "f".repeat(64), count: 5 })), "mismatch"],
			["a failed transaction", (w) => tx(row(w), { err: { InstructionError: [0, "Custom"] } }), "mismatch"],
			["a signer outside the signer set", (w) => tx(row(w), { payer: SIGNER_B }), "mismatch"],
			["an unsigned fee payer", (w) => tx(row(w), { payerSigned: false }), "mismatch"],
			["a signature the cluster does not know", () => null, "unverified"],
		];
		for (const [name, transaction, status] of cases) {
			const w = world(event({ id: "evt_v16_note" }));
			w.ledger.events.push(note(w));
			const known = transaction(w);
			cluster(w, known === null ? {} : { [NEW_SIGNATURE]: known });
			const result = await verifyEventRef(w.ports, "evt_v16_note");
			expect({ name, status: result.status }).toEqual({ name, status });
			expect(await anchorEvidenceFor(w.ports, "evt_v16_note")).toMatchObject({ proof_ref: null });
		}
	});

	test("a note bound to another row is ignored: another root, another count or another previous signature", async () => {
		for (const over of [{ root: "f".repeat(64) }, { count: 4 }, { previous: `8${"f".repeat(87)}` }]) {
			const w = world(event({ id: "evt_v16_note" }));
			w.ledger.events.push(note(w, over));
			cluster(w, { [NEW_SIGNATURE]: tx(storedRow(w).memo) });
			const result = await verifyEventRef(w.ports, "evt_v16_note");
			expect(result.status).toBe("unverified");
			expect(sigsRead(w)).toEqual([SIGNATURE]);
		}
	});

	test("a malformed note from an operator (an unknown key) is ignored", async () => {
		const w = world(event({ id: "evt_v16_note" }));
		w.ledger.events.push(note(w, { extra: { unexpected: 1 } }));
		cluster(w, { [NEW_SIGNATURE]: tx(storedRow(w).memo) });
		expect((await verifyEventRef(w.ports, "evt_v16_note")).status).toBe("unverified");
		expect(sigsRead(w)).toEqual([SIGNATURE]);
	});

	test("the newest bound note wins and an older one is never a fallback", async () => {
		/** An hour with an older note naming NEW_SIGNATURE and a newer one naming SECOND_SIGNATURE; the cluster knows `known`. */
		const verifyWith = async (known: string) => {
			const w = world(event({ id: "evt_v16_note" }));
			w.ledger.events.push(note(w, { id: "evt_v16_reanchor_old", newSig: NEW_SIGNATURE, ts: new Date(H + 4 * HOUR_MS).toISOString() }), note(w, { id: "evt_v16_reanchor_new", newSig: SECOND_SIGNATURE, ts: NOTE_TS }));
			cluster(w, { [known]: tx(storedRow(w).memo) });
			return { w, result: await verifyEventRef(w.ports, "evt_v16_note") };
		};

		// The newer note names a transaction the cluster does not know: unverified, although the older one would verify.
		const unknown = await verifyWith(NEW_SIGNATURE);
		expect(unknown.result.status).toBe("unverified");
		if (!("evidence" in unknown.result)) throw new Error("expected evidence");
		expect(unknown.result.evidence.signature).toBe(SECOND_SIGNATURE);
		expect(sigsRead(unknown.w)).toEqual([SECOND_SIGNATURE]);

		// The newer note names the verifying one: anchored through the newer.
		expect((await verifyWith(SECOND_SIGNATURE)).result.status).toBe("anchored");
	});

	test("newestBoundNote is the one pointer shared with the re-anchor executor: the newest bound note, never an older one, null when none is bound", async () => {
		const w = world(event({ id: "evt_v16_note" }));
		w.ledger.events.push(
			note(w, { id: "evt_v16_old", newSig: NEW_SIGNATURE, ts: new Date(H + 4 * HOUR_MS).toISOString() }),
			note(w, { id: "evt_v16_new", newSig: SECOND_SIGNATURE, ts: NOTE_TS }),
			note(w, { id: "evt_v16_unbound", newSig: SECOND_SIGNATURE, previous: `8${"f".repeat(87)}`, ts: new Date(H + 6 * HOUR_MS).toISOString() }),
		);
		const { records } = await readReanchorNotes(w.ports, H, storedRow(w));
		expect(records.map((record) => record.event_id)).toEqual(["evt_v16_unbound", "evt_v16_new", "evt_v16_old"]);

		// The unbound (newest overall) note is skipped; the newest BOUND one is chosen, and the older one is not a fallback.
		expect(newestBoundNote(records, storedRow(w))?.event_id).toBe("evt_v16_new");
		expect(newestBoundNote(records.slice(2), storedRow(w))?.event_id).toBe("evt_v16_old");
		expect(newestBoundNote([], storedRow(w))).toBeNull();
		expect(newestBoundNote(records, { ...storedRow(w), root: "f".repeat(64) })).toBeNull();

		// The verifier follows exactly that note.
		expect((await followReanchor(w.ports, H, storedRow(w))).tx_sig).toBe(newestBoundNote(records, storedRow(w))?.payload.new_tx_sig as string);
	});

	test("an older valid note beside a newer one naming a missing transaction leaves the hour unverified: the executor must therefore not call it recorded", async () => {
		const w = world(event({ id: "evt_v16_note" }));
		w.ledger.events.push(
			note(w, { id: "evt_v16_old", newSig: NEW_SIGNATURE, ts: new Date(H + 4 * HOUR_MS).toISOString() }),
			note(w, { id: "evt_v16_new", newSig: SECOND_SIGNATURE, ts: NOTE_TS }),
		);
		cluster(w, { [NEW_SIGNATURE]: tx(storedRow(w).memo) });
		const result = await verifyEventRef(w.ports, "evt_v16_note");
		expect(result.status).toBe("unverified");
		if (!("evidence" in result)) throw new Error("expected evidence");
		expect(result.evidence.signature).toBe(SECOND_SIGNATURE);

		// A repair note written later (same signature as the older note, newer ts) becomes the pointer and the hour verifies.
		w.ledger.events.push(note(w, { id: "evt_v16_repair", newSig: NEW_SIGNATURE, ts: new Date(H + 5 * HOUR_MS + 30 * 60_000).toISOString() }));
		expect((await verifyEventRef(w.ports, "evt_v16_note")).status).toBe("anchored");
	});

	test("readReanchorNotes reads the hour's session once per operator surface, keeps only notes of that hour, newest first", async () => {
		const w = world(event({ id: "evt_v16_note" }));
		const otherHour = buildReanchorEvent({ period_start: new Date(H + HOUR_MS).toISOString(), root: storedRow(w).root, event_count: 5, previous_tx_sig: SIGNATURE, new_tx_sig: SECOND_SIGNATURE, genesis: DEVNET_GENESIS_HASH });
		w.ledger.events.push(
			note(w, { id: "evt_v16_a", ts: new Date(H + 4 * HOUR_MS).toISOString() }),
			note(w, { id: "evt_v16_b", ts: NOTE_TS }),
			note(w, { id: "evt_v16_forged", surface: "omp" }),
			event({ id: "evt_v16_other_hour", surface: OPERATOR as SubstrateEvent["surface"], kind: otherHour.kind, summary: otherHour.summary, payload: { ...otherHour.payload }, session_id: reanchorSessionId(storedRow(w).period_start), ts: NOTE_TS }),
			event({ id: "evt_v16_plain", surface: OPERATOR as SubstrateEvent["surface"], session_id: reanchorSessionId(storedRow(w).period_start), ts: NOTE_TS }),
			note(w, { id: "evt_v16_elsewhere", session: "sess-elsewhere" }),
		);
		const { records, incomplete } = await readReanchorNotes(w.ports, H);
		expect(incomplete).toBeNull();
		expect(records.map((record) => record.event_id)).toEqual(["evt_v16_b", "evt_v16_a"]);
		expect(records.every((record) => record.surface === OPERATOR && record.payload.new_tx_sig === NEW_SIGNATURE)).toBe(true);
		// The author filter is in the query itself, so the row limit applies to trusted notes only.
		expect(w.ledger.queries).toEqual([{ match: { kind: "note", session_id: "anchor:2026-10-20T10", surface: OPERATOR }, limit: LOOKUP_ROW_LIMIT, order: "desc", includePayload: true }]);
	});

	test("readReanchorNotes asks nothing without an operator surface or a ledger", async () => {
		const w = world(event({ id: "evt_v16_note" }));
		expect(await readReanchorNotes({ ...w.ports, operatorSurfaces: new Set() }, H)).toEqual({ records: [], incomplete: null });
		expect(await readReanchorNotes({ ...w.ports, ledger: null }, H)).toEqual({ records: [], incomplete: null });
		expect(w.ledger.queries).toEqual([]);
	});

	test("every operator surface is read: the newest bound note across them wins", async () => {
		const w = world(event({ id: "evt_v16_note" }));
		w.ports.operatorSurfaces = new Set([OPERATOR, "omp"]);
		w.ledger.events.push(note(w, { id: "evt_v16_hermes", ts: new Date(H + 4 * HOUR_MS).toISOString() }), note(w, { id: "evt_v16_omp", surface: "omp", newSig: SECOND_SIGNATURE, ts: NOTE_TS }));
		const { records } = await readReanchorNotes(w.ports, H, storedRow(w));
		expect(records.map((record) => record.event_id)).toEqual(["evt_v16_omp", "evt_v16_hermes"]);
		expect(w.ledger.queries.map((query) => query.match?.surface)).toEqual(["hermes", "omp"]);
		const followed = await followReanchor(w.ports, H, storedRow(w));
		expect(followed.tx_sig).toBe(SECOND_SIGNATURE);
	});

	test("600 ordinary notes of another caller in the predictable session, newer than the real note, do not hide it", async () => {
		const w = world(event({ id: "evt_v16_note" }));
		w.ledger.events.push(note(w));
		for (let i = 0; i < 600; i++) {
			w.ledger.events.push(event({ id: `evt_v16_noise_${i}`, surface: "omp" as SubstrateEvent["surface"], session_id: reanchorSessionId(storedRow(w).period_start), ts: new Date(H + 6 * HOUR_MS + i * 1000).toISOString() }));
		}
		cluster(w, { [NEW_SIGNATURE]: tx(storedRow(w).memo) });
		const result = await verifyEventRef(w.ports, "evt_v16_note");
		expect(result.status).toBe("anchored");
		if (!("evidence" in result)) throw new Error("expected evidence");
		expect(result.evidence.signature).toBe(NEW_SIGNATURE);
		const sessionQueries = w.ledger.queries.filter((query) => query.match?.session_id !== undefined);
		expect(sessionQueries).toHaveLength(1);
		expect(sessionQueries[0]?.match?.surface).toBe(OPERATOR);
	});

	test("a trusted surface's own noise is paged past until the newest bound note is found", async () => {
		const w = world(event({ id: "evt_v16_note" }));
		w.ledger.events.push(note(w));
		const session = reanchorSessionId(storedRow(w).period_start);
		for (let i = 0; i < 600; i++) {
			w.ledger.events.push(event({ id: `evt_v16_noise_${i}`, surface: OPERATOR as SubstrateEvent["surface"], session_id: session, ts: new Date(H + 6 * HOUR_MS + i * 1000).toISOString() }));
		}
		cluster(w, { [NEW_SIGNATURE]: tx(storedRow(w).memo) });
		const result = await verifyEventRef(w.ports, "evt_v16_note");
		expect(result.status).toBe("anchored");
		const sessionQueries = w.ledger.queries.filter((query) => query.match?.session_id !== undefined);
		expect(sessionQueries).toHaveLength(2);
		// The second page continues from the oldest note of the first (the 500th newest of 600 noise notes).
		expect(sessionQueries[1]?.until).toBe(new Date(H + 6 * HOUR_MS + 100 * 1000).toISOString());
	});

	test("a read cut by its page cap is unverified with a reason of its own: the stored row is never judged through it", async () => {
		const w = world(event({ id: "evt_v16_note" }));
		w.ledger.events.push(note(w));
		const session = reanchorSessionId(storedRow(w).period_start);
		const original = w.ledger.queryEvents.bind(w.ledger);
		let served = 0;
		w.ledger.queryEvents = async (query: EventQuery = {}) => {
			if (query.match?.session_id !== session) return original(query);
			w.ledger.calls.queryEvents++;
			w.ledger.queries.push(query);
			// A trusted surface with more notes than the page cap reads: the real note is never reached.
			return Array.from({ length: LOOKUP_ROW_LIMIT }, () => {
				const n = served++;
				return toRow(event({ id: `evt_v16_flood_${n}`, surface: OPERATOR as SubstrateEvent["surface"], session_id: session, ts: new Date(H + 40 * HOUR_MS - n * 1000).toISOString() }));
			});
		};
		cluster(w, { [NEW_SIGNATURE]: tx(storedRow(w).memo) });

		const { incomplete } = await readReanchorNotes(w.ports, H, storedRow(w));
		expect(incomplete).toContain(`${REANCHOR_READ_MAX_PAGES}-page limit`);
		await expect(followReanchor(w.ports, H, storedRow(w))).rejects.toBeInstanceOf(ReanchorReadIncomplete);

		const result = await verifyEventRef(w.ports, "evt_v16_note");
		expect(result.status).toBe("unverified");
		expect(result.reasons.join(" ")).toContain("could not be read completely");
		// The old signature was never asked about.
		expect(sigsRead(w)).toEqual([]);
	});

	test("a failed first read of the replacement is the failed read of the verification too: unverified, never a mismatch against the stale signer", async () => {
		const w = world(event({ id: "evt_v16_note" }));
		const rotation = buildSignerRotateEvent({ old_pubkey: SIGNER_A, new_pubkey: SIGNER_B, effective_from_ms: H + 4 * HOUR_MS, reason: "rotate the anchor key" });
		w.ledger.events.push(
			event({ id: "evt_v16_rotate", surface: OPERATOR as SubstrateEvent["surface"], session_id: null, kind: rotation.kind, summary: rotation.summary, payload: { ...rotation.payload }, ts: new Date(H + 4 * HOUR_MS).toISOString() }),
			note(w),
		);
		const replacement = tx(storedRow(w).memo, { payer: SIGNER_B });
		let reads = 0;
		w.rpc.transactionMemo = async (signature: string, commitment: string) => {
			w.rpc.calls.push([signature, commitment]);
			reads++;
			// The first read fails; a second one would succeed, and would name a signer other than the stored row's.
			if (reads === 1) throw new Error("rpc down");
			return commitment === "finalized" ? replacement : null;
		};
		const result = await verifyEventRef(w.ports, "evt_v16_note");
		expect(result.status).toBe("unverified");
		expect(reads).toBe(1);
	});

	test("followReanchor swaps only the pointer: the row's root, count and memo stay, and a chain read adds the signer and slot", async () => {
		const w = world(event({ id: "evt_v16_note" }));
		w.ledger.events.push(note(w));
		const row = storedRow(w);

		const bare = await followReanchor(w.ports, H, row);
		expect(bare).toEqual({ ...row, tx_sig: NEW_SIGNATURE, anchored_at: NOTE_TS });

		const read = await followReanchor(w.ports, H, row, async (signature) => {
			expect(signature).toBe(NEW_SIGNATURE);
			return { memo: row.memo, signer: SIGNER_B, signerSigned: true, err: null, slot: 77, blockTimeMs: H, finality: "finalized" };
		});
		expect(read).toEqual({ ...row, tx_sig: NEW_SIGNATURE, signer: SIGNER_B, slot: 77, anchored_at: NOTE_TS });
		// The stored row object itself was not changed.
		expect(row.tx_sig).toBe(SIGNATURE);

		const failing = await followReanchor(w.ports, H, row, async () => {
			throw new Error("rpc down");
		});
		expect(failing).toEqual({ ...row, tx_sig: NEW_SIGNATURE, anchored_at: NOTE_TS });
	});

	test("followReanchor keeps the stored row when the ledger cannot be read, and never throws", async () => {
		const w = world(event({ id: "evt_v16_note" }));
		w.ledger.events.push(note(w));
		w.ledger.failQuery = "greptime unreachable";
		const row = storedRow(w);
		expect(await followReanchor(w.ports, H, row)).toBe(row);
	});
});
