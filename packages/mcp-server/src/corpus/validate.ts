/**
 * Guards for what the corpus routes accept: every field of a request body is narrowed here, and the first thing wrong refuses
 * the whole request with a closed reason instead of being guessed at. Pure: no I/O, no clock.
 *
 * Request bounds live here too, so the route, the tool and the tests name one number.
 */
import {
	CORPUS_PROTOCOL,
	CORPUS_SOURCES,
	isCorpusSource,
	isDocKind,
	isDocTier,
	type CorpusDocument,
	type CorpusEntry,
	type CorpusIngestRequest,
	type CorpusPlanRequest,
	type CorpusScope,
	type CorpusSource,
} from "@substrate/corpus";

/** One plan request holds at most this many entries (a host with a few hundred repositories reports a few thousand). */
export const MAX_PLAN_ENTRIES = 20_000;
/** The repositories one scope names. */
export const MAX_SCOPE_REPOS = 2_000;
/** Documents with a body in one ingest request. */
export const MAX_INGEST_DOCUMENTS = 200;
/** Tombstones in one ingest request. */
export const MAX_INGEST_TOMBSTONES = 500;
/** One document body, as `docs_ingest` caps a page. */
export const MAX_DOCUMENT_BYTES = 1_000_000;
export const MAX_PATH_LENGTH = 1024;
const MAX_REPO_LENGTH = 200;
const MAX_COMMIT_LENGTH = 100;
/** The `bytes` column is a Postgres integer. */
const MAX_ENTRY_BYTES = 2_147_483_647;

/** Why a whole request is refused. Closed: the CLI prints these and the tests pin them. */
export const REQUEST_REFUSALS = [
	"bad-request",
	"bad-protocol",
	"too-many-entries",
	"too-many-documents",
	"too-many-tombstones",
	"empty-request",
	"empty-scope",
	"bad-scope",
	"bad-repo",
	"bad-path",
	"bad-kind",
	"bad-tier",
	"bad-sha256",
	"bad-bytes",
	"bad-source",
	"bad-commit",
	"bad-body",
	"duplicate-entry",
] as const;
export type RequestRefusal = (typeof REQUEST_REFUSALS)[number];

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: RequestRefusal; detail?: string | undefined };

function refuse(reason: RequestRefusal, detail?: string): { ok: false; reason: RequestRefusal; detail?: string | undefined } {
	return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
}

