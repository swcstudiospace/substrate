/**
 * Docs idempotency manifest (D25-15, D25-17).
 *
 * One JSON file per dataset at `<stateDir>/<dataset>/manifest.json`, where
 * `stateDir` resolves from `SUBSTRATE_DOCS_STATE` (default
 * `/var/lib/substrate/docs`). Shape:
 * `{ versions[], current, paths: { <path> -> { hash, documentIds[], meta[] } } }`.
 *
 * Rules:
 * - The only write path is temp-file + rename (atomic). Callers MUST hold
 *   {@link withDatasetLock} across read-modify-write; `saveManifest` itself
 *   does not lock (the lock is not re-entrant).
 * - A missing or corrupt file never throws: without a client it yields a
 *   fresh manifest, with a client it rebuilds from RAGFlow document
 *   name/meta_fields. A rebuild restores idempotency (path -> hash ->
 *   document ids) and source metadata; `current` stays null until the next
 *   `finalize` cuts a version, because recency order is not recoverable from
 *   RAGFlow metadata alone.
 * - D25-17 enforcement is preference 3 (post-filter; see ragflow.ts): only
 *   the current version is searchable. {@link currentDocumentIds} is the set
 *   search.ts filters against.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_DOCS_STATE } from "../config.ts";
import type {
	RagflowDatasetSummary,
	RagflowDocument,
	UploadedDocument,
	UploadFile,
} from "./ragflow.ts";

/**
 * Structural seam every docs door uses instead of `RagflowClient` directly,
 * so unit tests can pass an in-process fake with zero network calls. The real
 * `RagflowClient` satisfies this interface (asserted in ingest.test.ts).
 */
export interface DocsRagflow {
	listDatasets(): Promise<RagflowDatasetSummary[]>;
	listDocuments(datasetId: string, page?: number, pageSize?: number): Promise<RagflowDocument[]>;
	uploadDocuments(datasetId: string, files: UploadFile[]): Promise<UploadedDocument[]>;
	parseDocuments(datasetId: string, documentIds: string[]): Promise<void>;
	updateDocument(
		datasetId: string,
		documentId: string,
		patch: { name?: string; metaFields?: Record<string, unknown> },
	): Promise<void>;
	deleteDocuments(datasetId: string, documentIds: string[]): Promise<void>;
	ensureDataset(
		name: string,
		options?: { description?: string; embeddingModel?: string; chunkMethod?: string },
	): Promise<string>;
}

/** Per-section source metadata carried in RAGFlow meta_fields (D25-16). */
export interface SectionDocMeta {
	sourceUrl: string;
	headingPath: string[];
	commit: string;
	title: string;
	path: string;
	contentSha256: string;
	sectionIndex: number;
}

export interface ManifestPathEntry {
	hash: string;
	documentIds: string[];
	meta: SectionDocMeta[];
	updatedCommit: string;
}

export interface ManifestVersion {
	commit: string;
	paths: string[];
	documentIds: string[];
	cutAt: string;
}

export interface DocsManifest {
	version: 1;
	dataset: string;
	current: string | null;
	versions: ManifestVersion[];
	paths: Record<string, ManifestPathEntry>;
}

export function emptyManifest(dataset: string): DocsManifest {
	return { version: 1, dataset, current: null, versions: [], paths: {} };
}

/** `SUBSTRATE_DOCS_STATE`, trimmed, else the production default. Never throws. */
export function resolveStateDir(env: Record<string, string | undefined> = process.env): string {
	return env.SUBSTRATE_DOCS_STATE?.trim() || DEFAULT_DOCS_STATE;
}

/** Injectable filesystem seam; the crash test fails `rename` mid-write. */
export interface ManifestFs {
	readFile(path: string): Promise<string>;
	writeFile(path: string, content: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	mkdir(path: string): Promise<void>;
}

const defaultFs: ManifestFs = {
	readFile: (path) => readFile(path, "utf8"),
	writeFile: (path, content) => writeFile(path, content, "utf8"),
	rename: (from, to) => rename(from, to),
	mkdir: async (path) => {
		await mkdir(path, { recursive: true });
	},
};

let tmpCounter = 0;

function manifestPath(stateDir: string, dataset: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(dataset)) {
		throw new Error(`refusing to resolve a manifest path for dataset ${JSON.stringify(dataset)}`);
	}
	return join(stateDir, dataset, "manifest.json");
}

