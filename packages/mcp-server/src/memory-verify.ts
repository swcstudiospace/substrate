/**
 * Verify one governed memory record against the ledger anchor (v1.6, phase 60).
 *
 * Two independent questions, answered in this order:
 *
 * 1. Does the stored content still hash to the stored `entry_hash`? (the gate's own hash; see
 *    `memory-record.ts`). A mismatch means the row was changed after the gate wrote it.
 * 2. Does the ledger event the write rested on (`source_event`) sit inside an anchored root? That is the
 *    injected `anchorEvidence` reader's job; this module only defines the minimal shape it must return and
 *    maps it onto a verdict.
 *
 * Exactly one verdict comes back. "Anchored" is evidence that the write EVENT existed by the time a root
 * was published; it is not evidence about the record's body (a devnet root holds no content), and it says
 * nothing about a row whose body was never in the event. The reasons say so.
 *
 * Pure but for the two injected readers; no clock, no environment, no network of its own.
 */
import { entryHashFor, isForgottenMarker, matchEntryHash, contentOf, toNexusRecord } from "./memory-record.ts";
import type { MemoryEntry } from "./types.ts";

const ANCHOR_STATUSES = ["anchored", "pending", "unanchored", "unverified", "mismatch"] as const;
type AnchorStatus = (typeof ANCHOR_STATUSES)[number];

/**
 * What the anchor reader reports for one ledger event.
 *
 * - `anchored`    the event is inside a published root and `proof_ref` names the inclusion proof.
 * - `pending`     the event exists but its hour is not anchored yet.
 * - `unanchored`  the event exists and no root will cover it (or the ledger holds no such event).
 * - `unverified`  the reader could not decide (store down, proof unreadable).
 * - `mismatch`    a root exists and the event does not verify against it.
 */
export interface AnchorEvidence {
	status: AnchorStatus;
	/** An opaque reference to the inclusion proof (an anchor id, a tx signature, a proof digest). Required when anchored. */
	proof_ref?: string | null;
	/** The reader's own one-line detail, kept verbatim in the reasons (never content). */
	detail?: string;
}

export interface MemoryVerifyDeps {
	/** The stored entry, or null when the id is unknown. Throws on a store error. */
	getEntry(id: string): Promise<MemoryEntry | null>;
	/** Resolve the anchor state of the ledger event `eventId`. */
	anchorEvidence(eventId: string): Promise<AnchorEvidence>;
	/** Cap on the anchor lookup. Default `DEFAULT_ANCHOR_TIMEOUT_MS`. */
	anchorTimeoutMs?: number;
	/** The deadline timer. Absent, a real timer is used; tests inject one that resolves at once. */
	sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_ANCHOR_TIMEOUT_MS = 5_000;

export const VERIFY_STATUSES = ["verified", "hash-mismatch", "pending", "unanchored", "unverified", "anchor-mismatch"] as const;
export type VerifyStatus = (typeof VERIFY_STATUSES)[number];

export interface MemoryVerifyResult {
	id: string;
	status: VerifyStatus;
	/** Why, in order. Always at least one. Never carries record content. */
	reasons: string[];
	/** The stored `entry_hash`. */
	content_hash: string;
	/** Which preimage the stored hash matched, or null (mismatch, or not checked). */
	hash_version: "v1" | "v2" | null;
	/** False when the content was not (or could not be) rehashed, for instance a forgotten entry whose body is gone. */
	content_checked: boolean;
	source_event: string | null;
	anchor: { status: AnchorStatus; proof_ref: string | null } | null;
}

type MemoryVerifyRule = "bad_id" | "not_found";

/** The id is malformed or names no entry. This is a caller error, unlike a record that fails to verify. */
export class MemoryVerifyError extends Error {
	readonly rule: MemoryVerifyRule;
	constructor(rule: MemoryVerifyRule, message: string) {
		super(message);
		this.name = "MemoryVerifyError";
		this.rule = rule;
	}
}

const SESSION_REF_PREFIX = "session:";
const MAX_PROOF_REF = 200;
const MAX_DETAIL = 200;

function oneLine(value: string, max: number): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strips C0/DEL control characters from untrusted text
	const flat = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

async function withDeadline<T>(work: Promise<T>, ms: number, sleep: MemoryVerifyDeps["sleep"]): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let deadline: Promise<{ timedOut: true }>;
	if (sleep) {
		deadline = sleep(ms).then(() => ({ timedOut: true as const }));
	} else {
		const { promise, resolve } = Promise.withResolvers<{ timedOut: true }>();
		timer = setTimeout(() => resolve({ timedOut: true }), ms);
		deadline = promise;
	}
	try {
		return await Promise.race([work.then((value) => ({ timedOut: false as const, value })), deadline]);
	} finally {
		clearTimeout(timer);
	}
}

/** Parse the reader's answer; anything that is not the documented shape is `unverified`, never trusted. */
function parseEvidence(value: unknown): { ok: true; evidence: AnchorEvidence & { proof_ref: string | null } } | { ok: false; reason: string } {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "anchor reader returned a non-object" };
	const rec = value as Record<string, unknown>;
	const status = rec["status"];
	if (typeof status !== "string" || !(ANCHOR_STATUSES as readonly string[]).includes(status)) {
		return { ok: false, reason: "anchor reader returned an unknown status" };
	}
	const proof = rec["proof_ref"];
	if (proof !== undefined && proof !== null && (typeof proof !== "string" || proof.length === 0 || proof.length > MAX_PROOF_REF)) {
		return { ok: false, reason: `anchor reader returned a proof_ref that is not a 1-${MAX_PROOF_REF} character string` };
	}
	const detail = rec["detail"];
	return {
		ok: true,
		evidence: {
			status: status as AnchorStatus,
			proof_ref: typeof proof === "string" ? proof : null,
			...(typeof detail === "string" && detail.length > 0 ? { detail: oneLine(detail, MAX_DETAIL) } : {}),
		},
	};
}

