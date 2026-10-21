import { describe, expect, test } from "bun:test";
import { causalChain, graphLinks, reduceEvent } from "./memory-graph.ts";

function row(id: string, ts: number, graph = "g"): Record<string, unknown> {
	return {
		id,
		ts: `2026-10-21T10:00:${String(ts).padStart(2, "0")}Z`,
		kind: "agent.step",
		surface: "claude-code",
		graph_id: graph,
		node_id: null,
		summary: `summary ${id}`,
	};
}

describe("reduceEvent", () => {
	test("cuts the summary at 200 characters", () => {
		const reduced = reduceEvent({ id: "e1", ts: "t", kind: "k", surface: "s", node_id: null, summary: "a".repeat(250) });
		expect(reduced.summary.length).toBe(200);
		expect(reduced.summary).toBe("a".repeat(200));
	});
});

describe("graphLinks", () => {
	test("keeps the newest five events per graph, newest first", () => {
		const rows = [row("e3", 3), row("e1", 1), row("e7", 7), row("e5", 5), row("e2", 2), row("e6", 6), row("e4", 4)];
		const links = graphLinks(["g"], new Map([["g", rows]]));
		expect(links).toHaveLength(1);
		expect(links[0]?.events.map((event) => event.id)).toEqual(["e7", "e6", "e5", "e4", "e3"]);
	});

	test("gives a graph with no rows an empty events list", () => {
		const links = graphLinks(["g1", "g2"], new Map([["g1", [row("e1", 1, "g1")]]]));
		expect(links).toEqual([
			{ graph_id: "g1", events: [expect.objectContaining({ id: "e1" })] },
			{ graph_id: "g2", events: [] },
		]);
	});

	test("keeps first-seen order of distinct graph ids", () => {
		const links = graphLinks(["b", "a", "b", "c", "a"], new Map());
		expect(links.map((link) => link.graph_id)).toEqual(["b", "a", "c"]);
	});
});

describe("causalChain", () => {
	const session = [row("e1", 1), row("e2", 2), row("e3", 3), row("e4", 4), row("e5", 5), row("e6", 6), row("e7", 7), row("e8", 8)];

	test("returns up to five preceding events, nearest first, excluding the source and later rows", () => {
		const chain = causalChain(session, "e7");
		expect(chain.map((event) => event.id)).toEqual(["e6", "e5", "e4", "e3", "e2"]);
		expect(chain.map((event) => event.id)).not.toContain("e7");
		expect(chain.map((event) => event.id)).not.toContain("e8");
	});

	test("returns an empty list for an unknown source", () => {
		expect(causalChain(session, "missing")).toEqual([]);
	});
});
