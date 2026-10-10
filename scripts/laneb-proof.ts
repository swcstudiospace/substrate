#!/usr/bin/env bun
/**
 * LANEB-07 isolated proof (`bun run proof:laneb`).
 *
 * Against the Phase-16 harness twin only: reads the `consumer.env` that
 * `rehearsal up --surfaces claude-code,cursor,hermes,omp,muse --name p19`
 * wrote, refuses a production port or a non-loopback host before the first
 * request, then drives a working-to-idle-to-close pane through a real
 * proof-named herdr server (`herdr --session substrate-proof-<tag> server`)
 * watched by a real collector child with persisted state, one Muse tool call
 * through the installed hook (`muse plugins hook test --fixture` after
 * validate, install-or-update, approve and an `inspect` trusted_enabled
 * check), one brief through the real writer, and one synthetic Cursor stop —
 * asserting every event within ten seconds of its own action with zero
 * refused emits. Every side effect lands in temp dirs plus the proof-named
 * session, which is stopped and deleted in `finally`; the twin stays up for
 * the operator's `rehearsal down`.
 *
 * Exit codes mirror the harness: 0 pass, 1 failed, 2 usage-or-refused.
 * No live default herdr session is ever connected and no model runs
 * anywhere: pane states are reported by the proof and the hook runs through
 * the installed hook-test runner with a fixture. Child environments are
 * built explicitly and never inherit HERDR or XDG entries.
 */
import type { Subprocess } from "bun";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStop } from "../packages/collectors/src/cursor-stop.ts";
import { postEvent } from "../packages/collectors/src/emit.ts";
import { branchFor, repoSlug } from "../packages/collectors/src/git-context.ts";
import { loadState, MARKER_START, pass } from "../packages/collectors/src/muse.ts";
import { parseShellExports, refuseSmokeUrl, runDirFor } from "./rehearsal.ts";

const PROOF_NAME = "p19";
const PROOF_SOURCE = "substrate-proof";
const SESSION_PREFIX = "substrate-proof-";
const QUERY_BUDGET_MS = 10_000;
const HOOK_BUDGET_MS = 8000;
const DEAD_URL = "http://127.0.0.1:1";
const HERDR_STARTUP_MS = 20_000;
const RPC_TIMEOUT_MS = 5000;
const STATE_WAIT_MS = 15_000;
const CHILD_TIMEOUT_MS = 60_000;
const COLLECTOR_STOP_MS = 5000;
const MUSE_BIN = "/root/.local/bin/muse";

const results: boolean[] = [];
function check(ok: boolean, what: string, detail?: string): void {
	results.push(ok);
	process.stdout.write(`${ok ? "  ok  " : " FAIL "} ${what}${detail ? ` — ${detail}` : ""}\n`);
}

function shellGit(dir: string, args: string[]): void {
	const run = spawnSync("git", args, { cwd: dir, stdio: "pipe", encoding: "utf8" });
	if (run.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(run.stderr).slice(0, 200)}`);
}

/**
 * A child environment that cannot reach a live session or leak desktop
 * state: explicit keys only, never HERDR_* or XDG_*, with auto-update off.
 */
export function childEnv(extra: Record<string, string>): Record<string, string> {
	// The launcher can update the live installation independently of HOME,
	// so every child — including the projector's muse calls — opts out.
	// XDG_* are dropped by construction: only PATH, MUSE_NO_AUTO_UPDATE and
	// the explicit extras below ever reach the child (scratch-HOME isolation
	// per the verified 19-RESEARCH Muse facts).
	const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", MUSE_NO_AUTO_UPDATE: "1" };
	for (const [key, value] of Object.entries(extra)) env[key] = value;
	for (const key of Object.keys(env)) {
		if (key.startsWith("HERDR_")) throw new Error(`child env carries ${key}`);
		if (key.startsWith("XDG_")) throw new Error(`child env carries ${key}`);
	}
	return env;
}

interface QueryEvent {
	kind?: unknown;
	surface?: unknown;
	repo?: unknown;
	branch?: unknown;
	session_id?: unknown;
	summary?: unknown;
	payload?: Record<string, unknown>;
}

async function queryEvents(base: string, tok: string, body: Record<string, unknown>, timeoutMs = QUERY_BUDGET_MS): Promise<QueryEvent[]> {
	const res = await fetch(`${base}/events/query`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${tok}` },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (res.status !== 200) throw new Error(`query answered ${res.status}`);
	const raw: unknown = await res.json();
	if (raw && typeof raw === "object" && "events" in raw && Array.isArray(raw.events)) {
		return raw.events.filter((event): event is QueryEvent => typeof event === "object" && event !== null);
	}
	return [];
}

