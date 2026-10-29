/**
 * The skills registry, proven against a real Postgres (uplift-5 S5a).
 *
 * `skills-approve.test.ts` proves the service's ordering against an in-memory store that runs the
 * same `transition`; this proves the places where the database is what decides: the primary key
 * that keeps one row per (repo, name, pull request), the CHECK on `state`, the locked
 * read-judge-write of `decideSkill` under two connections, and that nothing here ever deletes.
 * A fake cannot make a unique index reject the second of two inserts that each believed they were
 * the first, so mocking Postgres here would mock the one thing under test.
 *
 *     SUBSTRATE_TEST_PG_URL=postgres://… bun test index-store.skills
 *
 * Every row is written under a run-scoped `repo`, which `afterAll` removes.
 */
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { IndexStore, skillDecisionLockKey } from "./index-store.ts";
import { defined } from "./test-support.ts";

const PG_URL = process.env.SUBSTRATE_TEST_PG_URL?.trim();
const RUN = Date.now().toString(36);
const REPO = `ut-skills-${RUN}/agent-skills`;
const MERGE = "0123456789abcdef0123456789abcdef01234567";
const HASH = "ab".repeat(32);

let a: IndexStore;
let b: IndexStore;
let raw: SQL;

const describeLive = PG_URL ? describe : describe.skip;

function decision(over: Partial<Parameters<IndexStore["decideSkill"]>[0]> = {}): Parameters<IndexStore["decideSkill"]>[0] {
	return {
		repo: REPO,
		name: "demo-skill",
		pr_number: 12,
		decision: "approve",
		merge_sha: MERGE,
		pr_url: "https://github.com/x/y/pull/12",
		branch: "skill/omp/demo-skill-20261014T123456789Z-ab12",
		proposed_by: "omp",
		decided_by: "claude-code",
		reason: null,
		...over,
	};
}

function proposal(over: Partial<Parameters<IndexStore["upsertProposedSkill"]>[0]> = {}): Parameters<IndexStore["upsertProposedSkill"]>[0] {
	return { repo: REPO, name: "demo-skill", pr_number: 12, pr_url: "https://github.com/x/y/pull/12", branch: "b1", content_sha256: HASH, proposed_by: "omp", ...over };
}

