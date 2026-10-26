import { describe, expect, test } from "bun:test";
import {
	bytesToHex,
	formatMemo,
	HOUR_MS,
	hexToBytes,
	merkleRoot,
	merkleRootHex,
	parseSignerSet,
	verifyMerkleProofHex,
	YOUNG_ANCHOR_GRACE_MS,
} from "@substrate/ledger";
import {
	type AnchorTransactionRead,
	CHECKPOINT_VERIFY_STATUSES,
	type CheckpointVerifyDeps,
	CheckpointVerifyError,
	DEFAULT_ANCHOR_LAG_MS,
	type HourLeafRead,
	verifyCheckpoint,
} from "./checkpoint-verify.ts";
import { eventHash } from "./event.ts";
import { INGEST_LAG_MS, type AnchorRow } from "./greptime.ts";
import { buildCheckpointEvent } from "./session-events.ts";
import { VERIFY_PENDING_MS } from "./service.ts";
import type { SubstrateEvent } from "./types.ts";

/**
 * Proof for phase 59b: a checkpoint resolves to its hour root, inclusion proof, anchors row and devnet
 * transaction, and lands in exactly one of five statuses. Everything is injected: no network, no clock.
 */

const H = Date.UTC(2026, 9, 20, 10);
const GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqaEyCydFLPYGEC";
const OTHER_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
// Real 32-byte public keys (the three memo program ids), so base58 validation is exercised for real.
const SIGNER_A = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo";
const SIGNER_B = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const SIGNER_C = "Memo4c2pN8afCj432Lb7RMVKi9PbQnnW7ewFFaV3oAH";
const SIGNATURE = `5${"a".repeat(87)}`;
const CKPT = "ckpt_0123456789abcdefghjkmnpqrs";
const HEX_64 = "0123456789abcdef".repeat(4);
const HEX_40 = "0123456789abcdef0123456789abcdef01234567";
const ANCHORED_AT = H + 2 * HOUR_MS;
const BLOCK_TIME = ANCHORED_AT + 30_000;
const NOW = H + 6 * HOUR_MS;

function leafHash(i: number): string {
	return new Bun.CryptoHasher("sha256").update(`p59b-leaf:${i}`).digest("hex");
}

function checkpointEvent(): SubstrateEvent {
	const draft = buildCheckpointEvent("sess-p59b", {
		ckpt_id: CKPT,
		seq: 1,
		trigger: "turn",
		git_tree: HEX_40,
		manifest_sha256: HEX_64,
		file_count: 3,
		skipped_count: 0,
	});
	const base: Omit<SubstrateEvent, "hash"> = {
		id: "evt_p59bcheckpoint000000000000000001",
		ts: new Date(H + 30 * 60_000).toISOString(),
		surface: "claude-code",
		session_id: "sess-p59b",
		graph_id: null,
		node_id: null,
		linear_identifier: null,
		step: null,
		repo: null,
		branch: null,
		actor: "agent",
		kind: draft.kind,
		summary: draft.summary,
		payload: { ...draft.payload },
		prev: null,
	};
	return { ...base, hash: eventHash(base) };
}

interface Scenario {
	event: SubstrateEvent;
	leaves: HourLeafRead[];
	row: AnchorRow;
	tx: AnchorTransactionRead;
	root: string;
}

/** An hour of `size` events with the checkpoint at `index`, anchored by SIGNER_A. The root is the production tree's, the memo the production memo's. */
function scenario(size: number, index: number): Scenario {
	const event = checkpointEvent();
	const leaves: HourLeafRead[] = Array.from({ length: size }, (_, i) =>
		i === index ? { event_id: event.id, hash: event.hash } : { event_id: `evt_p59bother${String(i).padStart(4, "0")}`, hash: leafHash(i) },
	);
	const root = merkleRootHex(leaves.map((leaf) => leaf.hash));
	const memo = formatMemo({ periodStartMs: H, rootHex: root, count: size });
	return {
		event,
		leaves,
		root,
		row: {
			period_start: new Date(H).toISOString(),
			period_end: new Date(H + HOUR_MS).toISOString(),
			root,
			event_count: size,
			memo,
			tx_sig: SIGNATURE,
			signer: SIGNER_A,
			cluster: "devnet",
			slot: 4242,
			anchored_at: new Date(ANCHORED_AT).toISOString(),
			stale_hashes: null,
		},
		tx: { memo, signer: SIGNER_A, signerSigned: true, err: null, slot: 4242, blockTimeMs: BLOCK_TIME, finality: "finalized" },
	};
}

