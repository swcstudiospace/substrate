/**
 * Muse brief writer, against temporary git repositories, fetch stubs and loopback HTTP.
 *
 * The writer must not call `/events`. Briefs are keyed by the origin slug.
 * A decoy token is assembled at runtime so no credential shape sits in git.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { redact } from "../../mcp-server/src/redact.ts";
import {
	briefPathFor,
	emptyState,
	ensurePointer,
	fetchBrief,
	ledgerAvailable,
	MARKER_END,
	MARKER_START,
	pass,
	pointerBlock,
	POLL_MS,
	repoList,
	type MuseState,
} from "./muse.ts";

const made: string[] = [];
const originalFetch = globalThis.fetch;
const originalWrite = process.stderr.write.bind(process.stderr);
const originalEnv = {
	state: process.env.SUBSTRATE_COLLECTOR_STATE,
	url: process.env.SUBSTRATE_URL,
	token: process.env.SUBSTRATE_TOKEN,
};

afterEach(() => {
	globalThis.fetch = originalFetch;
	process.stderr.write = originalWrite;
	if (originalEnv.state === undefined) delete process.env.SUBSTRATE_COLLECTOR_STATE;
	else process.env.SUBSTRATE_COLLECTOR_STATE = originalEnv.state;
	if (originalEnv.url === undefined) delete process.env.SUBSTRATE_URL;
	else process.env.SUBSTRATE_URL = originalEnv.url;
	const savedToken = originalEnv.token;
	if (savedToken === undefined) delete process.env.SUBSTRATE_TOKEN;
	else process.env.SUBSTRATE_TOKEN = savedToken;
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
	made.length = 0;
});

function git(repo: string, args: string[]): string {
	const result = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(result.stderr.toString().slice(0, 400));
	return result.stdout.toString().trim();
}

function tempGit(options: { origin?: string } = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "muse-writer-"));
	made.push(dir);
	git(dir, ["init", "-q", "--initial-branch=main"]);
	git(dir, ["config", "user.email", "test@example.invalid"]);
	git(dir, ["config", "user.name", "Substrate Test"]);
	writeFileSync(join(dir, "README.md"), "hello\n");
	git(dir, ["add", "README.md"]);
	git(dir, ["commit", "-q", "-m", "init"]);
	if (options.origin !== undefined) git(dir, ["remote", "add", "origin", options.origin]);
	return dir;
}

function arm(dir: string): { state: MuseState; logs: string[] } {
	const statePath = `${dir}-muse-offsets.json`;
	made.push(statePath);
	process.env.SUBSTRATE_COLLECTOR_STATE = statePath;
	process.env.SUBSTRATE_URL = "http://127.0.0.1:9";
	const logs: string[] = [];
	process.stderr.write = ((chunk: string | Uint8Array) => {
		logs.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	return { state: emptyState(), logs };
}

interface BriefCall {
	url: string;
	body: Record<string, unknown>;
	authorization: string | null;
}

function stubFetch(options: { brief?: string | null; status?: number; health?: boolean; throwBrief?: boolean } = {}): {
	briefs: BriefCall[];
	healthz: number;
	events: number;
} {
	const briefs: BriefCall[] = [];
	const counts = { healthz: 0, events: 0 };
	globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("/events")) {
			counts.events += 1;
			return new Response("{}", { status: 202 });
		}
		if (url.endsWith("/healthz")) {
			counts.healthz += 1;
			const greptime = options.health !== false;
			return new Response(JSON.stringify({ greptime }), { status: 200 });
		}
		if (url.endsWith("/brief")) {
			const headers = new Headers(init?.headers);
			briefs.push({
				url,
				body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
				authorization: headers.get("authorization"),
			});
			if (options.throwBrief) throw new Error("network down");
			if (options.brief === null) return new Response("", { status: options.status ?? 500 });
			return new Response(options.brief ?? "stub brief", { status: options.status ?? 200 });
		}
		return new Response("no", { status: 404 });
	}) as typeof fetch;
	return { briefs, ...counts, get healthz() { return counts.healthz; }, get events() { return counts.events; } };
}

function briefPath(repo: string): string {
	return join(repo, ".substrate", "BRIEF.md");
}

type WriterFault = "healthy" | "ledger-down" | "health-http" | "health-disconnect" | "brief-hung-headers" | "brief-hung-body";

function waitUntil(check: () => boolean, label: string, changes: EventEmitter, timeoutMs = 6_500): Promise<void> {
	// A watchdog bounds broken children; completion is event-driven, never a guessed sleep.
	const deadline = AbortSignal.timeout(timeoutMs);
	return new Promise<void>((resolve, reject) => {
		function cleanup() {
			changes.off("change", inspect);
			deadline.removeEventListener("abort", expired);
		}
		function expired() {
			cleanup();
			reject(new Error(`Timed out waiting for ${label}`));
		}
		function inspect() {
			try {
				if (!check()) return;
				cleanup();
				resolve();
			} catch (cause) {
				cleanup();
				reject(cause);
			}
		}
		changes.on("change", inspect);
		deadline.addEventListener("abort", expired, { once: true });
		inspect();
	});
}

function sourceBrief(sourcePath: string, branch: string): string {
	const source = JSON.parse(readFileSync(sourcePath, "utf8")) as { revision: number; summary: string };
	return `# acme/widgets (${branch})\nRevision ${source.revision}\n${source.summary}\n`;
}

/** Real sockets, including requests that never finish headers or their body. */
async function writerServer(sourcePath: string) {
	let fault: WriterFault = "healthy";
	const sockets = new Set<Socket>();
	const paths: string[] = [];
	const briefs: Array<Record<string, unknown>> = [];
	const authorizations: Array<string | undefined> = [];
	const changes = new EventEmitter();
	const server = createServer((request, response) => {
		paths.push(request.url ?? "");
		authorizations.push(request.headers.authorization);
		if (request.url === "/healthz") {
			if (fault === "health-disconnect") {
				request.socket.destroy();
				return;
			}
			response.writeHead(fault === "health-http" ? 503 : 200, { "content-type": "application/json" });
			response.end(JSON.stringify({ greptime: fault !== "ledger-down" }));
			return;
		}
		if (request.url === "/brief") {
			let body = "";
			request.setEncoding("utf8");
			request.on("data", (chunk: string) => { body += chunk; });
			request.on("end", () => {
				const input = JSON.parse(body) as Record<string, unknown>;
				briefs.push(input);
				changes.emit("change");
				if (fault === "brief-hung-headers") return;
				response.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
				if (fault === "brief-hung-body") {
					// A received 200 and nonempty prefix are NOT a complete good brief.
					response.write("INCOMPLETE RESPONSE THAT MUST NEVER REPLACE THE GOOD BRIEF\n");
					return;
				}
				response.end(sourceBrief(sourcePath, String(input.branch)));
			});
			return;
		}
		response.writeHead(request.url === "/events" ? 202 : 404);
		response.end("{}");
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => { sockets.delete(socket); });
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Loopback HTTP port missing");
	return {
		url: `http://127.0.0.1:${address.port}`,
		paths,
		briefs,
		authorizations,
		setFault(next: WriterFault) { fault = next; },
		async briefReceived(count: number) {
			await waitUntil(() => briefs.length >= count, `HTTP brief request ${count}`, changes);
		},
		async close() {
			const closed = new Promise<void>((resolve) => { server.close(() => resolve()); });
			for (const socket of sockets) socket.destroy();
			await closed;
		},
	};
}

interface ScratchWatch {
	readonly logs: string;
	waiting(count: number): Promise<void>;
	advance(ms: number): Promise<void>;
	close(): Promise<void>;
}

/** Only the child's sleep clock is virtual; HTTP and abort deadlines stay real. */
function scratchWatch(repo: string, url: string, statePath: string): ScratchWatch {
	const home = mkdtempSync(join(tmpdir(), "muse-watch-home-"));
	made.push(home);
	const preload = join(home, "clock.ts");
	writeFileSync(preload, `
const realSleep = Bun.sleep.bind(Bun);
let now = 0;
let pending: { deadline: number; resolve: () => void } | undefined;
Bun.sleep = ((delay: number | Date) => {
	if (typeof delay !== "number") return realSleep(delay);
	if (pending) throw new Error("Overlapping writer sleeps");
	return new Promise<void>((resolve) => {
		pending = { deadline: now + delay, resolve };
		process.stdout.write("muse-test:waiting:" + pending.deadline + "\\n");
	});
}) as typeof Bun.sleep;
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
	input += chunk;
	let newline: number;
	while ((newline = input.indexOf("\\n")) !== -1) {
		const advance = Number(input.slice(0, newline));
		input = input.slice(newline + 1);
		if (!Number.isFinite(advance) || advance < 0) throw new Error("Invalid clock advance");
		now += advance;
		if (pending && now >= pending.deadline) {
			const due = pending;
			pending = undefined;
			due.resolve();
		}
		process.stdout.write("muse-test:advanced:" + now + "\\n");
	}
});
`);
	const child = spawn(process.execPath, [
		"--no-env-file", "--preload", preload, new URL("./muse.ts", import.meta.url).pathname, "--watch",
	], {
		cwd: repo,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: home,
			TMPDIR: home,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			SUBSTRATE_MUSE_REPOS: repo,
			SUBSTRATE_URL: url,
			SUBSTRATE_COLLECTOR_STATE: statePath,
			SUBSTRATE_STATE_DIR: home,
			SUBSTRATE_TOKENS_DIR: join(home, "empty-tokens"),
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	let closed = false;
	let spawnError: Error | undefined;
	const changes = new EventEmitter();
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => { stdout += chunk; changes.emit("change"); });
	child.stderr.on("data", (chunk: string) => { stderr += chunk; changes.emit("change"); });
	child.on("error", (error) => { spawnError = error; changes.emit("change"); });
	child.on("close", () => { closed = true; changes.emit("change"); });
	function alive() {
		if (spawnError) throw spawnError;
		if (closed) throw new Error(`Writer exited before its checkpoint: ${stderr}`);
	}
	let clock = 0;
	return {
		get logs() { return stderr; },
		async waiting(count: number) {
			await waitUntil(() => {
				alive();
				return stdout.split("\n").filter((line) => line.startsWith("muse-test:waiting:")).length >= count;
			}, `writer scheduled sleep ${count}`, changes);
		},
		async advance(ms: number) {
			alive();
			clock += ms;
			child.stdin.write(`${ms}\n`);
			await waitUntil(() => {
				alive();
				return stdout.split("\n").includes(`muse-test:advanced:${clock}`);
			}, "child clock acknowledgement", changes);
		},
		async close() {
			if (!closed) child.kill("SIGKILL");
			await waitUntil(() => closed, "scratch writer shutdown", changes, 2_000);
		},
	};
}

function persistedMuseState(path: string): MuseState {
	return JSON.parse(readFileSync(path, "utf8")) as MuseState;
}

function expectOnePointer(repo: string): void {
	const agents = readFileSync(join(repo, "AGENTS.md"), "utf8");
	expect(agents.split(MARKER_START).length - 1).toBe(1);
	expect(agents.split(MARKER_END).length - 1).toBe(1);
	expect(agents).toContain(pointerBlock());
}

describe("repo list", () => {
	test("SUBSTRATE_MUSE_REPOS is required and relative entries are rejected", () => {
		expect(() => repoList(undefined)).toThrow(/SUBSTRATE_MUSE_REPOS is required/);
		expect(() => repoList("")).toThrow(/required/);
		expect(() => repoList("relative/repo")).toThrow(/absolute/);
		expect(repoList("/srv/a:/srv/b")).toEqual(["/srv/a", "/srv/b"]);
		expect(POLL_MS).toBe(300_000);
	});
});

describe("muse writer", () => {
	test("writes a redacted brief keyed by the origin slug and never calls /events", async () => {
		const repo = tempGit({ origin: "https://github.com/acme/widgets.git" });
		const { state } = arm(repo);
		const secret = `${"ts"}${"key-"}abcDEF123456ghiJKL`;
		const raw = `note token=${secret}`;
		process.env.SUBSTRATE_TOKEN = "tok";
		const seen = stubFetch({ brief: raw });
		const now = "2026-10-09T12:00:00.000Z";
		await pass([repo], state, now);

		expect(seen.events).toBe(0);
		expect(seen.healthz).toBe(1);
		expect(seen.briefs).toHaveLength(1);
		expect(seen.briefs[0]?.body).toEqual({ repo: "acme/widgets", branch: "main", surface: "muse" });
		expect(seen.briefs[0]?.authorization).toBe("Bearer tok");
		const written = readFileSync(briefPath(repo), "utf8");
		expect(written).toBe(redact(raw));
		expect(written).not.toContain(secret);
		expect(state.repos[repo]?.last_success).toBe(now);
		expect(state.counters.fetch_failed).toBe(0);
		const saved = JSON.parse(readFileSync(process.env.SUBSTRATE_COLLECTOR_STATE as string, "utf8")) as MuseState;
		expect(saved.repos[repo]?.last_success).toBe(now);
		expect(saved.counters).toMatchObject({ fetch_failed: 0, no_slug: 0 });
	});

	test("an unchanged brief is not rewritten", async () => {
		const repo = tempGit({ origin: "https://github.com/acme/widgets.git" });
		const { state } = arm(repo);
		stubFetch({ brief: "same" });
		await pass([repo], state, "2026-10-09T12:00:00.000Z");
		const past = new Date("2020-01-01T00:00:00.000Z");
		utimesSync(briefPath(repo), past, past);
		await pass([repo], state, "2026-10-09T12:05:00.000Z");
		expect(statSync(briefPath(repo)).mtimeMs).toBe(past.getTime());
	});

	test("every failed fetch leaves BRIEF.md byte-identical and still ensures the pointer", async () => {
		const repo = tempGit({ origin: "https://github.com/acme/widgets.git" });
		const { state, logs } = arm(repo);
		mkdirSync(join(repo, ".substrate"));
		writeFileSync(briefPath(repo), "OLD BRIEF");
		const modes: Array<{ label: string; options: Parameters<typeof stubFetch>[0]; reason: string }> = [
			{ label: "http", options: { brief: null, status: 500 }, reason: "http_500" },
			{ label: "empty", options: { brief: "", status: 200 }, reason: "empty" },
			{ label: "network", options: { throwBrief: true }, reason: "network" },
		];
		for (const mode of modes) {
			stubFetch(mode.options);
			const before = readFileSync(briefPath(repo));
			await pass([repo], state, "2026-10-09T12:00:00.000Z");
			expect(readFileSync(briefPath(repo))).toEqual(before);
			expect(logs.some((line) => line.includes(`fetch failed (${mode.reason})`))).toBe(true);
		}
		expect(state.counters.fetch_failed).toBe(modes.length);
		expect(state.repos[repo]?.last_failure).toBe("2026-10-09T12:00:00.000Z");
		const agents = readFileSync(join(repo, "AGENTS.md"), "utf8");
		expect(agents.split(MARKER_START).length - 1).toBe(1);
	});

	test("a down ledger writes no brief, counts ledger_unavailable, and still ensures the pointer", async () => {
		const repo = tempGit({ origin: "https://github.com/acme/widgets.git" });
		const { state, logs } = arm(repo);
		const seen = stubFetch({ health: false, brief: "should-not-land" });
		await pass([repo], state, "2026-10-09T12:00:00.000Z");
		expect(existsSync(briefPath(repo))).toBe(false);
		expect(seen.briefs).toHaveLength(0);
		expect(seen.healthz).toBe(1);
		expect(state.counters.fetch_failed).toBe(1);
		expect(logs.some((line) => line.includes("ledger_unavailable"))).toBe(true);
		expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toContain(MARKER_START);
	});

	test("one health check covers every repo in the pass", async () => {
		const a = tempGit({ origin: "https://github.com/acme/a.git" });
		const b = tempGit({ origin: "https://github.com/acme/b.git" });
		const { state } = arm(a);
		const seen = stubFetch({ brief: "x" });
		await pass([a, b], state, "2026-10-09T12:00:00.000Z");
		expect(seen.healthz).toBe(1);
		expect(seen.briefs.map((call) => call.body.repo)).toEqual(["acme/a", "acme/b"]);
		expect(seen.events).toBe(0);
	});

	test("a repo without an origin is skipped and counted no_slug", async () => {
		const repo = tempGit();
		const { state, logs } = arm(repo);
		const seen = stubFetch({ brief: "x" });
		await pass([repo], state, "2026-10-09T12:00:00.000Z");
		expect(seen.briefs).toHaveLength(0);
		expect(state.counters.no_slug).toBe(1);
		expect(existsSync(briefPath(repo))).toBe(false);
		expect(existsSync(join(repo, "AGENTS.md"))).toBe(false);
		expect(logs.some((line) => line.includes("no origin slug"))).toBe(true);
	});

	test("six runs leave one marker block, and a pre-existing file keeps its outside bytes", async () => {
		const repo = tempGit({ origin: "https://github.com/acme/widgets.git" });
		const { state } = arm(repo);
		const original = "# My Repo\n\nHand-written instructions that must survive.\n";
		writeFileSync(join(repo, "AGENTS.md"), original);
		for (let i = 0; i < 6; i++) {
			stubFetch({ brief: `brief ${i}` });
			await pass([repo], state, "2026-10-09T12:00:00.000Z");
		}
		const agents = readFileSync(join(repo, "AGENTS.md"), "utf8");
		expect(agents.split(MARKER_START).length - 1).toBe(1);
		expect(agents.split(MARKER_END).length - 1).toBe(1);
		expect(agents.startsWith(original)).toBe(true);
		expect(readFileSync(briefPath(repo), "utf8")).toBe("brief 5");
	});

	test("duplicate blocks collapse at the first and bytes outside them stay identical", async () => {
		const repo = tempGit({ origin: "https://github.com/acme/widgets.git" });
		const { state } = arm(repo);
		const head = "HEAD line\n";
		const middle = "MIDDLE line\n";
		const tail = "TAIL line\n";
		const stale = `${MARKER_START}\nold\n${MARKER_END}`;
		writeFileSync(join(repo, "AGENTS.md"), `${head}${stale}${middle}${stale}${tail}`);
		stubFetch({ brief: "fresh" });
		await pass([repo], state, "2026-10-09T12:00:00.000Z");
		const agents = readFileSync(join(repo, "AGENTS.md"), "utf8");
		expect(agents.split(MARKER_START).length - 1).toBe(1);
		expect(agents).toBe(`${head}${pointerBlock()}${middle}${tail}`);
	});

	test("an orphan start marker leaves AGENTS.md untouched", async () => {
		const repo = tempGit({ origin: "https://github.com/acme/widgets.git" });
		const { state, logs } = arm(repo);
		const original = `hello\n${MARKER_START}\nno end\n`;
		writeFileSync(join(repo, "AGENTS.md"), original);
		stubFetch({ brief: "fresh" });
		await pass([repo], state, "2026-10-09T12:00:00.000Z");
		expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toBe(original);
		expect(state.counters.orphan_pointer).toBe(1);
		expect(logs.some((line) => line.includes("orphan brief marker"))).toBe(true);
		expect(readFileSync(briefPath(repo), "utf8")).toBe("fresh");
	});

	test(".substrate is excluded locally, including in a linked worktree", async () => {
		const repo = tempGit({ origin: "https://github.com/acme/widgets.git" });
		const { state } = arm(repo);
		stubFetch({ brief: "fresh" });
		await pass([repo], state, "2026-10-09T12:00:00.000Z");
		expect(git(repo, ["check-ignore", ".substrate"])).toBe(".substrate");
		const mainExclude = git(repo, ["rev-parse", "--git-path", "info/exclude"]);
		const mainExcludePath = isAbsolute(mainExclude) ? mainExclude : resolve(repo, mainExclude);
		expect(readFileSync(mainExcludePath, "utf8")).toContain(".substrate/");
		expect(git(repo, ["status", "--porcelain"])).not.toContain(".substrate");

		const wtParent = mkdtempSync(join(tmpdir(), "muse-wt-"));
		made.push(wtParent);
		const wt = join(wtParent, "wt");
		git(repo, ["worktree", "add", "-q", "-b", "side", wt]);
		stubFetch({ brief: "worktree brief" });
		await pass([wt], state, "2026-10-09T12:00:00.000Z");
		// A linked worktree's `.git` is a file. The exclude path comes from git, so the
		// writer never treats that file as a directory. This git shares `info/exclude`
		// with the main repo; the proof is that check-ignore still holds there.
		expect(statSync(join(wt, ".git")).isFile()).toBe(true);
		expect(existsSync(join(wt, ".git", "info", "exclude"))).toBe(false);
		expect(git(wt, ["check-ignore", ".substrate"])).toBe(".substrate");
		expect(readFileSync(mainExcludePath, "utf8")).toContain(".substrate/");
	});

	test("ensurePointer on its own creates a missing file and does not duplicate", () => {
		const repo = tempGit({ origin: "https://github.com/acme/widgets.git" });
		const counters = emptyState().counters;
		expect(ensurePointer(repo, counters)).toBe("written");
		expect(ensurePointer(repo, counters)).toBe("unchanged");
		expect(readFileSync(join(repo, "AGENTS.md"), "utf8").split(MARKER_START).length - 1).toBe(1);
	});
	test("an unreadable AGENTS.md is left untouched instead of replaced", () => {
		const repo = tempGit({ origin: "https://github.com/acme/widgets.git" });
		const { logs } = arm(repo);
		mkdirSync(join(repo, "AGENTS.md"));
		const counters = emptyState().counters;
		expect(ensurePointer(repo, counters)).toBe("unchanged");
		expect(statSync(join(repo, "AGENTS.md")).isDirectory()).toBe(true);
		expect(counters.orphan_pointer).toBe(0);
		expect(logs.some((line) => line.includes("left untouched"))).toBe(true);
	});

	test("a linked .substrate refuses the brief and keeps the target untouched", async () => {
		const repo = tempGit({ origin: "https://github.com/acme/widgets.git" });
		const { state, logs } = arm(repo);
		stubFetch({ brief: "fresh brief" });
		const target = mkdtempSync(join(tmpdir(), "muse-brief-target-"));
		made.push(target);
		writeFileSync(join(target, "BRIEF.md"), "TARGET");
		symlinkSync(target, join(repo, ".substrate"));
		await pass([repo], state, "2026-10-09T12:00:00.000Z");
		expect(readFileSync(join(target, "BRIEF.md"), "utf8")).toBe("TARGET");
		expect(state.counters.fetch_failed).toBe(1);
		expect(logs.some((line) => line.includes("brief_dir_outside_repo"))).toBe(true);
	});

	test("briefPathFor accepts a real dir and rejects links", () => {
		const repo = tempGit({ origin: "https://github.com/acme/widgets.git" });
		mkdirSync(join(repo, ".substrate"));
		expect(briefPathFor(repo)).toBe(join(repo, ".substrate", "BRIEF.md"));
		rmSync(join(repo, ".substrate"), { recursive: true, force: true });
		const target = mkdtempSync(join(tmpdir(), "muse-brief-target-"));
		made.push(target);
		symlinkSync(target, join(repo, ".substrate"));
		expect(briefPathFor(repo)).toBeNull();
	});

	test("briefPathFor follows a linked repo root but still rejects a linked .substrate", () => {
		const repo = tempGit({ origin: "https://github.com/acme/widgets.git" });
		mkdirSync(join(repo, ".substrate"));
		const linkParent = mkdtempSync(join(tmpdir(), "muse-link-"));
		made.push(linkParent);
		const link = join(linkParent, "repo-link");
		symlinkSync(repo, link);
		expect(briefPathFor(link)).toBe(join(link, ".substrate", "BRIEF.md"));
		rmSync(join(repo, ".substrate"), { recursive: true, force: true });
		expect(briefPathFor(link)).toBe(join(link, ".substrate", "BRIEF.md"));
	});

	test("fetchBrief reports an empty body as a failure", async () => {
		process.env.SUBSTRATE_URL = "http://127.0.0.1:9";
		stubFetch({ brief: "", status: 200 });
		expect(await fetchBrief("acme/widgets", "main")).toEqual({ ok: false, reason: "empty" });
	});
});

describe("ledger gate", () => {
	test("healthz carries the bearer a token-gated server demands", async () => {
		process.env.SUBSTRATE_URL = "http://127.0.0.1:9";
		process.env.SUBSTRATE_TOKEN = "tok";
		let seen: string | null = "missing";
		let status = 401;
		globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			seen = new Headers(init?.headers).get("authorization");
			return new Response(JSON.stringify({ greptime: true }), { status });
		}) as typeof fetch;
		expect(await ledgerAvailable()).toBe(false);
		expect(seen).toBe("Bearer tok");
		status = 200;
		expect(await ledgerAvailable()).toBe(true);
	});

	test("healthz without the ledger flag stays unavailable", async () => {
		process.env.SUBSTRATE_URL = "http://127.0.0.1:9";
		delete process.env.SUBSTRATE_TOKEN;
		globalThis.fetch = (async (_input: Parameters<typeof fetch>[0]) => new Response(JSON.stringify({ greptime: false }), { status: 200 })) as typeof fetch;
		expect(await ledgerAvailable()).toBe(false);
	});
});

