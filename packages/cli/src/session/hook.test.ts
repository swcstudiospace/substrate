/**
 * `substrate session hook <trigger>`: a checkpoint at each automatic boundary through `runSession`, with the
 * in-memory server on the wire format, and the fail-open contract: every error path exits 0 with nothing on
 * stdout. The clock is injected; nothing sleeps.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type Runner, spawnRunner } from "../../../worktree-snapshot/src/index.ts";
import { cleanupTemp, git, makeRepo, tempDir, writeFiles } from "../../../worktree-snapshot/src/testkit.ts";
import { type LocalCheckpoint, listLocalCheckpoints } from "./checkpoint.ts";
import { EXIT_DONE, type SessionDeps, runSession } from "./command.ts";
import { HOOK_TIMEOUT_MS, MAX_ENVELOPE_BYTES, parseEnvelope, runHook, unconsumedHints } from "./hook.ts";
import { resolvePendingDir } from "./pending.ts";
import { consumedPath, readConsumed } from "./steering-consumed.ts";
import { FakeServer, FakeTranscript, fetchFor, seededRandomBytes } from "./testkit.ts";
import type { SteerDirective, SteerFetch } from "../steer/client.ts";

afterAll(cleanupTemp);
setDefaultTimeout(300_000);

const SESSION = "sess-1";
const T0 = Date.parse("2026-01-01T00:00:00.000Z");

interface Rig {
	dir: string;
	server: FakeServer;
	steer: SteerStub;
	out: string[];
	err: string[];
	clock: { ms: number };
	deps: SessionDeps;
}

/** What the REST routes the steering and context triggers read answer with. `down` throws like a refused connection; `garbage` answers 200 with HTML. */
interface SteerStub {
	mode: "up" | "down" | "garbage";
	directives: unknown[];
	context: unknown;
	calls: Array<{ path: string; search: string; authorization: string | undefined }>;
}

function steerFetchFor(stub: SteerStub): SteerFetch {
	return async (input, init) => {
		const url = new URL(input);
		stub.calls.push({ path: url.pathname, search: url.search, authorization: init.headers.authorization });
		if (stub.mode === "down") throw new TypeError("fetch failed");
		if (stub.mode === "garbage") return new Response("<html>not json</html>", { status: 200 });
		if (url.pathname === "/steering/directives") return Response.json({ directives: stub.directives });
		if (url.pathname === "/session/context") return Response.json(stub.context);
		return new Response("{}", { status: 404 });
	};
}

function rig(overrides: Partial<SessionDeps> = {}, repo = true): Rig {
	const dir = repo ? makeRepo() : tempDir();
	if (repo) writeFiles(dir, { "a.txt": "alpha\n" });
	const server = new FakeServer();
	const steer: SteerStub = { mode: "up", directives: [], context: {}, calls: [] };
	const out: string[] = [];
	const err: string[] = [];
	const clock = { ms: T0 };
	const deps: SessionDeps = {
		worktree: dir,
		url: "http://127.0.0.1:7410",
		tokenFor: () => "tok-CANARY-0123456789abcdef-secret",
		timeoutMs: 1500,
		now: () => new Date(clock.ms),
		randomBytes: seededRandomBytes(9),
		transcript: new FakeTranscript(),
		out: (text) => out.push(text),
		err: (text) => err.push(text),
		fetch: fetchFor(server),
		steerFetch: steerFetchFor(steer),
		...overrides,
	};
	return { dir, server, steer, out, err, clock, deps };
}

const envelope = (r: Rig, extra: Record<string, unknown> = {}): string =>
	JSON.stringify({ session_id: SESSION, cwd: r.dir, transcript_path: "/home/someone/.claude/projects/x/t.jsonl", ...extra });

/** Run the hook with `stdin` as the envelope text. */
async function hook(r: Rig, stdin: string, ...argv: string[]): Promise<number> {
	r.out.length = 0;
	r.err.length = 0;
	return runSession(["hook", ...argv], { ...r.deps, stdin: async () => stdin });
}

const mine = async (r: Rig): Promise<LocalCheckpoint[]> => (await listLocalCheckpoints({ worktree: r.dir })).checkpoints.filter((c) => c.session_id === SESSION);

