import { describe, expect, test } from "bun:test";
import { bytesToHex, hexToBytes, merkleRoot, merkleRootHex } from "./merkle.ts";
import {
	domainDigestHex,
	merkleAuditPath,
	merkleProofHex,
	verifyAuditPath,
	verifyMerkleProofAgainstCommitment,
	verifyMerkleProofHex,
} from "./merkle-proof.ts";

/** Deterministic 64-hex event hashes: SHA-256 of a fixed-seed label, never random. */
function hashes(n: number): string[] {
	return Array.from({ length: n }, (_, i) => new Bun.CryptoHasher("sha256").update(`seed-v1:${i}`).digest("hex"));
}

/** RFC 6962 audit path length, derived from the split rule independently of the implementation. */
function expectedPathLength(index: number, size: number): number {
	if (size === 1) return 0;
	let k = 1;
	while (k * 2 < size) k *= 2;
	return 1 + (index < k ? expectedPathLength(index, k) : expectedPathLength(index - k, size - k));
}

function flip(hex: string): string {
	return (hex[0] === "0" ? "1" : "0") + hex.slice(1);
}

describe("merkleAuditPath / verifyAuditPath (RFC 6962 2.1.1, RFC 9162 2.1.3)", () => {
	test("every index of every size 1..40 verifies against merkleRootHex, with the RFC path length", () => {
		for (let size = 1; size <= 40; size++) {
			const set = hashes(size);
			const root = merkleRootHex(set);
			for (let index = 0; index < size; index++) {
				const proof = merkleProofHex(set, index);
				expect(proof.index).toBe(index);
				expect(proof.size).toBe(size);
				expect(proof.path.length).toBe(expectedPathLength(index, size));
				expect(proof.path.length).toBeLessThanOrEqual(Math.ceil(Math.log2(size)));
				expect(verifyMerkleProofHex(set[index] as string, proof, root)).toBe(true);
			}
		}
	});

	test("a power-of-two tree has paths of exactly log2(n)", () => {
		for (const size of [1, 2, 4, 8, 16, 32]) {
			for (let index = 0; index < size; index++) {
				expect(merkleProofHex(hashes(size), index).path.length).toBe(Math.log2(size));
			}
		}
	});

	test("size 1 yields an empty path and verifies against the one-leaf root", () => {
		const set = hashes(1);
		const proof = merkleProofHex(set, 0);
		expect(proof.path).toEqual([]);
		expect(verifyMerkleProofHex(set[0] as string, proof, merkleRootHex(set))).toBe(true);
	});

	test("the last leaf of an odd size is promoted, never duplicated", () => {
		const set = hashes(7);
		const root = merkleRootHex(set);
		const proof = merkleProofHex(set, 6);
		// 7 leaves split 4 + 3, then 3 splits 2 + 1: leaf 6 is the lone right child, so its path is
		// [root of leaves 4..5, root of leaves 0..3] and it is hashed once, never paired with itself.
		expect(proof.path.length).toBe(2);
		expect(verifyMerkleProofHex(set[6] as string, proof, root)).toBe(true);
		// A duplicated-last-leaf tree has a different root, so a path built that way must not verify.
		const duplicated = merkleRootHex([...set, set[6] as string]);
		expect(duplicated).not.toBe(root);
		expect(verifyMerkleProofHex(set[6] as string, proof, duplicated)).toBe(false);
		// The sibling of a lone promoted leaf is never the leaf itself.
		expect(proof.path).not.toContain(bytesToHex(merkleRoot([hexToBytes(set[6] as string)])));
	});

	test("the byte API round-trips for arbitrary leaf lengths", () => {
		const leaves = ["", "00", "10", "2021", "3031", "40414243"].map(hexToBytes);
		const root = merkleRoot(leaves);
		for (const [index, leaf] of leaves.entries()) {
			expect(verifyAuditPath(leaf, index, leaves.length, merkleAuditPath(leaves, index), root)).toBe(true);
		}
	});

	test("verification fails for a flipped leaf, a flipped path element, a wrong index, a different root", () => {
		const size = 13;
		const set = hashes(size);
		const root = merkleRootHex(set);
		for (let index = 0; index < size; index++) {
			const proof = merkleProofHex(set, index);
			const hash = set[index] as string;
			expect(verifyMerkleProofHex(flip(hash), proof, root)).toBe(false);
			for (let i = 0; i < proof.path.length; i++) {
				const path = proof.path.map((p, j) => (j === i ? flip(p) : p));
				expect(verifyMerkleProofHex(hash, { ...proof, path }, root)).toBe(false);
			}
			expect(verifyMerkleProofHex(hash, { ...proof, index: (index + 1) % size }, root)).toBe(false);
			expect(verifyMerkleProofHex(hash, { ...proof, index: size + index }, root)).toBe(false);
			expect(verifyMerkleProofHex(hash, proof, flip(root))).toBe(false);
			expect(verifyMerkleProofHex(hash, proof, merkleRootHex(hashes(size + 1)))).toBe(false);
		}
	});

	test("a raw proof does not authenticate its size", () => {
		const size = 13;
		const set = hashes(size);
		const root = merkleRootHex(set);
		// RFC 9162 verification consumes the path with a bit-shift recipe driven by (index, size). Index 0
		// takes four steps for both 13 and 14 leaves, so the same path yields the same root under either
		// size: the root commits to the contents, not to its own size.
		const first = merkleProofHex(set, 0);
		expect(verifyMerkleProofHex(set[0] as string, { ...first, size: 14 }, root)).toBe(true);
		// The size therefore has to be bound to a trusted count, which is what the commitment verifier does.
		for (let index = 0; index < size; index++) {
			const proof = merkleProofHex(set, index);
			const hash = set[index] as string;
			for (const wrong of [size - 1, size + 1, size * 2]) {
				expect(verifyMerkleProofAgainstCommitment(hash, { ...proof, size: wrong }, { rootHex: root, count: size })).toBe(false);
			}
		}
	});

	test("a claimed size that changes the step shape for the index fails the raw verifier", () => {
		let shapeChanges = 0;
		for (const size of [1, 2, 5, 8, 13, 16, 17, 40]) {
			const set = hashes(size);
			const root = merkleRootHex(set);
			for (let index = 0; index < size; index++) {
				const proof = merkleProofHex(set, index);
				const hash = set[index] as string;
				for (let claimed = 1; claimed <= 64; claimed++) {
					if (index < claimed && expectedPathLength(index, claimed) === proof.path.length) continue;
					shapeChanges++;
					expect(verifyMerkleProofHex(hash, { ...proof, size: claimed }, root)).toBe(false);
				}
			}
		}
		expect(shapeChanges).toBeGreaterThan(0);
	});

	test("the commitment verifier accepts the matching count for every size and index, and rejects a flipped root", () => {
		for (let size = 1; size <= 40; size++) {
			const set = hashes(size);
			const root = merkleRootHex(set);
			for (let index = 0; index < size; index++) {
				const proof = merkleProofHex(set, index);
				const hash = set[index] as string;
				expect(verifyMerkleProofAgainstCommitment(hash, proof, { rootHex: root, count: size })).toBe(true);
				expect(verifyMerkleProofAgainstCommitment(hash, proof, { rootHex: flip(root), count: size })).toBe(false);
			}
		}
	});

	test("the commitment verifier rejects a malformed count", () => {
		const set = hashes(4);
		const root = merkleRootHex(set);
		const proof = merkleProofHex(set, 1);
		for (const count of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
			expect(() => verifyMerkleProofAgainstCommitment(set[1] as string, proof, { rootHex: root, count })).toThrow(/count/);
		}
	});

	test("a truncated or extended path never verifies", () => {
		for (const size of [2, 5, 8, 13, 40]) {
			const set = hashes(size);
			const root = merkleRootHex(set);
			for (let index = 0; index < size; index++) {
				const proof = merkleProofHex(set, index);
				const hash = set[index] as string;
				expect(verifyMerkleProofHex(hash, { ...proof, path: proof.path.slice(0, -1) }, root)).toBe(false);
				expect(verifyMerkleProofHex(hash, { ...proof, path: [...proof.path, proof.path[0] as string] }, root)).toBe(false);
				expect(verifyMerkleProofHex(hash, { ...proof, path: [...proof.path, "00".repeat(32)] }, root)).toBe(false);
			}
		}
	});

	test("a leaf is not a valid interior node: a one-leaf proof does not verify a multi-leaf root", () => {
		const set = hashes(2);
		expect(verifyMerkleProofHex(set[0] as string, { index: 0, size: 1, path: [] }, merkleRootHex(set))).toBe(false);
	});

	test("rejects malformed input like merkleRootHex does", () => {
		const set = hashes(4);
		const root = merkleRootHex(set);
		expect(() => merkleAuditPath([], 0)).toThrow(/empty input/);
		expect(() => merkleAuditPath(set.map(hexToBytes), 4)).toThrow(/out of range/);
		expect(() => merkleAuditPath(set.map(hexToBytes), -1)).toThrow(/out of range/);
		expect(() => merkleAuditPath(set.map(hexToBytes), 1.5)).toThrow(/out of range/);
		expect(() => merkleProofHex([], 0)).toThrow(/empty input/);
		expect(() => merkleProofHex([...set, "XYZ"], 0)).toThrow(/entry 4 is not 64 lowercase hex/);
		expect(() => merkleProofHex([set[0]?.toUpperCase() as string], 0)).toThrow(/entry 0 is not 64 lowercase hex/);
		expect(() => merkleProofHex(set, 4)).toThrow(/out of range/);
		const proof = merkleProofHex(set, 1);
		expect(() => verifyMerkleProofHex("nothex", proof, root)).toThrow(/hash is not 64 lowercase hex/);
		expect(() => verifyMerkleProofHex(set[1] as string, proof, "ab")).toThrow(/root is not 64 lowercase hex/);
		expect(() => verifyMerkleProofHex(set[1] as string, { ...proof, path: ["zz"] }, root)).toThrow(/path element 0/);
		expect(() => verifyMerkleProofHex(set[1] as string, { ...proof, size: 0 }, root)).toThrow(/size 0/);
		expect(() => verifyMerkleProofHex(set[1] as string, { ...proof, index: -1 }, root)).toThrow(/index -1/);
		expect(() => verifyMerkleProofHex(set[1] as string, { ...proof, index: 0.5 }, root)).toThrow(/index 0.5/);
	});
});

