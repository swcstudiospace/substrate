/**
 * Phase 72: the graph, docs, ledger, memory and lease doors at the service boundary. `claude-code` is granted `owner/a` only.
 * Each test names the boundary it proves and asserts that nothing outside the grant is read or written.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { MemoryVerifyError } from "./memory-verify.ts";
import { REPO_REGISTRY_ENV, REPO_SCOPES_ENV } from "./repo-scope.ts";
import { type LinkedMemoryEntry, Substrate } from "./service.ts";

function scopedEnv(): Record<string, string | undefined> {
	const dirA = mkdtempSync(join(tmpdir(), "rw-a-"));
	const dirB = mkdtempSync(join(tmpdir(), "rw-b-"));
	return {
		[REPO_REGISTRY_ENV]: JSON.stringify({ "owner/a": { checkouts: [dirA], worktrees: [] }, "owner/b": { checkouts: [dirB], worktrees: [] } }),
		[REPO_SCOPES_ENV]: JSON.stringify({ "claude-code": ["owner/a"] }),
	};
}

/** An index that answers the graph row and the reaper, and counts every call, so a test can see what was read. */
function countingIndex(graphs: Record<string, { repo: string | null }>) {
	const calls: string[] = [];
	const reaped: string[] = [];
	const index = {
		getGraph: async (graphId: string) => {
			calls.push(`getGraph:${graphId}`);
			const row = graphs[graphId];
			return row === undefined ? null : { graph_id: graphId, repo: row.repo, nodes: [], steps: [], edges: [] };
		},
		reapExpiredLeases: async (repo: string | null) => {
			calls.push(`reap:${repo}`);
			reaped.push(repo ?? "*");
			return [];
		},
		// No live-session authority: the constructor reads this member on every index, and these tests never reach discovery.
		liveSessions: () => null,
	};
	return { index, calls, reaped };
}

const SURFACE = "claude-code" as const;

describe("graph reads (criterion 2: a graph's repository is resolved before its content is read)", () => {
	test("boundary: a graph whose repository is not granted is refused, and only its row is read", async () => {
		const { index, calls } = countingIndex({ "ut-b": { repo: "owner/b" } });
		const substrate = new Substrate(loadConfig(scopedEnv()), { index: index as never, greptime: null });
		calls.length = 0;
		const refused = await substrate.scopedGraphRefusal("graph_get", SURFACE, "ut-b");
		expect(refused).toMatchObject({ ok: false, status: 403, body: { error: "repo-not-granted" } });
		expect(calls).toEqual(["getGraph:ut-b"]);
	});

	test("boundary: a graph with no resolvable repository is refused under scope", async () => {
		const { index } = countingIndex({ "ut-none": { repo: null } });
		const substrate = new Substrate(loadConfig(scopedEnv()), { index: index as never, greptime: null });
		expect(await substrate.scopedGraphRefusal("graph_get", SURFACE, "ut-none")).toMatchObject({ body: { error: "graph-repo-unresolved" } });
		expect(await substrate.scopedGraphRefusal("graph_get", SURFACE, "ut-unknown")).toMatchObject({ body: { error: "graph-repo-unresolved" } });
	});

	test("a granted graph passes; scoping off passes every graph without reading it", async () => {
		const { index, calls } = countingIndex({ "ut-a": { repo: "owner/a" } });
		const scoped = new Substrate(loadConfig(scopedEnv()), { index: index as never, greptime: null });
		expect(await scoped.scopedGraphRefusal("graph_get", SURFACE, "ut-a")).toBeNull();
		const off = new Substrate(loadConfig({}), { index: index as never, greptime: null });
		calls.length = 0;
		expect(await off.scopedGraphRefusal("graph_get", SURFACE, "ut-b")).toBeNull();
		expect(calls).toHaveLength(0);
	});

	test("boundary: a brief that names a granted repository but a graph of another repository is refused", async () => {
		const { index } = countingIndex({ "ut-b": { repo: "owner/b" } });
		const substrate = new Substrate(loadConfig(scopedEnv()), { index: index as never, greptime: null });
		expect(await substrate.scopedBriefRefusal(SURFACE, { repo: "owner/a", graph_id: "ut-b" })).toMatchObject({ body: { error: "graph-repo-mismatch" } });
	});
});

