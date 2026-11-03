import { describe, expect, test } from "bun:test";
import { graphIndexAddress } from "./graph-index.ts";
import { bs58decode, bs58encode } from "./rpc.ts";

const PREFIX = "substrate:graph-index:v1\n";

/** SHA-256 of `text`, as bytes, from the runtime hasher: independent of the module under test. */
function sha256Of(text: string): Uint8Array {
	return new Uint8Array(new Bun.CryptoHasher("sha256").update(text).digest());
}

describe("graphIndexAddress", () => {
	test("is deterministic and decodes to exactly 32 bytes", () => {
		expect(graphIndexAddress("graph-a")).toBe(graphIndexAddress("graph-a"));
		expect(bs58decode(graphIndexAddress("graph-a")).length).toBe(32);
	});

	test("is base58 of SHA-256 over the domain prefix and the graph id", () => {
		for (const graphId of ["graph-a", "tenant:team:graph", "line one\nline two", "g".repeat(512)]) {
			expect(graphIndexAddress(graphId)).toBe(bs58encode(sha256Of(`${PREFIX}${graphId}`)));
		}
	});

	test("the prefix is in the hash: the bare id and other prefixes give other addresses", () => {
		const address = graphIndexAddress("graph-a");
		expect(address).not.toBe(bs58encode(sha256Of("graph-a")));
		expect(address).not.toBe(bs58encode(sha256Of("substrate:graph-index:v2\ngraph-a")));
		expect(address).not.toBe(bs58encode(sha256Of("substrate:graph-index:v1graph-a")));
	});

	test("is distinct per graph id, including ids that differ only by a colon, a newline or case", () => {
		const ids = ["graph-a", "graph-b", "graph-a:", "graph-a\n", "Graph-A", "a:b", "a", "graph-a graph-a"];
		const addresses = new Set(ids.map((id) => graphIndexAddress(id)));
		expect(addresses.size).toBe(ids.length);
	});

	test("refuses an empty graph id", () => {
		expect(() => graphIndexAddress("")).toThrow("graphIndexAddress:");
	});
});
