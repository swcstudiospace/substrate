/** The docs archive writer (SOTA-02): checksummed snapshot of the docs plane state for verification and migration replay. */
/**
 * The docs archive (SOTA-02, Phase 46, Task 3): a checksummed copy of what the docs plane holds, written and
 * read back before any deletion. It keeps the dataset and document inventory, the substrate's docs state
 * file, the baseline citations for the frozen queries, and a check of every document against its committed object.
 * `verifyArchive` re-reads the directory and refuses any drift from its manifest, so a deletion gated on a passing
 * verification is gated on the archive that is actually on disk.
 *
 * Page bytes are not archived. Each page is re-read from git at its recorded commit (OD-4), and only the sha256 of
 * its sanitised body is kept, computed by the ingest's own `changeSha`. The reads go through
 * {@link DocsArchiveSource}: production uses {@link docsArchiveSource}, and tests drive the same writer with the
 * docs plane fake.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { stripRemoteImages } from "@substrate/corpus";
import { changeSha, loadIngestRecords, type IngestRecord } from "./docs-ingest.ts";
import { refusedMount, type DevReader } from "./ledger-archive.ts";
import { redact } from "./redact.ts";
import { DEFAULT_RETRIEVAL_KNOBS, type DatasetListOutcome, type DocsChunk, type DocsDataset, type FetchLike, type RetrievalOutcome } from "./planes/docs-wire.ts";
import { listDatasets as listDatasetsFromPlane } from "./docs-datasets.ts";

interface DocsDocument {
	id: string;
	name: string;
	meta_fields: { source_url: string | undefined; commit: string | undefined; heading_path: string | undefined };
}
type DocumentListOutcome = { ok: true; documents: DocsDocument[] } | { ok: false; reason: string };
type PlaneConfig = { url: string; apiKey: string };

const DOCUMENT_LIST_PAGE_SIZE = 100;
const DOCUMENT_LIST_MAX_PAGES = 100;

async function callPlane(
	config: PlaneConfig,
	fetchImpl: FetchLike,
	path: string,
	init: { method: string; body?: string; timeoutMs: number },
): Promise<{ ok: true; body: unknown } | { ok: false; reason: string }> {
	let response: Response;
	try {
		response = await fetchImpl(`${config.url.replace(/\/+$/, "")}${path}`, {
			method: init.method,
			headers: { authorization: `Bearer ${config.apiKey}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
			...(init.body !== undefined ? { body: init.body } : {}),
			signal: AbortSignal.timeout(init.timeoutMs),
		});
	} catch (cause) {
		return { ok: false, reason: `lightrag: ${cause instanceof Error ? cause.message : String(cause)}` };
	}
	if (!response.ok) return { ok: false, reason: `lightrag ${response.status}` };
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return { ok: false, reason: "lightrag: response was not JSON" };
	}
	if (body !== null && typeof body === "object" && "code" in body) {
		const code = (body as Record<string, unknown>).code;
		if (code !== 0) {
			const message = typeof (body as Record<string, unknown>).message === "string" ? (body as Record<string, unknown>).message : "request failed";
			return { ok: false, reason: `lightrag: ${message}` };
		}
	}
	return { ok: true, body };
}

function readString(entry: object, ...names: string[]): string | undefined {
	for (const name of names) {
		if (name in entry) {
			const value = (entry as Record<string, unknown>)[name];
			if (typeof value === "string") return value;
		}
	}
	return undefined;
}

function readNumber(entry: object, ...names: string[]): number | undefined {
	for (const name of names) {
		if (name in entry) {
			const value = (entry as Record<string, unknown>)[name];
			if (typeof value === "number" && Number.isFinite(value)) return value;
		}
	}
	return undefined;
}

function dataOf(body: unknown): unknown {
	return body !== null && typeof body === "object" && "data" in body ? (body as Record<string, unknown>).data : body;
}

function documentOf(entry: unknown): DocsDocument | null {
	if (entry === null || typeof entry !== "object") return null;
	const id = readString(entry, "id");
	const name = readString(entry, "name");
	if (id === undefined || name === undefined) return null;
	const meta: object = "meta_fields" in entry && entry.meta_fields !== null && typeof entry.meta_fields === "object" ? entry.meta_fields : {};
	return { id, name, meta_fields: { source_url: readString(meta, "source_url"), commit: readString(meta, "commit"), heading_path: readString(meta, "heading_path") } };
}

async function listDocuments(config: PlaneConfig, datasetId: string, fetchImpl: FetchLike, timeoutMs = 4000): Promise<DocumentListOutcome> {
	const documents: DocsDocument[] = [];
	for (let page = 1; page <= DOCUMENT_LIST_MAX_PAGES; page += 1) {
		const answered = await callPlane(config, fetchImpl, `/api/v1/datasets/${encodeURIComponent(datasetId)}/documents?page=${page}&page_size=${DOCUMENT_LIST_PAGE_SIZE}`, { method: "GET", timeoutMs });
		if (!answered.ok) return answered;
		const data = dataOf(answered.body);
		if (data === null || typeof data !== "object" || !("docs" in data) || !Array.isArray(data.docs)) {
			return { ok: false, reason: "lightrag: unexpected document list shape" };
		}
		for (const entry of data.docs) {
			const document = documentOf(entry);
			if (document !== null) documents.push(document);
		}
		const total = readNumber(data, "total", "total_datasets");
		const reached = total === undefined ? data.docs.length < DOCUMENT_LIST_PAGE_SIZE : documents.length >= total;
		if (reached || data.docs.length === 0) return { ok: true, documents };
	}
	return { ok: false, reason: "lightrag: document list exceeds the page cap" };
}

async function retrieveChunks(config: PlaneConfig, question: string, datasetIds: readonly string[], fetchImpl: FetchLike, timeoutMs = 4000): Promise<RetrievalOutcome> {
	if (datasetIds.length === 0) throw new Error("retrieveChunks needs explicit dataset_ids; unscoped retrieval is forbidden");
	const knobs = DEFAULT_RETRIEVAL_KNOBS;
	const answered = await callPlane(config, fetchImpl, "/api/v1/retrieval", {
		method: "POST",
		body: JSON.stringify({
			question,
			dataset_ids: [...datasetIds],
			page: 1,
			page_size: 30,
			similarity_threshold: knobs.similarityThreshold,
			vector_similarity_weight: knobs.vectorSimilarityWeight,
			top_k: knobs.topK,
			...(knobs.rerankId !== undefined ? { rerank_id: knobs.rerankId } : {}),
		}),
		timeoutMs,
	});
	if (!answered.ok) return answered;
	const data = dataOf(answered.body);
	if (data === null || typeof data !== "object" || !("chunks" in data) || !Array.isArray(data.chunks)) {
		return { ok: false, reason: "lightrag: unexpected response shape" };
	}
	const chunks: DocsChunk[] = [];
	for (const entry of data.chunks) {
		if (entry === null || typeof entry !== "object") continue;
		if (!("content" in entry) || typeof entry.content !== "string") continue;
		const documentId = readString(entry, "document_id");
		const chunkId = readString(entry, "id", "chunk_id");
		const headingPath = readString(entry, "heading_path");
		const sourceUrl = readString(entry, "source_url");
		const score = readNumber(entry, "similarity", "score");
		chunks.push({
			content: entry.content,
			document_name: readString(entry, "document_keyword", "document_name") ?? "doc",
			...(documentId !== undefined ? { document_id: documentId } : {}),
			...(chunkId !== undefined ? { chunk_id: chunkId } : {}),
			...(headingPath !== undefined ? { heading_path: headingPath } : {}),
			...(sourceUrl !== undefined ? { source_url: sourceUrl } : {}),
			...(score !== undefined ? { score } : {}),
		});
	}
	return { ok: true, chunks };
}

/** The production source: the plane's own client, with the archive's retrieval knobs. */
export function docsArchiveSource(config: PlaneConfig, fetchImpl: FetchLike): DocsArchiveSource {
	return {
		listDatasets: () => listDatasetsFromPlane(config, fetchImpl),
		listDocuments: (datasetId) => listDocuments(config, datasetId, fetchImpl),
		retrieve: (question, datasetIds) => retrieveChunks(config, question, datasetIds, fetchImpl),
	};
}

