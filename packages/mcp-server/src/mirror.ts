/**
 * Mirrors a node claim out to the trackers that show it to humans.
 *
 * The index claim is the source of truth and has already landed by the time
 * the mirror runs. The mirror never throws: every tracker failure comes back as
 * a MirrorFailure for the caller to record as a warning event (D-02). A target
 * with no credential is disabled, which is not a failure.
 */
import type { SubstrateConfig } from "./config.ts";
import { LinearClient, stateIdByName } from "./linear.ts";
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

export class Mirror {
	constructor(private readonly targets: { linear: LinearClient | null }) {}

	/** The startup log line's body, so a missing key shows once at boot rather than as a warning per claim. */
	describe(): string {
		return `linear ${this.targets.linear ? "on" : "off"}`;
	}

	/** Run the claim transition on every enabled target. Never throws. */
	async claim(ctx: MirrorContext): Promise<MirrorFailure[]> {
		const failures: MirrorFailure[] = [];
		if (this.targets.linear) {
			try {
				await this.claimLinear(this.targets.linear, ctx);
			} catch (cause) {
				failures.push({ target: "linear", reason: reasonOf(cause) });
			}
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
		const ref = ctx.node.linear_issue_id ?? ctx.node.linear_identifier;
		if (!ref) throw new Error("node has no Linear issue reference");

		const issue = await linear.issueContext(ref);
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
}

/** Production wiring: a Linear target only when LINEAR_API_KEY is configured. */
export function createMirror(config: SubstrateConfig, fetchImpl?: typeof fetch): Mirror {
	return new Mirror({
		linear: config.linearApiKey ? new LinearClient(config.linearApiKey, { fetchImpl }) : null,
	});
}
