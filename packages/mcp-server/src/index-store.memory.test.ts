/**
 * Memory governance, proven against a real Postgres.
 *
 * `memory-write.test.ts` proves the gate's decisions against a fake store; this
 * proves the two places where the *index* is what decides — the unique indexes
 * over the entries in force and over the review queue. Both of the races below
 * were invisible to the fake, because a fake cannot reproduce a unique index
 * rejecting the second of two inserts that each believed they were the first:
 *
 *   1. Two first writes for one subject, under different idempotency keys.
 *      Neither retires a predecessor, so `memory_standing_idx` is what separates
 *      them, and the loser has to come back as a conflict it can retry rather
 *      than as a store error with its key stuck in flight.
 *   2. Content approved once and proposed again. Approving the second proposal
 *      moves it to `approved` beside the first, which the old `(entry_hash,
 *      state)` index rejected — after the memory entry had already committed, so
 *      the caller was told nothing was stored while the entry was in the index.
 *
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

/** Thrown to roll a deliberately-held transaction back, the way `insertEntry` does. */
class HeldOpen extends Error {}

/**
 * Whether `work` settles inside `ms`.
 *
 * How a test asserts that two statements really are contending: a `false` here is the
 * blocked-on-the-index state that makes the race a race. The rejection handler is
 * attached eagerly so a later failure is never an unhandled one.
 */
function settles(work: Promise<unknown>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expiry = new Promise<boolean>((resolve) => {
		timer = setTimeout(() => resolve(false), ms);
	});
	return Promise.race([
		work.then(
			() => true,
			() => true,
		),
		expiry,
	]).finally(() => clearTimeout(timer));
}

