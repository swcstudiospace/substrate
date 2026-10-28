/**
 * rollback() with the real snapshot library on temporary git repositories and a fake server: the file
 * state really goes back, nothing is left half done, and the ledger hears about it exactly once.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { RandomBytes } from "../../../mcp-server/src/session-events.ts";
import { SimulatedCrash, readPinnedSnapshot, snapshot } from "../../../worktree-snapshot/src/index.ts";
import { mutateToB, SCENARIO_POLICY, writeScenarioA } from "../../../worktree-snapshot/src/scenario.ts";
import { cleanupTemp, expectWorktreeMatches, FIXED_NOW, fileStateHash, git, makeRepo, tempDir, writeFiles } from "../../../worktree-snapshot/src/testkit.ts";
import { type CheckpointResult, createCheckpoint, listLocalCheckpoints } from "./checkpoint.ts";
import { listPending, replayPending } from "./pending.ts";
import { type RollbackParams, type RollbackResult, RollbackInputError, rollback, unsupportedTranscriptPort } from "./rollback.ts";
import { FakeServer, FakeTranscript, seededRandomBytes } from "./testkit.ts";

afterAll(cleanupTemp);
setDefaultTimeout(300_000);

const SESSION = "sess-1";

interface World {
	dir: string;
	pendingDir: string;
	server: FakeServer;
	transcript: FakeTranscript;
	randomBytes: RandomBytes;
}

function world(): World {
	const dir = makeRepo();
	writeScenarioA(dir);
	return { dir, pendingDir: join(tempDir(), "pending"), server: new FakeServer(), transcript: new FakeTranscript(), randomBytes: seededRandomBytes(11) };
}

function checkpoint(w: World, sessionId = SESSION, trigger: "manual" | "turn" = "manual"): Promise<CheckpointResult> {
	return createCheckpoint({
		worktree: w.dir,
		sessionId,
		trigger,
		surface: "claude-code",
		client: w.server,
		now: FIXED_NOW,
		randomBytes: w.randomBytes,
		pendingDir: w.pendingDir,
		policy: SCENARIO_POLICY,
	});
}

function roll(w: World, target: string | number, overrides: Partial<RollbackParams> = {}): Promise<RollbackResult> {
	return rollback({
		worktree: w.dir,
		sessionId: SESSION,
		target,
		dryRun: false,
		force: false,
		offline: false,
		surface: "claude-code",
		client: w.server,
		transcript: w.transcript,
		now: FIXED_NOW,
		randomBytes: w.randomBytes,
		pendingDir: w.pendingDir,
		policy: SCENARIO_POLICY,
		...overrides,
	});
}

const treeOf = async (w: World): Promise<string> => (await snapshot({ worktree: w.dir, policy: SCENARIO_POLICY, now: FIXED_NOW })).tree;
const journalPath = (w: World): string => join(w.dir, ".git", "substrate-restore", "restore-journal.json");

/** A at the first checkpoint, B (every kind of change) at the second. Returns both. */
async function twoStates(w: World): Promise<{ c1: CheckpointResult; c2: CheckpointResult }> {
	const c1 = await checkpoint(w);
	mutateToB(w.dir);
	const c2 = await checkpoint(w);
	return { c1, c2 };
}

