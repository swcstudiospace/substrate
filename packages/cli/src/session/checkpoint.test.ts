/**
 * createCheckpoint and the local registry, on real temporary git repositories with a fake server.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RandomBytes } from "../../../mcp-server/src/session-events.ts";
import { pinSnapshot, snapshot } from "../../../worktree-snapshot/src/index.ts";
import { cleanupTemp, FIXED_NOW, git, makeRepo, tempDir, writeFiles } from "../../../worktree-snapshot/src/testkit.ts";
import { CheckpointError, checkpointsOfSession, createCheckpoint, listLocalCheckpoints } from "./checkpoint.ts";
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
