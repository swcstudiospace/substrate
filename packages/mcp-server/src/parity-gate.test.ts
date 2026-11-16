import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { corpusDocumentName } from "@substrate/corpus";
import { parsePartArgs, reasonCategory, runParity } from "./parity-run.ts";
import type { FetchLike } from "./planes/lightrag.ts";
import {
	checkRecordMapping,
	citationMatches,
	flattenedNameMatches,
	FROZEN_SAMPLE,
	manifestRecords,
	type ManifestRecord,
	type PlaneDocument,
	runSample,
	type SampleQuery,
} from "./parity-gate.ts";

const REPO = "swcstudiospace/agent-substrate";
const SHA = "0123456789abcdef".repeat(4);

/** A record and its plane document, as a matched pair: the baseline every Part A case changes one field of. */
function pair(id: string, path: string): { record: ManifestRecord; document: PlaneDocument } {
	return {
		record: { documentId: id, datasetId: REPO, sourceUrl: path, sha: SHA },
		document: { id, name: corpusDocumentName(REPO, path, SHA) },
	};
}

const CLEAN = [pair("doc-1", "docs/a.md"), pair("doc-2", "docs/b.md")];

function mapping(pairs: Array<{ record: ManifestRecord; document: PlaneDocument }>, extra: PlaneDocument[] = []) {
	return checkRecordMapping(
		pairs.map((entry) => entry.record),
		[...pairs.map((entry) => entry.document), ...extra],
		false,
	);
}