describe("docs (criterion 2: the docs corpus spans every repository, so a scoped caller is refused)", () => {
	test("boundary: docs search is refused to a scoped surface, named or not, and the Hindsight fallback with it", async () => {
		const substrate = new Substrate(loadConfig(scopedEnv()), { index: null, greptime: null });
		expect(await substrate.scopedDocsRefusal("docs_search", SURFACE)).toMatchObject({ status: 403, body: { error: "all-repos-not-granted" } });
		expect(await substrate.scopedDocsRefusal("docs_search", null)).toMatchObject({ status: 403 });
		expect(await new Substrate(loadConfig({}), { index: null, greptime: null }).scopedDocsRefusal("docs_search", SURFACE)).toBeNull();
	});
});

describe("ledger reads (criterion 2: rows outside the grant are dropped before the reply)", () => {
	test("boundary: a named repository outside the grant is refused, and the ledger is not queried", async () => {
		const substrate = new Substrate(loadConfig(scopedEnv()), { index: null, greptime: null });
		const query = spyOn(substrate, "queryEvents");
		const outcome = await substrate.queryEventsFor({ repo: "owner/b" }, SURFACE);
		expect(outcome).toMatchObject({ ok: false, status: 403, body: { error: "repo-not-granted" } });
		expect(query).not.toHaveBeenCalled();
		query.mockRestore();
	});

	test("boundary: a named query returns only rows of granted repositories; rows with no repository are dropped", async () => {
		const substrate = new Substrate(loadConfig(scopedEnv()), { index: null, greptime: null });
		const rows = [
			{ id: "e1", repo: "owner/a" },
			{ id: "e2", repo: "owner/b" },
			{ id: "e3", repo: null },
		];
		spyOn(substrate, "queryEvents").mockResolvedValue({ events: rows as never, count: 3, truncated: false });
		const outcome = await substrate.queryEventsFor({ repo: "owner/a" }, SURFACE);
		expect(outcome.ok && outcome.result.events.map((event) => event.id)).toEqual(["e1"]);
		expect(outcome.ok && outcome.result.count).toBe(1);
	});

	test("boundary: a caller not granted the named repository reads no ledger rows at all", async () => {
		const substrate = new Substrate(loadConfig(scopedEnv()), { index: null, greptime: null });
		const query = spyOn(substrate, "queryEvents");
		expect(await substrate.queryEventsFor({ repo: "owner/a" }, "cursor")).toMatchObject({ ok: false, body: { error: "repo-not-granted" } });
		expect(query).not.toHaveBeenCalled();
		query.mockRestore();
	});
});

/** A memory entry as the reply carries it, with every required field set; only the id and scope vary by case. */
function memory(id: string, scope: string): LinkedMemoryEntry {
	return {
		id,
		scope,
		text: id,
		kind: "fact",
		writer: "claude-code",
		actor: "agent",
		trust: "agent-claimed",
		ttl: "30d",
		created: "2026-11-01T00:00:00.000Z",
		version: 1,
		entry_hash: "0".repeat(64),
		needs_reverification: false,
	};
}