/** The one stderr line of a `--verbose` run. */
function verboseLine(r: Rig): string {
	const lines = r.err.join("").split("\n").filter((line) => line.length > 0);
	expect(lines).toHaveLength(1);
	return lines[0] as string;
}

describe("a turn hook creates one checkpoint", () => {
	test("trigger turn, the envelope's session, nothing on stdout or stderr, one ledger record", async () => {
		const r = rig();
		expect(await hook(r, envelope(r), "turn")).toBe(EXIT_DONE);
		expect(r.out).toEqual([]);
		expect(r.err).toEqual([]);
		const checkpoints = await mine(r);
		expect(checkpoints).toHaveLength(1);
		expect(checkpoints[0]?.trigger).toBe("turn");
		expect(checkpoints[0]?.session_id).toBe(SESSION);
		expect(checkpoints[0]?.seq).toBe(1);
		expect(checkpoints[0]?.taken_at_ms).toBe(T0);
		expect(r.server.deliveries.checkpoint).toBe(1);
		expect([...r.server.checkpoints.values()].map((c) => c.trigger)).toEqual(["turn"]);
	});

	test("--verbose writes one line naming the checkpoint, still nothing on stdout", async () => {
		const r = rig();
		expect(await hook(r, envelope(r), "turn", "--verbose")).toBe(EXIT_DONE);
		expect(r.out).toEqual([]);
		const [checkpoint] = await mine(r);
		expect(verboseLine(r)).toContain(`created checkpoint ${checkpoint?.ckpt_id}`);
	});

	test("--session wins over the envelope's session_id", async () => {
		const r = rig();
		await hook(r, envelope(r), "turn", "--session", "sess-flag");
		const all = (await listLocalCheckpoints({ worktree: r.dir })).checkpoints;
		expect(all.map((c) => c.session_id)).toEqual(["sess-flag"]);
	});

	test("with no session id anywhere, the one session that has checkpoints in the worktree is used", async () => {
		const r = rig();
		expect(await runSession(["checkpoint", "--session", SESSION, "--json"], r.deps)).toBe(EXIT_DONE);
		r.clock.ms += 120_000;
		writeFiles(r.dir, { "a.txt": "beta\n" });
		expect(await hook(r, "", "turn")).toBe(EXIT_DONE);
		expect((await mine(r)).map((c) => c.trigger)).toEqual(["manual", "turn"]);
	});
});

describe("the rate limit and the unchanged-tree skip", () => {
	test("turn: one per minute, the boundary included", async () => {
		const r = rig();
		await hook(r, envelope(r), "turn");
		r.clock.ms = T0 + 30_000;
		writeFiles(r.dir, { "a.txt": "beta\n" });
		await hook(r, envelope(r), "turn", "--verbose");
		expect(verboseLine(r)).toContain("rate limited");
		expect(await mine(r)).toHaveLength(1);
		r.clock.ms = T0 + 59_999;
		await hook(r, envelope(r), "turn");
		expect(await mine(r)).toHaveLength(1);
		r.clock.ms = T0 + 60_000;
		await hook(r, envelope(r), "turn");
		expect((await mine(r)).map((c) => c.seq)).toEqual([1, 2]);
	});

	test("an unchanged worktree is skipped however long ago the last checkpoint was", async () => {
		const r = rig();
		await hook(r, envelope(r), "turn");
		r.clock.ms = T0 + 3_600_000;
		await hook(r, envelope(r), "turn", "--verbose");
		expect(verboseLine(r)).toContain("unchanged");
		expect(await mine(r)).toHaveLength(1);
		expect(r.server.deliveries.checkpoint).toBe(1);
		writeFiles(r.dir, { "a.txt": "beta\n" });
		await hook(r, envelope(r), "turn");
		expect(await mine(r)).toHaveLength(2);
	});

	test("plan-step: one per ten seconds, and the plan reference is recorded", async () => {
		const r = rig();
		await hook(r, envelope(r), "plan-step", "--plan-phase", "61", "--plan-step", "3");
		let checkpoints = await mine(r);
		expect(checkpoints).toHaveLength(1);
		expect(checkpoints[0]?.trigger).toBe("plan-step");
		expect(checkpoints[0]?.plan_ref).toEqual({ phase: "61", step: "3" });
		r.clock.ms = T0 + 9_999;
		writeFiles(r.dir, { "a.txt": "beta\n" });
		await hook(r, envelope(r), "plan-step", "--plan-step", "4");
		expect(await mine(r)).toHaveLength(1);
		r.clock.ms = T0 + 10_000;
		await hook(r, envelope(r), "plan-step", "--plan-step", "4");
		checkpoints = await mine(r);
		expect(checkpoints.map((c) => c.plan_ref?.step)).toEqual(["3", "4"]);
	});

	test("an empty --plan-step (a script whose substitution printed nothing) means no plan reference", async () => {
		const r = rig();
		expect(await hook(r, envelope(r), "plan-step", "--plan-step", "")).toBe(EXIT_DONE);
		const [checkpoint] = await mine(r);
		expect(checkpoint?.trigger).toBe("plan-step");
		expect(checkpoint?.plan_ref).toBeUndefined();
	});
});

