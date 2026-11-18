/**
 * Linear GraphQL client for the claim mirror (MIRROR-01).
 *
 * Every call is timed out and every failure is thrown as a LinearError for the
 * mirror to turn into a warning event: Linear being slow or down must never
 * block or undo a lease decision. Labels are only ever changed additively —
 * there is deliberately no way to send `labelIds` (which overwrites) through
 * this client.
 *
 * States are resolved by type through the issue's own team, ordered by
 * `position` (D23-06): first `started` is the lowest-position `started` state,
 * first `unstarted` the lowest-position `unstarted` state. In Review is the one
 * exception, resolved by name among `started` states. The substrate never
 * resolves or sends a `completed` (Done) state id — only the
 * hermes-linear-connector DoD gate moves an issue to Done.
 *
 * A leaf module: imports nothing from service.ts, index-store.ts or lease.ts.
 */

const DEFAULT_TIMEOUT_MS = 5000;
export const LINEAR_API_URL = "https://api.linear.app/graphql";

export class LinearError extends Error {}

export interface LinearState {
	id: string;
	name: string;
	type: string;
	position: number;
}

export interface IssueContext {
	id: string;
	identifier: string;
	team: { id: string; key: string; states: LinearState[] };
	labels: Array<{ id: string; name: string }>;
	comments: string[];
}

/** The lowest-position `started` state of the issue's own team. Never a `completed` state. */
export function firstStartedStateId(ctx: IssueContext): string {
	const candidates = ctx.team.states.filter((s) => s.type === "started").sort((a, b) => a.position - b.position);
	const state = candidates[0];
	if (!state) throw new LinearError(`team ${ctx.team.key} has no started state`);
	if (state.type === "completed") throw new LinearError(`refusing to resolve a completed state in team ${ctx.team.key}`);
	return state.id;
}

/** The lowest-position `unstarted` state of the issue's own team. Never a `completed` state. */
export function firstUnstartedStateId(ctx: IssueContext): string {
	const candidates = ctx.team.states.filter((s) => s.type === "unstarted").sort((a, b) => a.position - b.position);
	const state = candidates[0];
	if (!state) throw new LinearError(`team ${ctx.team.key} has no unstarted state`);
	if (state.type === "completed") throw new LinearError(`refusing to resolve a completed state in team ${ctx.team.key}`);
	return state.id;
}

/**
 * The `started` state named "In Review" (case-insensitive) in the issue's own
 * team. Its absence is a mirror failure, never a fallback to another state —
 * and never a `completed` state.
 */
export function inReviewStateId(ctx: IssueContext): string {
	const state = ctx.team.states.find((s) => s.type === "started" && s.name.toLowerCase() === "in review");
	if (!state) throw new LinearError(`team ${ctx.team.key} has no started state named "In Review"`);
	if (state.type === "completed") throw new LinearError(`refusing to resolve a completed state in team ${ctx.team.key}`);
	return state.id;
}

interface GraphqlResponse<T> {
	data?: T;
	errors?: Array<{ message?: string }>;
}

interface IssueQueryResult {
	issue: {
		id: string;
		identifier: string;
		team: { id: string; key: string; states: { nodes: Array<{ id: string; name: string; type: string; position: number }> } };
		labels: { nodes: Array<{ id: string; name: string }> };
		comments: { nodes: Array<{ body: string }> };
	} | null;
}

interface LabelQueryResult {
	issueLabels: { nodes: Array<{ id: string; name: string; team: { id: string } | null }> };
}

/** An issue as `issueRelations` reads it: its UUID, identifier, and the relations it is the source of. */
export interface IssueRelations {
	id: string;
	identifier: string;
	relations: Array<{ type: string; relatedIssueId: string }>;
}

export class LinearClient {
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;
	private readonly endpoint: string;
	/** `teamId:name` → label id, for the process lifetime. Labels are not renamed under us in practice. */
	private readonly labelCache = new Map<string, string>();

	constructor(
		private readonly apiKey: string,
		opts?: { fetchImpl?: typeof fetch; timeoutMs?: number; endpoint?: string },
	) {
		this.fetchImpl = opts?.fetchImpl ?? fetch;
		this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.endpoint = (opts?.endpoint ?? LINEAR_API_URL).replace(/\/+$/, "");
	}

