/**
 * Muse brief writer, against real temporary git repositories and a stubbed fetch.
 *
 * The writer must not call `/events`. Briefs are keyed by the origin slug.
 * A decoy token is assembled at runtime so no credential shape sits in git.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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
