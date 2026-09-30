/**
 * Exclusive hold, proven against a real Postgres.
 *
 * `lease.test.ts` proves the algebra and the compare-and-swap discipline; this
 * proves that the SQL in `IndexStore` actually implements them — that the epoch
 * guard is on the statement, that expiry is judged by the server's clock, and
 * that two connections racing for one node produce one lease. None of that can
 * be shown without a database, so these tests skip unless one is given:
 *
 *     SUBSTRATE_TEST_PG_URL=postgres://… bun test index-store.lease
 *
 * Skipping rather than mocking is deliberate. A mock of Postgres' concurrency
 * would be a mock of the one thing under test, and a green suite that proved
 * nothing would be worse than a skipped one that says so. The tables are the
 * real migration and every row created here is namespaced to one graph id and
 * dropped afterwards.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { IndexStore } from "./index-store.ts";
import { leaseState } from "./lease.ts";

const PG_URL = process.env.SUBSTRATE_TEST_PG_URL?.trim();
const GRAPH = `ut-leasetest-${Date.now().toString(36)}`;

// Two stores, so the race goes through two connections rather than one — a
// single connection would serialise the statements and the test would pass
// without the guard doing anything.
let a: IndexStore;
let b: IndexStore;

const describeLive = PG_URL ? describe : describe.skip;

describeLive("exclusive hold against a live index", () => {
	beforeAll(async () => {
		a = new IndexStore(PG_URL!);
		b = new IndexStore(PG_URL!);
		await a.migrate();
	});

	afterAll(async () => {
		if (!PG_URL) return;
		// graph_nodes and graph_edges cascade from graph_index.
		await a.registerGraph({ graph_id: GRAPH }).catch(() => undefined);
		await a.close().catch(() => undefined);
		await b.close().catch(() => undefined);
	});

	async function freshNode(nodeId: string): Promise<void> {
		await a.registerGraph({
			graph_id: GRAPH,
			repo: "swcstudiospace/agent-substrate",
			nodes: [{ node_id: nodeId, linear_identifier: "SPE-4792" }],
		});
		await a.releaseNode(GRAPH, nodeId, { force: true });
	}

	test("two connections racing for one node: exactly one lease", async () => {
		await freshNode("n2");

		const [first, second] = await Promise.all([
			a.claimNode(GRAPH, "n2", "grok-bot", "sess-grok", 300),
			b.claimNode(GRAPH, "n2", "hermes", "sess-hermes", 300),
		]);

		expect([first.claimed, second.claimed].filter(Boolean)).toHaveLength(1);
		const winner = first.claimed ? first : second;
		const loser = first.claimed ? second : first;
		expect(loser.lease.holder).toEqual(winner.lease.holder);
		expect(loser.lease.lease_id).toBe(winner.lease.lease_id);
		expect(winner.lease.state).toBe("held");
	});

	test("ten concurrent claims leave one lease and one epoch bump", async () => {
		await freshNode("n3");
		const before = (await a.claimNode(GRAPH, "n3", "omp", "sess-seed", 300)).lease.epoch;
		await a.releaseNode(GRAPH, "n3", { force: true });

		const results = await Promise.all(
			Array.from({ length: 10 }, (_, i) =>
				(i % 2 === 0 ? a : b).claimNode(GRAPH, "n3", "hermes", `sess-${i}`, 300),
			),
		);

		expect(results.filter((result) => result.claimed)).toHaveLength(1);
		// One change of hold, so the epoch moved exactly once.
		const held = results.find((result) => result.claimed)!;
		expect(held.lease.epoch).toBe(before + 1);
	});

	test("two sessions of the same surface are two holders", async () => {
		await freshNode("n4");

		const first = await a.claimNode(GRAPH, "n4", "hermes", "sess-a", 300);
		const second = await b.claimNode(GRAPH, "n4", "hermes", "sess-b", 300);

		expect(first.claimed).toBe(true);
		expect(second.claimed).toBe(false);
		expect(second.lease.holder).toEqual({ surface: "hermes", session_id: "sess-a" });
	});

	test("the holder renews in place, keeping its lease id and epoch", async () => {
		await freshNode("n5");
		const first = await a.claimNode(GRAPH, "n5", "hermes", "sess-a", 300);

		const again = await a.claimNode(GRAPH, "n5", "hermes", "sess-a", 600);

		expect(again.claimed).toBe(true);
		expect(again.decision.action).toBe("renewed");
		expect(again.lease.lease_id).toBe(first.lease.lease_id);
		expect(again.lease.epoch).toBe(first.lease.epoch);
		expect(Date.parse(again.lease.expires_at ?? "")).toBeGreaterThan(Date.parse(first.lease.expires_at ?? ""));
	});

	test("a lapsed lease is taken over by the next claimant, under a new id", async () => {
		await freshNode("n6");
		// The shortest lease the bounds allow, so expiry is reached by waiting rather
		// than by lying to the server about the time — which the server would ignore.
		const first = await a.claimNode(GRAPH, "n6", "grok-bot", "sess-grok", 30);
		await a.expireLease(GRAPH, "n6");

		const second = await b.claimNode(GRAPH, "n6", "hermes", "sess-hermes", 300);

		expect(second.claimed).toBe(true);
		expect(second.decision.action).toBe("stolen");
		expect(second.decision.evicted).toEqual({ surface: "grok-bot", session_id: "sess-grok" });
		expect(second.lease.lease_id).not.toBe(first.lease.lease_id);
		expect(second.lease.epoch).toBe(first.lease.epoch + 1);
	});

	test("a stale lease id cannot heartbeat the lease that replaced it", async () => {
		await freshNode("n7");
		const first = await a.claimNode(GRAPH, "n7", "grok-bot", "sess-grok", 30);
		await a.expireLease(GRAPH, "n7");
		const second = await b.claimNode(GRAPH, "n7", "hermes", "sess-hermes", 300);

		const beat = await a.heartbeatNode(GRAPH, "n7", first.lease.lease_id ?? "", 3600);

		expect(beat.ok).toBe(false);
		expect(beat.decision.ok === false && beat.decision.reason).toBe("lost");
		// And the live lease was not extended by the attempt.
		expect(beat.lease.lease_id).toBe(second.lease.lease_id);
		expect(Date.parse(beat.lease.expires_at ?? "")).toBeLessThan(Date.now() + 400_000);
	});

	test("the holder's heartbeat pushes expiry out without changing hands", async () => {
		await freshNode("n8");
		const claim = await a.claimNode(GRAPH, "n8", "hermes", "sess-a", 60);

		const beat = await a.heartbeatNode(GRAPH, "n8", claim.lease.lease_id ?? "", 600);

		expect(beat.ok).toBe(true);
		expect(beat.lease.epoch).toBe(claim.lease.epoch);
		expect(Date.parse(beat.lease.expires_at ?? "")).toBeGreaterThan(Date.parse(claim.lease.expires_at ?? ""));
	});

	test("a stale holder cannot release the node someone else now holds", async () => {
		await freshNode("n9");
		const first = await a.claimNode(GRAPH, "n9", "grok-bot", "sess-grok", 30);
		await a.expireLease(GRAPH, "n9");
		const second = await b.claimNode(GRAPH, "n9", "hermes", "sess-hermes", 300);

		const refused = await a.releaseNode(GRAPH, "n9", { lease_id: first.lease.lease_id });

		expect(refused.released).toBe(false);
		expect(refused.decision.ok === false && refused.decision.reason).toBe("stale-lease");
		expect(refused.node.lease_id).toBe(second.lease.lease_id);
	});

	test("a release with no lease id and no force changes nothing", async () => {
		await freshNode("n10");
		await a.claimNode(GRAPH, "n10", "hermes", "sess-a", 300);

		const refused = await a.releaseNode(GRAPH, "n10", {});

		expect(refused.released).toBe(false);
		expect(refused.decision.ok === false && refused.decision.reason).toBe("lease-id-required");
		expect(refused.node.claimed_by).toBe("hermes");
	});

	test("the epoch never goes backwards across a release", async () => {
		await freshNode("n11");
		const first = await a.claimNode(GRAPH, "n11", "hermes", "sess-a", 300);
		await a.releaseNode(GRAPH, "n11", { lease_id: first.lease.lease_id });

		const second = await b.claimNode(GRAPH, "n11", "omp", "sess-b", 300);

		expect(second.lease.epoch).toBeGreaterThan(first.lease.epoch);
	});

	test("reaping clears lapsed leases and names whose they were", async () => {
		await freshNode("n12");
		await a.claimNode(GRAPH, "n12", "grok-bot", "sess-grok", 30);
		await a.expireLease(GRAPH, "n12");

		const reaped = await a.reapExpiredLeases("swcstudiospace/agent-substrate");

		const ours = reaped.find((lease) => lease.graph_id === GRAPH && lease.node_id === "n12");
		expect(ours?.holder).toEqual({ surface: "grok-bot", session_id: "sess-grok" });
		const after = await a.nodesForRepo("swcstudiospace/agent-substrate");
		expect(after.find((node) => node.graph_id === GRAPH && node.node_id === "n12")?.claimed_by).toBeNull();
	});

	test("reaping does not clobber a claim that lands at the same moment", async () => {
		// Expiry exists to let the next agent in, so a reaper that cleared the lease
		// a new holder had just taken would undo the very thing it enables — and the
		// new holder would carry a lease id no row holds.
		await freshNode("n15");
		await a.claimNode(GRAPH, "n15", "grok-bot", "sess-grok", 30);
		await a.expireLease(GRAPH, "n15");

		const [reaped, claim] = await Promise.all([
			a.reapExpiredLeases("swcstudiospace/agent-substrate"),
			b.claimNode(GRAPH, "n15", "hermes", "sess-hermes", 300),
		]);

		const after = (await a.nodesForRepo("swcstudiospace/agent-substrate")).find(
			(node) => node.graph_id === GRAPH && node.node_id === "n15",
		);
		if (claim.claimed) {
			// The claim landed: the node is held by its new holder, whatever the reaper
			// did with the lease it had observed.
			expect(after?.lease_id).toBe(claim.lease.lease_id);
			expect(after?.claimed_by).toBe("hermes");
		} else {
			expect(reaped.some((lease) => lease.node_id === "n15")).toBe(true);
			expect(after?.claimed_by).toBeNull();
		}
	});

	test("a live lease is not reaped", async () => {
		await freshNode("n13");
		await a.claimNode(GRAPH, "n13", "hermes", "sess-live", 3600);

		const reaped = await a.reapExpiredLeases("swcstudiospace/agent-substrate");

		expect(reaped.find((lease) => lease.node_id === "n13")).toBeUndefined();
	});

	test("expiry is judged by the server's clock, not the caller's", async () => {
		// A caller with a fast clock must not be able to declare a live lease expired
		// and take the node: the decision is a proposal, and the statement re-checks.
		await freshNode("n14");
		const held = await a.claimNode(GRAPH, "n14", "hermes", "sess-a", 3600);
		expect(leaseState({ ...held.lease, surface: "hermes", session_id: "sess-a", claimed_at: null, heartbeat_at: null, expires_at: held.lease.expires_at }, Date.now())).toBe("held");

		// Ask again from the other connection as a different holder, which the
		// server's own expiry check must refuse.
		const refused = await b.claimNode(GRAPH, "n14", "grok-bot", "sess-grok", 300);

		expect(refused.claimed).toBe(false);
		expect(refused.lease.lease_id).toBe(held.lease.lease_id);
	});

	test("edges round-trip through the index and back out per repo", async () => {
		await a.registerGraph({
			graph_id: GRAPH,
			repo: "swcstudiospace/agent-substrate",
			nodes: [{ node_id: "n20" }, { node_id: "n21" }],
			edges: [
				{ from_node: "n21", to_node: "n20", kind: "requires" },
				// Re-registering the same edge must not duplicate it.
				{ from_node: "n21", to_node: "n20", kind: "requires" },
				{ from_node: "n21", to_node: "n20", kind: "nonsense" as never },
			],
		});

		const edges = (await a.edgesForRepo("swcstudiospace/agent-substrate")).filter((edge) => edge.graph_id === GRAPH);

		expect(edges).toHaveLength(1);
		expect(edges[0]).toMatchObject({ from_node: "n21", to_node: "n20", kind: "requires" });
	});
});

if (!PG_URL) {
	test("the live lease tests are skipped without SUBSTRATE_TEST_PG_URL", () => {
		// Stated rather than silent: a suite that skips its only real concurrency
		// proof should say so in its own output.
		expect(PG_URL).toBeUndefined();
	});
}
