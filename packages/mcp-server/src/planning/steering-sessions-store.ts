/**
 * Durable live-session security authority. The historical `steering_sessions` restart-cache table is retained by
 * immutable migration history, but has no runtime adapter or authorization role. Only server-issued bindings in
 * `live_session_bindings` grant access, through the transactional authority below.
 */
import type { SQL, TransactionSQL } from "bun";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { nextSteeringSession, scopeRepoId, STEERING_STATES, type SteeringSession, type SteeringSessionState } from "../event.ts";
import { redact } from "../redact.ts";
import { SURFACES, type Surface } from "../types.ts";

/** Validated row projection used internally by the authoritative snapshot parser. */
interface StoredSteeringSession {
	surface: Surface;
	session: SteeringSession;
}


function isSurface(value: string): value is Surface {
	return (SURFACES as readonly string[]).includes(value);
}

function isState(value: string): value is SteeringSessionState {
	return (STEERING_STATES as readonly string[]).includes(value);
}

/**
 * A copy of the session with its caller-supplied free text passed through the redactor: the directions and the planning hash,
 * which arrive from the caller as they are. The ledger event redacts the same text; this is the step the table and the
 * `/steering/sessions` answer need so a credential pasted into a direction is not kept or handed on. Identifiers and the state
 * are not changed, so the session's key stays the one its owner wrote.
 */
export function steeringSessionWithoutSecrets(session: SteeringSession): SteeringSession {
	return {
		...session,
		...(session.planning_hash === undefined ? {} : { planning_hash: redact(session.planning_hash) }),
		...(session.steering === undefined ? {} : { steering: redact(session.steering) }),
	};
}

/** A canonical stored row as a session, or null for an unknown surface/state or invalid timestamp. */
function storedSessionOf(row: Record<string, unknown>): StoredSteeringSession | null {
	const surface = String(row.surface);
	const state = String(row.state);
	const updated = new Date(row.updated_at as string | number | Date);
	if (!isSurface(surface) || !isState(state) || Number.isNaN(updated.getTime())) return null;
	const steering = row.steering;
	const planningHash = row.planning_hash;
	return {
		surface,
		session: steeringSessionWithoutSecrets({
			session_id: String(row.session_id),
			repo_id: String(row.repo_id),
			state,
			...(typeof planningHash === "string" ? { planning_hash: planningHash } : {}),
			...(typeof steering === "string" ? { steering } : {}),
			updated_at: updated.toISOString(),
		}),
	};
}


/** Authenticated transport identity, never request-body attribution. */
export interface LiveSessionCaller {
	surface: Surface | null;
	isOperator: boolean;
}
export interface LiveSessionAccess {
	caller: LiveSessionCaller;
	sessionId: string;
	sessionBinding?: string;
}
export type LiveSessionOperation = "private-read" | "owner-transition" | "heartbeat" | "close" | "operator-queue" | "operator-ack";
export interface LiveSessionSnapshot {
	session: SteeringSession;
	ownerSurface: Surface;
	issuedAt: string;
	expiresAt: string;
}
/** Public, proof-free projection. Neither free text nor private directive counts belong here. */
export interface LiveSessionMetadata {
	session_id: string;
	surface: Surface;
	repo_id: string;
	state: SteeringSessionState;
	updated_at: string;
	expires_at: string;
}
export interface LiveSessionFailure {
	ok: false;
	error: { code: "not-found" | "session-unavailable" };
}
export type LiveSessionResult = { ok: true; snapshot: LiveSessionSnapshot } | LiveSessionFailure;
export type LiveSessionIssueResult = { ok: true; snapshot: LiveSessionSnapshot; sessionBinding: string } | LiveSessionFailure;
export type LiveSessionCloseResult = { ok: true; snapshot: LiveSessionSnapshot; closedAt: string } | LiveSessionFailure;
export type LiveSessionTransitionResult =
	| { ok: true; snapshot: LiveSessionSnapshot; previous?: SteeringSessionState }
	| LiveSessionFailure
	| { ok: false; error: { code: "invalid-transition"; reason: string } };
export interface LiveSessionInput {
	repoId: string;
	state: SteeringSessionState;
	steering?: string;
	planningHash?: string;
}
export interface LiveSessionListQuery {
	repoId?: string;
	limit: number;
	cursor?: string;
}
export type LiveSessionListResult = { ok: true; sessions: LiveSessionMetadata[]; nextCursor?: string } | LiveSessionFailure;
export interface LiveSessionAuthority {
	issue(input: LiveSessionInput & { caller: LiveSessionCaller }): Promise<LiveSessionIssueResult>;
	read(access: LiveSessionAccess, operation: LiveSessionOperation): Promise<LiveSessionResult>;
	transition(access: LiveSessionAccess, input: LiveSessionInput & { previousState?: SteeringSessionState }, operation: LiveSessionOperation): Promise<LiveSessionTransitionResult>;
	heartbeat(access: LiveSessionAccess): Promise<LiveSessionResult>;
	close(access: LiveSessionAccess): Promise<LiveSessionCloseResult>;
	listVisible(caller: LiveSessionCaller, query: LiveSessionListQuery): Promise<LiveSessionListResult>;
	listMetadata(query: LiveSessionListQuery & { repoId: string }): Promise<LiveSessionListResult>;
}

