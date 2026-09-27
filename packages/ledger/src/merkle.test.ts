import { describe, expect, test } from "bun:test";
import { bytesToHex, hexToBytes, merkleRoot, merkleRootHex } from "./merkle.ts";

// RFC 6962 reference leaves and roots (Trillian / Certificate Transparency test vectors).
const LEAVES = ["", "00", "10", "2021", "3031", "40414243", "5051525354555657", "606162636465666768696a6b6c6d6e6f"].map(
	hexToBytes,
);
const ROOTS = [
	"6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
	"fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125",
	"aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77",
	"d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7",
	"4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4",
	"76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef",
	"ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c",
	"5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328",
];

describe("merkleRoot (RFC 6962)", () => {
	for (const [i, root] of ROOTS.entries()) {
		test(`reference root for n=${i + 1}`, () => {
			expect(bytesToHex(merkleRoot(LEAVES.slice(0, i + 1)))).toBe(root);
		});
	}

	test("empty input throws", () => {
		expect(() => merkleRoot([])).toThrow();
	});

	test("a one-leaf root is not the plain SHA-256 of the leaf (0x00 prefix)", () => {
		const leaf = hexToBytes("ab".repeat(32));
		const plain = new Bun.CryptoHasher("sha256").update(leaf).digest("hex");
		expect(bytesToHex(merkleRoot([leaf]))).not.toBe(plain);
	});

	test("swapping two leaves of four changes the root", () => {
		const four = LEAVES.slice(0, 4);
		const swapped = [four[1], four[0], four[2], four[3]] as Uint8Array[];
		expect(bytesToHex(merkleRoot(swapped))).not.toBe(bytesToHex(merkleRoot(four)));
	});
});

describe("hex helpers", () => {
	test("64 lowercase hex → 32 bytes and back", () => {
		const hex = "0123456789abcdef".repeat(4);
		const bytes = hexToBytes(hex);
		expect(bytes.length).toBe(32);
		expect(bytesToHex(bytes)).toBe(hex);
	});

	test("hexToBytes rejects odd length and non-lowercase-hex characters", () => {
		expect(() => hexToBytes("abc")).toThrow();
		expect(() => hexToBytes("AB")).toThrow();
		expect(() => hexToBytes("zz")).toThrow();
		expect(() => hexToBytes("0x")).toThrow();
	});
});

describe("merkleRootHex", () => {
	const hashes = ["11", "22", "33"].map((b) => b.repeat(32));

	test("equals merkleRoot over the decoded hashes", () => {
		expect(merkleRootHex(hashes)).toBe(bytesToHex(merkleRoot(hashes.map(hexToBytes))));
	});

	test("rejects entries that are not exactly 64 lowercase hex characters", () => {
		expect(() => merkleRootHex(["ab".repeat(31)])).toThrow();
		expect(() => merkleRootHex(["AB".repeat(32)])).toThrow();
		expect(() => merkleRootHex([`${"ab".repeat(32)}00`])).toThrow();
		expect(() => merkleRootHex([...hashes, "g".repeat(64)])).toThrow();
	});
});
