// Task state and the openTask contract (D-06, D-08, D-13). No rivet import: every collaborator
// (substrate client, VM handle factory, model-route hook, store) arrives through the constructor,
// so tasks.test.ts drives TaskService with fakes.
//
// One task = one node of one graph = one Claude Code session in the graph's VM, session id = node
// id. The record on disk is what survives a host restart; the live session state is read from the
// VM on every status call and folded into exit_code by the pure pollCode.

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Route, sessionEnv, SUBSTRATE_RELAY_URL, type TestsRoute, trackerRoute, worktreeFor } from "./options.ts";
import { isValidGraphId } from "./sandbox-options.ts";
import {
	ADDITIONAL_INSTRUCTIONS,
	isValidIdentifier,
	isValidNodeId,
	isValidRepoSlug,
	renderPrompt,
	type Skill,
	seedFiles,
	type TrackerLocators,
	VM_WORK,
} from "./seed.ts";
import {
	type ClaimReply,
	type CompleteReply,
	type Dod,
	type GraphNodeView,
	type GraphView,
	HEARTBEAT_INTERVAL_MS,
	type HeartbeatReply,
	heartbeatDue,
	HOST_SURFACE,
	type LeaseStoreLike,
} from "./substrate.ts";

export type PendingApproval = { request_id: string; tool: string; at: string; deadlineMs?: number };
/** Default approval deadline (D33-05): 900 s, the same ladder as the lease TTL and the claim timeout. */
export const APPROVAL_TIMEOUT_MS = 900_000;

/**
 * SUBSTRATE_APPROVAL_TIMEOUT_S in seconds (D33-05); malformed values fall back to the
 * default. Pure for tests — main.ts wires process.env through it.
 */
export function parseApprovalTimeoutMs(raw: string | undefined, log?: (line: string) => void): number {
	const seconds = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
	if (!Number.isFinite(seconds) || seconds <= 0) {
		if (raw !== undefined && raw.trim() !== "") log?.(`[substrate-host] invalid SUBSTRATE_APPROVAL_TIMEOUT_S ${raw}: using default 900 s`);
		return APPROVAL_TIMEOUT_MS;
	}
	return Math.floor(seconds * 1000);
}

export type SeededFile = { path: string; sha256: string; bytes: number };

export type TaskRecord = {
	graph_id: string;
	node_id: string;
	identifier: string;
	repo: string;
	session_id: string;
	prompt_count: number;
	turn_in_flight: boolean;
	last_stop_reason: string | null;
	exit_code: number | null;
	released: boolean;
	pending_approvals: PendingApproval[];
	opened_at: string;
	last_error: string | null;
	seeded: SeededFile[];
	/** D-07: continuation prompts sent after host restarts; the next key is `<gid>:<nid>:resume:<resumes + 1>`. */
	resumes: number;
	/** Approval requests that died with an interrupted turn (count only; they can never be answered). */
	stale_approvals: number;
	/** 03-07: set once by the host's own pr-create (T-03-07-04/05); null until a PR is opened. */
	pr_url: string | null;
	pr_number: number | null;
	/** D-10: when the PR fields reached the trackers and who wrote them (T-03-07-06). */
	synced_at: string | null;
	sync_by: SyncBy | null;
	/** D-13: taps that answered allow_once. Old records read as 0. */
	approvals_allowed: number;
	/** D-13: taps that answered reject_once. Old records read as 0. */
	approvals_denied: number;
};

/** model: the sync host function; model_mcp: in-VM ultrathink-sync verified read-only; host: the turn-settle backstop. */
export type SyncBy = "model" | "model_mcp" | "host";

/**
 * Records written by earlier plans lack later fields: resume counters read as 0 (T-03-06-01: the
 * key must stay numeric), PR and sync fields as null.
 */
export function withRecordDefaults(record: TaskRecord): TaskRecord {
	record.resumes = Number.isInteger(record.resumes) ? record.resumes : 0;
	record.stale_approvals = Number.isInteger(record.stale_approvals) ? record.stale_approvals : 0;
	record.pr_url = typeof record.pr_url === "string" ? record.pr_url : null;
	record.pr_number = Number.isInteger(record.pr_number) ? record.pr_number : null;
	record.synced_at = typeof record.synced_at === "string" ? record.synced_at : null;
	record.sync_by = record.sync_by === "model" || record.sync_by === "model_mcp" || record.sync_by === "host" ? record.sync_by : null;
	record.approvals_allowed = Number.isInteger(record.approvals_allowed) ? record.approvals_allowed : 0;
	record.approvals_denied = Number.isInteger(record.approvals_denied) ? record.approvals_denied : 0;
	return record;
}

/** D-07: the tasks whose turn a host restart cut short — in flight, still claimed, not finished. */
export function interruptedTasks(records: readonly TaskRecord[]): TaskRecord[] {
	return records.filter((r) => r.turn_in_flight && !r.released && r.exit_code === null);
}

/** The continuation prompt (D-07): the model resumes from the worktree and its first prompt's steps. */
export const RESUME_TEXT =
	"substrate-host restarted during your last turn. Continue the same task from the files in /home/agentos/work and the numbered steps of your first prompt; do not repeat steps that already succeeded.";

export type OpenRequest = { graph_id: string; node_id: string; identifier: string; repo: string; worktree: string };

export type SessionStatus = "idle" | "running" | "waiting" | "failed";

/**
 * The dispatcher's poll(): null while the turn runs or waits on an approval, 0 after a clean
 * end_turn, 1 for every other outcome (another stop reason, a failed session, a failed prompt).
 */
export function pollCode(
	record: Pick<TaskRecord, "turn_in_flight" | "last_stop_reason" | "last_error">,
	sessionState?: string | null,
): 0 | 1 | null {
	if (record.last_error) return 1;
	if (sessionState === "failed") return 1;
	if (record.turn_in_flight) return null;
	if (sessionState === "running" || sessionState === "waiting") return null;
	if (record.last_stop_reason === null || record.last_stop_reason === undefined) return null;
	return record.last_stop_reason === "end_turn" ? 0 : 1;
}

