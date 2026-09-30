/**
 * Drift is a disagreement between the tree, the trail and the claims, so every
 * test here builds one deliberately and checks that it is named — and, just as
 * important, that a repo where all three agree produces nothing.
 */
import { describe, expect, test } from "bun:test";
import {
	DEFAULT_IDLE_SECONDS,
	analyzeDrift,
	extractCommitSha,
	formatDrift,
	shaMatches,
	type DriftClaim,
	type DriftEvent,
	type DriftInputs,
} from "./drift.ts";
import { NO_LEASE, type LeaseSnapshot } from "./lease.ts";
import type { EventKind, GraphEdge, Surface } from "./types.ts";

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const ALL_SOURCES = { git: true, ledger: true, index: true };

function minutesAgo(minutes: number): string {
	return new Date(NOW - minutes * 60_000).toISOString();
}

function event(overrides: Partial<DriftEvent> & { kind: EventKind }): DriftEvent {
	return {
		id: `evt_${Math.random().toString(16).slice(2)}`,
		ts: minutesAgo(5),
		surface: "hermes",
		session_id: "sess-hermes",
		summary: "did a thing",
		graph_id: "ut-1",
		node_id: null,
		sha: null,
		...overrides,
	};
}

function lease(overrides: Partial<LeaseSnapshot> = {}): LeaseSnapshot {
	return {
		...NO_LEASE,
		lease_id: "lse_live",
		surface: "hermes",
		session_id: "sess-hermes",
		claimed_at: minutesAgo(10),
		heartbeat_at: minutesAgo(1),
		expires_at: new Date(NOW + 600_000).toISOString(),
		epoch: 1,
		...overrides,
	};
}

function claim(overrides: Partial<DriftClaim> = {}): DriftClaim {
	return {
		graph_id: "ut-1",
		node_id: "n2",
		linear_identifier: "SPE-4792",
		state: "started",
		lease: lease(),
		...overrides,
	};
}

function inputs(overrides: Partial<DriftInputs> = {}): DriftInputs {
	return {
		repo: "swcstudiospace/agent-substrate",
		now: NOW,
		git: {
			sha: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
			short_sha: "1a2b3c4",
			subject: "feat: leases",
			committed_at: minutesAgo(6),
			branch: "main",
			knows_ledger_commit: true,
		},
		events: [event({ kind: "commit", sha: "1a2b3c4", summary: "commit 1a2b3c4 feat: leases", ts: minutesAgo(6) })],
		claims: [],
		nodes: [],
		edges: [],
		sources: ALL_SOURCES,
		...overrides,
	};
}

function kinds(report: { findings: Array<{ kind: string }> }): string[] {
	return report.findings.map((finding) => finding.kind);
}

describe("agreement", () => {
	test("a repo where all three records agree reports no drift", () => {
		const report = analyzeDrift(inputs());
		expect(report.findings).toEqual([]);
		expect(report.ok).toBe(true);
		expect(report.unavailable).toEqual([]);
	});

	test("a live, heartbeating, unblocked lease is not drift", () => {
		const report = analyzeDrift(
			inputs({
				claims: [claim()],
				nodes: [{ graph_id: "ut-1", node_id: "n2", linear_identifier: "SPE-4792", state: "started" }],
				events: [
					event({ kind: "commit", sha: "1a2b3c4", summary: "commit 1a2b3c4 feat: leases", ts: minutesAgo(6) }),
					event({ kind: "file.edit", node_id: "n2", ts: minutesAgo(3) }),
				],
			}),
		);
		expect(report.findings).toEqual([]);
		expect(report.claims[0]?.lease.state).toBe("held");
	});
});

