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

describe("findNode", () => {
	/** An index that answers the UUID lookup and the identifier lookup from separate tables, as the SQL does. */
	function findStub(byId: Record<string, string[]>, byIdentifier: Record<string, string[]>) {
		const calls: Array<{ linearIssueId?: string; linearIdentifier?: string }> = [];
		const row = (key: string) => {
			const [graph_id, node_id] = key.split("/") as [string, string];
			return { graph_id, node_id, linear_issue_id: null, linear_identifier: null, repo: `repo-of-${graph_id}`, branch: "main", graph_status: "Implementing" };
		};
		const index = {
			findNodesByLinear: async (ref: { linearIssueId?: string; linearIdentifier?: string }) => {
				calls.push(ref);
				const hits = ref.linearIssueId ? (byId[ref.linearIssueId] ?? []) : [];
				if (hits.length > 0) return hits.map(row);
				return ref.linearIdentifier ? (byIdentifier[ref.linearIdentifier] ?? []).map(row) : [];
			},
		};
		return { calls, substrate: new Substrate(loadConfig({}), { index: index as never, greptime: null }) };
	}

	test("one node owning the issue id resolves with its graph's repo and branch", async () => {
		const { substrate } = findStub({ "issue-uuid": ["ut-a/n1"] }, {});

		const result = await substrate.findNode({ linear_issue_id: "issue-uuid" });

		expect(result).toMatchObject({
			found: true,
			graph_id: "ut-a",
			node_id: "n1",
			repo: "repo-of-ut-a",
			branch: "main",
			graph_status: "Implementing",
		});
		if (result.found) expect(result.node).not.toHaveProperty("repo");
	});

	test("falls back to the identifier when no node carries the issue id (backfilled nodes)", async () => {
		const { substrate } = findStub({}, { "SWC-7": ["ut-b/n2"] });

		const result = await substrate.findNode({ linear_issue_id: "issue-uuid", linear_identifier: "SWC-7" });

		expect(result).toMatchObject({ found: true, graph_id: "ut-b", node_id: "n2" });
	});

	test("two owning nodes are reported as ambiguous, not guessed", async () => {
		const { substrate } = findStub({ "issue-uuid": ["ut-a/n1", "ut-c/n3"] }, {});

		const result = await substrate.findNode({ linear_issue_id: "issue-uuid" });

		expect(result.found).toBe(false);
		if (!result.found) expect(result.reason).toStartWith("ambiguous");
	});

	test("an issue on no node is reported as unregistered", async () => {
		const { substrate } = findStub({}, {});

		const result = await substrate.findNode({ linear_identifier: "SWC-404" });

		expect(result.found).toBe(false);
		if (!result.found) expect(result.reason).toStartWith("no registered node");
	});

	test("with neither reference it answers without querying the index", async () => {
		const { calls, substrate } = findStub({}, {});

		const result = await substrate.findNode({});

		expect(result).toEqual({ found: false, reason: "provide linear_issue_id or linear_identifier" });
		expect(calls).toEqual([]);
	});
});

/** A node claimed by claude-code/sess-holder, behind an index that records and applies release/state writes. */
function holderStores(node: Partial<GraphNode> = {}) {
	const emitted: SubstrateEvent[] = [];
	const writes: string[] = [];
	const current: GraphNode = {
		graph_id: "ut-1",
		node_id: "n1",
		linear_issue_id: "issue-uuid",
		linear_identifier: "SWC-7",
		notion_page: null,
		state: "started",
		claimed_by: "claude-code",
		claimed_at: "2026-09-25T00:00:00.000Z",
		claim_session: "sess-holder",
		...node,
	};
	const index = {
		getGraph: async (graph_id: string) =>
			graph_id === "ut-1"
				? { graph_id, repo: "swcstudiospace/agent-substrate", branch: "main", nodes: [{ ...current }] }
				: null,
		releaseNode: async () => {
			writes.push("release");
			Object.assign(current, { claimed_by: null, claimed_at: null, claim_session: null });
		},
		setNodeState: async (_graph_id: string, _node_id: string, state: NodeState) => {
			writes.push(`state:${state}`);
			current.state = state;
		},
	};
	const greptime = {
		lastHash: async () => null,
		insertEvent: async (event: SubstrateEvent) => {
			emitted.push(event);
		},
	};
	return { emitted, writes, index, greptime };
}