export type Validation = { ok: true; request: OpenRequest } | { ok: false; error: string };

/** POST /tasks body: every id checked with the dispatcher's patterns, worktree pinned to the graph's. */
export function validateOpenRequest(body: unknown): Validation {
	if (typeof body !== "object" || body === null) return { ok: false, error: "body must be a JSON object" };
	const b = body as Record<string, unknown>;
	if (!isValidGraphId(b.graph_id)) return { ok: false, error: "graph_id is missing or invalid" };
	if (!isValidNodeId(b.node_id)) return { ok: false, error: "node_id is missing or invalid" };
	if (!isValidIdentifier(b.identifier)) return { ok: false, error: "identifier is missing or invalid" };
	if (!isValidRepoSlug(b.repo)) return { ok: false, error: "repo is missing or invalid" };
	const worktree = worktreeFor(b.graph_id);
	if (b.worktree !== worktree) return { ok: false, error: `worktree must be ${worktree}` };
	return {
		ok: true,
		request: { graph_id: b.graph_id, node_id: b.node_id, identifier: b.identifier, repo: b.repo, worktree },
	};
}

export type HostCallTarget = { graphId: string; nodeId: string; sessionId: string } | { error: string };

/**
 * The one guard every VM host function runs first (T-03-03-02): the graph comes from the actor
 * key, the claim session from the task record, and the guest may only name a node of its own
 * graph. A guest --graph or --session is refused before anything is looked up.
 */
export function hostCallTarget(
	actorKey: readonly unknown[],
	argv: readonly string[],
	lookup: (graphId: string, nodeId: string) => Pick<TaskRecord, "session_id"> | null | undefined,
): HostCallTarget {
	const graphId = actorKey[0];
	if (!isValidGraphId(graphId)) return { error: "actor key does not name a valid graph id" };
	let nodeId: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--graph" || arg?.startsWith("--graph=") || arg === "--session" || arg?.startsWith("--session=")) {
			return { error: "graph and session are fixed by the host; only --node may be given" };
		}
		if (arg === "--node") {
			nodeId = argv[i + 1];
			i++;
		} else if (arg?.startsWith("--node=")) {
			nodeId = arg.slice("--node=".length);
		}
	}
	if (!isValidNodeId(nodeId)) return { error: "--node is missing or invalid" };
	const record = lookup(graphId, nodeId);
	if (!record) return { error: `no task for node ${nodeId} in this VM` };
	return { graphId, nodeId, sessionId: record.session_id };
}

export type TaskStoreLike = {
	get(graphId: string, nodeId: string): TaskRecord | null;
	save(record: TaskRecord): void;
	list(): TaskRecord[];
};

/** One JSON file per task under <dir>/<gid>--<nid>.json, mode 0600, written via temp + rename. */
export class TaskStore implements TaskStoreLike {
	dir: string;

	constructor(dir: string) {
		this.dir = dir;
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}

	path(graphId: string, nodeId: string): string {
		if (!isValidGraphId(graphId) || !isValidNodeId(nodeId)) throw new Error("invalid task key");
		return join(this.dir, `${graphId}--${nodeId}.json`);
	}

	get(graphId: string, nodeId: string): TaskRecord | null {
		try {
			return withRecordDefaults(JSON.parse(readFileSync(this.path(graphId, nodeId), "utf8")) as TaskRecord);
		} catch (cause) {
			if ((cause as { code?: unknown }).code === "ENOENT") return null;
			throw cause;
		}
	}

