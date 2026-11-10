/**
 * The RAGFlow dataset archive (phase 46, SC2): what the RAGFlow plane held,
 * written somewhere off-box and checksummed, so the RAGFlow code and storage
 * can only be removed after a read-back proves the archive intact.
 *
 * `archiveRagflow` writes, under an operator-named directory:
 *
 *   1. `inventory/<dataset>.json` — the dataset list and, per dataset, its
 *      document list (`GET /api/v1/datasets/{id}/documents`, planes/ragflow.ts
 *      `listDocuments`) with the ingest metadata each document echoes
 *      (`source_url`, `commit`, `heading_path`) and the page hash read back
 *      from git at the recorded commit;
 *   2. `state/docs-ingest.json` — a verbatim copy of the substrate's docs
 *      state file (`SUBSTRATE_DOCS_STATE_FILE`; hashes, ids and pins only,
 *      never secrets);
 *   3. `baseline/<query-id>.json` — for each of the 20 frozen parity queries
 *      (`fixtures/parity/parity-queries.json`), the RAGFlow citations that
 *      answer it, best first — Part B's side of `docs-parity.ts`;
 *   4. `manifest.json` — every written file's relative path, byte length and
 *      sha256, written last.
 *
 * `verifyArchive` re-reads every file the manifest lists, recomputes sha256
 * and byte length, refuses any file on disk the manifest does not list, and
 * returns `{ok, mismatches}`. The migration job (`scripts/docs-migrate.ts`)
 * refuses to run unless it passed.
 *
 * Refusals run before any write: a non-empty target is refused (an archive
 * is a fresh directory, never a merge into one), and a target that lives on
 * the root filesystem is refused unless
 * `SUBSTRATE_RAGFLOW_ARCHIVE_ALLOW_ROOTFS` is truthy — the same gate the
 * index archive applies (`index-archive.ts`, `SUBSTRATE_INDEX_ARCHIVE_ALLOW_ROOTFS`):
 * an off-box archive lives on a dedicated mount.
 *
 * Page bytes are read from git at each page's recorded commit
 * (`git show <commit>:<path>`), not from the plane, and digested with the
 * ingest's own hash — the same sha256-over-UTF-8 construction
 * `docs-ingest.ts` records in `content_sha256` — then compared against the
 * state file's recorded hash. A page whose git bytes hash differently is
 * reported (`page_hash_mismatches`), never silently accepted: the archived
 * inventory must describe exactly what was ingested.
 *
 * Secrets: nothing here reads or writes a credential. The manifest holds
 * paths, byte counts and digests; the inventory holds ids, parse states and
 * the metadata the plane already echoes. Keys and endpoints never enter it.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
	listDatasets,
	listDocuments,
	retrieveChunks,
	type FetchLike,
	type RagflowConfig,
} from "./planes/ragflow.ts";
import type { DatasetListSource } from "./docs-datasets.ts";
import { loadIngestRecords, type IngestRecord } from "./docs-ingest.ts";
import { DEFAULT_SEARCH_DATASET_NAMES } from "./docs-search.ts";

/** The manifest file an archive writes last and a verify reads first. */
export const ARCHIVE_MANIFEST_NAME = "manifest.json";

/** The archive kind recorded in the manifest. */
export const ARCHIVE_KIND = "ragflow-archive";

/** Where the operator points the archive; unset means the archive refuses by name, never a guess. */
export const RAGFLOW_ARCHIVE_DIR_ENV = "SUBSTRATE_RAGFLOW_ARCHIVE_DIR";

/** Truthy value waives the dedicated-mount gate for a deliberate local test (mirrors `SUBSTRATE_INDEX_ARCHIVE_ALLOW_ROOTFS`). */
export const RAGFLOW_ARCHIVE_ALLOW_ROOTFS_ENV = "SUBSTRATE_RAGFLOW_ARCHIVE_ALLOW_ROOTFS";

/** One frozen parity query, exactly the fixture's shape. */
export interface ArchiveQuery {
	id: string;
	question: string;
}

/** `SUBSTRATE_RAGFLOW_ARCHIVE_DIR` as resolved from an environment, or null. */
export function archiveDirFromEnv(env: Record<string, string | undefined>): string | null {
	const value = env[RAGFLOW_ARCHIVE_DIR_ENV]?.trim();
	return value ? value : null;
}

