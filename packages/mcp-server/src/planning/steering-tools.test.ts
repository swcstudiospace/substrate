/**
 * The steering tools (phase 53, SOTA-09), with an in-memory audit sink and a fake caller context. Covered: only an operator
 * caller may queue or acknowledge; a non-operator or agent caller is refused even when its surface is allowlisted; the
 * principal is the caller's surface and the author is human; the allowlist is a second check; a conflicting directive is
 * not applied without confirm; an unconfigured sink refuses every write and records nothing; steering_list returns only the
 * target session's directives. The last group drives the tools through a real MCP client: an argument that tries to name
 * an author is refused, and a write with no sink answers not-configured as an error while a read answers it as a plain reply.
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../config.ts";
import { createMcpServer, type McpCaller } from "../mcp.ts";
import { Substrate } from "../service.ts";
import { type SteeringAuditEntry, SteeringInbox, type SteeringHistorySink } from "./steering.ts";
import {
	acknowledgeSteering,
	listSteering,
	queueSteering,
	type SteeringCaller,
	type SteeringQueueInput,
	type SteeringWiring,
} from "./steering-tools.ts";

const NOW = 1_800_000_000_000;
const OPERATOR: SteeringCaller = { surface: "omp", isOperator: true };

/** An audit sink that keeps every entry in order, and can be made to fail. */
class MemorySink implements SteeringHistorySink {
	readonly entries: SteeringAuditEntry[] = [];
	failing = false;

	async append(entry: SteeringAuditEntry): Promise<void> {
		if (this.failing) throw new Error("sink unavailable");
		this.entries.push(entry);
	}

	events(): string[] {
		return this.entries.map((entry) => entry.event);
	}
}

function wiringFor(history: SteeringHistorySink | null, allowlist: readonly string[] = ["omp"]): SteeringWiring {
	const clock = { nowMs: () => NOW };
	return {
		enabled: true,
		clock,
		inbox: history === null ? null : new SteeringInbox({ history, clock, policy: { allowlist, ratePerMin: 10 } }),
	};
}

function queueInput(overrides: Partial<SteeringQueueInput> = {}): SteeringQueueInput {
	return {
		id: "dir-1",
		target_session_id: "sess-a",
		action: "redirect",
		priority: "normal",
		body: "Stop the migration and review the schema first.",
		conflicts_with_active_plan: false,
		...overrides,
	};
}

describe("queueSteering", () => {
	test("refuses a non-operator caller, even when its surface is on the allowlist, and records nothing", async () => {
		const sink = new MemorySink();
		const wiring = wiringFor(sink);

		const result = await queueSteering(wiring, { surface: "omp", isOperator: false }, queueInput());

		expect(result).toEqual({ status: "forbidden", reason: "operator-required" });
		expect(sink.entries).toEqual([]);
		expect(listSteering(wiring, { session_id: "sess-a" })).toEqual({ status: "listed", target_session_id: "sess-a", directives: [] });
	});

	test("refuses an agent surface that is allowlisted, because it is not an operator", async () => {
		const sink = new MemorySink();

		const result = await queueSteering(wiringFor(sink, ["claude-code"]), { surface: "claude-code", isOperator: false }, queueInput());

		expect(result).toEqual({ status: "forbidden", reason: "operator-required" });
		expect(sink.entries).toEqual([]);
	});

	test("refuses a bare local run with no surface, since there is no identity to authorise", async () => {
		const sink = new MemorySink();

		expect(await queueSteering(wiringFor(sink), { surface: null, isOperator: true }, queueInput())).toEqual({
			status: "forbidden",
			reason: "caller-identity-missing",
		});
		expect(sink.entries).toEqual([]);
	});

	test("the second check still refuses an operator whose surface is not on the allowlist", async () => {
		const sink = new MemorySink();

		expect(await queueSteering(wiringFor(sink, ["omp"]), { surface: "codex", isOperator: true }, queueInput())).toEqual({
			status: "refused",
			error: { code: "principal-not-allowed" },
		});
		expect(sink.entries).toEqual([]);
	});

	test("the principal is the operator's surface and the author is human", async () => {
		const sink = new MemorySink();

		expect(await queueSteering(wiringFor(sink), OPERATOR, queueInput())).toEqual({
			status: "queued",
			directive_id: "dir-1",
			target_session_id: "sess-a",
			queued_at_ms: NOW,
		});
		expect(sink.entries[0]).toMatchObject({ event: "queued", directive: { author: { principalId: "omp", kind: "human" } } });
	});

	test("audits the queue before the directive is listed, and holds the queue when the audit fails", async () => {
		const sink = new MemorySink();
		sink.failing = true;
		const wiring = wiringFor(sink);

		expect(await queueSteering(wiring, OPERATOR, queueInput())).toMatchObject({
			status: "refused",
			error: { code: "audit-unavailable", attempts: 2 },
		});
		expect(listSteering(wiring, { session_id: "sess-a" })).toEqual({ status: "listed", target_session_id: "sess-a", directives: [] });
	});
});

