/**
 * The index half of the forget primitive (v1.6, phase 57, unit b): `markMemoryForgotten`,
 * `memoryEntriesCreatedAfter` and `memoryDocumentShared`, and what every memory reader does with a row whose
 * `superseded_by` holds a forget marker.
 *
 * Two layers, like the migrate suites:
 *
 *   - Against a recording fake connection (`IndexStoreOptions.sql`), always run: the exact statements and their
 *     parameters, the argument validation, and the predicates each reader sends. No database.
 *   - Against a real Postgres, skipped unless `SUBSTRATE_TEST_PG_URL` is set: what the statements DO (the mark
 *     is one conditional update, the rollback cut is strict and ordered, a forgotten row leaves the brief and the
 *     search but stays readable, the standing identity is freed, the sweeper's lifetime read skips it).
 *
 *     SUBSTRATE_TEST_PG_URL=postgres://… bun test index-store.memory-forget
 *
 * Every live row carries `RUN` in its id; `afterAll` removes them.
 */
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { IndexStore } from "./index-store.ts";
import { DEFAULT_SWEEP_POLICY } from "./index-sweep.ts";
import {
	forgetEntries,
	forgetIdFor,
	forgetMarker,
	isForgetMarker,
	MAX_FORGET_ENTRIES,
	MAX_ROLLBACK_SELECT_LIMIT,
	selectForRollback,
	type ForgetDeps,
} from "./memory-forget.ts";
import { defined } from "./test-support.ts";

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();
const MARKER = forgetMarker(`fg_${"a".repeat(26)}`);

interface Statement {
	text: string;
	params: unknown[];
}

/**
 * A recording stand-in for the connection. A tagged call builds a composable fragment (nested `sql\`\`` fragments and
 * `sql(array)` value lists are flattened into `$n` placeholders, as the driver does) that runs the handler when awaited.
 */
function fakeSql(handler: (statement: Statement) => Array<Record<string, unknown>> = () => []) {
	const statements: Statement[] = [];
	class ValueList {
		constructor(readonly values: readonly unknown[]) {}
	}
	class Fragment {
		constructor(
			readonly strings: readonly string[],
			readonly values: readonly unknown[],
		) {}
		render(params: unknown[]): string {
			let out = this.strings[0] ?? "";
			this.values.forEach((value, index) => {
				if (value instanceof Fragment) out += value.render(params);
				else if (value instanceof ValueList) {
					out += `(${value.values.map((entry) => `$${params.push(entry)}`).join(",")})`;
				} else out += `$${params.push(value)}`;
				out += this.strings[index + 1] ?? "";
			});
			return out;
		}
		// biome-ignore lint/suspicious/noThenProperty: deliberate thenable fake; the driver's tagged-template fragments run when awaited
		then(resolve: (rows: Array<Record<string, unknown>>) => unknown, reject: (cause: unknown) => unknown): Promise<unknown> {
			const params: unknown[] = [];
			const statement = { text: squash(this.render(params)), params };
			statements.push(statement);
			return Promise.resolve()
				.then(() => handler(statement))
				.then(resolve, reject);
		}
	}
	const sql = ((first: unknown, ...values: unknown[]) =>
		Array.isArray(first) && "raw" in first ? new Fragment(first as readonly string[], values) : new ValueList(first as unknown[])) as unknown as SQL;
	return { sql, statements };
}

function store(handler?: (statement: Statement) => Array<Record<string, unknown>>) {
	const fake = fakeSql(handler);
	return { index: new IndexStore("postgres://unused.invalid/index", { sql: fake.sql }), statements: fake.statements };
}

const row = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
	id,
	scope: "repo:acme/app",
	kind: "fact",
	body: `body of ${id}`,
	writer: "claude-code",
	actor: "agent",
	trust: "agent-claimed",
	ttl: "permanent",
	created: "2026-10-20T12:00:01.000Z",
	version: 1,
	entry_hash: `h-${id}`,
	...over,
});

