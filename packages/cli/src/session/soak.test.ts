/**
 * The CLI half of the multi-day soak (v1.6 phase 62, criterion 1): a simulated 72 hours of `substrate session` work on a REAL
 * temporary git repository, against the in-memory server of `testkit.ts`.
 *
 * 44 real checkpoints (`createCheckpoint`) with real file changes between them; a server outage of three hours and twenty minutes in
 * the middle (the checkpoints taken meanwhile are journalled, bounded, and delivered exactly once on recovery, carrying the time they
 * were taken); three "process restarts" (a new id source, nothing remembered but the repository and the journal) after each of which the
 * registry, the journal and the server agree and an offered-again checkpoint is the same checkpoint; real rollbacks with tree equality; a
 * commit that cannot be delivered and is synced later; and restores that die mid-way (before the first file, and in the middle) and are
 * completed on the next run, never left partial.
 *
 * Time is an injected clock, no timer is used by the code under test (a tracker proves none is left), and the only randomness is seeded.
 * The server side of the same run, against the real service, is `packages/mcp-server/src/soak-multiday.test.ts`.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CAPS, HandleTracker, MINUTE, T0, journalStats, mutateWorktree, seedWorktree, seeded } from "../../../mcp-server/src/soak.testkit.ts";
import { SimulatedCrash, snapshot } from "../../../worktree-snapshot/src/index.ts";
import { cleanupTemp, makeRepo, tempDir } from "../../../worktree-snapshot/src/testkit.ts";
import { createCheckpoint, listLocalCheckpoints } from "./checkpoint.ts";
import type { ClientResult, RecordCheckpointOk, RecordCheckpointRequest } from "./client.ts";
import { EXIT_DONE, type SessionDeps, runSession } from "./command.ts";
import { listPending, replayPending } from "./pending.ts";
import { type RollbackParams, type RollbackResult, rollback } from "./rollback.ts";
import { FakeServer, FakeTranscript, fetchFor, seededRandomBytes } from "./testkit.ts";

afterAll(cleanupTemp);
setDefaultTimeout(300_000);

const SESSION = "soak-cli-only";
/** 44 steps of 100 minutes: 73 hours. */
const STEP = 100 * MINUTE;
const STEPS = 44;
/** The server is down from step 18 (30 hours in) to step 20 (33 hours 20 minutes): steps 18 and 19 are taken while it is. */
const OUTAGE_FROM_STEP = 18;
const OUTAGE_TO_STEP = 20;
const RESTART_STEPS: readonly number[] = [10, 19, 35];

/** A hook that kills the restore before operation `index`, the way a dead process would. */
const crashAt = (index: number) => ({
	beforeOp: (at: number): void => {
		if (at === index) throw new SimulatedCrash(`the process died before operation ${index}`);
	},
});

describe("a multi-day session on a real git worktree", () => {
	test("keeps its journal bounded, delivers exactly once after an outage, and resumes cleanly after restarts and crashes", async () => {
		const tracker = new HandleTracker();
		tracker.install();
		try {
			await runCliSoak(tracker);
		} finally {
			tracker.uninstall();
		}
	});
});

