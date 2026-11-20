/**
 * `substrate session ...`: the grammar, the exit codes and the output, through `runSession` with a fake
 * server on the wire format, plus one real process to prove `index.ts` dispatches it.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchLike } from "./client.ts";
import { SimulatedCrash } from "../../../worktree-snapshot/src/index.ts";
import { mutateToB, SCENARIO_POLICY, writeScenarioA } from "../../../worktree-snapshot/src/scenario.ts";
import { cleanupTemp, FIXED_NOW, makeRepo, tempDir, writeFiles } from "../../../worktree-snapshot/src/testkit.ts";
import { listLocalCheckpoints } from "./checkpoint.ts";
import {
	EXIT_DONE,
	EXIT_FAILED,
	EXIT_LEDGER_PENDING,
	EXIT_REFUSED,
	EXIT_USAGE,
	type SessionDeps,
	SESSION_USAGE,
	parseSessionArgs,
	runSession,
} from "./command.ts";
import { OMP_SESSION_MAX_BYTES } from "./omp-fork.ts";
import { type FetchLog, FakeServer, FakeTranscript, fetchFor, seededRandomBytes } from "./testkit.ts";

afterAll(cleanupTemp);
setDefaultTimeout(300_000);

const TOKEN = "tok-CANARY-0123456789abcdef-secret";
const SESSION = "sess-1";

interface Rig {
	dir: string;
	server: FakeServer;
	transcript: FakeTranscript;
	log: FetchLog;
	out: string[];
	err: string[];
	deps: SessionDeps;
}

function rig(overrides: Partial<SessionDeps> = {}, scenario = true): Rig {
	const dir = makeRepo();
	if (scenario) writeScenarioA(dir);
	else writeFiles(dir, { "a.txt": "alpha\n" });
	const server = new FakeServer();
	const transcript = new FakeTranscript();
	const log: FetchLog = { authorization: [], tools: [] };
	const out: string[] = [];
	const err: string[] = [];
	const deps: SessionDeps = {
		worktree: dir,
		url: "http://127.0.0.1:7410",
		tokenFor: () => TOKEN,
		timeoutMs: 1500,
		now: FIXED_NOW,
		randomBytes: seededRandomBytes(5),
		transcript,
		out: (text) => out.push(text),
		err: (text) => err.push(text),
		fetch: fetchFor(server, log),
		policy: SCENARIO_POLICY,
		home: "/home/someone",
		...overrides,
	};
	return { dir, server, transcript, log, out, err, deps };
}

const text = (lines: string[]): string => lines.join("");

async function session(r: Rig, ...argv: string[]): Promise<number> {
	return runSession(argv, r.deps);
}

function json(r: Rig): Record<string, unknown> {
	return JSON.parse(text(r.out).trim().split("\n").pop() ?? "{}") as Record<string, unknown>;
}

const neverCalled: FetchLike = async () => {
	throw new Error("the network must not be used");
};

describe("the grammar is refused before any work", () => {
	const refused: Array<[string, string[]]> = [
		["no subcommand", []],
		["an unknown subcommand", ["frobnicate"]],
		["an unknown flag", ["checkpoint", "--bogus"]],
		["a flag of another subcommand", ["recover", "--force"]],
		["--session on sync", ["sync", "--session", "x"]],
		["--steering-session on historical checkpoint", ["checkpoint", "--steering-session", "live"]],
		["--binding-file on historical checkpoint listing", ["checkpoints", "--binding-file", "/private/live.json"]],
		["a value flag with no value", ["checkpoint", "--trigger"]],
		["a value flag followed by a flag", ["checkpoint", "--trigger", "--json"]],
		["a repeated flag", ["checkpoint", "--json", "--json"]],
		["rollback with no target", ["rollback", "--session", "s"]],
		["rollback with two targets", ["rollback", "previous", "1", "--session", "s"]],
		["a rollback target that is none of ckpt, seq, previous", ["rollback", "latest", "--session", "s"]],
		["a path as a rollback target", ["rollback", "../../etc/passwd", "--session", "s"]],
		["a positional on checkpoint", ["checkpoint", "extra"]],
		["an unknown trigger", ["checkpoint", "--session", "s", "--trigger", "whenever"]],
		["an unknown surface", ["checkpoint", "--session", "s", "--surface", "not-a-surface"]],
		["a transcript ref that is not JSON", ["checkpoint", "--session", "s", "--transcript-ref", "{oops"]],
		["a transcript ref that is a path", ["checkpoint", "--session", "s", "--transcript-ref", '{"surface":"claude-code","session_locator":"/home/x/a.jsonl","turn_no":1}']],
		["a transcript ref with no entry or turn", ["checkpoint", "--session", "s", "--transcript-ref", '{"surface":"claude-code","session_locator":"abc"}']],
		["--omp-session with no value", ["checkpoint", "--session", "s", "--omp-session"]],
		["--omp-session given twice", ["checkpoint", "--session", "s", "--omp-session", "a.jsonl", "--omp-session", "b.jsonl"]],
		["--omp-session together with --transcript-ref", ["checkpoint", "--session", "s", "--omp-session", "a.jsonl", "--transcript-ref", '{"surface":"claude-code","session_locator":"abc","turn_no":7}']],
		["--omp-session on another subcommand", ["checkpoints", "--omp-session", "a.jsonl"]],
		["an empty --omp-session", ["checkpoint", "--session", "s", "--omp-session", ""]],
		["hook-config with no target", ["hook-config"]],
		["hook-config with an unknown target", ["hook-config", "vim"]],
		["hook-config with two targets", ["hook-config", "claude-code", "git-post-commit"]],
		["a flag on hook-config", ["hook-config", "claude-code", "--json"]],
	];
	for (const [name, argv] of refused) {
		test(`${name}: usage on stderr, exit 2, no server call, no checkpoint`, async () => {
			const r = rig({ fetch: neverCalled });
			const exit = await session(r, ...argv);
			expect(exit).toBe(EXIT_USAGE);
			expect(text(r.err)).toContain("usage: substrate session checkpoint");
			expect(text(r.out)).toBe("");
			expect((await listLocalCheckpoints({ worktree: r.dir })).checkpoints).toEqual([]);
		});
	}

	test("flag order is free: --dry-run before or after the target means the same", () => {
		const a = parseSessionArgs(["rollback", "--dry-run", "ckpt_" + "a".repeat(26), "--json"]);
		const b = parseSessionArgs(["rollback", "ckpt_" + "a".repeat(26), "--json", "--dry-run"]);
		for (const parsed of [a, b]) {
			expect(typeof parsed).toBe("object");
			if (typeof parsed === "string") continue;
			expect(parsed.positional).toEqual(["ckpt_" + "a".repeat(26)]);
			expect([...parsed.flags.keys()].sort()).toEqual(["dry-run", "json"]);
		}
	});

	test("hook parsing separates historical and live identities, requires values and rejects proof flags", () => {
		const live = `ls_${"a".repeat(64)}`;
		const parsed = parseSessionArgs(["hook", "steering", "--session", "history", "--steering-session", live, "--binding-file", "/private/live.json"]);
		expect(typeof parsed).toBe("object");
		if (typeof parsed === "string") throw new Error("hook arguments unexpectedly refused");
		expect(parsed.flags.get("session")).toBe("history");
		expect(parsed.flags.get("steering-session")).toBe(live);
		expect(parsed.flags.get("binding-file")).toBe("/private/live.json");
		for (const argv of [
			["hook", "steering", "--steering-session"],
			["hook", "steering", "--binding-file"],
			["hook", "steering", "--steering-session", "--verbose"],
			["hook", "steering", "--binding-file", "--verbose"],
			["hook", "steering", "--steering-session", live, "--steering-session", live],
			["hook", "steering", "--binding-file", "a", "--binding-file", "b"],
			["hook", "steering", "--session-binding", "c".repeat(64)],
		]) expect(typeof parseSessionArgs(argv)).toBe("string");
		expect(SESSION_USAGE).toContain("--session HISTORICAL_ID");
		expect(SESSION_USAGE).toContain("--steering-session LIVE_ID");
		expect(SESSION_USAGE).toContain("--binding-file PATH");
	});

	test("rejected proof flags never echo their token or value, including joined syntax and verbose hooks", async () => {
		const proof = "e".repeat(64);
		for (const flags of [["--session-binding", proof], [`--session-binding=${proof}`], [`--${proof}`]]) {
			for (const prefix of [["checkpoint"], ["hook", "steering", "--verbose"]]) {
				const argv = [...prefix, ...flags];
				const reason = parseSessionArgs(argv);
				expect(typeof reason).toBe("string");
				expect(reason).not.toContain(proof);
				const r = rig({ fetch: neverCalled, steerFetch: async () => { throw new Error("the network must not be used"); } });
				expect(await runSession(argv, r.deps)).toBe(prefix[0] === "hook" ? EXIT_DONE : EXIT_USAGE);
				expect(text(r.out)).toBe("");
				expect(text(r.err)).toContain("unknown flag");
				expect(text(r.err)).not.toContain(proof);
				expect(r.server.calls).toEqual([]);
			}
		}
	});

	test("the usage text names every subcommand and the exit codes", () => {
		for (const word of ["checkpoint", "checkpoints", "rollback", "recover", "sync", "hook", "hook-config", "hook-install", "exit: 0 done, 1 failed, 2 usage, 3 refused", "4 files restored"]) {
			expect(SESSION_USAGE).toContain(word);
		}
	});
});

describe("session checkpoint", () => {
	test("creates a checkpoint, records it, and prints it as text or JSON", async () => {
		const r = rig();
		expect(await session(r, "checkpoint", "--session", SESSION, "--trigger", "turn")).toBe(EXIT_DONE);
		expect(text(r.out)).toContain(`for session ${SESSION}`);
		expect(text(r.out)).toContain("ledger: recorded");

		const j = rig();
		expect(await session(j, "checkpoint", "--session", SESSION, "--json")).toBe(EXIT_DONE);
		const body = json(j);
		expect(body).toMatchObject({ ok: true, command: "checkpoint", session_id: SESSION, created: true, ledger: { status: "recorded", stored: true } });
		expect(body.checkpoint).toMatchObject({ seq: 1, trigger: "manual", session_id: SESSION });
		expect(j.server.checkpoints.size).toBe(1);
		// The bearer for the surface went out with the call.
		expect(j.log.authorization).toEqual([`Bearer ${TOKEN}`]);
	});

	test("a server that is down is not a failure: exit 0, the checkpoint stands, and the output says it is pending", async () => {
		const r = rig();
		r.server.down = true;
		expect(await session(r, "checkpoint", "--session", SESSION)).toBe(EXIT_DONE);
		expect(text(r.out)).toContain("ledger: PENDING");
		expect(text(r.out)).toContain("substrate session sync");
		expect((await listLocalCheckpoints({ worktree: r.dir })).checkpoints).toHaveLength(1);
	});

	test("reports skipped files, relative to the worktree", async () => {
		const r = rig({}, false);
		writeFiles(r.dir, { "big.dat": "y".repeat(200) });
		expect(await session(r, "checkpoint", "--session", SESSION)).toBe(EXIT_DONE);
		expect(text(r.out)).toContain("skipped big.dat (too-large)");
	});

	test("carries a transcript pointer and a plan reference to the ledger", async () => {
		const r = rig();
		const ref = '{"surface":"claude-code","session_locator":"abc","turn_no":7}';
		expect(await session(r, "checkpoint", "--session", SESSION, "--transcript-ref", ref, "--plan-phase", "61", "--plan-step", "b")).toBe(EXIT_DONE);
		const [held] = [...r.server.checkpoints.values()];
		expect(held?.transcript_ref).toEqual({ surface: "claude-code", session_locator: "abc", turn_no: 7 });
		expect(held?.plan_ref).toEqual({ phase: "61", step: "b" });
	});

	describe("--omp-session", () => {
		const CONTENT_CANARY = "CANARY-PROMPT-TEXT";
		const OMP_FILE =
			[
				{ type: "session", version: 3, id: "01900000-0000-7000-8000-00000000aaaa", timestamp: "2026-10-20T08:00:00.000Z", cwd: "/synthetic/project" },
				{ type: "message", id: "a1a1a1a1", parentId: null, timestamp: "t", message: { role: "user", content: [{ type: "text", text: CONTENT_CANARY }] } },
				{ type: "message", id: "a2a2a2a2", parentId: "a1a1a1a1", timestamp: "t", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
				{ type: "message", id: "a3a3a3a3", parentId: "a2a2a2a2", timestamp: "t", message: { role: "user", content: [{ type: "text", text: "again" }] } },
			]
				.map((line) => JSON.stringify(line))
				.join("\n") + "\n";
		const FILE_PATH = "/home/someone/secret-dir/synthetic.jsonl";

		test("records the leaf of the omp session as the transcript pointer: the basename as locator, never the path or content", async () => {
			const asked: Array<[string, number]> = [];
			const r = rig({
				readFile: async (path, maxBytes) => {
					asked.push([path, maxBytes]);
					return OMP_FILE;
				},
			});
			expect(await session(r, "checkpoint", "--session", SESSION, "--omp-session", FILE_PATH, "--json")).toBe(EXIT_DONE);
			expect(asked).toEqual([[FILE_PATH, OMP_SESSION_MAX_BYTES]]);
			const [held] = [...r.server.checkpoints.values()];
			expect(held?.transcript_ref).toMatchObject({ surface: "omp", session_locator: "synthetic.jsonl", entry_id: "a3a3a3a3", turn_no: 2, parent_entry_id: "a2a2a2a2" });
			expect(held?.transcript_ref?.prefix_sha256).toMatch(/^[0-9a-f]{64}$/);
			const body = json(r);
			expect(body.transcript_ref_skipped).toBeUndefined();
			expect(body.checkpoint).toMatchObject({ transcript_ref: { session_locator: "synthetic.jsonl" } });
			const everything = text(r.out) + text(r.err) + JSON.stringify([...r.server.checkpoints.values()]);
			expect(everything).not.toContain("secret-dir");
			expect(everything).not.toContain(CONTENT_CANARY);
		});

		test("a file that cannot be read does not fail the checkpoint: it is made without a pointer and the output says why, without the path", async () => {
			const r = rig({
				readFile: async (path) => {
					throw new Error(`ENOENT: no such file or directory, open '${path}'`);
				},
			});
			expect(await session(r, "checkpoint", "--session", SESSION, "--omp-session", FILE_PATH)).toBe(EXIT_DONE);
			expect(text(r.out)).toContain("transcript reference NOT recorded (--omp-session: unreadable)");
			expect(text(r.out)).toContain("created checkpoint");
			expect(text(r.out) + text(r.err)).not.toContain("secret-dir");
			const [held] = [...r.server.checkpoints.values()];
			expect(held).toBeDefined();
			expect(held?.transcript_ref).toBeUndefined();
		});

		test("a file that does not parse is a typed reason in JSON and never echoes its content", async () => {
			const r = rig({ readFile: async () => `not json ${CONTENT_CANARY}\n` });
			expect(await session(r, "checkpoint", "--session", SESSION, "--omp-session", FILE_PATH, "--json")).toBe(EXIT_DONE);
			const body = json(r);
			expect(body).toMatchObject({ ok: true, created: true, transcript_ref_skipped: { source: "omp-session", reason: "header-invalid" } });
			expect(body.checkpoint).not.toHaveProperty("transcript_ref");
			expect(text(r.out) + text(r.err)).not.toContain(CONTENT_CANARY);
			expect([...r.server.checkpoints.values()][0]?.transcript_ref).toBeUndefined();
		});

		test("an unsupported omp session version is reported by its code", async () => {
			const old = OMP_FILE.replace('"version":3', '"version":2');
			const r = rig({ readFile: async () => old });
			expect(await session(r, "checkpoint", "--session", SESSION, "--omp-session", FILE_PATH)).toBe(EXIT_DONE);
			expect(text(r.out)).toContain("--omp-session: unsupported-version");
		});

		test("--omp-session together with --transcript-ref is a usage error before any read or checkpoint", async () => {
			let reads = 0;
			const r = rig({
				fetch: neverCalled,
				readFile: async () => {
					reads++;
					return OMP_FILE;
				},
			});
			const ref = '{"surface":"claude-code","session_locator":"abc","turn_no":7}';
			expect(await session(r, "checkpoint", "--session", SESSION, "--omp-session", FILE_PATH, "--transcript-ref", ref)).toBe(EXIT_USAGE);
			expect(text(r.err)).toContain("mutually exclusive");
			expect(reads).toBe(0);
			expect((await listLocalCheckpoints({ worktree: r.dir })).checkpoints).toEqual([]);
		});

		test("the default reader reads a real file, and refuses a directory and a file over the cap as typed reasons", async () => {
			const dir = tempDir();
			const good = join(dir, "real-session.jsonl");
			writeFileSync(good, OMP_FILE);
			const r = rig();
			expect(await session(r, "checkpoint", "--session", SESSION, "--omp-session", good)).toBe(EXIT_DONE);
			expect([...r.server.checkpoints.values()][0]?.transcript_ref).toMatchObject({ surface: "omp", session_locator: "real-session.jsonl", entry_id: "a3a3a3a3" });

			const big = join(dir, "big.jsonl");
			writeFileSync(big, "");
			truncateSync(big, OMP_SESSION_MAX_BYTES + 1);
			const b = rig();
			expect(await session(b, "checkpoint", "--session", SESSION, "--omp-session", big)).toBe(EXIT_DONE);
			expect(text(b.out)).toContain("--omp-session: too-large");
			expect([...b.server.checkpoints.values()][0]?.transcript_ref).toBeUndefined();

			const d = rig();
			expect(await session(d, "checkpoint", "--session", SESSION, "--omp-session", dir)).toBe(EXIT_DONE);
			expect(text(d.out)).toContain("--omp-session: unreadable");
		});
	});

	test("the session comes from --session, else from the one session this worktree knows, else the command asks", async () => {
		const r = rig();
		expect(await session(r, "checkpoint")).toBe(EXIT_USAGE);
		expect(text(r.err)).toContain("pass --session");
		expect(await session(r, "checkpoint", "--session", "one")).toBe(EXIT_DONE);
		r.err.length = 0;
		expect(await session(r, "checkpoint")).toBe(EXIT_DONE);
		expect([...r.server.checkpoints.values()].map((c) => c.session_id)).toEqual(["one", "one"]);
		expect(await session(r, "checkpoint", "--session", "two")).toBe(EXIT_DONE);
		expect(await session(r, "checkpoint")).toBe(EXIT_USAGE);
		expect(text(r.err)).toContain("2 sessions");
	});
});

describe("session checkpoints", () => {
	test("lists the local checkpoints with the server's view, newest facts first, and the pending journal", async () => {
		const r = rig();
		await session(r, "checkpoint", "--session", SESSION);
		r.server.down = true;
		await session(r, "checkpoint", "--session", SESSION);
		r.server.down = false;
		r.out.length = 0;

		expect(await session(r, "checkpoints", "--json")).toBe(EXIT_DONE);
		const body = json(r) as { checkpoints: Array<{ seq: number; ledger: { state: string; anchor?: string } }>; pending: Record<string, number> };
		expect(body.checkpoints.map((c) => [c.seq, c.ledger.state])).toEqual([
			[1, "recorded"],
			[2, "pending"],
		]);
		expect(body.checkpoints[0]?.ledger.anchor).toBe("anchored");
		expect(body.pending).toMatchObject({ pending_checkpoints: 1, pending_rollbacks: 0, corrupt_pending: 0 });
	});

	test("with the server unreachable it lists locally, asks once, and says unreachable", async () => {
		const r = rig();
		await session(r, "checkpoint", "--session", SESSION);
		await session(r, "checkpoint", "--session", SESSION);
		await session(r, "checkpoint", "--session", SESSION);
		r.server.down = true;
		const before = r.server.calls.length;
		r.out.length = 0;
		expect(await session(r, "checkpoints", "--json")).toBe(EXIT_DONE);
		expect(r.server.calls.length - before).toBe(1);
		const body = json(r) as { checkpoints: Array<{ ledger: { state: string } }> };
		expect(body.checkpoints.map((c) => c.ledger.state).sort()).toEqual(["unreachable", "unreachable", "unreachable"]);
	});

	test("a local checkpoint the server does not hold is `not-on-server` under the code the real server answers, `not-found`", async () => {
		for (const code of ["not-found", "target-not-found"]) {
			const r = rig();
			r.server.notFoundCode = code;
			await session(r, "checkpoint", "--session", SESSION);
			r.server.checkpoints.clear();
			r.out.length = 0;
			expect(await session(r, "checkpoints", "--json")).toBe(EXIT_DONE);
			const body = json(r) as { checkpoints: Array<{ ledger: { state: string } }> };
			expect(body.checkpoints.map((c) => c.ledger.state)).toEqual(["not-on-server"]);
		}
	});

	test("--offline never asks the server", async () => {
		const r = rig();
		await session(r, "checkpoint", "--session", SESSION);
		const before = r.log.tools.length;
		expect(await session(r, "checkpoints", "--offline")).toBe(EXIT_DONE);
		expect(r.log.tools.length).toBe(before);
		expect(text(r.out)).toContain("ledger unknown");
	});

	test("an empty worktree says so, and --session filters", async () => {
		const r = rig();
		expect(await session(r, "checkpoints")).toBe(EXIT_DONE);
		expect(text(r.out)).toContain("no local checkpoints");
		await session(r, "checkpoint", "--session", "one");
		await session(r, "checkpoint", "--session", "two");
		r.out.length = 0;
		await session(r, "checkpoints", "--session", "two", "--json");
		expect((json(r) as { checkpoints: unknown[] }).checkpoints).toHaveLength(1);
	});
});

/** Checkpoint at state A, mutate to state B, checkpoint again; returns the ckpt id of the first (A). */
async function twoStates(r: Rig): Promise<string> {
	await session(r, "checkpoint", "--session", SESSION);
	mutateToB(r.dir);
	await session(r, "checkpoint", "--session", SESSION);
	const [first] = [...r.server.checkpoints.values()].sort((a, b) => a.seq - b.seq);
	r.out.length = 0;
	return first?.ckpt_id ?? "";
}

