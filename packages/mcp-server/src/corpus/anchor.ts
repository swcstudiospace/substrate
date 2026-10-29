/**
 * What `GET /corpus/anchor?root=HEX64` answers (v1.7 phase 69): is this corpus root inside an hourly Merkle root written to devnet?
 *
 * The corpus root is recorded as a `docs.corpus.root` ledger event (`root.ts`). The ledger cannot filter on a payload field, so
 * the events of the root session are read newest first and matched here. The event is then judged by the verifier a session
 * checkpoint is judged by (`verifyEventRef`: the proof of the event inside its hour, the anchors row, the devnet transaction,
 * the memo and the signer set), so a root and a checkpoint answer with the same closed statuses and the same reasons.
 *
 * - No event carries the root, on a read that reached the start of the root session: `unanchored`. It is an answer, not an error.
 * - No event was found but the read did not reach the start (a page limit, a read that cannot advance, a ledger that failed, no
 *   ledger): `unverified`, never `unanchored`, because absence in a partial read is not absence.
 * - Several events may carry one root (the manifest changed without changing the root, or an event was written again). The newest
 *   {@link MAX_ANCHOR_CANDIDATES} are judged newest first and the first `anchored` one is reported; when none is, the newest
 *   one's verdict is.
 *
 * Nothing here sends a transaction.
 */
import { CORPUS_PROTOCOL, type CorpusAnchorEvidence, type CorpusAnchorResponse, type CorpusAnchorStatus } from "@substrate/corpus";
import { CheckpointVerifyError, type CheckpointEvidence } from "../checkpoint-verify.ts";
import { LOOKUP_ROW_LIMIT, verifyEventRef, type AnchorVerifyPorts, type EventAnchorToolResult } from "../anchor-verify-deps.ts";
import { redact } from "../redact.ts";
import type { SubstrateEvent } from "../types.ts";
import { CORPUS_ROOT_ACTION, CORPUS_ROOT_SESSION } from "./root.ts";

/** Pages of {@link LOOKUP_ROW_LIMIT} root events one lookup reads before it calls the read incomplete. */
export const ANCHOR_LOOKUP_MAX_PAGES = 10;

/** The newest events carrying one root that are judged. */
export const MAX_ANCHOR_CANDIDATES = 5;

const REASON_MAX = 300;

/** The verifier. A parameter so a test can give every classification without a chain. */
export type AnchorVerifier = (ports: AnchorVerifyPorts, eventId: string) => Promise<EventAnchorToolResult>;

interface Candidate {
	eventId: string;
	count: number | null;
	manifestVersion: number | null;
}

