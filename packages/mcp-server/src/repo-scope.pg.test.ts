/**
 * Phase 72: the repository grant filter in the worktree registry's list query, proven against a real Postgres. The
 * filter is `lower(repo) in (select jsonb_array_elements_text(...))` in `WorktreeRegistry.list` (`worktree-registry.ts`).
 * It is the only SQL that restricts rows to a grant. The grant itself is derived from `SUBSTRATE_REPO_SCOPES` through
 * `repoScopeFromEnv` and `grantedRepos`, the same path the service takes. These skip unless a database is given:
 *
 *     SUBSTRATE_TEST_PG_URL=postgres://… bun test repo-scope.pg
 *
 * Two repositories are seeded through the public `report()` API. Each run namespaces its host and repositories with a
 * marker, and sweeps its host at the end with a report from the far future, so a shared database is left as it was found.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { IndexStore } from "./index-store.ts";
import { grantedRepos, REPO_SCOPES_ENV, repoScopeFromEnv } from "./repo-scope.ts";
import { defined } from "./test-support.ts";
import type { ReportedWorktree, StoredWorktree, WorktreeStoreFilter } from "./worktree-registry.ts";

const PG_URL = process.env.SUBSTRATE_TEST_PG_URL?.trim();
const MARKER = `ut-p72-${Date.now().toString(36)}`;
const HOST = `${MARKER}-host`;
const ALPHA = `${MARKER}/alpha`;
const BETA = `${MARKER}/beta`;
/** Mixed-case spelling of ALPHA. The filter compares `lower(repo)`, so a granted repository reported this way is still granted. */
const ALPHA_UPPER = `${MARKER}/Alpha`;
const SURFACE = "cursor";
const HEAD = "a".repeat(40);
const T0 = new Date("2026-03-01T00:00:00.000Z");
const T1 = new Date("2026-03-01T01:00:00.000Z");
const TTL_S = 365 * 86_400;
const STALE_BEFORE = new Date("2026-02-01T00:00:00.000Z");
const FRESH_COMMIT = "2026-02-28T12:00:00.000Z";
const STALE_COMMIT = "2026-01-01T00:00:00.000Z";

const describeLive = PG_URL ? describe : describe.skip;

function row(repo: string, path: string, overrides: Partial<ReportedWorktree> = {}): ReportedWorktree {
	return {
		path,
		repo,
		branch: "feature/x",
		head: HEAD,
		base: "main",
		dirty: false,
		ahead: 0,
		behind: 0,
		last_commit_at: FRESH_COMMIT,
		size_bytes: 1024,
		locked: false,
		primary: false,
		pr_state: "none",
		...overrides,
	};
}

function filter(overrides: Partial<WorktreeStoreFilter>): WorktreeStoreFilter {
	return { repo: null, host: HOST, state: "all", limit: 500, staleBefore: STALE_BEFORE, repos: null, ...overrides };
}

const pathsOf = (rows: readonly StoredWorktree[]): string[] => rows.map((r) => r.path).sort();

const ALPHA_PATHS = ["/work/alpha-clean", "/work/alpha-dirty", "/work/alpha-stale", "/work/alpha-upper"].sort();
const BETA_PATHS = ["/work/beta-clean", "/work/beta-dirty", "/work/beta-stale"].sort();