interface Calls {
	rows: number;
	leaves: number;
	genesis: number;
	transactions: number;
}

function depsFor(s: Scenario, overrides: Partial<CheckpointVerifyDeps> = {}): { deps: CheckpointVerifyDeps; calls: Calls } {
	const calls: Calls = { rows: 0, leaves: 0, genesis: 0, transactions: 0 };
	const deps: CheckpointVerifyDeps = {
		findEvent: async (ref) => (ref === CKPT || ref === s.event.id ? { event: s.event, ingested_at_ms: H + 30 * 60_000 } : null),
		listHourLeaves: async () => {
			calls.leaves++;
			return s.leaves;
		},
		readAnchorRow: async (hour) => {
			calls.rows++;
			return hour === H ? s.row : null;
		},
		fetchAnchorTransaction: async (signature) => {
			calls.transactions++;
			return signature === s.row.tx_sig ? s.tx : null;
		},
		getGenesisHash: async () => {
			calls.genesis++;
			return GENESIS;
		},
		signerSet: parseSignerSet([{ pubkey: SIGNER_A, valid_from_ms: 0, valid_until_ms: null }]),
		nowMs: NOW,
		config: { expectedGenesis: GENESIS, anchorLagMs: DEFAULT_ANCHOR_LAG_MS, maxLeaves: 1000 },
		...overrides,
	};
	return { deps, calls };
}

const flip = (hex: string): string => (hex[0] === "0" ? "1" : "0") + hex.slice(1);

describe("anchored: a proof for every tree size 1..17 at every index", () => {
	for (let size = 1; size <= 17; size++) {
		test(`size ${size}: every index is anchored and its proof verifies against the production root`, async () => {
			for (let index = 0; index < size; index++) {
				const s = scenario(size, index);
				const { deps } = depsFor(s);
				const result = await verifyCheckpoint(deps, CKPT);
				expect({ size, index, status: result.status, reasons: result.reasons }).toEqual({ size, index, status: "anchored", reasons: [] });
				expect(result.evidence).toMatchObject({
					event_hash: s.event.hash,
					leaf_index: index,
					computed_root: s.root,
					anchored_root: s.root,
					count: size,
					signature: SIGNATURE,
					slot: 4242,
					signer: SIGNER_A,
					block_time_ms: BLOCK_TIME,
					finality: "finalized",
				});
				// The proof is checkable on its own, against the root built by the production tree.
				expect(result.evidence.proof).not.toBeNull();
				expect(verifyMerkleProofHex(s.event.hash, { index, size, path: result.evidence.proof as string[] }, bytesToHex(merkleRoot(s.leaves.map((leaf) => hexToBytes(leaf.hash)))))).toBe(true);
			}
		});
	}

	test("the anchor job's leaf order and hashing: the hour root is merkleRootHex over the hashes in ingest order", () => {
		// service.ts hourDigest: root = merkleRootHex(leaves.map(leaf => leaf.hash)); memo = formatMemo(...).
		const s = scenario(5, 2);
		expect(s.root).toBe(bytesToHex(merkleRoot(s.leaves.map((leaf) => hexToBytes(leaf.hash)))));
		expect(s.row.memo).toBe(formatMemo({ periodStartMs: H, rootHex: s.root, count: 5 }));
	});

	test("an event id resolves the same checkpoint as its ckpt id", async () => {
		const s = scenario(4, 3);
		const { deps } = depsFor(s);
		const byEvent = await verifyCheckpoint(deps, s.event.id);
		const byCkpt = await verifyCheckpoint(deps, CKPT);
		expect(byEvent).toEqual({ ...byCkpt, ref: s.event.id });
		expect(byEvent.checkpoint).toMatchObject({ ckpt_id: CKPT, seq: 1, trigger: "turn", git_tree: HEX_40, manifest_sha256: HEX_64, event_id: s.event.id });
		expect(byEvent.hour_start).toBe(new Date(H).toISOString());
	});

	test("the result's status is always one of the five", async () => {
		const { deps } = depsFor(scenario(3, 1));
		expect(CHECKPOINT_VERIFY_STATUSES).toEqual(["anchored", "pending", "unanchored", "unverified", "mismatch"]);
		expect(CHECKPOINT_VERIFY_STATUSES).toContain((await verifyCheckpoint(deps, CKPT)).status);
	});

	test("the pending window is service.ts's own constant", () => {
		expect(DEFAULT_ANCHOR_LAG_MS).toBe(VERIFY_PENDING_MS);
	});
});

