/**
 * The multi-day resilience soak (v1.6 phase 62, criterion 1): a simulated 72 hour session on injected clocks shows bounded
 * memory and handle counts, and a clean resume after a restart and after a store failover.
 *
 * Nothing sleeps and nothing touches a network. Bun's system time is the clock (`SoakClock`), so the service's own `Date.now()`
 * follows the simulated hours; the ledger, the memory index, the Hindsight plane, the cache server and Solana are fakes
 * (`soak.testkit.ts`); the files are a REAL temporary git repository driven through the real CLI flow (`createCheckpoint`,
 * `rollback`, `replayPending`) talking to the real MCP server over an in-process client.
 *
 * What the long run proves, with the numbers in `soak.testkit.ts` (`CAPS`) and below:
 *
 * 1. 618 `session_checkpoint` calls (one per 7 simulated minutes), several thousand memory entries, hourly anchors from the
 *    fake ledger and RPC, periodic `checkpoint_verify` and `memory_verify`, three rollbacks (the last to a checkpoint 44 hours
 *    old, forgetting thousands of entries in batches), 42 real checkpoints of a real worktree and real rollbacks with tree equality.
 * 2. After every simulated hour the structures that could grow without bound are under explicit caps, the service's two standing
 *    intervals are the only timers production code holds (and none is left after a shutdown), and two more identical hours add
 *    nothing to any of them (the tripwire). The RAG state machine and the retain outbox, which hold their own bounded maps, are soaked
 *    directly further down.
 * 3. At six points the `Substrate` and the CLI are rebuilt over the same stores and the same repository: replays change nothing,
 *    the local registry and the ledger agree, an interrupted restore is completed, never left partial.
 * 4. The ledger is down for 182 minutes (journalled, bounded, delivered exactly once, late-recorded checkpoints cut memory at the
 *    time they were TAKEN), then the Hindsight plane, the index and Solana each fail (Solana inside the long run, the others in a
 *    world of their own).
 * 5. At the end the pure consistency verifier finds no drift, and a planted drift is found.
 *
 * Fail-before checks sit at the bottom: each mutates a fake or a cap and asserts the run would have noticed.
 */
import { afterAll, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createCheckpoint, listLocalCheckpoints } from "../../cli/src/session/checkpoint.ts";
import { type FetchLike as CliFetch, type RollbackServerClient, createRollbackServerClient } from "../../cli/src/session/client.ts";
import { listPending, replayPending } from "../../cli/src/session/pending.ts";
import { type RollbackParams, type RollbackResult, rollback } from "../../cli/src/session/rollback.ts";
import { FakeTranscript, seededRandomBytes } from "../../cli/src/session/testkit.ts";
import { SimulatedCrash, snapshot } from "../../worktree-snapshot/src/index.ts";
import { cleanupTemp, makeRepo, tempDir } from "../../worktree-snapshot/src/testkit.ts";
import { DEVNET_GENESIS_HASH } from "./anchor.ts";
import { DEFAULT_RAG_MACHINE_SETTINGS } from "./config.ts";
import { type Timer, verifyConsistency } from "./consistency-verify.ts";
import { RagStateMachine } from "./mcp.ts";
import { type RetainDeliveryOutcome, type RetainDropCause, type RetainOutboxEntry, RetainOutbox } from "./retain-outbox.ts";
import { FORGET_BATCH_SIZE, MAX_SAMPLE_IDS } from "./session-rollback.ts";
import type { RandomBytes } from "./session-events.ts";
import { type McpHarness, ckptId, rbId, withPlaneEnv } from "./session-rollback.testkit.ts";
import {
	CAPS,
	type BoundedSizes,
	type Boot,
	HOUR_MS,
	HandleTracker,
	MINUTE,
	SOAK_SCOPE,
	SoakClock,
	T0,
	boot,
	ckptRequest,
	consistencyReaders,
	hex40,
	makeFakes,
	measure,
	mutateWorktree,
	planeDeletes,
	planeDocuments,
	privateMap,
	privateSize,
	seedPlaneDocument,
	seedWorktree,
	seeded,
	shutdown,
	soakEntry,
	violations,
} from "./soak.testkit.ts";

afterAll(cleanupTemp);
// The 72 hour simulation is CPU-bound and takes about 280 s on this host; 900 s keeps host load from failing it.
setDefaultTimeout(900_000);

type Json = Record<string, unknown>;

const TICK = 7 * MINUTE;
/** 618 ticks of 7 minutes: 72.1 hours. */
const TICKS = 618;
/** One steady "hour" of the tripwire: nine ticks, 63 minutes. */
const STEADY_TICKS = 9;
const SESSION_A = "soak-72h";
const SESSION_B = "soak-cli";
/** The ledger is down for ticks 306 to 331: 26 ticks, 182 minutes. */
const OUTAGE_FROM = 306;
const OUTAGE_TO = 332;
/** A real checkpoint of the real worktree every 15 ticks: 42 of them in 618 ticks. */
const CLI_EVERY = 15;
const RESTART_TICKS: readonly number[] = [150, 320, 520];
/** Events the ledger may gain per simulated hour (checkpoints, memory-write audits, rollback notes): the one linear growth. */
const LEDGER_EVENTS_PER_HOUR = 150;

// ---------------------------------------------------------------------------
// The simulation: one clock, the fakes that outlive a restart, and a running `Substrate`
// ---------------------------------------------------------------------------

/** A session's client-side view: the number of its newest checkpoint and its seq counter. */
interface SessionTrack {
	id: string;
	lastN: number | null;
	seq: number;
}

interface PlanJson {
	ok: true;
	plan: {
		rollback_id: string;
		plan_digest: string;
		later_checkpoints: Array<{ ckpt_id: string; seq: number }>;
		anchor: { status: string; reasons: string[] } | null;
		memory: { would_forget: number; sample_ids: string[]; truncated: boolean };
	};
}

/** The flags under which a production boot starts timers of its own: the brief's recall prefetch and the read-only Hindsight inventory. */
const BACKGROUND_ENV = { SUBSTRATE_BRIEF_RECALL: "shadow", SUBSTRATE_HINDSIGHT_INVENTORY: "on" } as const;

/** The telemetry buffer on, in a fresh directory: an event an outage refuses is parked for the ledger instead of being dropped. */
function bufferEnv(): Record<string, string> {
	const dir = tempDir("soak-event-buffer-");
	return { SUBSTRATE_EVENT_BUFFER_PATH: join(dir, "buffer.jsonl"), SUBSTRATE_EVENT_DEAD_LETTER_PATH: join(dir, "dead-letter.jsonl") };
}

class Sim {
	readonly fakes = makeFakes();
	readonly clock = new SoakClock();
	readonly tracker = new HandleTracker();
	running!: Boot;
	private entryCount = 0;
	private ckptCount = 0;
	private env: Record<string, string> = {};
	private background = false;

	/** Standing timers production code holds while the service runs: one interval each for the recall prefetch and the inventory, or none. */
	get expectedTimers(): number {
		return this.background ? 2 : 0;
	}

	/** `background` also starts the service's own background tasks (their intervals are the standing handles the run counts). */
	async start(env: Record<string, string> = {}, background = false): Promise<void> {
		this.tracker.install();
		this.background = background;
		this.env = { ...env, ...(background ? BACKGROUND_ENV : {}) };
		this.running = await boot(this.fakes, this.env);
		await this.startBackground();
	}

	/** Tear the service down the way a shutdown does (nothing with a timer may be left) and build another over the same stores. */
	async restart(): Promise<void> {
		await shutdown(this.running);
		expect(this.tracker.outstanding()).toEqual([]);
		this.running = await boot(this.fakes, this.env);
		await this.startBackground();
	}

	private async startBackground(): Promise<void> {
		if (!this.background) return;
		expect(this.running.substrate.startRecall()).toEqual({ recall: true, inventory: true });
		// The inventory probes once at start; let that settle, so the probe's own deadline timer is not counted as a standing handle.
		await this.running.substrate.refreshHindsightInventory();
		expect(this.tracker.outstanding().map((timer) => timer.kind)).toEqual(["interval", "interval"]);
	}

