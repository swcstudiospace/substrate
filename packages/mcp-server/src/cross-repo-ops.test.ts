import { describe, expect, test } from "bun:test";
import { type BranchFanoutRequest, crossRepoStatus, runBranchFanout } from "./cross-repo-ops.ts";
import { defaultScopedGitRunner } from "./repo-executor.ts";
import { BRANCH, depsFor, FAILED, git, type Intercept, opOf, orFail, refIn, request, runnerWith, stepStates, world } from "./cross-repo-ops.testkit.ts";

describe("a branch fan-out across two registered repositories", () => {
	test("a branch is cut in every repository and each step is recorded applied with its planned sha", async () => {
		const w = world();
		const { run, writes } = runnerWith();
		const op = opOf(await runBranchFanout(request(), depsFor(w, run)));
		expect(op.status).toBe("done");
		expect(stepStates(op)).toEqual(["owner/a:applied", "owner/b:applied"]);
		for (const step of op.steps) expect(step.plannedSha).toMatch(/^[0-9a-f]{40}$/);
		expect(refIn(w.checkoutA, `refs/heads/${BRANCH}`)).toBe(op.steps[0]?.plannedSha ?? null);
		expect(refIn(w.checkoutB, `refs/heads/${BRANCH}`)).toBe(op.steps[1]?.plannedSha ?? null);
		expect(writes.map((write) => write.cwd)).toEqual([w.checkoutA, w.checkoutB]);
	});

	test("a retry with the same key runs no effect and returns the stored operation", async () => {
		const w = world();
		await runBranchFanout(request(), depsFor(w, runnerWith().run));
		const retry = runnerWith();
		const again = opOf(await runBranchFanout(request(), depsFor(w, retry.run)));
		expect(again.status).toBe("done");
		expect(retry.writes).toHaveLength(0);
	});

	test("a request under a stored key with a different branch is refused and writes nothing", async () => {
		const w = world();
		await runBranchFanout(request(), depsFor(w, runnerWith().run));
		const writesBefore = w.store.writes;
		const other = runnerWith();
		const outcome = await runBranchFanout(request({ branch: "feature/other" }), depsFor(w, other.run));
		expect(outcome).toMatchObject({ ok: false, reason: "key-reused" });
		expect(other.writes).toHaveLength(0);
		expect(w.store.writes).toBe(writesBefore);
		expect(refIn(w.checkoutA, "refs/heads/feature/other")).toBeNull();
	});

	test("a branch that already sits at the planned sha is not adopted: it is refused, and the rollback leaves it in place", async () => {
		const w = world();
		const mainB = refIn(w.checkoutB, "refs/heads/main");
		git(w.checkoutB, ["branch", BRANCH, "main"]);
		const op = opOf(await runBranchFanout(request(), depsFor(w, runnerWith().run)));
		expect(op.status).toBe("rolled-back");
		expect(stepStates(op)).toEqual(["owner/a:compensated", "owner/b:failed/ref-exists"]);
		expect(refIn(w.checkoutB, `refs/heads/${BRANCH}`)).toBe(mainB);
	});
});

