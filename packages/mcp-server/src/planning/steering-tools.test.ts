/**
 * The steering tools (phase 53, SOTA-09), with an in-memory audit sink and a fake caller context. Covered: only an operator
 * caller may queue or acknowledge; a non-operator or agent caller is refused even when its surface is allowlisted; the
 * principal is the caller's surface and the author is human; the allowlist is a second check; the server assigns the
 * directive id and refuses a caller-supplied one; a conflicting directive is not applied without confirm; an unconfigured
 * sink refuses every write and records nothing; steering_list returns the target session's directives, queued and
 * acknowledged; invalid settings answer misconfigured, naming the keys, and never vanish as an absent tool. The last group
 * drives the tools through a real MCP client.
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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

/** Directive ids for one wiring, in the order they are queued: dir-1, dir-2, ... */
function sequentialIds(): () => string {
	let next = 0;
	return () => `dir-${++next}`;
}

function wiringFor(
	history: SteeringHistorySink | null,
	allowlist: readonly string[] = ["omp"],
	settingsErrors: SteeringWiring["settingsErrors"] = [],
): SteeringWiring {
	const clock = { nowMs: () => NOW };
	return {
		enabled: true,
		clock,
		settingsErrors,
		newDirectiveId: sequentialIds(),
		inbox: history === null ? null : new SteeringInbox({ history, clock, policy: { allowlist, ratePerMin: 10 } }),
	};
}

