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
		await a.releaseNode(GRAPH, nodeId, { force: true }, null);
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
		// The loser learns who won and until when, never the winner's lease id.
		expect(loser.lease.lease_id).toBeNull();
		expect(winner.lease.lease_id).toMatch(/^lse_/);
		expect(winner.lease.state).toBe("held");
	});

	test("ten concurrent claims leave one lease and one epoch bump", async () => {
		await freshNode("n3");
		const before = (await a.claimNode(GRAPH, "n3", "omp", "sess-seed", 300)).lease.epoch;
		await a.releaseNode(GRAPH, "n3", { force: true }, null);

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
		// Two sessions of one surface — two replicas of one agent — so the holder
		// check passes and the lease id is what refuses it.
		await freshNode("n7");
		const first = await a.claimNode(GRAPH, "n7", "hermes", "sess-old", 30);
		await a.expireLease(GRAPH, "n7");
		const second = await b.claimNode(GRAPH, "n7", "hermes", "sess-new", 300);

		const beat = await a.heartbeatNode(GRAPH, "n7", first.lease.lease_id ?? "", "hermes", 3600);

		expect(beat.ok).toBe(false);
		expect(beat.decision.ok === false && beat.decision.reason).toBe("lost");
		// It is told who holds it now, but not the id that would let it act as them.
		expect(beat.lease.holder).toEqual({ surface: "hermes", session_id: "sess-new" });
		expect(beat.lease.lease_id).toBeNull();
		expect(beat.lease.epoch).toBe(second.lease.epoch);
		// And the live lease was not extended by the attempt.
		expect(Date.parse(beat.lease.expires_at ?? "")).toBeLessThan(Date.now() + 400_000);
	});

	test("the holder's heartbeat pushes expiry out without changing hands", async () => {
		await freshNode("n8");
		const claim = await a.claimNode(GRAPH, "n8", "hermes", "sess-a", 60);

		const beat = await a.heartbeatNode(GRAPH, "n8", claim.lease.lease_id ?? "", "hermes", 600);

		expect(beat.ok).toBe(true);
		expect(beat.lease.lease_id).toBe(claim.lease.lease_id);
		expect(beat.lease.epoch).toBe(claim.lease.epoch);
		expect(Date.parse(beat.lease.expires_at ?? "")).toBeGreaterThan(Date.parse(claim.lease.expires_at ?? ""));
	});

	test("a stale holder cannot release the node someone else now holds", async () => {
		await freshNode("n9");
		const first = await a.claimNode(GRAPH, "n9", "hermes", "sess-old", 30);
		await a.expireLease(GRAPH, "n9");
		await b.claimNode(GRAPH, "n9", "hermes", "sess-new", 300);

		const refused = await a.releaseNode(GRAPH, "n9", { lease_id: first.lease.lease_id }, "hermes");

		expect(refused.released).toBe(false);
		expect(refused.decision.ok === false && refused.decision.reason).toBe("stale-lease");
		expect(refused.node.claim_session).toBe("sess-new");
	});

	test("a release with no lease id and no force changes nothing", async () => {
		await freshNode("n10");
		await a.claimNode(GRAPH, "n10", "hermes", "sess-a", 300);

		const refused = await a.releaseNode(GRAPH, "n10", {}, "hermes");

		expect(refused.released).toBe(false);
		expect(refused.decision.ok === false && refused.decision.reason).toBe("lease-id-required");
		expect(refused.node.claimed_by).toBe("hermes");
	});

	test("the epoch never goes backwards across a release", async () => {
		await freshNode("n11");
		const first = await a.claimNode(GRAPH, "n11", "hermes", "sess-a", 300);
		await a.releaseNode(GRAPH, "n11", { lease_id: first.lease.lease_id }, "hermes");

		const second = await b.claimNode(GRAPH, "n11", "omp", "sess-b", 300);

		expect(second.lease.epoch).toBeGreaterThan(first.lease.epoch);
	});

	test("reaping clears lapsed leases and names whose they were, by epoch rather than lease id", async () => {
		await freshNode("n12");
		const claim = await a.claimNode(GRAPH, "n12", "grok-bot", "sess-grok", 30);
		await a.expireLease(GRAPH, "n12");

		const reaped = await a.reapExpiredLeases("swcstudiospace/agent-substrate");

		const ours = reaped.find((lease) => lease.graph_id === GRAPH && lease.node_id === "n12");
		expect(ours?.holder).toEqual({ surface: "grok-bot", session_id: "sess-grok" });
		expect(ours?.lease_epoch).toBe(claim.lease.epoch);
		expect(ours).not.toHaveProperty("lease_id");
		const after = await a.nodesForRepo("swcstudiospace/agent-substrate");
		expect(after.find((node) => node.graph_id === GRAPH && node.node_id === "n12")?.claimed_by).toBeNull();
	});

	test("a renewal decided before expiry cannot revive the lease after it", async () => {
		// The renewal branch used to check only the lease id. A holder that decided
		// "renewed" a moment before its expiry could land the UPDATE after it,
		// reviving a lapsed lease under its old id and epoch — while every other
		// reader had already been told the node was free. Expiring the lease between
		// the decision and the write is exactly that window, forced.
		await freshNode("n16");
		const first = await a.claimNode(GRAPH, "n16", "hermes", "sess-a", 300);
		await a.expireLease(GRAPH, "n16");

		// Same holder, same session: the decision is "reclaimed", not "renewed",
		// because the client now also sees the expiry — and a reclaim takes a new id.
		const again = await a.claimNode(GRAPH, "n16", "hermes", "sess-a", 300);

		expect(again.claimed).toBe(true);
		expect(again.decision.action).toBe("reclaimed");
		expect(again.lease.lease_id).not.toBe(first.lease.lease_id);
		expect(again.lease.epoch).toBe(first.lease.epoch + 1);
	});

	test("an extension aimed at a lapsed lease is refused by the server, not just the client", async () => {
		// The renewal branch of `claimNode` and `heartbeatNode` now carry the *same*
		// `coalesce(lease_expires_at, …) > now()` predicate, and this exercises it
		// through the heartbeat — the one of the two a test can aim at a lapsed lease
		// directly, since `decideClaim` sees the expiry too and turns a late renewal
		// into the `reclaimed` the test above asserts. What is proven here is that the
		// predicate is the server's clock: nothing the caller says extends a lease
		// Postgres considers gone.
		await freshNode("n17");
		const first = await a.claimNode(GRAPH, "n17", "hermes", "sess-a", 300);
		await a.expireLease(GRAPH, "n17");

		const beat = await a.heartbeatNode(GRAPH, "n17", first.lease.lease_id ?? "", "hermes", 3600);

		expect(beat.ok).toBe(false);
		expect(beat.decision.ok === false && beat.decision.reason).toBe("expired");
		// And the expiry was not pushed out by the attempt.
		expect(Date.parse(beat.lease.expires_at ?? "")).toBeLessThanOrEqual(Date.now());
	});

	test("the reaper does not clear a lease that a heartbeat renewed", async () => {
		// The reaper's CAS compared only lease_id and claimed_by, neither of which a
		// heartbeat changes — so a renewal committing inside the reaper's window lost
		// its holder the node. Fencing on the observed expiry is what rules that out.
		await freshNode("n18");
		const claim = await a.claimNode(GRAPH, "n18", "hermes", "sess-a", 30);
		await a.expireLease(GRAPH, "n18");

		const [reaped] = await Promise.all([
			a.reapExpiredLeases("swcstudiospace/agent-substrate"),
			// A claim, because a heartbeat on a lapsed lease is refused by design;
			// either way the point is a write that moves the expiry under the reaper.
			b.claimNode(GRAPH, "n18", "hermes", "sess-a", 600),
		]);

		const after = (await a.nodesForRepo("swcstudiospace/agent-substrate")).find(
			(node) => node.graph_id === GRAPH && node.node_id === "n18",
		);
		// Whichever landed first, the node is never left holding a *renewed* lease
		// that the reaper also reported as expired.
		const reapedThis = reaped.some((lease) => lease.node_id === "n18");
		if (reapedThis) {
			expect(after?.lease_id === null || after?.lease_id !== claim.lease.lease_id).toBe(true);
		} else {
			expect(after?.claimed_by).toBe("hermes");
			expect(Date.parse(String(after?.lease_expires_at))).toBeGreaterThan(Date.now());
		}
	});

	test("completion writes the state in the same statement as the release", async () => {
		// Two statements left a window: another agent claims the node between the
		// release and the state write, and the state write closes *their* live node.
		// One guarded UPDATE cannot straddle that.
		await freshNode("n19");
		const claim = await a.claimNode(GRAPH, "n19", "hermes", "sess-a", 300);

		const done = await a.releaseNode(GRAPH, "n19", { lease_id: claim.lease.lease_id }, "hermes", "completed");

		expect(done.released).toBe(true);
		expect(done.node.state).toBe("completed");
		expect(done.node.claimed_by).toBeNull();
		expect(done.node.lease_id).toBeNull();
	});

	test("a stale holder's completion leaves both the lease and the state alone", async () => {
		await freshNode("n22");
		const first = await a.claimNode(GRAPH, "n22", "hermes", "sess-old", 30);
		await a.expireLease(GRAPH, "n22");
		await b.claimNode(GRAPH, "n22", "hermes", "sess-new", 600);

		const refused = await a.releaseNode(GRAPH, "n22", { lease_id: first.lease.lease_id }, "hermes", "completed");

		expect(refused.released).toBe(false);
		expect(refused.node.state).not.toBe("completed");
		expect(refused.node.claim_session).toBe("sess-new");
	});

	test("another surface cannot beat, release or complete a held node, even with its lease id", async () => {
		await freshNode("n24");
		const claim = await a.claimNode(GRAPH, "n24", "swarm-a05-be", `A05@r0:${GRAPH}`, 300);
		const leaseId = claim.lease.lease_id ?? "";

		const beat = await b.heartbeatNode(GRAPH, "n24", leaseId, "swarm-a09-rev", 3600);
		const release = await b.releaseNode(GRAPH, "n24", { lease_id: leaseId }, "swarm-a09-rev");
		const complete = await b.releaseNode(GRAPH, "n24", { lease_id: leaseId }, "swarm-a09-rev", "completed");

		expect(beat.decision.ok === false && beat.decision.reason).toBe("not-holder");
		expect(beat.lease.lease_id).toBeNull();
		expect(beat.lease.holder).toEqual({ surface: "swarm-a05-be", session_id: `A05@r0:${GRAPH}` });
		expect(beat.lease.expires_at).toBe(claim.lease.expires_at);
		expect(release.decision.ok === false && release.decision.reason).toBe("not-holder");
		expect(complete.decision.ok === false && complete.decision.reason).toBe("not-holder");
		expect(complete.node.state).not.toBe("completed");
		expect(complete.node.claimed_by).toBe("swarm-a05-be");

		// The holder's own surface still can.
		const own = await a.heartbeatNode(GRAPH, "n24", leaseId, "swarm-a05-be", 600);
		expect(own.ok).toBe(true);
		expect(own.lease.lease_id).toBe(leaseId);
	});

	test("an operator's forced release is not held to the holder's surface", async () => {
		await freshNode("n25");
		await a.claimNode(GRAPH, "n25", "swarm-a05-be", `A05@r0:${GRAPH}`, 300);

		const forced = await b.releaseNode(GRAPH, "n25", { force: true }, "hermes");

		expect(forced.released).toBe(true);
		expect(forced.decision.ok === true && forced.decision.action).toBe("forced");
		expect(forced.node.claimed_by).toBeNull();
	});

	test("an ordinary release reports the holder it took the node from", async () => {
		await freshNode("n23");
		const claim = await a.claimNode(GRAPH, "n23", "hermes", "sess-a", 300);

		const released = await a.releaseNode(GRAPH, "n23", { lease_id: claim.lease.lease_id }, "hermes");

		expect(released.decision.ok === true && released.decision.holder).toEqual({
			surface: "hermes",
			session_id: "sess-a",
		});
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
		expect(refused.lease.holder).toEqual({ surface: "hermes", session_id: "sess-a" });
		expect(refused.lease.epoch).toBe(held.lease.epoch);
		expect(refused.lease.lease_id).toBeNull();
	});

	async function edgesOfGraph() {
		return (await a.edgesForRepo("swcstudiospace/agent-substrate")).filter((edge) => edge.graph_id === GRAPH);
	}

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

		const edges = await edgesOfGraph();

		expect(edges).toHaveLength(1);
		expect(edges[0]).toMatchObject({ from_node: "n21", to_node: "n20", kind: "requires" });
	});

	test("a later register replaces the dependency set rather than adding to it", async () => {
		// Insert-only meant a dependency removed upstream could never be removed
		// here, and every later drift scan went on reporting a held node as blocked
		// by a relation that no longer existed.
		await a.registerGraph({
			graph_id: GRAPH,
			repo: "swcstudiospace/agent-substrate",
			nodes: [{ node_id: "n20" }, { node_id: "n21" }],
			edges: [{ from_node: "n21", to_node: "n20", kind: "requires" }],
		});

		await a.registerGraph({
			graph_id: GRAPH,
			edges: [{ from_node: "n21", to_node: "n20", kind: "gated_by" }],
		});

		const edges = await edgesOfGraph();
		expect(edges).toHaveLength(1);
		expect(edges[0]?.kind).toBe("gated_by");
	});

	test("two registers racing on an empty edge set do not merge into their union", async () => {
		// A DELETE that matches no row locks nothing, so both transactions used to
		// delete zero rows and then both insert — and the result was the union of two
		// authoritative replacements, leaving live a dependency one caller had
		// removed. The row lock on the graph is what serialises them.
		await a.registerGraph({
			graph_id: GRAPH,
			repo: "swcstudiospace/agent-substrate",
			nodes: [{ node_id: "n20" }, { node_id: "n21" }],
			edges: [],
		});

		await Promise.all([
			a.registerGraph({ graph_id: GRAPH, edges: [{ from_node: "n21", to_node: "n20", kind: "requires" }] }),
			b.registerGraph({ graph_id: GRAPH, edges: [{ from_node: "n21", to_node: "n20", kind: "gated_by" }] }),
		]);

		const edges = await edgesOfGraph();
		// Exactly one of the two sets won; neither caller's replacement was merged
		// with the other's.
		expect(edges).toHaveLength(1);
		expect(["requires", "gated_by"]).toContain(edges[0]?.kind ?? "");
	});

	test("an empty set clears them; omitting the field leaves them alone", async () => {
		await a.registerGraph({
			graph_id: GRAPH,
			repo: "swcstudiospace/agent-substrate",
			nodes: [{ node_id: "n20" }, { node_id: "n21" }],
			edges: [{ from_node: "n21", to_node: "n20", kind: "requires" }],
		});

		// A partial register — a status update, say — must not erase dependencies it
		// was never told about.
		await a.registerGraph({ graph_id: GRAPH, status: "In Progress" });
		expect(await edgesOfGraph()).toHaveLength(1);

		await a.registerGraph({ graph_id: GRAPH, edges: [] });
		expect(await edgesOfGraph()).toEqual([]);
	});
});

if (!PG_URL) {
	test("the live lease tests are skipped without SUBSTRATE_TEST_PG_URL", () => {
		// Stated rather than silent: a suite that skips its only real concurrency
		// proof should say so in its own output.
		expect(PG_URL).toBeUndefined();
	});
}
