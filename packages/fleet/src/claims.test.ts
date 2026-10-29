import { describe, expect, test } from "bun:test";
import { type ClaimsLookup, claimStatus, parseClaimsBody } from "./claims.ts";

const GRAPH = "ut-mu1-abcd1234";
const CLAIM = { node_id: "n1", holder: { surface: "hermes", session_id: "s-1" }, expires_at: "2026-10-29T13:00:00.000Z" };

describe("parseClaimsBody", () => {
	test("reads the route's reply for the graph that was asked about", () => {
		expect(parseClaimsBody({ graph_id: GRAPH, claims: [CLAIM] }, GRAPH)).toEqual([CLAIM]);
		expect(parseClaimsBody({ graph_id: GRAPH, claims: [] }, GRAPH)).toEqual([]);
	});

	test.each([
		["a reply about another graph", { graph_id: "other", claims: [] }],
		["a reply with no claims list", { graph_id: GRAPH }],
		["a claim with no node", { graph_id: GRAPH, claims: [{ holder: null, expires_at: null }] }],
		["a claim whose holder is half there", { graph_id: GRAPH, claims: [{ node_id: "n", holder: { surface: "hermes" }, expires_at: null }] }],
		["a claim whose expiry is a number", { graph_id: GRAPH, claims: [{ node_id: "n", holder: null, expires_at: 5 }] }],
		["not an object", "claims"],
		["null", null],
	])("refuses %s, so it can never read as `no claims`", (_label, body) => {
		expect(parseClaimsBody(body, GRAPH)).toBeNull();
	});
});

describe("claimStatus", () => {
	const answer = (lookup: ClaimsLookup) => async (): Promise<ClaimsLookup> => lookup;

	test("a live claim, an empty answer and a failed question are three different things", async () => {
		expect(await claimStatus(GRAPH, answer({ ok: true, claims: [CLAIM] }))).toEqual({ state: "live", graph_id: GRAPH, claims: [CLAIM] });
		expect(await claimStatus(GRAPH, answer({ ok: true, claims: [] }))).toEqual({ state: "none", graph_id: GRAPH });
		expect(await claimStatus(GRAPH, answer({ ok: false, error: "HTTP 503" }))).toEqual({ state: "unverified", graph_id: GRAPH, reason: "HTTP 503" });
	});
});
