/**
 * The replay gate against the REAL `substrate-mcp` HTTP handler on a deployment that requires a bearer.
 *
 * The other spool tests use a stub server. The real server leaves GET /healthz open and checks the bearer
 * on every other route, so a probe that sends no credential learns the idempotency mode and the replay's
 * POST /events is what answers 401. A present bearer that names no surface is still refused on /healthz.
 * These tests start `createHttpServer` with surface tokens configured and anonymous callers disallowed, in
 * front of a duck-typed ledger, and prove that an unauthenticated replay is skipped without an attempt
 * consumed, that a wrong credential holds as `healthz-auth`, and that the replay's own credential — explicit,
 * from `SUBSTRATE_TOKEN`, or from the per-surface token file — lets the probe through and the replay is delivered.
 *
 * The server runs in `SUBSTRATE_EVENT_IDEMPOTENCY=accept`, so its own `/healthz` advertises the mode the spool
 * requires and a replay-marked, keyed request takes the real ledger lookup (a duck-typed ledger that finds nothing).
 * A thin proxy in front only records the `authorization` header of every `/healthz` request; it forwards
 * everything except Host (the proxy's own port, which the real listener refuses with 421), so the real bearer check, route and `/events` handler are what answer.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../mcp-server/src/config.ts";
import { createObservability, type Observability } from "../../mcp-server/src/observe.ts";
import { createHttpServer } from "../../mcp-server/src/server.ts";
import { Substrate } from "../../mcp-server/src/service.ts";
import { drainEventSpool, parkEvent, prepareEvent, resetSpoolReplayState } from "./emit.ts";
import { EventSpool } from "./spool.ts";
import { isolateSpoolEnv } from "./spool-test-env.ts";

const BEARER = `tok-${randomBytes(16).toString("hex")}`;
const WRONG_BEARER = `tok-${randomBytes(16).toString("hex")}`;

interface Running {
	url: string;
	written: Array<{ surface: string; kind: string }>;
	/** `authorization` header of every `/healthz` request the real server answered. */
	healthAuth: Array<string | null>;
	close: () => void;
}

let running: Running[] = [];
let restoreEnv: () => void = () => undefined;
let stateDir = "";
let realStderr: typeof process.stderr.write;

beforeEach(() => {
	restoreEnv = isolateSpoolEnv();
	stateDir = mkdtempSync(join(tmpdir(), "spool-real-"));
	process.env.SUBSTRATE_STATE_DIR = stateDir;
	process.env.SUBSTRATE_EVENT_SPOOL = "on";
	resetSpoolReplayState();
	realStderr = process.stderr.write.bind(process.stderr);
	process.stderr.write = (() => true) as typeof process.stderr.write;
});

afterEach(() => {
	for (const server of running) server.close();
	running = [];
	process.stderr.write = realStderr;
	restoreEnv();
});

async function startRealServer(): Promise<Running> {
	const env = { SUBSTRATE_TOKEN_CLAUDE_CODE: BEARER, SUBSTRATE_ALLOW_ANONYMOUS: "0", SUBSTRATE_EVENT_IDEMPOTENCY: "accept" };
	const config = loadConfig(env);
	const observability: Observability = createObservability(config, env);
	await observability.start();
	const written: Array<{ surface: string; kind: string }> = [];
	const ledger = {
		ping: async () => true,
		ensureAppendMode: async () => true,
		probeDialect: async () => undefined,
		quotingDialectKnown: true,
		probeWritable: async () => ({ lastProbeAt: new Date().toISOString(), lastProbeOk: true, lastProbeError: null }),
		capacity: async () => null,
		anchorCoverage: async () => Promise.reject(new Error("no coverage in this test")),
		lastHash: async () => null,
		findByIdempotencyKey: async () => null,
		insertEvent: async (event: { surface: string; kind: string }) => {
			written.push(event);
		},
	};
	const substrate = new Substrate(config, { index: null, greptime: ledger } as unknown as ConstructorParameters<typeof Substrate>[1], observability.observer);
	const real = createHttpServer(substrate, config, observability);
	await new Promise<void>((resolve) => real.listen(0, "127.0.0.1", resolve));
	const realUrl = `http://127.0.0.1:${(real.address() as AddressInfo).port}`;
	const healthAuth: Array<string | null> = [];
	const front = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async (req) => {
			const path = new URL(req.url).pathname;
			if (path === "/healthz") healthAuth.push(req.headers.get("authorization"));
			// The proxy's Host names its own port. The real listener checks its own, so the forwarded Host is dropped and fetch sets the real one.
			const headers = new Headers(req.headers);
			headers.delete("host");
			const answer = await fetch(`${realUrl}${path}`, { method: req.method, headers, body: req.method === "GET" ? undefined : await req.text() });
			return answer;
		},
	});
	const handle: Running = {
		url: `http://127.0.0.1:${front.port}`,
		written,
		healthAuth,
		close: () => {
			front.stop(true);
			real.close();
			observability.stop();
		},
	};
	running.push(handle);
	return handle;
}

