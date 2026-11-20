/**
 * The context-matrix store against a real Postgres: the insert that keeps the first
 * row for an `entry_id`, the one-way move from candidate to accepted, the slot read
 * the promotion gate depends on, and the gate's conflict decision made over what the
 * store actually returns.
 *
 * Skipped unless a database is given, like `index-store.memory.test.ts`:
 *
 *     SUBSTRATE_TEST_PG_URL=postgres://… bun test index-store.context-matrix
 *
 * Every row written here carries `RUN` in its `entry_id`, and `afterAll` removes them.
 */
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { decidePromotion, type CandidateEntry } from "./context-matrix-gate.ts";
import { IndexStore } from "./index-store.ts";
import { defined } from "./test-support.ts";

const PG_URL = process.env.SUBSTRATE_TEST_PG_URL?.trim();
const RUN = Date.now().toString(36);
const ID_PREFIX = `ctx-${RUN}-`;
const SHA = "a".repeat(64);

const describeLive = PG_URL ? describe : describe.skip;

let store: IndexStore;
/** For the assertions and the cleanup: what is in the table, not what the API says. */
let raw: SQL;

function entry(name: string, overrides: Partial<CandidateEntry> = {}): CandidateEntry {
	return {
		entryId: `${ID_PREFIX}${name}`,
		realm: `ctx-realm-${RUN}`,
		milestone: "m1",
		phase: "p1",
		sourcePath: `docs/${RUN}/${name}.md`,
		sourceSha256: SHA,
		entryKind: "decision",
		bodyRedacted: `Context matrix ${RUN} ${name} keeps the log append-only.`,
		...overrides,
	};
}

/** The stored row for one `entry_id`, read straight from the table. */
async function stored(entryId: string): Promise<Array<Record<string, unknown>>> {
	return (await raw`
		select entry_id, realm, milestone, phase, source_path, source_sha256, entry_kind, body_redacted, status
		from context_matrix_entries where entry_id = ${entryId}`) as Array<Record<string, unknown>>;
}

describeLive("context matrix store against a live index", () => {
	beforeAll(async () => {
		store = new IndexStore(defined(PG_URL, "SUBSTRATE_TEST_PG_URL"), { contextMatrixWrite: true });
		raw = new SQL(defined(PG_URL, "SUBSTRATE_TEST_PG_URL"));
		await store.migrate();
	});

	afterAll(async () => {
		if (!PG_URL) return;
		await raw`delete from context_matrix_entries where entry_id like ${`${ID_PREFIX}%`}`.catch(() => undefined);
		await raw.end().catch(() => undefined);
		await store.close().catch(() => undefined);
	});

	test("inserting the same entry_id twice stores one row: inserted, then existing, and the first body is kept", async () => {
		const first = entry("a");
		expect(await store.insertContextCandidate(first)).toBe("inserted");
		expect(await store.insertContextCandidate({ ...first, bodyRedacted: `${first.bodyRedacted} changed` })).toBe("existing");

		const rows = await stored(first.entryId);
		expect(rows.length).toBe(1);
		expect(defined(rows[0], "stored row")).toMatchObject({
			entry_id: first.entryId,
			body_redacted: first.bodyRedacted,
			status: "candidate",
		});
	});

	test("acceptContextCandidate moves a candidate to accepted once: true the first time, false after", async () => {
		const candidate = entry("b");
		await store.insertContextCandidate(candidate);

		expect(await store.acceptContextCandidate(candidate.entryId)).toBe(true);
		expect(await store.acceptContextCandidate(candidate.entryId)).toBe(false);
		expect(defined((await stored(candidate.entryId))[0], "stored row").status).toBe("accepted");
	});

	test("listAcceptedContext returns only accepted rows in the given realm, kind and source path, ordered by entry_id", async () => {
		const realm = `ctx-realm-${RUN}`;
		const sourcePath = `docs/${RUN}/c-slot.md`;
		const first = entry("c-1", { realm, sourcePath });
		const second = entry("c-2", { realm, sourcePath });
		const candidate = entry("c-3", { realm, sourcePath });
		const otherRealm = entry("c-4", { realm: `ctx-other-${RUN}`, sourcePath });
		const otherKind = entry("c-5", { realm, sourcePath, entryKind: "fact" });
		const otherSource = entry("c-6", { realm, sourcePath: `docs/${RUN}/c-other.md` });

		// The second entry is inserted first, so the ordering cannot come from insertion order.
		for (const row of [second, first, candidate, otherRealm, otherKind, otherSource]) {
			await store.insertContextCandidate(row);
		}
		for (const row of [first, second, otherRealm, otherKind, otherSource]) {
			expect(await store.acceptContextCandidate(row.entryId)).toBe(true);
		}

		expect(await store.listAcceptedContext(realm, "decision", sourcePath)).toEqual([first, second]);
	});

	test("a stored accepted entry in the slot makes the gate hold a different body as a conflict", async () => {
		const realm = `ctx-realm-${RUN}`;
		const sourcePath = `docs/${RUN}/d-slot.md`;
		const kept = entry("d-1", { realm, sourcePath, bodyRedacted: `Context matrix ${RUN} d-1 keeps the log append-only.` });
		const incoming = entry("d-2", { realm, sourcePath, bodyRedacted: `Context matrix ${RUN} d-2 replaces the log with a queue.` });

		await store.insertContextCandidate(kept);
		expect(await store.acceptContextCandidate(kept.entryId)).toBe(true);
		await store.insertContextCandidate(incoming);

		const accepted = await store.listAcceptedContext(realm, "decision", sourcePath);
		expect(decidePromotion(incoming, accepted)).toEqual({ outcome: "held", reason: "conflict" });
	});
});

describe("context matrix candidate writes with the flag off", () => {
	test("insertContextCandidate resolves to disabled and acceptContextCandidate to false, and neither issues a query", async () => {
		const noQuery = (() => {
			throw new Error("the store issued a query with contextMatrixWrite off");
		}) as unknown as SQL;
		const off = new IndexStore("postgres://unused", { sql: noQuery, contextMatrixWrite: false });
		const candidate = entry("flag-off");
		expect(await off.insertContextCandidate(candidate)).toBe("disabled");
		expect(await off.acceptContextCandidate(candidate.entryId)).toBe(false);
	});
});
