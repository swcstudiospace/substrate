/**
 * Manifest tests (D25-15, D25-17): atomic writes, corruption fallback,
 * rebuild-from-RAGFlow equivalence, lock serialisation, and the lookup
 * helpers search.ts consumes. State lives in per-test tmp dirs — no test
 * touches the production `SUBSTRATE_DOCS_STATE`.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtemp, readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearDatasetCache } from "./registry.ts";
import type { DatasetEntry } from "./registry.ts";
import { ingestPage } from "./ingest.ts";
import {
	currentDocumentIds,
	emptyManifest,
	loadManifest,
	lookupDocumentMeta,
	lookupPath,
	rebuildManifest,
	resolveStateDir,
	saveManifest,
	withDatasetLock,
} from "./manifest.ts";
import type { DocsManifest, DocsRagflow, ManifestFs, SectionDocMeta } from "./manifest.ts";
import type {
	RagflowDatasetSummary,
	RagflowDocument,
	UploadedDocument,
	UploadFile,
} from "./ragflow.ts";

const COMMIT_A = "a".repeat(40);

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

function url(commit: string, path: string): string {
	return `https://github.com/ExampleOrg/test-docs/blob/${commit}/${path}`;
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
	counts = { list: 0, upload: 0, parse: 0, update: 0, delete: 0 };

	async listDatasets(): Promise<RagflowDatasetSummary[]> {
		return [{ id: "ds-test", name: "test-docs", embeddingModel: undefined }];
	}

	async listDocuments(datasetId: string, page = 1, pageSize = 100): Promise<RagflowDocument[]> {
		void datasetId;
		this.counts.list += 1;
		const rows = [...this.docs.values()];
		return rows.slice((page - 1) * pageSize, page * pageSize).map((doc) => ({
			id: doc.id,
			name: doc.name,
			run: doc.run,
			metaFields: { ...doc.metaFields },
			raw: {},
		}));
	}

	/** Seed DONE documents directly, as a prior upload+parse would leave them. */
	async seed(path: string, commit: string, hash: string, sections: number): Promise<string[]> {
		const ids: string[] = [];
		for (let index = 0; index < sections; index += 1) {
			this.seq += 1;
			const id = `doc-${this.seq}`;
			this.docs.set(id, {
				id,
				name: `${path} #s${index} ${hash.slice(0, 12)}`,
				run: "DONE",
				metaFields: {
					source_url: index === 0 ? url(commit, path) : `${url(commit, path)}#s${index}`,
					heading_path: index === 0 ? [] : [`S${index}`],
					commit,
					title: "T",
					path,
					content_sha256: hash,
					section_index: index,
				},
				content: `section ${index}`,
			});
			ids.push(id);
		}
		return ids;
	}

	async uploadDocuments(_datasetId: string, files: UploadFile[]): Promise<UploadedDocument[]> {
		this.counts.upload += 1;
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
		this.counts.parse += 1;
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
		this.counts.update += 1;
		const doc = this.docs.get(documentId)!;
		if (patch.name !== undefined) doc.name = patch.name;
		if (patch.metaFields !== undefined) doc.metaFields = { ...patch.metaFields };
	}

	async deleteDocuments(_datasetId: string, documentIds: string[]): Promise<void> {
		this.counts.delete += 1;
		for (const id of documentIds) this.docs.delete(id);
	}

	async ensureDataset(name: string): Promise<string> {
		return `id-${name}`;
	}
}

let stateDir = "";
let fake = new FakeRagflow();

beforeEach(async () => {
	clearDatasetCache();
	stateDir = await mkdtemp(join(tmpdir(), "docs-25-02-manifest-"));
	fake = new FakeRagflow();
});

function sampleManifest(): DocsManifest {
	const manifest = emptyManifest("test-docs");
	manifest.current = COMMIT_A;
	manifest.versions.push({
		commit: COMMIT_A,
		paths: ["docs/a.md"],
		documentIds: ["doc-1", "doc-2"],
		cutAt: new Date().toISOString(),
	});
	manifest.paths["docs/a.md"] = {
		hash: "h".repeat(64),
		documentIds: ["doc-1", "doc-2"],
		meta: [
			{
				sourceUrl: url(COMMIT_A, "docs/a.md"),
				headingPath: [],
				commit: COMMIT_A,
				title: "A",
				path: "docs/a.md",
				contentSha256: "h".repeat(64),
				sectionIndex: 0,
			},
			{
				sourceUrl: `${url(COMMIT_A, "docs/a.md")}#part`,
				headingPath: ["A", "Part"],
				commit: COMMIT_A,
				title: "A",
				path: "docs/a.md",
				contentSha256: "h".repeat(64),
				sectionIndex: 1,
			},
		],
		updatedCommit: COMMIT_A,
	};
	return manifest;
}

