/**
 * The pending journal: atomic 0600 writes in a 0700 directory, strict reads that report and skip a
 * corrupt file, a bound on the count, and a replay that is harmless to repeat.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTemp, git, makeRepo, tempDir } from "../../../worktree-snapshot/src/testkit.ts";
import {
	MAX_PENDING_BYTES,
	MAX_PENDING_ITEMS,
	MAX_PLANE_RETRIES,
	PENDING_DIR_NAME,
	type PendingCheckpoint,
	type PendingItem,
	type PendingRollback,
	PendingJournalError,
	listPending,
	removePending,
	replayPending,
	resolvePendingDir,
	writePending,
} from "./pending.ts";
import { FakeServer, failure } from "./testkit.ts";

afterAll(cleanupTemp);
setDefaultTimeout(60_000);

const TREE = "a".repeat(40);
const SHA = "b".repeat(64);
const SESSION = "sess-1";

function ckptId(n: number): string {
	return `ckpt_${n.toString(36).padStart(26, "0")}`;
}

function rbId(n: number): string {
	return `rb_${n.toString(36).padStart(26, "0")}`;
}

function checkpointItem(seq: number, overrides: Partial<PendingCheckpoint> = {}): PendingCheckpoint {
	return {
		version: 1,
		kind: "checkpoint",
		id: ckptId(seq),
		session_id: SESSION,
		surface: "claude-code",
		queued_at: "2026-01-01T00:00:00.000Z",
		attempts: 1,
		record: { ckpt_id: ckptId(seq), seq, trigger: "manual", git_tree: TREE, manifest_sha256: SHA, file_count: 2, skipped_count: 0 },
		...overrides,
	};
}

function rollbackItem(n: number, digest: string | null, overrides: Partial<PendingRollback> = {}): PendingRollback {
	return {
		version: 1,
		kind: "rollback",
		id: rbId(n),
		session_id: SESSION,
		surface: "claude-code",
		queued_at: `2026-01-01T00:00:0${n}.000Z`,
		attempts: 1,
		commit: {
			target_ckpt_id: ckptId(1),
			plan_digest: digest,
			from_ckpt_id: ckptId(2),
			pre_restore_tree: TREE,
			pre_restore_ckpt_id: ckptId(3),
			files: { added: 1, modified: 2, deleted: 3 },
			transcript: "marker-only",
		},
		...overrides,
	};
}

const dirOf = (): string => join(tempDir(), "pending");

describe("writePending and listPending", () => {
	test("round-trips an item, atomically, with mode 0600 in a 0700 directory and no temp file left", () => {
		const dir = dirOf();
		const item = checkpointItem(1);
		writePending(dir, item);
		expect(listPending(dir)).toEqual({ items: [item], corrupt: [] });
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		expect(statSync(join(dir, `checkpoint-${item.id}.json`)).mode & 0o777).toBe(0o600);
		expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	test("writing the same item again replaces it (idempotent) and does not count twice", () => {
		const dir = dirOf();
		writePending(dir, checkpointItem(1));
		writePending(dir, checkpointItem(1, { attempts: 5 }));
		const { items } = listPending(dir);
		expect(items).toHaveLength(1);
		expect(items[0]?.attempts).toBe(5);
	});

	test("an item that is not valid is refused before anything is written", () => {
		const dir = dirOf();
		const bad: unknown[] = [
			{ ...checkpointItem(1), id: "not-a-ckpt-id" },
			{ ...checkpointItem(1), extra: true },
			{ ...checkpointItem(1), record: { ...checkpointItem(1).record, seq: 0 } },
			{ ...checkpointItem(1), record: { ...checkpointItem(1).record, ckpt_id: ckptId(9) } },
			{ ...checkpointItem(1), attempts: -1 },
			{ ...rollbackItem(1, "d"), id: "rb_short" },
			{ ...rollbackItem(1, "d"), commit: { ...rollbackItem(1, "d").commit, transcript: "rewrote" } },
			{ ...rollbackItem(1, "d"), commit: { ...rollbackItem(1, "d").commit, pre_restore_tree: "xyz" } },
			{ ...rollbackItem(1, "d"), commit: { ...rollbackItem(1, "d").commit, until_ms: -1 } },
			{ ...rollbackItem(1, "d"), commit: { ...rollbackItem(1, "d").commit, until_ms: "yesterday" } },
			{ ...rollbackItem(1, "d"), plane_retries: -1 },
			{ ...rollbackItem(1, "d"), plane_retries: MAX_PLANE_RETRIES + 1 },
			{ ...rollbackItem(1, "d"), plane_retries: 1, restoring: true },
			{ ...checkpointItem(1), record: { ...checkpointItem(1).record, taken_at_ms: -3 } },
		];
		for (const item of bad) {
			expect(() => writePending(dir, item as PendingItem)).toThrow(PendingJournalError);
		}
		expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
	});

	test("until_ms of a commit and taken_at_ms of a checkpoint survive the journal, and an item without them stays valid", () => {
		const dir = dirOf();
		const bounded = rollbackItem(1, null, { commit: { ...rollbackItem(1, null).commit, until_ms: 1_788_000_000_123 } });
		const taken = checkpointItem(1, { record: { ...checkpointItem(1).record, taken_at_ms: 1_788_000_000_000 } });
		writePending(dir, bounded);
		writePending(dir, taken);
		writePending(dir, rollbackItem(2, "d"));
		const { items, corrupt } = listPending(dir);
		expect(corrupt).toEqual([]);
		expect(items.find((item) => item.id === bounded.id)).toEqual(bounded);
		expect(items.find((item) => item.id === taken.id)).toEqual(taken);
		expect(items.find((item) => item.id === rbId(2))).toEqual(rollbackItem(2, "d"));
	});

	test("plane_retries of a rollback survives the journal", () => {
		const dir = dirOf();
		const kept = rollbackItem(1, "d", { plane_retries: 2 });
		writePending(dir, kept);
		expect(listPending(dir).items).toEqual([kept]);
	});

	test("checkpoints list before rollbacks, in seq order, whatever the write order", () => {
		const dir = dirOf();
		writePending(dir, rollbackItem(2, "d"));
		writePending(dir, checkpointItem(3));
		writePending(dir, rollbackItem(1, "d"));
		writePending(dir, checkpointItem(1));
		expect(listPending(dir).items.map((item) => `${item.kind}:${item.id}`)).toEqual([
			`checkpoint:${ckptId(1)}`,
			`checkpoint:${ckptId(3)}`,
			`rollback:${rbId(1)}`,
			`rollback:${rbId(2)}`,
		]);
	});

	test("a missing directory lists nothing", () => {
		expect(listPending(join(tempDir(), "never-made"))).toEqual({ items: [], corrupt: [] });
	});

	test("removePending deletes one item and is a no-op for a missing one", () => {
		const dir = dirOf();
		writePending(dir, checkpointItem(1));
		removePending(dir, "checkpoint", ckptId(1));
		removePending(dir, "checkpoint", ckptId(1));
		expect(listPending(dir).items).toEqual([]);
	});
});

describe("strict reads", () => {
	test("a corrupt file is reported and skipped, never deleted, and never hides a valid one", () => {
		const dir = dirOf();
		writePending(dir, checkpointItem(1));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `checkpoint-${ckptId(2)}.json`), "{not json");
		writeFileSync(join(dir, `checkpoint-${ckptId(3)}.json`), JSON.stringify({ ...checkpointItem(3), surprise: 1 }));
		// Valid content under the wrong name.
		writeFileSync(join(dir, `checkpoint-${ckptId(4)}.json`), JSON.stringify(checkpointItem(5)));
		writeFileSync(join(dir, "notes.txt"), "stray");
		writeFileSync(join(dir, `checkpoint-${ckptId(6)}.json`), "x".repeat(MAX_PENDING_BYTES + 1));
		symlinkSync(join(dir, `checkpoint-${ckptId(1)}.json`), join(dir, `checkpoint-${ckptId(7)}.json`));
		const listing = listPending(dir);
		expect(listing.items.map((item) => item.id)).toEqual([ckptId(1)]);
		const reasons = Object.fromEntries(listing.corrupt.map((entry) => [entry.file, entry.reason]));
		expect(reasons[`checkpoint-${ckptId(2)}.json`]).toBe("not valid JSON");
		expect(reasons[`checkpoint-${ckptId(3)}.json`]).toContain("not a known field");
		expect(reasons[`checkpoint-${ckptId(4)}.json`]).toBe("the file name does not match its content");
		expect(reasons["notes.txt"]).toBe("not a pending journal file name");
		expect(reasons[`checkpoint-${ckptId(6)}.json`]).toContain("larger than");
		expect(reasons[`checkpoint-${ckptId(7)}.json`]).toBe("not a regular file");
		// Nothing was deleted.
		expect(existsSync(join(dir, `checkpoint-${ckptId(2)}.json`))).toBe(true);
		expect(readFileSync(join(dir, `checkpoint-${ckptId(2)}.json`), "utf8")).toBe("{not json");
	});

	test("a leftover temp file from an interrupted write is ignored", () => {
		const dir = dirOf();
		writePending(dir, checkpointItem(1));
		writeFileSync(join(dir, `checkpoint-${ckptId(2)}.json.tmp`), "half");
		expect(listPending(dir)).toEqual({ items: [checkpointItem(1)], corrupt: [] });
	});
});

describe("bounds", () => {
	test("a full journal refuses a NEW item with a typed error but still takes an update", () => {
		const dir = dirOf();
		writePending(dir, checkpointItem(1));
		for (let i = 0; i < MAX_PENDING_ITEMS - 1; i++) writeFileSync(join(dir, `checkpoint-fill-${i}.json`), "{}");
		let error: unknown;
		try {
			writePending(dir, checkpointItem(2));
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(PendingJournalError);
		expect((error as PendingJournalError).code).toBe("full");
		expect(existsSync(join(dir, `checkpoint-${ckptId(2)}.json`))).toBe(false);
		// An update of an item already in the journal is not growth.
		writePending(dir, checkpointItem(1, { attempts: 9 }));
		expect(listPending(dir).items[0]?.attempts).toBe(9);
		// A directory over the bound is read up to the bound, and the journal says so.
		writeFileSync(join(dir, "checkpoint-fill-extra.json"), "{}");
		expect(listPending(dir).corrupt.some((entry) => entry.file === "(directory)")).toBe(true);
	});
});

describe("resolvePendingDir", () => {
	test("is substrate-pending under the worktree's own git directory", async () => {
		const repo = makeRepo();
		const dir = await resolvePendingDir(repo);
		expect(dir.endsWith(`/.git/${PENDING_DIR_NAME}`)).toBe(true);
		expect(git(repo, ["rev-parse", "--absolute-git-dir"]).trim().endsWith("/.git")).toBe(true);
	});
});

describe("replayPending", () => {
	function server(): FakeServer {
		return new FakeServer();
	}

	function dirWith(...items: PendingItem[]): string {
		const dir = dirOf();
		for (const item of items) writePending(dir, item);
		return dir;
	}

	test("delivers checkpoints before rollbacks, removes what is acknowledged, and a second sync sends nothing", async () => {
		const fake = server();
		fake.checkpoints.set(ckptId(1), { ...checkpointItem(1).record, session_id: SESSION, event_id: "evt_seed" });
		const dir = dirWith(rollbackItem(1, null), checkpointItem(2), checkpointItem(3));
		const first = await replayPending({ dir, clientFor: () => fake });
		expect(first.delivered.map((entry) => `${entry.kind}:${entry.id}`)).toEqual([`checkpoint:${ckptId(2)}`, `checkpoint:${ckptId(3)}`, `rollback:${rbId(1)}`]);
		expect(first).toMatchObject({ failed: [], skipped: 0, remaining: 0 });
		expect(fake.deliveries).toEqual({ checkpoint: 2, commit: 1 });
		// A rollback queued without a digest is planned first.
		expect(fake.calls.indexOf(`plan:${ckptId(1)}`)).toBeLessThan(fake.calls.indexOf(`commit:${rbId(1)}:committed`));
		expect(listPending(dir).items).toEqual([]);

		const before = fake.calls.length;
		const second = await replayPending({ dir, clientFor: () => fake });
		expect(second).toMatchObject({ delivered: [], failed: [], skipped: 0, remaining: 0 });
		expect(fake.calls.length).toBe(before);
	});

	test("a commit queued without a plan is planned again with the bound it was queued with, and committed with it", async () => {
		const fake = server();
		fake.checkpoints.set(ckptId(1), { ...checkpointItem(1).record, session_id: SESSION, event_id: "evt_seed" });
		const dir = dirWith(rollbackItem(1, null, { commit: { ...rollbackItem(1, null).commit, until_ms: 1_788_000_000_123 } }));
		await replayPending({ dir, clientFor: () => fake });
		expect(fake.planRequests).toEqual([{ session_id: SESSION, target_ckpt_id: ckptId(1), rollback_id: rbId(1), until_ms: 1_788_000_000_123 }]);
		expect(fake.commits.get(rbId(1))).toMatchObject({ until_ms: 1_788_000_000_123 });
		// A commit queued before the field existed plans without one.
		const old = server();
		old.checkpoints.set(ckptId(1), { ...checkpointItem(1).record, session_id: SESSION, event_id: "evt_seed" });
		await replayPending({ dir: dirWith(rollbackItem(2, null)), clientFor: () => old });
		expect(old.planRequests).toEqual([{ session_id: SESSION, target_ckpt_id: ckptId(1), rollback_id: rbId(2) }]);
	});

	test("a commit whose reply says the plane deletes are pending stays in the journal and is sent again, until the server reports none", async () => {
		const fake = server();
		fake.checkpoints.set(ckptId(1), { ...checkpointItem(1).record, session_id: SESSION, event_id: "evt_seed" });
		fake.planePendingReplies = 2;
		const dir = dirWith(rollbackItem(1, null));

		const first = await replayPending({ dir, clientFor: () => fake });
		expect(first.delivered).toHaveLength(1);
		expect(first.plane_pending).toEqual([{ id: rbId(1), event_id: first.delivered[0]?.event_id ?? "", retries: 0 }]);
		expect(first).toMatchObject({ failed: [], remaining: 1, warnings: [] });
		expect(listPending(dir).items[0]).toMatchObject({ kind: "rollback", id: rbId(1), plane_retries: 0 });

		// The same commit is sent again, and the server answers pending once more: kept, counted, not announced as delivered again.
		const second = await replayPending({ dir, clientFor: () => fake });
		expect(second.delivered).toEqual([]);
		expect(second.plane_pending).toMatchObject([{ id: rbId(1), retries: 1 }]);
		expect(second.remaining).toBe(1);

		// No pending deletes left: the record goes.
		const third = await replayPending({ dir, clientFor: () => fake });
		expect(third.delivered).toMatchObject([{ kind: "rollback", id: rbId(1) }]);
		expect(third).toMatchObject({ remaining: 0, plane_pending: [], warnings: [] });
		expect(listPending(dir).items).toEqual([]);
		// The server recorded the rollback once; the later sends were replays of it.
		expect(fake.deliveries.commit).toBe(1);
	});

	test("an offline rollback kept for a plane retry holds the digest the server accepted, so the next sync commits it without planning again", async () => {
		const fake = server();
		fake.checkpoints.set(ckptId(1), { ...checkpointItem(1).record, session_id: SESSION, event_id: "evt_seed" });
		fake.planePendingReplies = 2;
		const dir = dirWith(rollbackItem(1, null));
		expect(listPending(dir).items[0]).toMatchObject({ commit: { plan_digest: null } });

		await replayPending({ dir, clientFor: () => fake });
		expect(fake.planRequests).toHaveLength(1);
		const kept = listPending(dir).items[0];
		const digest = fake.commits.get(rbId(1))?.plan_digest;
		expect(typeof digest).toBe("string");
		expect(kept).toMatchObject({ kind: "rollback", plane_retries: 0, commit: { plan_digest: digest } });

		// The target checkpoint is gone from the server's bounded read: a re-plan would answer not-found, so none may be asked for.
		fake.checkpoints.clear();
		const second = await replayPending({ dir, clientFor: () => fake });
		expect(fake.planRequests).toHaveLength(1);
		expect(fake.calls.filter((call) => call.startsWith(`commit:${rbId(1)}`))).toHaveLength(2);
		expect(second).toMatchObject({ failed: [], plane_pending: [{ id: rbId(1), retries: 1 }] });

		const third = await replayPending({ dir, clientFor: () => fake });
		expect(fake.planRequests).toHaveLength(1);
		expect(third).toMatchObject({ failed: [], remaining: 0, plane_pending: [], warnings: [] });
		expect(listPending(dir).items).toEqual([]);
	});

	test("a server that keeps reporting pending deletes is sent the commit a bounded number of times, then the record is dropped with a named warning", async () => {
		const fake = server();
		fake.checkpoints.set(ckptId(1), { ...checkpointItem(1).record, session_id: SESSION, event_id: "evt_seed" });
		fake.planePendingReplies = 1_000;
		const dir = dirWith(rollbackItem(1, null));

		await replayPending({ dir, clientFor: () => fake });
		for (let retries = 1; retries < MAX_PLANE_RETRIES; retries++) {
			const outcome = await replayPending({ dir, clientFor: () => fake });
			expect(outcome.plane_pending).toMatchObject([{ id: rbId(1), retries }]);
			expect(outcome.warnings).toEqual([]);
		}

		const last = await replayPending({ dir, clientFor: () => fake });
		expect(last.warnings).toHaveLength(1);
		expect(last.warnings[0]).toContain("plane-pending-exhausted");
		expect(last.warnings[0]).toContain(rbId(1));
		expect(last).toMatchObject({ remaining: 0, plane_pending: [], failed: [] });
		expect(listPending(dir).items).toEqual([]);
		// One first delivery and MAX_PLANE_RETRIES sends again, then nothing more.
		expect(fake.calls.filter((call) => call.startsWith(`commit:${rbId(1)}`))).toHaveLength(MAX_PLANE_RETRIES + 1);
		const before = fake.calls.length;
		await replayPending({ dir, clientFor: () => fake });
		expect(fake.calls.length).toBe(before);
	});

	test("a server that cannot be reached leaves a plane-pending record in place with its retry count", async () => {
		const fake = server();
		fake.checkpoints.set(ckptId(1), { ...checkpointItem(1).record, session_id: SESSION, event_id: "evt_seed" });
		fake.planePendingReplies = 1;
		const dir = dirWith(rollbackItem(1, null));
		await replayPending({ dir, clientFor: () => fake });
		fake.down = true;
		const outcome = await replayPending({ dir, clientFor: () => fake });
		expect(outcome.failed).toHaveLength(1);
		expect(listPending(dir).items[0]).toMatchObject({ plane_retries: 0, attempts: 2 });
	});

	test("a replay that crashed after the server acknowledged is harmless: the item is sent again and held once", async () => {
		const fake = server();
		const item = checkpointItem(1);
		const dir = dirWith(item);
		await replayPending({ dir, clientFor: () => fake });
		// Put the same item back, as if the delete had never happened.
		writePending(dir, item);
		const again = await replayPending({ dir, clientFor: () => fake });
		expect(again.delivered).toHaveLength(1);
		expect(fake.deliveries.checkpoint).toBe(1);
		expect(fake.checkpoints.size).toBe(1);
	});

	test("a down server costs one call, leaves everything in place with the attempt counted, and skips the rest", async () => {
		const fake = server();
		fake.down = true;
		const dir = dirWith(checkpointItem(1), checkpointItem(2), rollbackItem(1, "d"));
		const outcome = await replayPending({ dir, clientFor: () => fake });
		expect(fake.calls).toEqual([`record:${ckptId(1)}`]);
		expect(outcome.delivered).toEqual([]);
		expect(outcome.failed).toHaveLength(1);
		expect(outcome.failed[0]).toMatchObject({ code: "network", retryable: true });
		expect(outcome.skipped).toBe(2);
		expect(outcome.remaining).toBe(3);
		const first = listPending(dir).items.find((item) => item.id === ckptId(1));
		expect(first?.attempts).toBe(2);
		expect(first?.last_error).toContain("network");
	});

	test("a refusal that is not about reachability does not stop the other items", async () => {
		const fake = server();
		const refuses = new Map<string, boolean>([[ckptId(1), true]]);
		const original = fake.recordCheckpoint.bind(fake);
		fake.recordCheckpoint = async (request) => (refuses.get(request.ckpt_id) ? failure("invalid-request", "rejected", false) : original(request));
		const dir = dirWith(checkpointItem(1), checkpointItem(2));
		const outcome = await replayPending({ dir, clientFor: () => fake });
		expect(outcome.failed.map((entry) => entry.id)).toEqual([ckptId(1)]);
		expect(outcome.delivered.map((entry) => entry.id)).toEqual([ckptId(2)]);
		expect(outcome.remaining).toBe(1);
	});

	test("a stale-plan answer re-plans once and delivers; stale twice leaves the commit for the next sync", async () => {
		const fake = server();
		fake.checkpoints.set(ckptId(1), { ...checkpointItem(1).record, session_id: SESSION, event_id: "evt_seed" });
		fake.staleCommits = 1;
		const dir = dirWith(rollbackItem(1, "old-digest"));
		const delivered = await replayPending({ dir, clientFor: () => fake });
		expect(delivered.delivered).toHaveLength(1);
		expect(fake.calls.filter((call) => call.startsWith("plan:"))).toHaveLength(1);

		const stuck = server();
		stuck.checkpoints.set(ckptId(1), { ...checkpointItem(1).record, session_id: SESSION, event_id: "evt_seed" });
		stuck.staleCommits = 2;
		const dir2 = dirWith(rollbackItem(2, "old-digest"));
		expect(stuck.calls).toEqual([]);
		const second = await replayPending({ dir: dir2, clientFor: () => stuck });
		expect(second.failed[0]?.code).toBe("stale-plan");
		expect(second.remaining).toBe(1);
		expect(stuck.calls.filter((call) => call.startsWith("commit:"))).toHaveLength(2);
	});

	test("each item is delivered with the client of its own surface", async () => {
		const seen: string[] = [];
		const fake = server();
		const dir = dirWith(checkpointItem(1, { surface: "cursor" }), checkpointItem(2, { surface: "claude-code" }));
		await replayPending({
			dir,
			clientFor: (surface) => {
				seen.push(surface);
				return fake;
			},
		});
		expect(seen).toEqual(["cursor", "claude-code"]);
	});

	test("corrupt files are reported by the replay and left alone", async () => {
		const fake = server();
		const dir = dirWith(checkpointItem(1));
		writeFileSync(join(dir, `checkpoint-${ckptId(2)}.json`), "garbage");
		chmodSync(join(dir, `checkpoint-${ckptId(2)}.json`), 0o600);
		const outcome = await replayPending({ dir, clientFor: () => fake });
		expect(outcome.delivered).toHaveLength(1);
		expect(outcome.corrupt.map((entry) => entry.file)).toEqual([`checkpoint-${ckptId(2)}.json`]);
		expect(existsSync(join(dir, `checkpoint-${ckptId(2)}.json`))).toBe(true);
	});
});