describeLive("the repo grant filter in the worktree list query against a live index", () => {
	let index: IndexStore;
	let stored: { alpha: number; beta: number };

	beforeAll(async () => {
		index = new IndexStore(defined(PG_URL, "SUBSTRATE_TEST_PG_URL"));
		await index.migrate();
		const registry = index.worktreeRegistry();
		// Alpha is reported first (T0) and beta a later report (T1), so beta's rows are the newest in the table. A filter
		// applied after the read, past a LIMIT, would then drop them and return nothing; the filter has to run in SQL.
		const alpha = await registry.report({
			host: HOST,
			reportedAt: T0,
			seenAt: T0,
			ttlS: TTL_S,
			worktrees: [
				row(ALPHA, "/work/alpha-clean"),
				row(ALPHA, "/work/alpha-dirty", { dirty: true }),
				row(ALPHA, "/work/alpha-stale", { last_commit_at: STALE_COMMIT }),
				row(ALPHA_UPPER, "/work/alpha-upper"),
			],
		});
		const beta = await registry.report({
			host: HOST,
			reportedAt: T1,
			seenAt: T1,
			ttlS: TTL_S,
			worktrees: [
				row(BETA, "/work/beta-clean"),
				row(BETA, "/work/beta-dirty", { dirty: true }),
				row(BETA, "/work/beta-stale", { last_commit_at: STALE_COMMIT }),
			],
		});
		stored = { alpha: alpha.stored, beta: beta.stored };
	});

	afterAll(async () => {
		if (!PG_URL) return;
		// An empty report from the far future sweeps everything the host left behind.
		const farFuture = new Date("2100-01-01T00:00:00.000Z");
		await index.worktreeRegistry().report({ host: HOST, reportedAt: farFuture, seenAt: farFuture, ttlS: 60, worktrees: [] }).catch(() => undefined);
		await index.close().catch(() => undefined);
	});

	test("the seeded rows are stored: four for alpha, three for beta", () => {
		expect(stored).toEqual({ alpha: 4, beta: 3 });
	});

	test("the grant the scope parser derives lists only alpha rows, and no beta row", async () => {
		const parsed = repoScopeFromEnv({ [REPO_SCOPES_ENV]: JSON.stringify({ [SURFACE]: [ALPHA] }) });
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) throw new Error(parsed.problem);
		const repos = grantedRepos(parsed.value, SURFACE);
		expect(repos).toEqual([ALPHA]);

		const rows = await index.worktreeRegistry().list(filter({ repos }));
		expect(pathsOf(rows)).toEqual(ALPHA_PATHS);
		expect(rows.every((r) => r.repo.toLowerCase() === ALPHA)).toBe(true);
	});

	test("with state all, a grant for alpha returns alpha rows only, including the mixed-case spelling", async () => {
		const rows = await index.worktreeRegistry().list(filter({ repos: [ALPHA] }));
		expect(pathsOf(rows)).toEqual(ALPHA_PATHS);
		expect(rows.some((r) => r.path === "/work/beta-clean")).toBe(false);
	});

	test("state dirty under a grant for alpha returns the dirty alpha row, not the dirty beta row", async () => {
		const rows = await index.worktreeRegistry().list(filter({ repos: [ALPHA], state: "dirty" }));
		expect(pathsOf(rows)).toEqual(["/work/alpha-dirty"]);
	});

	test("state stale under a grant for alpha returns the stale alpha row, not the stale beta row", async () => {
		const rows = await index.worktreeRegistry().list(filter({ repos: [ALPHA], state: "stale" }));
		expect(pathsOf(rows)).toEqual(["/work/alpha-stale"]);
	});

	test("a named beta repository under a grant for alpha returns nothing: the grant wins over the named filter", async () => {
		const rows = await index.worktreeRegistry().list(filter({ repo: BETA, repos: [ALPHA] }));
		expect(rows).toEqual([]);
	});

	test("a named alpha repository under a grant for alpha returns the lowercase alpha rows; the named filter is an exact match, so the mixed-case row is not named", async () => {
		const rows = await index.worktreeRegistry().list(filter({ repo: ALPHA, repos: [ALPHA] }));
		expect(pathsOf(rows)).toEqual(["/work/alpha-clean", "/work/alpha-dirty", "/work/alpha-stale"]);
	});

	test("an empty grant matches no row", async () => {
		expect(await index.worktreeRegistry().list(filter({ repos: [] }))).toEqual([]);
	});

	test("the unfiltered read (repos null) returns both repositories, so beta is removed by the grant and not by absence", async () => {
		const rows = await index.worktreeRegistry().list(filter({ repos: null }));
		expect(pathsOf(rows)).toEqual([...ALPHA_PATHS, ...BETA_PATHS].sort());
	});

	test("a grant for both repositories returns every seeded row", async () => {
		const rows = await index.worktreeRegistry().list(filter({ repos: [ALPHA, BETA] }));
		expect(pathsOf(rows)).toEqual([...ALPHA_PATHS, ...BETA_PATHS].sort());
	});

	test("a limit of one under a grant for alpha returns one alpha row, though beta's rows are newer: the filter runs before the LIMIT", async () => {
		const rows = await index.worktreeRegistry().list(filter({ repos: [ALPHA], limit: 1 }));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.repo.toLowerCase()).toBe(ALPHA);
	});
});
