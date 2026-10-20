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
 * It also holds the real-gate regression for `current_version`: a decision buried
 * under 120 newer entries in its scope is still rewritten without a search.
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
import type { MemoryReadOptions, MemoryWriteRequest, MemoryWriteResult } from "./types.ts";

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

	/** What one reader sees of this run's rows, through the call `memory_search` makes. */
	async function seenBy(read: MemoryReadOptions | undefined, scope?: string): Promise<string[]> {
		const page = await a.searchMemoryPage({ limit: 500, ...(scope === undefined ? {} : { scope }) }, read);
		return page.entries.map((entry) => entry.text).filter((text) => text.includes(MARKER));
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
		// Unique where the data still permits it, which is what a database written
		// before this fix always looks like. Plain otherwise: the new schema allows two
		// approved rows for one hash, so a suite re-run against a database that already
		// holds a pair must not fail in its own setup instead of testing the migration.
		// What is under test either way is `drop index if exists`, which goes by name.
		await raw`
			create unique index if not exists memory_reviews_hash_idx on memory_reviews (entry_hash, state)`.catch(
			async () => {
				await raw`create index if not exists memory_reviews_hash_idx on memory_reviews (entry_hash, state)`;
			},
		);

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

		// Real entries: resolution joins the row it is approving against, so that the
		// proposal is only resolved by an entry that can actually answer it.
		const install = async (id: string) => {
			await raw`
				insert into memory_entries (id, scope, kind, body, writer, entry_hash, ttl, version)
				values (${id}, 'global', 'decision', ${proposal.text}, 'hermes', ${hash}, 'permanent', 1)`;
		};

		expect(await a.enqueueReview(proposal)).toBe(`memr_${MARKER}_1`);
		await install(`mem_${MARKER}_r1`);
		expect(await a.releaseReviews(hash, `mem_${MARKER}_r1`, "hermes")).toBe(1);

		// Parked again — allowed, because the pending slot is free once the first was
		// decided — and approved again.
		expect(await a.enqueueReview({ ...proposal, id: `memr_${MARKER}_2` })).toBe(`memr_${MARKER}_2`);
		await install(`mem_${MARKER}_r2`);
		expect(await a.releaseReviews(hash, `mem_${MARKER}_r2`, "hermes")).toBe(1);

		const rows = (await raw`
			select state, count(*)::int as n from memory_reviews where entry_hash = ${hash}
			group by state`) as Array<{ state: string; n: number }>;
		expect(rows).toEqual([{ state: "approved", n: 2 }]);
	});

	test("the queue tells a reviewer what retention to approve", async () => {
		// A reviewer installs a proposal by re-submitting it with a token, and the
		// release only resolves a proposal the entry answers — so the queue has to say
		// what was asked for. Without it a `30d` proposal is approved as `permanent`
		// and stays pending, with nothing on screen to explain why.
		const parked = {
			...firstWriteRow({ id: `memr_${MARKER}_ttl`, idempotency_key: `${MARKER}-r7` }),
			scope: "global",
			subject: null,
			entry_hash: `hash-${MARKER}-ttl`,
			text: `${MARKER} the runner is rebuilt weekly`,
			conflict_key: null,
			ttl: "30d" as const,
			reason: "global scope requires review",
		};
		expect(await a.enqueueReview(parked)).toBe(`memr_${MARKER}_ttl`);
		// A real quarantine row, so the other half of this assertion is about something:
		// an empty queue satisfies `every` without proving anything at all.
		await a.quarantineEntry({
			...firstWriteRow({ id: `memq_${MARKER}_ttl`, idempotency_key: `${MARKER}-q7` }),
			scope: "global",
			subject: null,
			entry_hash: `hash-${MARKER}-quarantined`,
			text: `${MARKER} it might be the poller`,
			conflict_key: null,
			ttl: "30d" as const,
			reason: "speculative" as const,
			detail: "hedged language",
		});

		const queue = await a.governanceQueue(50);
		const row = queue.reviews.find((review) => review.id === `memr_${MARKER}_ttl`);

		expect(row?.ttl).toBe("30d");
		// And the quarantine row carries none even though the write asked for one: that
		// table holds no retention, because a parked write was never kept for anything.
		const quarantined = queue.quarantined.find((held) => held.id === `memq_${MARKER}_ttl`);
		expect(quarantined).toBeDefined();
		expect(quarantined?.ttl).toBeUndefined();
	});

	test("an entry resolves only the proposals it answers", async () => {
		// `releaseReviews` matches on the content hash, and content is not the whole of
		// a proposal: one parked after the entry was written is a new ask, and one
		// asking for a different retention is not answered by this entry at all.
		// Resolving either takes a live request out of a reviewer's queue without
		// installing what it asked for — and a replay, which carries no review token,
		// reaches this call.
		const hash = `hash-${MARKER}-answers`;
		const proposal = {
			...firstWriteRow({ id: `memr_${MARKER}_6`, idempotency_key: `${MARKER}-r6` }),
			scope: "global",
			subject: null,
			entry_hash: hash,
			text: `${MARKER} the host runs eight agents`,
			conflict_key: null,
			reason: "global scope requires review",
		};

		// Parked before the entry, asking for what the entry will hold.
		expect(await a.enqueueReview(proposal)).toBe(`memr_${MARKER}_6`);
		await raw`
			insert into memory_entries (id, scope, kind, body, writer, entry_hash, ttl, version, created)
			values (${`mem_${MARKER}_answers`}, 'global', 'decision', ${proposal.text}, 'hermes', ${hash},
			        'permanent', 1, now())`;
		expect(await a.releaseReviews(hash, `mem_${MARKER}_answers`, "hermes")).toBe(1);

		// Raised afterwards, and for a different retention: neither is this entry's to
		// resolve, and a second release must leave both alone.
		await raw`
			insert into memory_reviews (id, scope, kind, body, writer, ttl, entry_hash, reason, state, created)
			values (${`memr_${MARKER}_later`}, 'global', 'decision', ${proposal.text}, 'hermes', 'permanent',
			        ${hash}, 'r', 'pending', now() + interval '1 second')`;
		expect(await a.releaseReviews(hash, `mem_${MARKER}_answers`, "hermes")).toBe(0);

		await raw`update memory_reviews set state = 'approved' where id = ${`memr_${MARKER}_later`}`;
		await raw`
			insert into memory_reviews (id, scope, kind, body, writer, ttl, entry_hash, reason, state, created)
			values (${`memr_${MARKER}_30d`}, 'global', 'decision', ${proposal.text}, 'hermes', '30d',
			        ${hash}, 'r', 'pending', now() - interval '1 hour')`;
		expect(await a.releaseReviews(hash, `mem_${MARKER}_answers`, "hermes")).toBe(0);

		const pending = (await raw`
			select id from memory_reviews where entry_hash = ${hash} and state = 'pending'`) as Array<{ id: string }>;
		expect(pending.map((row) => row.id)).toEqual([`memr_${MARKER}_30d`]);
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

	test("approving a re-proposal of installed content is accepted, not reported as lost", async () => {
		// The reported bug, end to end through the gate and a real index. Propose,
		// approve, send the same content again without a token — which parks a second
		// proposal, because the key the first one spent was spent on a refusal — and
		// then approve that one too.
		//
		// That last approval is where it went wrong: the entry committed, and resolving
		// the proposal raised a duplicate key against the row the first approval had
		// left. The caller was told `store.write-failed` with the entry sitting in the
		// index. An appending kind, so the second approval really does write a row.
		const request = { scope: "global", kind: "fact" as const, text: `${MARKER} eight agents share one host` };

		expect((await write(a, request)).reason).toBe("review.required");
		const first = await write(a, { ...request, review_token: REVIEW_TOKEN, idempotency_key: `${MARKER}-ap1` });
		expect(first.outcome).toBe("accepted");

		// Parked again: nothing pins the outcome of a refusal, which is what makes
		// approval-by-resubmit work at all.
		const reproposed = await write(b, request);
		expect(reproposed.reason).toBe("review.required");
		expect(reproposed.review_id).not.toBe(first.entry!.id);

		const second = await write(b, { ...request, review_token: REVIEW_TOKEN, idempotency_key: `${MARKER}-ap2` });

		expect(second.outcome).toBe("accepted");
		expect(second.verified_persisted).toBe(true);
		expect(second.entry!.id).not.toBe(first.entry!.id);

		// Both entries are in the index, both proposals are resolved, and the caller
		// was told so — which is the whole of it.
		const entries = (await raw`
			select count(*)::int as n from memory_entries where entry_hash = ${first.entry!.entry_hash}`) as Array<{
			n: number;
		}>;
		expect(entries[0]!.n).toBe(2);
		const reviews = (await raw`
			select state, count(*)::int as n from memory_reviews where entry_hash = ${first.entry!.entry_hash}
			group by state`) as Array<{ state: string; n: number }>;
		expect(reviews).toEqual([{ state: "approved", n: 2 }]);
	});

	test("a version conflict names the version in force, however buried the decision is", async () => {
		// The gap this closes: a client learned the version to re-submit against by
		// searching memory, and search matches only the body and returns the newest 100.
		// A decision whose body lacks its subject's words, under 100+ newer entries in its
		// scope, could never be found again — so the rewrite stayed refused at v1. The
		// refusal now carries the version, and no search is needed at all.
		const repo = `memtest-${RUN}/scratch`;
		const scope = `repo:${repo}`;
		const subject = `db-choice-${RUN}`;
		const first = await write(a, {
			scope,
			repo,
			subject,
			// Neither "db" nor "choice" appears in the body.
			text: `${MARKER} use postgres 16`,
			idempotency_key: `${MARKER}-cv-decision-1`,
		});
		expect(first.outcome).toBe("accepted");
		expect(first.entry?.version).toBe(1);

		for (let i = 0; i < 120; i++) {
			const fact = await write(a, {
				scope,
				repo,
				kind: "fact",
				text: `${MARKER} scratch fact ${i}: the build cache was warm`,
				idempotency_key: `${MARKER}-cv-fact-${i}`,
			});
			expect(fact.outcome).toBe("accepted");
		}

		const rewrite = {
			scope,
			repo,
			subject,
			text: `${MARKER} use postgres 17`,
			idempotency_key: `${MARKER}-cv-decision-2`,
		};
		const refused = await write(b, rewrite);
		expect(refused.outcome).toBe("conflict");
		expect(refused.reason).toBe("version.required");
		expect(refused.conflict_with).toBe(first.entry!.id);
		expect(refused.current_version).toBe(1);

		// Straight back, same key, with the version the refusal named.
		const retry = await write(b, { ...rewrite, expected_version: refused.current_version ?? undefined });
		expect(retry.outcome).toBe("accepted");
		expect(retry.verified_persisted).toBe(true);
		expect(retry.idempotency_key).toBe(`${MARKER}-cv-decision-2`);
		expect(retry.entry?.version).toBe(2);
		expect(retry.entry?.supersedes).toBe(first.entry!.id);
	}, 60_000);

	test("a rewrite whose predecessor is replaced under it is a version race, and its key retries at once", async () => {
		// Two rewrites of one v1, under different keys. The competing one lands in the
		// window between the loser's read and its insert — run from inside the loser's
		// `insertEntry`, before it delegates. The real store retires the predecessor
		// before it inserts, so the loser finds v1 already retired and answers
		// `standing-moved`: a version race, never the identity race the winner's row
		// would suggest if the index were met first.
		const subject = `raced-${RUN}`;
		const first = await write(a, { subject, text: `${MARKER} the scheduler is cron`, idempotency_key: `${MARKER}-vr-1` });
		expect(first.outcome).toBe("accepted");
		expect(first.entry?.version).toBe(1);

		// Held on an object, not a `let`: TypeScript narrows a `let` assigned only inside
		// a closure to its initial `undefined` at the reads below.
		const competing: { result?: MemoryWriteResult; raced: boolean } = { raced: false };
		const racing: MemoryStore = {
			claimWrite: (input) => b.claimWrite(input),
			finishWrite: (key, holder, outcome, entryId) => b.finishWrite(key, holder, outcome, entryId),
			releaseWrite: (key, holder) => b.releaseWrite(key, holder),
			restoreWrite: (key, holder, reserved) => b.restoreWrite(key, holder, reserved),
			standingEntry: (identity) => b.standingEntry(identity),
			insertEntry: async (row, claim) => {
				if (!competing.raced) {
					competing.raced = true;
					competing.result = await write(a, {
						subject,
						text: `${MARKER} the scheduler is systemd timers`,
						expected_version: 1,
						idempotency_key: `${MARKER}-vr-k2`,
					});
				}
				return await b.insertEntry(row, claim);
			},
			readEntry: (id) => b.readEntry(id),
			quarantineEntry: (row) => b.quarantineEntry(row),
			enqueueReview: (row) => b.enqueueReview(row),
			releaseReviews: (hash, entryId, by) => b.releaseReviews(hash, entryId, by),
		};

		const rewrite = {
			subject,
			text: `${MARKER} the scheduler is a Greptime job`,
			idempotency_key: `${MARKER}-vr-k1`,
		};
		const loser = await write(racing, { ...rewrite, expected_version: 1 });

		const competitor = competing.result;
		expect(competitor?.outcome).toBe("accepted");
		expect(competitor?.entry?.version).toBe(2);
		expect(loser.outcome).toBe("conflict");
		expect(loser.reason).toBe("version.raced");
		expect(loser.verified_persisted).toBe(false);
		// The version in force now — the competitor's — not the v1 this write read.
		expect(loser.current_version).toBe(2);

		// Rolled back: the competitor is the one entry in force, and nothing of the
		// loser's landed.
		const standing = (await raw`
			select id, version from memory_entries
			where subject = ${subject} and superseded_by is null`) as Array<{ id: string; version: number }>;
		expect(standing.map((row) => row.id)).toEqual([competitor!.entry!.id]);
		const record = (await raw`
			select outcome from memory_writes where idempotency_key = ${`${MARKER}-vr-k1`}`) as Array<{ outcome: string }>;
		expect(record[0]?.outcome).toBe("conflict");

		// Straight back, same key, against the version the conflict named.
		const retry = await write(b, { ...rewrite, expected_version: loser.current_version ?? undefined });
		expect(retry.outcome).toBe("accepted");
		expect(retry.verified_persisted).toBe(true);
		expect(retry.idempotency_key).toBe(`${MARKER}-vr-k1`);
		expect(retry.entry?.version).toBe(3);
		expect(retry.entry?.supersedes).toBe(competitor!.entry!.id);
	});

	test("an agent's own notes are readable in search by that agent only; shared scopes stay visible to every surface", async () => {
		const shared = await write(a, { scope: SCOPE, kind: "fact", writer: "hermes", subject: `shared-${RUN}`, text: `${MARKER} shared fact` });
		const hermesNote = await write(a, { scope: "agent:hermes", kind: "fact", writer: "hermes", subject: `hermes-${RUN}`, text: `${MARKER} hermes private note` });
		const ompNote = await write(a, { scope: "agent:omp", kind: "fact", writer: "omp", subject: `omp-${RUN}`, text: `${MARKER} omp private note` });
		expect(shared.verified_persisted).toBe(true);
		expect(hermesNote.verified_persisted).toBe(true);
		expect(ompNote.verified_persisted).toBe(true);

		const asOmp = await seenBy({ surface: "omp", repo: REPO });
		expect(asOmp).toContain(`${MARKER} shared fact`);
		expect(asOmp).toContain(`${MARKER} omp private note`);
		expect(asOmp).not.toContain(`${MARKER} hermes private note`);
		expect(await seenBy({ surface: "omp", repo: REPO }, "agent:hermes")).toEqual([]);
		expect(await seenBy({ surface: "hermes", repo: REPO }, "agent:hermes")).toEqual([`${MARKER} hermes private note`]);
		expect(await seenBy(undefined, "agent:hermes")).toEqual([`${MARKER} hermes private note`]);
	});

	test("an agent's note is read only in the repo it was written for, and by no caller that names none", async () => {
		const OTHER_REPO = "swcstudiospace/other-repo";
		const inRepo = await write(a, { scope: "agent:omp", kind: "fact", writer: "omp", repo: REPO, subject: `repo-a-${RUN}`, text: `${MARKER} omp note for repo a` });
		const inOther = await write(a, { scope: "agent:omp", kind: "fact", writer: "omp", repo: OTHER_REPO, subject: `repo-b-${RUN}`, text: `${MARKER} omp note for repo b` });
		const noRepo = await write(a, { scope: "agent:omp", kind: "fact", writer: "omp", repo: undefined, subject: `no-repo-${RUN}`, text: `${MARKER} omp note naming no repo` });
		expect(inRepo.verified_persisted).toBe(true);
		expect(inOther.verified_persisted).toBe(true);
		expect(noRepo.verified_persisted).toBe(true);

		const inA = await seenBy({ surface: "omp", repo: REPO }, "agent:omp");
		expect(inA).toContain(`${MARKER} omp note for repo a`);
		expect(inA).not.toContain(`${MARKER} omp note for repo b`);
		expect(inA).not.toContain(`${MARKER} omp note naming no repo`);

		const inB = await seenBy({ surface: "omp", repo: OTHER_REPO }, "agent:omp");
		expect(inB).toContain(`${MARKER} omp note for repo b`);
		expect(inB).not.toContain(`${MARKER} omp note for repo a`);

		expect(await seenBy({ surface: "omp" }, "agent:omp")).toEqual([]);
	});

	test("a legacy agent row, written before a repo was recorded, is read by no caller", async () => {
		const legacy = `${MARKER} legacy omp note`;
		await raw`
			insert into memory_entries (id, scope, kind, body, writer, entry_hash)
			values (${`legacy-${RUN}`}, 'agent:omp', 'fact', ${legacy}, 'omp', ${`legacy-hash-${RUN}`})`;
		const stored = (await raw`select repo from memory_entries where id = ${`legacy-${RUN}`}`) as Array<{ repo: string | null }>;
		expect(stored[0]?.repo).toBeNull();
		expect(await seenBy({ surface: "omp", repo: REPO }, "agent:omp")).not.toContain(legacy);
		expect(await seenBy({ surface: "omp" }, "agent:omp")).not.toContain(legacy);
	});

	test("the repo index is built onto a database that already holds entries, from its ledger entry alone", async () => {
		await raw`drop index if exists memory_entries_repo_idx`;
		await raw`delete from schema_migrations where version = 31`;
		await a.migrate();
		const indexes = ((await raw`select indexname from pg_indexes where tablename = 'memory_entries'`) as Array<{ indexname: string }>).map(
			(row) => row.indexname,
		);
		expect(indexes).toContain("memory_entries_repo_idx");
		const rows = (await raw`select count(*)::int as n from memory_entries where body like ${`%${MARKER}%`}`) as Array<{ n: number }>;
		expect(rows[0]?.n ?? 0).toBeGreaterThan(0);
	});
});
