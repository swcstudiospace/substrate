/**
 * Node leases: one holder at a time, with a TTL and a heartbeat.
 *
 * Phase 0's claim was advisory. It keyed the holder on the *surface*, so two
 * Hermes sessions both matched `claimed_by = 'hermes'` and both believed they
 * held the node; and it had no expiry, so a session that was killed held its
 * node until a human noticed. Neither is a coordination primitive — an agent
 * cannot act on a claim it cannot trust to be exclusive.
 *
 * A lease fixes both:
 *
 *   - **Single holder.** Identity is the pair (surface, session_id), not the
 *     surface. Two sessions of one agent are two holders.
 *   - **TTL.** A lease expires. A dead holder releases its node by doing
 *     nothing, which is the only thing a dead holder reliably does.
 *   - **Heartbeat.** A live holder extends its own lease, and only its own:
 *     every extension is fenced by the `lease_id` it was granted, and by the
 *     caller's authenticated surface being the holder's.
 *   - **Secrecy.** The `lease_id` is the fencing token, so only the holder is
 *     shown it: in the reply that grants it and in replies to calls that
 *     already presented it. Every other view carries `lease_id: null`.
 *   - **Epoch.** A monotonic counter per node, bumped on every change of
 *     holder. It is the compare-and-swap token: the index only applies a
 *     decision that was taken against the epoch still on the row, so of two
 *     agents racing for a free node exactly one write lands.
 *
 * This module is the algebra, with no store and no clock of its own — which is
 * what lets `lease.test.ts` prove exclusivity by interleaving racing claims
 * rather than by asserting that the SQL looks right. `IndexStore` is the
 * enforcer: it re-checks the same preconditions inside one statement, against
 * Postgres' clock rather than the caller's.
 */
import { randomUUID } from "node:crypto";
import type { Surface } from "./types.ts";

/**
 * How long a lease lives without a heartbeat.
 *
 * Long enough that an agent thinking for a few minutes does not lose its node,
 * short enough that a killed session does not strand one for an afternoon.
 */
export const DEFAULT_LEASE_TTL_SECONDS = 900;
/** Below this, ordinary scheduling jitter would expire a live holder's lease. */
export const MIN_LEASE_TTL_SECONDS = 30;
/** Above this, a lease stops being a lease and becomes the old permanent claim. */
export const MAX_LEASE_TTL_SECONDS = 86_400;

export function normalizeTtlSeconds(seconds: unknown, fallback = DEFAULT_LEASE_TTL_SECONDS): number {
	const asked = typeof seconds === "number" && Number.isFinite(seconds) ? Math.trunc(seconds) : fallback;
	return Math.min(MAX_LEASE_TTL_SECONDS, Math.max(MIN_LEASE_TTL_SECONDS, asked));
}

/**
 * Lease ids are opaque and unguessable: holding one is what proves you are the
 * holder, which is why no reply shows one to anybody else (see {@link leaseView}).
 */
export function newLeaseId(): string {
	return `lse_${randomUUID().replace(/-/g, "")}`;
}

export interface LeaseHolder {
	surface: Surface;
	session_id: string;
}

/**
 * A node's lease as the index holds it.
 *
 * Timestamps are whatever the driver returned — Bun's SQL gives `Date`, the
 * MCP surface gives ISO strings — so every reader goes through {@link parseTime}
 * rather than assuming one.
 */
export interface LeaseSnapshot {
	lease_id: string | null;
	surface: Surface | null;
	session_id: string | null;
	claimed_at: string | Date | null;
	heartbeat_at: string | Date | null;
	expires_at: string | Date | null;
	epoch: number;
}

export const NO_LEASE: LeaseSnapshot = {
	lease_id: null,
	surface: null,
	session_id: null,
	claimed_at: null,
	heartbeat_at: null,
	expires_at: null,
	epoch: 0,
};

export type LeaseState = "free" | "held" | "expired";

export function parseTime(value: string | Date | number | null | undefined): number | null {
	if (value === null || value === undefined) return null;
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? null : parsed;
}

/**
 * When a lease lapses, in epoch millis.
 *
 * A row claimed before leases existed carries `claimed_by` and `claimed_at` but
 * no `expires_at`. Treating that as "never expires" would strand those nodes
 * forever — the very failure leases exist to end — so it is read as having
 * expired one default TTL after it was claimed, which lets the next claim heal
 * the row. A claim with neither timestamp has nothing to trust and is expired.
 */
