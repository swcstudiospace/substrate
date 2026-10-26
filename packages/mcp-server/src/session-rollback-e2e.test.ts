/**
 * The whole rollback, end to end (v1.6 phase 61): the real CLI flow (`createCheckpoint`, then `rollback()`) on a real
 * temporary git worktree, talking through the real `createRollbackServerClient` and an injected fetch to a real MCP
 * server over a real `Substrate` with an in-memory ledger and memory index and the recording Hindsight fake.
 *
 * What it proves together: the client and the server speak the same contract, the files really go back, the ledger
 * holds one `session.checkpoint` per checkpoint and the `session.rollback`, the memory written after the checkpoint is
 * forgotten (index marked, plane documents deleted) while everything written before it, by another surface or in another
 * session is untouched, and a second run changes nothing again. No network, no clock of our own, a seeded id source.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { type CommitRollbackOk, type FetchLike, type RollbackServerClient, createRollbackServerClient } from "../../cli/src/session/client.ts";
import { createCheckpoint } from "../../cli/src/session/checkpoint.ts";
import { rollback } from "../../cli/src/session/rollback.ts";
import { FakeTranscript, seededRandomBytes } from "../../cli/src/session/testkit.ts";
import { readPinnedSnapshot, snapshot } from "../../worktree-snapshot/src/index.ts";
import { SCENARIO_POLICY, mutateToB, writeScenarioA } from "../../worktree-snapshot/src/scenario.ts";
import { FIXED_NOW, cleanupTemp, expectWorktreeMatches, makeRepo, tempDir } from "../../worktree-snapshot/src/testkit.ts";
import type { Substrate } from "./service.ts";
import { parseSessionEventPayload } from "./session-events.ts";
import { SESSION, bankOf, connect, entry, seedDocuments, withPlaneEnv, world } from "./session-rollback.testkit.ts";
import type { SubstrateEvent } from "./types.ts";

afterAll(cleanupTemp);
setDefaultTimeout(300_000);

interface RpcCall {
	params: { name: string; arguments: Record<string, unknown> };
}

interface Wire {
	client: RollbackServerClient;
	/** The tools called, in order, and the bearer each call carried. */
	tools: string[];
	bearers: Array<string | undefined>;
	/** The arguments of every call, by tool. */
	calls: Array<{ tool: string; args: Record<string, unknown> }>;
}

/** The CLI client, pointed at an in-process MCP client through a fetch that answers in the server's JSON-RPC shape. */
async function wire(substrate: Substrate): Promise<Wire> {
	const mcp = await connect(substrate, "claude-code");
	const tools: string[] = [];
	const bearers: Array<string | undefined> = [];
	const calls: Wire["calls"] = [];
	const fetchImpl: FetchLike = async (_url, init) => {
		const rpc: RpcCall = JSON.parse(init.body);
		const { name, arguments: args } = rpc.params;
		tools.push(name);
		bearers.push(init.headers["authorization"]);
		calls.push({ tool: name, args });
		const result = await mcp.client.callTool({ name, arguments: args });
		const body = { jsonrpc: "2.0", id: 1, result: { content: result.content, isError: result.isError === true } };
		return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
	};
	const client = createRollbackServerClient({ url: "http://substrate.test", token: "test-token", timeoutMs: 5_000, fetch: fetchImpl, signalFor: () => new AbortController().signal });
	return { client, tools, bearers, calls };
}

const sessionEvents = (events: readonly SubstrateEvent[], action: string): SubstrateEvent[] => events.filter((event) => event.payload["action"] === action);