describe("markMemoryForgotten against a fake connection", () => {
	test("one conditional update: sets the marker where superseded_by is null, returns what it changed", async () => {
		const { index, statements } = store(() => [{ id: "mem_a" }, { id: "mem_c" }]);
		expect(await index.markMemoryForgotten(["mem_a", "mem_b", "mem_c"], MARKER)).toEqual(["mem_a", "mem_c"]);
		expect(statements).toEqual([
			{
				text: "update memory_entries set superseded_by = $1, forgotten_at = now() where id in ($2,$3,$4) and superseded_by is null returning id",
				params: [MARKER, "mem_a", "mem_b", "mem_c"],
			},
		]);
	});

	test("duplicate ids collapse, an empty list sends nothing, and the id bound is the call bound", async () => {
		const { index, statements } = store();
		await index.markMemoryForgotten(["mem_a", "mem_a"], MARKER);
		expect(statements[0]?.params).toEqual([MARKER, "mem_a"]);
		expect(await index.markMemoryForgotten([], MARKER)).toEqual([]);
		expect(statements).toHaveLength(1);
		const many = Array.from({ length: MAX_FORGET_ENTRIES + 1 }, (_, i) => `mem_${i}`);
		await expect(index.markMemoryForgotten(many, MARKER)).rejects.toThrow(/exceeds the 200-id bound/);
		await expect(index.markMemoryForgotten(many.slice(0, MAX_FORGET_ENTRIES), MARKER)).resolves.toEqual([]);
	});

	test("only a well-formed forget marker is ever written: an entry id, a raw string or an injection attempt is refused before any SQL", async () => {
		const { index, statements } = store();
		for (const bad of ["mem_a", "", "forgotten:", "forgotten:fg_short", `${MARKER}'; drop table memory_entries; --`, "fg_aaaaaaaaaaaaaaaaaaaaaaaaaa"]) {
			await expect(index.markMemoryForgotten(["mem_a"], bad)).rejects.toThrow(/not a forget marker/);
		}
		expect(statements).toEqual([]);
	});

	test("a second call over the same ids is the same statement and changes nothing the first one did not", async () => {
		let rows = [{ id: "mem_a" }];
		const { index, statements } = store(() => {
			const answer = rows;
			rows = []; // the database changes a row once: superseded_by is no longer null afterwards
			return answer;
		});
		expect(await index.markMemoryForgotten(["mem_a"], MARKER)).toEqual(["mem_a"]);
		expect(await index.markMemoryForgotten(["mem_a"], MARKER)).toEqual([]);
		expect(statements[0]).toEqual(statements[1] as Statement);
	});
});

