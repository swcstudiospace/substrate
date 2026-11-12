import { describe, expect, test } from "bun:test";
import { httpMergeBackNoted } from "./command.ts";

const URL_BASE = "http://127.0.0.1:7410";
const HEAD = "a".repeat(40);

function ledgerAnswering(body: unknown, status = 200): typeof fetch {
	return (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

function lookupWith(fetchImpl: typeof fetch) {
	return httpMergeBackNoted({ url: URL_BASE, token: "t", timeoutMs: 1000, fetchImpl });
}

const NOTE = { kind: "note", payload: { action: "worktree.merge_back", repo: "acme/widgets", head: HEAD } };

describe("httpMergeBackNoted", () => {
	test("a merge-back note for the same head settles the question as noted", async () => {
		const answer = await lookupWith(ledgerAnswering({ events: [NOTE], count: 1, truncated: false }))("acme/widgets", HEAD);
		expect(answer).toEqual({ ok: true, noted: true });
	});

	test("a note for another head does not count", async () => {
		const other = { ...NOTE, payload: { ...NOTE.payload, head: "b".repeat(40) } };
		const answer = await lookupWith(ledgerAnswering({ events: [other], count: 1, truncated: false }))("acme/widgets", HEAD);
		expect(answer).toEqual({ ok: true, noted: false });
	});

	test("a full window with no match cannot prove the note is absent, so it is a failure", async () => {
		const answer = await lookupWith(ledgerAnswering({ events: [], count: 0, truncated: true }))("acme/widgets", HEAD);
		expect(answer.ok).toBe(false);
	});

	test("an empty window with no truncation proves the note is absent", async () => {
		const answer = await lookupWith(ledgerAnswering({ events: [], count: 0, truncated: false }))("acme/widgets", HEAD);
		expect(answer).toEqual({ ok: true, noted: false });
	});

	test("a ledger error or a non-200 answer is a failure, never not-recorded", async () => {
		expect((await lookupWith(ledgerAnswering({ events: [], count: 0, error: "down" }))("acme/widgets", HEAD)).ok).toBe(false);
		expect((await lookupWith(ledgerAnswering({}, 503))("acme/widgets", HEAD)).ok).toBe(false);
	});

	test("no bearer token is a failure: the lookup never reaches the ledger", async () => {
		let reached = false;
		const fetchImpl = (async () => {
			reached = true;
			return new Response("{}");
		}) as unknown as typeof fetch;
		const answer = await httpMergeBackNoted({ url: URL_BASE, token: undefined, timeoutMs: 1000, fetchImpl })("acme/widgets", HEAD);
		expect(answer.ok).toBe(false);
		expect(reached).toBe(false);
	});
});