export function leaseExpiry(snapshot: LeaseSnapshot, fallbackTtlSeconds = DEFAULT_LEASE_TTL_SECONDS): number | null {
	const explicit = parseTime(snapshot.expires_at);
	if (explicit !== null) return explicit;
	const claimed = parseTime(snapshot.claimed_at);
	if (claimed !== null) return claimed + fallbackTtlSeconds * 1000;
	return null;
}

export function leaseState(
	snapshot: LeaseSnapshot,
	now: number,
	fallbackTtlSeconds = DEFAULT_LEASE_TTL_SECONDS,
): LeaseState {
	// No surface means nothing holds it, whatever the other columns say: a
	// released node keeps its epoch so the CAS token stays monotonic.
	if (!snapshot.surface) return "free";
	const expiry = leaseExpiry(snapshot, fallbackTtlSeconds);
	if (expiry === null) return "expired";
	return expiry > now ? "held" : "expired";
}

/**
 * Whether a snapshot is held by exactly this holder.
 *
 * Both halves must match and both must be present. A stored claim with no
 * session — a legacy row — is nobody's, because nothing can prove otherwise;
 * it lapses by TTL instead.
 */
export function sameHolder(snapshot: LeaseSnapshot, holder: LeaseHolder): boolean {
	if (!snapshot.surface || !snapshot.session_id) return false;
	return snapshot.surface === holder.surface && snapshot.session_id === holder.session_id;
}

export function holderOf(snapshot: LeaseSnapshot): LeaseHolder | null {
	if (!snapshot.surface) return null;
	return { surface: snapshot.surface, session_id: snapshot.session_id ?? "" };
}

export type ClaimAction =
	/** The node was free. */
	| "granted"
	/** This holder's live lease was extended. */
	| "renewed"
	/** This holder's own lease had lapsed and was taken again, under a new id. */
	| "reclaimed"
	/** Another holder's lease had lapsed and was taken over. */
	| "stolen"
	/** Another holder's lease is live. Nothing changed. */
	| "denied";

export interface ClaimRequest extends LeaseHolder {
	ttl_seconds: number;
	/**
	 * The authenticated token's surface, null on an anonymous local run. A claim
	 * that would renew or re-claim an existing hold must come from the holder's
	 * own surface; see {@link decideClaim}.
	 */
	caller: Surface | null;
}

export interface ClaimDecision {
	action: ClaimAction;
	/** True for every action but `denied`. */
	granted: boolean;
	/** The lease id to write. Unchanged on a renewal; fresh on every change of hold. */
	lease_id: string | null;
	/** The epoch to write. Bumped whenever the hold changes hands, including to the same holder. */
	epoch: number;
	/** The epoch the decision was taken against — the compare-and-swap token. */
	observed_epoch: number;
	ttl_seconds: number;
	/** The holder whose lapsed lease this takes over, if any. Set for `reclaimed` and `stolen`. */
	evicted: LeaseHolder | null;
	/** Who holds it. On `denied` this is someone else; otherwise it is the requester. */
	holder: LeaseHolder;
	/** When the lease being displaced or extended was due to lapse. */
	observed_expiry: string | null;
	/**
	 * Why a `denied` claim was refused, when it was not plain contention:
	 * `not-holder` means the request named the holder but the caller's token is
	 * another surface. Null on every grant and on an ordinary denial.
	 */
	reason: "not-holder" | null;
}

function iso(millis: number | null): string | null {
	return millis === null ? null : new Date(millis).toISOString();
}

/**
 * Decide what a claim does, given the lease as last observed.
 *
 * Pure: the caller supplies `now` and the new lease id is drawn once per
 * decision, so a test can replay a race deterministically. The decision is a
 * proposal — it is only true once a store has applied it against
 * `observed_epoch`.
 *
 * **Renewal is a holder's act.** A claim naming the current holder — surface and
 * session — renews a live lease (and returns its id) or re-claims a lapsed one.
 * The holder's surface and session are both public, so naming them proves
 * nothing; when the caller is authenticated, its token must also be the
 * holder's surface, or the claim is `denied` with reason `not-holder` and
 * nothing changes. Otherwise any token could stretch or shorten another agent's
 * hold and be handed its lease id. An anonymous caller (null) is not checked,
 * as in the fenced calls.
 */
