/**
 * Checkpoint anchor verification (v1.6, phase 59b).
 *
 * A `session.checkpoint` event is an ordinary ledger event until something proves it sits inside an
 * hourly Merkle root that was written to Solana devnet. `verifyCheckpoint` resolves a checkpoint (by
 * checkpoint id or event id) to its hour, its inclusion proof, its anchors row and its devnet
 * transaction, and answers with exactly one of five statuses:
 *
 * - `anchored`   — the proof verifies against a root a signer in the signer set wrote on devnet, and
 *                  the memo's count is the proof's tree size;
 * - `pending`    — the hour is not closed (plus the ingest lag) or its anchor may still land;
 * - `unanchored` — the hour closed long ago and no anchors row exists (or no hour covers the event);
 * - `unverified` — a row exists but the chain could not settle it: unreachable RPC, a devnet reset
 *                  (different genesis hash), a missing signature, an hour too large to rebuild here.
 *                  NEVER a verdict of tampering;
 * - `mismatch`   — a chain read that DID succeed disagrees with the ledger: the recomputed root, the
 *                  proof, the memo count or period, or the signer (outside its window) differ, or the
 *                  event no longer hashes to its stored hash.
 *
 * Pure and dependency-injected: every read arrives through `CheckpointVerifyDeps`, the clock is
 * `deps.nowMs`, nothing here reads the environment, sends a transaction or opens a socket. The leaf
 * order and hashing are the anchor job's own (`hourDigest` in service.ts): the hour's event hashes in
 * ingest order, folded with `merkleRootHex`; the proof comes from `merkleProofHex` over the same
 * list and is checked with `verifyMerkleProofAgainstCommitment`, which binds the proof's tree size to
 * the anchored memo's event count (a root alone does not authenticate the size).
 */
import {
	acceptsSigner,
	classifyChainEvidence,
	hourEnd,
	hourIso,
	hourStart,
	isClosed,
	merkleProofHex,
	merkleRootHex,
	parseMemo,
	verifyMerkleProofAgainstCommitment,
	type SignatureStatus,
	type SignerSet,
} from "@substrate/ledger";
import { eventHash } from "./event.ts";
import { INGEST_LAG_MS, type AnchorRow } from "./greptime.ts";
import { redact } from "./redact.ts";
import { parseSessionEventPayload, SESSION_CHECKPOINT_ACTION, SessionEventError, type CheckpointPayload } from "./session-events.ts";
import type { SubstrateEvent } from "./types.ts";

export const CHECKPOINT_VERIFY_STATUSES = ["anchored", "pending", "unanchored", "unverified", "mismatch"] as const;
export type CheckpointVerifyStatus = (typeof CHECKPOINT_VERIFY_STATUSES)[number];

/** How long after an hour ends its anchor may still land before verify calls it unanchored (service.ts `VERIFY_PENDING_MS`). */
export const DEFAULT_ANCHOR_LAG_MS = 3 * 3_600_000;
/** The largest hour this verifier rebuilds in memory by default. */
export const DEFAULT_MAX_LEAVES = 50_000;

const CKPT_ID_RE = /^ckpt_[0-9a-z]{26}$/;
const OPAQUE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const REASON_MAX = 300;

export type CheckpointVerifyErrorCode = "invalid-ref" | "invalid-config" | "not-found" | "not-a-checkpoint" | "ref-mismatch";