describe("Muse scheduled watch over real loopback HTTP", () => {
	test("a source change refreshes only at the scheduled deadline and restart retains state and one pointer", async () => {
		const repo = tempGit({ origin: "https://github.com/acme/widgets.git" });
		const sourcePath = join(repo, "ledger-source.json");
		const statePath = join(repo, "writer-state.json");
		const outside = "# Local instructions\n\nPreserve these bytes.\n";
		writeFileSync(join(repo, "AGENTS.md"), outside);
		const secret = `${"ts"}${"key-"}abcDEF123456ghiJKL`;
		writeFileSync(sourcePath, JSON.stringify({ revision: 1, summary: `First shared source\r\nToken: ${secret}` }));
		const seed = emptyState();
		seed.counters.fetch_failed = 7;
		seed.repos[repo] = { last_failure: "2026-10-08T12:00:00.000Z" };
		writeFileSync(statePath, JSON.stringify(seed));
		const server = await writerServer(sourcePath);
		let watch: ScratchWatch | undefined;
		try {
			watch = scratchWatch(repo, server.url, statePath);
			await watch.waiting(1);
			const initial = persistedMuseState(statePath);
			const oldBytes = readFileSync(briefPath(repo));
			const pointerBytes = readFileSync(join(repo, "AGENTS.md"));
			expect(oldBytes.toString("utf8")).toBe(redact(sourceBrief(sourcePath, "main")));
			expect(oldBytes.toString("utf8")).not.toContain(secret);
			expectOnePointer(repo);
			expect(pointerBytes.toString("utf8")).toBe(`${outside}\n${pointerBlock()}\n`);
			expect(initial.counters).toEqual(seed.counters);
			expect(initial.repos[repo]?.last_failure).toBe(seed.repos[repo]?.last_failure);
			expect(initial.repos[repo]?.last_success).toMatch(/^\d{4}-\d{2}-\d{2}T/);
			expect(server.briefs).toEqual([{ repo: "acme/widgets", branch: "main", surface: "muse" }]);

			const beforeDeadlineRequests = [...server.paths];
			// Change the HTTP source and git context, not the writer or its pass function.
			writeFileSync(sourcePath, JSON.stringify({ revision: 2, summary: "Another agent finished the build.\r\nFresh shared context." }));
			git(repo, ["switch", "-q", "-c", "scheduled-side"]);
			await watch.advance(299_999);
			expect(server.paths).toEqual(beforeDeadlineRequests);
			expect(readFileSync(briefPath(repo))).toEqual(oldBytes);
			expect(persistedMuseState(statePath)).toEqual(initial);

			await watch.advance(1);
			await watch.waiting(2);
			const refreshed = persistedMuseState(statePath);
			const expected = redact(sourceBrief(sourcePath, "scheduled-side"));
			expect(readFileSync(briefPath(repo), "utf8")).toBe(expected);
			expect(readFileSync(briefPath(repo))).not.toEqual(oldBytes);
			expect(refreshed.counters).toEqual(seed.counters);
			expect(refreshed.repos[repo]?.last_failure).toBe(seed.repos[repo]?.last_failure);
			expect(refreshed.repos[repo]?.last_success).not.toBe(initial.repos[repo]?.last_success);
			expect(server.briefs).toEqual([
				{ repo: "acme/widgets", branch: "main", surface: "muse" },
				{ repo: "acme/widgets", branch: "scheduled-side", surface: "muse" },
			]);
			expect(readFileSync(join(repo, "AGENTS.md"))).toEqual(pointerBytes);
			expectOnePointer(repo);

			await watch.close();
			watch = undefined;
			// A real new CLI process must consume the saved counters/timestamps.
			writeFileSync(sourcePath, JSON.stringify({ revision: 3, summary: "Source advanced while the writer was stopped." }));
			watch = scratchWatch(repo, server.url, statePath);
			await watch.waiting(1);
			const restarted = persistedMuseState(statePath);
			expect(readFileSync(briefPath(repo), "utf8")).toBe(redact(sourceBrief(sourcePath, "scheduled-side")));
			expect(restarted.counters).toEqual(refreshed.counters);
			expect(restarted.repos[repo]?.last_failure).toBe(refreshed.repos[repo]?.last_failure);
			expect(restarted.repos[repo]?.last_success).not.toBe(refreshed.repos[repo]?.last_success);
			expect(readFileSync(join(repo, "AGENTS.md"))).toEqual(pointerBytes);
			expectOnePointer(repo);
			expect(server.paths.filter((path) => path !== "/healthz" && path !== "/brief")).toEqual([]);
			expect(server.authorizations.every((authorization) => authorization === undefined)).toBe(true);
		} finally {
			try { await watch?.close(); } finally { await server.close(); }
		}
	}, 15_000);

	for (const fault of ["ledger-down", "health-http", "health-disconnect", "brief-hung-headers", "brief-hung-body"] as const) {
		test(`scheduled ${fault} preserves the exact good brief, pointer and persisted failure accounting without events`, async () => {
			const repo = tempGit({ origin: "https://github.com/acme/widgets.git" });
			const sourcePath = join(repo, "ledger-source.json");
			const statePath = join(repo, "writer-state.json");
			writeFileSync(sourcePath, JSON.stringify({ revision: 1, summary: "KNOWN GOOD BRIEF\r\nExact UTF-8 bytes: café — ready." }));
			writeFileSync(join(repo, "AGENTS.md"), "# Instructions outside the pointer must survive.\n");
			const server = await writerServer(sourcePath);
			let watch: ScratchWatch | undefined;
			try {
				watch = scratchWatch(repo, server.url, statePath);
				await watch.waiting(1);
				const good = persistedMuseState(statePath);
				const oldBytes = readFileSync(briefPath(repo));
				const pointerBytes = readFileSync(join(repo, "AGENTS.md"));
				expect(oldBytes.toString("utf8")).toBe(redact(sourceBrief(sourcePath, "main")));
				expect(good.counters.fetch_failed).toBe(0);
				expect(good.repos[repo]?.last_success).toMatch(/^\d{4}-\d{2}-\d{2}T/);
				expectOnePointer(repo);

				writeFileSync(sourcePath, JSON.stringify({ revision: 2, summary: "THIS NEW SOURCE MUST NOT LAND DURING THE OUTAGE." }));
				server.setFault(fault);
				const hungBrief = fault === "brief-hung-headers" || fault === "brief-hung-body";
				const started = performance.now();
				await watch.advance(300_000);
				if (hungBrief) {
					await server.briefReceived(2);
					expect(readFileSync(briefPath(repo))).toEqual(oldBytes);
					expect(persistedMuseState(statePath)).toEqual(good);
				}
				await watch.waiting(2);
				const elapsed = performance.now() - started;
				if (hungBrief) {
					// Real fetch abort is the behavior under test: virtualizing it would
					// conceal a broken timeout on headers or a partially received body.
					expect(elapsed).toBeGreaterThanOrEqual(2_500);
					expect(elapsed).toBeLessThan(6_500);
				}
				const failed = persistedMuseState(statePath);
				expect(readFileSync(briefPath(repo))).toEqual(oldBytes);
				expect(readFileSync(join(repo, "AGENTS.md"))).toEqual(pointerBytes);
				expectOnePointer(repo);
				expect(failed.counters).toEqual({ ...good.counters, fetch_failed: 1 });
				expect(failed.repos[repo]?.last_success).toBe(good.repos[repo]?.last_success);
				expect(failed.repos[repo]?.last_failure).toMatch(/^\d{4}-\d{2}-\d{2}T/);
				expect(watch.logs).toContain(`fetch failed (${hungBrief ? "network" : "ledger_unavailable"})`);
				expect(server.briefs).toHaveLength(hungBrief ? 2 : 1);
				expect(server.briefs.every((body) => body.repo === "acme/widgets" && body.branch === "main" && body.surface === "muse")).toBe(true);
				expect(server.paths.filter((path) => path !== "/healthz" && path !== "/brief")).toEqual([]);
				expect(server.authorizations.every((authorization) => authorization === undefined)).toBe(true);
			} finally {
				try { await watch?.close(); } finally { await server.close(); }
			}
		}, 15_000);
	}
});
