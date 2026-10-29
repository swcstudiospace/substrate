/**
 * `substrate corpus prove` and `substrate corpus verify`: the offline verification of a proof file (valid, and each way of
 * tampering with it), its exit codes, the online anchor check and its absence, and what is printed. Proofs are built here from the
 * ledger's own tree functions, independently of the server's code, so a disagreement between the two shows.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { compareEntries, CORPUS_PROTOCOL, corpusLeafHex, type CorpusAnchorResponse, type CorpusAnchorStatus, type CorpusProofResponse } from "@substrate/corpus";
import { defined } from "../../../corpus/src/test-support.ts";
import { merkleRootHex } from "../../../ledger/src/merkle.ts";
import { merkleProofHex } from "../../../ledger/src/merkle-proof.ts";
import { runCorpus } from "./index.ts";
import { conflictWith, MAX_PROOF_FILE_BYTES, verifyProofOffline } from "./proof.ts";
import { CorpusStub } from "./testkit.ts";

const stub = new CorpusStub();
afterAll(() => stub.stop());
beforeEach(() => {
	stub.seen = [];
	stub.routes.clear();
});

const REPO = "Acme/Alpha";

interface Doc {
	repo: string;
	path: string;
	sha256: string;
}

function docs(count: number): Doc[] {
	return Array.from({ length: count }, (_, index) => ({ repo: REPO, path: `docs/doc-${index}.md`, sha256: `${index.toString(16).padStart(2, "0")}${"ab".repeat(31)}` }));
}

/** The proof of `docs[target]` as the server would give it, built straight from the ledger's functions. */
function proofOf(all: readonly Doc[], target: number): CorpusProofResponse {
	const sorted = [...all].sort(compareEntries);
	const leaves = sorted.map((doc) => corpusLeafHex(doc.repo, doc.path, doc.sha256));
	const chosen = defined(sorted[target], "the proven document");
	const { index, size, path } = merkleProofHex(leaves, target);
	return {
		protocol: CORPUS_PROTOCOL,
		repo: chosen.repo,
		documentPath: chosen.path,
		sha256: chosen.sha256,
		leaf: defined(leaves[target], "leaf"),
		index,
		treeSize: size,
		path,
		root: merkleRootHex(leaves),
		manifestVersion: 11,
	};
}

function flip(hex: string): string {
	return `${hex.slice(0, -1)}${hex.endsWith("0") ? "1" : "0"}`;
}

describe("verifyProofOffline", () => {
	test("accepts the proof of every document of trees of 1, 2, 3, 5 and 8, at the first, middle and last index", () => {
		for (const size of [1, 2, 3, 5, 8]) {
			const all = docs(size);
			for (const target of new Set([0, Math.floor(size / 2), size - 1])) expect({ size, target, verdict: verifyProofOffline(proofOf(all, target)) }).toEqual({ size, target, verdict: { valid: true } });
		}
	});

	test("rejects a changed repo, path or hash: the leaf is no longer the document's", () => {
		const proof = proofOf(docs(5), 2);
		for (const changed of [{ repo: "Acme/Other" }, { documentPath: "docs/other.md" }, { sha256: "cd".repeat(32) }]) {
			const verdict = verifyProofOffline({ ...proof, ...changed });
			expect(verdict).toMatchObject({ valid: false });
			expect(verdict.valid === false && verdict.reason).toContain("leaf");
		}
	});

	test("rejects a changed leaf, sibling, root or index even when the document fields are untouched", () => {
		const proof = proofOf(docs(5), 2);
		const sibling = defined(proof.path[0], "first sibling");
		const variants: Array<Partial<CorpusProofResponse>> = [
			{ leaf: flip(proof.leaf) },
			{ path: [flip(sibling), ...proof.path.slice(1)] },
			{ path: proof.path.slice(1) },
			{ root: flip(proof.root) },
			{ index: 3 },
		];
		for (const changed of variants) expect({ changed, valid: verifyProofOffline({ ...proof, ...changed }).valid }).toEqual({ changed, valid: false });
	});

	test("a malformed file is an invalid proof with a reason, never a throw", () => {
		const proof = proofOf(docs(3), 1);
		const malformed: Array<Partial<CorpusProofResponse>> = [{ sha256: "NOT-HEX" }, { path: ["not hex"] }, { root: "short" }, { treeSize: 0 }, { index: 99 }];
		for (const changed of malformed) {
			const verdict = verifyProofOffline({ ...proof, ...changed });
			expect({ changed, valid: verdict.valid }).toEqual({ changed, valid: false });
		}
	});
});