/**
 * The verdict for entry `id`. Throws `MemoryVerifyError` only for a malformed or unknown id; every
 * condition of the record itself, including a missing `source_event` and a failing anchor reader, is a
 * verdict with reasons.
 */
export async function verifyMemoryRecord(deps: MemoryVerifyDeps, id: string): Promise<MemoryVerifyResult> {
	if (typeof id !== "string" || id.length === 0 || id.length > 200) {
		throw new MemoryVerifyError("bad_id", "memory id must be a non-empty string of at most 200 characters");
	}
	const entry = await deps.getEntry(id);
	if (!entry) throw new MemoryVerifyError("not_found", `no memory entry ${id} in the index`);

	const nexus = toNexusRecord(entry);
	const forgotten = nexus.state === "forgotten" || isForgottenMarker(entry.superseded_by);
	const reasons: string[] = [];
	const base = {
		id: entry.id,
		content_hash: entry.entry_hash,
		source_event: nexus.provenance.source_event,
	};

	// Step 1: the content hash. A forgotten entry whose body was removed cannot be rehashed; that is the
	// point of forgetting, so it is reported as unchecked rather than as tampering.
	let hashVersion: "v1" | "v2" | null = null;
	let contentChecked = true;
	if (entry.entry_hash.length === 0) {
		return {
			...base,
			status: "unverified",
			reasons: ["the entry has no stored entry_hash (written before the governance gate), so its content cannot be checked"],
			hash_version: null,
			content_checked: false,
			anchor: null,
		};
	}
	if (forgotten && entry.text.length === 0) {
		contentChecked = false;
		reasons.push("the entry is forgotten and its body is gone, so the content hash was not recomputed");
	} else {
		hashVersion = matchEntryHash(contentOf(entry), entry.writer, entry.entry_hash);
		if (hashVersion === null) {
			const { v1 } = entryHashFor(contentOf(entry), entry.writer);
			return {
				...base,
				status: "hash-mismatch",
				reasons: [`the stored content hashes to ${v1.slice(0, 12)}… (v1) and not to the stored entry_hash ${entry.entry_hash.slice(0, 12)}…: the row changed after the gate wrote it`],
				hash_version: null,
				content_checked: true,
				anchor: null,
			};
		}
		reasons.push(`content hash recomputed and matches the stored entry_hash (${hashVersion} preimage)`);
	}

	// Step 2: the write event.
	const sourceEvent = nexus.provenance.source_event;
	if (sourceEvent === null) {
		return { ...base, status: "unanchored", reasons: [...reasons, "the write named no source_event, so there is no ledger event to anchor"], hash_version: hashVersion, content_checked: contentChecked, anchor: null };
	}
	if (sourceEvent.startsWith(SESSION_REF_PREFIX)) {
		return {
			...base,
			status: "unanchored",
			reasons: [...reasons, `source_event ${sourceEvent} is a session reference, not a ledger event id, so it has no anchor`],
			hash_version: hashVersion,
			content_checked: contentChecked,
			anchor: null,
		};
	}

	const timeoutMs = deps.anchorTimeoutMs ?? DEFAULT_ANCHOR_TIMEOUT_MS;
	let raw: unknown;
	try {
		const outcome = await withDeadline(deps.anchorEvidence(sourceEvent), timeoutMs, deps.sleep);
		if (outcome.timedOut) {
			return { ...base, status: "unverified", reasons: [...reasons, `the anchor lookup for ${sourceEvent} did not answer within ${timeoutMs} ms`], hash_version: hashVersion, content_checked: contentChecked, anchor: null };
		}
		raw = outcome.value;
	} catch (error) {
		// A failing reader is an unknown, reported as `unverified`. Treating it as `verified` would be unsafe
		// and treating it as a crash would hide the content-hash result above, which is already settled.
		const message = error instanceof Error ? error.message : String(error);
		return { ...base, status: "unverified", reasons: [...reasons, `the anchor lookup for ${sourceEvent} failed: ${oneLine(message, MAX_DETAIL)}`], hash_version: hashVersion, content_checked: contentChecked, anchor: null };
	}

	const parsed = parseEvidence(raw);
	if (!parsed.ok) {
		return { ...base, status: "unverified", reasons: [...reasons, parsed.reason], hash_version: hashVersion, content_checked: contentChecked, anchor: null };
	}
	const { evidence } = parsed;
	const anchor = { status: evidence.status, proof_ref: evidence.proof_ref };
	const note = evidence.detail ? ` (${evidence.detail})` : "";
	const finish = (status: VerifyStatus, reason: string): MemoryVerifyResult => ({
		...base,
		status,
		reasons: [...reasons, reason],
		hash_version: hashVersion,
		content_checked: contentChecked,
		anchor,
	});
	switch (evidence.status) {
		case "anchored":
			if (evidence.proof_ref === null) {
				return { ...finish("unverified", `the anchor reader reported ${sourceEvent} anchored without a proof reference${note}`), anchor };
			}
			return finish("verified", `write event ${sourceEvent} is inside an anchored root (proof ${evidence.proof_ref})${note}`);
		case "pending":
			return finish("pending", `write event ${sourceEvent} is not covered by a published root yet${note}`);
		case "unanchored":
			return finish("unanchored", `write event ${sourceEvent} is not covered by any anchored root${note}`);
		case "unverified":
			return finish("unverified", `the anchor state of ${sourceEvent} could not be determined${note}`);
		case "mismatch":
			return finish("anchor-mismatch", `write event ${sourceEvent} does not verify against the published root${note}`);
	}
}
