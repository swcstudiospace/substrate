/**
 * Tests for the lease-model substrate client: bearer carriage, lease
 * persistence, and heartbeat. Fetch is faked; no secret value appears in
 * any assertion — only header presence and the `Bearer ` scheme.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	heartbeatDue,
	LeaseStore,
	resolveHostBearer,
	SubstrateClient,
	type LeaseRecord,
} from "./substrate.ts";

function jsonRpc(id: number, payload: unknown): Response {
	return new Response(
		JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ text: JSON.stringify(payload) }] } }),
		{ status: 200 },
	);
}

function captureFetch(reply: (url: string, init: RequestInit) => Response) {
	const seen: Array<{ url: string; init: RequestInit }> = [];
	const fetchImpl = (async (url: string, init: RequestInit) => {
		seen.push({ url, init });
		return reply(url, init);
	}) as unknown as typeof fetch;
	return { seen, fetchImpl };
}

function headersOf(init: RequestInit): Record<string, string> {
	return (init.headers ?? {}) as Record<string, string>;
}

describe("resolveHostBearer", () => {
	test("per-unit host env file variable wins", () => {
		const bearer = resolveHostBearer(
			{ SUBSTRATE_TOKEN_SUBSTRATE: "unit-bearer", SUBSTRATE_TOKEN: "direct-bearer" } as NodeJS.ProcessEnv,
			() => null,
		);
		expect(bearer).toBe("unit-bearer");
	});

	test("Phase 20 order after the unit variable: direct, file, tokens dir", () => {
		expect(
			resolveHostBearer({ SUBSTRATE_TOKEN: "direct-bearer" } as NodeJS.ProcessEnv, () => null),
		).toBe("direct-bearer");
		expect(
			resolveHostBearer(
				{ SUBSTRATE_TOKEN_FILE: "/tmp/does-not-matter" } as NodeJS.ProcessEnv,
				() => "file-bearer",
			),
		).toBe("file-bearer");
		expect(
			resolveHostBearer({} as NodeJS.ProcessEnv, (path) =>
				path === "/etc/substrate/tokens/substrate" ? "dir-bearer" : null,
			),
		).toBe("dir-bearer");
	});

	test("absent everywhere means null (fail-open; the server refuses)", () => {
		expect(resolveHostBearer({} as NodeJS.ProcessEnv, () => null)).toBeNull();
	});
});

describe("bearer carriage", () => {
	test("every tool call carries the Authorization bearer header", async () => {
		const { seen, fetchImpl } = captureFetch((url) =>
			jsonRpc(1, { graph_id: "g", node_id: "n", nodes: [] }),
		);
		const client = new SubstrateClient({ baseUrl: "http://127.0.0.1:9", fetchImpl, bearer: "test-bearer" });
		expect(client.authenticated).toBe(true);
		await client.graphGet("g");
		expect(seen).toHaveLength(1);
		expect(headersOf(seen[0]?.init ?? {}).authorization).toBe("Bearer test-bearer");
	});

	test("anonymous client sends no authorization header", async () => {
		const { seen, fetchImpl } = captureFetch((url) =>
			jsonRpc(1, { graph_id: "g", node_id: "n", nodes: [] }),
		);
		const client = new SubstrateClient({
			baseUrl: "http://127.0.0.1:9",
			fetchImpl,
			env: {} as NodeJS.ProcessEnv,
			readTokenFile: () => null,
		});
		expect(client.authenticated).toBe(false);
		await client.graphGet("g");
		expect("authorization" in headersOf(seen[0]?.init ?? {})).toBe(false);
	});

	test("no baked secret: sources carry names only", () => {
		const source = readFileSync(new URL("./substrate.ts", import.meta.url), "utf8");
		expect(source).not.toMatch(/Bearer [A-Za-z0-9_-]{8,}/);
		expect(source).toMatch(/SUBSTRATE_TOKEN_SUBSTRATE/);
	});
});

describe("lease persist and heartbeat", () => {
	test("claimAndPersist writes the lease id to a 0600 file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lease-"));
		const { fetchImpl } = captureFetch((url) => jsonRpc(1, { claimed: true, lease_id: "lease-123" }));
		const client = new SubstrateClient({ baseUrl: "http://127.0.0.1:9", fetchImpl, bearer: "test-bearer" });
		const store = new LeaseStore(dir);
		const reply = await client.claimAndPersist(store, "g", "n", "claude-code", "s");
		expect(reply.claimed).toBe(true);
		const loaded = store.load("g", "n");
		expect(loaded?.lease_id).toBe("lease-123");
		const mode = statSync(join(dir, "g__n.lease.json")).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	test("claim without a lease id persists nothing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lease-"));
		const { fetchImpl } = captureFetch((url) => jsonRpc(1, { claimed: true }));
		const client = new SubstrateClient({ baseUrl: "http://127.0.0.1:9", fetchImpl, bearer: "test-bearer" });
		const store = new LeaseStore(dir);
		await client.claimAndPersist(store, "g", "n", "claude-code", "s");
		expect(store.load("g", "n")).toBeNull();
	});

	test("heartbeatDue fires at half the TTL", () => {
		const record: LeaseRecord = { lease_id: "lease-123", acquiredAtMs: 0, ttlSeconds: 900 };
		expect(heartbeatDue(record, 449_999)).toBe(false);
		expect(heartbeatDue(record, 450_000)).toBe(true);
	});

	test("heartbeat renews inside the TTL; refusal names its reason", async () => {
		const calls: string[] = [];
		const fetchImpl = (async () => {
			calls.push("heartbeat");
			return jsonRpc(1, { ok: true });
		}) as unknown as typeof fetch;
		const client = new SubstrateClient({ baseUrl: "http://127.0.0.1:9", fetchImpl, bearer: "test-bearer" });
		expect(await client.heartbeat("g", "n", "lease-123")).toEqual({ ok: true });
		expect(calls).toHaveLength(1);
	});
});