describe("the tree against the trail", () => {
	test("a commit with no event is named, with the trail's own tip as evidence", () => {
		const report = analyzeDrift(
			inputs({
				events: [event({ kind: "commit", sha: "9999999", summary: "commit 9999999 earlier work", ts: minutesAgo(90) })],
			}),
		);

		expect(kinds(report)).toEqual(["git.tip_unlogged"]);
		const finding = report.findings[0];
		expect(finding?.severity).toBe("warn");
		expect(finding?.detail).toContain("1a2b3c4");
		expect(finding?.evidence.ledger_last_commit).toMatchObject({ sha: "9999999" });
	});

	test("a short sha in the ledger matches the full sha in the tree", () => {
		// The trap: the collector stores `rev-parse --short`, git reports the full
		// hash. Comparing them for equality would report every commit as unlogged.
		expect(analyzeDrift(inputs()).findings).toEqual([]);
		expect(shaMatches("1a2b3c4", "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b")).toBe(true);
		expect(shaMatches("1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b", "1a2b3c4")).toBe(true);
		expect(shaMatches("1a2b3c5", "1a2b3c4d5e")).toBe(false);
		// Too short to be specific: not a match, rather than a lucky one.
		expect(shaMatches("1a2b3", "1a2b3c4d5e")).toBe(false);
		expect(shaMatches(null, "1a2b3c4")).toBe(false);
	});

	test("a repo with commits and no events at all is a silent ledger, not an unlogged tip", () => {
		const report = analyzeDrift(inputs({ events: [] }));
		expect(kinds(report)).toEqual(["ledger.silent"]);
		expect(report.findings[0]?.detail).toContain("Nothing here is being recorded");
	});

	test("a commit in the trail that the checkout does not have is named", () => {
		const report = analyzeDrift(
			inputs({
				git: { ...inputs().git, knows_ledger_commit: false },
				events: [event({ kind: "commit", sha: "deadbee", summary: "commit deadbee from another host", ts: minutesAgo(2) })],
			}),
		);

		expect(kinds(report)).toEqual(["git.tip_unlogged", "ledger.commit_unknown_to_git"]);
		expect(report.findings[1]?.detail).toContain("unfetched");
	});

	test("a truncated window that does not show the tip is inconclusive, not drift", () => {
		// A busy repo pushes a perfectly well-logged commit out of the newest N
		// events, and inferring "unlogged" from that silence invented drift on
		// exactly the repos that have the most activity.
		const report = analyzeDrift(
			inputs({
				events: [event({ kind: "commit", sha: "9999999", summary: "commit 9999999 older work", ts: minutesAgo(90) })],
				events_truncated: true,
				tip_logged: null,
			}),
		);

		expect(kinds(report)).not.toContain("git.tip_unlogged");
		expect(report.unavailable.join(" ")).toContain("recent-activity window");
	});

	test("a whole-ledger answer outranks the window, both ways", () => {
		const windowMisses = {
			events: [event({ kind: "commit", sha: "9999999", summary: "commit 9999999 older work", ts: minutesAgo(90) })],
			events_truncated: true,
		};
		// Found outside the window: no finding.
		expect(kinds(analyzeDrift(inputs({ ...windowMisses, tip_logged: true })))).not.toContain("git.tip_unlogged");
		// Definitively absent from the whole ledger: a real finding, window or not.
		expect(kinds(analyzeDrift(inputs({ ...windowMisses, tip_logged: false })))).toContain("git.tip_unlogged");
	});

	test("an untruncated window that does not show the tip is still drift", () => {
		// The window held everything there was, so its silence is evidence.
		const report = analyzeDrift(
			inputs({
				events: [event({ kind: "commit", sha: "9999999", summary: "commit 9999999 older work", ts: minutesAgo(90) })],
				events_truncated: false,
				tip_logged: null,
			}),
		);
		expect(kinds(report)).toEqual(["git.tip_unlogged"]);
	});

	test("an unreadable checkout is reported as not compared, not as agreement", () => {
		// The distinction that keeps a clean report honest: nothing disagreed because
		// nothing could be read.
		const report = analyzeDrift(
			inputs({
				sources: { git: false, ledger: true, index: true },
				git: { sha: null, short_sha: null, subject: null, committed_at: null, branch: null, unavailable: "not a readable git checkout: /nope" },
				events: [],
			}),
		);

		expect(report.findings).toEqual([]);
		expect(report.ok).toBe(true);
		expect(report.unavailable).toEqual(["not a readable git checkout: /nope"]);
	});
});