describe("atomic manifest", () => {
	test("save then load round-trips", async () => {
		const expected = sampleManifest();
		await saveManifest("test-docs", expected, { stateDir });
		expect(await loadManifest("test-docs", { stateDir })).toEqual(expected);
	});

	test("a crash mid-write leaves the old manifest", async () => {
		const expected = sampleManifest();
		await saveManifest("test-docs", expected, { stateDir });
		const failingFs: ManifestFs = {
			readFile: (path) => readFile(path, "utf8"),
			writeFile: (path, content) => writeFile(path, content, "utf8"),
			rename: () => Promise.reject(new Error("disk lost")),
			mkdir: async (path) => {
				await mkdir(path, { recursive: true });
			},
		};
		const next = sampleManifest();
		next.current = null;
		await expect(saveManifest("test-docs", next, { stateDir, fs: failingFs })).rejects.toThrow("disk lost");
		expect(await loadManifest("test-docs", { stateDir })).toEqual(expected);
	});

	test("stray tmp files never confuse the load", async () => {
		const expected = sampleManifest();
		await saveManifest("test-docs", expected, { stateDir });
		await writeFile(join(stateDir, "test-docs", "manifest.json.tmp-1-1.json"), "garbage{", "utf8");
		expect(await loadManifest("test-docs", { stateDir })).toEqual(expected);
	});

	test("a missing file loads empty without a client", async () => {
		expect(await loadManifest("test-docs", { stateDir })).toEqual(emptyManifest("test-docs"));
	});

	test("corrupt JSON without a client loads empty, never throws", async () => {
		await mkdir(join(stateDir, "test-docs"), { recursive: true });
		await writeFile(join(stateDir, "test-docs", "manifest.json"), "{oops", "utf8");
		expect(await loadManifest("test-docs", { stateDir })).toEqual(emptyManifest("test-docs"));
	});

	test("every write lands under the given state dir", async () => {
		await saveManifest("test-docs", sampleManifest(), { stateDir });
		expect(await readdir(stateDir)).toEqual(["test-docs"]);
		expect(await readdir(join(stateDir, "test-docs"))).toEqual(["manifest.json"]);
	});
});

describe("rebuild from RAGFlow", () => {
	test("rebuild restores the path map from meta_fields alone", async () => {
		const hashA = "a".repeat(64);
		const hashB = "b".repeat(64);
		const idsA = await fake.seed("docs/a.md", COMMIT_A, hashA, 2);
		const idsB = await fake.seed("docs/b.md", COMMIT_A, hashB, 1);
		const rebuilt = await rebuildManifest("test-docs", fake, "ds-test");
		expect(rebuilt.dataset).toBe("test-docs");
		expect(rebuilt.current).toBeNull();
		expect(rebuilt.paths["docs/a.md"]!.hash).toBe(hashA);
		expect(rebuilt.paths["docs/a.md"]!.documentIds).toEqual(idsA);
		expect(rebuilt.paths["docs/b.md"]!.documentIds).toEqual(idsB);
		expect(rebuilt.paths["docs/a.md"]!.meta.map((row) => row.sectionIndex)).toEqual([0, 1]);
		expect(rebuilt.paths["docs/a.md"]!.meta[1]).toMatchObject({
			headingPath: ["S1"],
			commit: COMMIT_A,
			path: "docs/a.md",
			contentSha256: hashA,
		});
		expect(rebuilt.versions.map((row) => row.commit)).toEqual([COMMIT_A]);
		expect(rebuilt.versions[0]!.paths).toEqual(["docs/a.md", "docs/b.md"]);
	});

	test("same-commit different-hash uploads for one path rebuild to a single upload", async () => {
		const hashA = "a".repeat(64);
		const hashB = "b".repeat(64);
		const idsA = await fake.seed("docs/a.md", COMMIT_A, hashA, 1);
		const idsB = await fake.seed("docs/a.md", COMMIT_A, hashB, 1);
		const rebuilt = await rebuildManifest("test-docs", fake, "ds-test");
		const entry = rebuilt.paths["docs/a.md"]!;
		expect(entry.documentIds).toHaveLength(1);
		const single = entry.documentIds[0] === idsA[0] ? { hash: hashA, ids: idsA } : { hash: hashB, ids: idsB };
		expect(entry.documentIds).toEqual(single.ids);
		expect(entry.hash).toBe(single.hash);
		expect(entry.meta).toHaveLength(1);
		expect(entry.meta[0]!.contentSha256).toBe(single.hash);
		// The versions section stays commit-grouped: both uploads are listed.
		expect(rebuilt.versions.map((row) => row.commit)).toEqual([COMMIT_A]);
		expect([...rebuilt.versions[0]!.documentIds].sort()).toEqual([...idsA, ...idsB].sort());
	});

	test("a corrupt file rebuilds through loadManifest", async () => {
		const hashA = "a".repeat(64);
		const idsA = await fake.seed("docs/a.md", COMMIT_A, hashA, 1);
		await mkdir(join(stateDir, "test-docs"), { recursive: true });
		await writeFile(join(stateDir, "test-docs", "manifest.json"), "not json", "utf8");
		const loaded = await loadManifest("test-docs", { stateDir, client: fake, datasetId: "ds-test" });
		expect(loaded.paths["docs/a.md"]!.documentIds).toEqual(idsA);
	});

	test("a real ingest round-trips through loss and rebuild", async () => {
		const first = await ingestPage(
			{
				dataset: "test-docs",
				sourceUrl: url(COMMIT_A, "docs/guide.md"),
				commit: COMMIT_A,
				content: "# Guide\n\nBody.\n\n## Part\n\nMore.\n",
				surface: "substrate",
				isSubstrateOrOperator: true,
			},
			{ registry: REGISTRY, client: fake, stateDir },
		);
		expect(first.status).toBe("uploaded");
		if (first.status !== "uploaded") throw new Error("unreachable");
		const before = await loadManifest("test-docs", { stateDir });
		const rebuilt = await rebuildManifest("test-docs", fake, "ds-test");
		expect(rebuilt.paths["docs/guide.md"]!.hash).toBe(before.paths["docs/guide.md"]!.hash);
		expect(rebuilt.paths["docs/guide.md"]!.documentIds).toEqual(first.documentIds);
	});

	test("a rebuilt group whose parse never completed is dropped, not restored", async () => {
		// The parse call 404'd before the manifest was written: the upload
		// exists with metadata but its run never left UNSTART. Restoring it
		// would let the unchanged fast-path short-circuit forever, so the
		// rebuild drops the path and the next ingest re-parses.
		const hashA = "c".repeat(64);
		const ids = await fake.seed("docs/stuck.md", COMMIT_A, hashA, 1);
		fake.docs.get(ids[0]!)!.run = "UNSTART";
		const hashB = "d".repeat(64);
		const doneIds = await fake.seed("docs/done.md", COMMIT_A, hashB, 1);

		const rebuilt = await rebuildManifest("test-docs", fake, "ds-test");

		expect(rebuilt.paths["docs/stuck.md"]).toBeUndefined();
		expect(rebuilt.paths["docs/done.md"]!.documentIds).toEqual(doneIds);
		// A later group that did finish can still own the path.
		const laterIds = await fake.seed("docs/stuck.md", "f".repeat(40), hashB, 1);
		const second = await rebuildManifest("test-docs", fake, "ds-test");
		expect(second.paths["docs/stuck.md"]!.documentIds).toEqual(laterIds);
	});
});

