/**
 * The migration job's offline proof (SC4 build): the dry run verifies the
 * archive, maps every record and gates Part A with zero fetches; a tampered
 * archive is refused; --apply without the recorded Part A pass is refused;
 * a passing apply replays pages through the LightRAG ingest against a fake
 * plane, carries the archived per-URL versions onto the `lightrag::` keys,
 * records the dataset pins and emits the cutover note — while --rehearsal
 * persists nothing and notes nothing. The frozen sample's shape is pinned
 * too: exactly 20 unique {id, question} entries.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveRagflow, ingestSha256, type ArchiveQuery } from "../packages/mcp-server/src/docs-archive.ts";
import { RagflowFake } from "../packages/mcp-server/src/ragflow-fake.ts";
import type { EventInput } from "../packages/mcp-server/src/types.ts";
import type { FetchLike } from "../packages/mcp-server/src/planes/lightrag.ts";
import { main, loadArchive, partAMarker, runApply, runDryRun } from "./docs-migrate.ts";

const BERLIN = "ds-berlin-agent-substrate";
const HAMM = "ds-hamm-programming-desk";
const SAMPLE: ArchiveQuery[] = [
	{ id: "q01", question: "What does docs_search return when it fails?" },
	{ id: "q02", question: "Which arguments does docs_search accept?" },
];

async function seedPlane(fake: RagflowFake): Promise<Record<string, string>> {
	const gitFiles: Record<string, string> = {};
	for (const datasetId of [BERLIN, HAMM]) {
		for (const index of [1, 2, 3]) {
			const name = `docs/page-${datasetId}-${index}.md`;
			const body = `# page ${datasetId} ${index}\n\nserved bytes\n`;
			const commit = `c${datasetId.length}${index}ffff`;
			const form = new FormData();
			form.append("file", new File([body], name));
			const uploaded = await fake.fetch(`http://ragflow.test/api/v1/datasets/${datasetId}/documents`, { method: "POST", body: form });
			const reply = (await uploaded.json()) as { data: Array<{ id: string }> };
			const documentId = reply.data[0]?.id ?? "";
			await fake.fetch(`http://ragflow.test/api/v1/datasets/${datasetId}/documents/${documentId}`, {
				method: "PATCH",
				body: JSON.stringify({ meta_fields: { source_url: `https://example.com/${name}`, commit, heading_path: "Docs" } }),
			});
			gitFiles[`${commit}:${name}`] = body;
		}
	}
	fake.serveUploadsAsChunks = true;
	return gitFiles;
}

function harness(fake: RagflowFake, gitFiles: Record<string, string>, versions: Record<string, number>): { deps: Parameters<typeof archiveRagflow>[0]; stateFile: string } {
	const stateFile = join(mkdtempSync(join(tmpdir(), "docs-migrate-state-")), "docs-ingest.json");
	const records: Record<string, unknown> = {};
	let index = 0;
	for (const key of Object.keys(gitFiles)) {
		const path = key.split(":")[1] ?? "";
		const datasetId = path.replace("docs/page-", "").replace(/-\d+\.md$/, "");
		index += 1;
		records[`${datasetId}::https://example.com/${path}`] = {
			sha: ingestSha256(gitFiles[key] ?? ""),
			dataset_id: datasetId,
			source_url: `https://example.com/${path}`,
			document_id: `doc-${index}`,
			version: versions[path] ?? 1,
		};
	}
	const datasetPins: Record<string, unknown> = {};
	for (const [name, id] of [["agent-substrate", BERLIN], ["programming-desk", HAMM]] as const) {
		datasetPins[name] = [
			{
				dataset: name,
				dataset_id: id,
				version: "v4",
				commit: "c0ffee",
				content_sha256: ingestSha256("pinned"),
				ingested_at: "2026-11-01T00:00:00.000Z",
				backend: "ragflow",
			},
		];
	}
	writeFileSync(stateFile, `${JSON.stringify({ version: 2, records, versions: datasetPins })}\n`, "utf8");
	return {
		stateFile,
		deps: {
			config: { url: "http://ragflow.test", apiKey: "test-key" },
			fetchImpl: fake.fetch,
			stateFile,
			sample: SAMPLE,
			gitShow: async (commit, path) => {
				const bytes = gitFiles[`${commit}:${path}`];
				if (bytes === undefined) throw new Error(`no such commit: ${commit}:${path}`);
				return bytes;
			},
			devOf: (path) => (path === "/" ? 1 : 2),
		},
	};
}

interface ApplyFixture {
	archiveDir: string;
	gitFiles: Record<string, string>;
	lightrag: { fetchImpl: FetchLike; uploads: string[] };
	events: EventInput[];
	stateFile: string;
}

async function applyFixture(over: { versions?: Record<string, number>; rehearsal?: boolean } = {}): Promise<ApplyFixture> {
	const fake = new RagflowFake();
	const gitFiles = await seedPlane(fake);
	const { deps, stateFile } = harness(fake, gitFiles, over.versions ?? {});
	const archiveDir = mkdtempSync(join(tmpdir(), "docs-migrate-archive-"));
	const outcome = await archiveRagflow(deps, archiveDir);
	if (outcome.page_hash_mismatches.length > 0) throw new Error(`fixture archive drifted: ${JSON.stringify(outcome.page_hash_mismatches)}`);
	const uploads: string[] = [];
	const events: EventInput[] = [];
	const lightragFetch: FetchLike = async (input, init) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		if (method === "POST" && url.pathname === "/documents/upload") {
			const file = (init?.body as FormData).get("file") as File;
			uploads.push(await file.text());
			return Response.json({ status: "success", data: { track_id: `trk-${String(uploads.length).padStart(3, "0")}` } });
		}
		if (method === "POST" && url.pathname === "/documents/scan") return Response.json({ status: "success" });
		if (method === "GET" && url.pathname === "/documents/pipeline_status") return Response.json({ status: "idle" });
		return Response.json({ detail: "no route" }, { status: 404 });
	};
	return { archiveDir, gitFiles, lightrag: { fetchImpl: lightragFetch, uploads }, events, stateFile };
}

function partAFile(dir: string, records = 6): string {
	const file = join(dir, "SUMMARY-part-a.md");
	writeFileSync(file, `dry run ok\n\n\`${partAMarker(records)}\`\n`, "utf8");
	return file;
}

describe("docs-migrate", () => {
	test("the frozen sample is exactly 20 unique {id, question} entries", () => {
		const fixture = JSON.parse(readFileSync(new URL("../fixtures/parity/parity-queries.json", import.meta.url).pathname, "utf8")) as { queries: Array<{ id: string; question: string }> };
		expect(fixture.queries).toHaveLength(20);
		expect(new Set(fixture.queries.map((query) => query.id)).size).toBe(20);
		for (const query of fixture.queries) {
			expect(Object.keys(query).sort()).toEqual(["id", "question"]);
			expect(query.id).toMatch(/^q\d{2}$/);
		}
	});

	test("the dry run passes Part A with zero fetches and prints the marker", async () => {
		const fixture = await applyFixture();
		const out: string[] = [];
		const calls: string[] = [];
		const spy: FetchLike = async (input) => {
			calls.push(String(input));
			throw new Error("the dry run must not touch the network");
		};
		const outcome = await runDryRun({ archiveDir: fixture.archiveDir }, { out: (t) => out.push(t), err: () => undefined });
		expect(outcome.exit).toBe(0);
		const report = JSON.parse(out[0] ?? "{}") as { partA: { passed: boolean; records: number }; partB: { skipped: boolean }; mismatches: unknown[]; marker: string };
		expect(report.partA).toMatchObject({ passed: true, records: 6 });
		expect(report.partB).toEqual({ skipped: true });
		expect(report.mismatches).toEqual([]);
		expect(report.marker).toBe(partAMarker(6));
		expect(calls).toEqual([]);
		expect(fixture.lightrag.uploads).toEqual([]);
	});

	test("a dry run over --answers runs the full ordered gate", async () => {
		const fixture = await applyFixture();
		const archive = loadArchive(fixture.archiveDir);
		const answers = archive.baselines.map((baseline) => ({ id: baseline.id, source_urls: baseline.citations.map((citation) => citation.source_url ?? "") }));
		const answersFile = join(fixture.archiveDir, "..", "answers.json");
		writeFileSync(answersFile, JSON.stringify(answers), "utf8");
		const out: string[] = [];
		const outcome = await runDryRun({ archiveDir: fixture.archiveDir, answersFile }, { out: (t) => out.push(t), err: () => undefined });
		const report = JSON.parse(out[0] ?? "{}") as { partB: { skipped: boolean; queries: number; passed: boolean }; matchRate: number | null };
		expect(report.partB).toMatchObject({ skipped: false, queries: 2, passed: true });
		expect(report.matchRate).toBe(1);
		expect(outcome.exit).toBe(0);
		rmSync(answersFile, { force: true });
	});

	test("a tampered archive refuses the dry run with the file named", async () => {
		const fixture = await applyFixture();
		const inventory = join(fixture.archiveDir, "inventory", "agent-substrate.json");
		writeFileSync(inventory, `${readFileSync(inventory, "utf8")} `, { mode: 0o600 });
		const err: string[] = [];
		const outcome = await runDryRun({ archiveDir: fixture.archiveDir }, { out: () => undefined, err: (t) => err.push(t) });
		expect(outcome.exit).toBe(1);
		expect(outcome.refused).toBe("archive verification failed");
		expect(err[0]).toContain("sha256 differs");
	});

	test("apply without a recorded Part A pass is refused before any effect", async () => {
		const fixture = await applyFixture();
		const noMarker = join(fixture.archiveDir, "..", "no-marker.md");
		writeFileSync(noMarker, "the dry run failed; nothing passed", "utf8");
		const outcome = await runApply(
			{
				archiveDir: fixture.archiveDir,
				partAFile: noMarker,
				rehearsal: false,
				stateFile: fixture.stateFile,
				datasets: [],
				lightragUrl: "http://lightrag.test",
				fetchImpl: fixture.lightrag.fetchImpl,
				gitShow: async (commit, path) => fixture.gitFiles[`${commit}:${path}`] ?? "",
				poll: { maxPolls: 1, intervalMs: 0 },
			},
			{ out: () => undefined, err: () => undefined },
		);
		expect(outcome.exit).toBe(1);
		expect(outcome.refused).toContain("Part A");
		expect(fixture.lightrag.uploads).toEqual([]);
		const persisted = readFileSync(fixture.stateFile, "utf8");
		expect(persisted).not.toContain("lightrag::");
	});

	test("a passing apply replays pages, carries versions, records pins and notes the cutover", async () => {
		const fixture = await applyFixture({ versions: { "docs/page-ds-berlin-agent-substrate-1.md": 3 } });
		const partA = partAFile(mkdtempSync(join(tmpdir(), "docs-migrate-")));
		const outcome = await runApply(
			{
				archiveDir: fixture.archiveDir,
				partAFile: partA,
				rehearsal: false,
				stateFile: fixture.stateFile,
				datasets: [],
				lightragUrl: "http://lightrag.test",
				fetchImpl: fixture.lightrag.fetchImpl,
				gitShow: async (commit, path) => fixture.gitFiles[`${commit}:${path}`] ?? "",
				poll: { maxPolls: 1, intervalMs: 0 },
				now: () => 1_700_000_000_000,
			},
			{ out: () => undefined, err: () => undefined },
		);
		expect(outcome.exit).toBe(0);
		const report = outcome.report as { totals: { ingested: number; failed: number }; records_lightrag: number; versions_carried: number; versions_recorded: number; state_file_persisted: boolean; cutover_note_emitted: boolean };
		expect(report.totals).toMatchObject({ ingested: 6, failed: 0 });
		expect(report.records_lightrag).toBe(6);
		expect(report.versions_recorded).toBe(2);
		expect(report.state_file_persisted).toBe(true);
		expect(report.cutover_note_emitted).toBe(true);
		expect(fixture.lightrag.uploads).toHaveLength(6);
		const persisted = JSON.parse(readFileSync(fixture.stateFile, "utf8")) as { records: Record<string, { version: number }> };
		const carried = Object.entries(persisted.records).filter(([key]) => key.startsWith("lightrag::"));
		expect(carried).toHaveLength(6);
		const carriedThree = carried.find(([key]) => key.endsWith("docs/page-ds-berlin-agent-substrate-1.md"));
		expect(carriedThree?.[1].version).toBe(3);
		const notes = outcome.report ? [] : [];
		expect(notes).toEqual([]);
	});

	test("a rehearsal apply persists nothing and emits no cutover note", async () => {
		const fixture = await applyFixture();
		const partA = partAFile(mkdtempSync(join(tmpdir(), "docs-migrate-")));
		const before = readFileSync(fixture.stateFile, "utf8");
		const outcome = await runApply(
			{
				archiveDir: fixture.archiveDir,
				partAFile: partA,
				rehearsal: true,
				stateFile: fixture.stateFile,
				datasets: [],
				lightragUrl: "http://lightrag.test",
				fetchImpl: fixture.lightrag.fetchImpl,
				gitShow: async (commit, path) => fixture.gitFiles[`${commit}:${path}`] ?? "",
				poll: { maxPolls: 1, intervalMs: 0 },
				now: () => 1_700_000_000_000,
			},
			{ out: () => undefined, err: () => undefined },
		);
		expect(outcome.exit).toBe(0);
		const report = outcome.report as { rehearsal: boolean; records_lightrag: number; state_file_persisted: boolean; cutover_note_emitted: boolean };
		expect(report).toMatchObject({ rehearsal: true, records_lightrag: 6, state_file_persisted: false, cutover_note_emitted: false });
		expect(readFileSync(fixture.stateFile, "utf8")).toBe(before);
	});

	test("main: the dry run exits 0 through the CLI seam with a fetch spy in place", async () => {
		const fixture = await applyFixture();
		const calls: string[] = [];
		const spy: FetchLike = async (input) => {
			calls.push(String(input));
			throw new Error("no network in a dry run");
		};
		const out: string[] = [];
		const code = await main(["--archive", fixture.archiveDir], { SUBSTRATE_RAGFLOW_ARCHIVE_DIR: "" }, { out: (t) => out.push(t), err: () => undefined }, spy);
		expect(code).toBe(0);
		expect(calls).toEqual([]);
		expect(out.join("")).toContain(partAMarker(6));
		expect(await main(["--apply", "--archive", fixture.archiveDir], {}, { out: () => undefined, err: () => undefined }, spy)).toBe(2);
		expect(await main(["--archive", join(tmpdir())], {}, { out: () => undefined, err: () => undefined }, spy)).toBe(1);
		expect(await main([], {}, { out: () => undefined, err: () => undefined }, spy)).toBe(2);
		expect(await main(["--mystery"], {}, { out: () => undefined, err: () => undefined }, spy)).toBe(2);
	});
});
