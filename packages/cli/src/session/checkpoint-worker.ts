/**
 * One process of the two-process checkpoint test: `bun checkpoint-worker.ts <worktree> <count>` makes
 * <count> checkpoints of the session "race" in <worktree> (offline, so each is journaled) and prints one
 * JSON line `{"seq","ckpt_id","ref"}` per checkpoint. Imported by nothing; spawned by checkpoint.test.ts.
 */
import { createCheckpoint } from "./checkpoint.ts";
import { offlineClient } from "./client.ts";

const [worktree, count] = process.argv.slice(2);
if (worktree === undefined || count === undefined) throw new Error("usage: checkpoint-worker.ts <worktree> <count>");

for (let i = 0; i < Number(count); i += 1) {
	const { checkpoint } = await createCheckpoint({
		worktree,
		sessionId: "race",
		trigger: "manual",
		surface: "claude-code",
		client: offlineClient(),
		now: () => new Date(),
		randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
	});
	process.stdout.write(`${JSON.stringify({ seq: checkpoint.seq, ckpt_id: checkpoint.ckpt_id, ref: checkpoint.ref })}\n`);
}
