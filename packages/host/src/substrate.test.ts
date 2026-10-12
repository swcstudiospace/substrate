/**
 * Tests for the lease-model substrate client: bearer carriage, lease
 * persistence, and heartbeat. Fetch is faked; no secret value appears in
 * any assertion — only header presence and the `Bearer ` scheme.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	heartbeatDue,
	LeaseStore,
	resolveHostBearer,
	resolveLeaseBearer,
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
				{ SUBSTRATE_TOKEN_FILE: "/tmp/x" } as NodeJS.ProcessEnv,
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

describe("resolveLeaseBearer", () => {
	test("per-unit lease variable wins without touching the job chain", () => {
		const bearer = resolveLeaseBearer(
			{ SUBSTRATE_TOKEN_CLAUDE_CODE: "lease-bearer", SUBSTRATE_TOKEN: "direct-bearer" } as NodeJS.ProcessEnv,
			() => null,
		);
		expect(bearer).toBe("lease-bearer");
	});

	test("Phase 20 order after the unit variable: direct, file, tokens dir claude-code surface", () => {
		expect(
			resolveLeaseBearer({ SUBSTRATE_TOKEN: "direct-bearer" } as NodeJS.ProcessEnv, () => null),
		).toBe("direct-bearer");
		expect(
			resolveLeaseBearer(
				{ SUBSTRATE_TOKEN_FILE: "/tmp/x" } as NodeJS.ProcessEnv,
				() => "file-bearer",
			),
		).toBe("file-bearer");
		expect(
			resolveLeaseBearer({} as NodeJS.ProcessEnv, (path) =>
				path === "/etc/substrate/tokens/claude-code" ? "dir-bearer" : null,
			),
		).toBe("dir-bearer");
	});

	test("lease and job chains never share a surface file", () => {
		const read = (path: string) => (path.endsWith("/substrate") ? "job-bearer" : path.endsWith("/claude-code") ? "lease-bearer" : null);
		expect(resolveHostBearer({} as NodeJS.ProcessEnv, read)).toBe("job-bearer");
		expect(resolveLeaseBearer({} as NodeJS.ProcessEnv, read)).toBe("lease-bearer");
	});

	test("absent everywhere means null (fail-open; the server refuses)", () => {
		expect(resolveLeaseBearer({} as NodeJS.ProcessEnv, () => null)).toBeNull();
	});
});

describe("bearer carriage", () => {
	test("lease and job bearers resolve distinctly with no cross-surface fallback", async () => {
		const client = new SubstrateClient({ baseUrl: "http://127.0.0.1:9", fetchImpl: (async () => jsonRpc(1, {})) as unknown as typeof fetch, bearer: "lease-bearer", jobBearer: "job-bearer" });
		expect(client.authenticated).toBe(true);
		expect(client.jobAuthenticated).toBe(true);
		expect(client.bearer).not.toBe(client.jobBearer);
	});

	test("anonymous client carries neither bearer", async () => {
		const client = new SubstrateClient({
			baseUrl: "http://127.0.0.1:9",
			fetchImpl: (async () => jsonRpc(1, {})) as unknown as typeof fetch,
			env: {} as NodeJS.ProcessEnv,
			readTokenFile: () => null,
		});
		expect(client.authenticated).toBe(false);
		expect(client.jobAuthenticated).toBe(false);
	});

	test("no baked secret: sources carry names only", () => {
		const source = readFileSync(new URL("./substrate.ts", import.meta.url), "utf8");
		expect(source).not.toMatch(/Bearer [A-Za-z0-9_-]{8,}/);
		expect(source).toMatch(/SUBSTRATE_TOKEN_SUBSTRATE/);
		expect(source).toMatch(/SUBSTRATE_TOKEN_CLAUDE_CODE/);
	});
});

describe("lease persist and heartbeat", () => {
	test("claimAndPersist writes the lease id to a 0600 file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lease-"));
		const { fetchImpl } = captureFetch((url) => jsonRpc(1, { claimed: true, lease: { lease_id: "lease-123" } }));
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

	test("a real persist failure compensates with the captured grant and throws names-only", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lease-"));
		const file = join(dir, "not-a-dir");
		writeFileSync(file, "occupied");
		const released: string[] = [];
		const fetchImpl = (async (url: string, init: RequestInit) => {
			const body: unknown = JSON.parse(String(init.body));
			const params: unknown = typeof body === "object" && body !== null && "params" in body ? body.params : undefined;
			const name: unknown = typeof params === "object" && params !== null && "name" in params ? params.name : undefined;
			if (name === "graph_release") {
				released.push("grant");
				return jsonRpc(2, { released: true });
			}
			return jsonRpc(1, { claimed: true, lease: { lease_id: "lease-123" } });
		}) as unknown as typeof fetch;
		const client = new SubstrateClient({ baseUrl: "http://127.0.0.1:9", fetchImpl, bearer: "test-bearer" });
		const store = new LeaseStore(file);
		const failure = await client.claimAndPersist(store, "g", "n", "claude-code", "s").then(
			() => "no-throw",
			(cause: unknown) => String(cause),
		);
		expect(failure).toContain("lease persist failed");
		expect(failure).toContain("grant released");
		expect(failure).not.toContain("lease-123");
		expect(released).toEqual(["grant"]);
		expect(store.load("g", "n")).toBeNull();
	});

	test("a refused compensation still throws without claiming release", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lease-"));
		const file = join(dir, "not-a-dir");
		writeFileSync(file, "occupied");
		const fetchImpl = (async (url: string, init: RequestInit) => {
			const body: unknown = JSON.parse(String(init.body));
			const params: unknown = typeof body === "object" && body !== null && "params" in body ? body.params : undefined;
			const name: unknown = typeof params === "object" && params !== null && "name" in params ? params.name : undefined;
			if (name === "graph_release") return jsonRpc(2, { released: false, reason: "stale-lease" });
			return jsonRpc(1, { claimed: true, lease: { lease_id: "lease-123" } });
		}) as unknown as typeof fetch;
		const client = new SubstrateClient({ baseUrl: "http://127.0.0.1:9", fetchImpl, bearer: "test-bearer" });
		const store = new LeaseStore(file);
		const failure = await client.claimAndPersist(store, "g", "n", "claude-code", "s").then(
			() => "no-throw",
			(cause: unknown) => String(cause),
		);
		expect(failure).toContain("release refused");
		expect(failure).not.toContain("lease-123");
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