	/** The shutdown path; whatever production code left behind after it is a leak, reported after the tracker is removed. */
	async stop(): Promise<void> {
		let left: Array<{ kind: string; origin: string }> = [];
		try {
			await shutdown(this.running);
			left = this.tracker.outstanding();
		} finally {
			this.tracker.uninstall();
			this.clock.restore();
		}
		expect(left).toEqual([]);
	}

	async call(tool: string, args: Json): Promise<{ isError: boolean; json: Json }> {
		const result = await this.running.mcp.call(tool, args);
		return { isError: result.isError, json: result.json };
	}

	/** The next checkpoint of `track`, taken at `takenAtMs`: its request body (the ledger has not heard of it yet). */
	takeCheckpoint(track: SessionTrack, trigger = "turn", takenAtMs: number = this.clock.now()): { request: Json; n: number } {
		const n = ++this.ckptCount;
		const request = ckptRequest({ n, seq: ++track.seq, prev: track.lastN, session: track.id, trigger, takenAtMs });
		track.lastN = n;
		return { request, n };
	}

	/** Write `count` governed-looking entries: the index row, the plane document and the ledger's write audit. Created at `startMs` + j seconds (or minus, for `direction: -1`). */
	writeEntries(session: string, count: number, startMs: number, options: { hermesEvery?: number; direction?: 1 | -1 } = {}): string[] {
		const ids: string[] = [];
		for (let j = 1; j <= count; j++) {
			const n = ++this.entryCount;
			const createdMs = startMs + (options.direction ?? 1) * j * 1000;
			const writer = options.hermesEvery !== undefined && n % options.hermesEvery === 0 ? "hermes" : "claude-code";
			const audit = this.fakes.ledger.appendMemoryWrite({ id: `evt_mw_${n}`, tsMs: createdMs, surface: writer, scope: SOAK_SCOPE, kind: "fact" });
			const entry = soakEntry({ n, session, createdMs, sourceEvent: audit.id, writer });
			this.fakes.index.add(entry);
			seedPlaneDocument(this.fakes.plane, entry);
			ids.push(entry.id);
		}
		return ids;
	}

	/** What a rollback to a checkpoint that cuts at `cutMs` should forget, from the index rows themselves, not from the code under test. Oldest first. */
	expectedForget(session: string, cutMs: number, untilMs: number): string[] {
		return this.fakes.index.entries
			.filter((e) => e.session_id === session && e.writer === "claude-code" && e.superseded_by === undefined && Date.parse(e.created) > cutMs && Date.parse(e.created) <= untilMs)
			.sort((a, b) => Date.parse(a.created) - Date.parse(b.created) || (a.id < b.id ? -1 : 1))
			.map((e) => e.id);
	}

	async plan(track: SessionTrack, targetN: number, rollbackN: number, untilMs: number): Promise<PlanJson> {
		const answer = await this.call("session_rollback_plan", { session_id: track.id, target_ckpt_id: ckptId(targetN), rollback_id: rbId(rollbackN), until_ms: untilMs });
		return answer.json as unknown as PlanJson;
	}

	/** The commit body of a rollback, with the fields a real client sends. */
	commitBody(track: SessionTrack, targetN: number, rollbackN: number, digest: string, fromN: number, preN: number, untilMs: number): Json {
		return {
			session_id: track.id,
			rollback_id: rbId(rollbackN),
			target_ckpt_id: ckptId(targetN),
			plan_digest: digest,
			outcome: "committed",
			from_ckpt_id: ckptId(fromN),
			pre_restore_tree: hex40(preN),
			pre_restore_ckpt_id: ckptId(preN),
			files: { added: 2, modified: 5, deleted: 1 },
			transcript: "marker-only",
			until_ms: untilMs,
		};
	}

	/** Between plan and commit a client records its pre-restore checkpoint; returns the commit body that names it. */
	async preRestoreAndCommitBody(track: SessionTrack, targetN: number, rollbackN: number, planned: PlanJson, untilMs: number): Promise<Json> {
		const fromN = track.lastN as number;
		const pre = this.takeCheckpoint(track, "pre-restore");
		expect((await this.call("session_checkpoint", pre.request)).json).toMatchObject({ ok: true, stored: true });
		return this.commitBody(track, targetN, rollbackN, planned.plan.plan_digest, fromN, pre.n, untilMs);
	}
}

// ---------------------------------------------------------------------------
// The CLI side: a client over the in-process MCP server, rebuilt at every restart
// ---------------------------------------------------------------------------

interface RpcCall {
	params: { name: string; arguments: Json };
}

/** The CLI's `RollbackServerClient`, pointed at the in-process MCP client through a fetch that answers in the server's JSON-RPC shape. */
function wireClient(mcp: McpHarness): RollbackServerClient {
	const fetchImpl: CliFetch = async (_url, init) => {
		const { name, arguments: args } = (JSON.parse(init.body) as RpcCall).params;
		const result = await mcp.client.callTool({ name, arguments: args });
		const body = { jsonrpc: "2.0", id: 1, result: { content: result.content, isError: result.isError === true } };
		return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
	};
	return createRollbackServerClient({ url: "http://substrate.test", token: "test-token", timeoutMs: 5_000, fetch: fetchImpl, signalFor: () => new AbortController().signal });
}

interface Cli {
	dir: string;
	pendingDir: string;
	client: RollbackServerClient;
	randomBytes: RandomBytes;
}

/** A CLI process: new client, new id source (a restarted process must not mint the ids of the last one). */
function newCli(dir: string, pendingDir: string, mcp: McpHarness, generation: number): Cli {
	return { dir, pendingDir, client: wireClient(mcp), randomBytes: seededRandomBytes(1_000 + generation) };
}

const cliClock = (): Date => new Date();

function cliCheckpoint(cli: Cli, trigger: "turn" | "manual" = "turn") {
	return createCheckpoint({ worktree: cli.dir, sessionId: SESSION_B, trigger, surface: "claude-code", client: cli.client, now: cliClock, randomBytes: cli.randomBytes, pendingDir: cli.pendingDir });
}

function cliRollback(cli: Cli, target: string, extra: Partial<RollbackParams> = {}): Promise<RollbackResult> {
	return rollback({
		worktree: cli.dir,
		sessionId: SESSION_B,
		target,
		dryRun: false,
		force: false,
		offline: false,
		surface: "claude-code",
		client: cli.client,
		transcript: new FakeTranscript(),
		now: cliClock,
		randomBytes: cli.randomBytes,
		pendingDir: cli.pendingDir,
		...extra,
	});
}

const treeOf = async (dir: string): Promise<string> => (await snapshot({ worktree: dir, now: cliClock })).tree;

// ---------------------------------------------------------------------------
// The 72 hour run
// ---------------------------------------------------------------------------

describe("a 72 hour session on injected clocks", () => {
	test("stays bounded, leaves no handle, and resumes cleanly after restarts and a ledger failover", async () => {
		await withPlaneEnv(async () => {
			const sim = new Sim();
			await sim.start({}, true);
			try {
				await runSoak(sim);
			} finally {
				await sim.stop();
			}
		});
	});
});