describe("acknowledgeSteering", () => {
	test("refuses a non-operator caller and leaves the directive queued", async () => {
		const sink = new MemorySink();
		const wiring = wiringFor(sink);
		await queueSteering(wiring, OPERATOR, queueInput());

		expect(
			await acknowledgeSteering(wiring, { surface: "omp", isOperator: false }, { directive_id: "dir-1", session_id: "sess-a", outcome: "declined" }),
		).toEqual({ status: "forbidden", reason: "operator-required" });
		expect(sink.events()).toEqual(["queued"]);
	});

	test("a conflicting directive is not applied without confirm, and is applied with it", async () => {
		const sink = new MemorySink();
		const wiring = wiringFor(sink);
		await queueSteering(wiring, OPERATOR, queueInput({ id: "dir-2", conflicts_with_active_plan: true }));

		expect(await acknowledgeSteering(wiring, OPERATOR, { directive_id: "dir-2", session_id: "sess-a", outcome: "applied" })).toEqual({
			status: "refused",
			error: { code: "confirmation-required" },
		});
		expect(sink.events()).toEqual(["queued"]);

		expect(
			await acknowledgeSteering(wiring, OPERATOR, { directive_id: "dir-2", session_id: "sess-a", outcome: "applied", confirm: true }),
		).toEqual({ status: "acknowledged", directive_id: "dir-2", outcome: "applied", confirmed: true });
		expect(sink.events()).toEqual(["queued", "acknowledged"]);
	});

	test("an acknowledgement that cannot be audited leaves the directive queued", async () => {
		const sink = new MemorySink();
		const wiring = wiringFor(sink);
		await queueSteering(wiring, OPERATOR, queueInput());

		sink.failing = true;
		expect(await acknowledgeSteering(wiring, OPERATOR, { directive_id: "dir-1", session_id: "sess-a", outcome: "declined" })).toMatchObject({
			status: "refused",
			error: { code: "audit-unavailable" },
		});

		sink.failing = false;
		expect(listSteering(wiring, { session_id: "sess-a" })).toMatchObject({ status: "listed", directives: [{ id: "dir-1" }] });
	});
});

describe("with no audit sink", () => {
	test("every write answers not-configured, and nothing is recorded", async () => {
		const wiring = wiringFor(null);

		expect(await queueSteering(wiring, OPERATOR, queueInput())).toEqual({ status: "not-configured" });
		expect(await acknowledgeSteering(wiring, OPERATOR, { directive_id: "dir-1", session_id: "sess-a", outcome: "declined" })).toEqual({
			status: "not-configured",
		});
		expect(listSteering(wiring, { session_id: "sess-a" })).toEqual({ status: "not-configured" });
	});
});

describe("listSteering", () => {
	test("returns only the target session's directives, highest priority first", async () => {
		const sink = new MemorySink();
		const wiring = wiringFor(sink);
		await queueSteering(wiring, OPERATOR, queueInput({ id: "dir-a1", target_session_id: "sess-a" }));
		await queueSteering(wiring, OPERATOR, queueInput({ id: "dir-b1", target_session_id: "sess-b" }));
		await queueSteering(wiring, OPERATOR, queueInput({ id: "dir-a2", target_session_id: "sess-a", priority: "high" }));

		expect(listSteering(wiring, { session_id: "sess-a" })).toMatchObject({
			status: "listed",
			target_session_id: "sess-a",
			directives: [{ id: "dir-a2", priority: "high" }, { id: "dir-a1" }],
		});
		expect(listSteering(wiring, { session_id: "sess-b" })).toMatchObject({ status: "listed", directives: [{ id: "dir-b1" }] });
	});

	test("a queued-then-acknowledged directive is still listed, with state acknowledged and its outcome", async () => {
		const sink = new MemorySink();
		const wiring = wiringFor(sink);
		await queueSteering(wiring, OPERATOR, queueInput({ id: "dir-a1" }));
		await queueSteering(wiring, OPERATOR, queueInput({ id: "dir-a2" }));
		await acknowledgeSteering(wiring, OPERATOR, { directive_id: "dir-a2", session_id: "sess-a", outcome: "declined" });

		expect(listSteering(wiring, { session_id: "sess-a" })).toMatchObject({
			status: "listed",
			directives: [
				{ id: "dir-a1", state: "queued", outcome: null, confirmed: false, acknowledged_at_ms: null },
				{ id: "dir-a2", state: "acknowledged", outcome: "declined", confirmed: false, acknowledged_at_ms: NOW },
			],
		});
	});

	test("an acknowledged directive from another session is not listed for this one", async () => {
		const sink = new MemorySink();
		const wiring = wiringFor(sink);
		await queueSteering(wiring, OPERATOR, queueInput({ id: "dir-b1", target_session_id: "sess-b" }));
		await acknowledgeSteering(wiring, OPERATOR, { directive_id: "dir-b1", session_id: "sess-b", outcome: "applied", confirm: true });

		expect(listSteering(wiring, { session_id: "sess-a" })).toEqual({ status: "listed", target_session_id: "sess-a", directives: [] });
	});
});

