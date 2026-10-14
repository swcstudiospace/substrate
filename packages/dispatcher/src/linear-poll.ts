/**
 * Dispatcher Linear poll foundation (DISP-01 / DISP-02).
 *
 * Classification keeps an issue only when exactly one label name starts with
 * `dispatch:` and its suffix is a known surface; anything else is
 * `not-dispatchable`. Once-only marker comments use the exact line
 * `substrate-dispatch: <outcome>` and page comment bodies to the end, never
 * the last-20 window of `issueContext`. Label removal is additive-only via
 * `removedLabelIds` and touches only `dispatch:`-prefixed labels.
 *
 * The client is a structural interface that `LinearClient` satisfies, so
 * tests run against an in-memory fake: no live Linear, no network.
 */

import { SURFACES } from "../../mcp-server/src/types.ts";
import type { LinearClient } from "../../mcp-server/src/linear.ts";

/** Outcome names, verbatim from DISP-02. */
export const DISPATCH_OUTCOMES = [
	"not-dispatchable",
	"no-node",
	"already-claimed",
	"low-disk",
	"no-checkout",
	"path-conflict",
	"git-failed",
	"host-refused",
	"host-unreachable",
	"exited-unclaimed",
	"claim-timeout",
] as const;
export type DispatchOutcome = (typeof DISPATCH_OUTCOMES)[number];

export interface PollLabel {
	id: string;
	name: string;
}

export interface PollIssue {
	id: string;
	identifier: string;
	labels: PollLabel[];
}

export type IssueClassification =
	| { kind: "dispatchable"; surface: string }
	| { kind: "not-dispatchable" }
	| { kind: "ignored" };

/** The Linear surface `LinearClient` exposes to the poll. Satisfied structurally; see `_pollClientContract` below. */
export interface PollingClient {
	listUnstartedIssues(after?: string | null): Promise<{
		nodes: PollIssue[];
		pageInfo: { hasNextPage: boolean; endCursor: string | null };
	}>;
	graphql<T>(query: string, variables: Record<string, unknown>): Promise<T>;
	createComment(issueId: string, body: string): Promise<void>;
	updateIssue(id: string, input: { removedLabelIds?: string[] }): Promise<void>;
}

/** Compile-time pin: the real client must satisfy the poll contract. */
type _PollClientContract = LinearClient extends PollingClient ? true : false;
const _pollClientContract: _PollClientContract = true;
void _pollClientContract;

/** Exact marker line. The body carries the outcome token and nothing else, never issue text. */
export function markerBody(outcome: DispatchOutcome): string {
	return `substrate-dispatch: ${outcome}`;
}

/**
 * Exactly one `dispatch:<surface>` label with a known surface dispatches.
 * One present-but-unknown label, two or more, or a bare `dispatch:` prefix
 * is `not-dispatchable` (DISP-04). An issue with no `dispatch:`-prefixed
 * label at all is `ignored`: unrelated work the dispatcher never comments
 * on, counts, or prints.
 */
export function classifyIssue(issue: PollIssue): IssueClassification {
	const dispatchLabels = issue.labels.filter((label) => label.name.startsWith("dispatch:"));
	if (dispatchLabels.length === 0) return { kind: "ignored" };
	if (dispatchLabels.length !== 1) return { kind: "not-dispatchable" };
	const only = dispatchLabels[0];
	if (!only) return { kind: "not-dispatchable" };
	const suffix = only.name.slice("dispatch:".length);
	if (!(SURFACES as readonly string[]).includes(suffix)) return { kind: "not-dispatchable" };
	return { kind: "dispatchable", surface: suffix };
}

interface CommentPage {
	issue: {
		comments: {
			nodes: Array<{ body: string }>;
			pageInfo: { hasNextPage: boolean; endCursor: string | null };
		};
	} | null;
}

/**
 * True when a comment already carries the exact marker line. Pages to the
 * end of the comment connection: a marker pushed out of any fixed window
 * must still stop a second post.
 */
export async function hasMarkerComment(
	client: PollingClient,
	issueId: string,
	outcome: DispatchOutcome,
): Promise<boolean> {
	const marker = markerBody(outcome);
	let after: string | null = null;
	for (;;) {
		const data: CommentPage = await client.graphql<CommentPage>(
			`query DispatchMarkerComments($id: String!, $after: String) {
				issue(id: $id) {
					comments(first: 50, after: $after) { nodes { body } pageInfo { hasNextPage endCursor } }
				}
			}`,
			{ id: issueId, after },
		);
		const comments = data.issue?.comments;
		if (!comments) return false;
		for (const node of comments.nodes) {
			if (node.body.split("\n").some((line: string) => line.trim() === marker)) return true;
		}
		if (!comments.pageInfo.hasNextPage || comments.pageInfo.endCursor === null) return false;
		after = comments.pageInfo.endCursor;
	}
}

/** Post the outcome marker unless one is already present. Returns what happened. */
export async function ensureMarkerComment(
	client: PollingClient,
	issueId: string,
	outcome: DispatchOutcome,
): Promise<"commented" | "already-marked"> {
	if (await hasMarkerComment(client, issueId, outcome)) return "already-marked";
	await client.createComment(issueId, markerBody(outcome));
	return "commented";
}

/**
 * Remove the issue's `dispatch:` labels additively. Unrelated labels are
 * never named, and no other `updateIssue` field is sent.
 */
export async function removeDispatchLabels(
	client: PollingClient,
	issue: PollIssue,
): Promise<"removed" | "nothing-to-remove"> {
	const ids = issue.labels.filter((label) => label.name.startsWith("dispatch:")).map((label) => label.id);
	if (ids.length === 0) return "nothing-to-remove";
	await client.updateIssue(issue.id, { removedLabelIds: ids });
	return "removed";
}

export interface CollectedCandidates {
	dispatchable: Array<{ issue: PollIssue; surface: string }>;
	notDispatchable: PollIssue[];
	/** Unrelated issues: no `dispatch:` label, never commented or counted. */
	ignored: PollIssue[];
}

/** Page the unstarted-issue list to the end and split by classification. */
export async function collectCandidates(client: PollingClient): Promise<CollectedCandidates> {
	const collected: CollectedCandidates = { dispatchable: [], notDispatchable: [], ignored: [] };
	let after: string | null = null;
	for (;;) {
		const page = await client.listUnstartedIssues(after);
		for (const node of page.nodes) {
			const classification = classifyIssue(node);
			if (classification.kind === "dispatchable") {
				collected.dispatchable.push({ issue: node, surface: classification.surface });
			} else if (classification.kind === "ignored") {
				collected.ignored.push(node);
			} else {
				collected.notDispatchable.push(node);
			}
		}
		if (!page.pageInfo.hasNextPage || page.pageInfo.endCursor === null) break;
		after = page.pageInfo.endCursor;
	}
	return collected;
}
