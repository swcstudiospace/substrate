/**
 * The text of `substrate steer` and the context hook: control characters are neutralised, ages are stated, and the
 * digest never exceeds its bound or cuts a line in half.
 */
import { describe, expect, test } from "bun:test";
import type { ContextDigest, DigestItem } from "./client.ts";
import { plain } from "./plain.ts";
import { ageOf, ageText, boundLines, renderDigest, renderSessionLine, renderSessions } from "./render.ts";

const item = (source: string, age_s: number, fields: Record<string, unknown> = {}): DigestItem => ({ source, age_s, fields });

const digest = (over: Partial<ContextDigest> = {}): ContextDigest => ({
	generated_at: "2026-01-01T00:00:00.000Z",
	repo_id: "acme/widgets",
	for_session: null,
	lists: { sessions: [], claims: [], events: [], handoffs: [], planning: [] },
	truncated: [],
	notes: [],
	...over,
});

describe("plain", () => {
	test("replaces control characters (escape, bell, newline, tab, DEL) with one space and collapses runs", () => {
		expect(plain("a\u001b[31mb\u0007\n\tc\u007fd", 100)).toBe("a [31mb c d");
	});
	test("cuts to the limit with an ellipsis that counts toward it", () => {
		expect(plain("abcdefghij", 5)).toBe("abcd…");
		expect(plain("abcde", 5)).toBe("abcde");
	});
	test("keeps astral characters whole", () => {
		expect(plain("😀😀", 10)).toBe("😀😀");
	});
});

describe("ages", () => {
	test("the unit changes at 60 s, 60 min and 24 h", () => {
		expect([0, 59, 60, 3_599, 3_600, 86_399, 86_400, 172_800].map(ageText)).toEqual(["0s", "59s", "1m", "59m", "1h", "23h", "1d", "2d"]);
	});
	test("a timestamp in the future is age zero, and one that is not a date has no age", () => {
		const now = Date.parse("2026-01-01T00:00:00.000Z");
		expect(ageOf("2026-01-01T00:00:10.000Z", now)).toBe(0);
		expect(ageOf("2025-12-31T23:59:00.000Z", now)).toBe(60);
		expect(ageOf(now - 5_000, now)).toBe(5);
		expect(ageOf("yesterday", now)).toBeUndefined();
	});
	test("a session line with an unreadable time prints it as given rather than inventing an age", () => {
		const line = renderSessionLine({ session_id: "s", surface: "omp", repo_id: "r", state: "ACTIVE", updated_at: "recently", planning_hash: null, steering: "PAUSED", pending_directives: 0 }, 0);
		expect(line).toContain("updated recently");
		expect(line).toContain("steering=PAUSED");
		expect(line).not.toContain("planning=");
	});
});

describe("metadata-only session rendering", () => {
	const metadata = {
		session_id: `ls_${"1".repeat(64)}`, surface: "omp", repo_id: "acme/widgets", state: "ACTIVE",
		updated_at: "2026-01-01T00:00:00.000Z", expires_at: "2026-01-01T01:00:00.000Z",
	};

	test("absent private fields are omitted, not invented as zero or undefined", () => {
		const line = renderSessionLine(metadata, Date.parse("2026-01-01T00:01:00.000Z"));
		expect(line).toContain("surface=omp");
		expect(line).toContain("state=ACTIVE");
		expect(line).toContain("repo=acme/widgets");
		expect(line).toContain("updated 1m ago");
		expect(line).not.toContain("pending=");
		expect(line).not.toContain("planning=");
		expect(line).not.toContain("steering=");
		expect(line).not.toContain("undefined");
		expect(line).not.toContain("null");
		expect(renderSessions({ sessions: [metadata], truncated: false }, Date.parse("2026-01-01T00:01:00.000Z"))).toEqual([line]);
	});

	test("explicit operator zero and authorized private values remain distinguishable from absence", () => {
		const line = renderSessionLine({ ...metadata, pending_directives: 0, planning_hash: "0123456789abcdef", steering: { state: "PAUSED" } }, 0);
		expect(line).toContain("pending=0");
		expect(line).toContain("planning=01234567");
		expect(line).toContain("steering=PAUSED");
	});

	test("metadata strings still neutralize terminal controls", () => {
		const line = renderSessionLine({ ...metadata, surface: "omp\u001b[2J", repo_id: "acme/widgets\u0007", state: "ACTIVE\nPAUSED" }, 0);
		expect(line).not.toContain("\u001b");
		expect(line).not.toContain("\u0007");
		expect(line).not.toContain("\n");
		expect(line).not.toContain("pending=");
	});
});

