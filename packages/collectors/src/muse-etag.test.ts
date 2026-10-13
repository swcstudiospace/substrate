/**
 * Muse brief writer, the ETag half (uplift-2 R1): the tag of the last 200 is
 * kept per repo, sent back as `If-None-Match`, and a 304 leaves `BRIEF.md`
 * untouched. Real temporary git repositories and a stubbed fetch, as in
 * `muse.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyState, fetchBrief, loadState, pass, saveState, type MuseState } from "./muse.ts";

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
	if (originalEnv.token === undefined) delete process.env.SUBSTRATE_TOKEN;
	else process.env.SUBSTRATE_TOKEN = originalEnv.token;
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
	made.length = 0;
});

function git(repo: string, args: string[]): string {
	const result = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(result.stderr.toString().slice(0, 400));
	return result.stdout.toString().trim();
}

function tempGit(): string {
	const dir = mkdtempSync(join(tmpdir(), "muse-etag-"));
	made.push(dir);
	git(dir, ["init", "-q", "--initial-branch=main"]);
	git(dir, ["config", "user.email", "test@example.invalid"]);
	git(dir, ["config", "user.name", "Substrate Test"]);
	writeFileSync(join(dir, "README.md"), "hello\n");
	git(dir, ["add", "README.md"]);
	git(dir, ["commit", "-q", "-m", "init"]);
	git(dir, ["remote", "add", "origin", "https://github.com/acme/widgets.git"]);
	return dir;
}

function arm(dir: string): MuseState {
	const statePath = `${dir}-muse-offsets.json`;
	made.push(statePath);
	process.env.SUBSTRATE_COLLECTOR_STATE = statePath;
	process.env.SUBSTRATE_URL = "http://127.0.0.1:9";
	process.stderr.write = (() => true) as typeof process.stderr.write;
	return emptyState();
}

interface BriefCall {
	ifNoneMatch: string | null;
}

/**
 * A server that answers `/brief` with `text` under `etag`, and 304 whenever the
 * request carries that tag. `calls` records what the writer sent.
 */
function stubServer(text: string, etag: string): { calls: BriefCall[]; setBrief: (text: string, etag: string) => void } {
	const calls: BriefCall[] = [];
	let current = { text, etag };
	globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("/healthz")) return new Response(JSON.stringify({ greptime: true }), { status: 200 });
		if (url.endsWith("/brief")) {
			const headers = new Headers(init?.headers);
			const ifNoneMatch = headers.get("if-none-match");
			calls.push({ ifNoneMatch });
			if (ifNoneMatch === current.etag) return new Response(null, { status: 304, headers: { etag: current.etag } });
			return new Response(current.text, { status: 200, headers: { etag: current.etag } });
		}
		return new Response("no", { status: 404 });
	}) as typeof fetch;
	return {
		calls,
		setBrief(nextText, nextEtag) {
			current = { text: nextText, etag: nextEtag };
		},
	};
}

const briefPath = (repo: string): string => join(repo, ".substrate", "BRIEF.md");

