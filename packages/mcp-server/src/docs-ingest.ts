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
import type { DocsBackend, LightragConfig } from "./config.ts";
import type { LightragDatasetList } from "./docs-search.ts";
import {
	deleteDocuments as deleteLightragDocuments,
	parseDocuments as parseLightragDocuments,
	pollParseStatus as pollLightragParseStatus,
	storePlanningPage,
	uploadDocument as uploadLightragDocument,
} from "./planes/lightrag.ts";
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
import type { EventInput, PlanningGraphHint, PlanningGraphRelation, Surface } from "./types.ts";

/** One page may not exceed 1 MB (D25-05, Phase 21 precedent). */
export const INGEST_PAGE_MAX_BYTES = 1_000_000;
/** One ingest call may not exceed 5 MB total. */
export const INGEST_CALL_MAX_BYTES = 5_000_000;

/**
 * Where ingestable pages live, as path prefixes. Mirrors the
 * `agent-substrate` dataset sources in `docs/data-planes.md`
 * (`README.md`, `docs/`, `.planning/` — the whole planning tree, so phase
 * plans ride the same refresh as the project brief).
 */
export const DEFAULT_INGEST_ROOTS: readonly string[] = ["docs/", "README.md", ".planning/"];

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
 * content-hash idempotency keys stay stable across restarts of the server. A
 * `.planning/**.md` page additionally carries its planning-graph hint
 * (`graph`: heading entities plus section/link relations), extracted
 * post-read so the stat cap still applies before any byte is loaded. The
 * result is sorted by path, so a refresh ingests in a stable order.
 */
export async function scanIngestPages(baseDir: string, roots: readonly string[], io: ScanIo = nodeIo): Promise<IngestPage[]> {
	const pages: IngestPage[] = [];
	for (const root of roots) {
		const absolute = resolve(baseDir, root);
		let info: Stats;
		try {
			info = await io.lstat(absolute);
		} catch {
			continue; // absent or unreadable root: skipped, not fatal
		}
		if (info.isSymbolicLink()) continue; // a root that is itself a link is never followed
		if (root.endsWith("/")) await collectDirectory(absolute, root, pages, io);
		else if (info.isFile()) await addFilePage(absolute, root, pages, io);
	}
	pages.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return pages;
}

async function collectDirectory(dir: string, prefix: string, pages: IngestPage[], io: ScanIo): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await io.readdir(dir, { withFileTypes: true });
	} catch {
		return; // missing or unreadable: skipped, not fatal
	}
	for (const entry of entries) {
		if (entry.isSymbolicLink()) continue;
		const relative = `${prefix}${entry.name}`;
		if (entry.isDirectory()) await collectDirectory(join(dir, entry.name), `${relative}/`, pages, io);
		else if (entry.isFile()) await addFilePage(join(dir, entry.name), relative, pages, io);
	}
}

async function addFilePage(absolute: string, path: string, pages: IngestPage[], io: ScanIo): Promise<void> {
	// The size cap applies to the stat, before anything is read: a file the
	// ingest would refuse as page-too-large is never loaded just to be thrown
	// away. It is skipped like every other page the sweep cannot take —
	// quietly, and counted only by its absence from the result.
	let size: number;
	try {
		size = (await io.stat(absolute)).size;
	} catch {
		return; // missing or unreadable: skipped, not fatal
	}
	if (size > INGEST_PAGE_MAX_BYTES) return;
	let body: string;
	try {
		body = await io.readFile(absolute, "utf8");
	} catch {
		return;
	}
	const graph = extractPlanningGraphHint(path, body);
	pages.push({
		path,
		source_url: pathToFileURL(absolute).href,
		body,
		...(graph !== undefined ? { graph } : {}),
	});
}

/**
 * Whether a repo-relative page path is a planning page: anything under
 * `.planning/` ending in `.md`. Non-planning pages never carry a graph hint.
 */