describe("a rollback that works", () => {
	test("puts back added, deleted, renamed, mode-changed, symlinked and untracked files, and records it once", async () => {
		const w = world();
		const { c1, c2 } = await twoStates(w);
		const snapA = await readPinnedSnapshot({ worktree: w.dir, ref: c1.checkpoint.ref, now: FIXED_NOW });

		const result = await roll(w, c1.checkpoint.ckpt_id);

		expect(result.status).toBe("committed");
		expect(result.mode).toBe("server");
		expect(result.anchor).toEqual({ status: "anchored", reasons: [], source: "server" });
		expect(await treeOf(w)).toBe(c1.checkpoint.tree);
		expectWorktreeMatches(w.dir, snapA);
		// The things the mutation did, one by one.
		expect(readFileSync(join(w.dir, "README.md"), "utf8")).toBe("readme v1\n");
		expect(existsSync(join(w.dir, "docs", "old.md"))).toBe(true);
		expect(existsSync(join(w.dir, "src", "util.ts"))).toBe(true);
		expect(existsSync(join(w.dir, "src", "helpers.ts"))).toBe(false);
		expect(lstatSync(join(w.dir, "src", "main.ts")).mode & 0o111).toBe(0);
		expect(lstatSync(join(w.dir, "scripts", "run.sh")).mode & 0o111).not.toBe(0);
		expect(readlinkSync(join(w.dir, "link"))).toBe("README.md");
		expect(readFileSync(join(w.dir, "notes", "todo.txt"), "utf8")).toBe("todo\n");
		expect(existsSync(join(w.dir, "new", "created.txt"))).toBe(false);
		expect([...readFileSync(join(w.dir, "bin.dat"))]).toEqual([0, 255, 1, 2, 0, 128]);
		expect(readFileSync(join(w.dir, ".planning", "plan.md"), "utf8")).toBe("plan v1\n");

		// The pre-restore checkpoint holds the state the rollback replaced.
		expect(result.pre_restore).toMatchObject({ tree: c2.checkpoint.tree, server: "recorded" });
		const { checkpoints } = await listLocalCheckpoints({ worktree: w.dir });
		expect(checkpoints.map((c) => [c.seq, c.trigger])).toEqual([
			[1, "manual"],
			[2, "manual"],
			[3, "pre-restore"],
		]);
		expect(result.restore?.files.added).toBeGreaterThan(0);
		expect(result.restore?.files.deleted).toBeGreaterThan(0);
		expect(result.restore?.files.modified).toBeGreaterThan(0);
		expect(git(w.dir, ["rev-parse", "--verify", result.restore?.safety_ref ?? "missing"]).trim()).toMatch(/^[0-9a-f]{40}$/);

		// The ledger heard once, with the plan digest and the counts.
		expect(result.ledger.state).toBe("committed");
		expect(w.server.deliveries.commit).toBe(1);
		const commit = w.server.commits.get(result.rollback_id ?? "");
		expect(commit).toMatchObject({
			outcome: "committed",
			session_id: SESSION,
			target_ckpt_id: c1.checkpoint.ckpt_id,
			from_ckpt_id: c2.checkpoint.ckpt_id,
			pre_restore_ckpt_id: result.pre_restore?.ckpt_id,
			pre_restore_tree: c2.checkpoint.tree,
			files: result.restore?.files,
			transcript: "marker-only",
		});
		expect(commit && "local_only" in commit ? commit.local_only : undefined).toBeUndefined();
		// The checkpoint after the target and the pre-restore checkpoint the rollback took are both superseded.
		expect(result.memory).toEqual({ superseded_entries: 2, forgotten_documents: 1, plane_pending: false, truncated: false });
		expect(listPending(w.pendingDir).items).toEqual([]);
		expect(w.transcript.requests).toHaveLength(1);
		expect(w.transcript.requests[0]).toMatchObject({ sessionId: SESSION, targetCkptId: c1.checkpoint.ckpt_id, rollbackId: result.rollback_id });
	});

	test("the pre-restore checkpoint makes the rollback itself undoable, with no drift right after it", async () => {
		const w = world();
		const { c1, c2 } = await twoStates(w);
		const snapB = await readPinnedSnapshot({ worktree: w.dir, ref: c2.checkpoint.ref, now: FIXED_NOW });
		const first = await roll(w, c1.checkpoint.ckpt_id);
		expect(first.status).toBe("committed");

		const undo = await roll(w, first.pre_restore?.ckpt_id ?? "missing");
		expect(undo.status).toBe("committed");
		expect(undo.plan?.drift_count).toBe(0);
		expectWorktreeMatches(w.dir, snapB);
		expect(await treeOf(w)).toBe(c2.checkpoint.tree);
	});

	test("seq numbers and `previous` resolve against this session's checkpoints (dry runs, so nothing moves)", async () => {
		const w = world();
		const c1 = await checkpoint(w);
		writeFiles(w.dir, { "extra.txt": "x\n" });
		await checkpoint(w);
		writeFiles(w.dir, { "extra2.txt": "y\n" });
		const c3 = await checkpoint(w);
		const bySeq = await roll(w, 1, { dryRun: true });
		expect(bySeq.target).toMatchObject({ ckpt_id: c1.checkpoint.ckpt_id, seq: 1 });
		const byText = await roll(w, "2", { dryRun: true });
		expect(byText.target?.seq).toBe(2);
		const previous = await roll(w, "previous", { dryRun: true });
		expect(previous.target).toMatchObject({ ckpt_id: c3.checkpoint.ckpt_id, seq: 3 });
	});
});

