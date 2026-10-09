/**
 * Dispatcher tick (DISP-04, DISP-05, DISP-06, DISP-07).
 *
 * One pass over Linear candidates for the Hermes surface: skip the
 * given-up, resolve the issue to a node (`graph_find`), refuse a live
 * lease held before launch (`already-claimed`), preflight the Hermes MCP
 * config, ensure the verified worktree, spawn headless Hermes over an
 * ids-only prompt, and watch `graph_get` for the triple-condition landing.
 *
 * Non-hermes dispatchable surfaces defer silently: `dispatch:claude-code`
 * routing belongs to plan 24-04, and nothing here may claim, comment, or
 * label on its behalf. Landed launches leave tracker labels alone — the
 * Mirror swaps `dispatch:*` for `agent:hermes` when the Hermes token's
 * claim stands. Unclaimed endings (exit, 900 s) persist given-up first via
 * the watch, then comment and remove only the dispatch label.
 *
 * Every event is vocabulary-closed: kinds `note`/`warning`, surface
 * `substrate`, `action: "dispatch"`, `runtime: "dispatcher"`, summaries
 * naming graph ids and outcome tokens — never issue text.
 */

import type { PollIssue, PollingClient } from "./linear-poll.ts";
import { collectCandidates, ensureMarkerComment, removeDispatchLabels, type DispatchOutcome } from "./linear-poll.ts";
import type { DispatchEventInput, FindNodeResult, GraphSnapshot, SubstrateClient } from "./substrate-client.ts";
import {
	buildChildEnv,
	buildSessionId,
	checkSubstrateMcp,
	launchHermes,
	writePromptFile,
	type SpawnFn,
} from "./launch-hermes.ts";
import { isGivenUp, isLiveLease, watchClaim, type GivenUpOutcome, type WatchedNode } from "./watch.ts";
import type { EnsureWorktreeResult } from "./worktree.ts";

/** The substrate surface tick talks to. `SubstrateClient` satisfies it. */
export interface TickSubstrate {
	findNode(ref: { linear_issue_id: string; linear_identifier: string }): Promise<FindNodeResult>;
	getGraph(graph_id: string): Promise<GraphSnapshot | null>;
	emitEvent(event: DispatchEventInput): Promise<void>;
}

type _TickSubstrateContract = SubstrateClient extends TickSubstrate ? true : false;
const _tickSubstrateContract: _TickSubstrateContract = true;
void _tickSubstrateContract;

/** `dispatch:<graph-or-identifier>:0`: the tick's own session namespace. */
export function tickSessionId(key: string): string {
	return `dispatch:${key}:0`;
}

/** Success event: the Hermes session landed its claim. */
export function launchedEvent(graphId: string, nodeId: string): DispatchEventInput {
	return {
		kind: "note",
		summary: `dispatched ${graphId}: launched`,
		session_id: tickSessionId(graphId),
		graph_id: graphId,
		node_id: nodeId,
		payload: { action: "dispatch", runtime: "dispatcher", outcome: "launched", graph_id: graphId },
	};
}

/**
 * Failure event. `key` is the graph id when resolution succeeded, else the
 * Linear identifier — either way an id, never issue text.
 */
export function failedEvent(key: string, reason: string, nodeId?: string): DispatchEventInput {
	return {
		kind: "warning",
		summary: `dispatch failed for ${key}: ${reason}`,
		session_id: tickSessionId(key),
		graph_id: key,
		...(nodeId === undefined ? {} : { node_id: nodeId }),
		payload: { action: "dispatch", runtime: "dispatcher", outcome: "failed", reason, graph_id: key },
	};
}

export interface TickDeps {
	linear: PollingClient;
	substrate: TickSubstrate;
	/** Injected root: tmp in tests, never `/var/lib/substrate` here. */
	givenUpDir: string;
	/** Bound worktree gate (statfs and git stay behind this seam). */
	worktree: (input: { graphId: string; repo: string | null }) => Promise<EnsureWorktreeResult>;
	/** Raw `~/.hermes/config.yaml` text, or null when unreadable. */
	readHermesConfig: () => string | null | Promise<string | null>;
	/** Injected spawner: the real `hermes` binary is never executed here. */
	spawn: SpawnFn;
	/** Dispatcher process env source for the child allowlist. */
	childEnvSource: Record<string, string | undefined>;
	substrateUrl: string;
	hermesToken: string;
	isAlive: (pid: number) => boolean;
	/** Group kill on watch timeout. */
	signalProcess: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
	sleep: (ms: number) => Promise<void>;
	now?: () => number;
	pollIntervalMs?: number;
}