describe("muse writer and the brief ETag", () => {
	test("stores the tag of a 200, sends it back, and a 304 leaves BRIEF.md untouched", async () => {
		const repo = tempGit();
		const state = arm(repo);
		const server = stubServer("first brief", 'W/"aaaa"');

		await pass([repo], state, "2026-10-13T12:00:00.000Z");
		expect(server.calls[0]?.ifNoneMatch).toBeNull();
		expect(readFileSync(briefPath(repo), "utf8")).toBe("first brief");
		expect(state.repos[repo]?.etag).toBe('W/"aaaa"');
		expect(state.counters.unchanged).toBe(0);
		const saved = loadState(process.env.SUBSTRATE_COLLECTOR_STATE as string);

		const past = new Date("2020-01-01T00:00:00.000Z");
		utimesSync(briefPath(repo), past, past);
		await pass([repo], state, "2026-10-13T12:05:00.000Z");
		expect(server.calls[1]?.ifNoneMatch).toBe('W/"aaaa"');
		expect(statSync(briefPath(repo)).mtimeMs).toBe(past.getTime());
		expect(readFileSync(briefPath(repo), "utf8")).toBe("first brief");
		expect(state.counters.unchanged).toBe(1);
		expect(state.counters.fetch_failed).toBe(0);
		expect(state.repos[repo]?.last_success).toBe("2026-10-13T12:05:00.000Z");
		expect(state.repos[repo]?.etag).toBe('W/"aaaa"');

		// The brief changed on the server: a 200 with a new tag replaces the file and the tag.
		server.setBrief("second brief", 'W/"bbbb"');
		await pass([repo], state, "2026-10-13T12:10:00.000Z");
		expect(server.calls[2]?.ifNoneMatch).toBe('W/"aaaa"');
		expect(readFileSync(briefPath(repo), "utf8")).toBe("second brief");
		expect(state.repos[repo]?.etag).toBe('W/"bbbb"');
		expect(state.counters.unchanged).toBe(1);
		expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toContain("substrate-brief:start");
	});

	test("a deleted BRIEF.md is fetched in full: the tag is not sent while the file is gone", async () => {
		const repo = tempGit();
		const state = arm(repo);
		const server = stubServer("the brief", 'W/"cccc"');
		await pass([repo], state, "2026-10-13T12:00:00.000Z");
		unlinkSync(briefPath(repo));

		await pass([repo], state, "2026-10-13T12:05:00.000Z");
		expect(server.calls[1]?.ifNoneMatch).toBeNull();
		expect(existsSync(briefPath(repo))).toBe(true);
		expect(readFileSync(briefPath(repo), "utf8")).toBe("the brief");
		expect(state.counters.unchanged).toBe(0);
	});

	test("a server without ETags behaves as before: no tag stored, no header sent", async () => {
		const repo = tempGit();
		const state = arm(repo);
		const calls: Array<string | null> = [];
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/healthz")) return new Response(JSON.stringify({ greptime: true }), { status: 200 });
			calls.push(new Headers(init?.headers).get("if-none-match"));
			return new Response("plain", { status: 200 });
		}) as typeof fetch;
		await pass([repo], state, "2026-10-13T12:00:00.000Z");
		await pass([repo], state, "2026-10-13T12:05:00.000Z");
		expect(calls).toEqual([null, null]);
		expect(state.repos[repo]?.etag).toBeUndefined();
		expect(readFileSync(briefPath(repo), "utf8")).toBe("plain");
	});

	test("a 304 to a request that sent no tag is a failed fetch, and the state file round-trips the tag", async () => {
		process.env.SUBSTRATE_URL = "http://127.0.0.1:9";
		globalThis.fetch = (async () => new Response(null, { status: 304 })) as typeof fetch;
		expect(await fetchBrief("acme/widgets", "main")).toEqual({ ok: false, reason: "http_304" });
		expect(await fetchBrief("acme/widgets", "main", 'W/"dddd"')).toEqual({ ok: true, unchanged: true, etag: 'W/"dddd"' });

		const path = join(mkdtempSync(join(tmpdir(), "muse-etag-state-")), "muse-offsets.json");
		made.push(join(path, ".."));
		const state = emptyState();
		state.repos["/srv/a"] = { last_success: "2026-10-13T12:00:00.000Z", etag: 'W/"eeee"' };
		state.repos["/srv/b"] = { etag: "x".repeat(300) };
		saveState(state, path);
		const loaded = loadState(path);
		expect(loaded.repos["/srv/a"]?.etag).toBe('W/"eeee"');
		// An over-long tag is dropped rather than replayed.
		expect(loaded.repos["/srv/b"]?.etag).toBeUndefined();
		expect(loaded.counters.unchanged).toBe(0);
	});
});
