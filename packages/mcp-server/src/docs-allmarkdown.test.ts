import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	discoverGroups,
	planAllMarkdown,
	runAllMarkdownIngest,
	type AllMarkdownPlan,
	type EntryKind,
	type IngestCall,
	type MarkdownFs,
} from "./docs-allmarkdown.ts";
import { INGEST_PAGE_MAX_BYTES, type IngestInput } from "./docs-ingest.ts";

const REPOS = "/repos";
const SESSION = "docs-allmarkdown:test";
const GENERATED = "2026-11-14T00:00:00.000Z";
/** The AWS documentation's example key: it matches the `aws` redaction rule and is safe to commit. */
const EXAMPLE_KEY = "AKIAIOSFODNN7EXAMPLE";

interface TreeOptions {
	links?: string[];
	heads?: Record<string, string>;
	roots?: string[];
	datasets?: Record<string, string>;
	known?: string[];
}

interface FakeFs extends MarkdownFs {
	/** Every path whose body was read. A stat alone is not a read. */
	reads: string[];
}

function missing(path: string): Error {
	return Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
}

/** An in-memory tree: a directory exists while a file lies under it. */
function fakeFs(files: Record<string, string>, options: TreeOptions = {}): FakeFs {
	const contents = new Map(Object.entries(files));
	const links = new Set(options.links ?? []);
	const heads = new Map(Object.entries(options.heads ?? {}));
	const reads: string[] = [];
	const childrenOf = (dir: string): Map<string, EntryKind> => {
		const prefix = `${dir}/`;
		const children = new Map<string, EntryKind>();
		for (const path of [...contents.keys(), ...links]) {
			if (!path.startsWith(prefix)) continue;
			const [head = "", ...tail] = path.slice(prefix.length).split("/");
			if (tail.length === 0) children.set(head, links.has(path) ? "symlink" : "file");
			else if (!children.has(head)) children.set(head, "dir");
		}
		return children;
	};
	return {
		reads,
		async list(dir) {
			const children = childrenOf(dir);
			if (children.size === 0) throw missing(dir);
			return [...children].map(([name, kind]) => ({ name, kind }));
		},
		async isDirectory(path) {
			return childrenOf(path).size > 0;
		},
		async kindOf(path) {
			if (links.has(path)) return "symlink";
			if (contents.has(path)) return "file";
			return childrenOf(path).size > 0 ? "dir" : null;
		},
		async size(path) {
			const body = contents.get(path);
			if (body === undefined) throw missing(path);
			return Buffer.byteLength(body, "utf8");
		},
		async read(path) {
			reads.push(path);
			const body = contents.get(path);
			if (body === undefined) throw missing(path);
			return Buffer.from(body, "utf8");
		},
		async readText(path) {
			const body = contents.get(path);
			if (body === undefined) throw missing(path);
			return body;
		},
		async headCommit(root) {
			return heads.get(root);
		},
		checkoutKey(root) {
			return `key:${root}`;
		},
	};
}

async function planTree(files: Record<string, string>, options: TreeOptions = {}): Promise<{ fs: FakeFs; plan: AllMarkdownPlan }> {
	const fs = fakeFs(files, options);
	const roots = options.roots ?? [];
	const discovered = await discoverGroups(fs, { roots, reposRoot: REPOS });
	const plan = await planAllMarkdown({
		fs,
		discovered,
		datasets: new Map(Object.entries(options.datasets ?? {})),
		known: new Set(options.known ?? []),
		roots,
		reposRoot: REPOS,
		generatedAt: GENERATED,
	});
	return { fs, plan };
}

function sentPages(plan: AllMarkdownPlan, group: string) {
	return (plan.batches.get(group) ?? []).flat();
}

function sentPaths(plan: AllMarkdownPlan, group: string): string[] {
	return sentPages(plan, group).map((page) => page.path).sort();
}

/** A fake ingest that records each call. Results are `ingested`, or a refusal with `refuse`. */
function fakeIngest(refuse?: string) {
	const calls: Array<{ input: IngestInput; roots: string[] }> = [];
	const ingest: IngestCall = async (input, roots) => {
		calls.push({ input, roots: [...roots] });
		if (refuse !== undefined) return { ok: false, refused: true, reason: refuse, changed: false };
		return {
			ok: true,
			changed: true,
			stripped_images: 0,
			results: input.pages.map((page) => ({
				path: page.path,
				source_url: page.source_url ?? "",
				status: "ingested" as const,
				document_id: `doc:${page.path}`,
				content_sha256: page.path,
			})),
		};
	};
	return { calls, ingest };
}

