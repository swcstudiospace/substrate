/**
 * The migration job's offline proof. The archive is written by the real writer (`archiveRagflow`) from the RAGFlow fake,
 * and the LightRAG plane is a fake that serves PARITY_GATE's reads, the frozen sample and the ingest routes. The cases
 * prove the job refuses before any upload when the archive, the mapping, the replayability or the gate fails; a passing apply
 * replays only the missing page, carries the archived version and records the pin; rehearsal persists nothing; and a replay
 * that does not land every page refuses its dataset, keeps only the uploads it confirmed, and records no pin or cutover. No
 * case reaches a network: every fetch is the fake.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { corpusDocumentName, parseCorpusDocumentName, stripRemoteImages } from "../../corpus/src/index.ts";
import { type ArchiveQuery, archiveRagflow, type ReadAtCommit, ragflowArchiveSource, verifyArchive } from "./docs-archive.ts";
import { createVersionStore, lightragSearchDatasets, recordVersion } from "./docs-datasets.ts";
import { changeSha, DEFAULT_INGEST_ROOTS, type IngestRecord, ingestDocs, loadIngestRecords, saveIngestRecords } from "./docs-ingest.ts";
import type { FetchLike } from "./planes/lightrag.ts";
import { FROZEN_SAMPLE } from "./parity-gate.ts";
import { RagflowFake } from "./ragflow-fake.ts";
import { datasetIdentity, main, mapRecords, loadArchive, parseMigrateArgs, partAMarker, runApply, runDryRun, type MigrateIo } from "./docs-migrate.ts";

const REPO = "agent-substrate";
const PLANE_REPO = "swcstudiospace/agent-substrate";
const RAG_CONFIG = { url: "http://ragflow.test", apiKey: "test-key" };
const LR_URL = "http://lightrag.test";
const COMMIT = "a1b2c3d4e5f60718";
const PLAN = "docs/plan.md";
const NOTES = "docs/notes.md";
const ORPHAN = "docs/orphan.md";
const PLAN_BODY = "# Plan\n\nThe plan lives in PLAN.md.\n";
const NOTES_BODY = "# Notes\n\nReplayed from the archive.\n";
const EXTRA = "docs/extra.md";
const EXTRA_BODY = "# Extra\n\nA page pinned to its own commit.\n";
const EXTRA_COMMIT = "0f1e2d3c4b5a6978";
const DESK = "docs/desk.md";
const DESK_BODY = "# Desk\n\nA sibling dataset's page, replayed under its mapped repository.\n";
const SKILL = "demo-skill/SKILL.md";
const SKILL_API = "demo-skill/references/api.md";
const SKILL_BODY = "# Demo skill\n\nThe skill's own page.\n";
const SKILL_API_BODY = "# Demo API\n\nThe reference the skill links to.\n";
const QUERIES: ArchiveQuery[] = [
	{ id: "q-01", question: "where is the plan?" },
	{ id: "q-02", question: "who reads the plan?" },
];
const NO_RELEASE_ROOT = join(tmpdir(), "docs-migrate-test-no-release-root");
/** The replay's page reader: the pages as they stood at the recorded commit, so no case reaches the working repository. */
const REPLAY_READ: ReadAtCommit = (commit, path) => {
	if (path === EXTRA && (commit === COMMIT || commit === EXTRA_COMMIT)) return Buffer.from(EXTRA_BODY, "utf8");
	if (commit !== COMMIT) return null;
	if (path === NOTES) return Buffer.from(NOTES_BODY, "utf8");
	if (path === PLAN) return Buffer.from(PLAN_BODY, "utf8");
	return null;
};

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "docs-migrate-"));
	scratch.push(dir);
	return dir;
}

const sourceOf = (path: string): string => `file:///srv/agent-substrate/${path}`;
const shaOf = (body: string): string => changeSha(stripRemoteImages(body).body, undefined);
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Fixture {
	root: string;
	archiveDir: string;
	stateFile: string;
}

/**
 * A production docs state holding the plan's LightRAG record (already matched by the plane), and the RAGFlow-era notes
 * record at version 3, then the archive of both. `extraRecords` adds archived records; `undocumented` adds a RAGFlow
 * document with no commit, which the replay cannot reproduce; `desk` adds an archived programming-desk page at the same commit;
 * `skills` adds an archived agent-skills skill at `demo-skill/SKILL.md` and `demo-skill/references/api.md`, at the same commit.
 */