describe("baseline and steering", () => {
	test("baseline is taken once per session", async () => {
		const r = rig();
		await hook(r, envelope(r), "baseline");
		expect((await mine(r)).map((c) => c.trigger)).toEqual(["baseline"]);
		r.clock.ms = T0 + 86_400_000;
		writeFiles(r.dir, { "a.txt": "beta\n" });
		await hook(r, envelope(r), "baseline", "--verbose");
		expect(verboseLine(r)).toContain("already has a checkpoint");
		expect(await mine(r)).toHaveLength(1);
	});

	test("steering: one checkpoint per directive id, others unlimited", async () => {
		const r = rig();
		await hook(r, envelope(r, { directive_id: "dir-1" }), "steering");
		let checkpoints = await mine(r);
		expect(checkpoints).toHaveLength(1);
		expect(checkpoints[0]?.trigger).toBe("steering");
		expect(checkpoints[0]?.plan_ref).toEqual({ step: "directive:dir-1" });
		// The same directive again, with the worktree changed: still one.
		writeFiles(r.dir, { "a.txt": "beta\n" });
		await hook(r, envelope(r, { directive_id: "dir-1" }), "steering", "--verbose");
		expect(verboseLine(r)).toContain("already has a checkpoint");
		expect(await mine(r)).toHaveLength(1);
		// A different directive, immediately: taken.
		await hook(r, envelope(r, { directive_id: "dir-2" }), "steering");
		checkpoints = await mine(r);
		expect(checkpoints.map((c) => c.plan_ref?.step)).toEqual(["directive:dir-1", "directive:dir-2"]);
	});

	test("a steering envelope with no directive id still checkpoints a changed worktree", async () => {
		const r = rig();
		await hook(r, envelope(r), "steering");
		expect((await mine(r)).map((c) => c.trigger)).toEqual(["steering"]);
	});
});

