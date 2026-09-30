/**
 * `coord.drift_scan` — where the three records of what is happening in a repo
 * disagree.
 *
 * The substrate keeps three of them and nothing ever compared them:
 *
 *   1. **the tree** — what git actually has at HEAD;
 *   2. **the trail** — the events the ledger holds for that repo;
 *   3. **the claims** — the leases the index says are held.
 *
 * Each can be right while the others are wrong, and every interesting failure
 * of a multi-agent host shows up as a disagreement between two of them: a
 * commit with no event means a collector is down, a live lease with no activity
 * means a session died mid-node, an event on a node nobody holds means an agent
 * skipped the claim and two of them are about to collide.
 *
 * So this does not fix anything and does not guess. It gathers the three,
 * compares them, and names each disagreement with the evidence for it. The
 * analysis here is pure — the gathering, with its git calls and its two
 * database round-trips, is `Substrate.driftScan`'s job — which is what lets the
 * comparisons be tested against constructed disagreements rather than against
 * whatever the host happens to be doing.
 */
import { leaseState, leaseView, parseTime, type LeaseSnapshot, type LeaseView } from "./lease.ts";
import type { EdgeKind, EventKind, GraphEdge, NodeState, Surface } from "./types.ts";

/**
 * How long a lease may be held with nothing happening before that is drift.
 *
 * Longer than a lease TTL by design: a heartbeating lease is *alive*, so the
 * question this asks is different from expiry. It is whether the holder is
 * doing anything, and an agent that is thinking, or waiting on CI, is not
 * drifting. An hour of a held node with no event is.
 */
export const DEFAULT_IDLE_SECONDS = 3600;

/** Event kinds that count as work having happened on a node. */
const WORK_KINDS: ReadonlyArray<EventKind> = ["commit", "file.edit", "shell", "tool.call", "pr"];

export interface DriftGitTip {
	sha: string | null;
	short_sha: string | null;
	subject: string | null;
	committed_at: string | null;
	branch: string | null;
	/** Whether the checkout holds the newest commit the ledger names. Null = not asked. */
	knows_ledger_commit?: boolean | null;
	unavailable?: string;
}

export interface DriftEvent {
	id: string;
	ts: string;
	surface: Surface;
	session_id: string | null;
	kind: EventKind;
	summary: string;
	graph_id: string | null;
	node_id: string | null;
	/** The commit a `commit` event names, where one could be read out of it. */
	sha: string | null;
}

export interface DriftClaim {
	graph_id: string;
	node_id: string;
	linear_identifier: string | null;
	state: NodeState | null;
	lease: LeaseSnapshot;
}

export interface DriftNode {
	graph_id: string;
	node_id: string;
	linear_identifier: string | null;
	state: NodeState | null;
}

export type DriftKind =
	/** git's HEAD has no `commit` event: something committed outside the substrate. */
	| "git.tip_unlogged"
	/** The newest commit in the trail is not in this checkout: behind, or history was rewritten. */
	| "ledger.commit_unknown_to_git"
	/** The repo has commits and no events at all. */
	| "ledger.silent"
	/** A lease is recorded whose TTL has passed — held by nobody, still shown as held. */
	| "lease.expired"
	/** A live lease whose holder has emitted nothing for longer than the idle window. */
	| "lease.idle"
	/** A live lease whose holder's session has already ended. */
	| "lease.orphaned"
	/** Work landed on a node that nothing holds. */
	| "work.unclaimed"
	/** A held node's `requires` predecessor is not complete. */
	| "edge.requires_incomplete"
	/** A held node is gated on something that has not happened. */
	| "edge.gate_open";

export interface DriftFinding {
	kind: DriftKind;
	severity: "warn" | "info";
	/** One line, for a brief or a terminal. */
	detail: string;
	graph_id?: string;
	node_id?: string;
	surface?: Surface;
	session_id?: string;
	/** The facts the finding was drawn from, so it can be checked rather than believed. */
	evidence: Record<string, unknown>;
}

