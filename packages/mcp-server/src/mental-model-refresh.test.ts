import { describe, expect, test } from "bun:test";
import type { MentalModelRef } from "./config.ts";
import { EVENT_SOURCES } from "./event-sources.ts";
import type { TimerApi } from "./metrics-history.ts";
import { MentalModelRefresh, REFRESH_ACTION, REFRESH_INTERVAL_MS, isoWeek } from "./mental-model-refresh.ts";
import type { FetchLike, HindsightConfig } from "./planes/hindsight.ts";
import type { EventInput } from "./types.ts";

const HINDSIGHT: HindsightConfig = { url: "http://hindsight.test", apiKey: "test-key", bankPrefix: "sub-" };
const BASE = "http://hindsight.test/v1/default/banks";
/** A Wednesday in ISO week 2026-W43. */
const WEEK_DAY = new Date("2026-10-21T12:00:00Z");
const MODELS: MentalModelRef[] = [
	{ bank: "sub-omp", id: "mm_a" },
	{ bank: "sub-omp", id: "mm_b" },
	{ bank: "sub-hermes", id: "mm_c" },
];

interface Call {
	url: string;
	method: string;
	body: string | undefined;
}

function accepted(): Response {
	return new Response(JSON.stringify({ operation_id: "op-1", status: "queued" }), { status: 200, headers: { "content-type": "application/json" } });
}

/** A fake fetch: records every call, then answers by URL. */
function fakeFetch(answer: (url: string) => Promise<Response> | Response): { fetchImpl: FetchLike; calls: Call[] } {
	const calls: Call[] = [];
	const fetchImpl: FetchLike = async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
		return answer(url);
	};
	return { fetchImpl, calls };
}

interface FakeTimers {
	api: TimerApi;
	ms: number[];
	cleared: number;
	fire: () => void;
}

/** Captures the scheduled handler so a test fires the weekly tick by hand. */
function fakeTimers(): FakeTimers {
	const fake: FakeTimers = {
		api: {
			setInterval: (handler, ms) => {
				fake.fire = handler;
				fake.ms.push(ms);
				return { unref: () => undefined };
			},
			clearInterval: () => {
				fake.cleared += 1;
			},
		},
		ms: [],
		cleared: 0,
		fire: () => undefined,
	};
	return fake;
}

function setup(options: {
	models?: readonly MentalModelRef[];
	answer?: (url: string) => Promise<Response> | Response;
	config?: HindsightConfig | null;
	emit?: (event: EventInput) => Promise<unknown>;
}) {
	const fake = fakeTimers();
	const { fetchImpl, calls } = fakeFetch(options.answer ?? (() => accepted()));
	const events: EventInput[] = [];
	const refresh = new MentalModelRefresh({
		models: options.models ?? MODELS,
		hindsight: () => (options.config === undefined ? HINDSIGHT : options.config),
		fetchImpl,
		emit:
			options.emit ??
			(async (event) => {
				events.push(event);
				return undefined;
			}),
		now: () => WEEK_DAY,
		timers: fake.api,
	});
	return { refresh, fake, calls, events };
}

describe("isoWeek", () => {
	test("dates map to their ISO week, across the year boundaries", () => {
		expect(isoWeek(new Date("2026-01-01T00:00:00Z"))).toBe("2026-W01");
		expect(isoWeek(new Date("2024-12-29T00:00:00Z"))).toBe("2024-W52");
		expect(isoWeek(new Date("2024-12-30T00:00:00Z"))).toBe("2025-W01");
		expect(isoWeek(WEEK_DAY)).toBe("2026-W43");
	});
});

