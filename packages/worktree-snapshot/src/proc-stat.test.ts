/**
 * Pure unit tests for the /proc/<pid>/stat start-time parse. The samples are fixed text, so nothing
 * here reads the host's /proc.
 */
import { describe, expect, test } from "bun:test";
import { parseProcStatStartTicks, procStartSeconds } from "./proc-stat.ts";

/** Fields 3..21 are placeholders; field 22 (starttime) is 77973817, then three trailing fields. */
const TAIL = "S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 77973817 19 20 21";

describe("parseProcStatStartTicks", () => {
	test("reads field 22 of a plain stat line", () => {
		expect(parseProcStatStartTicks(`1525582 (bun) ${TAIL}`)).toBe(77973817);
	});

	test("reads field 22 when comm holds spaces and parentheses", () => {
		// Only the LAST ")" ends comm; splitting on the first one would shift every field.
		expect(parseProcStatStartTicks(`42 (a b) (c) ${TAIL}`)).toBe(77973817);
		expect(parseProcStatStartTicks(`42 (my bun (worker)) ${TAIL}`)).toBe(77973817);
		expect(parseProcStatStartTicks(`42 () ${TAIL}`)).toBe(77973817);
	});

	test("tolerates a trailing newline as /proc prints it", () => {
		expect(parseProcStatStartTicks(`1525582 (bun) ${TAIL}\n`)).toBe(77973817);
	});

	test("is null for a truncated line", () => {
		// Field 22 would be index 19 after comm; a line cut before it must not yield a neighbour field.
		expect(parseProcStatStartTicks("1525582 (bun) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18")).toBeNull();
		expect(parseProcStatStartTicks("1525582 (bun)")).toBeNull();
	});

	test("is null without a closing paren or for an empty string", () => {
		expect(parseProcStatStartTicks("")).toBeNull();
		expect(parseProcStatStartTicks("not a stat line")).toBeNull();
	});

	test("is null when field 22 is not a non-negative integer", () => {
		expect(parseProcStatStartTicks("1 (bun) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 abc 19")).toBeNull();
		expect(parseProcStatStartTicks("1 (bun) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 -5 19")).toBeNull();
	});
});

describe("procStartSeconds", () => {
	const btime = 1790699914;

	test("adds btime to the start ticks over the default 100 Hz", () => {
		expect(procStartSeconds(btime, `1525582 (bun) ${TAIL}`)).toBe(btime + 77973817 / 100);
	});

	test("survives a comm like (a b) (c)", () => {
		expect(procStartSeconds(btime, `42 (a b) (c) ${TAIL}`)).toBe(btime + 77973817 / 100);
	});

	test("divides by the supplied tick rate", () => {
		expect(procStartSeconds(btime, `1 (bun) ${TAIL}`, 250)).toBe(btime + 77973817 / 250);
	});

	test("is null for a truncated line or a non-positive tick rate", () => {
		expect(procStartSeconds(btime, "1 (bun) S 1 2 3")).toBeNull();
		expect(procStartSeconds(btime, `1 (bun) ${TAIL}`, 0)).toBeNull();
	});
});