describe("memory (criterion 2: memory rows outside the grant are dropped before the reply)", () => {
	test("boundary: entries scoped to another repository, and graphs of another repository, are removed; the rest stay", async () => {
		const { index } = countingIndex({ "ut-b": { repo: "owner/b" }, "ut-a": { repo: "owner/a" } });
		const substrate = new Substrate(loadConfig(scopedEnv()), { index: index as never, greptime: null });
		const reply = {
			entries: [
				{ ...memory("m1", "repo:owner/b"), causal_chain: [] },
				{ ...memory("m2", "repo:owner/a"), causal_chain: [] },
				memory("m3", "graph:ut-b"),
				memory("m4", "graph:ut-a"),
				memory("m5", "global"),
			],
			graph_links: [
				{ graph_id: "ut-b", events: [] },
				{ graph_id: "ut-a", events: [] },
			],
		};
		const filtered = await substrate.memoryReplyInGrant(reply, SURFACE);
		expect(filtered.entries.map((entry) => entry.id)).toEqual(["m2", "m4", "m5"]);
		expect(filtered.graph_links?.map((link) => link.graph_id)).toEqual(["ut-a"]);
		expect(filtered.entries.every((entry) => !("causal_chain" in entry))).toBe(true);
	});

	test("boundary: a memory row whose own repository is ungranted is dropped even under a global scope; the granted row stays", async () => {
		const { index } = countingIndex({});
		const substrate = new Substrate(loadConfig(scopedEnv()), { index: index as never, greptime: null });
		const reply = { entries: [{ ...memory("m6", "global"), repo: "owner/b" }, { ...memory("m7", "global"), repo: "owner/a" }] };
		const filtered = await substrate.memoryReplyInGrant(reply, SURFACE);
		expect(filtered.entries.map((entry) => entry.id)).toEqual(["m7"]);
	});

	test("boundary: a brief's memory read carries the caller's grant, so a row of an ungranted repository is never read into the brief", async () => {
		const reads: Array<{ granted?: (repo: string) => boolean }> = [];
		const { index } = countingIndex({});
		const briefIndex = {
			...index,
			openGraphs: async () => [],
			memoryForBrief: async (_repo: unknown, _graphId: unknown, _limit: unknown, read?: { granted?: (repo: string) => boolean }) => {
				reads.push(read ?? {});
				return [];
			},
		};
		const substrate = new Substrate(loadConfig(scopedEnv()), { index: briefIndex as never, greptime: null });
		await substrate.briefDetailed({ repo: "owner/a", surface: SURFACE });
		const granted = reads[0]?.granted;
		expect(granted?.("owner/a")).toBe(true);
		expect(granted?.("owner/b")).toBe(false);
	});
});

describe("memory verify (criterion 2: the reader's repository must be granted before the index is read)", () => {
	test("boundary: verifying an entry as an ungranted repository is refused as an unknown id, and the index is not touched", async () => {
		let touched = 0;
		const { index } = countingIndex({});
		const counted = new Proxy(index, {
			get(target, property, receiver) {
				touched += 1;
				return Reflect.get(target, property, receiver);
			},
		});
		const scoped = new Substrate(loadConfig(scopedEnv()), { index: counted as never, greptime: null });
		touched = 0;
		await expect(scoped.memoryVerify("mem-1", { surface: SURFACE, repo: "owner/b", isOperator: false })).rejects.toBeInstanceOf(MemoryVerifyError);
		expect(touched).toBe(0);
	});

	test("boundary: an entry in an ungranted repository is answered as an unknown id, and its content is never read", async () => {
		const { index } = countingIndex({});
		const stored = { ...memory("mem-1", "global"), repo: "owner/b" };
		const reads: string[] = [];
		const hidden = new Proxy(stored, {
			get(target, property, receiver) {
				reads.push(String(property));
				return Reflect.get(target, property, receiver);
			},
		});
		const caller = { surface: SURFACE, repo: "owner/a", isOperator: false };
		const withRow = new Substrate(loadConfig(scopedEnv()), { index: { ...index, readEntry: async () => hidden } as never, greptime: null });
		const withoutRow = new Substrate(loadConfig(scopedEnv()), { index: { ...index, readEntry: async () => null } as never, greptime: null });
		const hiddenAnswer = await withRow.memoryVerify("mem-1", caller).catch((cause: unknown) => cause);
		const unknownAnswer = await withoutRow.memoryVerify("mem-1", caller).catch((cause: unknown) => cause);
		expect(hiddenAnswer).toBeInstanceOf(MemoryVerifyError);
		expect(unknownAnswer).toBeInstanceOf(MemoryVerifyError);
		expect((hiddenAnswer as MemoryVerifyError).rule).toBe("not_found");
		expect((hiddenAnswer as MemoryVerifyError).message).toBe((unknownAnswer as MemoryVerifyError).message);
		// Only the row's scope and repository decide that it is ungranted; `then` is read by the promise that returns it. Its text, hash and anchor are never read.
		expect(reads.filter((property) => property !== "scope" && property !== "repo" && property !== "then")).toEqual([]);
	});

	test("positive control: an entry in a granted repository reaches the verifier, not the absent answer", async () => {
		const { index } = countingIndex({});
		const granted = { ...memory("mem-2", "global"), repo: "owner/a" };
		const substrate = new Substrate(loadConfig(scopedEnv()), { index: { ...index, readEntry: async () => granted } as never, greptime: null });
		const result = await substrate.memoryVerify("mem-2", { surface: SURFACE, repo: "owner/a", isOperator: false });
		expect(result.status).toBe("hash-mismatch");
	});
});

