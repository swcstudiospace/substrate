/**
 * DOCS-02: fail-closed docs ingest over RAGFlow (D25-05).
 *
 * Every page is stripped of remote images, scanned by the Phase 18 redactor
 * BEFORE upload and refused — never cleaned-and-published — on any finding.
 * The scan covers the body AND the outgoing metadata (`source_url`,
 * `commit`, `heading_path`): a clean body cannot publish a secret through a
 * heading. Six refusals fail closed with locator-only warning events: a
 * redactor finding, a page with no source URL, a path outside the
 * configured roots, a page or call over the size caps, an unauthenticated
 * caller, a VM guest. Both the posted `path` and the client-resolved
 * `real_path` (when present) must sit under the roots after dot-segment
 * normalization, so `docs/../private.md` and symlink escapes are refused.
 *
 * Uploads are idempotent by content hash, keyed by dataset plus source URL,
 * with per-page in-flight locks so concurrent retries share one upload.
 * Every upload carries `{source_url, commit, heading_path}` metadata (U-03).
 * Each record carries a `version` (1 on first ingest, +1 per replacement). A page may name the
 * `expected_version` it replaces; a mismatch refuses the call as `version.stale` (memory's
 * contract, answered 409). A mismatch found before the first upload writes nothing; one a concurrent ingest causes mid-call refuses the remaining pages, and `changed` reports what already landed. Absent, the page ingests as before.
 * A replacement reports the superseded document id; with
 * `SUBSTRATE_DOCS_PRUNE_SUPERSEDED=1` (uplift-2 R6) the superseded document
 * is deleted through the documented delete call once the replacement has
 * parsed, and the result says so (`pruned_document_id`) — or records why
 * the prune failed (`prune: "failed: …"`), non-fatally. Off, the corpus
 * keeps every superseded document, exactly as before.
 *
 * The state file (`SUBSTRATE_DOCS_STATE_FILE`) is at version 2: the ingest
 * records plus the per-dataset version lists, so pins and the
 * merge-trigger's idempotency survive a restart. A version-1 file (records
 * only) loads as before and is rewritten at version 2 on the next save.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	createVersionStore,
	DATASET_VERSION_RETENTION,
	DIRECT_DATASET_LIST,
	versionsFromJson,
	versionsToJson,
	type DatasetListSource,
	type DatasetVersion,
	type VersionStore,
} from "./docs-datasets.ts";
import { createFreshnessState, freshnessStateFromJson, freshnessStateToJson, type FreshnessState, type LagMarker } from "./docs-freshness.ts";
import {
	deleteDocuments,
	documentName,
	parseDocuments,
	pollParseStatus,
	uploadDocument,
	type FetchLike,
	type RagflowConfig,
} from "./planes/ragflow.ts";
import { REDACTION_RULES, redact, redactSkillContent } from "./redact.ts";
import { SKILL_NAME_RE } from "./skills/propose.ts";
import type { EventInput, Surface } from "./types.ts";

/** One page may not exceed 1 MB (D25-05, Phase 21 precedent). */
export const INGEST_PAGE_MAX_BYTES = 1_000_000;
/** One ingest call may not exceed 5 MB total. */
export const INGEST_CALL_MAX_BYTES = 5_000_000;

/**
 * Where ingestable pages live, as path prefixes. Mirrors the
 * `agent-substrate` dataset sources in `docs/data-planes.md`
 * (`README.md`, `docs/`, `.planning/PROJECT.md`).
 */
export const DEFAULT_INGEST_ROOTS: readonly string[] = ["docs/", "README.md", ".planning/PROJECT.md"];

/**
 * The file-system calls the sweep makes, injectable so a test can prove the
 * scanner enforces the size cap before any read. Defaults to node's fs.
 */
export interface ScanIo {
	lstat: (path: string) => Promise<Stats>;
	stat: (path: string) => Promise<Stats>;
	readdir: (path: string, options: { withFileTypes: true }) => Promise<Dirent[]>;
	readFile: (path: string, options: "utf8" | { encoding: "utf8" }) => Promise<string>;
}

export const nodeIo: ScanIo = { lstat, stat, readdir, readFile };

