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
	/**
	 * See `requestHash`. Null where the record does not say which request holds it: one
	 * written before the column existed, or one `restoreWrite` handed back — an attempt
	 * that gives a claim up does not get to leave its own identity on it. Null is
	 * "unknown", never "any"; what such a claim reserved is what identifies it.
	 */
	request_hash: string | null;
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
			 * that it did, so the successor has to look before writing again — and, when
			 * the row is not there, insert under this same id rather than a new one. The
			 * store keeps the reservation on the claim for exactly that reason.
			 *
			 * Only ever set where the reserved row is this write's own: a takeover of the
			 * same request, or — for a claim recorded before `request_hash` existed, whose
			 * identity is therefore unknown — one whose reservation is still empty or
			 * already holds this write's content. A reservation inherited across two
			 * different asks under one key names a row this write did not make, which the
			 * gate would recover and later replay as this write's own.
			 */
			tookOverFrom: string | null;
	  }
	| { claimed: false; existing: WriteRecord };

/**
 * The narrow store the gate needs.
 *
 * `claimWrite` carries the only concurrency requirement in the file: it must be
 * atomic, and it must hand the claim over only when the existing record is
 * finished-but-refused, an abandoned in-flight claim *for this same request*, or an
 * expired derived key.
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
		requestHash: string;
		entryId: string;
	}): Promise<ClaimResult>;
	/** Records an outcome only while `holder` still owns the claim. */
	finishWrite(key: string, holder: string, outcome: MemoryWriteOutcome, entryId: string | null): Promise<void>;
	/** Drops an in-flight claim only while `holder` still owns it. */
	releaseWrite(key: string, holder: string): Promise<void>;
	/**
	 * Give a claim back to the write that reserved `reserved.entryId`, and let go of it.
	 *
	 * For the one case `releaseWrite` cannot answer: a claim that was handed over
	 * carrying a reservation this attempt turns out to have no right to. Dropping it
	 * would take the pointer to a committed row with it and have the owner's retry write
	 * that row a second time, so the record is put back to what the reservation says and
	 * left takeable instead. Conditional on `holder`, and a no-op once it is not held.
	 */
	restoreWrite(key: string, holder: string, reserved: { entryId: string; entryHash: string }): Promise<void>;
	/** The current, un-superseded entry for a conflict identity. */
	standingEntry(conflictKey: string): Promise<MemoryEntry | null>;
	/**
	 * Insert the row and, where it supersedes one, retire its predecessor — in one
	 * atomic step. Doing the two separately has no safe order: superseding first can
	 * hide a standing entry behind a write that never lands, and inserting first
	 * leaves two entries in force for one identity.
	 *
	 * `claim` fences the insert on the claim that authorised it, in the *same* step.
	 * Fencing only `finishWrite` and `releaseWrite` stops a timed-out attempt
	 * corrupting the claim record but not the thing that record exists to prevent: the
	 * attempt still reaches this call and still inserts, so an appending kind ends up
	 * with two visible entries for one write. Ownership has to be checked where the
	 * row is written, not only where the bookkeeping is.
	 *
	 * `standing-moved` means another writer retired the predecessor in between.
	 * `standing-exists` means the identity this write believed free was filled while it
	 * was deciding — two first writes for one subject, under different keys, neither
	 * retiring anything. `claim-lost` means this attempt no longer holds the key — it
	 * ran past the in-flight timeout and a retry took over. The gate reports all three
	 * as a conflict rather than racing them.
	 *
	 * All three must *roll back*, and `standing-exists` in particular must not surface
	 * as a store error: a throw leaves the gate unable to say whether a row landed, so
	 * it keeps the key in flight and the loser cannot retry until the takeover timeout
	 * — for a race it lost cleanly and could have retried at once.
	 */
	insertEntry(
		row: NewMemoryEntry,
		claim: { key: string; holder: string },
	): Promise<
		{ ok: true; entry: MemoryEntry } | { ok: false; reason: "standing-moved" | "claim-lost" | "standing-exists" }
	>;
	readEntry(id: string): Promise<MemoryEntry | null>;
	/**
	 * Park a classified write. Idempotent on `entry_hash` — a retried write that is
	 * quarantined again must return the existing row rather than pile up duplicates
	 * for a reviewer to wade through.
	 */
	quarantineEntry(row: NewMemoryEntry & { reason: QuarantineReason; detail: string }): Promise<string>;
	/** Park a proposal awaiting review. Idempotent on `entry_hash`, as above. */
	enqueueReview(row: NewMemoryEntry & { reason: string }): Promise<string>;
	/**
	 * The proposal a reviewer already approved for this content, and the entry it put
	 * in force — or null where this content has never been approved.
	 *
	 * Asked before parking, because content already installed must not be proposed
	 * again. The queue would hold a decision that is already in force, and approving
	 * that second proposal is the write whose failure the caller hears about after the
	 * entry has committed.
	 */
	approvedReview(entryHash: string): Promise<{ id: string; entry_id: string } | null>;
	/**
	 * Write down that a reviewer's decision for this content is in force: resolve every
	 * proposal parked for it, and — where none was parked — record the approval anyway.
	 *
	 * The second half is what makes a *direct* install discoverable. A reviewer may send
	 * a global write with a token and no proposal having ever existed, which installs the
	 * entry and resolves nothing; with no approved row to find, the same content sent
	 * later without a token went back into the queue as though a reviewer had never seen
	 * it — and approving that proposal is the second entry for a decision already in
	 * force. What `approvedReview` is asked about is the decision, so the decision is
	 * what gets written down, queue entry or no queue entry.
	 *
	 * Atomic, because the two halves race each other: a proposal parked between the
	 * resolve and the record would be left pending for content already installed.
	 *
	 * `row` is only read where a row has to be created, and `row.id` is the id it takes.
	 */
	recordApproval(
		row: NewMemoryEntry & { reason: string },
		entryId: string,
		decidedBy: string,
	): Promise<{ released: number; review_id: string }>;
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