describe("the claims against the trail", () => {
	test("a lapsed lease still on the row is named as free", () => {
		const report = analyzeDrift(
			inputs({
				claims: [claim({ lease: lease({ expires_at: minutesAgo(20), heartbeat_at: minutesAgo(35) }) })],
			}),
		);

		expect(kinds(report)).toEqual(["lease.expired"]);
		expect(report.findings[0]?.detail).toContain("It is free");
		expect(report.findings[0]?.surface).toBe("hermes");
		expect(report.claims[0]?.lease.state).toBe("expired");
	});

	test("a lease held by a session that ended is orphaned", () => {
		const report = analyzeDrift(
			inputs({
				claims: [claim()],
				events: [
					event({ kind: "commit", sha: "1a2b3c4", summary: "commit 1a2b3c4 feat: leases", ts: minutesAgo(6) }),
					event({ kind: "session.end", ts: minutesAgo(4), summary: "session ended" }),
				],
			}),
		);

		expect(kinds(report)).toEqual(["lease.orphaned"]);
		expect(report.findings[0]?.session_id).toBe("sess-hermes");
	});

	test("a live lease with nothing happening for an hour is idle", () => {
		const report = analyzeDrift(
			inputs({
				claims: [
					claim({
						lease: lease({
							claimed_at: minutesAgo(180),
							heartbeat_at: minutesAgo(120),
							expires_at: new Date(NOW + 600_000).toISOString(),
						}),
					}),
				],
				events: [event({ kind: "file.edit", node_id: "n2", ts: minutesAgo(150) })],
			}),
		);

		expect(kinds(report)).toContain("lease.idle");
		const idle = report.findings.find((finding) => finding.kind === "lease.idle");
		// Measured from the last *work*, not from the last heartbeat — 150 minutes,
		// not the 120 since it last renewed.
		expect(idle?.evidence.idle_seconds).toBe(150 * 60);
		expect(idle?.detail).toContain("the work may not be");
	});

	test("a heartbeat does not count as work, so a zombie renewal loop is still idle", () => {
		// The case this finding exists for, and the one an earlier version could not
		// see: the lease is beating on schedule and nothing is being done under it.
		// Counting `heartbeat_at` as a sign of life made the finding unreachable.
		const report = analyzeDrift(
			inputs({
				claims: [
					claim({
						lease: lease({
							claimed_at: minutesAgo(300),
							heartbeat_at: minutesAgo(0),
							expires_at: new Date(NOW + 600_000).toISOString(),
						}),
					}),
				],
				events: [event({ kind: "commit", sha: "1a2b3c4", summary: "commit 1a2b3c4 feat: leases", ts: minutesAgo(6), surface: "omp" as Surface, session_id: "sess-omp" })],
			}),
		);

		expect(kinds(report)).toContain("lease.idle");
		expect(report.findings.find((finding) => finding.kind === "lease.idle")?.evidence.idle_seconds).toBe(300 * 60);
	});

	test("a heartbeat counts as life, so a lease taken seconds ago is never idle", () => {
		const report = analyzeDrift(
			inputs({
				claims: [claim({ lease: lease({ claimed_at: minutesAgo(0), heartbeat_at: minutesAgo(0) }) })],
				events: [event({ kind: "commit", sha: "1a2b3c4", summary: "commit 1a2b3c4 feat: leases", ts: minutesAgo(6) })],
			}),
		);
		expect(kinds(report)).not.toContain("lease.idle");
	});

	test("another agent's activity does not make this holder look busy", () => {
		// The bug this guards: counting any event in the repo as a sign of life would
		// hide every dead session on a host where anything else is running.
		const report = analyzeDrift(
			inputs({
				claims: [claim({ lease: lease({ claimed_at: minutesAgo(200), heartbeat_at: minutesAgo(200) }) })],
				events: [
					event({ kind: "commit", sha: "1a2b3c4", summary: "commit 1a2b3c4 feat: leases", ts: minutesAgo(1), surface: "omp", session_id: "sess-omp" }),
				],
			}),
		);
		expect(kinds(report)).toContain("lease.idle");
	});

	test("the idle window is configurable", () => {
		// Held and heartbeating for 45 minutes with no work of its own: inside the
		// default hour, well outside a ten-minute window.
		const held = {
			claims: [claim({ lease: lease({ claimed_at: minutesAgo(45), heartbeat_at: minutesAgo(45) }) })],
			events: [
				event({ kind: "commit", sha: "1a2b3c4", summary: "commit 1a2b3c4 feat: leases", ts: minutesAgo(6), surface: "omp" as Surface, session_id: "sess-omp" }),
			],
		};
		expect(kinds(analyzeDrift(inputs(held)))).not.toContain("lease.idle");
		expect(kinds(analyzeDrift(inputs({ ...held, idle_seconds: 600 })))).toContain("lease.idle");
		expect(DEFAULT_IDLE_SECONDS).toBe(3600);
	});
});

