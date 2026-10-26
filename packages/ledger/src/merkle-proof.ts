/**
 * Inclusion proofs over the RFC 6962 tree in `merkle.ts`: one event hash can be shown to sit inside
 * an anchored hourly root without revealing the other events in that hour.
 *
 * `merkleAuditPath` is the RFC 6962 section 2.1.1 audit path (PATH); `verifyAuditPath` is the RFC
 * 9162 section 2.1.3.2 verification. Both use the tree's own hashing (leaf = SHA256(0x00 ‖ bytes),
 * node = SHA256(0x01 ‖ left ‖ right)) and its split rule (largest power of two strictly below n), so
 * an odd last leaf is promoted, never duplicated.
 *
 * The root does not authenticate the tree size: a proof with a wrong `size` still verifies whenever
 * that size yields the same step shape for the index. The size must come from a trusted commitment,
 * which here is the anchored memo's event count (`substrate:v1:<hour>:<root>:<count>`);
 * `verifyMerkleProofAgainstCommitment` binds the proof's size to that count and is what the anchor
 * verifier MUST use.
 */

import { bytesToHex, hexToBytes, merkleRoot } from "./merkle.ts";

const NODE_PREFIX = Uint8Array.of(0x01);
const HASH_HEX_RE = /^[0-9a-f]{64}$/;
const UINT32_MAX = 0xffff_ffff;

