import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";
import { LinearClient } from "./linear.ts";
import { createMirror, Mirror } from "./mirror.ts";
import { Substrate } from "./service.ts";
import type { GraphNode, NodeState, SubstrateEvent } from "./types.ts";

/** Records what reached the event log, and stands in for the index. */
function stubStores(
	graph: { repo?: string | null; branch?: string | null } | null,
	claim: { claimed?: boolean; node?: Partial<GraphNode> } = {},
) {
	const emitted: SubstrateEvent[] = [];
	const states: Array<{ graph_id: string; node_id: string; state: NodeState }> = [];
	const index = {
		claimNode: async (graph_id: string, node_id: string) => ({
			claimed: claim.claimed ?? true,
			node: { graph_id, node_id, linear_identifier: "SPE-123", linear_issue_id: null, ...claim.node },
		}),
		getGraph: async () => (graph ? { repo: graph.repo ?? null, branch: graph.branch ?? null } : null),
		setNodeState: async (graph_id: string, node_id: string, state: NodeState) => {
			states.push({ graph_id, node_id, state });
		},
	};
	const greptime = {
		lastHash: async () => null,
		insertEvent: async (event: SubstrateEvent) => {
			emitted.push(event);
		},
	};
	return { emitted, states, index, greptime };
}

const KEY = "lin_api_service_test_key_42";