describe("lookups for search", () => {
	test("path, document, and current-version lookups", async () => {
		await saveManifest("test-docs", sampleManifest(), { stateDir });
		const manifest = await loadManifest("test-docs", { stateDir });
		expect(lookupPath(manifest, "docs/a.md")!.hash).toBe("h".repeat(64));
		expect(lookupPath(manifest, "docs/missing.md")).toBeUndefined();
		const meta: SectionDocMeta | undefined = lookupDocumentMeta(manifest, "doc-2");
		expect(meta).toMatchObject({ sectionIndex: 1, headingPath: ["A", "Part"] });
		expect(lookupDocumentMeta(manifest, "doc-9")).toBeUndefined();
		expect([...currentDocumentIds(manifest)].sort()).toEqual(["doc-1", "doc-2"]);
	});

	test("no current version means nothing searchable", () => {
		expect(currentDocumentIds(emptyManifest("test-docs")).size).toBe(0);
	});
});

describe("state resolution and locks", () => {
	test("SUBSTRATE_DOCS_STATE roots the manifest; default is production", () => {
		expect(resolveStateDir({ SUBSTRATE_DOCS_STATE: "  /tmp/x  " })).toBe("/tmp/x");
		expect(resolveStateDir({})).toBe("/var/lib/substrate/docs");
	});

	test("the dataset lock serialises holders", async () => {
		const order: string[] = [];
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const first = withDatasetLock("ds", async () => {
			entered.resolve();
			order.push("first");
			await release.promise;
			order.push("first-done");
			return 1;
		});
		await entered.promise;
		const second = withDatasetLock("ds", async () => {
			order.push("second");
			return 2;
		});
		// The second body parks on the queued lock: only synchronous work has
		// run since its call, so it provably has not executed yet.
		expect(order).toEqual(["first"]);
		release.resolve();
		expect(await Promise.all([first, second])).toEqual([1, 2]);
		expect(order).toEqual(["first", "first-done", "second"]);
	});

	test("lock failures release the next holder", async () => {
		await expect(
			withDatasetLock("ds", async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(await withDatasetLock("ds", async () => "recovered")).toBe("recovered");
	});
});