describe("the trail against the claims", () => {
	test("work on a node nobody holds is named once, not once per event", () => {
		const report = analyzeDrift(
			inputs({
				events: [
					event({ kind: "file.edit", node_id: "n4", ts: minutesAgo(2), surface: "omp", session_id: "sess-omp" }),
					event({ kind: "shell", node_id: "n4", ts: minutesAgo(3), surface: "omp", session_id: "sess-omp" }),
					event({ kind: "commit", sha: "1a2b3c4", summary: "commit 1a2b3c4 feat: leases", ts: minutesAgo(6) }),
				],
			}),
		);

		const unclaimed = report.findings.filter((finding) => finding.kind === "work.unclaimed");
		expect(unclaimed).toHaveLength(1);
		expect(unclaimed[0]?.node_id).toBe("n4");
		expect(unclaimed[0]?.severity).toBe("info");
		expect(unclaimed[0]?.detail).toContain("A second agent could take it mid-flight");
	});

	test("work on a node that is held is not drift", () => {
		const report = analyzeDrift(
			inputs({
				claims: [claim({ node_id: "n4" })],
				events: [
					event({ kind: "file.edit", node_id: "n4", ts: minutesAgo(2) }),
					event({ kind: "commit", sha: "1a2b3c4", summary: "commit 1a2b3c4 feat: leases", ts: minutesAgo(6) }),
				],
			}),
		);
		expect(kinds(report)).not.toContain("work.unclaimed");
	});

	test("work an agent legitimately finished and released is not drift", () => {
		// The false positive: comparing every event in the window against the leases
		// held *now* reported every completed, released node as work done without a
		// claim — normal finished work, flagged on every scan until it aged out.
		const report = analyzeDrift(
			inputs({
				nodes: [{ graph_id: "ut-1", node_id: "n4", linear_identifier: "SPE-1", state: "completed" }],
				events: [
					event({ kind: "file.edit", node_id: "n4", ts: minutesAgo(2), surface: "omp", session_id: "sess-omp" }),
					event({ kind: "commit", sha: "1a2b3c4", summary: "commit 1a2b3c4 feat: leases", ts: minutesAgo(6) }),
				],
			}),
		);
		expect(kinds(report)).not.toContain("work.unclaimed");
	});

	test("nor is work too old to still be in flight", () => {
		const report = analyzeDrift(
			inputs({
				nodes: [{ graph_id: "ut-1", node_id: "n4", linear_identifier: "SPE-1", state: "started" }],
				events: [
					// Outside the idle window: whatever happened here, nobody is mid-flight
					// on it now, so "a second agent could take it" is not a live concern.
					event({ kind: "file.edit", node_id: "n4", ts: minutesAgo(180), surface: "omp", session_id: "sess-omp" }),
					event({ kind: "commit", sha: "1a2b3c4", summary: "commit 1a2b3c4 feat: leases", ts: minutesAgo(6) }),
				],
			}),
		);
		expect(kinds(report)).not.toContain("work.unclaimed");
	});

	test("but recent work on an unfinished node nobody holds still is", () => {
		const report = analyzeDrift(
			inputs({
				nodes: [{ graph_id: "ut-1", node_id: "n4", linear_identifier: "SPE-1", state: "started" }],
				events: [
					event({ kind: "file.edit", node_id: "n4", ts: minutesAgo(2), surface: "omp", session_id: "sess-omp" }),
					event({ kind: "commit", sha: "1a2b3c4", summary: "commit 1a2b3c4 feat: leases", ts: minutesAgo(6) }),
				],
			}),
		);
		expect(kinds(report)).toContain("work.unclaimed");
	});

	test("a prompt or a note is not work, so it does not demand a claim", () => {
		const report = analyzeDrift(
			inputs({ events: [event({ kind: "prompt", node_id: "n4" }), event({ kind: "note", node_id: "n4" }), event({ kind: "commit", sha: "1a2b3c4", summary: "commit 1a2b3c4 feat: leases", ts: minutesAgo(6) })] }),
		);
		expect(kinds(report)).not.toContain("work.unclaimed");
	});
});

