/**
 * Test helpers for the session commands: an in-memory server that speaks the client contract, a seeded
 * random-bytes source, a scripted transcript port and a fetch that serves the in-memory server over the
 * JSON-RPC wire format. Imported only by tests.
 */
import { createHash } from "node:crypto";
import type { RandomBytes, RollbackTranscriptOutcome } from "../../../mcp-server/src/session-events.ts";
import { seeded } from "../../../worktree-snapshot/src/testkit.ts";
import type {
	AnchorStatus,
	ClientFailure,
	CommitRollbackOk,
	CommitRollbackRequest,
	PlanRollbackRequest,
	PlanRollbackResult,
	RecordCheckpointOk,
	RecordCheckpointRequest,
	RollbackPlan,
	RollbackServerClient,
	ClientResult,
	FetchLike,
} from "./client.ts";
import type { TranscriptPort, TranscriptRewindRequest, TranscriptRewindResult } from "./rollback.ts";

/** Reproducible random bytes: the same seed always mints the same ckpt and rollback ids. */
export function seededRandomBytes(seed: number): RandomBytes {
	const next = seeded(seed);
	return (length) => Uint8Array.from({ length }, () => Math.floor(next() * 256));
}

export function failure(code: string, message: string, retryable: boolean): ClientFailure {
	return { ok: false, error: { code, message, retryable } };
}

const ZERO_HASH = "0".repeat(64);

/**
 * A server that holds checkpoints and commits in memory. `down` makes every call fail as an unreachable
 * server would; `staleCommits` answers that many committed commits with `stale-plan` (each changes the
 * digest, as a real change to the plan would); `calls` is the ordered log of what was asked.
 */
export class FakeServer implements RollbackServerClient {
	down = false;
	unauthorized = false;
	anchorStatus: AnchorStatus | null = "anchored";
	/** The reasons the plan carries with a non-anchored status; the default names the status. */
	anchorReasons: string[] | null = null;
	staleCommits = 0;
	salt = 0;
	/** Set to fail commits (not plans) as an unreachable server would. */
	downForCommits = false;
	readonly calls: string[] = [];
	/** Every plan request, in order, as the client sent it. */
	readonly planRequests: PlanRollbackRequest[] = [];
	/** The code a plan for an unknown checkpoint answers with: the real server says `not-found`, an older fake said `target-not-found`. */
	notFoundCode = "target-not-found";
	readonly checkpoints = new Map<string, RecordCheckpointRequest & { event_id: string }>();
	readonly commits = new Map<string, CommitRollbackRequest & { event_id: string }>();
	readonly refusals: CommitRollbackRequest[] = [];
	/** First-time deliveries only: a replay of something already held does not count. */
	readonly deliveries = { checkpoint: 0, commit: 0 };
	private events = 0;

	private event(): string {
		this.events++;
		return `evt_${this.events}`;
	}

	async recordCheckpoint(request: RecordCheckpointRequest): Promise<ClientResult<RecordCheckpointOk>> {
		this.calls.push(`record:${request.ckpt_id}`);
		if (this.down) return failure("network", "connection refused", true);
		if (this.unauthorized) return failure("unauthorized", "HTTP 401", false);
		const held = this.checkpoints.get(request.ckpt_id);
		if (held !== undefined) return { ok: true, value: { ckpt_id: request.ckpt_id, event_id: held.event_id, stored: false } };
		const event_id = this.event();
		this.checkpoints.set(request.ckpt_id, { ...request, event_id });
		this.deliveries.checkpoint++;
		return { ok: true, value: { ckpt_id: request.ckpt_id, event_id, stored: true } };
	}

	private laterOf(target: string, session: string): Array<{ ckpt_id: string; seq: number }> {
		const base = this.checkpoints.get(target);
		if (base === undefined) return [];
		return [...this.checkpoints.values()]
			.filter((entry) => entry.session_id === session && entry.seq > base.seq)
			.sort((a, b) => a.seq - b.seq)
			.map((entry) => ({ ckpt_id: entry.ckpt_id, seq: entry.seq }));
	}

	/**
	 * The plan digest covers the checkpoints the rollback supersedes, not the pre-restore checkpoint the
	 * client takes between the plan and the commit (otherwise every rollback would be answered stale-plan once).
	 */
	private digest(target: string, session: string): string {
		const later = this.laterOf(target, session)
			.filter((entry) => this.checkpoints.get(entry.ckpt_id)?.trigger !== "pre-restore")
			.map((entry) => entry.ckpt_id);
		return createHash("sha256").update(JSON.stringify({ target, later, salt: this.salt })).digest("hex");
	}

