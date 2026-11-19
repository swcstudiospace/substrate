import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { DerivedMemoryHit, RecallReply } from "./memory-recall.ts";
import { mergeDerivedHits } from "./memory-search.ts";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	authorizeRepo,
	authorizeRepoPath,
	grantedRepos,
	isGranted,
	parseRepoRegistry,
	parseRepoScopes,
	REPO_REGISTRY_ENV,
	REPO_SCOPE_OFF,
	REPO_SCOPES_ENV,
	type RepoScope,
	refusalDigest,
	repoRefusalPayload,
	repoScopeFromEnv,
	resolveContained,
} from "./repo-scope.ts";

/** One repository's directories on disk. */
interface RepoDirs {
	checkout: string;
	worktrees: string;
}

/** Two repositories on disk: `a` and `b`, each with a checkout and a worktrees directory. Paths are real, so symlinks resolve. */
interface Layout {
	root: string;
	a: RepoDirs;
	b: RepoDirs;
}

function layout(): Layout {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "repo-scope-")));
	const make = (name: string) => {
		const checkout = join(root, name, "checkout");
		const worktrees = join(root, name, "worktrees");
		mkdirSync(checkout, { recursive: true });
		mkdirSync(worktrees, { recursive: true });
		return { checkout, worktrees };
	};
	return { root, a: make("a"), b: make("b") };
}

function registryJson(fixture: Layout): string {
	return JSON.stringify({
		"owner/a": { checkouts: [fixture.a.checkout], worktrees: [fixture.a.worktrees] },
		"owner/b": { checkouts: [fixture.b.checkout], worktrees: [fixture.b.worktrees] },
	});
}

function scopeFor(fixture: Layout, grants: Record<string, string[]> | null): RepoScope {
	const env: Record<string, string | undefined> = { [REPO_REGISTRY_ENV]: registryJson(fixture) };
	if (grants !== null) env[REPO_SCOPES_ENV] = JSON.stringify(grants);
	const parsed = repoScopeFromEnv(env);
	if (!parsed.ok) throw new Error(parsed.problem);
	return parsed.value;
}

describe("parseRepoRegistry", () => {
	test("boundary: a key that is not lowercase owner/name is refused, not normalised", () => {
		expect(parseRepoRegistry(JSON.stringify({ "Owner/Name": { checkouts: [], worktrees: [] } })).ok).toBe(false);
	});

	test("boundary: a relative directory is refused, never guessed at", () => {
		expect(parseRepoRegistry(JSON.stringify({ "owner/a": { checkouts: ["relative/dir"], worktrees: [] } })).ok).toBe(false);
	});

	test("boundary: two repositories may not share or nest a directory", () => {
		const shared = JSON.stringify({ "owner/a": { checkouts: ["/srv/x"], worktrees: [] }, "owner/b": { checkouts: [], worktrees: ["/srv/x/inner"] } });
		expect(parseRepoRegistry(shared).ok).toBe(false);
	});

	test("boundary: an entry takes only checkouts and worktrees", () => {
		expect(parseRepoRegistry(JSON.stringify({ "owner/a": { checkouts: [], worktrees: [], token: "x" } })).ok).toBe(false);
	});

	test("an unset registry is empty and valid; a valid one is read as registered", () => {
		expect(parseRepoRegistry(undefined)).toEqual({ ok: true, value: new Map() });
		const parsed = parseRepoRegistry(JSON.stringify({ "owner/a": { checkouts: ["/srv/a"], worktrees: ["/srv/a-wt"] } }));
		expect(parsed.ok && parsed.value.get("owner/a")).toEqual({ repo: "owner/a", checkouts: ["/srv/a"], worktrees: ["/srv/a-wt"] });
	});
});

describe("parseRepoScopes", () => {
	test("boundary: a key that names no surface is refused", () => {
		expect(parseRepoScopes(JSON.stringify({ "no-such-surface": ["owner/a"] })).ok).toBe(false);
	});

	test("boundary: a repository that is not canonical owner/name is refused", () => {
		expect(parseRepoScopes(JSON.stringify({ omp: ["Owner/A"] })).ok).toBe(false);
		expect(parseRepoScopes(JSON.stringify({ omp: ["no-slash"] })).ok).toBe(false);
	});

	test("a valid object grants each surface its repositories", () => {
		const parsed = parseRepoScopes(JSON.stringify({ omp: ["owner/a", "owner/b"], cursor: [] }));
		expect(parsed.ok && [...(parsed.value.get("omp") ?? [])]).toEqual(["owner/a", "owner/b"]);
	});
});

