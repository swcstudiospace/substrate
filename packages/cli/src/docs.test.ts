/**
 * `substrate docs ingest`, against a stub of the route over a real socket.
 *
 * Covers what the CLI sends (snake_case keys, the bearer), what it refuses
 * before posting (no token, a VM guest, a bad file, a page over the cap) and
 * how it reports each status. The engine-cap pin reads both files as text:
 * importing the engine module from this package would itself break the
 * substrate-only door the store lock enforces.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	test("posts the page with snake_case keys and the bearer, and prints the status", async () => {
		stub.seen = [];
		const name = writePage("planes.md", "The substrate is the only door.\n");
		const run = deps();
		const code = await runDocs(
			["ingest", "--dataset", "agent-substrate", "--path", name, "--source-url", "https://example.com/planes"],
			run,
		);
		expect(code).toBe(0);
		expect(stub.seen).toHaveLength(1);
		expect(stub.seen[0]?.authorization).toBe("Bearer tok-test");
		expect(stub.seen[0]?.path).toBe("/docs/ingest");
		const body = stub.seen[0]?.body;
		if (body === null || typeof body !== "object" || !("pages" in body) || !Array.isArray(body.pages)) {
			throw new Error("the CLI did not post pages");
		}
		expect(body).toMatchObject({ dataset: "agent-substrate" });
		expect(body.pages[0]).toMatchObject({ path: name, source_url: "https://example.com/planes" });
	});

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

	test("the CLI path normalization mirrors the engine gate", async () => {
		const root = join(import.meta.dir, "..", "..", "..");
		const cli = await Bun.file(join(root, "packages", "cli", "src", "docs.ts")).text();
		const engine = await Bun.file(join(root, "packages", "mcp-server", "src", "docs-ingest.ts")).text();
		expect(cli).toContain("if (parts.length === 0) return null;");
		expect(engine).toContain("if (parts.length === 0) return null;");
	});

	test("the CLI page cap equals the engine page cap", async () => {
		const root = join(import.meta.dir, "..", "..", "..");
		const cli = await Bun.file(join(root, "packages", "cli", "src", "docs.ts")).text();
		const engine = await Bun.file(join(root, "packages", "mcp-server", "src", "docs-ingest.ts")).text();
		expect(cli).toContain("1_000_000");
		expect(engine).toContain("1_000_000");
	});
});
