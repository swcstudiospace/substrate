/**
 * The governance gate that every `memory.write` passes through.
 *
 * Memory is the one plane other agents *act on*. An event that never lands costs
 * the trail; a memory that lands wrong sends the next four sessions down a road
 * that does not exist. So where `events.emit` fails open, this fails closed: a
 * write the gate cannot fully decide, authorise and verify does not become
 * something another agent will read.
 *
 * Five things happen here, in this order, and the order is the design:
 *
 *   1. **Shape.** A scope the gate cannot classify or a kind it does not know is a
 *      denial, not a new namespace.
 *   2. **RBAC**, default-deny (`memory-policy.ts`). Before the content is looked
 *      at, because storing — even quarantining — text from a writer that has no
 *      business at this scope is still storing it.
 *   3. **Quarantine** (`memory-classify.ts`). Secrets, PII and speculation parked
 *      out of sight rather than dropped.
 *   4. **Exactly-once.** An idempotency key is claimed before anything is written,
 *      so a retried write replays instead of duplicating.
 *   5. **Conflict.** LWW, versioned or review, then the insert — and then a
 *      read-back, because `verified_persisted` is a claim about the index and not
 *      about the insert statement returning.
 *
 * The store is an interface rather than `IndexStore` so that all of the above is
 * testable without a Postgres: the SQL is thin, the decisions are not.
 */
import { randomUUID } from "node:crypto";
import { canonicalJson, normalizeIdentifier, sha256Hex } from "./event.ts";
import { classify } from "./memory-classify.ts";
import {
	conflictKey,
	conflictPlan,
	DEFAULT_GRANTS,
	allowedForWriter,
	grantFor,
	isMemoryKind,
	isMemoryTtl,
	needsReverification,
	normalizeSubject,
	parseScope,
	resolveActor,
	resolveTrust,
	reverifyAfter,
	type MemoryGrant,
} from "./memory-policy.ts";
import { redact } from "./redact.ts";
import {
	MEMORY_TTLS,
	type Actor,
	type MemoryEntry,
	type MemoryKind,
	type MemoryTtl,
	type MemoryWriteOutcome,
	type MemoryWriteRequest,
	type MemoryWriteResult,
	type QuarantineReason,
	type Trust,
} from "./types.ts";

/** A memory body is prose, not a payload. Long enough for a paragraph, not a diff. */
const MAX_MEMORY_TEXT = 4000;
const MAX_KEY = 200;

/** How long a derived key dedupes for. An explicit key never expires — see `claimWrite`. */
export const DERIVED_KEY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How long a claimed-but-unfinished write blocks a retry before it is taken over. */
export const IN_FLIGHT_TIMEOUT_MS = 60_000;

/** The row a store is asked to insert. Everything on it has already been decided. */
export interface NewMemoryEntry {
	id: string;
	scope: string;
	kind: MemoryKind;
	subject: string | null;
	/** Redacted and capped. The store persists this, never the caller's original. */
	text: string;
	writer: string;
	actor: Actor;
	trust: Trust;
	ttl: MemoryTtl;
	source_event: string | null;
	session_id: string | null;
	graph_id: string | null;
	repo: string | null;
	conflict_key: string | null;
	version: number;
	supersedes: string | null;
	entry_hash: string;
	reverify_after: string;
	idempotency_key: string;
}

/** What an idempotency key already spent looks like. */
export interface WriteRecord {
	idempotency_key: string;
	explicit: boolean;
	outcome: MemoryWriteOutcome | "in-flight";
	entry_id: string | null;
	entry_hash: string;
}

export type ClaimResult =
	| {
			claimed: true;
			/**
			 * A fencing token. Every later statement about this claim carries it, so an
			 * attempt whose claim was taken over after timing out cannot come back and
			 * finish — or delete — the claim that replaced it. Identifying a claim by key
			 * alone is what lets a timed-out writer clobber its successor's record.
			 */
			holder: string;
			/**
			 * The entry id reserved by the abandoned attempt this claim took over, or null
			 * for a fresh claim. An attempt can insert its row and die before recording
			 * that it did, so the successor has to look before writing again.
			 */
			tookOverFrom: string | null;
	  }
	| { claimed: false; existing: WriteRecord };