function describe(cause: unknown): string {
	const text = redact(cause instanceof Error ? cause.message : String(cause));
	return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX)}...` : text;
}

function integerOf(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** The gap an unreadable row leaves, or null when every row was read. */
function unreadableGap(unreadable: number): string | null {
	return unreadable === 0 ? null : `${unreadable} root event row${unreadable === 1 ? "" : "s"} could not be decoded, so the one asked for may be among them`;
}

/** The newest events whose payload names `root`, and why the read may not have reached the start of the session (null when it did). */
async function findRootEvents(ports: AnchorVerifyPorts, root: string): Promise<{ candidates: Candidate[]; gap: string | null }> {
	const ledger = ports.ledger;
	if (ledger === null) return { candidates: [], gap: "the event ledger is not configured (GREPTIME_URL), so no root event can be read" };
	const candidates: Candidate[] = [];
	const seen = new Set<string>();
	let until: string | undefined;
	let unreadable = 0;
	for (let page = 1; ; page++) {
		let rows: Array<Record<string, unknown>>;
		try {
			rows = await ledger.queryEvents({
				match: { kind: "note", surface: "substrate", session_id: CORPUS_ROOT_SESSION },
				limit: LOOKUP_ROW_LIMIT,
				order: "desc",
				includePayload: true,
				...(until === undefined ? {} : { until }),
			});
		} catch (cause) {
			return { candidates, gap: `the root events could not be read: ${describe(cause)}` };
		}
		let fresh = 0;
		let oldest: string | undefined;
		for (const row of rows) {
			let event: SubstrateEvent;
			try {
				event = ports.rowToEvent(row);
			} catch {
				// One row the ledger returned in an odd shape is skipped, and counted: it could have been the one asked for.
				unreadable += 1;
				continue;
			}
			oldest = event.ts;
			if (seen.has(event.id)) continue;
			seen.add(event.id);
			fresh += 1;
			if (event.payload["action"] !== CORPUS_ROOT_ACTION || event.payload["root"] !== root) continue;
			candidates.push({ eventId: event.id, count: integerOf(event.payload["count"]), manifestVersion: integerOf(event.payload["manifest_version"]) });
			if (candidates.length >= MAX_ANCHOR_CANDIDATES) return { candidates, gap: null };
		}
		if (rows.length < LOOKUP_ROW_LIMIT) return { candidates, gap: unreadableGap(unreadable) };
		if (fresh === 0 || oldest === undefined) return { candidates, gap: `the root events could not be read past one instant (${LOOKUP_ROW_LIMIT} or more share it)` };
		if (page >= ANCHOR_LOOKUP_MAX_PAGES) return { candidates, gap: `the root events hit the ${ANCHOR_LOOKUP_MAX_PAGES}-page limit (${ANCHOR_LOOKUP_MAX_PAGES * LOOKUP_ROW_LIMIT} events)` };
		until = oldest;
	}
}

function evidenceOf(result: EventAnchorToolResult): CorpusAnchorEvidence | null {
	if (!("evidence" in result)) return null;
	const evidence: CheckpointEvidence = result.evidence;
	return {
		anchoredRoot: evidence.anchored_root,
		hourEventCount: evidence.count,
		eventHash: evidence.event_hash,
		leafIndex: evidence.leaf_index,
		hourProof: evidence.proof,
		signature: evidence.signature,
		slot: evidence.slot,
		signer: evidence.signer,
		blockTimeMs: evidence.block_time_ms,
		finality: evidence.finality,
	};
}

function answer(root: string, status: CorpusAnchorStatus, reasons: string[], candidate: Candidate | null, result: EventAnchorToolResult | null): CorpusAnchorResponse {
	return {
		protocol: CORPUS_PROTOCOL,
		root,
		status,
		reasons,
		eventId: candidate?.eventId ?? null,
		count: candidate?.count ?? null,
		manifestVersion: candidate?.manifestVersion ?? null,
		hourStart: result !== null && "hour_start" in result ? result.hour_start : null,
		evidence: result === null ? null : evidenceOf(result),
	};
}

/** Judges one candidate. A caller error of the verifier (a malformed id, an event that vanished) is a status of its own, never a throw. */
async function judge(ports: AnchorVerifyPorts, verify: AnchorVerifier, candidate: Candidate): Promise<EventAnchorToolResult> {
	try {
		return await verify(ports, candidate.eventId);
	} catch (cause) {
		if (cause instanceof CheckpointVerifyError) {
			return { status: cause.code === "not-found" ? "unanchored" : "unverified", ref: candidate.eventId, reasons: [describe(cause)] };
		}
		return { status: "unverified", ref: candidate.eventId, reasons: [`the anchor check failed: ${describe(cause)}`] };
	}
}

/** The anchor status of a corpus root. `root` is already 64 lowercase hex. */
export async function corpusAnchorStatus(ports: AnchorVerifyPorts, root: string, verify: AnchorVerifier = verifyEventRef): Promise<CorpusAnchorResponse> {
	const { candidates, gap } = await findRootEvents(ports, root);
	const newest = candidates[0];
	if (newest === undefined) {
		if (gap !== null) return answer(root, "unverified", [gap], null, null);
		return answer(root, "unanchored", ["no docs.corpus.root event in the ledger carries this root, so no hour was ever anchored over it"], null, null);
	}
	const head = await judge(ports, verify, newest);
	if (head.status === "anchored") return answer(root, head.status, head.reasons, newest, head);
	for (const candidate of candidates.slice(1)) {
		const result = await judge(ports, verify, candidate);
		if (result.status === "anchored") return answer(root, result.status, result.reasons, candidate, result);
	}
	return answer(root, head.status, head.reasons, newest, head);
}