export interface DriftInputs {
	repo: string;
	now?: number;
	git: DriftGitTip;
	/** Repo-scoped events, newest first. */
	events: DriftEvent[];
	claims: DriftClaim[];
	nodes: DriftNode[];
	edges: GraphEdge[];
	idle_seconds?: number;
	/**
	 * Whether the ledger holds a `commit` event naming the git tip, asked of the
	 * whole ledger rather than of `events`.
	 *
	 * `events` is a window of recent activity, so its silence about a commit is
	 * not evidence: a busy repo pushes a well-logged commit out of the newest N
	 * events and the scan would invent `git.tip_unlogged`. A definite answer here
	 * decides it; `null` means the question could not be asked, and then the
	 * window is all there is — and a full window is treated as inconclusive
	 * rather than as drift.
	 */
	tip_logged?: boolean | null;
	/** True when `events` was truncated by the limit, so its silence proves nothing. */
	events_truncated?: boolean;
	/** Which of the three records could actually be read. */
	sources: { git: boolean; ledger: boolean; index: boolean };
}

export interface DriftReport {
	repo: string;
	scanned_at: string;
	/** True when all three records agree, as far as they could be read. */
	ok: boolean;
	git: DriftGitTip;
	ledger: {
		events: number;
		last_event: { ts: string; surface: Surface; kind: EventKind; summary: string } | null;
		last_commit: { ts: string; surface: Surface; sha: string | null; summary: string } | null;
		/** Newest activity per surface, so a silent agent is visible. */
		surfaces: Array<{ surface: Surface; last_ts: string; last_summary: string }>;
	};
	claims: Array<{
		graph_id: string;
		node_id: string;
		linear_identifier: string | null;
		state: NodeState | null;
		lease: LeaseView;
	}>;
	findings: DriftFinding[];
	sources: DriftInputs["sources"];
	/** Records that could not be read, so a clean report is not mistaken for a complete one. */
	unavailable: string[];
}

/**
 * The commit a `commit` event names.
 *
 * The git collector puts a short sha in `payload.sha`; the summary carries it
 * too (`commit 1a2b3c4 subject`) because that is what a human reads. Either is
 * accepted, since a collector may be older than whichever is current.
 */
export function extractCommitSha(summary: string, payload: Record<string, unknown> | undefined): string | null {
	const fromPayload = payload?.sha;
	if (typeof fromPayload === "string" && /^[0-9a-f]{7,40}$/i.test(fromPayload)) return fromPayload.toLowerCase();
	const match = /\bcommit\s+([0-9a-f]{7,40})\b/i.exec(summary);
	return match?.[1]?.toLowerCase() ?? null;
}

/**
 * Whether two shas name the same commit, one of them possibly abbreviated.
 *
 * Prefix comparison rather than equality: the ledger holds `git rev-parse
 * --short` output and the checkout reports the full hash, so requiring equality
 * would report every commit as unlogged.
 */
export function shaMatches(a: string | null | undefined, b: string | null | undefined): boolean {
	if (!a || !b) return false;
	const [x, y] = [a.toLowerCase(), b.toLowerCase()];
	const shorter = x.length <= y.length ? x : y;
	const longer = shorter === x ? y : x;
	// Below 7 characters an abbreviation is not specific enough to claim a match.
	return shorter.length >= 7 && longer.startsWith(shorter);
}

function nodeKey(graphId: string, nodeId: string): string {
	return `${graphId}/${nodeId}`;
}

/**
 * Whether the ledger holds the git tip's commit event. `null` means unknown.
 *
 * A whole-ledger answer decides it either way. Without one, finding the commit
 * in the window is proof it is there — but *not* finding it is only proof when
 * the window held every event there was. A truncated window that does not show
 * the commit is the case that used to be reported as drift, on repos busy
 * enough to push a well-logged commit out of the newest N events.
 */
function tipIsLogged(
	inputs: Pick<DriftInputs, "tip_logged" | "events_truncated">,
	inWindow: boolean,
): boolean | null {
	if (inputs.tip_logged === true || inputs.tip_logged === false) return inputs.tip_logged;
	if (inWindow) return true;
	return inputs.events_truncated ? null : false;
}