export function isPlanningPage(path: string): boolean {
	const clean = normalizeIngestPath(path);
	return clean !== null && clean.startsWith(".planning/") && clean.endsWith(".md");
}

/**
 * The phase id a planning hint attributes: the phase directory for
 * `.planning/phases/<id>/…`, else the path under `.planning/` without the
 * `.md` suffix (`PROJECT.md` → `"PROJECT"`).
 */
export function planningPhaseOf(path: string): string {
	const clean = normalizeIngestPath(path) ?? path;
	const under = clean.startsWith(".planning/") ? clean.slice(".planning/".length) : clean;
	if (under.startsWith("phases/")) {
		const id = under.slice("phases/".length).split("/")[0];
		if (id !== undefined && id.length > 0) return id;
	}
	return under.endsWith(".md") ? under.slice(0, -".md".length) : under;
}

const ATX_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const INLINE_LINK = /\[([^\]]*)\]\(([^)\s]+)(?:\s+[^)]*)?\)/g;

/**
 * Extract the planning-graph hint a `.planning` markdown page carries for the
 * LightRAG insert: ATX headings become entities (parent→child headings become
 * `contains` relations), inline markdown links become `links-to` relations
 * from the enclosing heading (or the phase, when none precedes) to the raw
 * target, and the directory chain contributes trailing `parent-child`
 * relations (every ancestor directory parents what it holds, down to the
 * page). Targets stay verbatim — cross-folder (`../docs/x.md`), anchor
 * (`#section`) and remote (`https://…`) alike — so the ingest roots gate,
 * not the scanner, decides what resolves. Code fences and a leading `---`
 * frontmatter block are skipped, never parsed; reference-style links and
 * bare autolinks are not extracted. Returns undefined for non-planning
 * paths; a heading-less planning page still yields its directory edges
 * (empty entity lists mean "no bias", never an absent hint).
 */
export function extractPlanningGraphHint(path: string, body: string): PlanningGraphHint | undefined {
	if (!isPlanningPage(path)) return undefined;
	const phase = planningPhaseOf(path);
	const entities: string[] = [];
	const seen = new Set<string>();
	const relations: PlanningGraphHint["relations"] = [];
	const stack: Array<{ level: number; text: string }> = [];
	// Prose lines: a leading `---` frontmatter block and fenced code never
	// reach extraction — headings and links inside them are content samples,
	// not plan structure.
	const rawLines = body.split("\n");
	// A leading `---` block is frontmatter only when a closing `---`/`...`
	// line follows; otherwise it is content (e.g. a horizontal rule) and
	// nothing is skipped.
	let start = 0;
	if ((rawLines[0]?.trim() ?? "") === "---") {
		const close = rawLines.findIndex((line, index) => index > 0 && (line.trim() === "---" || line.trim() === "..."));
		if (close > 0) start = close + 1;
	}
	const prose: string[] = [];
	let fence: string | null = null;
	for (const line of rawLines.slice(start)) {
		const trimmed = line.trim();
		if (fence !== null) {
			if (trimmed.startsWith(fence)) fence = null;
			continue;
		}
		if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
			fence = trimmed.startsWith("```") ? "```" : "~~~";
			continue;
		}
		prose.push(line);
	}
	const scan = prose.join("\n");
	// Headings in document order: entities, plus parent→child `contains`
	// relations. Exact-duplicate headings count once (railway's
	// `planningNodeCount` counts distinct nodes the same way).
	const headingAt: Array<{ offset: number; text: string }> = [];
	{
		let offset = 0;
		for (const line of prose) {
			const heading = ATX_HEADING.exec(line.trim());
			const text = (heading?.[2] ?? "").trim();
			if (heading && text.length > 0) {
				if (!seen.has(text)) {
					seen.add(text);
					entities.push(text);
				}
				const level = heading[1]?.length ?? 1;
				while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
				const parent = stack.length > 0 ? stack[stack.length - 1]?.text : undefined;
				if (parent !== undefined) relations.push({ source: parent, target: text, kind: "contains" });
				stack.push({ level, text });
				headingAt.push({ offset, text });
			}
			offset += line.length + 1;
		}
	}
	// Inline markdown links in document order: `links-to` from the enclosing
	// heading (or the phase, when none precedes) to the verbatim target.
	// Images never match — the `[` must not follow `!` — and neither do
	// reference-style links or bare autolinks.
	for (const match of scan.matchAll(INLINE_LINK)) {
		const at = match.index ?? 0;
		if (at > 0 && scan[at - 1] === "!") continue;
		const target = (match[2] ?? "").trim();
		if (target.length === 0) continue;
		let enclosing: string | null = null;
		for (const entry of headingAt) {
			if (entry.offset <= at) enclosing = entry.text;
			else break;
		}
		relations.push({ source: enclosing ?? phase, target, kind: "links-to" });
	}
	// Directory hierarchy, always last so content relations keep document
	// order: every ancestor directory is the `parent-child` parent of what
	// it holds, down to the page itself. The LightRAG insert uses these to
	// join sibling pages under their phase folder even when the prose
	// names no headings or links at all.
	for (const edge of directoryParentChildRelations(path)) relations.push(edge);
	return { phase, entities, relations };
}