export const ARCHIVE_VERSION = 1;
export const MANIFEST_FILE = "manifest.json";
/** Directories are 0700 and files 0600: the archive names every document and commit the plane holds (T-46-01). */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
/** A dataset name or query id becomes a file name, so it must be a plain token. */

/** Where `docs-migrate` writes when `--archive` is omitted. */
export function lightragArchiveFromEnv(env: Record<string, string | undefined>): { dir: string | null; allowRootfs: boolean } {
	const raw = env.SUBSTRATE_LIGHTRAG_ARCHIVE_DIR?.trim() ?? "";
	const flag = (env.SUBSTRATE_LIGHTRAG_ARCHIVE_ALLOW_ROOTFS ?? "").trim().toLowerCase();
	return { dir: raw.length > 0 ? raw : null, allowRootfs: flag === "1" || flag === "true" || flag === "yes" };
}
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMIT = /^[0-9a-f]{7,40}$/;
/** The largest page read back from git; the ingest refuses pages over its own cap long before this. */
const MAX_PAGE_BYTES = 16 * 1024 * 1024;

/** Reads a repo file as it was at a commit, or null when the commit or the path is not there. */
export type ReadAtCommit = (commit: string, path: string) => Buffer | null;

export interface ArchiveQuery {
	id: string;
	question: string;
}

