/**
 * Phase 72 criterion 1 at the MCP door. The tool is registered as `coord_drift_scan` (mcp.ts), the MCP name for
 * `coord.drift_scan`. A surface granted only `owner/a` that names a path in `owner/b` is refused before any git call,
 * and the refusal is recorded. Driven through a real client over the in-memory transport, as mcp.test.ts does.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "./config.ts";
import { createMcpServer } from "./mcp.ts";
import { REPO_REGISTRY_ENV, REPO_SCOPES_ENV } from "./repo-scope.ts";
import { Substrate } from "./service.ts";
import type { SubstrateEvent } from "./types.ts";

interface Repos {
	a: string;
	b: string;
	env: Record<string, string>;
}

/** `owner/a` and `owner/b`, each with a checkout that carries a `.git` entry so it reads as a checkout. */
function twoRepos(): Repos {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "mcp-drift-scope-")));
	const make = (name: string) => {
		const checkout = join(root, name, "checkout");
		mkdirSync(join(checkout, ".git"), { recursive: true });
		mkdirSync(join(root, name, "worktrees"), { recursive: true });
		return checkout;
	};
	const a = make("a");
	const b = make("b");
	const registry = JSON.stringify({
		"owner/a": { checkouts: [a], worktrees: [join(root, "a", "worktrees")] },
		"owner/b": { checkouts: [b], worktrees: [join(root, "b", "worktrees")] },
	});
	return { a, b, env: { [REPO_REGISTRY_ENV]: registry, [REPO_SCOPES_ENV]: JSON.stringify({ omp: ["owner/a"] }) } };
}

/** A greptime stub: every append is recorded, every read is counted. */
function ledger() {
	const written: SubstrateEvent[] = [];
	const reads: string[] = [];
	const read = (name: string) => async () => {
		reads.push(name);
		return [];
	};
	return {
		written,
		reads,
		greptime: {
			ensureAppendMode: async () => true,
			lastHash: async () => null,
			insertEvent: async (event: SubstrateEvent) => {
				written.push(event);
			},
			queryEvents: read("queryEvents"),
			readEvents: read("readEvents"),
			recentForRepo: read("recentForRepo"),
			commitEventsNaming: read("commitEventsNaming"),
			graphIngest: async () => [],
			firstIngestMs: async () => null,
		},
	};
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const stop of cleanup.splice(0).reverse()) await stop();
});

async function connect(env: Record<string, string>) {
	const config = loadConfig(env);
	const stub = ledger();
	const substrate = new Substrate(config, { index: null, greptime: stub.greptime as never });
	const server = createMcpServer(substrate, "omp");
	const client = new Client({ name: "drift-scope-test", version: "0.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	cleanup.push(async () => {
		await client.close();
		await server.close();
	});
	return { client, ledger: stub };
}

describe("MCP coord_drift_scan (criterion 1 at the MCP door)", () => {
	test("a path in an ungranted repository is refused: isError, zero git argv calls, one repo.scope-refused warning", async () => {
		const repos = twoRepos();
		const { client, ledger: stub } = await connect(repos.env);
		const spawn = spyOn(Bun, "spawnSync");
		try {
			const result = await client.callTool({ name: "coord_drift_scan", arguments: { repo: "owner/b", path: repos.b } });
			const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";

			expect(result.isError).toBe(true);
			expect(JSON.parse(text)).toMatchObject({ error: "repo-not-granted" });
			expect(text).not.toContain(repos.b);
			expect(spawn.mock.calls.filter(([argv]) => Array.isArray(argv) && argv[0] === "git")).toHaveLength(0);
			expect(stub.reads).toHaveLength(0);

			const refusals = stub.written.filter((event) => (event.payload as { action?: string } | undefined)?.action === "repo.scope-refused");
			expect(refusals).toHaveLength(1);
			expect(refusals[0]).toMatchObject({
				kind: "warning",
				surface: "omp",
				payload: { action: "repo.scope-refused", route: "drift", reason: "repo-not-granted" },
			});
			expect(JSON.stringify(refusals)).not.toContain(repos.b);
		} finally {
			spawn.mockRestore();
		}
	});

	test("positive control: a granted path is scanned, and the git spy observes the scan's git calls", async () => {
		const repos = twoRepos();
		const { client, ledger: stub } = await connect(repos.env);
		const spawn = spyOn(Bun, "spawnSync");
		try {
			const result = await client.callTool({ name: "coord_drift_scan", arguments: { repo: "owner/a", path: repos.a } });
			expect(result.isError).not.toBe(true);
			expect(spawn.mock.calls.filter(([argv]) => Array.isArray(argv) && argv[0] === "git").length).toBeGreaterThan(0);
			expect(stub.written.filter((event) => (event.payload as { action?: string } | undefined)?.action === "repo.scope-refused")).toHaveLength(0);
		} finally {
			spawn.mockRestore();
		}
	});
});
