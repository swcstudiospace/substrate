/**
 * The steering MCP tools (phase 53, SOTA-09): queue a directive, acknowledge one, and list the queued directives for a
 * session. Each tool is a thin shell over the inbox in `steering.ts`, which owns every rule: the human-only author, the
 * allowlist, the rate limit, audit before effect, and the confirm rule for a conflicting directive.
 *
 * What this module adds:
 * - Strict argument schemas. An unknown field is refused at the MCP boundary, not dropped.
 * - A typed result per tool. A write with no injected audit sink answers `not-configured` and records nothing; a refused
 *   write carries the inbox's typed error.
 * - The sink is never built here. The inbox arrives injected through `SteeringWiring`, so this module never touches the
 *   store, the filesystem or a clock of its own.
 */
import { z } from "zod";
import { SESSION_ID_RE } from "./presence.ts";
import {
	STEERING_ACTIONS,
	STEERING_BODY_MAX,
	STEERING_OUTCOMES,
	STEERING_PRIORITIES,
	type SteeringClock,
	type SteeringError,
	type SteeringInbox,
	type SteeringOutcome,
} from "./steering.ts";

/** The inbox the tools run against, and the clock that stamps a queued directive. `inbox` is null with no audit sink. */
export interface SteeringWiring {
	/** Whether SUBSTRATE_PLANNING_STEERING is on. The tools are registered only when it is. */
	readonly enabled: boolean;
	readonly inbox: SteeringInbox | null;
	readonly clock: SteeringClock;
}

const DIRECTIVE_ID_MAX = 128;
const PRINCIPAL_ID_MAX = 128;
const PLAN_ID_MAX = 64;

/** `steering_queue`. Field names are snake_case, like the other tools in `mcp.ts`. Unknown fields are refused. */
export const STEERING_QUEUE_INPUT = z
	.object({
		id: z.string().min(1).max(DIRECTIVE_ID_MAX).describe("The directive id: letters, digits and . _ : -, starting with a letter or digit."),
		principal_id: z.string().min(1).max(PRINCIPAL_ID_MAX).describe("The author's principal id. It must be on SUBSTRATE_PLANNING_STEERING_PRINCIPALS."),
		author_kind: z.enum(["human", "agent"]).describe("Who authored the directive. An agent is always refused."),
		priority: z.enum(STEERING_PRIORITIES).describe("low, normal or high."),
		target_session_id: z.string().regex(SESSION_ID_RE).describe("The planning session the directive is for."),
		action: z.enum(STEERING_ACTIONS).describe("pause, redirect or annotate."),
		body: z.string().min(1).max(STEERING_BODY_MAX).describe("The directive text. Secret-shaped values are redacted before they are stored."),
		plan_ref: z
			.object({
				phase: z.string().min(1).max(PLAN_ID_MAX),
				plan: z.string().min(1).max(PLAN_ID_MAX),
			})
			.strict()
			.optional()
			.describe("The phase and plan the directive refers to, when it names one."),
		conflicts_with_active_plan: z.boolean().describe("True when the directive contradicts the session's active plan. Such a directive needs confirm to be applied."),
	})
	.strict();

/** `steering_acknowledge`. The target session acknowledges with `applied` or `declined`. */
export const STEERING_ACKNOWLEDGE_INPUT = z
	.object({
		directive_id: z.string().min(1).max(DIRECTIVE_ID_MAX).describe("The id of the queued directive."),
		session_id: z.string().regex(SESSION_ID_RE).describe("The session the directive is for. It must match the directive's target."),
		outcome: z.enum(STEERING_OUTCOMES).describe("applied or declined."),
		confirm: z.boolean().optional().describe("Required true to apply a directive that conflicts with the active plan."),
	})
	.strict();

/** `steering_list`. The queued directives for one session. */
export const STEERING_LIST_INPUT = z
	.object({
		session_id: z.string().regex(SESSION_ID_RE).describe("The planning session whose queued directives to list."),
	})
	.strict();