describe("a forced failure at a later step compensates the earlier ones", () => {
	test("a failed create at the second repository undoes the first and reports rolled-back, never done", async () => {
		const w = world();
		const failSecond: Intercept = (args, cwd) => (args[0] === "update-ref" && cwd === w.checkoutB ? FAILED : undefined);
		const op = opOf(await runBranchFanout(request(), depsFor(w, runnerWith(failSecond).run)));
		expect(op.status).toBe("rolled-back");
		expect(stepStates(op)).toEqual(["owner/a:compensated", "owner/b:failed/apply-failed"]);
		expect(refIn(w.checkoutA, `refs/heads/${BRANCH}`)).toBeNull();
		expect(refIn(w.checkoutB, `refs/heads/${BRANCH}`)).toBeNull();
	});

	test("a failure at the first repository stops the run: the second is never attempted and stays pending", async () => {
		const w = world();
		const failFirst: Intercept = (args, cwd) => (args[0] === "update-ref" && cwd === w.checkoutA ? FAILED : undefined);
		const attempt = runnerWith(failFirst);
		const op = opOf(await runBranchFanout(request(), depsFor(w, attempt.run)));
		expect(op.status).toBe("rolled-back");
		expect(stepStates(op)).toEqual(["owner/a:failed/apply-failed", "owner/b:pending"]);
		expect(attempt.writes.map((write) => write.cwd)).toEqual([w.checkoutA]);
		expect(refIn(w.checkoutB, `refs/heads/${BRANCH}`)).toBeNull();
	});

	test("a rolled-back operation is terminal: a retry performs no git call", async () => {
		const w = world();
		const failSecond: Intercept = (args, cwd) => (args[0] === "update-ref" && cwd === w.checkoutB ? FAILED : undefined);
		await runBranchFanout(request(), depsFor(w, runnerWith(failSecond).run));
		const retry = runnerWith();
		const op = opOf(await runBranchFanout(request(), depsFor(w, retry.run)));
		expect(op.status).toBe("rolled-back");
		expect(retry.writes).toHaveLength(0);
	});

	test("a ref moved by an outside change is parked and left alone; the retry neither deletes it nor repeats a create", async () => {
		const w = world();
		const outside = git(w.checkoutA, ["commit-tree", "HEAD^{tree}", "-p", "main", "-m", "outside change"]);
		let moved = false;
		const outsideMove: Intercept = (args, cwd) => {
			if (args[0] !== "update-ref" || cwd !== w.checkoutB || moved) return undefined;
			moved = true;
			defaultScopedGitRunner(["update-ref", `refs/heads/${BRANCH}`, outside], w.checkoutA, {});
			return FAILED;
		};
		const first = opOf(await runBranchFanout(request(), depsFor(w, runnerWith(outsideMove).run)));
		expect(first.status).toBe("needs-attention");
		expect(stepStates(first)).toEqual(["owner/a:parked/ref-moved", "owner/b:failed/apply-failed"]);
		expect(refIn(w.checkoutA, `refs/heads/${BRANCH}`)).toBe(outside);

		const retry = runnerWith();
		const second = opOf(await runBranchFanout(request(), depsFor(w, retry.run)));
		expect(second.status).toBe("needs-attention");
		expect(stepStates(second)).toEqual(["owner/a:parked/ref-moved", "owner/b:failed/apply-failed"]);
		expect(retry.writes).toHaveLength(0);
		expect(refIn(w.checkoutA, `refs/heads/${BRANCH}`)).toBe(outside);
	});

	test("a failed compensating delete parks the step, and a retry completes the rollback", async () => {
		const w = world();
		let failedDelete = false;
		const failFirstDelete: Intercept = (args, cwd) => {
			if (args[0] === "update-ref" && cwd === w.checkoutB) return FAILED;
			if (args[0] === "update-ref" && args[1] === "-d" && cwd === w.checkoutA && !failedDelete) {
				failedDelete = true;
				return FAILED;
			}
			return undefined;
		};
		const first = opOf(await runBranchFanout(request(), depsFor(w, runnerWith(failFirstDelete).run)));
		expect(first.status).toBe("needs-attention");
		expect(stepStates(first)).toEqual(["owner/a:parked/undo-failed", "owner/b:failed/apply-failed"]);
		expect(refIn(w.checkoutA, `refs/heads/${BRANCH}`)).not.toBeNull();

		const second = opOf(await runBranchFanout(request(), depsFor(w, runnerWith().run)));
		expect(second.status).toBe("rolled-back");
		expect(stepStates(second)).toEqual(["owner/a:compensated", "owner/b:failed/apply-failed"]);
		expect(refIn(w.checkoutA, `refs/heads/${BRANCH}`)).toBeNull();
	});
});

describe("a crash between an effect and its record is resumed without a second effect", () => {
	test("a crash after the create landed is adopted on retry, not created again", async () => {
		const w = world();
		let crashed = false;
		const crashAfterSecondCreate: Intercept = (args, cwd, env) => {
			if (args[0] !== "update-ref" || cwd !== w.checkoutB || crashed) return undefined;
			crashed = true;
			defaultScopedGitRunner(args, cwd, env);
			throw new Error("simulated crash");
		};
		await expect(runBranchFanout(request(), depsFor(w, runnerWith(crashAfterSecondCreate).run))).rejects.toThrow("simulated crash");
		const stored = await w.store.load("op-1");
		expect(stored?.status).toBe("running");
		expect(stepStates(orFail(stored))).toEqual(["owner/a:applied", "owner/b:applying"]);

		const retry = runnerWith();
		const op = opOf(await runBranchFanout(request(), depsFor(w, retry.run)));
		expect(op.status).toBe("done");
		expect(stepStates(op)).toEqual(["owner/a:applied", "owner/b:applied/adopted"]);
		expect(retry.writes).toHaveLength(0);
		expect(refIn(w.checkoutB, `refs/heads/${BRANCH}`)).toBe(op.steps[1]?.plannedSha ?? null);
	});

	test("a crash before the create ran leaves the step applying, and the retry creates it once", async () => {
		const w = world();
		let crashed = false;
		const crashBeforeCreate: Intercept = (args, cwd) => {
			if (args[0] !== "update-ref" || cwd !== w.checkoutB || crashed) return undefined;
			crashed = true;
			throw new Error("simulated crash");
		};
		await expect(runBranchFanout(request(), depsFor(w, runnerWith(crashBeforeCreate).run))).rejects.toThrow("simulated crash");
		const retry = runnerWith();
		const op = opOf(await runBranchFanout(request(), depsFor(w, retry.run)));
		expect(op.status).toBe("done");
		expect(retry.writes.map((write) => write.cwd)).toEqual([w.checkoutB]);
	});
});