describe("repoScopeFromEnv", () => {
	test("unset scopes is scoping off, with the registry still read", () => {
		const parsed = repoScopeFromEnv({});
		expect(parsed.ok && parsed.value.enforced).toBe(false);
	});

	test("set scopes is enforcement, and a malformed registry refuses even with scopes unset", () => {
		expect(repoScopeFromEnv({ [REPO_SCOPES_ENV]: "{}" })).toMatchObject({ ok: true, value: { enforced: true } });
		expect(repoScopeFromEnv({ [REPO_REGISTRY_ENV]: "not json" }).ok).toBe(false);
	});
});

describe("authorizeRepo", () => {
	const fixture = layout();

	test("boundary: scoping off grants every repository, as before", () => {
		const scope = scopeFor(fixture, null);
		expect(authorizeRepo(scope, null, "anyone/else")).toEqual({ ok: true, repo: "anyone/else", target: null });
	});

	test("boundary: a surface is refused a repository outside its grant", () => {
		const scope = scopeFor(fixture, { omp: ["owner/a"] });
		expect(authorizeRepo(scope, "omp", "owner/a").ok).toBe(true);
		expect(authorizeRepo(scope, "omp", "owner/b")).toEqual({ ok: false, reason: "repo-not-granted" });
	});

	test("boundary: an anonymous caller holds no grant, and a surface missing from the scopes object holds none", () => {
		const scope = scopeFor(fixture, { omp: ["owner/a"] });
		expect(authorizeRepo(scope, null, "owner/a")).toEqual({ ok: false, reason: "repo-not-granted" });
		expect(authorizeRepo(scope, "cursor", "owner/a")).toEqual({ ok: false, reason: "repo-not-granted" });
	});

	test("a name that is not owner/name is refused under scoping, whatever the grant", () => {
		const scope = scopeFor(fixture, { omp: ["owner/a"] });
		expect(authorizeRepo(scope, "omp", "")).toEqual({ ok: false, reason: "repo-not-granted" });
	});
});

describe("authorizeRepoPath", () => {
	const fixture = layout();

	test("boundary: a path inside a granted repository's registered directory is placed in that repository", () => {
		const scope = scopeFor(fixture, { omp: ["owner/a"] });
		const gate = authorizeRepoPath(scope, "omp", join(fixture.a.checkout, "src"), null);
		expect(gate).toEqual({ ok: true, repo: "owner/a", target: join(fixture.a.checkout, "src") });
	});

	test("boundary: a new directory under a granted worktrees directory is placed before it exists", () => {
		const scope = scopeFor(fixture, { omp: ["owner/a"] });
		const fresh = join(fixture.a.worktrees, "new-branch");
		expect(authorizeRepoPath(scope, "omp", fresh, null)).toEqual({ ok: true, repo: "owner/a", target: fresh });
	});

	test("boundary: a dot-dot path that leaves the granted registration is placed where it really lands", () => {
		const scope = scopeFor(fixture, { omp: ["owner/a"] });
		const outside = join(fixture.a.worktrees, "..", "..", "b", "checkout");
		expect(authorizeRepoPath(scope, "omp", outside, null)).toEqual({ ok: false, reason: "repo-not-granted" });
	});

	test("boundary: a symlink inside a granted directory that points into another repository is refused", () => {
		const link = join(fixture.a.worktrees, "link-to-b");
		symlinkSync(fixture.b.checkout, link);
		const scope = scopeFor(fixture, { omp: ["owner/a"] });
		expect(authorizeRepoPath(scope, "omp", link, null)).toEqual({ ok: false, reason: "repo-not-granted" });
	});

	test("boundary: a path inside no registration is refused before anything is read", () => {
		const scope = scopeFor(fixture, { omp: ["owner/a"] });
		expect(authorizeRepoPath(scope, "omp", join(fixture.root, "stray"), null)).toEqual({ ok: false, reason: "path-not-registered" });
	});

	test("boundary: a repository named that does not own the path is a mismatch, after the grant check", () => {
		const scope = scopeFor(fixture, { omp: ["owner/a", "owner/b"] });
		expect(authorizeRepoPath(scope, "omp", fixture.a.checkout, "owner/b")).toEqual({ ok: false, reason: "path-repo-mismatch" });
	});

	test("scoping off places nothing and refuses nothing, as before", () => {
		expect(authorizeRepoPath(REPO_SCOPE_OFF, null, join(fixture.root, "stray"), null)).toEqual({ ok: true, repo: null, target: null });
	});
});

