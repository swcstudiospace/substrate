/**
 * summarize: counter aggregation, --since filtering, garbled-line skipping.
 * Plus one spawned run proving the CLI is read-only and exits 0.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarize } from "./status.ts";

describe("summarize counters", () => {
	test("aggregates stored/refused/failed plus collector extras", () => {
		const summary = summarize(
			{
				herdr: { version: 2, panes: {}, counters: { stored: 3, refused: 1, failed: 2, unmapped: 4 } },
				muse: { counters: { stored: 9, refused: 0, failed: 1, fetch_failed: 2, no_slug: 1 } },
				grok: { "/some/log.jsonl": 128, counters: { stored: 5, refused: 0, failed: 0 } },
			},
			[],
		);

		expect(summary.collectors["herdr"]).toEqual({
			stored: 3,
			refused: 1,
			failed: 2,
			extras: { unmapped: 4 },
		});
		expect(summary.collectors["muse"]).toEqual({
			stored: 9,
			refused: 0,
			failed: 1,
			extras: { fetch_failed: 2, no_slug: 1 },
		});
		expect(summary.collectors["grok"]).toEqual({ stored: 5, refused: 0, failed: 0, extras: {} });
		expect(summary.refused).toEqual([]);
		expect(summary.skipped).toBe(0);
	});

	test("missing files and non-number counters read as zeros", () => {
		const summary = summarize({ herdr: undefined, muse: "garbage", grok: { counters: { stored: "3" } } }, []);

		expect(summary.collectors["herdr"]).toEqual({ stored: 0, refused: 0, failed: 0, extras: {} });
		expect(summary.collectors["muse"]).toEqual({ stored: 0, refused: 0, failed: 0, extras: {} });
		expect(summary.collectors["grok"]).toEqual({ stored: 0, refused: 0, failed: 0, extras: {} });
	});
});

describe("refused lines", () => {
	const line = (ts: string): string =>
		JSON.stringify({
			ts,
			collector: "grok",
			source: "grok",
			kind: "prompt",
			surface: "grok-build",
			status: 400,
			error: "unknown kind",
		});

	test("keeps ts at or after since, drops earlier lines", () => {
		const summary = summarize(
			{},
			[line("2026-10-08T10:00:00.000Z"), line("2026-10-09T10:00:00.000Z")],
			"2026-10-09T00:00:00.000Z",
		);

		expect(summary.refused.map((entry) => entry.ts)).toEqual(["2026-10-09T10:00:00.000Z"]);
		expect(summary.skipped).toBe(0);
	});

	test("garbled lines are skipped, never fatal, blanks ignored", () => {
		const summary = summarize({}, ["{not json", JSON.stringify({ collector: "x" }), "", line("2026-10-09T10:00:00.000Z")]);

		expect(summary.refused).toHaveLength(1);
		expect(summary.skipped).toBe(2);
	});
});

describe("collectors:status CLI", () => {
	test("prints counters and refused lines as JSON, writes nothing, exits 0", () => {
		const dir = mkdtempSync(join(tmpdir(), "collectors-status-"));
		writeFileSync(
			join(dir, "grok-offsets.json"),
			JSON.stringify({ counters: { stored: 2, refused: 1, failed: 0 } }),
		);
		writeFileSync(
			join(dir, "refused-emits.jsonl"),
			`${JSON.stringify({
				ts: "2026-10-09T10:00:00.000Z",
				collector: "grok",
				source: "grok",
				kind: "prompt",
				surface: "grok-build",
				status: 400,
				error: "nope",
			})}\n{broken\n`,
		);

		const before = readdirSync(dir).sort();
		const result = Bun.spawnSync(
			["bun", "packages/collectors/src/status.ts", "--state-dir", dir, "--json"],
			{ stdout: "pipe", stderr: "pipe" },
		);

		expect(result.exitCode).toBe(0);
		const summary = JSON.parse(result.stdout.toString()) as {
			collectors: Record<string, { stored: number; refused: number }>;
			refused: unknown[];
			skipped: number;
		};
		expect(summary.collectors["grok"]).toMatchObject({ stored: 2, refused: 1 });
		expect(summary.collectors["herdr"]).toMatchObject({ stored: 0, refused: 0 });
		expect(summary.refused).toHaveLength(1);
		expect(summary.skipped).toBe(1);
		expect(readdirSync(dir).sort()).toEqual(before);
	});
});