function hasControlCharacter(text: string): boolean {
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

const OWNER_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** `owner/name`, or `local/<directory name>` for a checkout with no origin. A repo never holds a colon (document names split on it). */
export function isValidRepo(repo: string): boolean {
	if (repo.length === 0 || repo.length > MAX_REPO_LENGTH) return false;
	if (repo.startsWith("local/")) {
		const name = repo.slice("local/".length);
		return name.length > 0 && name !== "." && name !== ".." && !/[/\\:]/.test(name) && !hasControlCharacter(name);
	}
	return OWNER_NAME.test(repo);
}

/** A repository-relative path in normal form: forward slashes, no empty, `.` or `..` segment, not absolute, no control character or NUL. */
export function isValidPath(path: string): boolean {
	if (path.length === 0 || path.length > MAX_PATH_LENGTH) return false;
	if (path.startsWith("/") || path.includes("\\") || hasControlCharacter(path)) return false;
	return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function isSha256Hex(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** The one object guard the corpus module uses; fields stay `unknown` and the parsers narrow them. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** One entry, narrowed field by field. `bytes` is the size of the raw file the sha256 describes. */
export function parseEntry(raw: unknown): Parsed<CorpusEntry> {
	if (!isRecord(raw)) return refuse("bad-request", "an entry must be an object");
	const { repo, path, kind, tier, sha256, bytes, source, commit } = raw;
	if (typeof repo !== "string" || !isValidRepo(repo)) return refuse("bad-repo", typeof repo === "string" ? repo.slice(0, 80) : undefined);
	if (typeof path !== "string" || !isValidPath(path)) return refuse("bad-path", `${repo}: ${typeof path === "string" ? path.slice(0, 80) : "not a string"}`);
	if (!isDocKind(kind)) return refuse("bad-kind", `${repo}:${path}`);
	if (!isDocTier(tier)) return refuse("bad-tier", `${repo}:${path}`);
	if (!isSha256Hex(sha256)) return refuse("bad-sha256", `${repo}:${path}`);
	if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0 || bytes > MAX_ENTRY_BYTES) return refuse("bad-bytes", `${repo}:${path}`);
	if (!isCorpusSource(source)) return refuse("bad-source", `${repo}:${path}`);
	if (commit !== undefined && typeof commit !== "string") return refuse("bad-commit", `${repo}:${path}`);
	if (typeof commit === "string" && (commit.length === 0 || commit.length > MAX_COMMIT_LENGTH || hasControlCharacter(commit))) return refuse("bad-commit", `${repo}:${path}`);
	return { ok: true, value: { repo, path, kind, tier, sha256, bytes, source, ...(typeof commit === "string" ? { commit } : {}) } };
}

/** The plan's scope: at least one repo and one source, every repo well formed. An empty scope judges nothing, so it is refused, not read as "everything". */
export function parseScope(raw: unknown): Parsed<CorpusScope> {
	if (!isRecord(raw)) return refuse("bad-scope", "scope must be an object");
	const { repos, maxTier, sources } = raw;
	if (!Array.isArray(repos) || !Array.isArray(sources) || !isDocTier(maxTier)) return refuse("bad-scope", "scope needs repos, maxTier and sources");
	if (repos.length === 0 || sources.length === 0) return refuse("empty-scope");
	if (repos.length > MAX_SCOPE_REPOS) return refuse("bad-scope", `at most ${MAX_SCOPE_REPOS} repos`);
	const repoList: string[] = [];
	for (const repo of repos) {
		if (typeof repo !== "string" || !isValidRepo(repo)) return refuse("bad-repo", typeof repo === "string" ? repo.slice(0, 80) : undefined);
		repoList.push(repo);
	}
	const sourceList: CorpusSource[] = [];
	for (const source of sources) {
		if (!isCorpusSource(source)) return refuse("bad-source", `scope source must be one of ${CORPUS_SOURCES.join(", ")}`);
		sourceList.push(source);
	}
	return { ok: true, value: { repos: [...new Set(repoList)], maxTier, sources: [...new Set(sourceList)] } };
}

function keyOf(entry: Pick<CorpusEntry, "repo" | "path">): string {
	return `${entry.repo}\n${entry.path}`;
}

/** `POST /corpus/plan`: the protocol version, at most {@link MAX_PLAN_ENTRIES} well-formed entries with unique keys, and a non-empty scope. */
export function parsePlanRequest(raw: unknown): Parsed<CorpusPlanRequest> {
	if (!isRecord(raw)) return refuse("bad-request", "the body must be a JSON object");
	if (raw.protocol !== CORPUS_PROTOCOL) return refuse("bad-protocol", `this server speaks protocol ${CORPUS_PROTOCOL}`);
	if (!Array.isArray(raw.entries)) return refuse("bad-request", "entries must be an array");
	if (raw.entries.length > MAX_PLAN_ENTRIES) return refuse("too-many-entries", `at most ${MAX_PLAN_ENTRIES}`);
	const scope = parseScope(raw.scope);
	if (!scope.ok) return scope;
	const seen = new Set<string>();
	const entries: CorpusEntry[] = [];
	for (const item of raw.entries) {
		const entry = parseEntry(item);
		if (!entry.ok) return entry;
		const key = keyOf(entry.value);
		if (seen.has(key)) return refuse("duplicate-entry", `${entry.value.repo}:${entry.value.path}`);
		seen.add(key);
		entries.push(entry.value);
	}
	return { ok: true, value: { protocol: CORPUS_PROTOCOL, entries, scope: scope.value } };
}

/**
 * `POST /corpus/ingest`: documents (an entry plus its text) and tombstone keys, within the per-request bounds, each key at most
 * once across both lists. A body over {@link MAX_DOCUMENT_BYTES} is not a request refusal: it is that one document's `too-large`.
 */
export function parseIngestRequest(raw: unknown): Parsed<CorpusIngestRequest> {
	if (!isRecord(raw)) return refuse("bad-request", "the body must be a JSON object");
	if (raw.protocol !== CORPUS_PROTOCOL) return refuse("bad-protocol", `this server speaks protocol ${CORPUS_PROTOCOL}`);
	const rawDocuments = raw.documents === undefined ? [] : raw.documents;
	const rawTombstones = raw.tombstones === undefined ? [] : raw.tombstones;
	if (!Array.isArray(rawDocuments) || !Array.isArray(rawTombstones)) return refuse("bad-request", "documents and tombstones must be arrays");
	if (rawDocuments.length === 0 && rawTombstones.length === 0) return refuse("empty-request");
	if (rawDocuments.length > MAX_INGEST_DOCUMENTS) return refuse("too-many-documents", `at most ${MAX_INGEST_DOCUMENTS}`);
	if (rawTombstones.length > MAX_INGEST_TOMBSTONES) return refuse("too-many-tombstones", `at most ${MAX_INGEST_TOMBSTONES}`);
	const seen = new Set<string>();
	const documents: CorpusDocument[] = [];
	for (const item of rawDocuments) {
		const entry = parseEntry(item);
		if (!entry.ok) return entry;
		const body = isRecord(item) ? item.body : undefined;
		if (typeof body !== "string") return refuse("bad-body", `${entry.value.repo}:${entry.value.path}`);
		const key = keyOf(entry.value);
		if (seen.has(key)) return refuse("duplicate-entry", `${entry.value.repo}:${entry.value.path}`);
		seen.add(key);
		documents.push({ ...entry.value, body });
	}
	const tombstones: Array<{ repo: string; path: string }> = [];
	for (const item of rawTombstones) {
		if (!isRecord(item)) return refuse("bad-request", "a tombstone must be an object");
		const { repo, path } = item;
		if (typeof repo !== "string" || !isValidRepo(repo)) return refuse("bad-repo", typeof repo === "string" ? repo.slice(0, 80) : undefined);
		if (typeof path !== "string" || !isValidPath(path)) return refuse("bad-path", `${repo}: ${typeof path === "string" ? path.slice(0, 80) : "not a string"}`);
		const key = keyOf({ repo, path });
		if (seen.has(key)) return refuse("duplicate-entry", `${repo}:${path}`);
		seen.add(key);
		tombstones.push({ repo, path });
	}
	return { ok: true, value: { protocol: CORPUS_PROTOCOL, documents, tombstones } };
}
