/**
 * The contract between the corpus library, the CLI and the server (v1.7 phase 63).
 *
 * Types, closed lists and pure key helpers only: no I/O, no clock, no environment. The library produces `CorpusEntry`
 * values, the CLI sends them to the server routes below, and the server keeps one manifest row per `(repo, path)`.
 */

/** Bumped on a breaking change to any shape below; a server refuses a request that names another version. */
export const CORPUS_PROTOCOL = 1;

/** The one docs dataset the corpus writes into. LightRAG has a single workspace, so this is a record-key label. */
export const CORPUS_DATASET = "corpus";

/** The routes the CLI calls. */
export const CORPUS_ROUTES = {
	plan: "/corpus/plan",
	ingest: "/corpus/ingest",
	status: "/corpus/status",
	reflect: "/corpus/reflect",
	gaps: "/corpus/gaps",
} as const;

/** What a document is, decided from its path alone. Closed: a new kind is a contract change. */
export const DOC_KINDS = [
	"readme",
	"doc",
	"adr",
	"runbook",
	"changelog",
	"agents",
	"skill",
	"planning-state",
	"planning-roadmap",
	"planning-requirements",
	"planning-project",
	"planning-milestones",
	"planning-audit",
	"planning-context",
	"planning-summary",
	"planning-verification",
	"planning-plan",
	"planning-research",
	"planning-archive",
	"planning-other",
	"greptile-kb",
	"digest",
	"other",
] as const;
export type DocKind = (typeof DOC_KINDS)[number];

/** 1 is authoritative and current, 2 is supporting, 3 is bulk or historical. */
export const DOC_TIERS = [1, 2, 3] as const;
export type DocTier = (typeof DOC_TIERS)[number];

/** Where an entry was found. */
export const CORPUS_SOURCES = ["fs", "github", "greptile"] as const;
export type CorpusSource = (typeof CORPUS_SOURCES)[number];

/** One documentation file, described without its body. */
export interface CorpusEntry {
	/** `owner/name` from the origin remote, or `local/<directory>` when the checkout has none. */
	repo: string;
	/** Repository-relative path with forward slashes. */
	path: string;
	kind: DocKind;
	tier: DocTier;
	/** sha256 of the raw bytes, lowercase hex. */
	sha256: string;
	bytes: number;
	source: CorpusSource;
	/** The commit the content was read at, when known. */
	commit?: string | undefined;
	/**
	 * A repo-relative path of the same repository that replaces this document, from its `superseded-by` front-matter marker
	 * (tier 1 and 2 documents only). The server keeps it only when it is a valid path; an invalid marker is dropped, never a refusal.
	 */
	supersededBy?: string | undefined;
}

/** An entry plus its text, sent only for documents that must change. */
export interface CorpusDocument extends CorpusEntry {
	body: string;
}

/**
 * `plan` and `status` use these actions; `unchanged` rows are counted and never listed. `update` is the same sha256
 * under a different source, kind or tier: a manifest-only refresh that never touches the docs plane.
 */
export const PLAN_ACTIONS = ["add", "change", "update", "rename", "tombstone", "unchanged"] as const;
export type PlanAction = (typeof PLAN_ACTIONS)[number];

/** Bounds both sides enforce: the CLI keeps its requests inside them and the server refuses a request outside them. */
export const MAX_PLAN_ENTRIES = 20_000;
export const MAX_COVERAGE_PAIRS = 4_000;
export const MAX_INGEST_DOCUMENTS = 200;
export const MAX_INGEST_TOMBSTONES = 500;

/** One (repository, source) pair a scan read completely. */
export interface CorpusCoverage {
	repo: string;
	source: CorpusSource;
}

/**
 * Which part of the manifest a plan may judge. A manifest row the scan did not report is tombstoned only when its
 * `(repo, source)` pair is in `coverage` and its tier is at most `maxTier`. The caller lists a pair only when that source
 * read that repository completely: a failed read, a truncated tree or a cap such as `--max-repos` leaves the pair out, so
 * a narrower or failed scan never tombstones the documents it did not cover. An empty list tombstones nothing; the entries
 * are still planned and ingested.
 */
export interface CorpusScope {
	coverage: CorpusCoverage[];
	maxTier: DocTier;
}

export interface CorpusPlanRequest {
	protocol: typeof CORPUS_PROTOCOL;
	entries: CorpusEntry[];
	scope: CorpusScope;
}

export interface PlanItem {
	action: Exclude<PlanAction, "unchanged">;
	repo: string;
	path: string;
	sha256?: string | undefined;
	/** Present for `rename`: the manifest row the document moved from (same repo, same sha256). */
	renamedFrom?: string | undefined;
}

