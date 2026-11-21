/**
 * The provenance of one governed memory entry, as a verified supersession chain (v1.7).
 *
 * `memory_verify` answers for one entry. This module answers for the claim the entry belongs to: it
 * walks `supersedes` backward to the first version and `superseded_by` forward to the latest, and
 * attaches to every hop the same verdict `memory_verify` would give (`verifyMemoryRecord`, with the
 * caller's injected `anchorEvidence` reader), plus which governance rows that hop's content matched,
 * by `entry_hash`: a pending `memory_reviews` row and/or a `memory_quarantine` row.
 *
 * The reply carries ids, hashes and statuses only. Entry text and subjects are never read into the
 * result, and the governance lookups return a row id and nothing else — the store methods named in
 * `MemoryProvenanceDeps` read one id column — so a quarantined body, which still holds whatever got it
 * quarantined, cannot be returned even by a caller holding a review token. That is deliberate: this
 * tool proves which rows a version passed through, not what any of them said.
 *
 * The walk is safe on hostile data, on the same terms as `supersessionChain` in `memory-record.ts`:
 * every id is visited at most once (a cycle ends the walk and is reported, never followed again), each
 * direction is bounded by `MAX_CHAIN_HOPS`, a `forgotten:` marker is a terminal state, and a link the
 * store does not hold is reported in `dangling`. The starting id, when malformed or unknown, is the
 * caller's error (`MemoryVerifyError`, as `memory_verify` throws); a link further along the chain that
 * cannot be read is `dangling`, not a throw, so one missing version does not hide the rest.
 *
 * Pure but for the injected readers; no clock, no environment, no network of its own.
 */
import { isForgottenMarker, MAX_CHAIN_HOPS, toNexusRecord, type ChainBack, type ChainForward } from "./memory-record.ts";
import { MemoryVerifyError, verifyMemoryRecord, type AnchorEvidence, type MemoryVerifyResult } from "./memory-verify.ts";
import type { MemoryEntry } from "./types.ts";

export interface MemoryProvenanceDeps {
	/** The stored entry, or null when the id is unknown (or not readable by the caller). Throws on a store error. */
	getEntry(id: string): Promise<MemoryEntry | null>;
	/** Resolve the anchor state of the ledger event `eventId`. */
	anchorEvidence(eventId: string): Promise<AnchorEvidence>;
	/** The pending review row whose `entry_hash` is this digest, as its id, or null. Id only: never a body. */
	findPendingReviewByHash(entryHash: string): Promise<string | null>;
	/** The quarantine row whose `entry_hash` is this digest, as its id, or null. Id only: never a body. */
	findQuarantineByHash(entryHash: string): Promise<string | null>;
	/** Cap on each hop's anchor lookup. Default `DEFAULT_ANCHOR_TIMEOUT_MS` (in `memory-verify.ts`). */
	anchorTimeoutMs?: number;
	/** The deadline timer. Absent, a real timer is used; tests inject one that resolves at once. */
	sleep?: (ms: number) => Promise<void>;
}

/** One version of the claim, oldest to newest within a result's `chain`. Carries no content. */
export interface ProvenanceHop {
	id: string;
	version: number;
	state: "current" | "superseded" | "forgotten";
	/** The gate's `entry_hash`, verbatim. */
	content_hash: string;
	source_event: string | null;
	/** The full `memory_verify` verdict for this hop: hashes, the anchor, and reasons — never the body. */
	verify: MemoryVerifyResult;
	/** The pending review this content matched, by id, or null. */
	review: { id: string } | null;
	/** The quarantine this content matched, by id, or null. */
	quarantine: { id: string } | null;
}

export interface MemoryProvenanceResult {
	/** The id asked for. */
	id: string;
	/** Oldest to newest, including `id`. Empty only when `id` is unknown, which throws instead. */
	chain: ProvenanceHop[];
	back: ChainBack;
	forward: ChainForward;
	/** Ids a link names that the store does not hold, in the order met. */
	dangling: string[];
	/** The `forgotten:<x>` marker the walk stopped at, or null. */
	forgotten_marker: string | null;
}

function nullable(value: string | undefined | null): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The verified provenance chain around `id`. Throws `MemoryVerifyError` only for a malformed or unknown
 * starting id; every condition further along the chain is reported in the result.
 */
