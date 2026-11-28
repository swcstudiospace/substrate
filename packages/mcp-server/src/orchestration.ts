/**
 * E4 CLI Agent + Grok Bot orchestration, E7 leader fencing (phase 85).
 *
 * Three jobs, pure, no I/O in this file — the IO lives in `Substrate`
 * (`service.ts`) which wires these decisions to the ledger:
 *
 * - **Delegation** ({@link buildDelegation}) rides the signed handoff packet
 *   (`handoff.ts`) with the `agent:<surface>` namespace ({@link agentNamespace})
 *   and the Phase 72 allowlist as the permission model
 *   ({@link checkDelegationPermission}); the ledger append itself is the
 *   per-agent audit ({@link DelegationAuditPort}).
 * - **Fencing** ({@link LeaderFence}) is the single-writer session mutation
 *   gate per worktree: `acquire(session, worktree)` issues a fencing token on
 *   lease renewal (`lease_id` + epoch CAS), and a stale token is rejected on
 *   write ({@link LeaderFence.fencedWrite}).
 * - **TTL queueing + DLQ** ({@link DelegationQueue}) holds delegation tasks
 *   with a TTL (default 900s, `lease.ts:42`); expired or failed entries move
 *   to the dead-letter list, never silently dropped.
 *
 * No new coordination store: the fence and the queue are in-process memory
 * (like `EventBuffer`'s layers), audited through the ledger.
 */
import { buildHandoff, type HandoffInput, type HandoffPacket, type HandoffParty } from "./handoff.ts";
import {
	decideClaim,
	decideHeartbeat,
	newLeaseId,
	NO_LEASE,
	DEFAULT_LEASE_TTL_SECONDS,
	normalizeTtlSeconds,
	type ClaimDecision,
	type LeaseSnapshot,
} from "./lease.ts";
import { allowlistFor, type RepoAllowlist } from "./repo-allowlist.ts";
import type { Surface } from "./types.ts";

// ── E4 delegation ─────────────────────────────────────────────────────────────

/** The delegation namespace of one surface, e.g. `agent:claude-code`. */
export function agentNamespace(surface: Surface): string {
	return `agent:${surface}`;
}

/**
 * Whether `fromSession` may delegate work on `repoId` to `toSession`. Both
 * sessions must hold a Phase 72 allowlist grant for the repo; an empty
 * allowlist grants nothing (fail-closed). Never throws.
 */
export function checkDelegationPermission(
	allowlist: RepoAllowlist,
	fromSession: string,
	toSession: string,
	repoId: string,
): { ok: true } | { ok: false; reason: "not-allowed" | "empty-allowlist" } {
	if (allowlist.size === 0) return { ok: false, reason: "empty-allowlist" };
	const fromOk = allowlistFor(allowlist, fromSession).has(repoId);
	const toOk = allowlistFor(allowlist, toSession).has(repoId);
	if (!fromOk || !toOk) return { ok: false, reason: "not-allowed" };
	return { ok: true };
}

export interface DelegationInput extends Omit<HandoffInput, "from" | "to"> {
	from: HandoffParty;
	/** The receiving agent's surface. */
	to_surface: Surface;
	/** The receiving agent's session. */
	to_session: string;
}

export interface Delegation {
	packet: HandoffPacket;
	namespace: string;
	to_session: string;
	/** The repo the packet names, if any. */
	repo: string | null;
}

/**
 * Build one delegation from the handoff input by naming the receiver as the
 * `to` party (the packet's own redaction/capping applies) and stamping the
 * sender's `agent:<surface>` namespace beside it.
 */
export function buildDelegation(input: DelegationInput): Delegation {
	const packet = buildHandoff({
		...input,
		to: { surface: input.to_surface, session_id: input.to_session },
	});
	return { packet, namespace: agentNamespace(input.from.surface), to_session: input.to_session, repo: packet.repo };
}

/** One per-agent audit row for a delegation: who delegated to whom, under which namespace, for which repo. */
export interface DelegationAuditEntry {
	namespace: string;
	from_surface: Surface;
	from_session: string | null;
	to_surface: Surface;
	to_session: string;
	repo: string | null;
	handoff_id: string;
}

