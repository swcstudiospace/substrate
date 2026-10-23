/**
 * The gate-accepted retain forward into the writer's `sub-<surface>` bank.
 *
 * DOCS-04's write half (D26-04): after the index write returns `accepted`
 * with `verified_persisted`, the accepted record is forwarded — redacted,
 * carrying its source, idempotent by `document_id` — into the writer's bank,
 * which `ensureBank` first pins to `chunks` mode so the plane stores the
 * accepted text as-is. Postgres stays the governed store: the forward never
 * blocks the write's accepted reply, and any refusal or failure emits the
 * existing `memory.retain.failed` warning with locators plus hashes, never
 * values (D26-07, Phase 21 precedent). A refusal is never cleaned-and-
 * published: any redactor finding stops the forward outright.
 *
 * Transient plane failures (uplift-2 R3) no longer end the trail: when the
 * caller hands in an outbox sink, a timeout, transport error, open breaker,
 * 5xx or 429 parks the forward there instead of warning, and the outbox's
 * replay comes back through `replayRetain` with the entry re-read from the
 * index. The warning is deferred to the outbox's last attempt, not removed.
 * Refusals (unsourced, unredacted, guest, 4xx other than 429) are not
 * transient and warn at once, exactly as before.
 *
 * An entry past its `ttl` is refused too (uplift-3 N4, `retain.expired`), in
 * **both** `SUBSTRATE_MEMORY_EXPIRY` modes: `report` is about what the index
 * still serves, and serving a dead memory tagged is honest where copying it
 * into a bank that keeps it until replaced is not. The outbox replay hits this
 * most — an entry parked for hours can be past its lifetime by the time its
 * turn comes — and a refusal there is permanent, never retried.
 */
import {
	bankForSurface,
	ensureBank,
	forgetEnsuredBank,
	retainMemories,
	type FetchLike,
	type HindsightConfig,
	type HindsightResult,
} from "./planes/hindsight.ts";
import { canonicalJson, sha256Hex } from "./event.ts";
import { memoryExpiry, type GraphLifetime, type MemoryExpiry } from "./memory-policy.ts";
import { applyRule, redact, REDACTION_RULES } from "./redact.ts";
import { isTransientRetainReason, type RetainOutboxCandidate } from "./retain-outbox.ts";
import { SURFACES, type EventInput, type MemoryEntry, type MemoryWriteRequest, type MemoryWriteResult } from "./types.ts";

/** The known surfaces as plain strings, for the emit-surface check. */
const KNOWN_SURFACES: readonly string[] = SURFACES;

/** Where a transient failure parks instead of warning; `false` means "not taken, warn now". */
export interface RetainOutboxSink {
	enqueue(candidate: RetainOutboxCandidate): boolean;
}

export interface RetainDeps {
	config: HindsightConfig | null;
	fetchImpl?: FetchLike;
	/** A guest instance never forwards bytes to the plane (D25-05 posture). */
	vmGuest?: boolean;
	emit: (event: EventInput) => Promise<unknown>;
	/** Absent: every failure warns at once (the pre-outbox behaviour). */
	outbox?: RetainOutboxSink;
	/** The retain POST bound (`HINDSIGHT_RETAIN_TIMEOUT_MS`); the plane default otherwise. */
	retainTimeoutMs?: number;
	/**
	 * What the index knows of the graph a `ttl: graph` entry lives for (null: no
	 * row), for `memoryExpiry`. Absent, a `graph` entry cannot be judged and is
	 * forwarded; a `30d` entry is judged from its own `created` either way.
	 */
	graphLifetime?: (entry: MemoryEntry) => Promise<GraphLifetime | null>;
}

export interface ForwardOutcome {
	forwarded: boolean;
	bank: string;
	document_id: string;
	reason?: string;
	rules?: string[];
	/** True when a transient failure was parked in the outbox instead of warned. */
	queued?: boolean;
}

/** Which redaction rules fire on the text, for the locator-only warning. */
function findingRules(text: string): string[] {
	const found: string[] = [];
	for (const rule of REDACTION_RULES) {
		if (applyRule(rule.name, text) !== text) found.push(rule.name);
	}
	if (found.length === 0 && redact(text) !== text) found.push("structural");
	return found;
}

/**
 * The one `memory.retain.failed` warning shape, shared by the live forward
 * and the outbox's last attempt so the trail reads the same either way. An
 * unknown writer surface cannot emit (the vocabulary is closed) and logs.
 */
