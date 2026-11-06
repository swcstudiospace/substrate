/**
 * The Merkle leaf of one corpus document (v1.7 phase 69, PROOF-01).
 *
 * A leaf commits to `(repo, path, sha256)`: which document, in which repository, with which content. The encoding is fixed,
 * versioned and unambiguous, and documented in `docs/corpus-proofs.md`:
 *
 *   leaf bytes = DOMAIN ‖ u32be(len(repo)) ‖ repo ‖ u32be(len(path)) ‖ path ‖ sha256
 *
 * where DOMAIN is the 24 ASCII bytes `substrate:corpus:leaf:v1`, `repo` and `path` are UTF-8, every length is the byte length as
 * a 4-byte big-endian unsigned integer, and `sha256` is the 32 raw bytes of the document's content hash. The domain prefix has a
 * fixed length and the tail is fixed at 32 bytes, so no two different triples encode to the same bytes (`("ab", "c")` and
 * `("a", "bc")` differ by their length prefixes). The leaf handed to the ledger's tree is the SHA-256 of those bytes, as 64
 * lowercase hex characters: the ledger's RFC 6962 functions take 32-byte leaves and hash each once more with their own `0x00`
 * leaf prefix.
 *
 * Pure: no environment, no clock, no network. Leaves are sorted by `(repo, path)` by code unit (`compareEntries`) before they
 * are folded, so the root does not depend on insertion order or a locale.
 */
import { createHash } from "node:crypto";

/** The leaf encoding's version, carried by its domain prefix. A new encoding is a new domain string, never a silent change. */
export const CORPUS_LEAF_DOMAIN = "substrate:corpus:leaf:v1";

/**
 * The root of a manifest with no active document: RFC 6962's hash of the empty tree, SHA-256 of zero bytes. The ledger's own
 * `merkleRoot` refuses an empty input (an empty hour is never anchored), so the corpus defines this value itself. It is a
 * plain constant and is never emitted as a root event.
 */
export const CORPUS_EMPTY_ROOT = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** How many leading hex characters of a root the short form carries (what a `docs_search` reply names). */
const CORPUS_SHORT_ROOT_LENGTH = 12;

/** The most sibling hashes a proof may carry (the depth of a tree of 2^64 leaves); the CLI refuses a proof file with a longer path. */
export const MAX_PROOF_PATH_LENGTH = 64;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const LONE_SURROGATE = /\p{Surrogate}/u;

/** Whether `value` is 64 lowercase hex characters. */
export function isSha256Hex(value: unknown): value is string {
	return typeof value === "string" && SHA256_HEX.test(value);
}

/** Why a triple has no leaf, or null when it has one. Closed. */
type LeafRefusal = "bad-sha256" | "bad-text";

/**
 * Whether `(repo, path, sha256)` can be encoded: the hash is 64 lowercase hex and the two names are well-formed Unicode. A
 * lone surrogate would be written as U+FFFD, so two different strings could share a leaf; it is refused instead.
 */
export function leafRefusal(repo: string, path: string, sha256: string): LeafRefusal | null {
	if (!isSha256Hex(sha256)) return "bad-sha256";
	if (LONE_SURROGATE.test(repo) || LONE_SURROGATE.test(path)) return "bad-text";
	return null;
}

function lengthPrefixed(bytes: Uint8Array): Buffer {
	const prefix = Buffer.alloc(4);
	prefix.writeUInt32BE(bytes.length, 0);
	return Buffer.concat([prefix, bytes]);
}

/** The leaf of one document, as 64 lowercase hex characters. Throws on a triple `leafRefusal` names. */
export function corpusLeafHex(repo: string, path: string, sha256: string): string {
	const refusal = leafRefusal(repo, path, sha256);
	if (refusal !== null) throw new Error(`corpusLeafHex: ${refusal === "bad-sha256" ? "sha256 is not 64 lowercase hex characters" : "repo or path is not well-formed Unicode"}`);
	const encoded = Buffer.concat([Buffer.from(CORPUS_LEAF_DOMAIN, "ascii"), lengthPrefixed(Buffer.from(repo, "utf8")), lengthPrefixed(Buffer.from(path, "utf8")), Buffer.from(sha256, "hex")]);
	return createHash("sha256").update(encoded).digest("hex");
}

/** The first {@link CORPUS_SHORT_ROOT_LENGTH} characters of a root. */
export function shortRoot(root: string): string {
	return root.slice(0, CORPUS_SHORT_ROOT_LENGTH);
}
