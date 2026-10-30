import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, renameSync, rmSync } from "node:fs";
import {
	CORPUS_PROTOCOL,
	defaultGitBytesRunner,
	type CorpusIngestRequest,
	type CorpusPlanRequest,
	type CorpusPlanResponse,
	type PlanAction,
	type PlanItem,
} from "@substrate/corpus";
import { commitAll, defined, fingerprint, gitWorld, runGit, writeTree, type GitWorld } from "../../../corpus/src/test-support.ts";
import type { ClientResult, CorpusClient } from "./client.ts";
import type { Delivery, DocsSync } from "./events.ts";
import { ingestOf } from "./testkit.ts";
import { partitionInventory, runSync, scanRefusalSummary, withoutScanRefusals, type SyncDeps, type SyncRequest } from "./sync.ts";
import type { Inventory } from "./inventory.ts";

const roots: string[] = [];
afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const LABEL = "local/local";

function world(files: Record<string, string> = { "README.md": "# one\n", "docs/a.md": "a\n" }): GitWorld {
	const made = gitWorld(files);
	roots.push(made.root);
	return made;
}

function pushFromOther(w: GitWorld, files: Record<string, string>): void {
	writeTree(w.other, files);
	commitAll(w.other, "remote change");
	runGit(w.other, ["push", "-q", "origin", "main"]);
}

/** A server that keeps a manifest: what is planned and ingested follows from what was sent before, as the real one does. */
function fakeServer(options: { refuse?: (path: string) => boolean; planFails?: boolean; planThrows?: boolean } = {}) {
	const manifest = new Map<string, string>();
	const plans: CorpusPlanRequest[] = [];
	const ingests: CorpusIngestRequest[] = [];
	const client: CorpusClient = {
		async plan(request): Promise<ClientResult<CorpusPlanResponse>> {
			plans.push(request);
			if (options.planThrows === true) throw new Error("the plan exploded");
			if (options.planFails === true) return { ok: false, error: { kind: "unavailable", message: "the server is unavailable (503)" } };
			const items: PlanItem[] = [];
			const counts: Record<PlanAction, number> = { add: 0, change: 0, update: 0, rename: 0, tombstone: 0, unchanged: 0 };
			const present = new Set<string>();
			for (const entry of request.entries) {
				const key = `${entry.repo}:${entry.path}`;
				present.add(key);
				const known = manifest.get(key);
				const action: PlanAction = known === undefined ? "add" : known === entry.sha256 ? "unchanged" : "change";
				counts[action] += 1;
				if (action !== "unchanged") items.push({ action, repo: entry.repo, path: entry.path, sha256: entry.sha256 });
			}
			const covered = new Set(request.scope.coverage.map((pair) => pair.repo));
			for (const key of manifest.keys()) {
				const repo = key.slice(0, key.indexOf(":"));
				if (!covered.has(repo) || present.has(key)) continue;
				counts.tombstone += 1;
				items.push({ action: "tombstone", repo, path: key.slice(repo.length + 1) });
			}
			return { ok: true, value: { protocol: CORPUS_PROTOCOL, items, counts, manifestVersion: plans.length } };
		},
		async ingest(request) {
			ingests.push(request);
			const results = [
				...request.documents.map((document) => {
					if (options.refuse?.(document.path) === true) return { repo: document.repo, path: document.path, status: "refused" as const, reason: "secret-findings" };
					manifest.set(`${document.repo}:${document.path}`, document.sha256);
					return { repo: document.repo, path: document.path, status: "ingested" as const };
				}),
				...request.tombstones.map((row) => {
					manifest.delete(`${row.repo}:${row.path}`);
					return { repo: row.repo, path: row.path, status: "tombstoned" as const };
				}),
			];
			return { ok: true, value: ingestOf(results) };
		},
		async status() {
			return { ok: false, error: { kind: "http", message: "unused" } };
		},
		async reconcile() {
			return { ok: false, error: { kind: "http", message: "unused" } };
		},
		async neardup() {
			return { ok: false, error: { kind: "http", message: "unused" } };
		},
		async proof() {
			return { ok: false, error: { kind: "http", message: "unused" } };
		},
		async anchor() {
			return { ok: false, error: { kind: "http", message: "unused" } };
		},
	};
	return { client, manifest, plans, ingests };
}

function depsFor(w: GitWorld, client: CorpusClient, events: DocsSync[], over: Partial<SyncDeps> = {}): SyncDeps {
	let tick = 1_000_000;
	return {
		client,
		emit: async (event): Promise<Delivery> => {
			events.push(event);
			return { ok: true };
		},
		runner: undefined,
		git: defaultGitBytesRunner,
		readFile: (path) => readFileSync(path),
		now: () => {
			tick += 500;
			return tick;
		},
		roots: [w.root],
		mirrorDir: w.mirrors,
		maxTier: 2,
		maxBytes: 1_000_000,
		batchDocs: 20,
		batchBytes: 1_000_000,
		...over,
	};
}

