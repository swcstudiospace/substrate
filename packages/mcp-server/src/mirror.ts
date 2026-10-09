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
 * A leaf module: imports only ./types.ts, ./config.ts (type-only) and the
 * ./linear.ts + ./notion.ts clients — never service.ts, index-store.ts or
 * lease.ts.
 */
import type { SubstrateConfig } from "./config.ts";
import {
	firstStartedStateId,
	firstUnstartedStateId,
	inReviewStateId,
	type IssueContext,
	LinearClient,
} from "./linear.ts";
import { buildProperty, NotionClient, notionPageId, type PropertyValue } from "./notion.ts";
import { isSwarmSurface, type Surface } from "./types.ts";

export type MirrorOp = "claim" | "steal" | "release" | "expire" | "force" | "review" | "done" | "close";

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

export class Mirror {
	private readonly linear: LinearClient | null;
	private readonly notion: NotionClient | null;
	/** `graphId/nodeId` → tail of that node's execution chain. */
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
	 * The node's issue state as Linear has it now, or null when Linear is off,
	 * the node has no issue or the read fails. Never throws. Lets completion
	 * tell an issue the connector already moved to Done from one still open.
	 */
	async linearState(ctx: Pick<MirrorContext, "linearRef">): Promise<{ name: string; type: string } | null> {
		if (!this.linear || !ctx.linearRef) return null;
		return this.linear.issueState(ctx.linearRef).catch(() => null);
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
			return { ok: false, reason: `linear read failed: ${reasonOf(cause)}` };
		}
	}

	/** One transition serialized behind earlier transitions for the same node. */
	private async serialized<T>(ctx: MirrorContext, fn: () => Promise<T>): Promise<T> {
		const key = `${ctx.graphId}/${ctx.nodeId}`;
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
			} catch (cause) {
				failures.push({ target: "linear", op, reason: reasonOf(cause) });
			}
		}
		if (this.notion) {
			const failure = await this.notionStep(this.notion, ctx, notionWants(linearOk, linearState));
			if (failure) failures.push({ target: "notion", op, reason: failure });
		}
		return failures;
	}

	/**
	 * One PATCH on the node's Issue row, each value shaped for the type the row
	 * itself reports. At most one failure: unshapable properties are skipped
	 * and named together, and the rest are still sent.
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
			const types = await notion.getPage(pageId);
			const skipped: string[] = [];
			const properties: Record<string, unknown> = {};
			for (const [name, value] of Object.entries(wants)) {
				const type = types[name];
				const shaped = type ? buildProperty(type, value) : null;
				if (shaped) {
					properties[name] = shaped;
				} else {
					skipped.push(
						type
							? `"${name}" on page ${pageId} is a ${type} property, which substrate cannot write`
							: `page ${pageId} has no "${name}" property`,
					);
				}
			}
			if (Object.keys(properties).length > 0) await notion.updatePage(pageId, properties);
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
		if (!issue.comments.includes(body)) await linear.createComment(issue.id, body);
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
}

/** Production wiring: each target only when its API key is configured. */
export function createMirror(config: SubstrateConfig, fetchImpl?: typeof fetch): Mirror {
	return new Mirror({
		linear: config.linearApiKey
			? new LinearClient(config.linearApiKey, { fetchImpl, endpoint: config.linearApiUrl })
			: null,
		notion: config.notionApiKey
			? new NotionClient(config.notionApiKey, {
					dataSourceId: config.notionTaskGraphDataSource,
					fetchImpl,
					baseUrl: config.notionApiUrl,
				})
			: null,
	});
}