/** The ledger side of per-agent audit: `Substrate` appends one event per delegation. Tests use a fake. */
export interface DelegationAuditPort {
	appendAudit(entry: DelegationAuditEntry): void | Promise<void>;
}

/** Append the one audit row for a delegation through `port`. */
export async function recordDelegationAudit(port: DelegationAuditPort, delegation: Delegation): Promise<void> {
	const { packet } = delegation;
	await port.appendAudit({
		namespace: delegation.namespace,
		from_surface: packet.from.surface,
		from_session: packet.from.session_id,
		to_surface: packet.to.surface,
		to_session: packet.to.session_id ?? delegation.to_session,
		repo: packet.repo,
		handoff_id: packet.handoff_id,
	});
}

// ── E7 leader fencing ─────────────────────────────────────────────────────────

/** A fencing token: proof of holding the worktree's single-writer slot at one epoch. */
export interface FenceToken {
	worktree_path: string;
	surface: Surface;
	session_id: string;
	lease_id: string;
	epoch: number;
	/** The epoch the token was taken against — the compare-and-swap token. */
	observed_epoch: number;
}

export type FenceDenial = { ok: false; reason: "held-not-holder" | "unheld" | "stale-epoch" | "not-holder" | "lost" | "expired" };
export type FenceAcquired = { ok: true; token: FenceToken; action: ClaimDecision["action"] };
export type FenceResult = FenceAcquired | FenceDenial;

/**
 * The single-writer session mutation gate: at most one holder per worktree, with
 * an epoch that moves only when the hold changes hands. `acquire` wraps
 * `decideClaim` (`lease.ts:218`); `renew` wraps `decideHeartbeat`
 * (`lease.ts:312`); a stale token (older epoch, or another holder's lease id)
 * is rejected on write.
 */
export class LeaderFence {
	private readonly leases = new Map<string, LeaseSnapshot>();

	/** Acquire or renew the worktree's single-writer slot for `(surface, sessionId)`. Denied while another holder is live. */
	acquire(sessionId: string, surface: Surface, worktreePath: string, nowMs: number, ttlSeconds = DEFAULT_LEASE_TTL_SECONDS): FenceResult {
		const current = this.leases.get(worktreePath) ?? NO_LEASE;
		const ttl = normalizeTtlSeconds(ttlSeconds);
		const decision = decideClaim(current, { surface, session_id: sessionId, ttl_seconds: ttl, caller: surface }, nowMs, newLeaseId);
		if (!decision.granted) {
			return { ok: false, reason: "held-not-holder" };
		}
		this.leases.set(worktreePath, {
			lease_id: decision.lease_id,
			surface,
			session_id: sessionId,
			claimed_at: current.claimed_at,
			heartbeat_at: new Date(nowMs).toISOString(),
			expires_at: new Date(nowMs + ttl * 1000).toISOString(),
			epoch: decision.epoch,
		});
		const token: FenceToken = {
			worktree_path: worktreePath,
			surface,
			session_id: sessionId,
			lease_id: decision.lease_id ?? "",
			epoch: decision.epoch,
			observed_epoch: decision.observed_epoch,
		};
		return { ok: true, token, action: decision.action };
	}

	/** Extend the hold behind `token`. The token's lease id must be the current one and the lease must still be live. */
	renew(token: FenceToken, nowMs: number, ttlSeconds = DEFAULT_LEASE_TTL_SECONDS): FenceResult {
		const current = this.leases.get(token.worktree_path);
		if (!current) return { ok: false, reason: "unheld" };
		const ttl = normalizeTtlSeconds(ttlSeconds);
		const decision = decideHeartbeat(current, { lease_id: token.lease_id, ttl_seconds: ttl, caller: token.surface }, nowMs);
		if (!decision.ok) return { ok: false, reason: decision.reason === "not-holder" ? "not-holder" : decision.reason };
		this.leases.set(token.worktree_path, {
			...current,
			heartbeat_at: new Date(nowMs).toISOString(),
			expires_at: new Date(nowMs + ttl * 1000).toISOString(),
		});
		const renewed: FenceToken = { ...token, lease_id: decision.lease_id, epoch: decision.observed_epoch, observed_epoch: decision.observed_epoch };
		return { ok: true, token: renewed, action: "renewed" };
	}

