import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, rmSync } from "node:fs";
import { tempDir } from "../../../corpus/src/test-support.ts";
import { createBodyStore } from "./bodies.ts";

const parents: string[] = [];
afterEach(() => {
	for (const dir of parents.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function parent(): string {
	const dir = tempDir("bodies-");
	parents.push(dir);
	return dir;
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("the body store", () => {
	test("returns what was stored under a hash, exactly, and null for a hash never stored", () => {
		const store = createBodyStore(parent());
		store.put(HASH_A, "# text with é and a trailing newline\n");
		expect(store.get(HASH_A)).toBe("# text with é and a trailing newline\n");
		expect(store.get(HASH_B)).toBeNull();
		store.close();
	});

	test("only a lowercase hex sha256 names a body, so a path can never escape the directory", () => {
		const store = createBodyStore(parent());
		for (const bad of ["../escape", "a".repeat(63), "A".repeat(64), "", `${HASH_A}/x`]) {
			expect(() => store.put(bad, "x")).toThrow(RangeError);
			expect(store.get(bad)).toBeNull();
		}
		store.close();
	});

	test("close removes the whole directory", () => {
		const root = parent();
		const store = createBodyStore(root);
		store.put(HASH_A, "x");
		expect(readdirSync(root)).toHaveLength(1);
		store.close();
		expect(readdirSync(root)).toEqual([]);
	});
});
