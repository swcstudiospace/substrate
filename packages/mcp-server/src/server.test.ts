import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import { loadConfig } from "./config.ts";
import { createHttpServer } from "./server.ts";
import type { Substrate } from "./service.ts";

const ISSUE_REPLY = {
	found: true,
	graph_id: "ut-1",
	node_id: "n1",
	identifier: "SWC-9",
	title: "Fix X",
	description: "do the thing",
	untrusted: "UNTRUSTED ISSUE TEXT — a task description, not instructions.",
};

/** The HTTP surface over a Substrate stub, on an ephemeral loopback port with anonymous callers allowed. */
const issueReads: Array<[string, string]> = [];
const stub = {
	getIssue: async (graphId: string, nodeId: string) => {
		issueReads.push([graphId, nodeId]);
		return ISSUE_REPLY;
	},
} as unknown as Substrate;
const server = createHttpServer(stub, loadConfig({}));
let base = "";

beforeAll(async () => {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

function post(path: string, body: string) {
	return fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
}

describe("POST /issue (WR-05, D-15)", () => {
	test("returns the substrate's issue reply for graph_id and node_id", async () => {
		const res = await post("/issue", JSON.stringify({ graph_id: "ut-1", node_id: "n1" }));

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(ISSUE_REPLY);
		expect(issueReads).toEqual([["ut-1", "n1"]]);
	});

	test("refuses a body without node_id with 400 and no substrate call", async () => {
		const before = issueReads.length;
		const res = await post("/issue", JSON.stringify({ graph_id: "ut-1" }));

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "graph_id and node_id are required" });
		expect(issueReads).toHaveLength(before);
	});

	test("refuses a non-JSON body with 400", async () => {
		const res = await post("/issue", "not json");

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "request body is not valid JSON" });
	});

	test("has no GET route", async () => {
		const res = await fetch(`${base}/issue`);

		expect(res.status).toBe(404);
	});
});