describe("writes (criterion 4: a write whose target repository is not granted is refused before it is written)", () => {
	test("boundary: an event or graph registration naming an ungranted repository is refused", async () => {
		const { index } = countingIndex({});
		const substrate = new Substrate(loadConfig(scopedEnv()), { index: index as never, greptime: null });
		expect(await substrate.scopedWriteRefusal("events_emit", SURFACE, { repo: "owner/b" })).toMatchObject({ body: { error: "repo-not-granted" } });
		expect(await substrate.scopedWriteRefusal("graph_register", SURFACE, { repo: "owner/a" })).toBeNull();
	});

	test("boundary: a write with no target repository, or a graph that does not resolve, is refused under scope", async () => {
		const { index } = countingIndex({});
		const substrate = new Substrate(loadConfig(scopedEnv()), { index: index as never, greptime: null });
		expect(await substrate.scopedWriteRefusal("events_emit", SURFACE, {})).toMatchObject({ body: { error: "all-repos-not-granted" } });
		expect(await substrate.scopedWriteRefusal("events_emit", SURFACE, { graph_id: "ut-missing" })).toMatchObject({ body: { error: "graph-repo-unresolved" } });
	});
});

describe("lease reaper (criterion 5: an unnamed reap reaches every graph, so it is confined to the grant)", () => {
	test("boundary: a named repository outside the grant reaps nothing, and an unnamed reap reaps only granted repositories", async () => {
		const { index, reaped } = countingIndex({});
		const substrate = new Substrate(loadConfig(scopedEnv()), { index: index as never, greptime: null });
		reaped.length = 0;
		expect(await substrate.reapExpiredLeases("owner/b", SURFACE)).toEqual([]);
		expect(reaped).toEqual([]);
		expect(await substrate.reapExpiredLeases(null, SURFACE)).toEqual([]);
		expect(reaped).toEqual(["owner/a"]);
	});
});

describe("review findings at the service boundary", () => {
	test("RS-04: a lease tool on a graph of an ungranted repository is refused, and only the graph row is read", async () => {
		const { index, calls } = countingIndex({ "ut-b": { repo: "owner/b" } });
		const substrate = new Substrate(loadConfig(scopedEnv()), { index: index as never, greptime: null });
		calls.length = 0;
		for (const tool of ["graph_claim", "graph_heartbeat", "graph_release", "graph_complete"]) {
			expect(await substrate.scopedGraphRefusal(tool, SURFACE, "ut-b")).toMatchObject({ body: { error: "repo-not-granted" } });
		}
		expect(calls.every((call) => call === "getGraph:ut-b")).toBe(true);
	});

	test("RS-05: a named repository with a named graph recorded under another repository is refused before the write", async () => {
		const { index } = countingIndex({ "ut-b": { repo: "owner/b" } });
		const substrate = new Substrate(loadConfig(scopedEnv()), { index: index as never, greptime: null });
		expect(await substrate.scopedWriteRefusal("events_emit", SURFACE, { repo: "owner/a", graph_id: "ut-b" })).toMatchObject({ body: { error: "graph-repo-mismatch" } });
		expect(await substrate.scopedWriteRefusal("graph_register", SURFACE, { repo: "owner/a", graph_id: "ut-new" })).toBeNull();
	});

	test("RS-06: a handoff naming a granted repository and a graph of another repository is refused", async () => {
		const { index } = countingIndex({ "ut-b": { repo: "owner/b" } });
		const substrate = new Substrate(loadConfig(scopedEnv()), { index: index as never, greptime: null });
		expect(await substrate.scopedWriteRefusal("handoff", SURFACE, { repo: "owner/a", graph_id: "ut-b" })).toMatchObject({ body: { error: "graph-repo-mismatch" } });
	});

	test("RS-16: an unnamed ledger read is refused, so the store is never asked for another repository's rows", async () => {
		const substrate = new Substrate(loadConfig(scopedEnv()), { index: null, greptime: null });
		const query = spyOn(substrate, "queryEvents");
		expect(await substrate.queryEventsFor({}, SURFACE)).toMatchObject({ ok: false, body: { error: "all-repos-not-granted" } });
		expect(query).not.toHaveBeenCalled();
		query.mockRestore();
	});
});
