/**
 * Phase 101 F2 proven against the recording Hindsight fake: deterministic
 * extraction, typed retain with provenance, the recall join, and the
 * self-improvement update loop. Fake-only — no live Hindsight in tests.
 */
import { describe, expect, test } from "bun:test";
import { HindsightFake } from "../hindsight-fake.ts";
import { attachRelated, MAX_RELATED_PER_HIT, recallMemories } from "../memory-recall.ts";
import type { DerivedMemoryHit } from "../memory-recall.ts";
import { bankForSurface, RELATION_BANK_SURFACE, retainMemories } from "./hindsight.ts";
import type { HindsightConfig } from "./hindsight.ts";
import {
	diffRelations,
	edgesFromRelationHits,
	extractMdLinks,
	extractPhaseDeps,
	extractRelations,
	extractTsImports,
	relationBank,
	relationDocumentId,
	syncRelations,
	toRetainItems,
} from "./relations.ts";
import type { RelationEdge } from "./relations.ts";

const CONFIG: HindsightConfig = { url: "http://fake", apiKey: "test-bearer", bankPrefix: "sub-" };
const BANK = "sub-relations";

function setup(): HindsightFake {
	const fake = new HindsightFake();
	fake.banks.set(BANK, { mode: "chunks", memories: [] });
	return fake;
}

describe("extractTsImports", () => {
	test("covers static, side-effect, re-export, dynamic, and require forms", () => {
		const source = [
			`import x from './b';`,
			`import { a } from "./c";`,
			`import './side';`,
			`export * from './d';`,
			`export { x } from "./e";`,
			`const m = await import('./f');`,
			`const r = require('./g');`,
		].join("\n");
		const tos = extractTsImports("a.ts", source).map((relation) => relation.to).sort();
		expect(tos).toEqual(["./b", "./c", "./d", "./e", "./f", "./g", "./side"]);
		expect(extractTsImports("a.ts", source).every((relation) => relation.kind === "import" && relation.from === "a.ts")).toBe(true);
	});

	test("duplicate specifiers collapse to one edge; empty source yields none", () => {
		expect(extractTsImports("a.ts", `import a from './b';\nimport { c } from './b';`)).toHaveLength(1);
		expect(extractTsImports("a.ts", `const x = 1;\n`)).toEqual([]);
	});
});

describe("extractMdLinks", () => {
	test("keeps relative and anchor targets, skips absolute URLs", () => {
		const source = `[a](other.md) [b](./sub/c.md#sec) [c](#frag) [x](https://example.com/y) [y](mailto:a@b.c)`;
		const tos = extractMdLinks("index.md", source).map((relation) => relation.to);
		expect(tos).toEqual(["other.md", "./sub/c.md#sec", "#frag"]);
	});
});

describe("extractPhaseDeps", () => {
	test("single, multi, and Nothing edges; plain and bold syntax", () => {
		expect(extractPhaseDeps("ROADMAP.md", `**Depends on**: Phase 16`)).toEqual([{ kind: "phase-dep", from: "ROADMAP.md", to: "Phase 16" }]);
		expect(extractPhaseDeps("ROADMAP.md", `**Depends on**: Phase 17, Phase 18`).map((relation) => relation.to)).toEqual(["Phase 17", "Phase 18"]);
		expect(extractPhaseDeps("ROADMAP.md", `Depends on: Phase 21 (the route before its clients)`).map((relation) => relation.to)).toEqual(["Phase 21"]);
		expect(extractPhaseDeps("ROADMAP.md", `**Depends on**: Nothing (first v1.3 phase)`)).toEqual([]);
	});
});

describe("extractRelations", () => {
	test("combines all three extractors, deduped", () => {
		const source = `import x from './b';\n[guide](other.md)\n**Depends on**: Phase 16\nimport x from './b';\n`;
		const relations = extractRelations("a.ts", source);
		expect(relations.map((relation) => `${relation.kind}:${relation.to}`)).toEqual(["import:./b", "md-link:other.md", "phase-dep:Phase 16"]);
	});
});

describe("relationDocumentId + toRetainItems (tracer)", () => {
	test("stable id; retain items carry typed payload and provenance", () => {
		const id = relationDocumentId("a.ts", "b.ts", "import");
		expect(id).toBe(relationDocumentId("a.ts", "b.ts", "import"));
		expect(id).not.toBe(relationDocumentId("a.ts", "b.ts", "md-link"));
		const items = toRetainItems([{ kind: "import", from: "a.ts", to: "b.ts" }], { commit: "abc" });
		expect(items).toHaveLength(1);
		expect(items[0]?.document_id).toBe(id);
		expect(items[0]?.metadata).toEqual({ relation_kind: "import", from: "a.ts", to: "b.ts", source_path: "a.ts", commit: "abc" });
		expect(items[0]?.tags).toEqual(["relation", "relation:import"]);
	});

	test("one hardcoded relation round-trips through the fake retain, idempotently", async () => {
		const fake = setup();
		const items = toRetainItems([{ kind: "import", from: "a.ts", to: "b.ts" }], { commit: "abc" });
		const first = await retainMemories(CONFIG, BANK, items, fake.fetch);
		expect(first).toEqual({ ok: true, value: { items_count: 1 } });
		const recorded = fake.retains[0]?.item as Record<string, unknown>;
		expect(fake.retains).toHaveLength(1);
		expect(recorded["document_id"]).toBe(relationDocumentId("a.ts", "b.ts", "import"));
		expect(recorded["metadata"]).toEqual({ relation_kind: "import", from: "a.ts", to: "b.ts", source_path: "a.ts", commit: "abc" });
		const second = await retainMemories(CONFIG, BANK, items, fake.fetch);
		expect(second).toEqual({ ok: true, value: { items_count: 1 } });
		expect(fake.retainBodies()[1]).toEqual(fake.retainBodies()[0]);
		expect(fake.banks.get(BANK)?.memories).toHaveLength(1);
	});
});

