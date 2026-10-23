/**
 * The SLO transition notifier (uplift-3 N2): one event per sustained
 * transition, deduped through the checkpoint's records, a webhook that can
 * never block or throw, and nothing scheduled unless the flag is on.
 */
import { describe, expect, test } from "bun:test";
import type { BreakerSnapshot, BurnResult, CapacitySloResult, NotifyRecord, PlaneName, PlaneSloResult, SloResult } from "@substrate/observability";
import { loadConfig } from "./config.ts";
import { NOTIFY_SESSION, NOTIFY_SUMMARY_MAX, SloNotifier, notifyConditions, transitionEvent, type NotifyInputs } from "./slo-notify.ts";
import type { EventInput } from "./types.ts";

const T0 = Date.parse("2026-10-13T12:00:00Z");

function catalogue(status: SloResult["status"], observed = 1200): SloResult {
	return { id: "brief.p95", title: "Brief latency", statement: "p95 <= 800 ms", status, observed, unit: "ms", target: 800, samples: 40, detail: "" };
}

function plane(status: PlaneSloResult["status"]): PlaneSloResult {
	return { id: "plane.index.availability", plane: "index", title: "index availability", statement: "", status, observed: 0.9, unit: "ratio", target: 0.99, samples: 50, detail: "" };
}

function burn(status: BurnResult["status"]): BurnResult {
	return { id: "burn.tokens", title: "Token burn", statement: "", status, observed: 50_000, unit: "tokens/h", target: 10_000, samples: 3, detail: "" };
}

function capacity(status: CapacitySloResult["status"]): CapacitySloResult {
	return {
		id: "capacity.index.runway_days",
		title: "Index capacity runway",
		statement: "",
		status,
		observed: 3.5,
		unit: "days",
		target: 14,
		samples: 300,
		detail: "",
		bytesPerDay: 1,
		currentBytes: 1,
		volumeBytes: 2,
	};
}

function breakers(index: BreakerSnapshot["state"] | null = "closed"): Record<PlaneName, BreakerSnapshot | null> {
	const closed = (plane: PlaneName): BreakerSnapshot => ({ plane, state: "closed", failures: 0, openedAt: null, lastErrorAt: null, lastError: null });
	return {
		greptime: closed("greptime"),
		index: index === null ? null : { plane: "index", state: index, failures: index === "closed" ? 0 : 5, openedAt: T0, lastErrorAt: T0, lastError: "timed out" },
		cache: closed("cache"),
		hindsight: null,
		ragflow: null,
		lightrag: null,
	};
}

function inputs(overrides: Partial<NotifyInputs> = {}): NotifyInputs {
	return {
		catalogue: [catalogue("ok")],
		planes: [plane("ok")],
		burn: [burn("ok")],
		capacity: [capacity("ok")],
		breakers: breakers(),
		...overrides,
	};
}

interface World {
	notifier: SloNotifier;
	emitted: EventInput[];
	records: Record<string, NotifyRecord>;
	posts: Array<{ url: string; body: unknown }>;
	clock: { now: number };
	set(next: NotifyInputs): void;
	logs: string[];
}

function world(env: Record<string, string> = { SUBSTRATE_SLO_NOTIFY: "1" }, options: { webhook?: (url: string, init: RequestInit) => Promise<Response>; emit?: (event: EventInput) => Promise<unknown>; records?: Record<string, NotifyRecord> } = {}): World {
	const emitted: EventInput[] = [];
	const records = options.records ?? {};
	const posts: Array<{ url: string; body: unknown }> = [];
	const clock = { now: T0 };
	const logs: string[] = [];
	let current = inputs();
	const notifier = new SloNotifier({
		settings: loadConfig(env).sloNotify,
		evaluate: () => current,
		emit:
			options.emit ??
			(async (event) => {
				emitted.push(event);
				return { stored: true };
			}),
		records,
		now: () => clock.now,
		fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
			posts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
			return options.webhook ? options.webhook(String(url), init ?? {}) : new Response("ok", { status: 200 });
		}) as typeof fetch,
		log: (line) => logs.push(line),
	});
	return { notifier, emitted, records, posts, clock, set: (next) => (current = next), logs };
}