/** A Linear stand-in recording every operation with its variables; the team has Todo, In Progress, In Review and Done. */
function trackerLinear(opts: { status?: number; labels?: Array<{ id: string; name: string }> } = {}) {
	const requests: Array<{ op: string; variables: Record<string, unknown> }> = [];
	const fetchImpl = (async (_url: string, init: RequestInit) => {
		const { query, variables } = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
		const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "unknown";
		requests.push({ op, variables });
		if (opts.status && opts.status !== 200) return new Response("internal error", { status: opts.status });
		const replies: Record<string, unknown> = {
			IssueContext: {
				issue: {
					id: "issue-uuid",
					identifier: "SWC-7",
					team: {
						id: "team-swc",
						key: "SWC",
						states: {
							nodes: [
								{ id: "st-todo", name: "Todo", type: "unstarted" },
								{ id: "st-progress", name: "In Progress", type: "started" },
								{ id: "st-review", name: "In Review", type: "started" },
								{ id: "st-done", name: "Done", type: "completed" },
							],
						},
					},
					labels: {
						nodes: opts.labels ?? [
							{ id: "lbl-agent-cc", name: "agent:claude-code" },
							{ id: "lbl-area", name: "area:mcp" },
						],
					},
					comments: { nodes: [] },
				},
			},
			IssueUpdate: { issueUpdate: { success: true } },
		};
		return new Response(JSON.stringify({ data: replies[op] }), { status: 200 });
	}) as unknown as typeof fetch;
	const updates = () => requests.filter((r) => r.op === "IssueUpdate").map((r) => r.variables.input);
	return { requests, updates, mirror: new Mirror({ linear: new LinearClient(KEY, { fetchImpl }) }) };
}

describe("releaseNode", () => {
	test("the holder's release sends Linear to Todo, drops agent:<surface>, clears the claim and logs one release event", async () => {
		const { emitted, writes, index, greptime } = holderStores();
		const linear = trackerLinear();
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: greptime as never, mirror: linear.mirror });

		const result = await substrate.releaseNode("ut-1", "n1", "claude-code", "sess-holder");

		expect(result.released).toBe(true);
		expect(result.node).toMatchObject({ claimed_by: null, claim_session: null, state: "unstarted" });
		expect(linear.updates()).toEqual([{ stateId: "st-todo", removedLabelIds: ["lbl-agent-cc"] }]);
		expect(writes).toEqual(["release", "state:unstarted"]);
		expect(emitted).toHaveLength(1);
		expect(emitted[0]).toMatchObject({
			kind: "release",
			graph_id: "ut-1",
			node_id: "n1",
			repo: "swcstudiospace/agent-substrate",
			branch: "main",
			session_id: "sess-holder",
			linear_identifier: "SWC-7",
		});
	});

	test("an issue without the agent label gets a state change only", async () => {
		const { index, greptime } = holderStores();
		const linear = trackerLinear({ labels: [{ id: "lbl-agent-omp", name: "agent:omp" }] });
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: greptime as never, mirror: linear.mirror });

		await substrate.releaseNode("ut-1", "n1", "claude-code", "sess-holder");

		expect(linear.updates()).toEqual([{ stateId: "st-todo" }]);
	});

	for (const [label, surface, session, node] of [
		["another surface", "omp", "sess-holder", {}],
		["the same surface in another session", "claude-code", "sess-other", {}],
		["anyone on an unclaimed node", "claude-code", "sess-holder", { claimed_by: null, claim_session: null }],
	] as const) {
		test(`${label} is refused with no Linear request, index write or event`, async () => {
			const { emitted, writes, index, greptime } = holderStores(node);
			const linear = trackerLinear();
			const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: greptime as never, mirror: linear.mirror });

			const result = await substrate.releaseNode("ut-1", "n1", surface, session);

			expect(result.released).toBe(false);
			expect(result.reason).toBe(
				node.claimed_by === null
					? "node is not claimed"
					: "node is claimed by claude-code session sess-holder; only that session can release it",
			);
			expect(linear.requests).toEqual([]);
			expect(writes).toEqual([]);
			expect(emitted).toEqual([]);
		});
	}

	test("Linear answering 500 still releases, logs the release and one warning naming linear/release (D-02)", async () => {
		const { emitted, writes, index, greptime } = holderStores();
		const linear = trackerLinear({ status: 500 });
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: greptime as never, mirror: linear.mirror });

		const result = await substrate.releaseNode("ut-1", "n1", "claude-code", "sess-holder");

		expect(result.released).toBe(true);
		expect(writes).toEqual(["release", "state:unstarted"]);
		expect(emitted.map((e) => e.kind)).toEqual(["release", "warning"]);
		expect(emitted[1]?.payload).toMatchObject({ target: "linear", action: "release" });
		expect(emitted[1]).toMatchObject({ graph_id: "ut-1", node_id: "n1", repo: "swcstudiospace/agent-substrate" });
	});

	test("an unknown node throws rather than answering for a node that does not exist", async () => {
		const { index, greptime } = holderStores();
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: greptime as never, mirror: trackerLinear().mirror });

		await expect(substrate.releaseNode("ut-1", "n9", "claude-code", "sess-holder")).rejects.toThrow("unknown node ut-1/n9");
	});
});