	/** One GraphQL POST. Error messages carry status and response text, never the key or request headers. */
	async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
		let response: Response;
		try {
			response = await this.fetchImpl(this.endpoint, {
				method: "POST",
				// Linear personal API keys go in raw; a `Bearer ` prefix is for OAuth tokens and is rejected.
				headers: { Authorization: this.apiKey, "Content-Type": "application/json" },
				body: JSON.stringify({ query, variables }),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (cause) {
			throw new LinearError(`linear unreachable: ${cause instanceof Error ? cause.message : String(cause)}`);
		}

		const text = await response.text();
		if (!response.ok) throw new LinearError(`linear ${response.status}: ${text.slice(0, 200)}`);

		let body: GraphqlResponse<T>;
		try {
			body = JSON.parse(text) as GraphqlResponse<T>;
		} catch {
			throw new LinearError(`linear returned non-JSON: ${text.slice(0, 200)}`);
		}
		if (body.errors?.length) {
			const messages = body.errors.map((e) => e.message ?? "unknown error").join("; ");
			throw new LinearError(`linear: ${messages.slice(0, 200)}`);
		}
		if (!body.data) throw new LinearError("linear returned no data");
		return body.data;
	}

	/** Everything one transition needs, in one query. `ref` may be a UUID or an identifier like SWC-12. */
	async issueContext(ref: string): Promise<IssueContext> {
		const data = await this.graphql<IssueQueryResult>(
			`query IssueContext($id: String!) {
				issue(id: $id) {
					id identifier
					team { id key states { nodes { id name type position } } }
					labels { nodes { id name } }
					comments(last: 20) { nodes { body } }
				}
			}`,
			{ id: ref },
		);
		const issue = data.issue;
		if (!issue) throw new LinearError(`issue ${ref} not found`);
		return {
			id: issue.id,
			identifier: issue.identifier,
			team: { id: issue.team.id, key: issue.team.key, states: issue.team.states.nodes },
			labels: issue.labels.nodes,
			comments: issue.comments.nodes.map((c) => c.body),
		};
	}

	/** The issue's current workflow state. `ref` may be a UUID or an identifier like SWC-12. */
	async issueState(ref: string): Promise<{ name: string; type: string }> {
		const data = await this.graphql<{ issue: { state: { name: string; type: string } } | null }>(
			`query IssueState($id: String!) {
				issue(id: $id) { state { name type } }
			}`,
			{ id: ref },
		);
		if (!data.issue) throw new LinearError(`issue ${ref} not found`);
		return data.issue.state;
	}

	/** The issue's identifier, title and description. `ref` may be a UUID or an identifier like SWC-12. */
	async issueText(ref: string): Promise<{ identifier: string; title: string; description: string | null }> {
		const data = await this.graphql<{ issue: { identifier: string; title: string; description: string | null } | null }>(
			`query IssueText($id: String!) {
				issue(id: $id) { identifier title description }
			}`,
			{ id: ref },
		);
		if (!data.issue) throw new LinearError(`issue ${ref} not found`);
		return data.issue;
	}

	/**
	 * The id of a label with this exact name usable on the team: the team's own
	 * label, else a workspace label, else a new team label.
	 */
	async ensureLabel(teamId: string, name: string): Promise<string> {
		const key = `${teamId}:${name}`;
		const cached = this.labelCache.get(key);
		if (cached) return cached;

		const found = await this.findLabel(teamId, name);
		if (found) {
			this.labelCache.set(key, found);
			return found;
		}

		let created: string | undefined;
		try {
			const data = await this.graphql<{ issueLabelCreate: { success: boolean; issueLabel: { id: string } | null } }>(
				`mutation LabelCreate($input: IssueLabelCreateInput!) {
					issueLabelCreate(input: $input) { success issueLabel { id } }
				}`,
				{ input: { name, teamId } },
			);
			created = data.issueLabelCreate.success ? data.issueLabelCreate.issueLabel?.id : undefined;
			if (!created) throw new LinearError(`issueLabelCreate for "${name}" did not succeed`);
		} catch (cause) {
			// A concurrent claimer may have created it, or a same-named workspace label
			// may block a team label. Either way the label now exists to be found.
			const retry = await this.findLabel(teamId, name);
			if (!retry) throw cause;
			created = retry;
		}
		this.labelCache.set(key, created);
		return created;
	}

	private async findLabel(teamId: string, name: string): Promise<string | undefined> {
		const data = await this.graphql<LabelQueryResult>(
			`query Labels($name: String!) {
				issueLabels(filter: { name: { eq: $name } }) { nodes { id name team { id } } }
			}`,
			{ name },
		);
		const exact = data.issueLabels.nodes.filter((l) => l.name === name);
		return (exact.find((l) => l.team?.id === teamId) ?? exact.find((l) => l.team === null))?.id;
	}

	/** Additive only: there is no parameter through which `labelIds` could be sent. */
	async updateIssue(
		id: string,
		input: { stateId?: string; addedLabelIds?: string[]; removedLabelIds?: string[] },
	): Promise<void> {
		const payload: Record<string, unknown> = {};
		if (input.stateId) payload.stateId = input.stateId;
		if (input.addedLabelIds?.length) payload.addedLabelIds = input.addedLabelIds;
		if (input.removedLabelIds?.length) payload.removedLabelIds = input.removedLabelIds;
		const data = await this.graphql<{ issueUpdate: { success: boolean } }>(
			`mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
				issueUpdate(id: $id, input: $input) { success }
			}`,
			{ id, input: payload },
		);
		if (!data.issueUpdate.success) throw new LinearError(`issueUpdate on ${id} did not succeed`);
	}

	async createComment(issueId: string, body: string): Promise<void> {
		const data = await this.graphql<{ commentCreate: { success: boolean } }>(
			`mutation CommentCreate($input: CommentCreateInput!) {
				commentCreate(input: $input) { success }
			}`,
			{ input: { issueId, body } },
		);
		if (!data.commentCreate.success) throw new LinearError(`commentCreate on ${issueId} did not succeed`);
	}

	/**
	 * An issue's UUID, identifier and the relations it is the source of, in one query. `ref` may be a UUID or an
	 * identifier like SWC-12. A `blocks` relation is stored on the blocking issue.
	 */
	async issueRelations(ref: string): Promise<IssueRelations> {
		const data = await this.graphql<{
			issue: { id: string; identifier: string; relations: { nodes: Array<{ type: string; relatedIssue: { id: string } | null }> } } | null;
		}>(
			`query IssueRelations($id: String!) {
				issue(id: $id) { id identifier relations { nodes { type relatedIssue { id } } } }
			}`,
			{ id: ref },
		);
		const issue = data.issue;
		if (!issue) throw new LinearError(`no issue ${ref}`);
		return {
			id: issue.id,
			identifier: issue.identifier,
			relations: issue.relations.nodes.flatMap((relation) =>
				relation.relatedIssue ? [{ type: relation.type, relatedIssueId: relation.relatedIssue.id }] : [],
			),
		};
	}

	/**
	 * Create a relation from `issueId` to `relatedIssueId` and return its id. For `blocks`, `issueId` is the blocking
	 * issue. The id is what a later removal needs to delete exactly this relation.
	 */
	async createIssueRelation(issueId: string, relatedIssueId: string, type: "blocks"): Promise<string> {
		const data = await this.graphql<{ issueRelationCreate: { success: boolean; issueRelation: { id: string } | null } }>(
			`mutation IssueRelationCreate($input: IssueRelationCreateInput!) {
				issueRelationCreate(input: $input) { success issueRelation { id } }
			}`,
			{ input: { issueId, relatedIssueId, type } },
		);
		const created = data.issueRelationCreate;
		if (!created.success || !created.issueRelation) {
			throw new LinearError(`issueRelationCreate ${type} from ${issueId} to ${relatedIssueId} did not succeed`);
		}
		return created.issueRelation.id;
	}

	/** Delete one relation by its id. Only a relation this client was told it created is ever passed here. */
	async deleteIssueRelation(id: string): Promise<void> {
		const data = await this.graphql<{ issueRelationDelete: { success: boolean } }>(
			`mutation IssueRelationDelete($id: String!) {
				issueRelationDelete(id: $id) { success }
			}`,
			{ id },
		);
		if (!data.issueRelationDelete.success) throw new LinearError(`issueRelationDelete ${id} did not succeed`);
	}
}
