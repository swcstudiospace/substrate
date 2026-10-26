/**
 * The service half of anchor verification (v1.6, phases 59 and 60): builds `CheckpointVerifyDeps` from the ledger client
 * and the devnet RPC, so `service.ts` only hands in its ports and `checkpoint-verify.ts` stays pure.
 *
 * What each dependency reads:
 *
 * - `findEvent`: an event id reads that event (`eventsByIds`, payload included) and the time of its first ingest record
 *   (`cursorPosition`), which decides its hour. A checkpoint id has NO by-payload read in the ledger, so it is found by a
 *   BOUNDED search: the newest 500 `note` events of the caller's session when one is given, otherwise of the caller's
 *   surface within the last seven days, the one whose payload names the checkpoint. A checkpoint older than that, or from
 *   another surface, is not found by id: pass its event id or its session id.
 * - `listHourLeaves`: `greptime.hourLeaves`, cut at `maxLeaves + 1` (the verifier needs no more to call an hour too big).
 * - `readAnchorRow`: `greptime.anchorForPeriod`, the row the anchor job wrote.
 * - `fetchAnchorTransaction`: `Rpc.transactionMemo`, asked at `finalized` and then at `confirmed` (an anchor lands at
 *   `confirmed` first), with the RPC's block time converted from seconds to milliseconds.
 * - `getGenesisHash`: the RPC's.
 * - `signerSet`: the bootstrap set (the configured anchor public key, valid from the epoch with no end) folded with the
 *   `anchor.signer.rotate` events an OPERATOR surface wrote (`signerSetFromRotationEvents`; the ledger accepts events from
 *   any authenticated caller, so an event from a non-operator surface is ignored). The rotation read is the newest 500
 *   notes of each operator surface; when a surface returns a full page, or the read fails, the set may be incomplete, and
 *   a `mismatch` that rests on the signer alone is reported as `unverified` with that reason instead.
 * - `expectedGenesis`: devnet's (`DEVNET_GENESIS_HASH`).
 *
 * Solana unconfigured (no anchor public key, or a refused RPC URL) or no ledger: the answer is `unverified` with the reason,
 * decided BEFORE any read, so no network call is made. Nothing here sends a transaction.
 */
import {
	ANCHOR_SIGNER_ROTATE_ACTION,
	parseSignerSet,
	signerSetFromRotationEvents,
	type Rpc,
	type RotationEventInput,
	type SignerSet,
} from "@substrate/ledger";
import { DEVNET_GENESIS_HASH } from "./anchor.ts";
import {
	CheckpointVerifyError,
	DEFAULT_ANCHOR_LAG_MS,
	DEFAULT_MAX_LEAVES,
	verifyCheckpoint,
	verifyEventAnchor,
	type AnchorTransactionRead,
	type CheckpointEvidence,
	type CheckpointEventRecord,
	type CheckpointVerifyDeps,
	type CheckpointVerifyResult,
	type EventAnchorResult,
} from "./checkpoint-verify.ts";
import { MAX_QUERY_LIMIT, type GreptimeClient } from "./greptime.ts";
import { redact } from "./redact.ts";
import type { SubstrateEvent } from "./types.ts";

/** How far back a checkpoint id is searched on the caller's surface when no session is named. */
export const CKPT_LOOKUP_WINDOW_MS = 7 * 24 * 3_600_000;
/** Rows one bounded lookup reads: the ledger's own per-read cap. */
export const LOOKUP_ROW_LIMIT = MAX_QUERY_LIMIT;
/** Operator surfaces whose rotation events are read. */
export const MAX_OPERATOR_SURFACES = 8;

const CKPT_ID = /^ckpt_[0-9a-z]{26}$/;
const SIGNATURE_LEVELS = ["finalized", "confirmed"] as const;

/** The ledger reads verification uses. `GreptimeClient` satisfies it; a test passes a fake. */
export type AnchorLedger = Pick<GreptimeClient, "queryEvents" | "eventsByIds" | "cursorPosition" | "hourLeaves" | "anchorForPeriod">;

