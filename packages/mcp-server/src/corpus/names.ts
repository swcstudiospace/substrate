/**
 * The plane-side name of a corpus document: `corpus:<repo>:<path>@<first 12 hex of sha256>`, with `/` and `%` percent-encoded.
 *
 * The sha suffix is there because LightRAG answers a same-name document with 409: a changed document gets a new name, so the
 * new version can be written beside the old one and the old one deleted once the new row is recorded. The name is also what a
 * search result carries back as its file path, which is how a citation finds its repository and path again.
 *
 * Upstream keeps only the last path component of a document source, so a name holding `/` would lose its directories; `/`
 * (and `%`, so the encoding reverses) is written as `%2F` (`%25`). Every other character is kept: a name the plane would
 * still alter is refused by `isSafeCorpusName`, never rewritten.
 */
import { createHash } from "node:crypto";
import { isAcceptableFileSource } from "../planes/lightrag-bulk.ts";
import { isValidRepo } from "./validate.ts";

export const CORPUS_NAME_PREFIX = "corpus:";

/** Hex digits of the content hash kept in the name. Twelve is 48 bits: collisions inside one path's history are not a concern. */
export const NAME_SHA_LENGTH = 12;

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

/**
 * The id LightRAG gives the document stored under `name`: `doc-` plus the MD5 of the name (`compute_mdhash_id(file_path,
 * prefix="doc-")`, recorded in `planes/lightrag-bulk.ts`). Used only to clear a same-name document the manifest does not know.
 */
export function planeDocumentIdForName(name: string): string {
	return `doc-${createHash("md5").update(name, "utf8").digest("hex")}`;
}
