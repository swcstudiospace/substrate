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
	reconcile: "/corpus/reconcile",
	root: "/corpus/root",
	proof: "/corpus/proof",
	anchor: "/corpus/anchor",
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
	/** Seconds since the newest manifest write, or null when the manifest holds no row yet. */
	lagSeconds: number | null;
	manifestVersion: number;
}

/** The most items `reconcile` lists in one list; the counts always cover all of them. */
export const RECONCILE_MAX_ITEMS = 500;

/** `execute: false` is a dry run: the server reports the drift and repairs nothing. */
export interface CorpusReconcileRequest {
	protocol: typeof CORPUS_PROTOCOL;
	execute: boolean;
}

/** What the docs plane and the manifest disagree about. */
export interface ReconcileDrift {
	/** Active manifest rows whose plane document is gone. */
	missingInPlane: Array<{ repo: string; path: string }>;
	/** Plane documents named `corpus:` that no active row owns. */
	orphansInPlane: string[];
	/** How many active rows and plane documents were compared. */
	checked: number;
	/** True when a list was cut at {@link RECONCILE_MAX_ITEMS} or the plane listing was not complete. */
	truncated: boolean;
}

export interface CorpusReconcileResponse {
	protocol: typeof CORPUS_PROTOCOL;
	drift: ReconcileDrift;
	/** Rows marked removed so the next plan offers them as `add`, and orphan plane documents deleted; both 0 on a dry run. */
	repaired: { requeued: number; deleted: number };
	manifestVersion: number;
}

/** Why a sync ran. Closed: the `docs.sync` event carries it. */
export const SYNC_TRIGGERS = ["manual", "watch", "hook", "sweep", "reconcile"] as const;
export type SyncTrigger = (typeof SYNC_TRIGGERS)[number];

/** How a sync ended. Closed: the `docs.sync` event carries it. */
export const SYNC_OUTCOMES = ["ok", "partial", "failed", "skipped"] as const;
export type SyncOutcome = (typeof SYNC_OUTCOMES)[number];

/**
 * `GET /corpus/root`: the Merkle root over the active manifest (v1.7 phase 69). `count` is the number of leaves it covers;
 * `skipped` is how many active rows could not be encoded as a leaf (a malformed hash or name) and so are not covered.
 */
export interface CorpusRootResponse {
	protocol: typeof CORPUS_PROTOCOL;
	root: string;
	count: number;
	manifestVersion: number;
	skipped: number;
}

/**
 * `GET /corpus/proof?repo=R&path=P`: the inclusion proof of one active document. `repo`, `documentPath` and `sha256` are the
 * triple the leaf commits to; `path` is the RFC 6962 audit path (sibling hashes, leaf to root), which is NOT the document's path.
 * A verifier recomputes `leaf` from the triple, then checks `index`, `treeSize` and `path` against `root`.
 */
export interface CorpusProofResponse {
	protocol: typeof CORPUS_PROTOCOL;
	repo: string;
	documentPath: string;
	sha256: string;
	leaf: string;
	index: number;
	treeSize: number;
	path: string[];
	root: string;
	manifestVersion: number;
}

/** How a root's anchor reads: the closed set of the ledger's checkpoint verification, so a root and a checkpoint answer alike. */
export const CORPUS_ANCHOR_STATUSES = ["anchored", "pending", "unanchored", "unverified", "mismatch"] as const;
export type CorpusAnchorStatus = (typeof CORPUS_ANCHOR_STATUSES)[number];

/** What the chain and the ledger say about the hour a root event sits in. Every member is null when no check got that far. */
export interface CorpusAnchorEvidence {
	/** The hourly Merkle root the anchor memo commits to. */
	anchoredRoot: string | null;
	/** The hour's event count the memo commits to; the bound tree size of `hourProof`. */
	hourEventCount: number | null;
	/** The root event's own hash, the leaf of the hourly tree. */
	eventHash: string | null;
	leafIndex: number | null;
	/** The audit path of the root event inside the hourly tree, leaf to root. */
	hourProof: string[] | null;
	signature: string | null;
	slot: number | null;
	signer: string | null;
	blockTimeMs: number | null;
	finality: "processed" | "confirmed" | "finalized" | null;
}

/**
 * `GET /corpus/anchor?root=HEX64`. `unanchored` is an answer, not an error: no `docs.corpus.root` event carries the root, or
 * the hour it sits in has no anchor. `count` and `manifestVersion` come from the root event, `hourStart` from its hour.
 */
export interface CorpusAnchorResponse {
	protocol: typeof CORPUS_PROTOCOL;
	root: string;
	status: CorpusAnchorStatus;
	reasons: string[];
	eventId: string | null;
	count: number | null;
	manifestVersion: number | null;
	hourStart: string | null;
	evidence: CorpusAnchorEvidence | null;
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
