/**
 * `openGraphs` against a real Postgres.
 *
 * Proves what the batched read must still mean after it stopped querying
 * `graph_nodes` once per open graph: the open rows of one repo in `updated desc`
 * order, each carrying its own nodes in `node_id` order (and `[]` when it has
 * none), terminal graphs and other repos absent, and `excludeGraphId` dropping
 * exactly one graph. The `in ${sql(ids)}` list and the per-graph grouping are
 * the parts a fake cannot vouch for, so this is skipped unless a database is given:
 *
 *     SUBSTRATE_TEST_PG_URL=postgres://… bun test index-store.open-graphs
 *
 * Every row written here carries `RUN` in its graph id and `afterAll` removes them.
 *
 * The round-trip count itself (two statements, however many graphs are open) is
 * not asserted: neither `IndexStore` nor the plane gate counts statements, and
 * the scratch database has no `pg_stat_statements`. It is read off the method.
 */
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { IndexStore } from "./index-store.ts";
import { defined } from "./test-support.ts";

const PG_URL = process.env.SUBSTRATE_TEST_PG_URL?.trim();
const RUN = `ut-opengraphs-${Date.now().toString(36)}`;
const REPO = `${RUN}/repo`;
const OTHER_REPO = `${RUN}/other-repo`;

let store: IndexStore;
let raw: SQL;
/** One instant for the whole suite; every seeded timestamp is this minus whole minutes. */
const NOW = Date.now();
const ago = (minutes: number): Date => new Date(NOW - minutes * 60_000);

const describeLive = PG_URL ? describe : describe.skip;

/** `<RUN>-<name>`, so every id in this suite is findable by prefix. */
const id = (name: string): string => `${RUN}-${name}`;

describeLive("openGraphs against a live index", () => {
	beforeAll(async () => {
		store = new IndexStore(defined(PG_URL, "SUBSTRATE_TEST_PG_URL"));
		raw = new SQL(defined(PG_URL, "SUBSTRATE_TEST_PG_URL"));
		await store.migrate();
		await seed();
	});

	afterAll(async () => {
		if (!PG_URL) return;
		const like = `${RUN}%`;
		for (const table of ["graph_edges", "graph_steps", "graph_bindings", "graph_nodes", "graph_index"]) {
			await raw.unsafe(`delete from ${table} where graph_id like $1`, [like]).catch(() => undefined);
		}
		await raw.end().catch(() => undefined);
		await store.close().catch(() => undefined);
	});

	async function seed(): Promise<void> {
		// name, repo, status, minutes ago (updated), node ids in insertion order —
		// deliberately not sorted, so `order by node_id` is observable.
		const graphs: Array<[string, string, string | null, number, string[]]> = [
			["g-open-progress", REPO, "In Progress", 30, ["n2", "n1"]],
			["g-open-null", REPO, null, 10, []],
			["g-open-todo", REPO, "Todo", 20, ["n3", "n1", "n2"]],
			["g-merged", REPO, "Merged", 5, ["n2", "n1"]],
			["g-other-repo", OTHER_REPO, "In Progress", 1, ["n1"]],
		];
		for (const [name, repo, status, minutes, nodeIds] of graphs) {
			const graphId = id(name);
			await raw`
				insert into graph_index (graph_id, repo, status, created, updated)
				values (${graphId}, ${repo}, ${status}, ${ago(minutes)}, ${ago(minutes)})`;
			for (const nodeId of nodeIds) {
				await raw`insert into graph_nodes (graph_id, node_id, state) values (${graphId}, ${nodeId}, 'pending')`;
			}
		}
	}

	test("returns the repo's open graphs newest first, each with its own nodes in node_id order", async () => {
		const views = await store.openGraphs(REPO);

		expect(views.map((v) => v.graph_id)).toEqual([id("g-open-null"), id("g-open-todo"), id("g-open-progress")]);
		for (const view of views) {
			expect(view.repo).toBe(REPO);
			expect(view.steps).toEqual([]);
			expect(view.edges).toEqual([]);
			for (const node of view.nodes) expect(node.graph_id).toBe(view.graph_id);
		}

		const nodeIds = Object.fromEntries(views.map((v) => [v.graph_id, v.nodes.map((n) => n.node_id)]));
		expect(nodeIds).toEqual({
			[id("g-open-progress")]: ["n1", "n2"],
			[id("g-open-null")]: [],
			[id("g-open-todo")]: ["n1", "n2", "n3"],
		});
	});

	test("the terminal graph and the other repo's graph are absent", async () => {
		const ids = (await store.openGraphs(REPO)).map((v) => v.graph_id);
		expect(ids).not.toContain(id("g-merged"));
		expect(ids).not.toContain(id("g-other-repo"));

		const other = await store.openGraphs(OTHER_REPO);
		expect(other.map((v) => v.graph_id)).toEqual([id("g-other-repo")]);
		expect(other[0]?.nodes.map((n) => n.node_id)).toEqual(["n1"]);
	});

	test("excludeGraphId drops that graph only", async () => {
		const views = await store.openGraphs(REPO, id("g-open-todo"));
		expect(views.map((v) => v.graph_id)).toEqual([id("g-open-null"), id("g-open-progress")]);
		expect(views[1]?.nodes.map((n) => n.node_id)).toEqual(["n1", "n2"]);
	});

	test("a repo with no open graphs is empty", async () => {
		expect(await store.openGraphs(`${RUN}/nowhere`)).toEqual([]);
	});
});
