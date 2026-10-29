import { describe, expect, test } from "bun:test";
import { CORPUS_PROTOCOL, MAX_COVERAGE_PAIRS, MAX_INGEST_DOCUMENTS, MAX_INGEST_TOMBSTONES, MAX_PLAN_ENTRIES, type CorpusScope } from "@substrate/corpus";
import { defined } from "../test-support.ts";
import { entryOf, makeDocument } from "./testkit.ts";
import { parseEntry, parseIngestRequest, parsePlanRequest } from "./validate.ts";

const REPO = "swcstudiospace/agent-substrate";
const SCOPE: CorpusScope = { coverage: [{ repo: REPO, source: "fs" }], maxTier: 2 };
const GOOD = entryOf(makeDocument(REPO, "docs/a.md", "text"));

function refusedReason(result: { ok: boolean; reason?: string }): string | undefined {
	return result.ok ? undefined : result.reason;
}

describe("parseEntry refuses with the first closed reason", () => {
	const cases: Array<[string, Record<string, unknown>, string]> = [
		["a repo that is not owner/name", { repo: "nope" }, "bad-repo"],
		["an escaping path", { path: "../x.md" }, "bad-path"],
		["a kind outside the list", { kind: "wiki" }, "bad-kind"],
		["a tier of 4", { tier: 4 }, "bad-tier"],
		["an uppercase sha256", { sha256: "A".repeat(64) }, "bad-sha256"],
		["a short sha256", { sha256: "ab" }, "bad-sha256"],
		["a negative size", { bytes: -1 }, "bad-bytes"],
		["a fractional size", { bytes: 1.5 }, "bad-bytes"],
		["an unknown source", { source: "svn" }, "bad-source"],
		["an empty commit", { commit: "" }, "bad-commit"],
	];
	for (const [label, over, reason] of cases) {
		test(label, () => {
			expect(refusedReason(parseEntry({ ...GOOD, ...over }))).toBe(reason);
		});
	}

	test("a well-formed entry is returned as it is, with or without a commit", () => {
		expect(parseEntry(GOOD)).toEqual({ ok: true, value: GOOD });
		const { commit: _commit, ...noCommit } = GOOD;
		expect(parseEntry(noCommit)).toEqual({ ok: true, value: noCommit });
		expect(refusedReason(parseEntry("a string"))).toBe("bad-request");
	});
});

describe("parsePlanRequest", () => {
	const base = { protocol: CORPUS_PROTOCOL, entries: [GOOD], scope: SCOPE };

	test("a good request parses and de-duplicates the coverage pairs", () => {
		const parsed = parsePlanRequest({
			...base,
			scope: {
				coverage: [
					{ repo: REPO, source: "fs" },
					{ repo: REPO, source: "fs" },
				],
				maxTier: 2,
			},
		});
		expect(parsed.ok && parsed.value.scope).toEqual(SCOPE);
	});

	test("an empty coverage is a valid scope: the entries are planned and nothing is tombstoned", () => {
		const parsed = parsePlanRequest({ ...base, scope: { coverage: [], maxTier: 3 } });
		expect(parsed.ok && parsed.value.scope).toEqual({ coverage: [], maxTier: 3 });
	});

	test("another protocol version and a malformed scope are refused with a closed reason", () => {
		expect(refusedReason(parsePlanRequest({ ...base, protocol: 2 }))).toBe("bad-protocol");
		expect(refusedReason(parsePlanRequest({ ...base, scope: { ...SCOPE, maxTier: 7 } }))).toBe("bad-scope");
		expect(refusedReason(parsePlanRequest({ ...base, scope: { maxTier: 2 } }))).toBe("bad-scope");
		expect(refusedReason(parsePlanRequest({ ...base, scope: { ...SCOPE, coverage: ["a/b"] } }))).toBe("bad-scope");
		expect(refusedReason(parsePlanRequest({ ...base, scope: { ...SCOPE, coverage: [{ repo: "nope", source: "fs" }] } }))).toBe("bad-repo");
		expect(refusedReason(parsePlanRequest({ ...base, scope: { ...SCOPE, coverage: [{ repo: REPO, source: "cvs" }] } }))).toBe("bad-source");
		expect(refusedReason(parsePlanRequest({ ...base, scope: undefined }))).toBe("bad-scope");
	});

	test("the coverage cap is exact: the limit is accepted, one more pair is refused", () => {
		const pairs = (count: number) => Array.from({ length: count }, (_, index) => ({ repo: `acme/r${index}`, source: "fs" }));
		expect(parsePlanRequest({ ...base, scope: { coverage: pairs(MAX_COVERAGE_PAIRS), maxTier: 2 } }).ok).toBe(true);
		expect(refusedReason(parsePlanRequest({ ...base, scope: { coverage: pairs(MAX_COVERAGE_PAIRS + 1), maxTier: 2 } }))).toBe("bad-scope");
	});

	test("more than the entry cap is refused before any entry is read; one bad entry refuses the whole request", () => {
		expect(refusedReason(parsePlanRequest({ ...base, entries: Array.from({ length: MAX_PLAN_ENTRIES + 1 }, () => GOOD) }))).toBe("too-many-entries");
		expect(refusedReason(parsePlanRequest({ ...base, entries: [GOOD, { ...GOOD, path: "../esc.md" }] }))).toBe("bad-path");
	});

	test("the same (repo, path) twice is refused", () => {
		expect(refusedReason(parsePlanRequest({ ...base, entries: [GOOD, GOOD] }))).toBe("duplicate-entry");
	});
});