describe("dry run", () => {
	test("lists the exact changes and counts and changes nothing, locally or on the server", async () => {
		const w = world();
		const { c1 } = await twoStates(w);
		const before = fileStateHash(w.dir);
		const callsBefore = w.server.calls.length;
		const localBefore = (await listLocalCheckpoints({ worktree: w.dir })).checkpoints.length;

		const result = await roll(w, c1.checkpoint.ckpt_id, { dryRun: true });

		expect(result.status).toBe("dry-run");
		expect(result.plan?.counts.total).toBeGreaterThan(8);
		const ops = result.plan?.operations ?? [];
		expect(ops.length).toBe(result.plan?.counts.total as number);
		expect(ops.some((op) => op.op === "delete" && op.path === "new/created.txt")).toBe(true);
		expect(ops.some((op) => op.op === "add" && op.path === "docs/old.md")).toBe(true);
		expect(ops.some((op) => op.op === "chmod" && op.path === "src/main.ts")).toBe(true);
		expect(result.blocked_by).toEqual([]);
		expect(fileStateHash(w.dir)).toBe(before);
		expect((await listLocalCheckpoints({ worktree: w.dir })).checkpoints).toHaveLength(localBefore);
		// Only the read-only plan call reached the server.
		expect(w.server.calls.slice(callsBefore)).toEqual([`plan:${c1.checkpoint.ckpt_id}`]);
		expect(w.transcript.requests).toEqual([]);
		expect(listPending(w.pendingDir).items).toEqual([]);
	});

	test("says a real run would refuse for drift, and still writes nothing to the ledger", async () => {
		const w = world();
		const { c1 } = await twoStates(w);
		writeFiles(w.dir, { "src/main.ts": "edited by someone else\n" });
		const result = await roll(w, c1.checkpoint.ckpt_id, { dryRun: true });
		expect(result.status).toBe("dry-run");
		expect(result.blocked_by).toEqual(["drift-detected"]);
		expect(result.plan?.drift_count).toBeGreaterThan(0);
		expect(w.server.refusals).toEqual([]);
	});
});

describe("drift", () => {
	test("is refused (and reported), then goes through with force and the drifted state is kept in the pre-restore checkpoint", async () => {
		const w = world();
		const { c1 } = await twoStates(w);
		writeFiles(w.dir, { "src/main.ts": "edited after the last checkpoint\n" });
		const drifted = fileStateHash(w.dir);
		const driftedTree = await treeOf(w);

		const refused = await roll(w, c1.checkpoint.ckpt_id);
		expect(refused.status).toBe("refused");
		expect(refused.refusal?.reason).toBe("drift-detected");
		expect(fileStateHash(w.dir)).toBe(drifted);
		expect(w.server.refusals).toHaveLength(1);
		expect(w.server.refusals[0]).toMatchObject({ outcome: "refused", reason: "drift-detected", target_ckpt_id: c1.checkpoint.ckpt_id });
		expect(refused.ledger.state).toBe("refusal-recorded");
		expect(w.server.commits.size).toBe(0);

		const forced = await roll(w, c1.checkpoint.ckpt_id, { force: true });
		expect(forced.status).toBe("committed");
		expect(forced.warnings.some((warning) => warning.includes("drift overridden by --force"))).toBe(true);
		expect(forced.pre_restore?.tree).toBe(driftedTree);
		expect(await treeOf(w)).toBe(c1.checkpoint.tree);
	});

	test("a refusal report that cannot be delivered does not change the refusal (fail-open)", async () => {
		const w = world();
		const { c1 } = await twoStates(w);
		writeFiles(w.dir, { "src/main.ts": "edited\n" });
		w.server.downForCommits = true;
		const result = await roll(w, c1.checkpoint.ckpt_id);
		expect(result.status).toBe("refused");
		expect(result.ledger.state).toBe("refusal-not-recorded");
	});
});