export function decideClaim(
	current: LeaseSnapshot,
	request: ClaimRequest,
	now: number,
	mintLeaseId: () => string = newLeaseId,
): ClaimDecision {
	const ttl = normalizeTtlSeconds(request.ttl_seconds);
	const state = leaseState(current, now);
	const expiry = iso(leaseExpiry(current));
	const holder: LeaseHolder = { surface: request.surface, session_id: request.session_id };
	const base = {
		epoch: current.epoch,
		observed_epoch: current.epoch,
		ttl_seconds: ttl,
		observed_expiry: expiry,
	};
	// The holder's id stays out of a denial. Every fenced call takes it as proof
	// of holding, so handing it to the loser of a race would hand over the node.
	const denied = (reason: "not-holder" | null): ClaimDecision => ({
		...base,
		action: "denied",
		granted: false,
		lease_id: null,
		evicted: null,
		holder: holderOf(current) ?? holder,
		reason,
	});

	const ownHold = state !== "free" && sameHolder(current, holder);
	if (ownHold && isStranger(current, request.caller)) return denied("not-holder");

	if (state === "held") {
		if (ownHold) {
			// A renewal keeps the lease id: the holder's fencing token must survive
			// its own re-claim, or every claim would invalidate the heartbeat loop
			// that the same agent is running.
			return { ...base, action: "renewed", granted: true, lease_id: current.lease_id, evicted: null, holder, reason: null };
		}
		return denied(null);
	}

	// Free or lapsed: the hold changes, so the epoch moves and the lease id is new.
	// A fresh id is what stops a holder whose lease lapsed from heartbeating it
	// back to life after someone else has been there.
	const evicted = state === "expired" ? holderOf(current) : null;
	const action: ClaimAction = evicted === null ? "granted" : ownHold ? "reclaimed" : "stolen";
	return {
		...base,
		action,
		granted: true,
		lease_id: mintLeaseId(),
		epoch: current.epoch + 1,
		evicted: action === "reclaimed" ? null : evicted,
		holder,
		reason: null,
	};
}

export type HeartbeatRefusal =
	/** Nothing holds the node. */
	| "unheld"
	/** Another surface holds it. The caller's token cannot act for that holder, whatever id it presents. */
	| "not-holder"
	/** Someone else holds it: this lease id is stale. */
	| "lost"
	/** This lease lapsed. Re-claim rather than extend — someone may have been here since. */
	| "expired";

export type HeartbeatDecision =
	| { ok: true; lease_id: string; ttl_seconds: number; observed_epoch: number }
	| { ok: false; reason: HeartbeatRefusal; holder: LeaseHolder | null; observed_expiry: string | null };

/**
 * Whether an authenticated caller is a different surface from the holder.
 *
 * `caller` is the token's surface, null on an anonymous local run. Null is never
 * a stranger: with no tokens there is no identity to compare, and the machine's
 * owner is the only caller there is. Both fenced decisions run this before they
 * compare the lease id, so a refusal says nothing about whether the id was right.
 */
function isStranger(current: LeaseSnapshot, caller: Surface | null): boolean {
	return caller !== null && current.surface !== null && current.surface !== caller;
}

/**
 * Decide whether a heartbeat may extend a lease.
 *
 * A lapsed lease is refused even when its id still matches and nobody has taken
 * the node. It would be safe to revive under the epoch CAS, but "a lease that
 * expired is gone" is the contract the rest of this design reasons from: drift
 * scans, the brief and any second agent all read an expired lease as free, and
 * a heartbeat that could quietly undo that would make all three wrong. The
 * holder re-claims instead, which is one call and leaves a `reclaimed` event.
 */
export function decideHeartbeat(
	current: LeaseSnapshot,
	request: { lease_id: string; ttl_seconds: number; caller: Surface | null },
	now: number,
): HeartbeatDecision {
	const expiry = iso(leaseExpiry(current));
	if (!current.lease_id || !current.surface) {
		return { ok: false, reason: "unheld", holder: null, observed_expiry: expiry };
	}
	if (isStranger(current, request.caller)) {
		return { ok: false, reason: "not-holder", holder: holderOf(current), observed_expiry: expiry };
	}
	if (current.lease_id !== request.lease_id) {
		return { ok: false, reason: "lost", holder: holderOf(current), observed_expiry: expiry };
	}
	if (leaseState(current, now) !== "held") {
		return { ok: false, reason: "expired", holder: holderOf(current), observed_expiry: expiry };
	}
	return {
		ok: true,
		lease_id: current.lease_id,
		ttl_seconds: normalizeTtlSeconds(request.ttl_seconds),
		observed_epoch: current.epoch,
	};
}

export type ReleaseAction =
	/** The holder released its own lease. */
	| "released"
	/** Nothing held the node. */
	| "noop"
	/** An operator dropped someone else's lease deliberately. */
	| "forced";

export type ReleaseRefusal =
	/** Another surface holds it. Only the holder's own token, or an operator's force, can drop it. */
	| "not-holder"
	/** The lease id offered is not the one on the node — a stale holder. */
	| "stale-lease"
	/** No lease id offered, and no explicit force. */
	| "lease-id-required";