describe("fail-open: every error path exits 0 with nothing on stdout", () => {
	const bad: Array<[string, string, string]> = [
		["malformed JSON", "{not json", "not valid JSON"],
		["a JSON array", "[]", "not a JSON object"],
		["a JSON scalar", "42", "not a JSON object"],
		["a mistyped session_id", JSON.stringify({ session_id: 7 }), "session_id"],
		["an over-long session_id", JSON.stringify({ session_id: "s".repeat(513) }), "session_id"],
		["a mistyped directive_id", JSON.stringify({ session_id: SESSION, directive_id: {} }), "directive_id"],
		["a relative cwd", JSON.stringify({ session_id: SESSION, cwd: "relative/dir" }), "not an absolute path"],
		["a cwd outside any git worktree", JSON.stringify({ session_id: SESSION, cwd: "/nonexistent-substrate-hook-test-dir" }), "not inside a git worktree"],
	];
	for (const [name, stdin, expected] of bad) {
		test(`${name}: exit 0, no stdout, no checkpoint, one verbose line`, async () => {
			const r = rig();
			expect(await hook(r, stdin, "turn")).toBe(EXIT_DONE);
			expect(r.out).toEqual([]);
			expect(r.err).toEqual([]);
			expect(await hook(r, stdin, "turn", "--verbose")).toBe(EXIT_DONE);
			expect(r.out).toEqual([]);
			expect(verboseLine(r)).toContain(expected);
			expect((await listLocalCheckpoints({ worktree: r.dir })).checkpoints).toEqual([]);
			expect(r.server.calls).toEqual([]);
		});
	}

	test("empty stdin and no known session: skipped, exit 0", async () => {
		const r = rig();
		expect(await hook(r, "", "turn")).toBe(EXIT_DONE);
		expect(r.out).toEqual([]);
		expect(r.err).toEqual([]);
		await hook(r, "   \n", "turn", "--verbose");
		expect(verboseLine(r)).toContain("no session id");
		expect((await listLocalCheckpoints({ worktree: r.dir })).checkpoints).toEqual([]);
	});

	test("a missing session id with several sessions in the worktree: skipped, exit 0", async () => {
		const r = rig();
		await runSession(["checkpoint", "--session", "one"], r.deps);
		await runSession(["checkpoint", "--session", "two"], r.deps);
		expect(await hook(r, JSON.stringify({ cwd: r.dir }), "turn", "--verbose")).toBe(EXIT_DONE);
		expect(verboseLine(r)).toContain("several sessions");
		expect((await listLocalCheckpoints({ worktree: r.dir })).checkpoints).toHaveLength(2);
	});

	test("a server that is down: the local checkpoint stands, the record is journaled, exit 0", async () => {
		const r = rig();
		r.server.down = true;
		expect(await hook(r, envelope(r), "turn", "--verbose")).toBe(EXIT_DONE);
		expect(r.out).toEqual([]);
		expect(verboseLine(r)).toContain("ledger pending");
		expect(await mine(r)).toHaveLength(1);
		expect(r.server.deliveries.checkpoint).toBe(0);
	});

	test("an unauthorized server: exit 0, nothing on stdout, the local checkpoint stands", async () => {
		const r = rig();
		r.server.unauthorized = true;
		expect(await hook(r, envelope(r), "turn")).toBe(EXIT_DONE);
		expect(r.out).toEqual([]);
		expect(r.err).toEqual([]);
		expect(await mine(r)).toHaveLength(1);
	});

	test("a worktree that is not a git repository: exit 0, nothing on stdout", async () => {
		const r = rig({}, false);
		expect(await hook(r, JSON.stringify({ session_id: SESSION }), "turn", "--verbose")).toBe(EXIT_DONE);
		expect(r.out).toEqual([]);
		expect(verboseLine(r)).toContain("failed open");
	});

	test("a stdin that throws: exit 0, the reason on one verbose line", async () => {
		const r = rig();
		const exit = await runSession(["hook", "turn", "--verbose"], {
			...r.deps,
			stdin: async () => {
				throw new Error("stdin is closed");
			},
		});
		expect(exit).toBe(EXIT_DONE);
		expect(r.out).toEqual([]);
		expect(verboseLine(r)).toContain("stdin is closed");
	});

	test("a stdin that never ends: the timeout returns exit 0 without blocking", async () => {
		const r = rig();
		const started = performance.now();
		const exit = await runSession(["hook", "turn", "--verbose"], { ...r.deps, stdin: () => new Promise<string>(() => {}), hookTimeoutMs: 20 });
		expect(exit).toBe(EXIT_DONE);
		expect(performance.now() - started).toBeLessThan(5_000);
		expect(r.out).toEqual([]);
		expect(verboseLine(r)).toContain("did not finish within 20 ms");
	});

	test("a server that never answers: the hook ends at its timeout, exit 0", async () => {
		const r = rig({ fetch: () => new Promise<Response>(() => {}) });
		const exit = await runSession(["hook", "turn", "--verbose"], { ...r.deps, stdin: async () => envelope(r), hookTimeoutMs: 2_000 });
		expect(exit).toBe(EXIT_DONE);
		expect(r.out).toEqual([]);
		expect(r.err.join("")).toMatch(/did not finish within 2000 ms|ledger pending/);
	});

	const refusedGrammar: Array<[string, string[]]> = [
		["no trigger", ["hook"]],
		["an unknown trigger", ["hook", "whenever"]],
		["a trigger that is not a hook trigger", ["hook", "manual"]],
		["two triggers", ["hook", "turn", "baseline"]],
		["an unknown flag", ["hook", "turn", "--bogus"]],
		["a flag of another subcommand", ["hook", "turn", "--json"]],
		["an unknown surface", ["hook", "turn", "--surface", "not-a-surface"]],
		["a value flag with no value", ["hook", "turn", "--session"]],
	];
	for (const [name, argv] of refusedGrammar) {
		test(`a misconfigured hook (${name}) exits 0, not 2, and prints nothing`, async () => {
			const r = rig({ fetch: () => Promise.reject(new Error("the network must not be used")) });
			expect(await runSession(argv, { ...r.deps, stdin: async () => envelope(r) })).toBe(EXIT_DONE);
			expect(r.out).toEqual([]);
			expect(r.err).toEqual([]);
			expect((await listLocalCheckpoints({ worktree: r.dir })).checkpoints).toEqual([]);
			expect(await runSession([...argv, "--verbose"], { ...r.deps, stdin: async () => envelope(r) })).toBe(EXIT_DONE);
			expect(r.err.join("").split("\n").filter((line) => line.length > 0)).toHaveLength(1);
		});
	}

	test("the bearer never reaches stderr", async () => {
		const r = rig();
		r.server.down = true;
		await hook(r, envelope(r), "turn", "--verbose");
		expect(r.err.join("")).not.toContain("CANARY");
	});
});

