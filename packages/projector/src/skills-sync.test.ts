import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	childEnv,
	decide,
	type PendingRefresh,
	postDocsRefresh,
	readPendingRefresh,
	REFRESH_PENDING_FILE,
	refreshTarget,
	type RunResult,
	runSync,
	SYNC_REFRESH_DATASET,
	type SyncContext,
	writePendingRefresh,
} from "./skills-sync.ts";
import type { WarningEvent } from "./skills.ts";

const L = "/tmp/lib";
const OLD = "1111111111111111111111111111111111111111";
const NEW = "2222222222222222222222222222222222222222";

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

describe("decide", () => {
	const clean = { porcelain: "", branch: "main" };
	test("a dirty tree is refused first", () => {
		expect(decide({ porcelain: " M x", branch: "main", isAncestor: true, head: OLD, originMain: NEW })).toBe("refuse-dirty");
		expect(decide({ porcelain: "?? new-file\n", branch: "other" })).toBe("refuse-dirty");
	});
	test("a branch other than main is refused", () => {
		expect(decide({ porcelain: "", branch: "other", isAncestor: true, head: OLD, originMain: NEW })).toBe("refuse-branch");
		expect(decide({ porcelain: "", branch: "HEAD" })).toBe("refuse-branch");
	});
	test("clean main with no remote facts yet → fetch", () => {
		expect(decide(clean)).toBe("fetch");
	});
	test("HEAD not an ancestor of origin/main → refuse-diverged", () => {
		expect(decide({ ...clean, isAncestor: false, head: OLD, originMain: NEW })).toBe("refuse-diverged");
	});
	test("HEAD equal to origin/main → current; otherwise ff", () => {
		expect(decide({ ...clean, isAncestor: true, head: OLD, originMain: OLD })).toBe("current");
		expect(decide({ ...clean, isAncestor: true, head: OLD, originMain: NEW })).toBe("ff");
	});
});

type Script = { porcelain?: string; branch?: string; fetch?: RunResult; ancestor?: number; head?: string; origin?: string; merge?: RunResult; tree?: string | null; refresh?: "ok" | "fail" | "throw"; pending?: PendingRefresh | null };

function harness(script: Script) {
	const calls: string[][] = [];
	const warnings: WarningEvent[] = [];
	const log: string[] = [];
	let projected = 0;
	const refreshPosts: Array<{ commit: string; content_sha256: string }> = [];
	const pendingSaves: Array<PendingRefresh | null> = [];
	const runner = async (argv: readonly string[]): Promise<RunResult> => {
		calls.push([...argv]);
		const verb = argv.slice(3).join(" ");
		switch (verb) {
			case "status --porcelain":
				return ok(script.porcelain ?? "");
			case "rev-parse --abbrev-ref HEAD":
				return ok(`${script.branch ?? "main"}\n`);
			case "fetch origin main":
				return script.fetch ?? ok();
			case "merge-base --is-ancestor HEAD origin/main":
				return { code: script.ancestor ?? 0, stdout: "", stderr: "" };
			case "rev-parse HEAD origin/main":
				return ok(`${script.head ?? OLD}\n${script.origin ?? OLD}\n`);
			case "merge --ff-only origin/main":
				return script.merge ?? ok("Fast-forward\n");
			case "rev-parse HEAD^{tree}":
				return script.tree === null ? { code: 128, stdout: "", stderr: "fatal: not a git repository" } : ok(`${script.tree ?? "treehash"}\n`);
			default:
				throw new Error(`unexpected argv ${argv.join(" ")}`);
		}
	};
	const notifyRefresh = script.refresh === undefined
		? undefined
		: async (input: { commit: string; content_sha256: string }) => {
			refreshPosts.push(input);
			if (script.refresh === "fail") return { ok: false as const, reason: "merge-trigger 503" };
			if (script.refresh === "throw") throw new Error("boom");
			return { ok: true as const };
		};
	const ctx: SyncContext = {
		runner,
		libraryDir: L,
		log: (line) => log.push(line),
		emitWarning: async (event) => {
			warnings.push(event);
			return true;
		},
		project: async () => {
			projected++;
			return { actions: 0, warnings: 0 };
		},
		...(notifyRefresh ? { notifyRefresh } : {}),
		// The key's presence is the seam; `pending` may be null (nothing stored).
		...("pending" in script
			? { loadPendingRefresh: () => (script.pending ?? null) satisfies PendingRefresh | null, savePendingRefresh: (pending: PendingRefresh | null) => pendingSaves.push(pending) }
			: {}),
	};
	return { ctx, calls, warnings, log, projected: () => projected, refreshPosts, pendingSaves };
}