export async function emitRetainWarning(
	emit: RetainDeps["emit"],
	writer: string,
	sessionId: string | undefined,
	summary: string,
	payload: Record<string, unknown>,
): Promise<void> {
	const line = redact(summary);
	if (!KNOWN_SURFACES.includes(writer)) {
		process.stderr.write(`[substrate] ${line} by ${redact(writer)}\n`);
		return;
	}
	await emit({
		surface: writer as EventInput["surface"],
		kind: "warning",
		summary: line,
		...(sessionId !== undefined ? { session_id: sessionId } : {}),
		payload: { action: "memory.retain", ...payload },
	}).catch((cause: unknown) => {
		process.stderr.write(`[substrate] ${line} (emit failed: ${redact(String(cause))})\n`);
	});
}

/**
 * The plane document one accepted entry forwards to. Subject-addressed
 * writes supersede by replacing: the id is the claim identity (scope, kind,
 * subject — kinds stay separate, so a fact never shares a document with a
 * warning), while subject-less appends keep the idempotency key.
 */
export function retainDocumentId(entry: MemoryEntry, idempotencyKey: string): string {
	const subject = typeof entry.subject === "string" && entry.subject.length > 0 ? entry.subject : undefined;
	if (subject === undefined) return idempotencyKey;
	return `subj_${sha256Hex(canonicalJson({ scope: entry.scope, kind: entry.kind, subject })).slice(0, 32)}`;
}

/** What the live forward and the outbox replay both hand to `forwardEntry`. */
export interface RetainTarget {
	entry: MemoryEntry;
	writer: string;
	bank: string;
	documentId: string;
	sessionId?: string;
	/** The source event the forward carries; the gate requires one. */
	source?: string;
}

/**
 * Forward one accepted write. Unaccepted, unverified, or unconfigured writes
 * forward nothing and warn nothing — the gate owns that trail. Everything
 * else that stops the forward is a `memory.retain.failed` warning, or a
 * parked outbox entry when the failure is transient and a sink was given.
 */
export async function forwardRetain(
	deps: RetainDeps,
	request: MemoryWriteRequest,
	result: MemoryWriteResult,
): Promise<ForwardOutcome> {
	const entry = result.entry;
	if (result.outcome !== "accepted" || !result.verified_persisted || !entry) {
		return { forwarded: false, bank: "", document_id: "", reason: "not-accepted" };
	}
	if (!deps.config) {
		return { forwarded: false, bank: "", document_id: "", reason: "hindsight is not configured" };
	}
	const sessionId = typeof request.session_id === "string" && request.session_id.length > 0 ? request.session_id : undefined;
	const source = typeof request.source_event === "string" && request.source_event.length > 0 ? request.source_event : undefined;
	return forwardEntry(deps, deps.config, {
		entry,
		writer: result.writer,
		bank: bankForSurface(deps.config, result.writer),
		documentId: retainDocumentId(entry, result.idempotency_key),
		...(sessionId !== undefined ? { sessionId } : {}),
		...(source !== undefined ? { source } : {}),
	});
}

/**
 * The outbox's replay of one parked forward. The caller re-read `entry` from
 * the index by id (so the body sent is the body in force), and the bank and
 * document id are the ones the live forward used — same key, `update_mode:
 * replace`, so a replay after a success that was lost in flight stores once.
 * The source is the entry's own `source_event`; the request that carried it
 * is gone with the process that took it.
 */
export async function replayRetain(
	deps: RetainDeps,
	target: Omit<RetainTarget, "source">,
): Promise<ForwardOutcome> {
	if (!deps.config) {
		return { forwarded: false, bank: target.bank, document_id: target.documentId, reason: "hindsight is not configured" };
	}
	const source = typeof target.entry.source_event === "string" && target.entry.source_event.length > 0 ? target.entry.source_event : undefined;
	return forwardEntry(deps, deps.config, { ...target, ...(source !== undefined ? { source } : {}) });
}