describe("the weekly mental-model refresh", () => {
	test("no models named: nothing is scheduled and nothing is called", async () => {
		const { refresh, fake, calls } = setup({ models: [] });
		expect(refresh.start()).toBe(false);
		await refresh.flush();
		expect(fake.ms).toEqual([]);
		expect(calls).toEqual([]);
	});

	test("models named: the timer is seven days out, and no pass runs at boot", async () => {
		const { refresh, fake, calls, events } = setup({});
		expect(refresh.start()).toBe(true);
		await refresh.flush();
		expect(fake.ms).toEqual([7 * 24 * 60 * 60 * 1000]);
		expect(REFRESH_INTERVAL_MS).toBe(604_800_000);
		expect(calls).toEqual([]);
		expect(events).toEqual([]);
	});

	test("start twice keeps one timer", () => {
		const { refresh, fake } = setup({});
		refresh.start();
		refresh.start();
		expect(fake.ms).toHaveLength(1);
		refresh.stop();
	});

	test("each named model is refreshed once per run, with the confirmed POST", async () => {
		const { refresh, fake, calls } = setup({});
		refresh.start();
		fake.fire();
		await refresh.flush();
		expect(calls).toEqual([
			{ url: `${BASE}/sub-omp/mental-models/mm_a/refresh`, method: "POST", body: "{}" },
			{ url: `${BASE}/sub-omp/mental-models/mm_b/refresh`, method: "POST", body: "{}" },
			{ url: `${BASE}/sub-hermes/mental-models/mm_c/refresh`, method: "POST", body: "{}" },
		]);
		refresh.stop();
	});

	test("a failing model does not stop the others, and each outcome gets one ledger note", async () => {
		const { refresh, fake, calls, events } = setup({
			answer: (url) => {
				if (url.includes("mm_a")) throw new Error("socket reset");
				if (url.includes("mm_b")) return new Response(JSON.stringify({ detail: "refused" }), { status: 500, headers: { "content-type": "application/json" } });
				return accepted();
			},
		});
		refresh.start();
		fake.fire();
		await refresh.flush();
		expect(calls).toHaveLength(3);
		expect(events.map((event) => [event.kind, event.payload])).toEqual([
			["warning", { action: REFRESH_ACTION, bank: "sub-omp", mental_model_id: "mm_a", status: "failed", reason: "network" }],
			["warning", { action: REFRESH_ACTION, bank: "sub-omp", mental_model_id: "mm_b", status: "failed", reason: "server" }],
			["note", { action: REFRESH_ACTION, bank: "sub-hermes", mental_model_id: "mm_c", status: "ok" }],
		]);
		refresh.stop();
	});

	test("an accepted refresh is one ledger note on the week's session, with the confirmed payload fields", async () => {
		const { refresh, fake, events } = setup({ models: [{ bank: "sub-omp", id: "mm_a" }] });
		refresh.start();
		fake.fire();
		await refresh.flush();
		expect(events).toEqual([
			{
				surface: "substrate",
				kind: "note",
				summary: "mental model refresh accepted: sub-omp/mm_a",
				session_id: "mental-model:sub-omp:mm_a:2026-W43",
				payload: { action: "memory.mental_model.refresh", bank: "sub-omp", mental_model_id: "mm_a", status: "ok" },
			},
		]);
		refresh.stop();
	});

	test("each emitted outcome equals the catalog sample of its row: the accepted note and the failed warning", async () => {
		const { refresh, fake, events } = setup({
			models: [
				{ bank: "sub-omp", id: "mm_a" },
				{ bank: "sub-omp", id: "mm_b" },
			],
			answer: (url) => (url.includes("mm_a") ? accepted() : new Response(JSON.stringify({ detail: "down" }), { status: 500, headers: { "content-type": "application/json" } })),
		});
		refresh.start();
		fake.fire();
		await refresh.flush();
		const sampleOf = (id: string) => {
			const row = EVENT_SOURCES.find((source) => source.id === id);
			if (row === undefined) throw new Error(`no catalog row ${id}`);
			return row.sample();
		};
		expect(events).toEqual([sampleOf("memory.mental_model.refresh"), sampleOf("memory.mental_model.refresh.failed")]);
		refresh.stop();
	});

	test("an answer without an operation id is recorded failed as invalid-response", async () => {
		const { refresh, fake, events } = setup({
			models: [{ bank: "sub-omp", id: "mm_a" }],
			answer: () => new Response(JSON.stringify({ status: "queued" }), { status: 200, headers: { "content-type": "application/json" } }),
		});
		refresh.start();
		fake.fire();
		await refresh.flush();
		expect(events.map((event) => event.payload?.["reason"])).toEqual(["invalid-response"]);
		refresh.stop();
	});

	test("the plane is unconfigured: each model is recorded failed as unconfigured, with no call", async () => {
		const { refresh, fake, calls, events } = setup({ config: null });
		refresh.start();
		fake.fire();
		await refresh.flush();
		expect(calls).toEqual([]);
		expect(events.map((event) => event.payload?.["reason"])).toEqual(["unconfigured", "unconfigured", "unconfigured"]);
		refresh.stop();
	});

	test("a ledger write that fails is ignored: the pass still reaches every model", async () => {
		const { refresh, fake, calls } = setup({
			emit: async () => {
				throw new Error("ledger down");
			},
		});
		refresh.start();
		fake.fire();
		await expect(refresh.flush()).resolves.toBeUndefined();
		expect(calls).toHaveLength(3);
		refresh.stop();
	});

	test("a tick while a pass is running starts nothing", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { refresh, fake, calls } = setup({
			models: [{ bank: "sub-omp", id: "mm_a" }],
			answer: async () => {
				await gate;
				return accepted();
			},
		});
		refresh.start();
		fake.fire();
		fake.fire();
		expect(calls).toHaveLength(1);
		release();
		await refresh.flush();
		expect(calls).toHaveLength(1);
		refresh.stop();
	});

	test("stop clears the timer once", () => {
		const { refresh, fake } = setup({});
		refresh.start();
		refresh.stop();
		refresh.stop();
		expect(fake.cleared).toBe(1);
	});
});