function anchorOf(proof: CorpusProofResponse, status: CorpusAnchorStatus, over: Partial<CorpusAnchorResponse> = {}): CorpusAnchorResponse {
	return {
		protocol: CORPUS_PROTOCOL,
		root: proof.root,
		status,
		reasons: [],
		eventId: "evt_root",
		count: proof.treeSize,
		manifestVersion: proof.manifestVersion,
		hourStart: "2026-10-20T10:00:00.000Z",
		evidence:
			status === "anchored"
				? { anchoredRoot: "11".repeat(32), hourEventCount: 9, eventHash: "22".repeat(32), leafIndex: 2, hourProof: ["33".repeat(32)], signature: `5${"a".repeat(87)}`, slot: 4321, signer: "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo", blockTimeMs: 1_800_000_000_000, finality: "finalized" }
				: null,
		...over,
	};
}

describe("conflictWith", () => {
	const proof = proofOf(docs(4), 1);

	test("unanchored, pending and unverified do not contradict a proof that holds", () => {
		for (const status of ["anchored", "unanchored", "pending", "unverified"] as const) expect({ status, conflict: conflictWith(proof, anchorOf(proof, status)) }).toEqual({ status, conflict: null });
	});

	test("a mismatch, another root or a different document count does", () => {
		expect(conflictWith(proof, anchorOf(proof, "mismatch"))).toContain("disagree");
		expect(conflictWith(proof, anchorOf(proof, "anchored", { root: flip(proof.root) }))).toContain("different root");
		expect(conflictWith(proof, anchorOf(proof, "anchored", { count: proof.treeSize + 1 }))).toContain("covers");
		expect(conflictWith(proof, anchorOf(proof, "unanchored", { count: null }))).toBeNull();
	});
});

interface Run {
	code: number;
	out: string;
	err: string;
	written: Map<string, string>;
}

async function run(argv: string[], options: { files?: Record<string, string>; url?: string } = {}): Promise<Run> {
	const out: string[] = [];
	const err: string[] = [];
	const written = new Map<string, string>();
	const files = options.files ?? {};
	const code = await runCorpus(argv, {
		url: options.url ?? stub.url,
		token: "tok-1",
		timeoutMs: 2000,
		env: {},
		out: (text) => out.push(text),
		err: (text) => err.push(text),
		readFile: (path) => {
			const text = files[path];
			if (text === undefined) throw new Error(`ENOENT: no such file ${path}`);
			return new TextEncoder().encode(text);
		},
		writeFile: (path, text) => void written.set(path, text),
	});
	return { code, out: out.join(""), err: err.join(""), written };
}

const FILE = "proof.json";
const asFile = (proof: unknown): Record<string, string> => ({ [FILE]: JSON.stringify(proof) });

