/**
 * `memory_search`'s read side, proven against a real Postgres: the literal
 * `subject_prefix` filter and the `(before, before_id)` keyset cursor.
 *
 * Live for the reason `index-store.memory.test.ts` gives: what is under test is
 * SQL — `left()` against LIKE metacharacters, `now()` handing one timestamp to a
 * whole transaction, and microseconds a JS `Date` cannot carry — and a fake would
 * reproduce none of it.
 *
 *     SUBSTRATE_TEST_PG_URL=postgres://… bun test index-store.search
 *
 * Rows are inserted directly, because the timestamps are the point and the gate
 * stamps its own. Every body carries `MARKER`, every row sits in a run-scoped
 * scope, and `afterAll` removes them.
 */
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { IndexStore } from "./index-store.ts";
import type { MemoryEntry, MemorySearchCursor } from "./types.ts";

const PG_URL = process.env.SUBSTRATE_TEST_PG_URL?.trim();
const RUN = Date.now().toString(36);
const MARKER = `ut-searchtest-${RUN}`;

let store: IndexStore;
let raw: SQL;

const describeLive = PG_URL ? describe : describe.skip;

interface Row {
	id: string;
	scope: string;
	subject: string | null;
	body: string;
	created: string;
	superseded_by?: string;
}

async function insert(rows: readonly Row[]): Promise<void> {
	for (const row of rows) {
		await raw`
			insert into memory_entries (id, scope, kind, body, subject, writer, entry_hash, version, superseded_by, created)
			values (${row.id}, ${row.scope}, 'fact', ${row.body}, ${row.subject}, 'hermes', ${`hash-${row.id}`}, 1,
			        ${row.superseded_by ?? null}, ${row.created}::timestamptz)`;
	}
}

/** Every page of a prefix listing, following `next` until it is null. */
async function pageThrough(scope: string, subjectPrefix: string, limit: number) {
	const seen: MemoryEntry[] = [];
	const cursors: MemorySearchCursor[] = [];
	let cursor: MemorySearchCursor | null = null;
	for (let page = 0; page < 100; page++) {
		const got = await store.searchMemoryPage({
			scope,
			subjectPrefix,
			limit,
			...(cursor ? { before: cursor.before, beforeId: cursor.before_id } : {}),
		});
		seen.push(...got.entries);
		if (!got.next) return { seen, cursors };
		cursors.push(got.next);
		cursor = got.next;
	}
	throw new Error("the cursor never ended");
}