describe("Part A record mapping", () => {
	test("zero mismatches between the records and the plane passes", () => {
		const result = mapping(CLEAN);
		expect(result).toEqual({ ok: true, records: 2, documents: 2, mismatches: [] });
	});

	test("a record whose document is missing from the plane is a mismatch", () => {
		const records = CLEAN.map((entry) => entry.record).concat({ documentId: "doc-9", datasetId: REPO, sourceUrl: "docs/z.md", sha: SHA });
		const result = checkRecordMapping(records, CLEAN.map((entry) => entry.document), false);
		expect(result.ok).toBe(false);
		expect(result.mismatches).toEqual([{ kind: "record-without-document", documentId: "doc-9" }]);
	});

	test("a record with no resolved document id is a mismatch, not a silent skip", () => {
		const records = [{ documentId: "", datasetId: REPO, sourceUrl: "docs/a.md", sha: SHA }];
		const result = checkRecordMapping(records, [pair("doc-1", "docs/a.md").document], false);
		expect(result.ok).toBe(false);
		expect(result.mismatches).toEqual([
			{ kind: "record-without-document", documentId: "" },
			{ kind: "document-without-record", id: "doc-1" },
		]);
	});

	test("a changed source URL is a source-url mismatch", () => {
		const changed = pair("doc-1", "docs/a.md");
		changed.record = { ...changed.record, sourceUrl: "docs/renamed.md" };
		const result = mapping([changed, pair("doc-2", "docs/b.md")]);
		expect(result.ok).toBe(false);
		expect(result.mismatches).toEqual([{ kind: "source-url-mismatch", id: "doc-1" }]);
	});

	test("a changed version is a version mismatch", () => {
		const changed = pair("doc-1", "docs/a.md");
		changed.record = { ...changed.record, sha: "f".repeat(64) };
		const result = mapping([changed, pair("doc-2", "docs/b.md")]);
		expect(result.mismatches).toEqual([{ kind: "version-mismatch", id: "doc-1" }]);
	});

	test("a dataset that differs from the document's repo is a dataset mismatch", () => {
		const changed = pair("doc-1", "docs/a.md");
		changed.record = { ...changed.record, datasetId: "someone-else/repo" };
		const result = mapping([changed, pair("doc-2", "docs/b.md")]);
		expect(result.mismatches).toEqual([{ kind: "dataset-mismatch", id: "doc-1" }]);
	});

	test("a file:// source URL matches its corpus document by the trailing repo path", () => {
		const record: ManifestRecord = { documentId: "doc-1", datasetId: REPO, sourceUrl: "file:///srv/checkout/docs/a.md", sha: SHA };
		const result = mapping([{ record, document: { id: "doc-1", name: corpusDocumentName(REPO, "docs/a.md", SHA) } }, pair("doc-2", "docs/b.md")]);
		expect(result).toEqual({ ok: true, records: 2, documents: 2, mismatches: [] });
	});

	test("a file:// source matches on whole path segments: a file under xdocs/ is a source-url mismatch", () => {
		const record: ManifestRecord = { documentId: "doc-1", datasetId: REPO, sourceUrl: "file:///srv/checkout/xdocs/a.md", sha: SHA };
		const result = mapping([{ record, document: { id: "doc-1", name: corpusDocumentName(REPO, "docs/a.md", SHA) } }, pair("doc-2", "docs/b.md")]);
		expect(result.mismatches).toEqual([{ kind: "source-url-mismatch", id: "doc-1" }]);
	});

	test("a flattened ingest name confirms its record's path but not dataset or version, and a different path is a source mismatch", () => {
		const record: ManifestRecord = { documentId: "doc-1", datasetId: REPO, sourceUrl: "file:///srv/checkout/docs/a.md", sha: SHA };
		expect(flattenedNameMatches(record.sourceUrl, "docs__a.md")).toBe(true);
		expect(flattenedNameMatches("docs/a.md", "docs__a.md")).toBe(true);
		expect(flattenedNameMatches("file:///srv/checkout/docs/b.md", "docs__a.md")).toBe(false);
		expect(flattenedNameMatches("file:///srv/checkout/xdocs/a.md", "docs__a.md")).toBe(false);
		const matched = checkRecordMapping([record], [{ id: "doc-1", name: "docs__a.md" }], false);
		expect(matched.mismatches).toEqual([{ kind: "unverifiable-name", id: "doc-1" }]);
		const moved = checkRecordMapping([{ ...record, sourceUrl: "file:///srv/checkout/docs/b.md" }], [{ id: "doc-1", name: "docs__a.md" }], false);
		expect(moved.mismatches).toEqual([
			{ kind: "source-url-mismatch", id: "doc-1" },
			{ kind: "unverifiable-name", id: "doc-1" },
		]);
	});

	test("a stale plane document no record references is an extra mismatch", () => {
		const result = mapping(CLEAN, [{ id: "doc-stale", name: corpusDocumentName(REPO, "docs/old.md", SHA) }]);
		expect(result.ok).toBe(false);
		expect(result.mismatches).toEqual([{ kind: "document-without-record", id: "doc-stale" }]);
	});

	test("a plane name that is not a corpus name is refused as unparseable", () => {
		const result = checkRecordMapping(
			[CLEAN[0]?.record as ManifestRecord],
			[{ id: "doc-1", name: "corpus:not-a-valid-name" }],
			false,
		);
		expect(result.mismatches).toEqual([{ kind: "unparseable-name", id: "doc-1" }]);
	});

	test("a truncated listing fails closed, because a missing document proves nothing", () => {
		const result = checkRecordMapping(
			CLEAN.map((entry) => entry.record),
			CLEAN.map((entry) => entry.document),
			true,
		);
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/truncated/);
	});

	test("an empty record set fails closed rather than passing an empty comparison", () => {
		const result = checkRecordMapping([], [], false);
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/no lightrag records/);
	});
});

describe("manifestRecords", () => {
	test("keeps only lightrag:: keys and reads the fields the mapping needs", () => {
		const state = {
			version: 2,
			records: {
				"lightrag::ds::docs/a.md": { document_id: "doc-1", dataset_id: "ds", source_url: "docs/a.md", sha: SHA, version: 1 },
				"retired::ds::docs/a.md": { document_id: "old", dataset_id: "ds", source_url: "docs/a.md", sha: SHA, version: 1 },
			},
		};
		expect(manifestRecords(state)).toEqual([{ documentId: "doc-1", datasetId: "ds", sourceUrl: "docs/a.md", sha: SHA }]);
	});

	test("a malformed lightrag record is kept with empty fields, so it surfaces as a mismatch", () => {
		const records = manifestRecords({ records: { "lightrag::ds::x": "not-an-object" } });
		expect(records).toEqual([{ documentId: "", datasetId: "", sourceUrl: "", sha: "" }]);
	});

	test("no records table is null, not an empty list", () => {
		expect(manifestRecords({ version: 2 })).toBeNull();
		expect(manifestRecords(null)).toBeNull();
	});
});

