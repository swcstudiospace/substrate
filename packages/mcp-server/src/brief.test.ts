import { describe, expect, test } from "bun:test";
import { composeBrief, toDate } from "./brief.ts";

describe("toDate", () => {
	test("reads a Greptime millisecond epoch, which arrives as an integer", () => {
		// Regression: new Date("1790186361859") is not new Date(1790186361859),
		// which rendered every brief timestamp as --:--.
		expect(toDate(1790186361859)?.toISOString()).toBe("2026-09-23T17:59:21.859Z");
	});

	test("disambiguates precision by magnitude", () => {
		const expected = "2026-09-23T17:59:21";
		expect(toDate(1790186361)?.toISOString()).toStartWith(expected); // seconds
		expect(toDate(1790186361859)?.toISOString()).toStartWith(expected); // millis
		expect(toDate(1790186361859 * 1e3)?.toISOString()).toStartWith(expected); // micros
		expect(toDate(1790186361859 * 1e6)?.toISOString()).toStartWith(expected); // nanos
	});

	test("still accepts ISO strings and Dates", () => {
		expect(toDate("2026-09-23T17:59:21.859Z")?.toISOString()).toBe("2026-09-23T17:59:21.859Z");
		const now = new Date();
		expect(toDate(now)).toBe(now);
	});

	test("returns null for junk rather than an Invalid Date", () => {
		expect(toDate("not-a-date")).toBeNull();
		expect(toDate(null)).toBeNull();
		expect(toDate(undefined)).toBeNull();
	});
});

describe("composeBrief", () => {
	test("degrades to a usable line when no store is configured", async () => {
		const brief = await composeBrief(
			{ repo: "swcstudiospace/autonogrammer", surface: "claude-code" },
			{ index: null, greptime: null },
		);
		expect(brief).toContain("## Substrate brief: swcstudiospace/autonogrammer");
		expect(brief).toContain("first claude-code session here");
	});

	test("says so when a graph id is not in the index", async () => {
		const brief = await composeBrief(
			{ repo: "r", graph_id: "ut-nope-00000000", surface: "hermes" },
			{ index: null, greptime: null },
		);
		expect(brief).toContain("not in the index yet");
	});

	test("never throws when a store fails — a blocked prompt is worse than a thin brief", async () => {
		const exploding = {
			getGraph: () => Promise.reject(new Error("postgres is down")),
			openGraphs: () => Promise.reject(new Error("postgres is down")),
			memoryForBrief: () => Promise.reject(new Error("postgres is down")),
		};
		const brief = await composeBrief(
			{ repo: "swcstudiospace/autonogrammer", graph_id: "ut-x", surface: "claude-code" },
			{ index: exploding as never, greptime: null },
		);
		expect(brief).toContain("## Substrate brief:");
	});
});