describe("memoryEntriesCreatedAfter against a fake connection", () => {
	const SELECT = "select * from memory_entries where session_id = $1";
	const TAIL = "and superseded_by is null and date_trunc('milliseconds', created) > $";
	const ORDER = "::timestamptz order by created asc, id asc limit $";

	test("session scope, not superseded, strictly after the instant in whole milliseconds, ordered, limit + 1", async () => {
		const { index, statements } = store();
		const found = await index.memoryEntriesCreatedAfter("sess-1", "2026-10-20T12:00:00.123456Z");
		expect(found).toEqual({ entries: [], truncated: false });
		expect(statements).toEqual([
			{ text: `${SELECT} ${TAIL}2${ORDER}3`, params: ["sess-1", "2026-10-20T12:00:00.123Z", 1001] },
		]);
	});

	test("a graph narrows the same query", async () => {
		const { index, statements } = store();
		await index.memoryEntriesCreatedAfter("sess-1", "2026-10-20T12:00:00.000Z", "g-9", 25);
		expect(statements[0]).toEqual({
			text: `${SELECT} and graph_id = $2 ${TAIL}3${ORDER}4`,
			params: ["sess-1", "g-9", "2026-10-20T12:00:00.000Z", 26],
		});
	});

	test("an upper bound adds an inclusive whole-millisecond predicate before the order, and the limit stays last", async () => {
		const { index, statements } = store();
		await index.memoryEntriesCreatedAfter("sess-1", "2026-10-20T12:00:00.000Z", null, 5, "2026-10-20T13:00:00.789123Z");
		expect(statements).toEqual([
			{
				text: `${SELECT} ${TAIL}2::timestamptz and date_trunc('milliseconds', created) <= $3::timestamptz order by created asc, id asc limit $4`,
				params: ["sess-1", "2026-10-20T12:00:00.000Z", "2026-10-20T13:00:00.789Z", 6],
			},
		]);
		await index.memoryEntriesCreatedAfter("sess-1", "2026-10-20T12:00:00.000Z", "g-9", 5, "2026-10-20T12:00:00.000Z");
		expect(statements[1]?.params).toEqual(["sess-1", "g-9", "2026-10-20T12:00:00.000Z", "2026-10-20T12:00:00.000Z", 6]);
	});

	test("refuses an unparseable upper bound and one before the lower bound, before any SQL", async () => {
		const { index, statements } = store();
		await expect(index.memoryEntriesCreatedAfter("sess-1", "2026-10-20T12:00:00.000Z", null, 5, "later")).rejects.toThrow(/not an instant/);
		await expect(index.memoryEntriesCreatedAfter("sess-1", "2026-10-20T12:00:00.000Z", null, 5, "2026-10-20T11:59:59.999Z")).rejects.toThrow(/upper bound is before/);
		expect(statements).toEqual([]);
	});

	test("one row over the limit means truncated, and the extra row is not returned", async () => {
		const { index } = store((statement) => {
			const limit = Number(statement.params.at(-1)) - 1;
			return Array.from({ length: limit + 1 }, (_, i) => row(`mem_${i}`));
		});
		const found = await index.memoryEntriesCreatedAfter("sess-1", "2026-10-20T12:00:00.000Z", null, 3);
		expect(found.truncated).toBe(true);
		expect(found.entries.map((entry) => entry.id)).toEqual(["mem_0", "mem_1", "mem_2"]);
		const exact = store((statement) => Array.from({ length: Number(statement.params.at(-1)) - 1 }, (_, i) => row(`mem_${i}`)));
		expect((await exact.index.memoryEntriesCreatedAfter("sess-1", "2026-10-20T12:00:00.000Z", null, 3)).truncated).toBe(false);
	});

	test("refuses a missing session, a bad instant and a bad limit before any SQL", async () => {
		const { index, statements } = store();
		const after = "2026-10-20T12:00:00.000Z";
		await expect(index.memoryEntriesCreatedAfter("", after)).rejects.toThrow(/session is required/);
		await expect(index.memoryEntriesCreatedAfter("sess-1", "yesterday")).rejects.toThrow(/not an instant/);
		await expect(index.memoryEntriesCreatedAfter("sess-1", after, "")).rejects.toThrow(/graphId is empty/);
		for (const limit of [0, -1, 1.5, MAX_ROLLBACK_SELECT_LIMIT + 1, Number.NaN]) {
			await expect(index.memoryEntriesCreatedAfter("sess-1", after, null, limit)).rejects.toThrow(/limit must be an integer from 1 to 5000/);
		}
		expect(statements).toEqual([]);
	});

	test("selectForRollback drives it: the store's order and truncation come back as the selection", async () => {
		const { index, statements } = store(() => [row("mem_a"), row("mem_b")]);
		const selection = await selectForRollback(
			{ entriesCreatedAfter: (session, after, graph, limit) => index.memoryEntriesCreatedAfter(session, after, graph, limit) },
			{ session_id: "sess-1", after: "2026-10-20T12:00:00Z", limit: 10 },
		);
		expect(selection).toEqual({ entry_ids: ["mem_a", "mem_b"], truncated: false, after: "2026-10-20T12:00:00.000Z" });
		expect(statements[0]?.params).toEqual(["sess-1", "2026-10-20T12:00:00.000Z", 11]);
	});
});