describe("Part B sample", () => {
	const SAMPLE_TWO: SampleQuery[] = [
		{ id: "A", question: "a?", expectedSource: "docs/a.md" },
		{ id: "B", question: "b?", expectedSource: "docs/b.md" },
	];

	test("a pass at the threshold is ok: 9 of 10 meets a 0.9 threshold", async () => {
		const sample: SampleQuery[] = Array.from({ length: 10 }, (_, index) => ({ id: `Q${index}`, question: `q${index}`, expectedSource: `docs/d${index}.md` }));
		const result = await runSample(sample, async (question) => {
			const index = Number(question.slice(1));
			return { ok: true, sources: [corpusDocumentName(REPO, index === 0 ? "docs/other.md" : `docs/d${index}.md`, SHA)] };
		}, 0.9);
		expect(result).toMatchObject({ ok: true, queries: 10, passes: 9, rate: 0.9, threshold: 0.9 });
	});

	test("one miss below a 100 percent threshold fails the gate", async () => {
		const sample: SampleQuery[] = Array.from({ length: 10 }, (_, index) => ({ id: `Q${index}`, question: `q${index}`, expectedSource: `docs/d${index}.md` }));
		const result = await runSample(sample, async (question) => {
			const index = Number(question.slice(1));
			return { ok: true, sources: [`docs/d${index === 0 ? "wrong" : index}.md`] };
		});
		expect(result).toMatchObject({ ok: false, passes: 9, threshold: 1 });
		expect(result.results[0]).toEqual({ id: "Q0", hit: false });
	});

	test("a query that does not answer is a miss and carries its reason", async () => {
		const result = await runSample(SAMPLE_TWO, async () => ({ ok: false, reason: "lightrag 503" }));
		expect(result.ok).toBe(false);
		expect(result.results).toEqual([
			{ id: "A", hit: false, reason: "lightrag 503" },
			{ id: "B", hit: false, reason: "lightrag 503" },
		]);
	});

	test("only the top five citations count", async () => {
		const sources = [...Array.from({ length: 5 }, (_, i) => `docs/x${i}.md`), "docs/a.md"];
		const result = await runSample([SAMPLE_TWO[0] as SampleQuery], async () => ({ ok: true, sources }));
		expect(result.passes).toBe(0);
	});

	test("an empty sample never passes", async () => {
		expect((await runSample([], async () => ({ ok: true, sources: [] }))).ok).toBe(false);
	});

	test("citationMatches accepts a corpus name, a file URL and a flattened name, and rejects a suffix without a boundary", () => {
		expect(citationMatches(corpusDocumentName(REPO, "docs/docs-plane.md", SHA), "docs/docs-plane.md")).toBe(true);
		expect(citationMatches("file:///srv/app/docs/docs-plane.md", "docs/docs-plane.md")).toBe(true);
		expect(citationMatches("docs__docs-plane.md", "docs/docs-plane.md")).toBe(true);
		expect(citationMatches("xdocs/docs-plane.md", "docs/docs-plane.md")).toBe(false);
	});

	test("the frozen sample matches the Frozen sample table in 46-PLAN.md, so the two cannot drift", () => {
		const plan = readFileSync(new URL("../../../.planning/phases/46-lightrag-hybrid/46-PLAN.md", import.meta.url), "utf8");
		const section = plan.slice(plan.indexOf("## Frozen sample"));
		const rows = section
			.split("\n")
			.filter((line) => /^\| Q\d+ \|/.test(line))
			.map((line) => {
				const cells = line.split("|").map((cell) => cell.trim());
				return { id: cells[1] ?? "", question: cells[2] ?? "", expectedSource: (cells[3] ?? "").replaceAll("`", "") };
			});
		expect(rows).toHaveLength(10);
		expect(FROZEN_SAMPLE.map(({ id, question, expectedSource }) => ({ id, question, expectedSource }))).toEqual(rows);
	});
});