export interface AnchorVerifyPorts {
	/** The event ledger, or null when it is not configured. */
	ledger: AnchorLedger | null;
	/** Rebuild a stored event from a ledger row (`rowToEvent`). */
	rowToEvent: (row: Record<string, unknown>) => SubstrateEvent;
	/** The devnet RPC. Built lazily so an unconfigured or refused setup never constructs one. */
	rpc: () => Rpc;
	/** `config.solana.pubkey` and `config.solana.problem`. */
	solana: { pubkey: string | null; problem: string | null };
	/** Surfaces whose rotation events count (`operatorSurfaces(config)`). */
	operatorSurfaces: ReadonlySet<string>;
	/** Epoch milliseconds. */
	nowMs: () => number;
}

/** Where a checkpoint id is searched: the caller's session, else the caller's surface. */
export interface CheckpointLookup {
	sessionId?: string;
	surface?: string;
}

/** The answer when verification could not even start. A status, never an error. */
export interface UnverifiedResult {
	status: "unverified";
	ref: string;
	reasons: string[];
}

export type CheckpointVerifyToolResult = (CheckpointVerifyResult | UnverifiedResult) & { signer_set_complete?: false };
export type EventAnchorToolResult = (EventAnchorResult | UnverifiedResult) & { signer_set_complete?: false };

interface Prepared {
	deps: CheckpointVerifyDeps;
	/** Why the signer set may be incomplete, or null. */
	gap: string | null;
}

function describe(cause: unknown): string {
	return redact(cause instanceof Error ? cause.message : String(cause)).slice(0, 300);
}

/** The reason verification cannot start, or null when it can. Decided from config and ports alone: no read, no network. */
export function anchorVerifyBlocker(ports: Pick<AnchorVerifyPorts, "ledger" | "solana">): string | null {
	if (ports.ledger === null) return "the event ledger is not configured (GREPTIME_URL), so there is nothing to verify against";
	// The config problem is written for the operator's boot log: the guard names the refused host there. A tool reply goes to any
	// caller and a private RPC host must not reach one, so the reply carries a fixed reason and the detail stays in the boot warnings.
	if (ports.solana.problem !== null) return "Solana is not usable: SOLANA_RPC_URL refused by the devnet-only guard (the server's boot warnings say why)";
	if (ports.solana.pubkey === null) return "Solana is not configured (SOLANA_ANCHOR_PUBKEY is unset), so no anchor can be checked against devnet";
	return null;
}

function eventOf(ports: AnchorVerifyPorts, row: Record<string, unknown>): SubstrateEvent {
	return ports.rowToEvent(row);
}

async function findById(ports: AnchorVerifyPorts, ledger: AnchorLedger, id: string): Promise<CheckpointEventRecord | null> {
	const rows = await ledger.eventsByIds([id], true);
	const row = rows.find((candidate) => String(candidate.id) === id);
	if (row === undefined) return null;
	const position = await ledger.cursorPosition(id);
	return { event: eventOf(ports, row), ingested_at_ms: position === null ? null : position.ingestedAt };
}

async function findCheckpoint(ports: AnchorVerifyPorts, ledger: AnchorLedger, ckptId: string, lookup: CheckpointLookup): Promise<CheckpointEventRecord | null> {
	const match =
		lookup.sessionId !== undefined
			? { kind: "note", session_id: lookup.sessionId }
			: lookup.surface !== undefined
				? { kind: "note", surface: lookup.surface }
				: null;
	if (match === null) return null;
	const rows = await ledger.queryEvents({
		match,
		...(lookup.sessionId === undefined ? { since: new Date(ports.nowMs() - CKPT_LOOKUP_WINDOW_MS).toISOString() } : {}),
		limit: LOOKUP_ROW_LIMIT,
		order: "desc",
		includePayload: true,
	});
	for (const row of rows) {
		const event = eventOf(ports, row);
		if (event.payload["ckpt_id"] !== ckptId) continue;
		const position = await ledger.cursorPosition(event.id);
		return { event, ingested_at_ms: position === null ? null : position.ingestedAt };
	}
	return null;
}