describe("runHook directly", () => {
	test("returns a typed outcome and never throws, even when every dependency throws", async () => {
		const r = rig();
		const outcome = await runHook({
			trigger: "turn",
			worktree: r.dir,
			surface: "claude-code",
			client: new FakeServer(),
			now: () => {
				throw new Error("clock exploded");
			},
			randomBytes: seededRandomBytes(1),
			readStdin: async () => envelope(r),
		});
		expect(outcome.status).toBe("failed");
	});

	test("the default budget is ten seconds", () => {
		expect(HOOK_TIMEOUT_MS).toBe(10_000);
	});
});

describe("overlapping hooks and the number of snapshots", () => {
	const hookParams = (r: Rig, trigger: "turn" | "plan-step", seed: number, run?: Runner) => ({
		trigger,
		worktree: r.dir,
		surface: "claude-code",
		client: r.server,
		now: r.deps.now,
		randomBytes: seededRandomBytes(seed),
		readStdin: async () => envelope(r),
		...(run === undefined ? {} : { run }),
	});

	test("two plan-step hooks started together inside the interval make exactly one checkpoint and skip the other", async () => {
		const r = rig();
		const outcomes = await Promise.all([runHook(hookParams(r, "plan-step", 1)), runHook(hookParams(r, "plan-step", 2))]);

		expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["checkpointed", "skipped"]);
		const skipped = outcomes.find((outcome) => outcome.status === "skipped");
		expect(skipped?.status === "skipped" && skipped.reason).toContain("rate limited");
		expect((await mine(r)).map((c) => c.seq)).toEqual([1]);
		expect(r.server.deliveries.checkpoint).toBe(1);
	});

	/** A runner that counts the snapshots taken: each one starts from `git read-tree --empty` on a temporary index. */
	function countingRunner(): { run: Runner; snapshots: () => number } {
		let count = 0;
		const run: Runner = async (argv, options) => {
			if (argv.includes("read-tree")) count += 1;
			return spawnRunner(argv, options);
		};
		return { run, snapshots: () => count };
	}

	test("the first automatic checkpoint hashes the worktree once, and an unchanged tree afterwards is skipped after one hash too", async () => {
		const r = rig();
		const { run, snapshots } = countingRunner();
		const first = await runHook(hookParams(r, "turn", 1, run));
		expect(first.status).toBe("checkpointed");
		expect(snapshots()).toBe(1);

		r.clock.ms = T0 + 3_600_000;
		const second = await runHook(hookParams(r, "turn", 2, run));
		expect(second.status === "skipped" && second.reason).toContain("unchanged");
		expect(snapshots()).toBe(2);
		expect(await mine(r)).toHaveLength(1);
	});

	test("a hook the cheap rules decline takes no snapshot at all", async () => {
		const r = rig();
		const { run, snapshots } = countingRunner();
		await runHook(hookParams(r, "turn", 1, run));
		const before = snapshots();
		r.clock.ms = T0 + 1_000;
		writeFiles(r.dir, { "a.txt": "beta\n" });
		const outcome = await runHook(hookParams(r, "turn", 2, run));
		expect(outcome.status === "skipped" && outcome.reason).toContain("rate limited");
		expect(snapshots()).toBe(before);
	});
});

