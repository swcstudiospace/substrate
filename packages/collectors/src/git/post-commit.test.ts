/**
 * The post-commit hook stays fail-open and says when the substrate refused the emit.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

function listen(status: number, error: string): Promise<{ url: string; bodies: string[]; close: () => void }> {
	const bodies: string[] = [];
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		bodies.push(Buffer.concat(chunks).toString("utf8"));
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify({ error }));
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve({
				url: `http://127.0.0.1:${port}`,
				bodies,
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
});
