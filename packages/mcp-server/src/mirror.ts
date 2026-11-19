/**
 * The claim mirror (MIRROR-02/03/05): a told-not-deciding writer that turns
 *main's final lease decisions into Linear state/label/comment writes and
 * Notion Agent/Linear-State writes.
 *
 * The mirror never decides ownership and never throws: every tracker failure
 * comes back as a MirrorFailure for service.ts to record as one `mirror.failed`
 * warning per failed target. A failure never rolls a lease back. Calls for one
 * node serialize through an in-process per-graph_id/node_id chain so a
 * release's mirror cannot overtake its claim's.
 *
 * Swarm holders (D23-03) get exactly one Linear comment per transition and
 * nothing else — no state change, no label calls, no Notion request.
 *
 * The mirror never sees a lease id (D23-04): MirrorContext carries scalar refs
 * only, and comments carry surface, session, graph and node.
 *
 * A leaf module: imports only ./types.ts, ./config.ts (type-only), ./redact.ts
 * and the ./linear.ts + ./notion.ts clients — never service.ts, index-store.ts
 * or lease.ts.
 */
import type { SubstrateConfig } from "./config.ts";
import {
	firstStartedStateId,
	firstUnstartedStateId,
	inReviewStateId,
	type IssueContext,
	LinearClient,
} from "./linear.ts";
import { NotionClient, notionPageId, type PropertyValue } from "./notion.ts";
import { redact } from "./redact.ts";
import { type EdgeKind, isSwarmSurface, type Surface } from "./types.ts";

export type MirrorOp = "claim" | "steal" | "release" | "expire" | "force" | "review" | "done" | "close";

/** A target that wrote cleanly for one op. Reported through `MirrorContext.report`, so the node's evidence shows each step that landed. */
export interface MirrorSuccess {
	target: "linear" | "notion";
	op: MirrorOp;
}

export interface MirrorContext {
	graphId: string;
	nodeId: string;
	/** New holder for claim/steal, departing holder for release/expire/force, completing holder for review/done/close. */
	holder: Surface;
	sessionId: string;
	/** The previous holder a steal takes the node from. */
	evictedHolder?: Surface;
	epoch: number;
	/** `linear_issue_id ?? linear_identifier`; null when the node has no Linear reference. */
	linearRef: string | null;
	notionPage: string | null;
	/** Told each target that wrote cleanly. Optional: a caller that does not need outcomes passes nothing. */
	report?: (success: MirrorSuccess) => void;
}

export interface MirrorFailure {
	target: "linear" | "notion";
	op: MirrorOp;
	reason: string;
}

const REASON_LIMIT = 300;

function reasonOf(cause: unknown): string {
	const message = cause instanceof Error ? cause.message : String(cause);
	return message.slice(0, REASON_LIMIT);
}

/** The exact-text comment body for one transition; idempotent by exact match. */
export function transitionComment(
	op: "claim" | "steal" | "release" | "expire" | "force" | "done" | "close",
	ctx: Pick<MirrorContext, "holder" | "sessionId" | "graphId" | "nodeId">,
): string {
	const where = `session ${ctx.sessionId} (graph ${ctx.graphId}, node ${ctx.nodeId})`;
	switch (op) {
		case "claim":
		case "steal":
			return `Claimed by ${ctx.holder} — ${where}`;
		case "release":
			return `Released by ${ctx.holder} — ${where}`;
		case "expire":
			return `Lease expired for ${ctx.holder} — ${where}`;
		case "force":
			return `Lease forced off ${ctx.holder} — ${where}`;
		case "done":
		case "close":
			return `Completed by ${ctx.holder} — ${where}`;
	}
}

/**
 * The Linear step of one transition. Returns the name of the Linear state just
 * set, or null when the transition sets no state (close/done) — the Notion
 * `Linear State` mirrors what substrate just set, so it is written only when a
 * state was set.
 */
type LinearStep = (linear: LinearClient) => Promise<string | null>;

