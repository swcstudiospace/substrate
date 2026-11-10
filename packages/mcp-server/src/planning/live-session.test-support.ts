import { createHash, timingSafeEqual } from "node:crypto";
import { nextSteeringSession, scopeRepoId, STEERING_STATES, type SteeringSessionState } from "../event.ts";
import { SURFACES } from "../types.ts";
import {
	steeringSessionWithoutSecrets,
	type LiveSessionAccess, type LiveSessionAuthority, type LiveSessionCaller, type LiveSessionCloseResult,
	type LiveSessionFailure, type LiveSessionInput, type LiveSessionIssueResult, type LiveSessionListQuery,
	type LiveSessionListResult, type LiveSessionMetadata, type LiveSessionOperation, type LiveSessionResult,
	type LiveSessionSnapshot, type LiveSessionTransitionResult,
} from "./steering-sessions-store.ts";

const denied = (): LiveSessionFailure => ({ ok: false, error: { code: "not-found" } });
const failed = (): LiveSessionFailure => ({ ok: false, error: { code: "session-unavailable" } });
const hash = (id: string, proof: string) => createHash("sha256").update(`substrate.live-session-binding.v1\0${id}\0${proof}`).digest();
const overrides: Partial<Record<LiveSessionOperation, true>> = { "private-read": true, close: true, "operator-queue": true, "operator-ack": true };

/** Test-only deterministic model. No put/import/reset/transfer bypass exists; all grants originate in issue(). */
export class TestLiveSessionAuthority implements LiveSessionAuthority {
	private readonly rows = new Map<string, { snapshot: LiveSessionSnapshot; proofHash: Buffer; closedAt?: string }>();
	private sequence = 0;
	private clock: number;
	readonly leaseSeconds: number;
	unavailable = false;

	constructor(options: { nowMs?: number; leaseSeconds?: number } = {}) {
		this.clock = options.nowMs ?? Date.parse("2026-10-31T00:00:00.000Z");
		this.leaseSeconds = options.leaseSeconds ?? 3600;
	}
	advance(milliseconds: number): void { this.clock += milliseconds; }

	private lookup(access: LiveSessionAccess, operation: LiveSessionOperation) {
		const row = this.rows.get(access.sessionId);
		if (!row || row.closedAt !== undefined || Date.parse(row.snapshot.expiresAt) <= this.clock || access.caller.surface === null || !SURFACES.includes(access.caller.surface)) return undefined;
		if (access.caller.isOperator && overrides[operation]) return row;
		if (row.snapshot.ownerSurface !== access.caller.surface || !/^[a-f0-9]{64}$/.test(access.sessionBinding ?? "")) return undefined;
		return timingSafeEqual(row.proofHash, hash(access.sessionId, access.sessionBinding ?? "")) ? row : undefined;
	}