function sha256(...parts: Uint8Array[]): Uint8Array {
	const hasher = new Bun.CryptoHasher("sha256");
	for (const part of parts) hasher.update(part);
	return new Uint8Array(hasher.digest());
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/** The largest power of two strictly below `n` (n >= 2). */
function splitPoint(n: number): number {
	let k = 1;
	while (k * 2 < n) k *= 2;
	return k;
}

/**
 * The RFC 6962 audit path for leaf `index` of `leaves`: the sibling subtree hashes from the leaf up
 * to the root. A single-leaf tree has an empty path. An empty `leaves` or an out-of-range `index` throws.
 */
export function merkleAuditPath(leaves: readonly Uint8Array[], index: number): Uint8Array[] {
	if (leaves.length === 0) throw new Error("merkleAuditPath: empty input (an empty hour is never anchored)");
	if (!Number.isInteger(index) || index < 0 || index >= leaves.length) {
		throw new Error(`merkleAuditPath: index ${index} is out of range for ${leaves.length} leaves`);
	}
	const path: Uint8Array[] = [];
	// Walk down from the root, collecting siblings; reverse at the end so the path runs leaf → root.
	let lo = 0;
	let hi = leaves.length;
	let m = index;
	while (hi - lo > 1) {
		const k = splitPoint(hi - lo);
		if (m < k) {
			path.push(merkleRoot(leaves.slice(lo + k, hi)));
			hi = lo + k;
		} else {
			path.push(merkleRoot(leaves.slice(lo, lo + k)));
			lo += k;
			m -= k;
		}
	}
	return path.reverse();
}

/**
 * RFC 9162 section 2.1.3.2: does `path` prove `leaf` (raw leaf bytes, not yet hashed) is leaf
 * `index` of a `size`-leaf tree whose root is `root`? Any inconsistency (index out of range, a path
 * whose length differs from the one the claimed (index, size) implies, a changed byte anywhere) is
 * `false`, never a throw.
 *
 * The root commits to the tree's contents, not to its own size. The path is consumed by a bit-shift
 * recipe driven by (index, size), so two sizes that give the same recipe for `index` compute the
 * same root from the same path and BOTH verify. A wrong size is rejected only when it changes the
 * step shape. Callers MUST bind `size` to a trusted count (see `verifyMerkleProofAgainstCommitment`).
 */
export function verifyAuditPath(
	leaf: Uint8Array,
	index: number,
	size: number,
	path: readonly Uint8Array[],
	root: Uint8Array,
): boolean {
	if (!Number.isSafeInteger(index) || !Number.isSafeInteger(size) || size < 1 || index < 0 || index >= size) return false;
	let fn = index;
	let sn = size - 1;
	let r = merkleRoot([leaf]);
	for (const p of path) {
		if (sn === 0) return false;
		if (fn % 2 === 1 || fn === sn) {
			r = sha256(NODE_PREFIX, p, r);
			if (fn % 2 === 0) {
				while (fn % 2 === 0 && fn !== 0) {
					fn = Math.floor(fn / 2);
					sn = Math.floor(sn / 2);
				}
			}
		} else {
			r = sha256(NODE_PREFIX, r, p);
		}
		fn = Math.floor(fn / 2);
		sn = Math.floor(sn / 2);
	}
	return sn === 0 && bytesEqual(r, root);
}

export type MerkleProofHex = { index: number; size: number; path: string[] };

function assertHash(fn: string, what: string, value: unknown): asserts value is string {
	if (typeof value !== "string" || !HASH_HEX_RE.test(value)) {
		throw new Error(`${fn}: ${what} is not 64 lowercase hex characters`);
	}
}

/** The inclusion proof for `hashes[index]` (64-hex event hashes, ingest order). Malformed input throws. */
export function merkleProofHex(hashes: readonly string[], index: number): MerkleProofHex {
	for (const [i, h] of hashes.entries()) assertHash("merkleProofHex", `entry ${i}`, h);
	const path = merkleAuditPath(hashes.map(hexToBytes), index);
	return { index, size: hashes.length, path: path.map(bytesToHex) };
}

/**
 * Verify a hex inclusion proof of the event hash `hash` against the hourly root `rootHex`. A
 * malformed shape (non-hex hash, root or path element; non-integer index; size below 1) throws,
 * as `merkleRootHex` does; a well-formed proof that does not verify returns `false`.
 *
 * RFC-exact, so the root does NOT authenticate `proof.size`: a wrong size whose (index, size) pair
 * drives the same step recipe (e.g. index 0 with size 13 versus 14, both four steps) still verifies
 * from the same path. Callers MUST bind the size to a trusted count; for anchored hours use
 * `verifyMerkleProofAgainstCommitment` with the memo's event count.
 */
export function verifyMerkleProofHex(
	hash: string,
	proof: { index: number; size: number; path: readonly string[] },
	rootHex: string,
): boolean {
	assertHash("verifyMerkleProofHex", "hash", hash);
	assertHash("verifyMerkleProofHex", "root", rootHex);
	if (!Number.isSafeInteger(proof.index) || proof.index < 0) {
		throw new Error(`verifyMerkleProofHex: index ${proof.index} is not a non-negative integer`);
	}
	if (!Number.isSafeInteger(proof.size) || proof.size < 1) {
		throw new Error(`verifyMerkleProofHex: size ${proof.size} is not an integer >= 1`);
	}
	for (const [i, p] of proof.path.entries()) assertHash("verifyMerkleProofHex", `path element ${i}`, p);
	return verifyAuditPath(hexToBytes(hash), proof.index, proof.size, proof.path.map(hexToBytes), hexToBytes(rootHex));
}

/**
 * Verify a hex inclusion proof against an anchored commitment: the hourly root AND the event count
 * the anchor memo (`substrate:v1:<hour>:<root>:<count>`) commits to. True only when
 * `proof.size === commitment.count` and `verifyMerkleProofHex(hash, proof, commitment.rootHex)`.
 *
 * This is the function the anchor verifier MUST use, with the memo's count: the root alone does not
 * authenticate the proof's `size` (see `verifyAuditPath`), so binding `size` to the committed count
 * is what makes the proof's size trustworthy. A malformed shape (non-hex hash, root or path
 * element; non-integer index; proof size below 1; `commitment.count` not a positive safe integer)
 * throws like `verifyMerkleProofHex`; a well-formed proof that does not match returns `false`.
 */
export function verifyMerkleProofAgainstCommitment(
	hash: string,
	proof: { index: number; size: number; path: readonly string[] },
	commitment: { rootHex: string; count: number },
): boolean {
	if (!Number.isSafeInteger(commitment.count) || commitment.count < 1) {
		throw new Error(`verifyMerkleProofAgainstCommitment: count ${commitment.count} is not a positive safe integer`);
	}
	const verified = verifyMerkleProofHex(hash, proof, commitment.rootHex);
	return proof.size === commitment.count && verified;
}

/**
 * SHA-256 over a length-prefixed canonical encoding of `domain` and `parts` (each: uint32
 * big-endian byte length, then the bytes; strings are UTF-8). Two different part lists never
 * collide by concatenation (`["ab","c"]` vs `["a","bc"]`), so a later phase can bind a checkpoint
 * to a chain head and a manifest unambiguously.
 */
export function domainDigestHex(domain: string, parts: readonly (string | Uint8Array)[]): string {
	const encoder = new TextEncoder();
	const hasher = new Bun.CryptoHasher("sha256");
	for (const field of [domain, ...parts]) {
		const bytes = typeof field === "string" ? encoder.encode(field) : field;
		if (bytes.length > UINT32_MAX) throw new Error("domainDigestHex: a part is longer than 2^32-1 bytes");
		const prefix = new Uint8Array(4);
		new DataView(prefix.buffer).setUint32(0, bytes.length, false);
		hasher.update(prefix);
		hasher.update(bytes);
	}
	return bytesToHex(new Uint8Array(hasher.digest()));
}
