/**
 * The durable completion store (phase 53, SOTA-09, D53-i), exercised on a real temp directory: a completion survives a
 * restart, recording it again is a no-op, a changed file hash runs its step again and is flagged, a corrupt file refuses
 * the open, and an unset directory reports that checkpoints are not durable.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planResume, recordCompletion } from "./checkpoint.ts";
import { CheckpointStoreError, COMPLETIONS_FILE, completionStoreView, DurableCompletionStore } from "./checkpoint-store.ts";
import { loadCheckpointDirectory, PLANNING_CHECKPOINT_DIR_ENV } from "./config.ts";

let dir: string;
let checkpoints: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "checkpoint-store-"));
	checkpoints = join(dir, "checkpoints");
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

const COMPLETION = { phase: "53", step: "03-steer", fileHash: sha256("plan v1"), recordedAtMs: 1_000 };

describe("a completion survives a restart", () => {
	test("record, reopen the same directory, record the same key again: exactly one record is stored", async () => {
		const first = await DurableCompletionStore.open(checkpoints);
		const inserted = await recordCompletion(first, COMPLETION);
		expect(inserted.outcome).toBe("inserted");

		const reopened = await DurableCompletionStore.open(checkpoints);
		expect(await recordCompletion(reopened, COMPLETION)).toEqual({ outcome: "exists", key: inserted.key });
		expect(await reopened.list("53")).toEqual([expect.objectContaining({ key: inserted.key, phase: "53", step: "03-steer" })]);

		const lines = (await readFile(join(checkpoints, COMPLETIONS_FILE), "utf8")).split("\n").filter((line) => line !== "");
		expect(lines).toHaveLength(1);
	});

	test("a changed file hash re-runs the step and is flagged on resume, and its completion is a second record", async () => {
		const store = await DurableCompletionStore.open(checkpoints);
		await recordCompletion(store, COMPLETION);

		const reopened = await DurableCompletionStore.open(checkpoints);
		const changed = sha256("plan v2");
		const resumed = planResume({
			phase: "53",
			steps: [{ step: "03-steer", fileHash: changed }],
			lastCheckpoint: await reopened.list("53"),
		});
		expect(resumed).toEqual({
			ok: true,
			plan: { run: [expect.objectContaining({ step: "03-steer", fileChanged: true })], completed: [] },
		});

		expect(await recordCompletion(reopened, { ...COMPLETION, fileHash: changed })).toMatchObject({ outcome: "inserted" });
		expect(await reopened.list("53")).toHaveLength(2);

		const unchanged = planResume({
			phase: "53",
			steps: [{ step: "03-steer", fileHash: COMPLETION.fileHash }],
			lastCheckpoint: await reopened.list("53"),
		});
		expect(unchanged).toEqual({ ok: true, plan: { run: [], completed: [expect.objectContaining({ step: "03-steer" })] } });
	});

	test("a file that does not parse refuses the open, and nothing is repaired", async () => {
		await mkdir(checkpoints, { recursive: true });
		await writeFile(join(checkpoints, COMPLETIONS_FILE), "not json\n");
		await expect(DurableCompletionStore.open(checkpoints)).rejects.toBeInstanceOf(CheckpointStoreError);
		await expect(DurableCompletionStore.open(checkpoints)).rejects.toMatchObject({ code: "corrupt-record", line: 1 });
	});

	test("a record whose key is not the hash of its fields refuses the open", async () => {
		await mkdir(checkpoints, { recursive: true });
		const forged = { ...COMPLETION, key: "a".repeat(64) };
		await writeFile(join(checkpoints, COMPLETIONS_FILE), `${JSON.stringify(forged)}\n`);
		await expect(DurableCompletionStore.open(checkpoints)).rejects.toMatchObject({ code: "corrupt-record", line: 1 });
	});
});

describe("the checkpoint directory setting", () => {
	test("unset or blank keeps checkpoints in memory, and the view says they are not durable", () => {
		expect(completionStoreView(loadCheckpointDirectory({}))).toEqual({ durable: false, reason: "checkpoint-dir-unset" });
		expect(completionStoreView(loadCheckpointDirectory({ [PLANNING_CHECKPOINT_DIR_ENV]: "   " }))).toEqual({
			durable: false,
			reason: "checkpoint-dir-unset",
		});
	});

	test("an absolute directory makes the checkpoints durable", () => {
		expect(completionStoreView(loadCheckpointDirectory({ [PLANNING_CHECKPOINT_DIR_ENV]: checkpoints }))).toEqual({ durable: true });
	});

	test("a relative directory is refused and the view says it is invalid, without echoing the value", () => {
		const config = loadCheckpointDirectory({ [PLANNING_CHECKPOINT_DIR_ENV]: "relative/checkpoints" });
		expect(config).toEqual({ ok: false, errors: [{ key: PLANNING_CHECKPOINT_DIR_ENV, reason: "not-absolute" }] });
		expect(completionStoreView(config)).toEqual({ durable: false, reason: "checkpoint-dir-invalid" });
	});
});

describe("two opens of one directory do not overwrite each other (greptile P1)", () => {
	test("a record written through one open survives an insert through a second open that loaded the file earlier", async () => {
		const first = await DurableCompletionStore.open(checkpoints);
		const second = await DurableCompletionStore.open(checkpoints);
		const x = await recordCompletion(first, COMPLETION);
		const y = await recordCompletion(second, { ...COMPLETION, step: "04-plan" });
		expect(x.outcome).toBe("inserted");
		expect(y.outcome).toBe("inserted");

		const reopened = await DurableCompletionStore.open(checkpoints);
		expect((await reopened.list("53")).map((record) => record.key).sort()).toEqual([x.key, y.key].sort());
		expect((await second.list("53")).map((record) => record.key).sort()).toEqual([x.key, y.key].sort());
	});
});
