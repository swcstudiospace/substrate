/**
 * `substrate docs ...` through the real command (`index.ts` dispatches at
 * import time, so these spawn it). A loopback stub answers what `/docs/ingest`
 * answers; slugs, commits and tokens are inert fixtures. No test touches a
 * live substrate, and the refresh smoke reads a fixture repo only.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const CLI = join(import.meta.dir, "index.ts");
const COMMIT = "a".repeat(40);
const SLUG = "example/guide";

const scratch = mkdtempSync(join(tmpdir(), "substrate-docs-index-"));
afterAll(() => {
	stub.server.stop(true);
	rmSync(scratch, { recursive: true, force: true });
});

interface Seen {
	path: string;
	authorization: string | null;
	body: Record<string, unknown>;
}

/** `/docs/ingest` as far as the CLI can tell: one scripted reply plus a record. */
class Stub {
	seen: Seen[] = [];
	reply: { status: number; body: unknown } = { status: 200, body: { status: "uploaded" } };
	readonly server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async (request) => {
			const raw = await request.text();
			const parsed: unknown = raw ? JSON.parse(raw) : {};
			const body: Record<string, unknown> = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? { ...parsed } : {};
			this.seen.push({ path: new URL(request.url).pathname, body, authorization: request.headers.get("authorization") });
			return new Response(JSON.stringify(this.reply.body), {
				status: this.reply.status,
				headers: { "content-type": "application/json" },
			});
		},
	});
	readonly url = `http://127.0.0.1:${this.server.port}`;
}

const stub = new Stub();

const UPLOADED = {
	status: "uploaded",
	datasetId: "ds-9",
	contentSha256: "0".repeat(64),
	sections: 1,
	redactions: 0,
	imagesStripped: 0,
	documentIds: ["doc-1"],
};

async function spawn(args: string[], env: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number }> {
	const proc = Bun.spawn(["bun", CLI, ...args], {
		env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { stdout, stderr, code };
}

function page(name: string, content: string): string {
	const path = join(scratch, name);
	writeFileSync(path, content);
	return path;
}

const base = (file: string, extra: string[] = []) => [
	"docs",
	"ingest",
	"--dataset",
	"guide",
	"--file",
	file,
	"--source-url",
	`https://${"github.com"}/${SLUG}/blob/${COMMIT}/docs/x.md`,
	"--commit",
	COMMIT,
	...extra,
];

function fixtureRepo(files: Record<string, string>): { dir: string; commit: string } {
	const dir = mkdtempSync(join(scratch, "repo-"));
	const run = (args: string[]): string => {
		const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
		if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
		return (result.stdout ?? "").trim();
	};
	run(["init", "-b", "main"]);
	run(["config", "user.email", "fixture@example.com"]);
	run(["config", "user.name", "fixture"]);
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(dir, dirname(path)), { recursive: true });
		writeFileSync(join(dir, path), content);
		run(["add", path]);
	}
	run(["commit", "-m", "fixture"]);
	return { dir, commit: run(["rev-parse", "HEAD"]) };
}