export type ReleaseDecision =
	| {
			ok: true;
			action: ReleaseAction;
			lease_id: string | null;
			evicted: LeaseHolder | null;
			/**
			 * Who held the lease before this release.
			 *
			 * Carried on the success path, not just on `forced`, because the row is
			 * about to have its holder columns cleared: a caller that read the holder
			 * off the *returned* row would find null and attribute the release to
			 * nobody. The ledger note for an ordinary release needs this to name the
			 * agent that let the node go.
			 */
			holder: LeaseHolder | null;
			observed_epoch: number;
	  }
	| { ok: false; reason: ReleaseRefusal; holder: LeaseHolder | null; observed_epoch: number };

/**
 * Decide whether a release may drop the lease on a node.
 *
 * This is the other half of fencing, and the half that is easy to leave out.
 * Without it, an agent that stalled past its TTL and then woke up would release
 * — or complete — a node that a second agent has since claimed and is working
 * on, and the second agent would never learn. So a release quotes the lease id
 * it believes it holds and is refused if that is not the current one, and it is
 * refused outright when the caller's surface is not the holder's. An operator
 * prising a node loose from a holder that is gone says `force`, and that is
 * recorded rather than looking like an ordinary release. Force skips the holder
 * check: taking a node off someone else is what it is for, and the transport has
 * already decided that this caller may.
 */
export function decideRelease(
	current: LeaseSnapshot,
	request: { lease_id?: string | null; force?: boolean; caller: Surface | null },
	_now: number,
): ReleaseDecision {
	const observed_epoch = current.epoch;
	const held = holderOf(current);
	if (!current.lease_id || !current.surface) {
		// Nothing to release. `noop` is a success — releasing a free node is not an
		// error — but it is emphatically *not* proof of ownership, and a caller that
		// treats it as one (`completeNode` did) lets anyone close an unheld node.
		return { ok: true, action: "noop", lease_id: null, evicted: null, holder: null, observed_epoch };
	}
	if (!request.force && isStranger(current, request.caller)) {
		return { ok: false, reason: "not-holder", holder: held, observed_epoch };
	}
	if (request.lease_id) {
		if (request.lease_id !== current.lease_id) {
			return { ok: false, reason: "stale-lease", holder: held, observed_epoch };
		}
		return { ok: true, action: "released", lease_id: current.lease_id, evicted: null, holder: held, observed_epoch };
	}
	if (request.force) {
		return { ok: true, action: "forced", lease_id: current.lease_id, evicted: held, holder: held, observed_epoch };
	}
	return { ok: false, reason: "lease-id-required", holder: held, observed_epoch };
}

/** The lease as the MCP and REST surfaces report it. */
export interface LeaseView {
	/**
	 * Null unless this reply is to the holder: the grant that minted it, or a call
	 * that presented it and was accepted. Holder, epoch and expiry are public.
	 */
	lease_id: string | null;
	holder: LeaseHolder | null;
	epoch: number;
	state: LeaseState;
	claimed_at: string | null;
	heartbeat_at: string | null;
	expires_at: string | null;
	/** Seconds until it lapses. Negative once it has. */
	expires_in_seconds: number | null;
}

/**
 * The lease as anyone may see it: everything but the id.
 *
 * The default, because a reader is never entitled to the id. The holder got it
 * from its own grant, and a holder that lost it re-claims with the same session
 * from its own surface's token, which renews and returns it. Every place that used to show it to a reader was
 * a way for a second agent to release or complete a node it never held.
 */
export function leaseView(snapshot: LeaseSnapshot, now = Date.now()): LeaseView {
	return { ...holderLeaseView(snapshot, now), lease_id: null };
}

/**
 * The lease as its holder sees it, id included.
 *
 * Only for a reply whose request proved the hold: the grant that minted the id,
 * or a call that presented it and was accepted. Anywhere else, {@link leaseView}.
 */
export function holderLeaseView(snapshot: LeaseSnapshot, now = Date.now()): LeaseView {
	const expiry = leaseExpiry(snapshot);
	return {
		lease_id: snapshot.lease_id,
		holder: holderOf(snapshot),
		epoch: snapshot.epoch,
		state: leaseState(snapshot, now),
		claimed_at: iso(parseTime(snapshot.claimed_at)),
		heartbeat_at: iso(parseTime(snapshot.heartbeat_at)),
		expires_at: iso(expiry),
		expires_in_seconds: expiry === null ? null : Math.round((expiry - now) / 1000),
	};
}
