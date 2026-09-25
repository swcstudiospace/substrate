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
import { type Route, sessionEnv, SUBSTRATE_MCP_URL, type TestsRoute, trackerRoute, worktreeFor } from "./options.ts";
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
import { type GraphNodeView, type GraphView, HOST_SURFACE } from "./substrate.ts";

export type PendingApproval = { request_id: string; tool: string; at: string };
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
};

export type SubstrateLike = {
	graphGet(graphId: string): Promise<GraphView | null>;
	graphClaim(graphId: string, nodeId: string, surface: string, sessionId: string): Promise<{ claimed: boolean; reason?: string }>;
	graphRelease(graphId: string, nodeId: string, surface: string, sessionId: string): Promise<unknown>;
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
	/** Awaited before sessions.open and before every prompt (T-03-03-09). */
	ensureModelRoute: (handle: VmHandle, graphId: string) => Promise<void>;
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
};

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
	/** resumeInterrupted runs once per host process (D-07). */
	resumedThisBoot: boolean;
	/** Set by beginShutdown: prompt rejections after this point are the shutdown's, not the turn's. */
	stopping: boolean;

	constructor(deps: TaskServiceDeps) {
		this.deps = deps;
		this.log = deps.log ?? ((line) => process.stdout.write(`${line}\n`));
		this.now = deps.now ?? (() => new Date());
		this.turns = new Map();
		this.resumedThisBoot = false;
		this.stopping = false;
	}

	/**
	 * Called from the SIGTERM handler before the registry shuts down: an in-flight prompt that the
	 * shutdown rejects (sidecar exit, lost websocket) must keep its record in flight, or the next
	 * boot would never send its continuation (D-07).
	 */
	beginShutdown(): void {
		this.stopping = true;
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

		const claim = await this.deps.substrate.graphClaim(gid, nid, HOST_SURFACE, nid);
		if (!claim.claimed) return { status: 409, body: { error: claim.reason ?? "claim refused" } };

		try {
			const brief = await this.deps.substrate.brief(gid, req.repo);
			const handle = this.deps.vmFor(gid);
			await this.deps.ensureModelRoute(handle, gid);

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
					this.deps.route.s === "mcp" ? [{ type: "http", name: "substrate", url: SUBSTRATE_MCP_URL, headers: [] }] : [],
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
			};
			this.deps.store.save(record);

			await this.deps.ensureModelRoute(handle, gid);
			this.startPrompt(handle, record, prompt, `${gid}:${nid}:1`);
			this.log(`[substrate-host] task opened ${gid}/${nid} (${req.identifier})`);
			return { status: 202, body: await this.statusOf(record) };
		} catch (cause) {
			await this.deps.substrate.graphRelease(gid, nid, HOST_SURFACE, nid).catch((error: unknown) => {
				this.log(`[substrate-host] release after failed open ${gid}/${nid} failed: ${String(error)}`);
			});
			this.log(`[substrate-host] open ${gid}/${nid} failed after claim: ${String(cause)}`);
			return { status: 502, body: { error: String(cause) } };
		}
	}

	/** Start a turn without awaiting it; the record is updated when the prompt settles. */
	startPrompt(handle: VmHandle, record: TaskRecord, text: string, idempotencyKey: string): void {
		const key = `${record.graph_id}/${record.node_id}`;
		const settled = handle.sessions
			.prompt({ sessionId: record.session_id, idempotencyKey, content: [{ type: "text", text }] })
			.then((result) => {
				this.update(record.graph_id, record.node_id, (r) => {
					r.turn_in_flight = false;
					r.last_stop_reason = result.stopReason;
					r.exit_code = pollCode(r);
				});
				this.log(`[substrate-host] turn ended ${key} stop=${result.stopReason}`);
				return this.backstopSync(record.graph_id, record.node_id);
			})
			.catch((cause: unknown) => {
				if (this.stopping) {
					// D-07: the host is going down; the turn is interrupted, not failed, so the next boot resumes it.
					this.log(`[substrate-host] prompt interrupted by shutdown ${key}: ${String(cause)}`);
					return;
				}
				this.update(record.graph_id, record.node_id, (r) => {
					r.turn_in_flight = false;
					r.last_error = String(cause);
					r.exit_code = 1;
				});
				this.log(`[substrate-host] prompt failed ${key}: ${String(cause)}`);
				return this.backstopSync(record.graph_id, record.node_id);
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
	 * The model route is re-established first (on a:hostfn_proxy the restart killed the in-VM relay);
	 * a task whose route or prompt fails is marked failed on its own and the others still resume.
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
			} catch (cause) {
				this.update(gid, nid, (r) => {
					r.turn_in_flight = false;
					r.last_error = String(cause);
					r.exit_code = 1;
				});
				this.log(`[substrate-host] resume ${key} failed before the prompt: ${String(cause)}`);
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

	/** onSessionEvent → permission_request: recorded, logged, never answered (D-13 floor). */
	recordApproval(graphId: string, sessionId: string, requestId: string, tool: string): void {
		this.update(graphId, sessionId, (r) => {
			if (!r.pending_approvals.some((p) => p.request_id === requestId)) {
				r.pending_approvals.push({ request_id: requestId, tool, at: this.now().toISOString() });
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
			exit_code: pollCode(record, state),
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

	/** Cancel the running turn; the prompt promise then settles with its stop reason. */
	async terminate(graphId: string, nodeId: string): Promise<boolean> {
		const record = this.deps.store.get(graphId, nodeId);
		if (!record) return false;
		await this.deps
			.vmFor(graphId)
			.sessions.cancelPrompt({ sessionId: record.session_id })
			.catch((cause: unknown) => this.log(`[substrate-host] terminate ${graphId}/${nodeId}: ${String(cause)}`));
		return true;
	}

	/** Cancel, unload the session and release the claim; the VM and its history stay (not delete). */
	async kill(graphId: string, nodeId: string): Promise<boolean> {
		const record = this.deps.store.get(graphId, nodeId);
		if (!record) return false;
		const handle = this.deps.vmFor(graphId);
		await handle.sessions
			.cancelPrompt({ sessionId: record.session_id })
			.catch((cause: unknown) => this.log(`[substrate-host] kill cancel ${graphId}/${nodeId}: ${String(cause)}`));
		await handle.sessions
			.unload({ sessionId: record.session_id })
			.catch((cause: unknown) => this.log(`[substrate-host] kill unload ${graphId}/${nodeId}: ${String(cause)}`));
		await this.deps.substrate
			.graphRelease(graphId, nodeId, HOST_SURFACE, record.session_id)
			.catch((cause: unknown) => this.log(`[substrate-host] kill release ${graphId}/${nodeId}: ${String(cause)}`));
		this.update(graphId, nodeId, (r) => {
			r.released = true;
			r.turn_in_flight = false;
			if (r.last_stop_reason === null) r.last_stop_reason = "killed";
			r.exit_code = pollCode(r);
		});
		this.log(`[substrate-host] task killed ${graphId}/${nodeId}`);
		return true;
	}
}