/**
 * The pages the configured roots hold under `baseDir`, for a refresh that runs
 * on the machine holding the checkout (the `/docs/merge-trigger` route).
 *
 * Roots are repo-relative, exactly as `roots` describes them for posted pages:
 * a trailing `/` sweeps a directory tree, a bare name reads one file. Each
 * root is lstat-checked before it is followed, so a link used AS a root is
 * skipped exactly like links found INSIDE the sweep — a link can point outside
 * the checkout, and the guards below have no real path to check against the
 * roots. Each file is stat-checked before it is read, so a page over
 * {@link INGEST_PAGE_MAX_BYTES} is refused the read instead of being pulled
 * into memory only for the ingest to refuse it. An entry that cannot be
 * stat'ed, read or opened is skipped, never fatal: a root this checkout does
 * not have is not an outage of the docs plane. A sweep that finds nothing
 * comes back empty, and the guarded ingest refuses `no-pages` on it. Every
 * page carries a `file://` source URL derived from its resolved path, so the
 * content-hash idempotency keys stay stable across restarts of the server. The
 * result is sorted by path, so a refresh ingests in a stable order.
 */
export async function scanIngestPages(baseDir: string, roots: readonly string[], io: ScanIo = nodeIo): Promise<IngestPage[]> {
	return scanPages(baseDir, roots, io, "skip");
}

/**
 * The pages of an agent-skills checkout under `roots`: {@link scanIngestPages}, except that a path
 * which exists but cannot be listed, stat'ed or read fails the scan. A skill whose `references/` tree
 * is unreadable then fails its refresh, instead of ingesting fewer pages under a version that looks
 * fresh. A missing path is still just absent; the size and link rules are unchanged.
 */
export async function readSkillsCheckoutPages(baseDir: string, roots: readonly string[], io: ScanIo = nodeIo): Promise<IngestPage[]> {
	return scanPages(baseDir, roots, io, "fail");
}

async function scanPages(baseDir: string, roots: readonly string[], io: ScanIo, unreadable: Unreadable): Promise<IngestPage[]> {
	const pages: IngestPage[] = [];
	for (const root of roots) {
		const absolute = resolve(baseDir, root);
		const info = await tolerant(() => io.lstat(absolute), unreadable);
		if (info === undefined) continue; // absent or unreadable root: skipped, not fatal under "skip"
		if (info.isSymbolicLink()) continue; // a root that is itself a link is never followed
		if (root.endsWith("/")) await collectDirectory(absolute, root, pages, io, unreadable);
		else if (info.isFile()) await addFilePage(absolute, root, pages, io, unreadable);
	}
	pages.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return pages;
}

/**
 * The roots of an agent-skills checkout (phase 42, D42-2). A directory `<name>/` at the checkout root
 * is a skill only when its name passes `SKILL_NAME_RE` (the rule `libraryNames` applies) and it holds a
 * regular `SKILL.md`; its roots are that file and `<name>/references/` (a tree): the layout `writeTree`
 * writes and the library projector reads. A directory that fails either check contributes no roots, so
 * its notes never become searchable. Links are not skills. The listing throws when the checkout cannot be
 * read, and so does a `SKILL.md` check that fails for any reason but the file being absent; the caller
 * fails that refresh.
 */
export async function skillsCheckoutRoots(checkout: string, io: Pick<ScanIo, "readdir" | "lstat"> = nodeIo): Promise<string[]> {
	const entries = await io.readdir(checkout, { withFileTypes: true });
	const roots: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !SKILL_NAME_RE.test(entry.name)) continue;
		const manifest = await tolerant(() => io.lstat(join(checkout, entry.name, "SKILL.md")), "fail");
		if (manifest?.isFile() === true) roots.push(`${entry.name}/SKILL.md`, `${entry.name}/references/`);
	}
	return roots;
}

/** How a scan treats a path it cannot read: skip it (agent-substrate), or fail the scan (an agent-skills checkout). */
type Unreadable = "skip" | "fail";

/**
 * One filesystem read. A missing path yields undefined under either policy; any other failure yields
 * undefined under "skip" and rethrows under "fail".
 */
async function tolerant<T>(read: () => Promise<T>, unreadable: Unreadable): Promise<T | undefined> {
	try {
		return await read();
	} catch (cause) {
		const missing = cause instanceof Error && "code" in cause && cause.code === "ENOENT";
		if (unreadable === "fail" && !missing) throw cause;
		return undefined;
	}
}

async function collectDirectory(dir: string, prefix: string, pages: IngestPage[], io: ScanIo, unreadable: Unreadable): Promise<void> {
	const entries = await tolerant(() => io.readdir(dir, { withFileTypes: true }), unreadable);
	if (entries === undefined) return; // a missing directory is skipped; an unreadable one only under "skip"
	for (const entry of entries) {
		if (entry.isSymbolicLink()) continue;
		const relative = `${prefix}${entry.name}`;
		if (entry.isDirectory()) await collectDirectory(join(dir, entry.name), `${relative}/`, pages, io, unreadable);
		else if (entry.isFile()) await addFilePage(join(dir, entry.name), relative, pages, io, unreadable);
	}
}

