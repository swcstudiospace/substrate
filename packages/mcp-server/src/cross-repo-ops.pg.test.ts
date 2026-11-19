/**
 * A branch fan-out over the live index: its steps are durable in Postgres, so a fresh `IndexStore` on the same database resumes
 * an operation that crashed, and reads the parked result of one that could not compensate. These skip unless a database is given:
 *
 *     SUBSTRATE_TEST_PG_URL=postgres://… bun test cross-repo-ops.pg
 *
 * The repositories are temporary git checkouts; the database should be disposable.
 */
import { describe, expect, test } from "bun:test";
import { crossRepoStatus, type CrossRepoStore, runBranchFanout } from "./cross-repo-ops.ts";
import { depsFor, FAILED, git, type Intercept, opOf, orFail, refIn, repos, request, runnerWith, stepStates } from "./cross-repo-ops.testkit.ts";
import { defaultScopedGitRunner } from "./repo-executor.ts";
import { IndexStore } from "./index-store.ts";
import { defined } from "./test-support.ts";

const PG_URL = process.env.SUBSTRATE_TEST_PG_URL?.trim();
const MARKER = `ut-xro-${Date.now().toString(36)}`;
const BRANCH = "feature/x";

const describeLive = PG_URL ? describe : describe.skip;

/** Opens a fresh index over the database and runs `fn` with its operation log; the index is closed after, even on failure. */
async function withStore<T>(fn: (store: CrossRepoStore) => Promise<T>): Promise<T> {
	const index = new IndexStore(defined(PG_URL, "SUBSTRATE_TEST_PG_URL"));
	try {
		await index.migrate();
		return await fn(index.crossRepoStore());
	} finally {
		await index.close().catch(() => undefined);
	}
}

describeLive("a branch fan-out over the live index", () => {
	test("a crash after a create lands is resumed by a fresh index over the same database, with no second create", async () => {
		const r = repos();
		const key = `${MARKER}-crash`;
		let crashed = false;
		const crashAfterSecondCreate: Intercept = (args, cwd, env) => {
			if (args[0] !== "update-ref" || cwd !== r.checkoutB || crashed) return undefined;
			crashed = true;
			defaultScopedGitRunner(args, cwd, env);
			throw new Error("simulated crash");
		};
		await withStore(async (store) => {
			await expect(runBranchFanout(request({ key }), depsFor({ ...r, store }, runnerWith(crashAfterSecondCreate).run))).rejects.toThrow("simulated crash");
		});

		const retry = runnerWith();
		const op = await withStore(async (store) => opOf(await runBranchFanout(request({ key }), depsFor({ ...r, store }, retry.run))));
		expect(op.status).toBe("done");
		expect(stepStates(op)).toEqual(["owner/a:applied", "owner/b:applied/adopted"]);
		expect(retry.writes).toHaveLength(0);
		expect(refIn(r.checkoutB, `refs/heads/${BRANCH}`)).toBe(op.steps[1]?.plannedSha ?? null);
	});

	test("a parked compensation is read back by a fresh index, and the ref an outside change moved is left as it is", async () => {
		const r = repos();
		const key = `${MARKER}-parked`;
		const outside = git(r.checkoutA, ["commit-tree", "HEAD^{tree}", "-p", "main", "-m", "outside change"]);
		let moved = false;
		const outsideMove: Intercept = (args, cwd) => {
			if (args[0] !== "update-ref" || cwd !== r.checkoutB || moved) return undefined;
			moved = true;
			defaultScopedGitRunner(["update-ref", `refs/heads/${BRANCH}`, outside], r.checkoutA, {});
			return FAILED;
		};
		await withStore(async (store) => opOf(await runBranchFanout(request({ key }), depsFor({ ...r, store }, runnerWith(outsideMove).run))));

		const status = await withStore(async (store) => orFail(await crossRepoStatus(key, depsFor({ ...r, store }, runnerWith().run))));
		expect(status.status).toBe("needs-attention");
		expect(stepStates(status)).toEqual(["owner/a:parked/ref-moved", "owner/b:failed/apply-failed"]);
		expect(refIn(r.checkoutA, `refs/heads/${BRANCH}`)).toBe(outside);
	});
});
