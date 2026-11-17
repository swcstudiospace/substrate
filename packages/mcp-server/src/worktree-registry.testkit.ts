/**
 * One set of cases for every `WorktreeRegistryStore` adapter. `worktree-registry.test.ts` runs it against the in-memory
 * adapter and `worktree-registry.pg.test.ts` against Postgres (skipped without `SUBSTRATE_TEST_PG_URL`), so the fake the
 * route tests rely on cannot drift from the SQL. Call it inside a `describe`; the cases register themselves with `test`.
 *
 * Every case names its own hosts and repos through the harness, so a run against a shared database never reads a row
 * another run or another case wrote, and every clock is an argument: nothing here sleeps.
 */
import { expect, test } from "bun:test";
import { defined } from "./test-support.ts";
import type { ReportedWorktree, WorktreeRegistryStore, WorktreeStoreFilter } from "./worktree-registry.ts";

export interface ContractHarness {
	store: WorktreeRegistryStore;
	/** A host name unique to this run and to `label`. */
	host(label: string): string;
	/** An owner/name unique to this run and to `label`. */
	repo(label: string): string;
}

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const T0 = new Date("2026-03-01T00:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 86_400_000;

const at = (base: Date, offsetMs: number): Date => new Date(base.getTime() + offsetMs);

function record(repo: string, path: string, overrides: Partial<ReportedWorktree> = {}): ReportedWorktree {
	return {
		path,
		repo,
		branch: "feature/x",
		head: HEAD_A,
		base: "main",
		dirty: false,
		ahead: 0,
		behind: 0,
		last_commit_at: "2026-02-28T12:00:00.000Z",
		size_bytes: 1024,
		locked: false,
		primary: false,
		pr_state: "none",
		...overrides,
	};
}

function filter(overrides: Partial<WorktreeStoreFilter>): WorktreeStoreFilter {
	return { repo: null, host: null, state: "all", limit: 500, staleBefore: new Date(0), repos: null, ...overrides };
}

export function worktreeStoreContract(harness: () => ContractHarness): void {
	test("a report is stored and listed back field for field, with first and last seen set to the report's instant", async () => {
		const { store, host, repo } = harness();
		const h = host("roundtrip");
		const r = repo("roundtrip");
		const full = record(r, "/work/a", {
			branch: null,
			base: null,
			dirty: true,
			ahead: 3,
			behind: 1,
			last_commit_at: null,
			size_bytes: 5_000_000_000,
			locked: true,
			primary: true,
			pr_state: "open",
			session_id: "sess-1",
			graph_id: "graph-1",
		});
		const plain = record(r, "/work/b");

		expect(await store.report({ host: h, reportedAt: at(T0, -1000), seenAt: T0, ttlS: 86_400, worktrees: [full, plain] })).toEqual({ stored: 2, removed: 0 });

		const rows = await store.list(filter({ repo: r }));
		expect(rows).toEqual([
			{ ...full, host: h, first_seen_at: T0.toISOString(), last_seen_at: T0.toISOString() },
			{ ...plain, host: h, first_seen_at: T0.toISOString(), last_seen_at: T0.toISOString() },
		]);
		// An optional member the reporter did not send is absent from the row, not null.
		expect("session_id" in defined(rows[1], "the plain row")).toBe(false);
	});

	test("a later report updates the row in place: the fields change, first_seen_at stays and last_seen_at moves", async () => {
		const { store, host, repo } = harness();
		const h = host("update");
		const r = repo("update");
		await store.report({ host: h, reportedAt: T0, seenAt: T0, ttlS: 86_400, worktrees: [record(r, "/work/a", { dirty: false, session_id: "sess-1" })] });

		const later = at(T0, 2 * HOUR);
		const second = await store.report({
			host: h,
			reportedAt: later,
			seenAt: later,
			ttlS: 86_400,
			worktrees: [record(r, "/work/a", { dirty: true, head: HEAD_B, ahead: 2, pr_state: "merged" })],
		});

		expect(second).toEqual({ stored: 1, removed: 0 });
		const rows = await store.list(filter({ repo: r }));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ dirty: true, head: HEAD_B, ahead: 2, pr_state: "merged", first_seen_at: T0.toISOString(), last_seen_at: later.toISOString() });
		// The reporter dropped the attribution, and the row follows the latest report rather than keeping the old one.
		expect(rows[0] !== undefined && "session_id" in rows[0]).toBe(false);
	});

	test("a row the report leaves out is kept while it is inside the retention window, and deleted once it is older than the window at report time", async () => {
		const { store, host, repo } = harness();
		const h = host("ttl");
		const r = repo("ttl");
		const ttlS = 2 * 86_400;
		await store.report({ host: h, reportedAt: T0, seenAt: T0, ttlS, worktrees: [record(r, "/work/old"), record(r, "/work/kept")] });

		// A day later only /work/kept is listed: /work/old is one day unseen, inside the two-day window, so it stays.
		const day1 = at(T0, DAY);
		expect(await store.report({ host: h, reportedAt: day1, seenAt: day1, ttlS, worktrees: [record(r, "/work/kept")] })).toEqual({ stored: 1, removed: 0 });
		expect((await store.list(filter({ repo: r }))).map((row) => row.path).sort()).toEqual(["/work/kept", "/work/old"]);

		// Three days after the first report /work/old has gone unseen for three days, past the window: the report sweeps it.
		const day3 = at(T0, 3 * DAY);
		expect(await store.report({ host: h, reportedAt: day3, seenAt: day3, ttlS, worktrees: [record(r, "/work/kept")] })).toEqual({ stored: 1, removed: 1 });
		expect((await store.list(filter({ repo: r }))).map((row) => row.path)).toEqual(["/work/kept"]);
	});

	test("a row older than the window that the same report lists again is refreshed, not deleted", async () => {
		const { store, host, repo } = harness();
		const h = host("refresh");
		const r = repo("refresh");
		await store.report({ host: h, reportedAt: T0, seenAt: T0, ttlS: DAY / 1000, worktrees: [record(r, "/work/a")] });

		const late = at(T0, 10 * DAY);
		expect(await store.report({ host: h, reportedAt: late, seenAt: late, ttlS: DAY / 1000, worktrees: [record(r, "/work/a")] })).toEqual({ stored: 1, removed: 0 });
		const rows = await store.list(filter({ repo: r }));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ first_seen_at: T0.toISOString(), last_seen_at: late.toISOString() });
	});

	test("two hosts are independent: one host's report never sweeps or replaces the other's rows, even for the same path", async () => {
		const { store, host, repo } = harness();
		const a = host("indep-a");
		const b = host("indep-b");
		const r = repo("indep");
		await store.report({ host: a, reportedAt: T0, seenAt: T0, ttlS: DAY / 1000, worktrees: [record(r, "/work/shared", { dirty: true }), record(r, "/work/only-a")] });

		// Ten days on, host b reports: host a's rows are far past the window, but b's report is not about host a.
		const late = at(T0, 10 * DAY);
		expect(await store.report({ host: b, reportedAt: late, seenAt: late, ttlS: DAY / 1000, worktrees: [record(r, "/work/shared", { dirty: false })] })).toEqual({ stored: 1, removed: 0 });

		const rows = await store.list(filter({ repo: r }));
		expect(rows.map((row) => [row.host, row.path, row.dirty])).toEqual([
			[b, "/work/shared", false],
			[a, "/work/only-a", false],
			[a, "/work/shared", true],
		]);
		expect((await store.list(filter({ repo: r, host: a }))).map((row) => row.path)).toEqual(["/work/only-a", "/work/shared"]);
		expect((await store.list(filter({ repo: r, host: b }))).map((row) => row.path)).toEqual(["/work/shared"]);
	});

	test("an empty report stores nothing and still sweeps its host's expired rows", async () => {
		const { store, host, repo } = harness();
		const h = host("empty");
		const r = repo("empty");
		await store.report({ host: h, reportedAt: T0, seenAt: T0, ttlS: DAY / 1000, worktrees: [record(r, "/work/a")] });

		const late = at(T0, 2 * DAY);
		expect(await store.report({ host: h, reportedAt: late, seenAt: late, ttlS: DAY / 1000, worktrees: [] })).toEqual({ stored: 0, removed: 1 });
		expect(await store.list(filter({ repo: r }))).toEqual([]);
	});

	test("the listing filters by repo, host, dirty and stale, orders newest report first then host then path, and honours the limit", async () => {
		const { store, host, repo } = harness();
		const h = host("filters");
		const r = repo("filters");
		const other = repo("filters-other");
		await store.report({
			host: h,
			reportedAt: T0,
			seenAt: T0,
			ttlS: 30 * DAY / 1000,
			worktrees: [
				record(r, "/work/fresh-clean", { last_commit_at: "2026-02-28T00:00:00.000Z" }),
				record(r, "/work/old-clean", { last_commit_at: "2026-01-01T00:00:00.000Z" }),
				record(r, "/work/old-dirty", { dirty: true, last_commit_at: "2026-01-01T00:00:00.000Z" }),
				record(r, "/work/no-commit", { last_commit_at: null }),
				record(other, "/work/other"),
			],
		});
		const staleBefore = new Date("2026-02-15T00:00:00.000Z");

		expect((await store.list(filter({ repo: r, state: "dirty" }))).map((row) => row.path)).toEqual(["/work/old-dirty"]);
		// A worktree with no known last commit is not proven stale.
		expect((await store.list(filter({ repo: r, state: "stale", staleBefore }))).map((row) => row.path)).toEqual(["/work/old-clean", "/work/old-dirty"]);
		expect((await store.list(filter({ repo: other }))).map((row) => row.path)).toEqual(["/work/other"]);

		// All five share one last_seen_at and one host, so the order falls to the path.
		const all = await store.list(filter({ host: h }));
		expect(all.map((row) => row.path)).toEqual(["/work/fresh-clean", "/work/no-commit", "/work/old-clean", "/work/old-dirty", "/work/other"]);
		expect(await store.list(filter({ host: h, limit: 2 }))).toHaveLength(2);

		// A fresher report moves its row to the front.
		const later = at(T0, HOUR);
		await store.report({ host: h, reportedAt: later, seenAt: later, ttlS: 30 * DAY / 1000, worktrees: [record(r, "/work/old-clean", { last_commit_at: "2026-01-01T00:00:00.000Z" })] });
		expect(defined((await store.list(filter({ host: h, limit: 1 })))[0], "the newest row").path).toBe("/work/old-clean");
	});

	test("a report's files are stored with the truncation flag and read back as sent; the listing never carries them", async () => {
		const { store, host, repo } = harness();
		const h = host("files");
		const r = repo("files");
		await store.report({
			host: h,
			reportedAt: T0,
			seenAt: T0,
			ttlS: DAY / 1000,
			worktrees: [record(r, "/work/a", { files: ["a.ts", "b/c.ts"], files_truncated: true }), record(r, "/work/b", { files: [] }), record(r, "/work/c", { files: null })],
		});

		const rows = await store.candidates({ repo: r, limit: 10 });
		const byPath = new Map(rows.map((row) => [row.path, row]));
		expect(byPath.get("/work/a")).toMatchObject({ files: ["a.ts", "b/c.ts"], files_truncated: true });
		// An empty list says "touches nothing" and null says "could not list": the store keeps the two apart.
		expect(byPath.get("/work/b")).toMatchObject({ files: [], files_truncated: false });
		expect(byPath.get("/work/c")).toMatchObject({ files: null, files_truncated: false });
		expect((await store.list(filter({ repo: r }))).some((row) => "files" in row || "files_truncated" in row)).toBe(false);
	});

	test("the freshest report wins: one that omits files, or says null, clears what an earlier one stored", async () => {
		const { store, host, repo } = harness();
		const h = host("clear");
		const r = repo("clear");
		await store.report({ host: h, reportedAt: T0, seenAt: T0, ttlS: DAY / 1000, worktrees: [record(r, "/work/a", { files: ["a.ts"], files_truncated: true }), record(r, "/work/b", { files: ["b.ts"] })] });

		const later = at(T0, HOUR);
		await store.report({ host: h, reportedAt: later, seenAt: later, ttlS: DAY / 1000, worktrees: [record(r, "/work/a"), record(r, "/work/b", { files: null })] });

		const rows = await store.candidates({ repo: r, limit: 10 });
		expect(rows.map((row) => [row.path, row.files, row.files_truncated])).toEqual([
			["/work/a", null, false],
			["/work/b", null, false],
		]);

		const newest = at(T0, 2 * HOUR);
		await store.report({ host: h, reportedAt: newest, seenAt: newest, ttlS: DAY / 1000, worktrees: [record(r, "/work/a", { files: ["z.ts"] })] });
		expect(defined((await store.candidates({ repo: r, limit: 10 })).find((row) => row.path === "/work/a"), "the row").files).toEqual(["z.ts"]);
	});

	test("the candidate read is one repository (without regard to case), newest report first then host then path, and bounded by its limit", async () => {
		const { store, host, repo } = harness();
		const h = host("candidates");
		const other = host("candidates-2");
		const r = repo("candidates");
		await store.report({ host: h, reportedAt: T0, seenAt: T0, ttlS: DAY / 1000, worktrees: [record(r, "/work/b", { files: ["x"] }), record(r, "/work/a", { files: ["x"] }), record(repo("candidates-elsewhere"), "/work/z", { files: ["x"] })] });
		const later = at(T0, HOUR);
		await store.report({ host: other, reportedAt: later, seenAt: later, ttlS: DAY / 1000, worktrees: [record(r, "/work/newest", { files: ["x"] })] });

		const all = await store.candidates({ repo: r, limit: 10 });
		expect(all.map((row) => [row.host, row.path])).toEqual([
			[other, "/work/newest"],
			[h, "/work/a"],
			[h, "/work/b"],
		]);
		expect(await store.candidates({ repo: r.toUpperCase(), limit: 10 })).toHaveLength(3);
		const bounded = await store.candidates({ repo: r, limit: 2 });
		expect(bounded.map((row) => row.path)).toEqual(["/work/newest", "/work/a"]);
		expect(await store.candidates({ repo: repo("candidates-none"), limit: 10 })).toEqual([]);
	});

	test("the retention sweep still removes a row that carries files, and the candidate read no longer returns it", async () => {
		const { store, host, repo } = harness();
		const h = host("sweep-files");
		const r = repo("sweep-files");
		await store.report({ host: h, reportedAt: T0, seenAt: T0, ttlS: DAY / 1000, worktrees: [record(r, "/work/old", { files: ["a.ts"] })] });
		const late = at(T0, 2 * DAY);
		expect(await store.report({ host: h, reportedAt: late, seenAt: late, ttlS: DAY / 1000, worktrees: [record(r, "/work/new", { files: ["b.ts"] })] })).toEqual({ stored: 1, removed: 1 });
		expect((await store.candidates({ repo: r, limit: 10 })).map((row) => row.path)).toEqual(["/work/new"]);
	});
}