describe("session rollback", () => {

	test("exit 0 when it is done and recorded; --json carries the status and the exit", async () => {
		const r = rig();
		const target = await twoStates(r);
		expect(await session(r, "rollback", target, "--json")).toBe(EXIT_DONE);
		expect(json(r)).toMatchObject({ ok: true, exit: 0, status: "committed", ledger: { state: "committed" }, mode: "server" });
		expect(r.server.deliveries.commit).toBe(1);
	});

	test("human output names the files, the safety ref and the ledger event", async () => {
		const r = rig();
		const target = await twoStates(r);
		expect(await session(r, "rollback", target)).toBe(EXIT_DONE);
		const output = text(r.out);
		expect(output).toContain("rolled back to");
		expect(output).toContain("ledger event");
		expect(output).toContain("safety ref refs/substrate/safety/");
		expect(output).toContain("pre-restore checkpoint");
		expect(output).toContain("transcript: marker-only");
	});

	test("exit 0 for a dry run, which lists the operations", async () => {
		const r = rig();
		const target = await twoStates(r);
		expect(await session(r, "rollback", target, "--dry-run")).toBe(EXIT_DONE);
		expect(text(r.out)).toContain("dry run: nothing was changed");
		expect(text(r.out)).toContain("  delete new/created.txt");
	});

	test("exit 3 when it refuses (drift), and exit 0 once forced", async () => {
		const r = rig();
		const target = await twoStates(r);
		writeFiles(r.dir, { "src/main.ts": "edited\n" });
		expect(await session(r, "rollback", target)).toBe(EXIT_REFUSED);
		expect(text(r.out)).toContain("refused (drift-detected)");
		expect(await session(r, "rollback", target, "--force")).toBe(EXIT_DONE);
	});

	test("exit 3 for a target of another session", async () => {
		const r = rig();
		await session(r, "checkpoint", "--session", "other");
		const [theirs] = [...r.server.checkpoints.values()];
		await session(r, "checkpoint", "--session", SESSION);
		expect(await session(r, "rollback", theirs?.ckpt_id ?? "", "--session", SESSION)).toBe(EXIT_REFUSED);
		expect(text(r.out)).toContain("not-authorized");
	});

	test("exit 4 with the exact words when the files are restored but the ledger commit is pending", async () => {
		const r = rig();
		const target = await twoStates(r);
		r.server.down = true;
		expect(await session(r, "rollback", target)).toBe(EXIT_LEDGER_PENDING);
		expect(text(r.out)).toContain("files restored, ledger commit pending");
		expect(text(r.out)).toContain("UNANCHORED");
		expect(text(r.out)).toContain("substrate session sync");
	});

	test("exit 1 with the recovery facts when the restore fails", async () => {
		const r = rig({
			hooks: {
				beforeOp: (index) => {
					if (index === 2) throw new Error("disk full");
				},
			},
		});
		const target = await twoStates(r);
		expect(await session(r, "rollback", target)).toBe(EXIT_FAILED);
		expect(text(r.out)).toContain("failed (restore-failed)");
		expect(text(r.out)).toContain("rolled back: yes");
		expect(text(r.out)).toContain("safety ref refs/substrate/safety/");
	});

	test("--offline never touches the network", async () => {
		const r = rig();
		const target = await twoStates(r);
		const before = r.log.tools.length;
		expect(await session(r, "rollback", target, "--offline")).toBe(EXIT_LEDGER_PENDING);
		expect(r.log.tools.length).toBe(before);
	});

	test("an unexpected error is a failure with exit 1 and a message, in JSON too", async () => {
		const r = rig({ worktree: tempDir() });
		expect(await session(r, "rollback", "previous", "--session", "s", "--json")).toBe(EXIT_FAILED);
		expect(json(r)).toMatchObject({ ok: false, exit: 1, status: "failed", failure: { code: "git-failed" } });
	});
});

