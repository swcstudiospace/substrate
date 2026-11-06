/**
 * The rules a corpus document has to satisfy, in one pure module so the CLI can apply them before it sends or deletes
 * anything and the server applies the very same ones when the request arrives: the repository label, the path, the
 * plane-side document name, the size and the empty body.
 *
 * The plane-side name is `corpus:<repo>:<path>@<first 12 hex of sha256>`, with `/` and `%` percent-encoded.
 * The sha suffix is there because LightRAG answers a same-name document with 409: a changed document gets a new name, so
 * the new version can be written beside the old one and the old one deleted once the new row is recorded. The name is also
 * what a search result carries back as its file path, which is how a citation finds its repository and path again.
 *
 * Upstream keeps only the last path component of a document source, so a name holding `/` would lose its directories; `/`
 * (and `%`, so the encoding reverses) is written as `%2F` (`%25`). Every other character is kept: a name the plane would
 * still alter is refused by `isSafeCorpusName`, never rewritten.
 */
import { createHash } from "node:crypto";

/** One document body, as `docs_ingest` caps a page. */
export const MAX_DOCUMENT_BYTES = 1_000_000;
export const MAX_PATH_LENGTH = 1024;
export const MAX_REPO_LENGTH = 200;

export const CORPUS_NAME_PREFIX = "corpus:";

/** Hex digits of the content hash kept in the name. Twelve is 48 bits: collisions inside one path's history are not a concern. */
const NAME_SHA_LENGTH = 12;

/** The prefix of a repository label for a directory that has no GitHub origin. */
const LOCAL_PREFIX = "local/";

/** Hex digits of the directory-name hash that keeps two different names from sharing a rewritten label. */
const LOCAL_HASH_LENGTH = 8;

export function hasControlCharacter(text: string): boolean {
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
	if (repo.startsWith(LOCAL_PREFIX)) {
		const name = repo.slice(LOCAL_PREFIX.length);
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

/**
 * The one label of a plain directory (a copy collection, or a checkout with no GitHub origin). A directory name that
 * already satisfies the repository rule keeps `local/<name>` unchanged, so rows recorded earlier keep their identity. Any
 * other name becomes `local/<slug>-<8 hex of sha256(name)>`: the slug is the name with every character outside
 * `[A-Za-z0-9._-]` replaced by `-`, stripped of leading dots and dashes (`collection` when nothing is left) and cut so the
 * whole label fits the repository length limit with the hash kept. The hash tells apart two names that slug alike.
 */
export function localRepoId(dirName: string): string {
	const plain = `${LOCAL_PREFIX}${dirName}`;
	if (isValidRepo(plain)) return plain;
	const hash = createHash("sha256").update(dirName, "utf8").digest("hex").slice(0, LOCAL_HASH_LENGTH);
	const room = MAX_REPO_LENGTH - LOCAL_PREFIX.length - 1 - LOCAL_HASH_LENGTH;
	const slug = dirName.replace(/[^A-Za-z0-9._-]/gu, "-").replace(/^[.-]+/, "").slice(0, room);
	return `${LOCAL_PREFIX}${slug === "" ? "collection" : slug}-${hash}`;
}

// JS `\s` and Python `str.strip()` differ at U+0085 (Python only) and U+FEFF (JS only); an edge of either kind is refused.
const EDGE_SPACE = /^[\s\u0085]|[\s\u0085]$/;

/** A parser hint upstream may strip from the basename: `name.[engine].ext`. Refused whole: whether a bracket is a hint depends on the server's engines. */
const PARSER_HINT_SHAPE = /\.\[[^\]]*\]\.[^.]+$/;

/**
 * Whether upstream accepts `name` as a `file_source` UNCHANGED. The server builds document names with this, because the
 * name is the document's identity and a silently rewritten name would map a result to the wrong document.
 *
 * Mirrors `/documents/texts` (lightrag_api_routers_document_routes.py v1.5.7): `reject_unsafe_document_source` (:212-226)
 * refuses control characters (U+0000-U+001F, U+007F), lone surrogates, U+FFFE and U+FFFF; then `normalize_file_path`
 * (:245-254) strips whitespace, maps `""`/`no-file-path` to `unknown_source` (which the route answers 400), keeps only the
 * final path component (`Path(...).name`, so a `/` would drop the directories) and strips a recognised `[engine]` parser
 * hint (lightrag/parser/routing.py:62, :1085-1099). The route also requires the normalised names of one request to be unique.
 */
export function isAcceptableFileSource(name: string): boolean {
	if (name.length === 0) return false;
	for (let index = 0; index < name.length; index += 1) {
		const unit = name.charCodeAt(index);
		if (unit <= 0x1f || unit === 0x7f || unit === 0xfffe || unit === 0xffff) return false;
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = name.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
			index += 1;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			return false;
		}
	}
	if (EDGE_SPACE.test(name)) return false;
	if (name === "no-file-path" || name === "unknown_source" || name === "." || name === "..") return false;
	if (name.includes("/")) return false;
	return !PARSER_HINT_SHAPE.test(name);
}