async function buildFixture(options: { extraRecords?: Array<[string, IngestRecord]>; undocumented?: boolean; desk?: boolean; skills?: boolean; extra?: { commit: string } } = {}): Promise<Fixture> {
	const root = scratchDir();
	const stateFile = join(root, "docs-ingest.json");
	const fake = new RagflowFake();
	const ragflowId = fake.datasets.find((dataset) => dataset.name === REPO)?.id ?? "";
	if (ragflowId === "") throw new Error("the RAGFlow fake lists no agent-substrate dataset");

	const versions = createVersionStore();
	recordVersion(versions, {
		dataset: REPO,
		dataset_id: ragflowId,
		version: "v4",
		commit: COMMIT,
		content_sha256: shaOf("pinned"),
		ingested_at: "2026-10-28T00:00:00.000Z",
		backend: "ragflow",
	});
	const deskId = fake.datasets.find((dataset) => dataset.name === "programming-desk")?.id ?? "";
	if (options.desk === true && deskId === "") throw new Error("the RAGFlow fake lists no programming-desk dataset");
	const desk: Array<[string, IngestRecord]> = options.desk === true ? [[`${deskId}::${sourceOf(DESK)}`, { sha: shaOf(DESK_BODY), dataset_id: deskId, source_url: sourceOf(DESK), document_id: "ragflow-desk", version: 1 }]] : [];
	const skillsId = fake.datasets.find((dataset) => dataset.name === "agent-skills")?.id ?? "";
	if (options.skills === true && skillsId === "") throw new Error("the RAGFlow fake lists no agent-skills dataset");
	const skillSource = (path: string): string => `file:///srv/agent-skills/${path}`;
	const skills: Array<[string, IngestRecord]> =
		options.skills === true
			? [
					[`${skillsId}::${skillSource(SKILL)}`, { sha: shaOf(SKILL_BODY), dataset_id: skillsId, source_url: skillSource(SKILL), document_id: "ragflow-skill", version: 1 }],
					[`${skillsId}::${skillSource(SKILL_API)}`, { sha: shaOf(SKILL_API_BODY), dataset_id: skillsId, source_url: skillSource(SKILL_API), document_id: "ragflow-skill-api", version: 1 }],
				]
			: [];
	const records = new Map<string, IngestRecord>([
		[`lightrag::${PLANE_REPO}::${sourceOf(PLAN)}`, { sha: shaOf(PLAN_BODY), dataset_id: PLANE_REPO, source_url: sourceOf(PLAN), document_id: "doc-plan", version: 1 }],
		[`${ragflowId}::${sourceOf(NOTES)}`, { sha: shaOf(NOTES_BODY), dataset_id: ragflowId, source_url: sourceOf(NOTES), document_id: "ragflow-notes", version: 3 }],
		...(options.extraRecords ?? []),
		...desk,
		...skills,
		...(options.extra === undefined ? [] : [[`${ragflowId}::${sourceOf(EXTRA)}`, { sha: shaOf(EXTRA_BODY), dataset_id: ragflowId, source_url: sourceOf(EXTRA), document_id: "ragflow-extra", version: 1 }] as [string, IngestRecord]]),
	]);
	await saveIngestRecords(stateFile, records, versions);

	fake.documents["ragflow-notes"] = {
		id: "ragflow-notes",
		dataset_id: ragflowId,
		name: "docs__notes.md",
		run: "DONE",
		polls: 0,
		meta_fields: { source_url: sourceOf(NOTES), commit: COMMIT, heading_path: "Notes" },
	};
	if (options.undocumented === true) {
		fake.documents["doc-orphan"] = { id: "doc-orphan", dataset_id: ragflowId, name: "docs__orphan.md", run: "DONE", polls: 0, meta_fields: { source_url: sourceOf(ORPHAN) } };
	}
	if (options.extra !== undefined) {
		fake.documents["ragflow-extra"] = { id: "ragflow-extra", dataset_id: ragflowId, name: "docs__extra.md", run: "DONE", polls: 0, meta_fields: { source_url: sourceOf(EXTRA), commit: options.extra.commit, heading_path: "Extra" } };
	}
	if (options.desk === true) {
		fake.documents["ragflow-desk"] = { id: "ragflow-desk", dataset_id: deskId, name: "docs__desk.md", run: "DONE", polls: 0, meta_fields: { source_url: sourceOf(DESK), commit: COMMIT, heading_path: "Desk" } };
	}
	if (options.skills === true) {
		fake.documents["ragflow-skill"] = { id: "ragflow-skill", dataset_id: skillsId, name: "demo-skill__SKILL.md", run: "DONE", polls: 0, meta_fields: { source_url: skillSource(SKILL), commit: COMMIT, heading_path: "Demo skill" } };
		fake.documents["ragflow-skill-api"] = { id: "ragflow-skill-api", dataset_id: skillsId, name: "demo-skill__references__api.md", run: "DONE", polls: 0, meta_fields: { source_url: skillSource(SKILL_API), commit: COMMIT, heading_path: "Demo API" } };
	}
	fake.chunks[ragflowId] = [{ document_id: "ragflow-notes", document_name: "docs__notes.md", content: NOTES_BODY, source_url: sourceOf(NOTES), heading_path: "Notes", score: 0.9 }];

	const bodies: Record<string, string> = { [`${COMMIT}:${PLAN}`]: PLAN_BODY, [`${COMMIT}:${NOTES}`]: NOTES_BODY };
	if (options.extra !== undefined) bodies[`${options.extra.commit}:${EXTRA}`] = EXTRA_BODY;
	if (options.desk === true) bodies[`${COMMIT}:${DESK}`] = DESK_BODY;
	if (options.skills === true) {
		bodies[`${COMMIT}:${SKILL}`] = SKILL_BODY;
		bodies[`${COMMIT}:${SKILL_API}`] = SKILL_API_BODY;
	}
	const readAtCommit: ReadAtCommit = (commit, path) => {
		const body = bodies[`${commit}:${path}`];
		return body === undefined ? null : Buffer.from(body, "utf8");
	};
	const archiveDir = join(root, "archive");
	const outcome = await archiveRagflow(
		{ source: ragflowArchiveSource(RAG_CONFIG, fake.fetch), stateFile, queries: QUERIES, repoRoot: root, readAtCommit, releaseRoot: NO_RELEASE_ROOT, allowRootfs: true },
		archiveDir,
	);
	if (!outcome.ok) throw new Error(`fixture archive refused: ${outcome.reason}`);
	return { root, archiveDir, stateFile };
}

