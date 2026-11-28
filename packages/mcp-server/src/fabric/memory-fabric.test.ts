/** E3 memory fabric tests (phase 84): fakes only, no planes, no network. */
import { describe, expect, test } from "bun:test";
import {
	LIGHTRAG_WRITE_FORBIDDEN,
	MemoryFabric,
	type HindsightPort,
	type LightragPort,
	type ProvenanceChunk,
} from "./memory-fabric.ts";
import type { HindsightResult, RecallHit, RetainItem } from "../planes/hindsight.ts";

class FakeHindsight implements HindsightPort {
	retained: Array<{ bank: string; items: RetainItem[] }> = [];
	forgotten: Array<{ bank: string; document_id: string }> = [];
	hits: RecallHit[] = [];

	async retain(bank: string, items: RetainItem[]): Promise<HindsightResult<{ items_count: number }>> {
		this.retained.push({ bank, items });
		return { ok: true, value: { items_count: items.length } };
	}

	async recall(_bank: string, _query: string): Promise<HindsightResult<RecallHit[]>> {
		return { ok: true, value: this.hits };
	}

	async forget(bank: string, document_id: string): Promise<HindsightResult<boolean>> {
		this.forgotten.push({ bank, document_id });
		return { ok: true, value: true };
	}
}

class FakeLightrag implements LightragPort {
	provenanceCalls: string[] = [];
	chunks: ProvenanceChunk[] = [];
	fail = false;

	async provenance(query: string): Promise<{ ok: true; chunks: ProvenanceChunk[] } | { ok: false; reason: string }> {
		this.provenanceCalls.push(query);
		if (this.fail) return { ok: false, reason: "lightrag-down" };
		return { ok: true, chunks: this.chunks };
	}
}

const auditEvents: Array<{ summary: string; payload: Record<string, unknown> }> = [];

function fabric(hindsight: FakeHindsight, lightrag: FakeLightrag): MemoryFabric {
	auditEvents.length = 0;
	return new MemoryFabric({
		hindsight,
		lightrag,
		audit: {
			async audit(summary, payload) {
				auditEvents.push({ summary, payload });
			},
		},
	});
}

describe("MemoryFabric routing", () => {
	test("remember retains in Hindsight only, LightRAG untouched", async () => {
		const hindsight = new FakeHindsight();
		const lightrag = new FakeLightrag();
		const result = await fabric(hindsight, lightrag).remember({ bank: "sub-omp", content: "fact", document_id: "doc-1", tags: ["t"] });
		expect(result).toEqual({ ok: true, items_count: 1 });
		expect(hindsight.retained).toHaveLength(1);
		expect(hindsight.retained[0]?.bank).toBe("sub-omp");
		expect(hindsight.retained[0]?.items[0]?.document_id).toBe("doc-1");
		expect(lightrag.provenanceCalls).toEqual([]);
	});

	test("forget goes to Hindsight only", async () => {
		const hindsight = new FakeHindsight();
		const lightrag = new FakeLightrag();
		const result = await fabric(hindsight, lightrag).forget({ bank: "sub-omp", document_id: "doc-1" });
		expect(result).toEqual({ ok: true });
		expect(hindsight.forgotten).toEqual([{ bank: "sub-omp", document_id: "doc-1" }]);
		expect(lightrag.provenanceCalls).toEqual([]);
	});
});

describe("MemoryFabric recall provenance join", () => {
	test("joins LightRAG provenance onto the matching Hindsight hit, metadata only", async () => {
		const hindsight = new FakeHindsight();
		hindsight.hits = [{ id: "h1", text: "remembered text", document_id: "doc-1", tags: [], metadata: {} }];
		const lightrag = new FakeLightrag();
		lightrag.chunks = [{ document_id: "doc-1", document_name: "doc-1", score: 0.9, source_url: "http://docs/doc-1" }];
		const result = await fabric(hindsight, lightrag).recall({ bank: "sub-omp", query: "q" });
		expect(result.degraded).toBe(false);
		expect(result.hits).toHaveLength(1);
		const hit = result.hits[0];
		expect(hit?.text).toBe("remembered text");
		expect(hit?.hindsight).toBe(true);
		expect(hit?.lightrag).toBe(true);
		expect(hit?.provenance).toEqual({ document_id: "doc-1", document_name: "doc-1", score: 0.9, source_url: "http://docs/doc-1" });
		expect(JSON.stringify(result)).not.toContain('"content"');
	});

	test("LightRAG-only chunk is a provenance row with no text", async () => {
		const hindsight = new FakeHindsight();
		hindsight.hits = [];
		const lightrag = new FakeLightrag();
		lightrag.chunks = [{ document_id: "doc-9", document_name: "doc-9" }];
		const result = await fabric(hindsight, lightrag).recall({ bank: "sub-omp", query: "q" });
		expect(result.hits).toEqual([{ id: "doc-9", text: null, document_id: "doc-9", provenance: { document_id: "doc-9", document_name: "doc-9" }, hindsight: false, lightrag: true }]);
	});

	test("a down LightRAG still returns Hindsight hits, degraded with a reason", async () => {
		const hindsight = new FakeHindsight();
		hindsight.hits = [{ id: "h1", text: "text", tags: [], metadata: {} }];
		const lightrag = new FakeLightrag();
		lightrag.fail = true;
		const result = await fabric(hindsight, lightrag).recall({ bank: "sub-omp", query: "q" });
		expect(result.degraded).toBe(true);
		expect(result.hits).toHaveLength(1);
		expect(result.reasons).toContain("lightrag-provenance:lightrag-down");
	});
});

describe("MemoryFabric LightRAG-write rejection", () => {
	test("writeLightragContent is rejected with one audit event and no LightRAG call", async () => {
		const hindsight = new FakeHindsight();
		const lightrag = new FakeLightrag();
		const result = await fabric(hindsight, lightrag).writeLightragContent({ content: "secret write" });
		expect(result).toEqual({ ok: false, reason: LIGHTRAG_WRITE_FORBIDDEN });
		expect(auditEvents).toHaveLength(1);
		expect(auditEvents[0]?.payload).toEqual({ outcome: "rejected", reason: LIGHTRAG_WRITE_FORBIDDEN });
		expect(lightrag.provenanceCalls).toEqual([]);
		expect(hindsight.retained).toEqual([]);
	});

	test("rememberTo a non-Hindsight plane is the same rejection", async () => {
		const hindsight = new FakeHindsight();
		const lightrag = new FakeLightrag();
		const result = await fabric(hindsight, lightrag).rememberTo("lightrag", { bank: "b", content: "c", document_id: "d" });
		expect(result).toEqual({ ok: false, reason: LIGHTRAG_WRITE_FORBIDDEN });
		expect(auditEvents).toHaveLength(1);
		expect(hindsight.retained).toEqual([]);
	});
});