describe("recover", () => {
	test("says there is nothing to recover; after a crash it finishes the restore and reports it", async () => {
		const crashing = rig({
			hooks: {
				beforeOp: (index) => {
					if (index === 3) throw new SimulatedCrash("process died");
				},
			},
		});
		expect(await session(crashing, "recover")).toBe(EXIT_DONE);
		expect(text(crashing.out)).toContain("nothing to recover");

		await session(crashing, "checkpoint", "--session", SESSION);
		mutateToB(crashing.dir);
		await session(crashing, "checkpoint", "--session", SESSION);
		const [first] = [...crashing.server.checkpoints.values()].sort((a, b) => a.seq - b.seq);
		const exit = await session(crashing, "rollback", first?.ckpt_id ?? "");
		expect(exit).toBe(EXIT_FAILED);
		expect(existsSync(join(crashing.dir, ".git", "substrate-restore", "restore-journal.json"))).toBe(true);

		crashing.out.length = 0;
		const recovered = { ...crashing.deps, hooks: undefined };
		expect(await runSession(["recover", "--json"], recovered)).toBe(EXIT_DONE);
		expect(json(crashing)).toMatchObject({ ok: true, command: "recover", recovered: true, direction: "forward" });
		expect(existsSync(join(crashing.dir, ".git", "substrate-restore", "restore-journal.json"))).toBe(false);
		expect(await runSession(["recover"], recovered)).toBe(EXIT_DONE);
		// The rollback journalled before the crash is delivered by sync once recover has finished the restore.
		expect(crashing.server.deliveries.commit).toBe(0);
		expect(await runSession(["sync"], recovered)).toBe(EXIT_DONE);
		expect(crashing.server.deliveries.commit).toBe(1);
	});

	test("sync alone finishes a crashed restore and delivers its journalled rollback once, without `recover`", async () => {
		const crashing = rig({
			hooks: {
				beforeOp: (index) => {
					if (index === 3) throw new SimulatedCrash("process died");
				},
			},
		});
		await session(crashing, "checkpoint", "--session", SESSION);
		mutateToB(crashing.dir);
		await session(crashing, "checkpoint", "--session", SESSION);
		const [first] = [...crashing.server.checkpoints.values()].sort((a, b) => a.seq - b.seq);
		expect(await session(crashing, "rollback", first?.ckpt_id ?? "")).toBe(EXIT_FAILED);
		expect(existsSync(join(crashing.dir, ".git", "substrate-restore", "restore-journal.json"))).toBe(true);
		expect(crashing.server.deliveries.commit).toBe(0);

		// A new process that runs only `sync`: the restore is completed and the commit is delivered, not held back as restore-in-progress.
		const restarted = { ...crashing.deps, hooks: undefined };
		crashing.out.length = 0;
		expect(await runSession(["sync", "--json"], restarted)).toBe(EXIT_DONE);
		expect(json(crashing)).toMatchObject({ ok: true, command: "sync", remaining: 0, failed: [] });
		expect(existsSync(join(crashing.dir, ".git", "substrate-restore", "restore-journal.json"))).toBe(false);
		expect(crashing.server.deliveries.commit).toBe(1);
		expect(await runSession(["sync"], restarted)).toBe(EXIT_DONE);
		expect(crashing.server.deliveries.commit).toBe(1);
	});
});

