/**
 * The `docs.sync` note a sync reports (v1.7 phase 65, WATCH-05). It maps onto the existing `note` kind through
 * `payload.action`, with `payload.runtime` naming the job. The body names no surface: the server attributes the event to the
 * surface of the token the CLI presents, so a token bound to one surface is never asked to act as another.
 *
 * A failed post never fails the sync: the emitter resolves to a delivery result and never rejects, and the caller reports
 * the result next to the sync's own outcome so a lost event is visible but harmless.
 */
import type { SyncOutcome, SyncTrigger } from "@substrate/corpus";

export const DOCS_SYNC_ACTION = "docs.sync";
export const DOCS_SYNC_RUNTIME = "corpus-sync";
/** The `repo` of an event that covers more than one repository. */
export const ALL_REPOS = "*";
/** Bounded: an event is a note, not a log. */
const EVENT_TIMEOUT_MS = 5000;

export interface DocsSync {
	/** The repository label, or {@link ALL_REPOS} when the sync covered several. */
	repo: string;
	trigger: SyncTrigger;
	outcome: SyncOutcome;
	/** Whole seconds from the first change signal of the burst to the end of the sync. */
	lagS: number;
	added: number;
	changed: number;
	updated: number;
	tombstoned: number;
	refused: number;
	failed: number;
	durationMs: number;
}

export type Delivery = { ok: true } | { ok: false; reason: string };

export type EmitDocsSync = (sync: DocsSync) => Promise<Delivery>;

/** The body `POST /events` takes. */
export function docsSyncBody(sync: DocsSync): Record<string, unknown> {
	const counts = `+${sync.added} ~${sync.changed + sync.updated} -${sync.tombstoned}`;
	return {
		kind: "note",
		actor: "agent",
		summary: `docs sync ${sync.repo}: ${sync.outcome} (${counts}${sync.refused + sync.failed > 0 ? `, ${sync.refused} refused, ${sync.failed} failed` : ""}) in ${sync.durationMs} ms, ${sync.lagS} s after the change`,
		payload: {
			action: DOCS_SYNC_ACTION,
			runtime: DOCS_SYNC_RUNTIME,
			repo: sync.repo,
			trigger: sync.trigger,
			outcome: sync.outcome,
			lag_s: sync.lagS,
			added: sync.added,
			changed: sync.changed,
			updated: sync.updated,
			tombstoned: sync.tombstoned,
			refused: sync.refused,
			failed: sync.failed,
			duration_ms: sync.durationMs,
		},
	};
}

export interface EmitterConfig {
	/** The substrate's base URL, without a trailing slash. */
	url: string;
	token: string | undefined;
	fetchImpl?: typeof fetch | undefined;
	timeoutMs?: number | undefined;
}

/** Posts the event through the REST route; never rejects. */
export function createHttpEmitter(config: EmitterConfig): EmitDocsSync {
	const fetchImpl = config.fetchImpl ?? fetch;
	return async (sync) => {
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (config.token !== undefined) headers.authorization = `Bearer ${config.token}`;
		try {
			const response = await fetchImpl(`${config.url}/events`, {
				method: "POST",
				headers,
				body: JSON.stringify(docsSyncBody(sync)),
				signal: AbortSignal.timeout(config.timeoutMs ?? EVENT_TIMEOUT_MS),
			});
			// The body is never read: a refusal is reported by its status alone.
			return response.ok ? { ok: true } : { ok: false, reason: `http-${response.status}` };
		} catch (cause) {
			return { ok: false, reason: cause instanceof Error && cause.name === "TimeoutError" ? "timeout" : "network" };
		}
	};
}
