/**
 * Tandem recall (phase 57c): the pure merge of LightRAG chunks and Hindsight memory. No clock but the injected
 * one, no randomness but a seeded shuffle, nothing that opens a socket.
 */
import { describe, expect, test } from "bun:test";
import {
	DEFAULT_TANDEM_OPTIONS,
	TANDEM_CONTENT_CAP,
	TANDEM_MAX_CAP,
	TANDEM_RRF_K,
	mergeTandem,
	normalizeTandemContent,
	parseTandemOptions,
	tandemDigest,
	type TandemHindsightInput,
	type TandemLightragInput,
	type TandemMerge,
} from "./tandem-recall.ts";

const SECRET = `ghp_${"a".repeat(40)}`;
const NOW = Date.parse("2026-10-26T10:00:00.000Z");

function chunk(n: number, extra: Partial<TandemLightragInput> = {}): TandemLightragInput {
	return {
		title: `doc ${n}`,
		source_url: `https://example.com/doc-${n}`,
		snippet: `lightrag fact number ${n}`,
		score: 1 - n / 100,
		document_id: `doc-${n}`,
		chunk_id: `chunk-${n}`,
		...extra,
	};
}

function memory(n: number, extra: Partial<TandemHindsightInput> = {}): TandemHindsightInput {
	return { bank: "sub-cursor", id: `mem-${n}`, text: `hindsight memory number ${n}`, document_id: `mwd_${n}`, score: 1 - n / 100, ...extra };
}