/** The Notion values one transition wants, given its Linear outcome. */
type NotionWants = (linearOk: boolean, linearState: string | null) => Record<string, PropertyValue>;

function stateNameById(issue: IssueContext, stateId: string): string {
	return issue.team.states.find((s) => s.id === stateId)?.name ?? stateId;
}

/** One graph edge to mirror, read from the waiting node's side: `waitingNode` cannot proceed until `blockerNode` completes. */
export interface EdgeRelation {
	kind: EdgeKind;
	waitingNode: string;
	waitingRef: string | null;
	blockerNode: string;
	blockerRef: string | null;
}

/** The Linear relation a `created` edge wrote, and the issues it joins: what a later removal of the edge needs. */
export interface WrittenRelation {
	id: string;
	blockerIssueId: string;
	waitingIssueId: string;
}

/** What one edge did. `skipped` means a side has no tracker issue, so nothing was asked of Linear. */
export interface EdgeOutcome extends EdgeRelation {
	status: "created" | "existing" | "skipped" | "failed";
	reason?: string;
	relation?: WrittenRelation;
}

/**
 * A Linear relation this mirror created, as the ledger records it: the `created` outcome of an edge between two
 * graph nodes. Only such a relation may ever be deleted; one a person made is never recorded, so never owned.
 */
export interface OwnedRelation extends WrittenRelation {
	kind: EdgeKind;
	blockerNode: string;
	waitingNode: string;
	blockerRef: string | null;
	waitingRef: string | null;
}

/** What a removal did. `kept` means another edge still holds the relation, so nothing was deleted. */
export interface UnrelateOutcome {
	status: "deleted" | "kept" | "skipped" | "failed";
	reason?: string;
}

/** The owned relations a graph's ledger still holds: a relation is owned from its `ok` create until its `ok` delete. */
export function ownedRelations(events: ReadonlyArray<{ payload?: Record<string, unknown> }>): OwnedRelation[] {
	const owned = new Map<string, OwnedRelation>();
	for (const { payload } of events) {
		if (payload?.action !== "mirror" || payload.target !== "linear") continue;
		const pair = `${String(payload.blocker_node)}>${String(payload.waiting_node)}`;
		if (payload.op === "relate" && payload.status === "ok" && typeof payload.relation_id === "string") {
			owned.set(pair, {
				id: payload.relation_id,
				blockerIssueId: String(payload.blocker_issue_id),
				waitingIssueId: String(payload.waiting_issue_id),
				kind: payload.edge_kind as EdgeKind,
				blockerNode: String(payload.blocker_node),
				waitingNode: String(payload.waiting_node),
				blockerRef: typeof payload.blocker_ref === "string" ? payload.blocker_ref : null,
				waitingRef: typeof payload.waiting_ref === "string" ? payload.waiting_ref : null,
			});
		} else if (payload.op === "unrelate" && payload.status === "ok") {
			owned.delete(pair);
		}
	}
	return [...owned.values()];
}

export class Mirror {
	private readonly linear: LinearClient | null;
	private readonly notion: NotionClient | null;
	/** Serialisation key (`graphId/nodeId`, or a relation pair) → tail of its chain. */
	private readonly chains = new Map<string, Promise<void>>();

	constructor(targets: { linear: LinearClient | null; notion?: NotionClient | null }) {
		this.linear = targets.linear;
		this.notion = targets.notion ?? null;
	}

	/** The startup log line's body, so a missing key shows once at boot rather than as a warning per claim. */
	describe(): string {
		return `linear ${this.linear ? "on" : "off"}, notion ${this.notion ? "on" : "off"}`;
	}

	/**
	 * Granted/reclaimed: first started state, `agent:<holder>` added, every
	 * `dispatch:*` and every other `agent:*` removed — one issueUpdate — then
	 * the exact-text claim comment (skipped when identical among the last 20).
	 * Notion sets Agent and Linear State. Never throws.
	 */
	claim(ctx: MirrorContext): Promise<MirrorFailure[]> {
		return this.serialized(ctx, () => {
			if (isSwarmSurface(ctx.holder)) return this.swarmOnly(ctx, "claim");
			return this.run(ctx, "claim", (linear) => this.claimLinear(linear, ctx), (linearOk, state) => ({
				Agent: ctx.holder,
				...(linearOk && state ? { "Linear State": state } : {}),
			}));
		});
	}