describe("resolveContained", () => {
	test("a relative path and a NUL byte resolve to nothing", () => {
		expect(resolveContained("relative/x")).toBeNull();
		expect(resolveContained("/tmp/a\0b")).toBeNull();
	});
});

describe("grantedRepos and isGranted", () => {
	const fixture = layout();

	test("unscoped is unrestricted (null); anonymous is an empty list; a surface gets its sorted grant", () => {
		expect(grantedRepos(REPO_SCOPE_OFF, null)).toBeNull();
		const scope = scopeFor(fixture, { omp: ["owner/b", "owner/a"] });
		expect(grantedRepos(scope, null)).toEqual([]);
		expect(grantedRepos(scope, "omp")).toEqual(["owner/a", "owner/b"]);
		expect(isGranted(scope, "omp", "owner/a")).toBe(true);
		expect(isGranted(REPO_SCOPE_OFF, null, "owner/a")).toBe(true);
	});
});

describe("refusal audit", () => {
	test("boundary: the audit carries a digest of the requested path, never the path", () => {
		const requested = "/var/lib/private/owner-secret-checkout";
		const payload = repoRefusalPayload("drift", "repo-not-granted", requested);
		expect(JSON.stringify(payload)).not.toContain("private");
		expect(payload).toEqual({ action: "repo.scope-refused", route: "drift", reason: "repo-not-granted", requested_sha256: refusalDigest(requested) });
		expect(refusalDigest(requested)).toHaveLength(16);
	});
});

describe("review findings on the registry, the scopes variable and the digest", () => {
	test("RS-14: two registrations that name the same directory through a symlink are refused at boot", () => {
		const f = layout();
		const alias = join(f.root, "alias-of-a");
		symlinkSync(f.a.checkout, alias);
		const registry = JSON.stringify({ "owner/a": { checkouts: [f.a.checkout], worktrees: [] }, "owner/b": { checkouts: [alias], worktrees: [] } });
		expect(parseRepoRegistry(registry).ok).toBe(false);
	});

	test("RS-15: a blank scopes variable is malformed, so the boot refuses rather than scoping off", () => {
		expect(repoScopeFromEnv({ [REPO_SCOPES_ENV]: "   " }).ok).toBe(false);
	});

	test("RS-17: the refusal digest is keyed, so it is not the unkeyed hash of the requested value", () => {
		const requested = "/var/lib/private/owner-secret-checkout";
		expect(refusalDigest(requested)).not.toBe(createHash("sha256").update(requested).digest("hex").slice(0, 16));
		expect(refusalDigest(requested)).toBe(refusalDigest(requested));
	});
});

describe("RS-07: derived memory hits are filtered by the grant", () => {
	const hit = (id: string, scope: string, repo: string): DerivedMemoryHit => ({ bank: "b", id, text: id, derived: true, scope, repo, tags: [] });

	test("boundary: a derived hit from an ungranted repository is absent from the merged reply, and a granted one is present", () => {
		const recall: RecallReply = {
			results: [hit("granted", "repo:owner/a", "owner/a"), hit("ungranted", "repo:owner/b", "owner/b")],
			degraded: false,
			notice: "",
		};
		const granted = (repo: string) => repo === "owner/a";
		const merged = mergeDerivedHits([], recall, undefined, { surface: "omp", repo: "owner/a", granted });
		expect(merged.derived.map((item) => item.id)).toEqual(["granted"]);
	});

	test("boundary: a graph-scoped derived hit with no repository is absent under scope, since its repository cannot be read", () => {
		const recall: RecallReply = {
			results: [{ bank: "b", id: "graph-hit", text: "x", derived: true, scope: "graph:ut-x", tags: [] }],
			degraded: false,
			notice: "",
		};
		const merged = mergeDerivedHits([], recall, undefined, { surface: "omp", repo: "owner/a", granted: () => true });
		expect(merged.derived).toEqual([]);
	});

	test("scoping off: the same hits are all returned, as before", () => {
		const recall: RecallReply = {
			results: [hit("a", "repo:owner/a", "owner/a"), hit("b", "repo:owner/b", "owner/b")],
			degraded: false,
			notice: "",
		};
		const merged = mergeDerivedHits([], recall, undefined, { surface: "omp", repo: "owner/a" });
		expect(merged.derived.map((item) => item.id)).toEqual(["a", "b"]);
	});
});
