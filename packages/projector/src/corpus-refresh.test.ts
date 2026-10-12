/**
 * The skills-sync refresh leg: committed reads, call chunking and the
 * substrate post. Bytes come from git objects, never the working tree;
 * every post carries the refresh metadata; failures are reasons.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	chunkPages,
	collectCommittedPages,
	postCorpusRefresh,
	refreshLibraryCorpus,
	type CorpusPage,
	type FetchFn,
	type GitRunner,
} from "./corpus-refresh.ts";

const HEAD = "2222222222222222222222222222222222222222";

function stubGit(head: string, files: Record<string, { mode: string; size: number; body: string }>, fails?: Set<string>): GitRunner {
	return async (args) => {
		const [cmd, ...rest] = args;
		if (cmd === "rev-parse") return { code: 0, stdout: `${head}\n`, stderr: "" };
		if (cmd === "ls-tree") {
			const records = Object.entries(files)
				.map(([path, file]) => `${file.mode} blob deadbeef ${file.size}\t${path}`)
				.join("\0");
			return { code: 0, stdout: records, stderr: "" };
		}
		if (cmd === "cat-file") {
			const path = (rest[1] ?? "").replace(/^[^:]+:/, "");
			const found = files[path];
			if (!found || fails?.has(path)) return { code: 128, stdout: "", stderr: "fatal: not found" };
			return { code: 0, stdout: found.body, stderr: "" };
		}
		throw new Error(`unexpected git argv ${args.join(" ")}`);
	};
}

const SKILL_FILES = {
	"review/SKILL.md": { mode: "100644", size: 40, body: "# Review\n\nReview skills live here.\n" },
	"review/references/notes.md": { mode: "100644", size: 30, body: "# Notes\n\nReference notes.\n" },
	"stray/notes.md": { mode: "100644", size: 20, body: "# Stray\n\nNo skill here.\n" },
	"BadName/SKILL.md": { mode: "100644", size: 20, body: "# Bad\n\nInvalid name.\n" },
};

describe("collectCommittedPages", () => {
	test("reads SKILL.md plus references from the verified commit", async () => {
		const calls: string[][] = [];
		const runGit: GitRunner = async (args) => {
			calls.push([...args]);
			return stubGit(HEAD, SKILL_FILES)(args);
		};
		const collected = await collectCommittedPages(runGit, HEAD);
		if (!collected.ok) throw new Error(`expected corpus: ${collected.reason}`);
		expect(collected.pages.map((page) => page.path)).toEqual([
			"agent-skills/review/SKILL.md",
			"agent-skills/review/references/notes.md",
		]);
		expect(collected.pages.every((page) => page.source_url.startsWith("agent-skills://review/"))).toBe(true);
		expect(calls[0]).toEqual(["rev-parse", "HEAD"]);
		expect(calls[1]).toEqual(["ls-tree", "-r", "-l", "-z", HEAD]);
		expect(calls).toContainEqual(["cat-file", "-p", `${HEAD}:review/SKILL.md`]);
		expect(calls).toContainEqual(["cat-file", "-p", `${HEAD}:review/references/notes.md`]);
		expect(calls.some((call) => call.join(" ").includes("stray"))).toBe(false);
	});

	test("a moved HEAD refuses before any read", async () => {
		let reads = 0;
		const runGit: GitRunner = async (args) => {
			if (args[0] === "cat-file" || args[0] === "ls-tree") reads += 1;
			return stubGit("9999999999999999999999999999999999999999", SKILL_FILES)(args);
		};
		const collected = await collectCommittedPages(runGit, HEAD);
		if (collected.ok) throw new Error("expected a refusal");
		expect(collected.reason).toBe("head-changed");
		expect(reads).toBe(0);
	});

	test("symlinks, oversize blobs and empty trees refuse before any read", async () => {
		const linked = await collectCommittedPages(
			stubGit(HEAD, { ...SKILL_FILES, "review/references/link.md": { mode: "120000", size: 10, body: "SKILL.md" } }),
			HEAD,
		);
		if (linked.ok) throw new Error("expected a refusal");
		expect(linked.reason).toBe("corpus-refused");

		const huge = await collectCommittedPages(
			stubGit(HEAD, { ...SKILL_FILES, "review/references/big.md": { mode: "100644", size: 1_000_001, body: "big" } }),
			HEAD,
		);
		if (huge.ok) throw new Error("expected a refusal");
		expect(huge.reason).toBe("corpus-refused");

		const empty = await collectCommittedPages(stubGit(HEAD, { "stray/notes.md": { mode: "100644", size: 5, body: "x" } }), HEAD);
		if (empty.ok) throw new Error("expected a refusal");
		expect(empty.reason).toBe("empty-corpus");
	});

	test("an unreadable blob fails the run, not a partial corpus", async () => {
		const collected = await collectCommittedPages(
			stubGit(HEAD, SKILL_FILES, new Set(["review/references/notes.md"])),
			HEAD,
		);
		if (collected.ok) throw new Error("expected a failure");
		expect(collected.reason).toBe("blob-unreadable");
	});
});

describe("chunkPages", () => {
	test("packs bodies under the per-call cap", () => {
		const page = (name: string, bytes: number): CorpusPage => ({
			path: `agent-skills/review/${name}`,
			source_url: `agent-skills://review/${name}`,
			body: `x${"y".repeat(bytes - 1)}`,
		});
		const chunks = chunkPages([page("a.md", 3_000_000), page("b.md", 3_000_000), page("c.md", 10)]);
		expect(chunks).toHaveLength(2);
		expect(chunks[0]?.map((entry) => entry.path)).toEqual(["agent-skills/review/a.md"]);
		expect(chunks[1]?.map((entry) => entry.path)).toEqual(["agent-skills/review/b.md", "agent-skills/review/c.md"]);
	});
});

interface Posted {
	url: string;
	authorization: string | null;
	body: unknown;
}

function stubFetch(posted: Posted[], reply: { status: number; body: unknown }): FetchFn {
	return async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const headers = new Headers(init?.headers);
		let body: unknown = null;
		try {
			body = init?.body ? JSON.parse(String(init.body)) : null;
		} catch {
			body = init?.body;
		}
		posted.push({ url, authorization: headers.get("authorization"), body });
		return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
	};
}

function postedBody(call: Posted | undefined): unknown {
	if (!call || typeof call.body !== "object" || call.body === null) throw new Error("the refresh posted no body");
	return call.body;
}

describe("postCorpusRefresh", () => {
	const page: CorpusPage = { path: "agent-skills/review/SKILL.md", source_url: "agent-skills://review/SKILL.md", body: "Hello.\n" };
	const meta = { id: "skills-sync:abc123", trigger: "skills-sync" as const };

	test("every chunk carries the refresh metadata with part numbering", async () => {
		const posted: Posted[] = [];
		const big: CorpusPage = { ...page, path: "agent-skills/review/a.md", body: `x${"y".repeat(3_000_000)}` };
		const other: CorpusPage = { ...page, path: "agent-skills/review/b.md", body: `x${"y".repeat(3_000_000)}` };
		const outcome = await postCorpusRefresh({
			url: "http://127.0.0.1:7410",
			token: "tok-sync",
			dataset: "agent-skills",
			commit: "abc123",
			pages: [big, other],
			refresh: meta,
			fetchImpl: stubFetch(posted, { status: 200, body: { ok: true, results: [{ status: "ingested" }] } }),
		});
		expect(outcome).toEqual({ ok: true, stored: 2 });
		expect(posted).toHaveLength(2);
		expect(posted[0]?.authorization).toBe("Bearer tok-sync");
		expect(postedBody(posted[0])).toMatchObject({
			dataset: "agent-skills",
			commit: "abc123",
			session_id: "skills-sync:abc123",
			refresh: { id: "skills-sync:abc123", part: 1, parts: 2, trigger: "skills-sync" },
		});
		expect(postedBody(posted[1])).toMatchObject({ refresh: { id: "skills-sync:abc123", part: 2, parts: 2, trigger: "skills-sync" } });
	});

	test("missing bearer, empty corpus, 5xx and malformed replies are reasons", async () => {
		const posted: Posted[] = [];
		const base = {
			url: "http://127.0.0.1:7410",
			token: "tok-sync",
			dataset: "agent-skills",
			commit: "abc123",
			pages: [page],
			refresh: meta,
		};
		expect(await postCorpusRefresh({ ...base, token: undefined, fetchImpl: stubFetch(posted, { status: 200, body: {} }) })).toEqual({
			ok: false,
			reason: "no-bearer",
		});
		expect(await postCorpusRefresh({ ...base, pages: [], fetchImpl: stubFetch(posted, { status: 200, body: {} }) })).toEqual({
			ok: false,
			reason: "empty-corpus",
		});
		expect(
			await postCorpusRefresh({ ...base, fetchImpl: stubFetch(posted, { status: 500, body: { ok: false } }) }),
		).toEqual({ ok: false, reason: "http-500" });
		expect(await postCorpusRefresh({ ...base, fetchImpl: stubFetch(posted, { status: 200, body: { ok: true } }) })).toEqual({
			ok: false,
			reason: "bad-reply",
		});
		expect(posted).toHaveLength(2);
	});

	test("a 200 whose results do not match the chunk is a bad reply, not a partial success", async () => {
		const posted: Posted[] = [];
		const two: CorpusPage[] = [
			{ ...page, path: "agent-skills/review/a.md", source_url: "agent-skills://review/a.md" },
			{ ...page, path: "agent-skills/review/b.md", source_url: "agent-skills://review/b.md" },
		];
		const base = {
			url: "http://127.0.0.1:7410",
			token: "tok-sync",
			dataset: "agent-skills",
			commit: "abc123",
			pages: two,
			refresh: meta,
		};
		expect(
			await postCorpusRefresh({ ...base, fetchImpl: stubFetch(posted, { status: 200, body: { ok: true, results: [{ status: "ingested" }] } }) }),
		).toEqual({ ok: false, reason: "bad-reply" });
		expect(
			await postCorpusRefresh({ ...base, fetchImpl: stubFetch(posted, { status: 200, body: { ok: true, results: [{ status: "stored" }] } }) }),
		).toEqual({ ok: false, reason: "bad-reply" });
		expect(
			await postCorpusRefresh({ ...base, fetchImpl: stubFetch(posted, { status: 200, body: { ok: false, results: [] } }) }),
		).toEqual({ ok: false, reason: "bad-reply" });
	});

	test("a silent server is a reason, not a throw", async () => {
		const refusing: FetchFn = async () => {
			throw new Error("connect ECONNREFUSED");
		};
		expect(
			await postCorpusRefresh({
				url: "http://127.0.0.1:7410",
				token: "tok-sync",
				dataset: "agent-skills",
				commit: HEAD,
				pages: [page],
				refresh: meta,
				fetchImpl: refusing,
			}),
		).toEqual({ ok: false, reason: "no-answer" });
	});
});

describe("refreshLibraryCorpus", () => {
	test("posts the verified commit with the skills-sync marker", async () => {
		const posted: Posted[] = [];
		const outcome = await refreshLibraryCorpus({
			libraryDir: "/tmp/lib",
			commit: HEAD,
			runGit: stubGit(HEAD, SKILL_FILES),
			url: "http://127.0.0.1:7410",
			token: "tok-sync",
			fetchImpl: stubFetch(posted, { status: 200, body: { ok: true, results: [{ status: "ingested" }, { status: "ingested" }] } }),
		});
		expect(outcome).toEqual({ ok: true, stored: 2 });
		expect(posted).toHaveLength(1);
		expect(postedBody(posted[0])).toMatchObject({
			dataset: "agent-skills",
			commit: HEAD,
			refresh: { id: `skills-sync:${HEAD}`, part: 1, parts: 1, trigger: "skills-sync" },
		});
	});

	test("a moved HEAD and a missing bearer stay visible", async () => {
		const posted: Posted[] = [];
		expect(
			await refreshLibraryCorpus({
				libraryDir: "/tmp/lib",
				commit: HEAD,
				runGit: stubGit("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", SKILL_FILES),
				url: "http://127.0.0.1:7410",
				token: "tok-sync",
				fetchImpl: stubFetch(posted, { status: 200, body: { ok: true, results: [] } }),
			}),
		).toEqual({ ok: false, reason: "head-changed", detail: "aaaaaaaaaaaa" });
		expect(posted).toHaveLength(0);

		const savedUnit = process.env.SUBSTRATE_TOKEN_SUBSTRATE;
		const savedToken = process.env.SUBSTRATE_TOKEN;
		delete process.env.SUBSTRATE_TOKEN_SUBSTRATE;
		delete process.env.SUBSTRATE_TOKEN;
		try {
			expect(
				await refreshLibraryCorpus({
					libraryDir: "/tmp/lib",
					commit: HEAD,
					runGit: stubGit(HEAD, SKILL_FILES),
					url: "http://127.0.0.1:7410",
					fetchImpl: stubFetch(posted, { status: 200, body: { ok: true, results: [] } }),
				}),
			).toEqual({ ok: false, reason: "no-bearer" });
		} finally {
			if (savedUnit !== undefined) process.env.SUBSTRATE_TOKEN_SUBSTRATE = savedUnit;
			if (savedToken !== undefined) process.env.SUBSTRATE_TOKEN = savedToken;
		}
		expect(posted).toHaveLength(0);
	});

});