describe("refusals run no git and write nothing", () => {
	test("a surface not granted a repository is refused before any git call or store write", async () => {
		const w = world({ omp: ["owner/a", "owner/b"], cursor: ["owner/a"] });
		const { run, writes } = runnerWith();
		const outcome = await runBranchFanout(request(), depsFor(w, run, "cursor"));
		expect(outcome).toMatchObject({ ok: false, reason: "repo-not-granted" });
		expect(writes).toHaveLength(0);
		expect(w.store.writes).toBe(0);
	});

	test("an anonymous caller is refused when scoping is enforced", async () => {
		const w = world();
		const outcome = await runBranchFanout(request(), depsFor(w, runnerWith().run, null));
		expect(outcome).toMatchObject({ ok: false, reason: "repo-not-granted" });
		expect(w.store.writes).toBe(0);
	});

	test("a repository with no registration is refused", async () => {
		const w = world({ omp: ["owner/a", "owner/zzz"] });
		const outcome = await runBranchFanout(request({ repos: [{ repo: "owner/a", base: "main" }, { repo: "owner/zzz", base: "main" }] }), depsFor(w, runnerWith().run));
		expect(outcome).toMatchObject({ ok: false, reason: "repo-not-registered" });
		expect(w.store.writes).toBe(0);
	});

	test("a base that names no commit in a repository is refused before the store is written", async () => {
		const w = world();
		const outcome = await runBranchFanout(request({ repos: [{ repo: "owner/a", base: "main" }, { repo: "owner/b", base: "no-such-base" }] }), depsFor(w, runnerWith().run));
		expect(outcome).toMatchObject({ ok: false, reason: "base-unresolved" });
		expect(w.store.writes).toBe(0);
	});

	test("a branch name git rejects is refused before the store is written", async () => {
		const w = world();
		const outcome = await runBranchFanout(request({ branch: "feature..x" }), depsFor(w, runnerWith().run));
		expect(outcome).toMatchObject({ ok: false, reason: "branch-invalid" });
		expect(w.store.writes).toBe(0);
	});

	test("malformed requests are refused with a message that names the field and not the value", async () => {
		const w = world();
		const deps = depsFor(w, runnerWith().run);
		const cases: Array<[BranchFanoutRequest, string]> = [
			[request({ key: "has space" }), "key"],
			[request({ branch: "-x" }), "branch"],
			[request({ repos: [{ repo: "owner/a", base: "main" }] }), "between 2 and 16"],
			[request({ repos: [{ repo: "owner/a", base: "main" }, { repo: "OWNER/A", base: "main" }] }), "once"],
			[request({ repos: [{ repo: "not a repo", base: "main" }, { repo: "owner/b", base: "main" }] }), "repos[0].repo"],
			[request({ repos: [{ repo: "owner/a", base: "--output=x" }, { repo: "owner/b", base: "main" }] }), "repos[0].base"],
		];
		for (const [input, field] of cases) {
			const outcome = await runBranchFanout(input, deps);
			expect(outcome).toMatchObject({ ok: false, reason: "request-invalid" });
			if (outcome.ok) throw new Error("expected a refusal");
			expect(outcome.problem).toContain(field);
			expect(outcome.problem).not.toContain("has space");
		}
		expect(w.store.writes).toBe(0);
	});
});

describe("status exposes the stored operation to a granted surface only", () => {
	test("a parked step is visible to the surface that drove it, with its reason", async () => {
		const w = world({ omp: ["owner/a", "owner/b"] });
		const failSecond: Intercept = (args, cwd) => (args[0] === "update-ref" && cwd === w.checkoutB ? FAILED : undefined);
		let failedDelete = false;
		const parkFirst: Intercept = (args, cwd, env) => {
			if (args[0] === "update-ref" && args[1] === "-d" && cwd === w.checkoutA && !failedDelete) {
				failedDelete = true;
				return FAILED;
			}
			return failSecond(args, cwd, env);
		};
		await runBranchFanout(request(), depsFor(w, runnerWith(parkFirst).run));
		const status = await crossRepoStatus("op-1", depsFor(w, runnerWith().run));
		expect(status?.status).toBe("needs-attention");
		expect(stepStates(orFail(status))).toEqual(["owner/a:parked/undo-failed", "owner/b:failed/apply-failed"]);
	});

	test("a surface not granted every repository of the operation sees nothing, as for an unknown key", async () => {
		const w = world({ omp: ["owner/a", "owner/b"], cursor: ["owner/a"] });
		await runBranchFanout(request(), depsFor(w, runnerWith().run));
		expect(await crossRepoStatus("op-1", depsFor(w, runnerWith().run, "cursor"))).toBeNull();
		expect((await crossRepoStatus("op-1", depsFor(w, runnerWith().run, "omp")))?.status).toBe("done");
	});

	test("an unknown or malformed key names no operation", async () => {
		const w = world();
		expect(await crossRepoStatus("never-written", depsFor(w, runnerWith().run))).toBeNull();
		expect(await crossRepoStatus("bad key", depsFor(w, runnerWith().run))).toBeNull();
	});
});
