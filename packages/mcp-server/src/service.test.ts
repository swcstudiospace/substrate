import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";
import { Substrate } from "./service.ts";
import type { SubstrateEvent } from "./types.ts";

/** Records what reached the event log, and stands in for the index. */
function stubStores(graph: { repo?: string | null; branch?: string | null } | null) {
	const emitted: SubstrateEvent[] = [];
	const index = {
		claimNode: async (graph_id: string, node_id: string) => ({
			claimed: true,
			node: { graph_id, node_id, linear_identifier: "SPE-123" },
		}),
		getGraph: async () => (graph ? { repo: graph.repo ?? null, branch: graph.branch ?? null } : null),
	};
	const greptime = {
		lastHash: async () => null,
		insertEvent: async (event: SubstrateEvent) => {
			emitted.push(event);
		},
	};
	return { emitted, index, greptime };
}

describe("claimNode", () => {
	test("stamps the claim event with the graph's repo", async () => {
		// Regression: the claim event used to carry no repo, so it was invisible to
		// every repo-scoped brief — the one place a claim most needs to be seen.
		const { emitted, index, greptime } = stubStores({ repo: "swcstudiospace/x", branch: "main" });
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: greptime as never });

		await substrate.claimNode("ut-1", "n4", "omp", "sess-1");

		expect(emitted).toHaveLength(1);
		expect(emitted[0]?.kind).toBe("claim");
		expect(emitted[0]?.repo).toBe("swcstudiospace/x");
		expect(emitted[0]?.branch).toBe("main");
		expect(emitted[0]?.surface).toBe("omp");
	});

	test("does not repeat the node id the brief already renders", async () => {
		const { emitted, index, greptime } = stubStores({ repo: "r" });
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: greptime as never });

		await substrate.claimNode("ut-1", "n4", "omp", "sess-1");

		expect(emitted[0]?.summary).toBe("claimed SPE-123");
		expect(emitted[0]?.summary).not.toContain("n4");
	});

	test("still claims when the graph lookup fails — the claim matters more than its event", async () => {
		const { emitted, index, greptime } = stubStores(null);
		index.getGraph = async () => {
			throw new Error("postgres blipped");
		};
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: greptime as never });

		const result = await substrate.claimNode("ut-1", "n4", "omp", "sess-1");

		expect(result.claimed).toBe(true);
		expect(emitted[0]?.repo).toBeNull();
	});
});