describe("parseEnvelope", () => {
	test("reads the Claude Code fields and ignores the rest", () => {
		expect(parseEnvelope(JSON.stringify({ session_id: "s", cwd: "/x", transcript_path: "/t", hook_event_name: "Stop", stop_hook_active: false }))).toEqual({ session_id: "s", cwd: "/x" });
	});
	test("null fields are absent; empty text is an empty envelope", () => {
		expect(parseEnvelope(JSON.stringify({ session_id: null, directive_id: "d" }))).toEqual({ directive_id: "d" });
		expect(parseEnvelope("")).toEqual({});
	});
	test("refuses text longer than the cap", () => {
		expect(typeof parseEnvelope(" ".repeat(MAX_ENVELOPE_BYTES + 1))).toBe("string");
	});
});

const directive = (id: string, over: Partial<SteerDirective> = {}): SteerDirective => ({
	id,
	session_id: SESSION,
	action: "pause",
	body: "stop and wait",
	priority: "normal",
	status: "acknowledged",
	author: "operator-1",
	created_at: "2026-01-01T00:00:00.000Z",
	acknowledged_at: "2026-01-01T00:00:05.000Z",
	outcome: "applied",
	checkpoint_hint: { trigger: "steering", directive_id: id },
	...over,
});

const stepsOf = async (r: Rig): Promise<Array<string | undefined>> => (await mine(r)).filter((c) => c.trigger === "steering").map((c) => c.plan_ref?.step);
const consumedOf = async (r: Rig): Promise<string[]> => readConsumed(consumedPath(await resolvePendingDir(r.dir), SESSION));

