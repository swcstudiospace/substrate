/**
 * `memory_recall` proven against the fake banks server (D26-03, D26-05).
 *
 * Fan-out bound, shared-budget degradation, source-bank attribution, derived
 * framing, redacted hits, empty-plus-reason on outage — and the two negative
 * gates: no shared-bank fallback for unlisted surfaces, and no
 * `planes/hindsight` import in the brief's synchronous compose path.
 */
import { describe, expect, test } from "bun:test";
import { auditMode } from "../../audit/src/policy.ts";
import { HindsightFake } from "./hindsight-fake.ts";
import { recallMemories, resolveRecallBanks, UNTRUSTED_MEMORY_NOTICE, type RecallDeps } from "./memory-recall.ts";
import { mergeDerivedHits } from "./memory-search.ts";
import { normalizeRoute, toolLabel } from "./observe.ts";
import type { HindsightConfig } from "./planes/hindsight.ts";
import type { MemoryEntry } from "./types.ts";

const CONFIG: HindsightConfig = { url: "http://fake", apiKey: "test-bearer", bankPrefix: "sub-" };

function deps(fake: HindsightFake, banks: string[] | null = ["sub-hermes"]): RecallDeps {
	return { config: CONFIG, banks, fetchImpl: fake.fetch, budgetMs: 2000 };
}

function seedTwo(fake: HindsightFake): void {
	fake.seed("sub-cursor", [
		{ id: "c1", text: "fence the lease before handoff", document_id: "mwd_c1", tags: ["cursor"], metadata: {}, score: 0.5 },
	]);
	fake.seed("sub-hermes", [
		{ id: "h1", text: "quote versions in conflicts", document_id: "mwd_h1", tags: ["hermes"], metadata: {}, score: 0.9 },
		{ id: "h2", text: "deploy password: hunter2", document_id: "mwd_h2", tags: ["hermes"], metadata: {}, score: 0.1 },
	]);
}

describe("resolveRecallBanks", () => {
	test("the caller's bank leads the configured set", () => {
		expect(resolveRecallBanks("cursor", ["sub-hermes", "sub-cursor"], "sub-")).toEqual({
			banks: ["sub-cursor", "sub-hermes"],
		});
	});

	test("a caller alone still reads its own bank", () => {
		expect(resolveRecallBanks("cursor", null, "sub-")).toEqual({ banks: ["sub-cursor"] });
	});

	test("an unlisted surface is refused, never given a shared bank", () => {
		const resolved = resolveRecallBanks("nope", null, "sub-");
		expect("refused" in resolved).toBe(true);
	});

	test("an unknown caller reads an explicit configured set", () => {
		expect(resolveRecallBanks(null, ["sub-hermes"], "sub-")).toEqual({ banks: ["sub-hermes"] });
	});

	test("configured desk banks never enter the fan-out set", () => {
		expect(resolveRecallBanks("cursor", ["sub-hermes", "pd-desk"], "sub-")).toEqual({ banks: ["sub-cursor", "sub-hermes"] });
		expect(resolveRecallBanks(null, ["pd-desk"], "sub-")).toEqual({
			refused: "no recall bank for surface unattributed: configure HINDSIGHT_BANKS",
		});
	});
});