const LIVE_ID = /^ls_[a-f0-9]{64}$/;
const LIVE_PROOF = /^[a-f0-9]{64}$/;
const DUMMY_BINDING_HASH = Buffer.alloc(32);
const OPERATOR_OPERATIONS: Partial<Record<LiveSessionOperation, true>> = {
	"private-read": true, close: true, "operator-queue": true, "operator-ack": true,
};
const notFound = (): LiveSessionFailure => ({ ok: false, error: { code: "not-found" } });
const unavailable = (): LiveSessionFailure => ({ ok: false, error: { code: "session-unavailable" } });

function bindingHash(sessionId: string, proof: string): Buffer {
	return createHash("sha256").update("substrate.live-session-binding.v1\0").update(sessionId).update("\0").update(proof).digest();
}

function authorized(row: Record<string, unknown> | undefined, access: LiveSessionAccess, operation: LiveSessionOperation): boolean {
	const proof = access.sessionBinding;
	const validProof = typeof proof === "string" && LIVE_PROOF.test(proof);
	const expected = typeof row?.binding_proof_hash === "string" && LIVE_PROOF.test(row.binding_proof_hash)
		? Buffer.from(row.binding_proof_hash, "hex") : DUMMY_BINDING_HASH;
	const supplied = validProof ? bindingHash(access.sessionId, proof) : DUMMY_BINDING_HASH;
	const matches = timingSafeEqual(expected, supplied) && validProof;
	if (!row || access.caller.surface === null || !isSurface(access.caller.surface)) return false;
	if (access.caller.isOperator && OPERATOR_OPERATIONS[operation]) return true;
	return row.owner_surface === access.caller.surface && matches;
}

function snapshotOf(row: Record<string, unknown>): LiveSessionSnapshot {
	const stored = storedSessionOf({ ...row, surface: row.owner_surface });
	const issuedAt = new Date(row.issued_at as string | Date).toISOString();
	const expiresAt = new Date(row.expires_at as string | Date).toISOString();
	if (!stored || !LIVE_ID.test(stored.session.session_id) || scopeRepoId(stored.session.repo_id) !== stored.session.repo_id) {
		throw new Error("invalid live session row");
	}
	return { session: stored.session, ownerSurface: stored.surface, issuedAt, expiresAt };
}

function metadataOf(row: Record<string, unknown>): LiveSessionMetadata {
	const surface = String(row.owner_surface);
	const state = String(row.state);
	if (!isSurface(surface) || !isState(state) || !LIVE_ID.test(String(row.session_id))) throw new Error("invalid live metadata row");
	return {
		session_id: String(row.session_id), surface, repo_id: String(row.repo_id), state,
		updated_at: new Date(row.updated_at as string | Date).toISOString(),
		expires_at: new Date(row.expires_at as string | Date).toISOString(),
	};
}

/** Upper bound on expired, still-open sessions one discovery call marks terminal; the remainder wait for later calls. */
export const EXPIRY_PASS_LIMIT = 100;

/**
 * Marks up to EXPIRY_PASS_LIMIT expired, still-open sessions terminal. The row keeps its identity; free text is cleared the
 * way `close` clears it, and the `where closed_at is null` partial indexes stop covering it. Expiry is monotone (renewal needs
 * a live row), so a row expired at scan time is still expired once locked. Rows locked elsewhere are skipped, never awaited.
 * Driver errors propagate to the caller, which answers with the sanitized unavailable result.
 */
async function expireDue(sql: SQL): Promise<void> {
	await sql.begin(async (tx) => {
		await tx`
			with due as (
				select session_id from live_session_bindings
				where closed_at is null and expires_at <= clock_timestamp()
				limit ${EXPIRY_PASS_LIMIT} for update skip locked)
			update live_session_bindings as b
			set closed_at = clock_timestamp(), close_reason = 'expired', steering = null, planning_hash = null
			from due where b.session_id = due.session_id`;
	});
}

/**
 * Mandatory PostgreSQL authority, wholly independent of the optional restart cache above.
 * Mutations lock first, then obtain wall-clock SQL time (not the transaction-start timestamp).
 * No driver exception escapes this boundary and no plaintext proof leaves issuance.
 */