describe("boundLines", () => {
	test("text within the bound is untouched", () => {
		expect(boundLines(["a", "b"], 100)).toBe("a\nb");
	});
	test("over the bound it drops whole lines from the end, says how many, and stays within the bound", () => {
		const lines = Array.from({ length: 50 }, (_, index) => `line ${index} ${"x".repeat(40)}`);
		const out = boundLines(lines, 500);
		expect(out.length).toBeLessThanOrEqual(500);
		expect(out).toMatch(/\(… \d+ more lines cut\)$/);
		for (const kept of out.split("\n").slice(0, -1)) expect(lines).toContain(kept);
	});
	test("a first line longer than the bound leaves only the cut note, still within the bound", () => {
		const out = boundLines(["y".repeat(1_000)], 30);
		expect(out.length).toBeLessThanOrEqual(30);
		expect(out).toContain("cut");
	});
});

describe("renderDigest", () => {
	test("groups by list in a fixed order, names source and age on every item, and puts the described fields first", () => {
		const text = renderDigest(
			digest({
				for_session: "sess-1",
				lists: {
					sessions: [item("presence", 12, { zeta: "last", branch: "feat/x", session_id: "other", worktree: "/w/x" })],
					claims: [item("graph", 7_300, { node_id: "n1", holder: "omp" })],
					events: [],
					handoffs: [item("ledger", 90_000, { goal: "finish parser" })],
					planning: [],
				},
				truncated: ["events"],
				notes: ["bounded to 20 per list"],
			}),
		);
		const lines = text.split("\n");
		expect(lines[0]).toBe("Live context for acme/widgets (for session sess-1), generated 2026-01-01T00:00:00.000Z");
		expect(lines).toContain("sessions:");
		expect(lines).toContain("claims:");
		expect(lines).toContain("handoffs:");
		expect(lines).not.toContain("events:");
		expect(lines.indexOf("sessions:")).toBeLessThan(lines.indexOf("claims:"));
		expect(lines).toContain("- [presence, 12s old] session_id=other worktree=/w/x branch=feat/x zeta=last");
		expect(lines).toContain("- [graph, 2h old] node_id=n1 holder=omp");
		expect(lines).toContain("- [ledger, 1d old] goal=finish parser");
		expect(lines).toContain("(cut by the server: events)");
		expect(lines).toContain("note: bounded to 20 per list");
	});

	test("fields that are not text or numbers are left out, and an item shows at most six fields", () => {
		const text = renderDigest(digest({ lists: { sessions: [], claims: [], events: [item("ledger", 1, { nested: { a: 1 }, list: [1], none: null, a: "1", b: "2", c: "3", d: "4", e: "5", f: "6", g: "7" })], handoffs: [], planning: [] } }));
		const line = defined(text.split("\n").find((l) => l.startsWith("- [ledger")));
		expect(line).toBe("- [ledger, 1s old] a=1 b=2 c=3 d=4 e=5 f=6");
	});

	test("a field value is cut to 80 characters", () => {
		const text = renderDigest(digest({ lists: { sessions: [], claims: [], events: [item("ledger", 1, { summary: "s".repeat(500) })], handoffs: [], planning: [] } }));
		const line = defined(text.split("\n").find((l) => l.startsWith("- [ledger")));
		expect(line.length).toBeLessThan(120);
		expect(line).toContain("…");
	});

	test("is bounded however many items there are, and the bound is the argument", () => {
		const events = Array.from({ length: 400 }, (_, index) => item("ledger", index, { summary: `event number ${index}` }));
		const big = digest({ lists: { sessions: [], claims: [], events, handoffs: [], planning: [] } });
		expect(renderDigest(big).length).toBeLessThanOrEqual(4_000);
		expect(renderDigest(big, 300).length).toBeLessThanOrEqual(300);
	});

	test("an empty digest is just its header", () => {
		expect(renderDigest(digest()).split("\n")).toHaveLength(1);
	});
});

function defined<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("expected a value");
	return value;
}
