/**
 * RFC 6962 Merkle Tree Hash (D-10), the one tree the anchor job and verify share.
 *
 * leaf = SHA256(0x00 ‖ leaf bytes), node = SHA256(0x01 ‖ left ‖ right); n leaves split at the
 * largest power of two strictly below n, so an odd last leaf is promoted, never duplicated. The
 * 0x00/0x01 prefixes keep a leaf from ever hashing like an interior node (second-preimage).
 */

const LEAF_PREFIX = Uint8Array.of(0x00);
const NODE_PREFIX = Uint8Array.of(0x01);
const HASH_HEX_RE = /^[0-9a-f]{64}$/;

export function sha256(...parts: Uint8Array[]): Uint8Array {
	const hasher = new Bun.CryptoHasher("sha256");
	for (const part of parts) hasher.update(part);
	return new Uint8Array(hasher.digest());
}

/** The Merkle Tree Hash of `leaves` (any lengths; Phase 6 feeds 32-byte event hashes). Empty input throws. */
export function merkleRoot(leaves: readonly Uint8Array[]): Uint8Array {
	if (leaves.length === 0) throw new Error("merkleRoot: empty input (an empty hour is never anchored)");
	if (leaves.length === 1) return sha256(LEAF_PREFIX, leaves[0] as Uint8Array);
	let k = 1;
	while (k * 2 < leaves.length) k *= 2;
	return sha256(NODE_PREFIX, merkleRoot(leaves.slice(0, k)), merkleRoot(leaves.slice(k)));
}

/** Lowercase hex only, even length. */
export function hexToBytes(hex: string): Uint8Array {
	if (hex.length % 2 !== 0) throw new Error(`hexToBytes: odd length ${hex.length}`);
	if (!/^[0-9a-f]*$/.test(hex)) throw new Error("hexToBytes: not lowercase hex");
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

export function bytesToHex(bytes: Uint8Array): string {
	let hex = "";
	for (const b of bytes) hex += b.toString(16).padStart(2, "0");
	return hex;
}

/** Root over 64-hex event hashes, as lowercase hex. Any entry that is not exactly 64 lowercase hex throws. */
export function merkleRootHex(hashes: readonly string[]): string {
	for (const [i, h] of hashes.entries()) {
		if (!HASH_HEX_RE.test(h)) throw new Error(`merkleRootHex: entry ${i} is not 64 lowercase hex characters`);
	}
	return bytesToHex(merkleRoot(hashes.map(hexToBytes)));
}