/** Why a global write is parked, as the reviewer's queue reads it. */
const REVIEW_REQUIRED = "global scope requires review";
/** Why an approval exists with no proposal behind it: a reviewer installed it outright. */
const APPROVAL_INSTALLED = "installed with a reviewer's token";

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

/**
 * What makes two requests under one idempotency key *the same request*.
 *
 * Deliberately wider than `contentHash`, and it has to be a second hash rather than a
 * wider first one: `contentHash` is how a parked proposal is matched to its reviewed
 * re-submission, so the reviewed attempt must hash the same there even though it is
 * asking for different trust. Two questions, two hashes.
 *
 * Everything the caller *asks to have recorded* is in here. A key re-used with the same
 * text but a different `ttl` or a different requested `trust` is a request for different
 * retention or different confidence; replaying the original would answer `accepted` for
 * state that was never recorded, which is the same lie as replaying different text.
 *
 * `session_id` is left out on purpose: a retry legitimately arrives in a new session,
 * and the session that wrote the row is honestly the one recorded. `graph_id` and `repo`
 * are in, because they decide which briefs the entry appears in — a difference there is
 * a difference in what the write does.
 */
function requestHash(input: {
	entryHash: string;
	ttl: MemoryTtl;
	trust: Trust | undefined;
	actor: Actor | undefined;
	sourceEvent: string | null;
	graphId: string | null;
	repo: string | null;
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
	const asked = requestHash({
		entryHash,
		ttl,
		trust: request.trust,
		actor: request.actor,
		sourceEvent,
		graphId: normalizeIdentifier(request.graph_id),
		repo: normalizeIdentifier(request.repo),
	});

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
	//
	// On taking over an abandoned in-flight claim the store keeps that claim's
	// reservation rather than replacing it with this one, so the pointer to a row that
	// may already exist is never overwritten before it has been resolved. See `rowId`.
	const entryId = newId("mem");
	const claim = await store.claimWrite({ key, explicit: explicitKey !== null, entryHash, requestHash: asked, entryId });
	if (!claim.claimed) return await replay(store, key, claim.existing, grant.name, entryHash, asked);
	const { holder } = claim;

	// Taking over an abandoned claim is not the same as finding nothing done. Look for
	// the row that attempt reserved before writing another one.
	//
	// This read is deliberately *not* caught. An error here is not evidence that the
	// row is absent, and treating it as such would insert a second entry under a key
	// that already has one — the precise failure the reservation exists to prevent.
	// Failing the write instead costs a retry, which is recoverable; a duplicate memory
	// is not.
	const orphan = claim.tookOverFrom ? await store.readEntry(claim.tookOverFrom) : null;
	// The reservation names a row holding different content. A store that parts with a
	// reservation only to the write that made it cannot reach this, and the gate checks
	// anyway, because the alternative is the one lie this whole stage exists to prevent:
	// replying `accepted` with a stranger's entry, and recording that entry against this
	// key so the next retry reads it back as this write's own `verified_persisted` row.
	//
	// Refusing is only half the answer, though. The claim is now in flight under this
	// attempt, carrying this request's hashes over a row belonging to another write —
	// which is how that write ends up locked out of its own entry: its retry reads a key
	// spent on a different ask, is told `idempotency.reused`, and the row it committed
	// stays unreachable for ever. So the claim goes back to what it reserved, and this
	// attempt lets go of it.
	//
	// The restore is deliberately not caught. It is the whole reason this refusal is safe
	// to give, and a refusal that quietly left the claim rewritten would strand the write
	// it exists to protect; failing here costs a retry instead, which is recoverable.
	if (orphan && orphan.entry_hash !== entryHash) {
		await store.restoreWrite(key, holder, { entryId: orphan.id, entryHash: orphan.entry_hash });
		return reused(key, grant.name, orphan);
	}
	if (orphan) {
		// A recovered global write is installed, so its proposal is no longer pending —
		// the acknowledgement died, not the review. Leaving it in the queue would have a
		// reviewer weighing a decision that is already in force.
		// Leaving the approval *unrecorded* would be the other half of the same mistake:
		// the next tokenless submission of this content would find nothing approved and be
		// parked as though no reviewer had ever seen it.
		if (reviewed && scope.class === "global") {
			await store
				.recordApproval(
					{ ...baseRow, id: newId("memr"), idempotency_key: key, reason: APPROVAL_INSTALLED },
					orphan.id,
					writer,
				)
				.catch(() => undefined);
		}
		await store.finishWrite(key, holder, "accepted", orphan.id).catch(() => undefined);
		return {
			outcome: "accepted",
			reason: "recovered.orphan",
			remedy:
				"A previous attempt under this key had already written this entry but died before acknowledging " +
				"it. That entry is returned; nothing was written again.",
			// Read out of the index, and its content is this request's — checked above, so
			// this is a verification rather than an assumption.
			verified_persisted: true,
			idempotency_key: key,
			entry: orphan,
			deduplicated: true,
			grant: grant.name,
		};
	}

	/**
	 * The id this attempt will insert under.
	 *
	 * When an abandoned claim's reserved row turned out not to exist, this attempt takes
	 * that id over rather than minting a fresh one. Two reasons, and the second is the
	 * better one: the claim row already points at it, so a crash here stays recoverable
	 * without another write; and if the attempt we fenced out is in fact still alive and
	 * inserts after us, it collides on the primary key instead of adding a second row.
	 * Sharing the reservation makes the insert itself mutually exclusive.
	 */
	const rowId = claim.tookOverFrom ?? entryId;

	// ── 5. conflict, insert, read-back ─────────────────────────────────────────
	// True from the moment the insert is *attempted*, not from the moment it returns.
	//
	// Whether the row landed is unknowable once the insert throws: a connection lost
	// during the commit is exactly the failure that leaves a committed row and an
	// exception. Releasing the key there hands a retry a fresh claim with a fresh
	// reserved id, and for an appending kind that is the second visible entry this
	// whole stage exists to prevent.
	//
	// So the claim is kept over the entire window in which a row might exist, and let
	// go only where nothing can have been written. The cost is a key held for the
	// in-flight timeout after a genuine outage; the successor then takes it over, looks
	// for the id this attempt reserved, and either recovers that row or — since it
	// inherits the same reservation — writes it. Both are exactly-once. A released key
	// in doubt is not.
	let mayHaveWritten = false;
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
			// Already approved once, and still in force. Parking it again would put a
			// decision a reviewer has installed back in their queue — and the approval of
			// that second proposal is the write that then reports itself failed, because
			// the entry commits before the proposal is resolved. So the honest answer is
			// the entry: it is this content, it is in the index, and nothing was written
			// again.
			//
			// Only where the installed row answers *this* request, which is more than one
			// condition. It has to still be standing — a superseded row is no longer what any
			// agent reads, so re-proposing the content is a real proposal — and it has to
			// already record the retention and the confidence being asked for. See
			// `requestDiff`: `entry_hash` is content only, so a changed `ttl` or `trust`
			// arrives here hashing identically while asking for something the entry in force
			// does not say.
			const want = { ttl, trust: request.trust, actor: request.actor };
			const standing = await standingApproval(store, entryHash);
			const changed = standing ? requestDiff(standing.entry, want) : null;
			if (standing && !changed) return await alreadyApproved(store, { key, holder }, standing, grant.name, trust);

			const reviewId = await store.enqueueReview({
				...baseRow,
				id: newId("memr"),
				idempotency_key: key,
				reason: changed ? `${REVIEW_REQUIRED} — ${changed}` : REVIEW_REQUIRED,
			});

			// Look again, now that the proposal is parked.
			//
			// The lookup above and this insert are two statements, and a reviewer installing
			// this content in between is not a rare shape: it is what happens whenever an
			// agent re-proposes at the moment its proposal is being approved. Without this
			// second look the gate parks a proposal for a decision that went into force
			// while it was deciding — the stale queue entry `approvedReview` exists to
			// prevent, one step later. Nothing to undo if it did: the pending row is for this
			// exact content, so the reviewer's own decision resolves it.
			//
			// Skipped where the content is already known approved-but-different, because
			// then the parked proposal is a genuinely new ask and is meant to stay.
			const raced = changed ? null : await standingApproval(store, entryHash);
			if (raced && !requestDiff(raced.entry, want)) {
				const resolved = { ...baseRow, id: newId("memr"), idempotency_key: key, reason: APPROVAL_INSTALLED };
				await store.recordApproval(resolved, raced.entry.id, writer).catch(() => undefined);
				return await alreadyApproved(store, { key, holder }, raced, grant.name, trust);
			}

			await store.finishWrite(key, holder, "conflict", null);
			return {
				outcome: "conflict",
				reason: "review.required",
				remedy:
					`A ${kind} at global scope is read by every agent in every repo, so it is a proposal until a ` +
					`reviewer releases it. It is parked as ${reviewId}. ` +
					(changed && standing
						? `This content is already in force as ${standing.entry.id}, but with a different ${changed} — so ` +
							"this is a new proposal rather than a duplicate of it, and re-submitting it with a review_token " +
							"is what installs the change."
						: "Re-submit the same write with a review_token to install it, or scope it to this repo or graph " +
							"instead."),
				verified_persisted: false,
				idempotency_key: key,
				strategy: "require-review",
				review_id: reviewId,
				grant: grant.name,
				...(changed && standing ? { conflict_with: standing.entry.id } : {}),
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
			id: rowId,
			idempotency_key: key,
			conflict_key: identity,
			version: standing ? standing.version + 1 : 1,
			supersedes: standing?.id ?? null,
			trust: trust.trust,
			actor,
			reverify_after: reverifyAfter(trust.trust, now).toISOString(),
		};

		mayHaveWritten = true;
		const written = await store.insertEntry(row, { key, holder });
		if (!written.ok) {
			// A refusal is the store answering, not failing: it rolled back, so nothing
			// landed and the key is safe to let go of again.
			mayHaveWritten = false;
			// A lost claim is not this attempt's to record an outcome for — the successor
			// owns the key now, and `finishWrite` would be a fenced no-op anyway. Say so
			// plainly rather than reporting somebody else's takeover as this write's race.
			if (written.reason === "claim-lost") {
				return {
					outcome: "conflict",
					reason: "write.superseded",
					// The remedy must not offer a fresh key. The retry that owns this one may
					// already have written the entry, and for an appending kind a fresh key is
					// how one write becomes two. Re-submitting under the *same* key is always
					// safe: it replays the accepted record, recovers the reserved row, or is
					// told the key is still in flight.
					remedy:
						"This write held its idempotency key past the in-flight timeout, so a retry took the key over " +
						"and owns it now. Nothing was written here, but that retry may already have written this " +
						"entry. Read its result, or re-submit under the same idempotency_key — never a fresh one, " +
						"which is how one write becomes two entries.",
					verified_persisted: false,
					idempotency_key: key,
					strategy: plan.resolve,
					grant: grant.name,
				};
			}
			// Two first writes for one subject, under different keys — the usual shape.
			// Neither saw a standing entry, so neither retired one, and the identity went
			// to whichever insert reached the index first. Nothing landed here — the store
			// rolled back — so the key records a conflict and is takeable again
			// immediately, which is the half that used to be missing: the collision
			// surfaced as a store error, the gate could not rule out a committed row, and
			// the loser's key stayed in flight until the takeover timeout.
			if (written.reason === "standing-exists") {
				await store.finishWrite(key, holder, "conflict", null);
				// Whoever won is the entry to re-submit against, and it is worth naming: the
				// standing read above found nothing, so without this the reply could only say
				// that something else got there first.
				const winner = identity ? await store.standingEntry(identity).catch(() => null) : null;
				return {
					outcome: "conflict",
					reason: "standing.raced",
					remedy:
						`Another writer put a ${kind} in force for this subject while this write was in flight` +
						`${winner ? ` (${winner.id})` : ""}, and one entry is in force per subject. Nothing was written ` +
						"here and this idempotency_key is free to use again: re-read the entry in force and re-submit " +
						(plan.resolve === "versioned"
							? "against it with expected_version set to its version."
							: "against it."),
					verified_persisted: false,
					idempotency_key: key,
					strategy: plan.resolve,
					grant: grant.name,
					...(winner ? { conflict_with: winner.id } : {}),
				};
			}
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
		// Record the commit *before* the read-back, not after. Everything below can throw,
		// and if the acknowledgement were last then a crash in between would leave a row
		// in the index that no claim points at — so the retry would write a second one.
		// Recorded first, the retry replays and re-verifies instead.
		await store.finishWrite(key, holder, "accepted", inserted.id);

		// Read it back before believing it. `verified_persisted` is a claim about what
		// is in the index, and an insert that returned is not the same statement.
		const stored = await store.readEntry(inserted.id);
		const verified = stored !== null && stored.entry_hash === entryHash;

		// The decision is written down whether or not anything was parked for it. A
		// reviewer may install a global entry outright, with a token and no proposal ever
		// having existed; recording only the *release* of pending rows leaves that install
		// invisible to `approvedReview`, and the same content sent later without a token is
		// then parked as though no reviewer had ever seen it.
		if (verified && plan.requiresReview) {
			await store.recordApproval({ ...row, id: newId("memr"), reason: APPROVAL_INSTALLED }, inserted.id, writer);
		}

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
		// Let go of the key only where no row can exist: an outage before the insert was
		// attempted would otherwise burn it, and the retry would replay a write that never
		// happened. From the attempt onwards the claim stays — held even if it was only the
		// acknowledgement that failed — because an abandoned claim is recoverable and a
		// duplicate entry is not.
		if (!mayHaveWritten) await store.releaseWrite(key, holder).catch(() => undefined);
		throw cause;
	}
}

/**
 * The entry a reviewer's approval of this exact content put in force, or null.
 *
 * Three things have to hold before an approval means "this content is what agents
 * read": the row it points at has to exist, it has to hold this content — `entry_hash`
 * is the tie between a proposal and its entry, and a mismatch means the pointer is
 * wrong rather than that this content is in force — and it has to be standing.
 */
async function standingApproval(
	store: MemoryStore,
	entryHash: string,
): Promise<{ review: string; entry: MemoryEntry } | null> {
	const approved = await store.approvedReview(entryHash);
	if (!approved) return null;
	const installed = await store.readEntry(approved.entry_id);
	if (!installed || installed.entry_hash !== entryHash || installed.superseded_by) return null;
	return { review: approved.id, entry: installed };
}

/**
 * What this request asks to have recorded that the entry in force does not record.
 *
 * `entry_hash` covers the *content* — scope, kind, subject, text, writer — and
 * deliberately not the retention or the confidence, because a reviewed re-submission
 * has to hash the same as the proposal it is approving while asking for different
 * trust. So a hash match is not yet an answer to this request: the same words asking
 * for `ttl: "session"` against a permanent entry, or for `human-confirmed` against an
 * agent-claimed one, are a different ask about the same claim. Answering those with the
 * standing entry and `verified_persisted: true` reports retention and confidence that
 * were never recorded — the same falsehood `requestHash` refuses on a re-used key, one
 * table over.
 *
 * Only what the caller actually asked for counts. A request naming no `trust` and no
 * `actor` is asking for the default, not asking for the entry in force to be *downgraded*
 * to it; counting that as a difference would put decisions a reviewer installed straight
 * back into their queue, which is the bug this whole branch exists to prevent. `ttl`
 * always counts: it has a default, and that default is a retention ask like any other.
 */
function requestDiff(
	entry: MemoryEntry,
	want: { ttl: MemoryTtl; trust: Trust | undefined; actor: Actor | undefined },
): string | null {
	if (entry.ttl !== want.ttl) return `ttl (asked for ${want.ttl}, in force is ${entry.ttl})`;
	if (want.trust !== undefined && entry.trust !== want.trust) {
		return `trust (asked for ${want.trust}, in force is ${entry.trust})`;
	}
	if (want.actor !== undefined && entry.actor !== want.actor) {
		return `actor (asked for ${want.actor}, in force is ${entry.actor})`;
	}
	return null;
}

/**
 * Answer a re-proposal with the entry a reviewer already installed.
 *
 * The claim is **released**, not finished. Recording `accepted` against it spends the
 * key on a row this attempt did not write, and for the derived key a keyless
 * re-proposal arrives under that is the next bug: once the approved entry is
 * superseded, the same content inside the 24-hour window replays the superseded row as
 * this write's own `verified_persisted` entry instead of reaching review. Nothing was
 * written here, so the key is protecting nothing — and letting go of it is what makes
 * the next ask get decided against the index as it is *then*, which is the only way a
 * superseded approval stops answering for a decision that is no longer in force.
 */
async function alreadyApproved(
	store: MemoryStore,
	claim: { key: string; holder: string },
	standing: { review: string; entry: MemoryEntry },
	grant: string,
	trust: { downgradedFrom?: Trust },
): Promise<Decision> {
	await store.releaseWrite(claim.key, claim.holder);
	return {
		outcome: "accepted",
		reason: "review.already-approved",
		remedy:
			"A reviewer already approved this exact content, with the retention and trust you asked for, and it is " +
			"the entry in force — so it was not parked for review again and nothing was written. Send a changed text " +
			"— or supersede the entry deliberately — if this was meant to be a new proposal.",
		// Read out of the index and hash-checked, like every other verification here.
		verified_persisted: true,
		idempotency_key: claim.key,
		entry: standing.entry,
		deduplicated: true,
		strategy: "require-review",
		review_id: standing.review,
		grant,
		...(trust.downgradedFrom ? { trust_downgraded_from: trust.downgradedFrom } : {}),
	};
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
	entryHash: string,
	asked: string,
): Promise<Decision> {
	if (existing.outcome === "in-flight") {
		// A key held for a *different* ask is spent, not merely busy. No amount of waiting
		// turns it into this write's key, so "retry in a moment" would be advice that can
		// only ever be refused — and the attempt holding it may already have written a row
		// that a takeover would otherwise hand back as this one's.
		if (existing.request_hash && existing.request_hash !== asked) return reused(key, grant, null);

		// The same answer for the same reason, one step further out. A claim whose
		// reservation already holds another write's content is one the store will not part
		// with — it is holding it for the write that committed that row, so that write can
		// come back and recover it — and no amount of waiting changes that either. It is the
		// whole test for a record carrying no `request_hash`, where what was reserved is the
		// only identity there is, and a backstop for one where the two disagree.
		//
		// Unguarded for the reason given below: a read that fails is not evidence of absence.
		const reserved = existing.entry_id ? await store.readEntry(existing.entry_id) : null;
		if (reserved && reserved.entry_hash !== entryHash) return reused(key, grant, reserved);

		return refuse(
			"conflict",
			"write.in-flight",
			"Another write is holding this idempotency key. Retry in a moment with the same key.",
			{ idempotency_key: key, grant },
		);
	}
	// Unguarded on purpose. A read that fails must not read as "the row is absent" —
	// that is the mistake the orphan lookup already made once. A throw here surfaces as
	// `denied / store.write-failed`, which is the honest answer.
	const entry = existing.entry_id ? await store.readEntry(existing.entry_id) : null;

	// A key already spent on a *different request* cannot also stand for this one.
	// Reporting that as `accepted` and handing back the earlier entry would say this write
	// landed when it never happened — and no remedy makes that honest, so it is a conflict.
	//
	// Checked against the request identity, not the text: the same words with a different
	// `ttl` or a different requested `trust` ask for retention or confidence that the
	// stored row does not have. `verified_persisted: true` on that reply would be a
	// straight falsehood about state the caller is about to rely on.
	//
	// A record with no `request_hash` predates it; fall back to the content comparison
	// rather than refusing a write whose identity simply was not recorded.
	const divergent = existing.request_hash ? existing.request_hash !== asked : entry !== null && entry.entry_hash !== entryHash;
	if (divergent) return reused(key, grant, entry);

	// Past the check above, any row there is this request's own content.
	const verified = entry !== null;
	return {
		outcome: "accepted",
		reason: "idempotent.replay",
		remedy: verified
			? "This key was already spent; the entry it wrote is returned unchanged. Nothing was written again."
			: // Nothing is in the index under this key, so a fresh key writes one entry rather
				// than a second. That is only true because the read above proved the absence.
				"This key was already spent, but the entry it recorded is no longer in the index. Nothing is stored " +
				"under this key, so investigate how it was removed before relying on either outcome; a fresh " +
				"idempotency_key will write this entry once.",
		verified_persisted: verified,
		idempotency_key: key,
		deduplicated: true,
		grant,
		...(entry ? { entry } : {}),
	};
}

/**
 * One key, two different asks.
 *
 * Shared by the three places that can find out — a finished record, a claim still in
 * flight, and a reservation recovered from an attempt that died — because the caller's
 * position is identical in all three: this write did not happen, and nothing sent under
 * this key will make it happen. A single wording also keeps the answer from drifting
 * into one that sounds like a success on one path and a refusal on another.
 */
function reused(key: string, grant: string, entry: MemoryEntry | null): Decision {
	return refuse(
		"conflict",
		"idempotency.reused",
		`This idempotency_key was already spent on a different write${entry ? ` (${entry.id})` : ""}. A key is the ` +
			"promise that one write happens once, so it cannot also stand for this one — and that covers the ttl " +
			"and trust you asked for, not just the text. Send this entry under its own idempotency_key.",
		{ idempotency_key: key, grant, ...(entry ? { conflict_with: entry.id } : {}) },
	);
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
