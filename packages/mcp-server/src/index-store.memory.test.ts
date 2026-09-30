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

	test("a database carrying the old reviews index is migrated onto the new one", async () => {
		// Declared first on purpose: the old index is unique over `(entry_hash, state)`,
		// so it cannot be created once the repeat-approval test below has written two
		// approved rows for one hash — which is the same fact this fix is about.
		await raw`
			create unique index if not exists memory_reviews_hash_idx on memory_reviews (entry_hash, state)`;

		await a.migrate();

		const indexes = ((await raw`
			select indexname from pg_indexes where tablename = 'memory_reviews'`) as Array<{ indexname: string }>).map(
			(row) => row.indexname,
		);
		expect(indexes).toContain("memory_reviews_pending_idx");
		// The point of the migration, and the half a fresh database never exercises: the
		// index that rejected the second approval is gone, not merely joined.
		expect(indexes).not.toContain("memory_reviews_hash_idx");
	});

	test("a first write blocks on an uncommitted first write, then is told so", async () => {
		// The shape the gate produces when two writers both read no standing entry:
		// same conflict key, `supersedes: null` on both, different keys. Neither
		// `standing-moved` check fires, so `memory_standing_idx` is the only thing
		// between them — and it used to reject the loser with a duplicate-key error the
		// gate could not tell from a connection lost over a committed row.
		//
		// The winner is held *uncommitted* on a connection of its own rather than raced
		// with `Promise.all`. Two inserts started together can still be serialised by
		// the driver or the scheduler, and a test that passes because they happened to
		// run one after the other proves nothing about the state the loser actually has
		// to handle: a row in the index that no other transaction can yet see.
		const identity = firstWriteRow({ id: "probe", idempotency_key: "probe" }).conflict_key!;
		const keyB = `${MARKER}-race-b`;
		const claimB = await b.claimWrite({
			key: keyB,
			explicit: true,
			entryHash: "hash-mem_b",
			requestHash: "req-b",
			entryId: `mem_${MARKER}_b`,
		});
		expect(claimB.claimed).toBe(true);
		if (!claimB.claimed) return;

		const blocker = new SQL(PG_URL!);
		let winnerInserted: () => void = () => undefined;
		let commitWinner: () => void = () => undefined;
		const inserted = new Promise<void>((resolve) => {
			winnerInserted = resolve;
		});
		const mayCommit = new Promise<void>((resolve) => {
			commitWinner = resolve;
		});
		const held = blocker.begin(async (tx: SQL) => {
			await tx`
				insert into memory_entries (id, scope, kind, body, subject, writer, conflict_key, entry_hash, version)
				values (${`mem_${MARKER}_a`}, ${SCOPE}, 'decision', ${`${MARKER} herdr`}, ${`runtime-${RUN}`},
				        'hermes', ${identity}, 'hash-mem_a', 1)`;
			winnerInserted();
			await mayCommit;
		});

		try {
			await inserted;
			const loser = b.insertEntry(
				firstWriteRow({ id: `mem_${MARKER}_b`, idempotency_key: keyB, text: `${MARKER} Orca` }),
				{ key: keyB, holder: claimB.holder },
			);
			// It must *block*, not decide: until the winner commits or rolls back, the
			// index cannot say whether the identity is taken, and either answer would be
			// a guess. This is the half `on conflict … do nothing` is relied on for.
			const raced = await Promise.race([
				loser.then(() => "decided" as const),
				Bun.sleep(300).then(() => "blocked" as const),
			]);
			expect(raced).toBe("blocked");

			commitWinner();
			await held;
			// And now it decides, against a row that committed while it was waiting:
			// refused, not thrown, and named as the collision it is rather than as a lost
			// predecessor — those are two different things for the caller.
			expect(await loser).toEqual({ ok: false, reason: "standing-exists" });
		} finally {
			commitWinner();
			await held.catch(() => undefined);
			await blocker.end().catch(() => undefined);
		}

		// One entry in force for the identity, and the loser wrote no row at all — the
		// transaction it declined in was rolled back rather than half-committed.
		const written = (await raw`
			select id from memory_entries where conflict_key = ${identity}`) as Array<{ id: string }>;
		expect(written.map((row) => row.id)).toEqual([`mem_${MARKER}_a`]);
		expect(await a.readEntry(`mem_${MARKER}_b`)).toBeNull();
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
			standingByHash: (hash) => b.standingByHash(hash),
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
		expect(await a.releaseReviews(hash, `mem_${MARKER}_r1`, "hermes")).toBe(1);

		// Parked again — allowed, because the pending slot is free once the first was
		// decided — and approved again.
		expect(await a.enqueueReview({ ...proposal, id: `memr_${MARKER}_2` })).toBe(`memr_${MARKER}_2`);
		expect(await a.releaseReviews(hash, `mem_${MARKER}_r2`, "hermes")).toBe(1);

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

	test("parking is declined for content that is already in force", async () => {
		// The window this closes is between a check and an insert: a reviewer who
		// installs the entry there leaves the proposal parked behind them, for a
		// decision already in force. So the store tests it in the insert.
		const hash = `hash-${MARKER}-inforce`;
		const proposal = {
			...firstWriteRow({ id: `memr_${MARKER}_5`, idempotency_key: `${MARKER}-r5` }),
			scope: "global",
			subject: null,
			entry_hash: hash,
			text: `${MARKER} the ledger is append-only`,
			conflict_key: null,
			reason: "global scope requires review",
		};
		await raw`
			insert into memory_entries (id, scope, kind, body, writer, entry_hash, version)
			values (${`mem_${MARKER}_inforce`}, 'global', 'decision', ${proposal.text}, 'hermes', ${hash}, 1)`;

		expect(await a.enqueueReview(proposal)).toBeNull();
		expect((await a.standingByHash(hash))?.id).toBe(`mem_${MARKER}_inforce`);

		// Superseded, and it is a proposal again: what is in force is what matters, not
		// what was once approved.
		await raw`
			update memory_entries set superseded_by = 'mem_someone-else'
			where id = ${`mem_${MARKER}_inforce`}`;
		expect(await a.enqueueReview(proposal)).toBe(`memr_${MARKER}_5`);
		expect(await a.standingByHash(hash)).toBeNull();
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
		const installed = (await raw`
			select count(*)::int as n from memory_entries where body like ${`%${MARKER} the runtime is herdr%`}
			  and scope = 'global'`) as Array<{ n: number }>;
		expect(installed[0]!.n).toBe(1);
	});

	test("a global decision installed straight from a token is not re-proposed either", async () => {
		// No proposal was ever parked for this one: a reviewer's token installs a global
		// write directly. Asking the review table "was this approved" would miss it and
		// put a decision already in force back in the queue — which is why the question
		// is asked of the index instead.
		const request = {
			scope: "global",
			kind: "decision" as const,
			subject: `direct-${RUN}`,
			text: `${MARKER} the ledger is append-only`,
		};

		const direct = await write(a, { ...request, review_token: REVIEW_TOKEN });
		expect(direct.outcome).toBe("accepted");
		const parked = (await raw`
			select count(*)::int as n from memory_reviews where entry_hash = ${direct.entry!.entry_hash}`) as Array<{
			n: number;
		}>;
		expect(parked[0]!.n).toBe(0);

		const again = await write(b, request);
		expect(again.outcome).toBe("accepted");
		expect(again.reason).toBe("review.already-approved");
		expect(again.entry?.id).toBe(direct.entry!.id);
		const after = (await raw`
			select count(*)::int as n from memory_reviews where entry_hash = ${direct.entry!.entry_hash}`) as Array<{
			n: number;
		}>;
		expect(after[0]!.n).toBe(0);
	});
});
