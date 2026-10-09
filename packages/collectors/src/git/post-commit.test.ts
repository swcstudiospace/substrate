/**
 * The post-commit hook stays fail-open and says when the substrate refused the emit.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(import.meta.dir, "post-commit");

async function repoWithCommit(subject: string): Promise<string> {
	const repo = mkdtempSync(join(tmpdir(), "substrate-hook-"));
	mkdirSync(repo, { recursive: true });
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

function listen(status: number, error: string): Promise<{ url: string; bodies: string[]; auths: Array<string | null>; close: () => void }> {
	const bodies: string[] = [];
	const auths: Array<string | null> = [];
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		bodies.push(Buffer.concat(chunks).toString("utf8"));
		auths.push(req.headers.authorization ?? null);
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify({ error }));
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve({
				url: `http://127.0.0.1:${port}`,
				bodies,
				auths,
				close: () => server.close(),
			});
		});
	});
}

async function runHook(repo: string, env: Record<string, string>): Promise<{ exitCode: number; stderr: string }> {
	const child = Bun.spawn(["bash", HOOK], {
		cwd: repo,
		env: { ...process.env, SUBSTRATE_HOOK_WAIT: "1", ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	return { exitCode, stderr };
}

describe("post-commit", () => {
	test("prints one stderr line on refusal and still exits 0, without the payload", async () => {
		const subject = "payload-secret-marker";
		const repo = await repoWithCommit(subject);
		const server = await listen(400, "unknown kind: nope");
		try {
			const result = await runHook(repo, { SUBSTRATE_URL: server.url, SUBSTRATE_TIMEOUT_MS: "1000" });

			expect(result.exitCode).toBe(0);
			const lines = result.stderr.split("\n").filter((line) => line.length > 0);
			expect(lines).toEqual(["[substrate] post-commit emit refused: status=400 error=unknown kind: nope"]);
			expect(result.stderr).not.toContain(subject);
			expect(server.bodies[0]).toContain(subject);
		} finally {
			server.close();
		}
	});

	test("an accepted emit prints nothing", async () => {
		const repo = await repoWithCommit("landed");
		const server = await listen(202, "");
		try {
			const result = await runHook(repo, { SUBSTRATE_URL: server.url, SUBSTRATE_TIMEOUT_MS: "1000" });

			expect(result.exitCode).toBe(0);
			expect(result.stderr).toBe("");
		} finally {
			server.close();
		}
	});

	test("an unreachable substrate is one line and exit 0", async () => {
		const repo = await repoWithCommit("offline");
		const result = await runHook(repo, {
			SUBSTRATE_URL: "http://127.0.0.1:1",
			SUBSTRATE_TIMEOUT_MS: "300",
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr.trim()).toBe("[substrate] post-commit emit refused: status=0 error=unreachable");
		expect(result.stderr).not.toContain("offline");
	});

	test("SSH and HTTPS origins drop a trailing .git", async () => {
		const repo = await repoWithCommit("slug");
		const server = await listen(202, "");
		const git = (args: string[]) => {
			const result = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", ...args], { cwd: repo });
			if (result.exitCode !== 0) throw new Error(result.stderr.toString());
		};
		try {
			git(["remote", "add", "origin", "git@github.com:swcstudiospace/agent-substrate.git"]);
			await runHook(repo, { SUBSTRATE_URL: server.url, SUBSTRATE_TIMEOUT_MS: "1000" });
			git(["remote", "set-url", "origin", "https://github.com/swcstudiospace/agent-substrate.git"]);
			await runHook(repo, { SUBSTRATE_URL: server.url, SUBSTRATE_TIMEOUT_MS: "1000" });

			const slugs = server.bodies.map((body) => (JSON.parse(body) as { repo?: string }).repo);
			expect(slugs).toEqual(["swcstudiospace/agent-substrate", "swcstudiospace/agent-substrate"]);
		} finally {
			server.close();
		}
	});

	test("a headless refusal is appended to the hook log and the hook still returns", async () => {
		const subject = "payload-secret-marker";
		const repo = await repoWithCommit(subject);
		const server = await listen(400, "unknown kind: nope");
		const log = join(repo, "hook.log");
		const started = Date.now();
		try {
			// setsid drops the controlling terminal, which is the branch that used
			// to discard the line. The hook must not inherit this process's pipes.
			const child = Bun.spawn(["setsid", "bash", HOOK], {
				cwd: repo,
				env: {
					...process.env,
					SUBSTRATE_URL: server.url,
					SUBSTRATE_TIMEOUT_MS: "1000",
					SUBSTRATE_HOOK_WAIT: "",
					SUBSTRATE_HOOK_LOG: log,
				},
				stdout: "ignore",
				stderr: "ignore",
			});
			const exitCode = await child.exited;
			expect(exitCode).toBe(0);
			expect(Date.now() - started).toBeLessThan(1500);

			const deadline = Date.now() + 2000;
			let text = "";
			while (Date.now() < deadline) {
				text = await Bun.file(log).text().catch(() => "");
				if (text.includes("status=400")) break;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			expect(text).toContain("[substrate] post-commit emit refused: status=400 error=unknown kind: nope");
			expect(text).not.toContain(subject);
		} finally {
			server.close();
		}
	});

	test("a read-only hook log does not drop the commit event", async () => {
		const repo = await repoWithCommit("readonly-log");
		const server = await listen(202, "");
		const log = join(repo, "hook.log");
		writeFileSync(log, "");
		chmodSync(log, 0o444);
		try {
			const child = Bun.spawn(["setsid", "bash", HOOK], {
				cwd: repo,
				env: {
					...process.env,
					SUBSTRATE_URL: server.url,
					SUBSTRATE_TIMEOUT_MS: "1000",
					SUBSTRATE_HOOK_WAIT: "",
					SUBSTRATE_HOOK_LOG: log,
				},
				stdout: "ignore",
				stderr: "ignore",
			});
			expect(await child.exited).toBe(0);
			const deadline = Date.now() + 2000;
			while (Date.now() < deadline && server.bodies.length === 0) {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			expect(server.bodies.length).toBeGreaterThan(0);
			expect(server.bodies[0]).toContain("readonly-log");
		} finally {
			server.close();
		}
	});

	test("a hook log that is a directory does not drop the commit event", async () => {
		// Opening a directory for append fails for every user, including root.
		// chmod 0444 does not: root can still write that file, so that case
		// never exercises the fallback.
		const repo = await repoWithCommit("directory-log");
		const server = await listen(202, "");
		const log = join(repo, "hook-log-dir");
		mkdirSync(log);
		try {
			const child = Bun.spawn(["setsid", "bash", HOOK], {
				cwd: repo,
				env: {
					...process.env,
					SUBSTRATE_URL: server.url,
					SUBSTRATE_TIMEOUT_MS: "1000",
					SUBSTRATE_HOOK_WAIT: "",
					SUBSTRATE_HOOK_LOG: log,
				},
				stdout: "ignore",
				stderr: "ignore",
			});
			expect(await child.exited).toBe(0);
			const deadline = Date.now() + 2000;
			while (Date.now() < deadline && server.bodies.length === 0) {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			expect(server.bodies.length).toBeGreaterThan(0);
			expect(server.bodies[0]).toContain("directory-log");
		} finally {
			server.close();
		}
	});

	test("returns before the substrate answers when it is not told to wait", async () => {
		const repo = await repoWithCommit("slow");
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const server = createServer(async (_req, res) => {
			await held;
			res.writeHead(202, { "content-type": "application/json" });
			res.end("{}");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		const started = Date.now();
		try {
			const child = Bun.spawn(["bash", HOOK], {
				cwd: repo,
				env: {
					...process.env,
					SUBSTRATE_URL: `http://127.0.0.1:${port}`,
					SUBSTRATE_TIMEOUT_MS: "5000",
					SUBSTRATE_HOOK_WAIT: "",
				},
				stdout: "ignore",
				stderr: "ignore",
			});
			const exitCode = await child.exited;
			expect(exitCode).toBe(0);
			expect(Date.now() - started).toBeLessThan(1500);
		} finally {
			release();
			server.close();
		}
	});

	test("resolves the bearer from the per-surface tokens-dir file", async () => {
		const repo = await repoWithCommit("tokens-dir bearer");
		const dir = mkdtempSync(join(tmpdir(), "hook-tokens-"));
		writeFileSync(join(dir, "cursor"), "hook-cursor-file\n");
		const server = await listen(202, "");
		try {
			const result = await runHook(repo, {
				SUBSTRATE_URL: server.url,
				SUBSTRATE_TIMEOUT_MS: "1000",
				SUBSTRATE_TOKEN: "",
				SUBSTRATE_TOKENS_DIR: dir,
				SUBSTRATE_SURFACE: "cursor",
			});
			expect(result.exitCode).toBe(0);
			expect(server.auths).toEqual(["Bearer hook-cursor-file"]);
			expect(result.stderr).not.toContain("hook-cursor-file");
		} finally {
			server.close();
		}
	});

	test("the environment value wins over the tokens-dir file", async () => {
		const repo = await repoWithCommit("env wins");
		const dir = mkdtempSync(join(tmpdir(), "hook-tokens-"));
		writeFileSync(join(dir, "cursor"), "hook-cursor-file\n");
		const server = await listen(202, "");
		try {
			const result = await runHook(repo, {
				SUBSTRATE_URL: server.url,
				SUBSTRATE_TIMEOUT_MS: "1000",
				SUBSTRATE_TOKEN: "hook-env-value",
				SUBSTRATE_TOKENS_DIR: dir,
				SUBSTRATE_SURFACE: "cursor",
			});
			expect(result.exitCode).toBe(0);
			expect(server.auths).toEqual(["Bearer hook-env-value"]);
		} finally {
			server.close();
		}
	});

	test("the token-file variable sits between env and tokens dir", async () => {
		const repo = await repoWithCommit("token file bearer");
		const dir = mkdtempSync(join(tmpdir(), "hook-tokens-"));
		writeFileSync(join(dir, "cursor"), "hook-cursor-file\n");
		const file = join(dir, "agent.token");
		writeFileSync(file, "hook-file-value\n");
		const server = await listen(202, "");
		try {
			const result = await runHook(repo, {
				SUBSTRATE_URL: server.url,
				SUBSTRATE_TIMEOUT_MS: "1000",
				SUBSTRATE_TOKEN: "",
				SUBSTRATE_TOKEN_FILE: file,
				SUBSTRATE_TOKENS_DIR: dir,
				SUBSTRATE_SURFACE: "cursor",
			});
			expect(result.exitCode).toBe(0);
			expect(server.auths).toEqual(["Bearer hook-file-value"]);
		} finally {
			server.close();
		}
	});

	test("an unsafe surface never reaches the tokens dir", async () => {
		const repo = await repoWithCommit("unsafe surface");
		const dir = mkdtempSync(join(tmpdir(), "hook-tokens-"));
		writeFileSync(join(dir, "cursor"), "hook-cursor-file\n");
		const server = await listen(202, "");
		try {
			const result = await runHook(repo, {
				SUBSTRATE_URL: server.url,
				SUBSTRATE_TIMEOUT_MS: "1000",
				SUBSTRATE_TOKEN: "",
				SUBSTRATE_TOKENS_DIR: dir,
				SUBSTRATE_SURFACE: "../cursor",
			});
			expect(result.exitCode).toBe(0);
			expect(server.auths).toEqual([null]);
		} finally {
			server.close();
		}
	});
});
