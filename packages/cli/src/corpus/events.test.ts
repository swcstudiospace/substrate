import { afterAll, describe, expect, test } from "bun:test";
import { createHttpEmitter, docsSyncBody, type DocsSync } from "./events.ts";
import { CorpusStub } from "./testkit.ts";

const stub = new CorpusStub();
afterAll(() => stub.stop());

const sync: DocsSync = {
	repo: "Acme/Alpha",
	trigger: "watch",
	outcome: "partial",
	lagS: 7,
	added: 2,
	changed: 1,
	updated: 3,
	tombstoned: 0,
	refused: 1,
	failed: 0,
	durationMs: 1234,
};

describe("docsSyncBody", () => {
	test("is a note that names no surface (the token's own is used) and no event-level repo, and whose payload carries every field of the contract", () => {
		const body = docsSyncBody(sync);
		expect(body.kind).toBe("note");
		expect("surface" in body).toBe(false);
		expect("repo" in body).toBe(false);
		expect(body.payload).toEqual({
			action: "docs.sync",
			runtime: "corpus-sync",
			repo: "Acme/Alpha",
			trigger: "watch",
			outcome: "partial",
			lag_s: 7,
			added: 2,
			changed: 1,
			updated: 3,
			tombstoned: 0,
			refused: 1,
			failed: 0,
			duration_ms: 1234,
		});
		expect(String(body.summary)).toContain("partial");
	});

	test("an event for every repository names '*' in the payload", () => {
		expect(docsSyncBody({ ...sync, repo: "*" }).payload).toMatchObject({ repo: "*" });
	});
});

describe("createHttpEmitter", () => {
	test("posts the body to /events with the bearer", async () => {
		stub.seen = [];
		stub.on("POST /events", () => ({ status: 200, body: { ok: true } }));
		const result = await createHttpEmitter({ url: stub.url, token: "tok-1" })(sync);
		expect(result).toEqual({ ok: true });
		const seen = stub.requests("/events")[0];
		expect(seen?.authorization).toBe("Bearer tok-1");
		expect(seen?.body).toEqual(JSON.parse(JSON.stringify(docsSyncBody(sync))));
	});

	test("a refusal, an unreachable server and a timeout each come back as a reason and never throw", async () => {
		stub.on("POST /events", () => ({ status: 403, body: { error: "forbidden" } }));
		expect(await createHttpEmitter({ url: stub.url, token: undefined })(sync)).toEqual({ ok: false, reason: "http-403" });
		expect(await createHttpEmitter({ url: "http://127.0.0.1:1", token: undefined, timeoutMs: 1000 })(sync)).toEqual({ ok: false, reason: "network" });
		stub.on("POST /events", () => "hang");
		expect(await createHttpEmitter({ url: stub.url, token: undefined, timeoutMs: 50 })(sync)).toEqual({ ok: false, reason: "timeout" });
	});
});
