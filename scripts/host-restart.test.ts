/**
 * Kill-and-restart rehearsal (32-02, LANEA-03): a TaskService over on-disk
 * TaskStore + sibling LeaseStore is killed mid-turn with fake VMs, then a new
 * service over the same dirs resumes exactly one continuation; a third boot
 * sends nothing. No rivet runtime, no daemon, no substrate writes.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRoute } from "../packages/host/src/options.ts";
import { WORKTREES_ROOT } from "../packages/host/src/sandbox-options.ts";
import { type LeaseStoreLike, LeaseStore } from "../packages/host/src/substrate.ts";
import {
	RESUME_TEXT,
	TaskService,
	type TaskRecord,
	TaskStore,
	type TaskStoreLike,
	type VmHandle,
} from "../packages/host/src/tasks.ts";

const GID = "ut-rst-11111111";
const NID = "n1";
const ROUTE = parseRoute("a:loopback,b:prompt_hostfn,c:hostfn_commit,s:hostfn");

type SubCalls = { heartbeats: string[]; claims: string[]; releases: string[] };

/** Fake substrate: grants numbered leases, heartbeats ok, records call order. */
function fakeSubstrate(calls: SubCalls, order: string[]) {
	let n = 0;
	return {
		bearer: "restart-bearer",
		graphGet: async (graphId: string) => ({
			graph_id: graphId,
			nodes: [
				{
					graph_id: graphId,
					node_id: NID,
					linear_issue_id: null,
					linear_identifier: "SWC-1",
					notion_page: null,
					state: null,
					claimed_by: null,
					claimed_at: null,
					claim_session: null,
				},
			],
		}),
		graphClaim: async () => ({ claimed: true }),
		claimAndPersist: async (store: LeaseStoreLike, graphId: string, nodeId: string) => {
			calls.claims.push(`${graphId}/${nodeId}`);
			order.push(`claim:${graphId}`);
			n += 1;
			const leaseId = `lse_restart_${n}`;
			store.persist(graphId, nodeId, { lease_id: leaseId, acquiredAtMs: 0, ttlSeconds: 900 });
			return { claimed: true, lease_id: leaseId };
		},
		heartbeat: async (graphId: string, nodeId: string) => {
			calls.heartbeats.push(`${graphId}/${nodeId}`);
			order.push(`heartbeat:${graphId}`);
			return { ok: true };
		},
		graphComplete: async () => ({ completed: true }),
		graphRelease: async (graphId: string, nodeId: string) => {
			calls.releases.push(`${graphId}/${nodeId}`);
			return { released: true };
		},
		brief: async () => "restart brief",
	};
}

type Actor = {
	files: Map<string, string>;
	opens: number;
	prompts: string[];
	routeCalls: string[];
	rejectFirst: (error: unknown) => void;
};

/**
 * Fake VM: the first prompt (`<gid>:<nid>:1`) never settles; continuations
 * resolve end_turn at once. The pending first prompt rejects on demand.
 */
function fakeVm(actor: Actor, order: string[]): VmHandle {
	let rejectPending: ((error: unknown) => void) | null = null;
	actor.rejectFirst = (error) => rejectPending?.(error);
	return {
		filesystem: {
			mkdir: async () => undefined,
			writeFile: async (path, content) => {
				actor.files.set(path, String(content));
			},
			readFile: async (path) => new TextEncoder().encode(actor.files.get(path) ?? ""),
		},
		sessions: {
			open: async () => {
				actor.opens += 1;
			},
			prompt: (input) => {
				actor.prompts.push(input.idempotencyKey);
				order.push(`prompt:${input.idempotencyKey}`);
				if (!input.idempotencyKey.includes(":resume:")) {
					return new Promise<{ stopReason: string }>((_resolve, reject) => {
						rejectPending = reject;
					});
				}
				return Promise.resolve({ stopReason: "end_turn" });
			},
			get: async () => ({ state: { status: "idle" }, latestSequence: 1 }),
			readHistory: async () => ({ events: [] }),
			cancelPrompt: async () => ({ status: "cancelled" }),
			unload: async () => undefined,
		},
		respondPermission: async () => ({ status: "not_pending" as const }),
	};
}

function boot(
	store: TaskStoreLike,
	leases: LeaseStoreLike,
	substrate: ReturnType<typeof fakeSubstrate>,
	actor: Actor,
	order: string[],
	routeFailsFor?: string,
): TaskService {
	const handle = fakeVm(actor, order);
	return new TaskService({
		substrate,
		vmFor: () => handle,
		store,
		leases,
		ensureModelRoute: async (_handle, graphId) => {
			actor.routeCalls.push(graphId);
			order.push(`route:${graphId}`);
			if (routeFailsFor === graphId) throw new Error(`relay failed for ${graphId}`);
		},
		route: ROUTE,
		testsRoute: "sandbox",
		model: "restart-model",
		skills: [],
		trackers: { notionDataSourceUrl: "collection://restart", linearTeam: "SWC" },
		log: () => undefined,
	});
}