describe("targets", () => {
	test("a checkpoint of another session is refused as not-authorized, and nothing moves", async () => {
		const w = world();
		const foreign = await checkpoint(w, "someone-elses-session");
		await checkpoint(w);
		mutateToB(w.dir);
		await checkpoint(w);
		const before = fileStateHash(w.dir);
		const result = await roll(w, foreign.checkpoint.ckpt_id);
		expect(result.status).toBe("refused");
		expect(result.refusal?.reason).toBe("not-authorized");
		expect(result.refusal?.detail).toContain("another session");
		expect(fileStateHash(w.dir)).toBe(before);
		expect(w.server.commits.size).toBe(0);
	});

	test("an unknown id, a missing seq and `previous` with no checkpoint are target-not-found", async () => {
		const w = world();
		const none = await roll(w, "previous");
		expect(none).toMatchObject({ status: "refused", refusal: { reason: "target-not-found" } });
		await checkpoint(w);
		const unknown = await roll(w, `ckpt_${"q".repeat(26)}`);
		expect(unknown).toMatchObject({ status: "refused", refusal: { reason: "target-not-found" } });
		const missingSeq = await roll(w, 9);
		expect(missingSeq).toMatchObject({ status: "refused", refusal: { reason: "target-not-found" } });
	});

	test("a target that is not a ckpt id, a seq or `previous` is an input error", async () => {
		const w = world();
		await expect(roll(w, "../../etc/passwd")).rejects.toBeInstanceOf(RollbackInputError);
		await expect(roll(w, "latest")).rejects.toMatchObject({ code: "invalid-target" });
		await expect(roll(w, "previous", { sessionId: "" })).rejects.toMatchObject({ code: "invalid-session" });
	});

	test("a local checkpoint that disagrees with the ledger's record of it is refused, force or not", async () => {
		const w = world();
		const { c1 } = await twoStates(w);
		const held = w.server.checkpoints.get(c1.checkpoint.ckpt_id);
		if (held === undefined) throw new Error("expected the server to hold the checkpoint");
		w.server.checkpoints.set(c1.checkpoint.ckpt_id, { ...held, git_tree: "f".repeat(40) });
		const before = fileStateHash(w.dir);
		for (const force of [false, true]) {
			const result = await roll(w, c1.checkpoint.ckpt_id, { force });
			expect(result).toMatchObject({ status: "refused", refusal: { reason: "hash-mismatch" } });
		}
		expect(fileStateHash(w.dir)).toBe(before);
	});
});

describe("anchor status", () => {
	test("mismatch refuses unless forced; pending, unanchored and unverified only warn in the output", async () => {
		const w = world();
		const { c1 } = await twoStates(w);
		w.server.anchorStatus = "mismatch";
		const refused = await roll(w, c1.checkpoint.ckpt_id);
		expect(refused).toMatchObject({ status: "refused", refusal: { reason: "hash-mismatch" }, anchor: { status: "mismatch" } });
		expect(await treeOf(w)).not.toBe(c1.checkpoint.tree);

		for (const status of ["pending", "unanchored", "unverified"] as const) {
			w.server.anchorStatus = status;
			const result = await roll(w, c1.checkpoint.ckpt_id, { dryRun: true });
			expect(result.status).toBe("dry-run");
			expect(result.blocked_by).toEqual([]);
			expect(result.anchor?.status).toBe(status);
		}

		w.server.anchorStatus = "mismatch";
		const forced = await roll(w, c1.checkpoint.ckpt_id, { force: true });
		expect(forced.status).toBe("committed");
		expect(forced.warnings.some((warning) => warning.includes("anchor mismatch overridden"))).toBe(true);
	});

	test("a retired signer (mismatch, signer-retired) refuses a rollback; an unreadable rotation list (unverified, rotation-read-incomplete) only warns", async () => {
		const w = world();
		const { c1 } = await twoStates(w);
		w.server.anchorStatus = "mismatch";
		w.server.anchorReasons = ["signer-retired: a key was retired at 2026-01-01T00:00:00.000Z, at or before the anchored hour"];
		const refused = await roll(w, c1.checkpoint.ckpt_id);
		expect(refused).toMatchObject({ status: "refused", refusal: { reason: "hash-mismatch" }, anchor: { status: "mismatch" } });
		expect(await treeOf(w)).not.toBe(c1.checkpoint.tree);

		w.server.anchorStatus = "unverified";
		w.server.anchorReasons = ["rotation-read-incomplete: the rotation notes could not be read"];
		const open = await roll(w, c1.checkpoint.ckpt_id, { dryRun: true });
		expect(open.status).toBe("dry-run");
		expect(open.blocked_by).toEqual([]);
	});

	test("a plan with no anchor information is reported as unverified, not as anchored", async () => {
		const w = world();
		const { c1 } = await twoStates(w);
		w.server.anchorStatus = null;
		const result = await roll(w, c1.checkpoint.ckpt_id, { dryRun: true });
		expect(result.anchor).toEqual({ status: "unverified", reasons: ["the server returned no anchor status"], source: "server" });
	});
});

