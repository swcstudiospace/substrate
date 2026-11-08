/**
 * The per-node artifact read (phase 38, B-D3): `nodeArtifactOf` reads the graph's whole ledger and keeps one node's
 * events. An unreadable or unconfigured ledger is an error, never an empty artifact a caller could mistake for "no steps".
 */
import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";
import { Substrate } from "./service.ts";

const GRAPH = "ut-1";

/** A ledger row as Greptime returns it: epoch-millis `ts`, and the payload as JSON text. */
function row(id: number, nodeId: string | null, payload: Record<string, unknown>): Record<string, unknown> {
	return {
		id: `evt_${id}`,
		ts: 1_700_000_000_000 + id,
		surface: "substrate",
		session_id: "sess-1",
		graph_id: GRAPH,
		node_id: nodeId,
		linear_identifier: null,
		step: null,
		repo: null,
		branch: null,
		actor: "omp",
		kind: "note",
		summary: `event ${id}`,
		payload: JSON.stringify(payload),
		hash: `h${id}`,
		prev: null,
	};
}

function substrateWith(greptime: unknown): Substrate {
	return new Substrate(loadConfig({}), { index: {} as never, greptime: greptime as never, mirror: null as never, steering: { history: null, liveSessions: null } });
}

const at = (id: number) => new Date(1_700_000_000_000 + id).toISOString();

describe("the per-node artifact read", () => {
	test("one node's events come back as its steps, in time order, and another node's or an unbound event never reaches it", async () => {
		const rows = [
			row(1, "n1", { action: "granted", lease_epoch: 1 }),
			row(2, "n2", { action: "mirror", target: "linear", op: "claim", status: "ok" }),
			row(3, "n1", { action: "mirror", target: "linear", op: "claim", status: "ok" }),
			row(4, "n1", { action: "mirror", target: "notion", op: "claim", status: "ok" }),
			row(5, null, { action: "mirror", target: "linear", op: "review", status: "ok" }),
			row(6, "n1", { action: "dod", status: "approved", already_done: false }),
		];

		const read = await substrateWith({ readEvents: async () => rows }).nodeArtifactOf(GRAPH, "n1");

		expect(read).toEqual({
			artifact: {
				node_id: "n1",
				claim: [{ ts: at(1), action: "granted" }],
				linear: [{ ts: at(3), op: "claim", status: "ok", reason: null, blocker_node: null, edge_kind: null }],
				notion: [{ ts: at(4), op: "claim", status: "ok", reason: null }],
				dod: [{ ts: at(6), status: "approved", reason: null }],
			},
		});
	});

	test("a node id is matched in the form the ledger stored it, so a long id keeps its history", async () => {
		const longId = "n".repeat(600);
		const stored = longId.slice(0, 512);
		const rows = [row(1, stored, { action: "mirror", target: "linear", op: "claim", status: "ok" })];

		const read = await substrateWith({ readEvents: async () => rows }).nodeArtifactOf(GRAPH, longId);

		expect(read).toEqual({
			artifact: expect.objectContaining({
				node_id: stored,
				linear: [expect.objectContaining({ op: "claim", status: "ok" })],
			}),
		});
	});

	test("an unreadable ledger is an error, never an empty artifact", async () => {
		const greptime = {
			readEvents: async () => {
				throw new Error("greptime unreachable: connect ETIMEDOUT");
			},
		};

		const read = await substrateWith(greptime).nodeArtifactOf(GRAPH, "n1");

		expect(read).toEqual({ error: expect.stringContaining("unreachable") });
	});

	test("no ledger configured is an error, never an empty artifact", async () => {
		const read = await substrateWith(null).nodeArtifactOf(GRAPH, "n1");

		expect(read).toEqual({ error: "GREPTIME_URL is not set" });
	});
});
