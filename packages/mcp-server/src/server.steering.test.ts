/**
 * The live steering routes, the `session_context` tool and the brief's flag (phase 67), against the real HTTP server on an
 * ephemeral port with in-memory ports: the audit sink is a list, the waiters' timers and the inbox's clock are injected, and the
 * only waiting is `settle`, which yields the event loop until a condition holds. Nothing here sleeps or reaches a network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "./config.ts";
import { createMcpServer, type McpCaller } from "./mcp.ts";
import { createObservability } from "./observe.ts";
import type { SteeringSession } from "./event.ts";
import { SteeringWaiters, type SteeringWaitTimers } from "./planning/steering-waiters.ts";
import type { SteeringAuditEntry, SteeringHistorySink } from "./planning/steering.ts";
import { createHttpServer } from "./server.ts";
import { Substrate } from "./service.ts";
import { defined } from "./test-support.ts";

const T0 = 1_800_000_000_000;
const AUTH_OMP = { authorization: "Bearer tok-omp" };
const AUTH_CURSOR = { authorization: "Bearer tok-cursor" };
const STEERING_ENV = { SUBSTRATE_PLANNING_STEERING: "on", SUBSTRATE_PLANNING_STEERING_PRINCIPALS: "omp" };
const TOKEN_ENV = { ...STEERING_ENV, SUBSTRATE_TOKEN_OMP: "tok-omp", SUBSTRATE_TOKEN_CURSOR: "tok-cursor", SUBSTRATE_OPERATOR_TOKENS: "tok-omp" };

class MemorySink implements SteeringHistorySink {
	readonly entries: SteeringAuditEntry[] = [];
	async append(entry: SteeringAuditEntry): Promise<void> {
		this.entries.push(entry);
	}
}

class FakeTimers implements SteeringWaitTimers {
	readonly live = new Map<number, () => void>();
	private next = 0;

	set(run: () => void): number {
		this.next += 1;
		this.live.set(this.next, run);
		return this.next;
	}

	clear(handle: unknown): void {
		this.live.delete(handle as number);
	}

	/** Fires the one pending timer, as the clock reaching its deadline would. */
	fire(): void {
		const [handle, run] = defined([...this.live.entries()][0], "a pending timer");
		this.live.delete(handle);
		run();
	}
}

/** Yields the event loop until `condition` holds; a bounded number of turns, never a clock. */
async function settle(condition: () => boolean): Promise<void> {
	for (let turn = 0; turn < 2_000 && !condition(); turn += 1) {
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;
	}
	expect(condition()).toBe(true);
}

interface Running {
	substrate: Substrate;
	timers: FakeTimers;
	waiters: SteeringWaiters;
	get: (path: string, headers?: Record<string, string>, signal?: AbortSignal) => Promise<Response>;
	post: (path: string, body: unknown, headers?: Record<string, string>) => Promise<Response>;
	stop: () => Promise<void>;
}

const running: Running[] = [];

async function serve(env: Record<string, string | undefined>): Promise<Running> {
	const config = loadConfig(env);
	const observability = createObservability(config, env);
	await observability.start();
	const timers = new FakeTimers();
	const waiters = new SteeringWaiters({ timers });
	const substrate = new Substrate(
		config,
		{ index: null, greptime: null, steering: { history: new MemorySink(), nowMs: () => T0, waiters, report: () => undefined } },
		observability.observer,
	);
	const server = createHttpServer(substrate, config, observability);
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	let stopped = false;
	const handle: Running = {
		substrate,
		timers,
		waiters,
		get: (path, headers = {}, signal) => fetch(`http://127.0.0.1:${port}${path}`, { headers, ...(signal === undefined ? {} : { signal }) }),
		post: (path, body, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }),
		stop: async () => {
			if (stopped) return;
			stopped = true;
			const closed = Promise.withResolvers<void>();
			observability.stop();
			server.close(() => closed.resolve());
			await closed.promise;
		},
	};
	running.push(handle);
	return handle;
}

