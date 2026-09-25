/**
 * Linear GraphQL client for the claim mirror.
 *
 * Every call is timed out and every failure is thrown as a LinearError for the
 * mirror to turn into a warning event: Linear being slow or down must never
 * block or undo a claim. Labels are only ever changed additively — there is
 * deliberately no way to send `labelIds` (which overwrites) or
 * `replaceTeamLabels` through this client.
 */

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_ENDPOINT = "https://api.linear.app/graphql";

export class LinearError extends Error {}

export interface IssueContext {
	id: string;
	identifier: string;
	team: { id: string; key: string; states: Array<{ id: string; name: string; type: string }> };
	labels: Array<{ id: string; name: string }>;
	comments: string[];
}

/**
 * A state id by its name within the issue's own team. Never by type: "In
 * Progress" and "In Review" are both type `started`, so a type lookup is
 * ambiguous and would silently pick the wrong one.
 */
export function stateIdByName(ctx: IssueContext, name: string): string {
	const wanted = name.toLowerCase();
	const state = ctx.team.states.find((s) => s.name.toLowerCase() === wanted);
	if (!state) throw new LinearError(`no state named "${name}" in team ${ctx.team.key}`);
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
		team: { id: string; key: string; states: { nodes: Array<{ id: string; name: string; type: string }> } };
		labels: { nodes: Array<{ id: string; name: string }> };
		comments: { nodes: Array<{ body: string }> };
	} | null;
}

interface LabelQueryResult {
	issueLabels: { nodes: Array<{ id: string; name: string; team: { id: string } | null }> };
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
		this.endpoint = opts?.endpoint ?? DEFAULT_ENDPOINT;
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
					team { id key states { nodes { id name type } } }
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

	/** Additive only: there is no parameter through which `labelIds` could be sent (D-03). */
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
}