async function runSoak(sim: Sim): Promise<void> {
	const { fakes, clock, tracker } = sim;
	/** The shared caps, except that the two standing intervals of the service's background tasks are expected. */
	const caps: BoundedSizes = { ...CAPS, timers: sim.expectedTimers };
	const rand = seeded(20_261_020);
	const cliRand = seeded(77);
	const dir = makeRepo();
	seedWorktree(dir);
	const pendingDir = join(tempDir(), "pending");
	let generation = 1;
	let cli = newCli(dir, pendingDir, sim.running.mcp, generation);
	const A: SessionTrack = { id: SESSION_A, lastN: null, seq: 0 };

	const tickAt = (k: number): number => T0 + k * TICK;
	/** Tick -> the checkpoint of session A recorded at it. */
	const ckptByTick = new Map<number, { n: number; eventId: string }>();
	/** The checkpoints of the real worktree, by tick. */
	const cliCheckpoints = new Map<number, { ckptId: string; tree: string; takenAtMs: number }>();
	/** A client's journal of the synthetic session's checkpoints the ledger did not take. Bounded like the CLI's. */
	const journalA: Json[] = [];
	let lastRecorded: { request: Json; eventId: string } | null = null;
	let lastHour = -1;
	const seriesMax: BoundedSizes = { emitChains: 0, retainChains: 0, completionChains: 0, retainOutbox: 0, redisKeys: 0, cacheInflight: 0, journalItems: 0, journalBytes: 0, journalTemps: 0, timers: 0 };

	const counts = (): { events: number; marks: number; deletes: number; forgotten: number; pending: number } => ({
		events: fakes.ledger.events.length,
		marks: fakes.index.marks.length,
		deletes: planeDeletes(fakes.plane).length,
		forgotten: fakes.index.forgotten().length,
		pending: existsSync(pendingDir) ? listPending(pendingDir).items.length : 0,
	});

	/** The local registry and the ledger agree: every local checkpoint of the session is in the ledger exactly once or in the journal, never both, never neither. */
	async function expectRegistryMatchesLedger(label: string): Promise<void> {
		const local = await listLocalCheckpoints({ worktree: dir });
		expect({ label, invalid: local.invalid }).toEqual({ label, invalid: [] });
		const registry = local.checkpoints.filter((c) => c.session_id === SESSION_B).map((c) => c.ckpt_id);
		const ledgerIds = fakes.ledger
			.byAction("session.checkpoint")
			.filter((e) => e.session_id === SESSION_B)
			.map((e) => String(e.payload["ckpt_id"]));
		const pendingIds = existsSync(pendingDir) ? listPending(pendingDir).items.filter((item) => item.kind === "checkpoint").map((item) => item.id) : [];
		expect({ label, ids: [...ledgerIds, ...pendingIds].sort() }).toEqual({ label, ids: [...registry].sort() });
	}

	/** Tear everything down and build it again over the same stores and the same repository. Nothing may change by restarting. */
	async function restartAll(label: string): Promise<void> {
		const before = counts();
		await sim.restart();
		generation++;
		cli = newCli(dir, pendingDir, sim.running.mcp, generation);
		expect({ label, ...counts() }).toEqual({ label, ...before });
		await expectRegistryMatchesLedger(label);
		if (lastRecorded !== null && !fakes.ledger.down) {
			// The newest checkpoint offered again (a client that did not hear the reply): the same event, nothing written.
			const again = (await sim.call("session_checkpoint", lastRecorded.request)).json;
			expect({ label, again }).toMatchObject({ again: { ok: true, stored: false, event_id: lastRecorded.eventId } });
			expect({ label, ...counts() }).toEqual({ label, ...before });
		}
	}

	// -- evidence: checkpoint_verify and memory_verify -----------------------------------------------------------

	const verifyOf = async (args: Json): Promise<Json> => (await sim.call("checkpoint_verify", args)).json;

	async function verifyEvidence(hour: number): Promise<void> {
		// A checkpoint recorded at least three hours ago is inside a closed, anchored hour.
		let tick = Math.floor(((hour - 3) * 60) / 7);
		while (tick > 0 && !ckptByTick.has(tick)) tick--;
		const old = ckptByTick.get(tick);
		expect(old).toBeDefined();
		const anchored = await verifyOf({ event_id: old?.eventId });
		expect({ hour, status: anchored["status"], reasons: anchored["reasons"] }).toEqual({ hour, status: "anchored", reasons: [] });
		expect(anchored["checkpoint"]).toMatchObject({ ckpt_id: ckptId(old?.n as number), session_id: SESSION_A });
		// The newest one is in an hour that has not closed yet, or just did: pending or anchored, never anything else.
		const newest = lastRecorded;
		expect(newest).not.toBeNull();
		expect(["pending", "anchored"]).toContain((await verifyOf({ event_id: newest?.eventId }))["status"] as string);
		// By checkpoint id, searched in the named session's newest notes.
		const recent = ckptByTick.get(Math.max(...ckptByTick.keys()));
		expect(["pending", "anchored"]).toContain((await verifyOf({ ckpt_id: ckptId(recent?.n as number), session_id: SESSION_A }))["status"] as string);
		// A memory entry from the middle of the run, still in force: its hash is intact and the write event it names is anchored.
		const entry = fakes.index.entries.find((e, at) => at >= fakes.index.entries.length / 2 && e.writer === "claude-code" && e.superseded_by === undefined);
		expect(entry).toBeDefined();
		const verified = (await sim.call("memory_verify", { id: entry?.id })).json;
		expect({ hour, id: entry?.id, status: verified["status"] }).toEqual({ hour, id: entry?.id, status: "verified" });
	}

	/** Solana unreachable, then answering from another cluster, then back: never a mismatch, and the reasons say which. */
	async function chainFaults(): Promise<void> {
		const target = ckptByTick.get(Math.floor((30 * 60) / 7));
		expect(target).toBeDefined();
		const args = { event_id: target?.eventId };
		expect((await verifyOf(args))["status"]).toBe("anchored");

		fakes.rpc.down = "connect ECONNREFUSED (simulated RPC outage)";
		const unreachable = await verifyOf(args);
		expect(unreachable["status"]).toBe("unverified");
		expect((unreachable["reasons"] as string[]).join(" ")).toMatch(/could not be read/);
		const memoryDuring = (await sim.call("memory_verify", { id: fakes.index.entries[0]?.id })).json;
		expect(["unverified", "pending", "unanchored"]).toContain(memoryDuring["status"] as string);
		expect(memoryDuring["status"]).not.toBe("anchor-mismatch");

		fakes.rpc.down = null;
		fakes.rpc.genesis = `ResetDevnetGenesis${"1".repeat(26)}`;
		const reset = await verifyOf(args);
		expect(reset["status"]).toBe("unverified");
		expect((reset["reasons"] as string[]).join(" ")).toMatch(/reset/);

		fakes.rpc.genesis = DEVNET_GENESIS_HASH;
		expect((await verifyOf(args))["status"]).toBe("anchored");
	}

	async function hourBarrier(hour: number): Promise<void> {
		const sizes = measure(sim.running, fakes, pendingDir, tracker);
		expect({ hour, over: violations(sizes, caps), timers: sizes.timers, standing: tracker.outstanding().map((timer) => timer.kind) }).toEqual({ hour, over: [], timers: sim.expectedTimers, standing: ["interval", "interval"] });
		for (const name of Object.keys(seriesMax) as Array<keyof BoundedSizes>) seriesMax[name] = Math.max(seriesMax[name], sizes[name]);
		// The ledger's event count is the one thing allowed to grow, and only linearly in the simulated hours.
		expect(fakes.ledger.events.length).toBeLessThanOrEqual(LEDGER_EVENTS_PER_HOUR * (hour + 1) + 400);
		if (fakes.ledger.down || hour < 4) return;
		if (hour % 4 === 0) await verifyEvidence(hour);
		if (hour === 50) await chainFaults();
	}

	// -- the ledger failover -------------------------------------------------------------------------------------

	/** While the ledger is down, the session tools answer ledger-down and retryable, and change nothing. */
	async function expectOutageAnswers(): Promise<void> {
		const before = counts();
		const plan = (await sim.call("session_rollback_plan", { session_id: A.id, target_ckpt_id: ckptId(1), rollback_id: rbId(900), until_ms: clock.now() })).json;
		expect(plan).toMatchObject({ ok: false, error: { code: "ledger-down", retryable: true } });
		const commit = (await sim.call("session_rollback_commit", sim.commitBody(A, 1, 900, "a".repeat(64), 2, 3, clock.now()))).json;
		expect(commit).toMatchObject({ ok: false, error: { code: "ledger-down", retryable: true } });
		expect(counts()).toEqual(before);
	}

	async function recoverLedger(k: number): Promise<void> {
		const recoveredAt = tickAt(k);
		const before = fakes.ledger.events.length;
		expect(journalA.length).toBeGreaterThanOrEqual(25);
		fakes.ledger.setDown(false);
		fakes.chain.anchorDue(recoveredAt);
		// The synthetic client delivers its journal in order: each exactly once.
		const delivered: string[] = [];
		for (const request of journalA) {
			const answer = (await sim.call("session_checkpoint", request)).json;
			expect(answer).toMatchObject({ ok: true, stored: true });
			expect(answer["warnings"]).toBeUndefined();
			delivered.push(String(answer["event_id"]));
		}
		expect(new Set(delivered).size).toBe(journalA.length);
		expect(fakes.ledger.events.length - before).toBe(journalA.length);
		// Offered again, nothing is stored twice.
		for (const [at, request] of journalA.entries()) {
			expect((await sim.call("session_checkpoint", request)).json).toMatchObject({ ok: true, stored: false, event_id: delivered[at] });
		}
		expect(fakes.ledger.events.length - before).toBe(journalA.length);
		// Recorded late, each carries the time it was TAKEN, and its ledger time is the recovery.
		for (const [at, request] of journalA.entries()) {
			const event = fakes.ledger.events.find((candidate) => candidate.id === delivered[at]);
			expect(event?.payload["taken_at_ms"]).toBe(request["taken_at_ms"]);
			expect(Date.parse(event?.ts ?? "")).toBe(recoveredAt);
			expect(request["taken_at_ms"] as number).toBeLessThan(recoveredAt);
		}
		lastRecorded = { request: journalA[journalA.length - 1] as Json, eventId: delivered[delivered.length - 1] as string };
		journalA.length = 0;

		// The CLI's journal: every undelivered checkpoint, once.
		const queued = listPending(pendingDir).items;
		expect(queued.length).toBeGreaterThanOrEqual(2);
		expect(queued.every((item) => item.kind === "checkpoint")).toBe(true);
		const synced = await replayPending({ dir: pendingDir, clientFor: () => cli.client });
		expect(synced).toMatchObject({ remaining: 0, failed: [], skipped: 0, corrupt: [] });
		expect(synced.delivered.map((item) => item.id).sort()).toEqual(queued.map((item) => item.id).sort());
		const eventsAfterSync = fakes.ledger.events.length;
		const again = await replayPending({ dir: pendingDir, clientFor: () => cli.client });
		expect(again).toMatchObject({ delivered: [], remaining: 0 });
		expect(fakes.ledger.events.length).toBe(eventsAfterSync);
		// The checkpoint taken during the outage is in the ledger with its taken-at time, so a rollback to it cuts at that instant.
		for (const item of queued) {
			if (item.kind !== "checkpoint") continue;
			const event = fakes.ledger.byAction("session.checkpoint").find((candidate) => candidate.payload["ckpt_id"] === item.id);
			expect(event?.payload["taken_at_ms"]).toBe(item.record.taken_at_ms);
			expect(Date.parse(event?.ts ?? "")).toBeGreaterThanOrEqual(recoveredAt);
		}
		await expectRegistryMatchesLedger("after the ledger recovered");
		expect(counts().pending).toBe(0);
	}

	/** Roll the real worktree back to the checkpoint taken while the ledger was down: the memory cut is the time it was taken. */
	async function lateRecordRollback(k: number): Promise<void> {
		clock.set(tickAt(k) + MINUTE);
		const targetTick = OUTAGE_FROM + 9;
		const target = cliCheckpoints.get(targetTick);
		expect(target).toBeDefined();
		const untilMs = clock.now();
		const expected = sim.expectedForget(SESSION_B, target?.takenAtMs as number, untilMs);
		// Entries written during the outage, after the checkpoint was taken, are in the set: a record-time cut would keep them.
		const duringOutage = expected.filter((id) => Date.parse(fakes.index.entries.find((e) => e.id === id)?.created ?? "") < tickAt(OUTAGE_TO));
		expect(duringOutage.length).toBeGreaterThanOrEqual(10);

		const result = await cliRollback(cli, target?.ckptId as string);
		expect({ status: result.status, mode: result.mode, refusal: result.refusal }).toEqual({ status: "committed", mode: "server", refusal: undefined });
		expect(result.memory).toEqual({ superseded_entries: expected.length, forgotten_documents: expected.length, plane_pending: false, truncated: false });
		expect(await treeOf(dir)).toBe(target?.tree as string);
		const forgotten = new Set(fakes.index.forgotten());
		for (const id of expected) expect(forgotten.has(id)).toBe(true);
		expect([...forgotten].filter((id) => fakes.index.entries.find((e) => e.id === id)?.session_id === SESSION_B).sort()).toEqual([...expected].sort());
		await expectRegistryMatchesLedger("after the late-recorded rollback");
	}

	// -- the synthetic session's rollbacks -------------------------------------------------------------------------

	async function rollbackA(at: number, targetTick: number, rollbackN: number, flow: { restartAfterPlan?: boolean; restartAfterCommit?: boolean; anchor: "pending" | "anchored" }): Promise<string[]> {
		clock.set(tickAt(at) + MINUTE);
		const target = ckptByTick.get(targetTick);
		expect(target).toBeDefined();
		const untilMs = clock.now();
		const expected = sim.expectedForget(SESSION_A, tickAt(targetTick), untilMs);
		expect(expected.length).toBeGreaterThan(0);

		const planned = await sim.plan(A, target?.n as number, rollbackN, untilMs);
		expect(planned.ok).toBe(true);
		expect(planned.plan.memory).toMatchObject({ would_forget: expected.length, truncated: false });
		expect(planned.plan.memory.sample_ids).toHaveLength(Math.min(MAX_SAMPLE_IDS, expected.length));
		for (const id of planned.plan.memory.sample_ids) expect(expected).toContain(id);
		expect(planned.plan.later_checkpoints.length).toBeGreaterThan(0);
		// The anchor verdict of the target: still inside an open hour, or inside a closed and anchored one.
		expect(planned.plan.anchor?.status).toBe(flow.anchor);

		if (flow.restartAfterPlan === true) {
			await restartAll(`rollback ${rollbackN}: plan`);
			// The same plan again: the digest, the memory, the anchor verdict, everything.
			expect(await sim.plan(A, target?.n as number, rollbackN, untilMs)).toEqual(planned);
		}

		const body = await sim.preRestoreAndCommitBody(A, target?.n as number, rollbackN, planned, untilMs);
		const before = counts();
		const committed = (await sim.call("session_rollback_commit", body)).json;
		expect(committed).toMatchObject({ ok: true, memory: { superseded_entries: expected.length, forgotten_documents: expected.length, plane_pending: false, truncated: false } });
		expect(committed["replayed"]).toBeUndefined();

		// Forgotten in whole batches of at most FORGET_BATCH_SIZE, exactly the expected set, one note per batch, one rollback note.
		const marks = fakes.index.marks.slice(before.marks);
		expect(marks).toHaveLength(Math.ceil(expected.length / FORGET_BATCH_SIZE));
		for (const mark of marks) expect(mark.ids.length).toBeLessThanOrEqual(FORGET_BATCH_SIZE);
		expect(marks.flatMap((mark) => mark.ids).sort()).toEqual([...expected].sort());
		expect(counts().deletes - before.deletes).toBe(expected.length);
		const notes = fakes.ledger.byAction("memory.forget").filter((event) => event.payload["rollback_id"] === rbId(rollbackN));
		expect(notes).toHaveLength(marks.length);
		const rollbackNotes = fakes.ledger.byAction("session.rollback").filter((event) => event.payload["rollback_id"] === rbId(rollbackN));
		expect(rollbackNotes).toHaveLength(1);
		expect(rollbackNotes[0]?.payload["memory"]).toEqual({ superseded_entries: expected.length, forgotten_documents: expected.length });
		const afterCommit = counts();

		if (flow.restartAfterCommit === true) await restartAll(`rollback ${rollbackN}: commit`);
		// The same commit again (a lost reply, a sync after a restart): the earlier answer, and not one store changes.
		const replay = (await sim.call("session_rollback_commit", body)).json;
		expect(replay).toMatchObject({ ok: true, replayed: true, event_id: committed["event_id"], memory: { superseded_entries: expected.length, forgotten_documents: expected.length, plane_pending: false } });
		expect(counts()).toEqual(afterCommit);
		// The control entries (another surface's writes in the same session) are untouched.
		for (const entry of fakes.index.entries) if (entry.writer === "hermes") expect(entry.superseded_by).toBeUndefined();
		return expected;
	}

	// -- one tick of the run -----------------------------------------------------------------------------------

	async function tick(k: number, options: { cli: boolean }): Promise<void> {
		const t = tickAt(k);
		clock.set(t);
		fakes.chain.anchorDue(t);
		const hour = Math.floor((t - T0) / HOUR_MS);
		if (hour > lastHour) {
			lastHour = hour;
			await hourBarrier(hour);
		}
		if (RESTART_TICKS.includes(k)) await restartAll(`restart at tick ${k}`);
		if (k === OUTAGE_FROM) fakes.ledger.setDown(true);
		if (k === OUTAGE_TO) await recoverLedger(k);
		if (k === OUTAGE_FROM + 4) await expectOutageAnswers();

		// The synthetic session's checkpoint, one per tick.
		const { request, n } = sim.takeCheckpoint(A);
		const answer = (await sim.call("session_checkpoint", request)).json;
		if (fakes.ledger.down) {
			expect(answer).toMatchObject({ ok: false, error: { code: "ledger-down", retryable: true } });
			journalA.push(request);
			expect(journalA.length).toBeLessThanOrEqual(CAPS.journalItems);
		} else {
			expect(answer).toMatchObject({ ok: true, stored: true });
			ckptByTick.set(k, { n, eventId: String(answer["event_id"]) });
			lastRecorded = { request, eventId: String(answer["event_id"]) };
		}

		// A real checkpoint of the real worktree, with real file changes between them.
		if (options.cli && k % CLI_EVERY === 0) {
			mutateWorktree(dir, cliRand, k);
			const result = await cliCheckpoint(cli);
			if (fakes.ledger.down) {
				expect(result.server).toMatchObject({ status: "pending", code: "ledger-down" });
				expect(counts().pending).toBeLessThanOrEqual(CAPS.journalItems);
			} else {
				expect(result.server).toMatchObject({ status: "recorded", stored: true });
			}
			cliCheckpoints.set(k, { ckptId: result.checkpoint.ckpt_id, tree: result.checkpoint.tree, takenAtMs: result.checkpoint.taken_at_ms as number });
		}

		// Memory written all along: the audit lands in the ledger, the row in the index, the document in the plane.
		sim.writeEntries(SESSION_A, 6 + Math.floor(rand() * 5), t, { hermesEvery: 25 });
		sim.writeEntries(SESSION_B, 1 + Math.floor(rand() * 2), t + 20_000);
	}

	// -- the run ---------------------------------------------------------------------------------------------------

	for (let k = 0; k < TICKS; k++) {
		await tick(k, { cli: true });
		if (k === OUTAGE_TO) await lateRecordRollback(k);
		if (k === 205) await rollbackA(205, 200, 1, { anchor: "pending" });
		if (k === 411) await rollbackA(411, 400, 2, { anchor: "anchored", restartAfterPlan: true, restartAfterCommit: true });
		if (k === 520) await crashAndRecover(k);
	}
	// The last rollback: to a checkpoint 44 hours old, with thousands of entries to forget in batches.
	const old = await rollbackA(TICKS - 1, 240, 3, { anchor: "anchored" });
	expect(old.length).toBeGreaterThan(2_000);

	/** An interrupted restore of the real worktree is completed on the next run: never left partial. */
	async function crashAndRecover(k: number): Promise<void> {
		clock.set(tickAt(k) + MINUTE);
		const target = cliCheckpoints.get(495);
		expect(target).toBeDefined();
		const untilMs = clock.now();
		const expected = sim.expectedForget(SESSION_B, target?.takenAtMs as number, untilMs);
		expect(expected.length).toBeGreaterThan(0);
		const hooks = {
			beforeOp: (index: number): void => {
				if (index === 1) throw new SimulatedCrash("the process died mid-restore");
			},
		};
		await expect(cliRollback(cli, target?.ckptId as string, { hooks })).rejects.toBeInstanceOf(SimulatedCrash);
		const journal = join(dir, ".git", "substrate-restore", "restore-journal.json");
		expect(existsSync(journal)).toBe(true);
		expect(await treeOf(dir)).not.toBe(target?.tree);
		await restartAll("crash mid-restore");
		const result = await cliRollback(cli, target?.ckptId as string);
		expect(result.recovered).toMatchObject({ direction: "forward" });
		expect({ status: result.status, refusal: result.refusal }).toEqual({ status: "committed", refusal: undefined });
		expect(result.memory).toEqual({ superseded_entries: expected.length, forgotten_documents: expected.length, plane_pending: false, truncated: false });
		expect(existsSync(journal)).toBe(false);
		expect(existsSync(join(dir, ".git", "substrate-restore.lock"))).toBe(false);
		expect(await treeOf(dir)).toBe(target?.tree as string);
		await expectRegistryMatchesLedger("after the interrupted restore");
	}

	// -- the tripwire: the same hour twice more must not grow anything ---------------------------------------------
	const steady: BoundedSizes[] = [];
	for (let pass = 0; pass < 2; pass++) {
		for (let k = TICKS + pass * STEADY_TICKS; k < TICKS + (pass + 1) * STEADY_TICKS; k++) await tick(k, { cli: false });
		steady.push(measure(sim.running, fakes, pendingDir, tracker));
	}
	expect(violations(steady[1] as BoundedSizes, caps)).toEqual([]);
	expect(steady[1]).toEqual(steady[0]);

	// -- what the run covered, and where it peaked -----------------------------------------------------------------
	expect(cliCheckpoints.size).toBeGreaterThanOrEqual(40);
	expect(fakes.index.entries.length).toBeGreaterThan(3_000);
	expect(ckptByTick.size).toBe(TICKS + 2 * STEADY_TICKS - (OUTAGE_TO - OUTAGE_FROM));
	expect(fakes.chain.hours.length).toBeGreaterThanOrEqual(70);
	expect(seriesMax.journalItems).toBeGreaterThanOrEqual(1);
	expect(seriesMax.journalItems).toBeLessThanOrEqual(CAPS.journalItems);
	expect(violations(seriesMax, caps)).toEqual([]);
	await expectRegistryMatchesLedger("at the end");
	const local = await listLocalCheckpoints({ worktree: dir });
	expect(local.checkpoints.filter((c) => c.session_id === SESSION_B).length).toBeGreaterThanOrEqual(42);

	// -- the final cross-store consistency check -------------------------------------------------------------------
	const inert: Timer = { after: () => () => {} };
	const options = { now: () => clock.now(), bankFor: (writer: string) => `sub-${writer}`, maxEntries: 20_000, maxDocuments: 20_000, maxLedgerEvents: 50_000, timer: inert };
	const report = await verifyConsistency(consistencyReaders(fakes), options);
	expect(report.findings).toEqual([]);
	expect(report).toMatchObject({ ok: true, truncated: false });
	expect(report.counts.entries_examined).toBe(fakes.index.entries.length);
	expect(report.counts.entries_forgotten).toBeGreaterThan(2_500);
	expect(tracker.outstanding()).toHaveLength(sim.expectedTimers);

	// A planted drift is found: the check above is not vacuous.
	const victim = [...fakes.index.entries].reverse().find((e) => e.writer === "claude-code" && e.superseded_by === undefined && Date.parse(e.created) < clock.now() - 5 * MINUTE);
	expect(victim).toBeDefined();
	const bank = fakes.plane.banks.get("sub-claude-code");
	const at = (bank?.memories ?? []).findIndex((memory) => memory.metadata["entry_id"] === victim?.id);
	expect(at).toBeGreaterThanOrEqual(0);
	const [removed] = bank?.memories.splice(at, 1) ?? [];
	const drifted = await verifyConsistency(consistencyReaders(fakes), options);
	expect(drifted.ok).toBe(false);
	expect(drifted.findings.map((finding) => finding.code)).toContain("index_entry_missing_in_plane");
	if (removed !== undefined) bank?.memories.push(removed);
}