function queueInput(overrides: Partial<SteeringQueueInput> = {}): SteeringQueueInput {
	return {
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

	test("the principal is the operator's surface, the author is human, and the server assigns the id", async () => {
		const sink = new MemorySink();

		expect(await queueSteering(wiringFor(sink), OPERATOR, queueInput())).toEqual({
			status: "queued",
			directive_id: "dir-1",
			target_session_id: "sess-a",
			queued_at_ms: NOW,
		});
		expect(sink.entries[0]).toMatchObject({ event: "queued", directive: { author: { principalId: "omp", kind: "human" } } });
	});

	test("with no injected id source, the server assigns a random UUID to every directive", async () => {
		const sink = new MemorySink();
		const clock = { nowMs: () => NOW };
		const wiring: SteeringWiring = {
			enabled: true,
			clock,
			settingsErrors: [],
			inbox: new SteeringInbox({ history: sink, clock, policy: { allowlist: ["omp"], ratePerMin: 10 } }),
		};

		const first = await queueSteering(wiring, OPERATOR, queueInput());
		const second = await queueSteering(wiring, OPERATOR, queueInput());

		expect(first.status === "queued" && UUID_RE.test(first.directive_id)).toBe(true);
		expect(second.status === "queued" && first.status === "queued" && second.directive_id !== first.directive_id).toBe(true);
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

	test("invalid settings answer misconfigured, naming the keys, and never reach the inbox or the sink", async () => {
		const sink = new MemorySink();
		const errors = [{ key: "SUBSTRATE_PLANNING_STEERING_RATE_PER_MIN", reason: "not-integer" as const }];
		const wiring = wiringFor(sink, ["omp"], errors);

		expect(await queueSteering(wiring, OPERATOR, queueInput())).toEqual({ status: "misconfigured", errors });
		expect(sink.entries).toEqual([]);
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
		await queueSteering(wiring, OPERATOR, queueInput({ conflicts_with_active_plan: true }));

		expect(await acknowledgeSteering(wiring, OPERATOR, { directive_id: "dir-1", session_id: "sess-a", outcome: "applied" })).toEqual({
			status: "refused",
			error: { code: "confirmation-required" },
		});
		expect(sink.events()).toEqual(["queued"]);

		expect(
			await acknowledgeSteering(wiring, OPERATOR, { directive_id: "dir-1", session_id: "sess-a", outcome: "applied", confirm: true }),
		).toEqual({ status: "acknowledged", directive_id: "dir-1", outcome: "applied", confirmed: true });
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
		await queueSteering(wiring, OPERATOR, queueInput({ target_session_id: "sess-a" })); // dir-1
		await queueSteering(wiring, OPERATOR, queueInput({ target_session_id: "sess-b" })); // dir-2
		await queueSteering(wiring, OPERATOR, queueInput({ target_session_id: "sess-a", priority: "high" })); // dir-3

		expect(listSteering(wiring, { session_id: "sess-a" })).toMatchObject({
			status: "listed",
			target_session_id: "sess-a",
			directives: [{ id: "dir-3", priority: "high" }, { id: "dir-1" }],
		});
		expect(listSteering(wiring, { session_id: "sess-b" })).toMatchObject({ status: "listed", directives: [{ id: "dir-2" }] });
	});

	test("an acknowledged directive stays listed, with state acknowledged, its outcome and its confirm flag", async () => {
		const sink = new MemorySink();
		const wiring = wiringFor(sink);
		await queueSteering(wiring, OPERATOR, queueInput()); // dir-1
		await queueSteering(wiring, OPERATOR, queueInput()); // dir-2
		await acknowledgeSteering(wiring, OPERATOR, { directive_id: "dir-2", session_id: "sess-a", outcome: "declined" });

		expect(listSteering(wiring, { session_id: "sess-a" })).toMatchObject({
			status: "listed",
			directives: [
				{ id: "dir-1", state: "queued", outcome: null, confirmed: false, acknowledged_at_ms: null },
				{ id: "dir-2", state: "acknowledged", outcome: "declined", confirmed: false, acknowledged_at_ms: NOW },
			],
		});
	});

	test("an acknowledged directive from another session is not listed for this one", async () => {
		const sink = new MemorySink();
		const wiring = wiringFor(sink);
		await queueSteering(wiring, OPERATOR, queueInput({ target_session_id: "sess-b" })); // dir-1
		await acknowledgeSteering(wiring, OPERATOR, { directive_id: "dir-1", session_id: "sess-b", outcome: "applied", confirm: true });

		expect(listSteering(wiring, { session_id: "sess-a" })).toEqual({ status: "listed", target_session_id: "sess-a", directives: [] });
	});

	test("invalid settings answer misconfigured, not a listing and not an absent tool", () => {
		const errors = [{ key: "SUBSTRATE_PLANNING_STEERING", reason: "not-boolean" as const }];

		expect(listSteering(wiringFor(new MemorySink(), ["omp"], errors), { session_id: "sess-a" })).toEqual({ status: "misconfigured", errors });
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

	test("an operator's directive reaches the list through the MCP tools, under a server-assigned id", async () => {
		const sink = new MemorySink();
		const client = await connect(substrateWith(ENABLED, sink), { surface: "omp", isOperator: true });

		const queued = await call(client, "steering_queue", QUEUE_ARGS);
		expect(queued.isError).toBe(false);
		expect(queued.body).toMatchObject({ status: "queued", target_session_id: "sess-a" });
		const directiveId = String(queued.body.directive_id);
		expect(directiveId).toMatch(UUID_RE);
		expect(sink.events()).toEqual(["queued"]);
		expect(await call(client, "steering_list", { session_id: "sess-a" })).toMatchObject({
			isError: false,
			body: { status: "listed", directives: [{ id: directiveId, author_principal_id: "omp" }] },
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

	test("an argument that names the author or the directive id is refused at the boundary and records nothing", async () => {
		const sink = new MemorySink();
		const client = await connect(substrateWith(ENABLED, sink), { surface: "omp", isOperator: true });

		// The schemas have no author or id fields, so the SDK refuses the call before the handler runs. The refusal is checked
		// by its flag and by what happened, not by the wording of the SDK's message.
		for (const extra of [{ principal_id: "omp" }, { author_kind: "human" }, { id: "caller-chosen" }]) {
			const result = await client.callTool({ name: "steering_queue", arguments: { ...QUEUE_ARGS, ...extra } });
			expect(result.isError).toBe(true);
		}
		expect(sink.entries).toEqual([]);
		expect(await call(client, "steering_list", { session_id: "sess-a" })).toMatchObject({
			isError: false,
			body: { status: "listed", directives: [] },
		});
	});

	test("a write with no audit sink answers not-configured as an error, and a read answers it as a plain reply", async () => {
		const client = await connect(substrateWith(ENABLED, null), { surface: "omp", isOperator: true });

		expect(await call(client, "steering_queue", QUEUE_ARGS)).toMatchObject({ isError: true, body: { status: "not-configured" } });
		expect(await call(client, "steering_list", { session_id: "sess-a" })).toMatchObject({
			isError: false,
			body: { status: "not-configured" },
		});
	});

	test("invalid settings register the tools and steering_list answers an error naming the key, not an absent tool", async () => {
		const sink = new MemorySink();
		const client = await connect(substrateWith({ ...ENABLED, SUBSTRATE_PLANNING_STEERING_RATE_PER_MIN: "ten" }, sink), {
			surface: "omp",
			isOperator: true,
		});

		expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("steering_list");
		expect(await call(client, "steering_list", { session_id: "sess-a" })).toEqual({
			isError: true,
			body: { status: "misconfigured", errors: [{ key: "SUBSTRATE_PLANNING_STEERING_RATE_PER_MIN", reason: "not-integer" }] },
		});
		expect(await call(client, "steering_queue", QUEUE_ARGS)).toMatchObject({
			isError: true,
			body: { status: "misconfigured" },
		});
		expect(sink.entries).toEqual([]);
	});

	test("a malformed enable switch still registers the tools, answered as misconfigured", async () => {
		const client = await connect(substrateWith({ SUBSTRATE_PLANNING_STEERING: "maybe" }, new MemorySink()), {
			surface: "omp",
			isOperator: true,
		});

		expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("steering_list");
		expect(await call(client, "steering_list", { session_id: "sess-a" })).toMatchObject({
			isError: true,
			body: { status: "misconfigured", errors: [{ key: "SUBSTRATE_PLANNING_STEERING", reason: "not-boolean" }] },
		});
	});

	test("with the switch off, invalid settings register no tool at all", async () => {
		const client = await connect(substrateWith({ SUBSTRATE_PLANNING_STEERING: "off", SUBSTRATE_PLANNING_STEERING_RATE_PER_MIN: "ten" }, new MemorySink()), {
			surface: "omp",
			isOperator: true,
		});

		expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain("steering_list");
	});
});
