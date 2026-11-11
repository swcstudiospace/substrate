import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { corpusDocumentName } from "@substrate/corpus";
import { parsePartArgs } from "../../../scripts/parity-gate.ts";
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
				"ragflow::ds::docs/a.md": { document_id: "old", dataset_id: "ds", source_url: "docs/a.md", sha: SHA, version: 1 },
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
		const plan = readFileSync(new URL("../../../.planning/phases/46-ragflow-hybrid/46-PLAN.md", import.meta.url), "utf8");
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