const verbs = (calls: string[][]) => calls.map((c) => c.slice(3).join(" "));

describe("runSync executor", () => {
	test("refuse-dirty: no fetch, no projector, one warning", async () => {
		const h = harness({ porcelain: " M docs-agno/SKILL.md\n" });
		expect(await runSync(h.ctx)).toEqual({ decision: "refuse-dirty", code: 0 });
		expect(verbs(h.calls)).not.toContain("fetch origin main");
		expect(h.projected()).toBe(0);
		expect(h.warnings.map((w) => [w.surface, w.kind, w.payload])).toEqual([
			["substrate", "warning", { action: "skills.sync", runtime: "skills-sync", reason: "dirty" }],
		]);
		expect(h.log).toEqual(["[skills-sync] refused dirty"]);
	});

	test("refuse-branch: no fetch, no projector, one warning", async () => {
		const h = harness({ branch: "skill/x" });
		expect((await runSync(h.ctx)).decision).toBe("refuse-branch");
		expect(verbs(h.calls)).not.toContain("fetch origin main");
		expect(h.projected()).toBe(0);
		expect(h.warnings.map((w) => w.payload.reason)).toEqual(["branch"]);
		expect(h.log).toEqual(["[skills-sync] refused branch"]);
	});

	test("refuse-diverged: fetched, no merge, no projector, one warning", async () => {
		const h = harness({ ancestor: 1, head: OLD, origin: NEW });
		expect((await runSync(h.ctx)).decision).toBe("refuse-diverged");
		expect(verbs(h.calls)).toContain("fetch origin main");
		expect(verbs(h.calls)).not.toContain("merge --ff-only origin/main");
		expect(h.projected()).toBe(0);
		expect(h.warnings.map((w) => w.payload.reason)).toEqual(["diverged"]);
		expect(h.log).toEqual(["[skills-sync] refused diverged"]);
	});

	test("ff: the exact --ff-only argv, then the projector", async () => {
		const h = harness({ head: OLD, origin: NEW });
		expect(await runSync(h.ctx)).toEqual({ decision: "ff", code: 0 });
		expect(h.calls).toContainEqual(["git", "-C", L, "merge", "--ff-only", "origin/main"]);
		expect(h.calls[0]).toEqual(["git", "-C", L, "status", "--porcelain"]);
		expect(h.calls).toContainEqual(["git", "-C", L, "fetch", "origin", "main"]);
		expect(h.projected()).toBe(1);
		expect(h.warnings).toEqual([]);
		expect(h.log).toEqual([`[skills-sync] ff ${OLD}..${NEW}`]);
	});

	test("current: no merge, the projector still runs (self-heal), no warning", async () => {
		const h = harness({ head: OLD, origin: OLD });
		expect(await runSync(h.ctx)).toEqual({ decision: "current", code: 0 });
		expect(verbs(h.calls)).not.toContain("merge --ff-only origin/main");
		expect(h.projected()).toBe(1);
		expect(h.warnings).toEqual([]);
		expect(h.log).toEqual([`[skills-sync] current ${OLD}`]);
	});

	test("a failed git step ends the tick with exit 1, one warning, and no projector", async () => {
		const h = harness({ fetch: { code: 128, stdout: "", stderr: "fatal: unable to access" } });
		expect(await runSync(h.ctx)).toEqual({ decision: "error", code: 1 });
		expect(verbs(h.calls)).not.toContain("merge --ff-only origin/main");
		expect(h.projected()).toBe(0);
		expect(h.warnings.map((w) => w.payload.reason)).toEqual(["fetch-failed"]);
		expect(h.log[0]).toStartWith("[skills-sync] refused fetch-failed");
	});

	test("a failed ff merge is refused with a warning and no projector", async () => {
		const h = harness({ head: OLD, origin: NEW, merge: { code: 128, stdout: "", stderr: "fatal: Not possible to fast-forward" } });
		expect((await runSync(h.ctx)).code).toBe(1);
		expect(h.projected()).toBe(0);
		expect(h.warnings.map((w) => w.payload.reason)).toEqual(["merge-failed"]);
	});
});