/** The lightrag reads the archive makes. Production wraps the plane's client; tests may script it. */
export interface DocsArchiveSource {
	listDatasets(): Promise<DatasetListOutcome>;
	listDocuments(datasetId: string): Promise<DocumentListOutcome>;
	retrieve(question: string, datasetIds: readonly string[]): Promise<RetrievalOutcome>;
}

export interface ArchiveDeps {
	source: DocsArchiveSource;
	/** `SUBSTRATE_DOCS_STATE_FILE`: the docs state file that is copied. The archive refuses without one. */
	stateFile: string | null;
	/** The frozen sample. Each query's lightrag citations are kept as its baseline. */
	queries: readonly ArchiveQuery[];
	/** The repo the pages are read from at their recorded commits, and where the git reads run. */
	repoRoot: string;
	/** Reads a page at its commit. Defaults to `git show`; tests may inject one. */
	readAtCommit?: ReadAtCommit;
	/** Overrides for `refusedMount`: the device reader and the release root it compares against. */
	dev?: DevReader;
	releaseRoot?: string;
	/** `SUBSTRATE_DOCS_ARCHIVE_ALLOW_ROOTFS`: waives only the dedicated-mount gate. */
	allowRootfs?: boolean;
}

export type ArchiveResult =
	| { ok: true; manifest_sha256: string; files: number; bytes: number; page_mismatches: number }
	| { ok: false; reason: string };

/** One document's check against its committed object. `match` is false whenever either side is unknown. */
export interface ArchivedPageCheck {
	dataset: string;
	document_id: string;
	source_url: string | null;
	path: string;
	commit: string | null;
	recorded_sha256: string | null;
	git_sha256: string | null;
	match: boolean;
}

export interface ArchiveMismatch {
	path: string;
	reason: string;
}

export interface ArchiveVerdict {
	ok: boolean;
	mismatches: ArchiveMismatch[];
}

const ManifestSchema = z.object({
	version: z.literal(ARCHIVE_VERSION),
	files: z.array(z.object({ path: z.string().min(1), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) })),
});
type Manifest = z.infer<typeof ManifestSchema>;
type ManifestEntry = Manifest["files"][number];

interface ArchiveFile {
	path: string;
	data: Buffer;
}

type Gathered = { ok: true; files: ArchiveFile[]; pageMismatches: number } | { ok: false; reason: string };

const refused = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
const json = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
const scrub = (value: string | null): string | null => (value === null ? null : redact(value));