/** The signer set and why it may be incomplete. Never throws: a failed rotation read leaves the bootstrap set and a gap. */
async function readSignerSet(ports: AnchorVerifyPorts, ledger: AnchorLedger, pubkey: string): Promise<{ set: SignerSet; gap: string | null }> {
	const bootstrap = parseSignerSet([{ pubkey, valid_from_ms: 0, valid_until_ms: null }]);
	const surfaces = [...ports.operatorSurfaces].sort().slice(0, MAX_OPERATOR_SURFACES);
	if (surfaces.length === 0) return { set: bootstrap, gap: null };
	const events: RotationEventInput[] = [];
	let gap: string | null = null;
	for (const surface of surfaces) {
		let rows: Array<Record<string, unknown>>;
		try {
			rows = await ledger.queryEvents({ match: { kind: "note", surface }, limit: LOOKUP_ROW_LIMIT, order: "desc", includePayload: true });
		} catch (cause) {
			gap = `the signer rotation events of ${surface} could not be read: ${describe(cause)}`;
			continue;
		}
		if (rows.length >= LOOKUP_ROW_LIMIT) {
			gap = `the signer rotation read of ${surface} hit its ${LOOKUP_ROW_LIMIT}-note limit, so an older rotation may be missing`;
		}
		for (const row of rows) {
			const event = eventOf(ports, row);
			if (event.payload["action"] !== ANCHOR_SIGNER_ROTATE_ACTION) continue;
			events.push({ event_id: event.id, ts_ms: Date.parse(event.ts), surface: event.surface, payload: event.payload });
		}
	}
	const derived = signerSetFromRotationEvents(bootstrap, events, {
		// Rotation events are honoured only from an operator surface: the ledger takes events from any authenticated caller.
		authorize: (event) => event.surface !== undefined && ports.operatorSurfaces.has(event.surface),
	});
	return { set: derived.set, gap };
}

/** Level a transaction was found at, asked highest first. A node that does not know the signature at any level answers null. */
async function fetchTransaction(rpc: Rpc, signature: string): Promise<AnchorTransactionRead | null> {
	for (const level of SIGNATURE_LEVELS) {
		const found = await rpc.transactionMemo(signature, level);
		if (found === null) continue;
		return {
			memo: found.memo,
			signer: found.payer,
			signerSigned: found.payerSigned,
			err: found.err,
			slot: found.slot,
			// The RPC reports seconds; the verifier compares milliseconds.
			blockTimeMs: found.blockTime === null ? null : found.blockTime * 1000,
			finality: level,
		};
	}
	return null;
}

async function prepare(ports: AnchorVerifyPorts, lookup: CheckpointLookup): Promise<Prepared | string> {
	const blocker = anchorVerifyBlocker(ports);
	if (blocker !== null) return blocker;
	const ledger = ports.ledger as AnchorLedger;
	const pubkey = ports.solana.pubkey as string;
	let signers: { set: SignerSet; gap: string | null };
	try {
		signers = await readSignerSet(ports, ledger, pubkey);
	} catch (cause) {
		// The configured key is not a valid public key, or the rotation fold refused: nothing can be checked against a signer set.
		return `the signer set could not be built: ${describe(cause)}`;
	}
	const deps: CheckpointVerifyDeps = {
		findEvent: (ref) => (CKPT_ID.test(ref) ? findCheckpoint(ports, ledger, ref, lookup) : findById(ports, ledger, ref)),
		listHourLeaves: async (hourStartMs, maxLeaves) => (await ledger.hourLeaves(hourStartMs)).slice(0, maxLeaves + 1).map(({ event_id, hash }) => ({ event_id, hash })),
		readAnchorRow: (hourStartMs) => ledger.anchorForPeriod(hourStartMs),
		fetchAnchorTransaction: (signature) => fetchTransaction(ports.rpc(), signature),
		getGenesisHash: () => ports.rpc().getGenesisHash(),
		signerSet: signers.set,
		nowMs: ports.nowMs(),
		config: { expectedGenesis: DEVNET_GENESIS_HASH, anchorLagMs: DEFAULT_ANCHOR_LAG_MS, maxLeaves: DEFAULT_MAX_LEAVES },
	};
	return { deps, gap: signers.gap };
}