export async function memoryProvenance(deps: MemoryProvenanceDeps, id: string): Promise<MemoryProvenanceResult> {
	if (typeof id !== "string" || id.length === 0 || id.length > 200) {
		throw new MemoryVerifyError("bad_id", "memory id must be a non-empty string of at most 200 characters");
	}
	const start = await deps.getEntry(id);
	if (!start) throw new MemoryVerifyError("not_found", `no memory entry ${id} in the index`);

	const entries = new Map<string, MemoryEntry>([[start.id, start]]);
	const seen = new Set<string>([start.id]);
	const dangling: string[] = [];

	// Backward: `supersedes` to the first version.
	const older: string[] = [];
	let back: ChainBack = "root";
	let cursor = start;
	for (let hops = 0; ; hops++) {
		const prev = nullable(cursor.supersedes);
		if (prev === null) break;
		if (seen.has(prev)) {
			back = "cycle";
			break;
		}
		if (hops >= MAX_CHAIN_HOPS) {
			back = "truncated";
			break;
		}
		const row = await deps.getEntry(prev);
		if (!row) {
			dangling.push(prev);
			back = "missing";
			break;
		}
		seen.add(prev);
		entries.set(prev, row);
		older.push(prev);
		cursor = row;
	}

	// Forward: `superseded_by` to the latest version.
	const newer: string[] = [];
	let forward: ChainForward = "current";
	let marker: string | null = null;
	cursor = start;
	for (let hops = 0; ; hops++) {
		const next = nullable(cursor.superseded_by);
		if (next === null) break;
		if (isForgottenMarker(next)) {
			forward = "forgotten";
			marker = next;
			break;
		}
		if (seen.has(next)) {
			forward = "cycle";
			break;
		}
		if (hops >= MAX_CHAIN_HOPS) {
			forward = "truncated";
			break;
		}
		const row = await deps.getEntry(next);
		if (!row) {
			dangling.push(next);
			forward = "missing";
			break;
		}
		seen.add(next);
		entries.set(next, row);
		newer.push(next);
		cursor = row;
	}

	const chainIds = [...older.reverse(), start.id, ...newer];
	const chain: ProvenanceHop[] = [];
	for (const hopId of chainIds) {
		const entry = entries.get(hopId) as MemoryEntry;
		const nexus = toNexusRecord(entry);
		// The entry was readable when the walk reached it. If it cannot be re-read for the verdict (a
		// race with a forget or a visibility change), the hop is reported `unverified` with the hash
		// already in hand, never dropped and never guessed at.
		let verify: MemoryVerifyResult;
		try {
			verify = await verifyMemoryRecord(
				{
					getEntry: deps.getEntry,
					anchorEvidence: deps.anchorEvidence,
					...(deps.anchorTimeoutMs !== undefined ? { anchorTimeoutMs: deps.anchorTimeoutMs } : {}),
					...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
				},
				hopId,
			);
		} catch (cause) {
			if (!(cause instanceof MemoryVerifyError)) throw cause;
			verify = {
				id: entry.id,
				status: "unverified",
				reasons: ["the entry could not be re-read for verification, so its content hash and anchor were not checked"],
				content_hash: entry.entry_hash,
				hash_version: null,
				content_checked: false,
				source_event: nexus.provenance.source_event,
				anchor: null,
			};
		}
		// Governance rows are matched on the content hash, and only their ids come back. A store error
		// here propagates: a provenance answer that silently hides a quarantine would be worse than none.
		const [reviewId, quarantineId] =
			entry.entry_hash.length > 0
				? await Promise.all([deps.findPendingReviewByHash(entry.entry_hash), deps.findQuarantineByHash(entry.entry_hash)])
				: [null, null];
		chain.push({
			id: entry.id,
			version: entry.version,
			state: nexus.state,
			content_hash: entry.entry_hash,
			source_event: nexus.provenance.source_event,
			verify,
			review: reviewId === null ? null : { id: reviewId },
			quarantine: quarantineId === null ? null : { id: quarantineId },
		});
	}

	return { id: start.id, chain, back, forward, dangling, forgotten_marker: marker };
}