describe("parseIngestRequest", () => {
	const document = makeDocument(REPO, "docs/a.md", "text");
	const base = { protocol: CORPUS_PROTOCOL, documents: [document], tombstones: [] };

	test("documents and tombstones parse; a missing list is empty", () => {
		const parsed = parseIngestRequest({ protocol: CORPUS_PROTOCOL, tombstones: [{ repo: REPO, path: "docs/old.md" }] });
		expect(parsed.ok && parsed.value).toEqual({ protocol: CORPUS_PROTOCOL, documents: [], tombstones: [{ repo: REPO, path: "docs/old.md" }] });
		expect(parseIngestRequest(base).ok).toBe(true);
	});

	test("an empty request, another protocol and a body that is not text are refused", () => {
		expect(refusedReason(parseIngestRequest({ protocol: CORPUS_PROTOCOL, documents: [], tombstones: [] }))).toBe("empty-request");
		expect(refusedReason(parseIngestRequest({ ...base, protocol: 0 }))).toBe("bad-protocol");
		expect(refusedReason(parseIngestRequest({ ...base, documents: [{ ...document, body: 7 }] }))).toBe("bad-body");
	});

	test("the per-request bounds are exact: the limit is accepted, one more is refused", () => {
		const documents = (count: number) => Array.from({ length: count }, (_, index) => makeDocument(REPO, `docs/${index}.md`, `body ${index}`));
		const tombstones = (count: number) => Array.from({ length: count }, (_, index) => ({ repo: REPO, path: `old/${index}.md` }));
		expect(parseIngestRequest({ ...base, documents: documents(MAX_INGEST_DOCUMENTS) }).ok).toBe(true);
		expect(refusedReason(parseIngestRequest({ ...base, documents: documents(MAX_INGEST_DOCUMENTS + 1) }))).toBe("too-many-documents");
		expect(parseIngestRequest({ ...base, documents: [], tombstones: tombstones(MAX_INGEST_TOMBSTONES) }).ok).toBe(true);
		expect(refusedReason(parseIngestRequest({ ...base, documents: [], tombstones: tombstones(MAX_INGEST_TOMBSTONES + 1) }))).toBe("too-many-tombstones");
	});

	test("a key may appear once across documents and tombstones", () => {
		expect(refusedReason(parseIngestRequest({ ...base, tombstones: [{ repo: REPO, path: "docs/a.md" }] }))).toBe("duplicate-entry");
		expect(refusedReason(parseIngestRequest({ ...base, documents: [document, document] }))).toBe("duplicate-entry");
		const bad = parseIngestRequest({ ...base, tombstones: [{ repo: REPO, path: "/etc/passwd" }] });
		expect(defined(bad.ok ? undefined : bad, "a refusal").reason).toBe("bad-path");
	});
});