describe("notifyConditions", () => {
	test("one condition per objective and per non-closed breaker; unconfigured, insufficient-data and null breakers are clear", () => {
		const conditions = notifyConditions(
			inputs({ catalogue: [catalogue("breached")], planes: [plane("unconfigured")], burn: [burn("insufficient-data")], breakers: breakers("half-open") }),
		);
		expect(conditions.map((c) => [c.objective, c.state])).toEqual([
			["brief.p95", "breached"],
			["plane.index.availability", null],
			["burn.tokens", null],
			["capacity.index.runway_days", null],
			["breaker.greptime", null],
			["breaker.index", "open"],
			["breaker.cache", null],
		]);
		expect(conditions.find((c) => c.objective === "breaker.index")).toMatchObject({ observed: 5, target: null });
	});
});

describe("transitionEvent", () => {
	test("is a substrate warning with the pinned payload, a note on recovery, and a bounded summary", () => {
		const breached = transitionEvent({ objective: "brief.p95", observed: 1234.5678, target: 800 }, "breached");
		expect(breached).toEqual({
			surface: "substrate",
			kind: "warning",
			summary: "slo breached: brief.p95 (observed 1234.568, target 800)",
			session_id: NOTIFY_SESSION,
			payload: { action: "slo.transition", runtime: "slo", objective: "brief.p95", state: "breached", observed: 1234.5678, target: 800 },
		});
		expect(transitionEvent({ objective: "breaker.index", observed: 5, target: null }, "open").kind).toBe("warning");
		expect(transitionEvent({ objective: "brief.p95", observed: 600, target: 800 }, "recovered").kind).toBe("note");
		const long = transitionEvent({ objective: "x".repeat(400), observed: null, target: null }, "breached");
		expect(long.summary.length).toBe(NOTIFY_SUMMARY_MAX);
	});
});

