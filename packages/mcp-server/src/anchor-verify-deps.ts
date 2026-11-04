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
 * - `readAnchorRow`: `greptime.anchorForPeriod`, the row the anchor job wrote, then {@link followReanchor}: after a devnet reset the
 *   row still names the old (vanished) signature, and the `anchor.reanchor` event an OPERATOR surface wrote for that hour is a
 *   POINTER to the replacement transaction. A valid event bound to the stored row (same hour, root, count and previous signature)
 *   swaps only the row's `tx_sig` (and the signer, slot and time the chain and the event show); the verifier then reads that
 *   transaction from the chain and applies the same signer-set, memo, root and proof checks as for any row. An event from a
 *   non-operator surface, a malformed one, or one bound to another row is ignored, and an event can never make an hour pass
 *   without its chain transaction verifying. The anchors row itself is never rewritten. The notes are read PER operator surface
 *   (the hour's session is predictable and any caller may write ordinary notes into it, so a limit applied before the author filter
 *   could hide the real note), paged until the newest bound note is found; a read cut by its page cap leaves the hour `unverified`
 *   with a reason of its own (`ReanchorReadIncomplete`). One transaction read per signature is shared by the pointer's signer lookup
 *   and the verification itself, so a failed read is never judged against a stale signer.
 * - `fetchAnchorTransaction`: `Rpc.transactionMemo`, asked at `finalized` and then at `confirmed` (an anchor lands at
 *   `confirmed` first), with the RPC's block time converted from seconds to milliseconds.
 * - `getGenesisHash`: the RPC's.
 * - `signerSet`: the bootstrap set, folded with the `anchor.signer.rotate` events an OPERATOR surface wrote
 *   (`signerSetFromRotationEvents`; the ledger accepts events from any authenticated caller, so an event from a non-operator
 *   surface is ignored). The bootstrap is `SUBSTRATE_ANCHOR_SIGNER_SET` when it is set (it REPLACES the next form: keep the old
 *   key in it with its `valid_until_ms` and rotating the job key by `SOLANA_ANCHOR_PUBKEY` leaves every old anchor verifiable),
 *   else the configured anchor public key alone, valid from the epoch with no end. A malformed `SUBSTRATE_ANCHOR_SIGNER_SET`
 *   answers `unverified` with a fixed reason, never an empty set. The rotation read takes the `note` events of each operator
 *   surface newest first and pages (keyset on `ts`, {@link ROTATION_READ_MAX_PAGES} pages of 500 at most) until the surface is
 *   exhausted, keeping only the `anchor.signer.rotate` ones (the ledger cannot filter on a payload field, so the action is
 *   matched here), so unrelated notes no longer hide a rotation. When the read is still cut by that hard cap, cannot advance, or
 *   fails, the set may be incomplete and a signer is not provably current: an `anchored` verdict, and a `mismatch` that rests on
 *   the signer alone, are reported as `unverified` with reason `rotation-read-incomplete`. A signer whose window closed at or
 *   before the anchored hour started, on a complete read, stays a `mismatch` (a known bad signature, so a rollback refuses) and
 *   gains the reason `signer-retired`; one retired after that
 *   hour is judged by the verifier against the anchor's block time, as before. Every result of a verification that started
 *   carries a small `signer_set` summary (source, size, rotation notes applied, rotation notes ignored and why, the read gap), so
 *   an ignored rotation note is not silent.
 * - `expectedGenesis`: devnet's (`DEVNET_GENESIS_HASH`).
 * - `listGraphPointers` / `confirmPointer`: `readGraphPointers` and `confirmGraphPointer`. A graph's v3 pointers are listed at its index
 *   address (confirmed, paged, within a budget), and each listed pointer is confirmed through its transaction (design 5, steps 2 and 3).
 *
 * Solana unconfigured (no anchor public key, or a refused RPC URL) or no ledger: `anchorVerifyBlocker` answers `unverified` with the reason,
 * decided BEFORE any read, so the checkpoint and event verify make no network call. The graph pointer ports are not behind that gate:
 * `verifyGraph` refuses to read the chain at all when `SOLANA_RPC_URL` was refused by the devnet guard (its verdict is `ok` false with the
 * named reason, and no RPC call is made); otherwise it lists a graph's index address through the configured RPC URL. With no key the confirmed
 * pointers cannot be told apart by payer, so they are judged `unverified`. Nothing here sends a transaction.
 */