/**
 * The narrow store the gate needs.
 *
 * `claimWrite` carries the only concurrency requirement in the file: it must be
 * atomic, and it must hand the claim over only when the existing record is
 * finished-but-refused, an abandoned in-flight claim, or an expired derived key.
 */
export interface MemoryStore {
	/**
	 * `entryId` is the row this attempt *will* insert, reserved on the claim before it
	 * exists. That is what makes a crash between the insert and the acknowledgement
	 * recoverable: the successor knows which row to look for.
	 */
	claimWrite(input: {
		key: string;
		explicit: boolean;
		entryHash: string;
		entryId: string;
	}): Promise<ClaimResult>;
	/** Records an outcome only while `holder` still owns the claim. */
	finishWrite(key: string, holder: string, outcome: MemoryWriteOutcome, entryId: string | null): Promise<void>;
	/** Drops an in-flight claim only while `holder` still owns it. */
	releaseWrite(key: string, holder: string): Promise<void>;
	/** The current, un-superseded entry for a conflict identity. */
	standingEntry(conflictKey: string): Promise<MemoryEntry | null>;
	/**
	 * Insert the row and, where it supersedes one, retire its predecessor — in one
	 * atomic step. Doing the two separately has no safe order: superseding first can
	 * hide a standing entry behind a write that never lands, and inserting first
	 * leaves two entries in force for one identity.
	 *
	 * `standing-moved` means another writer retired the predecessor in between. The
	 * gate reports that as a conflict rather than racing it.
	 */
	insertEntry(row: NewMemoryEntry): Promise<{ ok: true; entry: MemoryEntry } | { ok: false; reason: "standing-moved" }>;
	readEntry(id: string): Promise<MemoryEntry | null>;
	/**
	 * Park a classified write. Idempotent on `entry_hash` — a retried write that is
	 * quarantined again must return the existing row rather than pile up duplicates
	 * for a reviewer to wade through.
	 */
	quarantineEntry(row: NewMemoryEntry & { reason: QuarantineReason; detail: string }): Promise<string>;
	/** Park a proposal awaiting review. Idempotent on `entry_hash`, as above. */
	enqueueReview(row: NewMemoryEntry & { reason: string }): Promise<string>;
	/** Mark parked proposals for this content reviewed, once a reviewer lands one. */
	releaseReviews(entryHash: string, entryId: string, decidedBy: string): Promise<number>;
}

export interface GovernanceDeps {
	store: MemoryStore;
	/** Checked against the operator's configured reviewer tokens. Never logged. */
	isReviewToken: (token: string | undefined) => boolean;
	/** Operator grants are appended to the defaults; they widen, never narrow. */
	grants?: readonly MemoryGrant[];
	/**
	 * Whether an event id names a real event in the ledger.
	 *
	 * `verified-by-test` rests on a `source_event`, and a claim backed by a string
	 * nobody checked is an asserted claim wearing a verified label — with the longer
	 * shelf life to match. Absent, throwing or false all mean the same thing here:
	 * unconfirmed, so the trust is downgraded. Fail-closed, like everything else on
	 * this path.
	 */
	verifySourceEvent?: (eventId: string) => Promise<boolean>;
	now?: () => Date;
	newId?: (prefix: string) => string;
}