const request = (over: Partial<SyncRequest> = {}): SyncRequest => ({ repos: [LABEL], trigger: "manual", execute: true, fetchMirrors: true, ...over });

describe("runSync through the mirror view", () => {
	test("ingests a remote-only push from the mirror and writes nothing into the checkout", async () => {
		const w = world();
		pushFromOther(w, { "docs/b.md": "b\n" });
		const server = fakeServer();
		const events: DocsSync[] = [];
		const before = fingerprint(w.local);

		const result = await runSync(depsFor(w, server.client, events), request());

		expect(result.outcome).toBe("ok");
		expect(result.mirrors).toEqual([{ repo: LABEL, status: "fetched", view: "mirror" }]);
		expect(defined(server.plans[0], "a plan").entries.map((entry) => entry.path)).toEqual(["README.md", "docs/a.md", "docs/b.md"]);
		const bodies = server.ingests.flatMap((ingest) => ingest.documents).map((document) => `${document.path}=${document.body}`);
		expect(bodies.sort()).toEqual(["README.md=# one\n", "docs/a.md=a\n", "docs/b.md=b\n"]);
		expect(fingerprint(w.local)).toBe(before);
	});

	test("a second sync with nothing changed plans everything unchanged and ingests nothing", async () => {
		const w = world();
		const server = fakeServer();
		const events: DocsSync[] = [];
		await runSync(depsFor(w, server.client, events), request());
		const sent = server.ingests.length;

		const again = await runSync(depsFor(w, server.client, events), request({ fetchMirrors: false }));

		expect(again.outcome).toBe("ok");
		expect(again.plan?.counts).toEqual({ add: 0, change: 0, update: 0, rename: 0, tombstone: 0, unchanged: 2 });
		expect(server.ingests).toHaveLength(sent);
	});

	test("a local edit and an unrelated remote change both reach the plane, and nothing flips back", async () => {
		const w = world({ "README.md": "# one\n", "docs/a.md": "a\n", "docs/b.md": "b\n" });
		const server = fakeServer();
		const events: DocsSync[] = [];
		await runSync(depsFor(w, server.client, events), request());
		writeTree(w.local, { "docs/a.md": "a-local\n" });
		pushFromOther(w, { "docs/b.md": "b-remote\n" });

		const result = await runSync(depsFor(w, server.client, events), request());

		expect(result.plan?.items.map((item) => `${item.action}:${item.path}`).sort()).toEqual(["change:docs/a.md", "change:docs/b.md"]);
		// The remote push goes on while the local edit stays unpulled: a third sync changes nothing.
		pushFromOther(w, { "docs/c.md": "c\n" });
		const third = await runSync(depsFor(w, server.client, events), request());
		expect(third.plan?.items.map((item) => `${item.action}:${item.path}`)).toEqual(["add:docs/c.md"]);
	});

	test("without --fetch an existing mirror is read as it is; a repository with no mirror is read from its working tree", async () => {
		const w = world();
		const server = fakeServer();
		const events: DocsSync[] = [];
		const first = await runSync(depsFor(w, server.client, events), request({ fetchMirrors: false }));
		expect(first.mirrors).toEqual([{ repo: LABEL, status: "absent", reason: "not-created", view: "working-tree" }]);
		pushFromOther(w, { "docs/b.md": "b\n" });
		expect(first.inventory?.entries.map((entry) => entry.path)).toEqual(["README.md", "docs/a.md"]);

		const second = await runSync(depsFor(w, server.client, events), request({ fetchMirrors: true }));
		expect(second.inventory?.entries.map((entry) => entry.path)).toEqual(["README.md", "docs/a.md", "docs/b.md"]);

		pushFromOther(w, { "docs/c.md": "c\n" });
		const third = await runSync(depsFor(w, server.client, events), request({ fetchMirrors: false }));
		expect(third.mirrors).toEqual([{ repo: LABEL, status: "unfetched", view: "mirror" }]);
		expect(third.inventory?.entries.map((entry) => entry.path)).toEqual(["README.md", "docs/a.md", "docs/b.md"]);
	});

	test("a failed fetch is reported as mirror-stale, keeps reading the last good mirror and changes no row", async () => {
		const w = world();
		pushFromOther(w, { "docs/b.md": "b\n" });
		const server = fakeServer();
		const events: DocsSync[] = [];
		await runSync(depsFor(w, server.client, events), request());
		const manifestBefore = new Map(server.manifest);
		const sent = server.ingests.length;

		renameSync(w.origin, `${w.origin}.away`);
		const offline = await runSync(depsFor(w, server.client, events), request());

		expect(offline.outcome).toBe("ok");
		expect(offline.mirrors).toEqual([{ repo: LABEL, status: "stale", reason: "fetch-failed", view: "mirror" }]);
		expect(offline.plan?.counts.unchanged).toBe(3);
		expect(server.ingests).toHaveLength(sent);
		expect(server.manifest).toEqual(manifestBefore);
	});

	test("a read that is not complete leaves the repository out of the coverage, so nothing is tombstoned", async () => {
		const w = world();
		const server = fakeServer();
		const events: DocsSync[] = [];
		await runSync(depsFor(w, server.client, events), request());
		runGit(w.local, ["checkout", "-q", "--orphan", "lone"]);
		rmSync(`${w.local}/docs`, { recursive: true });
		commitAll(w.local, "lone");

		const result = await runSync(depsFor(w, server.client, events), request());

		expect(defined(server.plans.at(-1), "the plan").scope.coverage).toEqual([]);
		expect(result.incomplete.join(" ")).toContain("shares no history");
		expect(result.plan?.counts.tombstone).toBe(0);
		expect(server.manifest.has(`${LABEL}:docs/a.md`)).toBe(true);
	});
});