// ---------------------------------------------------------------------------
// The other failovers, each in a world of its own
// ---------------------------------------------------------------------------

describe("the Hindsight plane down during a rollback", () => {
	for (const mode of ["off", "enforce"] as const) {
		test(`(event idempotency ${mode}) the marks stand, the deletes stay pending, recall never serves a forgotten entry, and the re-run completes`, async () => {
			await withPlaneEnv(async () => {
				const sim = new Sim();
				await sim.start({ SUBSTRATE_EVENT_IDEMPOTENCY: mode });
				try {
					const { fakes, clock } = sim;
					const P: SessionTrack = { id: "soak-plane", lastN: null, seq: 0 };
					const t0 = clock.now();
					const c1 = sim.takeCheckpoint(P);
					expect((await sim.call("session_checkpoint", c1.request)).json).toMatchObject({ ok: true, stored: true });
					// Written first, so they are the documents a recall returns (a bank answers at most four per recall).
					const forgettable = sim.writeEntries(P.id, 120, t0);
					sim.writeEntries(P.id, 8, t0, { direction: -1 });
					sim.writeEntries(P.id, 6, t0 + 200_000, { hermesEvery: 1 });
					const textOf = (id: string): string => fakes.index.entries.find((e) => e.id === id)?.text ?? "";
					const forgettableTexts = new Set(forgettable.map(textOf));
					clock.set(t0 + 2 * HOUR_MS);

					const recall = () => sim.running.substrate.recallMemories({ query: "soak" }, "claude-code");
					const primed = await recall();
					expect(primed.results.length).toBeGreaterThan(0);
					for (const hit of primed.results) expect(forgettableTexts.has(hit.text)).toBe(true);
					expect((await recall()).results).toEqual(primed.results);
					const bumpsBefore = fakes.redis.bumps();

					// The plane goes down; the rollback runs anyway.
					fakes.faults.planeDown = true;
					const untilMs = clock.now();
					const planned = await sim.plan(P, c1.n, 1, untilMs);
					expect(planned.plan.memory.would_forget).toBe(120);
					const body = await sim.preRestoreAndCommitBody(P, c1.n, 1, planned, untilMs);
					const first = (await sim.call("session_rollback_commit", body)).json;
					expect(first).toMatchObject({ ok: true, memory: { superseded_entries: 120, forgotten_documents: 0, plane_pending: true, truncated: false } });
					expect(fakes.index.forgotten()).toHaveLength(120);
					expect(planeDocuments(fakes.plane, "sub-claude-code")).toHaveLength(128);
					expect(planeDeletes(fakes.plane)).toEqual([]);
					const bumpsAfterMarks = fakes.redis.bumps();
					expect(bumpsAfterMarks.memory).toBeGreaterThan(bumpsBefore.memory);
					expect(bumpsAfterMarks.recall).toBeGreaterThan(bumpsBefore.recall);
					// Recall during the outage serves nothing from the stale cache: the generations moved with the marks.
					const during = await recall();
					expect(during.results).toEqual([]);
					expect(during.degraded).toBe(true);

					// The plane recovers; the same commit is the retry. The half-open breaker admits one probe at a time, so a re-run may leave some
					// deletions pending: each re-run retries only those, and the run converges.
					clock.advance(10 * MINUTE);
					fakes.faults.planeDown = false;
					let second = (await sim.call("session_rollback_commit", body)).json;
					let reruns = 0;
					while ((second["memory"] as { plane_pending: boolean }).plane_pending && reruns < 4) {
						reruns++;
						second = (await sim.call("session_rollback_commit", body)).json;
					}
					expect(second).toMatchObject({ ok: true, replayed: true, event_id: first["event_id"], memory: { plane_pending: false } });
					expect(reruns).toBeLessThanOrEqual(3);
					expect(new Set(planeDeletes(fakes.plane)).size).toBe(120);
					expect(planeDocuments(fakes.plane, "sub-claude-code")).toEqual(fakes.index.entries.filter((e) => e.writer === "claude-code" && e.superseded_by === undefined).map((e) => e.idempotency_key as string));
					expect(planeDocuments(fakes.plane, "sub-hermes")).toHaveLength(6);
					const bumpsAfterRetry = fakes.redis.bumps();
					expect(bumpsAfterRetry.memory).toBeGreaterThan(bumpsAfterMarks.memory);
					expect(bumpsAfterRetry.recall).toBeGreaterThan(bumpsAfterMarks.recall);
					const after = await recall();
					expect(after.results.length).toBeGreaterThan(0);
					for (const hit of after.results) expect(forgettableTexts.has(hit.text)).toBe(false);

					// A further run changes nothing that matters: the index, the plane, the generations. Under `off` the plane's request log is checked too; under `enforce` a retry of a deduplicated note may repeat a delete that finds nothing, which changes no state.
					const stateNow = () => ({
						forgotten: fakes.index.forgotten().length,
						docs: planeDocuments(fakes.plane, "sub-claude-code").length,
						bumps: fakes.redis.bumps(),
						marks: fakes.index.marks.length,
						...(mode === "off" ? { deletes: planeDeletes(fakes.plane).length } : {}),
					});
					const settled = stateNow();
					const third = (await sim.call("session_rollback_commit", body)).json;
					expect(third).toMatchObject({ ok: true, replayed: true, event_id: first["event_id"], memory: { plane_pending: false } });
					expect(stateNow()).toEqual(settled);
					expect(fakes.ledger.byAction("session.rollback")).toHaveLength(1);
					expect(sim.tracker.outstanding()).toEqual([]);
				} finally {
					await sim.stop();
				}
			});
		});
	}
});

