import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import { type ApiService, createApiServer } from "./api.ts";
import { WORKTREES_ROOT } from "./sandbox-options.ts";
import type { OpenResult, TaskStatus } from "./tasks.ts";

const GID = "ut-a-12345678";
const NID = "n1";

function statusFor(graphId: string, nodeId: string, extra: Record<string, unknown> = {}): TaskStatus {
	return {
		graph_id: graphId,
		node_id: nodeId,
		identifier: "TRC-1",
		repo: "swcstudiospace/agent-substrate",
		session_id: nodeId,
		prompt_count: 1,
		turn_in_flight: true,
		last_stop_reason: null,
		exit_code: null,
		released: false,
		pending_approvals: [],
		opened_at: "2026-09-25T12:00:00.000Z",
		last_error: null,
		seeded: [],
		resumes: 0,
		stale_approvals: 0,
		state: "running",
		latest_sequence: 1,
		history_events: 1,
		...extra,
	};
}

/** A TaskService stand-in: one in-memory task, every call recorded. */
function fakeService() {
	const calls: string[] = [];
	const tasks = new Map<string, TaskStatus>();
	const service: ApiService = {
		openTask: async (body): Promise<OpenResult> => {
			calls.push("openTask");
			const b = body as { graph_id?: string; node_id?: string; worktree?: string };
			if (!b.graph_id || !b.node_id) return { status: 400, body: { error: "graph_id is missing or invalid" } };
			if (b.worktree !== `${WORKTREES_ROOT}/${b.graph_id}`) return { status: 400, body: { error: "worktree must match" } };
			const key = `${b.graph_id}/${b.node_id}`;
			const existing = tasks.get(key);
			if (existing) return { status: 200, body: existing };
			// A field TaskRecord does not name (a later plan's) must reach the wire unchanged.
			const created = statusFor(b.graph_id, b.node_id, { resumes: 2 });
			tasks.set(key, created);
			return { status: 202, body: created };
		},
		status: async (gid, nid) => {
			calls.push(`status ${gid}/${nid}`);
			return tasks.get(`${gid}/${nid}`) ?? null;
		},
		list: async () => [...tasks.values()],
		terminate: async (gid, nid) => {
			calls.push(`terminate ${gid}/${nid}`);
			return tasks.has(`${gid}/${nid}`);
		},
		kill: async (gid, nid) => {
			calls.push(`kill ${gid}/${nid}`);
			return tasks.has(`${gid}/${nid}`);
		},
	};
	return { service, calls, tasks };
}

let server: Server;
let base: string;
const fake = fakeService();

beforeAll(async () => {
	server = createApiServer(fake.service, { engineReady: () => true });
	const { promise, resolve } = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => resolve());
	await promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	base = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
	server.close();
});

const post = (path: string, body?: string) =>
	fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body });

describe("substrate-host API", () => {
	test("GET /healthz reports engine and api", async () => {
		const res = await fetch(`${base}/healthz`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ engine: true, api: true });
	});

	test("POST /tasks answers 202 for a new task and 200 for the same task again", async () => {
		const body = JSON.stringify({
			graph_id: GID,
			node_id: NID,
			identifier: "TRC-1",
			repo: "swcstudiospace/agent-substrate",
			worktree: `${WORKTREES_ROOT}/${GID}`,
		});
		const first = await post("/tasks", body);
		expect(first.status).toBe(202);
		expect(((await first.json()) as TaskStatus).graph_id).toBe(GID);
		const second = await post("/tasks", body);
		expect(second.status).toBe(200);
		expect(((await second.json()) as TaskStatus).prompt_count).toBe(1);
	});

	test("POST /tasks with malformed JSON is 400 and a validation refusal passes through as 400", async () => {
		const bad = await post("/tasks", "{not json");
		expect(bad.status).toBe(400);
		expect(await bad.json()).toEqual({ error: "request body is not valid JSON" });
		const refused = await post("/tasks", JSON.stringify({ graph_id: GID, node_id: NID, worktree: "/tmp/x" }));
		expect(refused.status).toBe(400);
	});

	test("GET /tasks/<gid>/<nid> returns the status, 404 for an unknown task", async () => {
		const found = await fetch(`${base}/tasks/${GID}/${NID}`);
		expect(found.status).toBe(200);
		const status = (await found.json()) as TaskStatus;
		expect(status.node_id).toBe(NID);
		expect(status.state).toBe("running");
		expect((status as TaskStatus & { resumes?: number }).resumes).toBe(2);
		const missing = await fetch(`${base}/tasks/${GID}/n9`);
		expect(missing.status).toBe(404);
	});

	test("path segments failing the id patterns are 400 before the service is asked", async () => {
		const before = fake.calls.length;
		expect((await fetch(`${base}/tasks/..%2Fx/n1`)).status).toBe(400);
		expect((await fetch(`${base}/tasks/${GID}/n%201`)).status).toBe(400);
		expect((await post(`/tasks/${GID}/${"n".repeat(33)}/kill`)).status).toBe(400);
		expect(fake.calls.length).toBe(before);
	});

	test("GET /tasks lists every task", async () => {
		const res = await fetch(`${base}/tasks`);
		expect(res.status).toBe(200);
		expect(((await res.json()) as TaskStatus[]).map((t) => t.node_id)).toEqual([NID]);
	});

	test("terminate and kill answer 202 for a known task and 404 otherwise", async () => {
		expect((await post(`/tasks/${GID}/${NID}/terminate`)).status).toBe(202);
		expect((await post(`/tasks/${GID}/${NID}/kill`)).status).toBe(202);
		expect((await post(`/tasks/${GID}/n9/terminate`)).status).toBe(404);
		expect(fake.calls).toContain(`terminate ${GID}/${NID}`);
		expect(fake.calls).toContain(`kill ${GID}/${NID}`);
	});

	test("unknown routes are 404", async () => {
		expect((await fetch(`${base}/nope`)).status).toBe(404);
		expect((await post(`/tasks/${GID}/${NID}/pause`)).status).toBe(404);
	});
});
