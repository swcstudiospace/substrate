import { describe, expect, test } from "bun:test";
import { parseRoute } from "./options.ts";
import { WORKTREES_ROOT } from "./sandbox-options.ts";
import {
	hostCallTarget,
	MemoryTaskStore,
	pollCode,
	type TaskRecord,
	TaskService,
	type TaskServiceDeps,
	validateOpenRequest,
	type VmHandle,
} from "./tasks.ts";

const ROUTE = parseRoute("a:loopback,b:prompt_hostfn,c:hostfn_commit,s:hostfn");
const GID = "ut-a-12345678";
const NID = "n1";

function openBody(overrides: Record<string, unknown> = {}) {
	return {
		graph_id: GID,
		node_id: NID,
		identifier: "TRC-1",
		repo: "swcstudiospace/agent-substrate",
		worktree: `${WORKTREES_ROOT}/${GID}`,
		...overrides,
	};
}

type Call = { name: string; args: unknown[] };

/** Fakes for every collaborator; `calls` records the order of every side effect. */
function harness(opts: {
	graphNode?: { claimed_by: string | null; claim_session: string | null } | null;
	claimed?: boolean;
	openThrows?: string;
	modelRouteThrows?: string;
	sessionState?: string;
	store?: MemoryTaskStore;
} = {}) {
	const calls: Call[] = [];
	const record = (name: string, ...args: unknown[]) => calls.push({ name, args });
	let pending = Promise.withResolvers<{ stopReason: string }>();
	let promptInFlight = false;
	const files = new Map<string, string>();
	const handle: VmHandle = {
		filesystem: {
			mkdir: async (path, options) => {
				record("mkdir", path, options);
			},
			writeFile: async (path, content) => {
				record("writeFile", path);
				files.set(path, String(content));
			},
			readFile: async (path) => new TextEncoder().encode(files.get(path) ?? ""),
		},
		sessions: {
			open: async (input) => {
				record("sessions.open", input);
				if (opts.openThrows) throw new Error(opts.openThrows);
			},
			prompt: (input) => {
				record("sessions.prompt", input);
				pending = Promise.withResolvers<{ stopReason: string }>();
				promptInFlight = true;
				return pending.promise;
			},
			get: async () => ({ state: { status: opts.sessionState ?? (promptInFlight ? "running" : "idle") }, latestSequence: 3 }),
			readHistory: async () => ({ events: [1, 2, 3] }),
			cancelPrompt: async (input) => {
				record("sessions.cancelPrompt", input);
				return { status: "cancelled" };
			},
			unload: async (input) => {
				record("sessions.unload", input);
			},
		},
	};
	const node = opts.graphNode === undefined ? { claimed_by: null, claim_session: null } : opts.graphNode;
	const deps: TaskServiceDeps = {
		substrate: {
			graphGet: async (graphId) => {
				record("graphGet", graphId);
				return { graph_id: graphId, nodes: node ? [{ node_id: NID, ...node }] : [] } as never;
			},
			graphClaim: async (...args) => {
				record("graphClaim", ...args);
				return { claimed: opts.claimed ?? true, reason: opts.claimed === false ? "held by hermes session s-9" : undefined };
			},
			graphRelease: async (...args) => {
				record("graphRelease", ...args);
				return { released: true };
			},
			brief: async () => "# brief\n",
		},
		vmFor: (graphId) => {
			record("vmFor", graphId);
			return handle;
		},
		store: opts.store ?? new MemoryTaskStore(),
		ensureModelRoute: async (_handle, graphId) => {
			record("ensureModelRoute", graphId);
			if (opts.modelRouteThrows) throw new Error(opts.modelRouteThrows);
		},
		route: ROUTE,
		testsRoute: "sandbox",
		model: "grok-4.6",
		skills: [{ name: "ultrathink-sync", files: [{ rel: "SKILL.md", content: "# sync" }] }],
		trackers: { notionDataSourceUrl: "https://www.notion.so/x", linearTeam: "SWC" },
		log: () => undefined,
		now: () => new Date("2026-09-25T12:00:00Z"),
	};
	const service = new TaskService(deps);
	const named = (name: string) => calls.filter((c) => c.name === name);
	/** Settle the in-flight prompt and wait until the service has folded the outcome into the record. */
	const settle = (outcome: { stopReason: string } | { error: unknown }) => {
		const turn = service.turns.get(`${GID}/${NID}`);
		promptInFlight = false;
		if ("error" in outcome) pending.reject(outcome.error);
		else pending.resolve(outcome);
		return turn ?? Promise.resolve();
	};
	return {
		service,
		calls,
		named,
		files,
		store: deps.store as MemoryTaskStore,
		settlePrompt: (stopReason: string) => settle({ stopReason }),
		failPrompt: (error: unknown) => settle({ error }),
	};
}

