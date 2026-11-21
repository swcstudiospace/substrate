import { loadConfig } from "./config.ts";
import { createObservability } from "./observe.ts";
import { Substrate } from "./service.ts";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeRepoAllowlist, repoAllowlistFromEnv, REPO_ALLOWLIST_ENV } from "./repo-allowlist.ts";
import { describeRepoScope, REPO_REGISTRY_ENV, REPO_SCOPES_ENV, REPO_SCOPE_OFF, repoScopeFromEnv, type RepoScope } from "./repo-scope.ts";
import { SURFACES } from "./types.ts";

function scopeWith(checkouts: string[], grants: Record<string, string[]> | null): RepoScope {
	const env: Record<string, string | undefined> = {
		[REPO_REGISTRY_ENV]: JSON.stringify({ "owner/a": { checkouts, worktrees: [] } }),
	};
	if (grants !== null) env[REPO_SCOPES_ENV] = JSON.stringify(grants);
	const parsed = repoScopeFromEnv(env);
	if (!parsed.ok) throw new Error(parsed.problem);
	return parsed.value;
}

describe("describeRepoScope", () => {
	test("enforced: registry roots, existence, grants including ungranted surfaces, refusals", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "repo-scope-status-")));
		const checkout = join(root, "checkout");
		mkdirSync(checkout);
		const scope = scopeWith([checkout, join(root, "missing")], { omp: ["owner/a"] });
		const described = describeRepoScope(scope, { byReason: { "repo-not-granted": 2 }, byRoute: { drift: 2 } });
		expect(described.enforced).toBe(true);
		expect(described.registry).toEqual([{ repo: "owner/a", rootCount: 2, rootsExist: [true, false] }]);
		expect(described.grants).toHaveLength(SURFACES.length);
		expect(described.grants.find((g) => g.surface === "omp")?.repos).toEqual(["owner/a"]);
		expect(described.grants.find((g) => g.surface === "cursor")?.repos).toEqual([]);
		expect(described.refusals).toEqual({ byReason: { "repo-not-granted": 2 }, byRoute: { drift: 2 } });
		expect(JSON.stringify(described)).not.toContain(checkout);
	});

	test("off: enforced is false, registry still described, grants empty for every surface", () => {
		const described = describeRepoScope(REPO_SCOPE_OFF);
		expect(described.enforced).toBe(false);
		expect(described.registry).toEqual([]);
		expect(described.grants).toHaveLength(SURFACES.length);
		expect(described.grants.every((g) => g.repos.length === 0)).toBe(true);
		expect(described.refusals).toEqual({ byReason: {}, byRoute: {} });
	});

	test("missing root: a directory that does not exist is reported false, never a path", () => {
		const scope = scopeWith(["/definitely/not/here"], null);
		const described = describeRepoScope(scope);
		expect(described.registry).toEqual([{ repo: "owner/a", rootCount: 1, rootsExist: [false] }]);
		expect(JSON.stringify(described)).not.toContain("/definitely/not/here");
	});
});

describe("describeRepoAllowlist", () => {
	test("names and presence only: the credential value never appears", () => {
		const secret = "super-secret-credential-value";
		const parsed = repoAllowlistFromEnv({
			[REPO_ALLOWLIST_ENV]: JSON.stringify({ "sess-1": { "owner/a": "CRED_A", "owner/b": "CRED_B" } }),
		});
		if (!parsed.ok) throw new Error(parsed.problem);
		const described = describeRepoAllowlist(parsed.value, { CRED_A: secret, CRED_B: "" });
		expect(described.sessionCount).toBe(1);
		expect(described.perSession).toEqual({
			"sess-1": {
				"owner/a": { credentialEnvName: "CRED_A", envSet: true },
				"owner/b": { credentialEnvName: "CRED_B", envSet: false },
			},
		});
		expect(JSON.stringify(described)).not.toContain(secret);
	});

	test("empty allowlist: zero sessions", () => {
		const described = describeRepoAllowlist(new Map(), {});
		expect(described).toEqual({ sessionCount: 0, perSession: {} });
	});
});

describe("repoScopeStatus gating", () => {
	test("non-operator: refused 403 operator-required, nothing described", async () => {
		const config = loadConfig({ SUBSTRATE_REPO_SCOPES: JSON.stringify({ omp: ["owner/a"] }) });
		const observability = createObservability(config, {});
		await observability.start();
		try {
			const substrate = new Substrate(config, { index: null, greptime: null }, observability.observer);
			const refused = substrate.repoScopeStatus("omp", false, {});
			expect(refused.status).toBe(403);
			expect(refused.body).toMatchObject({ ok: false, reason: "operator-required" });
			expect(JSON.stringify(refused.body)).not.toContain("owner/a");
			const allowed = substrate.repoScopeStatus("omp", true, { [REPO_ALLOWLIST_ENV]: "{}" });
			expect(allowed.status).toBe(200);
			expect(allowed.body).toMatchObject({ ok: true, enforced: true });
		} finally {
			observability.stop();
		}
	});
});
