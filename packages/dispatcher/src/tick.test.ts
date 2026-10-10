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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PollIssue, PollingClient } from "./linear-poll.ts";
import type { DispatchEventInput, FindNodeResult, GraphSnapshot } from "./substrate-client.ts";
import { isGivenUp, markGivenUp } from "./watch.ts";
import { dispatchIssue, runTick, type TickDeps, type TickSubstrate } from "./tick.ts";
import type { HermesSpawnOptions } from "./launch-hermes.ts";
import { InvalidGraphIdError, type EnsureWorktreeResult } from "./worktree.ts";

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
	dialClaudeCode?: () => Promise<"host-unreachable" | "host-refused">;
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
	dialClaudeCode:
		overrides.dialClaudeCode ??
		(async () => {
			throw new Error("dialClaudeCode not stubbed: tests never open real sockets");
		}),
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

	test("a live lease on another node of the same graph serializes as already-claimed", async () => {
		const linear = linearFake([HERMES_ISSUE]);
		const busyGraph: GraphSnapshot = {
			graph_id: GRAPH_ID,
			nodes: [
				{ graph_id: GRAPH_ID, node_id: NODE_ID, claimed_by: null, claim_session: null, lease_id: null, lease_expires_at: null },
				{ graph_id: GRAPH_ID, node_id: "n9", claimed_by: "hermes", claim_session: "hermes:other:0", lease_id: null, lease_expires_at: LIVE },
			],
		};
		const substrate = substrateFake(foundNode(), [busyGraph]);
		const { deps, spawns } = tickDeps({ linear, substrate });

		const result = await dispatchIssue(HERMES_ISSUE, "hermes", deps);

		expect(result).toEqual({ status: "marked", outcome: "already-claimed" });
		expect(spawns).toEqual([]);
		expect(linear.comments).toEqual([{ issueId: HERMES_ISSUE.id, body: "substrate-dispatch: already-claimed" }]);
		expect(linear.updates).toEqual([]);
		expect(isGivenUp(deps.givenUpDir, HERMES_ISSUE.id)).toBe(false);
		expectVocabularyClosed(substrate.events);
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

	test("an invalid graph id is marked and does not escape the tick", async () => {
		const linear = linearFake([HERMES_ISSUE]);
		const substrate = substrateFake(foundNode(), [FREE_GRAPH]);
		const { deps, spawns } = tickDeps({
			linear,
			substrate,
			worktree: async () => {
				throw new InvalidGraphIdError("graph_id is not a dispatch id");
			},
		});

		const result = await dispatchIssue(HERMES_ISSUE, "hermes", deps);

		expect(result).toEqual({ status: "marked", outcome: "not-dispatchable" });
		expect(spawns).toEqual([]);
		expect(linear.comments).toEqual([{ issueId: HERMES_ISSUE.id, body: "substrate-dispatch: not-dispatchable" }]);
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

	test("a known non-launcher surface is marked not-dispatchable once and never spawned", async () => {
		const linear = linearFake([HERMES_ISSUE]);
		const substrate = substrateFake(foundNode(), [FREE_GRAPH]);
		const { deps, spawns } = tickDeps({ linear, substrate });

		const first = await dispatchIssue(HERMES_ISSUE, "cursor", deps);
		const second = await dispatchIssue(HERMES_ISSUE, "cursor", deps);

		expect(first).toEqual({ status: "marked", outcome: "not-dispatchable" });
		expect(second).toEqual({ status: "marked", outcome: "not-dispatchable" });
		expect(spawns).toEqual([]);
		expect(linear.comments).toEqual([{ issueId: HERMES_ISSUE.id, body: "substrate-dispatch: not-dispatchable" }]);
		expect(linear.updates).toEqual([]);
		expect(substrate.events).toHaveLength(2);
		expect(substrate.graphCalls).toBe(0);
	});

	test("a disabled kill switch sleeps the pass with no comments", async () => {
		const linear = linearFake([HERMES_ISSUE]);
		const substrate = substrateFake(foundNode(), [FREE_GRAPH]);
		const { deps, spawns } = tickDeps({ linear, substrate });
		deps.dispatchDisabled = () => true;

		const summary = await runTick(deps);

		expect(summary).toEqual([]);
		expect(spawns).toEqual([]);
		expect(linear.comments).toEqual([]);
		expect(substrate.events).toEqual([]);
	});

	test("a missing hermes binary skips like a missing MCP entry", async () => {
		const linear = linearFake([HERMES_ISSUE]);
		const substrate = substrateFake(foundNode(), [FREE_GRAPH]);
		const { deps, spawns } = tickDeps({ linear, substrate });
		deps.hermesPresent = () => false;

		const result = await dispatchIssue(HERMES_ISSUE, "hermes", deps);

		expect(result).toEqual({ status: "preflight-skip", reason: "mcp-unconfigured" });
		expect(spawns).toEqual([]);
		expect(linear.comments).toEqual([]);
		expect(isGivenUp(deps.givenUpDir, HERMES_ISSUE.id)).toBe(false);
	});

	test("a rejected node id marks that issue and the queue continues", async () => {
		const bad: PollIssue = {
			id: "iss-bad-node",
			identifier: "ENG-100",
			labels: [{ id: "lbl-bad", name: "dispatch:hermes" }],
		};
		const linear = linearFake([bad, HERMES_ISSUE]);
		const substrate = substrateFake(foundNode(), [FREE_GRAPH, graphWith("hermes", SESSION_ID, LIVE)]);
		let finds = 0;
		substrate.client.findNode = async () => {
			finds += 1;
			if (finds === 1) return { ...foundNode(), node_id: "n:1" } as FindNodeResult;
			return foundNode();
		};
		const { deps, spawns } = tickDeps({ linear, substrate });

		const summary = await runTick(deps);

		expect(summary).toHaveLength(2);
		expect(summary[0]?.result).toEqual({ status: "marked", outcome: "not-dispatchable" });
		expect(summary[1]?.result).toEqual({ status: "landed" });
		expect(spawns).toHaveLength(1);
		expect(linear.comments).toContainEqual({ issueId: bad.id, body: "substrate-dispatch: not-dispatchable" });
	});

	test("a prompt symlink marks that issue and the queue continues", async () => {
		const bad: PollIssue = {
			id: "iss-symlink",
			identifier: "ENG-099",
			labels: [{ id: "lbl-link", name: "dispatch:hermes" }],
		};
		const linear = linearFake([bad, HERMES_ISSUE]);
		const substrate = substrateFake(foundNode(), [FREE_GRAPH, FREE_GRAPH, graphWith("hermes", SESSION_ID, LIVE)]);
		const { deps, base, spawns } = tickDeps({ linear, substrate });
		const badDir = join(base, "bad-wt");
		const goodDir = join(base, "good-wt");
		mkdirSync(badDir, { recursive: true });
		mkdirSync(goodDir, { recursive: true });
		symlinkSync("/tmp", join(badDir, `substrate-dispatch-${NODE_ID}.md`));
		let trees = 0;
		deps.worktree = async () => ({ ok: true, path: trees++ === 0 ? badDir : goodDir, reused: false });

		const summary = await runTick(deps);

		expect(summary[0]?.result).toEqual({ status: "marked", outcome: "not-dispatchable" });
		expect(summary[1]?.result).toEqual({ status: "landed" });
		expect(spawns).toHaveLength(1);
		expect(linear.comments).toContainEqual({ issueId: bad.id, body: "substrate-dispatch: not-dispatchable" });
	});

	test("runTick marks the non-dispatchable and dispatches hermes", async () => {
		const other: PollIssue = {
			id: "iss-other",
			identifier: "ENG-102",
			labels: [
				{ id: "lbl-a", name: "dispatch:hermes" },
				{ id: "lbl-b", name: "dispatch:claude-code" },
			],
		};
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

	test("runTick ignores issues without a dispatch label: no comment, no event, no summary", async () => {
		const plain: PollIssue = { id: "iss-plain", identifier: "ENG-103", labels: [] };
		const linear = linearFake([HERMES_ISSUE, plain], { [HERMES_ISSUE.id]: [`noise ${CANARY}`] });
		const substrate = substrateFake(foundNode(), [FREE_GRAPH, graphWith("hermes", SESSION_ID, LIVE)]);
		const { deps } = tickDeps({ linear, substrate });

		const summary = await runTick(deps);

		expect(summary).toHaveLength(1);
		expect(summary[0]?.issue.identifier).toBe(HERMES_ISSUE.identifier);
		expect(linear.comments).toEqual([]);
		expect(linear.updates).toEqual([]);
	});
});

describe("claude-code dial", () => {
	const CLAUDE_ISSUE: PollIssue = {
		id: "iss-claude-1",
		identifier: "ENG-201",
		labels: [{ id: "lbl-cc", name: "dispatch:claude-code" }],
	};

	function dialLinear(seeds: Record<string, string[]> = {}): LinearFake {
		const comments: LinearFake["comments"] = [];
		const updates: LinearFake["updates"] = [];
		const client: PollingClient = {
			listUnstartedIssues: async () => ({ nodes: [CLAUDE_ISSUE], pageInfo: { hasNextPage: false, endCursor: null } }),
			graphql: async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
				expect(query).toContain("DispatchMarkerComments");
				const issueId = variables["id"];
				expect(typeof issueId).toBe("string");
				const bodies = [
					...(seeds[issueId as string] ?? []),
					...comments.filter((comment) => comment.issueId === issueId).map((comment) => comment.body),
				];
				return {
					issue: { comments: { nodes: bodies.map((body) => ({ body })), pageInfo: { hasNextPage: false, endCursor: null } } },
				} as unknown as T;
			},
			createComment: async (issueId: string, body: string) => void comments.push({ issueId, body }),
			updateIssue: async (id: string, input: { removedLabelIds?: string[] }) => void updates.push({ id, input }),
		};
		return { client, comments, updates };
	}

	test("a refused dial marks host-unreachable with no give-up, worktree, or spawn", async () => {
		const linear = dialLinear();
		const substrate = substrateFake(foundNode(), []);
		let worktreeCalls = 0;
		const { deps, spawns } = tickDeps({
			linear,
			substrate,
			worktree: async () => {
				worktreeCalls += 1;
				return { ok: false as const, outcome: "low-disk" as const };
			},
			dialClaudeCode: async () => "host-unreachable",
		});

		const result = await dispatchIssue(CLAUDE_ISSUE, "claude-code", deps);

		expect(result).toEqual({ status: "marked", outcome: "host-unreachable" });
		expect(worktreeCalls).toBe(0);
		expect(spawns).toEqual([]);
		expect(linear.comments).toEqual([{ issueId: CLAUDE_ISSUE.id, body: "substrate-dispatch: host-unreachable" }]);
		expect(linear.updates).toEqual([]);
		expect(isGivenUp(deps.givenUpDir, CLAUDE_ISSUE.id)).toBe(false);
		expect(substrate.graphCalls).toBe(0);
		expectVocabularyClosed(substrate.events);
		const marked = substrate.events[0];
		if (!marked) throw new Error("expected one emitted event");
		expect(marked.payload).toMatchObject({ outcome: "failed", reason: "host-unreachable" });
	});

	test("an answered dial marks host-refused and keeps the label", async () => {
		const linear = dialLinear();
		const substrate = substrateFake(foundNode(), []);
		const { deps, spawns } = tickDeps({ linear, substrate, dialClaudeCode: async () => "host-refused" });

		const result = await dispatchIssue(CLAUDE_ISSUE, "claude-code", deps);

		expect(result).toEqual({ status: "marked", outcome: "host-refused" });
		expect(spawns).toEqual([]);
		expect(linear.comments).toEqual([{ issueId: CLAUDE_ISSUE.id, body: "substrate-dispatch: host-refused" }]);
		expect(linear.updates).toEqual([]);
		expect(isGivenUp(deps.givenUpDir, CLAUDE_ISSUE.id)).toBe(false);
		expectVocabularyClosed(substrate.events);
	});

	test("host-unreachable is once-only and never joins the given-up set", async () => {
		const linear = dialLinear({ [CLAUDE_ISSUE.id]: ["substrate-dispatch: host-unreachable"] });
		const substrate = substrateFake(foundNode(), []);
		let dials = 0;
		const { deps } = tickDeps({
			linear,
			substrate,
			dialClaudeCode: async () => {
				dials += 1;
				return "host-unreachable";
			},
		});

		const result = await dispatchIssue(CLAUDE_ISSUE, "claude-code", deps);

		expect(result).toEqual({ status: "marked", outcome: "host-unreachable" });
		expect(dials).toBe(1);
		expect(linear.comments).toEqual([]);
		expect(isGivenUp(deps.givenUpDir, CLAUDE_ISSUE.id)).toBe(false);
	});
});