describe("domainDigestHex", () => {
	test("is 64 lowercase hex and stable", () => {
		const digest = domainDigestHex("substrate:checkpoint:v1", ["head", "manifest"]);
		expect(digest).toMatch(/^[0-9a-f]{64}$/);
		expect(domainDigestHex("substrate:checkpoint:v1", ["head", "manifest"])).toBe(digest);
	});

	test("part boundaries cannot collide by concatenation", () => {
		expect(domainDigestHex("d", ["ab", "c"])).not.toBe(domainDigestHex("d", ["a", "bc"]));
		expect(domainDigestHex("d", ["a"])).not.toBe(domainDigestHex("d", ["a", ""]));
		expect(domainDigestHex("d", ["", "a"])).not.toBe(domainDigestHex("d", ["a", ""]));
		expect(domainDigestHex("d", [])).not.toBe(domainDigestHex("d", [""]));
	});

	test("different domains give different digests, and a domain is not a part", () => {
		expect(domainDigestHex("one", ["x"])).not.toBe(domainDigestHex("two", ["x"]));
		expect(domainDigestHex("one", ["x"])).not.toBe(domainDigestHex("", ["one", "x"]));
	});

	test("a string part and the same bytes hash alike (UTF-8)", () => {
		expect(domainDigestHex("d", ["héllo"])).toBe(domainDigestHex("d", [new TextEncoder().encode("héllo")]));
	});

	test("matches the documented encoding: uint32 big-endian length then bytes, per field", () => {
		const expected = new Bun.CryptoHasher("sha256")
			.update(Uint8Array.of(0, 0, 0, 1))
			.update("d")
			.update(Uint8Array.of(0, 0, 0, 2))
			.update("ab")
			.digest("hex");
		expect(domainDigestHex("d", ["ab"])).toBe(expected);
	});
});
