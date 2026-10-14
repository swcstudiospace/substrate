/**
 * `capacity()` round trips (uplift-4 S2), proved without a database: `/healthz`
 * bounds the call at one second and every serial statement costs a proxy round
 * trip, so the lease-table row must be read beside the other two, not after
 * them. The store's connection is replaced by a fake whose statements stay open
 * until the test releases them, so concurrency is observable without timers.
 */
import { describe, expect, test } from "bun:test";
import { IndexStore } from "./index-store.ts";

type Row = Record<string, unknown>;

const LEASE_ROW: Row = { upd: "10", hot: "4", live: "45", dead: "5" };

function fakeSql(leaseRows: Row[]) {
	const open: Array<{ release: () => void }> = [];
	let maxOpen = 0;
	const answers: Array<[RegExp, Row[]]> = [
		[/pg_database_size/, [{ bytes: "1000" }]],
		[/n_tup_upd/, leaseRows],
		[/pg_total_relation_size/, [{ name: "graph_nodes", total_bytes: "64", live_rows: "45", dead_rows: "5" }]],
	];
	const sql = (strings: TemplateStringsArray): Promise<Row[]> => {
		const text = strings.join("?");
		const rows = answers.find(([pattern]) => pattern.test(text))?.[1] ?? [];
		return new Promise<Row[]>((resolve) => {
			open.push({ release: () => resolve(rows) });
			maxOpen = Math.max(maxOpen, open.length);
		});
	};
	return { sql, open, maxOpen: () => maxOpen };
}

/** A store whose connection is the fake; the pool is private, so the one collaborator `capacity()` talks to is swapped. */
function storeWith(fake: ReturnType<typeof fakeSql>): IndexStore {
	const store = new IndexStore("postgres://u@localhost/x");
	const internals = store as unknown as { sql: unknown };
	internals.sql = fake.sql;
	return store;
}

/** Let every statement the call is going to issue without waiting on an answer be issued. */
async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Run `capacity()` to completion against the fake, answering whatever is open. */
async function capacityOf(fake: ReturnType<typeof fakeSql>) {
	const pending = storeWith(fake).capacity();
	await settle();
	for (const statement of fake.open.splice(0)) statement.release();
	return pending;
}

describe("IndexStore.capacity", () => {
	test("issues its three reads together: the lease-table row adds no serial round trip", async () => {
		const fake = fakeSql([LEASE_ROW]);
		const pending = storeWith(fake).capacity();
		await settle();
		// Nothing has been answered, and all three statements are already open at once.
		expect(fake.open.length).toBe(3);
		expect(fake.maxOpen()).toBe(3);
		for (const statement of fake.open.splice(0)) statement.release();
		await pending;
	});

	test("the answer keeps its shape, with the graph_nodes ratios computed from the extra row", async () => {
		expect(await capacityOf(fakeSql([LEASE_ROW]))).toEqual({
			databaseBytes: 1000,
			tables: [{ name: "graph_nodes", totalBytes: 64, liveRows: 45, deadRows: 5 }],
			graphNodes: { hotUpdateRatio: 0.4, deadRatio: 0.1 },
		});
	});

	test("no updates or no rows yet reports null ratios, and an absent graph_nodes row reports null", async () => {
		expect((await capacityOf(fakeSql([{ upd: "0", hot: "0", live: "0", dead: "0" }]))).graphNodes).toEqual({ hotUpdateRatio: null, deadRatio: null });
		expect((await capacityOf(fakeSql([]))).graphNodes).toBeNull();
	});
});