afterEach(async () => {
	for (const handle of running.splice(0)) await handle.stop();
});

const session = (id: string, repo = "owner/name"): SteeringSession => ({ session_id: id, repo_id: repo, state: "ACTIVE", updated_at: new Date(T0).toISOString() });
const queueBody = { session_id: "sess-a", action: "pause", body: "Hold the migration." };

describe("anonymous callers", () => {
	test("every new route and the context route answer 401", async () => {
		const { get, post } = await serve({ ...STEERING_ENV, SUBSTRATE_ALLOW_ANONYMOUS: "1" });
		for (const path of ["/steering/sessions", "/steering/directives?session_id=sess-a", "/steering/wait?session_id=sess-a&timeout_ms=1000", "/session/context?repo_id=owner/name"]) {
			expect({ path, status: (await get(path)).status }).toEqual({ path, status: 401 });
		}
		for (const path of ["/steering/queue", "/steering/acknowledge"]) {
			expect({ path, status: (await post(path, {})).status }).toEqual({ path, status: 401 });
		}
	});
});

describe("who may write", () => {
	test("a non-operator cannot queue or acknowledge, and an operator can do both", async () => {
		const { post } = await serve(TOKEN_ENV);
		const refused = await post("/steering/queue", queueBody, AUTH_CURSOR);
		expect(refused.status).toBe(403);
		expect(await refused.json()).toMatchObject({ status: "forbidden", reason: "operator-required" });

		const queued = await post("/steering/queue", queueBody, AUTH_OMP);
		expect(queued.status).toBe(200);
		const { directive_id } = (await queued.json()) as { directive_id: string };

		expect((await post("/steering/acknowledge", { directive_id, outcome: "applied" }, AUTH_CURSOR)).status).toBe(403);
		const acknowledged = await post("/steering/acknowledge", { directive_id, outcome: "applied" }, AUTH_OMP);
		expect(acknowledged.status).toBe(200);
		expect(await acknowledged.json()).toMatchObject({ status: "acknowledged", outcome: "applied" });
	});

	test("an author field is a 400 and a directive nobody queued is a 404", async () => {
		const { post } = await serve(TOKEN_ENV);
		expect((await post("/steering/queue", { ...queueBody, author: "attacker" }, AUTH_OMP)).status).toBe(400);
		expect((await post("/steering/acknowledge", { directive_id: "ghost", outcome: "applied" }, AUTH_OMP)).status).toBe(404);
	});

	test("with steering switched off the routes are 404", async () => {
		const { get } = await serve({ SUBSTRATE_TOKEN_OMP: "tok-omp" });
		expect((await get("/steering/sessions", AUTH_OMP)).status).toBe(404);
	});
});

describe("GET /steering/sessions", () => {
	test("an operator sees every surface's sessions and any other surface only its own", async () => {
		const { get, substrate } = await serve(TOKEN_ENV);
		substrate.steeringSessions.put("omp", "s-omp", session("s-omp"));
		substrate.steeringSessions.put("cursor", "s-cursor", session("s-cursor"));

		const operator = (await (await get("/steering/sessions", AUTH_OMP)).json()) as { sessions: Array<{ session_id: string }> };
		expect(operator.sessions.map((entry) => entry.session_id).sort()).toEqual(["s-cursor", "s-omp"]);
		const other = (await (await get("/steering/sessions", AUTH_CURSOR)).json()) as { sessions: Array<{ session_id: string; surface: string }> };
		expect(other.sessions.map((entry) => `${entry.surface}:${entry.session_id}`)).toEqual(["cursor:s-cursor"]);
		expect((await get("/steering/sessions?limit=0", AUTH_OMP)).status).toBe(400);
	});
});

