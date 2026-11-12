/**
 * Phase 72 at the CLI: `substrate worktree` refuses a path or repository outside the surface's grant before any git call.
 * Each test names the boundary it proves. The git runner records its calls and never spawns git.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmitOutcome } from "../../../collectors/src/emit.ts";
import type { GitRunner } from "../../../fleet/src/index.ts";
import { REPO_REGISTRY_ENV, REPO_SCOPES_ENV } from "../../../mcp-server/src/repo-scope.ts";
import type { EventInput } from "../../../mcp-server/src/types.ts";
import { type PostOutcome, runWorktree, type WorktreeDeps } from "./command.ts";

interface Dirs {
	checkout: string;
	worktrees: string;
}

interface Fixture {
	root: string;
	a: Dirs;
	b: Dirs;
	stray: string;
	registry: string;
}

function fixture(): Fixture {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "cli-scope-")));
	const make = (name: string): Dirs => {
		const checkout = join(root, name, "checkout");
		const worktrees = join(root, name, "worktrees");
		mkdirSync(join(checkout, ".git"), { recursive: true });
		mkdirSync(worktrees, { recursive: true });
		return { checkout, worktrees };
	};
	const stray = join(root, "stray");
	mkdirSync(stray);
	const a = make("a");
	const b = make("b");
	const registry = JSON.stringify({
		"owner/a": { checkouts: [a.checkout], worktrees: [a.worktrees] },
		"owner/b": { checkouts: [b.checkout], worktrees: [b.worktrees] },
	});
	return { root, a, b, stray, registry };
}

interface Seen {
	git: string[][];
	err: string[];
	events: EventInput[];
}

function deps(env: Record<string, string | undefined>, cwd: string): { deps: WorktreeDeps; seen: Seen } {
	const seen: Seen = { git: [], err: [], events: [] };
	const git: GitRunner = async (args) => {
		seen.git.push([...args]);
		return { code: 0, stdout: "", stderr: "" };
	};
	const built: WorktreeDeps = {
		env,
		cwd,
		host: "test-host",
		out: () => undefined,
		err: (text) => seen.err.push(text),
		git,
		gh: async () => ({ code: 0, stdout: "", stderr: "" }),
		now: () => new Date(),
		freeBytes: () => 100 * 1024 ** 3,
		emit: async (event): Promise<EmitOutcome> => {
			seen.events.push(event);
			return { kind: "stored" };
		},
		postReport: async (): Promise<PostOutcome> => ({ ok: true, stored: 0 }),
		claims: async () => ({ ok: true, claims: [] }),
		listRegistry: async () => ({ ok: true, rows: [], truncated: false }),
		mergeBackNoted: async () => ({ ok: true, noted: false }),
	};
	return { deps: built, seen };
}

/** The local surface is granted `owner/a` only. */
function scopedEnv(f: Fixture): Record<string, string | undefined> {
	return { [REPO_REGISTRY_ENV]: f.registry, [REPO_SCOPES_ENV]: JSON.stringify({ "claude-code": ["owner/a"] }) };
}

describe("substrate worktree refuses outside the grant before any git call", () => {
	test("boundary: provision into another repository's checkout is refused and runs no git", async () => {
		const f = fixture();
		const { deps: d, seen } = deps(scopedEnv(f), f.root);
		expect(await runWorktree(["provision", "--repo", f.b.checkout, "--branch", "feat"], d)).toBe(2);
		expect(seen.git).toHaveLength(0);
		expect(seen.err.join("")).toContain("refused");
	});

	test("boundary: provision whose target lies in another repository's worktrees is refused and runs no git", async () => {
		const f = fixture();
		const { deps: d, seen } = deps(scopedEnv(f), f.root);
		expect(await runWorktree(["provision", "--repo", f.a.checkout, "--branch", "feat", "--path", join(f.b.worktrees, "feat")], d)).toBe(2);
		expect(seen.git).toHaveLength(0);
	});

	test("boundary: list over an unregistered root is refused and runs no git", async () => {
		const f = fixture();
		const { deps: d, seen } = deps(scopedEnv(f), f.root);
		expect(await runWorktree(["list", "--root", f.stray], d)).toBe(2);
		expect(seen.git).toHaveLength(0);
	});

	test("boundary: list over another repository's registered worktrees is refused and runs no git", async () => {
		const f = fixture();
		const { deps: d, seen } = deps(scopedEnv(f), f.root);
		expect(await runWorktree(["list", "--root", f.b.worktrees], d)).toBe(2);
		expect(seen.git).toHaveLength(0);
	});

	test("boundary: list --repo naming an ungranted repository is refused and runs no git", async () => {
		const f = fixture();
		const { deps: d, seen } = deps(scopedEnv(f), f.root);
		expect(await runWorktree(["list", "--repo", "owner/b", "--root", f.a.worktrees], d)).toBe(2);
		expect(seen.git).toHaveLength(0);
	});

	test("boundary: merge-back of a path in another repository is refused and runs no git", async () => {
		const f = fixture();
		const { deps: d, seen } = deps(scopedEnv(f), f.root);
		expect(await runWorktree(["merge-back", join(f.b.worktrees, "wt")], d)).toBe(2);
		expect(seen.git).toHaveLength(0);
	});

	test("boundary: guard of a path in another repository is refused and runs no git", async () => {
		const f = fixture();
		const { deps: d, seen } = deps(scopedEnv(f), f.root);
		expect(await runWorktree(["guard", f.b.checkout], d)).toBe(2);
		expect(seen.git).toHaveLength(0);
	});

	test("boundary: a symlink in a granted directory that points into another repository is refused and runs no git", async () => {
		const f = fixture();
		const link = join(f.a.worktrees, "to-b");
		symlinkSync(f.b.checkout, link);
		const { deps: d, seen } = deps(scopedEnv(f), f.root);
		expect(await runWorktree(["guard", link], d)).toBe(2);
		expect(seen.git).toHaveLength(0);
	});

	test("boundary: a refusal is audited with a digest of the requested path, never the path", async () => {
		const f = fixture();
		const { deps: d, seen } = deps(scopedEnv(f), f.root);
		await runWorktree(["guard", f.b.checkout], d);
		expect(seen.events).toHaveLength(1);
		const [event] = seen.events;
		expect(event?.payload).toMatchObject({ action: "repo.scope-refused", route: "worktree_guard", reason: "repo-not-granted" });
		expect(JSON.stringify(event)).not.toContain(f.b.checkout);
	});

	test("boundary: a malformed registry refuses the command before git, as it refuses the server boot", async () => {
		const f = fixture();
		const env = { [REPO_REGISTRY_ENV]: "not json", [REPO_SCOPES_ENV]: "{}" };
		const { deps: d, seen } = deps(env, f.root);
		expect(await runWorktree(["list", "--root", f.a.worktrees], d)).toBe(2);
		expect(seen.git).toHaveLength(0);
	});

	test("a root inside the granted repository is not refused by the scope", async () => {
		const f = fixture();
		const { deps: d, seen } = deps(scopedEnv(f), f.root);
		await runWorktree(["list", "--root", f.a.worktrees], d);
		expect(seen.events).toHaveLength(0);
		expect(seen.err.join("")).not.toContain("refused");
	});

	test("scoping off changes nothing: a root outside every registration is not refused by the scope", async () => {
		const f = fixture();
		const { deps: d, seen } = deps({ [REPO_REGISTRY_ENV]: f.registry }, f.root);
		await runWorktree(["list", "--root", f.stray], d);
		expect(seen.events).toHaveLength(0);
		expect(seen.err.join("")).not.toContain("refused");
	});
});