interface Plane {
	fetch: FetchLike;
	calls: string[];
	uploads: string[];
	names: string[];
	deleted: string[];
}

/**
 * A fake LightRAG. `paginated` lists the given documents plus every upload it accepted, so the ingest can resolve the
 * documents it wrote. `/query` answers each frozen question from its expected source.
 */
function fakeLightrag(listing: Array<{ id: string; file_path: string }>, rejectUpload: (fileName: string) => boolean = () => false): Plane {
	const documents = [...listing];
	const calls: string[] = [];
	const uploads: string[] = [];
	const deleted: string[] = [];
	const names: string[] = [];
	const tracked = new Map<string, { id: string; file_path: string }>();
	const fetch: FetchLike = async (input, init) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		calls.push(`${method} ${url.pathname}`);
		if (method === "POST" && url.pathname === "/documents/upload") {
			const form = init?.body;
			if (!(form instanceof FormData)) return json({ detail: "the upload is not multipart" }, 400);
			const file = form.get("file");
			if (!(file instanceof File)) return json({ detail: "the upload has no file part" }, 400);
			if (rejectUpload(file.name)) return json({ detail: "injected upload failure" }, 500);
			uploads.push(await file.text());
			names.push(file.name);
			const id = `doc-up-${String(uploads.length)}`;
			const trackId = `trk-${String(uploads.length)}`;
			documents.push({ id, file_path: file.name });
			tracked.set(trackId, { id, file_path: file.name });
			return json({ status: "success", data: { track_id: trackId } });
		}
		if (method === "DELETE" && url.pathname === "/documents/delete_document") {
			// The delete our own prune sent: its doc_ids, removed from the listing the fake serves.
			const sent = JSON.parse(String(init?.body)) as { doc_ids: string[] };
			deleted.push(...sent.doc_ids);
			for (const id of sent.doc_ids) {
				const at = documents.findIndex((document) => document.id === id);
				if (at >= 0) documents.splice(at, 1);
			}
			return json({ status: "deletion_started" });
		}
		if (method === "POST" && url.pathname === "/documents/paginated") return json({ documents, pagination: { has_next: false } });
		if (method === "POST" && url.pathname === "/query") {
			const body = JSON.parse(String(init?.body)) as { query: string };
			return json(frozenReply(body.query));
		}
		if (url.pathname === "/documents/scan") return json({ status: "success" });
		if (url.pathname === "/documents/pipeline_status") return json({ status: "idle", busy: false });
		if (url.pathname.startsWith("/documents/track_status/")) {
			const entry = tracked.get(url.pathname.slice("/documents/track_status/".length));
			return json({ track_id: url.pathname.slice("/documents/track_status/".length), documents: entry === undefined ? [] : [{ ...entry, status: "processed" }], total_count: entry === undefined ? 0 : 1 });
		}
		return json({ detail: "no route" }, 404);
	};
	return { fetch, calls, uploads, names, deleted };
}

function frozenReply(question: string): unknown {
	const item = FROZEN_SAMPLE.find((entry) => entry.question === question);
	const source = item?.expectedSource ?? "docs/elsewhere.md";
	return { data: { chunks: [{ content: "passage", file_path: corpusDocumentName(PLANE_REPO, source, shaOf(PLAN_BODY)) }] } };
}

/** The production plane: the plan is already there, matched by name, so Part A and Part B pass before anything is ingested. */
function matchedPlane(): Plane {
	return fakeLightrag([{ id: "doc-plan", file_path: corpusDocumentName(PLANE_REPO, PLAN, shaOf(PLAN_BODY)) }]);
}

function captureIo(): { io: MigrateIo; out: string[]; err: string[] } {
	const out: string[] = [];
	const err: string[] = [];
	return { io: { out: (text) => out.push(text), err: (text) => err.push(text) }, out, err };
}

function partAFile(dir: string, records = 1): string {
	const file = join(dir, "SUMMARY-part-a.md");
	writeFileSync(file, `dry run ok\n\n\`${partAMarker(records)}\`\n`, "utf8");
	return file;
}

