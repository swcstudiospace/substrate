/**
 * `substrate docs ingest`, against a stub of the route over a real socket.
 *
 * Covers what the CLI sends (snake_case keys, the bearer), what it refuses
 * before posting (no token, a VM guest, a bad file, a page over the cap) and
 * how it reports each status. The engine-cap pin reads both files as text:
 * importing the engine module from this package would itself break the
 * substrate-only door the store lock enforces.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { runDocs, type DocsDeps } from "./docs.ts";

interface Seen {
	method: string;
	path: string;
	authorization: string | null;
	body: unknown;
}

/** The route, as far as the CLI can tell: one scripted reply, and a record of what was posted. */
class RouteStub {
	seen: Seen[] = [];
	reply: { status: number; body: unknown } = {
		status: 200,
		body: { ok: true, results: [{ status: "ingested", document_id: "doc-1" }], stripped_images: 0 },
	};
	readonly server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async (request) => {
			const raw = await request.text();
			let body: unknown = null;
			try {
				body = raw ? JSON.parse(raw) : null;
			} catch {
				body = raw;
			}
			this.seen.push({
				method: request.method,
				path: new URL(request.url).pathname,
				authorization: request.headers.get("authorization"),
				body,
			});
			return new Response(typeof this.reply.body === "string" ? this.reply.body : JSON.stringify(this.reply.body), {
				status: this.reply.status,
				headers: { "content-type": "application/json" },
			});
		},
	});
	readonly url = `http://127.0.0.1:${this.server.port}`;
}

const stub = new RouteStub();
const scratch = mkdtempSync(join(tmpdir(), "substrate-docs-cli-"));
beforeEach(() => {
	stub.seen = [];
	stub.reply = { status: 200, body: { ok: true, results: [{ status: "ingested", document_id: "doc-1" }], stripped_images: 0 } };
});
afterAll(() => {
	stub.server.stop(true);
	rmSync(scratch, { recursive: true, force: true });
});

function deps(over: Partial<DocsDeps> = {}): DocsDeps {
	const out: string[] = [];
	const err: string[] = [];
	return {
		url: stub.url,
		token: "tok-test",
		timeoutMs: 5000,
		cwd: scratch,
		out: (text) => out.push(text),
		err: (text) => err.push(text),
		vmGuest: false,
		...over,
	};
}

function writePage(name: string, body: string): string {
	const path = join(scratch, name);
	writeFileSync(path, body);
	return name;
}