describe("substrate corpus verify, offline", () => {
	test("a valid proof file exits 0 and says valid, asking no server", async () => {
		const result = await run(["verify", FILE], { files: asFile(proofOf(docs(5), 3)) });
		expect(result.code).toBe(0);
		expect(result.out).toContain("proof: valid");
		expect(result.out).toContain("anchor: not checked");
		expect(result.out).toContain("result: valid");
		expect(stub.seen).toEqual([]);
	});

	test("each tampering of the file exits 1 and says invalid", async () => {
		const proof = proofOf(docs(5), 3);
		const sibling = defined(proof.path[1], "sibling");
		const tampered: unknown[] = [
			{ ...proof, documentPath: "docs/forged.md" },
			{ ...proof, sha256: "cd".repeat(32) },
			{ ...proof, leaf: flip(proof.leaf) },
			{ ...proof, path: proof.path.map((step) => (step === sibling ? flip(step) : step)) },
			{ ...proof, root: flip(proof.root) },
			{ notAProof: true },
		];
		for (const file of tampered) {
			const result = await run(["verify", FILE], { files: asFile(file) });
			expect({ file, code: result.code }).toEqual({ file, code: 1 });
		}
		const printed = await run(["verify", FILE], { files: asFile({ ...proof, root: flip(proof.root) }) });
		expect(printed.out).toContain("INVALID");
		expect(printed.out).toContain("result: invalid");
	});

	test("usage errors exit 2: no file, two files, a file that cannot be read, a file that is not JSON", async () => {
		expect((await run(["verify"])).code).toBe(2);
		expect((await run(["verify", "a.json", "b.json"])).code).toBe(2);
		const missing = await run(["verify", "nowhere.json"]);
		expect(missing.code).toBe(2);
		expect(missing.err).toContain("cannot read");
		const text = await run(["verify", FILE], { files: { [FILE]: "{ not json" } });
		expect(text.code).toBe(2);
		expect(text.err).toContain("not JSON");
		const huge = await run(["verify", FILE], { files: { [FILE]: "x".repeat(MAX_PROOF_FILE_BYTES + 1) } });
		expect(huge.code).toBe(2);
		expect(huge.err).toContain("larger than");
	});

	test("a name or path with control characters is printed escaped, never raw", async () => {
		const hostile = "docs/\u001b[2J\u0007bell\u2028line.md";
		const all = docs(3).map((doc, index) => (index === 1 ? { ...doc, path: hostile } : doc));
		const proof = proofOf(all, [...all].sort(compareEntries).findIndex((doc) => doc.path === hostile));
		const result = await run(["verify", FILE], { files: asFile(proof) });
		expect(result.code).toBe(0);
		expect(result.out).not.toContain("\u001b");
		expect(result.out).not.toContain("\u0007");
		expect(result.out).not.toContain("\u2028");
		expect(result.out).toContain("\\x1b[2J\\x07bell\\u2028line.md");
	});

	test("--json carries the verdict as data", async () => {
		const result = await run(["verify", FILE, "--json"], { files: asFile(proofOf(docs(2), 0)) });
		expect(JSON.parse(result.out)).toMatchObject({ valid: true, offline: { valid: true }, online: false, anchor: null });
	});
});

