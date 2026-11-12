/**
 * `substrate session hook <trigger>`: a checkpoint at each automatic boundary through `runSession`, with the
 * in-memory server on the wire format, and the fail-open contract: every error path exits 0 with nothing on
 * stdout. The clock is injected; nothing sleeps.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Runner, spawnRunner } from "../../../worktree-snapshot/src/index.ts";
import { cleanupTemp, git, makeRepo, tempDir, writeFiles } from "../../../worktree-snapshot/src/testkit.ts";
import { type LocalCheckpoint, listLocalCheckpoints } from "./checkpoint.ts";
import { EXIT_DONE, type SessionDeps, runSession } from "./command.ts";
import { HOOK_TIMEOUT_MS, MAX_ENVELOPE_BYTES, parseEnvelope, runHook, unconsumedHints } from "./hook.ts";
import { resolvePendingDir } from "./pending.ts";
import { consumedPath, readConsumed, writeConsumed } from "./steering-consumed.ts";
import { FakeServer, FakeTranscript, fetchFor, seededRandomBytes } from "./testkit.ts";
import type { SteerDirective, SteerFetch } from "../steer/client.ts";
import { saveBindingRecord, serverIdentity } from "../steer/binding-record.ts";

afterAll(cleanupTemp);
setDefaultTimeout(300_000);

const SESSION = "sess-1";
const LIVE = `ls_${"a".repeat(64)}`;
const SIBLING = `ls_${"b".repeat(64)}`;
const PROOF = "c".repeat(64);
const T0 = Date.parse("2026-01-01T00:00:00.000Z");

interface Rig {
	dir: string;
	server: FakeServer;
	bindingFile: string;
	steer: SteerStub;
	out: string[];
	err: string[];
	clock: { ms: number };
	deps: SessionDeps;
}

/** What the REST routes the steering and context triggers read answer with. `down` throws like a refused connection; `garbage` answers 200 with HTML. */
interface SteerStub {
	mode: "up" | "down" | "garbage" | "denied";
	directives: unknown[];
	context: unknown;
	calls: Array<{ path: string; search: string; authorization: string | undefined; sessionBinding: string | undefined }>;
}