describe("substrate docs ingest", () => {

	test("refuses without a bearer before anything is posted", async () => {
		stub.seen = [];
		const name = writePage("anon.md", "Hello.\n");
		const run = deps({ token: undefined });
		const code = await runDocs(
			["ingest", "--dataset", "agent-substrate", "--path", name, "--source-url", "https://example.com/anon"],
			run,
		);
		expect(code).toBe(1);
		expect(stub.seen).toHaveLength(0);
	});

	test("refuses on a VM guest before anything is posted", async () => {
		stub.seen = [];
		const name = writePage("guest.md", "Hello.\n");
		const run = deps({ vmGuest: true });
		const code = await runDocs(
			["ingest", "--dataset", "agent-substrate", "--path", name, "--source-url", "https://example.com/guest"],
			run,
		);
		expect(code).toBe(1);
		expect(stub.seen).toHaveLength(0);
	});

	test("refuses a file over the page cap before posting", async () => {
		stub.seen = [];
		const name = writePage("huge.md", `x${"y".repeat(1_000_000)}`);
		const run = deps();
		const code = await runDocs(
			["ingest", "--dataset", "agent-substrate", "--path", name, "--source-url", "https://example.com/huge"],
			run,
		);
		expect(code).toBe(1);
		expect(stub.seen).toHaveLength(0);
	});

	test("reports a server refusal as exit 1", async () => {
		stub.reply = { status: 400, body: { ok: false, refused: true, reason: "secret-findings" } };
		try {
			const name = writePage("bad.md", "Hello.\n");
			const run = deps();
			const code = await runDocs(
				["ingest", "--dataset", "agent-substrate", "--path", name, "--source-url", "https://example.com/bad"],
				run,
			);
			expect(code).toBe(1);
		} finally {
			stub.reply = {
				status: 200,
				body: { ok: true, results: [{ status: "ingested", document_id: "doc-1" }], stripped_images: 0 },
			};
		}
	});

	test("refuses a dot-segment escape before anything is posted", async () => {
		stub.seen = [];
		writePage("outside.md", "Secrets.\n");
		const run = deps();
		const code = await runDocs(
			["ingest", "--dataset", "agent-substrate", "--path", "docs/../../outside.md", "--source-url", "https://example.com/o"],
			run,
		);
		expect(code).toBe(1);
		expect(stub.seen).toHaveLength(0);
	});

	test("posts the normalized path with the resolved real path", async () => {
		stub.seen = [];
		const name = writePage("real.md", "Hello.\n");
		const run = deps();
		const code = await runDocs(
			["ingest", "--dataset", "agent-substrate", "--path", `docs/../${name}`, "--source-url", "https://example.com/r"],
			run,
		);
		expect(code).toBe(0);
		const body = stub.seen[0]?.body;
		if (body === null || typeof body !== "object" || !("pages" in body) || !Array.isArray(body.pages)) {
			throw new Error("the CLI did not post pages");
		}
		expect(body.pages[0]).toMatchObject({ path: name });
		expect(body.pages[0]).toHaveProperty("real_path");
	});


});