function isMeta(value: unknown): value is SectionDocMeta {
	const record = value as Record<string, unknown>;
	return (
		typeof record === "object" &&
		record !== null &&
		typeof record.sourceUrl === "string" &&
		(Array.isArray(record.headingPath) || typeof record.headingPath === "string") &&
		typeof record.commit === "string" &&
		typeof record.title === "string" &&
		typeof record.path === "string" &&
		typeof record.contentSha256 === "string" &&
		typeof record.sectionIndex === "number"
	);
}

function isManifest(value: unknown): value is DocsManifest {
	const record = value as Record<string, unknown>;
	if (typeof record !== "object" || record === null) return false;
	if (record.version !== 1 || typeof record.dataset !== "string") return false;
	if (record.current !== null && typeof record.current !== "string") return false;
	if (!Array.isArray(record.versions) || typeof record.paths !== "object" || record.paths === null) {
		return false;
	}
	return true;
}

function metaFromFields(meta: Record<string, unknown>): SectionDocMeta | null {
	const candidate = {
		sourceUrl: meta.source_url,
		headingPath: meta.heading_path,
		commit: meta.commit,
		title: meta.title,
		path: meta.path,
		contentSha256: meta.content_sha256,
		sectionIndex: meta.section_index,
	};
	if (!isMeta(candidate)) return null;
	return {
		...candidate,
		headingPath: Array.isArray(candidate.headingPath)
			? [...candidate.headingPath]
			: [candidate.headingPath],
	};
}

/**
 * Rebuild the path map from RAGFlow document metadata alone. Versions regroup
 * per commit (sorted, deterministic); `current` stays null — the next
 * finalize restores currency, cheaply, because idempotency survived.
 */
