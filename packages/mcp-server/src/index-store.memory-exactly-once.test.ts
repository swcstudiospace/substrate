/**
 * Memory exactly-once across a degraded substrate, against a real Postgres (uplift-7 gap 3).
 *
 * The idempotency record and the entry live in the same database and are claimed and
 * inserted through the same store, so a replayed key cannot write a second row. This
 * proves that on the real index rather than the fake store in `memory-write.test.ts`.
 *
 * Skipped unless a database is given:
 *
 *     SUBSTRATE_TEST_PG_URL=postgres://… bun test index-store.memory-exactly-once
 *
 * Every entry written here has `MARKER` in its body and a run-scoped subject, so each
 * test counts only its own rows and `afterAll` removes them.
 */
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { IndexStore } from "./index-store.ts";
import { governMemoryWrite, type MemoryStore } from "./memory-write.ts";
import type { MemoryWriteRequest, MemoryWriteResult } from "./types.ts";

const PG_URL = process.env.SUBSTRATE_TEST_PG_URL?.trim();
const RUN = Date.now().toString(36);
const MARKER = `ut-memexact-${RUN}`;
const REPO = "swcstudiospace/agent-substrate";
const SCOPE = `repo:${REPO}`;

let store: IndexStore;
/** For the assertions and cleanup: what is in the tables, not what the API says. */
let raw: SQL;

const describeLive = PG_URL ? describe : describe.skip;

/** Rows in `memory_entries` whose body starts with this test's label. */
async function rowsFor(label: string): Promise<number> {
	const counted = (await raw`
		select count(*)::int as n from memory_entries where body like ${`${MARKER}-${label}%`}`) as Array<{ n: number }>;
	return counted[0]?.n ?? 0;
}

function write(target: MemoryStore, label: string, request: Partial<MemoryWriteRequest> = {}): Promise<MemoryWriteResult> {
	return governMemoryWrite(
		{
			scope: SCOPE,
			kind: "decision",
			writer: "hermes",
			repo: REPO,
			subject: `${MARKER}-${label}`,
			text: `${MARKER}-${label} the runtime is herdr`,
			...request,
		},
		{ store: target, isReviewToken: () => false },
	);
}

/**
 * A store whose insert commits and then throws: the connection drops after the row
 * landed and before the caller hears back. The caller sees an outage (503 on the wire).
 */
function landThenDrop(index: IndexStore): MemoryStore {
	return new Proxy(index, {
		get(target, prop) {
			const value = Reflect.get(target, prop, target);
			if (prop !== "insertEntry") return typeof value === "function" ? value.bind(target) : value;
			return async (...args: unknown[]) => {
				await Reflect.apply(value, target, args);
				throw new Error("postgres: connection reset after commit");
			};
		},
	}) as unknown as MemoryStore;
}

describeLive("memory exactly-once against a live index", () => {
	beforeAll(async () => {
		store = new IndexStore(PG_URL!);
		raw = new SQL(PG_URL!);
		await store.migrate();
	});

	afterAll(async () => {
		if (!PG_URL) return;
		await raw`delete from memory_entries where body like ${`%${MARKER}%`}`.catch(() => undefined);
		await raw`delete from memory_writes where idempotency_key like ${`${MARKER}%`}`.catch(() => undefined);
		await raw.end().catch(() => undefined);
		await store.close().catch(() => undefined);
	});

	test("the same explicit key replayed twice writes one row and returns the original entry", async () => {
		const key = `${MARKER}-replay-key`;
		const first = await write(store, "replay", { idempotency_key: key });
		const second = await write(store, "replay", { idempotency_key: key });

		expect(first.outcome).toBe("accepted");
		expect(first.deduplicated).toBeUndefined();
		expect(second.outcome).toBe("accepted");
		expect(second.deduplicated).toBe(true);
		expect(second.idempotency_key).toBe(key);
		expect(second.entry?.id).toBe(first.entry?.id);
		expect(second.entry?.text).toBe(first.entry?.text);
		expect(await rowsFor("replay")).toBe(1);
	});

	test("a keyless write of new content writes each time; a keyless identical retry dedupes as today", async () => {
		const first = await write(store, "keyless-a", {});
		const second = await write(store, "keyless-b", {});
		const retry = await write(store, "keyless-b", {});

		expect(first.outcome).toBe("accepted");
		expect(second.outcome).toBe("accepted");
		expect(second.deduplicated).toBeUndefined();
		expect(second.entry?.id).not.toBe(first.entry?.id);
		expect(retry.deduplicated).toBe(true);
		expect(retry.entry?.id).toBe(second.entry?.id);
		expect(await rowsFor("keyless-a")).toBe(1);
		expect(await rowsFor("keyless-b")).toBe(1);
	});

	test("an outage after the row commits, then a same-key retry, never writes a second row", async () => {
		const key = `${MARKER}-outage-key`;
		await expect(write(landThenDrop(store), "outage", { idempotency_key: key })).rejects.toThrow("connection reset");
		expect(await rowsFor("outage")).toBe(1);

		// The retry arrives while the dead attempt's claim is still in flight. It is told to
		// wait, not given a second write. The stale-takeover path is covered by memory-write.test.ts.
		const retry = await write(store, "outage", { idempotency_key: key });
		expect(retry.outcome).toBe("conflict");
		expect(retry.reason).toBe("write.in-flight");
		expect(await rowsFor("outage")).toBe(1);
	});
});