describe("memoryDocumentShared against a fake connection", () => {
	test("a subject-less entry has a document of its own and sends no SQL", async () => {
		const { index, statements } = store();
		expect(await index.memoryDocumentShared({ id: "mem_a", scope: "global", kind: "fact", writer: "claude-code" })).toBe(false);
		expect(await index.memoryDocumentShared({ id: "mem_a", scope: "global", kind: "fact", subject: "", writer: "claude-code" })).toBe(false);
		expect(statements).toEqual([]);
	});

	test("a subject-addressed entry asks for another live entry of the same writer with the same scope, kind and subject", async () => {
		const { index, statements } = store((statement) => (statement.params.includes("shared") ? [{ shared: 1 }] : []));
		const entry = { id: "mem_a", scope: "repo:acme/app", kind: "decision" as const, writer: "claude-code" };
		expect(await index.memoryDocumentShared({ ...entry, subject: "shared" })).toBe(true);
		expect(await index.memoryDocumentShared({ ...entry, subject: "alone" })).toBe(false);
		// The writer is part of the question: another surface's live twin lives in another bank's document and does not keep this one.
		expect(statements[0]).toEqual({
			text: "select 1 as shared from memory_entries where scope = $1 and kind = $2 and subject = $3 and writer = $4 and id <> $5 and superseded_by is null limit 1",
			params: ["repo:acme/app", "decision", "shared", "claude-code", "mem_a"],
		});
	});
});

describe("forgottenEntryIds against a fake connection", () => {
	test("asks only for rows whose superseded_by is a forget marker, and answers the ids it found", async () => {
		const { index, statements } = store(() => [{ id: "mem_b" }]);
		expect(await index.forgottenEntryIds(["mem_a", "mem_b", "mem_a"])).toEqual(new Set(["mem_b"]));
		expect(statements).toEqual([{ text: "select id from memory_entries where id in ($1,$2) and superseded_by like $3", params: ["mem_a", "mem_b", "forgotten:%"] }]);
	});

	test("no ids sends no SQL, and an unbounded list is refused before any", async () => {
		const { index, statements } = store();
		expect(await index.forgottenEntryIds([])).toEqual(new Set());
		await expect(index.forgottenEntryIds(Array.from({ length: 501 }, (_, i) => `mem_${i}`))).rejects.toThrow(/exceeds the 500-id bound/);
		expect(statements).toEqual([]);
	});
});

describe("every memory reader in the index filters on superseded_by IS NULL, so a forgotten row is out of force", () => {
	test("memory_search leaves a forgotten row out, and only include_superseded brings it back", async () => {
		const plain = store();
		await plain.index.searchMemoryPage({ query: "", limit: 5 });
		expect(plain.statements[0]?.text).toContain("and superseded_by is null");
		const wide = store();
		await wide.index.searchMemoryPage({ query: "", limit: 5, includeSuperseded: true });
		expect(wide.statements[0]?.text).not.toContain("superseded_by");
		const listed = store();
		await listed.index.searchMemory("", undefined, 5, false);
		await listed.index.searchMemory("", undefined, 5, true);
		expect(listed.statements.map((statement) => statement.text.includes("superseded_by is null"))).toEqual([true, false]);
	});

	test("the brief and the standing-entry lookup leave a forgotten row out", async () => {
		const brief = store();
		await brief.index.memoryForBrief("acme/app", "g-1", 5);
		expect(brief.statements[0]?.text).toContain("and superseded_by is null");
		const standing = store();
		expect(await standing.index.standingEntry("key")).toBeNull();
		expect(standing.statements[0]?.text).toContain("conflict_key = $1 and superseded_by is null");
	});

	test("a brief read under a repository grant leaves out a global row of an ungranted repository; a read with no grant keeps every row", async () => {
		const { index } = store(() => [row("mem_b", { scope: "global", repo: "owner/b" }), row("mem_a", { scope: "global", repo: "owner/a" })]);
		const granted = (repo: string): boolean => repo === "owner/a";
		expect((await index.memoryForBrief("owner/a", null, 5, { surface: "cursor", granted })).map((entry) => entry.id)).toEqual(["mem_a"]);
		expect((await index.memoryForBrief("owner/a", null, 5, { surface: "cursor" })).map((entry) => entry.id)).toEqual(["mem_b", "mem_a"]);
	});

	test("a brief read under a grant keeps a graph row that names no repository: its graph is checked before the read, not its missing repo", async () => {
		const { index } = store(() => [row("mem_g", { scope: "graph:ut-1", repo: null }), row("mem_b", { scope: "global", repo: "owner/b" })]);
		const granted = (repo: string): boolean => repo === "owner/a";
		expect((await index.memoryForBrief(null, "ut-1", 5, { surface: "cursor", granted })).map((entry) => entry.id)).toEqual(["mem_g"]);
	});

	test("a forgotten row reads back with its marker, which is what makes the retain replay answer gone", async () => {
		const forgotten = store(() => [row("mem_a", { superseded_by: MARKER })]);
		const entry = await forgotten.index.readEntry("mem_a");
		expect(entry?.superseded_by).toBe(MARKER);
		expect(isForgetMarker(entry?.superseded_by)).toBe(true);
		// The service's replay rule (`current.superseded_by !== undefined`): defined means drop the parked copy.
		expect(entry?.superseded_by !== undefined).toBe(true);
		const live = store(() => [row("mem_b")]);
		expect((await live.index.readEntry("mem_b"))?.superseded_by).toBeUndefined();
	});
});