export interface ParsedCorpusName {
	repo: string;
	path: string;
	sha12: string;
}

function encodeSegment(text: string): string {
	return text.replaceAll("%", "%25").replaceAll("/", "%2F");
}

function decodeSegment(text: string): string {
	return text.replace(/%(25|2F)/g, (_match, code: string) => (code === "25" ? "%" : "/"));
}

export function corpusDocumentName(repo: string, path: string, sha256: string): string {
	return `${CORPUS_NAME_PREFIX}${encodeSegment(repo)}:${encodeSegment(path)}@${sha256.slice(0, NAME_SHA_LENGTH)}`;
}

/** The repo, path and sha prefix a corpus document name carries, or null when it is not one. */
export function parseCorpusDocumentName(name: string): ParsedCorpusName | null {
	if (!name.startsWith(CORPUS_NAME_PREFIX)) return null;
	const rest = name.slice(CORPUS_NAME_PREFIX.length);
	// A repo never holds a colon, so the first one ends it; a path may hold colons and `@`, so the suffix is the last `@`.
	const colon = rest.indexOf(":");
	if (colon <= 0) return null;
	const tail = rest.slice(colon + 1);
	const at = tail.lastIndexOf("@");
	if (at <= 0) return null;
	const repo = decodeSegment(rest.slice(0, colon));
	const path = decodeSegment(tail.slice(0, at));
	const sha12 = tail.slice(at + 1);
	if (!isValidRepo(repo) || path.length === 0 || !/^[0-9a-f]{12}$/.test(sha12)) return null;
	return { repo, path, sha12 };
}

/** True when the plane accepts this name as a document source unchanged. A name it would alter or refuse is never sent (`unsafe-name`). */
export function isSafeCorpusName(name: string): boolean {
	return isAcceptableFileSource(name);
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
 * Why a document is refused before anything is sent for it. The first four are decided here, from the document alone; the
 * server adds `sha-mismatch` and `secret-findings`, which need the body hashed and scanned. Closed.
 */
export const DOCUMENT_REFUSALS = ["bad-repo", "bad-path", "too-large", "unsafe-name", "empty-document"] as const;
type DocumentRefusal = (typeof DOCUMENT_REFUSALS)[number];

/**
 * The first rule a document breaks, or null when it may be sent: a well-formed repository and path (the server refuses a
 * whole request holding one that is not), a body within {@link MAX_DOCUMENT_BYTES}, a plane-safe document name, and text
 * left once remote images are stripped. The CLI runs this before it deletes the old copy of a renamed document, and the
 * server runs it again on arrival; the two cannot disagree because this is the only copy.
 */
export function documentRefusal(document: { repo: string; path: string; sha256: string; body: string }): DocumentRefusal | null {
	if (!isValidRepo(document.repo)) return "bad-repo";
	if (!isValidPath(document.path)) return "bad-path";
	if (Buffer.byteLength(document.body, "utf8") > MAX_DOCUMENT_BYTES) return "too-large";
	if (!isSafeCorpusName(corpusDocumentName(document.repo, document.path, document.sha256))) return "unsafe-name";
	if (stripRemoteImages(document.body).body.trim().length === 0) return "empty-document";
	return null;
}