describe("pending and unanchored", () => {
	test("an hour that is not closed is pending and nothing is read", async () => {
		const s = scenario(3, 1);
		const { deps, calls } = depsFor(s, { nowMs: H + HOUR_MS + INGEST_LAG_MS - 1 });
		const result = await verifyCheckpoint(deps, CKPT);
		expect(result.status).toBe("pending");
		expect(calls).toEqual({ rows: 0, leaves: 0, genesis: 0, transactions: 0 });
		expect(result.evidence).toMatchObject({ event_hash: s.event.hash, leaf_index: null, proof: null });
	});

	test("a closed hour with no row inside the lag window is pending; past it, unanchored", async () => {
		const s = scenario(3, 1);
		const noRow: Partial<CheckpointVerifyDeps> = { readAnchorRow: async () => null };
		const early = await verifyCheckpoint(depsFor(s, { ...noRow, nowMs: H + HOUR_MS + INGEST_LAG_MS }).deps, CKPT);
		expect(early.status).toBe("pending");
		const justInside = await verifyCheckpoint(depsFor(s, { ...noRow, nowMs: H + HOUR_MS + DEFAULT_ANCHOR_LAG_MS - 1 }).deps, CKPT);
		expect(justInside.status).toBe("pending");
		const late = await verifyCheckpoint(depsFor(s, { ...noRow, nowMs: H + HOUR_MS + DEFAULT_ANCHOR_LAG_MS }).deps, CKPT);
		expect(late.status).toBe("unanchored");
		expect(late.reasons[0]).toContain("no anchors row");
	});

	test("a row that landed inside the pending window is verified, not pending", async () => {
		const s = scenario(3, 1);
		const { deps } = depsFor(s, { nowMs: H + HOUR_MS + 10 * 60_000 });
		expect((await verifyCheckpoint(deps, CKPT)).status).toBe("anchored");
	});

	test("an event with no ingest record is unanchored: no hour covers it", async () => {
		const s = scenario(3, 1);
		const { deps } = depsFor(s, { findEvent: async () => ({ event: s.event, ingested_at_ms: null }) });
		const result = await verifyCheckpoint(deps, CKPT);
		expect(result.status).toBe("unanchored");
		expect(result.hour_start).toBeNull();
	});
});

