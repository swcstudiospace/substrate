/**
 * The `docs.sync` note's lag (v1.7 phase 65): what is read from an untrusted payload, and that the server records it as the
 * `substrate.corpus.sync_lag_seconds` gauge only when the ledger stored the note.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { CORPUS_SYNC_LAG_METRIC } from "@substrate/observability";
import { loadConfig } from "../config.ts";
import { createObservability, type Observability } from "../observe.ts";
import { createHttpServer } from "../server.ts";
import { Substrate } from "../service.ts";
import { SYNC_LAG_MAX_SECONDS, syncLagSeconds } from "./sync-event.ts";

describe("syncLagSeconds", () => {
	test("reads a whole number of seconds from a docs.sync payload, rounding a fraction", () => {
		expect(syncLagSeconds({ action: "docs.sync", lag_s: 42 })).toBe(42);
		expect(syncLagSeconds({ action: "docs.sync", lag_s: 12.6 })).toBe(13);
		expect(syncLagSeconds({ action: "docs.sync", lag_s: 0 })).toBe(0);
	});

	test("reads nothing from any other action, a missing or non-numeric lag, a negative or non-finite one, or a payload that is not an object", () => {
		expect(syncLagSeconds({ action: "docs.planning", lag_s: 5 })).toBeNull();
		expect(syncLagSeconds({ action: "docs.sync" })).toBeNull();
		expect(syncLagSeconds({ action: "docs.sync", lag_s: "5" })).toBeNull();
		expect(syncLagSeconds({ action: "docs.sync", lag_s: -1 })).toBeNull();
		expect(syncLagSeconds({ action: "docs.sync", lag_s: Number.NaN })).toBeNull();
		expect(syncLagSeconds({ action: "docs.sync", lag_s: Number.POSITIVE_INFINITY })).toBeNull();
		for (const payload of [null, undefined, "docs.sync", 7, ["docs.sync"]]) expect(syncLagSeconds(payload)).toBeNull();
	});

	test("a lag past a year is clamped to it, so one note cannot make the series meaningless", () => {
		expect(syncLagSeconds({ action: "docs.sync", lag_s: SYNC_LAG_MAX_SECONDS * 1000 })).toBe(SYNC_LAG_MAX_SECONDS);
	});
});

describe("POST /events with a docs.sync note", () => {
	const AUTH = { authorization: "Bearer tok-omp", "content-type": "application/json" };
	const running: Array<{ observability: Observability; server: Server }> = [];

	afterAll(() => {
		for (const { observability, server } of running) {
			observability.stop();
			server.close();
		}
	});

	/** A real server over a ledger stub that stores every row unless `refuse` is set. */
	async function serve(refuse = false) {
		const env = { SUBSTRATE_TOKEN_OMP: "tok-omp" };
		const config = loadConfig(env);
		const observability = createObservability(config, env);
		await observability.start();
		const ledger = {
			ping: async () => true,
			ensureAppendMode: async () => true,
			probeDialect: async () => true,
			quotingDialectKnown: true,
			lastHash: async () => null,
			insertEvent: async () => {
				if (refuse) throw new Error("greptime unreachable");
			},
			queryEvents: async () => [],
		};
		const substrate = new Substrate(config, { index: null, greptime: ledger as never }, observability.observer);
		const server = createHttpServer(substrate, config, observability);
		const listening = Promise.withResolvers<void>();
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		running.push({ observability, server });
		const { port } = server.address() as AddressInfo;
		const send = (payload: unknown) =>
			fetch(`http://127.0.0.1:${port}/events`, { method: "POST", headers: AUTH, body: JSON.stringify({ kind: "note", summary: "docs sync", payload }) });
		const gauge = (): number | null => {
			const metric = observability.instruments.snapshot().find((candidate) => candidate.name === CORPUS_SYNC_LAG_METRIC);
			const point = metric?.kind === "gauge" ? metric.points[0] : undefined;
			return point === undefined ? null : point.value;
		};
		return { send, gauge };
	}

	test("a stored sync note sets the gauge to its lag, and the newest one wins", async () => {
		const { send, gauge } = await serve();
		expect(gauge()).toBeNull();
		expect((await send({ action: "docs.sync", repo: "acme/docs", trigger: "watch", outcome: "ok", lag_s: 12.4 })).status).toBe(202);
		expect(gauge()).toBe(12);
		expect((await send({ action: "docs.sync", repo: "acme/docs", trigger: "sweep", outcome: "ok", lag_s: 3 })).status).toBe(202);
		expect(gauge()).toBe(3);
	});

	test("a note the ledger did not store, another action, or a lag that is not a number leaves the gauge alone", async () => {
		const refused = await serve(true);
		expect((await refused.send({ action: "docs.sync", lag_s: 99 })).status).toBe(503);
		expect(refused.gauge()).toBeNull();

		const open = await serve();
		await open.send({ action: "docs.sync", lag_s: 7 });
		await open.send({ action: "docs.planning", lag_s: 500 });
		await open.send({ action: "docs.sync", lag_s: -4 });
		await open.send({ action: "docs.sync", lag_s: "soon" });
		expect(open.gauge()).toBe(7);
	});
});
