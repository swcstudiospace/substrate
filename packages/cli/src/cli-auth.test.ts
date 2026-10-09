import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const CLI = join(ROOT, "packages/cli/src/index.ts");

/**
 * A recording stub, reached over real HTTP.
 *
 * Unlike the lessons stub it never refuses: it remembers every authorization
 * header it saw so the tests can say which bearer the real CLI sent.
 */
class RecordingStub {
	seen: Array<string | null> = [];
	readonly server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => this.handle(request) });
	readonly url = `http://127.0.0.1:${this.server.port}`;

	reset(): void {
		this.seen = [];
	}

	private async handle(request: Request): Promise<Response> {
		this.seen.push(request.headers.get("authorization"));
		await request.text().catch(() => "");
		return Response.json({ stored: true }, { status: 202 });
	}
}

const stub = new RecordingStub();

afterAll(() => {
	stub.server.stop(true);
});

/**
 * Spawned asynchronously, never with `spawnSync`.
 *
 * The stub listens in *this* process, and `spawnSync` blocks this event
 * loop — so the CLI's request would never be served and the command would
 * report the substrate unreachable. The env is an allowlist, never
 * `...process.env`, so an operator token cannot leak into the child.
 */
async function runCli(args: string[], env: Record<string, string>) {
	const child = Bun.spawn(["bun", CLI, ...args], {
		cwd: ROOT,
		env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

function emitArgs(): string[] {
	return ["emit", "--kind", "note", "--summary", "x", "--surface", "cursor"];
}

describe("CLI bearer", () => {
	test("sends the tokens-dir bearer for the command surface", async () => {
		const dir = mkdtempSync(join(tmpdir(), "auth-"));
		writeFileSync(join(dir, "cursor"), "tok-dir\n");
		stub.reset();
		const { exitCode, stdout, stderr } = await runCli(emitArgs(), { SUBSTRATE_URL: stub.url, SUBSTRATE_TOKENS_DIR: dir });
		expect(exitCode).toBe(0);
		expect(stub.seen).toEqual(["Bearer tok-dir"]);
		expect(stdout + stderr).not.toContain("tok-dir");
	});

	test("the env bearer wins over the tokens dir", async () => {
		const dir = mkdtempSync(join(tmpdir(), "auth-"));
		writeFileSync(join(dir, "cursor"), "tok-dir\n");
		stub.reset();
		const { exitCode } = await runCli(emitArgs(), {
			SUBSTRATE_URL: stub.url,
			SUBSTRATE_TOKENS_DIR: dir,
			SUBSTRATE_TOKEN: "tok-env",
		});
		expect(exitCode).toBe(0);
		expect(stub.seen).toEqual(["Bearer tok-env"]);
	});

	test("absent everywhere sends no header", async () => {
		const dir = mkdtempSync(join(tmpdir(), "auth-"));
		stub.reset();
		const { exitCode } = await runCli(emitArgs(), { SUBSTRATE_URL: stub.url, SUBSTRATE_TOKENS_DIR: dir });
		expect(exitCode).toBe(0);
		expect(stub.seen).toEqual([null]);
	});
});
