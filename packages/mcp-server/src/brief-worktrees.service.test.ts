/**
 * The brief's worktrees section through the service (phase 68, FLEET-06): the registry flag and the request decide whether
 * it exists, one candidate read feeds it, a failing read costs only this section, and it is in no cache key and no stored
 * snapshot. The registry is the in-memory adapter; the index is a fake. The pure matching rules are in
 * `brief-sessions.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { ReadThroughCache, type CacheRedis } from "./cache.ts";
import { loadConfig } from "./config.ts";
import { Substrate } from "./service.ts";
import { MemoryWorktreeRegistry } from "./worktree-registry-fake.ts";
import type { ReportedWorktree, WorktreeRegistryStore } from "./worktree-registry.ts";

class MapRedis implements CacheRedis {
	readonly values = new Map<string, string>();
	async get(key: string): Promise<string | null> {
		return this.values.get(key) ?? null;
	}
	async set(key: string, value: string): Promise<void> {
		this.values.set(key, value);
	}
	async incr(key: string): Promise<number> {
		const next = Number(this.values.get(key) ?? "0") + 1;
		this.values.set(key, String(next));
		return next;
	}
}

const ME = "sess-me";
const HOUR = 3_600_000;
const REGISTRY_ON = { SUBSTRATE_WORKTREE_REGISTRY: "on" };

const index = {
	getGraph: async () => ({
		graph_id: "ut-1",
		notion_task_page: null,
		repo: "acme/app",
		branch: null,
		surface: "cursor",
		status: "active",
		pr_url: null,
		created: null,
		updated: null,
		nodes: [],
		steps: [],
		edges: [],
	}),
	openGraphs: async () => [],
	memoryForBrief: async () => [],
};

function reported(path: string, overrides: Partial<ReportedWorktree> = {}): ReportedWorktree {
	return {
		path,
		repo: "acme/app",
		branch: "feature/x",
		head: "a".repeat(40),
		base: "b".repeat(40),
		dirty: true,
		ahead: 1,
		behind: 0,
		last_commit_at: null,
		size_bytes: null,
		locked: false,
		primary: false,
		pr_state: "none",
		...overrides,
	};
}

const OWN = reported("/w/mine", { session_id: ME, files: ["src/a.ts"] });
const OVERLAPPING = reported("/w/other", { session_id: "sess-other", files: ["src/a.ts", "src/q.ts"] });

async function seeded(host: string, rows: ReportedWorktree[], store = new MemoryWorktreeRegistry(), seenAt = new Date()): Promise<MemoryWorktreeRegistry> {
	await store.report({ host, reportedAt: seenAt, seenAt, ttlS: 30 * 86_400, worktrees: rows });
	return store;
}

function substrateWith(env: Record<string, string>, store: WorktreeRegistryStore | null, redis: CacheRedis = new MapRedis()): Substrate {
	const cache = new ReadThroughCache({ redis, enabled: true, log: () => {} });
	return new Substrate(loadConfig(env), { index: index as never, greptime: null, cache, worktrees: store, steering: { history: null, liveSessions: null } });
}

const request = { surface: "cursor" as const, repo: "acme/app", graph_id: "ut-1", session_id: ME };

describe("memory_brief with the worktree registry on", () => {
	test("names another session's worktree that shares a file, and only that: not the caller's own, an unattributed row, a quiet one, another repository's or one not seen for a day", async () => {
		const store = await seeded("host-1", [
			OWN,
			OVERLAPPING,
			reported("/w/quiet", { session_id: "sess-quiet", files: ["docs/x.md"] }),
			reported("/w/anon", { files: ["src/a.ts"] }),
			reported("/w/foreign", { repo: "someone/else", session_id: "sess-foreign", files: ["src/a.ts"] }),
		]);
		await seeded("host-old", [reported("/w/stale", { session_id: "sess-stale", files: ["src/a.ts"] })], store, new Date(Date.now() - 25 * HOUR));

		const detail = await substrateWith(REGISTRY_ON, store).briefDetailed(request);

		expect(detail.state).toBe("complete");
		expect(detail.text).toContain("host-1:/w/other");
		expect(detail.text).toContain("sess-other");
		expect(detail.text).toContain("overlap 1: src/a.ts");
		expect(detail.text).not.toContain("src/q.ts");
		for (const hidden of ["/w/mine", "/w/quiet", "/w/anon", "/w/foreign", "/w/stale"]) expect(detail.text).not.toContain(hidden);
		// One read for the whole brief, however many rows came back.
		expect(store.candidateReads).toBe(1);
	});

	test("a caller whose worktree has not reported its files gets the one line saying so", async () => {
		const store = await seeded("host-1", [OVERLAPPING]);
		const detail = await substrateWith(REGISTRY_ON, store).briefDetailed(request);
		expect(detail.text).toContain("your own worktree has not reported its files");
		expect(detail.text).not.toContain("/w/other");
	});

	test("registry off: no section and the registry is never read, even though the rows are there", async () => {
		const store = await seeded("host-1", [OWN, OVERLAPPING]);
		const detail = await substrateWith({}, store).briefDetailed(request);
		expect(detail.text).not.toContain("/w/other");
		expect(detail.text).not.toContain("your own worktree");
		expect(store.candidateReads).toBe(0);
	});

	test("no repository, no session or a blank session: no section and no read", async () => {
		const store = await seeded("host-1", [OWN, OVERLAPPING]);
		const substrate = substrateWith(REGISTRY_ON, store);
		const noRepo = { surface: "cursor" as const, graph_id: "ut-1", session_id: ME };
		for (const ask of [noRepo, { ...request, session_id: undefined }, { ...request, session_id: "" }]) {
			const detail = await substrate.briefDetailed(ask);
			expect(detail.text).not.toContain("/w/other");
		}
		expect(store.candidateReads).toBe(0);
	});

	test("a registry read that fails drops only this section, names the failure, leaks nothing of the error, and the brief stays complete", async () => {
		const broken: WorktreeRegistryStore = {
			report: async () => ({ stored: 0, removed: 0 }),
			list: async () => [],
			candidates: async () => {
				throw new Error("postgres is down: password=hunter2");
			},
		};
		const detail = await substrateWith(REGISTRY_ON, broken).briefDetailed(request);
		expect(detail.state).toBe("complete");
		expect(detail.failed).toEqual([]);
		expect(detail.text).toContain("Live worktrees not included: the read failed.");
		expect(detail.text).not.toContain("hunter2");
		expect(detail.text).toContain("ut-1");
	});

	test("the section is built for each request: it is in no cache entry and no stored snapshot, and a cached brief still shows today's overlap", async () => {
		const redis = new MapRedis();
		const store = await seeded("host-1", [OWN, OVERLAPPING]);
		const substrate = substrateWith(REGISTRY_ON, store, redis);

		const first = await substrate.briefDetailed(request);
		expect(first.text).toContain("/w/other");
		for (const value of redis.values.values()) {
			expect(value).not.toContain("/w/other");
			expect(value).not.toContain("sess-other");
		}

		// The other session moves off the shared file; the brief itself is a cache hit, the section is not.
		await seeded("host-1", [OWN, { ...OVERLAPPING, files: ["src/elsewhere.ts"] }], store);
		const second = await substrate.briefDetailed(request);
		expect(second.text).not.toContain("/w/other");
		expect(second.text).toContain("ut-1");
	});
});