describe("substrate corpus verify --online", () => {
	test("asks the server for the root's anchor and prints the hour and the transaction when it is anchored", async () => {
		const proof = proofOf(docs(5), 3);
		stub.on("GET /corpus/anchor", () => ({ status: 200, body: anchorOf(proof, "anchored") }));
		const result = await run(["verify", FILE, "--online"], { files: asFile(proof) });
		expect(result.code).toBe(0);
		expect(result.out).toContain("anchor: anchored");
		expect(result.out).toContain("hour: 2026-10-20T10:00:00.000Z");
		expect(result.out).toContain(`transaction: 5${"a".repeat(87)} (slot 4321)`);
		expect(defined(stub.seen[0]).search).toBe(`?root=${proof.root}`);
		expect(defined(stub.seen[0]).authorization).toBe("Bearer tok-1");
	});

	test("unanchored is an answer, not a failure: exit 0, said plainly", async () => {
		const proof = proofOf(docs(3), 0);
		stub.on("GET /corpus/anchor", () => ({ status: 200, body: anchorOf(proof, "unanchored", { reasons: ["no root event carries this root"], eventId: null, count: null, manifestVersion: null, hourStart: null }) }));
		const result = await run(["verify", FILE, "--online"], { files: asFile(proof) });
		expect(result.code).toBe(0);
		expect(result.out).toContain("anchor: unanchored");
		expect(result.out).toContain("no root event carries this root");
	});

	test("a mismatch, or a recorded root event with another document count, makes the result invalid", async () => {
		const proof = proofOf(docs(5), 3);
		stub.on("GET /corpus/anchor", () => ({ status: 200, body: anchorOf(proof, "mismatch") }));
		expect((await run(["verify", FILE, "--online"], { files: asFile(proof) })).code).toBe(1);
		stub.on("GET /corpus/anchor", () => ({ status: 200, body: anchorOf(proof, "anchored", { count: 6 }) }));
		const counted = await run(["verify", FILE, "--online"], { files: asFile(proof) });
		expect(counted.code).toBe(1);
		expect(counted.out).toContain("contradicts the proof");
	});

	test("with no server the offline result stands and the anchor check is reported skipped", async () => {
		const proof = proofOf(docs(3), 2);
		const result = await run(["verify", FILE, "--online"], { files: asFile(proof), url: "http://127.0.0.1:1" });
		expect(result.code).toBe(0);
		expect(result.out).toContain("proof: valid");
		expect(result.out).toContain("anchor: check skipped");
		stub.on("GET /corpus/anchor", () => ({ status: 503, body: { reason: "corpus.disabled" } }));
		const refused = await run(["verify", FILE, "--online"], { files: asFile(proof) });
		expect(refused.code).toBe(0);
		expect(refused.out).toContain("anchor: check skipped");
	});

	test("an invalid proof is not sent to the server at all", async () => {
		const proof = proofOf(docs(3), 2);
		const result = await run(["verify", FILE, "--online"], { files: asFile({ ...proof, root: flip(proof.root) }) });
		expect(result.code).toBe(1);
		expect(result.out).toContain("the proof is invalid, so the server was not asked");
		expect(stub.seen).toEqual([]);
	});
});

describe("substrate corpus prove", () => {
	test("asks for the proof by repo and path, prints it, and writes it with --out", async () => {
		const proof = proofOf(docs(5), 2);
		stub.on("GET /corpus/proof", () => ({ status: 200, body: proof }));
		const result = await run(["prove", "--repo", REPO, "--path", "docs/a b.md", "--out", "out.json"]);
		expect(result.code).toBe(0);
		expect(defined(stub.seen[0]).search).toBe("?repo=Acme%2FAlpha&path=docs%2Fa+b.md");
		expect(JSON.parse(result.out)).toEqual(proof);
		expect(JSON.parse(defined(result.written.get("out.json"), "the written file"))).toEqual(proof);
		// What prove wrote is what verify accepts.
		expect((await run(["verify", "out.json"], { files: { "out.json": defined(result.written.get("out.json")) } })).code).toBe(0);
	});

	test("without --out nothing is written", async () => {
		stub.on("GET /corpus/proof", () => ({ status: 200, body: proofOf(docs(2), 1) }));
		const result = await run(["prove", "--repo", REPO, "--path", "docs/doc-1.md"]);
		expect(result.code).toBe(0);
		expect(result.written.size).toBe(0);
	});

	test("a proof the server gives that does not verify is reported and not written", async () => {
		const proof = proofOf(docs(5), 2);
		stub.on("GET /corpus/proof", () => ({ status: 200, body: { ...proof, root: flip(proof.root) } }));
		const result = await run(["prove", "--repo", REPO, "--path", "docs/doc-2.md", "--out", "out.json"]);
		expect(result.code).toBe(1);
		expect(result.err).toContain("does not verify");
		expect(result.written.size).toBe(0);
		expect(result.out).toBe("");
	});

	test("a document the server does not hold, a refusal and a missing flag each end non-zero with a reason", async () => {
		stub.on("GET /corpus/proof", () => ({ status: 404, body: { error: "no active document has this repository and path", reason: "not-in-corpus" } }));
		const missing = await run(["prove", "--repo", REPO, "--path", "docs/none.md"]);
		expect(missing.code).toBe(1);
		expect(missing.err).toContain("no active document");
		expect((await run(["prove", "--repo", REPO])).code).toBe(2);
		expect((await run(["prove", "--path", "docs/a.md"])).code).toBe(2);
	});
});