/**
 * The directory-hierarchy edges a repo-relative page path carries: every
 * ancestor directory is the `parent-child` parent of the segment it holds,
 * down to the page itself (`.planning/phases/03-x/PLAN.md` yields
 * `.planning` → `.planning/phases` → `.planning/phases/03-x` →
 * `.planning/phases/03-x/PLAN.md`). Unresolvable paths yield no edges,
 * never a throw — the scanner gates, this helper only describes.
 */
export function directoryParentChildRelations(path: string): PlanningGraphRelation[] {
	const clean = normalizeIngestPath(path);
	if (clean === null) return [];
	const segments = clean.split("/");
	const relations: PlanningGraphRelation[] = [];
	for (let depth = 1; depth < segments.length; depth += 1) {
		const source = segments.slice(0, depth).join("/");
		const target = segments.slice(0, depth + 1).join("/");
		if (source.length > 0 && target.length > 0) relations.push({ source, target, kind: "parent-child" });
	}
	return relations;
}

export interface IngestPage {
	path: string;
	/** The client-resolved filesystem path, when the caller read one. Also gated. */
	real_path?: string;
	source_url?: string;
	body: string;
	heading_path?: string;
	/** Planning-graph hint the scan extracted; set for `.planning/**.md` pages only. */
	graph?: PlanningGraphHint;
}

export interface IngestInput {
	dataset: string;
	commit?: string;
	pages: IngestPage[];
	session_id?: string;
	/**
	 * Call-level planning-graph hints (LightRAG path): a planning page the
	 * scan did not hint (posted, not swept) still indexes its entities when
	 * a hint names the page's phase. `IngestPage.graph` wins per page.
	 */
	graphHints?: PlanningGraphHint[];
}