function openBody(graphId: string) {
	return {
		graph_id: graphId,
		node_id: NID,
		identifier: "SWC-1",
		repo: "swcstudiospace/agent-substrate",
		worktree: `${WORKTREES_ROOT}/${graphId}`,
	};
}

function record(overrides: Partial<TaskRecord> = {}): TaskRecord {
	return {
		graph_id: GID,
		node_id: NID,
		identifier: "SWC-1",
		repo: "swcstudiospace/agent-substrate",
		session_id: NID,
		prompt_count: 1,
		turn_in_flight: true,
		last_stop_reason: null,
		exit_code: null,
		released: false,
		pending_approvals: [],
		opened_at: "2026-09-25T12:00:00Z",
		last_error: null,
		seeded: [],
		resumes: 0,
		stale_approvals: 0,
		pr_url: null,
		pr_number: null,
		synced_at: null,
		sync_by: null,
		approvals_allowed: 0,
		approvals_denied: 0,
		...overrides,
	};
}

describe("kill-and-restart over on-disk stores (32-02)", () => {
	test("kill mid-turn → reboot sends exactly one resume-keyed continuation; a third boot sends none", async () => {
		const dir = mkdtempSync(join(tmpdir(), "host-restart-"));
		try {
			const store = new TaskStore(join(dir, "tasks"));
			const leases = new LeaseStore(join(dir, "leases"));
			const calls: SubCalls = { heartbeats: [], claims: [], releases: [] };
			const order: string[] = [];
			const substrate = fakeSubstrate(calls, order);
			const actor: Actor = { files: new Map(), opens: 0, prompts: [], routeCalls: [], rejectFirst: () => undefined };

			const boot1 = boot(store, leases, substrate, actor, order);
			expect((await boot1.openTask(openBody(GID))).status).toBe(202);
			boot1.recordApproval(GID, NID, "req-1", "Read");
			// SIGTERM-after-beginShutdown: the unsettlable prompt rejects; the record stays in flight.
			boot1.beginShutdown();
			actor.rejectFirst(new Error("SidecarProcessExited: sidecar process exited with disconnect"));
			await boot1.turns.get(`${GID}/${NID}`);
			expect(store.get(GID, NID)?.turn_in_flight).toBe(true);
			expect(store.get(GID, NID)?.exit_code).toBeNull();
			// The dead service's tick is disarmed: it emits no further heartbeats.
			expect(boot1.heartbeatArmed(GID, NID)).toBe(false);

			// Reboot over the same dirs.
			const boot2 = boot(store, leases, substrate, actor, order);
			expect(await boot2.resumeInterrupted()).toBe(1);
			expect(actor.prompts).toEqual([`${GID}:${NID}:1`, `${GID}:${NID}:resume:1`]);
			// Route re-established first, heartbeat-or-reclaim before the continuation.
			const tail = order.slice(order.indexOf(`prompt:${GID}:${NID}:1`) + 1);
			expect(tail).toEqual([`route:${GID}`, `heartbeat:${GID}`, `prompt:${GID}:${NID}:resume:1`]);
			const resumed = store.get(GID, NID);
			expect(resumed?.resumes).toBe(1);
			expect(resumed?.stale_approvals).toBe(1);
			expect(resumed?.pending_approvals).toEqual([]);
			expect(RESUME_TEXT).toContain("/home/agentos/work");
			// The lease file keeps 0600 across the reboot.
			expect(statSync(join(dir, "leases", `${GID}__${NID}.lease.json`)).mode & 0o777).toBe(0o600);
			// The continuation settles: no replay source is left.
			await boot2.turns.get(`${GID}/${NID}`);
			expect(calls.heartbeats).toEqual([`${GID}/${NID}`]);

			// A third boot over the same dirs sends nothing.
			const boot3 = boot(store, leases, substrate, actor, order);
			expect(await boot3.resumeInterrupted()).toBe(0);
			expect(actor.prompts).toHaveLength(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a task whose route fails is marked failed alone while the other still resumes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "host-restart-"));
		try {
			const store = new TaskStore(join(dir, "tasks"));
			const leases = new LeaseStore(join(dir, "leases"));
			store.save(record({ graph_id: "ut-aaa-11111111" }));
			store.save(record({ graph_id: "ut-bbb-22222222" }));
			const calls: SubCalls = { heartbeats: [], claims: [], releases: [] };
			const order: string[] = [];
			const substrate = fakeSubstrate(calls, order);
			const actor: Actor = { files: new Map(), opens: 0, prompts: [], routeCalls: [], rejectFirst: () => undefined };
			const reboot = boot(store, leases, substrate, actor, order, "ut-aaa-11111111");
			expect(await reboot.resumeInterrupted()).toBe(1);
			expect(actor.prompts).toEqual(["ut-bbb-22222222:n1:resume:1"]);
			const failed = store.get("ut-aaa-11111111", NID);
			expect(failed?.exit_code).toBe(1);
			expect(failed?.last_error).toContain("relay failed");
			expect(failed?.turn_in_flight).toBe(false);
			expect(store.get("ut-bbb-22222222", NID)?.resumes).toBe(1);
			await reboot.turns.get("ut-bbb-22222222/n1");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