function ago(from: number, now: number): string {
	const minutes = Math.max(0, Math.round((now - from) / 60_000));
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function label(claim: DriftClaim): string {
	return claim.linear_identifier ? `${claim.node_id} (${claim.linear_identifier})` : claim.node_id;
}

/** Compare the three records and name every disagreement. */
export function analyzeDrift(inputs: DriftInputs): DriftReport {
	const now = inputs.now ?? Date.now();
	const idleMs = (inputs.idle_seconds ?? DEFAULT_IDLE_SECONDS) * 1000;
	const findings: DriftFinding[] = [];
	const unavailable: string[] = [];
	if (!inputs.sources.git) unavailable.push(inputs.git.unavailable ?? "git: no checkout given");
	if (!inputs.sources.ledger) unavailable.push("ledger: not configured or unreachable");
	if (!inputs.sources.index) unavailable.push("index: not configured or unreachable");

	const commits = inputs.events.filter((event) => event.kind === "commit");
	const lastCommit = commits[0] ?? null;
	const lastEvent = inputs.events[0] ?? null;

	// ── the tree against the trail ────────────────────────────────────────────
	if (inputs.sources.git && inputs.sources.ledger && inputs.git.sha) {
		const inWindow = commits.find(
			(event) => shaMatches(event.sha, inputs.git.sha) || shaMatches(event.sha, inputs.git.short_sha),
		);
		const logged = tipIsLogged(inputs, inWindow !== undefined);
		if (logged === null) {
			// Neither record can answer it, so say that rather than guess. A truncated
			// window's silence about a commit is not evidence the commit is missing.
			unavailable.push(
				"ledger: the git tip could not be looked up beyond the recent-activity window, so whether it was logged is unknown",
			);
		} else if (!logged && inputs.events.length === 0) {
			findings.push({
				kind: "ledger.silent",
				severity: "warn",
				detail: `no events at all for ${inputs.repo}, but git is at ${inputs.git.short_sha ?? inputs.git.sha}. Nothing here is being recorded.`,
				evidence: { git_tip: inputs.git.sha, tip_committed_at: inputs.git.committed_at, events: 0 },
			});
		} else if (!logged) {
			findings.push({
				kind: "git.tip_unlogged",
				severity: "warn",
				detail:
					`git is at ${inputs.git.short_sha ?? inputs.git.sha} ("${inputs.git.subject ?? "?"}") and no commit event names it; ` +
					`the trail's newest commit is ${lastCommit?.sha ?? "none"}. A commit happened outside the substrate.`,
				...(lastCommit?.surface ? { surface: lastCommit.surface } : {}),
				evidence: {
					git_tip: inputs.git.sha,
					git_tip_short: inputs.git.short_sha,
					git_tip_committed_at: inputs.git.committed_at,
					ledger_last_commit: lastCommit ? { sha: lastCommit.sha, ts: lastCommit.ts, surface: lastCommit.surface } : null,
					commit_events: commits.length,
				},
			});
		}

		// The other direction: the trail names a commit this checkout has never seen.
		if (lastCommit && !shaMatches(lastCommit.sha, inputs.git.sha) && inputs.git.knows_ledger_commit === false) {
			findings.push({
				kind: "ledger.commit_unknown_to_git",
				severity: "warn",
				detail:
					`the trail's newest commit ${lastCommit.sha} (${lastCommit.surface}, ${ago(parseTime(lastCommit.ts) ?? now, now)} ago) ` +
					`is not in this checkout. Either it is unfetched, or that history was rewritten.`,
				surface: lastCommit.surface,
				evidence: { ledger_sha: lastCommit.sha, ledger_ts: lastCommit.ts, git_tip: inputs.git.sha },
			});
		}
	}

	// ── the claims against the trail ──────────────────────────────────────────
	const held = new Set<string>();
	const claims = inputs.claims.map((claim) => {
		const state = leaseState(claim.lease, now);
		if (state === "held") held.add(nodeKey(claim.graph_id, claim.node_id));
		return { ...claim, state_of_lease: state, view: leaseView(claim.lease, now) };
	});

	for (const claim of claims) {
		const holder = claim.view.holder;
		if (claim.state_of_lease === "expired") {
			findings.push({
				kind: "lease.expired",
				severity: "warn",
				detail:
					`${label(claim)} still shows ${holder?.surface ?? "someone"} holding it, but the lease lapsed ` +
					`${ago(parseTime(claim.lease.expires_at) ?? now, now)} ago. It is free; the row has not caught up.`,
				graph_id: claim.graph_id,
				node_id: claim.node_id,
				...(holder ? { surface: holder.surface, session_id: holder.session_id } : {}),
				evidence: { lease: claim.view },
			});
			continue;
		}
		if (claim.state_of_lease !== "held" || !holder) continue;

		// Only this holder's own events count. Another agent being busy in the repo
		// says nothing about whether the holder of *this* node is doing anything.
		const holderEvents = inputs.sources.ledger
			? inputs.events.filter(
					(event) =>
						event.surface === holder.surface &&
						(holder.session_id === "" || event.session_id === holder.session_id),
				)
			: [];
		const ended = holderEvents.find((event) => event.kind === "session.end");
		if (ended) {
			findings.push({
				kind: "lease.orphaned",
				severity: "warn",
				detail:
					`${label(claim)} is held by ${holder.surface} on a session that ended ` +
					`${ago(parseTime(ended.ts) ?? now, now)} ago. The lease will lapse at ${claim.view.expires_at}; until then the node looks taken.`,
				graph_id: claim.graph_id,
				node_id: claim.node_id,
				surface: holder.surface,
				session_id: holder.session_id,
				evidence: { session_end: { id: ended.id, ts: ended.ts }, lease: claim.view },
			});
			continue;
		}

		if (inputs.sources.ledger) {
			// Work inactivity, measured apart from lease renewal — which is the whole
			// point of this finding and what an earlier version got backwards. Counting
			// `heartbeat_at` as a sign of life meant a holder that beat its lease
			// forever without recording anything never crossed the threshold, so the
			// one case `lease.idle` exists to reveal was the one case it could not see.
			//
			// `claimed_at` is the floor, so a lease taken two seconds ago is never idle;
			// a heartbeat is not, because a heartbeat is not work.
			const lastWork = holderEvents.find((event) => WORK_KINDS.includes(event.kind));
			const since = Math.max(parseTime(lastWork?.ts) ?? 0, parseTime(claim.lease.claimed_at) ?? 0);
			if (since > 0 && now - since > idleMs) {
				findings.push({
					kind: "lease.idle",
					severity: "warn",
					detail:
						`${label(claim)} has been held by ${holder.surface} for ${ago(parseTime(claim.lease.claimed_at) ?? since, now)} ` +
						`with nothing recorded for ${ago(since, now)}. The lease is alive; the work may not be.`,
					graph_id: claim.graph_id,
					node_id: claim.node_id,
					surface: holder.surface,
					session_id: holder.session_id,
					evidence: {
						last_event: lastWork ? { id: lastWork.id, ts: lastWork.ts, kind: lastWork.kind, summary: lastWork.summary } : null,
						idle_seconds: Math.round((now - since) / 1000),
						lease: claim.view,
					},
				});
			}
		}
	}

	// ── the trail against the claims ──────────────────────────────────────────
	if (inputs.sources.ledger && inputs.sources.index) {
		const reported = new Set<string>();
		for (const event of inputs.events) {
			if (!event.graph_id || !event.node_id) continue;
			if (!WORK_KINDS.includes(event.kind)) continue;
			const key = nodeKey(event.graph_id, event.node_id);
			if (held.has(key) || reported.has(key)) continue;
			// The finding is "a second agent could take this mid-flight", so it only
			// holds for work that could still *be* in flight. Comparing every event in
			// the window against the leases held *now* reported every node an agent had
			// legitimately finished and released — normal completed work, flagged as a
			// coordination failure, on every scan until it aged out of the window.
			const at = parseTime(event.ts);
			if (at === null || now - at > idleMs) continue;
			const node = inputs.nodes.find((candidate) => nodeKey(candidate.graph_id, candidate.node_id) === key);
			if (node && (node.state === "completed" || node.state === "canceled")) continue;
			reported.add(key);
			findings.push({
				kind: "work.unclaimed",
				severity: "info",
				detail:
					`${event.surface} did work on ${event.node_id} ${ago(parseTime(event.ts) ?? now, now)} ago ` +
					`("${event.summary}") and nothing holds a lease on it. A second agent could take it mid-flight.`,
				graph_id: event.graph_id,
				node_id: event.node_id,
				surface: event.surface,
				...(event.session_id ? { session_id: event.session_id } : {}),
				evidence: { event: { id: event.id, ts: event.ts, kind: event.kind, summary: event.summary } },
			});
		}
	}

	// ── the claims against the graph's own edges ──────────────────────────────
	const stateOf = new Map(inputs.nodes.map((node) => [nodeKey(node.graph_id, node.node_id), node]));
	for (const claim of claims) {
		if (claim.state_of_lease !== "held") continue;
		for (const { edge, dependency } of dependenciesOf(claim, inputs.edges)) {
			const upstream = stateOf.get(nodeKey(claim.graph_id, dependency));
			// A dependency the index has never heard of is not evidence of anything.
			if (!upstream || upstream.state === "completed") continue;
			const gate = edge.kind === "gated_by";
			findings.push({
				kind: gate ? "edge.gate_open" : "edge.requires_incomplete",
				severity: "warn",
				detail:
					`${label(claim)} is held, but ${gate ? "it is gated by" : "it requires"} ` +
					`${upstream.linear_identifier ?? upstream.node_id}, which is ${upstream.state ?? "not started"}.`,
				graph_id: claim.graph_id,
				node_id: claim.node_id,
				...(claim.view.holder ? { surface: claim.view.holder.surface } : {}),
				evidence: { edge, dependency: { node_id: dependency, state: upstream.state ?? null } },
			});
		}
	}

	const bySurface = new Map<Surface, { surface: Surface; last_ts: string; last_summary: string }>();
	for (const event of inputs.events) {
		if (!bySurface.has(event.surface)) {
			bySurface.set(event.surface, { surface: event.surface, last_ts: event.ts, last_summary: event.summary });
		}
	}

	return {
		repo: inputs.repo,
		scanned_at: new Date(now).toISOString(),
		ok: findings.length === 0,
		git: inputs.git,
		ledger: {
			events: inputs.events.length,
			last_event: lastEvent
				? { ts: lastEvent.ts, surface: lastEvent.surface, kind: lastEvent.kind, summary: lastEvent.summary }
				: null,
			last_commit: lastCommit
				? { ts: lastCommit.ts, surface: lastCommit.surface, sha: lastCommit.sha, summary: lastCommit.summary }
				: null,
			surfaces: [...bySurface.values()],
		},
		claims: claims.map((claim) => ({
			graph_id: claim.graph_id,
			node_id: claim.node_id,
			linear_identifier: claim.linear_identifier,
			state: claim.state,
			lease: claim.view,
		})),
		findings,
		sources: inputs.sources,
		unavailable,
	};
}

/**
 * What a node is waiting on, from either side of the relation.
 *
 * `requires` and `gated_by` are written from the waiting node; `blocks` is
 * written from the other end. Reading both directions means a graph registered
 * either way round is checked the same.
 */
function dependenciesOf(
	claim: { graph_id: string; node_id: string },
	edges: GraphEdge[],
): Array<{ edge: GraphEdge; dependency: string; kind: EdgeKind }> {
	const out: Array<{ edge: GraphEdge; dependency: string; kind: EdgeKind }> = [];
	for (const edge of edges) {
		if (edge.graph_id !== claim.graph_id) continue;
		if (edge.from_node === claim.node_id && (edge.kind === "requires" || edge.kind === "gated_by")) {
			out.push({ edge, dependency: edge.to_node, kind: edge.kind });
		}
		if (edge.to_node === claim.node_id && edge.kind === "blocks") {
			out.push({ edge, dependency: edge.from_node, kind: "requires" });
		}
	}
	return out;
}

/** The report as a few lines of text, for the CLI and for a brief. */
export function formatDrift(report: DriftReport): string {
	const lines: string[] = [];
	const tip = report.git.short_sha ?? report.git.sha;
	lines.push(
		`drift scan ${report.repo} — ${report.findings.length === 0 ? "no drift" : `${report.findings.length} finding${report.findings.length === 1 ? "" : "s"}`}`,
	);
	lines.push(
		`git ${tip ?? "unavailable"}${report.git.branch ? ` @ ${report.git.branch}` : ""} · ` +
			`ledger ${report.ledger.events} event${report.ledger.events === 1 ? "" : "s"}` +
			`${report.ledger.last_commit ? ` (last commit ${report.ledger.last_commit.sha})` : ""} · ` +
			`${report.claims.length} claim${report.claims.length === 1 ? "" : "s"}`,
	);
	for (const finding of report.findings) {
		lines.push(`- [${finding.severity}] ${finding.kind}: ${finding.detail}`);
	}
	for (const missing of report.unavailable) lines.push(`- [info] not compared — ${missing}`);
	return lines.join("\n");
}
