import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CORPUS_EMPTY_ROOT, CORPUS_LEAF_DOMAIN, corpusLeafHex, isSha256Hex, leafRefusal, shortRoot } from "./leaf.ts";

const HELLO = createHash("sha256").update("hello").digest("hex");
const ZEROS = "0".repeat(64);
const A64 = "a".repeat(64);

describe("corpusLeafHex", () => {
	test("is pinned to known vectors, so the encoding cannot change without a new domain string", () => {
		expect(corpusLeafHex("swcstudiospace/agent-substrate", "docs/a.md", HELLO)).toBe("72149baea38a9a9b1bb3d909406da63deac9805cc90206705e51c3bc143def18");
		expect(corpusLeafHex("local/notes", "README.md", ZEROS)).toBe("638bd9b75b5a325cae687212dbf01e29ea32663fe3fbee4451a01072f43b5fc3");
		// Multi-byte UTF-8 in the path: the length prefix counts bytes, not characters.
		expect(corpusLeafHex("a/b", "é/ü.md", A64)).toBe("cff1987802dd30ccc1cc867b0684e825cbcce7a6ee5209542985bbd6f56140e1");
		expect(CORPUS_LEAF_DOMAIN).toBe("substrate:corpus:leaf:v1");
	});

	test("the length prefixes keep ('ab','c') and ('a','bc') apart", () => {
		const first = corpusLeafHex("ab", "c", A64);
		const second = corpusLeafHex("a", "bc", A64);
		expect(first).toBe("e93494bf6b494872e917d6fb131b87e99442e5bd62e042ebd8eb2551d8177e40");
		expect(second).toBe("e1e8b92bd54ff5b4199c4d5c7d685db2e5bc5d30e2813242a1f11b914061dd75");
		expect(first).not.toBe(second);
	});

	test("a change to any of the three parts changes the leaf", () => {
		const base = corpusLeafHex("a/b", "c.md", A64);
		expect(corpusLeafHex("a/c", "c.md", A64)).not.toBe(base);
		expect(corpusLeafHex("a/b", "d.md", A64)).not.toBe(base);
		expect(corpusLeafHex("a/b", "c.md", `b${A64.slice(1)}`)).not.toBe(base);
	});

	test("refuses a hash that is not 64 lowercase hex and a name with a lone surrogate, instead of encoding something else", () => {
		expect(() => corpusLeafHex("a/b", "c.md", "ABCD")).toThrow("sha256");
		expect(() => corpusLeafHex("a/b", "c.md", A64.toUpperCase())).toThrow("sha256");
		expect(() => corpusLeafHex("a/b", "bad\ud800.md", A64)).toThrow("well-formed");
		expect(leafRefusal("a/b", "c.md", "short")).toBe("bad-sha256");
		expect(leafRefusal("a/\udc00", "c.md", A64)).toBe("bad-text");
		expect(leafRefusal("a/b", "😀.md", A64)).toBeNull();
	});
});

describe("the empty root and the short form", () => {
	test("the empty manifest's root is the hash of zero bytes", () => {
		expect(CORPUS_EMPTY_ROOT).toBe(createHash("sha256").update("").digest("hex"));
	});

	test("shortRoot is the first 12 hex characters", () => {
		expect(shortRoot("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")).toBe("0123456789ab");
	});

	test("isSha256Hex accepts exactly 64 lowercase hex characters", () => {
		expect([isSha256Hex(A64), isSha256Hex(A64.slice(1)), isSha256Hex(`${A64}0`), isSha256Hex(A64.toUpperCase()), isSha256Hex(7)]).toEqual([true, false, false, false, false]);
	});
});
