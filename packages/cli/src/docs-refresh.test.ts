import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MAX_CONTENT_BYTES as SERVER_CAP, TEXT_EXTENSIONS as SERVER_EXTS } from "../../mcp-server/src/docs/ingest.ts";
import {
	DOCS_DEFAULT_TIMEOUT_MS,
	DOCS_MAX_CONTENT_BYTES,
	DOCS_PARSE_DEADLINE_MS,
	DOCS_POLL_INTERVAL_MS,
	DOCS_TEXT_EXTENSIONS,
	decodePathSegments,
	docsSourceUrl,
	docsTimeout,
	encodePathSegments,
	parseDeadlineMs,
	pollIntervalMs,
	runDocsIngest,
	runDocsRefresh,
	runDocsTick,
	type DocsDeps,
	type TickDeps,
} from "./docs-refresh.ts";

const COMMIT_A = "a".repeat(40);
const SLUG = "example/guide";
const SOURCE = (commit: string, path: string) => `https://${"github.com"}/${SLUG}/blob/${commit}/${path}`;

const scratch = mkdtempSync(join(tmpdir(), "substrate-docs-cli-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// ── stubs ────────────────────────────────────────────────────────────────────

interface Post {
	path: string;
	authorization: string | null;
	body: Record<string, unknown>;
}

/** An unreachable substrate: declared once here so call sites never cast inline. */
function throwingFetch(reason: string): typeof fetch {
	const impl = (async () => {
		throw new Error(reason);
	}) as unknown as typeof fetch;
	return impl;
}

function stubFetch(handler: (body: Record<string, unknown>) => { status: number; body: unknown }): {
	fetch: typeof fetch;
	posts: Post[];
} {
	const posts: Post[] = [];
	// Test double: fetch has no meaningful runtime shape to narrow, so the
	// mismatch is declared once on this named const, never at call sites.
	const impl = (async (url: string, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		const raw = typeof init?.body === "string" ? init.body : "";
		const parsed: unknown = raw ? JSON.parse(raw) : {};
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("stubFetch got a non-object body");
		}
		const body: Record<string, unknown> = { ...parsed };
		posts.push({ path: new URL(String(url)).pathname, body, authorization: headers.get("authorization") });
		const reply = handler(body);
		return new Response(JSON.stringify(reply.body), {
			status: reply.status,
			headers: { "content-type": "application/json" },
		});
	}) as unknown as typeof fetch;
	return { fetch: impl, posts };
}

const UPLOADED = {
	status: "uploaded",
	datasetId: "ds-9",
	contentSha256: "0".repeat(64),
	sections: 2,
	redactions: 0,
	imagesStripped: 0,
	documentIds: ["doc-1", "doc-2"],
};

function capture(overrides: Partial<DocsDeps> = {}): { deps: DocsDeps; out: string[]; err: string[] } {
	const out: string[] = [];
	const err: string[] = [];
	const deps: DocsDeps = {
		url: "http://127.0.0.1:1",
		token: "tok-test",
		timeoutMs: 5000,
		cwd: process.cwd(),
		out: (text) => out.push(text),
		err: (text) => err.push(text),
		env: {},
		...overrides,
	};
	return { deps, out, err };
}

const joined = (lines: string[]): string => lines.join("");

/** A real git repo with the given files committed on main. */
function gitRepo(files: Record<string, string>): { dir: string; commit: string } {
	const dir = mkdtempSync(join(scratch, "repo-"));
	const run = (args: string[]): string => {
		const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
		if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
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

function pageFile(name: string, content: string): string {
	const path = join(scratch, name);
	writeFileSync(path, content);
	return path;
}

const INGEST = (file: string, extra: string[] = []) => [
	"--dataset",
	"guide",
	"--file",
	file,
	"--source-url",
	SOURCE(COMMIT_A, "docs/x.md"),
	"--commit",
	COMMIT_A,
	...extra,
];

// ── ingest ───────────────────────────────────────────────────────────────────

describe("docs ingest (D25-12)", () => {
	test("the client cap is the server cap and the timeout is ~120 s", () => {
		expect(DOCS_MAX_CONTENT_BYTES).toBe(SERVER_CAP);
		expect(DOCS_DEFAULT_TIMEOUT_MS).toBe(120_000);
		expect(docsTimeout(undefined)).toBe(120_000);
		expect(docsTimeout("zero")).toBe(120_000);
		expect(docsTimeout("5000")).toBe(5000);
		expect(parseDeadlineMs(undefined)).toBe(DOCS_PARSE_DEADLINE_MS);
		expect(pollIntervalMs(undefined)).toBe(DOCS_POLL_INTERVAL_MS);
	});

	test("the client text set is the server text set", () => {
		expect(Object.keys(DOCS_TEXT_EXTENSIONS).sort()).toEqual([...SERVER_EXTS].sort());
	});

	test("a dry_run prints the key=value shape with a Bearer token and snake_case keys", async () => {
		const stub = stubFetch(() => ({
			status: 200,
			body: { ...UPLOADED, status: "dry_run", wouldUpload: true, documentIds: undefined },
		}));
		const file = pageFile("dry.md", "# Hi\n");
		const { deps, out } = capture({ fetch: stub.fetch });
		const code = await runDocsIngest(INGEST(file, ["--dry-run"]), deps);
		expect(code).toBe(0);
		expect(stub.posts).toHaveLength(1);
		expect(stub.posts[0]?.authorization).toBe("Bearer tok-test");
		expect(stub.posts[0]?.path).toBe("/docs/ingest");
		const body = stub.posts[0]?.body ?? {};
		expect(body).toMatchObject({ dataset: "guide", commit: COMMIT_A, dry_run: true });
		expect(body).not.toHaveProperty("surface");
		expect(typeof body.session_id === "string" && body.session_id.length > 0).toBe(true);
		const text = joined(out);
		for (const key of ["status=dry_run", "dataset_id=ds-9", "content_sha256=", "sections=2", "redactions=0", "images_stripped=0", "would_upload=true"]) {
			expect(text).toContain(key);
		}
	});

	test("an upload prints document_ids and one finding per line", async () => {
		const stub = stubFetch(() => ({
			status: 200,
			body: { ...UPLOADED, findings: [{ line: 3, rule: "pem" }] },
		}));
		const file = pageFile("up.md", "# Hi\n");
		const { deps, out } = capture({ fetch: stub.fetch });
		expect(await runDocsIngest(INGEST(file), deps)).toBe(0);
		const text = joined(out);
		expect(text).toContain("status=uploaded");
		expect(text).toContain("document_ids=doc-1,doc-2");
		expect(text).toContain("finding=3 pem");
	});

	test("a file over 256 KiB is refused before anything is posted", async () => {
		const stub = stubFetch(() => ({ status: 200, body: UPLOADED }));
		const file = pageFile("big.md", `x`.repeat(DOCS_MAX_CONTENT_BYTES + 1));
		const { deps, out, err } = capture({ fetch: stub.fetch });
		expect(await runDocsIngest(INGEST(file), deps)).toBe(1);
		expect(joined(out)).toContain("status=refused");
		expect(joined(err)).toContain("over the 256 KiB page cap");
		expect(stub.posts).toHaveLength(0);
	});

	test("a file at exactly 256 KiB still posts", async () => {
		const stub = stubFetch(() => ({ status: 200, body: UPLOADED }));
		const file = pageFile("exact.md", `x`.repeat(DOCS_MAX_CONTENT_BYTES));
		const { deps } = capture({ fetch: stub.fetch });
		expect(await runDocsIngest(INGEST(file), deps)).toBe(0);
		expect(stub.posts).toHaveLength(1);
	});

	test("the exit-code matrix: refusal, 4xx-shape, 5xx, unreachable, no token, bad flags", async () => {
		const file = pageFile("m.md", "# Hi\n");
		const refused = stubFetch(() => ({
			status: 400,
			body: { status: "refused", reason: "secret", findings: [{ line: 1, rule: "pem" }] },
		}));
		const first = capture({ fetch: refused.fetch });
		expect(await runDocsIngest(INGEST(file), first.deps)).toBe(1);
		expect(joined(first.out)).toContain("status=refused");
		expect(joined(first.out)).toContain("reason=secret");
		expect(joined(first.out)).toContain("finding=1 pem");

		const broken = stubFetch(() => ({ status: 502, body: { status: "failed", reason: "ragflow-error", message: "bad" } }));
		const second = capture({ fetch: broken.fetch });
		expect(await runDocsIngest(INGEST(file), second.deps)).toBe(1);
		expect(joined(second.out)).toContain("status=failed");

		const down = capture({ fetch: throwingFetch("refused") });
		expect(await runDocsIngest(INGEST(file), down.deps)).toBe(1);
		expect(joined(down.out)).toContain("status=failed");

		const noToken = capture({ fetch: refused.fetch, token: undefined });
		expect(await runDocsIngest(INGEST(file), noToken.deps)).toBe(1);
		expect(joined(noToken.err)).toContain("SUBSTRATE_TOKEN is not set");
		expect(refused.posts).toHaveLength(1);

		const badCommit = capture({ fetch: refused.fetch });
		expect(await runDocsIngest(INGEST(file, ["--commit", "zzz"]), badCommit.deps)).toBe(1);
		const missing = capture({ fetch: refused.fetch });
		expect(await runDocsIngest(["--dataset", "guide"], missing.deps)).toBe(1);
		const unknownFlag = capture({ fetch: refused.fetch });
		expect(await runDocsIngest(INGEST(file, ["--bogus", "x"]), unknownFlag.deps)).toBe(1);
	});

	test("the docs client never redacts locally", () => {
		for (const name of ["docs-refresh.ts", "index.ts"]) {
			const source = readFileSync(join(import.meta.dir, name), "utf8");
			const imports = source.split("\n").filter((line) => /^\s*import[\s{]/.test(line));
			expect(imports.join("\n")).not.toContain("redact");
			expect(source).not.toContain("redact(");
			expect(source).not.toContain("redactSkillContent");
		}
	});

	test("a file that is not valid UTF-8 is refused before anything is posted", async () => {
		const stub = stubFetch(() => ({ status: 200, body: UPLOADED }));
		const path = join(scratch, "bad-ingest.md");
		writeFileSync(path, Buffer.from([0x23, 0x20, 0x54, 0x0a, 0xff, 0xfe, 0x0a]));
		const { deps, out, err } = capture({ fetch: stub.fetch });
		expect(await runDocsIngest(INGEST(path), deps)).toBe(1);
		expect(joined(out)).toContain("status=refused");
		expect(joined(err)).toContain("not valid UTF-8");
		expect(stub.posts).toHaveLength(0);
	});
});

describe("docs refresh source_url round-trip", () => {
	test("encode leaves simple paths alone and escapes spaces, #, ?, %", () => {
		expect(encodePathSegments("docs/a.md")).toBe("docs/a.md");
		expect(encodePathSegments("docs/Setup Guide.md")).toBe("docs/Setup%20Guide.md");
		expect(encodePathSegments("docs/a#b.md")).toBe("docs/a%23b.md");
		expect(encodePathSegments("docs/q?x.md")).toBe("docs/q%3Fx.md");
		expect(encodePathSegments("docs/100%.md")).toBe("docs/100%25.md");
		expect(docsSourceUrl(SLUG, COMMIT_A, "docs/Setup Guide.md")).toBe(SOURCE(COMMIT_A, "docs/Setup%20Guide.md"));
	});

	test("decode inverts encode and refuses escapes and traversal", () => {
		for (const path of ["docs/a.md", "docs/Setup Guide.md", "docs/a#b.md", "docs/q?x.md", "docs/100%.md", "docs/üñï.md", "README.md"]) {
			expect(decodePathSegments(encodePathSegments(path))).toEqual({ ok: true, path });
		}
		for (const bad of ["docs/../x.md", "docs/%2E%2E/x.md", "docs/%2Fx.md", "docs/%5Cx.md", "docs/%ZZ.md", "docs/%", "", "docs//x.md"]) {
			expect(decodePathSegments(bad)).toEqual({ ok: false });
		}
	});
});

// ── refresh ──────────────────────────────────────────────────────────────────

function refreshDeps(stub: { fetch: typeof fetch }, env: Record<string, string> = {}) {
	return capture({ fetch: stub.fetch, env: { SUBSTRATE_DOCS_POLL_MS: "5", SUBSTRATE_DOCS_PARSE_TIMEOUT_MS: "5000", ...env } });
}

describe("docs refresh (D25-19/D25-20)", () => {
	test("posts committed pages with canonical URLs, then finalizes; totals print; only /docs/ingest is posted", async () => {
		const repo = gitRepo({ "docs/a.md": "# A\n\nhello\n", "docs/b.md": "# B\n\nworld\n", "img/logo.png": "binary" });
		const finalizeBodies: Record<string, unknown>[] = [];
		const stub = stubFetch((body) => {
			if (body.finalize === true) {
				finalizeBodies.push(body);
				return { status: 200, body: { status: "version-cut", dataset: "guide", datasetId: "ds-9", commit: repo.commit, paths: ["docs/a.md", "docs/b.md"], versions: 1, deletedDocumentIds: [] } };
			}
			return { status: 200, body: { ...UPLOADED, documentIds: [`doc-${String(body.source_url).split("/").pop()}`] } };
		});
		const { deps, out } = refreshDeps(stub);
		const code = await runDocsRefresh(["--dataset", "guide", "--commit", repo.commit, "--repo", repo.dir, "--slug", SLUG], deps);
		expect(code).toBe(0);
		const pages = stub.posts.filter((post) => post.body.finalize !== true);
		expect(pages).toHaveLength(2);
		for (const post of stub.posts) expect(post.path).toBe("/docs/ingest");
		const urls = pages.map((post) => String(post.body.source_url)).sort();
		expect(urls).toEqual([SOURCE(repo.commit, "docs/a.md"), SOURCE(repo.commit, "docs/b.md")].sort());
		for (const post of pages) {
			expect(post.body).toMatchObject({ dataset: "guide", commit: repo.commit });
			expect(typeof post.body.session_id === "string" && String(post.body.session_id).startsWith("docs-refresh:guide:")).toBe(true);
			expect(post.body).not.toHaveProperty("surface");
		}
		expect(finalizeBodies).toHaveLength(1);
		expect(finalizeBodies[0]).toMatchObject({ dataset: "guide", commit: repo.commit, finalize: true });
		expect(finalizeBodies[0]).toHaveProperty("paths_present");
		const text = joined(out);
		for (const key of ["status=cut", "dataset=guide", `commit=${repo.commit}`, "listed=3", "uploaded=2", "unchanged=0", "skipped=1", "refused=0", "documents=2"]) {
			expect(text).toContain(key);
		}
	});

	test("a dirty file in the working tree can never be ingested", async () => {
		const repo = gitRepo({ "docs/a.md": "# A\n\ncommitted\n" });
		writeFileSync(join(repo.dir, "docs/a.md"), "# A\n\nDIRTY UNCOMMITTED\n");
		const seen: string[] = [];
		const stub = stubFetch((body) => {
			if (body.finalize === true) {
				return { status: 200, body: { status: "version-cut", dataset: "guide", datasetId: "ds-9", commit: repo.commit, paths: ["docs/a.md"], versions: 1, deletedDocumentIds: [] } };
			}
			seen.push(String(body.content));
			return { status: 200, body: UPLOADED };
		});
		const { deps } = refreshDeps(stub);
		expect(await runDocsRefresh(["--dataset", "guide", "--commit", repo.commit, "--repo", repo.dir, "--slug", SLUG], deps)).toBe(0);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toContain("committed");
		expect(seen[0]).not.toContain("DIRTY");
	});

	test("a refused page warns but the version is still cut with it absent", async () => {
		const repo = gitRepo({ "docs/ok.md": "# Ok\n", "docs/bad.md": "# Bad\n" });
		const stub = stubFetch((body) => {
			if (body.finalize === true) {
				if (!Array.isArray(body.paths_present)) throw new Error("finalize needs paths_present");
				const paths: unknown[] = body.paths_present;
				expect(paths).toEqual(["docs/ok.md"]);
				return { status: 200, body: { status: "version-cut", dataset: "guide", datasetId: "ds-9", commit: repo.commit, paths, versions: 1, deletedDocumentIds: [] } };
			}
			if (String(body.source_url).endsWith("/docs/bad.md")) {
				return { status: 400, body: { status: "refused", reason: "secret", findings: [{ line: 1, rule: "pem" }] } };
			}
			return { status: 200, body: UPLOADED };
		});
		const { deps, out, err } = refreshDeps(stub);
		expect(await runDocsRefresh(["--dataset", "guide", "--commit", repo.commit, "--repo", repo.dir, "--slug", SLUG], deps)).toBe(0);
		expect(joined(out)).toContain("refused=1");
		expect(joined(out)).toContain("status=cut");
		expect(joined(err)).toContain("skipped docs/bad.md: secret");
	});

	test("unchanged pages ride into the version without re-uploading", async () => {
		const repo = gitRepo({ "docs/a.md": "# A\n" });
		const stub = stubFetch((body) => {
			if (body.finalize === true) {
				return { status: 200, body: { status: "version-cut", dataset: "guide", datasetId: "ds-9", commit: repo.commit, paths: ["docs/a.md"], versions: 2, deletedDocumentIds: [] } };
			}
			return { status: 200, body: { ...UPLOADED, status: "unchanged" } };
		});
		const { deps, out } = refreshDeps(stub);
		expect(await runDocsRefresh(["--dataset", "guide", "--commit", repo.commit, "--repo", repo.dir, "--slug", SLUG], deps)).toBe(0);
		expect(joined(out)).toContain("unchanged=1");
		expect(joined(out)).toContain("status=cut");
	});

	test("no ingested pages means no finalize call and exit 1", async () => {
		const repo = gitRepo({ "docs/a.md": "# A\n" });
		const stub = stubFetch(() => ({ status: 400, body: { status: "refused", reason: "secret" } }));
		const { deps, out } = refreshDeps(stub);
		expect(await runDocsRefresh(["--dataset", "guide", "--commit", repo.commit, "--repo", repo.dir, "--slug", SLUG], deps)).toBe(1);
		expect(stub.posts.every((post) => post.body.finalize !== true)).toBe(true);
		expect(joined(out)).toContain("status=failed");
	});

	test("a failed parse fails the run at once without cutting", async () => {
		const repo = gitRepo({ "docs/a.md": "# A\n" });
		let finalizes = 0;
		const stub = stubFetch((body) => {
			if (body.finalize === true) {
				finalizes += 1;
				return {
					status: 502,
					body: { status: "failed", reason: "ragflow-error", message: `refusing to cut ${repo.commit}: document doc-1 for docs/a.md reports run FAIL` },
				};
			}
			return { status: 200, body: UPLOADED };
		});
		const { deps, out, err } = refreshDeps(stub);
		expect(await runDocsRefresh(["--dataset", "guide", "--commit", repo.commit, "--repo", repo.dir, "--slug", SLUG], deps)).toBe(1);
		expect(finalizes).toBe(1);
		expect(joined(out)).toContain("status=failed");
		expect(joined(err)).toContain("parse failed");
	});

	test("a queued parse is polled until the version cuts", async () => {
		const repo = gitRepo({ "docs/a.md": "# A\n" });
		let finalizes = 0;
		let sleeps = 0;
		const stub = stubFetch((body) => {
			if (body.finalize === true) {
				finalizes += 1;
				if (finalizes === 1) {
					return {
						status: 502,
						body: { status: "failed", reason: "ragflow-error", message: `refusing to cut ${repo.commit}: document doc-1 for docs/a.md reports run UNSTART` },
					};
				}
				return { status: 200, body: { status: "version-cut", dataset: "guide", datasetId: "ds-9", commit: repo.commit, paths: ["docs/a.md"], versions: 1, deletedDocumentIds: [] } };
			}
			return { status: 200, body: UPLOADED };
		});
		const { deps, out } = refreshDeps(stub);
		deps.sleep = async () => { sleeps += 1; };
		expect(await runDocsRefresh(["--dataset", "guide", "--commit", repo.commit, "--repo", repo.dir, "--slug", SLUG], deps)).toBe(0);
		expect(finalizes).toBe(2);
		expect(sleeps).toBe(1);
		expect(joined(out)).toContain("status=cut");
	});

	test("a parse that never finishes fails at the bound", async () => {
		const repo = gitRepo({ "docs/a.md": "# A\n" });
		let finalizes = 0;
		const stub = stubFetch((body) => {
			if (body.finalize === true) {
				finalizes += 1;
				return {
					status: 502,
					body: { status: "failed", reason: "ragflow-error", message: `refusing to cut ${repo.commit}: document doc-1 for docs/a.md reports run missing` },
				};
			}
			return { status: 200, body: UPLOADED };
		});
		const { deps, out } = refreshDeps(stub, { SUBSTRATE_DOCS_POLL_MS: "5", SUBSTRATE_DOCS_PARSE_TIMEOUT_MS: "30" });
		expect(await runDocsRefresh(["--dataset", "guide", "--commit", repo.commit, "--repo", repo.dir, "--slug", SLUG], deps)).toBe(1);
		expect(finalizes).toBeGreaterThanOrEqual(1);
		expect(joined(out)).toContain("status=failed");
	});

	test("a per-page transport failure aborts the run without finalizing", async () => {
		const repo = gitRepo({ "docs/a.md": "# A\n", "docs/b.md": "# B\n" });
		const stub = stubFetch((body) => {
			if (body.finalize === true) {
				return { status: 200, body: { status: "version-cut", dataset: "guide", datasetId: "ds-9", commit: repo.commit, paths: [], versions: 1, deletedDocumentIds: [] } };
			}
			throw new Error("down");
		});
		const { deps, out, err } = refreshDeps(stub);
		expect(await runDocsRefresh(["--dataset", "guide", "--commit", repo.commit, "--repo", repo.dir, "--slug", SLUG], deps)).toBe(1);
		expect(stub.posts).toHaveLength(1);
		expect(stub.posts.every((post) => post.body.finalize !== true)).toBe(true);
		expect(joined(out)).toContain("status=failed");
		expect(joined(err)).toContain("did not answer for docs/a.md");
	});

	test("--repo is required outside agent-skills and --slug falls back to origin", async () => {
		const repo = gitRepo({ "docs/a.md": "# A\n" });
		const stub = stubFetch((body) => {
			if (body.finalize === true) {
				return { status: 200, body: { status: "version-cut", dataset: "guide", datasetId: "ds-9", commit: repo.commit, paths: ["docs/a.md"], versions: 1, deletedDocumentIds: [] } };
			}
			return { status: 200, body: UPLOADED };
		});
		const noRepo = refreshDeps(stub);
		expect(await runDocsRefresh(["--dataset", "guide", "--commit", repo.commit, "--slug", SLUG], noRepo.deps)).toBe(1);
		expect(joined(noRepo.out)).toContain("status=failed");

		const noSlug = refreshDeps(stub);
		expect(await runDocsRefresh(["--dataset", "guide", "--commit", repo.commit, "--repo", repo.dir], noSlug.deps)).toBe(1);
	});

	test("pages with spaces, #, and ? round-trip source_url into paths_present", async () => {
		const files = ["docs/Setup Guide.md", "docs/a#b.md", "docs/q?x.md"];
		const repo = gitRepo(Object.fromEntries(files.map((path) => [path, `# ${path}\n`])));
		// The stub mirrors the server: the manifest key is the URL pathname
		// remainder, echoed back as `path`; finalize only keeps present paths
		// that were actually stored.
		const keys = new Set<string>();
		const stub = stubFetch((body) => {
			if (body.finalize === true) {
				const present: unknown[] = Array.isArray(body.paths_present) ? body.paths_present : [];
				const matched = present.filter((path): path is string => typeof path === "string" && keys.has(path));
				return { status: 200, body: { status: "version-cut", dataset: "guide", datasetId: "ds-9", commit: repo.commit, paths: matched, versions: 1, deletedDocumentIds: [] } };
			}
			const url = new URL(String(body.source_url));
			expect(url.hash).toBe("");
			expect(url.search).toBe("");
			expect(String(body.source_url)).not.toContain(" ");
			const key = url.pathname.split("/").slice(5).join("/");
			keys.add(key);
			return { status: 200, body: { ...UPLOADED, path: key } };
		});
		const { deps, out } = refreshDeps(stub);
		expect(await runDocsRefresh(["--dataset", "guide", "--commit", repo.commit, "--repo", repo.dir, "--slug", SLUG], deps)).toBe(0);
		expect(stub.posts.filter((post) => post.body.finalize !== true)).toHaveLength(3);
		const finalize = stub.posts.find((post) => post.body.finalize === true);
		const finalizePaths: unknown = finalize?.body.paths_present;
		const present: unknown[] = Array.isArray(finalizePaths) ? finalizePaths : [];
		expect(present).toHaveLength(3);
		expect(present.every((path) => typeof path === "string" && keys.has(path))).toBe(true);
		expect(joined(out)).toContain("status=cut");
	});

	test("a 413 body-size refusal counts as refused and the version still cuts", async () => {
		const repo = gitRepo({ "docs/ok.md": "# Ok\n", "docs/huge.md": "# Huge\n" });
		const stub = stubFetch((body) => {
			if (body.finalize === true) {
				const present: unknown[] = Array.isArray(body.paths_present) ? body.paths_present : [];
				return { status: 200, body: { status: "version-cut", dataset: "guide", datasetId: "ds-9", commit: repo.commit, paths: present, versions: 1, deletedDocumentIds: [] } };
			}
			if (String(body.source_url).endsWith("/docs/huge.md")) {
				return { status: 413, body: { error: "request body too large" } };
			}
			return { status: 200, body: UPLOADED };
		});
		const { deps, out, err } = refreshDeps(stub);
		expect(await runDocsRefresh(["--dataset", "guide", "--commit", repo.commit, "--repo", repo.dir, "--slug", SLUG], deps)).toBe(0);
		expect(joined(out)).toContain("refused=1");
		expect(joined(out)).toContain("uploaded=1");
		expect(joined(out)).toContain("status=cut");
		expect(joined(err)).toContain("skipped docs/huge.md: request body too large");
	});

	test("a committed file over the page cap is refused before posting", async () => {
		const repo = gitRepo({ "docs/ok.md": "# Ok\n", "docs/big.md": "x".repeat(DOCS_MAX_CONTENT_BYTES + 1) });
		const stub = stubFetch((body) => {
			if (body.finalize === true) {
				const present: unknown[] = Array.isArray(body.paths_present) ? body.paths_present : [];
				return { status: 200, body: { status: "version-cut", dataset: "guide", datasetId: "ds-9", commit: repo.commit, paths: present, versions: 1, deletedDocumentIds: [] } };
			}
			return { status: 200, body: UPLOADED };
		});
		const { deps, out, err } = refreshDeps(stub);
		expect(await runDocsRefresh(["--dataset", "guide", "--commit", repo.commit, "--repo", repo.dir, "--slug", SLUG], deps)).toBe(0);
		expect(stub.posts.filter((post) => post.body.finalize !== true)).toHaveLength(1);
		expect(stub.posts.some((post) => String(post.body.source_url ?? "").endsWith("/docs/big.md"))).toBe(false);
		expect(joined(out)).toContain("refused=1");
		expect(joined(out)).toContain("status=cut");
		expect(joined(err)).toContain("over the 256 KiB page cap");
	});

	test("files outside the registry roots are skipped before posting", async () => {
		const registryFile = join(scratch, "roots-datasets.json");
		writeFileSync(
			registryFile,
			JSON.stringify([{ name: "guide", slug: SLUG, include: ["docs/**"], exclude: ["docs/drafts/**"], trigger: "merge-to-main" }]),
		);
		const repo = gitRepo({ "docs/a.md": "# A\n", "other/b.md": "# B\n", "docs/drafts/c.md": "# C\n" });
		const stub = stubFetch((body) => {
			if (body.finalize === true) {
				const present: unknown[] = Array.isArray(body.paths_present) ? body.paths_present : [];
				return { status: 200, body: { status: "version-cut", dataset: "guide", datasetId: "ds-9", commit: repo.commit, paths: present, versions: 1, deletedDocumentIds: [] } };
			}
			return { status: 200, body: UPLOADED };
		});
		const { deps, out } = refreshDeps(stub, { SUBSTRATE_DOCS_DATASETS: registryFile });
		expect(await runDocsRefresh(["--dataset", "guide", "--commit", repo.commit, "--repo", repo.dir, "--slug", SLUG], deps)).toBe(0);
		const pages = stub.posts.filter((post) => post.body.finalize !== true);
		expect(pages).toHaveLength(1);
		expect(String(pages[0]?.body.source_url)).toBe(SOURCE(repo.commit, "docs/a.md"));
		expect(joined(out)).toContain("skipped=2");
		expect(joined(out)).toContain("status=cut");
	});

	test("a committed file with invalid UTF-8 is skipped, never posted", async () => {
		const repo = gitRepo({ "docs/ok.md": "# Ok\n" });
		writeFileSync(join(repo.dir, "docs/bad.md"), Buffer.from([0x23, 0x20, 0x42, 0x0a, 0xff, 0xfe, 0x0a]));
		const added = spawnSync("git", ["add", "docs/bad.md"], { cwd: repo.dir, encoding: "utf8" });
		expect(added.status).toBe(0);
		const committed = spawnSync("git", ["commit", "-m", "bad bytes"], { cwd: repo.dir, encoding: "utf8" });
		expect(committed.status).toBe(0);
		const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo.dir, encoding: "utf8" }).stdout.trim();
		const stub = stubFetch((body) => {
			if (body.finalize === true) {
				const present: unknown[] = Array.isArray(body.paths_present) ? body.paths_present : [];
				return { status: 200, body: { status: "version-cut", dataset: "guide", datasetId: "ds-9", commit: head, paths: present, versions: 1, deletedDocumentIds: [] } };
			}
			return { status: 200, body: UPLOADED };
		});
		const { deps, out, err } = refreshDeps(stub);
		expect(await runDocsRefresh(["--dataset", "guide", "--commit", head, "--repo", repo.dir, "--slug", SLUG], deps)).toBe(0);
		expect(stub.posts.some((post) => String(post.body.source_url ?? "").endsWith("/docs/bad.md"))).toBe(false);
		expect(joined(out)).toContain("skipped=1");
		expect(joined(out)).toContain("status=cut");
		expect(joined(err)).toContain("skipped docs/bad.md");
	});
});

// ── tick ─────────────────────────────────────────────────────────────────────

function tickBase(overrides: Partial<TickDeps> = {}, reuseDir?: string): { out: string[]; err: string[]; stateDir: string; base: TickDeps } {
	const out: string[] = [];
	const err: string[] = [];
	const stateDir = reuseDir ?? mkdtempSync(join(scratch, "state-"));
	return {
		out,
		err,
		stateDir,
		base: {
			watch: "",
			stateDir,
			url: "http://127.0.0.1:1",
			token: "tok-test",
			timeoutMs: 5000,
			agentSkillsPath: join(scratch, "no-skills-here"),
			remoteTemplate: join(scratch, "no-remote-here", "{slug}.git"),
			out: (text: string) => out.push(text),
			err: (text: string) => err.push(text),
			env: { SUBSTRATE_DOCS_POLL_MS: "5", SUBSTRATE_DOCS_PARSE_TIMEOUT_MS: "5000" },
			...overrides,
		},
	};
}

function tickStub(): { fetch: typeof fetch; posts: Post[] } {
	return stubFetch((body) => {
		if (body.finalize === true) {
			return { status: 200, body: { status: "version-cut", dataset: body.dataset, datasetId: "ds-9", commit: body.commit, paths: body.paths_present, versions: 1, deletedDocumentIds: [] } };
		}
		return { status: 200, body: UPLOADED };
	});
}

describe("docs tick (D25-18, D25-21 catch-up)", () => {
	test("clones the mirror, refreshes on drift, then reports unchanged without re-posting", async () => {
		const origin = gitRepo({ "docs/a.md": "# A\n" });
		const stub = tickStub();
		const first = tickBase({ fetch: stub.fetch, remoteTemplate: `${origin.dir}` });
		first.base.watch = "guide=example/guide";
		first.base.remoteTemplate = origin.dir;
		expect(await runDocsTick(first.base)).toBe(0);
		expect(joined(first.out)).toContain("status=refreshed");
		expect(readFileSync(join(first.stateDir, "guide", "last-refresh-commit"), "utf8").trim()).toBe(origin.commit);
		const posted = stub.posts.length;
		expect(posted).toBeGreaterThan(0);

		const second = tickBase({ fetch: stub.fetch, remoteTemplate: origin.dir, watch: "guide=example/guide" }, first.stateDir);
		expect(await runDocsTick(second.base)).toBe(0);
		expect(joined(second.out)).toContain("status=unchanged");
		expect(stub.posts.length).toBe(posted);
	});

	test("a new origin commit refreshes again", async () => {
		const origin = gitRepo({ "docs/a.md": "# A\n" });
		const stub = tickStub();
		const tick = tickBase({ fetch: stub.fetch, remoteTemplate: origin.dir });
		tick.base.watch = "guide=example/guide";
		expect(await runDocsTick(tick.base)).toBe(0);
		const add = spawnSync("git", ["commit", "--allow-empty", "-m", "second"], { cwd: origin.dir, encoding: "utf8" });
		expect(add.status).toBe(0);
		const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: origin.dir, encoding: "utf8" }).stdout.trim();
		expect(await runDocsTick(tick.base)).toBe(0);
		expect(joined(tick.out)).toContain(`status=refreshed commit=${head}`);
	});

	test("bad watch, empty watch, missing token, and a dead remote all fail", async () => {
		const bad = tickBase();
		bad.base.watch = "not-a-pair";
		expect(await runDocsTick(bad.base)).toBe(1);

		const empty = tickBase();
		empty.base.watch = "   ";
		expect(await runDocsTick(empty.base)).toBe(1);

		const noToken = tickBase({ token: undefined });
		noToken.base.watch = "guide=example/guide";
		expect(await runDocsTick(noToken.base)).toBe(1);

		const stub = tickStub();
		const dead = tickBase({ fetch: stub.fetch });
		dead.base.watch = "guide=example/guide";
		expect(await runDocsTick(dead.base)).toBe(1);
		expect(joined(dead.out)).toContain("status=failed");
	});

	test("agent-skills catches up from the checkout read-only, never cloning", async () => {
		const skills = gitRepo({ "SKILL.md": "# Skill\n" });
		const stub = tickStub();
		const tick = tickBase({ fetch: stub.fetch, agentSkillsPath: skills.dir });
		tick.base.watch = "agent-skills=example/skills";
		expect(await runDocsTick(tick.base)).toBe(0);
		expect(joined(tick.out)).toContain("status=refreshed");
		expect(readFileSync(join(tick.stateDir, "agent-skills", "last-refresh-commit"), "utf8").trim()).toBe(skills.commit);
		expect(stub.posts.some((post) => post.body.dataset === "agent-skills")).toBe(true);
		// The unreachable template proves no clone was attempted: a clone would have failed the dataset.
		expect(stub.posts.length).toBeGreaterThan(0);
	});
});