async function addFilePage(absolute: string, path: string, pages: IngestPage[], io: ScanIo, unreadable: Unreadable): Promise<void> {
	// The size cap applies to the stat, before anything is read: a file the
	// ingest would refuse as page-too-large is never loaded just to be thrown
	// away. It is skipped like every other page the sweep cannot take —
	// quietly, and counted only by its absence from the result.
	const stats = await tolerant(() => io.stat(absolute), unreadable);
	if (stats === undefined || stats.size > INGEST_PAGE_MAX_BYTES) return;
	const body = await tolerant(() => io.readFile(absolute, "utf8"), unreadable);
	if (body === undefined) return;
	pages.push({ path, source_url: pathToFileURL(absolute).href, body });
}

export interface IngestPage {
	path: string;
	/** The client-resolved filesystem path, when the caller read one. Also gated. */
	real_path?: string;
	source_url?: string;
	body: string;
	heading_path?: string;
	/**
	 * The version of this source URL's record the caller believes it is replacing (memory's
	 * `expected_version` contract). Absent keeps today's behaviour; a mismatch refuses the call with
	 * `version.stale` before anything is uploaded.
	 */
	expected_version?: number;
}

export interface IngestInput {
	dataset: string;
	commit?: string;
	pages: IngestPage[];
	session_id?: string;
}

export interface IngestPageResult {
	path: string;
	source_url: string;
	status: "ingested" | "replaced" | "unchanged";
	document_id: string;
	content_sha256: string;
	/** The prior document this upload supersedes; deleted when the prune is on, else left for the operator. */
	superseded_document_id?: string;
	/** The superseded document the prune deleted (uplift-2 R6). */
	pruned_document_id?: string;
	/** Why the prune did not delete the superseded document: `failed: <reason>` (uplift-2 R6). */
	prune?: string;
}

/** One page's upload, shared with concurrent retries for the same key. */
export type PageSettlement =
	| { ok: true; result: IngestPageResult }
	| { ok: false; reason: string };

/**
 * `changed` says whether this call mutated state — uploaded, replaced or
 * pruned a document and re-recorded its source URL — on BOTH shapes
 * (Greptile round 2): with the prune on, page A can land and delete its
 * predecessor before page B fails, and the failure must still make the
 * service persist the records and invalidate cached searches. A refusal
 * that touched nothing (a gate, an unknown dataset, a first page that never
 * uploaded) says `changed: false`.
 */
export type IngestOutcome =
	| { ok: true; results: IngestPageResult[]; stripped_images: number; changed: boolean }
	| {
			ok: false;
			refused: true;
			reason: string;
			rules?: string[];
			page?: string;
			changed: boolean;
			/** On `version.stale`: what to re-submit against (memory's remedy). */
			remedy?: string;
			/** The record's version now; null when nothing is recorded for the source URL. */
			current_version?: number | null;
			/** The document id of the record a stale write collided with. */
			conflict_with?: string;
			/** On `version.stale`: `false`, since the refused page was not stored. */
			verified_persisted?: false;
	  };

/** A document this record's source URL once published, still on the plane unless pruned. */
export interface SupersededDocument {
	document_id: string;
	/** The commit that upload carried, when the caller named one. */
	commit?: string;
}

/**
 * A source URL's last ingest in one dataset, for hash idempotency — and,
 * per document, the commit that upload carried (uplift-2 R6, Greptile
 * round 1): a citation names its own document's commit, never the
 * dataset's newest pin. `superseded` lists earlier documents of the same
 * source URL that were replaced but not pruned (the last five), so a
 * chunk retrieval still returns from an older document cites that older
 * commit.
 */
export interface IngestRecord {
	sha: string;
	dataset_id: string;
	source_url: string;
	document_id: string;
	commit?: string;
	superseded?: SupersededDocument[];
	/** Monotonic per record: 1 on first ingest, +1 on each replacement. A legacy record loads as 1. */
	version: number;
}

/** What a citation needs to know about a document id: its source URL and the commit it was uploaded under, if any. */
export interface DocumentProvenance {
	source_url: string;
	commit?: string;
}

/**
 * The provenance of a document id across the ingest records: the current
 * document of a source URL, or one of its superseded, unpruned
 * predecessors. Undefined for a document these records never uploaded.
 */
export function documentProvenance(seen: ReadonlyMap<string, IngestRecord>, documentId: string): DocumentProvenance | undefined {
	for (const record of seen.values()) {
		if (record.document_id === documentId) return { source_url: record.source_url, ...(record.commit !== undefined ? { commit: record.commit } : {}) };
		const earlier = record.superseded?.find((entry) => entry.document_id === documentId);
		if (earlier) return { source_url: record.source_url, ...(earlier.commit !== undefined ? { commit: earlier.commit } : {}) };
	}
	return undefined;
}