describe("recallMemories", () => {
	test("fans out over the bank set with source attribution and derived framing", async () => {
		const fake = new HindsightFake();
		seedTwo(fake);
		const reply = await recallMemories(deps(fake), "lease", "cursor");
		expect(reply.degraded).toBe(false);
		expect(reply.notice).toBe(UNTRUSTED_MEMORY_NOTICE);
		expect(reply.results.map((hit) => `${hit.bank}:${hit.document_id}`)).toEqual([
			"sub-hermes:mwd_h1",
			"sub-cursor:mwd_c1",
			"sub-hermes:mwd_h2",
		]);
		for (const hit of reply.results) expect(hit.derived).toBe(true);
		const paths = fake.requests.map((request) => request.path);
		expect(paths.filter((path) => path.endsWith("/memories/recall")).length).toBe(2);
		expect(paths[0]).toContain("/banks/sub-cursor/");
	});

	test("hits are redacted before reply", async () => {
		const fake = new HindsightFake();
		seedTwo(fake);
		const reply = await recallMemories(deps(fake), "deploy", "cursor");
		const leaked = reply.results.filter((hit) => hit.text.includes("hunter2"));
		expect(leaked).toEqual([]);
		const redacted = reply.results.find((hit) => hit.document_id === "mwd_h2");
		expect(redacted?.text).toContain("[REDACTED]");
	});

	test("one slow bank degrades to a partial result under the shared budget", async () => {
		const fake = new HindsightFake();
		seedTwo(fake);
		fake.recallDelayMs["sub-hermes"] = 30_000;
		const reply = await recallMemories({ ...deps(fake), budgetMs: 100 }, "lease", "cursor");
		expect(reply.degraded).toBe(true);
		expect(reply.reason).toContain("sub-hermes");
		expect(reply.results.map((hit) => hit.bank)).toEqual(["sub-cursor"]);
	});

describe("registration", () => {
	test("the decided fail-open policy covers the new tool and route names", () => {
		expect(toolLabel("memory_recall")).toBe("memory_recall");
		expect(normalizeRoute("/memory/recall")).toBe("/memory/recall");
		expect(auditMode("memory_recall")).toBe("fail-open");
	});
});

	test("an outage yields empty plus reason, never a throw", async () => {
		const fake = new HindsightFake();
		seedTwo(fake);
		fake.failRecallWith = 500;
		const reply = await recallMemories(deps(fake), "lease", "cursor");
		expect(reply).toMatchObject({ results: [], degraded: true });
		expect(typeof reply.reason).toBe("string");
	});

	test("an empty query and a missing plane make no network call", async () => {
		const fake = new HindsightFake();
		seedTwo(fake);
		const empty = await recallMemories(deps(fake), "", "cursor");
		expect(empty).toMatchObject({ results: [], degraded: true });
		const unconfigured = await recallMemories({ ...deps(fake), config: null }, "lease", "cursor");
		expect(unconfigured).toMatchObject({ results: [], degraded: false, reason: "hindsight is not configured" });
		expect(fake.requests.length).toBe(0);
	});

	test("an unlisted surface with no configured set is refused without a call", async () => {
		const fake = new HindsightFake();
		seedTwo(fake);
		const reply = await recallMemories({ ...deps(fake), banks: null }, "lease", "nope");
		expect(reply).toMatchObject({ results: [], degraded: true });
		expect(reply.reason).toContain("nope");
		expect(fake.requests.length).toBe(0);
	});
	test("a guest never sends queries to the plane", async () => {
		const fake = new HindsightFake();
		seedTwo(fake);
		const reply = await recallMemories({ ...deps(fake), vmGuest: true }, "lease", "cursor");
		expect(reply).toMatchObject({ results: [], degraded: true, reason: "vm-guest" });
		expect(fake.requests.length).toBe(0);
	});

});

describe("anti-pattern gates", () => {
	test("the brief's compose path, its profiles and the recall snapshot never import the Hindsight client", async () => {
		// The brief reads recall ONLY from the `recall-snapshot` cache class, through a function the
		// service injects; none of the three modules may reach the plane.
		for (const file of ["./brief.ts", "./brief-profile.ts", "./recall-snapshot.ts"]) {
			const body = await Bun.file(new URL(file, import.meta.url)).text();
			const offenders = body.split("\n").filter((line) => /planes\/hindsight/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line));
			expect({ file, offenders }).toEqual({ file, offenders: [] });
		}
	});
});

describe("derived merge into memory_search", () => {
	const indexed: MemoryEntry[] = [
		{
			id: "mem_idx",
			scope: "repo:acme/app",
			kind: "fact",
			text: "the index is the governed store",
			writer: "cursor",
			actor: "agent",
			trust: "agent-claimed",
			ttl: "30d",
			created: "2026-10-10T00:00:00.000Z",
			version: 1,
			entry_hash: "hash_idx",
			needs_reverification: false,
		},
	];

	test("attribution survives the merge with index results first and unmarked", async () => {
		const fake = new HindsightFake();
		seedTwo(fake);
		const merged = mergeDerivedHits(indexed, await recallMemories(deps(fake), "lease", "cursor"), undefined, { surface: "cursor", repo: null });
		expect(merged.entries).toEqual(indexed);
		const first = merged.entries.at(0);
		expect(first).toEqual(indexed.at(0));
		expect(first !== undefined && "derived" in first).toBe(false);
		expect(merged.derived.map((hit) => `${hit.bank}:${hit.document_id}`)).toEqual([
			"sub-hermes:mwd_h1",
			"sub-cursor:mwd_c1",
			"sub-hermes:mwd_h2",
		]);
		for (const hit of merged.derived) expect(hit.derived).toBe(true);
		expect(merged.degraded).toBe(false);
	});

	test("an outage degrades to index-only with a reason", async () => {
		const fake = new HindsightFake();
		seedTwo(fake);
		fake.failRecallWith = 500;
		const merged = mergeDerivedHits(indexed, await recallMemories(deps(fake), "lease", "cursor"), undefined, { surface: "cursor", repo: null });
		expect(merged.entries).toEqual(indexed);
		expect(merged.derived).toEqual([]);
		expect(merged.degraded).toBe(true);
		expect(typeof merged.reason).toBe("string");
	});
});