describe("the memory index down during a rollback", () => {
	test("answers typed retryable errors with no partial mark; a drop mid-forget leaves whole batches; a re-plan completes it once", async () => {
		await withPlaneEnv(async () => {
			const sim = new Sim();
			await sim.start();
			try {
				const { fakes, clock } = sim;
				const S: SessionTrack = { id: "soak-index", lastN: null, seq: 0 };
				const t0 = clock.now();
				const c1 = sim.takeCheckpoint(S);
				expect((await sim.call("session_checkpoint", c1.request)).json).toMatchObject({ ok: true, stored: true });
				sim.writeEntries(S.id, 230, t0);
				sim.writeEntries(S.id, 20, t0, { direction: -1 });
				clock.set(t0 + 3 * HOUR_MS);
				const untilMs = clock.now();
				const expected = sim.expectedForget(S.id, t0, untilMs);
				expect(expected).toHaveLength(230);

				// 1. Down: every tool that needs the index says so, retryable, and nothing is marked or deleted or recorded.
				fakes.index.down = "the memory index is unreachable (simulated outage)";
				expect((await sim.call("session_rollback_plan", { session_id: S.id, target_ckpt_id: ckptId(c1.n), rollback_id: rbId(1), until_ms: untilMs })).json).toMatchObject({ ok: false, error: { code: "unavailable", retryable: true } });
				expect((await sim.call("session_rollback_commit", sim.commitBody(S, c1.n, 1, "a".repeat(64), c1.n, 98, untilMs))).json).toMatchObject({ ok: false, error: { code: "unavailable", retryable: true } });
				const raw = await sim.running.mcp.client.callTool({ name: "memory_verify", arguments: { id: expected[0] } });
				expect(raw.isError).toBe(true);
				expect(fakes.index.marks).toHaveLength(0);
				expect(planeDeletes(fakes.plane)).toEqual([]);
				expect(fakes.ledger.byAction("memory.forget")).toHaveLength(0);
				expect(fakes.ledger.byAction("session.rollback")).toHaveLength(0);

				// 2. Back, but the connection drops after two batches of the forget.
				fakes.index.down = null;
				const plan1 = await sim.plan(S, c1.n, 1, untilMs);
				expect(plan1.plan.memory.would_forget).toBe(230);
				const body = await sim.preRestoreAndCommitBody(S, c1.n, 1, plan1, untilMs);
				fakes.index.markFailsAfter = fakes.index.marks.length + 2;
				const partial = (await sim.call("session_rollback_commit", body)).json;
				expect(partial).toMatchObject({ ok: false, error: { code: "forget-incomplete", retryable: true, done: { superseded_entries: 100, forgotten_documents: 100, plane_pending: false } } });
				const firstTwoBatches = expected.slice(0, 2 * FORGET_BATCH_SIZE);
				expect([...fakes.index.forgotten()].sort()).toEqual([...firstTwoBatches].sort());
				expect(fakes.ledger.byAction("memory.forget")).toHaveLength(2);
				expect(fakes.ledger.byAction("session.rollback")).toHaveLength(0);
				expect(planeDeletes(fakes.plane)).toHaveLength(100);

				// 3. Healthy again: the old plan is stale and changes nothing; a new plan completes the forget once.
				fakes.index.markFailsAfter = null;
				const marksBefore = fakes.index.marks.length;
				expect((await sim.call("session_rollback_commit", body)).json).toMatchObject({ ok: false, error: { code: "stale-plan" } });
				expect(fakes.index.marks).toHaveLength(marksBefore);
				const plan2 = await sim.plan(S, c1.n, 1, untilMs);
				expect(plan2.plan.memory.would_forget).toBe(130);
				expect(plan2.plan.plan_digest).not.toBe(plan1.plan.plan_digest);
				const finished = (await sim.call("session_rollback_commit", { ...body, plan_digest: plan2.plan.plan_digest })).json;
				expect(finished).toMatchObject({ ok: true, memory: { superseded_entries: 230, forgotten_documents: 230, plane_pending: false, truncated: false } });
				expect([...fakes.index.forgotten()].sort()).toEqual([...expected].sort());
				expect(planeDeletes(fakes.plane)).toHaveLength(230);
				expect(fakes.ledger.byAction("memory.forget").filter((event) => event.payload["rollback_id"] === rbId(1))).toHaveLength(5);
				expect(fakes.ledger.byAction("session.rollback")).toHaveLength(1);
				expect(fakes.index.marks.every((mark) => mark.ids.length <= FORGET_BATCH_SIZE)).toBe(true);
				// Every entry was marked exactly once across the three runs.
				expect(fakes.index.marks.flatMap((mark) => mark.ids).sort()).toEqual([...expected].sort());
			} finally {
				await sim.stop();
			}
		});
	});
});

