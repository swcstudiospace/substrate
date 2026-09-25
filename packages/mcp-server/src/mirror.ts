/**
 * Mirrors node transitions — claim, release, review, done — out to the
 * trackers that show them to humans.
 *
 * The index is the source of truth and has already changed by the time the
 * mirror runs. The mirror never throws: every tracker failure comes back as a
 * MirrorFailure for the caller to record as a warning event (D-02). A target
 * with no credential is disabled, which is not a failure.
 *
 * Done is deliberately absent from the Linear side: only hermes-linear-
 * connector's DoD gate moves an issue to Done (D-06), so this module never
 * resolves a Done state id.
 *
 * Each transition runs the Linear step first, then one Notion PATCH on the
 * node's Issue row. Notion's `Linear State` mirrors what substrate just set on
 * Linear, so it is written only when that Linear step ran and succeeded —
 * except on done, where the connector has already moved Linear to Done. The
 * Notion side writes only Agent, Status, Linear State and Completed; the PR
 * fields belong to ultrathink-sync (D-07).
 */
import type { SubstrateConfig } from "./config.ts";
import { type IssueContext, LinearClient, stateIdByName } from "./linear.ts";
import { buildProperty, NotionClient, notionPageId, type PropertyValue } from "./notion.ts";
import type { GraphNode, Surface } from "./types.ts";

export interface MirrorContext {
	graphId: string;
	nodeId: string;
	surface: Surface;
	sessionId: string;
	node: GraphNode;
	repo: string | null;
	branch: string | null;
}

export interface MirrorFailure {
	target: "linear" | "notion";
	reason: string;
}

const REASON_LIMIT = 300;

function reasonOf(cause: unknown): string {
	const message = cause instanceof Error ? cause.message : String(cause);
	return message.slice(0, REASON_LIMIT);
}

/** The issue behind a node; every Linear transition starts here. */
async function linearIssue(linear: LinearClient, ctx: MirrorContext): Promise<IssueContext> {
	const ref = ctx.node.linear_issue_id ?? ctx.node.linear_identifier;
	if (!ref) throw new Error("node has no Linear issue reference");
	return linear.issueContext(ref);
}

/** The Notion values one transition wants, given whether its Linear step ran and succeeded. */
type NotionWants = (linearOk: boolean) => Record<string, PropertyValue>;

export class Mirror {
	constructor(private readonly targets: { linear: LinearClient | null; notion?: NotionClient | null }) {}

	/** The startup log line's body, so a missing key shows once at boot rather than as a warning per claim. */
	describe(): string {
		return `linear ${this.targets.linear ? "on" : "off"}, notion ${this.targets.notion ? "on" : "off"}`;
	}

	/** Run the claim transition on every enabled target. Never throws. */
	claim(ctx: MirrorContext): Promise<MirrorFailure[]> {
		return this.run(ctx, (linear) => this.claimLinear(linear, ctx), (linearOk) => ({
			Agent: ctx.surface,
			...(linearOk ? { "Linear State": "In Progress" } : {}),
		}));
	}

	/** Back to Todo with `agent:<surface>` removed, and Agent cleared on the Notion row (D-05). Never throws. */
	release(ctx: MirrorContext): Promise<MirrorFailure[]> {
		return this.run(ctx, (linear) => this.releaseLinear(linear, ctx), (linearOk) => ({
			Agent: null,
			...(linearOk ? { "Linear State": "Todo" } : {}),
		}));
	}

	/** To In Review, ahead of the connector's DoD gate. Never throws. */
	review(ctx: MirrorContext): Promise<MirrorFailure[]> {
		return this.run(ctx, (linear) => this.reviewLinear(linear, ctx), (linearOk): Record<string, PropertyValue> =>
			linearOk ? { "Linear State": "In Review" } : {},
		);
	}

	/**
	 * After the connector's gate has moved the issue to Done. Linear needs no
	 * call — the connector already made it — so this records completion on the
	 * Notion row: Status, Linear State and Completed only (D-07). Never throws.
	 */
	done(ctx: MirrorContext): Promise<MirrorFailure[]> {
		return this.run(ctx, null, () => ({
			Status: "Done",
			"Linear State": "Done",
			Completed: new Date().toISOString().slice(0, 10),
		}));
	}

	/**
	 * The node's issue state as Linear has it now, or null when Linear is off,
	 * the node has no issue or the read fails. Never throws. Lets completion
	 * tell an issue the connector already moved to Done from one still open.
	 */
	async linearState(ctx: MirrorContext): Promise<{ name: string; type: string } | null> {
		const ref = ctx.node.linear_issue_id ?? ctx.node.linear_identifier;
		if (!this.targets.linear || !ref) return null;
		return this.targets.linear.issueState(ref).catch(() => null);
	}

	/**
	 * The node's Linear issue text for issue_get (D-15), or why it is
	 * unavailable. Never throws; a failure carries the error message only,
	 * never headers or the request.
	 */
	async issueText(
		node: Pick<GraphNode, "linear_issue_id" | "linear_identifier">,
	): Promise<{ ok: true; identifier: string; title: string; description: string | null } | { ok: false; reason: string }> {
		if (!this.targets.linear) return { ok: false, reason: "linear mirror off" };
		const ref = node.linear_issue_id ?? node.linear_identifier;
		if (!ref) return { ok: false, reason: "node has no Linear issue reference" };
		try {
			return { ok: true, ...(await this.targets.linear.issueText(ref)) };
		} catch (cause) {
			return { ok: false, reason: `linear read failed: ${reasonOf(cause)}` };
		}
	}

