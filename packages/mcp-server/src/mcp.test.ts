import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./mcp.ts";
import type { Substrate } from "./service.ts";
import type { Surface } from "./types.ts";

/** An MCP client wired to the tool surface over a Substrate that records who each release/complete acted as. */
async function connect(callerSurface: Surface | null) {
	const calls: Array<{ verb: string; surface: Surface }> = [];
	const substrate = {
		releaseNode: async (_g: string, _n: string, surface: Surface) => {
			calls.push({ verb: "release", surface });
			return { released: true };
		},
		completeNode: async (_g: string, _n: string, surface: Surface) => {
			calls.push({ verb: "complete", surface });
			return { completed: true, reason: null };
		},
	} as unknown as Substrate;
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await createMcpServer(substrate, callerSurface).connect(serverSide);
	const client = new Client({ name: "mcp-test", version: "0.0.0" });
	await client.connect(clientSide);
	const call = async (name: string, args: Record<string, unknown>) => {
		const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> };
		return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
	};
	return { calls, call };
}

const ARGS = { graph_id: "ut-1", node_id: "n1", session_id: "sess-holder" };

describe("graph_release / graph_complete owner surface (WR-02)", () => {
	for (const [tool, verb, refused] of [
		["graph_release", "release", { released: false }],
		["graph_complete", "complete", { completed: false }],
	] as const) {
		test(`${tool}: an authenticated caller naming another surface is refused with no write`, async () => {
			const { calls, call } = await connect("omp");

			const result = await call(tool, { ...ARGS, surface: "claude-code" });

			expect(result).toMatchObject(refused);
			expect(result.reason).toBe("surface claude-code does not match the authenticated caller omp");
			expect(calls).toEqual([]);
		});

		test(`${tool}: an authenticated caller acts as its own surface, with or without naming it`, async () => {
			const { calls, call } = await connect("omp");

			await call(tool, ARGS);
			await call(tool, { ...ARGS, surface: "omp" });

			expect(calls).toEqual([
				{ verb, surface: "omp" },
				{ verb, surface: "omp" },
			]);
		});

		test(`${tool}: an anonymous caller is attributed by its payload`, async () => {
			const { calls, call } = await connect(null);

			await call(tool, { ...ARGS, surface: "grok-build" });
			await call(tool, ARGS);

			expect(calls).toEqual([
				{ verb, surface: "grok-build" },
				{ verb, surface: "claude-code" },
			]);
		});
	}
});
