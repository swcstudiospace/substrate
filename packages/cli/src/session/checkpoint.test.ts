/**
 * createCheckpoint and the local registry, on real temporary git repositories with a fake server.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RandomBytes } from "../../../mcp-server/src/session-events.ts";
import { type Runner, WorktreeBusyError, pinSnapshot, snapshot, spawnRunner } from "../../../worktree-snapshot/src/index.ts";
import { cleanupTemp, FIXED_NOW, git, makeRepo, tempDir, writeFiles } from "../../../worktree-snapshot/src/testkit.ts";
import { CheckpointError, type CheckpointResult, checkpointsOfSession, createCheckpoint, listLocalCheckpoints } from "./checkpoint.ts";
import { offlineClient } from "./client.ts";
import { listPending, replayPending } from "./pending.ts";
import { FakeServer, seededRandomBytes } from "./testkit.ts";

afterAll(cleanupTemp);
setDefaultTimeout(120_000);

const SESSION = "sess-1";

function setup(): { dir: string; pendingDir: string; server: FakeServer; randomBytes: RandomBytes } {
	const dir = makeRepo();
	writeFiles(dir, { "a.txt": "alpha\n" });
	return { dir, pendingDir: join(tempDir(), "pending"), server: new FakeServer(), randomBytes: seededRandomBytes(7) };
}

describe("createCheckpoint", () => {
	test("pins the worktree, numbers it, chains it to the previous one and records it on the server", async () => {
		const { dir, pendingDir, server, randomBytes } = setup();
		const base = { worktree: dir, sessionId: SESSION, surface: "claude-code", client: server, now: FIXED_NOW, randomBytes, pendingDir };
		const first = await createCheckpoint({ ...base, trigger: "turn", planRef: { phase: "61", step: "b" } });
		writeFiles(dir, { "b.txt": "beta\n" });
		const second = await createCheckpoint({ ...base, trigger: "manual", transcriptRef: { surface: "claude-code", session_locator: "abc", turn_no: 2 } });

		expect(first.created && first.checkpoint.seq).toBe(1);
		expect(second.checkpoint).toMatchObject({ seq: 2, prev_ckpt_id: first.checkpoint.ckpt_id, trigger: "manual" });
		expect(first.checkpoint.ckpt_id).toMatch(/^ckpt_[0-9a-z]{26}$/);
		expect(first.checkpoint.tree).not.toBe(second.checkpoint.tree);
		expect(first.server).toMatchObject({ status: "recorded", stored: true });
		expect(first.file_count).toBe(1);
		expect(second.file_count).toBe(2);

		const record = server.checkpoints.get(second.checkpoint.ckpt_id);
		expect(record).toMatchObject({
			session_id: SESSION,
			seq: 2,
			trigger: "manual",
			git_tree: second.checkpoint.tree,
			prev_ckpt_id: first.checkpoint.ckpt_id,
			transcript_ref: { surface: "claude-code", session_locator: "abc", turn_no: 2 },
			file_count: 2,
			skipped_count: 0,
			branch: "main",
		});
		expect(record?.manifest_sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(server.checkpoints.get(first.checkpoint.ckpt_id)?.plan_ref).toEqual({ phase: "61", step: "b" });

		// The pinned refs are the registry: everything is readable back from them alone.
		const local = await listLocalCheckpoints({ worktree: dir });
		expect(local.invalid).toEqual([]);
		expect(local.checkpoints.map((c) => [c.seq, c.trigger, c.session_id])).toEqual([
			[1, "turn", SESSION],
			[2, "manual", SESSION],
		]);
		expect(local.checkpoints[0]?.plan_ref).toEqual({ phase: "61", step: "b" });
		expect(local.checkpoints[1]?.transcript_ref).toEqual({ surface: "claude-code", session_locator: "abc", turn_no: 2 });
		expect(git(dir, ["rev-parse", local.checkpoints[0]?.ref ?? "missing"]).trim()).toBe(local.checkpoints[0]?.commit as string);
	});

	test("seq is per session: another session starts at 1 and the two never mix", async () => {
		const { dir, pendingDir, server, randomBytes } = setup();
		const base = { worktree: dir, surface: "claude-code", client: server, now: FIXED_NOW, randomBytes, pendingDir, trigger: "manual" as const };
		await createCheckpoint({ ...base, sessionId: "one" });
		await createCheckpoint({ ...base, sessionId: "one" });
		const other = await createCheckpoint({ ...base, sessionId: "two" });
		expect(other.checkpoint.seq).toBe(1);
		expect(other.checkpoint.prev_ckpt_id).toBeUndefined();
		const { checkpoints } = await listLocalCheckpoints({ worktree: dir });
		expect(checkpointsOfSession(checkpoints, "one").map((c) => c.seq)).toEqual([1, 2]);
		expect(checkpointsOfSession(checkpoints, "two").map((c) => c.seq)).toEqual([1]);
	});

	test("files the policy leaves out are reported, relative to the worktree", async () => {
		const { dir, pendingDir, server, randomBytes } = setup();
		writeFiles(dir, { "big.dat": "y".repeat(200), "ok.txt": "fine\n" });
		const result = await createCheckpoint({
			worktree: dir,
			sessionId: SESSION,
			trigger: "manual",
			surface: "claude-code",
			client: server,
			now: FIXED_NOW,
			randomBytes,
			pendingDir,
			policy: { maxFileBytes: 64 },
		});
		expect(result.skipped).toEqual([{ path: "big.dat", reason: "too-large" }]);
		expect(server.checkpoints.get(result.checkpoint.ckpt_id)?.skipped_count).toBe(1);
		expect(result.checkpoint.skipped_count).toBe(1);
	});

	test("sends the time the snapshot was pinned, from the injected clock, and keeps it in the pinned metadata", async () => {
		const { dir, pendingDir, server, randomBytes } = setup();
		const pinned = new Date("2026-03-04T05:06:07.891Z");
		const result = await createCheckpoint({ worktree: dir, sessionId: SESSION, trigger: "turn", surface: "claude-code", client: server, now: () => pinned, randomBytes, pendingDir });
		expect(server.checkpoints.get(result.checkpoint.ckpt_id)?.taken_at_ms).toBe(pinned.getTime());
		expect(result.checkpoint.taken_at_ms).toBe(pinned.getTime());
		// Read back from the ref alone: the commit time has only whole seconds, the metadata has the millisecond.
		const local = await listLocalCheckpoints({ worktree: dir });
		expect(local.checkpoints[0]?.taken_at_ms).toBe(pinned.getTime());
	});

	test("a checkpoint journaled while the server was down still reaches it with the time it was taken, hours later", async () => {
		const { dir, pendingDir, server, randomBytes } = setup();
		const pinned = new Date("2026-03-04T05:06:07.891Z");
		server.down = true;
		const result = await createCheckpoint({ worktree: dir, sessionId: SESSION, trigger: "turn", surface: "cursor", client: server, now: () => pinned, randomBytes, pendingDir });
		const queued = listPending(pendingDir).items[0];
		expect(queued?.kind === "checkpoint" && queued.record.taken_at_ms).toBe(pinned.getTime());

		server.down = false;
		await replayPending({ dir: pendingDir, clientFor: () => server });
		expect(server.checkpoints.get(result.checkpoint.ckpt_id)?.taken_at_ms).toBe(pinned.getTime());
	});

	test("offering an existing checkpoint again sends its original pin time, not the time of the offer", async () => {
		const { dir, pendingDir, server, randomBytes } = setup();
		const pinned = new Date("2026-03-04T05:06:07.891Z");
		const first = await createCheckpoint({ worktree: dir, sessionId: SESSION, trigger: "turn", surface: "claude-code", client: new FakeServer(), now: () => pinned, randomBytes, pendingDir });
		const later = new Date("2026-03-05T00:00:00.000Z");
		const again = await createCheckpoint({ worktree: dir, sessionId: SESSION, trigger: "turn", surface: "claude-code", client: server, now: () => later, randomBytes, pendingDir, seq: 1 });
		expect(again.created).toBe(false);
		expect(server.checkpoints.get(first.checkpoint.ckpt_id)?.taken_at_ms).toBe(pinned.getTime());
	});

	test("the server being down is not a checkpoint failure: the checkpoint stands and is journaled, and sync delivers it exactly once", async () => {
		const { dir, pendingDir, server, randomBytes } = setup();
		server.down = true;
		const result = await createCheckpoint({ worktree: dir, sessionId: SESSION, trigger: "turn", surface: "cursor", client: server, now: FIXED_NOW, randomBytes, pendingDir });
		expect(result.created).toBe(true);
		expect(result.server).toMatchObject({ status: "pending", code: "network" });
		expect((await listLocalCheckpoints({ worktree: dir })).checkpoints).toHaveLength(1);
		const pending = listPending(pendingDir).items;
		expect(pending).toHaveLength(1);
		expect(pending[0]).toMatchObject({ kind: "checkpoint", id: result.checkpoint.ckpt_id, session_id: SESSION, surface: "cursor", attempts: 1 });

		server.down = false;
		const outcome = await replayPending({ dir: pendingDir, clientFor: () => server });
		expect(outcome.delivered).toHaveLength(1);
		expect(server.deliveries.checkpoint).toBe(1);
		// The replay sent what the first attempt would have: the same id and seq.
		expect(server.checkpoints.get(result.checkpoint.ckpt_id)).toMatchObject({ seq: 1, trigger: "turn", git_tree: result.checkpoint.tree });
		expect(listPending(pendingDir).items).toEqual([]);
		await replayPending({ dir: pendingDir, clientFor: () => server });
		expect(server.deliveries.checkpoint).toBe(1);
	});

	test("an offline client journals the checkpoint too", async () => {
		const { dir, pendingDir, randomBytes } = setup();
		const result = await createCheckpoint({ worktree: dir, sessionId: SESSION, trigger: "manual", surface: "claude-code", client: offlineClient(), now: FIXED_NOW, randomBytes, pendingDir });
		expect(result.server).toMatchObject({ status: "pending", code: "offline" });
		expect(listPending(pendingDir).items).toHaveLength(1);
	});

	test("when the pending journal cannot take the record either, the checkpoint still stands and says so", async () => {
		const { dir, randomBytes } = setup();
		const server = new FakeServer();
		server.down = true;
		const blocked = join(tempDir(), "a-file");
		writeFileSync(blocked, "not a directory");
		const result = await createCheckpoint({
			worktree: dir,
			sessionId: SESSION,
			trigger: "manual",
			surface: "claude-code",
			client: server,
			now: FIXED_NOW,
			randomBytes,
			pendingDir: join(blocked, "pending"),
		});
		expect(result.server.status).toBe("unrecorded");
		expect((await listLocalCheckpoints({ worktree: dir })).checkpoints).toHaveLength(1);
	});

	test("asking for a seq that exists returns that checkpoint and makes no new ref (idempotent by session and seq)", async () => {
		const { dir, pendingDir, server, randomBytes } = setup();
		const base = { worktree: dir, sessionId: SESSION, trigger: "manual" as const, surface: "claude-code", client: server, now: FIXED_NOW, randomBytes, pendingDir };
		const first = await createCheckpoint({ ...base, seq: 1 });
		const again = await createCheckpoint({ ...base, seq: 1 });
		expect(again.created).toBe(false);
		expect(again.checkpoint.ckpt_id).toBe(first.checkpoint.ckpt_id);
		expect((await listLocalCheckpoints({ worktree: dir })).checkpoints).toHaveLength(1);
		// The re-offer to the server is a replay: held once.
		expect(server.deliveries.checkpoint).toBe(1);
		expect(server.checkpoints.get(first.checkpoint.ckpt_id)).toMatchObject({ seq: 1, git_tree: first.checkpoint.tree });
	});

	test("re-offering an existing checkpoint to a down server journals it again with the same ids", async () => {
		const { dir, pendingDir, server, randomBytes } = setup();
		const base = { worktree: dir, sessionId: SESSION, trigger: "manual" as const, surface: "claude-code", client: server, now: FIXED_NOW, randomBytes, pendingDir };
		server.down = true;
		const first = await createCheckpoint({ ...base, seq: 1 });
		const again = await createCheckpoint({ ...base, seq: 1 });
		expect(again.created).toBe(false);
		expect(listPending(pendingDir).items.map((item) => item.id)).toEqual([first.checkpoint.ckpt_id]);
	});

	test("a seq that skips ahead is allowed once; a later request for a gap below the highest is refused", async () => {
		const { dir, pendingDir, server, randomBytes } = setup();
		const base = { worktree: dir, sessionId: SESSION, trigger: "manual" as const, surface: "claude-code", client: server, now: FIXED_NOW, randomBytes, pendingDir };
		await createCheckpoint({ ...base, seq: 5 });
		await expect(createCheckpoint({ ...base, seq: 3 })).rejects.toMatchObject({ code: "seq-conflict" });
		const next = await createCheckpoint(base);
		expect(next.checkpoint.seq).toBe(6);
	});

	test("invalid input is refused before anything is pinned", async () => {
		const { dir, pendingDir, server, randomBytes } = setup();
		const base = { worktree: dir, sessionId: SESSION, trigger: "manual" as const, surface: "claude-code", client: server, now: FIXED_NOW, randomBytes, pendingDir };
		await expect(createCheckpoint({ ...base, sessionId: "" })).rejects.toBeInstanceOf(CheckpointError);
		await expect(createCheckpoint({ ...base, trigger: "whenever" as "manual" })).rejects.toBeInstanceOf(CheckpointError);
		// A transcript pointer must be an opaque id, never a path.
		await expect(
			createCheckpoint({ ...base, transcriptRef: { surface: "claude-code", session_locator: "/home/someone/.claude/session.jsonl", turn_no: 1 } }),
		).rejects.toMatchObject({ code: "invalid-input" });
		await expect(createCheckpoint({ ...base, seq: 0 })).rejects.toMatchObject({ code: "invalid-input" });
		expect((await listLocalCheckpoints({ worktree: dir })).checkpoints).toEqual([]);
		expect(server.calls).toEqual([]);
	});
});

describe("sequence allocation across callers sharing one git directory", () => {
	const lockPath = (dir: string): string => join(dir, ".git", "substrate-checkpoint.lock");

	test("two checkpoints started together get two distinct, contiguous seqs and two distinct pinned refs", async () => {
		const { dir, pendingDir, server, randomBytes } = setup();
		const base = { worktree: dir, sessionId: SESSION, trigger: "manual" as const, surface: "claude-code", client: server, now: FIXED_NOW, randomBytes, pendingDir, lockWait: { delayMs: 5 } };
		const results = await Promise.all([createCheckpoint(base), createCheckpoint(base)]);

		expect(results.every((result) => result.created)).toBe(true);
		const [first, second] = results.map((result) => result.checkpoint).sort((a, b) => a.seq - b.seq);
		expect([first?.seq, second?.seq]).toEqual([1, 2]);
		expect(first?.ref).not.toBe(second?.ref);
		expect(second?.prev_ckpt_id).toBe(first?.ckpt_id);
		expect(first?.prev_ckpt_id).toBeUndefined();
		const local = await listLocalCheckpoints({ worktree: dir });
		expect(local.invalid).toEqual([]);
		expect(local.checkpoints.map((c) => c.seq)).toEqual([1, 2]);
		// Two distinct ledger keys (`ckpt:s.<session>:<seq>`): neither record is deduped away.
		expect([...server.checkpoints.values()].map((record) => record.seq).sort()).toEqual([1, 2]);
		expect(existsSync(lockPath(dir))).toBe(false);
	});

	test("two processes making checkpoints at once never pin the same seq", async () => {
		const { dir } = setup();
		const script = fileURLToPath(new URL("./checkpoint-worker.ts", import.meta.url));
		const workers = [0, 1].map(() => Bun.spawn([process.execPath, script, dir, "2"], { stdout: "pipe", stderr: "pipe" }));
		const outputs = await Promise.all(workers.map(async (worker) => ({ code: await worker.exited, out: await new Response(worker.stdout).text(), err: await new Response(worker.stderr).text() })));

		for (const output of outputs) expect({ code: output.code, err: output.err }).toEqual({ code: 0, err: "" });
		const made = outputs.flatMap((output) => output.out.trim().split("\n").map((line) => JSON.parse(line) as { seq: number; ckpt_id: string; ref: string }));
		expect(made.map((entry) => entry.seq).sort()).toEqual([1, 2, 3, 4]);
		expect(new Set(made.map((entry) => entry.ref)).size).toBe(4);
		const local = checkpointsOfSession((await listLocalCheckpoints({ worktree: dir })).checkpoints, "race");
		expect(local.map((c) => c.seq)).toEqual([1, 2, 3, 4]);
		// One unbroken chain: each checkpoint follows the one before it.
		expect(local.map((c) => c.prev_ckpt_id)).toEqual([undefined, local[0]?.ckpt_id, local[1]?.ckpt_id, local[2]?.ckpt_id]);
		expect(existsSync(lockPath(dir))).toBe(false);
	});

	/** A runner that, once the snapshot is taken (the first lookup of the git directory), lets another caller make a checkpoint first. */
	function contended(onLost: () => Promise<unknown>): Runner {
		let fired = false;
		return async (argv, options) => {
			if (!fired && argv[1] === "-C" && argv.includes("--absolute-git-dir")) {
				fired = true;
				await onLost();
			}
			return spawnRunner(argv, options);
		};
	}

	test("a seq taken by someone else while this call was snapshotting is not reused: the next one is made, chained to it", async () => {
		const { dir, pendingDir, server, randomBytes } = setup();
		const base = { worktree: dir, sessionId: SESSION, trigger: "manual" as const, surface: "claude-code", client: server, now: FIXED_NOW, pendingDir };
		const rivals: CheckpointResult[] = [];
		const run = contended(async () => {
			rivals.push(await createCheckpoint({ ...base, randomBytes: seededRandomBytes(99) }));
		});
		const mine = await createCheckpoint({ ...base, randomBytes, run });

		expect(rivals[0]?.checkpoint.seq).toBe(1);
		expect(mine.created).toBe(true);
		expect(mine.checkpoint.seq).toBe(2);
		expect(mine.checkpoint.prev_ckpt_id).toBe(rivals[0]?.checkpoint.ckpt_id);
		expect(server.checkpoints.get(mine.checkpoint.ckpt_id)).toMatchObject({ seq: 2, prev_ckpt_id: rivals[0]?.checkpoint.ckpt_id });
		expect((await listLocalCheckpoints({ worktree: dir })).checkpoints.map((c) => c.seq)).toEqual([1, 2]);
	});

	test("an explicit seq that someone else made while this call was snapshotting returns their checkpoint and pins nothing", async () => {
		const { dir, pendingDir, server, randomBytes } = setup();
		const base = { worktree: dir, sessionId: SESSION, trigger: "manual" as const, surface: "claude-code", client: server, now: FIXED_NOW, pendingDir };
		const rivals: CheckpointResult[] = [];
		const run = contended(async () => {
			rivals.push(await createCheckpoint({ ...base, randomBytes: seededRandomBytes(99), seq: 1 }));
		});
		const mine = await createCheckpoint({ ...base, randomBytes, run, seq: 1 });

		const rival = rivals[0];
		if (!rival) throw new Error("the contending call never created a checkpoint");
		expect(mine.created).toBe(false);
		expect(mine.checkpoint.ckpt_id).toBe(rival.checkpoint.ckpt_id);
		expect((await listLocalCheckpoints({ worktree: dir })).checkpoints).toHaveLength(1);
		expect(existsSync(lockPath(dir))).toBe(false);
	});

	/** A lock record in the format `acquireWorktreeLock` writes. */
	function writeLock(dir: string, pid: number): void {
		writeFileSync(lockPath(dir), JSON.stringify({ pid, startedAt: "2026-01-01T00:00:00.000Z", procStart: null, host: hostname(), token: "held-by-test" }));
	}

	test("a stale checkpoint lock (its owner is gone) is broken and the checkpoint is made", async () => {
		const { dir, pendingDir, server, randomBytes } = setup();
		const gone = Bun.spawn(["true"]);
		await gone.exited;
		writeLock(dir, gone.pid);
		const result = await createCheckpoint({ worktree: dir, sessionId: SESSION, trigger: "manual", surface: "claude-code", client: server, now: FIXED_NOW, randomBytes, pendingDir });
		expect(result.checkpoint.seq).toBe(1);
		expect(existsSync(lockPath(dir))).toBe(false);
	});

	test("a checkpoint lock that stays busy fails the call with a typed error after the bounded wait, and pins nothing", async () => {
		const { dir, pendingDir, server, randomBytes } = setup();
		writeLock(dir, process.pid);
		const sleeps: number[] = [];
		const lockWait = { attempts: 3, delayMs: 7, sleep: async (ms: number): Promise<void> => void sleeps.push(ms) };
		const attempt = createCheckpoint({ worktree: dir, sessionId: SESSION, trigger: "manual", surface: "claude-code", client: server, now: FIXED_NOW, randomBytes, pendingDir, lockWait });
		await expect(attempt).rejects.toBeInstanceOf(WorktreeBusyError);
		await expect(attempt).rejects.toMatchObject({ code: "worktree-busy" });
		expect(sleeps).toEqual([7, 7]);
		expect((await listLocalCheckpoints({ worktree: dir })).checkpoints).toEqual([]);
		expect(server.calls).toEqual([]);
		// The holder's lock is untouched: a caller that did not take it never removes it.
		expect(existsSync(lockPath(dir))).toBe(true);
	});

	test("a held restore lock does not block a checkpoint (separate lock files)", async () => {
		const { dir, pendingDir, server, randomBytes } = setup();
		writeFileSync(join(dir, ".git", "substrate-restore.lock"), JSON.stringify({ pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z", procStart: null, host: hostname(), token: "restore" }));
		const result = await createCheckpoint({ worktree: dir, sessionId: SESSION, trigger: "pre-restore", surface: "claude-code", client: server, now: FIXED_NOW, randomBytes, pendingDir });
		expect(result.checkpoint.seq).toBe(1);
		expect(existsSync(join(dir, ".git", "substrate-restore.lock"))).toBe(true);
	});
});

describe("linked worktrees of one repository", () => {
	test("a fresh sibling worktree inherits nothing of the main worktree's session: no listing, seq 1, no chain", async () => {
		const { dir, pendingDir, server, randomBytes } = setup();
		const sibling = join(tempDir(), "sibling");
		git(dir, ["worktree", "add", "-q", "-b", "wt-sibling", sibling]);
		const base = { sessionId: SESSION, trigger: "manual" as const, surface: "claude-code", client: server, now: FIXED_NOW, randomBytes, pendingDir };
		const mine = await createCheckpoint({ ...base, worktree: dir });
		expect(mine.checkpoint.seq).toBe(1);

		expect((await listLocalCheckpoints({ worktree: sibling })).checkpoints).toEqual([]);
		const theirs = await createCheckpoint({ ...base, worktree: sibling });
		expect(theirs.checkpoint.seq).toBe(1);
		expect(theirs.checkpoint.prev_ckpt_id).toBeUndefined();
		// Each worktree still lists exactly its own one.
		expect((await listLocalCheckpoints({ worktree: sibling })).checkpoints.map((c) => c.ckpt_id)).toEqual([theirs.checkpoint.ckpt_id]);
		expect((await listLocalCheckpoints({ worktree: dir })).checkpoints.map((c) => c.ckpt_id)).toEqual([mine.checkpoint.ckpt_id]);
	});
});

describe("listLocalCheckpoints", () => {
	test("a checkpoint ref with no or damaged metadata is reported as invalid and not offered as a target", async () => {
		const { dir, pendingDir, server, randomBytes } = setup();
		await createCheckpoint({ worktree: dir, sessionId: SESSION, trigger: "manual", surface: "claude-code", client: server, now: FIXED_NOW, randomBytes, pendingDir });
		const snap = await snapshot({ worktree: dir, now: FIXED_NOW });
		await pinSnapshot({ worktree: dir, snapshot: snap, id: "no-metadata-0001", now: FIXED_NOW });
		await pinSnapshot({ worktree: dir, snapshot: snap, id: "bad-metadata-0001", metadata: { ckpt_id: "other", seq: 1, trigger: "manual", session_id: "s" }, now: FIXED_NOW });
		const badTrigger = `ckpt_${"z".repeat(26)}`;
		await pinSnapshot({ worktree: dir, snapshot: snap, id: badTrigger, metadata: { ckpt_id: badTrigger, seq: 1, trigger: "nope", session_id: "s" }, now: FIXED_NOW });
		const { checkpoints, invalid } = await listLocalCheckpoints({ worktree: dir });
		expect(checkpoints).toHaveLength(1);
		expect(Object.fromEntries(invalid.map((entry) => [entry.id, entry.reason]))).toEqual({
			"no-metadata-0001": "the checkpoint ref has no metadata",
			"bad-metadata-0001": "the metadata ckpt_id does not match the ref",
			[badTrigger]: "the metadata trigger is not a known trigger",
		});
	});
});
