/**
 * The telemetry, feedback and gap tables against a real Postgres: the append, the bounded oldest-first sweep, the upsert that
 * keeps one verdict per document and session, the grouped counts and the gap aggregate. None of that can be shown against a
 * fake, so these tests skip unless a database is given:
 *
 *     SUBSTRATE_TEST_PG_URL=postgres://… bun test corpus/reflect-store
 *
 * The tables are the real migration (step 38); every row is namespaced to one run's marker and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { IndexStore } from "../index-store.ts";
import { defined } from "../test-support.ts";
import type { ReflectStore, RetrievalRow } from "./reflect-store.ts";

const PG_URL = process.env.SUBSTRATE_TEST_PG_URL?.trim();
const MARKER = `ut-reflect-${Date.now().toString(36)}`;
const describeLive = PG_URL ? describe : describe.skip;

let index: IndexStore;
let store: ReflectStore;
let cleanup: SQL;

function row(queryHash: string, over: Partial<RetrievalRow> = {}): RetrievalRow {
	return { surface: MARKER, queryHash: `${MARKER}-${queryHash}`, queryText: `text of ${queryHash}`, backend: "lightrag", returned: [], topScore: null, returnedCount: 0, degraded: false, rerank: null, ...over };
}

describeLive("the reflect tables against a live index", () => {
	beforeAll(async () => {
		index = new IndexStore(defined(PG_URL, "SUBSTRATE_TEST_PG_URL"));
		await index.migrate();
		store = index.reflectStore();
		cleanup = new SQL(defined(PG_URL, "SUBSTRATE_TEST_PG_URL"));
	});

	afterAll(async () => {
		if (!PG_URL) return;
		await cleanup`delete from corpus_retrievals where surface = ${MARKER}`.catch(() => undefined);
		await cleanup`delete from corpus_feedback where document_key like ${`${MARKER}%`}`.catch(() => undefined);
		await cleanup`delete from corpus_documents where repo like ${`${MARKER}%`}`.catch(() => undefined);
		await cleanup.close().catch(() => undefined);
		await index.close().catch(() => undefined);
	});

	test("a retrieval row round-trips with its returned keys, scores, shadow note and degraded flag", async () => {
		await store.appendRetrieval(
			row("round-trip", {
				returned: [{ key: "acme/app:docs/a.md", score: 0.5 }],
				topScore: 0.5,
				returnedCount: 1,
				rerank: { mode: "shadow", order: ["acme/app:docs/a.md"], moved: 0 },
			}),
		);
		const rows = await cleanup`select * from corpus_retrievals where query_hash = ${`${MARKER}-round-trip`}`;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ surface: MARKER, query_text: "text of round-trip", backend: "lightrag", top_score: 0.5, returned_count: 1, degraded: false });
		expect(rows[0]?.returned).toEqual([{ key: "acme/app:docs/a.md", score: 0.5 }]);
		expect(rows[0]?.rerank).toEqual({ mode: "shadow", order: ["acme/app:docs/a.md"], moved: 0 });
	});

	test("a null query text and a null shadow note are stored as null", async () => {
		await store.appendRetrieval(row("nulls", { queryText: null }));
		const rows = await cleanup`select query_text, rerank, top_score from corpus_retrievals where query_hash = ${`${MARKER}-nulls`}`;
		expect(rows[0]).toMatchObject({ query_text: null, rerank: null, top_score: null });
	});

	test("the sweep deletes only rows older than the retention, oldest first, and never more than the batch", async () => {
		for (let i = 0; i < 5; i += 1) {
			await cleanup`
				insert into corpus_retrievals (at, surface, query_hash, backend, returned, returned_count)
				values (now() - make_interval(days => ${3000 + i}), ${MARKER}, ${`${MARKER}-ancient-${i}`}, 'lightrag', '[]'::jsonb, 0)`;
		}
		expect(await store.sweepRetrievals(365, 3)).toBe(3);
		const left = await cleanup`select query_hash from corpus_retrievals where surface = ${MARKER} and query_hash like ${`${MARKER}-ancient-%`} order by at`;
		// The three oldest went first: ancient-4, -3 and -2.
		expect(left.map((entry: { query_hash: string }) => entry.query_hash)).toEqual([`${MARKER}-ancient-1`, `${MARKER}-ancient-0`]);
		expect(await store.sweepRetrievals(365, 1000)).toBeGreaterThanOrEqual(2);
		const rest = await cleanup`select count(*)::int as n from corpus_retrievals where surface = ${MARKER} and query_hash like ${`${MARKER}-ancient-%`}`;
		expect(rest[0]?.n).toBe(0);
		// A recent row is untouched.
		const recent = await cleanup`select count(*)::int as n from corpus_retrievals where query_hash = ${`${MARKER}-round-trip`}`;
		expect(recent[0]?.n).toBe(1);
	});

	/** A manifest row for one document of the marker's repository, so its votes are counted. */
	async function activeDoc(repo: string, path: string, state: "active" | "tombstoned" = "active"): Promise<void> {
		await cleanup`
			insert into corpus_documents (repo, path, kind, tier, sha256, bytes, source, state)
			values (${repo}, ${path}, 'doc', 1, ${"0".repeat(64)}, 1, 'fs', ${state})
			on conflict (repo, path) do nothing`;
	}

	test("feedback is one verdict per document and session, the latest wins, and the counts are grouped per document", async () => {
		const repo = `${MARKER}/app`;
		const doc = `${repo}:docs/a.md`;
		const other = `${repo}:docs/b.md`;
		await activeDoc(repo, "docs/a.md");
		await activeDoc(repo, "docs/b.md");
		await store.upsertFeedback({ documentKey: doc, sessionId: "omp/s1", verdict: "stale", surface: "omp" });
		await store.upsertFeedback({ documentKey: doc, sessionId: "omp/s1", verdict: "helpful", surface: "omp" });
		await store.upsertFeedback({ documentKey: doc, sessionId: "omp/s2", verdict: "stale", surface: "omp" });
		await store.upsertFeedback({ documentKey: doc, sessionId: "claude-code/s1", verdict: "wrong", surface: "claude-code" });
		await store.upsertFeedback({ documentKey: other, sessionId: "omp/s1", verdict: "duplicate", surface: "omp" });
		const counts = await store.feedbackCounts(5000);
		// omp counts once, with its latest verdict (s2's stale); claude-code's wrong is its own vote.
		expect(counts.get(doc)).toEqual({ helpful: 0, unhelpful: 0, stale: 1, wrong: 1, duplicate: 0 });
		expect(counts.get(other)).toEqual({ helpful: 0, unhelpful: 0, stale: 0, wrong: 0, duplicate: 1 });
		const rows = await cleanup`select count(*)::int as n from corpus_feedback where document_key = ${doc}`;
		expect(rows[0]?.n).toBe(3);
	});

	test("one surface posting under many sessions counts once: its latest verdict, never the sum", async () => {
		const doc = `${MARKER}/stack:docs/x.md`;
		await activeDoc(`${MARKER}/stack`, "docs/x.md");
		for (const session of ["a", "b", "c", "d"]) await store.upsertFeedback({ documentKey: doc, sessionId: `omp/${session}`, verdict: "stale", surface: "omp" });
		expect((await store.feedbackCounts(5000)).get(doc)).toEqual({ helpful: 0, unhelpful: 0, stale: 1, wrong: 0, duplicate: 0 });
	});

	test("a document with no active manifest row is not counted, so its votes cannot take a slot of the bound", async () => {
		const tombstoned = `${MARKER}/gone:docs/t.md`;
		const absent = `${MARKER}/gone:docs/absent.md`;
		await activeDoc(`${MARKER}/gone`, "docs/t.md", "tombstoned");
		await store.upsertFeedback({ documentKey: tombstoned, sessionId: "omp/s1", verdict: "wrong", surface: "omp" });
		await store.upsertFeedback({ documentKey: absent, sessionId: "omp/s1", verdict: "wrong", surface: "omp" });
		const counts = await store.feedbackCounts(5000);
		expect(counts.has(tombstoned)).toBe(false);
		expect(counts.has(absent)).toBe(false);
	});

	test("the counts are bounded to the most recently voted documents", async () => {
		const bounded = await store.feedbackCounts(1);
		expect(bounded.size).toBe(1);
	});

	test("the shadow report counts the searches that carry a shadow note and lists the largest moves, never degraded ones", async () => {
		await cleanup`delete from corpus_retrievals where surface = ${MARKER}`;
		const shadow = (moved: number, order: string[]) => ({ mode: "shadow" as const, order, moved });
		await store.appendRetrieval(row("shadow-none", { rerank: shadow(0, [`${MARKER}/app:docs/a.md`]) }));
		await store.appendRetrieval(row("shadow-small", { rerank: shadow(1, [`${MARKER}/app:docs/b.md`]) }));
		await store.appendRetrieval(row("shadow-large", { queryText: null, rerank: shadow(4, [`${MARKER}/app:docs/c.md`, `${MARKER}/app:docs/d.md`]) }));
		await store.appendRetrieval(row("shadow-down", { degraded: true, rerank: shadow(9, []) }));
		await store.appendRetrieval(row("unshadowed"));
		const report = await store.shadowReport({ days: 30, limit: 5000 });
		const mine = report.largest.filter((entry) => entry.queryHash.startsWith(MARKER));
		expect(mine.map((entry) => ({ hash: entry.queryHash, moved: entry.moved, order: entry.order, text: entry.text }))).toEqual([
			{ hash: `${MARKER}-shadow-large`, moved: 4, order: [`${MARKER}/app:docs/c.md`, `${MARKER}/app:docs/d.md`], text: null },
			{ hash: `${MARKER}-shadow-small`, moved: 1, order: [`${MARKER}/app:docs/b.md`], text: "text of shadow-small" },
		]);
		expect(report.searches).toBeGreaterThanOrEqual(3);
		expect(report.movedSearches).toBeGreaterThanOrEqual(2);
		expect(report.moved).toBeGreaterThanOrEqual(5);
		expect((await store.shadowReport({ days: 30, limit: 1 })).largest).toHaveLength(1);
	});

	test("a verdict outside the closed list is refused by the table", async () => {
		const refused = (async () => {
			await cleanup`insert into corpus_feedback (document_key, session_id, verdict, surface) values (${`${MARKER}/app:x.md`}, 's', 'great', 'omp')`;
		})();
		await expect(refused).rejects.toThrow();
	});

	test("the gap aggregate lists a query whose best score was none or low, leaves out answered, degraded and old searches, and orders by searches", async () => {
		// Rows an earlier test of this file left under the same marker are gaps too; start from none.
		await cleanup`delete from corpus_retrievals where query_hash like ${`${MARKER}%`}`;
		await store.appendRetrieval(row("gap-none"));
		await store.appendRetrieval(row("gap-none"));
		await store.appendRetrieval(row("gap-none", { queryText: "the newest text" }));
		await store.appendRetrieval(row("gap-low", { topScore: 0.1, returnedCount: 1 }));
		await store.appendRetrieval(row("answered", { topScore: 0.9, returnedCount: 1 }));
		await store.appendRetrieval(row("mixed", { topScore: 0.1, returnedCount: 1 }));
		await store.appendRetrieval(row("mixed", { topScore: 0.6, returnedCount: 1 }));
		await store.appendRetrieval(row("down", { degraded: true }));
		await cleanup`
			insert into corpus_retrievals (at, surface, query_hash, backend, returned, returned_count)
			values (now() - make_interval(days => 45), ${MARKER}, ${`${MARKER}-too-old`}, 'lightrag', '[]'::jsonb, 0)`;
		const gaps = (await store.gaps({ gapScore: 0.2, days: 30, limit: 5000 })).filter((gap) => gap.queryHash.startsWith(MARKER));
		expect(gaps.map((gap) => gap.queryHash)).toEqual([`${MARKER}-gap-none`, `${MARKER}-gap-low`]);
		expect(gaps[0]).toMatchObject({ searches: 3, best: null, text: "the newest text" });
		expect(gaps[1]).toMatchObject({ searches: 1 });
		expect(defined(gaps[1], "the low gap").best).toBeCloseTo(0.1, 5);
		expect(typeof gaps[0]?.lastSeen).toBe("string");
		expect((await store.gaps({ gapScore: 0.2, days: 30, limit: 1 })).length).toBe(1);
		// With the gap score at zero nothing scores below it, but a query that returned no citation is still a gap.
		const atZero = (await store.gaps({ gapScore: 0, days: 30, limit: 5000 })).filter((gap) => gap.queryHash.startsWith(MARKER));
		expect(atZero.map((gap) => gap.queryHash)).toEqual([`${MARKER}-gap-none`]);
	});
});