describe("runSync outcomes and events", () => {
	test("one refused document makes the sync partial, never fails the others, and is counted in the event", async () => {
		const w = world();
		const server = fakeServer({ refuse: (path) => path === "docs/a.md" });
		const events: DocsSync[] = [];

		const result = await runSync(depsFor(w, server.client, events), request({ trigger: "hook" }));

		expect(result.outcome).toBe("partial");
		expect(result.ingest?.counts).toMatchObject({ ingested: 1, refused: 1, failed: 0 });
		expect(server.manifest.has(`${LABEL}:README.md`)).toBe(true);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ repo: LABEL, trigger: "hook", outcome: "partial", added: 2, refused: 1, failed: 0 });
	});

	test("the event carries the lag from the first change signal, not from the start of the sync", async () => {
		const w = world();
		const events: DocsSync[] = [];
		let tick = 10_000;
		const deps = depsFor(w, fakeServer().client, events, { now: () => (tick += 1000) });

		await runSync(deps, request({ firstSignalAtMs: 4_000 }));

		const event = defined(events[0], "an event");
		// Two reads of the clock one second apart bracket the sync; the lag counts from 4 s, so it is the whole span.
		expect(event.durationMs).toBe(1000);
		expect(event.lagS).toBe(8);
	});

	test("a failed plan is the outcome failed, with the reason, and the event says so", async () => {
		const w = world();
		const events: DocsSync[] = [];

		const result = await runSync(depsFor(w, fakeServer({ planFails: true }).client, events), request());

		expect(result.outcome).toBe("failed");
		expect(result.error).toContain("unavailable");
		expect(events[0]).toMatchObject({ outcome: "failed", added: 0, changed: 0 });
	});

	test("an unexpected exception is a failed sync, never a throw out of runSync", async () => {
		const w = world();
		const events: DocsSync[] = [];
		const result = await runSync(depsFor(w, fakeServer({ planThrows: true }).client, events), request());
		expect(result.outcome).toBe("failed");
		expect(result.error).toContain("the plan exploded");
		expect(events[0]?.outcome).toBe("failed");
	});

	test("a repository that is not below the roots is skipped and reported, and plans nothing", async () => {
		const w = world();
		const server = fakeServer();
		const events: DocsSync[] = [];

		const result = await runSync(depsFor(w, server.client, events), request({ repos: ["Acme/Nope"] }));

		expect(result.outcome).toBe("skipped");
		expect(result.notFound).toEqual(["Acme/Nope"]);
		expect(server.plans).toHaveLength(0);
		expect(events[0]).toMatchObject({ repo: "Acme/Nope", outcome: "skipped" });
	});

	test("a lost event never fails the sync and is reported in the result", async () => {
		const w = world();
		const server = fakeServer();
		const result = await runSync(depsFor(w, server.client, [], { emit: async () => ({ ok: false, reason: "http-503" }) }), request());
		expect(result.outcome).toBe("ok");
		expect(result.delivery).toEqual({ ok: false, reason: "http-503" });
	});

	test("a dry run sends nothing to the plane and emits no event", async () => {
		const w = world();
		const server = fakeServer();
		const events: DocsSync[] = [];

		const result = await runSync(depsFor(w, server.client, events), request({ execute: false }));

		expect(result.outcome).toBe("ok");
		expect(result.plan?.counts.add).toBe(2);
		expect(server.ingests).toHaveLength(0);
		expect(events).toEqual([]);
		expect(result.delivery).toBeNull();
	});

	test("a sync of every repository reports the label '*' in its event", async () => {
		const w = world();
		const events: DocsSync[] = [];
		await runSync(depsFor(w, fakeServer().client, events), request({ repos: null, trigger: "sweep" }));
		expect(events[0]).toMatchObject({ repo: "*", trigger: "sweep" });
	});
});