async function withStateDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "allmd-"));
	try {
		return await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const quiet = { out: () => undefined, err: () => undefined };

describe("docs-allmarkdown selection", () => {
	test("selection excludes milestones and symlinks, prunes excluded directories, and reads only .md files", async () => {
		const { fs, plan } = await planTree(
			{
				"/repos/alpha/README.md": "# alpha\n",
				"/repos/alpha/docs/guide.md": "# guide\n",
				"/repos/alpha/notes.txt": "not markdown\n",
				"/repos/alpha/.planning/PROJECT.md": "# project\n",
				"/repos/alpha/.planning/milestones/v1.0/ROADMAP.md": "# archived\n",
				"/repos/alpha/node_modules/pkg/README.md": "# dependency\n",
				"/repos/alpha/docs/link.md": "linked elsewhere\n",
			},
			{ links: ["/repos/alpha/docs/link.md"], datasets: { alpha: "alpha" }, known: ["alpha"] },
		);
		const group = plan.groups.find((entry) => entry.group === "alpha");
		expect(group?.md_files).toBe(3);
		expect(group?.planning_files).toBe(1);
		expect(group?.milestone_md_excluded).toBe(1);
		expect(group?.symlinks_skipped).toBe(1);
		expect(group?.excluded_dirs).toEqual({ node_modules: 1 });
		expect(sentPaths(plan, "alpha")).toEqual([".planning/PROJECT.md", "README.md", "docs/guide.md"]);
		expect(fs.reads.some((path) => path.includes("/milestones/"))).toBe(false);
		expect(fs.reads.some((path) => path.endsWith("/link.md"))).toBe(false);
	});

	test("dedup keeps one copy per group: a worktree's identical page is not sent again", async () => {
		const { plan } = await planTree(
			{
				"/repos/alpha/README.md": "# shared\n",
				"/repos/alpha/docs/a.md": "# unique a\n",
				"/wt/alpha-feat/.git": "gitdir: /repos/alpha/.git/worktrees/alpha-feat\n",
				"/wt/alpha-feat/README.md": "# shared\n",
				"/wt/alpha-feat/docs/b.md": "# feature b\n",
			},
			{ roots: ["/wt"], datasets: { alpha: "alpha" }, known: ["alpha"] },
		);
		expect(plan.groups.map((entry) => entry.group)).toEqual(["alpha"]);
		expect(plan.groups[0]?.worktrees).toEqual(["alpha-feat"]);
		expect(plan.groups[0]?.duplicate_files).toBe(1);
		expect(sentPaths(plan, "alpha")).toEqual(["README.md", "docs/a.md", "docs/b.md"]);
		expect(sentPages(plan, "alpha").find((page) => page.path === "README.md")?.source_url).toBe(pathToFileURL("/repos/alpha/README.md").href);
	});

	test("a file over the page cap is counted from its stat and never read", async () => {
		const big = "x".repeat(INGEST_PAGE_MAX_BYTES + 1);
		const { fs, plan } = await planTree(
			{ "/repos/alpha/big.md": big, "/repos/alpha/small.md": "# small\n" },
			{ datasets: { alpha: "alpha" }, known: ["alpha"] },
		);
		const group = plan.groups.find((entry) => entry.group === "alpha");
		expect(group?.over_cap_files).toBe(1);
		expect(group?.over_cap_bytes).toBe(INGEST_PAGE_MAX_BYTES + 1);
		expect(fs.reads).not.toContain("/repos/alpha/big.md");
		expect(sentPaths(plan, "alpha")).toEqual(["small.md"]);
	});
});

describe("docs-allmarkdown gate", () => {
	test("a refused page is never sent and reaches the leave-out file with only its path, rule names and hash", async () => {
		await withStateDir(async (dir) => {
			const { plan } = await planTree(
				{
					"/repos/alpha/README.md": "# ok\n",
					"/repos/alpha/docs/keys.md": `# keys\n${EXAMPLE_KEY}\n`,
				},
				{ datasets: { alpha: "alpha" }, known: ["alpha"] },
			);
			expect(sentPaths(plan, "alpha")).toEqual(["README.md"]);
			const leave = plan.leave_out.find((entry) => entry.group === "alpha");
			expect(leave?.refused.length).toBe(1);
			const entry = leave?.refused[0];
			expect(Object.keys(entry ?? {}).sort()).toEqual(["path", "rules", "sha256"]);
			expect(entry?.path).toBe("/repos/alpha/docs/keys.md");
			expect(entry?.rules).toContain("aws");
			expect(entry?.sha256).toMatch(/^[0-9a-f]{64}$/);

			expect(await runAllMarkdownIngest({ plan, apply: false, stateDir: dir, sessionId: SESSION, ...quiet })).toBe(0);
			const leaveText = await readFile(join(dir, "leave-out.json"), "utf8");
			expect(leaveText).toContain("/repos/alpha/docs/keys.md");
			expect(leaveText).not.toContain(EXAMPLE_KEY);
			const reportText = await readFile(join(dir, "report.json"), "utf8");
			const summaryText = await readFile(join(dir, "summary.md"), "utf8");
			expect(reportText).not.toContain(EXAMPLE_KEY);
			expect(summaryText).not.toContain(EXAMPLE_KEY);
		});
	});
});

describe("docs-allmarkdown run", () => {
	test("without apply no ingest call is made, and only the report files are written", async () => {
		await withStateDir(async (dir) => {
			const { plan } = await planTree({ "/repos/alpha/README.md": "# alpha\n" }, { datasets: { alpha: "alpha" }, known: ["alpha"] });
			const { calls, ingest } = fakeIngest();
			expect(await runAllMarkdownIngest({ plan, apply: false, stateDir: dir, ingest, sessionId: SESSION, ...quiet })).toBe(0);
			expect(calls).toEqual([]);
			expect(JSON.parse(await readFile(join(dir, "report.json"), "utf8")).meta.mode).toBe("dry-run");
			expect(await readFile(join(dir, "summary.md"), "utf8")).toContain("dry run, nothing sent");
		});
	});

	test("each group is sent under its registry dataset name, with the batch's paths as its roots", async () => {
		await withStateDir(async (dir) => {
			const { plan } = await planTree(
				{
					"/repos/alpha/README.md": "# a\n",
					"/repos/beta/docs/x.md": "# b\n",
					"/wt/loose/notes.md": "# loose\n",
				},
				{
					roots: ["/wt"],
					datasets: { alpha: "alpha-registry", beta: "beta-registry", "key:/wt/loose": "loose-registry" },
					known: ["alpha-registry", "beta-registry", "loose-registry"],
				},
			);
			const { calls, ingest } = fakeIngest();
			expect(await runAllMarkdownIngest({ plan, apply: true, stateDir: dir, ingest, sessionId: SESSION, ...quiet })).toBe(0);
			expect(calls.map((call) => call.input.dataset).sort()).toEqual(["alpha-registry", "beta-registry", "loose-registry"]);
			const alpha = calls.find((call) => call.input.pages[0]?.path === "README.md");
			expect(alpha?.input.dataset).toBe("alpha-registry");
			expect(alpha?.roots).toEqual(["README.md"]);
			expect(calls.find((call) => call.input.dataset === "beta-registry")?.input.pages[0]?.path).toBe("docs/x.md");
			expect(calls.find((call) => call.input.dataset === "loose-registry")?.input.pages[0]?.path).toBe("notes.md");
		});
	});

	test("a group whose dataset the ingest does not know is reported and never sent", async () => {
		await withStateDir(async (dir) => {
			const { plan } = await planTree(
				{ "/repos/alpha/README.md": "# a\n", "/repos/beta/README.md": "# b\n" },
				{ datasets: { alpha: "alpha", beta: "beta" }, known: ["alpha"] },
			);
			expect(plan.groups.find((entry) => entry.group === "beta")?.status).toBe("skipped-unknown-dataset");
			const { calls, ingest } = fakeIngest();
			expect(await runAllMarkdownIngest({ plan, apply: true, stateDir: dir, ingest, sessionId: SESSION, ...quiet })).toBe(0);
			expect(calls.map((call) => call.input.dataset)).toEqual(["alpha"]);
		});
	});

	test("a refused batch stops its group, is reported, and fails the run", async () => {
		await withStateDir(async (dir) => {
			const { plan } = await planTree({ "/repos/alpha/README.md": "# a\n" }, { datasets: { alpha: "alpha" }, known: ["alpha"] });
			const { ingest } = fakeIngest("unknown-dataset");
			expect(await runAllMarkdownIngest({ plan, apply: true, stateDir: dir, ingest, sessionId: SESSION, ...quiet })).toBe(1);
			const report = JSON.parse(await readFile(join(dir, "report.json"), "utf8"));
			expect(report.applied[0]).toMatchObject({ group: "alpha", batches_refused: 1, refusal: "unknown-dataset" });
		});
	});
});