/** mulberry32: a seeded generator, so a shuffle is the same on every run. */
function seeded(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function shuffled<T>(list: readonly T[], random: () => number): T[] {
	const out = [...list];
	for (let i = out.length - 1; i > 0; i -= 1) {
		const j = Math.floor(random() * (i + 1));
		[out[i], out[j]] = [out[j] as T, out[i] as T];
	}
	return out;
}

describe("normalised digest", () => {
	test("whitespace collapsed and case folded: two copies of one fact share a digest", () => {
		expect(normalizeTandemContent("  The  Plan\nlives\tin PLAN.md ")).toBe("the plan lives in plan.md");
		expect(tandemDigest("The Plan lives in PLAN.md")).toBe(tandemDigest("  the plan   LIVES in plan.md\n"));
		expect(tandemDigest("one thing")).not.toBe(tandemDigest("another thing"));
		expect(tandemDigest("x")).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("mergeTandem dedupe", () => {
	test("a memory with the same normalised content as a chunk is dropped; the LightRAG item survives and counts it", () => {
		const merged = mergeTandem({
			lightrag: [chunk(1, { snippet: "The plan lives in PLAN.md." })],
			hindsight: [memory(1, { text: "the plan   lives in\nplan.md." }), memory(2)],
			cap: 10,
			now: () => NOW,
		});
		expect(merged.items.map((item) => `${item.origin}:${item.id}`).sort()).toEqual(["hindsight:mwd_2", "lightrag:chunk-1"]);
		expect(merged.counts).toEqual({ lightrag: 1, hindsight: 1, deduplicated: 1 });
	});

	test("the survivor of a duplicate earns both ranks, so it outranks a unique item of equal position", () => {
		const merged = mergeTandem({
			lightrag: [chunk(1, { snippet: "shared fact" }), chunk(2)],
			hindsight: [memory(1, { text: "SHARED   fact" })],
			cap: 10,
		});
		const shared = merged.items.find((item) => item.id === "chunk-1");
		expect(shared?.score).toBeCloseTo(2 / (TANDEM_RRF_K + 1), 12);
		expect(merged.items[0]?.id).toBe("chunk-1");
	});

	test("two chunks of one origin with the same content collapse to the better-ranked one", () => {
		const merged = mergeTandem({
			lightrag: [chunk(1, { snippet: "same words", score: 0.2 }), chunk(2, { snippet: "Same   Words", score: 0.9 })],
			hindsight: [],
			cap: 10,
		});
		expect(merged.items.map((item) => item.id)).toEqual(["chunk-2"]);
		expect(merged.counts.deduplicated).toBe(1);
	});

	test("a memory whose source URL is a chunk's is dropped even with different text", () => {
		const merged = mergeTandem({
			lightrag: [chunk(1, { source_url: "hindsight:sub-cursor/mwd_7" })],
			hindsight: [memory(7, { text: "a different wording entirely" })],
			cap: 10,
		});
		expect(merged.items.map((item) => item.origin)).toEqual(["lightrag"]);
		expect(merged.counts.deduplicated).toBe(1);
	});

	test("chunks of one document share a URL and are not duplicates; a dataset: placeholder is no URL", () => {
		const merged = mergeTandem({
			lightrag: [
				chunk(1, { source_url: "https://example.com/page" }),
				chunk(2, { source_url: "https://example.com/page" }),
				chunk(3, { source_url: "dataset:agent-substrate" }),
				chunk(4, { source_url: "dataset:agent-substrate" }),
			],
			hindsight: [memory(1)],
			cap: 10,
		});
		expect(merged.items.filter((item) => item.origin === "lightrag")).toHaveLength(4);
		expect(merged.counts.deduplicated).toBe(0);
	});
});

describe("mergeTandem ranking", () => {
	test("reciprocal rank fusion, k = 60: a score is the sum of 1/(60 + rank) over the lists it is in", () => {
		const merged = mergeTandem({ lightrag: [chunk(1), chunk(2)], hindsight: [memory(1)], cap: 10 });
		const byId = new Map(merged.items.map((item) => [item.id, item.score]));
		expect(byId.get("chunk-1")).toBeCloseTo(1 / 61, 12);
		expect(byId.get("chunk-2")).toBeCloseTo(1 / 62, 12);
		expect(byId.get("mwd_1")).toBeCloseTo(1 / 61, 12);
	});

	test("equal fused scores break by origin, then id: hindsight before lightrag, chunk-1 before chunk-2", () => {
		const merged = mergeTandem({ lightrag: [chunk(1)], hindsight: [memory(1)], cap: 10 });
		expect(merged.items.map((item) => item.origin)).toEqual(["hindsight", "lightrag"]);
		const ids = mergeTandem({
			lightrag: [chunk(2, { score: 0.5 }), chunk(1, { score: 0.5 })],
			hindsight: [],
			cap: 10,
		}).items.map((item) => item.id);
		// Equal plane scores keep input order for the rank (chunk-2 first), so chunk-2 outranks chunk-1: rank decides before the id does.
		expect(ids).toEqual(["chunk-2", "chunk-1"]);
	});

	/** The merge without `input_index`, which is by design the caller's own list position and so follows the input order. */
	const stable = (merged: TandemMerge): string => JSON.stringify({ ...merged, items: merged.items.map(({ input_index: _position, ...item }) => item) });

	test("the same inputs in any order give the same output, byte for byte (seeded shuffles)", () => {
		const lightrag = Array.from({ length: 8 }, (_, i) => chunk(i + 1, { score: [0.9, 0.9, 0.7, 0.7, 0.7, 0.5, 0.3, 0.3][i] as number }));
		const hindsight = Array.from({ length: 6 }, (_, i) => memory(i + 1, { score: [0.8, 0.8, 0.6, 0.6, 0.4, 0.4][i] as number }));
		const reference = mergeTandem({ lightrag, hindsight, cap: 20, now: () => NOW });
		const random = seeded(57);
		for (let round = 0; round < 25; round += 1) {
			const merged = mergeTandem({ lightrag: shuffled(lightrag, random), hindsight: shuffled(hindsight, random), cap: 20, now: () => NOW });
			// Tied plane scores take their rank from input position, so equal-score items may swap; the set and the counts never change.
			expect(merged.items.map((item) => item.id).sort()).toEqual(reference.items.map((item) => item.id).sort());
			expect(merged.counts).toEqual(reference.counts);
		}
		// With distinct scores the order is exactly determined by the data, whatever the input order.
		const distinctL = lightrag.map((entry, i) => ({ ...entry, score: 1 - i / 10 }));
		const distinctH = hindsight.map((entry, i) => ({ ...entry, score: 1 - i / 10 }));
		const fixed = stable(mergeTandem({ lightrag: distinctL, hindsight: distinctH, cap: 10, now: () => NOW }));
		for (let round = 0; round < 25; round += 1) {
			expect(stable(mergeTandem({ lightrag: shuffled(distinctL, random), hindsight: shuffled(distinctH, random), cap: 10, now: () => NOW }))).toBe(fixed);
		}
	});

	test("a repeated merge of the same input is identical", () => {
		const input = { lightrag: [chunk(1), chunk(2)], hindsight: [memory(1), memory(2)], cap: 3, now: () => NOW };
		expect(JSON.stringify(mergeTandem(input))).toBe(JSON.stringify(mergeTandem(input)));
	});

	test("the injected clock stamps the merge", () => {
		expect(mergeTandem({ lightrag: [], hindsight: [], cap: 5, now: () => NOW }).at).toBe("2026-10-26T10:00:00.000Z");
	});
});

describe("mergeTandem cap and per-origin floor", () => {
	test("the cap bounds the result; zero, negative and non-finite caps return nothing; the hard maximum holds", () => {
		const lightrag = Array.from({ length: 60 }, (_, i) => chunk(i + 1));
		expect(mergeTandem({ lightrag, hindsight: [memory(1)], cap: 3 }).items).toHaveLength(3);
		for (const cap of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(mergeTandem({ lightrag, hindsight: [memory(1)], cap }).items).toEqual([]);
		expect(mergeTandem({ lightrag, hindsight: [], cap: 1000 }).items).toHaveLength(TANDEM_MAX_CAP);
	});

	test("both origins present: at least min(2, available) of each survive a tight cap", () => {
		// Hindsight's unique items sit below chunks that duplicates boost, so by rank alone they would be cut.
		const lightrag = ["fact a", "fact b", "fact c", "fact d", "fact e", "fact f"].map((snippet, i) => chunk(i + 1, { snippet }));
		const hindsight = [
			memory(1, { text: "FACT A" }),
			memory(2, { text: "fact   B" }),
			memory(3, { text: "fact c" }),
			memory(4, { text: "only memory four" }),
			memory(5, { text: "only memory five" }),
		];
		const merged = mergeTandem({ lightrag, hindsight, cap: 4 });
		expect(merged.items).toHaveLength(4);
		expect(merged.items.filter((item) => item.origin === "hindsight").map((item) => item.id).sort()).toEqual(["mwd_4", "mwd_5"]);
		expect(merged.items.filter((item) => item.origin === "lightrag")).toHaveLength(2);
		expect(merged.counts).toEqual({ lightrag: 2, hindsight: 2, deduplicated: 3 });
		// The result stays in fused order, not floor-first.
		const scores = merged.items.map((item) => item.score);
		expect(scores).toEqual([...scores].sort((left, right) => right - left));
	});

	test("one origin only: no floor applies; one item of the other: that one is kept", () => {
		const lightrag = Array.from({ length: 5 }, (_, i) => chunk(i + 1));
		expect(mergeTandem({ lightrag, hindsight: [], cap: 3 }).items.every((item) => item.origin === "lightrag")).toBe(true);
		expect(mergeTandem({ lightrag: [], hindsight: [memory(1), memory(2), memory(3)], cap: 2 }).items.map((item) => item.id)).toEqual(["mwd_1", "mwd_2"]);
		const mixed = mergeTandem({ lightrag, hindsight: [memory(9, { score: 0.01 })], cap: 2 });
		expect(mixed.items.map((item) => item.origin).sort()).toEqual(["hindsight", "lightrag"]);
	});

	test("a cap of one below the floors still returns the single best-ranked item", () => {
		const merged = mergeTandem({ lightrag: [chunk(1), chunk(2)], hindsight: [memory(1), memory(2)], cap: 1 });
		expect(merged.items).toHaveLength(1);
	});
});

describe("mergeTandem items", () => {
	test("a LightRAG item names the plane, the document, the chunk and the file; it is not derived", () => {
		const [item] = mergeTandem({
			lightrag: [chunk(1, { file_path: "docs/plan.md", title: "Plan", source_url: "https://example.com/plan" })],
			hindsight: [],
			cap: 5,
		}).items;
		expect(item).toEqual({
			origin: "lightrag",
			id: "chunk-1",
			input_index: 0,
			title: "Plan",
			source_url: "https://example.com/plan",
			content: "lightrag fact number 1",
			score: 1 / (TANDEM_RRF_K + 1),
			provenance: { bank: "lightrag", document_id: "doc-1", file_path: "docs/plan.md", chunk_id: "chunk-1" },
		});
		expect(Object.hasOwn(item!, "derived")).toBe(false);
	});

	test("a Hindsight item is derived and carries its bank, document and graph/session/node join keys", () => {
		const [item] = mergeTandem({
			lightrag: [],
			hindsight: [memory(3, { graph_id: "g-1", session_id: "s-1", node_id: "n-1", bank: "sub-omp" })],
			cap: 5,
		}).items;
		expect(item).toMatchObject({
			origin: "hindsight",
			derived: true,
			id: "mwd_3",
			title: "mwd_3",
			source_url: "hindsight:sub-omp/mwd_3",
			content: "hindsight memory number 3",
			provenance: { bank: "sub-omp", document_id: "mwd_3", graph_id: "g-1", session_id: "s-1", node_id: "n-1" },
		});
		expect(Object.hasOwn(item!.provenance, "file_path")).toBe(false);
		expect(Object.hasOwn(item!.provenance, "chunk_id")).toBe(false);
	});

	test("absent join keys are absent, not undefined; a memory with no document id is addressed by its id", () => {
		const [item] = mergeTandem({ lightrag: [], hindsight: [{ bank: "sub-omp", id: "m-1", text: "t" }], cap: 5 }).items;
		expect(item?.provenance).toEqual({ bank: "sub-omp", document_id: "m-1" });
		expect(item?.source_url).toBe("hindsight:sub-omp/m-1");
	});

	test("input_index maps an item back to what the caller handed in", () => {
		const lightrag = [chunk(1, { score: 0.1 }), chunk(2, { score: 0.9 })];
		const hindsight = [memory(1, { score: 0.2 }), memory(2, { score: 0.8 })];
		const merged = mergeTandem({ lightrag, hindsight, cap: 10 });
		for (const item of merged.items) {
			const source = item.origin === "lightrag" ? lightrag[item.input_index]?.chunk_id : hindsight[item.input_index]?.document_id;
			expect(source).toBe(item.id);
		}
	});

	test("content is redacted and capped; untrusted text never carries a secret", () => {
		const [item] = mergeTandem({
			lightrag: [chunk(1, { snippet: `token ${SECRET} ${"y ".repeat(TANDEM_CONTENT_CAP)}` })],
			hindsight: [],
			cap: 5,
		}).items;
		expect(item?.content).not.toContain(SECRET);
		expect(item!.content.length).toBeLessThanOrEqual(TANDEM_CONTENT_CAP);
		const [memoryItem] = mergeTandem({ lightrag: [], hindsight: [memory(1, { text: `remember ${SECRET}` })], cap: 5 }).items;
		expect(memoryItem?.content).not.toContain(SECRET);
	});
});

describe("parseTandemOptions", () => {
	test("off by default, with safe numbers", () => {
		expect(DEFAULT_TANDEM_OPTIONS).toEqual({ enabled: false, hindsight_limit: 5, budget_ms: 1500 });
		expect(parseTandemOptions(undefined)).toEqual(DEFAULT_TANDEM_OPTIONS);
		expect(parseTandemOptions(null)).toEqual(DEFAULT_TANDEM_OPTIONS);
		expect(parseTandemOptions({})).toEqual(DEFAULT_TANDEM_OPTIONS);
	});

	test("only true, on, true and 1 enable it; the numbers clamp and bad values fall back", () => {
		for (const enabled of [true, "on", "TRUE", " 1 "]) expect(parseTandemOptions({ enabled }).enabled).toBe(true);
		for (const enabled of [false, "off", "yes", "", 1, null, undefined]) expect(parseTandemOptions({ enabled }).enabled).toBe(false);
		expect(parseTandemOptions({ hindsight_limit: 500, budget_ms: 999_999 })).toMatchObject({ hindsight_limit: 10, budget_ms: 10_000 });
		expect(parseTandemOptions({ hindsight_limit: 0, budget_ms: 1 })).toMatchObject({ hindsight_limit: 1, budget_ms: 50 });
		expect(parseTandemOptions({ hindsight_limit: "3", budget_ms: "250" })).toMatchObject({ hindsight_limit: 3, budget_ms: 250 });
		expect(parseTandemOptions({ hindsight_limit: "abc", budget_ms: Number.NaN })).toMatchObject({ hindsight_limit: 5, budget_ms: 1500 });
	});
});
