import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRoute } from "./options.ts";
import { WORKTREES_ROOT } from "./sandbox-options.ts";
import {
	hostCallTarget,
	interruptedTasks,
	MemoryTaskStore,
	pollCode,
	RESUME_TEXT,
	type TaskRecord,
	TaskService,
	type TaskServiceDeps,
	TaskStore,
	type TaskStoreLike,
	validateOpenRequest,
	type VmHandle,
} from "./tasks.ts";
import { type LeaseStoreLike, LeaseStore, MemoryLeaseStore } from "./substrate.ts";

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
type PromptInput = Parameters<VmHandle["sessions"]["prompt"]>[0];

/** Fakes for every collaborator; `calls` records the order of every side effect. */
function harness(opts: {
	graphNode?: { claimed_by: string | null; claim_session: string | null } | null;
	claimed?: boolean;
	openThrows?: string;
	modelRouteThrows?: string;
	/** ensureModelRoute throws only for this graph id (the others succeed). */
	modelRouteThrowsFor?: string;
	/** sessions.prompt rejects at once when the idempotency key contains this text. */
	promptRejectsFor?: string;
	sessionState?: string;
	store?: TaskStoreLike;
	leases?: LeaseStoreLike;
	/** Lease id the fake claim grants (default fixed test value; plant high-entropy for log scans). */
	leaseId?: string;
	/** claimAndPersist grants without persisting (the missing-lease path). */
	dropLeasePersist?: boolean;
	/** Heartbeat answers in call order; exhausted queue answers ok:true. */
	heartbeats?: Array<{ ok: boolean; reason?: string }>;
	/** Re-claims (second and later claims) are refused. */
	reclaimRefused?: boolean;
	/** graphComplete answers refused. */
	completeRefused?: boolean;
	/** When given, log lines accumulate here for value-scan assertions. */
	logs?: string[];
} = {}) {
	const calls: Call[] = [];
	const record = (name: string, ...args: unknown[]) => calls.push({ name, args });
	/** Every sessions.prompt input, typed, in call order. */
	const prompts: PromptInput[] = [];
	/** Model-route and prompt steps in order, as `ensureModelRoute:<gid>` / `prompt:<idempotencyKey>`. */
	const sequence: string[] = [];
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
				prompts.push(input);
				sequence.push(`prompt:${input.idempotencyKey}`);
				if (opts.promptRejectsFor && input.idempotencyKey.includes(opts.promptRejectsFor)) {
					return Promise.reject(new Error(`prompt refused for ${input.idempotencyKey}`));
				}
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
		respondPermission: async (input) => {
			record("respondPermission", input);
			return { status: "accepted" };
		},
	};
	const node = opts.graphNode === undefined ? { claimed_by: null, claim_session: null } : opts.graphNode;
	const leases = opts.leases ?? new MemoryLeaseStore();
	const leaseId = opts.leaseId ?? "lse_test_0123456789abcdef0123456789abcdef";
	const heartbeatQueue = [...(opts.heartbeats ?? [])];
	let claimCalls = 0;
	const logs = opts.logs ?? [];
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
			claimAndPersist: async (store, graphId, nodeId, surface, sessionId) => {
				record("claimAndPersist", store, graphId, nodeId, surface, sessionId);
				claimCalls += 1;
				if (opts.claimed === false) return { claimed: false, reason: "held by hermes session s-9" };
				if (claimCalls > 1 && opts.reclaimRefused) return { claimed: false, reason: "taken over by hermes session s-9" };
				if (!opts.dropLeasePersist) store.persist(graphId, nodeId, { lease_id: leaseId, acquiredAtMs: 0, ttlSeconds: 900 });
				return { claimed: true, lease_id: leaseId };
			},
			heartbeat: async (...args) => {
				record("heartbeat", ...args);
				return heartbeatQueue.shift() ?? { ok: true };
			},
			graphComplete: async (...args) => {
				record("graphComplete", ...args);
				return opts.completeRefused ? { completed: false, reason: "stale-lease" } : { completed: true };
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
		leases,
		ensureModelRoute: async (_handle, graphId) => {
			record("ensureModelRoute", graphId);
			sequence.push(`ensureModelRoute:${graphId}`);
			if (opts.modelRouteThrows) throw new Error(opts.modelRouteThrows);
			if (opts.modelRouteThrowsFor === graphId) throw new Error(`relay failed for ${graphId}`);
		},
		route: ROUTE,
		testsRoute: "sandbox",
		model: "grok-4.6",
		skills: [{ name: "ultrathink-sync", files: [{ rel: "SKILL.md", content: "# sync" }] }],
		trackers: { notionDataSourceUrl: "https://www.notion.so/x", linearTeam: "SWC" },
		log: (line) => logs.push(line),
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
		prompts,
		sequence,
		files,
		logs,
		leases,
		leaseId,
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
		expect(h.named("claimAndPersist")[0]?.args.slice(1)).toEqual([GID, NID, "claude-code", NID]);
		expect(h.named("claimAndPersist")[0]?.args[0]).toBe(h.leases);
		const order = h.calls.map((c) => c.name).filter((n) => ["graphGet", "claimAndPersist", "ensureModelRoute", "sessions.open", "sessions.prompt"].includes(n));
		expect(order).toEqual(["graphGet", "claimAndPersist", "ensureModelRoute", "sessions.open", "ensureModelRoute", "sessions.prompt"]);
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
			"/home/agentos/.substrate/ultrathink-state.json",
			"/home/agentos/.substrate/ultrathink-state.xml",
		]);
		expect(body.seeded.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
		expect(JSON.parse(h.files.get("/home/agentos/.claude.json") ?? "")).toEqual({
			mcpServers: {
				substrate: { type: "http", url: "http://127.0.0.1:7410/mcp" },
				notion: { type: "http", url: "http://127.0.0.1:7412/mcp/notion" },
				linear: { type: "http", url: "http://127.0.0.1:7412/mcp/linear" },
			},
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
		expect(h.named("claimAndPersist")).toHaveLength(1);
		expect(h.named("sessions.open")).toHaveLength(1);
		expect(h.named("sessions.prompt")).toHaveLength(1);
	});

	test("a node held by another surface is 409 with no claim call", async () => {
		const h = harness({ graphNode: { claimed_by: "hermes", claim_session: "s-1" } });
		const result = await h.service.openTask(openBody());
		expect(result.status).toBe(409);
		expect(h.named("claimAndPersist")).toHaveLength(0);
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

describe("TaskService lease claim with persist-then-verify (32-01)", () => {
	test("open persists the granted lease and logs presence only, never the value", async () => {
		const leaseId = "lse_9f2c4a7e1b5d48f0a3c6e9b2d5f807163";
		const logs: string[] = [];
		const h = harness({ leaseId, logs });
		const result = await h.service.openTask(openBody());
		expect(result.status).toBe(202);
		expect(h.leases.load(GID, NID)?.lease_id).toBe(leaseId);
		expect(logs.some((line) => line.includes("lease persisted") && line.includes("yes"))).toBe(true);
		expect(logs.some((line) => line.includes(leaseId))).toBe(false);
		await h.settlePrompt("end_turn");
		expect(logs.some((line) => line.includes(leaseId))).toBe(false);
	});

	test("open onto a temp-dir LeaseStore writes a 0600 lease file beside the task records", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tasks-32-01-"));
		try {
			const leases = new LeaseStore(dir);
			const h = harness({ leases });
			expect((await h.service.openTask(openBody())).status).toBe(202);
			const mode = statSync(join(dir, `${GID}__${NID}.lease.json`)).mode & 0o777;
			expect(mode).toBe(0o600);
			expect(leases.load(GID, NID)?.lease_id).toBe(h.leaseId);
			await h.settlePrompt("end_turn");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a grant without a readable lease releases once and answers 502", async () => {
		const h = harness({ dropLeasePersist: true });
		const result = await h.service.openTask(openBody());
		expect(result.status).toBe(502);
		expect(JSON.stringify(result.body)).toContain("lease persist");
		expect(h.named("graphRelease")).toHaveLength(1);
		expect(h.named("graphRelease")[0]?.args).toEqual([GID, NID, "claude-code", NID]);
		expect(h.named("sessions.prompt")).toHaveLength(0);
		expect(h.store.get(GID, NID)).toBeNull();
	});
});

describe("TaskService heartbeat tick (32-01)", () => {
	test("a due tick heartbeats fenced on the persisted lease; a fresh lease is not-due with no call", async () => {
		const h = harness();
		await h.service.openTask(openBody());
		expect(h.service.heartbeatArmed(GID, NID)).toBe(true);
		expect(await h.service.heartbeatTick(GID, NID)).toBe("ok");
		expect(h.named("heartbeat")[0]?.args).toEqual([GID, NID, h.leaseId, 900]);
		// A just-persisted lease is not due: re-plant with the service clock and tick again.
		h.leases.persist(GID, NID, { lease_id: h.leaseId, acquiredAtMs: new Date("2026-09-25T12:00:00Z").getTime(), ttlSeconds: 900 });
		expect(await h.service.heartbeatTick(GID, NID)).toBe("not-due");
		expect(h.named("heartbeat")).toHaveLength(1);
		await h.settlePrompt("end_turn");
		expect(h.service.heartbeatArmed(GID, NID)).toBe(false);
	});

	test("a refused heartbeat re-claims exactly once and continues on the new lease", async () => {
		const h = harness({ heartbeats: [{ ok: false, reason: "expired" }] });
		await h.service.openTask(openBody());
		expect(await h.service.heartbeatTick(GID, NID)).toBe("reclaimed");
		expect(h.named("heartbeat")).toHaveLength(1);
		expect(h.named("claimAndPersist")).toHaveLength(2);
		expect(h.store.get(GID, NID)?.turn_in_flight).toBe(true);
		// The next tick heartbeats on the re-claimed lease with no further claim.
		expect(await h.service.heartbeatTick(GID, NID)).toBe("ok");
		expect(h.named("heartbeat")).toHaveLength(2);
		expect(h.named("claimAndPersist")).toHaveLength(2);
		await h.settlePrompt("end_turn");
	});

	test("a refused re-claim fails the turn closed with exactly one release and a dead tick", async () => {
		const h = harness({ heartbeats: [{ ok: false, reason: "lost" }], reclaimRefused: true });
		await h.service.openTask(openBody());
		expect(await h.service.heartbeatTick(GID, NID)).toBe("failed-closed");
		const stored = h.store.get(GID, NID);
		expect(stored?.turn_in_flight).toBe(false);
		expect(stored?.exit_code).toBe(1);
		expect(stored?.last_error).toBe("lease lost");
		expect(h.named("claimAndPersist")).toHaveLength(2);
		expect(h.named("graphRelease")).toHaveLength(1);
		expect(h.service.heartbeatArmed(GID, NID)).toBe(false);
		// A later tick is idle: the failed turn never heartbeats again.
		expect(await h.service.heartbeatTick(GID, NID)).toBe("idle");
		expect(h.named("heartbeat")).toHaveLength(1);
		expect(h.named("graphRelease")).toHaveLength(1);
	});

	test("terminate disarms the tick; the later settle still releases exactly once", async () => {
		const h = harness();
		await h.service.openTask(openBody());
		expect(h.service.heartbeatArmed(GID, NID)).toBe(true);
		await h.service.terminate(GID, NID);
		expect(h.service.heartbeatArmed(GID, NID)).toBe(false);
		expect(await h.service.heartbeatTick(GID, NID)).toBe("idle");
		expect(h.named("heartbeat")).toHaveLength(0);
		await h.settlePrompt("cancelled");
		expect(h.named("graphRelease")).toHaveLength(1);
	});

	test("kill disarms the tick and a later manual tick sends nothing", async () => {
		const h = harness();
		await h.service.openTask(openBody());
		await h.service.kill(GID, NID);
		expect(h.service.heartbeatArmed(GID, NID)).toBe(false);
		expect(await h.service.heartbeatTick(GID, NID)).toBe("idle");
		expect(h.named("heartbeat")).toHaveLength(0);
		expect(h.named("graphRelease")).toHaveLength(1);
	});

	test("beginShutdown disarms every tick", async () => {
		const h = harness();
		await h.service.openTask(openBody());
		expect(h.service.heartbeatArmed(GID, NID)).toBe(true);
		h.service.beginShutdown();
		expect(h.service.heartbeatArmed(GID, NID)).toBe(false);
	});
});

describe("TaskService single release and completion (32-01)", () => {
	test("a failed turn releases once; the later kill re-releases nothing", async () => {
		const h = harness();
		await h.service.openTask(openBody());
		await h.failPrompt(new Error("adapter exited"));
		expect(h.named("graphRelease")).toHaveLength(1);
		expect(h.store.get(GID, NID)?.released).toBe(true);
		await h.service.kill(GID, NID);
		expect(h.named("graphRelease")).toHaveLength(1);
		expect(h.named("sessions.cancelPrompt")).toHaveLength(1);
		expect(h.named("sessions.unload")).toHaveLength(1);
	});

	test("a settled turn releases once; the later kill re-releases nothing", async () => {
		const h = harness();
		await h.service.openTask(openBody());
		await h.settlePrompt("end_turn");
		expect(h.named("graphRelease")).toHaveLength(1);
		expect(h.store.get(GID, NID)?.released).toBe(true);
		await h.service.kill(GID, NID);
		expect(h.named("graphRelease")).toHaveLength(1);
	});

	test("complete sends the persisted lease_id with the DoD and releases; repeats and kills re-release nothing", async () => {
		const h = harness();
		await h.service.openTask(openBody());
		const reply = await h.service.complete(GID, NID, { summary: "  did the work  ", tests_pass: true });
		expect(reply).toEqual({ completed: true });
		expect(h.named("graphComplete")).toHaveLength(1);
		expect(h.named("graphComplete")[0]?.args).toEqual([GID, NID, h.leaseId, { summary: "did the work", tests_pass: true }]);
		expect(h.store.get(GID, NID)?.released).toBe(true);
		// The in-flight prompt settles after the completion: no second release.
		await h.settlePrompt("end_turn");
		expect(h.named("graphRelease")).toHaveLength(0);
		expect(await h.service.complete(GID, NID, { summary: "again", tests_pass: true })).toEqual({ completed: false, reason: "already released" });
		expect(h.named("graphComplete")).toHaveLength(1);
		await h.service.kill(GID, NID);
		expect(h.named("graphRelease")).toHaveLength(0);
	});

	test("complete refuses an empty summary, an unknown task and a refused grant without releasing", async () => {
		const h = harness();
		await h.service.openTask(openBody());
		expect(await h.service.complete(GID, NID, { summary: "   ", tests_pass: true })).toEqual({ completed: false, reason: "dod-required" });
		expect(await h.service.complete(GID, "n9", { summary: "x", tests_pass: true })).toEqual({ completed: false, reason: "unknown task" });
		expect(h.named("graphComplete")).toHaveLength(0);
		expect(h.store.get(GID, NID)?.released).toBe(false);
		const refused = harness({ completeRefused: true });
		await refused.service.openTask(openBody());
		expect(await refused.service.complete(GID, NID, { summary: "work", tests_pass: false })).toEqual({ completed: false, reason: "stale-lease" });
		expect(refused.store.get(GID, NID)?.released).toBe(false);
		await refused.settlePrompt("end_turn");
	});

	test("complete caps an overlong summary at the DoD limit", async () => {
		const h = harness();
		await h.service.openTask(openBody());
		expect(await h.service.complete(GID, NID, { summary: "s".repeat(2500), tests_pass: true })).toEqual({ completed: true });
		const sent: unknown = h.named("graphComplete")[0]?.args[3];
		if (typeof sent !== "object" || sent === null || !("summary" in sent)) throw new Error("complete did not send a dod");
		expect(sent.summary).toHaveLength(2000);
		await h.settlePrompt("end_turn");
	});
});

/** A record as 03-03 wrote it after the first prompt started (no resumes/stale_approvals yet). */
function taskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
	return {
		graph_id: GID,
		node_id: NID,
		identifier: "TRC-1",
		repo: "swcstudiospace/agent-substrate",
		session_id: NID,
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
		pr_url: null,
		pr_number: null,
		synced_at: null,
		sync_by: null,
		approvals_allowed: 0,
		approvals_denied: 0,
		...overrides,
	};
}

describe("interruptedTasks", () => {
	test("returns exactly the records whose turn was in flight, not released and not finished", () => {
		const inFlight = taskRecord({ graph_id: "ut-in-11111111" });
		const released = taskRecord({ graph_id: "ut-rel-22222222", released: true });
		const finished = taskRecord({ graph_id: "ut-fin-33333333", turn_in_flight: false, last_stop_reason: "end_turn", exit_code: 0 });
		const failed = taskRecord({ graph_id: "ut-bad-44444444", exit_code: 1 });
		const idle = taskRecord({ graph_id: "ut-idle-55555555", turn_in_flight: false });
		expect(interruptedTasks([released, inFlight, finished, failed, idle]).map((r) => r.graph_id)).toEqual(["ut-in-11111111"]);
		expect(interruptedTasks([])).toEqual([]);
	});
});

describe("TaskService.resumeInterrupted", () => {
	test("one interrupted record gets one continuation prompt keyed resume:1; approvals of the dead turn become stale", async () => {
		const store = new MemoryTaskStore();
		store.save(
			taskRecord({
				pending_approvals: [
					{ request_id: "req-1", tool: "Read", at: "2026-09-25T12:00:01.000Z" },
					{ request_id: "req-2", tool: "Bash", at: "2026-09-25T12:00:02.000Z" },
				],
			}),
		);
		const h = harness({ store });
		expect(await h.service.resumeInterrupted()).toBe(1);
		expect(h.prompts).toHaveLength(1);
		const prompt = h.prompts[0];
		expect(prompt?.sessionId).toBe(NID);
		expect(prompt?.idempotencyKey).toBe(`${GID}:${NID}:resume:1`);
		expect(prompt?.content).toEqual([{ type: "text", text: RESUME_TEXT }]);
		expect(RESUME_TEXT).toContain("/home/agentos/work");
		const stored = store.get(GID, NID);
		expect(stored?.prompt_count).toBe(2);
		expect(stored?.resumes).toBe(1);
		expect(stored?.turn_in_flight).toBe(true);
		expect(stored?.pending_approvals).toEqual([]);
		expect(stored?.stale_approvals).toBe(2);
		expect(stored?.exit_code).toBeNull();
		// The continuation settles exactly like the first prompt.
		await h.settlePrompt("end_turn");
		expect(store.get(GID, NID)?.exit_code).toBe(0);
		expect(store.get(GID, NID)?.turn_in_flight).toBe(false);
	});

	test("a second call in the same process sends nothing; the next boot keys the record resume:2", async () => {
		const store = new MemoryTaskStore();
		store.save(taskRecord());
		const boot1 = harness({ store });
		await boot1.service.resumeInterrupted();
		expect(await boot1.service.resumeInterrupted()).toBe(0);
		expect(boot1.prompts).toHaveLength(1);
		// The host restarts again while the continuation is still in flight (record: resumes 1, turn in flight).
		const boot2 = harness({ store });
		expect(await boot2.service.resumeInterrupted()).toBe(1);
		expect(boot2.prompts.map((p) => p.idempotencyKey)).toEqual([`${GID}:${NID}:resume:2`]);
		expect(store.get(GID, NID)?.resumes).toBe(2);
		expect(store.get(GID, NID)?.prompt_count).toBe(3);
	});

	test("released, finished and not-in-flight records get no prompt", async () => {
		const store = new MemoryTaskStore();
		store.save(taskRecord({ graph_id: "ut-rel-22222222", released: true, pending_approvals: [{ request_id: "r", tool: "Read", at: "t" }] }));
		store.save(taskRecord({ graph_id: "ut-fin-33333333", turn_in_flight: false, last_stop_reason: "end_turn", exit_code: 0 }));
		store.save(taskRecord({ graph_id: "ut-idle-55555555", turn_in_flight: false }));
		const h = harness({ store });
		expect(await h.service.resumeInterrupted()).toBe(0);
		expect(h.prompts).toHaveLength(0);
		expect(h.sequence).toEqual([]);
		for (const r of store.list()) {
			expect(r.resumes).toBe(0);
			expect(r.prompt_count).toBe(1);
		}
		expect(store.get("ut-rel-22222222", NID)?.pending_approvals).toHaveLength(1);
	});

	test("a continuation prompt that rejects fails that task only; the other task still resumes", async () => {
		const store = new MemoryTaskStore();
		store.save(taskRecord({ graph_id: "ut-aaa-11111111" }));
		store.save(taskRecord({ graph_id: "ut-bbb-22222222" }));
		const h = harness({ store, promptRejectsFor: "ut-aaa-11111111:" });
		expect(await h.service.resumeInterrupted()).toBe(2);
		expect(h.prompts.map((p) => p.idempotencyKey)).toEqual(["ut-aaa-11111111:n1:resume:1", "ut-bbb-22222222:n1:resume:1"]);
		await (h.service.turns.get("ut-aaa-11111111/n1") ?? Promise.resolve()); // the other turn is still pending on the fake
		const failed = store.get("ut-aaa-11111111", NID);
		expect(failed?.exit_code).toBe(1);
		expect(failed?.last_error).toContain("prompt refused");
		expect(failed?.turn_in_flight).toBe(false);
		const other = store.get("ut-bbb-22222222", NID);
		expect(other?.exit_code).toBeNull();
		expect(other?.last_error).toBeNull();
		expect(other?.turn_in_flight).toBe(true);
		expect(other?.resumes).toBe(1);
	});

	test("ensureModelRoute is awaited once per task before its prompt; a failing route fails that task only", async () => {
		const store = new MemoryTaskStore();
		store.save(taskRecord({ graph_id: "ut-aaa-11111111" }));
		store.save(taskRecord({ graph_id: "ut-bbb-22222222" }));
		const h = harness({ store, modelRouteThrowsFor: "ut-aaa-11111111" });
		expect(await h.service.resumeInterrupted()).toBe(1);
		expect(h.sequence).toEqual(["ensureModelRoute:ut-aaa-11111111", "ensureModelRoute:ut-bbb-22222222", "prompt:ut-bbb-22222222:n1:resume:1"]);
		const failed = store.get("ut-aaa-11111111", NID);
		expect(failed?.exit_code).toBe(1);
		expect(failed?.last_error).toContain("relay failed");
		expect(failed?.turn_in_flight).toBe(false);
		expect(failed?.resumes).toBe(0);
		expect(store.get("ut-bbb-22222222", NID)?.resumes).toBe(1);
		expect(store.get("ut-bbb-22222222", NID)?.exit_code).toBeNull();
	});

	test("TaskStore reads a record written before resumes/stale_approvals existed as 0, so the first key is resume:1", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tasks-03-06-"));
		try {
			const { resumes: _resumes, stale_approvals: _stale, ...legacy } = taskRecord();
			writeFileSync(join(dir, `${GID}--${NID}.json`), JSON.stringify(legacy));
			const store = new TaskStore(dir);
			expect(store.get(GID, NID)?.resumes).toBe(0);
			expect(store.list()[0]?.stale_approvals).toBe(0);
			const h = harness({ store });
			await h.service.resumeInterrupted();
			expect(h.prompts.map((p) => p.idempotencyKey)).toEqual([`${GID}:${NID}:resume:1`]);
			expect(store.get(GID, NID)?.resumes).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a prompt that rejects after beginShutdown leaves the record in flight, so the next boot resumes it", async () => {
		const store = new MemoryTaskStore();
		const h = harness({ store });
		await h.service.openTask(openBody());
		h.service.beginShutdown();
		await h.failPrompt(new Error("SidecarProcessExited: sidecar process exited with disconnect"));
		const stored = store.get(GID, NID);
		expect(stored?.turn_in_flight).toBe(true);
		expect(stored?.exit_code).toBeNull();
		expect(stored?.last_error).toBeNull();
		expect(interruptedTasks(store.list())).toHaveLength(1);
		// Without the shutdown flag the same rejection fails the task (the first-prompt contract from 03-03).
		const h2 = harness();
		await h2.service.openTask(openBody());
		await h2.failPrompt(new Error("boom"));
		expect(h2.store.get(GID, NID)?.exit_code).toBe(1);
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