/** A Linear stand-in recording each GraphQL operation name; `status` other than 200 fails every call. */
function recordingLinear(opts: { status?: number; comments?: string[] } = {}) {
	const ops: string[] = [];
	const fetchImpl = (async (_url: string, init: RequestInit) => {
		const { query } = JSON.parse(String(init.body)) as { query: string };
		const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "unknown";
		ops.push(op);
		if (opts.status && opts.status !== 200) return new Response("internal error", { status: opts.status });
		const replies: Record<string, unknown> = {
			IssueContext: {
				issue: {
					id: "issue-uuid",
					identifier: "SWC-7",
					team: { id: "team-swc", key: "SWC", states: { nodes: [{ id: "st-progress", name: "In Progress", type: "started" }] } },
					labels: { nodes: [] },
					comments: { nodes: (opts.comments ?? []).map((body) => ({ body })) },
				},
			},
			Labels: { issueLabels: { nodes: [{ id: "lbl-agent", name: "agent:omp", team: { id: "team-swc" } }] } },
			IssueUpdate: { issueUpdate: { success: true } },
			CommentCreate: { commentCreate: { success: true } },
		};
		return new Response(JSON.stringify({ data: replies[op] }), { status: 200 });
	}) as unknown as typeof fetch;
	return { ops, fetchImpl, mirror: new Mirror({ linear: new LinearClient(KEY, { fetchImpl }) }) };
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

describe("claimNode → mirror", () => {
	test("a losing claimer causes no Linear request, no event and no state write (D-04)", async () => {
		const { emitted, states, index, greptime } = stubStores(
			{ repo: "r" },
			{ claimed: false, node: { linear_issue_id: "issue-uuid", claimed_by: "claude-code" } },
		);
		const linear = recordingLinear();
		const substrate = new Substrate(loadConfig({}), {
			index: index as never,
			greptime: greptime as never,
			mirror: linear.mirror,
		});

		const result = await substrate.claimNode("ut-1", "n1", "omp", "sess-loser");

		expect(result.claimed).toBe(false);
		expect(linear.ops).toEqual([]);
		expect(emitted).toEqual([]);
		expect(states).toEqual([]);
	});

	test("Linear answering 500 still claims, and leaves exactly one warning naming the target (D-02)", async () => {
		const { emitted, index, greptime } = stubStores({ repo: "r", branch: "main" }, { node: { linear_issue_id: "issue-uuid" } });
		const linear = recordingLinear({ status: 500 });
		const substrate = new Substrate(loadConfig({}), {
			index: index as never,
			greptime: greptime as never,
			mirror: linear.mirror,
		});

		const result = await substrate.claimNode("ut-1", "n1", "omp", "sess-1");

		expect(result.claimed).toBe(true);
		expect(emitted.filter((e) => e.kind === "claim")).toHaveLength(1);
		const warnings = emitted.filter((e) => e.kind === "warning");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.graph_id).toBe("ut-1");
		expect(warnings[0]?.node_id).toBe("n1");
		expect(warnings[0]?.payload.target).toBe("linear");
		expect(warnings[0]?.payload.action).toBe("claim");
		expect(warnings[0]?.summary).toContain("500");
	});

	test("a node with no Linear reference warns without calling Linear", async () => {
		const { emitted, index, greptime } = stubStores(
			{ repo: "r" },
			{ node: { linear_issue_id: null, linear_identifier: null } },
		);
		const linear = recordingLinear();
		const substrate = new Substrate(loadConfig({}), {
			index: index as never,
			greptime: greptime as never,
			mirror: linear.mirror,
		});

		await substrate.claimNode("ut-1", "n1", "omp", "sess-1");

		const warnings = emitted.filter((e) => e.kind === "warning");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.summary).toContain("no Linear issue reference");
		expect(linear.ops).toEqual([]);
	});

	test("with no LINEAR_API_KEY the mirror is off: no requests and no warnings", async () => {
		const { emitted, index, greptime } = stubStores({ repo: "r" }, { node: { linear_issue_id: "issue-uuid" } });
		const linear = recordingLinear();
		const mirror = createMirror(loadConfig({}), linear.fetchImpl);
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: greptime as never, mirror });

		await substrate.claimNode("ut-1", "n1", "omp", "sess-1");

		expect(mirror.describe()).toBe("linear off");
		expect(linear.ops).toEqual([]);
		expect(emitted.filter((e) => e.kind === "warning")).toEqual([]);
	});

	test("a same-session re-claim re-applies state and labels but does not comment twice", async () => {
		const { emitted, index, greptime } = stubStores({ repo: "r" }, { node: { linear_issue_id: "issue-uuid" } });
		const linear = recordingLinear({ comments: ["Claimed by omp — session sess-1 (graph ut-1, node n1)"] });
		const substrate = new Substrate(loadConfig({}), {
			index: index as never,
			greptime: greptime as never,
			mirror: linear.mirror,
		});

		await substrate.claimNode("ut-1", "n1", "omp", "sess-1");

		expect(linear.ops).toContain("IssueUpdate");
		expect(linear.ops).not.toContain("CommentCreate");
		expect(emitted.filter((e) => e.kind === "warning")).toEqual([]);
	});

	test("an earlier session whose id extends this one does not suppress this session's comment", async () => {
		const { index, greptime } = stubStores({ repo: "r" }, { node: { linear_issue_id: "issue-uuid" } });
		const linear = recordingLinear({ comments: ["Claimed by omp — session sess-10 (graph ut-1, node n1)"] });
		const substrate = new Substrate(loadConfig({}), {
			index: index as never,
			greptime: greptime as never,
			mirror: linear.mirror,
		});

		await substrate.claimNode("ut-1", "n1", "omp", "sess-1");

		expect(linear.ops.filter((op) => op === "CommentCreate")).toHaveLength(1);
	});

	test("a winning claim records the node as started in the index", async () => {
		const { states, index, greptime } = stubStores({ repo: "r" });
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: greptime as never });

		await substrate.claimNode("ut-1", "n1", "omp", "sess-1");

		expect(states).toEqual([{ graph_id: "ut-1", node_id: "n1", state: "started" }]);
	});

	test("the API key never reaches an emitted event", async () => {
		const { emitted, index, greptime } = stubStores({ repo: "r" }, { node: { linear_issue_id: "issue-uuid" } });
		const linear = recordingLinear({ status: 401 });
		const substrate = new Substrate(loadConfig({}), {
			index: index as never,
			greptime: greptime as never,
			mirror: linear.mirror,
		});

		await substrate.claimNode("ut-1", "n1", "omp", "sess-1");

		expect(emitted.filter((e) => e.kind === "warning")).toHaveLength(1);
		for (const event of emitted) {
			expect(event.summary).not.toContain(KEY);
			expect(JSON.stringify(event.payload)).not.toContain(KEY);
		}
	});
});