function park(summary: string): void {
	const prepared = prepareEvent({ surface: "claude-code", kind: "note", summary }, { collector: "t" });
	expect(parkEvent(prepared, { collector: "t", source: "t.row", reason: "unreachable" })).toBe(true);
}

function depth(): number {
	return new EventSpool({ path: join(stateDir, "event-spool.jsonl") }).stats().depth;
}

describe("replay against the real server with a bearer required", () => {
	test("GET /healthz is open, so a probe without a credential learns the mode and /events refuses without consuming an attempt", async () => {
		const server = await startRealServer();
		park("anonymous probe");

		const result = await drainEventSpool({ all: true, url: server.url });

		expect(result).toEqual({
			status: "ran",
			delivered: 0,
			refused: 0,
			retried: 0,
			skipped: 1,
			dropped: 0,
			held: "unauthorized",
			budgetExhausted: false,
			remaining: 1,
			readFailed: false,
			writeFailed: false,
			pendingUnsaved: false,
		});
		expect(server.healthAuth).toEqual([null]);
		expect(server.written).toEqual([]);
		expect(new EventSpool({ path: join(stateDir, "event-spool.jsonl") }).list()[0]?.attempts).toBe(1);
	});

	test("a wrong credential holds the same way", async () => {
		const server = await startRealServer();
		park("wrong bearer");

		const result = await drainEventSpool({ all: true, url: server.url, token: WRONG_BEARER });

		expect(result).toEqual({ status: "held", reason: "healthz-auth", dropped: 0, remaining: expect.any(Number) });
		expect(server.written).toEqual([]);
	});

	test("the explicit token authenticates the probe and the replay: the event is delivered", async () => {
		const server = await startRealServer();
		park("explicit token");

		const result = await drainEventSpool({ all: true, url: server.url, token: BEARER });

		expect(result).toMatchObject({ status: "ran", delivered: 1, remaining: 0 });
		expect(server.healthAuth).toEqual([`Bearer ${BEARER}`]);
		expect(server.written.map((event) => event.kind)).toEqual(["note"]);
		expect(depth()).toBe(0);
	});

	test("SUBSTRATE_TOKEN from the environment is the same credential for the probe and the replay", async () => {
		const server = await startRealServer();
		process.env.SUBSTRATE_TOKEN = BEARER;
		park("env token");

		const result = await drainEventSpool({ all: true, url: server.url });

		expect(result).toMatchObject({ status: "ran", delivered: 1 });
		expect(server.healthAuth).toEqual([`Bearer ${BEARER}`]);
	});

	test("the per-surface token file the resolver reads is used for the probe too", async () => {
		const server = await startRealServer();
		const tokens = mkdtempSync(join(tmpdir(), "spool-real-tokens-"));
		writeFileSync(join(tokens, "claude-code"), `${BEARER}\n`);
		process.env.SUBSTRATE_TOKENS_DIR = tokens;
		park("token file");

		const result = await drainEventSpool({ all: true, url: server.url });

		expect(result).toMatchObject({ status: "ran", delivered: 1 });
		expect(server.healthAuth).toEqual([`Bearer ${BEARER}`]);
	});
});