describe("unverified: the chain could not settle it, which is never mismatch", () => {
	test("an unreachable RPC (genesis read throws)", async () => {
		const s = scenario(4, 1);
		const { deps } = depsFor(s, {
			getGenesisHash: async () => {
				throw new Error("fetch failed: ECONNREFUSED");
			},
		});
		const result = await verifyCheckpoint(deps, CKPT);
		expect(result.status).toBe("unverified");
		expect(result.reasons.join(" ")).toContain("genesis hash could not be read");
	});

	test("an unreachable RPC (transaction read throws)", async () => {
		const s = scenario(4, 1);
		const { deps } = depsFor(s, {
			fetchAnchorTransaction: async () => {
				throw new Error("timeout after 5000 ms");
			},
		});
		const result = await verifyCheckpoint(deps, CKPT);
		expect(result.status).toBe("unverified");
		expect(result.reasons.join(" ")).toContain("could not be read");
	});

	test("a different genesis hash is a suspected devnet reset, unverified, never mismatch", async () => {
		const s = scenario(4, 1);
		const { deps } = depsFor(s, { getGenesisHash: async () => OTHER_GENESIS, fetchAnchorTransaction: async () => null });
		const result = await verifyCheckpoint(deps, CKPT);
		expect(result.status).toBe("unverified");
		expect(result.reasons[0]).toContain("probably reset");
	});

	test("a signature the (right) cluster does not know, long after anchoring, is unverified", async () => {
		const s = scenario(4, 1);
		const { deps } = depsFor(s, { fetchAnchorTransaction: async () => null });
		const result = await verifyCheckpoint(deps, CKPT);
		expect(result.status).toBe("unverified");
		expect(result.reasons[0]).toContain("not found");
	});

	test("a signature that is not visible yet on a young anchor is unverified, not a missing signature", async () => {
		const s = scenario(4, 1);
		const { deps } = depsFor(s, { fetchAnchorTransaction: async () => null, nowMs: ANCHORED_AT + YOUNG_ANCHOR_GRACE_MS - 1 });
		const result = await verifyCheckpoint(deps, CKPT);
		expect(result.status).toBe("unverified");
		expect(result.reasons[0]).toContain("grace window");
	});

	test("a processed-only transaction is not enough", async () => {
		const s = scenario(4, 1);
		const { deps } = depsFor(s, { fetchAnchorTransaction: async () => ({ ...s.tx, finality: "processed" }) });
		expect((await verifyCheckpoint(deps, CKPT)).status).toBe("unverified");
	});

	test("a confirmed transaction is accepted (the anchor job writes at confirmed)", async () => {
		const s = scenario(4, 1);
		const { deps } = depsFor(s, { fetchAnchorTransaction: async () => ({ ...s.tx, finality: "confirmed" }) });
		const result = await verifyCheckpoint(deps, CKPT);
		expect(result.status).toBe("anchored");
		expect(result.evidence.finality).toBe("confirmed");
	});

	test("with the chain unreachable, a ledger-side disagreement stays unverified and is listed as a note", async () => {
		const s = scenario(4, 1);
		const { deps } = depsFor(s, {
			listHourLeaves: async () => s.leaves.map((leaf, i) => (i === 0 ? { ...leaf, hash: flip(leaf.hash) } : leaf)),
			getGenesisHash: async () => {
				throw new Error("down");
			},
		});
		const result = await verifyCheckpoint(deps, CKPT);
		expect(result.status).toBe("unverified");
		expect(result.reasons.some((reason) => reason.startsWith("ledger-side note: the recomputed root differs"))).toBe(true);
	});

	test("an hour with more leaves than maxLeaves is unverified with that reason, and its leaves are never listed", async () => {
		const s = scenario(10, 3);
		const { deps, calls } = depsFor(s, { config: { expectedGenesis: GENESIS, anchorLagMs: DEFAULT_ANCHOR_LAG_MS, maxLeaves: 9 } });
		const result = await verifyCheckpoint(deps, CKPT);
		expect(result.status).toBe("unverified");
		expect(result.reasons[0]).toContain("more than the 9");
		expect(calls.leaves).toBe(0);
		expect(calls.genesis).toBe(0);
	});

	test("a reader that returns more than maxLeaves entries is unverified too", async () => {
		const s = scenario(10, 3);
		const { deps } = depsFor(s, {
			config: { expectedGenesis: GENESIS, anchorLagMs: DEFAULT_ANCHOR_LAG_MS, maxLeaves: 10 },
			listHourLeaves: async () => [...s.leaves, { event_id: "evt_extra", hash: leafHash(99) }],
		});
		const result = await verifyCheckpoint(deps, CKPT);
		expect(result.status).toBe("unverified");
		expect(result.reasons[0]).toContain("more than 10");
	});

	test("an hour whose leaves or row cannot be read is unverified", async () => {
		const s = scenario(4, 1);
		const leavesDown = await verifyCheckpoint(
			depsFor(s, {
				listHourLeaves: async () => {
					throw new Error("hour member evt_x has no event row");
				},
			}).deps,
			CKPT,
		);
		expect(leavesDown.status).toBe("unverified");
		const rowDown = await verifyCheckpoint(
			depsFor(s, {
				readAnchorRow: async () => {
					throw new Error("ledger down");
				},
			}).deps,
			CKPT,
		);
		expect(rowDown.status).toBe("unverified");
	});

	test("a chain read with no block time yet cannot check the signer window: unverified", async () => {
		const s = scenario(4, 1);
		const { deps } = depsFor(s, { fetchAnchorTransaction: async () => ({ ...s.tx, blockTimeMs: null }) });
		const result = await verifyCheckpoint(deps, CKPT);
		expect(result.status).toBe("unverified");
		expect(result.reasons[0]).toContain("block time");
	});
});