describe("the steering tools over MCP", () => {
	const ENABLED = { SUBSTRATE_PLANNING_STEERING: "on", SUBSTRATE_PLANNING_STEERING_PRINCIPALS: "omp" };

	/** A substrate with the audit sink injected as `history`, or with no sink at all when `history` is undefined. */
	function substrateWith(env: Record<string, string | undefined>, history?: SteeringHistorySink | null) {
		return new Substrate(loadConfig(env), {
			index: null,
			greptime: null,
			planning: { presence: null, emit: async () => true },
			...(history === undefined ? {} : { steering: { history } }),
		});
	}

	async function connect(substrate: Substrate, caller: McpCaller): Promise<Client> {
		const server = createMcpServer(substrate, caller);
		const client = new Client({ name: "steering-test", version: "0.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		return client;
	}

	async function call(client: Client, name: string, args: Record<string, unknown>) {
		const result = await client.callTool({ name, arguments: args });
		const content = result.content as Array<{ type: string; text?: string }>;
		return { isError: result.isError === true, body: JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown> };
	}

	const QUEUE_ARGS = {
		id: "dir-m1",
		target_session_id: "sess-a",
		action: "annotate",
		priority: "normal",
		body: "Check the rollback plan.",
		conflicts_with_active_plan: false,
	};

	test("the three tools are listed only while steering is on", async () => {
		const off = await connect(substrateWith({}, null), { surface: "omp", isOperator: true });
		expect((await off.listTools()).tools.map((tool) => tool.name)).not.toContain("steering_queue");

		const on = await connect(substrateWith(ENABLED, new MemorySink()), { surface: "omp", isOperator: true });
		expect((await on.listTools()).tools.map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["steering_queue", "steering_acknowledge", "steering_list"]),
		);
	});

	test("an operator's directive reaches the list through the MCP tools", async () => {
		const sink = new MemorySink();
		const client = await connect(substrateWith(ENABLED, sink), { surface: "omp", isOperator: true });

		expect(await call(client, "steering_queue", QUEUE_ARGS)).toMatchObject({
			isError: false,
			body: { status: "queued", directive_id: "dir-m1" },
		});
		expect(sink.events()).toEqual(["queued"]);
		expect(await call(client, "steering_list", { session_id: "sess-a" })).toMatchObject({
			isError: false,
			body: { status: "listed", directives: [{ id: "dir-m1", author_principal_id: "omp" }] },
		});
	});

	test("a non-operator caller is refused even when its arguments name an allowlisted principal", async () => {
		const sink = new MemorySink();
		const client = await connect(substrateWith(ENABLED, sink), { surface: "omp", isOperator: false });

		expect(await call(client, "steering_queue", QUEUE_ARGS)).toMatchObject({
			isError: true,
			body: { status: "forbidden", reason: "operator-required" },
		});
		expect(sink.entries).toEqual([]);
	});

	test("an argument that tries to name the author is refused at the boundary and records nothing", async () => {
		const sink = new MemorySink();
		const client = await connect(substrateWith(ENABLED, sink), { surface: "omp", isOperator: true });

		for (const extra of [{ principal_id: "omp" }, { author_kind: "human" }]) {
			expect((await call(client, "steering_queue", { ...QUEUE_ARGS, ...extra })).isError).toBe(true);
		}
		expect(sink.entries).toEqual([]);
	});

	test("a write with no audit sink answers not-configured as an error, and a read answers it as a plain reply", async () => {
		const client = await connect(substrateWith(ENABLED, null), { surface: "omp", isOperator: true });

		expect(await call(client, "steering_queue", QUEUE_ARGS)).toMatchObject({ isError: true, body: { status: "not-configured" } });
		expect(await call(client, "steering_list", { session_id: "sess-a" })).toMatchObject({
			isError: false,
			body: { status: "not-configured" },
		});
	});
});