	/**
	 * Stolen: the same as a claim for the new holder, with `agent:<evicted>`
	 * removed and `agent:<new>` added in that single update plus the new
	 * session's own claim comment. Never throws.
	 */
	steal(ctx: MirrorContext): Promise<MirrorFailure[]> {
		return this.serialized(ctx, () => {
			if (isSwarmSurface(ctx.holder)) return this.swarmOnly(ctx, "steal");
			return this.run(ctx, "steal", (linear) => this.claimLinear(linear, ctx), (linearOk, state) => ({
				Agent: ctx.holder,
				...(linearOk && state ? { "Linear State": state } : {}),
			}));
		});
	}

	/** Released: first unstarted state, every `agent:*` removed — one issueUpdate, no comment. Never throws. */
	release(ctx: MirrorContext): Promise<MirrorFailure[]> {
		return this.serialized(ctx, () => {
			if (isSwarmSurface(ctx.holder)) return this.swarmOnly(ctx, "release");
			return this.run(ctx, "release", (linear) => this.clearLinear(linear, ctx), (linearOk, state) => ({
				Agent: null,
				...(linearOk && state ? { "Linear State": state } : {}),
			}));
		});
	}

	/** Expired: the same tracker effect as a release. Never throws. */
	expire(ctx: MirrorContext): Promise<MirrorFailure[]> {
		return this.serialized(ctx, () => {
			if (isSwarmSurface(ctx.holder)) return this.swarmOnly(ctx, "expire");
			return this.run(ctx, "expire", (linear) => this.clearLinear(linear, ctx), (linearOk, state) => ({
				Agent: null,
				...(linearOk && state ? { "Linear State": state } : {}),
			}));
		});
	}

	/** Forced: the same tracker effect as a release. Never throws. */
	force(ctx: MirrorContext): Promise<MirrorFailure[]> {
		return this.serialized(ctx, () => {
			if (isSwarmSurface(ctx.holder)) return this.swarmOnly(ctx, "force");
			return this.run(ctx, "force", (linear) => this.clearLinear(linear, ctx), (linearOk, state) => ({
				Agent: null,
				...(linearOk && state ? { "Linear State": state } : {}),
			}));
		});
	}

	/** To In Review on Linear, ahead of the connector's DoD gate. Never throws. */
	review(ctx: MirrorContext): Promise<MirrorFailure[]> {
		return this.serialized(ctx, () =>
			this.run(
				ctx,
				"review",
				async (linear) => {
					const issue = await this.linearIssue(linear, ctx);
					const stateId = inReviewStateId(issue);
					await linear.updateIssue(issue.id, { stateId });
					return stateNameById(issue, stateId);
				},
				(linearOk, state) => {
					const wants: Record<string, PropertyValue> = {};
					if (linearOk && state) wants["Linear State"] = state;
					return wants;
				},
			),
		);
	}

	/**
	 * After the connector's gate has moved the issue to Done. Linear needs no
	 * call — the connector already made it — so this records completion on the
	 * Notion row: Status, Linear State and Completed only. Never throws.
	 */
	done(ctx: MirrorContext): Promise<MirrorFailure[]> {
		return this.serialized(ctx, () => {
			if (isSwarmSurface(ctx.holder)) return this.swarmOnly(ctx, "done");
			return this.run(ctx, "done", null, () => ({
				Status: "Done",
				"Linear State": "Done",
				Completed: new Date().toISOString().slice(0, 10),
			}));
		});
	}

