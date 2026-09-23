import { describe, expect, test } from "bun:test";
import { identifierFromLinearUrl, mapNotionRows, nodeIdFromTitle, toNodeState, toSurface, type NotionRow } from "./backfill.ts";

describe("nodeIdFromTitle", () => {
	test("reads the [nN] prefix the tracker actually writes", () => {
		expect(nodeIdFromTitle("[n5] Rule out Linear API-side limitations")).toBe("n5");
		expect(nodeIdFromTitle("[n12] Something")).toBe("n12");
		expect(nodeIdFromTitle("  [N3] Upper case")).toBe("n3");
	});

	test("returns null when there is no prefix", () => {
		expect(nodeIdFromTitle("Ordered execution plan")).toBeNull();
		expect(nodeIdFromTitle(null)).toBeNull();
		expect(nodeIdFromTitle("n5 without brackets")).toBeNull();
	});
});

describe("identifierFromLinearUrl", () => {
	test("extracts the identifier from a real Linear URL", () => {
		expect(
			identifierFromLinearUrl("https://linear.app/swcstudio/issue/SPE-132/identify-missing-information"),
		).toBe("SPE-132");
	});

	test("returns null for a non-issue URL", () => {
		expect(identifierFromLinearUrl("https://linear.app/swcstudio/team/SPE/all")).toBeNull();
		expect(identifierFromLinearUrl(null)).toBeNull();
	});
});

describe("toNodeState", () => {
	test("maps Notion's mirrored states onto the workflow states", () => {
		expect(toNodeState("Backlog")).toBe("backlog");
		expect(toNodeState("Todo")).toBe("unstarted");
		expect(toNodeState("In Progress")).toBe("started");
		expect(toNodeState("In Review")).toBe("started_review");
		expect(toNodeState("Done")).toBe("completed");
		expect(toNodeState("Canceled")).toBe("canceled");
	});

	test("returns null rather than guessing at an unknown state", () => {
		expect(toNodeState("Something Else")).toBeNull();
		expect(toNodeState(null)).toBeNull();
	});
});

describe("mapNotionRows", () => {
	// Shaped after real rows from the Agent Task Graph.
	const rows: NotionRow[] = [
		{
			url: "https://notion.so/task",
			"Graph ID": "ut-mucem4mc-ec70360f",
			Level: "Task",
			Item: "Fix the CoT truncation",
			Repo: "swcstudiospace/claude-ultrathink",
			Branch: "main",
			Status: "Implementing",
			Agent: "claude-code",
		},
		{
			url: "https://notion.so/n5",
			"Graph ID": "ut-mucem4mc-ec70360f",
			Level: "Issue",
			Item: "[n5] Rule out Linear API-side limitations",
			"Issue ID": "SPE-121",
			"Linear URL": "https://linear.app/swcstudio/issue/SPE-121/rule-out",
			"Linear State": "In Progress",
		},
		{
			url: "https://notion.so/n6-step",
			"Graph ID": "ut-mucem4mc-ec70360f",
			Level: "Sub-Issue",
			Item: "[n6] Node Detail",
			"Issue ID": null,
			"Linear URL": "https://linear.app/swcstudio/issue/SPE-132/identify-missing",
			Step: 1,
		},
	];

	test("splits rows into a task, its nodes and its steps", () => {
		const [plan] = mapNotionRows(rows);
		expect(plan?.graph_id).toBe("ut-mucem4mc-ec70360f");
		expect(plan?.repo).toBe("swcstudiospace/claude-ultrathink");
		expect(plan?.surface).toBe("claude-code");
		expect(plan?.status).toBe("Implementing");
		expect(plan?.notion_task_page).toBe("https://notion.so/task");
		expect(plan?.steps).toHaveLength(1);
	});

	test("reads the identifier from Issue ID, and from the URL when it is null", () => {
		const [plan] = mapNotionRows(rows);
		expect(plan?.nodes.find((n) => n.node_id === "n5")?.linear_identifier).toBe("SPE-121");
		expect(plan?.steps[0]?.node_id).toBe("n6");
	});

	test("invents the parent node for an orphan step so the foreign key holds", () => {
		const [plan] = mapNotionRows(rows);
		// n6's Issue row was never in this page of results.
		expect(plan?.nodes.map((n) => n.node_id)).toEqual(["n5", "n6"]);
	});

	test("sorts nodes numerically, so n10 follows n9 rather than n1", () => {
		const many = ["n1", "n2", "n10", "n9"].map((id) => ({
			"Graph ID": "g",
			Level: "Issue",
			Item: `[${id}] x`,
		}));
		expect(mapNotionRows(many)[0]?.nodes.map((n) => n.node_id)).toEqual(["n1", "n2", "n9", "n10"]);
	});

	test("groups multiple graphs separately", () => {
		const plans = mapNotionRows([
			{ "Graph ID": "g1", Level: "Issue", Item: "[n1] a" },
			{ "Graph ID": "g2", Level: "Issue", Item: "[n1] b" },
		]);
		expect(plans).toHaveLength(2);
	});

	test("ignores rows with no Graph ID or no node id", () => {
		const plans = mapNotionRows([
			{ Level: "Issue", Item: "[n1] no graph id" },
			{ "Graph ID": "g", Level: "Issue", Item: "no node id prefix" },
		]);
		expect(plans).toHaveLength(1);
		expect(plans[0]?.nodes).toHaveLength(0);
	});
});

describe("toSurface", () => {
	test("accepts known surfaces, normalising separators", () => {
		expect(toSurface("claude-code")).toBe("claude-code");
		expect(toSurface("Grok Build")).toBe("grok-build");
		expect(toSurface("  HERMES ")).toBe("hermes");
	});

	test("rejects free text rather than poisoning the index", () => {
		// Notion's Agent column is plain text, so anything can land in it.
		expect(toSurface("ove on a laptop")).toBeNull();
		expect(toSurface("")).toBeNull();
		expect(toSurface(null)).toBeNull();
	});
});