describe("parity CLI arguments", () => {
	test("accepts --part A and --part B only", () => {
		expect(parsePartArgs(["--part", "A"])).toEqual({ part: "A" });
		expect(parsePartArgs(["--part", "B"])).toEqual({ part: "B" });
		expect(parsePartArgs(["--part", "C"])).toEqual({ reason: "usage: parity-gate --part A|B" });
		expect(parsePartArgs([])).toEqual({ reason: "usage: parity-gate --part A|B" });
		expect(parsePartArgs(["--part", "A", "extra"])).toEqual({ reason: "usage: parity-gate --part A|B" });
	});
});

describe("record mapping: a document held under another name", () => {
	const record = (documentId: string, path: string): ManifestRecord => ({ documentId, datasetId: REPO, sourceUrl: path, sha: SHA });
	const document = (id: string, path: string): PlaneDocument => ({ id, name: corpusDocumentName(REPO, path, SHA) });

	test("a record whose document the listing holds under a flattened name is unverifiable, not missing", () => {
		const result = checkRecordMapping([record("flat", "docs/a.md")], [], false, ["flat"]);
		expect(result).toMatchObject({ ok: false, mismatches: [{ kind: "unverifiable-name", id: "flat" }] });
	});

	test("a flattened-name document no record references is a document-without-record mismatch", () => {
		const result = checkRecordMapping([record("a", "docs/a.md")], [document("a", "docs/a.md")], false, ["stale"]);
		expect(result).toMatchObject({ ok: false, mismatches: [{ kind: "document-without-record", id: "stale" }] });
	});

	test("an id the listing does not hold is still a record-without-document, even with other ids present", () => {
		const result = checkRecordMapping([record("gone", "docs/a.md")], [], false, ["other"]);
		expect(result.mismatches).toEqual([
			{ kind: "record-without-document", documentId: "gone" },
			{ kind: "document-without-record", id: "other" },
		]);
	});
});

describe("plane reasons in a report", () => {
	test("a transport reason keeps its category and drops the cause, which can carry an address", () => {
		expect(reasonCategory(`lightrag unreachable: connect ECONNREFUSED ${PLANE_ADDRESS}:9621`)).toBe("lightrag unreachable");
	});

	test("an HTTP status keeps its code", () => {
		expect(reasonCategory("lightrag 503")).toBe("lightrag 503");
	});

	test("a reason outside the known categories is plane-unavailable, never echoed", () => {
		expect(reasonCategory(`proxy at ${PLANE_ADDRESS} refused`)).toBe("plane-unavailable");
	});
});

const KEY = "k-test-only-7c1e";
const PLANE_ADDRESS = "192.0.2.7";
const PLANE_URL = `http://${PLANE_ADDRESS}:9621`;
const SCRATCH = mkdtempSync(join(tmpdir(), "parity-gate-test-"));

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

function stateFile(name: string, records: Record<string, unknown>): string {
	const file = join(SCRATCH, name);
	writeFileSync(file, JSON.stringify({ version: 2, records }));
	return file;
}

const stateKey = (path: string) => `lightrag::${REPO}::${path}`;
const stateRecord = (documentId: string, path: string, sha = SHA) => ({ document_id: documentId, dataset_id: REPO, source_url: path, sha });
const listing = (documents: unknown[]) => ({ documents, pagination: { has_next: false } });
const corpusEntry = (id: string, path: string) => ({ id, file_path: corpusDocumentName(REPO, path, SHA) });

const CLEAN_STATE = stateFile("clean.json", {
	[stateKey("docs/a.md")]: stateRecord("doc-a", "docs/a.md"),
	[stateKey("docs/b.md")]: stateRecord("doc-b", "docs/b.md"),
});
const CLEAN_LISTING = listing([corpusEntry("doc-a", "docs/a.md"), corpusEntry("doc-b", "docs/b.md")]);