describe("sync", () => {
	test("delivers what a down server missed, exactly once, then reports nothing pending", async () => {
		const r = rig();
		const target = await twoStates(r);
		r.server.down = true;
		expect(await session(r, "rollback", target)).toBe(EXIT_LEDGER_PENDING);

		expect(await session(r, "sync")).toBe(EXIT_FAILED);
		expect(text(r.out)).toContain("still pending");
		r.server.down = false;
		r.out.length = 0;
		expect(await session(r, "sync", "--json")).toBe(EXIT_DONE);
		const body = json(r) as { delivered: Array<{ kind: string }>; remaining: number };
		expect(body.delivered.map((d) => d.kind)).toEqual(["checkpoint", "rollback"]);
		expect(body.remaining).toBe(0);
		expect(r.server.deliveries.commit).toBe(1);

		r.out.length = 0;
		expect(await session(r, "sync")).toBe(EXIT_DONE);
		expect(text(r.out)).toContain("nothing pending");
		expect(r.server.deliveries.commit).toBe(1);
	});
});

describe("output hygiene", () => {
	test("the bearer never appears in any output or error, even when the server and the network echo it", async () => {
		const r = rig();
		const target = await twoStates(r);
		const echoing: FetchLike = async (url, init) => {
			if (init.body.includes("session_rollback_plan")) throw new TypeError(`connect failed for ${url}?token=${TOKEN} with ${init.headers.authorization}`);
			return new Response(`bad gateway for ${TOKEN}`, { status: 502 });
		};
		r.deps.fetch = echoing;
		for (const argv of [
			["checkpoint", "--session", SESSION],
			["checkpoints"],
			["checkpoints", "--json"],
			["rollback", target],
			["rollback", target, "--json"],
			["sync"],
			["sync", "--json"],
		]) {
			await runSession(argv, r.deps);
		}
		const everything = text(r.out) + text(r.err);
		expect(everything.length).toBeGreaterThan(0);
		expect(everything).not.toContain(TOKEN);
		expect(everything).not.toContain("0123456789abcdef");
		expect(everything).not.toContain("Bearer tok");
	});

	test("absolute paths are scrubbed from output: the worktree becomes <worktree> and the home directory ~", async () => {
		const r = rig();
		const port = {
			rewind: async (): Promise<never> => {
				throw new Error(`cannot read ${r.dir}/t.jsonl and /home/someone/.claude/t.jsonl`);
			},
		};
		r.deps.transcript = port;
		await session(r, "checkpoint", "--session", SESSION);
		mutateToB(r.dir);
		await session(r, "checkpoint", "--session", SESSION);
		const target = [...r.server.checkpoints.values()].sort((a, b) => a.seq - b.seq)[0]?.ckpt_id ?? "";
		r.out.length = 0;
		expect(await session(r, "rollback", target, "--json")).toBe(EXIT_DONE);
		const output = text(r.out);
		expect(output).toContain("<worktree>/t.jsonl");
		expect(output).toContain("~/.claude/t.jsonl");
		expect(output).not.toContain(r.dir);
		expect(output).not.toContain("/home/someone");
	});
});