describe("mismatch: a chain read that succeeded disagrees with the ledger", () => {
	test("event content changed after it was written (stored hash no longer matches)", async () => {
		const s = scenario(4, 1);
		const tampered: SubstrateEvent = { ...s.event, summary: "session checkpoint rewritten" };
		const { deps, calls } = depsFor(s, { findEvent: async () => ({ event: tampered, ingested_at_ms: H + 30 * 60_000 }) });
		const result = await verifyCheckpoint(deps, CKPT);
		expect(result.status).toBe("mismatch");
		expect(result.reasons[0]).toContain("no longer hashes");
		expect(calls.transactions).toBe(0);
	});

	test("event payload changed after it was written", async () => {
		const s = scenario(4, 1);
		const tampered: SubstrateEvent = { ...s.event, payload: { ...s.event.payload, git_tree: "f".repeat(40) } };
		const { deps } = depsFor(s, { findEvent: async () => ({ event: tampered, ingested_at_ms: H + 30 * 60_000 }) });
		expect((await verifyCheckpoint(deps, CKPT)).status).toBe("mismatch");
	});

	test("event stored hash replaced by another well-formed hash", async () => {
		const s = scenario(4, 1);
		const tampered: SubstrateEvent = { ...s.event, hash: flip(s.event.hash) };
		const { deps } = depsFor(s, { findEvent: async () => ({ event: tampered, ingested_at_ms: H + 30 * 60_000 }) });
		expect((await verifyCheckpoint(deps, CKPT)).status).toBe("mismatch");
	});

	test("an attacker who re-hashes a rewritten event still fails: the anchored root holds the old hash", async () => {
		const s = scenario(4, 1);
		const { hash: _old, ...rest } = s.event;
		const rewritten = { ...rest, summary: "session checkpoint rewritten, consistently re-hashed" };
		const forged: SubstrateEvent = { ...rewritten, hash: eventHash(rewritten) };
		const { deps } = depsFor(s, { findEvent: async () => ({ event: forged, ingested_at_ms: H + 30 * 60_000 }) });
		const result = await verifyCheckpoint(deps, CKPT);
		expect(result.status).toBe("mismatch");
		expect(result.reasons.join(" ")).toContain("carries a different hash than the event");
	});

	test("a leaf changed or swapped in the hour: the recomputed root differs from the chain's", async () => {
		const s = scenario(6, 2);
		const changed = await verifyCheckpoint(
			depsFor(s, { listHourLeaves: async () => s.leaves.map((leaf, i) => (i === 4 ? { ...leaf, hash: flip(leaf.hash) } : leaf)) }).deps,
			CKPT,
		);
		expect(changed.status).toBe("mismatch");
		expect(changed.reasons.join(" ")).toContain("differs from the recomputed");
		const swapped = [...s.leaves];
		[swapped[0], swapped[5]] = [swapped[5] as HourLeafRead, swapped[0] as HourLeafRead];
		const reordered = await verifyCheckpoint(depsFor(s, { listHourLeaves: async () => swapped }).deps, CKPT);
		expect(reordered.status).toBe("mismatch");
	});

	test("the event is missing from its hour's leaves", async () => {
		const s = scenario(5, 2);
		const { deps } = depsFor(s, { listHourLeaves: async () => s.leaves.filter((_, i) => i !== 2) });
		const result = await verifyCheckpoint(deps, CKPT);
		expect(result.status).toBe("mismatch");
		expect(result.reasons.join(" ")).toContain("not a member of its hour's leaves");
		expect(result.evidence.leaf_index).toBeNull();
	});

	test("the chain's root is not the recomputed root", async () => {
		const s = scenario(5, 2);
		const { deps } = depsFor(s, {
			fetchAnchorTransaction: async () => ({ ...s.tx, memo: formatMemo({ periodStartMs: H, rootHex: flip(s.root), count: 5 }) }),
		});
		const result = await verifyCheckpoint(deps, CKPT);
		expect(result.status).toBe("mismatch");
		expect(result.evidence.anchored_root).toBe(flip(s.root));
		expect(result.reasons.join(" ")).toContain("does not verify against the anchored root");
	});

	test("the memo's count is wrong: the proof's size is bound to it and the proof fails", async () => {
		const s = scenario(5, 2);
		for (const count of [4, 6, 8]) {
			const { deps } = depsFor(s, { fetchAnchorTransaction: async () => ({ ...s.tx, memo: formatMemo({ periodStartMs: H, rootHex: s.root, count }) }) });
			const result = await verifyCheckpoint(deps, CKPT);
			expect({ count, status: result.status }).toEqual({ count, status: "mismatch" });
			expect(result.reasons.join(" ")).toContain("inclusion proof does not verify");
		}
	});

	test("the memo names another hour, is not a v1 memo, or is absent", async () => {
		const s = scenario(5, 2);
		const otherHour = await verifyCheckpoint(
			depsFor(s, { fetchAnchorTransaction: async () => ({ ...s.tx, memo: formatMemo({ periodStartMs: H - HOUR_MS, rootHex: s.root, count: 5 }) }) }).deps,
			CKPT,
		);
		expect(otherHour.status).toBe("mismatch");
		const notV1 = await verifyCheckpoint(depsFor(s, { fetchAnchorTransaction: async () => ({ ...s.tx, memo: `substrate:v2:${s.root}` }) }).deps, CKPT);
		expect(notV1.status).toBe("mismatch");
		const noMemo = await verifyCheckpoint(depsFor(s, { fetchAnchorTransaction: async () => ({ ...s.tx, memo: null }) }).deps, CKPT);
		expect(noMemo.status).toBe("mismatch");
	});

	test("a failed transaction is a mismatch", async () => {
		const s = scenario(3, 0);
		const { deps } = depsFor(s, { fetchAnchorTransaction: async () => ({ ...s.tx, err: { InstructionError: [0, "Custom"] } }) });
		expect((await verifyCheckpoint(deps, CKPT)).status).toBe("mismatch");
	});

	test("the anchors row disagrees with the chain memo or with its own memo", async () => {
		const s = scenario(5, 2);
		const rowCount = await verifyCheckpoint(depsFor(s, { readAnchorRow: async () => ({ ...s.row, event_count: 6 }) }).deps, CKPT);
		expect(rowCount.status).toBe("mismatch");
		const rowRoot = await verifyCheckpoint(depsFor(s, { readAnchorRow: async () => ({ ...s.row, root: flip(s.root) }) }).deps, CKPT);
		expect(rowRoot.status).toBe("mismatch");
		const rowPeriod = await verifyCheckpoint(
			depsFor(s, { readAnchorRow: async () => ({ ...s.row, memo: formatMemo({ periodStartMs: H - HOUR_MS, rootHex: s.root, count: 5 }) }) }).deps,
			CKPT,
		);
		expect(rowPeriod.status).toBe("mismatch");
	});

	test("a wrong signer, or an unsigned memo transaction", async () => {
		const s = scenario(5, 2);
		const wrong = await verifyCheckpoint(depsFor(s, { fetchAnchorTransaction: async () => ({ ...s.tx, signer: SIGNER_C }) }).deps, CKPT);
		expect(wrong.status).toBe("mismatch");
		expect(wrong.reasons.join(" ")).toContain("not in the signer set");
		const unsigned = await verifyCheckpoint(depsFor(s, { fetchAnchorTransaction: async () => ({ ...s.tx, signerSigned: false }) }).deps, CKPT);
		expect(unsigned.status).toBe("mismatch");
		const rowNamesOther = await verifyCheckpoint(depsFor(s, { readAnchorRow: async () => ({ ...s.row, signer: SIGNER_B }) }).deps, CKPT);
		expect(rowNamesOther.status).toBe("mismatch");
	});
});

