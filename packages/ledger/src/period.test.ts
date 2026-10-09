import { describe, expect, test } from "bun:test";
import { closedHours, HOUR_MS, hourEnd, hourIso, hourStart, isClosed } from "./period.ts";

const H10 = Date.UTC(2026, 8, 26, 10);
const H11 = Date.UTC(2026, 8, 26, 11);
const LAG = 5 * 60_000;

describe("hour buckets (half-open, UTC)", () => {
	test("the first and last millisecond of 10:00 both bucket to 10:00; 11:00:00.000 is 11:00", () => {
		expect(hourStart(Date.UTC(2026, 8, 26, 10, 0, 0, 0))).toBe(H10);
		expect(hourStart(Date.UTC(2026, 8, 26, 10, 59, 59, 999))).toBe(H10);
		expect(hourStart(Date.UTC(2026, 8, 26, 11, 0, 0, 0))).toBe(H11);
	});

	test("hourIso and hourEnd", () => {
		expect(hourIso(Date.UTC(2026, 8, 26, 10, 42, 7, 1))).toBe("2026-09-26T10:00:00.000Z");
		expect(hourEnd(H10)).toBe(H10 + HOUR_MS);
		expect(hourEnd(H10)).toBe(H11);
	});
});

describe("closed hours", () => {
	test("10:00 closes exactly at 11:00 plus the lag", () => {
		expect(isClosed(H10, H11 + LAG - 1, LAG)).toBe(false);
		expect(isClosed(H10, H11 + LAG, LAG)).toBe(true);
		expect(closedHours(H10, Date.UTC(2026, 8, 26, 11, 4, 59, 999), LAG)).toEqual([]);
		expect(closedHours(H10, Date.UTC(2026, 8, 26, 11, 5, 0, 0), LAG)).toEqual([H10]);
	});

	test("ascending from hourStart(from), stopping before the open hour", () => {
		const from = Date.UTC(2026, 8, 26, 7, 30);
		const now = Date.UTC(2026, 8, 26, 11, 20);
		expect(closedHours(from, now, LAG)).toEqual([
			Date.UTC(2026, 8, 26, 7),
			Date.UTC(2026, 8, 26, 8),
			Date.UTC(2026, 8, 26, 9),
			H10,
		]);
	});
});
