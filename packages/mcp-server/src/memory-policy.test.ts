import { describe, expect, test } from "bun:test";
import {
	allowedForWriter,
	conflictKey,
	conflictPlan,
	DEFAULT_GRANTS,
	grantFor,
	isTerminalGraphStatus,
	MEMORY_TTL_30D_MS,
	memoryExpiry,
	memoryGraphId,
	needsReverification,
	normalizeSubject,
	parseGrants,
	parseScope,
	resolveActor,
	resolveTrust,
	reverifyAfter,
	TRUST_SHELF_LIFE_DAYS,
	type MemoryGrant,
} from "./memory-policy.ts";
import { TERMINAL_GRAPH_STATUSES } from "./index-sweep.ts";
import { MEMORY_KINDS, type MemoryKind, type MemoryScope } from "./types.ts";

/** Shorthand: the parsed scope, asserted non-null so a typo in a test fails loudly. */
function scope(raw: string): MemoryScope {
	const parsed = parseScope(raw);
	if (!parsed) throw new Error(`test used an unparseable scope: ${raw}`);
	return parsed;
}

describe("parseScope", () => {
	test("reads the five families", () => {
		expect(parseScope("global")).toEqual({ class: "global", id: null, canonical: "global" });
		expect(parseScope("graph:ut-1")).toEqual({ class: "graph", id: "ut-1", canonical: "graph:ut-1" });
		expect(parseScope("repo:swcstudiospace/agent-substrate")?.class).toBe("repo");
		expect(parseScope("agent:hermes")).toEqual({ class: "agent", id: "hermes", canonical: "agent:hermes" });
		expect(parseScope("person:ove")?.class).toBe("person");
	});

	test("refuses anything it cannot classify, so a typo is a denial and not a new namespace", () => {
		// The failure this prevents: `repos:foo` sailing past a policy keyed on scope
		// class, and becoming an ungoverned scope nothing has a rule for.
		expect(parseScope("repos:foo")).toBeNull();
		expect(parseScope("REPO")).toBeNull();
		expect(parseScope("graph:")).toBeNull();
		expect(parseScope(":ut-1")).toBeNull();
		expect(parseScope("")).toBeNull();
		expect(parseScope(undefined)).toBeNull();
		expect(parseScope(42)).toBeNull();
	});

	test("global takes no id", () => {
		// `global:anything` is a caller reaching for a scope that does not exist.
		expect(parseScope("global:everything")).toBeNull();
	});

	test("an agent id folds case, because it names a surface", () => {
		// The `self` rule compares it against the writer, so `agent:HERMES` written by
		// `hermes` has to be that agent's own scope and not a denial nobody can explain.
		expect(parseScope("agent:HERMES")?.canonical).toBe("agent:hermes");
		expect(grantFor("hermes", scope("agent:HERMES"), "fact")?.name).toBe("agent-self");
	});

	test("a repo id keeps its case, because the brief reads the original spelling", () => {
		// GitHub slugs can carry case. Lowercasing the write while memoryForBrief queries
		// what the caller passed is the lookup-that-never-matches bug.
		expect(parseScope("repo:swcstudiospace/AutonoGrammer")?.canonical).toBe("repo:swcstudiospace/AutonoGrammer");
	});

	test("normalises the id the same way every other query key is", () => {
		// The scope is written by the gate and read by memoryForBrief; a raw form here
		// and a cleaned one there is the lookup-that-never-matches bug all over again.
		expect(parseScope("  GRAPH:ut-1  ")?.canonical).toBe("graph:ut-1");
		expect(parseScope(`repo:${"x".repeat(900)}`)?.id?.length).toBe(512);
	});

	test("strips a credential out of the scope itself", () => {
		const parsed = parseScope("graph:GITHUB_TOKEN=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
		expect(parsed?.id).not.toContain("ghp_");
	});
});

describe("default-deny RBAC", () => {
	test("a known surface writes the working scopes", () => {
		expect(grantFor("hermes", scope("graph:ut-1"), "decision")?.name).toBe("graph-any");
		expect(grantFor("omp", scope("repo:a/b"), "warning")?.name).toBe("repo-working");
		expect(grantFor("cursor", scope("global"), "fact")?.name).toBe("global-standing");
	});

	test("an unrecognised writer matches no wildcard at all", () => {
		// This is the teeth. An MCP caller with no bearer token arrives as `unknown`,
		// and default-deny has to mean it writes nothing rather than everything `*`
		// covers.
		for (const kind of MEMORY_KINDS) {
			expect(grantFor("unknown", scope("graph:ut-1"), kind)).toBeNull();
			expect(grantFor("unknown", scope("global"), kind)).toBeNull();
		}
		expect(allowedForWriter("unknown")).toEqual([]);
	});

	test("person scope is granted to nobody by default", () => {
		// A note about a human is not an agent's to write.
		for (const kind of MEMORY_KINDS) {
			expect(grantFor("hermes", scope("person:ove"), kind)).toBeNull();
		}
	});

	test("an agent scope is the writer's own or nothing", () => {
		expect(grantFor("hermes", scope("agent:hermes"), "fact")?.name).toBe("agent-self");
		expect(grantFor("hermes", scope("agent:omp"), "fact")).toBeNull();
	});

	test("the gaps in the grants are the policy", () => {
		// A global todo is nobody's todo; a repo-wide handoff addresses nobody and
		// would sit in every brief forever.
		expect(grantFor("hermes", scope("global"), "todo")).toBeNull();
		expect(grantFor("hermes", scope("global"), "handoff")).toBeNull();
		expect(grantFor("hermes", scope("repo:a/b"), "handoff")).toBeNull();
	});

	test("a denial can name what the writer could have written instead", () => {
		const allowed = allowedForWriter("muse");
		expect(allowed.map((row) => row.scope).sort()).toEqual(["agent", "global", "graph", "repo"]);
		expect(allowed.find((row) => row.scope === "global")?.kinds).not.toContain("todo");
	});

	test("an operator grant widens, and is matched by name", () => {
		const grants: MemoryGrant[] = [
			...DEFAULT_GRANTS,
			{ name: "ove-person", surfaces: ["hermes"], scopes: ["person"], kinds: ["fact"] },
		];
		expect(grantFor("hermes", scope("person:ove"), "fact", grants)?.name).toBe("ove-person");
		// And only for the surface and kind it names.
		expect(grantFor("omp", scope("person:ove"), "fact", grants)).toBeNull();
		expect(grantFor("hermes", scope("person:ove"), "warning", grants)).toBeNull();
	});

	test("an explicitly named writer need not be a known surface", () => {
		// How an operator lets a surface the substrate does not know about write,
		// without the wildcard quietly letting in every other unknown caller too.
		const grants: MemoryGrant[] = [
			{ name: "codex-ish", surfaces: ["some-new-agent"], scopes: ["graph"], kinds: ["fact"] },
		];
		expect(grantFor("some-new-agent", scope("graph:ut-1"), "fact", grants)?.name).toBe("codex-ish");
		expect(grantFor("another-new-agent", scope("graph:ut-1"), "fact", grants)).toBeNull();
	});
});

describe("parseGrants", () => {
	function collect() {
		const warnings: string[] = [];
		return { warnings, warn: (message: string) => warnings.push(message) };
	}

	test("reads a well-formed grant", () => {
		const { warnings, warn } = collect();
		const grants = parseGrants('[{"name":"x","surfaces":["hermes"],"scopes":["person"],"kinds":["fact"]}]', warn);
		expect(grants).toEqual([{ name: "x", surfaces: ["hermes"], scopes: ["person"], kinds: ["fact"] }]);
		expect(warnings).toEqual([]);
	});

	test("drops junk rather than throwing, because the defaults are the stricter policy", () => {
		// Falling back to the defaults is the fail-closed direction, and a typo in one
		// grant must not stop substrate-mcp booting.
		const { warnings, warn } = collect();
		expect(parseGrants("not json", warn)).toEqual([]);
		expect(parseGrants('{"surfaces":["hermes"]}', warn)).toEqual([]);
		expect(parseGrants('[{"surfaces":["hermes"],"scopes":["nope"],"kinds":["fact"]}]', warn)).toEqual([]);
		expect(parseGrants('[{"surfaces":[],"scopes":["graph"],"kinds":["fact"]}]', warn)).toEqual([]);
		expect(warnings).toHaveLength(4);
	});

	test("filters unknown kinds out of an otherwise valid grant", () => {
		const { warn } = collect();
		const grants = parseGrants('[{"surfaces":["hermes"],"scopes":["graph"],"kinds":["fact","nonsense"]}]', warn);
		expect(grants[0]?.kinds).toEqual(["fact"]);
	});

	test("an empty or missing value configures nothing", () => {
		const { warnings, warn } = collect();
		expect(parseGrants(undefined, warn)).toEqual([]);
		expect(parseGrants("   ", warn)).toEqual([]);
		expect(warnings).toEqual([]);
	});
});

describe("conflictPlan", () => {
	test("global is reviewed whatever the kind", () => {
		expect(conflictPlan(scope("global"), "fact", false).requiresReview).toBe(true);
		expect(conflictPlan(scope("global"), "decision", true).requiresReview).toBe(true);
	});

	test("a decision is versioned and a todo is last-write-wins", () => {
		expect(conflictPlan(scope("repo:a/b"), "decision", true).resolve).toBe("versioned");
		expect(conflictPlan(scope("repo:a/b"), "todo", true).resolve).toBe("lww");
	});

	test("review and resolution are orthogonal", () => {
		// A global decision is reviewed *and*, once released, versioned.
		expect(conflictPlan(scope("global"), "decision", true)).toEqual({ resolve: "versioned", requiresReview: true });
	});

	test("without a subject there is nothing to collide on", () => {
		for (const kind of MEMORY_KINDS) {
			expect(conflictPlan(scope("repo:a/b"), kind, false).resolve).toBe("append");
		}
	});

	test("facts, warnings and handoffs accumulate even with a subject", () => {
		// Three warnings about one file are three warnings, not one overwriting two.
		for (const kind of ["fact", "warning", "handoff"] as MemoryKind[]) {
			expect(conflictPlan(scope("graph:ut-1"), kind, true).resolve).toBe("append");
		}
	});
});

describe("conflict identity", () => {
	test("is scope, kind and subject — never the text", () => {
		expect(conflictKey(scope("repo:a/b"), "todo", "lockfile")).toBe("repo:a/b|todo|lockfile");
		expect(conflictKey(scope("repo:a/b"), "decision", "lockfile")).not.toBe("repo:a/b|todo|lockfile");
	});

	test("is absent without a subject", () => {
		expect(conflictKey(scope("repo:a/b"), "todo", null)).toBeNull();
	});

	test("folds case, so a reworded subject still collides", () => {
		expect(normalizeSubject("  Runtime Choice  ")).toBe("runtime choice");
		expect(normalizeSubject("")).toBeNull();
		expect(normalizeSubject(undefined)).toBeNull();
		expect(normalizeSubject("x".repeat(500))?.length).toBe(200);
	});

	test("redacts before it caps, so a token across the cap is never stored as a fragment", () => {
		// The token starts before the 200th character and runs past it. Capping first would keep
		// `ghp_` and some of its letters, which no credential pattern would then recognise.
		const token = `ghp_${"a".repeat(40)}`;
		expect(normalizeSubject(`${"x".repeat(185)} ${token}`)).toBe(`${"x".repeat(185)} [redacted]`);
	});
});

describe("trust decay", () => {
	const created = new Date("2026-09-30T00:00:00.000Z");

	test("each level has a shelf life, and an agent's claim is the shortest", () => {
		expect(TRUST_SHELF_LIFE_DAYS["agent-claimed"]).toBeLessThan(TRUST_SHELF_LIFE_DAYS["verified-by-test"]);
		expect(TRUST_SHELF_LIFE_DAYS["verified-by-test"]).toBeLessThan(TRUST_SHELF_LIFE_DAYS["human-confirmed"]);
	});

	test("the deadline is the shelf life from the write", () => {
		expect(reverifyAfter("agent-claimed", created).toISOString()).toBe("2026-10-14T00:00:00.000Z");
		expect(reverifyAfter("human-confirmed", created).toISOString()).toBe("2027-03-29T00:00:00.000Z");
	});

	test("an entry decays where it sits, with no sweeper job", () => {
		const deadline = reverifyAfter("agent-claimed", created).toISOString();
		expect(needsReverification(deadline, created.getTime())).toBe(false);
		expect(needsReverification(deadline, created.getTime() + 13 * 86_400_000)).toBe(false);
		expect(needsReverification(deadline, created.getTime() + 15 * 86_400_000)).toBe(true);
	});

	test("a row with no deadline — one written before the gate — never reads as decayed", () => {
		// Phase 0 entries have a null column. Reporting every one of them as stale on
		// the day this ships would bury the ones that genuinely are.
		expect(needsReverification(null)).toBe(false);
		expect(needsReverification(undefined)).toBe(false);
		expect(needsReverification("not-a-date")).toBe(false);
	});
});

describe("an agent cannot vouch for itself", () => {
	test("human-confirmed takes a reviewer's token", () => {
		expect(resolveTrust({ requested: "human-confirmed", reviewed: false, sourceEventVerified: false })).toEqual({
			trust: "agent-claimed",
			downgradedFrom: "human-confirmed",
		});
		expect(resolveTrust({ requested: "human-confirmed", reviewed: true, sourceEventVerified: false })).toEqual({
			trust: "human-confirmed",
		});
	});

	test("verified-by-test takes provenance that was actually looked up", () => {
		// An unchecked event id is just a string. Granting the longer shelf life on the
		// strength of one would make `verified-by-test` a label rather than a claim.
		expect(resolveTrust({ requested: "verified-by-test", reviewed: false, sourceEventVerified: false })).toEqual({
			trust: "agent-claimed",
			downgradedFrom: "verified-by-test",
		});
		expect(resolveTrust({ requested: "verified-by-test", reviewed: false, sourceEventVerified: true })).toEqual({
			trust: "verified-by-test",
		});
	});

	test("agent-claimed is what an unadorned write gets", () => {
		expect(resolveTrust({ reviewed: false, sourceEventVerified: false })).toEqual({ trust: "agent-claimed" });
	});

	test("an actor: human claim is provenance too", () => {
		expect(resolveActor("human", false)).toBe("agent");
		expect(resolveActor("human", true)).toBe("human");
		expect(resolveActor(undefined, true)).toBe("agent");
	});
});

describe("memory lifetime (uplift-3 N4)", () => {
	const created = "2026-09-01T00:00:00.000Z";
	const at = (days: number): number => Date.parse(created) + days * 86_400_000;

	test("a 30d entry is alive on day 29 and expired on day 31, and says when", () => {
		const entry = { ttl: "30d", created };
		expect(memoryExpiry(entry, null, at(29))).toEqual({ expired: false, expires_at: "2026-10-01T00:00:00.000Z", reason: null });
		expect(memoryExpiry(entry, null, at(31))).toEqual({ expired: true, expires_at: "2026-10-01T00:00:00.000Z", reason: "30d" });
		// Inclusive at the instant, like `needsReverification`; the span is the constant the sweeper's cutoff also uses.
		expect(memoryExpiry(entry, null, at(30)).expired).toBe(true);
		expect(MEMORY_TTL_30D_MS).toBe(30 * 86_400_000);
		// The graph argument is irrelevant to a dated class.
		expect(memoryExpiry(entry, { status: "Merged" }, at(1)).expired).toBe(false);
	});

	test("a graph entry lives while its graph is open and dies with it or without it", () => {
		const entry = { ttl: "graph", created };
		expect(memoryExpiry(entry, { status: "In Progress" }, at(400))).toEqual({ expired: false, expires_at: null, reason: null });
		// A row registered without a status is open, as `openGraphs` reads it.
		expect(memoryExpiry(entry, { status: null }, at(400)).expired).toBe(false);
		expect(memoryExpiry(entry, { status: "Merged" }, at(0))).toEqual({ expired: true, expires_at: null, reason: "graph-terminal" });
		for (const status of TERMINAL_GRAPH_STATUSES) expect(memoryExpiry(entry, { status }, at(0)).reason).toBe("graph-terminal");
		// No row in graph_index: swept, or never registered — either way nothing to live for.
		expect(memoryExpiry(entry, null, at(0))).toEqual({ expired: true, expires_at: null, reason: "graph-unindexed" });
	});

	test("permanent, an undefined ttl and an undatable row never expire", () => {
		expect(memoryExpiry({ ttl: "permanent", created }, null, at(10_000)).expired).toBe(false);
		expect(memoryExpiry({ ttl: "permanent", created }, { status: "Merged" }, at(10_000)).expired).toBe(false);
		expect(memoryExpiry({ ttl: "forever", created }, null, at(10_000)).expired).toBe(false);
		expect(memoryExpiry({ ttl: "30d", created: "not-a-date" }, null, at(10_000))).toEqual({ expired: false, expires_at: null, reason: null });
	});

	test("the terminal list is the sweeper's, so the two cannot drift apart", () => {
		for (const status of TERMINAL_GRAPH_STATUSES) expect(isTerminalGraphStatus(status)).toBe(true);
		expect(isTerminalGraphStatus("In Progress")).toBe(false);
		expect(isTerminalGraphStatus("merged")).toBe(false);
		expect(isTerminalGraphStatus(null)).toBe(false);
		expect(isTerminalGraphStatus(undefined)).toBe(false);
	});

	test("the graph an entry lives for is its graph_id, else the tail of a graph: scope, else none", () => {
		expect(memoryGraphId({ scope: "repo:acme/app", graph_id: "ut-1" })).toBe("ut-1");
		expect(memoryGraphId({ scope: "graph:ut-2", graph_id: "ut-1" })).toBe("ut-1");
		expect(memoryGraphId({ scope: "graph:ut-2" })).toBe("ut-2");
		expect(memoryGraphId({ scope: "repo:acme/app" })).toBeNull();
		expect(memoryGraphId({ scope: "global" })).toBeNull();
		expect(memoryGraphId({ scope: "graph:" })).toBeNull();
	});
});