describe("scoped merge", () => {
	test("a requested scope filters the plane leg to retained scopes", async () => {
		const fake = new HindsightFake();
		fake.seed("sub-cursor", [
			{ id: "c1", text: "fence the lease", document_id: "mwd_c1", tags: ["cursor"], metadata: { scope: "repo:acme/app" }, score: 0.5 },
		]);
		fake.seed("sub-hermes", [
			{ id: "h1", text: "another repo rule", document_id: "mwd_h1", tags: ["hermes"], metadata: { scope: "repo:other" }, score: 0.9 },
		]);
		const reply = await recallMemories(deps(fake), "rule", "cursor");
		expect(reply.results.map((hit) => hit.bank)).toEqual(["sub-hermes", "sub-cursor"]);
		const scoped = mergeDerivedHits([], reply, "repo:acme/app", { surface: "cursor", repo: null });
		expect(scoped.derived.map((hit) => `${hit.bank}:${hit.scope}`)).toEqual(["sub-cursor:repo:acme/app"]);
		const unscoped = mergeDerivedHits([], reply, undefined, { surface: "cursor", repo: null });
		expect(unscoped.derived.length).toBe(2);
	});

	test("an agent's derived hit reaches only its own surface, in the repo it was retained for", async () => {
		const fake = new HindsightFake();
		fake.seed("sub-hermes", [
			{ id: "h1", text: "hermes private note", document_id: "mwd_h1", tags: ["hermes"], metadata: { scope: "agent:hermes", repo: "acme/app" }, score: 0.9 },
			{ id: "h2", text: "shared repo rule", document_id: "mwd_h2", tags: ["hermes"], metadata: { scope: "repo:acme/app" }, score: 0.8 },
			{ id: "h3", text: "hermes note from another repo", document_id: "mwd_h3", tags: ["hermes"], metadata: { scope: "agent:hermes", repo: "other/repo" }, score: 0.7 },
		]);
		const texts = (hits: Array<{ text: string }>) => hits.map((hit) => hit.text).sort();
		const reply = await recallMemories(deps(fake), "rule", "cursor");
		expect(texts(mergeDerivedHits([], reply, undefined, { surface: "omp", repo: "acme/app" }).derived)).toEqual(["shared repo rule"]);
		expect(mergeDerivedHits([], reply, "agent:hermes", { surface: "omp", repo: "acme/app" }).derived).toEqual([]);
		const asHermes = await recallMemories(deps(fake), "rule", "hermes", "acme/app");
		expect(texts(mergeDerivedHits([], asHermes, undefined, { surface: "hermes", repo: "acme/app" }).derived)).toEqual([
			"hermes private note",
			"shared repo rule",
		]);
		const noRepo = await recallMemories(deps(fake), "rule", "hermes");
		expect(texts(mergeDerivedHits([], noRepo, undefined, { surface: "hermes", repo: null }).derived)).toEqual(["shared repo rule"]);
	});

	test("a private copy that outscores a shared one does not hide the shared one", async () => {
		const fake = new HindsightFake();
		fake.seed("sub-hermes", [
			{ id: "p1", text: "fence the lease", document_id: "mwd_p1", tags: ["hermes"], metadata: { scope: "agent:hermes" }, score: 0.9 },
			{ id: "s1", text: "fence the lease", document_id: "mwd_s1", tags: ["hermes"], metadata: { scope: "repo:acme/app" }, score: 0.5 },
		]);
		const reply = await recallMemories(deps(fake), "lease", "cursor");
		expect(reply.results.map((hit) => hit.scope)).toEqual(["repo:acme/app"]);
	});
});