	/** The fencing check: the token's epoch CAS and lease id must still match the current hold. */
	assertFresh(token: FenceToken): FenceDenial | { ok: true } {
		const current = this.leases.get(token.worktree_path);
		if (!current) return { ok: false, reason: "unheld" };
		if (current.surface !== token.surface || current.session_id !== token.session_id) return { ok: false, reason: "not-holder" };
		if (token.epoch !== current.epoch || token.lease_id !== current.lease_id) return { ok: false, reason: "stale-epoch" };
		return { ok: true };
	}

	/** Run `fn` only while `token` is still the current hold; a stale token is rejected and `fn` never runs. */
	async fencedWrite<T>(token: FenceToken, fn: () => Promise<T> | T): Promise<{ ok: true; value: T } | FenceDenial> {
		const fresh = this.assertFresh(token);
		if (!fresh.ok) return fresh;
		return { ok: true, value: await fn() };
	}

	/** Test and operator seam: the worktree's current hold, if any. */
	snapshot(worktreePath: string): LeaseSnapshot | null {
		return this.leases.get(worktreePath) ?? null;
	}
}

// ── TTL queue + dead-letter ──────────────────────────────────────────────────

export interface QueueTask {
	id: string;
	from_surface: Surface;
	from_session: string;
	to_surface: Surface;
	to_session: string;
	repo: string;
	goal: string;
}

export interface QueueEntry extends QueueTask {
	enqueued_at: number;
	expires_at: number;
	ttl_seconds: number;
}

export interface DeadLetter {
	task: QueueEntry;
	reason: "ttl-expired" | "failed";
	dead_at: number;
	detail: string | null;
}

/** A TTL'd delegation queue with a dead-letter list. Expired or failed entries land in the DLQ, never silently dropped. */
export class DelegationQueue {
	private readonly pending = new Map<string, QueueEntry>();
	private readonly dead: DeadLetter[] = [];

	enqueue(task: QueueTask, options: { ttlSeconds?: number | undefined; now?: number | undefined } = {}): QueueEntry {
		const now = options.now ?? Date.now();
		const ttl = normalizeTtlSeconds(options.ttlSeconds ?? DEFAULT_LEASE_TTL_SECONDS);
		if (this.pending.has(task.id)) throw new Error(`duplicate delegation task: ${task.id}`);
		const entry: QueueEntry = { ...task, enqueued_at: now, expires_at: now + ttl * 1000, ttl_seconds: ttl };
		this.pending.set(task.id, entry);
		return entry;
	}

	/** Take the non-expired tasks (FIFO by `(enqueued_at, id)`). Expired ones move to the dead-letter list. */
	dequeue(nowMs: number = Date.now()): QueueEntry[] {
		const ready: QueueEntry[] = [];
		for (const entry of [...this.pending.values()].sort((a, b) => a.enqueued_at - b.enqueued_at || (a.id === b.id ? 0 : a.id < b.id ? -1 : 1))) {
			if (entry.expires_at <= nowMs) {
				this.pending.delete(entry.id);
				this.dead.push({ task: entry, reason: "ttl-expired", dead_at: nowMs, detail: `ttl ${entry.ttl_seconds}s elapsed` });
			} else {
				this.pending.delete(entry.id);
				ready.push(entry);
			}
		}
		return ready;
	}

	/** Move one pending task to the dead-letter list. Returns false when the id is unknown. */
	fail(id: string, detail = "failed", nowMs: number = Date.now()): boolean {
		const entry = this.pending.get(id);
		if (!entry) return false;
		this.pending.delete(id);
		this.dead.push({ task: entry, reason: "failed", dead_at: nowMs, detail });
		return true;
	}

	/** The dead-letter list, oldest first. */
	listDead(): readonly DeadLetter[] {
		return [...this.dead].sort((a, b) => a.dead_at - b.dead_at || (a.task.id === b.task.id ? 0 : a.task.id < b.task.id ? -1 : 1));
	}

	deadCount(): number {
		return this.dead.length;
	}

	pendingCount(): number {
		return this.pending.size;
	}
}
