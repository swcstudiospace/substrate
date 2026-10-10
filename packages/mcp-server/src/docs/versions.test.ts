/**
 * Version cutter tests (D25-17): finalize cuts, absent pages go unsearchable,
 * retention keeps five, failures keep the previous version. In-process fake
 * only — zero network calls, tmp state dirs only.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RagflowError } from "./ragflow.ts";
import type {
	RagflowDatasetSummary,
	RagflowDocument,
	UploadedDocument,
	UploadFile,
} from "./ragflow.ts";
import { clearDatasetCache } from "./registry.ts";
import type { DatasetEntry } from "./registry.ts";
import { ingestPage } from "./ingest.ts";
import { currentDocumentIds, loadManifest } from "./manifest.ts";
import type { DocsRagflow } from "./manifest.ts";
import { KEEP_VERSIONS, finalize } from "./versions.ts";

const REGISTRY: DatasetEntry[] = [
	{
		name: "test-docs",
		slug: "ExampleOrg/test-docs",
		include: ["docs/**/*.md"],
		exclude: [],
		trigger: "merge-to-main",
		datasetId: "ds-test",
	},
];

function commit(index: number): string {
	return String(index).repeat(40);
}

function url(commitSha: string, path: string): string {
	return `https://github.com/ExampleOrg/test-docs/blob/${commitSha}/${path}`;
}

interface StoredDoc {
	id: string;
	name: string;
	run: string;
	metaFields: Record<string, unknown>;
	content: string;
}

class FakeRagflow implements DocsRagflow {
	docs = new Map<string, StoredDoc>();
	seq = 0;
	calls = { list: 0, upload: 0, parse: 0, update: 0, delete: 0, ensure: 0 };
	failListsWith: Error | null = null;
	failDeletesWith: Error | null = null;

	totalCalls(): number {
		return Object.values(this.calls).reduce((a, b) => a + b, 0);
	}

	setRun(id: string, run: string): void {
		this.docs.get(id)!.run = run;
	}

	drop(id: string): void {
		this.docs.delete(id);
	}

	async listDatasets(): Promise<RagflowDatasetSummary[]> {
		return [{ id: "ds-test", name: "test-docs", embeddingModel: undefined }];
	}

	async listDocuments(datasetId: string, page = 1, pageSize = 100): Promise<RagflowDocument[]> {
		void datasetId;
		this.calls.list += 1;
		if (this.failListsWith) throw this.failListsWith;
		const rows = [...this.docs.values()];
		return rows.slice((page - 1) * pageSize, page * pageSize).map((doc) => ({
			id: doc.id,
			name: doc.name,
			run: doc.run,
			metaFields: { ...doc.metaFields },
			raw: {},
		}));
	}

	async uploadDocuments(_datasetId: string, files: UploadFile[]): Promise<UploadedDocument[]> {
		this.calls.upload += 1;
		return files.map((file) => {
			this.seq += 1;
			const id = `doc-${this.seq}`;
			this.docs.set(id, {
				id,
				name: file.filename,
				run: "UNSTART",
				metaFields: {},
				content: String(file.content),
			});
			return { documentId: id, name: file.filename };
		});
	}

	async parseDocuments(_datasetId: string, documentIds: string[]): Promise<void> {
		this.calls.parse += 1;
		for (const id of documentIds) {
			const doc = this.docs.get(id);
			if (doc) doc.run = "DONE";
		}
	}

	async updateDocument(
		_datasetId: string,
		documentId: string,
		patch: { name?: string; metaFields?: Record<string, unknown> },
	): Promise<void> {
		this.calls.update += 1;
		const doc = this.docs.get(documentId)!;
		if (patch.name !== undefined) doc.name = patch.name;
		if (patch.metaFields !== undefined) doc.metaFields = { ...patch.metaFields };
	}

	async deleteDocuments(_datasetId: string, documentIds: string[]): Promise<void> {
		this.calls.delete += 1;
		if (this.failDeletesWith) throw this.failDeletesWith;
		for (const id of documentIds) this.docs.delete(id);
	}

	async ensureDataset(name: string): Promise<string> {
		this.calls.ensure += 1;
		return `id-${name}`;
	}
}

let stateDir = "";
let fake = new FakeRagflow();