/** The one world behind the late-record guard and its fail-before twin. */
async function lateRecordScenario(honourTakenAt: boolean): Promise<{ forgotten: string[]; before: string[]; during: string[]; after: string[] }> {
	return withPlaneEnv(async () => {
		const sim = new Sim();
		await sim.start();
		try {
			const { fakes, clock } = sim;
			const L: SessionTrack = { id: "soak-late", lastN: null, seq: 0 };
			const t0 = clock.now();
			const c1 = sim.takeCheckpoint(L);
			expect((await sim.call("session_checkpoint", c1.request)).json).toMatchObject({ ok: true, stored: true });
			const before = sim.writeEntries(L.id, 3, t0 + MINUTE);
			clock.set(t0 + 10 * MINUTE);
			fakes.ledger.setDown(true);
			clock.set(t0 + 20 * MINUTE);
			// Taken now, the ledger is down: the client journals it.
			const late = sim.takeCheckpoint(L);
			expect((await sim.call("session_checkpoint", late.request)).json).toMatchObject({ ok: false, error: { code: "ledger-down", retryable: true } });
			const during = sim.writeEntries(L.id, 4, t0 + 21 * MINUTE);
			clock.set(t0 + 60 * MINUTE);
			fakes.ledger.setDown(false);
			const { taken_at_ms: _dropped, ...withoutTakenAt } = late.request;
			expect((await sim.call("session_checkpoint", honourTakenAt ? late.request : withoutTakenAt)).json).toMatchObject({ ok: true, stored: true });
			const after = sim.writeEntries(L.id, 2, t0 + 61 * MINUTE);
			clock.set(t0 + 65 * MINUTE);
			const untilMs = clock.now();
			const planned = await sim.plan(L, late.n, 1, untilMs);
			const body = await sim.preRestoreAndCommitBody(L, late.n, 1, planned, untilMs);
			expect((await sim.call("session_rollback_commit", body)).json).toMatchObject({ ok: true });
			return { forgotten: [...fakes.index.forgotten()], before, during, after };
		} finally {
			await sim.stop();
		}
	});
}