export async function rebuildManifest(
	dataset: string,
	client: DocsRagflow,
	datasetId: string,
): Promise<DocsManifest> {
	const manifest = emptyManifest(dataset);
	const byPath = new Map<string, Array<{ id: string; meta: SectionDocMeta; run: string }>>();
	const byCommit = new Map<string, { paths: Set<string>; documentIds: string[] }>();
	let page = 1;
	for (;;) {
		const docs = await client.listDocuments(datasetId, page, 100);
		for (const doc of docs) {
			const meta = metaFromFields(doc.metaFields);
			if (!meta) continue;
			let rows = byPath.get(meta.path);
			if (!rows) {
				rows = [];
				byPath.set(meta.path, rows);
			}
			rows.push({ id: doc.id, meta, run: doc.run });
			let group = byCommit.get(meta.commit);
			if (!group) {
				group = { paths: new Set(), documentIds: [] };
				byCommit.set(meta.commit, group);
			}
			group.paths.add(meta.path);
			group.documentIds.push(doc.id);
		}
		if (docs.length < 100) break;
		page += 1;
	}
	const now = new Date().toISOString();
	for (const [path, rows] of [...byPath.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
		// Recency is not recoverable from RAGFlow metadata, so the live entry
		// is a heuristic: the largest same-commit-and-content group (the current
		// version usually holds every page), ties broken by commit then hash
		// for determinism. A title-only re-upload at the same commit leaves two
		// hashes behind; commit-only grouping would merge them into one entry
		// holding one hash and both uploads' document IDs. A wrong pick costs
		// at most one extra upload: the next refresh re-ingests, and its
		// finalize restores the exact state.
		// A rebuilt entry asserts a completed parse. A document that never
		// reached DONE — the parse call 404'd before the manifest was
		// written, the process died between queue and run, or RAGFlow
		// failed it — must not re-enter here, or the unchanged fast-path
		// would short-circuit on it forever. Drop the group; the next
		// ingest re-uploads and re-parses the whole page.
		const groups = new Map<string, Array<{ id: string; meta: SectionDocMeta; run: string }>>();
		for (const row of rows) {
			const key = `${row.meta.commit} ${row.meta.contentSha256}`;
			let group = groups.get(key);
			if (!group) {
				group = [];
				groups.set(key, group);
			}
			group.push(row);
		}
		const live = [...groups.values()]
			.filter((rowsInGroup) => rowsInGroup.every((row) => row.run === "DONE"))
			.sort(
				(a, b) => b.length - a.length || (a[0]!.meta.commit < b[0]!.meta.commit ? -1 : a[0]!.meta.commit > b[0]!.meta.commit ? 1 : a[0]!.meta.contentSha256 < b[0]!.meta.contentSha256 ? -1 : a[0]!.meta.contentSha256 > b[0]!.meta.contentSha256 ? 1 : 0),
			)[0];
		if (!live) continue;
		live.sort((a, b) => a.meta.sectionIndex - b.meta.sectionIndex);
		manifest.paths[path] = {
			hash: live[0]!.meta.contentSha256,
			documentIds: live.map((row) => row.id),
			meta: live.map((row) => row.meta),
			updatedCommit: live[0]!.meta.commit,
		};
	}
	for (const commit of [...byCommit.keys()].sort()) {
		const group = byCommit.get(commit)!;
		manifest.versions.push({
			commit,
			paths: [...group.paths].sort(),
			documentIds: group.documentIds,
			cutAt: now,
		});
	}
	return manifest;
}

export interface ManifestDeps {
	stateDir?: string;
	env?: Record<string, string | undefined>;
	fs?: ManifestFs;
	client?: DocsRagflow;
	datasetId?: string;
}

/**
 * Load the dataset manifest. A missing or corrupt file falls back to a
 * rebuild when a client + dataset id are given, else to an empty manifest.
 * Never throws for a bad file; RAGFlow failures propagate so the caller can
 * answer `failed` instead of silently re-uploading the world.
 */
export async function loadManifest(dataset: string, deps: ManifestDeps = {}): Promise<DocsManifest> {
	const stateDir = deps.stateDir ?? resolveStateDir(deps.env);
	const fs = deps.fs ?? defaultFs;
	let raw: string;
	try {
		raw = await fs.readFile(manifestPath(stateDir, dataset));
	} catch {
		if (deps.client && deps.datasetId) return rebuildManifest(dataset, deps.client, deps.datasetId);
		return emptyManifest(dataset);
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (isManifest(parsed) && parsed.dataset === dataset) return parsed;
	} catch {
		// Corrupt JSON falls through to the rebuild below.
	}
	if (deps.client && deps.datasetId) return rebuildManifest(dataset, deps.client, deps.datasetId);
	return emptyManifest(dataset);
}

/**
 * The only write path: temp file + rename. Call with the dataset lock held.
 * A crash before the rename leaves the old manifest (and an ignored tmp
 * file) behind.
 */
export async function saveManifest(
	dataset: string,
	manifest: DocsManifest,
	deps: ManifestDeps = {},
): Promise<void> {
	const stateDir = deps.stateDir ?? resolveStateDir(deps.env);
	const fs = deps.fs ?? defaultFs;
	const target = manifestPath(stateDir, dataset);
	await fs.mkdir(join(stateDir, dataset));
	tmpCounter += 1;
	const tmp = `${target}.tmp-${process.pid}-${tmpCounter}.json`;
	await fs.writeFile(tmp, JSON.stringify(manifest));
	await fs.rename(tmp, target);
}

/** Path entry lookup (idempotency + metadata). */
export function lookupPath(manifest: DocsManifest, path: string): ManifestPathEntry | undefined {
	return manifest.paths[path];
}

/** Source metadata for one RAGFlow document id, or undefined when unknown. */
export function lookupDocumentMeta(manifest: DocsManifest, documentId: string): SectionDocMeta | undefined {
	// Entries keep document ids aligned with their section metadata, so the
	// position of the id is the position of its row.
	for (const entry of Object.values(manifest.paths)) {
		const index = entry.documentIds.indexOf(documentId);
		if (index !== -1) return entry.meta[index];
	}
	return undefined;
}

/**
 * Document ids of the current version's paths — the D25-17 post-filter set
 * search.ts intersects retrieval hits with. Empty when no version was cut.
 */
export function currentDocumentIds(manifest: DocsManifest): Set<string> {
	const out = new Set<string>();
	if (!manifest.current) return out;
	const version = manifest.versions.find((row) => row.commit === manifest.current);
	if (!version) return out;
	for (const path of version.paths) {
		for (const id of manifest.paths[path]?.documentIds ?? []) out.add(id);
	}
	return out;
}

// --- Per-dataset in-process lock -------------------------------------------

const tails = new Map<string, Promise<void>>();

/**
 * Serialise async work per dataset key: concurrent identical ingests collapse
 * to one upload because the idempotency check and the upload share the lock.
 * Independent datasets proceed in parallel. Never rejects from queueing —
 * only `fn`'s own outcome propagates.
 */
export async function withDatasetLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const prev = tails.get(key);
	const head = (prev ?? Promise.resolve()).catch(() => {});
	let release!: () => void;
	const mine = new Promise<void>((resolve) => {
		release = resolve;
	});
	const chained = head.then(() => mine);
	tails.set(key, chained);
	try {
		await head;
		return await fn();
	} finally {
		release();
		if (tails.get(key) === chained) tails.delete(key);
	}
}