function sha256Hex(data: Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

function safeRepoPath(path: string): boolean {
	return path.length > 0 && !path.startsWith("/") && !path.startsWith("-") && !path.split("/").includes("..");
}

function safeArchivePath(path: string): boolean {
	return path.length > 0 && path !== MANIFEST_FILE && !path.startsWith("/") && !path.split("/").includes("..");
}

/**
 * `git show <commit>:<path>` in `repoRoot`. The arguments go to git as an array, never through a shell, and a value
 * that is not a commit hash or a repo-relative path is never passed to git at all.
 */
export function gitAtCommit(repoRoot: string): ReadAtCommit {
	return (commit, path) => {
		if (!COMMIT.test(commit) || !safeRepoPath(path)) return null;
		try {
			return execFileSync("git", ["show", `${commit}:${path}`], { cwd: repoRoot, maxBuffer: MAX_PAGE_BYTES, stdio: ["ignore", "pipe", "ignore"] });
		} catch {
			return null;
		}
	};
}


/**
 * Write the archive of the lightrag plane into `dir`. Nothing is written until every lightrag read and every baseline
 * query has succeeded, so a failed read leaves no partial archive. The directory is refused when it is unset, not
 * empty, or on the root filesystem (unless `allowRootfs`). The manifest is written last.
 */
export async function archiveDocs(deps: ArchiveDeps, dir: string | null): Promise<ArchiveResult> {
	if (dir === null) return refused("SUBSTRATE_LIGHTRAG_ARCHIVE_DIR is unset: the archive refuses by name and writes nothing");
	const stateFile = deps.stateFile;
	if (stateFile === null) return refused("SUBSTRATE_DOCS_STATE_FILE is unset: there is no docs state to archive");
	const refusal = preflight(deps, dir, stateFile);
	if (refusal !== null) return refused(refusal);
	const gathered = await gather(deps, stateFile);
	if (!gathered.ok) return refused(gathered.reason);
	const written = writeArchive(dir, gathered.files);
	return { ok: true, manifest_sha256: written.manifestSha256, files: written.files, bytes: written.bytes, page_mismatches: gathered.pageMismatches };
}

function preflight(deps: ArchiveDeps, dir: string, stateFile: string): string | null {
	if (!existsSync(stateFile)) return "the docs state file does not exist";
	if (deps.queries.length === 0) return "no baseline queries were given";
	const ids = deps.queries.map((query) => query.id);
	if (ids.some((id) => !SAFE_NAME.test(id))) return "a baseline query id is not usable as a file name";
	if (new Set(ids).size !== ids.length) return "baseline query ids are not unique";
	if (existsSync(dir)) {
		if (!statSync(dir).isDirectory()) return `refusing ${dir}: it exists and is not a directory`;
		if (readdirSync(dir).length > 0) return `refusing ${dir}: the target directory is not empty`;
	}
	return refusedMount(dir, {
		cwd: deps.repoRoot,
		dev: deps.dev,
		allowRootfs: deps.allowRootfs,
		...(deps.releaseRoot === undefined ? {} : { releaseRoot: deps.releaseRoot }),
	});
}

async function gather(deps: ArchiveDeps, stateFile: string): Promise<Gathered> {
	const listed = await deps.source.listDatasets();
	if (!listed.ok) return refused(listed.reason);
	const datasets = listed.datasets;
	if (datasets.length === 0) return refused("lightrag lists no datasets to archive");
	const names = datasets.map((dataset) => dataset.name);
	if (names.some((name) => !SAFE_NAME.test(name))) return refused("a lightrag dataset name is not usable as a file name");
	if (new Set(names).size !== names.length) return refused("lightrag lists two datasets under one name");

	const listings: Array<{ dataset: DocsDataset; documents: DocsDocument[] }> = [];
	for (const dataset of datasets) {
		const documents = await deps.source.listDocuments(dataset.id);
		if (!documents.ok) return refused(documents.reason);
		listings.push({ dataset, documents: documents.documents });
	}

	const loaded = await loadIngestRecords(stateFile, names);
	if (loaded.problem !== undefined) return refused(loaded.problem);

	const files: ArchiveFile[] = [
		{ path: "inventory/_datasets.json", data: json({ datasets: datasets.map((dataset) => ({ id: dataset.id, name: redact(dataset.name) })) }) },
		...listings.map(({ dataset, documents }) => ({
			path: `inventory/${dataset.name}.json`,
			data: json({ dataset: { id: dataset.id, name: redact(dataset.name) }, documents: documents.map(documentEntry) }),
		})),
		{ path: "state/docs-ingest.json", data: readFileSync(stateFile) },
	];

	const datasetIds = datasets.map((dataset) => dataset.id);
	for (const query of deps.queries) {
		const answered = await deps.source.retrieve(query.question, datasetIds);
		if (!answered.ok) return refused(`baseline ${query.id}: ${answered.reason}`);
		files.push({ path: `baseline/${query.id}.json`, data: json({ id: query.id, citations: answered.chunks.map(citationEntry) }) });
	}

	const readAt = deps.readAtCommit ?? gitAtCommit(deps.repoRoot);
	const checks = listings.flatMap(({ dataset, documents }) => documents.map((document) => pageCheck(dataset, document, loaded.records, readAt)));
	files.push({ path: "pages.json", data: json({ checks }) });
	return { ok: true, files, pageMismatches: checks.filter((check) => !check.match).length };
}

function documentEntry(document: DocsDocument) {
	return {
		id: document.id,
		name: redact(document.name),
		source_url: scrub(document.meta_fields.source_url ?? null),
		commit: scrub(document.meta_fields.commit ?? null),
		heading_path: scrub(document.meta_fields.heading_path ?? null),
	};
}

function citationEntry(chunk: DocsChunk) {
	return {
		document_id: chunk.document_id ?? null,
		chunk_id: chunk.chunk_id ?? null,
		document_name: redact(chunk.document_name),
		source_url: scrub(chunk.source_url ?? null),
		heading_path: scrub(chunk.heading_path ?? null),
		score: chunk.score ?? null,
	};
}

/**
 * Check one document against the object it was ingested from. lightrag names a document by its repo path with `/`
 * written as `__` (`documentName`), so the path is that name reversed. The page is hashed with the ingest's own
 * `changeSha` over the sanitised body, and matched against the state record for its dataset and source URL.
 */
function pageCheck(dataset: DocsDataset, document: DocsDocument, records: ReadonlyMap<string, IngestRecord>, readAt: ReadAtCommit): ArchivedPageCheck {
	const sourceUrl = document.meta_fields.source_url ?? null;
	const commit = document.meta_fields.commit ?? null;
	const path = document.name.replace(/__/g, "/");
	const recorded = [...records.values()].find((record) => record.dataset_id === dataset.id && record.source_url === sourceUrl);
	const bytes = commit === null ? null : readAt(commit, path);
	const gitSha = bytes === null ? null : changeSha(stripRemoteImages(bytes.toString("utf8")).body, undefined);
	return {
		dataset: redact(dataset.name),
		document_id: document.id,
		source_url: scrub(sourceUrl),
		path: redact(path),
		commit,
		recorded_sha256: recorded?.sha ?? null,
		git_sha256: gitSha,
		match: recorded !== undefined && gitSha !== null && gitSha === recorded.sha,
	};
}

function writeArchive(dir: string, files: readonly ArchiveFile[]): { manifestSha256: string; files: number; bytes: number } {
	mkdirSync(dir, { recursive: true, mode: DIR_MODE });
	chmodSync(dir, DIR_MODE);
	const entries: ManifestEntry[] = [];
	for (const file of [...files].sort((left, right) => (left.path < right.path ? -1 : 1))) {
		const target = join(dir, file.path);
		mkdirSync(dirname(target), { recursive: true, mode: DIR_MODE });
		writeFileSync(target, file.data, { mode: FILE_MODE });
		chmodSync(target, FILE_MODE);
		entries.push({ path: file.path, bytes: file.data.length, sha256: sha256Hex(file.data) });
	}
	const manifest = json({ version: ARCHIVE_VERSION, files: entries });
	writeFileSync(join(dir, MANIFEST_FILE), manifest, { mode: FILE_MODE });
	chmodSync(join(dir, MANIFEST_FILE), FILE_MODE);
	return { manifestSha256: sha256Hex(manifest), files: entries.length, bytes: entries.reduce((total, entry) => total + entry.bytes, 0) };
}

/**
 * Re-read an archive and check it against its manifest. Every listed file must exist as a regular file with the
 * recorded length and sha256, every listed path must stay inside the directory, and no file may sit there unlisted.
 * A missing or malformed manifest fails the whole archive.
 */
export function verifyArchive(dir: string): ArchiveVerdict {
	const manifest = readManifest(dir);
	if (typeof manifest === "string") return { ok: false, mismatches: [{ path: MANIFEST_FILE, reason: manifest }] };
	const mismatches: ArchiveMismatch[] = [];
	for (const entry of manifest.files) {
		const mismatch = checkEntry(dir, entry);
		if (mismatch !== null) mismatches.push(mismatch);
	}
	const listed = new Set(manifest.files.map((entry) => entry.path));
	for (const path of walk(dir, "")) {
		if (path !== MANIFEST_FILE && !listed.has(path)) mismatches.push({ path, reason: "unlisted: the manifest does not name this file" });
	}
	return { ok: mismatches.length === 0, mismatches };
}

function readManifest(dir: string): Manifest | string {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8"));
	} catch {
		return "manifest missing or unreadable";
	}
	const parsed = ManifestSchema.safeParse(raw);
	return parsed.success ? parsed.data : "manifest malformed";
}

function checkEntry(dir: string, entry: ManifestEntry): ArchiveMismatch | null {
	if (!safeArchivePath(entry.path)) return { path: entry.path, reason: "unsafe path: it leaves the archive directory" };
	const target = join(dir, entry.path);
	let data: Buffer;
	try {
		if (!lstatSync(target).isFile()) return { path: entry.path, reason: "not a regular file" };
		data = readFileSync(target);
	} catch {
		return { path: entry.path, reason: "missing or unreadable" };
	}
	if (data.length !== entry.bytes) return { path: entry.path, reason: `length ${data.length} differs from the manifest's ${entry.bytes}` };
	if (sha256Hex(data) !== entry.sha256) return { path: entry.path, reason: "sha256 differs from the manifest" };
	return null;
}

/** Every file under `dir` as a relative path with `/` separators. A symlink or other non-directory counts as a file. */
function walk(dir: string, prefix: string): string[] {
	const found: string[] = [];
	for (const item of readdirSync(join(dir, prefix), { withFileTypes: true })) {
		const path = prefix === "" ? item.name : `${prefix}/${item.name}`;
		if (item.isDirectory()) found.push(...walk(dir, path));
		else found.push(path);
	}
	return found;
}
