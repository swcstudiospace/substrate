import { afterEach, describe, expect, test } from "bun:test";
import { type ReconcileIo, reconcileMain } from "./reconcile-main.ts";

/** A run's io: the lines each stream received, and an `open` that records it was reached and then fails the test. */
function fakeIo(opened: string[]): { io: ReconcileIo; out: string[]; err: string[] } {
	const out: string[] = [];
	const err: string[] = [];
	const io: ReconcileIo = {
		out: (line) => out.push(line),
		err: (line) => err.push(line),
		open: () => {
			opened.push("open");
			throw new Error("open must not be reached");
		},
	};
	return { io, out, err };
}

describe("reconcileMain", () => {
	const savedPgUrl = process.env.SUBSTRATE_PG_URL;

	afterEach(() => {
		if (savedPgUrl === undefined) delete process.env.SUBSTRATE_PG_URL;
		else process.env.SUBSTRATE_PG_URL = savedPgUrl;
	});

	test("an unknown subcommand exits 2", async () => {
		const opened: string[] = [];
		const { io, err } = fakeIo(opened);
		expect(await reconcileMain(["bogus"], io)).toBe(2);
		expect(err.join("\n")).toMatch(/unknown subcommand/);
		expect(opened).toEqual([]);
	});

	test("report with no configured index exits 2 and reads nothing", async () => {
		delete process.env.SUBSTRATE_PG_URL;
		const opened: string[] = [];
		const { io, out, err } = fakeIo(opened);
		expect(await reconcileMain(["report"], io)).toBe(2);
		expect(err.join("\n")).toMatch(/SUBSTRATE_PG_URL is not set/);
		expect(opened).toEqual([]);
		expect(out).toEqual([]);
	});
});