describe("partitionInventory", () => {
	function inventory(repos: Record<string, number>): Inventory {
		const entries = Object.entries(repos).flatMap(([repo, count]) =>
			Array.from({ length: count }, (_, i) => ({ repo, path: `d${i}.md`, kind: "doc" as const, tier: 1 as const, sha256: "a".repeat(64), bytes: 1, source: "fs" as const })),
		);
		return {
			entries,
			paths: new Map(),
			sources: ["fs"],
			maxTier: 2,
			scope: { coverage: Object.keys(repos).map((repo) => ({ repo, source: "fs" as const })), maxTier: 2 },
			report: { checkouts: 0, repos: [], collapsed: { clones: 0, worktrees: 0, identical: 0, identicalGroups: 0, identicalCopies: [] }, skipped: [], skippedByReason: {}, emptyCollections: 0, notes: [] },
		};
	}

	test("groups repositories so no plan exceeds the entry bound, keeping each repository whole", () => {
		const { groups, oversized } = partitionInventory(inventory({ "a/a": 4, "b/b": 4, "c/c": 3, "d/d": 1 }), 8);
		expect(oversized).toEqual([]);
		expect(groups.map((group) => group.entries.length)).toEqual([8, 4]);
		expect(groups.map((group) => group.scope.coverage.map((pair) => pair.repo))).toEqual([["a/a", "b/b"], ["c/c", "d/d"]]);
	});

	test("a repository over the bound is reported and not planned, and the rest still go", () => {
		const { groups, oversized } = partitionInventory(inventory({ "a/a": 9, "b/b": 2 }), 8);
		expect(oversized).toEqual(["a/a"]);
		expect(groups).toHaveLength(1);
		expect(defined(groups[0], "a group").scope.coverage).toEqual([{ repo: "b/b", source: "fs" }]);
	});

	test("a covered repository with no entries still travels with its coverage, and the coverage bound applies", () => {
		const { groups } = partitionInventory(inventory({ "a/a": 0, "b/b": 0, "c/c": 0 }), 100, 2);
		expect(groups.map((group) => group.scope.coverage.length)).toEqual([2, 1]);
		expect(groups.every((group) => group.entries.length === 0)).toBe(true);
	});

	test("grouping appends to the existing array", () => {
		const inv = inventory({ "a/a": 3 });
		const { groups } = partitionInventory(inv, 10);
		expect(defined(groups[0], "group").entries[2]).toBe(inv.entries[2]);
	});

	test("a bad path is counted once for the sweep, not once per group", () => {
		const inv = inventory({ "a/a": 1, "b/b": 1 });
		inv.report.skipped = [{ repo: "a/a", path: "bad\\x.md", reason: "bad-path" }];
		inv.report.skippedByReason = { "bad-path": 1 };
		const { groups } = partitionInventory(inv, 1);
		expect(groups).toHaveLength(2);
		const stripped = groups.map(withoutScanRefusals);
		expect(stripped.every((group) => group.report.skippedByReason["bad-path"] === 0)).toBe(true);
		expect(scanRefusalSummary(inv).count).toBe(1);
	});
});

describe("the shared repository lock", () => {
	test("a second sync of the same repository waits until the first has sent", async () => {
		const w = world();
		const server = fakeServer();
		const gate = Promise.withResolvers<void>();
		const plan = server.client.plan.bind(server.client);
		let entered = 0;
		server.client.plan = async (request) => {
			entered += 1;
			if (entered === 1) await gate.promise;
			return plan(request);
		};
		const events: DocsSync[] = [];
		const first = runSync(depsFor(w, server.client, events), request());
		const started = Date.now();
		while (entered < 1 && Date.now() - started < 10_000) {
			const wait = Promise.withResolvers<void>();
			setTimeout(wait.resolve, 10);
			await wait.promise;
		}
		const second = runSync(depsFor(w, server.client, events), request({ trigger: "watch" }));
		const pause = Promise.withResolvers<void>();
		setTimeout(pause.resolve, 40);
		await pause.promise;
		expect(entered).toBe(1);
		expect(server.ingests).toHaveLength(0);
		gate.resolve();
		await first;
		await second;
		expect(entered).toBe(2);
		expect(server.ingests.length).toBeGreaterThan(0);
	});
});