	async planRollback(request: PlanRollbackRequest): Promise<PlanRollbackResult> {
		this.calls.push(`plan:${request.target_ckpt_id}`);
		this.planRequests.push({ ...request });
		if (this.down) return failure("network", "connection refused", true);
		if (this.unauthorized) return failure("unauthorized", "HTTP 401", false);
		const target = this.checkpoints.get(request.target_ckpt_id);
		if (target === undefined || target.session_id !== request.session_id) {
			return failure(this.notFoundCode, "no such checkpoint for this session", false);
		}
		const plan: RollbackPlan = {
			rollback_id: request.rollback_id ?? `rb_${"0".repeat(26)}`,
			session_id: request.session_id,
			target: {
				ckpt_id: target.ckpt_id,
				seq: target.seq,
				event_id: target.event_id,
				event_hash: ZERO_HASH,
				git_tree: target.git_tree,
				manifest_sha256: target.manifest_sha256,
				...(target.transcript_ref === undefined ? {} : { transcript_ref: target.transcript_ref }),
			},
			later_checkpoints: this.laterOf(target.ckpt_id, request.session_id),
			anchor: this.anchorStatus === null ? null : { status: this.anchorStatus, reasons: this.anchorReasons ?? (this.anchorStatus === "anchored" ? [] : [`status ${this.anchorStatus}`]) },
			memory: { would_forget: 2, sample_ids: ["mem_a", "mem_b"], truncated: false },
			plan_digest: this.digest(target.ckpt_id, request.session_id),
		};
		return { ok: true, value: { plan } };
	}

	/** How many more commit answers (a first delivery or a replay of a held commit) report `plane_pending: true`, as a server whose Hindsight deletes keep failing does. */
	planePendingReplies = 0;

	private takePlanePending(): boolean {
		if (this.planePendingReplies <= 0) return false;
		this.planePendingReplies--;
		return true;
	}

	async commitRollback(request: CommitRollbackRequest): Promise<ClientResult<CommitRollbackOk>> {
		this.calls.push(`commit:${request.rollback_id}:${request.outcome}`);
		if (this.down || this.downForCommits) return failure("network", "connection refused", true);
		if (this.unauthorized) return failure("unauthorized", "HTTP 401", false);
		if (request.outcome === "refused") {
			this.refusals.push(request);
			return { ok: true, value: { event_id: this.event() } };
		}
		const held = this.commits.get(request.rollback_id);
		if (held !== undefined) return { ok: true, value: { event_id: held.event_id, memory: { superseded_entries: 0, forgotten_documents: 0, plane_pending: this.takePlanePending(), truncated: false } } };
		if (this.staleCommits > 0) {
			this.staleCommits--;
			this.salt++;
			return failure("stale-plan", "the plan changed", false);
		}
		if (request.plan_digest !== this.digest(request.target_ckpt_id, request.session_id)) return failure("stale-plan", "the plan changed", false);
		const event_id = this.event();
		this.commits.set(request.rollback_id, { ...request, event_id });
		this.deliveries.commit++;
		return {
			ok: true,
			value: { event_id, memory: { superseded_entries: this.laterOf(request.target_ckpt_id, request.session_id).length, forgotten_documents: 1, plane_pending: this.takePlanePending(), truncated: false } },
		};
	}
}

/** A transcript port that answers a fixed outcome and logs its requests. */
export class FakeTranscript implements TranscriptPort {
	readonly requests: TranscriptRewindRequest[] = [];
	outcome: RollbackTranscriptOutcome = "marker-only";
	throws = false;

	async rewind(request: TranscriptRewindRequest): Promise<TranscriptRewindResult> {
		this.requests.push(request);
		if (this.throws) throw new Error("the adapter exploded");
		return { outcome: this.outcome };
	}
}

/** What a `fetchFor` fetch saw, for assertions on the bearer and the tools called. */
export interface FetchLog {
	authorization: Array<string | undefined>;
	tools: string[];
}

/**
 * A fetch that speaks the server's wire format over a `FakeServer`: an unreachable server (`network`)
 * throws like a failed connection, `unauthorized` is an HTTP 401, anything else is an `{ok:false}` tool answer.
 */
export function fetchFor(server: FakeServer, log?: FetchLog): FetchLike {
	return async (_url, init) => {
		const call = JSON.parse(init.body) as { params: { name: string; arguments: Record<string, unknown> } };
		const { name, arguments: args } = call.params;
		log?.authorization.push(init.headers.authorization);
		log?.tools.push(name);
		let result: ClientResult<object>;
		if (name === "session_checkpoint") result = await server.recordCheckpoint(args as unknown as RecordCheckpointRequest);
		else if (name === "session_rollback_plan") result = await server.planRollback(args as unknown as PlanRollbackRequest);
		else result = await server.commitRollback(args as unknown as CommitRollbackRequest);
		let payload: object;
		if (result.ok) {
			payload = { ok: true, ...result.value };
		} else if (result.error.code === "network") {
			throw new TypeError("fetch failed");
		} else if (result.error.code === "unauthorized") {
			return new Response("unauthorized", { status: 401 });
		} else {
			payload = { ok: false, error: { code: result.error.code, message: result.error.message } };
		}
		const body = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } };
		return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
	};
}