describe("the checkpoint_hint reader of the steering trigger", () => {
	test("an acknowledged directive with a hint gets exactly the checkpoint it names, with no envelope directive id", async () => {
		const r = rig();
		r.steer.directives = [directive("dir-1")];
		expect(await hook(r, envelope(r), "steering")).toBe(EXIT_DONE);
		expect(r.out).toEqual([]);
		expect(await stepsOf(r)).toEqual(["directive:dir-1"]);
		expect(r.steer.calls).toHaveLength(1);
		expect(r.steer.calls[0]?.path).toBe("/steering/directives");
		expect(r.steer.calls[0]?.search).toBe(`?session_id=${SESSION}&status=acknowledged`);
		expect(r.steer.calls[0]?.authorization).toBe("Bearer tok-CANARY-0123456789abcdef-secret");
		expect(await consumedOf(r)).toEqual(["dir-1"]);
	});

	test("a second run, with the same hint still listed and the worktree changed, writes no second checkpoint for it", async () => {
		const r = rig();
		r.steer.directives = [directive("dir-1")];
		await hook(r, envelope(r), "steering");
		writeFiles(r.dir, { "a.txt": "beta\n" });
		await hook(r, envelope(r), "steering");
		expect((await stepsOf(r)).filter((step) => step === "directive:dir-1")).toHaveLength(1);
		expect(await consumedOf(r)).toEqual(["dir-1"]);
	});

	test("each new hint gets its own checkpoint on a later run", async () => {
		const r = rig();
		r.steer.directives = [directive("dir-1")];
		await hook(r, envelope(r), "steering");
		writeFiles(r.dir, { "a.txt": "beta\n" });
		r.steer.directives = [directive("dir-1"), directive("dir-2")];
		await hook(r, envelope(r), "steering");
		expect(await stepsOf(r)).toEqual(["directive:dir-1", "directive:dir-2"]);
		expect(await consumedOf(r)).toEqual(["dir-1", "dir-2"]);
	});

	test("a hint whose directive the envelope also names is one checkpoint", async () => {
		const r = rig();
		r.steer.directives = [directive("dir-1")];
		await hook(r, envelope(r, { directive_id: "dir-1" }), "steering");
		expect(await stepsOf(r)).toEqual(["directive:dir-1"]);
	});

	test("a hint with an unchanged worktree takes no checkpoint and is still consumed: when the tree changes later, it does not get one", async () => {
		const r = rig();
		expect(await runSession(["checkpoint", "--session", SESSION, "--json"], r.deps)).toBe(EXIT_DONE);
		r.steer.directives = [directive("dir-1")];
		await hook(r, envelope(r), "steering", "--verbose");
		expect(verboseLine(r)).toContain("unchanged");
		expect(await stepsOf(r)).toEqual([]);
		expect(await consumedOf(r)).toEqual(["dir-1"]);
		// Without the hook's own state the policy would now admit a `directive:dir-1` checkpoint of the changed tree; only the plain one is taken.
		writeFiles(r.dir, { "a.txt": "beta\n" });
		await hook(r, envelope(r), "steering");
		expect(await stepsOf(r)).toEqual([undefined]);
	});

	test("directives without a steering hint, for another session, or declined are ignored; a plain steering checkpoint is still taken", async () => {
		const r = rig();
		r.steer.directives = [
			directive("dir-1", { checkpoint_hint: null }),
			directive("dir-2", { session_id: "someone-else" }),
			directive("dir-3", { checkpoint_hint: { trigger: "turn", directive_id: "dir-3" } }),
		];
		await hook(r, envelope(r), "steering");
		expect(await stepsOf(r)).toEqual([undefined]);
		expect(await consumedOf(r)).toEqual([]);
	});

	test("a server that is down: the normal steering checkpoint is taken, nothing is consumed, exit 0, nothing on stdout", async () => {
		const r = rig();
		r.steer.mode = "down";
		r.steer.directives = [directive("dir-1")];
		expect(await hook(r, envelope(r, { directive_id: "dir-7" }), "steering")).toBe(EXIT_DONE);
		expect(r.out).toEqual([]);
		expect(r.err).toEqual([]);
		expect(await stepsOf(r)).toEqual(["directive:dir-7"]);
		expect(await consumedOf(r)).toEqual([]);
	});

	test("an answer that is not JSON is the same as a server that is down", async () => {
		const r = rig();
		r.steer.mode = "garbage";
		expect(await hook(r, envelope(r), "steering")).toBe(EXIT_DONE);
		expect(await stepsOf(r)).toEqual([undefined]);
		expect(await consumedOf(r)).toEqual([]);
	});

	test("an answer with the wrong shape is the same as a server that is down", async () => {
		const r = rig();
		r.steer.directives = [{ id: "dir-1", session_id: SESSION }];
		expect(await hook(r, envelope(r), "steering")).toBe(EXIT_DONE);
		expect(await stepsOf(r)).toEqual([undefined]);
		expect(await consumedOf(r)).toEqual([]);
	});

	test("a session id the server's registry would not accept never reaches the routes", async () => {
		const r = rig();
		await hook(r, JSON.stringify({ session_id: "has spaces", cwd: r.dir }), "steering");
		expect(r.steer.calls).toEqual([]);
		expect((await listLocalCheckpoints({ worktree: r.dir })).checkpoints.map((c) => c.trigger)).toEqual(["steering"]);
	});

	test("the other triggers never read the routes", async () => {
		const r = rig();
		await hook(r, envelope(r), "turn");
		expect(r.steer.calls).toEqual([]);
	});
});

describe("unconsumedHints", () => {
	test("keeps the order of the list, drops consumed, repeated, foreign and non-steering hints, and stops at five", () => {
		const many = Array.from({ length: 8 }, (_, index) => directive(`d${index}`));
		const picked = unconsumedHints([directive("a", { checkpoint_hint: null }), directive("c"), directive("c"), directive("d", { session_id: "x" }), ...many], SESSION, new Set(["d0"]));
		expect(picked).toEqual(["c", "d1", "d2", "d3", "d4"]);
	});
});

