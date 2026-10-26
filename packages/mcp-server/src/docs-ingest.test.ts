/**
 * Plan 25-02 Task 1: docs_ingest gates plus hash idempotency against the
 * fake. All six refusals fail closed with locator-only warning events;
 * unchanged hashes skip, changed hashes replace; images strip and count.
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import {
	INGEST_CALL_MAX_BYTES,
	INGEST_PAGE_MAX_BYTES,
	extractPlanningGraphHint,
	batchIngestPages,
	ingestDocs,
	isPlanningPage,
	loadIngestRecords,
	nodeIo,
	planningPhaseOf,
	preflightIngestPages,
	saveIngestRecords,
	scanIngestPages,
	readSkillsCheckoutPages,
	skillsCheckoutRoots,
	stripRemoteImages,
	type IngestDeps,
	type IngestInput,
	type IngestOutcome,
	type IngestRecord,
	type PageSettlement,
	type ScanIo,
} from "./docs-ingest.ts";
import { createMcpServer } from "./mcp.ts";
import { RagflowFake } from "./ragflow-fake.ts";
import { Substrate } from "./service.ts";
import type { EventInput } from "./types.ts";
import type { FetchLike } from "./planes/ragflow.ts";

const CONFIG = { url: "http://ragflow.test", apiKey: "test-key" };

function harness(
	fake: RagflowFake,
	over: Partial<Pick<IngestDeps, "surface" | "vmGuest" | "roots" | "config" | "seen" | "locks" | "poll" | "fetchImpl" | "datasetLockWaitMs">> = {},
) {
	const events: EventInput[] = [];
	const seen = new Map<string, IngestRecord>();
	const deps: IngestDeps = {
		config: CONFIG,
		emit: async (event: EventInput): Promise<unknown> => {
			events.push(event);
			return { stored: false };
		},
		surface: "omp",
		seen,
		poll: { intervalMs: 0 },
		fetchImpl: fake.fetch,
		...over,
	};
	const ingest = (input: IngestInput): Promise<IngestOutcome> => ingestDocs(deps, input);
	return { events, seen, ingest };
}

const PAGE = {
	path: "docs/data-planes.md",
	source_url: "https://example.com/agent-substrate/data-planes",
	body: "The substrate is the only door to the data planes.",
};

describe("docs_ingest gates", () => {
	test("ingests a clean page with metadata and a note event", async () => {
		const fake = new RagflowFake();
		const { events, ingest } = harness(fake);
		const outcome = await ingest({ dataset: "agent-substrate", commit: "abc123", pages: [PAGE] });
		if (!outcome.ok) throw new Error(`expected ingest: ${outcome.reason}`);
		expect(outcome.results).toHaveLength(1);
		expect(outcome.results[0]?.status).toBe("ingested");
		expect(outcome.changed).toBe(true);
		expect(fake.uploads).toHaveLength(1);
		expect(fake.uploads[0]?.metadata).toMatchObject({
			source_url: PAGE.source_url,
			commit: "abc123",
		});
		const notes = events.filter((event) => event.kind === "note");
		expect(notes).toHaveLength(1);
		expect(notes[0]?.payload).toMatchObject({ action: "docs.ingest", dataset_id: "ds-berlin-agent-substrate" });
	});

	test("refuses on a redactor finding and never uploads", async () => {
		const fake = new RagflowFake();
		const { events, ingest } = harness(fake);
		const outcome = await ingest({
			dataset: "agent-substrate",
			pages: [{ ...PAGE, body: "paste sk-proj-abcdefghij1234567890 here" }],
		});
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toBe("secret-findings");
		// A refusal that touched nothing is not a state change (Greptile round 2).
		expect(outcome.changed).toBe(false);
		expect(outcome.rules).toContain("openai-proj");
		expect(fake.uploads).toHaveLength(0);
		const warnings = events.filter((event) => event.kind === "warning");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.payload).toMatchObject({ action: "docs.ingest", status: "refused" });
		expect(JSON.stringify(warnings[0]?.payload)).not.toContain("sk-proj-");
	});

	test("refuses a page without a source URL", async () => {
		const fake = new RagflowFake();
		const { ingest } = harness(fake);
		const outcome = await ingest({ dataset: "agent-substrate", pages: [{ path: PAGE.path, body: PAGE.body }] });
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toBe("no-source-url");
		expect(fake.uploads).toHaveLength(0);
	});

	test("refuses a path outside the configured roots", async () => {
		const fake = new RagflowFake();
		const { ingest } = harness(fake);
		const outcome = await ingest({
			dataset: "agent-substrate",
			pages: [{ ...PAGE, path: "../secrets.txt" }],
		});
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toBe("outside-roots");
		expect(fake.uploads).toHaveLength(0);
	});

	test("refuses a page over 1 MB and a call over 5 MB", async () => {
		const fake = new RagflowFake();
		const { ingest } = harness(fake);
		const big = await ingest({
			dataset: "agent-substrate",
			pages: [{ ...PAGE, body: `x${"y".repeat(1_000_000)}` }],
		});
		if (big.ok) throw new Error("expected a page refusal");
		expect(big.reason).toBe("page-too-large");

		const pages = [1, 2, 3, 4, 5, 6].map((n) => ({ ...PAGE, path: `docs/page-${n}.md`, body: `z${"y".repeat(900_000)}` }));
		const wide = await ingest({ dataset: "agent-substrate", pages });
		if (wide.ok) throw new Error("expected a call refusal");
		expect(wide.reason).toBe("call-too-large");
		expect(fake.uploads).toHaveLength(0);
	});

	test("refuses unauthenticated callers and VM guests before any network call", async () => {
		const anonymous = new RagflowFake();
		const anonymousHarness = harness(anonymous, { surface: null });
		const denied = await anonymousHarness.ingest({ dataset: "agent-substrate", pages: [PAGE] });
		if (denied.ok) throw new Error("expected a refusal");
		expect(denied.reason).toBe("unauthenticated");
		expect(anonymous.requests).toHaveLength(0);

		const guest = new RagflowFake();
		const guestHarness = harness(guest, { vmGuest: true });
		const refused = await guestHarness.ingest({ dataset: "agent-substrate", pages: [PAGE] });
		if (refused.ok) throw new Error("expected a refusal");
		expect(refused.reason).toBe("vm-guest");
		expect(guest.requests).toHaveLength(0);
	});
});

describe("docs_ingest idempotency and images", () => {
	test("skips unchanged hashes and replaces changed ones", async () => {
		const fake = new RagflowFake();
		const { ingest } = harness(fake);
		const first = await ingest({ dataset: "agent-substrate", pages: [PAGE] });
		if (!first.ok) throw new Error(`expected ingest: ${first.reason}`);
		const again = await ingest({ dataset: "agent-substrate", pages: [PAGE] });
		if (!again.ok) throw new Error(`expected skip: ${again.reason}`);
		expect(again.results[0]?.status).toBe("unchanged");
		expect(again.changed).toBe(false);
		expect(fake.uploads).toHaveLength(1);

		const changed = await ingest({ dataset: "agent-substrate", pages: [{ ...PAGE, body: `${PAGE.body} More.` }] });
		if (!changed.ok) throw new Error(`expected replace: ${changed.reason}`);
		expect(changed.results[0]?.status).toBe("replaced");
		expect(fake.uploads).toHaveLength(2);
	});

	test("strips remote images pre-upload and counts them", async () => {
		const fake = new RagflowFake();
		const { ingest } = harness(fake);
		const outcome = await ingest({
			dataset: "agent-substrate",
			pages: [
				{
					...PAGE,
					body: 'See <img src="https://example.com/logo.png"> and ![arch](https://example.com/a.png) plus ![local](./b.png).',
				},
			],
		});
		if (!outcome.ok) throw new Error(`expected ingest: ${outcome.reason}`);
		expect(outcome.stripped_images).toBe(2);
		expect(fake.uploads[0]?.content).not.toContain("https://example.com/logo.png");
		expect(fake.uploads[0]?.content).toContain("./b.png");
	});

	test("a parse that never finishes is a timeout refusal", async () => {
		const fake = new RagflowFake();
		fake.parseBehavior = "never";
		const { ingest } = harness(fake);
		const outcome = await ingest({ dataset: "agent-substrate", pages: [PAGE] });
		if (outcome.ok) throw new Error("expected a timeout");
		expect(outcome.reason).toBe("parse-timeout");
	});
});

describe("stripRemoteImages", () => {
	test("counts tags and markdown images, keeps local paths", () => {
		const stripped = stripRemoteImages('A <img src="http://x/y.png"> B ![c](https://x/z.png) D ![e](./f.png)');
		expect(stripped.stripped).toBe(2);
		expect(stripped.body).toContain("./f.png");
	});
});

describe("docs_ingest wiring", () => {
	test("Substrate.ingestDocs ingests and refuses anonymous callers", async () => {
		const fake = new RagflowFake();
		const live = new Substrate(loadConfig({ RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k" }), {
			index: null,
			greptime: null,
			ragflowFetch: fake.fetch,
		});
		const reply = await live.ingestDocs({ dataset: "agent-substrate", pages: [PAGE] }, "omp");
		if (!reply.ok) throw new Error(`expected ingest: ${reply.reason}`);
		expect(reply.results[0]?.status).toBe("ingested");

		const denied = await live.ingestDocs({ dataset: "agent-substrate", pages: [PAGE] }, null);
		if (denied.ok) throw new Error("expected a refusal");
		expect(denied.reason).toBe("unauthenticated");
	});

	test("docs_ingest is callable over MCP and refusals are errors", async () => {
		const fake = new RagflowFake();
		const substrate = new Substrate(loadConfig({ RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k" }), {
			index: null,
			greptime: null,
			ragflowFetch: fake.fetch,
		});
		const server = createMcpServer(substrate, "omp");
		const client = new Client({ name: "substrate-test", version: "0.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		try {
			const tools = (await client.listTools()).tools;
			expect(tools.some((tool) => tool.name === "docs_ingest")).toBe(true);
			const result = await client.callTool({ name: "docs_ingest", arguments: { dataset: "agent-substrate", pages: [PAGE] } });
			const content = result.content as Array<{ type: string; text?: string }>;
			const reply: unknown = JSON.parse(content[0]?.text ?? "null");
			const first =
				reply !== null && typeof reply === "object" && "results" in reply && Array.isArray(reply.results)
					? reply.results[0]
					: null;
			const state = first !== null && typeof first === "object" && "status" in first ? first.status : null;
			expect(state).toBe("ingested");

			const refused = await client.callTool({
				name: "docs_ingest",
				arguments: { dataset: "agent-substrate", pages: [{ path: PAGE.path, body: PAGE.body }] },
			});
			expect(refused.isError).toBe(true);
		} finally {
			await client.close();
			await server.close();
		}
	});
});

describe("docs_ingest review hardening", () => {
	test("refuses a secret smuggled in the heading metadata", async () => {
		const fake = new RagflowFake();
		const { events, ingest } = harness(fake);
		const outcome = await ingest({
			dataset: "agent-substrate",
			pages: [{ ...PAGE, heading_path: "sk-proj-abcdefghij1234567890" }],
		});
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toBe("secret-findings");
		expect(outcome.rules).toContain("openai-proj");
		expect(fake.uploads).toHaveLength(0);
		expect(JSON.stringify(events)).not.toContain("sk-proj-");
	});

	test("refuses dot-segment escapes and out-of-roots real paths", async () => {
		const fake = new RagflowFake();
		const { ingest } = harness(fake);
		const escaped = await ingest({ dataset: "agent-substrate", pages: [{ ...PAGE, path: "docs/../private.md" }] });
		if (escaped.ok) throw new Error("expected a refusal");
		expect(escaped.reason).toBe("outside-roots");
		const linked = await ingest({
			dataset: "agent-substrate",
			pages: [{ ...PAGE, real_path: "../elsewhere.md" }],
		});
		if (linked.ok) throw new Error("expected a refusal");
		expect(linked.reason).toBe("outside-roots");
		expect(fake.uploads).toHaveLength(0);
	});

	test("refuses a secret in graph strings on the LightRAG path before any upload", async () => {
		const fake = new RagflowFake();
		const events: EventInput[] = [];
		const outcome = await ingestDocs(
			{
				config: null,
				backend: "lightrag",
				lightragConfig: { url: "http://lightrag.test" },
				lightragDatasets: { list: async () => ({ ok: true, datasets: [{ id: "agent-substrate", name: "agent-substrate" }] }), invalidate: () => undefined },
				lightragFetch: fake.fetch,
				seen: new Map<string, IngestRecord>(),
				poll: { intervalMs: 0 },
				emit: async (event: EventInput): Promise<unknown> => {
					events.push(event);
					return { stored: false };
				},
				surface: "omp",
			},
			{ dataset: "agent-substrate", pages: [{ ...PAGE, graph: { phase: "docs", entities: ["sk-proj-abcdefghij1234567890"], relations: [] } }] },
		);
		if (outcome.ok) throw new Error("expected a refusal");
		expect(outcome.reason).toMatch(/^secret-findings/);
		expect(fake.uploads).toHaveLength(0);
		expect(JSON.stringify(events)).not.toContain("sk-proj-");
	});

	test("keys records by dataset so a second dataset ingests and the first still skips", async () => {
		const fake = new RagflowFake();
		const { ingest } = harness(fake);
		const first = await ingest({ dataset: "agent-substrate", pages: [PAGE] });
		if (!first.ok) throw new Error(`expected ingest: ${first.reason}`);
		const other = await ingest({ dataset: "programming-desk", pages: [PAGE] });
		if (!other.ok) throw new Error(`expected ingest: ${other.reason}`);
		expect(other.results[0]?.status).toBe("ingested");
		const again = await ingest({ dataset: "agent-substrate", pages: [PAGE] });
		if (!again.ok) throw new Error(`expected skip: ${again.reason}`);
		expect(again.results[0]?.status).toBe("unchanged");
		expect(fake.uploads).toHaveLength(2);
	});

	test("concurrent retries for one page share a single upload", async () => {
		const fake = new RagflowFake();
		const locks = new Map<string, { task: Promise<PageSettlement>; sha: string }>();
		const left = harness(fake, { locks, poll: { intervalMs: 0 } });
		const right = harness(fake, { locks, seen: left.seen, poll: { intervalMs: 0 } });
		const [a, b] = await Promise.all([
			left.ingest({ dataset: "agent-substrate", pages: [PAGE] }),
			right.ingest({ dataset: "agent-substrate", pages: [PAGE] }),
		]);
		if (!a.ok || !b.ok) throw new Error("expected both to settle");
		expect(fake.uploads).toHaveLength(1);
		expect(a.results[0]?.document_id).toBe(b.results[0]?.document_id);
	});

	test("a concurrent retry with different content uploads its own page", async () => {
		const fake = new RagflowFake();
		const locks = new Map<string, { task: Promise<PageSettlement>; sha: string }>();
		const left = harness(fake, { locks, poll: { intervalMs: 0 } });
		const right = harness(fake, { locks, seen: left.seen, poll: { intervalMs: 0 } });
		const [a, b] = await Promise.all([
			left.ingest({ dataset: "agent-substrate", pages: [PAGE] }),
			right.ingest({ dataset: "agent-substrate", pages: [{ ...PAGE, body: `${PAGE.body} Newer.` }] }),
		]);
		if (!a.ok || !b.ok) throw new Error("expected both to settle");
		expect(fake.uploads).toHaveLength(2);
		expect(a.results[0]?.status).toBe("ingested");
		expect(b.results[0]?.status).toBe("replaced");
		expect(b.results[0]?.superseded_document_id).toBe(a.results[0]?.document_id);
	});

	test("a replacement reports the superseded document id", async () => {
		const fake = new RagflowFake();
		const { events, ingest } = harness(fake);
		const first = await ingest({ dataset: "agent-substrate", pages: [PAGE] });
		if (!first.ok) throw new Error(`expected ingest: ${first.reason}`);
		const changed = await ingest({ dataset: "agent-substrate", pages: [{ ...PAGE, body: `${PAGE.body} More.` }] });
		if (!changed.ok) throw new Error(`expected replace: ${changed.reason}`);
		expect(changed.results[0]?.status).toBe("replaced");
		expect(changed.results[0]?.superseded_document_id).toBe(first.results[0]?.document_id);
		const notes = events.filter((event) => event.kind === "note");
		const payload = notes[notes.length - 1]?.payload ?? {};
		expect(payload.superseded_document_ids).toEqual([first.results[0]?.document_id]);
	});
});

describe("ingest record persistence", () => {
	test("records round-trip through the state file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "substrate-docs-state-"));
		try {
			const file = join(dir, "ingest.json");
			const seen = new Map<string, IngestRecord>([
				["ds-1::https://example.com/a", { sha: "s1", dataset_id: "ds-1", source_url: "https://example.com/a", document_id: "doc-1", version: 1 }],
			]);
			await saveIngestRecords(file, seen);
			const loaded = await loadIngestRecords(file);
			expect(loaded.problem).toBeUndefined();
			expect(loaded.records.get("ds-1::https://example.com/a")?.document_id).toBe("doc-1");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a missing or corrupt file means an empty map, never a throw", async () => {
		const dir = mkdtempSync(join(tmpdir(), "substrate-docs-state-"));
		try {
			const missing = await loadIngestRecords(join(dir, "absent.json"));
			expect(missing.records.size).toBe(0);
			expect(missing.problem).toBeUndefined();
			const corrupt = join(dir, "corrupt.json");
			writeFileSync(corrupt, "not json{{{");
			const loaded = await loadIngestRecords(corrupt);
			expect(loaded.records.size).toBe(0);
			expect(typeof loaded.problem).toBe("string");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a restarted server skips pages its state file already records", async () => {
		const dir = mkdtempSync(join(tmpdir(), "substrate-docs-state-"));
		try {
			const file = join(dir, "ingest.json");
			const env = { RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k", SUBSTRATE_DOCS_STATE_FILE: file };
			const fake = new RagflowFake();
			const first = new Substrate(loadConfig(env), { index: null, greptime: null, ragflowFetch: fake.fetch });
			const ingested = await first.ingestDocs({ dataset: "agent-substrate", pages: [PAGE] }, "omp");
			if (!ingested.ok) throw new Error(`expected ingest: ${ingested.reason}`);
			const second = new Substrate(loadConfig(env), { index: null, greptime: null, ragflowFetch: fake.fetch });
			const skipped = await second.ingestDocs({ dataset: "agent-substrate", pages: [PAGE] }, "omp");
			if (!skipped.ok) throw new Error(`expected skip: ${skipped.reason}`);
			expect(skipped.results[0]?.status).toBe("unchanged");
			expect(fake.uploads).toHaveLength(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("scanIngestPages", () => {
	test("an oversize page is stat-checked, never read, and counted only by its absence", async () => {
		const root = mkdtempSync(join(tmpdir(), "substrate-scan-size-"));
		try {
			mkdirSync(join(root, "docs"), { recursive: true });
			writeFileSync(join(root, "docs", "huge.md"), "x".repeat(INGEST_PAGE_MAX_BYTES + 1));
			writeFileSync(join(root, "docs", "small.md"), "small enough");
			// The fs stub records every read the sweep makes, so the proof that
			// the cap applies before any read is that the oversize file's path
			// never appears in it.
			const reads: string[] = [];
			const io: ScanIo = {
				...nodeIo,
				readFile: (path, options) => {
					reads.push(String(path));
					return nodeIo.readFile(path, options);
				},
			};
			const pages = await scanIngestPages(root, ["docs/"], io);
			expect(pages.map((page) => page.path)).toEqual(["docs/small.md"]);
			expect(reads.some((path) => path.endsWith("huge.md"))).toBe(false);
			// A sweep of only oversize files comes back empty, which the guarded
			// ingest refuses as no-pages.
			expect(await scanIngestPages(root, ["docs/huge.md"], io)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a root that is itself a link is skipped, never followed", async () => {
		const root = mkdtempSync(join(tmpdir(), "substrate-scan-root-"));
		const outside = mkdtempSync(join(tmpdir(), "substrate-scan-out-"));
		try {
			writeFileSync(join(outside, "secret.md"), "outside the checkout");
			mkdirSync(join(root, "docs"), { recursive: true });
			writeFileSync(join(root, "docs", "real.md"), "inside");
			// Links used AS roots — a file link, a directory link bare, and the
			// same directory link in sweep form — are skipped exactly like links
			// found inside the sweep: a link can point outside the checkout, and
			// the roots guards have no real path to check it against.
			symlinkSync(join(outside, "secret.md"), join(root, "linked.md"));
			symlinkSync(join(root, "docs"), join(root, "linked-dir"));
			const pages = await scanIngestPages(root, ["linked.md", "linked-dir", "linked-dir/", "docs/"]);
			expect(pages.map((page) => page.path)).toEqual(["docs/real.md"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});
});

describe("agent-skills checkout roots and scan", () => {
	test("a folder whose name fails the skill-name rule is not a skill, even with SKILL.md and references/", async () => {
		const root = mkdtempSync(join(tmpdir(), "substrate-skills-name-"));
		try {
			mkdirSync(join(root, "demo-skill", "references"), { recursive: true });
			writeFileSync(join(root, "demo-skill", "SKILL.md"), "Demo skill body.\n");
			writeFileSync(join(root, "demo-skill", "references", "api.md"), "The demo API reference.\n");
			// Folders the library projector never takes as skills: their names fail SKILL_NAME_RE (upper case,
			// an underscore, a leading hyphen), yet each holds a SKILL.md and a references tree.
			for (const name of ["Bad_Name", "-leading", "UPPER"]) {
				mkdirSync(join(root, name, "references"), { recursive: true });
				writeFileSync(join(root, name, "SKILL.md"), "Not a valid skill name.\n");
				writeFileSync(join(root, name, "references", "api.md"), "An unnamed reference.\n");
			}
			const roots = await skillsCheckoutRoots(root);
			expect(roots).toEqual(["demo-skill/SKILL.md", "demo-skill/references/"]);
			const pages = await readSkillsCheckoutPages(root, roots);
			expect(pages.map((page) => page.path)).toEqual(["demo-skill/SKILL.md", "demo-skill/references/api.md"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a directory without SKILL.md contributes no roots, so its notes never become searchable", async () => {
		const root = mkdtempSync(join(tmpdir(), "substrate-skills-roots-"));
		try {
			mkdirSync(join(root, "demo-skill", "references"), { recursive: true });
			writeFileSync(join(root, "demo-skill", "SKILL.md"), "Demo skill body.\n");
			writeFileSync(join(root, "demo-skill", "references", "api.md"), "The demo API reference.\n");
			// Not skills: a directory with a references tree but no SKILL.md, a dot-directory, and a bare file.
			mkdirSync(join(root, "notes", "references"), { recursive: true });
			writeFileSync(join(root, "notes", "references", "api.md"), "Notes, not a skill.\n");
			mkdirSync(join(root, ".hidden"));
			writeFileSync(join(root, ".hidden", "SKILL.md"), "Hidden.\n");
			writeFileSync(join(root, "README.md"), "The checkout readme.\n");
			const roots = await skillsCheckoutRoots(root);
			expect(roots).toEqual(["demo-skill/SKILL.md", "demo-skill/references/"]);
			const pages = await readSkillsCheckoutPages(root, roots);
			expect(pages.map((page) => page.path)).toEqual(["demo-skill/SKILL.md", "demo-skill/references/api.md"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a skill with no references directory yields its SKILL.md alone; the missing tree is not an error", async () => {
		const root = mkdtempSync(join(tmpdir(), "substrate-skills-bare-"));
		try {
			mkdirSync(join(root, "demo-skill"));
			writeFileSync(join(root, "demo-skill", "SKILL.md"), "Demo skill body.\n");
			const pages = await readSkillsCheckoutPages(root, await skillsCheckoutRoots(root));
			expect(pages.map((page) => page.path)).toEqual(["demo-skill/SKILL.md"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("an unreadable references directory fails the skills scan; the skip scan keeps the rest", async () => {
		const root = mkdtempSync(join(tmpdir(), "substrate-skills-denied-"));
		try {
			mkdirSync(join(root, "demo-skill", "references"), { recursive: true });
			writeFileSync(join(root, "demo-skill", "SKILL.md"), "Demo skill body.\n");
			writeFileSync(join(root, "demo-skill", "references", "api.md"), "The demo API reference.\n");
			const io: ScanIo = {
				...nodeIo,
				readdir: (path, options) => (path.endsWith(join("demo-skill", "references")) ? Promise.reject(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })) : nodeIo.readdir(path, options)),
			};
			const roots = ["demo-skill/SKILL.md", "demo-skill/references/"];
			await expect(readSkillsCheckoutPages(root, roots, io)).rejects.toThrow("EACCES");
			const kept = await scanIngestPages(root, roots, io);
			expect(kept.map((page) => page.path)).toEqual(["demo-skill/SKILL.md"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("an unreadable SKILL.md check fails the roots listing instead of dropping the skill", async () => {
		const root = mkdtempSync(join(tmpdir(), "substrate-skills-manifest-"));
		try {
			mkdirSync(join(root, "demo-skill"));
			writeFileSync(join(root, "demo-skill", "SKILL.md"), "Demo skill body.\n");
			const io: Pick<ScanIo, "readdir" | "lstat"> = {
				readdir: nodeIo.readdir,
				lstat: (path) => (path.endsWith("SKILL.md") ? Promise.reject(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })) : nodeIo.lstat(path)),
			};
			await expect(skillsCheckoutRoots(root, io)).rejects.toThrow("EACCES");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("docs_ingest expected_version (memory's contract)", () => {
	// Each test builds its own harness: its own record map and fake, so no state is shared between them.
	test("a stale expected_version is refused with nothing written: the stored record is byte-identical", async () => {
		const fake = new RagflowFake();
		const { events, seen, ingest } = harness(fake);
		const first = await ingest({ dataset: "agent-substrate", pages: [PAGE] });
		if (!first.ok) throw new Error(`expected ingest: ${first.reason}`);
		const recordBefore = JSON.stringify([...seen.entries()]);
		const uploadsBefore = fake.uploads.length;

		const stale = await ingest({ dataset: "agent-substrate", pages: [{ ...PAGE, body: `${PAGE.body} Stale.`, expected_version: 7 }] });
		if (stale.ok) throw new Error("expected a version.stale refusal");
		expect(stale).toMatchObject({
			refused: true,
			reason: "version.stale",
			page: PAGE.path,
			current_version: 1,
			conflict_with: first.results[0]?.document_id,
			changed: false,
		});
		expect(stale.remedy).toContain("current_version");
		expect(fake.uploads).toHaveLength(uploadsBefore);
		expect(JSON.stringify([...seen.entries()])).toBe(recordBefore);
		const warnings = events.filter((event) => event.kind === "warning");
		expect(warnings.at(-1)?.payload).toMatchObject({ action: "docs.ingest", status: "refused", reason: "version.stale" });
	});

	test("a stale docs write is refused with outcome conflict and uploads nothing", async () => {
		const fake = new RagflowFake();
		const { ingest } = harness(fake);
		const first = await ingest({ dataset: "agent-substrate", pages: [PAGE] });
		if (!first.ok) throw new Error(`expected ingest: ${first.reason}`);
		const uploadsBefore = fake.uploads.length;

		const stale = await ingest({ dataset: "agent-substrate", pages: [{ ...PAGE, body: `${PAGE.body} Stale.`, expected_version: 7 }] });
		if (stale.ok) throw new Error("expected a version.stale refusal");
		expect(stale).toMatchObject({ refused: true, reason: "version.stale", outcome: "conflict" });
		expect(fake.uploads).toHaveLength(uploadsBefore);
	});

	test("a matching expected_version is accepted and the record version increments", async () => {
		const fake = new RagflowFake();
		const { seen, ingest } = harness(fake);
		const first = await ingest({ dataset: "agent-substrate", pages: [PAGE] });
		if (!first.ok) throw new Error(`expected ingest: ${first.reason}`);
		expect([...seen.values()][0]?.version).toBe(1);

		const replaced = await ingest({ dataset: "agent-substrate", pages: [{ ...PAGE, body: `${PAGE.body} Second.`, expected_version: 1 }] });
		if (!replaced.ok) throw new Error(`expected replace: ${replaced.reason}`);
		expect(replaced.results[0]?.status).toBe("replaced");
		expect(fake.uploads).toHaveLength(2);
		expect([...seen.values()][0]?.version).toBe(2);

		// Version 1 is now stale: the caller must re-submit against the version it was told.
		const again = await ingest({ dataset: "agent-substrate", pages: [{ ...PAGE, body: `${PAGE.body} Third.`, expected_version: 1 }] });
		expect(again).toMatchObject({ ok: false, reason: "version.stale", current_version: 2 });
	});

	test("an absent expected_version keeps today's behaviour: the write proceeds and the version still counts", async () => {
		const fake = new RagflowFake();
		const { seen, ingest } = harness(fake);
		await ingest({ dataset: "agent-substrate", pages: [PAGE] });
		const replaced = await ingest({ dataset: "agent-substrate", pages: [{ ...PAGE, body: `${PAGE.body} Second.` }] });
		if (!replaced.ok) throw new Error(`expected replace: ${replaced.reason}`);
		expect(replaced.results[0]?.status).toBe("replaced");
		expect(fake.uploads).toHaveLength(2);
		expect([...seen.values()][0]?.version).toBe(2);

		const skipped = await ingest({ dataset: "agent-substrate", pages: [{ ...PAGE, body: `${PAGE.body} Second.` }] });
		if (!skipped.ok) throw new Error(`expected skip: ${skipped.reason}`);
		expect(skipped.results[0]?.status).toBe("unchanged");
		expect([...seen.values()][0]?.version).toBe(2);
	});
});

describe("docs_ingest expected_version on the LightRAG plane", () => {
	test("a page expecting a version nothing has on record is refused before any upload", async () => {
		const fake = new RagflowFake();
		const events: EventInput[] = [];
		const seen = new Map<string, IngestRecord>();
		const outcome = await ingestDocs(
			{
				config: null,
				backend: "lightrag",
				lightragConfig: { url: "http://lightrag.test" },
				lightragDatasets: { list: async () => ({ ok: true, datasets: [{ id: "agent-substrate", name: "agent-substrate" }] }), invalidate: () => undefined },
				lightragFetch: fake.fetch,
				seen,
				poll: { intervalMs: 0 },
				emit: async (event: EventInput): Promise<unknown> => {
					events.push(event);
					return { stored: false };
				},
				surface: "omp",
			},
			{ dataset: "agent-substrate", pages: [{ ...PAGE, expected_version: 7 }] },
		);
		if (outcome.ok) throw new Error("expected a version.stale refusal");
		expect(outcome).toMatchObject({ refused: true, reason: "version.stale", page: PAGE.path, current_version: null, changed: false });
		expect(fake.uploads).toHaveLength(0);
		expect(seen.size).toBe(0);
	});
});

describe("docs_ingest atomic batch", () => {
	const OTHER = { ...PAGE, path: "docs/other.md", source_url: "https://example.com/agent-substrate/other" };
	const SECOND = { ...PAGE, path: "docs/data-planes-2.md" };

	test("a batch with one stale page is refused whole: the matching page is neither uploaded nor recorded", async () => {
		const fake = new RagflowFake();
		const { events, seen, ingest } = harness(fake);
		const first = await ingest({ dataset: "agent-substrate", pages: [PAGE, OTHER] });
		if (!first.ok) throw new Error(`expected ingest: ${first.reason}`);
		const recordBefore = JSON.stringify([...seen.entries()]);
		const uploadsBefore = fake.uploads.length;

		const batch = await ingest({
			dataset: "agent-substrate",
			pages: [
				{ ...PAGE, body: `${PAGE.body} Matching.`, expected_version: 1 },
				{ ...OTHER, body: `${OTHER.body} Stale.`, expected_version: 7 },
			],
		});
		if (batch.ok) throw new Error("expected a version.stale refusal");
		expect(batch).toMatchObject({
			refused: true,
			reason: "version.stale",
			page: OTHER.path,
			current_version: 1,
			conflict_with: first.results[1]?.document_id,
			changed: false,
		});
		expect(fake.uploads).toHaveLength(uploadsBefore);
		expect(JSON.stringify([...seen.entries()])).toBe(recordBefore);
		expect(events.filter((event) => event.kind === "warning").at(-1)?.payload).toMatchObject({ reason: "version.stale" });
	});

	test("a batch whose pages all match is stored, each record advancing one version", async () => {
		const fake = new RagflowFake();
		const { seen, ingest } = harness(fake);
		const first = await ingest({ dataset: "agent-substrate", pages: [PAGE, OTHER] });
		if (!first.ok) throw new Error(`expected ingest: ${first.reason}`);
		const replaced = await ingest({
			dataset: "agent-substrate",
			pages: [
				{ ...PAGE, body: `${PAGE.body} Next.`, expected_version: 1 },
				{ ...OTHER, body: `${OTHER.body} Next.`, expected_version: 1 },
			],
		});
		if (!replaced.ok) throw new Error(`expected replace: ${replaced.reason}`);
		expect(replaced.results.map((result) => result.status)).toEqual(["replaced", "replaced"]);
		expect(replaced.changed).toBe(true);
		expect(fake.uploads).toHaveLength(4);
		expect([...seen.values()].map((record) => record.version)).toEqual([2, 2]);
	});

	test("a later page of one source URL is checked against the version an earlier page of the batch leaves", async () => {
		const fake = new RagflowFake();
		const { seen, ingest } = harness(fake);
		const first = await ingest({ dataset: "agent-substrate", pages: [PAGE] });
		if (!first.ok) throw new Error(`expected ingest: ${first.reason}`);
		const recordBefore = JSON.stringify([...seen.entries()]);
		const uploadsBefore = fake.uploads.length;

		// The first page would store version 2; the second, still expecting 1, must refuse the whole call.
		const batch = await ingest({
			dataset: "agent-substrate",
			pages: [
				{ ...PAGE, body: `${PAGE.body} One.`, expected_version: 1 },
				{ ...SECOND, source_url: PAGE.source_url, body: `${PAGE.body} Two.`, expected_version: 1 },
			],
		});
		expect(batch).toMatchObject({ ok: false, refused: true, reason: "version.stale", page: SECOND.path, current_version: 1, changed: false });
		expect(fake.uploads).toHaveLength(uploadsBefore);
		expect(JSON.stringify([...seen.entries()])).toBe(recordBefore);
	});

	test("a repeated URL whose later page is stale against the batch reports the saved version and conflict_with, and stores nothing", async () => {
		const fake = new RagflowFake();
		const { events, seen, ingest } = harness(fake);
		await ingest({ dataset: "agent-substrate", pages: [PAGE] });
		const replaced = await ingest({ dataset: "agent-substrate", pages: [{ ...PAGE, body: `${PAGE.body} Second.`, expected_version: 1 }] });
		if (!replaced.ok) throw new Error(`expected replace: ${replaced.reason}`);
		const savedDocumentId = [...seen.values()][0]?.document_id;
		const recordBefore = JSON.stringify([...seen.entries()]);
		const uploadsBefore = fake.uploads.length;

		// The first page would store version 3, so the second page's expected 2 is stale against the batch. The saved record is version 2.
		const batch = await ingest({
			dataset: "agent-substrate",
			pages: [
				{ ...PAGE, body: `${PAGE.body} One.`, expected_version: 2 },
				{ ...SECOND, source_url: PAGE.source_url, body: `${PAGE.body} Two.`, expected_version: 2 },
			],
		});
		if (batch.ok) throw new Error("expected a version.stale refusal");
		expect(batch).toMatchObject({
			refused: true,
			reason: "version.stale",
			page: SECOND.path,
			current_version: 2,
			conflict_with: savedDocumentId,
			verified_persisted: false,
			changed: false,
		});
		expect(fake.uploads).toHaveLength(uploadsBefore);
		expect(JSON.stringify([...seen.entries()])).toBe(recordBefore);
		expect(events.filter((event) => event.kind === "warning").at(-1)?.payload).toMatchObject({ reason: "version.stale" });
	});

	test("a batch may chain expected versions on one source URL", async () => {
		const fake = new RagflowFake();
		const { seen, ingest } = harness(fake);
		const first = await ingest({ dataset: "agent-substrate", pages: [PAGE] });
		if (!first.ok) throw new Error(`expected ingest: ${first.reason}`);
		const chained = await ingest({
			dataset: "agent-substrate",
			pages: [
				{ ...PAGE, body: `${PAGE.body} One.`, expected_version: 1 },
				{ ...SECOND, source_url: PAGE.source_url, body: `${PAGE.body} Two.`, expected_version: 2 },
			],
		});
		if (!chained.ok) throw new Error(`expected chained ingest: ${chained.reason}`);
		expect(chained.results.map((result) => result.status)).toEqual(["replaced", "replaced"]);
		expect(fake.uploads).toHaveLength(3);
		expect([...seen.values()][0]?.version).toBe(3);
	});

	test("a call that cannot take its dataset's lock in time is refused with nothing written, and the lock frees afterwards", async () => {
		const fake = new RagflowFake();
		let openGate!: () => void;
		const gate = new Promise<void>((resolve) => {
			openGate = resolve;
		});
		// The holder's requests wait on the gate, so its call keeps the dataset lock until the gate opens.
		const heldFetch: FetchLike = async (input, init) => {
			await gate;
			return fake.fetch(input, init);
		};
		const holder = harness(fake, { fetchImpl: heldFetch });
		const holding = holder.ingest({ dataset: "agent-substrate", pages: [PAGE] });

		const waiter = harness(fake, { datasetLockWaitMs: 20 });
		const waitedOut = await waiter.ingest({ dataset: "agent-substrate", pages: [OTHER] });
		if (waitedOut.ok) throw new Error("expected the waiter to time out");
		expect(waitedOut).toMatchObject({ reason: "dataset-lock-timeout", changed: false });
		expect(fake.uploads).toHaveLength(0);
		expect(waiter.seen.size).toBe(0);

		openGate();
		const held = await holding;
		if (!held.ok) throw new Error(`expected the holder to store: ${held.reason}`);
		expect(fake.uploads).toHaveLength(1);

		const after = await waiter.ingest({ dataset: "agent-substrate", pages: [OTHER] });
		if (!after.ok) throw new Error(`expected the lock to be free: ${after.reason}`);
		expect(after.results[0]?.status).toBe("ingested");
	});
});

describe("a refresh's ingest calls (split under the call limit)", () => {
	/** Six pages of 900 KB each: 5.4 MB in total, every page under the 1 MB page limit. */
	function wideSkills() {
		return [1, 2, 3, 4, 5, 6].map((n) => ({
			path: `docs/skill-${n}.md`,
			source_url: `file:///checkout/docs/skill-${n}.md`,
			body: `skill-${n} ${"y".repeat(900_000)}`,
		}));
	}

	test("batchIngestPages keeps every call under the call limit, in page order, with each page in exactly one call", () => {
		const pages = wideSkills();
		const batches = batchIngestPages(pages);
		expect(batches.length).toBeGreaterThan(1);
		for (const batch of batches) {
			const bytes = batch.reduce((sum, page) => sum + Buffer.byteLength(page.body, "utf8"), 0);
			expect(bytes).toBeLessThanOrEqual(INGEST_CALL_MAX_BYTES);
		}
		expect(batches.flat().map((page) => page.path)).toEqual(pages.map((page) => page.path));
	});

	test("preflightIngestPages refuses a page's secret before any call uploads, so earlier pages are not stored", async () => {
		const fake = new RagflowFake();
		const events: EventInput[] = [];
		const deps: IngestDeps = {
			config: CONFIG,
			emit: async (event: EventInput): Promise<unknown> => {
				events.push(event);
				return { stored: false };
			},
			surface: "omp",
			seen: new Map(),
			poll: { intervalMs: 0 },
			fetchImpl: fake.fetch,
		};
		const leaked = { ...PAGE, path: "docs/leaked.md", source_url: "file:///checkout/docs/leaked.md", body: "paste sk-proj-abcdefghij1234567890 here" };
		const reason = await preflightIngestPages(deps, { dataset: "agent-substrate", pages: [...wideSkills().slice(0, 2), leaked] });
		expect(reason).toBe("secret-findings");
		expect(fake.uploads).toHaveLength(0);
		expect(events).toHaveLength(1);
	});

	test("preflightIngestPages passes a clean set and refuses an empty one", async () => {
		const fake = new RagflowFake();
		const deps: IngestDeps = { config: CONFIG, emit: async (): Promise<unknown> => ({ stored: false }), surface: "omp", seen: new Map(), poll: { intervalMs: 0 }, fetchImpl: fake.fetch };
		expect(await preflightIngestPages(deps, { dataset: "agent-substrate", pages: wideSkills() })).toBeUndefined();
		expect(await preflightIngestPages(deps, { dataset: "agent-substrate", pages: [] })).toBe("no-pages");
		expect(fake.uploads).toHaveLength(0);
	});
});