describe("checkpoint, mutate, rollback, against the real server", () => {
	test("puts the files back, forgets only what the caller wrote after the checkpoint, and a second run changes nothing", async () => {
		await withPlaneEnv(async () => {
			const w = world();
			const server = await wire(w.substrate);
			const dir = makeRepo();
			writeScenarioA(dir);
			const pendingDir = join(tempDir(), "pending");
			const randomBytes = seededRandomBytes(11);
			const base = { worktree: dir, sessionId: SESSION, surface: "claude-code", client: server.client, now: FIXED_NOW, randomBytes, pendingDir, policy: SCENARIO_POLICY };

			// A checkpoint of state A, recorded by the server.
			const c1 = await createCheckpoint({ ...base, trigger: "manual" });
			expect(c1.server).toMatchObject({ status: "recorded", stored: true });
			const c1Event = w.ledger.events.find((event) => event.payload["ckpt_id"] === c1.checkpoint.ckpt_id) as SubstrateEvent;
			const t = Date.parse(c1Event.ts);

			// Memory around it: before, after (two), after by another surface, after in another session.
			const at = (ms: number): string => new Date(ms).toISOString();
			w.index.entries.push(
				entry({ id: "mem_before", created: at(t - 60_000) }),
				entry({ id: "mem_after_1", created: at(t + 60_000) }),
				entry({ id: "mem_after_2", created: at(t + 61_000) }),
				entry({ id: "mem_hermes", created: at(t + 62_000), writer: "hermes" }),
				entry({ id: "mem_elsewhere", created: at(t + 63_000), session_id: "another-session" }),
			);
			seedDocuments(w.plane, w.index.entries);

			// State B, checkpointed, then rolled back to A.
			mutateToB(dir);
			const c2 = await createCheckpoint({ ...base, trigger: "manual" });
			expect(c2.server).toMatchObject({ status: "recorded", stored: true });
			const toolsBefore = server.tools.length;

			const first = await rollback({ ...base, target: c1.checkpoint.ckpt_id, dryRun: false, force: false, offline: false, transcript: new FakeTranscript() });

			// The contract held end to end: one plan, the pre-restore checkpoint, one commit, and no stale-plan round.
			expect(first.status).toBe("committed");
			expect(first.mode).toBe("server");
			expect(server.tools.slice(toolsBefore)).toEqual(["session_rollback_plan", "session_checkpoint", "session_rollback_commit"]);
			expect(new Set(server.bearers)).toEqual(new Set(["Bearer test-token"]));
			expect(first.anchor).toMatchObject({ status: "unverified", source: "server" });
			expect(first.memory).toEqual({ superseded_entries: 2, forgotten_documents: 2, plane_pending: false, truncated: false });
			expect(first.ledger.state).toBe("committed");

			// The files are back: the tree is A's, and every file matches the pinned snapshot of A.
			const now = await snapshot({ worktree: dir, policy: SCENARIO_POLICY, now: FIXED_NOW });
			expect(now.tree).toBe(c1.checkpoint.tree);
			expectWorktreeMatches(dir, await readPinnedSnapshot({ worktree: dir, ref: c1.checkpoint.ref, now: FIXED_NOW }));

			// The ledger: one checkpoint event per checkpoint (A, B and the pre-restore one) and one rollback.
			const checkpoints = sessionEvents(w.ledger.events, "session.checkpoint");
			expect(checkpoints.map((event) => event.payload["ckpt_id"])).toEqual([c1.checkpoint.ckpt_id, c2.checkpoint.ckpt_id, first.pre_restore?.ckpt_id]);
			expect(checkpoints.map((event) => event.payload["seq"])).toEqual([1, 2, 3]);
			const rollbacks = sessionEvents(w.ledger.events, "session.rollback");
			expect(rollbacks).toHaveLength(1);
			const event = rollbacks[0] as SubstrateEvent;
			expect(first.ledger).toMatchObject({ state: "committed", event_id: event.id });
			expect(parseSessionEventPayload(event.payload, { stored: true })).toMatchObject({
				rollback_id: first.rollback_id,
				from_ckpt_id: c2.checkpoint.ckpt_id,
				to_ckpt_id: c1.checkpoint.ckpt_id,
				target_event_id: c1Event.id,
				target_hash: c1Event.hash,
				pre_restore_ckpt_id: first.pre_restore?.ckpt_id,
				pre_restore_tree: c2.checkpoint.tree,
				files_added: first.restore?.files.added,
				files_modified: first.restore?.files.modified,
				files_deleted: first.restore?.files.deleted,
				memory: { superseded_entries: 2, forgotten_documents: 2 },
				transcript: "marker-only",
			});
			// Checkpoints carry the ledger chain position the server observed: B's head is A's event.
			const c2Payload = checkpoints[1]?.payload;
			expect(c2Payload?.["chain_head"]).toEqual({ event_id: c1Event.id, hash: c1Event.hash });
			// Every event of the session is chained to the one before it.
			const chain = w.ledger.events.filter((candidate) => candidate.session_id === SESSION);
			chain.forEach((candidate, position) => expect(candidate.prev).toBe(position === 0 ? null : (chain[position - 1]?.hash ?? null)));

			// The memory: what was written after the checkpoint, by this surface, in this session, is out of force.
			expect(w.index.forgotten().sort()).toEqual(["mem_after_1", "mem_after_2"]);
			for (const kept of ["mem_before", "mem_hermes", "mem_elsewhere"]) expect((await w.index.readEntry(kept))?.superseded_by).toBeUndefined();
			// The rows stay for audit: a forgotten entry is still readable by id, only marked.
			expect((await w.index.readEntry("mem_after_1"))?.superseded_by).toMatch(/^forgotten:fg_[0-9a-f]{26}$/);
			// And its plane document is deleted, the others are not.
			const deletes = w.plane.requests.filter((request) => request.method === "DELETE").map((request) => request.path.split("/").pop());
			expect(deletes.sort()).toEqual(["idem-mem_after_1", "idem-mem_after_2"]);
			expect((w.plane.banks.get(bankOf("claude-code"))?.memories ?? []).map((memory) => memory.document_id)).toEqual(["idem-mem_before", "idem-mem_elsewhere"]);
			expect((w.plane.banks.get(bankOf("hermes"))?.memories ?? []).map((memory) => memory.document_id)).toEqual(["idem-mem_hermes"]);
			// Recall after the rollback: nothing is left in force after the rollback point for this surface and session.
			expect((await w.substrate.sessionRollbackPlan({ session_id: SESSION, target_ckpt_id: c1.checkpoint.ckpt_id }, { surface: "claude-code", isOperator: false })).ok).toBe(true);
			expect((await w.index.memoryEntriesCreatedAfter(SESSION, at(t), null, 100)).entries.map((candidate) => candidate.id)).toEqual(["mem_hermes"]);

			// A second rollback run to the same checkpoint: not drift, no files to change, nothing left to forget.
			const marks = w.index.marks.length;
			const planeRequests = w.plane.requests.length;
			const second = await rollback({ ...base, target: c1.checkpoint.ckpt_id, dryRun: false, force: false, offline: false, transcript: new FakeTranscript() });

			expect(second.status).toBe("committed");
			expect(second.rollback_id).not.toBe(first.rollback_id);
			expect(second.memory).toEqual({ superseded_entries: 0, forgotten_documents: 0, plane_pending: false, truncated: false });
			expect((await snapshot({ worktree: dir, policy: SCENARIO_POLICY, now: FIXED_NOW })).tree).toBe(c1.checkpoint.tree);
			expect(w.index.marks).toHaveLength(marks);
			expect(w.plane.requests).toHaveLength(planeRequests);
			expect(w.index.forgotten().sort()).toEqual(["mem_after_1", "mem_after_2"]);

			// The same commit sent again (a lost reply, a sync) answers the earlier result and writes nothing.
			const firstCommit = server.calls.find((call) => call.tool === "session_rollback_commit" && call.args["rollback_id"] === first.rollback_id);
			expect(firstCommit).toBeDefined();
			const eventsBefore = w.ledger.events.length;
			const repeat = await server.client.commitRollback(firstCommit?.args as unknown as Parameters<RollbackServerClient["commitRollback"]>[0]);

			expect(repeat.ok).toBe(true);
			const repeated: CommitRollbackOk | undefined = repeat.ok ? repeat.value : undefined;
			expect(repeated).toMatchObject({ event_id: event.id, memory: { superseded_entries: 2, forgotten_documents: 2, plane_pending: false, truncated: false } });
			expect(w.ledger.events).toHaveLength(eventsBefore);
			expect(w.index.marks).toHaveLength(marks);
			expect(sessionEvents(w.ledger.events, "session.rollback")).toHaveLength(2);
		});
	});

	test("a checkpoint another surface recorded cannot be planned: the CLI reports it as a server failure and changes no file", async () => {
		const w = world();
		const server = await wire(w.substrate);
		const dir = makeRepo();
		writeScenarioA(dir);
		const pendingDir = join(tempDir(), "pending");
		const base = { worktree: dir, sessionId: SESSION, surface: "claude-code", client: server.client, now: FIXED_NOW, randomBytes: seededRandomBytes(5), pendingDir, policy: SCENARIO_POLICY };
		const c1 = await createCheckpoint({ ...base, trigger: "manual" });
		// The ledger holds the checkpoint as hermes's, not claude-code's: the server must not reveal or use it.
		const recorded = w.ledger.events.find((candidate) => candidate.payload["ckpt_id"] === c1.checkpoint.ckpt_id) as SubstrateEvent;
		recorded.surface = "hermes";
		const before = (await snapshot({ worktree: dir, policy: SCENARIO_POLICY, now: FIXED_NOW })).tree;

		const result = await rollback({ ...base, target: c1.checkpoint.ckpt_id, dryRun: false, force: false, offline: false, transcript: new FakeTranscript() });

		expect(result.status).toBe("failed");
		expect(result.failure?.code).toBe("not-found");
		expect((await snapshot({ worktree: dir, policy: SCENARIO_POLICY, now: FIXED_NOW })).tree).toBe(before);
		expect(sessionEvents(w.ledger.events, "session.rollback")).toHaveLength(0);
	});
});
