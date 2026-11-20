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
		const failed: string[] = [];
		const brief = await composeBrief(
			{ repo: "swcstudiospace/autonogrammer", graph_id: "ut-x", surface: "claude-code" },
			{ index: exploding as never, greptime: null },
			undefined,
			(source) => {
				failed.push(source);
			},
		);
		expect(brief).toContain("## Substrate brief:");
		expect(brief).toContain("not in the index yet");
		// Once per failed source, in section order (uplift-2 R1); no ledger, so no recent-actions read.
		expect(failed).toEqual(["graph", "open graphs", "memory"]);
	});
});

describe("how the brief reports a lease", () => {
	/** One graph, one node, with whatever lease the test wants on it. */
	function indexWith(node: Record<string, unknown>) {
		return {
			getGraph: async () => ({
				graph_id: "ut-1",
				repo: "swcstudiospace/agent-substrate",
				branch: "main",
				surface: "hermes",
				status: "In Progress",
				pr_url: null,
				nodes: [
					{
						graph_id: "ut-1",
						node_id: "n2",
						linear_identifier: "SPE-4792",
						state: "started",
						lease_epoch: 1,
						...node,
					},
				],
				steps: [],
				edges: [],
			}),
			openGraphs: async () => [],
			memoryForBrief: async () => [],
		};
	}

	async function briefFor(node: Record<string, unknown>): Promise<string> {
		return composeBrief(
			{ repo: "swcstudiospace/agent-substrate", graph_id: "ut-1", surface: "omp" },
			{ index: indexWith(node) as never, greptime: null },
		);
	}

	test("a live lease is reported as held, by whom, and since when", async () => {
		const brief = await briefFor({
			claimed_by: "hermes",
			claim_session: "sess-a",
			claimed_at: new Date(Date.now() - 300_000).toISOString(),
			lease_id: "lse_live",
			lease_expires_at: new Date(Date.now() + 600_000).toISOString(),
		});

		expect(brief).toContain("n2 SPE-4792 held by hermes 5 min ago");
	});

	test("a lapsed lease is reported as free, naming who was last there", async () => {
		// The line that matters most. Reading "started by hermes" off a lease that
		// expired half an hour ago keeps the next agent off a node it may have, which
		// is the deadlock leases exist to end — and it is exactly what the old brief said.
		const brief = await briefFor({
			claimed_by: "hermes",
			claim_session: "sess-dead",
			claimed_at: new Date(Date.now() - 7_200_000).toISOString(),
			lease_id: "lse_dead",
			lease_expires_at: new Date(Date.now() - 1_800_000).toISOString(),
		});

		expect(brief).toContain("n2 SPE-4792 free — hermes's lease expired 30 min ago");
		expect(brief).not.toContain("held by");
	});

	test("a claim from before leases existed lapses in the brief too", async () => {
		// A Phase 0 row: claimed_by and claimed_at, no lease columns. Held for one
		// default TTL, then reported free, so the index heals rather than stranding it.
		const brief = await briefFor({
			claimed_by: "omp",
			claim_session: null,
			claimed_at: new Date(Date.now() - 86_400_000).toISOString(),
			lease_id: null,
			lease_expires_at: null,
		});

		expect(brief).toContain("free — omp's lease expired");
	});

	test("a completed node reads as done whatever its lease said", async () => {
		const brief = await briefFor({ state: "completed", claimed_by: "hermes", lease_id: null, lease_expires_at: null });
		expect(brief).toContain("n2 SPE-4792 done (hermes)");
	});

	test("an unclaimed node is neither held nor stale", async () => {
		const brief = await briefFor({ claimed_by: null, claimed_at: null, lease_id: null, lease_expires_at: null });
		expect(brief).toContain("n2 SPE-4792 started");
		expect(brief).not.toContain("lease expired");
	});
});

describe("recent-actions quoting follows the ledger's dialect", () => {
	/** A ledger stub that records each statement and answers with no rows, with the dialect the client would report. */
	function ledger(escapesBackslashes: boolean) {
		const sent: string[] = [];
		const greptime = {
			escapesBackslashes,
			sql: async (statement: string) => {
				sent.push(statement);
				return [];
			},
		};
		return { sent, greptime };
	}

	test("a server that does not escape backslashes is asked for the repo with its backslash verbatim", async () => {
		const { sent, greptime } = ledger(false);
		await composeBrief({ repo: "acme\\app", surface: "cursor" }, { index: null, greptime: greptime as never }, undefined, undefined, { budgetMs: 0 });
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain(`"repo" = 'acme\\app'`);
		expect(sent[0]).not.toContain("\\\\");
	});

	test("a server that escapes backslashes is asked for the doubled form, which is what it stored", async () => {
		const { sent, greptime } = ledger(true);
		await composeBrief({ repo: "acme\\app", surface: "cursor" }, { index: null, greptime: greptime as never }, undefined, undefined, { budgetMs: 0 });
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain(`"repo" = 'acme\\\\app'`);
	});
});