export interface IngestPageResult {
	path: string;
	source_url: string;
	/** `failed` is LightRAG-path only: per-file isolation records the page instead of refusing the call. */
	status: "ingested" | "replaced" | "unchanged" | "failed";
	document_id: string;
	content_sha256: string;
	/** The prior document this upload supersedes; deleted when the prune is on, else left for the operator. */
	superseded_document_id?: string;
	/** The superseded document the prune deleted (uplift-2 R6). */
	pruned_document_id?: string;
	/** Why the prune did not delete the superseded document: `failed: <reason>` (uplift-2 R6). */
	prune?: string;
	/** Why this page failed (`failed` status only), bounded and redacted. */
	error?: string;
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
	| { ok: true; results: IngestPageResult[]; stripped_images: number; changed: boolean; partial?: boolean }
	| { ok: false; refused: true; reason: string; rules?: string[]; page?: string; changed: boolean };

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
	/** Which plane stores this ingest; the reach rule when unset (`lightragConfig` present means lightrag). */
	backend?: DocsBackend;
	/** LightRAG reach; presence selects the LightRAG path when `backend` is unset. */
	lightragConfig?: LightragConfig | null;
	/** The LightRAG dataset list reader; the RAGFlow list (via `config`) when omitted. */
	lightragDatasets?: LightragDatasetList;
	/** Fetch the LightRAG calls go out on; `fetchImpl` when omitted. */
	lightragFetch?: FetchLike;
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
	extra?: { rules?: string[]; page?: string; changed?: boolean },
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

export async function ingestDocs(deps: IngestDeps, input: IngestInput): Promise<IngestOutcome> {
	const sessionId = deps.sessionId ?? `docs-ingest:${randomUUID()}`;
	const roots = deps.roots ?? DEFAULT_INGEST_ROOTS;
	const seen = deps.seen ?? new Map<string, IngestRecord>();
	const locks = deps.locks ?? new Map<string, { task: Promise<PageSettlement>; sha: string }>();
	const config = deps.config;
	if (deps.surface === null) return refused(deps, sessionId, "unauthenticated");
	if (deps.vmGuest === true) return refused(deps, sessionId, "vm-guest");
	// Backend selection up front: explicit `backend` wins, else `lightragConfig`
	// presence means lightrag (the `resolveDocsBackend` rule). The RAGFlow
	// reach check waits until after the LightRAG branch below, so an explicit
	// LightRAG backend never trips on a missing RAGFlow reach.
	const backend: DocsBackend = deps.backend ?? (deps.lightragConfig != null ? "lightrag" : "ragflow");
	if (input.pages.length === 0) return refused(deps, sessionId, "no-pages");

	const prepared: Array<{ page: IngestPage; sourceUrl: string; body: string; sha: string }> = [];
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

	// Validation above is plane-independent, so the LightRAG path shares it;
	// listing, upload and parse below are per-plane.
	if (backend === "lightrag") {
		return ingestDocsLightrag(deps, input, sessionId, { roots, seen, locks, prepared, strippedImages });
	}
	if (config === null) return refused(deps, sessionId, "ragflow-not-configured");
	const listed = await (deps.datasets ?? DIRECT_DATASET_LIST).list(config, deps.fetchImpl);
	if (!listed.ok) return refused(deps, sessionId, listed.reason);
	const dataset = listed.datasets.find((entry) => entry.name === input.dataset);
	if (!dataset) return refused(deps, sessionId, "unknown-dataset");
	const commit = input.commit ?? "unpinned";

	const results: IngestPageResult[] = [];
	// True once any page of this call stored a document (and so a record).
	const changed = (): boolean => results.some((result) => result.status !== "unchanged");
	for (const { page, sourceUrl, body, sha } of prepared) {
		const key = recordKey(dataset.id, sourceUrl);
		for (;;) {
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

/**
 * Live steering propagation (SPE-19390): `.planning/` polling.
 *
 * A planning update must trigger a docs refresh without blocking the
 * session that made it. The poller re-scans the ingest roots, hashes the
 * result and compares it with the last served hash: equal means quiet,
 * different means the planner changed something a steering session still
 * describes from memory. The hash, not the pages, is the cross-call state,
 * so a restarted poller resumes from one stored string.
 */
export interface PlanningPollConfig {
	/** Ms between polls; the caller sleeps, this module only scans once per call. */
	intervalMs?: number;
	/** Upper bound on pages hashed per tick; extra pages are ignored, never fetched. */
	maxPages?: number;
}

export const PLANNING_POLL_DEFAULTS: Required<PlanningPollConfig> = { intervalMs: 5000, maxPages: 200 };

/**
 * The stable hash of one poll tick: the sorted `path + sha` pairs, so
 * reorderings do not read as changes and one edited page does. Capped to
 * `maxPages` paths so a runaway checkout cannot grow the digest input.
 */
export function planningContentHash(pages: readonly IngestPage[], maxPages: number = PLANNING_POLL_DEFAULTS.maxPages): string {
	const pairs = pages
		.map((page) => `${page.path}\n${sha256(page.body)}`)
		.sort()
		.slice(0, Math.max(1, maxPages));
	return sha256(pairs.join("\n"));
}

/** Compare one tick against the last served hash. */
export function planningPollTick(
	previousHash: string | null,
	pages: readonly IngestPage[],
	config: PlanningPollConfig = {},
): { hash: string; changed: boolean } {
	const hash = planningContentHash(pages, config.maxPages ?? PLANNING_POLL_DEFAULTS.maxPages);
	return { hash, changed: previousHash === null ? pages.length > 0 : previousHash !== hash };
}

/**
 * One non-blocking poll tick: scan the roots and report whether the
 * planning content moved. A scan failure is not a change — the next tick
 * retries — and the previous hash is returned so the caller keeps serving it.
 */
export async function pollPlanningRefresh(
	baseDir: string,
	roots: readonly string[],
	previousHash: string | null,
	config: PlanningPollConfig = {},
	io: ScanIo = nodeIo,
): Promise<{ hash: string; changed: boolean; pages: IngestPage[]; error?: string }> {
	let pages: IngestPage[];
	try {
		pages = await scanIngestPages(baseDir, roots, io);
	} catch (cause) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		return { hash: previousHash ?? "", changed: false, pages: [], error: redact(reason).slice(0, 200) };
	}
	const { hash, changed } = planningPollTick(previousHash, pages, config);
	return { hash, changed, pages };
}

/**
 * Roots a planning scrape sweeps. The whole `.planning/` tree — phase
 * plans ride the same refresh as the project brief — narrowed from the
 * ingest roots so a planning poll never reads `docs/` or `README.md`.
 */
export const PLANNING_SCAN_ROOTS: readonly string[] = [".planning/"];

/**
 * The LightRAG planning-scrape lifecycle, in order: a sweep starts
 * `IDLE`, moves through `SCANNING` (roots read) → `PROCESSING` (per-file
 * sanitize + hash) → `INDEXING` (vector uploads) and settles on
 * `SUCCESS` (everything indexed), `PARTIAL` (some files indexed, some
 * failed — per-file isolation, never a whole-sweep refusal) or `ERROR`
 * (nothing could be read or indexed). Terminal states are `SUCCESS`,
 * `PARTIAL` and `ERROR` — the poller only re-serves on those.
 */
export const PLANNING_SCRAPE_STATES = ["IDLE", "SCANNING", "PROCESSING", "INDEXING", "SUCCESS", "PARTIAL", "ERROR"] as const;
export type PlanningScrapeState = (typeof PLANNING_SCRAPE_STATES)[number];

/**
 * Sanitize one planning page for the vector insert: remote images are
 * stripped (local image paths stay for the gates) and surrounding
 * whitespace is trimmed so trailing-newline churn does not read as a
 * content change. Pure — the gate refusals in `ingestDocs` still apply
 * to the sanitized body before anything uploads.
 */
export function sanitizePlanningBody(body: string): { body: string; stripped: number } {
	const stripped = stripRemoteImages(body);
	return { body: stripped.body.trim(), stripped: stripped.stripped };
}

/**
 * The per-page content hash the incremental update keys on: the sha of
 * the sanitized body, so the trigger and the ingest skip agree on what
 * "unchanged" means.
 */
export function planningPageSha(page: Pick<IngestPage, "body">): string {
	return sha256(sanitizePlanningBody(page.body).body);
}

/** One path's last indexed hash, for the incremental update. */
export function hashPlanningPages(pages: readonly IngestPage[]): Map<string, string> {
	const hashes = new Map<string, string>();
	for (const page of pages) hashes.set(page.path, planningPageSha(page));
	return hashes;
}

/**
 * Polling-plus-hash trigger: compare one scan against the last indexed
 * per-page hashes. `previous === null` is the first poll (everything not
 * yet indexed triggers); otherwise only new or changed paths trigger, so
 * an unchanged poll indexes nothing. Pure — the caller owns the sleep
 * between polls and persists the returned `hash`.
 */
export interface PlanningIngestTrigger {
	triggered: boolean;
	/** The roots this decision covers (`PLANNING_SCAN_ROOTS` unless overridden). */
	roots: readonly string[];
	/** New or changed paths, sorted, empty when nothing moved. */
	paths: string[];
	/** `planning-initial`, `planning-changed:<n>` or `planning-unchanged`. */
	reason: string;
	/** The tick hash the next poll compares against. */
	hash: string;
}

export function planningIngestTrigger(
	pages: readonly IngestPage[],
	previous: ReadonlyMap<string, string> | null,
	roots: readonly string[] = PLANNING_SCAN_ROOTS,
): PlanningIngestTrigger {
	const hash = planningContentHash(pages);
	if (previous === null) {
		const paths = pages.map((page) => page.path).sort();
		return { triggered: paths.length > 0, roots, paths, reason: "planning-initial", hash };
	}
	const paths = pages.filter((page) => previous.get(page.path) !== planningPageSha(page)).map((page) => page.path).sort();
	if (paths.length === 0) return { triggered: false, roots, paths, reason: "planning-unchanged", hash };
	return { triggered: true, roots, paths, reason: `planning-changed:${paths.length}`, hash };
}

/**
 * Settle one scrape from its counts: nothing attempted is `SUCCESS`
 * (an unchanged incremental tick is not a failure), no failures is
 * `SUCCESS`, some failures is `PARTIAL`, total failure is `ERROR`.
 */
export function planningScrapeStateForOutcome(total: number, failed: number): PlanningScrapeState {
	if (total === 0 || failed === 0) return "SUCCESS";
	if (failed < total) return "PARTIAL";
	return "ERROR";
}

/** One file the `PROCESSING` step could not sanitize: isolated, never fatal. */
export interface PlanningScrapeError {
	path: string;
	error: string;
}

/** The settled result of a planning scrape: terminal state, pages and per-file errors. */
export interface PlanningScrapeResult {
	state: PlanningScrapeState;
	pages: IngestPage[];
	/** Sanitized bodies by path, for the `INDEXING` step; pages that failed are absent. */
	sanitized: Map<string, string>;
	errors: PlanningScrapeError[];
	hash: string;
	changed: boolean;
}

/**
 * Scrape the planning roots through `SCANNING` → `PROCESSING`, reporting
 * each transition via `onState` (the initial `IDLE` is reported too, so a
 * poller can log the full lifecycle). Per-file isolation: a page that
 * cannot be sanitized is recorded in `errors` and excluded from
 * `sanitized`, while the rest of the sweep still settles `SUCCESS` (no
 * errors) or `PARTIAL`. A scan that throws settles `ERROR` with no pages.
 * Never throws: the poller calls this on a timer and must not crash on it.
 */
export async function scrapePlanningPages(
	baseDir: string,
	roots: readonly string[] = PLANNING_SCAN_ROOTS,
	previousHash: string | null = null,
	opts: { io?: ScanIo; maxPages?: number; onState?: (state: PlanningScrapeState) => void } = {},
): Promise<PlanningScrapeResult> {
	const io = opts.io ?? nodeIo;
	const report = (state: PlanningScrapeState): void => {
		try {
			opts.onState?.(state);
		} catch {
			// A logging callback must never fail the scrape.
		}
	};
	report("IDLE");
	report("SCANNING");
	let pages: IngestPage[];
	try {
		pages = await scanIngestPages(baseDir, roots, io);
	} catch (cause) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		report("ERROR");
		return { state: "ERROR", pages: [], sanitized: new Map(), errors: [], hash: previousHash ?? "", changed: false };
	}
	report("PROCESSING");
	const sanitized = new Map<string, string>();
	const errors: PlanningScrapeError[] = [];
	for (const page of pages) {
		try {
			sanitized.set(page.path, sanitizePlanningBody(page.body).body);
		} catch (cause) {
			const reason = cause instanceof Error ? cause.message : String(cause);
			errors.push({ path: page.path, error: redact(reason).slice(0, 200) });
		}
	}
	const { hash, changed } = planningPollTick(previousHash, pages, { maxPages: opts.maxPages });
	const state = errors.length === 0 ? "SUCCESS" : pages.length - errors.length > 0 ? "PARTIAL" : "ERROR";
	report(state);
	return { state, pages, sanitized, errors, hash, changed };
}

/**
 * Ingest via the LightRAG plane (cutover backend).
 *
 * Shares the RAGFlow path's validation (roots, size caps, redactor scan),
 * hash idempotency, in-flight locks, records and outcome shape; only the
 * plane calls differ. Dataset resolution is best effort — the dedicated
 * LightRAG list, else the RAGFlow list (keeps existing records aligned),
 * else the requested dataset as its own id — because LightRAG hosts one
 * knowledge base per server. Pages with a planning-graph hint (`graph`,
 * or an `graphHints` entry naming the page's phase) store through
 * `storePlanningPage` so the insert indexes their entities; other pages
 * upload as plain documents. The prune honors `deps.prune` through the
 * plane's document delete, exactly as on RAGFlow.
 */
async function ingestDocsLightrag(
	deps: IngestDeps,
	input: IngestInput,
	sessionId: string,
	shared: {
		roots: readonly string[];
		seen: Map<string, IngestRecord>;
		locks: Map<string, { task: Promise<PageSettlement>; sha: string }>;
		prepared: Array<{ page: IngestPage; sourceUrl: string; body: string; sha: string }>;
		strippedImages: number;
	},
): Promise<IngestOutcome> {
	const { seen, locks, prepared, strippedImages } = shared;
	const lightrag = deps.lightragConfig;
	if (lightrag == null) return refused(deps, sessionId, "lightrag-not-configured");
	const fetchImpl = deps.lightragFetch ?? deps.fetchImpl;
	let listed: { ok: true; datasets: Array<{ id: string; name: string }> } | { ok: false; reason: string };
	if (deps.lightragDatasets !== undefined) listed = await deps.lightragDatasets.list();
	else if (deps.config !== null)
		listed = await (deps.datasets ?? DIRECT_DATASET_LIST).list(deps.config, deps.fetchImpl);
	else listed = { ok: true, datasets: [{ id: input.dataset, name: input.dataset }] };
	if (!listed.ok) return refused(deps, sessionId, listed.reason);
	const dataset = listed.datasets.find((entry) => entry.name === input.dataset);
	if (!dataset) return refused(deps, sessionId, "unknown-dataset");
	const commit = input.commit ?? "unpinned";
	const results: IngestPageResult[] = [];
	const changed = (): boolean => results.some((result) => result.status !== "unchanged");
	// Per-file isolation: a page the plane rejects is recorded as `failed`
	// and the sweep continues, so one bad page never voids the pages that
	// landed. The call reports `partial` when anything landed alongside
	// failures, and refuses only when nothing did.
	let failed = 0;
	let firstFailure: { reason: string; page: string } | null = null;
	const recordFailed = (pagePath: string, source: string, hash: string, reason: string): void => {
		failed += 1;
		if (firstFailure === null) firstFailure = { reason, page: pagePath };
		results.push({
			path: pagePath,
			source_url: source,
			status: "failed",
			document_id: "",
			content_sha256: hash,
			error: redact(reason).slice(0, 200),
		});
	};
	for (const { page, sourceUrl, body, sha } of prepared) {
		const hint = page.graph ?? (isPlanningPage(page.path) ? input.graphHints?.find((entry) => entry.phase === planningPhaseOf(page.path)) : undefined);
		const key = recordKey(dataset.id, sourceUrl);
		for (;;) {
			const prior = seen.get(key);
			if (prior && prior.sha === sha) {
				results.push({ path: page.path, source_url: sourceUrl, status: "unchanged", document_id: prior.document_id, content_sha256: sha });
				break;
			}
			const running = locks.get(key);
			if (running && running.sha === sha) {
				const settled = await running.task;
				if (!settled.ok) {
					recordFailed(page.path, sourceUrl, sha, settled.reason);
					break;
				}
				results.push(settled.result);
				break;
			}
			if (!running) {
				const replacedPrior = prior;
				const task: Promise<PageSettlement> = (async (): Promise<PageSettlement> => {
					const uploaded =
						hint !== undefined
							? await storePlanningPage(
									lightrag,
									{
										path: page.path,
										sourceUrl,
										body,
										...(input.commit !== undefined ? { commit: input.commit } : {}),
										...(page.heading_path !== undefined ? { headingPath: page.heading_path } : {}),
										...(hint.entities.length > 0 ? { entities: [...hint.entities] } : {}),
									},
									fetchImpl,
								)
							: await uploadLightragDocument(
									lightrag,
									{
										// Same path-flattening as the RAGFlow plane, so both
										// planes address the same logical document.
										name: documentName(page.path),
										content: body,
										metadata: { source_url: sourceUrl, commit, heading_path: page.heading_path ?? "" },
									},
									fetchImpl,
								);
					if (!uploaded.ok) return { ok: false, reason: uploaded.reason };
					const started = await parseLightragDocuments(lightrag, dataset.id, [uploaded.document_id], fetchImpl);
					if (!started.ok) return { ok: false, reason: started.reason };
					const parsed = await pollLightragParseStatus(lightrag, { dataset_id: dataset.id, document_id: uploaded.document_id }, fetchImpl, {
						maxPolls: deps.poll?.maxPolls,
						intervalMs: deps.poll?.intervalMs,
					});
					if (!parsed.ok) return { ok: false, reason: parsed.reason };
					let prune: { pruned_document_id: string } | { prune: string } | null = null;
					if (replacedPrior && deps.prune === true && replacedPrior.document_id !== uploaded.document_id) {
						const deleted = await deleteLightragDocuments(lightrag, dataset.id, [replacedPrior.document_id], fetchImpl);
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
				if (!settled.ok) {
					recordFailed(page.path, sourceUrl, sha, settled.reason);
					break;
				}
				results.push(settled.result);
				break;
			}
			const settled = await running.task;
			if (!settled.ok) {
				recordFailed(page.path, sourceUrl, sha, settled.reason);
				break;
			}
		}
	}
	// Fail-closed when nothing landed: a sweep of only failures is a
	// refusal naming the first one, with no state change to persist. A
	// sweep that landed anything reports the failures as `partial`
	// instead — per-file isolation, never a voided batch.
	if (results.length > 0 && failed >= results.length && firstFailure !== null) {
		return refused(deps, sessionId, firstFailure.reason, { page: firstFailure.page, changed: false });
	}
	await deps.emit({
		surface: deps.surface,
		kind: "note",
		summary: `docs ingest ${results.every((result) => result.status === "unchanged") ? "skipped" : "stored"} ${results.length} page(s) into ${dataset.name}${failed > 0 ? ` (${failed} failed)` : ""}`,
		session_id: sessionId,
		payload: {
			action: "docs.ingest",
			backend: "lightrag",
			dataset_id: dataset.id,
			source_urls: results.map((result) => result.source_url),
			superseded_document_ids: results.flatMap((result) => (result.superseded_document_id ? [result.superseded_document_id] : [])),
			pruned_document_ids: results.flatMap((result) => (result.pruned_document_id ? [result.pruned_document_id] : [])),
			stripped_images: strippedImages,
			scrape_state: planningScrapeStateForOutcome(results.length, failed),
			...(failed > 0
				? { partial: true, failed_pages: results.filter((result) => result.status === "failed").map((result) => result.path) }
				: {}),
		},
	});
	return { ok: true, results, stripped_images: strippedImages, changed: changed(), ...(failed > 0 ? { partial: true } : {}) };
}