export interface IngestDeps {
	config: RagflowConfig | null;
	roots?: readonly string[];
	vmGuest?: boolean;
	/** Records keyed `${dataset_id}::${source_url}`; held by the service, optionally persisted. */
	seen?: Map<string, IngestRecord>;
	/** In-flight uploads by record key, tagged with the uploading sha; held by the service so retries serialize. */
	locks?: Map<string, { task: Promise<PageSettlement>; sha: string }>;
	/** Parse budget; production passes a real delay, tests pass zero. */
	poll?: { maxPolls?: number; intervalMs?: number };
	emit: (event: EventInput) => Promise<unknown>;
	surface: Surface | null;
	sessionId?: string;
	fetchImpl?: FetchLike;
	/** The dataset list reader; the plane directly when omitted (uplift-2 R6). */
	datasets?: DatasetListSource;
	/** Delete the superseded document after a replacement parses (`SUBSTRATE_DOCS_PRUNE_SUPERSEDED`); off keeps it. */
	prune?: boolean;
	/** How long a call waits behind another ingest of its dataset before refusing `dataset-lock-timeout`. Defaults to 180 s. */
	datasetLockWaitMs?: number;
	/** Where a failed prune is reported; stderr when omitted. */
	log?: (line: string) => void;
}

const REMOTE_IMG_TAG = /<img\b[^>]*\bsrc\s*=\s*["']https?:[^>]*>/gi;
const REMOTE_MD_IMAGE = /!\[[^\]]*\]\(\s*https?:[^)]+\)/g;

/** Strip remote images pre-upload; local image paths are left for the gates. */
export function stripRemoteImages(body: string): { body: string; stripped: number } {
	let stripped = 0;
	const withoutTags = body.replace(REMOTE_IMG_TAG, () => {
		stripped += 1;
		return "";
	});
	const withoutMd = withoutTags.replace(REMOTE_MD_IMAGE, () => {
		stripped += 1;
		return "";
	});
	return { body: withoutMd, stripped };
}

/**
 * Every redactor rule that fires on the text, by rule name.
 *
 * Runs the event-path rules plus the skill-shaped scan before anything is
 * uploaded: a firing rule is a refusal, never a quiet replacement. If
 * rehearsal surfaces a RAGFlow-shaped secret this misses, the rule lands in
 * Phase 18's `redact.ts`, not here (CONTEXT out-of-scope).
 */