// ── against a real Postgres ─────────────────────────────────────────────────────────────────────────────────────

const PG_URL = process.env.SUBSTRATE_TEST_PG_URL?.trim();
const describeLive = PG_URL ? describe : describe.skip;
const RUN = `ut-forgettest-${Date.now().toString(36)}`;
const id = (name: string): string => `${RUN}-${name}`;
const SESSION = `${RUN}-sess`;
const REPO = `${RUN}/forget`;
const SCOPE = `repo:${REPO}`;
/** The rollback point, whole milliseconds. */
const T = Date.UTC(2026, 9, 20, 12, 0, 0);
const at = (offsetMs: number): string => new Date(T + offsetMs).toISOString();

describeLive("forget against a live index", () => {
	let raw: SQL;
	let index: IndexStore;

	async function put(
		name: string,
		created: string,
		over: { session?: string | null; graph?: string | null; ttl?: string; subject?: string | null; conflictKey?: string | null; supersededBy?: string | null; kind?: string } = {},
	): Promise<void> {
		await raw`
			insert into memory_entries (id, scope, kind, body, writer, ttl, session_id, graph_id, subject, conflict_key, superseded_by, entry_hash, source_event, created)
			values (${id(name)}, ${SCOPE}, ${over.kind ?? "fact"}, ${`${RUN} ${name}`}, 'cursor', ${over.ttl ?? "permanent"},
			        ${over.session === undefined ? SESSION : over.session}, ${over.graph ?? null}, ${over.subject ?? null},
			        ${over.conflictKey ?? null}, ${over.supersededBy ?? null}, ${`h-${id(name)}`}, 'evt_proof', ${created}::timestamptz)`;
	}

	beforeAll(async () => {
		raw = new SQL(defined(PG_URL, "SUBSTRATE_TEST_PG_URL"));
		index = new IndexStore(defined(PG_URL, "SUBSTRATE_TEST_PG_URL"));
		await index.migrate();
		await put("before", at(-1000));
		await put("tie", at(0));
		// Same millisecond as the rollback point, later microseconds: still a tie, still kept.
		await put("tie-micros", `${at(0).slice(0, -1)}400Z`);
		await put("after-1", at(1000), { graph: id("g-1") });
		await put("after-2", at(2000), { graph: id("g-2") });
		await put("after-3", at(2000), { graph: id("g-1"), subject: "shared-subject", conflictKey: id("ck-1") });
		await put("after-sup", at(1500), { supersededBy: id("after-1") });
		await put("other-session", at(1000), { session: `${RUN}-other` });
		await put("no-session", at(1000), { session: null });
		await put("old-30d", at(1000), { ttl: "30d" });
		await put("old-30d-keep", at(1000), { ttl: "30d", session: `${RUN}-other` });
		await put("sib-a", at(-5000), { subject: "twin", kind: "decision" });
		await put("sib-b", at(-4000), { subject: "twin", kind: "decision" });
	});

	afterAll(async () => {
		if (!PG_URL) return;
		await raw`delete from memory_entries where id like ${`${RUN}%`}`.catch(() => undefined);
		await raw.end().catch(() => undefined);
		await index.close().catch(() => undefined);
	});

	test("the rollback cut is strict, ordered by created then id, and skips other sessions and superseded rows", async () => {
		const all = await index.memoryEntriesCreatedAfter(SESSION, at(0));
		expect(all.truncated).toBe(false);
		// created asc, then id asc: after-1 and old-30d share T+1s, after-2 and after-3 share T+2s.
		expect(all.entries.map((entry) => entry.id)).toEqual(["after-1", "old-30d", "after-2", "after-3"].map(id));
		const ids = all.entries.map((entry) => entry.id);
		for (const kept of ["before", "tie", "tie-micros", "after-sup", "other-session", "no-session"]) expect(ids).not.toContain(id(kept));
	});

	test("a graph narrows the cut, and a limit truncates it", async () => {
		const graph = await index.memoryEntriesCreatedAfter(SESSION, at(0), id("g-1"));
		expect(graph.entries.map((entry) => entry.id)).toEqual([id("after-1"), id("after-3")]);
		const page = await index.memoryEntriesCreatedAfter(SESSION, at(0), null, 2);
		expect(page.truncated).toBe(true);
		expect(page.entries.map((entry) => entry.id)).toEqual([id("after-1"), id("old-30d")]);
	});

	test("an upper bound is inclusive in whole milliseconds: the new timeline's rows are not selected", async () => {
		const upTo1s = await index.memoryEntriesCreatedAfter(SESSION, at(0), null, 100, at(1000));
		expect(upTo1s.entries.map((entry) => entry.id)).toEqual([id("after-1"), id("old-30d")]);
		expect((await index.memoryEntriesCreatedAfter(SESSION, at(0), null, 100, at(0))).entries).toEqual([]);
		expect((await index.memoryEntriesCreatedAfter(SESSION, at(0), null, 100, at(2000))).entries.map((entry) => entry.id)).toEqual(
			["after-1", "old-30d", "after-2", "after-3"].map(id),
		);
	});

	test("the mark changes only rows with no superseded_by, keeps every row, and a second call changes nothing", async () => {
		const marker = forgetMarker(forgetIdFor({ reason: "operator", entry_ids: [id("after-1"), id("after-2"), id("after-sup")] }));
		const first = await index.markMemoryForgotten([id("after-1"), id("after-2"), id("after-sup"), id("missing")], marker);
		expect(first.sort()).toEqual([id("after-1"), id("after-2")]);
		expect(await index.markMemoryForgotten([id("after-1"), id("after-2"), id("after-sup")], marker)).toEqual([]);
		expect((await index.readEntry(id("after-1")))?.superseded_by).toBe(marker);
		expect((await index.readEntry(id("after-1")))?.text).toBe(`${RUN} after-1`);
		// A real superseder is never overwritten.
		expect((await index.readEntry(id("after-sup")))?.superseded_by).toBe(id("after-1"));
		// Forgotten rows drop out of the next cut: select, forget, select again terminates.
		const next = await index.memoryEntriesCreatedAfter(SESSION, at(0));
		expect(next.entries.map((entry) => entry.id)).not.toContain(id("after-1"));
		expect(next.entries.map((entry) => entry.id)).not.toContain(id("after-2"));
	});

	test("the brief and memory_search stop serving a forgotten row; include_superseded still returns it, marker and all", async () => {
		const briefed = (await index.memoryForBrief(REPO, null, 500, { surface: "cursor" })).map((entry) => entry.id);
		expect(briefed).not.toContain(id("after-1"));
		expect(briefed).not.toContain(id("after-2"));
		expect(briefed).toContain(id("after-3"));
		const searched = (await index.searchMemory("", SCOPE, 500, false, { surface: "cursor" })).map((entry) => entry.id);
		expect(searched).not.toContain(id("after-1"));
		const audit = await index.searchMemory("", SCOPE, 500, true, { surface: "cursor" });
		const forgotten = audit.find((entry) => entry.id === id("after-1"));
		expect(forgotten).toBeDefined();
		expect(isForgetMarker(forgotten?.superseded_by)).toBe(true);
	});

	test("forgetting the standing entry frees its conflict identity and takes it out of the lifecycle read", async () => {
		expect((await index.standingEntry(id("ck-1")))?.id).toBe(id("after-3"));
		const marker = forgetMarker(`fg_${"b".repeat(26)}`);
		expect(await index.markMemoryForgotten([id("after-3"), id("old-30d")], marker)).toHaveLength(2);
		expect(await index.standingEntry(id("ck-1"))).toBeNull();
		// The partial unique index no longer holds the identity: a new row can take it.
		await put("after-4", at(3000), { conflictKey: id("ck-1") });
		expect((await index.standingEntry(id("ck-1")))?.id).toBe(id("after-4"));
		const now = T + 40 * 24 * 60 * 60 * 1000;
		const candidates = (await index.memoryLifecycleCandidates({ now, policy: { ...DEFAULT_SWEEP_POLICY, batch: 100_000 } }))
			.map((candidate) => String(candidate.id))
			.filter((candidate) => candidate.startsWith(RUN));
		expect(candidates).toContain(id("old-30d-keep"));
		expect(candidates).not.toContain(id("old-30d"));
	});

	test("a live twin keeps a subject-addressed document shared; once it is forgotten the document is no longer shared", async () => {
		const a = { id: id("sib-a"), scope: SCOPE, kind: "decision" as const, subject: "twin", writer: "cursor" };
		expect(await index.memoryDocumentShared(a)).toBe(true);
		await index.markMemoryForgotten([id("sib-b")], forgetMarker(`fg_${"c".repeat(26)}`));
		expect(await index.memoryDocumentShared(a)).toBe(false);
	});

	test("end to end: select the rollback cut, forget it through the index, forget it again", async () => {
		await put("e2e-1", at(10_000), { session: `${RUN}-e2e` });
		await put("e2e-2", at(11_000), { session: `${RUN}-e2e` });
		await put("e2e-before", at(-10_000), { session: `${RUN}-e2e` });
		const deleted: string[] = [];
		const emitted: unknown[] = [];
		const deps: ForgetDeps = {
			readEntry: (entryId) => index.readEntry(entryId),
			markForgotten: (ids, marker) => index.markMemoryForgotten(ids, marker),
			deletePlaneDocument: async (entry) => {
				deleted.push(entry.id);
				return { ok: true };
			},
			documentShared: (entry) => index.memoryDocumentShared(entry),
			emit: async (payload) => {
				emitted.push(payload);
			},
			now: () => T,
		};
		const selection = await selectForRollback(
			{ entriesCreatedAfter: (session, after, graph, limit) => index.memoryEntriesCreatedAfter(session, after, graph, limit) },
			{ session_id: `${RUN}-e2e`, after: at(0) },
		);
		expect(selection.entry_ids).toEqual([id("e2e-1"), id("e2e-2")]);
		const request = { reason: "rollback" as const, entry_ids: selection.entry_ids, actor: "agent" as const, session_id: `${RUN}-e2e`, rollback_id: "rb_0123456789abcdefghjkmnpqrs" };
		const first = await forgetEntries(deps, request);
		expect(first.counts).toEqual({ marked: 2, already_forgotten: 0, already_superseded: 0, missing: 0 });
		expect(first.plane.deleted).toBe(2);
		const again = await forgetEntries(deps, request);
		expect(again.counts).toEqual({ marked: 0, already_forgotten: 2, already_superseded: 0, missing: 0 });
		expect((await index.readEntry(id("e2e-1")))?.superseded_by).toBe(first.marker);
		expect((await index.readEntry(id("e2e-before")))?.superseded_by).toBeUndefined();
		expect((await index.memoryEntriesCreatedAfter(`${RUN}-e2e`, at(0))).entries).toEqual([]);
		expect(emitted).toHaveLength(2);
	});
});