async function runCliSoak(tracker: HandleTracker): Promise<void> {
	const server = new FakeServer();
	let nowMs = T0;
	const clock = (): Date => new Date(nowMs);
	const dir = makeRepo();
	seedWorktree(dir);
	const pendingDir = join(tempDir(), "pending");
	const restoreJournal = join(dir, ".git", "substrate-restore", "restore-journal.json");
	const restoreLock = join(dir, ".git", "substrate-restore.lock");
	const rand = seeded(31);
	let generation = 1;
	let randomBytes = seededRandomBytes(generation);

	const params = () => ({ worktree: dir, sessionId: SESSION, surface: "claude-code", client: server, now: clock, randomBytes, pendingDir });
	const checkpoint = () => createCheckpoint({ ...params(), trigger: "turn" });
	const rollbackTo = (target: string, extra: Partial<RollbackParams> = {}): Promise<RollbackResult> =>
		rollback({ ...params(), target, dryRun: false, force: false, offline: false, transcript: new FakeTranscript(), ...extra });
	const pendingItems = () => (existsSync(pendingDir) ? listPending(pendingDir).items : []);
	const registry = async () => (await listLocalCheckpoints({ worktree: dir })).checkpoints.filter((c) => c.session_id === SESSION);
	const treeNow = async (): Promise<string> => (await snapshot({ worktree: dir, now: clock })).tree;
	const treeOfCheckpoint = async (ckptId: string): Promise<string> => {
		const found = (await registry()).find((c) => c.ckpt_id === ckptId);
		expect(found).toBeDefined();
		return found?.tree as string;
	};
	const sessionDeps = (): SessionDeps => ({
		worktree: dir,
		url: "http://substrate.test",
		tokenFor: () => "tok-soak",
		timeoutMs: 5_000,
		now: clock,
		randomBytes,
		transcript: new FakeTranscript(),
		out: () => {},
		err: () => {},
		fetch: fetchFor(server),
		signalFor: () => new AbortController().signal,
		pendingDir,
		home: "/home/soak",
	});

	/** The registry, the journal and the server agree; every bounded structure is under its cap; no timer is left. */
	async function expectConsistent(label: string): Promise<void> {
		const listing = await listLocalCheckpoints({ worktree: dir });
		expect({ label, invalid: listing.invalid }).toEqual({ label, invalid: [] });
		const mine = listing.checkpoints.filter((c) => c.session_id === SESSION).map((c) => c.ckpt_id);
		const held = [...server.checkpoints.keys()];
		const queued = pendingItems().filter((item) => item.kind === "checkpoint").map((item) => item.id);
		// Exactly once: the server was given each checkpoint it holds once, and the registry is what the server holds plus what the journal still owes it.
		expect({ label, deliveries: server.deliveries.checkpoint }).toEqual({ label, deliveries: held.length });
		expect({ label, ids: [...held, ...queued].sort() }).toEqual({ label, ids: [...mine].sort() });
		const journal = journalStats(pendingDir);
		expect({ label, items: journal.items <= CAPS.journalItems, bytes: journal.bytes <= CAPS.journalBytes, temps: journal.temps }).toEqual({ label, items: true, bytes: true, temps: 0 });
		expect({ label, timers: tracker.outstanding() }).toEqual({ label, timers: [] });
	}

	/** A new process: a new id source, and nothing carried over but the repository, the journal and the server. */
	async function restart(label: string): Promise<void> {
		const before = { local: (await registry()).map((c) => c.ckpt_id), queued: pendingItems().map((item) => item.id).sort(), held: server.checkpoints.size, deliveries: { ...server.deliveries } };
		generation++;
		randomBytes = seededRandomBytes(generation);
		const all = await registry();
		const newest = all[all.length - 1];
		expect(newest).toBeDefined();
		// The newest checkpoint asked for again by its seq is that checkpoint, offered to the server again, not a second one.
		const again = await createCheckpoint({ ...params(), trigger: "turn", seq: newest?.seq as number });
		expect({ label, created: again.created, ckpt_id: again.checkpoint.ckpt_id }).toEqual({ label, created: false, ckpt_id: newest?.ckpt_id as string });
		if (server.down) expect(again.server).toMatchObject({ status: "pending", code: "network" });
		else expect(again.server).toMatchObject({ status: "recorded", stored: false });
		const after = { local: (await registry()).map((c) => c.ckpt_id), queued: pendingItems().map((item) => item.id).sort(), held: server.checkpoints.size, deliveries: { ...server.deliveries } };
		expect({ label, ...after }).toEqual({ label, ...before });
		await expectConsistent(label);
	}

	/** The server is back: every journalled checkpoint is delivered once, with the time it was taken, and a second sync finds nothing. */
	async function recover(): Promise<void> {
		const queued = pendingItems();
		expect(queued).toHaveLength(2);
		const held = server.checkpoints.size;
		const synced = await replayPending({ dir: pendingDir, clientFor: () => server });
		expect(synced).toMatchObject({ failed: [], remaining: 0, skipped: 0, corrupt: [] });
		expect(synced.delivered.map((item) => item.id).sort()).toEqual(queued.map((item) => item.id).sort());
		expect(server.checkpoints.size).toBe(held + 2);
		for (const item of queued) {
			if (item.kind !== "checkpoint") continue;
			expect(server.checkpoints.get(item.id)?.taken_at_ms).toBe(item.record.taken_at_ms);
		}
		expect(await replayPending({ dir: pendingDir, clientFor: () => server })).toMatchObject({ delivered: [], remaining: 0 });
		expect(server.checkpoints.size).toBe(held + 2);
		await expectConsistent("after the outage");
	}

	// -- the 73 hours ------------------------------------------------------------------------------------------------
	const byStep = new Map<number, string>();
	for (let step = 0; step < STEPS; step++) {
		nowMs = T0 + step * STEP;
		if (step === OUTAGE_FROM_STEP) server.down = true;
		if (step === OUTAGE_TO_STEP) {
			server.down = false;
			await recover();
		}
		if (RESTART_STEPS.includes(step)) await restart(`restart at step ${step}`);
		mutateWorktree(dir, rand, step);
		const result = await checkpoint();
		expect(result.created).toBe(true);
		if (server.down) expect(result.server).toMatchObject({ status: "pending", code: "network" });
		else expect(result.server).toMatchObject({ status: "recorded", stored: true });
		byStep.set(step, result.checkpoint.ckpt_id);
		await expectConsistent(`step ${step}`);
	}
	expect(byStep.size).toBeGreaterThanOrEqual(40);
	expect(server.deliveries.checkpoint).toBe(STEPS);
	expect(pendingItems()).toEqual([]);

	// -- a real rollback, with tree equality, and the same rollback again --------------------------------------------
	nowMs = T0 + STEPS * STEP;
	const target30 = byStep.get(30) as string;
	const tree30 = await treeOfCheckpoint(target30);
	const first = await rollbackTo(target30);
	expect({ status: first.status, mode: first.mode, refusal: first.refusal }).toEqual({ status: "committed", mode: "server", refusal: undefined });
	expect(first.restore?.operations_total).toBeGreaterThan(0);
	expect(first.pre_restore?.server).toBe("recorded");
	expect(await treeNow()).toBe(tree30);
	expect(server.commits.size).toBe(1);
	expect(server.deliveries.commit).toBe(1);
	await expectConsistent("after the first rollback");
	const second = await rollbackTo(target30);
	expect(second.status).toBe("committed");
	expect(second.restore?.operations_total).toBe(0);
	expect(await treeNow()).toBe(tree30);
	expect(server.deliveries.commit).toBe(2);

	// -- a commit the server cannot take: files restored, commit journalled, delivered once by a later sync -------------
	nowMs += STEP;
	mutateWorktree(dir, rand, STEPS);
	byStep.set(STEPS, (await checkpoint()).checkpoint.ckpt_id);
	const target40 = byStep.get(40) as string;
	server.downForCommits = true;
	const undelivered = await rollbackTo(target40);
	expect({ status: undelivered.status, ledger: undelivered.ledger.state }).toEqual({ status: "commit-pending", ledger: "pending" });
	expect(await treeNow()).toBe(await treeOfCheckpoint(target40));
	expect(pendingItems().filter((item) => item.kind === "rollback")).toHaveLength(1);
	expect(server.deliveries.commit).toBe(2);
	server.downForCommits = false;
	const synced = await replayPending({ dir: pendingDir, clientFor: () => server });
	expect(synced).toMatchObject({ failed: [], remaining: 0 });
	expect(synced.delivered.map((item) => item.kind)).toEqual(["rollback"]);
	expect(server.deliveries.commit).toBe(3);
	expect(await replayPending({ dir: pendingDir, clientFor: () => server })).toMatchObject({ delivered: [], remaining: 0 });
	expect(server.deliveries.commit).toBe(3);
	await expectConsistent("after the late commit");

	// -- a restore that dies in the middle: the next process completes it, never leaving it partial ---------------------
	nowMs += STEP;
	mutateWorktree(dir, rand, STEPS + 1);
	const c45 = await checkpoint();
	byStep.set(STEPS + 1, c45.checkpoint.ckpt_id);
	const target41 = byStep.get(41) as string;
	const tree41 = await treeOfCheckpoint(target41);
	await expect(rollbackTo(target41, { hooks: crashAt(1) })).rejects.toBeInstanceOf(SimulatedCrash);
	expect(existsSync(restoreJournal)).toBe(true);
	const partial = await treeNow();
	expect(partial).not.toBe(c45.checkpoint.tree);
	expect(partial).not.toBe(tree41);
	// A new process runs `substrate session recover`.
	generation++;
	randomBytes = seededRandomBytes(generation);
	expect(await runSession(["recover", "--json"], sessionDeps())).toBe(EXIT_DONE);
	expect(await treeNow()).toBe(tree41);
	expect(existsSync(restoreJournal)).toBe(false);
	expect(existsSync(restoreLock)).toBe(false);
	await expectConsistent("after recover");
	// The commit journalled before the crash is the crashed rollback's own: `recover` finished the restore, `sync` delivers it once.
	expect(pendingItems().map((item) => item.kind)).toEqual(["rollback"]);
	const beforeSync = server.deliveries.commit;
	expect(await runSession(["sync"], sessionDeps())).toBe(EXIT_DONE);
	expect(server.deliveries.commit).toBe(beforeSync + 1);
	expect(pendingItems()).toEqual([]);

	// -- a restore that dies before its first file: the worktree is exactly as it was, and the next rollback recovers and commits -------
	nowMs += STEP;
	mutateWorktree(dir, rand, STEPS + 2);
	const c46 = await checkpoint();
	byStep.set(STEPS + 2, c46.checkpoint.ckpt_id);
	const target42 = byStep.get(42) as string;
	const tree42 = await treeOfCheckpoint(target42);
	await expect(rollbackTo(target42, { hooks: crashAt(0) })).rejects.toBeInstanceOf(SimulatedCrash);
	expect(existsSync(restoreJournal)).toBe(true);
	expect(await treeNow()).toBe(c46.checkpoint.tree);
	generation++;
	randomBytes = seededRandomBytes(generation);
	const commitsBefore = server.deliveries.commit;
	const resumed = await rollbackTo(target42);
	expect(resumed.recovered).toMatchObject({ direction: "forward" });
	expect({ status: resumed.status, refusal: resumed.refusal }).toEqual({ status: "committed", refusal: undefined });
	expect(await treeNow()).toBe(tree42);
	expect(existsSync(restoreJournal)).toBe(false);
	expect(server.deliveries.commit).toBe(commitsBefore + 1);
	await expectConsistent("after the resumed rollback");
	// The rollback the first run journalled before it died was settled forward by this run's recovery and waits for `sync`, delivered once.
	expect(pendingItems().map((item) => item.kind)).toEqual(["rollback"]);
	expect(resumed.warnings.some((warning) => warning.includes("substrate session sync"))).toBe(true);
	expect(await runSession(["sync"], sessionDeps())).toBe(EXIT_DONE);
	expect(server.deliveries.commit).toBe(commitsBefore + 2);

	// -- the registry at the end ---------------------------------------------------------------------------------------
	const mine = await registry();
	expect(mine.length).toBeGreaterThanOrEqual(STEPS + 3);
	expect(mine.map((c) => c.seq)).toEqual(mine.map((_, at) => at + 1));
	expect(pendingItems()).toEqual([]);
	expect(await runSession(["checkpoints", "--session", SESSION, "--offline", "--json"], sessionDeps())).toBe(EXIT_DONE);
	expect(tracker.outstanding()).toEqual([]);
}