	/**
	 * Forced or other-state completion: `agent:*` removed and Notion Agent
	 * cleared, Linear's state left alone — only the connector ever moves an
	 * issue to Done. Never throws.
	 */
	close(ctx: MirrorContext): Promise<MirrorFailure[]> {
		return this.serialized(ctx, () => {
			if (isSwarmSurface(ctx.holder)) return this.swarmOnly(ctx, "close");
			return this.run(
				ctx,
				"close",
				async (linear) => {
					const issue = await this.linearIssue(linear, ctx);
					await linear.updateIssue(issue.id, {
						removedLabelIds: issue.labels.filter((l) => l.name.startsWith("agent:")).map((l) => l.id),
					});
					return null;
				},
			() => ({ Agent: null }),
			);
		});
	}

	/**
	 * The node's issue state as Linear has it now, or null when Linear is off
	 * or the node has no issue. A failed read throws rather than returning
	 * null: the DoD gate must tell "could not read" apart from "still open",
	 * so it never mirrors In Review onto an issue the connector may already
	 * have moved to Done. Its only reader is the gate, which refuses as
	 * unavailable on a throw.
	 */
	async linearState(ctx: Pick<MirrorContext, "linearRef">): Promise<{ name: string; type: string } | null> {
		if (!this.linear || !ctx.linearRef) return null;
		return this.linear.issueState(ctx.linearRef);
	}

	/**
	 * The node's Linear issue text for issue_get, or why it is unavailable.
	 * Never throws; a failure carries the error message only, never headers or
	 * the request.
	 */
	async issueText(
		node: Pick<MirrorContext, "linearRef">,
	): Promise<{ ok: true; identifier: string; title: string; description: string | null } | { ok: false; reason: string }> {
		if (!this.linear) return { ok: false, reason: "linear mirror off" };
		if (!node.linearRef) return { ok: false, reason: "node has no Linear issue reference" };
		try {
			return { ok: true, ...(await this.linear.issueText(node.linearRef)) };
		} catch (cause) {
			// Upstream text is untrusted and may carry a credential-shaped
			// fragment (a password-bearing URL in a GraphQL error, say), so the
			// reason MCP forwards is redacted before it is capped.
			return { ok: false, reason: `linear read failed: ${redact(reasonOf(cause))}` };
		}
	}


	/** One transition serialized behind earlier transitions for the same node. */
	private async serialized<T>(ctx: MirrorContext, fn: () => Promise<T>): Promise<T> {
		return this.exclusive(`${ctx.graphId}/${ctx.nodeId}`, fn);
	}

