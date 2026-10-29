/**
 * One sync: read the named repositories (or all of them) through the mirror view, plan against the server, and with
 * `execute` ingest what the plan says must change, then report the outcome as a `docs.sync` event (v1.7 phase 65).
 *
 * This is the one code path every trigger runs: `corpus sync`, the watch loop, the sweep and the reconcile. It reads the
 * repositories and writes nothing into them. It never throws: a failure is the outcome `failed` with a closed message.
 *
 * A sweep over many repositories scans once and plans in groups that stay inside the server's per-request limits; a
 * repository too large for one plan is reported and left alone (its rows are not judged).
 */
import {
	buildView,
	CORPUS_PROTOCOL,
	type Checkout,
	type CheckoutRead,
	type CorpusEntry,
	type CorpusPlanResponse,
	type CorpusScope,
	ensureMirror,
	type GitBytesRunner,
	type GitRunner,
	INGEST_STATUSES,
	MAX_COVERAGE_PAIRS,
	MAX_PLAN_ENTRIES,
	type DocTier,
	type MirrorState,
	PLAN_ACTIONS,
	type PlanAction,
	readLocation,
	type SyncOutcome,
	type SyncTrigger,
} from "@substrate/corpus";
import type { ClientError, CorpusClient } from "./client.ts";
import { ALL_REPOS, type Delivery, type EmitDocsSync } from "./events.ts";
import { executeIngest } from "./ingest.ts";
import { collectInventory, type Inventory } from "./inventory.ts";
import type { IngestSummary } from "./render.ts";

export interface SyncDeps {
	client: CorpusClient;
	/** Absent: no event is sent. */
	emit: EmitDocsSync | undefined;
	/** Discovery's git runner (a test seam; the default runs real git). */
	runner: GitRunner | undefined;
	/** The mirror and the view's git runner. */
	git: GitBytesRunner;
	readFile: (path: string) => Uint8Array;
	now: () => number;
	roots: string[];
	mirrorDir: string;
	maxTier: DocTier;
	maxBytes: number;
	batchDocs: number;
	batchBytes: number;
}

export interface SyncRequest {
	/** Repository labels; null reads every repository below the roots. */
	repos: string[] | null;
	trigger: SyncTrigger;
	execute: boolean;
	/** Fetch the mirrors first (the sweep and the reconcile); false reads whatever mirror exists as it is. */
	fetchMirrors: boolean;
	/** When the first change signal of the burst arrived; the lag counts from here. Absent: from the start of the sync. */
	firstSignalAtMs?: number | undefined;
}

export interface MirrorReport {
	repo: string;
	status: MirrorState["status"];
	reason?: string | undefined;
	/** What the repository was read from: the mirror view, or its working tree alone. */
	view: "mirror" | "working-tree";
}

export interface SyncResult {
	outcome: SyncOutcome;
	trigger: SyncTrigger;
	execute: boolean;
	/** The repository labels that were read. */
	repos: string[];
	/** Requested labels that match nothing below the roots. */
	notFound: string[];
	inventory: Inventory | null;
	plan: CorpusPlanResponse | null;
	ingest: IngestSummary | null;
	mirrors: MirrorReport[];
	/** Repositories that were not read completely, or too large to plan, with the reason. */
	incomplete: string[];
	/** The request that stopped the run, or the unexpected failure. */
	error: string | null;
	/** Null for a dry run or when no emitter is configured. */
	delivery: Delivery | null;
	durationMs: number;
	lagS: number;
}

function sumCounts<K extends string>(keys: readonly K[], parts: ReadonlyArray<Record<K, number>>): Record<K, number> {
	const total = Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
	for (const part of parts) for (const key of keys) total[key] += part[key];
	return total;
}

function labelsOf(inventory: Inventory): string[] {
	const labels = new Set<string>();
	for (const entry of inventory.entries) labels.add(entry.repo);
	for (const pair of inventory.scope.coverage) labels.add(pair.repo);
	return [...labels].sort();
}