describeLive("the skills registry against a live index", () => {
	beforeAll(async () => {
		const url = defined(PG_URL, "SUBSTRATE_TEST_PG_URL");
		a = new IndexStore(url);
		b = new IndexStore(url);
		raw = new SQL(url);
		await a.migrate();
		// Idempotent: a second boot over an existing table changes nothing.
		await a.migrate();
	});

	afterAll(async () => {
		if (!PG_URL) return;
		await raw`delete from skills_registry where repo = ${REPO}`.catch(() => undefined);
		await raw.end().catch(() => undefined);
		await a.close().catch(() => undefined);
		await b.close().catch(() => undefined);
	});

	test("the table has the key and the state check the state machine relies on", async () => {
		const key = (await raw`
			select a.attname as name
			from pg_index i
			cross join lateral unnest(i.indkey::int2[]) with ordinality as k(attnum, ord)
			join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
			where i.indrelid = 'skills_registry'::regclass and i.indisprimary
			order by k.ord`) as Array<{ name: string }>;
		expect(key.map((row) => row.name)).toEqual(["repo", "name", "pr_number"]);

		const refused = await raw`
			insert into skills_registry (repo, name, pr_number, state) values (${REPO}, 'bad-state', 1, 'pending')`.then(
			() => null,
			(cause: unknown) => cause,
		);
		expect(refused).not.toBeNull();
	});

	test("a proposal is one proposed row, and recording it again changes nothing, whatever state the row is in", async () => {
		await a.upsertProposedSkill(proposal({ name: "idem-skill", pr_number: 1 }));
		await a.upsertProposedSkill(proposal({ name: "idem-skill", pr_number: 1, content_sha256: "cd".repeat(32) }));
		let rows = await a.listSkills(REPO, "proposed", 50);
		expect(rows.filter((row) => row.name === "idem-skill")).toHaveLength(1);
		expect(rows.find((row) => row.name === "idem-skill")).toMatchObject({ state: "proposed", content_sha256: HASH, proposed_by: "omp" });

		await a.decideSkill(decision({ name: "idem-skill", pr_number: 1 }));
		// A retry of the proposal after the decision must not move the row back to proposed.
		await a.upsertProposedSkill(proposal({ name: "idem-skill", pr_number: 1 }));
		rows = await a.listSkills(REPO, null, 50);
		expect(rows.find((row) => row.name === "idem-skill")).toMatchObject({ state: "approved", content_sha256: HASH, merge_sha: MERGE });
	});

	test("approving a proposed row keeps its hash; approving a pull request nobody proposed creates a row with an empty hash", async () => {
		await a.upsertProposedSkill(proposal({ name: "known-skill", pr_number: 2 }));
		const known = await a.decideSkill(decision({ name: "known-skill", pr_number: 2, reason: "looked good" }));
		expect(known).toMatchObject({ outcome: "applied", row: { state: "approved", content_sha256: HASH, merge_sha: MERGE, decided_by: "claude-code", reason: "looked good", proposed_by: "omp" } });
		expect(known.outcome === "applied" && known.row.decided_at).toBeTruthy();

		const created = await a.decideSkill(decision({ name: "unproposed-skill", pr_number: 3, proposed_by: "cursor" }));
		expect(created).toMatchObject({ outcome: "applied", row: { state: "approved", content_sha256: "", proposed_by: "cursor" } });
		// A proposal that arrives later for the same pull request fills in the hash it lacked.
		await a.upsertProposedSkill(proposal({ name: "unproposed-skill", pr_number: 3 }));
		const rows = await a.listSkills(REPO, "approved", 50);
		expect(rows.find((row) => row.name === "unproposed-skill")).toMatchObject({ state: "approved", content_sha256: HASH, merge_sha: MERGE });
	});

	test("the state machine holds in the database: exists, final declined and retired, retire needs approved", async () => {
		const first = await a.decideSkill(decision({ name: "walk-skill", pr_number: 4 }));
		expect(first.outcome).toBe("applied");
		expect((await a.decideSkill(decision({ name: "walk-skill", pr_number: 4 }))).outcome).toBe("exists");
		// A different merge commit for the same pull request is not what the row says.
		expect(await a.decideSkill(decision({ name: "walk-skill", pr_number: 4, merge_sha: "f".repeat(40) }))).toMatchObject({ outcome: "refused", rule: "bad_transition" });
		expect(await a.decideSkill(decision({ name: "walk-skill", pr_number: 4, decision: "decline", merge_sha: null }))).toMatchObject({ outcome: "refused", rule: "bad_transition" });

		const retired = await a.decideSkill(decision({ name: "walk-skill", pr_number: 4, decision: "retire", merge_sha: null, pr_url: null, branch: null, proposed_by: null }));
		expect(retired).toMatchObject({ outcome: "applied", row: { state: "retired", merge_sha: MERGE } });
		expect((await a.decideSkill(decision({ name: "walk-skill", pr_number: 4, decision: "retire", merge_sha: null }))).outcome).toBe("exists");
		expect(await a.decideSkill(decision({ name: "walk-skill", pr_number: 4 }))).toMatchObject({ outcome: "refused", rule: "bad_transition" });

		expect(await a.decideSkill(decision({ name: "never-approved", pr_number: 5, decision: "retire", merge_sha: null }))).toMatchObject({ outcome: "refused", rule: "no_approved_row", row: null });
		const declined = await a.decideSkill(decision({ name: "no-skill", pr_number: 6, decision: "decline", merge_sha: null }));
		expect(declined).toMatchObject({ outcome: "applied", row: { state: "declined", merge_sha: null } });
		expect(await a.decideSkill(decision({ name: "no-skill", pr_number: 6 }))).toMatchObject({ outcome: "refused", rule: "bad_transition" });
	});

	test("two connections racing to decide one new row produce one applied and one exists, and one row", async () => {
		const results = await Promise.all([
			a.decideSkill(decision({ name: "race-skill", pr_number: 7 })),
			b.decideSkill(decision({ name: "race-skill", pr_number: 7 })),
			a.decideSkill(decision({ name: "race-skill", pr_number: 7 })),
			b.decideSkill(decision({ name: "race-skill", pr_number: 7 })),
		]);
		expect(results.filter((result) => result.outcome === "applied")).toHaveLength(1);
		expect(results.filter((result) => result.outcome === "exists")).toHaveLength(3);
		const rows = (await raw`select count(*)::int as n from skills_registry where repo = ${REPO} and name = 'race-skill'`) as Array<{ n: number }>;
		expect(rows[0]?.n).toBe(1);
	});

	test("an approved name whose later merged content differs is a new row beside the first, never a replace, and the approved list is one entry per name", async () => {
		expect(await a.decideSkill(decision({ name: "evolving-skill", pr_number: 8, merge_sha: MERGE }))).toMatchObject({ outcome: "applied", remaining_approved: 1 });
		expect(await a.decideSkill(decision({ name: "evolving-skill", pr_number: 9, merge_sha: "e".repeat(40) }))).toMatchObject({ outcome: "applied", remaining_approved: 2 });
		const rows = (await a.listSkills(REPO, null, 100)).filter((row) => row.name === "evolving-skill");
		expect(rows.map((row) => [row.pr_number, row.merge_sha])).toEqual([
			[8, MERGE],
			[9, "e".repeat(40)],
		]);
		// The list a reader builds its name set from has the name once, through its most recent approval.
		const approved = (await a.listSkills(REPO, "approved", 100)).filter((row) => row.name === "evolving-skill");
		expect(approved.map((row) => [row.pr_number, row.merge_sha])).toEqual([[9, "e".repeat(40)]]);
		// Retiring the newer row leaves the name approved through the older one, and the decision says so.
		expect(await a.decideSkill(decision({ name: "evolving-skill", pr_number: 9, decision: "retire", merge_sha: null }))).toMatchObject({ outcome: "applied", remaining_approved: 1 });
		expect((await a.listSkills(REPO, "approved", 100)).filter((row) => row.name === "evolving-skill").map((row) => row.pr_number)).toEqual([8]);
		// Declining a later proposal never touches the approval.
		expect(await a.decideSkill(decision({ name: "evolving-skill", pr_number: 10, decision: "decline", merge_sha: null }))).toMatchObject({ outcome: "applied", remaining_approved: 1 });
		expect((await a.listSkills(REPO, "approved", 100)).filter((row) => row.name === "evolving-skill").map((row) => row.pr_number)).toEqual([8]);
	});

	test("rows of another library are invisible, the list is ordered by name in code-unit order, and the limit bounds it", async () => {
		const other = `${REPO}-other`;
		await a.decideSkill(decision({ repo: other, name: "alien-skill", pr_number: 1 }));
		// A hyphen sorts before a letter in code-unit order; a locale collation that ignores it puts `ab` first.
		await a.decideSkill(decision({ name: "ab", pr_number: 41 }));
		await a.decideSkill(decision({ name: "a-b", pr_number: 40 }));
		try {
			const approved = await a.listSkills(REPO, "approved", 500);
			expect(approved.some((row) => row.name === "alien-skill")).toBe(false);
			const names = approved.map((row) => row.name);
			expect(names).toEqual([...names].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
			expect(names.indexOf("a-b")).toBeGreaterThanOrEqual(0);
			expect(names.indexOf("a-b")).toBeLessThan(names.indexOf("ab"));
			// Every row of every state is by name then pull request number.
			const everything = (await a.listSkills(REPO, null, 500)).map((row) => [row.name, row.pr_number] as const);
			expect(everything).toEqual([...everything].sort((x, y) => (x[0] === y[0] ? x[1] - y[1] : x[0] < y[0] ? -1 : 1)));
			expect(await a.listSkills(REPO, null, 2)).toHaveLength(2);
		} finally {
			await raw`delete from skills_registry where repo = ${other}`;
		}
	});

	test("two concurrent retires on DIFFERENT approved pull requests of one name wait on the per-name advisory lock, then answer 1 and 0 and leave the name unlisted", async () => {
		// Real time is unavoidable here: the test observes backends blocked inside Postgres (polled) and asserts that
		// nothing settles while the key is held, which no fake clock can drive.
		const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
		// Two rounds, the pull request order swapped. Each holds the REAL lock key from a third connection, so both
		// retires are provably in flight at once: without the lock in `decideSkill` they would settle while it is held.
		for (const [round, first, second] of [[0, 200, 201], [1, 301, 300]] as const) {
			const name = `pair-skill-${String(round)}`;
			await a.decideSkill(decision({ name, pr_number: first }));
			await a.decideSkill(decision({ name, pr_number: second, merge_sha: "d".repeat(40) }));
			// Two approved pull requests, one list entry for the name.
			expect((await a.listSkills(REPO, "approved", 500)).filter((row) => row.name === name)).toHaveLength(1);

			const release = Promise.withResolvers<void>();
			const held = Promise.withResolvers<void>();
			// The third connection: a transaction that takes the same advisory lock and keeps it until released.
			const holder = raw.begin(async (tx: SQL) => {
				await tx`select pg_advisory_xact_lock(hashtextextended(${skillDecisionLockKey(REPO, name)}::text, 0))`;
				held.resolve();
				await release.promise;
			});
			await held.promise;

			const settled: string[] = [];
			const retire = (store: IndexStore, pr: number) =>
				store.decideSkill(decision({ name, pr_number: pr, decision: "retire", merge_sha: null })).finally(() => settled.push(String(pr)));
			const calls = [retire(a, first), retire(b, second)];

			// Both backends must be blocked on the advisory lock before anything is judged.
			const deadline = Date.now() + 5000;
			let waiters = 0;
			while (Date.now() < deadline) {
				const counted = (await raw`
					select count(*)::int as n from pg_locks
					where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())`) as Array<{ n: number }>;
				waiters = counted[0]?.n ?? 0;
				if (waiters >= 2) break;
				await sleep(25);
			}
			if (waiters < 2) {
				release.resolve();
				await Promise.allSettled([holder, ...calls]);
			}
			expect({ round, waiters_blocked_on_the_advisory_lock: waiters }).toEqual({ round, waiters_blocked_on_the_advisory_lock: 2 });

			// While the key is held neither decision may settle; without the lock in decideSkill both would already have.
			await sleep(300);
			expect({ round, settled_while_lock_held: [...settled] }).toEqual({ round, settled_while_lock_held: [] });

			release.resolve();
			await holder;
			const results = await Promise.all(calls);
			expect(results.map((result) => result.outcome)).toEqual(["applied", "applied"]);
			// The multiset, not the order: one decision saw one approved row left, the other saw none.
			expect(results.map((result) => (result.outcome === "refused" ? -1 : result.remaining_approved)).sort()).toEqual([0, 1]);
			expect((await a.listSkills(REPO, "approved", 500)).filter((row) => row.name === name)).toEqual([]);
		}
	});

	test("a skill's version is monotonic per name: a new proposal takes the next, a retry keeps its own, an approval that creates a row takes the next, and the read is the highest", async () => {
		// Its own repo, so the row count below stays about REPO alone; removed here.
		const repo = `ut-skills-${RUN}/versioned`;
		try {
			expect(await a.skillVersion(repo, "demo-skill")).toBeNull();
			await a.upsertProposedSkill(proposal({ repo, pr_number: 1, pr_url: "https://github.com/x/y/pull/1" }));
			await a.upsertProposedSkill(proposal({ repo, pr_number: 2, pr_url: "https://github.com/x/y/pull/2" }));
			// A retry of pull request 1 is the same row: its version does not move.
			await a.upsertProposedSkill(proposal({ repo, pr_number: 1, pr_url: "https://github.com/x/y/pull/1" }));
			// An approval with no proposal recorded creates a row, under the same per-name lock: the next version.
			await a.decideSkill(decision({ repo, pr_number: 3, pr_url: "https://github.com/x/y/pull/3" }));
			const versions = (await raw`select pr_number, version from skills_registry where repo = ${repo} order by pr_number`) as Array<{
				pr_number: number;
				version: number;
			}>;
			expect(versions).toEqual([
				{ pr_number: 1, version: 1 },
				{ pr_number: 2, version: 2 },
				{ pr_number: 3, version: 3 },
			]);
			expect(await a.skillVersion(repo, "demo-skill")).toEqual({ version: 3, pr_url: "https://github.com/x/y/pull/3" });
		} finally {
			await raw`delete from skills_registry where repo = ${repo}`;
		}
	});

	test("nothing in the store deletes: every row written above is still there", async () => {
		const rows = (await raw`select count(*)::int as n from skills_registry where repo = ${REPO}`) as Array<{ n: number }>;
		// idem, known, unproposed, walk, no-skill, race, evolving (three), the hyphen pair (two) and two retired pairs (four) = 15 rows; "never-approved" left none.
		expect(rows[0]?.n).toBe(15);
	});
});