/**
 * Poll until `want` holds, measuring the ten-second budget from the action
 * timestamp `sinceMs` (recorded BEFORE the driver). Each request is bounded
 * by the time that remains, so a slow query cannot overrun the deadline.
 */
async function pollFor(base: string, tok: string, body: Record<string, unknown>, want: (events: QueryEvent[]) => boolean, sinceMs = Date.now()): Promise<QueryEvent[]> {
	const deadline = sinceMs + QUERY_BUDGET_MS;
	let seen: QueryEvent[] = [];
	while (Date.now() < deadline) {
		const remaining = remainingMs(sinceMs, Date.now());
		if (remaining <= 0) break;
		seen = await queryEvents(base, tok, body, remaining);
		if (want(seen)) return seen;
		await Bun.sleep(250);
	}
	return seen;
}

/** Only proof-named sessions may be stopped or deleted by this script. */
export function isProofSession(name: string): boolean {
	return name.startsWith(SESSION_PREFIX) && name.length > SESSION_PREFIX.length && /^[A-Za-z0-9-]+$/.test(name);
}

/** Milliseconds left in the ten-second action-to-event budget; never negative. */
export function remainingMs(startedAt: number, now: number, budgetMs = QUERY_BUDGET_MS): number {
	return Math.max(0, startedAt + budgetMs - now);
}

/**
 * Pre-execution guard for any hook run: the installed config URL must equal
 * the already-guarded twin URL, and must itself pass the smoke refusal.
 * Returns the refusal reason, or null when the target is safe to run.
 */
export function assertHookTarget(hookUrl: string, twinUrl: string): string | null {
	if (!hookUrl) return "installed hook has no url; refusing to run the hook";
	if (hookUrl !== twinUrl) return "installed hook url differs from the guarded twin; refusing to run the hook";
	return refuseSmokeUrl(hookUrl);
}

interface HerdrRpcError {
	code?: string;
	message?: string;
}

/** One bounded ND-JSON call against the proof-named herdr socket. */
function herdrRpc(socketPath: string, method: string, params: unknown, timeoutMs = RPC_TIMEOUT_MS): Promise<{ result?: unknown; error?: HerdrRpcError }> {
	const { promise, resolve } = Promise.withResolvers<{ result?: unknown; error?: HerdrRpcError }>();
	let settled = false;
	const finish = (out: { result?: unknown; error?: HerdrRpcError }): void => {
		if (settled) return;
		settled = true;
		resolve(out);
	};
	let sock: Socket;
	try {
		sock = createConnection(socketPath);
	} catch (cause) {
		finish({ error: { code: "socket_error", message: String(cause) } });
		return promise;
	}
	const id = `laneb-proof-${Date.now().toString(36)}`;
	const timer = setTimeout(() => {
		try {
			sock.destroy();
		} catch {
			// Already gone.
		}
		finish({ error: { code: "timeout", message: `${method} timed out` } });
	}, timeoutMs);
	let buf = "";
	sock.on("data", (chunk) => {
		buf += chunk.toString("utf8");
		let idx = buf.indexOf("\n");
		while (idx >= 0) {
			const line = buf.slice(0, idx).trim();
			buf = buf.slice(idx + 1);
			idx = buf.indexOf("\n");
			if (!line) continue;
			let msg: unknown = null;
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			if (!msg || typeof msg !== "object") continue;
			if (!("id" in msg) || msg.id !== id) continue;
			clearTimeout(timer);
			try {
				sock.end();
			} catch {
				// Already gone.
			}
			let result: unknown;
			if ("result" in msg) result = msg.result;
			let error: HerdrRpcError | undefined;
			if ("error" in msg && msg.error && typeof msg.error === "object") {
				const err = msg.error;
				const code = "code" in err && typeof err.code === "string" ? err.code : undefined;
				const message = "message" in err && typeof err.message === "string" ? err.message : undefined;
				error = { code, message };
			}
			finish({ result, error });
			return;
		}
	});
	sock.on("error", (cause) => {
		clearTimeout(timer);
		finish({ error: { code: "socket_error", message: String(cause) } });
	});
	sock.on("connect", () => {
		sock.write(`${JSON.stringify({ id, method, params })}\n`);
	});
	return promise;
}

/** Bounded wait for a file (herdr socket) to exist. */
async function waitForPath(path: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) return true;
		await Bun.sleep(100);
	}
	return existsSync(path);
}

/** Bounded wait for the collector child to seed v2 state (first-run done). */
async function waitForSeededState(statePath: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const raw: unknown = JSON.parse(readFileSync(statePath, "utf8"));
			if (raw && typeof raw === "object" && "version" in raw && raw.version === 2) return true;
		} catch {
			// Not seeded yet.
		}
		await Bun.sleep(200);
	}
	return false;
}

