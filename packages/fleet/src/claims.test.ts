import { describe, expect, test } from "bun:test";
import { type ClaimsLookup, type ClaimStatus, claimStatus, type LiveClaim, NOT_CHECKED, parseClaimsBody, sessionOfClaims } from "./claims.ts";

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

describe("sessionOfClaims", () => {
	const held = (node: string, session: string): LiveClaim => ({ node_id: node, holder: { surface: "hermes", session_id: session }, expires_at: null });
	const holderless: LiveClaim = { node_id: "n9", holder: null, expires_at: null };

	test("every live claim held by one session names that session", () => {
		expect(sessionOfClaims({ state: "live", graph_id: GRAPH, claims: [held("n1", "sess-1")] })).toBe("sess-1");
		expect(sessionOfClaims({ state: "live", graph_id: GRAPH, claims: [held("n1", "sess-1"), held("n2", "sess-1")] })).toBe("sess-1");
	});

	const NAMING_NOBODY: Array<[string, ClaimStatus]> = [
		["two holder sessions", { state: "live", graph_id: GRAPH, claims: [held("n1", "sess-1"), held("n2", "sess-2")] }],
		["a claim with no holder beside a held one", { state: "live", graph_id: GRAPH, claims: [held("n1", "sess-1"), holderless] }],
		["a claim with no holder first", { state: "live", graph_id: GRAPH, claims: [holderless, held("n1", "sess-1")] }],
		["only a claim with no holder", { state: "live", graph_id: GRAPH, claims: [holderless] }],
		["a holder whose session id is not in the session grammar", { state: "live", graph_id: GRAPH, claims: [held("n1", "has a space")] }],
		["none", { state: "none", graph_id: GRAPH }],
		["unverified", { state: "unverified", graph_id: GRAPH, reason: "HTTP 503" }],
		["not-checked", NOT_CHECKED],
	];

	test.each(NAMING_NOBODY)("%s attributes nothing", (_label, status) => {
		expect(sessionOfClaims(status)).toBeNull();
	});
});