/**
 * A `mismatch` is `unverified` when the signer set may be incomplete AND the same evidence would verify with the observed
 * signer in the set: a missing rotation looks exactly like a forged signer, so only the signer is in doubt. Any other
 * disagreement (the root, the proof, the count, the memo) stays a `mismatch`. `again` re-runs the verification with the extra
 * signer and answers its status.
 */
async function settleSignerGap<R extends { status: string; evidence: CheckpointEvidence; reasons: string[] }>(
	result: R,
	gap: string | null,
	again: (extraSigner: string) => Promise<string>,
): Promise<R & { signer_set_complete?: false }> {
	if (gap === null) return result;
	const flagged = { ...result, signer_set_complete: false as const };
	const signer = result.evidence.signer;
	if (result.status !== "mismatch" || signer === null) return flagged;
	if ((await again(signer)) !== "anchored") return flagged;
	return { ...flagged, status: "unverified", reasons: [...result.reasons, gap] };
}

/** The deps with one more signer, valid for all time: what the signer set would be if no rotation were missing. */
function withSigner(deps: CheckpointVerifyDeps, pubkey: string): CheckpointVerifyDeps {
	return { ...deps, signerSet: [...deps.signerSet, { pubkey, valid_from_ms: 0, valid_until_ms: null }] };
}

/**
 * Verify one checkpoint (by checkpoint id or event id). Throws `CheckpointVerifyError` for a bad ref, an unknown or foreign
 * event; everything else, including an unconfigured Solana or ledger, is a status.
 */
export async function verifyCheckpointRef(ports: AnchorVerifyPorts, ref: string, lookup: CheckpointLookup = {}): Promise<CheckpointVerifyToolResult> {
	const prepared = await prepare(ports, lookup);
	if (typeof prepared === "string") return { status: "unverified", ref, reasons: [prepared] };
	const result = await verifyCheckpoint(prepared.deps, ref);
	return settleSignerGap(result, prepared.gap, async (signer) => (await verifyCheckpoint(withSigner(prepared.deps, signer), ref)).status);
}

/** Verify that one ledger event, by event id, sits in an anchored root. Same errors and statuses as `verifyCheckpointRef`. */
export async function verifyEventRef(ports: AnchorVerifyPorts, eventId: string): Promise<EventAnchorToolResult> {
	const prepared = await prepare(ports, {});
	if (typeof prepared === "string") return { status: "unverified", ref: eventId, reasons: [prepared] };
	const result = await verifyEventAnchor(prepared.deps, eventId);
	return settleSignerGap(result, prepared.gap, async (signer) => (await verifyEventAnchor(withSigner(prepared.deps, signer), eventId)).status);
}

/**
 * The `anchorEvidence` reader `verifyMemoryRecord` takes, over `verifyEventRef`. The proof reference is the anchor
 * transaction's signature, which anyone can look up on devnet. An event the ledger does not hold is `unanchored` (no root
 * will ever cover it); a malformed id, a reader that failed or a misconfiguration is `unverified`.
 */
export async function anchorEvidenceFor(
	ports: AnchorVerifyPorts,
	eventId: string,
): Promise<{ status: "anchored" | "pending" | "unanchored" | "unverified" | "mismatch"; proof_ref: string | null; detail?: string }> {
	try {
		const result = await verifyEventRef(ports, eventId);
		const detail = result.reasons[0];
		const proof = "evidence" in result ? result.evidence.signature : null;
		return { status: result.status, proof_ref: result.status === "anchored" ? proof : null, ...(detail !== undefined ? { detail } : {}) };
	} catch (cause) {
		if (cause instanceof CheckpointVerifyError) {
			return { status: cause.code === "not-found" ? "unanchored" : "unverified", proof_ref: null, detail: describe(cause) };
		}
		throw cause;
	}
}