function steerFetchFor(stub: SteerStub): SteerFetch {
	return async (input, init) => {
		const url = new URL(input);
		stub.calls.push({ path: url.pathname, search: url.search, authorization: init.headers.authorization, sessionBinding: init.headers["X-Substrate-Session-Binding"] });
		if (stub.mode === "down") throw new TypeError("fetch failed");
		if (stub.mode === "garbage") return new Response("<html>not json</html>", { status: 200 });
		if (stub.mode === "denied") return Response.json({ status: "refused", error: { code: "not-found" } }, { status: 404 });
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
	const bindingFile = saveBindingRecord({
		version: 1, server_identity: serverIdentity(deps.url), surface: "claude-code",
		session_id: LIVE, session_binding: PROOF, expires_at: "2026-01-01T01:00:00.000Z",
	}, { directory: tempDir() });
	return { dir, server, steer, bindingFile, out, err, clock, deps };
}

const envelope = (r: Rig, extra: Record<string, unknown> = {}): string =>
	JSON.stringify({ session_id: SESSION, steering_session_id: LIVE, binding_file: r.bindingFile, cwd: r.dir, transcript_path: "/home/someone/.claude/projects/x/t.jsonl", ...extra });

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
			url: r.deps.url,
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
		url: r.deps.url,
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
	test("reads separate live identity and record path; proof values are never accepted as envelope fields", () => {
		expect(parseEnvelope(JSON.stringify({ session_id: "history", steering_session_id: LIVE, binding_file: "/private/live.json" })))
			.toEqual({ session_id: "history", steering_session_id: LIVE, binding_file: "/private/live.json" });
		for (const field of ["steering_session_id", "binding_file"]) {
			expect(typeof parseEnvelope(JSON.stringify({ [field]: 7 }))).toBe("string");
			expect(typeof parseEnvelope(JSON.stringify({ [field]: "" }))).toBe("string");
		}
		for (const field of ["session_binding", "sessionBinding"]) {
			const result = parseEnvelope(JSON.stringify({ [field]: PROOF }));
			expect(typeof result).toBe("string");
			expect(result).not.toContain(PROOF);
		}
	});

	test("reads the Claude Code fields and ignores the rest", () => {
		expect(parseEnvelope(JSON.stringify({ session_id: "s", cwd: "/x", transcript_path: "/t", hook_event_name: "Stop", stop_hook_active: false }))).toEqual({ session_id: "s", cwd: "/x", transcript_path: "/t" });
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
	session_id: LIVE,
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
const consumedOf = async (r: Rig, live = LIVE): Promise<string[]> => readConsumed(consumedPath(await resolvePendingDir(r.dir), SESSION, live));

describe("the checkpoint_hint reader of the steering trigger", () => {
	test("a well-shaped wrong proof is sent only as a header and a target refusal grants no hints", async () => {
		const r = rig();
		const wrongProof = "e".repeat(64);
		const record = JSON.parse(readFileSync(r.bindingFile, "utf8")) as Record<string, unknown>;
		record.session_binding = wrongProof;
		writeFileSync(r.bindingFile, JSON.stringify(record));
		const requests: Array<{ url: string; proof: string | undefined; body: string | undefined }> = [];
		r.deps.steerFetch = async (url, init) => {
			requests.push({ url, proof: init.headers["X-Substrate-Session-Binding"], body: init.body });
			return init.headers["X-Substrate-Session-Binding"] === PROOF
				? Response.json({ directives: [directive("must-not-consume")] })
				: Response.json({ status: "refused", error: { code: "not-found" } }, { status: 404 });
		};
		await hook(r, envelope(r), "steering", "--verbose");
		expect(requests).toHaveLength(1);
		expect(requests[0]?.proof).toBe(wrongProof);
		expect(requests[0]?.url).not.toContain(wrongProof);
		expect(requests[0]?.body).toBeUndefined();
		expect(await stepsOf(r)).toEqual([undefined]);
		expect(await consumedOf(r)).toEqual([]);
		expect(verboseLine(r)).toContain("private steering hints skipped");
		expect(r.out.join("") + r.err.join("")).not.toContain(wrongProof);
	});

	test("proof remains outside checkpoint records and the replay journal when the checkpoint server is down", async () => {
		const r = rig();
		r.server.down = true;
		r.steer.directives = [directive("pending-hint")];
		await hook(r, envelope(r), "steering", "--verbose");
		expect(await stepsOf(r)).toEqual(["directive:pending-hint"]);
		const pendingDir = await resolvePendingDir(r.dir);
		const pending = readdirSync(pendingDir).filter((name) => name.endsWith(".json"));
		expect(pending.length).toBeGreaterThan(0);
		for (const name of pending) {
			const body = readFileSync(join(pendingDir, name), "utf8");
			expect(body).not.toContain(PROOF);
			expect(body).not.toContain("session_binding");
			expect(body).not.toContain(r.bindingFile);
		}
		expect(r.err.join("")).not.toContain(PROOF);
	});

	test("a historical label alone, even one shaped like a live handle, never requests private hints", async () => {
		const r = rig();
		r.steer.directives = [directive("must-not-read")];
		await hook(r, JSON.stringify({ session_id: LIVE, binding_file: r.bindingFile, cwd: r.dir }), "steering");
		expect(r.steer.calls).toEqual([]);
		const checkpoints = (await listLocalCheckpoints({ worktree: r.dir })).checkpoints;
		expect(checkpoints.map((checkpoint) => ({ session: checkpoint.session_id, step: checkpoint.plan_ref?.step }))).toEqual([{ session: LIVE, step: undefined }]);
	});

	test("live and file flags override the envelope without changing the historical --session override", async () => {
		const r = rig();
		r.steer.directives = [directive("flag-selected"), directive("foreign", { session_id: SIBLING })];
		await hook(r, envelope(r, { steering_session_id: SIBLING, binding_file: "/missing-envelope-record" }), "steering",
			"--session", "historical-flag", "--steering-session", LIVE, "--binding-file", r.bindingFile);
		expect(r.steer.calls.map((call) => [call.search, call.sessionBinding])).toEqual([[`?session_id=${LIVE}&status=acknowledged`, PROOF]]);
		expect((await listLocalCheckpoints({ worktree: r.dir })).checkpoints.map((checkpoint) => [checkpoint.session_id, checkpoint.plan_ref?.step]))
			.toEqual([["historical-flag", "directive:flag-selected"]]);
		expect(r.out.join("") + r.err.join("")).not.toContain(PROOF);
	});

	const badRecords: Array<[string, (r: Rig) => string]> = [
		["missing", () => join(tempDir(), "absent.json")],
		["corrupt", (r) => { writeFileSync(r.bindingFile, `{broken ${PROOF}`); return r.bindingFile; }],
		...(["server_identity", "surface", "session_id"] as const).map((field): [string, (r: Rig) => string] => [
			`mismatched ${field}`,
			(r) => {
				const record = JSON.parse(readFileSync(r.bindingFile, "utf8")) as Record<string, unknown>;
				record[field] = field === "server_identity" ? serverIdentity("http://127.0.0.1:9999") : field === "surface" ? "omp" : SIBLING;
				writeFileSync(r.bindingFile, JSON.stringify(record));
				return r.bindingFile;
			},
		]),
	];
	for (const [name, arrange] of badRecords) {
		test(`${name} record skips hints locally, leaves consumption untouched and still checkpoints with a sanitized note`, async () => {
			const r = rig();
			r.steer.directives = [directive("must-not-read")];
			const statePath = consumedPath(await resolvePendingDir(r.dir), SESSION, LIVE);
			writeConsumed(statePath, SESSION, LIVE, ["remembered"]);
			const bindingFile = arrange(r);
			expect(await hook(r, envelope(r, { binding_file: bindingFile, directive_id: "ordinary" }), "steering", "--verbose")).toBe(EXIT_DONE);
			expect(r.steer.calls).toEqual([]);
			expect(await stepsOf(r)).toEqual(["directive:ordinary"]);
			expect(readConsumed(statePath)).toEqual(["remembered"]);
			expect(verboseLine(r)).toContain("created checkpoint");
			expect(verboseLine(r)).toContain("private steering hints skipped (matching private binding record missing or invalid)");
			expect(r.out).toEqual([]);
			expect(r.err.join("")).not.toContain(PROOF);
			expect(r.err.join("")).not.toContain(bindingFile);
		});
	}

	test("the selected surface and configured server URL scope the record and header", async () => {
		const r = rig({ url: "http://127.0.0.1:7543/" });
		const file = saveBindingRecord({
			version: 1, server_identity: serverIdentity(r.deps.url), surface: "omp",
			session_id: LIVE, session_binding: PROOF, expires_at: "2026-01-01T01:00:00.000Z",
		}, { directory: tempDir() });
		r.steer.directives = [directive("scoped")];
		await hook(r, envelope(r), "steering", "--surface", "omp", "--binding-file", file);
		expect(await stepsOf(r)).toEqual(["directive:scoped"]);
		expect(r.steer.calls[0]?.sessionBinding).toBe(PROOF);
	});

	test("a sibling live incarnation cannot prune or consume another incarnation's decisions", async () => {
		const r = rig();
		const firstPath = consumedPath(await resolvePendingDir(r.dir), SESSION, LIVE);
		writeConsumed(firstPath, SESSION, LIVE, ["remembered-a"]);
		const siblingProof = "d".repeat(64);
		const file = saveBindingRecord({
			version: 1, server_identity: serverIdentity(r.deps.url), surface: "claude-code",
			session_id: SIBLING, session_binding: siblingProof, expires_at: "2026-01-01T01:00:00.000Z",
		}, { directory: tempDir() });
		r.steer.directives = [directive("sibling-hint", { session_id: SIBLING }), directive("foreign-a")];
		await hook(r, envelope(r, { steering_session_id: SIBLING, binding_file: file }), "steering");
		expect(readConsumed(firstPath)).toEqual(["remembered-a"]);
		expect(await consumedOf(r, SIBLING)).toEqual(["sibling-hint"]);
		expect(await stepsOf(r)).toEqual(["directive:sibling-hint"]);
		expect(r.steer.calls[0]?.sessionBinding).toBe(siblingProof);
		const state = readFileSync(consumedPath(await resolvePendingDir(r.dir), SESSION, SIBLING), "utf8");
		expect(state).not.toContain(siblingProof);
		expect(state).not.toContain("session_binding");
		expect(JSON.stringify([...r.server.checkpoints.values()])).not.toContain(siblingProof);
	});

	test("a typed authorization refusal preserves existing decisions and takes only the ordinary checkpoint", async () => {
		const r = rig();
		const path = consumedPath(await resolvePendingDir(r.dir), SESSION, LIVE);
		writeConsumed(path, SESSION, LIVE, ["kept"]);
		r.steer.mode = "denied";
		await hook(r, envelope(r), "steering", "--verbose");
		expect(await stepsOf(r)).toEqual([undefined]);
		expect(readConsumed(path)).toEqual(["kept"]);
		expect(r.steer.calls).toHaveLength(1);
		expect(verboseLine(r)).toContain("private steering hints skipped (private hint lookup refused or unavailable)");
	});

	test("private client exceptions cannot echo a binding proof into the verbose checkpoint outcome", async () => {
		const r = rig({ steerFetch: async () => { throw new Error(`private request failed ${PROOF}`); } });
		await hook(r, envelope(r), "steering", "--verbose");
		expect(await stepsOf(r)).toEqual([undefined]);
		expect(verboseLine(r)).toContain("private steering hints skipped");
		expect(r.err.join("")).not.toContain(PROOF);
	});

	test("only five matching hints are acted on in one run; foreign live hints are not consumed", async () => {
		const r = rig();
		r.steer.directives = [directive("foreign", { session_id: SIBLING }), ...Array.from({ length: 7 }, (_, index) => directive(`bounded-${index}`))];
		await hook(r, envelope(r), "steering");
		expect(await consumedOf(r)).toEqual(["bounded-0", "bounded-1", "bounded-2", "bounded-3", "bounded-4"]);
		expect(await stepsOf(r)).toEqual(["directive:bounded-0"]);
	});

	test("an acknowledged directive with a hint gets exactly the checkpoint it names, with no envelope directive id", async () => {
		const r = rig();
		r.steer.directives = [directive("dir-1")];
		expect(await hook(r, envelope(r), "steering")).toBe(EXIT_DONE);
		expect(r.out).toEqual([]);
		expect(await stepsOf(r)).toEqual(["directive:dir-1"]);
		expect(r.steer.calls).toHaveLength(1);
		expect(r.steer.calls[0]?.path).toBe("/steering/directives");
		expect(r.steer.calls[0]?.search).toBe(`?session_id=${LIVE}&status=acknowledged`);
		expect(r.steer.calls[0]?.sessionBinding).toBe(PROOF);
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

	test("a skipped hint stays consumed after more than 200 later decisions, while the server still lists it", async () => {
		const r = rig();
		const earlier = Array.from({ length: 250 }, (_, index) => (index === 0 ? "old-skipped" : `filler-${index}`));
		writeConsumed(consumedPath(await resolvePendingDir(r.dir), SESSION, LIVE), SESSION, LIVE, earlier);
		r.steer.directives = [...earlier.map((id) => directive(id)), directive("dir-new")];
		await hook(r, envelope(r), "steering");
		expect(await stepsOf(r)).toEqual(["directive:dir-new"]);
		const kept = await consumedOf(r);
		expect(kept).toHaveLength(251);
		expect(kept[0]).toBe("old-skipped");
		// The skipped hint has no checkpoint key to stop it, so only the remembered decision does: later edits get the plain checkpoint.
		writeFiles(r.dir, { "a.txt": "beta\n" });
		await hook(r, envelope(r), "steering");
		expect(await stepsOf(r)).toEqual(["directive:dir-new", undefined]);
	});

	test("the decision of a directive the server no longer lists is forgotten, and an unreadable listing forgets nothing", async () => {
		const r = rig();
		writeConsumed(consumedPath(await resolvePendingDir(r.dir), SESSION, LIVE), SESSION, LIVE, ["kept", "gone"]);
		r.steer.mode = "down";
		await hook(r, envelope(r), "steering");
		expect(await consumedOf(r)).toEqual(["kept", "gone"]);
		r.steer.mode = "up";
		r.steer.directives = [directive("kept", { checkpoint_hint: null })];
		writeFiles(r.dir, { "a.txt": "gamma\n" });
		await hook(r, envelope(r), "steering");
		expect(await consumedOf(r)).toEqual(["kept"]);
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

	test("an invalid live handle never reaches private routes and does not invalidate the historical checkpoint label", async () => {
		const r = rig();
		await hook(r, envelope(r, { session_id: "has spaces", steering_session_id: "not-live" }), "steering", "--verbose");
		expect(verboseLine(r)).toContain("private steering hints skipped (invalid live session handle)");
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
		const picked = unconsumedHints([directive("a", { checkpoint_hint: null }), directive("c"), directive("c"), directive("d", { session_id: "x" }), ...many], LIVE, new Set(["d0"]));
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
		expect(r.steer.calls[0]?.sessionBinding).toBeUndefined();
		expect(r.steer.calls[0]?.search).not.toContain(LIVE);
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