describe("rotated signers: accepted by the anchor's block time, not by who is current", () => {
	const ROTATION = H + HOUR_MS + 30 * 60_000;
	const signerSet = parseSignerSet([
		{ pubkey: SIGNER_A, valid_from_ms: 0, valid_until_ms: ROTATION },
		{ pubkey: SIGNER_B, valid_from_ms: ROTATION, valid_until_ms: null },
	]);

	test("the old signer inside its window is anchored even though it was rotated out later", async () => {
		const s = scenario(4, 1);
		const { deps } = depsFor(s, { signerSet, fetchAnchorTransaction: async () => ({ ...s.tx, blockTimeMs: ROTATION - 1 }) });
		expect((await verifyCheckpoint(deps, CKPT)).status).toBe("anchored");
	});

	test("the old signer after its window closed is a mismatch", async () => {
		const s = scenario(4, 1);
		const { deps } = depsFor(s, { signerSet, fetchAnchorTransaction: async () => ({ ...s.tx, blockTimeMs: ROTATION }) });
		const result = await verifyCheckpoint(deps, CKPT);
		expect(result.status).toBe("mismatch");
		expect(result.reasons.join(" ")).toContain("outside its valid window");
	});

	test("the new signer inside its window is anchored; before its window it is a mismatch", async () => {
		const s = scenario(4, 1);
		const row = { ...s.row, signer: SIGNER_B };
		const inside = await verifyCheckpoint(
			depsFor(s, { signerSet, readAnchorRow: async () => row, fetchAnchorTransaction: async () => ({ ...s.tx, signer: SIGNER_B, blockTimeMs: ROTATION }) }).deps,
			CKPT,
		);
		expect(inside.status).toBe("anchored");
		const before = await verifyCheckpoint(
			depsFor(s, { signerSet, readAnchorRow: async () => row, fetchAnchorTransaction: async () => ({ ...s.tx, signer: SIGNER_B, blockTimeMs: ROTATION - 1 }) }).deps,
			CKPT,
		);
		expect(before.status).toBe("mismatch");
	});
});

