/**
 * The post-commit hook and the event spool: the hook only ever appends. It
 * parks a commit event after a retryable failure when `SUBSTRATE_EVENT_SPOOL`
 * is on and the installer gave it the collectors directory, and in every other
 * case it behaves as it always did and creates no file.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(import.meta.dir, "post-commit");
const COLLECTORS_SRC = join(import.meta.dir, "..");
// Runtime-assembled so no credential shape sits in source (redact-lock rule 4).
const decoy = `ghp_${"a1B2c3D4e5".repeat(4)}`;

function repoWithCommit(subject: string): string {
	const repo = mkdtempSync(join(tmpdir(), "substrate-hook-spool-"));
	const git = (args: string[]) => {
		const result = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", ...args], {
			cwd: repo,
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "Hook Test",
				GIT_AUTHOR_EMAIL: "hook@example.com",
				GIT_COMMITTER_NAME: "Hook Test",
				GIT_COMMITTER_EMAIL: "hook@example.com",
			},
		});
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	};
	git(["init"]);
	writeFileSync(join(repo, "readme.txt"), "hello\n");
	git(["add", "readme.txt"]);
	git(["commit", "-m", subject]);
	return repo;
}

interface Stub {
	url: string;
	paths: string[];
	headers: Array<string | null>;
	close: () => void;
}

function serve(status: number): Stub {
	const paths: string[] = [];
	const headers: Array<string | null> = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: (req) => {
			paths.push(new URL(req.url).pathname);
			headers.push(req.headers.get("x-substrate-replay"));
			return Response.json({ error: "down", stored: false }, { status });
		},
	});
	return { url: `http://127.0.0.1:${server.port}`, paths, headers, close: () => void server.stop(true) };
}

async function runHook(repo: string, env: Record<string, string>): Promise<number> {
	const child = Bun.spawn(["bash", HOOK], {
		cwd: repo,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: process.env.HOME ?? "",
			SUBSTRATE_HOOK_WAIT: "1",
			SUBSTRATE_TOKENS_DIR: mkdtempSync(join(tmpdir(), "hook-spool-tokens-")),
			...env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
	return await child.exited;
}

function spooled(stateDir: string): Array<{ key: string; collector: string; event: Record<string, unknown> }> {
	const path = join(stateDir, "event-spool.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as { key: string; collector: string; event: Record<string, unknown> });
}

describe("post-commit with the spool", () => {
	test("a 5xx parks the commit event once, redacted and keyed, and the hook never replays or probes", async () => {
		const server = serve(503);
		const stateDir = mkdtempSync(join(tmpdir(), "hook-spool-state-"));
		try {
			const repo = repoWithCommit(`fix ${decoy}`);

			const code = await runHook(repo, {
				SUBSTRATE_URL: server.url,
				SUBSTRATE_STATE_DIR: stateDir,
				SUBSTRATE_EVENT_SPOOL: "on",
				SUBSTRATE_COLLECTORS_SRC: COLLECTORS_SRC,
			});

			expect(code).toBe(0);
			expect(server.paths).toEqual(["/events"]);
			expect(server.headers).toEqual([null]);
			const [entry] = spooled(stateDir);
			expect(spooled(stateDir)).toHaveLength(1);
			expect(entry?.collector).toBe("git-post-commit");
			expect(entry?.event.kind).toBe("commit");
			expect(typeof entry?.event.ts).toBe("string");
			expect(readFileSync(join(stateDir, "event-spool.jsonl"), "utf8")).not.toContain(decoy);
		} finally {
			server.close();
		}
	});

	test("an unreachable substrate parks it too", async () => {
		const closed = serve(200);
		const url = closed.url;
		closed.close();
		const stateDir = mkdtempSync(join(tmpdir(), "hook-spool-state-"));

		const code = await runHook(repoWithCommit("unreachable"), {
			SUBSTRATE_URL: url,
			SUBSTRATE_STATE_DIR: stateDir,
			SUBSTRATE_EVENT_SPOOL: "on",
			SUBSTRATE_COLLECTORS_SRC: COLLECTORS_SRC,
		});

		expect(code).toBe(0);
		expect(spooled(stateDir)).toHaveLength(1);
	});

	test("a 4xx is a refusal: reported, never parked", async () => {
		const server = serve(400);
		const stateDir = mkdtempSync(join(tmpdir(), "hook-spool-state-"));
		try {
			await runHook(repoWithCommit("refused"), {
				SUBSTRATE_URL: server.url,
				SUBSTRATE_STATE_DIR: stateDir,
				SUBSTRATE_EVENT_SPOOL: "on",
				SUBSTRATE_COLLECTORS_SRC: COLLECTORS_SRC,
			});

			expect(spooled(stateDir)).toEqual([]);
		} finally {
			server.close();
		}
	});

	test("with the flag off, or an uninstalled copy without the collectors directory, a failure creates no file", async () => {
		const server = serve(503);
		const stateDir = mkdtempSync(join(tmpdir(), "hook-spool-state-"));
		try {
			await runHook(repoWithCommit("flag off"), {
				SUBSTRATE_URL: server.url,
				SUBSTRATE_STATE_DIR: stateDir,
				SUBSTRATE_COLLECTORS_SRC: COLLECTORS_SRC,
			});
			await runHook(repoWithCommit("not installed"), {
				SUBSTRATE_URL: server.url,
				SUBSTRATE_STATE_DIR: stateDir,
				SUBSTRATE_EVENT_SPOOL: "on",
			});

			expect(readdirSync(stateDir)).toEqual([]);
			expect(server.paths).toEqual(["/events", "/events"]);
		} finally {
			server.close();
		}
	});

	test("a state directory that cannot be written leaves the hook exiting 0", async () => {
		const server = serve(503);
		const blocker = join(mkdtempSync(join(tmpdir(), "hook-spool-blocker-")), "file");
		writeFileSync(blocker, "not a directory");
		try {
			const code = await runHook(repoWithCommit("unwritable"), {
				SUBSTRATE_URL: server.url,
				SUBSTRATE_STATE_DIR: join(blocker, "state"),
				SUBSTRATE_EVENT_SPOOL: "on",
				SUBSTRATE_COLLECTORS_SRC: COLLECTORS_SRC,
			});

			expect(code).toBe(0);
		} finally {
			server.close();
		}
	});
});