describe("the real command", () => {
	const indexPath = join(import.meta.dir, "..", "index.ts");
	const cleanEnv = (): Record<string, string> => ({ PATH: process.env.PATH ?? "", HOME: tempDir() });

	test("`substrate session` is dispatched: usage and exit 2 for a wrong flag, before any work", () => {
		const dir = makeRepo();
		const result = Bun.spawnSync([process.execPath, "--no-env-file", indexPath, "session", "checkpoint", "--bogus"], { cwd: dir, env: cleanEnv() });
		expect(result.exitCode).toBe(2);
		expect(result.stderr.toString()).toContain("usage: substrate session checkpoint");
		expect(result.stdout.toString()).toBe("");
	});

	test("`substrate session checkpoints --offline` runs in the current repository", () => {
		const dir = makeRepo();
		const result = Bun.spawnSync([process.execPath, "--no-env-file", indexPath, "session", "checkpoints", "--offline"], { cwd: dir, env: cleanEnv() });
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toContain("no local checkpoints");
	});

	test("the top-level help lists the session command", () => {
		const result = Bun.spawnSync([process.execPath, "--no-env-file", indexPath], { cwd: tempDir(), env: cleanEnv() });
		expect(result.stdout.toString()).toContain("substrate session checkpoint");
	});
});