describe("graph edges", () => {
	const nodes = [
		{ graph_id: "ut-1", node_id: "n1", linear_identifier: "SPE-1", state: "started" as const },
		{ graph_id: "ut-1", node_id: "n2", linear_identifier: "SPE-4792", state: "started" as const },
	];

	test("a held node whose requirement is incomplete is named", () => {
		const edges: GraphEdge[] = [{ graph_id: "ut-1", from_node: "n2", to_node: "n1", kind: "requires" }];
		const report = analyzeDrift(inputs({ claims: [claim()], nodes, edges }));

		expect(kinds(report)).toEqual(["edge.requires_incomplete"]);
		expect(report.findings[0]?.detail).toContain("requires SPE-1, which is started");
	});

	test("the same relation written from the blocking side is read the same way", () => {
		const edges: GraphEdge[] = [{ graph_id: "ut-1", from_node: "n1", to_node: "n2", kind: "blocks" }];
		expect(kinds(analyzeDrift(inputs({ claims: [claim()], nodes, edges })))).toEqual(["edge.requires_incomplete"]);
	});

	test("a gate is reported as a gate, not as a requirement", () => {
		const edges: GraphEdge[] = [{ graph_id: "ut-1", from_node: "n2", to_node: "n1", kind: "gated_by" }];
		const report = analyzeDrift(inputs({ claims: [claim()], nodes, edges }));
		expect(kinds(report)).toEqual(["edge.gate_open"]);
		expect(report.findings[0]?.detail).toContain("gated by");
	});

	test("a completed requirement is not drift", () => {
		const edges: GraphEdge[] = [{ graph_id: "ut-1", from_node: "n2", to_node: "n1", kind: "requires" }];
		const done = [{ ...nodes[0]!, state: "completed" as const }, nodes[1]!];
		expect(analyzeDrift(inputs({ claims: [claim()], nodes: done, edges })).findings).toEqual([]);
	});

	test("an edge naming a node the index has never seen is not evidence of anything", () => {
		const edges: GraphEdge[] = [{ graph_id: "ut-1", from_node: "n2", to_node: "n99", kind: "requires" }];
		expect(analyzeDrift(inputs({ claims: [claim()], nodes, edges })).findings).toEqual([]);
	});

	test("edges are only checked for nodes that are actually held", () => {
		const edges: GraphEdge[] = [{ graph_id: "ut-1", from_node: "n2", to_node: "n1", kind: "requires" }];
		const lapsed = [claim({ lease: lease({ expires_at: minutesAgo(30) }) })];
		expect(kinds(analyzeDrift(inputs({ claims: lapsed, nodes, edges })))).toEqual(["lease.expired"]);
	});

	test("an edge in another graph is not applied to this one", () => {
		const edges: GraphEdge[] = [{ graph_id: "ut-2", from_node: "n2", to_node: "n1", kind: "requires" }];
		expect(analyzeDrift(inputs({ claims: [claim()], nodes, edges })).findings).toEqual([]);
	});
});

describe("the report", () => {
	test("summarises each record so the comparison can be checked by hand", () => {
		const report = analyzeDrift(
			inputs({
				claims: [claim()],
				events: [
					event({ kind: "commit", sha: "1a2b3c4", summary: "commit 1a2b3c4 feat: leases", ts: minutesAgo(6) }),
					event({ kind: "file.edit", surface: "omp", session_id: "sess-omp", ts: minutesAgo(9), summary: "edited brief.ts" }),
				],
			}),
		);

		expect(report.ledger.events).toBe(2);
		expect(report.ledger.last_commit).toMatchObject({ sha: "1a2b3c4", surface: "hermes" });
		expect(report.ledger.surfaces.map((s) => s.surface)).toEqual(["hermes", "omp"]);
		expect(report.claims).toHaveLength(1);
		expect(report.scanned_at).toBe(new Date(NOW).toISOString());
	});

	test("formats to lines a hook or a terminal can print", () => {
		const text = formatDrift(analyzeDrift(inputs({ events: [] })));
		expect(text.split("\n")[0]).toBe("drift scan swcstudiospace/agent-substrate — 1 finding");
		expect(text).toContain("git 1a2b3c4 @ main");
		expect(text).toContain("[warn] ledger.silent");
	});

	test("says which records were not compared", () => {
		const text = formatDrift(
			analyzeDrift(inputs({ sources: { git: true, ledger: false, index: false }, events: [] })),
		);
		expect(text).toContain("not compared — ledger");
		expect(text).toContain("not compared — index");
	});
});

describe("extractCommitSha", () => {
	test("prefers the payload the collector writes", () => {
		expect(extractCommitSha("commit 1a2b3c4 subject", { sha: "9999999" })).toBe("9999999");
	});

	test("falls back to the summary, for a collector that sends no payload", () => {
		expect(extractCommitSha("commit 1A2B3C4 subject", undefined)).toBe("1a2b3c4");
		expect(extractCommitSha("commit 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b x", {})).toBe(
			"1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
		);
	});

	test("ignores anything that is not a sha", () => {
		expect(extractCommitSha("committed the fix", { sha: "not-a-sha" })).toBeNull();
		expect(extractCommitSha("commit abc", {})).toBeNull();
		expect(extractCommitSha("no sha here", undefined)).toBeNull();
	});
});

describe("surfaces", () => {
	test("every surface's newest event is the one reported", () => {
		const surfaces: Surface[] = ["hermes", "omp", "muse"];
		const report = analyzeDrift(
			inputs({
				events: surfaces.flatMap((surface, i) => [
					event({ kind: "note", surface, session_id: `s-${surface}`, ts: minutesAgo(i + 1), summary: `${surface} new` }),
					event({ kind: "note", surface, session_id: `s-${surface}`, ts: minutesAgo(i + 60), summary: `${surface} old` }),
				]),
			}),
		);
		expect(report.ledger.surfaces.map((s) => s.last_summary)).toEqual(["hermes new", "omp new", "muse new"]);
	});
});