const CONFIG = { url: LR_URL };

describe("docs-migrate: arguments", () => {
	test("the modes, the rehearsal flag and the value flags parse; bad flags are refused", () => {
		expect(parseMigrateArgs(["--archive", "/a", "--part-a", "/p", "--apply", "--rehearsal"])).toMatchObject({ mode: "apply", archive: "/a", partA: "/p", rehearsal: true, reason: null });
		expect(parseMigrateArgs(["--archive", "/a"])).toMatchObject({ mode: "dry-run", reason: null });
		expect(parseMigrateArgs(["--rehearsal", "--archive", "/a"]).reason).toContain("--rehearsal only applies to --apply");
		expect(parseMigrateArgs(["--archive"]).reason).toContain("--archive needs a value");
		expect(parseMigrateArgs(["--mystery"]).reason).toContain("unexpected --mystery");
	});
});

describe("docs-migrate: dry run", () => {
	test("PARITY_GATE passes, the marker is printed, and nothing is uploaded or written", async () => {
		const fixture = await buildFixture();
		const before = readFileSync(fixture.stateFile, "utf8");
		const plane = matchedPlane();
		const { io, out } = captureIo();
		const outcome = await runDryRun({ archiveDir: fixture.archiveDir, stateFile: fixture.stateFile, config: CONFIG, fetchImpl: plane.fetch }, io);
		expect(outcome.exit).toBe(0);
		const report = JSON.parse(out.join("")) as { marker: string; gate_ok: boolean; records: number; unmapped: unknown[]; undocumented: unknown[] };
		expect(report).toMatchObject({ marker: partAMarker(1), gate_ok: true, records: 1, unmapped: [], undocumented: [] });
		expect(plane.uploads).toEqual([]);
		expect(plane.calls.some((call) => call.includes("/documents/upload"))).toBe(false);
		expect(readFileSync(fixture.stateFile, "utf8")).toBe(before);
	});

	test("a tampered archive refuses before any plane call", async () => {
		const fixture = await buildFixture();
		const inventory = join(fixture.archiveDir, "inventory", `${REPO}.json`);
		writeFileSync(inventory, `${readFileSync(inventory, "utf8")} `, { mode: 0o600 });
		const plane = matchedPlane();
		const { io, err } = captureIo();
		const outcome = await runDryRun({ archiveDir: fixture.archiveDir, stateFile: fixture.stateFile, config: CONFIG, fetchImpl: plane.fetch }, io);
		expect(outcome).toMatchObject({ ok: false, exit: 1, refused: "archive verification failed" });
		expect(err.join("")).toContain("archive verification failed");
		expect(plane.calls).toEqual([]);
	});

	test("a failed Part A refuses the job and no document is uploaded", async () => {
		const fixture = await buildFixture();
		const plane = fakeLightrag([]);
		const { io } = captureIo();
		const outcome = await runDryRun({ archiveDir: fixture.archiveDir, stateFile: fixture.stateFile, config: CONFIG, fetchImpl: plane.fetch }, io);
		expect(outcome).toMatchObject({ ok: false, exit: 1, refused: "PARITY_GATE failed; refusing ingestion" });
		expect(plane.uploads).toEqual([]);
		expect(plane.calls.some((call) => call.includes("/documents/upload"))).toBe(false);
	});

	test("an archived RAGFlow record whose dataset the inventory does not list refuses the job", async () => {
		const fixture = await buildFixture({
			extraRecords: [["ds-gone::file:///srv/agent-substrate/docs/gone.md", { sha: shaOf("gone"), dataset_id: "ds-gone", source_url: sourceOf("docs/gone.md"), document_id: "doc-gone", version: 1 }]],
		});
		const plane = matchedPlane();
		const { io } = captureIo();
		const outcome = await runDryRun({ archiveDir: fixture.archiveDir, stateFile: fixture.stateFile, config: CONFIG, fetchImpl: plane.fetch }, io);
		expect(outcome).toMatchObject({ ok: false, refused: "archived RAGFlow records map to no archived dataset" });
		expect(plane.calls).toEqual([]);
	});

	test("an archived document without a commit refuses the job: the replay could not reproduce it", async () => {
		const fixture = await buildFixture({ undocumented: true });
		const plane = matchedPlane();
		const { io } = captureIo();
		const outcome = await runDryRun({ archiveDir: fixture.archiveDir, stateFile: fixture.stateFile, config: CONFIG, fetchImpl: plane.fetch }, io);
		expect(outcome).toMatchObject({ ok: false, refused: "archived documents without a commit or source URL cannot be replayed" });
		expect(plane.calls).toEqual([]);
	});

	test("the CLI refuses before any plane call without LIGHTRAG_URL, and without a state file", async () => {
		const fixture = await buildFixture();
		const plane = matchedPlane();
		const { io, err } = captureIo();
		expect(await main(["--archive", fixture.archiveDir], { SUBSTRATE_DOCS_STATE_FILE: fixture.stateFile }, io, plane.fetch)).toBe(2);
		expect(err.join("")).toContain("LIGHTRAG_URL is unset");
		expect(await main(["--archive", fixture.archiveDir], { LIGHTRAG_URL: LR_URL }, io, plane.fetch)).toBe(2);
		expect(plane.calls).toEqual([]);
	});

	test("the CLI dry run exits 0 with LIGHTRAG_URL set and the state file named", async () => {
		const fixture = await buildFixture();
		const plane = matchedPlane();
		const { io, out } = captureIo();
		const code = await main(["--archive", fixture.archiveDir, "--state-file", fixture.stateFile], { LIGHTRAG_URL: LR_URL }, io, plane.fetch);
		expect(code).toBe(0);
		expect(out.join("")).toContain(partAMarker(1));
		expect(plane.uploads).toEqual([]);
	});
});