describe("the server is not there", () => {
	test("unreachable at plan time: the rollback works from the local refs, says unanchored, queues the commit, and sync delivers it once", async () => {
		const w = world();
		const { c1, c2 } = await twoStates(w);
		const snapA = await readPinnedSnapshot({ worktree: w.dir, ref: c1.checkpoint.ref, now: FIXED_NOW });
		w.server.down = true;
		const callsBefore = w.server.calls.length;

		const result = await roll(w, c1.checkpoint.ckpt_id);

		expect(result.status).toBe("commit-pending");
		expect(result.mode).toBe("local-only");
		expect(result.local_only_reason).toBe("server-unreachable");
		expect(result.anchor).toMatchObject({ status: "unanchored", source: "local" });
		expectWorktreeMatches(w.dir, snapA);
		expect(await treeOf(w)).toBe(c1.checkpoint.tree);
		// One timeout, not one per call: after the plan failed the client stopped asking.
		expect(w.server.calls.slice(callsBefore)).toEqual([`plan:${c1.checkpoint.ckpt_id}`]);
		expect(result.warnings.some((warning) => warning.includes("unanchored"))).toBe(true);
		expect(result.ledger.state).toBe("pending");

		const pending = listPending(w.pendingDir).items;
		expect(pending.map((item) => item.kind)).toEqual(["checkpoint", "rollback"]);
		const queued = pending[1];
		expect(queued).toMatchObject({ kind: "rollback", id: result.rollback_id, session_id: SESSION });
		expect(queued?.kind === "rollback" && queued.commit).toMatchObject({
			target_ckpt_id: c1.checkpoint.ckpt_id,
			plan_digest: null,
			from_ckpt_id: c2.checkpoint.ckpt_id,
			local_only: true,
			transcript: "marker-only",
		});

		w.server.down = false;
		const synced = await replayPending({ dir: w.pendingDir, clientFor: () => w.server });
		expect(synced.delivered.map((entry) => entry.kind)).toEqual(["checkpoint", "rollback"]);
		expect(w.server.deliveries.commit).toBe(1);
		const delivered = w.server.commits.get(result.rollback_id ?? "");
		expect(delivered).toMatchObject({ outcome: "committed", local_only: true, pre_restore_ckpt_id: result.pre_restore?.ckpt_id });
		expect(listPending(w.pendingDir).items).toEqual([]);

		const again = await replayPending({ dir: w.pendingDir, clientFor: () => w.server });
		expect(again.delivered).toEqual([]);
		expect(w.server.deliveries.commit).toBe(1);
	});

	test("--offline never contacts the server and says so", async () => {
		const w = world();
		const { c1 } = await twoStates(w);
		const callsBefore = w.server.calls.length;
		const result = await roll(w, c1.checkpoint.ckpt_id, { offline: true });
		expect(result.status).toBe("commit-pending");
		expect(result.local_only_reason).toBe("offline");
		expect(w.server.calls.length).toBe(callsBefore);
		expect(await treeOf(w)).toBe(c1.checkpoint.tree);
		expect(listPending(w.pendingDir).items.map((item) => item.kind)).toEqual(["checkpoint", "rollback"]);
	});

	test("a ledger that says it is down is treated like an unreachable server", async () => {
		const w = world();
		const { c1 } = await twoStates(w);
		const plan = w.server.planRollback.bind(w.server);
		w.server.planRollback = async (request) => {
			const planned = await plan(request);
			return planned.ok ? { ok: false, error: { code: "ledger-down", message: "ledger unavailable", retryable: true } } : planned;
		};
		const result = await roll(w, c1.checkpoint.ckpt_id);
		expect(result.status).toBe("commit-pending");
		expect(result.local_only_reason).toBe("server-unreachable");
	});

	test("reachable at plan time but down at commit: the plan digest is kept in the queued commit", async () => {
		const w = world();
		const { c1 } = await twoStates(w);
		w.server.downForCommits = true;
		const result = await roll(w, c1.checkpoint.ckpt_id);
		expect(result.status).toBe("commit-pending");
		expect(result.mode).toBe("server");
		expect(await treeOf(w)).toBe(c1.checkpoint.tree);
		const queued = listPending(w.pendingDir).items.find((item) => item.kind === "rollback");
		expect(queued?.kind === "rollback" && queued.commit.plan_digest).toMatch(/^[0-9a-f]{64}$/);
		w.server.downForCommits = false;
		const synced = await replayPending({ dir: w.pendingDir, clientFor: () => w.server });
		expect(synced.failed).toEqual([]);
		expect(w.server.deliveries.commit).toBe(1);
	});

	test("the instant the rollback began bounds every plan and the commit, and a commit queued offline keeps it for the sync", async () => {
		const w = world();
		const { c1 } = await twoStates(w);
		const began = FIXED_NOW().getTime();
		const online = await roll(w, c1.checkpoint.ckpt_id);
		expect(online.status).toBe("committed");
		expect(w.server.planRequests.at(-1)).toMatchObject({ target_ckpt_id: c1.checkpoint.ckpt_id, until_ms: began });
		expect(w.server.commits.get(online.rollback_id ?? "")).toMatchObject({ outcome: "committed", until_ms: began });

		// A rollback that could not reach the server at plan time: the bound is in the pending commit, and the sync's plan and commit use it.
		const offline = world();
		const states = await twoStates(offline);
		offline.server.down = true;
		const queuedRun = await roll(offline, states.c1.checkpoint.ckpt_id);
		expect(queuedRun.status).toBe("commit-pending");
		const queued = listPending(offline.pendingDir).items.find((item) => item.kind === "rollback");
		expect(queued?.kind === "rollback" && queued.commit.until_ms).toBe(began);
		offline.server.down = false;
		offline.server.planRequests.length = 0;
		const synced = await replayPending({ dir: offline.pendingDir, clientFor: () => offline.server });
		expect(synced.failed).toEqual([]);
		expect(offline.server.planRequests).toEqual([expect.objectContaining({ rollback_id: queuedRun.rollback_id, until_ms: began })]);
		expect(offline.server.commits.get(queuedRun.rollback_id ?? "")).toMatchObject({ until_ms: began, local_only: true });
	});

	test("the server's not-found answer for a target it does not hold is the target-not-found refusal, like a missing local checkpoint", async () => {
		const w = world();
		const { c1 } = await twoStates(w);
		w.server.checkpoints.clear();
		w.server.notFoundCode = "not-found";
		const treeBefore = await treeOf(w);

		const result = await roll(w, c1.checkpoint.ckpt_id);

		expect(result).toMatchObject({ status: "refused", refusal: { reason: "target-not-found" } });
		expect(w.server.refusals.map((refusal) => refusal.outcome === "refused" && refusal.reason)).toEqual(["target-not-found"]);
		// Nothing was restored: the refusal came before any file was touched.
		expect(await treeOf(w)).toBe(treeBefore);
		expect(listPending(w.pendingDir).items.filter((item) => item.kind === "rollback")).toEqual([]);
	});

	test("an unauthorized plan is a refusal, not a silent local rollback; --offline is the way around it", async () => {
		const w = world();
		const { c1 } = await twoStates(w);
		w.server.unauthorized = true;
		const refused = await roll(w, c1.checkpoint.ckpt_id);
		expect(refused).toMatchObject({ status: "refused", refusal: { reason: "not-authorized" } });
		expect(refused.refusal?.detail).toContain("--offline");
		expect(await treeOf(w)).not.toBe(c1.checkpoint.tree);
		const offline = await roll(w, c1.checkpoint.ckpt_id, { offline: true });
		expect(offline.status).toBe("commit-pending");
		expect(await treeOf(w)).toBe(c1.checkpoint.tree);
	});

	test("a server answer the client cannot use fails the run instead of guessing", async () => {
		const w = world();
		const { c1 } = await twoStates(w);
		w.server.planRollback = async () => ({ ok: false, error: { code: "bad-response", message: "garbled", retryable: false } });
		const result = await roll(w, c1.checkpoint.ckpt_id);
		expect(result.status).toBe("failed");
		expect(result.failure?.message).toContain("--offline");
		expect(await treeOf(w)).not.toBe(c1.checkpoint.tree);
	});
});