/** A caller error (bad ref, missing or foreign event, bad config). Distinct from a verification verdict. */
export class CheckpointVerifyError extends Error {
	override name = "CheckpointVerifyError";
	readonly code: CheckpointVerifyErrorCode;
	constructor(code: CheckpointVerifyErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

/** The event as the ledger stores it, plus the time of its first ingest record (which decides its hour). */
export interface CheckpointEventRecord {
	event: SubstrateEvent;
	/** Epoch ms of the event's first `event_ingest` record; null when it has none, so no hour covers it. */
	ingested_at_ms: number | null;
}

/** One member of an hour, in position order (the shape of the ledger client's `HourLeaf`, less the time). */
export interface HourLeafRead {
	event_id: string;
	/** 64 lowercase hex. */
	hash: string;
}

/** What the chain says about one anchor transaction. Raw: this module parses and checks the memo itself. */
export interface AnchorTransactionRead {
	/** The memo text of the memo-program instruction, or null when the transaction has none. */
	memo: string | null;
	/** The fee payer's public key, or null when the node did not report one. */
	signer: string | null;
	/** Whether the payer signed the transaction. */
	signerSigned: boolean;
	/** The transaction's error, `null` for success. */
	err: unknown;
	slot: number | null;
	/** Block time in epoch ms (convert RPC seconds at the adapter); null when the node has none yet. */
	blockTimeMs: number | null;
	finality: "processed" | "confirmed" | "finalized";
}

export interface CheckpointVerifyConfig {
	/** The genesis hash of the cluster anchors must live on (devnet's). */
	expectedGenesis: string;
	/** How long after an hour ends its anchor may still land (default `DEFAULT_ANCHOR_LAG_MS`). */
	anchorLagMs: number;
	/** Hours with more leaves than this are `unverified` (default `DEFAULT_MAX_LEAVES`). */
	maxLeaves: number;
}

export interface CheckpointVerifyDeps {
	/** Resolve a checkpoint id or an event id to the stored event; null when unknown. */
	findEvent(ref: string): Promise<CheckpointEventRecord | null>;
	/**
	 * The hour's members in the anchor job's order (ingest order) with their stored hashes. May stop at
	 * `maxLeaves + 1` entries: more than `maxLeaves` is all the verifier needs to know.
	 */
	listHourLeaves(hourStartMs: number, maxLeaves: number): Promise<readonly HourLeafRead[]>;
	readAnchorRow(hourStartMs: number): Promise<AnchorRow | null>;
	/** The anchor transaction read back from the cluster; null when the cluster does not know the signature. Throws when unreachable. */
	fetchAnchorTransaction(signature: string): Promise<AnchorTransactionRead | null>;
	/** The cluster's genesis hash. Throws when unreachable. */
	getGenesisHash(): Promise<string>;
	signerSet: SignerSet;
	nowMs: number;
	config: CheckpointVerifyConfig;
}

export interface CheckpointEvidence {
	event_hash: string;
	leaf_index: number | null;
	/** The audit path, leaf to root, as 64-hex strings. */
	proof: string[] | null;
	/** The root recomputed from the ledger's leaves. */
	computed_root: string | null;
	/** The root the chain's memo commits to. */
	anchored_root: string | null;
	/** The memo's event count (the proof's bound tree size). */
	count: number | null;
	signature: string | null;
	slot: number | null;
	signer: string | null;
	block_time_ms: number | null;
	finality: "processed" | "confirmed" | "finalized" | null;
}

export interface CheckpointVerifyResult {
	status: CheckpointVerifyStatus;
	ref: string;
	checkpoint: Pick<CheckpointPayload, "ckpt_id" | "seq" | "trigger" | "git_tree" | "manifest_sha256"> & { event_id: string; session_id: string | null };
	/** ISO start of the hour the event's ingest record places it in; null when it has no ingest record. */
	hour_start: string | null;
	evidence: CheckpointEvidence;
	reasons: string[];
}

function describeCause(cause: unknown): string {
	const text = redact(cause instanceof Error ? cause.message : String(cause));
	return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX)}...` : text;
}

function assertConfig(config: CheckpointVerifyConfig, nowMs: number): void {
	if (typeof config?.expectedGenesis !== "string" || config.expectedGenesis.length === 0) {
		throw new CheckpointVerifyError("invalid-config", "config.expectedGenesis must be a non-empty genesis hash");
	}
	if (!Number.isSafeInteger(config.maxLeaves) || config.maxLeaves < 1) {
		throw new CheckpointVerifyError("invalid-config", "config.maxLeaves must be a positive integer");
	}
	if (!Number.isFinite(config.anchorLagMs) || config.anchorLagMs < 0) {
		throw new CheckpointVerifyError("invalid-config", "config.anchorLagMs must be a non-negative number of milliseconds");
	}
	if (!Number.isFinite(nowMs)) throw new CheckpointVerifyError("invalid-config", "nowMs must be a finite number");
}

/**
 * Verify one checkpoint against the anchored hourly roots. Throws `CheckpointVerifyError` for a bad
 * ref, a bad config, an unknown event or an event that is not a checkpoint; every other outcome is a
 * status. A dependency that throws while reading the chain or the hour is `unverified`, never a crash
 * and never `mismatch`.
 */
export async function verifyCheckpoint(deps: CheckpointVerifyDeps, ref: string): Promise<CheckpointVerifyResult> {
	const { config, nowMs } = deps;
	assertConfig(config, nowMs);
	if (typeof ref !== "string" || !OPAQUE_ID_RE.test(ref)) {
		throw new CheckpointVerifyError("invalid-ref", "ref must be a checkpoint id (ckpt_...) or an event id of 1..128 characters from [A-Za-z0-9._:-]");
	}
	const found = await deps.findEvent(ref);
	if (found === null) throw new CheckpointVerifyError("not-found", `no event or checkpoint matches ${ref}`);
	const { event, ingested_at_ms } = found;

	let payload: CheckpointPayload;
	try {
		const parsed = parseSessionEventPayload(event.payload, { stored: true });
		if (parsed.action !== SESSION_CHECKPOINT_ACTION) throw new SessionEventError("enum", "action", "is not a checkpoint");
		payload = parsed;
	} catch (cause) {
		throw new CheckpointVerifyError("not-a-checkpoint", `event ${event.id} is not a valid ${SESSION_CHECKPOINT_ACTION}: ${describeCause(cause)}`);
	}
	if (CKPT_ID_RE.test(ref) ? payload.ckpt_id !== ref : event.id !== ref) {
		throw new CheckpointVerifyError("ref-mismatch", `the reader returned event ${event.id} (${payload.ckpt_id}) for ref ${ref}`);
	}

	const hour = ingested_at_ms === null || !Number.isFinite(ingested_at_ms) ? null : hourStart(ingested_at_ms);
	const evidence: CheckpointEvidence = {
		event_hash: event.hash,
		leaf_index: null,
		proof: null,
		computed_root: null,
		anchored_root: null,
		count: null,
		signature: null,
		slot: null,
		signer: null,
		block_time_ms: null,
		finality: null,
	};
	const result = (status: CheckpointVerifyStatus, reasons: string[]): CheckpointVerifyResult => ({
		status,
		ref,
		checkpoint: {
			ckpt_id: payload.ckpt_id,
			seq: payload.seq,
			trigger: payload.trigger,
			git_tree: payload.git_tree,
			manifest_sha256: payload.manifest_sha256,
			event_id: event.id,
			session_id: event.session_id,
		},
		hour_start: hour === null ? null : hourIso(hour),
		evidence,
		reasons,
	});

	// The event itself: its stored hash must be the hash of its stored content, or every proof below
	// would be a proof about something the event no longer says.
	const { hash: storedHash, ...rest } = event;
	if (!HASH_RE.test(storedHash)) return result("mismatch", ["the event's stored hash is not 64 lowercase hex"]);
	if (eventHash(rest) !== storedHash) {
		return result("mismatch", ["the event no longer hashes to its stored hash: its content changed after it was written"]);
	}

	if (hour === null) {
		return result("unanchored", ["the event has no ingest record, so no hourly root covers it"]);
	}
	if (!isClosed(hour, nowMs, INGEST_LAG_MS)) {
		return result("pending", [`hour ${hourIso(hour)} is not closed yet (it closes ${INGEST_LAG_MS} ms after it ends)`]);
	}

	let row: AnchorRow | null;
	try {
		row = await deps.readAnchorRow(hour);
	} catch (cause) {
		return result("unverified", [`the anchors row could not be read: ${describeCause(cause)}`]);
	}
	if (row === null) {
		if (nowMs < hourEnd(hour) + config.anchorLagMs) {
			return result("pending", [`no anchors row yet for ${hourIso(hour)}; the anchor may still land within ${config.anchorLagMs} ms of the hour's end`]);
		}
		return result("unanchored", [`no anchors row for ${hourIso(hour)} more than ${config.anchorLagMs} ms after the hour ended`]);
	}

	evidence.signature = row.tx_sig;
	// Disagreements between the ledger's own records. They are findings (mismatch) only once a chain
	// read succeeded; with the chain unreachable the row alone cannot be judged and the status stays
	// `unverified`, with these listed as extra reasons.
	const findings: string[] = [];
	// Things the chain could not settle even though it answered (no block time yet).
	const unresolved: string[] = [];

	if (Date.parse(row.period_start) !== hour) findings.push(`the anchors row names ${row.period_start}, not ${hourIso(hour)}`);
	const rowMemo = parseMemo(row.memo);
	if (rowMemo === null) {
		findings.push("the anchors row's memo is not a v1 anchor memo");
	} else if (rowMemo.periodStartMs !== hour || rowMemo.rootHex !== row.root || rowMemo.count !== row.event_count) {
		findings.push("the anchors row disagrees with its own memo (period, root or count)");
	}
	if (!SIGNATURE_RE.test(row.tx_sig)) findings.push("the anchors row's transaction signature is not a base58 signature");

	if (!Number.isSafeInteger(row.event_count) || row.event_count < 1) {
		return result("unverified", ["the anchors row carries no usable event count"]);
	}
	if (row.event_count > config.maxLeaves) {
		return result("unverified", [`hour ${hourIso(hour)} holds ${row.event_count} events, more than the ${config.maxLeaves} this verifier rebuilds; verify it offline with the archive tools`]);
	}

	let leaves: readonly HourLeafRead[];
	try {
		leaves = await deps.listHourLeaves(hour, config.maxLeaves);
	} catch (cause) {
		return result("unverified", [`the hour's leaves could not be read: ${describeCause(cause)}`]);
	}
	if (leaves.length > config.maxLeaves) {
		return result("unverified", [`hour ${hourIso(hour)} holds more than ${config.maxLeaves} events; verify it offline with the archive tools`]);
	}
	const badLeaf = leaves.findIndex((leaf) => !HASH_RE.test(leaf.hash));
	if (badLeaf !== -1) {
		findings.push(`leaf ${badLeaf} of the hour is not 64 lowercase hex`);
	} else if (leaves.length === 0) {
		findings.push("the hour has no leaves, yet the event has an ingest record in it");
	} else {
		evidence.computed_root = merkleRootHex(leaves.map((leaf) => leaf.hash));
		const index = leaves.findIndex((leaf) => leaf.event_id === event.id);
		if (index === -1) {
			findings.push("the event is not a member of its hour's leaves");
		} else if ((leaves[index] as HourLeafRead).hash !== event.hash) {
			findings.push("the hour's leaf for this event carries a different hash than the event");
		} else {
			const proof = merkleProofHex(
				leaves.map((leaf) => leaf.hash),
				index,
			);
			evidence.leaf_index = index;
			evidence.proof = proof.path;
		}
		if (evidence.computed_root !== row.root) findings.push("the recomputed root differs from the anchors row's root");
		if (leaves.length !== row.event_count) findings.push(`the hour has ${leaves.length} leaves, the anchors row says ${row.event_count}`);
	}

	// The chain. Any failure to ask is `unverified`; only an answer can contradict the ledger.
	let observedGenesis: string | null = null;
	const chainNotes: string[] = [];
	try {
		observedGenesis = await deps.getGenesisHash();
	} catch (cause) {
		chainNotes.push(`the genesis hash could not be read: ${describeCause(cause)}`);
	}
	let transaction: AnchorTransactionRead | null = null;
	let signatureStatus: SignatureStatus = "unreachable";
	if (observedGenesis !== null && SIGNATURE_RE.test(row.tx_sig)) {
		try {
			transaction = await deps.fetchAnchorTransaction(row.tx_sig);
			signatureStatus = transaction === null ? "not-found" : transaction.finality;
		} catch (cause) {
			chainNotes.push(`the anchor transaction could not be read: ${describeCause(cause)}`);
		}
	}
	const anchoredAtMs = Date.parse(row.anchored_at);
	const chain = classifyChainEvidence({
		expectedGenesis: config.expectedGenesis,
		observedGenesis,
		signatureStatus,
		anchoredAtMs: Number.isFinite(anchoredAtMs) ? anchoredAtMs : hourEnd(hour),
		nowMs,
	});
	if (chain.verdict !== "ok" || transaction === null) {
		return result("unverified", [chain.reason, ...chainNotes, ...findings.map((finding) => `ledger-side note: ${finding}`)]);
	}

	evidence.slot = transaction.slot;
	evidence.signer = transaction.signer;
	evidence.block_time_ms = transaction.blockTimeMs;
	evidence.finality = transaction.finality;

	if (transaction.err !== null && transaction.err !== undefined) findings.push("the anchor transaction failed on chain");
	const memo = transaction.memo === null ? null : parseMemo(transaction.memo);
	if (transaction.memo === null) {
		findings.push("the anchor transaction carries no memo-program instruction");
	} else if (memo === null) {
		findings.push("the anchor transaction's memo is not a v1 anchor memo");
	} else {
		evidence.anchored_root = memo.rootHex;
		evidence.count = memo.count;
		if (memo.periodStartMs !== hour) findings.push(`the chain memo names ${hourIso(memo.periodStartMs)}, not ${hourIso(hour)}`);
		if (evidence.computed_root !== null && memo.rootHex !== evidence.computed_root) {
			findings.push(`the chain's root ${memo.rootHex} differs from the recomputed ${evidence.computed_root}`);
		}
		if (memo.count !== leaves.length) findings.push(`the chain memo counts ${memo.count} events, the ledger holds ${leaves.length}`);
		if (memo.rootHex !== row.root || memo.count !== row.event_count) findings.push("the anchors row disagrees with the chain memo");
		if (evidence.proof !== null && evidence.leaf_index !== null) {
			let proofProblem = "the inclusion proof does not verify against the anchored root and event count";
			try {
				if (
					verifyMerkleProofAgainstCommitment(
						event.hash,
						{ index: evidence.leaf_index, size: leaves.length, path: evidence.proof },
						{ rootHex: memo.rootHex, count: memo.count },
					)
				) {
					proofProblem = "";
				}
			} catch (cause) {
				proofProblem = `the inclusion proof is malformed: ${describeCause(cause)}`;
			}
			if (proofProblem !== "") findings.push(proofProblem);
		}
	}

	if (transaction.signer === null || !transaction.signerSigned) {
		findings.push("the anchor transaction has no signing fee payer");
	} else {
		if (row.signer !== transaction.signer) findings.push(`the anchors row names signer ${row.signer}, the chain shows ${transaction.signer}`);
		if (transaction.blockTimeMs === null) {
			unresolved.push("the cluster reported no block time yet, so the signer's validity window cannot be checked");
		} else {
			const accepted = acceptsSigner(deps.signerSet, transaction.signer, transaction.blockTimeMs);
			if (!accepted.ok) findings.push(accepted.reason);
		}
	}

	if (findings.length > 0) return result("mismatch", findings);
	if (unresolved.length > 0) return result("unverified", unresolved);
	return result("anchored", []);
}