describe("the context trigger", () => {
	const digest = (over: Record<string, unknown> = {}) => ({
		generated_at: "2026-01-01T00:00:00.000Z",
		repo_id: "acme/widgets",
		for_session: SESSION,
		sessions: [{ source: "presence", age_s: 12, session_id: "other-1", surface: "omp", branch: "feat/x", worktree: "/w/x" }],
		claims: [{ source: "graph", age_s: 90, node_id: "n1", holder: "omp" }],
		events: [],
		handoffs: [],
		planning: [],
		truncated: { events: false },
		notes: [],
		...over,
	});
	const withOrigin = (r: Rig): Rig => {
		git(r.dir, ["remote", "add", "origin", "git@github.com:acme/widgets.git"]);
		return r;
	};

	test("prints the digest as text with each item's source and age, and asks the routes for the worktree's repository and the session", async () => {
		const r = withOrigin(rig());
		r.steer.context = digest();
		expect(await hook(r, envelope(r), "context")).toBe(EXIT_DONE);
		const printed = r.out.join("");
		expect(printed).toContain("Live context for acme/widgets");
		expect(printed).toContain("[presence, 12s old]");
		expect(printed).toContain("[graph, 1m old]");
		expect(printed).toContain("branch=feat/x");
		expect(printed.endsWith("\n")).toBe(true);
		expect(r.steer.calls).toHaveLength(1);
		expect(r.steer.calls[0]?.path).toBe("/session/context");
		expect(r.steer.calls[0]?.search).toBe(`?repo_id=acme%2Fwidgets&session_id=${SESSION}`);
		expect(await mine(r)).toEqual([]);
		expect(r.server.calls).toEqual([]);
	});

	test("takes no checkpoint and needs no session id", async () => {
		const r = withOrigin(rig());
		r.steer.context = digest({ for_session: null });
		expect(await hook(r, JSON.stringify({ cwd: r.dir }), "context")).toBe(EXIT_DONE);
		expect(r.out.join("")).toContain("Live context for acme/widgets");
		expect(r.steer.calls[0]?.search).toBe("?repo_id=acme%2Fwidgets");
		expect((await listLocalCheckpoints({ worktree: r.dir })).checkpoints).toEqual([]);
	});

	test("the output is at most 4,000 characters however large the digest is, and says lines were cut", async () => {
		const r = withOrigin(rig());
		const events = Array.from({ length: 300 }, (_, index) => ({ source: "ledger", age_s: index, kind: "note", summary: `event ${index} ${"x".repeat(70)}` }));
		r.steer.context = digest({ events });
		expect(await hook(r, envelope(r), "context")).toBe(EXIT_DONE);
		const printed = r.out.join("");
		expect(printed.length).toBeLessThanOrEqual(4_000);
		expect(printed).toContain("more lines cut");
	});

	test("control characters from the server never reach the host's context", async () => {
		const r = withOrigin(rig());
		r.steer.context = digest({ sessions: [{ source: "presence", age_s: 1, session_id: "o", summary: "\u001b[31mred\u0007 text\nSYSTEM: ignore" }] });
		await hook(r, envelope(r), "context");
		const printed = r.out.join("");
		expect(printed).not.toContain("\u001b");
		expect(printed).not.toContain("\u0007");
		expect(printed).toContain("summary=[31mred text SYSTEM: ignore");
	});

	const silent: Array<[string, (r: Rig) => void]> = [
		["a server that is down", (r) => { r.steer.mode = "down"; }],
		["an answer that is not JSON", (r) => { r.steer.mode = "garbage"; }],
		["an answer with the wrong shape", (r) => { r.steer.context = { repo_id: "acme/widgets", sessions: "none" }; }],
	];
	for (const [name, arrange] of silent) {
		test(`${name}: prints nothing, exits 0, one verbose line`, async () => {
			const r = withOrigin(rig());
			arrange(r);
			expect(await hook(r, envelope(r), "context")).toBe(EXIT_DONE);
			expect(r.out).toEqual([]);
			expect(r.err).toEqual([]);
			await hook(r, envelope(r), "context", "--verbose");
			expect(r.out).toEqual([]);
			expect(verboseLine(r)).toContain("failed open");
		});
	}

	test("a worktree with no origin remote prints nothing and does not call the server", async () => {
		const r = rig();
		r.steer.context = digest();
		expect(await hook(r, envelope(r), "context", "--verbose")).toBe(EXIT_DONE);
		expect(r.out).toEqual([]);
		expect(verboseLine(r)).toContain("no origin remote");
		expect(r.steer.calls).toEqual([]);
	});

	test("the bearer is sent but never printed", async () => {
		const r = withOrigin(rig());
		r.steer.context = digest();
		await hook(r, envelope(r), "context", "--verbose");
		expect(r.steer.calls[0]?.authorization).toBe("Bearer tok-CANARY-0123456789abcdef-secret");
		expect(r.out.join("") + r.err.join("")).not.toContain("CANARY");
	});
});
