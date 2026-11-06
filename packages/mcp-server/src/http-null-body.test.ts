/**
 * A JSON `null` body on the REST write routes is the caller's mistake: it answers 400, never 500.
 *
 * Each route reads a property of its parsed body, and `null` has none, so the guard that refuses a
 * non-object has to run before that read. `http.test.ts` covers the routes themselves; this covers the body.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import { loadConfig, type SubstrateConfig } from "./config.ts";
import { createObservability } from "./observe.ts";
import { createHttpServer } from "./server.ts";
import { Substrate } from "./service.ts";

/** The header every fixture that posts a JSON string must send: fetch sends a string body as text/plain. */
const JSON_HEADERS = { "content-type": "application/json" };

interface Harness {
	base: string;
	close(): void;
}

const running: Harness[] = [];

async function start(): Promise<Harness> {
	const env: Record<string, string | undefined> = {};
	const config: SubstrateConfig = loadConfig(env);
	const observability = createObservability(config, env);
	await observability.start();
	const substrate = new Substrate(
		config,
		{ index: null, greptime: null, steering: { history: null, liveSessions: null } } as ConstructorParameters<typeof Substrate>[1],
		observability.observer,
	);
	const server = createHttpServer(substrate, config, observability);
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const { port } = server.address() as AddressInfo;
	let closed = false;
	const harness: Harness = {
		base: `http://127.0.0.1:${port}`,
		close() {
			if (closed) return;
			closed = true;
			observability.stop();
			server.close();
		},
	};
	running.push(harness);
	return harness;
}

afterAll(() => {
	for (const harness of running) harness.close();
});

describe("a null JSON body on the REST write routes", () => {
	test("a null JSON body on /handoff, /drift, /verify, /events and /evidence answers 400, not 500", async () => {
		const harness = await start();
		for (const route of ["/handoff", "/drift", "/verify", "/events", "/evidence"]) {
			const response = await fetch(`${harness.base}${route}`, { method: "POST", headers: JSON_HEADERS, body: "null" });
			expect({ route, status: response.status }).toEqual({ route, status: 400 });
		}
	});
});
