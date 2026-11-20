import { describe, expect, test } from "bun:test";
import { httpMergeBackNoted } from "./command.ts";

const URL_BASE = "http://127.0.0.1:7410";
const HEAD = "a".repeat(40);

function ledgerAnswering(body: unknown, status = 200): typeof fetch {
	return (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

function lookupWith(fetchImpl: typeof fetch, token: string | undefined = "t") {
	return httpMergeBackNoted({ url: URL_BASE, token, timeoutMs: 1000, fetchImpl });
}

const NOTE = { kind: "note", ts: "2026-11-12T10:00:00.000Z", payload: { action: "worktree.merge_back", repo: "acme/widgets", head: HEAD } };

/** A ledger that answers each page from a script, recording each request body. */
function scriptedLedger(pages: unknown[]): { fetchImpl: typeof fetch; requests: Record<string, unknown>[] } {
	const requests: Record<string, unknown>[] = [];
	const fetchImpl = (async (_url: string, init: RequestInit) => {
		requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
		const page = pages[requests.length - 1] ?? { events: [], count: 0, truncated: false };
		return new Response(JSON.stringify(page), { status: 200, headers: { "content-type": "application/json" } });
	}) as unknown as typeof fetch;
	return { fetchImpl, requests };
}

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

	test("an empty window with no truncation proves the note is absent", async () => {
		const answer = await lookupWith(ledgerAnswering({ events: [], count: 0, truncated: false }))("acme/widgets", HEAD);
		expect(answer).toEqual({ ok: true, noted: false });
	});

	test("a full page with no match is read further back, so a busy repository still finds its note", async () => {
		const older = { ...NOTE, ts: "2026-11-11T09:00:00.000Z", payload: { ...NOTE.payload, head: "c".repeat(40) } };
		const ledger = scriptedLedger([
			{ events: [], count: 0, truncated: false },
			{ events: [{ ...older, ts: "2026-11-12T09:00:00.000Z" }], count: 1, truncated: true },
			{ events: [NOTE], count: 1, truncated: false },
		]);
		const answer = await lookupWith(ledger.fetchImpl)("acme/widgets", HEAD);
		expect(answer).toEqual({ ok: true, noted: true });
		expect(ledger.requests).toHaveLength(3);
		expect(ledger.requests[2]?.until).toBe("2026-11-12T09:00:00.000Z");
	});

	test("a full page whose events all share one millisecond refuses rather than answering not-recorded", async () => {
		const sameMs = { ...NOTE, ts: "2026-11-12T09:00:00.000Z", payload: { ...NOTE.payload, head: "d".repeat(40) } };
		const ledger = scriptedLedger([
			{ events: [], count: 0, truncated: false },
			{ events: [sameMs], count: 1, truncated: true },
			{ events: [sameMs], count: 1, truncated: true },
		]);
		const answer = await lookupWith(ledger.fetchImpl)("acme/widgets", HEAD);
		expect(answer.ok).toBe(false);
	});

	test("a ledger error or a non-200 answer is a failure, never not-recorded", async () => {
		expect((await lookupWith(ledgerAnswering({ events: [], count: 0, error: "down" }))("acme/widgets", HEAD)).ok).toBe(false);
		expect((await lookupWith(ledgerAnswering({}, 503))("acme/widgets", HEAD)).ok).toBe(false);
	});

	test("an untokened lookup sends no authorization header and reads the answer the server gives", async () => {
		let sentAuthorization: string | null | undefined;
		const fetchImpl = (async (_url: string, init: RequestInit) => {
			sentAuthorization = new Headers(init.headers).get("authorization");
			return new Response(JSON.stringify({ events: [NOTE], count: 1, truncated: false }), { status: 200 });
		}) as unknown as typeof fetch;
		const answer = await httpMergeBackNoted({ url: URL_BASE, token: undefined, timeoutMs: 1000, fetchImpl })("acme/widgets", HEAD);
		expect(sentAuthorization).toBeNull();
		expect(answer).toEqual({ ok: true, noted: true });
	});
});