/** Truthiness the way the toggles read it: `1 | true | yes`, case-insensitive; anything else is off. */
export function allowRootfsFromEnv(env: Record<string, string | undefined>): boolean {
	const value = env[RAGFLOW_ARCHIVE_ALLOW_ROOTFS_ENV]?.trim().toLowerCase();
	return value === "1" || value === "true" || value === "yes";
}

/** A refused archive: thrown before any write, naming the gate that refused. */
export class ArchiveRefused extends Error {}

/** One page of the plane as the archive records it. */
export interface ArchivedDocument {
	id: string;
	/** The name on the plane: the page's repo path with `/` flattened to `__`. */
	name: string;
	/** The repo path recovered from the plane name (`__` unflattened); null when it cannot be. */
	path: string | null;
	run: string;
	source_url: string | null;
	commit: string | null;
	heading_path: string | null;
	/** The git bytes' digest at the recorded commit, hashed with the ingest's own hash; null when unread. */
	content_sha256: string | null;
	/** `null` when there was nothing to compare; otherwise whether the git hash matches the recorded ingest hash. */
	content_hash_ok: boolean | null;
}

export interface ArchivedDataset {
	id: string;
	name: string;
	documents: ArchivedDocument[];
}

/** One frozen query's RAGFlow answer, as the baseline file holds it. */
export interface ArchivedBaseline {
	id: string;
	question: string;
	/** `false` when the retrieval failed; its citations are then absent and the gate reads a miss. */
	ok: boolean;
	reason?: string;
	/** Up to five cited sources, best first: `source_urls[0]` is the top-1 the gate matches. */
	citations: Array<{ source_url: string | null; document_name: string; score: number | null }>;
}

export interface ArchiveManifestFile {
	/** Path relative to the archive root, `/`-separated. */
	path: string;
	bytes: number;
	sha256: string;
}

export interface ArchiveManifest {
	version: 1;
	kind: typeof ARCHIVE_KIND;
	createdAt: string;
	/** The frozen sample's digest, so a later reader can tell a different sample. */
	sample_sha256: string;
	files: ArchiveManifestFile[];
}

export interface RagflowArchiveDeps {
	/** The RAGFlow reach; the archive reads, never writes. */
	config: RagflowConfig;
	/** Fetch the plane calls go out on; the real fetch when omitted (tests inject the fake). */
	fetchImpl?: FetchLike;
	/** The dataset list reader; the plane directly when omitted. */
	datasets?: DatasetListSource;
	/** The docs state file's path (`SUBSTRATE_DOCS_STATE_FILE`); null archives an explicit absence marker. */
	stateFile?: string | null;
	/** The frozen parity sample; every entry becomes `baseline/<id>.json`. */
	sample: readonly ArchiveQuery[];
	/** Which dataset names the baseline spans; the docs-search defaults when omitted. */
	datasetNames?: readonly string[];
	/** Read one page's bytes at its commit; the real `git show` when omitted. */
	gitShow?: (commit: string, path: string) => Promise<string>;
	/** The repo root `gitShow` runs in; the process cwd when omitted. */
	cwd?: string;
	/** The digest for manifest entries and page hashes; the ingest's own sha256 construction when omitted. */
	sha256?: (text: string) => string;
	/** `SUBSTRATE_RAGFLOW_ARCHIVE_ALLOW_ROOTFS` resolved; false keeps the dedicated-mount gate. */
	allowRootfs?: boolean;
	/** The st_dev reader the mount gate compares with; the real `stat` walking to the nearest existing ancestor when omitted. */
	devOf?: (path: string) => number | null;
	/** Injected time for the manifest's `createdAt`. */
	now?: () => number;
}

export interface ArchiveOutcome {
	dir: string;
	datasets: number;
	documents: number;
	baselines: number;
	files: number;
	bytes: number;
	/** The manifest's own digest, as Task 4 records it. */
	manifest_sha256: string;
	/** Pages whose git bytes could not be read or did not match the recorded ingest hash. */
	page_hash_mismatches: Array<{ dataset: string; name: string; reason: string }>;
}

/** The digest the ingest records (`docs-ingest.ts sha256`): sha256 over the UTF-8 bytes. */
export function ingestSha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The inverse of `documentName` (planes/ragflow.ts): `docs__a.md` reads back as `docs/a.md`. */
export function pathFromDocumentName(name: string): string {
	return name.replace(/__/g, "/");
}