function defaultId(prefix: string): string {
	return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

function refuse(
	outcome: Exclude<MemoryWriteOutcome, "accepted">,
	reason: string,
	remedy: string,
	extra: Partial<Decision> = {},
): Decision {
	return { outcome, reason, remedy, verified_persisted: false, idempotency_key: "", ...extra };
}

/** Derive a key from the content, so an interrupted retry dedupes without one. */
function derivedKey(entryHash: string, sourceEvent: string | null, reviewed: boolean): string {
	return `mwd_${sha256Hex(canonicalJson({ entryHash, sourceEvent, reviewed }))}`;
}

/**
 * The hash `verified_persisted` compares, and the identity a parked review is
 * released by. Over the *governed* content only: the same claim re-submitted with
 * a reviewer's token has to hash the same, or approval-by-resubmit could never
 * find the proposal it is approving.
 */
function contentHash(input: {
	scope: string;
	kind: MemoryKind;
	subject: string | null;
	text: string;
	writer: string;
}): string {
	return sha256Hex(canonicalJson(input));
}

export async function governMemoryWrite(
	request: MemoryWriteRequest,
	deps: GovernanceDeps,
): Promise<MemoryWriteResult> {
	const result = await decide(request, deps);
	// Every reply says who the write was attributed to, on every outcome.
	//
	// The caller does not get to assume it: a bearer token overrides a caller-named
	// surface, so the writer a caller asked to be and the writer it got can differ —
	// and a parameter that is silently ignored is a footgun. RBAC was decided on this
	// name, so this name is what the caller has to be told.
	return { ...result, writer: typeof request.writer === "string" ? request.writer.trim() : "" };
}

/** Everything but the attribution, which `governMemoryWrite` stamps on every reply. */
type Decision = Omit<MemoryWriteResult, "writer">;

async function decide(request: MemoryWriteRequest, deps: GovernanceDeps): Promise<Decision> {
	const { store } = deps;
	const now = deps.now?.() ?? new Date();
	const newId = deps.newId ?? defaultId;
	const grants = [...DEFAULT_GRANTS, ...(deps.grants ?? [])];

	// ── 1. shape ───────────────────────────────────────────────────────────────
	const writer = typeof request.writer === "string" ? request.writer.trim() : "";
	if (!writer) {
		return refuse("denied", "writer.missing", "Name the writing surface, or present a token that identifies it.");
	}

	const scope = parseScope(request.scope);
	if (!scope) {
		return refuse(
			"denied",
			"scope.malformed",
			"scope must be `global`, or `graph:<id>` / `repo:<owner/name>` / `agent:<surface>` / `person:<name>`.",
		);
	}
	if (!isMemoryKind(request.kind)) {
		return refuse("denied", "kind.unknown", "kind must be one of decision, fact, warning, handoff, todo.");
	}
	const kind = request.kind;
	if (request.ttl !== undefined && !isMemoryTtl(request.ttl)) {
		return refuse("denied", "ttl.unknown", `ttl must be one of ${MEMORY_TTLS.join(", ")}.`);
	}
	const ttl: MemoryTtl = request.ttl ?? "permanent";

	const raw = typeof request.text === "string" ? request.text.trim() : "";
	if (!raw) {
		return refuse("denied", "text.empty", "text is required — an empty memory entry tells the next agent nothing.");
	}

	// ── 2. RBAC, default-deny ──────────────────────────────────────────────────
	const grant = grantFor(writer, scope, kind, grants);
	if (!grant) {
		const allowed = allowedForWriter(writer, grants)
			.map(({ scope: cls, kinds }) => `${cls}: ${kinds.join("/")}`)
			.join("; ");
		return refuse(
			"denied",
			"rbac.no-grant",
			allowed
				? `No grant lets ${writer} write a ${kind} at ${scope.class} scope. It may write — ${allowed}. ` +
						`Widen it with SUBSTRATE_MEMORY_GRANTS if that is deliberate.`
				: `${writer} holds no memory grants at all. Present a surface token, or add a grant for it in ` +
						"SUBSTRATE_MEMORY_GRANTS.",
			{ grant: null },
		);
	}

	const reviewed = deps.isReviewToken(request.review_token);
	// Redact before capping, for the reason `normalizeEvent` does: truncating first
	// can cut a token in half so its own pattern no longer matches.
	const text = redact(raw).slice(0, MAX_MEMORY_TEXT);
	const subject = normalizeSubject(request.subject);
	const sourceEvent = normalizeIdentifier(request.source_event);
	const entryHash = contentHash({ scope: scope.canonical, kind, subject, text, writer });

	/**
	 * The fields every row the gate can write shares; only the target table, the id
	 * and the conflict bookkeeping differ. Trust and actor start at what an
	 * unreviewed agent is entitled to — a quarantined or parked row is never allowed
	 * to carry a trust level the write had not yet earned.
	 */
	const baseRow: Omit<NewMemoryEntry, "id" | "idempotency_key"> = {
		scope: scope.canonical,
		kind,
		subject,
		text,
		writer,
		actor: "agent",
		trust: "agent-claimed",
		ttl,
		source_event: sourceEvent,
		session_id: normalizeIdentifier(request.session_id),
		graph_id: normalizeIdentifier(request.graph_id),
		repo: normalizeIdentifier(request.repo),
		conflict_key: null,
		version: 1,
		supersedes: null,
		entry_hash: entryHash,
		reverify_after: reverifyAfter("agent-claimed", now).toISOString(),
	};

	// ── 3. quarantine ──────────────────────────────────────────────────────────
	const classification = classify(raw, kind);
	if (classification && !(classification.reviewable && reviewed)) {
		const key = normalizeKey(request.idempotency_key) ?? derivedKey(entryHash, sourceEvent, reviewed);
		const parked = await store.quarantineEntry({
			...baseRow,
			id: newId("memq"),
			idempotency_key: key,
			reason: classification.reason,
			detail: classification.detail,
		});
		return {
			outcome: "quarantined",
			reason: `quarantine.${classification.reason}`,
			remedy: quarantineRemedy(classification.reason, classification.detail, kind),
			verified_persisted: false,
			idempotency_key: key,
			quarantine_id: parked,
			quarantine_reason: classification.reason,
			grant: grant.name,
		};
	}

	// ── 4. exactly-once ────────────────────────────────────────────────────────
	const explicitKey = normalizeKey(request.idempotency_key);
	const key = explicitKey ?? derivedKey(entryHash, sourceEvent, reviewed);
	// Minted before the claim, so the claim can reserve it. An attempt that inserts its
	// row and then dies is otherwise indistinguishable from one that never got that far,
	// and its successor has to guess — which means either duplicating the row or losing
	// it. Reserving the id removes the guess.
	const entryId = newId("mem");
	const claim = await store.claimWrite({ key, explicit: explicitKey !== null, entryHash, entryId });
	if (!claim.claimed) return await replay(store, key, claim.existing, grant.name);
	const { holder } = claim;

	// Taking over an abandoned claim is not the same as finding nothing done. Look for
	// the row that attempt reserved before writing another one.
	if (claim.tookOverFrom) {
		const orphan = await store.readEntry(claim.tookOverFrom).catch(() => null);
		if (orphan) {
			await store.finishWrite(key, holder, "accepted", orphan.id).catch(() => undefined);
			return {
				outcome: "accepted",
				reason: "recovered.orphan",
				remedy:
					"A previous attempt under this key had already written this entry but died before acknowledging " +
					"it. That entry is returned; nothing was written again.",
				verified_persisted: orphan.entry_hash === entryHash,
				idempotency_key: key,
				entry: orphan,
				deduplicated: true,
				grant: grant.name,
			};
		}
	}

	// ── 5. conflict, insert, read-back ─────────────────────────────────────────
	// True once the entry has committed. From that point the claim is never released:
	// releasing it would let a retry insert the row a second time, which for an
	// appending kind means two visible entries for one write.
	let committed = false;
	try {
		const plan = conflictPlan(scope, kind, subject !== null);
		// Only a `verified-by-test` claim standing on a source event needs the ledger
		// consulted, and only when no reviewer vouched for it — so an ordinary write pays
		// nothing for this.
		const sourceEventVerified =
			request.trust === "verified-by-test" && !reviewed && sourceEvent
				? await (deps.verifySourceEvent?.(sourceEvent) ?? Promise.resolve(false)).catch(() => false)
				: false;
		const trust = resolveTrust({ requested: request.trust, reviewed, sourceEventVerified });
		const actor = resolveActor(request.actor, reviewed);

		if (plan.requiresReview && !reviewed) {
			const reviewId = await store.enqueueReview({
				...baseRow,
				id: newId("memr"),
				idempotency_key: key,
				reason: "global scope requires review",
			});
			await store.finishWrite(key, holder, "conflict", null);
			return {
				outcome: "conflict",
				reason: "review.required",
				remedy:
					`A ${kind} at global scope is read by every agent in every repo, so it is a proposal until a ` +
					`reviewer releases it. It is parked as ${reviewId}. Re-submit the same write with a review_token ` +
					"to install it, or scope it to this repo or graph instead.",
				verified_persisted: false,
				idempotency_key: key,
				strategy: "require-review",
				review_id: reviewId,
				grant: grant.name,
				...(trust.downgradedFrom ? { trust_downgraded_from: trust.downgradedFrom } : {}),
			};
		}

		// Only a strategy that *resolves* on the identity may record one. `conflict_key`
		// is backed by a unique index over the entries in force, so stamping it on an
		// appending kind would turn the second warning about one subject into a store
		// error instead of a second warning.
		const identity = plan.resolve === "append" ? null : conflictKey(scope, kind, subject);
		const standing = identity ? await store.standingEntry(identity) : null;

		if (plan.resolve === "versioned") {
			const stale = versionMismatch(standing, request.expected_version);
			if (stale) {
				await store.finishWrite(key, holder, "conflict", null);
				return {
					outcome: "conflict",
					reason: stale.reason,
					remedy: stale.remedy,
					verified_persisted: false,
					idempotency_key: key,
					strategy: "versioned",
					grant: grant.name,
					...(standing ? { conflict_with: standing.id } : {}),
				};
			}
		}

		const row: NewMemoryEntry = {
			...baseRow,
			id: entryId,
			idempotency_key: key,
			conflict_key: identity,
			version: standing ? standing.version + 1 : 1,
			supersedes: standing?.id ?? null,
			trust: trust.trust,
			actor,
			reverify_after: reverifyAfter(trust.trust, now).toISOString(),
		};

		const written = await store.insertEntry(row);
		if (!written.ok) {
			await store.finishWrite(key, holder, "conflict", null);
			return {
				outcome: "conflict",
				reason: "version.raced",
				remedy:
					"Another writer superseded the entry this write was replacing while it was in flight. Re-read the " +
					"current entry and re-submit against it.",
				verified_persisted: false,
				idempotency_key: key,
				strategy: plan.resolve,
				grant: grant.name,
				...(standing ? { conflict_with: standing.id } : {}),
			};
		}

		const inserted = written.entry;
		committed = true;
		// Record the commit *before* the read-back, not after. Everything below can throw,
		// and if the acknowledgement were last then a crash in between would leave a row
		// in the index that no claim points at — so the retry would write a second one.
		// Recorded first, the retry replays and re-verifies instead.
		await store.finishWrite(key, holder, "accepted", inserted.id);

		// Read it back before believing it. `verified_persisted` is a claim about what
		// is in the index, and an insert that returned is not the same statement.
		const stored = await store.readEntry(inserted.id);
		const verified = stored !== null && stored.entry_hash === entryHash;

		if (verified && plan.requiresReview) await store.releaseReviews(entryHash, inserted.id, writer);

		return {
			outcome: "accepted",
			reason: verified ? "accepted" : "accepted.unverified",
			remedy: verified
				? "Stored and read back. Other agents will see it in their brief."
				: "The insert returned but the read-back did not. Retry with this same idempotency_key — the replay " +
					"re-verifies rather than writing again. Do not act on this entry until verified_persisted is true.",
			verified_persisted: verified,
			idempotency_key: key,
			entry: { ...(stored ?? inserted), needs_reverification: needsReverification(row.reverify_after, now.getTime()) },
			strategy: plan.resolve,
			grant: grant.name,
			...(standing ? { conflict_with: standing.id } : {}),
			...(trust.downgradedFrom ? { trust_downgraded_from: trust.downgradedFrom } : {}),
		};
	} catch (cause) {
		// Let go of the key only while nothing has committed: an outage before the insert
		// would otherwise burn it, and the retry would replay a write that never happened.
		// Once the entry exists the claim stays — held if even the acknowledgement failed —
		// because the alternative is a duplicate, and an abandoned claim is recoverable
		// while a duplicate entry is not.
		if (!committed) await store.releaseWrite(key, holder).catch(() => undefined);
		throw cause;
	}
}

/**
 * A caller-supplied key is stored and echoed, so it is redacted like every other
 * free-text field. Redaction is deterministic, so the same key still dedupes
 * against itself on a retry.
 */
function normalizeKey(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const cleaned = redact(value.trim()).slice(0, MAX_KEY);
	return cleaned.length > 0 ? cleaned : null;
}

/**
 * Answer a key that has already been spent.
 *
 * Only an `accepted` record replays — that is the one with a side effect worth
 * protecting. A refused write left nothing behind, so re-asking is allowed to get
 * a fresh answer, which is also what makes approval-by-resubmit work: the parked
 * `conflict` record does not permanently pin the outcome.
 */
async function replay(
	store: MemoryStore,
	key: string,
	existing: WriteRecord,
	grant: string,
): Promise<Decision> {
	if (existing.outcome === "in-flight") {
		return refuse(
			"conflict",
			"write.in-flight",
			"Another write is holding this idempotency key. Retry in a moment with the same key.",
			{ idempotency_key: key, grant },
		);
	}
	const entry = existing.entry_id ? await store.readEntry(existing.entry_id) : null;
	const verified = entry !== null && entry.entry_hash === existing.entry_hash;
	return {
		outcome: "accepted",
		reason: "idempotent.replay",
		remedy: verified
			? "This key was already spent; the entry it wrote is returned unchanged. Nothing was written again."
			: "This key was already spent, but the entry it recorded is not in the index. Investigate before " +
				"relying on it, and use a fresh idempotency_key to write again.",
		verified_persisted: verified,
		idempotency_key: key,
		deduplicated: true,
		grant,
		...(entry ? { entry } : {}),
	};
}

/** The optimistic-concurrency check that gives `versioned` its teeth. */
function versionMismatch(
	standing: MemoryEntry | null,
	expected: number | undefined,
): { reason: string; remedy: string } | null {
	if (!standing) {
		if (expected === undefined || expected === 0) return null;
		return {
			reason: "version.stale",
			remedy:
				`No decision is in force for this subject, so there is no version ${expected} to replace. ` +
				"Re-submit without expected_version to record the first one.",
		};
	}
	if (expected === undefined) {
		return {
			reason: "version.required",
			remedy:
				`A decision is already in force for this subject (${standing.id}, version ${standing.version}). ` +
				"Read it, then re-submit with expected_version set to that version to supersede it deliberately.",
		};
	}
	if (expected !== standing.version) {
		return {
			reason: "version.stale",
			remedy:
				`The decision in force is version ${standing.version} (${standing.id}), not ${expected}. ` +
				"Re-read it — somebody changed it since — and re-submit against the current version.",
		};
	}
	return null;
}

function quarantineRemedy(reason: QuarantineReason, detail: string, kind: MemoryKind): string {
	if (reason === "secret") {
		return (
			`Quarantined: ${detail}. A reviewer cannot release this one. Re-submit the entry describing where the ` +
			"credential lives rather than quoting it."
		);
	}
	if (reason === "pii") {
		return (
			`Quarantined: ${detail}. Re-submit without it, or — if it genuinely belongs in memory — at ` +
			"`person:<name>` scope with a review_token."
		);
	}
	return (
		`Quarantined: ${detail}. Record it as kind=todo or kind=handoff if it is work not yet done, re-submit as a ` +
		`${kind} once it is settled, or send it with a review_token if a human is vouching for it.`
	);
}