describeLive("memory search against a live index", () => {
	beforeAll(async () => {
		store = new IndexStore(PG_URL!);
		raw = new SQL(PG_URL!);
		await store.migrate();
	});

	afterAll(async () => {
		if (!PG_URL) return;
		await raw`delete from memory_entries where body like ${`%${MARKER}%`}`.catch(() => undefined);
		await raw.end().catch(() => undefined);
		await store.close().catch(() => undefined);
	});

	test("subject_prefix matches only that prefix, with LIKE metacharacters taken literally", async () => {
		const scope = `repo:searchtest-${RUN}/prefix`;
		const subjects = [
			"lesson:v1.2/15/a",
			"lesson:v1.2/15/b",
			"lessonxv1.2",
			"lesson-digest:v1.2",
			"les_on:z",
			"lesson%:q",
			"50%_off\\x",
			"50%_offy",
		];
		await insert(
			subjects.map((subject, i) => ({
				id: `mem_${MARKER}_p${i}`,
				scope,
				subject,
				body: `${MARKER} prefix ${i}`,
				created: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
			})),
		);
		// One with no subject at all, which no prefix matches.
		await insert([{ id: `mem_${MARKER}_pnull`, scope, subject: null, body: `${MARKER} no subject`, created: "2026-01-01T00:01:00Z" }]);

		const subjectsFor = async (subjectPrefix: string) =>
			(await store.searchMemoryPage({ scope, subjectPrefix, limit: 100 })).entries.map((entry) => entry.subject).sort();

		expect(await subjectsFor("lesson:")).toEqual(["lesson:v1.2/15/a", "lesson:v1.2/15/b"]);
		// As LIKE patterns, `_` would match the `s` of every `lesson…` and `%` would match anything.
		expect(await subjectsFor("les_on:")).toEqual(["les_on:z"]);
		expect(await subjectsFor("lesson%")).toEqual(["lesson%:q"]);
		expect(await subjectsFor("50%_off\\")).toEqual(["50%_off\\x"]);
		expect(await subjectsFor("lesson-digest:")).toEqual(["lesson-digest:v1.2"]);
		expect(await subjectsFor("nothing-starts-like-this")).toEqual([]);
	});

	test("the cursor pages through more than 100 entries with no gap and no repeat, through shared timestamps", async () => {
		const scope = `repo:searchtest-${RUN}/cursor`;
		const total = 257;
		// Seven entries per timestamp, as one transaction's `now()` would stamp them, and
		// four timestamps per millisecond: a cursor cut to the millisecond, or one on the
		// timestamp alone, would skip or repeat across these boundaries.
		const base = Date.UTC(2026, 1, 1);
		const rows: Row[] = [];
		for (let i = 0; i < total; i++) {
			const micros = Math.floor(i / 7) * 250;
			const ms = base + Math.floor(micros / 1000);
			const fraction = String(micros % 1000).padStart(3, "0");
			const created = `${new Date(ms).toISOString().slice(0, 23)}${fraction}Z`;
			// Ids out of insertion order, so the tie-break is not the insertion order in disguise.
			const id = `mem_${MARKER}_c${String((i * 37) % total).padStart(3, "0")}`;
			rows.push({ id, scope, subject: `lesson:v1.2/cursor/${i}`, body: `${MARKER} cursor ${i}`, created });
		}
		await insert(rows);
		// A neighbour in the scope the prefix must leave out.
		await insert([{ id: `mem_${MARKER}_cother`, scope, subject: "note:other", body: `${MARKER} other`, created: "2026-02-01T00:00:00.000100Z" }]);

		const expected = (
			(await raw`
				select id from memory_entries where scope = ${scope} and subject like 'lesson:%'
				order by created desc, id desc`) as Array<{ id: string }>
		).map((row) => row.id);
		expect(expected).toHaveLength(total);

		for (const limit of [100, 33, 7]) {
			const { seen, cursors } = await pageThrough(scope, "lesson:", limit);
			const ids = seen.map((entry) => entry.id);
			expect(ids).toEqual(expected);
			expect(new Set(ids).size).toBe(total);
			// Every full page hands back a pair, including a last page that is exactly full,
			// whose pair leads to one empty page and a null.
			expect(cursors).toHaveLength(Math.floor(total / limit));
			// The cursor carries the microseconds the index stores.
			for (const cursor of cursors) expect(cursor.before).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
		}

		// `before` alone is strictly before the instant: the whole tie at it is left out,
		// and the page starts at the newest entry older than it.
		const tie = rows[14]!.created;
		const after = await store.searchMemoryPage({ scope, subjectPrefix: "lesson:", before: tie, limit: 100 });
		const createdOf = new Map(rows.map((row) => [row.id, row.created] as const));
		expect(after.entries.some((entry) => createdOf.get(entry.id) === tie)).toBe(false);
		expect(after.entries.map((entry) => entry.id)).toEqual(expected.filter((id) => createdOf.get(id)! < tie));
	}, 60_000);

	test("keyset boundaries compose with literal prefixes, full text, scope and retired history", async () => {
		const scope = `repo:searchtest-${RUN}/combined`;
		const subjectPrefix = "lesson:%_\\/";
		const id = (suffix: string) => `mem_${MARKER}_combined_${suffix}`;
		const tie = "2026-02-02T00:00:00.123456Z";
		const matching = { scope, subject: `${subjectPrefix}match`, body: `${MARKER} quartz`, created: tie };
		await insert([
			{ ...matching, id: id("z"), created: "2026-02-02T00:00:00.123457Z" },
			{ ...matching, id: id("y"), superseded_by: id("z") },
			{ ...matching, id: id("x"), subject: "lesson:anything/match" },
			{ ...matching, id: id("w"), body: `${MARKER} granite` },
			{ ...matching, id: id("v") },
			{ ...matching, id: id("u") },
			{ ...matching, id: id("t"), created: "2026-02-02T00:00:00.123455Z" },
			{ ...matching, id: id("s"), subject: null },
			{ ...matching, id: id("r"), scope: `${scope}/neighbour` },
		]);

		for (const scoped of [true, false]) {
			for (const includeSuperseded of [false, true]) {
				const search = { query: `${MARKER} quartz`, subjectPrefix, includeSuperseded, ...(scoped ? { scope } : {}) };
				const expected = ["z", ...(includeSuperseded ? ["y"] : []), "v", "u", ...(scoped ? [] : ["r"]), "t"].map(id);
				const seen: string[] = [];
				let cursor: MemorySearchCursor | null = null;
				for (let page = 0; page < 10; page++) {
					const result = await store.searchMemoryPage({
						...search,
						limit: 2,
						...(cursor ? { before: cursor.before, beforeId: cursor.before_id } : {}),
					});
					seen.push(...result.entries.map((entry) => entry.id));
					cursor = result.next;
					if (!cursor) break;
				}
				expect(cursor).toBeNull();
				expect(seen).toEqual(expected);
				const beforeOnly = await store.searchMemoryPage({ ...search, before: tie, limit: 100 });
				expect(beforeOnly.entries.map((entry) => entry.id)).toEqual([id("t")]);
			}
		}

		// A boundary is a value pair, not a lookup of a still-existing entry.
		const missingBoundary = await store.searchMemoryPage({
			scope, query: `${MARKER} quartz`, subjectPrefix, before: tie, beforeId: `${id("v")}0`, limit: 100,
		});
		expect(missingBoundary.entries.map((entry) => entry.id)).toEqual(["v", "u", "t"].map(id));
	});

	test("with neither new parameter the search is what it was: newest first, superseded left out", async () => {
		// 130 rows, every even one a lesson; the newest lesson, n128, has been superseded.
		const scope = `repo:searchtest-${RUN}/plain`;
		const rows: Row[] = [];
		for (let i = 0; i < 130; i++) {
			rows.push({
				id: `mem_${MARKER}_n${String(i).padStart(3, "0")}`,
				scope,
				subject: i % 2 === 0 ? `lesson:v1.2/plain/${i}` : null,
				body: `${MARKER} ${i % 3 === 0 ? "heartbeat" : "warm cache"} ${i}`,
				created: new Date(Date.UTC(2026, 2, 1, 0, 0, i)).toISOString(),
				...(i === 128 ? { superseded_by: `mem_${MARKER}_n129` } : {}),
			});
		}
		await insert(rows);

		/** The statement `searchMemory` ran before paging existed. */
		const before = async (query: string, limit: number, includeSuperseded = false) =>
			(
				(await raw`
					select id from memory_entries
					where scope = ${scope}
					  and (${includeSuperseded}::boolean or superseded_by is null)
					  and (${query} = '' or to_tsvector('english', body) @@ plainto_tsquery('english', ${query}))
					order by created desc
					limit ${limit}`) as Array<{ id: string }>
			).map((row) => row.id);

		for (const [query, limit] of [["", 100], ["heartbeat", 20], ["warm cache", 100], ["", 20]] as const) {
			const now = (await store.searchMemory(query, scope, limit)).map((entry) => entry.id);
			expect(now).toEqual(await before(query, limit));
		}
		expect((await store.searchMemory("", scope, 100)).map((entry) => entry.id)).not.toContain(`mem_${MARKER}_n128`);
		expect((await store.searchMemory("", scope, 100, true)).map((entry) => entry.id)).toEqual(await before("", 100, true));

		// The paged read keeps the same visibility: the superseded lesson stays out of a listing.
		const listed = await pageThrough(scope, "lesson:", 100);
		expect(listed.seen).toHaveLength(64);
		expect(listed.seen.map((entry) => entry.id)).not.toContain(`mem_${MARKER}_n128`);
		const withRetired = await store.searchMemoryPage({ scope, subjectPrefix: "lesson:", limit: 100, includeSuperseded: true });
		expect(withRetired.entries[0]?.id).toBe(`mem_${MARKER}_n128`);
	}, 60_000);
});