describe("pollCode", () => {
	const base = { turn_in_flight: false, last_stop_reason: null, last_error: null };
	test("null while the turn is in flight or the session runs or waits", () => {
		expect(pollCode({ ...base, turn_in_flight: true })).toBeNull();
		expect(pollCode(base, "waiting")).toBeNull();
		expect(pollCode(base, "running")).toBeNull();
	});
	test("0 after end_turn when nothing is in flight", () => {
		expect(pollCode({ ...base, last_stop_reason: "end_turn" }, "idle")).toBe(0);
	});
	test("1 for any other stop reason, a failed prompt or a failed session", () => {
		for (const reason of ["cancelled", "refusal", "max_tokens"]) {
			expect(pollCode({ ...base, last_stop_reason: reason })).toBe(1);
		}
		expect(pollCode({ ...base, last_error: "boom" })).toBe(1);
		expect(pollCode(base, "failed")).toBe(1);
		// Regression: a session that failed mid-turn must not read as still running.
		expect(pollCode({ ...base, turn_in_flight: true }, "failed")).toBe(1);
	});
});

describe("validateOpenRequest", () => {
	test("accepts the dispatcher's shape with the pinned worktree", () => {
		const result = validateOpenRequest(openBody());
		expect(result.ok).toBe(true);
	});
	test.each([
		["graph_id", { graph_id: "../x" }],
		["node_id", { node_id: "n 1" }],
		["node_id", { node_id: "n".repeat(33) }],
		["identifier", { identifier: "swc-1" }],
		["repo", { repo: "a/../b" }],
		["worktree", { worktree: "/tmp/x" }],
	])("rejects a bad %s naming the field", (field, override) => {
		const result = validateOpenRequest(openBody(override));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain(field);
	});
	test("rejects a non-object body", () => {
		expect(validateOpenRequest(null).ok).toBe(false);
		expect(validateOpenRequest("x").ok).toBe(false);
	});
});