describe("a checkpoint recorded late", () => {
	test("cuts memory at the time it was taken: what was written during the outage is forgotten with what came after", async () => {
		const world = await lateRecordScenario(true);
		expect(new Set(world.forgotten)).toEqual(new Set([...world.during, ...world.after]));
		for (const kept of world.before) expect(world.forgotten).not.toContain(kept);
	});
});

describe("a parked event lands before a later checkpoint reads the chain", () => {
	test("the later checkpoint names the parked event it settled as its chain head", async () => {
		await withPlaneEnv(async () => {
			const sim = new Sim();
			await sim.start(bufferEnv());
			try {
				const track: SessionTrack = { id: "soak-settle", lastN: null, seq: 0 };
				const first = sim.takeCheckpoint(track);
				expect((await sim.call("session_checkpoint", first.request)).json).toMatchObject({ ok: true, stored: true });
				// Down for one event write: the outage refuses the write, so the event is parked in the buffer, not stored.
				sim.fakes.ledger.setDown(true);
				const parked = await sim.running.substrate.emit({ surface: "omp", kind: "note", summary: "parked during the outage", session_id: track.id });
				expect(parked).toMatchObject({ stored: false, buffered: true });
				sim.fakes.ledger.setDown(false);
				// The checkpoint settles the parked event before it reads the chain, so its chain head is that event.
				const later = sim.takeCheckpoint(track);
				expect((await sim.call("session_checkpoint", later.request)).json).toMatchObject({ ok: true, stored: true });
				const landed = sim.fakes.ledger.events.find((event) => event.id === parked.event.id);
				const written = sim.fakes.ledger.events.find((event) => event.session_id === track.id && event.payload["ckpt_id"] === ckptId(later.n));
				expect(landed).toBeDefined();
				expect(written?.payload["chain_head"]).toEqual({ event_id: landed?.id, hash: landed?.hash });
			} finally {
				await sim.stop();
			}
		});
	});
});

describe("a service stopped while an event is parked", () => {
	test("leaves no drain tick behind: the shutdown abandons the event tick", async () => {
		await withPlaneEnv(async () => {
			const sim = new Sim();
			await sim.start(bufferEnv());
			try {
				sim.fakes.ledger.setDown(true);
				const parked = await sim.running.substrate.emit({ surface: "omp", kind: "note", summary: "parked at shutdown", session_id: "soak-stop" });
				expect(parked).toMatchObject({ stored: false, buffered: true });
				// The parked event armed the drain tick; stop() fails the test if the shutdown leaves any timer behind.
				expect(sim.tracker.outstanding().map((timer) => timer.kind)).toContain("interval");
			} finally {
				await sim.stop();
			}
		});
	});
});

// ---------------------------------------------------------------------------
// The structures with their own bound, soaked directly
// ---------------------------------------------------------------------------