import {
	ANCHOR_SIGNER_ROTATE_ACTION,
	parseSignerSet,
	signerSetFromRotationEvents,
	type Rpc,
	type RotationEventInput,
	type SignerSet,
} from "@substrate/ledger";
import { DEVNET_GENESIS_HASH, readGraphPointers } from "./anchor.ts";
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
import { normalizeKey } from "./event.ts";
import { MAX_QUERY_LIMIT, type AnchorRow, type GreptimeClient } from "./greptime.ts";
import { parseReanchorPayload, type ReanchorPayload } from "./reanchor-plan.ts";
import { redact } from "./redact.ts";
import type { SubstrateEvent } from "./types.ts";

/** How far back a checkpoint id is searched on the caller's surface when no session is named. */
export const CKPT_LOOKUP_WINDOW_MS = 7 * 24 * 3_600_000;
/** Rows one bounded lookup reads: the ledger's own per-read cap. */
export const LOOKUP_ROW_LIMIT = MAX_QUERY_LIMIT;
/** Rotation read: pages of {@link LOOKUP_ROW_LIMIT} notes one operator surface may take before the read is called incomplete. */
export const ROTATION_READ_MAX_PAGES = 50;
/** Operator surfaces whose rotation events are read. */
export const MAX_OPERATOR_SURFACES = 8;

const CKPT_ID = /^ckpt_[0-9a-z]{26}$/;
const SIGNATURE_LEVELS = ["finalized", "confirmed"] as const;

/** The ledger reads verification uses. `GreptimeClient` satisfies it; a test passes a fake. */
export type AnchorLedger = Pick<GreptimeClient, "queryEvents" | "eventsByIds" | "cursorPosition" | "hourLeaves" | "anchorForPeriod">;

/** One entry of a graph's index listing: the signature and the memo text the listing hints. The hint is confirmed before it counts. */
export interface PointerEntry {
	signature: string;
	memo: string | null;
}

/** A graph's index listing. `complete` is false when the page cap or the budget stopped it before the listing ended. */
export interface PointerListing {
	entries: PointerEntry[];
	complete: boolean;
}

/** One pointer transaction's fields, as the verifier reads a transaction (`confirmGraphPointer`). */
export interface PointerConfirmation {
	signature: string;
	memo: string;
	payer: string;
	payerSigned: boolean;
	err: unknown;
	slot: number;
	/** Block time in seconds, as the RPC reports it; null when the node has none. The signer is judged at this time. */
	blockTime: number | null;
}