describeLive("memory governance against a live index", () => {
	beforeAll(async () => {
		a = new IndexStore(PG_URL!);
		b = new IndexStore(PG_URL!);
		raw = new SQL(PG_URL!);
		await a.migrate();
		// Run twice because the DDL is meant to be idempotent, and a second run is the
		// cheapest proof of it. What it does *not* prove is the replacement of the old
		// review index — a database this suite has already migrated no longer carries it —
		// so that has a test of its own, which seeds the old shape first.
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
		const identity = firstWriteRow({ id: "probe", idempotency_key: "probe" }).conflict_key!;
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

		// Both inserts have to be in flight *at once*, and `Promise.all` does not arrange
		// that on its own: the two statements are free to serialise, the second finding the
		// identity already taken and committed, and then the test passes without the index
		// having arbitrated a race at all.
		//
		// So a third row takes the identity from inside a transaction that is held open.
		// Both writers under test then block on `memory_standing_idx` — proved below, by
		// neither of them settling while it is held — and rolling that transaction back is
		// the starting pistol: they are released together, one commits, and the other finds
		// out the only way that matters, from the index.
		let release!: () => void;
		const rolledBack = new Promise<void>((resolve) => {
			release = resolve;
		});
		let holding!: () => void;
		const held = new Promise<void>((resolve) => {
			holding = resolve;
		});
		const blocker = raw
			.begin(async (tx: SQL) => {
				await tx`
					insert into memory_entries (id, scope, kind, body, writer, conflict_key, entry_hash)
					values (${`mem_${MARKER}_block`}, ${SCOPE}, 'decision', ${`${MARKER} holding the identity`},
					        'hermes', ${identity}, ${`hash-${MARKER}-block`})`;
				holding();
				await rolledBack;
				// Undone: the two writers under test are the only ones that may end up holding
				// the identity, or the assertions below would be about this row.
				throw new HeldOpen();
			})
			.catch((cause: unknown) => {
				if (!(cause instanceof HeldOpen)) throw cause;
			});
		await held;

		const race = Promise.all([
			a.insertEntry(firstWriteRow({ id: `mem_${MARKER}_a`, idempotency_key: keyA, text: `${MARKER} herdr` }), {
				key: keyA,
				holder: claimA.holder,
			}),
			b.insertEntry(firstWriteRow({ id: `mem_${MARKER}_b`, idempotency_key: keyB, text: `${MARKER} Orca` }), {
				key: keyB,
				holder: claimB.holder,
			}),
		]);
		// The overlap itself, measured rather than hoped for: while the identity is held,
		// neither insert can get past the index. Asserted after the hand-over below, so a
		// failure here does not leave the transaction open and every later test waiting on
		// it.
		const overlapped = !(await settles(race, 250));

		release();
		await blocker;
		const [first, second] = await race;
		expect(overlapped).toBe(true);

		const outcomes = [first, second];
		expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
		// Refused, not thrown, and named as the collision it is rather than as a lost
		// predecessor — those are two different things for the caller.
		expect(outcomes.filter((outcome) => !outcome.ok && outcome.reason === "standing-exists")).toHaveLength(1);

		// One entry in force for the identity, and the loser wrote no row at all — the
		// transaction it declined in was rolled back rather than half-committed.
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
			approvedReview: (hash) => b.approvedReview(hash),
			recordApproval: (row, entryId, by) => b.recordApproval(row, entryId, by),
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

	test("approving content that was approved before does not collide", async () => {
		// The store half of the repeat-approval bug, with nothing else in the way. The
		// second `releaseReviews` used to raise a duplicate key on `(entry_hash, state)`
		// — and in the gate it raised it *after* the entry had committed.
		const hash = `hash-${MARKER}-twice`;
		const proposal = {
			...firstWriteRow({ id: `memr_${MARKER}_1`, idempotency_key: `${MARKER}-r1` }),
			scope: "global",
			subject: null,
			entry_hash: hash,
			text: `${MARKER} eight agents share one host`,
			conflict_key: null,
			reason: "global scope requires review",
		};

		expect(await a.enqueueReview(proposal)).toBe(`memr_${MARKER}_1`);
		expect(await a.recordApproval(proposal, `mem_${MARKER}_r1`, "hermes")).toEqual({
			released: 1,
			review_id: `memr_${MARKER}_1`,
		});

		// Parked again — allowed, because the pending slot is free once the first was
		// decided — and approved again.
		expect(await a.enqueueReview({ ...proposal, id: `memr_${MARKER}_2` })).toBe(`memr_${MARKER}_2`);
		expect(await a.recordApproval({ ...proposal, id: `memr_${MARKER}_2` }, `mem_${MARKER}_r2`, "hermes")).toEqual({
			released: 1,
			review_id: `memr_${MARKER}_2`,
		});

		const rows = (await raw`
			select state, count(*)::int as n from memory_reviews where entry_hash = ${hash}
			group by state`) as Array<{ state: string; n: number }>;
		expect(rows).toEqual([{ state: "approved", n: 2 }]);
	});

	test("a pending proposal is still one per content", async () => {
		// The uniqueness that parking actually needs, and the half that has to survive
		// the index change: a retried proposal finds its own row rather than filling a
		// reviewer's queue.
		const hash = `hash-${MARKER}-pending`;
		const proposal = {
			...firstWriteRow({ id: `memr_${MARKER}_3`, idempotency_key: `${MARKER}-r3` }),
			scope: "global",
			subject: null,
			entry_hash: hash,
			text: `${MARKER} the poller runs on the host`,
			conflict_key: null,
			reason: "global scope requires review",
		};

		expect(await a.enqueueReview(proposal)).toBe(`memr_${MARKER}_3`);
		expect(await b.enqueueReview({ ...proposal, id: `memr_${MARKER}_4` })).toBe(`memr_${MARKER}_3`);

		const rows = (await raw`
			select count(*)::int as n from memory_reviews where entry_hash = ${hash}`) as Array<{ n: number }>;
		expect(rows[0]!.n).toBe(1);
	});

	test("re-proposing an installed global decision reports the entry, not a failure", async () => {
		// End to end, through the gate: propose, approve, then send the same content
		// again without a token. That third write used to park a second proposal, and
		// approving *it* is where the caller was told nothing was stored while the
		// entry was in the index.
		const request = {
			scope: "global",
			kind: "decision" as const,
			subject: `runtime-global-${RUN}`,
			text: `${MARKER} the runtime is herdr`,
		};

		const proposed = await write(a, request);
		expect(proposed.outcome).toBe("conflict");
		expect(proposed.reason).toBe("review.required");

		const approved = await write(a, { ...request, review_token: REVIEW_TOKEN });
		expect(approved.outcome).toBe("accepted");
		expect(approved.verified_persisted).toBe(true);

		const again = await write(b, request);
		expect(again.outcome).toBe("accepted");
		expect(again.reason).toBe("review.already-approved");
		expect(again.verified_persisted).toBe(true);
		expect(again.entry?.id).toBe(approved.entry!.id);

		// Nothing new in front of a reviewer, and one entry in the index.
		const pending = (await raw`
			select count(*)::int as n from memory_reviews
			where entry_hash = ${approved.entry!.entry_hash} and state = 'pending'`) as Array<{ n: number }>;
		expect(pending[0]!.n).toBe(0);
		const entries = (await raw`
			select count(*)::int as n from memory_entries where body like ${`%${MARKER} the runtime is herdr%`}
			  and scope = 'global'`) as Array<{ n: number }>;
		expect(entries[0]!.n).toBe(1);
	});

	test("an entry installed straight from a token leaves an approval to find", async () => {
		// The install with no proposal behind it: a reviewer sends the write with a token
		// and nothing is pending, so resolving pending rows resolves nothing. With no
		// `approved` row left behind there was nothing for `approvedReview` to find, and the
		// same content sent later without a token went back into the queue as though no
		// reviewer had ever seen it — where approving it is a second entry for a decision
		// already in force.
		const request = {
			scope: "global",
			kind: "decision" as const,
			subject: `direct-${RUN}`,
			text: `${MARKER} the gate installs with a token`,
		};

		const installed = await write(a, { ...request, review_token: REVIEW_TOKEN });
		expect(installed.outcome).toBe("accepted");
		expect(installed.verified_persisted).toBe(true);

		// Recorded although nothing was released — the half `releaseReviews` could not do.
		const marker = (await raw`
			select id, state, entry_id, decided_by from memory_reviews
			where entry_hash = ${installed.entry!.entry_hash}`) as Array<Record<string, unknown>>;
		expect(marker).toHaveLength(1);
		expect(marker[0]!.state).toBe("approved");
		expect(marker[0]!.entry_id).toBe(installed.entry!.id);
		expect(await a.approvedReview(installed.entry!.entry_hash)).toEqual({
			id: String(marker[0]!.id),
			entry_id: installed.entry!.id,
		});

		// And the tokenless re-submission is answered with the entry rather than parked.
		const again = await write(b, request);
		expect(again.outcome).toBe("accepted");
		expect(again.reason).toBe("review.already-approved");
		expect(again.entry?.id).toBe(installed.entry!.id);
		const pending = (await raw`
			select count(*)::int as n from memory_reviews
			where entry_hash = ${installed.entry!.entry_hash} and state = 'pending'`) as Array<{ n: number }>;
		expect(pending[0]!.n).toBe(0);
	});

	test("a re-proposal asking for a different ttl is parked with the ttl it asked for", async () => {
		// `entry_hash` is content only, so this write reaches the gate hashing exactly like
		// the approved one while asking for retention the entry in force does not have.
		const request = {
			scope: "global",
			kind: "fact" as const,
			text: `${MARKER} the poller runs on the host`,
		};
		const approved = await write(a, { ...request, review_token: REVIEW_TOKEN });
		expect(approved.outcome).toBe("accepted");
		expect(approved.entry?.ttl).toBe("permanent");

		const shorter = await write(b, { ...request, ttl: "30d" });

		expect(shorter.outcome).toBe("conflict");
		expect(shorter.reason).toBe("review.required");
		expect(shorter.conflict_with).toBe(approved.entry!.id);
		// Parked as its own proposal, carrying the retention actually asked for — not
		// answered with the permanent entry under `verified_persisted: true`.
		const parked = (await raw`
			select ttl, state from memory_reviews where id = ${shorter.review_id!}`) as Array<Record<string, unknown>>;
		expect(parked[0]).toMatchObject({ ttl: "30d", state: "pending" });
		const standing = (await raw`
			select ttl from memory_entries where entry_hash = ${approved.entry!.entry_hash}
			  and superseded_by is null`) as Array<{ ttl: string }>;
		expect(standing.map((row) => row.ttl)).toEqual(["permanent"]);
	});

	test("migrate replaces the old (entry_hash, state) uniqueness", async () => {
		// The half of the repeat-approval fix that only a database can show: a schema
		// carrying the *old* index, migrated. Running `migrate` twice in `beforeAll` proves
		// it is idempotent and nothing about the replacement, because by then there is no
		// old index left to replace.
		//
		// The old shape is unique over every state, so it cannot be created while the table
		// holds two rows for one content in one state — which is exactly what the new shape
		// allows and what the tests above have already left behind. Those rows are this
		// suite's own audit trail and the assertions that needed them have run, so the
		// duplicates go first.
		await raw`
			delete from memory_reviews r using memory_reviews o
			where r.entry_hash = o.entry_hash and r.state = o.state and r.ctid > o.ctid`;
		await raw`drop index if exists memory_reviews_pending_idx`;
		await raw`create unique index memory_reviews_hash_idx on memory_reviews (entry_hash, state)`;

		await a.migrate();

		const indexes = (await raw`
			select indexname from pg_indexes where tablename = 'memory_reviews'`) as Array<{ indexname: string }>;
		const names = indexes.map((row) => row.indexname);
		expect(names).not.toContain("memory_reviews_hash_idx");
		expect(names).toContain("memory_reviews_pending_idx");

		// And what the replacement is for: two approved rows for one content, which the old
		// index rejected — in the gate, *after* the entry had already committed.
		const hash = `hash-${MARKER}-migrated`;
		const proposal = {
			...firstWriteRow({ id: `memr_${MARKER}_5`, idempotency_key: `${MARKER}-r5` }),
			scope: "global",
			subject: null,
			entry_hash: hash,
			text: `${MARKER} migrations are idempotent`,
			conflict_key: null,
			reason: "global scope requires review",
		};
		await a.enqueueReview(proposal);
		expect((await a.recordApproval(proposal, `mem_${MARKER}_r5`, "hermes")).released).toBe(1);
		await a.enqueueReview({ ...proposal, id: `memr_${MARKER}_6` });
		expect((await a.recordApproval({ ...proposal, id: `memr_${MARKER}_6` }, `mem_${MARKER}_r6`, "hermes")).released).toBe(
			1,
		);
		const rows = (await raw`
			select state, count(*)::int as n from memory_reviews where entry_hash = ${hash}
			group by state`) as Array<{ state: string; n: number }>;
		expect(rows).toEqual([{ state: "approved", n: 2 }]);
	});
});