export function bunLiveSessionAuthority(
	sql: SQL,
	options: { leaseSeconds: number; randomBytes?: (size: number) => Buffer },
): LiveSessionAuthority {
	const entropy = options.randomBytes ?? randomBytes;
	const validLease = Number.isSafeInteger(options.leaseSeconds) && options.leaseSeconds >= 1 && options.leaseSeconds <= 86_400;
	type Transaction = TransactionSQL;

	async function locked(
		tx: Transaction, access: LiveSessionAccess, operation: LiveSessionOperation,
	): Promise<{ row: Record<string, unknown>; snapshot: LiveSessionSnapshot; now: string } | LiveSessionFailure> {
		const rows: Array<Record<string, unknown>> = await tx`
			select session_id, owner_surface, repo_id, binding_proof_hash, issued_at, expires_at,
				updated_at, state, steering, planning_hash, closed_at
			from live_session_bindings where session_id = ${access.sessionId} for update`;
		// A separate statement is essential: a SELECT expression can be evaluated before a row-lock wait.
		const clock: Array<{ now: Date | string }> = await tx`select clock_timestamp() as now`;
		const now = new Date(clock[0]?.now ?? Number.NaN).toISOString();
		const row = rows[0];
		if (!authorized(row, access, operation) || !row || row.closed_at !== null || new Date(row.expires_at as string | Date).getTime() <= Date.parse(now)) {
			return notFound();
		}
		return { row, snapshot: snapshotOf(row), now };
	}

	async function listing(caller: LiveSessionCaller | null, query: LiveSessionListQuery): Promise<LiveSessionListResult> {
		try {
			if (!validLease) return unavailable();
			if (caller !== null && (caller.surface === null || !isSurface(caller.surface))) return notFound();
			if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 200 || (query.cursor !== undefined && !LIVE_ID.test(query.cursor))) return unavailable();
			const repo = query.repoId === undefined ? null : scopeRepoId(query.repoId);
			if (repo === "") return unavailable();
			// Discovery is the maintenance point: expired sessions leave the live indexes before the scan reads them.
			await expireDue(sql);
			// All predicates precede LIMIT. SQL selects only the public columns, even for operators.
			const rows: Array<Record<string, unknown>> = await sql`
				select session_id, owner_surface, repo_id, state, updated_at, expires_at
				from live_session_bindings
				where closed_at is null and expires_at > clock_timestamp()
					and (${caller === null || caller.isOperator} or owner_surface = ${caller?.surface ?? ""})
					and (${repo}::text is null or repo_id = ${repo})
					and (${query.cursor ?? null}::text is null or session_id > ${query.cursor ?? null})
				order by session_id asc limit ${query.limit + 1}`;
			const sessions = rows.slice(0, query.limit).map(metadataOf);
			const nextCursor = rows.length > query.limit ? sessions.at(-1)?.session_id : undefined;
			return { ok: true, sessions, ...(nextCursor === undefined ? {} : { nextCursor }) };
		} catch {
			return unavailable();
		}
	}

	return {
		async issue(input) {
			try {
				if (!validLease || input.caller.surface === null || !isSurface(input.caller.surface) || !isState(input.state) || scopeRepoId(input.repoId) === "") return unavailable();
				for (let attempt = 0; attempt < 4; attempt += 1) {
					const idBytes = entropy(32);
					const proofBytes = entropy(32);
					if (idBytes.length !== 32 || proofBytes.length !== 32) return unavailable();
					const sessionId = `ls_${idBytes.toString("hex")}`;
					const sessionBinding = proofBytes.toString("hex");
					const proofHash = bindingHash(sessionId, sessionBinding).toString("hex");
					const next = nextSteeringSession(null, {
						session_id: sessionId, repo_id: input.repoId, state: input.state,
						...(input.steering === undefined ? {} : { steering: input.steering }),
						...(input.planningHash === undefined ? {} : { planning_hash: input.planningHash }),
					}, 0); // Validation only; all persisted/returned timestamps come from PostgreSQL.
					if (!next.ok) return unavailable();
					const session = steeringSessionWithoutSecrets(next.session);
					const result = await sql.begin(async (tx) => {
						const rows: Array<Record<string, unknown>> = await tx`
							with stamp as (select clock_timestamp() as now)
							insert into live_session_bindings
								(session_id, owner_surface, repo_id, binding_proof_hash, issued_at, last_seen_at, expires_at, updated_at, state, steering, planning_hash)
							select ${sessionId}, ${input.caller.surface}, ${session.repo_id}, ${proofHash},
								now, now, now + ${options.leaseSeconds} * interval '1 second', now,
								${session.state}, ${session.steering ?? null}, ${session.planning_hash ?? null} from stamp
							on conflict (session_id) do nothing
							returning session_id, owner_surface, repo_id, issued_at, expires_at, updated_at, state, steering, planning_hash`;
						return rows[0] === undefined ? null : snapshotOf(rows[0]);
					});
					// begin resolves only after commit; a lost commit response cannot return a credential.
					if (result !== null) return { ok: true, snapshot: result, sessionBinding };
				}
				return unavailable();
			} catch {
				return unavailable();
			}
		},
		async read(access, operation) {
			try {
				if (!validLease) return unavailable();
				return await sql.begin(async (tx): Promise<LiveSessionResult> => {
					const held = await locked(tx, access, operation);
					return "ok" in held ? held : { ok: true, snapshot: held.snapshot };
				});
			} catch {
				return unavailable();
			}
		},
		async transition(access, input, operation) {
			try {
				if (!validLease) return unavailable();
				// A read/queue operation must never be repurposed to mutate canonical state.
				if (operation !== "owner-transition" && operation !== "operator-ack") return notFound();
				if (operation === "operator-ack" && !access.caller.isOperator) return notFound();
				return await sql.begin(async (tx): Promise<LiveSessionTransitionResult> => {
					const held = await locked(tx, access, operation);
					if ("ok" in held) return held;
					const current = held.snapshot.session;
					if (input.repoId !== current.repo_id) return notFound();
					if (!isState(input.state) || (input.previousState !== undefined && input.previousState !== current.state)) {
						return { ok: false, error: { code: "invalid-transition", reason: "state precondition refused" } };
					}
					const steering = input.steering ?? current.steering;
					const planningHash = input.planningHash ?? current.planning_hash;
					const next = nextSteeringSession(current, {
						session_id: access.sessionId, repo_id: current.repo_id, state: input.state,
						...(steering === undefined ? {} : { steering }),
						...(planningHash === undefined ? {} : { planning_hash: planningHash }),
					}, Date.parse(held.now));
					if (!next.ok) return { ok: false, error: { code: "invalid-transition", reason: next.reason } };
					const session = steeringSessionWithoutSecrets(next.session);
					const renew = operation === "owner-transition";
					const rows: Array<Record<string, unknown>> = await tx`
						update live_session_bindings set state = ${session.state}, steering = ${session.steering ?? null},
							planning_hash = ${session.planning_hash ?? null}, updated_at = ${held.now}::timestamptz,
							last_seen_at = case when ${renew} then ${held.now}::timestamptz else last_seen_at end,
							expires_at = case when ${renew} then ${held.now}::timestamptz + ${options.leaseSeconds} * interval '1 second' else expires_at end
						where session_id = ${access.sessionId}
						returning session_id, owner_surface, repo_id, issued_at, expires_at, updated_at, state, steering, planning_hash`;
					if (!rows[0]) throw new Error("missing updated row");
					return { ok: true, snapshot: snapshotOf(rows[0]), ...(next.previous === undefined ? {} : { previous: next.previous }) };
				});
			} catch {
				return unavailable();
			}
		},
		async heartbeat(access) {
			try {
				if (!validLease) return unavailable();
				return await sql.begin(async (tx): Promise<LiveSessionResult> => {
					const held = await locked(tx, access, "heartbeat");
					if ("ok" in held) return held;
					const rows: Array<Record<string, unknown>> = await tx`
						update live_session_bindings set last_seen_at = ${held.now}::timestamptz,
							expires_at = ${held.now}::timestamptz + ${options.leaseSeconds} * interval '1 second'
						where session_id = ${access.sessionId}
						returning session_id, owner_surface, repo_id, issued_at, expires_at, updated_at, state, steering, planning_hash`;
					if (!rows[0]) throw new Error("missing heartbeat row");
					return { ok: true, snapshot: snapshotOf(rows[0]) };
				});
			} catch {
				return unavailable();
			}
		},
		async close(access) {
			try {
				if (!validLease) return unavailable();
				return await sql.begin(async (tx): Promise<LiveSessionCloseResult> => {
					const held = await locked(tx, access, "close");
					if ("ok" in held) return held;
					const rows: Array<{ closed_at: string | Date }> = await tx`
						update live_session_bindings set closed_at = ${held.now}::timestamptz, close_reason = 'closed',
							steering = null, planning_hash = null
						where session_id = ${access.sessionId} returning closed_at`;
					if (!rows[0]) throw new Error("missing closed row");
					return { ok: true, snapshot: { ...held.snapshot, session: {
						session_id: held.snapshot.session.session_id, repo_id: held.snapshot.session.repo_id,
						state: held.snapshot.session.state, updated_at: held.snapshot.session.updated_at,
					} }, closedAt: new Date(rows[0].closed_at).toISOString() };
				});
			} catch {
				return unavailable();
			}
		},
		listVisible: (caller, query) => listing(caller, query),
		listMetadata: (query) => listing(null, query),
	};
}