	/**
	 * Run `fn` once every earlier call holding `key` has settled. Serialisation is in-process only: two substrate
	 * processes sharing one Linear workspace are not serialised by this.
	 */
	private async exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.chains.get(key) ?? Promise.resolve();
		const { promise: gate, resolve: done } = Promise.withResolvers<void>();
		const tail = prev.then(() => gate);
		this.chains.set(key, tail);
		await prev;
		try {
			return await fn();
		} finally {
			done();
			if (this.chains.get(key) === tail) this.chains.delete(key);
		}
	}

	/** Swarm exception: exactly one comment, and nothing else. */
	private async swarmOnly(
		ctx: MirrorContext,
		op: "claim" | "steal" | "release" | "expire" | "force" | "done" | "close",
	): Promise<MirrorFailure[]> {
		if (!this.linear || !ctx.linearRef) return [];
		try {
			const issue = await this.linearIssue(this.linear, ctx);
			const body = transitionComment(op, ctx);
			if (!issue.comments.includes(body)) await this.linear.createComment(issue.id, body);
			ctx.report?.({ target: "linear", op });
			return [];
		} catch (cause) {
			return [{ target: "linear", op, reason: reasonOf(cause) }];
		}
	}

	private async run(
		ctx: MirrorContext,
		op: MirrorOp,
		linearStep: LinearStep | null,
		notionWants: NotionWants,
	): Promise<MirrorFailure[]> {
		const failures: MirrorFailure[] = [];
		let linearOk = false;
		let linearState: string | null = null;
		if (this.linear && linearStep && ctx.linearRef) {
			try {
				linearState = await linearStep(this.linear);
				linearOk = true;
				ctx.report?.({ target: "linear", op });
			} catch (cause) {
				if (cause instanceof ClaimCommentFailed) {
					// The state move landed and only the courtesy comment did
					// not: Notion must still show the state Linear now has,
					// with the comment failure kept as its own warning.
					linearState = cause.state;
					linearOk = true;
					failures.push({ target: "linear", op, reason: `comment failed: ${reasonOf(cause.cause)}` });
				} else {
					failures.push({ target: "linear", op, reason: reasonOf(cause) });
				}
			}
		}
		if (this.notion) {
			const wants = notionWants(linearOk, linearState);
			const failure = await this.notionStep(this.notion, ctx, wants);
			if (failure) failures.push({ target: "notion", op, reason: failure });
			else if (ctx.notionPage && Object.keys(wants).length > 0) ctx.report?.({ target: "notion", op });
		}
		return failures;
	}

	/**
	 * One shaped write on the node's Issue row: a single GET for the row's
	 * own property types, then one PATCH. At most one failure: unshapable
	 * properties are skipped and named together, and the rest are still sent.
	 */
	private async notionStep(
		notion: NotionClient,
		ctx: MirrorContext,
		wants: Record<string, PropertyValue>,
	): Promise<string | null> {
		if (Object.keys(wants).length === 0 || !ctx.notionPage) return null;
		const pageId = notionPageId(ctx.notionPage);
		if (!pageId) return `notion_page holds no Notion page id: ${ctx.notionPage.slice(0, 100)}`;

		try {
			const skipped = await notion.writeShaped(pageId, wants);
			return skipped.length ? skipped.join("; ").slice(0, REASON_LIMIT) : null;
		} catch (cause) {
			return reasonOf(cause);
		}
	}

	/** The issue behind a node; every Linear transition starts here. */
	private async linearIssue(linear: LinearClient, ctx: MirrorContext): Promise<IssueContext> {
		if (!ctx.linearRef) throw new Error("node has no Linear issue reference");
		return linear.issueContext(ctx.linearRef);
	}

	/**
	 * First started state (by type through the issue's own team),
	 * `agent:<holder>` added, every `dispatch:*` and every other `agent:*`
	 * removed — one issueUpdate — then the exact-text claim comment, skipped
	 * when an identical body is among the issue's last 20 comments. Returns the
	 * name of the state just set.
	 */
	private async claimLinear(linear: LinearClient, ctx: MirrorContext): Promise<string> {
		const issue = await this.linearIssue(linear, ctx);
		const stateId = firstStartedStateId(issue);
		const agentLabelId = await linear.ensureLabel(issue.team.id, `agent:${ctx.holder}`);
		const removedLabelIds = issue.labels
			.filter((l) => l.name.startsWith("dispatch:") || (l.name.startsWith("agent:") && l.name !== `agent:${ctx.holder}`))
			.map((l) => l.id);
		await linear.updateIssue(issue.id, { stateId, addedLabelIds: [agentLabelId], removedLabelIds });
		const body = transitionComment(ctx.evictedHolder ? "steal" : "claim", ctx);
		if (!issue.comments.includes(body)) {
			try {
				await linear.createComment(issue.id, body);
			} catch (cause) {
				throw new ClaimCommentFailed(stateNameById(issue, stateId), cause);
			}
		}
		return stateNameById(issue, stateId);
	}

	/** First unstarted state and every `agent:*` removed — one issueUpdate, no comment. */
	private async clearLinear(linear: LinearClient, ctx: MirrorContext): Promise<string> {
		const issue = await this.linearIssue(linear, ctx);
		const stateId = firstUnstartedStateId(issue);
		await linear.updateIssue(issue.id, {
			stateId,
			removedLabelIds: issue.labels.filter((l) => l.name.startsWith("agent:")).map((l) => l.id),
		});
		return stateNameById(issue, stateId);
	}

	/**
	 * Graph edges into Linear `blocks` relations. The blocking issue is the source, so the waiting issue is
	 * blocked by it. A relation that already exists in that direction is read, not written again. An edge with no
	 * tracker issue on either side is skipped. Each edge stands alone: a failure on one never stops the rest.
	 * Never throws.
	 *
	 * The check and the create run under a lock keyed by the issue pair's UUIDs. Two registrations racing on one new
	 * edge would otherwise both read the blocker before either writes, and both create, leaving Linear a duplicate.
	 * The blocker is read again inside the lock, after any write that raced it has landed.
	 */
	async relateEdges(edges: EdgeRelation[]): Promise<EdgeOutcome[]> {
		const outcomes: EdgeOutcome[] = [];
		for (const edge of edges) {
			const linear = this.linear;
			const blockerRef = edge.blockerRef;
			const waitingRef = edge.waitingRef;
			if (!linear || !blockerRef || !waitingRef) {
				outcomes.push({ ...edge, status: "skipped" });
				continue;
			}
			try {
				const blockerId = (await linear.issueRelations(blockerRef)).id;
				const waitingId = (await linear.issueRelations(waitingRef)).id;
				const outcome = await this.exclusive(`relation:${blockerId}>${waitingId}`, async (): Promise<EdgeOutcome> => {
					const blocker = await linear.issueRelations(blockerRef);
					if (blocker.relations.some((relation) => relation.type === "blocks" && relation.relatedIssueId === waitingId)) {
						return { ...edge, status: "existing" };
					}
					const id = await linear.createIssueRelation(blocker.id, waitingId, "blocks");
					return { ...edge, status: "created", relation: { id, blockerIssueId: blocker.id, waitingIssueId: waitingId } };
				});
				outcomes.push(outcome);
			} catch (cause) {
				const reason = redact(cause instanceof Error ? cause.message : String(cause)).slice(0, 300);
				outcomes.push({ ...edge, status: "failed", reason });
			}
		}
		return outcomes;
	}

	/**
	 * Delete a relation this mirror created, when the edge it stood for has left the graph. Runs under the same lock
	 * as the create, and asks `stillWanted` inside that lock, so a racing registration that re-adds the edge either
	 * lands first (and the relation is kept) or waits and creates it again. Never throws.
	 */
	async unrelate(owned: OwnedRelation, stillWanted: () => Promise<boolean>): Promise<UnrelateOutcome> {
		const linear = this.linear;
		if (!linear) return { status: "skipped" };
		try {
			return await this.exclusive(`relation:${owned.blockerIssueId}>${owned.waitingIssueId}`, async (): Promise<UnrelateOutcome> => {
				if (await stillWanted()) return { status: "kept" };
				await linear.deleteIssueRelation(owned.id);
				return { status: "deleted" };
			});
		} catch (cause) {
			const reason = redact(cause instanceof Error ? cause.message : String(cause)).slice(0, 300);
			return { status: "failed", reason };
		}
	}
}
	/**
	 * The claim comment did not land, but the state move it followed did.
	 * Carries the state name `run` must still mirror to Notion so a failed
	 * courtesy comment never hides a state Linear already has.
	 */

class ClaimCommentFailed extends Error {
	readonly state: string;
	override readonly cause: unknown;
	constructor(state: string, cause: unknown) {
		super(`claim comment failed after the state move to ${state}`);
		this.state = state;
		this.cause = cause;
	}
}

/** Production wiring: each target only when its API key is configured. */
export function createMirror(config: SubstrateConfig, fetchImpl?: typeof fetch): Mirror {
	const fetchOption = fetchImpl === undefined ? {} : { fetchImpl };
	return new Mirror({
		linear: config.linearApiKey
			? new LinearClient(config.linearApiKey, { ...fetchOption, endpoint: config.linearApiUrl })
			: null,
		notion: config.notionApiKey
			? new NotionClient(config.notionApiKey, {
					dataSourceId: config.notionTaskGraphDataSource,
					...fetchOption,
					baseUrl: config.notionApiUrl,
				})
			: null,
	});
}