describe("stale plans", () => {
	test("one stale-plan answer re-plans once and then commits", async () => {
		const w = world();
		const { c1 } = await twoStates(w);
		w.server.staleCommits = 1;
		const callsBefore = w.server.calls.length;
		const result = await roll(w, c1.checkpoint.ckpt_id);
		expect(result.status).toBe("committed");
		const calls = w.server.calls.slice(callsBefore);
		expect(calls.filter((call) => call.startsWith("plan:"))).toHaveLength(2);
		expect(calls.filter((call) => call.includes(":committed"))).toHaveLength(2);
		expect(w.server.deliveries.commit).toBe(1);
	});

	test("a plan that changes again stops: files stay restored, the commit is queued for a fresh plan, sync delivers it", async () => {
		const w = world();
		const { c1 } = await twoStates(w);
		w.server.staleCommits = 2;
		const result = await roll(w, c1.checkpoint.ckpt_id);
		expect(result.status).toBe("commit-pending");
		expect(result.ledger.message).toContain("stale-plan");
		expect(await treeOf(w)).toBe(c1.checkpoint.tree);
		const queued = listPending(w.pendingDir).items.find((item) => item.kind === "rollback");
		expect(queued?.kind === "rollback" && queued.commit.plan_digest).toBeNull();
		const synced = await replayPending({ dir: w.pendingDir, clientFor: () => w.server });
		expect(synced.delivered.some((entry) => entry.kind === "rollback")).toBe(true);
		expect(w.server.deliveries.commit).toBe(1);
	});
});