export type DispatchIssueResult =
	| { status: "skipped"; reason: "given-up" }
	| { status: "deferred"; surface: string }
	| { status: "marked"; outcome: DispatchOutcome }
	| { status: "preflight-skip"; reason: "mcp-unconfigured" }
	| { status: "landed" }
	| { status: "unclaimed"; outcome: GivenUpOutcome };

/**
 * Dispatch one dispatchable issue. Reports unclaimed endings through the
 * watch's `onUnclaimed`, which runs only after the given-up file write.
 */
export async function dispatchIssue(
	issue: PollIssue,
	surface: string,
	deps: TickDeps,
): Promise<DispatchIssueResult> {
	if (isGivenUp(deps.givenUpDir, issue.id)) return { status: "skipped", reason: "given-up" };
	if (surface !== "hermes") return { status: "deferred", surface };

	const resolved = await deps.substrate.findNode({
		linear_issue_id: issue.id,
		linear_identifier: issue.identifier,
	});
	if (!resolved.found) {
		await ensureMarkerComment(deps.linear, issue.id, "no-node");
		await deps.substrate.emitEvent(failedEvent(issue.identifier, "no-node"));
		return { status: "marked", outcome: "no-node" };
	}
	const { graph_id: graphId, node_id: nodeId, repo } = resolved;
	const sessionId = buildSessionId(graphId, nodeId);
	const nowMs = (deps.now ?? Date.now)();

	const preGraph = await deps.substrate.getGraph(graphId);
	const preNode: WatchedNode | null =
		preGraph?.nodes.find((node) => node.node_id === nodeId) ?? null;
	if (preNode !== null && isLiveLease(preNode, nowMs)) {
		await ensureMarkerComment(deps.linear, issue.id, "already-claimed");
		await deps.substrate.emitEvent(failedEvent(graphId, "already-claimed", nodeId));
		return { status: "marked", outcome: "already-claimed" };
	}

	if (checkSubstrateMcp(await deps.readHermesConfig()) !== "ok") {
		await deps.substrate.emitEvent(failedEvent(graphId, "mcp-unconfigured", nodeId));
		return { status: "preflight-skip", reason: "mcp-unconfigured" };
	}

	const worktree = await deps.worktree({ graphId, repo });
	if (!worktree.ok) {
		await ensureMarkerComment(deps.linear, issue.id, worktree.outcome);
		await deps.substrate.emitEvent(failedEvent(graphId, worktree.outcome, nodeId));
		return { status: "marked", outcome: worktree.outcome };
	}

	const promptPath = writePromptFile(worktree.path, { graphId, nodeId, sessionId });
	const child = await launchHermes(
		{
			worktreePath: worktree.path,
			promptPath,
			env: buildChildEnv(deps.childEnvSource, { substrateUrl: deps.substrateUrl, hermesToken: deps.hermesToken }),
		},
		{ spawn: deps.spawn },
	);

	const watched = await watchClaim(
		{ childPid: child.pid, sessionId, issueId: issue.id, givenUpDir: deps.givenUpDir },
		{
			getNode: async () => {
				const graph = await deps.substrate.getGraph(graphId);
				return graph?.nodes.find((node) => node.node_id === nodeId) ?? null;
			},
			isAlive: () => deps.isAlive(child.pid),
			signal: (pid, signal) => deps.signalProcess(pid, signal),
			sleep: deps.sleep,
			now: deps.now,
			pollIntervalMs: deps.pollIntervalMs,
			onUnclaimed: async (outcome) => {
				await ensureMarkerComment(deps.linear, issue.id, outcome);
				await removeDispatchLabels(deps.linear, issue);
				await deps.substrate.emitEvent(failedEvent(graphId, outcome, nodeId));
			},
		},
	);
	if (watched.status === "landed") {
		await deps.substrate.emitEvent(launchedEvent(graphId, nodeId));
		return { status: "landed" };
	}
	return { status: "unclaimed", outcome: watched.status };
}

export interface TickIssueSummary {
	issue: PollIssue;
	surface: string | null;
	result: DispatchIssueResult;
}

/** One full pass: poll, mark the non-dispatchable, dispatch the Hermes set. */
export async function runTick(deps: TickDeps): Promise<TickIssueSummary[]> {
	const { dispatchable, notDispatchable } = await collectCandidates(deps.linear);
	const summary: TickIssueSummary[] = [];
	for (const issue of notDispatchable) {
		await ensureMarkerComment(deps.linear, issue.id, "not-dispatchable");
		await deps.substrate.emitEvent(failedEvent(issue.identifier, "not-dispatchable"));
		summary.push({ issue, surface: null, result: { status: "marked", outcome: "not-dispatchable" } });
	}
	for (const { issue, surface } of dispatchable) {
		summary.push({ issue, surface, result: await dispatchIssue(issue, surface, deps) });
	}
	return summary;
}
