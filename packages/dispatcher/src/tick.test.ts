/**
 * Tests for the dispatcher tick (DISP-04 through DISP-07).
 *
 * Every seam is a fake: Linear, substrate MCP, worktree gate, Hermes
 * config, spawner, clock, and signals. The real `hermes` binary is never
 * executed; the given-up set and prompt files live in tmp dirs. A canary
 * string seeded into pre-existing comment bodies must never reappear in
 * anything the tick writes.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PollIssue, PollingClient } from "./linear-poll.ts";
import type { DispatchEventInput, FindNodeResult, GraphSnapshot } from "./substrate-client.ts";
import { isGivenUp, markGivenUp } from "./watch.ts";
import { dispatchIssue, runTick, type TickDeps, type TickSubstrate } from "./tick.ts";
import type { HermesSpawnOptions } from "./launch-hermes.ts";

const CANARY = "CANARY-meridian-thistle-582";

const GRAPH_ID = "ut-mkts36-abcdef01";
const NODE_ID = "n3";
const SESSION_ID = `hermes:${GRAPH_ID}:${NODE_ID}`;
const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const LIVE = new Date(NOW + 600_000).toISOString();

const HERMES_ISSUE: PollIssue = {
	id: "iss-hermes-1",
	identifier: "ENG-101",
	labels: [
		{ id: "lbl-dispatch", name: "dispatch:hermes" },
		{ id: "lbl-team", name: "team:eng" },
	],
};

const tmpBases: string[] = [];
afterEach(() => {
	while (tmpBases.length > 0) {
		const base = tmpBases.pop();
		if (base !== undefined) rmSync(base, { recursive: true, force: true });
	}
});

function makeTmp(): string {
	const base = mkdtempSync(join(tmpdir(), "dispatcher-tick-"));
	tmpBases.push(base);
	return base;
}

interface LinearFake {
	client: PollingClient;
	comments: Array<{ issueId: string; body: string }>;
	updates: Array<{ id: string; input: { removedLabelIds?: string[] } }>;
}

function linearFake(issues: PollIssue[], seeds: Record<string, string[]> = {}): LinearFake {
	const comments: LinearFake["comments"] = [];
	const updates: LinearFake["updates"] = [];
	const client: PollingClient = {
		listUnstartedIssues: async () => ({ nodes: issues, pageInfo: { hasNextPage: false, endCursor: null } }),
		graphql: async <T>(query: string, _variables: Record<string, unknown>): Promise<T> => {
			expect(query).toContain("DispatchMarkerComments");
			const bodies = [...(seeds[HERMES_ISSUE.id] ?? []), ...comments.filter((c) => c.issueId === HERMES_ISSUE.id).map((c) => c.body)];
			return {
				issue: { comments: { nodes: bodies.map((body) => ({ body })), pageInfo: { hasNextPage: false, endCursor: null } } },
			} as unknown as T;
		},
		createComment: async (issueId: string, body: string) => void comments.push({ issueId, body }),
		updateIssue: async (id: string, input: { removedLabelIds?: string[] }) => void updates.push({ id, input }),
	};
	return { client, comments, updates };
}

interface SubstrateFake {
	findResult: FindNodeResult;
	graphQueue: Array<GraphSnapshot | null>;
	graphCalls: number;
	events: DispatchEventInput[];
	client: TickSubstrate;
}

function substrateFake(findResult: FindNodeResult, graphQueue: Array<GraphSnapshot | null>): SubstrateFake {
	const events: DispatchEventInput[] = [];
	const fake: SubstrateFake = {
		findResult,
		graphQueue,
		graphCalls: 0,
		events,
		client: {
			findNode: async () => findResult,
			getGraph: async () => {
				fake.graphCalls += 1;
				return fake.graphQueue.length > 1 ? (fake.graphQueue.shift() ?? null) : (fake.graphQueue[0] ?? null);
			},
			emitEvent: async (event) => void events.push(event),
		},
	};
	return fake;
}

function foundNode(): FindNodeResult {
	return {
		found: true,
		graph_id: GRAPH_ID,
		node_id: NODE_ID,
		repo: "swcstudiospace/agent-substrate",
		branch: null,
		node: {
			graph_id: GRAPH_ID,
			node_id: NODE_ID,
			claimed_by: null,
			claim_session: null,
			lease_id: null,
			lease_expires_at: null,
		},
	};
}

function graphWith(claimed_by: string | null, claim_session: string | null, lease_expires_at: string | null): GraphSnapshot {
	return {
		graph_id: GRAPH_ID,
		nodes: [{ graph_id: GRAPH_ID, node_id: NODE_ID, claimed_by, claim_session, lease_id: null, lease_expires_at }],
	};
}

const FREE_GRAPH = graphWith(null, null, null);

interface Spawned {
	argv: string[];
	options: HermesSpawnOptions;
}

const SUBSTRATE_CONFIG = "mcp_servers:\n  substrate:\n    url: http://127.0.0.1:7410/mcp\n    enabled: true\n";

function tickDeps(overrides: {
	linear: LinearFake;
	substrate: SubstrateFake;
	worktree?: (input: { graphId: string; repo: string | null }) => Promise<EnsureWorktreeResult>;
	config?: string | null;
	alive?: boolean | (() => boolean);
	nowRef?: { now: number };
}): { deps: TickDeps; base: string; worktreeDir: string; spawns: Spawned[]; signals: string[] } {
	const base = makeTmp();
	const givenUpDir = join(base, "given-up");
	const worktreeDir = join(base, "wt");
	mkdirSync(worktreeDir, { recursive: true });
	const spawns: Spawned[] = [];
	const signals: string[] = [];
	const nowRef = overrides.nowRef ?? { now: NOW };
	const alive = overrides.alive ?? true;
	const deps: TickDeps = {
		linear: overrides.linear.client,
		substrate: overrides.substrate.client,
		givenUpDir,
		worktree: overrides.worktree ?? (async () => ({ ok: true as const, path: worktreeDir, reused: false })),
		readHermesConfig: () => (overrides.config === undefined ? SUBSTRATE_CONFIG : overrides.config),
		spawn: (argv, options) => {
			spawns.push({ argv, options });
			return { pid: 4242 };
		},
		childEnvSource: {
			HOME: "/root",
			PATH: "/usr/bin",
			LINEAR_API_KEY: "must-not-pass",
			SUBSTRATE_TOKEN_SUBSTRATE: "must-not-pass",
		},
		substrateUrl: "http://127.0.0.1:7410",
		hermesToken: "hermes-token",
		isAlive: typeof alive === "function" ? alive : () => alive,
		signalProcess: (_pid, signal) => void signals.push(signal),
		sleep:
			overrides.nowRef !== undefined
				? async (ms) => void (nowRef.now += ms)
				: async () => {},
		now: () => nowRef.now,
		pollIntervalMs: 1,
	};
	return { deps, base, worktreeDir, spawns, signals };
}

function expectVocabularyClosed(events: DispatchEventInput[]): void {
	expect(events.length).toBeGreaterThan(0);
	for (const event of events) {
		expect(["note", "warning"]).toContain(event.kind);
		expect(event.session_id.startsWith("dispatch:")).toBe(true);
		expect(event.payload.action).toBe("dispatch");
		expect(event.payload.runtime).toBe("dispatcher");
		expect(JSON.stringify(event)).not.toContain(CANARY);
	}
}

describe("hermes dispatch", () => {
	test("a landed claim emits a launch event and touches nothing else", async () => {
		const linear = linearFake([HERMES_ISSUE], { [HERMES_ISSUE.id]: [`prior discussion ${CANARY}`] });
		const substrate = substrateFake(foundNode(), [
			FREE_GRAPH,
			graphWith("hermes", SESSION_ID, LIVE),
		]);
		const { deps, worktreeDir, spawns } = tickDeps({ linear, substrate });

		const result = await dispatchIssue(HERMES_ISSUE, "hermes", deps);

		expect(result).toEqual({ status: "landed" });
		expect(spawns).toHaveLength(1);
		const spawned = spawns[0];
		if (!spawned) throw new Error("expected one recorded spawn");
		const promptPath = spawned.argv[spawned.argv.length - 1];
		if (!promptPath) throw new Error("expected a prompt path in argv");
		expect(spawned.argv).toEqual([
			"hermes",
			"chat",
			"--oneshot",
			"--quiet",
			"--source",
			"tool",
			"--yolo",
			"--accept-hooks",
			"--in",
			worktreeDir,
			"--query-file",
			promptPath,
		]);
		expect(JSON.stringify(spawned)).not.toContain(CANARY);
		expect(Object.keys(spawned.options.env).sort()).toEqual(
			["HOME", "PATH", "SUBSTRATE_TOKEN_HERMES", "SUBSTRATE_URL"].sort(),
		);
		const prompt = readFileSync(promptPath, "utf8");
		expect(prompt).toContain(GRAPH_ID);
		expect(prompt).toContain(SESSION_ID);
		expect(prompt).not.toContain(CANARY);
		expect(linear.comments).toEqual([]);
		expect(linear.updates).toEqual([]);
		expect(isGivenUp(deps.givenUpDir, HERMES_ISSUE.id)).toBe(false);
		expectVocabularyClosed(substrate.events);
		expect(substrate.events).toEqual([
			{
				kind: "note",
				summary: `dispatched ${GRAPH_ID}: launched`,
				session_id: `dispatch:${GRAPH_ID}:0`,
				graph_id: GRAPH_ID,
				node_id: NODE_ID,
				payload: { action: "dispatch", runtime: "dispatcher", outcome: "launched", graph_id: GRAPH_ID },
			},
		]);
	});

	test("a foreign live lease is already-claimed before launch", async () => {
		const linear = linearFake([HERMES_ISSUE]);
		const substrate = substrateFake(foundNode(), [graphWith("cursor", "cursor:sess-9", LIVE)]);
		const { deps, spawns } = tickDeps({ linear, substrate });

		const result = await dispatchIssue(HERMES_ISSUE, "hermes", deps);

		expect(result).toEqual({ status: "marked", outcome: "already-claimed" });
		expect(spawns).toEqual([]);
		expect(linear.comments).toEqual([{ issueId: HERMES_ISSUE.id, body: "substrate-dispatch: already-claimed" }]);
		expect(linear.updates).toEqual([]);
		expect(isGivenUp(deps.givenUpDir, HERMES_ISSUE.id)).toBe(false);
		expectVocabularyClosed(substrate.events);
	});

	test("exit without claim persists given-up before commenting and removes only the dispatch label", async () => {
		const linear = linearFake([HERMES_ISSUE]);
		const seen: string[] = [];
		const substrate = substrateFake(foundNode(), [FREE_GRAPH]);
		const { deps } = tickDeps({ linear, substrate, alive: false });
		linear.client.createComment = async (issueId: string, body: string) => {
			seen.push(isGivenUp(deps.givenUpDir, issueId) ? "file-first" : "comment-first");
			void linear.comments.push({ issueId, body });
		};

		const result = await dispatchIssue(HERMES_ISSUE, "hermes", deps);

		expect(result).toEqual({ status: "unclaimed", outcome: "exited-unclaimed" });
		expect(seen).toEqual(["file-first"]);
		expect(linear.comments).toEqual([{ issueId: HERMES_ISSUE.id, body: "substrate-dispatch: exited-unclaimed" }]);
		expect(linear.updates).toEqual([{ id: HERMES_ISSUE.id, input: { removedLabelIds: ["lbl-dispatch"] } }]);
		expectVocabularyClosed(substrate.events);
		const exited = substrate.events[0];
		if (!exited) throw new Error("expected one emitted event");
		expect(exited.payload).toMatchObject({ outcome: "failed", reason: "exited-unclaimed" });
	});

	test("900 s without landing SIGTERMs then SIGKILLs and gives up", async () => {
		const linear = linearFake([HERMES_ISSUE]);
		const substrate = substrateFake(foundNode(), [FREE_GRAPH]);
		const nowRef = { now: NOW };
		const { deps, signals } = tickDeps({
			linear,
			substrate,
			alive: true,
			nowRef,
		});
		deps.pollIntervalMs = 60_000;

		const result = await dispatchIssue(HERMES_ISSUE, "hermes", deps);

		expect(result).toEqual({ status: "unclaimed", outcome: "claim-timeout" });
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(isGivenUp(deps.givenUpDir, HERMES_ISSUE.id)).toBe(true);
		expect(linear.comments).toEqual([{ issueId: HERMES_ISSUE.id, body: "substrate-dispatch: claim-timeout" }]);
		expect(linear.updates).toEqual([{ id: HERMES_ISSUE.id, input: { removedLabelIds: ["lbl-dispatch"] } }]);
		expectVocabularyClosed(substrate.events);
	});

	test("a missing MCP config skips without spawn, comment, or give-up", async () => {
		const linear = linearFake([HERMES_ISSUE]);
		const substrate = substrateFake(foundNode(), [FREE_GRAPH]);
		const { deps, spawns } = tickDeps({ linear, substrate, config: null });

		const result = await dispatchIssue(HERMES_ISSUE, "hermes", deps);

		expect(result).toEqual({ status: "preflight-skip", reason: "mcp-unconfigured" });
		expect(spawns).toEqual([]);
		expect(linear.comments).toEqual([]);
		expect(linear.updates).toEqual([]);
		expect(isGivenUp(deps.givenUpDir, HERMES_ISSUE.id)).toBe(false);
		expectVocabularyClosed(substrate.events);
		const skipped = substrate.events[0];
		if (!skipped) throw new Error("expected one emitted event");
		expect(skipped.payload).toMatchObject({ reason: "mcp-unconfigured" });
	});

	test("an unresolvable issue is no-node with no spawn and no worktree", async () => {
		const linear = linearFake([HERMES_ISSUE]);
		const substrate = substrateFake({ found: false, reason: "no registered node" }, []);
		let worktreeCalls = 0;
		const { deps, spawns } = tickDeps({
			linear,
			substrate,
			worktree: async () => {
				worktreeCalls += 1;
				return { ok: false as const, outcome: "low-disk" as const };
			},
		});

		const result = await dispatchIssue(HERMES_ISSUE, "hermes", deps);

		expect(result).toEqual({ status: "marked", outcome: "no-node" });
		expect(worktreeCalls).toBe(0);
		expect(spawns).toEqual([]);
		expect(linear.comments).toEqual([{ issueId: HERMES_ISSUE.id, body: "substrate-dispatch: no-node" }]);
		expectVocabularyClosed(substrate.events);
	});

	test("a worktree refusal comments its outcome and never spawns", async () => {
		const linear = linearFake([HERMES_ISSUE]);
		const substrate = substrateFake(foundNode(), [FREE_GRAPH]);
		const { deps, spawns } = tickDeps({
			linear,
			substrate,
			worktree: async () => ({ ok: false as const, outcome: "low-disk" as const }),
		});

		const result = await dispatchIssue(HERMES_ISSUE, "hermes", deps);

		expect(result).toEqual({ status: "marked", outcome: "low-disk" });
		expect(spawns).toEqual([]);
		expect(linear.comments).toEqual([{ issueId: HERMES_ISSUE.id, body: "substrate-dispatch: low-disk" }]);
		expectVocabularyClosed(substrate.events);
	});
});

describe("tick boundaries", () => {
	test("given-up issues are skipped silently", async () => {
		const linear = linearFake([HERMES_ISSUE]);
		const substrate = substrateFake(foundNode(), [FREE_GRAPH]);
		const { deps, spawns } = tickDeps({ linear, substrate });
		markGivenUp(deps.givenUpDir, HERMES_ISSUE.id, "claim-timeout");

		const result = await dispatchIssue(HERMES_ISSUE, "hermes", deps);

		expect(result).toEqual({ status: "skipped", reason: "given-up" });
		expect(spawns).toEqual([]);
		expect(linear.comments).toEqual([]);
		expect(substrate.events).toEqual([]);
		expect(substrate.graphCalls).toBe(0);
	});

	test("non-hermes surfaces defer without side effects", async () => {
		const linear = linearFake([HERMES_ISSUE]);
		const substrate = substrateFake(foundNode(), [FREE_GRAPH]);
		const { deps, spawns } = tickDeps({ linear, substrate });

		const result = await dispatchIssue(HERMES_ISSUE, "claude-code", deps);

		expect(result).toEqual({ status: "deferred", surface: "claude-code" });
		expect(spawns).toEqual([]);
		expect(linear.comments).toEqual([]);
		expect(linear.updates).toEqual([]);
		expect(substrate.events).toEqual([]);
	});

	test("runTick marks the non-dispatchable and dispatches hermes", async () => {
		const other: PollIssue = { id: "iss-other", identifier: "ENG-102", labels: [] };
		const linear = linearFake([HERMES_ISSUE, other], { [HERMES_ISSUE.id]: [`noise ${CANARY}`] });
		const substrate = substrateFake(foundNode(), [FREE_GRAPH, graphWith("hermes", SESSION_ID, LIVE)]);
		const { deps } = tickDeps({ linear, substrate });

		const summary = await runTick(deps);

		expect(summary).toHaveLength(2);
		const first = summary[0];
		const second = summary[1];
		if (!first || !second) throw new Error("expected two tick summaries");
		expect(first.result).toEqual({ status: "marked", outcome: "not-dispatchable" });
		expect(second.result).toEqual({ status: "landed" });
		expect(linear.comments).toEqual([{ issueId: "iss-other", body: "substrate-dispatch: not-dispatchable" }]);
		expectVocabularyClosed(substrate.events);
		for (const comment of linear.comments) {
			expect(comment.body).not.toContain(CANARY);
		}
	});
});