	async issue(input: LiveSessionInput & { caller: LiveSessionCaller }): Promise<LiveSessionIssueResult> {
		if (this.unavailable || input.caller.surface === null || !SURFACES.includes(input.caller.surface) || !STEERING_STATES.includes(input.state)) return failed();
		const sequence = ++this.sequence;
		// Separate deterministic streams are a fixture only, never production entropy.
		const sessionId = `ls_${createHash("sha256").update(`test-id:${sequence}`).digest("hex")}`;
		const sessionBinding = createHash("sha256").update(`test-proof:${sequence}`).digest("hex");
		const next = nextSteeringSession(null, { session_id: sessionId, repo_id: input.repoId, state: input.state,
			...(input.steering === undefined ? {} : { steering: input.steering }),
			...(input.planningHash === undefined ? {} : { planning_hash: input.planningHash }) }, this.clock);
		if (!next.ok) return failed();
		const snapshot: LiveSessionSnapshot = { session: steeringSessionWithoutSecrets(next.session), ownerSurface: input.caller.surface,
			issuedAt: new Date(this.clock).toISOString(), expiresAt: new Date(this.clock + this.leaseSeconds * 1000).toISOString() };
		this.rows.set(sessionId, { snapshot, proofHash: hash(sessionId, sessionBinding) });
		return { ok: true, snapshot: structuredClone(snapshot), sessionBinding };
	}
	async read(access: LiveSessionAccess, operation: LiveSessionOperation): Promise<LiveSessionResult> {
		if (this.unavailable) return failed();
		const row = this.lookup(access, operation);
		return row ? { ok: true, snapshot: structuredClone(row.snapshot) } : denied();
	}
	async transition(access: LiveSessionAccess, input: LiveSessionInput & { previousState?: SteeringSessionState }, operation: LiveSessionOperation): Promise<LiveSessionTransitionResult> {
		if (this.unavailable) return failed();
		if (operation !== "owner-transition" && operation !== "operator-ack") return denied();
		if (operation === "operator-ack" && !access.caller.isOperator) return denied();
		const row = this.lookup(access, operation);
		if (!row || input.repoId !== row.snapshot.session.repo_id) return denied();
		if (!STEERING_STATES.includes(input.state) || (input.previousState !== undefined && input.previousState !== row.snapshot.session.state)) {
			return { ok: false, error: { code: "invalid-transition", reason: "state precondition refused" } };
		}
		const current = row.snapshot.session;
		const steering = input.steering ?? current.steering;
		const planningHash = input.planningHash ?? current.planning_hash;
		const next = nextSteeringSession(current, { session_id: access.sessionId, repo_id: input.repoId, state: input.state,
			...(steering === undefined ? {} : { steering }),
			...(planningHash === undefined ? {} : { planning_hash: planningHash }) }, this.clock);
		if (!next.ok) return { ok: false, error: { code: "invalid-transition", reason: next.reason } };
		row.snapshot.session = steeringSessionWithoutSecrets(next.session);
		if (operation === "owner-transition") row.snapshot.expiresAt = new Date(this.clock + this.leaseSeconds * 1000).toISOString();
		return { ok: true, snapshot: structuredClone(row.snapshot), ...(next.previous === undefined ? {} : { previous: next.previous }) };
	}
	async heartbeat(access: LiveSessionAccess): Promise<LiveSessionResult> {
		if (this.unavailable) return failed();
		const row = this.lookup(access, "heartbeat");
		if (!row) return denied();
		row.snapshot.expiresAt = new Date(this.clock + this.leaseSeconds * 1000).toISOString();
		return { ok: true, snapshot: structuredClone(row.snapshot) };
	}
	async close(access: LiveSessionAccess): Promise<LiveSessionCloseResult> {
		if (this.unavailable) return failed();
		const row = this.lookup(access, "close");
		if (!row) return denied();
		row.closedAt = new Date(this.clock).toISOString();
		delete row.snapshot.session.steering;
		delete row.snapshot.session.planning_hash;
		return { ok: true, snapshot: structuredClone(row.snapshot), closedAt: row.closedAt };
	}
	private list(caller: LiveSessionCaller | null, query: LiveSessionListQuery): LiveSessionListResult {
		if (this.unavailable) return failed();
		if (caller !== null && (caller.surface === null || !SURFACES.includes(caller.surface))) return denied();
		if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 200 || (query.cursor !== undefined && !/^ls_[a-f0-9]{64}$/.test(query.cursor))) return failed();
		const repo = query.repoId === undefined ? undefined : scopeRepoId(query.repoId);
		if (repo === "") return failed();
		const visible = [...this.rows.values()].filter((row) => !row.closedAt && Date.parse(row.snapshot.expiresAt) > this.clock
			&& (caller === null || caller.isOperator || row.snapshot.ownerSurface === caller.surface)
			&& (repo === undefined || row.snapshot.session.repo_id === repo)
			&& (query.cursor === undefined || row.snapshot.session.session_id > query.cursor))
			.sort((a, b) => a.snapshot.session.session_id.localeCompare(b.snapshot.session.session_id));
		const sessions: LiveSessionMetadata[] = visible.slice(0, query.limit).map(({ snapshot }) => ({ session_id: snapshot.session.session_id,
			surface: snapshot.ownerSurface, repo_id: snapshot.session.repo_id, state: snapshot.session.state,
			updated_at: snapshot.session.updated_at, expires_at: snapshot.expiresAt }));
		const nextCursor = visible.length > query.limit ? sessions.at(-1)?.session_id : undefined;
		return { ok: true, sessions, ...(nextCursor === undefined ? {} : { nextCursor }) };
	}
	async listVisible(caller: LiveSessionCaller, query: LiveSessionListQuery): Promise<LiveSessionListResult> { return this.list(caller, query); }
	async listMetadata(query: LiveSessionListQuery & { repoId: string }): Promise<LiveSessionListResult> { return this.list(null, query); }
}

export function createTestLiveSessionAuthority(options: { nowMs?: number; leaseSeconds?: number } = {}): TestLiveSessionAuthority {
	return new TestLiveSessionAuthority(options);
}

/** Issue through the port, returning access ready for a real integration call; never seeds an unproved identity. */
export async function issueLiveSession(authority: LiveSessionAuthority, input: Partial<LiveSessionInput> & { caller?: LiveSessionCaller } = {}) {
	const caller: LiveSessionCaller = input.caller ?? { surface: "omp", isOperator: false };
	const result = await authority.issue({ caller, repoId: input.repoId ?? "owner/name", state: input.state ?? "ACTIVE",
		...(input.steering === undefined ? {} : { steering: input.steering }),
		...(input.planningHash === undefined ? {} : { planningHash: input.planningHash }) });
	if (!result.ok) throw new Error("test live session issuance failed");
	const sessionId = result.snapshot.session.session_id;
	const access: LiveSessionAccess = { caller, sessionId, sessionBinding: result.sessionBinding };
	return { ...result, sessionId, access };
}
