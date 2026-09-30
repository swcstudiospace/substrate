/**
 * Memory governance, proven against a real Postgres.
 *
 * `memory-write.test.ts` proves the gate's decisions against a fake store; this
 * proves the place where the *index* is what decides: two first writes for one
 * subject, under different idempotency keys. Neither retires a predecessor, so
 * `memory_standing_idx` is what separates them, and the loser has to come back
 * as a conflict it can retry rather than as a store error with its key stuck in
 * flight. The fake store cannot reproduce that — a unique index rejecting the
 * second of two inserts that each believed they were the first is the thing
 * under test. *
 * Skipped unless a database is given, for the reason `index-store.lease.test.ts`
 * gives: mocking Postgres' concurrency would mock the one thing under test.
 *
 *     SUBSTRATE_TEST_PG_URL=postgres://… bun test index-store.memory
 *
 * Every row written here carries `MARKER` in its text and a run-scoped subject,
 * and `afterAll` removes them.
 */
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { IndexStore } from "./index-store.ts";
import { governMemoryWrite, type MemoryStore, type NewMemoryEntry } from "./memory-write.ts";
import { conflictKey, parseScope } from "./memory-policy.ts";
import type { MemoryWriteRequest, MemoryWriteResult } from "./types.ts";

const PG_URL = process.env.SUBSTRATE_TEST_PG_URL?.trim();
const RUN = Date.now().toString(36);
/** In every body this suite writes, so the cleanup can find them and nothing else. */
const MARKER = `ut-memtest-${RUN}`;
const REPO = "swcstudiospace/agent-substrate";
const SCOPE = `repo:${REPO}`;
const REVIEW_TOKEN = "a-reviewer-token-long-enough";

// Two stores, so a race goes through two connections. One connection would
// serialise the statements and the test would pass with the index doing nothing.
let a: IndexStore;
let b: IndexStore;
/** For the assertions and the cleanup: what is in the tables, not what the API says. */
let raw: SQL;

const describeLive = PG_URL ? describe : describe.skip;