async function forwardEntry(deps: RetainDeps, config: HindsightConfig, target: RetainTarget): Promise<ForwardOutcome> {
	const { entry, writer, bank, documentId, sessionId, source } = target;
	const refuse = async (reason: string, extra: Record<string, unknown> = {}): Promise<ForwardOutcome> => {
		await emitRetainWarning(deps.emit, writer, sessionId, `hindsight retain refused: ${reason} (${bank}/${documentId})`, {
			reason,
			bank,
			document_id: documentId,
			...extra,
			entry_hash: entry.entry_hash,
		});
		return { forwarded: false, bank, document_id: documentId, reason };
	};
	if (deps.vmGuest === true) return refuse("vm-guest");
	if (!source) return refuse("retain.unsourced");
	const expiry = await lifetimeOf(deps, entry);
	if (expiry.expired) return refuse("retain.expired", { ttl: entry.ttl, expiry: expiry.reason });
	const context = `memory ${entry.kind} at ${entry.scope}`;
	const metadata: Record<string, string> = {
		surface: writer,
		scope: entry.scope,
		kind: entry.kind,
		source,
		entry_id: entry.id,
		created: entry.created,
	};
	if (typeof entry.subject === "string" && entry.subject.length > 0) metadata.subject = entry.subject;
	if (entry.repo) metadata.repo = entry.repo;
	const texts = [entry.text, context, ...Object.values(metadata)];
	const rules = [...new Set(texts.flatMap((text) => findingRules(text)))];
	if (rules.length > 0) {
		const refused = await refuse("retain.unredacted", { rule: rules.join(",") });
		return { ...refused, rules };
	}
	// A failure past the refusals: transient ones park in the outbox when the
	// caller gave one (the warning is the outbox's to emit, later); the rest
	// warn now. The reason string is the plane's error kind under a fixed
	// prefix, which is what the transient set is keyed on.
	const fail = async (reason: string): Promise<ForwardOutcome> => {
		if (isTransientRetainReason(reason) && deps.outbox !== undefined) {
			const taken = deps.outbox.enqueue({
				bank,
				document_id: documentId,
				entry_id: entry.id,
				surface: writer,
				entry_hash: entry.entry_hash,
				...(sessionId !== undefined ? { session_id: sessionId } : {}),
				reason,
			});
			if (taken) return { forwarded: false, bank, document_id: documentId, reason, queued: true };
		}
		await emitRetainWarning(deps.emit, writer, sessionId, `hindsight retain failed: ${reason} (${bank}/${documentId})`, {
			reason,
			bank,
			document_id: documentId,
			entry_hash: entry.entry_hash,
		});
		return { forwarded: false, bank, document_id: documentId, reason };
	};
	const fetchImpl = deps.fetchImpl ?? fetch;
	const items = [{ content: entry.text, context, tags: [writer, entry.kind], metadata, document_id: documentId }];
	const retain = (): Promise<HindsightResult<{ items_count: number }>> =>
		deps.retainTimeoutMs !== undefined
			? retainMemories(config, bank, items, fetchImpl, deps.retainTimeoutMs)
			: retainMemories(config, bank, items, fetchImpl);
	const ensured = await ensureBank(config, bank, fetchImpl);
	if (!ensured.ok) return fail(`ensure-bank-${ensured.error.kind}`);
	let retained = await retain();
	if (!retained.ok && retained.error.kind === "not-found") {
		// The bank this process remembers as ensured answered 404: it was
		// removed out of band. Forget it, ensure once more, retry once — a
		// second 404 is reported as such, never looped on.
		forgetEnsuredBank(config, bank);
		const reEnsured = await ensureBank(config, bank, fetchImpl);
		if (!reEnsured.ok) return fail(`ensure-bank-${reEnsured.error.kind}`);
		retained = await retain();
	}
	if (!retained.ok) return fail(`retain-${retained.error.kind}`);
	return { forwarded: true, bank, document_id: documentId };
}

/**
 * The entry's lifetime verdict for the forward. A `graph` entry needs the
 * index's word on its graph; without a resolver it is treated as alive rather
 * than guessed dead, because a forward refused on a guess warns about a memory
 * that may be in force. An index read that fails is the same: alive, this time.
 */
async function lifetimeOf(deps: RetainDeps, entry: MemoryEntry): Promise<MemoryExpiry> {
	if (entry.ttl !== "graph") return memoryExpiry(entry, null);
	const alive: MemoryExpiry = { expired: false, expires_at: null, reason: null };
	if (!deps.graphLifetime) return alive;
	try {
		return memoryExpiry(entry, await deps.graphLifetime(entry));
	} catch {
		return alive;
	}
}