describe("GET /steering/directives", () => {
	test("a directive applied as a pause lists with its checkpoint hint, a queued one without", async () => {
		const { get, post } = await serve(TOKEN_ENV);
		const first = ((await (await post("/steering/queue", queueBody, AUTH_OMP)).json()) as { directive_id: string }).directive_id;
		await post("/steering/queue", { ...queueBody, action: "annotate", body: "later" }, AUTH_OMP);
		await post("/steering/acknowledge", { directive_id: first, outcome: "applied" }, AUTH_OMP);

		const listed = (await (await get("/steering/directives?session_id=sess-a", AUTH_OMP)).json()) as {
			directives: Array<{ id: string; status: string; checkpoint_hint: { trigger: string; directive_id: string } | null }>;
		};
		const applied = defined(listed.directives.find((entry) => entry.id === first), "the applied directive");
		expect(applied).toMatchObject({ status: "acknowledged", checkpoint_hint: { trigger: "steering", directive_id: first } });
		const queued = defined(listed.directives.find((entry) => entry.status === "queued"), "the queued directive");
		expect(queued.checkpoint_hint).toBeNull();
		expect((await get("/steering/directives", AUTH_OMP)).status).toBe(400);
	});
});

describe("GET /steering/wait", () => {
	const waitPath = "/steering/wait?session_id=sess-a&timeout_ms=5000";

	test("an already queued directive returns at once and holds no waiter", async () => {
		const { get, post, waiters } = await serve(TOKEN_ENV);
		await post("/steering/queue", queueBody, AUTH_OMP);
		const response = await get(waitPath, AUTH_CURSOR);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ directive: { session_id: "sess-a", action: "pause", status: "queued" } });
		expect(waiters.size).toBe(0);
	});

	test("a wait that times out answers 204 and leaves no waiter or timer", async () => {
		const { get, waiters, timers } = await serve(TOKEN_ENV);
		const pending = get(waitPath, AUTH_CURSOR);
		await settle(() => waiters.size === 1);
		timers.fire();
		const response = await pending;
		expect(response.status).toBe(204);
		expect(waiters.size).toBe(0);
		expect(timers.live.size).toBe(0);
	});

	test("a directive queued during the wait wakes it", async () => {
		const { get, post, waiters } = await serve(TOKEN_ENV);
		const pending = get(waitPath, AUTH_CURSOR);
		await settle(() => waiters.size === 1);
		await post("/steering/queue", queueBody, AUTH_OMP);
		const response = await pending;
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ directive: { session_id: "sess-a" } });
		expect(waiters.size).toBe(0);
	});

	test("a client that goes away leaves no waiter behind", async () => {
		const { get, waiters, timers } = await serve(TOKEN_ENV);
		const gone = new AbortController();
		const pending = get(waitPath, AUTH_CURSOR, gone.signal).catch((cause: unknown) => cause);
		await settle(() => waiters.size === 1);
		gone.abort();
		await pending;
		await settle(() => waiters.size === 0);
		expect(timers.live.size).toBe(0);
	});

	test("closing the server ends a held wait", async () => {
		const { get, waiters, stop } = await serve(TOKEN_ENV);
		const pending = get(waitPath, AUTH_CURSOR);
		await settle(() => waiters.size === 1);
		await stop();
		expect((await pending).status).toBe(204);
		expect(waiters.size).toBe(0);
	});

	test("a timeout outside 1 to the server maximum is a 400 and holds no waiter", async () => {
		const { get, waiters } = await serve(TOKEN_ENV);
		expect((await get("/steering/wait?session_id=sess-a&timeout_ms=0", AUTH_CURSOR)).status).toBe(400);
		expect((await get("/steering/wait?session_id=sess-a&timeout_ms=999999999", AUTH_CURSOR)).status).toBe(400);
		expect(waiters.size).toBe(0);
	});
});