interface SentRequest {
	path: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

/** A fake LightRAG: `answer` gives each path's reply, or an Error to throw as a transport failure. */
function fakePlane(answer: (path: string, body: Record<string, unknown>) => unknown): { fetch: FetchLike; sent: SentRequest[] } {
	const sent: SentRequest[] = [];
	const fetch: FetchLike = async (input, init) => {
		const path = new URL(String(input)).pathname;
		const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
		sent.push({ path, headers: { ...(init?.headers as Record<string, string> | undefined) }, body });
		const reply = answer(path, body);
		if (reply instanceof Error) throw reply;
		return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
	};
	return { fetch, sent };
}

/** The `/query` reply for one frozen question: its expected source at rank one, or a wrong source for `missId`. */
function frozenReply(query: unknown, missId?: string): unknown {
	const item = FROZEN_SAMPLE.find((entry) => entry.question === query);
	const source = item !== undefined && item.id !== missId ? item.expectedSource : "docs/elsewhere.md";
	return { data: { chunks: [{ content: "passage", file_path: corpusDocumentName(REPO, source, SHA) }] } };
}

function env(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
	return { LIGHTRAG_URL: PLANE_URL, LIGHTRAG_API_KEY: KEY, ...extra };
}

describe("parity CLI run", () => {
	test("without LIGHTRAG_URL, Part A exits 2 and opens no socket", async () => {
		const plane = fakePlane(() => CLEAN_LISTING);
		const outcome = await runParity(["--part", "A"], { SUBSTRATE_DOCS_STATE_FILE: CLEAN_STATE }, plane);
		expect(outcome).toEqual({ exitCode: 2, report: { part: "A", ok: false, reason: "LIGHTRAG_URL is unset; no socket was opened" } });
		expect(plane.sent).toHaveLength(0);
	});

	test("without LIGHTRAG_URL, Part B exits 2 and opens no socket", async () => {
		const plane = fakePlane(() => ({}));
		const outcome = await runParity(["--part", "B"], {}, plane);
		expect(outcome).toEqual({ exitCode: 2, report: { part: "B", ok: false, reason: "LIGHTRAG_URL is unset; no socket was opened" } });
		expect(plane.sent).toHaveLength(0);
	});

	test("bad arguments exit 2 before any plane read", async () => {
		const plane = fakePlane(() => CLEAN_LISTING);
		const outcome = await runParity(["--part", "C"], env({ SUBSTRATE_DOCS_STATE_FILE: CLEAN_STATE }), plane);
		expect(outcome).toEqual({ exitCode: 2, report: { ok: false, reason: "usage: parity-gate --part A|B" } });
		expect(plane.sent).toHaveLength(0);
	});

	test("a missing docs state file exits 2 and reads no plane", async () => {
		const plane = fakePlane(() => CLEAN_LISTING);
		const outcome = await runParity(["--part", "A"], env({ SUBSTRATE_DOCS_STATE_FILE: join(SCRATCH, "absent.json") }), plane);
		expect(outcome).toEqual({ exitCode: 2, report: { part: "A", ok: false, reason: "the docs state file is unreadable or not JSON" } });
		expect(plane.sent).toHaveLength(0);
	});

	test("Part A: matching records exit 0, send the key as X-API-Key, and print neither the key nor the address", async () => {
		const plane = fakePlane((path) => (path === "/documents/paginated" ? CLEAN_LISTING : {}));
		const outcome = await runParity(["--part", "A"], env({ SUBSTRATE_DOCS_STATE_FILE: CLEAN_STATE }), plane);
		expect(outcome.exitCode).toBe(0);
		expect(outcome.report).toMatchObject({ part: "A", ok: true, records: 2, plane_documents: 2, other_documents: 0, truncated: false, mismatch_count: 0 });
		expect(plane.sent.map((request) => request.path)).toEqual(["/documents/paginated"]);
		expect(plane.sent[0]?.headers["X-API-Key"]).toBe(KEY);
		const printed = JSON.stringify(outcome.report);
		expect(printed).not.toContain(KEY);
		expect(printed).not.toContain(PLANE_ADDRESS);
	});

	test("Part A: a changed version exits 1 and is counted as a version mismatch", async () => {
		const state = stateFile("version.json", {
			[stateKey("docs/a.md")]: stateRecord("doc-a", "docs/a.md"),
			[stateKey("docs/b.md")]: stateRecord("doc-b", "docs/b.md", "f".repeat(64)),
		});
		const plane = fakePlane(() => CLEAN_LISTING);
		const outcome = await runParity(["--part", "A"], env({ SUBSTRATE_DOCS_STATE_FILE: state }), plane);
		expect(outcome.exitCode).toBe(1);
		expect(outcome.report).toMatchObject({ ok: false, mismatches: { "version-mismatch": 1 }, mismatch_count: 1 });
	});

	test("Part A: a record whose document is held under a flattened name is unverifiable, not missing", async () => {
		const state = stateFile("flattened.json", {
			[stateKey("docs/a.md")]: stateRecord("doc-a", "docs/a.md"),
			[stateKey("docs/b.md")]: stateRecord("doc-b", "docs/b.md"),
			[stateKey("docs/x.md")]: stateRecord("doc-flat", "docs/x.md"),
		});
		const plane = fakePlane(() => listing([...CLEAN_LISTING.documents, { id: "doc-flat", file_path: "docs__x.md" }]));
		const outcome = await runParity(["--part", "A"], env({ SUBSTRATE_DOCS_STATE_FILE: state }), plane);
		expect(outcome.exitCode).toBe(1);
		expect(outcome.report).toMatchObject({ ok: false, other_documents: 1, mismatches: { "unverifiable-name": 1 } });
	});

	test("Part A: a listing with an unreadable entry is truncated and fails closed with its reason", async () => {
		const plane = fakePlane(() => listing([...CLEAN_LISTING.documents, { file_path: "corpus:entry-without-id" }]));
		const outcome = await runParity(["--part", "A"], env({ SUBSTRATE_DOCS_STATE_FILE: CLEAN_STATE }), plane);
		expect(outcome.exitCode).toBe(1);
		expect(outcome.report).toMatchObject({ ok: false, truncated: true });
		expect(String(outcome.report.reason)).toContain("truncated");
	});

	test("Part A: an unreachable plane exits 1 with a closed reason and no address", async () => {
		const plane = fakePlane(() => new Error(`connect ECONNREFUSED ${PLANE_ADDRESS}:9621`));
		const outcome = await runParity(["--part", "A"], env({ SUBSTRATE_DOCS_STATE_FILE: CLEAN_STATE }), plane);
		expect(outcome).toEqual({ exitCode: 1, report: { part: "A", ok: false, reason: "plane-unavailable" } });
		expect(JSON.stringify(outcome.report)).not.toContain(PLANE_ADDRESS);
	});

	test("Part B: every frozen question answered from its source exits 0 with a 1.0 rate, and mode is reported", async () => {
		const plane = fakePlane((path, body) => (path === "/query" ? frozenReply(body.query) : {}));
		const outcome = await runParity(["--part", "B"], env(), plane);
		expect(outcome.exitCode).toBe(0);
		expect(outcome.report).toMatchObject({ part: "B", ok: true, mode: "hybrid", top_k: 5, queries: 10, passes: 10, rate: 1, threshold: 1 });
		expect(plane.sent).toHaveLength(10);
		expect(plane.sent.every((request) => request.body.mode === "hybrid")).toBe(true);
	});

	test("Part B: one wrong citation exits 1 with 9 of 10 and names the miss", async () => {
		const plane = fakePlane((path, body) => (path === "/query" ? frozenReply(body.query, "Q1") : {}));
		const outcome = await runParity(["--part", "B"], env(), plane);
		expect(outcome.exitCode).toBe(1);
		expect(outcome.report).toMatchObject({ ok: false, passes: 9, rate: 0.9 });
		expect(outcome.report.results).toContainEqual({ id: "Q1", hit: false });
	});

	test("Part B: the mode sent is the configured mode, and the report names it", async () => {
		const plane = fakePlane((path, body) => (path === "/query" ? frozenReply(body.query) : {}));
		const outcome = await runParity(["--part", "B"], env({ SUBSTRATE_LIGHTRAG_QUERY_MODE: "naive" }), plane);
		expect(outcome.report.mode).toBe("naive");
		expect(plane.sent[0]?.body.mode).toBe("naive");
	});

	test("Part B: an unreachable plane misses every question with a category, and prints no address", async () => {
		const plane = fakePlane(() => new Error(`connect ECONNREFUSED ${PLANE_ADDRESS}:9621`));
		const outcome = await runParity(["--part", "B"], env(), plane);
		expect(outcome.exitCode).toBe(1);
		expect(outcome.report).toMatchObject({ ok: false, passes: 0, rate: 0 });
		expect(outcome.report.results).toEqual(FROZEN_SAMPLE.map((item) => ({ id: item.id, hit: false, reason: "lightrag unreachable" })));
		expect(JSON.stringify(outcome.report)).not.toContain(PLANE_ADDRESS);
	});
});
