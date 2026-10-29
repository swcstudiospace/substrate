/**
 * The durable steering session registry against a real Postgres (phase 67): write-through, the boot load, TTL pruning at boot,
 * the newest-`cap` rule, flag off persisting nothing, and a failing store that does not fail the steering call.
 *
 *     SUBSTRATE_TEST_PG_URL=postgres://… bun test steering-sessions-store.pg
 *
 * Skipped without a database, like `index-store.lease.test.ts`: a mock of the table would be a mock of the thing under test.
 * The table is the real opt-in migration step, and every row this file writes carries one per-run session id prefix and is
 * deleted afterwards.
 */
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SteeringSession, SteeringSessionState } from "../event.ts";
import { IndexStore } from "../index-store.ts";
import { defined } from "../test-support.ts";
import type { EventInput } from "../types.ts";
import { SteeringSessionRegistry, STEERING_PERSIST_FAILED_ACTION } from "./session-state.ts";
import { bunSteeringSessionsStore, type SteeringSessionsStore } from "./steering-sessions-store.ts";

const PG_URL = process.env.SUBSTRATE_TEST_PG_URL?.trim();
const RUN = `ut-steersess-${Date.now().toString(36)}`;
const NOW = Date.now();
const DAY = 86_400_000;
const TTL_MS = 7 * DAY;

const describeLive = PG_URL ? describe : describe.skip;

const session = (id: string, updatedMs: number, state: SteeringSessionState = "ACTIVE"): SteeringSession => ({
	session_id: `${RUN}-${id}`,
	repo_id: "owner/name",
	state,
	updated_at: new Date(updatedMs).toISOString(),
});

let index: IndexStore;
let sql: SQL;

function registry(options: { store?: SteeringSessionsStore | null; cap?: number } = {}) {
	const events: EventInput[] = [];
	const reg = new SteeringSessionRegistry({
		emit: async (event) => {
			events.push(event);
			return { stored: true };
		},
		nowMs: () => NOW,
		report: () => undefined,
		ttlMs: TTL_MS,
		store: options.store === undefined ? bunSteeringSessionsStore(sql) : options.store,
		...(options.cap === undefined ? {} : { cap: options.cap }),
	});
	return { reg, events };
}

async function rowCount(): Promise<number> {
	const rows: Array<{ n: string }> = await sql`select count(*)::text as n from steering_sessions where session_id like ${`${RUN}-%`}`;
	return Number(defined(rows[0], "a count row").n);
}

describeLive("the durable steering session registry against a live index", () => {
	beforeAll(async () => {
		const url = defined(PG_URL, "SUBSTRATE_TEST_PG_URL");
		index = new IndexStore(url, { migrationOptIns: { "steering-audit": false, "steering-sessions": true } });
		await index.migrate();
		sql = new SQL(url);
	});

	afterAll(async () => {
		if (!PG_URL) return;
		await sql`delete from steering_sessions where session_id like ${`${RUN}-%`}`.catch(() => undefined);
		await sql.close().catch(() => undefined);
		await index.close().catch(() => undefined);
	});

	test("a write is upserted and a fresh registry loads it back, last writer winning", async () => {
		const first = registry();
		first.reg.put("omp", `${RUN}-w`, session("w", NOW + 1_000, "ACTIVE"));
		first.reg.put("omp", `${RUN}-w`, session("w", NOW + 2_000, "PAUSED"));
		await first.reg.idle();
		expect(await rowCount()).toBe(1);

		const second = registry();
		const report = await second.reg.loadDurable();
		expect(report.failed).toBeNull();
		expect(second.reg.get("omp", `${RUN}-w`)?.state).toBe("PAUSED");
	});

	test("rows past the TTL are not loaded and are pruned at boot", async () => {
		const seed = registry();
		seed.reg.put("cursor", `${RUN}-old`, session("old", NOW - 30 * DAY));
		await seed.reg.idle();
		expect(await rowCount()).toBeGreaterThanOrEqual(1);

		const boot = registry();
		const report = await boot.reg.loadDurable();
		expect(report.pruned).toBeGreaterThanOrEqual(1);
		expect(boot.reg.get("cursor", `${RUN}-old`)).toBeUndefined();
		const left: Array<{ n: string }> = await sql`select count(*)::text as n from steering_sessions where session_id = ${`${RUN}-old`}`;
		expect(left[0]?.n).toBe("0");
	});

	test("only the newest `cap` rows are loaded", async () => {
		const seed = registry();
		for (let n = 1; n <= 5; n += 1) seed.reg.put("omp", `${RUN}-c${n}`, session(`c${n}`, NOW + 10_000 + n * 1_000));
		await seed.reg.idle();

		const boot = registry({ cap: 3 });
		await boot.reg.loadDurable();
		const held = [1, 2, 3, 4, 5].filter((n) => boot.reg.get("omp", `${RUN}-c${n}`) !== undefined);
		expect(held).toEqual([3, 4, 5]);
	});

	test("with no store (the flag off) nothing is persisted", async () => {
		const before = await rowCount();
		const off = registry({ store: null });
		off.reg.put("omp", `${RUN}-off`, session("off", NOW + 50_000));
		await off.reg.idle();
		expect(off.reg.get("omp", `${RUN}-off`)?.state).toBe("ACTIVE");
		expect(await rowCount()).toBe(before);
	});

	test("a store that fails does not fail the call and records one persist_failed warning", async () => {
		const broken = new SQL(defined(PG_URL, "SUBSTRATE_TEST_PG_URL"));
		await broken.close();
		const { reg, events } = registry({ store: bunSteeringSessionsStore(broken) });
		reg.put("omp", `${RUN}-bad`, session("bad", NOW + 60_000));
		await reg.idle();
		expect(reg.get("omp", `${RUN}-bad`)?.state).toBe("ACTIVE");
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ kind: "warning", payload: { action: STEERING_PERSIST_FAILED_ACTION } });
	});
});