/**
 * Run the real Muse CLI under the scratch HOME: no XDG_* keys by
 * construction (fresh env), no auto-update, bounded wall time.
 */
function museScratch(args: string[], scratchHome: string, cwd: string, timeoutMs = CHILD_TIMEOUT_MS): { status: number; stdout: string; stderr: string } {
	const run = spawnSync(MUSE_BIN, args, {
		cwd,
		encoding: "utf8",
		timeout: timeoutMs,
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: scratchHome, MUSE_NO_AUTO_UPDATE: "1" },
	});
	return { status: run.status ?? 1, stdout: String(run.stdout ?? ""), stderr: String(run.stderr ?? "") };
}

type SpawnedChild = Subprocess;

/** SIGTERM a child owned by this proof, then SIGKILL past a bound. */
async function stopOwnedChild(proc: SpawnedChild, timeoutMs = COLLECTOR_STOP_MS): Promise<void> {
	try {
		proc.kill("SIGTERM");
	} catch {
		// Already gone.
	}
	await Promise.race([proc.exited.then(() => undefined).catch(() => undefined), Bun.sleep(timeoutMs)]);
	try {
		proc.kill("SIGKILL");
	} catch {
		// Already gone.
	}
}

/** Session ids the collector state file currently tracks. */
function trackedSessionIds(statePath: string): string[] {
	try {
		const raw: unknown = JSON.parse(readFileSync(statePath, "utf8"));
		if (!raw || typeof raw !== "object" || !("panes" in raw)) return [];
		const panes: unknown = raw.panes;
		if (!panes || typeof panes !== "object") return [];
		const ids: string[] = [];
		for (const entry of Object.values(panes)) {
			if (entry && typeof entry === "object" && "session_id" in entry && typeof entry.session_id === "string") {
				ids.push(entry.session_id);
			}
		}
		return ids;
	} catch {
		return [];
	}
}

async function museCachePaths(): Promise<string[]> {
	// Reads the live installation: never let the launcher update it mid-proof.
	const run = spawnSync("/root/.local/bin/muse", ["plugins", "list", "--json"], {
		encoding: "utf8",
		env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1" },
	});
	if (run.status !== 0) throw new Error(`muse list failed: ${String(run.stderr).slice(0, 200)}`);
	const raw: unknown = JSON.parse(String(run.stdout));
	if (raw && typeof raw === "object" && "plugins" in raw && Array.isArray(raw.plugins)) {
		return raw.plugins
			.map((entry) => {
				if (entry && typeof entry === "object" && "record" in entry) {
					const record: unknown = entry.record;
					if (record && typeof record === "object" && "cache_path" in record) {
						return typeof record.cache_path === "string" ? record.cache_path : "";
					}
				}
				return "";
			})
			.sort();
	}
	return [];
}