describe("the retain outbox over 72 hours", () => {
	test("a plane outage fills it only to its bound, every parked retain is accounted for, and recovery empties it", async () => {
		const rand = seeded(5);
		let nowMs = T0;
		let planeUp = true;
		// 100, not the production default of 200: an entry exhausts its ten attempts after about 190 minutes of outage, so a larger bound
		// is never reached and the queue-full drop path would go unexercised. At 100 both the full and the exhausted paths run.
		const MAX = 100;
		const dropped: Record<RetainDropCause, number> = { "outbox-full": 0, exhausted: 0, abandoned: 0 };
		let replayed = 0;
		const outbox = new RetainOutbox({
			max: MAX,
			maxAttempts: 10,
			now: () => nowMs,
			random: rand,
			onDrop: (_entry, cause) => {
				dropped[cause]++;
			},
		});
		const deliver = async (_entry: RetainOutboxEntry): Promise<RetainDeliveryOutcome> => {
			if (!planeUp) return { transient: "retain-network" };
			replayed++;
			return "delivered";
		};
		let enqueued = 0;
		let peak = 0;
		for (let minute = 0; minute < 72 * 60; minute++) {
			nowMs = T0 + minute * MINUTE;
			// Two outages: hours 6 to 12 and hours 40 to 44.
			planeUp = !((minute >= 360 && minute < 720) || (minute >= 2_400 && minute < 2_640));
			// One live retain a minute: it lands, or parks.
			if (!planeUp) {
				outbox.enqueue({ bank: "sub-claude-code", document_id: `doc-${minute}`, entry_id: `mem_${minute}`, surface: "claude-code", entry_hash: "h".repeat(64), reason: "retain-network" });
				enqueued++;
			}
			// A plane that answers again replays everything at once (the recovery path); otherwise only what is due.
			await outbox.drain(deliver, { all: planeUp });
			peak = Math.max(peak, outbox.size());
			expect(outbox.size()).toBeLessThanOrEqual(MAX);
			expect(enqueued).toBe(replayed + dropped["outbox-full"] + dropped.exhausted + dropped.abandoned + outbox.size());
			if (planeUp) expect(outbox.size()).toBe(0);
		}
		expect(peak).toBe(MAX);
		expect(dropped["outbox-full"]).toBeGreaterThan(0);
		expect(outbox.stats()).toMatchObject({ size: 0, oldestAt: null });
		expect(replayed).toBeGreaterThan(0);
	});

	test("a durable outbox survives a restart with nothing lost or doubled", async () => {
		const path = join(tempDir(), "retain-outbox.jsonl");
		const nowMs = T0;
		const first = new RetainOutbox({ path, max: 50, now: () => nowMs, random: seeded(9) });
		for (let i = 0; i < 5; i++) first.enqueue({ bank: "sub-claude-code", document_id: `doc-${i}`, entry_id: `mem_${i}`, surface: "claude-code", entry_hash: "h".repeat(64), reason: "retain-timeout" });
		const second = new RetainOutbox({ path, max: 50, now: () => nowMs, random: seeded(9) });
		expect(second.list().map((entry) => entry.document_id)).toEqual(first.list().map((entry) => entry.document_id));
		expect(second.list()).toHaveLength(5);
		const sent: string[] = [];
		await second.drain(async (entry) => {
			sent.push(entry.document_id);
			return "delivered";
		}, { all: true });
		expect(sent.sort()).toEqual(["doc-0", "doc-1", "doc-2", "doc-3", "doc-4"]);
		expect(second.size()).toBe(0);
		// The next restart finds it empty: nothing is delivered twice.
		expect(new RetainOutbox({ path, max: 50, now: () => nowMs, random: seeded(9) }).size()).toBe(0);
	});
});

describe("the RAG state machine over 72 hours", () => {
	test("its idempotency map stays at its cap, replays answer from it, and the breaker cycles every hour", async () => {
		const clock = new SoakClock();
		const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			const machine = new RagStateMachine();
			const settings = DEFAULT_RAG_MACHINE_SETTINGS;
			let key = 0;
			for (let hour = 0; hour < 72; hour++) {
				for (let minute = 0; minute < 55; minute++) {
					clock.advance(MINUTE);
					const steer = machine.transition("STEERING", "soak", `op-${key++}`);
					expect(steer.state).toBe("STEERING");
					const refresh = machine.transition("CONTEXT_REFRESH", "soak", `op-${key++}`);
					expect(refresh.state).toBe("CONTEXT_REFRESH");
					expect(machine.recordSuccess("soak:served").state).toBe("IDLE");
				}
				// An answer already given is given again, and the machine does not move.
				const settled = machine.snapshot();
				expect(machine.transition("STEERING", "replayed", `op-${key - 1}`).state).toBe("CONTEXT_REFRESH");
				expect(machine.snapshot()).toEqual(settled);
				// An incident: three failures trip the breaker; it refuses while cooling, admits one probe, and a good probe closes it.
				machine.transition("STEERING", "soak:incident", `op-${key++}`);
				machine.transition("CONTEXT_REFRESH", "soak:incident", `op-${key++}`);
				for (let failure = 0; failure < 3; failure++) machine.recordFailure(settings, "plane down");
				expect(machine.snapshot().state).toBe("ERROR");
				expect(machine.admitQuery(settings.halfOpenMs)).toBe("refuse");
				clock.advance(settings.halfOpenMs + 1_000);
				expect(machine.admitQuery(settings.halfOpenMs)).toBe("probe");
				expect(machine.admitQuery(settings.halfOpenMs)).toBe("refuse");
				machine.transition("STEERING", "soak:probe");
				machine.transition("CONTEXT_REFRESH", "soak:probe");
				machine.recordSuccess("soak:probe", { probe: true });
				machine.settleProbe();
				expect(machine.snapshot().state).toBe("IDLE");
				expect(machine.admitQuery(settings.halfOpenMs)).toBe("serve");
				clock.advance(4 * MINUTE);
				expect(privateSize(machine, "seen")).toBeLessThanOrEqual(200);
			}
			expect(privateSize(machine, "seen")).toBe(200);
			// No transition of the soak was refused as illegal.
			const refused = stderr.mock.calls.filter((call) => String(call[0]).includes("illegal-transition-refused"));
			expect(refused).toEqual([]);
		} finally {
			stderr.mockRestore();
			clock.restore();
		}
	});
});

// ---------------------------------------------------------------------------
// Fail-before: each check mutates a fake or a cap and asserts the run would have noticed
// ---------------------------------------------------------------------------

describe("the soak notices what it is built to notice", () => {
	test("a queue that never drains, a cap that is one too low and a leaked timer are all reported", async () => {
		await withPlaneEnv(async () => {
			const sim = new Sim();
			await sim.start();
			try {
				const clean = measure(sim.running, sim.fakes, null, sim.tracker);
				expect(violations(clean)).toEqual([]);
				// A leaked per-session append queue (what a regression that forgot to release a turn would leave).
				const chains = privateMap<string, Promise<void>>(sim.running.substrate, "emitChains");
				chains.set("leak", Promise.resolve());
				const leaked = measure(sim.running, sim.fakes, null, sim.tracker);
				expect(leaked.emitChains).toBe(1);
				expect(violations(leaked)).toEqual(["emitChains: 1 > cap 0"]);
				chains.delete("leak");
				expect(violations(measure(sim.running, sim.fakes, null, sim.tracker))).toEqual([]);
				// A cap lowered below what a healthy run measures trips; at the measurement it passes.
				expect(violations({ ...clean, redisKeys: CAPS.redisKeys + 1 })).toEqual([`redisKeys: ${CAPS.redisKeys + 1} > cap ${CAPS.redisKeys}`]);
				expect(violations({ ...clean, journalItems: CAPS.journalItems })).toEqual([]);
				expect(violations({ ...clean, journalItems: CAPS.journalItems + 1 })).toHaveLength(1);
			} finally {
				await sim.stop();
			}
		});
	});

	test("the handle tracker sees a timer a production-style caller leaves behind, and forgets it once cleared", () => {
		const tracker = new HandleTracker();
		tracker.install();
		try {
			// Real timers are the thing under test here: each is far in the future and cleared before the test ends, so none fires and nothing waits.
			const interval = setInterval(() => {}, 1_000_000);
			const timeout = setTimeout(() => {}, 1_000_000);
			expect(tracker.outstanding({ includeTests: true }).map((timer) => timer.kind).sort()).toEqual(["interval", "timeout"]);
			// This file is a test, so production code's view of the same timers is empty: the filter is what keeps the SDK's and the fakes' timers out.
			expect(tracker.outstanding()).toEqual([]);
			clearInterval(interval);
			clearTimeout(timeout);
			expect(tracker.outstanding({ includeTests: true })).toEqual([]);
		} finally {
			tracker.uninstall();
		}
	});

	test("a server that ignored taken_at_ms would keep the memory written between taking and recording", async () => {
		const honoured = await lateRecordScenario(true);
		const ignored = await lateRecordScenario(false);
		expect(new Set(ignored.forgotten)).toEqual(new Set(ignored.after));
		for (const kept of ignored.during) expect(ignored.forgotten).not.toContain(kept);
		// The two worlds differ exactly where the late-record guard acts.
		expect(honoured.forgotten.length).toBe(ignored.forgotten.length + honoured.during.length);
		expect(honoured.during).toEqual(ignored.during);
	});
});
