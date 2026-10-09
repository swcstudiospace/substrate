#!/usr/bin/env bun
/**
 * LANEB-07 isolated proof (`bun run proof:laneb`).
 *
 * Against the Phase-16 harness twin only: reads the `consumer.env` that
 * `rehearsal up --surfaces claude-code,cursor,hermes,omp,muse --name p19`
 * wrote, refuses a production port or a non-loopback host before the first
 * request, then drives a working-to-idle-to-close pane through the real
 * herdr collector, one Muse tool call through the projected hook, one brief
 * through the real writer, and one synthetic Cursor stop — asserting every
 * event over a repo-filtered read within ten seconds with zero refused
 * emits. Every side effect lands in temp dirs; the twin stays up for the
 * operator's `rehearsal down`.
 *
 * Exit codes mirror the harness: 0 pass, 1 failed, 2 usage-or-refused.
 * The pane source is a loopback socket stub speaking the snapshot RPC, so
 * no live herdr session is ever connected; child environments are built
 * explicitly and never inherit HERDR entries. No model runs anywhere: the
 * pane states are reported by the proof and the hook runs against a
 * fixture.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrCollector } from "../packages/collectors/src/herdr.ts";
import type { HerdrPane } from "../packages/collectors/src/herdr-map.ts";
import { runStop } from "../packages/collectors/src/cursor-stop.ts";
import { postEvent } from "../packages/collectors/src/emit.ts";
import { branchFor, repoSlug } from "../packages/collectors/src/git-context.ts";
import { loadState, MARKER_START, pass } from "../packages/collectors/src/muse.ts";
import { parseShellExports, refuseSmokeUrl, runDirFor } from "./rehearsal.ts";

const PROOF_NAME = "p19";
const QUERY_BUDGET_MS = 10_000;
const HOOK_BUDGET_MS = 8000;
const DEAD_URL = "http://127.0.0.1:1";

const results: boolean[] = [];
function check(ok: boolean, what: string, detail?: string): void {
	results.push(ok);
	process.stdout.write(`${ok ? "  ok  " : " FAIL "} ${what}${detail ? ` — ${detail}` : ""}\n`);
}

function shellGit(dir: string, args: string[]): void {
	const run = spawnSync("git", args, { cwd: dir, stdio: "pipe", encoding: "utf8" });
	if (run.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(run.stderr).slice(0, 200)}`);
}

/** A child environment that cannot reach a live session: explicit keys only. */
function childEnv(extra: Record<string, string>): Record<string, string> {
	const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
	for (const [key, value] of Object.entries(extra)) env[key] = value;
	for (const key of Object.keys(env)) {
		if (key.startsWith("HERDR_")) throw new Error(`child env carries ${key}`);
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

async function queryEvents(base: string, tok: string, body: Record<string, unknown>): Promise<QueryEvent[]> {
	const res = await fetch(`${base}/events/query`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${tok}` },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(10_000),
	});
	if (res.status !== 200) throw new Error(`query answered ${res.status}`);
	const raw: unknown = await res.json();
	if (raw && typeof raw === "object" && "events" in raw && Array.isArray(raw.events)) {
		return raw.events.filter((event): event is QueryEvent => typeof event === "object" && event !== null);
	}
	return [];
}

async function pollFor(base: string, tok: string, body: Record<string, unknown>, want: (events: QueryEvent[]) => boolean): Promise<QueryEvent[]> {
	const deadline = Date.now() + QUERY_BUDGET_MS;
	let seen: QueryEvent[] = [];
	while (Date.now() < deadline) {
		seen = await queryEvents(base, tok, body);
		if (want(seen)) return seen;
		await Bun.sleep(250);
	}
	return seen;
}

async function museCachePaths(): Promise<string[]> {
	const run = spawnSync("/root/.local/bin/muse", ["plugins", "list", "--json"], { encoding: "utf8" });
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

	let collector: HerdrCollector | undefined;
	let server: Server | undefined;
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

		// Pane source: a loopback stub for the snapshot RPC. Panes are the
		// proof's own fixtures; the collector under test is real.
		let panes: HerdrPane[] = [];
		server = createServer((socket) => {
			let buf = "";
			socket.on("data", (chunk) => {
				buf += chunk.toString("utf8");
				let idx = buf.indexOf("\n");
				while (idx >= 0) {
					const line = buf.slice(0, idx).trim();
					buf = buf.slice(idx + 1);
					idx = buf.indexOf("\n");
					if (!line) continue;
					let raw: unknown = null;
					try {
						raw = JSON.parse(line);
					} catch {
						continue;
					}
					if (!raw || typeof raw !== "object") continue;
					const id = "id" in raw ? raw.id : undefined;
					const method = "method" in raw && typeof raw.method === "string" ? raw.method : "";
					if (method === "session.snapshot") {
						socket.write(`${JSON.stringify({ id, result: { snapshot: { panes } } })}\n`);
						socket.end();
					}
				}
			});
		});
		const sockPath = join(tmp, "herdr.sock");
		await new Promise<void>((resolve, reject) => {
			server?.listen(sockPath, () => resolve());
			server?.once("error", reject);
		});
		const pane = (status: string): HerdrPane => ({ pane_id: "w9:p1", terminal_id: "t-laneb-1", agent: "omp", agent_status: status, cwd: repo });

		// Seed the v2 file on an empty snapshot so seeding swallows nothing.
		collector = new HerdrCollector({ socketPath: sockPath, statePath: herdrState });
		panes = [];
		const seed = await collector.runPass();
		const seededRaw: unknown = JSON.parse(readFileSync(herdrState, "utf8"));
		const seededVersion = seededRaw && typeof seededRaw === "object" && "version" in seededRaw ? seededRaw.version : 0;
		check(seed.emitted === 0 && seededVersion === 2, "empty snapshot seeds v2 state silently");

		// Working, then a kill-and-restart, then idle: one start, one note.
		panes = [pane("working")];
		const started = await collector.runPass();
		collector.stop();
		collector = new HerdrCollector({ socketPath: sockPath, statePath: herdrState });
		panes = [pane("idle")];
		const idled = await collector.runPass();
		check(started.emitted >= 1, "working pane emits session.start");
		check(idled.emitted >= 1, "idle transition emits a note after restart");

		// Pane close, then stop the collector.
		panes = [];
		const closed = await collector.runPass();
		collector.stop();
		collector = undefined;
		check(closed.emitted >= 1, "closed pane emits session.end");

		// Muse bundle into an isolated scope: validated, never installed.
		const cachesBefore = await museCachePaths();
		const tokenFile = join(tmp, "token.env");
		writeFileSync(tokenFile, `SUBSTRATE_TOKEN=${tok}\n`, { mode: 0o600 });
		chmodSync(tokenFile, 0o600);
		const bundleDir = join(tmp, "bundle");
		const projected = spawnSync(process.execPath, ["packages/projector/src/muse.ts", "--bundle-only"], {
			cwd: process.cwd(),
			env: childEnv({ HOME: scratchHome, MUSE_PLUGIN_DIR: bundleDir, SUBSTRATE_URL: base, SUBSTRATE_MUSE_TOKEN_FILE: tokenFile, SUBSTRATE_STATE_DIR: stateDir }),
			encoding: "utf8",
		});
		check(projected.status === 0, "muse bundle projects into the isolated scope", String(projected.stderr).slice(0, 160));
		const hookPath = join(bundleDir, "hooks", "post-tool-use.ts");
		let hookUrl = "";
		try {
			const hookConfig: unknown = JSON.parse(readFileSync(join(bundleDir, "hooks", "substrate.json"), "utf8"));
			if (hookConfig && typeof hookConfig === "object" && "url" in hookConfig && typeof hookConfig.url === "string") {
				hookUrl = hookConfig.url;
			}
		} catch {
			hookUrl = "";
		}
		const hookSession = `muse-hook-${Date.now().toString(36)}`;
		const hooked = await runHook(hookPath, repo, scratchHome, { tool_name: "Edit", session_id: hookSession, tool_use_id: "call-7", outcome: "success", duration_ms: 35 });
		check(hooked.code === 0 && hooked.stdout === "", "muse hook emits with empty stdout", `exit ${hooked.code}`);
		const cachesAfter = await museCachePaths();
		check(JSON.stringify(cachesAfter) === JSON.stringify(cachesBefore), "operator muse cache paths identical before and after");

		// Every herdr and muse event lands under the repo filter in budget.
		const seen = await pollFor(base, tok, { repo: slug, limit: 100, include_payload: true }, (events) => {
			const has = (kind: string, surface: string): boolean => events.some((event) => event.kind === kind && event.surface === surface);
			return has("session.start", "omp") && has("note", "omp") && has("tool.call", "muse") && has("session.end", "omp");
		});
		const one = (kind: string, surface: string): QueryEvent[] => seen.filter((event) => event.kind === kind && event.surface === surface);
		check(one("session.start", "omp").length === 1, "exactly one session.start across the restart", `${one("session.start", "omp").length}`);
		const note = one("note", "omp")[0];
		check(note?.payload?.["status"] === "idle" && note?.payload?.["runtime"] === "herdr", "idle note carries runtime herdr");
		const tool = one("tool.call", "muse")[0];
		check(tool?.branch === "p19-tag", "muse tool.call carries the branch", String(tool?.branch ?? "missing"));
		const end = one("session.end", "omp")[0];
		check(end?.repo === slug, "herdr session.end carries the repo", String(end?.repo ?? "missing"));

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
		collector?.stop();
		server?.close();
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