export interface AnchorVerifyPorts {
	/** The event ledger, or null when it is not configured. */
	ledger: AnchorLedger | null;
	/** Rebuild a stored event from a ledger row (`rowToEvent`). */
	rowToEvent: (row: Record<string, unknown>) => SubstrateEvent;
	/** The devnet RPC. Built lazily so an unconfigured or refused setup never constructs one. */
	rpc: () => Rpc;
	/** `config.solana.pubkey` and `config.solana.problem`. */
	solana: {
		pubkey: string | null;
		problem: string | null;
		/** `config.solana.signerSet`: the parsed `SUBSTRATE_ANCHOR_SIGNER_SET`, or null/absent when it is unset. */
		signerSet?: SignerSet | null;
		/** `config.solana.signerSetProblem`: set when `SUBSTRATE_ANCHOR_SIGNER_SET` is malformed. The value is never carried. */
		signerSetProblem?: string | null;
	};
	/** Surfaces whose rotation events count (`operatorSurfaces(config)`). */
	operatorSurfaces: ReadonlySet<string>;
	/** Epoch milliseconds. */
	nowMs: () => number;
	/** One graph's v3 pointers, listed at its index address within `budgetMs` (`readGraphPointers`; design 5, step 2). */
	listGraphPointers: (graphId: string, opts: { budgetMs: number }) => Promise<PointerListing>;
	/** One pointer transaction's fields, or null when the node cannot answer (`confirmGraphPointer`; design 5, step 3). */
	confirmPointer: (signature: string) => Promise<PointerConfirmation | null>;
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

/** Rotation notes the summary names when they were ignored; the rest are counted by the size of the set alone. */
export const MAX_REPORTED_ROTATION_ISSUES = 10;

/** What a verification says about the signer set it judged against. Small by construction; public keys and ids only. */
export interface SignerSetSummary {
	/** `env`: `SUBSTRATE_ANCHOR_SIGNER_SET` was the bootstrap. `pubkey`: `SOLANA_ANCHOR_PUBKEY` alone was. */
	source: "env" | "pubkey";
	/** Entries in the effective set (bootstrap plus applied rotations). */
	entries: number;
	rotation_notes_applied: number;
	/** Rotation notes that were ignored, with the rule that ignored them (at most {@link MAX_REPORTED_ROTATION_ISSUES}). */
	rotation_issues: Array<{ event_id: string; reason: string }>;
	/** Why the rotation read may be incomplete (the page cap, no progress, or a failed read), or null. */
	read_gap: string | null;
}

export type CheckpointVerifyToolResult = (CheckpointVerifyResult | UnverifiedResult) & { signer_set_complete?: false; signer_set?: SignerSetSummary };
export type EventAnchorToolResult = (EventAnchorResult | UnverifiedResult) & { signer_set_complete?: false; signer_set?: SignerSetSummary };

interface Prepared {
	deps: CheckpointVerifyDeps;
	/** Why the signer set may be incomplete, or null. */
	gap: string | null;
	summary: SignerSetSummary;
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
	// Fixed text, like the refused RPC URL: a tool reply goes to any caller and the malformed value never leaves the config.
	if ((ports.solana.signerSetProblem ?? null) !== null) return "Solana is not usable: SUBSTRATE_ANCHOR_SIGNER_SET is malformed (the server's boot warnings say why)";
	// A configured signer set replaces the public key as the bootstrap, so the key is only required when there is no set.
	if (ports.solana.pubkey === null && (ports.solana.signerSet ?? null) === null) return "Solana is not configured (SOLANA_ANCHOR_PUBKEY is unset), so no anchor can be checked against devnet";
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
			? { kind: "note", session_id: normalizeKey(lookup.sessionId) ?? lookup.sessionId }
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

/** The signer set, why it may be incomplete, and the summary a result carries. Never throws for a failed read: a failed rotation read leaves the bootstrap set and a gap. */
async function readSignerSet(ports: AnchorVerifyPorts, ledger: AnchorLedger): Promise<{ set: SignerSet; gap: string | null; summary: SignerSetSummary }> {
	const configured = ports.solana.signerSet ?? null;
	// Throws when the configured anchor key is not a public key: `prepare` answers that as an unverified reason.
	const bootstrap = configured !== null ? parseSignerSet(configured) : parseSignerSet([{ pubkey: ports.solana.pubkey as string, valid_from_ms: 0, valid_until_ms: null }]);
	const source = configured !== null ? "env" : "pubkey";
	const allSurfaces = [...ports.operatorSurfaces].sort();
	const surfaces = allSurfaces.slice(0, MAX_OPERATOR_SURFACES);
	if (surfaces.length === 0) return { set: bootstrap, gap: null, summary: { source, entries: bootstrap.length, rotation_notes_applied: 0, rotation_issues: [], read_gap: null } };
	const events: RotationEventInput[] = [];
	const seen = new Set<string>();
	// Surfaces past the cap are never read, so a retirement on one of them could not be applied: say so rather than report a complete read.
	let gap: string | null =
		allSurfaces.length > surfaces.length
			? `${allSurfaces.length - surfaces.length} of ${allSurfaces.length} operator surfaces were not read (the cap is ${MAX_OPERATOR_SURFACES}: ${allSurfaces.slice(MAX_OPERATOR_SURFACES).join(", ")}), so a retirement on one of them may be missing`
			: null;
	for (const surface of surfaces) {
		let until: string | undefined;
		for (let page = 0; ; page++) {
			if (page >= ROTATION_READ_MAX_PAGES) {
				gap = `the signer rotation read of ${surface} hit its ${ROTATION_READ_MAX_PAGES}-page limit (${ROTATION_READ_MAX_PAGES * LOOKUP_ROW_LIMIT} notes), so an older rotation may be missing`;
				break;
			}
			let rows: Array<Record<string, unknown>>;
			try {
				rows = await ledger.queryEvents({ match: { kind: "note", surface }, limit: LOOKUP_ROW_LIMIT, order: "desc", includePayload: true, ...(until !== undefined ? { until } : {}) });
			} catch (cause) {
				gap = `the signer rotation events of ${surface} could not be read: ${describe(cause)}`;
				break;
			}
			let fresh = 0;
			let oldest: string | undefined;
			for (const row of rows) {
				const event = eventOf(ports, row);
				oldest = event.ts;
				if (seen.has(event.id)) continue;
				seen.add(event.id);
				fresh++;
				if (event.payload["action"] !== ANCHOR_SIGNER_ROTATE_ACTION) continue;
				events.push({ event_id: event.id, ts_ms: Date.parse(event.ts), surface: event.surface, payload: event.payload });
			}
			if (rows.length < LOOKUP_ROW_LIMIT) break;
			if (fresh === 0 || oldest === undefined) {
				gap = `the signer rotation read of ${surface} could not advance past one instant (${LOOKUP_ROW_LIMIT} or more notes share it), so an older rotation may be missing`;
				break;
			}
			until = oldest;
		}
	}
	const derived = signerSetFromRotationEvents(bootstrap, events, {
		// Rotation events are honoured only from an operator surface. The event carries no proof of who wrote it, so the surface is
		// only as good as the door that wrote it: `events_emit` and `POST /events` refuse `anchor.signer.rotate` from any caller that is
		// not an operator writing as its own surface (`reserved-actions.ts`). This check is the second line behind that door, not the first.
		authorize: (event) => event.surface !== undefined && ports.operatorSurfaces.has(event.surface),
	});
	const summary: SignerSetSummary = {
		source,
		entries: derived.set.length,
		rotation_notes_applied: derived.applied.length,
		rotation_issues: derived.issues.slice(0, MAX_REPORTED_ROTATION_ISSUES).map(({ event_id, reason }) => ({ event_id, reason })),
		read_gap: gap,
	};
	return { set: derived.set, gap, summary };
}

/**
 * The effective signer set for callers outside the verifier (the re-anchor executor, `substrate verify`): the same read the
 * verifier makes (`readSignerSet`), with the ledger taken from the ports exactly as `prepare` takes it. `gap` says the rotation
 * read may be incomplete. Throws when the ledger is not configured, the configured key is not a public key, or the fold refuses.
 */
export async function resolveSignerSet(ports: AnchorVerifyPorts): Promise<{ set: SignerSet; gap: string | null }> {
	if (ports.ledger === null) throw new Error("the event ledger is not configured (GREPTIME_URL), so the signer set cannot be read");
	// A malformed SUBSTRATE_ANCHOR_SIGNER_SET leaves the set null: reading on would silently fall back to the public key alone.
	if ((ports.solana.signerSetProblem ?? null) !== null) throw new Error("SUBSTRATE_ANCHOR_SIGNER_SET is malformed (the server's boot warnings say why)");
	const { set, gap } = await readSignerSet(ports, ports.ledger);
	return { set, gap };
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

/**
 * The two pointer ports over the devnet RPC, for `AnchorVerifyPorts`. `rpc` is read lazily, as `ports.rpc` is; the listing budget runs
 * on `nowMs`.
 */
export function graphPointerPorts(rpc: () => Rpc, nowMs: () => number): Pick<AnchorVerifyPorts, "listGraphPointers" | "confirmPointer"> {
	return {
		listGraphPointers: (graphId, opts) => readGraphPointers(rpc(), graphId, { budgetMs: opts.budgetMs, nowMs }),
		confirmPointer: (signature) => confirmGraphPointer(rpc(), signature),
	};
}

/**
 * One pointer transaction's fields, read as the hour transaction is (finalized, then confirmed). Null when the node does not know the
 * signature, or the transaction carries no memo or no payer: the verifier then cannot confirm the pointer, which fails closed.
 */
export async function confirmGraphPointer(rpc: Rpc, signature: string): Promise<PointerConfirmation | null> {
	const found = await fetchTransaction(rpc, signature);
	if (found === null || found.memo === null || found.signer === null) return null;
	return { signature, memo: found.memo, payer: found.signer, payerSigned: found.signerSigned, err: found.err, slot: found.slot ?? 0, blockTime: found.blockTimeMs === null ? null : found.blockTimeMs / 1000 };
}

/**
 * The session the `anchor.reanchor` event of an hour is written in: the anchor job's own per-hour session
 * (`anchor:<YYYY-MM-DDTHH>`), so the verifier reads one small session instead of paging a surface's notes.
 */
export function reanchorSessionId(periodStartIso: string): string {
	return `anchor:${periodStartIso.slice(0, 13)}`;
}

/** One `anchor.reanchor` note the verifier accepts as a candidate pointer. */
export interface ReanchorRecord {
	event_id: string;
	/** ISO time the note was written. */
	ts: string;
	surface: string;
	payload: ReanchorPayload;
}

/** Pages of {@link LOOKUP_ROW_LIMIT} notes one operator surface may take in one hour's session before the re-anchor read is called incomplete. */
export const REANCHOR_READ_MAX_PAGES = 20;

/**
 * The re-anchor notes of an hour could not all be read (a page limit, a read that cannot advance), so a newer pointer than the one
 * found, or the only one, may be missing. The verifier reports the hour `unverified` with this message and never reads through the old row.
 */
export class ReanchorReadIncomplete extends Error {
	override name = "ReanchorReadIncomplete";
}

/** What a note must be bound to: the stored row's root, event count and signature (the note's `previous_tx_sig`). */
export type ReanchorBinding = Pick<AnchorRow, "root" | "event_count" | "tx_sig">;

/** Whether `record` is bound to `binding`: same root, same event count, and `previous_tx_sig` equal to the row's signature. */
export function isBoundNote(record: ReanchorRecord, binding: ReanchorBinding): boolean {
	return record.payload.root === binding.root && record.payload.event_count === binding.event_count && record.payload.previous_tx_sig === binding.tx_sig;
}

/**
 * The one pointer that counts for an hour: the first record of the newest-first `records` that is bound to `binding`, or null. The
 * verifier ({@link followReanchor}) and the re-anchor executor (`reanchor.ts`) both choose their note through this, so an older bound
 * note is never a fallback for a newer one in either place.
 */
export function newestBoundNote(records: readonly ReanchorRecord[], binding: ReanchorBinding): ReanchorRecord | null {
	return records.find((record) => isBoundNote(record, binding)) ?? null;
}

/** The valid `anchor.reanchor` notes of one hour written by an operator surface, newest first, and why the read may be incomplete. */
export interface ReanchorNotes {
	records: ReanchorRecord[];
	/** Null when every trusted note of the hour's session was read (or the newest bound one was found on each surface); otherwise the reason. */
	incomplete: string | null;
}

function noteRecord(ports: Pick<AnchorVerifyPorts, "rowToEvent" | "operatorSurfaces">, row: Record<string, unknown>, periodStart: string): { event: SubstrateEvent; record: ReanchorRecord | null } {
	const event = ports.rowToEvent(row);
	if (event.kind !== "note" || !ports.operatorSurfaces.has(event.surface)) return { event, record: null };
	let payload: ReanchorPayload;
	try {
		payload = parseReanchorPayload(event.payload, { stored: true });
	} catch {
		return { event, record: null };
	}
	if (payload.period_start !== periodStart) return { event, record: null };
	return { event, record: { event_id: event.id, ts: event.ts, surface: event.surface, payload } };
}

/**
 * The valid `anchor.reanchor` notes of one hour written by an OPERATOR surface, newest first. The ledger accepts events from any
 * authenticated caller, so a note from another surface, a malformed one, or one naming another hour is ignored; `events_emit`
 * additionally refuses the action from a non-operator (`reserved-actions.ts`).
 *
 * Read per trusted surface: the session of an hour (`anchor:<hour>`) is predictable and any caller may write ordinary notes into it,
 * so a row limit applied before the author filter could be filled with other callers' notes and push the real one out of the window.
 * Each operator surface is read newest first in pages of {@link LOOKUP_ROW_LIMIT} (keyset on `ts`) until its newest note bound to
 * `binding` is found (when given) or its notes are exhausted, at most {@link REANCHOR_READ_MAX_PAGES} pages; a surface that is cut by
 * that limit, or cannot advance, makes the result `incomplete` rather than silently shorter. Throws when the ledger read fails: the
 * caller decides what an unreadable ledger means.
 */
export async function readReanchorNotes(ports: Pick<AnchorVerifyPorts, "ledger" | "rowToEvent" | "operatorSurfaces">, periodStartMs: number, binding?: ReanchorBinding): Promise<ReanchorNotes> {
	if (ports.ledger === null || ports.operatorSurfaces.size === 0) return { records: [], incomplete: null };
	const periodStart = new Date(periodStartMs).toISOString();
	const session = reanchorSessionId(periodStart);
	const records: ReanchorRecord[] = [];
	const gaps: string[] = [];
	const seen = new Set<string>();
	for (const surface of [...ports.operatorSurfaces].sort()) {
		let until: string | undefined;
		for (let page = 1; ; page++) {
			const rows = await ports.ledger.queryEvents({
				match: { kind: "note", session_id: session, surface },
				limit: LOOKUP_ROW_LIMIT,
				order: "desc",
				includePayload: true,
				...(until !== undefined ? { until } : {}),
			});
			let fresh = 0;
			let oldest: string | undefined;
			let found = false;
			for (const row of rows) {
				const { event, record } = noteRecord(ports, row, periodStart);
				oldest = event.ts;
				if (seen.has(event.id)) continue;
				seen.add(event.id);
				fresh++;
				if (record === null) continue;
				records.push(record);
				if (binding !== undefined && isBoundNote(record, binding)) found = true;
			}
			if (found || rows.length < LOOKUP_ROW_LIMIT) break;
			if (fresh === 0 || oldest === undefined) {
				gaps.push(`the notes of ${surface} in ${session} could not be read past one instant (${LOOKUP_ROW_LIMIT} or more notes share it)`);
				break;
			}
			if (page >= REANCHOR_READ_MAX_PAGES) {
				gaps.push(`the notes of ${surface} in ${session} hit the ${REANCHOR_READ_MAX_PAGES}-page limit (${REANCHOR_READ_MAX_PAGES * LOOKUP_ROW_LIMIT} notes) before the newest re-anchor note was found`);
				break;
			}
			until = oldest;
		}
	}
	records.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
	return { records, incomplete: gaps.length === 0 ? null : gaps.join("; ") };
}

/**
 * The row verification should judge: the stored row, or, when a valid operator `anchor.reanchor` note for the hour is bound to it
 * (same root, same event count, and `previous_tx_sig` equal to the row's signature), the same row pointing at the note's
 * replacement transaction. The newest bound note wins; an older one is never a fallback, so a newer note naming a transaction that does
 * not verify leaves the hour unverified or mismatched rather than passing through an older pointer. A ledger read that fails keeps the
 * stored row; a read that is incomplete ({@link ReanchorNotes.incomplete}) throws {@link ReanchorReadIncomplete}, because the stored row
 * would then be judged although a newer pointer may exist. `fetchTx` reads the replacement's signer and slot (the event carries neither)
 * from the chain; without it, or when it fails, the stored row's own signer stays. The verifier must then judge the SAME read: the caller
 * shares one transaction read between this call and the verification (`prepare`), so a failed read is a failed read for both and the
 * stale signer is never compared with a later, successful one.
 */
export async function followReanchor(
	ports: Pick<AnchorVerifyPorts, "ledger" | "rowToEvent" | "operatorSurfaces">,
	periodStartMs: number,
	row: AnchorRow,
	fetchTx?: (signature: string) => Promise<AnchorTransactionRead | null>,
): Promise<AnchorRow> {
	let notes: ReanchorNotes;
	try {
		notes = await readReanchorNotes(ports, periodStartMs, row);
	} catch {
		return row;
	}
	if (notes.incomplete !== null) throw new ReanchorReadIncomplete(`the anchor.reanchor notes of this hour could not be read completely: ${notes.incomplete}`);
	const pointer = newestBoundNote(notes.records, row);
	if (pointer === null) return row;
	let read: AnchorTransactionRead | null = null;
	if (fetchTx !== undefined) {
		try {
			read = await fetchTx(pointer.payload.new_tx_sig);
		} catch {
			read = null;
		}
	}
	return { ...row, tx_sig: pointer.payload.new_tx_sig, signer: read?.signer ?? row.signer, slot: read?.slot ?? row.slot, anchored_at: pointer.ts };
}

async function prepare(ports: AnchorVerifyPorts, lookup: CheckpointLookup): Promise<Prepared | string> {
	const blocker = anchorVerifyBlocker(ports);
	if (blocker !== null) return blocker;
	const ledger = ports.ledger as AnchorLedger;
	let signers: { set: SignerSet; gap: string | null; summary: SignerSetSummary };
	try {
		signers = await readSignerSet(ports, ledger);
	} catch (cause) {
		// The configured key is not a valid public key, or the rotation fold refused: nothing can be checked against a signer set.
		return `the signer set could not be built: ${describe(cause)}`;
	}
	// One read per signature for the whole verification: the replacement's signer is taken from the same read the verifier then judges, so a
	// failed first read stays a failed read (unverified) and is never paired with the stored row's signer on a second, successful one.
	const transactionReads = new Map<string, Promise<AnchorTransactionRead | null>>();
	const readTransaction = (signature: string): Promise<AnchorTransactionRead | null> => {
		const shared = transactionReads.get(signature);
		if (shared !== undefined) return shared;
		const started = fetchTransaction(ports.rpc(), signature);
		transactionReads.set(signature, started);
		return started;
	};
	const deps: CheckpointVerifyDeps = {
		findEvent: (ref) => (CKPT_ID.test(ref) ? findCheckpoint(ports, ledger, ref, lookup) : findById(ports, ledger, ref)),
		listHourLeaves: async (hourStartMs, maxLeaves) => (await ledger.hourLeaves(hourStartMs)).slice(0, maxLeaves + 1).map(({ event_id, hash }) => ({ event_id, hash })),
		readAnchorRow: async (hourStartMs) => {
			const row = await ledger.anchorForPeriod(hourStartMs);
			return row === null ? null : followReanchor(ports, hourStartMs, row, readTransaction);
		},
		fetchAnchorTransaction: readTransaction,
		getGenesisHash: () => ports.rpc().getGenesisHash(),
		signerSet: signers.set,
		nowMs: ports.nowMs(),
		config: { expectedGenesis: DEVNET_GENESIS_HASH, anchorLagMs: DEFAULT_ANCHOR_LAG_MS, maxLeaves: DEFAULT_MAX_LEAVES },
	};
	return { deps, gap: signers.gap, summary: signers.summary };
}

/**
 * Settles what the signer set may or may not say about a verdict.
 *
 * - The rotation read is incomplete (`gap`): a signer is not provably current, since a missing note may have retired it. An
 *   `anchored` verdict is `unverified` with reason `rotation-read-incomplete` (never `anchored`), and so is a `mismatch` that
 *   the same evidence would not have if the observed signer were in the set: a missing rotation looks exactly like a forged
 *   signer, so only the signer is in doubt. Any other disagreement (the root, the proof, the count, the memo) stays a `mismatch`.
 * - The read is complete and the signer's window closed at or before the anchored hour started: a `mismatch` that only the
 *   signer explains stays a `mismatch` and gains the reason `signer-retired`. It is a KNOWN mismatch, never `unverified`:
 *   `unverified` lets a rollback proceed, and a complete read leaves nothing unknown. A signer retired after that hour keeps the verifier's own
 *   verdict, which judges it against the anchor's block time.
 *
 * `again` re-runs the verification with the extra signer and answers its status.
 */
async function settleSignerGap<R extends { status: string; evidence: CheckpointEvidence; reasons: string[]; hour_start: string | null }>(
	result: R,
	gap: string | null,
	summary: SignerSetSummary,
	signerSet: SignerSet,
	again: (extraSigner: string) => Promise<string>,
): Promise<R & { signer_set_complete?: false; signer_set: SignerSetSummary }> {
	const reported = { ...result, signer_set: summary };
	const signer = result.evidence.signer;
	if (gap !== null) {
		const flagged = { ...reported, signer_set_complete: false as const };
		const incomplete = { ...flagged, status: "unverified", reasons: [...result.reasons, `rotation-read-incomplete: ${gap}`] };
		if (result.status === "anchored") return incomplete;
		if (result.status !== "mismatch" || signer === null) return flagged;
		return (await again(signer)) === "anchored" ? incomplete : flagged;
	}
	if (result.status !== "mismatch" || signer === null || result.hour_start === null) return reported;
	const hourStartMs = Date.parse(result.hour_start);
	const retired = signerSet.find((entry) => entry.pubkey === signer && entry.valid_until_ms !== null && entry.valid_until_ms <= hourStartMs);
	if (retired === undefined || (await again(signer)) !== "anchored") return reported;
	return { ...reported, reasons: [...result.reasons, `signer-retired: ${signer} was retired at ${new Date(retired.valid_until_ms as number).toISOString()}, at or before the anchored hour ${result.hour_start}`] };
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
	return settleSignerGap(result, prepared.gap, prepared.summary, prepared.deps.signerSet, async (signer) => (await verifyCheckpoint(withSigner(prepared.deps, signer), ref)).status);
}

/** Verify that one ledger event, by event id, sits in an anchored root. Same errors and statuses as `verifyCheckpointRef`. */
export async function verifyEventRef(ports: AnchorVerifyPorts, eventId: string): Promise<EventAnchorToolResult> {
	const prepared = await prepare(ports, {});
	if (typeof prepared === "string") return { status: "unverified", ref: eventId, reasons: [prepared] };
	const result = await verifyEventAnchor(prepared.deps, eventId);
	return settleSignerGap(result, prepared.gap, prepared.summary, prepared.deps.signerSet, async (signer) => (await verifyEventAnchor(withSigner(prepared.deps, signer), eventId)).status);
}

/**
 * The `anchorEvidence` reader `verifyMemoryRecord` takes, over `verifyEventRef`. The proof reference is the anchor
 * transaction's signature, which anyone can look up on devnet. An event the ledger does not hold is `unanchored` (no root
 * will ever cover it); a malformed id, a reader that failed or a misconfiguration is `unverified`.
 */
export async function anchorEvidenceFor(
	ports: AnchorVerifyPorts,
	eventId: string,
	/** Told the signer set summary of the verification, when one ran (the memory verifier attaches it to its own result). */
	observe?: (summary: SignerSetSummary) => void,
): Promise<{ status: "anchored" | "pending" | "unanchored" | "unverified" | "mismatch"; proof_ref: string | null; detail?: string }> {
	try {
		const result = await verifyEventRef(ports, eventId);
		if (result.signer_set !== undefined) observe?.(result.signer_set);
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