describe("childEnv allowlist", () => {
	test("a git child receives exactly the four allowlisted entries", () => {
		// Store and token names stay out of this fixture: the store-lock and
		// no-secrets suites forbid them in tracked .ts files, and the plan's
		// grep gate pins their absence in skills-sync.ts itself.
		const env = childEnv({
			PATH: "/usr/bin:/bin",
			HOME: "/home/op",
			SUBSTRATE_TOKEN: "secret",
			SUBSTRATE_URL: "http://store:7410",
			UNRELATED_STORE_URL: "http://store:8428",
			ANOTHER_SECRET: "secret",
		});
		expect(Object.keys(env).sort()).toEqual(["GH_PROMPT_DISABLED", "GIT_TERMINAL_PROMPT", "HOME", "PATH"]);
		expect(env).toEqual({ PATH: "/usr/bin:/bin", HOME: "/home/op", GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" });
	});

	test("HOME falls back to /root and PATH to the system default when unset", () => {
		expect(childEnv({})).toEqual({ PATH: "/usr/bin:/bin", HOME: "/root", GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" });
	});
});

/** One stderr capture; `restore` goes in a finally. */
function captureStderr(): { lines: string[]; restore: () => void } {
	const lines: string[] = [];
	const original = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: Uint8Array | string, ...rest: unknown[]): boolean => {
		void rest;
		lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	}) as typeof process.stderr.write;
	return { lines, restore: () => (process.stderr.write = original) };
}

describe("runSync refresh trigger (U6)", () => {
	test("a fast-forward fires exactly one refresh POST with the new head and tree hash", async () => {
		const h = harness({ head: OLD, origin: NEW, tree: "treehash-1", refresh: "ok" });
		expect(await runSync(h.ctx)).toEqual({ decision: "ff", code: 0 });
		expect(h.refreshPosts).toEqual([{ commit: NEW, content_sha256: "treehash-1" }]);
		expect(verbs(h.calls)).toContain("rev-parse HEAD^{tree}");
		expect(h.projected()).toBe(1);
	});

	test("the POST rides the sync dataset constant, so the route hears agent-skills", async () => {
		// The dataset name is fixed by the sync, not the route default: a skills fast-forward
		// must never refresh the substrate's own docs dataset.
		expect(SYNC_REFRESH_DATASET).toBe("agent-skills");
	});

	test("a dirty-tree sync fires no refresh and reads no tree hash", async () => {
		const h = harness({ porcelain: " M docs-agno/SKILL.md\n", refresh: "ok" });
		expect((await runSync(h.ctx)).decision).toBe("refuse-dirty");
		expect(h.refreshPosts).toEqual([]);
		expect(verbs(h.calls)).not.toContain("rev-parse HEAD^{tree}");
	});

	test("a current tick is not a fast-forward and fires no refresh", async () => {
		const h = harness({ head: OLD, origin: OLD, refresh: "ok" });
		expect((await runSync(h.ctx)).decision).toBe("current");
		expect(h.refreshPosts).toEqual([]);
		expect(verbs(h.calls)).not.toContain("rev-parse HEAD^{tree}");
	});

	test("a refused POST is one stderr line and the sync still succeeds", async () => {
		const h = harness({ head: OLD, origin: NEW, refresh: "fail" });
		const stderr = captureStderr();
		try {
			expect(await runSync(h.ctx)).toEqual({ decision: "ff", code: 0 });
			expect(h.refreshPosts).toHaveLength(1);
			expect(h.projected()).toBe(1);
			expect(stderr.lines.join("")).toContain("[skills-sync] docs refresh not triggered: merge-trigger 503");
		} finally {
			stderr.restore();
		}
	});

	test("a throwing refresh sink is caught: one stderr line, exit 0, projector ran", async () => {
		const h = harness({ head: OLD, origin: NEW, refresh: "throw" });
		const stderr = captureStderr();
		try {
			expect(await runSync(h.ctx)).toEqual({ decision: "ff", code: 0 });
			expect(h.projected()).toBe(1);
			expect(stderr.lines.join("")).toContain("[skills-sync] docs refresh not triggered: boom");
		} finally {
			stderr.restore();
		}
	});

	test("a tree hash the tick cannot read skips the POST, never the sync", async () => {
		const h = harness({ head: OLD, origin: NEW, tree: null, refresh: "ok" });
		const stderr = captureStderr();
		try {
			expect(await runSync(h.ctx)).toEqual({ decision: "ff", code: 0 });
			expect(h.refreshPosts).toEqual([]);
			expect(stderr.lines.join("")).toContain("[skills-sync] docs refresh not triggered: tree hash failed");
		} finally {
			stderr.restore();
		}
	});

	test("no refresh seam in the context means no POST and no tree read", async () => {
		const h = harness({ head: OLD, origin: NEW });
		expect(await runSync(h.ctx)).toEqual({ decision: "ff", code: 0 });
		expect(h.refreshPosts).toEqual([]);
		expect(verbs(h.calls)).not.toContain("rev-parse HEAD^{tree}");
	});

	const PENDING: PendingRefresh = { commit: OLD, content_sha256: "tree-pending" };

	test("a pending refresh retries on a current tick and clears on success", async () => {
		const h = harness({ head: OLD, origin: OLD, refresh: "ok", pending: PENDING });
		expect(await runSync(h.ctx)).toEqual({ decision: "current", code: 0 });
		// The payload that failed in an earlier tick is exactly what goes back on
		// the wire — no new tree read for a tick that merged nothing.
		expect(h.refreshPosts).toEqual([PENDING]);
		expect(verbs(h.calls)).not.toContain("rev-parse HEAD^{tree}");
		expect(h.projected()).toBe(1);
		expect(h.warnings).toEqual([]);
		expect(h.pendingSaves).toEqual([null]);
	});

	test("a pending refresh that fails again stays pending and the sync stays green", async () => {
		const h = harness({ head: OLD, origin: OLD, refresh: "fail", pending: PENDING });
		const stderr = captureStderr();
		try {
			expect(await runSync(h.ctx)).toEqual({ decision: "current", code: 0 });
			expect(h.refreshPosts).toEqual([PENDING]);
			// The payload is kept for the next tick; the tick itself still exits 0.
			expect(h.pendingSaves).toEqual([PENDING]);
			expect(stderr.lines.join("")).toContain("[skills-sync] docs refresh not triggered: merge-trigger 503");
		} finally {
			stderr.restore();
		}
	});

	test("a fast-forward supersedes a pending refresh", async () => {
		const h = harness({ head: OLD, origin: NEW, tree: "tree-new", refresh: "ok", pending: PENDING });
		expect(await runSync(h.ctx)).toEqual({ decision: "ff", code: 0 });
		// The newest tree is the one search should hold: the stale payload is
		// never re-posted, and a delivered refresh clears the pending slot.
		expect(h.refreshPosts).toEqual([{ commit: NEW, content_sha256: "tree-new" }]);
		expect(h.pendingSaves).toEqual([null]);
	});

	test("a fast-forward whose POST fails leaves the new payload pending", async () => {
		const h = harness({ head: OLD, origin: NEW, tree: "tree-new", refresh: "fail", pending: PENDING });
		const stderr = captureStderr();
		try {
			expect(await runSync(h.ctx)).toEqual({ decision: "ff", code: 0 });
			expect(h.refreshPosts).toEqual([{ commit: NEW, content_sha256: "tree-new" }]);
			expect(h.pendingSaves).toEqual([{ commit: NEW, content_sha256: "tree-new" }]);
			expect(stderr.lines.join("")).toContain("[skills-sync] docs refresh not triggered: merge-trigger 503");
		} finally {
			stderr.restore();
		}
	});

	test("a tick the sync refuses touches neither the POST nor the pending slot", async () => {
		const h = harness({ porcelain: " M docs-agno/SKILL.md\n", refresh: "ok", pending: PENDING });
		expect((await runSync(h.ctx)).decision).toBe("refuse-dirty");
		expect(h.refreshPosts).toEqual([]);
		expect(h.pendingSaves).toEqual([]);
	});

	test("a tree hash the ff tick cannot read leaves the pending payload alone", async () => {
		const h = harness({ head: OLD, origin: NEW, tree: null, refresh: "ok", pending: PENDING });
		const stderr = captureStderr();
		try {
			expect(await runSync(h.ctx)).toEqual({ decision: "ff", code: 0 });
			expect(h.refreshPosts).toEqual([]);
			expect(h.pendingSaves).toEqual([]);
			expect(stderr.lines.join("")).toContain("[skills-sync] docs refresh not triggered: tree hash failed");
		} finally {
			stderr.restore();
		}
	});
});

describe("refreshTarget", () => {
	test("no projector surface token means the trigger is off", () => {
		expect(refreshTarget({})).toBeNull();
		expect(refreshTarget({ SUBSTRATE_TOKEN: "   " })).toBeNull();
		expect(refreshTarget({ SUBSTRATE_TOKEN_SUBSTRATE: "  ", SUBSTRATE_TOKEN: "   " })).toBeNull();
	});

	test("the surface's own unit token wins, and the generic token is the fallback", () => {
		expect(refreshTarget({ SUBSTRATE_TOKEN_SUBSTRATE: "tok-substrate" })).toEqual({ url: "http://127.0.0.1:7410", token: "tok-substrate" });
		expect(refreshTarget({ SUBSTRATE_TOKEN_SUBSTRATE: "tok-substrate", SUBSTRATE_TOKEN: "tok-generic" })).toEqual({
			url: "http://127.0.0.1:7410",
			token: "tok-substrate",
		});
		// A deployment that only holds the older spelling still gets the trigger.
		expect(refreshTarget({ SUBSTRATE_TOKEN: "tok-generic" })).toEqual({ url: "http://127.0.0.1:7410", token: "tok-generic" });
	});

	test("defaults to the loopback substrate and reads both at call time", () => {
		expect(refreshTarget({ SUBSTRATE_TOKEN: "tok" })).toEqual({ url: "http://127.0.0.1:7410", token: "tok" });
		expect(refreshTarget({ SUBSTRATE_TOKEN: "tok", SUBSTRATE_URL: "http://127.0.0.1:17410/" })).toEqual({
			url: "http://127.0.0.1:17410",
			token: "tok",
		});
	});
});

describe("postDocsRefresh", () => {
	test("posts the dataset body with the bearer to the merge-trigger route", async () => {
		const seen: Array<{ url: string; init: RequestInit }> = [];
		const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			seen.push({ url: String(input), init: init ?? {} });
			return new Response("{}", { status: 200 });
		}) as typeof fetch;
		const outcome = await postDocsRefresh(
			{ url: "http://127.0.0.1:7410", token: "tok" },
			{ dataset: SYNC_REFRESH_DATASET, commit: NEW, content_sha256: "treehash-1" },
			fetchImpl,
		);
		expect(outcome).toEqual({ ok: true });
		expect(seen).toHaveLength(1);
		expect(seen[0]?.url).toBe("http://127.0.0.1:7410/docs/merge-trigger");
		const headers = seen[0]?.init.headers as Record<string, string>;
		expect(headers.authorization).toBe("Bearer tok");
		expect(headers["content-type"]).toBe("application/json");
		expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ dataset: "agent-skills", commit: NEW, content_sha256: "treehash-1" });
	});

	test("a refusal and an unreachable substrate are reasons, never throws", async () => {
		const refusing = (async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => new Response("no", { status: 503 })) as typeof fetch;
		expect(await postDocsRefresh({ url: "http://127.0.0.1:7410", token: "tok" }, { dataset: "agent-skills", commit: "c", content_sha256: "s" }, refusing)).toEqual({
			ok: false,
			reason: "merge-trigger 503",
		});
		const dead = (async (_input: Parameters<typeof fetch>[0], _init?: RequestInit): Promise<Response> => {
			throw new Error("connect ECONNREFUSED");
		}) as typeof fetch;
		const unreachable = await postDocsRefresh(
			{ url: "http://127.0.0.1:7410", token: "tok" },
			{ dataset: "agent-skills", commit: "c", content_sha256: "s" },
			dead,
		);
		expect(unreachable.ok).toBe(false);
		if (!unreachable.ok) expect(unreachable.reason).toContain("merge-trigger unreachable: connect ECONNREFUSED");
	});
});