describe("recall join", () => {
	const hitFor = (document_id: string, text: string): DerivedMemoryHit => ({ bank: "sub-cursor", id: document_id, text, derived: true, document_id, tags: [] });
	const edge: RelationEdge = { kind: "import", from: "a.ts", to: "b.ts", source_path: "a.ts", commit: "abc" };

	test("hit for b.ts gains the a.ts edge as metadata; text untouched", () => {
		const before = hitFor("b.ts", "hello");
		const after = attachRelated([before], [edge]);
		expect(after[0]?.text).toBe("hello");
		expect(after[0]?.related).toEqual([{ kind: "import", to: "a.ts", source_path: "a.ts", commit: "abc" }]);
		expect(before.related).toBeUndefined();
	});

	test("unmatched hits gain no related key; per-hit cap holds", () => {
		const untouched = attachRelated([hitFor("z.ts", "hello")], [edge]);
		expect("related" in (untouched[0] as object)).toBe(false);
		const many: RelationEdge[] = Array.from({ length: MAX_RELATED_PER_HIT + 2 }, (_, index) => ({ ...edge, from: `s${index}.ts` }));
		expect(attachRelated([hitFor("b.ts", "hello")], many)[0]?.related).toHaveLength(MAX_RELATED_PER_HIT);
	});

	test("recallMemories carries related metadata on the reply", async () => {
		const fake = new HindsightFake();
		fake.banks.set("sub-cursor", {
			mode: "chunks",
			memories: [{ id: "m1", text: "fence the lease", document_id: "b.ts", tags: [], metadata: {}, score: 0.9 }],
		});
		const reply = await recallMemories({ config: CONFIG, banks: ["sub-cursor"], fetchImpl: fake.fetch, relations: [edge] }, "lease", "cursor");
		expect(reply.results).toHaveLength(1);
		expect(reply.results[0]?.text).toBe("fence the lease");
		expect(reply.results[0]?.related).toEqual([{ kind: "import", to: "a.ts", source_path: "a.ts", commit: "abc" }]);
	});
});

describe("update loop", () => {
	test("diff adds fresh-only and removes stale-only edges", () => {
		const old = [{ kind: "import" as const, from: "a.ts", to: "b.ts" }];
		const fresh = [{ kind: "import" as const, from: "a.ts", to: "c.ts" }];
		expect(diffRelations(old, fresh)).toEqual({ added: fresh, removed: old });
		expect(diffRelations(fresh, fresh)).toEqual({ added: [], removed: [] });
	});

	test("sync retains added and deletes removed; re-sync is a no-op", async () => {
		const fake = setup();
		const old = [{ kind: "import" as const, from: "a.ts", to: "b.ts" }];
		const fresh = [{ kind: "import" as const, from: "a.ts", to: "c.ts" }];
		await retainMemories(CONFIG, BANK, toRetainItems(old, { commit: "abc" }), fake.fetch);
		const synced = await syncRelations(CONFIG, BANK, old, fresh, { commit: "abc2", fetchImpl: fake.fetch });
		expect(synced).toEqual({ ok: true, value: { added: 1, removed: 1 } });
		const ids = (fake.banks.get(BANK)?.memories ?? []).map((memory) => memory.document_id);
		expect(ids).toEqual([relationDocumentId("a.ts", "c.ts", "import")]);
		expect(fake.requests.some((request) => request.method === "DELETE" && request.path.includes(encodeURIComponent(relationDocumentId("a.ts", "b.ts", "import"))))).toBe(true);
		const requestsBefore = fake.requests.length;
		expect(await syncRelations(CONFIG, BANK, fresh, fresh, { commit: "abc2", fetchImpl: fake.fetch })).toEqual({ ok: true, value: { added: 0, removed: 0 } });
		expect(fake.requests.length).toBe(requestsBefore);
	});

	test("retained episodes parse back into edges for the join", async () => {
		const fake = setup();
		await retainMemories(CONFIG, BANK, toRetainItems([{ kind: "import", from: "a.ts", to: "b.ts" }], { commit: "abc" }), fake.fetch);
		const recalled = await fake.fetch(new URL("/v1/default/banks/sub-relations/memories/recall", "http://fake"), {
			method: "POST",
			headers: { authorization: "Bearer test-bearer", "content-type": "application/json" },
			body: JSON.stringify({ query: "a" }),
		}).then((response) => response.json() as Promise<{ results: Parameters<typeof edgesFromRelationHits>[0] }>);
		const edges = edgesFromRelationHits(recalled.results);
		expect(edges).toEqual([{ kind: "import", from: "a.ts", to: "b.ts", source_path: "a.ts", commit: "abc" }]);
		expect(edgesFromRelationHits([{ id: "m", text: "plain memory", tags: [], metadata: {} }])).toEqual([]);
	});
});

describe("bank ownership", () => {
	test("relations bank is prefix plus extractor surface", () => {
		expect(RELATION_BANK_SURFACE).toBe("relations");
		expect(relationBank(CONFIG)).toBe("sub-relations");
		expect(relationBank(CONFIG)).toBe(bankForSurface(CONFIG, RELATION_BANK_SURFACE));
	});
});