describe("docs-migrate: apply", () => {
	test("a passing apply replays only the missing page, carries the archived version and records the pin", async () => {
		const fixture = await buildFixture();
		const plane = matchedPlane();
		const { io } = captureIo();
		const outcome = await runApply(
			{
				archiveDir: fixture.archiveDir,
				stateFile: fixture.stateFile,
				config: CONFIG,
				fetchImpl: plane.fetch,
				partAFile: partAFile(fixture.root),
				rehearsal: false,
				datasets: [],
				checkoutRepo: PLANE_REPO,
				readAtCommit: REPLAY_READ,
				poll: { maxPolls: 1, intervalMs: 0 },
				now: () => 1_700_000_000_000,
			},
			io,
		);
		expect(outcome.exit).toBe(0);
		expect(plane.uploads).toEqual([NOTES_BODY]);
		const report = outcome.report as { state_file_persisted: boolean; versions_carried: number; versions_recorded: number; cutover_event: { payload: { action: string; from: string; to: string } } | null };
		expect(report).toMatchObject({ state_file_persisted: true, versions_carried: 1, versions_recorded: 1 });
		expect(report.cutover_event?.payload).toMatchObject({ action: "docs.cutover", from: "ragflow", to: "lightrag" });

		const persisted = await loadIngestRecords(fixture.stateFile);
		expect(persisted.records.get(`lightrag::${PLANE_REPO}::${sourceOf(NOTES)}`)).toMatchObject({ version: 3, document_id: "doc-up-1" });
		expect(persisted.records.get(`lightrag::${PLANE_REPO}::${sourceOf(PLAN)}`)?.version).toBe(1);
		expect(persisted.versions.get(REPO)?.some((version) => version.backend === "lightrag" && version.version === "v4")).toBe(true);
	});

	test("a normal refresh after a passing apply finds the migrated record under the same key and carries its version", async () => {
		const fixture = await buildFixture();
		const plane = matchedPlane();
		const { io } = captureIo();
		const applied = await runApply(
			{ archiveDir: fixture.archiveDir, stateFile: fixture.stateFile, config: CONFIG, fetchImpl: plane.fetch, partAFile: partAFile(fixture.root), rehearsal: false, datasets: [], checkoutRepo: PLANE_REPO, readAtCommit: REPLAY_READ, poll: { maxPolls: 1, intervalMs: 0 } },
			io,
		);
		expect(applied.exit).toBe(0);
		const { records } = await loadIngestRecords(fixture.stateFile);
		const key = `lightrag::${PLANE_REPO}::${sourceOf(NOTES)}`;
		expect(records.get(key)?.version).toBe(3);
		const refresh = await ingestDocs(
			{
				config: null,
				backend: "lightrag",
				lightragConfig: CONFIG,
				lightragDatasets: { list: async () => lightragSearchDatasets([REPO], datasetIdentity), invalidate: () => undefined },
				lightragFetch: plane.fetch,
				seen: records,
				locks: new Map(),
				roots: DEFAULT_INGEST_ROOTS,
				surface: "substrate",
				emit: async () => ({ stored: false }),
				poll: { maxPolls: 1, intervalMs: 0 },
			},
			{ dataset: REPO, commit: "7e6d5c4b3a291807", pages: [{ path: NOTES, source_url: sourceOf(NOTES), body: "# Notes\n\nEdited after the migration.\n" }] },
		);
		expect(refresh.ok && refresh.results.map((result) => result.status)).toEqual(["replaced"]);
		expect(records.get(key)?.version).toBe(4);
	});

	test("a normal refresh reads a record kept under the bare repository name, versions it on, and prunes its document", async () => {
		const legacy: IngestRecord = { sha: shaOf(NOTES_BODY), dataset_id: PLANE_REPO, source_url: sourceOf(NOTES), document_id: "doc-legacy", version: 1, commit: COMMIT };
		const plane = fakeLightrag([
			{ id: "doc-plan", file_path: corpusDocumentName(PLANE_REPO, PLAN, shaOf(PLAN_BODY)) },
			{ id: "doc-legacy", file_path: corpusDocumentName(PLANE_REPO, NOTES, shaOf(NOTES_BODY)) },
		]);
		const records = new Map<string, IngestRecord>([[`lightrag::${REPO}::${sourceOf(NOTES)}`, legacy]]);
		const refresh = await ingestDocs(
			{
				config: null,
				backend: "lightrag",
				lightragConfig: CONFIG,
				lightragDatasets: { list: async () => lightragSearchDatasets([REPO], datasetIdentity), invalidate: () => undefined },
				lightragFetch: plane.fetch,
				seen: records,
				locks: new Map(),
				roots: DEFAULT_INGEST_ROOTS,
				surface: "substrate",
				emit: async () => ({ stored: false }),
				poll: { maxPolls: 1, intervalMs: 0 },
				prune: true,
			},
			{ dataset: REPO, commit: "7e6d5c4b3a291807", pages: [{ path: NOTES, source_url: sourceOf(NOTES), body: "# Notes\n\nEdited after the migration.\n" }] },
		);
		expect(refresh.ok && refresh.results).toMatchObject([{ status: "replaced", superseded_document_id: "doc-legacy", pruned_document_id: "doc-legacy" }]);
		expect(plane.deleted).toEqual(["doc-legacy"]);
		expect(records.get(`lightrag::${PLANE_REPO}::${sourceOf(NOTES)}`)).toMatchObject({ version: 2, document_id: "doc-up-1" });
		expect(records.has(`lightrag::${REPO}::${sourceOf(NOTES)}`)).toBe(false);
	});

	test("every name a passing apply writes parses to the repository its record is keyed under", async () => {
		const fixture = await buildFixture();
		const plane = matchedPlane();
		const { io } = captureIo();
		const outcome = await runApply(
			{ archiveDir: fixture.archiveDir, stateFile: fixture.stateFile, config: CONFIG, fetchImpl: plane.fetch, partAFile: partAFile(fixture.root), rehearsal: false, datasets: [], checkoutRepo: PLANE_REPO, readAtCommit: REPLAY_READ, poll: { maxPolls: 1, intervalMs: 0 } },
			io,
		);
		expect(outcome.exit).toBe(0);
		const { records } = await loadIngestRecords(fixture.stateFile);
		const stored = records.get(`lightrag::${PLANE_REPO}::${sourceOf(NOTES)}`);
		const parsed = plane.names.map((name) => parseCorpusDocumentName(name));
		expect(plane.names).toEqual([corpusDocumentName(PLANE_REPO, NOTES, shaOf(NOTES_BODY))]);
		expect(parsed.map((name) => name?.path)).toEqual([NOTES]);
		expect(parsed.every((name) => name !== null && name.repo === stored?.dataset_id)).toBe(true);
		expect(stored?.dataset_id).toBe(PLANE_REPO);
	});

	test("apply refuses without the recorded gate pass, before any plane call", async () => {
		const fixture = await buildFixture();
		const noMarker = join(fixture.root, "no-marker.md");
		writeFileSync(noMarker, "the dry run failed; nothing passed", "utf8");
		const plane = matchedPlane();
		const { io } = captureIo();
		const outcome = await runApply(
			{ archiveDir: fixture.archiveDir, stateFile: fixture.stateFile, config: CONFIG, fetchImpl: plane.fetch, partAFile: noMarker, rehearsal: false, datasets: [], checkoutRepo: PLANE_REPO },
			io,
		);
		expect(outcome).toMatchObject({ ok: false, exit: 1 });
		expect(outcome.refused).toContain("does not record a gate pass");
		expect(plane.calls).toEqual([]);
	});

	test("apply refuses a recorded pass whose record count no longer matches the live gate", async () => {
		const fixture = await buildFixture();
		const plane = matchedPlane();
		const { io } = captureIo();
		const outcome = await runApply(
			{ archiveDir: fixture.archiveDir, stateFile: fixture.stateFile, config: CONFIG, fetchImpl: plane.fetch, partAFile: partAFile(fixture.root, 7), rehearsal: false, datasets: [], checkoutRepo: PLANE_REPO },
			io,
		);
		expect(outcome.refused).toContain("the recorded pass is stale");
		expect(plane.uploads).toEqual([]);
	});

	test("a failed gate refuses ingestion: the plane is read, nothing is uploaded, the state is untouched", async () => {
		const fixture = await buildFixture();
		const before = readFileSync(fixture.stateFile, "utf8");
		const plane = fakeLightrag([]);
		const { io } = captureIo();
		const outcome = await runApply(
			{ archiveDir: fixture.archiveDir, stateFile: fixture.stateFile, config: CONFIG, fetchImpl: plane.fetch, partAFile: partAFile(fixture.root), rehearsal: false, datasets: [], checkoutRepo: PLANE_REPO },
			io,
		);
		expect(outcome).toMatchObject({ ok: false, exit: 1, refused: "PARITY_GATE failed; refusing ingestion" });
		expect(plane.uploads).toEqual([]);
		expect(readFileSync(fixture.stateFile, "utf8")).toBe(before);
	});

	test("the CLI refuses apply without the operator's approval for this run, before any plane call", async () => {
		const fixture = await buildFixture();
		const plane = matchedPlane();
		const { io, err } = captureIo();
		const code = await main(
			["--apply", "--archive", fixture.archiveDir, "--state-file", fixture.stateFile, "--part-a", partAFile(fixture.root)],
			{ LIGHTRAG_URL: LR_URL },
			io,
			plane.fetch,
		);
		expect(code).toBe(2);
		expect(err.join("")).toContain("SUBSTRATE_DOCS_MIGRATE_APPROVED=1");
		expect(plane.calls).toEqual([]);
	});

	test("rehearsal replays into the plane but persists no state and reports no cutover event", async () => {
		const fixture = await buildFixture();
		const before = readFileSync(fixture.stateFile, "utf8");
		const plane = matchedPlane();
		const { io } = captureIo();
		const outcome = await runApply(
			{ archiveDir: fixture.archiveDir, stateFile: fixture.stateFile, config: CONFIG, fetchImpl: plane.fetch, partAFile: partAFile(fixture.root), rehearsal: true, datasets: [], checkoutRepo: PLANE_REPO, readAtCommit: REPLAY_READ, poll: { maxPolls: 1, intervalMs: 0 } },
			io,
		);
		expect(outcome.exit).toBe(0);
		expect(outcome.report).toMatchObject({ rehearsal: true, state_file_persisted: false, cutover_event: null });
		expect(readFileSync(fixture.stateFile, "utf8")).toBe(before);
	});

	test("a sibling dataset with archived documents replays under its mapped repository: it is not refused, and its record is keyed under that repository", async () => {
		const fixture = await buildFixture({ desk: true });
		const plane = matchedPlane();
		const { io } = captureIo();
		const readAt: ReadAtCommit = (commit, path) => (path === DESK && commit === COMMIT ? Buffer.from(DESK_BODY, "utf8") : REPLAY_READ(commit, path));
		const outcome = await runApply(
			{
				archiveDir: fixture.archiveDir,
				stateFile: fixture.stateFile,
				config: CONFIG,
				fetchImpl: plane.fetch,
				partAFile: partAFile(fixture.root),
				rehearsal: false,
				datasets: ["programming-desk"],
				checkoutRepo: PLANE_REPO,
				readAtCommit: readAt,
				poll: { maxPolls: 1, intervalMs: 0 },
				now: () => 1_700_000_000_000,
			},
			io,
		);
		expect(outcome.exit).toBe(0);
		const report = outcome.report as { datasets: Array<{ dataset: string; ingested: number; refused?: string }> };
		expect(report.datasets).toMatchObject([{ dataset: "programming-desk", ingested: 1 }]);
		expect(report.datasets[0]?.refused).toBeUndefined();
		expect(plane.uploads).toEqual([DESK_BODY]);
		expect(plane.names).toEqual([corpusDocumentName("swcstudiospace/programming-desk", DESK, shaOf(DESK_BODY))]);

		const { records } = await loadIngestRecords(fixture.stateFile);
		const key = `lightrag::swcstudiospace/programming-desk::${sourceOf(DESK)}`;
		expect(records.get(key)).toMatchObject({ dataset_id: "swcstudiospace/programming-desk", document_id: "doc-up-1" });
	});
});

