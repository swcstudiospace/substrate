import { describe, expect, test } from "bun:test";
import { AsyncMutex } from "./mutex.ts";

function deferred(): { promise: Promise<void>; release: () => void } {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { promise, release: resolve };
}

describe("AsyncMutex", () => {
	test("holders run one at a time, in the order they asked", async () => {
		const mutex = new AsyncMutex();
		const log: string[] = [];
		const gate = deferred();
		const first = mutex.run(async () => {
			log.push("first:start");
			await gate.promise;
			log.push("first:end");
		});
		const second = mutex.run(async () => {
			log.push("second:start");
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(log).toEqual(["first:start"]);
		gate.release();
		await Promise.all([first, second]);
		expect(log).toEqual(["first:start", "first:end", "second:start"]);
	});

	test("a holder that throws releases the lock and its caller sees the error", async () => {
		const mutex = new AsyncMutex();
		const failing = mutex.run(async () => {
			throw new Error("boom");
		});
		await expect(failing).rejects.toThrow("boom");
		expect(await mutex.run(async () => "next")).toBe("next");
	});

	test("the value of the work is returned", async () => {
		expect(await new AsyncMutex().run(async () => 42)).toBe(42);
	});
});