describeLive("memory governance against a live index", () => {
	beforeAll(async () => {
		a = new IndexStore(PG_URL!);
		b = new IndexStore(PG_URL!);
		raw = new SQL(PG_URL!);
		await a.migrate();
		// Idempotent, and on a database carrying the old `(entry_hash, state)` index it
		// is the second run that replaces it — so running it twice is part of the proof.
		await a.migrate();
	});

	afterAll(async () => {
		if (!PG_URL) return;
		await raw`delete from memory_entries where body like ${`%${MARKER}%`}`.catch(() => undefined);
		await raw`delete from memory_reviews where body like ${`%${MARKER}%`}`.catch(() => undefined);
		await raw`delete from memory_quarantine where body like ${`%${MARKER}%`}`.catch(() => undefined);
		await raw`delete from memory_writes where idempotency_key like ${`${MARKER}%`}`.catch(() => undefined);
		await raw.end().catch(() => undefined);
		await a.close().catch(() => undefined);
		await b.close().catch(() => undefined);
	});

	/** A write through the real gate, against one of the two connections. */
	function write(store: MemoryStore, request: Partial<MemoryWriteRequest> = {}): Promise<MemoryWriteResult> {
		return governMemoryWrite(
			{ scope: SCOPE, kind: "decision", writer: "hermes", repo: REPO, text: `${MARKER} placeholder`, ...request },
			{ store, isReviewToken: (token) => token === REVIEW_TOKEN },
		);
	}

	/** A row as the gate would hand it to the store: a first write, retiring nothing. */
	function firstWriteRow(over: Partial<NewMemoryEntry> & { id: string; idempotency_key: string }): NewMemoryEntry {
		const scope = parseScope(SCOPE)!;
		return {
			scope: scope.canonical,
			kind: "decision",
			subject: `runtime-${RUN}`,
			text: `${MARKER} the runtime is herdr`,
			writer: "hermes",
			actor: "agent",
			trust: "agent-claimed",
			ttl: "permanent",
			source_event: null,
			session_id: null,
			graph_id: null,
			repo: REPO,
			conflict_key: conflictKey(scope, "decision", `runtime-${RUN}`),
			version: 1,
			supersedes: null,
			entry_hash: `hash-${over.id}`,
			reverify_after: new Date(Date.now() + 86_400_000).toISOString(),
			...over,
		};
	}

	test("two first writes for one subject: one entry, and the other is told so", async () => {
		// The shape the gate produces when two writers both read no standing entry:
		// same conflict key, `supersedes: null` on both, different keys. Neither
		// `standing-moved` check fires, so `memory_standing_idx` is the only thing
		// between them — and it used to reject the loser with a duplicate-key error the
		// gate could not tell from a connection lost over a committed row.
		const keyA = `${MARKER}-race-a`;
		const keyB = `${MARKER}-race-b`;
		const claimA = await a.claimWrite({
			key: keyA,
			explicit: true,
			entryHash: "hash-mem_a",
			requestHash: "req-a",
			entryId: `mem_${MARKER}_a`,
		});
		const claimB = await b.claimWrite({
			key: keyB,
			explicit: true,
			entryHash: "hash-mem_b",
			requestHash: "req-b",
			entryId: `mem_${MARKER}_b`,
		});
		expect(claimA.claimed && claimB.claimed).toBe(true);
		if (!claimA.claimed || !claimB.claimed) return;

		// Both in flight at once: the loser blocks on the winner's uncommitted index
		// entry and only then finds out, which is the whole point of doing this through
		// two connections.
		const [first, second] = await Promise.all([
			a.insertEntry(firstWriteRow({ id: `mem_${MARKER}_a`, idempotency_key: keyA, text: `${MARKER} herdr` }), {
				key: keyA,
				holder: claimA.holder,
			}),
			b.insertEntry(firstWriteRow({ id: `mem_${MARKER}_b`, idempotency_key: keyB, text: `${MARKER} Orca` }), {
				key: keyB,
				holder: claimB.holder,
			}),
		]);

		const outcomes = [first, second];
		expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
		// Refused, not thrown, and named as the collision it is rather than as a lost
		// predecessor — those are two different things for the caller.
		expect(outcomes.filter((outcome) => !outcome.ok && outcome.reason === "standing-exists")).toHaveLength(1);

		// One entry in force for the identity, and the loser wrote no row at all — the
		// transaction it declined in was rolled back rather than half-committed.
		const identity = firstWriteRow({ id: "probe", idempotency_key: "probe" }).conflict_key!;
		const written = (await raw`
			select id from memory_entries where conflict_key = ${identity}`) as Array<{ id: string }>;
		const winnerId = first.ok ? first.entry.id : second.ok ? second.entry.id : "";
		expect(written.map((row) => row.id)).toEqual([winnerId]);
		const loserId = first.ok ? `mem_${MARKER}_b` : `mem_${MARKER}_a`;
		expect(await a.readEntry(loserId)).toBeNull();
	});

	test("the loser's key is spent on a conflict, so its retry is not blocked", async () => {
		// Through the whole gate this time. `standingEntry` is pinned to null on the
		// loser's connection, which is exactly what it saw: it read before the winner
		// committed. Everything past that read — the insert, the index, the claim
		// record — is the real thing.
		const subject = `ledger-${RUN}`;
		const winner = await write(a, { subject, text: `${MARKER} Greptime is the ledger`, idempotency_key: `${MARKER}-w` });
		expect(winner.outcome).toBe("accepted");

		const racing: MemoryStore = {
			claimWrite: (input) => b.claimWrite(input),
			finishWrite: (key, holder, outcome, entryId) => b.finishWrite(key, holder, outcome, entryId),
			releaseWrite: (key, holder) => b.releaseWrite(key, holder),
			restoreWrite: (key, holder, reserved) => b.restoreWrite(key, holder, reserved),
			// The stale read the race is made of — once. The gate's second look, after the
			// index refuses the insert, happens when the winner is committed and visible,
			// so it goes to the real store and is what names the winner in the reply.
			standingEntry: (() => {
				let stale = true;
				return async (identity: string) => {
					if (!stale) return await b.standingEntry(identity);
					stale = false;
					return null;
				};
			})(),
			insertEntry: (row, claim) => b.insertEntry(row, claim),
			readEntry: (id) => b.readEntry(id),
			quarantineEntry: (row) => b.quarantineEntry(row),
			enqueueReview: (row) => b.enqueueReview(row),
			releaseReviews: (hash, entryId, by) => b.releaseReviews(hash, entryId, by),
		};

		const loser = await write(racing, {
			subject,
			text: `${MARKER} Postgres is the ledger`,
			idempotency_key: `${MARKER}-l`,
		});

		expect(loser.outcome).toBe("conflict");
		expect(loser.reason).toBe("standing.raced");
		expect(loser.conflict_with).toBe(winner.entry!.id);

		// The claim record is the assertion that matters: `conflict`, not `in-flight`.
		// In flight it would refuse the loser's own retry for the takeover timeout.
		const record = (await raw`
			select outcome from memory_writes where idempotency_key = ${`${MARKER}-l`}`) as Array<{ outcome: string }>;
		expect(record[0]?.outcome).toBe("conflict");

		const retry = await write(b, {
			subject,
			text: `${MARKER} Postgres is the ledger`,
			idempotency_key: `${MARKER}-l`,
			expected_version: 1,
		});
		expect(retry.outcome).toBe("accepted");
		expect(retry.entry?.version).toBe(2);
		expect(retry.entry?.supersedes).toBe(winner.entry!.id);
	});

});