describe("docs-migrate: archive reading", () => {
	test("the archive loads as inventory and carries the archived records and pins; the mapping names the migrated records", async () => {
		const fixture = await buildFixture();
		expect(await verifyArchive(fixture.archiveDir)).toMatchObject({ ok: true, mismatches: [] });
		const read = await loadArchive(fixture.archiveDir);
		if (!read.ok) throw new Error(read.reason);
		const names = read.archive.datasets.map((dataset) => dataset.name);
		expect(names).toContain(REPO);
		expect(read.archive.datasets.find((dataset) => dataset.name === REPO)?.documents.map((document) => document.path)).toEqual([NOTES]);
		expect(mapRecords(read.archive).migrated).toEqual([{ dataset: REPO, source_url: sourceOf(NOTES), version: 3 }]);
		expect(mapRecords(read.archive).unmapped).toEqual([]);
	});
});

describe("docs-migrate: a replay that does not land every page", () => {
	test("a mixed-success batch refuses the dataset: the failed page is not migrated, no pin or cutover is recorded, and the landed page is kept", async () => {
		const fixture = await buildFixture({ extra: { commit: COMMIT } });
		const plane = fakeLightrag([{ id: "doc-plan", file_path: corpusDocumentName(PLANE_REPO, PLAN, shaOf(PLAN_BODY)) }], (name) => name.includes("extra"));
		const { io } = captureIo();
		const outcome = await runApply(
			{
				archiveDir: fixture.archiveDir,
				stateFile: fixture.stateFile,
				config: CONFIG,
				fetchImpl: plane.fetch,
				partAFile: partAFile(fixture.root),
				rehearsal: false,
				datasets: [REPO],
				checkoutRepo: PLANE_REPO,
				readAtCommit: REPLAY_READ,
				poll: { maxPolls: 1, intervalMs: 0 },
				now: () => 1_700_000_000_000,
			},
			io,
		);
		expect(outcome).toMatchObject({ ok: false, exit: 1 });
		const report = outcome.report as {
			datasets: Array<{ dataset: string; ingested: number; failed: number; refused?: string }>;
			totals: { ingested: number; failed: number };
			state_file_persisted: boolean;
			versions_recorded: number;
			cutover_event: unknown;
		};
		expect(report.datasets.find((entry) => entry.dataset === REPO)).toMatchObject({ ingested: 1, failed: 1 });
		expect(report.datasets.find((entry) => entry.dataset === REPO)?.refused).toContain("failed to upload");
		expect(report).toMatchObject({ state_file_persisted: true, versions_recorded: 0, cutover_event: null, totals: { ingested: 1, failed: 1 } });
		expect(plane.uploads).toEqual([NOTES_BODY]);

		const persisted = await loadIngestRecords(fixture.stateFile);
		expect(persisted.records.get(`lightrag::${PLANE_REPO}::${sourceOf(NOTES)}`)).toMatchObject({ version: 3, document_id: "doc-up-1" });
		expect(persisted.records.has(`lightrag::${PLANE_REPO}::${sourceOf(EXTRA)}`)).toBe(false);
		expect(persisted.versions.get(REPO)?.some((version) => version.backend === "lightrag")).toBe(false);
	});

	test("a dataset refused after an earlier commit landed keeps that upload, and records no pin or cutover", async () => {
		const fixture = await buildFixture({ extra: { commit: EXTRA_COMMIT } });
		const plane = fakeLightrag([{ id: "doc-plan", file_path: corpusDocumentName(PLANE_REPO, PLAN, shaOf(PLAN_BODY)) }], (name) => name.includes("extra"));
		const { io } = captureIo();
		const outcome = await runApply(
			{
				archiveDir: fixture.archiveDir,
				stateFile: fixture.stateFile,
				config: CONFIG,
				fetchImpl: plane.fetch,
				partAFile: partAFile(fixture.root),
				rehearsal: false,
				datasets: [REPO],
				checkoutRepo: PLANE_REPO,
				readAtCommit: REPLAY_READ,
				poll: { maxPolls: 1, intervalMs: 0 },
				now: () => 1_700_000_000_000,
			},
			io,
		);
		expect(outcome).toMatchObject({ ok: false, exit: 1 });
		const report = outcome.report as { datasets: Array<{ dataset: string; refused?: string }>; state_file_persisted: boolean; versions_recorded: number; cutover_event: unknown };
		expect(report.datasets.find((entry) => entry.dataset === REPO)?.refused).toBeDefined();
		expect(report).toMatchObject({ state_file_persisted: true, versions_recorded: 0, cutover_event: null });
		expect(plane.uploads).toEqual([NOTES_BODY]);

		const persisted = await loadIngestRecords(fixture.stateFile);
		expect(persisted.records.get(`lightrag::${PLANE_REPO}::${sourceOf(NOTES)}`)).toMatchObject({ version: 3, document_id: "doc-up-1" });
		expect(persisted.records.has(`lightrag::${PLANE_REPO}::${sourceOf(EXTRA)}`)).toBe(false);
		expect(persisted.versions.get(REPO)?.some((version) => version.backend === "lightrag")).toBe(false);
	});
});

