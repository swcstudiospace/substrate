/**
 * The steering tools (phase 53, SOTA-09), with an in-memory audit sink. Covered: a non-allowlisted author and an agent-kind
 * author are refused; a queued directive is audited before it is listed and an acknowledgement after it is applied; a
 * conflicting directive is not applied without confirm; an unconfigured sink refuses every write and records nothing;
 * steering_list returns only the target session's directives. The last group drives the three tools through a real MCP
 * client: they are listed only while steering is on, an unknown field is refused, and a write with no sink answers
 * not-configured as an error while a read answers it as a plain reply.
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
	type SteeringQueueInput,
	type SteeringWiring,
} from "./steering-tools.ts";

const NOW = 1_800_000_000_000;

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

function wiringFor(history: SteeringHistorySink | null, allowlist: readonly string[] = ["alice"]): SteeringWiring {
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
		principal_id: "alice",
		author_kind: "human",
		priority: "normal",
		target_session_id: "sess-a",
		action: "redirect",
		body: "Stop the migration and review the schema first.",
		conflicts_with_active_plan: false,
		...overrides,
	};
}

describe("queueSteering", () => {
	test("refuses an author who is not on the allowlist, and records nothing", async () => {
		const sink = new MemorySink();
		const wiring = wiringFor(sink);

		const result = await queueSteering(wiring, queueInput({ principal_id: "mallory" }));

		expect(result).toEqual({ status: "refused", error: { code: "principal-not-allowed" } });
		expect(sink.entries).toEqual([]);
		expect(listSteering(wiring, { session_id: "sess-a" })).toEqual({ status: "listed", target_session_id: "sess-a", directives: [] });
	});

	test("refuses an agent-kind author even when the principal is allowlisted", async () => {
		const sink = new MemorySink();

		const result = await queueSteering(wiringFor(sink), queueInput({ author_kind: "agent" }));

		expect(result).toEqual({ status: "refused", error: { code: "agent-author-refused" } });
		expect(sink.entries).toEqual([]);
	});

	test("audits the queue before the directive is listed, and the acknowledgement after it", async () => {
		const sink = new MemorySink();
		const wiring = wiringFor(sink);

		expect(await queueSteering(wiring, queueInput())).toEqual({
			status: "queued",
			directive_id: "dir-1",
			target_session_id: "sess-a",
			queued_at_ms: NOW,
		});
		expect(sink.events()).toEqual(["queued"]);

		expect(await acknowledgeSteering(wiring, { directive_id: "dir-1", session_id: "sess-a", outcome: "declined" })).toEqual({
			status: "acknowledged",
			directive_id: "dir-1",
			outcome: "declined",
			confirmed: false,
		});
		expect(sink.events()).toEqual(["queued", "acknowledged"]);
	});

	test("holds the queue when its audit write fails, so nothing is listed", async () => {
		const sink = new MemorySink();
		sink.failing = true;
		const wiring = wiringFor(sink);

		expect(await queueSteering(wiring, queueInput())).toMatchObject({
			status: "refused",
			error: { code: "audit-unavailable", attempts: 2 },
		});
		expect(listSteering(wiring, { session_id: "sess-a" })).toEqual({ status: "listed", target_session_id: "sess-a", directives: [] });
	});
});

describe("acknowledgeSteering", () => {
	test("a conflicting directive is not applied without confirm, and is applied with it", async () => {
		const sink = new MemorySink();
		const wiring = wiringFor(sink);
		await queueSteering(wiring, queueInput({ id: "dir-2", conflicts_with_active_plan: true }));

		expect(await acknowledgeSteering(wiring, { directive_id: "dir-2", session_id: "sess-a", outcome: "applied" })).toEqual({
			status: "refused",
			error: { code: "confirmation-required" },
		});
		expect(sink.events()).toEqual(["queued"]);

		expect(
			await acknowledgeSteering(wiring, { directive_id: "dir-2", session_id: "sess-a", outcome: "applied", confirm: true }),
		).toEqual({ status: "acknowledged", directive_id: "dir-2", outcome: "applied", confirmed: true });
		expect(sink.events()).toEqual(["queued", "acknowledged"]);
	});

	test("an acknowledgement that cannot be audited leaves the directive queued", async () => {
		const sink = new MemorySink();
		const wiring = wiringFor(sink);
		await queueSteering(wiring, queueInput());

		sink.failing = true;
		expect(await acknowledgeSteering(wiring, { directive_id: "dir-1", session_id: "sess-a", outcome: "declined" })).toMatchObject({
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

		expect(await queueSteering(wiring, queueInput())).toEqual({ status: "not-configured" });
		expect(await acknowledgeSteering(wiring, { directive_id: "dir-1", session_id: "sess-a", outcome: "declined" })).toEqual({
			status: "not-configured",
		});
		expect(listSteering(wiring, { session_id: "sess-a" })).toEqual({ status: "not-configured" });
	});
});

describe("listSteering", () => {
	test("returns only the target session's directives, highest priority first", async () => {
		const sink = new MemorySink();
		const wiring = wiringFor(sink);
		await queueSteering(wiring, queueInput({ id: "dir-a1", target_session_id: "sess-a" }));
		await queueSteering(wiring, queueInput({ id: "dir-b1", target_session_id: "sess-b" }));
		await queueSteering(wiring, queueInput({ id: "dir-a2", target_session_id: "sess-a", priority: "high" }));

		expect(listSteering(wiring, { session_id: "sess-a" })).toMatchObject({
			status: "listed",
			target_session_id: "sess-a",
			directives: [{ id: "dir-a2", priority: "high" }, { id: "dir-a1" }],
		});
		expect(listSteering(wiring, { session_id: "sess-b" })).toMatchObject({ status: "listed", directives: [{ id: "dir-b1" }] });
	});

	test("an acknowledged directive leaves the list", async () => {
		const sink = new MemorySink();
		const wiring = wiringFor(sink);
		await queueSteering(wiring, queueInput({ id: "dir-a1" }));
		await queueSteering(wiring, queueInput({ id: "dir-a2" }));
		await acknowledgeSteering(wiring, { directive_id: "dir-a2", session_id: "sess-a", outcome: "applied" });

		expect(listSteering(wiring, { session_id: "sess-a" })).toMatchObject({ status: "listed", directives: [{ id: "dir-a1" }] });
	});
});

describe("the steering tools over MCP", () => {
	const CALLER: McpCaller = { surface: "omp", isOperator: false };
	const ENABLED = { SUBSTRATE_PLANNING_STEERING: "on", SUBSTRATE_PLANNING_STEERING_PRINCIPALS: "alice" };

	/** A substrate with the audit sink injected as `history`, or with no sink at all when `history` is undefined. */
	function substrateWith(env: Record<string, string | undefined>, history?: SteeringHistorySink | null) {
		return new Substrate(loadConfig(env), {
			index: null,
			greptime: null,
			planning: { presence: null, emit: async () => true },
			...(history === undefined ? {} : { steering: { history } }),
		});
	}

	async function connect(substrate: Substrate): Promise<Client> {
		const server = createMcpServer(substrate, CALLER);
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

	test("the three tools are listed only while steering is on", async () => {
		const off = await connect(substrateWith({}, null));
		expect((await off.listTools()).tools.map((tool) => tool.name)).not.toContain("steering_queue");

		const on = await connect(substrateWith(ENABLED, new MemorySink()));
		expect((await on.listTools()).tools.map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["steering_queue", "steering_acknowledge", "steering_list"]),
		);
	});

	test("a queued directive reaches the list through the MCP tools", async () => {
		const sink = new MemorySink();
		const client = await connect(substrateWith(ENABLED, sink));

		const queuedReply = await call(client, "steering_queue", {
			id: "dir-m1",
			principal_id: "alice",
			author_kind: "human",
			priority: "normal",
			target_session_id: "sess-a",
			action: "annotate",
			body: "Check the rollback plan.",
			conflicts_with_active_plan: false,
		});
		expect(queuedReply).toMatchObject({ isError: false, body: { status: "queued", directive_id: "dir-m1" } });
		expect(sink.events()).toEqual(["queued"]);

		expect(await call(client, "steering_list", { session_id: "sess-a" })).toMatchObject({
			isError: false,
			body: { status: "listed", directives: [{ id: "dir-m1" }] },
		});
	});

	test("an unknown field is refused at the boundary and records nothing", async () => {
		const sink = new MemorySink();
		const client = await connect(substrateWith(ENABLED, sink));

		const reply = await call(client, "steering_queue", {
			id: "dir-m2",
			principal_id: "alice",
			author_kind: "human",
			priority: "normal",
			target_session_id: "sess-a",
			action: "annotate",
			body: "Check the rollback plan.",
			conflicts_with_active_plan: false,
			unexpected: true,
		});

		expect(reply.isError).toBe(true);
		expect(sink.entries).toEqual([]);
	});

	test("a write with no audit sink answers not-configured as an error, and a read answers it as a plain reply", async () => {
		const client = await connect(substrateWith(ENABLED, null));

		expect(
			await call(client, "steering_queue", {
				id: "dir-m3",
				principal_id: "alice",
				author_kind: "human",
				priority: "normal",
				target_session_id: "sess-a",
				action: "annotate",
				body: "Check the rollback plan.",
				conflicts_with_active_plan: false,
			}),
		).toMatchObject({ isError: true, body: { status: "not-configured" } });
		expect(await call(client, "steering_list", { session_id: "sess-a" })).toMatchObject({
			isError: false,
			body: { status: "not-configured" },
		});
	});
});
