/**
 * `GET /handoffs`, driven through the real HTTP server, the handoff signer and a ledger that answers reads (SPE-5714).
 *
 * A packet recorded by `POST /handoff` is replayed by `GET /handoffs?graph=` with the verdict it verifies under, the same chain the
 * `coord_handoff_list` tool returns. A row the ledger holds under the handoff kind whose packet is malformed is skipped, and does not
 * reach the caller.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { loadConfig } from "./config.ts";
import { createObservability, type Observability } from "./observe.ts";
import { createHttpServer } from "./server.ts";
import { Substrate } from "./service.ts";
import type { SubstrateEvent } from "./types.ts";

const ENV = {
	SUBSTRATE_TOKEN_HERMES: "tok-hermes",
	SUBSTRATE_HANDOFF_KEY: "a-test-signing-key",
	SUBSTRATE_HANDOFF_KEY_ID: "k1",
};

/** The events the ledger has appended, in append order. */
const written: SubstrateEvent[] = [];

// The ledger takes the writes and answers the replay read. A read returns rows as Greptime does: the timestamp in epoch milliseconds
// and the payload as JSON text. So the replay has to rebuild each event from those rows, as it does in production.
const greptime = {
	ensureAppendMode: async () => true,
	lastHash: async () => "tip-hash",
	insertEvent: async (event: SubstrateEvent) => {
		written.push(event);
	},
	readEvents: async (column: "session_id" | "graph_id", value: string) =>
		written
			.filter((event) => event[column] === value)
			.map((event) => ({ ...event, ts: Date.parse(event.ts), payload: JSON.stringify(event.payload), step: null })),
};

let base: string;
let server: Server;
let observability: Observability;

beforeAll(async () => {
	const config = loadConfig(ENV);
	observability = createObservability(config, ENV);
	await observability.start();
	const substrate = new Substrate(config, { index: null, greptime: greptime as never });
	server = createHttpServer(substrate, config, observability);
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
	observability.stop();
	server.close();
});

test("a handoff recorded over REST is replayed by GET /handoffs with its verdict, and a malformed stored row is not returned", async () => {
	const posted = await fetch(`${base}/handoff`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: "Bearer tok-hermes" },
		body: JSON.stringify({
			to: "omp",
			goal: "take over n2",
			graph_id: "ut-1",
			node_id: "n2",
			session_id: "sess-hermes",
			dod: ["bun test green"],
		}),
	});
	const recorded = (await posted.json()) as { stored: boolean; event: { id: string } | null };
	expect(posted.status).toBe(202);
	expect(recorded.stored).toBe(true);

	// A row under the handoff kind whose packet is not one. The replay must skip it alone.
	const genuine = written[0];
	if (genuine === undefined) throw new Error("the recorded handoff was not appended");
	written.push({ ...genuine, id: "evt_malformed", summary: "handoff to omp: malformed", payload: { handoff: { goal: "x", signature: null } } });

	const replay = await fetch(`${base}/handoffs?graph=ut-1`, { headers: { authorization: "Bearer tok-hermes" } });
	const body = (await replay.json()) as Array<{
		event_id: string;
		packet: { goal: string; from: { surface: string } } | null;
		verdict: unknown;
	}>;

	expect(replay.status).toBe(200);
	const recordedId = recorded.event?.id;
	if (recordedId === undefined) throw new Error("the recorded handoff has no event id");
	expect(body.map((entry) => entry.event_id)).toEqual([recordedId]);
	expect(body[0]?.packet?.goal).toBe("take over n2");
	expect(body[0]?.packet?.from.surface).toBe("hermes");
	expect(body[0]?.verdict).toEqual({ ok: true, key_id: "k1" });
});