describe("docs-migrate: agent-skills layout", () => {
	test("an agent-skills archive of skill-layout pages replays without refusal and is ingested", async () => {
		const fixture = await buildFixture({ skills: true });
		const plane = matchedPlane();
		const { io } = captureIo();
		const readAt: ReadAtCommit = (commit, path) => {
			if (commit === COMMIT && path === SKILL) return Buffer.from(SKILL_BODY, "utf8");
			if (commit === COMMIT && path === SKILL_API) return Buffer.from(SKILL_API_BODY, "utf8");
			return REPLAY_READ(commit, path);
		};
		const outcome = await runApply(
			{
				archiveDir: fixture.archiveDir,
				stateFile: fixture.stateFile,
				config: CONFIG,
				fetchImpl: plane.fetch,
				partAFile: partAFile(fixture.root),
				rehearsal: false,
				datasets: ["agent-skills"],
				checkoutRepo: PLANE_REPO,
				readAtCommit: readAt,
				poll: { maxPolls: 1, intervalMs: 0 },
				now: () => 1_700_000_000_000,
			},
			io,
		);
		expect(outcome.exit).toBe(0);
		const report = outcome.report as { datasets: Array<{ dataset: string; ingested: number; refused?: string }> };
		const skillsReplay = report.datasets.find((entry) => entry.dataset === "agent-skills");
		expect(skillsReplay?.refused).toBeUndefined();
		expect(skillsReplay).toMatchObject({ ingested: 2 });
		expect(plane.uploads.sort()).toEqual([SKILL_BODY, SKILL_API_BODY].sort());
	});
});
