/**
 * E6 episodic memory (phase 84): session outcomes as ledger records with
 * provenance and visible supersession.
 *
 * One episode is one session outcome — `{ session_id, graph_id, outcome,
 * summary, provenance, supersedes_id? }` — appended to the ledger as a `note`
 * (`Substrate.recordEpisode`). The same record is retrievable by session or
 * graph (`Substrate.listEpisodes`, the `session_registry`/`graph_get` reads),
 * and a newer episode that names `supersedes_id` makes the link visible both
 * ways: the newer record says what it supersedes, the older record names its
 * replacement in `superseded_by`. Nothing is deleted; supersession is a link,
 * not a rewrite.
 */
/** The ledger columns the episodic read needs — a stored event or a queried row (`LedgerEvent`, whose payload is optional). */
export interface EpisodicSourceEvent {
	session_id: string | null;
	graph_id: string | null;
	payload?: Record<string, unknown>;
}

/** One session outcome. `provenance` is free text naming what the summary rests on (a bank, a document, a run). */
export interface EpisodicRecord {
	episode_id: string;
	session_id: string;
	graph_id: string;
	outcome: string;
	summary: string;
	provenance: string;
	supersedes_id?: string;
}

/** An episode with its supersession link resolved in both directions. */
export interface LinkedEpisodic extends EpisodicRecord {
	superseded_by: string | null;
}

/** The ledger payload marker every episodic event carries. */
export const EPISODIC_MARKER = "episodic";

/** Caps: one episode never dwarfs the events around it on the same chain. */
export const EPISODIC_SUMMARY_CAP = 2_000;
export const EPISODIC_PROVENANCE_CAP = 500;

/** The payload fields an episodic event carries, beside the ledger's own columns. */
export function episodicPayload(record: EpisodicRecord): Record<string, unknown> {
	return {
		episodic: true,
		episode_id: record.episode_id,
		outcome: record.outcome,
		summary: record.summary.slice(0, EPISODIC_SUMMARY_CAP),
		provenance: record.provenance.slice(0, EPISODIC_PROVENANCE_CAP),
		...(record.supersedes_id !== undefined ? { supersedes_id: record.supersedes_id } : {}),
	};
}

function textOf(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/** The episode a ledger event carries, or null for any event that is not episodic. */
export function parseEpisodicEvent(event: EpisodicSourceEvent): EpisodicRecord | null {
	const payload = event.payload ?? {};
	if (payload.episodic !== true) return null;
	const episodeId = textOf(payload.episode_id);
	const outcome = textOf(payload.outcome);
	const summary = textOf(payload.summary);
	const provenance = textOf(payload.provenance);
	if (episodeId === null || outcome === null || summary === null || provenance === null) return null;
	if (event.session_id === null || event.graph_id === null) return null;
	const supersedes = textOf(payload.supersedes_id);
	return {
		episode_id: episodeId,
		session_id: event.session_id,
		graph_id: event.graph_id,
		outcome,
		summary,
		provenance,
		...(supersedes !== null ? { supersedes_id: supersedes } : {}),
	};
}

/** Every episode in a page of events, in ledger order. */
export function parseEpisodicEvents(events: readonly EpisodicSourceEvent[]): EpisodicRecord[] {
	const records: EpisodicRecord[] = [];
	for (const event of events) {
		const record = parseEpisodicEvent(event);
		if (record !== null) records.push(record);
	}
	return records;
}

/**
 * Resolve `superseded_by` for every episode: an episode is superseded by the
 * episode that names its `episode_id` in `supersedes_id`. Pure and
 * deterministic — input order decides which linker wins when two name the
 * same predecessor (the first wins).
 */
export function supersessionChain(records: readonly EpisodicRecord[]): LinkedEpisodic[] {
	const supersedes: Record<string, string> = {};
	for (const record of records) {
		if (record.supersedes_id !== undefined && supersedes[record.supersedes_id] === undefined) {
			supersedes[record.supersedes_id] = record.episode_id;
		}
	}
	return records.map((record) => ({
		...record,
		superseded_by: supersedes[record.episode_id] ?? null,
	}));
}

/** The episodes of one session, optionally narrowed to one graph — the `session_registry` read. */
export function episodesForSession(records: readonly EpisodicRecord[], sessionId: string, graphId?: string): LinkedEpisodic[] {
	return supersessionChain(records.filter((record) => record.session_id === sessionId && (graphId === undefined || record.graph_id === graphId)));
}

/** The episodes of one graph — the `graph_get` read. */
export function episodesForGraph(records: readonly EpisodicRecord[], graphId: string): LinkedEpisodic[] {
	return supersessionChain(records.filter((record) => record.graph_id === graphId));
}

/** One session's episodes with their chain links, for the registry view. */
export interface EpisodicSession {
	session_id: string;
	episodes: LinkedEpisodic[];
}

/** Group episodes by session for the registry view. Pure; input is not modified. */
export function episodicIndex(records: readonly EpisodicRecord[]): EpisodicSession[] {
	const bySession = new Map<string, EpisodicRecord[]>();
	for (const record of records) {
		const list = bySession.get(record.session_id) ?? [];
		list.push(record);
		bySession.set(record.session_id, list);
	}
	return [...bySession.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([session_id, list]) => ({ session_id, episodes: supersessionChain(list) }));
}