describe("pending refresh state file", () => {
	test("stores, replaces and clears the payload through the same file", () => {
		const dir = mkdtempSync(join(tmpdir(), "substrate-pending-"));
		const file = join(dir, "skills", "refresh-pending.json");
		try {
			expect(readPendingRefresh(file)).toBeNull();
			writePendingRefresh(file, { commit: NEW, content_sha256: "tree-1" });
			expect(readPendingRefresh(file)).toEqual({ commit: NEW, content_sha256: "tree-1" });
			writePendingRefresh(file, { commit: OLD, content_sha256: "tree-2" });
			expect(readPendingRefresh(file)).toEqual({ commit: OLD, content_sha256: "tree-2" });
			writePendingRefresh(file, null);
			expect(readPendingRefresh(file)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an unusable file is no pending refresh, never a throw", () => {
		const dir = mkdtempSync(join(tmpdir(), "substrate-pending-"));
		try {
			const broken = join(dir, "broken.json");
			for (const body of ["{not json", JSON.stringify(["not", "an", "object"]), JSON.stringify({ content_sha256: "tree-1" }), JSON.stringify({ commit: "", content_sha256: "tree-1" })]) {
				writeFileSync(broken, body);
				expect(readPendingRefresh(broken)).toBeNull();
			}
			// The production default is the sync's state directory, beside the
			// projector's warned-state file.
			expect(REFRESH_PENDING_FILE).toBe("/var/lib/substrate/skills/refresh-pending.json");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