export function findingRules(text: string): string[] {
	const rules = new Set<string>();
	for (const rule of REDACTION_RULES) {
		const flags = rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`;
		if (new RegExp(rule.pattern.source, flags).test(text)) rules.add(rule.name);
	}
	const skill = redactSkillContent(text);
	for (const hit of [...skill.findings, ...skill.redactions]) rules.add(hit.rule);
	if (redact(text) !== text && rules.size === 0) rules.add("unknown-rule");
	return [...rules];
}

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * A repo-rooted path with dot-segments resolved, or null when it escapes.
 *
 * Backslashes become slashes, absolute paths are refused, and `..` that
 * climbs past the repo root yields null — so `docs/../private.md`
 * normalizes to `private.md` and fails the roots check instead of passing
 * it. The CLI carries its own copy (it cannot import this module without
 * breaking the substrate-only door) pinned by a text test.
 */
export function normalizeIngestPath(path: string): string | null {
	const slashed = path.replace(/\\/g, "/");
	if (slashed.startsWith("/")) return null;
	const parts: string[] = [];
	for (const part of slashed.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (parts.length === 0) return null;
			parts.pop();
			continue;
		}
		parts.push(part);
	}
	return parts.join("/");
}
function refused(
	deps: IngestDeps,
	sessionId: string,
	reason: string,
	extra?: { rules?: string[]; page?: string; changed?: boolean; remedy?: string; current_version?: number | null; conflict_with?: string; verified_persisted?: false },
): Promise<IngestOutcome> {
	const { changed = false, ...locator } = extra ?? {};
	const outcome: IngestOutcome = { ok: false, refused: true, reason, ...locator, changed };
	if (deps.surface === null) return Promise.resolve(outcome);
	return deps
		.emit({
			surface: deps.surface,
			kind: "warning",
			summary: `docs ingest refused: ${reason}`,
			session_id: sessionId,
			payload: {
				action: "docs.ingest",
				status: "refused",
				reason,
				...(extra?.rules !== undefined ? { rules: extra.rules } : {}),
				...(extra?.page !== undefined ? { page: extra.page } : {}),
			},
		})
		.then(
			() => outcome,
			() => outcome,
		);
}

function underRoot(path: string, roots: readonly string[]): boolean {
	const clean = normalizeIngestPath(path);
	if (clean === null) return false;
	return roots.some((root) => (root.endsWith("/") ? clean.startsWith(root) : clean === root));
}

function recordKey(datasetId: string, sourceUrl: string): string {
	return `${datasetId}::${sourceUrl}`;
}

/** How long a call waits behind another ingest of its dataset before it is refused `dataset-lock-timeout`. */
const DATASET_INGEST_LOCK_WAIT_MS = 180_000;

/** Returned by the lock when its wait ended before the dataset was free. */
const LOCK_WAIT_EXPIRED = "lock-wait-expired" as const;

/**
 * Each dataset's ingest queue tail, for this process. A call queues behind the tail, runs once the call ahead
 * of it settles, and settles its own slot when it ends, on every path.
 */
const datasetIngestQueues = new Map<string, Promise<void>>();

/**
 * Runs `work` once no other ingest of `dataset` is ahead of it. A call still waiting after `waitMs` gives up
 * without running `work`, so it writes nothing. A call that gave up keeps its slot in the queue until the calls
 * ahead of it settle, so later calls still wait for them.
 */
async function withDatasetIngestLock<T>(dataset: string, waitMs: number, work: () => Promise<T>): Promise<T | typeof LOCK_WAIT_EXPIRED> {
	const ahead = datasetIngestQueues.get(dataset) ?? Promise.resolve();
	let settleSlot: () => void = () => undefined;
	const slot = new Promise<void>((resolve) => {
		settleSlot = () => resolve();
	});
	const tail = ahead.then(() => slot);
	datasetIngestQueues.set(dataset, tail);
	// The entry is dropped only once the queue is idle, so a new call never skips a running one.
	void tail.then(() => {
		if (datasetIngestQueues.get(dataset) === tail) datasetIngestQueues.delete(dataset);
	});
	let cancelExpiry: () => void = () => undefined;
	const expired = new Promise<typeof LOCK_WAIT_EXPIRED>((resolve) => {
		const timer = setTimeout(() => resolve(LOCK_WAIT_EXPIRED), waitMs);
		cancelExpiry = () => clearTimeout(timer);
	});
	const turn = await Promise.race([ahead.then(() => "held" as const), expired]);
	cancelExpiry();
	if (turn === LOCK_WAIT_EXPIRED) {
		settleSlot();
		return LOCK_WAIT_EXPIRED;
	}
	try {
		return await work();
	} finally {
		settleSlot();
	}
}

/** A page after the gates: its normalised body, hash, and source URL, ready for the dataset lock. */
type PreparedPage = { page: IngestPage; sourceUrl: string; body: string; sha: string };

/**
 * Memory's `expected_version` rule (`versionMismatch` in memory-write.ts), for one source URL. `planned` is the
 * version an earlier page of this call leaves for that URL, when one does; `saved` is the record as it stood
 * before this batch. Absent `expected` is today's behaviour. The check compares against `planned` when present,
 * else `saved`; with neither, the record is version 0, so only an expected 0 (or none) passes. The reply's
 * `current_version` and `conflict_with` always describe `saved`, the record a stale write collides with.
 */
function staleVersion(
	planned: { version: number } | undefined,
	saved: { version: number; document_id?: string } | undefined,
	expected: number | undefined,
): { remedy: string; current_version: number | null; conflict_with?: string; verified_persisted: false } | null {
	if (expected === undefined) return null;
	const against = planned ?? saved;
	if (!against) {
		if (expected === 0) return null;
		return {
			remedy:
				`No document is recorded for this source URL, so there is no version ${expected} to replace. ` +
				"Re-submit without expected_version to record the first one.",
			current_version: null,
			verified_persisted: false,
		};
	}
	if (expected === against.version) return null;
	const reply = {
		current_version: saved?.version ?? null,
		verified_persisted: false as const,
		...(saved?.document_id !== undefined ? { conflict_with: saved.document_id } : {}),
	};
	if (planned) {
		return {
			remedy:
				`An earlier page of this call writes this source URL and leaves it at version ${planned.version}, not ${expected}. ` +
				"Re-submit with that version, or in a separate call.",
			...reply,
		};
	}
	return {
		remedy:
			`The record for this source URL is version ${against.version} (${saved?.document_id ?? "no document id"}), not ${expected}. ` +
			"Re-submit against the current version (current_version).",
		...reply,
	};
}

export async function ingestDocs(deps: IngestDeps, input: IngestInput): Promise<IngestOutcome> {
	const sessionId = deps.sessionId ?? `docs-ingest:${randomUUID()}`;
	const roots = deps.roots ?? DEFAULT_INGEST_ROOTS;
	const config = deps.config;
	if (deps.surface === null) return refused(deps, sessionId, "unauthenticated");
	if (deps.vmGuest === true) return refused(deps, sessionId, "vm-guest");
	if (config === null) return refused(deps, sessionId, "ragflow-not-configured");
	if (input.pages.length === 0) return refused(deps, sessionId, "no-pages");

	const prepared: PreparedPage[] = [];
	let total = 0;
	let strippedImages = 0;
	for (const page of input.pages) {
		if (!page.source_url) return refused(deps, sessionId, "no-source-url", { page: page.path });
		if (!underRoot(page.path, roots)) return refused(deps, sessionId, "outside-roots", { page: page.path });
		if (page.real_path !== undefined && !underRoot(page.real_path, roots)) {
			return refused(deps, sessionId, "outside-roots", { page: page.path });
		}
		const stripped = stripRemoteImages(page.body);
		strippedImages += stripped.stripped;
		const size = Buffer.byteLength(stripped.body, "utf8");
		if (size > INGEST_PAGE_MAX_BYTES) return refused(deps, sessionId, "page-too-large", { page: page.path });
		total += size;
		if (total > INGEST_CALL_MAX_BYTES) return refused(deps, sessionId, "call-too-large", { page: page.path });
		const rules = findingRules(`${stripped.body}\n${page.source_url}\n${input.commit ?? ""}\n${page.heading_path ?? ""}`);
		if (rules.length > 0) return refused(deps, sessionId, "secret-findings", { rules, page: page.path });
		prepared.push({ page, sourceUrl: page.source_url, body: stripped.body, sha: sha256(stripped.body) });
	}

	// Taken before the first read of the record. No await sits between the gates and this call, so the lock
	// is held by the time `ingestDocs` returns its promise.
	const waited = await withDatasetIngestLock(input.dataset, deps.datasetLockWaitMs ?? DATASET_INGEST_LOCK_WAIT_MS, () =>
		writeBatch(deps, config, input, prepared, { sessionId, strippedImages }),
	);
	if (waited === LOCK_WAIT_EXPIRED) return refused(deps, sessionId, "dataset-lock-timeout");
	return waited;
}

/** The part of an ingest that runs under its dataset's lock: the dataset lookup, the version plan, then the writes. */
async function writeBatch(
	deps: IngestDeps,
	config: RagflowConfig,
	input: IngestInput,
	prepared: PreparedPage[],
	call: { sessionId: string; strippedImages: number },
): Promise<IngestOutcome> {
	const { sessionId, strippedImages } = call;
	if (deps.surface === null) return refused(deps, sessionId, "unauthenticated");
	const seen = deps.seen ?? new Map<string, IngestRecord>();
	const locks = deps.locks ?? new Map<string, { task: Promise<PageSettlement>; sha: string }>();
	const listed = await (deps.datasets ?? DIRECT_DATASET_LIST).list(config, deps.fetchImpl);
	if (!listed.ok) return refused(deps, sessionId, listed.reason);
	const dataset = listed.datasets.find((entry) => entry.name === input.dataset);
	if (!dataset) return refused(deps, sessionId, "unknown-dataset");
	const commit = input.commit ?? "unpinned";
	// memory's `expected_version` contract, planned for every page before the first upload. A page whose source
	// URL an earlier page of this call also writes is checked against the version that page leaves, so a conflict
	// anywhere refuses the whole call with nothing uploaded or recorded.
	const planned = new Map<string, { version: number; sha: string }>();
	for (const { page, sourceUrl, sha } of prepared) {
		const key = recordKey(dataset.id, sourceUrl);
		const current = planned.get(key) ?? seen.get(key);
		const stale = staleVersion(planned.get(key), seen.get(key), page.expected_version);
		if (stale) return refused(deps, sessionId, "version.stale", { page: page.path, ...stale });
		if (current?.sha === sha) continue;
		planned.set(key, { version: (current?.version ?? 0) + 1, sha });
	}

	const results: IngestPageResult[] = [];
	// True once any page of this call stored a document (and so a record).
	const changed = (): boolean => results.some((result) => result.status !== "unchanged");
	for (const { page, sourceUrl, body, sha } of prepared) {
		const key = recordKey(dataset.id, sourceUrl);
		for (;;) {
			// The record as it stands when this page is written. The lock keeps this call the only writer of this
			// dataset's records, so the version plan above still holds here and no refusal can follow an upload.
			const prior = seen.get(key);
			if (prior && prior.sha === sha) {
				results.push({ path: page.path, source_url: sourceUrl, status: "unchanged", document_id: prior.document_id, content_sha256: sha });
				break;
			}
			// Synchronous check-and-set: no await sits between the lookup
			// and the store, so concurrent retries serialize here.
			const running = locks.get(key);
			if (running && running.sha === sha) {
				const settled = await running.task;
				if (!settled.ok) return refused(deps, sessionId, settled.reason, { page: page.path, changed: changed() });
				results.push(settled.result);
				break;
			}
			if (!running) {
				const replacedPrior = prior;
				const task: Promise<PageSettlement> = (async (): Promise<PageSettlement> => {
					const uploaded = await uploadDocument(
						config,
						{
							dataset_id: dataset.id,
							name: documentName(page.path),
							content: body,
							metadata: { source_url: sourceUrl, commit, heading_path: page.heading_path ?? "" },
						},
						deps.fetchImpl,
					);
					if (!uploaded.ok) return { ok: false, reason: uploaded.reason };
					const started = await parseDocuments(config, dataset.id, [uploaded.document_id], deps.fetchImpl);
					if (!started.ok) return { ok: false, reason: started.reason };
					const parsed = await pollParseStatus(config, { dataset_id: dataset.id, document_id: uploaded.document_id }, deps.fetchImpl, {
						maxPolls: deps.poll?.maxPolls,
						intervalMs: deps.poll?.intervalMs,
					});
					if (!parsed.ok) return { ok: false, reason: parsed.reason };
					// The replacement is retrievable; only now may the superseded
					// document go. A failed delete leaves both documents and is
					// reported, never a refusal of the page that already landed.
					let prune: { pruned_document_id: string } | { prune: string } | null = null;
					if (replacedPrior && deps.prune === true && replacedPrior.document_id !== uploaded.document_id) {
						const deleted = await deleteDocuments(config, dataset.id, [replacedPrior.document_id], deps.fetchImpl);
						if (deleted.ok) prune = { pruned_document_id: replacedPrior.document_id };
						else {
							prune = { prune: `failed: ${deleted.reason}` };
							(deps.log ?? ((line: string) => process.stderr.write(line)))(
								`[substrate] docs ingest: superseded document ${replacedPrior.document_id} in ${dataset.name} not pruned — ${redact(deleted.reason)}\n`,
							);
						}
					}
					const result: IngestPageResult = {
						path: page.path,
						source_url: sourceUrl,
						status: replacedPrior ? "replaced" : "ingested",
						document_id: uploaded.document_id,
						content_sha256: sha,
						...(replacedPrior ? { superseded_document_id: replacedPrior.document_id } : {}),
						...(prune ?? {}),
					};
					// The record keeps this upload's commit (only a named one — "unpinned"
					// on the wire is not a commit) and, unless the prune just deleted it,
					// the replaced document with its own commit, bounded to the last five.
					const lineage: SupersededDocument[] = [
						...(replacedPrior?.superseded ?? []),
						...(replacedPrior && prune !== null && "pruned_document_id" in prune
							? []
							: replacedPrior
								? [{ document_id: replacedPrior.document_id, ...(replacedPrior.commit !== undefined ? { commit: replacedPrior.commit } : {}) }]
								: []),
					].slice(-DATASET_VERSION_RETENTION);
					seen.set(key, {
						sha,
						dataset_id: dataset.id,
						source_url: sourceUrl,
						document_id: uploaded.document_id,
						version: replacedPrior ? replacedPrior.version + 1 : 1,
						...(input.commit !== undefined ? { commit: input.commit } : {}),
						...(lineage.length > 0 ? { superseded: lineage } : {}),
					});
					return { ok: true, result };
				})();
				locks.set(key, { task, sha });
				let settled: PageSettlement;
				try {
					settled = await task;
				} finally {
					if (locks.get(key)?.task === task) locks.delete(key);
				}
				if (!settled.ok) return refused(deps, sessionId, settled.reason, { page: page.path, changed: changed() });
				results.push(settled.result);
				break;
			}
			// A different body is mid-upload: wait for it, then recheck —
			// a third writer may have stored ours meanwhile, else upload ours.
			const settled = await running.task;
			if (!settled.ok) return refused(deps, sessionId, settled.reason, { page: page.path, changed: changed() });
		}
	}

	await deps.emit({
		surface: deps.surface,
		kind: "note",
		summary: `docs ingest ${results.every((result) => result.status === "unchanged") ? "skipped" : "stored"} ${results.length} page(s) into ${dataset.name}`,
		session_id: sessionId,
		payload: {
			action: "docs.ingest",
			dataset_id: dataset.id,
			source_urls: results.map((result) => result.source_url),
			superseded_document_ids: results.flatMap((result) => (result.superseded_document_id ? [result.superseded_document_id] : [])),
			pruned_document_ids: results.flatMap((result) => (result.pruned_document_id ? [result.pruned_document_id] : [])),
			stripped_images: strippedImages,
		},
	});
	return { ok: true, results, stripped_images: strippedImages, changed: changed() };
}
/**
 * Ingest records on disk, so a restarted server does not re-upload pages it
 * already stored (Greptile P1), and — since version 2 (uplift-2 R6) — the
 * per-dataset version lists, so pins and the merge-trigger's idempotency
 * survive the same restart. A missing or corrupt file means empty tables,
 * never a throw: losing dedup degrades to a duplicate upload, losing pins
 * to `unpinned` citations, while refusing ingest over an unreadable file
 * would turn a disk hiccup into an outage of the publication path. The
 * caller reports the problem string. A version-1 file has no `versions`
 * member and loads with an empty version store; the next save writes
 * version 2 (one-way).
 */
export interface IngestStateFile {
	version: 2;
	records: Record<string, IngestRecord>;
	versions: Record<string, DatasetVersion[]>;
	/** uplift-4 S7: accepted merge-triggers per dataset; absent until one was accepted. */
	triggers?: Record<string, unknown>;
	/** uplift-4 S7: breaches in progress (the lag warning's dedupe); absent while none is. */
	lag?: Record<string, LagMarker>;
}

export async function loadIngestRecords(
	file: string,
): Promise<{ records: Map<string, IngestRecord>; versions: VersionStore; freshness: FreshnessState; problem?: string }> {
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch {
		return { records: new Map<string, IngestRecord>(), versions: createVersionStore(), freshness: createFreshnessState() };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {
			records: new Map<string, IngestRecord>(),
			versions: createVersionStore(),
			freshness: createFreshnessState(),
			problem: `${file} is not valid JSON; starting with empty ingest records`,
		};
	}
	if (parsed === null || typeof parsed !== "object" || !("records" in parsed) || parsed.records === null || typeof parsed.records !== "object") {
		return {
			records: new Map<string, IngestRecord>(),
			versions: createVersionStore(),
			freshness: createFreshnessState(),
			problem: `${file} has no records table; starting with empty ingest records`,
		};
	}
	const records = new Map<string, IngestRecord>();
	for (const [key, record] of Object.entries(parsed.records)) {
		if (record === null || typeof record !== "object") continue;
		if (!("sha" in record) || !("dataset_id" in record) || !("source_url" in record) || !("document_id" in record)) continue;
		if (typeof record.sha !== "string" || typeof record.dataset_id !== "string" || typeof record.source_url !== "string" || typeof record.document_id !== "string") {
			continue;
		}
		const superseded: SupersededDocument[] = [];
		if ("superseded" in record && Array.isArray(record.superseded)) {
			for (const entry of record.superseded) {
				if (entry === null || typeof entry !== "object" || !("document_id" in entry) || typeof entry.document_id !== "string") continue;
				const commit = "commit" in entry && typeof entry.commit === "string" ? entry.commit : undefined;
				superseded.push({ document_id: entry.document_id, ...(commit !== undefined ? { commit } : {}) });
			}
		}
		records.set(key, {
			sha: record.sha,
			dataset_id: record.dataset_id,
			source_url: record.source_url,
			document_id: record.document_id,
			...("commit" in record && typeof record.commit === "string" ? { commit: record.commit } : {}),
			...(superseded.length > 0 ? { superseded } : {}),
			// A record written before versions existed was ingested once: version 1.
			version: "version" in record && typeof record.version === "number" && Number.isInteger(record.version) && record.version >= 1 ? record.version : 1,
		});
	}
	const versions = "versions" in parsed ? versionsFromJson(parsed.versions) : createVersionStore();
	return { records, versions, freshness: freshnessStateFromJson(parsed) };
}

/**
 * Persist ingest records and version lists. Throws on I/O failure; the
 * caller logs and continues. Written to a sibling temp file and renamed,
 * so a crash mid-write never leaves half a JSON document behind.
 */
export async function saveIngestRecords(
	file: string,
	seen: Map<string, IngestRecord>,
	versions: VersionStore = createVersionStore(),
	freshness: FreshnessState = createFreshnessState(),
): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	const state: IngestStateFile = { version: 2, records: Object.fromEntries(seen), versions: versionsToJson(versions), ...freshnessStateToJson(freshness) };
	const tmp = `${file}.${process.pid}.tmp`;
	await writeFile(tmp, `${JSON.stringify(state)}\n`, "utf8");
	await rename(tmp, file);
}