export type SteeringQueueInput = z.infer<typeof STEERING_QUEUE_INPUT>;
export type SteeringAcknowledgeInput = z.infer<typeof STEERING_ACKNOWLEDGE_INPUT>;
export type SteeringListInput = z.infer<typeof STEERING_LIST_INPUT>;

/** The result of a write. `refused` carries the inbox's typed error; `not-configured` means no audit sink was injected. */
export type SteeringWriteResult =
	| { status: "queued"; directive_id: string; target_session_id: string; queued_at_ms: number }
	| { status: "acknowledged"; directive_id: string; outcome: SteeringOutcome; confirmed: boolean }
	| { status: "refused"; error: SteeringError }
	| { status: "not-configured" };

export interface ListedSteeringDirective {
	id: string;
	author_principal_id: string;
	priority: string;
	action: string;
	body: string;
	plan_ref: { phase: string; plan: string } | null;
	conflicts_with_active_plan: boolean;
	created_at_ms: number;
}

/** The queued directives for one session. Acknowledged directives are not listed. A read: `not-configured` is not an error. */
export type SteeringListResult =
	| { status: "listed"; target_session_id: string; directives: ListedSteeringDirective[] }
	| { status: "not-configured" };

/** Whether a write was refused, or had no sink to write to. Both are error replies. */
export function steeringFailed(result: SteeringWriteResult): boolean {
	return result.status === "refused" || result.status === "not-configured";
}

/** Queue a directive. The inbox validates, authorises, rate-limits and audits before the directive is stored. */
export async function queueSteering(wiring: SteeringWiring, input: SteeringQueueInput): Promise<SteeringWriteResult> {
	if (wiring.inbox === null) return { status: "not-configured" };
	const result = await wiring.inbox.enqueue({
		id: input.id,
		author: { principalId: input.principal_id, kind: input.author_kind },
		createdAtMs: wiring.clock.nowMs(),
		priority: input.priority,
		targetSessionId: input.target_session_id,
		action: input.action,
		body: input.body,
		planRef: input.plan_ref,
		conflictsWithActivePlan: input.conflicts_with_active_plan,
	});
	if (!result.ok) return { status: "refused", error: result.error };
	return {
		status: "queued",
		directive_id: result.value.directive.id,
		target_session_id: result.value.directive.targetSessionId,
		queued_at_ms: result.value.queuedAtMs,
	};
}

/** Acknowledge a queued directive. Applying a conflicting directive needs `confirm: true`; the inbox enforces it. */
export async function acknowledgeSteering(wiring: SteeringWiring, input: SteeringAcknowledgeInput): Promise<SteeringWriteResult> {
	if (wiring.inbox === null) return { status: "not-configured" };
	const result = await wiring.inbox.acknowledge({
		directiveId: input.directive_id,
		sessionId: input.session_id,
		outcome: input.outcome,
		confirm: input.confirm,
	});
	if (!result.ok) return { status: "refused", error: result.error };
	return {
		status: "acknowledged",
		directive_id: result.value.directive.id,
		outcome: input.outcome,
		confirmed: input.confirm === true,
	};
}

/** The queued directives for one session, highest priority first. A read: it writes nothing and records nothing. */
export function listSteering(wiring: SteeringWiring, input: SteeringListInput): SteeringListResult {
	if (wiring.inbox === null) return { status: "not-configured" };
	const directives = wiring.inbox.pendingFor(input.session_id).map((directive) => ({
		id: directive.id,
		author_principal_id: directive.author.principalId,
		priority: directive.priority,
		action: directive.action,
		body: directive.body,
		plan_ref: directive.planRef ?? null,
		conflicts_with_active_plan: directive.conflictsWithActivePlan,
		created_at_ms: directive.createdAtMs,
	}));
	return { status: "listed", target_session_id: input.session_id, directives };
}
