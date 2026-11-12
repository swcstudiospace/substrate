import { describe, expect, test } from "bun:test";
import { type BranchFanoutRequest, type CrossRepoStore, crossRepoFanoutReply, crossRepoStatus, crossRepoStatusReply, runBranchFanout } from "./cross-repo-ops.ts";
import { REPO_ALLOWLIST_ENV } from "./repo-allowlist.ts";
import { defaultScopedGitRunner, type ScopedGitResult } from "./repo-executor.ts";
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

describe("undo never deletes a ref the operation did not create", () => {
	const UNREADABLE: ScopedGitResult = { code: 128, stdout: "", stderr: "injected read failure" };

	test("a step whose first ref read fails never attempted its create: it is failed, not parked, and a branch already there is kept", async () => {
		const w = world();
		git(w.checkoutB, ["branch", BRANCH, "main"]);
		const mainB = refIn(w.checkoutB, "refs/heads/main");
		let unreadable = false;
		const readFailsOnce: Intercept = (args, cwd) => {
			if (args[0] !== "rev-parse" || args[3] !== `refs/heads/${BRANCH}` || cwd !== w.checkoutB || unreadable) return undefined;
			unreadable = true;
			return UNREADABLE;
		};
		const attempt = runnerWith(readFailsOnce);
		const op = opOf(await runBranchFanout(request(), depsFor(w, attempt.run)));
		expect(op.status).toBe("rolled-back");
		expect(stepStates(op)).toEqual(["owner/a:compensated", "owner/b:failed/apply-failed"]);
		expect(attempt.writes.filter((write) => write.cwd === w.checkoutB)).toHaveLength(0);
		expect(refIn(w.checkoutB, `refs/heads/${BRANCH}`)).toBe(mainB);
		expect(refIn(w.checkoutA, `refs/heads/${BRANCH}`)).toBeNull();
	});

	test("a ref another writer put at the planned sha during the create is adopted, never deleted by the rollback", async () => {
		const w = world();
		const mainA = git(w.checkoutA, ["rev-parse", "main"]);
		let raced = false;
		const racedCreate: Intercept = (args, cwd, env) => {
			if (args[0] === "update-ref" && args[1] !== "-d" && cwd === w.checkoutA && !raced) {
				raced = true;
				defaultScopedGitRunner(["update-ref", `refs/heads/${BRANCH}`, mainA], w.checkoutA, env);
				return FAILED;
			}
			return args[0] === "update-ref" && cwd === w.checkoutB ? FAILED : undefined;
		};
		const op = opOf(await runBranchFanout(request(), depsFor(w, runnerWith(racedCreate).run)));
		expect(op.status).toBe("needs-attention");
		expect(stepStates(op)).toEqual(["owner/a:parked/adopted", "owner/b:failed/apply-failed"]);
		expect(refIn(w.checkoutA, `refs/heads/${BRANCH}`)).toBe(mainA);

		const retry = runnerWith();
		const again = opOf(await runBranchFanout(request(), depsFor(w, retry.run)));
		expect(again.status).toBe("needs-attention");
		expect(stepStates(again)).toEqual(["owner/a:parked/adopted", "owner/b:failed/apply-failed"]);
		expect(retry.writes).toHaveLength(0);
		expect(refIn(w.checkoutA, `refs/heads/${BRANCH}`)).toBe(mainA);
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

describe("the session allowlist applies to every git call, on top of the surface grant", () => {
	test("a surface granted a repository by its scope is refused when its allowlist entry does not name it, before any git call", async () => {
		const w = world();
		const env = { ...w.env, [REPO_ALLOWLIST_ENV]: JSON.stringify({ omp: { "owner/a": "XRO_TEST_CREDENTIAL_0" } }) };
		let gitCalls = 0;
		const { run } = runnerWith(() => {
			gitCalls += 1;
			return undefined;
		});
		const outcome = await runBranchFanout(request(), depsFor(w, run, "omp", env));
		expect(outcome).toMatchObject({ ok: false, reason: "repo-not-granted" });
		expect(gitCalls).toBe(0);
		expect(w.store.writes).toBe(0);
	});

	test("a malformed allowlist grants nothing: every repository is refused before any git call", async () => {
		const w = world();
		const env = { ...w.env, [REPO_ALLOWLIST_ENV]: "{not json" };
		const { run, writes } = runnerWith();
		expect(await runBranchFanout(request(), depsFor(w, run, "omp", env))).toMatchObject({ ok: false, reason: "repo-not-granted" });
		expect(writes).toHaveLength(0);
		expect(w.store.writes).toBe(0);
	});

	test("a session absent from the allowlist sees no operation, though its surface is granted every repository", async () => {
		const w = world();
		await runBranchFanout(request(), depsFor(w, runnerWith().run));
		const env = { ...w.env, [REPO_ALLOWLIST_ENV]: "{}" };
		expect(await crossRepoStatus("op-1", depsFor(w, runnerWith().run, "omp", env))).toBeNull();
	});
});

describe("the operation persists each step before its git effect", () => {
	test("a step is applying in the store before its create runs, and applied only after the create is read back", async () => {
		const w = world();
		const log: string[] = [];
		const store: CrossRepoStore = {
			create: (input) => w.store.create(input),
			load: (key) => w.store.load(key),
			moveStep: async (key, index, from, to, detail, at) => {
				const moved = await w.store.moveStep(key, index, from, to, detail, at);
				if (moved) log.push(`step ${index} ${to}`);
				return moved;
			},
			setStatus: (key, status, at) => w.store.setStatus(key, status, at),
		};
		const { run } = runnerWith((args, cwd) => {
			if (args[0] === "update-ref" && args[1] !== "-d") log.push(`ref ${cwd === w.checkoutA ? "a" : "b"}`);
			return undefined;
		});
		const op = opOf(await runBranchFanout(request(), depsFor({ ...w, store }, run)));
		expect(op.status).toBe("done");
		expect(log).toEqual(["step 0 applying", "ref a", "step 0 applied", "step 1 applying", "ref b", "step 1 applied"]);
	});
});

describe("the boundary answers malformed input with an explicit error and writes nothing", () => {
	test("a body that is not a JSON object, names a field it does not read, or carries a malformed field is refused with 400", async () => {
		const w = world();
		const deps = depsFor(w, runnerWith().run);
		const bodies: unknown[] = [null, [], "owner/a", { ...request(), extra: "secret-value" }, { key: "op-1", branch: BRANCH, repos: "owner/a" }, { ...request(), key: "bad key" }];
		for (const body of bodies) {
			const reply = await crossRepoFanoutReply(body, deps);
			expect(reply.status).toBe(400);
			expect(reply.body).toMatchObject({ ok: false, reason: "request-invalid" });
			expect(JSON.stringify(reply.body)).not.toContain("secret-value");
		}
		expect(w.store.writes).toBe(0);
	});

	test("a reused key is 409, an unlisted repository is 403, and an anonymous caller is 403; a retry of a granted key is 200 with no ref write", async () => {
		const w = world({ omp: ["owner/a", "owner/b"], cursor: ["owner/a"] });
		const first = runnerWith();
		expect((await crossRepoFanoutReply(request(), depsFor(w, first.run))).status).toBe(200);
		const retry = runnerWith();
		expect(await crossRepoFanoutReply(request(), depsFor(w, retry.run))).toMatchObject({ status: 200, body: { ok: true, operation: { status: "done" } } });
		expect(retry.writes).toHaveLength(0);
		expect(await crossRepoFanoutReply(request({ branch: "feature/other" }), depsFor(w, runnerWith().run))).toMatchObject({ status: 409, body: { reason: "key-reused" } });
		expect(await crossRepoFanoutReply(request({ key: "op-2" }), depsFor(w, runnerWith().run, "cursor"))).toMatchObject({ status: 403, body: { reason: "repo-not-granted" } });
		expect(await crossRepoFanoutReply(request({ key: "op-3" }), depsFor(w, runnerWith().run, null))).toMatchObject({ status: 403 });
	});
});

describe("the status reply answers a malformed key with 400, an unseen key with 404, and a stored operation with 200", () => {
	test("each status is answered from the stored operation and reveals nothing for an unseen key", async () => {
		const w = world();
		await crossRepoFanoutReply(request(), depsFor(w, runnerWith().run));
		expect(await crossRepoStatusReply(undefined, depsFor(w, runnerWith().run))).toMatchObject({ status: 400, body: { reason: "request-invalid" } });
		expect(await crossRepoStatusReply("bad key", depsFor(w, runnerWith().run))).toMatchObject({ status: 400 });
		expect(await crossRepoStatusReply("never-written", depsFor(w, runnerWith().run))).toMatchObject({ status: 404, body: { reason: "not-found" } });
		expect(await crossRepoStatusReply("op-1", depsFor(w, runnerWith().run))).toMatchObject({ status: 200, body: { ok: true, operation: { status: "done" } } });
	});
});

const BRANCH_REF = `refs/heads/${BRANCH}`;

describe("concurrent drivers of one operation key never interleave their steps", () => {
	test("two overlapping drivers create each branch once and both report the same done operation", async () => {
		const w = world();
		const first = runnerWith();
		const second = runnerWith();
		const [x, y] = await Promise.all([runBranchFanout(request(), depsFor(w, first.run)), runBranchFanout(request(), depsFor(w, second.run))]);
		const op = opOf(x);
		expect(opOf(y).status).toBe("done");
		expect(stepStates(op)).toEqual(["owner/a:applied", "owner/b:applied"]);
		expect(first.writes.length + second.writes.length).toBe(2);
		expect(refIn(w.checkoutA, BRANCH_REF)).toBe(op.steps[0]?.plannedSha ?? null);
		expect(refIn(w.checkoutB, BRANCH_REF)).toBe(op.steps[1]?.plannedSha ?? null);
	});

	test("a driver that finds a live applying step waits for it: it creates nothing and the live step is not reclassified", async () => {
		const w = world();
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const live = runnerWith();
		const waiting = runnerWith();
		const pausedStore = pausingAtApplying(w.store, () => {
			reached.resolve();
			return release.promise;
		});
		const first = runBranchFanout(request(), depsFor({ ...w, store: pausedStore }, live.run));
		await reached.promise;
		const second = runBranchFanout(request(), depsFor(w, waiting.run));
		await flush();
		expect(waiting.writes).toHaveLength(0);
		release.resolve();
		const [x, y] = await Promise.all([first, second]);
		expect(stepStates(opOf(x))).toEqual(["owner/a:applied", "owner/b:applied"]);
		expect(opOf(y).status).toBe("done");
		expect(live.writes).toHaveLength(2);
		expect(waiting.writes).toHaveLength(0);
	});

	test("overlapping drivers that roll back leave no branch in any repository", async () => {
		const w = world();
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const failSecond: Intercept = (args, cwd) => (args[0] === "update-ref" && cwd === w.checkoutB ? FAILED : undefined);
		const pausedStore = pausingAtApplying(w.store, () => {
			reached.resolve();
			return release.promise;
		});
		const first = runBranchFanout(request(), depsFor({ ...w, store: pausedStore }, runnerWith(failSecond).run));
		await reached.promise;
		const second = runBranchFanout(request(), depsFor(w, runnerWith(failSecond).run));
		await flush();
		release.resolve();
		const outcomes = await Promise.all([first, second]);
		for (const outcome of outcomes) {
			const op = opOf(outcome);
			expect(op.status).toBe("rolled-back");
			expect(stepStates(op)).toEqual(["owner/a:compensated", "owner/b:failed/apply-failed"]);
		}
		expect(refIn(w.checkoutA, BRANCH_REF)).toBeNull();
		expect(refIn(w.checkoutB, BRANCH_REF)).toBeNull();
	});

	test("a driver that throws releases its key: a retry of the same key completes the operation", async () => {
		const w = world();
		const crash: Intercept = (args, cwd) => {
			if (args[0] === "update-ref" && cwd === w.checkoutA) throw new Error("simulated crash");
			return undefined;
		};
		await expect(runBranchFanout(request(), depsFor(w, runnerWith(crash).run))).rejects.toThrow("simulated crash");
		const retry = runnerWith();
		const op = opOf(await runBranchFanout(request(), depsFor(w, retry.run)));
		expect(op.status).toBe("done");
		expect(stepStates(op)).toEqual(["owner/a:applied", "owner/b:applied"]);
	});
});

/**
 * Lets every concurrent driver run until it first waits. The store is in-process, so each driver's next step is a microtask: a
 * fixed number of turns reaches the point where a driver that is not waiting would have written. No wall-clock timer is needed.
 */
async function flush(): Promise<void> {
	for (let turn = 0; turn < 200; turn++) await Promise.resolve();
}

/**
 * A store whose first `applying` move pauses once it has landed: the step is live in the store while its git call has not run.
 */
function pausingAtApplying(inner: CrossRepoStore, pause: () => Promise<void>): CrossRepoStore {
	let paused = false;
	return {
		create: (input) => inner.create(input),
		load: (key) => inner.load(key),
		moveStep: async (...args) => {
			const moved = await inner.moveStep(...args);
			if (moved && args[3] === "applying" && !paused) {
				paused = true;
				await pause();
			}
			return moved;
		},
		setStatus: (key, status, at) => inner.setStatus(key, status, at),
	};
}