	save(record: TaskRecord): void {
		const target = this.path(record.graph_id, record.node_id);
		const tmp = `${target}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
		try {
			renameSync(tmp, target);
		} catch (cause) {
			rmSync(tmp, { force: true });
			throw cause;
		}
	}

	list(): TaskRecord[] {
		const records: TaskRecord[] = [];
		for (const name of readdirSync(this.dir).sort()) {
			if (!name.endsWith(".json")) continue;
			records.push(withRecordDefaults(JSON.parse(readFileSync(join(this.dir, name), "utf8")) as TaskRecord));
		}
		return records;
	}
}

/** In-memory store for tests and for hosts that prefer not to persist (never the production unit). */
export class MemoryTaskStore implements TaskStoreLike {
	records: Map<string, TaskRecord>;

	constructor() {
		this.records = new Map();
	}

	get(graphId: string, nodeId: string): TaskRecord | null {
		return this.records.get(`${graphId}--${nodeId}`) ?? null;
	}

	save(record: TaskRecord): void {
		this.records.set(`${record.graph_id}--${record.node_id}`, record);
	}

	list(): TaskRecord[] {
		return [...this.records.values()];
	}
}

/** The slice of a rivet VM handle TaskService drives; vm.ts's client handle satisfies it. */
export type VmHandle = {
	filesystem: {
		mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
		writeFile(path: string, content: string | Uint8Array): Promise<void>;
		readFile(path: string): Promise<Uint8Array>;
	};
	sessions: {
		open(input: {
			sessionId: string;
			agent: string;
			cwd: string;
			env: Record<string, string>;
			mcpServers: Array<{ type: "http"; name: string; url: string; headers: Array<{ name: string; value: string }> }>;
			permissionPolicy: "ask";
			additionalInstructions: string;
		}): Promise<void>;
		prompt(input: {
			sessionId: string;
			idempotencyKey: string;
			content: Array<{ type: "text"; text: string }>;
		}): Promise<{ stopReason: string }>;
		get(input: { sessionId: string }): Promise<{ state: { status: string }; latestSequence: number }>;
		readHistory(input: { sessionId: string }): Promise<{ events: unknown[] }>;
		cancelPrompt(input: { sessionId: string }): Promise<unknown>;
		unload(input: { sessionId: string }): Promise<void>;
	};
	/** The only answer path (D-13). vm.ts never calls this; the broker does, through TaskService. */
	respondPermission(input: { sessionId: string; requestId: string; optionId: string }): Promise<{ status: "accepted" | "not_pending" }>;
};

export type SubstrateLike = {
	graphGet(graphId: string): Promise<GraphView | null>;
	graphClaim(graphId: string, nodeId: string, surface: string, sessionId: string): Promise<{ claimed: boolean; reason?: string }>;
	claimAndPersist(
		store: LeaseStoreLike,
		graphId: string,
		nodeId: string,
		surface: string,
		sessionId: string,
		nowMs?: number,
	): Promise<ClaimReply>;
	heartbeat(graphId: string, nodeId: string, leaseId: string, ttlSeconds?: number): Promise<HeartbeatReply>;
	graphComplete(graphId: string, nodeId: string, leaseId: string | null, dod: Dod): Promise<CompleteReply>;
	/**
	 * Fenced release (I-02): the persisted `lease_id` or null. The reply's
	 * `released` flag is the truth — a refusal never marks the record released.
	 */
	graphRelease(graphId: string, nodeId: string, leaseId: string | null): Promise<{ released: boolean; reason?: string }>;
	brief(graphId: string, repo: string): Promise<string>;
};
/** The slice of sync.ts's HostSync the turn-settle backstop drives. */
export type HostSyncLike = {
	syncPr(input: {
		graphId: string;
		nodeId: string;
		prUrl: string;
		prNumber: number;
		repo: string;
		branch: string;
		node: Pick<GraphNodeView, "linear_issue_id" | "linear_identifier">;
	}): Promise<{ notion: string; linear: string }>;
	verifyModelSync(input: {
		graphId: string;
		node: Pick<GraphNodeView, "linear_issue_id" | "linear_identifier">;
		prUrl: string;
	}): Promise<{ notion: boolean; linear: boolean }>;
};

export type TaskServiceDeps = {
	substrate: SubstrateLike;
	/** vm.getOrCreate([graphId]) — one VM per graph (D-06). */
	vmFor: (graphId: string) => VmHandle;
	store: TaskStoreLike;
	/** The lease files beside the task records (D32-04); `main.ts` roots it at the unit's storage dir. */
	leases: LeaseStoreLike;
	/** Awaited before sessions.open and before every prompt (T-03-03-09). */
	ensureModelRoute: (handle: VmHandle, graphId: string) => Promise<void>;
	/** Awaited beside the model route on s:mcp (starts the in-VM substrate relay; no-op elsewhere). */
	ensureSubstrateRoute: (handle: VmHandle, graphId: string) => Promise<void>;
	route: Route;
	testsRoute: TestsRoute;
	model: string;
	directKey?: string;
	skills: Skill[];
	trackers: TrackerLocators;
	/** D-10 backstop; absent means no tracker sync on this host. */
	sync?: HostSyncLike;
	log?: (line: string) => void;
	now?: () => Date;
	/** Heartbeat tick period in ms; the half-TTL default stands in production, tests inject short values. */
	heartbeatIntervalMs?: number;
	/** Approval deadline in ms; the 900 s default stands in production, tests inject short values. */
	approvalTimeoutMs?: number;
};

/** The DoD summary cap, matching the `graph_complete` tool schema. */
export const DOD_SUMMARY_MAX = 2000;

/** One heartbeat-or-reclaim tick's outcome (D32-02). */
export type HeartbeatTick = "ok" | "not-due" | "reclaimed" | "failed-closed" | "idle";

/**
 * Whether a task still holds guest mutation authority (SEC03): host-credentialed
 * callbacks (commit/push/PR/sync/complete/run-tests) run only for live tasks. A
 * released task is terminal; a settled-but-unreleased task failed. Terminal release
 * transitions themselves (release/terminate/kill) are exempt — they end authority,
 * they do not spend it. Pure so every host-function boundary shares one rule.
 */
export function mutationRefusal(record: Pick<TaskRecord, "released" | "exit_code"> | null | undefined): "released" | "failed" | null {
	if (!record) return null;
	if (record.released) return "released";
	if (record.exit_code !== null) return "failed";
	return null;
}


export type CompleteInput = { summary: string; tests_pass: boolean; review_pass?: boolean };
export type CompleteResult = { completed: boolean; reason?: string };

export type TaskStatus = TaskRecord & {
	state: string;
	latest_sequence: number | null;
	history_events: number | null;
};

export type OpenResult = { status: 200 | 202 | 400 | 409 | 502; body: TaskStatus | { error: string } };

function sha256(content: string | Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

export class TaskService {
	deps: TaskServiceDeps;
	log: (line: string) => void;
	now: () => Date;
	/** In-flight turns by `<gid>/<nid>`: the promise settles once the record reflects the prompt's outcome. */
	turns: Map<string, Promise<void>>;
	/** Heartbeat tick timers by `<gid>/<nid>`, armed while a turn runs (D32-02); cleared on every settle path. */
	heartbeats: Map<string, NodeJS.Timeout>;
	/** resumeInterrupted runs once per host process (D-07). */
	resumedThisBoot: boolean;
	/** Set by beginShutdown: prompt rejections after this point are the shutdown's, not the turn's. */
	stopping: boolean;

	constructor(deps: TaskServiceDeps) {
		this.deps = deps;
		this.log = deps.log ?? ((line) => process.stdout.write(`${line}\n`));
		this.now = deps.now ?? (() => new Date());
		this.turns = new Map();
		this.heartbeats = new Map();
		this.resumedThisBoot = false;
		this.stopping = false;
	}

	/**
	 * Called from the SIGTERM handler before the registry shuts down: an in-flight prompt that the
	 * shutdown rejects (sidecar exit, lost websocket) must keep its record in flight, or the next
	 * boot would never send its continuation (D-07). Heartbeat ticks stop: the dead process must
	 * not extend a lease the next boot re-claims (T-32-01a).
	 */
	beginShutdown(): void {
		this.stopping = true;
		for (const timer of this.heartbeats.values()) clearInterval(timer);
		this.heartbeats.clear();
	}

	/**
	 * The single release path (D32-03, I-02): every terminal state funnels here, and the
	 * record's `released` flag makes a second call a no-op. Fenced on the persisted
	 * `lease_id`; the reply's `released` flag is the truth — a refusal or transport
	 * error never marks the record released. Never throws.
	 */
	async releaseOnce(graphId: string, nodeId: string): Promise<void> {
		const key = `${graphId}/${nodeId}`;
		const record = this.deps.store.get(graphId, nodeId);
		if (record?.released) return;
		const leaseId = this.deps.leases.load(graphId, nodeId)?.lease_id ?? null;
		let reply: { released: boolean; reason?: string };
		try {
			reply = await this.deps.substrate.graphRelease(graphId, nodeId, leaseId);
		} catch (cause) {
			this.log(`[substrate-host] release ${key} failed: ${String(cause)}`);
			return;
		}
		if (!reply.released) {
			this.log(`[substrate-host] release ${key} refused: ${reply.reason ?? "refused"}`);
			return;
		}
		if (record) {
			this.update(graphId, nodeId, (r) => {
				r.released = true;
			});
		}
	}

	/** Arm the heartbeat tick for a running turn; an armed tick is replaced, never doubled. */
	private startHeartbeat(graphId: string, nodeId: string): void {
		const key = `${graphId}/${nodeId}`;
		this.clearHeartbeat(graphId, nodeId);
		const timer = setInterval(() => {
			void this.heartbeatTick(graphId, nodeId);
		}, this.deps.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
		timer.unref?.();
		this.heartbeats.set(key, timer);
	}

	/** Clear one task's tick; idempotent, so every settle path calls it unconditionally. */
	private clearHeartbeat(graphId: string, nodeId: string): void {
		const key = `${graphId}/${nodeId}`;
		const timer = this.heartbeats.get(key);
		if (timer !== undefined) {
			clearInterval(timer);
			this.heartbeats.delete(key);
		}
	}

	/** Whether a tick is armed for this task (lifecycle introspection for tests and the resume path). */
	heartbeatArmed(graphId: string, nodeId: string): boolean {
		return this.heartbeats.has(`${graphId}/${nodeId}`);
	}

	/**
	 * Heartbeat-or-reclaim shared by the tick and the resume path (D32-02/D32-06): a due
	 * heartbeat goes out fenced on the persisted `lease_id`; a refusal — or a missing lease
	 * file — triggers exactly one `claimAndPersist` re-claim, never an extension, never a loop.
	 */
	private async heartbeatOrReclaim(graphId: string, nodeId: string, sessionId: string): Promise<"ok" | "not-due" | "reclaimed" | "failed"> {
		const key = `${graphId}/${nodeId}`;
		const nowMs = this.now().getTime();
		const lease = this.deps.leases.load(graphId, nodeId);
		if (lease && !heartbeatDue(lease, nowMs)) return "not-due";
		if (lease) {
			let beat: { ok: boolean; reason?: string };
			try {
				beat = await this.deps.substrate.heartbeat(graphId, nodeId, lease.lease_id, lease.ttlSeconds);
			} catch (cause) {
				beat = { ok: false, reason: String(cause) };
			}
			if (beat.ok) {
				this.log(`[substrate-host] heartbeat ok ${key}`);
				return "ok";
			}
			this.log(`[substrate-host] heartbeat refused ${key}: ${beat.reason ?? "refused"} — re-claiming once`);
		}
		let reclaim: { claimed: boolean; reason?: string };
		try {
			reclaim = await this.deps.substrate.claimAndPersist(this.deps.leases, graphId, nodeId, HOST_SURFACE, sessionId, nowMs);
		} catch (cause) {
			this.log(`[substrate-host] re-claim failed ${key}: ${String(cause)}`);
			return "failed";
		}
		if (reclaim.claimed && this.deps.leases.load(graphId, nodeId)) {
			this.log(`[substrate-host] lease re-claimed for ${key}: yes`);
			return "reclaimed";
		}
		this.log(`[substrate-host] re-claim refused ${key}: ${reclaim.reason ?? "refused"}`);
		return "failed";
	}

	/**
	 * One tick for a running turn: idle when the turn already ended, fail-closed (mark failed
	 * + single release) when the lease is gone and the one re-claim refused.
	 */
	async heartbeatTick(graphId: string, nodeId: string): Promise<HeartbeatTick> {
		const key = `${graphId}/${nodeId}`;
		const record = this.deps.store.get(graphId, nodeId);
		if (!record || !record.turn_in_flight || record.released || record.exit_code !== null) return "idle";
		// Both are "while the turn runs" duties: an untapped approval auto-denies fail-closed
		// here even when no heartbeat is due, so a parked waiting turn never waits forever.
		await this.sweepApprovalTimeouts(graphId, nodeId);
		const outcome = await this.heartbeatOrReclaim(graphId, nodeId, record.session_id);
		if (outcome !== "failed") return outcome;
		this.clearHeartbeat(graphId, nodeId);
		this.update(graphId, nodeId, (r) => {
			r.turn_in_flight = false;
			r.last_error = "lease lost";
			r.exit_code = 1;
		});
		await this.releaseOnce(graphId, nodeId);
		// SEC03: the stale guest must stop now, not on prompt settlement. Authority is
		// already revoked synchronously above (a failed record refuses every mutation);
		// cancel + unload stop the actual session best-effort. Either failing leaves the
		// record failed — cancellation delay/failure never restores authority.
		const failed = this.deps.store.get(graphId, nodeId);
		if (failed) {
			const handle = this.deps.vmFor(graphId);
			await handle.sessions.cancelPrompt({ sessionId: failed.session_id }).catch((cause: unknown) => {
				this.log(`[substrate-host] lease-loss cancel ${key} failed: ${String(cause)}`);
			});
			await handle.sessions.unload({ sessionId: failed.session_id }).catch((cause: unknown) => {
				this.log(`[substrate-host] lease-loss unload ${key} failed: ${String(cause)}`);
			});
		}
		this.log(`[substrate-host] turn failed ${key}: lease lost`);
		return "failed-closed";
	}

	/**
	 * Complete the node through the DoD gate with the persisted `lease_id` (D32-03): the
	 * server drops the lease on success, so the record is marked released and no later path
	 * re-releases it. A released record completes nothing — the guard is the double-release
	 * protection, not an error.
	 */
	async complete(graphId: string, nodeId: string, input: CompleteInput): Promise<CompleteResult> {
		const key = `${graphId}/${nodeId}`;
		const record = this.deps.store.get(graphId, nodeId);
		if (!record) return { completed: false, reason: "unknown task" };
		if (record.released) return { completed: false, reason: "already released" };
		if (record.exit_code !== null) return { completed: false, reason: "task failed" };
		const summary = input.summary.trim().slice(0, DOD_SUMMARY_MAX);
		if (summary === "") return { completed: false, reason: "dod-required" };
		const dod: Dod = {
			summary,
			tests_pass: input.tests_pass,
			...(input.review_pass !== undefined ? { review_pass: input.review_pass } : {}),
		};
		const lease = this.deps.leases.load(graphId, nodeId);
		let reply: { completed: boolean; reason?: string };
		try {
			reply = await this.deps.substrate.graphComplete(graphId, nodeId, lease?.lease_id ?? null, dod);
		} catch (cause) {
			return { completed: false, reason: String(cause) };
		}
		if (!reply.completed) return { completed: false, reason: reply.reason ?? "refused" };
		this.clearHeartbeat(graphId, nodeId);
		this.update(graphId, nodeId, (r) => {
			r.turn_in_flight = false;
			r.released = true;
			if (r.last_stop_reason === null) r.last_stop_reason = "end_turn";
			r.exit_code = r.last_error ? 1 : 0;
		});
		this.log(`[substrate-host] task completed ${key}`);
		return { completed: true };
	}

	/**
	 * The guest-initiated terminal release shared by both guest routes (SEC01): fenced on
	 * the persisted `lease_id`, and — only on `released:true` — clears the heartbeat and
	 * marks the record released so no tick re-claims and no resume revives it. The turn
	 * itself settles naturally afterwards. Refusals and transport errors leave the record
	 * untouched and report truthfully. Terminal release transitions are exempt from the
	 * mutation guard: they end authority, they do not spend it.
	 */
	async guestRelease(graphId: string, nodeId: string): Promise<{ released: boolean; reason?: string }> {
		const key = `${graphId}/${nodeId}`;
		const record = this.deps.store.get(graphId, nodeId);
		const leaseId = this.deps.leases.load(graphId, nodeId)?.lease_id ?? null;
		let reply: { released: boolean; reason?: string };
		try {
			reply = await this.deps.substrate.graphRelease(graphId, nodeId, leaseId);
		} catch (cause) {
			this.log(`[substrate-host] guest release ${key} failed: ${String(cause)}`);
			return { released: false, reason: String(cause) };
		}
		if (!reply.released) {
			this.log(`[substrate-host] guest release ${key} refused: ${reply.reason ?? "refused"}`);
			return { released: false, reason: reply.reason ?? "refused" };
		}
		this.clearHeartbeat(graphId, nodeId);
		if (record) {
			this.update(graphId, nodeId, (r) => {
				r.released = true;
				r.turn_in_flight = false;
				if (r.exit_code === null) r.exit_code = 0;
			});
		}
		this.log(`[substrate-host] guest released ${key}`);
		return { released: true };
	}


	/** Research Pattern 2: validate → existing? → graph_get → graph_claim → brief → seed → open → prompt (not awaited). */
	async openTask(body: unknown): Promise<OpenResult> {
		const validation = validateOpenRequest(body);
		if (!validation.ok) return { status: 400, body: { error: validation.error } };
		const req = validation.request;
		const { graph_id: gid, node_id: nid } = req;

		const existing = this.deps.store.get(gid, nid);
		if (existing) return { status: 200, body: await this.statusOf(existing) };

		const graph = await this.deps.substrate.graphGet(gid);
		if (!graph) return { status: 400, body: { error: `graph ${gid} is not registered` } };
		const node = graph.nodes?.find((n) => n.node_id === nid);
		if (!node) return { status: 400, body: { error: `graph ${gid} has no node ${nid}` } };
		if (node.claimed_by && node.claimed_by !== HOST_SURFACE) {
			return { status: 409, body: { error: `node is claimed by ${node.claimed_by} session ${node.claim_session}` } };
		}

		// A real persist throw compensates inside claimAndPersist (fenced on the captured
		// grant, never force) and arrives here as a names-only failure: 502 before any VM
		// work, with no claimed lease left behind.
		let claim: ClaimReply;
		try {
			claim = await this.deps.substrate.claimAndPersist(this.deps.leases, gid, nid, HOST_SURFACE, nid, this.now().getTime());
		} catch (cause) {
			this.log(`[substrate-host] open ${gid}/${nid} failed after claim: ${String(cause)}`);
			return { status: 502, body: { error: "lease persist failed" } };
		}
		if (!claim.claimed) return { status: 409, body: { error: claim.reason ?? "claim refused" } };
		// Persist-then-verify (D32-04, I-02): a grant without a readable lease file must never
		// leave a held claim the next boot cannot fence. Compensate with the captured grant's
		// own `lease_id` when the grant carried one — never an unfenced force — then answer 502.
		if (!this.deps.leases.load(gid, nid)) {
			const grantedLease = claim.lease?.lease_id ?? null;
			if (grantedLease) {
				await this.deps.substrate.graphRelease(gid, nid, grantedLease).catch((error: unknown) => {
					this.log(`[substrate-host] release after failed open ${gid}/${nid} failed: ${String(error)}`);
				});
			}
			this.log(`[substrate-host] open ${gid}/${nid} failed after claim: lease persist verification failed`);
			return { status: 502, body: { error: "lease persist verification failed" } };
		}
		this.log(`[substrate-host] lease persisted for ${gid}/${nid}: yes`);

		try {
			const brief = await this.deps.substrate.brief(gid, req.repo);
			const handle = this.deps.vmFor(gid);
			await this.deps.ensureModelRoute(handle, gid);
			await this.deps.ensureSubstrateRoute(handle, gid);

			const prompt = renderPrompt({
				identifier: req.identifier,
				graphId: gid,
				nodeId: nid,
				repo: req.repo,
				sessionId: nid,
				route: this.deps.route,
				testsRoute: this.deps.testsRoute,
			});
			const files = seedFiles({
				brief,
				skills: this.deps.skills,
				trackers: this.deps.trackers,
				graph,
				nodeId: nid,
				route: this.deps.route,
				prompt,
			});
			const seeded: SeededFile[] = [];
			const dirs = new Set(files.map((f) => f.path.slice(0, f.path.lastIndexOf("/"))));
			for (const dir of dirs) await handle.filesystem.mkdir(dir, { recursive: true });
			for (const file of files) {
				await handle.filesystem.writeFile(file.path, file.content);
				const back = await handle.filesystem.readFile(file.path);
				const digest = sha256(back);
				if (digest !== sha256(file.content)) throw new Error(`seed read-back mismatch for ${file.path}`);
				seeded.push({ path: file.path, sha256: digest, bytes: back.byteLength });
			}

			await handle.sessions.open({
				sessionId: nid,
				agent: "claude",
				cwd: VM_WORK,
				env: sessionEnv({ route: this.deps.route, model: this.deps.model, graphId: gid, nodeId: nid, directKey: this.deps.directKey }),
				mcpServers:
					this.deps.route.s === "mcp" ? [{ type: "http", name: "substrate", url: SUBSTRATE_RELAY_URL, headers: [] }] : [],
				permissionPolicy: "ask",
				additionalInstructions: ADDITIONAL_INSTRUCTIONS,
			});

			const record: TaskRecord = {
				graph_id: gid,
				node_id: nid,
				identifier: req.identifier,
				repo: req.repo,
				session_id: nid,
				prompt_count: 1,
				turn_in_flight: true,
				last_stop_reason: null,
				exit_code: null,
				released: false,
				pending_approvals: [],
				opened_at: this.now().toISOString(),
				last_error: null,
				seeded,
				resumes: 0,
				stale_approvals: 0,
				pr_url: null,
				pr_number: null,
				synced_at: null,
				sync_by: null,
				approvals_allowed: 0,
				approvals_denied: 0,
			};
			this.deps.store.save(record);

			await this.deps.ensureModelRoute(handle, gid);
			await this.deps.ensureSubstrateRoute(handle, gid);
			this.startPrompt(handle, record, prompt, `${gid}:${nid}:1`);
			this.log(`[substrate-host] task opened ${gid}/${nid} (${req.identifier})`);
			return { status: 202, body: await this.statusOf(record) };
		} catch (cause) {
			// The claim is persisted, so the fenced single-release path compensates (I-02).
			await this.releaseOnce(gid, nid);
			this.log(`[substrate-host] open ${gid}/${nid} failed after claim: ${String(cause)}`);
			return { status: 502, body: { error: String(cause) } };
		}
	}

	/**
	 * Start a turn without awaiting it; the record is updated when the prompt settles. The
	 * heartbeat tick arms here and clears on every settle path, and every non-shutdown settle
	 * releases the claim once (D32-02/D32-03) — a settled turn holds no lease, so a later
	 * `complete` must precede the settle and a later boot never resumes it.
	 */
	startPrompt(handle: VmHandle, record: TaskRecord, text: string, idempotencyKey: string): void {
		const key = `${record.graph_id}/${record.node_id}`;
		this.startHeartbeat(record.graph_id, record.node_id);
		const settled = handle.sessions
			.prompt({ sessionId: record.session_id, idempotencyKey, content: [{ type: "text", text }] })
			.then((result) => {
				this.clearHeartbeat(record.graph_id, record.node_id);
				this.update(record.graph_id, record.node_id, (r) => {
					// A terminal record (lease lost, guest released/completed) keeps its
					// failure: settlement folds the stop reason only into a live turn.
					if (r.exit_code !== null) return;
					r.turn_in_flight = false;
					r.last_stop_reason = result.stopReason;
					r.exit_code = pollCode(r);
				});
				this.log(`[substrate-host] turn ended ${key} stop=${result.stopReason}`);
				return this.releaseOnce(record.graph_id, record.node_id).then(() => this.backstopSync(record.graph_id, record.node_id));
			})
			.catch((cause: unknown) => {
				this.clearHeartbeat(record.graph_id, record.node_id);
				if (this.stopping) {
					// D-07: the host is going down; the turn is interrupted, not failed, so the next boot resumes it.
					this.log(`[substrate-host] prompt interrupted by shutdown ${key}: ${String(cause)}`);
					return;
				}
				this.update(record.graph_id, record.node_id, (r) => {
					if (r.exit_code !== null) return;
					r.turn_in_flight = false;
					r.last_error = String(cause);
					r.exit_code = 1;
				});
				this.log(`[substrate-host] prompt failed ${key}: ${String(cause)}`);
				return this.releaseOnce(record.graph_id, record.node_id).then(() => this.backstopSync(record.graph_id, record.node_id));
			})
			.finally(() => {
				if (this.turns.get(key) === settled) this.turns.delete(key);
			});
		this.turns.set(key, settled);
	}

	/**
	 * D-10 backstop, on every route, once per task: a settled turn whose record holds a pr_url
	 * (recorded by the host's own pr-create) that is still unsynced. On tracker_route vm_mcp the
	 * model's in-VM ultrathink-sync is verified read-only first (both trackers hold the URL →
	 * sync_by model_mcp, no write); otherwise — and on tracker_route host always — the host writes
	 * the PR fields itself (sync_by host, the D-10 deviation 03-10 records). synced_at is set after
	 * one run whatever the trackers answered, so a later settle never repeats it; the outcome is in
	 * the journal.
	 */
	async backstopSync(graphId: string, nodeId: string): Promise<void> {
		const sync = this.deps.sync;
		const record = this.deps.store.get(graphId, nodeId);
		if (!sync || !record || !record.pr_url || record.pr_number === null || record.synced_at !== null) return;
		const key = `${graphId}/${nodeId}`;
		const prUrl = record.pr_url;
		const prNumber = record.pr_number;
		try {
			const graph = await this.deps.substrate.graphGet(graphId);
			const node = graph?.nodes?.find((n) => n.node_id === nodeId);
			if (!graph || !node) {
				this.log(`[substrate-host] sync backstop ${key}: graph or node missing from the index`);
				return;
			}
			let by: SyncBy = "host";
			if (trackerRoute(this.deps.route) === "vm_mcp") {
				const seen = await sync.verifyModelSync({ graphId, node, prUrl });
				if (seen.notion && seen.linear) by = "model_mcp";
			}
			if (by === "host") {
				const result = await sync.syncPr({ graphId, nodeId, prUrl, prNumber, repo: graph.repo ?? record.repo, branch: `substrate/${graphId}`, node });
				this.log(`[substrate-host] sync by host for ${key}`);
				this.log(`[substrate-host] sync result ${key}: notion ${result.notion}, linear ${result.linear}`);
			} else {
				this.log(`[substrate-host] sync by model (mcp) for ${key}`);
			}
			this.update(graphId, nodeId, (r) => {
				r.synced_at = this.now().toISOString();
				r.sync_by = by;
			});
		} catch (cause) {
			this.log(`[substrate-host] sync backstop ${key} failed: ${String(cause)}`);
		}
	}

	/**
	 * D-07, once per process at boot: every task whose turn the previous host process left in
	 * flight gets exactly one continuation prompt, keyed `<gid>:<nid>:resume:<n>` so a repeated
	 * boot cannot replay it (T-03-06-01). rivet restores the session itself (resume → load →
	 * bounded-history fallback); the host only sends the next prompt. Approval requests of the dead
	 * turn can never be answered, so they leave pending_approvals as a stale count (T-03-06-02).
	 * The model route is re-established first (on a:hostfn_proxy the restart killed the in-VM relay),
	 * then the persisted lease is heartbeat-or-reclaimed (D32-06); a task whose route, lease or
	 * prompt fails is marked failed on its own and the others still resume.
	 * Returns the number of continuation prompts sent.
	 */
	async resumeInterrupted(): Promise<number> {
		if (this.resumedThisBoot) return 0;
		this.resumedThisBoot = true;
		let sent = 0;
		for (const interrupted of interruptedTasks(this.deps.store.list())) {
			const { graph_id: gid, node_id: nid } = interrupted;
			const key = `${gid}/${nid}`;
			let handle: VmHandle;
			try {
				handle = this.deps.vmFor(gid);
				await this.deps.ensureModelRoute(handle, gid);
				await this.deps.ensureSubstrateRoute(handle, gid);
			} catch (cause) {
				this.update(gid, nid, (r) => {
					r.turn_in_flight = false;
					r.last_error = String(cause);
					r.exit_code = 1;
				});
				this.log(`[substrate-host] resume ${key} failed before the prompt: ${String(cause)}`);
				continue;
			}
			// D32-06: the restarted turn is a running turn — heartbeat-or-reclaim the persisted
			// lease before the continuation. A refused re-claim fails that task alone (no prompt,
			// no resume bump) and the loop continues over the remaining tasks.
			const leaseCheck = await this.heartbeatOrReclaim(gid, nid, interrupted.session_id);
			if (leaseCheck === "failed") {
				this.update(gid, nid, (r) => {
					r.turn_in_flight = false;
					r.last_error = "lease lost";
					r.exit_code = 1;
				});
				await this.releaseOnce(gid, nid);
				await handle.sessions.cancelPrompt({ sessionId: interrupted.session_id }).catch((cause: unknown) => {
					this.log(`[substrate-host] resume lease-loss cancel ${key} failed: ${String(cause)}`);
				});
				this.log(`[substrate-host] resume ${key} failed on the lease: re-claim refused`);
				continue;
			}
			const record = this.update(gid, nid, (r) => {
				r.resumes += 1;
				r.prompt_count += 1;
				r.stale_approvals += r.pending_approvals.length;
				r.pending_approvals = [];
				r.turn_in_flight = true;
			});
			if (!record) continue;
			const idempotencyKey = `${gid}:${nid}:resume:${record.resumes}`;
			this.startPrompt(handle, record, RESUME_TEXT, idempotencyKey);
			this.log(`[substrate-host] resumed ${key} key ${idempotencyKey}`);
			sent += 1;
		}
		return sent;
	}

	update(graphId: string, nodeId: string, change: (record: TaskRecord) => void): TaskRecord | null {
		const record = this.deps.store.get(graphId, nodeId);
		if (!record) return null;
		change(record);
		this.deps.store.save(record);
		return record;
	}

	/** onSessionEvent → permission_request: recorded with a deadline, logged, never answered (D-13 floor). */
	recordApproval(graphId: string, sessionId: string, requestId: string, tool: string): void {
		const at = this.now();
		const deadlineMs = at.getTime() + (this.deps.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS);
		this.update(graphId, sessionId, (r) => {
			if (!r.pending_approvals.some((p) => p.request_id === requestId)) {
				r.pending_approvals.push({ request_id: requestId, tool, at: at.toISOString(), deadlineMs });
			}
		});
		this.log(`[substrate-host] approval pending ${graphId}/${sessionId} request ${requestId} (telegram approvals off)`);
	}

	/** onSessionEvent → permission_response: the request is no longer pending, whoever resolved it. */
	resolveApproval(graphId: string, sessionId: string, requestId: string): void {
		this.update(graphId, sessionId, (r) => {
			r.pending_approvals = r.pending_approvals.filter((p) => p.request_id !== requestId);
		});
	}

	/**
	 * The only code path that answers a permission request (D-13). Called only after an
	 * authorised callback. allow_always is refused here as well as at the button layer.
	 *
	 * Single-answer semantics: the request is claimed out of pending synchronously, before
	 * the first await, so a concurrent answer (a tap racing the timeout sweep) finds nothing
	 * and reads not_pending. A refused transport restores the claim and also reads not_pending.
	 */
	async respondApproval(graphId: string, sessionId: string, requestId: string, optionId: string): Promise<"answered" | "not_pending"> {
		if (optionId !== "allow_once" && optionId !== "reject_once") return "not_pending";
		let had = false;
		this.update(graphId, sessionId, (r) => {
			const index = r.pending_approvals.findIndex((p) => p.request_id === requestId);
			if (index >= 0) {
				r.pending_approvals.splice(index, 1);
				had = true;
			}
		});
		if (!had) return "not_pending";
		const handle = this.deps.vmFor(graphId);
		let result: { status: string };
		try {
			result = await handle.respondPermission({ sessionId, requestId, optionId });
		} catch {
			this.restoreApproval(graphId, sessionId, requestId);
			return "not_pending";
		}
		if (result.status !== "accepted") {
			this.restoreApproval(graphId, sessionId, requestId);
			return "not_pending";
		}
		this.update(graphId, sessionId, (r) => {
			if (optionId === "allow_once") r.approvals_allowed += 1;
			else r.approvals_denied += 1;
		});
		return "answered";
	}

	/** Put back a claimed approval the transport refused, so a later tap or sweep can answer it. */
	private restoreApproval(graphId: string, sessionId: string, requestId: string): void {
		this.update(graphId, sessionId, (r) => {
			if (!r.pending_approvals.some((p) => p.request_id === requestId)) {
				r.pending_approvals.push({
					request_id: requestId, tool: "unknown",
					at: this.now().toISOString(),
					deadlineMs: this.now().getTime() + (this.deps.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS),
				});
			}
		});
	}

	/**
	 * Auto-deny every approval past its deadline through the respondApproval path (D33-04):
	 * the same deny call, the same approvals_denied increment, the same pending-clearing,
	 * plus a timeout log line carrying ids only. Entries without a numeric deadline (records
	 * written before deadlines existed) never expire — fail open toward the old behavior.
	 * Returns the number of requests settled by this sweep.
	 */
	async sweepApprovalTimeouts(graphId: string, nodeId: string): Promise<number> {
		const key = `${graphId}/${nodeId}`;
		const record = this.deps.store.get(graphId, nodeId);
		if (!record || !record.turn_in_flight || record.released || record.exit_code !== null) return 0;
		const nowMs = this.now().getTime();
		const expired = record.pending_approvals
			.filter((p) => typeof p.deadlineMs === "number" && p.deadlineMs <= nowMs)
			.map((p) => p.request_id);
		let settled = 0;
		for (const requestId of expired) {
			const outcome = await this.respondApproval(graphId, record.session_id, requestId, "reject_once");
			settled += 1;
			this.log(`[substrate-host] approval timeout ${key} request ${requestId} (${outcome})`);
		}
		return settled;
	}

	/** Every stored field plus the live session view; later plans' record fields appear unchanged. */
	async statusOf(record: TaskRecord): Promise<TaskStatus> {
		let state = "unknown";
		let latest: number | null = null;
		let history: number | null = null;
		if (!record.released) {
			try {
				const handle = this.deps.vmFor(record.graph_id);
				const info = await handle.sessions.get({ sessionId: record.session_id });
				state = info.state.status;
				latest = info.latestSequence;
				const page = await handle.sessions.readHistory({ sessionId: record.session_id });
				history = page.events.length;
			} catch (cause) {
				this.log(`[substrate-host] session read ${record.graph_id}/${record.node_id} failed: ${String(cause)}`);
			}
		} else {
			state = "unloaded";
		}
		return {
			...record,
			exit_code: record.exit_code ?? pollCode(record, state),
			state,
			latest_sequence: latest,
			history_events: history,
		};
	}

	async status(graphId: string, nodeId: string): Promise<TaskStatus | null> {
		const record = this.deps.store.get(graphId, nodeId);
		return record ? this.statusOf(record) : null;
	}

	async list(): Promise<TaskStatus[]> {
		const out: TaskStatus[] = [];
		for (const record of this.deps.store.list()) out.push(await this.statusOf(record));
		return out;
	}

	/**
	 * Cancel the running turn; the prompt promise then settles with its stop reason. The tick
	 * clears here and the claim releases here (D32-03) — the later settle finds the `released`
	 * flag and re-releases nothing, but still folds the stop reason into the record.
	 */
	async terminate(graphId: string, nodeId: string): Promise<boolean> {
		const record = this.deps.store.get(graphId, nodeId);
		if (!record) return false;
		this.clearHeartbeat(graphId, nodeId);
		await this.deps
			.vmFor(graphId)
			.sessions.cancelPrompt({ sessionId: record.session_id })
			.catch((cause: unknown) => this.log(`[substrate-host] terminate ${graphId}/${nodeId}: ${String(cause)}`));
		await this.releaseOnce(graphId, nodeId);
		return true;
	}

	/** Cancel, unload the session and release the claim; the VM and its history stay (not delete). */
	async kill(graphId: string, nodeId: string): Promise<boolean> {
		const record = this.deps.store.get(graphId, nodeId);
		if (!record) return false;
		const handle = this.deps.vmFor(graphId);
		this.clearHeartbeat(graphId, nodeId);
		await handle.sessions
			.cancelPrompt({ sessionId: record.session_id })
			.catch((cause: unknown) => this.log(`[substrate-host] kill cancel ${graphId}/${nodeId}: ${String(cause)}`));
		await handle.sessions
			.unload({ sessionId: record.session_id })
			.catch((cause: unknown) => this.log(`[substrate-host] kill unload ${graphId}/${nodeId}: ${String(cause)}`));
		await this.releaseOnce(graphId, nodeId);
		this.update(graphId, nodeId, (r) => {
			r.turn_in_flight = false;
			if (r.last_stop_reason === null) r.last_stop_reason = "killed";
			r.exit_code = pollCode(r);
		});
		this.log(`[substrate-host] task killed ${graphId}/${nodeId}`);
		return true;
	}
}
