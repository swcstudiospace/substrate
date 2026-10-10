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
import { normalizeRoute, toolLabel } from "./observe.ts";
import type { HindsightConfig } from "./planes/hindsight.ts";

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
});

describe("anti-pattern gates", () => {
	test("the brief's synchronous compose path never imports the Hindsight client", async () => {
		const body = await Bun.file(new URL("./brief.ts", import.meta.url)).text();
		const offenders = body.split("\n").filter((line) => /planes\/hindsight/.test(line));
		expect({ offenders }).toEqual({ offenders: [] });
	});
});