async function runHook(hookPath: string, cwd: string, home: string, fixture: Record<string, unknown>): Promise<{ code: number; stdout: string; ms: number }> {
	const started = Date.now();
	const proc = Bun.spawn(["bun", hookPath], {
		cwd,
		env: childEnv({ HOME: home }),
		stdin: new Blob([JSON.stringify(fixture)]),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	return { code, stdout, ms: Date.now() - started };
}

async function main(argv: string[]): Promise<number> {
	if (argv.length > 0) {
		process.stderr.write(`[laneb-proof] unexpected argument ${argv[0]}.\nusage: proof:laneb\n`);
		return 2;
	}
	const runDir = runDirFor(PROOF_NAME);
	let consumer: string;
	try {
		consumer = readFileSync(join(runDir, "consumer.env"), "utf8");
	} catch {
		process.stderr.write(`[laneb-proof] refused: no consumer.env for ${PROOF_NAME}: run rehearsal up --name ${PROOF_NAME} first.\n`);
		return 2;
	}
	const record = parseShellExports(consumer);
	const base = (record["SUBSTRATE_URL"] ?? "").replace(/\/+$/, "");
	const tok = record["SUBSTRATE_TOKEN"] ?? "";
	if (!tok) {
		process.stderr.write(`[laneb-proof] refused: consumer.env for ${PROOF_NAME} has no twin token.\n`);
		return 2;
	}
	const refused = refuseSmokeUrl(base);
	if (refused !== null) {
		process.stderr.write(`[laneb-proof] refused: ${refused}.\n`);
		return 2;
	}

	const tag = `p19-${Date.now().toString(36)}`;
	process.stdout.write(`\n[laneb-proof] ${tag} against ${base}\n\n`);

	for (const key of Object.keys(process.env)) {
		if (key.startsWith("HERDR_")) delete process.env[key];
	}
	const savedEnv = { url: process.env.SUBSTRATE_URL, token: process.env.SUBSTRATE_TOKEN, stateDir: process.env.SUBSTRATE_STATE_DIR, collectorState: process.env.SUBSTRATE_COLLECTOR_STATE, museRepos: process.env.SUBSTRATE_MUSE_REPOS };

	const tmp = realpathSync(mkdtempSync(join(tmpdir(), "laneb-proof-")));
	const stateDir = join(tmp, "state");
	const cursorRoot = join(tmp, "cursor");
	const transcripts = join(tmp, "transcripts");
	const scratchHome = join(tmp, "home");
	mkdirSync(stateDir, { recursive: true });
	mkdirSync(scratchHome, { recursive: true });
	const herdrState = join(stateDir, "herdr-offsets.json");
	const museState = join(stateDir, "muse-offsets.json");
	process.env.SUBSTRATE_URL = base;
	process.env.SUBSTRATE_TOKEN = tok;
	process.env.SUBSTRATE_STATE_DIR = stateDir;
	process.env.SUBSTRATE_COLLECTOR_STATE = museState;

	let collectorProc: SpawnedChild | undefined;
	let herdrServer: SpawnedChild | undefined;
	let proofSession: string | undefined;
	let proofSock = "";
	let proofHome = "";
	try {
		// Scratch repo R: a run-tagged rehearsal slug with a resolvable branch.
		const repo = join(tmp, "repo");
		const runSlug = `substrate-rehearsal/p19-${tag}`;
		mkdirSync(repo, { recursive: true });
		shellGit(repo, ["init", "-q", "--initial-branch=p19-tag"]);
		shellGit(repo, ["config", "user.email", "laneb-proof@example.invalid"]);
		shellGit(repo, ["config", "user.name", "LANEB proof"]);
		shellGit(repo, ["commit", "-q", "--allow-empty", "-m", `proof ${tag}`]);
		shellGit(repo, ["remote", "add", "origin", `https://github.com/${runSlug}.git`]);
		const slug = repoSlug(repo);
		const branch = branchFor(repo);
		check(slug === runSlug, "scratch repo slug resolves", slug);
		check(branch === "p19-tag", "scratch repo branch resolves", branch);
		if (slug !== runSlug || branch !== "p19-tag") return 1;

		// Real proof-named herdr server plus a watching collector child with
		// persisted state (D19-27). Nothing here touches the live default
		// session: every socket call targets proofSock, and teardown stops
		// and deletes only this proof-named session. No model runs: pane
		// states are reported by the proof itself.
		const session = `${SESSION_PREFIX}${tag}`;
		if (!isProofSession(session)) {
			process.stderr.write(`[laneb-proof] refused: session name is not proof-owned.\n`);
			return 2;
		}
		proofSession = session;
		proofHome = process.env.HOME && process.env.HOME.length > 0 ? process.env.HOME : "/root";
		proofSock = join(proofHome, ".config", "herdr", "sessions", session, "herdr.sock");
		try {
			herdrServer = Bun.spawn(["herdr", "--session", session, "server"], {
				cwd: process.cwd(),
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: proofHome },
				stdout: "ignore",
				stderr: "ignore",
			});
		} catch (cause) {
			check(false, "proof herdr server starts", String(cause).slice(0, 160));
			return 1;
		}
		check(await waitForPath(proofSock, HERDR_STARTUP_MS), "proof herdr server owns its socket", proofSock);
		if (!existsSync(proofSock)) return 1;

		// The watching collector child starts with scratch state BEFORE the
		// first pane is driven, so first-run seeding cannot swallow events.
		const collectorEnv = childEnv({ HOME: proofHome, SUBSTRATE_URL: base, SUBSTRATE_TOKEN: tok, SUBSTRATE_STATE_DIR: stateDir, SUBSTRATE_COLLECTOR_STATE: herdrState });
		collectorProc = Bun.spawn(["bun", "packages/collectors/src/herdr.ts", "--watch", "--session", session], {
			cwd: process.cwd(),
			env: collectorEnv,
			stdout: "ignore",
			stderr: "ignore",
		});
		const seeded = await waitForSeededState(herdrState, STATE_WAIT_MS);
		check(seeded, "proof collector seeds v2 state before the first pane");
		if (!seeded) return 1;

		// Scratch workspace whose root pane lives in R, then working.
		const created = await herdrRpc(proofSock, "workspace.create", { cwd: repo, label: `${PROOF_SOURCE}-${tag}`, focus: false });
		let paneId = "";
		if (created.result && typeof created.result === "object" && "root_pane" in created.result) {
			const rootPane: unknown = created.result.root_pane;
			if (rootPane && typeof rootPane === "object" && "pane_id" in rootPane && typeof rootPane.pane_id === "string") {
				paneId = rootPane.pane_id;
			}
		}
		check(paneId.length > 0, "proof workspace opens a scratch pane in R", paneId || (created.error ? `${created.error.code ?? "error"}` : "no pane").slice(0, 120));
		if (!paneId) return 1;

		const tWorking = Date.now();
		const reportedWorking = await herdrRpc(proofSock, "pane.report_agent", { pane_id: paneId, source: PROOF_SOURCE, agent: "omp", state: "working" });
		check(!reportedWorking.error, "scratch pane reports working", reportedWorking.error ? `${reportedWorking.error.code ?? "error"}`.slice(0, 120) : paneId);
		const seenStart = await pollFor(base, tok, { repo: slug, limit: 100, include_payload: true }, (events) =>
			events.some((event) => event.kind === "session.start" && event.surface === "omp"),
			tWorking,
		);
		const starts = seenStart.filter((event) => event.kind === "session.start" && event.surface === "omp");
		check(starts.length >= 1, "working pane emits session.start within 10s of the report", `${starts.length}`);
		const firstStart = starts[0];
		const startSessionId = typeof firstStart?.session_id === "string" ? firstStart.session_id : "";
		check(firstStart?.repo === slug, "session.start carries the rehearsal slug", String(firstStart?.repo ?? "missing"));
		check(firstStart?.branch === "p19-tag", "session.start carries the branch", String(firstStart?.branch ?? "missing"));

		// Saved-offset recovery: the state file holds the working pane, then
		// the collector child is killed and restarted before idle arrives.
		const savedBefore = trackedSessionIds(herdrState);
		check(startSessionId === "" ? savedBefore.length >= 1 : savedBefore.includes(startSessionId), "collector state saves the working pane offset", `${savedBefore.length} tracked`);
		if (collectorProc) {
			await stopOwnedChild(collectorProc);
			collectorProc = undefined;
		}
		collectorProc = Bun.spawn(["bun", "packages/collectors/src/herdr.ts", "--watch", "--session", session], {
			cwd: process.cwd(),
			env: collectorEnv,
			stdout: "ignore",
			stderr: "ignore",
		});
		await Bun.sleep(2500);
		const savedAfter = trackedSessionIds(herdrState);
		check(savedAfter.length >= 1 && savedBefore.every((id) => savedAfter.includes(id)), "restarted collector reloads the saved offsets", `${savedAfter.length} tracked`);

		const tIdle = Date.now();
		const reportedIdle = await herdrRpc(proofSock, "pane.report_agent", { pane_id: paneId, source: PROOF_SOURCE, agent: "omp", state: "idle" });
		check(!reportedIdle.error, "scratch pane reports idle after the restart", reportedIdle.error ? `${reportedIdle.error.code ?? "error"}`.slice(0, 120) : paneId);
		const seenIdle = await pollFor(base, tok, { repo: slug, limit: 100, include_payload: true }, (events) =>
			events.some((event) => event.kind === "note" && event.surface === "omp" && event.payload?.["status"] === "idle"),
			tIdle,
		);
		const idleNotes = seenIdle.filter((event) => event.kind === "note" && event.surface === "omp");
		check(idleNotes.length >= 1, "idle transition emits a note after restart within 10s of the report", `${idleNotes.length}`);
		check(idleNotes[0]?.payload?.["runtime"] === "herdr" && idleNotes[0]?.payload?.["status"] === "idle", "idle note carries runtime herdr", JSON.stringify(idleNotes[0]?.payload ?? null).slice(0, 120));

		// Pane close, then stop the collector child.
		const tClose = Date.now();
		const closedPane = await herdrRpc(proofSock, "pane.close", { pane_id: paneId });
		check(!closedPane.error, "scratch pane closes", closedPane.error ? `${closedPane.error.code ?? "error"}`.slice(0, 120) : paneId);
		const seenEnd = await pollFor(base, tok, { repo: slug, limit: 100, include_payload: true }, (events) =>
			events.some((event) => event.kind === "session.end" && event.surface === "omp"),
			tClose,
		);
		const ends = seenEnd.filter((event) => event.kind === "session.end" && event.surface === "omp");
		check(ends.length >= 1, "closed pane emits session.end within 10s of the close", `${ends.length}`);
		check(ends[0]?.repo === slug, "herdr session.end carries the repo", String(ends[0]?.repo ?? "missing"));
		if (collectorProc) {
			await stopOwnedChild(collectorProc);
			collectorProc = undefined;
		}
		const allStarts = await queryEvents(base, tok, { repo: slug, limit: 100 }, QUERY_BUDGET_MS);
		const startCount = allStarts.filter((event) => event.kind === "session.start" && event.surface === "omp" && (startSessionId === "" || event.session_id === startSessionId)).length;
		check(startCount === 1, "exactly one session.start across the restart", `${startCount}`);

		// Real scratch-scope Muse install: validate, install-or-update,
		// approve, inspect — never into the operator scope. XDG_* are unset
		// by construction in every scratch child env below. No model runs:
		// the tool call travels through the installed hook-test runner.
		const cachesBefore = await museCachePaths();
		const tokenFile = join(tmp, "token.env");
		writeFileSync(tokenFile, `SUBSTRATE_TOKEN=${tok}\n`, { mode: 0o600 });
		chmodSync(tokenFile, 0o600);
		const bundleDir = join(tmp, "bundle");
		const projected = spawnSync(process.execPath, ["packages/projector/src/muse.ts"], {
			cwd: process.cwd(),
			env: childEnv({ HOME: scratchHome, MUSE_PLUGIN_DIR: bundleDir, SUBSTRATE_URL: base, SUBSTRATE_MUSE_TOKEN_FILE: tokenFile, SUBSTRATE_STATE_DIR: stateDir }),
			encoding: "utf8",
			timeout: CHILD_TIMEOUT_MS,
		});
		check(projected.status === 0, "muse bundle installs into the scratch scope", String(projected.stderr).slice(0, 160));
		const inspected = museScratch(["plugins", "inspect", "substrate", "--json"], scratchHome, process.cwd());
		let trusted = false;
		try {
			const parsed: unknown = JSON.parse(inspected.stdout);
			if (parsed && typeof parsed === "object" && "runtime_capabilities" in parsed && Array.isArray(parsed.runtime_capabilities)) {
				const caps: unknown[] = parsed.runtime_capabilities;
				trusted = caps.length > 0 && caps.every((cap) => !!cap && typeof cap === "object" && "status" in cap && cap.status === "trusted_enabled");
			}
		} catch {
			trusted = false;
		}
		check(trusted, "scratch install is approved (trusted_enabled)");
		const listed = museScratch(["plugins", "list", "--json"], scratchHome, process.cwd());
		let installedCache = "";
		try {
			const parsed: unknown = JSON.parse(listed.stdout);
			if (parsed && typeof parsed === "object" && "plugins" in parsed && Array.isArray(parsed.plugins)) {
				for (const entry of parsed.plugins) {
					if (!entry || typeof entry !== "object") continue;
					if (!("plugin" in entry) || !entry.plugin || typeof entry.plugin !== "object") continue;
					if (!("id" in entry.plugin) || entry.plugin.id !== "substrate") continue;
					if (!("record" in entry) || !entry.record || typeof entry.record !== "object") continue;
					if ("cache_path" in entry.record && typeof entry.record.cache_path === "string") installedCache = entry.record.cache_path;
				}
			}
		} catch {
			installedCache = "";
		}
		check(installedCache.length > 0, "scratch install reports a cache path", installedCache.slice(0, 80));
		// Pre-execution guard (T-19-14): the installed config URL must equal
		// the guarded twin URL before ANY hook runs.
		let installedUrl = "";
		try {
			const installedConfig: unknown = JSON.parse(readFileSync(join(installedCache, "hooks", "substrate.json"), "utf8"));
			if (installedConfig && typeof installedConfig === "object" && "url" in installedConfig && typeof installedConfig.url === "string") {
				installedUrl = installedConfig.url;
			}
		} catch {
			installedUrl = "";
		}
		const hookGuard = assertHookTarget(installedUrl, base);
		check(hookGuard === null, "installed hook config targets the guarded twin", installedUrl || "missing");
		if (hookGuard !== null) {
			process.stderr.write(`[laneb-proof] refused: ${hookGuard}.\n`);
			return 2;
		}
		let installedRedact = "";
		try {
			installedRedact = readFileSync(join(installedCache, "hooks", "redact.ts"), "utf8");
		} catch {
			installedRedact = "";
		}
		const bundleRedact = readFileSync(join(bundleDir, "hooks", "redact.ts"), "utf8");
		check(installedRedact.length > 0 && installedRedact === bundleRedact, "installed redactor matches the projected bundle", `${installedRedact.length} bytes`);
		const hookSession = `muse-hook-${Date.now().toString(36)}`;
		const fixturePath = join(tmp, "hook-fixture.json");
		writeFileSync(fixturePath, JSON.stringify({ event: "PostToolUse", stdin: { hook_event_name: "PostToolUse", session_id: hookSession, tool_name: "Edit", tool_use_id: "call-7", outcome: "success", duration_ms: 35 } }));
		const tHook = Date.now();
		const hookTest = museScratch(["plugins", "hook", "test", "substrate:post-tool-use", "--fixture", fixturePath, "--json"], scratchHome, repo);
		let hookOk = false;
		let hookDetail = "unparsed";
		try {
			const parsed: unknown = JSON.parse(hookTest.stdout);
			if (parsed && typeof parsed === "object" && "terminals" in parsed && Array.isArray(parsed.terminals)) {
				for (const terminal of parsed.terminals) {
					if (!terminal || typeof terminal !== "object") continue;
					if (!("hook_key" in terminal) || terminal.hook_key !== "plugin:substrate:post-tool-use") continue;
					const exitCode: unknown = "exit_code" in terminal ? terminal.exit_code : undefined;
					const stdout: unknown = "stdout" in terminal ? terminal.stdout : undefined;
					hookDetail = `exit ${typeof exitCode === "number" ? exitCode : "?"}`;
					if (exitCode === 0 && stdout === "") {
						hookOk = true;
						hookDetail = "exit 0";
					}
				}
			}
		} catch {
			hookOk = false;
		}
		check(hookOk, "installed hook test completes with empty stdout", hookDetail.slice(0, 120));
		const seenTool = await pollFor(base, tok, { repo: slug, limit: 100, include_payload: true }, (events) =>
			events.some((event) => event.kind === "tool.call" && event.surface === "muse"),
			tHook,
		);
		const toolCalls = seenTool.filter((event) => event.kind === "tool.call" && event.surface === "muse");
		check(toolCalls.length >= 1, "installed hook emits tool.call within 10s of the hook test", `${toolCalls.length}`);
		check(toolCalls[0]?.branch === "p19-tag", "muse tool.call carries the branch", String(toolCalls[0]?.branch ?? "missing"));
		const cachesAfter = await museCachePaths();
		check(JSON.stringify(cachesAfter) === JSON.stringify(cachesBefore), "operator muse cache paths identical before and after");

		// The per-action polls above already asserted the start, the idle
		// note, the tool call and the end within ten seconds of their own
		// actions; the brief writer reads the same repo scope next.

		// The writer lists both mid-kind events, keeps one pointer, and a
		// closed-port run leaves the brief byte-identical.
		process.env.SUBSTRATE_MUSE_REPOS = repo;
		await pass([repo], loadState());
		const briefPath = join(repo, ".substrate", "BRIEF.md");
		const agentsPath = join(repo, "AGENTS.md");
		const first = readFileSync(briefPath, "utf8");
		check(first.includes("herdr") && first.includes("muse called Edit"), "BRIEF.md lists the note and the tool call");
		check(first.includes(slug), "BRIEF.md heads the rehearsal slug");
		const markers = (text: string): number => text.split(MARKER_START).length - 1;
		check(markers(readFileSync(agentsPath, "utf8")) === 1, "one pointer block after the first pass");
		for (let i = 0; i < 4; i++) await pass([repo], loadState());
		check(markers(readFileSync(agentsPath, "utf8")) === 1, "one pointer block across five reruns");
		process.env.SUBSTRATE_URL = DEAD_URL;
		await pass([repo], loadState());
		process.env.SUBSTRATE_URL = base;
		check(readFileSync(briefPath, "utf8") === first, "closed-port run leaves BRIEF.md byte-identical");
		check(markers(readFileSync(agentsPath, "utf8")) === 1, "closed-port run keeps the pointer");

		// Synthetic Cursor stop: a runtime-assembled shape is copied redacted
		// at 0600 and the session.end names the copy.
		const shape = ["gh", "p_", "a1B2c3D4e5".repeat(4)].join("");
		const cid = `laneb-proof-${Date.now().toString(36)}`;
		const transcriptDir = join(cursorRoot, "projects", "p", "agent-transcripts", cid);
		mkdirSync(transcriptDir, { recursive: true });
		const transcript = join(transcriptDir, `${cid}.jsonl`);
		writeFileSync(transcript, `{"role":"user","text":"deploy with ${shape} now"}\n`);
		const envelope = JSON.stringify({ conversation_id: cid, transcript_path: transcript, status: "completed" });
		const outcome = await runStop(envelope, {
			emit: (event) => postEvent(event, { timeoutMs: 1500, collector: "cursor-stop", source: "cursor.stop" }),
			root: cursorRoot,
			destDir: transcripts,
		});
		const copy = join(transcripts, `${cid}.jsonl`);
		check(existsSync(copy), "cursor transcript copy lands in the scratch dir");
		if (existsSync(copy)) {
			check((statSync(copy).mode & 0o777) === 0o600, "cursor copy is mode 0600");
			check(!readFileSync(copy, "utf8").includes(shape), "cursor copy holds no trace of the shape");
		}
		check(outcome.ref !== null, "stop reports the transcript copy", outcome.reason ?? "");
		const cursorSeen = await pollFor(base, tok, { session_id: cid, limit: 10, include_payload: true }, (events) =>
			events.some((event) => event.kind === "session.end" && event.surface === "cursor"),
		);
		const cursorEnd = cursorSeen.find((event) => event.kind === "session.end" && event.surface === "cursor");
		check(cursorEnd?.payload?.["transcript_ref"] !== null && cursorEnd?.payload?.["transcript_ref"] !== undefined, "cursor session.end names the copy");

		// Fail-open hooks against a dead url: exit 0, empty stdout, in budget.
		const deadSpawn = (target: string, stdin: string, extra: Record<string, string>): Promise<{ code: number; stdout: string; ms: number }> => {
			const startedAt = Date.now();
			const proc = Bun.spawn(["bun", target], {
				env: childEnv({ HOME: scratchHome, SUBSTRATE_URL: DEAD_URL, ...extra }),
				stdin: new Blob([stdin]),
				stdout: "pipe",
				stderr: "pipe",
			});
			return Promise.all([new Response(proc.stdout).text(), proc.exited]).then(([stdout, code]) => ({ code, stdout, ms: Date.now() - startedAt }));
		};
		const deadCursor = await deadSpawn("packages/collectors/src/cursor-stop.ts", envelope, { SUBSTRATE_CURSOR_ROOT: cursorRoot, SUBSTRATE_TRANSCRIPTS_DIR: join(tmp, "dead-transcripts") });
		check(deadCursor.code === 0 && deadCursor.stdout === "" && deadCursor.ms < HOOK_BUDGET_MS, "cursor hook fails open on a dead url", `${deadCursor.ms}ms`);
		const deadBundle = join(tmp, "dead-bundle");
		const deadProjected = spawnSync(process.execPath, ["packages/projector/src/muse.ts", "--bundle-only"], {
			cwd: process.cwd(),
			env: childEnv({ HOME: scratchHome, MUSE_PLUGIN_DIR: deadBundle, SUBSTRATE_URL: DEAD_URL, SUBSTRATE_MUSE_TOKEN_FILE: tokenFile, SUBSTRATE_STATE_DIR: stateDir }),
			encoding: "utf8",
		});
		let deadHookOk = false;
		let deadHookMs = -1;
		if (deadProjected.status === 0) {
			const deadHook = await runHook(join(deadBundle, "hooks", "post-tool-use.ts"), repo, scratchHome, { tool_name: "Read" });
			deadHookOk = deadHook.code === 0 && deadHook.stdout === "" && deadHook.ms < HOOK_BUDGET_MS;
			deadHookMs = deadHook.ms;
		}
		check(deadHookOk, "muse hook fails open on a dead url", `${deadHookMs}ms`);

		// Zero refused emits since the proof started.
		const startIso = new Date(Date.now() - 30 * 60 * 1000).toISOString();
		const status = spawnSync(process.execPath, ["packages/collectors/src/status.ts", "--state-dir", stateDir, "--since", startIso], {
			env: childEnv({ HOME: scratchHome, SUBSTRATE_STATE_DIR: stateDir }),
			encoding: "utf8",
		});
		const statusOut = String(status.stdout ?? "");
		check(status.status === 0 && statusOut.includes("): 0 ("), "collectors:status reports zero refused", statusOut.trim().split("\n").at(-1) ?? "");
	} finally {
		if (collectorProc) await stopOwnedChild(collectorProc);
		collectorProc = undefined;
		// Stop and delete ONLY the proof-named session; the live default
		// session is never named here.
		if (proofSession && isProofSession(proofSession)) {
			const scrubbedEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: proofHome || "/root" };
			spawnSync("herdr", ["--session", proofSession, "server", "stop"], { timeout: 10_000, encoding: "utf8", env: scrubbedEnv });
			spawnSync("herdr", ["session", "delete", proofSession], { timeout: 10_000, encoding: "utf8", env: scrubbedEnv });
			try {
				rmdirSync(join(scrubbedEnv.HOME, ".config", "herdr", "sessions"));
			} catch {
				// Non-empty or already gone.
			}
		}
		try {
			herdrServer?.kill("SIGTERM");
		} catch {
			// Already gone.
		}
		herdrServer = undefined;
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(tmp, { recursive: true, force: true });
	}

	const passed = results.filter(Boolean).length;
	process.stdout.write(`\n${passed}/${results.length} laneb checks passed\n`);
	return passed === results.length ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