export interface Partition {
	groups: Inventory[];
	/** Labels too large for one plan: not planned, so no row of theirs is judged. */
	oversized: string[];
}

/** Splits an inventory by repository into plans that fit the server's per-request limits. */
export function partitionInventory(inventory: Inventory, maxEntries = MAX_PLAN_ENTRIES, maxPairs = MAX_COVERAGE_PAIRS): Partition {
	const entries = new Map<string, CorpusEntry[]>();
	for (const entry of inventory.entries) entries.set(entry.repo, [...(entries.get(entry.repo) ?? []), entry]);
	const pairs = new Map<string, CorpusScope["coverage"]>();
	for (const pair of inventory.scope.coverage) pairs.set(pair.repo, [...(pairs.get(pair.repo) ?? []), pair]);

	const groups: Inventory[] = [];
	const oversized: string[] = [];
	let current: { entries: CorpusEntry[]; coverage: CorpusScope["coverage"] } = { entries: [], coverage: [] };
	const close = (): void => {
		if (current.entries.length === 0 && current.coverage.length === 0) return;
		groups.push({ ...inventory, entries: current.entries, scope: { coverage: current.coverage, maxTier: inventory.scope.maxTier } });
		current = { entries: [], coverage: [] };
	};
	for (const label of labelsOf(inventory)) {
		const mine = entries.get(label) ?? [];
		const covered = pairs.get(label) ?? [];
		if (mine.length > maxEntries || covered.length > maxPairs) {
			oversized.push(label);
			continue;
		}
		if (current.entries.length + mine.length > maxEntries || current.coverage.length + covered.length > maxPairs) close();
		current.entries.push(...mine);
		current.coverage.push(...covered);
	}
	close();
	return { groups, oversized };
}

function describeError(error: ClientError): string {
	return error.message;
}

function mirrorReason(state: MirrorState): string | undefined {
	return state.status === "stale" || state.status === "absent" ? state.reason : undefined;
}

export async function runSync(deps: SyncDeps, request: SyncRequest): Promise<SyncResult> {
	const startedAt = deps.now();
	const mirrors: MirrorReport[] = [];
	const result: SyncResult = {
		outcome: "ok",
		trigger: request.trigger,
		execute: request.execute,
		repos: [],
		notFound: [],
		inventory: null,
		plan: null,
		ingest: null,
		mirrors,
		incomplete: [],
		error: null,
		delivery: null,
		durationMs: 0,
		lagS: 0,
	};
	try {
		await syncInto(deps, request, result);
	} catch (cause) {
		result.outcome = "failed";
		result.error = `unexpected failure: ${cause instanceof Error ? cause.message : String(cause)}`;
	}
	const endedAt = deps.now();
	result.durationMs = Math.max(0, endedAt - startedAt);
	result.lagS = Math.max(0, Math.round((endedAt - (request.firstSignalAtMs ?? startedAt)) / 1000));
	if (request.execute && deps.emit !== undefined) {
		const plan = result.plan?.counts;
		const ingest = result.ingest?.counts;
		result.delivery = await deps.emit({
			repo: request.repos !== null && request.repos.length === 1 ? (request.repos[0] ?? ALL_REPOS) : ALL_REPOS,
			trigger: request.trigger,
			outcome: result.outcome,
			lagS: result.lagS,
			added: plan?.add ?? 0,
			changed: (plan?.change ?? 0) + (plan?.rename ?? 0),
			updated: plan?.update ?? 0,
			tombstoned: ingest?.tombstoned ?? 0,
			refused: ingest?.refused ?? 0,
			failed: ingest?.failed ?? 0,
			durationMs: result.durationMs,
		});
	}
	return result;
}