describe("TaskService.openTask", () => {
	test("claims as claude-code, seeds, opens with permissionPolicy ask and starts the first prompt without awaiting it", async () => {
		const h = harness();
		const result = await h.service.openTask(openBody());
		expect(result.status).toBe(202);
		expect(h.named("graphClaim")[0]?.args).toEqual([GID, NID, "claude-code", NID]);
		const order = h.calls.map((c) => c.name).filter((n) => ["graphGet", "graphClaim", "ensureModelRoute", "sessions.open", "sessions.prompt"].includes(n));
		expect(order).toEqual(["graphGet", "graphClaim", "ensureModelRoute", "sessions.open", "ensureModelRoute", "sessions.prompt"]);
		const open = h.named("sessions.open")[0]?.args[0] as Parameters<VmHandle["sessions"]["open"]>[0];
		expect(open.permissionPolicy).toBe("ask");
		expect(open.sessionId).toBe(NID);
		expect(open.cwd).toBe("/home/agentos/work");
		expect(Object.keys(open.env).sort()).toEqual(
			["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "SUBSTRATE_GRAPH_ID", "SUBSTRATE_NODE_ID"].sort(),
		);
		expect(open.env.ANTHROPIC_API_KEY).toBe("shunt");
		expect(open.mcpServers).toEqual([]); // s:hostfn: no session MCP server
		const prompt = h.named("sessions.prompt")[0]?.args[0] as { idempotencyKey: string; content: Array<{ text: string }> };
		expect(prompt.idempotencyKey).toBe(`${GID}:${NID}:1`);
		expect(prompt.content[0]?.text).toContain("agentos-substrate issue-get --node n1");
		expect(prompt.content[0]?.text).toContain("agentos-substrate release --node n1");
		// The prompt promise is still pending: openTask resolved without awaiting it.
		const body = result.body as TaskRecord & { state: string };
		expect(body.turn_in_flight).toBe(true);
		expect(body.prompt_count).toBe(1);
		expect(body.exit_code).toBeNull();
		expect(body.seeded.map((f) => f.path)).toEqual([
			"/home/agentos/SUBSTRATE_BRIEF.md",
			"/home/agentos/.claude/skills/ultrathink-sync/SKILL.md",
			"/home/agentos/.claude.json",
			"/home/agentos/.config/ultrathink/config.json",
		]);
		expect(body.seeded.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
		expect(JSON.parse(h.files.get("/home/agentos/.claude.json") ?? "")).toEqual({
			mcpServers: { substrate: { type: "http", url: "http://127.0.0.1:7410/mcp" } },
		});

		await h.settlePrompt("end_turn");
		const after = await h.service.status(GID, NID);
		expect(after?.turn_in_flight).toBe(false);
		expect(after?.last_stop_reason).toBe("end_turn");
		expect(after?.exit_code).toBe(0);
	});

	test("a second open for the same task returns 200 with the stored record and prompts nothing again", async () => {
		const h = harness();
		expect((await h.service.openTask(openBody())).status).toBe(202);
		const second = await h.service.openTask(openBody());
		expect(second.status).toBe(200);
		expect((second.body as TaskRecord).prompt_count).toBe(1);
		expect(h.named("graphClaim")).toHaveLength(1);
		expect(h.named("sessions.open")).toHaveLength(1);
		expect(h.named("sessions.prompt")).toHaveLength(1);
	});

	test("a node held by another surface is 409 with no claim call", async () => {
		const h = harness({ graphNode: { claimed_by: "hermes", claim_session: "s-1" } });
		const result = await h.service.openTask(openBody());
		expect(result.status).toBe(409);
		expect(h.named("graphClaim")).toHaveLength(0);
		expect(h.named("sessions.open")).toHaveLength(0);
	});

	test("a refused claim is 409 with no session call", async () => {
		const h = harness({ claimed: false });
		const result = await h.service.openTask(openBody());
		expect(result.status).toBe(409);
		expect(h.named("sessions.open")).toHaveLength(0);
		expect(h.named("vmFor")).toHaveLength(0);
	});

	test("an unknown graph or node is 400", async () => {
		const h = harness({ graphNode: null });
		expect((await h.service.openTask(openBody())).status).toBe(400);
	});

	test("sessions.open throwing after the claim releases it once and answers 502", async () => {
		const h = harness({ openThrows: "vm boot failed" });
		const result = await h.service.openTask(openBody());
		expect(result.status).toBe(502);
		expect(h.named("graphRelease")).toHaveLength(1);
		expect(h.named("graphRelease")[0]?.args).toEqual([GID, NID, "claude-code", NID]);
		expect(h.named("sessions.prompt")).toHaveLength(0);
		expect(h.store.get(GID, NID)).toBeNull();
	});

	test("ensureModelRoute throwing after the claim releases it once and answers 502", async () => {
		const h = harness({ modelRouteThrows: "relay down" });
		const result = await h.service.openTask(openBody());
		expect(result.status).toBe(502);
		expect(h.named("graphRelease")).toHaveLength(1);
		expect(h.named("sessions.open")).toHaveLength(0);
	});

	test("a failed prompt sets last_error and exit_code 1", async () => {
		const h = harness();
		await h.service.openTask(openBody());
		await h.failPrompt(new Error("adapter exited"));
		const after = await h.service.status(GID, NID);
		expect(after?.last_error).toContain("adapter exited");
		expect(after?.exit_code).toBe(1);
	});
});

describe("TaskService status, terminate and kill", () => {
	test("status spreads every stored field, including ones TaskRecord does not name", async () => {
		const h = harness();
		await h.service.openTask(openBody());
		const stored = h.store.get(GID, NID) as TaskRecord & { resumes?: number };
		stored.resumes = 2;
		h.store.save(stored);
		const status = (await h.service.status(GID, NID)) as (TaskRecord & { resumes?: number; state: string; latest_sequence: number | null; history_events: number | null }) | null;
		expect(status?.resumes).toBe(2);
		expect(status?.state).toBe("running");
		expect(status?.latest_sequence).toBe(3);
		expect(status?.history_events).toBe(3);
		expect(status?.exit_code).toBeNull();
	});

	test("status of an unknown task is null and list returns every record", async () => {
		const h = harness();
		expect(await h.service.status(GID, "n9")).toBeNull();
		await h.service.openTask(openBody());
		expect((await h.service.list()).map((t) => t.node_id)).toEqual([NID]);
	});

	test("terminate cancels the prompt; the settled cancellation maps to exit_code 1", async () => {
		const h = harness({ sessionState: "idle" });
		await h.service.openTask(openBody());
		expect(await h.service.terminate(GID, NID)).toBe(true);
		expect(h.named("sessions.cancelPrompt")).toHaveLength(1);
		await h.settlePrompt("cancelled");
		expect((await h.service.status(GID, NID))?.exit_code).toBe(1);
		expect(await h.service.terminate(GID, "n9")).toBe(false);
	});

	test("kill cancels, unloads and releases once each and marks the record released", async () => {
		const h = harness();
		await h.service.openTask(openBody());
		expect(await h.service.kill(GID, NID)).toBe(true);
		expect(h.named("sessions.cancelPrompt")).toHaveLength(1);
		expect(h.named("sessions.unload")).toHaveLength(1);
		expect(h.named("graphRelease")).toHaveLength(1);
		expect(h.named("graphRelease")[0]?.args).toEqual([GID, NID, "claude-code", NID]);
		const status = await h.service.status(GID, NID);
		expect(status?.released).toBe(true);
		expect(status?.exit_code).toBe(1);
		expect(status?.state).toBe("unloaded");
	});

	test("permission requests are recorded as pending and cleared by their response; nothing answers them", async () => {
		const h = harness({ sessionState: "waiting" });
		await h.service.openTask(openBody());
		h.service.recordApproval(GID, NID, "req-1", "Bash");
		h.service.recordApproval(GID, NID, "req-1", "Bash");
		let status = await h.service.status(GID, NID);
		expect(status?.pending_approvals).toEqual([{ request_id: "req-1", tool: "Bash", at: "2026-09-25T12:00:00.000Z" }]);
		expect(status?.exit_code).toBeNull();
		h.service.resolveApproval(GID, NID, "req-1");
		status = await h.service.status(GID, NID);
		expect(status?.pending_approvals).toEqual([]);
	});
});

describe("hostCallTarget", () => {
	const lookup = (gid: string, nid: string) => (gid === GID && nid === NID ? { session_id: "sess-n1" } : null);

	test("resolves graph from the actor key, node from --node and the claim session from the record", () => {
		expect(hostCallTarget([GID], ["--node", NID], lookup)).toEqual({ graphId: GID, nodeId: NID, sessionId: "sess-n1" });
		expect(hostCallTarget([GID], [`--node=${NID}`], lookup)).toEqual({ graphId: GID, nodeId: NID, sessionId: "sess-n1" });
	});

	test("refuses a bad node, a node with no record and a node recorded only under another graph", () => {
		expect(hostCallTarget([GID], ["--node", "n 1"], lookup)).toHaveProperty("error");
		expect(hostCallTarget([GID], ["--node", "n2"], lookup)).toHaveProperty("error");
		const asked: string[] = [];
		const spy = (gid: string, nid: string) => {
			asked.push(gid);
			return lookup(gid, nid);
		};
		expect(hostCallTarget(["ut-other-00000000"], ["--node", NID], spy)).toHaveProperty("error");
		// The lookup is only ever asked about the actor's own graph.
		expect(asked).toEqual(["ut-other-00000000"]);
	});

	test("refuses a guest --graph or --session before anything is looked up", () => {
		let asked = 0;
		const spy = (gid: string, nid: string) => {
			asked++;
			return lookup(gid, nid);
		};
		expect(hostCallTarget([GID], ["--node", NID, "--graph", "ut-x-00000000"], spy)).toHaveProperty("error");
		expect(hostCallTarget([GID], ["--session", "s", "--node", NID], spy)).toHaveProperty("error");
		expect(hostCallTarget([GID], ["--node", NID, "--session=s"], spy)).toHaveProperty("error");
		expect(asked).toBe(0);
	});

	test("refuses an actor key that is not a valid graph id", () => {
		expect(hostCallTarget(["../x"], ["--node", NID], lookup)).toHaveProperty("error");
		expect(hostCallTarget([], ["--node", NID], lookup)).toHaveProperty("error");
	});
});