beforeEach(async () => {
	clearDatasetCache();
	stateDir = await mkdtemp(join(tmpdir(), "docs-25-02-versions-"));
	fake = new FakeRagflow();
});

function writer(over: Record<string, unknown> = {}) {
	return { surface: "substrate", isSubstrateOrOperator: true, ...over };
}

async function ingest(path: string, version: number, content?: string) {
	const sha = commit(version);
	const result = await ingestPage(
		{
			dataset: "test-docs",
			sourceUrl: url(sha, path),
			commit: sha,
			content: content ?? `# T\n\nv${version}\n`,
			...writer(),
		},
		{ registry: REGISTRY, client: fake, stateDir },
	);
	expect(result.status).toBe("uploaded");
	if (result.status !== "uploaded") throw new Error("ingest precondition failed");
	return result;
}

describe("finalize", () => {
	test("a cut marks the version current with its paths", async () => {
		const ingested = await ingest("docs/guide.md", 1);
		const cut = await finalize(
			{ dataset: "test-docs", commit: commit(1), pathsPresent: ["docs/guide.md"], ...writer() },
			{ registry: REGISTRY, client: fake, stateDir },
		);
		expect(cut).toMatchObject({
			status: "version-cut",
			dataset: "test-docs",
			datasetId: "ds-test",
			commit: commit(1),
			paths: ["docs/guide.md"],
			versions: 1,
			deletedDocumentIds: [],
		});
		const manifest = await loadManifest("test-docs", { stateDir });
		expect(manifest.current).toBe(commit(1));
		expect([...currentDocumentIds(manifest)].sort()).toEqual([...ingested.documentIds].sort());
	});

	test("absent pages leave the searchable set and are pruned", async () => {
		await ingest("docs/keep.md", 1, "# Keep\n\nStay.\n");
		const gone = await ingest("docs/gone.md", 1, "# Gone\n\nLeave.\n");
		const cut = await finalize(
			{ dataset: "test-docs", commit: commit(1), pathsPresent: ["docs/keep.md"], ...writer() },
			{ registry: REGISTRY, client: fake, stateDir },
		);
		expect(cut.status).toBe("version-cut");
		if (cut.status !== "version-cut") throw new Error("unreachable");
		expect(cut.paths).toEqual(["docs/keep.md"]);
		expect(cut.deletedDocumentIds.sort()).toEqual([...gone.documentIds].sort());
		const manifest = await loadManifest("test-docs", { stateDir });
	 const searchable = currentDocumentIds(manifest);
		for (const id of gone.documentIds) expect(searchable.has(id)).toBe(false);
		expect(fake.docs.size).toBe(2);
	});

	test("a cut is refused after manifest loss while a page is still parsing", async () => {
		const ingested = await ingest("docs/guide.md", 1);
		// The manifest file is lost while the parse is still in flight: the
		// rebuild must keep the page (marked unparsed) so finalize gates the
		// cut on its parse instead of cutting a version without the page.
		await rm(join(stateDir, "test-docs", "manifest.json"));
		for (const id of ingested.documentIds) fake.setRun(id, "UNSTART");
		const refused = await finalize(
			{ dataset: "test-docs", commit: commit(1), pathsPresent: ["docs/guide.md"], ...writer() },
			{ registry: REGISTRY, client: fake, stateDir },
		);
		expect(refused).toMatchObject({ status: "failed", reason: "ragflow-error" });
		if (refused.status !== "failed") throw new Error("unreachable");
		expect(refused.message).toContain("run UNSTART");

		// Once the parse lands, the same cut succeeds with the page included.
		for (const id of ingested.documentIds) fake.setRun(id, "DONE");
		const cut = await finalize(
			{ dataset: "test-docs", commit: commit(1), pathsPresent: ["docs/guide.md"], ...writer() },
			{ registry: REGISTRY, client: fake, stateDir },
		);
		expect(cut).toMatchObject({ status: "version-cut", paths: ["docs/guide.md"] });
	});

	test("never-ingested paths are simply absent from the cut", async () => {
		await ingest("docs/guide.md", 1);
		const cut = await finalize(
			{
				dataset: "test-docs",
				commit: commit(1),
				pathsPresent: ["docs/guide.md", "docs/refused.md"],
				...writer(),
			},
			{ registry: REGISTRY, client: fake, stateDir },
		);
		expect(cut).toMatchObject({ status: "version-cut", paths: ["docs/guide.md"] });
	});

	test("six sequential versions leave five with old documents deleted", async () => {
		expect(KEEP_VERSIONS).toBe(5);
		let lastIds: string[] = [];
		for (let version = 1; version <= 6; version += 1) {
			const ingested = await ingest("docs/guide.md", version);
			lastIds = ingested.documentIds;
			const cut = await finalize(
				{ dataset: "test-docs", commit: commit(version), pathsPresent: ["docs/guide.md"], ...writer() },
				{ registry: REGISTRY, client: fake, stateDir },
			);
			expect(cut.status).toBe("version-cut");
		}
		const manifest = await loadManifest("test-docs", { stateDir });
		expect(manifest.versions.length).toBe(5);
		expect(manifest.versions.map((row) => row.commit)).toEqual([
			commit(2),
			commit(3),
			commit(4),
			commit(5),
			commit(6),
		]);
		expect(manifest.current).toBe(commit(6));
		// Two sections per version, five live versions.
		expect(fake.docs.size).toBe(10);
		expect([...currentDocumentIds(manifest)].sort()).toEqual([...lastIds].sort());
	});

	test("unchanged pages ride into the new version with no upload", async () => {
		const first = await ingest("docs/guide.md", 1);
		await finalize(
			{ dataset: "test-docs", commit: commit(1), pathsPresent: ["docs/guide.md"], ...writer() },
			{ registry: REGISTRY, client: fake, stateDir },
		);
		const uploads = fake.calls.upload;
		const again = await ingestPage(
			{
				dataset: "test-docs",
				sourceUrl: url(commit(2), "docs/guide.md"),
				commit: commit(2),
				content: "# T\n\nv1\n",
				...writer(),
			},
			{ registry: REGISTRY, client: fake, stateDir },
		);
		expect(again.status).toBe("unchanged");
		const cut = await finalize(
			{ dataset: "test-docs", commit: commit(2), pathsPresent: ["docs/guide.md"], ...writer() },
			{ registry: REGISTRY, client: fake, stateDir },
		);
		expect(cut).toMatchObject({ status: "version-cut", paths: ["docs/guide.md"], versions: 2 });
		expect(fake.calls.upload).toBe(uploads);
		const manifest = await loadManifest("test-docs", { stateDir });
		expect(manifest.current).toBe(commit(2));
		expect([...currentDocumentIds(manifest)].sort()).toEqual([...first.documentIds].sort());
	});

	test("failed, pending, or missing parses block the cut", async () => {
		for (const run of ["FAIL", "UNSTART", "CANCEL"]) {
			clearDatasetCache();
			const fresh = new FakeRagflow();
			const ingested = await ingestPage(
				{
					dataset: "test-docs",
					sourceUrl: url(commit(1), "docs/guide.md"),
					commit: commit(1),
					content: `# T\n\nrun ${run}\n`,
					...writer(),
				},
				{ registry: REGISTRY, client: fresh, stateDir },
			);
			expect(ingested.status).toBe("uploaded");
			if (ingested.status !== "uploaded") throw new Error("unreachable");
			for (const id of ingested.documentIds) fresh.setRun(id, run);
			const cut = await finalize(
				{ dataset: "test-docs", commit: commit(1), pathsPresent: ["docs/guide.md"], ...writer() },
				{ registry: REGISTRY, client: fresh, stateDir },
			);
			expect(cut.status).toBe("failed");
			if (cut.status !== "failed") throw new Error("unreachable");
			expect(cut.message).toContain(run === "UNSTART" ? "UNSTART" : run);
		}
		const manifest = await loadManifest("test-docs", { stateDir });
		expect(manifest.current).toBeNull();
		expect(manifest.versions).toEqual([]);
		const ingested = await ingestPage(
			{
				dataset: "test-docs",
				sourceUrl: url(commit(2), "docs/other.md"),
				commit: commit(2),
				content: "# O\n\nBody.\n",
				...writer(),
			},
			{ registry: REGISTRY, client: fake, stateDir },
		);
		expect(ingested.status).toBe("uploaded");
		if (ingested.status !== "uploaded") throw new Error("unreachable");
		for (const id of ingested.documentIds) fake.drop(id);
		const missing = await finalize(
			{ dataset: "test-docs", commit: commit(2), pathsPresent: ["docs/other.md"], ...writer() },
			{ registry: REGISTRY, client: fake, stateDir },
		);
		expect(missing.status).toBe("failed");
	});

	test("RAGFlow failures keep the previous version current", async () => {
		await ingest("docs/guide.md", 1);
		await finalize(
			{ dataset: "test-docs", commit: commit(1), pathsPresent: ["docs/guide.md"], ...writer() },
			{ registry: REGISTRY, client: fake, stateDir },
		);
		fake.failListsWith = new RagflowError("ragflow timeout after 10ms");
		const timed = await finalize(
			{ dataset: "test-docs", commit: commit(2), pathsPresent: ["docs/guide.md"], ...writer() },
			{ registry: REGISTRY, client: fake, stateDir },
		);
		expect(timed).toEqual({
			status: "failed",
			reason: "ragflow-timeout",
			message: "ragflow timeout after 10ms",
		});
		fake.failListsWith = null;
		// A page uploaded but never versioned is stale at the next cut; its
		// delete failing must fail the cut, not move the current pointer.
		await ingest("docs/stale.md", 3, "# Stale\n\nNever versioned.\n");
		fake.failDeletesWith = new RagflowError("ragflow error 109: gone");
		const deleted = await finalize(
			{ dataset: "test-docs", commit: commit(3), pathsPresent: ["docs/guide.md"], ...writer() },
			{ registry: REGISTRY, client: fake, stateDir },
		);
		expect(deleted.status).toBe("failed");
		const manifest = await loadManifest("test-docs", { stateDir });
		expect(manifest.current).toBe(commit(1));
		expect(manifest.versions.length).toBe(1);
	});

	test("writer, dataset, and commit refusals never reach RAGFlow", async () => {
		const forbidden = await finalize(
			{ dataset: "test-docs", commit: commit(1), pathsPresent: [], ...writer({ isSubstrateOrOperator: false }) },
			{ registry: REGISTRY, client: fake, stateDir },
		);
		expect(forbidden).toEqual({ status: "refused", reason: "forbidden" });
		const unknown = await finalize(
			{ dataset: "nope", commit: commit(1), pathsPresent: [], ...writer() },
			{ registry: REGISTRY, client: fake, stateDir },
		);
		expect(unknown).toEqual({ status: "refused", reason: "unknown-dataset" });
		const badCommit = await finalize(
			{ dataset: "test-docs", commit: "zzz", pathsPresent: [], ...writer() },
			{ registry: REGISTRY, client: fake, stateDir },
		);
		expect(badCommit).toEqual({ status: "refused", reason: "outside-roots" });
		expect(fake.totalCalls()).toBe(0);
		expect(await readdir(stateDir)).toEqual([]);
	});

	test("overlapping runs cut their own run's documents via a per-run snapshot", async () => {
		const first = await ingest("docs/guide.md", 1);
		// An overlapping run re-ingests the same page before this run finalizes.
		await ingest("docs/guide.md", 2);
		const cut = await finalize(
			{
				dataset: "test-docs",
				commit: commit(1),
				pathsPresent: ["docs/guide.md"],
				pages: [{ path: "docs/guide.md", hash: first.contentSha256, documentIds: [...first.documentIds] }],
				...writer(),
			},
			{ registry: REGISTRY, client: fake, stateDir },
		);
		expect(cut.status).toBe("version-cut");
		const manifest = await loadManifest("test-docs", { stateDir });
		expect(manifest.current).toBe(commit(1));
		expect([...currentDocumentIds(manifest)].sort()).toEqual([...first.documentIds].sort());
	});

	test("a snapshot with unparsed documents blocks the cut", async () => {
		const first = await ingest("docs/guide.md", 1);
		for (const id of first.documentIds) fake.setRun(id, "FAIL");
		const cut = await finalize(
			{
				dataset: "test-docs",
				commit: commit(1),
				pathsPresent: ["docs/guide.md"],
				pages: [{ path: "docs/guide.md", hash: first.contentSha256, documentIds: [...first.documentIds] }],
				...writer(),
			},
			{ registry: REGISTRY, client: fake, stateDir },
		);
		expect(cut.status).toBe("failed");
		if (cut.status !== "failed") throw new Error("unreachable");
		expect(cut.message).toContain("FAIL");
	});

	test("a page pruned out of retention re-ingests instead of reusing deleted ids", async () => {
		const content = "# Return\n\nSame.\n";
		await ingest("docs/return.md", 1, content);
		const first = await finalize(
			{ dataset: "test-docs", commit: commit(1), pathsPresent: ["docs/return.md"], ...writer() },
			{ registry: REGISTRY, client: fake, stateDir },
		);
		expect(first.status).toBe("version-cut");
		for (let version = 2; version <= 6; version += 1) {
			const cut = await finalize(
				{ dataset: "test-docs", commit: commit(version), pathsPresent: [], ...writer() },
				{ registry: REGISTRY, client: fake, stateDir },
			);
			expect(cut.status).toBe("version-cut");
		}
		const pruned = await loadManifest("test-docs", { stateDir });
		expect(pruned.paths["docs/return.md"]).toBeUndefined();
		const restored = await ingestPage(
			{
				dataset: "test-docs",
				sourceUrl: url(commit(7), "docs/return.md"),
				commit: commit(7),
				content,
				...writer(),
			},
			{ registry: REGISTRY, client: fake, stateDir },
		);
		expect(restored.status).toBe("uploaded");
		if (restored.status !== "uploaded") throw new Error("unreachable");
		const cut = await finalize(
			{ dataset: "test-docs", commit: commit(7), pathsPresent: ["docs/return.md"], ...writer() },
			{ registry: REGISTRY, client: fake, stateDir },
		);
		expect(cut).toMatchObject({ status: "version-cut", paths: ["docs/return.md"] });
		const manifest = await loadManifest("test-docs", { stateDir });
		expect([...currentDocumentIds(manifest)].sort()).toEqual([...restored.documentIds].sort());
	});

	test("an in-flight page from another run survives a cut that does not cover it", async () => {
		await ingest("docs/first.md", 1, "# First\n\nOne.\n");
		const second = await ingest("docs/second.md", 1, "# Second\n\nTwo.\n");
		for (const id of second.documentIds) fake.setRun(id, "UNSTART");
		const cut = await finalize(
			{ dataset: "test-docs", commit: commit(1), pathsPresent: ["docs/first.md"], ...writer() },
			{ registry: REGISTRY, client: fake, stateDir },
		);
		expect(cut.status).toBe("version-cut");
		if (cut.status !== "version-cut") throw new Error("unreachable");
		expect(cut.paths).toEqual(["docs/first.md"]);
		expect(cut.deletedDocumentIds).toEqual([]);
		for (const id of second.documentIds) expect(fake.docs.has(id)).toBe(true);
		const manifest = await loadManifest("test-docs", { stateDir });
		expect(manifest.paths["docs/second.md"]?.documentIds.sort()).toEqual([...second.documentIds].sort());

		// Once the parse lands, a cut that still omits the page prunes it.
		for (const id of second.documentIds) fake.setRun(id, "DONE");
		const pruned = await finalize(
			{ dataset: "test-docs", commit: commit(2), pathsPresent: ["docs/first.md"], ...writer() },
			{ registry: REGISTRY, client: fake, stateDir },
		);
		expect(pruned.status).toBe("version-cut");
		if (pruned.status !== "version-cut") throw new Error("unreachable");
		expect(pruned.deletedDocumentIds.sort()).toEqual([...second.documentIds].sort());
		const after = await loadManifest("test-docs", { stateDir });
		expect(after.paths["docs/second.md"]).toBeUndefined();
	});

	test("a failed page absent from the cut is pruned", async () => {
		await ingest("docs/first.md", 1, "# First\n\nOne.\n");
		const second = await ingest("docs/second.md", 1, "# Second\n\nTwo.\n");
		for (const id of second.documentIds) fake.setRun(id, "FAIL");
		const cut = await finalize(
			{ dataset: "test-docs", commit: commit(1), pathsPresent: ["docs/first.md"], ...writer() },
			{ registry: REGISTRY, client: fake, stateDir },
		);
		expect(cut.status).toBe("version-cut");
		if (cut.status !== "version-cut") throw new Error("unreachable");
		expect(cut.deletedDocumentIds.sort()).toEqual([...second.documentIds].sort());
		const manifest = await loadManifest("test-docs", { stateDir });
		expect(manifest.paths["docs/second.md"]).toBeUndefined();
		for (const id of second.documentIds) expect(fake.docs.has(id)).toBe(false);
	});
});
