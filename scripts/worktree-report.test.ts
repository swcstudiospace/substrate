import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tempDir } from "../packages/fleet/src/testkit.ts";

const SCRIPT = join(import.meta.dir, "worktree-report.ts");

/** Runs the scheduled report as a timer would: its own process, the given environment, and no inherited worktree or URL settings. */
async function runScheduled(extra: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !key.startsWith("SUBSTRATE_")) env[key] = value;
	}
	const proc = Bun.spawn([process.execPath, SCRIPT], { env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	return { code: await proc.exited, out, err };
}

describe("scripts/worktree-report.ts", () => {
	test("with no worktree root configured it exits 2 and reports nothing", async () => {
		const run = await runScheduled({});
		expect(run.code).toBe(2);
		expect(run.err).toContain("no worktree root is configured");
		expect(run.out).toBe("");
	});

	test("when the registry cannot be read it posts nothing and exits 1, so no session attribution is lost", async () => {
		const root = tempDir();
		// Port 9 refuses connections at once: the listing fails before any report is attempted.
		const run = await runScheduled({ SUBSTRATE_WORKTREE_ROOTS: root, SUBSTRATE_URL: "http://127.0.0.1:9", SUBSTRATE_TIMEOUT_MS: "1000" });
		expect(run.code).toBe(1);
		expect(run.err).toContain("cannot keep session attribution");
		expect(run.err).toContain("nothing was reported");
		expect(run.out).not.toContain("reported to the registry");
	});
});