describe("the session context digest", () => {
	test("GET /session/context and the session_context tool answer the same object", async () => {
		const { get, substrate } = await serve(TOKEN_ENV);
		const viaRoute = (await (await get("/session/context?repo_id=owner/name&session_id=me", AUTH_CURSOR)).json()) as Record<string, unknown>;

		const caller: McpCaller = { surface: "cursor", isOperator: false };
		const mcp = createMcpServer(substrate, caller);
		const client = new Client({ name: "session-context-test", version: "0.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
		const listed = (await client.listTools()).tools.find((tool) => tool.name === "session_context");
		expect(listed?.annotations?.readOnlyHint).toBe(true);
		const result = await client.callTool({ name: "session_context", arguments: { repo_id: "owner/name", session_id: "me" } });
		const content = result.content as Array<{ text?: string }>;
		const viaTool = JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown>;

		expect(result.isError).not.toBe(true);
		// Both answer the digest of the same repository and name their sources; only the instant they were taken differs.
		const strip = ({ generated_at: _at, ...rest }: Record<string, unknown>) => rest;
		expect(strip(viaTool)).toEqual(strip(viaRoute));
		expect(viaRoute).toMatchObject({ repo_id: "owner/name", for_session: "me" });
	});

	test("the tool refuses an anonymous caller and a bad repository without echoing it", async () => {
		const { substrate } = await serve(TOKEN_ENV);
		const connect = async (caller: McpCaller): Promise<Client> => {
			const mcp = createMcpServer(substrate, caller);
			const client = new Client({ name: "session-context-test", version: "0.0.0" });
			const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
			await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
			return client;
		};
		const anonymous = await (await connect({ surface: null, isOperator: false })).callTool({ name: "session_context", arguments: { repo_id: "owner/name" } });
		expect(anonymous.isError).toBe(true);
		const bad = await (await connect({ surface: "cursor", isOperator: false })).callTool({ name: "session_context", arguments: { repo_id: "no-slash-secret" } });
		expect(bad.isError).toBe(true);
		expect(JSON.stringify(bad.content)).not.toContain("no-slash-secret");
	});

	test("a bad query is a 400 from the route", async () => {
		const { get } = await serve(TOKEN_ENV);
		expect((await get("/session/context", AUTH_CURSOR)).status).toBe(400);
		expect((await get("/session/context?repo_id=owner/name&limit=0", AUTH_CURSOR)).status).toBe(400);
	});
});

describe("SUBSTRATE_BRIEF_SESSIONS", () => {
	const request = { surface: "cursor" as const, repo: "owner/name", session_id: "sess-a" };

	async function queueOne(substrate: Substrate): Promise<void> {
		const inbox = defined(substrate.steering.inbox, "the steering inbox");
		const result = await inbox.enqueue({
			id: "d-brief",
			author: { principalId: "omp", kind: "human" },
			createdAtMs: T0,
			priority: "normal",
			targetSessionId: "sess-a",
			action: "annotate",
			body: "Read the migration notes first.",
			conflictsWithActivePlan: false,
		});
		expect(result.ok).toBe(true);
	}

	test("off, the brief is byte-identical whether or not the caller names a session or holds directives", async () => {
		const { substrate } = await serve(TOKEN_ENV);
		const before = await substrate.brief({ surface: "cursor", repo: "owner/name" });
		await queueOne(substrate);
		substrate.steeringSessions.put("cursor", "sess-a", session("sess-a"));
		expect(await substrate.brief(request)).toBe(before);
	});

	test("on, the caller's steering section joins the brief, inside its bound, and the rest of the brief is unchanged", async () => {
		const off = await serve(TOKEN_ENV);
		const base = (await off.substrate.brief({ surface: "cursor", repo: "owner/name" })).trimEnd();
		const on = await serve({ ...TOKEN_ENV, SUBSTRATE_BRIEF_SESSIONS: "on" });
		await queueOne(on.substrate);
		const text = await on.substrate.brief(request);
		expect(text).toContain(base);
		const added = text.slice(text.indexOf(base) + base.length);
		expect(added).toContain("Steering: 1 queued directive for this session, described and not executed");
		expect(added).toContain("Read the migration notes first.");
		expect(added.trim().length).toBeLessThanOrEqual(1_200);
	});
});