describe("planning scan graph hints (LightRAG path)", () => {
	test("isPlanningPage admits only .planning markdown", () => {
		expect(isPlanningPage(".planning/PROJECT.md")).toBe(true);
		expect(isPlanningPage(".planning/phases/25-x/PLAN.md")).toBe(true);
		expect(isPlanningPage("docs/data-planes.md")).toBe(false);
		expect(isPlanningPage(".planning/diagram.png")).toBe(false);
		expect(isPlanningPage(".planning/../docs/escape.md")).toBe(false);
	});

	test("planningPhaseOf names the phase directory, else the planning path", () => {
		expect(planningPhaseOf(".planning/phases/25-x/PLAN.md")).toBe("25-x");
		expect(planningPhaseOf(".planning/PROJECT.md")).toBe("PROJECT");
		expect(planningPhaseOf("docs/data-planes.md")).toBe("docs/data-planes");
	});

	test("headings become entities with parent-child contains relations", () => {
		const hint = extractPlanningGraphHint(".planning/phases/25-x/PLAN.md", "# Phase plan\n\n## Access path\n");
		expect(hint?.phase).toBe("25-x");
		expect(hint?.entities).toEqual(["Phase plan", "Access path"]);
		expect(hint?.relations).toEqual([{ source: "Phase plan", target: "Access path", kind: "contains" }]);
	});

	test("markdown links become links-to from the enclosing heading, targets verbatim", () => {
		const hint = extractPlanningGraphHint(
			".planning/phases/25-x/PLAN.md",
			"# Phase plan\n\nImplements the [retriever](../docs/data-planes.md) for the phase.\n\n## Access path\n",
		);
		expect(hint?.relations).toEqual([
			{ source: "Phase plan", target: "Access path", kind: "contains" },
			{ source: "Phase plan", target: "../docs/data-planes.md", kind: "links-to" },
		]);
	});

	test("non-planning pages yield no hint; heading-less planning pages yield empty lists", () => {
		expect(extractPlanningGraphHint("docs/data-planes.md", "# Heading\n")).toBeUndefined();
		expect(extractPlanningGraphHint(".planning/note.md", "Just prose with a [link](target.md).\n")).toEqual({
			phase: "note",
			entities: [],
			relations: [{ source: "note", target: "target.md", kind: "links-to" }],
		});
	});

	test("fences and frontmatter contribute nothing; images and duplicate headings are skipped", () => {
		const hint = extractPlanningGraphHint(
			".planning/PROJECT.md",
			"---\ntitle: sample\n---\n\n```\n# Not a heading\n```\n\n# Real\n\n![diagram](img.png)\n\n# Real\n",
		);
		expect(hint?.entities).toEqual(["Real"]);
		expect(hint?.relations).toEqual([]);
	});

	test("scanIngestPages attaches graph hints to planning pages only", async () => {
		const root = mkdtempSync(join(tmpdir(), "substrate-scan-graph-"));
		try {
			mkdirSync(join(root, ".planning", "phase-a"), { recursive: true });
			mkdirSync(join(root, "docs"), { recursive: true });
			writeFileSync(join(root, ".planning", "phase-a", "PLAN.md"), "# Phase A\n\nImplements the [retriever](../docs/data-planes.md).\n");
			writeFileSync(join(root, "docs", "small.md"), "# Small\n");
			const pages = await scanIngestPages(root, ["docs/", ".planning/"]);
			expect(pages.map((page) => page.path).sort()).toEqual([".planning/phase-a/PLAN.md", "docs/small.md"]);
			const planning = pages.find((page) => page.path === ".planning/phase-a/PLAN.md");
			expect(planning?.graph).toEqual({
				phase: "phase-a",
				entities: ["Phase A"],
				relations: [{ source: "Phase A", target: "../docs/data-planes.md", kind: "links-to" }],
			});
			const docs = pages.find((page) => page.path === "docs/small.md");
			expect(docs).toBeDefined();
			expect("graph" in (docs as object)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("an oversize planning file is stat-checked, never read, and yields no hint", async () => {
		const root = mkdtempSync(join(tmpdir(), "substrate-scan-graph-size-"));
		try {
			mkdirSync(join(root, ".planning"), { recursive: true });
			writeFileSync(join(root, ".planning", "huge.md"), "x".repeat(INGEST_PAGE_MAX_BYTES + 1));
			const reads: string[] = [];
			const io: ScanIo = {
				...nodeIo,
				readFile: (path, options) => {
					reads.push(String(path));
					return nodeIo.readFile(path, options);
				},
			};
			const pages = await scanIngestPages(root, [".planning/"], io);
			expect(pages).toEqual([]);
			expect(reads.some((path) => path.endsWith("huge.md"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("ingest accepts call-level graphHints on the RAGFlow path unchanged", async () => {
		const fake = new RagflowFake();
		const { ingest } = harness(fake);
		const outcome = await ingest({
			dataset: "agent-substrate",
			commit: "abc123",
			pages: [PAGE],
			graphHints: [{ phase: "test", entities: ["substrate"], relations: [] }],
		});
		if (!outcome.ok) throw new Error(`expected ingest: ${outcome.reason}`);
		expect(outcome.results).toHaveLength(1);
		expect(outcome.results[0]?.status).toBe("ingested");
		expect(fake.uploads).toHaveLength(1);
	});
});

/**
 * A LightRAG stand-in for the ingest path. The upload route records each file it accepts (its content, source URL
 * and the graph the form carries) and answers 500 for any content `failUploadWhen` names. Scan and parse status
 * answer at once.
 */
class LightragFake {
	readonly uploads: Array<{ content: string; source_url: string; graph: string }> = [];
	failUploadWhen: ((content: string) => boolean) | null = null;
	readonly fetch: FetchLike = async (input, init) => {
		const url = new URL(String(input));
		if (init?.method === "POST" && url.pathname === "/documents/upload") {
			const form = init.body as FormData;
			const content = await (form.get("file") as Blob).text();
			if (this.failUploadWhen?.(content) === true) return Response.json({ detail: "upload refused" }, { status: 500 });
			const id = `trk-${this.uploads.length + 1}`;
			this.uploads.push({ content, source_url: String(form.get("source_url")), graph: String(form.get("graph_entities") ?? "") });
			return Response.json({ status: "success", data: { track_id: id } });
		}
		if (init?.method === "POST" && url.pathname === "/documents/scan") return Response.json({ status: "success" });
		if (url.pathname === "/documents/pipeline_status") return Response.json({ status: "idle" });
		return Response.json({ detail: "no route" }, { status: 404 });
	};
}

function lightragHarness(fake: LightragFake) {
	const seen = new Map<string, IngestRecord>();
	const deps: IngestDeps = {
		config: null,
		backend: "lightrag",
		lightragConfig: { url: "http://lightrag.test" },
		lightragDatasets: { list: async () => ({ ok: true, datasets: [{ id: "agent-substrate", name: "agent-substrate" }] }), invalidate: () => undefined },
		lightragFetch: fake.fetch,
		seen,
		poll: { intervalMs: 0 },
		emit: async (): Promise<unknown> => ({ stored: false }),
		surface: "omp",
	};
	return { seen, ingest: (input: IngestInput): Promise<IngestOutcome> => ingestDocs(deps, input) };
}

describe("docs_ingest on the LightRAG plane: failed writes and graph corrections", () => {
	test("a later page of a source URL is not written once an earlier page of that URL failed in the call", async () => {
		const fake = new LightragFake();
		fake.failUploadWhen = (content) => content.startsWith("First");
		const { seen, ingest } = lightragHarness(fake);
		const outcome = await ingest({
			dataset: "agent-substrate",
			pages: [
				{ ...PAGE, body: "First version of the data planes.", expected_version: 0 },
				{ ...PAGE, body: "Second version of the data planes.", expected_version: 1 },
				{ path: "docs/other.md", source_url: "https://example.com/agent-substrate/other", body: "An unrelated page." },
			],
		});
		if (!outcome.ok) throw new Error(`expected a partial ingest: ${outcome.reason}`);
		const [first, second, other] = outcome.results;
		expect(first).toMatchObject({ path: PAGE.path, status: "failed" });
		expect(first?.error).toMatch(/lightrag 500/);
		expect(second).toMatchObject({ path: PAGE.path, status: "failed" });
		expect(second?.error).toMatch(/earlier page/);
		expect(other).toMatchObject({ path: "docs/other.md", status: "ingested" });
		expect(fake.uploads.map((upload) => upload.content)).toEqual(["An unrelated page."]);
		expect(seen.size).toBe(1);
	});

	test("a graph correction with unchanged markdown is a change: the page re-uploads with the corrected graph", async () => {
		const fake = new LightragFake();
		const { ingest } = lightragHarness(fake);
		const page = (entity: string) => ({
			path: ".planning/phases/01-graph/PLAN.md",
			source_url: "file:///repo/.planning/phases/01-graph/PLAN.md",
			body: "# Plan\n\nThe plan body.",
			graph: { phase: "01-graph", entities: [entity], relations: [] },
		});
		const first = await ingest({ dataset: "agent-substrate", pages: [page("Draft entity")] });
		if (!first.ok) throw new Error(`expected ingest: ${first.reason}`);
		expect(first.results[0]?.status).toBe("ingested");

		const corrected = await ingest({ dataset: "agent-substrate", pages: [page("Corrected entity")] });
		if (!corrected.ok) throw new Error(`expected the correction to store: ${corrected.reason}`);
		expect(corrected.results[0]?.status).toBe("replaced");
		expect(fake.uploads).toHaveLength(2);
		expect(fake.uploads[1]?.graph).toContain("Corrected entity");

		const repeat = await ingest({ dataset: "agent-substrate", pages: [page("Corrected entity")] });
		if (!repeat.ok) throw new Error(`expected ingest: ${repeat.reason}`);
		expect(repeat.results[0]?.status).toBe("unchanged");
		expect(fake.uploads).toHaveLength(2);
	});
});