describe("substrate docs ingest", () => {
	test("a dry_run prints the key=value shape with the token header and exits 0", async () => {
		stub.seen = [];
		stub.reply = { status: 200, body: { ...UPLOADED, status: "dry_run", wouldUpload: true } };
		const result = await spawn(base(page("dry.md", "# Hi\n"), ["--dry-run"]), {
			SUBSTRATE_URL: stub.url,
			SUBSTRATE_TOKEN: "tok-real",
		});
		expect(result.code).toBe(0);
		for (const key of ["status=dry_run", "dataset_id=ds-9", "content_sha256=", "sections=1", "would_upload=true"]) {
			expect(result.stdout).toContain(key);
		}
		expect(stub.seen).toHaveLength(1);
		expect(stub.seen[0]?.authorization).toBe("Bearer tok-real");
		expect(stub.seen[0]?.path).toBe("/docs/ingest");
	});

	test("a file over the cap is refused before anything is posted", async () => {
		stub.seen = [];
		stub.reply = { status: 200, body: UPLOADED };
		const result = await spawn(base(page("big.md", "x".repeat(256 * 1024 + 1))), {
			SUBSTRATE_URL: stub.url,
			SUBSTRATE_TOKEN: "tok-real",
		});
		expect(result.code).toBe(1);
		expect(result.stdout).toContain("status=refused");
		expect(stub.seen).toHaveLength(0);
	});

	test("a refusal prints findings line+rule and exits 1; a 5xx and an unreachable server exit 1", async () => {
		stub.reply = { status: 400, body: { status: "refused", reason: "secret", findings: [{ line: 2, rule: "pem" }] } };
		const refused = await spawn(base(page("r.md", "# Hi\n")), { SUBSTRATE_URL: stub.url, SUBSTRATE_TOKEN: "tok-real" });
		expect(refused.code).toBe(1);
		expect(refused.stdout).toContain("status=refused");
		expect(refused.stdout).toContain("finding=2 pem");

		stub.reply = { status: 502, body: { status: "failed", reason: "ragflow-error", message: "bad" } };
		const failed = await spawn(base(page("f.md", "# Hi\n")), { SUBSTRATE_URL: stub.url, SUBSTRATE_TOKEN: "tok-real" });
		expect(failed.code).toBe(1);
		expect(failed.stdout).toContain("status=failed");

		const down = await spawn(base(page("d.md", "# Hi\n")), { SUBSTRATE_URL: "http://127.0.0.1:1", SUBSTRATE_TOKEN: "tok-real" });
		expect(down.code).toBe(1);
		expect(down.stdout).toContain("status=failed");
	});

	test("no token exits 1 without posting", async () => {
		stub.seen = [];
		stub.reply = { status: 200, body: UPLOADED };
		const result = await spawn(base(page("n.md", "# Hi\n")), { SUBSTRATE_URL: stub.url });
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("SUBSTRATE_TOKEN is not set");
		expect(stub.seen).toHaveLength(0);
	});
});

describe("substrate docs refresh", () => {
	test("dispatches refresh over HTTP and exits 0 when the version cuts", async () => {
		const repo = fixtureRepo({ "docs/a.md": "# A\n" });
		stub.seen = [];
		const refreshing = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: async (request) => {
				const raw = await request.text();
				const parsed: unknown = raw ? JSON.parse(raw) : {};
				const body: Record<string, unknown> = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? { ...parsed } : {};
				stub.seen.push({ path: new URL(request.url).pathname, body, authorization: request.headers.get("authorization") });
				if (body.finalize === true) {
					return Response.json({ status: "version-cut", dataset: "guide", datasetId: "ds-9", commit: repo.commit, paths: ["docs/a.md"], versions: 1, deletedDocumentIds: [] });
				}
				return Response.json(UPLOADED);
			},
		});
		try {
			const result = await spawn(
				["docs", "refresh", "--dataset", "guide", "--commit", repo.commit, "--repo", repo.dir, "--slug", SLUG],
				{ SUBSTRATE_URL: `http://127.0.0.1:${refreshing.port}`, SUBSTRATE_TOKEN: "tok-real" },
			);
			expect(result.code).toBe(0);
			expect(result.stdout).toContain("status=cut");
			expect(result.stdout).toContain(`commit=${repo.commit}`);
			const pages = stub.seen.filter((post) => post.body.finalize !== true);
			expect(pages).toHaveLength(1);
			expect(String(pages[0]?.body.source_url)).toBe(`https://${"github.com"}/${SLUG}/blob/${repo.commit}/docs/a.md`);
		} finally {
			refreshing.stop(true);
		}
	});
});

describe("usage", () => {
	test("the usage text lists the docs commands", async () => {
		const result = await spawn([], {});
		expect(result.stdout).toContain("substrate docs ingest --dataset N --file P --source-url U --commit S");
		expect(result.stdout).toContain("substrate docs refresh --dataset N --commit S");
	});
});