/** The default page-bytes reader: `git show <commit>:<path>` in the repo root. */
export async function gitShowPage(cwd: string, commit: string, path: string): Promise<string> {
	const run = promisify(execFile);
	const { stdout } = await run("git", ["show", `${commit}:${path}`], { cwd, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" });
	return stdout;
}

/** The nearest existing ancestor's filesystem id, for the dedicated-mount gate. */
function statDev(path: string): number | null {
	let current = path;
	for (;;) {
		try {
			return statSync(current).dev;
		} catch {
			const parent = resolve(current, "..");
			if (parent === current) return null;
			current = parent;
		}
	}
}

/** Inventory and baseline file names are dataset ids and query ids; everything outside a safe set is folded to `-`. */
function safeFileName(name: string): string {
	const folded = name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
	return folded.length > 0 ? folded : "unnamed";
}

/** A relative archive path, refused when it escapes the archive root. */
function containedPath(dir: string, relativePath: string): string {
	const full = resolve(dir, relativePath);
	const rel = relative(dir, full);
	if (rel.startsWith("..") || resolve(rel) === rel) throw new ArchiveRefused(`archive path escapes the archive root: ${relativePath}`);
	return full;
}

interface PendingFile {
	path: string;
	bytes: Buffer;
}

function fileEntry(deps: { sha256: (text: string) => string }, file: PendingFile): ArchiveManifestFile {
	return {
		path: file.path,
		bytes: file.bytes.byteLength,
		sha256: deps.sha256(file.bytes.toString("utf8")),
	};
}

/**
 * Archive the RAGFlow plane. Read-only against the plane: dataset list,
 * document list, one retrieval per frozen query. Every refusal happens
 * before the first byte is written.
 */
export async function archiveRagflow(deps: RagflowArchiveDeps, dir: string): Promise<ArchiveOutcome> {
	const hash = deps.sha256 ?? ingestSha256;
	const hashDep = { sha256: hash };
	const target = resolve(dir);
	// ── Refusals, before any write ──────────────────────────────────────
	const devOf = deps.devOf ?? statDev;
	if (deps.allowRootfs !== true) {
		const targetDev = devOf(target);
		const rootDev = devOf("/");
		if (targetDev !== null && rootDev !== null && targetDev === rootDev) {
			throw new ArchiveRefused(
				`refusing to archive onto the root filesystem; set ${RAGFLOW_ARCHIVE_ALLOW_ROOTFS_ENV}=1 only for a deliberate local test`,
			);
		}
	}
	if (existsSync(target)) {
		const present = readdirSync(target);
		if (present.length > 0) throw new ArchiveRefused(`refusing to archive into a non-empty directory: ${present.length} entr(y|ies) present`);
	}
	if (deps.sample.length === 0) throw new ArchiveRefused("refusing to archive without the frozen parity sample");
	for (const query of deps.sample) {
		if (typeof query?.id !== "string" || query.id.length === 0 || typeof query?.question !== "string" || query.question.length === 0) {
			throw new ArchiveRefused("the frozen parity sample has an entry without an id or a question");
		}
	}
	// ── Read the plane ──────────────────────────────────────────────────
	const fetchImpl = deps.fetchImpl ?? fetch;
	const listed = deps.datasets !== undefined ? await deps.datasets.list(deps.config, fetchImpl) : await listDatasets(deps.config, fetchImpl);
	if (!listed.ok) throw new ArchiveRefused(`dataset list failed: ${listed.reason}`);
	if (listed.datasets.length === 0) throw new ArchiveRefused("the plane lists no datasets to archive");
	// The state file's records carry the hash each ingest recorded; the page
	// bytes from git are checked against them below.
	let records = new Map<string, IngestRecord>();
	let stateBytes: Buffer;
	if (deps.stateFile != null && deps.stateFile.length > 0) {
		try {
			stateBytes = readFileSync(deps.stateFile);
			records = (await loadIngestRecords(deps.stateFile)).records;
		} catch (cause) {
			const reason = cause instanceof Error ? cause.message.slice(0, 200) : String(cause);
			stateBytes = Buffer.from(
				JSON.stringify({ version: 0, note: `SUBSTRATE_DOCS_STATE_FILE unreadable at archive time: ${reason}` }),
				"utf8",
			);
		}
	} else {
		stateBytes = Buffer.from(
			JSON.stringify({ version: 0, note: "SUBSTRATE_DOCS_STATE_FILE unset; ingest records were process-local and are not archived" }),
			"utf8",
		);
	}
	const wantedNames = deps.datasetNames ?? DEFAULT_SEARCH_DATASET_NAMES;
	const readableIds = listed.datasets.filter((dataset) => wantedNames.includes(dataset.name)).map((dataset) => dataset.id);
	const baselineIds = readableIds.length > 0 ? readableIds : listed.datasets.map((dataset) => dataset.id);
	const pageHashMismatches: ArchiveOutcome["page_hash_mismatches"] = [];
	const gitShow = deps.gitShow ?? ((commit: string, path: string) => gitShowPage(deps.cwd ?? process.cwd(), commit, path));
	const archivedDatasets: ArchivedDataset[] = [];
	for (const dataset of listed.datasets) {
		const documents = await listDocuments(deps.config, dataset.id, fetchImpl);
		if (!documents.ok) throw new ArchiveRefused(`document list failed for ${dataset.name}: ${documents.reason}`);
		const archived: ArchivedDocument[] = [];
		for (const document of documents.documents) {
			const sourceUrl = document.meta_fields.source_url ?? null;
			const commit = document.meta_fields.commit ?? null;
			const path = pathFromDocumentName(document.name);
			const recorded = sourceUrl !== null ? records.get(`${dataset.id}::${sourceUrl}`) : undefined;
			let contentSha256: string | null = null;
			let contentHashOk: boolean | null = null;
			if (commit !== null && path.length > 0 && !path.includes("\u0000")) {
				try {
					const bytes = await gitShow(commit, path);
					contentSha256 = hash(bytes);
					if (recorded !== undefined) {
						contentHashOk = contentSha256 === recorded.sha;
						if (!contentHashOk) {
							pageHashMismatches.push({ dataset: dataset.name, name: document.name, reason: "content hash differs from the recorded ingest hash" });
						}
					}
				} catch (cause) {
					const reason = cause instanceof Error ? cause.message.slice(0, 200) : String(cause);
					pageHashMismatches.push({ dataset: dataset.name, name: document.name, reason: `git show failed: ${reason}` });
					// Nothing was compared, so nothing is claimed: an unreadable page is reported, not judged.
					contentHashOk = null;
				}
			}
			archived.push({
				id: document.id,
				name: document.name,
				path: path.length > 0 ? path : null,
				run: document.run,
				source_url: sourceUrl,
				commit,
				heading_path: document.meta_fields.heading_path ?? null,
				content_sha256: contentSha256,
				content_hash_ok: contentHashOk,
			});
		}
		archivedDatasets.push({ id: dataset.id, name: dataset.name, documents: archived });
	}
	const baselines: ArchivedBaseline[] = [];
	for (const query of deps.sample) {
		const answered = await retrieveChunks(deps.config, { question: query.question, dataset_ids: baselineIds, page_size: 5 }, fetchImpl);
		if (!answered.ok) {
			baselines.push({ id: query.id, question: query.question, ok: false, reason: answered.reason, citations: [] });
			continue;
		}
		baselines.push({
			id: query.id,
			question: query.question,
			ok: true,
			citations: answered.chunks.slice(0, 5).map((chunk) => ({
				source_url: chunk.source_url ?? null,
				document_name: chunk.document_name,
				score: typeof chunk.score === "number" ? chunk.score : null,
			})),
		});
	}
	// ── Write ───────────────────────────────────────────────────────────
	mkdirSync(target, { recursive: true, mode: 0o700 });
	try {
		chmodSync(target, 0o700);
	} catch {
		// A filesystem that refuses the mode change still holds the archive; the manifest checksums are the contract.
	}
	const pending: PendingFile[] = [];
	for (const dataset of archivedDatasets) {
		pending.push({
			path: join("inventory", `${safeFileName(dataset.name)}.json`),
			bytes: Buffer.from(JSON.stringify(dataset), "utf8"),
		});
	}
	pending.push({ path: join("state", "docs-ingest.json"), bytes: stateBytes });
	for (const baseline of baselines) {
		pending.push({ path: join("baseline", `${safeFileName(baseline.id)}.json`), bytes: Buffer.from(JSON.stringify(baseline), "utf8") });
	}
	let bytes = 0;
	const entries: ArchiveManifestFile[] = [];
	for (const file of pending) {
		const full = containedPath(target, file.path);
		mkdirSync(resolve(full, ".."), { recursive: true, mode: 0o700 });
		writeFileSync(full, file.bytes, { mode: 0o600 });
		const entry = fileEntry(hashDep, file);
		entries.push(entry);
		bytes += entry.bytes;
	}
	const manifest: ArchiveManifest = {
		version: 1,
		kind: ARCHIVE_KIND,
		createdAt: new Date((deps.now ?? Date.now)()).toISOString(),
		sample_sha256: hash(JSON.stringify(deps.sample)),
		files: entries,
	};
	const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, "\t")}\n`, "utf8");
	writeFileSync(containedPath(target, ARCHIVE_MANIFEST_NAME), manifestBytes, { mode: 0o600 });
	const documents = archivedDatasets.reduce((total, dataset) => total + dataset.documents.length, 0);
	return {
		dir: target,
		datasets: archivedDatasets.length,
		documents,
		baselines: baselines.length,
		files: entries.length + 1,
		bytes: bytes + manifestBytes.byteLength,
		manifest_sha256: hash(manifestBytes.toString("utf8")),
		page_hash_mismatches: pageHashMismatches,
	};
}

export interface ArchiveVerifyMismatch {
	file: string;
	why: string;
}

export interface ArchiveVerifyResult {
	ok: boolean;
	mismatches: ArchiveVerifyMismatch[];
}

/** Every regular file under `dir`, as paths relative to it, `/`-separated; the manifest excluded. */
function diskFiles(dir: string): string[] {
	const found: string[] = [];
	const walk = (current: string): void => {
		let entries: string[];
		try {
			entries = readdirSync(current);
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(current, entry);
			let info;
			try {
				info = statSync(full);
			} catch {
				continue;
			}
			if (info.isDirectory()) walk(full);
			else if (info.isFile()) found.push(relative(dir, full).split("\\").join("/"));
		}
	};
	walk(dir);
	return found.filter((path) => path !== ARCHIVE_MANIFEST_NAME);
}

/**
 * Re-read an archive against its manifest: every listed file's sha256 and
 * byte length recomputed, any file the manifest does not list refused, any
 * manifest path that escapes the archive root refused. Never throws for a
 * damaged archive — the mismatches are the answer.
 */
export async function verifyArchive(dir: string): Promise<ArchiveVerifyResult> {
	const root = resolve(dir);
	const mismatches: ArchiveVerifyMismatch[] = [];
	let manifestText: string;
	try {
		manifestText = readFileSync(join(root, ARCHIVE_MANIFEST_NAME), "utf8");
	} catch {
		return { ok: false, mismatches: [{ file: ARCHIVE_MANIFEST_NAME, why: "missing" }] };
	}
	let manifest: ArchiveManifest;
	try {
		manifest = JSON.parse(manifestText) as ArchiveManifest;
	} catch {
		return { ok: false, mismatches: [{ file: ARCHIVE_MANIFEST_NAME, why: "not valid JSON" }] };
	}
	if (manifest === null || typeof manifest !== "object" || manifest.kind !== ARCHIVE_KIND || !Array.isArray(manifest.files)) {
		return { ok: false, mismatches: [{ file: ARCHIVE_MANIFEST_NAME, why: `not a ${ARCHIVE_KIND} manifest` }] };
	}
	const listed = new Set<string>();
	for (const entry of manifest.files) {
		if (entry === null || typeof entry !== "object" || typeof entry.path !== "string") {
			mismatches.push({ file: ARCHIVE_MANIFEST_NAME, why: "an entry without a path" });
			continue;
		}
		let full: string;
		try {
			full = containedPath(root, entry.path);
		} catch (cause) {
			mismatches.push({ file: entry.path, why: cause instanceof Error ? cause.message : "escapes the archive root" });
			continue;
		}
		listed.add(entry.path);
		let bytes: Buffer;
		try {
			bytes = readFileSync(full);
		} catch {
			mismatches.push({ file: entry.path, why: "missing" });
			continue;
		}
		if (entry.bytes !== undefined && bytes.byteLength !== entry.bytes) {
			mismatches.push({ file: entry.path, why: `byte length differs: manifest ${String(entry.bytes)}, disk ${String(bytes.byteLength)}` });
		}
		if (typeof entry.sha256 === "string" && ingestSha256(bytes.toString("utf8")) !== entry.sha256) {
			mismatches.push({ file: entry.path, why: "sha256 differs" });
		}
	}
	for (const path of diskFiles(root)) {
		if (!listed.has(path)) mismatches.push({ file: path, why: "not listed in the manifest" });
	}
	return { ok: mismatches.length === 0, mismatches };
}