describe("SloNotifier", () => {
	test("a breach held for less than the sustain emits nothing; held for the sustain, exactly one warning", async () => {
		const w = world();
		w.set(inputs({ catalogue: [catalogue("breached")] }));
		expect(await w.notifier.tick()).toEqual([]);
		w.clock.now = T0 + 299_000;
		expect(await w.notifier.tick()).toEqual([]);
		expect(w.emitted).toEqual([]);

		w.clock.now = T0 + 300_000;
		const transitions = await w.notifier.tick();
		expect(transitions).toHaveLength(1);
		expect(transitions[0]).toMatchObject({ objective: "brief.p95", state: "breached", webhook: "skipped" });
		expect(w.emitted).toHaveLength(1);
		expect(w.emitted[0]).toMatchObject({
			surface: "substrate",
			kind: "warning",
			payload: { action: "slo.transition", runtime: "slo", objective: "brief.p95", state: "breached", observed: 1200, target: 800 },
		});
		expect(w.emitted[0]!.summary.length).toBeLessThanOrEqual(NOTIFY_SUMMARY_MAX);
		expect(w.records["brief.p95"]).toEqual({ state: "breached", at: T0 + 300_000 });

		// Still breached: nothing more, however many ticks.
		for (let i = 1; i <= 10; i++) {
			w.clock.now = T0 + 300_000 + i * 60_000;
			expect(await w.notifier.tick()).toEqual([]);
		}
		expect(w.emitted).toHaveLength(1);
	});

	test("a breach that clears before the sustain is forgotten, and must be sustained again", async () => {
		const w = world();
		w.set(inputs({ catalogue: [catalogue("breached")] }));
		await w.notifier.tick();
		w.clock.now = T0 + 200_000;
		w.set(inputs());
		await w.notifier.tick();
		w.clock.now = T0 + 250_000;
		w.set(inputs({ catalogue: [catalogue("breached")] }));
		await w.notifier.tick();
		w.clock.now = T0 + 400_000;
		expect(await w.notifier.tick()).toEqual([]);
		w.clock.now = T0 + 550_000;
		expect(await w.notifier.tick()).toHaveLength(1);
	});

	test("recovery, sustained, is one note; a breach after it is announced again", async () => {
		const w = world();
		w.set(inputs({ catalogue: [catalogue("breached")] }));
		await w.notifier.tick();
		w.clock.now = T0 + 300_000;
		await w.notifier.tick();
		expect(w.emitted).toHaveLength(1);

		w.set(inputs());
		w.clock.now = T0 + 360_000;
		expect(await w.notifier.tick()).toEqual([]);
		w.clock.now = T0 + 660_000;
		const recovered = await w.notifier.tick();
		expect(recovered).toHaveLength(1);
		expect(recovered[0]).toMatchObject({ objective: "brief.p95", state: "recovered" });
		expect(w.emitted[1]).toMatchObject({ kind: "note", payload: { action: "slo.transition", state: "recovered", objective: "brief.p95" } });
		expect(w.records["brief.p95"]).toEqual({ state: "recovered", at: T0 + 660_000 });
		w.clock.now = T0 + 720_000;
		expect(await w.notifier.tick()).toEqual([]);

		w.set(inputs({ catalogue: [catalogue("breached")] }));
		w.clock.now = T0 + 780_000;
		await w.notifier.tick();
		w.clock.now = T0 + 1_080_000;
		expect(await w.notifier.tick()).toHaveLength(1);
		expect(w.emitted).toHaveLength(3);
	});

	test("an objective that was never announced has nothing to recover from", async () => {
		const w = world();
		w.set(inputs({ planes: [plane("insufficient-data")] }));
		await w.notifier.tick();
		w.clock.now = T0 + 600_000;
		expect(await w.notifier.tick()).toEqual([]);
		expect(w.emitted).toEqual([]);
	});

	test("a restart with the checkpoint's records does not re-announce a standing breach", async () => {
		const records: Record<string, NotifyRecord> = { "brief.p95": { state: "breached", at: T0 - 3_600_000 } };
		const w = world({ SUBSTRATE_SLO_NOTIFY: "1" }, { records });
		w.set(inputs({ catalogue: [catalogue("breached")] }));
		for (let i = 0; i <= 10; i++) {
			w.clock.now = T0 + i * 60_000;
			expect(await w.notifier.tick()).toEqual([]);
		}
		expect(w.emitted).toEqual([]);
		// And the recovery is still announced, once.
		w.set(inputs());
		w.clock.now = T0 + 700_000;
		await w.notifier.tick();
		w.clock.now = T0 + 1_000_000;
		expect(await w.notifier.tick()).toHaveLength(1);
		expect(w.emitted[0]).toMatchObject({ kind: "note", payload: { state: "recovered" } });
	});

	test("plane, burn, capacity breaches and an open breaker each get their own transition", async () => {
		const w = world({ SUBSTRATE_SLO_NOTIFY: "1", SUBSTRATE_SLO_NOTIFY_SUSTAIN_S: "0" });
		w.set(inputs({ planes: [plane("breached")], burn: [burn("breached")], capacity: [capacity("breached")], breakers: breakers("open") }));
		const transitions = await w.notifier.tick();
		expect(transitions.map((t) => [t.objective, t.state])).toEqual([
			["plane.index.availability", "breached"],
			["burn.tokens", "breached"],
			["capacity.index.runway_days", "breached"],
			["breaker.index", "open"],
		]);
		expect(w.emitted.find((e) => e.payload?.objective === "breaker.index")?.payload).toMatchObject({ state: "open", observed: 5, target: null });
		// A half-open breaker is still open: no recovery, no re-announcement.
		w.set(inputs({ planes: [plane("breached")], burn: [burn("breached")], capacity: [capacity("breached")], breakers: breakers("half-open") }));
		expect(await w.notifier.tick()).toEqual([]);
		w.set(inputs({ planes: [plane("breached")], burn: [burn("breached")], capacity: [capacity("breached")], breakers: breakers("closed") }));
		expect((await w.notifier.tick()).map((t) => [t.objective, t.state])).toEqual([["breaker.index", "recovered"]]);
	});

	test("the webhook gets the payload once per transition, and its failure or timeout neither throws nor blocks", async () => {
		const ok = world({ SUBSTRATE_SLO_NOTIFY: "1", SUBSTRATE_SLO_NOTIFY_SUSTAIN_S: "0", SUBSTRATE_SLO_WEBHOOK_URL: "http://127.0.0.1:9/hook" });
		ok.set(inputs({ catalogue: [catalogue("breached")] }));
		expect((await ok.notifier.tick())[0]?.webhook).toBe("sent");
		expect(ok.posts).toHaveLength(1);
		expect(ok.posts[0]?.body).toMatchObject({ action: "slo.transition", runtime: "slo", objective: "brief.p95", state: "breached", observed: 1200, target: 800 });
		expect(await ok.notifier.tick()).toEqual([]);
		expect(ok.posts).toHaveLength(1);

		const failing = world(
			{ SUBSTRATE_SLO_NOTIFY: "1", SUBSTRATE_SLO_NOTIFY_SUSTAIN_S: "0", SUBSTRATE_SLO_WEBHOOK_URL: "http://127.0.0.1:9/hook?token=secret-hook-token" },
			{ webhook: async () => new Response("no", { status: 503 }) },
		);
		failing.set(inputs({ catalogue: [catalogue("breached")] }));
		expect((await failing.notifier.tick())[0]?.webhook).toBe("failed");
		expect(failing.emitted).toHaveLength(1);
		expect(failing.logs.join("\n")).toContain("HTTP 503");
		expect(failing.logs.join("\n")).not.toContain("secret-hook-token");

		const throwing = world(
			{ SUBSTRATE_SLO_NOTIFY: "1", SUBSTRATE_SLO_NOTIFY_SUSTAIN_S: "0", SUBSTRATE_SLO_WEBHOOK_URL: "http://127.0.0.1:9/hook" },
			{ webhook: async () => Promise.reject(new Error("ECONNREFUSED")) },
		);
		throwing.set(inputs({ catalogue: [catalogue("breached")] }));
		expect((await throwing.notifier.tick())[0]?.webhook).toBe("failed");
		expect(throwing.emitted).toHaveLength(1);
		expect(throwing.records["brief.p95"]?.state).toBe("breached");
	});

	test("an emit that rejects is logged, and the transition is still recorded so the ledger is not asked twice", async () => {
		const w = world({ SUBSTRATE_SLO_NOTIFY: "1", SUBSTRATE_SLO_NOTIFY_SUSTAIN_S: "0" }, { emit: async () => Promise.reject(new Error("ledger down")) });
		w.set(inputs({ catalogue: [catalogue("breached")] }));
		expect(await w.notifier.tick()).toHaveLength(1);
		expect(w.logs.join("\n")).toContain("ledger down");
		expect(await w.notifier.tick()).toEqual([]);
	});

	test("start schedules nothing unless SUBSTRATE_SLO_NOTIFY=1", () => {
		const off = world({});
		expect(off.notifier.start()).toBe(false);
		expect(off.notifier.scheduled).toBe(false);
		const on = world({ SUBSTRATE_SLO_NOTIFY: "1" });
		expect(on.notifier.start()).toBe(true);
		expect(on.notifier.scheduled).toBe(true);
		expect(on.notifier.start()).toBe(false);
		on.notifier.stop();
		expect(on.notifier.scheduled).toBe(false);
	});

	test("the settings read their defaults and bounds", () => {
		expect(loadConfig({}).sloNotify).toEqual({ enabled: false, intervalS: 60, sustainS: 300, webhookUrl: null });
		expect(loadConfig({ SUBSTRATE_SLO_NOTIFY: "1", SUBSTRATE_SLO_NOTIFY_S: "1", SUBSTRATE_SLO_NOTIFY_SUSTAIN_S: "-5", SUBSTRATE_SLO_WEBHOOK_URL: "ftp://x" }).sloNotify).toEqual({
			enabled: true,
			intervalS: 5,
			sustainS: 0,
			webhookUrl: null,
		});
		expect(loadConfig({ SUBSTRATE_SLO_WEBHOOK_URL: " https://hooks.example/abc " }).sloNotify.webhookUrl).toBe("https://hooks.example/abc");
	});
});