export interface CorpusPlanResponse {
	protocol: typeof CORPUS_PROTOCOL;
	items: PlanItem[];
	counts: Record<PlanAction, number>;
	/** Increases whenever the manifest changes; a plan made against an older version is still valid, only less fresh. */
	manifestVersion: number;
}

export interface CorpusIngestRequest {
	protocol: typeof CORPUS_PROTOCOL;
	documents: CorpusDocument[];
	/** Manifest keys to remove from the docs plane, as `{repo, path}`. */
	tombstones: Array<{ repo: string; path: string }>;
}

export const INGEST_STATUSES = ["ingested", "updated", "unchanged", "tombstoned", "refused", "failed"] as const;
export type IngestStatus = (typeof INGEST_STATUSES)[number];

export interface CorpusIngestResultItem {
	repo: string;
	path: string;
	status: IngestStatus;
	/** A closed reason code for `refused` and `failed`, for example `secret-findings` or `plane-unavailable`. */
	reason?: string | undefined;
	documentId?: string | undefined;
}

export interface CorpusIngestResponse {
	protocol: typeof CORPUS_PROTOCOL;
	results: CorpusIngestResultItem[];
	counts: Record<IngestStatus, number>;
	manifestVersion: number;
}

export interface CorpusStatusResponse {
	protocol: typeof CORPUS_PROTOCOL;
	total: number;
	active: number;
	tombstoned: number;
	byRepo: Array<{ repo: string; active: number; tombstoned: number }>;
	byKind: Array<{ kind: DocKind; count: number }>;
	byTier: Array<{ tier: DocTier; count: number }>;
	lastIngestAt: string | null;
	manifestVersion: number;
}

/** Bounds of `POST /corpus/reflect`: the CLI keeps inside them and the server refuses a request outside them. */
export const MAX_REFLECT_DIGESTS = 200;
export const MAX_DIGEST_CHARS = 20_000;

/** The virtual path a repository digest is stored under: it is not a file of the repository. */
export const DIGEST_PATH = ".substrate/digest.md";

export interface CorpusDigestPayload {
	repo: string;
	text: string;
	/** sha256 of `text` (UTF-8), lowercase hex. */
	sha256: string;
}

export interface CorpusReflectRequest {
	protocol: typeof CORPUS_PROTOCOL;
	digests: CorpusDigestPayload[];
}

export const REFLECT_STATUSES = ["stored", "unchanged", "refused", "failed"] as const;
export type ReflectStatus = (typeof REFLECT_STATUSES)[number];

export interface CorpusReflectResultItem {
	repo: string;
	status: ReflectStatus;
	/** A closed reason code for `refused` and `failed`. */
	reason?: string | undefined;
}

export interface CorpusReflectResponse {
	protocol: typeof CORPUS_PROTOCOL;
	results: CorpusReflectResultItem[];
	manifestVersion: number;
}

/** The most gaps one `GET /corpus/gaps` answers, and how many it answers when `limit` is absent. */
export const MAX_GAPS_LIMIT = 200;
export const DEFAULT_GAPS_LIMIT = 50;

/** A query the corpus could not answer well, aggregated by the hash of the query. */
export interface CorpusGap {
	queryHash: string;
	/** The redacted, capped text of the query, when the server kept it. */
	text: string | null;
	searches: number;
	lastSeen: string;
	/** The best score any of the searches returned; null when none returned a scored citation. */
	best: number | null;
}

export interface CorpusGapsResponse {
	protocol: typeof CORPUS_PROTOCOL;
	gaps: CorpusGap[];
	truncated: boolean;
}

/** The manifest key of a document, also the identity used in logs and proofs. */
export function documentKey(repo: string, path: string): string {
	return `${repo}:${path}`;
}

/** The citation URL for a document: the GitHub blob when the repo has a GitHub origin, else a `corpus://` URL. */
export function sourceUrl(repo: string, path: string, commit?: string): string {
	const encoded = path
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
	if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) && !repo.startsWith("local/")) {
		return `https://github.com/${repo}/blob/${commit === undefined || commit === "" ? "HEAD" : commit}/${encoded}`;
	}
	return `corpus://${repo}/${encoded}`;
}

export function isDocKind(value: unknown): value is DocKind {
	return typeof value === "string" && (DOC_KINDS as readonly string[]).includes(value);
}

export function isDocTier(value: unknown): value is DocTier {
	return value === 1 || value === 2 || value === 3;
}

export function isCorpusSource(value: unknown): value is CorpusSource {
	return typeof value === "string" && (CORPUS_SOURCES as readonly string[]).includes(value);
}
