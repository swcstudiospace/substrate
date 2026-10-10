/**
 * The Hindsight client proven against the fake banks server (D26-09).
 *
 * Every behavior the G1/G2 live probes will confirm is proven here first:
 * bearer carriage, bank-in-path, chunks ensure, both recall shapes,
 * timeout-as-Result, and errors that never leak the key or an array-detail.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { HindsightFake } from "../hindsight-fake.ts";
import {
	bankForSurface,
	clearEnsuredBanks,
	deleteBank,
	deleteDocument,
	ensureBank,
	getDocument,
	hindsightBanksFromEnv,
	hindsightFromEnv,
	patchDocumentTags,
	probeHealth,
	probeVersion,
	recallBank,
	retainMemories,
	type HindsightConfig,
} from "./hindsight.ts";

const CONFIG: HindsightConfig = { url: "http://fake", apiKey: "test-bearer", bankPrefix: "sub-" };

function setup(): HindsightFake {
	const fake = new HindsightFake();
	fake.seed("sub-cursor", [
		{ id: "m1", text: "fence the lease before handoff", document_id: "mwd_1", tags: ["cursor"], metadata: {}, score: 0.9 },
		{ id: "m2", text: "quote versions in conflicts", document_id: "mwd_2", tags: ["cursor"], metadata: {}, score: 0.4 },
	]);
	return fake;
}

beforeEach(() => {
	clearEnsuredBanks();
});

describe("hindsightFromEnv", () => {
	test("trims and strips trailing slashes, defaults the bank prefix", () => {
		const config = hindsightFromEnv({ HINDSIGHT_URL: " http://plane:8888// ", HINDSIGHT_API_KEY: " k " });
		expect(config).toEqual({ url: "http://plane:8888", apiKey: "k", bankPrefix: "sub-" });
	});

	test("honours an explicit bank prefix and parses the bank list", () => {
		const config = hindsightFromEnv({ HINDSIGHT_URL: "http://plane:8888", HINDSIGHT_API_KEY: "k", HINDSIGHT_BANK_PREFIX: "lab-" });
		expect(config?.bankPrefix).toBe("lab-");
		expect(hindsightBanksFromEnv({ HINDSIGHT_BANKS: "sub-cursor, sub-hermes\nsub-omp" })).toEqual(["sub-cursor", "sub-hermes", "sub-omp"]);
		expect(hindsightBanksFromEnv({})).toBeNull();
	});

	test("desk banks never enter the fan-out set", () => {
		expect(hindsightBanksFromEnv({ HINDSIGHT_BANKS: "sub-cursor, pd-desk, pd-lead" })).toEqual(["sub-cursor"]);
		expect(hindsightBanksFromEnv({ HINDSIGHT_BANKS: "pd-desk, pd-lead" })).toBeNull();
	});

	test("is null without a URL and key", () => {
		expect(hindsightFromEnv({})).toBeNull();
		expect(hindsightFromEnv({ HINDSIGHT_URL: "http://plane:8888" })).toBeNull();
	});

	test("banks are prefix plus surface", () => {
		expect(bankForSurface(CONFIG, "cursor")).toBe("sub-cursor");
	});
});

describe("probes", () => {
	test("health and version carry no bearer and parse", async () => {
		const fake = setup();
		const health = await probeHealth(CONFIG, fake.fetch);
		const version = await probeVersion(CONFIG, fake.fetch);
		expect(health).toEqual({ ok: true, value: { status: "healthy", database: "connected" } });
		expect(version).toEqual({ ok: true, value: { api_version: "0.9.1", features: { recall: true, retain: true } } });
		const probed = fake.requests.filter((request) => request.path === "/health" || request.path === "/version");
		expect(probed.length).toBe(2);
		for (const request of probed) expect(request.authed).toBe(false);
	});

	test("a minimal version still parses (U-01 version pair)", async () => {
		const fake = setup();
		fake.versionShape = "minimal";
		const version = await probeVersion(CONFIG, fake.fetch);
		expect(version).toEqual({ ok: true, value: { api_version: "unknown", features: {} } });
	});
});

describe("ensureBank", () => {
	test("a bank already in chunks mode costs one authed GET", async () => {
		const fake = setup();
		const ensured = await ensureBank(CONFIG, "sub-cursor", fake.fetch);
		expect(ensured).toEqual({ ok: true, value: { created: false } });
		expect(fake.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
			"GET /v1/default/banks/sub-cursor/config",
		]);
		for (const request of fake.requests) expect(request.authed).toBe(true);
	});

	test("a missing bank is created then pinned to chunks", async () => {
		const fake = setup();
		const ensured = await ensureBank(CONFIG, "sub-hermes", fake.fetch);
		expect(ensured).toEqual({ ok: true, value: { created: true } });
		expect(fake.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
			"GET /v1/default/banks/sub-hermes/config",
			"PUT /v1/default/banks/sub-hermes",
			"PATCH /v1/default/banks/sub-hermes/config",
		]);
		expect(fake.requests.at(-1)?.body).toEqual({ updates: { retain_extraction_mode: "chunks" } });
		expect(fake.banks.get("sub-hermes")?.mode).toBe("chunks");
	});

	test("pinning the mode of an existing bank is not creating it", async () => {
		const fake = setup();
		await fake.fetch("http://fake/v1/default/banks/sub-legacy", {
			method: "PUT",
			headers: { authorization: "Bearer test-bearer", "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(fake.banks.get("sub-legacy")?.mode).toBe("server-default");
		const ensured = await ensureBank(CONFIG, "sub-legacy", fake.fetch);
		expect(ensured).toEqual({ ok: true, value: { created: false } });
		expect(fake.banks.get("sub-legacy")?.mode).toBe("chunks");
	});

	test("a success stays ensured; a failure retries next call", async () => {
		const fake = setup();
		await ensureBank(CONFIG, "sub-cursor", fake.fetch);
		await ensureBank(CONFIG, "sub-cursor", fake.fetch);
		expect(fake.requests.length).toBe(1);
		clearEnsuredBanks();
		await ensureBank(CONFIG, "sub-cursor", fake.fetch);
		expect(fake.requests.length).toBe(2);
	});
});

describe("retainMemories", () => {
	test("upserts with document_id, update_mode replace and async false", async () => {
		const fake = setup();
		const retained = await retainMemories(
			CONFIG,
			"sub-cursor",
			[{ content: "fence the lease", tags: ["cursor"], metadata: { surface: "cursor" }, document_id: "mwd_3" }],
			fake.fetch,
		);
		expect(retained).toEqual({ ok: true, value: { items_count: 1 } });
		const bodies = fake.retainBodies();
		expect(bodies.length).toBe(1);
		const body = bodies[0];
		expect(body).toMatchObject({ async: false });
		if (body !== null && typeof body === "object" && "items" in body && Array.isArray(body.items)) {
			expect(body.items[0]).toMatchObject({ content: "fence the lease", document_id: "mwd_3", update_mode: "replace" });
		} else {
			throw new Error("retain body had no items");
		}
	});

	test("an unkeyed retain rejects before any network call", async () => {
		const fake = setup();
		await expect(
			retainMemories(CONFIG, "sub-cursor", [{ content: "x", tags: [], document_id: "" }], fake.fetch),
		).rejects.toThrow(/document_id/);
		expect(fake.requests.length).toBe(0);
	});

	test("the fake 400s an unkeyed retain on the wire", async () => {
		const fake = setup();
		const response = await fake.fetch("http://fake/v1/default/banks/sub-cursor/memories", {
			method: "POST",
			headers: { authorization: "Bearer test-bearer", "content-type": "application/json" },
			body: JSON.stringify({ items: [{ content: "x" }], async: false }),
		});
		expect(response.status).toBe(400);
	});
});

describe("recallBank", () => {
	test("parses the bare shape with the recall body", async () => {
		const fake = setup();
		const recalled = await recallBank(CONFIG, "sub-cursor", { query: "lease" }, fake.fetch);
		expect(recalled.ok).toBe(true);
		if (!recalled.ok) return;
		expect(recalled.value.map((hit) => hit.text)).toEqual(["fence the lease before handoff", "quote versions in conflicts"]);
		const bodies = fake.recalls();
		expect(bodies.length).toBe(1);
		expect(bodies[0]).toMatchObject({ query: "lease", budget: "low", max_tokens: 400 });
		const first = bodies[0];
		if (first !== null && typeof first === "object" && "types" in first && Array.isArray(first.types)) {
			expect(first.types).toEqual(["world", "experience", "observation"]);
		} else {
			throw new Error("recall body had no types");
		}
	});

	test("parses the wrapped shape identically", async () => {
		const fake = setup();
		fake.recallShape = "wrapped";
		const recalled = await recallBank(CONFIG, "sub-cursor", { query: "lease" }, fake.fetch);
		expect(recalled.ok).toBe(true);
		if (!recalled.ok) return;
		expect(recalled.value.length).toBe(2);
	});

	test("caps at four hits per bank", async () => {
		const fake = setup();
		fake.seed(
			"sub-omp",
			Array.from({ length: 6 }, (_, index) => ({ id: `o${index}`, text: `memory ${index}`, tags: [], metadata: {} })),
		);
		const recalled = await recallBank(CONFIG, "sub-omp", { query: "memory" }, fake.fetch);
		expect(recalled.ok).toBe(true);
		if (!recalled.ok) return;
		expect(recalled.value.length).toBe(4);
	});

	test("a missing results array is an invalid-response, never an empty success", async () => {
		const recalled = await recallBank(CONFIG, "sub-cursor", { query: "lease" }, () =>
			Promise.resolve(Response.json({ unexpected: true })),
		);
		expect(recalled.ok).toBe(false);
		if (recalled.ok) return;
		expect(recalled.error.kind).toBe("invalid-response");
	});

	test("a timeout is a Result, never a throw", async () => {
		const fake = setup();
		fake.recallDelayMs["sub-cursor"] = 5_000;
		const recalled = await recallBank(CONFIG, "sub-cursor", { query: "lease" }, fake.fetch, 50);
		expect(recalled.ok).toBe(false);
		if (recalled.ok) return;
		expect(recalled.error.kind).toBe("timeout");
	});

	test("an array detail is never shown; a string detail is", async () => {
		const arrayed = await recallBank(CONFIG, "sub-cursor", { query: "lease" }, () =>
			Promise.resolve(Response.json({ detail: ["field a broke", "field b broke"] }, { status: 422 })),
		);
		expect(arrayed.ok).toBe(false);
		if (arrayed.ok) return;
		expect(arrayed.error.kind).toBe("bad-request");
		expect(arrayed.error.message).not.toContain("field a broke");
		expect(arrayed.error.message).toContain("422");

		const stringed = await recallBank(CONFIG, "sub-cursor", { query: "lease" }, () =>
			Promise.resolve(Response.json({ detail: "bank is sealed" }, { status: 403 })),
		);
		expect(stringed.ok).toBe(false);
		if (stringed.ok) return;
		expect(stringed.error.kind).toBe("auth");
		expect(stringed.error.message).toContain("bank is sealed");
	});

	test("no recall runs without a bank path segment", async () => {
		const fake = setup();
		const response = await fake.fetch("http://fake/v1/default/memories/recall", {
			method: "POST",
			headers: { authorization: "Bearer test-bearer", "content-type": "application/json" },
			body: JSON.stringify({ query: "lease" }),
		});
		expect(response.status).toBe(500);
		expect(fake.requests.at(-1)?.path).toBe("/v1/default/memories/recall");
	});
});

describe("documents", () => {
	test("get, retag and delete round-trip; missing is null, not an error", async () => {
		const fake = setup();
		const found = await getDocument(CONFIG, "sub-cursor", "mwd_1", fake.fetch);
		expect(found.ok).toBe(true);
		if (!found.ok) return;
		expect(found.value?.text).toContain("fence the lease");

		const missing = await getDocument(CONFIG, "sub-cursor", "mwd-nope", fake.fetch);
		expect(missing).toEqual({ ok: true, value: null });

		const patched = await patchDocumentTags(CONFIG, "sub-cursor", "mwd_1", ["cursor", "lease"], fake.fetch);
		expect(patched).toEqual({ ok: true, value: undefined });

		const deleted = await deleteDocument(CONFIG, "sub-cursor", "mwd_1", fake.fetch);
		expect(deleted).toEqual({ ok: true, value: true });
		const gone = await getDocument(CONFIG, "sub-cursor", "mwd_1", fake.fetch);
		expect(gone).toEqual({ ok: true, value: null });
		const again = await deleteDocument(CONFIG, "sub-cursor", "mwd_1", fake.fetch);
		expect(again).toEqual({ ok: true, value: false });
	});

	test("deleteBank removes the bank the probe created", async () => {
		const fake = setup();
		await ensureBank(CONFIG, "sub-throwaway", fake.fetch);
		expect(fake.banks.has("sub-throwaway")).toBe(true);
		const deleted = await deleteBank(CONFIG, "sub-throwaway", fake.fetch);
		expect(deleted).toEqual({ ok: true, value: undefined });
		expect(fake.banks.has("sub-throwaway")).toBe(false);
	});
});

describe("bodyless deletes", () => {
	test("an empty 204 is a success that clears the ensured-bank entry", async () => {
		const fake = setup();
		fake.emptyDelete = true;
		const deletedDoc = await deleteDocument(CONFIG, "sub-cursor", "mwd_1", fake.fetch);
		expect(deletedDoc).toEqual({ ok: true, value: true });
		const missing = await getDocument(CONFIG, "sub-cursor", "mwd_1", fake.fetch);
		expect(missing).toEqual({ ok: true, value: null });

		await ensureBank(CONFIG, "sub-throwaway", fake.fetch);
		const requestsBefore = fake.requests.length;
		const deletedBank = await deleteBank(CONFIG, "sub-throwaway", fake.fetch);
		expect(deletedBank).toEqual({ ok: true, value: undefined });
		expect(fake.banks.has("sub-throwaway")).toBe(false);
		// The ensured entry was cleared: re-ensuring probes the plane again.
		await ensureBank(CONFIG, "sub-throwaway", fake.fetch);
		expect(fake.requests.length).toBeGreaterThan(requestsBefore + 1);
	});
});