describe("caller errors are typed errors, not statuses", () => {
	const code = async (promise: Promise<unknown>): Promise<string> => {
		try {
			await promise;
		} catch (cause) {
			if (cause instanceof CheckpointVerifyError) return cause.code;
			throw cause;
		}
		return "no error";
	};

	test("a malformed ref", async () => {
		const { deps } = depsFor(scenario(2, 0));
		for (const ref of ["", "has space", "a/b", "x".repeat(129), "'; DROP TABLE x"]) {
			expect({ ref, code: await code(verifyCheckpoint(deps, ref)) }).toEqual({ ref, code: "invalid-ref" });
		}
	});

	test("an unknown ref", async () => {
		const { deps } = depsFor(scenario(2, 0));
		expect(await code(verifyCheckpoint(deps, "ckpt_zzzzzzzzzzzzzzzzzzzzzzzzzz"))).toBe("not-found");
	});

	test("an event that is not a checkpoint", async () => {
		const s = scenario(2, 0);
		const base: Omit<SubstrateEvent, "hash"> = { ...s.event, kind: "tool.call", payload: { action: "shell" } };
		const { hash: _h, ...unhashed } = base as SubstrateEvent;
		const other: SubstrateEvent = { ...unhashed, hash: eventHash(unhashed) };
		const { deps } = depsFor(s, { findEvent: async () => ({ event: other, ingested_at_ms: H + 30 * 60_000 }) });
		expect(await code(verifyCheckpoint(deps, other.id))).toBe("not-a-checkpoint");
	});

	test("a reader that returns a different checkpoint than the one asked for", async () => {
		const s = scenario(2, 0);
		const { deps } = depsFor(s);
		expect(await code(verifyCheckpoint(deps, "ckpt_0123456789abcdefghjkmnpqrr"))).toBe("not-found");
		const confused = depsFor(s, { findEvent: async () => ({ event: s.event, ingested_at_ms: H + 30 * 60_000 }) }).deps;
		expect(await code(verifyCheckpoint(confused, "ckpt_0123456789abcdefghjkmnpqrr"))).toBe("ref-mismatch");
		expect(await code(verifyCheckpoint(confused, "evt_someotherevent"))).toBe("ref-mismatch");
	});

	test("a bad config", async () => {
		const s = scenario(2, 0);
		const bad = [
			{ expectedGenesis: "", anchorLagMs: 1, maxLeaves: 1 },
			{ expectedGenesis: GENESIS, anchorLagMs: -1, maxLeaves: 1 },
			{ expectedGenesis: GENESIS, anchorLagMs: 1, maxLeaves: 0 },
			{ expectedGenesis: GENESIS, anchorLagMs: 1, maxLeaves: 1.5 },
		];
		for (const config of bad) {
			expect({ config, code: await code(verifyCheckpoint(depsFor(s, { config }).deps, CKPT)) }).toEqual({ config, code: "invalid-config" });
		}
		expect(await code(verifyCheckpoint(depsFor(s, { nowMs: Number.NaN }).deps, CKPT))).toBe("invalid-config");
	});
});