// ---------------------------------------------------------------------------
// Fail-before: each check mutates a fake and asserts the run would have noticed
// ---------------------------------------------------------------------------

/** A server that counts a replay as a delivery: what a regression in its idempotency would look like to the exactly-once invariant. */
class DoubleCountingServer extends FakeServer {
	override async recordCheckpoint(request: RecordCheckpointRequest): Promise<ClientResult<RecordCheckpointOk>> {
		const answer = await super.recordCheckpoint(request);
		if (answer.ok && !answer.value.stored) this.deliveries.checkpoint++;
		return answer;
	}
}

const exactlyOnce = (server: FakeServer): boolean => server.deliveries.checkpoint === server.checkpoints.size;

describe("the soak notices what it is built to notice", () => {
	const request = { session_id: SESSION, ckpt_id: `ckpt_${"0".repeat(26)}`, seq: 1, trigger: "turn", git_tree: "a".repeat(40), manifest_sha256: "b".repeat(64), file_count: 1, skipped_count: 0 } as const;

	test("the exactly-once invariant holds for the real fake and fails for one that counts a replay as a delivery", async () => {
		const sound = new FakeServer();
		await sound.recordCheckpoint(request);
		await sound.recordCheckpoint(request);
		expect(exactlyOnce(sound)).toBe(true);
		const broken = new DoubleCountingServer();
		await broken.recordCheckpoint(request);
		await broken.recordCheckpoint(request);
		expect(exactlyOnce(broken)).toBe(false);
	});

	test("the journal measurement counts a stray temporary file and the items a cap would be judged on", () => {
		const dir = tempDir();
		expect(journalStats(dir)).toEqual({ items: 0, bytes: 0, temps: 0 });
		writeFileSync(join(dir, "checkpoint-ckpt_x.json.tmp"), "{}");
		writeFileSync(join(dir, "checkpoint-ckpt_y.json"), "{}");
		expect(journalStats(dir)).toEqual({ items: 1, bytes: 2, temps: 1 });
		expect(journalStats(join(dir, "missing"))).toEqual({ items: 0, bytes: 0, temps: 0 });
	});
});