	private async run(
		ctx: MirrorContext,
		linearStep: ((linear: LinearClient) => Promise<void>) | null,
		notionWants: NotionWants,
	): Promise<MirrorFailure[]> {
		const failures: MirrorFailure[] = [];
		let linearOk = false;
		if (this.targets.linear && linearStep) {
			try {
				await linearStep(this.targets.linear);
				linearOk = true;
			} catch (cause) {
				failures.push({ target: "linear", reason: reasonOf(cause) });
			}
		}
		if (this.targets.notion) {
			failures.push(...(await this.notionStep(this.targets.notion, ctx, notionWants(linearOk))));
		}
		return failures;
	}

	/**
	 * One PATCH on the node's Issue row, each value shaped for the type the row
	 * itself reports. A property the row lacks, or has in a type substrate
	 * cannot write, is skipped with its own failure; the rest are still sent.
	 */
	private async notionStep(
		notion: NotionClient,
		ctx: MirrorContext,
		wants: Record<string, PropertyValue>,
	): Promise<MirrorFailure[]> {
		if (Object.keys(wants).length === 0) return [];
		const pageId = notionPageId(ctx.node.notion_page);
		if (!pageId) {
			const reason = ctx.node.notion_page
				? `notion_page holds no Notion page id: ${ctx.node.notion_page.slice(0, 100)}`
				: "node has no notion_page";
			return [{ target: "notion", reason }];
		}

		const failures: MirrorFailure[] = [];
		try {
			const types = await notion.getPage(pageId);
			const properties: Record<string, unknown> = {};
			for (const [name, value] of Object.entries(wants)) {
				const type = types[name];
				const shaped = type ? buildProperty(type, value) : null;
				if (shaped) {
					properties[name] = shaped;
				} else {
					const reason = type
						? `"${name}" on page ${pageId} is a ${type} property, which substrate cannot write`
						: `page ${pageId} has no "${name}" property`;
					failures.push({ target: "notion", reason });
				}
			}
			if (Object.keys(properties).length > 0) await notion.updatePage(pageId, properties);
		} catch (cause) {
			failures.push({ target: "notion", reason: reasonOf(cause) });
		}
		return failures;
	}

	/**
	 * In Progress (by name, in the issue's own team), `agent:<surface>` added,
	 * every `dispatch:*` label removed — one issueUpdate — then one comment.
	 * Safe to re-run: state and labels converge, and the comment is skipped when
	 * this session already left one (the D-02 retry path).
	 */
	private async claimLinear(linear: LinearClient, ctx: MirrorContext): Promise<void> {
		const issue = await linearIssue(linear, ctx);
		const stateId = stateIdByName(issue, "In Progress");
		const agentLabelId = await linear.ensureLabel(issue.team.id, `agent:${ctx.surface}`);
		const removedLabelIds = issue.labels.filter((l) => l.name.startsWith("dispatch:")).map((l) => l.id);
		await linear.updateIssue(issue.id, { stateId, addedLabelIds: [agentLabelId], removedLabelIds });
		// `session sess-1 ` with the space, so an earlier sess-10 comment does not count as sess-1's.
		const marker = `session ${ctx.sessionId}`;
		if (issue.comments.some((body) => body.includes(`${marker} `) || body.endsWith(marker))) return;
		await linear.createComment(
			issue.id,
			`Claimed by ${ctx.surface} — session ${ctx.sessionId} (graph ${ctx.graphId}, node ${ctx.nodeId})`,
		);
	}

	/** Todo (by name) and `agent:<surface>` removed when the issue carries it — one issueUpdate. */
	private async releaseLinear(linear: LinearClient, ctx: MirrorContext): Promise<void> {
		const issue = await linearIssue(linear, ctx);
		const agentLabel = `agent:${ctx.surface}`;
		await linear.updateIssue(issue.id, {
			stateId: stateIdByName(issue, "Todo"),
			removedLabelIds: issue.labels.filter((l) => l.name === agentLabel).map((l) => l.id),
		});
	}

	/** In Review by name — never In Progress, which shares its `started` type, and never Done. */
	private async reviewLinear(linear: LinearClient, ctx: MirrorContext): Promise<void> {
		const issue = await linearIssue(linear, ctx);
		await linear.updateIssue(issue.id, { stateId: stateIdByName(issue, "In Review") });
	}
}

/** Production wiring: each target only when its API key is configured. */
export function createMirror(config: SubstrateConfig, fetchImpl?: typeof fetch): Mirror {
	return new Mirror({
		linear: config.linearApiKey ? new LinearClient(config.linearApiKey, { fetchImpl }) : null,
		notion: config.notionApiKey
			? new NotionClient(config.notionApiKey, { dataSourceId: config.notionTaskGraphDataSource, fetchImpl })
			: null,
	});
}