describe("substrate docs refresh", () => {
	function git(dir: string, ...args: string[]): string {
		return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 30_000 }).trim();
	}

	function mkRepo(name: string, files: Record<string, string>): { dir: string; commit: string } {
		const abs = join(scratch, name);
		mkdirSync(abs, { recursive: true });
		for (const [rel, body] of Object.entries(files)) {
			mkdirSync(join(abs, dirname(rel)), { recursive: true });
			writeFileSync(join(abs, rel), body);
		}
		git(abs, "init", "-q");
		git(abs, "add", "-A");
		git(abs, "-c", "user.name=t", "-c", "user.email=t@t.t", "commit", "-qm", "seed");
		return { dir: name, commit: git(abs, "rev-parse", "HEAD") };
	}

	test("posts committed bytes, ignoring dirty and untracked worktree files", async () => {
		stub.seen = [];
		const repo = mkRepo("crepo-1", { "a.md": "Committed alpha.\n" });
		writeFileSync(join(scratch, repo.dir, "a.md"), "Dirty alpha.\n");
		writeFileSync(join(scratch, repo.dir, "b.md"), "Untracked beta.\n");
		const code = await runDocs(
			["refresh", "--dataset", "agent-substrate", "--commit", repo.commit, "--dir", repo.dir, "--roots", "a.md,b.md"],
			deps(),
		);
		expect(code).toBe(0);
		expect(stub.seen).toHaveLength(1);
		expect(stub.seen[0]?.authorization).toBe("Bearer tok-test");
		expect(stub.seen[0]?.path).toBe("/docs/ingest");
		const body = stub.seen[0]?.body;
		if (body === null || typeof body !== "object" || !("pages" in body) || !Array.isArray(body.pages)) {
			throw new Error("the CLI did not post pages");
		}
		expect(body).toMatchObject({
			dataset: "agent-substrate",
			commit: repo.commit,
			session_id: `docs-refresh:${repo.commit}`,
			refresh: { id: `repo-merge:agent-substrate:${repo.commit}`, part: 1, parts: 1, trigger: "repo-merge" },
		});
		expect(body.pages).toHaveLength(1);
		expect(body.pages[0]).toMatchObject({ path: "a.md", source_url: "agent-substrate://a.md", body: "Committed alpha.\n" });
	});

	test("a committed symlink refuses the whole run before any post", async () => {
		stub.seen = [];
		const abs = join(scratch, "crepo-2");
		mkdirSync(abs, { recursive: true });
		writeFileSync(join(abs, "a.md"), "Alpha.\n");
		symlinkSync(join(abs, "a.md"), join(abs, "link.md"));
		git(abs, "init", "-q");
		git(abs, "add", "-A");
		git(abs, "-c", "user.name=t", "-c", "user.email=t@t.t", "commit", "-qm", "seed");
		const commit = git(abs, "rev-parse", "HEAD");
		const code = await runDocs(
			["refresh", "--dataset", "agent-substrate", "--commit", commit, "--dir", "crepo-2", "--roots", "a.md,link.md"],
			deps(),
		);
		expect(code).toBe(1);
		expect(stub.seen).toHaveLength(0);
	});

	test("a directory outside a checkout is refused, not posted unverified", async () => {
		stub.seen = [];
		mkdirSync(join(scratch, "norepo"), { recursive: true });
		writeFileSync(join(scratch, "norepo", "a.md"), "Alpha.\n");
		const code = await runDocs(
			["refresh", "--dataset", "agent-substrate", "--commit", "abc123", "--dir", "norepo"],
			deps(),
		);
		expect(code).toBe(1);
		expect(stub.seen).toHaveLength(0);
	});

	test("a checkout moved past --commit is refused before anything is posted", async () => {
		stub.seen = [];
		const repo = mkRepo("crepo-3", { "a.md": "Alpha.\n" });
		const abs = join(scratch, repo.dir);
		writeFileSync(join(abs, "b.md"), "Beta.\n");
		git(abs, "add", "-A");
		git(abs, "-c", "user.name=t", "-c", "user.email=t@t.t", "commit", "-qm", "second");
		const code = await runDocs(
			["refresh", "--dataset", "agent-substrate", "--commit", repo.commit, "--dir", repo.dir],
			deps(),
		);
		expect(code).toBe(1);
		expect(stub.seen).toHaveLength(0);
	});

	test("refuses without a bearer or on a guest before anything is posted", async () => {
		stub.seen = [];
		mkdirSync(join(scratch, "refresh-2"), { recursive: true });
		writeFileSync(join(scratch, "refresh-2", "a.md"), "Alpha.\n");
		const anonymous = await runDocs(
			["refresh", "--dataset", "agent-substrate", "--commit", "abc123", "--dir", "refresh-2"],
			deps({ token: undefined }),
		);
		expect(anonymous).toBe(1);
		const guest = await runDocs(
			["refresh", "--dataset", "agent-substrate", "--commit", "abc123", "--dir", "refresh-2"],
			deps({ vmGuest: true }),
		);
		expect(guest).toBe(1);
		expect(stub.seen).toHaveLength(0);
	});

	test("refuses an over-cap committed blob naming it, posting nothing", async () => {
		stub.seen = [];
		const repo = mkRepo("crepo-4", { "a.md": "Alpha.\n", "huge.md": `x${"y".repeat(1_000_000)}` });
		const code = await runDocs(
			["refresh", "--dataset", "agent-substrate", "--commit", repo.commit, "--dir", repo.dir, "--roots", "a.md,huge.md"],
			deps(),
		);
		expect(code).toBe(1);
		expect(stub.seen).toHaveLength(0);
	});

	test("requires dataset, commit and dir", async () => {
		stub.seen = [];
		expect(await runDocs(["refresh", "--commit", "abc123", "--dir", "refresh-4"], deps())).toBe(1);
		expect(await runDocs(["refresh", "--dataset", "agent-substrate", "--dir", "refresh-4"], deps())).toBe(1);
		expect(await runDocs(["refresh", "--dataset", "agent-substrate", "--commit", "abc123"], deps())).toBe(1);
		expect(stub.seen).toHaveLength(0);
	});

});
