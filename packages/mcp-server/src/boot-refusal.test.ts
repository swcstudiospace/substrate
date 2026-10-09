/**
 * The one boot refusal the server has: a self-contradictory identity config.
 *
 * A token value listed under two surfaces, or a `SUBSTRATE_TOKEN_*` variable
 * naming no surface, refuses to boot — one `[substrate] refused — …` line on
 * stderr naming variables only, then exit 78 (EX_CONFIG) so systemd stops
 * instead of crash-looping. The refusal happens in `loadConfig`, before any
 * store is touched, so these cases need no Postgres or Greptime.
 *
 * The child is spawned with an allowlisted environment (PATH, HOME and BUN_*
 * from the parent, plus only the variables the case names) and the no-env-file
 * server argv, so neither the developer's process env nor a checkout `.env`
 * file can leak in — least of all a real token.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const ENTRY = join(ROOT, "packages", "mcp-server", "src", "index.ts");

/**
 * The server spawn argv: Bun without env-file autoload, the checkout entry
 * point. `scripts/rehearsal.ts` builds the same argv for the Phase 16
 * harness; without the flag Bun would autoload a checkout `.env` file into
 * the child's environment and the refusal below could read values the test
 * never passed.
 */
function serverArgv(): string[] {
	return [process.execPath, "--no-env-file", ENTRY];
}

function allowlistedEnv(extra: Record<string, string>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of ["PATH", "HOME"]) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("BUN_") && value !== undefined) env[key] = value;
	}
	return { ...env, ...extra };
}

async function spawnServer(env: Record<string, string>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const child = Bun.spawn(serverArgv(), { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

describe("a contradictory identity config refuses boot", () => {
	test("one value under two surfaces exits 78 naming both variables, never the value", async () => {
		const result = await spawnServer(
			allowlistedEnv({ SUBSTRATE_TOKEN_HERMES: "tok-h1, tok-both", SUBSTRATE_TOKEN_CURSOR: "tok-c1, tok-both" }),
		);

		expect(result.exitCode).toBe(78);
		expect(result.stderr.startsWith("[substrate] refused")).toBe(true);
		expect(result.stderr).toContain("SUBSTRATE_TOKEN_HERMES");
		expect(result.stderr).toContain("SUBSTRATE_TOKEN_CURSOR");
		expect(`${result.stdout}\n${result.stderr}`).not.toContain("tok-both");
	});

	test("a variable naming no surface exits 78 naming it, never the value", async () => {
		const result = await spawnServer(allowlistedEnv({ SUBSTRATE_TOKEN_DESK_GATEWAY: "tok-gw" }));

		expect(result.exitCode).toBe(78);
		expect(result.stderr.startsWith("[substrate] refused")).toBe(true);
		expect(result.stderr).toContain("SUBSTRATE_TOKEN_DESK_GATEWAY");
		expect(`${result.stdout}\n${result.stderr}`).not.toContain("tok-gw");
	});
});

describe("a consistent identity config boots past the refusal", () => {
	test("the spawn carries --no-env-file and a valid env never prints the refused marker", async () => {
		expect(serverArgv()).toContain("--no-env-file");

		const child = Bun.spawn(serverArgv(), {
			cwd: ROOT,
			env: allowlistedEnv({ SUBSTRATE_TOKEN_HERMES: "tok-ok", SUBSTRATE_PORT: "0" }),
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
			const decoder = new TextDecoder();
			let out = "";
			let listening = false;
			try {
				const deadline = Date.now() + 15_000;
				while (Date.now() < deadline) {
					const { done, value } = await reader.read();
					if (value) out += decoder.decode(value, { stream: true });
					if (out.includes("listening on")) {
						listening = true;
						break;
					}
					if (done) break;
				}
			} finally {
				reader.releaseLock();
			}
			expect(listening).toBe(true);
		} finally {
			child.kill();
			await child.exited;
		}
		const stderr = await new Response(child.stderr).text();
		expect(stderr).not.toContain("[substrate] refused");
	});
});