describe("a restore that goes wrong", () => {
	test("a crash mid-restore is finished by the next run, which reports it; the crashed run never reached the ledger", async () => {
		const w = world();
		const { c1 } = await twoStates(w);
		const snapA = await readPinnedSnapshot({ worktree: w.dir, ref: c1.checkpoint.ref, now: FIXED_NOW });
		let crashedAt = -1;
		const crashed = await roll(w, c1.checkpoint.ckpt_id, {
			hooks: {
				beforeOp: (index) => {
					if (index === 3) {
						crashedAt = index;
						throw new SimulatedCrash("process died");
					}
				},
			},
		}).catch((caught: unknown) => caught);
		expect(crashed).toBeInstanceOf(SimulatedCrash);
		expect(crashedAt).toBe(3);
		expect(existsSync(journalPath(w))).toBe(true);
		expect(await treeOf(w)).not.toBe(c1.checkpoint.tree);
		expect(w.server.commits.size).toBe(0);

		// Any next run starts by recovering, even a dry run, and says so.
		const next = await roll(w, c1.checkpoint.ckpt_id, { dryRun: true });
		expect(next.recovered).toMatchObject({ direction: "forward" });
		const recovered = next.recovered?.files;
		expect((recovered?.added ?? 0) + (recovered?.modified ?? 0) + (recovered?.deleted ?? 0)).toBeGreaterThan(0);
		expect(next.warnings.some((warning) => warning.includes("interrupted restore"))).toBe(true);
		expect(existsSync(journalPath(w))).toBe(false);
		expect(await treeOf(w)).toBe(c1.checkpoint.tree);
		expectWorktreeMatches(w.dir, snapA);
		expect(next.status).toBe("dry-run");
		expect(next.plan?.counts.total).toBe(0);
		// The pre-restore checkpoint taken before the crash is still there to undo with.
		const { checkpoints } = await listLocalCheckpoints({ worktree: w.dir });
		expect(checkpoints.some((c) => c.trigger === "pre-restore")).toBe(true);
	});

	test("a crash mid-restore leaves a journalled commit that sync holds back until recover finishes the restore, then delivers once", async () => {
		const w = world();
		const { c1 } = await twoStates(w);
		const crashed = await roll(w, c1.checkpoint.ckpt_id, {
			hooks: {
				beforeOp: (index) => {
					if (index === 3) throw new SimulatedCrash("process died");
				},
			},
		}).catch((caught: unknown) => caught);
		expect(crashed).toBeInstanceOf(SimulatedCrash);
		const marked = listPending(w.pendingDir).items.find((item) => item.kind === "rollback");
		expect(marked?.kind === "rollback" && marked.restoring).toBe(true);
		expect(marked?.kind === "rollback" && marked.commit.files.added + marked.commit.files.modified + marked.commit.files.deleted).toBeGreaterThan(0);

		// Before the restore is finished the ledger is not told.
		const early = await replayPending({ dir: w.pendingDir, clientFor: () => w.server });
		expect(early.failed.some((entry) => entry.kind === "rollback" && entry.code === "restore-in-progress")).toBe(true);
		expect(w.server.deliveries.commit).toBe(0);

		const next = await roll(w, c1.checkpoint.ckpt_id, { dryRun: true });
		expect(next.recovered).toMatchObject({ direction: "forward" });
		const settled = listPending(w.pendingDir).items.find((item) => item.kind === "rollback");
		expect(settled?.kind === "rollback" && settled.restoring).toBeUndefined();
		const synced = await replayPending({ dir: w.pendingDir, clientFor: () => w.server });
		expect(synced.delivered.some((entry) => entry.kind === "rollback")).toBe(true);
		expect(w.server.deliveries.commit).toBe(1);
		expect(listPending(w.pendingDir).items.filter((item) => item.kind === "rollback")).toEqual([]);
	});

	test("a rollback that crashed before its restore began is dropped by the next run, never delivered", async () => {
		const w = world();
		const { c1 } = await twoStates(w);
		const crashed = await roll(w, c1.checkpoint.ckpt_id, {
			hooks: {
				beforeOp: (index) => {
					if (index === 0) throw new SimulatedCrash("process died");
				},
			},
		}).catch((caught: unknown) => caught);
		expect(crashed).toBeInstanceOf(SimulatedCrash);
		// Forget the journal: as if the process died before the restore wrote it.
		rmSync(journalPath(w), { force: true });
		await roll(w, c1.checkpoint.ckpt_id, { dryRun: true });
		expect(listPending(w.pendingDir).items.filter((item) => item.kind === "rollback")).toEqual([]);
		expect(w.server.deliveries.commit).toBe(0);
	});

	test("a failure that is handled rolls back, is reported honestly with the safety ref, and writes nothing to the ledger", async () => {
		const w = world();
		const { c1, c2 } = await twoStates(w);
		const before = fileStateHash(w.dir);
		const result = await roll(w, c1.checkpoint.ckpt_id, {
			hooks: {
				beforeOp: (index) => {
					if (index === 4) throw new Error("disk full");
				},
			},
		});
		expect(result.status).toBe("failed");
		expect(result.failure).toMatchObject({ modified: true, rolled_back: true, recover: null });
		expect(result.failure?.safety_ref).toMatch(/^refs\/substrate\/safety\//);
		expect(fileStateHash(w.dir)).toBe(before);
		expect(await treeOf(w)).toBe(c2.checkpoint.tree);
		expect(w.server.commits.size).toBe(0);
		expect(listPending(w.pendingDir).items.filter((item) => item.kind === "rollback")).toEqual([]);
	});
});

describe("the transcript step", () => {
	test("the outcome the port reports is what the ledger records", async () => {
		const w = world();
		const { c1 } = await twoStates(w);
		w.transcript.outcome = "moved-leaf";
		const result = await roll(w, c1.checkpoint.ckpt_id);
		expect(result.transcript).toEqual({ outcome: "moved-leaf" });
		expect(w.server.commits.get(result.rollback_id ?? "")).toMatchObject({ transcript: "moved-leaf" });
	});

	test("a port that throws cannot undo or fail a rollback whose files are already restored", async () => {
		const w = world();
		const { c1 } = await twoStates(w);
		w.transcript.throws = true;
		const result = await roll(w, c1.checkpoint.ckpt_id);
		expect(result.status).toBe("committed");
		expect(result.transcript?.outcome).toBe("unsupported");
		expect(result.warnings.some((warning) => warning.includes("transcript step failed"))).toBe(true);
		expect(w.server.commits.get(result.rollback_id ?? "")).toMatchObject({ transcript: "unsupported" });
	});

	test("the target's transcript pointer reaches the port", async () => {
		const w = world();
		const c1 = await createCheckpoint({
			worktree: w.dir,
			sessionId: SESSION,
			trigger: "turn",
			transcriptRef: { surface: "claude-code", session_locator: "abc", turn_no: 3 },
			surface: "claude-code",
			client: w.server,
			now: FIXED_NOW,
			randomBytes: w.randomBytes,
			pendingDir: w.pendingDir,
			policy: SCENARIO_POLICY,
		});
		mutateToB(w.dir);
		await checkpoint(w);
		await roll(w, c1.checkpoint.ckpt_id);
		expect(w.transcript.requests[0]?.transcriptRef).toEqual({ surface: "claude-code", session_locator: "abc", turn_no: 3 });
	});

	test("the default port reports unsupported and never claims to have moved anything", async () => {
		expect(await unsupportedTranscriptPort.rewind({ sessionId: "s", surface: "claude-code", rollbackId: "rb", targetCkptId: "ckpt" })).toMatchObject({ outcome: "unsupported" });
	});
});