async function syncInto(deps: SyncDeps, request: SyncRequest, result: SyncResult): Promise<void> {
	const readCheckout = (checkout: Checkout): CheckoutRead | null => {
		const state = ensureMirror(checkout.dir, deps.mirrorDir, deps.git, { fetch: request.fetchMirrors });
		const report = (view: MirrorReport["view"]): void => {
			result.mirrors.push({ repo: checkout.repo, status: state.status, reason: mirrorReason(state), view });
		};
		if (state.status === "absent") {
			report("working-tree");
			return null;
		}
		const view = buildView({
			repo: checkout.repo,
			repoDir: checkout.dir,
			mirrorDir: state.mirrorDir,
			maxTier: deps.maxTier,
			maxBytes: deps.maxBytes,
			runner: deps.git,
			readFile: deps.readFile,
		});
		report(view === null ? "working-tree" : "mirror");
		return view;
	};

	const inventory = await collectInventory({
		roots: deps.roots,
		maxTier: deps.maxTier,
		maxBytes: deps.maxBytes,
		sources: ["fs"],
		maxRepos: 0,
		runner: deps.runner,
		readFile: deps.readFile,
		repos: request.repos ?? undefined,
		readCheckout,
	});
	result.inventory = inventory;
	result.repos = [...new Set(inventory.report.repos.map((repo) => repo.repo))].sort();
	result.notFound = (request.repos ?? []).filter((label) => !result.repos.includes(label));
	result.incomplete = inventory.report.repos.filter((repo) => !repo.complete).map((repo) => `${repo.repo}: ${repo.incomplete ?? "incomplete"}`);
	if (result.repos.length === 0) {
		result.outcome = "skipped";
		return;
	}

	const { groups, oversized } = partitionInventory(inventory);
	for (const label of oversized) result.incomplete.push(`${label}: too many documents for one plan; it was not planned`);
	const plans: CorpusPlanResponse[] = [];
	const ingests: IngestSummary[] = [];
	let fatal: ClientError | null = null;
	for (const group of groups) {
		if (fatal !== null) break;
		const planned = await deps.client.plan({ protocol: CORPUS_PROTOCOL, entries: group.entries, scope: group.scope });
		if (!planned.ok) {
			fatal = planned.error;
			break;
		}
		plans.push(planned.value);
		if (!request.execute) continue;
		const outcome = await executeIngest({
			plan: planned.value,
			inventory: group,
			client: deps.client,
			bodies: null,
			readFile: (location) => readLocation(location, deps.git, deps.readFile),
			maxBytes: deps.maxBytes,
			batchDocs: deps.batchDocs,
			batchBytes: deps.batchBytes,
		});
		ingests.push(outcome.summary);
		fatal = outcome.fatal;
	}

	if (plans.length > 0) {
		result.plan = {
			protocol: CORPUS_PROTOCOL,
			items: plans.flatMap((plan) => plan.items),
			counts: sumCounts<PlanAction>(PLAN_ACTIONS, plans.map((plan) => plan.counts)),
			manifestVersion: plans[plans.length - 1]?.manifestVersion ?? 0,
		};
	}
	if (request.execute && ingests.length > 0) {
		result.ingest = {
			counts: sumCounts(INGEST_STATUSES, ingests.map((summary) => summary.counts)),
			problems: ingests.flatMap((summary) => summary.problems),
			manifestVersion: ingests[ingests.length - 1]?.manifestVersion ?? null,
		};
	}
	if (fatal !== null) {
		result.outcome = "failed";
		result.error = describeError(fatal);
		return;
	}
	const bad = (result.ingest?.counts.refused ?? 0) + (result.ingest?.counts.failed ?? 0);
	if (bad > 0 || oversized.length > 0) result.outcome = "partial";
}

/** True when the sync should end the command with a non-zero exit: it failed, or anything asked for was refused or failed. */
export function syncFailed(result: SyncResult): boolean {
	return result.outcome === "failed" || result.outcome === "partial";
}
